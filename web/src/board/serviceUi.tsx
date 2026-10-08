import { useEffect, useId, useState } from 'react'
import { boardApi, errorMessage, type Service, type ServiceTarget } from './boardApi.js'
import { dm, stamp, todayIso } from './format.js'
import { Icon } from './Icon.js'

/**
 * Serwis — UI pieces shared by the board and the set page: the service strip
 * under the order bars, "required" badges and the service form.
 *
 * Teal is the service colour (amber already means "Do sprawdzenia" on the board).
 */

export const SERVICE_COLORS = {
  light: '#D5EEE9', // with hours — the truck keeps driving that day
  lightFg: '#0E4A41',
  full: '#2E8576', // all day — unavailable
  fullFg: '#FFFFFF',
  border: '#2E8576',
  conflict: '#B42318',
}

export const PHASE_LABELS: Record<Service['phase'], string> = {
  required: 'wymagany',
  upcoming: 'zaplanowany',
  ongoing: 'trwa',
  done: 'zakończony',
  cancelled: 'odwołany',
}

const minutes = (hhmm: string | null) => {
  if (!hhmm) return 0
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

const dayIndex = (iso: string, weekStart: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${weekStart}T00:00:00Z`)) / 86400000)

/** "10:00" → "10", "10:30" → "10:30" (strip labels are short). */
function hour(hhmm: string | null): string {
  if (!hhmm) return ''
  return hhmm.endsWith(':00') ? String(Number(hhmm.slice(0, 2))) : hhmm.replace(/^0/, '')
}

const WEEKDAY = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So']
const weekday = (iso: string) => WEEKDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? ''

/** Short text inside a strip block: "10–13 · Kraków · olej", "So 14 → Nd 9 · agregat", "cały dzień · Kalisz". */
export function serviceShortLabel(s: Service): string {
  let time = ''
  if (s.allDay) time = s.startDay === s.endDay ? 'cały dzień' : 'całe dni'
  else if (s.startDay === s.endDay) time = `${hour(s.startTime)}–${hour(s.endTime)}`
  else time = `${s.startDay ? weekday(s.startDay) : ''} ${hour(s.startTime)} → ${s.endDay ? weekday(s.endDay) : ''} ${hour(s.endTime)}`
  return [s.target === 'trailer' ? s.trailerPlate : null, time, s.place || null, s.description || null].filter(Boolean).join(' · ')
}

/** Full description for tooltips and lists. */
export function serviceTitle(s: Service): string {
  const what = s.target === 'trailer' ? `Serwis naczepy ${s.trailerPlate}` : 'Serwis ciągnika'
  const parts = [what, s.when || `wymagany, zgłoszony ${dm(s.reportedAt.slice(0, 10))}`, s.place, s.description].filter(Boolean)
  return parts.join(' · ')
}

interface PlacedService {
  s: Service
  start: number
  end: number
  lane: number
}

/** Position (in days from Monday, 0–7) of each planned service, stacked into lanes when they overlap. */
export function placeServices(services: Service[], weekStart: string): PlacedService[] {
  const laneEnds: number[] = []
  const placed: PlacedService[] = []
  const items = services
    .filter(s => s.startDay && s.endDay)
    .map(s => {
      const start = dayIndex(s.startDay!, weekStart) + (s.allDay ? 0 : minutes(s.startTime) / 1440)
      const end = s.allDay ? dayIndex(s.endDay!, weekStart) + 1 : dayIndex(s.endDay!, weekStart) + minutes(s.endTime) / 1440
      return { s, start: Math.max(0, Math.min(7, start)), end: Math.max(0, Math.min(7, end)) }
    })
    .filter(x => x.end > x.start || x.end > 0)
    .sort((a, b) => a.start - b.start)
  for (const it of items) {
    const visualEnd = Math.max(it.end, it.start + 0.7) // blocks have a minimum width
    let lane = laneEnds.findIndex(e => e <= it.start)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(visualEnd)
    } else laneEnds[lane] = visualEnd
    placed.push({ ...it, lane })
  }
  return placed
}

/** x (days, 0–7) → CSS offset in a 7-column grid with 4px gaps. */
function xCss(x: number): string {
  const gaps = Math.min(6, Math.max(0, Math.floor(x - 1e-6)))
  return `calc((100% - 24px) * ${(x / 7).toFixed(5)} + ${gaps * 4}px)`
}

export function ServiceStrip({ services, weekStart, onOpen }: { services: Service[]; weekStart: string; onOpen: (s: Service) => void }) {
  const placed = placeServices(services, weekStart)
  if (placed.length === 0) return null
  const lanes = Math.max(...placed.map(p => p.lane)) + 1
  return (
    <div className="relative mt-1.5" style={{ height: lanes * 24 }} aria-label="Serwisy">
      {placed.map(({ s, start, end, lane }) => {
        const full = s.allDay
        const trailer = s.target === 'trailer'
        const anchorRight = start > 6.2
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onOpen(s)}
            title={serviceTitle(s)}
            aria-label={serviceTitle(s)}
            className="absolute flex items-center gap-1 overflow-hidden whitespace-nowrap rounded-[5px] px-1.5 text-left text-[11.5px] font-semibold hover:brightness-95"
            style={{
              top: lane * 24 + 2,
              height: 20,
              ...(anchorRight ? { right: `calc(100% - ${xCss(end)})` } : { left: xCss(start) }),
              width: `calc(${xCss(end)} - ${xCss(start)})`,
              minWidth: '5.75rem',
              background: trailer ? '#FFFFFF' : full ? SERVICE_COLORS.full : SERVICE_COLORS.light,
              color: trailer ? SERVICE_COLORS.lightFg : full ? SERVICE_COLORS.fullFg : SERVICE_COLORS.lightFg,
              border: trailer ? `1.5px dashed ${SERVICE_COLORS.border}` : 'none',
              opacity: s.phase === 'done' ? 0.75 : 1,
            }}
          >
            <Icon name="service" size={11} />
            <span className="truncate">{serviceShortLabel(s)}</span>
          </button>
        )
      })}
    </div>
  )
}

/** "Serwis wymagany: olej · od 06.10" — clicking opens the service (Zaplanuj / Odwołaj …). */
export function RequiredBadges({ services, onOpen }: { services: Service[]; onOpen: (s: Service) => void }) {
  if (services.length === 0) return null
  return (
    <span className="flex flex-col items-start gap-1">
      {services.map(s => (
        <button
          key={s.id}
          type="button"
          onClick={e => {
            e.stopPropagation()
            onOpen(s)
          }}
          onDoubleClick={e => e.stopPropagation()}
          title={`${serviceTitle(s)} — kliknij, żeby zaplanować`}
          className="inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[11.5px] font-semibold"
          style={
            s.target === 'trailer'
              ? { border: `1.5px dashed ${SERVICE_COLORS.border}`, color: SERVICE_COLORS.lightFg, background: '#FFFFFF' }
              : { background: SERVICE_COLORS.light, color: SERVICE_COLORS.lightFg }
          }
        >
          <Icon name="service" size={11} />
          <span className="truncate">
            {s.target === 'trailer' ? 'naczepa' : 'serwis'}: {s.description || 'wymagany'} · od {dm(s.reportedAt.slice(0, 10))}
          </span>
        </button>
      ))}
    </span>
  )
}

// ---------------------------------------------------------------- form

export interface ServiceDialogTruck {
  id: number
  plate: string
  trailer: string | null
}

type Mode = 'planned' | 'required'

const FIELD = 'h-11 rounded-lg border border-[#C9CEC6] px-3 font-normal'

/**
 * One form for adding and changing a service, from the board ("+" under a day)
 * and from the set page. Status switch: Zaplanowany (dates, hours or whole days)
 * / Wymagany (no date yet). On an existing service switching moves it
 * (Zaplanuj / Odłóż); Odwołaj and Usuń are separate buttons.
 */
export function ServiceDialog({
  truck,
  service,
  day,
  candidates = [],
  onClose,
  onSaved,
}: {
  truck: ServiceDialogTruck
  service?: Service | null
  day?: string
  /** Required services that a new planned one may be (merge instead of a duplicate). */
  candidates?: Service[]
  onClose: () => void
  onSaved: () => void
}) {
  const id = useId()
  const editing = service ?? null
  const startDefault = day ?? todayIso()
  const [mode, setMode] = useState<Mode>(editing ? (editing.status === 'required' ? 'required' : 'planned') : 'planned')
  const [target, setTarget] = useState<ServiceTarget>(editing?.target ?? 'truck')
  const [trailerPlate, setTrailerPlate] = useState(editing?.trailerPlate ?? truck.trailer ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [place, setPlace] = useState(editing?.place ?? '')
  const [allDay, setAllDay] = useState(editing?.allDay ?? false)
  const [startDay, setStartDay] = useState(editing?.startDay ?? startDefault)
  const [startTime, setStartTime] = useState(editing?.startTime ?? '08:00')
  const [endDay, setEndDay] = useState(editing?.endDay ?? startDefault)
  const [endTime, setEndTime] = useState(editing?.endTime ?? '10:00')
  const [mergeWith, setMergeWith] = useState<number | 'new' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const plateKey = trailerPlate.replace(/[^0-9A-Za-z]/g, '').toUpperCase()
  const matching = editing
    ? []
    : candidates.filter(c => c.status === 'required' && c.target === target && (target === 'truck' || (c.trailerPlate ?? '') === plateKey))
  const askMerge = mode === 'planned' && matching.length > 0
  const cancelled = editing?.status === 'cancelled'

  const when = () =>
    allDay ? { allDay: true, startDay, endDay } : { allDay: false, startDay, startTime, endDay, endTime }

  const check = (): string | null => {
    if (mode === 'required' && !description.trim()) return 'Wpisz, co trzeba zrobić (np. wymiana oleju).'
    if (target === 'trailer' && !trailerPlate.trim()) return 'Podaj numer naczepy.'
    if (mode === 'planned') {
      if (!startDay || !endDay) return 'Podaj daty serwisu.'
      if (allDay && endDay < startDay) return 'Ostatni dzień serwisu nie może być przed pierwszym.'
      if (!allDay && (!startTime || !endTime)) return 'Podaj godziny serwisu albo zaznacz „Cały dzień”.'
      if (!allDay && `${endDay}T${endTime}` <= `${startDay}T${startTime}`) return 'Koniec serwisu musi być po początku.'
      if (askMerge && mergeWith === null) return 'Zaznacz, czy to serwis zgłoszony wcześniej, czy nowy.'
    }
    return null
  }

  const run = async (fn: () => Promise<unknown>) => {
    setSaving(true)
    setError(null)
    try {
      await fn()
      onSaved()
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się zapisać serwisu.'))
      setSaving(false)
    }
  }

  const save = () => {
    const problem = check()
    if (problem) {
      setError(problem)
      return
    }
    const common = {
      target,
      ...(target === 'trailer' ? { trailerPlate: trailerPlate.trim() } : {}),
      description: description.trim(),
      place: place.trim(),
    }
    void run(async () => {
      if (editing) {
        await boardApi.updateService(editing.id, mode === 'planned' ? { ...common, status: 'planned', ...when() } : { ...common, status: 'required' })
      } else if (askMerge && typeof mergeWith === 'number') {
        const base = matching.find(c => c.id === mergeWith)
        await boardApi.updateService(mergeWith, {
          status: 'planned',
          ...when(),
          ...(description.trim() ? { description: description.trim() } : { description: base?.description ?? '' }),
          ...(place.trim() ? { place: place.trim() } : {}),
        })
      } else {
        await boardApi.createService({ truckId: truck.id, status: mode, ...common, ...(mode === 'planned' ? when() : {}) })
      }
    })
  }

  const primaryLabel = !editing
    ? askMerge && typeof mergeWith === 'number'
      ? 'Zaplanuj zgłoszony'
      : 'Dodaj serwis'
    : cancelled
      ? 'Przywróć'
      : editing.status === 'required' && mode === 'planned'
        ? 'Zaplanuj'
        : editing.status === 'planned' && mode === 'required'
          ? 'Odłóż'
          : 'Zapisz'

  const seg = (active: boolean) =>
    `h-10 flex-1 rounded-md px-3 text-sm font-semibold ${active ? 'bg-white text-[#15181C] shadow-sm' : 'text-[#545B63] hover:text-[#15181C]'}`

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="flex max-h-[calc(100vh-32px)] w-full max-w-lg flex-col overflow-y-auto rounded-xl bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id={`${id}-title`} className="flex items-center gap-2 text-lg font-bold">
              <Icon name="service" size={18} /> {editing ? 'Serwis' : 'Nowy serwis'} · {truck.plate}
            </h2>
            <p className="text-sm text-[#545B63]">
              {editing
                ? `${PHASE_LABELS[editing.phase]} · zgłoszony ${stamp(editing.reportedAt)} przez ${editing.createdBy}`
                : 'Okres, w którym auto (albo naczepa) nie jest dostępne. Nie zmienia km ani kwot.'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="flex h-11 w-11 flex-none items-center justify-center rounded-lg border border-[#D5D9D3]">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-3 text-sm">
          {cancelled && (
            <p className="rounded-lg bg-[#F6F7F4] px-3 py-2 text-[13px] text-[#3D444C]">Serwis odwołany. „Przywróć” wraca go na tablicę — potem możesz go zmienić.</p>
          )}
          {!cancelled && (
            <div role="radiogroup" aria-label="Rodzaj serwisu" className="flex gap-1 rounded-lg bg-[#E2E5DF] p-1">
              <button type="button" role="radio" aria-checked={mode === 'planned'} onClick={() => setMode('planned')} className={seg(mode === 'planned')}>
                Zaplanowany
              </button>
              <button type="button" role="radio" aria-checked={mode === 'required'} onClick={() => setMode('required')} className={seg(mode === 'required')}>
                Wymagany (bez terminu)
              </button>
            </div>
          )}
          {editing && !cancelled && editing.status === 'planned' && mode === 'required' && (
            <p className="rounded-lg bg-[#F6F7F4] px-3 py-2 text-[13px] text-[#3D444C]">Serwis wróci do wymaganych — znacznik pojawi się znowu przy aucie, termin zostanie w historii.</p>
          )}
          {editing && !cancelled && editing.status === 'required' && mode === 'planned' && (
            <p className="rounded-lg bg-[#F6F7F4] px-3 py-2 text-[13px] text-[#3D444C]">Podaj termin — ten sam wpis stanie się serwisem zaplanowanym.</p>
          )}

          <div role="radiogroup" aria-label="Czego dotyczy" className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="font-semibold">Dotyczy</span>
            <label className="flex min-h-10 cursor-pointer items-center gap-2">
              <input type="radio" name={`${id}-target`} disabled={cancelled} checked={target === 'truck'} onChange={() => setTarget('truck')} className="h-[18px] w-[18px] accent-[#1E4E9C]" />
              ciągnika {truck.plate}
            </label>
            <label className="flex min-h-10 cursor-pointer items-center gap-2">
              <input type="radio" name={`${id}-target`} disabled={cancelled} checked={target === 'trailer'} onChange={() => setTarget('trailer')} className="h-[18px] w-[18px] accent-[#1E4E9C]" />
              naczepy
            </label>
            {target === 'trailer' && (
              <input
                aria-label="Numer naczepy"
                value={trailerPlate}
                disabled={cancelled}
                maxLength={20}
                onChange={e => setTrailerPlate(e.target.value)}
                placeholder="np. AB123CD"
                className={`${FIELD} h-10 w-36 font-mono uppercase`}
              />
            )}
          </div>

          {askMerge && (
            <fieldset className="flex flex-col gap-1.5 rounded-lg border border-[#C9CEC6] px-3 py-2.5">
              <legend className="px-1 font-semibold">Czy to zgłoszony wcześniej serwis?</legend>
              {matching.map(c => (
                <label key={c.id} className="flex min-h-9 cursor-pointer items-center gap-2">
                  <input type="radio" name={`${id}-merge`} checked={mergeWith === c.id} onChange={() => setMergeWith(c.id)} className="h-[18px] w-[18px] accent-[#1E4E9C]" />
                  Tak — {c.description || 'serwis'} (zgłoszony {dm(c.reportedAt.slice(0, 10))})
                </label>
              ))}
              <label className="flex min-h-9 cursor-pointer items-center gap-2">
                <input type="radio" name={`${id}-merge`} checked={mergeWith === 'new'} onChange={() => setMergeWith('new')} className="h-[18px] w-[18px] accent-[#1E4E9C]" />
                Nie, to nowy serwis
              </label>
            </fieldset>
          )}

          <label className="flex flex-col gap-1 font-semibold" htmlFor={`${id}-desc`}>
            Co {mode === 'required' ? '*' : '(opcjonalnie)'}
            <input id={`${id}-desc`} value={description} disabled={cancelled} maxLength={300} onChange={e => setDescription(e.target.value)} placeholder="np. wymiana oleju, agregat" className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 font-semibold" htmlFor={`${id}-place`}>
            {mode === 'required' ? 'Gdzie może zjechać (opcjonalnie)' : 'Gdzie (opcjonalnie)'}
            <input id={`${id}-place`} value={place} disabled={cancelled} maxLength={150} onChange={e => setPlace(e.target.value)} placeholder="np. Kraków, serwis marki" className={FIELD} />
          </label>

          {mode === 'planned' && !cancelled && (
            <div className="flex flex-col gap-2 rounded-lg bg-[#F6F7F4] px-3 py-3">
              <label className="flex min-h-9 cursor-pointer items-center gap-2 font-semibold">
                <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} className="h-[18px] w-[18px] accent-[#1E4E9C]" />
                Cały dzień (auto niedostępne)
              </label>
              <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-2">
                <span className="font-semibold">Od</span>
                <input
                  type="date"
                  aria-label="Od — dzień"
                  value={startDay}
                  onChange={e => {
                    const v = e.target.value
                    setStartDay(v)
                    if (v && (!endDay || endDay < v)) setEndDay(v)
                  }}
                  className={FIELD}
                />
                {!allDay ? (
                  <input type="time" aria-label="Od — godzina" value={startTime} onChange={e => setStartTime(e.target.value)} className={`${FIELD} w-36`} />
                ) : (
                  <span />
                )}
                <span className="font-semibold">Do</span>
                <input type="date" aria-label="Do — dzień" value={endDay} min={startDay} onChange={e => setEndDay(e.target.value)} className={FIELD} />
                {!allDay ? (
                  <input type="time" aria-label="Do — godzina" value={endTime} onChange={e => setEndTime(e.target.value)} className={`${FIELD} w-36`} />
                ) : (
                  <span />
                )}
              </div>
              {!allDay && startDay === endDay && (
                <span className="text-xs text-[#545B63]">Auto tego dnia jedzie dalej — serwis z godzinami nie koliduje ze zleceniami.</span>
              )}
              {allDay && <span className="text-xs text-[#545B63]">Zlecenie w taki dzień dostanie czerwoną ramkę na tablicy.</span>}
            </div>
          )}

          {error && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-800">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {editing && !cancelled && !confirmDelete && (
              <>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void run(() => boardApi.updateService(editing.id, { status: 'cancelled' }))}
                  className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold disabled:opacity-60"
                >
                  Odwołaj
                </button>
                <button type="button" disabled={saving} onClick={() => setConfirmDelete(true)} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold text-[#9B1C1C] disabled:opacity-60">
                  Usuń
                </button>
              </>
            )}
            {editing && confirmDelete && (
              <>
                <span className="text-[13px] text-[#3D444C]">Usunąć wpis wprowadzony przez pomyłkę?</span>
                <button type="button" onClick={() => setConfirmDelete(false)} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold">
                  Nie
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void run(() => boardApi.deleteService(editing.id))}
                  className="h-11 rounded-lg bg-[#9B1C1C] px-4 font-semibold text-white disabled:opacity-60"
                >
                  Tak, usuń
                </button>
              </>
            )}
            {!confirmDelete && (
              <>
                <span className="flex-1" />
                <button type="button" onClick={onClose} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold">
                  Anuluj
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    cancelled
                      ? void run(() =>
                          boardApi.updateService(editing!.id, editing!.startDay ? { status: 'planned' } : { status: 'required' }),
                        )
                      : save()
                  }
                  className="h-11 rounded-lg bg-[#1E4E9C] px-4 font-semibold text-white disabled:opacity-60"
                >
                  {primaryLabel}
                </button>
              </>
            )}
          </div>

          {editing && editing.history.length > 0 && (
            <details className="rounded-lg bg-[#F6F7F4] px-3 py-2">
              <summary className="cursor-pointer font-semibold">Historia ({editing.history.length})</summary>
              <ul className="mt-2 flex flex-col gap-1.5">
                {editing.history.map((h, i) => (
                  <li key={i} className="text-[13px]">
                    <span className="font-mono text-xs text-[#545B63]">
                      {stamp(h.at)} · {h.by}
                    </span>
                    <br />
                    {h.text}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}

/** First day to propose for a new service on a page showing [from, to]. */
export function defaultServiceDay(from: string, to: string): string {
  const today = todayIso()
  return today >= from && today <= to ? today : from
}

