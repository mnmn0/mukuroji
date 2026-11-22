import { childElement, childElements, escapeXml, parseXmlDocument, textContent, type XmlElement } from './xmlDocument'
import { createZipArchive, readZipArchive } from './zipArchive'

/** Value of one spreadsheet cell; a date cell is read as `YYYY-MM-DD` text. */
export type SpreadsheetCell = string | number | boolean | null

/** Rows of one worksheet, in sheet order. */
export type SpreadsheetSheet = {
  /** Sheet name. */
  name: string
  /** Cell values by row and column; missing cells are null. */
  rows: SpreadsheetCell[][]
}

/** Worksheet to write, with typed columns. */
export type SpreadsheetSheetInput = {
  /** Sheet name, at most 31 characters. */
  name: string
  /** Header row. */
  columns: string[]
  /** Columns whose `YYYY-MM-DD` text is written as a date cell. */
  dateColumns?: ReadonlySet<string>
  /** Data rows, one value per column. */
  rows: SpreadsheetCell[][]
}

/** Table found in a workbook: its sheet, header row, and data rows as objects. */
export type SpreadsheetTable = {
  /** Sheet the table was read from. */
  sheetName: string
  /** One-based row number of the header in the sheet. */
  headerRow: number
  /** Header names in column order. */
  headers: string[]
  /** Data rows keyed by header; empty rows are left out. */
  rows: Array<Record<string, SpreadsheetCell>>
}

/** Error for a workbook that cannot be read as a Work Item table. */
export class SpreadsheetError extends Error {
  /**
   * Creates the error.
   *
   * @param message - Explanation for the person importing.
   */
  constructor(message: string) {
    super(message)
    this.name = 'SpreadsheetError'
  }
}

/** Largest workbook accepted for import, in bytes. */
export const SPREADSHEET_IMPORT_MAX_BYTES = 10 * 1024 * 1024

const readLimits = { maxEntries: 2_000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 }

/** Rows searched for the header row. */
const headerSearchRows = 20

/** Most cells read from one sheet. */
const maxCells = 2_000_000

/** Built-in number formats that show a date or time. */
const builtInDateFormats = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57])

/**
 * Reads every worksheet of an `.xlsx` workbook.
 *
 * Shared, inline, and formula string results are read as text, booleans as booleans, and numbers
 * whose cell format shows a date as `YYYY-MM-DD` text.
 *
 * @param bytes - Workbook file bytes.
 * @returns Worksheets in workbook order.
 * @throws SpreadsheetError when the file is not a readable workbook.
 */
export async function readSpreadsheetWorkbook(bytes: Uint8Array): Promise<SpreadsheetSheet[]> {
  if (bytes.byteLength > SPREADSHEET_IMPORT_MAX_BYTES) throw new SpreadsheetError('The workbook is too large to import.')
  let files: Map<string, Uint8Array>
  try {
    files = await readZipArchive(bytes, readLimits, (name) => name.startsWith('xl/') && name.endsWith('.xml') || name.endsWith('.rels'))
  } catch {
    throw new SpreadsheetError('The file is not an Excel workbook (.xlsx).')
  }
  const decoder = new TextDecoder()
  /** Parses one XML part of the workbook. */
  const readPart = (path: string) => {
    const data = files.get(path)
    if (!data) return undefined
    try {
      return parseXmlDocument(decoder.decode(data))
    } catch {
      throw new SpreadsheetError('The workbook contains XML that cannot be read.')
    }
  }
  const workbook = readPart('xl/workbook.xml')
  if (!workbook) throw new SpreadsheetError('The file is not an Excel workbook (.xlsx).')
  const date1904 = childElement(workbook, 'workbookPr')?.attributes.date1904
  const uses1904 = date1904 === '1' || date1904 === 'true'
  const relationships = new Map(childElements(readPart('xl/_rels/workbook.xml.rels') ?? emptyElement(), 'Relationship')
    .map((relationship) => [relationship.attributes.Id ?? '', relationship.attributes.Target ?? '']))
  const sharedStrings = childElements(readPart('xl/sharedStrings.xml') ?? emptyElement(), 'si').map(readStringItem)
  const dateStyles = readDateStyles(readPart('xl/styles.xml'))
  const sheets: SpreadsheetSheet[] = []
  for (const sheet of childElements(childElement(workbook, 'sheets') ?? emptyElement(), 'sheet')) {
    const target = relationships.get(sheet.attributes.id ?? '')
    if (!target) continue
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//u, '')}`
    const worksheet = readPart(path)
    if (!worksheet) continue
    sheets.push({
      name: sheet.attributes.name ?? '',
      rows: readWorksheetRows(worksheet, sharedStrings, dateStyles, uses1904),
    })
  }
  return sheets
}

/**
 * Finds the Work Item table in a workbook.
 *
 * The first sheet with a header row is used. The header row is the first of the first 20 rows
 * whose filled cells are all distinct text and that has at least two of them, so a title or a
 * note above the table is skipped.
 *
 * @param sheets - Worksheets in workbook order.
 * @returns The table.
 * @throws SpreadsheetError when no sheet has a header row.
 */
export function findSpreadsheetTable(sheets: readonly SpreadsheetSheet[]): SpreadsheetTable {
  for (const sheet of sheets) {
    const headerIndex = sheet.rows.slice(0, headerSearchRows).findIndex(isHeaderRow)
    if (headerIndex < 0) continue
    const headerCells = sheet.rows[headerIndex]!
    const columns = headerCells.flatMap((cell, column) =>
      typeof cell === 'string' && cell.trim() ? [{ column, header: cell.trim() }] : [])
    const rows = sheet.rows.slice(headerIndex + 1).flatMap((cells) => {
      if (!cells.some((cell) => cell !== null && cell !== '')) return []
      return [Object.fromEntries(columns.map(({ column, header }) => [header, cells[column] ?? null]))]
    })
    return { sheetName: sheet.name, headerRow: headerIndex + 1, headers: columns.map(({ header }) => header), rows }
  }
  throw new SpreadsheetError('No sheet has a header row.')
}

/**
 * Builds an `.xlsx` workbook.
 *
 * Text is written as inline strings, so nothing is read as a formula, and the date columns are
 * written as date cells.
 *
 * @param sheets - Worksheets in order.
 * @param modifiedAt - Modification time written for the workbook's entries.
 * @returns Workbook file bytes.
 */
export function createSpreadsheetWorkbook(sheets: readonly SpreadsheetSheetInput[], modifiedAt = new Date()): Uint8Array {
  const encoder = new TextEncoder()
  const names = sheets.map((sheet, index) => sanitizeSheetName(sheet.name, index))
  const files = [
    {
      name: '[Content_Types].xml',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>',
    },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, xml: createWorksheetXml(sheet) })),
  ]
  return createZipArchive(files.map((file) => ({ name: file.name, data: encoder.encode(file.xml) })), modifiedAt)
}

/**
 * Builds the XML of one worksheet with a frozen, bold header row.
 *
 * @param sheet - Worksheet to write.
 * @returns Worksheet XML.
 */
function createWorksheetXml(sheet: SpreadsheetSheetInput) {
  const dateColumns = new Set(sheet.columns.flatMap((column, index) => sheet.dateColumns?.has(column) ? [index] : []))
  const header = `<row r="1">${sheet.columns.map((column, index) => createCell(index, 1, column, false, 2)).join('')}</row>`
  const body = sheet.rows.map((cells, rowIndex) =>
    `<row r="${rowIndex + 2}">${cells.map((cell, column) => createCell(column, rowIndex + 2, cell, dateColumns.has(column))).join('')}</row>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${header}${body}</sheetData></worksheet>`
}

/**
 * Builds the XML of one cell.
 *
 * @param column - Zero-based column.
 * @param row - One-based row.
 * @param value - Cell value.
 * @param isDateColumn - Whether `YYYY-MM-DD` text becomes a date cell.
 * @param style - Cell style index.
 * @returns Cell XML, empty for a missing value.
 */
function createCell(column: number, row: number, value: SpreadsheetCell, isDateColumn: boolean, style = 0) {
  const reference = `${columnName(column)}${row}`
  if (value === null || value === '') return ''
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`
  if (typeof value === 'number') return `<c r="${reference}"><v>${value}</v></c>`
  const serial = isDateColumn ? toDateSerial(value) : undefined
  if (serial !== undefined) return `<c r="${reference}" s="1"><v>${serial}</v></c>`
  const space = /^\s|\s$|\n/u.test(value) ? ' xml:space="preserve"' : ''
  return `<c r="${reference}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t${space}>${escapeXml(value)}</t></is></c>`
}

/**
 * Reads the cells of a worksheet into rows.
 *
 * @param worksheet - Worksheet XML.
 * @param sharedStrings - Shared string table.
 * @param dateStyles - Style indexes whose number format shows a date.
 * @param uses1904 - Whether the workbook counts dates from 1904.
 * @returns Rows of cell values.
 */
function readWorksheetRows(
  worksheet: XmlElement,
  sharedStrings: readonly string[],
  dateStyles: ReadonlySet<number>,
  uses1904: boolean,
) {
  const rows: SpreadsheetCell[][] = []
  // Counts every slot the rows allocate, including the empty ones before a far-right cell or a
  // far-down row, so a small sparse sheet cannot make the browser allocate millions of entries.
  let allocatedSlots = 0
  let nextRow = 1
  for (const row of childElements(childElement(worksheet, 'sheetData') ?? emptyElement(), 'row')) {
    const rowNumber = readPositiveInteger(row.attributes.r) ?? nextRow
    nextRow = rowNumber + 1
    if (rowNumber > 1_048_576) throw new SpreadsheetError('The worksheet has too many rows.')
    const cells: SpreadsheetCell[] = []
    let nextColumn = 0
    for (const cell of childElements(row, 'c')) {
      const column = readColumnIndex(cell.attributes.r) ?? nextColumn
      nextColumn = column + 1
      if (column > 16_383) throw new SpreadsheetError('The worksheet has too many cells.')
      allocatedSlots += Math.max(1, column + 1 - cells.length)
      if (allocatedSlots > maxCells) throw new SpreadsheetError('The worksheet has too many cells.')
      while (cells.length < column) cells.push(null)
      cells[column] = readCellValue(cell, sharedStrings, dateStyles, uses1904)
    }
    allocatedSlots += Math.max(0, rowNumber - 1 - rows.length)
    if (allocatedSlots > maxCells) throw new SpreadsheetError('The worksheet has too many cells.')
    while (rows.length < rowNumber - 1) rows.push([])
    rows[rowNumber - 1] = cells
  }
  return rows
}

/**
 * Reads the value of one cell.
 *
 * @param cell - Cell XML.
 * @param sharedStrings - Shared string table.
 * @param dateStyles - Style indexes whose number format shows a date.
 * @param uses1904 - Whether the workbook counts dates from 1904.
 * @returns The value.
 */
function readCellValue(
  cell: XmlElement,
  sharedStrings: readonly string[],
  dateStyles: ReadonlySet<number>,
  uses1904: boolean,
): SpreadsheetCell {
  const type = cell.attributes.t ?? 'n'
  const raw = textContent(childElement(cell, 'v'))
  if (type === 'inlineStr') return readStringItem(childElement(cell, 'is') ?? emptyElement())
  if (type === 's') return sharedStrings[Number(raw)] ?? null
  if (type === 'str' || type === 'e') return raw
  if (type === 'b') return raw === '1'
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return raw
  return dateStyles.has(Number(cell.attributes.s ?? '0')) ? fromDateSerial(value, uses1904) ?? value : value
}

/**
 * Reads the text of a shared or inline string, joining rich-text runs.
 *
 * @param item - `si` or `is` element.
 * @returns The text without phonetic runs.
 */
function readStringItem(item: XmlElement) {
  const plain = childElement(item, 't')
  if (plain) return textContent(plain)
  return childElements(item, 'r').map((run) => textContent(childElement(run, 't'))).join('')
}

/**
 * Finds the cell styles whose number format shows a date.
 *
 * @param styles - Styles XML.
 * @returns Style indexes.
 */
function readDateStyles(styles: XmlElement | undefined) {
  const result = new Set<number>()
  if (!styles) return result
  const customDateFormats = new Set(childElements(childElement(styles, 'numFmts') ?? emptyElement(), 'numFmt')
    .filter((format) => isDateFormatCode(format.attributes.formatCode ?? ''))
    .map((format) => Number(format.attributes.numFmtId)))
  childElements(childElement(styles, 'cellXfs') ?? emptyElement(), 'xf').forEach((format, index) => {
    const id = Number(format.attributes.numFmtId ?? '0')
    if (builtInDateFormats.has(id) || customDateFormats.has(id)) result.add(index)
  })
  return result
}

/**
 * Checks whether a number format code shows a date.
 *
 * @param code - Format code.
 * @returns Whether it has a year, month, or day outside quoted text.
 */
function isDateFormatCode(code: string) {
  const unquoted = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/gu, '')
  return /[dy]|m(?!\w*s)/iu.test(unquoted) && !/^[#0.,%\s]*$/u.test(unquoted)
}

/**
 * Converts a spreadsheet date serial to a calendar date.
 *
 * @param serial - Days since the workbook epoch.
 * @param uses1904 - Whether the epoch is 1904.
 * @returns `YYYY-MM-DD`, or undefined outside the supported range.
 */
function fromDateSerial(serial: number, uses1904: boolean) {
  if (serial < 1 || serial > 2_958_465) return undefined
  const days = Math.floor(serial) + (uses1904 ? 1_462 : 0)
  // Serial 60 is the 1900-02-29 that spreadsheets count but that never existed.
  const epoch = Date.UTC(1899, 11, days >= 61 || uses1904 ? 30 : 31)
  return new Date(epoch + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Converts a calendar date to a 1900-epoch spreadsheet serial.
 *
 * @param value - `YYYY-MM-DD` text.
 * @returns The serial, or undefined when the text is not such a date.
 */
function toDateSerial(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined
  const time = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) return undefined
  const days = Math.round((time - Date.UTC(1899, 11, 30)) / 86_400_000)
  return days >= 61 ? days : undefined
}

/**
 * Checks whether a row can be a header row.
 *
 * @param cells - Row cells.
 * @returns Whether it has at least two filled cells, all distinct text.
 */
function isHeaderRow(cells: readonly SpreadsheetCell[]) {
  const filled = cells.filter((cell) => cell !== null && cell !== '')
  if (filled.length < 2) return false
  if (!filled.every((cell) => typeof cell === 'string' && cell.trim())) return false
  const names = filled.map((cell) => String(cell).trim())
  return new Set(names).size === names.length
}

/**
 * Converts a cell reference such as `C12` to a zero-based column.
 *
 * @param reference - Cell reference.
 * @returns The column, if the reference is valid.
 */
function readColumnIndex(reference: string | undefined) {
  const letters = /^([A-Z]{1,3})\d+$/u.exec(reference ?? '')?.[1]
  if (!letters) return undefined
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1
}

/**
 * Converts a zero-based column to its letters.
 *
 * @param index - Column.
 * @returns Letters such as `AB`.
 */
function columnName(index: number) {
  let name = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name
  }
  return name
}

/**
 * Makes a sheet name that spreadsheets accept.
 *
 * @param name - Wanted name.
 * @param index - Sheet position, used when the name is empty.
 * @returns A name of at most 31 characters without `[]:*?/\`.
 */
function sanitizeSheetName(name: string, index: number) {
  const cleaned = name.replace(/[[\]:*?/\\]/gu, ' ').trim().slice(0, 31)
  return cleaned || `Sheet${index + 1}`
}

/**
 * Reads a positive integer attribute.
 *
 * @param value - Attribute value.
 * @returns The integer, if valid.
 */
function readPositiveInteger(value: string | undefined) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

/**
 * Creates an element with no content, used when an optional part is missing.
 *
 * @returns An empty element.
 */
function emptyElement(): XmlElement {
  return { name: '', attributes: {}, children: [] }
}
