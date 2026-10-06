import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { sameCarrier, type BoardContext } from './context.js'
import type { ComputedOrder } from './compute.js'
import { aliasKey, normalizePlate } from './normalize.js'

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
  'NO_CARRIER',
] as const

export type DerivedKind = (typeof DERIVED_KINDS)[number]
export type EventKind = 'DISAPPEARED' | 'OVERRIDE_SUPERSEDED' | 'NEW_TRUCK'
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

/** Derived issues for the given computed orders. */
export function deriveIssues(orders: ComputedOrder[], ctx: BoardContext, t: IssueThresholds): IssueDraft[] {
  const out: IssueDraft[] = []
  const unknownPlaces = new Map<string, { raw: string; orders: Set<string> }>()
  const unknownTrailers = new Map<string, { raw: string; orders: Set<string> }>()

  for (const o of orders) {
    if (o.history || !o.hasFleetLeg) continue
    const ref = o.orderNo
    const counted = o.excluded === null

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
          out.push({
            key: `PRZ_TRUCK_UNKNOWN:${ref}:${plate}`,
            kind: 'PRZ_TRUCK_UNKNOWN',
            ref,
            message: `Auto ${plate} z wpisu PRZ nie jest ani w Twojej flocie, ani we flocie własnej. Literówka?`,
            details: { plate },
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
          if (Math.abs(amount - o.costApp) > 0.5 && Math.abs(sameCarrierSum - o.costApp) > 0.5) {
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
            message: `Auto z eksportu (${o.subPlate}) nie występuje we wpisie PRZ (${o.prz.from}>${o.prz.to}).`,
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
    if (fleetLeg && counted) {
      if (!o.legs[0]?.trailerRaw) {
        const truck = fleetLeg.truckId !== null ? ctx.fleet.byId(fleetLeg.truckId) : undefined
        out.push({
          key: `MISSING_TRAILER:${ref}`,
          kind: 'MISSING_TRAILER',
          ref,
          message: 'Brak numeru naczepy w zleceniu.',
          details: { lastKnown: truck?.trailerPlate ?? null, plate: fleetLeg.plate },
          fingerprint: '',
        })
      } else if (!fleetLeg.trailerKnown) {
        const k = normalizePlate(fleetLeg.trailerRaw)
        const entry = unknownTrailers.get(k) ?? { raw: fleetLeg.trailerRaw, orders: new Set<string>() }
        entry.orders.add(ref)
        unknownTrailers.set(k, entry)
      }
    }

    if (o.noCarrier && o.excluded === null) {
      out.push({
        key: `NO_CARRIER:${ref}`,
        kind: 'NO_CARRIER',
        ref,
        message: 'Zlecenie spedycyjne jest anulowane, a zlecenie klienta nie — brak przewoźnika.',
        details: {},
        fingerprint: o.statusSped,
      })
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
    out.push({
      key: `UNKNOWN_TRAILER:${k}`,
      kind: 'UNKNOWN_TRAILER',
      ref: v.raw,
      message: `Naczepa „${v.raw}” nie istnieje w bazie (${orders.slice(0, 3).join(', ')}${orders.length > 3 ? '…' : ''}).`,
      details: { raw: v.raw, orders, suggestions: ctx.trailers.suggest(v.raw) },
      fingerprint: k,
    })
  }
  return out
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
