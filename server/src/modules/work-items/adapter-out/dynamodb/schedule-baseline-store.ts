import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  parseProjectScheduleBaselineEntry,
  PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES,
  type ProjectScheduleBaseline,
  type ProjectScheduleBaselineEntry,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../../directory'

/** DynamoDB condition checks that pin the caller's authorization in the same transaction. */
export type ScheduleBaselineCallerAuthorizationCheck = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Input of one Project schedule baseline capture. */
export type CaptureProjectScheduleBaselineInput = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project whose baseline is captured. */
  projectId: string
  /** Frozen planned dates of every Work Item in the Project. */
  entries: readonly ProjectScheduleBaselineEntry[]
  /** Capture time as an ISO timestamp. */
  capturedAt: string
  /** Server-built conditions that fail the write when the caller lost access. */
  callerAuthorization: readonly ScheduleBaselineCallerAuthorizationCheck[]
}

/** Persistence port for the latest schedule baseline of each Project. */
export type ProjectScheduleBaselineStore = {
  /**
   * Reads the latest baseline of a Project.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project whose baseline is read.
   * @returns The baseline with every entry, or `null` when none was captured.
   */
  get(workspaceId: string, teamId: string, projectId: string): Promise<ProjectScheduleBaseline | null>
  /**
   * Replaces the latest baseline of a Project.
   *
   * @param input - Capture input.
   * @returns The stored baseline.
   */
  capture(input: CaptureProjectScheduleBaselineInput): Promise<ProjectScheduleBaseline>
}

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
    const previous = await this.get(input.workspaceId, input.teamId, input.projectId)
    const baseline: ProjectScheduleBaseline = {
      revision: (previous?.revision ?? 0) + 1,
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
              ConditionExpression: previous
                ? '#revision = :revision AND #type = :type'
                : 'attribute_not_exists(recordKey)',
              ...(previous
                ? {
                    ExpressionAttributeNames: { '#revision': 'revision', '#type': 'entryType' },
                    ExpressionAttributeValues: { ':revision': previous.revision, ':type': ENTRY_TYPE },
                  }
                : {}),
            },
          },
          ...input.callerAuthorization,
        ],
      }))
    } catch (error) {
      return storageFailure(error)
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
    const baseline: ProjectScheduleBaseline = {
      revision: (this.baselines.get(key)?.revision ?? 0) + 1,
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
    typeof capturedAt !== 'string' ||
    !Array.isArray(entries)
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

/**
 * Maps a DynamoDB failure to a Project data error.
 *
 * @param error - Thrown SDK error.
 * @returns Never; always throws.
 */
function storageFailure(error: unknown): never {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  if (name === 'TransactionCanceledException' || name === 'ConditionalCheckFailedException') {
    throw new ProjectDataError(
      409,
      'ScheduleBaselineConflict',
      'The schedule baseline or your permissions changed. Reload and try again.',
    )
  }
  if (
    typeof name === 'string' &&
    ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TimeoutError'].includes(name)
  ) {
    throw new ProjectDataError(503, 'ScheduleBaselineRetryable', 'Schedule baseline storage is temporarily unavailable.')
  }
  throw new ProjectDataError(502, 'ScheduleBaselineStorageFailure', 'Schedule baseline storage request failed.')
}
