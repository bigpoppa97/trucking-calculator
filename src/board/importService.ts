import type { Kysely } from 'kysely'
import type { DB, ImportMode } from '../db/schema.js'
import { carrierKey, loadBoardContext, retiredOn, sameCarrier, type BoardContext } from './context.js'
import { readExport, type ExportRow } from './exportReader.js'
import { parsePrz, resolveSwapDate } from './prz.js'
import { parseFerries } from './ferry.js'
import { fmtDate, raiseEventIssue } from './issues.js'
import { matchDrafts, replaceDraft, type MatchDraft, type MatchOrder } from './drafts.js'
import { splitPlaces } from './normalize.js'
import { formatAt, parseAtValue } from './times.js'

/**
 * Import of the application's order-list export.
 *
 * Each daily file is a snapshot of a date range (the saved view: loading
 * date from 7 days back + future). Orders are matched by order number:
 * new ones are added, changed ones updated with a change log, and fleet
 * orders inside the file's date range that are missing from it are flagged
 * "zniknęło" (never deleted silently) — unless the file is a partial export
 * (a few last-minute orders, a filtered view: at most half of the board's
 * orders of its days), which only adds and updates (26.10.2026).
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
  /** Preliminary orders replaced by an order from this file (12.10.2026). */
  replacedDrafts?: Array<{ draftNo: string; orderNo: string }>
  /** Preliminary orders with more than one possible order — asked in the review queue. */
  draftQuestions?: string[]
  /**
   * Not a full export of its days (26.10.2026): `found` of the board's orders of those days
   * are in the file, `missing` are not — and were not flagged "zniknęło".
   */
  partial?: { found: number; missing: number }
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
  load_time: 'godzina załadunku',
  unload_time: 'godzina rozładunku',
}

/** Hours: the first time a file brings them is not a change in the application. */
const TIME_FIELDS = new Set(['load_time', 'unload_time'])

/** Fields whose manual correction shadows an application value. */
const TRACKED_OVERRIDES = new Set(['rev', 'cost', 'trailer', 'prz', 'extra_cost', 'load_at', 'unload_at'])

/**
 * The application value a manual correction of `field` shadows. "Koszt dodatkowy"
 * shadows the ferries typed into the notes (PROM entries) — so adding or changing
 * a PROM entry in the application wins over an older manual correction.
 */
export function overrideAppValue(
  field: string,
  v: {
    rev_eur: number | null
    cost_eur: number | null
    trailer_raw: string
    notes_app: string
    load_date: string
    load_time?: string | null | undefined
    unload_date: string
    unload_time?: string | null | undefined
  },
): string | number | null {
  switch (field) {
    case 'load_at':
      return formatAt({ date: v.load_date, time: v.load_time ?? null })
    case 'unload_at':
      return formatAt({ date: v.unload_date, time: v.unload_time ?? null })
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

/**
 * Did the application change the value a manual correction shadows? For loading/unloading
 * a correction made before the file had hours compares the day only (the hour appearing
 * for the first time is not a change).
 */
export function appValueChanged(field: string, stored: string, now: string | number | null): boolean {
  const current = String(now ?? '')
  if (field === 'load_at' || field === 'unload_at') {
    const a = parseAtValue(stored)
    const b = parseAtValue(current)
    if (a && b && a.time === null) return a.date !== b.date
  }
  return current !== stored
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
  const candidates = new Map<string, { carrier: string; orders: number; firstDate: string; retiredTruckId?: number; retiredOn?: string }>()

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
      // A carrier we work with runs a tractor that is not in the fleet registry — or a
      // tractor withdrawn from the department gets an order after its last day (26.10.2026).
      const known = [...carrierKeys].some(k => sameCarrier(k, carrierKey(r.carrier)))
      const owner = ctx.fleet.trucks.find(t => t.plates.some(p => p.plate === r.subPlate))
      const ownerRetired = owner ? retiredOn(owner) : null
      const retiredAfter = owner !== undefined && ownerRetired !== null && r.loadDate > ownerRetired
      if (!ctx.ignoredPlates.has(r.subPlate) && ((known && !owner) || retiredAfter)) {
        const c = candidates.get(r.subPlate) ?? {
          carrier: r.carrier,
          orders: 0,
          firstDate: r.loadDate,
          ...(retiredAfter ? { retiredTruckId: owner.id, retiredOn: ownerRetired } : {}),
        }
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
        // No hours column in the file → keep what the board already knows.
        load_time: r.loadTime === undefined ? (existing.get(r.orderNo)?.load_time ?? null) : r.loadTime,
        unload_time: r.unloadTime === undefined ? (existing.get(r.orderNo)?.unload_time ?? null) : r.unloadTime,
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
        if (TIME_FIELDS.has(field) && (before === null || before === undefined)) continue
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
        if (o.app_value !== null && appValueChanged(o.field, o.app_value, appNow)) {
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
      const inRange = await trx
        .selectFrom('board_orders')
        .select(['order_no', 'missing_since_import_id'])
        .where('history', '=', 0)
        .where('draft', '=', 0) // preliminary orders are never in the export
        .where('load_date', '>=', rangeFrom)
        .where('load_date', '<=', rangeTo)
        .execute()
      const missing = inRange.filter(o => !present.has(o.order_no))
      const found = inRange.length - missing.length
      // A small file (a few last-minute orders) or one filtered to a carrier is not the
      // whole picture of its days (26.10.2026): when it has at most half of the board's
      // orders of those days, nothing is flagged — the next full export does the check.
      if (missing.length > 0 && missing.length >= found) summary.partial = { found, missing: missing.length }
      for (const o of summary.partial ? [] : missing) {
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
      .where('draft', '=', 0)
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

  // Preliminary orders replaced by new orders of this file.
  if (options.mode === 'daily' && summary.created.length > 0) {
    await replaceDraftsFromImport(db, ctx, inScope, summary, importId, now)
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
          message: `Aplikacja zmieniła wartość, którą poprawiłeś ręcznie (${OVERRIDE_FIELD_LABELS[s.field] ?? s.field}). Obowiązuje teraz wartość z aplikacji.`,
          details: { field: s.field },
          fingerprint: String(importId),
        },
        now,
      )
    }
    for (const [plate, c] of candidates) {
      const count = `${c.orders} ${c.orders === 1 ? 'zlecenie' : 'zleceń'} w pliku`
      await raiseEventIssue(
        db,
        {
          key: `NEW_TRUCK:${plate}`,
          kind: 'NEW_TRUCK',
          ref: plate,
          message: c.retiredOn
            ? `Ciągnik ${plate} jest wycofany z działu (ostatni dzień ${fmtDate(c.retiredOn)}), a ma zlecenia po tym dniu (${count}, od ${fmtDate(c.firstDate)}). Te zlecenia nie są na tablicy.`
            : `Przewoźnik „${c.carrier}” jedzie ciągnikiem spoza bazy floty (${count}).`,
          details: {
            plate,
            carrier: c.carrier,
            orders: c.orders,
            firstDate: c.firstDate,
            ...(c.retiredOn ? { retiredTruckId: c.retiredTruckId, retiredOn: c.retiredOn } : {}),
          },
          fingerprint: plate,
        },
        now,
      )
    }
  }

  await db
    .updateTable('board_imports')
    .set({ summary: JSON.stringify(summary), partial: summary.partial ? 1 : 0 })
    .where('id', '=', importId)
    .execute()
  return summary
}

/** Names of manual corrections in messages and the order history. */
export const OVERRIDE_FIELD_LABELS: Record<string, string> = {
  rev: 'stawka klienta',
  cost: 'koszt przewoźnika',
  extra_cost: 'koszt dodatkowy',
  trailer: 'naczepa',
  prz: 'przepinka',
  exclude: 'wyłączenie z wyników',
  km_total: 'km razem',
  'km_total:1': 'km razem, 2. odcinek',
  km_loaded: 'km z ładunkiem',
  km_empty: 'km puste',
  'km_loaded:1': 'km z ładunkiem, 2. odcinek',
  'km_empty:1': 'km puste, 2. odcinek',
  driver: 'kierowca',
  'driver:1': 'kierowca, 2. odcinek',
  load_at: 'załadunek',
  unload_at: 'rozładunek',
}

/** Short label of an order for history lines: "W-3 (Wiedeń → Wilno, 13.10)". */
export function draftLabel(orderNo: string, loadPlaces: string, unloadPlaces: string, loadDate: string, ctx: BoardContext): string {
  const name = (raw: string) => {
    const code = ctx.places.resolve(raw)
    return code ? ctx.places.name(code) : raw
  }
  const loads = splitPlaces(loadPlaces).map(name)
  const unloads = splitPlaces(unloadPlaces).map(name)
  return `${orderNo} (${loads[0] ?? '?'} → ${unloads[unloads.length - 1] ?? '?'}, ${loadDate.slice(8, 10)}.${loadDate.slice(5, 7)})`
}

async function replaceDraftsFromImport(
  db: Kysely<DB>,
  ctx: BoardContext,
  inScope: ExportRow[],
  summary: ImportSummary,
  importId: number,
  now: string,
): Promise<void> {
  const draftRows = await db
    .selectFrom('board_orders')
    .select(['order_no', 'draft_truck_id', 'load_date', 'load_places', 'unload_places'])
    .where('draft', '=', 1)
    .execute()
  if (draftRows.length === 0) return
  const firstPlace = (raw: string) => {
    const first = splitPlaces(raw)[0]
    return first ? ctx.places.resolve(first) : null
  }
  const created = new Set(summary.created)
  const orders: MatchOrder[] = inScope
    .filter(r => created.has(r.orderNo))
    .map(r => {
      const trucks = new Set<number>()
      const sub = ctx.fleet.truckFor(r.subPlate, r.loadDate)
      if (sub) trucks.add(sub.id)
      const prz = parsePrz(r.notes).entries[0]
      if (prz) {
        const a = ctx.fleet.truckFor(prz.from, r.loadDate)
        const b = ctx.fleet.truckFor(prz.to, resolveSwapDate(prz.day, prz.month, r.loadDate))
        if (a) trucks.add(a.id)
        if (b) trucks.add(b.id)
      }
      return { orderNo: r.orderNo, truckIds: [...trucks], loadDate: r.loadDate, firstPlace: firstPlace(r.loadPlaces) }
    })
  const drafts: MatchDraft[] = draftRows.map(d => ({ orderNo: d.order_no, truckId: d.draft_truck_id, loadDate: d.load_date, firstPlace: firstPlace(d.load_places) }))
  const matches = matchDrafts(orders, drafts)
  summary.replacedDrafts = []
  summary.draftQuestions = []
  for (const m of matches.auto) {
    const d = draftRows.find(x => x.order_no === m.draftNo)!
    await replaceDraft(db, m.draftNo, m.orderNo, draftLabel(m.draftNo, d.load_places, d.unload_places, d.load_date, ctx), now)
    summary.replacedDrafts.push(m)
  }
  for (const q of matches.ambiguous) {
    await raiseEventIssue(
      db,
      {
        key: `DRAFT_MATCH:${q.draftNo}`,
        kind: 'DRAFT_MATCH',
        ref: q.draftNo,
        message: `Zlecenie wstępne ${q.draftNo} pasuje do kilku nowych zleceń z aplikacji (${q.candidates.join(', ')}). Które je zastępuje?`,
        details: { candidates: q.candidates, importId },
        fingerprint: q.candidates.join(','),
      },
      now,
    )
    summary.draftQuestions.push(q.draftNo)
  }
}
