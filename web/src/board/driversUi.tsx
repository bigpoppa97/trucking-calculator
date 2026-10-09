import { useEffect, useId, useMemo, useState } from 'react'
import { boardApi, errorMessage, type CertStatus, type CertWarning, type Driver } from './boardApi.js'
import { dm, dmy, todayIso } from './format.js'
import { Icon } from './Icon.js'

/**
 * Kierowcy — shared UI: certificate status colours, warnings next to a driver
 * and the driver change dialog (board "+" → Zmiana kierowcy, set page).
 */

export const CERT_STYLE: Record<CertStatus, { bg: string; fg: string; border: string }> = {
  ok: { bg: '#E3F1E6', fg: '#14532D', border: '#A7D3B0' },
  expiring: { bg: '#FBEBD0', fg: '#7A4A00', border: '#F4C77A' },
  expired: { bg: '#FDE2E1', fg: '#9B1C1C', border: '#F5A5A2' },
  none: { bg: '#ECEEEA', fg: '#545B63', border: '#D5D9D3' },
}

export function certStatusText(status: CertStatus, validTo: string | null, daysLeft: number | null): string {
  if (status === 'none' || !validTo) return 'bez daty ważności'
  if (status === 'expired') return `wygasł ${dmy(validTo)}`
  if (status === 'expiring') return daysLeft === 0 ? `wygasa dziś (${dmy(validTo)})` : `ważny do ${dmy(validTo)} — zostało ${daysLeft} dni`
  return `ważny do ${dmy(validTo)}`
}

/** "AVSEC wygasa 20.10" next to a driver on the board and the set page. */
export function DriverWarnings({ warnings, onOpen }: { warnings: CertWarning[]; onOpen?: (() => void) | undefined }) {
  if (warnings.length === 0) return null
  return (
    <span className="flex flex-wrap gap-1">
      {warnings.map(w => {
        const st = CERT_STYLE[w.status]
        const text = `${w.kind} ${w.status === 'expired' ? 'wygasł' : 'wygasa'} ${dm(w.validTo)}`
        const style = { background: st.bg, color: st.fg }
        return onOpen ? (
          <button
            key={w.kind}
            type="button"
            onClick={e => {
              e.stopPropagation()
              onOpen()
            }}
            onDoubleClick={e => e.stopPropagation()}
            title="Otwórz certyfikaty kierowcy"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold"
            style={style}
          >
            <Icon name="alert" size={11} /> {text}
          </button>
        ) : (
          <span key={w.kind} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold" style={style}>
            <Icon name="alert" size={11} /> {text}
          </span>
        )
      })}
    </span>
  )
}

const FIELD = 'h-11 rounded-lg border border-[#C9CEC6] px-3 font-normal'

/**
 * Zmiana kierowcy: who drives the tractor from a day. Drivers of the tractor's
 * carrier first; a new driver can be added on the spot. With "zdejmij z innego
 * auta" the driver leaves the tractor he is on that day.
 */
export function DriverChangeDialog({
  truck,
  day,
  change,
  onClose,
  onSaved,
}: {
  truck: { id: number; plate: string; carrier: string; driverId: number | null }
  day: string
  /** Existing change → edit (day, driver) or delete. */
  change?: { id: number; driverId: number | null } | null
  onClose: () => void
  onSaved: (message?: string) => void
}) {
  const id = useId()
  const [drivers, setDrivers] = useState<Driver[] | null>(null)
  const [driverId, setDriverId] = useState<string>(change ? String(change.driverId ?? 'none') : '')
  const [date, setDate] = useState(day || todayIso())
  const [release, setRelease] = useState(true)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    let alive = true
    boardApi
      .drivers()
      .then(list => {
        if (alive) setDrivers(list)
      })
      .catch(e => {
        if (alive) setError(errorMessage(e, 'Nie udało się wczytać kierowców.'))
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const { own, others } = useMemo(() => {
    const list = (drivers ?? []).filter(d => d.active || String(d.id) === driverId)
    const key = fold(truck.carrier)
    const mine = (d: Driver) => key !== '' && (fold(d.carrier).startsWith(key) || key.startsWith(fold(d.carrier))) && d.carrier !== ''
    return { own: list.filter(mine), others: list.filter(d => !mine(d)) }
  }, [drivers, truck.carrier, driverId])

  const selected = drivers?.find(d => String(d.id) === driverId) ?? null
  const elsewhere = selected ? selected.trucks.filter(t => t.id !== truck.id) : []

  const run = async (fn: () => Promise<string | undefined>) => {
    setSaving(true)
    setError(null)
    try {
      onSaved(await fn())
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się zapisać zmiany kierowcy.'))
      setSaving(false)
    }
  }

  const save = () => {
    if (!date) return setError('Podaj dzień zmiany.')
    if (adding && !name.trim()) return setError('Podaj imię i nazwisko nowego kierowcy.')
    if (!adding && driverId === '') return setError('Wybierz kierowcę.')
    void run(async () => {
      let target: number | null = driverId === 'none' ? null : Number(driverId)
      if (adding) target = await boardApi.createDriver({ name: name.trim(), phone: phone.trim(), carrier: truck.carrier })
      if (change) {
        await boardApi.updateDriverChange(change.id, { day: date, driverId: target })
        return undefined
      }
      // Only when the box was shown (the driver is on another tractor) — never a silent release.
      const releaseOther = !adding && elsewhere.length > 0 && release
      const res = await boardApi.setDriverChange({ truckId: truck.id, day: date, driverId: target, releaseOther })
      return res.released.length > 0 ? `${res.released.join(', ')}: od ${dm(date)} bez kierowcy.` : undefined
    })
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="flex max-h-[calc(100vh-32px)] w-full max-w-md flex-col overflow-y-auto rounded-xl bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id={`${id}-title`} className="flex items-center gap-2 text-lg font-bold">
              <Icon name="driver" size={18} /> Zmiana kierowcy · {truck.plate}
            </h2>
            <p className="text-sm text-[#545B63]">Od tego dnia tablica pokazuje nowego kierowcę; zlecenia przypisze sama.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="flex h-11 w-11 flex-none items-center justify-center rounded-lg border border-[#D5D9D3]">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1 font-semibold" htmlFor={`${id}-day`}>
            Od dnia
            <input id={`${id}-day`} type="date" value={date} onChange={e => setDate(e.target.value)} className={FIELD} />
          </label>

          {!adding ? (
            <label className="flex flex-col gap-1 font-semibold" htmlFor={`${id}-driver`}>
              Kierowca
              <select id={`${id}-driver`} value={driverId} onChange={e => setDriverId(e.target.value)} className={`${FIELD} px-2`} disabled={!drivers}>
                <option value="">{drivers ? '— wybierz —' : 'wczytywanie…'}</option>
                {own.length > 0 && (
                  <optgroup label={truck.carrier || 'Przewoźnik auta'}>
                    {own.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.trucks.length > 0 ? ` (teraz ${d.trucks.map(t => t.plate).join(', ')})` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {others.length > 0 && (
                  <optgroup label="Pozostali">
                    {others.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.carrier ? ` · ${d.carrier}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="none">— bez kierowcy —</option>
              </select>
            </label>
          ) : (
            <fieldset className="flex flex-col gap-2 rounded-lg border border-[#C9CEC6] px-3 py-2.5">
              <legend className="px-1 font-semibold">Nowy kierowca ({truck.carrier || 'bez przewoźnika'})</legend>
              <label className="flex flex-col gap-1 font-semibold" htmlFor={`${id}-name`}>
                Imię i nazwisko
                <input id={`${id}-name`} value={name} maxLength={120} onChange={e => setName(e.target.value)} className={FIELD} />
              </label>
              <label className="flex flex-col gap-1 font-semibold" htmlFor={`${id}-phone`}>
                Telefon
                <input id={`${id}-phone`} value={phone} maxLength={40} onChange={e => setPhone(e.target.value)} className={`${FIELD} font-mono`} />
              </label>
            </fieldset>
          )}
          <button type="button" onClick={() => setAdding(a => !a)} className="self-start text-[13px] font-semibold text-[#1E4E9C] underline">
            {adding ? 'Wybierz z listy kierowców' : '+ Nowy kierowca (nie ma go na liście)'}
          </button>

          {!change && !adding && elsewhere.length > 0 && (
            <label className="flex min-h-10 cursor-pointer items-start gap-2 rounded-lg bg-[#F6F7F4] px-3 py-2">
              <input type="checkbox" checked={release} onChange={e => setRelease(e.target.checked)} className="mt-0.5 h-[18px] w-[18px] accent-[#1E4E9C]" />
              <span>
                {selected?.name} jeździ teraz na {elsewhere.map(t => t.plate).join(', ')} — od {dm(date)} zostaw tamto auto bez kierowcy
              </span>
            </label>
          )}

          {error && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-800">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {change && !confirmDelete && (
              <button type="button" disabled={saving} onClick={() => setConfirmDelete(true)} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold text-[#9B1C1C]">
                Usuń zmianę
              </button>
            )}
            {change && confirmDelete ? (
              <>
                <span className="text-[13px]">Usunąć tę zmianę kierowcy?</span>
                <button type="button" onClick={() => setConfirmDelete(false)} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold">
                  Nie
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    void run(async () => {
                      await boardApi.deleteDriverChange(change.id)
                      return undefined
                    })
                  }
                  className="h-11 rounded-lg bg-[#9B1C1C] px-4 font-semibold text-white"
                >
                  Tak, usuń
                </button>
              </>
            ) : (
              <>
                <span className="flex-1" />
                <button type="button" onClick={onClose} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold">
                  Anuluj
                </button>
                <button type="button" disabled={saving} onClick={save} className="h-11 rounded-lg bg-[#1E4E9C] px-4 font-semibold text-white disabled:opacity-60">
                  Zapisz zmianę
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
