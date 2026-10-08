import { useCallback, useEffect, useState } from 'react'
import { parseDecimalInput } from '@domain'
import { api, ApiError } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'
import type { RouteDetailsDto, RouteSummaryDto, RouteWaypointDto } from '../lib/types.js'
import { formatEur, formatKm } from '../lib/format.js'
import { FillFromHerePanel } from '../components/FillFromHere.js'

/**
 * Route database screen (PRD §5.3): all routes, "tolls pending verification"
 * filter, per-country toll verification/entry, manual km override with an
 * audit note (PRD §3.3).
 */

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; routes: RouteSummaryDto[] }

export function RouteDbPage() {
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [pendingOnly, setPendingOnly] = useState(false)
  const [selected, setSelected] = useState<RouteDetailsDto | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  const refreshList = useCallback(async () => {
    try {
      setList({ kind: 'ready', routes: await api.listRoutes() })
    } catch (error) {
      setList({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'Nie udało się wczytać listy tras.',
      })
    }
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  const openRoute = async (routeCode: string) => {
    setDetailError(null)
    try {
      const route = await api.getRoute(routeCode)
      setSelected(route)
      if (route === null) setDetailError('Trasa zniknęła z bazy — odśwież listę.')
    } catch (error) {
      setDetailError(error instanceof ApiError ? error.message : 'Nie udało się wczytać trasy.')
    }
  }

  const onRouteUpdated = async (route: RouteDetailsDto) => {
    setSelected(route)
    await refreshList()
  }

  if (list.kind === 'loading') return <p className="p-6 text-sm text-slate-500">Wczytywanie bazy tras…</p>
  if (list.kind === 'error') {
    return (
      <p role="alert" className="m-6 rounded bg-red-50 px-4 py-3 text-sm text-red-700">
        {list.message}
      </p>
    )
  }

  const visible = pendingOnly ? list.routes.filter(r => r.tollsPending || r.hasEstimates) : list.routes

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800">Baza tras ({list.routes.length})</h2>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={pendingOnly}
              onChange={e => setPendingOnly(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            tylko opłaty do weryfikacji / uzupełnienia
          </label>
        </div>

        {visible.length === 0 ? (
          <p className="text-sm text-slate-500">
            {pendingOnly ? 'Wszystkie opłaty są zweryfikowane i uzupełnione. 🎉' : 'Baza tras jest pusta.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="py-1.5 pr-2 font-medium">Trasa</th>
                <th className="py-1.5 pr-2 font-medium">Km</th>
                <th className="py-1.5 pr-2 font-medium">Źródło km</th>
                <th className="py-1.5 font-medium">Opłaty</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(route => (
                <tr
                  key={route.id}
                  className={`cursor-pointer border-b border-slate-100 hover:bg-slate-50 ${
                    selected?.routeCode === route.routeCode ? 'bg-sky-50' : ''
                  }`}
                  onClick={() => void openRoute(route.routeCode)}
                >
                  <td className="py-1.5 pr-2 font-medium text-slate-800">
                    <button type="button" className="hover:underline">
                      {route.routeCode}
                    </button>
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums">{formatKm(route.totalKm)}</td>
                  <td className="py-1.5 pr-2 text-xs text-slate-500">
                    {route.kmSource === 'manual' ? 'ręczne (wiążące)' : 'HERE'}
                  </td>
                  <td className="py-1.5">
                    <span className="flex flex-wrap gap-1">
                      {route.hasEstimates && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                          szacunki do weryfikacji
                        </span>
                      )}
                      {route.tollsPending && (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-800">
                          brakujące opłaty
                        </span>
                      )}
                      {!route.hasEstimates && !route.tollsPending && (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">OK</span>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {detailError !== null && (
        <p role="alert" className="rounded bg-red-50 px-4 py-3 text-sm text-red-700">
          {detailError}
        </p>
      )}

      {selected !== null && (
        // Keyed by route: per-route form state must never carry over to another route.
        <RouteDetailPanel key={selected.routeCode} route={selected} onUpdated={onRouteUpdated} onError={setDetailError} />
      )}

      <WaypointsSection />
    </div>
  )
}

/** Common border crossings the fleet prefers (PRD §3.3). Coordinates sit on
 *  the crossing's road so the pass-through via snaps to the right corridor. */
const CROSSING_PRESETS: ReadonlyArray<{ name: string; lat: number; lon: number }> = [
  { name: 'Chyżne (PL/SK)', lat: 49.4053, lon: 19.7204 },
  { name: 'Šahy (SK/HU)', lat: 48.0742, lon: 18.949 },
  { name: 'Kudowa-Zdrój (PL/CZ)', lat: 50.4437, lon: 16.2262 },
  { name: 'Cieszyn (PL/CZ)', lat: 49.7484, lon: 18.633 },
  { name: 'Świecko (PL/DE)', lat: 52.3117, lon: 14.562 },
  { name: 'Jędrzychowice (PL/DE)', lat: 51.174, lon: 15.007 },
  { name: 'Barwinek (PL/SK)', lat: 49.4269, lon: 21.698 },
  { name: 'Hegyeshalom (HU/AT)', lat: 47.9107, lon: 17.156 },
]

function WaypointsSection() {
  const [routeCode, setRouteCode] = useState('')
  const [loadedCode, setLoadedCode] = useState<string | null>(null)
  const [waypoints, setWaypoints] = useState<RouteWaypointDto[]>([])
  const [presetIdx, setPresetIdx] = useState(0)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const code = routeCode.trim().toUpperCase()
    if (!/^[A-Z]{3}(-[A-Z]{3})+$/.test(code)) {
      setMessage({ kind: 'error', text: 'Podaj kod trasy w formacie WAW-BUD.' })
      return
    }
    setMessage(null)
    try {
      setWaypoints(await api.getRouteWaypoints(code))
      setLoadedCode(code)
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof ApiError ? error.message : 'Nie udało się wczytać punktów.' })
    }
  }

  const addPreset = () => {
    const preset = CROSSING_PRESETS[presetIdx]
    if (!preset || loadedCode === null) return
    const nextSeq = waypoints.length > 0 ? Math.max(...waypoints.map(w => w.seq)) + 1 : 1
    setWaypoints([...waypoints, { id: -nextSeq, routeCode: loadedCode, seq: nextSeq, name: preset.name, lat: preset.lat, lon: preset.lon }])
  }

  const save = async () => {
    if (loadedCode === null) return
    setBusy(true)
    setMessage(null)
    try {
      const saved = await api.saveRouteWaypoints(
        loadedCode,
        waypoints.map(({ seq, name, lat, lon }) => ({ seq, name, lat, lon })),
      )
      setWaypoints(saved)
      setMessage({
        kind: 'ok',
        text: 'Punkty zapisane. Zostaną użyte przy pobraniu trasy z HERE oraz przy odświeżaniu przebiegu drogi.',
      })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof ApiError ? error.message : 'Nie udało się zapisać punktów.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Preferowane punkty trasy" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-1 text-base font-semibold text-slate-800">Preferowane punkty trasy (przejścia graniczne)</h2>
      <p className="mb-3 text-xs text-slate-500">
        Punkty via wymuszają na HERE przebieg przez preferowane przejścia (np. WAW-BUD przez Chyżne i Šahy). Działają
        przy pierwszym pobraniu nowej trasy oraz przy „Pobierz przebieg drogi" — zapisane km i opłaty istniejących tras
        pozostają bez zmian.
      </p>

      <div className="mb-3 flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="wp-route-code" className="text-xs font-medium text-slate-600">
            Kod trasy
          </label>
          <input
            id="wp-route-code"
            type="text"
            value={routeCode}
            onChange={e => setRouteCode(e.target.value)}
            placeholder="np. WAW-BUD"
            className="rounded border border-slate-300 px-2 py-1.5 text-sm uppercase"
          />
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700"
        >
          Wczytaj punkty
        </button>
      </div>

      {message !== null && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`mb-3 rounded px-3 py-2 text-sm ${message.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-800'}`}
        >
          {message.text}
        </p>
      )}

      {loadedCode !== null && (
        <>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">{loadedCode}</h3>
          {waypoints.length === 0 ? (
            <p className="mb-3 text-sm text-slate-500">Brak punktów — trasa pojedzie domyślną drogą HERE.</p>
          ) : (
            <table className="mb-3 w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="py-1.5 pr-2 font-medium">Kolejność</th>
                  <th className="py-1.5 pr-2 font-medium">Nazwa</th>
                  <th className="py-1.5 pr-2 font-medium">Szer. (lat)</th>
                  <th className="py-1.5 pr-2 font-medium">Dł. (lon)</th>
                  <th className="py-1.5 font-medium">Akcja</th>
                </tr>
              </thead>
              <tbody>
                {waypoints.map((wp, i) => (
                  <tr key={wp.id} className="border-b border-slate-100">
                    <td className="py-1.5 pr-2 tabular-nums">{wp.seq}</td>
                    <td className="py-1.5 pr-2 font-medium text-slate-700">{wp.name}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-xs">{wp.lat}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-xs">{wp.lon}</td>
                    <td className="py-1.5">
                      <button
                        type="button"
                        onClick={() => setWaypoints(waypoints.filter((_, j) => j !== i))}
                        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        Usuń
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="wp-preset" className="text-xs font-medium text-slate-600">
                Dodaj przejście graniczne
              </label>
              <select
                id="wp-preset"
                value={presetIdx}
                onChange={e => setPresetIdx(Number(e.target.value))}
                className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              >
                {CROSSING_PRESETS.map((preset, i) => (
                  <option key={preset.name} value={i}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={addPreset}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Dodaj
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? 'Zapisuję…' : 'Zapisz punkty'}
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Kolejność punktów = kolejność przejazdu. Dla tras z lotniskami pośrednimi (np. WAW-BER-FRA) lotniska mają
            pozycje 1000, 2000… — punkt z kolejnością 500 wypada przed pierwszym lotniskiem pośrednim.
          </p>
        </>
      )}
    </section>
  )
}

function RouteDetailPanel({
  route,
  onUpdated,
  onError,
}: {
  route: RouteDetailsDto
  onUpdated: (route: RouteDetailsDto) => Promise<void>
  onError: (message: string) => void
}) {
  const countries = [...new Set([...Object.keys(route.countryKm), ...route.tolls.map(t => t.country)])].sort()

  return (
    <section
      aria-label={`Szczegóły trasy ${route.routeCode}`}
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h3 className="mb-1 text-base font-semibold text-slate-800">
        {route.routeCode} — {formatKm(route.totalKm)}
      </h3>
      <p className="mb-3 text-xs text-slate-500">
        Źródło km: {route.kmSource === 'manual' ? 'ręczne (wiążące)' : 'HERE'}
        {route.kmNote !== null && ` · notatka: ${route.kmNote}`}
        {route.kmUpdatedBy !== null && ` · zmienił: ${route.kmUpdatedBy} (${route.kmUpdatedAt ?? ''})`}
      </p>

      <table className="mb-4 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
            <th className="py-1 pr-2 font-medium">Kraj</th>
            <th className="py-1 pr-2 font-medium">Km</th>
            <th className="py-1 pr-2 font-medium">Opłata</th>
            <th className="py-1 pr-2 font-medium">Status</th>
            <th className="py-1 font-medium">Akcja</th>
          </tr>
        </thead>
        <tbody>
          {countries.map(country => {
            const toll = route.tolls.find(t => t.country === country)
            // Re-mount when the stored toll changes so the input shows the current value.
            return (
              <TollRow
                key={`${country}|${toll?.status ?? 'pending'}|${toll?.tollEur ?? ''}`}
                route={route}
                country={country}
                onUpdated={onUpdated}
                onError={onError}
              />
            )
          })}
        </tbody>
      </table>

      <FillFromHerePanel route={route} onFilled={onUpdated} className="mb-4" />

      {/* Re-mount on km changes (e.g. after a HERE fill) so the form never submits a stale country split. */}
      <KmOverrideForm
        key={`${route.totalKm}|${JSON.stringify(route.countryKm)}`}
        route={route}
        onUpdated={onUpdated}
        onError={onError}
      />
    </section>
  )
}

function TollRow({
  route,
  country,
  onUpdated,
  onError,
}: {
  route: RouteDetailsDto
  country: string
  onUpdated: (route: RouteDetailsDto) => Promise<void>
  onError: (message: string) => void
}) {
  const { user } = useAuth()
  const toll = route.tolls.find(t => t.country === country)
  const [value, setValue] = useState(toll === undefined ? '' : String(toll.tollEur).replace('.', ','))
  const [busy, setBusy] = useState(false)
  // Toll values are trust-tier data verified against invoices (PRD §4.3) —
  // entry and verification are finance/admin actions; the backend enforces
  // the same rule with a 403.
  const canEditTolls = user?.role === 'finance' || user?.role === 'admin'

  const submit = async () => {
    const parsed = parseDecimalInput(value)
    if (parsed === null || parsed < 0) {
      onError(`Nieprawidłowa kwota opłaty dla ${country} — podaj liczbę, np. 35,00.`)
      return
    }
    setBusy(true)
    try {
      const updated =
        toll?.status === 'estimate'
          ? await api.verifyToll(route.routeCode, country, parsed)
          : await api.setToll(route.routeCode, country, parsed)
      await onUpdated(updated)
    } catch (error) {
      onError(error instanceof ApiError ? error.message : 'Nie udało się zapisać opłaty.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className="border-b border-slate-100">
      <td className="py-1.5 pr-2 font-medium text-slate-700">{country}</td>
      <td className="py-1.5 pr-2 tabular-nums">
        {route.countryKm[country] === undefined ? '—' : formatKm(route.countryKm[country])}
      </td>
      <td className="py-1.5 pr-2 tabular-nums">{toll === undefined ? '—' : formatEur(toll.tollEur)}</td>
      <td className="py-1.5 pr-2 text-xs">
        {toll === undefined && <span className="text-orange-700">brak — do uzupełnienia</span>}
        {toll?.status === 'estimate' && <span className="text-amber-700">szacunek z HERE</span>}
        {toll?.status === 'verified' && (
          <span className="text-green-700">
            zweryfikowana{toll.verifiedBy !== null && ` · ${toll.verifiedBy}`}
          </span>
        )}
      </td>
      <td className="py-1.5">
        {toll?.status === 'verified' ? (
          <span className="text-xs text-slate-400">—</span>
        ) : !canEditTolls ? (
          <span className="text-xs text-slate-400">tylko finanse/administrator</span>
        ) : (
          <span className="flex items-center gap-1">
            <label className="sr-only" htmlFor={`toll-input-${country}`}>
              Kwota opłaty {country}
            </label>
            <input
              id={`toll-input-${country}`}
              type="text"
              inputMode="decimal"
              value={value}
              onChange={e => setValue(e.target.value)}
              className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
              placeholder="EUR"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              {toll?.status === 'estimate' ? 'Zweryfikuj' : 'Zapisz opłatę'}
            </button>
          </span>
        )}
      </td>
    </tr>
  )
}

function KmOverrideForm({
  route,
  onUpdated,
  onError,
}: {
  route: RouteDetailsDto
  onUpdated: (route: RouteDetailsDto) => Promise<void>
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [totalKm, setTotalKm] = useState(String(route.totalKm).replace('.', ','))
  const [countryKm, setCountryKm] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(route.countryKm).map(([c, km]) => [c, String(km).replace('.', ',')])),
  )
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const total = parseDecimalInput(totalKm)
    if (total === null || total <= 0) {
      onError('Nieprawidłowa łączna liczba km.')
      return
    }
    const parsedCountry: Record<string, number> = {}
    for (const [country, raw] of Object.entries(countryKm)) {
      const km = parseDecimalInput(raw)
      if (km === null || km < 0) {
        onError(`Nieprawidłowe km dla ${country}.`)
        return
      }
      parsedCountry[country] = km
    }
    setBusy(true)
    try {
      const updated = await api.overrideKm(route.routeCode, {
        totalKm: total,
        countryKm: parsedCountry,
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      })
      await onUpdated(updated)
      setOpen(false)
    } catch (error) {
      onError(error instanceof ApiError ? error.message : 'Nie udało się zapisać km.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
      >
        Koryguj km ręcznie
      </button>
    )
  }

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <h4 className="mb-2 text-sm font-semibold text-slate-800">Ręczna korekta km (wiążąca)</h4>
      <div className="mb-2 grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="override-total" className="text-xs font-medium text-slate-600">
            Łącznie km
          </label>
          <input
            id="override-total"
            type="text"
            inputMode="decimal"
            value={totalKm}
            onChange={e => setTotalKm(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        {Object.entries(countryKm).map(([country, raw]) => (
          <div key={country} className="flex flex-col gap-1">
            <label htmlFor={`override-${country}`} className="text-xs font-medium text-slate-600">
              {country} km
            </label>
            <input
              id={`override-${country}`}
              type="text"
              inputMode="decimal"
              value={raw}
              onChange={e => setCountryKm(m => ({ ...m, [country]: e.target.value }))}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </div>
        ))}
      </div>
      <div className="mb-2 flex flex-col gap-1">
        <label htmlFor="override-note" className="text-xs font-medium text-slate-600">
          Notatka (np. preferowane przejście graniczne)
        </label>
        <input
          id="override-note"
          type="text"
          value={note}
          onChange={e => setNote(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          placeholder="np. jeździmy przez Kudowę-Zdrój"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          Zapisz km
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
        >
          Anuluj
        </button>
      </div>
    </div>
  )
}
