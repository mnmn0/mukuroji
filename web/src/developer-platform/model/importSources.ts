import {
  measureWorkItemImportContentBytes,
  WORK_ITEM_IMPORT_MAPPING_FIELD_MAX_LENGTH,
  WORK_ITEM_IMPORT_MAX_BYTES,
} from '@mukuroji/contracts'
import type { DeveloperImportFieldMapping, DeveloperImportFormat } from './transfers'
import { MS_PROJECT_IMPORT_COLUMNS, readMsProjectXml } from './msProjectXml'
import { findSpreadsheetTable, readSpreadsheetWorkbook, SPREADSHEET_IMPORT_MAX_BYTES } from '../../shared/lib/files/spreadsheet'

/** File format chosen for an import; workbooks and MS Project files are sent as JSON rows. */
export type DeveloperImportFileFormat = DeveloperImportFormat | 'xlsx' | 'msproject'

/** Import source ready to send to the Public API. */
export type DeveloperImportSource = {
  /** Format the Public API reads. */
  format: DeveloperImportFormat
  /** Source text. */
  content: string
  /** Media type of the source text. */
  mediaType: 'text/csv' | 'application/json'
  /** Name of the file the person chose. */
  fileName: string
  /** Column names of the source, in order, used to suggest a mapping. */
  headers: string[]
}

/** Selected file, as the browser's `File` provides it. */
export type DeveloperImportFile = {
  /** File name. */
  name: string
  /** File size in bytes. */
  size: number
  /** Reads the file as text. */
  text: () => Promise<string>
  /** Reads the file bytes. */
  arrayBuffer: () => Promise<ArrayBuffer>
}

/** `accept` attribute of the file input for each import format. */
export const DEVELOPER_IMPORT_FILE_ACCEPT: Record<DeveloperImportFileFormat, string> = {
  csv: '.csv,text/csv',
  json: '.json,application/json',
  xlsx: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  msproject: '.xml,application/xml,text/xml',
}

/** Import target suggested for each known column name, compared without case. */
const suggestedTargets = new Map<string, string>([
  ['id', 'importKey'],
  ['uid', 'importKey'],
  ['importkey', 'importKey'],
  ['key', 'importKey'],
  ['parentid', 'parentKey'],
  ['parentkey', 'parentKey'],
  ['parent', 'parentKey'],
  ['title', 'title'],
  ['name', 'title'],
  ['description', 'description'],
  ['notes', 'description'],
  ['assignedprojectid', 'assignedProjectId'],
  ['assigneeuserid', 'assigneeUserId'],
  ['owner', 'assigneeUserId'],
  ['workitemtypeid', 'workItemTypeId'],
  ['workflowstatusid', 'workflowStatusId'],
  ['schedule', 'schedule'],
  ['priority', 'priority'],
  ['wbs', 'wbsNumber'],
  ['wbsnumber', 'wbsNumber'],
  ['outlinelevel', 'outlineLevel'],
  ['dependencies', 'dependencies'],
  ['predecessors', 'dependencies'],
  ['relations', 'relations'],
  ['contributors', 'contributors'],
  ['acceptancecriteria', 'acceptanceCriteria'],
])

/**
 * Reads a chosen file into the source the Public API imports.
 *
 * CSV and JSON files are sent as they are. The first table of a `.xlsx` workbook and the tasks of
 * a MS Project XML file are converted in the browser to JSON rows whose cells are text, the same
 * values a CSV file carries.
 *
 * The source must fit the import limit, counted the same way the server counts it, so an
 * oversized file is refused before it is sent.
 *
 * @param format - Format the person chose.
 * @param file - Chosen file.
 * @returns Source text and its column names.
 * @throws Error with a message for the person when the file cannot be read in that format or is
 * too large to import.
 */
export async function readDeveloperImportSource(
  format: DeveloperImportFileFormat,
  file: DeveloperImportFile,
): Promise<DeveloperImportSource> {
  const source = await readSourceInFormat(format, file)
  if (measureWorkItemImportContentBytes(source.content) > WORK_ITEM_IMPORT_MAX_BYTES) {
    throw new Error('The file is too large to import.')
  }
  return source
}

/**
 * Reads a chosen file in the format the person chose, without the import size check.
 *
 * @param format - Format the person chose.
 * @param file - Chosen file.
 * @returns Source text and its column names.
 * @throws Error with a message for the person when the file cannot be read in that format.
 */
async function readSourceInFormat(
  format: DeveloperImportFileFormat,
  file: DeveloperImportFile,
): Promise<DeveloperImportSource> {
  if (format === 'csv') {
    const content = await file.text()
    return { format, content, mediaType: 'text/csv', fileName: file.name, headers: readCsvHeader(content) }
  }
  if (format === 'json') {
    const content = await file.text()
    return { format, content, mediaType: 'application/json', fileName: file.name, headers: readJsonHeaders(content) }
  }
  if (file.size > SPREADSHEET_IMPORT_MAX_BYTES) throw new Error('The file is too large to import.')
  if (format === 'xlsx') {
    const table = findSpreadsheetTable(await readSpreadsheetWorkbook(new Uint8Array(await file.arrayBuffer())))
    const rows = table.rows.map((row) => Object.fromEntries(Object.entries(row).flatMap(([header, cell]) =>
      cell === null || cell === '' ? [] : [[header, String(cell)]])))
    return toJsonSource(rows, file.name, table.headers)
  }
  return toJsonSource(readMsProjectXml(await file.text()), file.name, [...MS_PROJECT_IMPORT_COLUMNS])
}

/**
 * Suggests a mapping for the known columns of a source.
 *
 * mukuroji's own export columns and the MS Project task columns map to the fields that re-import
 * them; read-only columns such as `revision` and unknown columns are left for the person to map.
 * When both a parent column and a WBS or outline column are present, only the parent is mapped,
 * because it already decides the hierarchy.
 *
 * @param headers - Source column names.
 * @returns Suggested mapping rows in column order.
 */
export function suggestDeveloperImportMapping(headers: readonly string[]): DeveloperImportFieldMapping[] {
  const mapping: DeveloperImportFieldMapping[] = []
  const targets = new Set<string>()
  for (const header of headers) {
    // A column name longer than a mapping field accepts is left for the person to rename.
    if (header.length > WORK_ITEM_IMPORT_MAPPING_FIELD_MAX_LENGTH) continue
    const target = header.startsWith('customFieldValues.')
      ? header
      : suggestedTargets.get(header.trim().toLowerCase())
    if (!target || targets.has(target)) continue
    targets.add(target)
    mapping.push({ sourceField: header, targetField: target })
  }
  if (!targets.has('parentKey')) return mapping
  return mapping.filter((entry) => entry.targetField !== 'wbsNumber' && entry.targetField !== 'outlineLevel')
}

/**
 * Builds a JSON source from converted rows.
 *
 * @param rows - Converted rows.
 * @param fileName - Chosen file name.
 * @param headers - Column names.
 * @returns JSON source.
 */
function toJsonSource(rows: Array<Record<string, unknown>>, fileName: string, headers: string[]): DeveloperImportSource {
  return {
    format: 'json',
    content: JSON.stringify(rows),
    mediaType: 'application/json',
    fileName,
    headers,
  }
}

/**
 * Reads the header row of CSV text.
 *
 * @param text - CSV text.
 * @returns Header names, empty when the text has none.
 */
function readCsvHeader(text: string) {
  const headers: string[] = []
  let cell = ''
  let quoted = false
  const source = text.replace(/^\ufeff/u, '')
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      headers.push(cell.trim())
      cell = ''
    } else if (character === '\r' || character === '\n') {
      break
    } else {
      cell += character
    }
  }
  headers.push(cell.trim())
  return headers.filter(Boolean)
}

/**
 * Lists the top-level keys of the rows of JSON import text.
 *
 * @param text - JSON text: an array of rows or an object with a `workItems` array.
 * @returns Keys in first-seen order, empty when the text is not import JSON.
 */
function readJsonHeaders(text: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\ufeff/u, ''))
  } catch {
    return []
  }
  const rows: unknown = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'workItems') : undefined
  if (!Array.isArray(rows)) return []
  const headers = new Set<string>()
  // Every row is read, because an export leaves out empty optional fields such as dependencies.
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    for (const [key, value] of Object.entries(row)) {
      // Custom field values are mapped one field at a time, as the CSV columns are.
      if (key === 'customFieldValues' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        for (const fieldId of Object.keys(value)) headers.add(`customFieldValues.${fieldId}`)
        continue
      }
      headers.add(key)
    }
  }
  return [...headers]
}
