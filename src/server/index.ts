import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import fastifyStatic from '@fastify/static'
import { createDatabase, migrateToLatest } from '../db/database.js'
import { AirportRepository } from '../repositories/airportRepository.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { TollSystemRuleRepository } from '../repositories/tollSystemRuleRepository.js'
import { RouteWaypointRepository } from '../repositories/routeWaypointRepository.js'
import { HereRoutingClient } from '../here/hereRoutingClient.js'
import { HereGeocodingClient } from '../here/hereGeocodingClient.js'
import { RouteFetchService } from '../here/routeFetchService.js'
import { BoardService } from '../board/boardService.js'
import { DistanceService } from '../board/distances.js'
import { ensurePlaceSeed } from '../board/placeSeed.js'
import { importAirports } from '../import/importAirports.js'
import { buildApp } from './app.js'
import { loadServerEnv } from './env.js'
import { loadDotEnv } from '../loadDotEnv.js'

loadDotEnv()

// Startup assertion first: no HERE_API_KEY → no server (kickoff Phase 3).
const env = loadServerEnv()

mkdirSync(dirname(env.databasePath), { recursive: true })
const db = createDatabase(env.databasePath)
await migrateToLatest(db)

const routingClient = new HereRoutingClient({ apiKey: env.hereApiKey })
const configRepo = new ConfigRepository(db)
const fetchService = new RouteFetchService({
  client: routingClient,
  airports: new AirportRepository(db),
  routes: new RouteRepository(db),
  config: configRepo,
  tollRules: new TollSystemRuleRepository(db),
  waypoints: new RouteWaypointRepository(db),
})

// Board (tablica): place dictionary + airports for km, HERE in the background.
if ((await new AirportRepository(db).count()) === 0) {
  try {
    await importAirports(db, readFileSync('data/v1/airports.csv', 'utf-8'))
  } catch {
    console.warn('Airport list not loaded (data/v1/airports.csv missing) — board places still work.')
  }
}
await ensurePlaceSeed(db)
const distances = new DistanceService({
  db,
  fetchService,
  hereClient: routingClient,
  vehicleProfile: () => configRepo.getTollVehicleProfile(),
  allowHere: process.env['BOARD_HERE'] !== 'off',
  actor: 'tablica',
})
const board = new BoardService(db, distances, { actor: process.env['BOARD_USER'] ?? 'tablica' })

const app = buildApp({
  db,
  fetchService,
  board,
  geocoder: new HereGeocodingClient({ apiKey: env.hereApiKey }),
  secureCookies: env.cookieSecure,
})

// Production mode: serve the built web UI (vite build → web/dist) from the
// same process, so one port carries both the SPA and /api — a single thing
// to tunnel or deploy. Dev keeps using the Vite server + proxy instead.
const webDist = resolve(env.webDistDir)
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist })
  app.setNotFoundHandler((request, reply) => {
    if ((request.raw.url ?? '').startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown API route.' } })
    }
    // SPA fallback — client-side routes resolve to index.html.
    return reply.sendFile('index.html')
  })
  console.log(`Serving web UI from ${webDist}`)
} else {
  console.log(`No built web UI at ${webDist} — API only (use the Vite dev server for the frontend).`)
}

try {
  await app.listen({ port: env.port, host: env.host })
  console.log(`Portal backend listening on http://${env.host}:${env.port}`)
} catch (error) {
  console.error('Failed to start server:', error instanceof Error ? error.message : error)
  process.exit(1)
}
