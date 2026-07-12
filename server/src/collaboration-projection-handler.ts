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
} from '@aws-sdk/lib-dynamodb'
import {
  listScopeConnections,
  postRealtimeMessage,
} from './realtime-handler'

/**
 * DynamoDB Streams event に含まれる AttributeValue の最小表現です。
 */
export type DynamoAttributeValue = {
  /** 文字列値です。 */
  S?: string
  /** 数値を表す文字列値です。 */
  N?: string
  /** 真偽値です。 */
  BOOL?: boolean
  /** null marker です。 */
  NULL?: boolean
  /** list value です。 */
  L?: DynamoAttributeValue[]
  /** map value です。 */
  M?: Record<string, DynamoAttributeValue>
  /** string set です。 */
  SS?: string[]
  /** number set です。 */
  NS?: string[]
}

/**
 * DynamoDB Streams record の database image です。
 */
export type DynamoStreamImage = {
  /** mutation 後の DynamoDB item です。 */
  NewImage?: Record<string, DynamoAttributeValue>
  /** Lambda partial batch response で checkpoint に使う stream sequence number です。 */
  SequenceNumber?: string
}

/**
 * AuditEventsTable stream の1 record です。
 */
export type DynamoStreamRecord = {
  /** 診断用の DynamoDB Streams event ID です。 */
  eventID?: string
  /** INSERT、MODIFY、REMOVE の event 種別です。 */
  eventName?: string
  /** DynamoDB item image です。 */
  dynamodb?: DynamoStreamImage
}

/**
 * AuditEventsTable stream Lambda event です。
 */
type DynamoStreamEvent = {
  /** 同じ batch で配送された stream records です。 */
  Records?: DynamoStreamRecord[]
}

/**
 * 再試行する stream record の識別子です。
 */
export type BatchItemFailure = {
  /** 再試行対象の DynamoDB Streams sequence number です。 */
  itemIdentifier: string
}

/**
 * Lambda partial batch failure response です。
 */
type BatchResponse = {
  /** 処理に失敗した stream records です。 */
  batchItemFailures: BatchItemFailure[]
}

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
  /** 現在権限の照合に使う project ID です。 */
  projectId?: string
  /** current comment ID です。 */
  commentId?: string
  /** notification/realtime consumer へ配送する event かどうかです。 */
  outboxStatus: 'pending' | 'suppressed'
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

const dynamoDbClient = new DynamoDBClient({ region: getAwsRegion() })
const cognitoClient = new CognitoIdentityProviderClient({ region: getAwsRegion() })
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})
const projectionConsumerName = 'collaboration-projection-v1'

/**
 * AuditEventsTable の pending outbox records を通知と realtime invalidation に projection します。
 */
export async function handler(event: DynamoStreamEvent): Promise<BatchResponse> {
  const records = event.Records ?? []
  const currentSystemAdminCache = new Map<string, Promise<boolean>>()
  const results = await Promise.all(
    records.map(async (record) => {
      try {
        await processRecord(record, currentSystemAdminCache)
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
) {
  if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) {
    return
  }

  const event = parseAuditProjectionEvent(unmarshalMap(record.dynamodb.NewImage))

  if (!event || event.outboxStatus !== 'pending' || await isProjectionProcessed(event.eventId)) {
    return
  }

  const currentScope = await readCurrentWorkItemScope(event)
  if (!currentScope.exists) {
    await markProjectionProcessed(event.eventId)
    return
  }
  const authorizationEvent = currentScope.checked
    ? { ...event, projectId: currentScope.projectId }
    : event

  const watcherCandidates = await readSubscribedWatcherCandidates(authorizationEvent)
  const candidates = groupNotificationCandidates({
    ...event,
    notificationCandidates: [...event.notificationCandidates, ...watcherCandidates],
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
        )
          ? candidate
          : undefined,
      ),
    )
  ).filter(isDefined)

  await Promise.all(
    eligibleCandidates.map((candidate) => projectNotification(event, candidate)),
  )
  await publishRealtimeInvalidation(event)
  await markProjectionProcessed(event.eventId)
}

async function readSubscribedWatcherCandidates(event: AuditProjectionEvent) {
  if (!['comment.created', 'comment.replied', 'comment.edited'].includes(event.eventType)) {
    return []
  }

  const scopes = [
    ...(event.scopeKey
      ? [{ entityKey: event.scopeKey, reason: 'watcher' }]
      : []),
    ...(event.projectId
      ? [{
          entityKey: `${event.workspaceId}#project#${event.projectId}`,
          reason: 'project-watcher',
        }]
      : []),
  ]
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

async function isProjectionProcessed(eventId: string) {
  const result = await documentClient.send(
    new GetCommand({
      TableName: requireEnv('PROCESSED_AUDIT_EVENTS_TABLE_NAME'),
      Key: {
        consumerName: projectionConsumerName,
        eventId,
      },
      ConsistentRead: true,
    }),
  )

  return result.Item !== undefined
}

async function markProjectionProcessed(eventId: string) {
  try {
    await documentClient.send(
      new PutCommand({
        TableName: requireEnv('PROCESSED_AUDIT_EVENTS_TABLE_NAME'),
        Item: {
          consumerName: projectionConsumerName,
          eventId,
          processedAt: new Date().toISOString(),
          expiresAt: currentEpochSeconds() + readPositiveIntegerEnv(
            'PROCESSED_AUDIT_EVENT_RETENTION_SECONDS',
            30 * 24 * 60 * 60,
          ),
        },
        ConditionExpression: 'attribute_not_exists(consumerName) AND attribute_not_exists(eventId)',
      }),
    )
  } catch (error) {
    if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) {
      throw error
    }
  }
}

async function projectNotification(
  event: AuditProjectionEvent,
  candidate: GroupedNotificationCandidate,
) {
  const { recipientKey, notificationKey, consumerName } = createNotificationProjectionKeys(
    event,
    candidate.memberKey,
  )

  try {
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: requireEnv('NOTIFICATIONS_TABLE_NAME'),
              Item: {
                recipientKey,
                notificationKey,
                notificationId: event.eventId,
                workspaceId: event.workspaceId,
                recipientMemberKey: candidate.memberKey,
                eventId: event.eventId,
                eventType: event.eventType,
                actorUserId: event.actorUserId,
                actorMemberKey: event.actorMemberKey,
                entityId: event.entityId,
                entityKey: event.scopeKey,
                targetId: event.targetId,
                commentId: event.commentId,
                projectId: event.projectId,
                teamId: event.teamId,
                deepLink: event.deepLink,
                reasons: candidate.reasons,
                occurredAt: event.occurredAt,
                createdAt: event.occurredAt,
              },
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
    if (!isConditionalTransactionCancellation(error)) {
      throw error
    }
  }
}

async function publishRealtimeInvalidation(event: AuditProjectionEvent) {
  if (!event.scopeKey) {
    return
  }

  const callbackEndpoint = process.env.WEBSOCKET_CALLBACK_ENDPOINT?.trim()

  if (!callbackEndpoint) {
    return
  }

  const connections = await listScopeConnections(event.scopeKey)

  await Promise.all(
    connections.map((connection) =>
      postRealtimeMessage(callbackEndpoint, connection.connectionId, {
        type: 'collaboration.invalidated',
        eventId: event.eventId,
        eventType: event.eventType,
        scopeKey: event.scopeKey,
        entityId: event.entityId,
        targetId: event.targetId,
        occurredAt: event.occurredAt,
      }),
    ),
  )
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
  const accessibleProjectIds = new Set(
    directoryItems
      .filter((item) =>
        item.entryType === 'project-member' &&
        normalizeMemberKey(item.memberKey) === memberKey &&
        (item.role === 'viewer' || item.role === 'member' || item.role === 'manager') &&
        item.projectId,
      )
      .map((item) => item.projectId as string),
  )

  if (event.projectId) {
    const project = activeProjects.find((item) => item.projectId === event.projectId)
    return project !== undefined &&
      (!event.teamId || project.teamId === event.teamId) &&
      accessibleProjectIds.has(event.projectId)
  }

  return activeProjects.some((item) =>
    item.teamId === event.teamId &&
    item.projectId !== undefined &&
    accessibleProjectIds.has(item.projectId)
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

  const username = readString(member.username) ?? readString(member.email) ?? memberKey
  let currentSystemAdmin = currentSystemAdminCache.get(username)

  if (!currentSystemAdmin) {
    currentSystemAdmin = isCurrentSystemAdmin(username)
    currentSystemAdminCache.set(username, currentSystemAdmin)
  }

  return currentSystemAdmin
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

async function readCurrentWorkItemScope(event: AuditProjectionEvent) {
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

  if (!item || item.directoryTeamId !== directoryTeamId || item.issueId !== event.issueId) {
    return { checked: true, exists: false, projectId: undefined }
  }

  return {
    checked: true,
    exists: true,
    projectId: typeof item.assignedProjectId === 'string' ? item.assignedProjectId : undefined,
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
    scopeKey,
    entityId,
    targetId: readString(value.targetId) ?? readString(target.id),
    notificationCandidates: readNotificationCandidates(metadata.notificationCandidates),
    deepLink: readString(metadata.deepLink),
    teamId: readString(metadata.teamId),
    issueId: readString(metadata.issueId),
    projectId: readString(metadata.projectId),
    commentId: readString(metadata.commentId),
    outboxStatus: value.outboxStatus === 'suppressed' ? 'suppressed' : 'pending',
  }
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

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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
