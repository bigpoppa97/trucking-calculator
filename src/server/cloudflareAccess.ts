import { createPublicKey, verify as verifySignature, type JsonWebKeyInput, type KeyObject } from 'node:crypto'

/**
 * Cloudflare Access in front of the board (tunnel from the office PC, later a server).
 *
 * Access authenticates the person (Microsoft 365 / one-time PIN) before a request
 * ever reaches us and forwards a signed JWT in `Cf-Access-Jwt-Assertion`. We verify
 * it ourselves (RS256 against the team's published keys, issuer, audience, expiry)
 * and map its `email` claim to an account in Użytkownicy — so the board never trusts
 * a header it has not checked, and roles stay managed in the board as before.
 *
 * Docs: developers.cloudflare.com → Access → Validate JWTs. Keys rotate every
 * 6 weeks (old ones stay valid 7 days), so they are fetched at runtime and cached.
 */

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion'

export interface AccessConfig {
  /** Team domain, e.g. "zet.cloudflareaccess.com" (with or without https://). */
  teamDomain: string
  /** Application Audience (AUD) tag of the Access application. */
  aud: string
}

export interface AccessIdentity {
  email: string
}

export interface AccessVerifierOptions {
  /** Injected in tests; defaults to fetching the team's certs endpoint. */
  fetchKeys?: (url: string) => Promise<unknown>
  /** Milliseconds since epoch; injected in tests. */
  now?: () => number
}

const CLOCK_LEEWAY_S = 60
const KEYS_MAX_AGE_MS = 60 * 60 * 1000 // refresh hourly
const MIN_REFETCH_INTERVAL_MS = 60 * 1000 // at most one certs fetch a minute

/** "zet", "zet.cloudflareaccess.com" or "https://zet.cloudflareaccess.com/" → "https://zet.cloudflareaccess.com". */
export function normalizeTeamDomain(raw: string): string {
  let value = raw.trim().replace(/\/+$/, '')
  value = value.replace(/^https?:\/\//i, '')
  if (value === '') throw new Error('Cloudflare Access team domain is empty.')
  if (!value.includes('.')) value = `${value}.cloudflareaccess.com`
  if (!/^[a-z0-9.-]+$/i.test(value)) throw new Error(`Invalid Cloudflare Access team domain: '${raw}'.`)
  return `https://${value.toLowerCase()}`
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function defaultFetchKeys(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Cloudflare Access certs: HTTP ${response.status}`)
  return response.json()
}

export class AccessVerifier {
  readonly issuer: string
  private readonly aud: string
  private readonly fetchKeys: (url: string) => Promise<unknown>
  private readonly now: () => number
  private keys = new Map<string, KeyObject>()
  private keysFetchedAt = 0
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  private pending: Promise<void> | null = null

  constructor(config: AccessConfig, options: AccessVerifierOptions = {}) {
    this.issuer = normalizeTeamDomain(config.teamDomain)
    this.aud = config.aud.trim()
    if (this.aud === '') throw new Error('Cloudflare Access AUD tag is empty.')
    this.fetchKeys = options.fetchKeys ?? defaultFetchKeys
    this.now = options.now ?? Date.now
  }

  get certsUrl(): string {
    return `${this.issuer}/cdn-cgi/access/certs`
  }

  /** Verified identity, or null for any token that is not a valid Access token for this application. */
  async verify(token: string): Promise<AccessIdentity | null> {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

    let header: unknown
    let payload: unknown
    try {
      header = decodeSegment(headerPart)
      payload = decodeSegment(payloadPart)
    } catch {
      return null
    }
    if (!isRecord(header) || !isRecord(payload)) return null
    if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') return null

    const key = await this.keyFor(header['kid'])
    if (!key) return null
    const signedOk = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      key,
      Buffer.from(signaturePart, 'base64url'),
    )
    if (!signedOk) return null

    if (payload['iss'] !== this.issuer) return null
    const aud = payload['aud']
    const audOk = Array.isArray(aud) ? aud.includes(this.aud) : aud === this.aud
    if (!audOk) return null

    const nowS = this.now() / 1000
    const exp = payload['exp']
    if (typeof exp !== 'number' || exp + CLOCK_LEEWAY_S < nowS) return null
    const nbf = payload['nbf']
    if (typeof nbf === 'number' && nbf - CLOCK_LEEWAY_S > nowS) return null

    // Service tokens (machine access) carry no email — not a person, no board account.
    const email = payload['email']
    if (typeof email !== 'string' || !email.includes('@')) return null
    return { email: email.trim().toLowerCase() }
  }

  private async keyFor(kid: string): Promise<KeyObject | undefined> {
    const now = this.now()
    const stale = this.keysFetchedAt === 0 || now - this.keysFetchedAt > KEYS_MAX_AGE_MS
    // An unknown key id may be a freshly rotated key. Never more than one fetch a minute.
    if ((stale || !this.keys.has(kid)) && now - this.lastAttemptAt >= MIN_REFETCH_INTERVAL_MS) {
      await this.refresh()
    } else if (this.pending) {
      await this.pending
    }
    return this.keys.get(kid)
  }

  private async refresh(): Promise<void> {
    if (this.pending) return this.pending
    this.lastAttemptAt = this.now()
    this.pending = (async () => {
      try {
        const body = await this.fetchKeys(this.certsUrl)
        const list = isRecord(body) && Array.isArray(body['keys']) ? body['keys'] : []
        const next = new Map<string, KeyObject>()
        for (const jwk of list) {
          if (!isRecord(jwk) || jwk['kty'] !== 'RSA' || typeof jwk['kid'] !== 'string') continue
          try {
            next.set(jwk['kid'], createPublicKey({ key: jwk, format: 'jwk' } as JsonWebKeyInput))
          } catch {
            // skip a malformed key, keep the rest
          }
        }
        if (next.size === 0) throw new Error('no RSA keys in the response')
        this.keys = next
        this.keysFetchedAt = this.now()
      } catch (error) {
        // Keep the previous keys; the next attempt comes after the refetch interval.
        console.warn('Cloudflare Access: could not load signing keys —', error instanceof Error ? error.message : error)
      } finally {
        this.pending = null
      }
    })()
    return this.pending
  }
}
