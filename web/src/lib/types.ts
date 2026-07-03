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
  kmNote: string | null
  kmUpdatedBy: string | null
  kmUpdatedAt: string | null
  countryKm: Record<string, number>
  tolls: RouteTollDto[]
  tollsPendingCountries: string[]
}

export interface RouteSummaryDto {
  id: number
  routeCode: string
  totalKm: number
  kmSource: 'here' | 'manual'
  createdAt: string
  tollsPending: boolean
  hasEstimates: boolean
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

import type { CostBreakdown, DriverCount } from '@domain'

export interface CalculationSnapshotDto {
  input: {
    routeCode: string
    totalKm: number
    orderDays: number
    driverCount: DriverCount
    fleetVariantName: string
    fleetMonthlyCostEur: number
    ferriesEur: number
    tunnelsEur: number
    revenueEur?: number
  }
  config: CalculatorConfig
  breakdown: CostBreakdown
}

export interface CalculationDto {
  id: number
  routeCode: string
  days: number
  drivers: number
  fleetVariantId: number
  ferriesEur: number
  tunnelsEur: number
  revenueEur: number | null
  snapshot: CalculationSnapshotDto
  createdBy: string
  createdAt: string
}

export interface SaveCalculationInput {
  routeCode: string
  days: number
  drivers: DriverCount
  fleetVariantId: number
  ferriesEur: number
  tunnelsEur: number
  revenueEur?: number
}

export type { CalculatorConfig }
