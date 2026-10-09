import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import type { DB, ImportMode, NoteKind, ServiceTarget } from '../db/schema.js'
import { computeOrders, placesLabel, type ComputedLeg, type ComputedOrder } from './compute.js'
import { loadBoardContext, type BoardContext, type TruckRecord } from './context.js'
import type { DistanceService } from './distances.js'
import { importExportFile, FIELD_LABELS, type ImportSummary } from './importService.js'
import { DEFAULT_THRESHOLDS, deriveIssues, fmtDate, syncDerivedIssues, type IssueThresholds } from './issues.js'
import { planFleetSync, type FleetPlan } from './fleetList.js'
import {
  CERT_FILE_MAX_BYTES,
  FROM_THE_BEGINNING,
  certStatus,
  certWarnings,
  cleanFilename,
  sniffScan,
  type CertStatus,
  kindKey as kindKeyOf,
  type DriverRecord,
  type LegDrivers,
} from './drivers.js'
import { addDays, aliasKey, isoWeekNumber, normalizePlate, weekStart } from './normalize.js'
import {
  dm as dmDay,
  fullyCoveredDays,
  isRealDay,
  targetLabel,
  toServiceDto,
  validateWhen,
  warsawNow,
  whenLabel,
  whenOf,
  type ServiceDto,
  type ServiceRecord,
  type ServiceWhen,
} from './services.js'

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

export const OVERRIDE_FIELDS = ['rev', 'cost', 'extra_cost', 'trailer', 'prz', 'exclude', 'km_loaded', 'km_empty', 'km_loaded:1', 'km_empty:1', 'driver', 'driver:1'] as const
export type OverrideField = (typeof OVERRIDE_FIELDS)[number]

/** Free-form day events; a service has its own record (board_services). */
const NOTE_KINDS: NoteKind[] = ['note', 'pause', 'driver', 'trailer', 'position']

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
  /** Set when the truck is in service all day on a day of this leg (red outline on the board). */
  serviceConflict: string | null
}

export interface WeekEvent {
  id: number | null
  day: string
  kind: NoteKind
  text: string
  auto: boolean
  /** Set for a driver change (board_driver_changes) — opens its edit dialog. */
  driverChangeId?: number
  driverId?: number | null
}

export interface CertWarning {
  kind: string
  validTo: string
  status: 'expiring' | 'expired'
}

export interface WeekTruck {
  id: number
  plate: string
  carrier: string
  /** Driver on the reference day (today in the current week, else the last day of the week). */
  driverId: number | null
  driver: string
  phone: string
  /** Expiring / expired certificates of that driver (newest per kind). */
  driverWarnings: CertWarning[]
  trailer: string | null
  trailerTypePl: string
  trailerTypeEn: string
  copyText: string
  bars: WeekBar[]
  events: WeekEvent[]
  /** Planned services in this week shown in the service strip (tractor + trailer services of the trailer behind it). */
  services: ServiceDto[]
  /** Required services (no date yet) of the tractor and of the trailer currently behind it. */
  required: ServiceDto[]
  totals: { revenue: number; cost: number; margin: number; km: number; kmEmpty: number; legs: number; kmEstimated: boolean }
}

export interface TruckOrderRow {
  orderNo: string
  legIndex: number
  legCount: number
  title: string
  startDate: string
  endDate: string
  revAlloc: number | null
  amount: number | null
  margin: number | null
  km: number | null
  kmEstimated: boolean
  prz: boolean
  excluded: string | null
  noCarrier: boolean
  missing: boolean
  /** "A → B (zmiana 11.10)"; manual = corrected in the order panel. */
  driver: string
  driverManual: boolean
}

export interface TruckView {
  truck: {
    id: number
    plate: string
    plates: Array<{ plate: string; validFrom: string; validTo: string | null }>
    carrier: string
    driverId: number | null
    driver: string
    phone: string
    driverWarnings: CertWarning[]
    trailer: string | null
    trailerTypePl: string
    active: boolean
    copyText: string
    required: ServiceDto[]
    /** Driver changes of this tractor, newest first (the first entry may be "from the beginning"). */
    driverChanges: Array<{ id: number; day: string; driverId: number | null; driver: string; createdBy: string; createdAt: string }>
  }
  from: string
  to: string
  today: string
  weeks: Array<{ weekStart: string; weekEnd: string; weekNumber: number; days: string[]; row: WeekTruck }>
  totals: { revenue: number; cost: number; margin: number; km: number; kmEmpty: number; legs: number; kmEstimated: boolean; services: number }
  orders: TruckOrderRow[]
  services: ServiceDto[]
  activeOrder: { orderNo: string; title: string; startDate: string; endDate: string; upcoming: boolean } | null
}

export interface DriverListItem {
  id: number
  name: string
  phone: string
  carrier: string
  notes: string
  active: boolean
  /** Tractors the driver is on today. */
  trucks: Array<{ id: number; plate: string }>
  avsec: { validTo: string | null; number: string; files: number; status: CertStatus; daysLeft: number | null } | null
  certCount: number
  warnings: CertWarning[]
}

export interface DriverDetails {
  driver: { id: number; name: string; phone: string; carrier: string; notes: string; active: boolean }
  trucks: Array<{ id: number; plate: string }>
  history: Array<{ truckId: number; plate: string; from: string; to: string | null }>
  certs: Array<{
    id: number
    kind: string
    number: string
    validTo: string | null
    notes: string
    status: CertStatus
    daysLeft: number | null
    createdBy: string
    updatedBy: string
    updatedAt: string
    files: Array<{ id: number; filename: string; mime: string; size: number; uploadedBy: string; uploadedAt: string }>
  }>
  warnings: CertWarning[]
}

export interface ServiceInput {
  truckId: number
  target: ServiceTarget
  trailerPlate?: string | undefined
  status: 'required' | 'planned'
  description?: string | undefined
  place?: string | undefined
  allDay?: boolean | undefined
  startDay?: string | undefined
  startTime?: string | undefined
  endDay?: string | undefined
  endTime?: string | undefined
}

export interface ServicePatch {
  status?: 'required' | 'planned' | 'cancelled' | undefined
  target?: ServiceTarget | undefined
  trailerPlate?: string | undefined
  description?: string | undefined
  place?: string | undefined
  allDay?: boolean | undefined
  startDay?: string | undefined
  startTime?: string | null | undefined
  endDay?: string | undefined
  endTime?: string | null | undefined
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
  /** Where certificate scans are stored (default data/pliki next to the database). */
  filesDir?: string
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
        // New trailer, or a retired one brought back into the fleet.
        const plate = normalizePlate(str('plate') || String(details['raw'] ?? issue.ref))
        const carrier = typeof details['carrier'] === 'string' ? details['carrier'] : undefined
        const exists = await this.db.selectFrom('board_trailers').select(['plate', 'carrier']).where('plate', '=', plate).executeTakeFirst()
        await this.upsertTrailer({
          plate,
          typePl: str('typePl') || undefined,
          typeEn: str('typeEn') || undefined,
          activeTo: null,
          ...(carrier && !exists?.carrier ? { carrier } : {}),
        })
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
    const { orders, weeks, today } = await this.loadWeeks([start], t => t.active)
    const week = weeks[0]!
    const trucks = week.trucks

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
      days: week.days,
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

  /**
   * Truck rows for one or more consecutive weeks (board week view, set page).
   * Orders are computed once for the whole range; services planned in the range
   * and every required one come along.
   */
  private async loadWeeks(weekStarts: string[], include: (t: TruckRecord) => boolean) {
    const first = weekStarts[0]!
    const last = addDays(weekStarts[weekStarts.length - 1]!, 6)
    const nowLocal = warsawNow(this.now())
    const today = nowLocal.slice(0, 10) // the board's "today" is the Polish date
    const ctx = await loadBoardContext(this.db)
    const orders = await computeOrders(this.db, ctx, this.distances, { from: addDays(first, -21), to: addDays(last, 14) })

    const openIssueRefs = new Set(
      (await this.db.selectFrom('board_issues').select('ref').where('status', '=', 'open').execute()).map(r => r.ref),
    )
    const orderNotes = await this.boardNotesFor(orders.map(o => o.orderNo))
    const dayNotes = await this.db
      .selectFrom('board_notes')
      .selectAll()
      .where('scope', '=', 'truck_day')
      .where('deleted', '=', 0)
      .where('kind', '!=', 'service')
      .where('day', '>=', first)
      .where('day', '<=', last)
      .orderBy('id')
      .execute()

    // Planned services around the range (wider, so bars reaching into the range see their conflicts) + every required one.
    const serviceRows = (await this.db
      .selectFrom('board_services')
      .selectAll()
      .where(eb =>
        eb.or([
          eb('status', '=', 'required'),
          eb.and([eb('status', '=', 'planned'), eb('start_day', '<=', addDays(last, 14)), eb('end_day', '>=', addDays(first, -21))]),
        ]),
      )
      .orderBy('id')
      .execute()) as ServiceRecord[]
    const history = await this.serviceHistory(serviceRows.map(r => r.id))
    const dtos = new Map(serviceRows.map(r => [r.id, toServiceDto(r, nowLocal, history.get(r.id) ?? [])]))
    const certsByDriver = await this.certsByDriver()

    const legsByTruck = new Map<number, Array<{ o: ComputedOrder; l: ComputedLeg }>>()
    for (const o of orders) {
      for (const l of o.legs) {
        if (l.kind !== 'fleet' || l.truckId === null) continue
        const list = legsByTruck.get(l.truckId) ?? []
        list.push({ o, l })
        legsByTruck.set(l.truckId, list)
      }
    }
    for (const list of legsByTruck.values()) {
      list.sort((a, b) => a.l.startDate.localeCompare(b.l.startDate) || a.l.endDate.localeCompare(b.l.endDate) || a.l.orderNo.localeCompare(b.l.orderNo))
    }

    /** Trailer behind the truck on a day: the latest order loaded by then, else the fixed trailer. */
    const trailerOn = (truck: TruckRecord, day: string): { trailer: string; since: string } | null => {
      const latest = [...(legsByTruck.get(truck.id) ?? [])].reverse().find(x => x.l.startDate <= day && x.l.trailer)
      if (latest?.l.trailer) return { trailer: latest.l.trailer, since: latest.l.startDate }
      return truck.trailerPlate ? { trailer: truck.trailerPlate, since: '' } : null
    }

    /** The truck the trailer is behind on a day (most recent order with it), or null. */
    const trailerHolder = (plate: string | null, day: string): number | null => {
      if (!plate) return null
      let best: { truckId: number; since: string } | null = null
      for (const t of ctx.fleet.trucks) {
        const on = trailerOn(t, day)
        if (on && on.trailer === plate && (!best || on.since > best.since)) best = { truckId: t.id, since: on.since }
      }
      return best?.truckId ?? null
    }

    // A planned trailer service shows on the truck that has the trailer on the first service day
    // (else on the truck it was entered at).
    const holderOf = new Map<number, number | null>()
    for (const r of serviceRows) {
      if (r.status === 'planned' && r.target === 'trailer' && r.start_day) holderOf.set(r.id, trailerHolder(r.trailer_plate, r.start_day) ?? r.truck_id)
    }
    const coveredDays = new Map<number, string[]>()
    for (const r of serviceRows) {
      const w = whenOf(r)
      if (r.status === 'planned' && r.target === 'truck' && w) coveredDays.set(r.id, fullyCoveredDays(w))
    }

    const weeks = weekStarts.map(start => {
      const end = addDays(start, 6)
      const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
      const refDay = today < end ? today : end
      const requiredTrailerHolder = new Map(
        serviceRows.filter(r => r.status === 'required' && r.target === 'trailer').map(r => [r.id, trailerHolder(r.trailer_plate, refDay)]),
      )
      const trucks: WeekTruck[] = []
      for (const truck of ctx.fleet.trucks.filter(include)) {
        const legs = legsByTruck.get(truck.id) ?? []

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
        for (const n of dayNotes.filter(n => n.truck_id === truck.id && n.day !== null && n.day >= start && n.day <= end)) {
          events.push({ id: n.id, day: n.day ?? start, kind: n.kind, text: n.text, auto: false })
        }
        // Driver changes (the "from the beginning" entry is never in a week).
        const changes = ctx.drivers.changesOf(truck.id)
        for (const [i, c] of changes.entries()) {
          if (c.day < start || c.day > end || c.day <= FROM_THE_BEGINNING) continue
          const prev = i > 0 ? changes[i - 1]! : null
          const text = prev ? `${ctx.drivers.name(prev.driverId)} → ${ctx.drivers.name(c.driverId)}` : ctx.drivers.name(c.driverId)
          events.push({ id: null, day: c.day, kind: 'driver', text: `Kierowca: ${text}`, auto: false, driverChangeId: c.id, driverId: c.driverId })
        }

        const truckServiceDays = serviceRows
          .filter(r => r.status === 'planned' && r.target === 'truck' && r.truck_id === truck.id)
          .flatMap(r => coveredDays.get(r.id) ?? [])
        const visible = legs.filter(x => x.l.endDate >= start && x.l.startDate <= end)
        const bars: WeekBar[] = visible.map(({ o, l }) => {
          const conflict =
            o.excluded || o.noCarrier ? [] : [...new Set(truckServiceDays.filter(d => d >= l.startDate && d <= l.endDate))].sort()
          return this.toBar(o, l, start, ctx, openIssueRefs, orderNotes.get(o.orderNo) ?? [], conflict)
        })

        const counted = legs.filter(x => !x.o.excluded && !x.o.noCarrier && x.l.startDate >= start && x.l.startDate <= end)
        const revenue = counted.reduce((s, x) => s + (x.l.revAlloc ?? 0), 0)
        const cost = counted.reduce((s, x) => s + (x.l.amount ?? 0) + (x.l.index === 0 ? x.o.extraCost : 0), 0)
        const km = counted.reduce((s, x) => s + (x.l.kmLoaded ?? 0) + (x.l.kmEmpty ?? 0), 0)
        const kmEmpty = counted.reduce((s, x) => s + (x.l.kmEmpty ?? 0), 0)

        const trailer = trailerOn(truck, today < end ? today : end)?.trailer ?? null
        const trailerRec = trailer ? ctx.trailers.get(trailer) : undefined
        const plate = ctx.fleet.plateOn(truck, today >= start && today <= end ? today : end)
        const typePl = trailerRec?.typePl ?? 'chłodnia 2,61 m · rolki'
        const typeEn = trailerRec?.typeEn ?? 'cooler 2.61m rollerbed'

        const services = serviceRows
          .filter(
            r =>
              r.status === 'planned' &&
              r.start_day !== null &&
              r.end_day !== null &&
              r.start_day <= end &&
              r.end_day >= start &&
              (r.target === 'truck' ? r.truck_id === truck.id : holderOf.get(r.id) === truck.id),
          )
          .map(r => dtos.get(r.id)!)
          .sort((a, b) => `${a.startDay}T${a.startTime ?? ''}`.localeCompare(`${b.startDay}T${b.startTime ?? ''}`))
        const required = serviceRows
          .filter(r => r.status === 'required' && (r.target === 'truck' ? r.truck_id === truck.id : requiredTrailerHolder.get(r.id) === truck.id))
          .map(r => dtos.get(r.id)!)
          .sort((a, b) => a.reportedAt.localeCompare(b.reportedAt))

        const driver = ctx.drivers.driverOn(truck.id, today >= start && today <= end ? today : end)
        trucks.push({
          id: truck.id,
          plate,
          carrier: truck.carrier,
          driverId: driver?.id ?? null,
          driver: driver?.name ?? '',
          phone: driver?.phone ?? '',
          driverWarnings: driver ? certWarnings(certsByDriver.get(driver.id) ?? [], today) : [],
          trailer,
          trailerTypePl: typePl,
          trailerTypeEn: typeEn,
          copyText: copyTextFor(plate, trailer, typeEn, driver),
          bars,
          events: events.sort((a, b) => a.day.localeCompare(b.day)),
          services,
          required,
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
      return { start, end, days, weekNumber: isoWeekNumber(start), trucks }
    })
    const requiredAll = serviceRows.filter(r => r.status === 'required').map(r => dtos.get(r.id)!)
    return { ctx, orders, weeks, today, nowLocal, legsByTruck, requiredAll, certsByDriver }
  }

  private toBar(
    o: ComputedOrder,
    l: ComputedLeg,
    weekStartIso: string,
    ctx: BoardContext,
    openIssueRefs: Set<string>,
    notes: Array<{ text: string; created_by: string; created_at: string }>,
    serviceDays: string[] = [],
  ): WeekBar {
    const dayIndex = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${weekStartIso}T00:00:00Z`)) / 86400000)
    const s = dayIndex(l.startDate)
    const e = dayIndex(l.endDate)
    const noteLines: string[] = []
    const serviceConflict = serviceDays.length > 0 ? `Auto w serwisie cały dzień ${serviceDays.map(dmDay).join(', ')}.` : null
    if (serviceConflict) noteLines.push(serviceConflict)
    if (o.missing) noteLines.push('Zniknęło z ostatniego eksportu.')
    if (o.excluded === 'cancelled') noteLines.push('Zlecenie anulowane (status A).')
    if (o.excluded === 'unconfirmed') noteLines.push('Zlecenie niezatwierdzone (status N).')
    if (o.noCarrier) noteLines.push('Brak przewoźnika (zlecenie spedycyjne anulowane).')
    if (o.notesApp) noteLines.push(`Z aplikacji: ${o.notesApp}`)
    for (const n of notes) noteLines.push(`Tablica · ${n.created_by}, ${fmtStamp(n.created_at)}: ${n.text}`)
    return {
      key: `${o.orderNo}|${l.index}`,
      orderNo: o.orderNo,
      legIndex: l.index,
      legCount: o.legs.length,
      title: legTitle(l, ctx),
      startDate: l.startDate,
      endDate: l.endDate,
      startDay: Math.max(-1, Math.min(7, s)),
      endDay: Math.max(-1, Math.min(7, e)),
      revAlloc: l.revAlloc,
      amount: l.amount,
      margin: legMargin(o, l),
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
      serviceConflict,
    }
  }

  // ---------------------------------------------------------------- set page (strona zestawu)

  /** One tractor over whole weeks covering [from, to] (week or month view). */
  async truckView(truckId: number, from: string, to: string): Promise<TruckView> {
    if (!isRealDay(from) || !isRealDay(to)) throw new BoardError('BAD_DATE', 'Podaj poprawną datę.')
    const first = weekStart(from)
    const lastStart = weekStart(to < from ? from : to)
    const weekStarts: string[] = []
    for (let s = first; s <= lastStart && weekStarts.length < 7; s = addDays(s, 7)) weekStarts.push(s)
    const exists = await this.db.selectFrom('board_trucks').select('id').where('id', '=', truckId).executeTakeFirst()
    if (!exists) throw new BoardError('TRUCK_NOT_FOUND', 'Nie ma takiego auta.', 404)

    const { ctx, weeks, today, nowLocal, legsByTruck, requiredAll, certsByDriver } = await this.loadWeeks(weekStarts, t => t.id === truckId)
    const truck = ctx.fleet.byId(truckId)!
    const rows = weeks.map(w => ({ weekStart: w.start, weekEnd: w.end, weekNumber: w.weekNumber, days: w.days, row: w.trucks[0]! }))
    const periodFrom = first
    const periodTo = addDays(weekStarts[weekStarts.length - 1]!, 6)

    const sum = (f: (r: WeekTruck) => number) => rows.reduce((s, w) => s + f(w.row), 0)
    const shownServices = new Set(rows.flatMap(w => w.row.services.map(sv => sv.id)))
    const totals = {
      revenue: round2(sum(r => r.totals.revenue)),
      cost: round2(sum(r => r.totals.cost)),
      margin: round2(sum(r => r.totals.margin)),
      km: sum(r => r.totals.km),
      kmEmpty: sum(r => r.totals.kmEmpty),
      legs: sum(r => r.totals.legs),
      kmEstimated: rows.some(w => w.row.totals.kmEstimated),
      services: shownServices.size,
    }

    const legs = legsByTruck.get(truckId) ?? []
    const orderRows: TruckOrderRow[] = legs
      .filter(x => x.l.startDate >= periodFrom && x.l.startDate <= periodTo)
      .map(({ o, l }) => ({
        orderNo: o.orderNo,
        legIndex: l.index,
        legCount: o.legs.length,
        title: legTitle(l, ctx),
        startDate: l.startDate,
        endDate: l.endDate,
        revAlloc: l.revAlloc,
        amount: l.amount === null ? null : round2(l.amount + (l.index === 0 ? o.extraCost : 0)),
        margin: legMargin(o, l),
        km: l.kmLoaded === null && l.kmEmpty === null ? null : (l.kmLoaded ?? 0) + (l.kmEmpty ?? 0),
        kmEstimated: l.kmEstimated,
        prz: l.przRole !== 'none',
        excluded: o.excluded,
        noCarrier: o.noCarrier,
        missing: o.missing,
        ...((): { driver: string; driverManual: boolean } => {
          const d = legDriversOf(o, l, ctx)
          return { driver: d.text, driverManual: d.manual }
        })(),
      }))

    // Active order and the header (trailer, badges) are about today; computed around today when the period is elsewhere.
    const todayRow = rows.find(w => today >= w.weekStart && today <= w.weekEnd)?.row ?? null
    let todayLegs = legs
    const windowFrom = addDays(periodFrom, -21)
    const windowTo = addDays(periodTo, 14)
    if (today < windowFrom || today > windowTo) {
      const around = await computeOrders(this.db, ctx, this.distances, { from: addDays(today, -21), to: addDays(today, 14) })
      todayLegs = around
        .flatMap(o => o.legs.filter(l => l.kind === 'fleet' && l.truckId === truckId).map(l => ({ o, l })))
        .sort((a, b) => a.l.startDate.localeCompare(b.l.startDate) || a.l.endDate.localeCompare(b.l.endDate) || a.l.orderNo.localeCompare(b.l.orderNo))
    }
    const live = todayLegs.filter(x => !x.o.excluded && !x.o.noCarrier)
    const current = [...live].reverse().find(x => x.l.startDate <= today && x.l.endDate >= today)
    const next = live.filter(x => x.l.startDate > today && x.l.startDate <= addDays(today, 14)).sort((a, b) => a.l.startDate.localeCompare(b.l.startDate))[0]
    const pick = current ?? next
    const activeOrder = pick
      ? { orderNo: pick.o.orderNo, title: legTitle(pick.l, ctx), startDate: pick.l.startDate, endDate: pick.l.endDate, upcoming: !current }
      : null

    const plateToday = ctx.fleet.plateOn(truck, today)
    const driverToday = ctx.drivers.driverOn(truckId, today)
    let header: { trailer: string | null; trailerTypePl: string; copyText: string; required: ServiceDto[] }
    if (todayRow) {
      header = { trailer: todayRow.trailer, trailerTypePl: todayRow.trailerTypePl, copyText: todayRow.copyText, required: todayRow.required }
    } else {
      const latest = [...todayLegs].reverse().find(x => x.l.startDate <= today && x.l.trailer)
      const trailer = latest?.l.trailer ?? truck.trailerPlate
      const rec = trailer ? ctx.trailers.get(trailer) : undefined
      const typeEn = rec?.typeEn ?? 'cooler 2.61m rollerbed'
      header = {
        trailer,
        trailerTypePl: rec?.typePl ?? 'chłodnia 2,61 m · rolki',
        copyText: copyTextFor(plateToday, trailer, typeEn, driverToday),
        required: requiredAll.filter(sv => (sv.target === 'truck' ? sv.truckId === truckId : trailer !== null && sv.trailerPlate === trailer)),
      }
    }
    const headerRow = header

    // Service list: the tractor's own services, those of its current trailer and trailer services shown on it in the period.
    const listRows = (await this.db
      .selectFrom('board_services')
      .selectAll()
      .where('status', '!=', 'deleted')
      .where(eb => {
        const ors = [eb.and([eb('target', '=', 'truck'), eb('truck_id', '=', truckId)])]
        if (headerRow.trailer) ors.push(eb.and([eb('target', '=', 'trailer'), eb('trailer_plate', '=', headerRow.trailer)]))
        if (shownServices.size > 0) ors.push(eb('id', 'in', [...shownServices]))
        return eb.or(ors)
      })
      .execute()) as ServiceRecord[]
    const listHistory = await this.serviceHistory(listRows.map(r => r.id))
    const services = listRows.map(r => toServiceDto(r, nowLocal, listHistory.get(r.id) ?? [])).sort(serviceListOrder)

    return {
      truck: {
        id: truck.id,
        plate: plateToday,
        plates: truck.plates.map(p => ({ plate: p.plate, validFrom: p.validFrom, validTo: p.validTo })),
        carrier: truck.carrier,
        driverId: driverToday?.id ?? null,
        driver: driverToday?.name ?? '',
        phone: driverToday?.phone ?? '',
        driverWarnings: driverToday ? certWarnings(certsByDriver.get(driverToday.id) ?? [], today) : [],
        trailer: headerRow.trailer,
        trailerTypePl: headerRow.trailerTypePl,
        active: truck.active,
        copyText: headerRow.copyText,
        required: headerRow.required,
        driverChanges: [...ctx.drivers.changesOf(truckId)].reverse().map(c => ({
          id: c.id,
          day: c.day,
          driverId: c.driverId,
          driver: ctx.drivers.name(c.driverId),
          createdBy: c.createdBy,
          createdAt: c.createdAt,
        })),
      },
      from: periodFrom,
      to: periodTo,
      today,
      weeks: rows,
      totals,
      orders: orderRows,
      services,
      activeOrder,
    }
  }

  // ---------------------------------------------------------------- services (serwis)

  private async serviceHistory(ids: number[]): Promise<Map<number, ServiceDto['history']>> {
    const map = new Map<number, ServiceDto['history']>()
    if (ids.length === 0) return map
    const rows = await this.db.selectFrom('board_service_changes').selectAll().where('service_id', 'in', ids).orderBy('id').execute()
    for (const r of rows) {
      const list = map.get(r.service_id) ?? []
      list.push({ at: r.created_at, by: r.created_by, text: r.text })
      map.set(r.service_id, list)
    }
    return map
  }

  /** Required services of every tractor and trailer (Flota shows trailers that are not behind a fleet tractor). */
  async requiredServices(): Promise<ServiceDto[]> {
    const rows = (await this.db.selectFrom('board_services').selectAll().where('status', '=', 'required').orderBy('reported_at').execute()) as ServiceRecord[]
    const history = await this.serviceHistory(rows.map(r => r.id))
    const nowLocal = warsawNow(this.now())
    return rows.map(r => toServiceDto(r, nowLocal, history.get(r.id) ?? []))
  }

  private async resolveServiceTarget(target: ServiceTarget, trailerRaw: string | undefined): Promise<string | null> {
    if (target === 'truck') return null
    const raw = (trailerRaw ?? '').trim()
    if (!raw) throw new BoardError('TRAILER_REQUIRED', 'Podaj numer naczepy.')
    const ctx = await loadBoardContext(this.db)
    const plate = ctx.trailers.canonical(raw)
    if (!plate) throw new BoardError('TRAILER_NOT_FOUND', `Nie znam naczepy ${normalizePlate(raw)} — dodaj ją we Flocie.`)
    return plate
  }

  async createService(input: ServiceInput): Promise<number> {
    const truck = await this.db.selectFrom('board_trucks').select('id').where('id', '=', input.truckId).executeTakeFirst()
    if (!truck) throw new BoardError('TRUCK_NOT_FOUND', 'Nie ma takiego auta.', 404)
    const trailerPlate = await this.resolveServiceTarget(input.target, input.trailerPlate)
    const description = (input.description ?? '').trim()
    const place = (input.place ?? '').trim()
    let when: ServiceWhen | null = null
    if (input.status === 'planned') {
      when = whenFromInput(input)
      const problem = validateWhen(when)
      if (problem) throw new BoardError('BAD_SERVICE_DATES', problem)
    } else if (!description) {
      throw new BoardError('EMPTY_SERVICE', 'Wpisz, co trzeba zrobić (np. wymiana oleju).')
    }
    const now = this.now()
    const actor = this.actor()
    const row = await this.db
      .insertInto('board_services')
      .values({
        truck_id: input.truckId,
        target: input.target,
        trailer_plate: trailerPlate,
        status: input.status,
        all_day: when?.allDay ? 1 : 0,
        start_day: when?.startDay ?? null,
        start_time: when && !when.allDay ? when.startTime : null,
        end_day: when?.endDay ?? null,
        end_time: when && !when.allDay ? when.endTime : null,
        description,
        place,
        reported_at: now,
        created_by: actor,
        created_at: now,
        updated_by: actor,
        updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const what = `${targetLabel(input.target, trailerPlate)}${description ? `: ${description}` : ''}`
    await this.logService(
      row.id,
      input.status === 'required' ? `Zgłoszono serwis wymagany (${what}).` : `Dodano serwis (${what}): ${whenLabel(when)}${place ? `, ${place}` : ''}.`,
    )
    return row.id
  }

  /**
   * Edit a service. `status` moves it: required → planned (Zaplanuj, needs dates),
   * planned → required (Odłóż, dates cleared), → cancelled (Odwołaj); a cancelled
   * one can come back. Every change goes to the service history.
   */
  async updateService(id: number, patch: ServicePatch): Promise<void> {
    const row = (await this.db.selectFrom('board_services').selectAll().where('id', '=', id).executeTakeFirst()) as ServiceRecord | undefined
    if (!row || row.status === 'deleted') throw new BoardError('SERVICE_NOT_FOUND', 'Nie ma takiego serwisu.', 404)
    if (row.status === 'cancelled') {
      const other = Object.entries(patch).filter(([k, v]) => k !== 'status' && v !== undefined)
      if (other.length > 0 || patch.status === undefined) throw new BoardError('SERVICE_CANCELLED', 'Odwołany serwis najpierw przywróć, potem zmieniaj.')
    }
    const status = patch.status ?? (row.status as 'required' | 'planned' | 'cancelled')
    const target = patch.target ?? row.target
    const trailerPlate =
      patch.target !== undefined || patch.trailerPlate !== undefined
        ? await this.resolveServiceTarget(target, patch.trailerPlate ?? row.trailer_plate ?? undefined)
        : row.trailer_plate
    const description = patch.description !== undefined ? patch.description.trim() : row.description
    const place = patch.place !== undefined ? patch.place.trim() : row.place
    const oldWhen = whenOf(row)
    let when: ServiceWhen | null = oldWhen
    if (status === 'planned') {
      when = {
        allDay: patch.allDay ?? (oldWhen?.allDay ?? false),
        startDay: patch.startDay ?? oldWhen?.startDay ?? '',
        startTime: patch.startTime !== undefined ? patch.startTime : (oldWhen?.startTime ?? null),
        endDay: patch.endDay ?? oldWhen?.endDay ?? '',
        endTime: patch.endTime !== undefined ? patch.endTime : (oldWhen?.endTime ?? null),
      }
      if (when.allDay) when = { ...when, startTime: null, endTime: null }
      const problem = validateWhen(when)
      if (problem) throw new BoardError('BAD_SERVICE_DATES', problem)
    } else if (status === 'required') {
      when = null
      if (!description) throw new BoardError('EMPTY_SERVICE', 'Wpisz, co trzeba zrobić (np. wymiana oleju).')
    }

    const lines: string[] = []
    if (status !== row.status) {
      if (row.status === 'cancelled') lines.push(`Przywrócono${status === 'planned' ? `: ${whenLabel(when)}` : ' do wymaganych'}.`)
      else if (status === 'planned') lines.push(`Zaplanowano: ${whenLabel(when)}.`)
      else if (status === 'required') lines.push(`Odłożono — wraca do wymaganych (było ${whenLabel(oldWhen)}).`)
      else lines.push('Odwołano.')
    } else if (status === 'planned' && whenLabel(oldWhen) !== whenLabel(when)) {
      lines.push(`Przesunięto: ${whenLabel(oldWhen)} → ${whenLabel(when)}.`)
    }
    if (target !== row.target || trailerPlate !== row.trailer_plate) {
      lines.push(`Dotyczy: ${targetLabel(row.target, row.trailer_plate)} → ${targetLabel(target, trailerPlate)}.`)
    }
    if (description !== row.description) lines.push(`Opis: „${row.description || '—'}” → „${description || '—'}”.`)
    if (place !== row.place) lines.push(`Miejsce: ${row.place || '—'} → ${place || '—'}.`)
    if (lines.length === 0) return

    await this.db
      .updateTable('board_services')
      .set({
        status,
        target,
        trailer_plate: trailerPlate,
        all_day: when?.allDay ? 1 : 0,
        start_day: when?.startDay ?? null,
        start_time: when && !when.allDay ? when.startTime : null,
        end_day: when?.endDay ?? null,
        end_time: when && !when.allDay ? when.endTime : null,
        description,
        place,
        updated_by: this.actor(),
        updated_at: this.now(),
      })
      .where('id', '=', id)
      .execute()
    for (const line of lines) await this.logService(id, line)
  }

  /** "Usuń": entered by mistake — hidden everywhere, the change log keeps it. */
  async deleteService(id: number): Promise<void> {
    const res = await this.db
      .updateTable('board_services')
      .set({ status: 'deleted', updated_by: this.actor(), updated_at: this.now() })
      .where('id', '=', id)
      .where('status', '!=', 'deleted')
      .executeTakeFirst()
    if (Number(res.numUpdatedRows) === 0) throw new BoardError('SERVICE_NOT_FOUND', 'Nie ma takiego serwisu.', 404)
    await this.logService(id, 'Usunięto (wpis przez pomyłkę).')
  }

  private async logService(id: number, text: string): Promise<void> {
    await this.db.insertInto('board_service_changes').values({ service_id: id, text, created_by: this.actor(), created_at: this.now() }).execute()
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
        text: `ręczna poprawka (${ov.field}): ${ov.field.startsWith('driver') ? ctx.drivers.name(Number(ov.value) || null) : ov.value}${ov.active ? '' : ` — zastąpiona: ${ov.superseded_note ?? ''}`}`,
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
        ...((): { driver: string; driverManual: boolean; drivers: Array<{ id: number | null; name: string }> } => {
          const d = legDriversOf(o, l, ctx)
          return { driver: d.text, driverManual: d.manual, drivers: d.drivers.map(x => ({ id: x.id, name: x.name })) }
        })(),
      })),
      notes: notes.map(n => ({ id: n.id, text: n.text, createdBy: n.created_by, createdAt: n.created_at })),
      overrides: overrides
        .filter(ov => ov.active === 1)
        .map(ov => ({
          field: ov.field,
          value: ov.value,
          display: ov.field.startsWith('driver') ? ctx.drivers.name(Number(ov.value) || null) : ov.value,
          createdAt: ov.created_at,
        })),
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
    if (input.kind === 'service') throw new BoardError('USE_SERVICE_FORM', 'Serwis dodaje się formularzem serwisu.')
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
    if (field.startsWith('driver')) {
      const driver = await this.db.selectFrom('board_drivers').select('id').where('id', '=', Number(value) || 0).executeTakeFirst()
      if (!driver) throw new BoardError('DRIVER_NOT_FOUND', 'Wybierz kierowcę z listy.')
    }
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

  // ---------------------------------------------------------------- drivers (kierowcy)

  private filesRoot(): string {
    return this.options.filesDir ?? join('data', 'pliki')
  }

  private certPath(storedName: string): string {
    return join(this.filesRoot(), 'certyfikaty', storedName)
  }

  /** Certificates (kind + valid to) of every driver, for the board warnings. */
  private async certsByDriver(): Promise<Map<number, Array<{ kind: string; validTo: string | null }>>> {
    const rows = await this.db.selectFrom('board_driver_certs').select(['driver_id', 'kind', 'valid_to']).where('deleted', '=', 0).execute()
    const map = new Map<number, Array<{ kind: string; validTo: string | null }>>()
    for (const r of rows) {
      const list = map.get(r.driver_id) ?? []
      list.push({ kind: r.kind, validTo: r.valid_to })
      map.set(r.driver_id, list)
    }
    return map
  }

  async drivers(): Promise<DriverListItem[]> {
    const ctx = await loadBoardContext(this.db)
    const today = this.today()
    const certs = await this.db.selectFrom('board_driver_certs').selectAll().where('deleted', '=', 0).execute()
    const fileCounts = await this.db
      .selectFrom('board_driver_cert_files')
      .select(['cert_id', eb => eb.fn.countAll<number>().as('n')])
      .groupBy('cert_id')
      .execute()
    const filesOf = new Map(fileCounts.map(f => [f.cert_id, Number(f.n)]))
    const truckIds = ctx.fleet.trucks.map(t => t.id)
    return ctx.drivers
      .all()
      .map(d => {
        const own = certs.filter(c => c.driver_id === d.id)
        const avsec = own
          .filter(c => kindKeyOf(c.kind) === 'AVSEC')
          .sort((a, b) => (b.valid_to ?? '9999').localeCompare(a.valid_to ?? '9999'))[0]
        return {
          id: d.id,
          name: d.name,
          phone: d.phone,
          carrier: d.carrier,
          notes: d.notes,
          active: d.active,
          trucks: ctx.drivers.trucksOf(d.id, today, truckIds).map(id => ({ id, plate: ctx.fleet.plateOn(ctx.fleet.byId(id)!, today) })),
          avsec: avsec ? { validTo: avsec.valid_to, number: avsec.number, files: filesOf.get(avsec.id) ?? 0, ...certStatus(avsec.valid_to, today) } : null,
          certCount: own.length,
          warnings: certWarnings(
            own.map(c => ({ kind: c.kind, validTo: c.valid_to })),
            today,
          ),
        }
      })
      .sort((a, b) => Number(b.active) - Number(a.active) || a.carrier.localeCompare(b.carrier, 'pl') || a.name.localeCompare(b.name, 'pl'))
  }

  async driverDetails(id: number): Promise<DriverDetails> {
    const ctx = await loadBoardContext(this.db)
    const d = ctx.drivers.byId.get(id)
    if (!d) throw new BoardError('DRIVER_NOT_FOUND', 'Nie ma takiego kierowcy.', 404)
    const today = this.today()
    const certs = await this.db.selectFrom('board_driver_certs').selectAll().where('driver_id', '=', id).where('deleted', '=', 0).execute()
    const files = certs.length
      ? await this.db
          .selectFrom('board_driver_cert_files')
          .selectAll()
          .where(
            'cert_id',
            'in',
            certs.map(c => c.id),
          )
          .orderBy('id')
          .execute()
      : []
    // Tractors this driver drove: each change to him, until the next change of that tractor.
    const history: DriverDetails['history'] = []
    for (const t of ctx.fleet.trucks) {
      const changes = ctx.drivers.changesOf(t.id)
      changes.forEach((c, i) => {
        if (c.driverId !== id) return
        const next = changes[i + 1]
        history.push({
          truckId: t.id,
          plate: ctx.fleet.plateOn(t, next ? addDays(next.day, -1) : today),
          from: c.day,
          to: next ? addDays(next.day, -1) : null,
        })
      })
    }
    history.sort((a, b) => b.from.localeCompare(a.from))
    return {
      driver: { id: d.id, name: d.name, phone: d.phone, carrier: d.carrier, notes: d.notes, active: d.active },
      trucks: ctx.drivers
        .trucksOf(
          id,
          today,
          ctx.fleet.trucks.map(t => t.id),
        )
        .map(tid => ({ id: tid, plate: ctx.fleet.plateOn(ctx.fleet.byId(tid)!, today) })),
      history,
      certs: certs
        .map(c => ({
          id: c.id,
          kind: c.kind,
          number: c.number,
          validTo: c.valid_to,
          notes: c.notes,
          ...certStatus(c.valid_to, today),
          createdBy: c.created_by,
          updatedBy: c.updated_by,
          updatedAt: c.updated_at,
          files: files
            .filter(f => f.cert_id === c.id)
            .map(f => ({ id: f.id, filename: f.filename, mime: f.mime, size: f.size, uploadedBy: f.uploaded_by, uploadedAt: f.uploaded_at })),
        }))
        .sort((a, b) => (kindKeyOf(a.kind) === 'AVSEC' ? 0 : 1) - (kindKeyOf(b.kind) === 'AVSEC' ? 0 : 1) || (b.validTo ?? '').localeCompare(a.validTo ?? '')),
      warnings: certWarnings(
        certs.map(c => ({ kind: c.kind, validTo: c.valid_to })),
        today,
      ),
    }
  }

  async createDriver(input: { name: string; phone?: string | undefined; carrier?: string | undefined; notes?: string | undefined }): Promise<number> {
    const name = cleanName(input.name)
    if (!name) throw new BoardError('EMPTY_DRIVER', 'Podaj imię i nazwisko kierowcy.')
    const carrier = (input.carrier ?? '').trim()
    const all = await this.db.selectFrom('board_drivers').select(['id', 'name', 'carrier']).execute()
    if (all.some(d => sameName(d.name, name) && sameName(d.carrier, carrier))) {
      throw new BoardError('DRIVER_EXISTS', `${name} już jest na liście kierowców${carrier ? ` (${carrier})` : ''}.`)
    }
    const row = await this.db
      .insertInto('board_drivers')
      .values({ name, phone: (input.phone ?? '').trim(), carrier, notes: (input.notes ?? '').trim(), created_at: this.now() })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  }

  /** Same name and carrier → the existing driver (used when a tractor is added with its driver). */
  private async findOrCreateDriver(input: { name: string; phone: string; carrier: string }): Promise<number> {
    const name = cleanName(input.name)
    const all = await this.db.selectFrom('board_drivers').select(['id', 'name', 'carrier']).execute()
    const found = all.find(d => sameName(d.name, name) && sameName(d.carrier, input.carrier))
    return found ? found.id : this.createDriver(input)
  }

  async updateDriver(id: number, patch: { name?: string | undefined; phone?: string | undefined; carrier?: string | undefined; notes?: string | undefined; active?: boolean | undefined }) {
    const set: Record<string, unknown> = {}
    if (patch.name !== undefined) {
      const name = cleanName(patch.name)
      if (!name) throw new BoardError('EMPTY_DRIVER', 'Podaj imię i nazwisko kierowcy.')
      set['name'] = name
    }
    if (patch.phone !== undefined) set['phone'] = patch.phone.trim()
    if (patch.carrier !== undefined) set['carrier'] = patch.carrier.trim()
    if (patch.notes !== undefined) set['notes'] = patch.notes.trim()
    if (patch.active !== undefined) set['active'] = patch.active ? 1 : 0
    if (Object.keys(set).length === 0) return
    const res = await this.db.updateTable('board_drivers').set(set).where('id', '=', id).executeTakeFirst()
    if (Number(res.numUpdatedRows) === 0) throw new BoardError('DRIVER_NOT_FOUND', 'Nie ma takiego kierowcy.', 404)
  }

  /**
   * Driver of a tractor from a day (one change per tractor and day — a second one replaces it).
   * `driverId` null = no driver. With `releaseOther` the driver leaves any other tractor he is on
   * that day (drivers move between a carrier's tractors).
   */
  async setDriverChange(input: { truckId: number; day: string; driverId: number | null; releaseOther?: boolean | undefined }): Promise<{ released: string[] }> {
    if (!isRealDay(input.day)) throw new BoardError('BAD_DATE', 'Podaj poprawną datę.')
    const truck = await this.db.selectFrom('board_trucks').select('id').where('id', '=', input.truckId).executeTakeFirst()
    if (!truck) throw new BoardError('TRUCK_NOT_FOUND', 'Nie ma takiego auta.', 404)
    if (input.driverId !== null && !(await this.db.selectFrom('board_drivers').select('id').where('id', '=', input.driverId).executeTakeFirst())) {
      throw new BoardError('DRIVER_NOT_FOUND', 'Nie ma takiego kierowcy.', 404)
    }
    const released: string[] = []
    const ctx = await loadBoardContext(this.db)
    const others =
      input.releaseOther && input.driverId !== null
        ? ctx.drivers.trucksOf(
            input.driverId,
            input.day,
            ctx.fleet.trucks.map(t => t.id).filter(id => id !== input.truckId),
          )
        : []
    await this.db.transaction().execute(async trx => {
      const upsert = async (truckId: number, driverId: number | null) =>
        trx
          .insertInto('board_driver_changes')
          .values({ truck_id: truckId, driver_id: driverId, day: input.day, created_by: this.actor(), created_at: this.now() })
          .onConflict(oc => oc.columns(['truck_id', 'day']).doUpdateSet({ driver_id: driverId, created_by: this.actor(), created_at: this.now() }))
          .execute()
      await upsert(input.truckId, input.driverId)
      for (const other of others) {
        await upsert(other, null)
        released.push(ctx.fleet.plateOn(ctx.fleet.byId(other)!, input.day))
      }
    })
    return { released }
  }

  async updateDriverChange(id: number, patch: { day?: string | undefined; driverId?: number | null | undefined }) {
    const row = await this.db.selectFrom('board_driver_changes').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) throw new BoardError('CHANGE_NOT_FOUND', 'Nie ma takiej zmiany kierowcy.', 404)
    const day = patch.day ?? row.day
    if (!isRealDay(day)) throw new BoardError('BAD_DATE', 'Podaj poprawną datę.')
    const driverId = patch.driverId !== undefined ? patch.driverId : row.driver_id
    if (driverId !== null && !(await this.db.selectFrom('board_drivers').select('id').where('id', '=', driverId).executeTakeFirst())) {
      throw new BoardError('DRIVER_NOT_FOUND', 'Nie ma takiego kierowcy.', 404)
    }
    if (day !== row.day) {
      const clash = await this.db.selectFrom('board_driver_changes').select('id').where('truck_id', '=', row.truck_id).where('day', '=', day).executeTakeFirst()
      if (clash) throw new BoardError('CHANGE_EXISTS', 'Tego dnia auto ma już zmianę kierowcy — popraw tamtą albo ją usuń.')
    }
    await this.db
      .updateTable('board_driver_changes')
      .set({ day, driver_id: driverId, created_by: this.actor(), created_at: this.now() })
      .where('id', '=', id)
      .execute()
  }

  async deleteDriverChange(id: number) {
    const res = await this.db.deleteFrom('board_driver_changes').where('id', '=', id).executeTakeFirst()
    if (Number(res.numDeletedRows) === 0) throw new BoardError('CHANGE_NOT_FOUND', 'Nie ma takiej zmiany kierowcy.', 404)
  }

  // ---------------------------------------------------------------- certificates (certyfikaty)

  private certInput(input: { kind?: string | undefined; number?: string | undefined; validTo?: string | null | undefined; notes?: string | undefined }) {
    const out: Record<string, unknown> = {}
    if (input.kind !== undefined) {
      const kind = input.kind.replace(/\s+/g, ' ').trim()
      if (!kind) throw new BoardError('EMPTY_KIND', 'Podaj rodzaj certyfikatu (np. AVSEC).')
      out['kind'] = kindKeyOf(kind) === 'AVSEC' ? 'AVSEC' : kind
    }
    if (input.number !== undefined) out['number'] = input.number.trim()
    if (input.validTo !== undefined) {
      if (input.validTo !== null && !isRealDay(input.validTo)) throw new BoardError('BAD_DATE', 'Podaj poprawną datę ważności.')
      out['valid_to'] = input.validTo
    }
    if (input.notes !== undefined) out['notes'] = input.notes.trim()
    return out
  }

  async createCert(driverId: number, input: { kind: string; number?: string | undefined; validTo?: string | null | undefined; notes?: string | undefined }): Promise<number> {
    if (!(await this.db.selectFrom('board_drivers').select('id').where('id', '=', driverId).executeTakeFirst())) {
      throw new BoardError('DRIVER_NOT_FOUND', 'Nie ma takiego kierowcy.', 404)
    }
    const values = this.certInput(input)
    const now = this.now()
    const row = await this.db
      .insertInto('board_driver_certs')
      .values({
        driver_id: driverId,
        kind: String(values['kind']),
        number: (values['number'] as string | undefined) ?? '',
        valid_to: (values['valid_to'] as string | null | undefined) ?? null,
        notes: (values['notes'] as string | undefined) ?? '',
        created_by: this.actor(),
        created_at: now,
        updated_by: this.actor(),
        updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  }

  async updateCert(id: number, patch: { kind?: string | undefined; number?: string | undefined; validTo?: string | null | undefined; notes?: string | undefined }) {
    const set = this.certInput(patch)
    if (Object.keys(set).length === 0) return
    const res = await this.db
      .updateTable('board_driver_certs')
      .set({ ...set, updated_by: this.actor(), updated_at: this.now() })
      .where('id', '=', id)
      .where('deleted', '=', 0)
      .executeTakeFirst()
    if (Number(res.numUpdatedRows) === 0) throw new BoardError('CERT_NOT_FOUND', 'Nie ma takiego certyfikatu.', 404)
  }

  /** Removes the certificate and its scans from disk (personal data is not kept after a delete). */
  async deleteCert(id: number) {
    const cert = await this.db.selectFrom('board_driver_certs').select('id').where('id', '=', id).where('deleted', '=', 0).executeTakeFirst()
    if (!cert) throw new BoardError('CERT_NOT_FOUND', 'Nie ma takiego certyfikatu.', 404)
    // Scans first: if anything fails, the certificate is still there to retry.
    const files = await this.db.selectFrom('board_driver_cert_files').select('id').where('cert_id', '=', id).execute()
    for (const f of files) await this.deleteCertFile(f.id)
    await this.db.updateTable('board_driver_certs').set({ deleted: 1, updated_by: this.actor(), updated_at: this.now() }).where('id', '=', id).execute()
  }

  async addCertFile(certId: number, filename: string, data: Uint8Array): Promise<number> {
    const cert = await this.db.selectFrom('board_driver_certs').select('id').where('id', '=', certId).where('deleted', '=', 0).executeTakeFirst()
    if (!cert) throw new BoardError('CERT_NOT_FOUND', 'Nie ma takiego certyfikatu.', 404)
    if (data.length === 0) throw new BoardError('EMPTY_FILE', 'Plik jest pusty.')
    if (data.length > CERT_FILE_MAX_BYTES) throw new BoardError('FILE_TOO_BIG', 'Plik jest za duży — najwyżej 15 MB.')
    const type = sniffScan(data)
    if (!type) throw new BoardError('BAD_FILE_TYPE', 'Wgraj skan jako PDF, JPG albo PNG.')
    const storedName = `${randomUUID()}.${type.ext}`
    const path = this.certPath(storedName)
    await mkdir(join(this.filesRoot(), 'certyfikaty'), { recursive: true })
    await writeFile(path, data)
    try {
      const row = await this.db
        .insertInto('board_driver_cert_files')
        .values({
          cert_id: certId,
          filename: cleanFilename(filename, type.ext),
          stored_name: storedName,
          mime: type.mime,
          size: data.length,
          uploaded_by: this.actor(),
          uploaded_at: this.now(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    } catch (error) {
      await rm(path, { force: true })
      throw error
    }
  }

  async certFile(id: number): Promise<{ filename: string; mime: string; data: Buffer }> {
    const row = await this.db
      .selectFrom('board_driver_cert_files')
      .innerJoin('board_driver_certs', 'board_driver_certs.id', 'board_driver_cert_files.cert_id')
      .select(['board_driver_cert_files.filename', 'board_driver_cert_files.stored_name', 'board_driver_cert_files.mime'])
      .where('board_driver_cert_files.id', '=', id)
      .where('board_driver_certs.deleted', '=', 0)
      .executeTakeFirst()
    if (!row) throw new BoardError('FILE_NOT_FOUND', 'Nie ma takiego pliku.', 404)
    try {
      return { filename: row.filename, mime: row.mime, data: await readFile(this.certPath(row.stored_name)) }
    } catch {
      throw new BoardError('FILE_MISSING', 'Pliku nie ma na dysku (folder data\\pliki). Wgraj skan jeszcze raz.', 404)
    }
  }

  async deleteCertFile(id: number) {
    const row = await this.db.selectFrom('board_driver_cert_files').select(['stored_name']).where('id', '=', id).executeTakeFirst()
    if (!row) throw new BoardError('FILE_NOT_FOUND', 'Nie ma takiego pliku.', 404)
    // Remove from disk first (a scan open in a viewer on Windows can refuse — then nothing changes and the user can retry).
    try {
      await rm(this.certPath(row.stored_name), { force: true })
    } catch {
      throw new BoardError('FILE_BUSY', 'Nie udało się usunąć pliku z dysku — zamknij podgląd skanu i spróbuj ponownie.', 409)
    }
    await this.db.deleteFrom('board_driver_cert_files').where('id', '=', id).execute()
  }

  // ---------------------------------------------------------------- registries

  /**
   * Current fleet pasted as text (see fleetList.ts). Without `apply` only the plan is returned,
   * so the user sees every change before it is made.
   */
  async syncFleetList(text: string, apply: boolean): Promise<Omit<FleetPlan, 'operations'> & { applied: boolean }> {
    const ctx = await loadBoardContext(this.db)
    const today = this.now().slice(0, 10)
    const plan = planFleetSync(text, ctx, today)
    const { operations, ...summary } = plan
    if (!apply || plan.errors.length > 0 || operations.length === 0) return { ...summary, applied: false }
    await this.db.transaction().execute(async trx => {
      for (const o of operations) {
        switch (o.op) {
          case 'truck-fixed-trailer':
            await trx.updateTable('board_trucks').set({ trailer_plate: o.trailer }).where('id', '=', o.truckId).execute()
            break
          case 'truck-activate':
            await trx.updateTable('board_trucks').set({ active: 1 }).where('id', '=', o.truckId).execute()
            break
          case 'trailer-add':
            await trx.insertInto('board_trailers').values({ plate: o.plate, carrier: o.carrier }).execute()
            await trx
              .insertInto('board_trailer_aliases')
              .values({ alias: o.plate, trailer_plate: o.plate })
              .onConflict(oc => oc.column('alias').doUpdateSet({ trailer_plate: o.plate }))
              .execute()
            break
          case 'trailer-carrier':
            await trx.updateTable('board_trailers').set({ carrier: o.carrier }).where('plate', '=', o.plate).execute()
            break
          case 'trailer-reactivate':
            await trx.updateTable('board_trailers').set({ active_to: null }).where('plate', '=', o.plate).execute()
            break
          case 'trailer-retire':
            await trx.updateTable('board_trailers').set({ active_to: o.activeTo }).where('plate', '=', o.plate).execute()
            break
        }
      }
    })
    await this.refreshIssues()
    return { ...summary, applied: true }
  }

  async fleet() {
    const ctx = await loadBoardContext(this.db)
    const today = this.today()
    return ctx.fleet.trucks.map(truck => {
      const { driver: _legacyDriver, phone: _legacyPhone, ...t } = truck
      const d = ctx.drivers.driverOn(t.id, today)
      return { ...t, currentPlate: ctx.fleet.plateOn(truck, today), driverId: d?.id ?? null, driver: d?.name ?? '' }
    })
  }

  /** The board's "today": the Polish date. */
  private today(): string {
    return warsawNow(this.now()).slice(0, 10)
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
        trailer_plate: input.trailerPlate ? normalizePlate(input.trailerPlate) : null,
        sort_order: Number(max?.m ?? 0) + 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await this.db.insertInto('board_truck_plates').values({ truck_id: truck.id, plate, valid_from: input.validFrom, valid_to: null }).execute()
    await this.db.deleteFrom('board_ignored_plates').where('plate', '=', plate).execute()
    if (input.driver?.trim()) {
      const driverId = await this.findOrCreateDriver({ name: input.driver, phone: input.phone ?? '', carrier: input.carrier ?? '' })
      await this.setDriverChange({ truckId: truck.id, day: FROM_THE_BEGINNING, driverId })
    }
    return truck.id
  }

  async updateTruck(id: number, patch: { carrier?: string; trailerPlate?: string | null; notes?: string; active?: boolean; sortOrder?: number }) {
    const set: Record<string, unknown> = {}
    if (patch.carrier !== undefined) set['carrier'] = patch.carrier
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
    const today = this.today()
    return ctx.trailers.all().map(t => {
      const fixed = ctx.fleet.trucks.find(tr => tr.trailerPlate === t.plate) ?? null
      return {
        ...t,
        aliases: aliases.filter(a => a.trailer_plate === t.plate && a.alias !== t.plate).map(a => a.alias),
        fixedTruckId: fixed?.id ?? null,
        fixedTruckPlate: fixed ? ctx.fleet.plateOn(fixed, today) : null,
      }
    })
  }

  /**
   * "Stały ciągnik" of a trailer (moved here from the tractor list, 08.10.2026): only for a carrier
   * with one set. null = the trailer rotates; a tractor keeps at most one fixed trailer.
   */
  async setTrailerFixedTruck(rawPlate: string, truckId: number | null) {
    const plate = normalizePlate(rawPlate)
    if (!(await this.db.selectFrom('board_trailers').select('plate').where('plate', '=', plate).executeTakeFirst())) {
      throw new BoardError('TRAILER_NOT_FOUND', `Naczepy ${plate} nie ma w bazie.`, 404)
    }
    if (truckId !== null && !(await this.db.selectFrom('board_trucks').select('id').where('id', '=', truckId).executeTakeFirst())) {
      throw new BoardError('TRUCK_NOT_FOUND', 'Nie ma takiego auta.', 404)
    }
    await this.db.transaction().execute(async trx => {
      await trx.updateTable('board_trucks').set({ trailer_plate: null }).where('trailer_plate', '=', plate).execute()
      if (truckId !== null) await trx.updateTable('board_trucks').set({ trailer_plate: plate }).where('id', '=', truckId).execute()
    })
  }

  /**
   * Add or change a trailer. `carrier`: owning carrier ('' = none); `activeTo`: last day in the
   * fleet (null = back in the fleet, undefined = unchanged; a new trailer starts in the fleet).
   */
  async upsertTrailer(input: {
    plate: string
    typePl?: string | undefined
    typeEn?: string | undefined
    notes?: string | undefined
    carrier?: string | undefined
    activeTo?: string | null | undefined
  }) {
    const plate = normalizePlate(input.plate)
    if (!plate) throw new BoardError('BAD_PLATE', 'Podaj numer naczepy.')
    if (input.activeTo && !/^\d{4}-\d{2}-\d{2}$/.test(input.activeTo)) throw new BoardError('BAD_DATE', 'Podaj datę w formacie RRRR-MM-DD.')
    const changes = {
      ...(input.typePl ? { type_pl: input.typePl } : {}),
      ...(input.typeEn ? { type_en: input.typeEn } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.carrier !== undefined ? { carrier: input.carrier.trim() } : {}),
      ...(input.activeTo !== undefined ? { active_to: input.activeTo } : {}),
    }
    const values = { plate, ...changes }
    const update = changes
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

/** Text for "Kopiuj" (sent to clients in English). */
function copyTextFor(plate: string, trailer: string | null, typeEn: string, driver: DriverRecord | null): string {
  return `Truck ${plate}, Trailer ${trailer ?? '—'} (${typeEn}), Driver: ${driver?.name ?? ''}${driver?.phone ? ` ${formatPhone(driver.phone)}` : ''}`
}

/** Driver(s) of a fleet leg; a manual correction ("driver" / "driver:1" = driver id) wins. */
function legDriversOf(o: ComputedOrder, l: ComputedLeg, ctx: BoardContext): LegDrivers {
  if (l.kind !== 'fleet' || l.truckId === null) return { drivers: [], text: '', manual: false }
  const ov = l.index === 0 ? (o.overrides['driver'] ?? o.overrides['driver:0']) : o.overrides[`driver:${l.index}`]
  const manual = ov ? Number(ov.value) : null
  return ctx.drivers.legDrivers(l.truckId, l.startDate, l.endDate, manual !== null && Number.isInteger(manual) && manual > 0 ? manual : null)
}

/** "Warszawa → Budapeszt (przez Kraków)" */
function legTitle(l: ComputedLeg, ctx: BoardContext): string {
  const from = l.stops[0] ? (ctx.places.name(l.stops[0].code) === '?' ? l.stops[0].raw : ctx.places.name(l.stops[0].code)) : '?'
  const lastStop = l.stops[l.stops.length - 1]
  const to = lastStop ? (lastStop.code ? ctx.places.name(lastStop.code) : lastStop.raw) : '?'
  const middle = l.stops.slice(1, -1).map(st => (st.code ? ctx.places.name(st.code) : st.raw))
  const via = middle.length > 0 ? ` (przez ${middle.join(', ')})` : ''
  return `${from} → ${to}${via}`
}

function legMargin(o: ComputedOrder, l: ComputedLeg): number | null {
  return l.revAlloc !== null && l.amount !== null ? round2(l.revAlloc - l.amount - (l.index === 0 ? o.extraCost : 0)) : null
}

function whenFromInput(input: { allDay?: boolean | undefined; startDay?: string | undefined; startTime?: string | undefined; endDay?: string | undefined; endTime?: string | undefined }): ServiceWhen {
  const allDay = input.allDay === true
  return {
    allDay,
    startDay: input.startDay ?? '',
    startTime: allDay ? null : (input.startTime ?? null),
    endDay: input.endDay ?? input.startDay ?? '',
    endTime: allDay ? null : (input.endTime ?? null),
  }
}

const PHASE_ORDER: Record<string, number> = { required: 0, ongoing: 1, upcoming: 2, done: 3, cancelled: 4 }

/** Required first, then ongoing and upcoming (soonest first), then past ones (latest first). */
function serviceListOrder(a: ServiceDto, b: ServiceDto): number {
  const pa = PHASE_ORDER[a.phase] ?? 9
  const pb = PHASE_ORDER[b.phase] ?? 9
  if (pa !== pb) return pa - pb
  if (a.phase === 'required') return a.reportedAt.localeCompare(b.reportedAt)
  const ka = `${a.startDay ?? ''}T${a.startTime ?? ''}`
  const kb = `${b.startDay ?? ''}T${b.startTime ?? ''}`
  return pa <= 2 ? ka.localeCompare(kb) : kb.localeCompare(ka)
}

function cleanName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** Names compared without case, diacritics and extra spaces. */
function sameName(a: string, b: string): boolean {
  return aliasKey(a) === aliasKey(b)
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
