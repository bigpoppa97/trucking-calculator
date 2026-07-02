import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import type { CalculatorConfig } from '../domain/types.js'
import type { TollVehicleProfile } from '../here/hereRoutingClient.js'

/** Config keys per PRD §5.2. The config table is the source of truth. */
export const CONFIG_KEYS = {
  fuelPrice: 'fuel_price',
  consumption: 'consumption',
  driverDayRate: 'driver_day_rate',
  monthlyOverhead: 'monthly_overhead',
  monthDays: 'month_days',
  /** Single global toll vehicle profile (PRD §4.3) — JSON value. */
  tollVehicleProfile: 'toll_vehicle_profile',
} as const

export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS]

export class ConfigRepository {
  constructor(private readonly db: Kysely<DB>) {}

  async getAll(): Promise<Record<string, string>> {
    const rows = await this.db.selectFrom('config').selectAll().execute()
    return Object.fromEntries(rows.map(r => [r.key, r.value]))
  }

  async setMany(values: Record<string, string>): Promise<void> {
    await this.db.transaction().execute(async trx => {
      for (const [key, value] of Object.entries(values)) {
        await trx
          .insertInto('config')
          .values({ key, value })
          .onConflict(oc => oc.column('key').doUpdateSet({ value }))
          .execute()
      }
    })
  }

  /**
   * Load the typed calculator config. Throws with a specific message when a
   * key is missing or non-numeric — callers surface it as an explicit
   * "configuration incomplete" state, never a silent default.
   */
  async getCalculatorConfig(): Promise<CalculatorConfig> {
    const all = await this.getAll()
    const num = (key: ConfigKey): number => {
      const raw = all[key]
      if (raw === undefined) throw new Error(`Configuration incomplete: missing '${key}'.`)
      const value = Number(raw)
      if (!Number.isFinite(value)) throw new Error(`Configuration invalid: '${key}' is not a number.`)
      return value
    }
    return {
      fuelPriceEurPerLitre: num(CONFIG_KEYS.fuelPrice),
      fuelConsumptionLPer100Km: num(CONFIG_KEYS.consumption),
      driverDayRateEur: num(CONFIG_KEYS.driverDayRate),
      monthlyOverheadEur: num(CONFIG_KEYS.monthlyOverhead),
      monthDays: num(CONFIG_KEYS.monthDays),
    }
  }

  /**
   * The single global toll vehicle profile (PRD §4.3). Seeded by migration
   * 0002; missing or malformed JSON is a hard error, not a silent default.
   */
  async getTollVehicleProfile(): Promise<TollVehicleProfile> {
    const row = await this.db
      .selectFrom('config')
      .select('value')
      .where('key', '=', CONFIG_KEYS.tollVehicleProfile)
      .executeTakeFirst()
    if (!row) throw new Error(`Configuration incomplete: missing '${CONFIG_KEYS.tollVehicleProfile}'.`)
    let parsed: unknown
    try {
      parsed = JSON.parse(row.value)
    } catch {
      throw new Error(`Configuration invalid: '${CONFIG_KEYS.tollVehicleProfile}' is not valid JSON.`)
    }
    const profile = parsed as Partial<TollVehicleProfile>
    if (
      typeof profile.axleCount !== 'number' ||
      typeof profile.grossWeightKg !== 'number' ||
      typeof profile.emissionType !== 'string'
    ) {
      throw new Error(`Configuration invalid: '${CONFIG_KEYS.tollVehicleProfile}' is missing required fields.`)
    }
    return { axleCount: profile.axleCount, grossWeightKg: profile.grossWeightKg, emissionType: profile.emissionType }
  }
}
