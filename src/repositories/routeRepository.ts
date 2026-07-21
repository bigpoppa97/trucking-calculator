import type { Kysely, Transaction } from 'kysely'
import type { DB, KmSource, TollStatusDb } from '../db/schema.js'
import type { RoutePolylineSection } from '../here/routeParser.js'

/** Route ID format per PRD §3.1: hyphen-separated IATA codes, 2+ stops. */
export const ROUTE_CODE_REGEX = /^[A-Z]{3}(-[A-Z]{3})+$/

export interface RouteToll {
  country: string
  tollEur: number
  status: TollStatusDb
  fetchedAt: string | null
  vehicleProfile: unknown | null
  verifiedBy: string | null
  verifiedAt: string | null
}

export interface RouteDetails {
  id: number
  routeCode: string
  stops: string[]
  totalKm: number
  kmSource: KmSource
  createdBy: string
  createdAt: string
  /** Manual km override audit (PRD §5.3). Null until the first override. */
  kmNote: string | null
  kmUpdatedBy: string | null
  kmUpdatedAt: string | null
  /** Per-country km, only countries actually driven (km > 0). */
  countryKm: Record<string, number>
  tolls: RouteToll[]
  /** Countries with km > 0 but no toll row — "tolls pending" (PRD §3.2). */
  tollsPendingCountries: string[]
  /** Route shape for the map preview; null for v1-imported routes. */
  polylineSections: RoutePolylineSection[] | null
}

export interface NewRouteInput {
  routeCode: string
  totalKm: number
  kmSource: KmSource
  createdBy: string
  countryKm: Record<string, number>
  polylineSections?: RoutePolylineSection[]
  tolls: Array<{
    country: string
    tollEur: number
    status: TollStatusDb
    fetchedAt?: string
    vehicleProfile?: unknown
    verifiedBy?: string
    verifiedAt?: string
  }>
}

export interface RouteSummary {
  id: number
  routeCode: string
  totalKm: number
  kmSource: KmSource
  createdAt: string
  tollsPending: boolean
  hasEstimates: boolean
}

export class RouteRepository {
  constructor(private readonly db: Kysely<DB>) {}

  async create(input: NewRouteInput): Promise<RouteDetails> {
    if (!ROUTE_CODE_REGEX.test(input.routeCode)) {
      throw new Error(`Invalid route code: must be hyphen-separated 3-letter IATA codes with 2+ stops.`)
    }
    const stops = input.routeCode.split('-')

    const id = await this.db.transaction().execute(async trx => {
      const route = await trx
        .insertInto('routes')
        .values({
          route_code: input.routeCode,
          stops: JSON.stringify(stops),
          total_km: input.totalKm,
          km_source: input.kmSource,
          created_by: input.createdBy,
          polyline_encoded: input.polylineSections === undefined ? null : JSON.stringify(input.polylineSections),
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      for (const [country, km] of Object.entries(input.countryKm)) {
        if (km <= 0) continue
        await trx.insertInto('route_country_km').values({ route_id: route.id, country, km }).execute()
      }
      for (const toll of input.tolls) {
        await insertToll(trx, route.id, toll)
      }
      return route.id
    })

    const details = await this.findById(id)
    if (!details) throw new Error('Route disappeared right after creation.')
    return details
  }

  async findByCode(routeCode: string): Promise<RouteDetails | null> {
    const row = await this.db
      .selectFrom('routes')
      .selectAll()
      .where('route_code', '=', routeCode)
      .executeTakeFirst()
    return row ? this.hydrate(row.id) : null
  }

  async findById(id: number): Promise<RouteDetails | null> {
    return this.hydrate(id)
  }

  async existsByCode(routeCode: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('routes')
      .select('id')
      .where('route_code', '=', routeCode)
      .executeTakeFirst()
    return row !== undefined
  }

  async listAll(): Promise<RouteSummary[]> {
    const routes = await this.db.selectFrom('routes').selectAll().orderBy('route_code').execute()
    const summaries: RouteSummary[] = []
    for (const r of routes) {
      const details = await this.hydrate(r.id)
      if (!details) continue
      summaries.push({
        id: r.id,
        routeCode: r.route_code,
        totalKm: r.total_km,
        kmSource: r.km_source,
        createdAt: r.created_at,
        tollsPending: details.tollsPendingCountries.length > 0,
        hasEstimates: details.tolls.some(t => t.status === 'estimate'),
      })
    }
    return summaries
  }

  /**
   * Manual km override (PRD §3.3): dispatcher-entered values are
   * authoritative — km_source flips to 'manual'. Audited with who/when/why.
   */
  async overrideKm(
    routeCode: string,
    totalKm: number,
    countryKm: Record<string, number>,
    audit?: { note?: string; updatedBy: string },
  ): Promise<void> {
    await this.db.transaction().execute(async trx => {
      const route = await trx
        .selectFrom('routes')
        .select('id')
        .where('route_code', '=', routeCode)
        .executeTakeFirst()
      if (!route) throw new Error(`Route not found: cannot override km.`)

      await trx
        .updateTable('routes')
        .set({
          total_km: totalKm,
          km_source: 'manual',
          km_note: audit?.note ?? null,
          km_updated_by: audit?.updatedBy ?? null,
          km_updated_at: audit === undefined ? null : new Date().toISOString(),
        })
        .where('id', '=', route.id)
        .execute()
      await trx.deleteFrom('route_country_km').where('route_id', '=', route.id).execute()
      for (const [country, km] of Object.entries(countryKm)) {
        if (km <= 0) continue
        await trx.insertInto('route_country_km').values({ route_id: route.id, country, km }).execute()
      }
    })
  }

  /**
   * Manual toll entry (PRD §3.2 "tolls pending" → filled in): a human-typed
   * value is authoritative, stored as verified with audit fields.
   */
  async setManualToll(routeId: number, country: string, tollEur: number, enteredBy: string): Promise<void> {
    await this.upsertToll(routeId, {
      country,
      tollEur,
      status: 'verified',
      verifiedBy: enteredBy,
      verifiedAt: new Date().toISOString(),
    })
  }

  /** Insert or replace a per-country toll value. */
  async upsertToll(routeId: number, toll: NewRouteInput['tolls'][number]): Promise<void> {
    await this.db.transaction().execute(async trx => {
      await trx
        .deleteFrom('route_country_toll')
        .where('route_id', '=', routeId)
        .where('country', '=', toll.country)
        .execute()
      await insertToll(trx, routeId, toll)
    })
  }

  /**
   * Promote an estimate to verified (PRD §4.3 verification workflow), with
   * audit fields. Optionally corrects the value at the same time.
   */
  async verifyToll(routeId: number, country: string, verifiedBy: string, correctedTollEur?: number): Promise<void> {
    const result = await this.db
      .updateTable('route_country_toll')
      .set({
        status: 'verified',
        verified_by: verifiedBy,
        verified_at: new Date().toISOString(),
        ...(correctedTollEur !== undefined ? { toll_eur: correctedTollEur } : {}),
      })
      .where('route_id', '=', routeId)
      .where('country', '=', country)
      .executeTakeFirst()
    if (result.numUpdatedRows === 0n) {
      throw new Error(`No toll row to verify for that route/country.`)
    }
  }

  private async hydrate(id: number): Promise<RouteDetails | null> {
    const row = await this.db.selectFrom('routes').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) return null

    const kmRows = await this.db
      .selectFrom('route_country_km')
      .selectAll()
      .where('route_id', '=', id)
      .execute()
    const tollRows = await this.db
      .selectFrom('route_country_toll')
      .selectAll()
      .where('route_id', '=', id)
      .execute()

    const countryKm: Record<string, number> = {}
    for (const k of kmRows) countryKm[k.country] = k.km

    const tolls: RouteToll[] = tollRows.map(t => ({
      country: t.country,
      tollEur: t.toll_eur,
      status: t.status,
      fetchedAt: t.fetched_at,
      vehicleProfile: t.vehicle_profile === null ? null : (JSON.parse(t.vehicle_profile) as unknown),
      verifiedBy: t.verified_by,
      verifiedAt: t.verified_at,
    }))

    const tollCountries = new Set(tolls.map(t => t.country))
    const tollsPendingCountries = Object.keys(countryKm).filter(c => !tollCountries.has(c))

    return {
      id: row.id,
      routeCode: row.route_code,
      stops: JSON.parse(row.stops) as string[],
      totalKm: row.total_km,
      kmSource: row.km_source,
      createdBy: row.created_by,
      createdAt: row.created_at,
      kmNote: row.km_note,
      kmUpdatedBy: row.km_updated_by,
      kmUpdatedAt: row.km_updated_at,
      countryKm,
      tolls,
      tollsPendingCountries,
      polylineSections:
        row.polyline_encoded === null ? null : (JSON.parse(row.polyline_encoded) as RoutePolylineSection[]),
    }
  }
}

async function insertToll(
  trx: Transaction<DB>,
  routeId: number,
  toll: NewRouteInput['tolls'][number],
): Promise<void> {
  await trx
    .insertInto('route_country_toll')
    .values({
      route_id: routeId,
      country: toll.country,
      toll_eur: toll.tollEur,
      status: toll.status,
      fetched_at: toll.fetchedAt ?? null,
      vehicle_profile: toll.vehicleProfile === undefined ? null : JSON.stringify(toll.vehicleProfile),
      verified_by: toll.verifiedBy ?? null,
      verified_at: toll.verifiedAt ?? null,
    })
    .execute()
}
