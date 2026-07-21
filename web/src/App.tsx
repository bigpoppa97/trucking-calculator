import { useState } from 'react'
import { CalculatorPage } from './pages/CalculatorPage.js'
import { RouteDbPage } from './pages/RouteDbPage.js'
import { ConfigPage } from './pages/ConfigPage.js'
import { HistoryPage } from './pages/HistoryPage.js'
import { LoginPage } from './pages/LoginPage.js'
import { UsersPage } from './pages/UsersPage.js'
import { useAuth } from './lib/auth.js'
import type { UserRole } from './lib/types.js'

type Screen = 'calculator' | 'routes' | 'config' | 'history' | 'users'

const TABS: Array<{ id: Screen; label: string; roles?: UserRole[] }> = [
  { id: 'calculator', label: 'Kalkulator' },
  { id: 'routes', label: 'Baza tras' },
  { id: 'config', label: 'Konfiguracja', roles: ['finance', 'admin'] },
  { id: 'history', label: 'Historia' },
  { id: 'users', label: 'Użytkownicy', roles: ['admin'] },
]

const ROLE_LABELS: Record<UserRole, string> = {
  dispatcher: 'dyspozytor',
  finance: 'finanse',
  admin: 'administrator',
}

export function App() {
  const { user, logout } = useAuth()
  const [screen, setScreen] = useState<Screen>('calculator')

  if (user === undefined) {
    return <p className="p-6 text-sm text-slate-500">Sprawdzanie sesji…</p>
  }
  if (user === null) {
    return <LoginPage />
  }

  const visibleTabs = TABS.filter(tab => tab.roles === undefined || tab.roles.includes(user.role))
  const activeScreen = visibleTabs.some(tab => tab.id === screen) ? screen : 'calculator'

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between p-4 pb-0">
          <h1 className="text-lg font-bold text-slate-900">Kalkulator kosztów transportu</h1>
          <span className="flex items-center gap-3 text-xs text-slate-500">
            <span>
              {user.displayName} · {ROLE_LABELS[user.role]}
            </span>
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              Wyloguj
            </button>
          </span>
        </div>
        <nav aria-label="Ekrany" className="mx-auto max-w-5xl px-4">
          <ul className="flex gap-1">
            {visibleTabs.map(tab => (
              <li key={tab.id}>
                <button
                  type="button"
                  onClick={() => setScreen(tab.id)}
                  aria-current={activeScreen === tab.id ? 'page' : undefined}
                  className={`rounded-t-md px-4 py-2 text-sm font-medium ${
                    activeScreen === tab.id
                      ? 'border-x border-t border-slate-200 bg-slate-100 text-slate-900'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {tab.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main>
        {activeScreen === 'calculator' && <CalculatorPage />}
        {activeScreen === 'routes' && <RouteDbPage />}
        {activeScreen === 'config' && <ConfigPage />}
        {activeScreen === 'history' && <HistoryPage />}
        {activeScreen === 'users' && <UsersPage />}
      </main>
    </div>
  )
}
