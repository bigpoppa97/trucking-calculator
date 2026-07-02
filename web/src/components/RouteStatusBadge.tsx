/**
 * Route status indicator (PRD §5.3):
 * "✓ from database" / "✓ from HERE (unverified tolls)" / "⚠ new route".
 */
export type RouteStatus = 'database' | 'here-unverified' | 'new-route'

const STYLES: Record<RouteStatus, { className: string; text: string }> = {
  database: {
    className: 'bg-green-100 text-green-800 border-green-300',
    text: '✓ z bazy tras',
  },
  'here-unverified': {
    className: 'bg-amber-100 text-amber-800 border-amber-300',
    text: '✓ z HERE (opłaty niezweryfikowane)',
  },
  'new-route': {
    className: 'bg-orange-100 text-orange-800 border-orange-300',
    text: '⚠ nowa trasa — brak w bazie',
  },
}

export function RouteStatusBadge({ status }: { status: RouteStatus }) {
  const style = STYLES[status]
  return (
    <span
      data-testid="route-status"
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${style.className}`}
    >
      {style.text}
    </span>
  )
}
