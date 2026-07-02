/**
 * Server environment. The HERE API key comes from the environment ONLY and
 * is asserted at startup (PRD §4.1 / kickoff Phase 3) — the process refuses
 * to boot without it, so a misconfiguration can never silently disable the
 * proxy or tempt anyone to put the key client-side.
 */

export interface ServerEnv {
  hereApiKey: string
  databasePath: string
  port: number
  host: string
}

export function loadServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const hereApiKey = env['HERE_API_KEY']?.trim()
  if (!hereApiKey) {
    throw new Error(
      'HERE_API_KEY environment variable is not set. Refusing to start — see .env.example.',
    )
  }

  const portRaw = env['PORT'] ?? '3001'
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT environment variable is not a valid port: '${portRaw}'.`)
  }

  return {
    hereApiKey,
    databasePath: env['DATABASE_PATH'] ?? 'data/calculator.sqlite',
    port,
    host: env['HOST'] ?? '127.0.0.1',
  }
}
