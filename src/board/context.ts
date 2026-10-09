import type { Kysely } from 'kysely'
import type { DB, PlaceKind } from '../db/schema.js'
import { DriverIndex } from './drivers.js'
import { aliasKey, editDistance, foldDiacritics, normalizePlate, splitPlaces } from './normalize.js'

/**
 * In-memory indexes over the board's reference data (fleet, trailers,
 * places, own-fleet plates). Loaded once per request/import — the data set is
 * small (8 trucks, dozens of trailers, ~100 places).
 */

export interface TruckPlate {
  id: number
  plate: string
  validFrom: string
  validTo: string | null
}

export interface TruckRecord {
  id: number
  carrier: string
  driver: string
  phone: string
  trailerPlate: string | null
  notes: string
  active: boolean
  sortOrder: number
  plates: TruckPlate[]
}

export interface PlaceRecord {
  code: string
  name: string
  country: string
  lat: number
  lon: number
  kind: PlaceKind
}

export interface TrailerRecord {
  plate: string
  typePl: string
  typeEn: string
  notes: string
  /** Owning carrier ('' = not assigned). Trailers rotate between a carrier's tractors. */
  carrier: string
  /** Last day in the fleet (YYYY-MM-DD); null = still in the fleet. */
  activeTo: string | null
}

export class FleetIndex {
  constructor(readonly trucks: TruckRecord[]) {}

  /** Truck that carried this plate on the given day (null = not ours on that day). */
  truckFor(plate: string, date: string): TruckRecord | null {
    const p = normalizePlate(plate)
    if (!p) return null
    for (const truck of this.trucks) {
      for (const tp of truck.plates) {
        if (tp.plate === p && tp.validFrom <= date && (tp.validTo === null || tp.validTo >= date)) return truck
      }
    }
    return null
  }

  /** Plate belongs to the fleet at any time (used for PRZ scope checks). */
  isFleetPlate(plate: string): boolean {
    const p = normalizePlate(plate)
    return this.trucks.some(t => t.plates.some(tp => tp.plate === p))
  }

  byId(id: number): TruckRecord | undefined {
    return this.trucks.find(t => t.id === id)
  }

  /** Plate valid on a day, else the most recent one. */
  plateOn(truck: TruckRecord, date: string): string {
    const valid = truck.plates.find(tp => tp.validFrom <= date && (tp.validTo === null || tp.validTo >= date))
    if (valid) return valid.plate
    const sorted = [...truck.plates].sort((a, b) => b.validFrom.localeCompare(a.validFrom))
    return sorted[0]?.plate ?? '—'
  }

  /** Carrier names of active trucks (alias keys), for "new truck of a fleet carrier" detection. */
  carrierKeys(): Set<string> {
    return new Set(this.trucks.filter(t => t.active && t.carrier).map(t => carrierKey(t.carrier)))
  }
}

/** Carrier names are compared folded; "ABC Transport Jan Kowalski" matches "ABC Transport" (one is a word-prefix of the other). */
export function carrierKey(name: string): string {
  return aliasKey(name)
}

export function sameCarrier(a: string, b: string): boolean {
  const ka = carrierKey(a)
  const kb = carrierKey(b)
  if (!ka || !kb) return false
  return ka === kb || ka.startsWith(kb + ' ') || kb.startsWith(ka + ' ')
}

export class TrailerIndex {
  private readonly aliases = new Map<string, string>()
  private readonly byPlate = new Map<string, TrailerRecord>()

  constructor(trailers: TrailerRecord[], aliases: Array<{ alias: string; plate: string }>) {
    for (const t of trailers) {
      this.byPlate.set(t.plate, t)
      this.aliases.set(normalizePlate(t.plate), t.plate)
    }
    for (const a of aliases) this.aliases.set(normalizePlate(a.alias), a.plate)
  }

  /** Canonical trailer plate for a raw export value, or null when unknown. */
  canonical(raw: string): string | null {
    const key = normalizePlate(raw)
    if (!key) return null
    return this.aliases.get(key) ?? null
  }

  get(plate: string): TrailerRecord | undefined {
    return this.byPlate.get(plate)
  }

  all(): TrailerRecord[] {
    return [...this.byPlate.values()]
  }

  /** Trailer was in the fleet on that day (unknown plates are never "active"). */
  isActiveOn(plate: string, date: string): boolean {
    const t = this.byPlate.get(plate)
    return t !== undefined && (t.activeTo === null || t.activeTo >= date)
  }

  /** Trailers currently in the fleet of this carrier (word-prefix carrier match). */
  poolOf(carrier: string): string[] {
    if (!carrier) return []
    return [...this.byPlate.values()]
      .filter(t => t.activeTo === null && t.carrier && sameCarrier(t.carrier, carrier))
      .map(t => t.plate)
      .sort()
  }

  /** Closest trailers in the fleet to an unknown or retired spelling ("KN96PE" → KN960PE). */
  suggest(raw: string, limit = 3): string[] {
    const key = normalizePlate(raw)
    return [...this.byPlate.values()]
      .filter(t => t.activeTo === null && t.plate !== key)
      .map(t => ({ plate: t.plate, d: editDistance(key, normalizePlate(t.plate)) }))
      .filter(x => x.d <= 2)
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map(x => x.plate)
  }
}

export class PlaceIndex {
  private readonly aliases = new Map<string, string>()
  readonly places = new Map<string, PlaceRecord>()

  constructor(places: PlaceRecord[], aliases: Array<{ alias: string; code: string }>) {
    for (const p of places) {
      this.places.set(p.code, p)
      this.aliases.set(aliasKey(p.code), p.code)
      this.aliases.set(aliasKey(p.name), p.code)
    }
    for (const a of aliases) this.aliases.set(a.alias, a.code)
  }

  /** Place code for a raw name from the export or a PRZ entry, or null. */
  resolve(raw: string): string | null {
    const key = aliasKey(raw)
    if (!key) return null
    const direct = this.aliases.get(key)
    if (direct) return direct
    // "NOWA WIEŚ 55-080" → try without a trailing postcode
    const noPostcode = key.replace(/\s*\d{2}\s?\d{3}$/, '').trim()
    if (noPostcode !== key) {
      const hit = this.aliases.get(noPostcode)
      if (hit) return hit
    }
    return null
  }

  get(code: string): PlaceRecord | undefined {
    return this.places.get(code)
  }

  name(code: string | null): string {
    if (!code) return '?'
    return this.places.get(code)?.name ?? code
  }

  /** Similar known places for an unknown name. */
  suggest(raw: string, limit = 3): PlaceRecord[] {
    const key = aliasKey(raw)
    const scored = new Map<string, number>()
    for (const [alias, code] of this.aliases) {
      const d = editDistance(key, alias)
      const threshold = Math.max(2, Math.floor(alias.length / 4))
      if (d <= threshold || (key.length >= 4 && alias.startsWith(key)) || (alias.length >= 4 && key.startsWith(alias))) {
        const prev = scored.get(code)
        if (prev === undefined || d < prev) scored.set(code, d)
      }
    }
    return [...scored.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([code]) => this.places.get(code)!)
      .filter(Boolean)
  }

  /** Resolve every "+"-separated part; unknown parts come back as null with the raw text. */
  resolveList(raw: string): Array<{ raw: string; code: string | null }> {
    return splitPlaces(raw).map(part => ({ raw: part, code: this.resolve(part) }))
  }
}

export interface BoardContext {
  fleet: FleetIndex
  drivers: DriverIndex
  trailers: TrailerIndex
  places: PlaceIndex
  ownPlates: Set<string>
  ignoredPlates: Set<string>
}

export async function loadBoardContext(db: Kysely<DB>): Promise<BoardContext> {
  const [trucks, plates, trailers, trailerAliases, places, placeAliases, own, ignored, drivers, driverChanges] = await Promise.all([
    db.selectFrom('board_trucks').selectAll().orderBy('sort_order').orderBy('id').execute(),
    db.selectFrom('board_truck_plates').selectAll().execute(),
    db.selectFrom('board_trailers').selectAll().execute(),
    db.selectFrom('board_trailer_aliases').selectAll().execute(),
    db.selectFrom('board_places').selectAll().execute(),
    db.selectFrom('board_place_aliases').selectAll().execute(),
    db.selectFrom('board_own_plates').select('plate').execute(),
    db.selectFrom('board_ignored_plates').select('plate').execute(),
    db.selectFrom('board_drivers').selectAll().execute(),
    db.selectFrom('board_driver_changes').selectAll().execute(),
  ])
  const fleet = new FleetIndex(
    trucks.map(t => ({
      id: t.id,
      carrier: t.carrier,
      driver: t.driver,
      phone: t.phone,
      trailerPlate: t.trailer_plate,
      notes: t.notes,
      active: t.active === 1,
      sortOrder: t.sort_order,
      plates: plates
        .filter(p => p.truck_id === t.id)
        .map(p => ({ id: p.id, plate: p.plate, validFrom: p.valid_from, validTo: p.valid_to }))
        .sort((a, b) => a.validFrom.localeCompare(b.validFrom)),
    })),
  )
  return {
    fleet,
    drivers: new DriverIndex(
      drivers.map(d => ({ id: d.id, name: d.name, phone: d.phone, carrier: d.carrier, notes: d.notes, active: d.active === 1 })),
      driverChanges.map(c => ({ id: c.id, truckId: c.truck_id, driverId: c.driver_id, day: c.day, createdBy: c.created_by, createdAt: c.created_at })),
    ),
    trailers: new TrailerIndex(
      trailers.map(t => ({ plate: t.plate, typePl: t.type_pl, typeEn: t.type_en, notes: t.notes, carrier: t.carrier, activeTo: t.active_to })),
      trailerAliases.map(a => ({ alias: a.alias, plate: a.trailer_plate })),
    ),
    places: new PlaceIndex(
      places.map(p => ({ code: p.code, name: p.name, country: p.country, lat: p.lat, lon: p.lon, kind: p.kind })),
      placeAliases.map(a => ({ alias: a.alias, code: a.place_code })),
    ),
    ownPlates: new Set(own.map(o => o.plate)),
    ignoredPlates: new Set(ignored.map(i => i.plate)),
  }
}

/** Folded upper-case text for comparisons in messages. */
export function displayKey(text: string): string {
  return foldDiacritics(text).toUpperCase()
}
