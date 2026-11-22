import type { WorkspaceMember, WorkspaceMemberStatus, WorkspaceRole } from '../api/access'

/** Filter of the Workspace member list. */
export type WorkspaceMemberFilter = {
  /** Text matched against the member's name and email; blank matches everyone. */
  query: string
  /** Status to keep, or `all`. */
  status: WorkspaceMemberStatus | 'all'
  /** Role to keep, or `all`. */
  role: WorkspaceRole | 'all'
}

/** Filter that keeps every member. */
export const emptyWorkspaceMemberFilter: WorkspaceMemberFilter = {
  query: '',
  role: 'all',
  status: 'all',
}

/**
 * Folds text for a forgiving search: full-width letters and digits become half-width, letters
 * become lower case, and spaces are removed, so `ｓａｔｏ`, `Sato` and `佐藤 花子` / `佐藤花子`
 * match one another.
 *
 * @param value - Text to fold.
 * @returns The folded text.
 */
function foldSearchText(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}

/**
 * Keeps the members that match a filter, in their original order.
 *
 * @param members - Workspace members.
 * @param filter - Filter to apply.
 * @returns The matching members.
 */
export function filterWorkspaceMembers(
  members: readonly WorkspaceMember[],
  filter: WorkspaceMemberFilter,
): WorkspaceMember[] {
  const query = foldSearchText(filter.query)
  return members.filter((member) =>
    (filter.status === 'all' || member.status === filter.status) &&
    (filter.role === 'all' || member.role === filter.role) &&
    (query === '' ||
      foldSearchText(member.name ?? '').includes(query) ||
      foldSearchText(member.email).includes(query))
  )
}

/** Column headers of the member CSV export. */
export type WorkspaceMemberCsvHeaders = {
  /** Header of the email column. */
  email: string
  /** Header of the display name column. */
  name: string
  /** Header of the role column. */
  role: string
  /** Header of the status column. */
  status: string
  /** Header of the joined date column. */
  createdAt: string
  /** Header of the deactivation date column. */
  deactivatedAt: string
}

/**
 * Quotes one CSV cell. A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return
 * gets a leading `'`, so a spreadsheet opens it as text instead of running it as a formula. A cell
 * that already starts with `'` gets one too, so the bulk invitation can strip exactly one `'` and
 * read every value back unchanged.
 *
 * @param value - Cell text.
 * @returns The quoted cell.
 */
function toCsvCell(value: string) {
  const safe = /^[=+\-@\t\r']/u.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

/**
 * Builds the CSV export of the member list, with a header row and CRLF line ends. Roles and
 * statuses are written as their API values (`owner`, `active`, ...), so the file can be read
 * back by the bulk invitation.
 *
 * @param members - Members to export, in export order.
 * @param headers - Column headers in the display language.
 * @returns CSV text.
 */
export function createWorkspaceMemberCsv(
  members: readonly WorkspaceMember[],
  headers: WorkspaceMemberCsvHeaders,
): string {
  const rows = [
    [headers.email, headers.name, headers.role, headers.status, headers.createdAt, headers.deactivatedAt],
    ...members.map((member) => [
      member.email,
      member.name ?? '',
      member.role,
      member.status,
      member.createdAt,
      member.deactivatedAt ?? '',
    ]),
  ]
  return `${rows.map((row) => row.map(toCsvCell).join(',')).join('\r\n')}\r\n`
}
