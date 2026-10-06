import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { boardApi, errorMessage, type FleetTruck, type GeocodeCandidate, type ImportSummary, type Issue } from './boardApi.js'
import { dm, stamp, todayIso } from './format.js'
import { Icon } from './Icon.js'

/**
 * Import of the application's export + the review queue ("Do sprawdzenia").
 */

const KIND_TAG: Record<string, { label: string; bg: string; fg: string }> = {
  HIGH_MARGIN: { label: 'Marża', bg: '#F4C77A', fg: '#3A2400' },
  NEGATIVE_MARGIN: { label: 'Marża', bg: '#F4C77A', fg: '#3A2400' },
  REV_PER_KM: { label: 'Stawka/km', bg: '#F4C77A', fg: '#3A2400' },
  PRZ_PARSE: { label: 'Przepinka', bg: '#F4C77A', fg: '#3A2400' },
  PRZ_MULTI: { label: 'Przepinka', bg: '#F4C77A', fg: '#3A2400' },
  PRZ_TRUCK_UNKNOWN: { label: 'Przepinka', bg: '#F4C77A', fg: '#3A2400' },
  PRZ_AMOUNT_MISMATCH: { label: 'Przepinka', bg: '#F4C77A', fg: '#3A2400' },
  PRZ_SUB_NOT_IN_ENTRY: { label: 'Przepinka', bg: '#F4C77A', fg: '#3A2400' },
  PRZ_DATE: { label: 'Przepinka', bg: '#F4C77A', fg: '#3A2400' },
  PRZ_PLACE_UNKNOWN: { label: 'Nowe miejsce', bg: '#DCE5F2', fg: '#15181C' },
  UNKNOWN_PLACE: { label: 'Nowe miejsce', bg: '#DCE5F2', fg: '#15181C' },
  UNKNOWN_TRAILER: { label: 'Naczepa', bg: '#E6E9EE', fg: '#15181C' },
  MISSING_TRAILER: { label: 'Naczepa', bg: '#E6E9EE', fg: '#15181C' },
  NEW_TRUCK: { label: 'Nowy ciągnik', bg: '#DCE5F2', fg: '#15181C' },
  DISAPPEARED: { label: 'Zniknęło', bg: '#E6E9EE', fg: '#15181C' },
  OVERRIDE_SUPERSEDED: { label: 'Poprawka', bg: '#E6E9EE', fg: '#15181C' },
  NO_CARRIER: { label: 'Przewoźnik', bg: '#F4C77A', fg: '#3A2400' },
}

const ORDER_KINDS = new Set([
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
])

export function ReviewPage({ onOpenOrder, onIssuesChanged }: { onOpenOrder: (orderNo: string) => void; onIssuesChanged: () => void }) {
  const [issues, setIssues] = useState<Issue[] | null>(null)
  const [fleet, setFleet] = useState<FleetTruck[]>([])
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [mode, setMode] = useState<'daily' | 'history'>('daily')
  const [dragOver, setDragOver] = useState(false)
  const [lastImport, setLastImport] = useState<{ filename: string; imported_at: string; summary: ImportSummary } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const [list, trucks, imports] = await Promise.all([boardApi.issues(), boardApi.fleet(), boardApi.imports()])
      setIssues(list)
      setFleet(trucks)
      setLastImport(imports[0] ?? null)
      setError(null)
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się wczytać listy.'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const upload = async (file: File | undefined) => {
    if (!file) return
    setImporting(true)
    setImportError(null)
    try {
      setSummary(await boardApi.importFile(file, mode))
      await load()
      onIssuesChanged()
    } catch (e) {
      setImportError(errorMessage(e, 'Import się nie udał.'))
    } finally {
      setImporting(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const resolve = async (issue: Issue, action: string, payload: Record<string, unknown> = {}) => {
    try {
      await boardApi.resolveIssue(issue.id, action, payload)
      await load()
      onIssuesChanged()
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się zapisać decyzji.'))
    }
  }

  const ignoreAllNewTrucks = async () => {
    for (const i of issues?.filter(x => x.kind === 'NEW_TRUCK') ?? []) await boardApi.resolveIssue(i.id, 'ignore')
    await load()
    onIssuesChanged()
  }

  const newTruckCount = issues?.filter(i => i.kind === 'NEW_TRUCK').length ?? 0
  const shown = summary ?? lastImport?.summary ?? null

  return (
    <div className="mx-auto flex max-w-[1400px] flex-wrap items-start gap-5 p-6">
      <section aria-labelledby="imp-h" className="flex min-w-0 flex-[1_1_520px] flex-col gap-4">
        <h1 id="imp-h" className="text-[22px] font-bold">
          Import eksportu z aplikacji
        </h1>
        <div
          onDragOver={e => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault()
            setDragOver(false)
            void upload(e.dataTransfer.files[0])
          }}
          className={`flex flex-col items-center gap-2.5 rounded-xl border-2 border-dashed bg-white px-5 py-7 text-center ${dragOver ? 'border-[#1E4E9C] bg-[#EEF2FA]' : 'border-[#9AA3AC]'}`}
        >
          <Icon name="upload" size={28} className="text-[#545B63]" />
          <span className="text-base font-semibold">{importing ? 'Importuję…' : 'Upuść tutaj plik eksportu (.xlsx)'}</span>
          <span className="max-w-[460px] text-[13px] text-[#545B63]">
            Zapisany widok w aplikacji: wszyscy klienci, data załadunku od 7 dni wstecz oraz zlecenia przyszłe.
          </span>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              disabled={importing}
              onClick={() => fileInput.current?.click()}
              className="h-11 rounded-lg bg-[#1E4E9C] px-4 font-semibold text-white disabled:opacity-60"
            >
              Wybierz plik
            </button>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={mode === 'history'} onChange={e => setMode(e.target.checked ? 'history' : 'daily')} className="h-4 w-4" />
              starsze dane (historia)
            </label>
          </div>
          <input ref={fileInput} type="file" accept=".xlsx" className="hidden" onChange={e => void upload(e.target.files?.[0])} />
        </div>
        {importError && (
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
            {importError}
          </p>
        )}
        {shown && <ImportCard summary={shown} fresh={summary !== null} onOpenOrder={onOpenOrder} />}
      </section>

      <section aria-labelledby="chk-h" className="flex min-w-0 flex-[1_1_520px] flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="chk-h" className="text-[22px] font-bold">
            Do sprawdzenia
          </h2>
          <span className="text-[13px] text-[#545B63]">{issues ? `${issues.length} otwarte` : ''}</span>
        </div>
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </p>
        )}
        {issues && issues.length === 0 && <p className="rounded-xl border border-[#D5D9D3] bg-white p-5 text-sm">Wszystko sprawdzone.</p>}
        {newTruckCount > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#D5D9D3] bg-white px-4 py-3 text-[13px]">
            <span>{newTruckCount} ciągników przewoźników z floty jeździ poza Twoją bazą (ich pozostałe auta).</span>
            <button type="button" onClick={() => void ignoreAllNewTrucks()} className="h-10 rounded-lg border border-[#C9CEC6] px-3 font-semibold">
              Pomiń wszystkie na stałe
            </button>
          </div>
        )}
        {issues?.map(issue => (
          <IssueCard key={issue.id} issue={issue} fleet={fleet} onResolve={(a, p) => void resolve(issue, a, p)} onOpenOrder={onOpenOrder} />
        ))}
        <div className="flex flex-col gap-2.5 rounded-xl bg-[#15181C] px-5 py-4 text-[#EEF0EC]">
          <span className="text-base font-bold">Wpis przepinki w uwagach</span>
          <span className="rounded-lg bg-[#2A3038] px-3 py-2.5 font-mono text-[13.5px]">PRZ GORZYCZKI 26.04 WGM4518U&gt;KN1050H 700/400</span>
          <span className="text-[13px] text-[#C9CED4]">
            Miejsce, data, auto oddające &gt; auto przejmujące, kwota dla każdego auta w tej samej kolejności. Marża zlecenia = stawka klienta − suma kwot.
          </span>
        </div>
      </section>
    </div>
  )
}

function ImportCard({ summary, fresh, onOpenOrder }: { summary: ImportSummary; fresh: boolean; onOpenOrder: (orderNo: string) => void }) {
  const total = summary.rowsInScope + summary.rowsOwnFleet + summary.rowsOtherCarriers || 1
  return (
    <div className="flex flex-col gap-3.5 rounded-xl border border-[#D5D9D3] bg-white px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-base font-bold">{fresh ? 'Wynik importu' : 'Ostatni import'}</span>
        <span className="font-mono text-[13px] text-[#545B63]">
          {summary.filename} · {stamp(summary.importedAt)} · {summary.rowsTotal} wierszy
          {summary.rangeFrom && ` · ${dm(summary.rangeFrom)}–${dm(summary.rangeTo ?? summary.rangeFrom)}`}
        </span>
      </div>
      <div
        role="img"
        aria-label={`Podział wierszy: ${summary.rowsInScope} Twojej floty, ${summary.rowsOwnFleet} floty własnej, ${summary.rowsOtherCarriers} innych przewoźników`}
        className="flex h-3.5 overflow-hidden rounded-full bg-[#EEF0EC]"
      >
        <span style={{ flex: summary.rowsInScope / total, background: '#1E4E9C' }} />
        <span style={{ flex: summary.rowsOwnFleet / total, background: '#9AA3AC' }} />
        <span style={{ flex: summary.rowsOtherCarriers / total, background: '#D5D9D3' }} />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 text-[13px]">
        <Dot color="#1E4E9C" n={summary.rowsInScope} label="Twoja flota" />
        <Dot color="#9AA3AC" n={summary.rowsOwnFleet} label="flota własna — pominięte" />
        <Dot color="#D5D9D3" n={summary.rowsOtherCarriers} label="inni przewoźnicy — pominięte" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2">
        <Stat label="Nowe" n={summary.created.length} />
        <Stat label="Zmienione" n={summary.updated.length} />
        <Stat label="Zniknęło" n={summary.disappeared.length} />
        <Stat label="Bez zmian" n={summary.unchanged} />
      </div>
      {summary.warnings.map(w => (
        <p key={w} className="rounded-lg bg-[#FBEBD0] px-3 py-2 text-[13px] text-[#3A2400]">
          {w}
        </p>
      ))}
      {summary.updated.length > 0 && (
        <div className="flex flex-col gap-1 text-[13px]">
          <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Zmiany</span>
          {summary.updated.slice(0, 12).map(u => (
            <span key={u.orderNo}>
              <button type="button" onClick={() => onOpenOrder(u.orderNo)} className="font-mono font-semibold text-[#1E4E9C] underline">
                {u.orderNo}
              </button>{' '}
              · {u.changes.map(c => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ')}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Dot({ color, n, label }: { color: string; n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      <span>
        <span className="font-mono font-semibold">{n}</span> {label}
      </span>
    </span>
  )
}

function Stat({ label, n }: { label: string; n: number }) {
  return (
    <div className="rounded-lg bg-[#F3F4F1] px-3 py-2.5">
      <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#545B63]">{label}</span>
      <span className="font-mono text-xl font-semibold">{n}</span>
    </div>
  )
}

function IssueCard({
  issue,
  fleet,
  onResolve,
  onOpenOrder,
}: {
  issue: Issue
  fleet: FleetTruck[]
  onResolve: (action: string, payload?: Record<string, unknown>) => void
  onOpenOrder: (orderNo: string) => void
}) {
  const tag = KIND_TAG[issue.kind] ?? { label: issue.kind, bg: '#E6E9EE', fg: '#15181C' }
  const d = issue.details
  const suggestions = (Array.isArray(d['suggestions']) ? d['suggestions'] : []) as Array<string | { code: string; name: string }>
  const isOrder = ORDER_KINDS.has(issue.kind)
  return (
    <article className="flex flex-col gap-2.5 rounded-xl border border-[#D5D9D3] bg-white px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="rounded px-2 py-0.5 text-[11.5px] font-bold uppercase tracking-wider" style={{ background: tag.bg, color: tag.fg }}>
          {tag.label}
        </span>
        {isOrder ? (
          <button type="button" onClick={() => onOpenOrder(issue.ref)} className="font-mono font-semibold text-[#1E4E9C] underline">
            {issue.ref}
          </button>
        ) : (
          <span className="font-mono font-semibold">{issue.ref}</span>
        )}
        <span className="text-xs text-[#545B63]">{stamp(issue.updated_at)}</span>
      </div>
      <p className="text-sm">{issue.message}</p>
      <div className="flex flex-wrap gap-2">
        {issue.kind === 'UNKNOWN_TRAILER' && (
          <>
            {suggestions.map(s => (
              <ActionButton key={String(s)} primary onClick={() => onResolve('alias', { trailer: s })}>
                To {String(s)} — zapamiętaj zapis
              </ActionButton>
            ))}
            <ActionButton onClick={() => onResolve('new', {})}>Dodaj jako nową naczepę</ActionButton>
          </>
        )}
        {issue.kind === 'MISSING_TRAILER' && <TrailerSetter lastKnown={typeof d['lastKnown'] === 'string' ? d['lastKnown'] : ''} onSet={t => onResolve('set', { trailer: t })} />}
        {(issue.kind === 'UNKNOWN_PLACE' || issue.kind === 'PRZ_PLACE_UNKNOWN') && (
          <PlaceResolver raw={String(d['raw'] ?? issue.ref)} suggestions={suggestions as Array<{ code: string; name: string }>} onResolve={onResolve} />
        )}
        {issue.kind === 'NEW_TRUCK' && <NewTruckActions fleet={fleet} firstDate={String(d['firstDate'] ?? todayIso())} onResolve={onResolve} />}
        {issue.kind === 'DISAPPEARED' && (
          <>
            <ActionButton primary onClick={() => onResolve('keep')}>
              Zostaw na tablicy
            </ActionButton>
            <ActionButton onClick={() => onResolve('delete')}>Usuń z tablicy</ActionButton>
          </>
        )}
        {!['NEW_TRUCK', 'DISAPPEARED'].includes(issue.kind) && (
          <ActionButton onClick={() => onResolve('dismiss')}>{issue.kind === 'OVERRIDE_SUPERSEDED' ? 'OK' : 'W porządku'}</ActionButton>
        )}
      </div>
    </article>
  )
}

function ActionButton({ children, primary, onClick }: { children: React.ReactNode; primary?: boolean; onClick: () => void }) {
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
