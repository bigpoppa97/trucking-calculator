import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import fastifyStatic from '@fastify/static'
import { createDatabase, migrateToLatest } from '../db/database.js'
import { AirportRepository } from '../repositories/airportRepository.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { TollSystemRuleRepository } from '../repositories/tollSystemRuleRepository.js'
import { RouteWaypointRepository } from '../repositories/routeWaypointRepository.js'
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
  tollRules: new TollSystemRuleRepository(db),
  waypoints: new RouteWaypointRepository(db),
})

const app = buildApp({ db, fetchService, secureCookies: env.cookieSecure })

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
