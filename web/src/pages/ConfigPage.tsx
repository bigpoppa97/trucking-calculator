import { useEffect, useRef, useState } from 'react'
import { parseDecimalInput } from '@domain'
import { api, ApiError } from '../lib/api.js'
import type {
  FleetVariantDto,
  SeenTollSystemDto,
  TollRecalcCandidateDto,
  TollRuleType,
  TollSystemRuleDto,
} from '../lib/types.js'
import { NumberField } from '../components/NumberField.js'
import { formatEur } from '../lib/format.js'

/**
 * Config screen (PRD §5.3, finance): fuel price, consumption, driver rate,
 * monthly overhead + fleet variants CRUD. The 30-day month denominator is a
 * validated business decision and is displayed, not editable.
 */

interface ConfigForm {
  fuelPrice: string
  consumption: string
  driverRate: string
  overhead: string
  monthDays: string
}

export function ConfigPage() {
  const [form, setForm] = useState<ConfigForm | null>(null)
  const [variants, setVariants] = useState<FleetVariantDto[]>([])
  const [tollRules, setTollRules] = useState<TollSystemRuleDto[]>([])
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.getConfig(), api.getFleetVariants(), api.listTollRules()])
      .then(([config, fleetVariants, rules]) => {
        if (cancelled) return
        setForm({
          fuelPrice: String(config.fuelPriceEurPerLitre).replace('.', ','),
          consumption: String(config.fuelConsumptionLPer100Km).replace('.', ','),
          driverRate: String(config.driverDayRateEur).replace('.', ','),
          overhead: String(config.monthlyOverheadEur).replace('.', ','),
          monthDays: String(config.monthDays),
        })
        setVariants(fleetVariants)
        setTollRules(rules)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessage({
            kind: 'error',
            text: error instanceof ApiError ? error.message : 'Nie udało się wczytać konfiguracji.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    if (form === null) return
    setMessage(null)
    const fuelPrice = parseDecimalInput(form.fuelPrice)
    const consumption = parseDecimalInput(form.consumption)
    const driverRate = parseDecimalInput(form.driverRate)
    const overhead = parseDecimalInput(form.overhead)
    const monthDays = parseDecimalInput(form.monthDays)
    if (
      fuelPrice === null || fuelPrice <= 0 ||
      consumption === null || consumption <= 0 ||
      driverRate === null || driverRate < 0 ||
      overhead === null || overhead < 0
    ) {
      setMessage({ kind: 'error', text: 'Popraw wartości — wszystkie pola muszą być liczbami dodatnimi.' })
      return
    }
    if (monthDays === null || !Number.isInteger(monthDays) || monthDays < 1 || monthDays > 31) {
      setMessage({ kind: 'error', text: 'Dni w miesiącu (mianownik) muszą być liczbą całkowitą od 1 do 31.' })
      return
    }
    setBusy(true)
    try {
      await api.updateConfig({
        fuelPriceEurPerLitre: fuelPrice,
        fuelConsumptionLPer100Km: consumption,
        driverDayRateEur: driverRate,
        monthlyOverheadEur: overhead,
        monthDays,
      })
      setMessage({ kind: 'ok', text: 'Konfiguracja zapisana. Nowe kalkulacje użyją nowych wartości.' })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof ApiError ? error.message : 'Nie udało się zapisać.' })
    } finally {
      setBusy(false)
    }
  }

  if (form === null && message === null) return <p className="p-6 text-sm text-slate-500">Wczytywanie…</p>

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      {message !== null && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`rounded px-4 py-3 text-sm ${
            message.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-800'
          }`}
        >
          {message.text}
        </p>
      )}

      {form !== null && (
        <section aria-label="Parametry kosztowe" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-base font-semibold text-slate-800">Parametry kosztowe</h2>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Cena paliwa (EUR/L)"
              value={form.fuelPrice}
              onChange={fuelPrice => setForm(f => (f === null ? f : { ...f, fuelPrice }))}
            />
            <NumberField
              label="Zużycie paliwa (L/100 km)"
              value={form.consumption}
              onChange={consumption => setForm(f => (f === null ? f : { ...f, consumption }))}
            />
            <NumberField
              label="Stawka kierowcy (EUR/dzień)"
              value={form.driverRate}
              onChange={driverRate => setForm(f => (f === null ? f : { ...f, driverRate }))}
            />
            <NumberField
              label="Inne koszty miesięczne (EUR)"
              value={form.overhead}
              onChange={overhead => setForm(f => (f === null ? f : { ...f, overhead }))}
            />
            <NumberField
              label="Dni w miesiącu (mianownik)"
              value={form.monthDays}
              onChange={monthDays => setForm(f => (f === null ? f : { ...f, monthDays }))}
            />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Mianownik dzieli miesięczne koszty taboru i koszty stałe (koszt = dni zlecenia / mianownik × koszt
            miesięczny). Mniejsza wartość = wyższy koszt na zlecenie. Zapisane kalkulacje pozostają zamrożone.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="mt-3 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            Zapisz konfigurację
          </button>
        </section>
      )}

      <VariantsSection variants={variants} onChanged={setVariants} onMessage={setMessage} />

      <TollRulesSection rules={tollRules} onChanged={setTollRules} onMessage={setMessage} />

      {/* Re-reads the candidates whenever the rules change. */}
      <BulkRecalcSection
        rulesVersion={JSON.stringify(tollRules)}
        // "Ostatnio zastosowana" changes during a bulk run — reload the rules afterwards.
        onFinished={() => {
          api.listTollRules().then(setTollRules, () => undefined)
        }}
      />
    </div>
  )
}

function VariantsSection({
  variants,
  onChanged,
  onMessage,
}: {
  variants: FleetVariantDto[]
  onChanged: (variants: FleetVariantDto[]) => void
  onMessage: (message: { kind: 'ok' | 'error'; text: string }) => void
}) {
  const [newName, setNewName] = useState('')
  const [newCost, setNewCost] = useState('')

  const addVariant = async () => {
    const cost = parseDecimalInput(newCost)
    if (newName.trim() === '' || cost === null || cost < 0) {
      onMessage({ kind: 'error', text: 'Podaj nazwę wariantu i prawidłowy koszt miesięczny.' })
      return
    }
    try {
      onChanged(await api.createVariant(newName.trim(), cost))
      setNewName('')
      setNewCost('')
      onMessage({ kind: 'ok', text: 'Wariant zapisany.' })
    } catch (error) {
      onMessage({ kind: 'error', text: error instanceof ApiError ? error.message : 'Nie udało się zapisać wariantu.' })
    }
  }

  const toggleActive = async (variant: FleetVariantDto) => {
    try {
      onChanged(await api.patchVariant(variant.id, { active: !variant.active }))
    } catch (error) {
      onMessage({ kind: 'error', text: error instanceof ApiError ? error.message : 'Nie udało się zmienić wariantu.' })
    }
  }

  return (
    <section aria-label="Warianty taboru" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-base font-semibold text-slate-800">Warianty taboru</h2>
      <table className="mb-3 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
            <th className="py-1.5 pr-2 font-medium">Nazwa</th>
            <th className="py-1.5 pr-2 font-medium">Koszt/mies.</th>
            <th className="py-1.5 font-medium">Aktywny</th>
          </tr>
        </thead>
        <tbody>
          {variants.map(variant => (
            <tr key={variant.id} className="border-b border-slate-100">
              <td className="py-1.5 pr-2 font-medium text-slate-700">{variant.name}</td>
              <td className="py-1.5 pr-2 tabular-nums">{formatEur(variant.monthlyCostEur)}</td>
              <td className="py-1.5">
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={variant.active}
                    onChange={() => void toggleActive(variant)}
                    aria-label={`Aktywny: ${variant.name}`}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  {variant.active ? 'aktywny' : 'nieaktywny'}
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="new-variant-name" className="text-xs font-medium text-slate-600">
            Nowy wariant
          </label>
          <input
            id="new-variant-name"
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="np. mega FRIGO"
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-variant-cost" className="text-xs font-medium text-slate-600">
            Koszt/mies. (EUR)
          </label>
          <input
            id="new-variant-cost"
            type="text"
            inputMode="decimal"
            value={newCost}
            onChange={e => setNewCost(e.target.value)}
            placeholder="np. 4800"
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => void addVariant()}
          className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700"
        >
          Dodaj wariant
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Nazwa istniejącego wariantu aktualizuje jego koszt. Wariantów nie usuwa się — dezaktywuj, aby ukryć w
        kalkulatorze (historia kalkulacji pozostaje nienaruszona).
      </p>
    </section>
  )
}

const RULE_TYPE_LABELS: Record<TollRuleType, string> = {
  replace_per_gate: 'cena za bramkę (waluta oryginalna)',
  scale: 'mnożnik',
}

function TollRulesSection({
  rules,
  onChanged,
  onMessage,
}: {
  rules: TollSystemRuleDto[]
  onChanged: (rules: TollSystemRuleDto[]) => void
  onMessage: (message: { kind: 'ok' | 'error'; text: string }) => void
}) {
  const [system, setSystem] = useState('')
  const [gateFilter, setGateFilter] = useState('')
  const [ruleType, setRuleType] = useState<TollRuleType>('replace_per_gate')
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const [seen, setSeen] = useState<SeenTollSystemDto[]>([])

  // Real system / gate names from stored routes — reloaded with the rules.
  useEffect(() => {
    let cancelled = false
    api
      .listSeenTollSystems()
      .then(list => {
        if (!cancelled) setSeen(list)
      })
      .catch(() => {
        // suggestions only — the form works without them
      })
    return () => {
      cancelled = true
    }
  }, [rules])

  const addRule = async () => {
    const parsed = parseDecimalInput(value)
    if (system.trim() === '' || parsed === null || parsed <= 0) {
      onMessage({ kind: 'error', text: 'Podaj nazwę systemu poboru opłat i dodatnią wartość reguły.' })
      return
    }
    try {
      onChanged(
        await api.upsertTollRule({
          tollSystem: system.trim(),
          ...(gateFilter.trim() !== '' ? { gateFilter: gateFilter.trim() } : {}),
          ruleType,
          value: parsed,
          ...(note.trim() !== '' ? { note: note.trim() } : {}),
        }),
      )
      setSystem('')
      setGateFilter('')
      setValue('')
      setNote('')
      onMessage({
        kind: 'ok',
        text: 'Reguła zapisana. Działa przy kolejnych pobraniach z HERE — zapisane trasy przelicz niżej („Przeliczanie szacunków opłat”).',
      })
    } catch (error) {
      onMessage({ kind: 'error', text: error instanceof ApiError ? error.message : 'Nie udało się zapisać reguły.' })
    }
  }

  const removeRule = async (rule: TollSystemRuleDto) => {
    try {
      onChanged(await api.deleteTollRule(rule.id))
      onMessage({ kind: 'ok', text: `Reguła dla '${ruleLabel(rule)}' usunięta.` })
    } catch (error) {
      onMessage({ kind: 'error', text: error instanceof ApiError ? error.message : 'Nie udało się usunąć reguły.' })
    }
  }

  return (
    <section aria-label="Korekty systemów poboru opłat" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-1 text-base font-semibold text-slate-800">Korekty systemów poboru opłat</h2>
      <p className="mb-3 text-xs text-slate-500">
        HERE potrafi zwrócić stawkę dla złej kategorii pojazdu (np. prywatna A2 liczona jak pojazd ponadnormatywny).
        Reguła koryguje szacunek przy pobraniu trasy — wartość nadal pozostaje szacunkiem do weryfikacji.
      </p>

      {rules.length === 0 ? (
        <p className="mb-3 text-sm text-slate-500">Brak reguł.</p>
      ) : (
        <table className="mb-3 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
              <th className="py-1.5 pr-2 font-medium">System poboru</th>
              <th className="py-1.5 pr-2 font-medium">Typ reguły</th>
              <th className="py-1.5 pr-2 font-medium">Wartość</th>
              <th className="py-1.5 pr-2 font-medium">Ostatnio zastosowana</th>
              <th className="py-1.5 pr-2 font-medium">Notatka</th>
              <th className="py-1.5 font-medium">Akcja</th>
            </tr>
          </thead>
          <tbody>
            {rules.map(rule => (
              <tr key={rule.id} className="border-b border-slate-100">
                <td className="py-1.5 pr-2 font-medium text-slate-700">
                  {rule.tollSystem}
                  {(rule.gateFilter ?? '') !== '' && (
                    <div className="text-xs font-normal text-slate-500">tylko bramki „{rule.gateFilter}”</div>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-xs">{RULE_TYPE_LABELS[rule.ruleType]}</td>
                <td className="py-1.5 pr-2 tabular-nums">{String(rule.value).replace('.', ',')}</td>
                <td className="py-1.5 pr-2 text-xs">
                  {rule.lastMatchedAt === undefined ? (
                    '—'
                  ) : rule.lastMatchedAt === null ? (
                    <span
                      className="text-orange-700"
                      title="Żadne pobranie z HERE nie trafiło w tę nazwę systemu — sprawdź pisownię w „Systemy poboru zwrócone przez HERE”"
                    >
                      nigdy
                    </span>
                  ) : (
                    new Date(rule.lastMatchedAt).toLocaleDateString('pl-PL')
                  )}
                </td>
                <td className="py-1.5 pr-2 text-xs text-slate-500">{rule.note ?? '—'}</td>
                <td className="py-1.5">
                  <button
                    type="button"
                    onClick={() => void removeRule(rule)}
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

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <div className="flex flex-col gap-1">
          <label htmlFor="rule-system" className="text-xs font-medium text-slate-600">
            System poboru (nazwa z HERE)
          </label>
          <input
            id="rule-system"
            type="text"
            list="rule-system-seen"
            value={system}
            onChange={e => setSystem(e.target.value)}
            placeholder="np. A2 AUTOSTRADA WIELKOPOLSKA"
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
          <datalist id="rule-system-seen">
            {[...new Set(seen.map(s => s.tollSystem))].map(name => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="rule-gate" className="text-xs font-medium text-slate-600">
            Tylko bramki zawierające (opcjonalnie)
          </label>
          <input
            id="rule-gate"
            type="text"
            value={gateFilter}
            onChange={e => setGateFilter(e.target.value)}
            placeholder="np. Świecko — puste = cały system"
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="rule-type" className="text-xs font-medium text-slate-600">
            Typ reguły
          </label>
          <select
            id="rule-type"
            value={ruleType}
            onChange={e => setRuleType(e.target.value as TollRuleType)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            {(Object.keys(RULE_TYPE_LABELS) as TollRuleType[]).map(t => (
              <option key={t} value={t}>
                {RULE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="rule-value" className="text-xs font-medium text-slate-600">
            Wartość
          </label>
          <input
            id="rule-value"
            type="text"
            inputMode="decimal"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="np. 105"
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="rule-note" className="text-xs font-medium text-slate-600">
            Notatka
          </label>
          <input
            id="rule-note"
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="np. AWSA kat. 4, cennik 2026-03"
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
      </div>
      <button
        type="button"
        onClick={() => void addRule()}
        className="mt-2 rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700"
      >
        Zapisz regułę
      </button>
      <p className="mt-2 text-xs text-slate-500">
        Ta sama nazwa systemu (i te same bramki) nadpisuje regułę. Nazwa musi być dokładnie taka jak w HERE (wielkość
        liter i polskie znaki bez znaczenia) — wybierz ją z listy poniżej. Reguła z bramkami ma pierwszeństwo przed regułą
        dla całego systemu. Dla typu „cena za bramkę" podaj cenę w walucie oryginalnej opłaty (np. PLN) — przeliczenie na
        EUR używa kursu z danych HERE.
      </p>

      <SeenSystemsList
        seen={seen}
        rules={rules}
        onPick={(name, gate) => {
          setSystem(name)
          setGateFilter(gate)
        }}
      />
    </section>
  )
}

function ruleLabel(rule: Pick<TollSystemRuleDto, 'tollSystem' | 'gateFilter'>): string {
  return (rule.gateFilter ?? '') === '' ? rule.tollSystem : `${rule.tollSystem} · bramki „${rule.gateFilter}”`
}

const normalizeName = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()

/** Toll systems HERE returned on stored routes — exact names and gates for a rule. */
function SeenSystemsList({
  seen,
  rules,
  onPick,
}: {
  seen: SeenTollSystemDto[]
  rules: TollSystemRuleDto[]
  onPick: (tollSystem: string, gateFilter: string) => void
}) {
  if (seen.length === 0) {
    return (
      <p className="mt-3 text-xs text-slate-500">
        Systemy poboru zwrócone przez HERE pojawią się tu po przeliczeniu opłat tras (sekcja niżej).
      </p>
    )
  }
  return (
    <details className="mt-3 text-xs text-slate-600">
      <summary className="cursor-pointer select-none font-medium text-slate-700">
        Systemy poboru zwrócone przez HERE na zapisanych trasach ({seen.length})
      </summary>
      <table className="mt-1 w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left uppercase text-slate-500">
            <th className="py-1 pr-2 font-medium">Kraj</th>
            <th className="py-1 pr-2 font-medium">System poboru</th>
            <th className="py-1 pr-2 font-medium">Bramki</th>
            <th className="py-1 pr-2 font-medium">Trasy</th>
            <th className="py-1 font-medium">Reguła</th>
          </tr>
        </thead>
        <tbody>
          {seen.map(s => {
            const hasRule = rules.some(r => normalizeName(r.tollSystem) === normalizeName(s.tollSystem))
            return (
              <tr key={`${s.country}|${s.tollSystem}`} className="border-b border-slate-100 align-top">
                <td className="py-1 pr-2">{s.country}</td>
                <td className="py-1 pr-2 font-mono text-[11px] text-slate-800">{s.tollSystem || '(bez nazwy)'}</td>
                <td className="py-1 pr-2">
                  {s.gates.length === 0 ? (
                    <span className="text-slate-400">HERE nie podał nazw</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {s.gates.slice(0, 12).map(gate => (
                        <button
                          key={gate}
                          type="button"
                          title="Wstaw system i tę bramkę do formularza reguły"
                          onClick={() => onPick(s.tollSystem, gate)}
                          className="rounded border border-slate-200 bg-white px-1.5 py-0.5 hover:bg-sky-50"
                        >
                          {gate}
                        </button>
                      ))}
                    </span>
                  )}
                </td>
                <td className="py-1 pr-2 tabular-nums">{s.routes}</td>
                <td className="py-1">
                  {hasRule ? (
                    <span className="text-green-700">jest</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onPick(s.tollSystem, '')}
                      className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-50"
                    >
                      Użyj nazwy
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </details>
  )
}

const REASON_LABELS: Record<TollRecalcCandidateDto['reason'], string> = {
  'never-checked': 'jeszcze nie sprawdzane',
  'rules-changed': 'reguły zmieniły się od ostatniego przeliczenia',
  'up-to-date': 'aktualne',
}

type BulkState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }
  | { kind: 'running'; done: number; total: number; failed: string[]; warned: string[] }
  | { kind: 'finished'; done: number; failed: string[]; warned: string[]; stopped: boolean }

/**
 * Bulk "Przelicz szacunki" after a rule change: routes whose last toll check
 * predates the current rules (or never ran) are recalculated one request at
 * a time from the browser — progress visible, no long-running server call.
 */
function BulkRecalcSection({ rulesVersion, onFinished }: { rulesVersion: string; onFinished?: () => void }) {
  const [candidates, setCandidates] = useState<TollRecalcCandidateDto[]>([])
  const [state, setState] = useState<BulkState>({ kind: 'loading' })
  const [stopRequested, setStopRequested] = useState(false)
  const stopRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    api
      .listTollRecalcCandidates()
      .then(list => {
        if (cancelled) return
        setCandidates(list)
        setState(prev => (prev.kind === 'running' || prev.kind === 'finished' ? prev : { kind: 'ready' }))
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ kind: 'error', message: error instanceof ApiError ? error.message : 'Nie udało się wczytać listy tras.' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [rulesVersion])

  const stale = candidates.filter(c => c.reason !== 'up-to-date')
  const byReason = (reason: TollRecalcCandidateDto['reason']) => candidates.filter(c => c.reason === reason).length

  const run = async (routeCodes: string[]) => {
    stopRef.current = false
    setStopRequested(false)
    const failed: string[] = []
    const warned: string[] = []
    let consecutiveFailures = 0
    let done = 0
    setState({ kind: 'running', done, total: routeCodes.length, failed, warned })
    for (const code of routeCodes) {
      if (stopRef.current) break
      try {
        const result = await api.recalculateTolls(code)
        consecutiveFailures = 0
        if (result.summary.tollCheck.warnings.length > 0) warned.push(code)
      } catch {
        failed.push(code)
        consecutiveFailures += 1
      }
      done += 1
      setState({ kind: 'running', done, total: routeCodes.length, failed: [...failed], warned: [...warned] })
      // HERE down or quota exhausted — stop instead of burning through the list.
      if (consecutiveFailures >= 3) {
        stopRef.current = true
      }
    }
    setState({ kind: 'finished', done, failed, warned, stopped: stopRef.current })
    onFinished?.()
    try {
      setCandidates(await api.listTollRecalcCandidates())
    } catch {
      // the summary above is what matters; the counts refresh on the next visit
    }
  }

  return (
    <section aria-label="Przeliczanie szacunków opłat" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-1 text-base font-semibold text-slate-800">Przeliczanie szacunków opłat</h2>
      <p className="mb-3 text-xs text-slate-500">
        Po zmianie reguły zapisane trasy mają nadal stare szacunki. Przeliczenie: jedno zapytanie do HERE na trasę, szacunki
        nadpisane nowymi wartościami, opłaty zweryfikowane i km bez zmian.
      </p>

      {state.kind === 'loading' && <p className="text-sm text-slate-500">Sprawdzam trasy…</p>}
      {state.kind === 'error' && (
        <p role="alert" className="text-sm text-red-700">
          {state.message}
        </p>
      )}

      {(state.kind === 'ready' || state.kind === 'finished') && (
        <div className="space-y-2 text-sm">
          <ul className="text-xs text-slate-600">
            <li>
              {REASON_LABELS['rules-changed']}: <strong>{byReason('rules-changed')}</strong>
            </li>
            <li>
              {REASON_LABELS['never-checked']}: <strong>{byReason('never-checked')}</strong>
            </li>
            <li>
              {REASON_LABELS['up-to-date']}: <strong>{byReason('up-to-date')}</strong>
            </li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={stale.length === 0}
              onClick={() => void run(stale.map(c => c.routeCode))}
              className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              Przelicz nieaktualne ({stale.length} {stale.length === 1 ? 'zapytanie' : 'zapytań'} do HERE)
            </button>
            {candidates.length > stale.length && (
              <button
                type="button"
                onClick={() => void run(candidates.map(c => c.routeCode))}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                Przelicz wszystkie z szacunkami ({candidates.length})
              </button>
            )}
          </div>
        </div>
      )}

      {state.kind === 'running' && (
        <div className="space-y-2 text-sm" aria-live="polite">
          <p>
            Przeliczam… {state.done}/{state.total}
            {state.failed.length > 0 && <span className="text-red-700"> · błędy: {state.failed.length}</span>}
          </p>
          <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
            <div className="h-2 bg-sky-500" style={{ width: `${(state.done / Math.max(state.total, 1)) * 100}%` }} />
          </div>
          <button
            type="button"
            disabled={stopRequested}
            onClick={() => {
              stopRef.current = true
              setStopRequested(true)
            }}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {stopRequested ? 'Zatrzymuję…' : 'Zatrzymaj'}
          </button>
        </div>
      )}

      {state.kind === 'finished' && (
        <div className="mt-3 space-y-1 rounded border border-slate-200 bg-slate-50 p-3 text-xs" aria-live="polite">
          <p className="font-medium text-slate-800">
            Przeliczono {state.done - state.failed.length} {state.stopped ? '(przerwano)' : ''} ✓
          </p>
          {state.warned.length > 0 && (
            <p className="text-amber-800">
              Z uwagami do opłat ({state.warned.length}): {state.warned.join(', ')} — szczegóły w Bazie tras.
            </p>
          )}
          {state.failed.length > 0 && (
            <p className="text-red-700">
              Nie udało się ({state.failed.length}): {state.failed.join(', ')}
              {state.stopped && ' — przerwano po kolejnych błędach (HERE niedostępny?). Spróbuj później.'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
