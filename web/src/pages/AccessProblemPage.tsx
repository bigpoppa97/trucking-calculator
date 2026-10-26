import { ACCESS_LOGOUT_URL } from '../lib/api.js'
import type { AccessProblem, AccessProblemCode } from '../lib/auth.js'

const TITLES: Record<AccessProblemCode, string> = {
  NO_ACCOUNT: 'Brak dostępu do tablicy',
  ACCESS_INVALID: 'Nie udało się potwierdzić logowania',
  ACCESS_REQUIRED: 'Dostęp z internetu zablokowany',
  ACCESS_NOT_CONFIGURED: 'Dostęp z internetu nie jest jeszcze ustawiony',
}

/**
 * Shown when the board is opened from the internet and cannot accept the login:
 * the Access email has no active account in Użytkownicy, the Access login could not
 * be verified (CF_ACCESS_* settings), no Access application is in front of the
 * address, or the tunnel runs before .env has the Access settings.
 */
export function AccessProblemPage({ problem }: { problem: AccessProblem }) {
  const title = TITLES[problem.code]
  // Signing out of Cloudflare only helps when Access is actually in front of the board.
  const canSwitchAccount = problem.code === 'NO_ACCOUNT' || problem.code === 'ACCESS_INVALID'
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-2 text-lg font-bold text-slate-900">{title}</h1>
        <p role="alert" className="mb-5 text-sm text-slate-600">
          {problem.message}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700"
          >
            Odśwież
          </button>
          {canSwitchAccount && (
            <a
              href={ACCESS_LOGOUT_URL}
              className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Zaloguj się innym kontem
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
