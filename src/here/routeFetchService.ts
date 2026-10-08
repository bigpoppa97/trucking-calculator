import type { AirportRepository } from '../repositories/airportRepository.js'
import type { ConfigRepository } from '../repositories/configRepository.js'
import type { RouteDetails, RouteRepository } from '../repositories/routeRepository.js'
import type { RouteWaypointRepository } from '../repositories/routeWaypointRepository.js'
import type { TollSystemRule, TollSystemRuleRepository } from '../repositories/tollSystemRuleRepository.js'
import { ROUTE_CODE_REGEX } from '../repositories/routeRepository.js'
import type { HerePlace, HereRoutingClient, TollVehicleProfile } from './hereRoutingClient.js'
import { parseHereRoute, type ParsedHereRoute, type RoutePolylineSection } from './routeParser.js'

/**
 * Fetch-and-save flow for routes not in the database (PRD §3.2 steps 2–3).
 * HERE is called exactly once per route, ever: fetching is refused when the
 * route already exists, and saving is a separate explicit action so the UI
 * can show results and offer "Save to route database".
 */

/** Baltic truck charges are time-based; with period passes the marginal
 *  cost is ~€0 — default their estimates to 0 with manual override (PRD §4.3). */
const BALTIC_DEFAULT_ZERO = ['EE', 'LV', 'LT']

export class RouteFetchError extends Error {
  constructor(
    readonly code: 'INVALID_ROUTE_CODE' | 'ROUTE_ALREADY_EXISTS' | 'ROUTE_NOT_FOUND' | 'AIRPORT_NOT_FOUND' | 'HERE_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'RouteFetchError'
  }
}

export interface FetchedRoute {
  routeCode: string
  stops: string[]
  totalKm: number
  countryKm: Record<string, number>
  /** EUR per alpha-2 country, all status 'estimate'. */
  tollEstimates: Record<string, number>
  /** Route shape per HERE section, for the map preview. */
  sections: RoutePolylineSection[]
  vehicleProfile: TollVehicleProfile
  fetchedAt: string
  warnings: string[]
}

/** What a gap fill changed (and deliberately did not) on an existing route. */
export interface GapFillSummary {
  /** Countries that were missing from the stored km split, with HERE km. */
  addedCountryKm: Record<string, number>
  /** Countries that had no toll value at all — now HERE estimates. */
  addedTolls: Record<string, number>
  /** Countries whose stored toll (verified or estimate) was left untouched. */
  keptTollCountries: string[]
  /** Countries still without a toll value after the fill. */
  stillPendingCountries: string[]
  /** HERE's own total, for comparison only — the stored total is kept. */
  hereTotalKm: number
  warnings: string[]
}

export interface GapFillResult {
  route: RouteDetails
  summary: GapFillSummary
}

/**
 * Pure planning step of a gap fill: only ADDS what the stored route lacks.
 * Stored country km and any existing toll row (verified or estimate) win.
 */
export function planGapFill(
  route: Pick<RouteDetails, 'countryKm' | 'tolls'>,
  hereCountryKm: Record<string, number>,
  hereTollEstimates: Record<string, number>,
): { addedCountryKm: Record<string, number>; addedTolls: Record<string, number>; keptTollCountries: string[] } {
  const addedCountryKm: Record<string, number> = {}
  for (const [country, km] of Object.entries(hereCountryKm)) {
    if (km > 0 && route.countryKm[country] === undefined) addedCountryKm[country] = km
  }
  const tollCountries = new Set(route.tolls.map(t => t.country))
  const addedTolls: Record<string, number> = {}
  for (const [country, eur] of Object.entries(hereTollEstimates)) {
    if (!tollCountries.has(country)) addedTolls[country] = eur
  }
  return { addedCountryKm, addedTolls, keptTollCountries: [...tollCountries].sort() }
}

/** Baltic €0 defaults for driven countries HERE did not price (PRD §4.3). */
function withBalticDefaults(
  countryKm: Record<string, number>,
  tollEstimates: Record<string, number>,
): { tollEstimates: Record<string, number>; defaulted: string[] } {
  const result = { ...tollEstimates }
  const defaulted: string[] = []
  for (const baltic of BALTIC_DEFAULT_ZERO) {
    if (countryKm[baltic] !== undefined && result[baltic] === undefined) {
      result[baltic] = 0
      defaulted.push(baltic)
    }
  }
  return { tollEstimates: result, defaulted }
}

const balticWarning = (country: string): string =>
  `${country}: time-based truck charge defaulted to €0 (period pass assumed) — override manually if needed.`

export interface RouteFetchServiceDeps {
  client: Pick<HereRoutingClient, 'fetchRoute'>
  airports: AirportRepository
  routes: RouteRepository
  config: ConfigRepository
  /** Optional: toll-system correction rules applied at parse time. */
  tollRules?: Pick<TollSystemRuleRepository, 'listAll'>
  /** Optional: company-preferred via waypoints per route code (PRD §3.3). */
  waypoints?: Pick<RouteWaypointRepository, 'listByRoute'>
  now?: () => string
}

export class RouteFetchService {
  constructor(private readonly deps: RouteFetchServiceDeps) {}

  /**
   * One ordered via chain: intermediate airport stops (implicit seq
   * (index+1)*1000) merged with company-preferred waypoints by their seq.
   * Waypoints ride as pass-through — they bend the route onto the preferred
   * corridor without stopping it or splitting sections.
   */
  private async buildViaChain(code: string, intermediates: HerePlace[]): Promise<{ via: HerePlace[]; waypointNames: string[] }> {
    const waypoints = (await this.deps.waypoints?.listByRoute(code)) ?? []
    const entries = [
      ...intermediates.map((place, i) => ({ seq: (i + 1) * 1000, place })),
      ...waypoints.map(wp => ({ seq: wp.seq, place: { lat: wp.lat, lon: wp.lon, passThrough: true } })),
    ]
    return {
      via: entries.sort((a, b) => a.seq - b.seq).map(e => e.place),
      waypointNames: waypoints.map(wp => wp.name),
    }
  }

  /** Airport coordinates for each stop, in order — fails before any HERE call. */
  private async resolvePlaces(stops: string[]): Promise<HerePlace[]> {
    const places: HerePlace[] = []
    for (const iata of stops) {
      const airport = await this.deps.airports.findByIata(iata)
      if (!airport) {
        throw new RouteFetchError('AIRPORT_NOT_FOUND', `Airport ${iata} is not in the airport database.`)
      }
      places.push({ lat: airport.lat, lon: airport.lon })
    }
    return places
  }

  /** ONE HERE request for the given stops (+ stored waypoints), parsed. */
  private async queryHere(
    code: string,
    stops: string[],
    rules: TollSystemRule[],
  ): Promise<{ parsed: ParsedHereRoute; profile: TollVehicleProfile; waypointNames: string[] }> {
    const places = await this.resolvePlaces(stops)
    const profile = await this.deps.config.getTollVehicleProfile()
    const { via, waypointNames } = await this.buildViaChain(code, places.slice(1, -1))

    try {
      const response = await this.deps.client.fetchRoute({
        origin: places[0]!,
        destination: places[places.length - 1]!,
        via,
        profile,
      })
      return { parsed: parseHereRoute(response, rules), profile, waypointNames }
    } catch {
      // Detail stays server-side; the client gets a graceful, static message.
      throw new RouteFetchError(
        'HERE_UNAVAILABLE',
        'Route service is temporarily unavailable. Please try again later.',
      )
    }
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))()
  }

  /** Call HERE for a route that is not in the database. Does NOT save. */
  async fetchNewRoute(routeCode: string): Promise<FetchedRoute> {
    const code = routeCode.trim().toUpperCase()
    if (!ROUTE_CODE_REGEX.test(code)) {
      throw new RouteFetchError(
        'INVALID_ROUTE_CODE',
        'Route code must be 3-letter IATA codes separated by hyphens, e.g. WAW-PRG.',
      )
    }
    if (await this.deps.routes.existsByCode(code)) {
      throw new RouteFetchError(
        'ROUTE_ALREADY_EXISTS',
        `Route ${code} is already in the database — use the stored data instead of calling HERE.`,
      )
    }

    const stops = code.split('-')
    const rules = (await this.deps.tollRules?.listAll()) ?? []
    const { parsed, profile, waypointNames } = await this.queryHere(code, stops, rules)

    const warnings = [...parsed.warnings]
    if (waypointNames.length > 0) {
      warnings.push(`Preferred waypoints applied: ${waypointNames.join(', ')}.`)
    }
    const { tollEstimates, defaulted } = withBalticDefaults(parsed.countryKm, parsed.tollEstimates)
    warnings.push(...defaulted.map(balticWarning))

    return {
      routeCode: code,
      stops,
      totalKm: parsed.totalKm,
      countryKm: parsed.countryKm,
      tollEstimates,
      sections: parsed.sections,
      vehicleProfile: profile,
      fetchedAt: this.now(),
      warnings,
    }
  }

  /**
   * Backfill the map shape for an EXISTING route (v1 imports have none).
   * Costs one HERE request; stores ONLY the polyline sections — stored km,
   * manual overrides and toll values are authoritative and stay untouched
   * (PRD §3.3). The shape is HERE's suggested road, which may differ from
   * the company-preferred crossing.
   */
  async refreshRouteShape(routeCode: string): Promise<RouteDetails> {
    const code = routeCode.trim().toUpperCase()
    const route = await this.deps.routes.findByCode(code)
    if (!route) {
      throw new RouteFetchError('ROUTE_NOT_FOUND', `Route ${code} is not in the database.`)
    }

    const { parsed } = await this.queryHere(code, route.stops, [])
    await this.deps.routes.setPolylineSections(route.id, parsed.sections)
    const updated = await this.deps.routes.findByCode(code)
    if (!updated) throw new RouteFetchError('ROUTE_NOT_FOUND', `Route ${code} disappeared during shape refresh.`)
    return updated
  }

  /**
   * Fill the GAPS of an EXISTING route from HERE (one request) — e.g. v1
   * imports whose sheet had no columns for FR/ES/NL/CH and no toll values.
   * Adds toll estimates for countries without any toll value and km for
   * countries missing from the stored split; stores the shape. Never
   * overwrites: verified tolls, existing estimates, stored country km and
   * the (binding) total km stay exactly as they are (PRD §3.3).
   */
  async fillRouteGaps(routeCode: string, actor: string): Promise<GapFillResult> {
    const code = routeCode.trim().toUpperCase()
    const route = await this.deps.routes.findByCode(code)
    if (!route) {
      throw new RouteFetchError('ROUTE_NOT_FOUND', `Route ${code} is not in the database.`)
    }

    const rules = (await this.deps.tollRules?.listAll()) ?? []
    const { parsed, profile, waypointNames } = await this.queryHere(code, route.stops, rules)
    const warnings = [...parsed.warnings]
    if (waypointNames.length > 0) {
      warnings.push(`Preferred waypoints applied: ${waypointNames.join(', ')}.`)
    }

    // Baltic defaults judged against the km the route will have after the fill.
    const { tollEstimates, defaulted } = withBalticDefaults(
      { ...parsed.countryKm, ...route.countryKm },
      parsed.tollEstimates,
    )
    const plan = planGapFill(route, parsed.countryKm, tollEstimates)
    warnings.push(...defaulted.filter(c => plan.addedTolls[c] !== undefined).map(balticWarning))

    const fetchedAt = this.now()
    const addedKmEntries = Object.entries(plan.addedCountryKm)
    await this.deps.routes.applyGapFill(route.id, {
      addCountryKm: plan.addedCountryKm,
      addTolls: Object.entries(plan.addedTolls).map(([country, tollEur]) => ({
        country,
        tollEur,
        status: 'estimate' as const,
        fetchedAt,
        vehicleProfile: profile,
      })),
      polylineSections: parsed.sections,
      ...(addedKmEntries.length > 0
        ? {
            kmAudit: {
              note: `Kraje uzupełnione z HERE: ${addedKmEntries.map(([c, km]) => `${c} ${String(km).replace('.', ',')} km`).join(', ')}`,
              updatedBy: actor,
              updatedAt: fetchedAt,
            },
          }
        : {}),
    })

    const updated = await this.deps.routes.findByCode(code)
    if (!updated) throw new RouteFetchError('ROUTE_NOT_FOUND', `Route ${code} disappeared during the HERE fill.`)
    return {
      route: updated,
      summary: {
        addedCountryKm: plan.addedCountryKm,
        addedTolls: plan.addedTolls,
        keptTollCountries: plan.keptTollCountries,
        stillPendingCountries: updated.tollsPendingCountries,
        hereTotalKm: parsed.totalKm,
        warnings,
      },
    }
  }

  /**
   * Save a fetched route (PRD §3.2 step 3): km_source='here', every toll
   * stored as status='estimate' with the vehicle profile snapshot. Countries
   * driven but without an estimate stay pending.
   */
  async saveFetchedRoute(fetched: FetchedRoute, actor: string): Promise<RouteDetails> {
    if (await this.deps.routes.existsByCode(fetched.routeCode)) {
      throw new RouteFetchError(
        'ROUTE_ALREADY_EXISTS',
        `Route ${fetched.routeCode} is already in the database.`,
      )
    }
    return this.deps.routes.create({
      routeCode: fetched.routeCode,
      totalKm: fetched.totalKm,
      kmSource: 'here',
      createdBy: actor,
      countryKm: fetched.countryKm,
      polylineSections: fetched.sections,
      tolls: Object.entries(fetched.tollEstimates).map(([country, tollEur]) => ({
        country,
        tollEur,
        status: 'estimate' as const,
        fetchedAt: fetched.fetchedAt,
        vehicleProfile: fetched.vehicleProfile,
      })),
    })
  }
}
