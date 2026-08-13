import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  GetObjectTaggingCommand,
  PutObjectTaggingCommand,
  S3Client,
  type Tag,
} from '@aws-sdk/client-s3'
import type { EnterpriseIdentitySnapshot } from '@mukuroji/contracts'
import { isCanonicalWorkItemRecord } from '../../../work-items'
import {
  evaluateEnterpriseAccess,
  resolveEnterpriseDirectoryPrincipal,
  type EnterpriseIdentityReadCapability,
} from '../../../enterprise-identity'
import type {
  CollaborationRealtimePublisher,
} from '../../application/ports/realtime-publisher'
import {
  createPlanningUpdateCollaborationEntityKey,
  createPlanningUpdatePublicTargetKey,
  createProjectCollaborationEntityKey,
} from '../../collaboration'
import {
  NOTIFICATION_PREFERENCES_KEY,
  createNotificationDeliveryPlan,
  parsePlanningUpdateTargetScheduleProjection,
  parseStoredNotificationPreferences,
  type PlanningScheduledNotificationKind,
  type NotificationPreferences,
} from '../../../notifications'
import { isMissingFileObjectVersionError } from '../../../files'
import type {
  BatchItemFailure,
  BatchResponse,
  DynamoAttributeValue,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from '../../../../infrastructure/aws/dynamodb-stream'

export type {
  BatchItemFailure,
  BatchResponse,
  DynamoAttributeValue,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from '../../../../infrastructure/aws/dynamodb-stream'

/**
 * Audit metadata に保存された notification recipient 候補です。
 */
export type NotificationCandidate = {
  /** Workspace member key です。 */
  memberKey: string
  /** mention、watcher、reply などの通知理由です。 */
  reason: string
}

/**
 * projection に必要な audit event の正規化表現です。
 */
export type AuditProjectionEvent = {
  /** deterministic audit event ID です。 */
  eventId: string
  /** comment.created などの event type です。 */
  eventType: string
  /** event が属する canonical Workspace ID です。 */
  workspaceId: string
  /** event を起こした actor member key です。 */
  actorUserId?: string
  /** Workspace membership と同じ namespace の actor member key です。 */
  actorMemberKey?: string
  /** Inbox で actor を表示する安全なラベルです。 */
  actorLabel?: string
  /** realtime client が購読する entity scope key です。 */
  scopeKey?: string
  /** entity の公開 ID です。 */
  entityId?: string
  /** target の公開 ID です。 */
  targetId?: string
  /** event の発生日時です。 */
  occurredAt: string
  /** notification recipient 候補です。 */
  notificationCandidates: NotificationCandidate[]
  /** 通知から対象へ遷移する path です。 */
  deepLink?: string
  /** 現在権限の照合に使う team ID です。 */
  teamId?: string
  /** 現在の assigned project を再解決する Work Item ID です。 */
  issueId?: string
  /** Team Triage notification の構造化 Entry target です。 */
  triageEntryId?: string
  /** 現在権限の照合に使う project ID です。 */
  projectId?: string
  /** current comment ID です。 */
  commentId?: string
  /** Curated context item ID targeted by the durable Workspace Search projection. */
  contextItemId?: string
  /** Canonical curated-context revision represented by this audit event. */
  sourceRevision?: number
  /** File proofing cleanup の対象 file ID です。 */
  fileId?: string
  /** Reply が属する root comment ID です。 */
  rootCommentId?: string
  /** Inbox 行に表示する対象タイトルです。 */
  notificationTitle?: string
  /** Audit event の安全な短い概要です。 */
  summary?: string
  /** Scheduled due/overdue event が対象にした date-only 期限です。 */
  dueDate?: string
  /** Scheduled Planning event の Project / Initiative target type です。 */
  planningTargetType?: 'project' | 'initiative'
  /** Scheduled Planning event の canonical target ID です。 */
  planningTargetId?: string
  /** Scheduled Planning event が再検証する UPDATE_TARGET record key です。 */
  planningTargetRecordKey?: string
  /** Scheduled Planning event が対象にした cadence occurrence deadline です。 */
  planningNextDueAt?: string
  /** Scheduled Planning event の reminder / overdue / escalation kind です。 */
  planningNotificationKind?: PlanningScheduledNotificationKind
  /** notification/realtime consumer へ配送する event かどうかです。 */
  outboxStatus: 'pending' | 'suppressed'
}

/** File delete cleanup が更新する DynamoDB key です。 */
export type DeletedFileMetadataKey = {
  /** FileProofingTable の partition key です。 */
  scopeKey: string
  /** FileProofingTable の sort key です。 */
  recordKey: string
}

/** File delete cleanup の object storage target です。 */
export type DeletedFileObjectVersion = {
  /** File bucket 内の immutable object key です。 */
  objectKey: string
  /** Versioned S3 object の immutable VersionId です。 */
  objectVersionId: string
}

/** Durable file delete cleanup の外部 I/O contract です。 */
export interface DeletedFileCleanupDependencies {
  /** File metadata row を強整合 read します。 */
  readFile(scopeKey: string, fileId: string): Promise<Record<string, unknown> | undefined>
  /** File scope 内の関連 rows を prefix query します。 */
  queryRows(scopeKey: string, recordPrefix: string): Promise<Array<Record<string, unknown>>>
  /** Immutable object version を deleted quarantine へ移します。 */
  tagDeletedObjectVersion(target: DeletedFileObjectVersion): Promise<void>
  /** 関連 metadata に tombstone と同じ retention を設定します。 */
  expireMetadata(
    keys: DeletedFileMetadataKey[],
    expiresAt: number,
    retentionUntil: string,
  ): Promise<void>
}

/** External ports used by one collaboration projection batch. */
export interface CollaborationProjectionDependencies {
  /** Port that performs durable file-delete cleanup. */
  deletedFileCleanup: DeletedFileCleanupDependencies
  /** Port that maintains durable Workspace Search context projections. */
  curatedContextSearch: CuratedContextSearchProjectionDependencies
  /** Port that publishes realtime invalidations. */
  realtime: CollaborationRealtimePublisher
  /** Optional authoritative Enterprise Identity reader for cadence authorization. */
  enterpriseIdentity?: Pick<EnterpriseIdentityReadCapability, 'getSnapshot'>
}

/** Canonical scope passed to the curated context Search projection. */
export type CuratedContextSearchProjectionInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Team identifier that owns the parent Work Item. */
  teamId: string
  /** Parent Work Item identifier. */
  issueId: string
  /** Current assigned Project identifier, when assigned. */
  projectId?: string
  /** Curated context item identifier that changed. */
  contextItemId: string
  /** Canonical revision represented by the audit event, when available. */
  sourceRevision?: number
}

/** Idempotent port for the current curated context Search document. */
export interface CuratedContextSearchProjectionDependencies {
  /** Upserts the current canonical context item into Search. */
  upsertCurrent(input: CuratedContextSearchProjectionInput): Promise<void>
  /** Deletes a superseded or orphaned context item Search document. */
  deleteCurrent(input: CuratedContextSearchProjectionInput): Promise<void>
}

/**
 * ProjectDirectoryTable から permission projection に使う row です。
 */
export type ProjectDirectoryItem = {
  /** directory row の sort key です。 */
  entryKey?: string
  /** team、project、project-member などの row type です。 */
  entryType?: string
  /** row が属する team ID です。 */
  teamId?: string
  /** row が属する project ID です。 */
  projectId?: string
  /** project member key です。 */
  memberKey?: string
  /** project member role です。 */
  role?: string
  /** archive 済み row の timestamp です。 */
  archivedAt?: string
}

/** Cognito group membership の1ページ分の正規化結果です。 */
export type CognitoGroupPage = {
  /** ページに含まれる Cognito group names です。 */
  groupNames: string[]
  /** 次ページがある場合の opaque pagination token です。 */
  nextToken?: string
}

/** Cognito group membership の1ページを取得する reader です。 */
export type CognitoGroupPageReader = (nextToken?: string) => Promise<CognitoGroupPage>

/**
 * 同じ recipient/event にまとめた notification candidate です。
 */
export type GroupedNotificationCandidate = {
  /** notification recipient の Workspace member key です。 */
  memberKey: string
  /** 同じ event で recipient に該当した理由一覧です。 */
  reasons: string[]
}

/**
 * notification row と recipient receipt の deterministic keys です。
 */
export type NotificationProjectionKeys = {
  /** NotificationsTable の partition key です。 */
  recipientKey: string
  /** NotificationsTable の sort key です。 */
  notificationKey: string
  /** ProcessedAuditEventsTable の recipient-scoped consumer name です。 */
  consumerName: string
}

/** Preference を反映した notification projection state です。 */
export type NotificationProjectionDeliveryState = {
  /** In-app Inbox に notification を表示するかどうかです。 */
  inAppVisible: boolean
  /** Inbox state です。In-app が無効なら archive として投影します。 */
  inboxState: 'unread' | 'archived'
  /** RecipientStatusIndex の partition key です。 */
  recipientStatusKey: string
  /** In-app 無効時に保存する archive timestamp です。 */
  archivedAt?: string
  /** 有効な delivery channel 一覧です。 */
  deliveryChannels: Array<'inApp' | 'email' | 'push'>
  /** Digest/quiet hours を反映した最短 delivery 時刻です。 */
  deliveryAfter: string
  /** Delivery plan の frequency です。 */
  deliveryFrequency: NotificationPreferences['frequency']
}

/** Projection 時点で強整合 read した Work Item scope です。 */
export type CurrentWorkItemNotificationScope = {
  /** Work Item read を実施できる event だったかどうかです。 */
  checked: boolean
  /** Work Item が現在も存在するかどうかです。 */
  exists: boolean
  /** 現在割り当てられている Project ID です。 */
  projectId?: string
  /** 現在の担当 Workspace member key です。 */
  assigneeMemberKey?: string
  /** 現在の date-only 期限です。 */
  dueDate?: string
  /** 現在の標準 workflow status category です。 */
  statusCategory?: string
}

/** Projection 時に強整合 read した Planning update target scope です。 */
export type CurrentPlanningUpdateNotificationScope = {
  /** Planning update target read を実施できる event だったかどうかです。 */
  checked: boolean
  /** Canonical target row と Initiative source が現在も存在するかどうかです。 */
  exists: boolean
  /** Current target が archived / disabled かどうかです。 */
  archived: boolean
  /** Current Project / Initiative target type です。 */
  targetType?: 'project' | 'initiative'
  /** Current canonical target ID です。 */
  targetId?: string
  /** Current target record key です。 */
  targetRecordKey?: string
  /** Current update owner member key です。 */
  ownerMemberKey?: string
  /** Current escalation recipient member key です。 */
  escalationMemberKey?: string
  /** Current cadence occurrence deadline です。 */
  nextDueAt?: string
  /** Current Team authorization scope です。 */
  teamId?: string
  /** Current Project authorization scope です。 */
  projectId?: string
}

/** Indicates that a Search projection receipt lost its parent Work Item fence. */
class CuratedContextSearchParentScopeChangedError extends Error {
  constructor() {
    super('Curated context search parent scope changed before receipt acknowledgement.')
    this.name = 'CuratedContextSearchParentScopeChangedError'
  }
}

/** Parent snapshot used to fence a curated-context Search receipt write. */
type CuratedContextSearchReceiptFence = {
  /** Audit event whose parent row is being fenced. */
  event: AuditProjectionEvent
  /** Parent scope observed immediately before the receipt write. */
  scope: CurrentWorkItemNotificationScope
}

const dynamoDbClient = new DynamoDBClient({ region: getAwsRegion() })
const cognitoClient = new CognitoIdentityProviderClient({ region: getAwsRegion() })
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})
const s3Client = new S3Client({ region: getAwsRegion() })
const projectionConsumerName = 'collaboration-projection-v1'
/** Independent receipt namespace for context search during rolling deployments. */
const curatedContextSearchProjectionConsumerName = 'collaboration-context-search-v2'
const watcherNotificationEventTypes = new Set([
  'comment.created',
  'comment.replied',
  'comment.edited',
  'planning-update.reminder',
  'planning-update.overdue',
  'planning-update.escalation',
  'context-item.created',
  'context-item.updated',
  'accepted-resolution.selected',
  'accepted-resolution.replaced',
  'accepted-resolution.edited',
])
const curatedContextSearchUpsertEventTypes = new Set([
  'context-item.created',
  'context-item.updated',
])
const curatedContextSearchProjectionEventTypes = new Set([
  ...curatedContextSearchUpsertEventTypes,
  'context-item.superseded',
])

/**
 * Reports whether one collaboration audit event should notify current scope watchers.
 *
 * @param eventType - Canonical append-only audit event type.
 * @returns Whether watcher candidates must be resolved for the event.
 */
export function supportsCollaborationWatcherNotifications(eventType: string) {
  return watcherNotificationEventTypes.has(eventType)
}

/**
 * Projects one curated-context audit event into Workspace search.
 *
 * @param event - Parsed canonical audit event.
 * @param dependencies - Idempotent search projection operations.
 * @param workItemExists - Whether the parent Work Item still exists at projection time.
 * @returns A promise that resolves after a relevant event is projected.
 */
export async function projectCuratedContextSearchEvent(
  event: AuditProjectionEvent,
  dependencies: CuratedContextSearchProjectionDependencies,
  workItemExists = true,
): Promise<void> {
  if (!curatedContextSearchProjectionEventTypes.has(event.eventType)) {
    return
  }

  const teamId = requireContextSearchProjectionIdentifier(event.teamId, 'team ID')
  const issueId = requireContextSearchProjectionIdentifier(event.issueId, 'Work Item ID')
  const contextItemId = requireContextSearchProjectionIdentifier(
    event.contextItemId,
    'context item ID',
  )
  const entityId = `team/${teamId}/issue/${issueId}`
  const scopeKey = `${event.workspaceId}#work-item#${entityId}`
  const targetId = `${entityId}/context-item/${contextItemId}`
  if (
    event.entityId !== entityId ||
    event.scopeKey !== scopeKey ||
    event.targetId !== targetId
  ) {
    throw new Error('Curated context search projection scope is invalid.')
  }

  const input: CuratedContextSearchProjectionInput = {
    workspaceId: event.workspaceId,
    teamId,
    issueId,
    contextItemId,
    ...(event.sourceRevision === undefined ? {} : { sourceRevision: event.sourceRevision }),
    ...(event.projectId ? { projectId: event.projectId } : {}),
  }
  if (workItemExists && curatedContextSearchUpsertEventTypes.has(event.eventType)) {
    await dependencies.upsertCurrent(input)
    return
  }
  await dependencies.deleteCurrent(input)
}

/**
 * Projects a context-search event while fencing the parent Work Item scope.
 *
 * The parent assignment can change independently of the audit stream event.
 * A fresh read immediately before and after the Search write keeps stale
 * project documents from being acknowledged as processed; a changed scope
 * deletes the old projection and leaves the stream record retryable.
 *
 * @param event - Parsed canonical audit event.
 * @param dependencies - Idempotent search projection operations.
 * @param readParentScope - Strongly consistent parent Work Item reader.
 * @returns The latest parent scope for the notification projection.
 * @throws Error when the parent scope changes around the Search write.
 */
export async function projectCuratedContextSearchEventWithParentFence(
  event: AuditProjectionEvent,
  dependencies: CuratedContextSearchProjectionDependencies,
  readParentScope: (
    event: AuditProjectionEvent,
  ) => Promise<CurrentWorkItemNotificationScope> = readCurrentWorkItemScope,
): Promise<CurrentWorkItemNotificationScope> {
  const before = await readParentScope(event)
  const scopedEvent = before.checked
    ? { ...event, projectId: before.projectId }
    : event
  await projectCuratedContextSearchEvent(scopedEvent, dependencies, before.exists)

  const after = await readParentScope(event)
  if (sameCuratedContextParentScope(before, after)) {
    return after
  }

  // Remove a document written under the stale scope before the event is
  // retried. The retry will resolve the new project or delete the orphan.
  await projectCuratedContextSearchEvent(scopedEvent, dependencies, false)
  throw new Error('Curated context search parent scope changed during projection.')
}

/**
 * Compares the parent fields that determine a context Search document scope.
 *
 * @param left - Scope observed before the Search write.
 * @param right - Scope observed after the Search write.
 * @returns Whether both reads describe the same parent assignment/existence.
 */
function sameCuratedContextParentScope(
  left: CurrentWorkItemNotificationScope,
  right: CurrentWorkItemNotificationScope,
) {
  return left.checked === right.checked &&
    left.exists === right.exists &&
    left.projectId === right.projectId
}

/**
 * Requires one non-empty identifier from curated-context audit metadata.
 *
 * @param value - Candidate identifier.
 * @param label - Safe diagnostic label.
 * @returns The validated identifier.
 */
function requireContextSearchProjectionIdentifier(
  value: string | undefined,
  label: string,
) {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`Curated context search projection ${label} is missing.`)
  }
  return normalized
}

/**
 * Audit stream batch を処理し、cleanup 失敗を record 単位の retry response に変換します。
 */
export async function processCollaborationProjectionBatch(
  event: DynamoStreamEvent,
  dependencies: CollaborationProjectionDependencies,
): Promise<BatchResponse> {
  const records = event.Records ?? []
  const currentSystemAdminCache = new Map<string, Promise<boolean>>()
  const enterpriseSnapshotCache = new Map<string, Promise<EnterpriseIdentitySnapshot>>()
  const results = await Promise.all(
    records.map(async (record) => {
      try {
        await processRecord(
          record,
          currentSystemAdminCache,
          enterpriseSnapshotCache,
          dependencies,
        )
        return undefined
      } catch (error) {
        console.error('Collaboration projection failed:', error)
        return createDynamoBatchItemFailure(record)
      }
    }),
  )

  return {
    batchItemFailures: results.filter(isDefined),
  }
}

async function processRecord(
  record: DynamoStreamRecord,
  currentSystemAdminCache: Map<string, Promise<boolean>>,
  enterpriseSnapshotCache: Map<string, Promise<EnterpriseIdentitySnapshot>>,
  dependencies: CollaborationProjectionDependencies,
) {
  if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) {
    return
  }

  const event = parseAuditProjectionEvent(unmarshalMap(record.dynamodb.NewImage))

  if (!event) {
    return
  }

  await cleanupDeletedFileProjection(event, dependencies.deletedFileCleanup)

  if (event.outboxStatus !== 'pending') {
    return
  }

  const isCuratedContextEvent = curatedContextSearchProjectionEventTypes.has(event.eventType)
  const searchProjectionProcessed = isCuratedContextEvent
    ? await isProjectionProcessed(event.eventId, curatedContextSearchProjectionConsumerName)
    : true
  let currentScope: CurrentWorkItemNotificationScope | undefined
  if (isCuratedContextEvent && !searchProjectionProcessed) {
    currentScope = await readCurrentWorkItemScope(event)
  }
  if (await isProjectionProcessed(event.eventId)) {
    if (isCuratedContextEvent && !searchProjectionProcessed && currentScope) {
      currentScope = await projectCuratedContextSearchEventWithParentFence(
        event,
        dependencies.curatedContextSearch,
      )
      await acknowledgeCuratedContextSearchProjection(
        event.eventId,
        event,
        currentScope,
        dependencies.curatedContextSearch,
      )
    }
    return
  }

  currentScope ??= await readCurrentWorkItemScope(event)
  if (isCuratedContextEvent && !searchProjectionProcessed) {
    currentScope = await projectCuratedContextSearchEventWithParentFence(
      event,
      dependencies.curatedContextSearch,
    )
    await acknowledgeCuratedContextSearchProjection(
      event.eventId,
      event,
      currentScope,
      dependencies.curatedContextSearch,
    )
  }
  if (!currentScope.exists) {
    await markProjectionProcessed(event.eventId)
    return
  }
  const workItemScopedEvent = currentScope.checked
    ? overlayCurrentWorkItemNotificationScope(event, currentScope)
    : event
  const workItemAuthorizationEvent = refreshScheduledNotificationEvent(
    workItemScopedEvent,
    currentScope,
  )
  if (!workItemAuthorizationEvent) {
    await markProjectionProcessed(event.eventId)
    return
  }

  const planningScope = await readCurrentPlanningUpdateScope(workItemAuthorizationEvent)
  if (!planningScope.exists) {
    await markProjectionProcessed(event.eventId)
    return
  }
  const planningScopedEvent = planningScope.checked
    ? {
      ...workItemAuthorizationEvent,
      teamId: planningScope.teamId,
      projectId: planningScope.projectId,
    }
    : workItemAuthorizationEvent
  const authorizationEvent = refreshPlanningScheduledNotificationEvent(
    planningScopedEvent,
    planningScope,
  )
  if (!authorizationEvent) {
    await markProjectionProcessed(event.eventId)
    return
  }

  const parentCondition = currentScope.checked && authorizationEvent.teamId && authorizationEvent.issueId
    ? createCuratedContextSearchParentCondition(
        requireEnv('TEAM_ISSUES_TABLE_NAME'),
        authorizationEvent,
        currentScope,
      )
    : undefined
  const watcherCandidates = await readSubscribedWatcherCandidates(authorizationEvent)
  const candidates = groupNotificationCandidates({
    ...authorizationEvent,
    notificationCandidates: [
      ...authorizationEvent.notificationCandidates,
      ...watcherCandidates,
    ],
  })
  const directoryItems = candidates.length > 0 && (authorizationEvent.projectId || authorizationEvent.teamId)
    ? await readProjectDirectory(authorizationEvent.workspaceId)
    : []
  const eligibleCandidates = (
    await Promise.all(
      candidates.map(async (candidate) =>
        await isEligibleRecipient(
          authorizationEvent,
          candidate.memberKey,
          directoryItems,
          currentSystemAdminCache,
          dependencies.enterpriseIdentity,
          enterpriseSnapshotCache,
        )
          ? candidate
          : undefined,
      ),
    )
  ).filter(isDefined)

  await Promise.all(
    eligibleCandidates.map((candidate) => projectNotification(
      authorizationEvent,
      candidate,
      parentCondition,
    )),
  )
  await publishRealtimeInvalidation(event, dependencies.realtime)
  await markProjectionProcessed(event.eventId)
}

/**
 * file.deleted outbox event から同期 delete の durable fallback cleanup を実行します。
 */
export async function cleanupDeletedFileProjection(
  event: AuditProjectionEvent,
  dependencies: DeletedFileCleanupDependencies,
): Promise<void> {
  if (event.eventType !== 'file.deleted') {
    return
  }

  const fileId = event.fileId ?? event.targetId
  if (!fileId || !event.teamId || (!event.issueId && !event.projectId)) {
    throw new Error('file.deleted cleanup metadata is incomplete.')
  }

  const scopeKey = event.issueId
    ? `WORKSPACE#${event.workspaceId}#TEAM#${event.teamId}#WORKITEM#${event.issueId}`
    : `WORKSPACE#${event.workspaceId}#TEAM#${event.teamId}#PROJECT#${event.projectId}`
  const file = await dependencies.readFile(scopeKey, fileId)
  if (
    !file ||
    file.entryType !== 'file' ||
    readString(file.scopeKey) !== scopeKey ||
    readString(file.fileId) !== fileId ||
    !readString(file.deletedAt)
  ) {
    throw new Error('Deleted file metadata row is unavailable or invalid.')
  }

  const expiresAt = readPositiveInteger(file.expiresAt)
  const retentionUntil = readString(file.retentionUntil)
  if (!expiresAt || !retentionUntil) {
    throw new Error('Deleted file retention metadata is unavailable or invalid.')
  }

  const expectedObjectPrefix = [
    'workspaces',
    encodeURIComponent(event.workspaceId),
    'files',
    encodeURIComponent(fileId),
    '',
  ].join('/')
  if (!Array.isArray(file.versions)) {
    throw new Error('Deleted file version metadata is invalid.')
  }
  const versions = file.versions
  const immutableVersions = versions.flatMap((version) => {
    if (!isRecord(version)) {
      throw new Error('Deleted file version metadata is invalid.')
    }

    const objectVersionId = readString(version.objectVersionId)
    if (!objectVersionId) {
      return []
    }

    const objectKey = readString(version.objectKey)
    if (!objectKey || !objectKey.startsWith(expectedObjectPrefix)) {
      throw new Error('Deleted file object key is unavailable or outside its file prefix.')
    }

    return [{ objectKey, objectVersionId } satisfies DeletedFileObjectVersion]
  })

  await Promise.all(immutableVersions.map((target) =>
    dependencies.tagDeletedObjectVersion(target)
  ))

  const [annotations, approvalIndexes] = await Promise.all([
    dependencies.queryRows(scopeKey, `ANNOTATION#${fileId}#`),
    dependencies.queryRows(scopeKey, `FILE_APPROVAL#${fileId}#`),
  ])
  const keys: DeletedFileMetadataKey[] = annotations
    .filter((item) => item.entryType === 'annotation')
    .map(readDeletedFileMetadataKey)

  for (const approvalIndex of approvalIndexes) {
    if (
      approvalIndex.entryType !== 'file-approval-index' ||
      readString(approvalIndex.fileId) !== fileId
    ) {
      continue
    }

    keys.push(readDeletedFileMetadataKey(approvalIndex))
    const approvalId = readString(approvalIndex.approvalId)
    const dueAt = readString(approvalIndex.dueAt)
    const reviewerMemberKeys = Array.isArray(approvalIndex.reviewerMemberKeys)
      ? approvalIndex.reviewerMemberKeys
      : undefined
    if (!approvalId || !dueAt || !reviewerMemberKeys) {
      throw new Error('Deleted file approval index metadata is invalid.')
    }
    keys.push({ scopeKey, recordKey: `APPROVAL#${approvalId}` })

    for (const reviewerMemberKey of reviewerMemberKeys) {
      const memberKey = normalizeMemberKey(readString(reviewerMemberKey))
      if (!memberKey) {
        throw new Error('Deleted file approval index reviewer metadata is invalid.')
      }
      keys.push({
        scopeKey: `WORKSPACE#${event.workspaceId}#REVIEWER#${memberKey}`,
        recordKey: `APPROVAL#${dueAt}#${approvalId}`,
      })
    }
  }

  await dependencies.expireMetadata(deduplicateMetadataKeys(keys), expiresAt, retentionUntil)
}

/** Existing S3 tags を保持したまま deleted quarantine tag を上書きします。 */
export function mergeDeletedObjectTags(tags: Tag[] | undefined): Tag[] {
  const preservedTags = (tags ?? []).filter((tag): tag is Required<Pick<Tag, 'Key' | 'Value'>> =>
    typeof tag.Key === 'string' &&
    typeof tag.Value === 'string' &&
    tag.Key !== 'mukuroji-deleted'
  )
  return [...preservedTags, { Key: 'mukuroji-deleted', Value: 'true' }]
}

/** Immutable file object version に deleted quarantine tag を冪等に付与します。 */
export async function tagDeletedFileObjectVersion(
  client: S3Client,
  bucketName: string,
  target: DeletedFileObjectVersion,
) {
  try {
    const current = await client.send(new GetObjectTaggingCommand({
      Bucket: bucketName,
      Key: target.objectKey,
      VersionId: target.objectVersionId,
    }))
    if (current.TagSet?.some((tag) => tag.Key === 'mukuroji-deleted' && tag.Value === 'true')) {
      return
    }
    await client.send(new PutObjectTaggingCommand({
      Bucket: bucketName,
      Key: target.objectKey,
      VersionId: target.objectVersionId,
      Tagging: { TagSet: mergeDeletedObjectTags(current.TagSet) },
    }))
  } catch (error) {
    if (!isMissingFileObjectVersionError(error)) {
      throw error
    }
  }
}

const defaultDeletedFileCleanupDependencies: DeletedFileCleanupDependencies = {
  async readFile(scopeKey, fileId) {
    const response = await documentClient.send(new GetCommand({
      TableName: requireEnv('FILE_PROOFING_TABLE_NAME'),
      Key: { scopeKey, recordKey: `FILE#${fileId}` },
      ConsistentRead: true,
    }))
    return response.Item
  },
  async queryRows(scopeKey, recordPrefix) {
    const items: Array<Record<string, unknown>> = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await documentClient.send(new QueryCommand({
        TableName: requireEnv('FILE_PROOFING_TABLE_NAME'),
        KeyConditionExpression: 'scopeKey = :scopeKey AND begins_with(recordKey, :recordPrefix)',
        ExpressionAttributeValues: {
          ':scopeKey': scopeKey,
          ':recordPrefix': recordPrefix,
        },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }))
      items.push(...(response.Items ?? []))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return items
  },
  async tagDeletedObjectVersion(target) {
    await tagDeletedFileObjectVersion(
      s3Client,
      requireEnv('FILE_BUCKET_NAME'),
      target,
    )
  },
  async expireMetadata(keys, expiresAt, retentionUntil) {
    for (let index = 0; index < keys.length; index += 20) {
      await Promise.all(keys.slice(index, index + 20).map(async (key) => {
        try {
          await documentClient.send(new UpdateCommand({
            TableName: requireEnv('FILE_PROOFING_TABLE_NAME'),
            Key: key,
            UpdateExpression: 'SET expiresAt = :expiresAt, retentionUntil = :retentionUntil',
            ConditionExpression: 'attribute_exists(scopeKey) AND attribute_exists(recordKey)',
            ExpressionAttributeValues: { ':expiresAt': expiresAt, ':retentionUntil': retentionUntil },
          }))
        } catch (error) {
          if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) {
            throw error
          }
        }
      }))
    }
  },
}

/** Production AWS adapter を使う durable file cleanup dependencies を返します。 */
export function createDefaultDeletedFileCleanupDependencies(): DeletedFileCleanupDependencies {
  return defaultDeletedFileCleanupDependencies
}

function readDeletedFileMetadataKey(item: Record<string, unknown>): DeletedFileMetadataKey {
  const scopeKey = readString(item.scopeKey)
  const recordKey = readString(item.recordKey)
  if (!scopeKey || !recordKey) {
    throw new Error('Deleted file related metadata key is invalid.')
  }
  return { scopeKey, recordKey }
}

function deduplicateMetadataKeys(keys: DeletedFileMetadataKey[]) {
  return [...new Map(keys.map((key) => [`${key.scopeKey}\0${key.recordKey}`, key])).values()]
}

async function readSubscribedWatcherCandidates(event: AuditProjectionEvent) {
  if (!supportsCollaborationWatcherNotifications(event.eventType)) {
    return []
  }

  const scopes = createSubscribedWatcherScopes(event)
  const pages = await Promise.all(scopes.map(async ({ entityKey, reason }) => {
    const candidates: NotificationCandidate[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined

    do {
      const response = await documentClient.send(new QueryCommand({
        TableName: requireEnv('COLLABORATION_TABLE_NAME'),
        KeyConditionExpression: 'entityKey = :entityKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':entityKey': entityKey,
          ':prefix': 'WATCHER#',
        },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }))
      candidates.push(...toSubscribedWatcherCandidates(response.Items ?? [], reason))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return candidates
  }))

  return pages.flat()
}

/**
 * Returns whether an audit event fans out to current collaboration watchers.
 *
 * @param eventType - Canonical audit event type.
 * @returns Whether the event's supported watcher scopes must be queried.
 */
export function projectsSubscribedWatchers(eventType: string) {
  return ['comment.created', 'comment.replied', 'comment.edited'].includes(eventType) ||
    planningNotificationKindFromEventType(eventType) !== undefined
}

/**
 * Creates the canonical collaboration scopes queried for one watcher-producing event.
 *
 * @param event - Audit event identity and current Project scope.
 * @returns Comment target/Project scopes or a Team-qualified Planning target scope.
 */
export function createSubscribedWatcherScopes(
  event: Pick<
    AuditProjectionEvent,
    | 'entityId'
    | 'eventType'
    | 'planningTargetId'
    | 'planningTargetType'
    | 'projectId'
    | 'scopeKey'
    | 'teamId'
    | 'workspaceId'
  >,
) {
  const planningNotification = planningNotificationKindFromEventType(event.eventType) !== undefined
  const planningTargetKey = planningNotification
    ? event.planningTargetType === 'project' && event.teamId && event.projectId
      ? createPlanningUpdatePublicTargetKey({
          type: 'project',
          teamId: event.teamId,
          projectId: event.projectId,
        })
      : event.planningTargetType === 'initiative' && event.planningTargetId
        ? createPlanningUpdatePublicTargetKey({
            type: 'initiative',
            entityId: event.planningTargetId,
          })
          : event.teamId && event.projectId
            ? createPlanningUpdatePublicTargetKey({
                type: 'project',
                teamId: event.teamId,
                projectId: event.projectId,
              })
          : event.entityId && (
              event.entityId.startsWith('project/') ||
              event.entityId.startsWith('initiative/')
            )
            ? event.entityId
            : undefined
    : undefined
  return [
    ...(planningNotification
      ? planningTargetKey
        ? [{
            entityKey: createPlanningUpdateCollaborationEntityKey(
              event.workspaceId,
              planningTargetKey,
            ),
            reason: 'watcher',
          }]
        : []
      : event.scopeKey
      ? [{ entityKey: event.scopeKey, reason: 'watcher' }]
      : []),
    ...(event.projectId && !planningNotification
      ? [{
          entityKey: createProjectCollaborationEntityKey(event.workspaceId, event.projectId),
          reason: 'project-watcher',
        }]
      : []),
  ]
}

/** Collaboration watcher rows から有効な notification candidates だけを抽出します。 */
export function toSubscribedWatcherCandidates(
  items: Array<Record<string, unknown>>,
  reason: string,
) {
  return items.flatMap((item) => {
    const memberKey = readString(item.memberKey)
    return item.entryType === 'watcher' && item.state === 'subscribed' && memberKey
      ? [{ memberKey, reason }]
      : []
  })
}

async function isProjectionProcessed(
  eventId: string,
  consumerName = projectionConsumerName,
) {
  const result = await documentClient.send(
    new GetCommand({
      TableName: requireEnv('PROCESSED_AUDIT_EVENTS_TABLE_NAME'),
      Key: {
        consumerName,
        eventId,
      },
      ConsistentRead: true,
    }),
  )

  return result.Item !== undefined
}

async function markProjectionProcessed(
  eventId: string,
  consumerName = projectionConsumerName,
  parentFence?: CuratedContextSearchReceiptFence,
) {
  const item = {
    consumerName,
    eventId,
    processedAt: new Date().toISOString(),
    expiresAt: currentEpochSeconds() + readPositiveIntegerEnv(
      'PROCESSED_AUDIT_EVENT_RETENTION_SECONDS',
      30 * 24 * 60 * 60,
    ),
  }
  const parentCondition = parentFence === undefined
    ? undefined
    : createCuratedContextSearchParentCondition(
        requireEnv('TEAM_ISSUES_TABLE_NAME'),
        parentFence.event,
        parentFence.scope,
      )
  try {
    const receiptPut = {
      Put: {
        TableName: requireEnv('PROCESSED_AUDIT_EVENTS_TABLE_NAME'),
        Item: item,
        ConditionExpression: 'attribute_not_exists(consumerName) AND attribute_not_exists(eventId)',
      },
    }
    if (parentCondition) {
      await documentClient.send(new TransactWriteCommand({
        TransactItems: [parentCondition, receiptPut],
      }))
    } else {
      await documentClient.send(new PutCommand({
        TableName: requireEnv('PROCESSED_AUDIT_EVENTS_TABLE_NAME'),
        Item: item,
        ConditionExpression: receiptPut.Put.ConditionExpression,
      }))
    }
  } catch (error) {
    if (isAwsNamedError(error, 'ConditionalCheckFailedException')) {
      return
    }
    if (isConditionalTransactionCancellation(error)) {
      if (await isProjectionProcessed(eventId, consumerName)) {
        return
      }
      throw new CuratedContextSearchParentScopeChangedError()
    }
    throw error
  }
}

/** Acknowledges Search only while the parent Work Item still has the captured scope. */
async function acknowledgeCuratedContextSearchProjection(
  eventId: string,
  event: AuditProjectionEvent,
  scope: CurrentWorkItemNotificationScope,
  dependencies: CuratedContextSearchProjectionDependencies,
): Promise<void> {
  try {
    await markProjectionProcessed(
      eventId,
      curatedContextSearchProjectionConsumerName,
      { event, scope },
    )
  } catch (error) {
    if (!(error instanceof CuratedContextSearchParentScopeChangedError)) {
      throw error
    }

    const latestScope = await readCurrentWorkItemScope(event)
    if (!sameCuratedContextParentScope(scope, latestScope)) {
      await projectCuratedContextSearchEvent(
        { ...event, projectId: scope.projectId },
        dependencies,
        false,
      )
    }
    throw error
  }
}

/**
 * Builds the parent condition used by a Search receipt transaction.
 *
 * @param tableName - Team Issues table containing the current parent Work Item.
 * @param event - Audit event identifying the parent Work Item.
 * @param scope - Parent scope captured before the receipt write.
 * @returns A DynamoDB condition check, or undefined when the event has no readable parent scope.
 */
export function createCuratedContextSearchParentCondition(
  tableName: string,
  event: AuditProjectionEvent,
  scope: CurrentWorkItemNotificationScope,
) {
  if (!scope.checked || !event.teamId || !event.issueId) {
    return undefined
  }

  const conditionExpression = !scope.exists
    ? 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)'
    : scope.projectId === undefined
      ? 'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND attribute_not_exists(#assignedProjectId)'
      : 'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #assignedProjectId = :assignedProjectId'
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        directoryTeamId: `${event.workspaceId}#team#${event.teamId}`,
        issueId: event.issueId,
      },
      ConditionExpression: conditionExpression,
      ...(scope.exists && scope.projectId !== undefined
        ? {
            ExpressionAttributeNames: { '#assignedProjectId': 'assignedProjectId' },
            ExpressionAttributeValues: { ':assignedProjectId': scope.projectId },
          }
        : scope.exists
          ? { ExpressionAttributeNames: { '#assignedProjectId': 'assignedProjectId' } }
          : {}),
    },
  }
}

async function projectNotification(
  event: AuditProjectionEvent,
  candidate: GroupedNotificationCandidate,
  parentCondition?: ReturnType<typeof createCuratedContextSearchParentCondition>,
) {
  const {
    recipientKey,
    consumerName,
  } = createNotificationProjectionKeys(event, candidate.memberKey)
  const preferences = await readProjectionNotificationPreferences(recipientKey)
  const deliveryState = createNotificationProjectionDeliveryState(
    recipientKey,
    event.occurredAt,
    preferences,
  )
  const notificationItem = createNotificationProjectionItem(
    event,
    candidate,
    deliveryState,
  )

  try {
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          ...(parentCondition ? [parentCondition] : []),
          {
            Put: {
              TableName: requireEnv('NOTIFICATIONS_TABLE_NAME'),
              Item: notificationItem,
              ConditionExpression:
                'attribute_not_exists(recipientKey) AND attribute_not_exists(notificationKey)',
            },
          },
          {
            Put: {
              TableName: requireEnv('PROCESSED_AUDIT_EVENTS_TABLE_NAME'),
              Item: {
                consumerName,
                eventId: event.eventId,
                processedAt: new Date().toISOString(),
                expiresAt: currentEpochSeconds() + readPositiveIntegerEnv(
                  'PROCESSED_AUDIT_EVENT_RETENTION_SECONDS',
                  30 * 24 * 60 * 60,
                ),
              },
              ConditionExpression:
                'attribute_not_exists(consumerName) AND attribute_not_exists(eventId)',
            },
          },
        ],
      }),
    )
  } catch (error) {
    if (parentCondition && isConditionalTransactionCancellationAt(error, 0)) {
      throw error
    }
    if (!isConditionalTransactionCancellation(error)) {
      throw error
    }
  }
}

/** Collaboration audit event を購読 scope の realtime invalidation として配送します。 */
export async function publishRealtimeInvalidation(
  event: AuditProjectionEvent,
  realtime: CollaborationRealtimePublisher,
) {
  if (!event.scopeKey) {
    return
  }

  await realtime.publish(event.scopeKey, {
    type: 'collaboration.invalidated',
    eventId: event.eventId,
    eventType: event.eventType,
    scopeKey: event.scopeKey,
    entityId: event.entityId,
    targetId: event.targetId,
    occurredAt: event.occurredAt,
  })
}

/**
 * notification candidate を canonical member key でまとめ、actor 自身を除外します。
 */
export function groupNotificationCandidates(event: AuditProjectionEvent) {
  const actorKey = normalizeMemberKey(event.actorMemberKey ?? event.actorUserId)
  const grouped = new Map<string, Set<string>>()

  for (const candidate of event.notificationCandidates) {
    const memberKey = normalizeMemberKey(candidate.memberKey)

    if (!memberKey || memberKey === actorKey) {
      continue
    }

    const reasons = grouped.get(memberKey) ?? new Set<string>()
    reasons.add(candidate.reason)
    grouped.set(memberKey, reasons)
  }

  return [...grouped].map(([memberKey, reasons]) => ({
    memberKey,
    reasons: [...reasons].sort(),
  } satisfies GroupedNotificationCandidate))
}

/**
 * 同じ audit event/recipient の retry が同じ notification と receipt を参照する key を作ります。
 */
export function createNotificationProjectionKeys(
  event: Pick<AuditProjectionEvent, 'workspaceId' | 'occurredAt' | 'eventId'>,
  memberKey: string,
): NotificationProjectionKeys {
  const normalizedMemberKey = normalizeMemberKey(memberKey)

  if (!normalizedMemberKey) {
    throw new TypeError('Notification member key is required.')
  }

  return {
    recipientKey: `${event.workspaceId}#${normalizedMemberKey}`,
    notificationKey: `${event.occurredAt}#${event.eventId}`,
    consumerName: `collaboration-notification#${normalizedMemberKey}`,
  }
}

/** In-app channel、digest frequency、quiet hours を notification row へ反映します。 */
export function createNotificationProjectionDeliveryState(
  recipientKey: string,
  occurredAt: string,
  preferences: NotificationPreferences,
): NotificationProjectionDeliveryState {
  const deliveryPlan = createNotificationDeliveryPlan(preferences, occurredAt)
  const inboxState = preferences.channels.inApp ? 'unread' : 'archived'

  return {
    inAppVisible: preferences.channels.inApp,
    inboxState,
    recipientStatusKey: `${recipientKey}#${inboxState}`,
    ...(inboxState === 'archived' ? { archivedAt: occurredAt } : {}),
    deliveryChannels: deliveryPlan.channels,
    deliveryAfter: deliveryPlan.deliveryAfter,
    deliveryFrequency: deliveryPlan.frequency,
  }
}

/** Audit event と recipient 候補から durable notification row を作成します。 */
export function createNotificationProjectionItem(
  event: AuditProjectionEvent,
  candidate: GroupedNotificationCandidate,
  deliveryState: NotificationProjectionDeliveryState,
  expiresAt = currentEpochSeconds() + readPositiveIntegerEnv(
    'NOTIFICATION_RETENTION_SECONDS',
    365 * 24 * 60 * 60,
  ),
) {
  const { recipientKey, notificationKey } = createNotificationProjectionKeys(
    event,
    candidate.memberKey,
  )

  return {
    recipientKey,
    notificationKey,
    recipientStatusKey: deliveryState.recipientStatusKey,
    itemType: 'notification',
    inboxState: deliveryState.inboxState,
    inAppVisible: deliveryState.inAppVisible,
    version: 1,
    notificationId: event.eventId,
    workspaceId: event.workspaceId,
    recipientMemberKey: candidate.memberKey,
    eventId: event.eventId,
    eventType: event.eventType,
    actorUserId: event.actorUserId,
    actorMemberKey: event.actorMemberKey,
    actorLabel: event.actorLabel,
    entityId: event.entityId,
    entityKey: event.scopeKey,
    targetId: event.targetId,
    issueId: event.issueId,
    triageEntryId: event.triageEntryId,
    commentId: event.commentId,
    rootCommentId: event.rootCommentId,
    projectId: event.projectId,
    teamId: event.teamId,
    planningTargetType: event.planningTargetType,
    planningTargetId: event.planningTargetId,
    planningTargetRecordKey: event.planningTargetRecordKey,
    planningNextDueAt: event.planningNextDueAt,
    planningNotificationKind: event.planningNotificationKind,
    deepLink: event.deepLink,
    title: event.notificationTitle,
    summary: event.summary,
    reasons: candidate.reasons,
    deliveryChannels: deliveryState.deliveryChannels,
    deliveryAfter: deliveryState.deliveryAfter,
    deliveryFrequency: deliveryState.deliveryFrequency,
    ...(deliveryState.archivedAt ? { archivedAt: deliveryState.archivedAt } : {}),
    occurredAt: event.occurredAt,
    createdAt: event.occurredAt,
    expiresAt,
  }
}

/** Scheduled notification を projection 時点の担当者と期限へ再検証します。 */
export function refreshScheduledNotificationEvent(
  event: AuditProjectionEvent,
  scope: CurrentWorkItemNotificationScope,
): AuditProjectionEvent | undefined {
  if (event.eventType !== 'work-item.due' && event.eventType !== 'work-item.overdue') {
    return event
  }

  const reason = event.eventType === 'work-item.due' ? 'due' : 'overdue'
  const scheduledMemberKey = normalizeMemberKey(
    event.notificationCandidates.find((candidate) => candidate.reason === reason)?.memberKey,
  )
  if (
    !scope.checked ||
    !scope.exists ||
    !scope.assigneeMemberKey ||
    scope.statusCategory === 'completed' ||
    scope.statusCategory === 'canceled' ||
    !event.dueDate ||
    scope.dueDate !== event.dueDate ||
    scheduledMemberKey !== scope.assigneeMemberKey
  ) {
    return undefined
  }

  return {
    ...event,
    notificationCandidates: [{
      memberKey: scope.assigneeMemberKey,
      reason,
    }],
  }
}

/**
 * Revalidates a scheduled Planning notification against its current owner, occurrence, and archive state.
 *
 * @param event - Parsed audit projection event.
 * @param scope - Strongly read current Planning update target scope.
 * @returns A current recipient event, or undefined when the scheduled event is stale.
 */
export function refreshPlanningScheduledNotificationEvent(
  event: AuditProjectionEvent,
  scope: CurrentPlanningUpdateNotificationScope,
): AuditProjectionEvent | undefined {
  const kind = planningNotificationKindFromEventType(event.eventType)
  if (!kind) {
    return event
  }
  const currentRecipient = kind === 'escalation'
    ? scope.escalationMemberKey
    : scope.ownerMemberKey
  const scheduledRecipient = normalizeMemberKey(
    event.notificationCandidates.find((candidate) => candidate.reason === kind)?.memberKey,
  )
  if (
    !scope.checked ||
    !scope.exists ||
    scope.archived ||
    !currentRecipient ||
    !event.planningTargetType ||
    event.planningTargetType !== scope.targetType ||
    !event.planningTargetId ||
    event.planningTargetId !== scope.targetId ||
    !event.planningTargetRecordKey ||
    event.planningTargetRecordKey !== scope.targetRecordKey ||
    !event.planningNextDueAt ||
    event.planningNextDueAt !== scope.nextDueAt ||
    event.planningNotificationKind !== kind ||
    scheduledRecipient !== currentRecipient
  ) {
    return undefined
  }

  return {
    ...event,
    teamId: scope.teamId,
    projectId: scope.projectId,
    notificationCandidates: [{ memberKey: currentRecipient, reason: kind }],
  }
}

/**
 * Overlays the current Work Item project onto a curated-context audit event.
 *
 * @param event - Audit event whose captured project may be stale.
 * @param scope - Current parent Work Item scope read by the projection.
 * @returns Event carrying the current project assignment, when one exists.
 */
export function overlayCurrentWorkItemNotificationScope(
  event: AuditProjectionEvent,
  scope: CurrentWorkItemNotificationScope,
): AuditProjectionEvent {
  if (scope.projectId !== undefined) {
    return { ...event, projectId: scope.projectId }
  }
  const { projectId: _staleProjectId, ...eventWithoutProject } = event
  return eventWithoutProject
}

async function readProjectionNotificationPreferences(recipientKey: string) {
  const result = await documentClient.send(new GetCommand({
    TableName: requireEnv('NOTIFICATIONS_TABLE_NAME'),
    Key: {
      recipientKey,
      notificationKey: NOTIFICATION_PREFERENCES_KEY,
    },
    ConsistentRead: true,
  }))

  return parseStoredNotificationPreferences(result.Item)
}

/**
 * DynamoDB Streams partial batch response に必要な sequence number を failure へ変換します。
 */
export function createDynamoBatchItemFailure(record: DynamoStreamRecord): BatchItemFailure {
  const sequenceNumber = record.dynamodb?.SequenceNumber?.trim()

  if (!sequenceNumber) {
    throw new TypeError('DynamoDB Streams sequence number is required for partial batch failure.')
  }

  return { itemIdentifier: sequenceNumber }
}

/** Workspace member roles accepted by the Enterprise authorization evaluator. */
type WorkspaceNotificationRole = 'owner' | 'admin' | 'member' | 'guest'

/**
 * Evaluates the authoritative Enterprise access required by one cadence notification.
 *
 * Legacy project-member access remains the first authorization path. This evaluator is used
 * only when the current Enterprise snapshot makes legacy access non-authoritative, matching the
 * cadence configuration path's fallback boundary.
 *
 * @param event - Scheduled Planning notification scope and notification kind.
 * @param memberKey - Active Workspace member key being considered.
 * @param workspaceRole - Current Workspace role from the active member row.
 * @param snapshot - Authoritative Enterprise Identity snapshot.
 * @returns Whether the member can perform the action represented by the notification.
 */
export function hasEligibleEnterpriseNotificationAccess(
  event: Pick<AuditProjectionEvent, 'workspaceId' | 'projectId' | 'teamId' | 'planningNotificationKind'>,
  memberKey: string,
  workspaceRole: WorkspaceNotificationRole,
  snapshot: EnterpriseIdentitySnapshot,
): boolean {
  if (snapshot.workspaceId !== event.workspaceId || event.planningNotificationKind === undefined) {
    return false
  }
  const normalizedMemberKey = normalizeMemberKey(memberKey)
  if (!normalizedMemberKey) return false

  const directoryPrincipal = resolveEnterpriseDirectoryPrincipal(snapshot, memberKey, [])
  const suppressLegacyWorkspaceRole = directoryPrincipal.directoryManaged ||
    directoryPrincipal.compatibleRoleAssignments.some((assignment) =>
      assignment.principalKind === 'member' &&
        normalizeMemberKey(assignment.principalId) === normalizedMemberKey ||
      assignment.principalKind === 'directory-group' && (
        assignment.source === 'directory-mapping' ||
        directoryPrincipal.directoryGroupIds.includes(assignment.principalId)
      )
    ) || directoryPrincipal.compatibleGroupMappings.some((mapping) => mapping.enabled)
  if (!suppressLegacyWorkspaceRole) return false

  const resource = event.projectId !== undefined
    ? event.teamId === undefined
      ? undefined
      : {
          workspaceId: event.workspaceId,
          kind: 'project' as const,
          targetId: event.projectId,
          parentTeamId: event.teamId,
        }
    : event.teamId === undefined
      ? undefined
      : {
          workspaceId: event.workspaceId,
          kind: 'team' as const,
          targetId: event.teamId,
        }
  if (!resource) return false

  const permission = event.planningNotificationKind === 'reminder' ||
    event.planningNotificationKind === 'overdue'
    ? 'work-items.write'
    : 'work-items.read'
  const access = evaluateEnterpriseAccess({
    permission,
    principal: {
      kind: 'member',
      principalId: normalizedMemberKey,
      directoryGroupIds: directoryPrincipal.directoryGroupIds,
      directoryGroupMemberships: directoryPrincipal.directoryGroupMemberships,
      workspaceRole,
      includeWorkspaceRolePermissions: false,
      directPermissions: ['workspace.read'],
      systemAdministrator: false,
    },
    assignments: directoryPrincipal.compatibleRoleAssignments,
    customRoles: snapshot.customRoles,
    groupMappings: directoryPrincipal.compatibleGroupMappings,
    resource,
  })
  return access.allowed
}

/**
 * 現在の active team/project/member snapshot から notification recipient の閲覧権限を判定します。
 */
export function hasEligibleProjectAccess(
  event: Pick<AuditProjectionEvent, 'projectId' | 'teamId'>,
  memberKey: string,
  directoryItems: ProjectDirectoryItem[],
) {
  if (!event.projectId && !event.teamId) {
    return true
  }

  const activeTeamIds = new Set(
    directoryItems
      .filter((item) => item.entryType === 'team' && item.teamId && !item.archivedAt)
      .map((item) => item.teamId as string),
  )
  const activeProjects = directoryItems.filter((item) =>
    item.entryType === 'project' &&
    item.projectId &&
    item.teamId &&
    activeTeamIds.has(item.teamId) &&
    !item.archivedAt
  )
  const accessibleProjectScopeKeys = new Set<string>()
  for (const item of directoryItems) {
    if (
      item.entryType !== 'project-member' ||
      normalizeMemberKey(item.memberKey) !== memberKey ||
      (item.role !== 'viewer' && item.role !== 'member' && item.role !== 'manager') ||
      !item.projectId
    ) {
      continue
    }
    const ownerTeams = activeProjects.filter((project) =>
      project.projectId === item.projectId &&
      (item.teamId === undefined || project.teamId === item.teamId)
    )
    if (ownerTeams.length !== 1 || !ownerTeams[0]?.teamId) continue
    accessibleProjectScopeKeys.add(`${ownerTeams[0].teamId}\0${item.projectId}`)
  }

  if (event.projectId) {
    const matchingProjects = activeProjects.filter((item) =>
      item.projectId === event.projectId &&
      (event.teamId === undefined || item.teamId === event.teamId)
    )
    if (matchingProjects.length !== 1 || !matchingProjects[0]?.teamId) return false
    return accessibleProjectScopeKeys.has(
      `${matchingProjects[0].teamId}\0${event.projectId}`,
    )
  }

  return activeProjects.some((item) =>
    item.teamId === event.teamId &&
    item.projectId !== undefined &&
    accessibleProjectScopeKeys.has(`${item.teamId}\0${item.projectId}`)
  )
}

/** Notification target の team/project が現在も active かを判定します。 */
export function hasActiveNotificationScope(
  event: Pick<AuditProjectionEvent, 'projectId' | 'teamId'>,
  directoryItems: ProjectDirectoryItem[],
) {
  if (!event.projectId && !event.teamId) {
    return true
  }

  const activeTeamIds = new Set(
    directoryItems
      .filter((item) => item.entryType === 'team' && item.teamId && !item.archivedAt)
      .map((item) => item.teamId as string),
  )

  if (event.projectId) {
    return directoryItems.some((item) =>
      item.entryType === 'project' &&
      item.projectId === event.projectId &&
      typeof item.teamId === 'string' &&
      activeTeamIds.has(item.teamId) &&
      !item.archivedAt &&
      (!event.teamId || item.teamId === event.teamId)
    )
  }

  return event.teamId !== undefined && activeTeamIds.has(event.teamId)
}

/** Cognito の全 group pages から現在の system-admin membership を判定します。 */
export async function hasCurrentSystemAdminMembership(
  systemAdminGroups: string[],
  readPage: CognitoGroupPageReader,
) {
  const configuredGroups = new Set(
    systemAdminGroups.map((group) => group.trim()).filter(Boolean),
  )

  if (configuredGroups.size === 0) {
    return false
  }

  let nextToken: string | undefined

  do {
    const page = await readPage(nextToken)

    if (page.groupNames.some((groupName) => configuredGroups.has(groupName))) {
      return true
    }

    nextToken = page.nextToken?.trim() || undefined
  } while (nextToken)

  return false
}

async function isEligibleRecipient(
  event: AuditProjectionEvent,
  memberKey: string,
  directoryItems: ProjectDirectoryItem[],
  currentSystemAdminCache: Map<string, Promise<boolean>>,
  enterpriseIdentity: Pick<EnterpriseIdentityReadCapability, 'getSnapshot'> | undefined,
  enterpriseSnapshotCache: Map<string, Promise<EnterpriseIdentitySnapshot>>,
) {
  const memberResult = await documentClient.send(
    new GetCommand({
      TableName: requireEnv('WORKSPACE_ACCESS_TABLE_NAME'),
      Key: {
        workspaceId: event.workspaceId,
        recordKey: `MEMBER#${memberKey}`,
      },
      ConsistentRead: true,
    }),
  )
  const member = memberResult.Item

  if (!isActiveWorkspaceNotificationMember(memberKey, member)) {
    return false
  }

  if (!hasActiveNotificationScope(event, directoryItems)) {
    return false
  }

  if (hasEligibleProjectAccess(event, memberKey, directoryItems)) {
    return true
  }

  if (
    enterpriseIdentity &&
    event.planningNotificationKind !== undefined &&
    (event.projectId !== undefined || event.teamId !== undefined)
  ) {
    const role = readWorkspaceNotificationRole(member.role)
    if (role) {
      let snapshotPromise = enterpriseSnapshotCache.get(event.workspaceId)
      if (!snapshotPromise) {
        snapshotPromise = enterpriseIdentity.getSnapshot(event.workspaceId)
        enterpriseSnapshotCache.set(event.workspaceId, snapshotPromise)
      }
      if (hasEligibleEnterpriseNotificationAccess(
        event,
        memberKey,
        role,
        await snapshotPromise,
      )) {
        return true
      }
    }
  }

  const username = readString(member.username) ?? readString(member.email) ?? memberKey
  let currentSystemAdmin = currentSystemAdminCache.get(username)

  if (!currentSystemAdmin) {
    currentSystemAdmin = isCurrentSystemAdmin(username)
    currentSystemAdminCache.set(username, currentSystemAdmin)
  }

  return currentSystemAdmin
}

/** Reads a supported Workspace role from a notification member row. */
function readWorkspaceNotificationRole(
  value: unknown,
): WorkspaceNotificationRole | undefined {
  return value === 'owner' || value === 'admin' || value === 'member' || value === 'guest'
    ? value
    : undefined
}

/** Workspace member row が現在も notification recipient として有効かを判定します。 */
export function isActiveWorkspaceNotificationMember(
  memberKey: string,
  member: Record<string, unknown> | undefined,
): member is Record<string, unknown> {
  return member !== undefined &&
    member.entryType === 'workspace-member' &&
    member.status === 'active' &&
    normalizeMemberKey(String(member.memberKey ?? member.email ?? '')) === memberKey
}

async function isCurrentSystemAdmin(username: string) {
  try {
    return await hasCurrentSystemAdminMembership(readSystemAdminGroups(), async (nextToken) => {
      const result = await cognitoClient.send(new AdminListGroupsForUserCommand({
        UserPoolId: requireEnv('COGNITO_USER_POOL_ID'),
        Username: username,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }))

      return {
        groupNames: (result.Groups ?? [])
          .map((group) => group.GroupName)
          .filter((groupName): groupName is string => typeof groupName === 'string'),
        ...(result.NextToken ? { nextToken: result.NextToken } : {}),
      }
    })
  } catch (error) {
    if (isAwsNamedError(error, 'UserNotFoundException')) {
      return false
    }

    throw error
  }
}

function readSystemAdminGroups() {
  return requireEnv('SYSTEM_ADMIN_GROUPS').split(',')
}

async function readProjectDirectory(directoryId: string) {
  const items: ProjectDirectoryItem[] = []
  let exclusiveStartKey: Record<string, unknown> | undefined

  do {
    const result = await documentClient.send(
      new QueryCommand({
        TableName: requireEnv('PROJECT_DIRECTORY_TABLE_NAME'),
        KeyConditionExpression: 'directoryId = :directoryId',
        ExpressionAttributeValues: { ':directoryId': directoryId },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )

    for (const value of result.Items ?? []) {
      items.push({
        ...(typeof value.entryKey === 'string' ? { entryKey: value.entryKey } : {}),
        ...(typeof value.entryType === 'string' ? { entryType: value.entryType } : {}),
        ...(typeof value.teamId === 'string' ? { teamId: value.teamId } : {}),
        ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
        ...(typeof value.memberKey === 'string' ? { memberKey: value.memberKey } : {}),
        ...(typeof value.role === 'string' ? { role: value.role } : {}),
        ...(typeof value.archivedAt === 'string' ? { archivedAt: value.archivedAt } : {}),
      })
    }

    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey)

  return items
}

async function readCurrentWorkItemScope(
  event: AuditProjectionEvent,
): Promise<CurrentWorkItemNotificationScope> {
  if (!event.teamId || !event.issueId) {
    return { checked: false, exists: true, projectId: event.projectId }
  }

  const directoryTeamId = `${event.workspaceId}#team#${event.teamId}`
  const result = await documentClient.send(new GetCommand({
    TableName: requireEnv('TEAM_ISSUES_TABLE_NAME'),
    Key: { directoryTeamId, issueId: event.issueId },
    ConsistentRead: true,
  }))
  const item = result.Item

  if (item === undefined) {
    return { checked: true, exists: false, projectId: undefined }
  }

  if (
    !isCanonicalWorkItemRecord(item) ||
    item.directoryTeamId !== directoryTeamId ||
    item.issueId !== event.issueId
  ) {
    throw new Error('Current Work Item row is invalid for collaboration projection.')
  }

  return {
    checked: true,
    exists: true,
    projectId: item.assignedProjectId,
    assigneeMemberKey: normalizeMemberKey(item.assigneeUserId),
    dueDate: normalizeStoredDateOnly(item.dueDate),
    statusCategory: item.statusCategory,
  }
}

/**
 * Strongly reads the canonical Planning update target and Initiative scope for scheduled events.
 *
 * @param event - Parsed audit event that may represent a Planning scheduled notification.
 * @returns Current Planning target scope, or an unchecked pass-through for other events.
 */
async function readCurrentPlanningUpdateScope(
  event: AuditProjectionEvent,
): Promise<CurrentPlanningUpdateNotificationScope> {
  const kind = planningNotificationKindFromEventType(event.eventType)
  if (!kind) {
    return { checked: false, exists: true, archived: false }
  }
  if (!event.planningTargetRecordKey) {
    return { checked: true, exists: false, archived: true }
  }

  const result = await documentClient.send(new GetCommand({
    TableName: requireEnv('PLANNING_TABLE_NAME'),
    Key: {
      workspaceId: event.workspaceId,
      recordKey: event.planningTargetRecordKey,
    },
    ConsistentRead: true,
  }))
  if (!result.Item) {
    return { checked: true, exists: false, archived: true }
  }
  const record = parsePlanningUpdateTargetScheduleProjection(result.Item)
  if (
    !record ||
    record.workspaceId !== event.workspaceId
  ) {
    throw new Error('Planning notification target row is invalid.')
  }
  const targetType = record.target.type
  const targetId = targetType === 'project'
    ? record.target.projectId
    : record.target.entityId
  const base = {
    checked: true,
    exists: true,
    archived: record.archivedAt !== undefined,
    targetType,
    targetId,
    targetRecordKey: event.planningTargetRecordKey,
    ...(record.cadence
      ? {
        ownerMemberKey: normalizeMemberKey(record.cadence.updateOwnerMemberKey),
        ...(record.cadence.escalationMemberKey
          ? { escalationMemberKey: normalizeMemberKey(record.cadence.escalationMemberKey) }
          : {}),
        nextDueAt: readTimestamp(record.cadence.nextDueAt),
      }
      : {}),
  }
  if (record.target.type === 'project') {
    return {
      ...base,
      teamId: record.target.teamId,
      projectId: record.target.projectId,
    }
  }

  const initiativeRecordKey = `ENTITY#${encodeURIComponent(record.target.entityId)}`
  const initiativeResult = await documentClient.send(new GetCommand({
    TableName: requireEnv('PLANNING_TABLE_NAME'),
    Key: { workspaceId: event.workspaceId, recordKey: initiativeRecordKey },
    ConsistentRead: true,
  }))
  const initiative = initiativeResult.Item
  if (!initiative) {
    return { ...base, exists: false, archived: true }
  }
  if (
    initiative.workspaceId !== event.workspaceId ||
    initiative.recordKey !== initiativeRecordKey ||
    initiative.entryType !== 'planning-entity' ||
    initiative.type !== 'initiative' ||
    initiative.id !== record.target.entityId
  ) {
    throw new Error('Planning notification Initiative source row is invalid.')
  }
  const teamId = readString(initiative.teamId)
  const projectId = readString(initiative.projectId)
  if (projectId && !teamId) {
    throw new Error('Planning notification Initiative Project scope requires a Team scope.')
  }
  return {
    ...base,
    archived: base.archived || initiative.archivedAt !== undefined,
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
  }
}

/**
 * schema v1 と legacy-compatible audit record を projection 用 event へ正規化します。
 */
export function parseAuditProjectionEvent(
  value: Record<string, unknown>,
): AuditProjectionEvent | undefined {
  const eventId = readString(value.eventId)
  const eventType = readString(value.eventType)
  const workspaceId = readString(value.workspaceId) ?? readString(value.directoryId)
  const occurredAt = readString(value.occurredAt)

  if (!eventId || !eventType || !workspaceId || !occurredAt) {
    return undefined
  }

  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const actor = isRecord(value.actor) ? value.actor : {}
  const entity = isRecord(value.entity) ? value.entity : {}
  const target = isRecord(value.target) ? value.target : {}
  const entityId = readString(value.entityId) ?? readString(entity.id)
  const entityType = readString(value.entityType) ?? readString(entity.type)
  const scopeKey = readString(value.entityKey) ?? (
    entityId && entityType ? `${workspaceId}#${entityType}#${entityId}` : undefined
  )

  return {
    eventId,
    eventType,
    workspaceId,
    occurredAt,
    actorUserId: readString(value.actorUserId) ?? readString(actor.id),
    actorMemberKey: readString(metadata.actorMemberKey),
    actorLabel: readString(actor.displayName) ?? readString(metadata.actorMemberKey),
    scopeKey,
    entityId,
    targetId: readString(value.targetId) ?? readString(target.id),
    notificationCandidates: readNotificationCandidates(metadata.notificationCandidates),
    deepLink: readString(metadata.deepLink),
    teamId: readString(metadata.teamId),
    issueId: readString(metadata.issueId),
    triageEntryId: readString(metadata.triageEntryId),
    projectId: readString(metadata.projectId),
    commentId: readString(metadata.commentId),
    contextItemId: readString(metadata.contextItemId),
    sourceRevision: readPositiveInteger(metadata.sourceRevision),
    fileId: readString(metadata.fileId),
    rootCommentId: readString(metadata.rootCommentId),
    notificationTitle: readString(metadata.notificationTitle) ?? readString(metadata.title),
    summary: readString(value.summary),
    dueDate: normalizeStoredDateOnly(readString(metadata.dueDate)),
    planningTargetType: readPlanningTargetType(metadata.planningTargetType),
    planningTargetId: readString(metadata.planningTargetId),
    planningTargetRecordKey: readString(metadata.planningTargetRecordKey),
    planningNextDueAt: readTimestamp(metadata.planningNextDueAt),
    planningNotificationKind: readPlanningNotificationKind(
      metadata.planningNotificationKind,
    ),
    outboxStatus: value.outboxStatus === 'suppressed' ? 'suppressed' : 'pending',
  }
}

/** Returns the canonical Planning notification kind represented by an event type. */
function planningNotificationKindFromEventType(
  eventType: string,
): PlanningScheduledNotificationKind | undefined {
  if (eventType === 'planning-update.reminder') return 'reminder'
  if (eventType === 'planning-update.overdue') return 'overdue'
  if (eventType === 'planning-update.escalation') return 'escalation'
  return undefined
}

/** Reads a validated Planning target type from audit metadata. */
function readPlanningTargetType(value: unknown): 'project' | 'initiative' | undefined {
  return value === 'project' || value === 'initiative' ? value : undefined
}

/** Reads a validated Planning notification kind from audit metadata. */
function readPlanningNotificationKind(
  value: unknown,
): PlanningScheduledNotificationKind | undefined {
  return value === 'reminder' || value === 'overdue' || value === 'escalation'
    ? value
    : undefined
}

function readNotificationCandidates(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) {
      return []
    }

    const memberKey = readString(candidate.memberKey)
    const reason = readString(candidate.reason)
    return memberKey && reason ? [{ memberKey, reason } satisfies NotificationCandidate] : []
  })
}

function unmarshalMap(value: Record<string, DynamoAttributeValue>) {
  return Object.fromEntries(
    Object.entries(value).map(([key, attribute]) => [key, unmarshalAttribute(attribute)]),
  )
}

function unmarshalAttribute(value: DynamoAttributeValue): unknown {
  if (value.S !== undefined) {
    return value.S
  }

  if (value.N !== undefined) {
    return Number(value.N)
  }

  if (value.BOOL !== undefined) {
    return value.BOOL
  }

  if (value.NULL) {
    return null
  }

  if (value.L) {
    return value.L.map(unmarshalAttribute)
  }

  if (value.M) {
    return unmarshalMap(value.M)
  }

  if (value.SS) {
    return value.SS
  }

  if (value.NS) {
    return value.NS.map(Number)
  }

  return undefined
}

function normalizeMemberKey(value: string | undefined) {
  return value?.trim().toLowerCase()
}

function normalizeStoredDateOnly(value: string | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : undefined
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Reads and canonicalizes a valid timestamp from untrusted event metadata. */
function readTimestamp(value: unknown): string | undefined {
  const text = readString(value)
  if (!text) return undefined
  const timestamp = Date.parse(text)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

function readPositiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function isAwsNamedError(error: unknown, name: string) {
  return error instanceof Error && error.name === name
}

function isConditionalTransactionCancellation(error: unknown) {
  if (!isAwsNamedError(error, 'TransactionCanceledException') || !isRecord(error)) {
    return false
  }

  const reasons = error.CancellationReasons
  return Array.isArray(reasons) && reasons.some((reason) =>
    isRecord(reason) && reason.Code === 'ConditionalCheckFailed'
  )
}

/**
 * Checks whether one transaction item failed its conditional expression.
 *
 * @param error - DynamoDB transaction error.
 * @param index - Zero-based transaction item index to inspect.
 * @returns Whether the selected transaction item failed conditionally.
 */
function isConditionalTransactionCancellationAt(error: unknown, index: number) {
  if (!isAwsNamedError(error, 'TransactionCanceledException') || !isRecord(error)) {
    return false
  }

  const reasons = error.CancellationReasons
  const reason = Array.isArray(reasons) ? reasons[index] : undefined
  return isRecord(reason) && reason.Code === 'ConditionalCheckFailed'
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1_000)
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function getAwsRegion() {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1'
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`${name} is required.`)
  }

  return value
}
