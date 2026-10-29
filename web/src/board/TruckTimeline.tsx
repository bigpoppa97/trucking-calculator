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
export const BAR_MIN_DAYS = 0.5
/** Room a chip takes for stacking (it is at most one day wide and may run into the next day). */
export const CHIP_DAYS = 0.95

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

/** CSS offset of an end position x (days): a whole day ends at the end of the previous column. */
export function endCss(x: number): string {
  const gaps = Math.max(0, Math.min(6, Math.ceil(x - 1e-9) - 1))
  return `calc((100% - 24px) * ${(x / 7).toFixed(6)} + ${gaps * 4}px)`
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
 * route can be read. Bars go into rows ("lanes"): one row holds orders that do not overlap.
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

/** Day events under the bars at their hour (29.10.2026); chips that would overlap go to the next row. */
export function placeEvents(events: WeekEvent[], days: string[]): PlacedEvent[] {
  const items = events
    .map(event => {
      const d = days.indexOf(event.day)
      return d < 0 ? null : { event, x: d + (dayFraction(event.time) ?? 0) }
    })
    .filter((it): it is { event: WeekEvent; x: number } => it !== null)
    .sort((a, b) => a.x - b.x)
  const laneEnds: number[] = []
  return items.map(({ event, x }) => {
    const from = Math.min(x, 7 - CHIP_DAYS)
    let lane = laneEnds.findIndex(e => e <= from + 1e-9)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(from + CHIP_DAYS)
    } else laneEnds[lane] = from + CHIP_DAYS
    return { event, x, lane }
  })
}

/** Co-load riding with another order ("doładunek", 28.10.2026): light purple. */
export const COLOAD_COLORS = { bg: '#E9E0F5', fg: '#2E1F47' } as const

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
  const bars = placeBars(row.bars)
  const lanes = bars.reduce((m, b) => Math.max(m, b.lane), 0)
  const chips = placeEvents(row.events, days)
  const chipRows = chips.reduce((m, c) => Math.max(m, c.lane + 1), 0)
  const todayIndex = nowFraction !== null ? Math.min(6, Math.floor(nowFraction * 7)) : null
  return (
    <div className="relative min-w-0 p-2">
      <DayGrid todayIndex={todayIndex} />
      <div className="relative" style={{ height: lanes > 0 ? lanes * LANE_H + (lanes - 1) * LANE_GAP : 0 }}>
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
            .join(' · ')
          const tipKey = `${weekStart}|${b.key}`
          return (
            <div
              key={b.key}
              data-testid={`bar-${b.key}`}
              className="absolute flex min-w-0 items-stretch rounded-[7px]"
              style={{
                top: (b.lane - 1) * (LANE_H + LANE_GAP),
                height: LANE_H,
                left: startCss(b.start),
                // 3 px of air before the next bar in the same row
                width: `calc(${endCss(b.end)} - ${startCss(b.start)} - 3px)`,
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
                className="flex min-w-0 flex-1 cursor-pointer flex-col justify-center gap-0.5 px-2 py-1 text-left text-[13px]"
              >
                <span className="block w-full truncate font-semibold">
                  {b.startDay < 0 ? '‹ ' : ''}
                  {b.title}
                  {b.endDay > 6 ? ' ›' : ''}
                </span>
                <span className="block w-full truncate font-mono text-[11.5px]">{sub}</span>
              </button>
              {b.noteLines.length > 0 && (
                <button
                  type="button"
                  aria-label="Pokaż notatkę do zlecenia"
                  onMouseEnter={() => onTip(tipKey)}
                  onMouseLeave={() => onTip(null)}
                  onFocus={() => onTip(tipKey)}
                  onBlur={() => onTip(null)}
                  className="flex w-6 flex-none cursor-help items-start justify-center pt-[7px]"
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
          {chips.map(({ event: e, x, lane }, i) => (
            <div
              key={e.driverChangeId !== undefined ? `d${e.driverChangeId}` : e.id !== null ? `n${e.id}` : `a${e.autoKey ?? i}`}
              className="absolute flex"
              style={{
                top: lane * CHIP_ROW_H,
                // at its hour; a chip late on Sunday is moved left to stay inside the week
                left: `min(${startCss(x)}, calc(100% - (100% - 24px) * ${CHIP_DAYS / 7}))`,
                maxWidth: `calc((100% - 24px) * ${CHIP_DAYS / 7})`,
              }}
            >
              <EventChip
                e={e}
                onOpenDriverChange={onOpenDriverChange}
                onOpenEvent={onOpenEvent}
                onOpenTrailerChange={onOpenTrailerChange}
              />
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
