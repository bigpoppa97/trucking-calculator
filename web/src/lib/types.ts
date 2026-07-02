import type { CalculatorConfig, TollStatus } from '@domain'

/** DTOs mirroring the portal backend responses (src/server/app.ts). */

export interface FleetVariantDto {
  id: number
  name: string
  monthlyCostEur: number
  active: boolean
}

export interface AirportDto {
  iata: string
  name: string
  city: string
  country: string
  lat: number
  lon: number
}

export interface RouteTollDto {
  country: string
  tollEur: number
  status: Exclude<TollStatus, 'missing'>
  fetchedAt: string | null
  verifiedBy: string | null
  verifiedAt: string | null
}

export interface RouteDetailsDto {
  id: number
  routeCode: string
  stops: string[]
  totalKm: number
  kmSource: 'here' | 'manual'
  countryKm: Record<string, number>
  tolls: RouteTollDto[]
  tollsPendingCountries: string[]
}

export interface VehicleProfileDto {
  axleCount: number
  grossWeightKg: number
  emissionType: string
}

export interface FetchedRouteDto {
  routeCode: string
  stops: string[]
  totalKm: number
  countryKm: Record<string, number>
  tollEstimates: Record<string, number>
  vehicleProfile: VehicleProfileDto
  fetchedAt: string
  warnings: string[]
}

export type { CalculatorConfig }
