import { describe, expect, it } from 'vitest'
import { parseDecimalInput, roundEur } from './money.js'

describe('roundEur', () => {
  it('rounds to 2 decimals half-up', () => {
    expect(roundEur(116.66666666)).toBe(116.67)
    expect(roundEur(37.404)).toBe(37.4)
    expect(roundEur(1.005)).toBe(1.01)
  })

  it('is tolerant of binary float noise', () => {
    expect(roundEur(680 * 0.28 * 1.4)).toBe(266.56) // raw product is 266.56000000000003
  })
})

describe('parseDecimalInput (Polish comma-decimal input, PRD §5.4)', () => {
  it.each([
    ['28,5', 28.5],
    ['1,40', 1.4],
    ['28.5', 28.5],
    ['1234', 1234],
    ['1 234,56', 1234.56],
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['  137,00 ', 137],
    ['-12,5', -12.5],
  ])('parses %s → %s', (raw, expected) => {
    expect(parseDecimalInput(raw)).toBe(expected)
  })

  it.each([['', null], ['abc', null], ['1,2,3', null], ['1.2.3', null], [',', null], ['12,', null]])(
    'rejects %s',
    raw => {
      expect(parseDecimalInput(raw as string)).toBeNull()
    },
  )
})
