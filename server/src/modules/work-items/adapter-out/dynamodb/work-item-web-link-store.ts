import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  parseWorkItemWebLinkTitle,
  parseWorkItemWebLinkUrl,
  WORK_ITEM_WEB_LINK_LIMIT,
  type PublicWorkItemWebLink,
} from '@mukuroji/contracts'
import { createMutationAuditEventPut, type MutationAuditContext } from '../../../audit'
import { ProjectDataError } from '../../../directory'
import type {
  WorkItemWebLinkState,
  WorkItemWebLinkStore as LinkStore,
  WriteWorkItemWebLinksInput as WriteInput,
} from '../../application/use-cases/work-item-web-links'

/** DynamoDB condition checks that pin the Work Item and the caller's access in the same transaction. */
export type WorkItemWebLinkConditionCheck = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Write input bound to DynamoDB condition checks and the request audit context. */
export type WriteWorkItemWebLinksInput = WriteInput<WorkItemWebLinkConditionCheck, MutationAuditContext>

/** Web link persistence bound to DynamoDB condition checks and the request audit context. */
export type WorkItemWebLinkStore = LinkStore<WorkItemWebLinkConditionCheck, MutationAuditContext>

/** Planning-table record type of a Work Item's web links. */
const ENTRY_TYPE = 'work-item-web-links'

/**
 * Builds the Planning-table record key of a Work Item's web links.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns The record key.
 */
function recordKey(teamId: string, workItemId: string) {
  return `WORK_ITEM_WEB_LINKS#${encodeURIComponent(teamId)}#${encodeURIComponent(workItemId)}`
}

/**
 * Rejects a write holding more links than one Work Item may have.
 *
 * @param links - Links to store.
 */
function assertLinkLimit(links: readonly PublicWorkItemWebLink[]) {
  if (links.length > WORK_ITEM_WEB_LINK_LIMIT) {
    throw new ProjectDataError(409, 'WorkItemWebLinkLimitExceeded', `A Work Item can hold at most ${WORK_ITEM_WEB_LINK_LIMIT} links.`)
  }
}

/**
 * Stores the web links of each Work Item as one row in the Planning table (ADR 0109), next to the
 * Project schedule baselines, with a revision compare-and-set and the audit event in one transaction.
 */
export class DynamoDbWorkItemWebLinkStore implements WorkItemWebLinkStore {
  /** Existing Planning table name. */
  private readonly tableName: string
  /** Injected document client. */
  private readonly client: DynamoDBDocumentClient
  /** Audit event table, when audit is configured. */
  private readonly auditTableName: string | undefined

  /**
   * Creates the store.
   *
   * @param tableName - Existing Planning table.
   * @param client - Configured document client.
   * @param auditTableName - Audit event table written in the same transaction, when configured.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient, auditTableName?: string) {
    this.tableName = tableName
    this.client = client
    this.auditTableName = auditTableName
  }

  /**
   * Reads the stored links of a Work Item with a strongly consistent read.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @returns The validated state, or `null` when no link was ever saved.
   */
  async get(workspaceId: string, teamId: string, workItemId: string): Promise<WorkItemWebLinkState | null> {
    const key = recordKey(teamId, workItemId)
    const { Item: row } = await this.client
      .send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey: key }, ConsistentRead: true }))
      .catch((error: unknown) => storageFailure(error))
    if (row === undefined) return null
    return parseStoredLinks(row, workspaceId, key)
  }

  /**
   * Replaces the link list with a compare-and-set on its revision, together with the condition
   * checks and the audit event.
   *
   * @param input - Write input.
   * @returns The stored state.
   */
  async write(input: WriteWorkItemWebLinksInput): Promise<WorkItemWebLinkState> {
    assertLinkLimit(input.links)
    if (input.conditionChecks.length === 0) {
      throw new ProjectDataError(503, 'WorkItemWebLinkAuthorizationUnavailable', 'Caller authorization is unavailable.')
    }
    const state: WorkItemWebLinkState = {
      revision: input.expectedRevision + 1,
      workItemCreatedAt: input.workItemCreatedAt,
      links: input.links.map(copyLink),
    }
    const audit = createWebLinkAuditPut(this.auditTableName, input)
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId: input.workspaceId,
            recordKey: recordKey(input.teamId, input.workItemId),
            entryType: ENTRY_TYPE,
            schemaVersion: 1,
            teamId: input.teamId,
            workItemId: input.workItemId,
            ...state,
            updatedAt: input.writtenAt,
          },
          ConditionExpression: input.expectedRevision > 0
            ? '#revision = :revision AND #type = :type'
            : 'attribute_not_exists(recordKey)',
          ...(input.expectedRevision > 0
            ? {
                ExpressionAttributeNames: { '#revision': 'revision', '#type': 'entryType' },
                ExpressionAttributeValues: { ':revision': input.expectedRevision, ':type': ENTRY_TYPE },
              }
            : {}),
        },
      },
      ...input.conditionChecks,
      ...(audit ? [audit] : []),
    ]
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      return storageFailure(error, transactItems.length)
    }
    return state
  }
}

/**
 * Copies a link into the fields a row stores, leaving out an absent title.
 *
 * @param link - Link to store.
 * @returns The copy.
 */
function copyLink(link: PublicWorkItemWebLink): PublicWorkItemWebLink {
  return {
    id: link.id,
    url: link.url,
    ...(link.title === undefined ? {} : { title: link.title }),
    createdByMemberId: link.createdByMemberId,
    createdAt: link.createdAt,
  }
}

/**
 * Builds the audit event of a link change: `work-item.web-link-added` or `work-item.web-link-removed`.
 * The event keeps the link ID and the URL's host, not the full URL or title, because a path or
 * query can carry a document name or a share token.
 *
 * @param auditTableName - Audit event table, when configured.
 * @param input - Write input.
 * @returns The audit Put, or undefined when audit is not configured.
 */
function createWebLinkAuditPut(auditTableName: string | undefined, input: WriteWorkItemWebLinksInput) {
  const action = webLinkAuditAction(input.change.kind)
  return createMutationAuditEventPut(auditTableName, input.auditContext, {
    directoryId: input.workspaceId,
    eventType: `work-item.${action}`,
    entityType: 'work-item',
    entityId: `team/${input.teamId}/issue/${input.workItemId}`,
    target: { type: 'work-item-web-link', id: input.change.link.id },
    action,
    occurredAt: input.writtenAt,
    changes: [],
    summary: input.change.kind === 'added' ? 'A link was added.' : 'A link was removed.',
    metadata: {
      adapter: 'work-item-web-link',
      teamId: input.teamId,
      workItemId: input.workItemId,
      linkId: input.change.link.id,
      host: new URL(input.change.link.url).host,
      linkCount: input.links.length,
    },
  })
}

/**
 * Names the audited action of a link change.
 *
 * @param kind - Whether a link was added or removed.
 * @returns The action.
 */
function webLinkAuditAction(kind: 'added' | 'removed') {
  return kind === 'added' ? 'web-link-added' : 'web-link-removed'
}

/** Isolated store for route and application tests and local runs without DynamoDB. */
export class InMemoryWorkItemWebLinkStore implements WorkItemWebLinkStore {
  /** States keyed by Workspace, Team, and Work Item. */
  private readonly states = new Map<string, WorkItemWebLinkState>()
  /** Audit events the writes would record, oldest first, for tests to inspect. */
  readonly auditEvents: { eventType: string, workItemId: string, linkId: string, actorId: string }[] = []

  /**
   * Reads a copy of a Work Item's links.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @returns The state, or `null`.
   */
  async get(workspaceId: string, teamId: string, workItemId: string): Promise<WorkItemWebLinkState | null> {
    return structuredClone(this.states.get(JSON.stringify([workspaceId, teamId, workItemId])) ?? null)
  }

  /**
   * Writes a Work Item's links when the revision still matches.
   *
   * @param input - Write input.
   * @returns The stored state.
   */
  async write(input: WriteWorkItemWebLinksInput): Promise<WorkItemWebLinkState> {
    assertLinkLimit(input.links)
    const key = JSON.stringify([input.workspaceId, input.teamId, input.workItemId])
    if ((this.states.get(key)?.revision ?? 0) !== input.expectedRevision) {
      throw new ProjectDataError(409, 'WorkItemWebLinkConflict', 'The links of this Work Item changed. Reload and try again.')
    }
    const state = { revision: input.expectedRevision + 1, workItemCreatedAt: input.workItemCreatedAt, links: input.links.map(copyLink) }
    this.states.set(key, structuredClone(state))
    this.auditEvents.push({
      eventType: `work-item.${webLinkAuditAction(input.change.kind)}`,
      workItemId: input.workItemId,
      linkId: input.change.link.id,
      actorId: input.auditContext.actor.id,
    })
    return state
  }
}

/**
 * Validates a stored link row.
 *
 * @param row - Raw DynamoDB item.
 * @param workspaceId - Expected Workspace.
 * @param key - Expected record key.
 * @returns The state.
 * @throws ProjectDataError when the row is malformed.
 */
function parseStoredLinks(row: Record<string, unknown>, workspaceId: string, key: string): WorkItemWebLinkState {
  const { revision, workItemCreatedAt, links } = row
  if (
    row.workspaceId !== workspaceId ||
    row.recordKey !== key ||
    row.entryType !== ENTRY_TYPE ||
    row.schemaVersion !== 1 ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof workItemCreatedAt !== 'string' ||
    !Array.isArray(links) ||
    links.length > WORK_ITEM_WEB_LINK_LIMIT
  ) {
    throw corruptLinks()
  }
  return { revision, workItemCreatedAt, links: links.map(parseStoredLink) }
}

/**
 * Validates one stored link.
 *
 * @param value - Raw link.
 * @returns The link.
 * @throws ProjectDataError when the link is malformed.
 */
function parseStoredLink(value: unknown): PublicWorkItemWebLink {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw corruptLinks()
  const id: unknown = Reflect.get(value, 'id')
  const url = parseWorkItemWebLinkUrl(Reflect.get(value, 'url'))
  const rawTitle: unknown = Reflect.get(value, 'title')
  const title = parseWorkItemWebLinkTitle(rawTitle)
  const createdByMemberId: unknown = Reflect.get(value, 'createdByMemberId')
  const createdAt: unknown = Reflect.get(value, 'createdAt')
  if (
    typeof id !== 'string' || !/^[0-9a-f]{32}$/u.test(id) ||
    url === undefined || url !== Reflect.get(value, 'url') ||
    title === undefined || (rawTitle !== undefined && title !== rawTitle) ||
    typeof createdByMemberId !== 'string' || createdByMemberId.length === 0 ||
    typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))
  ) {
    throw corruptLinks()
  }
  return { id, url, ...(title === null ? {} : { title }), createdByMemberId, createdAt }
}

/**
 * Creates the error for a malformed stored row.
 *
 * @returns The error.
 */
function corruptLinks() {
  return new ProjectDataError(502, 'WorkItemWebLinkCorruptState', 'The stored links of this Work Item are invalid.')
}

/** DynamoDB cancellation codes that mean the request may succeed if retried. */
const TRANSIENT_CANCELLATION_CODES = ['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']

/**
 * Maps a DynamoDB failure to a Project data error: a transaction cancelled only by failed
 * conditions is a conflict, one cancelled by throttling or a competing transaction is retryable,
 * and anything else is a storage failure.
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
        throw new ProjectDataError(409, 'WorkItemWebLinkConflict', 'The Work Item, its links, or your permissions changed. Reload and try again.')
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
  throw new ProjectDataError(502, 'WorkItemWebLinkStorageFailure', 'Work Item link storage request failed.')
}

/**
 * Creates the error for a storage failure that may succeed when retried.
 *
 * @returns The error.
 */
function retryableFailure() {
  return new ProjectDataError(503, 'WorkItemWebLinkRetryable', 'Work Item link storage is temporarily unavailable.')
}
