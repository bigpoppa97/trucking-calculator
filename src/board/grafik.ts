import ExcelJS from 'exceljs'
import { cellText, normalizePlate, parseAmount, toIsoDate } from './normalize.js'

/**
 * Reader for the legacy Excel planner ("Grafik podwykonawców"): one sheet per
 * week, 5 columns per truck (text, revenue, km, subcontractor rate, profit),
 * two rows per day (rows 4–17), truck header in rows 1–3
 * ("PLATE (Driver)", phone, trailer).
 *
 * Used to seed the fleet registry and to compare the board with the planner
 * during the parallel run. Never imported into orders (free text).
 */

export interface GrafikEntry {
  date: string
  text: string
  rev: number | null
  km: number | null
  sub: number | null
}

export interface GrafikTruck {
  plate: string
  driver: string
  phone: string
  trailer: string
  entries: GrafikEntry[]
}

export interface GrafikWeek {
  sheet: string
  weekStart: string
  trucks: GrafikTruck[]
}

function asDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return toIsoDate(value)
  return null
}

export async function readGrafik(path: string): Promise<GrafikWeek[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  const weeks: GrafikWeek[] = []
  for (const ws of wb.worksheets) {
    // Monday's date sits in column A, row 5 (row 4 holds the day name).
    let weekStart: string | null = null
    for (let r = 4; r <= 17 && !weekStart; r++) {
      const d = asDate(ws.getCell(r, 1).value)
      if (d) {
        const dayIndex = Math.floor((r - 4) / 2)
        const date = new Date(`${d}T00:00:00Z`)
        date.setUTCDate(date.getUTCDate() - dayIndex)
        weekStart = toIsoDate(date)
      }
    }
    if (!weekStart) continue
    const trucks: GrafikTruck[] = []
    for (let c = 2; c <= ws.columnCount; c += 5) {
      const header = cellText(ws.getCell(1, c).value)
      if (!header || /rentown/i.test(header)) continue
      const m = /^(.*?)\s*\((.*?)\)/.exec(header)
      const plate = normalizePlate(m ? m[1] : header)
      if (!plate) continue
      const entries: GrafikEntry[] = []
      for (let r = 4; r <= 17; r++) {
        const text = cellText(ws.getCell(r, c).value)
        const rev = parseAmount(ws.getCell(r, c + 1).value)
        const km = parseAmount(ws.getCell(r, c + 2).value)
        const sub = parseAmount(ws.getCell(r, c + 3).value)
        if (!text && rev === null && km === null && sub === null) continue
        const date = new Date(`${weekStart}T00:00:00Z`)
        date.setUTCDate(date.getUTCDate() + Math.floor((r - 4) / 2))
        entries.push({ date: toIsoDate(date), text, rev, km, sub })
      }
      trucks.push({
        plate,
        driver: m ? (m[2] ?? '').trim() : '',
        phone: cellText(ws.getCell(2, c).value),
        trailer: normalizePlate(ws.getCell(3, c).value),
        entries,
      })
    }
    weeks.push({ sheet: ws.name, weekStart, trucks })
  }
  // Sheet order in the workbook is not reliable; sort by date.
  return weeks.sort((a, b) => a.weekStart.localeCompare(b.weekStart))
}

/** Per-truck weekly totals as the planner computes them (revenue, km, subcontractor, profit). */
export function grafikWeekTotals(week: GrafikWeek) {
  return week.trucks.map(t => {
    const withRev = t.entries.filter(e => e.rev !== null && e.rev > 0)
    const rev = withRev.reduce((s, e) => s + (e.rev ?? 0), 0)
    const sub = withRev.reduce((s, e) => s + (e.sub ?? 0), 0)
    const km = t.entries.reduce((s, e) => s + (e.km ?? 0), 0)
    return { plate: t.plate, rev, sub, margin: rev - sub, km, entries: withRev.length }
  })
}
