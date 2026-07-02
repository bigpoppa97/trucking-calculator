/** EUR, 2 decimals, Polish locale (comma decimal separator) — PRD §5.4. */
const eurFormat = new Intl.NumberFormat('pl-PL', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatEur(value: number): string {
  return eurFormat.format(value)
}

const kmFormat = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 })

export function formatKm(value: number): string {
  return `${kmFormat.format(value)} km`
}

export function formatPercent(value: number): string {
  return `${new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 }).format(value)}%`
}
