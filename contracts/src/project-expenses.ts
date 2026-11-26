/**
 * Project expense entries: costs other than people's time, such as subcontracting or licenses,
 * that count toward a Project budget once a Project manager approves them (ADR 0104).
 */

/** Approval state of a Project expense. */
export type ProjectExpenseStatus = 'submitted' | 'approved' | 'rejected'

/** Every Project expense status. */
export const PROJECT_EXPENSE_STATUSES: readonly ProjectExpenseStatus[] = ['submitted', 'approved', 'rejected']

/** Outcome of a Project manager's decision on a submitted expense. */
export type ProjectExpenseDecisionOutcome = 'approved' | 'rejected'

/** Longest expense category, such as `外注費` or `License`. */
export const PROJECT_EXPENSE_CATEGORY_MAX_LENGTH = 80
/** Longest expense description. */
export const PROJECT_EXPENSE_DESCRIPTION_MAX_LENGTH = 1_000
/** Longest decision note. */
export const PROJECT_EXPENSE_NOTE_MAX_LENGTH = 1_000
/** Most receipt files one expense may name. */
export const PROJECT_EXPENSE_RECEIPTS_MAX = 5
/** Longest receipt File ID or Work Item ID. */
export const PROJECT_EXPENSE_REFERENCE_ID_MAX_LENGTH = 128
/** Most expenses one Project may hold. */
export const PROJECT_EXPENSES_MAX_ENTRIES = 2_000
/** Largest amount of one expense in minor currency units, kept far below 2^53 so sums stay exact. */
export const PROJECT_EXPENSE_AMOUNT_MAX_MINOR = 1_000_000_000_000

/** A Project manager's decision on an expense. */
export type ProjectExpenseDecision = {
  /** Whether the expense was approved or rejected. */
  outcome: ProjectExpenseDecisionOutcome
  /** Member key of the deciding Project manager. */
  decidedByMemberId: string
  /** ISO timestamp of the decision. */
  decidedAt: string
  /** Reason the manager gave, such as why it was rejected. */
  note?: string
}

/** One expense recorded on a Project. */
export type ProjectExpense = {
  /** Expense ID, unique within the Project. */
  id: string
  /** Team that owns the Project. */
  teamId: string
  /** Project the expense is charged to. */
  projectId: string
  /** Local date the cost was incurred, `YYYY-MM-DD`. */
  date: string
  /** Account the cost belongs to, such as `外注費`. */
  category: string
  /** Amount in minor currency units, a positive integer. */
  amountMinor: number
  /** ISO 4217 currency of the amount. */
  currency: string
  /** What the cost was for. */
  description?: string
  /** Work Item of the Project the cost belongs to, if any. */
  workItemId?: string
  /** File IDs of receipts uploaded to the Project's files, in the order given. */
  receiptFileIds: string[]
  /** Approval state; only `approved` expenses count toward the budget. */
  status: ProjectExpenseStatus
  /** Member key of the Project manager who submitted the expense or last resubmitted it. */
  submittedByMemberId: string
  /** ISO timestamp of the latest submission. */
  submittedAt: string
  /** Decision on the latest submission; absent while it waits for one. */
  decision?: ProjectExpenseDecision
  /** Optimistic concurrency revision, starting at 1. */
  revision: number
  /** ISO timestamp of the creation. */
  createdAt: string
  /** ISO timestamp of the last change. */
  updatedAt: string
}

/** Editable fields of an expense, as a create or update request sends them. */
export type ProjectExpenseInput = {
  /** Local date the cost was incurred, `YYYY-MM-DD`. */
  date: string
  /** Account the cost belongs to. */
  category: string
  /** Amount in minor currency units, a positive integer. */
  amountMinor: number
  /** ISO 4217 currency, three upper-case letters. */
  currency: string
  /** What the cost was for. */
  description?: string
  /** Work Item of the Project the cost belongs to. */
  workItemId?: string
  /** File IDs of receipts in the Project's files. */
  receiptFileIds?: string[]
}

/** Body of `POST /api/teams/:teamId/projects/:projectId/expenses`. */
export type CreateProjectExpenseRequest = ProjectExpenseInput

/** Body of `PUT /api/teams/:teamId/projects/:projectId/expenses/:expenseId`; resubmits the expense. */
export type UpdateProjectExpenseRequest = ProjectExpenseInput & {
  /** Revision the client read. */
  expectedRevision: number
}

/** Body of `POST /api/teams/:teamId/projects/:projectId/expenses/:expenseId/decision`. */
export type DecideProjectExpenseRequest = {
  /** Approve or reject. */
  outcome: ProjectExpenseDecisionOutcome
  /** Reason, such as why the expense is rejected. */
  note?: string
  /** Revision the client read. */
  expectedRevision: number
}

/** Body of `DELETE /api/teams/:teamId/projects/:projectId/expenses/:expenseId`. */
export type DeleteProjectExpenseRequest = {
  /** Revision the client read. */
  expectedRevision: number
}

/** Response of `GET /api/teams/:teamId/projects/:projectId/expenses`. */
export type ProjectExpenseListResponse = {
  /** Team that owns the Project. */
  teamId: string
  /** Project the expenses belong to. */
  projectId: string
  /** Every expense of the Project, newest date first. */
  expenses: ProjectExpense[]
  /** Member key of the caller, so the client can tell which expenses the caller may not decide. */
  viewerMemberId: string
}

/** Response of an expense create, update, or decision. */
export type ProjectExpenseResponse = {
  /** The stored expense. */
  expense: ProjectExpense
}

/** Result of parsing an expense input. */
export type ProjectExpenseInputParseResult =
  | {
    /** Parsing succeeded. */
    ok: true
    /** Normalized input. */
    value: ProjectExpenseInput
  }
  | {
    /** Parsing failed. */
    ok: false
    /** Explanation of the first invalid field. */
    message: string
  }

/** Result of parsing a decision request. */
export type DecideProjectExpenseParseResult =
  | {
    /** Parsing succeeded. */
    ok: true
    /** Normalized request. */
    value: DecideProjectExpenseRequest
  }
  | {
    /** Parsing failed. */
    ok: false
    /** Explanation of the first invalid field. */
    message: string
  }

/** Pattern of a `YYYY-MM-DD` date. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
/** Pattern of an ISO 4217 currency code. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/u
/** UTC ISO 8601 timestamp, such as `2026-11-20T08:00:00.000Z`. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u
/** Characters an identifier may hold. */
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9._:~-]+$/u
/** Control characters other than tab, line feed, and carriage return. */
// eslint-disable-next-line no-control-regex -- these control characters are what the check rejects.
const DISALLOWED_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
/** A UTF-16 surrogate without its pair. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Checks whether a value is a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether a value is a real calendar date in `YYYY-MM-DD`.
 *
 * @param value - Value to check.
 * @returns Whether the value is a valid date string.
 */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Checks whether a value is a UTC ISO 8601 timestamp.
 *
 * @param value - Value to check.
 * @returns Whether the value is a valid timestamp string.
 */
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
}

/**
 * Checks whether text holds no control character other than tab and line breaks and no
 * unpaired surrogate.
 *
 * @param text - Text to check.
 * @returns Whether the text may be stored.
 */
function hasStorableCharacters(text: string): boolean {
  return !DISALLOWED_CONTROL_CHARACTER.test(text) && !LONE_SURROGATE.test(text)
}

/**
 * Reads an optional text field, trimming it and treating an empty string as absent.
 *
 * @param value - Raw field value.
 * @param maxLength - Longest allowed text.
 * @returns The trimmed text, `undefined` when absent, or `null` when invalid.
 */
function readOptionalText(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return undefined
  return text.length <= maxLength && hasStorableCharacters(text) ? text : null
}

/**
 * Checks whether a value is an identifier a receipt or Work Item reference may use.
 *
 * @param value - Value to check.
 * @returns Whether the value is a valid identifier.
 */
function isReferenceId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PROJECT_EXPENSE_REFERENCE_ID_MAX_LENGTH &&
    REFERENCE_ID_PATTERN.test(value)
}

/**
 * Reads the receipt File IDs, trimming each and dropping repeats.
 *
 * @param value - Raw field value.
 * @returns The IDs in the order given, or `null` when invalid.
 */
function readReceiptFileIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const item of value) {
    const id = typeof item === 'string' ? item.trim() : item
    if (!isReferenceId(id)) return null
    if (!ids.includes(id)) ids.push(id)
  }
  return ids.length <= PROJECT_EXPENSE_RECEIPTS_MAX ? ids : null
}

/**
 * Checks whether a value is a valid expense amount.
 *
 * @param value - Value to check.
 * @returns Whether it is a positive safe integer within the limit.
 */
function isAmountMinor(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= PROJECT_EXPENSE_AMOUNT_MAX_MINOR
}

/**
 * Checks whether a value is a Project expense status.
 *
 * @param value - Value to check.
 * @returns Whether the value is a known status.
 */
export function isProjectExpenseStatus(value: unknown): value is ProjectExpenseStatus {
  return value === 'submitted' || value === 'approved' || value === 'rejected'
}

/**
 * Validates and normalizes the editable fields of an expense.
 *
 * @param value - Raw request body.
 * @returns The normalized input, or the first problem found.
 */
export function parseProjectExpenseInput(value: unknown): ProjectExpenseInputParseResult {
  if (!isRecord(value)) return { ok: false, message: 'Expense must be an object.' }
  const { date, category, amountMinor, currency, description, workItemId, receiptFileIds } = value
  if (!isCalendarDate(date)) return { ok: false, message: 'Expense date must be a date in YYYY-MM-DD.' }
  const normalizedCategory = readOptionalText(category, PROJECT_EXPENSE_CATEGORY_MAX_LENGTH)
  if (normalizedCategory === undefined || normalizedCategory === null) {
    return { ok: false, message: `Expense category is required, at most ${PROJECT_EXPENSE_CATEGORY_MAX_LENGTH} characters without control characters.` }
  }
  if (!isAmountMinor(amountMinor)) {
    return { ok: false, message: `Expense amount must be a positive integer in minor units of at most ${PROJECT_EXPENSE_AMOUNT_MAX_MINOR}.` }
  }
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    return { ok: false, message: 'Expense currency must be an ISO 4217 code such as JPY.' }
  }
  const normalizedDescription = readOptionalText(description, PROJECT_EXPENSE_DESCRIPTION_MAX_LENGTH)
  if (normalizedDescription === null) {
    return { ok: false, message: `Expense description must be text of at most ${PROJECT_EXPENSE_DESCRIPTION_MAX_LENGTH} characters without control characters.` }
  }
  const normalizedWorkItemId = typeof workItemId === 'string' ? workItemId.trim() : workItemId
  if (normalizedWorkItemId !== undefined && normalizedWorkItemId !== null && normalizedWorkItemId !== '' && !isReferenceId(normalizedWorkItemId)) {
    return { ok: false, message: 'Expense Work Item must be a Work Item ID.' }
  }
  const receipts = readReceiptFileIds(receiptFileIds)
  if (receipts === null) {
    return { ok: false, message: `Expense receipts must be a list of at most ${PROJECT_EXPENSE_RECEIPTS_MAX} File IDs.` }
  }
  return {
    ok: true,
    value: {
      date,
      category: normalizedCategory,
      amountMinor,
      currency,
      ...(normalizedDescription === undefined ? {} : { description: normalizedDescription }),
      ...(isReferenceId(normalizedWorkItemId) ? { workItemId: normalizedWorkItemId } : {}),
      receiptFileIds: receipts,
    },
  }
}

/**
 * Validates and normalizes a decision request.
 *
 * @param value - Raw request body.
 * @returns The normalized request, or the first problem found.
 */
export function parseDecideProjectExpenseRequest(value: unknown): DecideProjectExpenseParseResult {
  if (!isRecord(value)) return { ok: false, message: 'Decision must be an object.' }
  const { outcome, note, expectedRevision } = value
  if (outcome !== 'approved' && outcome !== 'rejected') {
    return { ok: false, message: 'Decision outcome must be approved or rejected.' }
  }
  const normalizedNote = readOptionalText(note, PROJECT_EXPENSE_NOTE_MAX_LENGTH)
  if (normalizedNote === null) {
    return { ok: false, message: `Decision note must be text of at most ${PROJECT_EXPENSE_NOTE_MAX_LENGTH} characters without control characters.` }
  }
  if (!isProjectExpenseRevision(expectedRevision)) return { ok: false, message: 'expectedRevision must be a positive integer.' }
  return {
    ok: true,
    value: { outcome, ...(normalizedNote === undefined ? {} : { note: normalizedNote }), expectedRevision },
  }
}

/**
 * Checks whether a value is a stored revision.
 *
 * @param value - Value to check.
 * @returns Whether it is a positive safe integer.
 */
export function isProjectExpenseRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * Validates a stored or received expense.
 *
 * @param value - Raw value.
 * @returns The expense, or `undefined` when any field is invalid.
 */
export function parseProjectExpense(value: unknown): ProjectExpense | undefined {
  if (!isRecord(value)) return undefined
  const input = parseProjectExpenseInput(value)
  if (!input.ok) return undefined
  const { id, teamId, projectId, status, submittedByMemberId, submittedAt, decision, revision, createdAt, updatedAt } = value
  if (!isReferenceId(id) || typeof teamId !== 'string' || teamId.length === 0 || typeof projectId !== 'string' || projectId.length === 0) {
    return undefined
  }
  if (!isProjectExpenseStatus(status) || typeof submittedByMemberId !== 'string' || submittedByMemberId.length === 0) return undefined
  if (!isTimestamp(submittedAt) || !isTimestamp(createdAt) || !isTimestamp(updatedAt) || !isProjectExpenseRevision(revision)) return undefined
  // Only the receipts the stored row names count; a row never holds an absent list.
  if (!Array.isArray(value.receiptFileIds)) return undefined
  const parsedDecision = decision === undefined ? undefined : parseDecision(decision)
  if (parsedDecision === null) return undefined
  // A submitted expense has no decision, and a decided one records the decision that set it.
  if (status === 'submitted' ? parsedDecision !== undefined : parsedDecision?.outcome !== status) return undefined
  return {
    id,
    teamId,
    projectId,
    ...input.value,
    receiptFileIds: input.value.receiptFileIds ?? [],
    status,
    submittedByMemberId,
    submittedAt,
    ...(parsedDecision === undefined ? {} : { decision: parsedDecision }),
    revision,
    createdAt,
    updatedAt,
  }
}

/**
 * Validates a stored decision.
 *
 * @param value - Raw value.
 * @returns The decision, or `null` when invalid.
 */
function parseDecision(value: unknown): ProjectExpenseDecision | null {
  if (!isRecord(value)) return null
  const { outcome, decidedByMemberId, decidedAt, note } = value
  if (outcome !== 'approved' && outcome !== 'rejected') return null
  if (typeof decidedByMemberId !== 'string' || decidedByMemberId.length === 0 || !isTimestamp(decidedAt)) return null
  const normalizedNote = readOptionalText(note, PROJECT_EXPENSE_NOTE_MAX_LENGTH)
  if (normalizedNote === null) return null
  return { outcome, decidedByMemberId, decidedAt, ...(normalizedNote === undefined ? {} : { note: normalizedNote }) }
}
