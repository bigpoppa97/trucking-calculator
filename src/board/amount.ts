/**
 * Numbers typed by hand into manual corrections (amounts in EUR, kilometres).
 * People write "2350e", "2 350 €", "2350,50", "590 km" — all mean the number.
 * Anything that is not clearly one non-negative number (e.g. "2350 zł", "abc",
 * "350+2000") is rejected rather than silently read as nothing.
 */
const UNIT = /(?:€|eur|euro|e|km)$/i

export function parseNumberInput(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  let s = raw.replace(/[\s  ]/g, '')
  s = s.replace(UNIT, '')
  if (!/^\d+(?:[.,]\d+)?$/.test(s)) return null
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
