import { calculateOrderCost, type CountryToll, type DriverCount, type ValidationIssue } from '../domain/index.js'
import type { CalculationRepository, CalculationSnapshot, SavedCalculation } from '../repositories/calculationRepository.js'
import type { ConfigRepository } from '../repositories/configRepository.js'
import type { FleetVariantRepository } from '../repositories/fleetVariantRepository.js'
import type { RouteDetails, RouteRepository } from '../repositories/routeRepository.js'

/**
 * Saving a calculation (PRD §5.2/§5.3 history): the SNAPSHOT IS BUILT
 * SERVER-SIDE from the stored route, current config, and current variant —
 * never trusted from the client — then frozen. Config changes afterwards
 * must not alter it.
 */

export class CalculationSaveError extends Error {
  constructor(
    readonly code: 'ROUTE_NOT_FOUND' | 'VARIANT_NOT_FOUND' | 'INVALID_INPUT',
    message: string,
    readonly issues: ValidationIssue[] = [],
  ) {
    super(message)
    this.name = 'CalculationSaveError'
  }
}

export interface SaveCalculationInput {
  routeCode: string
  days: number
  drivers: DriverCount
  fleetVariantId: number
  ferriesEur: number
  tunnelsEur: number
  revenueEur?: number
  createdBy: string
}

export interface CalculationServiceDeps {
  routes: RouteRepository
  variants: FleetVariantRepository
  config: ConfigRepository
  calculations: CalculationRepository
}

/** Route tolls → domain tolls: verified/estimate rows plus explicit 'missing'
 *  entries for driven countries without a toll value. */
export function routeTollsToDomain(route: RouteDetails): CountryToll[] {
  return [
    ...route.tolls.map(t => ({ country: t.country, tollEur: t.tollEur, status: t.status })),
    ...route.tollsPendingCountries.map(country => ({ country, tollEur: 0, status: 'missing' as const })),
  ]
}

export class CalculationService {
  constructor(private readonly deps: CalculationServiceDeps) {}

  async saveCalculation(input: SaveCalculationInput): Promise<SavedCalculation & { routeCode: string }> {
    const route = await this.deps.routes.findByCode(input.routeCode.trim().toUpperCase())
    if (!route) {
      throw new CalculationSaveError('ROUTE_NOT_FOUND', 'Route not in database — save the route first.')
    }
    const variant = await this.deps.variants.findById(input.fleetVariantId)
    if (!variant) {
      throw new CalculationSaveError('VARIANT_NOT_FOUND', 'Unknown fleet variant.')
    }

    const config = await this.deps.config.getCalculatorConfig()
    const result = calculateOrderCost(
      {
        totalKm: route.totalKm,
        orderDays: input.days,
        driverCount: input.drivers,
        fleetMonthlyCostEur: variant.monthlyCostEur,
        tolls: routeTollsToDomain(route),
        ferriesTunnelsEur: input.ferriesEur + input.tunnelsEur,
        ...(input.revenueEur !== undefined ? { revenueEur: input.revenueEur } : {}),
      },
      config,
    )
    if (!result.ok) {
      throw new CalculationSaveError('INVALID_INPUT', 'Calculation input is invalid.', result.issues)
    }

    const snapshot: CalculationSnapshot = {
      input: {
        routeCode: route.routeCode,
        totalKm: route.totalKm,
        orderDays: input.days,
        driverCount: input.drivers,
        fleetVariantName: variant.name,
        fleetMonthlyCostEur: variant.monthlyCostEur,
        ferriesEur: input.ferriesEur,
        tunnelsEur: input.tunnelsEur,
        ...(input.revenueEur !== undefined ? { revenueEur: input.revenueEur } : {}),
      },
      config,
      breakdown: result.breakdown,
    }

    const id = await this.deps.calculations.create({
      routeId: route.id,
      days: input.days,
      drivers: input.drivers,
      fleetVariantId: variant.id,
      ferriesEur: input.ferriesEur,
      tunnelsEur: input.tunnelsEur,
      ...(input.revenueEur !== undefined ? { revenueEur: input.revenueEur } : {}),
      snapshot,
      createdBy: input.createdBy,
    })

    const saved = await this.deps.calculations.findById(id)
    if (!saved) throw new Error('Calculation disappeared right after creation.')
    return { ...saved, routeCode: route.routeCode }
  }
}
