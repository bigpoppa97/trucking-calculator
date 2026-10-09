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
import { DriverPage, driverHash, parseDriverHash } from './board/DriverPage.js'
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

/** Pages with their own address: the set page (#/auto/…) and the driver page (#/kierowca/…). */
type Page = { kind: 'truck'; route: TruckRoute } | { kind: 'driver'; id: number }

function parsePage(hash: string): Page | null {
  const truck = parseTruckHash(hash)
  if (truck) return { kind: 'truck', route: truck }
  const driver = parseDriverHash(hash)
  return driver ? { kind: 'driver', id: driver.id } : null
}

function pageHash(p: Page): string {
  return p.kind === 'truck' ? truckHash(p.route) : driverHash({ id: p.id })
}

/** History entries we push carry the label of the page to go back to. */
function backLabelOfHistory(): string | null {
  const state = window.history.state as { tablicaBack?: unknown } | null
  return typeof state?.tablicaBack === 'string' ? state.tablicaBack : null
}

function clearHash(): void {
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search)
}

const BACK_LABELS: Record<string, string> = { board: 'Tablica', review: 'Do sprawdzenia', fleet: 'Flota' }

const allowed = (role: UserRole) => (item: { roles?: UserRole[] }) => item.roles === undefined || item.roles.includes(role)

export function App() {
  const { user, logout } = useAuth()
  const [screen, setScreen] = useState<Screen>('board')
  const [calcScreen, setCalcScreen] = useState<CalcScreen>('calculator')
  const [focus, setFocus] = useState<WeekFocus | null>(null)
  const [boardDate, setBoardDate] = useState<string>(todayIso())
  const [openIssues, setOpenIssues] = useState<number | null>(null)
  const [page, setPage] = useState<Page | null>(() => parsePage(window.location.hash))
  const [backLabel, setBackLabel] = useState<string | null>(backLabelOfHistory)
  const signedIn = user !== null && user !== undefined

  useEffect(() => {
    const sync = () => {
      setPage(parsePage(window.location.hash))
      setBackLabel(backLabelOfHistory())
    }
    window.addEventListener('popstate', sync)
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener('hashchange', sync)
    }
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
    setPage(null)
    setScreen(next)
  }

  /** Opens a page as a new history entry, so the browser's Back returns where it was opened from. */
  const openPage = (next: Page) => {
    const label = page ? (page.kind === 'driver' ? 'Kierowca' : 'Zestaw') : (BACK_LABELS[activeScreen] ?? 'Tablica')
    setFocus(null) // back on the board = the week that was open, without an old order panel
    window.history.pushState({ tablicaBack: label }, '', pageHash(next))
    setPage(next)
    setBackLabel(label)
  }
  const openTruck = (id: number, date: string) => openPage({ kind: 'truck', route: { id, date, mode: 'week' } })
  const openDriver = (id: number) => openPage({ kind: 'driver', id })

  const closePage = () => {
    if (backLabelOfHistory()) {
      window.history.back() // popstate brings the previous page (or the screen) back
      return
    }
    clearHash()
    setPage(null)
    setBackLabel(null)
  }

  const openOrder = async (orderNo: string) => {
    clearHash()
    setPage(null)
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
        {page?.kind === 'truck' && (
          <TruckPage
            key={page.route.id}
            truckId={page.route.id}
            date={page.route.date}
            mode={page.route.mode}
            backLabel={backLabel ?? 'Tablica'}
            onBack={closePage}
            onNavigate={(date, mode) => {
              const route: TruckRoute = { id: page.route.id, date, mode }
              window.history.replaceState(window.history.state, '', truckHash(route))
              setPage({ kind: 'truck', route })
            }}
            onShowOnBoard={orderNo => void openOrder(orderNo)}
            onOpenDriver={openDriver}
          />
        )}
        {page?.kind === 'driver' && (
          <DriverPage key={page.id} driverId={page.id} backLabel={backLabel ?? 'Flota'} onBack={closePage} onOpenTruck={id => openTruck(id, boardDate)} />
        )}
        {!page && activeScreen === 'board' && (
          <WeekPage focus={focus} initialDate={boardDate} onDateChange={setBoardDate} onReview={() => go('review')} onOpenTruck={openTruck} onOpenDriver={openDriver} />
        )}
        {!page && activeScreen === 'review' && <ReviewPage onOpenOrder={orderNo => void openOrder(orderNo)} onIssuesChanged={() => void refreshCount()} />}
        {!page && activeScreen === 'fleet' && (
          <FleetPage onChanged={() => void refreshCount()} onOpenTruck={id => openTruck(id, boardDate)} onOpenDriver={openDriver} />
        )}
        {!page && activeScreen === 'users' && (
          <div className="min-h-[calc(100vh-48px)] bg-slate-100">
            <UsersPage />
          </div>
        )}
        {!page && activeScreen === 'calculator' && (
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
