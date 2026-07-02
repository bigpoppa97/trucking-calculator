import { describe, expect, it } from 'vitest'
import {
  calculateOrderCost,
  driversCost,
  fleetCost,
  fuelCost,
  highwaysCost,
  overheadCost,
} from './costEngine.js'
import { roundEur } from './money.js'
import { DEFAULT_CONFIG, FLEET_VARIANT_SEED } from './defaults.js'
import type { CalculatorConfig, OrderCostInput } from './types.js'

/**
 * Reference case from the validated Sheets prototype (kickoff Phase 1):
 * WAW-PRG, 680 km, 1 day, 1 driver, tolls €137.00,
 * 28 L/100 km at €1.40/L, OLD €3,500 fleet cost, OLD €1,122 overhead.
 */
const PROTOTYPE_CONFIG: CalculatorConfig = {
  fuelPriceEurPerLitre: 1.4,
  fuelConsumptionLPer100Km: 28,
  driverDayRateEur: 160,
  monthlyOverheadEur: 1122,
  monthDays: 30,
}

const WAW_PRG: OrderCostInput = {
  totalKm: 680,
  orderDays: 1,
  driverCount: 1,
  fleetMonthlyCostEur: 3500,
  tolls: [
    { country: 'PL', tollEur: 62, status: 'verified' },
    { country: 'CZ', tollEur: 75, status: 'verified' },
  ],
  ferriesTunnelsEur: 0,
}

describe('validated prototype reference case (WAW-PRG)', () => {
  it('fuel: 680 km × 28/100 × €1.40 = €266.56', () => {
    expect(roundEur(fuelCost(680, PROTOTYPE_CONFIG))).toBe(266.56)
  })

  it('reproduces the full prototype breakdown', () => {
    const result = calculateOrderCost(WAW_PRG, PROTOTYPE_CONFIG)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.breakdown.fuelEur).toBe(266.56)
    expect(result.breakdown.highwaysEur).toBe(137.0)
    expect(result.breakdown.fleetEur).toBe(116.67) // 3500 / 30
    expect(result.breakdown.driversEur).toBe(160.0) // 1 × 160 × 1
    expect(result.breakdown.overheadEur).toBe(37.4) // 1122 / 30
    expect(result.breakdown.ferriesTunnelsEur).toBe(0)
    // Rounded sum of unrounded components:
    // 266.56 + 137 + 116.666… + 160 + 37.4 = 717.626… → 717.63
    expect(result.breakdown.totalEur).toBe(717.63)
  })

  it('computes P&L when revenue is entered', () => {
    const result = calculateOrderCost({ ...WAW_PRG, revenueEur: 900 }, PROTOTYPE_CONFIG)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.breakdown.pnl).not.toBeNull()
    expect(result.breakdown.pnl?.profitEur).toBe(182.37) // 900 − 717.626…
    expect(result.breakdown.pnl?.marginPct).toBe(20.26) // 182.373… / 900
  })

  it('omits P&L when revenue is not entered', () => {
    const result = calculateOrderCost(WAW_PRG, PROTOTYPE_CONFIG)
    expect(result.ok && result.breakdown.pnl).toBeNull()
  })
})

describe('current config values (kickoff confirmed facts)', () => {
  it('fleet variant costs: standard cooler €2,750 / mega COOL €4,500 / mega curtain €3,200', () => {
    expect(FLEET_VARIANT_SEED).toEqual([
      { name: 'standard cooler', monthlyCostEur: 2750 },
      { name: 'mega COOL', monthlyCostEur: 4500 },
      { name: 'mega curtain', monthlyCostEur: 3200 },
    ])
  })

  it('WAW-PRG with current defaults and mega COOL variant', () => {
    const megaCool = FLEET_VARIANT_SEED[1]!
    const result = calculateOrderCost(
      { ...WAW_PRG, fleetMonthlyCostEur: megaCool.monthlyCostEur },
      DEFAULT_CONFIG,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.breakdown.fuelEur).toBe(266.56)
    expect(result.breakdown.fleetEur).toBe(150.0) // 4500 / 30
    expect(result.breakdown.overheadEur).toBe(100.4) // 3012 / 30
    expect(result.breakdown.totalEur).toBe(813.96)
  })
})

describe('cost components', () => {
  it('drivers: order_days × 160 × driver_count', () => {
    expect(driversCost(2, 2, PROTOTYPE_CONFIG)).toBe(640)
    expect(driversCost(0.5, 1, PROTOTYPE_CONFIG)).toBe(80)
  })

  it('fleet and overhead prorate over a FIXED 30-day month', () => {
    expect(roundEur(fleetCost(15, 3000, PROTOTYPE_CONFIG))).toBe(1500)
    expect(roundEur(overheadCost(3, { ...PROTOTYPE_CONFIG, monthlyOverheadEur: 3000 }))).toBe(300)
  })

  it('highways sums verified and estimate tolls; missing contributes 0', () => {
    expect(
      highwaysCost([
        { country: 'DE', tollEur: 120.5, status: 'verified' },
        { country: 'CZ', tollEur: 40.25, status: 'estimate' },
        { country: 'SK', tollEur: 0, status: 'missing' },
      ]),
    ).toBeCloseTo(160.75, 10)
  })

  it('half-day orders are supported (min 0.5, step 0.5)', () => {
    const result = calculateOrderCost({ ...WAW_PRG, orderDays: 1.5 }, PROTOTYPE_CONFIG)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.breakdown.driversEur).toBe(240)
    expect(result.breakdown.fleetEur).toBe(175) // 1.5/30 × 3500
  })
})

describe('toll trust tiers (PRD §4.3)', () => {
  it('flags estimate-based tolls in the output', () => {
    const result = calculateOrderCost(
      {
        ...WAW_PRG,
        tolls: [
          { country: 'PL', tollEur: 62, status: 'verified' },
          { country: 'CZ', tollEur: 75, status: 'estimate' },
        ],
      },
      PROTOTYPE_CONFIG,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.breakdown.tollWarnings.usesEstimates).toBe(true)
    expect(result.breakdown.tollWarnings.estimatedCountries).toEqual(['CZ'])
    expect(result.breakdown.tollWarnings.hasMissing).toBe(false)
  })

  it('proceeds with a visible warning when a toll is missing', () => {
    const result = calculateOrderCost(
      {
        ...WAW_PRG,
        tolls: [
          { country: 'PL', tollEur: 62, status: 'verified' },
          { country: 'CZ', tollEur: 0, status: 'missing' },
        ],
      },
      PROTOTYPE_CONFIG,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.breakdown.highwaysEur).toBe(62)
    expect(result.breakdown.tollWarnings.hasMissing).toBe(true)
    expect(result.breakdown.tollWarnings.missingCountries).toEqual(['CZ'])
  })
})

describe('validation — no raw error states (PRD §5.4)', () => {
  it.each([
    [0, 'order.days.invalid'],
    [0.25, 'order.days.invalid'],
    [1.3, 'order.days.invalid'],
    [-1, 'order.days.invalid'],
  ])('rejects days=%s', (days, code) => {
    const result = calculateOrderCost({ ...WAW_PRG, orderDays: days }, PROTOTYPE_CONFIG)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(i => i.code)).toContain(code)
  })

  it('rejects driver counts other than 1 or 2', () => {
    const result = calculateOrderCost(
      { ...WAW_PRG, driverCount: 3 as unknown as 1 },
      PROTOTYPE_CONFIG,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(i => i.code)).toContain('order.drivers.invalid')
  })

  it('rejects non-positive distance and negative money fields', () => {
    const result = calculateOrderCost(
      { ...WAW_PRG, totalKm: 0, ferriesTunnelsEur: -5, revenueEur: -1 },
      PROTOTYPE_CONFIG,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    const codes = result.issues.map(i => i.code)
    expect(codes).toContain('order.totalKm.invalid')
    expect(codes).toContain('order.ferries.invalid')
    expect(codes).toContain('order.revenue.invalid')
  })

  it('rejects a config whose month denominator is not 30', () => {
    const result = calculateOrderCost(WAW_PRG, { ...PROTOTYPE_CONFIG, monthDays: 31 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(i => i.code)).toContain('config.monthDays.notThirty')
  })

  it('P&L margin is null when revenue is 0 (no division by zero)', () => {
    const result = calculateOrderCost({ ...WAW_PRG, revenueEur: 0 }, PROTOTYPE_CONFIG)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.breakdown.pnl?.profitEur).toBe(-717.63)
    expect(result.breakdown.pnl?.marginPct).toBeNull()
  })
})
