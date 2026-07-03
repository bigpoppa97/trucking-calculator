import { parse } from 'csv-parse/sync'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { parseDecimalInput } from '../domain/money.js'
import { AirportRepository, type Airport } from '../repositories/airportRepository.js'

/**
 * Import for the ~113-airport dataset from v1 (PRD §3.1, §6; originally
 * derived from OurAirports public domain data).
 *
 * Expected CSV header (case-insensitive): iata,name,city,country,lat,lon —
 * `latitude`/`longitude` are accepted as aliases (the v1 export uses them).
 */

export interface ImportAirportsReport {
  imported: number
  warnings: string[]
}

export async function importAirports(db: Kysely<DB>, csvContent: string): Promise<ImportAirportsReport> {
  const HEADER_ALIASES: Record<string, string> = { latitude: 'lat', longitude: 'lon' }
  const records = parse(csvContent, {
    columns: header =>
      (header as string[]).map(h => {
        const key = h.trim().toLowerCase()
        return HEADER_ALIASES[key] ?? key
      }),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Array<Record<string, string>>

  const warnings: string[] = []
  const airports: Airport[] = []

  for (const record of records) {
    const iata = (record['iata'] ?? '').trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(iata)) {
      warnings.push(`Airports: invalid IATA code '${record['iata']}' — row skipped.`)
      continue
    }
    const lat = parseDecimalInput(record['lat'] ?? '')
    const lon = parseDecimalInput(record['lon'] ?? '')
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      warnings.push(`Airports: ${iata} has invalid coordinates — row skipped.`)
      continue
    }
    const name = (record['name'] ?? '').trim()
    const city = (record['city'] ?? '').trim()
    const country = (record['country'] ?? '').trim().toUpperCase()
    if (name === '' || country.length !== 2) {
      warnings.push(`Airports: ${iata} missing name or valid alpha-2 country — row skipped.`)
      continue
    }
    airports.push({ iata, name, city, country, lat, lon })
  }

  const repo = new AirportRepository(db)
  const imported = await repo.upsertMany(airports)
  return { imported, warnings }
}
