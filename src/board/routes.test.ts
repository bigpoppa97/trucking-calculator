import ExcelJS from 'exceljs'
import type { FastifyInstance, InjectOptions } from 'fastify'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, migrateToLatest } from '../db/database.js'
import type { DB } from '../db/schema.js'
import type { RouteFetchService } from '../here/routeFetchService.js'
import { buildApp } from '../server/app.js'
import { seedSession } from '../server/testAuth.js'
import { ensurePlaceSeed } from './placeSeed.js'

/** HTTP-level smoke test of the board endpoints (import → week → order → note → issue). */

let db: Kysely<DB>
let app: FastifyInstance
let cookies: { session: string }
const call = (options: InjectOptions) => app.inject({ ...options, cookies })

beforeEach(async () => {
  db = createTestDatabase()
  await migrateToLatest(db)
  await ensurePlaceSeed(db)
  app = buildApp({ db, fetchService: {} as RouteFetchService })
  cookies = (await seedSession(db, 'dispatcher')).cookies
})

afterEach(async () => {
  await app.close()
  await db.destroy()
})

async function exportFile(): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('ag-grid')
  ws.addRow(['Numer zlecenia', 'Zleceniodawca', 'Miejsce załadunku', 'Data załadunku', 'Miejsce dostawy', 'Data rozładunku', 'Zleceniobiorca', 'Fracht zakup', 'Fracht sprzedaż', 'Uwagi', 'Ciągnik podwykonawcy', 'Naczepa podwykonawcy'])
  ws.addRow(['79-1-26', 'Klient', 'Warszawa', '2026-09-21', 'Vecsés', '2026-09-22', 'Alfa', 1450, 1250, '224R', 'AA1001A', 'TRX1'])
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64')
}

describe('board API', () => {
  it('runs the daily flow', async () => {
    let res = await call({ method: 'POST', url: '/api/board/fleet', payload: { plate: 'AA 1001A', validFrom: '2026-01-01', carrier: 'Alfa' } })
    expect(res.statusCode).toBe(200)

    res = await call({ method: 'POST', url: '/api/board/import', payload: { filename: 'e.xlsx', mode: 'daily', dataBase64: await exportFile() } })
    expect(res.statusCode).toBe(200)
    expect(res.json().summary.created).toEqual(['79-1-26'])

    res = await call({ method: 'GET', url: '/api/board/week?date=2026-09-23' })
    const week = res.json()
    expect(week.weekNumber).toBe(39)
    expect(week.trucks[0].bars[0]).toMatchObject({ orderNo: '79-1-26', title: 'Warszawa → Budapeszt (Vecsés)', margin: 200 })

    res = await call({ method: 'POST', url: '/api/board/orders/79-1-26/notes', payload: { text: 'Awizacja' } })
    expect(res.statusCode).toBe(200)
    res = await call({ method: 'GET', url: '/api/board/orders/79-1-26' })
    expect(res.json().notes[0]).toMatchObject({ text: 'Awizacja', createdBy: 'Test dispatcher' })

    res = await call({ method: 'GET', url: '/api/board/issues' })
    const issue = res.json().issues.find((i: { kind: string }) => i.kind === 'UNKNOWN_TRAILER')
    expect(issue.ref).toBe('TRX1')
    res = await call({ method: 'POST', url: `/api/board/issues/${issue.id}/resolve`, payload: { action: 'new', payload: {} } })
    expect(res.statusCode).toBe(200)
    res = await call({ method: 'GET', url: '/api/board/issues' })
    expect(res.json().issues.filter((i: { kind: string }) => i.kind === 'UNKNOWN_TRAILER')).toEqual([])
  })

  it('rejects a file without required columns with a clear message', async () => {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('x').addRow(['Numer zlecenia', 'Zleceniodawca'])
    const dataBase64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64')
    const res = await call({ method: 'POST', url: '/api/board/import', payload: { filename: 'x.xlsx', mode: 'daily', dataBase64 } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/Fracht zakup/)
  })

  it('returns a Polish 404 for an unknown order', async () => {
    const res = await call({ method: 'GET', url: '/api/board/orders/1-2-3' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.message).toMatch(/Nie ma takiego zlecenia/)
  })

  it('requires a signed-in user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/board/week?date=2026-09-23' })
    expect(res.statusCode).toBe(401)
  })
})
