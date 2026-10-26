import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { createTestDatabase, migrateToLatest } from '../db/database.js'
import { AirportRepository } from '../repositories/airportRepository.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { UserRepository } from '../repositories/userRepository.js'
import { RouteFetchService } from '../here/routeFetchService.js'
import { hashPassword } from '../auth/password.js'
import { AccessVerifier, normalizeTeamDomain } from './cloudflareAccess.js'
import { hostnameOf, isAllowedHost, isSameOrigin } from './requestGuards.js'
import { buildApp } from './app.js'
import { loadServerEnv } from './env.js'

const TEAM = 'https://zet-test.cloudflareaccess.com'
const AUD = 'aud-tag-123'
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0)

interface TestKey {
  kid: string
  privateKey: KeyObject
  jwk: Record<string, unknown>
}

function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } }
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

function token(key: TestKey, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const nowS = Math.floor(NOW / 1000)
  const head = b64({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header })
  const body = b64({
    aud: [AUD],
    email: 'Wojciech@Zet.pl',
    iss: TEAM,
    iat: nowS - 10,
    nbf: nowS - 10,
    exp: nowS + 3600,
    type: 'app',
    ...claims,
  })
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url')
  return `${head}.${body}.${signature}`
}

function verifierWith(keys: () => TestKey[], clock = { now: NOW }) {
  const calls: string[] = []
  const verifier = new AccessVerifier(
    { teamDomain: 'zet-test', aud: AUD },
    {
      now: () => clock.now,
      fetchKeys: async url => {
        calls.push(url)
        return { keys: keys().map(k => k.jwk), public_cert: { kid: 'x', cert: '' } }
      },
    },
  )
  return { verifier, calls, clock }
}

describe('normalizeTeamDomain', () => {
  it('accepts a bare team name, a domain or a URL', () => {
    expect(normalizeTeamDomain('zet')).toBe('https://zet.cloudflareaccess.com')
    expect(normalizeTeamDomain('zet.cloudflareaccess.com')).toBe('https://zet.cloudflareaccess.com')
    expect(normalizeTeamDomain(' https://Zet.cloudflareaccess.com/ ')).toBe('https://zet.cloudflareaccess.com')
    expect(() => normalizeTeamDomain('')).toThrow()
    expect(() => normalizeTeamDomain('zet/../x')).toThrow()
  })
})

describe('AccessVerifier', () => {
  const key = makeKey('k1')

  it('accepts a valid token and returns the lower-cased email', async () => {
    const { verifier, calls } = verifierWith(() => [key])
    expect(await verifier.verify(token(key))).toEqual({ email: 'wojciech@zet.pl' })
    expect(calls).toEqual([`${TEAM}/cdn-cgi/access/certs`])
    // keys are cached
    await verifier.verify(token(key))
    expect(calls).toHaveLength(1)
  })

  it('accepts aud as a plain string', async () => {
    const { verifier } = verifierWith(() => [key])
    expect(await verifier.verify(token(key, { aud: AUD }))).not.toBeNull()
  })

  it('rejects wrong audience, issuer, expired and not-yet-valid tokens', async () => {
    const { verifier } = verifierWith(() => [key])
    const nowS = Math.floor(NOW / 1000)
    expect(await verifier.verify(token(key, { aud: ['other-app'] }))).toBeNull()
    expect(await verifier.verify(token(key, { iss: 'https://evil.cloudflareaccess.com' }))).toBeNull()
    expect(await verifier.verify(token(key, { exp: nowS - 3600 }))).toBeNull()
    expect(await verifier.verify(token(key, { nbf: nowS + 3600 }))).toBeNull()
    expect(await verifier.verify(token(key, { exp: undefined }))).toBeNull()
  })

  it('rejects a token signed by another key, a tampered payload and alg tricks', async () => {
    const { verifier } = verifierWith(() => [key])
    const forger = makeKey('k1') // same kid, different key
    expect(await verifier.verify(token(forger))).toBeNull()

    const [h, , s] = token(key).split('.')
    const tampered = `${h}.${b64({ aud: [AUD], email: 'boss@zet.pl', iss: TEAM, exp: Math.floor(NOW / 1000) + 60 })}.${s}`
    expect(await verifier.verify(tampered)).toBeNull()

    expect(await verifier.verify(token(key, {}, { alg: 'none' }))).toBeNull()
    expect(await verifier.verify(token(key, {}, { alg: 'HS256' }))).toBeNull()
    expect(await verifier.verify('not.a-token')).toBeNull()
    expect(await verifier.verify('a.b.c')).toBeNull()
  })

  it('rejects service tokens (no email)', async () => {
    const { verifier } = verifierWith(() => [key])
    expect(await verifier.verify(token(key, { email: undefined, common_name: 'svc' }))).toBeNull()
  })

  it('picks up a rotated key, but fetches the certs at most once a minute', async () => {
    const rotated = makeKey('k2')
    let published = [key]
    const { verifier, calls, clock } = verifierWith(() => published)
    expect(await verifier.verify(token(key))).not.toBeNull()

    published = [key, rotated]
    // unknown kid within the first minute: no refetch yet
    clock.now = NOW + 30_000
    expect(await verifier.verify(token(rotated))).toBeNull()
    expect(calls).toHaveLength(1)

    clock.now = NOW + 61_000
    expect(await verifier.verify(token(rotated))).not.toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('keeps working on cached keys when the certs endpoint is down', async () => {
    let down = false
    const verifier = new AccessVerifier(
      { teamDomain: TEAM, aud: AUD },
      {
        now: () => NOW + (down ? 2 * 3600_000 : 0),
        fetchKeys: async () => {
          if (down) throw new Error('offline')
          return { keys: [key.jwk] }
        },
      },
    )
    expect(await verifier.verify(token(key))).not.toBeNull()
    down = true
    const late = token(key, { exp: Math.floor(NOW / 1000) + 3 * 3600 })
    expect(await verifier.verify(late)).not.toBeNull()
  })
})

describe('request guards', () => {
  it('parses hostnames and checks the public host', () => {
    expect(hostnameOf('Tablica.Example.pl:443')).toBe('tablica.example.pl')
    expect(hostnameOf('[::1]:3001')).toBe('[::1]')
    expect(isAllowedHost('evil.example.com', null)).toBe(true)
    expect(isAllowedHost('localhost:3001', 'tablica.example.pl')).toBe(true)
    expect(isAllowedHost('127.0.0.1:3001', 'tablica.example.pl')).toBe(true)
    expect(isAllowedHost('tablica.example.pl', 'tablica.example.pl')).toBe(true)
    expect(isAllowedHost('rebind.evil.com:3001', 'tablica.example.pl')).toBe(false)
    expect(isAllowedHost(undefined, 'tablica.example.pl')).toBe(false)
  })

  it('compares the Origin with the Host', () => {
    expect(isSameOrigin('https://tablica.example.pl', 'tablica.example.pl')).toBe(true)
    expect(isSameOrigin('http://localhost:3001', 'localhost:3001')).toBe(true)
    expect(isSameOrigin('https://evil.com', 'tablica.example.pl')).toBe(false)
    expect(isSameOrigin('null', 'localhost:3001')).toBe(false)
    // Vite dev proxy: :5173 → 127.0.0.1:3001
    expect(isSameOrigin('http://localhost:5173', '127.0.0.1:3001')).toBe(true)
    expect(isSameOrigin('https://evil.com', '127.0.0.1:3001')).toBe(false)
    expect(isSameOrigin('http://localhost:5173', 'tablica.example.pl')).toBe(false)
    expect(isSameOrigin('http://localhost:8080', '127.0.0.1:3001')).toBe(false)
  })
})

describe('server env', () => {
  const base = { HERE_API_KEY: 'k' }
  it('needs both Access settings or neither, and PUBLIC_HOST with them', () => {
    expect(loadServerEnv(base).access).toBeNull()
    const on = { ...base, CF_ACCESS_TEAM_DOMAIN: 'zet', CF_ACCESS_AUD: 'a', PUBLIC_HOST: 'tablica.example.pl' }
    expect(loadServerEnv(on).access).toEqual({ teamDomain: 'zet', aud: 'a' })
    expect(() => loadServerEnv({ ...base, CF_ACCESS_TEAM_DOMAIN: 'zet' })).toThrow(/CF_ACCESS_AUD/)
    expect(() => loadServerEnv({ ...base, CF_ACCESS_AUD: 'a' })).toThrow(/CF_ACCESS_TEAM_DOMAIN/)
    expect(() => loadServerEnv({ ...base, CF_ACCESS_TEAM_DOMAIN: 'zet', CF_ACCESS_AUD: 'a' })).toThrow(/PUBLIC_HOST/)
  })

  it('normalizes PUBLIC_HOST', () => {
    expect(loadServerEnv(base).publicHost).toBeNull()
    expect(loadServerEnv({ ...base, PUBLIC_HOST: 'https://Tablica.Example.pl/' }).publicHost).toBe('tablica.example.pl')
  })
})

describe('sign-in through Cloudflare Access', () => {
  const key = makeKey('app-key')
  let db: Kysely<DB>
  let app: FastifyInstance
  let plainApp: FastifyInstance

  const asAccess = (claims: Record<string, unknown> = {}) => ({ 'cf-access-jwt-assertion': token(key, claims) })

  beforeEach(async () => {
    db = createTestDatabase()
    await migrateToLatest(db)
    const fetchService = new RouteFetchService({
      client: { fetchRoute: async () => ({ routes: [] }) },
      airports: new AirportRepository(db),
      routes: new RouteRepository(db),
      config: new ConfigRepository(db),
    })
    const users = new UserRepository(db)
    await users.create({ email: 'wojciech@zet.pl', displayName: 'Wojciech', role: 'admin', passwordHash: await hashPassword('secret-password') })
    const off = await users.create({ email: 'byly@zet.pl', displayName: 'Były', role: 'dispatcher', passwordHash: await hashPassword('secret-password') })
    await users.updateById(off.id, { active: false })

    const { verifier } = verifierWith(() => [key])
    app = buildApp({ db, fetchService, access: verifier, publicHost: 'tablica.example.pl' })
    plainApp = buildApp({ db, fetchService })
  })

  it('signs in the account with the Access email, without a board session', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: asAccess() })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ user: { email: 'wojciech@zet.pl', displayName: 'Wojciech', role: 'admin' }, via: 'access' })
    expect(me.cookies).toHaveLength(0)

    const users = await app.inject({ method: 'GET', url: '/api/users', headers: asAccess() })
    expect(users.statusCode).toBe(200)
  })

  it('refuses an email without an active account, naming the address', async () => {
    for (const email of ['obcy@zet.pl', 'byly@zet.pl']) {
      const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: asAccess({ email }) })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ error: { code: 'NO_ACCOUNT', email } })
    }
  })

  it('refuses an invalid Access token instead of falling back to the session', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'wojciech@zet.pl', password: 'secret-password' },
    })
    const session = login.cookies.find(c => c.name === 'session')!.value
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { session },
      headers: asAccess({ aud: ['other-app'] }),
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: { code: 'ACCESS_INVALID' } })
  })

  it('refuses password login for requests that come through Access', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: asAccess(),
      payload: { email: 'wojciech@zet.pl', password: 'secret-password' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'USE_ACCESS' } })
  })

  it('keeps password login on localhost, with via = session', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'wojciech@zet.pl', password: 'secret-password' },
    })
    expect(login.statusCode).toBe(200)
    const session = login.cookies.find(c => c.name === 'session')!
    expect(session.secure).toBeFalsy()
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { session: session.value } })
    expect(me.json()).toMatchObject({ via: 'session' })
  })

  it('marks the session cookie Secure behind a local HTTPS proxy (no Access)', async () => {
    const login = await plainApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.0.0.5' },
      payload: { email: 'wojciech@zet.pl', password: 'secret-password' },
    })
    expect(login.statusCode).toBe(200)
    expect(login.cookies.find(c => c.name === 'session')?.secure).toBe(true)
  })

  it('fails closed: without a valid Access token only a local request may use the password', async () => {
    const credentials = { email: 'wojciech@zet.pl', password: 'secret-password' }
    const local = await app.inject({ method: 'POST', url: '/api/auth/login', payload: credentials })
    const session = local.cookies.find(c => c.name === 'session')!.value

    // Through the tunnel, Access missing in front (app deleted, path-scoped, second hostname, bypass policy)
    const viaTunnel = [
      { host: 'tablica.example.pl', 'x-forwarded-proto': 'https', 'cf-ray': '8a1b-WAW', 'cf-connecting-ip': '203.0.113.7' },
      { host: 'tablica.example.pl' },
      { host: 'localhost:3001', 'cf-ray': '8a1b-WAW' },
      { host: '127.0.0.1:3001', 'x-forwarded-for': '203.0.113.7' },
    ]
    // A LAN machine (HOST=0.0.0.0) sending Host: localhost without proxy headers
    const lan = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '192.168.1.20',
      headers: { host: 'localhost:3001' },
      payload: credentials,
    })
    expect(lan.statusCode).toBe(401)
    expect(lan.json()).toMatchObject({ error: { code: 'ACCESS_REQUIRED' } })
    for (const headers of viaTunnel) {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: credentials })
      expect(login.statusCode).toBe(401)
      expect(login.json()).toMatchObject({ error: { code: 'ACCESS_REQUIRED' } })
      expect(login.cookies).toHaveLength(0)
      const me = await app.inject({ method: 'GET', url: '/api/users', headers, cookies: { session } })
      expect(me.statusCode).toBe(401)
      expect(me.json()).toMatchObject({ error: { code: 'ACCESS_REQUIRED' } })
    }
    // ...while a valid Access token through the tunnel still works
    const ok = await app.inject({ method: 'GET', url: '/api/users', headers: { ...viaTunnel[0], ...asAccess() } })
    expect(ok.statusCode).toBe(200)
  })

  it('refuses everything that came through Cloudflare while Access is not configured', async () => {
    const headers = { host: 'tablica.example.pl', 'cf-ray': '8a1b-WAW', 'cf-connecting-ip': '203.0.113.7' }
    const login = await plainApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload: { email: 'wojciech@zet.pl', password: 'secret-password' },
    })
    expect(login.statusCode).toBe(403)
    expect(login.json()).toMatchObject({ error: { code: 'ACCESS_NOT_CONFIGURED' } })
    const local = await plainApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'wojciech@zet.pl', password: 'secret-password' },
    })
    expect(local.statusCode).toBe(200)
  })

  it('accepts writes from the Vite dev server (localhost:5173 → 127.0.0.1:3001)', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: '127.0.0.1:3001', origin: 'http://localhost:5173' },
      payload: { email: 'wojciech@zet.pl', password: 'secret-password' },
    })
    expect(login.statusCode).toBe(200)
  })

  it('ignores the Access header when Access is not configured', async () => {
    const res = await plainApp.inject({ method: 'GET', url: '/api/auth/me', headers: asAccess() })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
  })

  it('serves only localhost and the public host', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { ...asAccess(), host: 'tablica.example.pl' } })
    expect(ok.statusCode).toBe(200)
    const bad = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { ...asAccess(), host: 'rebind.evil.com' } })
    expect(bad.statusCode).toBe(421)
  })

  it('blocks writes sent from another site', async () => {
    const headers = { ...asAccess(), host: 'tablica.example.pl', 'content-type': 'application/json' }
    const payload = { email: 'nowy@zet.pl', displayName: 'Nowy', role: 'dispatcher', password: 'haslo-123456' }
    const cross = await app.inject({ method: 'POST', url: '/api/users', headers: { ...headers, origin: 'https://evil.com' }, payload })
    expect(cross.statusCode).toBe(403)
    expect(cross.json()).toMatchObject({ error: { code: 'CROSS_ORIGIN' } })
    const same = await app.inject({ method: 'POST', url: '/api/users', headers: { ...headers, origin: 'https://tablica.example.pl' }, payload })
    expect(same.statusCode).toBe(201)
  })
})
