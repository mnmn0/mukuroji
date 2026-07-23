import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import type {
  ExternalWorkItemLink,
  WorkItemSyncConflict,
} from '@mukuroji/contracts'
import {
  createMutationAuditContext,
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
} from '../../../audit'
import {
  createConnectorPollTargetLookupKey,
  createConnectorPollTargetRecordKey,
} from '../../connector-poll-projection'
import {
  ConnectorRuntimeError,
} from '../../connector-oauth'
import type {
  CommitConnectorSyncStateInput,
  ConnectorSyncConflictPage,
  ConnectorSyncPersistence,
  PersistedConnectorSyncState,
  StoredConnectorSyncConflict,
} from '../../connector-sync-runtime'

/** Stuck conflict resolution claim を takeover できるまでの既定秒数です。 */
export const CONNECTOR_CONFLICT_RESOLUTION_LEASE_SECONDS = 15 * 60

/** Maximum conditional-write retries for one conflict resolution claim. */
const CONNECTOR_CONFLICT_CLAIM_MAX_RETRIES = 3

/** Public conflict cursor の既定有効期間秒数です。 */
export const CONNECTOR_SYNC_CURSOR_TTL_SECONDS = 15 * 60

/** DynamoDB connector sync store の構築 options です。 */
export type DynamoDbConnectorSyncPersistenceOptions = {
  /** Developer platform single-table 名です。 */
  tableName?: string
  /** Immutable audit/Webhook outbox table 名です。 */
  auditTableName?: string
  /** Test または shared runtime が注入する DocumentClient です。 */
  documentClient?: DynamoDBDocumentClient
  /** detectedAt 順の conflict cursor に使う GSI 名です。 */
  lookupIndexName?: string
  /** Resolution lease expiry 判定に使う clock です。 */
  clock?: () => Date
  /** Stuck resolution claim を takeover できるまでの秒数です。 */
  resolutionLeaseSeconds?: number
  /** Cursor HMAC と production 判定に使う environment です。 */
  environment?: Readonly<Record<string, string | undefined>>
  /** 新規 cursor を署名する current HMAC secret です。 */
  cursorSigningSecret?: string
  /** Rotation grace period 中に検証だけ許可する旧 HMAC secrets です。 */
  previousCursorSigningSecrets?: readonly string[]
  /** Cursor の有効期間秒数です。 */
  cursorTtlSeconds?: number
}

/** Connector sync state の single-table row です。 */
type ConnectorSyncStateRow = {
  /** Workspace partition key です。 */
  workspaceId: string
  /** Link-scoped sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'connector-sync-state'
  /** Durable sync state です。 */
  value: PersistedConnectorSyncState
  /** Storage CAS revision です。 */
  version: number
}

/** Connector sync conflict の single-table row です。 */
type ConnectorSyncConflictRow = {
  /** Workspace partition key です。 */
  workspaceId: string
  /** Conflict-scoped sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'connector-sync-conflict'
  /** Public conflict と resolution 用 private snapshot です。 */
  value: StoredConnectorSyncConflict
  /** Storage CAS revision です。 */
  version: number
  /** Workspace-scoped conflict index partition key です。 */
  lookupKey: string
  /** detectedAt + conflict ID の stable index sort key です。 */
  lookupSortKey: string
}

/** Developer platform の external-link row 必要部分です。 */
type ExternalLinkRow = {
  /** Workspace partition key です。 */
  workspaceId: string
  /** External link sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'external-link'
  /** Public external link snapshot です。 */
  value: ExternalWorkItemLink
  /** Storage CAS revision です。 */
  version: number
  /** Legacy sparse GSI partition key です。replacement時に除去します。 */
  lookupKey?: string
  /** Legacy sparse GSI sort key です。replacement時に除去します。 */
  lookupSortKey?: string
}

/** DeveloperPlatformTable に connector sync state/conflict を永続化します。 */
export class DynamoDbConnectorSyncPersistence implements ConnectorSyncPersistence {
  /** Developer platform single-table 名です。 */
  private readonly tableName: string
  /** Immutable audit/Webhook outbox table 名です。 */
  private readonly auditTableName: string
  /** DynamoDB document client です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Conflict ordering に使う lookup GSI 名です。 */
  private readonly lookupIndexName: string
  /** Resolution lease expiry 判定に使う clock です。 */
  private readonly clock: () => Date
  /** Stuck resolution claim を takeover できるまでの秒数です。 */
  private readonly resolutionLeaseSeconds: number
  /** 新規 public cursor を署名する HMAC secret です。 */
  private readonly cursorSigningSecret: string
  /** Current と rotation grace period 中の旧 cursor HMAC secrets です。 */
  private readonly cursorVerificationSecrets: readonly string[]
  /** Public cursor の有効期間秒数です。 */
  private readonly cursorTtlSeconds: number

  /** Environment または明示 options から durable store を作成します。 */
  constructor(options: DynamoDbConnectorSyncPersistenceOptions = {}) {
    const environment = options.environment ?? process.env
    const production = isProductionEnvironment(environment)
    const configuredTableName = options.tableName ??
      environment.DEVELOPER_PLATFORM_TABLE_NAME?.trim()
    if (production && !configuredTableName) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncPersistenceConfigurationMissing',
        'Developer platform table name is required in production.',
      )
    }
    this.tableName = requireText(
      configuredTableName ??
        'mukuroji-developer-platform-local',
      'Developer platform table name',
    )
    const auditTableName = options.auditTableName ??
      getConfiguredAuditTableName(environment)
    if (!auditTableName) {
      throw new ConnectorRuntimeError(
        'ConnectorAuditOutboxUnavailable',
        'Connector sync requires a durable audit outbox table.',
      )
    }
    this.auditTableName = auditTableName
    this.documentClient = options.documentClient ?? createDocumentClient(environment)
    const configuredLookupIndexName = options.lookupIndexName ??
      environment.DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME?.trim()
    if (production && !configuredLookupIndexName) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncPersistenceConfigurationMissing',
        'Developer platform lookup index name is required in production.',
      )
    }
    this.lookupIndexName = requireText(
      configuredLookupIndexName ??
        'LookupKeyIndex',
      'Developer platform lookup index name',
    )
    this.clock = options.clock ?? (() => new Date())
    this.resolutionLeaseSeconds = options.resolutionLeaseSeconds ??
      CONNECTOR_CONFLICT_RESOLUTION_LEASE_SECONDS
    if (
      !Number.isSafeInteger(this.resolutionLeaseSeconds) ||
      this.resolutionLeaseSeconds < 60 ||
      this.resolutionLeaseSeconds > 60 * 60
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncResolutionLeaseInvalid',
        'Connector sync resolution lease must be between 60 and 3600 seconds.',
      )
    }
    const configuredCursorSigningSecret = options.cursorSigningSecret ??
      environment.CONNECTOR_SYNC_CURSOR_SIGNING_SECRET?.trim() ??
      environment.CONNECTOR_SYNC_ORIGIN_SIGNING_SECRET?.trim()
    if (production && !configuredCursorSigningSecret) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncPersistenceConfigurationMissing',
        'Connector sync cursor signing secret is required in production.',
      )
    }
    this.cursorSigningSecret = requireSigningSecret(
      configuredCursorSigningSecret ??
        'mukuroji-local-connector-sync-cursor-signing-secret',
    )
    const previousCursorSigningSecrets =
      options.previousCursorSigningSecrets ??
      readPreviousSigningSecrets(
        environment.CONNECTOR_SYNC_CURSOR_PREVIOUS_SIGNING_SECRETS_JSON,
      )
    if (previousCursorSigningSecrets.length > 3) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncCursorSigningSecretInvalid',
        'Connector sync cursor supports up to three previous signing secrets.',
      )
    }
    this.cursorVerificationSecrets = [
      this.cursorSigningSecret,
      ...previousCursorSigningSecrets.map(requireSigningSecret),
    ]
    this.cursorTtlSeconds = options.cursorTtlSeconds ??
      CONNECTOR_SYNC_CURSOR_TTL_SECONDS
    if (
      !Number.isSafeInteger(this.cursorTtlSeconds) ||
      this.cursorTtlSeconds < 60 ||
      this.cursorTtlSeconds > 24 * 60 * 60
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncCursorTtlInvalid',
        'Connector sync cursor TTL must be between 60 and 86400 seconds.',
      )
    }
  }

  /** Link の current sync state を強整合取得します。 */
  async getLinkState(workspaceIdValue: string, linkIdValue: string) {
    const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
    const linkId = requireIdentifier(linkIdValue, 'External link ID')
    const item = await this.getRow(workspaceId, syncStateRecordKey(linkId))
    if (!item) return undefined
    return structuredClone(readSyncStateRow(item).value)
  }

  /** Expected storage revision と一致する場合だけ sync checkpoint を保存します。 */
  async commitLinkState(input: CommitConnectorSyncStateInput) {
    const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
    const linkId = requireIdentifier(input.link.id, 'External link ID')
    const installationId = requireIdentifier(
      input.link.installationId,
      'Connector installation ID',
    )
    if (
      input.link.syncStatus === 'paused' ||
      input.link.syncDirection === 'none'
    ) return false
    const recordKey = syncStateRecordKey(linkId)
    const currentValue = await this.getRow(workspaceId, recordKey)
    const current = currentValue ? readSyncStateRow(currentValue) : undefined
    if (
      (current?.value.storageRevision ?? undefined) !==
        input.expectedStorageRevision
    ) {
      return false
    }
    const linkValue = await this.getRow(
      workspaceId,
      externalLinkRecordKey(linkId),
    )
    if (!linkValue) return false
    const currentLink = readExternalLinkRow(linkValue)
    if (
      currentLink.value.id !== linkId ||
      currentLink.value.installationId !== installationId ||
      currentLink.value.updatedAt !== input.link.updatedAt ||
      currentLink.value.syncDirection !== input.link.syncDirection ||
      currentLink.value.syncStatus !== input.link.syncStatus ||
      (!input.deferLinkStatus && currentLink.value.syncStatus === 'conflict')
    ) return false
    const syncedAt = requireTimestamp(
      input.syncedAt,
      'Connector sync timestamp',
    )
    const state: PersistedConnectorSyncState = {
      installationId,
      linkId,
      workItemRevision: requirePositiveInteger(
        input.workItemRevision,
        'Work Item revision',
      ),
      lastExternalVersion: requireText(
        input.externalRecord.externalVersion,
        'External version',
      ),
      ...(input.eventId
        ? { lastExternalEventId: requireText(input.eventId, 'External event ID') }
        : {}),
      storageRevision: (current?.value.storageRevision ?? 0) + 1,
      lastExternalRecord: structuredClone(input.externalRecord),
      lastSyncedAt: syncedAt,
    }
    const row: ConnectorSyncStateRow = {
      workspaceId,
      recordKey,
      entryType: 'connector-sync-state',
      value: state,
      version: (current?.version ?? 0) + 1,
    }
    const syncedLink: ExternalWorkItemLink = {
      ...currentLink.value,
      syncStatus: 'synced',
      updatedAt: syncedAt,
      lastSyncedAt: syncedAt,
    }
    const nextLink = createExternalLinkReplacementRow(currentLink, syncedLink)
    const pollTargetUpdate = input.deferLinkStatus
      ? undefined
      : createPollTargetDeltaUpdate(
          this.tableName,
          workspaceId,
          currentLink.value,
          syncedLink,
        )
    const auditPut = input.deferLinkStatus
      ? undefined
      : createPlatformAuditPut(this.auditTableName, {
          workspaceId,
          eventType: 'external-link.updated',
          entityType: 'external-link',
          entityId: syncedLink.id,
          transitionId: `synced:${state.storageRevision}:${syncedAt}`,
          teamId: syncedLink.teamId,
          occurredAt: syncedAt,
          action: 'updated',
          summary: 'External Work Item link synchronization state changed.',
          metadata: {
            externalLinkId: syncedLink.id,
            workItemId: syncedLink.workItemId,
            installationId: syncedLink.installationId,
            resourceType: syncedLink.resourceType,
            syncDirection: syncedLink.syncDirection,
            syncStatus: syncedLink.syncStatus,
          },
        })
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          current
            ? createVersionedPut(this.tableName, row, current.version)
            : {
                Put: {
                  TableName: this.tableName,
                  Item: row,
                  ConditionExpression:
                    'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
                },
              },
          input.deferLinkStatus
            ? {
                ConditionCheck: {
                  TableName: this.tableName,
                  Key: { workspaceId, recordKey: externalLinkRecordKey(linkId) },
                  ConditionExpression: '#version = :expectedVersion',
                  ExpressionAttributeNames: { '#version': 'version' },
                  ExpressionAttributeValues: {
                    ':expectedVersion': currentLink.version,
                  },
                },
              }
            : createVersionedPut(
                this.tableName,
                nextLink,
                currentLink.version,
              ),
          createActiveConnectorConditionCheck(
            this.tableName,
            workspaceId,
            installationId,
          ),
          ...(pollTargetUpdate ? [pollTargetUpdate] : []),
          ...(auditPut ? [auditPut] : []),
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw persistenceFailure(error)
    }
  }

  /** Link status と external-link.updated outbox event を原子的に保存します。 */
  async setLinkStatus(
    workspaceIdValue: string,
    linkIdValue: string,
    status: ExternalWorkItemLink['syncStatus'],
    updatedAtValue: string,
  ) {
    const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
    const linkId = requireIdentifier(linkIdValue, 'External link ID')
    const updatedAt = requireTimestamp(updatedAtValue, 'External link update timestamp')
    const rowValue = await this.getRow(workspaceId, externalLinkRecordKey(linkId))
    if (!rowValue) {
      throw new ConnectorRuntimeError(
        'ExternalWorkItemLinkNotFound',
        'External Work Item link was not found.',
      )
    }
    const row = readExternalLinkRow(rowValue)
    const normalizedStatus = requireSyncStatus(status)
    if (
      normalizedStatus !== 'paused' &&
      (row.value.syncStatus === 'paused' || row.value.syncDirection === 'none')
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncPaused',
        'Paused external links cannot be resumed by a connector worker.',
      )
    }
    if (
      row.value.syncStatus === normalizedStatus &&
      row.value.updatedAt === updatedAt
    ) return
    const link: ExternalWorkItemLink = {
      ...row.value,
      syncStatus: normalizedStatus,
      updatedAt,
      ...(normalizedStatus === 'synced' ? { lastSyncedAt: updatedAt } : {}),
    }
    const next = createExternalLinkReplacementRow(row, link)
    const pollTargetUpdate = createPollTargetDeltaUpdate(
      this.tableName,
      workspaceId,
      row.value,
      link,
    )
    const auditPut = createPlatformAuditPut(this.auditTableName, {
      workspaceId,
      eventType: 'external-link.updated',
      entityType: 'external-link',
      entityId: link.id,
      transitionId: `${normalizedStatus}:${updatedAt}`,
      teamId: link.teamId,
      occurredAt: updatedAt,
      action: 'updated',
      summary: 'External Work Item link synchronization state changed.',
      metadata: {
        externalLinkId: link.id,
        workItemId: link.workItemId,
        installationId: link.installationId,
        resourceType: link.resourceType,
        syncDirection: link.syncDirection,
        syncStatus: link.syncStatus,
      },
    })
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          createVersionedPut(this.tableName, next, row.version),
          ...(normalizedStatus === 'paused'
            ? []
            : [createActiveConnectorConditionCheck(
                this.tableName,
                workspaceId,
                link.installationId,
              )]),
          ...(pollTargetUpdate ? [pollTargetUpdate] : []),
          auditPut,
        ],
      }))
    } catch (error) {
      if (isTransactionConditionFailure(error)) {
        throw new ConnectorRuntimeError(
          'ConnectorSyncStateConflict',
          'External link state changed concurrently.',
          { retryable: true },
        )
      }
      throw persistenceFailure(error)
    }
  }

  /** Poll inventory generation と一致する pending link だけを synced へ CAS 遷移します。 */
  async acknowledgePendingLink(
    workspaceIdValue: string,
    linkIdValue: string,
    expectedUpdatedAtValue: string,
    expectedExternalVersionValue: string,
    expectedStateRevisionValue: number,
    syncedAtValue: string,
  ) {
    const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
    const linkId = requireIdentifier(linkIdValue, 'External link ID')
    const expectedUpdatedAt = requireTimestamp(
      expectedUpdatedAtValue,
      'Expected external link update timestamp',
    )
    const expectedExternalVersion = requireText(
      expectedExternalVersionValue,
      'Expected external version',
    )
    const expectedStateRevision = requirePositiveInteger(
      expectedStateRevisionValue,
      'Expected connector sync state revision',
    )
    const syncedAt = requireTimestamp(
      syncedAtValue,
      'Connector sync timestamp',
    )
    const rowValue = await this.getRow(workspaceId, externalLinkRecordKey(linkId))
    if (!rowValue) return false
    const row = readExternalLinkRow(rowValue)
    if (
      row.value.syncStatus !== 'pending' ||
      row.value.updatedAt !== expectedUpdatedAt ||
      (
        row.value.syncDirection !== 'inbound' &&
        row.value.syncDirection !== 'bidirectional'
      )
    ) return false
    const link: ExternalWorkItemLink = {
      ...row.value,
      syncStatus: 'synced',
      updatedAt: syncedAt,
      lastSyncedAt: syncedAt,
    }
    const next = createExternalLinkReplacementRow(row, link)
    const pollTargetUpdate = createPollTargetDeltaUpdate(
      this.tableName,
      workspaceId,
      row.value,
      link,
    )
    const auditPut = createPlatformAuditPut(this.auditTableName, {
      workspaceId,
      eventType: 'external-link.updated',
      entityType: 'external-link',
      entityId: link.id,
      transitionId: `pending-poll-ack:${expectedUpdatedAt}:${syncedAt}`,
      teamId: link.teamId,
      occurredAt: syncedAt,
      action: 'updated',
      summary: 'External Work Item link pending synchronization was acknowledged.',
      metadata: {
        externalLinkId: link.id,
        workItemId: link.workItemId,
        installationId: link.installationId,
        resourceType: link.resourceType,
        syncDirection: link.syncDirection,
        syncStatus: link.syncStatus,
      },
    })
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          createVersionedPut(this.tableName, next, row.version),
          {
            ConditionCheck: {
              TableName: this.tableName,
              Key: {
                workspaceId,
                recordKey: syncStateRecordKey(linkId),
              },
              ConditionExpression:
                '#entryType = :entryType AND #version = :expectedStateRevision AND ' +
                '#value.#lastExternalVersion = :expectedExternalVersion',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#version': 'version',
                '#value': 'value',
                '#lastExternalVersion': 'lastExternalVersion',
              },
              ExpressionAttributeValues: {
                ':entryType': 'connector-sync-state',
                ':expectedStateRevision': expectedStateRevision,
                ':expectedExternalVersion': expectedExternalVersion,
              },
            },
          },
          createActiveConnectorConditionCheck(
            this.tableName,
            workspaceId,
            link.installationId,
          ),
          ...(pollTargetUpdate ? [pollTargetUpdate] : []),
          auditPut,
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw persistenceFailure(error)
    }
  }

  /** Deterministic conflict ID と sync-conflict.created outbox event を原子的に作成します。 */
  async createConflict(recordValue: StoredConnectorSyncConflict) {
    const record = normalizeConflictRecord(recordValue)
    const recordKey = conflictRecordKey(record.conflict.id)
    const existingValue = await this.getRow(record.workspaceId, recordKey)
    if (existingValue) {
      const existing = readConflictRow(existingValue).value
      if (!sameConflictIdentity(existing, record)) {
        throw new ConnectorRuntimeError(
          'ConnectorSyncConflictCollision',
          'Connector sync conflict ID belongs to another conflict.',
        )
      }
      return structuredClone(existing.conflict)
    }
    const linkValue = await this.getRow(
      record.workspaceId,
      externalLinkRecordKey(record.conflict.externalLinkId),
    )
    if (!linkValue) throw connectorSyncStateConflict()
    const currentLink = readExternalLinkRow(linkValue)
    if (
      currentLink.value.installationId !== record.installationId ||
      currentLink.value.teamId !== record.teamId ||
      currentLink.value.workItemId !== record.conflict.workItemId ||
      currentLink.value.resourceType !== record.resourceType ||
      currentLink.value.syncDirection === 'none' ||
      currentLink.value.syncStatus === 'paused' ||
      currentLink.value.syncStatus === 'conflict'
    ) throw connectorSyncStateConflict()
    const row: ConnectorSyncConflictRow = {
      workspaceId: record.workspaceId,
      recordKey,
      entryType: 'connector-sync-conflict',
      value: record,
      version: 1,
      lookupKey: conflictLookupKey(record.workspaceId),
      lookupSortKey: conflictLookupSortKey(record.conflict),
    }
    const conflictedLink: ExternalWorkItemLink = {
      ...currentLink.value,
      syncStatus: 'conflict',
      updatedAt: record.conflict.detectedAt,
    }
    const nextLink = createExternalLinkReplacementRow(
      currentLink,
      conflictedLink,
    )
    const pollTargetUpdate = createPollTargetDeltaUpdate(
      this.tableName,
      record.workspaceId,
      currentLink.value,
      conflictedLink,
    )
    const auditPut = createPlatformAuditPut(this.auditTableName, {
      workspaceId: record.workspaceId,
      eventType: 'sync-conflict.created',
      entityType: 'sync-conflict',
      entityId: record.conflict.id,
      transitionId: 'created',
      teamId: record.teamId,
      occurredAt: record.conflict.detectedAt,
      action: 'created',
      summary: 'Connector synchronization conflict was detected.',
      metadata: {
        conflictId: record.conflict.id,
        externalLinkId: record.conflict.externalLinkId,
        workItemId: record.conflict.workItemId,
        installationId: record.installationId,
        resourceType: record.resourceType,
        fields: record.conflict.fields.map((field) => field.field),
      },
    })
    const linkAuditPut = createPlatformAuditPut(this.auditTableName, {
      workspaceId: record.workspaceId,
      eventType: 'external-link.updated',
      entityType: 'external-link',
      entityId: conflictedLink.id,
      transitionId: `conflict:${record.conflict.id}`,
      teamId: conflictedLink.teamId,
      occurredAt: record.conflict.detectedAt,
      action: 'updated',
      summary: 'External Work Item link entered conflict recovery.',
      metadata: {
        externalLinkId: conflictedLink.id,
        workItemId: conflictedLink.workItemId,
        installationId: conflictedLink.installationId,
        resourceType: conflictedLink.resourceType,
        syncDirection: conflictedLink.syncDirection,
        syncStatus: conflictedLink.syncStatus,
        conflictId: record.conflict.id,
      },
    })
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          createAbsentPut(this.tableName, row),
          createVersionedPut(this.tableName, nextLink, currentLink.version),
          createActiveConnectorConditionCheck(
            this.tableName,
            record.workspaceId,
            record.installationId,
          ),
          ...(pollTargetUpdate ? [pollTargetUpdate] : []),
          auditPut,
          linkAuditPut,
        ],
      }))
      return structuredClone(record.conflict)
    } catch (error) {
      if (!isTransactionConditionFailure(error)) throw persistenceFailure(error)
      const concurrentValue = await this.getRow(record.workspaceId, recordKey)
      if (!concurrentValue) throw connectorSyncStateConflict()
      const concurrent = readConflictRow(concurrentValue).value
      if (!sameConflictIdentity(concurrent, record)) {
        throw new ConnectorRuntimeError(
          'ConnectorSyncConflictCollision',
          'Connector sync conflict ID belongs to another conflict.',
        )
      }
      return structuredClone(concurrent.conflict)
    }
  }

  /** Workspace 内の conflict を opaque continuation cursor で page 取得します。 */
  async listConflicts(
    workspaceIdValue: string,
    input: {
      /** Optional status filter です。 */
      status?: WorkItemSyncConflict['status']
      /** 前 page の store cursor です。 */
      cursor?: string
      /** Page size です。 */
      limit: number
    },
  ): Promise<ConnectorSyncConflictPage> {
    const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
    const limit = requirePageSize(input.limit)
    const status = input.status === undefined
      ? undefined
      : requireConflictStatus(input.status)
    const exclusiveStartKey = input.cursor
      ? decodeCursor(
          input.cursor,
          workspaceId,
          this.lookupIndexName,
          this.cursorVerificationSecrets,
          this.clock().getTime(),
        )
      : undefined
    try {
      const items: WorkItemSyncConflict[] = []
      let startKey: Record<string, unknown> | undefined = exclusiveStartKey
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const response = await this.documentClient.send(new QueryCommand({
          TableName: this.tableName,
          IndexName: this.lookupIndexName,
          KeyConditionExpression: 'lookupKey = :lookupKey',
          ExpressionAttributeValues: {
            ':lookupKey': conflictLookupKey(workspaceId),
          },
          ScanIndexForward: false,
          Limit: Math.max(1, limit - items.length),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }))
        for (const locator of response.Items ?? []) {
          if (
            locator.workspaceId !== workspaceId ||
            typeof locator.recordKey !== 'string'
          ) throw invalidStoredRow('connector conflict index')
          const indexed = isRecord(locator.value)
            ? locator
            : await this.getRow(workspaceId, locator.recordKey)
          if (!indexed) throw invalidStoredRow('connector conflict index target')
          const conflict = readConflictRow(indexed).value.conflict
          if (status === undefined || conflict.status === status) {
            items.push(structuredClone(conflict))
          }
        }
        if (!response.LastEvaluatedKey) {
          return { items, hasMore: false }
        }
        startKey = response.LastEvaluatedKey
        if (items.length >= limit) {
          const nextCursor = encodeCursor(
            workspaceId,
            startKey,
            this.lookupIndexName,
            this.cursorSigningSecret,
            this.clock().getTime(),
            this.cursorTtlSeconds,
          )
          return { items, hasMore: true, nextCursor }
        }
      }
      throw new ConnectorRuntimeError(
        'ConnectorSyncPageLimitExceeded',
        'Connector sync conflict query exceeded its safe page limit.',
        { retryable: true },
      )
    } catch (error) {
      if (error instanceof ConnectorRuntimeError) throw error
      throw persistenceFailure(error)
    }
  }

  /** Workspace-bound conflict private snapshot を取得します。 */
  async getConflict(workspaceIdValue: string, conflictIdValue: string) {
    const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
    const conflictId = requireIdentifier(conflictIdValue, 'Conflict ID')
    const value = await this.getRow(workspaceId, conflictRecordKey(conflictId))
    return value ? structuredClone(readConflictRow(value).value) : undefined
  }

  /** Open conflict の resolution side effects を stable operation ID で fence します。 */
  async claimConflictResolution(
    workspaceIdValue: string,
    conflictIdValue: string,
    input: {
      /** Retry 間で固定する operation ID です。 */
      operationId: string
      /** Claim timestamp です。 */
      startedAt: string
    },
  ): Promise<'claimed' | 'same-operation' | 'busy' | undefined> {
    const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
    const conflictId = requireIdentifier(conflictIdValue, 'Conflict ID')
    const operationId = requireIdentifier(input.operationId, 'Resolution operation ID')
    const startedAt = requireTimestamp(input.startedAt, 'Resolution claim timestamp')
    return this.claimConflictResolutionWithRetry(
      workspaceId,
      conflictId,
      operationId,
      startedAt,
      0,
    )
  }

  /** Attempts one conflict claim and bounds retries after conditional conflicts. */
  private async claimConflictResolutionWithRetry(
    workspaceId: string,
    conflictId: string,
    operationId: string,
    startedAt: string,
    retryCount: number,
  ): Promise<'claimed' | 'same-operation' | 'busy' | undefined> {
    const value = await this.getRow(workspaceId, conflictRecordKey(conflictId))
    if (!value) return undefined
    const row = readConflictRow(value)
    if (row.value.conflict.status !== 'open') return undefined
    if (row.value.resolutionOperationId) {
      const claimedAt = Date.parse(row.value.resolutionStartedAt ?? '')
      const claimIsActive =
        Number.isFinite(claimedAt) &&
        claimedAt + this.resolutionLeaseSeconds * 1_000 > this.clock().getTime()
      if (claimIsActive) {
        return row.value.resolutionOperationId === operationId
          ? 'same-operation' as const
          : 'busy' as const
      }
    }
    const next: ConnectorSyncConflictRow = {
      ...row,
      value: {
        ...row.value,
        resolutionOperationId: operationId,
        resolutionStartedAt: startedAt,
      },
      version: row.version + 1,
    }
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: next,
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': row.version },
      }))
      return 'claimed' as const
    } catch (error) {
      if (isConditionalFailure(error)) {
        if (retryCount >= CONNECTOR_CONFLICT_CLAIM_MAX_RETRIES) {
          throw connectorSyncStateConflict()
        }
        return this.claimConflictResolutionWithRetry(
          workspaceId,
          conflictId,
          operationId,
          startedAt,
          retryCount + 1,
        )
      }
      throw persistenceFailure(error)
    }
  }

  /** Side effect 前に失敗した current resolution claim を CAS で解放します。 */
  async releaseConflictResolution(
    workspaceIdValue: string,
    conflictIdValue: string,
    operationIdValue: string,
  ) {
    const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
    const conflictId = requireIdentifier(conflictIdValue, 'Conflict ID')
    const operationId = requireIdentifier(
      operationIdValue,
      'Resolution operation ID',
    )
    const value = await this.getRow(workspaceId, conflictRecordKey(conflictId))
    if (!value) return false
    const row = readConflictRow(value)
    if (
      row.value.conflict.status !== 'open' ||
      row.value.resolutionOperationId !== operationId
    ) return false
    const nextValue = { ...row.value }
    delete nextValue.resolutionOperationId
    delete nextValue.resolutionStartedAt
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          ...row,
          value: nextValue,
          version: row.version + 1,
        },
        ConditionExpression:
          '#version = :expectedVersion AND #value.#resolutionOperationId = :operationId',
        ExpressionAttributeNames: {
          '#version': 'version',
          '#value': 'value',
          '#resolutionOperationId': 'resolutionOperationId',
        },
        ExpressionAttributeValues: {
          ':expectedVersion': row.version,
          ':operationId': operationId,
        },
      }))
      return true
    } catch (error) {
      if (isConditionalFailure(error)) return false
      throw persistenceFailure(error)
    }
  }

  /** Open conflict と sync-conflict.resolved outbox event を原子的に確定します。 */
  async completeConflict(
    workspaceIdValue: string,
    conflictIdValue: string,
    input: {
      /** Terminal status です。 */
      status: 'resolved' | 'ignored'
      /** Resolver Workspace user ID です。 */
      resolvedByUserId: string
      /** Resolution timestamp です。 */
      resolvedAt: string
      /** Claimed resolution operation ID です。 */
      operationId: string
    },
  ) {
    const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
    const conflictId = requireIdentifier(conflictIdValue, 'Conflict ID')
    const value = await this.getRow(workspaceId, conflictRecordKey(conflictId))
    if (!value) return undefined
    const row = readConflictRow(value)
    if (row.value.conflict.status !== 'open') return undefined
    const operationId = requireIdentifier(input.operationId, 'Resolution operation ID')
    if (row.value.resolutionOperationId !== operationId) return undefined
    const resolvedAt = requireTimestamp(input.resolvedAt, 'Conflict resolution timestamp')
    const resolvedByUserId = requireIdentifier(
      input.resolvedByUserId,
      'Conflict resolver user ID',
    )
    const conflict: WorkItemSyncConflict = {
      ...row.value.conflict,
      status: input.status,
      resolvedAt,
      resolvedByUserId,
    }
    const next: ConnectorSyncConflictRow = {
      ...row,
      value: { ...row.value, conflict },
      version: row.version + 1,
    }
    const linkValue = await this.getRow(
      workspaceId,
      externalLinkRecordKey(conflict.externalLinkId),
    )
    if (!linkValue) return undefined
    const currentLink = readExternalLinkRow(linkValue)
    if (
      currentLink.value.syncStatus !== 'conflict' ||
      currentLink.value.installationId !== row.value.installationId ||
      currentLink.value.teamId !== row.value.teamId ||
      currentLink.value.workItemId !== conflict.workItemId
    ) return undefined
    const terminalLinkStatus = input.status === 'ignored' ? 'paused' : 'synced'
    const terminalLink: ExternalWorkItemLink = {
      ...currentLink.value,
      syncStatus: terminalLinkStatus,
      updatedAt: resolvedAt,
      ...(terminalLinkStatus === 'synced'
        ? { lastSyncedAt: resolvedAt }
        : {}),
    }
    const nextLink = createExternalLinkReplacementRow(currentLink, terminalLink)
    const pollTargetUpdate = createPollTargetDeltaUpdate(
      this.tableName,
      workspaceId,
      currentLink.value,
      terminalLink,
    )
    const auditPut = createPlatformAuditPut(this.auditTableName, {
      workspaceId,
      eventType: 'sync-conflict.resolved',
      entityType: 'sync-conflict',
      entityId: conflict.id,
      transitionId: `${input.status}:${resolvedByUserId}`,
      teamId: row.value.teamId,
      occurredAt: resolvedAt,
      action: input.status,
      summary: input.status === 'ignored'
        ? 'Connector synchronization conflict was ignored.'
        : 'Connector synchronization conflict was resolved.',
      metadata: {
        conflictId: conflict.id,
        externalLinkId: conflict.externalLinkId,
        workItemId: conflict.workItemId,
        installationId: row.value.installationId,
        resolutionStatus: input.status,
      },
      actorId: resolvedByUserId,
    })
    const linkAuditPut = createPlatformAuditPut(this.auditTableName, {
      workspaceId,
      eventType: 'external-link.updated',
      entityType: 'external-link',
      entityId: terminalLink.id,
      transitionId: `conflict-${input.status}:${conflict.id}`,
      teamId: terminalLink.teamId,
      occurredAt: resolvedAt,
      action: 'updated',
      summary: input.status === 'ignored'
        ? 'External Work Item link was paused after its conflict was ignored.'
        : 'External Work Item link resumed after its conflict was resolved.',
      metadata: {
        externalLinkId: terminalLink.id,
        workItemId: terminalLink.workItemId,
        installationId: terminalLink.installationId,
        resourceType: terminalLink.resourceType,
        syncDirection: terminalLink.syncDirection,
        syncStatus: terminalLink.syncStatus,
        conflictId: conflict.id,
      },
      actorId: resolvedByUserId,
    })
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          createVersionedPut(this.tableName, next, row.version),
          createVersionedPut(this.tableName, nextLink, currentLink.version),
          ...(input.status === 'resolved'
            ? [createActiveConnectorConditionCheck(
                this.tableName,
                workspaceId,
                terminalLink.installationId,
              )]
            : []),
          ...(pollTargetUpdate ? [pollTargetUpdate] : []),
          auditPut,
          linkAuditPut,
        ],
      }))
      return structuredClone(conflict)
    } catch (error) {
      if (isTransactionConditionFailure(error)) return undefined
      throw persistenceFailure(error)
    }
  }

  /** Primary key row を強整合取得します。 */
  private async getRow(workspaceId: string, recordKey: string) {
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey },
        ConsistentRead: true,
      }))
      return response.Item
    } catch (error) {
      throw persistenceFailure(error)
    }
  }
}

/**
 * Environment 設定から production connector sync store を作成します。
 *
 * @param environment table/index/cursor key を読む environment です。
 * @returns Durable connector sync persistence です。
 */
export function createDynamoDbConnectorSyncPersistenceFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return new DynamoDbConnectorSyncPersistence({ environment })
}

/** Connector sync persistence が platform audit へ渡す入力です。 */
type PlatformAuditInput = {
  /** Workspace ID です。 */
  workspaceId: string
  /** Event type です。 */
  eventType: string
  /** Entity type です。 */
  entityType: string
  /** Entity ID です。 */
  entityId: string
  /** Stable transition ID です。 */
  transitionId: string
  /** Team authorization selector です。 */
  teamId: string
  /** Event occurrence timestamp です。 */
  occurredAt: string
  /** Audit action です。 */
  action: string
  /** Secret-free event summary です。 */
  summary: string
  /** Secret-free event metadata です。 */
  metadata: Readonly<Record<string, unknown>>
  /** Optional user actor ID です。 */
  actorId?: string
}

function createPlatformAuditPut(auditTableName: string, input: PlatformAuditInput) {
  const context = createMutationAuditContext({
    workspaceId: input.workspaceId,
    actor: {
      id: input.actorId ?? 'connector-sync',
      kind: input.actorId ? 'user' : 'service',
    },
    idempotencyKey:
      `connector-sync:${input.eventType}:${input.entityId}:${input.transitionId}`,
    occurredAt: input.occurredAt,
    request: {
      method: 'EVENT',
      path: `/connector-sync/${input.entityType}/${input.entityId}`,
      body: { transitionId: input.transitionId },
    },
    source: {
      kind: 'system',
      requestId: `connector-sync-${createDigest(input.transitionId).slice(0, 24)}`,
    },
  })
  const auditPut = createMutationAuditEventPut(auditTableName, context, {
    directoryId: input.workspaceId,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    occurredAt: input.occurredAt,
    summary: input.summary,
    metadata: {
      adapter: 'connector-sync',
      teamId: input.teamId,
      ...input.metadata,
    },
  })
  if (!auditPut) {
    throw new ConnectorRuntimeError(
      'ConnectorAuditOutboxUnavailable',
      'Connector sync audit outbox is not configured.',
    )
  }
  return auditPut
}

function createAbsentPut(tableName: string, item: Record<string, unknown>) {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression:
        'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
    },
  }
}

function createVersionedPut(
  tableName: string,
  item: Record<string, unknown>,
  expectedVersion: number,
) {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: '#version = :expectedVersion',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
    },
  }
}

function isPollableExternalLink(link: ExternalWorkItemLink) {
  return link.syncStatus !== 'paused' &&
    link.syncStatus !== 'conflict' &&
    (link.syncDirection === 'inbound' || link.syncDirection === 'bidirectional')
}

function createPollTargetDeltaUpdate(
  tableName: string,
  workspaceId: string,
  previous: ExternalWorkItemLink,
  next: ExternalWorkItemLink,
) {
  const delta = Number(isPollableExternalLink(next)) -
    Number(isPollableExternalLink(previous))
  if (delta === 0) return undefined
  const incrementing = delta === 1
  return {
    Update: {
      TableName: tableName,
      Key: {
        workspaceId,
        recordKey: createConnectorPollTargetRecordKey(
          next.installationId,
          next.resourceType,
        ),
      },
      UpdateExpression:
        'SET #entryType = if_not_exists(#entryType, :entryType), ' +
        '#value = if_not_exists(#value, :value), ' +
        'pollableLinkCount = ' +
        `${incrementing ? 'if_not_exists(pollableLinkCount, :zero) +' : 'pollableLinkCount -'} :one, ` +
        'lookupKey = :lookupKey, lookupSortKey = :lookupSortKey, ' +
        '#version = if_not_exists(#version, :zero) + :one',
      ConditionExpression: incrementing
        ? 'attribute_not_exists(#entryType) OR ' +
          '(#entryType = :entryType AND #value.#installationId = :installationId AND ' +
          '#value.#resourceType = :resourceType AND pollableLinkCount >= :zero)'
        : '#entryType = :entryType AND #value.#installationId = :installationId AND ' +
          '#value.#resourceType = :resourceType AND pollableLinkCount >= :one',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#value': 'value',
        '#installationId': 'installationId',
        '#resourceType': 'resourceType',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':entryType': 'connector-poll-target',
        ':value': {
          installationId: next.installationId,
          resourceType: next.resourceType,
        },
        ':installationId': next.installationId,
        ':resourceType': next.resourceType,
        ':lookupKey': createConnectorPollTargetLookupKey(
          workspaceId,
          next.installationId,
          next.resourceType,
        ),
        ':lookupSortKey': `${workspaceId}#${next.installationId}#${next.resourceType}`,
        ':zero': 0,
        ':one': 1,
      },
    },
  }
}

function createExternalLinkReplacementRow(
  row: ExternalLinkRow,
  link: ExternalWorkItemLink,
): ExternalLinkRow {
  const {
    lookupKey: _lookupKey,
    lookupSortKey: _lookupSortKey,
    ...baseRow
  } = row
  return {
    ...baseRow,
    value: link,
    version: row.version + 1,
  }
}

function normalizeConflictRecord(value: StoredConnectorSyncConflict) {
  const workspaceId = requireIdentifier(value.workspaceId, 'Workspace ID')
  const conflict = structuredClone(value.conflict)
  requireIdentifier(conflict.id, 'Conflict ID')
  requireIdentifier(conflict.externalLinkId, 'External link ID')
  requireIdentifier(conflict.workItemId, 'Work Item ID')
  requirePositiveInteger(conflict.localRevision, 'Conflict local revision')
  requireText(conflict.externalRevision, 'Conflict external revision')
  requireTimestamp(conflict.detectedAt, 'Conflict detection timestamp')
  if (conflict.status !== 'open') {
    throw new ConnectorRuntimeError(
      'ConnectorSyncConflictInvalid',
      'A new connector sync conflict must be open.',
    )
  }
  if (!Array.isArray(conflict.fields) || conflict.fields.length === 0) {
    throw new ConnectorRuntimeError(
      'ConnectorSyncConflictInvalid',
      'Connector sync conflict fields are required.',
    )
  }
  for (const field of conflict.fields) requireText(field.field, 'Conflict field')
  return {
    ...structuredClone(value),
    workspaceId,
    teamId: requireIdentifier(value.teamId, 'Team ID'),
    installationId: requireIdentifier(value.installationId, 'Connector installation ID'),
    conflict,
  }
}

function readSyncStateRow(value: Record<string, unknown>): ConnectorSyncStateRow {
  if (
    value.entryType !== 'connector-sync-state' ||
    !isRecord(value.value) ||
    !Number.isSafeInteger(value.version)
  ) throw invalidStoredRow('connector sync state')
  return value as ConnectorSyncStateRow
}

function readConflictRow(value: Record<string, unknown>): ConnectorSyncConflictRow {
  if (
    value.entryType !== 'connector-sync-conflict' ||
    !isRecord(value.value) ||
    !Number.isSafeInteger(value.version)
  ) throw invalidStoredRow('connector sync conflict')
  return value as ConnectorSyncConflictRow
}

function readExternalLinkRow(value: Record<string, unknown>): ExternalLinkRow {
  if (
    value.entryType !== 'external-link' ||
    !isRecord(value.value) ||
    !Number.isSafeInteger(value.version)
  ) throw invalidStoredRow('external Work Item link')
  const link = value.value
  requireIdentifier(link.id, 'External link ID')
  requireIdentifier(link.teamId, 'Team ID')
  requireIdentifier(link.workItemId, 'Work Item ID')
  return value as ExternalLinkRow
}

function sameConflictIdentity(
  left: StoredConnectorSyncConflict,
  right: StoredConnectorSyncConflict,
) {
  return left.workspaceId === right.workspaceId &&
    left.conflict.id === right.conflict.id &&
    left.conflict.externalLinkId === right.conflict.externalLinkId &&
    left.conflict.workItemId === right.conflict.workItemId &&
    left.conflict.localRevision === right.conflict.localRevision &&
    left.conflict.externalRevision === right.conflict.externalRevision
}

function encodeCursor(
  workspaceId: string,
  key: Record<string, unknown>,
  lookupIndexName: string,
  signingSecret: string,
  issuedAt: number,
  ttlSeconds: number,
) {
  if (
    key.workspaceId !== workspaceId ||
    typeof key.recordKey !== 'string' ||
    key.lookupKey !== conflictLookupKey(workspaceId) ||
    typeof key.lookupSortKey !== 'string'
  ) {
    throw invalidStoredRow('connector conflict cursor')
  }
  const payload = Buffer.from(JSON.stringify({
    workspaceId,
    lookupIndexName,
    issuedAt,
    expiresAt: issuedAt + ttlSeconds * 1_000,
    recordKey: key.recordKey,
    lookupKey: key.lookupKey,
    lookupSortKey: key.lookupSortKey,
  })).toString('base64url')
  const signature = createHmac('sha256', signingSecret)
    .update(`connector-sync-cursor-v1\0${payload}`)
    .digest('base64url')
  return `v1.${payload}.${signature}`
}

function decodeCursor(
  value: string,
  workspaceId: string,
  lookupIndexName: string,
  verificationSecrets: readonly string[],
  now: number,
) {
  try {
    if (value.length > 4_096) throw new Error('invalid')
    const [version, payload, signature, extra] = value.split('.')
    if (
      version !== 'v1' ||
      !payload ||
      !signature ||
      extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/u.test(payload) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(signature) ||
      !verificationSecrets.some((secret) =>
        isAuthenticCursorSignature(payload, signature, secret)
      )
    ) throw new Error('invalid')
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as unknown
    if (
      !isRecord(parsed) ||
      parsed.workspaceId !== workspaceId ||
      parsed.lookupIndexName !== lookupIndexName ||
      typeof parsed.issuedAt !== 'number' ||
      !Number.isSafeInteger(parsed.issuedAt) ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.issuedAt > now + 60_000 ||
      parsed.expiresAt <= now ||
      parsed.expiresAt <= parsed.issuedAt ||
      typeof parsed.recordKey !== 'string' ||
      !parsed.recordKey.startsWith('SYNCCONFLICT#') ||
      parsed.lookupKey !== conflictLookupKey(workspaceId) ||
      typeof parsed.lookupSortKey !== 'string'
    ) throw new Error('invalid')
    return {
      workspaceId,
      recordKey: parsed.recordKey,
      lookupKey: parsed.lookupKey,
      lookupSortKey: parsed.lookupSortKey,
    }
  } catch {
    throw new ConnectorRuntimeError(
      'ConnectorSyncCursorInvalid',
      'Connector sync conflict cursor is invalid.',
    )
  }
}

function isAuthenticCursorSignature(
  payload: string,
  signature: string,
  secret: string,
) {
  const expected = createHmac('sha256', secret)
    .update(`connector-sync-cursor-v1\0${payload}`)
    .digest()
  const actual = Buffer.from(signature, 'base64url')
  return actual.toString('base64url') === signature &&
    actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected)
}

function createDocumentClient(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const endpoint = environment.DYNAMODB_ENDPOINT ??
    environment.AWS_ENDPOINT_URL_DYNAMODB ??
    environment.AWS_ENDPOINT_URL
  const client = new DynamoDBClient({
    region: environment.AWS_REGION ??
      environment.AWS_DEFAULT_REGION ??
      'ap-northeast-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: environment.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: environment.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  })
}

function requireSyncStatus(value: ExternalWorkItemLink['syncStatus']) {
  if (!['pending', 'synced', 'conflict', 'failed', 'paused'].includes(value)) {
    throw new ConnectorRuntimeError(
      'ConnectorSyncStatusInvalid',
      'External link sync status is invalid.',
    )
  }
  return value
}

function requireConflictStatus(value: WorkItemSyncConflict['status']) {
  if (!['open', 'resolved', 'ignored'].includes(value)) {
    throw new ConnectorRuntimeError(
      'ConnectorSyncConflictStatusInvalid',
      'Connector sync conflict status is invalid.',
    )
  }
  return value
}

function requirePageSize(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new ConnectorRuntimeError(
      'ConnectorSyncPageSizeInvalid',
      'Connector sync conflict page size must be between 1 and 100.',
    )
  }
  return value
}

function requirePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConnectorRuntimeError('ConnectorSyncInputInvalid', `${label} is invalid.`)
  }
  return value
}

function requireTimestamp(value: string, label: string) {
  const text = requireText(value, label)
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds)) {
    throw new ConnectorRuntimeError('ConnectorSyncInputInvalid', `${label} is invalid.`)
  }
  return new Date(milliseconds).toISOString()
}

function requireIdentifier(value: unknown, label: string) {
  const text = requireText(value, label)
  if (text.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(text)) {
    throw new ConnectorRuntimeError('ConnectorSyncInputInvalid', `${label} is invalid.`)
  }
  return text
}

function requireText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) {
    throw new ConnectorRuntimeError('ConnectorSyncInputInvalid', `${label} is invalid.`)
  }
  return value.trim()
}

function syncStateRecordKey(linkId: string) {
  return `CONNECTORSYNC#${linkId}`
}

function conflictRecordKey(conflictId: string) {
  return `SYNCCONFLICT#${conflictId}`
}

function conflictLookupKey(workspaceId: string) {
  return `CONNECTOR_SYNC_CONFLICT#${workspaceId}`
}

function conflictLookupSortKey(conflict: WorkItemSyncConflict) {
  return `${conflict.detectedAt}#${conflict.id}`
}

function externalLinkRecordKey(linkId: string) {
  return `EXTERNALLINK#${linkId}`
}

function connectorRecordKey(installationId: string) {
  return `CONNECTOR#${installationId}`
}

function connectorSyncStateConflict() {
  return new ConnectorRuntimeError(
    'ConnectorSyncStateConflict',
    'External link or connector state changed concurrently.',
    { retryable: true },
  )
}

function createActiveConnectorConditionCheck(
  tableName: string,
  workspaceId: string,
  installationIdValue: string,
) {
  const installationId = requireIdentifier(
    installationIdValue,
    'Connector installation ID',
  )
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        workspaceId,
        recordKey: connectorRecordKey(installationId),
      },
      ConditionExpression:
        '#value.#id = :installationId AND #value.#status <> :disconnected AND #value.#status <> :needsReauthorization',
      ExpressionAttributeNames: {
        '#value': 'value',
        '#id': 'id',
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':installationId': installationId,
        ':disconnected': 'disconnected',
        ':needsReauthorization': 'needs-reauth',
      },
    },
  }
}

function isConditionalFailure(error: unknown) {
  return isNamedError(error, 'ConditionalCheckFailedException')
}

function isTransactionConditionFailure(error: unknown) {
  return isNamedError(error, 'TransactionCanceledException') &&
    isRecord(error) &&
    Array.isArray(error.CancellationReasons) &&
    error.CancellationReasons.some((reason) =>
      isRecord(reason) && reason.Code === 'ConditionalCheckFailed'
    )
}

function isNamedError(error: unknown, name: string) {
  return error instanceof Error && error.name === name
}

function requireSigningSecret(value: string) {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') < 32 ||
    Buffer.byteLength(value, 'utf8') > 4_096
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorSyncCursorSigningSecretInvalid',
      'Connector sync cursor signing secret is invalid.',
    )
  }
  return value
}

function readPreviousSigningSecrets(value: string | undefined) {
  if (!value?.trim()) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      !Array.isArray(parsed) ||
      parsed.length > 3 ||
      parsed.some((secret) => typeof secret !== 'string')
    ) throw new Error('invalid')
    return parsed.map(requireSigningSecret)
  } catch (error) {
    if (error instanceof ConnectorRuntimeError) throw error
    throw new ConnectorRuntimeError(
      'ConnectorSyncCursorSigningSecretInvalid',
      'Previous connector sync cursor signing secrets are invalid.',
    )
  }
}

function isProductionEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
) {
  return environment.NODE_ENV === 'production' ||
    Boolean(environment.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(environment.AWS_EXECUTION_ENV)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidStoredRow(entity: string) {
  return new ConnectorRuntimeError(
    'ConnectorSyncPersistenceInvalid',
    `Stored ${entity} row is invalid.`,
  )
}

function persistenceFailure(error: unknown) {
  if (error instanceof ConnectorRuntimeError) return error
  return new ConnectorRuntimeError(
    'ConnectorSyncPersistenceUnavailable',
    'Connector sync persistence is temporarily unavailable.',
    { retryable: true },
  )
}

function createDigest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
