import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { FleetVariantRepository } from '../repositories/fleetVariantRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { parseKonfiguracja } from './parseKonfiguracja.js'
import { parseTrasy } from './parseTrasy.js'

/**
 * One-time v1 → v2 import (PRD §6): Konfiguracja tab → config + fleet
 * variants; Trasy tab → routes, route_country_km, route_country_toll.
 *
 * Idempotent: config and variants are upserted; routes already present
 * (by route_code) are skipped, never overwritten — the database may hold
 * newer manual corrections than the sheet.
 */

export interface ImportV1Options {
  trasyCsv: string
  konfiguracjaCsv: string
  /** Recorded in created_by / verified_by audit fields. */
  actor?: string
  now?: () => string
}

export interface ImportV1Report {
  configKeysApplied: string[]
  variantsUpserted: string[]
  routesInserted: string[]
  routesSkippedExisting: string[]
  tollsImportedVerified: number
  tollsLeftPending: number
  warnings: string[]
}

export async function importV1(db: Kysely<DB>, options: ImportV1Options): Promise<ImportV1Report> {
  const actor = options.actor ?? 'v1-import'
  const now = options.now ?? (() => new Date().toISOString())

  const konfiguracja = parseKonfiguracja(options.konfiguracjaCsv)
  const trasy = parseTrasy(options.trasyCsv)
  const warnings = [...konfiguracja.warnings, ...trasy.warnings]

  const configRepo = new ConfigRepository(db)
  const variantRepo = new FleetVariantRepository(db)
  const routeRepo = new RouteRepository(db)

  await configRepo.setMany(konfiguracja.config)
  for (const variant of konfiguracja.variants) {
    await variantRepo.upsertByName(variant.name, variant.monthlyCostEur, true)
  }

  const routesInserted: string[] = []
  const routesSkippedExisting: string[] = []
  let tollsImportedVerified = 0
  let tollsLeftPending = 0

  for (const route of trasy.routes) {
    if (await routeRepo.existsByCode(route.routeCode)) {
      routesSkippedExisting.push(route.routeCode)
      continue
    }
    const timestamp = now()
    await routeRepo.create({
      routeCode: route.routeCode,
      totalKm: route.totalKm,
      // Sheet distances are company-validated driven distances, not API output.
      kmSource: 'manual',
      createdBy: actor,
      countryKm: route.countryKm,
      tolls: route.tolls.map(t => ({
        country: t.country,
        tollEur: t.tollEur,
        status: 'verified' as const,
        verifiedBy: actor,
        verifiedAt: timestamp,
      })),
    })
    routesInserted.push(route.routeCode)
    tollsImportedVerified += route.tolls.length
    tollsLeftPending += route.pendingTollCountries.length
  }

  return {
    configKeysApplied: Object.keys(konfiguracja.config),
    variantsUpserted: konfiguracja.variants.map(v => v.name),
    routesInserted,
    routesSkippedExisting,
    tollsImportedVerified,
    tollsLeftPending,
    warnings,
  }
}
