/**
 * Normalisation helpers for data coming out of the company application's
 * grid export. The export is typed by hand in many places, so the same truck,
 * trailer or place shows up in several spellings ("KN 7734P", "kn960pe",
 * "Vecsés"/"Vecses", "WARSZAWA"/"Warszawa"). Everything the board matches on
 * goes through these functions first.
 */

/** Characters NFD does not decompose but that should fold to ASCII. */
const EXTRA_FOLD: Record<string, string> = {
  ł: 'l',
  Ł: 'L',
  ø: 'o',
  Ø: 'O',
  ß: 'ss',
  đ: 'd',
  Đ: 'D',
  æ: 'ae',
  Æ: 'AE',
}

/** Removes diacritics: "Łódź" → "Lodz", "Vecsés" → "Vecses", "Schönefeld" → "Schonefeld". */
export function foldDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[łŁøØßđĐæÆ]/g, ch => EXTRA_FOLD[ch] ?? ch)
}

/**
 * Plate key: upper case, no spaces or punctuation. A "truck / trailer" pair
 * typed into one cell ("KNS8796U / ") keeps only the first part.
 */
export function normalizePlate(raw: unknown): string {
  const text = cellText(raw)
  if (!text) return ''
  const first = text.split('/')[0] ?? ''
  return foldDiacritics(first).toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Alias key for places and trailers: folded, lower case, single spaces,
 * hyphens treated as spaces ("Wien-Flughafen" = "Wien Flughafen").
 */
export function aliasKey(raw: unknown): string {
  return foldDiacritics(cellText(raw))
    .toLowerCase()
    .replace(/[_\-–—,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "Warszawa + WARSZAWA + Wrocław" → ["Warszawa", "WARSZAWA", "Wrocław"]. */
export function splitPlaces(raw: unknown): string[] {
  return cellText(raw)
    .split('+')
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/**
 * Plain text of a spreadsheet cell value. Handles exceljs shapes (rich text,
 * formula results, hyperlinks) and the "_x000D_" carriage-return artefact
 * the grid export leaves in multi-line notes.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.replace(/_x000D_/g, '').replace(/\r/g, '').trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return toIsoDate(value)
  if (typeof value === 'object') {
    const v = value as { richText?: Array<{ text?: string }>; result?: unknown; text?: unknown }
    if (Array.isArray(v.richText)) return cellText(v.richText.map(part => part.text ?? '').join(''))
    if (v.result !== undefined) return cellText(v.result)
    if (v.text !== undefined) return cellText(v.text)
  }
  return String(value).trim()
}

/** Amount in EUR from a cell: number, "1280,50", "1 280.50" → number; empty → null. */
export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = cellText(value).replace(/\s/g, '').replace(',', '.')
  if (!text) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/** Date cell → "YYYY-MM-DD". Accepts Date, ISO text, "DD.MM.YYYY" and Excel serials. */
export function parseDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : toIsoDate(value)
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    // Excel serial date (1900 system): day 25569 = 1970-01-01.
    return toIsoDate(new Date(Math.round((value - 25569) * 86400000)))
  }
  const text = cellText(value)
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text)
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  return null
}

/** Date → "YYYY-MM-DD" using UTC fields (dates in this module are calendar days, not instants). */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return toIsoDate(d)
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`)
  const b = Date.parse(`${toIso}T00:00:00Z`)
  return Math.round((b - a) / 86400000)
}

/** Monday of the ISO week containing the date. */
export function weekStart(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  const dow = (d.getUTCDay() + 6) % 7 // Monday = 0
  return addDays(isoDate, -dow)
}

/** ISO week number (1–53). */
export function isoWeekNumber(isoDate: string): number {
  const d = new Date(`${isoDate}T00:00:00Z`)
  const dow = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dow + 3) // Thursday of this week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const fdow = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdow + 3)
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000))
}

/** Levenshtein distance, for "did you mean" suggestions (trailers, places). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr.push(Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost))
    }
    prev = curr
  }
  return prev[b.length]!
}

/** Great-circle distance in km. */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
