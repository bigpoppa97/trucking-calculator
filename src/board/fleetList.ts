import type { BoardContext } from './context.js'
import { addDays, foldDiacritics, normalizePlate } from './normalize.js'

/**
 * "Stan floty" pasted as plain text — the way the department lists it:
 *
 *   Mozdyniewicz:
 *   Ciągniki: KN6635G, KN1050H, KN4814J
 *   Naczepy: KNS759RR, KNS463RP, KNS897RP
 *
 *   Karol Czerpak:
 *   Ciągnik: KN7179F
 *   Naczepa: KN560PP
 *
 * The list is the whole current fleet: trailers belong to the carrier of the
 * block; a carrier with one tractor and one trailer gets it as the tractor's
 * fixed trailer, carriers with several sets rotate them (no fixed trailer);
 * trailers missing from the list leave the fleet (history stays as it was).
 * Tractors are only reported, never created or hidden automatically — a
 * missing or unknown tractor is usually a plate change the user resolves
 * with the existing actions.
 */

export interface FleetBlock {
  name: string
  tractors: string[]
  trailers: string[]
}

export function parseFleetList(text: string): { blocks: FleetBlock[]; errors: string[] } {
  const blocks: FleetBlock[] = []
  const errors: string[] = []
  let current: FleetBlock | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const folded = foldDiacritics(line).toLowerCase()
    const isTractors = folded.startsWith('ciagnik')
    const isTrailers = folded.startsWith('naczep')
    if (isTractors || isTrailers) {
      if (!current) {
        errors.push(`Linia „${line}” jest przed nazwą przewoźnika.`)
        continue
      }
      const colon = line.indexOf(':')
      const value = colon >= 0 ? line.slice(colon + 1) : line.replace(/^\S+/, '')
      const plates = value
        .split(/[,;]+/)
        .map(p => normalizePlate(p))
        .filter(Boolean)
      if (isTractors) current.tractors.push(...plates)
      else current.trailers.push(...plates)
      continue
    }
    current = { name: line.replace(/:\s*$/, '').trim(), tractors: [], trailers: [] }
    blocks.push(current)
  }
  for (const b of blocks) {
    if (b.tractors.length === 0) errors.push(`Przewoźnik „${b.name}” nie ma linii „Ciągniki: …”.`)
  }
  if (blocks.length === 0 && errors.length === 0) errors.push('Wklej listę: nazwa przewoźnika, potem linie „Ciągniki: …” i „Naczepy: …”.')
  return { blocks, errors }
}

export type FleetOperation =
  | { op: 'truck-fixed-trailer'; truckId: number; trailer: string | null }
  | { op: 'truck-activate'; truckId: number }
  | { op: 'trailer-add'; plate: string; carrier: string }
  | { op: 'trailer-carrier'; plate: string; carrier: string }
  | { op: 'trailer-reactivate'; plate: string }
  | { op: 'trailer-retire'; plate: string; activeTo: string }

export interface FleetPlan {
  operations: FleetOperation[]
  changes: string[]
  warnings: string[]
  errors: string[]
}

const fmt = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`

export function planFleetSync(text: string, ctx: BoardContext, today: string): FleetPlan {
  const { blocks, errors } = parseFleetList(text)
  const plan: FleetPlan = { operations: [], changes: [], warnings: [], errors }
  if (errors.length > 0) return plan

  const listedTrailers = new Set<string>()
  const listedTrucks = new Set<number>()
  const seenTractors = new Map<string, string>()
  const seenTrailers = new Map<string, string>()

  for (const block of blocks) {
    for (const p of block.tractors) {
      const other = seenTractors.get(p)
      if (other) plan.errors.push(`Ciągnik ${p} jest na liście dwa razy („${other}” i „${block.name}”).`)
      seenTractors.set(p, block.name)
    }
    for (const p of block.trailers) {
      const other = seenTrailers.get(p)
      if (other) plan.errors.push(`Naczepa ${p} jest na liście dwa razy („${other}” i „${block.name}”).`)
      seenTrailers.set(p, block.name)
    }
  }
  if (plan.errors.length > 0) return plan

  for (const block of blocks) {
    const trucks = block.tractors.flatMap(plate => {
      const truck = ctx.fleet.truckFor(plate, today) ?? ctx.fleet.trucks.find(t => t.plates.some(tp => tp.plate === plate)) ?? null
      if (!truck) {
        plan.warnings.push(
          `Ciągnika ${plate} („${block.name}”) nie ma w bazie. Jeśli to nowe tablice istniejącego auta — Ciągniki → „Nowy numer”; jeśli nowe auto — „Dodaj ciągnik do działu”.`,
        )
        return []
      }
      return [{ plate, truck }]
    })
    const carriers = [...new Set(trucks.map(t => t.truck.carrier).filter(Boolean))]
    if (carriers.length > 1) {
      plan.warnings.push(`Ciągniki z bloku „${block.name}” mają w bazie różnych przewoźników: ${carriers.join(', ')}. Naczepy przypisuję do: ${carriers[0]}.`)
    }
    const carrier = carriers[0] ?? block.name

    for (const { plate, truck } of trucks) {
      listedTrucks.add(truck.id)
      if (!truck.active) {
        plan.operations.push({ op: 'truck-activate', truckId: truck.id })
        plan.changes.push(`${plate}: wraca na tablicę.`)
      }
    }

    for (const plate of block.trailers) {
      listedTrailers.add(plate)
      const rec = ctx.trailers.get(plate)
      if (!rec) {
        plan.operations.push({ op: 'trailer-add', plate, carrier })
        plan.changes.push(`${plate}: nowa naczepa (${carrier}).`)
        continue
      }
      if (rec.carrier !== carrier) {
        plan.operations.push({ op: 'trailer-carrier', plate, carrier })
        plan.changes.push(`${plate}: przewoźnik ${rec.carrier ? `${rec.carrier} → ` : ''}${carrier}.`)
      }
      if (rec.activeTo !== null) {
        plan.operations.push({ op: 'trailer-reactivate', plate })
        plan.changes.push(`${plate}: wraca do floty.`)
      }
    }

    // One set = fixed trailer; several sets = trailers rotate (the board shows the trailer of the latest order).
    const single = block.tractors.length === 1 && block.trailers.length === 1
    for (const { plate, truck } of trucks) {
      const fixed = single ? (block.trailers[0] ?? null) : null
      if (truck.trailerPlate !== fixed) {
        plan.operations.push({ op: 'truck-fixed-trailer', truckId: truck.id, trailer: fixed })
        plan.changes.push(
          fixed
            ? `${plate}: stała naczepa ${truck.trailerPlate ? `${truck.trailerPlate} → ` : ''}${fixed}.`
            : `${plate}: bez stałej naczepy (było ${truck.trailerPlate}) — naczepy przewoźnika rotują, tablica pokaże naczepę z ostatniego zlecenia.`,
        )
      }
    }
  }

  const activeTo = addDays(today, -1)
  for (const rec of ctx.trailers.all().sort((a, b) => a.plate.localeCompare(b.plate))) {
    if (listedTrailers.has(rec.plate) || rec.activeTo !== null) continue
    plan.operations.push({ op: 'trailer-retire', plate: rec.plate, activeTo })
    plan.changes.push(`${rec.plate}: wycofana z floty (ostatni dzień ${fmt(activeTo)}).`)
  }

  for (const truck of ctx.fleet.trucks) {
    if (!truck.active || listedTrucks.has(truck.id)) continue
    plan.warnings.push(
      `${ctx.fleet.plateOn(truck, today)} (${truck.carrier || 'bez przewoźnika'}) jest na tablicy, ale nie ma go na liście. Jeśli wypadł z działu: Ciągniki → Edytuj → odznacz „na tablicy”.`,
    )
  }
  return plan
}
