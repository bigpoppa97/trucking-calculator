import { useState } from 'react'
import type { FetchedRouteDto, PlaceDto, RouteDetailsDto } from '../lib/types.js'
import { formatEur, formatKm } from '../lib/format.js'
import { normalizeRouteInput, searchPlaces, titleCase, unknownStops } from '../lib/places.js'
import { AddPlaceForm } from './AddPlaceForm.js'
import { RouteStatusBadge, type RouteStatus } from './RouteStatusBadge.js'
import { TollCheckDetails, TollCheckWarnings } from './TollCheck.js'

/**
 * Route lookup panel (PRD §3.2): table-first, explicit confirmation before
 * any HERE call, explicit save step afterwards. Purely presentational —
 * state transitions live in CalculatorPage so the stale-reset rule is
 * enforced in one place.
 *
 * Stops (09.11.2026): airports or places from the board's dictionary, typed
 * as codes or names ("WAW-Kowno" → WAW-KUN). An unknown stop is offered as a
 * new dictionary place instead of a HERE call that would fail.
 */

export type RouteState =
  | { kind: 'idle' }
  | { kind: 'loading'; routeCode: string }
  | { kind: 'found'; route: RouteDetailsDto }
  | { kind: 'notFound'; routeCode: string }
  | { kind: 'fetching'; routeCode: string }
  | { kind: 'fetched'; fetched: FetchedRouteDto; saved: boolean; saving: boolean }
  | { kind: 'error'; message: string }

export interface RoutePanelProps {
  /** Route code to show in the field when the calculator restores a remembered route. */
  initialCode?: string | undefined
  routeState: RouteState
  /** Airports + dictionary places (GET /api/places). */
  places: PlaceDto[]
  onLookup: (routeCode: string) => void
  onConfirmHereFetch: () => void
  onSaveFetched: () => void
  /** Reloads the place list after "Dodaj miejsce". */
  onPlacesChanged?: (() => Promise<void>) | undefined
}

export function routeStatusOf(state: RouteState): RouteStatus | null {
  switch (state.kind) {
    case 'found': {
      const hasEstimates = state.route.tolls.some(t => t.status === 'estimate')
      return state.route.kmSource === 'here' || hasEstimates ? 'here-unverified' : 'database'
    }
    case 'fetched':
      return 'here-unverified'
    case 'notFound':
      return 'new-route'
    default:
      return null
  }
}

export function RoutePanel({
  initialCode,
  routeState,
  places,
  onLookup,
  onConfirmHereFetch,
  onSaveFetched,
  onPlacesChanged,
}: RoutePanelProps) {
  const [input, setInput] = useState(initialCode ?? '')
  const status = routeStatusOf(routeState)

  const lastSegment = (input.split('-').pop() ?? '').trim()
  const lastIsCode = places.some(p => p.code === lastSegment.toUpperCase())
  // Right after a lookup with unknown stops, the "Nie znam miejsca" box offers matches instead.
  const justLookedUp = routeState.kind === 'notFound' && routeState.routeCode === input
  const suggestions = lastSegment.length >= 1 && !lastIsCode && !justLookedUp ? searchPlaces(lastSegment, places, 6) : []

  const applySuggestion = (code: string) => {
    const parts = input.split('-')
    parts[parts.length - 1] = code
    setInput(parts.join('-'))
  }

  const submit = (raw: string) => {
    const code = normalizeRouteInput(raw, places)
    if (code === '') return
    setInput(code)
    onLookup(code)
  }

  /** Swap one stop of the looked-up route for another code and look it up again. */
  const replaceStop = async (routeCode: string, stop: string, code: string) => {
    const next = routeCode
      .split('-')
      .map(s => (s === stop ? code : s))
      .join('-')
    await onPlacesChanged?.()
    setInput(next)
    onLookup(next)
  }

  return (
    <section aria-label="Trasa" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-800">Trasa</h2>
        {status !== null && <RouteStatusBadge status={status} />}
      </div>

      <form
        className="flex gap-2"
        onSubmit={e => {
          e.preventDefault()
          if (input.trim() !== '') submit(input)
        }}
      >
        <label htmlFor="route-code" className="sr-only">
          Kod trasy
        </label>
        <input
          id="route-code"
          type="text"
          value={input}
          onChange={e => setInput(e.target.value.toUpperCase())}
          placeholder="np. WAW-PRG lub WAW-WYSO-FRA"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm uppercase shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-300"
        />
        <button
          type="submit"
          disabled={routeState.kind === 'loading' || routeState.kind === 'fetching'}
          className="shrink-0 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {routeState.kind === 'loading' ? 'Szukam…' : 'Sprawdź trasę'}
        </button>
      </form>

      {suggestions.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1" aria-label="Podpowiedzi miejsc">
          {suggestions.map(p => (
            <li key={p.code}>
              <SuggestionButton place={p} onClick={() => applySuggestion(p.code)} />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        {routeState.kind === 'idle' && (
          <p className="text-sm text-slate-500">
            Podaj trasę: kody lotnisk lub miejsc rozdzielone myślnikami (np. WAW-PRG, WAW-TCZE). Możesz wpisać nazwę
            miejscowości — podpowiem kod.
          </p>
        )}

        {routeState.kind === 'loading' && <p className="text-sm text-slate-500">Sprawdzam bazę tras…</p>}

        {routeState.kind === 'error' && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {routeState.message}
          </p>
        )}

        {routeState.kind === 'notFound' && places.length > 0 && unknownStops(routeState.routeCode, places).length > 0 && (
          <UnknownStops
            key={routeState.routeCode}
            routeCode={routeState.routeCode}
            places={places}
            onReplace={(stop, code) => replaceStop(routeState.routeCode, stop, code)}
          />
        )}

        {routeState.kind === 'notFound' && (places.length === 0 || unknownStops(routeState.routeCode, places).length === 0) && (
          <div className="rounded bg-orange-50 px-3 py-3 text-sm text-orange-900">
            <p className="mb-2">
              Trasy <strong>{routeState.routeCode}</strong> nie ma w bazie. Zapytać HERE API? (Zużywa limit
              zapytań — tylko dla naprawdę nowych tras.)
            </p>
            <button
              type="button"
              onClick={onConfirmHereFetch}
              className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700"
            >
              Zapytaj HERE API
            </button>
          </div>
        )}

        {routeState.kind === 'fetching' && <p className="text-sm text-slate-500">Pobieram trasę z HERE…</p>}

        {routeState.kind === 'found' && (
          <div className="space-y-2">
            <RouteDataTable data={toDisplay(routeState.route)} />
            {/* Warnings of the last HERE toll check — details and "Przelicz" under the map. */}
            <TollCheckWarnings warnings={routeState.route.tollCheck?.warnings ?? []} />
          </div>
        )}

        {routeState.kind === 'fetched' && (
          <div className="space-y-3">
            <RouteDataTable data={toDisplayFetched(routeState.fetched)} />
            <TollCheckWarnings warnings={routeState.fetched.tollCheck?.warnings ?? []} />
            {routeState.fetched.tollCheck !== undefined && <TollCheckDetails check={routeState.fetched.tollCheck} />}
            {routeState.fetched.warnings.length > 0 && (
              <ul className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {routeState.fetched.warnings.map(w => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {routeState.saved ? (
              <p className="text-sm font-medium text-green-700">Zapisano w bazie tras.</p>
            ) : (
              <button
                type="button"
                onClick={onSaveFetched}
                disabled={routeState.saving}
                className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {routeState.saving ? 'Zapisuję…' : 'Zapisz do bazy tras'}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function SuggestionButton({ place, onClick }: { place: PlaceDto; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={place.kind === 'airport' ? `Lotnisko${place.detail ? `: ${place.detail}` : ''}` : 'Miejsce ze słownika'}
      className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
    >
      <span className="font-mono">{place.code}</span> · {place.name}
      {place.kind === 'place' && place.country !== '' && <span className="text-slate-400"> ({place.country})</span>}
    </button>
  )
}

/**
 * The looked-up route has stops nobody knows: offer close matches (a typo, a
 * partial name) or "Dodaj miejsce" — one unknown stop at a time.
 */
function UnknownStops({
  routeCode,
  places,
  onReplace,
}: {
  routeCode: string
  places: PlaceDto[]
  onReplace: (stop: string, code: string) => Promise<void>
}) {
  const unknown = unknownStops(routeCode, places)
  const stop = unknown[0]!
  const close = searchPlaces(stop, places, 3)
  const [adding, setAdding] = useState(false)

  return (
    <div className="rounded bg-amber-50 px-3 py-3 text-sm text-amber-900" data-testid="unknown-stops">
      <p>
        Nie znam {unknown.length === 1 ? 'miejsca' : 'miejsc'}{' '}
        {unknown.map((u, i) => (
          <span key={u}>
            {i > 0 && ', '}
            <strong>{u}</strong>
          </span>
        ))}
        . To nie jest lotnisko ani miejsce ze słownika.
      </p>
      {close.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-xs">Może chodziło o:</span>
          {close.map(p => (
            <SuggestionButton key={p.code} place={p} onClick={() => void onReplace(stop, p.code)} />
          ))}
        </div>
      )}
      {adding ? (
        <AddPlaceForm
          initialName={titleCase(stop)}
          onCreated={code => onReplace(stop, code)}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
        >
          Dodaj „{titleCase(stop)}” jako nowe miejsce
        </button>
      )}
    </div>
  )
}

interface RouteDisplay {
  routeCode: string
  totalKm: number
  rows: Array<{ country: string; km: number | null; toll: number | null; tollLabel: string }>
}

function toDisplay(route: RouteDetailsDto): RouteDisplay {
  const countries = new Set([...Object.keys(route.countryKm), ...route.tolls.map(t => t.country)])
  return {
    routeCode: route.routeCode,
    totalKm: route.totalKm,
    rows: [...countries].sort().map(country => {
      const toll = route.tolls.find(t => t.country === country)
      return {
        country,
        km: route.countryKm[country] ?? null,
        toll: toll?.tollEur ?? null,
        tollLabel: toll === undefined ? 'brak — do uzupełnienia' : toll.status === 'estimate' ? 'szacunek' : 'zweryfikowana',
      }
    }),
  }
}

function toDisplayFetched(fetched: FetchedRouteDto): RouteDisplay {
  const countries = new Set([...Object.keys(fetched.countryKm), ...Object.keys(fetched.tollEstimates)])
  return {
    routeCode: fetched.routeCode,
    totalKm: fetched.totalKm,
    rows: [...countries].sort().map(country => ({
      country,
      km: fetched.countryKm[country] ?? null,
      toll: fetched.tollEstimates[country] ?? null,
      tollLabel: country in fetched.tollEstimates ? 'szacunek' : 'brak — do uzupełnienia',
    })),
  }
}

function RouteDataTable({ data }: { data: RouteDisplay }) {
  return (
    <div>
      <p className="mb-2 text-sm text-slate-700">
        <strong>{data.routeCode}</strong> — łącznie <span data-testid="route-total-km">{formatKm(data.totalKm)}</span>
      </p>
      {data.rows.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
              <th className="py-1 pr-2 font-medium">Kraj</th>
              <th className="py-1 pr-2 font-medium">Km</th>
              <th className="py-1 pr-2 font-medium">Opłata</th>
              <th className="py-1 font-medium">Status opłaty</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map(row => (
              <tr key={row.country} className="border-b border-slate-100">
                <td className="py-1 pr-2 font-medium text-slate-700">{row.country}</td>
                <td className="py-1 pr-2 tabular-nums">{row.km === null ? '—' : formatKm(row.km)}</td>
                <td className="py-1 pr-2 tabular-nums" data-testid={`toll-${row.country}`}>
                  {row.toll === null ? '—' : formatEur(row.toll)}
                </td>
                <td className="py-1 text-xs text-slate-500">{row.tollLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
