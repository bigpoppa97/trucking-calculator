import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthProvider, useAuth } from './auth.js'
import { AccessProblemPage } from '../pages/AccessProblemPage.js'

const USER = { id: 1, email: 'wojciech@zet.pl', displayName: 'Wojciech', role: 'admin', active: true, createdAt: '2026-10-01' }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function Probe() {
  const { user, via, problem, logout } = useAuth()
  if (user === undefined) return <p>sprawdzanie</p>
  if (user === null) return problem ? <AccessProblemPage problem={problem} /> : <p>logowanie hasłem</p>
  return (
    <div>
      <p>
        {user.displayName} przez {via}
      </p>
      <button type="button" onClick={() => void logout()}>
        Wyloguj
      </button>
    </div>
  )
}

let fetchMock: ReturnType<typeof vi.fn>
const assign = vi.fn()

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  assign.mockReset()
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AuthProvider with Cloudflare Access', () => {
  it('signs in from the Access identity and logs out through Cloudflare', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/auth/me' ? json(200, { user: USER, via: 'access' }) : json(200, { ok: true }),
    )
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    expect(await screen.findByText('Wojciech przez access')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Wyloguj' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/cdn-cgi/access/logout'))
  })

  it('shows who has no account instead of the password form', async () => {
    fetchMock.mockResolvedValue(
      json(403, {
        error: {
          code: 'NO_ACCOUNT',
          message: 'Adres obcy@zet.pl nie ma aktywnego konta w tablicy. Poproś administratora o dodanie go w zakładce Użytkownicy.',
          email: 'obcy@zet.pl',
        },
      }),
    )
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    expect(await screen.findByRole('heading', { name: 'Brak dostępu do tablicy' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('obcy@zet.pl')
    expect(screen.getByRole('link', { name: 'Zaloguj się innym kontem' })).toHaveAttribute('href', '/cdn-cgi/access/logout')
  })

  it('shows an unverifiable Access login as a problem, not as the password form', async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: 'ACCESS_INVALID', message: 'Nie udało się potwierdzić logowania Cloudflare.' } }))
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    expect(await screen.findByRole('heading', { name: 'Nie udało się potwierdzić logowania' })).toBeInTheDocument()
  })

  it('shows a blocked internet request (no Access in front) without the password form', async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: 'ACCESS_REQUIRED', message: 'Tablica otwarta z internetu bez logowania Cloudflare Access.' } }))
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    expect(await screen.findByRole('heading', { name: 'Dostęp z internetu zablokowany' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Zaloguj się innym kontem' })).not.toBeInTheDocument()
  })

  it('keeps the password flow on localhost', async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }))
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    expect(await screen.findByText('logowanie hasłem')).toBeInTheDocument()
  })
})
