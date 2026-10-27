import type { Kysely, Selectable } from 'kysely'
import type { BoardOrdersTable, DB } from '../db/schema.js'
import type { BoardContext } from './context.js'
import { DistanceService, type DistanceResult } from './distances.js'
import { parsePrz, resolveSwapDate, type PrzEntry } from './prz.js'
import { parseFerries } from './ferry.js'
import { parseNumberInput } from './amount.js'
import { normalizePlate, splitPlaces } from './normalize.js'
import { parseAtValue } from './times.js'

/**
 * Turns imported orders (+ manual corrections) into what the board shows:
 * legs per truck, margins and kilometres.
 *
 * Rules (agreed with the department, see the spec in the project):
 *  - margin = client rate − sum of the amounts the trucks get; counted whole
 *  - a PRZ entry splits the order into two legs at the swap place/date; the
 *    amounts in the entry are what each truck gets
 *  - status A (client) = cancelled, N = unconfirmed → shown, not counted
 *  - status A on the forwarding order without PRZ = the truck does not carry it
 *    (noCarrier): off the week board, out of results, no review item
 *  - PROM <amount> in the notes = ferry paid by the department → extra cost
 *    (lowers the margin); a manual "Koszt dodatkowy" correction replaces it
 *  - km loaded = along the leg's stops; km empty = from the truck's previous
 *    unloading (or a day event with a place, e.g. "Pozycja auta") to this leg's first stop
 *  - loading/unloading date and hour: from the export, unless corrected on the
 *    board ("load_at" / "unload_at"); a corrected loading date moves the order
 *    to that day everywhere (12.10.2026)
 *  - a preliminary order (draft, "W-…") runs on the truck it was entered for;
 *    without both rates its money is left out of the totals (km still count)
 */

export type LegKind = 'fleet' | 'own' | 'other'
export type Exclusion = 'cancelled' | 'unconfirmed' | 'manual' | null

export interface Stop {
  raw: string
  code: string | null
}

export interface ComputedLeg {
  orderNo: string
  index: number
  truckId: number | null
  plate: string
  kind: LegKind
  startDate: string
  endDate: string
  /** Hour at the start / end of the leg ("HH:MM"), null = unknown (e.g. at a PRZ swap). */
  startTime: string | null
  endTime: string | null
  stops: Stop[]
  amount: number | null
  revAlloc: number | null
  trailer: string | null
  trailerRaw: string
  trailerKnown: boolean
  kmLoaded: number | null
  kmEmpty: number | null
  kmEmptyFrom: string | null
  kmEstimated: boolean
  /** Km corrected by hand ("Km razem", or the older loaded / empty corrections). */
  kmManual: boolean
  przRole: 'none' | 'from' | 'to'
}

export interface ComputedPrz {
  place: string
  placeCode: string | null
  date: string
  from: string
  to: string
  amountFrom: number
  amountTo: number
  raw: string
}

export interface OverrideInfo {
  value: string
  appValue: string | null
  createdAt: string
  createdBy: string
}

export interface ComputedOrder {
  orderNo: string
  client: string
  clientRef: string
  carrier: string
  statusClient: string
  statusSped: string
  subPlate: string
  ownPlate: string
  /** Effective dates and hours (a manual correction wins over the export). */
  loadDate: string
  unloadDate: string
  loadTime: string | null
  unloadTime: string | null
  loadAtManual: boolean
  unloadAtManual: boolean
  loadPlaces: string
  unloadPlaces: string
  /** Preliminary order typed on the board (12.10.2026). */
  draft: boolean
  /** Draft without the client rate or the carrier amount: its money stays out of the totals. */
  draftNoMoney: boolean
  rev: number | null
  costApp: number | null
  cost: number | null
  /** Effective extra cost: the manual correction if any, else the ferries from the notes. */
  extraCost: number
  /** True when extraCost comes from a manual correction. */
  extraCostManual: boolean
  /** Ferry costs read from the notes (PROM entries), whatever the manual correction says. */
  ferryCost: number
  ferryEntries: string[]
  ferryErrors: string[]
  amountsTotal: number | null
  margin: number | null
  marginPct: number | null
  excluded: Exclusion
  noCarrier: boolean
  notesApp: string
  prz: ComputedPrz | null
  przErrors: string[]
  przExtraEntries: number
  legs: ComputedLeg[]
  overrides: Record<string, OverrideInfo>
  missing: boolean
  history: boolean
  hasFleetLeg: boolean
  /**
   * The export's truck is a fleet truck on the loading day — the order belongs to the
   * department even when a PRZ entry leaves no leg on a fleet truck (27.10.2026: a mistyped
   * plate made such an order vanish without a review item).
   */
  fleetByExport: boolean
}

export interface ComputeWindow {
  from: string
  to: string
}

/** Loads orders overlapping the window and computes legs, margins and km. */
export async function computeOrders(
  db: Kysely<DB>,
  ctx: BoardContext,
  distances: DistanceService,
  window: ComputeWindow,
  options: { includeHistory?: boolean } = {},
): Promise<ComputedOrder[]> {
  let query = db
    .selectFrom('board_orders')
    .selectAll()
    .where('unload_date', '>=', window.from)
    .where('load_date', '<=', window.to)
  if (!options.includeHistory) query = query.where('history', '=', 0)
  const rows = await query.orderBy('load_date').orderBy('order_no').execute()
  if (rows.length === 0) return []

  const orderNos = rows.map(r => r.order_no)
  const overrideRows = await db
    .selectFrom('board_overrides')
    .selectAll()
    .where('active', '=', 1)
    .where('order_no', 'in', orderNos)
    .orderBy('id')
    .execute()
  const overridesByOrder = new Map<string, Record<string, OverrideInfo>>()
  for (const o of overrideRows) {
    const rec = overridesByOrder.get(o.order_no) ?? {}
    rec[o.field] = { value: o.value, appValue: o.app_value, createdAt: o.created_at, createdBy: o.created_by }
    overridesByOrder.set(o.order_no, rec)
  }

  const orders: ComputedOrder[] = rows.map(row => buildOrder(row, overridesByOrder.get(row.order_no) ?? {}, ctx))

  await attachKilometres(db, ctx, distances, orders, window)
  return orders
}

type OrderRow = Selectable<BoardOrdersTable>

/** Stored manual corrections: also reads older entries typed with a unit ("2350e"). */
function num(value: string | undefined): number | null {
  return parseNumberInput(value)
}

export function buildOrder(row: OrderRow, overrides: Record<string, OverrideInfo>, ctx: BoardContext): ComputedOrder {
  const isDraft = row.draft === 1
  const draftNoMoney = isDraft && (row.rev_eur === null || row.cost_eur === null)
  const rev = draftNoMoney ? null : overrides['rev'] ? num(overrides['rev'].value) : row.rev_eur
  const cost = draftNoMoney ? null : overrides['cost'] ? num(overrides['cost'].value) : row.cost_eur

  // Loading / unloading: manual correction ("YYYY-MM-DD[ HH:MM]") or the export.
  const loadAt = parseAtValue(overrides['load_at']?.value)
  const unloadAt = parseAtValue(overrides['unload_at']?.value)
  const loadDate = loadAt?.date ?? row.load_date
  const loadTime = loadAt ? loadAt.time : (row.load_time ?? null)
  let unloadDate = unloadAt?.date ?? row.unload_date
  let unloadTime = unloadAt ? unloadAt.time : (row.unload_time ?? null)
  if (unloadDate < loadDate) {
    unloadDate = loadDate
    unloadTime = null
  }
  const trailerRaw = overrides['trailer'] ? overrides['trailer'].value : row.trailer_raw
  const przText = overrides['prz'] ? overrides['prz'].value : row.notes_app
  const ferries = parseFerries(przText)
  const extraCostManual = overrides['extra_cost'] !== undefined
  const extraCost = extraCostManual ? (num(overrides['extra_cost']!.value) ?? 0) : ferries.total

  let excluded: Exclusion = null
  if (overrides['exclude']?.value === '1') excluded = 'manual'
  else if (row.status_client === 'A') excluded = 'cancelled'
  else if (row.status_client === 'N') excluded = 'unconfirmed'

  const trailerCanonical = ctx.trailers.canonical(trailerRaw)
  const trailer = trailerCanonical ?? (normalizePlate(trailerRaw) || null)

  const loadStops = ctx.places.resolveList(row.load_places)
  const unloadStops = ctx.places.resolveList(row.unload_places)

  const parsed = parsePrz(przText)
  const entry: PrzEntry | undefined = parsed.entries[0]
  const draftTruck = isDraft && row.draft_truck_id !== null ? ctx.fleet.byId(row.draft_truck_id) : undefined
  const classify = (plate: string, date: string): { kind: LegKind; truckId: number | null } => {
    if (isDraft) return draftTruck ? { kind: 'fleet', truckId: draftTruck.id } : { kind: 'other', truckId: null }
    const truck = ctx.fleet.truckFor(plate, date)
    if (truck) return { kind: 'fleet', truckId: truck.id }
    if (ctx.ownPlates.has(plate)) return { kind: 'own', truckId: null }
    return { kind: 'other', truckId: null }
  }

  const legs: ComputedLeg[] = []
  let prz: ComputedPrz | null = null
  const baseLeg = {
    orderNo: row.order_no,
    trailer,
    trailerRaw,
    // Known = in the fleet on the loading day; a retired trailer goes to review like an unknown one.
    trailerKnown: trailerCanonical !== null && ctx.trailers.isActiveOn(trailerCanonical, row.load_date),
    kmLoaded: null,
    kmEmpty: null,
    kmEmptyFrom: null,
    kmEstimated: false,
    kmManual: false,
    revAlloc: null,
  }

  if (entry) {
    const swapDate = resolveSwapDate(entry.day, entry.month, row.load_date)
    const placeCode = ctx.places.resolve(entry.place)
    prz = {
      place: entry.place,
      placeCode,
      date: swapDate,
      from: entry.from,
      to: entry.to,
      amountFrom: entry.amountFrom,
      amountTo: entry.amountTo,
      raw: entry.raw,
    }
    const swapStop: Stop = { raw: entry.place, code: placeCode }
    const startA = loadDate
    const endA = swapDate < startA ? startA : swapDate
    const startB = endA
    const endB = unloadDate < startB ? startB : unloadDate
    const a = classify(entry.from, startA)
    const b = classify(entry.to, startB)
    legs.push({
      ...baseLeg,
      index: 0,
      truckId: a.truckId,
      plate: entry.from,
      kind: a.kind,
      startDate: startA,
      endDate: endA,
      startTime: loadTime,
      endTime: null,
      stops: [...loadStops, swapStop],
      amount: entry.amountFrom,
      przRole: 'from',
    })
    legs.push({
      ...baseLeg,
      index: 1,
      truckId: b.truckId,
      plate: entry.to,
      kind: b.kind,
      startDate: startB,
      endDate: endB,
      startTime: null,
      endTime: endB === unloadDate ? unloadTime : null,
      stops: [swapStop, ...unloadStops],
      amount: entry.amountTo,
      przRole: 'to',
    })
  } else {
    const c = classify(row.sub_plate, loadDate)
    legs.push({
      ...baseLeg,
      index: 0,
      truckId: c.truckId,
      plate: draftTruck ? ctx.fleet.plateOn(draftTruck, loadDate) : row.sub_plate,
      kind: c.kind,
      startDate: loadDate,
      endDate: unloadDate,
      startTime: loadTime,
      endTime: unloadTime,
      stops: [...loadStops, ...unloadStops],
      amount: cost,
      przRole: 'none',
    })
  }

  const amounts = legs.map(l => l.amount)
  const amountsTotal = amounts.every(a => a !== null)
    ? amounts.reduce<number>((s, a) => s + (a ?? 0), 0) + extraCost
    : null
  const margin = rev !== null && amountsTotal !== null ? round2(rev - amountsTotal) : null
  const marginPct = margin !== null && rev ? round2((margin / rev) * 100) : null

  // Revenue allocation per leg in proportion to the amounts (for per-truck stats).
  if (rev !== null) {
    const sum = legs.reduce((s, l) => s + (l.amount ?? 0), 0)
    for (const l of legs) {
      l.revAlloc = sum > 0 ? round2((rev * (l.amount ?? 0)) / sum) : round2(rev / legs.length)
    }
  }

  return {
    orderNo: row.order_no,
    client: row.client,
    clientRef: row.client_ref,
    carrier: row.carrier,
    statusClient: row.status_client,
    statusSped: row.status_sped,
    subPlate: row.sub_plate,
    ownPlate: row.own_plate,
    loadDate,
    unloadDate,
    loadTime,
    unloadTime,
    loadAtManual: loadAt !== null,
    unloadAtManual: unloadAt !== null,
    loadPlaces: row.load_places,
    unloadPlaces: row.unload_places,
    draft: isDraft,
    draftNoMoney,
    rev,
    costApp: row.cost_eur,
    cost,
    extraCost,
    extraCostManual,
    ferryCost: ferries.total,
    ferryEntries: ferries.entries.map(e => e.raw),
    ferryErrors: ferries.errors,
    amountsTotal,
    margin,
    marginPct,
    excluded,
    noCarrier: row.status_sped === 'A' && !entry,
    notesApp: row.notes_app,
    prz,
    przErrors: parsed.errors,
    przExtraEntries: Math.max(0, parsed.entries.length - 1),
    legs,
    overrides,
    missing: row.missing_since_import_id !== null,
    history: row.history === 1,
    hasFleetLeg: legs.some(l => l.kind === 'fleet'),
    fleetByExport: !isDraft && ctx.fleet.truckFor(row.sub_plate, loadDate) !== null,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Leg order on a truck: by start date, then end date, then order number. */
export function legSort(a: ComputedLeg, b: ComputedLeg): number {
  return (
    a.startDate.localeCompare(b.startDate) ||
    a.endDate.localeCompare(b.endDate) ||
    a.orderNo.localeCompare(b.orderNo) ||
    a.index - b.index
  )
}

async function attachKilometres(
  db: Kysely<DB>,
  ctx: BoardContext,
  distances: DistanceService,
  orders: ComputedOrder[],
  window: ComputeWindow,
): Promise<void> {
  // Only "Pozycja auta" with a place moves the start of the next empty run (spec §6). A place
  // on a note, pause or trailer event is information only (12.10.2026: a test note "TEST · POZ"
  // had silently added ~1500 empty km); services never move it (08.10.2026).
  const positionNotes = await db
    .selectFrom('board_notes')
    .select(['truck_id', 'day', 'place_code'])
    .where('scope', '=', 'truck_day')
    .where('deleted', '=', 0)
    .where('kind', '=', 'position')
    .where('place_code', 'is not', null)
    .where('day', '>=', window.from)
    .where('day', '<=', window.to)
    .execute()

  const byTruck = new Map<number, ComputedLeg[]>()
  for (const order of orders) {
    if (order.excluded === 'cancelled' || order.excluded === 'unconfirmed' || order.excluded === 'manual') continue
    if (order.noCarrier) continue
    for (const leg of order.legs) {
      if (leg.kind !== 'fleet' || leg.truckId === null) continue
      const list = byTruck.get(leg.truckId) ?? []
      list.push(leg)
      byTruck.set(leg.truckId, list)
    }
  }

  const pairs: Array<[string, string]> = []
  const emptyStart = new Map<ComputedLeg, string | null>()
  for (const [truckId, legs] of byTruck) {
    legs.sort(legSort)
    let prevEnd: string | null = null
    let prevEndDate: string | null = null
    for (const leg of legs) {
      let start = prevEnd
      const notes = positionNotes
        .filter(
          n =>
            n.truck_id === truckId &&
            n.day !== null &&
            n.day <= leg.startDate &&
            (prevEndDate === null || n.day >= prevEndDate),
        )
        .sort((a, b) => (a.day ?? '').localeCompare(b.day ?? ''))
      const lastNote = notes[notes.length - 1]
      if (lastNote?.place_code) start = lastNote.place_code
      emptyStart.set(leg, start)
      const first = leg.stops[0]?.code ?? null
      if (start && first) pairs.push([start, first])
      for (let i = 1; i < leg.stops.length; i++) {
        const a = leg.stops[i - 1]?.code
        const b = leg.stops[i]?.code
        if (a && b) pairs.push([a, b])
      }
      const last = leg.stops[leg.stops.length - 1]?.code ?? null
      prevEnd = last ?? prevEnd
      prevEndDate = leg.endDate
    }
  }
  // Loaded km for non-fleet legs is not needed on the board.

  const dist = await distances.getMany(pairs, ctx.places)
  const lookup = (a: string, b: string): DistanceResult | undefined =>
    a === b ? { km: 0, source: 'manual' } : dist.get(DistanceService.key(a, b))

  for (const legs of byTruck.values()) {
    for (const leg of legs) {
      let estimated = false
      let loaded: number | null = 0
      for (let i = 1; i < leg.stops.length; i++) {
        const a = leg.stops[i - 1]?.code
        const b = leg.stops[i]?.code
        if (!a || !b) {
          loaded = null
          break
        }
        const d = lookup(a, b)
        if (!d) {
          loaded = null
          break
        }
        if (d.source === 'estimate') estimated = true
        loaded = (loaded ?? 0) + d.km
      }
      if (leg.stops.some(s => s.code === null)) loaded = null
      const start = emptyStart.get(leg) ?? null
      const first = leg.stops[0]?.code ?? null
      let empty: number | null = null
      if (start && first) {
        const d = lookup(start, first)
        if (d) {
          empty = d.km
          if (d.source === 'estimate') estimated = true
        }
      }
      leg.kmLoaded = loaded === null ? null : Math.round(loaded)
      leg.kmEmpty = empty === null ? null : Math.round(empty)
      leg.kmEmptyFrom = start
      leg.kmEstimated = estimated
    }
  }

  // Manual km corrections per leg (suffix '' or ':0' = leg 0, ':1' = leg 1):
  //  - km_total ("Km razem", 26.10.2026): all km of the truck on the order; the empty run
  //    stays as computed (at most the total), the rest is loaded. Wins over the older pair.
  //  - km_loaded / km_empty: the older corrections (before 26.10.2026), still honoured.
  for (const order of orders) {
    for (const leg of order.legs) {
      const suffix = leg.index === 0 ? ['', ':0'] : [`:${leg.index}`]
      for (const s of suffix) {
        const l = order.overrides[`km_loaded${s}`]
        const e = order.overrides[`km_empty${s}`]
        if (l) {
          leg.kmLoaded = num(l.value)
          leg.kmEstimated = false
          leg.kmManual = true
        }
        if (e) {
          leg.kmEmpty = num(e.value)
          leg.kmManual = true
        }
      }
      for (const s of suffix) {
        const total = order.overrides[`km_total${s}`] ? num(order.overrides[`km_total${s}`]!.value) : null
        if (total === null) continue
        const empty = Math.min(Math.max(leg.kmEmpty ?? 0, 0), total)
        leg.kmEmpty = empty
        leg.kmLoaded = total - empty
        leg.kmEstimated = false
        leg.kmManual = true
      }
    }
  }
}

/**
 * Route of a whole order for the order panel (12.10.2026): every place in the
 * application's order except the last unloading, joined with "+", then "→" and
 * the last unloading — "Warszawa + Katowice (Pyrzowice) → Budapeszt (Vecsés)".
 */
export function routeLabel(loadRaw: string, unloadRaw: string, ctx: BoardContext): string {
  const names = (raw: string) =>
    splitPlaces(raw)
      .map(p => {
        const code = ctx.places.resolve(p)
        return code ? ctx.places.name(code) : p
      })
      .filter((v, i, arr) => arr.indexOf(v) === i)
  const loads = names(loadRaw)
  const unloads = names(unloadRaw)
  const last = unloads[unloads.length - 1]
  if (!last) return `${loads.join(' + ') || '?'} → ?`
  const before = [...loads, ...unloads.slice(0, -1)].filter((v, i, arr) => arr.indexOf(v) === i)
  return `${before.join(' + ') || '?'} → ${last}`
}

/** All place names of an order for display ("Warszawa + Wrocław"). */
export function placesLabel(raw: string, ctx: BoardContext): string {
  return splitPlaces(raw)
    .map(p => {
      const code = ctx.places.resolve(p)
      return code ? ctx.places.name(code) : p
    })
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(' + ')
}
