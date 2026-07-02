import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDatabase, migrateToLatest } from '../db/database.js'
import { AirportRepository } from '../repositories/airportRepository.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { HereRoutingClient } from '../here/hereRoutingClient.js'
import { RouteFetchService } from '../here/routeFetchService.js'
import { buildApp } from './app.js'
import { loadServerEnv } from './env.js'

// Startup assertion first: no HERE_API_KEY → no server (kickoff Phase 3).
const env = loadServerEnv()

mkdirSync(dirname(env.databasePath), { recursive: true })
const db = createDatabase(env.databasePath)
await migrateToLatest(db)

const fetchService = new RouteFetchService({
  client: new HereRoutingClient({ apiKey: env.hereApiKey }),
  airports: new AirportRepository(db),
  routes: new RouteRepository(db),
  config: new ConfigRepository(db),
})

const app = buildApp({ db, fetchService })

try {
  await app.listen({ port: env.port, host: env.host })
  console.log(`Portal backend listening on http://${env.host}:${env.port}`)
} catch (error) {
  console.error('Failed to start server:', error instanceof Error ? error.message : error)
  process.exit(1)
}
