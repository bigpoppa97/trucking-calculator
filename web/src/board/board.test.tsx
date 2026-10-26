import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Driver, DriverDetails, FleetTruck, Issue, OrderDetails, Service, TruckView, WeekView } from './boardApi.js'
import { WeekPage } from './WeekPage.js'
import { TruckPage, parseTruckHash, truckHash } from './TruckPage.js'
import { DriverPage, parseDriverHash } from './DriverPage.js'
import { ReviewPage } from './ReviewPage.js'
import { FleetPage } from './FleetPage.js'
import { placeBars } from './TruckTimeline.js'
import { ordersWithDrafts } from './format.js'
import type { WeekBar } from './boardApi.js'

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
      plate: 'AA1050H',
      carrier: 'Przewoźnik A',
      driverId: 5,
      driver: 'Kierowca A',
      phone: '600000000',
      driverWarnings: [],
      trailer: 'TR1111P',
      trailerTypePl: 'chłodnia 2,61 m · rolki',
      trailerTypeEn: 'cooler 2.61m rollerbed',
      copyText: 'AA1050H / TR1111P',
      bars: [
        {
          key: '79-1000-26:0',
          orderNo: '79-1000-26',
          legIndex: 0,
          legCount: 1,
          title: 'Warszawa → Budapeszt (Vecsés)',
          startDate: '2026-09-22',
          endDate: '2026-09-23',
          startTime: '16:00',
          endTime: '16:00',
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
          draft: false,
          inWeek: true,
          noteLines: [],
          serviceConflict: null,
        },
      ],
      events: [],
      services: [],
      required: [],
      totals: { revenue: 1500, carrier: 1300, cost: 1300, margin: 200, km: 680, kmEmpty: 0, legs: 1, kmEstimated: true },
    },
  ],
  kpis: { margin: 200, revenue: 1500, cost: 1300, orders: 1, drafts: 0, km: 680, kmEmpty: 0, revenuePerKm: 2.21, costPerKm: 1.91, kmEstimated: true, openIssues: 2 },
  lastImport: { importedAt: '2026-09-23T08:00:00Z', filename: 'export.xlsx', supplement: null },
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
    loadTime: '16:00',
    unloadTime: null,
    loadAtManual: false,
    unloadAtManual: false,
    route: 'Warszawa → Budapeszt (Vecsés)',
    draftNoMoney: false,
    draft: null,
    rev: 1500,
    costApp: 1300,
    amountsTotal: 1300,
    extraCost: 0,
    extraCostManual: false,
    ferryCost: 0,
    ferryEntries: [],
    ferryErrors: [],
    margin: 200,
    marginPct: 13.33,
    excluded: null,
    noCarrier: false,
    missing: false,
    notesApp: '',
    prz: null,
    przManual: null,
    przErrors: [],
    trailer: 'TR1111P',
  },
  legs: [
    {
      index: 0,
      plate: 'AA1050H',
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
      kmManual: false,
      driver: 'Kierowca A → Kierowca B (zmiana 23.09)',
      driverManual: false,
      drivers: [
        { id: 5, name: 'Kierowca A' },
        { id: 6, name: 'Kierowca B' },
      ],
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
    driverId: 5,
    driver: 'Kierowca A',
    trailerPlate: 'TR1111P',
    notes: '',
    active: true,
    sortOrder: 1,
    plates: [{ id: 1, plate: 'AA1050H', validFrom: '2024-01-01', validTo: null }],
    currentPlate: 'AA1050H',
    retiredOn: null,
  },
]

const issue = (over: Partial<Issue>): Issue => ({
  id: 1,
  key: 'k',
  kind: 'UNKNOWN_TRAILER',
  ref: 'TR 1111P',
  message: 'Naczepa „TR 1111P” nie istnieje w bazie.',
  details: { suggestions: ['TR1111P'] },
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

  it('shows the ferry from the notes and what it does to the margin', async () => {
    api.week.mockResolvedValue(WEEK)
    api.order.mockResolvedValue({
      ...ORDER,
      order: {
        ...ORDER.order,
        rev: 3720,
        amountsTotal: 2380,
        extraCost: 1180,
        ferryCost: 1180,
        ferryEntries: ['PROM 1180 Finnlines'],
        margin: 1340,
        marginPct: 36.02,
        notesApp: 'LH7411B-2026-10-10 PROM 1180 Finnlines',
      },
    })
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /79-1000-26, Warszawa/ }))
    const panel = await screen.findByRole('complementary', { name: 'Szczegóły zlecenia' })
    expect(await within(panel).findByText('Prom z uwag')).toBeInTheDocument()
    expect(within(panel).getByText(/Koszt promu 1\D?180 € — pomniejsza marżę/)).toBeInTheDocument()
    expect(within(panel).getByText(/w tym prom 1\D?180 €/)).toBeInTheDocument()
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
    await userEvent.click(await screen.findByRole('button', { name: 'To TR1111P — zapamiętaj zapis' }))
    expect(api.resolveIssue).toHaveBeenCalledWith(1, 'alias', { trailer: 'TR1111P' })
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
    api.drivers.mockResolvedValue([])
    render(<FleetPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Ciągniki' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Nowy numer / nowy ciągnik' }))
    await userEvent.type(screen.getByLabelText('Nowy numer'), 'aa2222h')
    await userEvent.clear(screen.getByLabelText('Obowiązuje od'))
    await userEvent.type(screen.getByLabelText('Obowiązuje od'), '2026-10-01')
    await userEvent.click(screen.getByRole('button', { name: 'Zapisz numer' }))
    expect(api.addPlate).toHaveBeenCalledWith(1, 'aa2222h', '2026-10-01')
    expect(await screen.findByRole('status')).toHaveTextContent('AA2222H')
  })

  it('blocks thresholds where min per km is not below max', async () => {
    api.fleet.mockResolvedValue(FLEET)
    api.thresholds.mockResolvedValue({ marginWarnPct: 40, revPerKmMin: 0.5, revPerKmMax: 4.5 })
    api.drivers.mockResolvedValue([])
    render(<FleetPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Progi ostrzeżeń' }))
    const min = await screen.findByLabelText('Stawka klienta / km — min (€)')
    await userEvent.clear(min)
    await userEvent.type(min, '5')
    expect(screen.getByRole('button', { name: 'Zapisz progi' })).toBeDisabled()
  })
})

describe('FleetPage — wklej stan floty', () => {
  it('shows the planned changes first and applies them on request', async () => {
    api.fleet.mockResolvedValue(FLEET)
    api.syncFleet
      .mockResolvedValueOnce({ changes: ['TR1111P: przewoźnik Przewoźnik A.'], warnings: ['KN9999X jest na tablicy, ale nie ma go na liście.'], errors: [], applied: false })
      .mockResolvedValueOnce({ changes: ['TR1111P: przewoźnik Przewoźnik A.'], warnings: [], errors: [], applied: true })
    api.drivers.mockResolvedValue([])
    render(<FleetPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Wklej stan floty' }))
    const apply = screen.getByRole('button', { name: /Zastosuj/ })
    expect(apply).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Lista'), 'Przewoźnik A:{enter}Ciągnik: AA1050H{enter}Naczepa: TR1111P')
    await userEvent.click(screen.getByRole('button', { name: 'Sprawdź zmiany' }))
    expect(api.syncFleet).toHaveBeenLastCalledWith('Przewoźnik A:\nCiągnik: AA1050H\nNaczepa: TR1111P', false)
    expect(await screen.findByText('TR1111P: przewoźnik Przewoźnik A.')).toBeInTheDocument()
    expect(screen.getByText(/nie ma go na liście/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Zastosuj (1)' }))
    expect(api.syncFleet).toHaveBeenLastCalledWith('Przewoźnik A:\nCiągnik: AA1050H\nNaczepa: TR1111P', true)
    expect(await screen.findByText('Zapisane zmiany')).toBeInTheDocument()
  })
})

const service = (over: Partial<Service>): Service => ({
  id: 7,
  truckId: 1,
  target: 'truck',
  trailerPlate: null,
  status: 'planned',
  phase: 'upcoming',
  allDay: false,
  startDay: '2026-09-24',
  startTime: '10:00',
  endDay: '2026-09-24',
  endTime: '13:00',
  when: '24.09 10:00–13:00',
  description: 'olej',
  place: 'Kraków',
  reportedAt: '2026-09-21T08:00:00Z',
  createdBy: 'Dyspozytor',
  updatedBy: 'Dyspozytor',
  updatedAt: '2026-09-21T08:00:00Z',
  history: [{ at: '2026-09-21T08:00:00Z', by: 'Dyspozytor', text: 'Dodano serwis (ciągnik: olej): 24.09 10:00–13:00, Kraków.' }],
  ...over,
})

const REQUIRED_TRUCK = service({ id: 8, status: 'required', phase: 'required', startDay: null, startTime: null, endDay: null, endTime: null, when: '', description: 'opony', place: '' })
const REQUIRED_TRAILER = service({ id: 9, target: 'trailer', trailerPlate: 'TR1111P', status: 'required', phase: 'required', startDay: null, startTime: null, endDay: null, endTime: null, when: '', description: 'agregat', place: '' })

function weekWithServices(): WeekView {
  const w = structuredClone(WEEK)
  const truck = w.trucks[0]!
  truck.services = [service({})]
  truck.required = [REQUIRED_TRUCK, REQUIRED_TRAILER]
  truck.bars[0]!.serviceConflict = 'Auto w serwisie cały dzień 23.09.'
  truck.bars[0]!.noteLines = ['Auto w serwisie cały dzień 23.09.']
  return w
}

describe('Serwis on the board', () => {
  it('shows the service strip, required badges and the conflict, and opens the set page', async () => {
    api.week.mockResolvedValue(weekWithServices())
    const openTruck = vi.fn()
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} onOpenTruck={openTruck} />)
    expect(await screen.findByRole('button', { name: /^Serwis ciągnika · 24\.09 10:00–13:00 · Kraków · olej$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /serwis: opony · od 21\.09/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /naczepa: agregat · od 21\.09/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /79-1000-26, .*Auto w serwisie cały dzień 23\.09\./ })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Strona zestawu AA1050H' }))
    expect(openTruck).toHaveBeenCalledWith(1, '2026-09-21')
    await userEvent.dblClick(screen.getByText('Przewoźnik A'))
    expect(openTruck).toHaveBeenCalledTimes(2)
  })

  it('plans a required service from its badge (same record)', async () => {
    api.week.mockResolvedValue(weekWithServices())
    api.updateService.mockResolvedValue({ ok: true })
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /serwis: opony/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: 'Wymagany (bez terminu)' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Zaplanowany' }))
    fireEvent.change(within(dialog).getByLabelText('Od — dzień'), { target: { value: '2026-09-24' } })
    fireEvent.change(within(dialog).getByLabelText('Do — dzień'), { target: { value: '2026-09-24' } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Zaplanuj' }))
    expect(api.updateService).toHaveBeenCalledWith(8, {
      target: 'truck',
      description: 'opony',
      place: '',
      status: 'planned',
      allDay: false,
      startDay: '2026-09-24',
      startTime: '08:00',
      endDay: '2026-09-24',
      endTime: '10:00',
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('adding a planned service from "+" asks whether it is the one already reported', async () => {
    api.week.mockResolvedValue(weekWithServices())
    api.createService.mockResolvedValue(10)
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Dodaj zdarzenie: AA1050H, 24.09' }))
    await userEvent.selectOptions(screen.getByLabelText('Rodzaj'), 'service')
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Nowy serwis · AA1050H/)).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: /Tak — opony/ })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dodaj serwis' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Zaznacz, czy to serwis zgłoszony wcześniej')
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Nie, to nowy serwis' }))
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Cały dzień/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dodaj serwis' }))
    expect(api.createService).toHaveBeenCalledWith({
      truckId: 1,
      status: 'planned',
      target: 'truck',
      description: '',
      place: '',
      allDay: true,
      startDay: '2026-09-24',
      endDay: '2026-09-24',
    })
  })

  it('a required service needs a description', async () => {
    api.week.mockResolvedValue(WEEK)
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Dodaj zdarzenie: AA1050H, 24.09' }))
    await userEvent.selectOptions(screen.getByLabelText('Rodzaj'), 'service')
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Wymagany (bez terminu)' }))
    await userEvent.click(within(dialog).getByRole('radio', { name: 'naczepy' }))
    expect(within(dialog).getByLabelText('Numer naczepy')).toHaveValue('TR1111P')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dodaj serwis' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Wpisz, co trzeba zrobić')
    expect(api.createService).not.toHaveBeenCalled()
  })
})

const TRUCK_VIEW = (): TruckView => {
  const row = weekWithServices().trucks[0]!
  return {
    truck: {
      id: 1,
      plate: 'AA1050H',
      plates: [
        { plate: 'AA1050H', validFrom: '2024-01-01', validTo: null },
        { plate: 'AA0001H', validFrom: '2020-01-01', validTo: '2023-12-31' },
      ],
      carrier: 'Przewoźnik A',
      driverId: 5,
      driver: 'Kierowca A',
      phone: '600000000',
      driverWarnings: [{ kind: 'AVSEC', validTo: '2026-10-01', status: 'expiring' }],
      trailer: 'TR1111P',
      trailerTypePl: 'chłodnia 2,61 m · rolki',
      active: true,
      retiredOn: null,
      copyText: 'Truck AA1050H',
      required: [REQUIRED_TRUCK],
      driverChanges: [
        { id: 31, day: '2026-09-23', driverId: 5, driver: 'Kierowca A', createdBy: 'Dyspozytor', createdAt: '2026-09-20T08:00:00Z' },
        { id: 30, day: '2000-01-01', driverId: 6, driver: 'Kierowca B', createdBy: 'migracja', createdAt: '2026-09-01T08:00:00Z' },
      ],
    },
    from: '2026-09-21',
    to: '2026-09-27',
    today: '2026-09-23',
    weeks: [{ weekStart: '2026-09-21', weekEnd: '2026-09-27', weekNumber: 39, days: WEEK.days, row }],
    totals: { revenue: 1500, carrier: 1300, cost: 1300, margin: 200, km: 680, kmEmpty: 0, legs: 1, kmEstimated: true, services: 1 },
    orders: [
      {
        orderNo: '79-1000-26',
        legIndex: 0,
        legCount: 1,
        title: 'Warszawa → Budapeszt (Vecsés)',
        startDate: '2026-09-22',
        endDate: '2026-09-23',
        revAlloc: 1500,
        amount: 1300,
        carrierAmount: 1300,
        margin: 200,
        km: 680,
        kmEstimated: true,
        prz: false,
        excluded: null,
        noCarrier: false,
        missing: false,
        draft: false,
        driver: 'Kierowca A',
        driverManual: false,
      },
    ],
    services: [REQUIRED_TRUCK, service({})],
    activeOrder: { orderNo: '79-1000-26', title: 'Warszawa → Budapeszt (Vecsés)', startDate: '2026-09-22', endDate: '2026-09-23', upcoming: false },
  }
}

describe('TruckPage (strona zestawu)', () => {
  it('shows the header, totals, services and orders of the period', async () => {
    api.truckView.mockResolvedValue(TRUCK_VIEW())
    const back = vi.fn()
    const navigate = vi.fn()
    render(<TruckPage truckId={1} date="2026-09-23" mode="week" onBack={back} onNavigate={navigate} />)
    expect(await screen.findByRole('heading', { name: 'AA1050H' })).toBeInTheDocument()
    expect(api.truckView).toHaveBeenCalledWith(1, '2026-09-23', '2026-09-23')
    expect(screen.getByText('Aktywne zlecenie')).toBeInTheDocument()
    expect(screen.getByText('Historia numerów (1)')).toBeInTheDocument()
    expect(screen.getByText('Serwisy')).toBeInTheDocument()

    const servicesTab = screen.getByRole('tabpanel')
    expect(within(servicesTab).getByText('Wymagane (1)')).toBeInTheDocument()
    expect(within(servicesTab).getByText('Zaplanowane i w trakcie (1)')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Zlecenia (1)' }))
    const orders = screen.getByRole('tabpanel')
    expect(within(orders).getByRole('button', { name: '79-1000-26' })).toBeInTheDocument()
    expect(within(orders).getByText('Razem (bez anulowanych i wyłączonych)')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('radio', { name: 'Miesiąc' }))
    expect(navigate).toHaveBeenCalledWith('2026-09-23', 'month')
    await userEvent.click(screen.getByRole('button', { name: 'Następny tydzień' }))
    expect(navigate).toHaveBeenCalledWith('2026-09-30', 'week')
    await userEvent.click(screen.getByRole('button', { name: /Tablica/ }))
    expect(back).toHaveBeenCalled()
  })

  it('asks the server for the whole calendar month in month mode', async () => {
    api.truckView.mockResolvedValue(TRUCK_VIEW())
    render(<TruckPage truckId={1} date="2026-02-10" mode="month" onBack={() => {}} onNavigate={() => {}} />)
    await waitFor(() => expect(api.truckView).toHaveBeenCalledWith(1, '2026-02-01', '2026-02-28'))
    expect(await screen.findByText('luty 2026')).toBeInTheDocument()
  })

  it('keeps the page in the address', () => {
    expect(parseTruckHash('#/auto/12?d=2026-10-05&widok=miesiac')).toEqual({ id: 12, date: '2026-10-05', mode: 'month' })
    expect(parseTruckHash('#/auto/3?d=2026-10-05')).toEqual({ id: 3, date: '2026-10-05', mode: 'week' })
    expect(parseTruckHash('#/flota')).toBeNull()
    expect(truckHash({ id: 12, date: '2026-10-05', mode: 'month' })).toBe('#/auto/12?d=2026-10-05&widok=miesiac')
  })
})

const DRIVERS: Driver[] = [
  {
    id: 5,
    name: 'Kierowca A',
    phone: '600000000',
    carrier: 'Przewoźnik A',
    notes: '',
    active: true,
    trucks: [{ id: 1, plate: 'AA1050H' }],
    avsec: { validTo: '2026-10-10', number: 'X1', files: 1, status: 'expiring', daysLeft: 17 },
    certCount: 1,
    warnings: [{ kind: 'AVSEC', validTo: '2026-10-10', status: 'expiring' }],
  },
  {
    id: 6,
    name: 'Kierowca B',
    phone: '',
    carrier: 'Przewoźnik A',
    notes: '',
    active: true,
    trucks: [{ id: 2, plate: 'AA2050H' }],
    avsec: null,
    certCount: 0,
    warnings: [],
  },
  { id: 7, name: 'Kierowca C', phone: '', carrier: 'Inna Firma', notes: '', active: true, trucks: [], avsec: null, certCount: 0, warnings: [] },
]

describe('Kierowcy', () => {
  it('Flota opens on drivers with their AVSEC, and "Certyfikaty" opens the driver page', async () => {
    api.drivers.mockResolvedValue(DRIVERS)
    const open = vi.fn()
    render(<FleetPage onOpenDriver={open} />)
    expect(await screen.findByText('Kierowca A')).toBeInTheDocument()
    expect(screen.getByText(/ważny do 10\.10\.2026 — zostało 17 dni/)).toBeInTheDocument()
    expect(screen.getAllByText('brak')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'Certyfikaty: Kierowca A' }))
    expect(open).toHaveBeenCalledWith(5)
  })

  it('a driver change from "+" on the board: carrier drivers first, frees the other tractor', async () => {
    api.week.mockResolvedValue(WEEK)
    api.drivers.mockResolvedValue(DRIVERS)
    api.setDriverChange.mockResolvedValue({ released: ['AA2050H'] })
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Dodaj zdarzenie: AA1050H, 24.09' }))
    await userEvent.selectOptions(screen.getByLabelText('Rodzaj'), 'driver')
    const dialog = screen.getByRole('dialog')
    const select = await within(dialog).findByLabelText('Kierowca')
    await waitFor(() => expect(within(select).getByRole('option', { name: /Kierowca B \(teraz AA2050H\)/ })).toBeInTheDocument())
    expect(within(select).getByRole('group', { name: 'Przewoźnik A' })).toBeInTheDocument()
    await userEvent.selectOptions(select, '6')
    expect(within(dialog).getByRole('checkbox', { name: /Kierowca B jeździ teraz na AA2050H/ })).toBeChecked()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Zapisz zmianę' }))
    expect(api.setDriverChange).toHaveBeenCalledWith({ truckId: 1, day: '2026-09-24', driverId: 6, releaseOther: true })
    expect(await screen.findByRole('status')).toHaveTextContent('AA2050H: od 24.09 bez kierowcy.')
  })

  it('a driver change chip on the board can be corrected or deleted', async () => {
    const week = structuredClone(WEEK)
    week.trucks[0]!.events = [{ id: null, day: '2026-09-23', kind: 'driver', text: 'Kierowca: Kierowca B → Kierowca A', auto: false, driverChangeId: 31, driverId: 5 }]
    week.trucks[0]!.driverWarnings = [{ kind: 'AVSEC', validTo: '2026-09-20', status: 'expired' }]
    api.week.mockResolvedValue(week)
    api.drivers.mockResolvedValue(DRIVERS)
    api.deleteDriverChange.mockResolvedValue({ ok: true })
    const openDriver = vi.fn()
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} onOpenDriver={openDriver} />)
    await userEvent.click(await screen.findByRole('button', { name: /AVSEC wygasł 20\.09/ }))
    expect(openDriver).toHaveBeenCalledWith(5)
    await userEvent.click(screen.getByRole('button', { name: 'Kierowca: Kierowca B → Kierowca A' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Usuń zmianę' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tak, usuń' }))
    expect(api.deleteDriverChange).toHaveBeenCalledWith(31)
  })

  it('the order panel names the driver(s) and corrects with a driver from the list', async () => {
    api.week.mockResolvedValue(WEEK)
    api.order.mockResolvedValue(ORDER)
    api.drivers.mockResolvedValue(DRIVERS)
    api.setOverride.mockResolvedValue({ ok: true })
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /79-1000-26, Warszawa/ }))
    const panel = await screen.findByRole('complementary', { name: 'Szczegóły zlecenia' })
    expect(await within(panel).findByText('Kierowca A → Kierowca B (zmiana 23.09)')).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Popraw ręcznie' }))
    await userEvent.selectOptions(within(panel).getByLabelText('Co poprawić'), 'driver')
    const who = await within(panel).findByLabelText('Kto jechał')
    await waitFor(() => expect(within(who).getByRole('option', { name: /Kierowca B/ })).toBeInTheDocument())
    await userEvent.selectOptions(who, '6')
    await userEvent.click(within(panel).getByRole('button', { name: 'Zapisz poprawkę' }))
    expect(api.setOverride).toHaveBeenCalledWith('79-1000-26', 'driver', '6')
  })
})

const DRIVER_DETAILS: DriverDetails = {
  driver: { id: 5, name: 'Kierowca A', phone: '600000000', carrier: 'Przewoźnik A', notes: '', active: true },
  trucks: [{ id: 1, plate: 'AA1050H' }],
  history: [{ truckId: 1, plate: 'AA1050H', from: '2000-01-01', to: null }],
  certs: [
    {
      id: 11,
      kind: 'AVSEC',
      number: 'X1',
      validTo: '2026-10-10',
      notes: '',
      status: 'expiring',
      daysLeft: 17,
      createdBy: 'Dyspozytor',
      updatedBy: 'Dyspozytor',
      updatedAt: '2026-09-20T08:00:00Z',
      files: [{ id: 21, filename: 'AVSEC.pdf', mime: 'application/pdf', size: 120000, uploadedBy: 'Dyspozytor', uploadedAt: '2026-09-20T08:00:00Z' }],
    },
  ],
  warnings: [{ kind: 'AVSEC', validTo: '2026-10-10', status: 'expiring' }],
}

describe('DriverPage (certyfikaty)', () => {
  it('shows certificates with scans to preview and download, and uploads a new scan', async () => {
    api.driver.mockResolvedValue(DRIVER_DETAILS)
    api.drivers.mockResolvedValue(DRIVERS)
    api.uploadCertFile.mockResolvedValue(22)
    render(<DriverPage driverId={5} onBack={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'Kierowca A' })).toBeInTheDocument()
    expect(screen.getByText('ważny do 10.10.2026 — zostało 17 dni')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Podgląd' })).toHaveAttribute('href', '/api/board/cert-files/21')
    expect(screen.getByRole('link', { name: 'Pobierz' })).toHaveAttribute('href', '/api/board/cert-files/21?download=1')
    expect(screen.getByText(/od początku tablicy/)).toBeInTheDocument()

    const bad = new File(['hello'], 'notatka.txt', { type: 'text/plain' })
    await userEvent.upload(screen.getByLabelText('Dodaj skan do AVSEC'), bad, { applyAccept: false })
    expect(await screen.findByRole('alert')).toHaveTextContent('wgraj skan jako PDF, JPG albo PNG')
    expect(api.uploadCertFile).not.toHaveBeenCalled()

    const pdf = new File(['%PDF-1.4'], 'skan.pdf', { type: 'application/pdf' })
    await userEvent.upload(screen.getByLabelText('Dodaj skan do AVSEC'), pdf)
    expect(api.uploadCertFile).toHaveBeenCalledWith(11, pdf)
    expect(await screen.findByRole('status')).toHaveTextContent('Dodano skan skan.pdf.')
  })

  it('adds a certificate (AVSEC by default) and keeps the page in the address', async () => {
    api.driver.mockResolvedValue({ ...DRIVER_DETAILS, certs: [] })
    api.drivers.mockResolvedValue(DRIVERS)
    api.createCert.mockResolvedValue(12)
    render(<DriverPage driverId={5} onBack={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Dodaj certyfikat' }))
    await userEvent.type(screen.getByLabelText('Numer'), 'AV-123')
    fireEvent.change(screen.getByLabelText('Ważny do'), { target: { value: '2027-03-31' } })
    const buttons = screen.getAllByRole('button', { name: 'Dodaj certyfikat' })
    await userEvent.click(buttons[buttons.length - 1]!)
    expect(api.createCert).toHaveBeenCalledWith(5, { kind: 'AVSEC', number: 'AV-123', validTo: '2027-03-31', notes: '' })
    expect(parseDriverHash('#/kierowca/5')).toEqual({ id: 5 })
    expect(parseDriverHash('#/auto/5')).toBeNull()
  })

  it('the set page links the driver and lists his changes', async () => {
    api.truckView.mockResolvedValue(TRUCK_VIEW())
    const openDriver = vi.fn()
    render(<TruckPage truckId={1} date="2026-09-23" mode="week" onBack={() => {}} onNavigate={() => {}} onOpenDriver={openDriver} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Kierowca A' }))
    expect(openDriver).toHaveBeenCalledWith(5)
    expect(screen.getByText('Historia kierowców (2)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /AVSEC wygasa 01\.10/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Zlecenia (1)' }))
    expect(within(screen.getByRole('tabpanel')).getByRole('columnheader', { name: 'Kierowca' })).toBeInTheDocument()
  })
})

describe('paczka 12.10.2026', () => {
  const bar = (over: Partial<WeekBar>): WeekBar => ({ ...WEEK.trucks[0]!.bars[0]!, ...over })

  it('the week column: our / carrier revenue and EUR/KM; money hidden together; short order count', async () => {
    api.week.mockResolvedValue(WEEK)
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    expect(await screen.findByText('1 500 € / 1 300 €')).toBeInTheDocument()
    expect(screen.getByText('2,21 € / 1,91 €')).toBeInTheDocument()
    expect(screen.getByText('1 zlecenie')).toBeInTheDocument()
    expect(screen.queryByText(/puste ·|Na km · puste/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Pokaż kwoty'))
    expect(screen.queryByText('2,21 € / 1,91 €')).not.toBeInTheDocument()
    expect(screen.getAllByText('≈680 km').length).toBeGreaterThan(0)
  })

  it('order counts in Polish, with preliminary orders mentioned only when there are any', () => {
    expect(ordersWithDrafts(1, 0)).toBe('1 zlecenie')
    expect(ordersWithDrafts(23, 0)).toBe('23 zlecenia')
    expect(ordersWithDrafts(12, 0)).toBe('12 zleceń')
    expect(ordersWithDrafts(27, 2)).toBe('27 zleceń (w tym 2 wstępne)')
    expect(ordersWithDrafts(27, 5)).toBe('27 zleceń (w tym 5 wstępnych)')
  })

  it('two orders sharing a day go in one row when the first is unloaded before the second is loaded', () => {
    const a = bar({ key: 'a', orderNo: 'A', startDay: 1, endDay: 2, startDate: '2026-09-22', endDate: '2026-09-23', endTime: '16:00' })
    const b = bar({ key: 'b', orderNo: 'B', startDay: 2, endDay: 2, startDate: '2026-09-23', endDate: '2026-09-23', startTime: '17:00', endTime: '23:00' })
    const placed = placeBars([a, b])
    expect(placed.map(p => [p.orderNo, p.lane, p.colStart, p.colEnd])).toEqual([
      ['A', 1, 3, 6],
      ['B', 1, 6, 7],
    ])
    // Unknown hour or loading before the unloading: two rows, whole days.
    expect(placeBars([a, { ...b, startTime: null }]).map(p => p.lane)).toEqual([1, 2])
    expect(placeBars([a, { ...b, startTime: '12:00' }]).map(p => [p.lane, p.colStart])).toEqual([
      [1, 3],
      [2, 5],
    ])
    // A one-day bar that already starts at noon cannot end at noon too.
    const c = bar({ key: 'c', orderNo: 'C', startDay: 2, endDay: 2, startDate: '2026-09-23', endDate: '2026-09-23', startTime: '23:30', endTime: '23:59' })
    expect(placeBars([a, b, c]).map(p => [p.orderNo, p.lane])).toEqual([
      ['A', 1],
      ['B', 1],
      ['C', 2],
    ])
  })

  it('a preliminary order from "+" under a day', async () => {
    api.week.mockResolvedValue(WEEK)
    api.places.mockResolvedValue([])
    api.createDraft.mockResolvedValue('W-1')
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Dodaj zdarzenie: AA1050H, 24.09' }))
    await userEvent.selectOptions(screen.getByLabelText('Rodzaj'), 'draft')
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Zlecenie wstępne · AA1050H/)).toBeInTheDocument()
    const [loadPlace, unloadPlace] = within(dialog).getAllByLabelText('Miejsce')
    await userEvent.type(loadPlace!, 'Wiedeń')
    await userEvent.type(unloadPlace!, 'Wilno')
    await userEvent.type(within(dialog).getByLabelText('Stawka klienta (€)'), '3620')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dodaj zlecenie wstępne' }))
    expect(api.createDraft).toHaveBeenCalledWith({
      truckId: 1,
      loadPlaces: 'Wiedeń',
      loadDate: '2026-09-24',
      loadTime: null,
      unloadPlaces: 'Wilno',
      unloadDate: '2026-09-25',
      unloadTime: null,
      client: '',
      rev: '3620',
      cost: null,
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Dodano zlecenie wstępne W-1')
  })

  it('the order panel of a preliminary order: banner, edit and delete after a confirmation', async () => {
    api.week.mockResolvedValue({ ...WEEK, trucks: [{ ...WEEK.trucks[0]!, bars: [bar({ orderNo: 'W-1', key: 'W-1|0', draft: true })] }] })
    api.order.mockResolvedValue({
      ...ORDER,
      order: {
        ...ORDER.order,
        orderNo: 'W-1',
        draftNoMoney: true,
        draft: { truckId: 1, loadPlaces: 'Wiedeń', loadDate: '2026-09-22', loadTime: null, unloadPlaces: 'Wilno', unloadDate: '2026-09-23', unloadTime: null, client: '', rev: 3620, cost: null },
      },
    })
    api.deleteDraft.mockResolvedValue({ ok: true })
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    const barButton = await screen.findByRole('button', { name: /W-1, zlecenie wstępne/ })
    expect(within(barButton).getByText(/wstępne/)).toBeInTheDocument()
    await userEvent.click(barButton)
    const panel = await screen.findByRole('complementary', { name: 'Szczegóły zlecenia' })
    expect(await within(panel).findByText(/Bez obu kwot nie liczy się w sumach/)).toBeInTheDocument()
    expect(within(panel).queryByText('Ręczne poprawki')).not.toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Usuń' }))
    await userEvent.click(within(panel).getByRole('button', { name: 'Usuń' }))
    expect(api.deleteDraft).toHaveBeenCalledWith('W-1')
  })

  it('review: a preliminary order with two possible orders is settled by choosing one', async () => {
    api.issues.mockResolvedValue([
      issue({ id: 7, kind: 'DRAFT_MATCH', ref: 'W-3', message: 'Zlecenie wstępne W-3 pasuje do kilku nowych zleceń', details: { candidates: ['79-1-26', '79-2-26'] } }),
    ])
    api.fleet.mockResolvedValue(FLEET)
    api.imports.mockResolvedValue([])
    api.resolveIssue.mockResolvedValue({ ok: true })
    render(<ReviewPage onOpenOrder={() => {}} onIssuesChanged={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Zastąp zleceniem 79-2-26' }))
    expect(api.resolveIssue).toHaveBeenCalledWith(7, 'replace', { orderNo: '79-2-26' })
  })
})

describe('day events (12.10.2026 bug)', () => {
  const withNote = (): WeekView => ({
    ...WEEK,
    trucks: [
      {
        ...WEEK.trucks[0]!,
        events: [{ id: 2, day: '2026-09-24', kind: 'note', text: 'TEST', auto: false, place: 'POZ', placeName: 'Poznań', createdBy: 'Wojciech', createdAt: '2026-10-12T13:37:47Z' }],
      },
    ],
  })

  it('shows the place on the chip and opens it for correcting', async () => {
    api.week.mockResolvedValue(withNote())
    api.updateEvent.mockResolvedValue({ ok: true })
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Notatka: POZ: TEST' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/dodał Wojciech/)).toBeInTheDocument()
    const place = within(dialog).getByLabelText(/Miejsce/)
    expect(place).toHaveValue('POZ')
    await userEvent.clear(place)
    await userEvent.type(within(dialog).getByLabelText('Opis'), ' — klient w Poznaniu')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Zapisz' }))
    expect(api.updateEvent).toHaveBeenCalledWith(2, { text: 'TEST — klient w Poznaniu', place: '' })
    expect(await screen.findByRole('status')).toHaveTextContent('Zapisano zdarzenie.')
  })

  it('deletes after a confirmation', async () => {
    api.week.mockResolvedValue(withNote())
    api.deleteNote.mockResolvedValue({ ok: true })
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Notatka: POZ: TEST' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Usuń' }))
    expect(api.deleteNote).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Usuń' }))
    expect(api.deleteNote).toHaveBeenCalledWith(2)
  })
})

describe('paczka 26.10.2026', () => {
  it('"Popraw ręcznie" offers one "Km razem" instead of four km fields; corrected km are marked', async () => {
    api.week.mockResolvedValue(WEEK)
    api.order.mockResolvedValue({
      ...ORDER,
      legs: [{ ...ORDER.legs[0]!, kmLoaded: 1100, kmEmpty: 150, kmEstimated: false, kmManual: true }],
      overrides: [
        { field: 'km_total', value: '1250', display: '1250', createdAt: '2026-10-26T10:00:00Z' },
        { field: 'km_loaded', value: '590', display: '590', createdAt: '2026-10-09T10:00:00Z' },
      ],
    })
    api.setOverride.mockResolvedValue({ ok: true })
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /79-1000-26, Warszawa/ }))
    const panel = await screen.findByRole('complementary', { name: 'Szczegóły zlecenia' })
    expect(await within(panel).findByText(/razem 1\D?250 km \(poprawione\)/)).toBeInTheDocument()
    expect(within(panel).getByText(/Km razem:/)).toBeInTheDocument()
    expect(within(panel).getByText(/Km z ładunkiem:/)).toBeInTheDocument() // an older correction stays visible
    await userEvent.click(within(panel).getByRole('button', { name: 'Popraw ręcznie' }))
    const select = within(panel).getByLabelText('Co poprawić')
    const options = within(select).getAllByRole('option').map(o => o.textContent)
    expect(options).toContain('Km razem')
    expect(options.some(o => o?.startsWith('Km z ładunkiem') || o?.startsWith('Km puste'))).toBe(false)
    await userEvent.selectOptions(select, 'km_total')
    await userEvent.type(within(panel).getByLabelText('Nowa wartość'), '1300')
    await userEvent.click(within(panel).getByRole('button', { name: 'Zapisz poprawkę' }))
    expect(api.setOverride).toHaveBeenCalledWith('79-1000-26', 'km_total', '1300')
  })

  it('a relay typed on the board is labelled as a manual correction', async () => {
    api.week.mockResolvedValue(WEEK)
    api.order.mockResolvedValue({
      ...ORDER,
      order: {
        ...ORDER.order,
        prz: { place: 'ŁÓDŹ', placeCode: 'LCJ', date: '2026-09-22', from: 'AA1050H', to: 'AA2050H', amountFrom: 700, amountTo: 600, raw: 'PRZ ŁÓDŹ 22.09 AA1050H>AA2050H 700/600' },
        przManual: { createdBy: 'Wojciech', createdAt: '2026-10-12T09:31:00Z' },
      },
    })
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /79-1000-26, Warszawa/ }))
    const panel = await screen.findByRole('complementary', { name: 'Szczegóły zlecenia' })
    expect(await within(panel).findByText('Przepinka (ręczna poprawka)')).toBeInTheDocument()
    expect(within(panel).queryByText('Przepinka z uwag')).not.toBeInTheDocument()
    expect(within(panel).getByText(/Wpisana na tablicy: Wojciech/)).toBeInTheDocument()
  })

  it('"Czy była przepinka?" opens both orders; a withdrawn tractor with a later order can be brought back', async () => {
    api.issues.mockResolvedValue([
      issue({ id: 7, kind: 'ROUTE_GAP', ref: '79-9018-26', message: 'Czy była przepinka? KN0000X: …', details: { orders: ['79-9013-26', '79-9018-26'] } }),
      issue({ id: 8, kind: 'NEW_TRUCK', ref: 'AA1050H', message: 'Ciągnik AA1050H jest wycofany z działu…', details: { retiredTruckId: 1, retiredOn: '2026-10-14' } }),
    ])
    api.fleet.mockResolvedValue(FLEET)
    api.imports.mockResolvedValue([])
    api.resolveIssue.mockResolvedValue({ ok: true })
    const open = vi.fn()
    render(<ReviewPage onOpenOrder={open} onIssuesChanged={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Otwórz 79-9013-26' }))
    expect(open).toHaveBeenCalledWith('79-9013-26')
    expect(screen.getByRole('button', { name: 'Otwórz 79-9018-26' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'W porządku' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Dodaj jako nowe auto' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Przywróć AA1050H do działu' }))
    expect(api.resolveIssue).toHaveBeenCalledWith(8, 'restore', {})
  })

  it('the import card tells a partial export apart', async () => {
    api.issues.mockResolvedValue([])
    api.fleet.mockResolvedValue(FLEET)
    api.imports.mockResolvedValue([
      {
        id: 15,
        filename: 'export (27).xlsx',
        imported_at: '2026-10-26T13:49:47Z',
        summary: {
          importId: 15, filename: 'export (27).xlsx', mode: 'daily', importedAt: '2026-10-26T13:49:47Z', rowsTotal: 2, rowsInScope: 2, rowsOwnFleet: 0, rowsOtherCarriers: 0,
          rangeFrom: '2026-10-26', rangeTo: '2026-10-26', created: ['79-9040-26'], updated: [], unchanged: 1, disappeared: [], reappeared: [], supersededOverrides: [],
          newTruckCandidates: [], warnings: [], partial: { found: 2, missing: 3 },
        },
      },
    ])
    render(<ReviewPage onOpenOrder={() => {}} onIssuesChanged={() => {}} />)
    expect(await screen.findByText(/Niepełny eksport: w pliku 2 z 5 zleceń, które tablica ma w dniu 26\.10\. Tablica dodała nowe/)).toBeInTheDocument()
  })

  it('withdraws a tractor with its last day and moves the driver; lists it under "Wycofane z działu"', async () => {
    const second: FleetTruck = { ...FLEET[0]!, id: 2, currentPlate: 'AA2050H', plates: [{ id: 2, plate: 'AA2050H', validFrom: '2024-01-01', validTo: null }], driver: 'Kierowca B', driverId: 6, sortOrder: 2 }
    api.fleet.mockResolvedValueOnce([...FLEET, second]).mockResolvedValue([{ ...FLEET[0]!, retiredOn: '2026-10-14', plates: [{ id: 1, plate: 'AA1050H', validFrom: '2024-01-01', validTo: '2026-10-14' }] }, second])
    api.retireTruck.mockResolvedValue({ plate: 'AA1050H', driverMovedTo: 'AA2050H' })
    api.restoreTruck.mockResolvedValue({ plate: 'AA1050H' })
    api.drivers.mockResolvedValue([])
    render(<FleetPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Ciągniki' }))
    await userEvent.click((await screen.findAllByRole('button', { name: 'Wycofaj' }))[0]!)
    const day = screen.getByLabelText('Ostatni dzień w dziale')
    await userEvent.clear(day)
    await userEvent.type(day, '2026-10-14')
    await userEvent.selectOptions(screen.getByLabelText('Kierowca Kierowca A od następnego dnia'), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Wycofaj AA1050H' }))
    expect(api.retireTruck).toHaveBeenCalledWith(1, '2026-10-14', 2)
    expect(await screen.findByRole('status')).toHaveTextContent('AA1050H wycofany — ostatni dzień 14.10.2026. Kierowca A od 15.10.2026 jeździ AA2050H.')
    expect(screen.getByText('Wycofane z działu (1)')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Przywróć' }))
    expect(api.restoreTruck).toHaveBeenCalledWith(1)
  })

  it('the footer names the last full export and a later partial one', async () => {
    api.week.mockResolvedValue({
      ...WEEK,
      lastImport: { importedAt: '2026-10-26T10:07:00Z', filename: 'export (26).xlsx', supplement: { importedAt: '2026-10-26T13:49:00Z', filename: 'export (27).xlsx', orders: 2 } },
    })
    render(<WeekPage focus={null} initialDate="2026-09-23" onReview={() => {}} />)
    expect(await screen.findByText(/Dane z importu .*\(export \(26\)\.xlsx\) · uzupełnienie .*\(2 zlecenia z export \(27\)\.xlsx\)\./)).toBeInTheDocument()
  })
})
