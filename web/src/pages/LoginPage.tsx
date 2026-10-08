import { useState, type FormEvent } from 'react'
import { ApiError } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'

export function LoginPage() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    if (email.trim() === '' || password === '') {
      setError('Podaj adres e-mail i hasło.')
      return
    }
    setBusy(true)
    try {
      await login(email.trim(), password)
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'INVALID_CREDENTIALS'
          ? 'Nieprawidłowy e-mail lub hasło.'
          : err instanceof ApiError
            ? err.message
            : 'Nie udało się zalogować. Spróbuj ponownie.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <form
        onSubmit={e => void submit(e)}
        className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h1 className="mb-1 text-lg font-bold text-slate-900">Kalkulator kosztów transportu</h1>
        <p className="mb-4 text-sm text-slate-500">Zaloguj się, aby kontynuować.</p>

        {error !== null && (
          <p role="alert" className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="mb-3 flex flex-col gap-1">
          <label htmlFor="login-email" className="text-xs font-medium text-slate-600">
            E-mail
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="mb-4 flex flex-col gap-1">
          <label htmlFor="login-password" className="text-xs font-medium text-slate-600">
            Hasło
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {busy ? 'Logowanie…' : 'Zaloguj się'}
        </button>
        <p className="mt-3 text-xs text-slate-400">
          Nie masz konta? Skontaktuj się z administratorem — samodzielna rejestracja jest wyłączona.
        </p>
      </form>
    </div>
  )
}
