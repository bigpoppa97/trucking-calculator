import type { Kysely } from 'kysely'
import type { DB, ImportMode, NoteKind } from '../db/schema.js'
import { computeOrders, placesLabel, type ComputedLeg, type ComputedOrder } from './compute.js'
import { loadBoardContext, type BoardContext } from './context.js'
import type { DistanceService } from './distances.js'
import { importExportFile, FIELD_LABELS, type ImportSummary } from './importService.js'
import { DEFAULT_THRESHOLDS, deriveIssues, fmtDate, syncDerivedIssues, type IssueThresholds } from './issues.js'
import { addDays, aliasKey, isoWeekNumber, normalizePlate, weekStart } from './normalize.js'

/**
 * Application service for the board: week view, order details, notes,
 * manual corrections, the review queue and the registries (fleet, trailers,
 * places). The HTTP layer is a thin wrapper around this class.
 */

export class BoardError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'BoardError'
  }
}

export const OVERRIDE_FIELDS = ['rev', 'cost', 'extra_cost', 'trailer', 'prz', 'exclude', 'km_loaded', 'km_empty', 'km_loaded:1', 'km_empty:1'] as const
export type OverrideField = (typeof OVERRIDE_FIELDS)[number]

const NOTE_KINDS: NoteKind[] = ['note', 'pause', 'service', 'driver', 'trailer', 'position']

export interface WeekBar {
  key: string
  orderNo: string
  legIndex: number
  legCount: number
  title: string
  startDate: string
  endDate: string
  /** Day index in the week, clipped: -1 = started before Monday, 7 = ends after Sunday. */
  startDay: number
  endDay: number
  revAlloc: number | null
  amount: number | null
  margin: number | null
  kmLoaded: number | null
  kmEmpty: number | null
  kmEstimated: boolean
  prz: boolean
  issue: boolean
  excluded: string | null
  missing: boolean
  noCarrier: boolean
  inWeek: boolean
  noteLines: string[]
}

export interface WeekEvent {
  id: number | null
  day: string
  kind: NoteKind
  text: string
  auto: boolean
}

export interface WeekTruck {
  id: number
  plate: string
  carrier: string
  driver: string
  phone: string
  trailer: string | null
  trailerTypePl: string
  trailerTypeEn: string
  copyText: string
  bars: WeekBar[]
  events: WeekEvent[]
  totals: { revenue: number; cost: number; margin: number; km: number; kmEmpty: number; legs: number; kmEstimated: boolean }
}

export interface WeekView {
  weekStart: string
  weekEnd: string
  weekNumber: number
  days: string[]
  today: string
  trucks: WeekTruck[]
  kpis: {
    margin: number
    revenue: number
    cost: number
    orders: number
    km: number
    kmEmpty: number
    revenuePerKm: number | null
    costPerKm: number | null
    kmEstimated: boolean
    openIssues: number
  }
  lastImport: { importedAt: string; filename: string } | null
}

export interface BoardServiceOptions {
  actor?: string
  now?: () => string
}

export class BoardService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly distances: DistanceService,
    private readonly options: BoardServiceOptions = {},
  ) {}

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString()
  }

  private actor(): string {
    return this.options.actor ?? 'tablica'
  }

  /** Same service, with notes/corrections/resolutions signed by the given user. */
  withActor(actor: string): BoardService {
    return new BoardService(this.db, this.distances, { ...this.options, actor })
  }

  async thresholds(): Promise<IssueThresholds> {
    const rows = await this.db
      .selectFrom('config')
      .selectAll()
      .where('key', 'in', ['board_margin_warn_pct', 'board_rev_per_km_min', 'board_rev_per_km_max'])
      .execute()
    const get = (k: string, d: number) => {
      const v = Number(rows.find(r => r.key === k)?.value)
      return Number.isFinite(v) ? v : d
    }
    return {
      marginWarnPct: get('board_margin_warn_pct', DEFAULT_THRESHOLDS.marginWarnPct),
      revPerKmMin: get('board_rev_per_km_min', DEFAULT_THRESHOLDS.revPerKmMin),
      revPerKmMax: get('board_rev_per_km_max', DEFAULT_THRESHOLDS.revPerKmMax),
    }
  }

  // ---------------------------------------------------------------- import

  async importFile(data: ArrayBuffer | Uint8Array, filename: string, mode: ImportMode): Promise<ImportSummary> {
    const summary = await importExportFile(this.db, data, filename, { mode, now: this.now() })
    if (summary.rangeFrom && summary.rangeTo) {
      // Computing the affected range queues distances for any new pairs.
      const ctx = await loadBoardContext(this.db)
      await computeOrders(this.db, ctx, this.distances, {
        from: addDays(summary.rangeFrom, -21),
        to: addDays(summary.rangeTo, 14),
      })
    }
    await this.refreshIssues()
    return summary
  }

  async imports(limit = 20) {
    const rows = await this.db.selectFrom('board_imports').selectAll().orderBy('id', 'desc').limit(limit).execute()
    return rows.map(r => ({ ...r, summary: JSON.parse(r.summary) as ImportSummary }))
  }

  // ---------------------------------------------------------------- issues

  async refreshIssues(): Promise<void> {
    const ctx = await loadBoardContext(this.db)
    const today = this.now().slice(0, 10)
    const orders = await computeOrders(this.db, ctx, this.distances, {
      from: addDays(today, -45),
      to: addDays(today, 60),
    })
    await syncDerivedIssues(this.db, deriveIssues(orders, ctx, await this.thresholds()), this.now())
  }

  async listIssues(status: 'open' | 'all' = 'open') {
    let q = this.db.selectFrom('board_issues').selectAll()
    if (status === 'open') q = q.where('status', '=', 'open')
    const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(500).execute()
    return rows.map(r => ({ ...r, details: JSON.parse(r.details) as Record<string, unknown> }))
  }

  /**
   * Resolve a review item. `action` depends on the kind:
   *  - any:              dismiss (derived → ignored until the values change)
   *  - UNKNOWN_TRAILER:  alias {trailer} | new {plate?, typePl?, typeEn?}
   *  - UNKNOWN_PLACE / PRZ_PLACE_UNKNOWN: alias {code} | new {code, name, lat, lon, country}
   *  - NEW_TRUCK:        new-plate {truckId, validFrom} | add-truck {carrier?} | ignore
   *  - MISSING_TRAILER:  set {trailer}
   *  - DISAPPEARED:      keep | delete
   */
  async resolveIssue(id: number, action: string, payload: Record<string, unknown>): Promise<void> {
    const issue = await this.db.selectFrom('board_issues').selectAll().where('id', '=', id).executeTakeFirst()
    if (!issue) throw new BoardError('ISSUE_NOT_FOUND', 'Nie ma takiej pozycji do sprawdzenia.', 404)
    const details = JSON.parse(issue.details) as Record<string, unknown>
    const now = this.now()
    const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string).trim() : '')
    const done = async (resolution: string, status: 'resolved' | 'ignored' = 'resolved') => {
      await this.db
        .updateTable('board_issues')
        .set({ status, resolution, resolved_by: this.actor(), updated_at: now })
        .where('id', '=', id)
        .execute()
    }

    switch (`${issue.kind}:${action}`) {
      case 'UNKNOWN_TRAILER:alias': {
        const trailer = normalizePlate(str('trailer'))
        if (!(await this.db.selectFrom('board_trailers').select('plate').where('plate', '=', trailer).executeTakeFirst())) {
          throw new BoardError('TRAILER_NOT_FOUND', `Naczepy ${trailer} nie ma w bazie.`)
        }
        await this.addTrailerAlias(String(details['raw'] ?? issue.ref), trailer)
        await done(`alias:${trailer}`)
        break
      }
      case 'UNKNOWN_TRAILER:new': {
        const plate = normalizePlate(str('plate') || String(details['raw'] ?? issue.ref))
        await this.upsertTrailer({ plate, typePl: str('typePl') || undefined, typeEn: str('typeEn') || undefined })
        await this.addTrailerAlias(String(details['raw'] ?? issue.ref), plate)
        await done(`new:${plate}`)
        break
      }
      case 'UNKNOWN_PLACE:alias':
      case 'PRZ_PLACE_UNKNOWN:alias': {
        const code = str('code').toUpperCase()
        if (!(await this.db.selectFrom('board_places').select('code').where('code', '=', code).executeTakeFirst())) {
          throw new BoardError('PLACE_NOT_FOUND', `Nie ma miejsca o kodzie ${code}.`)
        }
        await this.addPlaceAlias(String(details['raw'] ?? issue.ref), code)
        await done(`alias:${code}`)
        break
      }
      case 'UNKNOWN_PLACE:new':
      case 'PRZ_PLACE_UNKNOWN:new': {
        const code = await this.createPlace({
          code: str('code'),
          name: str('name') || String(details['raw'] ?? issue.ref),
          country: str('country'),
          lat: Number(payload['lat']),
          lon: Number(payload['lon']),
        })
        await this.addPlaceAlias(String(details['raw'] ?? issue.ref), code)
        await done(`new:${code}`)
        break
      }
      case 'NEW_TRUCK:new-plate': {
        const truckId = Number(payload['truckId'])
        const validFrom = str('validFrom') || String(details['firstDate'] ?? now.slice(0, 10))
        await this.addTruckPlate(truckId, issue.ref, validFrom)
        await done(`plate:${truckId}`)
        break
      }
      case 'NEW_TRUCK:add-truck': {
        await this.createTruck({
          plate: issue.ref,
          validFrom: String(details['firstDate'] ?? now.slice(0, 10)),
          carrier: str('carrier') || String(details['carrier'] ?? ''),
        })
        await done('added')
        break
      }
      case 'NEW_TRUCK:ignore': {
        await this.db
          .insertInto('board_ignored_plates')
          .values({ plate: issue.ref, reason: String(details['carrier'] ?? '') })
          .onConflict(oc => oc.column('plate').doNothing())
          .execute()
        await done('ignored', 'ignored')
        break
      }
      case 'MISSING_TRAILER:set': {
        await this.setOverride(issue.ref, 'trailer', normalizePlate(str('trailer')))
        await done('set')
        break
      }
      case 'DISAPPEARED:keep':
        await done('keep')
        break
      case 'DISAPPEARED:delete':
        await this.db.deleteFrom('board_notes').where('order_no', '=', issue.ref).execute()
        await this.db.deleteFrom('board_orders').where('order_no', '=', issue.ref).execute()
        await done('deleted')
        break
      default:
        if (action !== 'dismiss') throw new BoardError('UNKNOWN_ACTION', 'Nieznana akcja.')
        await done('dismissed', issue.kind.startsWith('DISAPPEARED') || issue.kind === 'OVERRIDE_SUPERSEDED' ? 'resolved' : 'ignored')
    }
    await this.refreshIssues()
  }

  // ---------------------------------------------------------------- week view

  async weekView(anyDayInWeek: string): Promise<WeekView> {
    const start = weekStart(anyDayInWeek)
    const end = addDays(start, 6)
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
    const today = this.now().slice(0, 10)
    const ctx = await loadBoardContext(this.db)
    const orders = await computeOrders(this.db, ctx, this.distances, { from: addDays(start, -21), to: addDays(end, 14) })

    const openIssueRefs = new Set(
      (await this.db.selectFrom('board_issues').select('ref').where('status', '=', 'open').execute()).map(r => r.ref),
    )
    const orderNotes = await this.boardNotesFor(orders.map(o => o.orderNo))
    const dayNotes = await this.db
      .selectFrom('board_notes')
      .selectAll()
      .where('scope', '=', 'truck_day')
      .where('deleted', '=', 0)
      .where('day', '>=', start)
      .where('day', '<=', end)
      .orderBy('id')
      .execute()

    const trucks: WeekTruck[] = []
    for (const truck of ctx.fleet.trucks.filter(t => t.active)) {
      const legs = orders
        .flatMap(o => o.legs.map(l => ({ o, l })))
        .filter(x => x.l.kind === 'fleet' && x.l.truckId === truck.id)
        .sort((a, b) => a.l.startDate.localeCompare(b.l.startDate) || a.l.endDate.localeCompare(b.l.endDate) || a.l.orderNo.localeCompare(b.l.orderNo))

      // Automatic trailer-change events between consecutive legs.
      const events: WeekEvent[] = []
      let prevTrailer: string | null = null
      for (const { o, l } of legs) {
        if (o.excluded || o.noCarrier) continue
        if (l.trailer && prevTrailer && l.trailer !== prevTrailer && l.startDate >= start && l.startDate <= end) {
          const where = l.stops[0]?.code ? `${l.stops[0].code}: ` : ''
          events.push({
            id: null,
            day: l.startDate,
            kind: 'trailer',
            text: l.przRole === 'to' ? `${where}przepinka, bierze ${l.trailer}` : `${where}${prevTrailer} → ${l.trailer}`,
            auto: true,
          })
        }
        if (l.trailer) prevTrailer = l.trailer
      }
      for (const n of dayNotes.filter(n => n.truck_id === truck.id)) {
        events.push({ id: n.id, day: n.day ?? start, kind: n.kind, text: n.text, auto: false })
      }

      const visible = legs.filter(x => x.l.endDate >= start && x.l.startDate <= end)
      const bars: WeekBar[] = visible.map(({ o, l }) => this.toBar(o, l, start, ctx, openIssueRefs, orderNotes.get(o.orderNo) ?? []))

      const counted = legs.filter(x => !x.o.excluded && !x.o.noCarrier && x.l.startDate >= start && x.l.startDate <= end)
      const revenue = counted.reduce((s, x) => s + (x.l.revAlloc ?? 0), 0)
      const cost = counted.reduce((s, x) => s + (x.l.amount ?? 0) + (x.l.index === 0 ? x.o.extraCost : 0), 0)
      const km = counted.reduce((s, x) => s + (x.l.kmLoaded ?? 0) + (x.l.kmEmpty ?? 0), 0)
      const kmEmpty = counted.reduce((s, x) => s + (x.l.kmEmpty ?? 0), 0)

      const latest = [...legs].reverse().find(x => x.l.startDate <= (today < end ? today : end) && x.l.trailer)
      const trailer = latest?.l.trailer ?? truck.trailerPlate
      const trailerRec = trailer ? ctx.trailers.get(trailer) : undefined
      const plate = ctx.fleet.plateOn(truck, today >= start && today <= end ? today : end)
      const typePl = trailerRec?.typePl ?? 'chłodnia 2,61 m · rolki'
      const typeEn = trailerRec?.typeEn ?? 'cooler 2.61m rollerbed'
      trucks.push({
        id: truck.id,
        plate,
        carrier: truck.carrier,
        driver: truck.driver,
        phone: truck.phone,
        trailer,
        trailerTypePl: typePl,
        trailerTypeEn: typeEn,
        copyText: `Truck ${plate}, Trailer ${trailer ?? '—'} (${typeEn}), Driver: ${truck.driver}${truck.phone ? ` ${formatPhone(truck.phone)}` : ''}`,
        bars,
        events: events.sort((a, b) => a.day.localeCompare(b.day)),
        totals: {
          revenue: round2(revenue),
          cost: round2(cost),
          margin: round2(revenue - cost),
          km,
          kmEmpty,
          legs: counted.length,
          kmEstimated: counted.some(x => x.l.kmEstimated),
        },
      })
    }

    // Department KPIs: whole-order margins for orders loaded this week; km from fleet legs.
    const weekOrders = orders.filter(o => o.hasFleetLeg && !o.excluded && !o.noCarrier && o.loadDate >= start && o.loadDate <= end)
    const revenue = weekOrders.reduce((s, o) => s + (o.rev ?? 0), 0)
    const cost = weekOrders.reduce((s, o) => s + (o.amountsTotal ?? 0), 0)
    const legRevenue = trucks.reduce((s, t) => s + t.totals.revenue, 0)
    const legCost = trucks.reduce((s, t) => s + t.totals.cost, 0)
    const km = trucks.reduce((s, t) => s + t.totals.km, 0)
    const kmEmpty = trucks.reduce((s, t) => s + t.totals.kmEmpty, 0)
    const lastImport = await this.db.selectFrom('board_imports').select(['imported_at', 'filename']).orderBy('id', 'desc').executeTakeFirst()
    const openIssues = await this.db
      .selectFrom('board_issues')
      .select(eb => eb.fn.countAll<number>().as('n'))
      .where('status', '=', 'open')
      .executeTakeFirst()
    return {
      weekStart: start,
      weekEnd: end,
      weekNumber: isoWeekNumber(start),
      days,
      today,
      trucks,
      kpis: {
        margin: round2(revenue - cost),
        revenue: round2(revenue),
        cost: round2(cost),
        orders: weekOrders.length,
        km,
        kmEmpty,
        revenuePerKm: km > 0 ? round2(legRevenue / km) : null,
        costPerKm: km > 0 ? round2(legCost / km) : null,
        kmEstimated: trucks.some(t => t.totals.kmEstimated),
        openIssues: Number(openIssues?.n ?? 0),
      },
      lastImport: lastImport ? { importedAt: lastImport.imported_at, filename: lastImport.filename } : null,
    }
  }

  private toBar(
    o: ComputedOrder,
    l: ComputedLeg,
    weekStartIso: string,
    ctx: BoardContext,
    openIssueRefs: Set<string>,
    notes: Array<{ text: string; created_by: string; created_at: string }>,
  ): WeekBar {
    const dayIndex = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${weekStartIso}T00:00:00Z`)) / 86400000)
    const s = dayIndex(l.startDate)
    const e = dayIndex(l.endDate)
    const from = l.stops[0] ? ctx.places.name(l.stops[0].code) === '?' ? l.stops[0].raw : ctx.places.name(l.stops[0].code) : '?'
    const lastStop = l.stops[l.stops.length - 1]
    const to = lastStop ? (lastStop.code ? ctx.places.name(lastStop.code) : lastStop.raw) : '?'
    const middle = l.stops.slice(1, -1).map(st => (st.code ? ctx.places.name(st.code) : st.raw))
    const via = middle.length > 0 ? ` (przez ${middle.join(', ')})` : ''
    const noteLines: string[] = []
    if (o.missing) noteLines.push('Zniknęło z ostatniego eksportu.')
    if (o.excluded === 'cancelled') noteLines.push('Zlecenie anulowane (status A).')
    if (o.excluded === 'unconfirmed') noteLines.push('Zlecenie niezatwierdzone (status N).')
    if (o.noCarrier) noteLines.push('Brak przewoźnika (zlecenie spedycyjne anulowane).')
    if (o.notesApp) noteLines.push(`Z aplikacji: ${o.notesApp}`)
    for (const n of notes) noteLines.push(`Tablica · ${n.created_by}, ${fmtStamp(n.created_at)}: ${n.text}`)
    const legMargin = l.revAlloc !== null && l.amount !== null ? round2(l.revAlloc - l.amount - (l.index === 0 ? o.extraCost : 0)) : null
    return {
      key: `${o.orderNo}|${l.index}`,
      orderNo: o.orderNo,
      legIndex: l.index,
      legCount: o.legs.length,
      title: `${from} → ${to}${via}`,
      startDate: l.startDate,
      endDate: l.endDate,
      startDay: Math.max(-1, Math.min(7, s)),
      endDay: Math.max(-1, Math.min(7, e)),
      revAlloc: l.revAlloc,
      amount: l.amount,
      margin: legMargin,
      kmLoaded: l.kmLoaded,
      kmEmpty: l.kmEmpty,
      kmEstimated: l.kmEstimated,
      prz: l.przRole !== 'none',
      issue: openIssueRefs.has(o.orderNo),
      excluded: o.excluded,
      missing: o.missing,
      noCarrier: o.noCarrier,
      inWeek: l.startDate >= weekStartIso,
      noteLines,
    }
  }

  private async boardNotesFor(orderNos: string[]) {
    const map = new Map<string, Array<{ id: number; text: string; created_by: string; created_at: string }>>()
    if (orderNos.length === 0) return map
    const rows = await this.db
      .selectFrom('board_notes')
      .select(['id', 'order_no', 'text', 'created_by', 'created_at'])
      .where('scope', '=', 'order')
      .where('deleted', '=', 0)
      .where('order_no', 'in', orderNos)
      .orderBy('id')
      .execute()
    for (const r of rows) {
      if (!r.order_no) continue
      const list = map.get(r.order_no) ?? []
      list.push({ id: r.id, text: r.text, created_by: r.created_by, created_at: r.created_at })
      map.set(r.order_no, list)
    }
    return map
  }

  // ---------------------------------------------------------------- order details

  async orderDetails(orderNo: string) {
    const row = await this.db.selectFrom('board_orders').selectAll().where('order_no', '=', orderNo).executeTakeFirst()
    if (!row) throw new BoardError('ORDER_NOT_FOUND', 'Nie ma takiego zlecenia na tablicy.', 404)
    const ctx = await loadBoardContext(this.db)
    const orders = await computeOrders(
      this.db,
      ctx,
      this.distances,
      { from: addDays(row.load_date, -21), to: addDays(row.unload_date, 1) },
      { includeHistory: true },
    )
    const o = orders.find(x => x.orderNo === orderNo)
    if (!o) throw new BoardError('ORDER_NOT_FOUND', 'Nie ma takiego zlecenia na tablicy.', 404)
    const [notes, changes, overrides, issues] = await Promise.all([
      this.db.selectFrom('board_notes').selectAll().where('order_no', '=', orderNo).where('deleted', '=', 0).orderBy('id').execute(),
      this.db.selectFrom('board_order_changes').selectAll().where('order_no', '=', orderNo).orderBy('id').execute(),
      this.db.selectFrom('board_overrides').selectAll().where('order_no', '=', orderNo).orderBy('id').execute(),
      this.db.selectFrom('board_issues').selectAll().where('ref', '=', orderNo).where('status', '=', 'open').execute(),
    ])
    const history = [
      ...changes.map(c => ({
        at: c.created_at,
        text:
          c.field === 'created'
            ? 'dodano z importu'
            : `${FIELD_LABELS[c.field] ?? c.field}: ${c.old_value ?? '—'} → ${c.new_value ?? '—'} (zmiana w aplikacji)`,
      })),
      ...overrides.map(ov => ({
        at: ov.created_at,
        text: `ręczna poprawka (${ov.field}): ${ov.value}${ov.active ? '' : ` — zastąpiona: ${ov.superseded_note ?? ''}`}`,
      })),
    ].sort((a, b) => a.at.localeCompare(b.at))

    return {
      order: {
        orderNo: o.orderNo,
        client: o.client,
        clientRef: o.clientRef,
        carrier: o.carrier,
        statusClient: o.statusClient,
        statusSped: o.statusSped,
        loadDate: o.loadDate,
        unloadDate: o.unloadDate,
        route: `${placesLabel(o.loadPlaces, ctx)} → ${placesLabel(o.unloadPlaces, ctx)}`,
        rev: o.rev,
        costApp: o.costApp,
        amountsTotal: o.amountsTotal,
        extraCost: o.extraCost,
        margin: o.margin,
        marginPct: o.marginPct,
        excluded: o.excluded,
        noCarrier: o.noCarrier,
        missing: o.missing,
        notesApp: o.notesApp,
        prz: o.prz,
        przErrors: o.przErrors,
        trailer: o.legs[0]?.trailer ?? null,
      },
      legs: o.legs.map(l => ({
        index: l.index,
        plate: l.plate,
        kind: l.kind,
        truckId: l.truckId,
        stops: l.stops.map(st => (st.code ? ctx.places.name(st.code) : st.raw)),
        from: l.stops[0] ? (l.stops[0].code ? ctx.places.name(l.stops[0].code) : l.stops[0].raw) : '?',
        to: (() => {
          const s = l.stops[l.stops.length - 1]
          return s ? (s.code ? ctx.places.name(s.code) : s.raw) : '?'
        })(),
        startDate: l.startDate,
        endDate: l.endDate,
        amount: l.amount,
        revAlloc: l.revAlloc,
        kmLoaded: l.kmLoaded,
        kmEmpty: l.kmEmpty,
        kmEmptyFrom: l.kmEmptyFrom ? ctx.places.name(l.kmEmptyFrom) : null,
        kmEstimated: l.kmEstimated,
      })),
      notes: notes.map(n => ({ id: n.id, text: n.text, createdBy: n.created_by, createdAt: n.created_at })),
      overrides: overrides.filter(ov => ov.active === 1).map(ov => ({ field: ov.field, value: ov.value, createdAt: ov.created_at })),
      issues: issues.map(i => ({ id: i.id, kind: i.kind, message: i.message })),
      history,
    }
  }

  // ---------------------------------------------------------------- notes & corrections

  async addOrderNote(orderNo: string, text: string) {
    await this.requireOrder(orderNo)
    const clean = text.trim()
    if (!clean) throw new BoardError('EMPTY_NOTE', 'Notatka jest pusta.')
    await this.db
      .insertInto('board_notes')
      .values({ scope: 'order', order_no: orderNo, kind: 'note', text: clean, created_by: this.actor(), created_at: this.now() })
      .execute()
  }

  async addTruckEvent(input: { truckId: number; day: string; kind: NoteKind; text: string; place?: string }) {
    if (!NOTE_KINDS.includes(input.kind)) throw new BoardError('BAD_KIND', 'Nieznany rodzaj zdarzenia.')
    const truck = await this.db.selectFrom('board_trucks').select('id').where('id', '=', input.truckId).executeTakeFirst()
    if (!truck) throw new BoardError('TRUCK_NOT_FOUND', 'Nie ma takiego auta.', 404)
    let placeCode: string | null = null
    if (input.place && input.place.trim()) {
      const ctx = await loadBoardContext(this.db)
      placeCode = ctx.places.resolve(input.place)
      if (!placeCode) throw new BoardError('PLACE_UNKNOWN', `Nie znam miejsca „${input.place}”. Dodaj je w słowniku miejsc.`)
    }
    const text = input.text.trim()
    if (!text) throw new BoardError('EMPTY_NOTE', 'Opis jest pusty.')
    await this.db
      .insertInto('board_notes')
      .values({
        scope: 'truck_day',
        truck_id: input.truckId,
        day: input.day,
        kind: input.kind,
        text,
        place_code: placeCode,
        created_by: this.actor(),
        created_at: this.now(),
      })
      .execute()
  }

  async deleteNote(id: number) {
    await this.db.updateTable('board_notes').set({ deleted: 1 }).where('id', '=', id).execute()
  }

  async setOverride(orderNo: string, field: string, value: string) {
    if (!(OVERRIDE_FIELDS as readonly string[]).includes(field)) throw new BoardError('BAD_FIELD', 'Tego pola nie można poprawić.')
    const row = await this.requireOrder(orderNo)
    const appValue =
      field === 'rev' ? row.rev_eur : field === 'cost' ? row.cost_eur : field === 'trailer' ? row.trailer_raw : field === 'prz' ? row.notes_app : null
    const now = this.now()
    await this.db.transaction().execute(async trx => {
      await trx
        .updateTable('board_overrides')
        .set({ active: 0, superseded_at: now, superseded_note: 'zastąpiona nowszą poprawką' })
        .where('order_no', '=', orderNo)
        .where('field', '=', field)
        .where('active', '=', 1)
        .execute()
      await trx
        .insertInto('board_overrides')
        .values({
          order_no: orderNo,
          field,
          value,
          app_value: appValue === null ? null : String(appValue),
          created_by: this.actor(),
          created_at: now,
        })
        .execute()
    })
    await this.refreshIssues()
  }

  async clearOverride(orderNo: string, field: string) {
    await this.db
      .updateTable('board_overrides')
      .set({ active: 0, superseded_at: this.now(), superseded_note: 'usunięta ręcznie' })
      .where('order_no', '=', orderNo)
      .where('field', '=', field)
      .where('active', '=', 1)
      .execute()
    await this.refreshIssues()
  }

  private async requireOrder(orderNo: string) {
    const row = await this.db.selectFrom('board_orders').selectAll().where('order_no', '=', orderNo).executeTakeFirst()
    if (!row) throw new BoardError('ORDER_NOT_FOUND', 'Nie ma takiego zlecenia na tablicy.', 404)
    return row
  }

  // ---------------------------------------------------------------- registries

  async fleet() {
    const ctx = await loadBoardContext(this.db)
    const today = this.now().slice(0, 10)
    return ctx.fleet.trucks.map(t => ({ ...t, currentPlate: ctx.fleet.plateOn(t, today) }))
  }

  async createTruck(input: { plate: string; validFrom: string; carrier?: string; driver?: string; phone?: string; trailerPlate?: string }) {
    const plate = normalizePlate(input.plate)
    if (!plate) throw new BoardError('BAD_PLATE', 'Podaj numer rejestracyjny ciągnika.')
    const clash = await this.db.selectFrom('board_truck_plates').select('id').where('plate', '=', plate).where('valid_to', 'is', null).executeTakeFirst()
    if (clash) throw new BoardError('PLATE_TAKEN', `Numer ${plate} jest już przypisany do auta we flocie.`)
    const max = await this.db.selectFrom('board_trucks').select(eb => eb.fn.max('sort_order').as('m')).executeTakeFirst()
    const truck = await this.db
      .insertInto('board_trucks')
      .values({
        carrier: input.carrier ?? '',
        driver: input.driver ?? '',
        phone: input.phone ?? '',
        trailer_plate: input.trailerPlate ? normalizePlate(input.trailerPlate) : null,
        sort_order: Number(max?.m ?? 0) + 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await this.db.insertInto('board_truck_plates').values({ truck_id: truck.id, plate, valid_from: input.validFrom, valid_to: null }).execute()
    await this.db.deleteFrom('board_ignored_plates').where('plate', '=', plate).execute()
    return truck.id
  }

  async updateTruck(id: number, patch: { carrier?: string; driver?: string; phone?: string; trailerPlate?: string | null; notes?: string; active?: boolean; sortOrder?: number }) {
    const set: Record<string, unknown> = {}
    if (patch.carrier !== undefined) set['carrier'] = patch.carrier
    if (patch.driver !== undefined) set['driver'] = patch.driver
    if (patch.phone !== undefined) set['phone'] = patch.phone
    if (patch.trailerPlate !== undefined) set['trailer_plate'] = patch.trailerPlate ? normalizePlate(patch.trailerPlate) : null
    if (patch.notes !== undefined) set['notes'] = patch.notes
    if (patch.active !== undefined) set['active'] = patch.active ? 1 : 0
    if (patch.sortOrder !== undefined) set['sort_order'] = patch.sortOrder
    if (Object.keys(set).length === 0) return
    const res = await this.db.updateTable('board_trucks').set(set).where('id', '=', id).executeTakeFirst()
    if (Number(res.numUpdatedRows) === 0) throw new BoardError('TRUCK_NOT_FOUND', 'Nie ma takiego auta.', 404)
  }

  /** New plate for an existing truck from a date; the previous plate ends the day before. */
  async addTruckPlate(truckId: number, rawPlate: string, validFrom: string) {
    const plate = normalizePlate(rawPlate)
    if (!plate) throw new BoardError('BAD_PLATE', 'Podaj numer rejestracyjny.')
    const truck = await this.db.selectFrom('board_trucks').select('id').where('id', '=', truckId).executeTakeFirst()
    if (!truck) throw new BoardError('TRUCK_NOT_FOUND', 'Nie ma takiego auta.', 404)
    await this.db.transaction().execute(async trx => {
      await trx
        .updateTable('board_truck_plates')
        .set({ valid_to: addDays(validFrom, -1) })
        .where('truck_id', '=', truckId)
        .where('valid_to', 'is', null)
        .where('valid_from', '<', validFrom)
        .execute()
      await trx
        .insertInto('board_truck_plates')
        .values({ truck_id: truckId, plate, valid_from: validFrom, valid_to: null })
        .onConflict(oc => oc.columns(['plate', 'valid_from']).doUpdateSet({ truck_id: truckId, valid_to: null }))
        .execute()
      await trx.deleteFrom('board_ignored_plates').where('plate', '=', plate).execute()
    })
    await this.refreshIssues()
  }

  async trailers() {
    const ctx = await loadBoardContext(this.db)
    const aliases = await this.db.selectFrom('board_trailer_aliases').selectAll().execute()
    return ctx.trailers.all().map(t => ({
      ...t,
      aliases: aliases.filter(a => a.trailer_plate === t.plate && a.alias !== t.plate).map(a => a.alias),
    }))
  }

  async upsertTrailer(input: { plate: string; typePl?: string | undefined; typeEn?: string | undefined; notes?: string | undefined }) {
    const plate = normalizePlate(input.plate)
    if (!plate) throw new BoardError('BAD_PLATE', 'Podaj numer naczepy.')
    const values = {
      plate,
      ...(input.typePl ? { type_pl: input.typePl } : {}),
      ...(input.typeEn ? { type_en: input.typeEn } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    }
    const update = {
      ...(input.typePl ? { type_pl: input.typePl } : {}),
      ...(input.typeEn ? { type_en: input.typeEn } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    }
    await this.db
      .insertInto('board_trailers')
      .values(values)
      .onConflict(oc => (Object.keys(update).length > 0 ? oc.column('plate').doUpdateSet(update) : oc.column('plate').doNothing()))
      .execute()
    await this.addTrailerAlias(plate, plate)
  }

  async addTrailerAlias(raw: string, trailerPlate: string) {
    const alias = normalizePlate(raw)
    if (!alias) return
    await this.db
      .insertInto('board_trailer_aliases')
      .values({ alias, trailer_plate: trailerPlate })
      .onConflict(oc => oc.column('alias').doUpdateSet({ trailer_plate: trailerPlate }))
      .execute()
  }

  async places() {
    const ctx = await loadBoardContext(this.db)
    const aliases = await this.db.selectFrom('board_place_aliases').selectAll().execute()
    return [...ctx.places.places.values()]
      .map(p => ({ ...p, aliases: aliases.filter(a => a.place_code === p.code).map(a => a.alias) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pl'))
  }

  async createPlace(input: { code?: string; name: string; country?: string; lat: number; lon: number }): Promise<string> {
    const name = input.name.trim()
    if (!name) throw new BoardError('BAD_PLACE', 'Podaj nazwę miejsca.')
    if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon) || Math.abs(input.lat) > 90 || Math.abs(input.lon) > 180) {
      throw new BoardError('BAD_COORDS', 'Podaj poprawne współrzędne (szerokość i długość geograficzną).')
    }
    let code = (input.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!code) code = aliasKey(name).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4).padEnd(4, 'X')
    if (/^[A-Z]{3}$/.test(code)) code = `${code}X` // 3 letters are reserved for real IATA codes
    let candidate = code
    for (let i = 2; await this.db.selectFrom('board_places').select('code').where('code', '=', candidate).executeTakeFirst(); i++) {
      candidate = `${code}${i}`
    }
    await this.db
      .insertInto('board_places')
      .values({ code: candidate, name, country: (input.country ?? '').toUpperCase(), lat: input.lat, lon: input.lon, kind: 'custom' })
      .execute()
    await this.addPlaceAlias(name, candidate)
    return candidate
  }

  async addPlaceAlias(raw: string, code: string) {
    const alias = aliasKey(raw)
    if (!alias) return
    await this.db
      .insertInto('board_place_aliases')
      .values({ alias, place_code: code })
      .onConflict(oc => oc.column('alias').doUpdateSet({ place_code: code }))
      .execute()
  }

  async setDistance(from: string, to: string, km: number, note: string | null) {
    if (!(km >= 0)) throw new BoardError('BAD_KM', 'Podaj liczbę kilometrów.')
    await this.distances.setManual(from.toUpperCase(), to.toUpperCase(), km, note)
  }

  async setThresholds(t: Partial<IssueThresholds>) {
    const entries: Array<[string, number | undefined]> = [
      ['board_margin_warn_pct', t.marginWarnPct],
      ['board_rev_per_km_min', t.revPerKmMin],
      ['board_rev_per_km_max', t.revPerKmMax],
    ]
    for (const [key, value] of entries) {
      if (value === undefined) continue
      await this.db
        .insertInto('config')
        .values({ key, value: String(value) })
        .onConflict(oc => oc.column('key').doUpdateSet({ value: String(value) }))
        .execute()
    }
    await this.refreshIssues()
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function fmtStamp(iso: string): string {
  return `${fmtDate(iso.slice(0, 10))}, ${iso.slice(11, 16)}`
}

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length === 9 ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}` : raw
}
