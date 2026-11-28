import { createHash } from 'node:crypto'
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import {
  AGENT_RUN_ARTIFACT_PROVIDERS,
  AGENT_RUN_ARTIFACT_UNVERIFIED_REASONS,
  AGENT_RUN_PULL_REQUEST_CHECK_STATES,
  AGENT_RUN_PULL_REQUEST_REVIEW_STATES,
  AGENT_RUN_PULL_REQUEST_STATES,
  type AgentRunArtifactStatus,
  type AgentRunPullRequestStatus,
} from '@mukuroji/contracts'
import { createAgentRunIntegrityError } from '../../domain/agent-run-error'
import { createAgentRunPartition } from './agent-run-store'

/** Schema version of stored artifact status rows. */
export const AGENT_RUN_ARTIFACT_STATUS_SCHEMA_VERSION = 1

/** Minimal DynamoDB command boundary used by the artifact status store. */
export type AgentRunArtifactStatusDocumentClient = {
  /** Sends one read or conditional update. */
  send(command: GetCommand | UpdateCommand): Promise<{
    /** Row a read found. */
    Item?: Record<string, unknown>
    /** Attributes an update returned. */
    Attributes?: Record<string, unknown>
  }>
}

/** Persistence of the verified state of pull request artifacts (ADR 0103). */
export interface AgentRunArtifactStatusStore {
  /**
   * Reads the stored statuses of the given pull request artifacts of one Work Item. Rows of URLs
   * that are no longer reported stay stored, so only the URLs asked for are read.
   *
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @param urls - Artifact URLs to read.
   * @returns The stored statuses, in no particular order; a URL with no row is left out.
   */
  getStatuses(directoryId: string, teamId: string, workItemId: string, urls: readonly string[]): Promise<AgentRunArtifactStatus[]>
  /**
   * Saves statuses. A status checked earlier than the stored one never replaces it, so a slow
   * refresh cannot bring back an older state.
   *
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @param statuses - Statuses to save.
   */
  saveStatuses(directoryId: string, teamId: string, workItemId: string, statuses: readonly AgentRunArtifactStatus[]): Promise<void>
  /**
   * Claims a refresh of one Work Item's statuses. A claim made less than `minimumIntervalMs` ago
   * refuses the next one, so repeated reads call the provider at most once per interval.
   *
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @param now - Claim time.
   * @param minimumIntervalMs - Shortest interval between two refreshes.
   * @returns The refresh sequence (1 for the Work Item's first refresh, one more for each claim
   * after it) when this caller may refresh, or undefined when another refresh was claimed too recently.
   */
  claimRefresh(directoryId: string, teamId: string, workItemId: string, now: Date, minimumIntervalMs: number): Promise<number | undefined>
}

/**
 * Builds the record key prefix of one Work Item's artifact statuses. The Work Item ID is hashed
 * like report keys so the key stays short and free of the separator.
 *
 * @param workItemId - Work Item ID.
 * @returns Record key prefix.
 */
export function artifactStatusRecordKeyPrefix(workItemId: string): string {
  return `agent-run-artifact#${createHash('sha256').update(workItemId).digest('base64url')}#`
}

/**
 * Builds the record key of one artifact status.
 *
 * @param workItemId - Work Item ID.
 * @param url - Artifact URL.
 * @returns Record key.
 */
export function artifactStatusRecordKey(workItemId: string, url: string): string {
  return `${artifactStatusRecordKeyPrefix(workItemId)}${createHash('sha256').update(url).digest('base64url')}`
}

/**
 * Builds the record key of one Work Item's refresh claim.
 *
 * @param workItemId - Work Item ID.
 * @returns Record key.
 */
export function artifactRefreshRecordKey(workItemId: string): string {
  return `agent-run-artifact-refresh#${createHash('sha256').update(workItemId).digest('base64url')}`
}

/** DynamoDB-backed artifact status store in the Agent Runs table. */
export class DynamoDbAgentRunArtifactStatusStore implements AgentRunArtifactStatusStore {
  /** Document client. */
  readonly #client: AgentRunArtifactStatusDocumentClient
  /** Agent Runs table name. */
  readonly #tableName: string

  /**
   * Creates the store.
   *
   * @param client - Document client.
   * @param tableName - Agent Runs table name.
   */
  constructor(client: AgentRunArtifactStatusDocumentClient, tableName: string) {
    this.#client = client
    this.#tableName = tableName
  }

  /** @inheritdoc */
  async getStatuses(directoryId: string, teamId: string, workItemId: string, urls: readonly string[]): Promise<AgentRunArtifactStatus[]> {
    // The caller asks for at most WORK_ITEM_ARTIFACT_STATUS_MAX_ITEMS URLs.
    const items = await Promise.all([...new Set(urls)].map(async (url) => (await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: {
        directoryTeamId: createAgentRunPartition(directoryId, teamId),
        recordKey: artifactStatusRecordKey(workItemId, url),
      },
      ConsistentRead: true,
    }))).Item))
    return items.flatMap((item) => item === undefined ? [] : [parseArtifactStatus(item, directoryId, workItemId)])
  }

  /** @inheritdoc */
  async saveStatuses(directoryId: string, teamId: string, workItemId: string, statuses: readonly AgentRunArtifactStatus[]): Promise<void> {
    await Promise.all(statuses.map(async (status) => {
      try {
        await this.#client.send(new UpdateCommand({
          TableName: this.#tableName,
          Key: {
            directoryTeamId: createAgentRunPartition(directoryId, teamId),
            recordKey: artifactStatusRecordKey(workItemId, status.url),
          },
          // The Workspace ID lets the tenant export and deletion find the row (ADR 0103).
          UpdateExpression: 'SET #schemaVersion = :schemaVersion, #workspaceId = :workspaceId, #workItemId = :workItemId, #status = :status, #checkedAt = :checkedAt',
          ConditionExpression: 'attribute_not_exists(#recordKey) OR #checkedAt < :checkedAt',
          ExpressionAttributeNames: {
            '#recordKey': 'recordKey',
            '#schemaVersion': 'schemaVersion',
            '#workspaceId': 'workspaceId',
            '#workItemId': 'workItemId',
            '#status': 'artifactStatus',
            '#checkedAt': 'checkedAt',
          },
          ExpressionAttributeValues: {
            ':schemaVersion': AGENT_RUN_ARTIFACT_STATUS_SCHEMA_VERSION,
            ':workspaceId': directoryId,
            ':workItemId': workItemId,
            ':status': status,
            ':checkedAt': status.checkedAt,
          },
        }))
      } catch (error) {
        // A newer status is already stored; it wins.
        if (!isConditionalCheckFailure(error)) throw error
      }
    }))
  }

  /** @inheritdoc */
  async claimRefresh(directoryId: string, teamId: string, workItemId: string, now: Date, minimumIntervalMs: number): Promise<number | undefined> {
    try {
      const response = await this.#client.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: {
          directoryTeamId: createAgentRunPartition(directoryId, teamId),
          recordKey: artifactRefreshRecordKey(workItemId),
        },
        // A row written before the count existed starts counting at its next claim.
        UpdateExpression: 'SET #refreshedAt = :now, #workspaceId = :workspaceId, #workItemId = :workItemId ADD #refreshCount :one',
        ConditionExpression: 'attribute_not_exists(#recordKey) OR #refreshedAt <= :threshold',
        ExpressionAttributeNames: {
          '#recordKey': 'recordKey', '#refreshedAt': 'refreshedAt', '#workspaceId': 'workspaceId', '#workItemId': 'workItemId',
          '#refreshCount': 'refreshCount',
        },
        ExpressionAttributeValues: {
          ':now': now.toISOString(),
          ':threshold': new Date(now.getTime() - minimumIntervalMs).toISOString(),
          ':workspaceId': directoryId,
          ':workItemId': workItemId,
          ':one': 1,
        },
        ReturnValues: 'UPDATED_NEW',
      }))
      const count: unknown = response.Attributes?.refreshCount
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) throw createAgentRunIntegrityError()
      return count
    } catch (error) {
      if (isConditionalCheckFailure(error)) return undefined
      throw error
    }
  }
}

/**
 * Checks whether a DynamoDB error is a failed condition.
 *
 * @param error - Caught error.
 * @returns True for a conditional check failure.
 */
function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException'
}

/**
 * Parses one stored artifact status row, refusing a row that does not match its key.
 *
 * @param item - Stored row.
 * @param directoryId - Workspace whose partition the row was read from.
 * @param workItemId - Work Item the row was queried for.
 * @returns The status.
 * @throws AgentRunError temporarily_unavailable for a corrupt row, including one that names
 * another Workspace, since tenant export and deletion find rows by that attribute.
 */
export function parseArtifactStatus(item: Record<string, unknown>, directoryId: string, workItemId: string): AgentRunArtifactStatus {
  const status = readArtifactStatus(item.artifactStatus)
  if (
    item.schemaVersion !== AGENT_RUN_ARTIFACT_STATUS_SCHEMA_VERSION ||
    item.workspaceId !== directoryId ||
    item.workItemId !== workItemId ||
    status === undefined ||
    item.recordKey !== artifactStatusRecordKey(workItemId, status.url)
  ) {
    throw createAgentRunIntegrityError()
  }
  return status
}

/**
 * Reads a stored status value.
 *
 * @param value - Stored value.
 * @returns The status, or undefined when it is malformed.
 */
function readArtifactStatus(value: unknown): AgentRunArtifactStatus | undefined {
  if (!isRecord(value)) return undefined
  const { url, provider, repository, number, verification, unverifiedReason, pullRequest, checkedAt } = value
  if (
    typeof url !== 'string' || url === '' ||
    !isOneOf(AGENT_RUN_ARTIFACT_PROVIDERS, provider) ||
    typeof repository !== 'string' || repository === '' ||
    typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 ||
    typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt))
  ) return undefined
  const base = { url, provider, repository, number, checkedAt }
  if (verification === 'unverified') {
    if (!isOneOf(AGENT_RUN_ARTIFACT_UNVERIFIED_REASONS, unverifiedReason) || pullRequest !== undefined) return undefined
    return { ...base, verification, unverifiedReason }
  }
  if (verification !== 'verified' || unverifiedReason !== undefined) return undefined
  const parsed = readPullRequestStatus(pullRequest)
  return parsed === undefined ? undefined : { ...base, verification, pullRequest: parsed }
}

/**
 * Reads a stored pull request state.
 *
 * @param value - Stored value.
 * @returns The state, or undefined when it is malformed.
 */
function readPullRequestStatus(value: unknown): AgentRunPullRequestStatus | undefined {
  if (!isRecord(value)) return undefined
  const { state, draft, headSha, checks, review, mergedAt, mergeCommitSha } = value
  if (
    !isOneOf(AGENT_RUN_PULL_REQUEST_STATES, state) ||
    typeof draft !== 'boolean' ||
    typeof headSha !== 'string' || headSha === '' ||
    !isOneOf(AGENT_RUN_PULL_REQUEST_CHECK_STATES, checks) ||
    !isOneOf(AGENT_RUN_PULL_REQUEST_REVIEW_STATES, review) ||
    (mergedAt !== undefined && typeof mergedAt !== 'string') ||
    (mergeCommitSha !== undefined && typeof mergeCommitSha !== 'string')
  ) return undefined
  return {
    state,
    draft,
    headSha,
    checks,
    review,
    ...(typeof mergedAt === 'string' ? { mergedAt } : {}),
    ...(typeof mergeCommitSha === 'string' ? { mergeCommitSha } : {}),
  }
}

/**
 * Checks whether a value is a plain record.
 *
 * @param value - Value to check.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether a value is one of a list of string literals.
 *
 * @param values - Allowed values.
 * @param value - Value to check.
 * @returns True when the value is listed.
 */
function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.some((entry) => entry === value)
}
