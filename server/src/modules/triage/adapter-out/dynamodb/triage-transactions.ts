import { createHash } from 'node:crypto'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type {
  TriageActionInput,
  TriageEntry,
  TriageEntryEvent,
  TriageMergeReceipt,
  TriageWorkItemReference,
} from '@mukuroji/contracts'
import type { MutationAuditContext } from '../../../audit'
import {
  applyTriageAction,
  evaluateTriageSchedule,
  recordTriageSourceActivity,
  TRIAGE_ENTRY_EVENT_LIMIT,
  TriageError,
  type TriageSourceActivity,
} from '../../domain/triage-entry'
import type { TriageIdempotency } from '../../triage'
import {
  createTriageAdmissionAssignmentAuditTransactionItems,
  createTriageAssignmentAuditTransactionItems,
  readTriageNotificationMemberKey,
  type TriageAuditOutboxConfiguration,
} from './triage-audit-events'

/** Default number of deterministic wake partitions used by the schedule index. */
export const DEFAULT_TRIAGE_WAKE_SHARD_COUNT = 8

/** One DynamoDB action that may be composed into a larger atomic write. */
export type TriageTransactionItem = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number]

/** A complete list of triage-owned DynamoDB transaction actions. */
export type TriageTransactionItems = NonNullable<TransactWriteCommandInput['TransactItems']>

/** Creates a condition that fences one observed Team configuration revision.
 *
 * @param tableName Request Intake table containing Team configuration.
 * @param workspaceId Owning Workspace identifier.
 * @param teamId Configured Team identifier.
 * @param expectedRevision Configuration revision observed before the mutation.
 * @returns A DynamoDB condition check that has not been executed.
 */
export function createTriageConfigurationRevisionConditionCheck(
  tableName: string,
  workspaceId: string,
  teamId: string,
  expectedRevision: number,
): TriageTransactionItem {
  const validatedTeamId = requireIdentifier(teamId, 'Team ID')
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TriageError(
      400,
      'InvalidTriageInput',
      'The observed Triage configuration revision is invalid.',
    )
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        scopeKey: createWorkspaceScopeKey(workspaceId),
        recordKey: `TRIAGE_CONFIG#TEAM#${validatedTeamId}`,
      },
      ConditionExpression:
        '(attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)) OR ' +
        '#configuration.#revision = :expectedRevision',
      ExpressionAttributeNames: {
        '#configuration': 'configuration',
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':expectedRevision': expectedRevision,
      },
    },
  }
}

/** The next entry together with transaction actions that have not been executed. */
export type TriageTransactionContribution = {
  /** The canonical entry returned after the combined transaction succeeds. */
  entry: TriageEntry
  /** Triage-owned actions to append to the caller's transaction. */
  transactItems: TriageTransactionItems
}

/** Input for an operation receipt composed by an external owner transaction. */
export type CreateTriageOperationReceiptTransactionPutInput = {
  /** Request Intake table name. */
  tableName: string
  /** Resulting canonical entry returned on replay. */
  entry: TriageEntry
  /** Stable operation namespace. */
  operation: string
  /** Replay protection bound to the semantic input. */
  idempotency: TriageIdempotency
  /** Receipt TTL instant. */
  expiresAt: string
}

/** Input for creating any source-owned triage entry atomically. */
export type CreateTriageEntryTransactionItemsInput = {
  /** Request Intake table name. */
  tableName: string
  /** Fully normalized initial entry. */
  entry: TriageEntry
  /** Fingerprint binding the source identity to its immutable initial payload. */
  inputFingerprint: string
  /** Number of deterministic wake shards configured on the table. */
  wakeShardCount?: number
  /** Optional audit outbox used to notify an owner selected during admission. */
  audit?: TriageAuditOutboxConfiguration
}

/** Input for composing a form submission triage row. */
export type CreateFormTriageEntryTransactionPutInput = {
  /** Request Intake table name. */
  tableName: string
  /** Fully normalized form-source entry. */
  entry: TriageEntry
  /** Number of deterministic wake shards configured on the table. */
  wakeShardCount?: number
}

/** Input for atomically appending source activity and resurfacing when required. */
export type CreateTriageSourceActivityTransactionItemsInput = {
  /** Request Intake table name. */
  tableName: string
  /** Strongly read current entry. */
  entry: TriageEntry
  /** Provider-normalized stable activity. */
  activity: TriageSourceActivity
  /** Replay protection bound to the stable source event. */
  idempotency: TriageIdempotency
  /** Optional receipt TTL instant, defaulting to ninety days after activity. */
  receiptExpiresAt?: string
  /** ISO instant when this transaction is being composed, used for the default receipt TTL. */
  now?: string
  /** Number of deterministic wake shards configured on the table. */
  wakeShardCount?: number
}

/** Input for an atomic accept-create, accept-link, or duplicate contribution. */
export type CreateTriageAcceptanceTransactionItemsInput = {
  /** Request Intake table name. */
  tableName: string
  /** Strongly read current entry. */
  entry: TriageEntry
  /** Validated acceptance or duplicate action with expected revision. */
  action: Extract<TriageActionInput, { action: 'accept' | 'duplicate' }>
  /** Final canonical Work Item identity chosen by application composition. */
  canonicalWorkItem: TriageWorkItemReference
  /** Stable member or service actor identifier. */
  actorId: string
  /** ISO 8601 mutation instant shared with the Work Item transaction. */
  now: string
  /** Replay protection bound to the semantic acceptance input. */
  idempotency: TriageIdempotency
  /** Duplicate-context preservation proof required for duplicate actions. */
  mergeReceipt?: TriageMergeReceipt
  /** Optional receipt TTL instant, defaulting to ninety days after mutation. */
  receiptExpiresAt?: string
  /** Number of deterministic wake shards configured on the table. */
  wakeShardCount?: number
}

/** Input for a non-Work-Item triage action transaction. */
export type CreateTriageActionTransactionItemsInput = {
  /** Request Intake table name. */
  tableName: string
  /** Strongly read current entry. */
  entry: TriageEntry
  /** Validated action that does not require Work Item orchestration. */
  action: Exclude<TriageActionInput, { action: 'accept' | 'duplicate' }>
  /** Stable member or service actor identifier. */
  actorId: string
  /** ISO 8601 mutation instant. */
  now: string
  /** Replay protection bound to the semantic action input. */
  idempotency: TriageIdempotency
  /** Immutable audit outbox joined to assignment actions. */
  audit: TriageAuditOutboxConfiguration
  /** Immutable caller context used when the action produces an assignment audit event. */
  auditContext: MutationAuditContext
  /** Optional receipt TTL instant, defaulting to ninety days after mutation. */
  receiptExpiresAt?: string
  /** Number of deterministic wake shards configured on the table. */
  wakeShardCount?: number
}

/** Input for one strongly read schedule candidate. */
export type CreateTriageScheduleTransactionItemsInput = {
  /** Request Intake table name. */
  tableName: string
  /** Strongly read current entry. */
  entry: TriageEntry
  /** ISO 8601 schedule evaluation instant. */
  now: string
  /** Number of deterministic wake shards configured on the table. */
  wakeShardCount?: number
}

/** Schedule contribution with explicit fired-deadline flags. */
export type TriageScheduleTransactionContribution = TriageTransactionContribution & {
  /** Whether a snoozed entry returned to pending. */
  resurfaced: boolean
  /** Whether response SLA breach was newly recorded. */
  breached: boolean
  /** Whether escalation was newly recorded. */
  escalated: boolean
  /** Whether retention redaction was newly applied. */
  redacted: boolean
}

/** Builds the conditional root Put for a form submission transaction.
 *
 * @param input The form entry and Request Intake table identity.
 * @returns A transaction Put that has not been executed.
 */
export function createFormTriageEntryTransactionPut(
  input: CreateFormTriageEntryTransactionPutInput,
): TriageTransactionItem {
  if (input.entry.source.kind !== 'form') {
    throw new TriageError(400, 'InvalidTriageSource', 'A form triage entry must use a form source.')
  }
  validateTriageEntryProjection(input.entry)
  return createEntryPut(
    requireText(input.tableName, 'Request Intake table name', 1_000),
    input.entry,
    normalizeWakeShardCount(input.wakeShardCount),
  )
}

/** Builds all triage-owned writes for a form submission transaction.
 *
 * @param input The initial form entry and source fingerprint.
 * @returns Root, source-claim, and immutable-event writes.
 */
export function createFormTriageEntryTransactionItems(
  input: CreateTriageEntryTransactionItemsInput,
): TriageTransactionItems {
  if (input.entry.source.kind !== 'form') {
    throw new TriageError(400, 'InvalidTriageSource', 'A form triage entry must use a form source.')
  }
  return createTriageEntryTransactionItems(input)
}

/** Builds all writes required to create a unique source entry.
 *
 * @param input The normalized entry, table, and initial payload fingerprint.
 * @returns Root, source-claim, and immutable-event writes.
 */
export function createTriageEntryTransactionItems(
  input: CreateTriageEntryTransactionItemsInput,
): TriageTransactionItems {
  const tableName = requireText(input.tableName, 'Request Intake table name', 1_000)
  validateTriageEntryProjection(input.entry)
  requireFingerprint(input.inputFingerprint)
  const events = input.entry.events.map((event) => createEventPut(tableName, input.entry, event))
  const admissionAssignmentAudit = input.audit
    ? createTriageAdmissionAssignmentAuditTransactionItems({
        audit: input.audit,
        entry: input.entry,
      })
    : []
  return [
    createEntryPut(tableName, input.entry, normalizeWakeShardCount(input.wakeShardCount)),
    createSourceClaimPut(tableName, input.entry, input.inputFingerprint),
    ...events,
    ...admissionAssignmentAudit,
  ]
}

/** Builds an activity receipt and revision-conditional resurface transaction.
 *
 * @param input The current entry, normalized activity, and replay protection.
 * @returns The next entry and unexecuted transaction items.
 */
export function createTriageSourceActivityTransactionItems(
  input: CreateTriageSourceActivityTransactionItemsInput,
): TriageTransactionContribution {
  const tableName = requireText(input.tableName, 'Request Intake table name', 1_000)
  validateTriageEntryProjection(input.entry)
  validateIdempotency(input.idempotency)
  const entry = ensureRetentionRedactionEvent(
    input.entry,
    recordTriageSourceActivity(input.entry, input.activity),
  )
  const newEvents = findNewEvents(input.entry, entry)
  return {
    entry,
    transactItems: [
      createEntryUpdate(
        tableName,
        entry,
        input.entry.revision,
        normalizeWakeShardCount(input.wakeShardCount),
      ),
      ...newEvents.map((event) => createEventPut(tableName, entry, event)),
      createReceiptPut(
        tableName,
        entry,
        'activity',
        input.idempotency,
        input.receiptExpiresAt ?? addDays(input.now ?? new Date().toISOString(), 90),
      ),
    ],
  }
}

/** Builds triage acceptance writes for composition with Work Item writes.
 *
 * @param input The current entry, final Work Item reference, actor, and replay protection.
 * @returns The accepted entry and unexecuted triage transaction actions.
 */
export function createTriageAcceptanceTransactionItems(
  input: CreateTriageAcceptanceTransactionItemsInput,
): TriageTransactionContribution {
  const tableName = requireText(input.tableName, 'Request Intake table name', 1_000)
  validateTriageEntryProjection(input.entry)
  validateIdempotency(input.idempotency)
  const entry = applyTriageAction(input.entry, input.action, {
    actorId: input.actorId,
    now: input.now,
    canonicalWorkItem: input.canonicalWorkItem,
    ...(input.mergeReceipt ? { mergeReceipt: input.mergeReceipt } : {}),
  })
  return createActionContribution(
    tableName,
    input.entry,
    entry,
    input.idempotency,
    input.receiptExpiresAt ?? addDays(input.now, 90),
    normalizeWakeShardCount(input.wakeShardCount),
    true,
  )
}

/** Builds a replay-safe transaction for an action without Work Item dependencies.
 *
 * @param input The current entry, action, actor, and replay protection.
 * @returns The next entry and unexecuted transaction actions.
 */
export function createTriageActionTransactionItems(
  input: CreateTriageActionTransactionItemsInput,
): TriageTransactionContribution {
  const tableName = requireText(input.tableName, 'Request Intake table name', 1_000)
  validateTriageEntryProjection(input.entry)
  validateIdempotency(input.idempotency)
  const entry = applyTriageAction(input.entry, input.action, {
    actorId: input.actorId,
    now: input.now,
  })
  const contribution = createActionContribution(
    tableName,
    input.entry,
    entry,
    input.idempotency,
    input.receiptExpiresAt ?? addDays(input.now, 90),
    normalizeWakeShardCount(input.wakeShardCount),
    false,
  )
  return {
    entry: contribution.entry,
    transactItems: [
      ...contribution.transactItems,
      ...(input.action.action === 'assign'
        ? createTriageAssignmentAuditTransactionItems({
            audit: input.audit,
            previousEntry: input.entry,
            assignedEntry: contribution.entry,
            actorId: input.actorId,
            auditContext: input.auditContext,
          })
        : []),
    ],
  }
}

/** Builds a revision-conditional schedule update when a deadline fired.
 *
 * @param input The current entry and schedule instant.
 * @returns The updated entry, fired flags, and unexecuted transaction items.
 */
export function createTriageScheduleTransactionItems(
  input: CreateTriageScheduleTransactionItemsInput,
): TriageScheduleTransactionContribution {
  const tableName = requireText(input.tableName, 'Request Intake table name', 1_000)
  validateTriageEntryProjection(input.entry)
  const evaluation = evaluateTriageSchedule(input.entry, input.now)
  const changed = evaluation.entry.revision !== input.entry.revision
  return {
    entry: evaluation.entry,
    resurfaced: evaluation.resurfaced,
    breached: evaluation.breached,
    escalated: evaluation.escalated,
    redacted: evaluation.redacted,
    transactItems: changed
      ? [
          createEntryUpdate(
            tableName,
            evaluation.entry,
            input.entry.revision,
            normalizeWakeShardCount(input.wakeShardCount),
          ),
          ...findNewEvents(input.entry, evaluation.entry).map((event) =>
            createEventPut(tableName, evaluation.entry, event)),
        ]
      : [],
  }
}

/** Returns the physical primary key for an entry.
 *
 * @param workspaceId The owning Workspace ID.
 * @param entryId The entry ID.
 * @returns The Request Intake table primary key.
 */
export function createTriageEntryKey(
  workspaceId: string,
  entryId: string,
): { scopeKey: string; recordKey: string } {
  return {
    scopeKey: createWorkspaceScopeKey(workspaceId),
    recordKey: `TRIAGE#${requireIdentifier(entryId, 'Triage entry ID')}`,
  }
}

/** Returns the source uniqueness lookup key.
 *
 * @param workspaceId The owning Workspace ID.
 * @param sourceKind The source kind.
 * @param sourceId The provider-stable source ID.
 * @returns The digest-based lookup key.
 */
export function createTriageSourceClaimKey(
  workspaceId: string,
  sourceKind: TriageEntry['source']['kind'],
  sourceId: string,
): { scopeKey: string; recordKey: 'LOOKUP' } {
  const digest = digestText([
    requireWorkspaceId(workspaceId),
    sourceKind,
    requireText(sourceId, 'Triage source ID', 500),
  ].join('\u0000'))
  return { scopeKey: `TRIAGE_SOURCE#${digest}`, recordKey: 'LOOKUP' }
}

/** Returns an operation idempotency receipt key.
 *
 * @param workspaceId The owning Workspace ID.
 * @param entryId The target entry ID.
 * @param operation The operation namespace.
 * @param idempotencyKey The caller-selected retry key.
 * @returns The digest-based receipt key.
 */
export function createTriageReceiptKey(
  workspaceId: string,
  entryId: string,
  operation: string,
  idempotencyKey: string,
): { scopeKey: string; recordKey: 'RECEIPT' } {
  const digest = digestText([
    requireWorkspaceId(workspaceId),
    requireIdentifier(entryId, 'Triage entry ID'),
    requireText(operation, 'Triage operation', 100),
    requireText(idempotencyKey, 'Triage idempotency key', 200),
  ].join('\u0000'))
  return { scopeKey: `TRIAGE_RECEIPT#${digest}`, recordKey: 'RECEIPT' }
}

/** Builds a fingerprint-bound receipt Put for an externally composed transaction.
 *
 * @param input The table, operation, result, and replay protection.
 * @returns An immutable receipt Put that has not been executed.
 */
export function createTriageOperationReceiptTransactionPut(
  input: CreateTriageOperationReceiptTransactionPutInput,
): TriageTransactionItem {
  validateTriageEntryProjection(input.entry)
  validateIdempotency(input.idempotency)
  return createReceiptPut(
    requireText(input.tableName, 'Request Intake table name', 1_000),
    input.entry,
    requireText(input.operation, 'Triage operation', 100),
    input.idempotency,
    input.expiresAt,
  )
}


/** Returns a Workspace scope key shared with Request Intake rows.
 *
 * @param workspaceId The Workspace directory ID.
 * @returns The table partition key.
 */
export function createWorkspaceScopeKey(workspaceId: string): string {
  return `WORKSPACE#${requireWorkspaceId(workspaceId)}`
}

/** Returns the reverse source association prefix for a Work Item.
 *
 * @param teamId The owning Team ID.
 * @param workItemId The canonical Work Item ID.
 * @returns The physical record-key prefix.
 */
export function createTriageWorkItemSourcePrefix(teamId: string, workItemId: string): string {
  return `TRIAGE_WORK_ITEM#${requireIdentifier(teamId, 'Team ID')}#${requireIdentifier(workItemId, 'Work Item ID')}#`
}

/** Strictly decodes an entry embedded in its expected persistence row.
 *
 * @param value The untrusted DynamoDB item.
 * @param expectedKey The physical primary key used to read the item.
 * @returns The canonical entry, or undefined for another, malformed, or misbound row.
 */
export function decodeTriageEntryRow(
  value: unknown,
  expectedKey: { scopeKey: string; recordKey: string },
): TriageEntry | undefined {
  if (!isRecord(value) || value.entryType !== 'triage-entry') return undefined
  if (!isTriageEntry(value.entry)) return undefined
  try {
    validateTriageEntryProjection(value.entry)
    const entryKey = createTriageEntryKey(value.entry.workspaceId, value.entry.id)
    if (entryKey.scopeKey !== expectedKey.scopeKey || entryKey.recordKey !== expectedKey.recordKey) {
      return undefined
    }
    const normalizedOwnerUserId = value.entry.ownerUserId?.trim().toLowerCase()
    return normalizedOwnerUserId === undefined || normalizedOwnerUserId === value.entry.ownerUserId
      ? value.entry
      : { ...value.entry, ownerUserId: normalizedOwnerUserId }
  } catch {
    return undefined
  }
}

/** Validates a triage entry before storing it.
 *
 * @param entry The entry projection to validate.
 */
export function validateTriageEntryProjection(entry: TriageEntry): void {
  if (!isTriageEntry(entry)) {
    throw new TriageError(400, 'InvalidTriageEntry', 'The triage entry projection is invalid.')
  }
  requireWorkspaceId(entry.workspaceId)
  requireIdentifier(entry.id, 'Triage entry ID')
  requireIdentifier(entry.teamId, 'Team ID')
  requireText(entry.source.sourceId, 'Triage source ID', 500)
  requireText(entry.sourcePreview.title, 'Triage source title', 500)
  requireText(entry.sourcePreview.body, 'Triage source preview', 8_000, true)
  if (entry.sourcePreview.permalink !== undefined) {
    requireHttpsUrl(entry.sourcePreview.permalink, 'Triage source permalink')
  }
  requireIsoInstant(entry.receivedAt, 'Triage received time')
  requireIsoInstant(entry.lastActivityAt, 'Triage last activity time')
  requireIsoInstant(entry.retention.expiresAt, 'Triage retention deadline')
  if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) {
    throw new TriageError(400, 'InvalidTriageEntry', 'Triage entry revision is invalid.')
  }
}

/** Creates an action contribution shared by resolved and ordinary actions. */
function createActionContribution(
  tableName: string,
  current: TriageEntry,
  entry: TriageEntry,
  idempotency: TriageIdempotency,
  receiptExpiresAt: string,
  wakeShardCount: number,
  associateWorkItem: boolean,
): TriageTransactionContribution {
  const retainedEntry = ensureRetentionRedactionEvent(current, entry)
  const events = findNewEvents(current, retainedEntry)
  const association = associateWorkItem
    ? [createWorkItemAssociationPut(tableName, retainedEntry)]
    : []
  return {
    entry: retainedEntry,
    transactItems: [
      createEntryUpdate(tableName, retainedEntry, current.revision, wakeShardCount),
      ...events.map((event) => createEventPut(tableName, retainedEntry, event)),
      ...association,
      createReceiptPut(tableName, retainedEntry, 'action', idempotency, receiptExpiresAt),
    ],
  }
}

/** Adds the retention audit event when a detached expiry projection enters a write. */
function ensureRetentionRedactionEvent(
  current: TriageEntry,
  next: TriageEntry,
): TriageEntry {
  const redactedAt = current.retention.redactedAt
  if (!redactedAt || current.events.some((event) =>
    event.type === 'retention-redacted' && event.createdAt === redactedAt
  )) return next
  const event: TriageEntryEvent = {
    id: `retention-redacted:${current.revision + 1}:${redactedAt}`,
    type: 'retention-redacted',
    actorId: 'system:triage-mutation',
    summary: 'Retained source content was redacted.',
    createdAt: redactedAt,
  }
  return {
    ...next,
    events: [...next.events, event].slice(-TRIAGE_ENTRY_EVENT_LIMIT),
  }
}

/** Builds an immutable root entry Put. */
function createEntryPut(
  tableName: string,
  entry: TriageEntry,
  wakeShardCount: number,
): TriageTransactionItem {
  return {
    Put: {
      TableName: tableName,
      Item: createStoredEntry(entry, wakeShardCount),
      ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    },
  }
}

/** Builds a revision-conditional root entry Update. */
function createEntryUpdate(
  tableName: string,
  entry: TriageEntry,
  expectedRevision: number,
  wakeShardCount: number,
): TriageTransactionItem {
  const stored = createStoredEntry(entry, wakeShardCount)
  const values: Record<string, unknown> = {
    ':entry': entry,
    ':revision': entry.revision,
    ':expectedRevision': expectedRevision,
    ':state': entry.state,
    ':teamId': entry.teamId,
    ':sourceKind': entry.source.kind,
    ':teamKey': stored.triageTeamKey,
    ':activityKey': stored.triageActivityKey,
  }
  const sets = [
    '#entry = :entry',
    '#revision = :revision',
    '#state = :state',
    'teamId = :teamId',
    'sourceKind = :sourceKind',
    'triageTeamKey = :teamKey',
    'triageActivityKey = :activityKey',
  ]
  const removes: string[] = []
  if (stored.triageOwnerKey) {
    values[':ownerKey'] = stored.triageOwnerKey
    sets.push('triageOwnerKey = :ownerKey')
  } else {
    removes.push('triageOwnerKey')
  }
  if (stored.triageWakeShard && stored.triageNextWakeAt) {
    values[':wakeShard'] = stored.triageWakeShard
    values[':nextWakeAt'] = stored.triageNextWakeAt
    sets.push('triageWakeShard = :wakeShard', 'triageNextWakeAt = :nextWakeAt')
  } else {
    removes.push('triageWakeShard', 'triageNextWakeAt')
  }
  if (entry.canonicalWorkItem) {
    values[':workItemId'] = entry.canonicalWorkItem.workItemId
    sets.push('canonicalWorkItemId = :workItemId')
  } else {
    removes.push('canonicalWorkItemId')
  }
  return {
    Update: {
      TableName: tableName,
      Key: createTriageEntryKey(entry.workspaceId, entry.id),
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ConditionExpression: '#revision = :expectedRevision AND teamId = :teamId',
      ExpressionAttributeNames: {
        '#entry': 'entry',
        '#revision': 'revision',
        '#state': 'state',
      },
      ExpressionAttributeValues: values,
    },
  }
}

/** Creates one persisted root item with sparse index attributes. */
function createStoredEntry(entry: TriageEntry, wakeShardCount: number) {
  const nextWakeAt = calculateNextWakeAt(entry)
  const triageOwnerKey = createOwnerIndexKey(entry)
  return {
    entryType: 'triage-entry',
    ...createTriageEntryKey(entry.workspaceId, entry.id),
    entry,
    revision: entry.revision,
    state: entry.state,
    teamId: entry.teamId,
    sourceKind: entry.source.kind,
    triageTeamKey: `WORKSPACE#${entry.workspaceId}#TEAM#${entry.teamId}`,
    triageActivityKey: `${entry.lastActivityAt}#${entry.id}`,
    ...(triageOwnerKey ? { triageOwnerKey } : {}),
    ...(nextWakeAt
      ? {
          triageWakeShard: `WAKE#${calculateWakeShard(entry.id, wakeShardCount)}`,
          triageNextWakeAt: `${nextWakeAt}#${entry.id}`,
        }
      : {}),
    ...(entry.canonicalWorkItem
      ? { canonicalWorkItemId: entry.canonicalWorkItem.workItemId }
      : {}),
  }
}

/** Builds a source uniqueness claim. */
function createSourceClaimPut(
  tableName: string,
  entry: TriageEntry,
  inputFingerprint: string,
): TriageTransactionItem {
  return {
    Put: {
      TableName: tableName,
      Item: {
        entryType: 'triage-source-claim',
        ...createTriageSourceClaimKey(entry.workspaceId, entry.source.kind, entry.source.sourceId),
        workspaceId: entry.workspaceId,
        entryId: entry.id,
        sourceKind: entry.source.kind,
        sourceId: entry.source.sourceId,
        inputFingerprint,
        createdAt: entry.createdAt,
      },
      ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    },
  }
}

/** Builds an immutable event Put. */
function createEventPut(
  tableName: string,
  entry: TriageEntry,
  event: TriageEntryEvent,
): TriageTransactionItem {
  return {
    Put: {
      TableName: tableName,
      Item: {
        entryType: 'triage-entry-event',
        scopeKey: createWorkspaceScopeKey(entry.workspaceId),
        recordKey: `TRIAGE_EVENT#${entry.id}#${event.createdAt}#${event.id}`,
        entryId: entry.id,
        event,
      },
      ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    },
  }
}

/** Builds an immutable reverse Work Item source association. */
function createWorkItemAssociationPut(tableName: string, entry: TriageEntry): TriageTransactionItem {
  if (!entry.canonicalWorkItem) {
    throw new TriageError(409, 'TriageWorkItemUnresolved', 'The canonical Work Item is missing.')
  }
  return {
    Put: {
      TableName: tableName,
      Item: {
        entryType: 'triage-work-item-source',
        scopeKey: createWorkspaceScopeKey(entry.workspaceId),
        recordKey: `${createTriageWorkItemSourcePrefix(
          entry.canonicalWorkItem.teamId,
          entry.canonicalWorkItem.workItemId,
        )}${entry.id}`,
        workspaceId: entry.workspaceId,
        teamId: entry.canonicalWorkItem.teamId,
        workItemId: entry.canonicalWorkItem.workItemId,
        entryId: entry.id,
        source: { kind: entry.source.kind, sourceId: entry.source.sourceId },
        updatedAt: entry.updatedAt,
      },
      ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    },
  }
}

/** Builds a fingerprint-bound operation receipt Put. */
function createReceiptPut(
  tableName: string,
  entry: TriageEntry,
  operation: string,
  idempotency: TriageIdempotency,
  expiresAtValue: string,
): TriageTransactionItem {
  const expiresAt = requireIsoInstant(expiresAtValue, 'Triage receipt expiry')
  return {
    Put: {
      TableName: tableName,
      Item: {
        entryType: 'triage-operation-receipt',
        ...createTriageReceiptKey(entry.workspaceId, entry.id, operation, idempotency.key),
        workspaceId: entry.workspaceId,
        entryId: entry.id,
        operation,
        inputFingerprint: idempotency.fingerprint,
        resultRevision: entry.revision,
        createdAt: entry.updatedAt,
        expiresAt: Math.floor(Date.parse(expiresAt) / 1_000),
      },
      ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    },
  }
}

/** Finds events appended after a strongly read projection. */
function findNewEvents(current: TriageEntry, next: TriageEntry): TriageEntryEvent[] {
  const currentIds = new Set(current.events.map((event) => event.id))
  return next.events.filter((event) => !currentIds.has(event.id))
}

/** Calculates the earliest deadline represented by the sparse wake index. */
function calculateNextWakeAt(entry: TriageEntry): string | undefined {
  const candidates: string[] = []
  if (!entry.retention.redactedAt) candidates.push(entry.retention.expiresAt)
  if (entry.state !== 'accepted' && entry.state !== 'duplicate' && entry.state !== 'declined') {
    if (entry.state === 'snoozed' && entry.snoozedUntil) candidates.push(entry.snoozedUntil)
    if (entry.sla && !entry.sla.breachedAt) candidates.push(entry.sla.dueAt)
    if (entry.sla?.escalationDueAt && !entry.sla.escalatedAt) {
      candidates.push(entry.sla.escalationDueAt)
    }
  }
  return candidates.sort()[0]
}

/** Creates a sparse owner index partition key. */
function createOwnerIndexKey(entry: TriageEntry): string {
  return `WORKSPACE#${entry.workspaceId}#TEAM#${entry.teamId}#OWNER#${
    entry.ownerUserId?.trim().toLowerCase() ?? 'UNOWNED'
  }`
}

/** Deterministically maps an entry ID to one wake shard. */
function calculateWakeShard(entryId: string, shardCount: number): number {
  const prefix = digestText(entryId).slice(0, 8)
  return Number.parseInt(prefix, 16) % shardCount
}

/** Adds whole UTC days to an instant. */
function addDays(value: string, days: number): string {
  const instant = new Date(requireIsoInstant(value, 'Triage receipt base time'))
  instant.setUTCDate(instant.getUTCDate() + days)
  return instant.toISOString()
}

/** Validates replay protection. */
function validateIdempotency(value: TriageIdempotency): void {
  requireText(value.key, 'Triage idempotency key', 200)
  requireFingerprint(value.fingerprint)
}

/** Validates a SHA-256 semantic input fingerprint. */
function requireFingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TriageError(400, 'InvalidTriageIdempotency', 'The input fingerprint is invalid.')
  }
}

/** Normalizes the configured wake shard count. */
function normalizeWakeShardCount(value: number | undefined): number {
  const count = value ?? DEFAULT_TRIAGE_WAKE_SHARD_COUNT
  if (!Number.isSafeInteger(count) || count < 1 || count > 128) {
    throw new TriageError(500, 'InvalidTriageConfiguration', 'The wake shard count is invalid.')
  }
  return count
}

/** Creates a SHA-256 hex digest. */
function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Requires a conservative identifier. */
function requireIdentifier(value: string, label: string): string {
  const identifier = requireText(value, label, 200)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(identifier)) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  return identifier
}

/**
 * Validates a canonical Workspace partition identifier without rejecting Cognito-style IDs.
 *
 * Workspace directory IDs legitimately contain delimiters such as `#` and `@`; they are
 * stored as DynamoDB scalar values, so only blank, oversized, and control-character values
 * need to be rejected here.
 *
 * @param value - Workspace identifier supplied by an authenticated boundary.
 * @returns The normalized Workspace identifier.
 */
function requireWorkspaceId(value: string): string {
  const workspaceId = requireText(value, 'Workspace ID', 500)
  if ([...workspaceId].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })) {
    throw new TriageError(400, 'InvalidTriageInput', 'Workspace ID is invalid.')
  }
  return workspaceId
}

/** Requires bounded text, optionally allowing an empty value. */
function requireText(
  value: string,
  label: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  const normalized = value.trim()
  if ((!allowEmpty && !normalized) || normalized.length > maximumLength) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  return normalized
}

/** Requires a parseable ISO 8601 instant. */
function requireIsoInstant(value: string, label: string): string {
  const instant = new Date(value)
  if (!Number.isFinite(instant.getTime())) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  return instant.toISOString()
}

/** Requires a bounded HTTPS URL. */
function requireHttpsUrl(value: string, label: string): string {
  if (value.length > 2_048) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`, { cause: error })
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  return url.toString()
}

/** Checks whether an untrusted value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deeply validates a persisted entry projection and rejects unknown fields. */
function isTriageEntry(value: unknown): value is TriageEntry {
  return isRecord(value) && hasOnlyKeys(value, [
    'schemaVersion',
    'id',
    'workspaceId',
    'source',
    'sourcePreview',
    'requester',
    'receivedAt',
    'lastActivityAt',
    'state',
    'routing',
    'teamId',
    'projectId',
    'ownerUserId',
    'permission',
    'sla',
    'snoozedUntil',
    'retention',
    'canonicalWorkItem',
    'mergeReceipt',
    'capabilities',
    'events',
    'revision',
    'createdAt',
    'updatedAt',
  ]) &&
    value.schemaVersion === 1 &&
    isIdentifier(value.id) &&
    isWorkspaceId(value.workspaceId) &&
    isSource(value.source) &&
    isPreview(value.sourcePreview) &&
    isRequester(value.requester) &&
    isIsoInstant(value.receivedAt) &&
    isIsoInstant(value.lastActivityAt) &&
    isTriageState(value.state) &&
    isRouting(value.routing) &&
    isIdentifier(value.teamId) &&
    (value.projectId === undefined || isIdentifier(value.projectId)) &&
    (value.ownerUserId === undefined || isMemberKey(value.ownerUserId)) &&
    isPermission(value.permission) &&
    (value.sla === undefined || isSla(value.sla)) &&
    (value.state === 'snoozed'
      ? isIsoInstant(value.snoozedUntil)
      : value.snoozedUntil === undefined) &&
    isRetention(value.retention) &&
    (value.canonicalWorkItem === undefined || isWorkItemReference(value.canonicalWorkItem)) &&
    (value.mergeReceipt === undefined || isMergeReceipt(value.mergeReceipt)) &&
    isCapabilities(value.capabilities) &&
    Array.isArray(value.events) && value.events.length <= TRIAGE_ENTRY_EVENT_LIMIT &&
    value.events.every(isEvent) &&
    typeof value.revision === 'number' && Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    isIsoInstant(value.createdAt) &&
    isIsoInstant(value.updatedAt)
}

/** Validates a lifecycle state. */
function isTriageState(value: unknown): value is TriageEntry['state'] {
  return value === 'pending' || value === 'accepted' || value === 'duplicate' ||
    value === 'declined' || value === 'snoozed' || value === 'needs-information'
}

/** Validates the persisted source reference fields required by storage. */
function isSource(value: unknown): value is TriageEntry['source'] {
  return isRecord(value) && hasOnlyKeys(value, [
    'kind',
    'sourceId',
    'provider',
    'containerId',
    'messageId',
    'formId',
    'submissionId',
    'connectorId',
  ]) &&
    (value.kind === 'form' || value.kind === 'chat' || value.kind === 'email' ||
      value.kind === 'webhook' || value.kind === 'manual-handoff') &&
    isBoundedText(value.sourceId, 500) &&
    isOptionalBoundedText(value.provider, 100) &&
    isOptionalBoundedText(value.containerId, 500) &&
    isOptionalBoundedText(value.messageId, 500) &&
    isOptionalBoundedText(value.formId, 200) &&
    isOptionalBoundedText(value.submissionId, 200) &&
    isOptionalBoundedText(value.connectorId, 200)
}

/** Validates a source preview. */
function isPreview(value: unknown): value is TriageEntry['sourcePreview'] {
  return isRecord(value) && hasOnlyKeys(value, [
    'title',
    'body',
    'channelLabel',
    'permalink',
    'attachmentCount',
    'commentCount',
    'watcherCount',
    'sanitized',
    'truncated',
  ]) &&
    isBoundedText(value.title, 500) &&
    isBoundedText(value.body, 8_000, true) &&
    isOptionalBoundedText(value.channelLabel, 200) &&
    (value.permalink === undefined || isHttpsUrl(value.permalink)) &&
    isNonNegativeSafeInteger(value.attachmentCount) &&
    isNonNegativeSafeInteger(value.commentCount) &&
    isNonNegativeSafeInteger(value.watcherCount) &&
    typeof value.sanitized === 'boolean' &&
    typeof value.truncated === 'boolean'
}

/** Validates a requester projection. */
function isRequester(value: unknown): value is TriageEntry['requester'] {
  return isRecord(value) && hasOnlyKeys(value, [
    'displayName',
    'email',
    'avatarUrl',
    'externalId',
    'guest',
  ]) &&
    isBoundedText(value.displayName, 500) &&
    isOptionalBoundedText(value.email, 320) &&
    (value.avatarUrl === undefined || isHttpsUrl(value.avatarUrl)) &&
    isOptionalBoundedText(value.externalId, 500) &&
    typeof value.guest === 'boolean'
}

/** Validates a permission projection. */
function isPermission(value: unknown): value is TriageEntry['permission'] {
  return isRecord(value) && hasOnlyKeys(value, [
    'visibility',
    'canReply',
    'guestVisible',
    'reasonCode',
    'checkedAt',
  ]) &&
    (value.visibility === 'full' || value.visibility === 'metadata-only' || value.visibility === 'denied') &&
    typeof value.canReply === 'boolean' && typeof value.guestVisible === 'boolean' &&
    isOptionalBoundedText(value.reasonCode, 200) &&
    isIsoInstant(value.checkedAt)
}

/** Validates a routing projection. */
function isRouting(value: unknown): value is TriageEntry['routing'] {
  return isRecord(value) && hasOnlyKeys(value, ['reason', 'candidates']) &&
    isBoundedText(value.reason, 2_000) && Array.isArray(value.candidates) &&
    value.candidates.length <= 100 && value.candidates.every(isRoutingCandidate)
}

/** Validates one persisted routing candidate. */
function isRoutingCandidate(value: unknown): value is TriageEntry['routing']['candidates'][number] {
  return isRecord(value) && hasOnlyKeys(value, [
    'teamId',
    'projectId',
    'reason',
    'ruleId',
    'score',
    'permitted',
  ]) &&
    isIdentifier(value.teamId) &&
    (value.projectId === undefined || isIdentifier(value.projectId)) &&
    isBoundedText(value.reason, 2_000) &&
    (value.ruleId === undefined || isIdentifier(value.ruleId)) &&
    (value.score === undefined || (
      typeof value.score === 'number' && Number.isFinite(value.score) &&
      value.score >= 0 && value.score <= 1
    )) &&
    typeof value.permitted === 'boolean'
}

/** Validates retention metadata. */
function isRetention(value: unknown): value is TriageEntry['retention'] {
  return isRecord(value) && hasOnlyKeys(value, ['policyId', 'expiresAt', 'redactedAt']) &&
    isOptionalBoundedText(value.policyId, 200) && isIsoInstant(value.expiresAt) &&
    (value.redactedAt === undefined || isIsoInstant(value.redactedAt))
}

/** Validates SLA and escalation timestamps. */
function isSla(value: unknown): value is NonNullable<TriageEntry['sla']> {
  return isRecord(value) && hasOnlyKeys(value, [
    'policyId',
    'dueAt',
    'breachedAt',
    'escalationDueAt',
    'escalatedAt',
    'escalationOwnerUserId',
  ]) &&
    isIdentifier(value.policyId) && isIsoInstant(value.dueAt) &&
    (value.breachedAt === undefined || isIsoInstant(value.breachedAt)) &&
    (value.escalationDueAt === undefined || isIsoInstant(value.escalationDueAt)) &&
    (value.escalatedAt === undefined || isIsoInstant(value.escalatedAt)) &&
    (value.escalationOwnerUserId === undefined ||
      readTriageNotificationMemberKey(value.escalationOwnerUserId) !== undefined)
}

/** Validates a canonical Work Item reference. */
function isWorkItemReference(
  value: unknown,
): value is NonNullable<TriageEntry['canonicalWorkItem']> {
  return isRecord(value) && hasOnlyKeys(value, ['teamId', 'workItemId', 'projectId', 'workItemTypeId']) &&
    isIdentifier(value.teamId) && isIdentifier(value.workItemId) &&
    (value.projectId === undefined || isIdentifier(value.projectId)) &&
    (value.workItemTypeId === undefined || isIdentifier(value.workItemTypeId))
}

/** Validates duplicate-context merge counts and completion time. */
function isMergeReceipt(value: unknown): value is NonNullable<TriageEntry['mergeReceipt']> {
  return isRecord(value) && hasOnlyKeys(value, [
    'canonicalWorkItemId',
    'mergedSourceCount',
    'mergedCommentCount',
    'mergedAttachmentCount',
    'mergedWatcherCount',
    'completedAt',
  ]) &&
    isIdentifier(value.canonicalWorkItemId) &&
    isNonNegativeSafeInteger(value.mergedSourceCount) &&
    isNonNegativeSafeInteger(value.mergedCommentCount) &&
    isNonNegativeSafeInteger(value.mergedAttachmentCount) &&
    isNonNegativeSafeInteger(value.mergedWatcherCount) &&
    isIsoInstant(value.completedAt)
}

/** Validates a capability projection. */
function isCapabilities(value: unknown): value is TriageEntry['capabilities'] {
  return isRecord(value) && hasOnlyKeys(value, [
    'canAssign',
    'canAcceptCreate',
    'canAcceptLink',
    'canMarkDuplicate',
    'canDecline',
    'canSnooze',
    'canRequestInformation',
    'canReply',
    'canViewInternalContext',
  ]) &&
    typeof value.canAssign === 'boolean' && typeof value.canAcceptCreate === 'boolean' &&
    typeof value.canAcceptLink === 'boolean' && typeof value.canMarkDuplicate === 'boolean' &&
    typeof value.canDecline === 'boolean' && typeof value.canSnooze === 'boolean' &&
    typeof value.canRequestInformation === 'boolean' && typeof value.canReply === 'boolean' &&
    typeof value.canViewInternalContext === 'boolean'
}

/** Validates an immutable event projection. */
function isEvent(value: unknown): value is TriageEntryEvent {
  return isRecord(value) && hasOnlyKeys(value, [
    'id',
    'type',
    'actorId',
    'summary',
    'createdAt',
  ]) &&
    isBoundedText(value.id, 200) && isEventType(value.type) &&
    isBoundedText(value.actorId, 500) && isBoundedText(value.summary, 2_000) &&
    isIsoInstant(value.createdAt)
}

/** Validates a persisted event discriminator. */
function isEventType(value: unknown): value is TriageEntryEvent['type'] {
  return value === 'created' || value === 'assigned' || value === 'accepted' ||
    value === 'linked' || value === 'duplicate' || value === 'declined' ||
    value === 'snoozed' || value === 'information-requested' ||
    value === 'activity-received' || value === 'resurfaced' ||
    value === 'sla-breached' || value === 'escalated' ||
    value === 'retention-redacted'
}

/** Returns whether an object contains only explicitly allowed keys. */
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

/** Validates a canonical persisted identifier. */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && value.trim() === value &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
}

/** Validates a Workspace identifier that may contain Cognito delimiters. */
function isWorkspaceId(value: unknown): value is string {
  return isBoundedText(value, 500) && value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127
    })
}

/** Validates a canonical Workspace member key. */
function isMemberKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 320 && value.trim() === value &&
    /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(value)
}

/** Validates bounded persisted text. */
function isBoundedText(value: unknown, maximumLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximumLength &&
    (allowEmpty || value.trim().length > 0)
}

/** Validates an optional bounded text field. */
function isOptionalBoundedText(value: unknown, maximumLength: number): boolean {
  return value === undefined || isBoundedText(value, maximumLength)
}

/** Validates an ISO 8601 instant in the canonical stored representation. */
function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false
  const instant = new Date(value)
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value
}

/** Validates a bounded credential-free HTTPS URL. */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

/** Validates a non-negative safe integer count. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
