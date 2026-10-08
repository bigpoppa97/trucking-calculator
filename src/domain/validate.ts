import type { CalculatorConfig, OrderCostInput, ValidationIssue } from './types.js'

/**
 * Input validation per PRD §5.4. Every failure produces a specific,
 * field-addressable issue — never a raw error state.
 */

const EPSILON = 1e-9

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** True when `days` is a positive multiple of 0.5 (min 0.5, step 0.5). */
export function isValidOrderDays(days: number): boolean {
  if (!isFiniteNumber(days) || days < 0.5) return false
  const doubled = days * 2
  return Math.abs(doubled - Math.round(doubled)) < EPSILON
}

export function validateConfig(config: CalculatorConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!isFiniteNumber(config.fuelPriceEurPerLitre) || config.fuelPriceEurPerLitre <= 0) {
    issues.push({ field: 'fuelPriceEurPerLitre', code: 'config.fuelPrice.invalid', message: 'Fuel price must be a positive number.' })
  }
  if (!isFiniteNumber(config.fuelConsumptionLPer100Km) || config.fuelConsumptionLPer100Km <= 0) {
    issues.push({ field: 'fuelConsumptionLPer100Km', code: 'config.consumption.invalid', message: 'Fuel consumption must be a positive number.' })
  }
  if (!isFiniteNumber(config.driverDayRateEur) || config.driverDayRateEur < 0) {
    issues.push({ field: 'driverDayRateEur', code: 'config.driverRate.invalid', message: 'Driver day rate must be zero or more.' })
  }
  if (!isFiniteNumber(config.monthlyOverheadEur) || config.monthlyOverheadEur < 0) {
    issues.push({ field: 'monthlyOverheadEur', code: 'config.overhead.invalid', message: 'Monthly overhead must be zero or more.' })
  }
  // Finance-editable since 2026-07 (business sign-off; overrides the original
  // PRD §2.1 fixed-30 decision). Must be a whole number of days in 1..31.
  if (!Number.isInteger(config.monthDays) || config.monthDays < 1 || config.monthDays > 31) {
    issues.push({ field: 'monthDays', code: 'config.monthDays.invalid', message: 'Month denominator must be a whole number between 1 and 31.' })
  }
  return issues
}

export function validateOrderInput(input: OrderCostInput): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (!isFiniteNumber(input.totalKm) || input.totalKm <= 0) {
    issues.push({ field: 'totalKm', code: 'order.totalKm.invalid', message: 'Total distance must be a positive number of kilometres.' })
  }
  if (!isValidOrderDays(input.orderDays)) {
    issues.push({ field: 'orderDays', code: 'order.days.invalid', message: 'Days must be at least 0.5, in steps of 0.5.' })
  }
  if (input.driverCount !== 1 && input.driverCount !== 2) {
    issues.push({ field: 'driverCount', code: 'order.drivers.invalid', message: 'Driver count must be 1 or 2.' })
  }
  if (!isFiniteNumber(input.fleetMonthlyCostEur) || input.fleetMonthlyCostEur < 0) {
    issues.push({ field: 'fleetMonthlyCostEur', code: 'order.fleetCost.invalid', message: 'Fleet monthly cost must be zero or more.' })
  }
  if (!isFiniteNumber(input.ferriesTunnelsEur) || input.ferriesTunnelsEur < 0) {
    issues.push({ field: 'ferriesTunnelsEur', code: 'order.ferries.invalid', message: 'Ferries/tunnels amount must be zero or more.' })
  }
  input.tolls.forEach((toll, i) => {
    if (toll.status !== 'missing' && (!isFiniteNumber(toll.tollEur) || toll.tollEur < 0)) {
      issues.push({ field: `tolls[${i}].tollEur`, code: 'order.toll.invalid', message: `Toll for ${toll.country} must be zero or more.` })
    }
  })
  if (input.revenueEur !== undefined && (!isFiniteNumber(input.revenueEur) || input.revenueEur < 0)) {
    issues.push({ field: 'revenueEur', code: 'order.revenue.invalid', message: 'Revenue must be zero or more.' })
  }

  return issues
}
