import { useState } from 'react'
import { api, ApiError } from '../lib/api.js'
import { formatEur, formatKm } from '../lib/format.js'
import type { RouteDetailsDto, TollCheckDto, TollItemDto, TollRecalcChangeDto, TollRecalcResultDto } from '../lib/types.js'

/**
 * Toll checks in the UI (27.10.2026):
 * - TollCheckWarnings: PL systems outside e-TOLL without a correction rule,
 *   and tolls per km far from the company's own routes (backend tollChecks.ts).
 * - TollCheckDetails: what HERE actually returned, per toll system — the place
 *   to read exact system and gate names for a correction rule.
 * - RecalcTollsPanel: "Przelicz opłaty z HERE" for a stored route — estimates
 *   replaced with the current HERE value after the rules; verified values and
 *   km stay (enforced by the backend).
 */

const formatDateTime = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const formatOriginal = (value: number, currency: string): string =>
  `${new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 }).format(value)} ${currency}`

export function TollCheckWarnings({ warnings, className = '' }: { warnings: string[]; className?: string }) {
  if (warnings.length === 0) return null
  return (
    <ul
      aria-label="Uwagi do opłat"
      className={`space-y-1 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 ${className}`}
    >
      {warnings.map(w => (
        <li key={w}>⚠️ {w}</li>
      ))}
    </ul>
  )
}

interface TollGroup {
  country: string
  tollSystem: string
  ruleId: number | null
  ruleApplied: boolean
  count: number
  hereEur: number
  finalEur: number
  gates: string[]
  prices: string[]
  coords: string[]
}

/** One row per country + system + rule — a gate rule shows as its own row. */
export function groupTollItems(items: TollItemDto[]): TollGroup[] {
  const groups = new Map<string, TollGroup>()
  for (const item of items) {
    const key = `${item.country}|${item.tollSystem}|${item.ruleId ?? '-'}`
    const group = groups.get(key) ?? {
      country: item.country,
      tollSystem: item.tollSystem,
      ruleId: item.ruleId,
      ruleApplied: false,
      count: 0,
      hereEur: 0,
      finalEur: 0,
      gates: [],
      prices: [],
      coords: [],
    }
    group.count += 1
    group.hereEur += item.hereEur
    group.finalEur += item.finalEur
    group.ruleApplied ||= item.ruleApplied
    for (const gate of item.gates) if (!group.gates.includes(gate)) group.gates.push(gate)
    for (const coord of item.gateCoords) if (!group.coords.includes(coord)) group.coords.push(coord)
    if (item.originalPrice !== null && item.originalCurrency !== null) {
      const price = formatOriginal(item.originalPrice, item.originalCurrency)
      if (!group.prices.includes(price)) group.prices.push(price)
    }
    groups.set(key, group)
  }
  return [...groups.values()]
}

export function TollCheckDetails({ check, open = false }: { check: TollCheckDto; open?: boolean }) {
  const groups = groupTollItems(check.items)
  return (
    <details open={open} className="text-xs text-slate-600">
      <summary className="cursor-pointer select-none text-slate-700">
        Szczegóły opłat z HERE ({groups.length} {groups.length === 1 ? 'pozycja' : 'pozycji'}) · sprawdzono{' '}
        {formatDateTime(check.checkedAt)}
      </summary>
      {groups.length === 0 ? (
        <p className="mt-1">HERE nie zwrócił żadnych opłat dla tej trasy.</p>
      ) : (
        // A list, not a table: the panel sits in the narrow column next to the map.
        <ul className="mt-1 divide-y divide-slate-200 rounded border border-slate-200 bg-white">
          {groups.map(g => (
            <li key={`${g.country}|${g.tollSystem}|${g.ruleId ?? '-'}`} className="space-y-0.5 px-2 py-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span>
                  <span className="font-medium">{g.country}</span>{' '}
                  <span className="select-all font-mono text-[11px] text-slate-800">{g.tollSystem || '(bez nazwy)'}</span>
                  <span className="text-slate-400"> · {g.count}×</span>
                </span>
                <span className="tabular-nums">
                  {g.ruleId !== null && g.ruleApplied ? (
                    <>
                      <span className="text-slate-400 line-through">{formatEur(g.hereEur)}</span>{' '}
                      <span className="font-medium">{formatEur(g.finalEur)}</span>
                    </>
                  ) : (
                    <span className="font-medium">{formatEur(g.finalEur)}</span>
                  )}
                </span>
              </div>
              <div className="text-slate-500">
                {g.gates.length > 0 ? (
                  <>
                    Bramki: {g.gates.slice(0, 6).join(', ')}
                    {g.gates.length > 6 && ` +${g.gates.length - 6}`}
                  </>
                ) : g.coords.length > 0 ? (
                  <>Bramki (współrzędne): {g.coords.slice(0, 3).join(' · ')}</>
                ) : (
                  'HERE nie podał nazw bramek'
                )}
                {g.prices.length > 0 && <> · cena: {g.prices.slice(0, 4).join(', ')}</>}
              </div>
              <div>
                {g.ruleId === null ? (
                  <span className="text-slate-400">bez reguły korekty</span>
                ) : g.ruleApplied ? (
                  <span className="text-green-700">reguła korekty zastosowana</span>
                ) : (
                  <span className="text-orange-700">reguła pasuje, ale nie dało się jej zastosować (brak ceny oryginalnej)</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

const OUTCOME_LABELS: Record<TollRecalcChangeDto['outcome'], { text: string; className: string }> = {
  updated: { text: 'zaktualizowano (szacunek)', className: 'text-sky-700' },
  unchanged: { text: 'bez zmian', className: 'text-slate-500' },
  added: { text: 'dodano (szacunek)', className: 'text-sky-700' },
  'kept-verified': { text: 'zweryfikowana — bez zmian', className: 'text-green-700' },
  'no-here-value': { text: 'HERE bez opłaty — zostaje stara', className: 'text-orange-700' },
  pending: { text: 'brak opłaty', className: 'text-orange-700' },
}

/** Recalculation makes sense only where something is not verified yet. */
export function canRecalculate(route: Pick<RouteDetailsDto, 'tolls' | 'tollsPendingCountries'>): boolean {
  return route.tolls.some(t => t.status === 'estimate') || route.tollsPendingCountries.length > 0
}

type RecalcState =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'busy' }
  | { kind: 'done'; result: TollRecalcResultDto['summary'] }
  | { kind: 'error'; message: string }

export function RecalcTollsPanel({
  route,
  onRecalculated,
  className = 'mt-3',
}: {
  route: RouteDetailsDto
  onRecalculated: (route: RouteDetailsDto) => void | Promise<void>
  className?: string
}) {
  const [state, setState] = useState<RecalcState>({ kind: 'idle' })
  const check = route.tollCheck ?? null
  const recalculable = canRecalculate(route)
  if (!recalculable && check === null && state.kind !== 'done') return null

  const run = async () => {
    setState({ kind: 'busy' })
    try {
      const result = await api.recalculateTolls(route.routeCode)
      setState({ kind: 'done', result: result.summary })
      await onRecalculated(result.route)
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'Nie udało się przeliczyć opłat. Spróbuj ponownie.',
      })
    }
  }

  return (
    <div
      role="group"
      aria-label="Przeliczanie opłat z HERE"
      className={`${className} space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700`}
    >
      {state.kind === 'done' ? (
        <RecalcSummary summary={state.result} />
      ) : (
        <>
          {check !== null && <TollCheckDetails check={check} />}
          {check === null && recalculable && (
            <p className="text-slate-500">
              Ta trasa nie była jeszcze sprawdzana po nowemu — przelicz, żeby zobaczyć szczegóły opłat i ostrzeżenia.
            </p>
          )}
          {state.kind === 'error' && (
            <p role="alert" className="text-red-700">
              {state.message}
            </p>
          )}
          {recalculable && state.kind !== 'confirm' && (
            <button
              type="button"
              disabled={state.kind === 'busy'}
              onClick={() => setState({ kind: 'confirm' })}
              className="rounded-md border border-sky-600 bg-white px-3 py-1.5 font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50"
            >
              {state.kind === 'busy' ? 'Przeliczam…' : 'Przelicz opłaty z HERE'}
            </button>
          )}
          {state.kind === 'confirm' && (
            <div className="space-y-2">
              <p>
                Jedno zapytanie do HERE z aktualnymi regułami korekty. Szacunki opłat zostaną nadpisane nowymi wartościami,
                brakujące opłaty — dopisane. Opłaty zweryfikowane i km trasy ({formatKm(route.totalKm)}) zostaną bez zmian.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void run()}
                  className="rounded-md bg-sky-600 px-3 py-1.5 font-medium text-white hover:bg-sky-700"
                >
                  Przelicz
                </button>
                <button
                  type="button"
                  onClick={() => setState({ kind: 'idle' })}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                >
                  Anuluj
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function RecalcSummary({ summary }: { summary: TollRecalcResultDto['summary'] }) {
  return (
    <div aria-live="polite" className="space-y-2">
      <p className="font-medium text-slate-800">Opłaty przeliczone z HERE ✓</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left uppercase text-slate-500">
            <th className="py-1 pr-2 font-medium">Kraj</th>
            <th className="py-1 pr-2 text-right font-medium">Było</th>
            <th className="py-1 pr-2 text-right font-medium">HERE teraz</th>
            <th className="py-1 font-medium">Wynik</th>
          </tr>
        </thead>
        <tbody>
          {summary.changes.map(c => (
            <tr key={c.country} className="border-b border-slate-100">
              <td className="py-1 pr-2 font-medium">{c.country}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{c.beforeEur === null ? '—' : formatEur(c.beforeEur)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{c.hereEur === null ? '—' : formatEur(c.hereEur)}</td>
              <td className={`py-1 ${OUTCOME_LABELS[c.outcome].className}`}>{OUTCOME_LABELS[c.outcome].text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* The check's warnings show with the route itself (route panel / route DB), not twice. */}
      {summary.tollCheck.warnings.length > 0 && (
        <p className="text-amber-800">⚠️ Uwagi do opłat: {summary.tollCheck.warnings.length} — opisane przy trasie.</p>
      )}
      <TollCheckDetails check={summary.tollCheck} />
      <p className="text-slate-500">Trasa wg HERE: {formatKm(summary.hereTotalKm)} (km w bazie bez zmian).</p>
      {summary.warnings.length > 0 && (
        <details className="text-slate-500">
          <summary className="cursor-pointer">Uwagi techniczne HERE ({summary.warnings.length})</summary>
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
