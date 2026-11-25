import { escapeSpreadsheetCell } from '../../shared/lib/spreadsheetCell'
import type { WorkspaceMember, WorkspaceMemberStatus, WorkspaceRole } from '../api/access'

/**
 * Order of the Workspace member list.
 *
 * - `default`: the server's order (role, then name)
 * - `name`: name, or email when the member has no name
 * - `last-sign-in`: members without a recorded sign-in first, then the oldest sign-in first, to
 *   find accounts nobody uses
 * - `joined`: the newest member first
 */
export type WorkspaceMemberSort = 'default' | 'name' | 'last-sign-in' | 'joined'

/** Orders of the member list, in the order the list offers them. */
export const workspaceMemberSorts: readonly WorkspaceMemberSort[] = ['default', 'name', 'last-sign-in', 'joined']

/** Filter of the Workspace member list. */
export type WorkspaceMemberFilter = {
  /** Text matched against the member's name and email; blank matches everyone. */
  query: string
  /** Status to keep, or `all`. */
  status: WorkspaceMemberStatus | 'all'
  /** Role to keep, or `all`. */
  role: WorkspaceRole | 'all'
  /** Order of the kept members. */
  sort: WorkspaceMemberSort
}

/** Filter that keeps every member. */
export const emptyWorkspaceMemberFilter: WorkspaceMemberFilter = {
  query: '',
  role: 'all',
  sort: 'default',
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
 * Compares two members for a sort order. Ties keep the original order, because the sort is stable.
 *
 * @param left - First member.
 * @param right - Second member.
 * @param sort - Sort order other than `default`.
 * @returns A negative number when `left` comes first, a positive number when `right` does.
 */
function compareMembers(
  left: WorkspaceMember,
  right: WorkspaceMember,
  sort: Exclude<WorkspaceMemberSort, 'default'>,
) {
  if (sort === 'name') {
    return (left.name?.trim() || left.email).localeCompare(right.name?.trim() || right.email, 'ja')
  }
  if (sort === 'joined') {
    return right.createdAt.localeCompare(left.createdAt)
  }
  if (left.lastSignedInAt === right.lastSignedInAt) return 0
  if (left.lastSignedInAt === undefined) return -1
  if (right.lastSignedInAt === undefined) return 1
  return left.lastSignedInAt.localeCompare(right.lastSignedInAt)
}

/**
 * Keeps the members that match a filter, in the filter's order.
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
  const kept = members.filter((member) =>
    (filter.status === 'all' || member.status === filter.status) &&
    (filter.role === 'all' || member.role === filter.role) &&
    (query === '' ||
      foldSearchText(member.name ?? '').includes(query) ||
      foldSearchText(member.email).includes(query))
  )
  const { sort } = filter
  return sort === 'default' ? kept : kept.sort((left, right) => compareMembers(left, right, sort))
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
  /** Header of the last sign-in column, which is blank when no sign-in is recorded or shown. */
  lastSignedInAt: string
}

/**
 * Quotes one CSV cell after escaping a leading formula character for spreadsheets.
 *
 * @param value - Cell text.
 * @returns The quoted cell.
 */
function toCsvCell(value: string) {
  return `"${escapeSpreadsheetCell(value).replaceAll('"', '""')}"`
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
    [
      headers.email,
      headers.name,
      headers.role,
      headers.status,
      headers.createdAt,
      headers.deactivatedAt,
      headers.lastSignedInAt,
    ],
    ...members.map((member) => [
      member.email,
      member.name ?? '',
      member.role,
      member.status,
      member.createdAt,
      member.deactivatedAt ?? '',
      member.lastSignedInAt ?? '',
    ]),
  ]
  return `${rows.map((row) => row.map(toCsvCell).join(',')).join('\r\n')}\r\n`
}
