import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'

/**
 * Stops a calculator route can use (09.11.2026): the calculator's airports
 * (3-letter IATA) plus the board's place dictionary (towns, border crossings,
 * warehouses — codes of 4+ characters, e.g. WYSO, TCZE). One shared
 * dictionary: a place added on the board works in the calculator and the
 * other way round.
 *
 * When a code is in both lists the airport row wins for coordinates, so
 * routes keep resolving exactly as before; the board only lends its Polish
 * name and spellings for search ("Kowno"/"Kaunas" → KUN).
 */

export type RoutePlaceKind = 'airport' | 'place'

export interface RoutePlace {
  code: string
  /** Display name: the board's (Polish) name when known, else the airport's city. */
  name: string
  /** Airport's full name; '' for board-only places. */
  detail: string
  country: string
  lat: number
  lon: number
  kind: RoutePlaceKind
  /** Folded spellings from the board dictionary (search only). */
  aliases: string[]
}

export type RoutePlaceRef = Pick<RoutePlace, 'code' | 'name' | 'lat' | 'lon' | 'kind'>

export class PlaceDirectory {
  constructor(private readonly db: Kysely<DB>) {}

  /** Coordinates for one route stop: airports first, then the board dictionary. */
  async findByCode(rawCode: string): Promise<RoutePlaceRef | null> {
    const code = rawCode.trim().toUpperCase()
    if (!code) return null
    const airport = await this.db.selectFrom('airports').selectAll().where('iata', '=', code).executeTakeFirst()
    if (airport) return { code: airport.iata, name: airport.city, lat: airport.lat, lon: airport.lon, kind: 'airport' }
    const place = await this.db.selectFrom('board_places').selectAll().where('code', '=', code).executeTakeFirst()
    if (place) return { code: place.code, name: place.name, lat: place.lat, lon: place.lon, kind: 'place' }
    return null
  }

  /** Every stop the calculator knows, for suggestions and the map. */
  async listAll(): Promise<RoutePlace[]> {
    const [airports, places, aliasRows] = await Promise.all([
      this.db.selectFrom('airports').selectAll().execute(),
      this.db.selectFrom('board_places').selectAll().execute(),
      this.db.selectFrom('board_place_aliases').selectAll().execute(),
    ])
    const aliasesOf = new Map<string, string[]>()
    for (const row of aliasRows) {
      const list = aliasesOf.get(row.place_code) ?? []
      list.push(row.alias)
      aliasesOf.set(row.place_code, list)
    }
    const boardByCode = new Map(places.map(p => [p.code, p]))

    const out: RoutePlace[] = airports.map(a => {
      const board = boardByCode.get(a.iata)
      return {
        code: a.iata,
        name: board?.name ?? a.city,
        detail: a.name,
        country: a.country,
        lat: a.lat,
        lon: a.lon,
        kind: 'airport' as const,
        aliases: (aliasesOf.get(a.iata) ?? []).sort(),
      }
    })
    const airportCodes = new Set(airports.map(a => a.iata))
    for (const p of places) {
      if (airportCodes.has(p.code)) continue
      out.push({
        code: p.code,
        name: p.name,
        detail: '',
        country: p.country,
        lat: p.lat,
        lon: p.lon,
        kind: 'place',
        aliases: (aliasesOf.get(p.code) ?? []).sort(),
      })
    }
    return out.sort((x, y) => x.code.localeCompare(y.code))
  }
}
