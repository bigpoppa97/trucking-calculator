import { useCallback, useEffect, useMemo, useState } from 'react'
import { boardApi, errorMessage, type NoteKind, type WeekBar, type WeekTruck, type WeekView } from './boardApi.js'
import { DAY_NAMES, EVENT_LABELS, addDaysIso, dm, eur, km, pct, perKm, signedEur, stamp, todayIso, weekRangeLabel } from './format.js'
import { EVENT_ICON, Icon } from './Icon.js'
import { OrderPanel } from './OrderPanel.js'

/**
 * Week view of the fleet board: trucks in rows, days in columns, orders as
 * bars from loading to unloading, events under the bars, week totals per
 * truck and for the department.
 */

const MONEY_KEY = 'tablica.showMoney'

function readShowMoney(): boolean {
  try {
    return localStorage.getItem(MONEY_KEY) !== '0'
  } catch {
    return true
  }
}

interface PlacedBar extends WeekBar {
  colStart: number
  colEnd: number
  lane: number
}

function placeBars(bars: WeekBar[]): PlacedBar[] {
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

function barColors(b: WeekBar, selected: boolean): { bg: string; fg: string; outline: string } {
  if (selected) return { bg: '#1E4E9C', fg: '#FFFFFF', outline: b.prz ? '2px dashed #FFFFFF' : 'none' }
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
  return { bg, fg, outline: b.prz ? '2px dashed #1E4E9C' : 'none' }
}

export interface WeekFocus {
  orderNo: string
  date: string
}

export function WeekPage({
  focus,
  initialDate,
  onReview,
  onDateChange,
}: {
  focus: WeekFocus | null
  initialDate?: string
  onReview: () => void
  onDateChange?: (date: string) => void
}) {
  const [date, setDate] = useState(focus?.date ?? initialDate ?? todayIso())
  const [view, setView] = useState<WeekView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showMoney, setShowMoney] = useState(readShowMoney)
  const [selected, setSelected] = useState<string | null>(focus?.orderNo ?? null)
  const [tip, setTip] = useState<string | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const [eventTarget, setEventTarget] = useState<{ truck: WeekTruck; day: string } | null>(null)

  useEffect(() => {
    if (focus) {
      setDate(focus.date)
      setSelected(focus.orderNo)
    }
  }, [focus])

  useEffect(() => {
    onDateChange?.(date)
  }, [date, onDateChange])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setView(await boardApi.week(date))
      setError(null)
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się wczytać tablicy.'))
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => {
    void load()
  }, [load])

  const toggleMoney = () => {
    setShowMoney(v => {
      try {
        localStorage.setItem(MONEY_KEY, v ? '0' : '1')
      } catch {
        // per-viewer convenience only
      }
      return !v
    })
  }

  const nowFraction = useMemo(() => {
    if (!view || view.today < view.weekStart || view.today > view.weekEnd) return null
    const dayIndex = view.days.indexOf(view.today)
    const now = new Date()
    return (dayIndex + (now.getHours() + now.getMinutes() / 60) / 24) / 7
  }, [view])

  const copy = async (truck: WeekTruck) => {
    try {
      await navigator.clipboard.writeText(truck.copyText)
    } catch {
      // clipboard unavailable — still show the text in the status
    }
    setCopied(truck.id)
    window.setTimeout(() => setCopied(c => (c === truck.id ? null : c)), 2500)
  }

  if (!view && loading) return <p className="p-6 text-sm text-[#545B63]">Wczytywanie tablicy…</p>
  if (!view) {
    return (
      <p role="alert" className="m-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
        {error}
      </p>
    )
  }

  const k = view.kpis
  return (
    <div className="pb-10">
      <section className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 pt-5 pb-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            aria-label="Poprzedni tydzień"
            onClick={() => setDate(addDaysIso(view.weekStart, -7))}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#C9CEC6] bg-white hover:bg-[#F7F8F6]"
          >
            <Icon name="left" size={18} />
          </button>
          <div className="flex flex-col px-1">
            <h1 className="text-[22px] font-bold leading-tight">Tydzień {view.weekNumber}</h1>
            <span className="text-[13px] text-[#545B63]">{weekRangeLabel(view.weekStart, view.weekEnd)}</span>
          </div>
          <button
            type="button"
            aria-label="Następny tydzień"
            onClick={() => setDate(addDaysIso(view.weekStart, 7))}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#C9CEC6] bg-white hover:bg-[#F7F8F6]"
          >
            <Icon name="right" size={18} />
          </button>
          <button
            type="button"
            onClick={() => setDate(todayIso())}
            className="h-11 rounded-lg border border-[#C9CEC6] bg-white px-3.5 font-semibold hover:bg-[#F7F8F6]"
          >
            Dziś
          </button>
          {loading && <span className="text-xs text-[#545B63]">odświeżanie…</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-[#3D444C]">
          <Legend color="#DCE5F2" label="Zlecenie" />
          <Legend color="#DCE5F2" label="Przepinka" dashed />
          <Legend color="#F4C77A" label="Do sprawdzenia" />
          <Legend color="#ECEEF0" label="Załadunek w poprzednim tygodniu" border />
          <label className="flex min-h-11 cursor-pointer items-center gap-2 pl-1.5 text-[13.5px] font-semibold text-[#15181C]">
            <input type="checkbox" checked={showMoney} onChange={toggleMoney} className="h-[18px] w-[18px] accent-[#1E4E9C]" />
            Pokaż kwoty
          </label>
        </div>
      </section>

      <section aria-label="Wynik tygodnia" className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5 px-6 pb-4">
        {showMoney && (
          <>
            <Kpi label="Marża tygodnia" value={eur(k.margin)} sub={`${pct(k.margin, k.revenue)} przychodu`} />
            <Kpi label="Przychód" value={eur(k.revenue)} sub={`${k.orders} zleceń z załadunkiem w tym tygodniu`} />
            <Kpi label="Koszt przewoźników" value={eur(k.cost)} sub="po skontach i poprawkach" />
          </>
        )}
        <Kpi label="Km razem" value={km(k.km, k.kmEstimated).replace(' km', '')} sub={`w tym puste ${pct(k.kmEmpty, k.km)}`} />
        {showMoney && <Kpi label="Przychód na km" value={perKm(k.revenuePerKm)} sub={`przewoźnik ${perKm(k.costPerKm)}/km`} />}
        <button type="button" onClick={onReview} className="rounded-[10px] border border-[#D5D9D3] bg-white px-3.5 py-3 text-left hover:border-[#9AA3AC]">
          <span className="block text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Do sprawdzenia</span>
          <span className="mt-1 block font-mono text-[22px] font-semibold">{k.openIssues}</span>
          <span className="block text-xs text-[#545B63]">otwórz listę</span>
        </button>
      </section>

      {view.trucks.length === 0 && (
        <p className="mx-6 rounded-lg border border-[#D5D9D3] bg-white px-4 py-6 text-center text-sm">
          Baza floty jest pusta. Dodaj swoje auta w zakładce <strong>Flota</strong> (albo uruchom <code>npm run board:seed</code>), a potem zaimportuj eksport.
        </p>
      )}
      {view.trucks.length > 0 && !view.lastImport && (
        <p className="mx-6 mb-3 rounded-lg border border-[#F4C77A] bg-[#FBEBD0] px-4 py-3 text-sm text-[#3A2400]">
          Nie ma jeszcze żadnego importu. Wgraj eksport z aplikacji w zakładce <strong>Do sprawdzenia</strong>.
        </p>
      )}

      {view.trucks.length > 0 && (
        <section className="relative px-6">
          <div className="overflow-x-auto rounded-xl border border-[#D5D9D3] bg-white">
            <div className="min-w-[1120px]">
              <div className="grid grid-cols-[236px_minmax(0,1fr)_156px] rounded-t-xl border-b border-[#D5D9D3] bg-[#F7F8F6]">
                <div className="flex items-center px-3.5 py-2.5 text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Auto</div>
                <div className="grid grid-cols-7 gap-x-1 px-2">
                  {view.days.map((d, i) => {
                    const isToday = d === view.today
                    return (
                      <div
                        key={d}
                        className={`my-1 flex items-baseline gap-1.5 rounded-md px-2 py-2 text-[13px] ${isToday ? 'bg-[#E3EAF6] font-bold text-[#1E4E9C]' : 'font-semibold text-[#545B63]'}`}
                      >
                        <span>{DAY_NAMES[i]}</span>
                        <span className="font-mono text-xs">{dm(d)}</span>
                        {isToday && <span className="text-[11px] uppercase tracking-wide">dziś</span>}
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center border-l border-[#E3E6E1] px-3.5 py-2.5 text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">
                  Tydzień
                </div>
              </div>

              {view.trucks.map(truck => (
                <TruckRow
                  key={truck.id}
                  truck={truck}
                  days={view.days}
                  showMoney={showMoney}
                  selected={selected}
                  tip={tip}
                  nowFraction={nowFraction}
                  copied={copied === truck.id}
                  onSelect={setSelected}
                  onTip={setTip}
                  onCopy={() => void copy(truck)}
                  onAddEvent={day => setEventTarget({ truck, day })}
                />
              ))}
            </div>
          </div>

          {selected && (
            <OrderPanel
              orderNo={selected}
              showMoney={showMoney}
              onClose={() => setSelected(null)}
              onChanged={() => void load()}
            />
          )}
        </section>
      )}

      {eventTarget && (
        <EventDialog
          truck={eventTarget.truck}
          day={eventTarget.day}
          onClose={() => setEventTarget(null)}
          onSaved={() => {
            setEventTarget(null)
            void load()
          }}
        />
      )}

      {view.lastImport && (
        <p className="px-6 pt-3 text-xs text-[#545B63]">
          Dane z importu {stamp(view.lastImport.importedAt)} ({view.lastImport.filename}).
          {k.kmEstimated && ' Kilometry oznaczone „≈” są szacunkowe — tablica uzupełni je z HERE w tle.'}
        </p>
      )}
    </div>
  )
}

function Legend({ color, label, dashed, border }: { color: string; label: string; dashed?: boolean; border?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-3 w-[18px] rounded-[3px]"
        style={{
          background: color,
          outline: dashed ? '2px dashed #1E4E9C' : undefined,
          outlineOffset: dashed ? -2 : undefined,
          boxShadow: border ? 'inset 0 0 0 1px #C9CEC6' : undefined,
        }}
      />
      {label}
    </span>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-[#D5D9D3] bg-white px-3.5 py-3">
      <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">{label}</span>
      <span className="font-mono text-[22px] font-semibold">{value}</span>
      <span className="text-xs text-[#545B63]">{sub}</span>
    </div>
  )
}

interface TruckRowProps {
  truck: WeekTruck
  days: string[]
  showMoney: boolean
  selected: string | null
  tip: string | null
  nowFraction: number | null
  copied: boolean
  onSelect: (orderNo: string) => void
  onTip: (key: string | null) => void
  onCopy: () => void
  onAddEvent: (day: string) => void
}

function TruckRow({ truck, days, showMoney, selected, tip, nowFraction, copied, onSelect, onTip, onCopy, onAddEvent }: TruckRowProps) {
  const bars = placeBars(truck.bars)
  const t = truck.totals
  return (
    <div className="grid grid-cols-[236px_minmax(0,1fr)_156px] border-b border-[#E3E6E1]">
      <div className="flex min-w-0 flex-col gap-1 border-r border-[#E3E6E1] px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-base font-semibold">{truck.plate}</span>
          <button
            type="button"
            onClick={onCopy}
            aria-label={`Kopiuj dane auta ${truck.plate}, naczepy i kierowcy`}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[#C9CEC6] bg-white px-2.5 text-xs font-semibold hover:bg-[#F7F8F6]"
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} />
            {copied ? 'Skopiowano' : 'Kopiuj'}
          </button>
        </div>
        <span className="truncate text-[13px] text-[#545B63]" title={truck.carrier}>
          {truck.carrier || 'przewoźnik — uzupełnij we Flocie'}
        </span>
        <span className="text-[13px]">
          {truck.driver || 'kierowca?'} {truck.phone && <span className="text-[#545B63]">· {truck.phone}</span>}
        </span>
        <span className="mt-0.5 self-start rounded bg-[#EEF0EC] px-1.5 py-0.5 text-xs">
          <span className="font-mono font-semibold">{truck.trailer ?? '—'}</span> · {truck.trailerTypePl}
        </span>
      </div>

      <div className="relative min-w-0 p-2">
        <div className="grid grid-cols-7 gap-x-1 gap-y-1.5" style={{ gridAutoRows: '50px' }}>
          {bars.map(b => {
            const isSel = selected === b.orderNo
            const c = barColors(b, isSel)
            const sub = [
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
                  aria-label={`${b.orderNo}, ${b.title}, ${dm(b.startDate)}–${dm(b.endDate)}`}
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
                    onMouseEnter={() => onTip(b.key)}
                    onMouseLeave={() => onTip(null)}
                    onFocus={() => onTip(b.key)}
                    onBlur={() => onTip(null)}
                    className="flex w-6 flex-none cursor-help items-start justify-center pt-[7px]"
                  >
                    <Icon name="note" size={14} />
                  </button>
                )}
                {tip === b.key && (
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
        <div className="mt-1.5 grid grid-cols-7 gap-1">
          {days.map(day => (
            <div key={day} className="flex min-w-0 flex-col items-start gap-1">
              {truck.events
                .filter(e => e.day === day)
                .map((e, i) => (
                  <span
                    key={`${e.id ?? 'auto'}-${i}`}
                    title={e.auto ? 'Wykryte automatycznie z naczep w zleceniach' : EVENT_LABELS[e.kind]}
                    className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] ${e.auto ? 'border-dashed border-[#9AA3AC] bg-[#F7F8F6]' : 'border-[#D5D9D3] bg-white'} text-[#3D444C]`}
                  >
                    <Icon name={EVENT_ICON[e.kind] ?? 'note'} size={12} />
                    <span className="truncate">{e.text}</span>
                  </span>
                ))}
              <button
                type="button"
                onClick={() => onAddEvent(day)}
                aria-label={`Dodaj zdarzenie: ${truck.plate}, ${dm(day)}`}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[#9AA3AC] hover:bg-[#EEF0EC] hover:text-[#15181C] focus:text-[#15181C]"
              >
                <Icon name="plus" size={13} />
              </button>
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

      <div className="flex flex-col gap-1.5 border-l border-[#E3E6E1] px-3.5 py-3 text-[13px]">
        {showMoney && (
          <>
            <Total label="Marża" value={signedEur(t.margin)} strong />
            <Total label="Przychód" value={eur(t.revenue)} />
          </>
        )}
        <Total label="Km razem" value={km(t.km, t.kmEstimated)} />
        <Total label="Na km · puste" value={`${t.km ? perKm(t.revenue / t.km) : '—'} · ${pct(t.kmEmpty, t.km)}`} small />
      </div>
    </div>
  )
}

function Total({ label, value, strong, small }: { label: string; value: string; strong?: boolean; small?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-[#545B63]">{label}</span>
      <span className={`font-mono ${strong ? 'text-[15px] font-semibold' : ''} ${small ? 'text-[12.5px]' : ''}`}>{value}</span>
    </div>
  )
}

const EVENT_KINDS: NoteKind[] = ['note', 'pause', 'service', 'driver', 'trailer', 'position']

function EventDialog({ truck, day, onClose, onSaved }: { truck: WeekTruck; day: string; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<NoteKind>('note')
  const [text, setText] = useState('')
  const [place, setPlace] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const needsPlace = kind === 'service' || kind === 'position'

  const save = async () => {
    setSaving(true)
    try {
      await boardApi.addEvent({
        truckId: truck.id,
        day,
        kind,
        text: text.trim() || EVENT_LABELS[kind] || 'Notatka',
        ...(place.trim() ? { place: place.trim() } : {}),
      })
      onSaved()
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się zapisać zdarzenia.'))
      setSaving(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="event-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="event-title" className="text-lg font-bold">
              Zdarzenie · {truck.plate}
            </h2>
            <p className="text-sm text-[#545B63]">{dm(day)} · widoczne tylko na tablicy</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#D5D9D3]">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1 font-semibold">
            Rodzaj
            <select value={kind} onChange={e => setKind(e.target.value as NoteKind)} className="h-11 rounded-lg border border-[#C9CEC6] px-2 font-normal">
              {EVENT_KINDS.map(k => (
                <option key={k} value={k}>
                  {EVENT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 font-semibold">
            Opis
            <input
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={kind === 'driver' ? 'np. wsiada Patryk' : kind === 'trailer' ? 'np. WAW: odstawił KNS463RP, wziął KNS897RP' : 'np. pauza 24h'}
              className="h-11 rounded-lg border border-[#C9CEC6] px-3 font-normal"
            />
          </label>
          <label className="flex flex-col gap-1 font-semibold">
            Miejsce {needsPlace ? '(od niego liczy się następny pusty dojazd)' : '(opcjonalnie)'}
            <input
              value={place}
              onChange={e => setPlace(e.target.value)}
              placeholder="np. Kraków albo KRK"
              className="h-11 rounded-lg border border-[#C9CEC6] px-3 font-normal"
            />
          </label>
          {error && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-800">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold">
              Anuluj
            </button>
            <button type="button" disabled={saving} onClick={() => void save()} className="h-11 rounded-lg bg-[#1E4E9C] px-4 font-semibold text-white disabled:opacity-60">
              Zapisz
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
