import {
  WORKSPACE_BULK_INVITATION_MAX_ROWS,
  WORKSPACE_INVITATION_NAME_MAX_LENGTH,
  isWorkspaceInvitationEmail,
  normalizeWorkspaceInvitationEmail,
} from '@mukuroji/contracts'
import type { WorkspaceInvitation, WorkspaceMember, WorkspaceRole } from '../api/access'
import { escapeSpreadsheetCell, unescapeSpreadsheetCell } from './spreadsheetCell'

/**
 * Why a row of a bulk invitation cannot be sent.
 *
 * - `invalid-email`: the email address is missing or cannot receive mail.
 * - `name-too-long`: the display name is longer than the API accepts or holds a control character.
 * - `invalid-role`: the role column names no Workspace role.
 * - `role-not-allowed`: the signed-in administrator cannot grant the role.
 * - `duplicate`: an earlier row of the same input has the same address.
 * - `already-member`: the address is already a Workspace member.
 * - `already-invited`: the address already has an open invitation.
 * - `reinvite-required`: the address has an expired, revoked or accepted invitation. The API keeps
 *   one invitation record per address, so a new one cannot be created; the ledger's reinvite
 *   action renews it instead.
 */
export type BulkInvitationIssue =
  | 'invalid-email'
  | 'name-too-long'
  | 'invalid-role'
  | 'role-not-allowed'
  | 'duplicate'
  | 'already-member'
  | 'already-invited'
  | 'reinvite-required'

/** One row of a bulk invitation after the check. */
export type BulkInvitationRow = {
  /** 1-based line number of the row in the pasted text or CSV file. */
  line: number
  /** Normalized email address, or the raw cell when it is not an address. */
  email: string
  /** Trimmed display name, when the row has one. */
  name?: string
  /** Role the invitation grants: the row's role column, or the role chosen for every row. */
  role: WorkspaceRole
  /**
   * The row's role cell as written, when it has one. It is kept so that putting a row back into
   * the input never turns an unknown role into a valid one.
   */
  roleInput?: string
  /** Why the row cannot be sent; absent when it can. */
  issue?: BulkInvitationIssue
}

/** Result of checking a bulk invitation input without sending anything. */
export type BulkInvitationPlan = {
  /** The first rows of the input that one bulk invitation sends, in input order, with blank lines left out. */
  rows: BulkInvitationRow[]
  /** Whether the input had more rows than one bulk invitation sends. */
  truncated: boolean
  /**
   * Rows past the bulk limit, unchecked and never sent. They are kept so that putting the unsent
   * rows back into the input does not drop them.
   */
  overflowRows: BulkInvitationRow[]
}

/** State the check compares the input with. */
export type BulkInvitationContext = {
  /** Role used for rows without a role column. */
  defaultRole: WorkspaceRole
  /** Roles the signed-in administrator can grant. */
  allowedRoles: readonly WorkspaceRole[]
  /** Current Workspace members. */
  members: readonly WorkspaceMember[]
  /** Current invitations. */
  invitations: readonly WorkspaceInvitation[]
}

/** Invitation statuses that block another invitation to the same address. */
const openInvitationStatuses: ReadonlySet<WorkspaceInvitation['status']> = new Set([
  'provisioning',
  'pending',
  'delivery-failed',
])

/** Header labels, lower-cased, that name the email column. */
const emailHeaders = new Set(['email', 'e-mail', 'mail', 'メール', 'メールアドレス'])
/** Header labels, lower-cased, that name the display name column. */
const nameHeaders = new Set(['name', 'display name', 'displayname', '名前', '氏名', '表示名'])
/** Header labels, lower-cased, that name the role column. */
const roleHeaders = new Set(['role', 'ロール', '権限'])

/** Role column values, lower-cased, and the Workspace role each names. */
const roleAliases = new Map<string, WorkspaceRole>([
  ['owner', 'owner'],
  ['オーナー', 'owner'],
  ['admin', 'admin'],
  ['管理者', 'admin'],
  ['member', 'member'],
  ['メンバー', 'member'],
  ['guest', 'guest'],
  ['ゲスト', 'guest'],
])

/** Column positions of one CSV layout. */
type ColumnLayout = {
  /** Index of the email column. */
  email: number
  /** Index of the display name column, when there is one. */
  name?: number
  /** Index of the role column, when there is one. */
  role?: number
}

/** A parsed CSV record and the line it starts on. */
type CsvRecord = {
  /** 1-based line the record starts on. */
  line: number
  /** Cells of the record. */
  cells: string[]
}

/**
 * Splits CSV text into records, following RFC 4180 quoting: a quoted cell may hold commas,
 * doubled quotes and line breaks. Tabs and semicolons also separate cells, so rows pasted from
 * a spreadsheet and address lists such as `a@example.com; b@example.com` work too.
 *
 * @param text - CSV or pasted text.
 * @returns The records with their starting line, including blank ones.
 */
function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = []
  const source = text.replace(/^\uFEFF/, '')
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let recordLine = 1

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        if (char === '\n') line += 1
        cell += char
      }
      continue
    }
    if (char === '"' && cell.trim() === '') {
      cell = ''
      quoted = true
    } else if (char === ',' || char === ';' || char === '\t') {
      cells.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      cells.push(cell)
      records.push({ line: recordLine, cells })
      cells = []
      cell = ''
      line += 1
      recordLine = line
    } else {
      cell += char
    }
  }
  cells.push(cell)
  records.push({ line: recordLine, cells })
  return records
}

/**
 * Finds the column layout from a header record, when the record is one.
 *
 * @param cells - Cells of the first non-blank record.
 * @returns The layout the header names, or `undefined` when the record is not a header.
 */
function readHeaderLayout(cells: readonly string[]): ColumnLayout | undefined {
  const labels = cells.map((cell) => cell.trim().toLowerCase())
  const email = labels.findIndex((label) => emailHeaders.has(label))
  if (email < 0) return undefined
  const name = labels.findIndex((label) => nameHeaders.has(label))
  const role = labels.findIndex((label) => roleHeaders.has(label))
  return {
    email,
    name: name >= 0 ? name : undefined,
    role: role >= 0 ? role : undefined,
  }
}

/** Layout of a record without a header: email, then name, then role. */
const positionalLayout: ColumnLayout = { email: 0, name: 1, role: 2 }

/** A row read from the input before it is checked. */
type RawInvitationRow = {
  /** 1-based line of the row. */
  line: number
  /** Raw email cell. */
  email: string
  /** Raw name cell. */
  name?: string
  /** Raw role cell. */
  role?: string
}

/**
 * Reads the rows of a record. A record without a header whose every non-blank cell holds an `@`
 * is a list of addresses, such as `a@example.com, b@example.com`, and gives one row per address.
 *
 * @param record - Parsed record.
 * @param layout - Column layout from a header, or `undefined` for positional columns.
 * @returns The rows of the record.
 */
function readRecordRows(record: CsvRecord, layout: ColumnLayout | undefined): RawInvitationRow[] {
  const cells = record.cells.map((cell) => unescapeSpreadsheetCell(cell.trim()))
  if (!layout) {
    const filled = cells.filter((cell) => cell !== '')
    if (filled.length > 1 && filled.every((cell) => cell.includes('@'))) {
      return filled.map((email) => ({ line: record.line, email }))
    }
  }
  const columns = layout ?? positionalLayout
  return [{
    line: record.line,
    email: cells[columns.email] ?? '',
    name: columns.name === undefined ? undefined : cells[columns.name],
    role: columns.role === undefined ? undefined : cells[columns.role],
  }]
}

/**
 * Tells whether a display name fits the API's limits.
 *
 * @param name - Trimmed display name.
 * @returns Whether the API accepts the name.
 */
function isAcceptableName(name: string) {
  return name.length <= WORKSPACE_INVITATION_NAME_MAX_LENGTH && !/\p{Cc}/u.test(name)
}

/**
 * Checks a bulk invitation without sending anything: it reads one invitation per line of pasted
 * text or CSV, and marks rows with a malformed address, a name or role the API rejects, an
 * address repeated in the input, or an address that is already a member or invited.
 *
 * A CSV may start with a header naming its columns (`email`, `name`, `role`, or メールアドレス,
 * 名前, ロール). Without one, the columns are email, name and role in that order.
 *
 * @param text - Pasted text or CSV file contents.
 * @param context - Current members and invitations, and the roles that may be granted.
 * @returns Every row with its issue, and whether rows past the limit were left out.
 */
export function planBulkInvitation(text: string, context: BulkInvitationContext): BulkInvitationPlan {
  const records = parseCsvRecords(text).filter((record) =>
    record.cells.some((cell) => cell.trim() !== '')
  )
  const layout = records.length > 0 ? readHeaderLayout(records[0].cells) : undefined
  const dataRecords = layout ? records.slice(1) : records
  const rawRows = dataRecords.flatMap((record) => readRecordRows(record, layout))
  const truncated = rawRows.length > WORKSPACE_BULK_INVITATION_MAX_ROWS
  const memberEmails = new Set(context.members.map((member) => normalizeWorkspaceInvitationEmail(member.email)))
  const invitedEmails = new Set(
    context.invitations
      .filter((invitation) => openInvitationStatuses.has(invitation.status))
      .map((invitation) => normalizeWorkspaceInvitationEmail(invitation.email)),
  )
  const closedInvitationEmails = new Set(
    context.invitations
      .filter((invitation) => !openInvitationStatuses.has(invitation.status))
      .map((invitation) => normalizeWorkspaceInvitationEmail(invitation.email)),
  )
  const seen = new Set<string>()

  const rows = rawRows.slice(0, WORKSPACE_BULK_INVITATION_MAX_ROWS).map((raw): BulkInvitationRow => {
    const email = normalizeWorkspaceInvitationEmail(raw.email)
    const name = raw.name?.trim() || undefined
    const roleInput = raw.role?.trim() || undefined
    const role = roleInput ? roleAliases.get(roleInput.toLowerCase()) : context.defaultRole
    const row: BulkInvitationRow = { line: raw.line, email, name, role: role ?? context.defaultRole }
    if (roleInput) row.roleInput = roleInput
    const issue: BulkInvitationIssue | undefined = !isWorkspaceInvitationEmail(email)
      ? 'invalid-email'
      : name !== undefined && !isAcceptableName(name)
        ? 'name-too-long'
        : role === undefined
          ? 'invalid-role'
          : !context.allowedRoles.includes(role)
            ? 'role-not-allowed'
            : seen.has(email)
              ? 'duplicate'
              : memberEmails.has(email)
                ? 'already-member'
                : invitedEmails.has(email)
                  ? 'already-invited'
                  : closedInvitationEmails.has(email)
                    ? 'reinvite-required'
                    : undefined
    if (isWorkspaceInvitationEmail(email)) seen.add(email)
    return issue ? { ...row, issue } : row
  })

  const overflowRows = rawRows.slice(WORKSPACE_BULK_INVITATION_MAX_ROWS).map((raw): BulkInvitationRow => {
    const roleInput = raw.role?.trim() || undefined
    const row: BulkInvitationRow = {
      email: normalizeWorkspaceInvitationEmail(raw.email),
      line: raw.line,
      name: raw.name?.trim() || undefined,
      role: context.defaultRole,
    }
    if (roleInput) row.roleInput = roleInput
    return row
  })

  return { overflowRows, rows, truncated }
}

/**
 * Builds a CSV of rows, so failed rows can be put back into the input and sent again. Every cell
 * is quoted and escaped like the member export, so a name holding a delimiter keeps its column, a
 * value starting with `'` or a formula character reads back unchanged, and the role column holds the role
 * as the row wrote it, so an unknown role stays unknown until the administrator corrects it.
 *
 * @param rows - Rows to write.
 * @returns CSV text with an `email,name,role` header.
 */
export function createBulkInvitationRetryCsv(rows: readonly BulkInvitationRow[]) {
  const quote = (value: string) => `"${escapeSpreadsheetCell(value).replaceAll('"', '""')}"`
  return ['email,name,role', ...rows.map((row) => [row.email, row.name ?? '', row.roleInput ?? ''].map(quote).join(','))]
    .join('\n')
}
