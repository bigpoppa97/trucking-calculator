/**
 * Money helpers. All money is EUR with 2-decimal display (PRD §5.4).
 */

/** Round to 2 decimals, half-up, tolerant of binary float noise (e.g. 266.56000000000003). */
export function roundEur(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * Parse a user-entered number accepting comma as decimal separator
 * (users are Polish — PRD §5.4). Accepts:
 *   "28,5"  "28.5"  "1 234,56"  "1234.56"  "1.234,56"  "1,234.56"
 * Spaces (incl. non-breaking) are treated as thousands separators.
 * When both '.' and ',' appear, the RIGHTMOST one is the decimal separator.
 * Returns null for anything that does not parse to a finite number.
 */
export function parseDecimalInput(raw: string): number | null {
  const s = raw.trim().replace(/[\s  ]/g, '')
  if (s === '') return null

  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')

  let normalized: string
  if (lastComma !== -1 && lastDot !== -1) {
    // Rightmost separator is decimal; the other kind is thousands grouping.
    if (lastComma > lastDot) {
      normalized = s.replace(/\./g, '').replace(',', '.')
    } else {
      normalized = s.replace(/,/g, '')
    }
  } else if (lastComma !== -1) {
    // Comma only — reject multiple commas ("1,2,3" is ambiguous, not a number).
    if (s.indexOf(',') !== lastComma) return null
    normalized = s.replace(',', '.')
  } else {
    // Dot only or plain digits — reject multiple dots.
    if (lastDot !== -1 && s.indexOf('.') !== lastDot) return null
    normalized = s
  }

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}
