import { parse } from 'csv-parse/sync'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { parseDecimalInput } from '../domain/money.js'
import { AirportRepository, type Airport } from '../repositories/airportRepository.js'

/**
 * Import for the ~113-airport dataset from v1 (PRD §3.1, §6; originally
 * derived from OurAirports public domain data).
 *
 * Expected CSV header (case-insensitive): iata,name,city,country,lat,lon
 * The v1 export file has not been provided yet — this importer is ready to
 * run as soon as it is: `npm run import:airports -- path/to/airports.csv`.
 */

export interface ImportAirportsReport {
  imported: number
  warnings: string[]
}

export async function importAirports(db: Kysely<DB>, csvContent: string): Promise<ImportAirportsReport> {
  const records = parse(csvContent, {
    columns: header => (header as string[]).map(h => h.trim().toLowerCase()),
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
