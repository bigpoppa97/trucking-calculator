import { ACCESS_LOGOUT_URL } from '../lib/api.js'
import type { AccessProblem } from '../lib/auth.js'

/**
 * Shown when Cloudflare Access signed someone in (Microsoft 365) whom the board
 * cannot accept: the address has no active account in Użytkownicy, or the Access
 * login could not be verified (wrong CF_ACCESS_* settings on the server).
 */
export function AccessProblemPage({ problem }: { problem: AccessProblem }) {
  const title = problem.code === 'NO_ACCOUNT' ? 'Brak dostępu do tablicy' : 'Nie udało się potwierdzić logowania'
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
          <a
            href={ACCESS_LOGOUT_URL}
            className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Zaloguj się innym kontem
          </a>
        </div>
      </div>
    </div>
  )
}
