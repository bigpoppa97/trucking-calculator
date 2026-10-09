import { NOTE_MARKERS } from './ferry.js'
import { normalizePlate } from './normalize.js'

/**
 * Trailer swap ("przepinka") entries typed into the client order's notes in
 * the company application:
 *
 *   PRZ <place> <dd.mm> <truck handing over>><truck taking over> <amount A>/<amount B>
 *   e.g. PRZ GORZYCZKI 26.04 WGM4518U>KN1050H 700/400
 *
 * Amounts are what each truck gets for its leg (a subcontractor's rate, or —
 * for an own-fleet truck — what the own fleet keeps). The order's margin is
 * the client rate minus the sum of the amounts.
 *
 * The notes field also carries flight numbers and ULD references
 * ("LH7459S-2026-09-23", "772R"), so only text starting at a PRZ marker is
 * read, up to the next ";", line break or PRZ/PROM marker (ferry costs, see
 * ferry.ts, share the field). A marker that does not match the format is
 * reported as an error — never silently ignored.
 */

export interface PrzEntry {
  /** Place exactly as typed (airport code or town, possibly with postcode). */
  place: string
  day: number
  month: number
  /** Normalised plates. */
  from: string
  to: string
  amountFrom: number
  amountTo: number
  raw: string
}

export interface PrzParseResult {
  entries: PrzEntry[]
  /** Raw text of PRZ segments that could not be read. */
  errors: string[]
}

const MARKER = /\bPRZ(?:EPINKA)?\b/gi
const NUM = String.raw`\d+(?:[.,]\d+)?`
const ENTRY = new RegExp(
  String.raw`^PRZ(?:EPINKA)?:?\s+(.+?)\s+(\d{1,2})\.(\d{1,2})(?:\.(?:\d{4}|\d{2}))?\.?\s+([A-Z0-9 ]+?)\s*>\s*([A-Z0-9 ]+?)\s+(${NUM})\s*\/\s*(${NUM})\s*$`,
  'i',
)

export function parsePrz(notes: string | null | undefined): PrzParseResult {
  const text = (notes ?? '').replace(/_x000D_/g, '').replace(/\r/g, '')
  const result: PrzParseResult = { entries: [], errors: [] }
  const starts: number[] = []
  for (const m of text.matchAll(MARKER)) starts.push(m.index)
  const markers = [...text.matchAll(NOTE_MARKERS)].map(m => m.index)
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!
    const nextMarker = markers.find(at => at > start) ?? text.length
    let segment = text.slice(start, nextMarker)
    const cut = segment.search(/[;\n]/)
    if (cut >= 0) segment = segment.slice(0, cut)
    segment = segment.trim().replace(/[.,]+$/, '').trim()
    const m = ENTRY.exec(segment)
    if (!m) {
      result.errors.push(segment)
      continue
    }
    const day = Number(m[2])
    const month = Number(m[3])
    const from = normalizePlate(m[4])
    const to = normalizePlate(m[5])
    if (day < 1 || day > 31 || month < 1 || month > 12 || !from || !to || from === to) {
      result.errors.push(segment)
      continue
    }
    result.entries.push({
      place: m[1]!.trim(),
      day,
      month,
      from,
      to,
      amountFrom: Number(m[6]!.replace(',', '.')),
      amountTo: Number(m[7]!.replace(',', '.')),
      raw: segment,
    })
  }
  return result
}

/**
 * The entry has no year: pick the year that puts the swap closest to the
 * order's loading date (handles orders crossing New Year).
 */
export function resolveSwapDate(day: number, month: number, referenceIso: string): string {
  const refYear = Number(referenceIso.slice(0, 4))
  const ref = Date.parse(`${referenceIso}T00:00:00Z`)
  let best = ''
  let bestDiff = Infinity
  for (const year of [refYear - 1, refYear, refYear + 1]) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const diff = Math.abs(Date.parse(`${iso}T00:00:00Z`) - ref)
    if (diff < bestDiff) {
      bestDiff = diff
      best = iso
    }
  }
  return best
}
