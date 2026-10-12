import { useEffect, useId, useState } from 'react'
import { boardApi, errorMessage, type DraftData, type DraftForm } from './boardApi.js'
import { addDaysIso, dm } from './format.js'
import { Icon } from './Icon.js'

/**
 * Preliminary order (zlecenie wstępne, 12.10.2026): agreed with the client
 * before the order is in the application. Added with "+" under a day of a
 * truck; an imported order on that truck (loading within a day) replaces it.
 */

export function DraftDialog({
  truck,
  day,
  draft,
  orderNo,
  onClose,
  onSaved,
}: {
  truck: { id: number; plate: string }
  /** Loading day for a new draft. */
  day?: string
  /** Existing draft (edit). */
  draft?: DraftData | null
  orderNo?: string
  onClose: () => void
  onSaved: (message?: string) => void
}) {
  const editing = Boolean(draft && orderNo)
  const start = draft?.loadDate ?? day ?? ''
  const [form, setForm] = useState<DraftForm>(() => ({
    loadPlaces: draft?.loadPlaces ?? '',
    loadDate: start,
    loadTime: draft?.loadTime ?? '',
    unloadPlaces: draft?.unloadPlaces ?? '',
    unloadDate: draft?.unloadDate ?? (start ? addDaysIso(start, 1) : ''),
    unloadTime: draft?.unloadTime ?? '',
    client: draft?.client ?? '',
    rev: draft?.rev !== null && draft?.rev !== undefined ? String(draft.rev).replace('.', ',') : '',
    cost: draft?.cost !== null && draft?.cost !== undefined ? String(draft.cost).replace('.', ',') : '',
  }))
  const [note, setNote] = useState('')
  const [places, setPlaces] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const listId = useId()

  useEffect(() => {
    boardApi
      .places()
      .then(list => setPlaces(list.map(p => p.name)))
      .catch(() => setPlaces([]))
  }, [])

  const set = <K extends keyof DraftForm>(key: K, value: DraftForm[K]) => setForm(f => ({ ...f, [key]: value }))

  const save = async () => {
    setSaving(true)
    const payload: DraftForm = {
      ...form,
      loadTime: form.loadTime?.trim() ? form.loadTime : null,
      unloadTime: form.unloadTime?.trim() ? form.unloadTime : null,
      rev: form.rev?.trim() ? form.rev : null,
      cost: form.cost?.trim() ? form.cost : null,
    }
    try {
      if (editing && orderNo) {
        await boardApi.updateDraft(orderNo, payload)
        onSaved(`Zapisano zmiany w zleceniu wstępnym ${orderNo}.`)
      } else {
        const no = await boardApi.createDraft({ ...payload, truckId: truck.id, ...(note.trim() ? { note: note.trim() } : {}) })
        onSaved(`Dodano zlecenie wstępne ${no} (${truck.plate}). Zastąpi je zlecenie z aplikacji przy imporcie.`)
      }
    } catch (e) {
      setError(errorMessage(e, 'Nie udało się zapisać zlecenia wstępnego.'))
      setSaving(false)
    }
  }

  const input = 'h-11 rounded-lg border border-[#C9CEC6] px-3 font-normal'
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="draft-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="max-h-[calc(100vh-32px)] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="draft-title" className="text-lg font-bold">
              {editing ? `Zlecenie wstępne ${orderNo}` : 'Zlecenie wstępne'} · {truck.plate}
            </h2>
            <p className="text-sm text-[#545B63]">
              {editing ? 'Czeka na zlecenie z aplikacji.' : `Załadunek ${start ? dm(start) : ''}. Zlecenie z aplikacji zastąpi je przy imporcie.`}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="flex h-11 w-11 flex-none items-center justify-center rounded-lg border border-[#D5D9D3]">
            <Icon name="close" size={18} />
          </button>
        </div>
        <datalist id={listId}>
          {places.map(p => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <div className="flex flex-col gap-3 text-sm">
          <fieldset className="grid grid-cols-[minmax(0,1fr)_150px_96px] gap-2">
            <legend className="mb-1 font-semibold">Załadunek</legend>
            <label className="flex flex-col gap-1 text-[13px]">
              Miejsce
              <input value={form.loadPlaces} onChange={e => set('loadPlaces', e.target.value)} list={listId} placeholder="np. Warszawa albo Gdańsk + Łódź" className={input} />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              Data
              <input type="date" value={form.loadDate} onChange={e => set('loadDate', e.target.value)} className={input} />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              Godzina
              <input type="time" value={form.loadTime ?? ''} onChange={e => set('loadTime', e.target.value)} className={`${input} px-2`} />
            </label>
          </fieldset>
          <fieldset className="grid grid-cols-[minmax(0,1fr)_150px_96px] gap-2">
            <legend className="mb-1 font-semibold">Rozładunek</legend>
            <label className="flex flex-col gap-1 text-[13px]">
              Miejsce
              <input value={form.unloadPlaces} onChange={e => set('unloadPlaces', e.target.value)} list={listId} placeholder="np. Wilno" className={input} />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              Data
              <input type="date" value={form.unloadDate} onChange={e => set('unloadDate', e.target.value)} className={input} />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              Godzina
              <input type="time" value={form.unloadTime ?? ''} onChange={e => set('unloadTime', e.target.value)} className={`${input} px-2`} />
            </label>
          </fieldset>
          <label className="flex flex-col gap-1 font-semibold">
            Klient
            <input value={form.client} onChange={e => set('client', e.target.value)} className={input} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 font-semibold">
              Stawka klienta (€)
              <input value={form.rev ?? ''} onChange={e => set('rev', e.target.value)} inputMode="decimal" placeholder="np. 2350" className={input} />
            </label>
            <label className="flex flex-col gap-1 font-semibold">
              Kwota dla przewoźnika (€)
              <input value={form.cost ?? ''} onChange={e => set('cost', e.target.value)} inputMode="decimal" placeholder="np. 1900" className={input} />
            </label>
          </div>
          <p className="text-xs text-[#545B63]">Bez którejś z kwot zlecenie wstępne liczy się tylko w kilometrach, nie w sumach marży i przychodu.</p>
          {!editing && (
            <label className="flex flex-col gap-1 font-semibold">
              Notatka (opcjonalnie)
              <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} className="resize-y rounded-lg border border-[#C9CEC6] px-3 py-2 font-normal" />
            </label>
          )}
          {error && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-800">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="h-11 rounded-lg border border-[#C9CEC6] px-4 font-semibold">
              Anuluj
            </button>
            <button type="button" disabled={saving} onClick={() => void save()} className="h-11 rounded-lg bg-[#1E4E9C] px-4 font-semibold text-white disabled:opacity-60">
              {editing ? 'Zapisz zmiany' : 'Dodaj zlecenie wstępne'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
