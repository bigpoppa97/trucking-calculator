import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { RouteFetchError, type FetchedRoute, type RouteFetchService } from '../here/routeFetchService.js'

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
}

const ROUTE_CODE_PARAM_SCHEMA = {
  type: 'object',
  properties: { routeCode: { type: 'string', minLength: 7, maxLength: 64 } },
  required: ['routeCode'],
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

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Validation errors carry safe, schema-derived messages.
    if (error.validation) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Invalid request payload.' } })
    }
    request.log?.error?.(error)
    // Static generic message only — never raw exception text (kickoff rule).
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Unexpected error. Please try again.' } })
  })

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
        const saved = await deps.fetchService.saveFetchedRoute(request.body, 'portal-user')
        return await reply.status(201).send({ route: saved })
      } catch (error) {
        return sendRouteFetchError(reply, error)
      }
    },
  )

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
      : error.code === 'ROUTE_ALREADY_EXISTS' ? 409
      : 502
    return reply.status(status).send({ error: { code: error.code, message: error.message } })
  }
  // Anything else is unexpected — let the central handler return a generic 500.
  throw error
}
