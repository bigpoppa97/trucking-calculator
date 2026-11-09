import { useId, useState } from 'react'
import { api, ApiError } from '../lib/api.js'
import type { GeocodeCandidateDto } from '../lib/types.js'

/**
 * "Dodaj miejsce" in the calculator (09.11.2026): a stop that is neither an
 * airport nor in the dictionary is added here — HERE search or coordinates by
 * hand — and lands in the board's place dictionary, so the board knows it too.
 * Same rules as the board's "Nowe miejsce": a 3-letter code is reserved for
 * airports, an empty code is made from the name (Barwinek → BARW).
 */

export interface AddPlaceFormProps {
  /** Starting text for the search and the name (the stop as typed, e.g. "Barwinek"). */
  initialName: string
  onCreated: (code: string) => Promise<void> | void
  onCancel?: () => void
}

export function AddPlaceForm({ initialName, onCreated, onCancel }: AddPlaceFormProps) {
  const id = useId()
  const [query, setQuery] = useState(initialName)
  const [candidates, setCandidates] = useState<GeocodeCandidateDto[] | null>(null)
  const [name, setName] = useState(initialName)
  const [code, setCode] = useState('')
  const [country, setCountry] = useState('')
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const latN = Number(lat.replace(',', '.'))
  const lonN = Number(lon.replace(',', '.'))
  const coordsValid =
    lat.trim() !== '' && lon.trim() !== '' && Number.isFinite(latN) && Number.isFinite(lonN) && Math.abs(latN) <= 90 && Math.abs(lonN) <= 180
  const valid = name.trim() !== '' && coordsValid

  const search = async () => {
    if (query.trim().length < 2) return
    setBusy(true)
    setError(null)
    try {
      setCandidates(await api.geocodePlace(query.trim()))
    } catch {
      setError('Wyszukiwanie nie zadziałało — wpisz współrzędne ręcznie.')
    } finally {
      setBusy(false)
    }
  }

  const pick = (c: GeocodeCandidateDto) => {
    setCountry(c.country.slice(0, 2).toUpperCase())
    setLat(String(c.lat))
    setLon(String(c.lon))
  }

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      const created = await api.createPlace({
        name: name.trim(),
        lat: latN,
        lon: lonN,
        ...(code.trim() ? { code: code.trim().toUpperCase() } : {}),
        ...(country.trim() ? { country: country.trim().toUpperCase() } : {}),
      })
      await onCreated(created)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Nie udało się dodać miejsca.')
    } finally {
      setBusy(false)
    }
  }

  const input = 'rounded-md border border-slate-300 px-2 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-300'
  const label = 'flex flex-col gap-1 text-xs font-medium text-slate-600'

  return (
    <form
      aria-label="Dodaj miejsce"
      className="mt-2 space-y-2 rounded-md border border-slate-200 bg-white p-3"
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className={label} htmlFor={`${id}-q`}>
          Znajdź na mapie (HERE)
          <input
            id={`${id}-q`}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void search()
              }
            }}
            placeholder="np. 47-175 Barwinek"
            className={`${input} w-64`}
          />
        </label>
        <button
          type="button"
          onClick={() => void search()}
          disabled={busy || query.trim().length < 2}
          className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Szukaj
        </button>
      </div>

      {candidates !== null && candidates.length === 0 && (
        <p className="text-xs text-slate-500">
          Nic nie znaleziono — wpisz współrzędne ręcznie (np. z Google Maps: prawy klik na mapie).
        </p>
      )}
      {candidates !== null && candidates.length > 0 && (
        <ul className="space-y-1" aria-label="Wyniki wyszukiwania">
          {candidates.map(c => {
            const chosen = String(c.lat) === lat && String(c.lon) === lon
            return (
              <li key={`${c.lat},${c.lon}`}>
                <button
                  type="button"
                  onClick={() => pick(c)}
                  aria-pressed={chosen}
                  className={`w-full rounded border px-2 py-1 text-left text-sm ${chosen ? 'border-sky-500 bg-sky-50' : 'border-slate-200 hover:border-slate-400'}`}
                >
                  {c.title} <span className="font-mono text-xs text-slate-500">({c.lat.toFixed(4)}, {c.lon.toFixed(4)})</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className={label} htmlFor={`${id}-n`}>
          Nazwa *
          <input id={`${id}-n`} value={name} onChange={e => setName(e.target.value)} className={`${input} w-44`} />
        </label>
        <label className={label} htmlFor={`${id}-k`}>
          Kod
          <input
            id={`${id}-k`}
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase())}
            placeholder="auto"
            maxLength={8}
            className={`${input} w-20 font-mono uppercase`}
          />
        </label>
        <label className={label} htmlFor={`${id}-c`}>
          Kraj
          <input
            id={`${id}-c`}
            value={country}
            onChange={e => setCountry(e.target.value.toUpperCase())}
            placeholder="PL"
            maxLength={2}
            className={`${input} w-12 font-mono uppercase`}
          />
        </label>
        <label className={label} htmlFor={`${id}-lat`}>
          Szerokość *
          <input id={`${id}-lat`} value={lat} onChange={e => setLat(e.target.value)} inputMode="decimal" className={`${input} w-28 font-mono`} />
        </label>
        <label className={label} htmlFor={`${id}-lon`}>
          Długość *
          <input id={`${id}-lon`} value={lon} onChange={e => setLon(e.target.value)} inputMode="decimal" className={`${input} w-28 font-mono`} />
        </label>
      </div>

      {error !== null && (
        <p role="alert" className="rounded bg-red-50 px-2 py-1 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={busy || !valid}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {busy ? 'Zapisuję…' : 'Dodaj miejsce'}
        </button>
        {onCancel !== undefined && (
          <button type="button" onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-700">
            Anuluj
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Miejsce trafi do wspólnego słownika (kalkulator i tablica). Kod pusty = z nazwy (np. BARW); 3 litery są zarezerwowane dla lotnisk.
      </p>
    </form>
  )
}
