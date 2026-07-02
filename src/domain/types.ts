/**
 * Domain types for the trucking cost calculation engine.
 * Formulas and conventions per PRD §2 (VALIDATED — do not change without business sign-off).
 */

/** Drivers per order are constrained to 1 or 2 (PRD §2.1, §5.4). */
export type DriverCount = 1 | 2

/**
 * Toll trust tiers (PRD §4.3):
 * - verified: human-confirmed against invoice/EETS rate — authoritative
 * - estimate: auto-fetched from HERE, unverified — used only when no verified value exists
 * - missing:  no value available — calculation proceeds with a visible warning
 */
export type TollStatus = 'verified' | 'estimate' | 'missing'

/** One per-country toll line for the order's route. */
export interface CountryToll {
  /** ISO 3166-1 alpha-2 country code, e.g. 'PL', 'DE'. */
  country: string
  /** Toll amount in EUR. Ignored (treated as 0) when status is 'missing'. */
  tollEur: number
  status: TollStatus
}

/**
 * Global calculation configuration (PRD §5.2 `config` table).
 * All values editable by finance; the config store is the source of truth.
 */
export interface CalculatorConfig {
  /** EUR per litre. Default 1.40. */
  fuelPriceEurPerLitre: number
  /** Litres per 100 km. Default 28. */
  fuelConsumptionLPer100Km: number
  /** EUR per driver per day. Default 160. */
  driverDayRateEur: number
  /** Static monthly overhead ("inne") in EUR, set by finance. */
  monthlyOverheadEur: number
  /**
   * Month denominator for prorations. FIXED at 30 by validated business
   * decision (PRD §2.1) — not calendar-aware. Do not change.
   */
  monthDays: number
}

/** Inputs describing a single order to be costed. */
export interface OrderCostInput {
  /** Total route distance in km (from route DB, HERE, or manual override). */
  totalKm: number
  /** Order duration in days. Minimum 0.5, step 0.5 (PRD §5.4). */
  orderDays: number
  driverCount: DriverCount
  /**
   * Monthly leasing cost of the selected fleet variant in EUR.
   * Variants are data (a table), not an enum (PRD §2.2) — the engine
   * receives the resolved monthly cost, never a variant name.
   */
  fleetMonthlyCostEur: number
  /** Per-country tolls for the route. May be empty. */
  tolls: CountryToll[]
  /** Manual EUR input per order, e.g. Helsinki ferry €220, Mont Blanc €450. */
  ferriesTunnelsEur: number
  /** Optional revenue for P&L. Omit/undefined when not entered. */
  revenueEur?: number
}

/** Warnings about toll data quality, surfaced with every calculation (PRD §4.3). */
export interface TollWarnings {
  /** Countries whose toll used an unverified HERE estimate. */
  estimatedCountries: string[]
  /** Countries with no toll value at all (contributed €0 to the total). */
  missingCountries: string[]
  /** True when at least one estimate-based toll entered the calculation. */
  usesEstimates: boolean
  /** True when at least one country had no toll value. */
  hasMissing: boolean
}

/** Optional P&L result (PRD §2.1). Present only when revenue was entered. */
export interface ProfitAndLoss {
  revenueEur: number
  /** revenue − total cost, rounded to 2 decimals. */
  profitEur: number
  /**
   * profit / revenue as a percentage, rounded to 2 decimals.
   * Null when revenue is 0 (margin undefined).
   */
  marginPct: number | null
}

/**
 * Full cost breakdown for an order. All *Eur fields are rounded to 2 decimals
 * for display. `totalEur` is the ROUNDED SUM OF UNROUNDED components — the
 * same convention as the Sheets prototype, which sums raw cell values.
 * Rounded components may therefore differ from `totalEur` by ≤ €0.01·n.
 */
export interface CostBreakdown {
  fuelEur: number
  highwaysEur: number
  fleetEur: number
  driversEur: number
  overheadEur: number
  ferriesTunnelsEur: number
  totalEur: number
  tollWarnings: TollWarnings
  pnl: ProfitAndLoss | null
}

/** A single input validation problem, mappable to an inline UI message (PRD §5.4). */
export interface ValidationIssue {
  field: string
  code: string
  /** English default message; UI may localise by `code`. */
  message: string
}
