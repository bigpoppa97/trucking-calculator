import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { NoteKind } from '../db/schema.js'
import type { HereGeocodingClient } from '../here/hereGeocodingClient.js'
import { BoardError, type BoardService, type ServiceInput, type ServicePatch } from './boardService.js'
import { ExportFormatError } from './exportReader.js'
import { foldDiacritics } from './normalize.js'

/**
 * HTTP endpoints of the board (prefix /api/board). Thin layer over
 * BoardService; every failure maps to a static, Polish message.
 */

export interface BoardRouteDeps {
  board: BoardService
  geocoder?: Pick<HereGeocodingClient, 'geocode'> | undefined
}

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const
const TIME = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } as const
const ID_PARAMS = { type: 'object', properties: { id: { type: 'string', pattern: '^\\d+$' } }, required: ['id'] } as const
const ORDER_PARAMS = {
  type: 'object',
  properties: { orderNo: { type: 'string', minLength: 1, maxLength: 64 } },
  required: ['orderNo'],
} as const

async function handle(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    const result = await fn()
    return await reply.send(result ?? { ok: true })
  } catch (error) {
    if (error instanceof BoardError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ExportFormatError) {
      return reply.status(400).send({ error: { code: 'EXPORT_FORMAT', message: error.message } })
    }
    throw error
  }
}

export function registerBoardRoutes(app: FastifyInstance, deps: BoardRouteDeps): void {
  // Every write is signed by the logged-in user (auth hook sets request.user).
  const as = (request: FastifyRequest): BoardService => (request.user ? deps.board.withActor(request.user.displayName) : deps.board)
  const board = deps.board

  app.get<{ Querystring: { date?: string } }>(
    '/api/board/week',
    { schema: { querystring: { type: 'object', properties: { date: DATE } } } },
    async (request, reply) => handle(reply, () => board.weekView(request.query.date ?? new Date().toISOString().slice(0, 10))),
  )

  app.get<{ Params: { orderNo: string } }>('/api/board/orders/:orderNo', { schema: { params: ORDER_PARAMS } }, async (request, reply) =>
    handle(reply, () => board.orderDetails(request.params.orderNo)),
  )

  app.post<{ Params: { orderNo: string }; Body: { text: string } }>(
    '/api/board/orders/:orderNo/notes',
    {
      schema: {
        params: ORDER_PARAMS,
        body: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['text'], additionalProperties: false },
      },
    },
    async (request, reply) => handle(reply, () => as(request).addOrderNote(request.params.orderNo, request.body.text)),
  )

  app.delete<{ Params: { id: string } }>('/api/board/notes/:id', { schema: { params: ID_PARAMS } }, async (request, reply) =>
    handle(reply, () => as(request).deleteNote(Number(request.params.id))),
  )

  app.post<{ Params: { orderNo: string }; Body: { field: string; value: string } }>(
    '/api/board/orders/:orderNo/overrides',
    {
      schema: {
        params: ORDER_PARAMS,
        body: {
          type: 'object',
          properties: { field: { type: 'string', minLength: 1, maxLength: 32 }, value: { type: 'string', maxLength: 500 } },
          required: ['field', 'value'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => handle(reply, () => as(request).setOverride(request.params.orderNo, request.body.field, request.body.value)),
  )

  app.delete<{ Params: { orderNo: string; field: string } }>(
    '/api/board/orders/:orderNo/overrides/:field',
    {
      schema: {
        params: {
          type: 'object',
          properties: { orderNo: { type: 'string', minLength: 1, maxLength: 64 }, field: { type: 'string', minLength: 1, maxLength: 32 } },
          required: ['orderNo', 'field'],
        },
      },
    },
    async (request, reply) => handle(reply, () => as(request).clearOverride(request.params.orderNo, request.params.field)),
  )

  app.post<{ Body: { truckId: number; day: string; kind: NoteKind; text: string; place?: string } }>(
    '/api/board/events',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            truckId: { type: 'integer', minimum: 1 },
            day: DATE,
            kind: { type: 'string', enum: ['note', 'pause', 'driver', 'trailer', 'position'] },
            text: { type: 'string', minLength: 1, maxLength: 500 },
            place: { type: 'string', maxLength: 100 },
          },
          required: ['truckId', 'day', 'kind', 'text'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) =>
      handle(reply, () =>
        as(request).addTruckEvent({
          truckId: request.body.truckId,
          day: request.body.day,
          kind: request.body.kind,
          text: request.body.text,
          ...(request.body.place !== undefined ? { place: request.body.place } : {}),
        }),
      ),
  )

  // Set page (strona zestawu): one tractor over whole weeks covering [from, to].
  app.get<{ Params: { id: string }; Querystring: { from: string; to?: string } }>(
    '/api/board/trucks/:id/view',
    { schema: { params: ID_PARAMS, querystring: { type: 'object', properties: { from: DATE, to: DATE }, required: ['from'] } } },
    async (request, reply) =>
      handle(reply, () => board.truckView(Number(request.params.id), request.query.from, request.query.to ?? request.query.from)),
  )

  // Services (serwis): required (no date yet) or planned (hours or whole days), tractor or trailer.
  const SERVICE_WHEN = {
    allDay: { type: 'boolean' },
    startDay: DATE,
    startTime: { anyOf: [TIME, { type: 'null' }] },
    endDay: DATE,
    endTime: { anyOf: [TIME, { type: 'null' }] },
    description: { type: 'string', maxLength: 300 },
    place: { type: 'string', maxLength: 150 },
    target: { type: 'string', enum: ['truck', 'trailer'] },
    trailerPlate: { type: 'string', maxLength: 20 },
  } as const

  app.get('/api/board/services/required', async (_request, reply) => handle(reply, async () => ({ services: await board.requiredServices() })))

  app.post<{ Body: ServiceInput }>(
    '/api/board/services',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            ...SERVICE_WHEN,
            truckId: { type: 'integer', minimum: 1 },
            status: { type: 'string', enum: ['required', 'planned'] },
            startTime: TIME,
            endTime: TIME,
          },
          required: ['truckId', 'target', 'status'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => handle(reply, async () => ({ id: await as(request).createService(request.body) })),
  )

  app.patch<{ Params: { id: string }; Body: ServicePatch }>(
    '/api/board/services/:id',
    {
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          properties: { ...SERVICE_WHEN, status: { type: 'string', enum: ['required', 'planned', 'cancelled'] } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => handle(reply, () => as(request).updateService(Number(request.params.id), request.body)),
  )

  app.delete<{ Params: { id: string } }>('/api/board/services/:id', { schema: { params: ID_PARAMS } }, async (request, reply) =>
    handle(reply, () => as(request).deleteService(Number(request.params.id))),
  )

  app.post<{ Body: { filename: string; mode: 'daily' | 'history'; dataBase64: string } }>(
    '/api/board/import',
    {
      bodyLimit: 40 * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          properties: {
            filename: { type: 'string', minLength: 1, maxLength: 255 },
            mode: { type: 'string', enum: ['daily', 'history'] },
            dataBase64: { type: 'string', minLength: 1 },
          },
          required: ['filename', 'mode', 'dataBase64'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => ({
        summary: await as(request).importFile(Buffer.from(request.body.dataBase64, 'base64'), request.body.filename, request.body.mode),
      })),
  )

  app.get('/api/board/imports', async (_request, reply) => handle(reply, async () => ({ imports: await board.imports() })))

  app.get<{ Querystring: { status?: 'open' | 'all' } }>(
    '/api/board/issues',
    { schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'all'] } } } } },
    async (request, reply) => handle(reply, async () => ({ issues: await board.listIssues(request.query.status ?? 'open') })),
  )

  app.post<{ Params: { id: string }; Body: { action: string; payload?: Record<string, unknown> } }>(
    '/api/board/issues/:id/resolve',
    {
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          properties: { action: { type: 'string', minLength: 1, maxLength: 32 }, payload: { type: 'object' } },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => handle(reply, () => as(request).resolveIssue(Number(request.params.id), request.body.action, request.body.payload ?? {})),
  )

  // Fleet registry
  app.get('/api/board/fleet', async (_request, reply) => handle(reply, async () => ({ trucks: await board.fleet() })))

  app.post<{ Body: { plate: string; validFrom: string; carrier?: string; driver?: string; phone?: string; trailerPlate?: string } }>(
    '/api/board/fleet',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            plate: { type: 'string', minLength: 2, maxLength: 20 },
            validFrom: DATE,
            carrier: { type: 'string', maxLength: 200 },
            driver: { type: 'string', maxLength: 200 },
            phone: { type: 'string', maxLength: 40 },
            trailerPlate: { type: 'string', maxLength: 20 },
          },
          required: ['plate', 'validFrom'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const id = await as(request).createTruck(request.body)
        await board.refreshIssues()
        return { id }
      }),
  )

  app.post<{ Body: { text: string; apply?: boolean } }>(
    '/api/board/fleet/sync',
    {
      schema: {
        body: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1, maxLength: 20000 }, apply: { type: 'boolean' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => handle(reply, () => as(request).syncFleetList(request.body.text, request.body.apply === true)),
  )

  app.patch<{ Params: { id: string }; Body: { carrier?: string; trailerPlate?: string | null; notes?: string; active?: boolean; sortOrder?: number } }>(
    '/api/board/fleet/:id',
    {
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          properties: {
            carrier: { type: 'string', maxLength: 200 },
            trailerPlate: { type: ['string', 'null'], maxLength: 20 },
            notes: { type: 'string', maxLength: 1000 },
            active: { type: 'boolean' },
            sortOrder: { type: 'integer' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        await as(request).updateTruck(Number(request.params.id), request.body)
        if (request.body.active !== undefined) await board.refreshIssues()
      }),
  )

  app.post<{ Params: { id: string }; Body: { plate: string; validFrom: string } }>(
    '/api/board/fleet/:id/plates',
    {
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          properties: { plate: { type: 'string', minLength: 2, maxLength: 20 }, validFrom: DATE },
          required: ['plate', 'validFrom'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => handle(reply, () => as(request).addTruckPlate(Number(request.params.id), request.body.plate, request.body.validFrom)),
  )

  // Trailers
  app.get('/api/board/trailers', async (_request, reply) => handle(reply, async () => ({ trailers: await board.trailers() })))

  app.post<{ Body: { plate: string; typePl?: string; typeEn?: string; notes?: string; carrier?: string; activeTo?: string | null } }>(
    '/api/board/trailers',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            plate: { type: 'string', minLength: 2, maxLength: 20 },
            typePl: { type: 'string', maxLength: 100 },
            typeEn: { type: 'string', maxLength: 100 },
            notes: { type: 'string', maxLength: 500 },
            carrier: { type: 'string', maxLength: 200 },
            activeTo: { anyOf: [DATE, { type: 'null' }] },
          },
          required: ['plate'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        await as(request).upsertTrailer(request.body)
        await board.refreshIssues()
      }),
  )

  app.post<{ Body: { alias: string; trailer: string } }>(
    '/api/board/trailers/aliases',
    {
      schema: {
        body: {
          type: 'object',
          properties: { alias: { type: 'string', minLength: 1, maxLength: 30 }, trailer: { type: 'string', minLength: 2, maxLength: 20 } },
          required: ['alias', 'trailer'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        await as(request).addTrailerAlias(request.body.alias, request.body.trailer.toUpperCase())
        await board.refreshIssues()
      }),
  )

  app.post<{ Body: { plate: string; truckId: number | null } }>(
    '/api/board/trailers/fixed-truck',
    {
      schema: {
        body: {
          type: 'object',
          properties: { plate: { type: 'string', minLength: 2, maxLength: 20 }, truckId: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] } },
          required: ['plate', 'truckId'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => handle(reply, () => as(request).setTrailerFixedTruck(request.body.plate, request.body.truckId)),
  )

  // Drivers (kierowcy), driver changes per tractor, certificates and their scans.
  const DRIVER_FIELDS = {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    phone: { type: 'string', maxLength: 40 },
    carrier: { type: 'string', maxLength: 200 },
    notes: { type: 'string', maxLength: 1000 },
  } as const
  const CERT_FIELDS = {
    kind: { type: 'string', minLength: 1, maxLength: 60 },
    number: { type: 'string', maxLength: 80 },
    validTo: { anyOf: [DATE, { type: 'null' }] },
    notes: { type: 'string', maxLength: 500 },
  } as const

  app.get('/api/board/drivers', async (_request, reply) => handle(reply, async () => ({ drivers: await board.drivers() })))

  app.get<{ Params: { id: string } }>('/api/board/drivers/:id', { schema: { params: ID_PARAMS } }, async (request, reply) =>
    handle(reply, () => board.driverDetails(Number(request.params.id))),
  )

  app.post<{ Body: { name: string; phone?: string; carrier?: string; notes?: string } }>(
    '/api/board/drivers',
    { schema: { body: { type: 'object', properties: DRIVER_FIELDS, required: ['name'], additionalProperties: false } } },
    async (request, reply) => handle(reply, async () => ({ id: await as(request).createDriver(request.body) })),
  )

  app.patch<{ Params: { id: string }; Body: { name?: string; phone?: string; carrier?: string; notes?: string; active?: boolean } }>(
    '/api/board/drivers/:id',
    { schema: { params: ID_PARAMS, body: { type: 'object', properties: { ...DRIVER_FIELDS, active: { type: 'boolean' } }, additionalProperties: false } } },
    async (request, reply) => handle(reply, () => as(request).updateDriver(Number(request.params.id), request.body)),
  )

  const DRIVER_ID = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] } as const
  app.post<{ Body: { truckId: number; day: string; driverId: number | null; releaseOther?: boolean } }>(
    '/api/board/driver-changes',
    {
      schema: {
        body: {
          type: 'object',
          properties: { truckId: { type: 'integer', minimum: 1 }, day: DATE, driverId: DRIVER_ID, releaseOther: { type: 'boolean' } },
          required: ['truckId', 'day', 'driverId'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => handle(reply, () => as(request).setDriverChange(request.body)),
  )

  app.patch<{ Params: { id: string }; Body: { day?: string; driverId?: number | null } }>(
    '/api/board/driver-changes/:id',
    { schema: { params: ID_PARAMS, body: { type: 'object', properties: { day: DATE, driverId: DRIVER_ID }, additionalProperties: false } } },
    async (request, reply) => handle(reply, () => as(request).updateDriverChange(Number(request.params.id), request.body)),
  )

  app.delete<{ Params: { id: string } }>('/api/board/driver-changes/:id', { schema: { params: ID_PARAMS } }, async (request, reply) =>
    handle(reply, () => as(request).deleteDriverChange(Number(request.params.id))),
  )

  app.post<{ Params: { id: string }; Body: { kind: string; number?: string; validTo?: string | null; notes?: string } }>(
    '/api/board/drivers/:id/certs',
    { schema: { params: ID_PARAMS, body: { type: 'object', properties: CERT_FIELDS, required: ['kind'], additionalProperties: false } } },
    async (request, reply) => handle(reply, async () => ({ id: await as(request).createCert(Number(request.params.id), request.body) })),
  )

  app.patch<{ Params: { id: string }; Body: { kind?: string; number?: string; validTo?: string | null; notes?: string } }>(
    '/api/board/certs/:id',
    { schema: { params: ID_PARAMS, body: { type: 'object', properties: CERT_FIELDS, additionalProperties: false } } },
    async (request, reply) => handle(reply, () => as(request).updateCert(Number(request.params.id), request.body)),
  )

  app.delete<{ Params: { id: string } }>('/api/board/certs/:id', { schema: { params: ID_PARAMS } }, async (request, reply) =>
    handle(reply, () => as(request).deleteCert(Number(request.params.id))),
  )

  app.post<{ Params: { id: string }; Body: { filename: string; dataBase64: string } }>(
    '/api/board/certs/:id/files',
    {
      bodyLimit: 25 * 1024 * 1024,
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          properties: { filename: { type: 'string', minLength: 1, maxLength: 255 }, dataBase64: { type: 'string', minLength: 1 } },
          required: ['filename', 'dataBase64'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => ({
        id: await as(request).addCertFile(Number(request.params.id), request.body.filename, Buffer.from(request.body.dataBase64, 'base64')),
      })),
  )

  // Scan preview (inline) or download (?download=1). Behind the session like every /api route.
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    '/api/board/cert-files/:id',
    { schema: { params: ID_PARAMS, querystring: { type: 'object', properties: { download: { type: 'string', enum: ['0', '1'] } } } } },
    async (request, reply) => {
      try {
        const file = await board.certFile(Number(request.params.id))
        const ascii = foldDiacritics(file.filename).replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'skan'
        const disposition = request.query.download === '1' ? 'attachment' : 'inline'
        return await reply
          .header('content-type', file.mime)
          .header(
            'content-disposition',
            `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          )
          .header('cache-control', 'private, no-store')
          .header('x-content-type-options', 'nosniff')
          .send(file.data)
      } catch (error) {
        if (error instanceof BoardError) return reply.status(error.status).send({ error: { code: error.code, message: error.message } })
        throw error
      }
    },
  )

  app.delete<{ Params: { id: string } }>('/api/board/cert-files/:id', { schema: { params: ID_PARAMS } }, async (request, reply) =>
    handle(reply, () => as(request).deleteCertFile(Number(request.params.id))),
  )

  // Places
  app.get('/api/board/places', async (_request, reply) => handle(reply, async () => ({ places: await board.places() })))

  app.post<{ Body: { code?: string; name: string; country?: string; lat: number; lon: number } }>(
    '/api/board/places',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            code: { type: 'string', maxLength: 8 },
            name: { type: 'string', minLength: 1, maxLength: 100 },
            country: { type: 'string', maxLength: 2 },
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lon: { type: 'number', minimum: -180, maximum: 180 },
          },
          required: ['name', 'lat', 'lon'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const code = await as(request).createPlace(request.body)
        await board.refreshIssues()
        return { code }
      }),
  )

  app.post<{ Body: { alias: string; code: string } }>(
    '/api/board/places/aliases',
    {
      schema: {
        body: {
          type: 'object',
          properties: { alias: { type: 'string', minLength: 1, maxLength: 100 }, code: { type: 'string', minLength: 2, maxLength: 8 } },
          required: ['alias', 'code'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        await as(request).addPlaceAlias(request.body.alias, request.body.code.toUpperCase())
        await board.refreshIssues()
      }),
  )

  app.put<{ Body: { from: string; to: string; km: number; note?: string } }>(
    '/api/board/distances',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            from: { type: 'string', minLength: 2, maxLength: 8 },
            to: { type: 'string', minLength: 2, maxLength: 8 },
            km: { type: 'number', minimum: 0 },
            note: { type: 'string', maxLength: 300 },
          },
          required: ['from', 'to', 'km'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        await as(request).setDistance(request.body.from, request.body.to, request.body.km, request.body.note ?? null)
        await board.refreshIssues()
      }),
  )

  app.get('/api/board/thresholds', async (_request, reply) => handle(reply, async () => ({ thresholds: await board.thresholds() })))

  app.put<{ Body: { marginWarnPct?: number; revPerKmMin?: number; revPerKmMax?: number } }>(
    '/api/board/thresholds',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            marginWarnPct: { type: 'number', minimum: 1, maximum: 100 },
            revPerKmMin: { type: 'number', minimum: 0 },
            revPerKmMax: { type: 'number', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        await as(request).setThresholds(request.body)
        return { thresholds: await board.thresholds() }
      }),
  )

  app.get<{ Querystring: { q: string } }>(
    '/api/board/geocode',
    { schema: { querystring: { type: 'object', properties: { q: { type: 'string', minLength: 2, maxLength: 120 } }, required: ['q'] } } },
    async (request, reply) =>
      handle(reply, async () => ({ candidates: deps.geocoder ? await deps.geocoder.geocode(request.query.q) : [] })),
  )
}
