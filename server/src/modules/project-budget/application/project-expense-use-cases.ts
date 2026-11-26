import {
  isProjectExpenseRevision,
  parseDecideProjectExpenseRequest,
  parseProjectExpenseInput,
  type ProjectExpense,
  type ProjectExpenseInput,
  type ProjectExpenseListResponse,
  type ProjectExpenseResponse,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../directory'

/** Team and Project of one expense request, after the route authorized the caller as a manager. */
export type ProjectExpenseScope = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project whose expenses are read or changed. */
  projectId: string
}

/** Commit-time inputs shared by every expense mutation. */
export type ProjectExpenseMutation<TCallerCheck, TAudit> = {
  /** Mutation time as an ISO timestamp. */
  now: string
  /** Server-built conditions that fail the write when the caller lost access. */
  callerAuthorization: readonly TCallerCheck[]
  /** Audit context of the request, recorded in the same transaction. */
  auditContext: TAudit
}

/** References an expense gains in one change, which the route must verify. */
export type ProjectExpenseReferences = {
  /** Work Item the change sets or replaces; absent when it stays the same or is cleared. */
  workItemId?: string
  /** Receipt File IDs the change adds; ones the expense already names are not checked again. */
  addedReceiptFileIds: string[]
}

/**
 * Verifies the references an expense gains, so it cannot name a Work Item or a file of another
 * Project.
 *
 * @param references - Work Item and receipts to verify.
 * @returns Extra commit-time fences, such as one proving the Work Item is still in the Project.
 * @throws ProjectDataError 400 when a reference is not allowed.
 */
export type ProjectExpenseReferenceVerifier<TCallerCheck> = (
  references: ProjectExpenseReferences,
) => Promise<readonly TCallerCheck[]>

/** Input of one expense creation, as the persistence port receives it. */
export type CreateProjectExpenseStoreInput<TCallerCheck, TAudit> = ProjectExpenseScope &
  ProjectExpenseMutation<TCallerCheck, TAudit> & {
    /** Complete expense to store. */
    expense: ProjectExpense
    /** Fingerprint of the creating request, so a retried request returns the same expense. */
    creationFingerprint: string
  }

/** Input of one expense replacement, as the persistence port receives it. */
export type UpdateProjectExpenseStoreInput<TCallerCheck, TAudit> = ProjectExpenseScope &
  ProjectExpenseMutation<TCallerCheck, TAudit> & {
    /** Expense read before the change; its revision guards the write. */
    previous: ProjectExpense
    /** Expense to store. */
    next: ProjectExpense
    /** Receipt of this request, stored with the expense so a retried request is recognized. */
    updateReceipt: string
    /** Key of this request without its content, stored so a reused key is recognized. */
    updateKey: string
  }

/** Input of one expense removal, as the persistence port receives it. */
export type DeleteProjectExpenseStoreInput<TCallerCheck, TAudit> = ProjectExpenseScope &
  ProjectExpenseDeleteMutation<TCallerCheck, TAudit> & {
    /** Expense read before the removal; its revision guards the delete. */
    previous: ProjectExpense
  }

/** Mutation context of a removal, with the receipt that lets a retry find the removal it made. */
export type ProjectExpenseDeleteMutation<TCallerCheck, TAudit> = ProjectExpenseMutation<TCallerCheck, TAudit> & {
  /** Receipt of this request, kept after the expense is gone. */
  deleteReceipt: string
}

/** One stored expense with the receipt of the change that produced its current revision. */
export type ProjectExpenseRecord = {
  /** The expense. */
  expense: ProjectExpense
  /** Receipt of the change that produced this revision; absent until the first change. */
  lastUpdateReceipt?: string
  /** Key of the change that produced this revision; absent until the first change. */
  lastUpdateKey?: string
}

/** Persistence port of Project expenses. */
export type ProjectExpenseStore<TCallerCheck, TAudit> = {
  /**
   * Reads every expense of a Project.
   *
   * @param scope - Team and Project.
   * @returns Every stored expense in any order.
   */
  list(scope: ProjectExpenseScope): Promise<ProjectExpense[]>
  /**
   * Reads one expense with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param expenseId - Expense ID.
   * @returns The expense and its last change receipt, or `null` when it does not exist.
   */
  get(scope: ProjectExpenseScope, expenseId: string): Promise<ProjectExpenseRecord | null>
  /**
   * Adds an expense, refusing it when the Project holds the most expenses it may.
   *
   * @param input - Creation input.
   * @returns The stored expense, or the expense an earlier identical request stored.
   */
  create(input: CreateProjectExpenseStoreInput<TCallerCheck, TAudit>): Promise<ProjectExpense>
  /**
   * Replaces an expense when it still has the previous revision.
   *
   * @param input - Replacement input.
   * @returns The stored expense.
   */
  update(input: UpdateProjectExpenseStoreInput<TCallerCheck, TAudit>): Promise<ProjectExpense>
  /**
   * Removes an expense when it still has the previous revision.
   *
   * @param input - Removal input.
   */
  delete(input: DeleteProjectExpenseStoreInput<TCallerCheck, TAudit>): Promise<void>
  /**
   * Tells whether a request with this receipt already removed the expense.
   *
   * @param scope - Team and Project.
   * @param expenseId - Expense ID.
   * @param deleteReceipt - Receipt of the removal request.
   * @returns True when the expense was removed by that request.
   */
  wasDeletedBy(scope: ProjectExpenseScope, expenseId: string, deleteReceipt: string): Promise<boolean>
}

/** Mutation context of a change that records who made it and how its request is recognized. */
export type ProjectExpenseChangeMutation<TCallerCheck, TAudit> = ProjectExpenseMutation<TCallerCheck, TAudit> & {
  /** Receipt of this request. */
  updateReceipt: string
  /** Key of this request without its content. */
  updateKey: string
  /** Member key of the Project manager making the change. */
  actorMemberId: string
}

/**
 * Reads every expense of a Project, newest date first.
 *
 * @param store - Expense persistence.
 * @param scope - Authorized Team and Project.
 * @param viewerMemberId - Member key of the caller.
 * @returns The list response.
 */
export async function listProjectExpensesUseCase<TCallerCheck, TAudit>(
  store: ProjectExpenseStore<TCallerCheck, TAudit>,
  scope: ProjectExpenseScope,
  viewerMemberId: string,
): Promise<ProjectExpenseListResponse> {
  const expenses = await store.list(scope)
  expenses.sort((left, right) =>
    right.date.localeCompare(left.date) ||
    right.createdAt.localeCompare(left.createdAt) ||
    left.id.localeCompare(right.id))
  return { teamId: scope.teamId, projectId: scope.projectId, expenses, viewerMemberId }
}

/**
 * Submits one expense on a Project; it waits for another Project manager's approval.
 *
 * @param store - Expense persistence.
 * @param scope - Authorized Team and Project.
 * @param body - Untrusted request body.
 * @param mutation - Mutation time, caller fences, audit context, expense ID, fingerprint, and submitter.
 * @returns The stored expense.
 * @throws ProjectDataError 400 when the body or a reference is invalid.
 */
export async function createProjectExpenseUseCase<TCallerCheck, TAudit>(
  store: ProjectExpenseStore<TCallerCheck, TAudit>,
  scope: ProjectExpenseScope,
  body: unknown,
  mutation: ProjectExpenseMutation<TCallerCheck, TAudit> & {
    /** Expense ID derived from the request's idempotency key. */
    expenseId: string
    /** Digest of the request, so a reused key with another body is refused. */
    creationFingerprint: string
    /** Member key of the manager submitting the expense. */
    submitterMemberId: string
    /** Checks the Work Item and receipt references against the Project. */
    verifyReferences: ProjectExpenseReferenceVerifier<TCallerCheck>
  },
): Promise<ProjectExpenseResponse> {
  const input = readExpenseInput(body)
  // A retry of a committed creation is answered by the store from the stored expense, so its
  // references are not verified again; a receipt deleted since then must not fail the retry.
  const alreadyCreated = await store.get(scope, mutation.expenseId) !== null
  const referenceChecks = alreadyCreated ? [] : await mutation.verifyReferences({
    ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }),
    addedReceiptFileIds: input.receiptFileIds ?? [],
  })
  const expense: ProjectExpense = {
    id: mutation.expenseId,
    teamId: scope.teamId,
    projectId: scope.projectId,
    ...input,
    receiptFileIds: input.receiptFileIds ?? [],
    status: 'submitted',
    submittedByMemberId: mutation.submitterMemberId,
    submittedAt: mutation.now,
    revision: 1,
    createdAt: mutation.now,
    updatedAt: mutation.now,
  }
  const stored = await store.create({
    ...scope,
    now: mutation.now,
    callerAuthorization: [...mutation.callerAuthorization, ...referenceChecks],
    auditContext: mutation.auditContext,
    expense,
    creationFingerprint: mutation.creationFingerprint,
  })
  return { expense: stored }
}

/**
 * Replaces the fields of a submitted or rejected expense and submits it again, by the caller.
 * An approved expense counts toward the budget and cannot change.
 *
 * @param store - Expense persistence.
 * @param scope - Authorized Team and Project.
 * @param expenseId - Expense to change.
 * @param body - Untrusted request body.
 * @param mutation - Mutation context and reference verification.
 * @returns The stored expense, or the current one when this same request was already applied.
 * @throws ProjectDataError 400 for an invalid body, 404 for an unknown expense, and 409 for a
 * stale revision or an approved expense.
 */
export async function updateProjectExpenseUseCase<TCallerCheck, TAudit>(
  store: ProjectExpenseStore<TCallerCheck, TAudit>,
  scope: ProjectExpenseScope,
  expenseId: string,
  body: unknown,
  mutation: ProjectExpenseChangeMutation<TCallerCheck, TAudit> & {
    /** Checks the Work Item and newly added receipt references against the Project. */
    verifyReferences: ProjectExpenseReferenceVerifier<TCallerCheck>
  },
): Promise<ProjectExpenseResponse> {
  const expectedRevision = readExpectedRevision(body)
  const input = readExpenseInput(body)
  const record = await requireExpense(store, scope, expenseId)
  const replayed = readReplay(record, expectedRevision, mutation)
  if (replayed) return { expense: replayed }
  const previous = record.expense
  if (previous.status === 'approved') {
    throw new ProjectDataError(409, 'ProjectExpenseApproved', 'An approved expense cannot change.')
  }
  const previousReceipts = new Set(previous.receiptFileIds)
  const referenceChecks = await mutation.verifyReferences({
    ...(input.workItemId === undefined || input.workItemId === previous.workItemId ? {} : { workItemId: input.workItemId }),
    addedReceiptFileIds: (input.receiptFileIds ?? []).filter((id) => !previousReceipts.has(id)),
  })
  const next: ProjectExpense = {
    id: previous.id,
    teamId: previous.teamId,
    projectId: previous.projectId,
    ...input,
    receiptFileIds: input.receiptFileIds ?? [],
    status: 'submitted',
    submittedByMemberId: mutation.actorMemberId,
    submittedAt: mutation.now,
    revision: previous.revision + 1,
    createdAt: previous.createdAt,
    updatedAt: mutation.now,
  }
  const stored = await store.update({
    ...scope,
    now: mutation.now,
    callerAuthorization: [...mutation.callerAuthorization, ...referenceChecks],
    auditContext: mutation.auditContext,
    updateReceipt: mutation.updateReceipt,
    updateKey: mutation.updateKey,
    previous,
    next,
  })
  return { expense: stored }
}

/**
 * Approves or rejects a submitted expense. The Project manager who submitted it cannot decide
 * it, so every approved expense was seen by two people.
 *
 * @param store - Expense persistence.
 * @param scope - Authorized Team and Project.
 * @param expenseId - Expense to decide.
 * @param body - Untrusted request body.
 * @param mutation - Mutation context; the actor is the decider.
 * @returns The decided expense, or the current one when this same request was already applied.
 * @throws ProjectDataError 400 for an invalid body, 403 for the submitter, 404 for an unknown
 * expense, and 409 for a stale revision or an expense already decided.
 */
export async function decideProjectExpenseUseCase<TCallerCheck, TAudit>(
  store: ProjectExpenseStore<TCallerCheck, TAudit>,
  scope: ProjectExpenseScope,
  expenseId: string,
  body: unknown,
  mutation: ProjectExpenseChangeMutation<TCallerCheck, TAudit>,
): Promise<ProjectExpenseResponse> {
  const parsed = parseDecideProjectExpenseRequest(body)
  if (!parsed.ok) throw new ProjectDataError(400, 'InvalidProjectExpense', parsed.message)
  const request = parsed.value
  const record = await requireExpense(store, scope, expenseId)
  const replayed = readReplay(record, request.expectedRevision, mutation)
  if (replayed) return { expense: replayed }
  const previous = record.expense
  if (previous.status !== 'submitted') {
    throw new ProjectDataError(409, 'ProjectExpenseDecided', 'The expense was already decided.')
  }
  if (previous.submittedByMemberId === mutation.actorMemberId) {
    throw new ProjectDataError(403, 'ProjectExpenseSelfDecisionForbidden', 'Another Project manager must decide an expense you submitted.')
  }
  const next: ProjectExpense = {
    ...previous,
    status: request.outcome,
    decision: {
      outcome: request.outcome,
      decidedByMemberId: mutation.actorMemberId,
      decidedAt: mutation.now,
      ...(request.note === undefined ? {} : { note: request.note }),
    },
    revision: previous.revision + 1,
    updatedAt: mutation.now,
  }
  const stored = await store.update({
    ...scope,
    now: mutation.now,
    callerAuthorization: mutation.callerAuthorization,
    auditContext: mutation.auditContext,
    updateReceipt: mutation.updateReceipt,
    updateKey: mutation.updateKey,
    previous,
    next,
  })
  return { expense: stored }
}

/**
 * Removes an expense that is not approved.
 *
 * @param store - Expense persistence.
 * @param scope - Authorized Team and Project.
 * @param expenseId - Expense to remove.
 * @param body - Untrusted request body with the expected revision.
 * @param mutation - Mutation time, caller fences, audit context, and removal receipt.
 * @throws ProjectDataError 400 for an invalid body, 404 for an unknown expense, and 409 for a
 * stale revision or an approved expense.
 */
export async function deleteProjectExpenseUseCase<TCallerCheck, TAudit>(
  store: ProjectExpenseStore<TCallerCheck, TAudit>,
  scope: ProjectExpenseScope,
  expenseId: string,
  body: unknown,
  mutation: ProjectExpenseDeleteMutation<TCallerCheck, TAudit>,
): Promise<void> {
  const expectedRevision = readExpectedRevision(body)
  const found = await store.get(scope, expenseId)
  // A retry whose first attempt removed the expense but lost the response succeeds again.
  if (!found) {
    if (await store.wasDeletedBy(scope, expenseId, mutation.deleteReceipt)) return
    throw expenseNotFound()
  }
  const previous = found.expense
  if (previous.revision !== expectedRevision) throw staleExpense()
  if (previous.status === 'approved') {
    throw new ProjectDataError(409, 'ProjectExpenseApproved', 'An approved expense cannot be deleted.')
  }
  await store.delete({ ...scope, ...mutation, previous })
}

/**
 * Reads one expense or answers 404.
 *
 * @param store - Expense persistence.
 * @param scope - Team and Project.
 * @param expenseId - Expense ID.
 * @returns The record.
 * @throws ProjectDataError 404 when the expense does not exist.
 */
async function requireExpense<TCallerCheck, TAudit>(
  store: ProjectExpenseStore<TCallerCheck, TAudit>,
  scope: ProjectExpenseScope,
  expenseId: string,
): Promise<ProjectExpenseRecord> {
  const record = await store.get(scope, expenseId)
  if (!record) throw expenseNotFound()
  return record
}

/**
 * Builds the error of an unknown expense.
 *
 * @returns The 404 error.
 */
function expenseNotFound() {
  return new ProjectDataError(404, 'ProjectExpenseNotFound', 'The expense was not found.')
}

/**
 * Recognizes a retried change and refuses a stale revision or a reused key.
 *
 * @param record - Stored expense with its last change receipt.
 * @param expectedRevision - Revision the request was made against.
 * @param mutation - Receipt and key of the request.
 * @returns The current expense when this same request already produced it, else `undefined`.
 * @throws ProjectDataError 409 for a key reused with other content or a stale revision.
 */
function readReplay(
  record: ProjectExpenseRecord,
  expectedRevision: number,
  mutation: { updateReceipt: string; updateKey: string },
): ProjectExpense | undefined {
  const current = record.expense
  if (current.revision === expectedRevision + 1 && record.lastUpdateReceipt === mutation.updateReceipt) {
    // The same request already produced the current revision, and only its response was lost.
    return current
  }
  if (record.lastUpdateKey === mutation.updateKey && record.lastUpdateReceipt !== mutation.updateReceipt) {
    throw new ProjectDataError(409, 'ProjectExpenseIdempotencyConflict', 'This Idempotency-Key was already used for another change.')
  }
  if (current.revision !== expectedRevision) throw staleExpense()
  return undefined
}

/**
 * Reads and validates the editable expense fields of a request body.
 *
 * @param body - Untrusted body.
 * @returns The normalized input.
 * @throws ProjectDataError 400 when invalid.
 */
function readExpenseInput(body: unknown): ProjectExpenseInput {
  const parsed = parseProjectExpenseInput(body)
  if (!parsed.ok) throw new ProjectDataError(400, 'InvalidProjectExpense', parsed.message)
  return parsed.value
}

/**
 * Reads the expected revision of a request body.
 *
 * @param body - Untrusted body.
 * @returns The revision.
 * @throws ProjectDataError 400 when it is missing or not a positive integer.
 */
function readExpectedRevision(body: unknown): number {
  const value = typeof body === 'object' && body !== null && 'expectedRevision' in body ? body.expectedRevision : undefined
  if (!isProjectExpenseRevision(value)) {
    throw new ProjectDataError(400, 'InvalidProjectExpense', 'expectedRevision must be a positive integer.')
  }
  return value
}

/**
 * Creates the error for an expense that changed since the client read it.
 *
 * @returns The error.
 */
function staleExpense() {
  return new ProjectDataError(409, 'ProjectExpenseConflict', 'The expense changed. Reload and try again.')
}
