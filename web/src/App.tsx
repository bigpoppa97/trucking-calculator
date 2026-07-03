import { useState } from 'react'
import { CalculatorPage } from './pages/CalculatorPage.js'
import { RouteDbPage } from './pages/RouteDbPage.js'
import { ConfigPage } from './pages/ConfigPage.js'
import { HistoryPage } from './pages/HistoryPage.js'

type Screen = 'calculator' | 'routes' | 'config' | 'history'

const TABS: Array<{ id: Screen; label: string }> = [
  { id: 'calculator', label: 'Kalkulator' },
  { id: 'routes', label: 'Baza tras' },
  { id: 'config', label: 'Konfiguracja' },
  { id: 'history', label: 'Historia' },
]

export function App() {
  const [screen, setScreen] = useState<Screen>('calculator')

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between p-4 pb-0">
          <h1 className="text-lg font-bold text-slate-900">Kalkulator kosztów transportu</h1>
          <span className="text-xs text-slate-400">v2.0</span>
        </div>
        <nav aria-label="Ekrany" className="mx-auto max-w-5xl px-4">
          <ul className="flex gap-1">
            {TABS.map(tab => (
              <li key={tab.id}>
                <button
                  type="button"
                  onClick={() => setScreen(tab.id)}
                  aria-current={screen === tab.id ? 'page' : undefined}
                  className={`rounded-t-md px-4 py-2 text-sm font-medium ${
                    screen === tab.id
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
        {screen === 'calculator' && <CalculatorPage />}
        {screen === 'routes' && <RouteDbPage />}
        {screen === 'config' && <ConfigPage />}
        {screen === 'history' && <HistoryPage />}
      </main>
    </div>
  )
}
