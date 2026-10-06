import ExcelJS from 'exceljs'
import { aliasKey, cellText, normalizePlate, parseAmount, parseDate } from './normalize.js'

/**
 * Reads the order-list export from the company application (an AG Grid
 * "Export to Excel" file). Columns are matched by header NAME, never by
 * position: the grid's column order and visibility change when someone
 * tweaks the view. A missing required column is a loud error.
 *
 * NOTE the application's column naming is the reverse of ours:
 *   "Fracht zakup"    = the client's rate  → our revenue
 *   "Fracht sprzedaż" = the carrier's rate → our cost
 */

export interface ExportRow {
  orderNo: string
  statusClient: string
  client: string
  loadCountry: string
  loadPlaces: string
  loadDate: string
  unloadCountry: string
  unloadPlaces: string
  unloadDate: string
  carrier: string
  statusSped: string
  ownPlate: string
  clientRef: string
  /** "Fracht zakup" — client rate (revenue). */
  revEur: number | null
  /** "Fracht sprzedaż" — carrier rate (cost). */
  costEur: number | null
  notes: string
  subPlate: string
  trailerRaw: string
}

type Field = keyof ExportRow

interface ColumnSpec {
  field: Field
  headers: string[] // alias keys (folded, lower case)
  required: boolean
  label: string // as shown in the application, for error messages
}

const COLUMNS: ColumnSpec[] = [
  { field: 'orderNo', headers: ['numer zlecenia'], required: true, label: 'Numer zlecenia' },
  { field: 'statusClient', headers: ['status zlecenia od klienta'], required: false, label: 'Status zlecenia od klienta' },
  { field: 'client', headers: ['zleceniodawca'], required: true, label: 'Zleceniodawca' },
  { field: 'loadCountry', headers: ['kraj zaladunku'], required: false, label: 'Kraj załadunku' },
  { field: 'loadPlaces', headers: ['miejsce zaladunku'], required: true, label: 'Miejsce załadunku' },
  { field: 'loadDate', headers: ['data zaladunku'], required: true, label: 'Data załadunku' },
  { field: 'unloadCountry', headers: ['kraj dostawy', 'kraj rozladunku'], required: false, label: 'Kraj dostawy' },
  { field: 'unloadPlaces', headers: ['miejsce dostawy', 'miejsce rozladunku'], required: true, label: 'Miejsce dostawy' },
  { field: 'unloadDate', headers: ['data rozladunku', 'data dostawy'], required: true, label: 'Data rozładunku' },
  { field: 'carrier', headers: ['zleceniobiorca'], required: true, label: 'Zleceniobiorca' },
  { field: 'statusSped', headers: ['status zl spedycyjnego', 'status zlecenia spedycyjnego'], required: false, label: 'Status zl spedycyjnego' },
  { field: 'ownPlate', headers: ['ciagnik'], required: false, label: 'Ciągnik' },
  { field: 'clientRef', headers: ['numer obcy'], required: false, label: 'Numer Obcy' },
  { field: 'revEur', headers: ['fracht zakup'], required: true, label: 'Fracht zakup' },
  { field: 'costEur', headers: ['fracht sprzedaz'], required: true, label: 'Fracht sprzedaż' },
  { field: 'notes', headers: ['uwagi'], required: true, label: 'Uwagi' },
  { field: 'subPlate', headers: ['ciagnik podwykonawcy'], required: true, label: 'Ciągnik podwykonawcy' },
  { field: 'trailerRaw', headers: ['naczepa podwykonawcy'], required: false, label: 'Naczepa podwykonawcy' },
]

export class ExportFormatError extends Error {
  constructor(
    message: string,
    readonly missingColumns: string[] = [],
  ) {
    super(message)
    this.name = 'ExportFormatError'
  }
}

export interface ExportReadResult {
  rows: ExportRow[]
  warnings: string[]
}

export async function readExport(data: ArrayBuffer | Uint8Array): Promise<ExportReadResult> {
  const workbook = new ExcelJS.Workbook()
  try {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  } catch {
    throw new ExportFormatError('Nie udało się otworzyć pliku. Wgraj eksport z aplikacji w formacie .xlsx.')
  }
  const sheet = workbook.worksheets[0]
  if (!sheet || sheet.rowCount < 1) throw new ExportFormatError('Plik nie zawiera arkusza z danymi.')

  // Header row → column index per field.
  const headerRow = sheet.getRow(1)
  const columnOf = new Map<Field, number>()
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const key = aliasKey(cell.value)
    const spec = COLUMNS.find(c => c.headers.includes(key))
    if (spec && !columnOf.has(spec.field)) columnOf.set(spec.field, colNumber)
  })

  const missingRequired = COLUMNS.filter(c => c.required && !columnOf.has(c.field)).map(c => c.label)
  if (missingRequired.length > 0) {
    throw new ExportFormatError(
      `W eksporcie brakuje kolumn: ${missingRequired.join(', ')}. Dodaj je w zapisanym widoku w aplikacji i wyeksportuj ponownie.`,
      missingRequired,
    )
  }
  const warnings: string[] = []
  const missingOptional = COLUMNS.filter(c => !c.required && !columnOf.has(c.field)).map(c => c.label)
  if (missingOptional.length > 0) {
    warnings.push(`Brak kolumn (opcjonalnych): ${missingOptional.join(', ')}.`)
  }

  const rows: ExportRow[] = []
  let skippedNoDate = 0
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r)
    const get = (field: Field): unknown => {
      const col = columnOf.get(field)
      return col === undefined ? undefined : row.getCell(col).value
    }
    const orderNo = cellText(get('orderNo'))
    if (!orderNo) continue
    const loadDate = parseDate(get('loadDate'))
    const unloadDate = parseDate(get('unloadDate')) ?? loadDate
    if (!loadDate || !unloadDate) {
      skippedNoDate++
      continue
    }
    rows.push({
      orderNo,
      statusClient: cellText(get('statusClient')).toUpperCase(),
      client: cellText(get('client')),
      loadCountry: cellText(get('loadCountry')),
      loadPlaces: cellText(get('loadPlaces')),
      loadDate,
      unloadCountry: cellText(get('unloadCountry')),
      unloadPlaces: cellText(get('unloadPlaces')),
      unloadDate: unloadDate < loadDate ? loadDate : unloadDate,
      carrier: cellText(get('carrier')),
      statusSped: cellText(get('statusSped')).toUpperCase(),
      ownPlate: normalizePlate(get('ownPlate')),
      clientRef: cellText(get('clientRef')),
      revEur: parseAmount(get('revEur')),
      costEur: parseAmount(get('costEur')),
      notes: cellText(get('notes')),
      subPlate: normalizePlate(get('subPlate')),
      trailerRaw: cellText(get('trailerRaw')),
    })
  }
  if (skippedNoDate > 0) warnings.push(`Pominięto ${skippedNoDate} wierszy bez daty załadunku.`)
  return { rows, warnings }
}
