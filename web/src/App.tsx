import { useCallback, useEffect, useState } from 'react'
import { CalculatorPage } from './pages/CalculatorPage.js'
import { RouteDbPage } from './pages/RouteDbPage.js'
import { ConfigPage } from './pages/ConfigPage.js'
import { HistoryPage } from './pages/HistoryPage.js'
import { LoginPage } from './pages/LoginPage.js'
import { UsersPage } from './pages/UsersPage.js'
import { useAuth } from './lib/auth.js'
import type { UserRole } from './lib/types.js'
import { WeekPage, type WeekFocus } from './board/WeekPage.js'
import { ReviewPage } from './board/ReviewPage.js'
import { FleetPage } from './board/FleetPage.js'
import { TruckPage, parseTruckHash, truckHash, type TruckRoute } from './board/TruckPage.js'
import { boardApi } from './board/boardApi.js'
import { todayIso } from './board/format.js'

type Screen = 'board' | 'review' | 'fleet' | 'calculator' | 'users'
type CalcScreen = 'calculator' | 'routes' | 'config' | 'history'

const SCREENS: Array<{ id: Screen; label: string; roles?: UserRole[] }> = [
  { id: 'board', label: 'Tablica' },
  { id: 'review', label: 'Do sprawdzenia' },
  { id: 'fleet', label: 'Flota' },
  { id: 'calculator', label: 'Kalkulator' },
  { id: 'users', label: 'Użytkownicy', roles: ['admin'] },
]

const CALC_TABS: Array<{ id: CalcScreen; label: string; roles?: UserRole[] }> = [
  { id: 'calculator', label: 'Kalkulator' },
  { id: 'routes', label: 'Baza tras' },
  { id: 'config', label: 'Konfiguracja', roles: ['finance', 'admin'] },
  { id: 'history', label: 'Historia' },
]

const ROLE_LABELS: Record<UserRole, string> = {
  dispatcher: 'dyspozytor',
  finance: 'finanse',
  admin: 'administrator',
}

function clearHash(): void {
  if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
}

const allowed = (role: UserRole) => (item: { roles?: UserRole[] }) => item.roles === undefined || item.roles.includes(role)

export function App() {
  const { user, logout } = useAuth()
  const [screen, setScreen] = useState<Screen>('board')
  const [calcScreen, setCalcScreen] = useState<CalcScreen>('calculator')
  const [focus, setFocus] = useState<WeekFocus | null>(null)
  const [boardDate, setBoardDate] = useState<string>(todayIso())
  const [openIssues, setOpenIssues] = useState<number | null>(null)
  const [truckRoute, setTruckRoute] = useState<TruckRoute | null>(() => parseTruckHash(window.location.hash))
  /** Where the set page was opened from; `pushed` = it added a history entry ("Back" pops it). */
  const [truckFrom, setTruckFrom] = useState<{ screen: Screen; pushed: boolean } | null>(null)
  const signedIn = user !== null && user !== undefined

  useEffect(() => {
    const onHash = () => setTruckRoute(parseTruckHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const refreshCount = useCallback(async () => {
    try {
      setOpenIssues((await boardApi.issues()).length)
    } catch {
      setOpenIssues(null) // backend offline — the page itself shows the error
    }
  }, [])

  useEffect(() => {
    if (signedIn) void refreshCount()
  }, [refreshCount, screen, signedIn])

  if (user === undefined) {
    return <p className="p-6 text-sm text-[#545B63]">Sprawdzanie sesji…</p>
  }
  if (user === null) {
    return <LoginPage />
  }

  const screens = SCREENS.filter(allowed(user.role))
  const calcTabs = CALC_TABS.filter(allowed(user.role))
  const activeScreen = screens.some(s => s.id === screen) ? screen : 'board'
  const activeCalc = calcTabs.some(t => t.id === calcScreen) ? calcScreen : 'calculator'

  const go = (next: Screen) => {
    setFocus(null)
    clearHash()
    setTruckRoute(null)
    setScreen(next)
  }

  const openTruck = (id: number, date: string) => {
    const route: TruckRoute = { id, date, mode: 'week' }
    setFocus(null) // back on the board = the week that was open, without an old order panel
    setTruckFrom({ screen: activeScreen, pushed: true })
    setTruckRoute(route)
    window.location.hash = truckHash(route)
  }

  const closeTruck = () => {
    if (truckFrom?.pushed) {
      window.history.back()
    } else {
      clearHash()
    }
    setTruckRoute(null)
    setTruckFrom(null)
  }

  const openOrder = async (orderNo: string) => {
    clearHash()
    setTruckRoute(null)
    let date = boardDate
    try {
      date = (await boardApi.order(orderNo)).order.loadDate || boardDate
    } catch {
      // order may have been removed — open the board on the current week anyway
    }
    setFocus({ orderNo, date })
    setScreen('board')
  }

  return (
    <div className="min-h-screen bg-[#EEF0EC] font-sans text-[#15181C]">
      <header className="sticky top-0 z-30 bg-[#15181C] text-[#EEF0EC]">
        <div className="flex flex-wrap items-center gap-x-6 px-4 sm:px-6">
          <span className="pt-3 text-[15px] font-bold tracking-tight sm:py-3">
            Tablica floty <span className="font-normal text-[#9AA3AC]">· spedycja</span>
          </span>
          <nav aria-label="Ekrany" className="order-3 -mx-3.5 w-[calc(100%+1.75rem)] overflow-x-auto sm:order-none sm:mx-0 sm:w-auto sm:min-w-0 sm:flex-1">
            <ul className="flex whitespace-nowrap">
              {screens.map(s => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => go(s.id)}
                    aria-current={activeScreen === s.id ? 'page' : undefined}
                    className={`relative flex h-12 items-center gap-2 px-3.5 text-sm font-semibold ${
                      activeScreen === s.id
                        ? 'text-white after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:rounded-t after:bg-[#F4C77A]'
                        : 'text-[#9AA3AC] hover:text-white'
                    }`}
                  >
                    {s.label}
                    {s.id === 'review' && openIssues !== null && openIssues > 0 && (
                      <span className="rounded-full bg-[#F4C77A] px-1.5 py-px font-mono text-[11.5px] font-bold text-[#3A2400]" aria-label={`${openIssues} otwartych`}>
                        {openIssues}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <span className="ml-auto flex items-center gap-3 pt-3 text-xs text-[#9AA3AC] sm:ml-0 sm:py-3">
            <span>
              {user.displayName} · {ROLE_LABELS[user.role]}
            </span>
            <button type="button" onClick={() => void logout()} className="h-8 rounded-md border border-[#3A4048] px-2.5 text-xs font-semibold text-[#EEF0EC] hover:bg-[#2A3038]">
              Wyloguj
            </button>
          </span>
        </div>
      </header>

      <main>
        {truckRoute && (
          <TruckPage
            key={truckRoute.id}
            truckId={truckRoute.id}
            date={truckRoute.date}
            mode={truckRoute.mode}
            backLabel={truckFrom?.screen === 'fleet' ? 'Flota' : 'Tablica'}
            onBack={closeTruck}
            onNavigate={(date, mode) => {
              const route: TruckRoute = { id: truckRoute.id, date, mode }
              window.history.replaceState(window.history.state, '', truckHash(route))
              setTruckRoute(route)
            }}
            onShowOnBoard={orderNo => void openOrder(orderNo)}
          />
        )}
        {!truckRoute && activeScreen === 'board' && (
          <WeekPage focus={focus} initialDate={boardDate} onDateChange={setBoardDate} onReview={() => go('review')} onOpenTruck={openTruck} />
        )}
        {!truckRoute && activeScreen === 'review' && <ReviewPage onOpenOrder={orderNo => void openOrder(orderNo)} onIssuesChanged={() => void refreshCount()} />}
        {!truckRoute && activeScreen === 'fleet' && <FleetPage onChanged={() => void refreshCount()} onOpenTruck={id => openTruck(id, boardDate)} />}
        {!truckRoute && activeScreen === 'users' && (
          <div className="min-h-[calc(100vh-48px)] bg-slate-100">
            <UsersPage />
          </div>
        )}
        {!truckRoute && activeScreen === 'calculator' && (
          <div className="min-h-[calc(100vh-48px)] bg-slate-100">
            <nav aria-label="Kalkulator" className="border-b border-slate-200 bg-white">
              <ul className="mx-auto flex max-w-5xl gap-1 px-4 pt-3">
                {calcTabs.map(tab => (
                  <li key={tab.id}>
                    <button
                      type="button"
                      onClick={() => setCalcScreen(tab.id)}
                      aria-current={activeCalc === tab.id ? 'page' : undefined}
                      className={`rounded-t-md px-4 py-2 text-sm font-medium ${
                        activeCalc === tab.id ? 'border-x border-t border-slate-200 bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {tab.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            {activeCalc === 'calculator' && <CalculatorPage />}
            {activeCalc === 'routes' && <RouteDbPage />}
            {activeCalc === 'config' && <ConfigPage />}
            {activeCalc === 'history' && <HistoryPage />}
          </div>
        )}
      </main>
    </div>
  )
}
