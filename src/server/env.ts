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
  /** Mark session cookies Secure — set COOKIE_SECURE=true behind HTTPS. */
  cookieSecure: boolean
  /** Directory of the built web UI; served when it exists. */
  webDistDir: string
  /** Cloudflare Access (CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD); null = password login only. */
  access: { teamDomain: string; aud: string } | null
  /** Public hostname (PUBLIC_HOST, e.g. tablica.example.pl); when set, other Host headers are refused. */
  publicHost: string | null
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

  const teamDomain = env['CF_ACCESS_TEAM_DOMAIN']?.trim() ?? ''
  const aud = env['CF_ACCESS_AUD']?.trim() ?? ''
  if ((teamDomain === '') !== (aud === '')) {
    throw new Error(
      'Cloudflare Access needs both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD in .env (or neither). Refusing to start.',
    )
  }
  const publicHost = (env['PUBLIC_HOST'] ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase()
  if (teamDomain !== '' && publicHost === '') {
    throw new Error(
      'Cloudflare Access is on but PUBLIC_HOST is empty — set PUBLIC_HOST to the tunnel address (e.g. tablica.example.com) in .env. Refusing to start.',
    )
  }

  return {
    hereApiKey,
    databasePath: env['DATABASE_PATH'] ?? 'data/calculator.sqlite',
    port,
    host: env['HOST'] ?? '127.0.0.1',
    cookieSecure: env['COOKIE_SECURE'] === 'true',
    webDistDir: env['WEB_DIST'] ?? 'web/dist',
    access: teamDomain === '' ? null : { teamDomain, aud },
    publicHost: publicHost === '' ? null : publicHost,
  }
}
