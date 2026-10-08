import type { Kysely } from 'kysely'
import type { DB, TollRuleType, TollSystemRuleRow } from '../db/schema.js'

/**
 * Correction rules for HERE toll systems that return the wrong tariff
 * (e.g. private A2 gates priced at the oversized category). Maintained by
 * finance/admin in the config screen; applied at parse time so corrected
 * values still land as status=estimate.
 */

export interface TollSystemRule {
  id: number
  tollSystem: string
  ruleType: TollRuleType
  value: number
  note: string | null
  updatedBy: string | null
  updatedAt: string | null
}

function toRule(row: TollSystemRuleRow): TollSystemRule {
  return {
    id: row.id,
    tollSystem: row.toll_system,
    ruleType: row.rule_type,
    value: row.value,
    note: row.note,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }
}

export class TollSystemRuleRepository {
  constructor(private readonly db: Kysely<DB>) {}

  async listAll(): Promise<TollSystemRule[]> {
    const rows = await this.db.selectFrom('toll_system_rules').selectAll().orderBy('toll_system').execute()
    return rows.map(toRule)
  }

  async upsertBySystem(
    input: { tollSystem: string; ruleType: TollRuleType; value: number; note?: string },
    actor: string,
    now: string = new Date().toISOString(),
  ): Promise<TollSystemRule> {
    const values = {
      toll_system: input.tollSystem.trim().toUpperCase(),
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
        oc.column('toll_system').doUpdateSet({
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
}
