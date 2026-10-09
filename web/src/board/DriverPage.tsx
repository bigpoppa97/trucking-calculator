import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { boardApi, errorMessage, type Cert, type DriverDetails } from './boardApi.js'
import { certFileUrl, dmy, fileSize, stamp } from './format.js'
import { Icon } from './Icon.js'
import { CERT_STYLE, certStatusText } from './driversUi.js'

/**
 * Strona kierowcy: contact, tractors, and certificates (AVSEC first) with their
 * scans — preview in a new tab, download to attach to an e-mail for a client.
 * Scans stay on the office computer (data\pliki).
 */

export interface DriverRoute {
  id: number
}

/** "#/kierowca/7" → route; anything else → null. */
export function parseDriverHash(hash: string): DriverRoute | null {
  const m = /^#\/kierowca\/(\d+)$/.exec(hash)
  return m ? { id: Number(m[1]) } : null
}

export function driverHash(r: DriverRoute): string {
  return `#/kierowca/${r.id}`
}

export const CERT_KINDS = ['AVSEC', 'ADR', 'Karta kierowcy', 'Świadectwo kwalifikacji', 'Badania lekarskie']
const ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png'
const MAX_BYTES = 15 * 1024 * 1024

const INPUT = 'h-10 rounded-lg border border-[#C9CEC6] bg-white px-3 text-sm'
const BTN = 'inline-flex h-10 items-center gap-1.5 rounded-lg border border-[#C9CEC6] bg-white px-3 text-sm font-semibold hover:border-[#9AA3AC] disabled:opacity-50'
const BTN_PRIMARY = 'inline-flex h-10 items-center gap-1.5 rounded-lg bg-[#1E4E9C] px-4 text-sm font-semibold text-white disabled:opacity-50'

export function DriverPage({
  driverId,
  onBack,
  backLabel = 'Flota',
  onOpenTruck,
}: {
  driverId: number
  onBack: () => void
  backLabel?: string
  onOpenTruck?: (truckId: number) => void
}) {
  const [data, setData] = useState<DriverDetails | null>(null)
  const [carriers, setCarriers] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await boardApi.driver(driverId))
      setError(null)
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się wczytać kierowcy.'))
    }
  }, [driverId])

  useEffect(() => {
    void load()
    boardApi
      .drivers()
      .then(list => setCarriers([...new Set(list.map(d => d.carrier).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pl'))))
      .catch(() => setCarriers([]))
  }, [load])

  const run = async (fn: () => Promise<unknown>, ok: string | null, fail: string) => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      await fn()
      await load()
      setDone(ok)
      return true
    } catch (e) {
      setError(errorMessage(e, fail))
      return false
    } finally {
      setBusy(false)
    }
  }

  const copy = async (c: Cert) => {
    if (!data) return
    const text = `Driver: ${data.driver.name}${data.driver.phone ? `, phone ${data.driver.phone}` : ''}. ${c.kind}${c.number ? ` no. ${c.number}` : ''}${c.validTo ? `, valid until ${dmy(c.validTo)}` : ''}.`
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // clipboard unavailable
    }
    setCopied(c.id)
    window.setTimeout(() => setCopied(x => (x === c.id ? null : x)), 2500)
  }

  if (!data) {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <BackButton label={backLabel} onBack={onBack} />
        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </p>
        ) : (
          <p className="text-sm text-[#545B63]">Wczytywanie kierowcy…</p>
        )}
      </div>
    )
  }

  const d = data.driver
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <BackButton label={backLabel} onBack={onBack} />
        <div className="flex flex-col">
          <h1 className="text-[22px] font-bold leading-tight">{d.name}</h1>
          <span className="text-[13px] text-[#545B63]">
            Kierowca{d.carrier ? ` · ${d.carrier}` : ''}
            {!d.active && ' · nieaktywny'}
          </span>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="rounded-lg bg-[#E3F1E6] px-4 py-2.5 text-sm text-[#14532D]">
          {done}
        </p>
      )}

      <section className="flex flex-col gap-3 rounded-xl border border-[#D5D9D3] bg-white px-5 py-4">
        {!editing ? (
          <div className="flex flex-wrap items-start gap-x-10 gap-y-3 text-sm">
            <Field label="Telefon">
              <span className="font-mono">{d.phone || '—'}</span>
            </Field>
            <Field label="Firma">{d.carrier || '—'}</Field>
            <Field label="Teraz jeździ">
              {data.trucks.length === 0
                ? '—'
                : data.trucks.map(t =>
                    onOpenTruck ? (
                      <button key={t.id} type="button" onClick={() => onOpenTruck(t.id)} className="mr-2 font-mono font-semibold text-[#1E4E9C] underline decoration-[#9AB3DA] underline-offset-[3px]">
                        {t.plate}
                      </button>
                    ) : (
                      <span key={t.id} className="mr-2 font-mono font-semibold">
                        {t.plate}
                      </span>
                    ),
                  )}
            </Field>
            {d.notes && <Field label="Uwagi">{d.notes}</Field>}
            <button type="button" onClick={() => setEditing(true)} className={`${BTN} ml-auto`}>
              <Icon name="pencil" size={14} /> Edytuj dane
            </button>
          </div>
        ) : (
          <DriverForm
            initial={d}
            carriers={carriers}
            busy={busy}
            onCancel={() => setEditing(false)}
            onSave={async patch => {
              if (await run(() => boardApi.updateDriver(d.id, patch), 'Zapisano dane kierowcy.', 'Nie udało się zapisać.')) setEditing(false)
            }}
          />
        )}
        {data.history.length > 0 && (
          <details className="text-[13px] text-[#545B63]">
            <summary className="cursor-pointer font-semibold">Historia aut ({data.history.length})</summary>
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {data.history.map(h => (
                <li key={`${h.truckId}-${h.from}`}>
                  <span className="font-mono font-semibold text-[#15181C]">{h.plate}</span> {h.from <= '2000-01-01' ? 'od początku tablicy' : `od ${dmy(h.from)}`}
                  {h.to ? ` do ${dmy(h.to)}` : ' — teraz'}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section aria-labelledby="certs-h" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="certs-h" className="text-lg font-bold">
            Certyfikaty
          </h2>
          {!adding && (
            <button type="button" onClick={() => setAdding(true)} className={BTN_PRIMARY}>
              <Icon name="plus" size={15} /> Dodaj certyfikat
            </button>
          )}
        </div>
        {adding && (
          <CertForm
            busy={busy}
            withFile
            onCancel={() => setAdding(false)}
            onSave={async (input, file) => {
              setBusy(true)
              setError(null)
              setDone(null)
              let certId: number | null = null
              try {
                certId = await boardApi.createCert(d.id, input)
                if (file) await boardApi.uploadCertFile(certId, file)
                setDone(`Dodano ${input.kind}${file ? ' ze skanem' : ''}.`)
                setAdding(false)
              } catch (e) {
                if (certId === null) {
                  setError(errorMessage(e, 'Nie udało się dodać certyfikatu.'))
                } else {
                  // The certificate exists, only the scan failed: close the form (no duplicate on retry) and say so.
                  setAdding(false)
                  setError(`Dodano ${input.kind}, ale skan nie został wgrany (${errorMessage(e, 'błąd wgrywania')}) — użyj „Dodaj skan” przy certyfikacie.`)
                }
              } finally {
                await load()
                setBusy(false)
              }
            }}
          />
        )}
        {data.certs.length === 0 && !adding && (
          <p className="rounded-xl border border-dashed border-[#C9CEC6] bg-white px-5 py-6 text-sm text-[#545B63]">
            Brak certyfikatów. Dodaj AVSEC ze skanem — będzie pod ręką, gdy klient zapyta.
          </p>
        )}
        {data.certs.map(c => (
          <CertCard
            key={c.id}
            cert={c}
            busy={busy}
            copied={copied === c.id}
            onCopy={() => void copy(c)}
            onSave={patch => run(() => boardApi.updateCert(c.id, patch), `Zapisano ${c.kind}.`, 'Nie udało się zapisać.')}
            onDelete={() => run(() => boardApi.deleteCert(c.id), `Usunięto ${c.kind} razem ze skanami.`, 'Nie udało się usunąć.')}
            onUpload={file => run(() => boardApi.uploadCertFile(c.id, file), `Dodano skan ${file.name}.`, 'Nie udało się wgrać pliku.')}
            onDeleteFile={(fileId, name) => run(() => boardApi.deleteCertFile(fileId), `Usunięto ${name}.`, 'Nie udało się usunąć pliku.')}
            onError={setError}
          />
        ))}
        <p className="text-xs text-[#545B63]">Skany są zapisane tylko na tym komputerze (folder data\pliki) i kopiowane przy każdej aktualizacji do data\kopie.</p>
      </section>
    </div>
  )
}

function BackButton({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-[#C9CEC6] bg-white px-3.5 font-semibold hover:bg-[#F7F8F6]">
      <Icon name="left" size={16} /> {label}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-[140px] flex-col gap-0.5">
      <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">{label}</span>
      <span>{children}</span>
    </div>
  )
}

export function DriverForm({
  initial,
  carriers,
  busy,
  onCancel,
  onSave,
  submitLabel = 'Zapisz',
}: {
  initial: { name: string; phone: string; carrier: string; notes: string; active: boolean }
  carriers: string[]
  busy: boolean
  onCancel: () => void
  onSave: (patch: { name: string; phone: string; carrier: string; notes: string; active: boolean }) => Promise<void>
  submitLabel?: string
}) {
  const id = useId()
  const [name, setName] = useState(initial.name)
  const [phone, setPhone] = useState(initial.phone)
  const [carrier, setCarrier] = useState(initial.carrier)
  const [notes, setNotes] = useState(initial.notes)
  const [active, setActive] = useState(initial.active)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={e => {
        e.preventDefault()
        if (!name.trim()) return setError('Podaj imię i nazwisko.')
        setError(null)
        void onSave({ name: name.trim(), phone: phone.trim(), carrier: carrier.trim(), notes: notes.trim(), active })
      }}
    >
      <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-n`}>
        Imię i nazwisko *
        <input id={`${id}-n`} value={name} maxLength={120} onChange={e => setName(e.target.value)} className={`${INPUT} w-60`} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-p`}>
        Telefon
        <input id={`${id}-p`} value={phone} maxLength={40} onChange={e => setPhone(e.target.value)} className={`${INPUT} w-40 font-mono`} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-c`}>
        Firma (przewoźnik)
        <input id={`${id}-c`} list={`${id}-cl`} value={carrier} maxLength={200} onChange={e => setCarrier(e.target.value)} className={`${INPUT} w-72`} />
        <datalist id={`${id}-cl`}>
          {carriers.map(c => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-u`}>
        Uwagi
        <input id={`${id}-u`} value={notes} maxLength={1000} onChange={e => setNotes(e.target.value)} className={`${INPUT} w-64`} />
      </label>
      <label className="flex h-10 items-center gap-2 text-sm">
        <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="h-4 w-4" />
        aktywny
      </label>
      {error && (
        <p role="alert" className="w-full rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      <span className="flex gap-2">
        <button type="button" onClick={onCancel} className={BTN}>
          Anuluj
        </button>
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>
          {submitLabel}
        </button>
      </span>
    </form>
  )
}

function checkFile(file: File): string | null {
  if (file.size > MAX_BYTES) return `${file.name}: plik jest za duży — najwyżej 15 MB.`
  if (!/\.(pdf|jpe?g|png)$/i.test(file.name)) return `${file.name}: wgraj skan jako PDF, JPG albo PNG.`
  return null
}

function CertForm({
  initial,
  busy,
  withFile,
  onCancel,
  onSave,
}: {
  initial?: { kind: string; number: string; validTo: string | null; notes: string }
  busy: boolean
  withFile?: boolean
  onCancel: () => void
  onSave: (input: { kind: string; number: string; validTo: string | null; notes: string }, file: File | null) => Promise<void>
}) {
  const id = useId()
  const [kind, setKind] = useState(initial?.kind ?? 'AVSEC')
  const [number, setNumber] = useState(initial?.number ?? '')
  const [validTo, setValidTo] = useState(initial?.validTo ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-[#9AB3DA] bg-white px-5 py-4"
      onSubmit={e => {
        e.preventDefault()
        if (!kind.trim()) return setError('Podaj rodzaj certyfikatu (np. AVSEC).')
        if (file) {
          const problem = checkFile(file)
          if (problem) return setError(problem)
        }
        setError(null)
        void onSave({ kind: kind.trim(), number: number.trim(), validTo: validTo || null, notes: notes.trim() }, file)
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-k`}>
          Rodzaj *
          <input id={`${id}-k`} list={`${id}-kl`} value={kind} maxLength={60} onChange={e => setKind(e.target.value)} className={`${INPUT} w-48`} />
          <datalist id={`${id}-kl`}>
            {CERT_KINDS.map(k => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-nr`}>
          Numer
          <input id={`${id}-nr`} value={number} maxLength={80} onChange={e => setNumber(e.target.value)} className={`${INPUT} w-48 font-mono`} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-v`}>
          Ważny do
          <input id={`${id}-v`} type="date" value={validTo} onChange={e => setValidTo(e.target.value)} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-u`}>
          Uwagi
          <input id={`${id}-u`} value={notes} maxLength={500} onChange={e => setNotes(e.target.value)} className={`${INPUT} w-64`} />
        </label>
        {withFile && (
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-f`}>
            Skan (PDF, JPG, PNG)
            <input id={`${id}-f`} type="file" accept={ACCEPT} onChange={e => setFile(e.target.files?.[0] ?? null)} className="h-10 text-sm" />
          </label>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      <span className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={BTN}>
          Anuluj
        </button>
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>
          {initial ? 'Zapisz' : 'Dodaj certyfikat'}
        </button>
      </span>
    </form>
  )
}

function CertCard({
  cert: c,
  busy,
  copied,
  onCopy,
  onSave,
  onDelete,
  onUpload,
  onDeleteFile,
  onError,
}: {
  cert: Cert
  busy: boolean
  copied: boolean
  onCopy: () => void
  onSave: (patch: { kind: string; number: string; validTo: string | null; notes: string }) => Promise<boolean>
  onDelete: () => Promise<boolean>
  onUpload: (file: File) => Promise<boolean>
  onDeleteFile: (id: number, name: string) => Promise<boolean>
  onError: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<'cert' | number | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const st = CERT_STYLE[c.status]

  if (editing) {
    return (
      <CertForm
        initial={c}
        busy={busy}
        onCancel={() => setEditing(false)}
        onSave={async input => {
          if (await onSave(input)) setEditing(false)
        }}
      />
    )
  }

  return (
    <article className="flex flex-col gap-3 rounded-xl border bg-white px-5 py-4" style={{ borderColor: c.status === 'ok' || c.status === 'none' ? '#D5D9D3' : st.border }}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-base font-bold">{c.kind}</span>
            {c.number && <span className="font-mono text-sm">nr {c.number}</span>}
          </span>
          <span className="self-start rounded-md px-2 py-0.5 text-[12.5px] font-semibold" style={{ background: st.bg, color: st.fg }}>
            {certStatusText(c.status, c.validTo, c.daysLeft)}
          </span>
          {c.notes && <span className="text-[13px] text-[#545B63]">{c.notes}</span>}
        </div>
        <span className="ml-auto flex flex-wrap gap-2">
          <button type="button" onClick={onCopy} className={BTN} aria-label={`Kopiuj dane ${c.kind}`}>
            <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Skopiowano' : 'Kopiuj dane'}
          </button>
          <button type="button" onClick={() => setEditing(true)} className={BTN}>
            <Icon name="pencil" size={14} /> Edytuj
          </button>
          {confirm === 'cert' ? (
            <>
              <button type="button" onClick={() => setConfirm(null)} className={BTN}>
                Nie
              </button>
              <button type="button" disabled={busy} onClick={() => void onDelete()} className="inline-flex h-10 items-center rounded-lg bg-[#9B1C1C] px-3 text-sm font-semibold text-white">
                Usuń ze skanami
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirm('cert')} className={`${BTN} text-[#9B1C1C]`}>
              <Icon name="trash" size={14} /> Usuń
            </button>
          )}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]">Skany ({c.files.length})</span>
        {c.files.length === 0 && <span className="text-[13px] text-[#545B63]">Brak skanu.</span>}
        <ul className="flex flex-col">
          {c.files.map(f => (
            <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#ECEEEA] py-2 text-sm first:border-t-0">
              <span className="min-w-0 flex-1 truncate font-semibold" title={f.filename}>
                {f.filename}
              </span>
              <span className="text-xs text-[#545B63]">
                {fileSize(f.size)} · {f.uploadedBy}, {stamp(f.uploadedAt)}
              </span>
              <a href={certFileUrl(f.id)} target="_blank" rel="noopener" className={BTN}>
                Podgląd
              </a>
              <a href={certFileUrl(f.id, true)} download={f.filename} className={BTN}>
                Pobierz
              </a>
              {confirm === f.id ? (
                <>
                  <button type="button" onClick={() => setConfirm(null)} className={BTN}>
                    Nie
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onDeleteFile(f.id, f.filename).then(() => setConfirm(null))}
                    className="inline-flex h-10 items-center rounded-lg bg-[#9B1C1C] px-3 text-sm font-semibold text-white"
                  >
                    Usuń plik
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirm(f.id)} aria-label={`Usuń ${f.filename}`} className={`${BTN} text-[#9B1C1C]`}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
        <span>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            aria-label={`Dodaj skan do ${c.kind}`}
            className="sr-only"
            onChange={e => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              const problem = checkFile(file)
              if (problem) return onError(problem)
              void onUpload(file)
            }}
          />
          <button type="button" disabled={busy} onClick={() => fileInput.current?.click()} className={BTN}>
            <Icon name="upload" size={14} /> Dodaj skan
          </button>
        </span>
      </div>
      <span className="text-xs text-[#8A939C]">
        Zmieniony {stamp(c.updatedAt)} · {c.updatedBy}
      </span>
    </article>
  )
}
