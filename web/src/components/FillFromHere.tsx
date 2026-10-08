import { useState } from 'react'
import { api, ApiError } from '../lib/api.js'
import { formatEur, formatKm } from '../lib/format.js'
import type { GapFillSummaryDto, RouteDetailsDto } from '../lib/types.js'

/**
 * "Uzupełnij z HERE" for routes already in the database — mostly v1 imports
 * whose sheet had no columns for FR/ES/NL/CH and zero tolls. One HERE call
 * fills ONLY the gaps: toll estimates for countries without any toll value
 * and km for countries missing from the stored split. Verified tolls,
 * existing estimates, stored country km and the binding total stay as they
 * are (enforced by the backend).
 */

/** Below this share of the total, the stored country split counts as incomplete. */
const KM_COVERAGE_THRESHOLD = 0.97

export interface RouteGaps {
  pendingCountries: string[]
  coveredKm: number
  kmIncomplete: boolean
}

export function routeGaps(route: Pick<RouteDetailsDto, 'totalKm' | 'countryKm' | 'tollsPendingCountries'>): RouteGaps {
  const coveredKm = Object.values(route.countryKm).reduce((sum, km) => sum + km, 0)
  return {
    pendingCountries: route.tollsPendingCountries,
    coveredKm,
    kmIncomplete: coveredKm < route.totalKm * KM_COVERAGE_THRESHOLD,
  }
}

export function hasGaps(route: Pick<RouteDetailsDto, 'totalKm' | 'countryKm' | 'tollsPendingCountries'>): boolean {
  const gaps = routeGaps(route)
  return gaps.pendingCountries.length > 0 || gaps.kmIncomplete
}

type PanelState =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'busy' }
  | { kind: 'done'; summary: GapFillSummaryDto }
  | { kind: 'error'; message: string }

export function FillFromHerePanel({
  route,
  onFilled,
  className = 'mt-3',
}: {
  route: RouteDetailsDto
  onFilled: (route: RouteDetailsDto) => void | Promise<void>
  className?: string
}) {
  const [state, setState] = useState<PanelState>({ kind: 'idle' })

  if ((state.kind === 'idle' || state.kind === 'confirm') && !hasGaps(route)) return null

  const run = async () => {
    setState({ kind: 'busy' })
    try {
      const result = await api.fillRouteFromHere(route.routeCode)
      setState({ kind: 'done', summary: result.summary })
      await onFilled(result.route)
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'Nie udało się pobrać danych z HERE. Spróbuj ponownie.',
      })
    }
  }

  const gaps = routeGaps(route)

  return (
    <div aria-label="Uzupełnianie trasy z HERE" role="group" className={`${className} rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-slate-700`}>
      {(state.kind === 'idle' || state.kind === 'error') && (
        <>
          <ul className="mb-2 space-y-0.5">
            {gaps.pendingCountries.length > 0 && <li>Brak opłat dla: {gaps.pendingCountries.join(', ')}.</li>}
            {gaps.kmIncomplete && (
              <li>
                Kraje w bazie pokrywają {formatKm(gaps.coveredKm)} z {formatKm(route.totalKm)} — części krajów brakuje.
              </li>
            )}
          </ul>
          {state.kind === 'error' && (
            <p role="alert" className="mb-2 text-red-700">
              {state.message}
            </p>
          )}
          <button
            type="button"
            onClick={() => setState({ kind: 'confirm' })}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700"
          >
            Uzupełnij z HERE
          </button>
        </>
      )}

      {state.kind === 'confirm' && (
        <>
          <p className="mb-2">
            Jedno zapytanie do HERE. Dopiszę brakujące kraje i brakujące opłaty (jako szacunek do weryfikacji).
            Zweryfikowane opłaty, istniejące szacunki i łączne km ({formatKm(route.totalKm)}) zostaną bez zmian.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void run()}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700"
            >
              Pobierz z HERE
            </button>
            <button
              type="button"
              onClick={() => setState({ kind: 'idle' })}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
            >
              Anuluj
            </button>
          </div>
        </>
      )}

      {state.kind === 'busy' && <p aria-live="polite">Pobieram dane z HERE…</p>}

      {state.kind === 'done' && <FillSummary summary={state.summary} />}
    </div>
  )
}

function FillSummary({ summary }: { summary: GapFillSummaryDto }) {
  const addedKm = Object.entries(summary.addedCountryKm)
  const addedTolls = Object.entries(summary.addedTolls)
  const nothingAdded = addedKm.length === 0 && addedTolls.length === 0

  return (
    <div aria-live="polite" className="space-y-0.5">
      <p className="font-medium text-slate-800">
        {nothingAdded ? 'HERE nie znalazł nic do uzupełnienia.' : 'Uzupełniono z HERE ✓'}
      </p>
      {addedKm.length > 0 && (
        <p>Dodane kraje: {addedKm.map(([country, km]) => `${country} ${formatKm(km)}`).join(', ')}</p>
      )}
      {addedTolls.length > 0 && (
        <p>
          Dodane opłaty (szacunek): {addedTolls.map(([country, eur]) => `${country} ${formatEur(eur)}`).join(', ')}
        </p>
      )}
      {summary.keptTollCountries.length > 0 && (
        <p className="text-slate-500">Bez zmian: {summary.keptTollCountries.join(', ')}</p>
      )}
      {summary.stillPendingCountries.length > 0 && (
        <p className="text-orange-700">
          Nadal bez opłaty (HERE jej nie wycenił): {summary.stillPendingCountries.join(', ')}
        </p>
      )}
      <p className="text-slate-500">Trasa wg HERE: {formatKm(summary.hereTotalKm)} (łączne km w bazie bez zmian).</p>
      {summary.warnings.length > 0 && (
        <details className="text-slate-500">
          <summary className="cursor-pointer">Uwagi HERE ({summary.warnings.length})</summary>
          <ul className="mt-1 list-disc pl-4">
            {summary.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
