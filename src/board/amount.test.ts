import { describe, expect, it } from 'vitest'
import { parseNumberInput } from './amount.js'

describe('parseNumberInput (hand-typed corrections)', () => {
  it('reads amounts and kilometres typed with a unit, spaces or a decimal comma', () => {
    expect(parseNumberInput('2350e')).toBe(2350)
    expect(parseNumberInput('2 350 €')).toBe(2350)
    expect(parseNumberInput('2350,50 EUR')).toBe(2350.5)
    expect(parseNumberInput('2350.5')).toBe(2350.5)
    expect(parseNumberInput('590 km')).toBe(590)
    expect(parseNumberInput('0')).toBe(0)
  })

  it('rejects anything that is not clearly one non-negative number', () => {
    for (const bad of ['', 'abc', '2350 zł', '350+2000', '-100', '2350e5x', '12.10.2026']) {
      expect(parseNumberInput(bad)).toBeNull()
    }
    expect(parseNumberInput(undefined)).toBeNull()
  })
})
