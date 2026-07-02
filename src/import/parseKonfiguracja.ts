import { parse } from 'csv-parse/sync'
import { parseDecimalInput } from '../domain/money.js'
import { CONFIG_KEYS } from '../repositories/configRepository.js'

/**
 * Parser for the v1 Google Sheet "Konfiguracja" tab export (PRD §6).
 * Sheet values are the source of truth at migration time.
 */

export interface ParsedKonfiguracja {
  /** Values for the config table, keyed by CONFIG_KEYS values. */
  config: Record<string, string>
  variants: Array<{ name: string; monthlyCostEur: number }>
  warnings: string[]
}

/** Parametr-prefix → config key. Exact prefixes from the v1 sheet. */
const PARAM_PREFIXES: Array<{ prefix: string; key: string }> = [
  { prefix: 'Cena paliwa', key: CONFIG_KEYS.fuelPrice },
  { prefix: 'Zużycie paliwa', key: CONFIG_KEYS.consumption },
  { prefix: 'Stawka kierowcy', key: CONFIG_KEYS.driverDayRate },
  { prefix: 'Inne koszty miesięczne', key: CONFIG_KEYS.monthlyOverhead },
  { prefix: 'Dni w miesiącu', key: CONFIG_KEYS.monthDays },
]

const VARIANT_PREFIX = 'Wariant taboru:'
/** Superseded by fleet variants — present in the sheet for history only. */
const LEGACY_PREFIX = 'Koszt taboru Standard'

export function parseKonfiguracja(csvContent: string): ParsedKonfiguracja {
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Array<Record<string, string>>

  const config: Record<string, string> = {}
  const variants: ParsedKonfiguracja['variants'] = []
  const warnings: string[] = []

  for (const record of records) {
    const param = (record['Parametr'] ?? '').trim()
    const rawValue = (record['Wartość'] ?? '').trim()
    if (param === '') continue

    const value = parseDecimalInput(rawValue)
    if (value === null) {
      warnings.push(`Konfiguracja: '${param}' has non-numeric value '${rawValue}' — skipped.`)
      continue
    }

    if (param.startsWith(VARIANT_PREFIX)) {
      const name = param.slice(VARIANT_PREFIX.length).trim()
      if (name === '') {
        warnings.push(`Konfiguracja: fleet variant row with empty name — skipped.`)
        continue
      }
      variants.push({ name, monthlyCostEur: value })
      continue
    }

    if (param.startsWith(LEGACY_PREFIX)) {
      warnings.push(`Konfiguracja: legacy parameter '${param}' skipped (superseded by fleet variants).`)
      continue
    }

    const mapping = PARAM_PREFIXES.find(p => param.startsWith(p.prefix))
    if (!mapping) {
      warnings.push(`Konfiguracja: unknown parameter '${param}' — skipped.`)
      continue
    }
    config[mapping.key] = String(value)
  }

  for (const { key } of PARAM_PREFIXES) {
    if (!(key in config)) warnings.push(`Konfiguracja: required config '${key}' not found in sheet export.`)
  }
  if (config[CONFIG_KEYS.monthDays] !== undefined && config[CONFIG_KEYS.monthDays] !== '30') {
    warnings.push(
      `Konfiguracja: month_days is ${config[CONFIG_KEYS.monthDays]}, but the validated business decision fixes it at 30.`,
    )
  }

  return { config, variants, warnings }
}
