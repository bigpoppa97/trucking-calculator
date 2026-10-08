import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError } from '../lib/api.js'
import type { UserDto, UserRole } from '../lib/types.js'

/** Admin-only user management: no self-registration (PRD §5.1). */

const ROLE_LABELS: Record<UserRole, string> = {
  dispatcher: 'dyspozytor',
  finance: 'finanse',
  admin: 'administrator',
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; users: UserDto[] }

export function UsersPage() {
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setList({ kind: 'ready', users: await api.listUsers() })
    } catch (error) {
      setList({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'Nie udało się wczytać listy użytkowników.',
      })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (list.kind === 'loading') return <p className="p-6 text-sm text-slate-500">Wczytywanie użytkowników…</p>
  if (list.kind === 'error') {
    return (
      <p role="alert" className="m-6 rounded bg-red-50 px-4 py-3 text-sm text-red-700">
        {list.message}
      </p>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      {actionError !== null && (
        <p role="alert" className="rounded bg-red-50 px-4 py-3 text-sm text-red-700">
          {actionError}
        </p>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-slate-800">Użytkownicy ({list.users.length})</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
              <th className="py-1.5 pr-2 font-medium">E-mail</th>
              <th className="py-1.5 pr-2 font-medium">Nazwa</th>
              <th className="py-1.5 pr-2 font-medium">Rola</th>
              <th className="py-1.5 pr-2 font-medium">Status</th>
              <th className="py-1.5 font-medium">Akcje</th>
            </tr>
          </thead>
          <tbody>
            {list.users.map(user => (
              <UserRow key={user.id} user={user} onChanged={refresh} onError={setActionError} />
            ))}
          </tbody>
        </table>
      </section>

      <CreateUserForm onCreated={refresh} onError={setActionError} />
    </div>
  )
}

function UserRow({
  user,
  onChanged,
  onError,
}: {
  user: UserDto
  onChanged: () => Promise<void>
  onError: (message: string | null) => void
}) {
  const [busy, setBusy] = useState(false)

  const patch = async (body: { role?: UserRole; active?: boolean; password?: string }) => {
    onError(null)
    setBusy(true)
    try {
      await api.patchUser(user.id, body)
      await onChanged()
    } catch (error) {
      onError(error instanceof ApiError ? error.message : 'Nie udało się zapisać zmiany.')
    } finally {
      setBusy(false)
    }
  }

  const resetPassword = async () => {
    const password = window.prompt(`Nowe hasło dla ${user.email} (min. 8 znaków):`)
    if (password === null) return
    if (password.length < 8) {
      onError('Hasło musi mieć co najmniej 8 znaków.')
      return
    }
    await patch({ password })
  }

  return (
    <tr className="border-b border-slate-100">
      <td className="py-1.5 pr-2 font-medium text-slate-800">{user.email}</td>
      <td className="py-1.5 pr-2">{user.displayName}</td>
      <td className="py-1.5 pr-2">
        <label className="sr-only" htmlFor={`role-${user.id}`}>
          Rola {user.email}
        </label>
        <select
          id={`role-${user.id}`}
          value={user.role}
          disabled={busy}
          onChange={e => void patch({ role: e.target.value as UserRole })}
          className="rounded border border-slate-300 px-2 py-1 text-xs"
        >
          {(Object.keys(ROLE_LABELS) as UserRole[]).map(role => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </td>
      <td className="py-1.5 pr-2 text-xs">
        {user.active ? (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-800">aktywne</span>
        ) : (
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-slate-600">wyłączone</span>
        )}
      </td>
      <td className="py-1.5">
        <span className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void patch({ active: !user.active })}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {user.active ? 'Dezaktywuj' : 'Aktywuj'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void resetPassword()}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Zresetuj hasło
          </button>
        </span>
      </td>
    </tr>
  )
}

function CreateUserForm({
  onCreated,
  onError,
}: {
  onCreated: () => Promise<void>
  onError: (message: string | null) => void
}) {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<UserRole>('dispatcher')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    onError(null)
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      onError('Podaj prawidłowy adres e-mail.')
      return
    }
    if (displayName.trim() === '') {
      onError('Podaj nazwę użytkownika.')
      return
    }
    if (password.length < 8) {
      onError('Hasło musi mieć co najmniej 8 znaków.')
      return
    }
    setBusy(true)
    try {
      await api.createUser({ email: email.trim(), displayName: displayName.trim(), role, password })
      setEmail('')
      setDisplayName('')
      setRole('dispatcher')
      setPassword('')
      await onCreated()
    } catch (error) {
      onError(error instanceof ApiError ? error.message : 'Nie udało się utworzyć konta.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-base font-semibold text-slate-800">Nowe konto</h2>
      <form onSubmit={e => void submit(e)} className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="new-user-email" className="text-xs font-medium text-slate-600">
            E-mail
          </label>
          <input
            id="new-user-email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-user-name" className="text-xs font-medium text-slate-600">
            Nazwa
          </label>
          <input
            id="new-user-name"
            type="text"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-user-role" className="text-xs font-medium text-slate-600">
            Rola
          </label>
          <select
            id="new-user-role"
            value={role}
            onChange={e => setRole(e.target.value as UserRole)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            {(Object.keys(ROLE_LABELS) as UserRole[]).map(r => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-user-password" className="text-xs font-medium text-slate-600">
            Hasło startowe
          </label>
          <input
            id="new-user-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="col-span-2 md:col-span-4">
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            Utwórz konto
          </button>
        </div>
      </form>
    </section>
  )
}
