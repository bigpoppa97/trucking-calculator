import type { Kysely } from 'kysely'
import type { DB, TollRuleType, TollSystemRuleRow } from '../db/schema.js'

/**
 * Correction rules for HERE toll systems that return the wrong tariff
 * (e.g. private A2 gates priced at the oversized category). Maintained by
 * finance/admin in the config screen; applied at parse time so corrected
 * values still land as status=estimate.
 *
 * A rule covers a whole system (gateFilter '') or only the system's tolls
 * whose gate name contains gateFilter (e.g. A2 Świecko–Nowy Tomyśl, which has
 * its own regulated tariff) — the gate-specific rule wins (see tollRules.ts).
 */

export interface TollSystemRule {
  id: number
  tollSystem: string
  /** '' = the whole system; otherwise a gate-name fragment. */
  gateFilter: string
  ruleType: TollRuleType
  value: number
  note: string | null
  updatedBy: string | null
  updatedAt: string | null
  /** Last time a HERE fetch applied the rule; null = never matched. */
  lastMatchedAt: string | null
}

function toRule(row: TollSystemRuleRow): TollSystemRule {
  return {
    id: row.id,
    tollSystem: row.toll_system,
    gateFilter: row.gate_filter,
    ruleType: row.rule_type,
    value: Number(row.value),
    note: row.note,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    lastMatchedAt: row.last_matched_at,
  }
}

export class TollSystemRuleRepository {
  constructor(private readonly db: Kysely<DB>) {}

  async listAll(): Promise<TollSystemRule[]> {
    const rows = await this.db
      .selectFrom('toll_system_rules')
      .selectAll()
      .orderBy('toll_system')
      .orderBy('gate_filter')
      .execute()
    return rows.map(toRule)
  }

  /** Same system + same gate filter overwrites; a new gate filter adds a rule. */
  async upsertBySystem(
    input: { tollSystem: string; gateFilter?: string; ruleType: TollRuleType; value: number; note?: string },
    actor: string,
    now: string = new Date().toISOString(),
  ): Promise<TollSystemRule> {
    const values = {
      toll_system: input.tollSystem.trim().replace(/\s+/g, ' ').toUpperCase(),
      gate_filter: (input.gateFilter ?? '').trim().replace(/\s+/g, ' '),
      rule_type: input.ruleType,
      value: input.value,
      note: input.note?.trim() || null,
      updated_by: actor,
      updated_at: now,
    }
    const row = await this.db
      .insertInto('toll_system_rules')
      .values(values)
      .onConflict(oc =>
        oc.columns(['toll_system', 'gate_filter']).doUpdateSet({
          rule_type: values.rule_type,
          value: values.value,
          note: values.note,
          updated_by: values.updated_by,
          updated_at: values.updated_at,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow()
    return toRule(row)
  }

  async deleteById(id: number): Promise<boolean> {
    const result = await this.db.deleteFrom('toll_system_rules').where('id', '=', id).executeTakeFirst()
    return Number(result.numDeletedRows ?? 0) > 0
  }

  /** Stamp the rules a HERE fetch just applied ("Ostatnio zastosowana"). */
  async markMatched(ids: number[], now: string = new Date().toISOString()): Promise<void> {
    if (ids.length === 0) return
    await this.db.updateTable('toll_system_rules').set({ last_matched_at: now }).where('id', 'in', ids).execute()
  }
}
