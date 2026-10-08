import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, setUnauthenticatedHandler } from './api.js'
import type { UserDto } from './types.js'

export interface AuthState {
  /** undefined = still checking the session, null = signed out. */
  user: UserDto | null | undefined
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
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

  useEffect(() => {
    setUnauthenticatedHandler(() => setUser(null))
    void api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
    return () => setUnauthenticatedHandler(null)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    setUser(await api.login(email, password))
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch (error) {
      // Losing the server-side session call is not fatal — drop local state.
      if (!(error instanceof ApiError)) throw error
    }
    setUser(null)
  }, [])

  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>
}
