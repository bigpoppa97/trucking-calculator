import { NOTE_MARKERS } from './ferry.js'
import { isOneSlip, normalizePlate } from './normalize.js'

/**
 * Trailer swap ("przepinka") entries typed into the client order's notes in
 * the company application:
 *
 *   PRZ <place> <dd.mm> [<hh:mm>] <truck handing over>><truck taking over> <amount A>/<amount B>
 *   e.g. PRZ GORZYCZKI 26.04 WGM4518U>KN1050H 700/400
 *        PRZ GORZYCZKI 26.04 14:00 WGM4518U>KN1050H 700/400   (09.11.2026: optional hour, also 14.00)
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
  /** Hour of the swap ("HH:MM", 09.11.2026), null = not given (the whole day). */
  time: string | null
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
  String.raw`^PRZ(?:EPINKA)?:?\s+(.+?)\s+(\d{1,2})\.(\d{1,2})(?:\.(?:\d{4}|\d{2}))?\.?(?:\s+(\d{1,2})[:.](\d{2}))?\s+([A-Z0-9 ]+?)\s*>\s*([A-Z0-9 ]+?)\s+(${NUM})\s*\/\s*(${NUM})\s*$`,
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
    const hour = m[4] === undefined ? null : Number(m[4])
    const minute = m[5] === undefined ? null : Number(m[5])
    const from = normalizePlate(m[6])
    const to = normalizePlate(m[7])
    const badTime = hour !== null && (hour > 23 || minute === null || minute > 59)
    if (day < 1 || day > 31 || month < 1 || month > 12 || badTime || !from || !to || from === to) {
      result.errors.push(segment)
      continue
    }
    result.entries.push({
      place: m[1]!.trim(),
      day,
      month,
      time: hour === null ? null : `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      from,
      to,
      amountFrom: Number(m[8]!.replace(',', '.')),
      amountTo: Number(m[9]!.replace(',', '.')),
      raw: segment,
    })
  }
  return result
}

/**
 * Known plates (fleet + own fleet) one keyboard slip away from a plate in a PRZ entry —
 * "Czy chodziło o KN4814J?". At most three, sorted.
 */
export function similarPlates(plate: string, known: Iterable<string>): string[] {
  const p = normalizePlate(plate)
  return [...new Set(known)].filter(k => isOneSlip(p, k)).sort().slice(0, 3)
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
