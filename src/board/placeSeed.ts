import type { Kysely } from 'kysely'
import type { DB, PlaceKind } from '../db/schema.js'
import { aliasKey } from './normalize.js'

/**
 * Starting place dictionary. Most loading/unloading points of the fleet are
 * airport cargo terminals, so airports use their IATA code; other points
 * (border crossings, hubs, towns) get a 4-letter code of our own so they
 * never collide with a real IATA code. Aliases are matched after
 * aliasKey() folding, so "Vecsés"/"Vecses" or "WARSZAWA"/"Warszawa" need one
 * entry. New spellings are learned from the review queue.
 *
 * Coordinates are approximate (cargo area / town centre) — enough for road
 * routing, which snaps to the network.
 */

interface SeedPlace {
  code: string
  name: string
  country: string
  lat: number
  lon: number
  kind: PlaceKind
  aliases: string[]
}

export const SEED_PLACES: SeedPlace[] = [
  // Airports (IATA)
  { code: 'WAW', name: 'Warszawa', country: 'PL', lat: 52.1657, lon: 20.9671, kind: 'airport', aliases: ['warszawa', 'warsaw', 'warschau', 'warszawa airport', 'warsaw airport', 'warszawa okecie', 'okecie', 'waw'] },
  { code: 'BUD', name: 'Budapeszt (Vecsés)', country: 'HU', lat: 47.4298, lon: 19.2611, kind: 'airport', aliases: ['budapeszt', 'budapest', 'vecses', 'ferihegy', 'budapest airport', 'bud'] },
  { code: 'VIE', name: 'Wiedeń', country: 'AT', lat: 48.1103, lon: 16.5697, kind: 'airport', aliases: ['wieden', 'wien', 'vienna', 'schwechat', 'flughafen wien', 'wien flughafen', 'vienna airport', 'wien schwechat', 'vie'] },
  { code: 'FRA', name: 'Frankfurt', country: 'DE', lat: 50.0333, lon: 8.5706, kind: 'airport', aliases: ['frankfurt', 'frankfurt am main', 'frankfurt airport', 'frankfurt flughafen', 'flughafen frankfurt', 'fra'] },
  { code: 'KRK', name: 'Kraków (Balice)', country: 'PL', lat: 50.0778, lon: 19.7848, kind: 'airport', aliases: ['krakow', 'balice', 'krakow airport', 'krk'] },
  { code: 'KTW', name: 'Katowice (Pyrzowice)', country: 'PL', lat: 50.4743, lon: 19.08, kind: 'airport', aliases: ['katowice', 'pyrzowice', 'ozarowice', 'katowice airport', 'ktw'] },
  { code: 'LCJ', name: 'Łódź', country: 'PL', lat: 51.7219, lon: 19.3981, kind: 'airport', aliases: ['lodz', 'lodz airport', 'lcj'] },
  { code: 'VNO', name: 'Wilno', country: 'LT', lat: 54.6341, lon: 25.2858, kind: 'airport', aliases: ['wilno', 'vilnius', 'vno'] },
  { code: 'RIX', name: 'Ryga', country: 'LV', lat: 56.9236, lon: 23.9711, kind: 'airport', aliases: ['ryga', 'riga', 'rix'] },
  { code: 'TLL', name: 'Tallin', country: 'EE', lat: 59.4133, lon: 24.8328, kind: 'airport', aliases: ['tallin', 'tallinn', 'tll'] },
  { code: 'KUN', name: 'Kowno', country: 'LT', lat: 54.9639, lon: 24.0848, kind: 'airport', aliases: ['kowno', 'kaunas', 'kauns', 'kun'] },
  { code: 'PRG', name: 'Praga', country: 'CZ', lat: 50.1008, lon: 14.26, kind: 'airport', aliases: ['praga', 'praha', 'prague', 'ruzyne', 'praha 6 ruzyne', 'praha 6', 'prague 6', 'prg'] },
  { code: 'BER', name: 'Berlin', country: 'DE', lat: 52.3667, lon: 13.5033, kind: 'airport', aliases: ['berlin', 'schonefeld', 'berlin schonefeld', 'berlin brandenburg', 'ber'] },
  { code: 'OTP', name: 'Bukareszt (Otopeni)', country: 'RO', lat: 44.5722, lon: 26.1022, kind: 'airport', aliases: ['bukareszt', 'bucharest', 'bucuresti', 'otopeni', 'otopeni ilfov', 'otp'] },
  { code: 'SOF', name: 'Sofia', country: 'BG', lat: 42.6967, lon: 23.4114, kind: 'airport', aliases: ['sofia', 'sof'] },
  { code: 'MUC', name: 'Monachium', country: 'DE', lat: 48.3538, lon: 11.7861, kind: 'airport', aliases: ['monachium', 'munchen', 'muenchen', 'munich', 'muc'] },
  { code: 'BTS', name: 'Bratysława', country: 'SK', lat: 48.1702, lon: 17.2127, kind: 'airport', aliases: ['bratyslawa', 'bratislava', 'bts'] },
  { code: 'LEJ', name: 'Lipsk', country: 'DE', lat: 51.4239, lon: 12.2163, kind: 'airport', aliases: ['lipsk', 'leipzig', 'schkeuditz', 'leipzig halle', 'lej'] },
  { code: 'WRO', name: 'Wrocław', country: 'PL', lat: 51.1027, lon: 16.8858, kind: 'airport', aliases: ['wroclaw', 'breslau', 'wro'] },
  { code: 'POZ', name: 'Poznań', country: 'PL', lat: 52.421, lon: 16.8263, kind: 'airport', aliases: ['poznan', 'poz'] },
  { code: 'GDN', name: 'Gdańsk', country: 'PL', lat: 54.3776, lon: 18.4662, kind: 'airport', aliases: ['gdansk', 'gdn'] },
  { code: 'RZE', name: 'Rzeszów', country: 'PL', lat: 50.11, lon: 22.0189, kind: 'airport', aliases: ['rzeszow', 'jasionka', 'rze'] },
  { code: 'HEL', name: 'Helsinki', country: 'FI', lat: 60.3172, lon: 24.9633, kind: 'airport', aliases: ['helsinki', 'vantaa', 'hel'] },
  { code: 'CPH', name: 'Kopenhaga', country: 'DK', lat: 55.618, lon: 12.6561, kind: 'airport', aliases: ['kopenhaga', 'copenhaga', 'copenhagen', 'kobenhavn', 'kastrup', 'cph'] },
  { code: 'LGG', name: 'Liège', country: 'BE', lat: 50.6374, lon: 5.4432, kind: 'airport', aliases: ['liege', 'luik', 'lgg'] },
  { code: 'LNZ', name: 'Linz', country: 'AT', lat: 48.2332, lon: 14.1875, kind: 'airport', aliases: ['linz', 'horsching', 'lnz'] },
  { code: 'STR', name: 'Stuttgart', country: 'DE', lat: 48.6899, lon: 9.2221, kind: 'airport', aliases: ['stuttgart', 'str'] },
  { code: 'NUE', name: 'Norymberga', country: 'DE', lat: 49.4987, lon: 11.0669, kind: 'airport', aliases: ['norymberga', 'nurnberg', 'nuernberg', 'nuremberg', 'nue'] },
  { code: 'CGN', name: 'Kolonia', country: 'DE', lat: 50.8658, lon: 7.1427, kind: 'airport', aliases: ['kolonia', 'koln', 'cologne', 'koln bonn', 'cgn'] },
  { code: 'DUS', name: 'Düsseldorf', country: 'DE', lat: 51.2895, lon: 6.7668, kind: 'airport', aliases: ['dusseldorf', 'duesseldorf', 'dus'] },
  { code: 'HHN', name: 'Hahn', country: 'DE', lat: 49.9487, lon: 7.2639, kind: 'airport', aliases: ['hahn', 'frankfurt hahn', 'hhn'] },
  { code: 'HAM', name: 'Hamburg', country: 'DE', lat: 53.6304, lon: 9.9882, kind: 'airport', aliases: ['hamburg', 'ham'] },
  { code: 'AMS', name: 'Amsterdam (Schiphol)', country: 'NL', lat: 52.3086, lon: 4.7639, kind: 'airport', aliases: ['amsterdam', 'schiphol', 'ams'] },
  { code: 'BRU', name: 'Bruksela', country: 'BE', lat: 50.9014, lon: 4.4844, kind: 'airport', aliases: ['bruksela', 'brussels', 'bruxelles', 'brussel', 'zaventem', 'bru'] },
  { code: 'CDG', name: 'Paryż', country: 'FR', lat: 49.0097, lon: 2.5479, kind: 'airport', aliases: ['paryz', 'paris', 'roissy', 'cdg'] },
  { code: 'MXP', name: 'Mediolan (Malpensa)', country: 'IT', lat: 45.6306, lon: 8.7281, kind: 'airport', aliases: ['mediolan', 'milan', 'milano', 'malpensa', 'mxp'] },
  { code: 'MAD', name: 'Madryt', country: 'ES', lat: 40.4936, lon: -3.5668, kind: 'airport', aliases: ['madryt', 'madrid', 'mad'] },
  { code: 'LYS', name: 'Lyon', country: 'FR', lat: 45.7256, lon: 5.0811, kind: 'airport', aliases: ['lyon', 'lys'] },
  { code: 'MRS', name: 'Marsylia', country: 'FR', lat: 43.4393, lon: 5.2214, kind: 'airport', aliases: ['marsylia', 'marseille', 'mrs'] },
  { code: 'ZAG', name: 'Zagrzeb', country: 'HR', lat: 45.7429, lon: 16.0688, kind: 'airport', aliases: ['zagrzeb', 'zagreb', 'zag'] },
  { code: 'LJU', name: 'Lublana', country: 'SI', lat: 46.2237, lon: 14.4576, kind: 'airport', aliases: ['lublana', 'ljubljana', 'ljublana', 'lju'] },
  { code: 'MMX', name: 'Malmö', country: 'SE', lat: 55.5363, lon: 13.3762, kind: 'airport', aliases: ['malmo', 'mmx'] },
  { code: 'ARN', name: 'Sztokholm (Arlanda)', country: 'SE', lat: 59.6519, lon: 17.9186, kind: 'airport', aliases: ['sztokholm', 'stockholm', 'arlanda', 'arn'] },
  { code: 'ZRH', name: 'Zurych', country: 'CH', lat: 47.4647, lon: 8.5492, kind: 'airport', aliases: ['zurych', 'zurich', 'zrh'] },
  { code: 'BRQ', name: 'Brno', country: 'CZ', lat: 49.1513, lon: 16.6944, kind: 'airport', aliases: ['brno', 'brq'] },
  { code: 'OSR', name: 'Ostrawa', country: 'CZ', lat: 49.6963, lon: 18.1111, kind: 'airport', aliases: ['ostrawa', 'ostrava', 'osr'] },
  { code: 'LUZ', name: 'Lublin', country: 'PL', lat: 51.2403, lon: 22.7136, kind: 'airport', aliases: ['lublin', 'luz'] },
  // Airports missing from the calculator's airport table — kind 'custom' (no calculator route lookup)
  { code: 'LUX', name: 'Luksemburg', country: 'LU', lat: 49.6266, lon: 6.2115, kind: 'custom', aliases: ['luksemburg', 'luxemburg', 'luxembourg', 'findel', 'lux'] },
  { code: 'BLL', name: 'Billund', country: 'DK', lat: 55.74, lon: 9.152, kind: 'custom', aliases: ['billund', 'bll'] },
  { code: 'FLR', name: 'Florencja', country: 'IT', lat: 43.81, lon: 11.205, kind: 'custom', aliases: ['florencja', 'florence', 'firenze', 'flr'] },
  // Hubs, crossings and towns (own 4-letter codes)
  { code: 'GORZ', name: 'Gorzyczki', country: 'PL', lat: 49.938, lon: 18.402, kind: 'custom', aliases: ['gorzyczki'] },
  { code: 'GLIW', name: 'Gliwice', country: 'PL', lat: 50.294, lon: 18.671, kind: 'custom', aliases: ['gliwice'] },
  { code: 'WYSO', name: 'Wysogotowo', country: 'PL', lat: 52.405, lon: 16.795, kind: 'custom', aliases: ['wysogotowo'] },
  { code: 'STRY', name: 'Stryków', country: 'PL', lat: 51.9, lon: 19.603, kind: 'custom', aliases: ['strykow'] },
  { code: 'STWO', name: 'Stalowa Wola', country: 'PL', lat: 50.583, lon: 22.053, kind: 'custom', aliases: ['stalowa wola'] },
  { code: 'WYPE', name: 'Wypędy', country: 'PL', lat: 52.129, lon: 20.929, kind: 'custom', aliases: ['wypedy'] },
  { code: 'DOBR', name: 'Dobrzykowice', country: 'PL', lat: 51.105, lon: 17.165, kind: 'custom', aliases: ['dobrzykowice'] },
  { code: 'JIHL', name: 'Jihlava', country: 'CZ', lat: 49.396, lon: 15.591, kind: 'custom', aliases: ['jihlava'] },
  { code: 'NYSA', name: 'Nysa', country: 'PL', lat: 50.474, lon: 17.334, kind: 'custom', aliases: ['nysa'] },
  { code: 'SIED', name: 'Siedlce', country: 'PL', lat: 52.168, lon: 22.29, kind: 'custom', aliases: ['siedlce'] },
  { code: 'PRUS', name: 'Pruszków', country: 'PL', lat: 52.17, lon: 20.8, kind: 'custom', aliases: ['pruszkow'] },
  { code: 'NWWR', name: 'Nowa Wieś Wrocławska', country: 'PL', lat: 51.032, lon: 16.925, kind: 'custom', aliases: ['nowa wies wroclawska'] },
  { code: 'TCZE', name: 'Tczew', country: 'PL', lat: 54.092, lon: 18.778, kind: 'custom', aliases: ['tczew'] },
]

/**
 * Inserts the seed places and aliases that are not there yet. Idempotent:
 * existing rows (possibly edited by the user) are never overwritten.
 */
export async function ensurePlaceSeed(db: Kysely<DB>): Promise<number> {
  let inserted = 0
  await db.transaction().execute(async trx => {
    for (const p of SEED_PLACES) {
      const res = await trx
        .insertInto('board_places')
        .values({ code: p.code, name: p.name, country: p.country, lat: p.lat, lon: p.lon, kind: p.kind })
        .onConflict(oc => oc.column('code').doNothing())
        .executeTakeFirst()
      inserted += Number(res.numInsertedOrUpdatedRows ?? 0)
      for (const alias of p.aliases) {
        await trx
          .insertInto('board_place_aliases')
          .values({ alias: aliasKey(alias), place_code: p.code })
          .onConflict(oc => oc.column('alias').doNothing())
          .execute()
      }
    }
  })
  return inserted
}
