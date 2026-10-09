import type { Service, WeekBar, WeekEvent, WeekTruck } from './boardApi.js'
import { EVENT_LABELS, dm, km, signedEur } from './format.js'
import { EVENT_ICON, Icon } from './Icon.js'
import { SERVICE_COLORS, ServiceStrip } from './serviceUi.js'

/**
 * One truck over one week: order bars from loading to unloading, the service
 * strip under them, day events and the "now" line. Shared by the board (one
 * row per truck) and the set page (one row per week).
 */

export interface PlacedBar extends WeekBar {
  colStart: number
  colEnd: number
  lane: number
}

export function placeBars(bars: WeekBar[]): PlacedBar[] {
  const laneEnds: number[] = []
  return [...bars]
    .sort((a, b) => a.startDay - b.startDay || a.endDay - b.endDay)
    .map(b => {
      const s = Math.max(0, b.startDay)
      const e = Math.min(6, b.endDay)
      let lane = laneEnds.findIndex(end => end < s)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(e)
      } else laneEnds[lane] = e
      return { ...b, colStart: s + 1, colEnd: e + 2, lane: lane + 1 }
    })
}

export function barColors(b: WeekBar, selected: boolean): { bg: string; fg: string; outline: string } {
  if (selected) return { bg: '#1E4E9C', fg: '#FFFFFF', outline: b.serviceConflict ? `2px solid #FCA5A5` : b.prz ? '2px dashed #FFFFFF' : 'none' }
  let bg = '#DCE5F2'
  let fg = '#15181C'
  if (!b.inWeek) {
    bg = '#ECEEF0'
    fg = '#545B63'
  }
  if (b.excluded || b.noCarrier || b.missing) {
    bg = '#F1F2F0'
    fg = '#6B7178'
  }
  if (b.issue) {
    bg = '#F4C77A'
    fg = '#3A2400'
  }
  const outline = b.serviceConflict ? `2px ${b.prz ? 'dashed' : 'solid'} ${SERVICE_COLORS.conflict}` : b.prz ? '2px dashed #1E4E9C' : 'none'
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
}

export function TruckTimeline({ row, weekStart, days, showMoney, selected, tip, nowFraction, onSelect, onTip, onAddEvent, onOpenService, onOpenDriverChange }: TruckTimelineProps) {
  const bars = placeBars(row.bars)
  return (
    <div className="relative min-w-0 p-2">
      <div className="grid grid-cols-7 gap-x-1 gap-y-1.5" style={{ gridAutoRows: '50px' }}>
        {bars.map(b => {
          const isSel = selected === b.orderNo
          const c = barColors(b, isSel)
          const sub = [
            b.serviceConflict ? 'serwis!' : null,
            b.prz ? 'PRZ' : null,
            b.issue ? 'Sprawdź' : null,
            b.excluded === 'cancelled' ? 'anulowane' : b.excluded === 'unconfirmed' ? 'niezatwierdzone' : b.excluded === 'manual' ? 'wyłączone' : null,
            b.noCarrier ? 'brak przewoźnika' : null,
            b.missing ? 'zniknęło' : null,
            showMoney && !b.excluded ? signedEur(b.margin) : null,
            km(b.kmLoaded === null && b.kmEmpty === null ? null : (b.kmLoaded ?? 0) + (b.kmEmpty ?? 0), b.kmEstimated),
          ]
            .filter(Boolean)
            .join(' · ')
          const tipKey = `${weekStart}|${b.key}`
          return (
            <div
              key={b.key}
              className="relative flex min-w-0 items-stretch rounded-[7px]"
              style={{
                gridColumn: `${b.colStart} / ${b.colEnd}`,
                gridRow: b.lane,
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
                aria-label={`${b.orderNo}, ${b.title}, ${dm(b.startDate)}–${dm(b.endDate)}${b.serviceConflict ? `. ${b.serviceConflict}` : ''}`}
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
      <div className="mt-1.5 grid grid-cols-7 gap-1">
        {days.map(day => (
          <div key={day} className="flex min-w-0 flex-col items-start gap-1">
            {row.events
              .filter(e => e.day === day)
              .map((e, i) =>
                e.driverChangeId !== undefined && onOpenDriverChange ? (
                  <button
                    key={`d${e.driverChangeId}`}
                    type="button"
                    onClick={() => onOpenDriverChange(e)}
                    aria-label={e.text}
                    title={`${e.text} — kliknij, żeby poprawić albo usunąć`}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-[#9AB3DA] bg-[#EEF3FB] px-2 py-0.5 text-[11.5px] text-[#1E3A6E] hover:border-[#1E4E9C]"
                  >
                    <Icon name="driver" size={12} />
                    <span className="truncate">→ {e.text.split(' → ').pop()?.replace(/^Kierowca: /, '')}</span>
                  </button>
                ) : (
                  <span
                    key={`${e.id ?? 'auto'}-${i}`}
                    title={e.auto ? 'Wykryte automatycznie z naczep w zleceniach' : EVENT_LABELS[e.kind]}
                    className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] ${e.auto ? 'border-dashed border-[#9AA3AC] bg-[#F7F8F6]' : 'border-[#D5D9D3] bg-white'} text-[#3D444C]`}
                  >
                    <Icon name={EVENT_ICON[e.kind] ?? 'note'} size={12} />
                    <span className="truncate">{e.text}</span>
                  </span>
                ),
              )}
            {onAddEvent && (
              <button
                type="button"
                onClick={() => onAddEvent(day)}
                aria-label={`Dodaj zdarzenie: ${row.plate}, ${dm(day)}`}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[#9AA3AC] hover:bg-[#EEF0EC] hover:text-[#15181C] focus:text-[#15181C]"
              >
                <Icon name="plus" size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      {nowFraction !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-[#C2410C]"
          style={{ left: `calc(8px + (100% - 16px) * ${nowFraction})` }}
        />
      )}
    </div>
  )
}

/** Position of the "now" line within a week (0–1), or null when today is outside it. */
export function nowFractionFor(days: string[], today: string): number | null {
  const dayIndex = days.indexOf(today)
  if (dayIndex < 0) return null
  const now = new Date()
  return (dayIndex + (now.getHours() + now.getMinutes() / 60) / 24) / 7
}
