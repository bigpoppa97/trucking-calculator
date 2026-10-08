import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { NoteKind } from '../db/schema.js'
import type { HereGeocodingClient } from '../here/hereGeocodingClient.js'
import { BoardError, type BoardService } from './boardService.js'
import { ExportFormatError } from './exportReader.js'

/**
 * HTTP endpoints of the board (prefix /api/board). Thin layer over
 * BoardService; every failure maps to a static, Polish message.
 */

export interface BoardRouteDeps {
  board: BoardService
  geocoder?: Pick<HereGeocodingClient, 'geocode'> | undefined
}

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const
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
            kind: { type: 'string', enum: ['note', 'pause', 'service', 'driver', 'trailer', 'position'] },
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

  app.patch<{ Params: { id: string }; Body: { carrier?: string; driver?: string; phone?: string; trailerPlate?: string | null; notes?: string; active?: boolean; sortOrder?: number } }>(
    '/api/board/fleet/:id',
    {
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          properties: {
            carrier: { type: 'string', maxLength: 200 },
            driver: { type: 'string', maxLength: 200 },
            phone: { type: 'string', maxLength: 40 },
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
