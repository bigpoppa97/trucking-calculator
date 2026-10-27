import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RouteDetailsDto, TollItemDto } from '../lib/types.js'
import { groupTollItems, RecalcTollsPanel, TollCheckDetails } from './TollCheck.js'

vi.mock('../lib/api.js', async importOriginal => {
  const original = await importOriginal<typeof import('../lib/api.js')>()
  return { ...original, api: { recalculateTolls: vi.fn() } }
})
const { api } = await import('../lib/api.js')
const mocked = vi.mocked(api)

const item = (over: Partial<TollItemDto> = {}): TollItemDto => ({
  country: 'PL',
  tollSystem: 'A2 AUTOSTRADA WIELKOPOLSKA',
  gates: [],
  gateCoords: [],
  hereEur: 94,
  finalEur: 38.8,
  originalPrice: 400,
  originalCurrency: 'PLN',
  ruleId: 1,
  ruleSignature: '1|replace_per_gate|165|',
  ruleApplied: true,
  ...over,
})

const ROUTE: RouteDetailsDto = {
  id: 1,
  routeCode: 'LCJ-BER',
  stops: ['LCJ', 'BER'],
  totalKm: 454.5,
  kmSource: 'here',
  kmNote: null,
  kmUpdatedBy: null,
  kmUpdatedAt: null,
  countryKm: { PL: 371.1, DE: 81.8 },
  tolls: [
    { country: 'PL', tollEur: 302.52, status: 'estimate', fetchedAt: null, verifiedBy: null, verifiedAt: null },
    { country: 'DE', tollEur: 27.84, status: 'verified', fetchedAt: null, verifiedBy: 'kasia', verifiedAt: null },
  ],
  tollsPendingCountries: [],
  polylineSections: null,
  tollCheck: null,
}

beforeEach(() => vi.clearAllMocks())

describe('groupTollItems / TollCheckDetails', () => {
  it('one row per system and rule, gate names and gate prices collected', () => {
    const groups = groupTollItems([
      item({ gates: ['Nowy Tomyśl'] }),
      item({ gates: ['Września'], originalPrice: 440 }),
      item({ ruleId: 2, gates: ['Świecko'], hereEur: 28, finalEur: 9.4, originalPrice: 120 }),
      item({ tollSystem: 'E-TOLL A/S', ruleId: null, ruleApplied: false, hereEur: 13, finalEur: 13, originalPrice: 55 }),
    ])
    expect(groups.map(g => [g.tollSystem, g.ruleId, g.count, g.gates, g.prices])).toEqual([
      ['A2 AUTOSTRADA WIELKOPOLSKA', 1, 2, ['Nowy Tomyśl', 'Września'], ['400 PLN', '440 PLN']],
      ['A2 AUTOSTRADA WIELKOPOLSKA', 2, 1, ['Świecko'], ['120 PLN']],
      ['E-TOLL A/S', null, 1, [], ['55 PLN']],
    ])
  })

  it('renders the exact HERE system name', () => {
    render(<TollCheckDetails open check={{ checkedAt: '2026-10-27T12:00:00Z', items: [item({ gates: ['Świecko'] })], warnings: [] }} />)
    expect(screen.getByText('A2 AUTOSTRADA WIELKOPOLSKA')).toBeInTheDocument()
    expect(screen.getByText(/Bramki: Świecko/)).toBeInTheDocument()
    expect(screen.getByText('reguła korekty zastosowana')).toBeInTheDocument()
  })
})

describe('RecalcTollsPanel', () => {
  it('is hidden when every toll is verified and the route was never checked', () => {
    const { container } = render(
      <RecalcTollsPanel route={{ ...ROUTE, tolls: ROUTE.tolls.map(t => ({ ...t, status: 'verified' as const })) }} onRecalculated={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('recalculates after confirmation and shows before/after, warnings and the new route', async () => {
    const updated = { ...ROUTE, tolls: [{ ...ROUTE.tolls[0]!, tollEur: 151.2 }, ROUTE.tolls[1]!] }
    mocked.recalculateTolls.mockResolvedValue({
      route: updated,
      summary: {
        changes: [
          { country: 'DE', beforeEur: 27.84, hereEur: 27.9, outcome: 'kept-verified' },
          { country: 'PL', beforeEur: 302.52, hereEur: 151.2, outcome: 'updated' },
        ],
        hereTotalKm: 452.9,
        warnings: [],
        tollCheck: { checkedAt: '2026-10-27T12:00:00Z', items: [item()], warnings: ['PL: podejrzanie wysoka opłata — test'] },
      },
    })
    const onRecalculated = vi.fn()
    const user = userEvent.setup()
    render(<RecalcTollsPanel route={ROUTE} onRecalculated={onRecalculated} />)

    await user.click(screen.getByRole('button', { name: 'Przelicz opłaty z HERE' }))
    expect(mocked.recalculateTolls).not.toHaveBeenCalled() // confirmation first — it costs a HERE request
    await user.click(screen.getByRole('button', { name: 'Przelicz' }))

    expect(await screen.findByText('Opłaty przeliczone z HERE ✓')).toBeInTheDocument()
    expect(mocked.recalculateTolls).toHaveBeenCalledWith('LCJ-BER')
    expect(onRecalculated).toHaveBeenCalledWith(updated)
    expect(screen.getByText('zaktualizowano (szacunek)')).toBeInTheDocument()
    expect(screen.getByText('zweryfikowana — bez zmian')).toBeInTheDocument()
    expect(screen.getByText(/Uwagi do opłat: 1/)).toBeInTheDocument()
  })
})
