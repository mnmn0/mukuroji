import { createSpreadsheetWorkbook } from '../../developer-platform/model/spreadsheet'

/** File format of a view export. */
export type TaskViewExportFormat = 'csv' | 'xlsx'

/** File formats a view can be exported to, in button order. */
export const taskViewExportFormats: readonly TaskViewExportFormat[] = ['csv', 'xlsx']

/** Header and text cells of one exported view, in the order the view shows them. */
export type TaskViewExportTable = {
  /** Column headings as the view labels them. */
  columns: string[]
  /** One text cell per column for each row; an empty cell is `''`. */
  rows: string[][]
}

/** Exported view ready for a browser download. */
export type TaskViewExportFile = {
  /** File contents. */
  blob: Blob
  /** File name offered by the download. */
  fileName: string
}

/**
 * Builds the CSV or Excel file of a view's rows and columns.
 *
 * The cells are the text the view shows, so a member exports only what they can already read.
 *
 * @param table - Header and text cells of the view.
 * @param format - File format.
 * @param baseName - File name without the date and extension, such as the Project name.
 * @param exportedAt - Export time, which names the file.
 * @returns The file and its name.
 */
export function createTaskViewExportFile(
  table: TaskViewExportTable,
  format: TaskViewExportFormat,
  baseName: string,
  exportedAt = new Date(),
): TaskViewExportFile {
  const fileName = `${sanitizeTaskViewExportFileName(baseName)}-${formatExportDate(exportedAt)}.${format}`
  if (format === 'xlsx') {
    const workbook = createSpreadsheetWorkbook([{
      name: 'Work Items',
      columns: table.columns,
      rows: table.rows.map((row) => row.map((cell) => cell || null)),
    }], exportedAt)
    return {
      blob: new Blob([new Uint8Array(workbook)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      fileName,
    }
  }
  const lines = [table.columns, ...table.rows].map((row) => row.map(escapeTaskViewCsvCell).join(','))
  // The byte order mark makes Excel read the UTF-8 file, including Japanese text, correctly.
  return {
    blob: new Blob([`\uFEFF${lines.join('\r\n')}\r\n`], { type: 'text/csv; charset=utf-8' }),
    fileName,
  }
}

/**
 * Quotes one CSV cell and prefixes a leading formula character so spreadsheets read it as text.
 *
 * @param value - Cell text.
 * @returns The escaped cell.
 */
export function escapeTaskViewCsvCell(value: string): string {
  const safeValue = /^[\t\r\n ]*[=+\-@]/u.test(value) ? `'${value}` : value
  return /[",\r\n]/u.test(safeValue) ? `"${safeValue.replaceAll('"', '""')}"` : safeValue
}

/**
 * Replaces characters that file systems reject in a file name.
 *
 * @param name - Proposed name.
 * @returns A name of at most 80 characters, or `work-items` when nothing is left.
 */
function sanitizeTaskViewExportFileName(name: string): string {
  const sanitized = name
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80)
  return sanitized || 'work-items'
}

/**
 * Formats the local export date as `YYYYMMDD`.
 *
 * @param value - Export time.
 * @returns The date part of the file name.
 */
function formatExportDate(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('')
}
