import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import type { CalculatorConfig, CostBreakdown, DriverCount } from '../domain/types.js'

/**
 * Frozen snapshot stored with every calculation (PRD §5.2): config changes
 * must not retroactively alter saved calculations. The snapshot is written
 * once and never updated.
 */
export interface CalculationSnapshot {
  input: {
    routeCode: string
    totalKm: number
    orderDays: number
    driverCount: DriverCount
    fleetVariantName: string
    fleetMonthlyCostEur: number
    ferriesEur: number
    tunnelsEur: number
    revenueEur?: number
  }
  config: CalculatorConfig
  breakdown: CostBreakdown
}

export interface NewCalculation {
  routeId: number
  days: number
  drivers: DriverCount
  fleetVariantId: number
  ferriesEur: number
  tunnelsEur: number
  revenueEur?: number
  snapshot: CalculationSnapshot
  createdBy: string
}

export interface SavedCalculation {
  id: number
  routeId: number
  days: number
  drivers: number
  fleetVariantId: number
  ferriesEur: number
  tunnelsEur: number
  revenueEur: number | null
  snapshot: CalculationSnapshot
  createdBy: string
  createdAt: string
}

export class CalculationRepository {
  constructor(private readonly db: Kysely<DB>) {}

  async create(calc: NewCalculation): Promise<number> {
    const row = await this.db
      .insertInto('calculations')
      .values({
        route_id: calc.routeId,
        days: calc.days,
        drivers: calc.drivers,
        fleet_variant_id: calc.fleetVariantId,
        ferries_eur: calc.ferriesEur,
        tunnels_eur: calc.tunnelsEur,
        revenue_eur: calc.revenueEur ?? null,
        snapshot: JSON.stringify(calc.snapshot),
        created_by: calc.createdBy,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  }

  async findById(id: number): Promise<SavedCalculation | null> {
    const row = await this.db
      .selectFrom('calculations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? toSaved(row) : null
  }

  async listRecent(limit = 50): Promise<SavedCalculation[]> {
    const rows = await this.db
      .selectFrom('calculations')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute()
    return rows.map(toSaved)
  }

  /** History view (PRD §5.3): newest first, optionally filtered by route code. */
  async listHistory(filter: { routeCode?: string; limit?: number } = {}): Promise<
    Array<SavedCalculation & { routeCode: string }>
  > {
    let query = this.db
      .selectFrom('calculations')
      .innerJoin('routes', 'routes.id', 'calculations.route_id')
      .selectAll('calculations')
      .select('routes.route_code')
      .orderBy('calculations.created_at', 'desc')
      .orderBy('calculations.id', 'desc')
      .limit(filter.limit ?? 100)
    if (filter.routeCode !== undefined) {
      query = query.where('routes.route_code', '=', filter.routeCode)
    }
    const rows = await query.execute()
    return rows.map(row => ({ ...toSaved(row), routeCode: row.route_code }))
  }

  async listByRoute(routeId: number): Promise<SavedCalculation[]> {
    const rows = await this.db
      .selectFrom('calculations')
      .selectAll()
      .where('route_id', '=', routeId)
      .orderBy('created_at', 'desc')
      .execute()
    return rows.map(toSaved)
  }
}

function toSaved(row: {
  id: number
  route_id: number
  days: number
  drivers: number
  fleet_variant_id: number
  ferries_eur: number
  tunnels_eur: number
  revenue_eur: number | null
  snapshot: string
  created_by: string
  created_at: string
}): SavedCalculation {
  return {
    id: row.id,
    routeId: row.route_id,
    days: row.days,
    drivers: row.drivers,
    fleetVariantId: row.fleet_variant_id,
    ferriesEur: row.ferries_eur,
    tunnelsEur: row.tunnels_eur,
    revenueEur: row.revenue_eur,
    snapshot: JSON.parse(row.snapshot) as CalculationSnapshot,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}
