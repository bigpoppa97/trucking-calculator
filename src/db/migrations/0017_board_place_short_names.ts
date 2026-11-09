import type { Kysely } from 'kysely'

/**
 * 09.11.2026: airport names on the board without the airport in brackets — "Budapeszt", not
 * "Budapeszt (Vecsés)" (the department: the brackets add nothing, and the bars should show the
 * whole route). Only the names the place seed wrote are changed; a name already edited stays.
 * Aliases ("vecses", "pyrzowice", …) are untouched, so the export's spellings still resolve.
 */
export const SHORTENED_PLACE_NAMES: Array<[code: string, from: string, to: string]> = [
  ['BUD', 'Budapeszt (Vecsés)', 'Budapeszt'],
  ['KRK', 'Kraków (Balice)', 'Kraków'],
  ['KTW', 'Katowice (Pyrzowice)', 'Katowice'],
  ['OTP', 'Bukareszt (Otopeni)', 'Bukareszt'],
  ['AMS', 'Amsterdam (Schiphol)', 'Amsterdam'],
  ['MXP', 'Mediolan (Malpensa)', 'Mediolan'],
  ['ARN', 'Sztokholm (Arlanda)', 'Sztokholm'],
]

export async function up(db: Kysely<any>): Promise<void> {
  for (const [code, from, to] of SHORTENED_PLACE_NAMES) {
    await db.updateTable('board_places').set({ name: to }).where('code', '=', code).where('name', '=', from).execute()
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const [code, from, to] of SHORTENED_PLACE_NAMES) {
    await db.updateTable('board_places').set({ name: from }).where('code', '=', code).where('name', '=', to).execute()
  }
}
