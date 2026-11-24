/** Leading characters a spreadsheet may run as a formula, plus `'` so that the escape reverses. */
const escapedLeadPattern = /^[=+\-@\t\r']/u

/**
 * Puts `'` before a cell that starts with `=`, `+`, `-`, `@`, a tab, a carriage return or `'`, so
 * a spreadsheet opens it as text instead of running it as a formula. Escaping a leading `'` as
 * well keeps the escape reversible with {@link unescapeSpreadsheetCell}.
 *
 * @param value - Cell text.
 * @returns The escaped cell text.
 */
export function escapeSpreadsheetCell(value: string): string {
  return escapedLeadPattern.test(value) ? `'${value}` : value
}

/**
 * Removes the `'` that {@link escapeSpreadsheetCell} added, so an escaped value reads back
 * unchanged.
 *
 * @param value - Cell text.
 * @returns The cell text without the escape.
 */
export function unescapeSpreadsheetCell(value: string): string {
  return value.startsWith("'") && escapedLeadPattern.test(value.slice(1)) ? value.slice(1) : value
}
