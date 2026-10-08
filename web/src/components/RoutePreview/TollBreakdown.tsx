import type { ReactNode } from 'react'
import type { TollStatus } from '@domain'
import { formatEur, formatKm } from '../../lib/format.js'

/**
 * Right panel of the route preview: per-country highway costs with flags,
 * driven-order rows and a total. Display-only.
 */

const FLAGS: Record<string, string> = {
  PL: '🇵🇱', DE: '🇩🇪', CZ: '🇨🇿', SK: '🇸🇰', HU: '🇭🇺',
  AT: '🇦🇹', EE: '🇪🇪', LV: '🇱🇻', LT: '🇱🇹',
  FR: '🇫🇷', NL: '🇳🇱', BE: '🇧🇪', CH: '🇨🇭', ES: '🇪🇸',
  IT: '🇮🇹', RO: '🇷🇴', HR: '🇭🇷', SI: '🇸🇮', BG: '🇧🇬',
  RS: '🇷🇸', SE: '🇸🇪', DK: '🇩🇰', NO: '🇳🇴', FI: '🇫🇮',
  GB: '🇬🇧', IE: '🇮🇪', PT: '🇵🇹', GR: '🇬🇷', UA: '🇺🇦',
}

const NAMES_PL: Record<string, string> = {
  PL: 'Polska', DE: 'Niemcy', CZ: 'Czechy', SK: 'Słowacja', HU: 'Węgry',
  AT: 'Austria', EE: 'Estonia', LV: 'Łotwa', LT: 'Litwa',
  FR: 'Francja', NL: 'Holandia', BE: 'Belgia', CH: 'Szwajcaria', ES: 'Hiszpania',
  IT: 'Włochy', RO: 'Rumunia', HR: 'Chorwacja', SI: 'Słowenia', BG: 'Bułgaria',
  RS: 'Serbia', SE: 'Szwecja', DK: 'Dania', NO: 'Norwegia', FI: 'Finlandia',
  GB: 'Wielka Brytania', IE: 'Irlandia', PT: 'Portugalia', GR: 'Grecja', UA: 'Ukraina',
}

export interface TollBreakdownRow {
  country: string
  km: number | null
  tollEur: number | null
  status: TollStatus | null
}

export function TollBreakdown({ rows, footer }: { rows: TollBreakdownRow[]; footer?: ReactNode }) {
  const total = rows.reduce((sum, row) => sum + (row.tollEur ?? 0), 0)
  const totalKm = rows.reduce((sum, row) => sum + (row.km ?? 0), 0)

  return (
    <section aria-label="Autostrady — podział na kraje" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-slate-800">Autostrady</h3>
        <span className="text-base font-bold text-slate-900">{formatEur(total)}</span>
      </div>

      <ul className="space-y-1.5">
        {rows.map(row => (
          <li key={row.country} className="flex items-center gap-2 text-sm">
            <span aria-hidden="true">{FLAGS[row.country] ?? '🏳️'}</span>
            <span className="text-slate-700">{NAMES_PL[row.country] ?? row.country}</span>
            <span className="ml-auto whitespace-nowrap tabular-nums text-xs text-slate-400">
              {row.km === null ? '' : formatKm(row.km)}
            </span>
            <span className="w-20 text-right tabular-nums font-semibold text-slate-800">
              {row.tollEur === null || row.status === 'missing' ? (
                <span className="font-normal text-slate-400">—</span>
              ) : (
                formatEur(row.tollEur)
              )}
            </span>
            {row.status === 'estimate' && (
              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">szacunek</span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-200 pt-2 text-sm">
        <span className="font-medium text-slate-700">Razem</span>
        <span className="ml-auto whitespace-nowrap tabular-nums text-xs text-slate-400">{formatKm(totalKm)}</span>
        <span className="w-20 text-right tabular-nums font-bold text-slate-900">{formatEur(total)}</span>
      </div>
      {footer}
    </section>
  )
}
