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

export interface DB {
  airports: AirportsTable
  routes: RoutesTable
  route_country_km: RouteCountryKmTable
  route_country_toll: RouteCountryTollTable
  fleet_variants: FleetVariantsTable
  config: ConfigTable
  calculations: CalculationsTable
}

export type AirportRow = Selectable<AirportsTable>
export type NewAirport = Insertable<AirportsTable>
export type RouteRow = Selectable<RoutesTable>
export type RouteCountryKmRow = Selectable<RouteCountryKmTable>
export type RouteCountryTollRow = Selectable<RouteCountryTollTable>
export type FleetVariantRow = Selectable<FleetVariantsTable>
export type FleetVariantUpdate = Updateable<FleetVariantsTable>
export type CalculationRow = Selectable<CalculationsTable>
