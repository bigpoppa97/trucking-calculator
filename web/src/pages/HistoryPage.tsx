import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api.js'
import type { CalculationDto } from '../lib/types.js'
import { formatEur, formatKm } from '../lib/format.js'
import { CostBreakdownPanel } from '../components/CostBreakdownPanel.js'

/**
 * History screen (PRD §5.3): saved calculations with FROZEN snapshots —
 * the displayed breakdown is exactly what was calculated at save time,
 * regardless of later config changes (PRD §5.2).
 */

type HistoryState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; calculations: CalculationDto[] }

export function HistoryPage() {
  const [state, setState] = useState<HistoryState>({ kind: 'loading' })
  const [routeFilter, setRouteFilter] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const load = async (route?: string) => {
    setState({ kind: 'loading' })
    try {
      setState({ kind: 'ready', calculations: await api.listCalculations(route) })
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'Nie udało się wczytać historii.',
      })
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-800">Historia kalkulacji</h2>
          <form
            className="flex gap-2"
            onSubmit={e => {
              e.preventDefault()
              void load(routeFilter.trim() === '' ? undefined : routeFilter.trim().toUpperCase())
            }}
          >
            <label htmlFor="history-route" className="sr-only">
              Filtr trasy
            </label>
            <input
              id="history-route"
              type="text"
              value={routeFilter}
              onChange={e => setRouteFilter(e.target.value.toUpperCase())}
              placeholder="filtr: np. WAW-PRG"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm uppercase"
            />
            <button
              type="submit"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              Filtruj
            </button>
          </form>
        </div>

        {state.kind === 'loading' && <p className="text-sm text-slate-500">Wczytywanie…</p>}
        {state.kind === 'error' && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.message}
          </p>
        )}
        {state.kind === 'ready' && state.calculations.length === 0 && (
          <p className="text-sm text-slate-500">Brak zapisanych kalkulacji.</p>
        )}
        {state.kind === 'ready' && state.calculations.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="py-1.5 pr-2 font-medium">Data</th>
                <th className="py-1.5 pr-2 font-medium">Trasa</th>
                <th className="py-1.5 pr-2 font-medium">Dni</th>
                <th className="py-1.5 pr-2 font-medium">Tabor</th>
                <th className="py-1.5 pr-2 font-medium">Koszt</th>
                <th className="py-1.5 pr-2 font-medium">Zysk</th>
                <th className="py-1.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {state.calculations.map(calc => (
                <HistoryRow
                  key={calc.id}
                  calc={calc}
                  expanded={expandedId === calc.id}
                  onToggle={() => setExpandedId(expandedId === calc.id ? null : calc.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function HistoryRow({ calc, expanded, onToggle }: { calc: CalculationDto; expanded: boolean; onToggle: () => void }) {
  const { snapshot } = calc
  return (
    <>
      <tr className="border-b border-slate-100">
        <td className="py-1.5 pr-2 text-xs text-slate-500">{calc.createdAt}</td>
        <td className="py-1.5 pr-2 font-medium text-slate-800">{calc.routeCode}</td>
        <td className="py-1.5 pr-2 tabular-nums">{String(calc.days).replace('.', ',')}</td>
        <td className="py-1.5 pr-2 text-xs">{snapshot.input.fleetVariantName}</td>
        <td className="py-1.5 pr-2 font-medium tabular-nums">{formatEur(snapshot.breakdown.totalEur)}</td>
        <td className="py-1.5 pr-2 tabular-nums">
          {snapshot.breakdown.pnl === null ? '—' : formatEur(snapshot.breakdown.pnl.profitEur)}
        </td>
        <td className="py-1.5 text-right">
          <button
            type="button"
            onClick={onToggle}
            className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            {expanded ? 'Zwiń' : 'Szczegóły'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="bg-slate-50 p-3">
            <p className="mb-2 text-xs text-slate-500">
              Zamrożony snapshot z chwili zapisu — późniejsze zmiany konfiguracji go nie zmieniają. Parametry:{' '}
              {formatKm(snapshot.input.totalKm)}, {String(snapshot.input.orderDays).replace('.', ',')} dni,{' '}
              {snapshot.input.driverCount} kier., paliwo {String(snapshot.config.fuelPriceEurPerLitre).replace('.', ',')}{' '}
              EUR/L, zużycie {String(snapshot.config.fuelConsumptionLPer100Km).replace('.', ',')} L/100km, inne{' '}
              {formatEur(snapshot.config.monthlyOverheadEur)}/mies.
            </p>
            <CostBreakdownPanel breakdown={snapshot.breakdown} />
          </td>
        </tr>
      )}
    </>
  )
}
