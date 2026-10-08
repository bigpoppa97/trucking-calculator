import { Kysely, sql } from 'kysely'

/**
 * Finance-maintained correction rules for HERE toll systems whose fares come
 * back at the wrong tariff. Discovered defect: HERE prices the private A2
 * (AMBERONE / Autostrada Wielkopolska) gates at the "category 5" oversized
 * rate (400–440 PLN/gate) for a 5-axle 40 t semi, which is really AWSA
 * category 4 (>3 axles, 105 PLN/gate as of 2026-03) — a ~3× overestimate.
 *
 * Rules match on HERE's tollSystem name and either replace the per-gate
 * price (in the fare's original currency, converted with the fare's own FX
 * ratio) or scale the fare by a factor. Corrected values stay status=estimate.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('toll_system_rules')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('toll_system', 'text', col => col.notNull().unique())
    .addColumn('rule_type', 'text', col =>
      col.notNull().check(sql`rule_type IN ('replace_per_gate', 'scale')`),
    )
    .addColumn('value', 'numeric', col => col.notNull())
    .addColumn('note', 'text')
    .addColumn('updated_by', 'text')
    .addColumn('updated_at', 'text')
    .execute()

  await db
    .insertInto('toll_system_rules')
    .values({
      toll_system: 'A2 AUTOSTRADA WIELKOPOLSKA',
      rule_type: 'replace_per_gate',
      value: 105,
      note: 'AWSA kat. 4 (>3 osie): 105 PLN/bramka od 2026-03. HERE błędnie zwraca stawkę kat. 5 (400–440 PLN).',
      updated_by: 'migration-seed',
      updated_at: new Date().toISOString(),
    })
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('toll_system_rules').execute()
}
