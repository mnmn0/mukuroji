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
import type { EnterpriseIdentitySnapshot, EnterprisePermissionId, TriageEntry } from '@mukuroji/contracts'
import type { DocumentProjectRole, GetDocumentRequest } from '../../../documents'
import { TriageError } from '../../../triage'
import { isCanonicalWorkItemRecord, workItemScheduleInstantToLocalDate } from '../../../work-items'
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
  TIMESHEET_REMINDER_EVENT_TYPE,
  slackDeliveryShard,
  emailDeliveryShard,
  isEmailNotificationEligible,
  isDocumentDeliveryVisible,
  resolveDocumentDeliveryAccess,
  resolveNotificationRecipientBoundary,
  requiresCurrentWorkItemAssignee,
  isSlackNotificationEligible,
  type PlanningScheduledNotificationKind,
  type NotificationPreferences,
} from '../../../notifications'
import { isMissingFileObjectVersionError, type ApprovalNotificationReader } from '../../../files'
import type {
  BatchItemFailure,
  BatchResponse,
  DynamoAttributeValue,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from '../../../../infrastructure/aws/dynamodb-stream'
import { loadServerConfig } from '../../../../infrastructure/config/server-config'

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
  /** Work Item `updatedAt` that a scheduled stale reminder was computed from. */
  workItemUpdatedAt?: string
  /** Whole days until the due date when the schedule emitted the stage (negative once overdue). */
  daysUntilDue?: number
  /** Work Item `reopenedAt` an escalation was scanned under; absent before any reopening. */
  workItemReopenedAt?: string
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
  /** Unsubmitted time entries a timesheet reminder was scanned for. */
  timeEntryIds?: string[]
  /** Instant at or before which a timesheet reminder's entries had to end to be due. */
  timesheetDueBefore?: string
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
  /** Revalidates timesheet reminders; without it every timesheet reminder is dropped. */
  timesheetReminders?: TimesheetReminderRevalidator
}

/** A `ConditionCheck` transaction item written together with a projected notification. */
export type ProjectionConditionCheck = {
  /** Condition that must still hold when the notification is saved. */
  ConditionCheck: {
    /** Table of the checked row. */
    TableName: string
    /** Key of the checked row. */
    Key: Record<string, unknown>
    /** Condition on the checked row. */
    ConditionExpression: string
    /** Attribute name placeholders. */
    ExpressionAttributeNames?: Record<string, string>
    /** Attribute value placeholders. */
    ExpressionAttributeValues?: Record<string, unknown>
  }
}

/** Checks that a timesheet reminder still names an unsubmitted entry of its recipient. */
export type TimesheetReminderRevalidator = {
  /**
   * Finds a named entry that is still draft or rejected and owned by the member.
   *
   * @param input - Workspace, Team, recipient, and the entries the schedule found.
   * @returns A condition that holds while that entry is unchanged, or undefined when none qualifies.
   */
  findUnsubmittedEntry(input: {
    /** Canonical Workspace ID. */
    workspaceId: string
    /** Team ID. */
    teamId: string
    /** Lower-case member key of the recipient. */
    memberKey: string
    /** Entry IDs the schedule found unsubmitted. */
    entryIds: readonly string[]
    /** An entry must have ended at or before this instant to still be due. */
    dueBefore: string
    /** Project the reminder is authorized against; the entry must still belong to it. */
    projectId: string
  }): Promise<ProjectionConditionCheck | undefined>
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
  deliveryChannels: Array<'inApp' | 'email' | 'push' | 'slack'>
  /** Digest/quiet hours を反映した最短 delivery 時刻です。 */
  deliveryAfter: string
  /** Delivery plan の frequency です。 */
  deliveryFrequency: NotificationPreferences['frequency']
  /** Whether the Email transport queue receives this notification; set only when it does. */
  emailQueued?: true
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
  /** Current Work Item `updatedAt` timestamp. */
  updatedAt?: string
  /** Today in the Work Item schedule's local calendar at read time, as `YYYY-MM-DD`. */
  localDate?: string
  /** Whether the Work Item is currently archived. */
  archived?: boolean
  /** Current Work Item revision, used to pin scheduled notification writes to this read. */
  revision?: number
  /** When the Work Item last reopened, if it ever did. */
  reopenedAt?: string
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
/**
 * Receipt namespace for the context Search projection. The receipt is fenced to the parent
 * Work Item scope and written before the event's projection receipt, so a retry after a later
 * notification or realtime failure does not repeat a completed Search write.
 */
const curatedContextSearchProjectionConsumerName = 'collaboration-context-search-v2'
const watcherNotificationEventTypes = new Set([
  'comment.created',
  'comment.replied',
  'comment.edited',
  'planning-update.reminder',
  'planning-update.overdue',
  'planning-update.escalation',
  'planning-update.published',
  'planning-update.health-degraded',
  'context-item.created',
  'context-item.updated',
  'accepted-resolution.selected',
  'accepted-resolution.replaced',
  'accepted-resolution.edited',
])
/**
 * Work Item change events whose current item watchers are notified when the change carries
 * notification candidates (assignment, status, schedule, or archive change).
 */
const workItemChangeWatcherEventTypes = new Set([
  'work-item.updated',
  'work-item.schedule-cascade-updated',
])
/**
 * Planning update events that fan out to the target's watchers and, for a Project target, to
 * the current Project members.
 */
const planningUpdatePublishEventTypes = new Set([
  'planning-update.published',
  'planning-update.health-degraded',
])
/**
 * Planning update publish and comment events. Their recipients must be able to read both the
 * scope captured by the update and the target's current scope.
 */
const planningUpdateActivityEventTypes = new Set([
  ...planningUpdatePublishEventTypes,
  'planning-update.commented',
])
/**
 * Scheduled Analytics report delivery to one recipient. Kept as a literal so this Lambda does not
 * bundle the Analytics module; it must match the event type the Analytics notifier writes.
 */
const analyticsReportDeliveredEventType = 'analytics.report.delivered'
/** Scheduled Work Item events that are revalidated against the current Work Item row. */
const scheduledWorkItemNotificationReasons = new Map([
  ['work-item.due', 'due'],
  ['work-item.due-soon', 'due-soon'],
  ['work-item.overdue', 'overdue'],
  ['work-item.overdue-reminder', 'overdue'],
  ['work-item.overdue-escalation', 'escalation'],
  ['work-item.stale', 'stale'],
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
 * Reports whether a Work Item change event should notify the item's current watchers.
 *
 * Title or description edits carry no notification candidates and stay silent; assignment,
 * status, schedule, and archive changes reach watchers as well as the owner and creator.
 *
 * @param event - Parsed audit event type and stored notification candidates.
 * @returns Whether item watchers must be resolved for the event.
 */
export function notifiesWorkItemChangeWatchers(
  event: Pick<AuditProjectionEvent, 'eventType' | 'notificationCandidates'>,
) {
  return workItemChangeWatcherEventTypes.has(event.eventType) &&
    event.notificationCandidates.length > 0
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

/**
 * Projects one audit stream record into file cleanup, Search, notifications, and realtime.
 *
 * The projection receipt marks the whole event as processed. A curated-context event first
 * projects Search under its own parent-fenced receipt, so a retry skips a Search write that
 * already succeeded and continues with the notification projection.
 *
 * @param record - DynamoDB stream record from the audit table.
 * @param currentSystemAdminCache - Batch-scoped cache of current system-admin checks.
 * @param enterpriseSnapshotCache - Batch-scoped cache of Enterprise Identity snapshots.
 * @param dependencies - External ports used by the projection.
 * @returns A promise that resolves after the record is projected or skipped.
 */
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

  if (await isProjectionProcessed(event.eventId)) {
    return
  }

  let currentScope: CurrentWorkItemNotificationScope
  if (
    curatedContextSearchProjectionEventTypes.has(event.eventType) &&
    !await isProjectionProcessed(event.eventId, curatedContextSearchProjectionConsumerName)
  ) {
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
  } else {
    currentScope = await readCurrentWorkItemScope(event)
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
    event.projectId,
  )
  const timesheetReminder = await readTimesheetReminderFence(event, dependencies.timesheetReminders)
  if (!workItemAuthorizationEvent || !timesheetReminder.current) {
    await markProjectionProcessed(event.eventId)
    return
  }

  const planningScope = await readCurrentPlanningUpdateScope(workItemAuthorizationEvent)
  if (!planningScope.exists) {
    await markProjectionProcessed(event.eventId)
    return
  }
  const planningActivity = planningUpdateActivityEventTypes.has(event.eventType)
  const planningScopedEvent = planningScope.checked && !planningActivity
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
  const currentPlanningActivityEvent = planningActivity
    ? createCurrentPlanningUpdateActivityScopeEvent(authorizationEvent, planningScope)
    : undefined
  if (planningActivity && !currentPlanningActivityEvent) {
    await markProjectionProcessed(event.eventId)
    return
  }

  // A timesheet reminder is fenced on the entry it was revalidated against, so a submission that
  // lands before the save cancels it and the stream retry drops the reminder.
  const parentCondition = (currentScope.checked && authorizationEvent.teamId && authorizationEvent.issueId
    ? createCuratedContextSearchParentCondition(
        requireEnv('WORK_ITEMS_TABLE_NAME'),
        authorizationEvent,
        currentScope,
      )
    : undefined) ?? timesheetReminder.condition
  const watcherCandidates = await readSubscribedWatcherCandidates(authorizationEvent)
  const memberDirectory = notifiesPlanningUpdateProjectMembers(authorizationEvent)
    ? await readProjectDirectory(authorizationEvent.workspaceId)
    : undefined
  const candidates = groupNotificationCandidates({
    ...authorizationEvent,
    notificationCandidates: [
      ...authorizationEvent.notificationCandidates,
      ...watcherCandidates,
      ...(memberDirectory
        ? toPlanningUpdateProjectMemberCandidates(authorizationEvent, memberDirectory)
        : []),
    ],
  })
  const directoryItems = memberDirectory ?? (
    candidates.length > 0 && (
      authorizationEvent.projectId ||
      authorizationEvent.teamId ||
      currentPlanningActivityEvent?.projectId ||
      currentPlanningActivityEvent?.teamId
    )
      ? await readProjectDirectory(authorizationEvent.workspaceId)
      : []
  )
  const eligibleCandidates = (
    await Promise.all(
      candidates.map(async (candidate) =>
        isCurrentEscalationManager(authorizationEvent, candidate.memberKey, directoryItems) &&
        await isEligibleRecipient(
          authorizationEvent,
          candidate.memberKey,
          directoryItems,
          currentSystemAdminCache,
          dependencies.enterpriseIdentity,
          enterpriseSnapshotCache,
        ) &&
        (
          !currentPlanningActivityEvent ||
          hasSamePlanningScope(authorizationEvent, currentPlanningActivityEvent) ||
          await isEligibleRecipient(
            currentPlanningActivityEvent,
            candidate.memberKey,
            directoryItems,
            currentSystemAdminCache,
            dependencies.enterpriseIdentity,
            enterpriseSnapshotCache,
          )
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
  if (
    !supportsCollaborationWatcherNotifications(event.eventType) &&
    !notifiesWorkItemChangeWatchers(event)
  ) {
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
    planningNotificationKindFromEventType(eventType) !== undefined ||
    planningUpdatePublishEventTypes.has(eventType)
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
  if (workItemChangeWatcherEventTypes.has(event.eventType)) {
    // Project watchers follow comments, not every field change of each Work Item.
    return event.scopeKey ? [{ entityKey: event.scopeKey, reason: 'watcher' }] : []
  }
  const planningNotification = planningNotificationKindFromEventType(event.eventType) !== undefined ||
    planningUpdatePublishEventTypes.has(event.eventType)
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
        requireEnv('WORK_ITEMS_TABLE_NAME'),
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

  const baseExpression = !scope.exists
    ? 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)'
    : scope.projectId === undefined
      ? 'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND attribute_not_exists(#assignedProjectId)'
      : 'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #assignedProjectId = :assignedProjectId'
  // Scheduled stages were revalidated against this exact read, so any later Work Item write
  // cancels the save and the stream retry re-reads and revalidates.
  const pinRevision = scope.exists &&
    scope.revision !== undefined &&
    scheduledWorkItemNotificationReasons.has(event.eventType)
  const names: Record<string, string> = scope.exists ? { '#assignedProjectId': 'assignedProjectId' } : {}
  const values: Record<string, unknown> = scope.exists && scope.projectId !== undefined
    ? { ':assignedProjectId': scope.projectId }
    : {}
  if (pinRevision) {
    names['#revision'] = 'revision'
    values[':revision'] = scope.revision
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        directoryTeamId: `${event.workspaceId}#team#${event.teamId}`,
        issueId: event.issueId,
      },
      ConditionExpression: pinRevision ? `${baseExpression} AND #revision = :revision` : baseExpression,
      ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
      ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
    },
  }
}

async function projectNotification(
  event: AuditProjectionEvent,
  candidate: GroupedNotificationCandidate,
  parentCondition?: ProjectionConditionCheck,
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
    deliveryChannels: deliveryPlan.channels.filter((channel) => channel !== 'slack' || isSlackNotificationEligible(preferences, occurredAt)),
    deliveryAfter: deliveryPlan.deliveryAfter,
    deliveryFrequency: deliveryPlan.frequency,
    ...(isEmailTransportEnabled() && isEmailNotificationEligible(preferences, occurredAt) ? { emailQueued: true } : {}),
  }
}

/**
 * Reports whether this deployment configured the Email transport sender.
 * Without it, Email stays a stored preference and nothing is queued for a later backlog.
 * @returns Whether a sender address is configured.
 */
function isEmailTransportEnabled(): boolean {
  return Boolean(loadServerConfig().environment.NOTIFICATION_EMAIL_SENDER?.trim())
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
    fileId: event.fileId,
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
    ...(deliveryState.deliveryChannels.includes('slack') ? {
      slackQueueShard: slackDeliveryShard(recipientKey),
      slackNextAttemptAt: deliveryState.deliveryAfter,
      slackDeliveryStatus: 'pending',
      slackAttempts: 0,
    } : {}),
    ...(deliveryState.emailQueued && deliveryState.deliveryChannels.includes('email') ? {
      emailQueueShard: emailDeliveryShard(recipientKey),
      emailNextAttemptAt: deliveryState.deliveryAfter,
      emailDeliveryStatus: 'pending',
      emailAttempts: 0,
    } : {}),
    ...(deliveryState.archivedAt ? { archivedAt: deliveryState.archivedAt } : {}),
    occurredAt: event.occurredAt,
    createdAt: event.occurredAt,
    dueDate: event.dueDate,
    workItemUpdatedAt: event.workItemUpdatedAt,
    daysUntilDue: event.daysUntilDue,
    workItemReopenedAt: event.workItemReopenedAt,
    expiresAt,
  }
}

/**
 * Re-evaluates a dated stage against today's date in the Work Item's calendar at delivery time.
 *
 * A due-soon reminder stays valid only while the item is still before its due date and no
 * further out than when it was scanned. A due reminder stays valid only on the due date, and an
 * overdue reminder only after it. An escalation stays valid only while the item is at
 * least as overdue as when it was scanned. Without a local date or the scanned day count the
 * stage is kept, so events from older schedule versions still deliver.
 *
 * @param reason - Scheduled recipient reason.
 * @param event - Parsed scheduled audit event with its due date.
 * @param localDate - Today in the Work Item schedule's local calendar.
 * @returns Whether the stage still applies.
 */
function isScheduledStageStillCurrent(
  reason: string,
  event: AuditProjectionEvent,
  localDate: string | undefined,
) {
  if (!event.dueDate || localDate === undefined) return true
  const currentDaysUntilDue = Math.round(
    (Date.parse(`${event.dueDate}T00:00:00Z`) - Date.parse(`${localDate}T00:00:00Z`)) / 86_400_000,
  )
  if (reason === 'due-soon') {
    // On or after the due date the due and overdue stages take over.
    if (currentDaysUntilDue <= 0) return false
    return event.daysUntilDue === undefined || currentDaysUntilDue <= event.daysUntilDue
  }
  // A due-day reminder held past its date, or an overdue one whose calendar moved back to the
  // due date, no longer matches the item's stage.
  if (reason === 'due') return currentDaysUntilDue === 0
  if (reason === 'overdue') return currentDaysUntilDue < 0
  if (reason === 'escalation' && event.daysUntilDue !== undefined) {
    return currentDaysUntilDue <= event.daysUntilDue
  }
  return true
}

/**
 * Revalidates a timesheet reminder against the current time entries.
 *
 * A reminder whose entries were all submitted, deleted, or moved to another owner between the
 * scan and the projection is dropped. Without a revalidator the reminder is dropped too, so a
 * stale reminder is never delivered. A current reminder carries a condition on the entry it was
 * revalidated against, to be written in the same transaction as the notification.
 *
 * @param event - Parsed audit event.
 * @param revalidator - Current time entry reader.
 * @returns Whether the event should still be projected, and the condition for a timesheet reminder.
 */
export async function readTimesheetReminderFence(
  event: AuditProjectionEvent,
  revalidator: TimesheetReminderRevalidator | undefined,
): Promise<{ current: boolean; condition?: ProjectionConditionCheck }> {
  if (event.eventType !== TIMESHEET_REMINDER_EVENT_TYPE) return { current: true }
  const recipient = event.notificationCandidates.find((candidate) => candidate.reason === 'timesheet')
  const memberKey = normalizeMemberKey(recipient?.memberKey)
  if (
    !revalidator ||
    !event.teamId ||
    !memberKey ||
    event.notificationCandidates.length !== 1 ||
    !event.timeEntryIds?.length ||
    !event.timesheetDueBefore ||
    !event.projectId
  ) {
    return { current: false }
  }
  const condition = await revalidator.findUnsubmittedEntry({
    workspaceId: event.workspaceId,
    teamId: event.teamId,
    memberKey,
    entryIds: event.timeEntryIds,
    dueBefore: event.timesheetDueBefore,
    projectId: event.projectId,
  })
  return condition ? { current: true, condition } : { current: false }
}

/**
 * Revalidates a scheduled Work Item notification against the current Work Item row.
 *
 * Every stage requires the Work Item to still be open, unarchived, and on the same due date (or,
 * for a stale reminder, still started with the same `updatedAt` and not yet overdue). A due-soon
 * reminder also expires once the due date arrives. Owner stages are re-pointed at the current
 * owner and dropped when ownership changed. Escalation must still target the Project it was
 * scanned for and keeps its manager candidates; the caller filters them by current Project
 * manager role.
 *
 * @param event - Parsed scheduled audit event.
 * @param scope - Strongly read current Work Item scope.
 * @param scheduledProjectId - Project the scan escalated to, before the current scope was overlaid.
 * @returns The event with current recipients, or undefined when the stage is stale.
 */
export function refreshScheduledNotificationEvent(
  event: AuditProjectionEvent,
  scope: CurrentWorkItemNotificationScope,
  scheduledProjectId: string | undefined = event.projectId,
): AuditProjectionEvent | undefined {
  const reason = scheduledWorkItemNotificationReasons.get(event.eventType)
  if (!reason) {
    return event
  }

  if (
    !scope.checked ||
    !scope.exists ||
    !scope.assigneeMemberKey ||
    scope.archived === true ||
    scope.statusCategory === 'completed' ||
    scope.statusCategory === 'canceled'
  ) {
    return undefined
  }

  if (reason === 'stale') {
    if (
      scope.statusCategory !== 'started' ||
      !event.workItemUpdatedAt ||
      readTimestamp(scope.updatedAt) !== event.workItemUpdatedAt ||
      // Overdue reminders take over once the item passes its due date, as in the schedule.
      (scope.dueDate !== undefined && scope.localDate !== undefined && scope.dueDate < scope.localDate)
    ) {
      return undefined
    }
  } else if (!event.dueDate || scope.dueDate !== event.dueDate) {
    return undefined
  } else if (!isScheduledStageStillCurrent(reason, event, scope.localDate)) {
    return undefined
  }

  if (reason === 'escalation') {
    // A Project move gets its own escalation key on the next scan, so the old one is dropped.
    if (!scope.projectId || scope.projectId !== scheduledProjectId) return undefined
    // Reopening also gets its own key, so an escalation scanned before it is dropped.
    if (event.workItemReopenedAt !== readTimestamp(scope.reopenedAt)) return undefined
    const recipients = event.notificationCandidates.filter((candidate) =>
      candidate.reason === 'escalation' &&
      normalizeMemberKey(candidate.memberKey) !== scope.assigneeMemberKey
    )
    return recipients.length > 0 ? { ...event, notificationCandidates: recipients } : undefined
  }

  const scheduledMemberKey = normalizeMemberKey(
    event.notificationCandidates.find((candidate) => candidate.reason === reason)?.memberKey,
  )
  if (scheduledMemberKey !== scope.assigneeMemberKey) {
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
 * Reports whether a published Planning update also notifies the current Project members.
 *
 * @param event - Parsed audit event.
 * @returns True for a publish or health-degradation event on a Project target.
 */
export function notifiesPlanningUpdateProjectMembers(
  event: Pick<AuditProjectionEvent, 'eventType' | 'planningTargetType' | 'projectId'>,
) {
  return planningUpdatePublishEventTypes.has(event.eventType) &&
    event.planningTargetType === 'project' &&
    Boolean(event.projectId)
}

/**
 * Creates the authorization event for the current scope of a Planning update publish or comment.
 *
 * The event keeps the captured scope in `teamId` / `projectId`; the returned copy carries the
 * target's current scope instead. A recipient must pass both checks.
 *
 * @param event - Publish or comment event carrying the captured scope.
 * @param scope - Strongly read current target scope.
 * @returns The current-scope event, or undefined when the target is gone, archived, or different.
 */
export function createCurrentPlanningUpdateActivityScopeEvent(
  event: AuditProjectionEvent,
  scope: CurrentPlanningUpdateNotificationScope,
): AuditProjectionEvent | undefined {
  if (
    !planningUpdateActivityEventTypes.has(event.eventType) ||
    !scope.checked ||
    !scope.exists ||
    scope.archived ||
    !event.planningTargetType ||
    event.planningTargetType !== scope.targetType ||
    !event.planningTargetId ||
    event.planningTargetId !== scope.targetId ||
    !event.planningTargetRecordKey ||
    event.planningTargetRecordKey !== scope.targetRecordKey
  ) {
    return undefined
  }
  const { teamId: _capturedTeamId, projectId: _capturedProjectId, ...rest } = event
  return {
    ...rest,
    ...(scope.teamId ? { teamId: scope.teamId } : {}),
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
  }
}

/** Reports whether two events carry the same Team / Project authorization scope. */
function hasSamePlanningScope(
  left: Pick<AuditProjectionEvent, 'projectId' | 'teamId'>,
  right: Pick<AuditProjectionEvent, 'projectId' | 'teamId'>,
) {
  return left.teamId === right.teamId && left.projectId === right.projectId
}

/**
 * Lists the current members of the published update's Project as notification candidates.
 *
 * @param event - Publish event carrying the Project scope.
 * @param directoryItems - Current Project directory rows.
 * @returns One `project-member` candidate per current viewer, member, or manager.
 */
export function toPlanningUpdateProjectMemberCandidates(
  event: Pick<AuditProjectionEvent, 'projectId'>,
  directoryItems: ProjectDirectoryItem[],
): NotificationCandidate[] {
  return directoryItems.flatMap((item) => {
    const memberKey = normalizeMemberKey(item.memberKey)
    return item.entryType === 'project-member' &&
      item.projectId === event.projectId &&
      (item.role === 'viewer' || item.role === 'member' || item.role === 'manager') &&
      memberKey
      ? [{ memberKey, reason: 'project-member' }]
      : []
  })
}

/**
 * Reports whether a recipient may receive a Work Item escalation as a current Project manager.
 *
 * @param event - Scheduled event whose Project scope reflects the current Work Item.
 * @param memberKey - Recipient member key.
 * @param directoryItems - Current Project directory rows.
 * @returns True for non-escalation events, or when the member manages the current Project.
 */
export function isCurrentEscalationManager(
  event: Pick<AuditProjectionEvent, 'eventType' | 'projectId'>,
  memberKey: string,
  directoryItems: ProjectDirectoryItem[],
) {
  if (scheduledWorkItemNotificationReasons.get(event.eventType) !== 'escalation') {
    return true
  }
  const normalized = normalizeMemberKey(memberKey)
  return Boolean(event.projectId) && directoryItems.some((item) =>
    item.entryType === 'project-member' &&
    item.projectId === event.projectId &&
    item.role === 'manager' &&
    item.archivedAt === undefined &&
    normalizeMemberKey(item.memberKey) === normalized
  )
}

/**
 * Revalidates a scheduled Planning notification against its current owner, occurrence, and archive state.
 *
 * @param event - Parsed audit projection event.
 * @param scope - Strongly read current Planning update target scope.
 * @param currentWatcher - Recipient whose current subscription was independently verified.
 * @returns A current recipient event, or undefined when the scheduled event is stale.
 */
export function refreshPlanningScheduledNotificationEvent(
  event: AuditProjectionEvent,
  scope: CurrentPlanningUpdateNotificationScope,
  currentWatcher?: string,
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
    (scheduledRecipient !== currentRecipient && !currentWatcher)
  ) {
    return undefined
  }

  return {
    ...event,
    teamId: scope.teamId,
    projectId: scope.projectId,
    notificationCandidates: currentWatcher
      ? [{ memberKey: currentWatcher, reason: 'watcher' }]
      : [{ memberKey: currentRecipient, reason: kind }],
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

/**
 * Reads validated preferences before committing notification and processing receipts.
 * @param recipientKey - Server-derived Workspace/member partition key.
 * @returns Stored preferences or defaults for an absent row.
 * @throws Error when a stored row is corrupt, leaving the stream record retryable.
 */
async function readProjectionNotificationPreferences(recipientKey: string) {
  const result = await documentClient.send(new GetCommand({
    TableName: requireEnv('NOTIFICATIONS_TABLE_NAME'),
    Key: {
      recipientKey,
      notificationKey: NOTIFICATION_PREFERENCES_KEY,
    },
    ConsistentRead: true,
  }))

  return parseStoredNotificationPreferences(result.Item, true)
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

/** Enterprise authorization result for one scheduled notification recipient. */
export type EnterpriseNotificationAuthorization = {
  /** Whether Enterprise Identity makes the legacy Workspace ACL non-authoritative. */
  authoritative: boolean
  /** Whether the recipient has the permission required by the notification. */
  allowed: boolean
}

/**
 * Resolves authoritative Enterprise Work Item access, with write access for cadence recipients.
 *
 * Legacy project-member access remains the fallback path when the current Enterprise snapshot
 * does not make it non-authoritative, matching the cadence configuration path's boundary.
 *
 * @param event - Scheduled Planning notification scope and notification kind.
 * @param memberKey - Active Workspace member key being considered.
 * @param workspaceRole - Current Workspace role from the active member row.
 * @param snapshot - Authoritative Enterprise Identity snapshot.
 * @param projectScopeOwnerTeamId - Uniquely resolved owner Team for a legacy Project scope.
 * @param cognitoGroupIds - Current recipient Cognito groups for direct group assignments.
 * @param readOnlyRecipient - A current watcher needs only read access, including reminder deliveries.
 * @param permissionCeiling - Current external collaborator permission ceiling, when applicable.
 * @param contentPermission - Independent content permission for non-Planning sources.
 * @returns Whether Enterprise is authoritative and whether the member can perform the action.
 */
export function resolveEnterpriseNotificationAuthorization(
  event: Pick<AuditProjectionEvent, 'workspaceId' | 'projectId' | 'teamId' | 'planningNotificationKind'> &
    Partial<Pick<AuditProjectionEvent, 'eventType'>>,
  memberKey: string,
  workspaceRole: WorkspaceNotificationRole,
  snapshot: EnterpriseIdentitySnapshot,
  projectScopeOwnerTeamId?: string,
  cognitoGroupIds: string[] = [],
  readOnlyRecipient = false,
  permissionCeiling?: EnterprisePermissionId[],
  contentPermission: EnterprisePermissionId = 'work-items.read',
): EnterpriseNotificationAuthorization {
  if (snapshot.workspaceId !== event.workspaceId) {
    return { authoritative: false, allowed: false }
  }
  const normalizedMemberKey = normalizeMemberKey(memberKey)
  if (!normalizedMemberKey) return { authoritative: false, allowed: false }

  const directoryPrincipal = resolveEnterpriseDirectoryPrincipal(snapshot, memberKey, cognitoGroupIds)
  if (directoryPrincipal.deprovisioned) return { authoritative: true, allowed: false }
  const authoritative = directoryPrincipal.directoryManaged ||
    directoryPrincipal.compatibleRoleAssignments.some((assignment) =>
      assignment.principalKind === 'member' &&
        normalizeMemberKey(assignment.principalId) === normalizedMemberKey ||
      assignment.principalKind === 'directory-group' && (
        assignment.source === 'directory-mapping' ||
        directoryPrincipal.directoryGroupIds.includes(assignment.principalId)
      )
    ) || directoryPrincipal.compatibleGroupMappings.some((mapping) => mapping.enabled)
  if (!authoritative) return { authoritative: false, allowed: false }

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
      ? { workspaceId: event.workspaceId, kind: 'workspace' as const }
      : {
          workspaceId: event.workspaceId,
          kind: 'team' as const,
          targetId: event.teamId,
        }
  if (!resource) return { authoritative: true, allowed: false }

  const requiresWrite = !readOnlyRecipient && (event.planningNotificationKind === 'reminder' ||
    event.planningNotificationKind === 'overdue')
  const planningContent = event.planningNotificationKind !== undefined ||
    (event.eventType !== undefined && planningUpdateActivityEventTypes.has(event.eventType))
  const permissions: EnterprisePermissionId[] = planningContent
    ? requiresWrite ? ['planning.write', 'work-items.write'] : ['planning.read', 'work-items.read']
    : [contentPermission]
  const allowed = permissions.some((permission) => evaluateEnterpriseAccess({
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
      ...(permissionCeiling ? { permissionCeiling } : {}),
    },
    assignments: directoryPrincipal.compatibleRoleAssignments,
    customRoles: snapshot.customRoles,
    groupMappings: directoryPrincipal.compatibleGroupMappings,
    resource,
    ...(projectScopeOwnerTeamId !== undefined ? { projectScopeOwnerTeamId } : {}),
  }).allowed)
  return { authoritative: true, allowed }
}

/**
 * Evaluates whether a recipient has the Enterprise permission required by a cadence notification.
 *
 * @param event - Scheduled Planning notification scope and notification kind.
 * @param memberKey - Active Workspace member key being considered.
 * @param workspaceRole - Current Workspace role from the active member row.
 * @param snapshot - Authoritative Enterprise Identity snapshot.
 * @param projectScopeOwnerTeamId - Uniquely resolved owner Team for a legacy Project scope.
 * @returns Whether the member can perform the action represented by the notification.
 */
export function hasEligibleEnterpriseNotificationAccess(
  event: Pick<AuditProjectionEvent, 'workspaceId' | 'projectId' | 'teamId' | 'planningNotificationKind'>,
  memberKey: string,
  workspaceRole: WorkspaceNotificationRole,
  snapshot: EnterpriseIdentitySnapshot,
  projectScopeOwnerTeamId?: string,
): boolean {
  return resolveEnterpriseNotificationAuthorization(
    event,
    memberKey,
    workspaceRole,
    snapshot,
    projectScopeOwnerTeamId,
  ).allowed
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

/** One Team or Project scope through which a recipient may read a delivered Analytics report. */
type AnalyticsDeliveryAuthorizationScope = {
  /** Team of the scope; absent for the Workspace scope. */
  teamId?: string
  /** Project of the scope; absent for Workspace and Team scopes. */
  projectId?: string
}

/**
 * Lists the scopes whose Work Item read admits a recipient to a delivered Analytics report.
 *
 * Analytics accepts Work Item read on any scope that the report covers, so a Team report is
 * readable through its Team or any of its active Projects, and a shared or personal report
 * through the Workspace or any active Team or Project. The generic rule instead requires the one
 * scope carried by the event, which is the whole Workspace for a shared report.
 *
 * @param event - Delivered report event; carries a Team only for a Team report.
 * @param directoryItems - Current project directory snapshot.
 * @returns Candidate scopes, the event's own scope first.
 */
function listAnalyticsDeliveryAuthorizationScopes(
  event: Pick<AuditProjectionEvent, 'teamId'>,
  directoryItems: ProjectDirectoryItem[],
): AnalyticsDeliveryAuthorizationScope[] {
  const activeTeamIds = new Set(directoryItems.flatMap((item) =>
    item.entryType === 'team' && typeof item.teamId === 'string' && !item.archivedAt ? [item.teamId] : []
  ))
  const projectScopes = directoryItems.flatMap((item) =>
    item.entryType === 'project' && typeof item.teamId === 'string' && activeTeamIds.has(item.teamId) &&
      typeof item.projectId === 'string' && !item.archivedAt &&
      (event.teamId === undefined || item.teamId === event.teamId)
      ? [{ teamId: item.teamId, projectId: item.projectId }]
      : []
  )
  if (event.teamId !== undefined) return [{ teamId: event.teamId }, ...projectScopes]
  return [{}, ...[...activeTeamIds].map((teamId) => ({ teamId })), ...projectScopes]
}

/**
 * Resolves a Project's owner Team only when the active directory contains one owner.
 *
 * @param event - Notification target containing the Project identifier.
 * @param directoryItems - Current Project Directory rows.
 * @returns The unique owner Team ID, or undefined for an absent or ambiguous Project.
 */
function readUniqueNotificationProjectOwnerTeamId(
  event: Pick<AuditProjectionEvent, 'projectId'>,
  directoryItems: ProjectDirectoryItem[],
) {
  if (event.projectId === undefined) return undefined
  const ownerTeamIds = new Set(
    directoryItems
      .filter((item) =>
        item.entryType === 'project' &&
        item.projectId === event.projectId &&
        typeof item.teamId === 'string' &&
        !item.archivedAt
      )
      .flatMap((item) => typeof item.teamId === 'string' ? [item.teamId] : []),
  )
  return ownerTeamIds.size === 1 ? [...ownerTeamIds][0] : undefined
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

/**
 * Rechecks active membership and current scoped content permissions.
 * @param event - Notification with refreshed canonical resource scope.
 * @param memberKey - Normalized recipient key.
 * @param directoryItems - Current active directory and legacy Project memberships.
 * @param currentSystemAdminCache - Invocation-local Cognito membership reads.
 * @param enterpriseIdentity - Authoritative Enterprise snapshot reader.
 * @param enterpriseSnapshotCache - Invocation-local Enterprise snapshots.
 * @param enforceContentAuthorization - Applies content RBAC and full-Team visibility for external delivery.
 * @param readApproval - Current approval and file visibility reader for external delivery.
 * @returns Whether the recipient currently has access to the notification's source.
 */
async function isEligibleRecipient(
  event: AuditProjectionEvent,
  memberKey: string,
  directoryItems: ProjectDirectoryItem[],
  currentSystemAdminCache: Map<string, Promise<boolean>>,
  enterpriseIdentity: Pick<EnterpriseIdentityReadCapability, 'getSnapshot'> | undefined,
  enterpriseSnapshotCache: Map<string, Promise<EnterpriseIdentitySnapshot>>,
  enforceContentAuthorization = false,
  readApproval?: ApprovalNotificationReader,
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

  const analyticsScopes = event.eventType === analyticsReportDeliveredEventType && event.projectId === undefined
    ? listAnalyticsDeliveryAuthorizationScopes(event, directoryItems)
    : undefined
  let cognitoGroupIds: string[] = []
  let permissionCeiling: EnterprisePermissionId[] | undefined
  const readOnlyRecipient = event.notificationCandidates.length > 0 &&
    event.notificationCandidates.every((candidate) => candidate.reason === 'watcher')
  const selectedWorkspaceRecipient = event.eventType === 'automation.notification.requested' &&
    !event.teamId && !event.projectId && !event.issueId && !event.planningTargetId &&
    event.notificationCandidates.some((candidate) => normalizeMemberKey(candidate.memberKey) === memberKey && candidate.reason === 'automation')
  const contentPermission = selectedWorkspaceRecipient ? 'workspace.read'
    : event.eventType.startsWith('approval.') ? 'files.read' : 'work-items.read'
  if (enforceContentAuthorization) {
    const role = readWorkspaceNotificationRole(member.role)
    if (!enterpriseIdentity || !role) return false
    if (event.eventType.startsWith('approval.')) {
      if (!readApproval || !event.targetId || !event.teamId || !event.issueId) return false
      if (!await readApproval({ workspaceId: event.workspaceId, teamId: event.teamId, issueId: event.issueId,
        approvalId: event.targetId, fileId: event.fileId, guest: role === 'guest' })) return false
    }
    let snapshot = enterpriseSnapshotCache.get(event.workspaceId)
    if (!snapshot) {
      snapshot = enterpriseIdentity.getSnapshot(event.workspaceId)
      enterpriseSnapshotCache.set(event.workspaceId, snapshot)
    }
    const current = await snapshot
    if (current.workspaceId !== event.workspaceId) return false
    const boundary = resolveNotificationRecipientBoundary(current, memberKey, readString(member.email) ?? memberKey, role)
    permissionCeiling = boundary.permissionCeiling
    const requiresWrite = !readOnlyRecipient && (event.planningNotificationKind === 'reminder' || event.planningNotificationKind === 'overdue')
    const permissions: EnterprisePermissionId[] =
      event.planningNotificationKind || planningUpdateActivityEventTypes.has(event.eventType)
      ? requiresWrite ? ['planning.write', 'work-items.write'] : ['planning.read', 'work-items.read']
      : [contentPermission]
    if (!boundary.allowed || permissionCeiling && !permissions.some((permission) => permissionCeiling?.includes(permission))) return false
    const username = readString(member.username) ?? readString(member.email) ?? memberKey
    const currentGroups = await readNotificationCognitoGroups(username)
    if (currentGroups === undefined) return false
    cognitoGroupIds = currentGroups
    currentSystemAdminCache.set(username, Promise.resolve(cognitoGroupIds.some((group) => readSystemAdminGroups().includes(group))))
  }

  let enterpriseAuthorization: EnterpriseNotificationAuthorization | undefined
  if (
    enterpriseIdentity &&
    (
      event.planningNotificationKind !== undefined ||
      planningUpdateActivityEventTypes.has(event.eventType) ||
      // Timesheet access can come from an Enterprise role alone, so it is evaluated here too.
      event.eventType === TIMESHEET_REMINDER_EVENT_TYPE ||
      enforceContentAuthorization
    ) &&
    (event.projectId !== undefined || event.teamId !== undefined || enforceContentAuthorization)
  ) {
    const role = readWorkspaceNotificationRole(member.role)
    if (role) {
      let snapshotPromise = enterpriseSnapshotCache.get(event.workspaceId)
      if (!snapshotPromise) {
        snapshotPromise = enterpriseIdentity.getSnapshot(event.workspaceId)
        enterpriseSnapshotCache.set(event.workspaceId, snapshotPromise)
      }
      const snapshot = await snapshotPromise
      if (snapshot.workspaceId !== event.workspaceId) return false
      if (!enforceContentAuthorization && snapshotHasDirectoryGroupAssignments(snapshot)) {
        // Projection does not otherwise read groups, so a role assigned to one of the recipient's
        // directory groups would be missed and the Planning notification dropped.
        const currentGroups = await readNotificationCognitoGroups(
          readString(member.username) ?? readString(member.email) ?? memberKey,
        )
        if (currentGroups === undefined) return false
        cognitoGroupIds = currentGroups
      }
      const authorizations = (analyticsScopes ?? [event]).map((scope) =>
        resolveEnterpriseNotificationAuthorization(
          { ...event, teamId: scope.teamId, projectId: scope.projectId },
          memberKey,
          role,
          snapshot,
          readUniqueNotificationProjectOwnerTeamId(scope, directoryItems),
          cognitoGroupIds,
          readOnlyRecipient,
          permissionCeiling,
          contentPermission,
        )
      )
      enterpriseAuthorization = {
        authoritative: authorizations.some((authorization) => authorization.authoritative),
        allowed: authorizations.some((authorization) => authorization.allowed),
      }
    }
  }

  if (enterpriseAuthorization?.authoritative) {
    if (enterpriseAuthorization.allowed) return true
  } else {
    const legacyAllowed = hasEligibleProjectAccess(event, memberKey, directoryItems) &&
      (!enforceContentAuthorization || event.teamId || event.projectId || member.role !== 'guest' || selectedWorkspaceRecipient)
    const teamProjects = directoryItems.filter((item) => item.entryType === 'project' &&
      item.teamId === event.teamId && item.projectId && !item.archivedAt)
    if (analyticsScopes && event.teamId) {
      // A Team report is readable through any readable Project of its Team, as in the Analytics
      // schedule and Inbox checks, while the generic Team rule requires every Project of the Team.
      if (teamProjects.some((project) => hasEligibleProjectAccess(project, memberKey, directoryItems))) return true
    } else if (legacyAllowed && (!enforceContentAuthorization || event.projectId || !event.teamId ||
      teamProjects.length > 0 && teamProjects.every((project) => hasEligibleProjectAccess(project, memberKey, directoryItems)))) return true
  }

  const username = readString(member.username) ?? readString(member.email) ?? memberKey
  let currentSystemAdmin = currentSystemAdminCache.get(username)

  if (!currentSystemAdmin) {
    currentSystemAdmin = isCurrentSystemAdmin(username)
    currentSystemAdminCache.set(username, currentSystemAdmin)
  }

  return currentSystemAdmin
}

/**
 * Reports whether any role in the Enterprise snapshot is assigned to a directory group.
 *
 * @param snapshot - Current Enterprise Identity snapshot.
 * @returns Whether recipient groups can change the authorization result.
 */
function snapshotHasDirectoryGroupAssignments(snapshot: EnterpriseIdentitySnapshot) {
  return snapshot.roleAssignments.some((assignment) => assignment.principalKind === 'directory-group')
}

/** Authorization snapshots for one delivery; production creates a fresh instance for each notification. */
export type NotificationDeliveryAuthorizationCache = {
  /** Refresh boundary; cached lookups are reused only within a five-second window. */
  expiresAt: number
  /** Current directory snapshots, keyed by workspace. */
  directories: Map<string, Promise<ProjectDirectoryItem[]>>
  /** Current enterprise snapshots, keyed by workspace. */
  enterpriseSnapshots: Map<string, Promise<EnterpriseIdentitySnapshot>>
}

/**
 * Creates an invocation-local cache; no authorization result survives a worker invocation.
 * @returns Empty bounded-lifetime caches.
 */
export function createNotificationDeliveryAuthorizationCache(): NotificationDeliveryAuthorizationCache {
  return { expiresAt: 0, directories: new Map(), enterpriseSnapshots: new Map() }
}

/**
 * Reads all current Cognito groups separately for each external delivery.
 * @param username - Current membership's Cognito username.
 * @returns Current group names, or undefined for a deleted user; transient failures propagate for retry.
 */
async function readNotificationCognitoGroups(username: string): Promise<string[] | undefined> {
  try {
    const names: string[] = []
    const cursors = new Set<string>()
    let nextToken: string | undefined
    do {
      const response = await cognitoClient.send(new AdminListGroupsForUserCommand({
        UserPoolId: requireEnv('COGNITO_USER_POOL_ID'), Username: username,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }))
      names.push(...(response.Groups ?? []).flatMap((group) => group.GroupName?.trim() ? [group.GroupName.trim()] : []))
      nextToken = response.NextToken?.trim() || undefined
      if (nextToken && cursors.has(nextToken)) throw new Error('Current notification group pagination did not advance.')
      if (nextToken) cursors.add(nextToken)
    } while (nextToken)
    return names
  } catch (error: unknown) {
    if (isAwsNamedError(error, 'UserNotFoundException')) return undefined
    throw error
  }
}

/**
 * Rechecks source scope and current recipient access immediately before external delivery.
 * @param event - Stored notification source and scope.
 * @param memberKey - Canonical recipient member key.
 * @param enterpriseIdentity - Authoritative enterprise identity reader.
 * @param cache - Snapshots for this delivery only; callers must not reuse them for another notification.
 * @param readDocument - Permission-filtered Documents reader; missing capability denies document delivery.
 * @param readTriage - Current permission-safe Triage reader; missing capability denies Triage delivery.
 * @param readApproval - Current approval/file reader; missing capability denies approval delivery.
 * @returns Whether the notification's recipient still has access.
 */
export async function authorizeNotificationDelivery(
  event: AuditProjectionEvent,
  memberKey: string,
  enterpriseIdentity: Pick<EnterpriseIdentityReadCapability, 'getSnapshot'>,
  cache: NotificationDeliveryAuthorizationCache = createNotificationDeliveryAuthorizationCache(),
  readDocument?: (request: GetDocumentRequest) => Promise<unknown>,
  readTriage?: (workspaceId: string, teamId: string, entryId: string) => Promise<Pick<TriageEntry, 'permission' | 'retention' | 'projectId' | 'ownerUserId'>>,
  readApproval?: ApprovalNotificationReader,
): Promise<boolean> {
  if (cache.expiresAt <= Date.now()) {
    cache.directories.clear()
    cache.enterpriseSnapshots.clear()
    cache.expiresAt = Date.now() + 5_000
  }
  if (event.eventType.startsWith('document.')) {
    if (!readDocument || !event.entityId) return false
    const result = await documentClient.send(new GetCommand({
      TableName: requireEnv('WORKSPACE_ACCESS_TABLE_NAME'),
      Key: { workspaceId: event.workspaceId, recordKey: `MEMBER#${memberKey}` }, ConsistentRead: true,
    }))
    const member = result.Item
    if (!isActiveWorkspaceNotificationMember(memberKey, member)) return false
    const workspaceRole = readWorkspaceNotificationRole(member?.role)
    if (!workspaceRole) return false
    let directoryPromise = cache.directories.get(event.workspaceId)
    if (!directoryPromise) {
      directoryPromise = readProjectDirectory(event.workspaceId)
      cache.directories.set(event.workspaceId, directoryPromise)
    }
    let enterprisePromise = cache.enterpriseSnapshots.get(event.workspaceId)
    if (!enterprisePromise) {
      enterprisePromise = enterpriseIdentity.getSnapshot(event.workspaceId)
      cache.enterpriseSnapshots.set(event.workspaceId, enterprisePromise)
    }
    const directory = await directoryPromise
    const projects = directory.flatMap((item) => {
      if (item.entryType !== 'project' || !item.projectId || !item.teamId ||
        !hasActiveNotificationScope(item, directory) ||
        readUniqueNotificationProjectOwnerTeamId(item, directory) !== item.teamId) return []
      return [{ teamId: item.teamId, projectId: item.projectId }]
    })
    const projectRoles: Record<string, DocumentProjectRole> = {}
    for (const item of directory) {
      if (item.entryType === 'project-member' && normalizeMemberKey(item.memberKey) === memberKey &&
        item.projectId && (item.role === 'viewer' || item.role === 'member' || item.role === 'manager') &&
        projects.some((project) => project.projectId === item.projectId && (!item.teamId || project.teamId === item.teamId))) {
        projectRoles[item.projectId] = item.role
      }
    }
    const username = readString(member?.username) ?? readString(member?.email) ?? memberKey
    const cognitoGroupIds = await readNotificationCognitoGroups(username)
    if (cognitoGroupIds === undefined) return false
    const systemAdmin = cognitoGroupIds.some((group) => readSystemAdminGroups().includes(group))
    return isDocumentDeliveryVisible(event.workspaceId, event.entityId, resolveDocumentDeliveryAccess({
      workspaceId: event.workspaceId, memberKey, memberEmail: readString(member?.email) ?? memberKey,
      workspaceRole, projectRoles, projects, cognitoGroupIds,
      isSystemAdmin: systemAdmin, snapshot: await enterprisePromise,
    }), readDocument)
  }
  let sourceEvent = event
  if (event.triageEntryId) {
    if (!event.teamId || !readTriage) return false
    try {
      const entry = await readTriage(event.workspaceId, event.teamId, event.triageEntryId)
      if (entry.permission.visibility !== 'full' || entry.retention.redactedAt !== undefined) return false
      const ownerOnly = event.notificationCandidates.length > 0 && event.notificationCandidates.every(({ reason }) =>
        ['assignee', 'assignment', 'due', 'overdue', 'sla', 'triage-sla', 'escalation', 'triage-assignment'].includes(reason))
      if (!event.issueId && ownerOnly && normalizeMemberKey(entry.ownerUserId) !== memberKey) return false
      const { projectId: _historicalProjectId, ...withoutProject } = event
      sourceEvent = { ...withoutProject, ...(entry.projectId ? { projectId: entry.projectId } : {}) }
    } catch (error: unknown) {
      if (error instanceof TriageError && error.status === 404) return false
      throw error
    }
  }
  const currentScope = await readCurrentWorkItemScope(sourceEvent)
  if (!currentScope.exists) return false
  if (currentScope.checked && requiresCurrentWorkItemAssignee({
    reasons: sourceEvent.notificationCandidates
      .filter((candidate) => normalizeMemberKey(candidate.memberKey) === memberKey)
      .map((candidate) => candidate.reason),
  }) && currentScope.assigneeMemberKey !== memberKey) return false
  const scoped = refreshScheduledNotificationEvent(
    currentScope.checked ? overlayCurrentWorkItemNotificationScope(sourceEvent, currentScope) : sourceEvent,
    currentScope,
    sourceEvent.projectId,
  )
  if (!scoped) return false
  const planningScope = await readCurrentPlanningUpdateScope(scoped)
  if (!planningScope.exists) return false
  const planningActivity = planningUpdateActivityEventTypes.has(scoped.eventType)
  const currentPlanningActivityEvent = planningActivity
    ? createCurrentPlanningUpdateActivityScopeEvent(scoped, planningScope)
    : undefined
  if (planningActivity && !currentPlanningActivityEvent) return false
  const current = planningScope.checked && !planningActivity
    ? { ...scoped, teamId: planningScope.teamId, projectId: planningScope.projectId }
    : scoped
  let currentWatcher: string | undefined
  if (planningScope.checked && event.notificationCandidates.some((candidate) => candidate.reason === 'watcher')) {
    for (const { entityKey } of createSubscribedWatcherScopes(current)) {
      const recordKey = `WATCHER#${memberKey}`
      const watcher = await documentClient.send(new GetCommand({
        TableName: requireEnv('COLLABORATION_TABLE_NAME'), Key: { entityKey, recordKey }, ConsistentRead: true,
      }))
      if (watcher.Item?.entityKey === entityKey && watcher.Item.recordKey === recordKey &&
        toSubscribedWatcherCandidates([watcher.Item], 'watcher').some((candidate) => normalizeMemberKey(candidate.memberKey) === memberKey)) {
        currentWatcher = memberKey
        break
      }
    }
  }
  const refreshed = refreshPlanningScheduledNotificationEvent(current, planningScope, currentWatcher)
  if (!refreshed) return false
  if (
    planningActivity &&
    !currentWatcher &&
    !event.notificationCandidates.some((candidate) =>
      candidate.reason !== 'watcher' && normalizeMemberKey(candidate.memberKey) === memberKey
    )
  ) return false
  let directory: ProjectDirectoryItem[] = []
  if (
    refreshed.projectId ||
    refreshed.teamId ||
    // A shared report is readable through any Team or Project, so it needs the directory too.
    refreshed.eventType === analyticsReportDeliveredEventType ||
    currentPlanningActivityEvent?.projectId ||
    currentPlanningActivityEvent?.teamId
  ) {
    let snapshot = cache.directories.get(event.workspaceId)
    if (!snapshot) {
      snapshot = readProjectDirectory(event.workspaceId)
      cache.directories.set(event.workspaceId, snapshot)
    }
    directory = await snapshot
  }
  if (!isCurrentEscalationManager(refreshed, memberKey, directory)) return false
  if (
    currentPlanningActivityEvent &&
    !hasSamePlanningScope(refreshed, currentPlanningActivityEvent) &&
    !await isEligibleRecipient(
      currentPlanningActivityEvent, memberKey, directory,
      new Map<string, Promise<boolean>>(), enterpriseIdentity, cache.enterpriseSnapshots,
      true, readApproval,
    )
  ) return false
  return isEligibleRecipient(
    refreshed, memberKey, directory,
    new Map<string, Promise<boolean>>(), enterpriseIdentity, cache.enterpriseSnapshots,
    true, readApproval,
  )
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

/** Reads normalized configured Cognito administrator group names. */
function readSystemAdminGroups() {
  return requireEnv('SYSTEM_ADMIN_GROUPS').split(',').map((group) => group.trim()).filter(Boolean)
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
    TableName: requireEnv('WORK_ITEMS_TABLE_NAME'),
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
    updatedAt: item.updatedAt,
    localDate: workItemScheduleInstantToLocalDate(new Date(), item.schedule.calendarPolicy),
    archived: item.archivedAt !== undefined,
    revision: item.revision,
    ...(item.reopenedAt === undefined ? {} : { reopenedAt: item.reopenedAt }),
  }
}

/**
 * Strongly reads the canonical Planning update target and Initiative scope for scheduled, publish, and comment events.
 *
 * @param event - Parsed audit event that may represent a Planning scheduled notification.
 * @returns Current Planning target scope, or an unchecked pass-through for other events.
 */
async function readCurrentPlanningUpdateScope(
  event: AuditProjectionEvent,
): Promise<CurrentPlanningUpdateNotificationScope> {
  const kind = planningNotificationKindFromEventType(event.eventType)
  if (!kind && !planningUpdateActivityEventTypes.has(event.eventType)) {
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
  const teamId = readOptionalPlanningScopeId(
    initiative.teamId,
    'Planning notification Initiative Team scope',
  )
  const projectId = readOptionalPlanningScopeId(
    initiative.projectId,
    'Planning notification Initiative Project scope',
  )
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
    workItemUpdatedAt: readTimestamp(metadata.workItemUpdatedAt),
    daysUntilDue: readOptionalDaysUntilDue(metadata.daysUntilDue),
    workItemReopenedAt: readOptionalReopenedAt(metadata.workItemReopenedAt),
    planningTargetType: readPlanningTargetType(metadata.planningTargetType),
    planningTargetId: readString(metadata.planningTargetId),
    planningTargetRecordKey: readString(metadata.planningTargetRecordKey),
    planningNextDueAt: readTimestamp(metadata.planningNextDueAt),
    planningNotificationKind: readPlanningNotificationKind(
      metadata.planningNotificationKind,
    ),
    ...(Array.isArray(metadata.timeEntryIds)
      ? { timeEntryIds: metadata.timeEntryIds.flatMap((entryId) => readString(entryId) ?? []) }
      : {}),
    ...(readString(metadata.timesheetDueBefore) ? { timesheetDueBefore: readString(metadata.timesheetDueBefore) } : {}),
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

/**
 * Reads an optional persisted Planning scope field without coercing malformed values to absent.
 *
 * @param value - Raw persisted scope value.
 * @param label - Field name used in the projection error.
 * @returns A trimmed scope identifier, or undefined when the field is absent.
 */
function readOptionalPlanningScopeId(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(label + ' is invalid.')
  }
  return value.trim()
}

/** Reads and canonicalizes a valid timestamp from untrusted event metadata. */
function readTimestamp(value: unknown): string | undefined {
  const text = readString(value)
  if (!text) return undefined
  const timestamp = Date.parse(text)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

/**
 * Reads the Work Item reopen time an escalation was scanned under.
 *
 * @param value - Raw `metadata.workItemReopenedAt` value.
 * @returns The canonical timestamp, or undefined when the field is absent.
 * @throws Error when the field is present but not a timestamp.
 */
function readOptionalReopenedAt(value: unknown) {
  if (value === undefined) return undefined
  const timestamp = readTimestamp(value)
  if (!timestamp) throw new Error('Scheduled Work Item notification workItemReopenedAt is invalid.')
  return timestamp
}

function readPositiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

/**
 * Reads the day count a schedule scan recorded on a dated Work Item event.
 *
 * Events from older schedule versions carry no count and keep their fallback. A present value
 * that is not a safe integer is a malformed event, so it fails the record instead of being read
 * as missing.
 *
 * @param value - Raw `metadata.daysUntilDue` value.
 * @returns The day count, or undefined when the field is absent.
 * @throws Error when the field is present but not a safe integer.
 */
function readOptionalDaysUntilDue(value: unknown) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value)) {
    throw new Error('Scheduled Work Item notification daysUntilDue is invalid.')
  }
  return Number(value)
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
  const value = Number(loadServerConfig().environment[name] ?? fallback)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function getAwsRegion() {
  const environment = loadServerConfig().environment
  return environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION ?? 'us-east-1'
}

function requireEnv(name: string) {
  const value = loadServerConfig().environment[name]?.trim()

  if (!value) {
    throw new Error(`${name} is required.`)
  }

  return value
}
