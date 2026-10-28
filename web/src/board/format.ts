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

/** Two values "ours / carrier's" in one cell (12.10.2026). */
export function pair(a: string, b: string): string {
  return `${a} / ${b}`
}

/** Polish plural: 1 zlecenie, 2–4 (22–24…) zlecenia, 0 and 5+ (12–14) zleceń. */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n)
  if (abs === 1) return one
  const d = abs % 10
  const dd = abs % 100
  return d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14) ? few : many
}

export function ordersLabel(n: number): string {
  return `${n} ${plural(n, 'zlecenie', 'zlecenia', 'zleceń')}`
}

/** "27 zleceń (w tym 2 wstępne)" — the second part only when there are preliminary orders. */
export function ordersWithDrafts(n: number, drafts: number): string {
  return drafts > 0 ? `${ordersLabel(n)} (w tym ${drafts} ${plural(drafts, 'wstępne', 'wstępne', 'wstępnych')})` : ordersLabel(n)
}

/** "07.10 16:00" (no hour → "07.10"). */
export function dmTime(iso: string, time: string | null | undefined): string {
  return `${dm(iso)}${time ? ` ${time}` : ''}`
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
  km_total: 'Km razem',
  'km_total:1': 'Km razem — 2. odcinek',
  // Older km corrections (before 26.10.2026): still shown and removable, no longer offered.
  km_loaded: 'Km z ładunkiem',
  km_empty: 'Km puste',
  'km_loaded:1': 'Km z ładunkiem — 2. odcinek',
  'km_empty:1': 'Km puste — 2. odcinek',
  driver: 'Kierowca',
  'driver:1': 'Kierowca — 2. odcinek',
  load_at: 'Załadunek (data i godzina)',
  unload_at: 'Rozładunek (data i godzina)',
  coload: 'Doładunek do zlecenia',
}

/** "Km razem" of a leg: km_total (leg 0) or km_total:1 (leg 1). */
export function kmTotalField(legIndex: number): string {
  return legIndex === 0 ? 'km_total' : `km_total:${legIndex}`
}

type LegKindRef = { index: number; kind: 'fleet' | 'own' | 'other' }

/** Label of a correction; "Km razem" names the leg only when two legs are the department's trucks. */
export function overrideLabel(field: string, legs: LegKindRef[]): string {
  if (field.startsWith('km_total')) {
    const fleet = legs.filter(l => l.kind === 'fleet')
    if (fleet.length > 1) return `Km razem — ${field === 'km_total' ? 1 : Number(field.split(':')[1] ?? 0) + 1}. odcinek`
    return 'Km razem'
  }
  return OVERRIDE_LABELS[field] ?? field
}

/**
 * Fields offered in "Popraw ręcznie". Kilometres (26.10.2026): one "Km razem" — all km of
 * the truck on the order — for the department's leg; a second one only when both legs of a
 * relay are the department's trucks.
 */
export function fixOptions(legs: LegKindRef[]): Array<{ field: string; label: string }> {
  const opt = (field: string) => ({ field, label: overrideLabel(field, legs) })
  const km = legs.filter(l => l.kind === 'fleet').map(l => opt(kmTotalField(l.index)))
  return [
    ...['rev', 'cost', 'extra_cost', 'trailer', 'prz', 'exclude'].map(opt),
    ...km,
    opt('driver'),
    ...(legs.length > 1 ? [opt('driver:1')] : []),
    opt('load_at'),
    opt('unload_at'),
    opt('coload'),
  ]
}

/** "2026-10-20" → "20.10.2026" */
export function dmy(iso: string | null | undefined): string {
  return iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : ''
}

/** Scan URLs (behind the session cookie). */
export function certFileUrl(id: number, download = false): string {
  return `/api/board/cert-files/${id}${download ? '?download=1' : ''}`
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}
