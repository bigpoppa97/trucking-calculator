import { useCallback, useEffect, useMemo, useState } from 'react'
import { boardApi, errorMessage, type Service, type TruckView, type WeekTruck } from './boardApi.js'
import { DAY_NAMES, addDaysIso, dm, eur, km, pct, perKm, signedEur, stamp, todayIso, weekRangeLabel } from './format.js'
import { Icon } from './Icon.js'
import { OrderPanel } from './OrderPanel.js'
import { PHASE_LABELS, RequiredBadges, SERVICE_COLORS, ServiceDialog, defaultServiceDay, serviceTitle } from './serviceUi.js'
import { TruckTimeline, nowFractionFor } from './TruckTimeline.js'
import { EventDialog, Kpi, Total, readShowMoney, writeShowMoney } from './WeekPage.js'

/**
 * Strona zestawu: one tractor over a week or a month — header (plates, carrier,
 * driver, trailer, active order), totals for the period, week rows like on the
 * board, and tabs with services and orders.
 */

export type TruckMode = 'week' | 'month'

/** The set page has its own address, so "Back" returns to the board and a refresh stays on the page. */
export interface TruckRoute {
  id: number
  date: string
  mode: TruckMode
}

/** "#/auto/12?d=2026-10-05&widok=miesiac" → route; anything else → null. */
export function parseTruckHash(hash: string): TruckRoute | null {
  const m = /^#\/auto\/(\d+)(?:\?(.*))?$/.exec(hash)
  if (!m) return null
  const params = new URLSearchParams(m[2] ?? '')
  const d = params.get('d') ?? ''
  return { id: Number(m[1]), date: /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayIso(), mode: params.get('widok') === 'miesiac' ? 'month' : 'week' }
}

export function truckHash(r: TruckRoute): string {
  return `#/auto/${r.id}?d=${r.date}${r.mode === 'month' ? '&widok=miesiac' : ''}`
}

const MONTHS_NOM = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień']

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

function monthEnd(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  const last = new Date(Date.UTC(y ?? 2000, m ?? 1, 0)).getUTCDate()
  return `${iso.slice(0, 7)}-${String(last).padStart(2, '0')}`
}

function shiftMonth(iso: string, by: number): string {
  const [y, m] = iso.split('-').map(Number)
  const d = new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1 + by, 1))
  return d.toISOString().slice(0, 10)
}

/** The days the page asks for: the week of `date`, or its calendar month (the server widens to whole weeks). */
export function truckPeriod(date: string, mode: TruckMode): { from: string; to: string } {
  return mode === 'month' ? { from: monthStart(date), to: monthEnd(date) } : { from: date, to: date }
}

function fmtDay(iso: string | null): string {
  return iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : ''
}

type Tab = 'services' | 'orders'

export function TruckPage({
  truckId,
  date,
  mode,
  onNavigate,
  onBack,
  backLabel = 'Tablica',
  onShowOnBoard,
}: {
  truckId: number
  date: string
  mode: TruckMode
  onNavigate: (date: string, mode: TruckMode) => void
  onBack: () => void
  backLabel?: string
  /** Opens an order on the board week view. */
  onShowOnBoard?: (orderNo: string) => void
}) {
  const [view, setView] = useState<TruckView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showMoney, setShowMoney] = useState(readShowMoney)
  const [selected, setSelected] = useState<string | null>(null)
  const [tip, setTip] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('services')
  const [serviceForm, setServiceForm] = useState<{ service?: Service; day?: string } | null>(null)
  const [eventTarget, setEventTarget] = useState<{ row: WeekTruck; day: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const period = truckPeriod(date, mode)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      setView(await boardApi.truckView(truckId, period.from, period.to))
      setError(null)
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się wczytać zestawu.'))
    } finally {
      setLoading(false)
    }
  }, [truckId, period.from, period.to])

  useEffect(() => {
    void load()
  }, [load])

  const toggleMoney = () => {
    setShowMoney(v => {
      writeShowMoney(!v)
      return !v
    })
  }

  const step = (dir: -1 | 1) => onNavigate(mode === 'month' ? shiftMonth(date, dir) : addDaysIso(date, 7 * dir), mode)

  const copy = async () => {
    if (!view) return
    try {
      await navigator.clipboard.writeText(view.truck.copyText)
    } catch {
      // clipboard unavailable
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2500)
  }

  const groups = useMemo(() => {
    const list = view?.services ?? []
    return {
      required: list.filter(s => s.phase === 'required'),
      planned: list.filter(s => s.phase === 'upcoming' || s.phase === 'ongoing'),
      past: list.filter(s => s.phase === 'done' || s.phase === 'cancelled'),
    }
  }, [view])

  if (!view && loading) return <p className="p-6 text-sm text-[#545B63]">Wczytywanie zestawu…</p>
  if (!view) {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <BackButton label={backLabel} onBack={onBack} />
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      </div>
    )
  }

  const t = view.truck
  const tot = view.totals
  const periodLabel =
    mode === 'month'
      ? `${MONTHS_NOM[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`
      : `Tydzień ${view.weeks[0]?.weekNumber ?? ''} · ${weekRangeLabel(view.from, view.to)}`
  const olderPlates = [...t.plates].filter(p => p.validTo).sort((a, b) => b.validFrom.localeCompare(a.validFrom))
  const truckForForms = { id: t.id, plate: t.plate, trailer: t.trailer }

  return (
    <div className="pb-10">
      <section className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 pt-5 pb-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <BackButton label={backLabel} onBack={onBack} />
          <button
            type="button"
            aria-label={mode === 'month' ? 'Poprzedni miesiąc' : 'Poprzedni tydzień'}
            onClick={() => step(-1)}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#C9CEC6] bg-white hover:bg-[#F7F8F6]"
          >
            <Icon name="left" size={18} />
          </button>
          <div className="flex flex-col px-1">
            <h1 className="text-[22px] font-bold leading-tight">
              <span className="font-mono">{t.plate}</span>
            </h1>
            <span className="text-[13px] text-[#545B63]">{periodLabel}</span>
          </div>
          <button
            type="button"
            aria-label={mode === 'month' ? 'Następny miesiąc' : 'Następny tydzień'}
            onClick={() => step(1)}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#C9CEC6] bg-white hover:bg-[#F7F8F6]"
          >
            <Icon name="right" size={18} />
          </button>
          <button type="button" onClick={() => onNavigate(todayIso(), mode)} className="h-11 rounded-lg border border-[#C9CEC6] bg-white px-3.5 font-semibold hover:bg-[#F7F8F6]">
            Dziś
          </button>
          <div role="radiogroup" aria-label="Okres" className="flex gap-1 rounded-lg bg-[#E2E5DF] p-1">
            {(['week', 'month'] as const).map(m => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => onNavigate(date, m)}
                className={`h-9 rounded-md px-3 text-sm font-semibold ${mode === m ? 'bg-white text-[#15181C] shadow-sm' : 'text-[#545B63] hover:text-[#15181C]'}`}
              >
                {m === 'week' ? 'Tydzień' : 'Miesiąc'}
              </button>
            ))}
          </div>
          {loading && <span className="text-xs text-[#545B63]">odświeżanie…</span>}
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 pl-1.5 text-[13.5px] font-semibold text-[#15181C]">
          <input type="checkbox" checked={showMoney} onChange={toggleMoney} className="h-[18px] w-[18px] accent-[#1E4E9C]" />
          Pokaż kwoty
        </label>
      </section>

      {error && (
        <p role="alert" className="mx-6 mb-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      )}

      <section aria-label="Zestaw" className="mx-6 mb-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3 rounded-xl border border-[#D5D9D3] bg-white px-5 py-4">
          <div className="flex min-w-[180px] flex-col gap-1">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Ciągnik</span>
            <span className="font-mono text-lg font-semibold">{t.plate}</span>
            {olderPlates.length > 0 && (
              <details className="text-xs text-[#545B63]">
                <summary className="cursor-pointer">Historia numerów ({olderPlates.length})</summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {olderPlates.map(p => (
                    <li key={`${p.plate}-${p.validFrom}`}>
                      <span className="font-mono">{p.plate}</span> do {fmtDay(p.validTo)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {!t.active && <span className="self-start rounded bg-[#ECEEEA] px-2 py-0.5 text-xs font-semibold text-[#545B63]">ukryty na tablicy</span>}
            <RequiredBadges services={t.required.filter(s => s.target === 'truck')} onOpen={s => setServiceForm({ service: s })} />
          </div>
          <div className="flex min-w-[200px] flex-col gap-1 text-[13.5px]">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Przewoźnik i kierowca</span>
            <span>{t.carrier || <span className="text-[#8A939C]">przewoźnik — uzupełnij we Flocie</span>}</span>
            <span>
              {t.driver || 'kierowca?'} {t.phone && <span className="text-[#545B63]">· {t.phone}</span>}
            </span>
          </div>
          <div className="flex min-w-[180px] flex-col items-start gap-1 text-[13.5px]">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Naczepa</span>
            <span className="rounded bg-[#EEF0EC] px-1.5 py-0.5 text-xs">
              <span className="font-mono font-semibold">{t.trailer ?? '—'}</span> · {t.trailerTypePl}
            </span>
            <RequiredBadges services={t.required.filter(s => s.target === 'trailer')} onOpen={s => setServiceForm({ service: s })} />
          </div>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={`Kopiuj dane auta ${t.plate}, naczepy i kierowcy`}
            className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[#C9CEC6] bg-white px-3 text-xs font-semibold hover:bg-[#F7F8F6]"
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} />
            {copied ? 'Skopiowano' : 'Kopiuj'}
          </button>
        </div>
        <div className={`flex flex-col gap-1.5 rounded-xl border px-5 py-4 ${view.activeOrder && !view.activeOrder.upcoming ? 'border-[#9AB3DA] bg-[#EEF3FB]' : 'border-[#D5D9D3] bg-white'}`}>
          <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">
            {view.activeOrder ? (view.activeOrder.upcoming ? 'Następne zlecenie' : 'Aktywne zlecenie') : 'Aktywne zlecenie'}
          </span>
          {view.activeOrder ? (
            <>
              <button
                type="button"
                onClick={() => setSelected(view.activeOrder!.orderNo)}
                className="self-start text-left font-mono text-base font-semibold text-[#1E4E9C] underline decoration-[#9AB3DA] underline-offset-[3px]"
              >
                {view.activeOrder.orderNo}
              </button>
              <span className="text-[13.5px]">{view.activeOrder.title}</span>
              <span className="font-mono text-xs text-[#545B63]">
                {dm(view.activeOrder.startDate)} → {dm(view.activeOrder.endDate)}
              </span>
              {onShowOnBoard && (
                <button type="button" onClick={() => onShowOnBoard(view.activeOrder!.orderNo)} className="self-start text-xs font-semibold text-[#1E4E9C] underline">
                  pokaż na tablicy
                </button>
              )}
            </>
          ) : (
            <span className="text-[13.5px] text-[#545B63]">Brak zlecenia w toku ani w najbliższych 2 tygodniach.</span>
          )}
        </div>
      </section>

      <section aria-label="Wynik okresu" className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5 px-6 pb-4">
        {showMoney && (
          <>
            <Kpi label="Marża" value={eur(tot.margin)} sub={`${pct(tot.margin, tot.revenue)} przychodu`} />
            <Kpi label="Przychód" value={eur(tot.revenue)} sub={`${tot.legs} zleceń · ${dm(view.from)}–${dm(view.to)}`} />
          </>
        )}
        <Kpi label="Km razem" value={km(tot.km, tot.kmEstimated).replace(' km', '')} sub={`w tym puste ${pct(tot.kmEmpty, tot.km)}`} />
        {showMoney && <Kpi label="Przychód na km" value={perKm(tot.km ? tot.revenue / tot.km : null)} sub="przychód / km razem" />}
        <Kpi label="Serwisy" value={String(tot.services)} sub={`w okresie · wymagane: ${t.required.length}`} />
      </section>

      <section aria-label="Kalendarz" className="relative px-6">
        <div className="overflow-x-auto rounded-xl border border-[#D5D9D3] bg-white">
          <div className="min-w-[1040px]">
            {view.weeks.map((w, wi) => (
              <div key={w.weekStart} className={wi > 0 ? 'border-t-2 border-[#D5D9D3]' : ''}>
                <div className={`grid grid-cols-[150px_minmax(0,1fr)_210px] border-b border-[#D5D9D3] bg-[#F7F8F6] ${wi === 0 ? 'rounded-t-xl' : ''}`}>
                  <div className="flex items-center px-3.5 py-2 text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Tydzień {w.weekNumber}</div>
                  <div className="grid grid-cols-7 gap-x-1 px-2">
                    {w.days.map((d, i) => {
                      const isToday = d === view.today
                      const outside = mode === 'month' && d.slice(0, 7) !== date.slice(0, 7)
                      return (
                        <div
                          key={d}
                          className={`my-1 flex items-baseline gap-1.5 rounded-md px-2 py-1.5 text-[13px] ${isToday ? 'bg-[#E3EAF6] font-bold text-[#1E4E9C]' : outside ? 'font-semibold text-[#A3AAB1]' : 'font-semibold text-[#545B63]'}`}
                        >
                          <span>{DAY_NAMES[i]}</span>
                          <span className="font-mono text-xs">{dm(d)}</span>
                          {isToday && <span className="text-[11px] uppercase tracking-wide">dziś</span>}
                        </div>
                      )
                    })}
                  </div>
                  <div className="flex items-center border-l border-[#E3E6E1] px-3.5 py-2 text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Tydzień</div>
                </div>
                <div className="grid grid-cols-[150px_minmax(0,1fr)_210px]">
                  <div className="flex min-w-0 flex-col gap-1 border-r border-[#E3E6E1] px-3.5 py-3 text-xs text-[#545B63]">
                    <span>{weekRangeLabel(w.weekStart, w.weekEnd)}</span>
                    <span>
                      naczepa <span className="font-mono font-semibold text-[#15181C]">{w.row.trailer ?? '—'}</span>
                    </span>
                  </div>
                  <TruckTimeline
                    row={w.row}
                    weekStart={w.weekStart}
                    days={w.days}
                    showMoney={showMoney}
                    selected={selected}
                    tip={tip}
                    nowFraction={nowFractionFor(w.days, view.today)}
                    onSelect={setSelected}
                    onTip={setTip}
                    onAddEvent={day => setEventTarget({ row: w.row, day })}
                    onOpenService={s => setServiceForm({ service: s })}
                  />
                  <div className="grid grid-cols-2 content-start gap-x-3 gap-y-1.5 border-l border-[#E3E6E1] px-3.5 py-3 text-[13px]">
                    {showMoney && (
                      <>
                        <Total label="Marża" value={signedEur(w.row.totals.margin)} strong />
                        <Total label="Przychód" value={eur(w.row.totals.revenue)} />
                      </>
                    )}
                    <Total label="Km razem" value={km(w.row.totals.km, w.row.totals.kmEstimated)} />
                    <Total label="Puste km" value={pct(w.row.totals.kmEmpty, w.row.totals.km)} />
                    {showMoney && <Total label="Na km" value={w.row.totals.km ? perKm(w.row.totals.revenue / w.row.totals.km) : '—'} />}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        {selected && <OrderPanel orderNo={selected} showMoney={showMoney} onClose={() => setSelected(null)} onChanged={() => void load()} />}
      </section>

      <section className="mx-6 mt-5 rounded-xl border border-[#D5D9D3] bg-white">
        <div role="tablist" aria-label="Szczegóły zestawu" className="flex gap-1 border-b border-[#D5D9D3] px-3 pt-2">
          {(
            [
              ['services', `Serwis (${view.services.filter(s => s.phase !== 'cancelled').length})`],
              ['orders', `Zlecenia (${view.orders.length})`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              onClick={() => setTab(id)}
              className={`relative h-11 px-3.5 text-sm font-semibold ${tab === id ? 'text-[#15181C] after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:rounded-t after:bg-[#1E4E9C]' : 'text-[#545B63] hover:text-[#15181C]'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'services' && (
          <div role="tabpanel" id="panel-services" aria-labelledby="tab-services" className="flex flex-col gap-4 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] text-[#545B63]">Serwisy ciągnika i jego naczepy. Wymagane czekają na termin — kliknij, żeby zaplanować.</p>
              <button
                type="button"
                onClick={() => setServiceForm({ day: defaultServiceDay(view.from, view.to) })}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-[#1E4E9C] px-4 text-sm font-semibold text-white"
              >
                <Icon name="plus" size={15} /> Dodaj serwis
              </button>
            </div>
            {view.services.length === 0 && <p className="rounded-lg bg-[#F6F7F4] px-4 py-4 text-sm text-[#545B63]">Brak serwisów. Dodaj pierwszy, gdy przewoźnik zgłosi zjazd.</p>}
            <ServiceGroup title="Wymagane" services={groups.required} onOpen={s => setServiceForm({ service: s })} />
            <ServiceGroup title="Zaplanowane i w trakcie" services={groups.planned} onOpen={s => setServiceForm({ service: s })} />
            <ServiceGroup title="Historia" services={groups.past} onOpen={s => setServiceForm({ service: s })} />
          </div>
        )}

        {tab === 'orders' && (
          <div role="tabpanel" id="panel-orders" aria-labelledby="tab-orders" className="overflow-x-auto px-5 py-4">
            {view.orders.length === 0 ? (
              <p className="rounded-lg bg-[#F6F7F4] px-4 py-4 text-sm text-[#545B63]">Brak zleceń z załadunkiem w tym okresie.</p>
            ) : (
              <table className="w-full min-w-[820px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[#D5D9D3] text-left text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">
                    <th className="px-2 py-2">Zlecenie</th>
                    <th className="px-2 py-2">Trasa</th>
                    <th className="px-2 py-2">Załadunek</th>
                    <th className="px-2 py-2">Rozładunek</th>
                    {showMoney && (
                      <>
                        <th className="px-2 py-2 text-right">Przychód</th>
                        <th className="px-2 py-2 text-right">Koszt</th>
                        <th className="px-2 py-2 text-right">Marża</th>
                      </>
                    )}
                    <th className="px-2 py-2 text-right">Km</th>
                    {showMoney && <th className="px-2 py-2 text-right">€/km</th>}
                  </tr>
                </thead>
                <tbody>
                  {view.orders.map(o => {
                    const off = Boolean(o.excluded || o.noCarrier)
                    const status = o.excluded === 'cancelled' ? 'anulowane' : o.excluded === 'unconfirmed' ? 'niezatwierdzone' : o.excluded === 'manual' ? 'wyłączone' : o.noCarrier ? 'brak przewoźnika' : o.missing ? 'zniknęło' : null
                    return (
                      <tr key={`${o.orderNo}|${o.legIndex}`} className={`border-b border-[#ECEEEA] ${off ? 'text-[#8A939C]' : ''}`}>
                        <td className="px-2 py-2">
                          <button type="button" onClick={() => setSelected(o.orderNo)} className="font-mono font-semibold text-[#1E4E9C] underline decoration-[#9AB3DA] underline-offset-[3px]">
                            {o.orderNo}
                          </button>
                          {o.legCount > 1 && <span className="ml-1 text-xs text-[#545B63]">odc. {o.legIndex + 1}/{o.legCount}</span>}
                          {o.prz && <span className="ml-1 text-xs font-semibold text-[#1E4E9C]">PRZ</span>}
                          {status && <span className="ml-1 text-xs">({status})</span>}
                        </td>
                        <td className={`px-2 py-2 ${o.excluded === 'cancelled' ? 'line-through' : ''}`}>{o.title}</td>
                        <td className="px-2 py-2 font-mono">{dm(o.startDate)}</td>
                        <td className="px-2 py-2 font-mono">{dm(o.endDate)}</td>
                        {showMoney && (
                          <>
                            <td className="px-2 py-2 text-right font-mono">{eur(o.revAlloc)}</td>
                            <td className="px-2 py-2 text-right font-mono">{eur(o.amount)}</td>
                            <td className="px-2 py-2 text-right font-mono">{signedEur(o.margin)}</td>
                          </>
                        )}
                        <td className="px-2 py-2 text-right font-mono">{km(o.km, o.kmEstimated)}</td>
                        {showMoney && <td className="px-2 py-2 text-right font-mono">{o.km && o.revAlloc !== null ? perKm(o.revAlloc / o.km) : '—'}</td>}
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td className="px-2 py-2" colSpan={4}>
                      Razem (bez anulowanych i wyłączonych)
                    </td>
                    {showMoney && (
                      <>
                        <td className="px-2 py-2 text-right font-mono">{eur(tot.revenue)}</td>
                        <td className="px-2 py-2 text-right font-mono">{eur(tot.cost)}</td>
                        <td className="px-2 py-2 text-right font-mono">{signedEur(tot.margin)}</td>
                      </>
                    )}
                    <td className="px-2 py-2 text-right font-mono">{km(tot.km, tot.kmEstimated)}</td>
                    {showMoney && <td className="px-2 py-2 text-right font-mono">{tot.km ? perKm(tot.revenue / tot.km) : '—'}</td>}
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        )}
      </section>

      {serviceForm && (
        <ServiceDialog
          truck={truckForForms}
          service={serviceForm.service ?? null}
          {...(serviceForm.day ? { day: serviceForm.day } : {})}
          candidates={t.required}
          onClose={() => setServiceForm(null)}
          onSaved={() => {
            setServiceForm(null)
            void load()
          }}
        />
      )}
      {eventTarget && (
        <EventDialog
          truck={{ ...eventTarget.row, required: t.required }}
          day={eventTarget.day}
          onClose={() => setEventTarget(null)}
          onSaved={() => {
            setEventTarget(null)
            void load()
          }}
        />
      )}
    </div>
  )
}

function BackButton({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-[#C9CEC6] bg-white px-3.5 font-semibold hover:bg-[#F7F8F6]">
      <Icon name="left" size={16} /> {label}
    </button>
  )
}

function ServiceGroup({ title, services, onOpen }: { title: string; services: Service[]; onOpen: (s: Service) => void }) {
  if (services.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[#545B63]">
        {title} ({services.length})
      </h3>
      <ul className="flex flex-col">
        {services.map(s => {
          const cancelled = s.phase === 'cancelled'
          return (
            <li key={s.id} className="border-t border-[#ECEEEA] first:border-t-0">
              <button type="button" onClick={() => onOpen(s)} title={serviceTitle(s)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2.5 text-left text-sm hover:bg-[#F7F8F6]">
                <span
                  className="w-24 flex-none rounded px-2 py-0.5 text-center text-xs font-semibold"
                  style={
                    s.phase === 'ongoing'
                      ? { background: SERVICE_COLORS.full, color: SERVICE_COLORS.fullFg }
                      : s.phase === 'cancelled' || s.phase === 'done'
                        ? { background: '#ECEEEA', color: '#545B63' }
                        : { background: SERVICE_COLORS.light, color: SERVICE_COLORS.lightFg }
                  }
                >
                  {PHASE_LABELS[s.phase]}
                </span>
                <span className={`w-48 flex-none font-mono text-[13px] ${cancelled ? 'line-through' : ''}`}>{s.when || `zgłoszony ${dm(s.reportedAt.slice(0, 10))}`}</span>
                <span className="w-32 flex-none text-[13px] text-[#545B63]">{s.target === 'trailer' ? `naczepa ${s.trailerPlate}` : 'ciągnik'}</span>
                <span className={`min-w-0 flex-1 ${cancelled ? 'line-through' : ''}`}>
                  {s.description || 'Serwis'}
                  {s.place && <span className="text-[#545B63]"> · {s.place}</span>}
                </span>
                <span className="text-xs text-[#545B63]">
                  {s.updatedBy}, {stamp(s.updatedAt)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
