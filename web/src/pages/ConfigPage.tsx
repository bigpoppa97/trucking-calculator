import { useEffect, useState } from 'react'
import { parseDecimalInput } from '@domain'
import { api, ApiError } from '../lib/api.js'
import type { FleetVariantDto } from '../lib/types.js'
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
}

export function ConfigPage() {
  const [form, setForm] = useState<ConfigForm | null>(null)
  const [variants, setVariants] = useState<FleetVariantDto[]>([])
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.getConfig(), api.getFleetVariants()])
      .then(([config, fleetVariants]) => {
        if (cancelled) return
        setForm({
          fuelPrice: String(config.fuelPriceEurPerLitre).replace('.', ','),
          consumption: String(config.fuelConsumptionLPer100Km).replace('.', ','),
          driverRate: String(config.driverDayRateEur).replace('.', ','),
          overhead: String(config.monthlyOverheadEur).replace('.', ','),
        })
        setVariants(fleetVariants)
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
    if (
      fuelPrice === null || fuelPrice <= 0 ||
      consumption === null || consumption <= 0 ||
      driverRate === null || driverRate < 0 ||
      overhead === null || overhead < 0
    ) {
      setMessage({ kind: 'error', text: 'Popraw wartości — wszystkie pola muszą być liczbami dodatnimi.' })
      return
    }
    setBusy(true)
    try {
      await api.updateConfig({
        fuelPriceEurPerLitre: fuelPrice,
        fuelConsumptionLPer100Km: consumption,
        driverDayRateEur: driverRate,
        monthlyOverheadEur: overhead,
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
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Dni w miesiącu (denominator): <strong>30</strong> — stała wartość, decyzja biznesowa, nieedytowalna.
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
