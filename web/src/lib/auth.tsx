import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ACCESS_LOGOUT_URL, api, ApiError, setAccessMode, setUnauthenticatedHandler, type AuthVia } from './api.js'
import type { UserDto } from './types.js'

/**
 * Reached from the internet, but the board cannot accept the login: no account for the
 * Access email, unverifiable Access login, no Access in front, or Access not set up in .env.
 */
export const ACCESS_PROBLEM_CODES = ['NO_ACCOUNT', 'ACCESS_INVALID', 'ACCESS_REQUIRED', 'ACCESS_NOT_CONFIGURED'] as const
export type AccessProblemCode = (typeof ACCESS_PROBLEM_CODES)[number]

export interface AccessProblem {
  code: AccessProblemCode
  message: string
}

const isAccessProblemCode = (code: string): code is AccessProblemCode =>
  (ACCESS_PROBLEM_CODES as readonly string[]).includes(code)

export interface AuthState {
  /** undefined = still checking the session, null = signed out. */
  user: UserDto | null | undefined
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** 'access' = signed in through Cloudflare (Microsoft 365), 'session' = board password. */
  via?: AuthVia | null
  problem?: AccessProblem | null
}

export const AuthContext = createContext<AuthState>({
  user: undefined,
  login: async () => {},
  logout: async () => {},
})

export function useAuth(): AuthState {
  return useContext(AuthContext)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null | undefined>(undefined)
  const [via, setVia] = useState<AuthVia | null>(null)
  const [problem, setProblem] = useState<AccessProblem | null>(null)

  useEffect(() => {
    setUnauthenticatedHandler(() => setUser(null))
    void api
      .me()
      .then(session => {
        setVia(session?.via ?? null)
        setAccessMode(session?.via === 'access')
        setUser(session?.user ?? null)
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && isAccessProblemCode(error.code)) {
          setProblem({ code: error.code, message: error.message })
        }
        setUser(null)
      })
    return () => setUnauthenticatedHandler(null)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    setUser(await api.login(email, password))
    setVia('session')
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch (error) {
      // Losing the server-side session call is not fatal — drop local state.
      if (!(error instanceof ApiError)) throw error
    }
    if (via === 'access') {
      // The next request would sign us straight back in — end the Cloudflare login instead.
      window.location.assign(ACCESS_LOGOUT_URL)
      return
    }
    setUser(null)
  }, [via])

  return <AuthContext.Provider value={{ user, login, logout, via, problem }}>{children}</AuthContext.Provider>
}
