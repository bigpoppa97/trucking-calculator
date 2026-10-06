import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FleetTruck, Issue, OrderDetails, WeekView } from './boardApi.js'
import { WeekPage } from './WeekPage.js'
import { ReviewPage } from './ReviewPage.js'
import { FleetPage } from './FleetPage.js'

vi.mock('./boardApi.js', async importOriginal => {
  const original = await importOriginal<typeof import('./boardApi.js')>()
  const fns = Object.fromEntries(Object.keys(original.boardApi).map(k => [k, vi.fn()]))
  return { ...original, boardApi: fns }
})

const { boardApi } = await import('./boardApi.js')
const api = vi.mocked(boardApi)

const WEEK: WeekView = {
  weekStart: '2026-09-21',
  weekEnd: '2026-09-27',
  weekNumber: 39,
  days: ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'],
  today: '2026-09-23',
  trucks: [
    {
      id: 1,
      plate: 'KN1050H',
      carrier: 'Przewoźnik A',
      driver: 'Kierowca A',
      phone: '600000000',
      trailer: 'KN1111P',
      trailerTypePl: 'chłodnia 2,61 m · rolki',
      trailerTypeEn: 'cooler 2.61m rollerbed',
      copyText: 'KN1050H / KN1111P',
      bars: [
        {
          key: '79-1000-26:0',
          orderNo: '79-1000-26',
          legIndex: 0,
          legCount: 1,
          title: 'Warszawa → Budapeszt (Vecsés)',
          startDate: '2026-09-22',
          endDate: '2026-09-23',
          startDay: 1,
          endDay: 2,
          revAlloc: 1500,
          amount: 1300,
          margin: 200,
          kmLoaded: 680,
          kmEmpty: 0,
          kmEstimated: true,
          prz: false,
          issue: false,
          excluded: null,
          missing: false,
          noCarrier: false,
          inWeek: true,
          noteLines: [],
        },
      ],
      events: [],
      totals: { revenue: 1500, cost: 1300, margin: 200, km: 680, kmEmpty: 0, legs: 1, kmEstimated: true },
    },
  ],
  kpis: { margin: 200, revenue: 1500, cost: 1300, orders: 1, km: 680, kmEmpty: 0, revenuePerKm: 2.21, costPerKm: 1.91, kmEstimated: true, openIssues: 2 },
  lastImport: { importedAt: '2026-09-23T08:00:00Z', filename: 'export.xlsx' },
}

const ORDER: OrderDetails = {
  order: {
    orderNo: '79-1000-26',
    client: 'Klient testowy',
    clientRef: 'X1',
    carrier: 'Przewoźnik A',
    statusClient: 'Z',
    statusSped: 'Z',
    loadDate: '2026-09-22',
    unloadDate: '2026-09-23',
    route: 'Warszawa → Budapeszt (Vecsés)',
    rev: 1500,
    costApp: 1300,
    amountsTotal: 1300,
    extraCost: 0,
    margin: 200,
    marginPct: 13.33,
    excluded: null,
    noCarrier: false,
    missing: false,
    notesApp: '',
    prz: null,
    przErrors: [],
    trailer: 'KN1111P',
  },
  legs: [
    {
      index: 0,
      plate: 'KN1050H',
      kind: 'fleet',
      truckId: 1,
      stops: ['Warszawa', 'Budapeszt (Vecsés)'],
      from: 'Warszawa',
      to: 'Budapeszt (Vecsés)',
      startDate: '2026-09-22',
      endDate: '2026-09-23',
      amount: 1300,
      revAlloc: 1500,
      kmLoaded: 680,
      kmEmpty: 0,
      kmEmptyFrom: 'Warszawa',
      kmEstimated: true,
    },
  ],
  notes: [],
  overrides: [],
  issues: [],
  history: [],
}

const FLEET: FleetTruck[] = [
  {
    id: 1,
    carrier: 'Przewoźnik A',
    driver: 'Kierowca A',
    phone: '600000000',
    trailerPlate: 'KN1111P',
    notes: '',
    active: true,
    sortOrder: 1,
    plates: [{ id: 1, plate: 'KN1050H', validFrom: '2024-01-01', validTo: null }],
    currentPlate: 'KN1050H',
  },
]

const issue = (over: Partial<Issue>): Issue => ({
  id: 1,
  key: 'k',
  kind: 'UNKNOWN_TRAILER',
  ref: 'KN 1111P',
  message: 'Naczepa „KN 1111P” nie istnieje w bazie.',
  details: { suggestions: ['KN1111P'] },
  status: 'open',
  created_at: '2026-09-23T08:00:00Z',
  updated_at: '2026-09-23T08:00:00Z',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  try {
    localStorage.clear()
  } catch {
    // ignore
  }
})

describe('WeekPage', () => {
  it('shows trucks with their orders and hides money on demand', async () => {
    api.week.mockResolvedValue(WEEK)
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    expect(await screen.findByText('Tydzień 39')).toBeInTheDocument()
    expect(api.week).toHaveBeenCalledWith('2026-09-23')
    const bar = screen.getByRole('button', { name: /79-1000-26, Warszawa → Budapeszt/ })
    expect(within(bar).getByText(/\+200 €/)).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Pokaż kwoty'))
    expect(within(bar).queryByText(/\+200 €/)).not.toBeInTheDocument()
    expect(screen.queryByText('Marża tygodnia')).not.toBeInTheDocument()
  })

  it('opens the order panel with legs and km split', async () => {
    api.week.mockResolvedValue(WEEK)
    api.order.mockResolvedValue(ORDER)
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /79-1000-26, Warszawa/ }))
    const panel = await screen.findByRole('complementary', { name: 'Szczegóły zlecenia' })
    expect(await within(panel).findByText('Klient testowy')).toBeInTheDocument()
    expect(within(panel).getByText(/z ładunkiem ≈680 km · dojazd pusty ≈0 km/)).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('complementary', { name: 'Szczegóły zlecenia' })).not.toBeInTheDocument()
  })

  it('jumps to the focused order week', async () => {
    api.week.mockResolvedValue(WEEK)
    api.order.mockResolvedValue(ORDER)
    render(<WeekPage focus={{ orderNo: '79-1000-26', date: '2026-09-22' }} onReview={() => {}} />)
    await waitFor(() => expect(api.week).toHaveBeenCalledWith('2026-09-22'))
    expect(await screen.findByRole('complementary', { name: 'Szczegóły zlecenia' })).toBeInTheDocument()
  })
})

describe('ReviewPage', () => {
  it('resolves a trailer typo by remembering the alias', async () => {
    api.issues.mockResolvedValue([issue({})])
    api.fleet.mockResolvedValue(FLEET)
    api.imports.mockResolvedValue([])
    api.resolveIssue.mockResolvedValue({ ok: true })
    const changed = vi.fn()
    render(<ReviewPage onOpenOrder={() => {}} onIssuesChanged={changed} />)
    await userEvent.click(await screen.findByRole('button', { name: 'To KN1111P — zapamiętaj zapis' }))
    expect(api.resolveIssue).toHaveBeenCalledWith(1, 'alias', { trailer: 'KN1111P' })
    await waitFor(() => expect(changed).toHaveBeenCalled())
  })

  it('does not create a place without coordinates', async () => {
    api.issues.mockResolvedValue([issue({ id: 2, kind: 'UNKNOWN_PLACE', ref: 'Strykow', details: { raw: 'Strykow', suggestions: [] } })])
    api.fleet.mockResolvedValue(FLEET)
    api.imports.mockResolvedValue([])
    render(<ReviewPage onOpenOrder={() => {}} onIssuesChanged={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Wpisz współrzędne ręcznie' }))
    await userEvent.click(screen.getByRole('button', { name: 'Dodaj miejsce' }))
    expect(api.resolveIssue).not.toHaveBeenCalled()
  })
})

describe('FleetPage', () => {
  it('records a new plate from a date for an existing truck', async () => {
    api.fleet.mockResolvedValue(FLEET)
    api.addPlate.mockResolvedValue({ ok: true })
    render(<FleetPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Nowy numer' }))
    await userEvent.type(screen.getByLabelText('Nowy numer'), 'kn2222h')
    await userEvent.clear(screen.getByLabelText('Obowiązuje od'))
    await userEvent.type(screen.getByLabelText('Obowiązuje od'), '2026-10-01')
    await userEvent.click(screen.getByRole('button', { name: 'Zapisz numer' }))
    expect(api.addPlate).toHaveBeenCalledWith(1, 'kn2222h', '2026-10-01')
    expect(await screen.findByRole('status')).toHaveTextContent('KN2222H')
  })

  it('blocks thresholds where min per km is not below max', async () => {
    api.fleet.mockResolvedValue(FLEET)
    api.thresholds.mockResolvedValue({ marginWarnPct: 40, revPerKmMin: 0.5, revPerKmMax: 4.5 })
    render(<FleetPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Progi ostrzeżeń' }))
    const min = await screen.findByLabelText('Stawka klienta / km — min (€)')
    await userEvent.clear(min)
    await userEvent.type(min, '5')
    expect(screen.getByRole('button', { name: 'Zapisz progi' })).toBeDisabled()
  })
})
