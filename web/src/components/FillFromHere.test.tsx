import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GapFillResultDto, RouteDetailsDto } from '../lib/types.js'
import { FillFromHerePanel, hasGaps, routeGaps } from './FillFromHere.js'

vi.mock('../lib/api.js', async importOriginal => {
  const original = await importOriginal<typeof import('../lib/api.js')>()
  return { ...original, api: { fillRouteFromHere: vi.fn() } }
})
const { api, ApiError } = await import('../lib/api.js')
const mocked = vi.mocked(api)

// The real WAW-MAD v1 import: sheet had only PL/DE columns and zero tolls.
const WAW_MAD: RouteDetailsDto = {
  id: 5,
  routeCode: 'WAW-MAD',
  stops: ['WAW', 'MAD'],
  totalKm: 2842,
  kmSource: 'manual',
  kmNote: null,
  kmUpdatedBy: null,
  kmUpdatedAt: null,
  countryKm: { PL: 466, DE: 705 },
  tolls: [],
  tollsPendingCountries: ['PL', 'DE'],
  polylineSections: null,
}

const FILLED: GapFillResultDto = {
  route: {
    ...WAW_MAD,
    countryKm: { PL: 466, DE: 705, BE: 160.2, FR: 1050.4, ES: 455.7 },
    tolls: [
      { country: 'PL', tollEur: 60.1, status: 'estimate', fetchedAt: 'x', verifiedBy: null, verifiedAt: null },
      { country: 'DE', tollEur: 245.3, status: 'estimate', fetchedAt: 'x', verifiedBy: null, verifiedAt: null },
      { country: 'BE', tollEur: 30, status: 'estimate', fetchedAt: 'x', verifiedBy: null, verifiedAt: null },
      { country: 'FR', tollEur: 312.4, status: 'estimate', fetchedAt: 'x', verifiedBy: null, verifiedAt: null },
    ],
    tollsPendingCountries: ['ES'],
  },
  summary: {
    addedCountryKm: { BE: 160.2, FR: 1050.4, ES: 455.7 },
    addedTolls: { PL: 60.1, DE: 245.3, BE: 30, FR: 312.4 },
    keptTollCountries: [],
    stillPendingCountries: ['ES'],
    hereTotalKm: 2851.6,
    warnings: ['Section 1: something HERE said'],
  },
}

beforeEach(() => vi.clearAllMocks())

describe('routeGaps / hasGaps', () => {
  it('flags pending tolls and a country split that misses part of the route', () => {
    expect(routeGaps(WAW_MAD)).toEqual({ pendingCountries: ['PL', 'DE'], coveredKm: 1171, kmIncomplete: true })
    expect(hasGaps(WAW_MAD)).toBe(true)
  })

  it('tolerates small rounding gaps in the split', () => {
    // v1 WAW-BER-FRA: 1108 of 1111 km
    expect(hasGaps({ totalKm: 1111, countryKm: { PL: 466, DE: 642 }, tollsPendingCountries: [] })).toBe(false)
  })
})

describe('FillFromHerePanel', () => {
  it('renders nothing for a complete route', () => {
    const { container } = render(
      <FillFromHerePanel
        route={{ ...WAW_MAD, countryKm: { PL: 1400, DE: 1442 }, tollsPendingCountries: [] }}
        onFilled={() => {}}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('confirms first, then fills and keeps the summary visible after the route has no gaps', async () => {
    const user = userEvent.setup()
    mocked.fillRouteFromHere.mockResolvedValue(FILLED)
    const onFilled = vi.fn()
    const { rerender } = render(<FillFromHerePanel route={WAW_MAD} onFilled={onFilled} />)

    expect(screen.getByText('Brak opłat dla: PL, DE.')).toBeInTheDocument()
    expect(screen.getByText(/pokrywają 1171 km z 2842 km/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Uzupełnij z HERE' }))
    expect(screen.getByText(/łączne km \(2842 km\) zostaną bez zmian/)).toBeInTheDocument()
    expect(mocked.fillRouteFromHere).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Pobierz z HERE' }))
    await waitFor(() => expect(onFilled).toHaveBeenCalledWith(FILLED.route))
    expect(mocked.fillRouteFromHere).toHaveBeenCalledWith('WAW-MAD')

    // Parent re-renders with the filled route — summary must stay.
    rerender(<FillFromHerePanel route={{ ...FILLED.route, tollsPendingCountries: [] }} onFilled={onFilled} />)
    expect(screen.getByText('Uzupełniono z HERE ✓')).toBeInTheDocument()
    expect(screen.getByText(/Dodane kraje: BE 160,2 km, FR 1050,4 km, ES 455,7 km/)).toBeInTheDocument()
    expect(screen.getByText(/Dodane opłaty \(szacunek\): PL 60,10 €, DE 245,30 €/)).toBeInTheDocument()
    expect(screen.getByText(/Nadal bez opłaty \(HERE jej nie wycenił\): ES/)).toBeInTheDocument()
    expect(screen.getByText('Uwagi HERE (1)')).toBeInTheDocument()
  })

  it('can be cancelled without any HERE call', async () => {
    const user = userEvent.setup()
    render(<FillFromHerePanel route={WAW_MAD} onFilled={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Uzupełnij z HERE' }))
    await user.click(screen.getByRole('button', { name: 'Anuluj' }))
    expect(screen.getByRole('button', { name: 'Uzupełnij z HERE' })).toBeInTheDocument()
    expect(mocked.fillRouteFromHere).not.toHaveBeenCalled()
  })

  it('shows the server message on failure and allows a retry', async () => {
    const user = userEvent.setup()
    mocked.fillRouteFromHere.mockRejectedValueOnce(
      new ApiError('HERE_UNAVAILABLE', 'Route service is temporarily unavailable. Please try again later.', 502),
    )
    const onFilled = vi.fn()
    render(<FillFromHerePanel route={WAW_MAD} onFilled={onFilled} />)
    await user.click(screen.getByRole('button', { name: 'Uzupełnij z HERE' }))
    await user.click(screen.getByRole('button', { name: 'Pobierz z HERE' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable')
    expect(onFilled).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Uzupełnij z HERE' })).toBeInTheDocument()
  })
})
