/** Formatting for the board (Polish conventions, amounts always EUR). */

const group = (n: number) => String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export function eur(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${n < 0 ? '−' : ''}${group(n)} €`
}

export function signedEur(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${n < 0 ? '−' : '+'}${group(n)} €`
}

export function km(n: number | null | undefined, estimated = false): string {
  if (n === null || n === undefined) return '— km'
  return `${estimated ? '≈' : ''}${group(n)} km`
}

export function pct(part: number, whole: number): string {
  if (!whole) return '—'
  return `${(Math.round((part / whole) * 1000) / 10).toFixed(1).replace('.', ',')}%`
}

export function perKm(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${n.toFixed(2).replace('.', ',')} €`
}

export const DAY_NAMES = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd']

export const MONTHS_GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia']

/** "2026-09-21" → "21.09" */
export function dm(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`
}

export function stamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function weekRangeLabel(start: string, end: string): string {
  const sd = Number(start.slice(8, 10))
  const ed = Number(end.slice(8, 10))
  const sm = Number(start.slice(5, 7)) - 1
  const em = Number(end.slice(5, 7)) - 1
  const year = end.slice(0, 4)
  return sm === em ? `${sd}–${ed} ${MONTHS_GEN[sm]} ${year}` : `${sd} ${MONTHS_GEN[sm]} – ${ed} ${MONTHS_GEN[em]} ${year}`
}

export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const EVENT_LABELS: Record<string, string> = {
  note: 'Notatka',
  pause: 'Pauza',
  service: 'Serwis',
  driver: 'Zmiana kierowcy',
  trailer: 'Naczepa',
  position: 'Pozycja auta',
}

export const OVERRIDE_LABELS: Record<string, string> = {
  rev: 'Stawka klienta (€)',
  cost: 'Koszt przewoźnika (€)',
  extra_cost: 'Koszt dodatkowy (€)',
  trailer: 'Naczepa',
  prz: 'Wpis przepinki (PRZ)',
  exclude: 'Wyłącz z wyników (1 = tak)',
  km_loaded: 'Km z ładunkiem',
  km_empty: 'Km puste',
  'km_loaded:1': 'Km z ładunkiem — 2. odcinek',
  'km_empty:1': 'Km puste — 2. odcinek',
}
