import { describe, expect, it } from 'vitest'
import { parseFerries } from './ferry.js'
import { parsePrz } from './prz.js'

describe('parseFerries (PROM <kwota> in the order notes)', () => {
  it('reads the amount among flight numbers, with a description after it', () => {
    const r = parseFerries('LH7411B-2026-10-10 PROM 1180 Finnlines HEL-TRA')
    expect(r).toEqual({ entries: [{ amount: 1180, raw: 'PROM 1180 Finnlines HEL-TRA' }], errors: [], total: 1180 })
  })

  it('accepts lower case, a colon, decimal commas, € / EUR and sums several entries', () => {
    const r = parseFerries('prom: 1180,50 €; PROMY 95EUR\nPROM=20')
    expect(r.errors).toEqual([])
    expect(r.entries.map(e => e.amount)).toEqual([1180.5, 95, 20])
    expect(r.total).toBe(1295.5)
  })

  it('reports entries without a readable amount instead of guessing (dates, times, no number)', () => {
    expect(parseFerries('PROM 10.10').errors).toEqual(['PROM 10.10'])
    expect(parseFerries('PROM 18:00 z Gdyni').errors).toEqual(['PROM 18:00 z Gdyni'])
    expect(parseFerries('PROM HEL-TRA').errors).toEqual(['PROM HEL-TRA'])
    expect(parseFerries('PROM 0').errors).toEqual(['PROM 0'])
    expect(parseFerries('PROM 10.10').total).toBe(0)
  })

  it('ignores words that merely start with PROM and empty notes', () => {
    expect(parseFerries('PROMOCJA 50%')).toEqual({ entries: [], errors: [], total: 0 })
    expect(parseFerries(null)).toEqual({ entries: [], errors: [], total: 0 })
  })

  it('shares the notes with a PRZ entry on the same line — both are read', () => {
    const notes = 'PRZ GORZYCZKI 22.09 WGM4518U>KN1050H 700/400 PROM 150'
    expect(parseFerries(notes)).toMatchObject({ total: 150, errors: [] })
    const prz = parsePrz(notes)
    expect(prz.errors).toEqual([])
    expect(prz.entries[0]).toMatchObject({ place: 'GORZYCZKI', amountFrom: 700, amountTo: 400 })
  })

  it('a PROM entry before the PRZ entry ends at the PRZ marker', () => {
    const notes = 'PROM 1180 PRZ WAW 22.09 KN4814J>KN1050H 1400/900'
    expect(parseFerries(notes)).toMatchObject({ entries: [{ amount: 1180, raw: 'PROM 1180' }], errors: [] })
    expect(parsePrz(notes).entries).toHaveLength(1)
  })
})
