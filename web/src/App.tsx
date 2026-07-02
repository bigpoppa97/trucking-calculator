import { CalculatorPage } from './pages/CalculatorPage.js'

export function App() {
  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between p-4">
          <h1 className="text-lg font-bold text-slate-900">Kalkulator kosztów transportu</h1>
          <span className="text-xs text-slate-400">v2.0</span>
        </div>
      </header>
      <main>
        <CalculatorPage />
      </main>
    </div>
  )
}
