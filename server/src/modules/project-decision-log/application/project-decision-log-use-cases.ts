import {
  compareProjectDecisionEntries,
  parseProjectDecisionEntryInput,
  teamDecisionLogItemMatches,
  TEAM_DECISION_LOG_MAX_ITEMS,
  TEAM_DECISION_LOG_QUERY_MAX_LENGTH,
  type ProjectDecisionEntry,
  type ProjectDecisionEntryInput,
  type ProjectDecisionEntryResponse,
  type ProjectDecisionLogViewerCapabilities,
  type ProjectDecisionLogResponse,
  type ProjectDecisionOrigin,
  type ProjectRaidEntry,
  type TeamDecisionLogItem,
  type TeamDecisionLogResponse,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../directory'

/** How far ahead of the server clock a decision time may be, to allow for client clock skew. */
const DECIDED_AT_MAX_SKEW_MS = 24 * 60 * 60 * 1000

/** Team and Project of one decision log request, after the route authorized it. */
export type ProjectDecisionLogScope = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project whose log is read or changed. */
  projectId: string
}

/** Commit-time inputs shared by every decision mutation. */
export type ProjectDecisionLogMutation<TCallerCheck, TAudit> = {
  /** Mutation time as an ISO timestamp. */
  now: string
  /** Server-built conditions that fail the write when the caller lost access. */
  callerAuthorization: readonly TCallerCheck[]
  /** Audit context of the request, recorded in the same transaction. */
  auditContext: TAudit
}

/** Member and Work Item references a decision gains in one change, which the route must verify. */
export type ProjectDecisionEntryReferences = {
  /** Deciders the change adds; ones the decision already names are not checked again. */
  addedDeciderMemberIds: string[]
  /** Related Work Items the change adds; ones the decision already names are not checked again. */
  addedWorkItemIds: string[]
}

/**
 * Verifies the references a decision gains, so a decision cannot name someone outside the
 * Project or a Work Item of another Project.
 *
 * @param references - Added deciders and Work Items.
 * @returns Extra commit-time fences, such as ones proving the Work Items stay in the Project.
 * @throws ProjectDataError 400 when a reference is not allowed.
 */
export type ProjectDecisionEntryReferenceVerifier<TCallerCheck> = (
  references: ProjectDecisionEntryReferences,
) => Promise<readonly TCallerCheck[]>

/** Input of one decision creation, as the persistence port receives it. */
export type CreateProjectDecisionEntryStoreInput<TCallerCheck, TAudit> = ProjectDecisionLogScope &
  ProjectDecisionLogMutation<TCallerCheck, TAudit> & {
    /** Complete decision to store. */
    entry: ProjectDecisionEntry
    /** Fingerprint of the creating request, so a retried request returns the same decision. */
    creationFingerprint: string
  }

/** Input of one decision replacement, as the persistence port receives it. */
export type UpdateProjectDecisionEntryStoreInput<TCallerCheck, TAudit> = ProjectDecisionLogScope &
  ProjectDecisionLogMutation<TCallerCheck, TAudit> & {
    /** Decision read before the change; its revision guards the write. */
    previous: ProjectDecisionEntry
    /** Decision to store. */
    next: ProjectDecisionEntry
    /** Receipt of this update request, stored so a retried request is recognized. */
    updateReceipt: string
    /** Key of this update request without its content, stored so a reused key is recognized. */
    updateKey: string
  }

/** One stored decision with the receipt of the update that produced its current revision. */
export type ProjectDecisionEntryRecord = {
  /** The decision. */
  entry: ProjectDecisionEntry
  /** Receipt of the update that produced this revision; absent until the first update. */
  lastUpdateReceipt?: string
  /** Key of the update that produced this revision; absent until the first update. */
  lastUpdateKey?: string
}

/** One decision read across a Team, with the Project it belongs to. */
export type TeamProjectDecisionEntry = {
  /** Project the decision belongs to. */
  projectId: string
  /** The decision. */
  entry: ProjectDecisionEntry
}

/** Persistence port of Project decision logs. */
export type ProjectDecisionLogStore<TCallerCheck, TAudit> = {
  /**
   * Reads every decision of a Project log.
   *
   * @param scope - Team and Project.
   * @returns Every stored decision in any order.
   */
  list(scope: ProjectDecisionLogScope): Promise<ProjectDecisionEntry[]>
  /**
   * Reads every decision of the Team's Projects, eventually consistent.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team whose Projects are read.
   * @returns Every stored decision with its Project, in any order.
   */
  listTeam(workspaceId: string, teamId: string): Promise<TeamProjectDecisionEntry[]>
  /**
   * Reads one decision with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param entryId - Entry ID.
   * @returns The decision and its last update receipt, or `null` when it does not exist.
   */
  get(scope: ProjectDecisionLogScope, entryId: string): Promise<ProjectDecisionEntryRecord | null>
  /**
   * Adds a decision, refusing it when the log is full.
   *
   * @param input - Creation input.
   * @returns The stored decision, or the decision an earlier identical request stored.
   */
  create(input: CreateProjectDecisionEntryStoreInput<TCallerCheck, TAudit>): Promise<ProjectDecisionEntry>
  /**
   * Replaces a decision when it still has the previous revision.
   *
   * @param input - Replacement input.
   * @returns The stored decision.
   */
  update(input: UpdateProjectDecisionEntryStoreInput<TCallerCheck, TAudit>): Promise<ProjectDecisionEntry>
}

/**
 * Reads a Project decision log, newest decision first.
 *
 * @param store - Log persistence.
 * @param scope - Authorized Team and Project.
 * @param viewer - What the caller may do, decided by the route.
 * @returns The log response.
 */
export async function readProjectDecisionLogUseCase<TCallerCheck, TAudit>(
  store: ProjectDecisionLogStore<TCallerCheck, TAudit>,
  scope: ProjectDecisionLogScope,
  viewer: ProjectDecisionLogViewerCapabilities,
): Promise<ProjectDecisionLogResponse> {
  const entries = await store.list(scope)
  entries.sort(compareProjectDecisionEntries)
  return { teamId: scope.teamId, projectId: scope.projectId, entries, viewer }
}

/** Mutation inputs of a decision creation. */
export type CreateProjectDecisionMutation<TCallerCheck, TAudit> = ProjectDecisionLogMutation<TCallerCheck, TAudit> & {
  /** Entry ID derived from the request's idempotency key. */
  entryId: string
  /** Fingerprint of the request method, path, and body. */
  creationFingerprint: string
  /** Member key of the caller, kept as the recorder. */
  recorderMemberId: string
  /** Verifies the deciders and Work Items the decision names. */
  verifyReferences: ProjectDecisionEntryReferenceVerifier<TCallerCheck>
  /**
   * Origin the server sets instead of the body's, such as `slack` for the Slack shortcut. Without
   * it the body may name only a Mukuroji screen.
   */
  origin?: ProjectDecisionOrigin
}

/**
 * Records one decision in a Project log.
 *
 * @param store - Log persistence.
 * @param scope - Authorized Team and Project.
 * @param body - Untrusted request body with the decision under `entry`.
 * @param mutation - Mutation time, caller fences, audit context, entry ID, and request fingerprint.
 * @returns The stored decision.
 * @throws ProjectDataError 400 when the body is invalid, 409 for a reused Idempotency-Key, and
 * 413 when the log is full.
 */
export async function createProjectDecisionEntryUseCase<TCallerCheck, TAudit>(
  store: ProjectDecisionLogStore<TCallerCheck, TAudit>,
  scope: ProjectDecisionLogScope,
  body: unknown,
  mutation: CreateProjectDecisionMutation<TCallerCheck, TAudit>,
): Promise<ProjectDecisionEntryResponse> {
  const input = readEntryInput(isRecord(body) ? body.entry : undefined, mutation.now, mutation.origin)
  // A retry of a committed creation is answered by the store from the stored decision, so its
  // references are not verified again; a decider who left the Project since then must not turn
  // the retry into an error.
  const alreadyCreated = await store.get(scope, mutation.entryId) !== null
  if (!alreadyCreated) await requireReplacement(store, scope, mutation.entryId, input)
  const referenceChecks = alreadyCreated ? [] : await mutation.verifyReferences({
    addedDeciderMemberIds: input.deciderMemberIds ?? [],
    addedWorkItemIds: input.relatedWorkItemIds ?? [],
  })
  const entry: ProjectDecisionEntry = {
    id: mutation.entryId,
    ...input,
    recordedByMemberId: mutation.recorderMemberId,
    revision: 1,
    createdAt: mutation.now,
    updatedAt: mutation.now,
  }
  const stored = await store.create({
    ...scope,
    now: mutation.now,
    callerAuthorization: [...mutation.callerAuthorization, ...referenceChecks],
    auditContext: mutation.auditContext,
    entry,
    creationFingerprint: mutation.creationFingerprint,
  })
  return { teamId: scope.teamId, projectId: scope.projectId, entry: stored }
}

/** Mutation inputs of a decision replacement. */
export type UpdateProjectDecisionMutation<TCallerCheck, TAudit> = ProjectDecisionLogMutation<TCallerCheck, TAudit> & {
  /** Receipt of this update request. */
  updateReceipt: string
  /** Key of this update request without its content. */
  updateKey: string
  /** Verifies the deciders and Work Items the change adds. */
  verifyReferences: ProjectDecisionEntryReferenceVerifier<TCallerCheck>
}

/**
 * Replaces the editable fields of one decision; superseding and withdrawing are status changes.
 * The origin and the recorder stay as they were recorded.
 *
 * @param store - Log persistence.
 * @param scope - Authorized Team and Project.
 * @param entryId - Decision to change.
 * @param body - Untrusted request body with `expectedRevision` and the decision under `entry`.
 * @param mutation - Mutation time, caller fences, audit context, and the request's update receipt.
 * @returns The stored decision, or the current decision when this same request was already applied.
 * @throws ProjectDataError 400 for an invalid body, 404 for an unknown decision, and 409 for a
 * stale revision or a reused Idempotency-Key.
 */
export async function updateProjectDecisionEntryUseCase<TCallerCheck, TAudit>(
  store: ProjectDecisionLogStore<TCallerCheck, TAudit>,
  scope: ProjectDecisionLogScope,
  entryId: string,
  body: unknown,
  mutation: UpdateProjectDecisionMutation<TCallerCheck, TAudit>,
): Promise<ProjectDecisionEntryResponse> {
  const expectedRevision = isRecord(body) ? body.expectedRevision : undefined
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ProjectDataError(400, 'InvalidProjectDecisionEntry', 'expectedRevision must be a positive integer.')
  }
  const record = await store.get(scope, entryId)
  if (!record) throw new ProjectDataError(404, 'ProjectDecisionEntryNotFound', 'The decision was not found.')
  const previous = record.entry
  // The stored origin is kept, so the body's origin is checked as if it were that one.
  const input = readEntryInput(isRecord(body) ? body.entry : undefined, mutation.now, previous.origin)
  if (previous.revision === expectedRevision + 1 && record.lastUpdateReceipt === mutation.updateReceipt) {
    // The same request already produced the current revision, and only its response was lost.
    return { teamId: scope.teamId, projectId: scope.projectId, entry: previous }
  }
  if (record.lastUpdateKey === mutation.updateKey && record.lastUpdateReceipt !== mutation.updateReceipt) {
    throw new ProjectDataError(409, 'ProjectDecisionEntryIdempotencyConflict', 'This Idempotency-Key was already used for another change.')
  }
  if (previous.revision !== expectedRevision) {
    throw new ProjectDataError(409, 'ProjectDecisionEntryConflict', 'The decision changed. Reload and try again.')
  }
  if (input.supersededByEntryId !== previous.supersededByEntryId) {
    await requireReplacement(store, scope, entryId, input)
  }
  const previousDeciders = new Set(previous.deciderMemberIds ?? [])
  const previousWorkItems = new Set(previous.relatedWorkItemIds ?? [])
  const referenceChecks = await mutation.verifyReferences({
    addedDeciderMemberIds: (input.deciderMemberIds ?? []).filter((id) => !previousDeciders.has(id)),
    addedWorkItemIds: (input.relatedWorkItemIds ?? []).filter((id) => !previousWorkItems.has(id)),
  })
  const next: ProjectDecisionEntry = {
    id: previous.id,
    ...input,
    origin: previous.origin,
    recordedByMemberId: previous.recordedByMemberId,
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
  return { teamId: scope.teamId, projectId: scope.projectId, entry: stored }
}

/** Filters of the Team decision log. */
export type TeamDecisionLogFilters = {
  /** Keyword matched against titles and free text, ignoring case. */
  keyword?: string
  /** Project to narrow to; it must be one of the visible Projects. */
  projectId?: string
}

/** Reads the decided change requests of one Project, as the Team log merges them. */
export type DecidedChangeRequestReader = (projectId: string) => Promise<ProjectRaidEntry[]>

/**
 * Reads the decisions of every Project of a Team the caller may see, merged with the change
 * requests approved or rejected in those Projects, newest decision first.
 *
 * @param store - Decision log persistence.
 * @param scope - Workspace, Team, and the Projects of the Team the caller may see.
 * @param filters - Untrusted keyword and Project filters.
 * @param readDecidedChangeRequests - Reads the decided change requests of one visible Project.
 * @returns At most {@link TEAM_DECISION_LOG_MAX_ITEMS} items and whether more matched.
 * @throws ProjectDataError 400 for a keyword that is too long.
 */
export async function readTeamDecisionLogUseCase<TCallerCheck, TAudit>(
  store: ProjectDecisionLogStore<TCallerCheck, TAudit>,
  scope: { workspaceId: string; teamId: string; visibleProjectIds: readonly string[] },
  filters: TeamDecisionLogFilters,
  readDecidedChangeRequests: DecidedChangeRequestReader,
): Promise<TeamDecisionLogResponse> {
  const keyword = (filters.keyword ?? '').trim()
  if (keyword.length > TEAM_DECISION_LOG_QUERY_MAX_LENGTH) {
    throw new ProjectDataError(400, 'InvalidTeamDecisionLogQuery', `The keyword must be at most ${TEAM_DECISION_LOG_QUERY_MAX_LENGTH} characters.`)
  }
  const visible = new Set(filters.projectId === undefined
    ? scope.visibleProjectIds
    : scope.visibleProjectIds.filter((id) => id === filters.projectId))
  const items: TeamDecisionLogItem[] = []
  if (visible.size > 0) {
    for (const { projectId, entry } of await store.listTeam(scope.workspaceId, scope.teamId)) {
      if (visible.has(projectId)) items.push({ kind: 'decision', projectId, decidedAt: entry.decidedAt, entry })
    }
    const changeRequests = await Promise.all([...visible].map(async (projectId) => ({
      projectId,
      entries: await readDecidedChangeRequests(projectId),
    })))
    for (const { projectId, entries } of changeRequests) {
      for (const entry of entries) {
        if (entry.decision) items.push({ kind: 'change-request', projectId, decidedAt: entry.decision.decidedAt, entry })
      }
    }
  }
  const matching = items.filter((item) => teamDecisionLogItemMatches(item, keyword))
  matching.sort((left, right) =>
    right.decidedAt.localeCompare(left.decidedAt) ||
    left.projectId.localeCompare(right.projectId) ||
    left.entry.id.localeCompare(right.entry.id))
  return {
    teamId: scope.teamId,
    items: matching.slice(0, TEAM_DECISION_LOG_MAX_ITEMS),
    truncated: matching.length > TEAM_DECISION_LOG_MAX_ITEMS,
  }
}

/**
 * Requires the decision a superseded decision names to be another decision of the same log.
 *
 * @param store - Log persistence.
 * @param scope - Team and Project.
 * @param entryId - Decision being saved.
 * @param input - Normalized input.
 * @throws ProjectDataError 400 when the named decision is this one or not in the log.
 */
async function requireReplacement<TCallerCheck, TAudit>(
  store: ProjectDecisionLogStore<TCallerCheck, TAudit>,
  scope: ProjectDecisionLogScope,
  entryId: string,
  input: ProjectDecisionEntryInput,
) {
  const replacementId = input.supersededByEntryId
  if (replacementId === undefined) return
  if (replacementId === entryId || await store.get(scope, replacementId) === null) {
    throw new ProjectDataError(400, 'InvalidProjectDecisionEntry', 'The replacing decision must be another decision of this Project.')
  }
}

/**
 * Validates untrusted decision input against the server clock and the allowed origin.
 *
 * @param value - The `entry` field of a request body.
 * @param now - Server time as an ISO timestamp.
 * @param serverOrigin - Origin the server decides; without it only Mukuroji screens are allowed.
 * @returns The normalized input, carrying the server origin when one is given.
 * @throws ProjectDataError 400 when the input is invalid.
 */
function readEntryInput(value: unknown, now: string, serverOrigin: ProjectDecisionOrigin | undefined): ProjectDecisionEntryInput {
  const parsed = parseProjectDecisionEntryInput(
    isRecord(value) && serverOrigin !== undefined ? { ...value, origin: serverOrigin } : value,
  )
  if (!parsed.ok) throw new ProjectDataError(400, 'InvalidProjectDecisionEntry', parsed.message)
  if (serverOrigin === undefined && parsed.value.origin === 'slack') {
    throw new ProjectDataError(400, 'InvalidProjectDecisionEntry', 'Only the Slack shortcut records a decision from Slack.')
  }
  if (Date.parse(parsed.value.decidedAt) > Date.parse(now) + DECIDED_AT_MAX_SKEW_MS) {
    throw new ProjectDataError(400, 'InvalidProjectDecisionEntry', 'decidedAt must not be in the future.')
  }
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
