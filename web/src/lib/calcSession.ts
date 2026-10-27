import type { DriverCount } from '@domain'
import type { FetchedRouteDto } from './types.js'

/**
 * Calculator state kept for the browser tab (27.10.2026): the route and the
 * order parameters survive switching to Tablica / Baza tras / Konfiguracja
 * and a page reload, and are gone when the tab is closed (sessionStorage) or
 * replaced by the next lookup.
 *
 * - A route from the database is stored by CODE and read again from the
 *   database on return (no HERE request; picks up e.g. recalculated tolls).
 * - A route fetched from HERE and not saved yet is stored whole — returning
 *   to it must not cost a second HERE request. Once saved it is stored by code.
 *
 * Every access is wrapped: private windows / blocked storage just mean the
 * calculator starts empty, as before.
 */

export interface CalcSessionForm {
  days: string
  drivers: DriverCount
  fleetVariantId: number | null
  ferries: string
  tunnels: string
  revenue: string
}

export type CalcSessionRoute =
  | { kind: 'db'; routeCode: string }
  | { kind: 'notFound'; routeCode: string }
  | { kind: 'fetched'; fetched: FetchedRouteDto }

export interface CalcSession {
  route: CalcSessionRoute | null
  form: CalcSessionForm | null
}

const KEY = 'kalkulator.sesja.v1'
const SCREEN_KEY = 'tablica.ekran.v1'

const isString = (v: unknown): v is string => typeof v === 'string'

function parseForm(raw: unknown): CalcSessionForm | null {
  if (typeof raw !== 'object' || raw === null) return null
  const f = raw as Record<string, unknown>
  if (!isString(f['days']) || !isString(f['ferries']) || !isString(f['tunnels']) || !isString(f['revenue'])) return null
  return {
    days: f['days'],
    drivers: f['drivers'] === 2 ? 2 : 1,
    fleetVariantId: typeof f['fleetVariantId'] === 'number' ? f['fleetVariantId'] : null,
    ferries: f['ferries'],
    tunnels: f['tunnels'],
    revenue: f['revenue'],
  }
}

function parseRoute(raw: unknown): CalcSessionRoute | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if ((r['kind'] === 'db' || r['kind'] === 'notFound') && isString(r['routeCode']) && r['routeCode'] !== '') {
    return { kind: r['kind'], routeCode: r['routeCode'] }
  }
  if (r['kind'] === 'fetched' && typeof r['fetched'] === 'object' && r['fetched'] !== null) {
    const fetched = r['fetched'] as FetchedRouteDto
    if (isString(fetched.routeCode) && typeof fetched.totalKm === 'number' && typeof fetched.countryKm === 'object') {
      return { kind: 'fetched', fetched }
    }
  }
  return null
}

export function loadCalcSession(): CalcSession {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw === null) return { route: null, form: null }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return { route: parseRoute(parsed['route']), form: parseForm(parsed['form']) }
  } catch {
    return { route: null, form: null }
  }
}

function write(session: CalcSession): boolean {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session))
    return true
  } catch {
    return false // quota / blocked storage — the calculator still works, it just won't be remembered
  }
}

export function saveCalcRoute(route: CalcSessionRoute): void {
  const session = { ...loadCalcSession(), route }
  if (write(session)) return
  // A very long HERE route can exceed the quota — then remember just the code:
  // on return the calculator offers the HERE query again instead of showing nothing.
  if (route.kind === 'fetched') write({ ...session, route: { kind: 'notFound', routeCode: route.fetched.routeCode } })
}

export function saveCalcForm(form: CalcSessionForm): void {
  write({ ...loadCalcSession(), form })
}

/** On sign-out: the next person at this browser starts with an empty calculator. */
export function clearCalcSession(): void {
  try {
    sessionStorage.removeItem(KEY)
    sessionStorage.removeItem(SCREEN_KEY)
  } catch {
    // nothing stored, nothing to clear
  }
}

/** Last open screen + calculator tab, so a reload returns there instead of to Tablica. */
export function loadScreen<S extends string, C extends string>(): { screen: S; calc: C } | null {
  try {
    const raw = sessionStorage.getItem(SCREEN_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { screen?: unknown; calc?: unknown }
    return isString(parsed.screen) && isString(parsed.calc) ? { screen: parsed.screen as S, calc: parsed.calc as C } : null
  } catch {
    return null
  }
}

export function saveScreen(screen: string, calc: string): void {
  try {
    sessionStorage.setItem(SCREEN_KEY, JSON.stringify({ screen, calc }))
  } catch {
    // not remembered — a reload opens Tablica, as before
  }
}
