import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { sameCarrier, type BoardContext } from './context.js'
import { legSort, type ComputedLeg, type ComputedOrder } from './compute.js'
import { aliasKey, normalizePlate } from './normalize.js'
import { similarPlates } from './prz.js'

/**
 * The review queue ("Do sprawdzenia").
 *
 * Two families:
 *  - DERIVED issues are recomputed from the current data after every import
 *    or edit; when the condition disappears they resolve themselves. An issue
 *    the user marked as fine stays ignored until its fingerprint (the values
 *    it was about) changes.
 *  - EVENT issues are raised by an import (order disappeared, a manual
 *    correction was superseded, a new truck of a fleet carrier) and stay
 *    until the user handles them.
 */

export const DERIVED_KINDS = [
  'PRZ_PARSE',
  'PRZ_MULTI',
  'PRZ_TRUCK_UNKNOWN',
  'PRZ_AMOUNT_MISMATCH',
  'PRZ_SUB_NOT_IN_ENTRY',
  'PRZ_PLACE_UNKNOWN',
  'PRZ_DATE',
  'NEGATIVE_MARGIN',
  'HIGH_MARGIN',
  'REV_PER_KM',
  'UNKNOWN_PLACE',
  'UNKNOWN_TRAILER',
  'MISSING_TRAILER',
  // No longer raised (09.10.2026: a cancelled forwarding order just leaves the board);
  // kept so open items from before resolve themselves.
  'NO_CARRIER',
  'FERRY_PARSE',
  // 12.10.2026: a preliminary order whose unloading day has passed without an order from the application.
  'DRAFT_STALE',
  // 26.10.2026: two consecutive orders of a truck too far apart for the time between them — a relay?
  'ROUTE_GAP',
  // 28.10.2026: a co-load (doładunek) whose main order is missing, cancelled or on another truck.
  'COLOAD',
] as const

export type DerivedKind = (typeof DERIVED_KINDS)[number]
export type EventKind = 'DISAPPEARED' | 'OVERRIDE_SUPERSEDED' | 'NEW_TRUCK' | 'DRAFT_MATCH'
export type IssueKind = DerivedKind | EventKind

export interface IssueDraft {
  key: string
  kind: IssueKind
  ref: string
  message: string
  details: Record<string, unknown>
  fingerprint: string
}

export interface IssueThresholds {
  marginWarnPct: number
  revPerKmMin: number
  revPerKmMax: number
}

export const DEFAULT_THRESHOLDS: IssueThresholds = { marginWarnPct: 40, revPerKmMin: 0.5, revPerKmMax: 4.5 }

const eur = (n: number) => `${Math.round(n).toLocaleString('pl-PL').replace(/ /g, ' ')} €`

/** Derived issues for the given computed orders; `today` = the Polish date (preliminary orders past their unloading). */
export function deriveIssues(orders: ComputedOrder[], ctx: BoardContext, t: IssueThresholds, today: string): IssueDraft[] {
  const out: IssueDraft[] = []
  const unknownPlaces = new Map<string, { raw: string; orders: Set<string> }>()
  const unknownTrailers = new Map<string, { raw: string; orders: Set<string>; carriers: Set<string> }>()

  for (const o of orders) {
    // A cancelled forwarding order without PRZ: the truck does not carry it — nothing to review.
    // An order of a fleet truck whose PRZ entry leaves no leg on the fleet stays here: it is off
    // the board, so this list is the only place it can still be seen (27.10.2026).
    if (o.history || o.noCarrier || (!o.hasFleetLeg && !o.fleetByExport)) continue
    const ref = o.orderNo
    const counted = o.excluded === null

    if (o.draft && today > o.unloadDate) {
      out.push({
        key: `DRAFT_STALE:${ref}`,
        kind: 'DRAFT_STALE',
        ref,
        message: `Zlecenie wstępne ${ref} (rozładunek ${fmtDate(o.unloadDate)}) nadal nie ma zlecenia z aplikacji. Zostawić je czy usunąć?`,
        details: { unloadDate: o.unloadDate },
        fingerprint: o.unloadDate,
      })
    }

    if (o.coLoad && !o.coLoad.valid && counted) {
      const c = o.coLoad
      const said = c.source === 'manual' ? `jest oznaczone na tablicy jako doładunek do ${c.of}` : `ma w uwagach „Doładunek do ${c.of}”`
      const plate = o.legs.find(l => l.kind === 'fleet')?.plate ?? o.subPlate
      const normal = ' Do tego czasu liczę je jako zwykłe zlecenie (z własnymi km).'
      const message =
        c.problem === 'no_ref'
          ? `W uwagach zlecenia ${ref} jest „doładunek”, ale bez numeru zlecenia głównego. Dopisz go (np. „Doładunek do 79-1234-26”) albo wskaż w panelu: Popraw ręcznie → Doładunek do zlecenia.`
          : c.problem === 'self'
            ? `Zlecenie ${ref} ${said} — czyli do samego siebie. Popraw numer zlecenia głównego.`
            : c.problem === 'cancelled'
              ? `Zlecenie ${ref} ${said}, ale ${c.of} jest anulowane.${normal}`
              : c.problem === 'other_truck'
                ? `Zlecenie ${ref} ${said}, ale ${c.of} jedzie innym autem (${c.mainPlates.join(', ') || 'spoza floty'}) niż ${ref} (${plate}).${normal}`
                : `Zlecenie ${ref} ${said}, ale zlecenia ${c.of} nie ma na tablicy.${normal}`
      out.push({
        key: `COLOAD:${ref}`,
        kind: 'COLOAD',
        ref,
        message,
        details: { of: c.of, problem: c.problem, source: c.source, mainPlates: c.mainPlates },
        fingerprint: `${c.of}|${c.problem ?? ''}|${c.mainPlates.join(',')}|${plate}`,
      })
    }

    for (const raw of o.przErrors) {
      out.push({
        key: `PRZ_PARSE:${ref}`,
        kind: 'PRZ_PARSE',
        ref,
        message: `Nie rozumiem wpisu przepinki: „${raw}”. Wzór: PRZ MIEJSCE DD.MM AUTO>AUTO KWOTA/KWOTA.`,
        details: { raw },
        fingerprint: raw,
      })
    }
    for (const raw of o.ferryErrors) {
      out.push({
        key: `FERRY_PARSE:${ref}:${raw}`,
        kind: 'FERRY_PARSE',
        ref,
        message: `Nie rozumiem wpisu promu: „${raw}”. Wzór: PROM KWOTA (w EUR, np. PROM 1180 albo PROM 1180,50).`,
        details: { raw },
        fingerprint: raw,
      })
    }
    if (o.przExtraEntries > 0) {
      out.push({
        key: `PRZ_MULTI:${ref}`,
        kind: 'PRZ_MULTI',
        ref,
        message: 'Więcej niż jedna przepinka w zleceniu — tablica liczy tylko pierwszą. Popraw podział ręcznie.',
        details: {},
        fingerprint: o.notesApp,
      })
    }
    if (o.prz) {
      for (const plate of [o.prz.from, o.prz.to]) {
        if (!ctx.fleet.isFleetPlate(plate) && !ctx.ownPlates.has(plate)) {
          const similar = similarPlates(plate, [...ctx.fleet.allPlates(), ...ctx.ownPlates])
          out.push({
            key: `PRZ_TRUCK_UNKNOWN:${ref}:${plate}`,
            kind: 'PRZ_TRUCK_UNKNOWN',
            ref,
            message:
              `Auto ${plate} z wpisu PRZ nie jest ani w Twojej flocie, ani we flocie własnej. ` +
              (similar.length > 0 ? `Literówka? Podobny numer: ${similar.join(', ')}.` : 'Literówka?') +
              (o.hasFleetLeg ? '' : ' Zlecenia nie ma teraz na tablicy — żaden odcinek nie jedzie autem z Twojej floty.'),
            // suggestions → "Popraw na …" in the review card (one click, 27.10.2026)
            details: { plate, suggestions: similar, entry: o.prz.raw },
            fingerprint: o.prz.raw,
          })
        }
      }
      if (o.subPlate && o.costApp !== null) {
        const fleetTruck = ctx.fleet.truckFor(o.subPlate, o.loadDate)
        if (o.subPlate === o.prz.from || o.subPlate === o.prz.to) {
          const amount = o.subPlate === o.prz.from ? o.prz.amountFrom : o.prz.amountTo
          // One forwarding order may cover both legs when both trucks belong to
          // the same carrier — then the two amounts together must equal the cost.
          const sameCarrierSum = [
            { plate: o.prz.from, amount: o.prz.amountFrom },
            { plate: o.prz.to, amount: o.prz.amountTo },
          ]
            .filter(x => {
              const t = ctx.fleet.truckFor(x.plate, o.loadDate)
              return t !== null && sameCarrier(t.carrier, o.carrier)
            })
            .reduce((sum, x) => sum + x.amount, 0)
          // Skonto (28.10.2026): the cost is the amount less 1.5% — not a mismatch (compute.ts).
          if (!o.skonto && Math.abs(amount - o.costApp) > 0.5 && Math.abs(sameCarrierSum - o.costApp) > 0.5) {
            out.push({
              key: `PRZ_AMOUNT_MISMATCH:${ref}`,
              kind: 'PRZ_AMOUNT_MISMATCH',
              ref,
              message: `Kwota ${o.subPlate} we wpisie PRZ (${eur(amount)}) różni się od kosztu w aplikacji (${eur(o.costApp)}).`,
              details: { plate: o.subPlate, amount, cost: o.costApp },
              fingerprint: `${amount}|${o.costApp}`,
            })
          }
        } else if (fleetTruck) {
          out.push({
            key: `PRZ_SUB_NOT_IN_ENTRY:${ref}`,
            kind: 'PRZ_SUB_NOT_IN_ENTRY',
            ref,
            message:
              `Auto z eksportu (${o.subPlate}) nie występuje we wpisie PRZ (${o.prz.from}>${o.prz.to}).` +
              (o.hasFleetLeg ? '' : ' Zlecenia nie ma teraz na tablicy — żaden odcinek nie jedzie autem z Twojej floty.'),
            details: { plate: o.subPlate },
            fingerprint: o.prz.raw,
          })
        }
      }
      if (!o.prz.placeCode) {
        const k = aliasKey(o.prz.place)
        out.push({
          key: `PRZ_PLACE_UNKNOWN:${k}`,
          kind: 'PRZ_PLACE_UNKNOWN',
          ref,
          message: `Nie znam miejsca przepinki „${o.prz.place}”. Wskaż je raz — potem tablica rozpozna je sama.`,
          details: {
            raw: o.prz.place,
            suggestions: ctx.places.suggest(o.prz.place).map(p => ({ code: p.code, name: p.name })),
          },
          fingerprint: k,
        })
      }
      if (o.prz.date < addDaysIso(o.loadDate, -1) || o.prz.date > addDaysIso(o.unloadDate, 1)) {
        out.push({
          key: `PRZ_DATE:${ref}`,
          kind: 'PRZ_DATE',
          ref,
          message: `Data przepinki ${fmtDate(o.prz.date)} jest poza terminem zlecenia (${fmtDate(o.loadDate)}–${fmtDate(o.unloadDate)}).`,
          details: {},
          fingerprint: o.prz.raw,
        })
      }
    }

    if (counted && o.margin !== null && o.rev !== null) {
      if (o.margin < 0) {
        out.push({
          key: `NEGATIVE_MARGIN:${ref}`,
          kind: 'NEGATIVE_MARGIN',
          ref,
          message: `Ujemna marża (${eur(o.margin)}). Sprawdź stawki albo kwoty we wpisie PRZ.`,
          details: { margin: o.margin },
          fingerprint: `${o.rev}|${o.amountsTotal}`,
        })
      } else if (o.marginPct !== null && o.marginPct > t.marginWarnPct) {
        out.push({
          key: `HIGH_MARGIN:${ref}`,
          kind: 'HIGH_MARGIN',
          ref,
          message: `Marża ${o.marginPct.toFixed(0)}% (${eur(o.margin)}) przy progu ${t.marginWarnPct}%. Czy brakuje wpisu PRZ?`,
          details: { margin: o.margin, pct: o.marginPct },
          fingerprint: `${o.rev}|${o.amountsTotal}`,
        })
      }
      // Revenue per loaded km on our legs (revenue allocated to them, so own-fleet legs don't distort it).
      const fleetLegs = o.legs.filter(l => l.kind === 'fleet')
      const km = fleetLegs.reduce((s, l) => s + (l.kmLoaded ?? 0), 0)
      const legRev = fleetLegs.reduce((s, l) => s + (l.revAlloc ?? 0), 0)
      const kmKnown = fleetLegs.every(l => l.kmLoaded !== null)
      if (kmKnown && km >= 80) {
        const perKm = legRev / km
        if (perKm > t.revPerKmMax || perKm < t.revPerKmMin) {
          out.push({
            key: `REV_PER_KM:${ref}`,
            kind: 'REV_PER_KM',
            ref,
            message: `Stawka klienta ${perKm.toFixed(2).replace('.', ',')} €/km wygląda nietypowo (${eur(legRev)} na ${km} km). Sprawdź kwotę lub walutę.`,
            details: { perKm, km },
            fingerprint: `${o.rev}|${km}`,
          })
        }
      }
    }

    for (const leg of o.legs) {
      if (leg.kind !== 'fleet') continue
      for (const stop of leg.stops) {
        if (stop.code) continue
        const k = aliasKey(stop.raw)
        if (!k) continue
        const entry = unknownPlaces.get(k) ?? { raw: stop.raw, orders: new Set<string>() }
        entry.orders.add(ref)
        unknownPlaces.set(k, entry)
      }
    }

    const fleetLeg = o.legs.find(l => l.kind === 'fleet')
    // A preliminary order has no trailer yet — nothing to check.
    if (fleetLeg && counted && !o.draft) {
      if (!o.legs[0]?.trailerRaw) {
        const truck = fleetLeg.truckId !== null ? ctx.fleet.byId(fleetLeg.truckId) : undefined
        out.push({
          key: `MISSING_TRAILER:${ref}`,
          kind: 'MISSING_TRAILER',
          ref,
          message: 'Brak numeru naczepy w zleceniu.',
          details: { lastKnown: truck?.trailerPlate ?? null, plate: fleetLeg.plate, pool: ctx.trailers.poolOf(truck?.carrier ?? '') },
          fingerprint: '',
        })
      } else if (!fleetLeg.trailerKnown) {
        const k = normalizePlate(fleetLeg.trailerRaw)
        const entry = unknownTrailers.get(k) ?? { raw: fleetLeg.trailerRaw, orders: new Set<string>(), carriers: new Set<string>() }
        entry.orders.add(ref)
        const carrier = fleetLeg.truckId !== null ? ctx.fleet.byId(fleetLeg.truckId)?.carrier : undefined
        if (carrier) entry.carriers.add(carrier)
        unknownTrailers.set(k, entry)
      }
    }

  }

  for (const [k, v] of unknownPlaces) {
    const orders = [...v.orders]
    out.push({
      key: `UNKNOWN_PLACE:${k}`,
      kind: 'UNKNOWN_PLACE',
      ref: v.raw,
      message: `Nie znam miejsca „${v.raw}” (${orders.length === 1 ? 'zlecenie' : 'zlecenia'} ${orders.slice(0, 3).join(', ')}${orders.length > 3 ? '…' : ''}).`,
      details: { raw: v.raw, orders, suggestions: ctx.places.suggest(v.raw).map(p => ({ code: p.code, name: p.name })) },
      fingerprint: k,
    })
  }
  for (const [k, v] of unknownTrailers) {
    const orders = [...v.orders]
    const list = `${orders.slice(0, 3).join(', ')}${orders.length > 3 ? '…' : ''}`
    const canonical = ctx.trailers.canonical(v.raw)
    const retired = canonical ? ctx.trailers.get(canonical) : undefined
    // Similar spellings first; for an unknown plate also the trailers of the carrier(s)
    // that drove it. A retired trailer is a real past trailer — only spelling matches,
    // never "the carrier's other trailer", so its history is not rewritten.
    const similar = ctx.trailers.suggest(v.raw)
    const pool = retired ? [] : [...v.carriers].flatMap(c => ctx.trailers.poolOf(c))
    const suggestions = [...new Set([...similar, ...pool])].slice(0, 4)
    out.push({
      key: `UNKNOWN_TRAILER:${k}`,
      kind: 'UNKNOWN_TRAILER',
      ref: v.raw,
      message: retired
        ? `Naczepy „${retired.plate}” nie ma już we flocie (do ${fmtDate(retired.activeTo ?? '')}), a jest w zleceniu: ${list}.`
        : `Naczepa „${v.raw}” nie istnieje w bazie (${list}).`,
      details: { raw: v.raw, orders, suggestions, retired: retired ? retired.plate : null, carrier: v.carriers.size === 1 ? [...v.carriers][0] : null },
      fingerprint: k,
    })
  }
  out.push(...routeGaps(orders, ctx))
  return out
}

/**
 * Continuity of a truck's route ("Czy była przepinka?", 26.10.2026). For two consecutive
 * orders A → B of a truck, the empty run from A's last unloading to B's first loading
 * must fit in the time between them: with both hours known at ROUTE_GAP_SPEED km/h plus
 * ROUTE_GAP_SLACK_H of slack (the export's unloading hour is the END of the window, so the
 * truck is often free hours earlier — with 1 h the data of 09–10.2026 gave three such false
 * alarms, with 4 h none); without hours, an empty run over ROUTE_GAP_SAME_DAY_KM on the
 * same day (or overlapping days) is suspicious. Typical cause: a relay (PRZ) nobody typed
 * in — the truck really left A or joined B somewhere else. Uses the legs after PRZ, so an
 * entered relay clears it; an empty run started by "Pozycja auta" is not checked.
 */
export const ROUTE_GAP_SPEED = 70
export const ROUTE_GAP_SLACK_H = 4
export const ROUTE_GAP_SAME_DAY_KM = 500
export const ROUTE_GAP_MIN_KM = 150

export function routeGaps(orders: ComputedOrder[], ctx: BoardContext): IssueDraft[] {
  const out: IssueDraft[] = []
  const byTruck = new Map<number, ComputedLeg[]>()
  const orderOf = new Map<ComputedLeg, ComputedOrder>()
  for (const o of orders) {
    // Same set of legs as the empty-run computation (compute.ts).
    if (o.excluded !== null || o.noCarrier) continue
    for (const leg of o.legs) {
      // A co-load rides inside its main order — no empty run of its own (28.10.2026).
      if (leg.kind !== 'fleet' || leg.truckId === null || leg.coLoad) continue
      const list = byTruck.get(leg.truckId) ?? []
      list.push(leg)
      byTruck.set(leg.truckId, list)
      orderOf.set(leg, o)
    }
  }
  for (const legs of byTruck.values()) {
    legs.sort(legSort)
    for (let i = 1; i < legs.length; i++) {
      const a = legs[i - 1]!
      const b = legs[i]!
      const oa = orderOf.get(a)!
      const ob = orderOf.get(b)!
      if (oa.history || ob.history || oa.orderNo === ob.orderNo) continue
      const aEnd = a.stops[a.stops.length - 1]?.code ?? null
      const bStart = b.stops[0]?.code ?? null
      const km = b.kmEmpty
      // Only the empty run from A's unloading (not from a "Pozycja auta" in between).
      if (km === null || !aEnd || !bStart || b.kmEmptyFrom !== aEnd) continue
      let hours: number | null = null
      let suspicious = false
      if (a.endTime && b.startTime) {
        hours = (Date.parse(`${b.startDate}T${b.startTime}:00Z`) - Date.parse(`${a.endDate}T${a.endTime}:00Z`)) / 3_600_000
        suspicious = km >= ROUTE_GAP_MIN_KM && km / ROUTE_GAP_SPEED > hours + ROUTE_GAP_SLACK_H
      } else {
        suspicious = km > ROUTE_GAP_SAME_DAY_KM && b.startDate <= a.endDate
      }
      if (!suspicious) continue
      const at = (date: string, time: string | null) => `${fmtDate(date)}${time ? ` ${time}` : ''}`
      const before = hours !== null ? hours < 0 : b.startDate < a.endDate
      const span = before
        ? ', a załadunek wypada przed rozładunkiem poprzedniego zlecenia'
        : hours === null
          ? ' tego samego dnia'
          : hours === 0
            ? ' bez czasu na dojazd'
            : ` w ${formatHours(hours)} h`
      const plate = b.plate || a.plate
      out.push({
        key: `ROUTE_GAP:${oa.orderNo}>${ob.orderNo}`,
        kind: 'ROUTE_GAP',
        ref: ob.orderNo,
        message:
          `Czy była przepinka? ${plate}: rozładunek ${oa.orderNo} — ${ctx.places.name(aEnd)} ${at(a.endDate, a.endTime)}, ` +
          `załadunek ${ob.orderNo} — ${ctx.places.name(bStart)} ${at(b.startDate, b.startTime)}: ok. ${km} km pustych${span}. ` +
          'Jeśli auto przepięło się w trasie, wpisz przepinkę (PRZ) w jednym z tych zleceń; jeśli data albo godzina jest zła — popraw ją.',
        details: { orders: [oa.orderNo, ob.orderNo], truckId: b.truckId, km, hours },
        // Dates, hours and places only: km filled in later by HERE must not reopen a dismissed item.
        fingerprint: `${a.endDate} ${a.endTime ?? ''}|${b.startDate} ${b.startTime ?? ''}|${aEnd}|${bStart}`,
      })
    }
  }
  return out
}

function formatHours(h: number): string {
  return (Math.round(h * 10) / 10).toString().replace('.', ',')
}

/** Upsert derived issues and auto-resolve the ones whose condition is gone. */
export async function syncDerivedIssues(db: Kysely<DB>, drafts: IssueDraft[], now: string): Promise<void> {
  const existing = await db
    .selectFrom('board_issues')
    .selectAll()
    .where('kind', 'in', DERIVED_KINDS as unknown as string[])
    .execute()
  const byKey = new Map(existing.map(e => [e.key, e]))
  const seen = new Set<string>()
  await db.transaction().execute(async trx => {
    for (const d of drafts) {
      if (seen.has(d.key)) continue
      seen.add(d.key)
      const prev = byKey.get(d.key)
      if (!prev) {
        await trx
          .insertInto('board_issues')
          .values({
            key: d.key,
            kind: d.kind,
            ref: d.ref,
            message: d.message,
            details: JSON.stringify(d.details),
            fingerprint: d.fingerprint,
            status: 'open',
            created_at: now,
            updated_at: now,
          })
          .execute()
        continue
      }
      let status = prev.status
      if (prev.status === 'resolved') status = 'open'
      if (prev.status === 'ignored' && prev.fingerprint !== d.fingerprint) status = 'open'
      await trx
        .updateTable('board_issues')
        .set({
          ref: d.ref,
          message: d.message,
          details: JSON.stringify(d.details),
          fingerprint: d.fingerprint,
          status,
          updated_at: status !== prev.status || prev.message !== d.message ? now : prev.updated_at,
          ...(status === 'open' && prev.status !== 'open' ? { resolved_by: null, resolution: null } : {}),
        })
        .where('id', '=', prev.id)
        .execute()
    }
    for (const prev of existing) {
      if (prev.status === 'open' && !seen.has(prev.key)) {
        await trx
          .updateTable('board_issues')
          .set({ status: 'resolved', resolution: 'auto', updated_at: now })
          .where('id', '=', prev.id)
          .execute()
      }
    }
  })
}

/** Insert or reopen an event issue (raised by an import). */
export async function raiseEventIssue(db: Kysely<DB>, draft: IssueDraft, now: string): Promise<void> {
  const prev = await db.selectFrom('board_issues').selectAll().where('key', '=', draft.key).executeTakeFirst()
  if (!prev) {
    await db
      .insertInto('board_issues')
      .values({
        key: draft.key,
        kind: draft.kind,
        ref: draft.ref,
        message: draft.message,
        details: JSON.stringify(draft.details),
        fingerprint: draft.fingerprint,
        status: 'open',
        created_at: now,
        updated_at: now,
      })
      .execute()
    return
  }
  const reopen = prev.status === 'resolved' || (prev.status === 'ignored' && prev.fingerprint !== draft.fingerprint)
  await db
    .updateTable('board_issues')
    .set({
      message: draft.message,
      details: JSON.stringify(draft.details),
      fingerprint: draft.fingerprint,
      updated_at: now,
      ...(reopen ? { status: 'open' as const, resolution: null, resolved_by: null } : {}),
    })
    .where('id', '=', prev.id)
    .execute()
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function fmtDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`
}
