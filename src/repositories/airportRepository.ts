import type { Kysely } from 'kysely'
import type { DB, NewAirport } from '../db/schema.js'

export interface Airport {
  iata: string
  name: string
  city: string
  country: string
  lat: number
  lon: number
}

export class AirportRepository {
  constructor(private readonly db: Kysely<DB>) {}

  async upsertMany(airports: Airport[]): Promise<number> {
    if (airports.length === 0) return 0
    await this.db.transaction().execute(async trx => {
      for (const a of airports) {
        const row: NewAirport = { ...a, iata: a.iata.toUpperCase() }
        await trx
          .insertInto('airports')
          .values(row)
          .onConflict(oc => oc.column('iata').doUpdateSet(row))
          .execute()
      }
    })
    return airports.length
  }

  async findByIata(iata: string): Promise<Airport | null> {
    const row = await this.db
      .selectFrom('airports')
      .selectAll()
      .where('iata', '=', iata.toUpperCase())
      .executeTakeFirst()
    return row ?? null
  }

  async count(): Promise<number> {
    const row = await this.db
      .selectFrom('airports')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow()
    return Number(row.n)
  }

  async listAll(): Promise<Airport[]> {
    return this.db.selectFrom('airports').selectAll().orderBy('iata').execute()
  }
}
