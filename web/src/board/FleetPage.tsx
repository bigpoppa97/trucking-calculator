import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import {
  boardApi,
  errorMessage,
  type FleetTruck,
  type GeocodeCandidate,
  type Place,
  type Thresholds,
  type Trailer,
} from './boardApi.js'
import { todayIso } from './format.js'
import { Icon } from './Icon.js'

/**
 * "Flota": the registries the board depends on — trucks (with plate history),
 * trailers (types + typo aliases), places (aliases, coordinates, manual
 * distances) and the warning thresholds used by the review queue.
 */

const INPUT = 'h-10 rounded-lg border border-[#C9CEC6] bg-white px-3 text-sm'
const BTN = 'inline-flex h-10 items-center gap-1.5 rounded-lg border border-[#C9CEC6] bg-white px-3 text-sm font-semibold hover:border-[#9AA3AC] disabled:opacity-50'
const BTN_PRIMARY = 'inline-flex h-10 items-center gap-1.5 rounded-lg bg-[#1E4E9C] px-4 text-sm font-semibold text-white disabled:opacity-50'
const CARD = 'flex flex-col gap-4 rounded-xl border border-[#D5D9D3] bg-white px-5 py-4'
const TH = 'px-3 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wider text-[#545B63]'
const TD = 'px-3 py-2.5 align-top'

type Section = 'trucks' | 'trailers' | 'places' | 'thresholds'

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'trucks', label: 'Ciągniki' },
  { id: 'trailers', label: 'Naczepy' },
  { id: 'places', label: 'Miejsca i odległości' },
  { id: 'thresholds', label: 'Progi ostrzeżeń' },
]

export function FleetPage({ onChanged }: { onChanged?: () => void }) {
  const [section, setSection] = useState<Section>('trucks')
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-[22px] font-bold">Flota i słowniki</h1>
        <nav aria-label="Sekcje floty">
          <ul className="flex flex-wrap gap-1 rounded-lg bg-[#E2E5DF] p-1">
            {SECTIONS.map(s => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSection(s.id)}
                  aria-current={section === s.id ? 'page' : undefined}
                  className={`h-9 rounded-md px-3 text-sm font-semibold ${section === s.id ? 'bg-white text-[#15181C] shadow-sm' : 'text-[#545B63] hover:text-[#15181C]'}`}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      {section === 'trucks' && <TrucksSection {...(onChanged ? { onChanged } : {})} />}
      {section === 'trailers' && <TrailersSection />}
      {section === 'places' && <PlacesSection />}
      {section === 'thresholds' && <ThresholdsSection {...(onChanged ? { onChanged } : {})} />}
    </div>
  )
}

function Alert({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
      {text}
    </p>
  )
}

function Done({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p role="status" className="rounded-lg bg-[#E3F1E6] px-4 py-2.5 text-sm text-[#14532D]">
      {text}
    </p>
  )
}

/** Runs an async action with shared busy/error/success state. */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const run = useCallback(async (fn: () => Promise<unknown>, okText: string | null, failText: string) => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      await fn()
      setDone(okText)
      return true
    } catch (e) {
      setError(errorMessage(e, failText))
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, done, run, setError }
}

function fmtDay(iso: string | null): string {
  if (!iso) return ''
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
}

// ---------------------------------------------------------------- trucks

function TrucksSection({ onChanged }: { onChanged?: () => void }) {
  const [trucks, setTrucks] = useState<FleetTruck[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [replating, setReplating] = useState<number | null>(null)
  const action = useAction()

  const load = useCallback(async () => {
    try {
      setTrucks(await boardApi.fleet())
      setLoadError(null)
    } catch (e) {
      setLoadError(errorMessage(e, 'Nie udało się wczytać floty.'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const changed = async () => {
    await load()
    onChanged?.()
  }

  const move = async (index: number, dir: -1 | 1) => {
    if (!trucks) return
    const target = index + dir
    if (target < 0 || target >= trucks.length) return
    const order = [...trucks]
    const a = order[index]
    const b = order[target]
    if (!a || !b) return
    order[index] = b
    order[target] = a
    await action.run(
      async () => {
        for (const [i, t] of order.entries()) {
          if (t.sortOrder !== i + 1) await boardApi.updateTruck(t.id, { sortOrder: i + 1 })
        }
        await changed()
      },
      null,
      'Nie udało się zmienić kolejności.',
    )
  }

  return (
    <section aria-labelledby="trucks-h" className="flex flex-col gap-4">
      <div className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="trucks-h" className="text-base font-bold">
            Ciągniki w dziale
          </h2>
          <span className="text-[13px] text-[#545B63]">
            Kolejność tutaj = kolejność wierszy na tablicy. Numer rejestracyjny zmieniaj przez „Nowy numer” — stare zlecenia zostaną przy tym samym aucie.
          </span>
        </div>
        <Alert text={loadError ?? action.error} />
        <Done text={action.done} />
        {trucks && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#D5D9D3]">
                  <th className={TH}>Kolejność</th>
                  <th className={TH}>Ciągnik</th>
                  <th className={TH}>Przewoźnik</th>
                  <th className={TH}>Kierowca</th>
                  <th className={TH}>Telefon</th>
                  <th className={TH}>Naczepa (stała)</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>
                    <span className="sr-only">Akcje</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {trucks.map((t, i) =>
                  editing === t.id ? (
                    <TruckEditRow
                      key={t.id}
                      truck={t}
                      onCancel={() => setEditing(null)}
                      onSave={async patch => {
                        const ok = await action.run(
                          async () => {
                            await boardApi.updateTruck(t.id, patch)
                            await changed()
                          },
                          `Zapisano ${t.currentPlate}.`,
                          'Nie udało się zapisać zmian.',
                        )
                        if (ok) setEditing(null)
                      }}
                      busy={action.busy}
                    />
                  ) : (
                    <TruckRow
                      key={t.id}
                      truck={t}
                      first={i === 0}
                      last={i === trucks.length - 1}
                      replating={replating === t.id}
                      busy={action.busy}
                      onMove={dir => void move(i, dir)}
                      onEdit={() => {
                        setReplating(null)
                        setEditing(t.id)
                      }}
                      onReplate={() => {
                        setEditing(null)
                        setReplating(replating === t.id ? null : t.id)
                      }}
                      onSavePlate={async (plate, validFrom) => {
                        const ok = await action.run(
                          async () => {
                            await boardApi.addPlate(t.id, plate, validFrom)
                            await changed()
                          },
                          `Nowy numer zapisany — od ${fmtDay(validFrom)} zlecenia na ${plate.toUpperCase()} trafią do tego auta.`,
                          'Nie udało się zapisać numeru.',
                        )
                        if (ok) setReplating(null)
                      }}
                    />
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <NewTruckForm
        onCreated={async plate => {
          await changed()
          action.setError(null)
          return plate
        }}
      />
    </section>
  )
}

function TruckRow(props: {
  truck: FleetTruck
  first: boolean
  last: boolean
  replating: boolean
  busy: boolean
  onMove: (dir: -1 | 1) => void
  onEdit: () => void
  onReplate: () => void
  onSavePlate: (plate: string, validFrom: string) => Promise<void>
}) {
  const { truck: t } = props
  const history = [...t.plates].sort((a, b) => b.validFrom.localeCompare(a.validFrom)).filter(p => p.plate !== t.currentPlate || p.validTo)
  return (
    <>
      <tr className={`border-b border-[#ECEEEA] ${t.active ? '' : 'text-[#8A939C]'}`}>
        <td className={TD}>
          <span className="flex gap-1">
            <button type="button" disabled={props.first || props.busy} onClick={() => props.onMove(-1)} className="h-8 w-8 rounded-md border border-[#D5D9D3] disabled:opacity-30" aria-label={`Przesuń ${t.currentPlate} wyżej`}>
              ↑
            </button>
            <button type="button" disabled={props.last || props.busy} onClick={() => props.onMove(1)} className="h-8 w-8 rounded-md border border-[#D5D9D3] disabled:opacity-30" aria-label={`Przesuń ${t.currentPlate} niżej`}>
              ↓
            </button>
          </span>
        </td>
        <td className={TD}>
          <span className="block font-mono text-[15px] font-semibold">{t.currentPlate || '—'}</span>
          {history.length > 0 && (
            <span className="mt-0.5 block text-xs text-[#545B63]">
              {history
                .filter(p => p.validTo)
                .map(p => `wcześniej ${p.plate} (do ${fmtDay(p.validTo)})`)
                .join(' · ')}
            </span>
          )}
        </td>
        <td className={TD}>{t.carrier || <span className="text-[#8A939C]">—</span>}</td>
        <td className={TD}>{t.driver || <span className="text-[#8A939C]">—</span>}</td>
        <td className={`${TD} font-mono`}>{t.phone || <span className="text-[#8A939C]">—</span>}</td>
        <td className={`${TD} font-mono`}>{t.trailerPlate || <span className="text-[#8A939C]">—</span>}</td>
        <td className={TD}>
          {t.active ? (
            <span className="rounded bg-[#E3F1E6] px-2 py-0.5 text-xs font-semibold text-[#14532D]">aktywny</span>
          ) : (
            <span className="rounded bg-[#ECEEEA] px-2 py-0.5 text-xs font-semibold text-[#545B63]">ukryty</span>
          )}
        </td>
        <td className={`${TD} whitespace-nowrap text-right`}>
          <span className="inline-flex gap-2">
            <button type="button" onClick={props.onEdit} className={BTN}>
              <Icon name="pencil" size={14} /> Edytuj
            </button>
            <button type="button" onClick={props.onReplate} aria-expanded={props.replating} className={BTN}>
              Nowy numer
            </button>
          </span>
        </td>
      </tr>
      {props.replating && (
        <tr className="border-b border-[#ECEEEA] bg-[#F6F7F4]">
          <td colSpan={8} className="px-3 py-3">
            <ReplateForm current={t.currentPlate} busy={props.busy} onSave={props.onSavePlate} />
          </td>
        </tr>
      )}
    </>
  )
}

function ReplateForm({ current, busy, onSave }: { current: string; busy: boolean; onSave: (plate: string, validFrom: string) => Promise<void> }) {
  const id = useId()
  const [plate, setPlate] = useState('')
  const [from, setFrom] = useState(todayIso())
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={e => {
        e.preventDefault()
        if (plate.trim()) void onSave(plate.trim(), from)
      }}
    >
      <span className="text-sm text-[#545B63]">
        {current} dostaje nowe tablice. Zlecenia sprzed tej daty zostają przy starym numerze tego samego auta.
      </span>
      <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-p`}>
        Nowy numer
        <input id={`${id}-p`} value={plate} onChange={e => setPlate(e.target.value)} className={`${INPUT} w-40 font-mono uppercase`} placeholder="np. KN1234X" required />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-d`}>
        Obowiązuje od
        <input id={`${id}-d`} type="date" value={from} onChange={e => setFrom(e.target.value)} className={INPUT} required />
      </label>
      <button type="submit" disabled={busy || !plate.trim()} className={BTN_PRIMARY}>
        Zapisz numer
      </button>
    </form>
  )
}

function TruckEditRow({
  truck,
  busy,
  onCancel,
  onSave,
}: {
  truck: FleetTruck
  busy: boolean
  onCancel: () => void
  onSave: (patch: { carrier: string; driver: string; phone: string; trailerPlate: string | null; active: boolean }) => Promise<void>
}) {
  const id = useId()
  const [carrier, setCarrier] = useState(truck.carrier)
  const [driver, setDriver] = useState(truck.driver)
  const [phone, setPhone] = useState(truck.phone)
  const [trailer, setTrailer] = useState(truck.trailerPlate ?? '')
  const [active, setActive] = useState(truck.active)
  const submit = () => void onSave({ carrier: carrier.trim(), driver: driver.trim(), phone: phone.trim(), trailerPlate: trailer.trim() || null, active })
  return (
    <tr className="border-b border-[#ECEEEA] bg-[#F6F7F4]">
      <td className={TD} />
      <td className={`${TD} font-mono text-[15px] font-semibold`}>{truck.currentPlate}</td>
      <td className={TD}>
        <label className="sr-only" htmlFor={`${id}-c`}>
          Przewoźnik
        </label>
        <input id={`${id}-c`} value={carrier} onChange={e => setCarrier(e.target.value)} className={`${INPUT} w-full`} />
      </td>
      <td className={TD}>
        <label className="sr-only" htmlFor={`${id}-d`}>
          Kierowca
        </label>
        <input id={`${id}-d`} value={driver} onChange={e => setDriver(e.target.value)} className={`${INPUT} w-full`} />
      </td>
      <td className={TD}>
        <label className="sr-only" htmlFor={`${id}-p`}>
          Telefon
        </label>
        <input id={`${id}-p`} value={phone} onChange={e => setPhone(e.target.value)} className={`${INPUT} w-full font-mono`} />
      </td>
      <td className={TD}>
        <label className="sr-only" htmlFor={`${id}-t`}>
          Naczepa
        </label>
        <input id={`${id}-t`} value={trailer} onChange={e => setTrailer(e.target.value)} className={`${INPUT} w-32 font-mono uppercase`} />
      </td>
      <td className={TD}>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="h-4 w-4" />
          na tablicy
        </label>
      </td>
      <td className={`${TD} whitespace-nowrap text-right`}>
        <span className="inline-flex gap-2">
          <button type="button" onClick={onCancel} className={BTN}>
            Anuluj
          </button>
          <button type="button" onClick={submit} disabled={busy} className={BTN_PRIMARY}>
            Zapisz
          </button>
        </span>
      </td>
    </tr>
  )
}

function NewTruckForm({ onCreated }: { onCreated: (plate: string) => Promise<string> }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [plate, setPlate] = useState('')
  const [from, setFrom] = useState(todayIso())
  const [carrier, setCarrier] = useState('')
  const [driver, setDriver] = useState('')
  const [phone, setPhone] = useState('')
  const [trailer, setTrailer] = useState('')
  const action = useAction()

  if (!open) {
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)} className={BTN}>
          <Icon name="plus" size={14} /> Dodaj ciągnik do działu
        </button>
      </div>
    )
  }

  const field = (key: string, label: string, value: string, set: (v: string) => void, extra = '', type = 'text') => (
    <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-${key}`}>
      {label}
      <input id={`${id}-${key}`} type={type} value={value} onChange={e => set(e.target.value)} className={`${INPUT} ${extra}`} />
    </label>
  )

  return (
    <form
      className={CARD}
      onSubmit={e => {
        e.preventDefault()
        void action
          .run(
            async () => {
              await boardApi.createTruck({
                plate: plate.trim(),
                validFrom: from,
                ...(carrier.trim() ? { carrier: carrier.trim() } : {}),
                ...(driver.trim() ? { driver: driver.trim() } : {}),
                ...(phone.trim() ? { phone: phone.trim() } : {}),
                ...(trailer.trim() ? { trailerPlate: trailer.trim() } : {}),
              })
              await onCreated(plate)
            },
            `Dodano ${plate.trim().toUpperCase()}. Zlecenia tego auta pojawią się po najbliższym imporcie.`,
            'Nie udało się dodać auta.',
          )
          .then(ok => {
            if (ok) {
              setPlate('')
              setCarrier('')
              setDriver('')
              setPhone('')
              setTrailer('')
            }
          })
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-bold">Nowy ciągnik w dziale</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-[#545B63] underline">
          Zamknij
        </button>
      </div>
      <Alert text={action.error} />
      <Done text={action.done} />
      <div className="flex flex-wrap items-end gap-3">
        {field('plate', 'Numer ciągnika *', plate, setPlate, 'w-40 font-mono uppercase')}
        {field('from', 'W dziale od *', from, setFrom, '', 'date')}
        {field('carrier', 'Przewoźnik (jak w aplikacji)', carrier, setCarrier, 'w-72')}
        {field('driver', 'Kierowca', driver, setDriver, 'w-48')}
        {field('phone', 'Telefon', phone, setPhone, 'w-40 font-mono')}
        {field('trailer', 'Naczepa', trailer, setTrailer, 'w-32 font-mono uppercase')}
        <button type="submit" disabled={action.busy || !plate.trim()} className={BTN_PRIMARY}>
          Dodaj
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------- trailers

function TrailersSection() {
  const id = useId()
  const [trailers, setTrailers] = useState<Trailer[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [plate, setPlate] = useState('')
  const [typePl, setTypePl] = useState('')
  const [typeEn, setTypeEn] = useState('')
  const [aliasFor, setAliasFor] = useState<string | null>(null)
  const [alias, setAlias] = useState('')
  const action = useAction()

  const load = useCallback(async () => {
    try {
      setTrailers(await boardApi.trailers())
      setLoadError(null)
    } catch (e) {
      setLoadError(errorMessage(e, 'Nie udało się wczytać naczep.'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const startEdit = (t: Trailer) => {
    setPlate(t.plate)
    setTypePl(t.typePl)
    setTypeEn(t.typeEn)
  }

  const save = () =>
    void action
      .run(
        async () => {
          await boardApi.saveTrailer({
            plate: plate.trim(),
            ...(typePl.trim() ? { typePl: typePl.trim() } : {}),
            ...(typeEn.trim() ? { typeEn: typeEn.trim() } : {}),
          })
          await load()
        },
        `Zapisano naczepę ${plate.trim().toUpperCase()}.`,
        'Nie udało się zapisać naczepy.',
      )
      .then(ok => {
        if (ok) {
          setPlate('')
          setTypePl('')
          setTypeEn('')
        }
      })

  const saveAlias = (trailerPlate: string) =>
    void action
      .run(
        async () => {
          await boardApi.addTrailerAlias(alias.trim(), trailerPlate)
          await load()
        },
        `Od teraz „${alias.trim()}” w eksporcie = ${trailerPlate}.`,
        'Nie udało się zapisać aliasu.',
      )
      .then(ok => {
        if (ok) {
          setAlias('')
          setAliasFor(null)
        }
      })

  return (
    <section aria-labelledby="trailers-h" className="flex flex-col gap-4">
      <div className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="trailers-h" className="text-base font-bold">
            Naczepy
          </h2>
          <span className="text-[13px] text-[#545B63]">Typ trafia do tekstu „Kopiuj dane auta”. Alias = literówka z aplikacji, którą tablica ma rozpoznawać.</span>
        </div>
        <Alert text={loadError ?? action.error} />
        <Done text={action.done} />
        {trailers && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#D5D9D3]">
                  <th className={TH}>Naczepa</th>
                  <th className={TH}>Typ (PL)</th>
                  <th className={TH}>Typ (EN)</th>
                  <th className={TH}>Rozpoznawane też jako</th>
                  <th className={TH}>
                    <span className="sr-only">Akcje</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {trailers.map(t => (
                  <tr key={t.plate} className="border-b border-[#ECEEEA]">
                    <td className={`${TD} font-mono font-semibold`}>{t.plate}</td>
                    <td className={TD}>{t.typePl}</td>
                    <td className={TD}>{t.typeEn}</td>
                    <td className={TD}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {t.aliases.map(a => (
                          <span key={a} className="rounded bg-[#ECEEEA] px-2 py-0.5 font-mono text-xs">
                            {a}
                          </span>
                        ))}
                        {aliasFor === t.plate ? (
                          <form
                            className="flex items-center gap-1.5"
                            onSubmit={e => {
                              e.preventDefault()
                              if (alias.trim()) saveAlias(t.plate)
                            }}
                          >
                            <label className="sr-only" htmlFor={`${id}-alias-${t.plate}`}>
                              Alias dla {t.plate}
                            </label>
                            <input id={`${id}-alias-${t.plate}`} value={alias} onChange={e => setAlias(e.target.value)} className={`${INPUT} h-8 w-32 font-mono uppercase`} autoFocus />
                            <button type="submit" disabled={action.busy || !alias.trim()} className="h-8 rounded-md bg-[#1E4E9C] px-2.5 text-xs font-semibold text-white disabled:opacity-50">
                              Dodaj
                            </button>
                            <button type="button" onClick={() => setAliasFor(null)} className="h-8 px-1.5 text-xs text-[#545B63] underline">
                              Anuluj
                            </button>
                          </form>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setAlias('')
                              setAliasFor(t.plate)
                            }}
                            className="h-7 rounded-md border border-dashed border-[#C9CEC6] px-2 text-xs text-[#545B63] hover:text-[#15181C]"
                          >
                            + alias
                          </button>
                        )}
                      </span>
                    </td>
                    <td className={`${TD} text-right`}>
                      <button type="button" onClick={() => startEdit(t)} className={BTN}>
                        <Icon name="pencil" size={14} /> Edytuj typ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <form
        className={CARD}
        onSubmit={e => {
          e.preventDefault()
          if (plate.trim()) save()
        }}
      >
        <h2 className="text-base font-bold">Dodaj lub zmień naczepę</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-plate`}>
            Numer *
            <input id={`${id}-plate`} value={plate} onChange={e => setPlate(e.target.value)} className={`${INPUT} w-36 font-mono uppercase`} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-pl`}>
            Typ (PL)
            <input id={`${id}-pl`} value={typePl} onChange={e => setTypePl(e.target.value)} placeholder="chłodnia 2,61 m · rolki" className={`${INPUT} w-64`} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-en`}>
            Typ (EN)
            <input id={`${id}-en`} value={typeEn} onChange={e => setTypeEn(e.target.value)} placeholder="cooler 2.61m rollerbed" className={`${INPUT} w-64`} />
          </label>
          <button type="submit" disabled={action.busy || !plate.trim()} className={BTN_PRIMARY}>
            Zapisz naczepę
          </button>
        </div>
        <span className="text-xs text-[#545B63]">Puste pola typu przy nowej naczepie = domyślna chłodnia 2,61 m z rolkami.</span>
      </form>
    </section>
  )
}

// ---------------------------------------------------------------- places

function PlacesSection() {
  const id = useId()
  const [places, setPlaces] = useState<Place[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [aliasFor, setAliasFor] = useState<string | null>(null)
  const [alias, setAlias] = useState('')
  const action = useAction()

  const load = useCallback(async () => {
    try {
      setPlaces(await boardApi.places())
      setLoadError(null)
    } catch (e) {
      setLoadError(errorMessage(e, 'Nie udało się wczytać miejsc.'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const shown = useMemo(() => {
    if (!places) return []
    const q = fold(filter.trim())
    if (!q) return places
    return places.filter(p => fold(`${p.code} ${p.name} ${p.country} ${p.aliases.join(' ')}`).includes(q))
  }, [places, filter])

  const saveAlias = (code: string) =>
    void action
      .run(
        async () => {
          await boardApi.addPlaceAlias(alias.trim(), code)
          await load()
        },
        `Od teraz „${alias.trim()}” = ${code}.`,
        'Nie udało się zapisać aliasu.',
      )
      .then(ok => {
        if (ok) {
          setAlias('')
          setAliasFor(null)
        }
      })

  return (
    <section aria-labelledby="places-h" className="flex flex-col gap-4">
      <div className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="places-h" className="text-base font-bold">
            Słownik miejsc
          </h2>
          <label className="flex items-center gap-2 text-sm" htmlFor={`${id}-filter`}>
            <Icon name="search" size={16} className="text-[#545B63]" />
            <span className="sr-only">Szukaj miejsca</span>
            <input id={`${id}-filter`} value={filter} onChange={e => setFilter(e.target.value)} placeholder="kod, nazwa lub alias" className={`${INPUT} w-64`} />
          </label>
        </div>
        <Alert text={loadError ?? action.error} />
        <Done text={action.done} />
        {places && (
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-[#D5D9D3]">
                  <th className={TH}>Kod</th>
                  <th className={TH}>Nazwa</th>
                  <th className={TH}>Kraj</th>
                  <th className={TH}>Współrzędne</th>
                  <th className={TH}>Aliasy z eksportu</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(p => (
                  <tr key={p.code} className="border-b border-[#ECEEEA]">
                    <td className={`${TD} font-mono font-semibold`}>
                      {p.code}
                      {p.kind === 'custom' && <span className="ml-1.5 rounded bg-[#DCE5F2] px-1.5 py-0.5 font-sans text-[10.5px] font-semibold uppercase">własne</span>}
                    </td>
                    <td className={TD}>{p.name}</td>
                    <td className={`${TD} font-mono`}>{p.country}</td>
                    <td className={`${TD} font-mono text-xs text-[#545B63]`}>
                      {p.lat.toFixed(4)}, {p.lon.toFixed(4)}
                    </td>
                    <td className={TD}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {p.aliases.map(a => (
                          <span key={a} className="rounded bg-[#ECEEEA] px-2 py-0.5 text-xs">
                            {a}
                          </span>
                        ))}
                        {aliasFor === p.code ? (
                          <form
                            className="flex items-center gap-1.5"
                            onSubmit={e => {
                              e.preventDefault()
                              if (alias.trim()) saveAlias(p.code)
                            }}
                          >
                            <label className="sr-only" htmlFor={`${id}-alias-${p.code}`}>
                              Alias dla {p.code}
                            </label>
                            <input id={`${id}-alias-${p.code}`} value={alias} onChange={e => setAlias(e.target.value)} className={`${INPUT} h-8 w-44`} autoFocus />
                            <button type="submit" disabled={action.busy || !alias.trim()} className="h-8 rounded-md bg-[#1E4E9C] px-2.5 text-xs font-semibold text-white disabled:opacity-50">
                              Dodaj
                            </button>
                            <button type="button" onClick={() => setAliasFor(null)} className="h-8 px-1.5 text-xs text-[#545B63] underline">
                              Anuluj
                            </button>
                          </form>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setAlias('')
                              setAliasFor(p.code)
                            }}
                            className="h-7 rounded-md border border-dashed border-[#C9CEC6] px-2 text-xs text-[#545B63] hover:text-[#15181C]"
                          >
                            + alias
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-sm text-[#545B63]">
                      Brak miejsc pasujących do „{filter}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <NewPlaceForm onCreated={load} />
        <DistanceForm places={places ?? []} />
      </div>
    </section>
  )
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
}

function NewPlaceForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<GeocodeCandidate[] | null>(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [country, setCountry] = useState('')
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const action = useAction()

  const search = () =>
    void action.run(
      async () => {
        const found = await boardApi.geocode(query.trim())
        setCandidates(found)
      },
      null,
      'Wyszukiwanie nie zadziałało — wpisz współrzędne ręcznie.',
    )

  const pick = (c: GeocodeCandidate) => {
    setName(prev => prev || query.trim())
    setCountry(c.country.slice(0, 2).toUpperCase())
    setLat(String(c.lat))
    setLon(String(c.lon))
  }

  const latN = Number(lat.replace(',', '.'))
  const lonN = Number(lon.replace(',', '.'))
  const valid = name.trim() !== '' && lat.trim() !== '' && lon.trim() !== '' && Number.isFinite(latN) && Number.isFinite(lonN)

  return (
    <form
      className={`${CARD} min-w-0 flex-[1_1_520px]`}
      onSubmit={e => {
        e.preventDefault()
        if (!valid) return
        void action
          .run(
            async () => {
              const created = await boardApi.createPlace({
                name: name.trim(),
                lat: latN,
                lon: lonN,
                ...(code.trim() ? { code: code.trim() } : {}),
                ...(country.trim() ? { country: country.trim().toUpperCase() } : {}),
              })
              await onCreated()
              return created
            },
            `Dodano miejsce ${name.trim()}.`,
            'Nie udało się dodać miejsca.',
          )
          .then(ok => {
            if (ok) {
              setQuery('')
              setCandidates(null)
              setName('')
              setCode('')
              setCountry('')
              setLat('')
              setLon('')
            }
          })
      }}
    >
      <h2 className="text-base font-bold">Nowe miejsce (np. przepinka poza lotniskiem)</h2>
      <Alert text={action.error} />
      <Done text={action.done} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-q`}>
          Znajdź na mapie
          <input
            id={`${id}-q`}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (query.trim().length >= 2) search()
              }
            }}
            placeholder="np. Gorzyczki, Polska"
            className={`${INPUT} w-72`}
          />
        </label>
        <button type="button" onClick={search} disabled={action.busy || query.trim().length < 2} className={BTN}>
          <Icon name="search" size={14} /> Szukaj
        </button>
      </div>
      {candidates && candidates.length === 0 && <p className="text-sm text-[#545B63]">Nic nie znaleziono — wpisz współrzędne ręcznie (np. z Google Maps: prawy klik na mapie).</p>}
      {candidates && candidates.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {candidates.map(c => (
            <li key={`${c.lat},${c.lon}`}>
              <button
                type="button"
                onClick={() => pick(c)}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${String(c.lat) === lat && String(c.lon) === lon ? 'border-[#1E4E9C] bg-[#EEF3FB]' : 'border-[#D5D9D3] hover:border-[#9AA3AC]'}`}
              >
                {c.title} <span className="font-mono text-xs text-[#545B63]">({c.lat.toFixed(4)}, {c.lon.toFixed(4)})</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-n`}>
          Nazwa *
          <input id={`${id}-n`} value={name} onChange={e => setName(e.target.value)} className={`${INPUT} w-56`} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-k`}>
          Kod (opcjonalnie)
          <input id={`${id}-k`} value={code} onChange={e => setCode(e.target.value)} placeholder="auto" maxLength={8} className={`${INPUT} w-24 font-mono uppercase`} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-c`}>
          Kraj
          <input id={`${id}-c`} value={country} onChange={e => setCountry(e.target.value)} placeholder="PL" maxLength={2} className={`${INPUT} w-16 font-mono uppercase`} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-lat`}>
          Szerokość *
          <input id={`${id}-lat`} value={lat} onChange={e => setLat(e.target.value)} inputMode="decimal" className={`${INPUT} w-32 font-mono`} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-lon`}>
          Długość *
          <input id={`${id}-lon`} value={lon} onChange={e => setLon(e.target.value)} inputMode="decimal" className={`${INPUT} w-32 font-mono`} />
        </label>
        <button type="submit" disabled={action.busy || !valid} className={BTN_PRIMARY}>
          Dodaj miejsce
        </button>
      </div>
      <span className="text-xs text-[#545B63]">Kod 3-literowy jest zarezerwowany dla lotnisk — własne miejsca dostają 4 znaki. Kilometry do nowego miejsca liczą się raz, potem są w bazie.</span>
    </form>
  )
}

function DistanceForm({ places }: { places: Place[] }) {
  const id = useId()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [kmValue, setKmValue] = useState('')
  const [note, setNote] = useState('')
  const action = useAction()
  const kmN = Number(kmValue.replace(',', '.'))
  const valid = from !== '' && to !== '' && from !== to && kmValue.trim() !== '' && Number.isFinite(kmN) && kmN >= 0

  return (
    <form
      className={`${CARD} min-w-0 flex-[1_1_380px]`}
      onSubmit={e => {
        e.preventDefault()
        if (!valid) return
        void action
          .run(
            () => boardApi.setDistance(from, to, kmN, note.trim() || undefined),
            `Zapisano ${from}–${to}: ${Math.round(kmN)} km (w obie strony).`,
            'Nie udało się zapisać odległości.',
          )
          .then(ok => {
            if (ok) {
              setKmValue('')
              setNote('')
            }
          })
      }}
    >
      <h2 className="text-base font-bold">Odległość ustalona ręcznie</h2>
      <span className="text-[13px] text-[#545B63]">Ma pierwszeństwo przed kalkulatorem i HERE dla wszystkich zleceń na tej parze miejsc. Pojedyncze zlecenie popraw w jego panelu.</span>
      <Alert text={action.error} />
      <Done text={action.done} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-f`}>
          Skąd
          <select id={`${id}-f`} value={from} onChange={e => setFrom(e.target.value)} className={`${INPUT} w-48`}>
            <option value="">—</option>
            {places.map(p => (
              <option key={p.code} value={p.code}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-t`}>
          Dokąd
          <select id={`${id}-t`} value={to} onChange={e => setTo(e.target.value)} className={`${INPUT} w-48`}>
            <option value="">—</option>
            {places.map(p => (
              <option key={p.code} value={p.code}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-km`}>
          Km
          <input id={`${id}-km`} value={kmValue} onChange={e => setKmValue(e.target.value)} inputMode="decimal" className={`${INPUT} w-24 font-mono`} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#545B63]" htmlFor={`${id}-note`}>
          Uwaga
          <input id={`${id}-note`} value={note} onChange={e => setNote(e.target.value)} placeholder="np. objazd A4" className={`${INPUT} w-44`} />
        </label>
        <button type="submit" disabled={action.busy || !valid} className={BTN_PRIMARY}>
          Zapisz
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------- thresholds

function ThresholdsSection({ onChanged }: { onChanged?: () => void }) {
  const id = useId()
  const [values, setValues] = useState<{ margin: string; min: string; max: string } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const action = useAction()

  useEffect(() => {
    boardApi
      .thresholds()
      .then((t: Thresholds) => setValues({ margin: String(t.marginWarnPct), min: String(t.revPerKmMin), max: String(t.revPerKmMax) }))
      .catch(e => setLoadError(errorMessage(e, 'Nie udało się wczytać progów.')))
  }, [])

  if (!values) return <Alert text={loadError} />

  const num = (s: string) => Number(s.replace(',', '.'))
  const valid = [values.margin, values.min, values.max].every(v => v.trim() !== '' && Number.isFinite(num(v))) && num(values.margin) >= 1 && num(values.margin) <= 100 && num(values.min) < num(values.max)

  return (
    <form
      className={`${CARD} max-w-[760px]`}
      onSubmit={e => {
        e.preventDefault()
        if (!valid) return
        void action.run(
          async () => {
            const t = await boardApi.saveThresholds({ marginWarnPct: num(values.margin), revPerKmMin: num(values.min), revPerKmMax: num(values.max) })
            setValues({ margin: String(t.marginWarnPct), min: String(t.revPerKmMin), max: String(t.revPerKmMax) })
            onChanged?.()
          },
          'Zapisano — lista „Do sprawdzenia” została przeliczona z nowymi progami.',
          'Nie udało się zapisać progów.',
        )
      }}
    >
      <h2 className="text-base font-bold">Kiedy zlecenie trafia do sprawdzenia</h2>
      <Alert text={loadError ?? action.error} />
      <Done text={action.done} />
      <div className="grid gap-4 sm:grid-cols-3">
        <ThresholdField id={`${id}-m`} label="Wysoka marża od (%)" hint="Zwykle oznacza przepinkę bez wpisu PRZ albo koszt w PLN." value={values.margin} onChange={v => setValues({ ...values, margin: v })} />
        <ThresholdField id={`${id}-min`} label="Stawka klienta / km — min (€)" hint="Poniżej — podejrzenie kwoty w PLN lub złych km." value={values.min} onChange={v => setValues({ ...values, min: v })} />
        <ThresholdField id={`${id}-max`} label="Stawka klienta / km — max (€)" hint="Powyżej — np. PLN wpisane jako EUR." value={values.max} onChange={v => setValues({ ...values, max: v })} />
      </div>
      <div>
        <button type="submit" disabled={action.busy || !valid} className={BTN_PRIMARY}>
          Zapisz progi
        </button>
      </div>
    </form>
  )
}

function ThresholdField({ id, label, hint, value, onChange }: { id: string; label: string; hint: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-semibold" htmlFor={id}>
        {label}
      </label>
      <input id={id} aria-describedby={`${id}-hint`} value={value} onChange={e => onChange(e.target.value)} inputMode="decimal" className={`${INPUT} font-mono`} />
      <span id={`${id}-hint`} className="text-xs text-[#545B63]">
        {hint}
      </span>
    </div>
  )
}
