import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  AGENT_RUN_RUNTIMES,
  AGENT_RUN_SCHEMA_VERSION,
  AGENT_SETTINGS_SCHEMA_VERSION,
  AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS,
  type AgentRunOutcome,
  type AgentSettings,
  type UpdateAgentSettingsRequest,
} from '@mukuroji/contracts'
import {
  calculateLeaseExpiry,
  createDefaultAgentSettings,
  type StoredAgentRun,
  type StoredAgentRunClaim,
} from '../../domain/agent-run'
import {
  AgentRunError,
  createAgentRunCommitConflictError,
  createAgentRunIntegrityError,
  createAgentRunNotActiveError,
} from '../../domain/agent-run-error'

/** One item of a DynamoDB write transaction. */
export type AgentRunTransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Index that lists one Work Item's runs by start time. */
export const AGENT_RUN_WORK_ITEM_INDEX_NAME = 'WorkItemRunIndex'

/** Sparse index that lists a Team's active runs by lease expiry. */
export const AGENT_RUN_ACTIVE_INDEX_NAME = 'ActiveRunIndex'

/** Largest page a list query returns. */
const maximumPageSize = 100

/** Minimal DynamoDB command boundary used by the Agent Run store. */
export type AgentRunDocumentClient = {
  /** Sends one read, query, update, or transaction. */
  send(command: GetCommand | QueryCommand | UpdateCommand | TransactWriteCommand): Promise<{
    /** Strongly read item. */
    Item?: Record<string, unknown>
    /** Query page. */
    Items?: Record<string, unknown>[]
    /** Key of the last evaluated item when more items remain. */
    LastEvaluatedKey?: Record<string, unknown>
  }>
}

/** One page of runs and the opaque continuation for the next page. */
export type AgentRunPage = {
  /** Runs in index order. */
  runs: StoredAgentRun[]
  /** Continuation for the next page; absent on the last page. */
  nextCursor?: string
}

/** Persistence port for Agent Runs, claims, and Team Agent settings. */
export interface AgentRunStore {
  /**
   * Strongly reads one run.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param runId - Run ID.
   * @returns The run, or undefined when it does not exist.
   */
  getRun(directoryId: string, teamId: string, runId: string): Promise<StoredAgentRun | undefined>
  /**
   * Strongly reads the claim of one Work Item.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @returns The claim, or undefined when no run holds the Work Item.
   */
  getClaim(directoryId: string, teamId: string, workItemId: string): Promise<StoredAgentRunClaim | undefined>
  /**
   * Strongly reads Team Agent settings.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @returns Saved settings or the defaults at revision 0.
   */
  getSettings(directoryId: string, teamId: string): Promise<AgentSettings>
  /**
   * Replaces Team Agent settings with revision CAS.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param update - Validated update including the expected revision.
   * @param actorMemberKey - Editor.
   * @param now - Save time.
   * @param extraItems - Audit writes committed with the settings.
   * @returns The saved settings.
   */
  saveSettings(
    directoryId: string,
    teamId: string,
    update: UpdateAgentSettingsRequest,
    actorMemberKey: string,
    now: Date,
    extraItems: readonly AgentRunTransactItem[],
  ): Promise<AgentSettings>
  /**
   * Lists one Work Item's runs, newest first.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @param cursor - Continuation from a previous page of the same query.
   * @param limit - Page size from 1 to 100.
   * @returns One page of runs.
   */
  listWorkItemRuns(directoryId: string, teamId: string, workItemId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage>
  /**
   * Lists a Team's active runs, soonest lease expiry first.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param cursor - Continuation from a previous page of the same query.
   * @param limit - Page size from 1 to 100.
   * @returns One page of active runs.
   */
  listActiveRuns(directoryId: string, teamId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage>
  /**
   * Lists a Team's finished runs in storage order.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param cursor - Continuation from a previous page of the same query.
   * @param limit - Evaluated items per page from 1 to 100; a page can be empty and still continue.
   * @returns One page of finished runs.
   */
  listFinishedRuns(directoryId: string, teamId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage>
  /**
   * Builds the writes that create a run and claim its Work Item.
   * @param run - New active run.
   * @returns Run and claim puts that fail when either already exists.
   */
  createStartItems(run: StoredAgentRun): AgentRunTransactItem[]
  /**
   * Builds the writes that fence a Work Item mutation and, for a held run, extend its lease.
   * @param input - Scope, current run, instance hash, and time.
   * @returns Lease update and claim checks to commit with the mutation.
   */
  createMutationFenceItems(input: AgentRunFenceInput): AgentRunTransactItem[]
  /**
   * Builds condition-only checks for writers that accept only ConditionCheck items.
   * @param input - Scope, current run, instance hash, and time.
   * @returns Run and claim condition checks.
   */
  createMutationFenceConditionChecks(input: AgentRunFenceInput): AgentRunTransactItem[]
  /**
   * Builds a check that no run holds a Work Item, for writes that must not race a start.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @returns ConditionCheck that the claim row does not exist.
   */
  createClaimAbsentCheck(directoryId: string, teamId: string, workItemId: string): AgentRunTransactItem
  /**
   * Builds the writes that finish an active run and remove its claim.
   * @param run - Finished form of the run.
   * @returns Run update and claim delete conditioned on the run still being active.
   */
  createCloseItems(run: StoredAgentRun): AgentRunTransactItem[]
  /**
   * Commits a standalone transaction of Agent Run writes and caller items.
   * @param items - Agent Run writes first, then audit or receipt writes.
   * @param fenceItemCount - Number of leading Agent Run writes whose failure means the run changed.
   */
  commit(items: readonly AgentRunTransactItem[], fenceItemCount: number): Promise<void>
  /**
   * Extends a lease in response to an explicit heartbeat, at most once per interval.
   * @param run - Active run.
   * @param now - Heartbeat time.
   * @returns The run with the extended lease.
   */
  heartbeat(run: StoredAgentRun, now: Date): Promise<StoredAgentRun>
  /**
   * Extends a lease after a mutation that could only check the run; a finished run is left as is.
   * @param run - Run that fenced the mutation.
   * @param now - Mutation time.
   */
  extendLeaseAfterMutation(run: StoredAgentRun, now: Date): Promise<void>
}

/** Input for building a mutation fence. */
export type AgentRunFenceInput = {
  /** Workspace ID. */
  directoryId: string
  /** Team ID. */
  teamId: string
  /** Mutated Work Item ID. */
  workItemId: string
  /** Hash of the caller's instance ID. */
  instanceIdHash: string
  /** Active run the caller holds for the Work Item, when it sent one. */
  run?: StoredAgentRun
  /** Mutation time. */
  now: Date
}

/**
 * Builds the Team partition key shared with canonical Work Items.
 *
 * @param directoryId - Workspace ID.
 * @param teamId - Team ID.
 * @returns Partition key.
 */
export function createAgentRunPartition(directoryId: string, teamId: string): string {
  return `${directoryId}#team#${teamId}`
}

/**
 * Builds a run row key.
 *
 * @param runId - Run ID.
 * @returns Sort key.
 */
function runRecordKey(runId: string): string {
  return `agent-run#${runId}`
}

/**
 * Builds a claim row key.
 *
 * @param workItemId - Work Item ID.
 * @returns Sort key.
 */
function claimRecordKey(workItemId: string): string {
  return `agent-run-claim#${workItemId}`
}

/** Sort key of the Team Agent settings row. */
const settingsRecordKey = 'agent-settings'

/**
 * Checks that a value is a record.
 *
 * @param value - Untrusted value.
 * @returns True for a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads a required non-empty string from a stored row.
 *
 * @param item - Stored row.
 * @param name - Attribute name.
 * @returns The value.
 */
function storedString(item: Record<string, unknown>, name: string): string {
  const value = item[name]
  if (typeof value !== 'string' || value.length === 0) throw createAgentRunIntegrityError()
  return value
}

/**
 * Reads an optional string from a stored row.
 *
 * @param item - Stored row.
 * @param name - Attribute name.
 * @returns The value or undefined.
 */
function optionalStoredString(item: Record<string, unknown>, name: string): string | undefined {
  const value = item[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw createAgentRunIntegrityError()
  return value
}

/**
 * Reads a required non-negative integer from a stored row.
 *
 * @param item - Stored row.
 * @param name - Attribute name.
 * @returns The value.
 */
function storedInteger(item: Record<string, unknown>, name: string): number {
  const value = item[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw createAgentRunIntegrityError()
  return value
}

/**
 * Reads a required UTC timestamp from a stored row.
 *
 * @param item - Stored row.
 * @param name - Attribute name.
 * @returns The timestamp.
 */
function storedTimestamp(item: Record<string, unknown>, name: string): string {
  const value = storedString(item, name)
  if (!Number.isFinite(Date.parse(value))) throw createAgentRunIntegrityError()
  return value
}

/**
 * Parses a stored run row and fails closed on any unexpected shape.
 *
 * @param item - Stored row.
 * @param expected - Partition and Team the row must belong to.
 * @returns The run.
 */
function parseRun(
  item: Record<string, unknown>,
  expected: {
    /** Expected Workspace ID. */
    directoryId: string
    /** Expected Team ID. */
    teamId: string
  },
): StoredAgentRun {
  if (item.schemaVersion !== AGENT_RUN_SCHEMA_VERSION || item.entityType !== 'agent-run') {
    throw createAgentRunIntegrityError()
  }
  const runId = storedString(item, 'runId')
  if (
    item.directoryTeamId !== createAgentRunPartition(expected.directoryId, expected.teamId) ||
    item.recordKey !== runRecordKey(runId) ||
    item.workspaceId !== expected.directoryId ||
    item.teamId !== expected.teamId
  ) {
    throw createAgentRunIntegrityError()
  }
  const runtime = AGENT_RUN_RUNTIMES.find((candidate) => candidate === item.runtime)
  const state = item.state === 'active' || item.state === 'finished' ? item.state : undefined
  const outcomes: readonly AgentRunOutcome[] = ['completed', 'paused', 'failed', 'released', 'superseded']
  const outcome = item.outcome === undefined ? undefined : outcomes.find((candidate) => candidate === item.outcome)
  if (!runtime || !state || (item.outcome !== undefined && !outcome) || (state === 'finished') !== (outcome !== undefined)) {
    throw createAgentRunIntegrityError()
  }
  const startRevision = storedInteger(item, 'startRevision')
  const leaseMinutes = storedInteger(item, 'leaseMinutes')
  if (startRevision < 1 || leaseMinutes < 1) throw createAgentRunIntegrityError()
  const finishedAt = item.finishedAt === undefined ? undefined : storedTimestamp(item, 'finishedAt')
  const lastHeartbeatRequestAt = item.lastHeartbeatRequestAt === undefined
    ? undefined
    : storedTimestamp(item, 'lastHeartbeatRequestAt')
  if ((state === 'finished') !== (finishedAt !== undefined)) throw createAgentRunIntegrityError()
  return {
    schemaVersion: AGENT_RUN_SCHEMA_VERSION,
    runId,
    directoryId: expected.directoryId,
    teamId: expected.teamId,
    workItemId: storedString(item, 'workItemId'),
    assigneeUserId: storedString(item, 'assigneeUserId'),
    runtime,
    agentName: storedString(item, 'agentName'),
    instanceIdHash: storedString(item, 'instanceIdHash'),
    credentialId: storedString(item, 'credentialId'),
    state,
    ...(outcome === undefined ? {} : { outcome }),
    startRevision,
    leaseMinutes,
    startedAt: storedTimestamp(item, 'startedAt'),
    lastHeartbeatAt: storedTimestamp(item, 'lastHeartbeatAt'),
    leaseExpiresAt: storedTimestamp(item, 'leaseExpiresAt'),
    ...(lastHeartbeatRequestAt === undefined ? {} : { lastHeartbeatRequestAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(optionalStoredString(item, 'finishedBy') === undefined ? {} : { finishedBy: storedString(item, 'finishedBy') }),
    reportCount: storedInteger(item, 'reportCount'),
  }
}

/**
 * Serializes a run row with its index keys.
 *
 * @param run - Run to store.
 * @returns DynamoDB item.
 */
function serializeRun(run: StoredAgentRun): Record<string, unknown> {
  const partition = createAgentRunPartition(run.directoryId, run.teamId)
  const { directoryId, ...fields } = run
  return {
    directoryTeamId: partition,
    recordKey: runRecordKey(run.runId),
    entityType: 'agent-run',
    workspaceId: directoryId,
    ...fields,
    workItemRunKey: `${partition}#${run.workItemId}`,
    workItemRunSortKey: `${run.startedAt}#${run.runId}`,
    ...(run.state === 'active'
      ? { activeRunPartition: partition, activeRunSortKey: `${run.leaseExpiresAt}#${run.runId}` }
      : {}),
  }
}

/**
 * Encodes a DynamoDB continuation key as an opaque cursor.
 *
 * @param key - LastEvaluatedKey.
 * @returns Base64url cursor or undefined.
 */
function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key === undefined ? undefined : Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

/**
 * Decodes a cursor and checks that it continues the same partition.
 *
 * @param cursor - Opaque cursor from a previous page.
 * @param partitionAttribute - Index partition attribute name.
 * @param partition - Expected partition value.
 * @returns ExclusiveStartKey, or undefined for the first page.
 */
function decodeCursor(cursor: string | undefined, partitionAttribute: string, partition: string): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new AgentRunError('validation_failed', 'The cursor is invalid.', { pointer: '/cursor' })
  }
  if (
    !isRecord(parsed) ||
    parsed[partitionAttribute] !== partition ||
    !Object.values(parsed).every((value) => typeof value === 'string')
  ) {
    throw new AgentRunError('validation_failed', 'The cursor is invalid.', { pointer: '/cursor' })
  }
  return parsed
}

/**
 * Validates a page size.
 *
 * @param limit - Requested size.
 * @returns The size.
 */
function readLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumPageSize) {
    throw new AgentRunError('validation_failed', `limit must be an integer from 1 to ${maximumPageSize}.`, { pointer: '/limit' })
  }
  return limit
}

/**
 * Checks whether a DynamoDB error has a given name.
 *
 * @param error - Thrown value.
 * @param name - Exception name.
 * @returns True when the names match.
 */
function isAwsNamedError(error: unknown, name: string): boolean {
  return isRecord(error) && error.name === name
}

/**
 * Checks whether a transaction was cancelled by a conditional failure within the leading items.
 *
 * @param error - Thrown value.
 * @param count - Number of leading items to inspect.
 * @returns True when one of them failed its condition.
 */
function isLeadingConditionalFailure(error: unknown, count: number): boolean {
  if (!isAwsNamedError(error, 'TransactionCanceledException') || !isRecord(error)) return false
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons)) return false
  return reasons.slice(0, count).some((reason) => isRecord(reason) && reason.Code === 'ConditionalCheckFailed')
}

/** DynamoDB-backed Agent Run store. */
export class DynamoDbAgentRunStore implements AgentRunStore {
  /** Document client configured by the composition root. */
  readonly #client: AgentRunDocumentClient
  /** Agent Runs table name. */
  readonly #tableName: string

  /**
   * Creates the store.
   *
   * @param client - DynamoDB document client.
   * @param tableName - Agent Runs table name.
   */
  constructor(client: AgentRunDocumentClient, tableName: string) {
    this.#client = client
    this.#tableName = tableName
  }

  /** @inheritdoc */
  async getRun(directoryId: string, teamId: string, runId: string): Promise<StoredAgentRun | undefined> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { directoryTeamId: createAgentRunPartition(directoryId, teamId), recordKey: runRecordKey(runId) },
      ConsistentRead: true,
    }))
    return response.Item === undefined ? undefined : parseRun(response.Item, { directoryId, teamId })
  }

  /** @inheritdoc */
  async getClaim(directoryId: string, teamId: string, workItemId: string): Promise<StoredAgentRunClaim | undefined> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { directoryTeamId: createAgentRunPartition(directoryId, teamId), recordKey: claimRecordKey(workItemId) },
      ConsistentRead: true,
    }))
    const item = response.Item
    if (item === undefined) return undefined
    if (item.entityType !== 'agent-run-claim' || item.workItemId !== workItemId || item.workspaceId !== directoryId) {
      throw createAgentRunIntegrityError()
    }
    return {
      workItemId,
      runId: storedString(item, 'runId'),
      instanceIdHash: storedString(item, 'instanceIdHash'),
      assigneeUserId: storedString(item, 'assigneeUserId'),
    }
  }

  /** @inheritdoc */
  async getSettings(directoryId: string, teamId: string): Promise<AgentSettings> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { directoryTeamId: createAgentRunPartition(directoryId, teamId), recordKey: settingsRecordKey },
      ConsistentRead: true,
    }))
    const item = response.Item
    if (item === undefined) return createDefaultAgentSettings(teamId)
    if (
      item.entityType !== 'agent-settings' ||
      item.schemaVersion !== AGENT_SETTINGS_SCHEMA_VERSION ||
      item.workspaceId !== directoryId ||
      item.teamId !== teamId ||
      typeof item.allowTakeoverAfterLeaseExpiry !== 'boolean'
    ) {
      throw createAgentRunIntegrityError()
    }
    const revision = storedInteger(item, 'revision')
    const leaseMinutes = storedInteger(item, 'leaseMinutes')
    if (revision < 1 || leaseMinutes < 1) throw createAgentRunIntegrityError()
    return {
      schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
      teamId,
      revision,
      leaseMinutes,
      allowTakeoverAfterLeaseExpiry: item.allowTakeoverAfterLeaseExpiry,
      updatedAt: storedTimestamp(item, 'updatedAt'),
      updatedBy: storedString(item, 'updatedBy'),
    }
  }

  /** @inheritdoc */
  async saveSettings(
    directoryId: string,
    teamId: string,
    update: UpdateAgentSettingsRequest,
    actorMemberKey: string,
    now: Date,
    extraItems: readonly AgentRunTransactItem[],
  ): Promise<AgentSettings> {
    const settings: AgentSettings = {
      schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
      teamId,
      revision: update.expectedRevision + 1,
      leaseMinutes: update.leaseMinutes,
      allowTakeoverAfterLeaseExpiry: update.allowTakeoverAfterLeaseExpiry,
      updatedAt: now.toISOString(),
      updatedBy: actorMemberKey,
    }
    try {
      await this.#client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.#tableName,
              Item: {
                directoryTeamId: createAgentRunPartition(directoryId, teamId),
                recordKey: settingsRecordKey,
                entityType: 'agent-settings',
                workspaceId: directoryId,
                ...settings,
              },
              ConditionExpression: update.expectedRevision === 0
                ? 'attribute_not_exists(recordKey)'
                : '#revision = :expectedRevision',
              ...(update.expectedRevision === 0
                ? {}
                : {
                    ExpressionAttributeNames: { '#revision': 'revision' },
                    ExpressionAttributeValues: { ':expectedRevision': update.expectedRevision },
                  }),
            },
          },
          ...extraItems,
        ],
      }))
    } catch (error) {
      if (isLeadingConditionalFailure(error, 1)) {
        throw new AgentRunError('conflict', 'Agent settings changed. Reload them before saving.', { pointer: '/expectedRevision' })
      }
      throw error
    }
    return settings
  }

  /** @inheritdoc */
  async listWorkItemRuns(directoryId: string, teamId: string, workItemId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage> {
    const key = `${createAgentRunPartition(directoryId, teamId)}#${workItemId}`
    const response = await this.#client.send(new QueryCommand({
      TableName: this.#tableName,
      IndexName: AGENT_RUN_WORK_ITEM_INDEX_NAME,
      KeyConditionExpression: '#workItemRunKey = :workItemRunKey',
      ExpressionAttributeNames: { '#workItemRunKey': 'workItemRunKey' },
      ExpressionAttributeValues: { ':workItemRunKey': key },
      ScanIndexForward: false,
      Limit: readLimit(limit),
      ExclusiveStartKey: decodeCursor(cursor, 'workItemRunKey', key),
    }))
    const runs = (response.Items ?? []).map((item) => parseRun(item, { directoryId, teamId }))
    if (runs.some((run) => run.workItemId !== workItemId)) throw createAgentRunIntegrityError()
    return this.#page(runs, response.LastEvaluatedKey)
  }

  /** @inheritdoc */
  async listActiveRuns(directoryId: string, teamId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage> {
    const partition = createAgentRunPartition(directoryId, teamId)
    const response = await this.#client.send(new QueryCommand({
      TableName: this.#tableName,
      IndexName: AGENT_RUN_ACTIVE_INDEX_NAME,
      KeyConditionExpression: '#activeRunPartition = :partition',
      ExpressionAttributeNames: { '#activeRunPartition': 'activeRunPartition' },
      ExpressionAttributeValues: { ':partition': partition },
      Limit: readLimit(limit),
      ExclusiveStartKey: decodeCursor(cursor, 'activeRunPartition', partition),
    }))
    // The index is eventually consistent; a run that just finished can still appear once.
    const runs = (response.Items ?? [])
      .map((item) => parseRun(item, { directoryId, teamId }))
      .filter((run) => run.state === 'active')
    return this.#page(runs, response.LastEvaluatedKey)
  }

  /** @inheritdoc */
  async listFinishedRuns(directoryId: string, teamId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage> {
    const partition = createAgentRunPartition(directoryId, teamId)
    const response = await this.#client.send(new QueryCommand({
      TableName: this.#tableName,
      KeyConditionExpression: '#directoryTeamId = :partition AND begins_with(#recordKey, :prefix)',
      FilterExpression: '#state = :finished',
      ExpressionAttributeNames: { '#directoryTeamId': 'directoryTeamId', '#recordKey': 'recordKey', '#state': 'state' },
      ExpressionAttributeValues: { ':partition': partition, ':prefix': 'agent-run#', ':finished': 'finished' },
      Limit: readLimit(limit),
      ExclusiveStartKey: decodeCursor(cursor, 'directoryTeamId', partition),
    }))
    return this.#page((response.Items ?? []).map((item) => parseRun(item, { directoryId, teamId })), response.LastEvaluatedKey)
  }

  /** @inheritdoc */
  createStartItems(run: StoredAgentRun): AgentRunTransactItem[] {
    const partition = createAgentRunPartition(run.directoryId, run.teamId)
    return [
      {
        Put: {
          TableName: this.#tableName,
          Item: serializeRun(run),
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
      {
        Put: {
          TableName: this.#tableName,
          Item: {
            directoryTeamId: partition,
            recordKey: claimRecordKey(run.workItemId),
            entityType: 'agent-run-claim',
            workspaceId: run.directoryId,
            workItemId: run.workItemId,
            runId: run.runId,
            instanceIdHash: run.instanceIdHash,
            assigneeUserId: run.assigneeUserId,
          },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
    ]
  }

  /** @inheritdoc */
  createMutationFenceItems(input: AgentRunFenceInput): AgentRunTransactItem[] {
    if (!input.run) return [this.#claimCheck(input)]
    const leaseExpiresAt = calculateLeaseExpiry(input.now, input.run.leaseMinutes)
    return [
      {
        Update: {
          TableName: this.#tableName,
          Key: { directoryTeamId: createAgentRunPartition(input.directoryId, input.teamId), recordKey: runRecordKey(input.run.runId) },
          UpdateExpression: 'SET #lastHeartbeatAt = :now, #leaseExpiresAt = :leaseExpiresAt, #activeRunSortKey = :activeRunSortKey',
          ConditionExpression: '#state = :active AND #workItemId = :workItemId AND #instanceIdHash = :instanceIdHash',
          ExpressionAttributeNames: {
            '#lastHeartbeatAt': 'lastHeartbeatAt',
            '#leaseExpiresAt': 'leaseExpiresAt',
            '#activeRunSortKey': 'activeRunSortKey',
            '#state': 'state',
            '#workItemId': 'workItemId',
            '#instanceIdHash': 'instanceIdHash',
          },
          ExpressionAttributeValues: {
            ':now': input.now.toISOString(),
            ':leaseExpiresAt': leaseExpiresAt,
            ':activeRunSortKey': `${leaseExpiresAt}#${input.run.runId}`,
            ':active': 'active',
            ':workItemId': input.workItemId,
            ':instanceIdHash': input.instanceIdHash,
          },
        },
      },
      this.#claimCheck(input),
    ]
  }

  /** @inheritdoc */
  createMutationFenceConditionChecks(input: AgentRunFenceInput): AgentRunTransactItem[] {
    if (!input.run) return [this.#claimCheck(input)]
    return [
      {
        ConditionCheck: {
          TableName: this.#tableName,
          Key: { directoryTeamId: createAgentRunPartition(input.directoryId, input.teamId), recordKey: runRecordKey(input.run.runId) },
          ConditionExpression: '#state = :active AND #workItemId = :workItemId AND #instanceIdHash = :instanceIdHash',
          ExpressionAttributeNames: { '#state': 'state', '#workItemId': 'workItemId', '#instanceIdHash': 'instanceIdHash' },
          ExpressionAttributeValues: { ':active': 'active', ':workItemId': input.workItemId, ':instanceIdHash': input.instanceIdHash },
        },
      },
      this.#claimCheck(input),
    ]
  }

  /** @inheritdoc */
  createClaimAbsentCheck(directoryId: string, teamId: string, workItemId: string): AgentRunTransactItem {
    return {
      ConditionCheck: {
        TableName: this.#tableName,
        Key: { directoryTeamId: createAgentRunPartition(directoryId, teamId), recordKey: claimRecordKey(workItemId) },
        ConditionExpression: 'attribute_not_exists(#recordKey)',
        ExpressionAttributeNames: { '#recordKey': 'recordKey' },
      },
    }
  }

  /** @inheritdoc */
  createCloseItems(run: StoredAgentRun): AgentRunTransactItem[] {
    if (run.state !== 'finished' || !run.outcome || !run.finishedAt || !run.finishedBy) {
      throw new TypeError('createCloseItems requires the finished form of a run.')
    }
    const partition = createAgentRunPartition(run.directoryId, run.teamId)
    return [
      {
        Update: {
          TableName: this.#tableName,
          Key: { directoryTeamId: partition, recordKey: runRecordKey(run.runId) },
          UpdateExpression: 'SET #state = :finished, #outcome = :outcome, #finishedAt = :finishedAt, #finishedBy = :finishedBy ' +
            'REMOVE #activeRunPartition, #activeRunSortKey, #lastHeartbeatRequestAt',
          ConditionExpression: '#state = :active',
          ExpressionAttributeNames: {
            '#state': 'state',
            '#outcome': 'outcome',
            '#finishedAt': 'finishedAt',
            '#finishedBy': 'finishedBy',
            '#activeRunPartition': 'activeRunPartition',
            '#activeRunSortKey': 'activeRunSortKey',
            '#lastHeartbeatRequestAt': 'lastHeartbeatRequestAt',
          },
          ExpressionAttributeValues: {
            ':finished': 'finished',
            ':outcome': run.outcome,
            ':finishedAt': run.finishedAt,
            ':finishedBy': run.finishedBy,
            ':active': 'active',
          },
        },
      },
      {
        Delete: {
          TableName: this.#tableName,
          Key: { directoryTeamId: partition, recordKey: claimRecordKey(run.workItemId) },
          ConditionExpression: '#runId = :runId',
          ExpressionAttributeNames: { '#runId': 'runId' },
          ExpressionAttributeValues: { ':runId': run.runId },
        },
      },
    ]
  }

  /** @inheritdoc */
  async commit(items: readonly AgentRunTransactItem[], fenceItemCount: number): Promise<void> {
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems: [...items] }))
    } catch (error) {
      if (isLeadingConditionalFailure(error, fenceItemCount)) throw createAgentRunNotActiveError()
      if (isAwsNamedError(error, 'TransactionCanceledException')) throw createAgentRunCommitConflictError()
      throw error
    }
  }

  /** @inheritdoc */
  async heartbeat(run: StoredAgentRun, now: Date): Promise<StoredAgentRun> {
    const leaseExpiresAt = calculateLeaseExpiry(now, run.leaseMinutes)
    const threshold = new Date(now.getTime() - AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS * 1_000).toISOString()
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { directoryTeamId: createAgentRunPartition(run.directoryId, run.teamId), recordKey: runRecordKey(run.runId) },
        UpdateExpression: 'SET #lastHeartbeatAt = :now, #lastHeartbeatRequestAt = :now, #leaseExpiresAt = :leaseExpiresAt, #activeRunSortKey = :activeRunSortKey',
        ConditionExpression: '#state = :active AND (attribute_not_exists(#lastHeartbeatRequestAt) OR #lastHeartbeatRequestAt <= :threshold)',
        ExpressionAttributeNames: {
          '#lastHeartbeatAt': 'lastHeartbeatAt',
          '#lastHeartbeatRequestAt': 'lastHeartbeatRequestAt',
          '#leaseExpiresAt': 'leaseExpiresAt',
          '#activeRunSortKey': 'activeRunSortKey',
          '#state': 'state',
        },
        ExpressionAttributeValues: {
          ':now': now.toISOString(),
          ':leaseExpiresAt': leaseExpiresAt,
          ':activeRunSortKey': `${leaseExpiresAt}#${run.runId}`,
          ':active': 'active',
          ':threshold': threshold,
        },
      }))
    } catch (error) {
      if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) throw error
      const current = await this.getRun(run.directoryId, run.teamId, run.runId)
      if (!current || current.state !== 'active') throw createAgentRunNotActiveError()
      const last = current.lastHeartbeatRequestAt === undefined ? now.getTime() : Date.parse(current.lastHeartbeatRequestAt)
      const retryAfterSeconds = Math.max(1, Math.ceil((last + AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS * 1_000 - now.getTime()) / 1_000))
      throw new AgentRunError('rate_limited', `Send at most one heartbeat every ${AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS} seconds per run.`, { retryAfterSeconds })
    }
    return {
      ...run,
      lastHeartbeatAt: now.toISOString(),
      lastHeartbeatRequestAt: now.toISOString(),
      leaseExpiresAt,
    }
  }

  /** @inheritdoc */
  async extendLeaseAfterMutation(run: StoredAgentRun, now: Date): Promise<void> {
    const leaseExpiresAt = calculateLeaseExpiry(now, run.leaseMinutes)
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { directoryTeamId: createAgentRunPartition(run.directoryId, run.teamId), recordKey: runRecordKey(run.runId) },
        UpdateExpression: 'SET #lastHeartbeatAt = :now, #leaseExpiresAt = :leaseExpiresAt, #activeRunSortKey = :activeRunSortKey',
        ConditionExpression: '#state = :active AND #lastHeartbeatAt < :now',
        ExpressionAttributeNames: {
          '#lastHeartbeatAt': 'lastHeartbeatAt',
          '#leaseExpiresAt': 'leaseExpiresAt',
          '#activeRunSortKey': 'activeRunSortKey',
          '#state': 'state',
        },
        ExpressionAttributeValues: {
          ':now': now.toISOString(),
          ':leaseExpiresAt': leaseExpiresAt,
          ':activeRunSortKey': `${leaseExpiresAt}#${run.runId}`,
          ':active': 'active',
        },
      }))
    } catch (error) {
      // The mutation already committed under the run fence; a run released since then keeps its state.
      if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) throw error
    }
  }

  /**
   * Builds the claim condition for a fenced mutation.
   *
   * @param input - Fence input.
   * @returns ConditionCheck on the claim row.
   */
  #claimCheck(input: AgentRunFenceInput): AgentRunTransactItem {
    const key = { directoryTeamId: createAgentRunPartition(input.directoryId, input.teamId), recordKey: claimRecordKey(input.workItemId) }
    return input.run
      ? {
          ConditionCheck: {
            TableName: this.#tableName,
            Key: key,
            ConditionExpression: '#runId = :runId AND #instanceIdHash = :instanceIdHash',
            ExpressionAttributeNames: { '#runId': 'runId', '#instanceIdHash': 'instanceIdHash' },
            ExpressionAttributeValues: { ':runId': input.run.runId, ':instanceIdHash': input.instanceIdHash },
          },
        }
      : {
          ConditionCheck: {
            TableName: this.#tableName,
            Key: key,
            ConditionExpression: 'attribute_not_exists(#recordKey) OR #instanceIdHash = :instanceIdHash',
            ExpressionAttributeNames: { '#recordKey': 'recordKey', '#instanceIdHash': 'instanceIdHash' },
            ExpressionAttributeValues: { ':instanceIdHash': input.instanceIdHash },
          },
        }
  }

  /**
   * Builds a page from query results.
   *
   * @param runs - Parsed runs.
   * @param lastEvaluatedKey - Continuation key.
   * @returns Page.
   */
  #page(runs: StoredAgentRun[], lastEvaluatedKey: Record<string, unknown> | undefined): AgentRunPage {
    const nextCursor = encodeCursor(lastEvaluatedKey)
    return { runs, ...(nextCursor === undefined ? {} : { nextCursor }) }
  }
}
