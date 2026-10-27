import type { AirportRepository } from '../repositories/airportRepository.js'
import type { ConfigRepository } from '../repositories/configRepository.js'
import type { RouteDetails, RouteRepository } from '../repositories/routeRepository.js'
import type { RouteWaypointRepository } from '../repositories/routeWaypointRepository.js'
import type { TollSystemRule, TollSystemRuleRepository } from '../repositories/tollSystemRuleRepository.js'
import { ROUTE_CODE_REGEX } from '../repositories/routeRepository.js'
import type { HerePlace, HereRoutingClient, TollVehicleProfile } from './hereRoutingClient.js'
import { parseHereRoute, type ParsedHereRoute, type RoutePolylineSection } from './routeParser.js'
import {
  computeTollRateBaseline,
  isTollCheckStale,
  rateWarnings,
  unmatchedSystemWarnings,
  type TollCheck,
} from './tollChecks.js'

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
  /** Per-toll details + check warnings (unmatched systems, €/km band). */
  tollCheck?: TollCheck
}

/** One country's toll before/after a "Przelicz opłaty z HERE". */
export interface TollRecalcChange {
  country: string
  /** Stored value before the recalculation (null = none). */
  beforeEur: number | null
  /** HERE estimate after correction rules (null = HERE gave none). */
  hereEur: number | null
  /**
   * updated   — estimate replaced by the new HERE value
   * unchanged — estimate equal to the new HERE value
   * added     — country had no toll value, now a HERE estimate
   * kept-verified — verified (invoice) value, never overwritten
   * no-here-value — HERE returned no toll; the stored estimate stays
   * pending   — no value before, none from HERE
   */
  outcome: 'updated' | 'unchanged' | 'added' | 'kept-verified' | 'no-here-value' | 'pending'
}

export interface TollRecalcResult {
  route: RouteDetails
  summary: {
    changes: TollRecalcChange[]
    hereTotalKm: number
    warnings: string[]
    tollCheck: TollCheck
  }
}

export type TollRecalcReason = 'never-checked' | 'rules-changed' | 'up-to-date'

export interface TollRecalcCandidate {
  routeCode: string
  reason: TollRecalcReason
  tollWarnings: number
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
  tollRules?: Pick<TollSystemRuleRepository, 'listAll'> & Partial<Pick<TollSystemRuleRepository, 'markMatched'>>
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
      const parsed = parseHereRoute(response, rules)
      if (parsed.matchedRuleIds.length > 0) {
        // Diagnostics only — a failed stamp must never fail the fetch.
        await this.deps.tollRules?.markMatched?.(parsed.matchedRuleIds, this.now()).catch(() => undefined)
      }
      return { parsed, profile, waypointNames }
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

  /**
   * Toll checks for one HERE result: non-e-TOLL systems without a rule and
   * the €/km band against the company's other stored routes.
   */
  private async buildTollCheck(
    parsed: ParsedHereRoute,
    countryKm: Record<string, number>,
    excludeRouteId?: number,
  ): Promise<TollCheck> {
    // HERE's own (rule-corrected) values only — the Baltic €0 period-pass
    // defaults are deliberate and must not read as "podejrzanie niska".
    const tollEstimates = parsed.tollEstimates
    const baseline = computeTollRateBaseline(await this.deps.routes.tollRateSamples(excludeRouteId))
    return {
      checkedAt: this.now(),
      items: parsed.tollItems,
      warnings: [
        ...unmatchedSystemWarnings(parsed.tollItems),
        ...rateWarnings(countryKm, tollEstimates, parsed.tollItems, baseline),
      ],
    }
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
    const tollCheck = await this.buildTollCheck(parsed, parsed.countryKm)

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
      tollCheck,
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
    const check = await this.buildTollCheck(parsed, { ...parsed.countryKm, ...route.countryKm }, route.id)
    warnings.push(...check.warnings)

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
      ...(fetched.tollCheck !== undefined ? { tollCheck: fetched.tollCheck } : {}),
      tolls: Object.entries(fetched.tollEstimates).map(([country, tollEur]) => ({
        country,
        tollEur,
        status: 'estimate' as const,
        fetchedAt: fetched.fetchedAt,
        vehicleProfile: fetched.vehicleProfile,
      })),
    })
  }

  /**
   * "Przelicz opłaty z HERE" for a STORED route (1 HERE request) with the
   * current correction rules. Every estimate is replaced by the new HERE
   * value and countries without a toll get one; verified (invoice) values,
   * stored km and the binding total stay as they are. Stores the shape and
   * the toll check, so a later rule change can tell this route is affected.
   */
  async recalculateTolls(routeCode: string): Promise<TollRecalcResult> {
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
    const countryKm = { ...parsed.countryKm, ...route.countryKm }
    const { tollEstimates, defaulted } = withBalticDefaults(countryKm, parsed.tollEstimates)
    warnings.push(...defaulted.map(balticWarning))
    const tollCheck = await this.buildTollCheck(parsed, countryKm, route.id)

    const fetchedAt = this.now()
    const written = new Set(
      await this.deps.routes.applyTollRecalc(route.id, {
        estimates: Object.entries(tollEstimates).map(([country, tollEur]) => ({
          country,
          tollEur,
          fetchedAt,
          vehicleProfile: profile,
        })),
        polylineSections: parsed.sections,
        tollCheck,
      }),
    )

    const before = new Map(route.tolls.map(t => [t.country, t]))
    const countries = [...new Set([...before.keys(), ...Object.keys(tollEstimates), ...Object.keys(route.countryKm)])].sort()
    const changes: TollRecalcChange[] = countries.map(country => {
      const old = before.get(country)
      const here = tollEstimates[country] ?? null
      const beforeEur = old?.tollEur ?? null
      let outcome: TollRecalcChange['outcome']
      if (old?.status === 'verified') outcome = 'kept-verified'
      else if (written.has(country)) outcome = old === undefined ? 'added' : old.tollEur === here ? 'unchanged' : 'updated'
      else outcome = old === undefined ? 'pending' : 'no-here-value'
      return { country, beforeEur, hereEur: here, outcome }
    })

    const updated = await this.deps.routes.findByCode(code)
    if (!updated) throw new RouteFetchError('ROUTE_NOT_FOUND', `Route ${code} disappeared during the toll recalculation.`)
    return { route: updated, summary: { changes, hereTotalKm: parsed.totalKm, warnings, tollCheck } }
  }

  /**
   * Stored routes whose HERE toll estimates may be out of date — the list
   * for the bulk recalculation after a rule change. No HERE call. Routes
   * whose every toll is verified (and none pending) are left out: a
   * recalculation would change nothing.
   */
  async listTollRecalcCandidates(): Promise<TollRecalcCandidate[]> {
    const rules = (await this.deps.tollRules?.listAll()) ?? []
    const candidates: TollRecalcCandidate[] = []
    for (const summary of await this.deps.routes.listAll()) {
      if (!summary.hasEstimates && !summary.tollsPending) continue
      const route = await this.deps.routes.findById(summary.id)
      if (!route) continue
      const reason: TollRecalcReason =
        route.tollCheck === null ? 'never-checked' : isTollCheckStale(route.tollCheck, rules) ? 'rules-changed' : 'up-to-date'
      candidates.push({ routeCode: route.routeCode, reason, tollWarnings: route.tollCheck?.warnings.length ?? 0 })
    }
    return candidates
  }
}
