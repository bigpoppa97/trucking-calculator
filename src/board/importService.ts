import type { Kysely } from 'kysely'
import type { DB, ImportMode } from '../db/schema.js'
import { carrierKey, loadBoardContext, sameCarrier, type BoardContext } from './context.js'
import { readExport, type ExportRow } from './exportReader.js'
import { parsePrz, resolveSwapDate } from './prz.js'
import { parseFerries } from './ferry.js'
import { raiseEventIssue } from './issues.js'

/**
 * Import of the application's order-list export.
 *
 * Each daily file is a snapshot of a date range (the saved view: loading
 * date from 7 days back + future). Orders are matched by order number:
 * new ones are added, changed ones updated with a change log, and fleet
 * orders inside the file's date range that are missing from it are flagged
 * "zniknęło" (never deleted silently).
 *
 * Scope: an order belongs on the board when its subcontractor tractor is a
 * fleet truck on the loading day, or when its PRZ entry names a fleet truck
 * (e.g. an own-fleet order whose second leg one of our trucks drives).
 */

export interface ImportChange {
  field: string
  from: string | null
  to: string | null
}

export interface ImportSummary {
  importId: number
  filename: string
  mode: ImportMode
  importedAt: string
  rowsTotal: number
  rowsInScope: number
  rowsOwnFleet: number
  rowsOtherCarriers: number
  rangeFrom: string | null
  rangeTo: string | null
  created: string[]
  updated: Array<{ orderNo: string; changes: ImportChange[] }>
  unchanged: number
  disappeared: string[]
  reappeared: string[]
  supersededOverrides: Array<{ orderNo: string; field: string }>
  newTruckCandidates: Array<{ plate: string; carrier: string; orders: number }>
  warnings: string[]
}

/** Field → label used in change logs and the UI. */
export const FIELD_LABELS: Record<string, string> = {
  rev_eur: 'stawka klienta',
  cost_eur: 'koszt',
  sub_plate: 'ciągnik',
  trailer_raw: 'naczepa',
  load_places: 'miejsce załadunku',
  load_date: 'data załadunku',
  unload_places: 'miejsce rozładunku',
  unload_date: 'data rozładunku',
  notes_app: 'uwagi',
  status_client: 'status zlecenia',
  status_sped: 'status zl. spedycyjnego',
  carrier: 'przewoźnik',
  client: 'klient',
}

/** Fields whose manual correction shadows an application value. */
const TRACKED_OVERRIDES = new Set(['rev', 'cost', 'trailer', 'prz', 'extra_cost'])

/**
 * The application value a manual correction of `field` shadows. "Koszt dodatkowy"
 * shadows the ferries typed into the notes (PROM entries) — so adding or changing
 * a PROM entry in the application wins over an older manual correction.
 */
export function overrideAppValue(
  field: string,
  v: { rev_eur: number | null; cost_eur: number | null; trailer_raw: string; notes_app: string },
): string | number | null {
  switch (field) {
    case 'rev':
      return v.rev_eur
    case 'cost':
      return v.cost_eur
    case 'trailer':
      return v.trailer_raw
    case 'prz':
      return v.notes_app
    case 'extra_cost':
      return parseFerries(v.notes_app).total
    default:
      return null
  }
}

export async function importExportFile(
  db: Kysely<DB>,
  data: ArrayBuffer | Uint8Array,
  filename: string,
  options: { mode: ImportMode; now?: string },
): Promise<ImportSummary> {
  const { rows, warnings } = await readExport(data)
  const ctx = await loadBoardContext(db)
  return importRows(db, ctx, rows, filename, { ...options, warnings })
}

export async function importRows(
  db: Kysely<DB>,
  ctx: BoardContext,
  rows: ExportRow[],
  filename: string,
  options: { mode: ImportMode; now?: string; warnings?: string[] },
): Promise<ImportSummary> {
  const now = options.now ?? new Date().toISOString()
  const today = now.slice(0, 10)
  const warnings = [...(options.warnings ?? [])]
  if (ctx.fleet.trucks.length === 0) {
    warnings.push('Baza floty jest pusta — dodaj auta w zakładce Flota, inaczej żadne zlecenie nie trafi na tablicę.')
  }

  // De-duplicate by order number (last row wins).
  const byNo = new Map<string, ExportRow>()
  let duplicates = 0
  for (const r of rows) {
    if (byNo.has(r.orderNo)) duplicates++
    byNo.set(r.orderNo, r)
  }
  if (duplicates > 0) warnings.push(`W pliku ${duplicates} numerów zleceń występuje więcej niż raz — wzięto ostatni wiersz.`)

  const dates = rows.map(r => r.loadDate).sort()
  const rangeFrom = dates[0] ?? null
  const rangeTo = dates[dates.length - 1] ?? null

  const carrierKeys = ctx.fleet.carrierKeys()
  const inScope: ExportRow[] = []
  let ownFleet = 0
  let other = 0
  const ownPlatesSeen = new Set<string>()
  const candidates = new Map<string, { carrier: string; orders: number; firstDate: string }>()

  for (const r of byNo.values()) {
    if (r.ownPlate) ownPlatesSeen.add(r.ownPlate)
    const subIsFleet = r.subPlate !== '' && ctx.fleet.truckFor(r.subPlate, r.loadDate) !== null
    let przNamesFleet = false
    const prz = parsePrz(r.notes).entries[0]
    if (prz) {
      const swap = resolveSwapDate(prz.day, prz.month, r.loadDate)
      przNamesFleet =
        ctx.fleet.truckFor(prz.from, r.loadDate) !== null || ctx.fleet.truckFor(prz.to, swap) !== null
    }
    if (subIsFleet || przNamesFleet) {
      inScope.push(r)
      continue
    }
    if (!r.subPlate) ownFleet++
    else {
      other++
      // A carrier we work with runs a tractor that is not in the fleet registry.
      const known = [...carrierKeys].some(k => sameCarrier(k, carrierKey(r.carrier)))
      if (known && !ctx.ignoredPlates.has(r.subPlate) && !ctx.fleet.isFleetPlate(r.subPlate)) {
        const c = candidates.get(r.subPlate) ?? { carrier: r.carrier, orders: 0, firstDate: r.loadDate }
        c.orders++
        if (r.loadDate < c.firstDate) c.firstDate = r.loadDate
        candidates.set(r.subPlate, c)
      }
    }
  }

  const importId = await db.transaction().execute(async trx => {
    const imp = await trx
      .insertInto('board_imports')
      .values({
        filename,
        imported_at: now,
        mode: options.mode,
        rows_total: rows.length,
        rows_in_scope: inScope.length,
        range_from: rangeFrom,
        range_to: rangeTo,
        summary: '{}',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    for (const plate of ownPlatesSeen) {
      await trx
        .insertInto('board_own_plates')
        .values({ plate, last_seen: today })
        .onConflict(oc => oc.column('plate').doUpdateSet({ last_seen: today }))
        .execute()
    }
    return imp.id
  })

  const summary: ImportSummary = {
    importId,
    filename,
    mode: options.mode,
    importedAt: now,
    rowsTotal: rows.length,
    rowsInScope: inScope.length,
    rowsOwnFleet: ownFleet,
    rowsOtherCarriers: other,
    rangeFrom,
    rangeTo,
    created: [],
    updated: [],
    unchanged: 0,
    disappeared: [],
    reappeared: [],
    supersededOverrides: [],
    newTruckCandidates: [...candidates.entries()].map(([plate, c]) => ({ plate, carrier: c.carrier, orders: c.orders })),
    warnings,
  }

  const existing = new Map(
    inScope.length === 0
      ? []
      : (
          await db
            .selectFrom('board_orders')
            .selectAll()
            .where(
              'order_no',
              'in',
              inScope.map(r => r.orderNo),
            )
            .execute()
        ).map(o => [o.order_no, o]),
  )

  await db.transaction().execute(async trx => {
    for (const r of inScope) {
      const values = {
        client: r.client,
        client_ref: r.clientRef,
        status_client: r.statusClient,
        status_sped: r.statusSped,
        carrier: r.carrier,
        sub_plate: r.subPlate,
        own_plate: r.ownPlate,
        trailer_raw: r.trailerRaw,
        load_places: r.loadPlaces,
        load_country: r.loadCountry,
        load_date: r.loadDate,
        unload_places: r.unloadPlaces,
        unload_country: r.unloadCountry,
        unload_date: r.unloadDate,
        rev_eur: r.revEur,
        cost_eur: r.costEur,
        notes_app: r.notes,
      }
      const prev = existing.get(r.orderNo)
      if (!prev) {
        await trx
          .insertInto('board_orders')
          .values({
            order_no: r.orderNo,
            ...values,
            history: options.mode === 'history' ? 1 : 0,
            first_import_id: importId,
            last_import_id: importId,
            missing_since_import_id: null,
            updated_at: now,
          })
          .execute()
        await trx
          .insertInto('board_order_changes')
          .values({ order_no: r.orderNo, import_id: importId, field: 'created', old_value: null, new_value: null, created_at: now })
          .execute()
        summary.created.push(r.orderNo)
        continue
      }

      const changes: ImportChange[] = []
      for (const field of Object.keys(FIELD_LABELS) as Array<keyof typeof values>) {
        const before = prev[field]
        const after = values[field]
        if (String(before ?? '') !== String(after ?? '')) {
          changes.push({ field, from: before === null ? null : String(before), to: after === null ? null : String(after) })
        }
      }
      // A daily import never turns a live order back into history.
      const history = options.mode === 'history' ? prev.history : 0
      await trx
        .updateTable('board_orders')
        .set({ ...values, history, last_import_id: importId, missing_since_import_id: null, updated_at: now })
        .where('order_no', '=', r.orderNo)
        .execute()
      if (prev.missing_since_import_id !== null) summary.reappeared.push(r.orderNo)
      for (const c of changes) {
        await trx
          .insertInto('board_order_changes')
          .values({ order_no: r.orderNo, import_id: importId, field: c.field, old_value: c.from, new_value: c.to, created_at: now })
          .execute()
      }
      if (changes.length > 0) summary.updated.push({ orderNo: r.orderNo, changes })
      else summary.unchanged++

      // The application wins over a manual correction once it changes the same value.
      const overrides = await trx
        .selectFrom('board_overrides')
        .selectAll()
        .where('order_no', '=', r.orderNo)
        .where('active', '=', 1)
        .execute()
      for (const o of overrides) {
        if (!TRACKED_OVERRIDES.has(o.field)) continue
        const appNow = overrideAppValue(o.field, values)
        if (o.app_value !== null && String(appNow ?? '') !== o.app_value) {
          await trx
            .updateTable('board_overrides')
            .set({
              active: 0,
              superseded_at: now,
              superseded_note:
                o.field === 'extra_cost'
                  ? `Prom w uwagach w aplikacji zmienił się z ${o.app_value} € na ${String(appNow ?? '')} €.`
                  : `Aplikacja zmieniła wartość z „${o.app_value}” na „${String(appNow ?? '')}”.`,
            })
            .where('id', '=', o.id)
            .execute()
          summary.supersededOverrides.push({ orderNo: r.orderNo, field: o.field })
        }
      }
    }

    // Disappeared: live fleet orders inside the file's date range that the file no longer has.
    if (options.mode === 'daily' && rangeFrom && rangeTo) {
      const present = new Set(byNo.keys())
      const candidatesMissing = await trx
        .selectFrom('board_orders')
        .select(['order_no', 'missing_since_import_id'])
        .where('history', '=', 0)
        .where('load_date', '>=', rangeFrom)
        .where('load_date', '<=', rangeTo)
        .execute()
      for (const o of candidatesMissing) {
        if (present.has(o.order_no)) continue
        // Still in the file but no longer ours (e.g. reassigned to another carrier) is also "gone".
        if (o.missing_since_import_id === null) {
          await trx
            .updateTable('board_orders')
            .set({ missing_since_import_id: importId, updated_at: now })
            .where('order_no', '=', o.order_no)
            .execute()
          summary.disappeared.push(o.order_no)
        }
      }
    }

    await trx
      .updateTable('board_imports')
      .set({ summary: JSON.stringify(summary) })
      .where('id', '=', importId)
      .execute()
  })

  // Orders previously on the board that are still in the file but no longer in
  // scope (e.g. moved to a carrier outside the fleet) count as gone as well.
  if (options.mode === 'daily' && byNo.size > 0) {
    const inScopeNos = new Set(inScope.map(r => r.orderNo))
    const stillPresentButMoved = await db
      .selectFrom('board_orders')
      .select(['order_no'])
      .where('history', '=', 0)
      .where('missing_since_import_id', 'is', null)
      .where('last_import_id', '<', importId)
      .where('order_no', 'in', [...byNo.keys()])
      .execute()
    for (const o of stillPresentButMoved) {
      if (inScopeNos.has(o.order_no)) continue
      await db
        .updateTable('board_orders')
        .set({ missing_since_import_id: importId, updated_at: now })
        .where('order_no', '=', o.order_no)
        .execute()
      summary.disappeared.push(o.order_no)
    }
  }

  // Event issues.
  if (options.mode === 'daily') {
    for (const no of summary.disappeared) {
      await raiseEventIssue(
        db,
        {
          key: `DISAPPEARED:${no}`,
          kind: 'DISAPPEARED',
          ref: no,
          message:
            'Zlecenie zniknęło z eksportu albo nie jedzie już autem z floty (anulowane, usunięte lub przepięte do innego przewoźnika).',
          details: { importId },
          fingerprint: String(importId),
        },
        now,
      )
    }
    for (const no of summary.reappeared) {
      await db
        .updateTable('board_issues')
        .set({ status: 'resolved', resolution: 'reappeared', updated_at: now })
        .where('key', '=', `DISAPPEARED:${no}`)
        .where('status', '=', 'open')
        .execute()
    }
    for (const s of summary.supersededOverrides) {
      await raiseEventIssue(
        db,
        {
          key: `OVERRIDE_SUPERSEDED:${s.orderNo}:${s.field}:${importId}`,
          kind: 'OVERRIDE_SUPERSEDED',
          ref: s.orderNo,
          message: `Aplikacja zmieniła wartość, którą poprawiłeś ręcznie (${s.field}). Obowiązuje teraz wartość z aplikacji.`,
          details: { field: s.field },
          fingerprint: String(importId),
        },
        now,
      )
    }
    for (const [plate, c] of candidates) {
      await raiseEventIssue(
        db,
        {
          key: `NEW_TRUCK:${plate}`,
          kind: 'NEW_TRUCK',
          ref: plate,
          message: `Przewoźnik „${c.carrier}” jedzie ciągnikiem spoza bazy floty (${c.orders} ${c.orders === 1 ? 'zlecenie' : 'zleceń'} w pliku).`,
          details: { plate, carrier: c.carrier, orders: c.orders, firstDate: c.firstDate },
          fingerprint: plate,
        },
        now,
      )
    }
  }

  await db
    .updateTable('board_imports')
    .set({ summary: JSON.stringify(summary) })
    .where('id', '=', importId)
    .execute()
  return summary
}
