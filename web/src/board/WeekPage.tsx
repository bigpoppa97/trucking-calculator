import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { boardApi, errorMessage, type NoteKind, type Service, type WeekEvent, type WeekTruck, type WeekView } from './boardApi.js'
import { DAY_NAMES, EVENT_LABELS, addDaysIso, dm, eur, km, ordersLabel, ordersWithDrafts, pair, pct, perKm, signedEur, stamp, todayIso, weekRangeLabel } from './format.js'
import { Icon } from './Icon.js'
import { OrderPanel } from './OrderPanel.js'
import { RequiredBadges, SERVICE_COLORS, ServiceDialog } from './serviceUi.js'
import { DriverChangeDialog, DriverWarnings } from './driversUi.js'
import { COLOAD_COLORS, TruckTimeline, nowFractionFor } from './TruckTimeline.js'
import { DraftDialog } from './DraftDialog.js'

/**
 * Week view of the fleet board: trucks in rows, days in columns, orders as
 * bars from loading to unloading, services in a strip under them, events
 * under the bars, week totals per truck and for the department.
 */

export const MONEY_KEY = 'tablica.showMoney'

export function readShowMoney(): boolean {
  try {
    return localStorage.getItem(MONEY_KEY) !== '0'
  } catch {
    return true
  }
}

export function writeShowMoney(show: boolean): void {
  try {
    localStorage.setItem(MONEY_KEY, show ? '1' : '0')
  } catch {
    // per-viewer convenience only
  }
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
  onOpenTruck,
  onOpenDriver,
  onIssuesChanged,
}: {
  focus: WeekFocus | null
  initialDate?: string
  onReview: () => void
  onDateChange?: (date: string) => void
  /** Set page of a truck (double click on the truck cell or click on its plate). */
  onOpenTruck?: (truckId: number, date: string) => void
  /** Driver page with certificates. */
  onOpenDriver?: (driverId: number) => void
  /** A review item was settled (the counter in the menu). */
  onIssuesChanged?: () => void
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
  const [serviceTarget, setServiceTarget] = useState<{ truck: WeekTruck; service: Service } | null>(null)
  const [driverChange, setDriverChange] = useState<{ truck: WeekTruck; event: WeekEvent } | null>(null)
  const [eventEdit, setEventEdit] = useState<{ truck: WeekTruck; event: WeekEvent } | null>(null)
  const [trailerChange, setTrailerChange] = useState<{ truck: WeekTruck; event: WeekEvent } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

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
      writeShowMoney(!v)
      return !v
    })
  }

  const nowFraction = useMemo(() => (view ? nowFractionFor(view.days, view.today) : null), [view])

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
          <Legend color="#F4F6FA" label="Zlecenie wstępne" dashedGray />
          <Legend color={COLOAD_COLORS.bg} label="Doładunek" />
          <Legend color="#F4C77A" label="Do sprawdzenia" />
          <Legend color="#ECEEF0" label="Załadunek w poprzednim tygodniu" border />
          <Legend color={SERVICE_COLORS.light} label="Serwis" />
          <Legend color="#DCE5F2" label="Kolizja z serwisem" conflict />
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
            <Kpi label="Przychód" value={eur(k.revenue)} sub={ordersWithDrafts(k.orders, k.drafts)} />
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

      {notice && (
        <p role="status" className="mx-6 mb-3 flex items-center justify-between gap-3 rounded-lg bg-[#E3F1E6] px-4 py-2.5 text-sm text-[#14532D]">
          {notice}
          <button type="button" onClick={() => setNotice(null)} aria-label="Zamknij komunikat" className="flex h-8 w-8 items-center justify-center rounded-md">
            <Icon name="close" size={14} />
          </button>
        </p>
      )}
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
              <div className="grid grid-cols-[236px_minmax(0,1fr)_184px] rounded-t-xl border-b border-[#D5D9D3] bg-[#F7F8F6]">
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
                  weekStart={view.weekStart}
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
                  onOpenService={service => setServiceTarget({ truck, service })}
                  {...(onOpenTruck ? { onOpenTruck: () => onOpenTruck(truck.id, view.weekStart) } : {})}
                  {...(onOpenDriver ? { onOpenDriver } : {})}
                  onOpenDriverChange={event => setDriverChange({ truck, event })}
                  onOpenEvent={event => setEventEdit({ truck, event })}
                  onOpenTrailerChange={event => setTrailerChange({ truck, event })}
                />
              ))}
            </div>
          </div>

          {selected && (
            <OrderPanel
              orderNo={selected}
              showMoney={showMoney}
              onClose={() => setSelected(null)}
              onChanged={() => {
                void load()
                onIssuesChanged?.()
              }}
              onOpenOrder={setSelected}
            />
          )}
        </section>
      )}

      {eventTarget && (
        <EventDialog
          truck={eventTarget.truck}
          day={eventTarget.day}
          onClose={() => setEventTarget(null)}
          onSaved={message => {
            setEventTarget(null)
            setNotice(message ?? null)
            void load()
          }}
        />
      )}
      {eventEdit && (
        <EventEditDialog
          plate={eventEdit.truck.plate}
          event={eventEdit.event}
          onClose={() => setEventEdit(null)}
          onSaved={message => {
            setEventEdit(null)
            setNotice(message ?? null)
            void load()
          }}
        />
      )}
      {trailerChange && (
        <TrailerChangeDialog
          truckId={trailerChange.truck.id}
          plate={trailerChange.truck.plate}
          event={trailerChange.event}
          onClose={() => setTrailerChange(null)}
          onSaved={message => {
            setTrailerChange(null)
            setNotice(message ?? null)
            void load()
          }}
        />
      )}
      {driverChange && driverChange.event.driverChangeId !== undefined && (
        <DriverChangeDialog
          truck={driverChange.truck}
          day={driverChange.event.day}
          change={{ id: driverChange.event.driverChangeId, driverId: driverChange.event.driverId ?? null, time: driverChange.event.time ?? null }}
          onClose={() => setDriverChange(null)}
          onSaved={() => {
            setDriverChange(null)
            void load()
          }}
        />
      )}

      {serviceTarget && (
        <ServiceDialog
          truck={serviceTarget.truck}
          service={serviceTarget.service}
          onClose={() => setServiceTarget(null)}
          onSaved={() => {
            setServiceTarget(null)
            void load()
          }}
        />
      )}

      {view.lastImport && (
        <p className="px-6 pt-3 text-xs text-[#545B63]">
          Dane z importu {stamp(view.lastImport.importedAt)} ({view.lastImport.filename})
          {view.lastImport.supplement &&
            ` · uzupełnienie ${stamp(view.lastImport.supplement.importedAt)} (${ordersLabel(view.lastImport.supplement.orders)} z ${view.lastImport.supplement.filename})`}
          .
          {k.kmEstimated && ' Kilometry oznaczone „≈” są szacunkowe — tablica uzupełni je z HERE w tle.'}
        </p>
      )}
    </div>
  )
}

function Legend({
  color,
  label,
  dashed,
  dashedGray,
  border,
  conflict,
}: {
  color: string
  label: string
  dashed?: boolean
  dashedGray?: boolean
  border?: boolean
  conflict?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-3 w-[18px] rounded-[3px]"
        style={{
          background: color,
          outline: conflict ? `2px solid ${SERVICE_COLORS.conflict}` : dashed ? '2px dashed #1E4E9C' : dashedGray ? '2px dashed #7C8794' : undefined,
          outlineOffset: dashed || dashedGray || conflict ? -2 : undefined,
          boxShadow: border ? 'inset 0 0 0 1px #C9CEC6' : undefined,
        }}
      />
      {label}
    </span>
  )
}

export function Kpi({ label, value, second, sub }: { label: string; value: string; /** Paired value ("nasz / przewoźnika"), shown smaller after a slash. */ second?: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-[#D5D9D3] bg-white px-3.5 py-3">
      <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">{label}</span>
      <span className="font-mono text-[22px] font-semibold">
        {value}
        {second !== undefined && <span className="whitespace-nowrap text-[16px] font-medium text-[#545B63]"> / {second}</span>}
      </span>
      <span className="text-xs text-[#545B63]">{sub}</span>
    </div>
  )
}

interface TruckRowProps {
  truck: WeekTruck
  weekStart: string
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
  onOpenService: (s: Service) => void
  onOpenTruck?: () => void
  onOpenDriver?: (driverId: number) => void
  onOpenDriverChange: (e: WeekEvent) => void
  onOpenEvent: (e: WeekEvent) => void
  onOpenTrailerChange: (e: WeekEvent) => void
}

function TruckRow({
  truck,
  weekStart,
  days,
  showMoney,
  selected,
  tip,
  nowFraction,
  copied,
  onSelect,
  onTip,
  onCopy,
  onAddEvent,
  onOpenService,
  onOpenTruck,
  onOpenDriver,
  onOpenDriverChange,
  onOpenEvent,
  onOpenTrailerChange,
}: TruckRowProps) {
  const openDriver = onOpenDriver && truck.driverId !== null ? () => onOpenDriver(truck.driverId!) : undefined
  const t = truck.totals
  return (
    <div className="grid grid-cols-[236px_minmax(0,1fr)_184px] border-b border-[#E3E6E1]">
      <div
        className="flex min-w-0 flex-col gap-1 border-r border-[#E3E6E1] px-3.5 py-3"
        onDoubleClick={onOpenTruck}
        title={onOpenTruck ? 'Kliknij dwukrotnie, żeby otworzyć stronę zestawu' : undefined}
      >
        <div className="flex items-center justify-between gap-2">
          {onOpenTruck ? (
            <button
              type="button"
              onClick={onOpenTruck}
              aria-label={`Strona zestawu ${truck.plate}`}
              className="rounded font-mono text-base font-semibold text-[#1E4E9C] underline decoration-[#9AB3DA] underline-offset-[3px] hover:decoration-[#1E4E9C]"
            >
              {truck.plate}
            </button>
          ) : (
            <span className="font-mono text-base font-semibold">{truck.plate}</span>
          )}
          <button
            type="button"
            onClick={onCopy}
            onDoubleClick={e => e.stopPropagation()}
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
          {openDriver ? (
            <button
              type="button"
              onClick={openDriver}
              onDoubleClick={e => e.stopPropagation()}
              title="Certyfikaty kierowcy"
              className="text-left hover:underline"
            >
              {truck.driver}
            </button>
          ) : (
            truck.driver || <span className="text-[#8A939C]">bez kierowcy</span>
          )}{' '}
          {truck.phone && <span className="text-[#545B63]">· {truck.phone}</span>}
        </span>
        <DriverWarnings warnings={truck.driverWarnings} onOpen={openDriver} />
        <RequiredBadges services={truck.required.filter(s => s.target === 'truck')} onOpen={onOpenService} />
        <span className="mt-0.5 self-start rounded bg-[#EEF0EC] px-1.5 py-0.5 text-xs">
          <span className="font-mono font-semibold">{truck.trailer ?? '—'}</span> · {truck.trailerTypePl}
        </span>
        <RequiredBadges services={truck.required.filter(s => s.target === 'trailer')} onOpen={onOpenService} />
      </div>

      <TruckTimeline
        row={truck}
        weekStart={weekStart}
        days={days}
        showMoney={showMoney}
        selected={selected}
        tip={tip}
        nowFraction={nowFraction}
        onSelect={onSelect}
        onTip={onTip}
        onAddEvent={onAddEvent}
        onOpenService={onOpenService}
        onOpenDriverChange={onOpenDriverChange}
        onOpenEvent={onOpenEvent}
        onOpenTrailerChange={onOpenTrailerChange}
      />

      <div className="flex flex-col gap-1.5 border-l border-[#E3E6E1] px-3.5 py-3 text-[13px]">
        {showMoney && (
          <>
            <Total label="Marża" value={signedEur(t.margin)} strong />
            <Total label="Przychód" value={pair(eur(t.revenue), eur(t.carrier))} title="nasz / przewoźnika" />
            <Total label="EUR/KM" value={t.km ? pair(perKm(t.revenue / t.km), perKm(t.carrier / t.km)) : '—'} title="nasz / przewoźnika" />
          </>
        )}
        <Total label="Km razem" value={km(t.km, t.kmEstimated)} />
      </div>
    </div>
  )
}

export function Total({
  label,
  value,
  strong,
  small,
  title,
  className = '',
}: {
  label: string
  value: string
  strong?: boolean
  small?: boolean
  /** Hover hint (e.g. "nasz / przewoźnika" for paired values). */
  title?: string
  className?: string
}) {
  return (
    <div className={`flex flex-col ${className}`} title={title}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-[#545B63]">{label}</span>
      <span className={`whitespace-nowrap font-mono ${strong ? 'text-[15px] font-semibold' : ''} ${small ? 'text-[12.5px]' : ''}`}>{value}</span>
    </div>
  )
}

/** "+" under a day: board events, plus a preliminary order (zlecenie wstępne, 12.10.2026). */
type DialogKind = NoteKind | 'draft'
const EVENT_KINDS: DialogKind[] = ['note', 'draft', 'service', 'pause', 'driver', 'trailer', 'position']
const DIALOG_LABELS: Record<string, string> = { ...EVENT_LABELS, draft: 'Zlecenie wstępne' }

export function EventDialog({ truck, day, onClose, onSaved }: { truck: WeekTruck; day: string; onClose: () => void; onSaved: (message?: string) => void }) {
  const [kind, setKind] = useState<DialogKind>('note')
  const [text, setText] = useState('')
  const [place, setPlace] = useState('')
  const [time, setTime] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const needsPlace = kind === 'position'

  const save = async () => {
    if (kind === 'draft') return
    setSaving(true)
    try {
      await boardApi.addEvent({
        truckId: truck.id,
        day,
        kind,
        text: text.trim() || EVENT_LABELS[kind] || 'Notatka',
        ...(place.trim() ? { place: place.trim() } : {}),
        ...(time.trim() ? { time: time.trim() } : {}),
      })
      onSaved()
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się zapisać zdarzenia.'))
      setSaving(false)
    }
  }

  if (kind === 'service') {
    return <ServiceDialog truck={truck} day={day} candidates={truck.required} onClose={onClose} onSaved={() => onSaved()} />
  }
  if (kind === 'driver') {
    return <DriverChangeDialog truck={truck} day={day} onClose={onClose} onSaved={onSaved} />
  }
  if (kind === 'draft') {
    return <DraftDialog truck={truck} day={day} onClose={onClose} onSaved={onSaved} />
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
          <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-2">
            <label className="flex flex-col gap-1 font-semibold">
              Rodzaj
              <select value={kind} onChange={e => setKind(e.target.value as DialogKind)} className="h-11 rounded-lg border border-[#C9CEC6] px-2 font-normal">
                {EVENT_KINDS.map(k => (
                  <option key={k} value={k}>
                    {DIALOG_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 font-semibold">
              Godzina (opcjonalnie)
              <input type="time" value={time} onChange={e => setTime(e.target.value)} className="h-11 rounded-lg border border-[#C9CEC6] px-2 font-normal" />
            </label>
          </div>
          <label className="flex flex-col gap-1 font-semibold">
            Opis
            <input
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={kind === 'trailer' ? 'np. WAW: odstawił AB123CD, wziął AB456CD' : kind === 'position' ? 'np. stoi na bazie' : 'np. pauza 24h'}
              className="h-11 rounded-lg border border-[#C9CEC6] px-3 font-normal"
            />
          </label>
          <label className="flex flex-col gap-1 font-semibold">
            Miejsce {needsPlace ? '(od niego liczy się następny pusty dojazd)' : '(opcjonalnie, tylko informacja — km nie zmienia)'}
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

/** Kinds a board day event can be changed to (a service and a driver change have their own forms). */
const EDIT_KINDS: NoteKind[] = ['note', 'pause', 'trailer', 'position']

/** A day event on the board (note, pause, trailer, position): correct it or delete it (12.10.2026). */
export function EventEditDialog({ plate, event, onClose, onSaved }: { plate: string; event: WeekEvent; onClose: () => void; onSaved: (message?: string) => void }) {
  const [kind, setKind] = useState<NoteKind>(event.kind)
  const [day, setDay] = useState(event.day)
  const [text, setText] = useState(event.text)
  const [place, setPlace] = useState(event.place ?? '')
  const [time, setTime] = useState(event.time ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const kinds = EDIT_KINDS.includes(event.kind) ? EDIT_KINDS : [event.kind, ...EDIT_KINDS]
  const id = event.id

  const run = async (fn: () => Promise<unknown>, message: string) => {
    if (id === null) return
    setSaving(true)
    try {
      await fn()
      onSaved(message)
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się zapisać zdarzenia.'))
      setSaving(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="event-edit-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="event-edit-title" className="text-lg font-bold">
              {EVENT_LABELS[event.kind] ?? 'Zdarzenie'} · {plate}
            </h2>
            <p className="text-sm text-[#545B63]">
              {dm(event.day)}
              {event.time ? ` ${event.time}` : ''}
              {event.createdBy ? ` · dodał ${event.createdBy}` : ''}
              {event.createdAt ? `, ${stamp(event.createdAt)}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#D5D9D3]">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1 font-semibold">
            Rodzaj
            <select value={kind} onChange={e => setKind(e.target.value as NoteKind)} className="h-11 rounded-lg border border-[#C9CEC6] px-2 font-normal">
              {kinds.map(k => (
                <option key={k} value={k}>
                  {EVENT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-2">
            <label className="flex flex-col gap-1 font-semibold">
              Dzień
              <input type="date" value={day} onChange={e => setDay(e.target.value)} className="h-11 rounded-lg border border-[#C9CEC6] px-3 font-normal" />
            </label>
            <label className="flex flex-col gap-1 font-semibold">
              Godzina (opcjonalnie)
              <input type="time" value={time} onChange={e => setTime(e.target.value)} className="h-11 rounded-lg border border-[#C9CEC6] px-2 font-normal" />
            </label>
          </div>
          <label className="flex flex-col gap-1 font-semibold">
            Opis
            <input value={text} onChange={e => setText(e.target.value)} className="h-11 rounded-lg border border-[#C9CEC6] px-3 font-normal" />
          </label>
          <label className="flex flex-col gap-1 font-semibold">
            Miejsce {kind === 'position' ? '(od niego liczy się następny pusty dojazd)' : '(opcjonalnie, tylko informacja — km nie zmienia)'}
            <input value={place} onChange={e => setPlace(e.target.value)} placeholder="np. Kraków albo KRK; puste = bez miejsca" className="h-11 rounded-lg border border-[#C9CEC6] px-3 font-normal" />
          </label>
          {error && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-800">
              {error}
            </p>
          )}
          {confirmDelete ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="font-semibold">Usunąć to zdarzenie?</span>
              <button
                type="button"
                disabled={saving}
                onClick={() => void run(() => boardApi.deleteNote(id!), 'Usunięto zdarzenie.')}
                className="h-11 rounded-lg bg-[#B42318] px-4 font-semibold text-white disabled:opacity-60"
              >
                Usuń
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold">
                Anuluj
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap justify-between gap-2">
              <button type="button" onClick={() => setConfirmDelete(true)} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold text-[#B42318]">
                Usuń
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold">
                  Anuluj
                </button>
                <button
                  type="button"
                  disabled={saving || !text.trim()}
                  onClick={() =>
                    void run(
                      () =>
                        boardApi.updateEvent(id!, {
                          ...(kind !== event.kind ? { kind } : {}),
                          ...(day !== event.day ? { day } : {}),
                          ...(text.trim() !== event.text ? { text: text.trim() } : {}),
                          ...(place.trim() !== (event.place ?? '') ? { place: place.trim() } : {}),
                          ...(time.trim() !== (event.time ?? '') ? { time: time.trim() || null } : {}),
                        }),
                      'Zapisano zdarzenie.',
                    )
                  }
                  className="h-11 rounded-lg bg-[#1E4E9C] px-4 font-semibold text-white disabled:opacity-60"
                >
                  Zapisz
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Zmiana naczepy (28.10.2026): an automatic change (gray chip, from the trailers in the orders)
 * or a board entry typed over one. Day, hour and place can be corrected — from that moment the
 * truck has the new trailer (left column, "Kopiuj", trailer services); the place is information
 * only (no km). "Usuń — nie było zmiany" hides the change; "Przywróć automatyczną" drops the entry.
 */
export function TrailerChangeDialog({
  truckId,
  plate,
  event,
  onClose,
  onSaved,
}: {
  truckId: number
  plate: string
  event: WeekEvent
  onClose: () => void
  onSaved: (message?: string) => void
}) {
  const id = useId()
  const typed = event.id !== null && !event.auto
  const autoText = event.autoText ?? event.text
  // The automatic text starts with the place code ("BUD: TR100 → TR200"); the place has its own field.
  const bare = (t: string) => (event.auto && event.place && t.startsWith(`${event.place}: `) ? t.slice(event.place.length + 2) : t)
  const [day, setDay] = useState(event.day)
  const [time, setTime] = useState(event.time ?? '')
  const [place, setPlace] = useState(event.placeName ?? event.place ?? '')
  const [text, setText] = useState(bare(event.text))
  const [places, setPlaces] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<'dismiss' | 'restore' | null>(null)

  useEffect(() => {
    boardApi
      .places()
      .then(list => setPlaces(list.map(p => p.name)))
      .catch(() => setPlaces([]))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setSaving(true)
    setError(null)
    try {
      await fn()
      onSaved(message)
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się zapisać zmiany naczepy.'))
      setSaving(false)
    }
  }

  const save = () => {
    if (!day) return setError('Podaj dzień zmiany.')
    const hour = time.trim() || null
    const description = text.trim() || bare(autoText)
    void run(
      () =>
        typed
          ? boardApi.updateEvent(event.id!, { day, time: hour, text: description, place: place.trim() || null })
          : boardApi.addEvent({
              truckId,
              day,
              kind: 'trailer',
              text: description,
              ...(place.trim() ? { place: place.trim() } : {}),
              time: hour,
              autoKey: event.autoKey!,
            }),
      `Zapisano zmianę naczepy: ${dm(day)}${hour ? ` ${hour}` : ''}.`,
    )
  }

  const dismiss = () =>
    void run(
      () =>
        typed
          ? boardApi.updateEvent(event.id!, { suppress: true })
          : boardApi.addEvent({ truckId, day: event.day, kind: 'trailer', text: autoText, autoKey: event.autoKey!, suppress: true }),
      'Zmiana naczepy usunięta z tablicy — nie było jej.',
    )

  const field = 'h-11 rounded-lg border border-[#C9CEC6] px-3 font-normal'
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="max-h-[calc(100vh-32px)] w-full max-w-md overflow-y-auto rounded-xl bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id={`${id}-title`} className="text-lg font-bold">
              Zmiana naczepy · {plate}
            </h2>
            <p className="text-sm text-[#545B63]">
              {typed
                ? `Poprawiona na tablicy${event.createdBy ? ` (${event.createdBy}${event.createdAt ? `, ${stamp(event.createdAt)}` : ''})` : ''}. Automatycznie: ${event.autoDay ? dm(event.autoDay) : ''} · ${autoText}.`
                : `Wykryta automatycznie z naczep w zleceniach: ${dm(event.day)} · ${autoText}.`}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="flex h-11 w-11 flex-none items-center justify-center rounded-lg border border-[#D5D9D3]">
            <Icon name="close" size={18} />
          </button>
        </div>
        <datalist id={`${id}-places`}>
          {places.map(p => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <div className="flex flex-col gap-3 text-sm">
          <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-2">
            <label className="flex flex-col gap-1 font-semibold">
              Dzień
              <input type="date" value={day} onChange={e => setDay(e.target.value)} className={field} />
            </label>
            <label className="flex flex-col gap-1 font-semibold">
              Godzina (opcjonalnie)
              <input type="time" value={time} onChange={e => setTime(e.target.value)} className={`${field} px-2`} />
            </label>
          </div>
          <label className="flex flex-col gap-1 font-semibold">
            Miejsce (tylko informacja — km nie zmienia)
            <input value={place} onChange={e => setPlace(e.target.value)} list={`${id}-places`} placeholder="np. Warszawa albo WAW" className={field} />
          </label>
          <label className="flex flex-col gap-1 font-semibold">
            Opis
            <input value={text} onChange={e => setText(e.target.value)} className={field} />
          </label>
          <p className="text-xs text-[#545B63]">Od tego dnia{time.trim() ? ' i godziny' : ''} auto ma nową naczepę — w kolumnie po lewej, w „Kopiuj” i przy serwisach naczepy.</p>
          {error && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-800">
              {error}
            </p>
          )}
          {confirm ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="font-semibold">
                {confirm === 'dismiss' ? 'Usunąć zmianę naczepy z tablicy?' : 'Wrócić do zmiany wykrytej automatycznie?'}
              </span>
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  confirm === 'dismiss' ? dismiss() : void run(() => boardApi.deleteNote(event.id!), 'Przywrócono automatyczną zmianę naczepy.')
                }
                className="h-11 rounded-lg bg-[#B42318] px-4 font-semibold text-white disabled:opacity-60"
              >
                {confirm === 'dismiss' ? 'Usuń' : 'Przywróć'}
              </button>
              <button type="button" onClick={() => setConfirm(null)} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold">
                Anuluj
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <div className="mr-auto flex flex-wrap gap-2">
                <button type="button" onClick={() => setConfirm('dismiss')} className="h-11 rounded-lg border border-[#C9CEC6] px-3 font-semibold text-[#B42318]">
                  Usuń — nie było zmiany
                </button>
                {typed && (
                  <button type="button" onClick={() => setConfirm('restore')} className="h-11 rounded-lg border border-[#C9CEC6] px-3 font-semibold">
                    Przywróć automatyczną
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold">
                  Anuluj
                </button>
                <button type="button" disabled={saving} onClick={save} className="h-11 rounded-lg bg-[#1E4E9C] px-4 font-semibold text-white disabled:opacity-60">
                  Zapisz
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
