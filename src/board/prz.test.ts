import { describe, expect, it } from 'vitest'
import { parsePrz, resolveSwapDate } from './prz.js'

describe('parsePrz', () => {
  it('reads the agreed format', () => {
    const r = parsePrz('PRZ GORZYCZKI 26.04 WGM4518U>KN1050H 700/400')
    expect(r.errors).toEqual([])
    expect(r.entries).toEqual([
      {
        place: 'GORZYCZKI',
        day: 26,
        month: 4,
        time: null,
        from: 'WGM4518U',
        to: 'KN1050H',
        amountFrom: 700,
        amountTo: 400,
        raw: 'PRZ GORZYCZKI 26.04 WGM4518U>KN1050H 700/400',
      },
    ])
  })

  it('reads an optional hour of the swap (09.11.2026): 14:00, 14.00, 9:30; an impossible hour is an unreadable entry', () => {
    expect(parsePrz('PRZ GORZYCZKI 26.04 14:00 WGM4518U>KN1050H 700/400').entries[0]).toMatchObject({ day: 26, month: 4, time: '14:00', from: 'WGM4518U', to: 'KN1050H' })
    expect(parsePrz('PRZ WAW 22.09 14.00 KN4814J>KN1050H 1400/900').entries[0]).toMatchObject({ time: '14:00', amountFrom: 1400 })
    expect(parsePrz('prz Nowa Wieś 55-080 3.10 9:30 kn 7179f>KN1585H 812,50/387,50').entries[0]).toMatchObject({ place: 'Nowa Wieś 55-080', time: '09:30', from: 'KN7179F' })
    expect(parsePrz('PRZEPINKA WAW 22.09.2026 06:15 KN4814J>KN1050H 1400/900').entries[0]).toMatchObject({ time: '06:15' })
    expect(parsePrz('PRZ WAW 22.09 KN4814J>KN1050H 1400/900').entries[0]?.time).toBeNull()
    for (const bad of ['PRZ WAW 22.09 25:00 KN4814J>KN1050H 1400/900', 'PRZ WAW 22.09 14:75 KN4814J>KN1050H 1400/900']) {
      const r = parsePrz(bad)
      expect([r.entries, r.errors]).toEqual([[], [bad]])
    }
  })

  it('finds the entry among flight numbers and other notes', () => {
    const r = parsePrz('LH6428B-2026-09-21; PRZ WAW 22.09 KN4814J > KN1050H 1400/900')
    expect(r.errors).toEqual([])
    expect(r.entries[0]).toMatchObject({ place: 'WAW', from: 'KN4814J', to: 'KN1050H', amountFrom: 1400, amountTo: 900 })
  })

  it('tolerates lower case, spaces in plates, decimal commas and multi-word places with postcodes', () => {
    const r = parsePrz('prz Nowa Wieś 55-080 3.10 kn 7179f>KN1585H 812,50/387,50')
    expect(r.errors).toEqual([])
    expect(r.entries[0]).toMatchObject({
      place: 'Nowa Wieś 55-080',
      day: 3,
      month: 10,
      from: 'KN7179F',
      to: 'KN1585H',
      amountFrom: 812.5,
      amountTo: 387.5,
    })
  })

  it('accepts the long marker and a year', () => {
    const r = parsePrz('Przepinka WRO 06.10.2026 KN1050H>KN5692K 450/400')
    expect(r.entries[0]).toMatchObject({ place: 'WRO', day: 6, month: 10, amountFrom: 450, amountTo: 400 })
  })

  it('reports a malformed entry instead of ignoring it', () => {
    const r = parsePrz('226R PRZ GORZYCZKI 26.04 WGM4518U KN1050H 700/400')
    expect(r.entries).toEqual([])
    expect(r.errors).toEqual(['PRZ GORZYCZKI 26.04 WGM4518U KN1050H 700/400'])
  })

  it('reads several entries separated by semicolons', () => {
    const r = parsePrz('PRZ WAW 22.09 KN4814J>KN1050H 1400/900; PRZ VNO 23.09 KN1050H>KN6635G 500/400')
    expect(r.entries).toHaveLength(2)
  })

  it('ignores notes without a marker (flight numbers, ULDs)', () => {
    for (const notes of ['LH7459S-2026-09-23', '641R, 631R', '', null, 'PRZESYŁKA PILNA']) {
      expect(parsePrz(notes)).toEqual({ entries: [], errors: [] })
    }
  })

  it('cleans the export carriage-return artefact', () => {
    const r = parsePrz('336R_x000D_\nPRZ BER 24.09 KN7734P>WGM4518U 1770/813')
    expect(r.entries).toHaveLength(1)
  })
})

describe('resolveSwapDate', () => {
  it('uses the order year', () => {
    expect(resolveSwapDate(22, 9, '2026-09-21')).toBe('2026-09-22')
  })
  it('crosses New Year in both directions', () => {
    expect(resolveSwapDate(2, 1, '2026-12-30')).toBe('2027-01-02')
    expect(resolveSwapDate(30, 12, '2027-01-02')).toBe('2026-12-30')
  })
})
