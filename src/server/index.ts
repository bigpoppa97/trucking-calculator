import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDatabase, migrateToLatest } from '../db/database.js'
import { AirportRepository } from '../repositories/airportRepository.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { readFileSync } from 'node:fs'
import { HereRoutingClient } from '../here/hereRoutingClient.js'
import { HereGeocodingClient } from '../here/hereGeocodingClient.js'
import { RouteFetchService } from '../here/routeFetchService.js'
import { BoardService } from '../board/boardService.js'
import { DistanceService } from '../board/distances.js'
import { ensurePlaceSeed } from '../board/placeSeed.js'
import { importAirports } from '../import/importAirports.js'
import { buildApp } from './app.js'
import { loadServerEnv } from './env.js'

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
const board = new BoardService(db, distances, { actor: process.env['BOARD_USER'] ?? 'kierownik' })

const app = buildApp({ db, fetchService, board, geocoder: new HereGeocodingClient({ apiKey: env.hereApiKey }) })

try {
  await app.listen({ port: env.port, host: env.host })
  console.log(`Portal backend listening on http://${env.host}:${env.port}`)
} catch (error) {
  console.error('Failed to start server:', error instanceof Error ? error.message : error)
  process.exit(1)
}
