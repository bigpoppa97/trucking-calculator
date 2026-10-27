import { Kysely, sql } from 'kysely'

/**
 * 27.10.2026 — toll checks (opłaty: przeliczanie, bramki, ostrzeżenia):
 *  - `toll_system_rules.gate_filter`: optional fragment of a gate name (e.g.
 *    'Świecko'). A rule with a filter applies only to that system's tolls whose
 *    gate / fare name contains it and wins over the system-wide rule (the A2
 *    Świecko–Nowy Tomyśl stretch has its own, regulated tariff). The unique key
 *    becomes (toll_system, gate_filter) — '' = the whole system.
 *  - `toll_system_rules.last_matched_at`: when a HERE fetch last applied the rule
 *    ("nigdy" on the config screen exposes a rule whose name never matches).
 *  - `routes.toll_check`: JSON of the last HERE toll check of a stored route —
 *    per-toll items (system, gates, HERE vs corrected EUR, matched rule),
 *    the check warnings and the rule signatures used, so a rule change can tell
 *    which routes are out of date without calling HERE.
 *
 * SQLite cannot drop a column-level UNIQUE, so the rules table is rebuilt.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE toll_system_rules_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      toll_system TEXT NOT NULL,
      gate_filter TEXT NOT NULL DEFAULT '',
      rule_type TEXT NOT NULL CHECK (rule_type IN ('replace_per_gate', 'scale')),
      value NUMERIC NOT NULL,
      note TEXT,
      updated_by TEXT,
      updated_at TEXT,
      last_matched_at TEXT,
      UNIQUE (toll_system, gate_filter)
    )
  `.execute(db)
  await sql`
    INSERT INTO toll_system_rules_new (id, toll_system, gate_filter, rule_type, value, note, updated_by, updated_at)
    SELECT id, toll_system, '', rule_type, value, note, updated_by, updated_at FROM toll_system_rules
  `.execute(db)
  await sql`DROP TABLE toll_system_rules`.execute(db)
  await sql`ALTER TABLE toll_system_rules_new RENAME TO toll_system_rules`.execute(db)

  await db.schema.alterTable('routes').addColumn('toll_check', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('routes').dropColumn('toll_check').execute()
  await sql`
    CREATE TABLE toll_system_rules_old (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      toll_system TEXT NOT NULL UNIQUE,
      rule_type TEXT NOT NULL CHECK (rule_type IN ('replace_per_gate', 'scale')),
      value NUMERIC NOT NULL,
      note TEXT,
      updated_by TEXT,
      updated_at TEXT
    )
  `.execute(db)
  await sql`
    INSERT OR IGNORE INTO toll_system_rules_old (id, toll_system, rule_type, value, note, updated_by, updated_at)
    SELECT id, toll_system, rule_type, value, note, updated_by, updated_at FROM toll_system_rules WHERE gate_filter = ''
  `.execute(db)
  await sql`DROP TABLE toll_system_rules`.execute(db)
  await sql`ALTER TABLE toll_system_rules_old RENAME TO toll_system_rules`.execute(db)
}
