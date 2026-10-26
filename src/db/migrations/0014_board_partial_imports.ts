import type { Kysely } from 'kysely'

/**
 * 26.10.2026 (paczka 26.10):
 *  - `board_imports.partial`: 1 = a partial export (a few last-minute orders, or a
 *    view filtered to one carrier) — at most half of the board's orders of the
 *    file's days are in it. Such a file only adds and updates; nothing is flagged
 *    "zniknęło" (the next full export does that check).
 *  - One-time clean-up: earlier imports are classified by the same rule (orders on
 *    the board now in the file's days vs. fleet orders in the file). Orders flagged
 *    "zniknęło" by a partial file come back, unless a later full export of their day
 *    lacked them too (then that export is the one that flagged them).
 *  - "New tractor" review items about a plate that has since been added to the fleet
 *    are closed (they stayed open when the plate was added in Flota).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('board_imports')
    .addColumn('partial', 'integer', col => col.notNull().defaultTo(0))
    .execute()

  const now = new Date().toISOString()
  const imports = (await db
    .selectFrom('board_imports')
    .select(['id', 'mode', 'rows_in_scope', 'range_from', 'range_to'])
    .orderBy('id')
    .execute()) as Array<{ id: number; mode: string; rows_in_scope: number; range_from: string | null; range_to: string | null }>

  const partial = new Map<number, { found: number; missing: number }>()
  for (const imp of imports) {
    if (imp.mode !== 'daily' || !imp.range_from || !imp.range_to) continue
    const row = (await db
      .selectFrom('board_orders')
      .select(eb => eb.fn.countAll().as('n'))
      .where('history', '=', 0)
      .where('draft', '=', 0)
      .where('load_date', '>=', imp.range_from)
      .where('load_date', '<=', imp.range_to)
      .executeTakeFirst()) as { n: number | bigint } | undefined
    const onBoard = Number(row?.n ?? 0)
    const found = Math.min(Number(imp.rows_in_scope), onBoard)
    const missing = onBoard - found
    if (missing > 0 && missing >= found) partial.set(imp.id, { found, missing })
  }
  for (const [id, counts] of partial) {
    // The stored summary ("Ostatni import" card) tells it too; its "zniknęło" no longer stand (see below).
    const row = (await db.selectFrom('board_imports').select('summary').where('id', '=', id).executeTakeFirst()) as { summary: string } | undefined
    let summary: Record<string, unknown> = {}
    try {
      summary = JSON.parse(row?.summary ?? '{}') as Record<string, unknown>
    } catch {
      summary = {}
    }
    await db
      .updateTable('board_imports')
      .set({ partial: 1, summary: JSON.stringify({ ...summary, disappeared: [], partial: counts }) })
      .where('id', '=', id)
      .execute()
  }

  if (partial.size > 0) {
    const flagged = (await db
      .selectFrom('board_orders')
      .select(['order_no', 'load_date', 'last_import_id', 'missing_since_import_id'])
      .where('missing_since_import_id', 'in', [...partial.keys()])
      .execute()) as Array<{ order_no: string; load_date: string; last_import_id: number; missing_since_import_id: number }>
    for (const o of flagged) {
      const fullLater = imports.find(
        i =>
          i.id > o.last_import_id &&
          i.mode === 'daily' &&
          !partial.has(i.id) &&
          i.range_from !== null &&
          i.range_to !== null &&
          i.range_from <= o.load_date &&
          o.load_date <= i.range_to,
      )
      if (fullLater) {
        await db.updateTable('board_orders').set({ missing_since_import_id: fullLater.id }).where('order_no', '=', o.order_no).execute()
        continue
      }
      await db.updateTable('board_orders').set({ missing_since_import_id: null, updated_at: now }).where('order_no', '=', o.order_no).execute()
      await db
        .updateTable('board_issues')
        .set({ status: 'resolved', resolution: 'partial_import', resolved_by: 'tablica', updated_at: now })
        .where('key', '=', `DISAPPEARED:${o.order_no}`)
        .where('status', '=', 'open')
        .execute()
    }
  }

  const fleetPlates = (await db.selectFrom('board_truck_plates').select('plate').execute()) as Array<{ plate: string }>
  if (fleetPlates.length > 0) {
    await db
      .updateTable('board_issues')
      .set({ status: 'resolved', resolution: 'added', resolved_by: 'tablica', updated_at: now })
      .where('kind', '=', 'NEW_TRUCK')
      .where('status', '=', 'open')
      .where('ref', 'in', [...new Set(fleetPlates.map(p => p.plate))])
      .execute()
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // The clean-up of "zniknęło" flags is not undone (the next full export re-checks anyway).
  await db.schema.alterTable('board_imports').dropColumn('partial').execute()
}
