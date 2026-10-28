import { useId, useState } from 'react'
import { boardApi, type FleetTruck, type GeocodeCandidate } from './boardApi.js'
import { todayIso } from './format.js'
import { Icon } from './Icon.js'

/**
 * The buttons that settle a review item ("Do sprawdzenia"): the same set in the review list
 * and, since 28.10.2026, under the orange boxes in the order panel.
 */

/** Review items about one order (their ref is the order number). */
export const ORDER_KINDS = new Set([
  'HIGH_MARGIN',
  'NEGATIVE_MARGIN',
  'REV_PER_KM',
  'PRZ_PARSE',
  'PRZ_MULTI',
  'PRZ_TRUCK_UNKNOWN',
  'PRZ_AMOUNT_MISMATCH',
  'PRZ_SUB_NOT_IN_ENTRY',
  'PRZ_DATE',
  'PRZ_PLACE_UNKNOWN',
  'MISSING_TRAILER',
  'DISAPPEARED',
  'OVERRIDE_SUPERSEDED',
  'NO_CARRIER',
  'FERRY_PARSE',
  'DRAFT_MATCH',
  'DRAFT_STALE',
  'ROUTE_GAP',
  'COLOAD',
])

export interface IssueRef {
  id: number
  kind: string
  ref: string
  details: Record<string, unknown>
}

export function IssueActions({
  issue,
  fleet,
  onResolve,
  onOpenOrder,
  currentOrderNo,
  onFixPrz,
  onFixCoLoad,
}: {
  issue: IssueRef
  fleet: FleetTruck[]
  onResolve: (action: string, payload?: Record<string, unknown>) => void
  onOpenOrder: (orderNo: string) => void
  /** Set in the order panel: the order shown there (no "Otwórz" for itself). */
  currentOrderNo?: string
  /** Order panel: open "Popraw ręcznie → Wpis przepinki" with the current entry. */
  onFixPrz?: () => void
  /** Order panel: open "Popraw ręcznie → Doładunek do zlecenia" (28.10.2026). */
  onFixCoLoad?: () => void
}) {
  const d = issue.details
  const suggestions = (Array.isArray(d['suggestions']) ? d['suggestions'] : []) as Array<string | { code: string; name: string }>
  const isOrder = ORDER_KINDS.has(issue.kind)
  return (
      <div className="flex flex-wrap gap-2">
        {issue.kind === 'UNKNOWN_TRAILER' && (
          <>
            {suggestions.map(s => (
              <ActionButton key={String(s)} primary onClick={() => onResolve('alias', { trailer: s })}>
                To {String(s)} — zapamiętaj zapis
              </ActionButton>
            ))}
            <ActionButton onClick={() => onResolve('new', {})}>{typeof d['retired'] === 'string' ? 'Przywróć do floty' : 'Dodaj jako nową naczepę'}</ActionButton>
          </>
        )}
        {issue.kind === 'MISSING_TRAILER' && (
          <>
            {(Array.isArray(d['pool']) ? (d['pool'] as string[]) : []).map(t => (
              <ActionButton key={t} primary onClick={() => onResolve('set', { trailer: t })}>
                {t}
              </ActionButton>
            ))}
            <TrailerSetter lastKnown={typeof d['lastKnown'] === 'string' ? d['lastKnown'] : ''} onSet={t => onResolve('set', { trailer: t })} />
          </>
        )}
        {(issue.kind === 'UNKNOWN_PLACE' || issue.kind === 'PRZ_PLACE_UNKNOWN') && (
          <PlaceResolver raw={String(d['raw'] ?? issue.ref)} suggestions={suggestions as Array<{ code: string; name: string }>} onResolve={onResolve} />
        )}
        {issue.kind === 'NEW_TRUCK' &&
          (typeof d['retiredTruckId'] === 'number' ? (
            <>
              <ActionButton primary onClick={() => onResolve('restore')}>
                Przywróć {issue.ref} do działu
              </ActionButton>
              <ActionButton onClick={() => onResolve('ignore')}>Pomiń na stałe</ActionButton>
            </>
          ) : (
            <NewTruckActions fleet={fleet} firstDate={String(d['firstDate'] ?? todayIso())} onResolve={onResolve} />
          ))}
        {issue.kind === 'PRZ_TRUCK_UNKNOWN' &&
          (Array.isArray(d['suggestions']) ? (d['suggestions'] as string[]) : []).map(plate => (
            <ActionButton key={plate} primary onClick={() => onResolve('fix_plate', { plate })}>
              Popraw na {plate}
            </ActionButton>
          ))}
        {issue.kind === 'PRZ_AMOUNT_MISMATCH' && onFixPrz && (
          <ActionButton primary onClick={onFixPrz}>
            Popraw wpis przepinki
          </ActionButton>
        )}
        {/* The order number above is a link too, but easy to miss — say it with a button (27.10.2026). The panel is the order already. */}
        {isOrder && !currentOrderNo && (
          <ActionButton onClick={() => onOpenOrder(issue.ref)}>Otwórz zlecenie</ActionButton>
        )}
        {issue.kind === 'COLOAD' && typeof d['of'] === 'string' && d['of'] && d['problem'] !== 'missing' && d['of'] !== currentOrderNo && (
          <ActionButton onClick={() => onOpenOrder(String(d['of']))}>Otwórz {String(d['of'])}</ActionButton>
        )}
        {issue.kind === 'COLOAD' && onFixCoLoad && (
          <ActionButton primary onClick={onFixCoLoad}>
            Wskaż zlecenie główne
          </ActionButton>
        )}
        {issue.kind === 'ROUTE_GAP' &&
          (Array.isArray(d['orders']) ? (d['orders'] as string[]) : [])
            .filter(no => no !== currentOrderNo)
            .map(no => (
            <ActionButton key={no} onClick={() => onOpenOrder(no)}>
              Otwórz {no}
            </ActionButton>
          ))}
        {issue.kind === 'DISAPPEARED' && (
          <>
            <ActionButton primary onClick={() => onResolve('keep')}>
              Zostaw na tablicy
            </ActionButton>
            <ActionButton onClick={() => onResolve('delete')}>Usuń z tablicy</ActionButton>
          </>
        )}
        {issue.kind === 'DRAFT_MATCH' && (
          <>
            {(Array.isArray(d['candidates']) ? (d['candidates'] as string[]) : []).map(no => (
              <ActionButton key={no} primary onClick={() => onResolve('replace', { orderNo: no })}>
                Zastąp zleceniem {no}
              </ActionButton>
            ))}
            <ActionButton onClick={() => onResolve('keep')}>Żadne — zostaw wstępne</ActionButton>
          </>
        )}
        {issue.kind === 'DRAFT_STALE' && (
          <>
            <ActionButton primary onClick={() => onResolve('delete')}>
              Usuń zlecenie wstępne
            </ActionButton>
            <ActionButton onClick={() => onResolve('dismiss')}>Zostaw</ActionButton>
          </>
        )}
        {!['NEW_TRUCK', 'DISAPPEARED', 'DRAFT_MATCH', 'DRAFT_STALE'].includes(issue.kind) && (
          <ActionButton onClick={() => onResolve('dismiss')}>{issue.kind === 'OVERRIDE_SUPERSEDED' ? 'OK' : 'W porządku'}</ActionButton>
        )}
      </div>
  )
}

export function ActionButton({ children, primary, onClick }: { children: React.ReactNode; primary?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-11 rounded-lg px-3.5 text-sm font-semibold ${primary ? 'bg-[#1E4E9C] text-white' : 'border border-[#C9CEC6] bg-white text-[#15181C]'}`}
    >
      {children}
    </button>
  )
}

function TrailerSetter({ lastKnown, onSet }: { lastKnown: string; onSet: (t: string) => void }) {
  const id = useId()
  const [value, setValue] = useState(lastKnown)
  return (
    <span className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={id}>
        Numer naczepy
      </label>
      <input id={id} value={value} onChange={e => setValue(e.target.value)} placeholder="numer naczepy" className="h-11 w-36 rounded-lg border border-[#C9CEC6] px-3 font-mono" />
      <ActionButton primary onClick={() => value.trim() && onSet(value.trim())}>
        Ustaw naczepę
      </ActionButton>
    </span>
  )
}

function NewTruckActions({ fleet, firstDate, onResolve }: { fleet: FleetTruck[]; firstDate: string; onResolve: (a: string, p?: Record<string, unknown>) => void }) {
  const id = useId()
  const [truckId, setTruckId] = useState<number | ''>('')
  const [from, setFrom] = useState(firstDate)
  const [open, setOpen] = useState(false)
  return (
    <>
      {!open ? (
        <ActionButton primary onClick={() => setOpen(true)}>
          Nowy numer auta…
        </ActionButton>
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`${id}-truck`}>
            Auto
          </label>
          <select id={`${id}-truck`} value={truckId} onChange={e => setTruckId(e.target.value ? Number(e.target.value) : '')} className="h-11 rounded-lg border border-[#C9CEC6] px-2">
            <option value="">wybierz auto…</option>
            {fleet.map(t => (
              <option key={t.id} value={t.id}>
                {t.currentPlate} · {t.carrier}
                {t.retiredOn ? ' (wycofany)' : ''}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor={`${id}-from`}>
            Od dnia
          </label>
          <input id={`${id}-from`} type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-11 rounded-lg border border-[#C9CEC6] px-2" />
          <ActionButton primary onClick={() => truckId && onResolve('new-plate', { truckId, validFrom: from })}>
            Zapisz
          </ActionButton>
        </span>
      )}
      <ActionButton onClick={() => onResolve('add-truck')}>Dodaj jako nowe auto</ActionButton>
      <ActionButton onClick={() => onResolve('ignore')}>Pomiń na stałe</ActionButton>
    </>
  )
}

function PlaceResolver({
  raw,
  suggestions,
  onResolve,
}: {
  raw: string
  suggestions: Array<{ code: string; name: string }>
  onResolve: (a: string, p?: Record<string, unknown>) => void
}) {
  const id = useId()
  const [query, setQuery] = useState(raw)
  const [candidates, setCandidates] = useState<GeocodeCandidate[] | null>(null)
  const [manual, setManual] = useState(false)
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const [name, setName] = useState(raw)
  const search = async () => {
    try {
      setCandidates(await boardApi.geocode(query))
    } catch {
      setCandidates([])
    }
  }
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {suggestions.map(s => (
          <ActionButton key={s.code} primary onClick={() => onResolve('alias', { code: s.code })}>
            To {s.name} ({s.code})
          </ActionButton>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`${id}-geo`}>
          Szukaj miejsca na mapie
        </label>
        <input id={`${id}-geo`} value={query} onChange={e => setQuery(e.target.value)} className="h-11 min-w-0 flex-1 rounded-lg border border-[#C9CEC6] px-3" />
        <ActionButton onClick={() => void search()}>
          <span className="inline-flex items-center gap-1.5">
            <Icon name="search" size={14} /> Szukaj na mapie
          </span>
        </ActionButton>
      </div>
      {candidates && candidates.length === 0 && <p className="text-[13px] text-[#545B63]">Mapa nic nie znalazła (albo HERE jest niedostępne).</p>}
      {candidates?.map(c => (
        <button
          key={`${c.lat},${c.lon}`}
          type="button"
          onClick={() => onResolve('new', { name: name.trim() || raw, lat: c.lat, lon: c.lon, country: c.country })}
          className="flex min-h-11 items-center gap-2 rounded-lg border border-[#C9CEC6] px-3 text-left text-sm hover:bg-[#F7F8F6]"
        >
          <Icon name="pin" size={14} /> {c.title} <span className="font-mono text-xs text-[#545B63]">{c.lat.toFixed(3)}, {c.lon.toFixed(3)}</span>
        </button>
      ))}
      {!manual && (
        <button type="button" onClick={() => setManual(true)} className="self-start text-[13px] font-semibold text-[#1E4E9C] underline">
          Wpisz współrzędne ręcznie
        </button>
      )}
      {manual && (
        <div className="flex flex-wrap items-end gap-2 text-[13px]">
          <label className="flex flex-col gap-1">
            Nazwa
            <input value={name} onChange={e => setName(e.target.value)} className="h-11 rounded-lg border border-[#C9CEC6] px-2" />
          </label>
          <label className="flex flex-col gap-1">
            Szerokość
            <input value={lat} onChange={e => setLat(e.target.value)} placeholder="51.69" className="h-11 w-28 rounded-lg border border-[#C9CEC6] px-2" />
          </label>
          <label className="flex flex-col gap-1">
            Długość
            <input value={lon} onChange={e => setLon(e.target.value)} placeholder="19.53" className="h-11 w-28 rounded-lg border border-[#C9CEC6] px-2" />
          </label>
          <ActionButton
            primary
            onClick={() => {
              const latN = Number(lat.replace(',', '.'))
              const lonN = Number(lon.replace(',', '.'))
              if (!name.trim() || !lat.trim() || !lon.trim() || !Number.isFinite(latN) || !Number.isFinite(lonN)) return
              onResolve('new', { name: name.trim(), lat: latN, lon: lonN })
            }}
          >
            Dodaj miejsce
          </ActionButton>
        </div>
      )}
    </div>
  )
}
