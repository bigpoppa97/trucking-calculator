import type { Kysely } from 'kysely'
import type { DB, DistanceSource } from '../db/schema.js'
import type { HereRoutingClient, TollVehicleProfile } from '../here/hereRoutingClient.js'
import { parseHereRoute } from '../here/routeParser.js'
import type { RouteFetchService } from '../here/routeFetchService.js'
import { haversineKm } from './normalize.js'
import type { PlaceIndex } from './context.js'

/**
 * Pairwise road distances between dictionary places.
 *
 * Lookup order: board cache (either direction) → calculator route database
 * (airport pairs, so manual km overrides made in the calculator win) → HERE
 * (once per pair, ever) → straight-line estimate × ROAD_FACTOR, flagged as an
 * estimate. HERE calls never happen inside a page request: missing pairs are
 * answered with an estimate immediately and queued for a background fetch,
 * so the next view shows the routed distance.
 */

export const ROAD_FACTOR = 1.2

export interface DistanceResult {
  km: number
  source: DistanceSource
}

export interface DistanceServiceDeps {
  db: Kysely<DB>
  /** Shared calculator flow for airport pairs: saves the route for the calculator too. */
  fetchService?: Pick<RouteFetchService, 'fetchNewRoute' | 'saveFetchedRoute'>
  /** Direct HERE routing for pairs involving non-airport places. */
  hereClient?: Pick<HereRoutingClient, 'fetchRoute'>
  vehicleProfile?: () => Promise<TollVehicleProfile>
  /** false in tests / offline: never call HERE. */
  allowHere: boolean
  actor?: string
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

export class DistanceService {
  private readonly queue = new Map<string, { from: string; to: string }>()
  private running: Promise<void> | null = null

  constructor(private readonly deps: DistanceServiceDeps) {}

  /** Distances for many pairs at once; unknown pairs are estimated and queued for HERE. */
  async getMany(pairs: Array<[string, string]>, places: PlaceIndex): Promise<Map<string, DistanceResult>> {
    const out = new Map<string, DistanceResult>()
    const wanted = new Map<string, [string, string]>()
    for (const [a, b] of pairs) {
      if (a === b) {
        out.set(pairKey(a, b), { km: 0, source: 'manual' })
        continue
      }
      wanted.set(pairKey(a, b), [a, b])
    }
    if (wanted.size === 0) return out

    const codes = [...new Set([...wanted.values()].flat())]
    const cached = await this.deps.db
      .selectFrom('board_distances')
      .selectAll()
      .where('from_code', 'in', codes)
      .where('to_code', 'in', codes)
      .execute()
    for (const row of cached) {
      const key = pairKey(row.from_code, row.to_code)
      if (!wanted.has(key)) continue
      const prev = out.get(key)
      // Prefer the better source when both directions are stored.
      if (!prev || rank(row.source) > rank(prev.source)) out.set(key, { km: row.km, source: row.source })
    }

    // Calculator route DB (2-stop airport routes) — read live every time so a
    // km override made in the calculator wins over HERE/estimates here.
    const routeCodes: string[] = []
    for (const [a, b] of wanted.values()) {
      if (/^[A-Z]{3}$/.test(a) && /^[A-Z]{3}$/.test(b)) routeCodes.push(`${a}-${b}`, `${b}-${a}`)
    }
    if (routeCodes.length > 0) {
      const routes = await this.deps.db
        .selectFrom('routes')
        .select(['route_code', 'total_km'])
        .where('route_code', 'in', routeCodes)
        .execute()
      for (const r of routes) {
        const [a, b] = r.route_code.split('-') as [string, string]
        const key = pairKey(a, b)
        const prev = out.get(key)
        if (!prev || rank('calculator') > rank(prev.source)) out.set(key, { km: r.total_km, source: 'calculator' })
      }
    }

    for (const [key, [a, b]] of wanted) {
      const hit = out.get(key)
      if (hit && hit.source !== 'estimate') continue
      if (!hit) {
        const pa = places.get(a)
        const pb = places.get(b)
        if (pa && pb) {
          const km = Math.round(haversineKm(pa, pb) * ROAD_FACTOR)
          out.set(key, { km, source: 'estimate' })
          await this.store(a, b, km, 'estimate')
        }
      }
      if (this.deps.allowHere) this.queue.set(key, { from: a, to: b })
    }
    if (this.deps.allowHere && this.queue.size > 0) this.kick(places)
    return out
  }

  static key(a: string, b: string): string {
    return pairKey(a, b)
  }

  /** Manual km for a pair (authoritative from now on, both directions). */
  async setManual(a: string, b: string, km: number, note: string | null): Promise<void> {
    await this.store(a, b, km, 'manual', note)
  }

  /** Re-queue all estimates for HERE (e.g. after the key starts working). */
  async refreshEstimates(places: PlaceIndex): Promise<number> {
    if (!this.deps.allowHere) return 0
    const rows = await this.deps.db.selectFrom('board_distances').selectAll().where('source', '=', 'estimate').execute()
    for (const r of rows) this.queue.set(pairKey(r.from_code, r.to_code), { from: r.from_code, to: r.to_code })
    if (rows.length > 0) this.kick(places)
    return rows.length
  }

  /** Resolves when the background queue is empty (used by tests and the import script). */
  async drain(): Promise<void> {
    while (this.running) await this.running
  }

  private kick(places: PlaceIndex): void {
    if (this.running) return
    this.running = (async () => {
      try {
        while (this.queue.size > 0) {
          const [key, pair] = this.queue.entries().next().value as [string, { from: string; to: string }]
          this.queue.delete(key)
          await this.fetchFromHere(pair.from, pair.to, places)
        }
      } finally {
        this.running = null
      }
    })()
  }

  private async fetchFromHere(a: string, b: string, places: PlaceIndex): Promise<void> {
    const current = await this.deps.db
      .selectFrom('board_distances')
      .select('source')
      .where(eb =>
        eb.or([
          eb.and([eb('from_code', '=', a), eb('to_code', '=', b)]),
          eb.and([eb('from_code', '=', b), eb('to_code', '=', a)]),
        ]),
      )
      .execute()
    if (current.some(c => c.source !== 'estimate')) return

    const pa = places.get(a)
    const pb = places.get(b)
    if (!pa || !pb) return
    try {
      const bothAirports = pa.kind === 'airport' && pb.kind === 'airport'
      if (bothAirports && this.deps.fetchService) {
        // Shared route database: the pair becomes a calculator route as well.
        const fetched = await this.deps.fetchService.fetchNewRoute(`${a}-${b}`)
        await this.deps.fetchService.saveFetchedRoute(fetched, this.deps.actor ?? 'tablica')
        await this.store(a, b, fetched.totalKm, 'here')
        return
      }
      if (this.deps.hereClient && this.deps.vehicleProfile) {
        const response = await this.deps.hereClient.fetchRoute({
          origin: { lat: pa.lat, lon: pa.lon },
          destination: { lat: pb.lat, lon: pb.lon },
          via: [],
          profile: await this.deps.vehicleProfile(),
        })
        const parsed = parseHereRoute(response)
        await this.store(a, b, Math.round(parsed.totalKm), 'here')
      }
    } catch {
      // Keep the estimate; a later refresh retries.
    }
  }

  private async store(a: string, b: string, km: number, source: DistanceSource, note: string | null = null) {
    const now = new Date().toISOString()
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      await this.deps.db
        .insertInto('board_distances')
        .values({ from_code: from, to_code: to, km, source, note, updated_at: now })
        .onConflict(oc => oc.columns(['from_code', 'to_code']).doUpdateSet({ km, source, note, updated_at: now }))
        .execute()
    }
  }
}

function rank(source: DistanceSource): number {
  return { estimate: 0, here: 1, calculator: 2, manual: 3 }[source]
}
