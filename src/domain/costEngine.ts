import type {
  CalculatorConfig,
  CostBreakdown,
  OrderCostInput,
  ProfitAndLoss,
  TollWarnings,
  ValidationIssue,
} from './types.js'
import { roundEur } from './money.js'
import { validateConfig, validateOrderInput } from './validate.js'

/**
 * Cost calculation engine — PRD §2 (VALIDATED formulas, do not change
 * without business sign-off).
 *
 *   total = fuel + highways + fleet + drivers + overhead + ferries/tunnels
 *
 * All component functions return UNROUNDED values; rounding to 2 decimals
 * happens once, at the breakdown boundary. The total is the rounded sum of
 * unrounded components — the same convention as the Sheets prototype.
 */

/** Fuel = total_km × (consumption / 100) × fuel_price. */
export function fuelCost(totalKm: number, config: CalculatorConfig): number {
  return totalKm * (config.fuelConsumptionLPer100Km / 100) * config.fuelPriceEurPerLitre
}

/**
 * Highways = Σ toll_per_country. Manual/stored values only — never computed
 * here (PRD §4.3). Entries with status 'missing' contribute 0.
 */
export function highwaysCost(tolls: OrderCostInput['tolls']): number {
  return tolls.reduce((sum, t) => sum + (t.status === 'missing' ? 0 : t.tollEur), 0)
}

/** Fleet (tabor) = (order_days / month_days) × monthly_fleet_cost. */
export function fleetCost(orderDays: number, fleetMonthlyCostEur: number, config: CalculatorConfig): number {
  return (orderDays / config.monthDays) * fleetMonthlyCostEur
}

/** Drivers = order_days × day_rate × driver_count. */
export function driversCost(orderDays: number, driverCount: number, config: CalculatorConfig): number {
  return orderDays * config.driverDayRateEur * driverCount
}

/** Overhead (inne) = (order_days / month_days) × monthly_overhead. */
export function overheadCost(orderDays: number, config: CalculatorConfig): number {
  return (orderDays / config.monthDays) * config.monthlyOverheadEur
}

function tollWarnings(tolls: OrderCostInput['tolls']): TollWarnings {
  const estimatedCountries = tolls.filter(t => t.status === 'estimate').map(t => t.country)
  const missingCountries = tolls.filter(t => t.status === 'missing').map(t => t.country)
  return {
    estimatedCountries,
    missingCountries,
    usesEstimates: estimatedCountries.length > 0,
    hasMissing: missingCountries.length > 0,
  }
}

function profitAndLoss(revenueEur: number, totalCostRaw: number): ProfitAndLoss {
  const profitRaw = revenueEur - totalCostRaw
  return {
    revenueEur: roundEur(revenueEur),
    profitEur: roundEur(profitRaw),
    marginPct: revenueEur === 0 ? null : roundEur((profitRaw / revenueEur) * 100),
  }
}

export type CalculationResult =
  | { ok: true; breakdown: CostBreakdown }
  | { ok: false; issues: ValidationIssue[] }

/**
 * Calculate the full cost breakdown for an order. Never throws on bad input:
 * invalid inputs return `{ ok: false, issues }` so the UI can render specific
 * inline messages (PRD §5.4 — no raw error states).
 */
export function calculateOrderCost(input: OrderCostInput, config: CalculatorConfig): CalculationResult {
  const issues = [...validateConfig(config), ...validateOrderInput(input)]
  if (issues.length > 0) return { ok: false, issues }

  const fuel = fuelCost(input.totalKm, config)
  const highways = highwaysCost(input.tolls)
  const fleet = fleetCost(input.orderDays, input.fleetMonthlyCostEur, config)
  const drivers = driversCost(input.orderDays, input.driverCount, config)
  const overhead = overheadCost(input.orderDays, config)
  const ferries = input.ferriesTunnelsEur

  const totalRaw = fuel + highways + fleet + drivers + overhead + ferries

  return {
    ok: true,
    breakdown: {
      fuelEur: roundEur(fuel),
      highwaysEur: roundEur(highways),
      fleetEur: roundEur(fleet),
      driversEur: roundEur(drivers),
      overheadEur: roundEur(overhead),
      ferriesTunnelsEur: roundEur(ferries),
      totalEur: roundEur(totalRaw),
      tollWarnings: tollWarnings(input.tolls),
      pnl: input.revenueEur === undefined ? null : profitAndLoss(input.revenueEur, totalRaw),
    },
  }
}
