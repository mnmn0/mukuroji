import { createHash } from 'node:crypto'
import {
  AdminUserGlobalSignOutCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import type { TenantOperation } from '@mukuroji/contracts'
import {
  createTenantDeletedMemberAlias,
  createTenantOperationEvidenceDigest,
  type TenantOperationExecutionCursor,
  type TenantOperationExecutionJob,
  type TenantOperationResourceOwner,
  type TenantOperationResourceOwnerKind,
  type TenantOperationResourceOwnerResult,
} from '../../application/tenant-operation-resource-owner'
import { TenantAdministrationError } from '../../domain/tenant-administration'

const RESOURCE_PAGE_SIZE = 20
const IDENTITY_PAGE_SIZE = 10

/** Environment-backed AWS resource names used by lifecycle resource owners. */
export type TenantOperationResourceOwnerConfig = {
  /** Tenant lifecycle state and evidence table. */
  tenantAdministrationTableName: string
  /** Dedicated private bucket containing export artifacts. */
  tenantExportBucketName: string
  /** Versioned tenant file bucket. */
  fileBucketName: string
  /** Cognito user pool whose tenant sessions are revoked. */
  cognitoUserPoolId: string
  /** Legacy project-task table. */
  legacyTasksTableName: string
  /** Canonical Work Item table. */
  workItemsTableName: string
  /** Work Item event table. */
  workItemEventsTableName: string
  /** Work Item configuration table. */
  workItemConfigurationTableName: string
  /** Automation table. */
  automationTableName: string
  /** Planning table. */
  planningTableName: string
  /** Developer-platform table containing tenant credentials and state. */
  developerPlatformTableName: string
  /** Analytics table. */
  analyticsTableName: string
  /** Public request-intake table. */
  requestIntakeTableName: string
  /** Workspace directory table. */
  projectDirectoryTableName: string
  /** Immutable audit event table retained after closure. */
  auditEventsTableName: string
  /** Workspace access table retained until final administrator verification. */
  workspaceAccessTableName: string
  /** Enterprise Identity table containing tenant credentials and state. */
  enterpriseIdentityTableName: string
  /** Collaborative Documents table. */
  documentsTableName: string
  /** Work Item collaboration table. */
  collaborationTableName: string
  /** Workspace search table. */
  workspaceSearchTableName: string
  /** Notification table. */
  notificationsTableName: string
  /** Realtime session table. */
  realtimeSessionsTableName: string
  /** File proofing metadata table. */
  fileProofingTableName: string
}

/** AWS clients and immutable capability identity used by one resource owner. */
export type TenantOperationAwsResourceOwnerInput = {
  /** Capability-isolated owner implementation to expose. */
  owner: TenantOperationResourceOwnerKind
  /** Shared DynamoDB DocumentClient. */
  documentClient: DynamoDBDocumentClient
  /** S3 client scoped by the Lambda role. */
  s3Client: S3Client
  /** Cognito client scoped by the Lambda role. */
  cognitoClient: CognitoIdentityProviderClient
  /** Exact resource names injected by CDK. */
  config: TenantOperationResourceOwnerConfig
  /** Testable clock used only in immutable evidence metadata. */
  clock?: () => Date
}

/** One exact or delimiter-safe tenant locator used by a table target. */
type TenantSelector = {
  /** DynamoDB attribute containing the tenant locator. */
  readonly attribute: string
  /** Comparison applied by the generated query or filter expression. */
  readonly mode: 'equals' | 'prefix'
  /** Builds the canonical tenant locator for one Workspace. */
  readonly value: (workspaceId: string) => string
}

/** One DynamoDB table and its complete tenant-isolation key contract. */
type TenantDynamoTarget = {
  /** Stable resource identifier used in artifacts and evidence. */
  readonly id: string
  /** Deployed DynamoDB table name. */
  readonly tableName: string
  /** Physical partition-key attribute. */
  readonly partitionKey: string
  /** Optional physical sort-key attribute. */
  readonly sortKey?: string
  /** All supported tenant locators for rows in the table. */
  readonly selectors: readonly TenantSelector[]
}

/** Opaque DynamoDB pagination state carried between queue jobs. */
type DynamoCursor = {
  /** Cursor discriminator. */
  readonly kind: 'dynamo'
  /** Last evaluated physical DynamoDB key. */
  readonly key: Record<string, unknown>
}

/** Opaque current-object pagination state carried between queue jobs. */
type ObjectCursor = {
  /** Cursor discriminator. */
  readonly kind: 'objects'
  /** S3 continuation token for the next object page. */
  readonly continuationToken?: string
}

/** Opaque versioned-object pagination state carried between queue jobs. */
type VersionCursor = {
  /** Cursor discriminator. */
  readonly kind: 'versions'
  /** S3 key marker for the next version page. */
  readonly keyMarker?: string
  /** S3 version marker paired with the key marker. */
  readonly versionIdMarker?: string
}

/** Every resource cursor accepted by a lifecycle resource owner. */
type ResourceCursor = DynamoCursor | ObjectCursor | VersionCursor

/** One normalized bounded DynamoDB page. */
type DynamoPage = {
  /** Valid record-shaped items returned by the page. */
  readonly items: Record<string, unknown>[]
  /** Physical continuation key when another page exists. */
  readonly lastEvaluatedKey?: Record<string, unknown>
}

/**
 * Executes bounded tenant export, revocation, anonymization, deletion, and verification pages.
 */
export class AwsTenantOperationResourceOwner implements TenantOperationResourceOwner {
  /** Capability-isolated owner kind. */
  private readonly owner: TenantOperationResourceOwnerKind
  /** DynamoDB client restricted by the owner Lambda role. */
  private readonly documentClient: DynamoDBDocumentClient
  /** S3 client restricted by the owner Lambda role. */
  private readonly s3Client: S3Client
  /** Cognito client restricted by the owner Lambda role. */
  private readonly cognitoClient: CognitoIdentityProviderClient
  /** Immutable deployed resource names. */
  private readonly config: TenantOperationResourceOwnerConfig
  /** Evidence timestamp source. */
  private readonly clock: () => Date

  /**
   * Creates one capability-isolated AWS resource owner.
   *
   * @param input - Owner identity, AWS clients, resources, and optional clock.
   */
  constructor(input: TenantOperationAwsResourceOwnerInput) {
    this.owner = input.owner
    this.documentClient = input.documentClient
    this.s3Client = input.s3Client
    this.cognitoClient = input.cognitoClient
    this.config = input.config
    this.clock = input.clock ?? (() => new Date())
  }

  /**
   * Processes one bounded page for the configured resource owner.
   *
   * @param job - Validated ID-only lifecycle job.
   * @param operation - Current strongly read operation.
   * @returns A continuation, terminal failure, or immutable evidence digest.
   */
  async execute(
    job: TenantOperationExecutionJob,
    operation: TenantOperation,
  ): Promise<TenantOperationResourceOwnerResult> {
    if (operation.operationId !== job.operationId || operation.workspaceId !== job.workspaceId) {
      throw new TenantAdministrationError(
        503,
        'TenantOperationScopeMismatch',
        'Tenant operation resource-owner scope is inconsistent.',
      )
    }
    if (this.owner === 'export') return await this.executeExport(job, operation)
    if (this.owner === 'access') return await this.executeAccessRevocation(job, operation)
    if (this.owner === 'identity') return await this.executeMemberAnonymization(job, operation)
    if (this.owner === 'data') return await this.executeDataDeletion(job, operation)
    if (this.owner === 'secrets') return await this.executeSecretDeletion(job, operation)
    return await this.executeVerification(job, operation)
  }

  /** Returns every tenant-owned table included in export snapshots. */
  private exportTargets(): TenantDynamoTarget[] {
    return [
      delimitedPrefixTarget(
        'legacy-tasks',
        this.config.legacyTasksTableName,
        'directoryProjectId',
        'taskId',
      ),
      delimitedPrefixTarget(
        'work-items',
        this.config.workItemsTableName,
        'directoryTeamId',
        'issueId',
      ),
      delimitedPrefixTarget(
        'work-item-events',
        this.config.workItemEventsTableName,
        'directoryTeamIssueId',
        'eventId',
      ),
      attributeTarget(
        'work-item-configuration',
        this.config.workItemConfigurationTableName,
        'scopeKey',
        'recordKey',
        [
          encodedWorkspaceSelector('scopeKey', 'equals', '', '#work-item-configuration'),
          encodedWorkspaceSelector('scopeKey', 'prefix', '', '#team#'),
        ],
      ),
      attributeTarget(
        'automation',
        this.config.automationTableName,
        'scopeKey',
        'recordKey',
        [
          workspaceSelector('workspaceId', 'equals'),
          encodedWorkspaceSelector('scopeKey', 'equals', '', '#automation'),
          encodedWorkspaceSelector('scopeKey', 'prefix', '', '#automation#'),
        ],
      ),
      exactTarget('planning', this.config.planningTableName, 'workspaceId', 'recordKey'),
      attributeTarget('developer-platform', this.config.developerPlatformTableName, 'workspaceId', 'recordKey', [
        workspaceSelector('workspaceId', 'equals'),
      ]),
      exactTarget('analytics', this.config.analyticsTableName, 'workspaceId', 'recordKey'),
      attributeTarget(
        'request-intake',
        this.config.requestIntakeTableName,
        'scopeKey',
        'recordKey',
        [
          workspaceSelector('workspaceId', 'equals'),
          workspaceSelector('scopeKey', 'equals', 'WORKSPACE#'),
        ],
      ),
      exactTarget('project-directory', this.config.projectDirectoryTableName, 'directoryId', 'entryKey'),
      exactTarget('audit-events', this.config.auditEventsTableName, 'directoryId', 'eventId'),
      exactTarget('workspace-access', this.config.workspaceAccessTableName, 'workspaceId', 'recordKey'),
      attributeTarget('enterprise-identity', this.config.enterpriseIdentityTableName, 'scopeKey', 'recordKey', [
        workspaceSelector('workspaceId', 'equals'),
        workspaceSelector('scopeKey', 'equals', 'WORKSPACE#'),
        workspaceSelector('scopeKey', 'prefix', 'WORKSPACE_STATE#', '#'),
      ]),
      attributeTarget(
        'documents',
        this.config.documentsTableName,
        'workspaceId',
        'recordKey',
        [
          workspaceSelector('workspaceId', 'equals'),
          workspaceSelector('targetWorkspaceId', 'equals'),
        ],
      ),
      delimitedPrefixTarget(
        'collaboration',
        this.config.collaborationTableName,
        'entityKey',
        'recordKey',
      ),
      exactTarget('workspace-search', this.config.workspaceSearchTableName, 'workspaceId', 'recordKey'),
      delimitedPrefixTarget(
        'notifications',
        this.config.notificationsTableName,
        'recipientKey',
        'notificationKey',
      ),
      attributeTarget('realtime', this.config.realtimeSessionsTableName, 'connectionId', undefined, [
        workspaceSelector('workspaceId', 'equals'),
      ]),
      attributeTarget(
        'file-proofing',
        this.config.fileProofingTableName,
        'scopeKey',
        'recordKey',
        [workspaceSelector('scopeKey', 'prefix', 'WORKSPACE#', '#')],
      ),
      exactTarget('tenant-administration', this.config.tenantAdministrationTableName, 'workspaceId', 'recordKey'),
    ]
  }

  /** Returns tables deleted before tenant secrets and control-plane evidence. */
  private dataDeletionTargets(): TenantDynamoTarget[] {
    const excluded = new Set([
      'audit-events',
      'developer-platform',
      'enterprise-identity',
      'tenant-administration',
      'workspace-access',
    ])
    return this.exportTargets().filter((target) => !excluded.has(target.id))
  }

  /** Returns tables whose tenant-scoped encrypted credentials are deleted separately. */
  private secretDeletionTargets(): TenantDynamoTarget[] {
    return this.exportTargets().filter((target) =>
      target.id === 'developer-platform' || target.id === 'enterprise-identity'
    )
  }

  /** Processes export snapshot, manifest, and verification phases. */
  private async executeExport(
    job: TenantOperationExecutionJob,
    operation: TenantOperation,
  ): Promise<TenantOperationResourceOwnerResult> {
    const phase = resolveExportPhase(job)
    if (phase === 'snapshot') {
      const result = await this.processExportSnapshotPage(job, operation)
      if (typeof result !== 'number') return result
      await this.writeExportSnapshotMarker(operation, result)
      if (job.step === 'export') {
        return {
          status: 'continuing',
          nextJob: createContinuation(job, {
            targetIndex: 0,
            phase: 'prepare',
            processedCount: result,
          }),
        }
      }
      return await this.completeWithEvidence(job, {
        artifactPrefix: createExportPrefix(operation),
        phase: 'snapshot',
        processedCount: result,
      })
    }
    if (phase === 'prepare') {
      const marker = await this.requireExportObject(
        `${createExportPrefix(operation)}/snapshot-complete.json`,
      )
      const manifest = JSON.stringify({
        schemaVersion: 1,
        operationId: operation.operationId,
        workspaceDigest: digestIdentifier(operation.workspaceId),
        format: operation.exportFormat ?? 'jsonl',
        requestedAt: operation.requestedAt,
        snapshotPrefix: `${createExportPrefix(operation)}/snapshot/`,
        snapshotMarkerEtag: normalizeEtag(marker.ETag),
      })
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.config.tenantExportBucketName,
        Key: `${createExportPrefix(operation)}/manifest.json`,
        Body: manifest,
        ContentType: 'application/json',
        ChecksumSHA256: checksumBase64(manifest),
        Metadata: {
          'operation-digest': digestIdentifier(operation.operationId),
          'workspace-digest': digestIdentifier(operation.workspaceId),
        },
      }))
      if (job.step === 'export') {
        return {
          status: 'continuing',
          nextJob: createContinuation(job, {
            targetIndex: 0,
            phase: 'verify',
            processedCount: job.cursor?.processedCount ?? 0,
          }),
        }
      }
      return await this.completeWithEvidence(job, {
        artifactPrefix: createExportPrefix(operation),
        manifestDigest: createHash('sha256').update(manifest).digest('hex'),
        phase: 'prepare',
      })
    }
    const manifest = await this.requireExportObject(
      `${createExportPrefix(operation)}/manifest.json`,
    )
    const snapshot = await this.requireExportObject(
      `${createExportPrefix(operation)}/snapshot-complete.json`,
    )
    if (
      manifest.ContentLength === undefined ||
      manifest.ContentLength <= 0 ||
      snapshot.ContentLength === undefined ||
      snapshot.ContentLength <= 0
    ) {
      return { status: 'failed', failureCode: 'EXPORT_ARTIFACT_EMPTY' }
    }
    return await this.completeWithEvidence(job, {
      artifactPrefix: createExportPrefix(operation),
      manifestEtag: normalizeEtag(manifest.ETag),
      phase: 'verify',
      snapshotEtag: normalizeEtag(snapshot.ETag),
    })
  }

  /** Processes one DynamoDB or file-object page of an export snapshot. */
  private async processExportSnapshotPage(
    job: TenantOperationExecutionJob,
    operation: TenantOperation,
  ): Promise<TenantOperationResourceOwnerResult | number> {
    const targets = this.exportTargets()
    const cursor = job.cursor ?? {
      targetIndex: 0,
      phase: 'snapshot',
      processedCount: 0,
    }
    if (cursor.targetIndex < targets.length) {
      const target = targets[cursor.targetIndex]
      if (!target) {
        throw new TenantAdministrationError(
          503,
          'TenantExportTargetInvalid',
          'Tenant export target is unavailable.',
        )
      }
      const page = await this.readDynamoPage(
        target,
        operation.workspaceId,
        decodeDynamoPosition(cursor.position),
        false,
      )
      const body = serializeExportPage(
        target.id,
        page.items,
        operation.exportFormat ?? 'jsonl',
      )
      if (page.items.length > 0) {
        const pageId = digestIdentifier(
          `${target.id}:${cursor.position ?? 'start'}`,
        )
        await this.s3Client.send(new PutObjectCommand({
          Bucket: this.config.tenantExportBucketName,
          Key: `${createExportPrefix(operation)}/snapshot/data/${target.id}/${pageId}.${operation.exportFormat ?? 'jsonl'}`,
          Body: body,
          ContentType: operation.exportFormat === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'application/x-ndjson',
          ChecksumSHA256: checksumBase64(body),
        }))
      }
      return {
        status: 'continuing',
        nextJob: createContinuation(job, {
          targetIndex: page.lastEvaluatedKey
            ? cursor.targetIndex
            : cursor.targetIndex + 1,
          ...(page.lastEvaluatedKey
            ? { position: encodeCursor({ kind: 'dynamo', key: page.lastEvaluatedKey }) }
            : {}),
          phase: 'snapshot',
          processedCount: cursor.processedCount + page.items.length,
        }),
      }
    }
    if (cursor.targetIndex > targets.length) return cursor.processedCount
    const objectCursor = decodeObjectPosition(cursor.position)
    const response = await this.s3Client.send(new ListObjectsV2Command({
      Bucket: this.config.fileBucketName,
      Prefix: `workspaces/${operation.workspaceId}/`,
      ContinuationToken: objectCursor?.continuationToken,
      MaxKeys: RESOURCE_PAGE_SIZE,
    }))
    let copied = 0
    for (const object of response.Contents ?? []) {
      if (!object.Key) continue
      const relativeKey = object.Key.slice(`workspaces/${operation.workspaceId}/`.length)
      await this.s3Client.send(new CopyObjectCommand({
        Bucket: this.config.tenantExportBucketName,
        Key: `${createExportPrefix(operation)}/snapshot/files/${relativeKey}`,
        CopySource: encodeCopySource(this.config.fileBucketName, object.Key),
        MetadataDirective: 'COPY',
      }))
      copied += 1
    }
    if (response.IsTruncated && response.NextContinuationToken) {
      return {
        status: 'continuing',
        nextJob: createContinuation(job, {
          targetIndex: targets.length,
          position: encodeCursor({
            kind: 'objects',
            continuationToken: response.NextContinuationToken,
          }),
          phase: 'snapshot',
          processedCount: cursor.processedCount + copied,
        }),
      }
    }
    return cursor.processedCount + copied
  }

  /** Writes the durable marker consumed by artifact preparation and verification. */
  private async writeExportSnapshotMarker(
    operation: TenantOperation,
    processedCount: number,
  ): Promise<void> {
    const body = JSON.stringify({
      schemaVersion: 1,
      operationId: operation.operationId,
      workspaceDigest: digestIdentifier(operation.workspaceId),
      snapshotPrefix: `${createExportPrefix(operation)}/snapshot/`,
      processedCount,
    })
    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.config.tenantExportBucketName,
      Key: `${createExportPrefix(operation)}/snapshot-complete.json`,
      Body: body,
      ContentType: 'application/json',
      ChecksumSHA256: checksumBase64(body),
    }))
  }

  /** Requires one private export object to exist before lifecycle advancement. */
  private async requireExportObject(key: string) {
    try {
      return await this.s3Client.send(new HeadObjectCommand({
        Bucket: this.config.tenantExportBucketName,
        Key: key,
      }))
    } catch (error) {
      if (isAwsNamedError(error, 'NotFound') || isAwsNamedError(error, 'NoSuchKey')) {
        throw new TenantAdministrationError(
          503,
          'TenantExportArtifactMissing',
          'Tenant export artifact is missing.',
        )
      }
      throw error
    }
  }

  /** Revokes non-requester Cognito sessions and deletes active realtime sessions. */
  private async executeAccessRevocation(
    job: TenantOperationExecutionJob,
    operation: TenantOperation,
  ): Promise<TenantOperationResourceOwnerResult> {
    const cursor = job.cursor ?? { targetIndex: 0, processedCount: 0 }
    if (cursor.targetIndex === 0) {
      const target = exactTarget(
        'workspace-access',
        this.config.workspaceAccessTableName,
        'workspaceId',
        'recordKey',
      )
      const page = await this.readDynamoPage(
        target,
        operation.workspaceId,
        decodeDynamoPosition(cursor.position),
        false,
      )
      let revoked = 0
      for (const item of page.items) {
        if (
          item.entryType !== 'workspace-member' ||
          typeof item.memberKey !== 'string' ||
          item.memberKey === operation.requestedBy
        ) {
          continue
        }
        try {
          await this.cognitoClient.send(new AdminUserGlobalSignOutCommand({
            UserPoolId: this.config.cognitoUserPoolId,
            Username: item.memberKey,
          }))
        } catch (error) {
          if (!isAwsNamedError(error, 'UserNotFoundException')) throw error
        }
        revoked += 1
      }
      return {
        status: 'continuing',
        nextJob: createContinuation(job, {
          targetIndex: page.lastEvaluatedKey ? 0 : 1,
          ...(page.lastEvaluatedKey
            ? { position: encodeCursor({ kind: 'dynamo', key: page.lastEvaluatedKey }) }
            : {}),
          processedCount: cursor.processedCount + revoked,
        }),
      }
    }
    if (cursor.targetIndex === 1) {
      const target = attributeTarget(
        'realtime',
        this.config.realtimeSessionsTableName,
        'connectionId',
        undefined,
        [
          workspaceSelector('workspaceId', 'equals'),
        ],
      )
      const page = await this.readDynamoPage(
        target,
        operation.workspaceId,
        decodeDynamoPosition(cursor.position),
        true,
      )
      await this.deleteDynamoItems(target, page.items)
      if (page.lastEvaluatedKey) {
        return {
          status: 'continuing',
          nextJob: createContinuation(job, {
            targetIndex: 1,
            position: encodeCursor({ kind: 'dynamo', key: page.lastEvaluatedKey }),
            processedCount: cursor.processedCount + page.items.length,
          }),
        }
      }
      return await this.completeWithEvidence(job, {
        processedCount: cursor.processedCount + page.items.length,
        sessionsDeleted: page.items.length,
      })
    }
    return { status: 'failed', failureCode: 'ACCESS_REVOCATION_CURSOR_INVALID' }
  }

  /** Replaces non-requester membership PII with deterministic closure tombstones. */
  private async executeMemberAnonymization(
    job: TenantOperationExecutionJob,
    operation: TenantOperation,
  ): Promise<TenantOperationResourceOwnerResult> {
    const cursor = job.cursor ?? { targetIndex: 0, processedCount: 0 }
    if (cursor.targetIndex === 1) {
      return await this.executeTenantAdministrationAnonymization(
        job,
        operation,
        cursor,
      )
    }
    if (cursor.targetIndex !== 0) {
      return { status: 'failed', failureCode: 'IDENTITY_CURSOR_INVALID' }
    }
    const target = exactTarget(
      'workspace-access',
      this.config.workspaceAccessTableName,
      'workspaceId',
      'recordKey',
    )
    const page = await this.readDynamoPage(
      target,
      operation.workspaceId,
      decodeDynamoPosition(cursor.position),
      false,
      IDENTITY_PAGE_SIZE,
    )
    let anonymized = 0
    for (const item of page.items) {
      const recordKey = item.recordKey
      if (typeof recordKey !== 'string') continue
      if (item.entryType === 'workspace-invitation') {
        await this.documentClient.send(new DeleteCommand({
          TableName: target.tableName,
          Key: { workspaceId: operation.workspaceId, recordKey },
        }))
        anonymized += 1
        continue
      }
      if (
        item.entryType !== 'workspace-member' ||
        typeof item.memberKey !== 'string' ||
        item.memberKey === operation.requestedBy ||
        item.anonymizedByOperationId === operation.operationId
      ) {
        continue
      }
      const alias = createTenantDeletedMemberAlias(
        operation.workspaceId,
        operation.operationId,
        item.memberKey,
      )
      const aliasRecordKey = `MEMBER#${alias}`
      const tombstone = {
        workspaceId: operation.workspaceId,
        recordKey: aliasRecordKey,
        entryType: 'workspace-member',
        id: alias,
        memberKey: alias,
        email: alias,
        role: normalizeStoredRole(item.role),
        status: 'deactivated',
        version: normalizeRevision(item.version) + 1,
        createdAt: normalizeTimestamp(item.createdAt, operation.requestedAt),
        updatedAt: this.clock().toISOString(),
        deactivatedAt: this.clock().toISOString(),
        anonymizedByOperationId: operation.operationId,
      }
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: target.tableName,
              Key: { workspaceId: operation.workspaceId, recordKey },
              ConditionExpression: 'memberKey = :memberKey',
              ExpressionAttributeValues: { ':memberKey': item.memberKey },
            },
          },
          {
            Put: {
              TableName: target.tableName,
              Item: tombstone,
              ConditionExpression: 'attribute_not_exists(recordKey)',
            },
          },
        ],
      }))
      anonymized += 1
    }
    if (page.lastEvaluatedKey) {
      return {
        status: 'continuing',
        nextJob: createContinuation(job, {
          targetIndex: 0,
          position: encodeCursor({ kind: 'dynamo', key: page.lastEvaluatedKey }),
          processedCount: cursor.processedCount + anonymized,
        }),
      }
    }
    return {
      status: 'continuing',
      nextJob: createContinuation(job, {
        targetIndex: 1,
        processedCount: cursor.processedCount + anonymized,
      }),
    }
  }

  /** Anonymizes retained control-plane actor fields before destructive deletion starts. */
  private async executeTenantAdministrationAnonymization(
    job: TenantOperationExecutionJob,
    operation: TenantOperation,
    cursor: TenantOperationExecutionCursor,
  ): Promise<TenantOperationResourceOwnerResult> {
    const target = exactTarget(
      'tenant-administration',
      this.config.tenantAdministrationTableName,
      'workspaceId',
      'recordKey',
    )
    const page = await this.readDynamoPage(
      target,
      operation.workspaceId,
      decodeDynamoPosition(cursor.position),
      false,
      IDENTITY_PAGE_SIZE,
    )
    let anonymized = 0
    for (const item of page.items) {
      const payload = item.payload
      if (typeof payload !== 'string') continue
      const anonymizedPayload = anonymizeTenantAdministrationPayload(
        payload,
        operation,
      )
      if (anonymizedPayload === payload) continue
      await this.documentClient.send(new PutCommand({
        TableName: target.tableName,
        Item: { ...item, payload: anonymizedPayload },
        ConditionExpression: 'payload = :expectedPayload',
        ExpressionAttributeValues: { ':expectedPayload': payload },
      }))
      anonymized += 1
    }
    if (page.lastEvaluatedKey) {
      return {
        status: 'continuing',
        nextJob: createContinuation(job, {
          targetIndex: 1,
          position: encodeCursor({ kind: 'dynamo', key: page.lastEvaluatedKey }),
          processedCount: cursor.processedCount + anonymized,
        }),
      }
    }
    return await this.completeWithEvidence(job, {
      anonymizedRecords: cursor.processedCount + anonymized,
      requesterRetainedForVerification: true,
    })
  }

  /** Deletes one bounded page of tenant business data or versioned files. */
  private async executeDataDeletion(
    job: TenantOperationExecutionJob,
    operation: TenantOperation,
  ): Promise<TenantOperationResourceOwnerResult> {
    const targets = this.dataDeletionTargets()
    const cursor = job.cursor ?? { targetIndex: 0, processedCount: 0 }
    if (cursor.targetIndex < targets.length) {
      const target = targets[cursor.targetIndex]
      if (!target) return { status: 'failed', failureCode: 'DATA_TARGET_INVALID' }
      const page = await this.readDynamoPage(
        target,
        operation.workspaceId,
        decodeDynamoPosition(cursor.position),
        true,
      )
      await this.deleteDynamoItems(target, page.items)
      return {
        status: 'continuing',
        nextJob: createContinuation(job, {
          targetIndex: page.lastEvaluatedKey
            ? cursor.targetIndex
            : cursor.targetIndex + 1,
          ...(page.lastEvaluatedKey
            ? { position: encodeCursor({ kind: 'dynamo', key: page.lastEvaluatedKey }) }
            : {}),
          processedCount: cursor.processedCount + page.items.length,
        }),
      }
    }
    if (cursor.targetIndex === targets.length) {
      const versionCursor = decodeVersionPosition(cursor.position)
      const response = await this.s3Client.send(new ListObjectVersionsCommand({
        Bucket: this.config.fileBucketName,
        Prefix: `workspaces/${operation.workspaceId}/`,
        KeyMarker: versionCursor?.keyMarker,
        VersionIdMarker: versionCursor?.versionIdMarker,
        MaxKeys: RESOURCE_PAGE_SIZE,
      }))
      const objects = [
        ...(response.Versions ?? []),
        ...(response.DeleteMarkers ?? []),
      ].flatMap((version) =>
        version.Key && version.VersionId
          ? [{ Key: version.Key, VersionId: version.VersionId }]
          : []
      )
      if (objects.length > 0) {
        const deletion = await this.s3Client.send(new DeleteObjectsCommand({
          Bucket: this.config.fileBucketName,
          Delete: { Objects: objects, Quiet: true },
        }))
        if ((deletion.Errors?.length ?? 0) > 0) {
          throw new TenantAdministrationError(
            503,
            'TenantOperationObjectDeleteIncomplete',
            'Tenant file deletion page was incomplete and must be retried.',
          )
        }
      }
      if (response.IsTruncated && response.NextKeyMarker) {
        return {
          status: 'continuing',
          nextJob: createContinuation(job, {
            targetIndex: targets.length,
            position: encodeCursor({
              kind: 'versions',
              keyMarker: response.NextKeyMarker,
              ...(response.NextVersionIdMarker
                ? { versionIdMarker: response.NextVersionIdMarker }
                : {}),
            }),
            processedCount: cursor.processedCount + objects.length,
          }),
        }
      }
      return await this.completeWithEvidence(job, {
        deletedResources: cursor.processedCount + objects.length,
        versionedFilesDeleted: objects.length,
      })
    }
    return { status: 'failed', failureCode: 'DATA_DELETION_CURSOR_INVALID' }
  }

  /** Deletes one bounded page of tenant-scoped credentials and authorization state. */
  private async executeSecretDeletion(
    job: TenantOperationExecutionJob,
    operation: TenantOperation,
  ): Promise<TenantOperationResourceOwnerResult> {
    return await this.executeDynamoDeletionTargets(
      job,
      operation,
      this.secretDeletionTargets(),
      'deletedSecretRecords',
    )
  }

  /** Verifies that every data and secret target plus the file prefix is empty. */
  private async executeVerification(
    job: TenantOperationExecutionJob,
    operation: TenantOperation,
  ): Promise<TenantOperationResourceOwnerResult> {
    const targets = [
      ...this.dataDeletionTargets(),
      ...this.secretDeletionTargets(),
    ]
    for (const target of targets) {
      const page = await this.readDynamoPage(
        target,
        operation.workspaceId,
        undefined,
        true,
        1,
      )
      if (page.items.length > 0) {
        return { status: 'failed', failureCode: 'VERIFIED_DELETION_INCOMPLETE' }
      }
    }
    const files = await this.s3Client.send(new ListObjectVersionsCommand({
      Bucket: this.config.fileBucketName,
      Prefix: `workspaces/${operation.workspaceId}/`,
      MaxKeys: 1,
    }))
    if (
      (files.Versions?.length ?? 0) > 0 ||
      (files.DeleteMarkers?.length ?? 0) > 0
    ) {
      return { status: 'failed', failureCode: 'VERIFIED_DELETION_INCOMPLETE' }
    }
    return await this.completeWithEvidence(job, {
      checkedTargets: targets.map((target) => target.id),
      versionedFilePrefixEmpty: true,
    })
  }

  /** Executes a bounded sequence of DynamoDB-only deletion targets. */
  private async executeDynamoDeletionTargets(
    job: TenantOperationExecutionJob,
    operation: TenantOperation,
    targets: readonly TenantDynamoTarget[],
    evidenceField: string,
  ): Promise<TenantOperationResourceOwnerResult> {
    const cursor = job.cursor ?? { targetIndex: 0, processedCount: 0 }
    if (cursor.targetIndex >= targets.length) {
      return await this.completeWithEvidence(job, {
        [evidenceField]: cursor.processedCount,
      })
    }
    const target = targets[cursor.targetIndex]
    if (!target) return { status: 'failed', failureCode: 'DELETION_TARGET_INVALID' }
    const page = await this.readDynamoPage(
      target,
      operation.workspaceId,
      decodeDynamoPosition(cursor.position),
      true,
    )
    await this.deleteDynamoItems(target, page.items)
    return {
      status: 'continuing',
      nextJob: createContinuation(job, {
        targetIndex: page.lastEvaluatedKey
          ? cursor.targetIndex
          : cursor.targetIndex + 1,
        ...(page.lastEvaluatedKey
          ? { position: encodeCursor({ kind: 'dynamo', key: page.lastEvaluatedKey }) }
          : {}),
        processedCount: cursor.processedCount + page.items.length,
      }),
    }
  }

  /** Reads one strongly consistent bounded DynamoDB page using tenant-owned keys only. */
  private async readDynamoPage(
    target: TenantDynamoTarget,
    workspaceId: string,
    exclusiveStartKey: Record<string, unknown> | undefined,
    keysOnly: boolean,
    limit = RESOURCE_PAGE_SIZE,
  ): Promise<DynamoPage> {
    const directSelector = target.selectors.length === 1 &&
      target.selectors[0]?.attribute === target.partitionKey &&
      target.selectors[0]?.mode === 'equals'
      ? target.selectors[0]
      : undefined
    const projection = keysOnly
      ? createKeyProjection(target)
      : undefined
    if (directSelector) {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: target.tableName,
        KeyConditionExpression: '#partitionKey = :tenantValue',
        ExpressionAttributeNames: {
          '#partitionKey': target.partitionKey,
          ...projection?.names,
        },
        ExpressionAttributeValues: {
          ':tenantValue': directSelector.value(workspaceId),
        },
        ...(projection && { ProjectionExpression: projection.expression }),
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
        Limit: limit,
      }))
      return {
        items: normalizeItems(response.Items),
        ...(response.LastEvaluatedKey && {
          lastEvaluatedKey: response.LastEvaluatedKey,
        }),
      }
    }
    const names: Record<string, string> = { ...projection?.names }
    const values: Record<string, unknown> = {}
    const filters = target.selectors.map((tenantSelector, index) => {
      const name = `#tenant${String(index)}`
      const value = `:tenant${String(index)}`
      names[name] = tenantSelector.attribute
      values[value] = tenantSelector.value(workspaceId)
      return tenantSelector.mode === 'equals'
        ? `${name} = ${value}`
        : `begins_with(${name}, ${value})`
    })
    const response = await this.documentClient.send(new ScanCommand({
      TableName: target.tableName,
      FilterExpression: `(${filters.join(' OR ')})`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ...(projection ? { ProjectionExpression: projection.expression } : {}),
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
      Limit: limit,
    }))
    return {
      items: normalizeItems(response.Items),
      ...(response.LastEvaluatedKey
        ? { lastEvaluatedKey: response.LastEvaluatedKey }
        : {}),
    }
  }

  /** Deletes one bounded DynamoDB page and rejects unprocessed writes for retry. */
  private async deleteDynamoItems(
    target: TenantDynamoTarget,
    items: readonly Record<string, unknown>[],
  ): Promise<void> {
    if (items.length === 0) return
    const requests = items.map((item) => ({
      DeleteRequest: {
        Key: createItemKey(target, item),
      },
    }))
    const response = await this.documentClient.send(new BatchWriteCommand({
      RequestItems: { [target.tableName]: requests },
    }))
    if ((response.UnprocessedItems?.[target.tableName]?.length ?? 0) > 0) {
      throw new TenantAdministrationError(
        503,
        'TenantOperationDeleteThrottled',
        'Tenant deletion page was throttled and must be retried.',
      )
    }
  }

  /** Writes or reuses one immutable, content-addressed evidence row. */
  private async completeWithEvidence(
    job: TenantOperationExecutionJob,
    summary: Readonly<Record<string, unknown>>,
  ): Promise<TenantOperationResourceOwnerResult> {
    const recordKey = `EVIDENCE#${job.operationId}#${job.step}`
    const existing = await this.documentClient.send(new GetCommand({
      TableName: this.config.tenantAdministrationTableName,
      Key: { workspaceId: job.workspaceId, recordKey },
      ConsistentRead: true,
    }))
    const existingDigest = readEvidenceDigest(existing.Item)
    if (existingDigest) return { status: 'completed', evidenceDigest: existingDigest }
    const evidencePayload = {
      schemaVersion: 1,
      workspaceDigest: digestIdentifier(job.workspaceId),
      operationId: job.operationId,
      step: job.step,
      owner: this.owner,
      summary,
      completedAt: this.clock().toISOString(),
    }
    const evidenceDigest = createTenantOperationEvidenceDigest(evidencePayload)
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.config.tenantAdministrationTableName,
        Item: {
          workspaceId: job.workspaceId,
          recordKey,
          kind: 'operation-evidence',
          evidenceDigest,
          payload: JSON.stringify(evidencePayload),
          createdAt: evidencePayload.completedAt,
        },
        ConditionExpression: 'attribute_not_exists(recordKey)',
      }))
    } catch (error) {
      if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) throw error
      const replay = await this.documentClient.send(new GetCommand({
        TableName: this.config.tenantAdministrationTableName,
        Key: { workspaceId: job.workspaceId, recordKey },
        ConsistentRead: true,
      }))
      const replayDigest = readEvidenceDigest(replay.Item)
      if (!replayDigest) {
        throw new TenantAdministrationError(
          503,
          'TenantOperationEvidenceConflict',
          'Tenant operation evidence conflicted with an invalid record.',
        )
      }
      return { status: 'completed', evidenceDigest: replayDigest }
    }
    return { status: 'completed', evidenceDigest }
  }
}

/** Creates a selector from a literal prefix, Workspace ID, and delimiter-safe suffix. */
function workspaceSelector(
  attribute: string,
  mode: TenantSelector['mode'],
  prefix = '',
  suffix = '',
): TenantSelector {
  return {
    attribute,
    mode,
    value: (workspaceId) => `${prefix}${workspaceId}${suffix}`,
  }
}

/** Creates a selector for modules that URI-encode the Workspace key component. */
function encodedWorkspaceSelector(
  attribute: string,
  mode: TenantSelector['mode'],
  prefix = '',
  suffix = '',
): TenantSelector {
  return {
    attribute,
    mode,
    value: (workspaceId) => `${prefix}${encodeURIComponent(workspaceId)}${suffix}`,
  }
}

/** Creates a directly queryable tenant partition target. */
function exactTarget(
  id: string,
  tableName: string,
  partitionKey: string,
  sortKey: string | undefined,
): TenantDynamoTarget {
  return {
    id,
    tableName,
    partitionKey,
    ...(sortKey ? { sortKey } : {}),
    selectors: [workspaceSelector(partitionKey, 'equals')],
  }
}

/** Creates a delimiter-safe prefix-filtered tenant partition target. */
function delimitedPrefixTarget(
  id: string,
  tableName: string,
  partitionKey: string,
  sortKey: string | undefined,
): TenantDynamoTarget {
  return {
    id,
    tableName,
    partitionKey,
    ...(sortKey ? { sortKey } : {}),
    selectors: [workspaceSelector(partitionKey, 'prefix', '', '#')],
  }
}

/** Creates a scan target whose tenant locator may differ from its primary key. */
function attributeTarget(
  id: string,
  tableName: string,
  partitionKey: string,
  sortKey: string | undefined,
  selectors: readonly TenantSelector[],
): TenantDynamoTarget {
  return {
    id,
    tableName,
    partitionKey,
    ...(sortKey ? { sortKey } : {}),
    selectors,
  }
}

/** Creates a collision-free key projection for deletion and verification reads. */
function createKeyProjection(target: TenantDynamoTarget): {
  readonly expression: string
  readonly names: Record<string, string>
} {
  return {
    expression: target.sortKey ? '#itemPk, #itemSk' : '#itemPk',
    names: {
      '#itemPk': target.partitionKey,
      ...(target.sortKey ? { '#itemSk': target.sortKey } : {}),
    },
  }
}

/** Extracts a complete primary key from a validated DynamoDB page item. */
function createItemKey(
  target: TenantDynamoTarget,
  item: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const partitionValue = item[target.partitionKey]
  if (partitionValue === undefined) {
    throw new TenantAdministrationError(
      503,
      'TenantOperationItemKeyInvalid',
      'Tenant operation item partition key is missing.',
    )
  }
  if (!target.sortKey) return { [target.partitionKey]: partitionValue }
  const sortValue = item[target.sortKey]
  if (sortValue === undefined) {
    throw new TenantAdministrationError(
      503,
      'TenantOperationItemKeyInvalid',
      'Tenant operation item sort key is missing.',
    )
  }
  return {
    [target.partitionKey]: partitionValue,
    [target.sortKey]: sortValue,
  }
}

/** Normalizes SDK item arrays without trusting non-record values. */
function normalizeItems(
  values: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] {
  return (values ?? []).filter(isRecord)
}

/** Serializes one tenant export page while redacting credential-bearing fields. */
function serializeExportPage(
  resource: string,
  items: readonly Record<string, unknown>[],
  format: 'jsonl' | 'csv',
): string {
  if (format === 'csv') {
    const rows = items.map((item) => [
      resource,
      JSON.stringify(redactExportValue(item)),
    ].map(escapeCsvCell).join(','))
    return `resource,record\n${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`
  }
  return items.map((item) => JSON.stringify({
    resource,
    record: redactExportValue(item),
  })).join('\n') + (items.length > 0 ? '\n' : '')
}

/** Recursively removes secrets while preserving tenant-owned business data. */
function redactExportValue(value: unknown, fieldName = ''): unknown {
  if (isSensitiveField(fieldName)) return '[REDACTED]'
  if (Array.isArray(value)) {
    return value.map((entry) => redactExportValue(entry))
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactExportValue(entry, key),
    ]))
  }
  return value
}

/** Returns true for fields that may carry reusable credentials or protected plaintext. */
function isSensitiveField(value: string): boolean {
  const normalized = value.replaceAll(/[^a-z0-9]/giu, '')
  return /(?:authorization|ciphertext|clientsecret|cookie|credential|password|privatekey|refreshtoken|secret|token)$/iu
    .test(normalized)
    || /(?:apikey|authorization|cookie|credential|password|privatekey|secret|signingkey|token)(?:digest|hash)$/iu
      .test(normalized)
}

/** Escapes one RFC 4180-compatible CSV cell. */
function escapeCsvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/** Resolves the export sub-phase for normal export and closure aggregate steps. */
function resolveExportPhase(
  job: TenantOperationExecutionJob,
): 'snapshot' | 'prepare' | 'verify' {
  if (job.step === 'snapshot') return 'snapshot'
  if (job.step === 'prepare-artifact') return 'prepare'
  if (job.step === 'verify-artifact') return 'verify'
  return job.cursor?.phase ?? 'snapshot'
}

/** Creates a continuation that cannot change the current job scope. */
function createContinuation(
  job: TenantOperationExecutionJob,
  cursor: TenantOperationExecutionCursor,
): TenantOperationExecutionJob {
  return { ...job, cursor }
}

/** Encodes a secret-free resource cursor for SQS transport. */
function encodeCursor(cursor: ResourceCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Decodes a DynamoDB continuation key. */
function decodeDynamoPosition(
  value: string | undefined,
): Record<string, unknown> | undefined {
  const cursor = decodeCursor(value)
  return cursor?.kind === 'dynamo' ? cursor.key : undefined
}

/** Decodes an S3 object-list continuation. */
function decodeObjectPosition(value: string | undefined): ObjectCursor | undefined {
  const cursor = decodeCursor(value)
  return cursor?.kind === 'objects' ? cursor : undefined
}

/** Decodes an S3 version-list continuation. */
function decodeVersionPosition(value: string | undefined): VersionCursor | undefined {
  const cursor = decodeCursor(value)
  return cursor?.kind === 'versions' ? cursor : undefined
}

/** Strictly decodes one bounded resource cursor. */
function decodeCursor(value: string | undefined): ResourceCursor | undefined {
  if (value === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw invalidCursor()
  }
  if (!isRecord(parsed) || typeof parsed.kind !== 'string') throw invalidCursor()
  if (parsed.kind === 'dynamo' && isRecord(parsed.key)) {
    return { kind: 'dynamo', key: parsed.key }
  }
  if (
    parsed.kind === 'objects' &&
    (parsed.continuationToken === undefined || typeof parsed.continuationToken === 'string')
  ) {
    return {
      kind: 'objects',
      ...(typeof parsed.continuationToken === 'string'
        ? { continuationToken: parsed.continuationToken }
        : {}),
    }
  }
  if (
    parsed.kind === 'versions' &&
    (parsed.keyMarker === undefined || typeof parsed.keyMarker === 'string') &&
    (parsed.versionIdMarker === undefined || typeof parsed.versionIdMarker === 'string')
  ) {
    return {
      kind: 'versions',
      ...(typeof parsed.keyMarker === 'string' ? { keyMarker: parsed.keyMarker } : {}),
      ...(typeof parsed.versionIdMarker === 'string'
        ? { versionIdMarker: parsed.versionIdMarker }
        : {}),
    }
  }
  throw invalidCursor()
}

/** Creates a stable invalid-cursor failure. */
function invalidCursor(): TenantAdministrationError {
  return new TenantAdministrationError(
    400,
    'TenantOperationCursorInvalid',
    'Tenant operation continuation cursor is invalid.',
  )
}

/** Creates an opaque deterministic S3 prefix without exposing tenant identifiers. */
function createExportPrefix(operation: TenantOperation): string {
  return `tenant-exports/${digestIdentifier(operation.workspaceId)}/${digestIdentifier(operation.operationId)}`
}

/** Creates one deterministic lowercase SHA-256 identifier digest. */
function digestIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Creates an S3 checksum value from UTF-8 content. */
function checksumBase64(value: string): string {
  return createHash('sha256').update(value).digest('base64')
}

/** Encodes an S3 copy source without changing slash separators. */
function encodeCopySource(bucketName: string, objectKey: string): string {
  return `${bucketName}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
}

/** Normalizes an optional quoted S3 entity tag. */
function normalizeEtag(value: string | undefined): string {
  return value?.replaceAll('"', '') ?? ''
}

/** Normalizes a stored role without retaining unknown values. */
function normalizeStoredRole(value: unknown): 'owner' | 'admin' | 'member' | 'guest' {
  if (value === 'owner' || value === 'admin' || value === 'member' || value === 'guest') {
    return value
  }
  return 'member'
}

/** Normalizes a stored optimistic revision. */
function normalizeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0
}

/** Normalizes a stored timestamp without propagating malformed values. */
function normalizeTimestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? value
    : fallback
}

/** Replaces retained top-level member identity fields in one control-plane payload. */
function anonymizeTenantAdministrationPayload(
  payload: string,
  operation: TenantOperation,
): string {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new TenantAdministrationError(
      503,
      'TenantAdministrationPayloadInvalid',
      'Tenant administration payload is invalid during anonymization.',
    )
  }
  if (!isRecord(value)) {
    throw new TenantAdministrationError(
      503,
      'TenantAdministrationPayloadInvalid',
      'Tenant administration payload is invalid during anonymization.',
    )
  }
  if (value.operationId === operation.operationId) {
    return payload
  }
  let changed = false
  const anonymized = Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (
      (key === 'ownerMemberKey' || key === 'requestedBy' || key === 'updatedBy') &&
      typeof entry === 'string' &&
      isPersonalMemberIdentity(entry)
    ) {
      changed = true
      return [
        key,
        createTenantDeletedMemberAlias(
          operation.workspaceId,
          operation.operationId,
          entry,
        ),
      ]
    }
    return [key, entry]
  }))
  return changed ? JSON.stringify(anonymized) : payload
}

/** Returns whether one actor field contains a user identity rather than a service identity. */
function isPersonalMemberIdentity(value: string): boolean {
  return !/^(?:deleted\+|executor:|meter:|system:)/u.test(value)
}

/** Reads one validated content-addressed evidence digest. */
function readEvidenceDigest(value: unknown): string | undefined {
  if (
    !isRecord(value) ||
    value.kind !== 'operation-evidence' ||
    typeof value.evidenceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.evidenceDigest)
  ) {
    return undefined
  }
  return value.evidenceDigest
}

/** Returns true for one AWS error name without exposing its message. */
function isAwsNamedError(error: unknown, name: string): boolean {
  return isRecord(error) && error.name === name
}

/** Returns true for a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
