import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'

export interface FleetVariant {
  id: number
  name: string
  monthlyCostEur: number
  active: boolean
}

export class FleetVariantRepository {
  constructor(private readonly db: Kysely<DB>) {}

  async listActive(): Promise<FleetVariant[]> {
    const rows = await this.db
      .selectFrom('fleet_variants')
      .selectAll()
      .where('active', '=', 1)
      .orderBy('name')
      .execute()
    return rows.map(toVariant)
  }

  async listAll(): Promise<FleetVariant[]> {
    const rows = await this.db.selectFrom('fleet_variants').selectAll().orderBy('name').execute()
    return rows.map(toVariant)
  }

  async findByName(name: string): Promise<FleetVariant | null> {
    const row = await this.db
      .selectFrom('fleet_variants')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst()
    return row ? toVariant(row) : null
  }

  async findById(id: number): Promise<FleetVariant | null> {
    const row = await this.db
      .selectFrom('fleet_variants')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? toVariant(row) : null
  }

  async updateById(id: number, patch: { monthlyCostEur?: number; active?: boolean }): Promise<boolean> {
    if (patch.monthlyCostEur === undefined && patch.active === undefined) return false
    const result = await this.db
      .updateTable('fleet_variants')
      .set({
        ...(patch.monthlyCostEur !== undefined ? { monthly_cost_eur: patch.monthlyCostEur } : {}),
        ...(patch.active !== undefined ? { active: patch.active ? 1 : 0 } : {}),
      })
      .where('id', '=', id)
      .executeTakeFirst()
    return result.numUpdatedRows > 0n
  }

  async upsertByName(name: string, monthlyCostEur: number, active = true): Promise<void> {
    await this.db
      .insertInto('fleet_variants')
      .values({ name, monthly_cost_eur: monthlyCostEur, active: active ? 1 : 0 })
      .onConflict(oc => oc.column('name').doUpdateSet({ monthly_cost_eur: monthlyCostEur, active: active ? 1 : 0 }))
      .execute()
  }
}

function toVariant(row: { id: number; name: string; monthly_cost_eur: number; active: number }): FleetVariant {
  return { id: row.id, name: row.name, monthlyCostEur: row.monthly_cost_eur, active: row.active === 1 }
}
