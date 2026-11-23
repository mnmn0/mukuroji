import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  parseProjectStatusReport,
  PROJECT_STATUS_REPORT_SECTIONS,
  type ProjectStatusReportSection,
  type ProjectStatusShare,
} from '@mukuroji/contracts'
import {
  createMutationAuditContext,
  createMutationAuditEventPut,
  type MutationAuditContext,
} from '../../../audit'
import { ProjectDataError } from '../../../directory'
import type {
  ProjectStatusShareLookup,
  ProjectStatusShareRecord,
  ProjectStatusShareScopeKey,
  ProjectStatusShareStore as ShareStore,
  ProjectStatusShareView,
} from '../../application/project-status-share-use-cases'

/** DynamoDB condition checks that pin the caller's authorization in the same transaction. */
export type ProjectStatusShareCallerAuthorizationCheck = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Share persistence bound to DynamoDB authorization fences and the request audit context. */
export type ProjectStatusShareStore = ShareStore<ProjectStatusShareCallerAuthorizationCheck, MutationAuditContext>

/** Creation input bound to DynamoDB fences. */
type CreateInput = Parameters<ProjectStatusShareStore['create']>[0]
/** Revocation input bound to DynamoDB fences. */
type RevokeInput = Parameters<ProjectStatusShareStore['revoke']>[0]

/** Planning-table record type of one share. */
const SHARE_TYPE = 'project-status-share'
/** Planning-table record type of the row that serializes share creation in a Project. */
const STATE_TYPE = 'project-status-share-state'
/** Planning-table record type of the token lookup row of an open share. */
const TOKEN_TYPE = 'project-status-share-token'
/** Schema version of the share and token rows. */
const SCHEMA_VERSION = 1
/** Route recorded on public view audit events; the token itself is never recorded. */
const PUBLIC_VIEW_ROUTE = '/api/public/project-status/:token'

/**
 * Builds the record key prefix of a Project's shares.
 *
 * @param scope - Team and Project.
 * @returns The prefix.
 */
function sharePrefix(scope: Pick<ProjectStatusShareScopeKey, 'teamId' | 'projectId'>) {
  return `PROJECT_STATUS_SHARE#${encodeURIComponent(scope.teamId)}#${encodeURIComponent(scope.projectId)}#SHARE#`
}

/**
 * Builds the record key of one share.
 *
 * @param scope - Team and Project.
 * @param shareId - Share ID.
 * @returns The record key.
 */
function shareKey(scope: Pick<ProjectStatusShareScopeKey, 'teamId' | 'projectId'>, shareId: string) {
  return `${sharePrefix(scope)}${encodeURIComponent(shareId)}`
}

/**
 * Builds the record key of the row whose revision serializes share creation in a Project. It
 * does not start with the share prefix, so listing shares never reads it.
 *
 * @param scope - Team and Project.
 * @returns The record key.
 */
function stateKey(scope: Pick<ProjectStatusShareScopeKey, 'teamId' | 'projectId'>) {
  return `PROJECT_STATUS_SHARE_STATE#${encodeURIComponent(scope.teamId)}#${encodeURIComponent(scope.projectId)}`
}

/**
 * Builds the record key of the token lookup row, in the same Workspace partition as the share.
 *
 * @param tokenHash - SHA-256 digest of the token secret.
 * @returns The record key.
 */
function tokenKey(tokenHash: string) {
  return `PROJECT_STATUS_SHARE_TOKEN#${tokenHash}`
}

/**
 * Stores each share as one Planning-table row with its redacted report, and an open share's
 * token digest as a lookup row in the same Workspace partition, so deleting the Workspace
 * partition removes both.
 */
export class DynamoDbProjectStatusShareStore implements ProjectStatusShareStore {
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
   * Reads every share of a Project without their report snapshots.
   *
   * @param scope - Team and Project.
   * @returns Every validated share.
   */
  async list(scope: ProjectStatusShareScopeKey): Promise<ProjectStatusShare[]> {
    const shares: ProjectStatusShare[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#workspaceId = :workspaceId AND begins_with(#recordKey, :prefix)',
        // The report snapshot is left out so that listing many shares stays small.
        ProjectionExpression: SHARE_FIELDS.map((_, index) => `#f${index}`).join(', '),
        ExpressionAttributeNames: {
          '#workspaceId': 'workspaceId',
          '#recordKey': 'recordKey',
          ...Object.fromEntries(SHARE_FIELDS.map((field, index) => [`#f${index}`, field])),
        },
        ExpressionAttributeValues: { ':workspaceId': scope.workspaceId, ':prefix': sharePrefix(scope) },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })).catch((error: unknown) => storageFailure(error))
      for (const row of page.Items ?? []) shares.push(parseShareRow(row, scope))
      exclusiveStartKey = page.LastEvaluatedKey
    } while (exclusiveStartKey)
    return shares
  }

  /**
   * Reads one share and its snapshot with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param shareId - Share ID.
   * @returns The record, or `null`.
   */
  async get(scope: ProjectStatusShareScopeKey, shareId: string): Promise<ProjectStatusShareRecord | null> {
    const row = await this.readItem(scope.workspaceId, shareKey(scope, shareId))
    return row ? parseRecord(row, scope) : null
  }

  /**
   * Finds an open share through its token lookup row.
   *
   * @param workspaceId - Workspace named by the token.
   * @param tokenHash - Digest of the token secret.
   * @returns The share, or `null`.
   */
  async findByTokenHash(workspaceId: string, tokenHash: string): Promise<ProjectStatusShareLookup | null> {
    const tokenRow = await this.readItem(workspaceId, tokenKey(tokenHash))
    if (!tokenRow) return null
    if (
      tokenRow.entryType !== TOKEN_TYPE ||
      tokenRow.schemaVersion !== SCHEMA_VERSION ||
      typeof tokenRow.teamId !== 'string' ||
      typeof tokenRow.projectId !== 'string' ||
      typeof tokenRow.shareId !== 'string'
    ) {
      throw corruptShare()
    }
    const scope = { workspaceId, teamId: tokenRow.teamId, projectId: tokenRow.projectId }
    const record = await this.get(scope, tokenRow.shareId)
    if (!record || record.tokenHash !== tokenHash) return null
    return { ...record, scope }
  }

  /**
   * Reads the Project's share creation revision with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @returns The revision, 0 before the first share.
   */
  async readRevision(scope: ProjectStatusShareScopeKey): Promise<number> {
    const row = await this.readItem(scope.workspaceId, stateKey(scope))
    if (!row) return 0
    if (row.entryType !== STATE_TYPE || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) {
      throw corruptShare()
    }
    return row.revision
  }

  /**
   * Stores the share and its token lookup row in one transaction with the caller fences, and
   * advances the Project's revision so that a concurrent creation checked against the same
   * revision fails.
   *
   * @param input - Creation input.
   */
  async create(input: CreateInput): Promise<void> {
    requireCallerAuthorization(input.callerAuthorization)
    const { share, report, tokenHash } = input.record
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'project.status_share_created',
      entityType: 'project',
      entityId: input.projectId,
      target: { type: SHARE_TYPE, id: share.id },
      action: 'status_share_created',
      occurredAt: input.now,
      changes: [],
      metadata: auditMetadata(input, share),
    })
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            ...rowIdentity(input, share.id),
            ...share,
            tokenHash,
            reportJson: JSON.stringify(report),
          },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId: input.workspaceId,
            recordKey: tokenKey(tokenHash),
            entryType: TOKEN_TYPE,
            schemaVersion: SCHEMA_VERSION,
            teamId: input.teamId,
            projectId: input.projectId,
            shareId: share.id,
          },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: { workspaceId: input.workspaceId, recordKey: stateKey(input) },
          UpdateExpression: 'SET #type = :type, #schemaVersion = :schemaVersion, #teamId = :teamId, #projectId = :projectId, #revision = :next, #updatedAt = :now',
          ConditionExpression: input.expectedRevision === 0
            ? 'attribute_not_exists(recordKey)'
            : '#type = :type AND #revision = :expected',
          ExpressionAttributeNames: {
            '#type': 'entryType',
            '#schemaVersion': 'schemaVersion',
            '#teamId': 'teamId',
            '#projectId': 'projectId',
            '#revision': 'revision',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':type': STATE_TYPE,
            ':schemaVersion': SCHEMA_VERSION,
            ':teamId': input.teamId,
            ':projectId': input.projectId,
            ':next': input.expectedRevision + 1,
            ':now': input.now,
            ...(input.expectedRevision === 0 ? {} : { ':expected': input.expectedRevision }),
          },
        },
      },
      ...input.callerAuthorization,
      ...(audit ? [audit] : []),
    ]
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      return storageFailure(error, items.length)
    }
  }

  /**
   * Marks the share revoked and deletes its token lookup row in one transaction.
   *
   * @param input - Revocation input.
   * @returns The revoked share.
   */
  async revoke(input: RevokeInput): Promise<ProjectStatusShare> {
    requireCallerAuthorization(input.callerAuthorization)
    const previous = input.previous.share
    const next: ProjectStatusShare = { ...previous, revokedAt: input.now }
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'project.status_share_revoked',
      entityType: 'project',
      entityId: input.projectId,
      target: { type: SHARE_TYPE, id: previous.id },
      action: 'status_share_revoked',
      occurredAt: input.now,
      changes: [{ field: 'revokedAt', after: input.now }],
      metadata: auditMetadata(input, previous),
    })
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Update: {
          TableName: this.tableName,
          Key: { workspaceId: input.workspaceId, recordKey: shareKey(input, previous.id) },
          UpdateExpression: 'SET #revokedAt = :now',
          ConditionExpression: '#type = :type AND attribute_not_exists(#revokedAt) AND #tokenHash = :tokenHash',
          ExpressionAttributeNames: { '#revokedAt': 'revokedAt', '#type': 'entryType', '#tokenHash': 'tokenHash' },
          ExpressionAttributeValues: { ':now': input.now, ':type': SHARE_TYPE, ':tokenHash': input.previous.tokenHash },
        },
      },
      {
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId: input.workspaceId, recordKey: tokenKey(input.previous.tokenHash) },
        },
      },
      ...input.callerAuthorization,
      ...(audit ? [audit] : []),
    ]
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      return storageFailure(error, items.length)
    }
    return next
  }

  /**
   * Counts a view and records it in audit in one transaction, skipped when a view was counted
   * within the counting window or the share was revoked meanwhile.
   *
   * @param lookup - Share that was opened.
   * @param view - View time and counting window.
   */
  async recordView(lookup: ProjectStatusShareLookup, view: ProjectStatusShareView): Promise<void> {
    const audit = createMutationAuditEventPut(
      this.auditTableName,
      createPublicViewAuditContext(lookup, view.now),
      {
        directoryId: lookup.scope.workspaceId,
        eventType: 'project.status_share_viewed',
        entityType: 'project',
        entityId: lookup.scope.projectId,
        target: { type: SHARE_TYPE, id: lookup.share.id },
        action: 'status_share_viewed',
        occurredAt: view.now,
        changes: [],
        metadata: auditMetadata(lookup.scope, lookup.share),
      },
    )
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: { workspaceId: lookup.scope.workspaceId, recordKey: shareKey(lookup.scope, lookup.share.id) },
              UpdateExpression: 'SET #lastViewedAt = :now ADD #viewCount :one',
              ConditionExpression: '#type = :type AND attribute_not_exists(#revokedAt) AND (attribute_not_exists(#lastViewedAt) OR #lastViewedAt < :countAfter)',
              ExpressionAttributeNames: {
                '#lastViewedAt': 'lastViewedAt',
                '#viewCount': 'viewCount',
                '#revokedAt': 'revokedAt',
                '#type': 'entryType',
              },
              ExpressionAttributeValues: {
                ':now': view.now,
                ':one': 1,
                ':type': SHARE_TYPE,
                ':countAfter': view.countAfter,
              },
            },
          },
          ...(audit ? [audit] : []),
        ],
      }))
    } catch (error) {
      // A view inside the counting window, or of a share revoked meanwhile, is not counted.
      if (readCancellationCodes(error)?.[0] === 'ConditionalCheckFailed') return
      storageFailure(error)
    }
  }

  /**
   * Reads one raw row with a strongly consistent read.
   *
   * @param workspaceId - Workspace partition.
   * @param recordKey - Record key.
   * @returns The raw row, or `undefined`.
   */
  private async readItem(workspaceId: string, recordKey: string): Promise<Record<string, unknown> | undefined> {
    const { Item: row } = await this.client
      .send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey },
        ConsistentRead: true,
      }))
      .catch((error: unknown) => storageFailure(error))
    return row
  }
}

/** Isolated store for route and application tests. */
export class InMemoryProjectStatusShareStore implements ProjectStatusShareStore {
  /** Share records keyed by Workspace, Team, Project, and share. */
  private readonly records = new Map<string, ProjectStatusShareRecord>()
  /** Token digests of open shares, keyed by Workspace and digest. */
  private readonly tokens = new Map<string, { teamId: string; projectId: string; shareId: string }>()
  /** Share creation revisions keyed by Workspace, Team, and Project. */
  private readonly revisions = new Map<string, number>()
  /** Audit events written by the store, for assertions. */
  readonly auditEvents: { action: string; shareId: string; metadata: Record<string, unknown> }[] = []

  /**
   * Reads copies of every share of a Project.
   *
   * @param scope - Team and Project.
   * @returns The shares.
   */
  async list(scope: ProjectStatusShareScopeKey): Promise<ProjectStatusShare[]> {
    const prefix = JSON.stringify([scope.workspaceId, scope.teamId, scope.projectId]).slice(0, -1)
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(`${prefix},`))
      .map(([, record]) => structuredClone(record.share))
  }

  /**
   * Reads a copy of one share.
   *
   * @param scope - Team and Project.
   * @param shareId - Share ID.
   * @returns The record, or `null`.
   */
  async get(scope: ProjectStatusShareScopeKey, shareId: string): Promise<ProjectStatusShareRecord | null> {
    const record = this.records.get(memoryKey(scope, shareId))
    return record ? structuredClone(record) : null
  }

  /**
   * Finds an open share by its token digest.
   *
   * @param workspaceId - Workspace named by the token.
   * @param tokenHash - Digest of the token secret.
   * @returns The share, or `null`.
   */
  async findByTokenHash(workspaceId: string, tokenHash: string): Promise<ProjectStatusShareLookup | null> {
    const token = this.tokens.get(JSON.stringify([workspaceId, tokenHash]))
    if (!token) return null
    const scope = { workspaceId, teamId: token.teamId, projectId: token.projectId }
    const record = await this.get(scope, token.shareId)
    return record ? { ...record, scope } : null
  }

  /**
   * Reads a Project's share creation revision.
   *
   * @param scope - Team and Project.
   * @returns The revision.
   */
  async readRevision(scope: ProjectStatusShareScopeKey): Promise<number> {
    return this.revisions.get(JSON.stringify([scope.workspaceId, scope.teamId, scope.projectId])) ?? 0
  }

  /**
   * Stores a share when the Project's revision is still the one the caller read.
   *
   * @param input - Creation input.
   */
  async create(input: CreateInput): Promise<void> {
    requireCallerAuthorization(input.callerAuthorization)
    const revisionKey = JSON.stringify([input.workspaceId, input.teamId, input.projectId])
    if ((this.revisions.get(revisionKey) ?? 0) !== input.expectedRevision) {
      throw new ProjectDataError(409, 'ProjectStatusShareConflict', 'The share links changed. Reload and try again.')
    }
    this.revisions.set(revisionKey, input.expectedRevision + 1)
    this.records.set(memoryKey(input, input.record.share.id), structuredClone(input.record))
    this.tokens.set(JSON.stringify([input.workspaceId, input.record.tokenHash]), {
      teamId: input.teamId,
      projectId: input.projectId,
      shareId: input.record.share.id,
    })
    this.auditEvents.push({ action: 'status_share_created', shareId: input.record.share.id, metadata: auditMetadata(input, input.record.share) })
  }

  /**
   * Revokes a share.
   *
   * @param input - Revocation input.
   * @returns The revoked share.
   */
  async revoke(input: RevokeInput): Promise<ProjectStatusShare> {
    requireCallerAuthorization(input.callerAuthorization)
    const key = memoryKey(input, input.previous.share.id)
    const record = this.records.get(key)
    if (!record || record.share.revokedAt !== undefined) {
      throw new ProjectDataError(409, 'ProjectStatusShareConflict', 'The share link changed. Reload and try again.')
    }
    record.share = { ...record.share, revokedAt: input.now }
    this.tokens.delete(JSON.stringify([input.workspaceId, record.tokenHash]))
    this.auditEvents.push({ action: 'status_share_revoked', shareId: record.share.id, metadata: auditMetadata(input, record.share) })
    return structuredClone(record.share)
  }

  /**
   * Counts a view outside the counting window.
   *
   * @param lookup - Share that was opened.
   * @param view - View time and counting window.
   */
  async recordView(lookup: ProjectStatusShareLookup, view: ProjectStatusShareView): Promise<void> {
    const record = this.records.get(memoryKey(lookup.scope, lookup.share.id))
    if (!record || record.share.revokedAt !== undefined) return
    if (record.share.lastViewedAt !== undefined && record.share.lastViewedAt >= view.countAfter) return
    record.share = { ...record.share, viewCount: record.share.viewCount + 1, lastViewedAt: view.now }
    this.auditEvents.push({ action: 'status_share_viewed', shareId: record.share.id, metadata: auditMetadata(lookup.scope, record.share) })
  }
}

/** Share fields read by a listing, which leaves out the report snapshot and token digest. */
const SHARE_FIELDS = [
  'workspaceId',
  'recordKey',
  'entryType',
  'schemaVersion',
  'id',
  'teamId',
  'projectId',
  'label',
  'sections',
  'showPeopleNames',
  'expiresAt',
  'createdAt',
  'createdByMemberKey',
  'reportAsOf',
  'revokedAt',
  'customerId',
  'contactId',
  'viewCount',
  'lastViewedAt',
] as const

/**
 * Builds the in-memory key of one share.
 *
 * @param scope - Team and Project.
 * @param shareId - Share ID.
 * @returns The key.
 */
function memoryKey(scope: ProjectStatusShareScopeKey, shareId: string) {
  return JSON.stringify([scope.workspaceId, scope.teamId, scope.projectId, shareId])
}

/**
 * Builds the identity attributes of one share row.
 *
 * @param scope - Team and Project.
 * @param shareId - Share ID.
 * @returns Key, record type, and schema version.
 */
function rowIdentity(scope: ProjectStatusShareScopeKey, shareId: string) {
  return {
    workspaceId: scope.workspaceId,
    recordKey: shareKey(scope, shareId),
    entryType: SHARE_TYPE,
    schemaVersion: SCHEMA_VERSION,
  }
}

/**
 * Builds the audit metadata shared by the create, revoke, and view events.
 *
 * @param scope - Team and Project.
 * @param share - Share.
 * @returns Metadata with the Team, Project, and the customer contact the link was sent to.
 */
function auditMetadata(scope: Pick<ProjectStatusShareScopeKey, 'teamId' | 'projectId'>, share: ProjectStatusShare) {
  return {
    teamId: scope.teamId,
    projectId: scope.projectId,
    shareId: share.id,
    sections: share.sections.join(','),
    showPeopleNames: share.showPeopleNames,
    expiresAt: share.expiresAt,
    ...(share.customerId === undefined ? {} : { customerId: share.customerId }),
    ...(share.contactId === undefined ? {} : { contactId: share.contactId }),
  }
}

/**
 * Builds the audit context of a public view, whose actor is the share link itself.
 *
 * @param lookup - Share that was opened.
 * @param now - View time.
 * @returns The audit context.
 */
function createPublicViewAuditContext(lookup: ProjectStatusShareLookup, now: string): MutationAuditContext {
  return createMutationAuditContext({
    workspaceId: lookup.scope.workspaceId,
    actor: {
      id: `project-status-share:${lookup.share.id}`,
      kind: 'system',
      displayName: lookup.share.label,
    },
    idempotencyKey: `project-status-share-view:${lookup.share.id}:${now}`,
    occurredAt: now,
    request: { method: 'GET', path: PUBLIC_VIEW_ROUTE, body: { shareId: lookup.share.id } },
    source: { kind: 'api', method: 'GET', route: PUBLIC_VIEW_ROUTE },
  })
}

/**
 * Refuses a write without the caller's commit-time authorization fences.
 *
 * @param checks - Caller authorization checks.
 */
function requireCallerAuthorization(checks: readonly unknown[]) {
  if (checks.length === 0) {
    throw new ProjectDataError(503, 'ProjectStatusShareAuthorizationUnavailable', 'Caller authorization is unavailable.')
  }
}

/**
 * Validates a stored share row without its snapshot.
 *
 * @param row - Raw DynamoDB item.
 * @param scope - Expected Workspace, Team, and Project.
 * @returns The share.
 * @throws ProjectDataError when the row is malformed or belongs to another scope.
 */
function parseShareRow(row: Record<string, unknown>, scope: ProjectStatusShareScopeKey): ProjectStatusShare {
  const sections = Array.isArray(row.sections) ? row.sections : undefined
  const knownSections = sections?.flatMap((section): ProjectStatusReportSection[] => {
    const known = PROJECT_STATUS_REPORT_SECTIONS.find((candidate) => candidate === section)
    return known === undefined ? [] : [known]
  })
  const text = (value: unknown) => typeof value === 'string' && value.length > 0
  const optionalText = (value: unknown) => value === undefined || text(value)
  if (
    row.workspaceId !== scope.workspaceId ||
    row.entryType !== SHARE_TYPE ||
    row.schemaVersion !== SCHEMA_VERSION ||
    row.teamId !== scope.teamId ||
    row.projectId !== scope.projectId ||
    typeof row.id !== 'string' ||
    row.recordKey !== shareKey(scope, row.id) ||
    typeof row.label !== 'string' ||
    !knownSections ||
    knownSections.length !== sections?.length ||
    typeof row.showPeopleNames !== 'boolean' ||
    !text(row.expiresAt) ||
    !text(row.createdAt) ||
    !text(row.createdByMemberKey) ||
    !text(row.reportAsOf) ||
    !optionalText(row.revokedAt) ||
    !optionalText(row.customerId) ||
    !optionalText(row.contactId) ||
    !optionalText(row.lastViewedAt) ||
    typeof row.viewCount !== 'number' ||
    !Number.isSafeInteger(row.viewCount) ||
    row.viewCount < 0
  ) {
    throw corruptShare()
  }
  const optional = (name: 'revokedAt' | 'customerId' | 'contactId' | 'lastViewedAt') => {
    const value = row[name]
    return typeof value === 'string' ? { [name]: value } : {}
  }
  return {
    id: row.id,
    teamId: scope.teamId,
    projectId: scope.projectId,
    label: row.label,
    sections: knownSections,
    showPeopleNames: row.showPeopleNames,
    expiresAt: String(row.expiresAt),
    createdAt: String(row.createdAt),
    createdByMemberKey: String(row.createdByMemberKey),
    reportAsOf: String(row.reportAsOf),
    viewCount: row.viewCount,
    ...optional('revokedAt'),
    ...optional('customerId'),
    ...optional('contactId'),
    ...optional('lastViewedAt'),
  }
}

/**
 * Validates a stored share row with its snapshot and token digest.
 *
 * @param row - Raw DynamoDB item.
 * @param scope - Expected Workspace, Team, and Project.
 * @returns The record.
 */
function parseRecord(row: Record<string, unknown>, scope: ProjectStatusShareScopeKey): ProjectStatusShareRecord {
  const share = parseShareRow(row, scope)
  if (typeof row.tokenHash !== 'string' || !/^[0-9a-f]{64}$/u.test(row.tokenHash) || typeof row.reportJson !== 'string') {
    throw corruptShare()
  }
  let stored: unknown
  try {
    stored = JSON.parse(row.reportJson)
  } catch {
    throw corruptShare()
  }
  const report = parseProjectStatusReport(stored)
  if (!report.ok) throw corruptShare()
  return { share, report: report.value, tokenHash: row.tokenHash }
}

/**
 * Creates the error for a malformed stored share.
 *
 * @returns The error.
 */
function corruptShare() {
  return new ProjectDataError(502, 'ProjectStatusShareCorruptState', 'The stored share link is invalid.')
}

/**
 * Reads the cancellation reason codes of a cancelled transaction.
 *
 * @param error - Thrown SDK error.
 * @returns The codes in transaction order, or `undefined` for any other error.
 */
function readCancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('name' in error) ||
    error.name !== 'TransactionCanceledException' ||
    !('CancellationReasons' in error) ||
    !Array.isArray(error.CancellationReasons)
  ) {
    return undefined
  }
  return error.CancellationReasons.map((reason: unknown) =>
    typeof reason === 'object' && reason !== null && 'Code' in reason ? String(reason.Code) : undefined)
}

/** DynamoDB cancellation codes that mean the request may succeed if retried. */
const TRANSIENT_CANCELLATION_CODES = ['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']

/**
 * Maps a DynamoDB failure to a Project data error.
 *
 * @param error - Thrown SDK error.
 * @param transactionSize - Number of items in the cancelled transaction, or 0 for a plain read.
 * @returns Never; always throws.
 */
function storageFailure(error: unknown, transactionSize = 0): never {
  if (error instanceof ProjectDataError) throw error
  const codes = readCancellationCodes(error)
  if (codes && transactionSize > 0 && codes.length === transactionSize) {
    const isConditionOrNone = (code: string | undefined) => code === 'None' || code === 'ConditionalCheckFailed'
    if (codes.includes('ConditionalCheckFailed') && codes.every(isConditionOrNone)) {
      throw new ProjectDataError(409, 'ProjectStatusShareConflict', 'The share link or your permissions changed. Reload and try again.')
    }
    if (
      codes.some((code) => code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)) &&
      codes.every((code) => isConditionOrNone(code) || (code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)))
    ) {
      throw retryableFailure()
    }
  }
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  if (
    typeof name === 'string' &&
    ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TransactionInProgressException', 'TimeoutError'].includes(name)
  ) {
    throw retryableFailure()
  }
  throw new ProjectDataError(502, 'ProjectStatusShareStorageFailure', 'Share link storage request failed.')
}

/**
 * Creates the error for a storage failure that may succeed when retried.
 *
 * @returns The error.
 */
function retryableFailure() {
  return new ProjectDataError(503, 'ProjectStatusShareRetryable', 'Share link storage is temporarily unavailable.')
}

