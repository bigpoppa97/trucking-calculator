import { useCallback, useEffect, useState } from 'react'
import { boardApi, errorMessage, type OrderDetails } from './boardApi.js'
import { OVERRIDE_LABELS, dm, eur, km, signedEur, stamp } from './format.js'
import { Icon } from './Icon.js'

/**
 * Order panel: legs, money, km, notes from the app (read-only), board-only
 * notes, open review items, manual corrections and the change history.
 */

const KIND_LABEL = { fleet: 'Twoje auto', own: 'flota własna — poza działem', other: 'spoza floty — poza działem' } as const

export function OrderPanel({
  orderNo,
  showMoney,
  onClose,
  onChanged,
}: {
  orderNo: string
  showMoney: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [data, setData] = useState<OrderDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [fixField, setFixField] = useState<string | null>(null)
  const [fixValue, setFixValue] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await boardApi.order(orderNo))
      setError(null)
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się wczytać zlecenia.'))
    }
  }, [orderNo])

  useEffect(() => {
    setData(null)
    setFixField(null)
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await load()
      onChanged()
      setError(null)
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się zapisać.'))
    } finally {
      setBusy(false)
    }
  }

  const o = data?.order
  return (
    <aside
      aria-label="Szczegóły zlecenia"
      className="fixed bottom-4 right-4 top-[104px] z-40 flex w-[440px] max-w-[calc(100vw-32px)] flex-col gap-4 overflow-y-auto rounded-xl border border-[#C9CEC6] bg-white p-5 shadow-[0_18px_48px_rgba(21,24,28,0.18)] sm:top-[60px]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Zlecenie</span>
          <span className="font-mono text-xl font-semibold">{orderNo}</span>
          {o && (
            <>
              <span className="text-sm">{o.client}</span>
              <span className="break-words font-mono text-xs text-[#545B63]">Nr obcy: {o.clientRef || '—'}</span>
            </>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Zamknij szczegóły zlecenia" className="flex h-11 w-11 flex-none items-center justify-center rounded-lg border border-[#D5D9D3] hover:bg-[#F7F8F6]">
          <Icon name="close" size={18} />
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {!data && !error && <p className="text-sm text-[#545B63]">Wczytywanie…</p>}

      {data && o && (
        <>
          <div className="flex flex-col gap-0.5">
            <span className="text-lg font-bold">{o.route}</span>
            <span className="text-[13px] text-[#545B63]">
              {dm(o.loadDate)} → {dm(o.unloadDate)} · naczepa <span className="font-mono">{o.trailer ?? '—'}</span> · {o.carrier}
            </span>
            {(o.excluded || o.noCarrier || o.missing) && (
              <span className="mt-1 rounded bg-[#F1F2F0] px-2 py-1 text-[13px] text-[#3D444C]">
                {o.excluded === 'cancelled' && 'Anulowane w aplikacji (status A) — poza wynikami. '}
                {o.excluded === 'unconfirmed' && 'Niezatwierdzone (status N) — poza wynikami. '}
                {o.excluded === 'manual' && 'Wyłączone ręcznie z wyników. '}
                {o.noCarrier && 'Zlecenie spedycyjne anulowane — brak przewoźnika. '}
                {o.missing && 'Zniknęło z ostatniego eksportu.'}
              </span>
            )}
          </div>

          {o.prz && (
            <div className="flex flex-col gap-1 rounded-lg bg-[#EEF2FA] px-3 py-2.5 outline-2 -outline-offset-2 outline-dashed outline-[#1E4E9C]">
              <span className="text-[11.5px] font-bold uppercase tracking-wider text-[#1E4E9C]">Przepinka z uwag</span>
              <span className="font-mono text-[13px]">
                {o.prz.place} · {dm(o.prz.date)} · {o.prz.from} → {o.prz.to} · {o.prz.amountFrom} / {o.prz.amountTo} €
              </span>
            </div>
          )}
          {o.przErrors.map(raw => (
            <p key={raw} className="rounded-lg bg-[#F4C77A] px-3 py-2 text-[13px] text-[#3A2400]">
              Nie rozumiem wpisu: <span className="font-mono">{raw}</span>. Wzór: <span className="font-mono">PRZ MIEJSCE DD.MM AUTO&gt;AUTO KWOTA/KWOTA</span>
            </p>
          ))}

          <div className="flex flex-col">
            <span className="pb-1 text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Odcinki</span>
            {data.legs.map(l => (
              <div key={l.index} className="flex flex-col gap-0.5 border-t border-[#E3E6E1] py-2">
                <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <span className="font-mono font-semibold">{l.plate}</span>
                  <span>{l.stops.length > 1 ? l.stops.join(' → ') : `${l.from} → ${l.to}`}</span>
                  <span className="text-xs text-[#545B63]">{KIND_LABEL[l.kind]}</span>
                </span>
                <span className="font-mono text-[12.5px] text-[#545B63]">
                  {dm(l.startDate)}–{dm(l.endDate)}
                  {showMoney && ` · kwota ${eur(l.amount)} · przychód ${eur(l.revAlloc)}`}
                </span>
                {l.kind === 'fleet' && (
                  <span className="font-mono text-[12.5px] text-[#545B63]">
                    z ładunkiem {km(l.kmLoaded, l.kmEstimated)} · dojazd pusty {km(l.kmEmpty, l.kmEstimated)}
                    {l.kmEmptyFrom ? ` (z: ${l.kmEmptyFrom})` : ' (brak poprzedniego zlecenia)'}
                  </span>
                )}
              </div>
            ))}
          </div>

          {showMoney && (
            <div className="grid grid-cols-3 gap-2">
              <Money label="Stawka klienta" value={eur(o.rev)} />
              <Money label="Kwoty dla aut" value={eur(o.amountsTotal)} sub={o.extraCost ? `w tym dodatkowe ${eur(o.extraCost)}` : undefined} />
              <Money label="Marża" value={signedEur(o.margin)} sub={o.marginPct !== null ? `${String(o.marginPct).replace('.', ',')}%` : undefined} />
            </div>
          )}

          {data.issues.map(i => (
            <p key={i.id} className="rounded-lg bg-[#F4C77A] px-3 py-2 text-[13px] text-[#3A2400]">
              {i.message}
            </p>
          ))}

          <div className="flex flex-col gap-1">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">
              Uwagi z aplikacji <span className="font-medium normal-case tracking-normal">· tylko do odczytu</span>
            </span>
            <span className="whitespace-pre-line break-words font-mono text-[13px]">{o.notesApp || '—'}</span>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">
              Notatki tablicy <span className="font-medium normal-case tracking-normal">· widoczne tylko tutaj, nie trafiają do aplikacji</span>
            </span>
            {data.notes.map(n => (
              <div key={n.id} className="flex items-start justify-between gap-2 rounded-lg bg-[#F3F4F1] px-3 py-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-[#545B63]">
                    {n.createdBy} · {stamp(n.createdAt)}
                  </span>
                  <span className="text-[13.5px]">{n.text}</span>
                </div>
                <button
                  type="button"
                  aria-label="Usuń notatkę"
                  onClick={() => void run(() => boardApi.deleteNote(n.id))}
                  className="flex h-8 w-8 flex-none items-center justify-center rounded text-[#545B63] hover:bg-white"
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            <label htmlFor="board-note" className="text-[13px] font-semibold">
              Nowa notatka
            </label>
            <textarea
              id="board-note"
              rows={2}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="np. klient prosi o awizację 2 h przed załadunkiem"
              className="w-full resize-y rounded-lg border border-[#C9CEC6] px-2.5 py-2 text-[13.5px]"
            />
            <div>
              <button
                type="button"
                disabled={busy || !note.trim()}
                onClick={() =>
                  void run(async () => {
                    await boardApi.addNote(orderNo, note)
                    setNote('')
                  })
                }
                className="h-11 rounded-lg border border-[#C9CEC6] bg-white px-3.5 font-semibold disabled:opacity-50"
              >
                Dodaj notatkę
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Ręczne poprawki</span>
            {data.overrides.length === 0 && <span className="text-[13px] text-[#545B63]">Brak — liczby pochodzą z aplikacji.</span>}
            {data.overrides.map(ov => (
              <div key={ov.field} className="flex items-center justify-between gap-2 rounded-lg bg-[#E6E9EE] px-3 py-2 text-[13px]">
                <span>
                  {OVERRIDE_LABELS[ov.field] ?? ov.field}: <span className="font-mono font-semibold">{ov.value}</span>
                </span>
                <button type="button" onClick={() => void run(() => boardApi.clearOverride(orderNo, ov.field))} className="text-[13px] font-semibold text-[#1E4E9C] underline">
                  Usuń
                </button>
              </div>
            ))}
            {fixField === null ? (
              <div>
                <button type="button" onClick={() => setFixField('cost')} className="h-11 rounded-lg bg-[#1E4E9C] px-3.5 font-semibold text-white">
                  Popraw ręcznie
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 rounded-lg border border-[#C9CEC6] p-3">
                <label className="flex flex-col gap-1 text-[13px] font-semibold">
                  Co poprawić
                  <select value={fixField} onChange={e => setFixField(e.target.value)} className="h-11 rounded-lg border border-[#C9CEC6] px-2 font-normal">
                    {Object.entries(OVERRIDE_LABELS).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[13px] font-semibold">
                  Nowa wartość
                  <input
                    value={fixValue}
                    onChange={e => setFixValue(e.target.value)}
                    placeholder={fixField === 'prz' ? 'PRZ WAW 22.09 KN4814J>KN1050H 1400/900' : ''}
                    className="h-11 rounded-lg border border-[#C9CEC6] px-3 font-normal"
                  />
                </label>
                <p className="text-xs text-[#545B63]">
                  Poprawka zostaje, dopóki aplikacja nie zmieni tej samej wartości — wtedy obowiązuje wartość z aplikacji.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy || !fixValue.trim()}
                    onClick={() =>
                      void run(async () => {
                        await boardApi.setOverride(orderNo, fixField, fixValue.trim().replace(',', fixField === 'prz' ? ',' : '.'))
                        setFixField(null)
                        setFixValue('')
                      })
                    }
                    className="h-11 rounded-lg bg-[#1E4E9C] px-3.5 font-semibold text-white disabled:opacity-50"
                  >
                    Zapisz poprawkę
                  </button>
                  <button type="button" onClick={() => setFixField(null)} className="h-11 rounded-lg border border-[#C9CEC6] px-3.5 font-semibold">
                    Anuluj
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="pb-0.5 text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Historia</span>
            {data.history.map((h, i) => (
              <span key={i} className="py-0.5 text-[13px] text-[#3D444C]">
                {stamp(h.at)} — {h.text}
              </span>
            ))}
          </div>
        </>
      )}
    </aside>
  )
}

function Money({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-[#F3F4F1] p-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-[#545B63]">{label}</span>
      <span className="font-mono font-semibold">{value}</span>
      {sub && <span className="text-xs text-[#545B63]">{sub}</span>}
    </div>
  )
}
