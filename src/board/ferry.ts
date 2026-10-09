/**
 * Ferry costs typed into the client order's notes in the company application
 * (the same field as PRZ entries). The application's export has no column for
 * them, yet the department pays the ferry, so it lowers the order's margin:
 *
 *   PROM <amount in EUR> [anything after it]
 *   e.g. PROM 1180   ·   PROM 1180,50 Finnlines HEL-TRA   ·   PROM: 95 €
 *
 * Several PROM entries in one order add up. Amounts are EUR, never converted;
 * the decimal separator is a comma (a dot followed by digits reads as a date,
 * "PROM 10.10", and is reported, like a time "PROM 18:00"). An entry without a
 * readable amount is reported — never silently ignored. Text after the amount
 * up to ";" / a line break / the next PRZ or PROM marker is a free description.
 */

export interface FerryEntry {
  amount: number
  raw: string
}

export interface FerryParseResult {
  entries: FerryEntry[]
  /** Raw text of PROM segments that could not be read. */
  errors: string[]
  /** Sum of the entries, rounded to cents. */
  total: number
}

/** Any marker that ends a PROM (or PRZ) segment. */
export const NOTE_MARKERS = /\b(?:PRZ(?:EPINKA)?|PROMY?)\b/gi
const FERRY_MARKER = /\bPROMY?\b/gi
const ENTRY = /^PROMY?\s*[:=]?\s*(\d+(?:,\d{1,2})?)(?![\d.:,])\s*(?:€|EUR\b)?(?:\s+.*)?$/i

export function parseFerries(notes: string | null | undefined): FerryParseResult {
  const text = (notes ?? '').replace(/_x000D_/g, '').replace(/\r/g, '')
  const result: FerryParseResult = { entries: [], errors: [], total: 0 }
  const markers = [...text.matchAll(NOTE_MARKERS)].map(m => m.index)
  for (const m of text.matchAll(FERRY_MARKER)) {
    const start = m.index
    const next = markers.find(i => i > start) ?? text.length
    let segment = text.slice(start, next)
    const cut = segment.search(/[;\n]/)
    if (cut >= 0) segment = segment.slice(0, cut)
    segment = segment.trim().replace(/[.,]+$/, '').trim()
    const e = ENTRY.exec(segment)
    const amount = e ? Number(e[1]!.replace(',', '.')) : NaN
    if (!e || !(amount > 0)) {
      result.errors.push(segment)
      continue
    }
    result.entries.push({ amount, raw: segment })
  }
  result.total = Math.round(result.entries.reduce((s, x) => s + x.amount, 0) * 100) / 100
  return result
}
