/**
 * Kierowcy — who drives which tractor on a day, and the driver of an order
 * (decisions of 08.10.2026):
 *  - the driver on a day = the latest change on or before that day;
 *  - an order: the driver on the loading day, plus every change strictly
 *    between loading and unloading ("A → B (zmiana 11.10)");
 *    a change on the unloading day belongs to the next order;
 *  - a manual correction in the order panel wins.
 */

export const FROM_THE_BEGINNING = '2000-01-01'

export interface DriverRecord {
  id: number
  name: string
  phone: string
  carrier: string
  notes: string
  active: boolean
}

export interface DriverChange {
  id: number
  truckId: number
  driverId: number | null
  day: string
  createdBy: string
  createdAt: string
}

export interface LegDrivers {
  /** Driver(s) in order of driving; a null driver = nobody assigned. */
  drivers: Array<{ id: number | null; name: string; from: string }>
  /** "A → B (zmiana 11.10)" or "A" or "—". */
  text: string
  manual: boolean
}

export class DriverIndex {
  readonly byId = new Map<number, DriverRecord>()
  private readonly changesByTruck = new Map<number, DriverChange[]>()

  constructor(drivers: DriverRecord[], changes: DriverChange[]) {
    for (const d of drivers) this.byId.set(d.id, d)
    for (const c of [...changes].sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id)) {
      const list = this.changesByTruck.get(c.truckId) ?? []
      list.push(c)
      this.changesByTruck.set(c.truckId, list)
    }
  }

  all(): DriverRecord[] {
    return [...this.byId.values()]
  }

  changesOf(truckId: number): DriverChange[] {
    return this.changesByTruck.get(truckId) ?? []
  }

  /** The change in force on that day (null = no change recorded yet). */
  changeOn(truckId: number, day: string): DriverChange | null {
    let found: DriverChange | null = null
    for (const c of this.changesOf(truckId)) {
      if (c.day <= day) found = c
      else break
    }
    return found
  }

  driverOn(truckId: number, day: string): DriverRecord | null {
    const c = this.changeOn(truckId, day)
    return c?.driverId ? (this.byId.get(c.driverId) ?? null) : null
  }

  /** Tractors the driver is on that day (normally one). */
  trucksOf(driverId: number, day: string, truckIds: number[]): number[] {
    return truckIds.filter(t => this.changeOn(t, day)?.driverId === driverId)
  }

  name(id: number | null): string {
    if (id === null) return 'bez kierowcy'
    return this.byId.get(id)?.name ?? '?'
  }

  /** Driver(s) of a leg from loading to unloading, or the manual correction (driver id). */
  legDrivers(truckId: number, startDate: string, endDate: string, manualDriverId?: number | null): LegDrivers {
    if (manualDriverId !== undefined && manualDriverId !== null) {
      const name = this.name(manualDriverId)
      return { drivers: [{ id: manualDriverId, name, from: startDate }], text: name, manual: true }
    }
    const first = this.changeOn(truckId, startDate)
    const drivers: LegDrivers['drivers'] = []
    if (first) drivers.push({ id: first.driverId, name: this.name(first.driverId), from: startDate })
    for (const c of this.changesOf(truckId)) {
      if (c.day > startDate && c.day < endDate) drivers.push({ id: c.driverId, name: this.name(c.driverId), from: c.day })
    }
    const names = drivers.filter((d, i) => i === 0 || d.id !== drivers[i - 1]!.id)
    if (names.length === 0) return { drivers: [], text: '—', manual: false }
    if (names.length === 1) return { drivers: names, text: names[0]!.name, manual: false }
    const swaps = names.slice(1).map(d => `${d.from.slice(8, 10)}.${d.from.slice(5, 7)}`)
    return { drivers: names, text: `${names.map(d => d.name).join(' → ')} (zmiana ${swaps.join(', ')})`, manual: false }
  }
}

// ---------------------------------------------------------------- certificates

export type CertStatus = 'ok' | 'expiring' | 'expired' | 'none'

/** Yellow from 30 days before the end of validity, red after it (08.10.2026). */
export const CERT_WARN_DAYS = 30

export function certStatus(validTo: string | null, today: string): { status: CertStatus; daysLeft: number | null } {
  if (!validTo) return { status: 'none', daysLeft: null }
  const daysLeft = Math.round((Date.parse(`${validTo}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)
  if (daysLeft < 0) return { status: 'expired', daysLeft }
  if (daysLeft <= CERT_WARN_DAYS) return { status: 'expiring', daysLeft }
  return { status: 'ok', daysLeft }
}

/** Cert kinds compared case-insensitively without spaces ("avsec", "AVSEC "). */
export function kindKey(kind: string): string {
  return kind.toUpperCase().replace(/\s+/g, ' ').trim()
}

export interface CertLike {
  kind: string
  validTo: string | null
}

/**
 * Warnings for the board: per kind only the newest certificate counts (a renewed
 * one supersedes the old), and only expiring or expired ones are reported.
 */
export function certWarnings(certs: CertLike[], today: string): Array<{ kind: string; validTo: string; status: 'expiring' | 'expired' }> {
  const newest = new Map<string, CertLike>()
  for (const c of certs) {
    const k = kindKey(c.kind)
    const prev = newest.get(k)
    if (!prev || (c.validTo ?? '9999') > (prev.validTo ?? '9999')) newest.set(k, c)
  }
  const out: Array<{ kind: string; validTo: string; status: 'expiring' | 'expired' }> = []
  for (const c of newest.values()) {
    if (!c.validTo) continue
    const { status } = certStatus(c.validTo, today)
    if (status === 'expiring' || status === 'expired') out.push({ kind: c.kind.trim(), validTo: c.validTo, status })
  }
  return out.sort((a, b) => a.validTo.localeCompare(b.validTo))
}

// ---------------------------------------------------------------- scans

export const CERT_FILE_MAX_BYTES = 15 * 1024 * 1024

/** Type of an uploaded scan by its first bytes (the name can lie). */
export function sniffScan(data: Uint8Array): { mime: string; ext: string } | null {
  const b = data
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return { mime: 'application/pdf', ext: 'pdf' }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { mime: 'image/png', ext: 'png' }
  }
  return null
}

/** A safe display/download name: no path parts or control characters, sensible length, right extension. */
export function cleanFilename(raw: string, ext: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '')
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 100).trim() || 'skan'
  return `${stem}.${ext}`
}
