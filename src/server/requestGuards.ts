import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Cheap guards for a board that is reachable from outside (Cloudflare tunnel):
 *
 * - Host: with PUBLIC_HOST set, only that hostname and localhost are served. A
 *   page on another site cannot point a hostname at 127.0.0.1 and talk to the
 *   board from the user's own browser (DNS rebinding).
 * - Origin: a write (POST/PUT/PATCH/DELETE) sent by a browser from another
 *   site is refused, even if the browser would attach our cookies to it.
 *   Requests without an Origin header (scripts, tests, same-origin GETs) pass.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** "Tablica.Example.pl:443" → "tablica.example.pl", "[::1]:3001" → "[::1]". */
export function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(0, end + 1)
  }
  return value.split(':')[0] ?? value
}

export function isAllowedHost(hostHeader: string | undefined, publicHost: string | null): boolean {
  if (publicHost === null) return true
  if (!hostHeader) return false
  const name = hostnameOf(hostHeader)
  return LOOPBACK_HOSTS.has(name) || name === hostnameOf(publicHost)
}

export function isSameOrigin(originHeader: string, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  try {
    return new URL(originHeader).host.toLowerCase() === hostHeader.trim().toLowerCase()
  } catch {
    return false // "null" or garbage
  }
}

export function registerRequestGuards(app: FastifyInstance, options: { publicHost: string | null }): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const host = request.headers.host
    if (!isAllowedHost(host, options.publicHost)) {
      return reply.status(421).type('text/plain; charset=utf-8').send(
        `Ten adres (${host ?? 'brak'}) nie jest adresem tablicy. Dozwolone: localhost i ${options.publicHost} (PUBLIC_HOST w .env).`,
      )
    }
    const origin = request.headers.origin
    if (
      origin !== undefined &&
      !SAFE_METHODS.has(request.method) &&
      !isSameOrigin(origin, host)
    ) {
      return reply
        .status(403)
        .send({ error: { code: 'CROSS_ORIGIN', message: 'Zapis z innej strony niż tablica został zablokowany.' } })
    }
  })
}
