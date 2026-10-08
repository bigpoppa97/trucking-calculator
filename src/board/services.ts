import type { ServiceStatus, ServiceTarget } from '../db/schema.js'
import { addDays } from './normalize.js'

/**
 * Serwis — pure helpers (validation, derived phase, labels).
 *
 * A planned service has a start and an end: all day(s) (dates only) or wall
 * times in Poland ("HH:MM"). "Done" is not stored — it follows from the end time.
 */

export type ServicePhase = 'required' | 'upcoming' | 'ongoing' | 'done' | 'cancelled'

export interface ServiceWhen {
  allDay: boolean
  startDay: string
  startTime: string | null
  endDay: string
  endTime: string | null
}

export interface ServiceRecord {
  id: number
  truck_id: number | null
  target: ServiceTarget
  trailer_plate: string | null
  status: ServiceStatus
  all_day: number
  start_day: string | null
  start_time: string | null
  end_day: string | null
  end_time: string | null
  description: string
  place: string
  reported_at: string
  created_by: string
  created_at: string
  updated_by: string
  updated_at: string
}

export interface ServiceDto {
  id: number
  truckId: number | null
  target: ServiceTarget
  trailerPlate: string | null
  status: 'required' | 'planned' | 'cancelled'
  phase: ServicePhase
  allDay: boolean
  startDay: string | null
  startTime: string | null
  endDay: string | null
  endTime: string | null
  /** Human label of the period, e.g. "14.10 08:00–10:00"; '' while required. */
  when: string
  description: string
  place: string
  reportedAt: string
  createdBy: string
  updatedBy: string
  updatedAt: string
  history: Array<{ at: string; by: string; text: string }>
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** Longest period accepted — catches a wrong year or month typed by mistake. */
export const MAX_SERVICE_DAYS = 60

export function whenOf(r: Pick<ServiceRecord, 'all_day' | 'start_day' | 'start_time' | 'end_day' | 'end_time'>): ServiceWhen | null {
  if (!r.start_day || !r.end_day) return null
  return { allDay: r.all_day === 1, startDay: r.start_day, startTime: r.start_time, endDay: r.end_day, endTime: r.end_time }
}

/** A real calendar day "YYYY-MM-DD" (not 2026-02-30). */
export function isRealDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false
  const d = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day
}

/** Error message in Polish, or null when the period is valid. */
export function validateWhen(w: ServiceWhen): string | null {
  if (!isRealDay(w.startDay) || !isRealDay(w.endDay)) return 'Podaj daty serwisu.'
  if (!w.allDay) {
    if (!w.startTime || !TIME_RE.test(w.startTime) || !w.endTime || !TIME_RE.test(w.endTime)) {
      return 'Podaj godziny serwisu (GG:MM) albo zaznacz „Cały dzień”.'
    }
    if (`${w.endDay}T${w.endTime}` <= `${w.startDay}T${w.startTime}`) return 'Koniec serwisu musi być po początku.'
  } else if (w.endDay < w.startDay) {
    return 'Ostatni dzień serwisu nie może być przed pierwszym.'
  }
  if (addDays(w.startDay, MAX_SERVICE_DAYS) < w.endDay) return `Serwis dłuższy niż ${MAX_SERVICE_DAYS} dni — sprawdź daty.`
  return null
}

/** "YYYY-MM-DDTHH:MM" of the start / the (exclusive) end. */
export function startOf(w: ServiceWhen): string {
  return `${w.startDay}T${w.allDay ? '00:00' : (w.startTime ?? '00:00')}`
}

export function endOf(w: ServiceWhen): string {
  return w.allDay ? `${addDays(w.endDay, 1)}T00:00` : `${w.endDay}T${w.endTime ?? '24:00'}`
}

export function phaseOf(r: Pick<ServiceRecord, 'status' | 'all_day' | 'start_day' | 'start_time' | 'end_day' | 'end_time'>, nowLocal: string): ServicePhase {
  if (r.status === 'required') return 'required'
  if (r.status === 'cancelled' || r.status === 'deleted') return 'cancelled'
  const w = whenOf(r)
  if (!w) return 'required'
  if (nowLocal < startOf(w)) return 'upcoming'
  if (nowLocal < endOf(w)) return 'ongoing'
  return 'done'
}

/** Days the vehicle is in service from midnight to midnight (the only days that conflict with orders). */
export function fullyCoveredDays(w: ServiceWhen): string[] {
  const days: string[] = []
  for (let d = w.startDay; d <= w.endDay; d = addDays(d, 1)) {
    if (w.allDay) {
      days.push(d)
      continue
    }
    const fromMidnight = d > w.startDay || (w.startTime ?? '00:00') === '00:00'
    const toMidnight = d < w.endDay || (w.endTime ?? '') >= '23:59'
    if (fromMidnight && toMidnight) days.push(d)
  }
  return days
}

export function dm(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`
}

/** "14.10, cały dzień" · "14.10–16.10, całe dni" · "14.10 08:00–10:00" · "14.10 14:00 → 15.10 10:00" */
export function whenLabel(w: ServiceWhen | null): string {
  if (!w) return ''
  if (w.allDay) return w.startDay === w.endDay ? `${dm(w.startDay)}, cały dzień` : `${dm(w.startDay)}–${dm(w.endDay)}, całe dni`
  if (w.startDay === w.endDay) return `${dm(w.startDay)} ${w.startTime}–${w.endTime}`
  return `${dm(w.startDay)} ${w.startTime} → ${dm(w.endDay)} ${w.endTime}`
}

export function targetLabel(target: ServiceTarget, trailerPlate: string | null): string {
  return target === 'trailer' ? `naczepa ${trailerPlate ?? '?'}` : 'ciągnik'
}

/** Wall-clock time in Poland for an ISO instant ("YYYY-MM-DDTHH:MM"). Service times are entered in Polish time. */
export function warsawNow(iso: string): string {
  try {
    const s = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Warsaw',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso))
    return s.replace(' ', 'T')
  } catch {
    return iso.slice(0, 16)
  }
}

export function toServiceDto(r: ServiceRecord, nowLocal: string, history: ServiceDto['history']): ServiceDto {
  return {
    id: r.id,
    truckId: r.truck_id,
    target: r.target,
    trailerPlate: r.trailer_plate,
    status: r.status === 'deleted' ? 'cancelled' : r.status,
    phase: phaseOf(r, nowLocal),
    allDay: r.all_day === 1,
    startDay: r.start_day,
    startTime: r.start_time,
    endDay: r.end_day,
    endTime: r.end_time,
    when: r.status === 'required' ? '' : whenLabel(whenOf(r)),
    description: r.description,
    place: r.place,
    reportedAt: r.reported_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    history,
  }
}
