import { describe, expect, it } from 'vitest'
import { displayAt, loadHour, parseAtInput, parseHoursWindow, unloadHour } from './times.js'
import { matchDrafts } from './drafts.js'

describe('hour windows from the export', () => {
  it.each([
    ['17:00 — 17:00', '17:00', '17:00'],
    ['07:00 — 09:00', '07:00', '09:00'],
    ['— — 14:30', null, '14:30'],
    ['18:00 — —', '18:00', null],
    ['— — —', null, null],
    ['', null, null],
    ['7:05-9:30', '07:05', '09:30'],
    ['8:00', '08:00', '08:00'],
  ])('%s', (raw, from, to) => {
    expect(parseHoursWindow(raw)).toEqual({ from, to })
  })

  it('loading takes the start of the window, unloading its end; a single hour is used as it is', () => {
    expect(loadHour(parseHoursWindow('07:00 — 09:00'))).toBe('07:00')
    expect(unloadHour(parseHoursWindow('08:00 — 21:30'))).toBe('21:30')
    expect(loadHour(parseHoursWindow('— — 14:30'))).toBe('14:30')
    expect(unloadHour(parseHoursWindow('23:00 — —'))).toBe('23:00')
  })
})

describe('manual loading/unloading entries', () => {
  const current = { date: '2026-10-07', time: '16:00' }
  it.each([
    ['07.10 12:00', '2026-10-07', '12:00'],
    ['6.10 9:30', '2026-10-06', '09:30'],
    ['12:00', '2026-10-07', '12:00'],
    ['06.10', '2026-10-06', '16:00'],
    ['2026-10-05 08:00', '2026-10-05', '08:00'],
    ['05.10.2026 08:00', '2026-10-05', '08:00'],
  ])('%s', (input, date, time) => {
    expect(parseAtInput(input, current)).toEqual({ date, time })
  })

  it.each(['jutro', '25:00', '31.02 10:00', '07.10 12:00 rano', ''])('refuses "%s"', input => {
    expect(parseAtInput(input, current)).toBeNull()
  })

  it('a date typed without a year takes the year closest to the order', () => {
    expect(parseAtInput('02.01 10:00', { date: '2026-12-30', time: null })).toEqual({ date: '2027-01-02', time: '10:00' })
  })

  it('shows a stored value the Polish way', () => {
    expect(displayAt('2026-10-07 12:00')).toBe('07.10 12:00')
    expect(displayAt('2026-10-07')).toBe('07.10')
  })
})

describe('preliminary orders ↔ new orders', () => {
  const order = (orderNo: string, truckIds: number[], loadDate: string, firstPlace: string | null = null) => ({ orderNo, truckIds, loadDate, firstPlace })
  const draft = (orderNo: string, truckId: number, loadDate: string, firstPlace: string | null = null) => ({ orderNo, truckId, loadDate, firstPlace })

  it('one order on the same truck within a day replaces the draft', () => {
    expect(matchDrafts([order('79-1', [1], '2026-10-13')], [draft('W-1', 1, '2026-10-12')])).toEqual({
      auto: [{ draftNo: 'W-1', orderNo: '79-1' }],
      ambiguous: [],
    })
  })

  it('another truck or two days apart is not a match', () => {
    expect(matchDrafts([order('79-1', [2], '2026-10-12'), order('79-2', [1], '2026-10-14')], [draft('W-1', 1, '2026-10-12')])).toEqual({ auto: [], ambiguous: [] })
  })

  it('a PRZ order matches on either of its trucks', () => {
    expect(matchDrafts([order('79-1', [1, 2], '2026-10-12')], [draft('W-1', 2, '2026-10-12')]).auto).toHaveLength(1)
  })

  it('the same loading place breaks a tie; otherwise the user decides', () => {
    const orders = [order('79-1', [1], '2026-10-12', 'WAW'), order('79-2', [1], '2026-10-12', 'VIE')]
    expect(matchDrafts(orders, [draft('W-1', 1, '2026-10-12', 'VIE')]).auto).toEqual([{ draftNo: 'W-1', orderNo: '79-2' }])
    expect(matchDrafts(orders, [draft('W-1', 1, '2026-10-12', 'GDN')]).ambiguous).toEqual([{ draftNo: 'W-1', candidates: ['79-1', '79-2'] }])
  })

  it('two drafts competing for one order are asked about, never both replaced', () => {
    const result = matchDrafts([order('79-1', [1], '2026-10-12')], [draft('W-1', 1, '2026-10-12'), draft('W-2', 1, '2026-10-13')])
    expect(result.auto).toEqual([])
    expect(result.ambiguous.map(a => a.draftNo)).toEqual(['W-1', 'W-2'])
  })
})
