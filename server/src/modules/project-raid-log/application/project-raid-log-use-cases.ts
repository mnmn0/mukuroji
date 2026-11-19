import {
  parseProjectRaidEntryInput,
  type ProjectRaidEntry,
  type ProjectRaidEntryResponse,
  type ProjectRaidLogResponse,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../directory'

/** Team and Project of one log request, after the route authorized it. */
export type ProjectRaidLogScope = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project whose log is read or changed. */
  projectId: string
}

/** Commit-time inputs shared by every log mutation. */
export type ProjectRaidLogMutation<TCallerCheck, TAudit> = {
  /** Mutation time as an ISO timestamp. */
  now: string
  /** Server-built conditions that fail the write when the caller lost access. */
  callerAuthorization: readonly TCallerCheck[]
  /** Audit context of the request, recorded in the same transaction. */
  auditContext: TAudit
}

/** Input of one entry creation, as the persistence port receives it. */
export type CreateProjectRaidEntryStoreInput<TCallerCheck, TAudit> = ProjectRaidLogScope &
  ProjectRaidLogMutation<TCallerCheck, TAudit> & {
    /** Complete entry to store. */
    entry: ProjectRaidEntry
    /** Fingerprint of the creating request, so a retried request returns the same entry. */
    creationFingerprint: string
  }

/** Input of one entry replacement, as the persistence port receives it. */
export type UpdateProjectRaidEntryStoreInput<TCallerCheck, TAudit> = ProjectRaidLogScope &
  ProjectRaidLogMutation<TCallerCheck, TAudit> & {
    /** Entry read before the change; its revision guards the write. */
    previous: ProjectRaidEntry
    /** Entry to store. */
    next: ProjectRaidEntry
    /** Receipt of this update request, stored with the entry so a retried request is recognized. */
    updateReceipt: string
  }

/** One stored entry with the receipt of the update that produced its current revision. */
export type ProjectRaidEntryRecord = {
  /** The entry. */
  entry: ProjectRaidEntry
  /** Receipt of the update that produced this revision; absent until the first update. */
  lastUpdateReceipt?: string
}

/** Persistence port of Project risk, issue, and change request logs. */
export type ProjectRaidLogStore<TCallerCheck, TAudit> = {
  /**
   * Reads every entry of a Project log.
   *
   * @param scope - Team and Project.
   * @returns Every stored entry in any order.
   */
  list(scope: ProjectRaidLogScope): Promise<ProjectRaidEntry[]>
  /**
   * Reads one entry with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param entryId - Entry ID.
   * @returns The entry and its last update receipt, or `null` when it does not exist.
   */
  get(scope: ProjectRaidLogScope, entryId: string): Promise<ProjectRaidEntryRecord | null>
  /**
   * Adds an entry, refusing it when the log is full.
   *
   * @param input - Creation input.
   * @returns The stored entry, or the entry an earlier identical request stored.
   */
  create(input: CreateProjectRaidEntryStoreInput<TCallerCheck, TAudit>): Promise<ProjectRaidEntry>
  /**
   * Replaces an entry when it still has the previous revision.
   *
   * @param input - Replacement input.
   * @returns The stored entry.
   */
  update(input: UpdateProjectRaidEntryStoreInput<TCallerCheck, TAudit>): Promise<ProjectRaidEntry>
}

/**
 * Reads a Project log, newest entry first.
 *
 * @param store - Log persistence.
 * @param scope - Authorized Team and Project.
 * @returns The log response.
 */
export async function readProjectRaidLogUseCase<TCallerCheck, TAudit>(
  store: ProjectRaidLogStore<TCallerCheck, TAudit>,
  scope: ProjectRaidLogScope,
): Promise<ProjectRaidLogResponse> {
  const entries = await store.list(scope)
  entries.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  return { teamId: scope.teamId, projectId: scope.projectId, entries }
}

/**
 * Adds one entry to a Project log.
 *
 * @param store - Log persistence.
 * @param scope - Authorized Team and Project.
 * @param body - Untrusted request body.
 * @param mutation - Mutation time, caller fences, audit context, entry ID, and request fingerprint.
 * @returns The stored entry.
 * @throws ProjectDataError 400 when the body is invalid.
 */
export async function createProjectRaidEntryUseCase<TCallerCheck, TAudit>(
  store: ProjectRaidLogStore<TCallerCheck, TAudit>,
  scope: ProjectRaidLogScope,
  body: unknown,
  mutation: ProjectRaidLogMutation<TCallerCheck, TAudit> & { entryId: string; creationFingerprint: string },
): Promise<ProjectRaidEntryResponse> {
  const input = readEntryInput(isRecord(body) ? body.entry : undefined)
  const entry: ProjectRaidEntry = {
    id: mutation.entryId,
    ...input,
    revision: 1,
    createdAt: mutation.now,
    updatedAt: mutation.now,
    ...(input.status === 'closed' ? { closedAt: mutation.now } : {}),
  }
  const stored = await store.create({
    ...scope,
    now: mutation.now,
    callerAuthorization: mutation.callerAuthorization,
    auditContext: mutation.auditContext,
    entry,
    creationFingerprint: mutation.creationFingerprint,
  })
  return { teamId: scope.teamId, projectId: scope.projectId, entry: stored }
}

/**
 * Replaces the editable fields of one entry; closing and reopening are status changes.
 *
 * @param store - Log persistence.
 * @param scope - Authorized Team and Project.
 * @param entryId - Entry to change.
 * @param body - Untrusted request body.
 * @param mutation - Mutation time, caller fences, audit context, and the request's update receipt.
 * @returns The stored entry, or the current entry when this same request was already applied.
 * @throws ProjectDataError 400 for an invalid body, 404 for an unknown entry, and 409 for a stale revision.
 */
export async function updateProjectRaidEntryUseCase<TCallerCheck, TAudit>(
  store: ProjectRaidLogStore<TCallerCheck, TAudit>,
  scope: ProjectRaidLogScope,
  entryId: string,
  body: unknown,
  mutation: ProjectRaidLogMutation<TCallerCheck, TAudit> & { updateReceipt: string },
): Promise<ProjectRaidEntryResponse> {
  const expectedRevision = isRecord(body) ? body.expectedRevision : undefined
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ProjectDataError(400, 'InvalidProjectRaidEntry', 'expectedRevision must be a positive integer.')
  }
  const input = readEntryInput(isRecord(body) ? body.entry : undefined)
  const record = await store.get(scope, entryId)
  if (!record) {
    throw new ProjectDataError(404, 'ProjectRaidEntryNotFound', 'The log entry was not found.')
  }
  const previous = record.entry
  if (
    previous.revision === expectedRevision + 1 &&
    record.lastUpdateReceipt === mutation.updateReceipt
  ) {
    // The same request already produced the current revision, and only its response was lost.
    return { teamId: scope.teamId, projectId: scope.projectId, entry: previous }
  }
  if (previous.revision !== expectedRevision) {
    throw new ProjectDataError(409, 'ProjectRaidEntryConflict', 'The log entry changed. Reload and try again.')
  }
  if (previous.kind !== input.kind) {
    throw new ProjectDataError(400, 'InvalidProjectRaidEntry', 'The kind of a log entry cannot change.')
  }
  const closedAt = input.status === 'closed'
    ? (previous.status === 'closed' ? previous.closedAt : mutation.now)
    : undefined
  const next: ProjectRaidEntry = {
    id: previous.id,
    ...input,
    revision: previous.revision + 1,
    createdAt: previous.createdAt,
    updatedAt: mutation.now,
    ...(closedAt === undefined ? {} : { closedAt }),
  }
  const stored = await store.update({ ...scope, ...mutation, previous, next })
  return { teamId: scope.teamId, projectId: scope.projectId, entry: stored }
}

/**
 * Validates untrusted entry input.
 *
 * @param value - The `entry` field of a request body.
 * @returns The normalized input.
 * @throws ProjectDataError 400 when the input is invalid.
 */
function readEntryInput(value: unknown) {
  const parsed = parseProjectRaidEntryInput(value)
  if (!parsed.ok) throw new ProjectDataError(400, 'InvalidProjectRaidEntry', parsed.message)
  return parsed.value
}

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
