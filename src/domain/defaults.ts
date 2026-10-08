import type { CalculatorConfig } from './types.js'

/**
 * Seed/default values. At runtime the config table (Phase 2) is the source
 * of truth — these exist for seeding and tests only.
 */

export const DEFAULT_CONFIG: CalculatorConfig = {
  fuelPriceEurPerLitre: 1.4, // PRD §2.1 default
  fuelConsumptionLPer100Km: 28, // PRD §2.1 default
  driverDayRateEur: 160, // PRD §2.1
  // PRD §2.1: "currently ~€3,012/month — confirm current value at build time".
  // PLACEHOLDER pending confirmation; migration imports the Konfiguracja tab value.
  monthlyOverheadEur: 3012,
  monthDays: 24, // finance-editable denominator (2026-07 business sign-off); default = working days
}

/**
 * Current fleet variants (PRD §2.2 + kickoff confirmed business facts).
 * Modeled as data, not an enum — more variants may be added later.
 * Phase 2 seeds the fleet_variants table from this list.
 */
export const FLEET_VARIANT_SEED: ReadonlyArray<{ name: string; monthlyCostEur: number }> = [
  { name: 'standard cooler', monthlyCostEur: 2750 },
  { name: 'mega COOL', monthlyCostEur: 4500 },
  { name: 'mega curtain', monthlyCostEur: 3200 },
]
