import { cellText } from './normalize.js'

/**
 * Hours on the board (12.10.2026). The application exports loading and
 * unloading hours as a window "OD — DO" where a missing end is "—":
 *   "07:00 — 09:00", "— — 14:30" (until 14:30), "18:00 — —" (from 18:00), "— — —".
 * Loading takes the start of its window, unloading the end of its window
 * ("do 16:00"); a single hour is used as it is.
 *
 * Manual corrections of loading/unloading ("load_at" / "unload_at") are stored
 * as "YYYY-MM-DD HH:MM" or "YYYY-MM-DD" (no hour known).
 */

export interface HoursWindow {
  from: string | null
  to: string | null
}

export interface At {
  date: string
  time: string | null
}

/** "7:05" → "07:05"; anything else (or 24:00+) → null. */
export function normTime(raw: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((raw ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function timeOfValue(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}`
  }
  if (typeof value === 'number' && value >= 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60)
    return normTime(`${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`)
  }
  return null
}

/** Hours window from an export cell (see the format above). */
export function parseHoursWindow(value: unknown): HoursWindow {
  const direct = timeOfValue(value)
  if (direct) return { from: direct, to: direct }
  const text = cellText(value)
  if (!text) return { from: null, to: null }
  const parts = text.split(/\s+[—–-]\s+/)
  if (parts.length === 2) return { from: normTime(parts[0]), to: normTime(parts[1]) }
  const times = [...text.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map(m => normTime(m[1])).filter((t): t is string => t !== null)
  if (times.length >= 2) return { from: times[0]!, to: times[times.length - 1]! }
  if (times.length === 1) return { from: times[0]!, to: times[0]! }
  return { from: null, to: null }
}

/** Loading hour of a window: its start, else its only hour. */
export function loadHour(w: HoursWindow): string | null {
  return w.from ?? w.to
}

/** Unloading hour of a window: its end ("do 16:00"), else its only hour. */
export function unloadHour(w: HoursWindow): string | null {
  return w.to ?? w.from
}

export function formatAt(at: At): string {
  return at.time ? `${at.date} ${at.time}` : at.date
}

/** Stored "YYYY-MM-DD[ HH:MM]" → At; null when it is not that shape. */
export function parseAtValue(stored: string | null | undefined): At | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?$/.exec((stored ?? '').trim())
  if (!m) return null
  return { date: m[1]!, time: m[2] ? normTime(m[2]) : null }
}

/** "2026-10-07 12:00" → "07.10 12:00" */
export function displayAt(stored: string): string {
  const at = parseAtValue(stored)
  if (!at) return stored
  return `${at.date.slice(8, 10)}.${at.date.slice(5, 7)}${at.time ? ` ${at.time}` : ''}`
}

function realDay(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso
}

/** Year for a "DD.MM" typed without one: the one closest to the reference date. */
function closestYear(day: number, month: number, referenceIso: string): string | null {
  const refYear = Number(referenceIso.slice(0, 4))
  const ref = Date.parse(`${referenceIso}T00:00:00Z`)
  let best: string | null = null
  let bestDiff = Infinity
  for (const year of [refYear - 1, refYear, refYear + 1]) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    if (!realDay(iso)) continue
    const diff = Math.abs(Date.parse(`${iso}T00:00:00Z`) - ref)
    if (diff < bestDiff) {
      bestDiff = diff
      best = iso
    }
  }
  return best
}

/**
 * A manual loading/unloading entry typed in the order panel:
 * "07.10 12:00", "7.10.2026 12:00", "2026-10-07 12:00", "12:00" (keeps the date),
 * "07.10" (keeps the hour). Returns null when nothing readable was typed.
 */
export function parseAtInput(input: string, current: At): At | null {
  let text = input.trim()
  if (!text) return null
  let date: string | null = null
  let time: string | null = null

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text)
  if (iso) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`
    if (!realDay(candidate)) return null
    date = candidate
    text = text.replace(iso[0], ' ')
  }
  const timeMatch = /\b(\d{1,2}):(\d{2})\b/.exec(text)
  if (timeMatch) {
    time = normTime(`${timeMatch[1]}:${timeMatch[2]}`)
    if (!time) return null
    text = text.replace(timeMatch[0], ' ')
  }
  if (!date) {
    const dm = /\b(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\b/.exec(text)
    if (dm) {
      const day = Number(dm[1])
      const month = Number(dm[2])
      if (dm[3]) {
        const candidate = `${dm[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        if (!realDay(candidate)) return null
        date = candidate
      } else {
        date = closestYear(day, month, current.date)
        if (!date) return null
      }
      text = text.replace(dm[0], ' ')
    }
  }
  // Anything else left over (letters, stray numbers) means we did not understand the entry.
  if (text.replace(/[\s,;]+/g, '') !== '') return null
  if (!date && !time) return null
  return { date: date ?? current.date, time: time ?? current.time }
}

/** Sort key of a moment; a missing hour counts as the start (fallback "00:00") or end ("23:59") of the day. */
export function atKey(at: At, missing: '00:00' | '23:59'): string {
  return `${at.date} ${at.time ?? missing}`
}
