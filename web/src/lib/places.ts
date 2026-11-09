import type { PlaceDto } from './types.js'

/**
 * Route stops in the calculator (09.11.2026): airports and places from the
 * board's dictionary, found by code, name or any known spelling. Folding
 * mirrors the board's aliasKey (src/board/normalize.ts) so "KRAKÓW",
 * "Krakow" and "krakow" are one key.
 */

const EXTRA_FOLD: Record<string, string> = { ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', ß: 'ss', đ: 'd', Đ: 'D', æ: 'ae', Æ: 'AE' }

export function foldKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[łŁøØßđĐæÆ]/g, ch => EXTRA_FOLD[ch] ?? ch)
    .toLowerCase()
    .replace(/[_\-–—,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Places matching what was typed, best first: code, then name, spellings, airport name. */
export function searchPlaces(query: string, places: readonly PlaceDto[], limit = 6): PlaceDto[] {
  const q = foldKey(query)
  if (!q) return []
  const scored: Array<{ place: PlaceDto; score: number }> = []
  for (const place of places) {
    const code = place.code.toLowerCase()
    const name = foldKey(place.name)
    const detail = foldKey(place.detail)
    let score: number | null = null
    if (code === q) score = 0
    else if (code.startsWith(q)) score = 1
    else if (name.startsWith(q)) score = 2
    else if (place.aliases.some(a => a.startsWith(q))) score = 3
    else if (q.length >= 3 && (detail.startsWith(q) || name.includes(q))) score = 4
    if (score !== null) scored.push({ place, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.place.code.length - b.place.code.length || a.place.code.localeCompare(b.place.code))
    .slice(0, limit)
    .map(s => s.place)
}

/** Code for one typed stop: a known code as is, else a name/spelling that points to exactly one place. */
export function resolveStop(raw: string, places: readonly PlaceDto[]): string | null {
  const upper = raw.trim().toUpperCase()
  if (!upper) return null
  if (places.some(p => p.code === upper)) return upper
  const key = foldKey(raw)
  const hits = new Set(places.filter(p => foldKey(p.name) === key || p.aliases.includes(key)).map(p => p.code))
  return hits.size === 1 ? [...hits][0]! : null
}

/**
 * "WAW-Kowno-TCZEW" → "WAW-KUN-TCZE": every stop typed as a name becomes its
 * code; unknown stops stay as typed (upper case) so the panel can offer to
 * add them. Empty segments ("WAW--PRG", a trailing hyphen) are dropped.
 */
export function normalizeRouteInput(input: string, places: readonly PlaceDto[]): string {
  return input
    .split('-')
    .map(part => part.trim())
    .filter(part => part !== '')
    .map(part => resolveStop(part, places) ?? part.toUpperCase())
    .join('-')
}

/** Stops of a route code that are neither airports nor dictionary places. */
export function unknownStops(routeCode: string, places: readonly PlaceDto[]): string[] {
  const codes = new Set(places.map(p => p.code))
  return [...new Set(routeCode.split('-').filter(stop => stop !== '' && !codes.has(stop)))]
}

/** "NOWA WIEŚ" → "Nowa Wieś" — a starting name for a place typed in capitals. */
export function titleCase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/(^|[\s(])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
}
