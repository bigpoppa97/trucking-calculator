import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { daysBetween } from './normalize.js'

/**
 * Preliminary orders (zlecenia wstępne, 12.10.2026): agreed with the client
 * and typed on the board before the client order exists in the application.
 * They live in board_orders (draft = 1, numbers "W-1", "W-2"…), so bars, km
 * and totals treat them like any order.
 *
 * When an import brings a new order on the same truck with loading within
 * one day of the draft, the order replaces the draft: automatically when the
 * pairing is unambiguous (ties broken by the same first loading place),
 * otherwise the review queue asks.
 */

export const DRAFT_PREFIX = 'W-'

export function isDraftNo(orderNo: string): boolean {
  return orderNo.startsWith(DRAFT_PREFIX)
}

export interface MatchOrder {
  orderNo: string
  /** Fleet trucks the order runs on (subcontractor tractor, PRZ legs). */
  truckIds: number[]
  loadDate: string
  /** Place code of the first loading place, null when unknown. */
  firstPlace: string | null
}

export interface MatchDraft {
  orderNo: string
  truckId: number | null
  loadDate: string
  firstPlace: string | null
}

export interface DraftMatches {
  /** Draft number → order number replacing it. */
  auto: Array<{ draftNo: string; orderNo: string }>
  /** Draft number → candidate order numbers (the user decides). */
  ambiguous: Array<{ draftNo: string; candidates: string[] }>
}

function narrow<T extends { firstPlace: string | null }>(list: T[], place: string | null): T[] {
  if (list.length <= 1 || !place) return list
  const same = list.filter(x => x.firstPlace === place)
  return same.length === 1 ? same : list
}

/** Pairs new orders from an import with drafts (pure; see the module comment). */
export function matchDrafts(orders: MatchOrder[], drafts: MatchDraft[]): DraftMatches {
  const fits = (o: MatchOrder, d: MatchDraft) => d.truckId !== null && o.truckIds.includes(d.truckId) && Math.abs(daysBetween(d.loadDate, o.loadDate)) <= 1
  const result: DraftMatches = { auto: [], ambiguous: [] }
  for (const d of drafts) {
    const candidates = orders.filter(o => fits(o, d))
    if (candidates.length === 0) continue
    const options = narrow(candidates, d.firstPlace)
    if (options.length === 1) {
      const order = options[0]!
      const rivals = narrow(
        drafts.filter(x => fits(order, x)),
        order.firstPlace,
      )
      if (rivals.length === 1 && rivals[0] === d) {
        result.auto.push({ draftNo: d.orderNo, orderNo: order.orderNo })
        continue
      }
    }
    result.ambiguous.push({ draftNo: d.orderNo, candidates: candidates.map(o => o.orderNo) })
  }
  return result
}

/**
 * The order from the application replaces the draft: board notes move to the
 * order, the order's history records it, the draft (with its corrections and
 * change log) is removed. The application wins in everything else.
 */
export async function replaceDraft(db: Kysely<DB>, draftNo: string, orderNo: string, label: string, now: string): Promise<void> {
  await db.transaction().execute(async trx => {
    const draft = await trx.selectFrom('board_orders').select('order_no').where('order_no', '=', draftNo).where('draft', '=', 1).executeTakeFirst()
    if (!draft) return
    await trx.updateTable('board_notes').set({ order_no: orderNo }).where('scope', '=', 'order').where('order_no', '=', draftNo).execute()
    await trx
      .insertInto('board_order_changes')
      .values({ order_no: orderNo, import_id: null, field: 'draft_replaced', old_value: draftNo, new_value: label, created_at: now })
      .execute()
    await trx
      .updateTable('board_issues')
      .set({ status: 'resolved', resolution: `replaced:${orderNo}`, updated_at: now })
      .where('ref', '=', draftNo)
      .where('status', '=', 'open')
      .execute()
    await trx.deleteFrom('board_orders').where('order_no', '=', draftNo).execute()
  })
}
