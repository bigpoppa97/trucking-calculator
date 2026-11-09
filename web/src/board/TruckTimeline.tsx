import type { Service, WeekBar, WeekEvent, WeekTruck } from './boardApi.js'
import { EVENT_LABELS, dm, dmTime, km, signedEur, stamp } from './format.js'
import { EVENT_ICON, Icon } from './Icon.js'
import { SERVICE_COLORS, ServiceStrip } from './serviceUi.js'

/**
 * One truck over one week: order bars from loading to unloading, the service
 * strip under them, day events and the "now" line. Shared by the board (one
 * row per truck) and the set page (one row per week).
 */

/**
 * Positions inside a truck-week are in days from Monday 00:00 (0–7). The area has 7 day columns
 * with 4 px gaps (bars, chips, the row of days above and the day lines share it), so a moment
 * is placed in its day column in proportion to the hour (29.10.2026).
 */
// 09.11.2026: ¾ of a day (was ½) — the route is written in full on the bar, in as many lines as
// it needs, and the longest word of a place name ("Budapeszt", "Dobrzykowice") must fit.
export const BAR_MIN_DAYS = 0.75
/** Room a chip takes for stacking (it is at most one day wide and may run into the next day). */
export const CHIP_DAYS = 0.95
/** A paid cancellation chip is wider (09.11.2026): number, "anulacja płatna" and the margin should fit. */
export const PAID_CHIP_DAYS = 1.5

/** Width of a chip in days. */
export function chipDays(item: ChipItem): number {
  return item.kind === 'paid' ? PAID_CHIP_DAYS : CHIP_DAYS
}

/** "HH:MM" → fraction of a day; null when unknown. */
function dayFraction(time: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? '')
  if (!m) return null
  return Math.min(1, (Number(m[1]) * 60 + Number(m[2])) / 1440)
}

/**
 * CSS offset of a start position x (days) in the content box: a whole day begins its own column.
 * `box` = the content width in CSS terms ('100%' inside the inner boxes; the padded outer box is 100% − 16 px).
 */
export function startCss(x: number, box = '100%'): string {
  const gaps = Math.max(0, Math.min(6, Math.floor(x + 1e-9)))
  return `calc((${box} - 24px) * ${(x / 7).toFixed(6)} + ${gaps * 4}px)`
}

export interface PlacedBar extends WeekBar {
  /** Days from Monday 00:00, clipped to the week; `end` includes the minimum width. */
  start: number
  end: number
  lane: number
}

/**
 * Bars from the loading hour to the unloading hour (29.10.2026); a missing hour = the whole day
 * (loading from its start, unloading to its end). A short bar is at least BAR_MIN_DAYS wide so the
 * route can be read in full. Bars go into rows ("lanes"): one row holds orders that do not overlap.
 */
export function placeBars(bars: WeekBar[]): PlacedBar[] {
  const items = bars.map(b => {
    const startFrac = b.startDay < 0 ? 0 : (dayFraction(b.startTime) ?? 0)
    const endFrac = b.endDay > 6 ? 1 : (dayFraction(b.endTime) ?? 1)
    let start = Math.max(0, Math.min(7, Math.max(0, b.startDay) + startFrac))
    let end = Math.max(0, Math.min(7, Math.min(6, b.endDay) + endFrac))
    if (end - start < BAR_MIN_DAYS) {
      end = Math.min(7, start + BAR_MIN_DAYS)
      start = Math.min(start, end - BAR_MIN_DAYS)
    }
    return { b, start, end }
  })
  items.sort((x, y) => x.start - y.start || x.end - y.end)
  const laneEnds: number[] = []
  return items.map(({ b, start, end }) => {
    let lane = laneEnds.findIndex(e => e <= start + 1e-9)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(end)
    } else laneEnds[lane] = end
    return { ...b, start, end, lane: lane + 1 }
  })
}

export interface PlacedEvent {
  event: WeekEvent
  /** Days from Monday 00:00: the event's hour, or the start of its day. */
  x: number
  lane: number
}

/** A chip under the bars: a day event, or a paid cancellation at its loading day and hour (09.11.2026). */
export type ChipItem = { kind: 'event'; event: WeekEvent } | { kind: 'paid'; bar: WeekBar }

export interface PlacedChip {
  item: ChipItem
  x: number
  lane: number
}

/** Chips under the bars at their hour (29.10.2026); chips that would overlap go to the next row. */
export function placeChips(chips: ChipItem[], days: string[]): PlacedChip[] {
  const items = chips
    .map(item => {
      const day = item.kind === 'event' ? item.event.day : item.bar.startDate
      const time = item.kind === 'event' ? item.event.time : item.bar.startTime
      const d = days.indexOf(day)
      return d < 0 ? null : { item, x: d + (dayFraction(time) ?? 0) }
    })
    .filter((it): it is { item: ChipItem; x: number } => it !== null)
    .sort((a, b) => a.x - b.x)
  const laneEnds: number[] = []
  return items.map(({ item, x }) => {
    const width = chipDays(item)
    const from = Math.min(x, 7 - width)
    let lane = laneEnds.findIndex(e => e <= from + 1e-9)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(from + width)
    } else laneEnds[lane] = from + width
    return { item, x, lane }
  })
}

/** Day events under the bars at their hour (29.10.2026); chips that would overlap go to the next row. */
export function placeEvents(events: WeekEvent[], days: string[]): PlacedEvent[] {
  return placeChips(
    events.map(event => ({ kind: 'event' as const, event })),
    days,
  ).map(c => ({ event: (c.item as { kind: 'event'; event: WeekEvent }).event, x: c.x, lane: c.lane }))
}

/** Co-load riding with another order ("doładunek", 28.10.2026): light purple. */
export const COLOAD_COLORS = { bg: '#E9E0F5', fg: '#2E1F47' } as const

/** Paid cancellation chip ("Anulacja płatna", 09.11.2026): rose — a colour no other mark uses. */
export const PAID_CANCEL_COLORS = { bg: '#FBE8EE', fg: '#5B1830', border: '#C77D93' } as const

export function barColors(b: WeekBar, selected: boolean): { bg: string; fg: string; outline: string } {
  if (selected) return { bg: '#1E4E9C', fg: '#FFFFFF', outline: b.serviceConflict ? `2px solid #FCA5A5` : b.prz || b.draft ? '2px dashed #FFFFFF' : 'none' }
  let bg = '#DCE5F2'
  let fg = '#15181C'
  if (!b.inWeek) {
    bg = '#ECEEF0'
    fg = '#545B63'
  }
  if (b.draft) {
    bg = '#F4F6FA'
    fg = '#2B3440'
  }
  if (b.coLoadOf) {
    bg = COLOAD_COLORS.bg
    fg = COLOAD_COLORS.fg
  }
  // "Zniknęło" is told only in the order panel (12.10.2026).
  if (b.excluded || b.noCarrier) {
    bg = '#F1F2F0'
    fg = '#6B7178'
  }
  if (b.issue) {
    bg = '#F4C77A'
    fg = '#3A2400'
  }
  const outline = b.serviceConflict
    ? `2px ${b.prz || b.draft ? 'dashed' : 'solid'} ${SERVICE_COLORS.conflict}`
    : b.prz
      ? '2px dashed #1E4E9C'
      : b.draft
        ? '2px dashed #7C8794'
        : 'none'
  return { bg, fg, outline }
}

export interface TruckTimelineProps {
  row: WeekTruck
  weekStart: string
  days: string[]
  showMoney: boolean
  selected: string | null
  tip: string | null
  nowFraction: number | null
  onSelect: (orderNo: string) => void
  onTip: (key: string | null) => void
  onAddEvent?: ((day: string) => void) | undefined
  onOpenService: (s: Service) => void
  /** Driver change chip clicked (edit / delete the change). */
  onOpenDriverChange?: ((e: WeekEvent) => void) | undefined
  /** Board day event (note, pause, trailer, position) clicked — edit or delete it. */
  onOpenEvent?: ((e: WeekEvent) => void) | undefined
  /** Trailer change chip (automatic, or a board entry typed over one) clicked — day, hour, place. */
  onOpenTrailerChange?: ((e: WeekEvent) => void) | undefined
}

/** Left edge of day `d` (0–7) in a week area with 8 px padding and 4 px gaps between the columns (bars, events, header). */
export function dayEdge(d: number): string {
  return `calc(6px + (100% - 12px) * ${d} / 7)`
}

/**
 * Day columns behind the bars (29.10.2026): a thin line on each day boundary, like spreadsheet
 * gridlines, and today's column faintly tinted. Bars and chips lie on top of it.
 */
export function DayGrid({ todayIndex, line = '#E4E7E2', today = '#F2F6FC' }: { todayIndex: number | null; line?: string; today?: string }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {todayIndex !== null && (
        <div className="absolute inset-y-0" style={{ left: dayEdge(todayIndex), width: 'calc((100% - 12px) / 7)', background: today }} />
      )}
      {[1, 2, 3, 4, 5, 6].map(d => (
        <div key={d} className="absolute inset-y-0 w-px" style={{ left: dayEdge(d), background: line }} />
      ))}
    </div>
  )
}

/** Chip text of a day event: "14:00 · POZ: TEST" with an hour and a place (the hour first — long chips are cut at the end). */
export function eventChipText(e: WeekEvent): string {
  return `${e.time ? `${e.time} · ` : ''}${e.place && !e.auto ? `${e.place}: ` : ''}${e.text}`
}

const LANE_H = 50
const LANE_GAP = 6
const CHIP_ROW_H = 24

/**
 * Bars sit on a grid of half-hour columns (09.11.2026): 48 per day, a 4 px gap column between
 * days (the same geometry as startCss, the row of days and the day lines). A grid row
 * grows with the tallest bar in it, so a route wraps onto as many lines as it needs instead of
 * being cut with "…".
 */
const SLOTS = 48
const BAR_GRID_COLS = Array.from({ length: 7 }, () => `repeat(${SLOTS}, minmax(0, 1fr))`).join(' 4px ')

/** Grid line of a position x (days from Monday 00:00); an end on a day boundary closes the previous day. */
export function gridLine(x: number, end: boolean): number {
  let day = Math.floor(x + 1e-9)
  let frac = x - day
  if (end && frac < 1e-9 && day > 0) {
    day -= 1
    frac = 1
  }
  if (day > 6) {
    day = 6
    frac = 1
  }
  return day * (SLOTS + 1) + Math.round(frac * SLOTS) + 1
}

export function TruckTimeline({
  row,
  weekStart,
  days,
  showMoney,
  selected,
  tip,
  nowFraction,
  onSelect,
  onTip,
  onAddEvent,
  onOpenService,
  onOpenDriverChange,
  onOpenEvent,
  onOpenTrailerChange,
}: TruckTimelineProps) {
  // A paid cancellation (09.11.2026) is not a bar: the truck did not drive — a chip on the loading day.
  const bars = placeBars(row.bars.filter(b => !b.paidCancel))
  const chips = placeChips(
    [
      ...row.bars.filter(b => b.paidCancel).map(bar => ({ kind: 'paid' as const, bar })),
      ...row.events.map(event => ({ kind: 'event' as const, event })),
    ],
    days,
  )
  const chipRows = chips.reduce((m, c) => Math.max(m, c.lane + 1), 0)
  const todayIndex = nowFraction !== null ? Math.min(6, Math.floor(nowFraction * 7)) : null
  return (
    <div className="relative min-w-0 p-2">
      <DayGrid todayIndex={todayIndex} />
      <div className="relative grid" style={{ gridTemplateColumns: BAR_GRID_COLS, gridAutoRows: `minmax(${LANE_H}px, auto)`, rowGap: LANE_GAP }}>
        {bars.map(b => {
          const isSel = selected === b.orderNo
          const c = barColors(b, isSel)
          const sub = [
            b.serviceConflict ? 'serwis!' : null,
            b.draft ? 'wstępne' : null,
            b.coLoadOf ? 'doładunek' : null,
            b.prz ? 'PRZ' : null,
            b.issue ? 'Sprawdź' : null,
            b.excluded === 'cancelled' ? 'anulowane' : b.excluded === 'unconfirmed' ? 'niezatwierdzone' : b.excluded === 'manual' ? 'wyłączone' : null,
            b.noCarrier ? 'anulowane u przewoźnika' : null,
            showMoney && !b.excluded ? signedEur(b.margin) : null,
            // A co-load has no km of its own — they are on the main order.
            b.coLoadOf ? null : km(b.kmLoaded === null && b.kmEmpty === null ? null : (b.kmLoaded ?? 0) + (b.kmEmpty ?? 0), b.kmEstimated),
          ]
            .filter(Boolean)
            // A line breaks only between the parts, never inside "≈258 km" or "+90 €".
            .map(part => String(part).replace(/ /g, '\u00A0'))
            .join(' · ')
          const tipKey = `${weekStart}|${b.key}`
          return (
            <div
              key={b.key}
              data-testid={`bar-${b.key}`}
              className="relative flex min-w-0 items-stretch rounded-[7px]"
              style={{
                gridRow: b.lane,
                gridColumn: `${gridLine(b.start, false)} / ${gridLine(b.end, true)}`,
                // 3 px of air before the next bar in the same row
                marginRight: 3,
                background: c.bg,
                color: c.fg,
                outline: c.outline,
                outlineOffset: -2,
                textDecoration: b.excluded === 'cancelled' ? 'line-through' : undefined,
              }}
            >
              <button
                type="button"
                onClick={() => onSelect(b.orderNo)}
                title={`${b.orderNo}${b.draft ? ' (wstępne)' : ''}${b.coLoadOf ? ` (doładunek do ${b.coLoadOf})` : ''} · ${b.title}\n${dmTime(b.startDate, b.startTime)} → ${dmTime(b.endDate, b.endTime)}`}
                aria-label={`${b.orderNo}${b.draft ? ', zlecenie wstępne' : ''}${b.coLoadOf ? `, doładunek do ${b.coLoadOf}` : ''}, ${b.title}, ${dmTime(b.startDate, b.startTime)}–${dmTime(b.endDate, b.endTime)}${b.serviceConflict ? `. ${b.serviceConflict}` : ''}`}
                className="flex min-w-0 flex-1 cursor-pointer flex-col justify-center gap-0.5 px-1.5 py-1.5 text-left text-[13px] leading-tight"
              >
                {/* The whole route, wrapped (09.11.2026); the note icon sits in the top-right corner — only the first line makes room for it. */}
                <span className="block w-full font-semibold [overflow-wrap:break-word]">
                  {b.noteLines.length > 0 && <span aria-hidden="true" className="float-right h-3.5 w-4" />}
                  {b.startDay < 0 ? '‹ ' : ''}
                  {b.title}
                  {b.endDay > 6 ? ' ›' : ''}
                </span>
                <span className="block w-full font-mono text-[11.5px] [overflow-wrap:break-word]">{sub}</span>
              </button>
              {b.noteLines.length > 0 && (
                <button
                  type="button"
                  aria-label="Pokaż notatkę do zlecenia"
                  onMouseEnter={() => onTip(tipKey)}
                  onMouseLeave={() => onTip(null)}
                  onFocus={() => onTip(tipKey)}
                  onBlur={() => onTip(null)}
                  className="absolute right-0.5 top-1 flex h-5 w-5 cursor-help items-center justify-center"
                  style={b.serviceConflict ? { color: isSel ? '#FFFFFF' : SERVICE_COLORS.conflict } : undefined}
                >
                  <Icon name={b.serviceConflict ? 'alert' : 'note'} size={14} />
                </button>
              )}
              {tip === tipKey && (
                <div
                  role="tooltip"
                  className="absolute right-0 top-[calc(100%+6px)] z-30 w-[300px] whitespace-pre-line rounded-lg bg-[#15181C] px-3 py-2.5 text-[12.5px] leading-normal text-[#F3F4F1] shadow-xl"
                >
                  {b.noteLines.join('\n')}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <ServiceStrip services={row.services} weekStart={weekStart} onOpen={onOpenService} />
      {chipRows > 0 && (
        <div className="relative mt-1.5" style={{ height: chipRows * CHIP_ROW_H }}>
          {chips.map(({ item, x, lane }, i) => (
            <div
              key={
                item.kind === 'paid'
                  ? `p${item.bar.key}`
                  : item.event.driverChangeId !== undefined
                    ? `d${item.event.driverChangeId}`
                    : item.event.id !== null
                      ? `n${item.event.id}`
                      : `a${item.event.autoKey ?? i}`
              }
              className="absolute flex"
              style={{
                top: lane * CHIP_ROW_H,
                // at its hour; a chip late on Sunday is moved left to stay inside the week
                left: `min(${startCss(x)}, calc(100% - (100% - 24px) * ${chipDays(item) / 7}))`,
                maxWidth: `calc((100% - 24px) * ${chipDays(item) / 7})`,
              }}
            >
              {item.kind === 'paid' ? (
                <PaidCancelChip b={item.bar} selected={selected === item.bar.orderNo} showMoney={showMoney} onSelect={onSelect} />
              ) : (
                <EventChip
                  e={item.event}
                  onOpenDriverChange={onOpenDriverChange}
                  onOpenEvent={onOpenEvent}
                  onOpenTrailerChange={onOpenTrailerChange}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {onAddEvent && (
        <div className="relative mt-1 grid grid-cols-7 gap-1">
          {days.map(day => (
            <div key={day}>
              <button
                type="button"
                onClick={() => onAddEvent(day)}
                aria-label={`Dodaj zdarzenie: ${row.plate}, ${dm(day)}`}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[#9AA3AC] hover:bg-[#EEF0EC] hover:text-[#15181C] focus:text-[#15181C]"
              >
                <Icon name="plus" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {nowFraction !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-[#C2410C]"
          style={{ left: `calc(8px + ${startCss(nowFraction * 7, '(100% - 16px)')})` }}
        />
      )}
    </div>
  )
}

/**
 * Paid cancellation (09.11.2026): the client pays, the truck did not drive — a chip at the loading
 * day and hour instead of a bar, so the truck's days stay free for other orders. Opens the order panel.
 */
function PaidCancelChip({ b, selected, showMoney, onSelect }: { b: WeekBar; selected: boolean; showMoney: boolean; onSelect: (orderNo: string) => void }) {
  const colors = selected
    ? { bg: '#1E4E9C', fg: '#FFFFFF', border: '#1E4E9C' }
    : b.issue
      ? { bg: '#F4C77A', fg: '#3A2400', border: '#C9962F' }
      : PAID_CANCEL_COLORS
  const text = [b.orderNo, 'anulacja płatna', b.issue ? 'Sprawdź' : null, showMoney ? signedEur(b.margin) : null].filter(Boolean).join(' · ')
  return (
    <button
      type="button"
      data-testid={`paid-${b.key}`}
      onClick={() => onSelect(b.orderNo)}
      aria-label={`${b.orderNo}, anulacja płatna, ${b.title}, załadunek ${dmTime(b.startDate, b.startTime)}${b.issue ? ', do sprawdzenia' : ''}`}
      title={`${b.orderNo} · ${b.title}\nAnulacja płatna — klient płaci, auto nie jechało (bez km).\nPlanowany załadunek ${dmTime(b.startDate, b.startTime)}`}
      className="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-semibold"
      style={{ background: colors.bg, color: colors.fg, borderColor: colors.border }}
    >
      <Icon name="ban" size={12} />
      <span className="truncate">{text}</span>
    </button>
  )
}

/** One day event under the bars: driver change, trailer change (automatic or typed over), board event. */
function EventChip({
  e,
  onOpenDriverChange,
  onOpenEvent,
  onOpenTrailerChange,
}: {
  e: WeekEvent
  onOpenDriverChange?: ((e: WeekEvent) => void) | undefined
  onOpenEvent?: ((e: WeekEvent) => void) | undefined
  onOpenTrailerChange?: ((e: WeekEvent) => void) | undefined
}) {
  if (e.driverChangeId !== undefined && onOpenDriverChange) {
    return (
      <button
        type="button"
        onClick={() => onOpenDriverChange(e)}
        aria-label={e.text}
        title={`${e.text}${e.time ? ` (od ${e.time})` : ''} — kliknij, żeby poprawić albo usunąć`}
        className="inline-flex max-w-full items-center gap-1 rounded-full border border-[#9AB3DA] bg-[#EEF3FB] px-2 py-0.5 text-[11.5px] text-[#1E3A6E] hover:border-[#1E4E9C]"
      >
        <Icon name="driver" size={12} />
        <span className="truncate">
          {e.time ? `${e.time} ` : ''}→ {e.text.split(' → ').pop()?.replace(/^Kierowca: /, '')}
        </span>
      </button>
    )
  }
  if (e.autoKey && onOpenTrailerChange) {
    return (
      <button
        type="button"
        onClick={() => onOpenTrailerChange(e)}
        aria-label={`Naczepa: ${eventChipText(e)}${e.auto ? ' (wykryta automatycznie)' : ''}`}
        title={
          e.auto
            ? 'Wykryte automatycznie z naczep w zleceniach — kliknij, żeby poprawić dzień, godzinę albo miejsce'
            : `Naczepa${e.placeName ? ` · ${e.placeName}` : ''}${e.createdBy ? ` · ${e.createdBy}` : ''}${e.createdAt ? `, ${stamp(e.createdAt)}` : ''}\n${e.text}\nPoprawione na tablicy (automatycznie: ${e.autoDay ? dm(e.autoDay) : ''}) — kliknij, żeby zmienić.`
        }
        className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] text-[#3D444C] hover:border-[#545B63] ${e.auto ? 'border-dashed border-[#9AA3AC] bg-[#F7F8F6]' : 'border-[#D5D9D3] bg-white'}`}
      >
        <Icon name={EVENT_ICON[e.kind] ?? 'note'} size={12} />
        <span className="truncate">{eventChipText(e)}</span>
      </button>
    )
  }
  if (!e.auto && e.id !== null && onOpenEvent) {
    return (
      <button
        type="button"
        onClick={() => onOpenEvent(e)}
        aria-label={`${EVENT_LABELS[e.kind] ?? 'Zdarzenie'}: ${eventChipText(e)}`}
        title={`${EVENT_LABELS[e.kind] ?? 'Zdarzenie'}${e.placeName ? ` · ${e.placeName}` : ''}${e.createdBy ? ` · ${e.createdBy}` : ''}${e.createdAt ? `, ${stamp(e.createdAt)}` : ''}\n${e.text}\nKliknij, żeby poprawić albo usunąć.`}
        className="inline-flex max-w-full items-center gap-1 rounded-full border border-[#D5D9D3] bg-white px-2 py-0.5 text-[11.5px] text-[#3D444C] hover:border-[#9AA3AC]"
      >
        <Icon name={EVENT_ICON[e.kind] ?? 'note'} size={12} />
        <span className="truncate">{eventChipText(e)}</span>
      </button>
    )
  }
  return (
    <span
      title={e.auto ? 'Wykryte automatycznie z naczep w zleceniach' : EVENT_LABELS[e.kind]}
      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] ${e.auto ? 'border-dashed border-[#9AA3AC] bg-[#F7F8F6]' : 'border-[#D5D9D3] bg-white'} text-[#3D444C]`}
    >
      <Icon name={EVENT_ICON[e.kind] ?? 'note'} size={12} />
      <span className="truncate">{eventChipText(e)}</span>
    </span>
  )
}

/** Position of the "now" line within a week (0–1), or null when today is outside it. */
export function nowFractionFor(days: string[], today: string): number | null {
  const dayIndex = days.indexOf(today)
  if (dayIndex < 0) return null
  const now = new Date()
  return (dayIndex + (now.getHours() + now.getMinutes() / 60) / 24) / 7
}
