import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  isProjectScheduleBaselineCapturedAt,
  parseProjectScheduleBaselineEntry,
  PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES,
  type ProjectScheduleBaseline,
  type ProjectScheduleBaselineEntry,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../../directory'
import type {
  CaptureProjectScheduleBaselineInput as CaptureInput,
  ProjectScheduleBaselineStore as BaselineStore,
} from '../../application/use-cases/project-schedule-baseline'

/** DynamoDB condition checks that pin the caller's authorization in the same transaction. */
export type ScheduleBaselineCallerAuthorizationCheck = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Capture input with DynamoDB authorization fences. */
export type CaptureProjectScheduleBaselineInput = CaptureInput<ScheduleBaselineCallerAuthorizationCheck>

/** Baseline persistence bound to DynamoDB authorization fences. */
export type ProjectScheduleBaselineStore = BaselineStore<ScheduleBaselineCallerAuthorizationCheck>

/** Planning-table record type of a Project schedule baseline. */
const ENTRY_TYPE = 'project-schedule-baseline'

/**
 * Builds the Planning-table record key of a Project schedule baseline.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns The record key.
 */
function recordKey(teamId: string, projectId: string) {
  return `PROJECT_SCHEDULE_BASELINE#${encodeURIComponent(teamId)}#${encodeURIComponent(projectId)}`
}

/**
 * Rejects a capture holding more entries than one record may store.
 *
 * @param entries - Entries to store.
 */
function assertEntryLimit(entries: readonly ProjectScheduleBaselineEntry[]) {
  if (entries.length > PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES) {
    throw new ProjectDataError(
      413,
      'ScheduleBaselineTooLarge',
      `A schedule baseline can hold at most ${PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES} Work Items.`,
    )
  }
}

/** Stores the latest schedule baseline of each Project as one row in the Planning table. */
export class DynamoDbProjectScheduleBaselineStore implements ProjectScheduleBaselineStore {
  /** Existing Planning table name. */
  private readonly tableName: string
  /** Injected document client. */
  private readonly client: DynamoDBDocumentClient

  /**
   * Creates the store.
   *
   * @param tableName - Existing Planning table.
   * @param client - Configured document client.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient) {
    this.tableName = tableName
    this.client = client
  }

  /**
   * Reads the latest baseline of a Project with a strongly consistent read.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project whose baseline is read.
   * @returns The validated baseline, or `null` when none was captured.
   */
  async get(workspaceId: string, teamId: string, projectId: string): Promise<ProjectScheduleBaseline | null> {
    const key = recordKey(teamId, projectId)
    const { Item: row } = await this.client
      .send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey: key }, ConsistentRead: true }))
      .catch((error: unknown) => storageFailure(error))
    if (row === undefined) return null
    return parseStoredBaseline(row, workspaceId, key)
  }

  /**
   * Replaces the latest baseline, advancing its revision with a compare-and-set.
   *
   * @param input - Capture input.
   * @returns The stored baseline.
   */
  async capture(input: CaptureProjectScheduleBaselineInput): Promise<ProjectScheduleBaseline> {
    assertEntryLimit(input.entries)
    if (input.callerAuthorization.length === 0) {
      throw new ProjectDataError(503, 'ScheduleBaselineAuthorizationUnavailable', 'Caller authorization is unavailable.')
    }
    const key = recordKey(input.teamId, input.projectId)
    const expectedRevision = input.expectedRevision
    const baseline: ProjectScheduleBaseline = {
      revision: expectedRevision + 1,
      capturedAt: input.capturedAt,
      entries: input.entries.map((entry) => ({ ...entry })),
    }
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                workspaceId: input.workspaceId,
                recordKey: key,
                entryType: ENTRY_TYPE,
                schemaVersion: 1,
                teamId: input.teamId,
                projectId: input.projectId,
                ...baseline,
              },
              ConditionExpression: expectedRevision > 0
                ? '#revision = :revision AND #type = :type'
                : 'attribute_not_exists(recordKey)',
              ...(expectedRevision > 0
                ? {
                    ExpressionAttributeNames: { '#revision': 'revision', '#type': 'entryType' },
                    ExpressionAttributeValues: { ':revision': expectedRevision, ':type': ENTRY_TYPE },
                  }
                : {}),
            },
          },
          ...input.callerAuthorization,
        ],
      }))
    } catch (error) {
      return storageFailure(error, input.callerAuthorization.length + 1)
    }
    return baseline
  }
}

/** Isolated store for route and application tests. */
export class InMemoryProjectScheduleBaselineStore implements ProjectScheduleBaselineStore {
  /** Baselines keyed by Workspace, Team, and Project. */
  private readonly baselines = new Map<string, ProjectScheduleBaseline>()

  /**
   * Reads a copy of a Project's baseline.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project whose baseline is read.
   * @returns The baseline, or `null`.
   */
  async get(workspaceId: string, teamId: string, projectId: string): Promise<ProjectScheduleBaseline | null> {
    return structuredClone(this.baselines.get(JSON.stringify([workspaceId, teamId, projectId])) ?? null)
  }

  /**
   * Replaces a Project's baseline.
   *
   * @param input - Capture input.
   * @returns The stored baseline.
   */
  async capture(input: CaptureProjectScheduleBaselineInput): Promise<ProjectScheduleBaseline> {
    assertEntryLimit(input.entries)
    const key = JSON.stringify([input.workspaceId, input.teamId, input.projectId])
    if ((this.baselines.get(key)?.revision ?? 0) !== input.expectedRevision) {
      throw new ProjectDataError(409, 'ScheduleBaselineConflict', 'The schedule baseline changed. Reload and try again.')
    }
    const baseline: ProjectScheduleBaseline = {
      revision: input.expectedRevision + 1,
      capturedAt: input.capturedAt,
      entries: input.entries.map((entry) => ({ ...entry })),
    }
    this.baselines.set(key, structuredClone(baseline))
    return baseline
  }
}

/**
 * Validates a stored baseline row.
 *
 * @param row - Raw DynamoDB item.
 * @param workspaceId - Expected Workspace.
 * @param key - Expected record key.
 * @returns The baseline.
 * @throws ProjectDataError when the row is malformed.
 */
function parseStoredBaseline(row: Record<string, unknown>, workspaceId: string, key: string): ProjectScheduleBaseline {
  const { revision, capturedAt, entries } = row
  if (
    row.workspaceId !== workspaceId ||
    row.recordKey !== key ||
    row.entryType !== ENTRY_TYPE ||
    row.schemaVersion !== 1 ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !isProjectScheduleBaselineCapturedAt(capturedAt) ||
    !Array.isArray(entries) ||
    entries.length > PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES
  ) {
    throw corruptBaseline()
  }
  const parsed: ProjectScheduleBaselineEntry[] = []
  for (const entry of entries) {
    const value = parseProjectScheduleBaselineEntry(entry)
    if (!value) throw corruptBaseline()
    parsed.push(value)
  }
  return { revision, capturedAt, entries: parsed }
}

/**
 * Creates the error for a malformed stored baseline.
 *
 * @returns The error.
 */
function corruptBaseline() {
  return new ProjectDataError(502, 'ScheduleBaselineCorruptState', 'The stored schedule baseline is invalid.')
}

/** DynamoDB cancellation codes that mean the request may succeed if retried. */
const TRANSIENT_CANCELLATION_CODES = ['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']

/**
 * Maps a DynamoDB failure to a Project data error.
 *
 * A transaction cancelled only by failed conditions is a conflict. One cancelled by throttling
 * or a competing transaction is retryable, and any other cancellation is a storage failure.
 *
 * @param error - Thrown SDK error.
 * @param transactionSize - Number of items in the cancelled transaction, or 0 for a plain read.
 * @returns Never; always throws.
 */
function storageFailure(error: unknown, transactionSize = 0): never {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  if (
    name === 'TransactionCanceledException' &&
    typeof error === 'object' &&
    error !== null &&
    'CancellationReasons' in error &&
    Array.isArray(error.CancellationReasons)
  ) {
    const codes = error.CancellationReasons.map((reason: unknown) =>
      typeof reason === 'object' && reason !== null && 'Code' in reason ? String(reason.Code) : undefined)
    if (transactionSize > 0 && codes.length === transactionSize) {
      if (codes.includes('ConditionalCheckFailed') && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')) {
        throw new ProjectDataError(
          409,
          'ScheduleBaselineConflict',
          'The schedule baseline or your permissions changed. Reload and try again.',
        )
      }
      if (
        codes.some((code) => code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)) &&
        codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed' || (code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)))
      ) {
        throw retryableFailure()
      }
    }
  }
  if (
    typeof name === 'string' &&
    ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TransactionInProgressException', 'TimeoutError'].includes(name)
  ) {
    throw retryableFailure()
  }
  throw new ProjectDataError(502, 'ScheduleBaselineStorageFailure', 'Schedule baseline storage request failed.')
}

/**
 * Creates the error for a storage failure that may succeed when retried.
 *
 * @returns The error.
 */
function retryableFailure() {
  return new ProjectDataError(503, 'ScheduleBaselineRetryable', 'Schedule baseline storage is temporarily unavailable.')
}
