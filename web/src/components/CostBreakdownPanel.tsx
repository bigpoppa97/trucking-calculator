import type { CostBreakdown } from '@domain'
import { formatEur, formatPercent } from '../lib/format.js'

/**
 * Live cost breakdown mirroring the validated sheet layout (PRD §5.3):
 * one row per §2.1 component, total, optional P&L. Estimate-based and
 * missing tolls are flagged visibly (PRD §4.3).
 */
export function CostBreakdownPanel({ breakdown }: { breakdown: CostBreakdown }) {
  const rows: Array<{ label: string; value: number }> = [
    { label: 'Paliwo', value: breakdown.fuelEur },
    { label: 'Autostrady (opłaty)', value: breakdown.highwaysEur },
    { label: 'Tabor', value: breakdown.fleetEur },
    { label: 'Kierowcy', value: breakdown.driversEur },
    { label: 'Inne (koszty stałe)', value: breakdown.overheadEur },
    { label: 'Promy / tunele', value: breakdown.ferriesTunnelsEur },
  ]

  return (
    <section aria-label="Kalkulacja kosztów" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-base font-semibold text-slate-800">Koszty zlecenia</h2>
      <dl className="divide-y divide-slate-100">
        {rows.map(row => (
          <div key={row.label} className="flex items-center justify-between py-1.5">
            <dt className="text-sm text-slate-600">{row.label}</dt>
            <dd className="text-sm font-medium tabular-nums text-slate-800">{formatEur(row.value)}</dd>
          </div>
        ))}
        <div className="flex items-center justify-between py-2">
          <dt className="text-sm font-semibold text-slate-800">Razem (break-even)</dt>
          <dd data-testid="total-cost" className="text-lg font-bold tabular-nums text-slate-900">
            {formatEur(breakdown.totalEur)}
          </dd>
        </div>
      </dl>

      {breakdown.tollWarnings.usesEstimates && (
        <p role="note" className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Opłaty drogowe dla: {breakdown.tollWarnings.estimatedCountries.join(', ')} to szacunki z HERE —
          niezweryfikowane z fakturą.
        </p>
      )}
      {breakdown.tollWarnings.hasMissing && (
        <p role="note" className="mt-2 rounded bg-orange-50 px-3 py-2 text-xs text-orange-800">
          Brak opłat drogowych dla: {breakdown.tollWarnings.missingCountries.join(', ')} — kalkulacja ich nie
          uwzględnia.
        </p>
      )}

      {breakdown.pnl !== null && (
        <div className="mt-4 rounded-md bg-slate-50 p-3">
          <h3 className="mb-2 text-sm font-semibold text-slate-800">Rachunek zysku</h3>
          <dl className="space-y-1">
            <div className="flex justify-between text-sm">
              <dt className="text-slate-600">Przychód</dt>
              <dd className="tabular-nums">{formatEur(breakdown.pnl.revenueEur)}</dd>
            </div>
            <div className="flex justify-between text-sm">
              <dt className="text-slate-600">Zysk</dt>
              <dd
                data-testid="profit"
                className={`font-semibold tabular-nums ${breakdown.pnl.profitEur >= 0 ? 'text-green-700' : 'text-red-700'}`}
              >
                {formatEur(breakdown.pnl.profitEur)}
              </dd>
            </div>
            {breakdown.pnl.marginPct !== null && (
              <div className="flex justify-between text-sm">
                <dt className="text-slate-600">Marża</dt>
                <dd className="tabular-nums">{formatPercent(breakdown.pnl.marginPct)}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </section>
  )
}
