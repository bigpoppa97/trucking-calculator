import { ApiError, reportUnauthenticated } from '../lib/api.js'

/** Client for /api/board — mirrors src/board/boardService.ts DTOs. */

export type NoteKind = 'note' | 'pause' | 'service' | 'driver' | 'trailer' | 'position'

export interface WeekBar {
  key: string
  orderNo: string
  legIndex: number
  legCount: number
  title: string
  startDate: string
  endDate: string
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
  /** Set when the truck is in service all day on a day of this leg. */
  serviceConflict: string | null
}

export type ServiceTarget = 'truck' | 'trailer'
export type ServicePhase = 'required' | 'upcoming' | 'ongoing' | 'done' | 'cancelled'

export interface Service {
  id: number
  truckId: number | null
  target: ServiceTarget
  trailerPlate: string | null
  status: 'required' | 'planned' | 'cancelled'
  phase: ServicePhase
  allDay: boolean
  startDay: string | null
  startTime: string | null
  endDay: string | null
  endTime: string | null
  /** e.g. "14.10 08:00–10:00"; '' while required. */
  when: string
  description: string
  place: string
  reportedAt: string
  createdBy: string
  updatedBy: string
  updatedAt: string
  history: Array<{ at: string; by: string; text: string }>
}

export interface ServiceInput {
  truckId: number
  target: ServiceTarget
  trailerPlate?: string
  status: 'required' | 'planned'
  description?: string
  place?: string
  allDay?: boolean
  startDay?: string
  startTime?: string
  endDay?: string
  endTime?: string
}

export interface ServicePatch {
  status?: 'required' | 'planned' | 'cancelled'
  target?: ServiceTarget
  trailerPlate?: string
  description?: string
  place?: string
  allDay?: boolean
  startDay?: string
  startTime?: string | null
  endDay?: string
  endTime?: string | null
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
  /** Planned services in this week (service strip). */
  services: Service[]
  /** Required services (no date yet) of the tractor and of the trailer behind it. */
  required: Service[]
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
}

export interface TruckView {
  truck: {
    id: number
    plate: string
    plates: Array<{ plate: string; validFrom: string; validTo: string | null }>
    carrier: string
    driver: string
    phone: string
    trailer: string | null
    trailerTypePl: string
    active: boolean
    copyText: string
    required: Service[]
  }
  from: string
  to: string
  today: string
  weeks: Array<{ weekStart: string; weekEnd: string; weekNumber: number; days: string[]; row: WeekTruck }>
  totals: { revenue: number; cost: number; margin: number; km: number; kmEmpty: number; legs: number; kmEstimated: boolean; services: number }
  orders: TruckOrderRow[]
  services: Service[]
  activeOrder: { orderNo: string; title: string; startDate: string; endDate: string; upcoming: boolean } | null
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

export interface OrderDetails {
  order: {
    orderNo: string
    client: string
    clientRef: string
    carrier: string
    statusClient: string
    statusSped: string
    loadDate: string
    unloadDate: string
    route: string
    rev: number | null
    costApp: number | null
    amountsTotal: number | null
    extraCost: number
    margin: number | null
    marginPct: number | null
    excluded: string | null
    noCarrier: boolean
    missing: boolean
    notesApp: string
    prz: { place: string; placeCode: string | null; date: string; from: string; to: string; amountFrom: number; amountTo: number; raw: string } | null
    przErrors: string[]
    trailer: string | null
  }
  legs: Array<{
    index: number
    plate: string
    kind: 'fleet' | 'own' | 'other'
    truckId: number | null
    stops: string[]
    from: string
    to: string
    startDate: string
    endDate: string
    amount: number | null
    revAlloc: number | null
    kmLoaded: number | null
    kmEmpty: number | null
    kmEmptyFrom: string | null
    kmEstimated: boolean
  }>
  notes: Array<{ id: number; text: string; createdBy: string; createdAt: string }>
  overrides: Array<{ field: string; value: string; createdAt: string }>
  issues: Array<{ id: number; kind: string; message: string }>
  history: Array<{ at: string; text: string }>
}

export interface ImportSummary {
  importId: number
  filename: string
  mode: 'daily' | 'history'
  importedAt: string
  rowsTotal: number
  rowsInScope: number
  rowsOwnFleet: number
  rowsOtherCarriers: number
  rangeFrom: string | null
  rangeTo: string | null
  created: string[]
  updated: Array<{ orderNo: string; changes: Array<{ field: string; from: string | null; to: string | null }> }>
  unchanged: number
  disappeared: string[]
  reappeared: string[]
  supersededOverrides: Array<{ orderNo: string; field: string }>
  newTruckCandidates: Array<{ plate: string; carrier: string; orders: number }>
  warnings: string[]
}

export interface Issue {
  id: number
  key: string
  kind: string
  ref: string
  message: string
  details: Record<string, unknown>
  status: 'open' | 'resolved' | 'ignored'
  created_at: string
  updated_at: string
}

export interface FleetTruck {
  id: number
  carrier: string
  driver: string
  phone: string
  trailerPlate: string | null
  notes: string
  active: boolean
  sortOrder: number
  plates: Array<{ id: number; plate: string; validFrom: string; validTo: string | null }>
  currentPlate: string
}

export interface Trailer {
  plate: string
  typePl: string
  typeEn: string
  notes: string
  /** Owning carrier ('' = not assigned). */
  carrier: string
  /** Last day in the fleet; null = in the fleet. */
  activeTo: string | null
  aliases: string[]
}

export interface FleetSyncResult {
  changes: string[]
  warnings: string[]
  errors: string[]
  applied: boolean
}

export interface Place {
  code: string
  name: string
  country: string
  lat: number
  lon: number
  kind: 'airport' | 'custom'
  aliases: string[]
}

export interface GeocodeCandidate {
  title: string
  lat: number
  lon: number
  country: string
}

export interface Thresholds {
  marginWarnPct: number
  revPerKmMin: number
  revPerKmMax: number
}

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(
      url,
      body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    )
  } catch {
    throw new ApiError('NETWORK', 'Brak połączenia z serwerem tablicy. Sprawdź, czy okno „Kalkulator kosztow - serwer” jest uruchomione.')
  }
  if (!response.ok) {
    let code = 'HTTP_ERROR'
    let message = 'Serwer zwrócił błąd. Spróbuj ponownie.'
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } }
      if (payload.error?.code) code = payload.error.code
      if (payload.error?.message) message = payload.error.message
    } catch {
      // keep generic message
    }
    if (response.status === 401 && code === 'UNAUTHENTICATED') reportUnauthenticated()
    throw new ApiError(code, message, response.status)
  }
  return (await response.json()) as T
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

export const boardApi = {
  week: (date: string) => call<WeekView>('GET', `/api/board/week?date=${date}`),
  order: (orderNo: string) => call<OrderDetails>('GET', `/api/board/orders/${encodeURIComponent(orderNo)}`),
  addNote: (orderNo: string, text: string) => call('POST', `/api/board/orders/${encodeURIComponent(orderNo)}/notes`, { text }),
  deleteNote: (id: number) => call('DELETE', `/api/board/notes/${id}`),
  setOverride: (orderNo: string, field: string, value: string) =>
    call('POST', `/api/board/orders/${encodeURIComponent(orderNo)}/overrides`, { field, value }),
  clearOverride: (orderNo: string, field: string) =>
    call('DELETE', `/api/board/orders/${encodeURIComponent(orderNo)}/overrides/${encodeURIComponent(field)}`),
  addEvent: (input: { truckId: number; day: string; kind: NoteKind; text: string; place?: string }) => call('POST', '/api/board/events', input),
  truckView: (id: number, from: string, to: string) => call<TruckView>('GET', `/api/board/trucks/${id}/view?from=${from}&to=${to}`),
  requiredServices: async () => (await call<{ services: Service[] }>('GET', '/api/board/services/required')).services,
  createService: async (input: ServiceInput) => (await call<{ id: number }>('POST', '/api/board/services', input)).id,
  updateService: (id: number, patch: ServicePatch) => call('PATCH', `/api/board/services/${id}`, patch),
  deleteService: (id: number) => call('DELETE', `/api/board/services/${id}`),
  async importFile(file: File, mode: 'daily' | 'history'): Promise<ImportSummary> {
    const dataBase64 = toBase64(await file.arrayBuffer())
    return (await call<{ summary: ImportSummary }>('POST', '/api/board/import', { filename: file.name, mode, dataBase64 })).summary
  },
  imports: async () => (await call<{ imports: Array<{ id: number; filename: string; imported_at: string; summary: ImportSummary }> }>('GET', '/api/board/imports')).imports,
  issues: async () => (await call<{ issues: Issue[] }>('GET', '/api/board/issues')).issues,
  resolveIssue: (id: number, action: string, payload: Record<string, unknown> = {}) =>
    call('POST', `/api/board/issues/${id}/resolve`, { action, payload }),
  fleet: async () => (await call<{ trucks: FleetTruck[] }>('GET', '/api/board/fleet')).trucks,
  createTruck: (input: { plate: string; validFrom: string; carrier?: string; driver?: string; phone?: string; trailerPlate?: string }) =>
    call('POST', '/api/board/fleet', input),
  updateTruck: (id: number, patch: Partial<{ carrier: string; driver: string; phone: string; trailerPlate: string | null; notes: string; active: boolean; sortOrder: number }>) =>
    call('PATCH', `/api/board/fleet/${id}`, patch),
  addPlate: (id: number, plate: string, validFrom: string) => call('POST', `/api/board/fleet/${id}/plates`, { plate, validFrom }),
  trailers: async () => (await call<{ trailers: Trailer[] }>('GET', '/api/board/trailers')).trailers,
  saveTrailer: (input: { plate: string; typePl?: string; typeEn?: string; carrier?: string; activeTo?: string | null }) => call('POST', '/api/board/trailers', input),
  syncFleet: (text: string, apply: boolean) => call<FleetSyncResult>('POST', '/api/board/fleet/sync', { text, apply }),
  addTrailerAlias: (alias: string, trailer: string) => call('POST', '/api/board/trailers/aliases', { alias, trailer }),
  places: async () => (await call<{ places: Place[] }>('GET', '/api/board/places')).places,
  createPlace: async (input: { code?: string; name: string; country?: string; lat: number; lon: number }) =>
    (await call<{ code: string }>('POST', '/api/board/places', input)).code,
  addPlaceAlias: (alias: string, code: string) => call('POST', '/api/board/places/aliases', { alias, code }),
  setDistance: (from: string, to: string, km: number, note?: string) =>
    call('PUT', '/api/board/distances', { from, to, km, ...(note ? { note } : {}) }),
  geocode: async (q: string) => (await call<{ candidates: GeocodeCandidate[] }>('GET', `/api/board/geocode?q=${encodeURIComponent(q)}`)).candidates,
  thresholds: async () => (await call<{ thresholds: Thresholds }>('GET', '/api/board/thresholds')).thresholds,
  saveThresholds: async (t: Partial<Thresholds>) => (await call<{ thresholds: Thresholds }>('PUT', '/api/board/thresholds', t)).thresholds,
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}
