import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { buildAuthDeps, registerAuthHook, registerAuthRoutes, requireRole } from './auth.js'
import { AirportRepository } from '../repositories/airportRepository.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { FleetVariantRepository } from '../repositories/fleetVariantRepository.js'
import { CalculationRepository } from '../repositories/calculationRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { TollSystemRuleRepository } from '../repositories/tollSystemRuleRepository.js'
import { RouteWaypointRepository } from '../repositories/routeWaypointRepository.js'
import { RouteFetchError, type FetchedRoute, type RouteFetchService } from '../here/routeFetchService.js'
import { CalculationSaveError, CalculationService } from './calculationService.js'
import type { DriverCount } from '../domain/index.js'
import { BoardService } from '../board/boardService.js'
import { DistanceService } from '../board/distances.js'
import { registerBoardRoutes } from '../board/routes.js'
import type { HereGeocodingClient } from '../here/hereGeocodingClient.js'

/**
 * HTTP layer for the route lookup / HERE proxy flow (PRD §3.2, §4):
 *
 *   GET  /api/routes/:routeCode   → table-first lookup; 404 = "not in database"
 *   POST /api/here/route-fetch    → the user-confirmed HERE call (no save)
 *   POST /api/routes              → "Save to route database" for a fetched route
 *
 * Every failure state maps to an explicit, static message — raw exception
 * text never reaches a response body.
 */

export interface AppDeps {
  db: Kysely<DB>
  fetchService: RouteFetchService
  /** Fleet board (tablica). Defaults to an offline instance (estimated km). */
  board?: BoardService
  geocoder?: Pick<HereGeocodingClient, 'geocode'>
  /** Mark the session cookie Secure — enable when served over HTTPS. */
  secureCookies?: boolean
}

const ROUTE_CODE_PARAM_SCHEMA = {
  type: 'object',
  properties: { routeCode: { type: 'string', minLength: 7, maxLength: 64 } },
  required: ['routeCode'],
} as const

const TOLL_PARAMS_SCHEMA = {
  type: 'object',
  properties: {
    routeCode: { type: 'string', minLength: 7, maxLength: 64 },
    country: { type: 'string', minLength: 2, maxLength: 2 },
  },
  required: ['routeCode', 'country'],
} as const

const FETCH_BODY_SCHEMA = {
  type: 'object',
  properties: { routeCode: { type: 'string', minLength: 7, maxLength: 64 } },
  required: ['routeCode'],
  additionalProperties: false,
} as const

const SAVE_BODY_SCHEMA = {
  type: 'object',
  properties: {
    routeCode: { type: 'string', minLength: 7, maxLength: 64 },
    stops: { type: 'array', items: { type: 'string' }, minItems: 2 },
    totalKm: { type: 'number', exclusiveMinimum: 0 },
    countryKm: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
    tollEstimates: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          polyline: { type: 'string', minLength: 1 },
          spans: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                offset: { type: 'integer', minimum: 0 },
                country: { type: 'string', minLength: 2, maxLength: 3 },
              },
              required: ['offset', 'country'],
              additionalProperties: false,
            },
          },
        },
        required: ['polyline', 'spans'],
        additionalProperties: false,
      },
    },
    vehicleProfile: {
      type: 'object',
      properties: {
        axleCount: { type: 'integer', minimum: 1 },
        grossWeightKg: { type: 'integer', minimum: 1 },
        emissionType: { type: 'string', minLength: 1 },
      },
      required: ['axleCount', 'grossWeightKg', 'emissionType'],
    },
    fetchedAt: { type: 'string', minLength: 1 },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['routeCode', 'stops', 'totalKm', 'countryKm', 'tollEstimates', 'vehicleProfile', 'fetchedAt'],
  additionalProperties: false,
} as const

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false })
  const routeRepo = new RouteRepository(deps.db)
  const configRepo = new ConfigRepository(deps.db)
  const variantRepo = new FleetVariantRepository(deps.db)
  const airportRepo = new AirportRepository(deps.db)
  const calculationRepo = new CalculationRepository(deps.db)
  const calculationService = new CalculationService({
    routes: routeRepo,
    variants: variantRepo,
    config: configRepo,
    calculations: calculationRepo,
  })
  const authDeps = buildAuthDeps(deps.db)
  app.register(fastifyCookie)
  registerAuthHook(app, authDeps)
  registerAuthRoutes(app, authDeps, { secureCookies: deps.secureCookies === true })

  // The authenticated user's email — written into every audit field. The
  // auth hook guarantees request.user is set on all non-public routes.
  const actor = (request: FastifyRequest): string => request.user?.email ?? 'unknown'

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Validation errors carry safe, schema-derived messages. The board (tablica) speaks Polish.
    const board = (request.raw.url ?? '').startsWith('/api/board')
    if (error.validation) {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION', message: board ? 'Nieprawidłowe dane w formularzu — sprawdź pola i spróbuj ponownie.' : 'Invalid request payload.' } })
    }
    if (error.statusCode === 413) {
      const url = request.raw.url ?? ''
      const message = !board
        ? 'Request too large.'
        : /\/certs\/\d+\/files/.test(url)
          ? 'Plik jest za duży — najwyżej 15 MB.'
          : url.startsWith('/api/board/import')
            ? 'Plik eksportu jest za duży — najwyżej 40 MB.'
            : 'Za dużo danych w jednym zapisie.'
      return reply.status(413).send({ error: { code: 'TOO_LARGE', message } })
    }
    request.log?.error?.(error)
    // Static generic message only — never raw exception text (kickoff rule).
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Unexpected error. Please try again.' } })
  })

  // Read endpoints for the calculator screen (PRD §5.3).
  app.get('/api/config', async (_request, reply) => {
    const config = await configRepo.getCalculatorConfig()
    return reply.send({ config })
  })

  app.get('/api/fleet-variants', async (_request, reply) => {
    const variants = await variantRepo.listActive()
    return reply.send({ variants })
  })

  app.get('/api/airports', async (_request, reply) => {
    const airports = await airportRepo.listAll()
    return reply.send({ airports })
  })

  // Route DB screen (PRD §5.3): list with pending/estimate flags.
  app.get('/api/routes', async (_request, reply) => {
    return reply.send({ routes: await routeRepo.listAll() })
  })

  // Manual km override with audit note (PRD §3.3, §5.3).
  app.put<{ Params: { routeCode: string }; Body: { totalKm: number; countryKm: Record<string, number>; note?: string } }>(
    '/api/routes/:routeCode/km',
    {
      schema: {
        params: ROUTE_CODE_PARAM_SCHEMA,
        body: {
          type: 'object',
          properties: {
            totalKm: { type: 'number', exclusiveMinimum: 0 },
            countryKm: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
            note: { type: 'string', maxLength: 500 },
          },
          required: ['totalKm', 'countryKm'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const code = request.params.routeCode.trim().toUpperCase()
      if (!(await routeRepo.existsByCode(code))) {
        return reply.status(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not in database.' } })
      }
      await routeRepo.overrideKm(code, request.body.totalKm, request.body.countryKm, {
        ...(request.body.note !== undefined ? { note: request.body.note } : {}),
        updatedBy: actor(request),
      })
      return reply.send({ route: await routeRepo.findByCode(code) })
    },
  )

  // Fill in a pending toll manually — human value, stored as verified, so
  // like estimate→verified promotion this is finance/admin work (PRD §4.3).
  app.put<{ Params: { routeCode: string; country: string }; Body: { tollEur: number } }>(
    '/api/routes/:routeCode/tolls/:country',
    {
      preHandler: requireRole('finance', 'admin'),
      schema: {
        params: TOLL_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: { tollEur: { type: 'number', minimum: 0 } },
          required: ['tollEur'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const code = request.params.routeCode.trim().toUpperCase()
      const route = await routeRepo.findByCode(code)
      if (!route) {
        return reply.status(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not in database.' } })
      }
      await routeRepo.setManualToll(route.id, request.params.country.toUpperCase(), request.body.tollEur, actor(request))
      return reply.send({ route: await routeRepo.findByCode(code) })
    },
  )

  // Estimate → verified promotion with audit (PRD §4.3 verification workflow).
  app.post<{ Params: { routeCode: string; country: string }; Body: { correctedTollEur?: number } }>(
    '/api/routes/:routeCode/tolls/:country/verify',
    {
      preHandler: requireRole('finance', 'admin'),
      schema: {
        params: TOLL_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: { correctedTollEur: { type: 'number', minimum: 0 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const code = request.params.routeCode.trim().toUpperCase()
      const route = await routeRepo.findByCode(code)
      if (!route) {
        return reply.status(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not in database.' } })
      }
      try {
        await routeRepo.verifyToll(route.id, request.params.country.toUpperCase(), actor(request), request.body.correctedTollEur)
      } catch {
        return reply
          .status(404)
          .send({ error: { code: 'TOLL_NOT_FOUND', message: 'No toll value to verify for this country.' } })
      }
      return reply.send({ route: await routeRepo.findByCode(code) })
    },
  )

  // Finance-editable config (PRD §5.3). month_days editable since 2026-07
  // (business sign-off, overrides the original PRD §2.1 fixed-30 decision).
  app.put<{
    Body: {
      fuelPriceEurPerLitre: number
      fuelConsumptionLPer100Km: number
      driverDayRateEur: number
      monthlyOverheadEur: number
      monthDays: number
    }
  }>(
    '/api/config',
    {
      preHandler: requireRole('finance', 'admin'),
      schema: {
        body: {
          type: 'object',
          properties: {
            fuelPriceEurPerLitre: { type: 'number', exclusiveMinimum: 0 },
            fuelConsumptionLPer100Km: { type: 'number', exclusiveMinimum: 0 },
            driverDayRateEur: { type: 'number', minimum: 0 },
            monthlyOverheadEur: { type: 'number', minimum: 0 },
            monthDays: { type: 'integer', minimum: 1, maximum: 31 },
          },
          required: ['fuelPriceEurPerLitre', 'fuelConsumptionLPer100Km', 'driverDayRateEur', 'monthlyOverheadEur', 'monthDays'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      await configRepo.setMany({
        fuel_price: String(request.body.fuelPriceEurPerLitre),
        consumption: String(request.body.fuelConsumptionLPer100Km),
        driver_day_rate: String(request.body.driverDayRateEur),
        monthly_overhead: String(request.body.monthlyOverheadEur),
        month_days: String(request.body.monthDays),
      })
      return reply.send({ config: await configRepo.getCalculatorConfig() })
    },
  )

  // Fleet variants CRUD (PRD §2.2: a table, not an enum) — config screen, so
  // finance/admin only.
  app.post<{ Body: { name: string; monthlyCostEur: number } }>(
    '/api/fleet-variants',
    {
      preHandler: requireRole('finance', 'admin'),
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            monthlyCostEur: { type: 'number', minimum: 0 },
          },
          required: ['name', 'monthlyCostEur'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      await variantRepo.upsertByName(request.body.name.trim(), request.body.monthlyCostEur, true)
      return reply.status(201).send({ variants: await variantRepo.listAll() })
    },
  )

  app.patch<{ Params: { id: string }; Body: { monthlyCostEur?: number; active?: boolean } }>(
    '/api/fleet-variants/:id',
    {
      preHandler: requireRole('finance', 'admin'),
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^\\d+$' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            monthlyCostEur: { type: 'number', minimum: 0 },
            active: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const updated = await variantRepo.updateById(Number(request.params.id), request.body)
      if (!updated) {
        return reply.status(404).send({ error: { code: 'VARIANT_NOT_FOUND', message: 'Fleet variant not found.' } })
      }
      return reply.send({ variants: await variantRepo.listAll() })
    },
  )

  // Toll-system correction rules (config screen): fix HERE fares returned at
  // the wrong tariff. Finance/admin only, like the rest of the config.
  const tollRuleRepo = new TollSystemRuleRepository(deps.db)

  app.get('/api/toll-rules', async (_request, reply) => {
    return reply.send({ rules: await tollRuleRepo.listAll() })
  })

  app.put<{ Body: { tollSystem: string; ruleType: 'replace_per_gate' | 'scale'; value: number; note?: string } }>(
    '/api/toll-rules',
    {
      preHandler: requireRole('finance', 'admin'),
      schema: {
        body: {
          type: 'object',
          properties: {
            tollSystem: { type: 'string', minLength: 1, maxLength: 200 },
            ruleType: { type: 'string', enum: ['replace_per_gate', 'scale'] },
            value: { type: 'number', exclusiveMinimum: 0 },
            note: { type: 'string', maxLength: 500 },
          },
          required: ['tollSystem', 'ruleType', 'value'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const rule = await tollRuleRepo.upsertBySystem(request.body, actor(request))
      return reply.send({ rule, rules: await tollRuleRepo.listAll() })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/toll-rules/:id',
    {
      preHandler: requireRole('finance', 'admin'),
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^\\d+$' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const deleted = await tollRuleRepo.deleteById(Number(request.params.id))
      if (!deleted) {
        return reply.status(404).send({ error: { code: 'RULE_NOT_FOUND', message: 'Toll rule not found.' } })
      }
      return reply.send({ rules: await tollRuleRepo.listAll() })
    },
  )

  // Calculation history with server-built frozen snapshots (PRD §5.2, §5.3).
  app.post<{
    Body: {
      routeCode: string
      days: number
      drivers: DriverCount
      fleetVariantId: number
      ferriesEur: number
      tunnelsEur: number
      revenueEur?: number
    }
  }>(
    '/api/calculations',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            routeCode: { type: 'string', minLength: 7, maxLength: 64 },
            days: { type: 'number', minimum: 0.5 },
            drivers: { type: 'integer', enum: [1, 2] },
            fleetVariantId: { type: 'integer', minimum: 1 },
            ferriesEur: { type: 'number', minimum: 0 },
            tunnelsEur: { type: 'number', minimum: 0 },
            revenueEur: { type: 'number', minimum: 0 },
          },
          required: ['routeCode', 'days', 'drivers', 'fleetVariantId', 'ferriesEur', 'tunnelsEur'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const calculation = await calculationService.saveCalculation({ ...request.body, createdBy: actor(request) })
        return await reply.status(201).send({ calculation })
      } catch (error) {
        if (error instanceof CalculationSaveError) {
          const status = error.code === 'INVALID_INPUT' ? 400 : 404
          return reply.status(status).send({ error: { code: error.code, message: error.message } })
        }
        throw error
      }
    },
  )

  app.get<{ Querystring: { route?: string; limit?: string } }>(
    '/api/calculations',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            route: { type: 'string', minLength: 7, maxLength: 64 },
            limit: { type: 'string', pattern: '^\\d+$' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const calculations = await calculationRepo.listHistory({
        ...(request.query.route !== undefined ? { routeCode: request.query.route.trim().toUpperCase() } : {}),
        limit: request.query.limit !== undefined ? Math.min(Number(request.query.limit), 500) : 100,
      })
      return reply.send({ calculations })
    },
  )

  app.get<{ Params: { routeCode: string } }>(
    '/api/routes/:routeCode',
    { schema: { params: ROUTE_CODE_PARAM_SCHEMA } },
    async (request, reply) => {
      const route = await routeRepo.findByCode(request.params.routeCode.trim().toUpperCase())
      if (!route) {
        // Explicit state for the §3.2 confirm dialog: "Route not in database. Query HERE API?"
        return reply.status(404).send({
          error: { code: 'ROUTE_NOT_FOUND', message: 'Route not in database.' },
        })
      }
      return reply.send({ source: 'database', route })
    },
  )

  // Company-preferred via waypoints per route code (PRD §3.3). Editable by
  // any authenticated user (dispatchers own routing knowledge); applied on
  // fetch and shape refresh as HERE pass-through vias.
  const waypointRepo = new RouteWaypointRepository(deps.db)

  app.get<{ Params: { routeCode: string } }>(
    '/api/route-waypoints/:routeCode',
    { schema: { params: ROUTE_CODE_PARAM_SCHEMA } },
    async (request, reply) => {
      return reply.send({ waypoints: await waypointRepo.listByRoute(request.params.routeCode) })
    },
  )

  app.put<{
    Params: { routeCode: string }
    Body: { waypoints: Array<{ seq: number; name: string; lat: number; lon: number }> }
  }>(
    '/api/route-waypoints/:routeCode',
    {
      schema: {
        params: ROUTE_CODE_PARAM_SCHEMA,
        body: {
          type: 'object',
          properties: {
            waypoints: {
              type: 'array',
              maxItems: 10,
              items: {
                type: 'object',
                properties: {
                  seq: { type: 'integer', minimum: 1, maximum: 99999 },
                  name: { type: 'string', minLength: 1, maxLength: 100 },
                  lat: { type: 'number', minimum: -90, maximum: 90 },
                  lon: { type: 'number', minimum: -180, maximum: 180 },
                },
                required: ['seq', 'name', 'lat', 'lon'],
                additionalProperties: false,
              },
            },
          },
          required: ['waypoints'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const seqs = request.body.waypoints.map(w => w.seq)
      if (new Set(seqs).size !== seqs.length) {
        return reply
          .status(400)
          .send({ error: { code: 'DUPLICATE_SEQ', message: 'Each waypoint needs a unique seq value.' } })
      }
      const waypoints = await waypointRepo.replaceForRoute(request.params.routeCode, request.body.waypoints)
      return reply.send({ waypoints })
    },
  )

  // Backfill the map shape for an existing route (1 HERE request). Shape
  // only — stored km/tolls stay authoritative.
  app.post<{ Params: { routeCode: string } }>(
    '/api/routes/:routeCode/shape',
    { schema: { params: ROUTE_CODE_PARAM_SCHEMA } },
    async (request, reply) => {
      try {
        const route = await deps.fetchService.refreshRouteShape(request.params.routeCode)
        return await reply.send({ route })
      } catch (error) {
        return sendRouteFetchError(reply, error)
      }
    },
  )

  // Fill the gaps of an existing route from HERE (1 request): toll estimates
  // for countries without any toll value + km for countries missing from the
  // stored split. Verified tolls, existing estimates, stored country km and
  // the binding total km stay untouched (PRD §3.3). Estimates still go
  // through the finance verification workflow.
  app.post<{ Params: { routeCode: string } }>(
    '/api/routes/:routeCode/fill-from-here',
    { schema: { params: ROUTE_CODE_PARAM_SCHEMA } },
    async (request, reply) => {
      try {
        const result = await deps.fetchService.fillRouteGaps(request.params.routeCode, actor(request))
        return await reply.send(result)
      } catch (error) {
        return sendRouteFetchError(reply, error)
      }
    },
  )

  app.post<{ Body: { routeCode: string } }>(
    '/api/here/route-fetch',
    { schema: { body: FETCH_BODY_SCHEMA } },
    async (request, reply) => {
      try {
        const fetched = await deps.fetchService.fetchNewRoute(request.body.routeCode)
        return await reply.send({ source: 'here', fetched })
      } catch (error) {
        return sendRouteFetchError(reply, error)
      }
    },
  )

  app.post<{ Body: FetchedRoute }>(
    '/api/routes',
    { schema: { body: SAVE_BODY_SCHEMA } },
    async (request, reply) => {
      try {
        const saved = await deps.fetchService.saveFetchedRoute(request.body, actor(request))
        return await reply.status(201).send({ route: saved })
      } catch (error) {
        return sendRouteFetchError(reply, error)
      }
    },
  )

  registerBoardRoutes(app, {
    board: deps.board ?? new BoardService(deps.db, new DistanceService({ db: deps.db, allowHere: false })),
    geocoder: deps.geocoder,
  })

  return app
}

function sendRouteFetchError(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  error: unknown,
): unknown {
  if (error instanceof RouteFetchError) {
    const status =
      error.code === 'INVALID_ROUTE_CODE' ? 400
      : error.code === 'AIRPORT_NOT_FOUND' ? 404
      : error.code === 'ROUTE_NOT_FOUND' ? 404
      : error.code === 'ROUTE_ALREADY_EXISTS' ? 409
      : 502
    return reply.status(status).send({ error: { code: error.code, message: error.message } })
  }
  // Anything else is unexpected — let the central handler return a generic 500.
  throw error
}
