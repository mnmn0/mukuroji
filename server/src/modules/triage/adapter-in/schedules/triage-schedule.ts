import { createHash } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import type { TriageEntry } from '@mukuroji/contracts'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createAuditEventTransactPut,
  createMutationAuditContext,
  getConfiguredAuditRetentionDays,
  getConfiguredAuditTableName,
  getConfiguredDynamoDbEndpoint,
} from '../../../audit'
import { TriageError } from '../../domain/triage-entry'
import {
  createTriageScheduleTransactionItems,
  decodeTriageEntryRow,
  DEFAULT_TRIAGE_WAKE_SHARD_COUNT,
} from '../../adapter-out/dynamodb/triage-transactions'

/** Default sparse wake-index name. */
export const TRIAGE_WAKE_INDEX_NAME = 'triage-wake-index'

/** EventBridge payload accepted by the triage schedule. */
export type TriageScheduleEvent = {
  /** EventBridge event identifier. */
  id?: string
  /** EventBridge schedule time in ISO 8601 form. */
  time?: string
}

/** DynamoDB dependencies needed by the triage schedule adapter. */
export type TriageScheduleDocumentClient = Pick<DynamoDBDocumentClient, 'send'>

/** Explicit schedule execution options. */
export type RunTriageScheduleOptions = {
  /** Request Intake DocumentClient. */
  documentClient: TriageScheduleDocumentClient
  /** Request Intake table name. */
  tableName: string
  /** Immutable audit event outbox table name. */
  auditTableName: string
  /** Number of days scheduled audit events remain queryable. */
  auditRetentionDays: number
  /** Sparse wake-index name. */
  wakeIndexName: string
  /** Number of deterministic wake partitions. */
  wakeShardCount: number
  /** Maximum candidates evaluated in one invocation. */
  batchSize: number
  /** ISO 8601 schedule evaluation instant. */
  now: string
}

/** Observable result of one bounded schedule invocation. */
export type TriageScheduleResult = {
  /** Whether processing was safely disabled because the wake index is unavailable. */
  disabled: boolean
  /** Number of KEYS_ONLY candidates strongly read from the base table. */
  evaluatedCandidates: number
  /** Number of entries returned to pending after snooze. */
  resurfacedEntries: number
  /** Number of newly recorded SLA breaches. */
  breachedEntries: number
  /** Number of newly recorded escalations. */
  escalatedEntries: number
  /** Number of entries newly redacted by retention policy. */
  redactedEntries: number
  /** Number of revision races safely skipped. */
  conflicts: number
}

/** Inputs used to append SLA audit events to the schedule transaction. */
type TriageScheduleAuditInput = {
  /** Immutable audit event outbox table name. */
  auditTableName: string
  /** Number of days scheduled audit events remain queryable. */
  auditRetentionDays: number
  /** Strongly read entry before its scheduled transition. */
  entry: TriageEntry
  /** ISO 8601 schedule evaluation instant. */
  now: string
  /** Whether this transaction newly records an SLA breach. */
  breached: boolean
  /** Whether this transaction newly records an escalation. */
  escalated: boolean
  /** Current configured escalation recipient when one exists. */
  escalationOwnerUserId?: string
}

/** Creates the production EventBridge handler from environment configuration.
 *
 * @returns An async handler compatible with the configured one-minute schedule.
 */
export function createProductionTriageScheduleHandler(): (
  event?: TriageScheduleEvent,
) => Promise<TriageScheduleResult> {
  const endpoint = getConfiguredDynamoDbEndpoint()
  const dynamoDbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
  const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
    marshallOptions: { removeUndefinedValues: true },
  })
  return createTriageScheduleHandler(documentClient, {
    tableName: requireEnvironment('REQUEST_INTAKE_TABLE_NAME'),
    auditTableName: requireAuditTableName(),
    auditRetentionDays: getConfiguredAuditRetentionDays(),
    wakeIndexName: readEnvironment('TRIAGE_WAKE_INDEX_NAME') ?? TRIAGE_WAKE_INDEX_NAME,
    wakeShardCount: readPositiveIntegerEnvironment(
      'TRIAGE_WAKE_SHARD_COUNT',
      DEFAULT_TRIAGE_WAKE_SHARD_COUNT,
      128,
    ),
    batchSize: readPositiveIntegerEnvironment('TRIAGE_SCHEDULE_BATCH_SIZE', 100, 1_000),
  })
}

/** Configuration captured by a schedule handler factory. */
export type TriageScheduleHandlerConfiguration = {
  /** Request Intake table name. */
  tableName: string
  /** Immutable audit event outbox table name. */
  auditTableName: string
  /** Number of days scheduled audit events remain queryable. */
  auditRetentionDays: number
  /** Sparse wake-index name. */
  wakeIndexName: string
  /** Number of deterministic wake partitions. */
  wakeShardCount: number
  /** Maximum candidates evaluated in one invocation. */
  batchSize: number
}

/** Creates a schedule handler with injected persistence dependencies.
 *
 * @param documentClient The Request Intake DocumentClient.
 * @param configuration Captured table and bounded-work configuration.
 * @returns An EventBridge-compatible schedule handler.
 */
export function createTriageScheduleHandler(
  documentClient: TriageScheduleDocumentClient,
  configuration: TriageScheduleHandlerConfiguration,
): (event?: TriageScheduleEvent) => Promise<TriageScheduleResult> {
  return async (event = {}) => runTriageSchedule({
    documentClient,
    tableName: configuration.tableName,
    auditTableName: configuration.auditTableName,
    auditRetentionDays: configuration.auditRetentionDays,
    wakeIndexName: configuration.wakeIndexName,
    wakeShardCount: configuration.wakeShardCount,
    batchSize: configuration.batchSize,
    now: normalizeScheduleTime(event.time),
  })
}

/** Evaluates due sparse-index candidates without scanning the table.
 *
 * @param options Explicit schedule dependencies and bounds.
 * @returns Deadline counts and rollout-safe disabled state.
 */
export async function runTriageSchedule(
  options: RunTriageScheduleOptions,
): Promise<TriageScheduleResult> {
  const tableName = requireText(options.tableName, 'Request Intake table name')
  const auditTableName = requireText(options.auditTableName, 'Audit event table name')
  const auditRetentionDays = requirePositiveInteger(
    options.auditRetentionDays,
    'Audit retention days',
    36_500,
  )
  const wakeIndexName = requireText(options.wakeIndexName, 'Triage wake index name')
  const now = normalizeScheduleTime(options.now)
  const wakeShardCount = requirePositiveInteger(options.wakeShardCount, 'Wake shard count', 128)
  const batchSize = requirePositiveInteger(options.batchSize, 'Schedule batch size', 1_000)
  const result: TriageScheduleResult = {
    disabled: false,
    evaluatedCandidates: 0,
    resurfacedEntries: 0,
    breachedEntries: 0,
    escalatedEntries: 0,
    redactedEntries: 0,
    conflicts: 0,
  }

  for (let shard = 0; shard < wakeShardCount && result.evaluatedCandidates < batchSize; shard += 1) {
    let response
    try {
      response = await options.documentClient.send(new QueryCommand({
        TableName: tableName,
        IndexName: wakeIndexName,
        KeyConditionExpression:
          'triageWakeShard = :wakeShard AND triageNextWakeAt <= :nextWakeAt',
        ExpressionAttributeValues: {
          ':wakeShard': `WAKE#${shard}`,
          ':nextWakeAt': `${now}#\uffff`,
        },
        Limit: batchSize - result.evaluatedCandidates,
        ScanIndexForward: true,
      }))
    } catch (error) {
      if (isUnavailableIndexError(error)) {
        await requireBaseTableForUnavailableIndex(
          options.documentClient,
          tableName,
          error,
        )
        return { ...result, disabled: true }
      }
      throw error
    }

    for (const item of response.Items ?? []) {
      if (result.evaluatedCandidates >= batchSize) break
      const key = readPrimaryKey(item)
      if (!key) {
        throw new TriageError(
          500,
          'InvalidTriageIndexRow',
          'The triage wake index contains an invalid row.',
        )
      }
      const read = await options.documentClient.send(new GetCommand({
        TableName: tableName,
        Key: key,
        ConsistentRead: true,
      }))
      if (read.Item === undefined) continue
      const entry = decodeTriageEntryRow(read.Item, key)
      if (!entry) {
        throw new TriageError(
          500,
          'InvalidTriageEntry',
          'The stored triage entry is invalid.',
        )
      }
      result.evaluatedCandidates += 1
      const contribution = createTriageScheduleTransactionItems({
        tableName,
        entry,
        now,
        wakeShardCount,
      })
      if (contribution.transactItems.length === 0) continue
      const escalationOwnerUserId = contribution.escalated
        ? await readEscalationOwnerUserId(options.documentClient, tableName, entry)
        : undefined
      const auditItems = createTriageScheduleAuditTransactionItems({
        auditTableName,
        auditRetentionDays,
        entry,
        now,
        breached: contribution.breached,
        escalated: contribution.escalated,
        escalationOwnerUserId,
      })
      try {
        await options.documentClient.send(new TransactWriteCommand({
          TransactItems: [...contribution.transactItems, ...auditItems],
        }))
        if (contribution.resurfaced) result.resurfacedEntries += 1
        if (contribution.breached) result.breachedEntries += 1
        if (contribution.escalated) result.escalatedEntries += 1
        if (contribution.redacted) result.redactedEntries += 1
      } catch (error) {
        if (isConditionalConflict(error)) {
          result.conflicts += 1
          continue
        }
        throw error
      }
    }
  }

  return result
}

/** Builds immutable outbox events for newly fired SLA schedule transitions. */
function createTriageScheduleAuditTransactionItems(input: TriageScheduleAuditInput) {
  const events = [
    ...(input.breached
      ? [createTriageScheduleAuditEvent(
          input,
          'sla-breached',
          input.entry.sla?.dueAt,
          input.entry.ownerUserId,
        )]
      : []),
    ...(input.escalated
      ? [createTriageScheduleAuditEvent(
          input,
          'escalated',
          input.entry.sla?.escalationDueAt,
          input.escalationOwnerUserId ?? input.entry.ownerUserId,
        )]
      : []),
  ]
  return events.map((event) => createAuditEventTransactPut(input.auditTableName, event))
}

/** Creates one deterministic Triage SLA audit event and notification candidate. */
function createTriageScheduleAuditEvent(
  input: TriageScheduleAuditInput,
  kind: 'sla-breached' | 'escalated',
  deadline: string | undefined,
  notificationUserId: string | undefined,
) {
  const eventType = kind === 'sla-breached' ? 'triage.sla-breached' : 'triage.escalated'
  const notificationReason = kind === 'sla-breached' ? 'triage-sla' : 'triage-escalation'
  const notificationMemberKey = readNotificationMemberKey(notificationUserId)
  const digest = createHash('sha256').update([
    input.entry.workspaceId,
    input.entry.id,
    eventType,
    deadline ?? input.now,
  ].join('\0')).digest('hex')
  const context = createMutationAuditContext({
    workspaceId: input.entry.workspaceId,
    actor: {
      id: 'system:triage-schedule',
      kind: 'system',
      displayName: 'Mukuroji Triage schedule',
    },
    idempotencyKey: `triage-schedule-v1:${digest}`,
    occurredAt: input.now,
    request: {
      method: 'SCHEDULE',
      path: '/internal/triage-schedule',
      body: {
        entryId: input.entry.id,
        eventType,
        deadline,
      },
    },
    source: {
      kind: 'system',
      method: 'SCHEDULE',
      route: '/internal/triage-schedule',
    },
  })
  const deepLink = `/teams/${encodeURIComponent(input.entry.teamId)}/triage?entryId=${
    encodeURIComponent(input.entry.id)
  }`
  return createAuditEvent({
    context,
    eventType,
    entity: { type: 'triage-entry', id: input.entry.id },
    action: kind,
    changes: [{
      field: kind === 'sla-breached' ? 'sla.breachedAt' : 'sla.escalatedAt',
      after: input.now,
    }],
    summary: kind === 'sla-breached'
      ? 'Triage response SLA was breached.'
      : 'The triage entry was escalated.',
    metadata: {
      actorMemberKey: 'system:triage-schedule',
      teamId: input.entry.teamId,
      ...(input.entry.projectId ? { projectId: input.entry.projectId } : {}),
      triageEntryId: input.entry.id,
      deepLink,
      notificationTitle: kind === 'sla-breached'
        ? 'Triage SLA breached'
        : 'Triage entry escalated',
      notificationCandidates: notificationMemberKey
        ? [{ memberKey: notificationMemberKey, reason: notificationReason }]
        : [],
    },
    expiresAt: calculateAuditExpiresAt(input.now, input.auditRetentionDays),
    outboxStatus: 'pending',
  })
}

/** Reads the current escalation recipient from the Team configuration row. */
async function readEscalationOwnerUserId(
  documentClient: TriageScheduleDocumentClient,
  tableName: string,
  entry: TriageEntry,
): Promise<string | undefined> {
  const policyId = entry.sla?.policyId
  if (!policyId) return undefined
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      scopeKey: `WORKSPACE#${entry.workspaceId}`,
      recordKey: `TRIAGE_CONFIG#TEAM#${entry.teamId}`,
    },
    ConsistentRead: true,
  }))
  if (!isRecord(response.Item) || response.Item.entryType !== 'triage-configuration') {
    return undefined
  }
  const configuration = response.Item.configuration
  if (!isRecord(configuration) || configuration.workspaceId !== entry.workspaceId ||
    configuration.teamId !== entry.teamId || !Array.isArray(configuration.slaPolicies)) {
    return undefined
  }
  for (const policy of configuration.slaPolicies) {
    if (!isRecord(policy) || policy.id !== policyId) continue
    return readNotificationMemberKey(policy.escalationOwnerUserId)
  }
  return undefined
}

/** Normalizes one bounded Workspace notification member key from persisted state. */
function readNotificationMemberKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return normalized && normalized.length <= 320 &&
      /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(normalized)
    ? normalized
    : undefined
}

/** Reads a KEYS_ONLY GSI result into a base-table key. */
function readPrimaryKey(value: unknown): { scopeKey: string; recordKey: string } | undefined {
  if (!isRecord(value) || typeof value.scopeKey !== 'string' || typeof value.recordKey !== 'string') {
    return undefined
  }
  return { scopeKey: value.scopeKey, recordKey: value.recordKey }
}

/** Classifies a missing or not-yet-active optional index. */
function isUnavailableIndexError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'ResourceNotFoundException') return true
  return error.name === 'ValidationException' &&
    /(?:does not have the specified index|specified index.*(?:does not exist|not found)|index.*(?:not found|backfilling|not active)|backfilling global secondary index)/iu.test(error.message)
}

/** Distinguishes an unavailable index from a missing required base table.
 *
 * @param documentClient Request Intake DocumentClient used by the schedule.
 * @param tableName Required Request Intake table name.
 * @param error Ambiguous query error returned for either a missing table or index.
 * @returns Completion after the base table is confirmed readable.
 */
async function requireBaseTableForUnavailableIndex(
  documentClient: TriageScheduleDocumentClient,
  tableName: string,
  error: unknown,
): Promise<void> {
  if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') return
  await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      scopeKey: 'TRIAGE_INDEX_AVAILABILITY_PROBE',
      recordKey: 'TRIAGE_INDEX_AVAILABILITY_PROBE',
    },
    ConsistentRead: true,
  }))
}

/** Classifies a revision race in a DynamoDB transaction. */
function isConditionalConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'ConditionalCheckFailedException') return true
  if (error.name !== 'TransactionCanceledException') return false
  const cancellationReasons = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(cancellationReasons) || cancellationReasons.length === 0) return false
  let hasConditionalFailure = false
  for (const reason of cancellationReasons) {
    const code = isRecord(reason) ? reason.Code : undefined
    if (code === 'ConditionalCheckFailed') {
      hasConditionalFailure = true
      continue
    }
    if (code !== 'None') return false
  }
  return hasConditionalFailure
}

/** Reads one non-empty environment variable. */
function requireEnvironment(name: string): string {
  const value = readEnvironment(name)
  if (!value) throw new TriageError(500, 'MissingTriageConfiguration', `${name} is required.`)
  return value
}

/** Requires the production audit outbox table configuration. */
function requireAuditTableName(): string {
  const tableName = getConfiguredAuditTableName()
  if (!tableName) {
    throw new TriageError(
      500,
      'MissingTriageConfiguration',
      'AUDIT_EVENTS_TABLE_NAME is required.',
    )
  }
  return tableName
}

/** Reads one optional environment variable. */
function readEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

/** Reads a bounded positive integer environment variable. */
function readPositiveIntegerEnvironment(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = readEnvironment(name)
  return requirePositiveInteger(value === undefined ? fallback : Number(value), name, maximum)
}

/** Requires a bounded positive integer. */
function requirePositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TriageError(500, 'InvalidTriageConfiguration', `${label} is invalid.`)
  }
  return value
}

/** Requires bounded non-empty text. */
function requireText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 1_000) {
    throw new TriageError(500, 'InvalidTriageConfiguration', `${label} is invalid.`)
  }
  return normalized
}

/** Normalizes an event or injected schedule time. */
function normalizeScheduleTime(value: string | undefined): string {
  const date = value === undefined ? new Date() : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new TriageError(400, 'InvalidTriageScheduleEvent', 'The schedule time is invalid.')
  }
  return date.toISOString()
}

/** Checks whether an untrusted value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
