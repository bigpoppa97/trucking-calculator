import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { createTestDatabase, migrateToLatest } from '../db/database.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { AirportRepository } from '../repositories/airportRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { UserRepository } from '../repositories/userRepository.js'
import { RouteFetchService } from '../here/routeFetchService.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { buildApp } from './app.js'
import { seedSession } from './testAuth.js'

let db: Kysely<DB>
let app: FastifyInstance

beforeEach(async () => {
  db = createTestDatabase()
  await migrateToLatest(db)
  await new ConfigRepository(db).setMany({
    fuel_price: '1.4',
    consumption: '28',
    driver_day_rate: '160',
    monthly_overhead: '3012',
    month_days: '30',
  })
  const fetchService = new RouteFetchService({
    client: { fetchRoute: async () => ({ routes: [] }) },
    airports: new AirportRepository(db),
    routes: new RouteRepository(db),
    config: new ConfigRepository(db),
  })
  app = buildApp({ db, fetchService })
})

describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('wrong password', hash)).toBe(false)
  })

  it('rejects malformed stored hashes without throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$a$b$c$zz$zz')).toBe(false)
  })
})

describe('login / logout', () => {
  beforeEach(async () => {
    await new UserRepository(db).create({
      email: 'anna@firma.pl',
      displayName: 'Anna',
      role: 'dispatcher',
      passwordHash: await hashPassword('secret-password'),
    })
  })

  it('logs in with valid credentials and sets a session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'anna@firma.pl', password: 'secret-password' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { user: { email: string; role: string } }).user).toMatchObject({
      email: 'anna@firma.pl',
      role: 'dispatcher',
    })
    const cookie = res.cookies.find(c => c.name === 'session')
    expect(cookie).toBeDefined()
    expect(cookie?.httpOnly).toBe(true)

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { session: cookie!.value } })
    expect(me.statusCode).toBe(200)
    expect((me.json() as { user: { email: string } }).user.email).toBe('anna@firma.pl')
  })

  it('rejects a wrong password with the same message as an unknown email', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'anna@firma.pl', password: 'nope' },
    })
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@firma.pl', password: 'nope' },
    })
    expect(wrongPassword.statusCode).toBe(401)
    expect(unknownEmail.statusCode).toBe(401)
    expect(wrongPassword.body).toBe(unknownEmail.body)
  })

  it('rejects a deactivated account', async () => {
    const repo = new UserRepository(db)
    const row = await repo.findByEmail('anna@firma.pl')
    await repo.updateById(row!.id, { active: false })
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'anna@firma.pl', password: 'secret-password' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('logout invalidates the session', async () => {
    const { cookies } = await seedSession(db, 'dispatcher')
    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies })
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies })
    expect(me.statusCode).toBe(401)
  })
})

describe('authentication requirement', () => {
  it('returns 401 for API calls without a session', async () => {
    for (const url of ['/api/config', '/api/routes', '/api/airports', '/api/calculations']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(401)
      expect((res.json() as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED')
    }
  })

  it('returns 401 for a garbage session token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config', cookies: { session: 'forged-token' } })
    expect(res.statusCode).toBe(401)
  })
})

describe('role guards', () => {
  it('dispatcher cannot edit config, fleet variants, or verify tolls', async () => {
    const { cookies } = await seedSession(db, 'dispatcher')
    const config = await app.inject({
      method: 'PUT',
      url: '/api/config',
      cookies,
      payload: { fuelPriceEurPerLitre: 1.5, fuelConsumptionLPer100Km: 28, driverDayRateEur: 160, monthlyOverheadEur: 3012 },
    })
    expect(config.statusCode).toBe(403)

    const variant = await app.inject({
      method: 'POST',
      url: '/api/fleet-variants',
      cookies,
      payload: { name: 'x', monthlyCostEur: 1 },
    })
    expect(variant.statusCode).toBe(403)

    await new RouteRepository(db).create({
      routeCode: 'WAW-PRG',
      totalKm: 680,
      kmSource: 'here',
      createdBy: 'test',
      countryKm: { PL: 420 },
      tolls: [{ country: 'PL', tollEur: 100, status: 'estimate' }],
    })
    const verify = await app.inject({ method: 'POST', url: '/api/routes/WAW-PRG/tolls/PL/verify', cookies, payload: {} })
    expect(verify.statusCode).toBe(403)
    const manual = await app.inject({ method: 'PUT', url: '/api/routes/WAW-PRG/tolls/PL', cookies, payload: { tollEur: 5 } })
    expect(manual.statusCode).toBe(403)
  })

  it('finance can edit config but not manage users', async () => {
    const { cookies } = await seedSession(db, 'finance')
    const config = await app.inject({
      method: 'PUT',
      url: '/api/config',
      cookies,
      payload: { fuelPriceEurPerLitre: 1.5, fuelConsumptionLPer100Km: 28, driverDayRateEur: 160, monthlyOverheadEur: 3012 },
    })
    expect(config.statusCode).toBe(200)

    const users = await app.inject({ method: 'GET', url: '/api/users', cookies })
    expect(users.statusCode).toBe(403)
  })
})

describe('admin user management', () => {
  it('admin creates accounts; duplicate email conflicts', async () => {
    const { cookies } = await seedSession(db, 'admin')
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      cookies,
      payload: { email: 'nowy@firma.pl', displayName: 'Nowy', role: 'dispatcher', password: 'password123' },
    })
    expect(created.statusCode).toBe(201)

    const dup = await app.inject({
      method: 'POST',
      url: '/api/users',
      cookies,
      payload: { email: 'nowy@firma.pl', displayName: 'Nowy', role: 'dispatcher', password: 'password123' },
    })
    expect(dup.statusCode).toBe(409)

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nowy@firma.pl', password: 'password123' },
    })
    expect(login.statusCode).toBe(200)
  })

  it('deactivating a user kills their sessions', async () => {
    const admin = await seedSession(db, 'admin')
    const target = await seedSession(db, 'dispatcher')
    const row = await new UserRepository(db).findByEmail(target.email)

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/users/${row!.id}`,
      cookies: admin.cookies,
      payload: { active: false },
    })
    expect(patched.statusCode).toBe(200)

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: target.cookies })
    expect(me.statusCode).toBe(401)
  })

  it('refuses to deactivate or demote the last admin', async () => {
    const admin = await seedSession(db, 'admin')
    const row = await new UserRepository(db).findByEmail(admin.email)

    const deactivate = await app.inject({
      method: 'PATCH',
      url: `/api/users/${row!.id}`,
      cookies: admin.cookies,
      payload: { active: false },
    })
    expect(deactivate.statusCode).toBe(400)
    expect((deactivate.json() as { error: { code: string } }).error.code).toBe('LAST_ADMIN')

    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/users/${row!.id}`,
      cookies: admin.cookies,
      payload: { role: 'finance' },
    })
    expect(demote.statusCode).toBe(400)
  })
})
