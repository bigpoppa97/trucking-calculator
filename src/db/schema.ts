import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely'

/**
 * Database schema per PRD §5.2 (normalized).
 *
 * SQLite storage notes (kept portable for the later Postgres swap):
 * - JSON(B) columns are stored as TEXT holding JSON; repositories parse/stringify.
 * - Booleans are INTEGER 0/1; repositories convert to/from boolean.
 * - Enums are TEXT with CHECK constraints.
 * - Timestamps are ISO-8601 TEXT (UTC).
 */

export type KmSource = 'here' | 'manual'
export type TollStatusDb = 'estimate' | 'verified'
export type UserRole = 'dispatcher' | 'finance' | 'admin'
export type TollRuleType = 'replace_per_gate' | 'scale'

export interface AirportsTable {
  iata: string // PK, 3-letter IATA code
  name: string
  city: string
  country: string // ISO 3166-1 alpha-2
  lat: number
  lon: number
}

export interface RoutesTable {
  id: Generated<number>
  route_code: string // UNIQUE, e.g. 'WAW-BER-FRA'
  stops: string // JSON array of IATA codes
  total_km: number
  km_source: KmSource
  created_by: string
  created_at: ColumnType<string, string | undefined, never>
  // Manual km override audit (PRD §5.3)
  km_note: ColumnType<string | null, string | null | undefined, string | null>
  km_updated_by: ColumnType<string | null, string | null | undefined, string | null>
  km_updated_at: ColumnType<string | null, string | null | undefined, string | null>
  /** JSON array of {polyline, spans} per HERE section; NULL = no shape stored. */
  polyline_encoded: ColumnType<string | null, string | null | undefined, string | null>
}

export interface RouteCountryKmTable {
  route_id: number
  country: string // ISO alpha-2
  km: number
}

export interface RouteCountryTollTable {
  route_id: number
  country: string // ISO alpha-2
  toll_eur: number
  status: TollStatusDb
  fetched_at: string | null
  vehicle_profile: string | null // JSON snapshot of the toll vehicle profile
  verified_by: string | null
  verified_at: string | null
}

export interface FleetVariantsTable {
  id: Generated<number>
  name: string // UNIQUE
  monthly_cost_eur: number
  active: number // 0/1
}

export interface ConfigTable {
  key: string // PK: fuel_price, consumption, driver_day_rate, monthly_overhead, month_days
  value: string
}

export interface CalculationsTable {
  id: Generated<number>
  route_id: number
  days: number
  drivers: number
  fleet_variant_id: number
  ferries_eur: number
  tunnels_eur: number
  revenue_eur: number | null
  snapshot: string // JSON: frozen full cost breakdown at calculation time
  created_by: string
  created_at: ColumnType<string, string | undefined, never>
}

export interface UsersTable {
  id: Generated<number>
  email: string // UNIQUE, lowercase
  display_name: string
  password_hash: string // scrypt, format: scrypt$N$r$p$saltHex$hashHex
  role: UserRole
  active: number // 0/1
  created_at: ColumnType<string, string | undefined, never>
}

export interface SessionsTable {
  token: string // PK, opaque random token
  user_id: number
  created_at: string
  expires_at: string
}

export interface TollSystemRulesTable {
  id: Generated<number>
  toll_system: string // UNIQUE — HERE tollSystem name, matched case-insensitively
  rule_type: TollRuleType
  value: number // per-gate price in the fare's original currency, or scale factor
  note: string | null
  updated_by: string | null
  updated_at: string | null
}

export interface RouteWaypointsTable {
  id: Generated<number>
  route_code: string // by CODE, not FK — definable before the route is fetched
  seq: number // ordering along the journey; intermediate airport stops sit at (index+1)*1000
  name: string
  lat: number
  lon: number
}

// ---------------------------------------------------------------------------
// Tablica floty (board) — migration 0009.
// ---------------------------------------------------------------------------

type Created = ColumnType<string, string | undefined, never>
type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>

export type DistanceSource = 'here' | 'manual' | 'estimate' | 'calculator'
export type PlaceKind = 'airport' | 'custom'
export type ImportMode = 'daily' | 'history'
export type NoteScope = 'order' | 'truck_day' | 'truck'
export type NoteKind = 'note' | 'pause' | 'service' | 'driver' | 'trailer' | 'position'
export type IssueStatus = 'open' | 'resolved' | 'ignored'

export interface BoardTrucksTable {
  id: Generated<number>
  carrier: ColumnType<string, string | undefined, string>
  driver: ColumnType<string, string | undefined, string>
  phone: ColumnType<string, string | undefined, string>
  trailer_plate: Nullable<string>
  notes: ColumnType<string, string | undefined, string>
  active: ColumnType<number, number | undefined, number>
  sort_order: ColumnType<number, number | undefined, number>
  created_at: Created
}

export interface BoardTruckPlatesTable {
  id: Generated<number>
  truck_id: number
  plate: string
  valid_from: string // YYYY-MM-DD
  valid_to: Nullable<string> // YYYY-MM-DD, inclusive; null = still valid
}

export interface BoardTrailersTable {
  plate: string
  type_pl: ColumnType<string, string | undefined, string>
  type_en: ColumnType<string, string | undefined, string>
  notes: ColumnType<string, string | undefined, string>
}

export interface BoardTrailerAliasesTable {
  alias: string
  trailer_plate: string
}

export interface BoardPlacesTable {
  code: string
  name: string
  country: ColumnType<string, string | undefined, string>
  lat: number
  lon: number
  kind: PlaceKind
}

export interface BoardPlaceAliasesTable {
  alias: string
  place_code: string
}

export interface BoardDistancesTable {
  from_code: string
  to_code: string
  km: number
  source: DistanceSource
  note: Nullable<string>
  updated_at: ColumnType<string, string | undefined, string>
}

export interface BoardOwnPlatesTable {
  plate: string
  last_seen: string
}

export interface BoardIgnoredPlatesTable {
  plate: string
  reason: ColumnType<string, string | undefined, string>
  created_at: Created
}

export interface BoardImportsTable {
  id: Generated<number>
  filename: string
  imported_at: string
  mode: ImportMode
  rows_total: number
  rows_in_scope: number
  range_from: Nullable<string>
  range_to: Nullable<string>
  summary: string // JSON
}

export interface BoardOrdersTable {
  order_no: string
  client: string
  client_ref: string
  status_client: string
  status_sped: string
  carrier: string
  sub_plate: string
  own_plate: string
  trailer_raw: string
  load_places: string
  load_country: string
  load_date: string
  unload_places: string
  unload_country: string
  unload_date: string
  rev_eur: number | null
  cost_eur: number | null
  notes_app: string
  history: ColumnType<number, number | undefined, number>
  first_import_id: number
  last_import_id: number
  missing_since_import_id: Nullable<number>
  created_at: Created
  updated_at: ColumnType<string, string | undefined, string>
}

export interface BoardOrderChangesTable {
  id: Generated<number>
  order_no: string
  import_id: Nullable<number>
  field: string
  old_value: Nullable<string>
  new_value: Nullable<string>
  created_at: string
}

export interface BoardOverridesTable {
  id: Generated<number>
  order_no: string
  field: string
  value: string
  app_value: Nullable<string>
  created_by: string
  created_at: string
  active: ColumnType<number, number | undefined, number>
  superseded_at: Nullable<string>
  superseded_note: Nullable<string>
}

export interface BoardNotesTable {
  id: Generated<number>
  scope: NoteScope
  order_no: Nullable<string>
  truck_id: Nullable<number>
  day: Nullable<string>
  kind: NoteKind
  text: string
  place_code: Nullable<string>
  created_by: string
  created_at: string
  deleted: ColumnType<number, number | undefined, number>
}

export interface BoardIssuesTable {
  id: Generated<number>
  key: string
  kind: string
  ref: string
  message: string
  details: ColumnType<string, string | undefined, string>
  fingerprint: ColumnType<string, string | undefined, string>
  status: IssueStatus
  created_at: string
  updated_at: string
  resolved_by: Nullable<string>
  resolution: Nullable<string>
}

export interface DB {
  airports: AirportsTable
  routes: RoutesTable
  route_country_km: RouteCountryKmTable
  route_country_toll: RouteCountryTollTable
  fleet_variants: FleetVariantsTable
  config: ConfigTable
  calculations: CalculationsTable
  users: UsersTable
  sessions: SessionsTable
  toll_system_rules: TollSystemRulesTable
  route_waypoints: RouteWaypointsTable

  board_trucks: BoardTrucksTable
  board_truck_plates: BoardTruckPlatesTable
  board_trailers: BoardTrailersTable
  board_trailer_aliases: BoardTrailerAliasesTable
  board_places: BoardPlacesTable
  board_place_aliases: BoardPlaceAliasesTable
  board_distances: BoardDistancesTable
  board_own_plates: BoardOwnPlatesTable
  board_ignored_plates: BoardIgnoredPlatesTable
  board_imports: BoardImportsTable
  board_orders: BoardOrdersTable
  board_order_changes: BoardOrderChangesTable
  board_overrides: BoardOverridesTable
  board_notes: BoardNotesTable
  board_issues: BoardIssuesTable
}

export type AirportRow = Selectable<AirportsTable>
export type NewAirport = Insertable<AirportsTable>
export type RouteRow = Selectable<RoutesTable>
export type RouteCountryKmRow = Selectable<RouteCountryKmTable>
export type RouteCountryTollRow = Selectable<RouteCountryTollTable>
export type FleetVariantRow = Selectable<FleetVariantsTable>
export type FleetVariantUpdate = Updateable<FleetVariantsTable>
export type CalculationRow = Selectable<CalculationsTable>
export type UserRow = Selectable<UsersTable>
export type SessionRow = Selectable<SessionsTable>
export type TollSystemRuleRow = Selectable<TollSystemRulesTable>
