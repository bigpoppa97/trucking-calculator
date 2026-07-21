import type { AirportRepository } from '../repositories/airportRepository.js'
import type { ConfigRepository } from '../repositories/configRepository.js'
import type { RouteDetails, RouteRepository } from '../repositories/routeRepository.js'
import type { TollSystemRuleRepository } from '../repositories/tollSystemRuleRepository.js'
import { ROUTE_CODE_REGEX } from '../repositories/routeRepository.js'
import type { HereRoutingClient, TollVehicleProfile } from './hereRoutingClient.js'
import { parseHereRoute, type RoutePolylineSection } from './routeParser.js'

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

export interface RouteFetchServiceDeps {
  client: Pick<HereRoutingClient, 'fetchRoute'>
  airports: AirportRepository
  routes: RouteRepository
  config: ConfigRepository
  /** Optional: toll-system correction rules applied at parse time. */
  tollRules?: Pick<TollSystemRuleRepository, 'listAll'>
  now?: () => string
}

export class RouteFetchService {
  constructor(private readonly deps: RouteFetchServiceDeps) {}

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
    const places = []
    for (const iata of stops) {
      const airport = await this.deps.airports.findByIata(iata)
      if (!airport) {
        throw new RouteFetchError('AIRPORT_NOT_FOUND', `Airport ${iata} is not in the airport database.`)
      }
      places.push({ lat: airport.lat, lon: airport.lon })
    }

    const profile = await this.deps.config.getTollVehicleProfile()
    const rules = (await this.deps.tollRules?.listAll()) ?? []

    let parsed
    try {
      const response = await this.deps.client.fetchRoute({
        origin: places[0]!,
        destination: places[places.length - 1]!,
        via: places.slice(1, -1),
        profile,
      })
      parsed = parseHereRoute(response, rules)
    } catch {
      // Detail stays server-side; the client gets a graceful, static message.
      throw new RouteFetchError(
        'HERE_UNAVAILABLE',
        'Route service is temporarily unavailable. Please try again later.',
      )
    }
    const warnings = [...parsed.warnings]

    const tollEstimates = { ...parsed.tollEstimates }
    for (const baltic of BALTIC_DEFAULT_ZERO) {
      if (parsed.countryKm[baltic] !== undefined && tollEstimates[baltic] === undefined) {
        tollEstimates[baltic] = 0
        warnings.push(
          `${baltic}: time-based truck charge defaulted to €0 (period pass assumed) — override manually if needed.`,
        )
      }
    }

    return {
      routeCode: code,
      stops,
      totalKm: parsed.totalKm,
      countryKm: parsed.countryKm,
      tollEstimates,
      sections: parsed.sections,
      vehicleProfile: profile,
      fetchedAt: (this.deps.now ?? (() => new Date().toISOString()))(),
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

    const places = []
    for (const iata of route.stops) {
      const airport = await this.deps.airports.findByIata(iata)
      if (!airport) {
        throw new RouteFetchError('AIRPORT_NOT_FOUND', `Airport ${iata} is not in the airport database.`)
      }
      places.push({ lat: airport.lat, lon: airport.lon })
    }
    const profile = await this.deps.config.getTollVehicleProfile()

    let parsed
    try {
      const response = await this.deps.client.fetchRoute({
        origin: places[0]!,
        destination: places[places.length - 1]!,
        via: places.slice(1, -1),
        profile,
      })
      parsed = parseHereRoute(response)
    } catch {
      throw new RouteFetchError(
        'HERE_UNAVAILABLE',
        'Route service is temporarily unavailable. Please try again later.',
      )
    }

    await this.deps.routes.setPolylineSections(route.id, parsed.sections)
    const updated = await this.deps.routes.findByCode(code)
    if (!updated) throw new RouteFetchError('ROUTE_NOT_FOUND', `Route ${code} disappeared during shape refresh.`)
    return updated
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
