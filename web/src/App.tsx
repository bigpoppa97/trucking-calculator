import { useCallback, useEffect, useState } from 'react'
import { CalculatorPage } from './pages/CalculatorPage.js'
import { RouteDbPage } from './pages/RouteDbPage.js'
import { ConfigPage } from './pages/ConfigPage.js'
import { HistoryPage } from './pages/HistoryPage.js'
import { WeekPage, type WeekFocus } from './board/WeekPage.js'
import { ReviewPage } from './board/ReviewPage.js'
import { FleetPage } from './board/FleetPage.js'
import { boardApi } from './board/boardApi.js'
import { todayIso } from './board/format.js'

type Screen = 'board' | 'review' | 'fleet' | 'calculator'
type CalcScreen = 'calculator' | 'routes' | 'config' | 'history'

const SCREENS: Array<{ id: Screen; label: string }> = [
  { id: 'board', label: 'Tablica' },
  { id: 'review', label: 'Do sprawdzenia' },
  { id: 'fleet', label: 'Flota' },
  { id: 'calculator', label: 'Kalkulator' },
]

const CALC_TABS: Array<{ id: CalcScreen; label: string }> = [
  { id: 'calculator', label: 'Kalkulator' },
  { id: 'routes', label: 'Baza tras' },
  { id: 'config', label: 'Konfiguracja' },
  { id: 'history', label: 'Historia' },
]

export function App() {
  const [screen, setScreen] = useState<Screen>('board')
  const [calcScreen, setCalcScreen] = useState<CalcScreen>('calculator')
  const [focus, setFocus] = useState<WeekFocus | null>(null)
  const [boardDate, setBoardDate] = useState<string>(todayIso())
  const [openIssues, setOpenIssues] = useState<number | null>(null)

  const refreshCount = useCallback(async () => {
    try {
      setOpenIssues((await boardApi.issues()).length)
    } catch {
      setOpenIssues(null) // backend offline — the page itself shows the error
    }
  }, [])

  useEffect(() => {
    void refreshCount()
  }, [refreshCount, screen])

  const go = (next: Screen) => {
    setFocus(null)
    setScreen(next)
  }

  const openOrder = async (orderNo: string) => {
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
          <nav aria-label="Ekrany" className="-mx-3.5 w-[calc(100%+1.75rem)] overflow-x-auto sm:mx-0 sm:w-auto sm:min-w-0 sm:flex-1">
            <ul className="flex whitespace-nowrap">
              {SCREENS.map(s => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => go(s.id)}
                    aria-current={screen === s.id ? 'page' : undefined}
                    className={`relative flex h-12 items-center gap-2 px-3.5 text-sm font-semibold ${
                      screen === s.id ? 'text-white after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:rounded-t after:bg-[#F4C77A]' : 'text-[#9AA3AC] hover:text-white'
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
        </div>
      </header>

      <main>
        {screen === 'board' && <WeekPage focus={focus} initialDate={boardDate} onDateChange={setBoardDate} onReview={() => go('review')} />}
        {screen === 'review' && <ReviewPage onOpenOrder={orderNo => void openOrder(orderNo)} onIssuesChanged={() => void refreshCount()} />}
        {screen === 'fleet' && <FleetPage onChanged={() => void refreshCount()} />}
        {screen === 'calculator' && (
          <div className="min-h-[calc(100vh-48px)] bg-slate-100">
            <nav aria-label="Kalkulator" className="border-b border-slate-200 bg-white">
              <ul className="mx-auto flex max-w-5xl gap-1 px-4 pt-3">
                {CALC_TABS.map(tab => (
                  <li key={tab.id}>
                    <button
                      type="button"
                      onClick={() => setCalcScreen(tab.id)}
                      aria-current={calcScreen === tab.id ? 'page' : undefined}
                      className={`rounded-t-md px-4 py-2 text-sm font-medium ${
                        calcScreen === tab.id ? 'border-x border-t border-slate-200 bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {tab.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            {calcScreen === 'calculator' && <CalculatorPage />}
            {calcScreen === 'routes' && <RouteDbPage />}
            {calcScreen === 'config' && <ConfigPage />}
            {calcScreen === 'history' && <HistoryPage />}
          </div>
        )}
      </main>
    </div>
  )
}
