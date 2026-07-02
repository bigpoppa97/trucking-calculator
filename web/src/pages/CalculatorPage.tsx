import { useEffect, useMemo, useState } from 'react'
import {
  calculateOrderCost,
  parseDecimalInput,
  type CalculatorConfig,
  type CostBreakdown,
  type CountryToll,
  type DriverCount,
} from '@domain'
import { api, ApiError } from '../lib/api.js'
import type { AirportDto, FleetVariantDto } from '../lib/types.js'
import { NumberField } from '../components/NumberField.js'
import { CostBreakdownPanel } from '../components/CostBreakdownPanel.js'
import { RoutePanel, type RouteState } from '../components/RoutePanel.js'

/**
 * Calculator screen (PRD §5.3), mirroring the validated sheet layout:
 * route lookup → order inputs → live cost breakdown + optional P&L.
 *
 * STALE-DATA RULE (PRD §5.4): every lookup transition REPLACES the entire
 * route state atomically. All derived values (km, tolls, breakdown) render
 * exclusively from that state, so a not-found or error result structurally
 * cannot leave old toll values on screen (the v1 stale-toll bug).
 */

interface OrderFormState {
  days: string
  drivers: DriverCount
  fleetVariantId: number | null
  ferries: string
  tunnels: string
  revenue: string
}

const INITIAL_FORM: OrderFormState = {
  days: '1',
  drivers: 1,
  fleetVariantId: null,
  ferries: '0',
  tunnels: '0',
  revenue: '',
}

type StaticData =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; config: CalculatorConfig; variants: FleetVariantDto[]; airports: AirportDto[] }

export function CalculatorPage() {
  const [staticData, setStaticData] = useState<StaticData>({ kind: 'loading' })
  const [routeState, setRouteState] = useState<RouteState>({ kind: 'idle' })
  const [form, setForm] = useState<OrderFormState>(INITIAL_FORM)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.getConfig(), api.getFleetVariants(), api.getAirports()])
      .then(([config, variants, airports]) => {
        if (cancelled) return
        setStaticData({ kind: 'ready', config, variants, airports })
        setForm(f => ({ ...f, fleetVariantId: variants[0]?.id ?? null }))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message =
          error instanceof ApiError ? error.message : 'Nie udało się wczytać konfiguracji. Odśwież stronę.'
        setStaticData({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const lookup = async (rawCode: string) => {
    const routeCode = rawCode.trim().toUpperCase()
    // Atomic reset BEFORE repopulating — nothing derived survives a lookup.
    setRouteState({ kind: 'loading', routeCode })
    try {
      const route = await api.getRoute(routeCode)
      setRouteState(route === null ? { kind: 'notFound', routeCode } : { kind: 'found', route })
    } catch (error) {
      setRouteState({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'Nie udało się sprawdzić trasy. Spróbuj ponownie.',
      })
    }
  }

  const confirmHereFetch = async () => {
    if (routeState.kind !== 'notFound') return
    const { routeCode } = routeState
    setRouteState({ kind: 'fetching', routeCode })
    try {
      const fetched = await api.fetchRouteFromHere(routeCode)
      setRouteState({ kind: 'fetched', fetched, saved: false, saving: false })
    } catch (error) {
      setRouteState({
        kind: 'error',
        message:
          error instanceof ApiError ? error.message : 'Nie udało się pobrać trasy z HERE. Spróbuj ponownie.',
      })
    }
  }

  const saveFetched = async () => {
    if (routeState.kind !== 'fetched' || routeState.saved) return
    const current = routeState
    setRouteState({ ...current, saving: true })
    try {
      await api.saveFetchedRoute(current.fetched)
      setRouteState({ ...current, saved: true, saving: false })
    } catch (error) {
      setRouteState({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'Nie udało się zapisać trasy. Spróbuj ponownie.',
      })
    }
  }

  const routeData = useMemo(() => {
    if (routeState.kind === 'found') {
      const { route } = routeState
      const tolls: CountryToll[] = [
        ...route.tolls.map(t => ({ country: t.country, tollEur: t.tollEur, status: t.status })),
        ...route.tollsPendingCountries.map(country => ({ country, tollEur: 0, status: 'missing' as const })),
      ]
      return { totalKm: route.totalKm, tolls }
    }
    if (routeState.kind === 'fetched') {
      const { fetched } = routeState
      const tolls: CountryToll[] = [
        ...Object.entries(fetched.tollEstimates).map(([country, tollEur]) => ({
          country,
          tollEur,
          status: 'estimate' as const,
        })),
        ...Object.keys(fetched.countryKm)
          .filter(country => !(country in fetched.tollEstimates))
          .map(country => ({ country, tollEur: 0, status: 'missing' as const })),
      ]
      return { totalKm: fetched.totalKm, tolls }
    }
    return null
  }, [routeState])

  const calc = useMemo((): { breakdown: CostBreakdown | null; errors: Record<string, string> } => {
    if (staticData.kind !== 'ready' || routeData === null) return { breakdown: null, errors: {} }

    const errors: Record<string, string> = {}
    const days = parseDecimalInput(form.days)
    if (days === null) errors['days'] = 'Podaj liczbę dni, np. 1,5.'
    const ferries = form.ferries.trim() === '' ? 0 : parseDecimalInput(form.ferries)
    if (ferries === null) errors['ferries'] = 'Podaj kwotę w EUR, np. 220,00.'
    const tunnels = form.tunnels.trim() === '' ? 0 : parseDecimalInput(form.tunnels)
    if (tunnels === null) errors['tunnels'] = 'Podaj kwotę w EUR, np. 450,00.'
    const revenue = form.revenue.trim() === '' ? undefined : parseDecimalInput(form.revenue)
    if (revenue === null) errors['revenue'] = 'Podaj kwotę w EUR albo zostaw puste.'

    const variant = staticData.variants.find(v => v.id === form.fleetVariantId)
    if (variant === undefined) errors['variant'] = 'Wybierz wariant taboru.'

    if (
      Object.keys(errors).length > 0 ||
      days === null ||
      ferries === null ||
      tunnels === null ||
      revenue === null ||
      !variant
    ) {
      return { breakdown: null, errors }
    }

    const result = calculateOrderCost(
      {
        totalKm: routeData.totalKm,
        orderDays: days,
        driverCount: form.drivers,
        fleetMonthlyCostEur: variant.monthlyCostEur,
        tolls: routeData.tolls,
        ferriesTunnelsEur: ferries + tunnels,
        ...(revenue !== undefined ? { revenueEur: revenue } : {}),
      },
      staticData.config,
    )

    if (!result.ok) {
      for (const issue of result.issues) {
        if (issue.field === 'orderDays') errors['days'] = 'Min. 0,5 dnia, krok co 0,5.'
        else if (issue.field === 'ferriesTunnelsEur') errors['ferries'] = 'Kwota nie może być ujemna.'
        else if (issue.field === 'revenueEur') errors['revenue'] = 'Kwota nie może być ujemna.'
        else errors[issue.field] = issue.message
      }
      return { breakdown: null, errors }
    }
    return { breakdown: result.breakdown, errors: {} }
  }, [staticData, routeData, form])

  if (staticData.kind === 'loading') {
    return <p className="p-6 text-sm text-slate-500">Wczytywanie konfiguracji…</p>
  }
  if (staticData.kind === 'error') {
    return (
      <p role="alert" className="m-6 rounded bg-red-50 px-4 py-3 text-sm text-red-700">
        {staticData.message}
      </p>
    )
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-4 p-4 md:grid-cols-2">
      <div className="space-y-4">
        <RoutePanel
          routeState={routeState}
          airports={staticData.airports}
          onLookup={lookup}
          onConfirmHereFetch={confirmHereFetch}
          onSaveFetched={saveFetched}
        />

        <section aria-label="Parametry zlecenia" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-base font-semibold text-slate-800">Parametry zlecenia</h2>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Dni (min 0,5)"
              value={form.days}
              onChange={days => setForm(f => ({ ...f, days }))}
              error={calc.errors['days']}
            />

            <div className="flex flex-col gap-1">
              <label htmlFor="drivers" className="text-sm font-medium text-slate-700">
                Kierowcy
              </label>
              <select
                id="drivers"
                value={form.drivers}
                onChange={e => setForm(f => ({ ...f, drivers: Number(e.target.value) as DriverCount }))}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-300"
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </div>

            <div className="col-span-2 flex flex-col gap-1">
              <label htmlFor="fleet-variant" className="text-sm font-medium text-slate-700">
                Wariant taboru
              </label>
              {/* Constrained select — free text impossible by construction (PRD §5.4) */}
              <select
                id="fleet-variant"
                value={form.fleetVariantId ?? ''}
                onChange={e => setForm(f => ({ ...f, fleetVariantId: Number(e.target.value) }))}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-300"
              >
                {staticData.variants.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
              {calc.errors['variant'] !== undefined && (
                <p role="alert" className="text-xs text-red-600">
                  {calc.errors['variant']}
                </p>
              )}
            </div>

            <NumberField
              label="Promy (EUR)"
              value={form.ferries}
              onChange={ferries => setForm(f => ({ ...f, ferries }))}
              error={calc.errors['ferries']}
            />
            <NumberField
              label="Tunele (EUR)"
              value={form.tunnels}
              onChange={tunnels => setForm(f => ({ ...f, tunnels }))}
              error={calc.errors['tunnels']}
            />
            <div className="col-span-2">
              <NumberField
                label="Przychód (EUR, opcjonalnie — dla marży)"
                value={form.revenue}
                onChange={revenue => setForm(f => ({ ...f, revenue }))}
                error={calc.errors['revenue']}
                placeholder="np. 900,00"
              />
            </div>
          </div>
        </section>
      </div>

      <div>
        {calc.breakdown !== null ? (
          <CostBreakdownPanel breakdown={calc.breakdown} />
        ) : (
          <section className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
            {routeData === null
              ? 'Sprawdź trasę, aby zobaczyć kalkulację kosztów.'
              : 'Popraw zaznaczone pola, aby zobaczyć kalkulację.'}
          </section>
        )}
      </div>
    </div>
  )
}
