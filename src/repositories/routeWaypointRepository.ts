import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'

/**
 * Company-preferred via waypoints per route code (PRD §3.3 — preferred
 * border crossings like Chyżne or Kudowa-Zdrój). Keyed by CODE so they can
 * be defined before the route is first fetched from HERE.
 */

export interface RouteWaypoint {
  id: number
  routeCode: string
  seq: number
  name: string
  lat: number
  lon: number
}

export interface RouteWaypointInput {
  seq: number
  name: string
  lat: number
  lon: number
}

export class RouteWaypointRepository {
  constructor(private readonly db: Kysely<DB>) {}

  async listByRoute(routeCode: string): Promise<RouteWaypoint[]> {
    const rows = await this.db
      .selectFrom('route_waypoints')
      .selectAll()
      .where('route_code', '=', routeCode.trim().toUpperCase())
      .orderBy('seq')
      .execute()
    return rows.map(r => ({ id: r.id, routeCode: r.route_code, seq: r.seq, name: r.name, lat: r.lat, lon: r.lon }))
  }

  /** Replace the full waypoint list for a route (idempotent PUT semantics). */
  async replaceForRoute(routeCode: string, waypoints: RouteWaypointInput[]): Promise<RouteWaypoint[]> {
    const code = routeCode.trim().toUpperCase()
    await this.db.transaction().execute(async trx => {
      await trx.deleteFrom('route_waypoints').where('route_code', '=', code).execute()
      for (const wp of waypoints) {
        await trx
          .insertInto('route_waypoints')
          .values({ route_code: code, seq: wp.seq, name: wp.name.trim(), lat: wp.lat, lon: wp.lon })
          .execute()
      }
    })
    return this.listByRoute(code)
  }
}
