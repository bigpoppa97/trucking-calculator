import { describe, expect, it } from 'vitest'
import { foldKey, normalizeRouteInput, resolveStop, searchPlaces, titleCase, unknownStops } from './places.js'
import type { PlaceDto } from './types.js'

const p = (code: string, name: string, kind: PlaceDto['kind'], aliases: string[] = [], detail = ''): PlaceDto => ({
  code,
  name,
  detail,
  country: 'PL',
  lat: 0,
  lon: 0,
  kind,
  aliases,
})

const PLACES: PlaceDto[] = [
  p('WAW', 'Warszawa', 'airport', ['warszawa', 'warsaw', 'okecie'], 'Warsaw Chopin'),
  p('LCJ', 'Łódź', 'airport', ['lodz'], 'Łódź Władysław Reymont'),
  p('KUN', 'Kowno', 'airport', ['kowno', 'kaunas'], 'Kaunas'),
  p('TCZE', 'Tczew', 'place', ['tczew']),
  p('NWWR', 'Nowa Wieś Wrocławska', 'place', ['nowa wies wroclawska']),
  // Two places sharing a spelling: a name must not pick one at random.
  p('NOWA', 'Nowa Wieś', 'place', ['nowa wies']),
  p('NOWA2', 'Nowa Wieś', 'place', ['nowa wies']),
]

describe('route stops (09.11.2026)', () => {
  it('folds like the board (diacritics, ł, case, separators)', () => {
    expect(foldKey('ŁÓDŹ')).toBe('lodz')
    expect(foldKey('  Nowa_Wieś,  Wrocławska ')).toBe('nowa wies wroclawska')
  })

  it('finds by code, name, spelling and airport name — codes first', () => {
    expect(searchPlaces('W', PLACES).map(x => x.code)[0]).toBe('WAW')
    expect(searchPlaces('łódź', PLACES).map(x => x.code)).toEqual(['LCJ'])
    expect(searchPlaces('KAUNAS', PLACES).map(x => x.code)).toEqual(['KUN'])
    expect(searchPlaces('chopin', PLACES).map(x => x.code)).toEqual([])
    expect(searchPlaces('wrocl', PLACES).map(x => x.code)).toEqual(['NWWR'])
    expect(searchPlaces('', PLACES)).toEqual([])
  })

  it('turns names into codes, leaves unknown and ambiguous stops as typed', () => {
    expect(resolveStop('kowno', PLACES)).toBe('KUN')
    expect(resolveStop('NOWA WIEŚ', PLACES)).toBeNull()
    expect(normalizeRouteInput('waw-Łódź-Tczew', PLACES)).toBe('WAW-LCJ-TCZE')
    expect(normalizeRouteInput('WAW--barwinek-', PLACES)).toBe('WAW-BARWINEK')
    expect(normalizeRouteInput(' - ', PLACES)).toBe('')
  })

  it('lists the stops nobody knows, once each', () => {
    expect(unknownStops('WAW-BARW-TCZE-BARW', PLACES)).toEqual(['BARW'])
    expect(unknownStops('WAW-TCZE', PLACES)).toEqual([])
  })

  it('gives a typed-in-capitals stop a readable starting name', () => {
    expect(titleCase('NOWA WIEŚ')).toBe('Nowa Wieś')
    expect(titleCase('BARWINEK')).toBe('Barwinek')
  })
})
