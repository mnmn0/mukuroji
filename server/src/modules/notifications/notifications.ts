import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import { getConfiguredDynamoDbEndpoint } from '../audit'

/** Notification timeline で選択できる保存状態です。 */
export type NotificationState = 'unread' | 'read' | 'archived' | 'snoozed'

/** Notification timeline の filter です。 */
export type NotificationFilter = 'all' | NotificationState

/** Notification mutation の action です。 */
export type NotificationAction =
  | 'mark-read'
  | 'mark-unread'
  | 'archive'
  | 'restore'
  | 'snooze'

/** Digest をまとめる頻度です。 */
export type NotificationFrequency = 'instant' | 'hourly' | 'daily' | 'weekly'

/** Notification を配送できる channel 設定です。 */
export type NotificationChannels = {
  /** In-app Inbox に通知を表示するかどうかです。 */
  inApp: boolean
  /** Email delivery plan を作成するかどうかです。 */
  email: boolean
  /** Push delivery plan を作成するかどうかです。 */
  push: boolean
}

/** Notification delivery を止める quiet hours です。 */
export type NotificationQuietHours = {
  /** Quiet hours を有効にするかどうかです。 */
  enabled: boolean
  /** Quiet hours の開始時刻を表す `HH:mm` です。 */
  start: string
  /** Quiet hours の終了時刻を表す `HH:mm` です。 */
  end: string
  /** Quiet hours を評価する IANA time zone です。 */
  timeZone: string
}

/** ユーザー別 notification preference です。 */
export type NotificationPreferences = {
  /** 保存済み preference の optimistic concurrency version です。 */
  version: number
  /** Channel ごとの有効状態です。 */
  channels: NotificationChannels
  /** Instant または digest の頻度です。 */
  frequency: NotificationFrequency
  /** Delivery を避ける時間帯です。 */
  quietHours: NotificationQuietHours
  /** 最終保存時刻です。未保存の default では省略します。 */
  updatedAt?: string
}

/** Notification preference を置き換える入力です。 */
export type UpdateNotificationPreferencesInput = {
  /** 読み込み時点の preference version です。 */
  version: number
  /** 保存する channel 設定です。 */
  channels: NotificationChannels
  /** 保存する delivery frequency です。 */
  frequency: NotificationFrequency
  /** 保存する quiet hours です。 */
  quietHours: NotificationQuietHours
}

/** Inbox API が返す render-ready notification です。 */
export type NotificationItem = {
  /** Recipient と sort key に束縛された opaque ID です。 */
  id: string
  /** 元になった immutable audit event ID です。 */
  eventId: string
  /** `comment.replied` などの event type です。 */
  eventType: string
  /** Notification の認可対象を再解決する canonical entity ID です。 */
  entityId?: string
  /** Recipient が通知対象になった理由です。 */
  reasons: string[]
  /** Actor の安全な表示ラベルです。 */
  actorLabel?: string
  /** 対象 Work Item などの表示タイトルです。 */
  title?: string
  /** Event の安全な短い概要です。 */
  summary?: string
  /** App 内で対象を開く相対 path です。 */
  deepLink?: string
  /** 対象 Team ID です。 */
  teamId?: string
  /** 現在の assigned Project ID です。 */
  projectId?: string
  /** 対象 Work Item ID です。 */
  issueId?: string
  /** 対象 comment ID です。 */
  commentId?: string
  /** Reply が属する root comment ID です。 */
  rootCommentId?: string
  /** Scheduled health update の Project / Initiative target type です。 */
  planningTargetType?: 'project' | 'initiative'
  /** Scheduled health update の canonical target ID です。 */
  planningTargetId?: string
  /** Current Planning target を再検証する record key です。 */
  planningTargetRecordKey?: string
  /** Scheduled health update が対象にした cadence deadline です。 */
  planningNextDueAt?: string
  /** Scheduled health update の notification stage です。 */
  planningNotificationKind?: 'reminder' | 'overdue' | 'escalation'
  /** Event 発生日時です。 */
  occurredAt: string
  /** 現在の Inbox state です。 */
  state: NotificationState
  /** Read にした日時です。 */
  readAt?: string
  /** Archive にした日時です。 */
  archivedAt?: string
  /** Snooze が終了する日時です。 */
  snoozedUntil?: string
}

/** Notification page の取得条件です。 */
export type ListNotificationsInput = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 認証済み Workspace member key です。 */
  memberKey: string
  /** Timeline state filter です。 */
  filter?: NotificationFilter
  /** Event type の追加 filter です。 */
  eventType?: string
  /** 1 page の最大件数です。 */
  limit?: number
  /** 前 page が返した opaque cursor です。 */
  cursor?: string
  /** Snooze expiry を評価する時刻です。 */
  now?: Date
  /** 現在の権限で notification を表示できるか判定します。 */
  isVisible?: NotificationVisibilityFilter
}

/** Notification timeline の1 pageです。 */
export type NotificationPage = {
  /** 現在の権限で表示できる notification です。 */
  notifications: NotificationItem[]
  /** 次 page がある場合の opaque cursor です。 */
  nextCursor?: string
}

/** Notification state mutation の入力です。 */
export type UpdateNotificationInput = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 認証済み Workspace member key です。 */
  memberKey: string
  /** API が受け取った opaque notification ID です。 */
  notificationId: string
  /** 適用する state action です。 */
  action: NotificationAction
  /** Snooze action の終了日時です。 */
  snoozedUntil?: string
  /** Mutation timestamp です。 */
  now?: Date
  /** 現在の権限で notification を変更できるか判定します。 */
  isVisible?: NotificationVisibilityFilter
}

/** Mark-all-read の入力です。 */
export type MarkAllNotificationsReadInput = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 認証済み Workspace member key です。 */
  memberKey: string
  /** Mutation timestamp です。 */
  now?: Date
  /** 現在の権限で notification を変更できるか判定します。 */
  isVisible?: NotificationVisibilityFilter
}

/** Notification の unread count 取得入力です。 */
export type CountUnreadNotificationsInput = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 認証済み Workspace member key です。 */
  memberKey: string
  /** Snooze expiry を評価する時刻です。 */
  now?: Date
  /** 現在の権限で notification を表示できるか判定します。 */
  isVisible?: NotificationVisibilityFilter
}

/** Notification preference の recipient 入力です。 */
export type NotificationRecipientInput = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 認証済み Workspace member key です。 */
  memberKey: string
}

/** Notification preference 更新入力です。 */
export type SaveNotificationPreferencesInput = NotificationRecipientInput & {
  /** 保存する preference です。 */
  preferences: UpdateNotificationPreferencesInput
  /** Mutation timestamp です。 */
  now?: Date
}

/** Notification の現在権限 filter です。 */
export type NotificationVisibilityFilter = (
  notification: NotificationItem,
) => boolean | Promise<boolean>

/** Notification delivery plan です。 */
export type NotificationDeliveryPlan = {
  /** 有効な channel 一覧です。 */
  channels: Array<keyof NotificationChannels>
  /** Email/push digest を配送可能になる時刻です。 */
  deliveryAfter: string
  /** Plan を作成した frequency です。 */
  frequency: NotificationFrequency
}

/** API handler が利用する notification store 契約です。 */
export type NotificationClient = {
  /** Recipient の notification timeline を page 取得します。 */
  list(input: ListNotificationsInput): Promise<NotificationPage>
  /** Recipient の現在表示可能な unread 件数を返します。 */
  countUnread(input: CountUnreadNotificationsInput): Promise<number>
  /** Notification の read/archive/snooze state を更新します。 */
  update(input: UpdateNotificationInput): Promise<NotificationItem>
  /** 現在表示可能な unread notification をすべて read にします。 */
  markAllRead(input: MarkAllNotificationsReadInput): Promise<number>
  /** Recipient の preference または default を返します。 */
  getPreferences(input: NotificationRecipientInput): Promise<NotificationPreferences>
  /** Recipient の preference を version 条件付きで置き換えます。 */
  savePreferences(input: SaveNotificationPreferencesInput): Promise<NotificationPreferences>
}

/** Notification API/store の安定した error です。 */
export class NotificationError extends Error {
  /** HTTP status code です。 */
  readonly status: number
  /** Client が分岐に使う error code です。 */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** NotificationsTable 内で preference を識別する sort key です。 */
export const NOTIFICATION_PREFERENCES_KEY = '!PREFERENCES'

/** 旧 notification row の state index 移行完了を識別する sort key です。 */
export const NOTIFICATION_STATUS_MIGRATION_KEY = '!MIGRATION#STATUS-V1'

/** 未保存ユーザーへ返す notification preference です。 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = Object.freeze({
  version: 0,
  channels: Object.freeze({ inApp: true, email: false, push: false }),
  frequency: 'instant',
  quietHours: Object.freeze({
    enabled: false,
    start: '22:00',
    end: '07:00',
    timeZone: 'UTC',
  }),
})

const defaultPageLimit = 20
const maximumPageLimit = 50
const maximumQueryPages = 100
const notificationIdVersion = 1
const notificationCursorVersion = 1
const snoozeMaximumMilliseconds = 365 * 24 * 60 * 60 * 1_000

/** Opaque notification ID の署名対象 payload です。 */
type NotificationIdentifier = {
  /** Payload schema version です。 */
  version: 1
  /** ID を利用できる recipient partition です。 */
  recipientKey: string
  /** Notification row の sort key です。 */
  notificationKey: string
}

/** Opaque notification cursor の署名対象 payload です。 */
type NotificationCursor = {
  /** Payload schema version です。 */
  version: 1
  /** Cursor を利用できる recipient partition です。 */
  recipientKey: string
  /** Cursor を利用できる state filter です。 */
  filter: NotificationFilter
  /** Cursor を利用できる event type filter です。 */
  eventType?: string
  /** DynamoDB Query の再開 key です。 */
  lastEvaluatedKey: Record<string, unknown>
}

/** DynamoDB-backed durable notification store です。 */
export class DynamoDbNotificationsClient implements NotificationClient {
  /** Notification と preference を保存する table 名です。 */
  private readonly tableName: string
  /** State 別 query に使う GSI 名です。 */
  private readonly statusIndexName: string
  /** DynamoDB の document client です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Local table bootstrap に使う low-level client です。 */
  private readonly dynamoDbClient: DynamoDBClient
  /** Local endpoint で table を自動作成するかどうかです。 */
  private readonly bootstrapLocalTable: boolean
  /** 同一 process 内の local table 初期化処理です。 */
  private tableReady?: Promise<void>

  constructor(
    tableName = getConfiguredNotificationsTableName(),
    documentClient?: DynamoDBDocumentClient,
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTable = Boolean(getConfiguredDynamoDbEndpoint()),
    statusIndexName = process.env.NOTIFICATIONS_STATUS_INDEX_NAME?.trim() || 'RecipientStatusIndex',
  ) {
    const endpoint = getConfiguredDynamoDbEndpoint()
    this.tableName = requireText(tableName, 'Notifications table name')
    this.statusIndexName = requireText(statusIndexName, 'Notifications status index name')
    this.dynamoDbClient = dynamoDbClient ?? new DynamoDBClient({
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      ...(endpoint
        ? {
            endpoint,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
            },
          }
        : {}),
    })
    this.documentClient = documentClient ?? DynamoDBDocumentClient.from(this.dynamoDbClient, {
      marshallOptions: { removeUndefinedValues: true },
    })
    this.bootstrapLocalTable = bootstrapLocalTable
  }

  /** Recipient の notification timeline を取得します。 */
  async list(input: ListNotificationsInput): Promise<NotificationPage> {
    await this.ensureTable()
    const recipientKey = createNotificationRecipientKey(input.workspaceId, input.memberKey)
    const filter = normalizeNotificationFilter(input.filter)
    const eventType = normalizeOptionalText(input.eventType)
    const limit = normalizeLimit(input.limit)
    const now = normalizeDate(input.now ?? new Date(), 'Notification list time')
    await this.ensureLegacyRowsMigrated(recipientKey, now)
    await this.wakeExpiredSnoozes(recipientKey, now)
    let exclusiveStartKey = input.cursor
      ? decodeNotificationCursor(input.cursor, recipientKey, filter, eventType)
      : undefined
    const notifications: NotificationItem[] = []
    let pages = 0

    while (notifications.length < limit && pages < maximumQueryPages) {
      pages += 1
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        ...(filter === 'all'
          ? {
              KeyConditionExpression: 'recipientKey = :recipientKey',
              ExpressionAttributeValues: { ':recipientKey': recipientKey },
              ConsistentRead: true,
            }
          : {
              IndexName: this.statusIndexName,
              KeyConditionExpression: 'recipientStatusKey = :recipientStatusKey',
              ExpressionAttributeValues: {
                ':recipientStatusKey': createRecipientStatusKey(recipientKey, filter),
              },
            }),
        Limit: Math.max(1, limit - notifications.length),
        ScanIndexForward: false,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))

      for (const row of response.Items ?? []) {
        const notification = toNotificationItem(row, recipientKey, now)
        if (!notification || !matchesNotificationFilter(notification, filter, eventType)) {
          continue
        }
        if (input.isVisible && !await input.isVisible(notification)) {
          continue
        }
        notifications.push(notification)
      }

      exclusiveStartKey = response.LastEvaluatedKey
      if (!exclusiveStartKey) {
        break
      }
    }

    return {
      notifications,
      ...(exclusiveStartKey
        ? { nextCursor: encodeNotificationCursor(recipientKey, filter, eventType, exclusiveStartKey) }
        : {}),
    }
  }

  /** Recipient の現在表示可能な unread 件数を返します。 */
  async countUnread(input: CountUnreadNotificationsInput) {
    await this.ensureTable()
    const recipientKey = createNotificationRecipientKey(input.workspaceId, input.memberKey)
    const now = normalizeDate(input.now ?? new Date(), 'Notification count time')
    await this.ensureLegacyRowsMigrated(recipientKey, now)
    await this.wakeExpiredSnoozes(recipientKey, now)
    let exclusiveStartKey: Record<string, unknown> | undefined
    let count = 0

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: this.statusIndexName,
        KeyConditionExpression: 'recipientStatusKey = :recipientStatusKey',
        ExpressionAttributeValues: {
          ':recipientStatusKey': createRecipientStatusKey(recipientKey, 'unread'),
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const row of response.Items ?? []) {
        const notification = toNotificationItem(row, recipientKey, now)
        if (notification?.state !== 'unread') {
          continue
        }
        if (!input.isVisible || await input.isVisible(notification)) {
          count += 1
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return count
  }

  /** Notification state を version 条件付きで更新します。 */
  async update(input: UpdateNotificationInput) {
    await this.ensureTable()
    const recipientKey = createNotificationRecipientKey(input.workspaceId, input.memberKey)
    const now = normalizeDate(input.now ?? new Date(), 'Notification update time')
    await this.ensureLegacyRowsMigrated(recipientKey, now)
    return this.updateAfterMigration(input, recipientKey, now)
  }

  /** Migration 済み recipient の notification state を version 条件付きで更新します。 */
  private async updateAfterMigration(
    input: UpdateNotificationInput,
    recipientKey: string,
    now: Date,
  ) {
    const identifier = decodeNotificationIdentifier(input.notificationId, recipientKey)
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        recipientKey,
        notificationKey: identifier.notificationKey,
      },
      ConsistentRead: true,
    }))
    const current = toNotificationItem(response.Item, recipientKey, now)

    if (!response.Item || !current || (input.isVisible && !await input.isVisible(current))) {
      throw new NotificationError(404, 'NotificationNotFound', 'Notification was not found.')
    }

    const currentRow = { ...response.Item }
    if (current.projectId) {
      currentRow.projectId = current.projectId
    } else if (current.teamId && current.issueId) {
      delete currentRow.projectId
    }
    const nextRow = applyNotificationAction(currentRow, input, recipientKey, now)
    const currentVersion = readPositiveInteger(response.Item.version) ?? 1

    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: nextRow,
        ConditionExpression:
          'attribute_exists(recipientKey) AND attribute_exists(notificationKey) AND ' +
          '(#version = :version OR (attribute_not_exists(#version) AND :version = :legacyVersion))',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: {
          ':version': currentVersion,
          ':legacyVersion': 1,
        },
      }))
    } catch (error) {
      if (isAwsNamedError(error, 'ConditionalCheckFailedException')) {
        throw new NotificationError(
          409,
          'NotificationVersionConflict',
          'Notification changed before this action was saved.',
        )
      }
      throw error
    }

    const updated = toNotificationItem(nextRow, recipientKey, now)
    if (!updated) {
      throw new NotificationError(500, 'InvalidNotification', 'Notification state is invalid.')
    }
    return updated
  }

  /** 現在表示可能な unread notification をすべて read にします。 */
  async markAllRead(input: MarkAllNotificationsReadInput) {
    await this.ensureTable()
    const recipientKey = createNotificationRecipientKey(input.workspaceId, input.memberKey)
    const now = normalizeDate(input.now ?? new Date(), 'Notification mark-all-read time')
    await this.ensureLegacyRowsMigrated(recipientKey, now)
    await this.wakeExpiredSnoozes(recipientKey, now)
    let exclusiveStartKey: Record<string, unknown> | undefined
    const notificationIds: string[] = []

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: this.statusIndexName,
        KeyConditionExpression: 'recipientStatusKey = :recipientStatusKey',
        ExpressionAttributeValues: {
          ':recipientStatusKey': createRecipientStatusKey(recipientKey, 'unread'),
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const row of response.Items ?? []) {
        const notification = toNotificationItem(row, recipientKey, now)
        if (
          notification?.state === 'unread' &&
          (!input.isVisible || await input.isVisible(notification))
        ) {
          notificationIds.push(notification.id)
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    let updatedCount = 0
    for (const notificationId of notificationIds) {
      try {
        await this.updateAfterMigration({
          ...input,
          notificationId,
          action: 'mark-read',
        }, recipientKey, now)
        updatedCount += 1
      } catch (error) {
        if (!(error instanceof NotificationError && error.code === 'NotificationVersionConflict')) {
          throw error
        }
      }
    }
    return updatedCount
  }

  /** Recipient の保存済み preference または default を返します。 */
  async getPreferences(input: NotificationRecipientInput) {
    await this.ensureTable()
    const recipientKey = createNotificationRecipientKey(input.workspaceId, input.memberKey)
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { recipientKey, notificationKey: NOTIFICATION_PREFERENCES_KEY },
      ConsistentRead: true,
    }))
    return parseStoredNotificationPreferences(response.Item)
  }

  /** Recipient の preference を version 条件付きで保存します。 */
  async savePreferences(input: SaveNotificationPreferencesInput) {
    await this.ensureTable()
    const recipientKey = createNotificationRecipientKey(input.workspaceId, input.memberKey)
    const preferences = normalizeNotificationPreferencesInput(input.preferences)
    const now = normalizeDate(input.now ?? new Date(), 'Notification preference update time')
    const next: NotificationPreferences = {
      ...preferences,
      version: preferences.version + 1,
      updatedAt: now.toISOString(),
    }

    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          recipientKey,
          notificationKey: NOTIFICATION_PREFERENCES_KEY,
          itemType: 'preferences',
          ...next,
        },
        ...(preferences.version === 0
          ? {
              ConditionExpression:
                'attribute_not_exists(recipientKey) AND attribute_not_exists(notificationKey)',
            }
          : {
              ConditionExpression:
                'attribute_exists(recipientKey) AND attribute_exists(notificationKey) AND #version = :version',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':version': preferences.version },
            }),
      }))
    } catch (error) {
      if (isAwsNamedError(error, 'ConditionalCheckFailedException')) {
        const currentResponse = await this.documentClient.send(new GetCommand({
          TableName: this.tableName,
          Key: {
            recipientKey,
            notificationKey: NOTIFICATION_PREFERENCES_KEY,
          },
          ConsistentRead: true,
        }))
        const current = parseStoredNotificationPreferences(currentResponse.Item)
        if (
          current.version === preferences.version + 1 &&
          notificationPreferencesMatchUpdate(current, preferences)
        ) {
          return current
        }

        throw new NotificationError(
          409,
          'NotificationPreferencesConflict',
          'Notification preferences changed before this update was saved.',
        )
      }
      throw error
    }

    return next
  }

  private async ensureLegacyRowsMigrated(recipientKey: string, now: Date) {
    const marker = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        recipientKey,
        notificationKey: NOTIFICATION_STATUS_MIGRATION_KEY,
      },
      ConsistentRead: true,
    }))
    if (marker.Item) {
      return
    }

    let exclusiveStartKey: Record<string, unknown> | undefined
    let pages = 0

    do {
      pages += 1
      if (pages > maximumQueryPages) {
        throw new NotificationError(
          503,
          'NotificationMigrationLimitExceeded',
          'Notification state migration exceeded its bounded page limit.',
        )
      }
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'recipientKey = :recipientKey',
        ExpressionAttributeValues: { ':recipientKey': recipientKey },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))

      for (const row of response.Items ?? []) {
        if (readText(row.recipientStatusKey)) {
          continue
        }
        const notification = toNotificationItem(row, recipientKey, now)
        if (!notification) {
          continue
        }
        const legacyScope = readLegacyWorkItemScope(row)
        const next: Record<string, unknown> = {
          ...row,
          ...(legacyScope.teamId ? { teamId: legacyScope.teamId } : {}),
          ...(legacyScope.issueId ? { issueId: legacyScope.issueId } : {}),
          itemType: 'notification',
          inboxState: notification.state,
          recipientStatusKey: createRecipientStatusKey(recipientKey, notification.state),
          version: readPositiveInteger(row.version) ?? 1,
          updatedAt: readTimestamp(row.updatedAt) ?? now.toISOString(),
        }
        if (
          readTimestamp(next.snoozedUntil) &&
          Date.parse(String(next.snoozedUntil)) <= now.getTime()
        ) {
          delete next.snoozedUntil
        }

        try {
          await this.documentClient.send(new PutCommand({
            TableName: this.tableName,
            Item: next,
            ConditionExpression:
              'attribute_exists(recipientKey) AND attribute_exists(notificationKey) AND ' +
              'attribute_not_exists(recipientStatusKey)',
          }))
        } catch (error) {
          if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) {
            throw error
          }
        }
      }

      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    await this.documentClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        recipientKey,
        notificationKey: NOTIFICATION_STATUS_MIGRATION_KEY,
        itemType: 'migration',
        migratedAt: now.toISOString(),
        version: 1,
      },
    }))
  }

  private async wakeExpiredSnoozes(recipientKey: string, now: Date) {
    let exclusiveStartKey: Record<string, unknown> | undefined

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: this.statusIndexName,
        KeyConditionExpression: 'recipientStatusKey = :recipientStatusKey',
        ExpressionAttributeValues: {
          ':recipientStatusKey': createRecipientStatusKey(recipientKey, 'snoozed'),
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const row of response.Items ?? []) {
        const snoozedUntil = readTimestamp(row.snoozedUntil)
        if (!snoozedUntil || Date.parse(snoozedUntil) > now.getTime()) {
          continue
        }
        const next = { ...row }
        delete next.snoozedUntil
        const state: NotificationState = readTimestamp(next.readAt) ? 'read' : 'unread'
        next.inboxState = state
        next.recipientStatusKey = createRecipientStatusKey(recipientKey, state)
        next.version = (readPositiveInteger(row.version) ?? 1) + 1
        next.updatedAt = now.toISOString()
        try {
          await this.documentClient.send(new PutCommand({
            TableName: this.tableName,
            Item: next,
            ConditionExpression: '#version = :version',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':version': readPositiveInteger(row.version) ?? 1 },
          }))
        } catch (error) {
          if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) {
            throw error
          }
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
  }

  private async ensureTable() {
    if (!this.bootstrapLocalTable) {
      return
    }
    this.tableReady ??= this.ensureLocalTable()
    await this.tableReady
  }

  private async ensureLocalTable() {
    try {
      await this.dynamoDbClient.send(new DescribeTableCommand({ TableName: this.tableName }))
      return
    } catch (error) {
      if (!isAwsNamedError(error, 'ResourceNotFoundException')) {
        throw error
      }
    }

    try {
      await this.dynamoDbClient.send(new CreateTableCommand({
        TableName: this.tableName,
        AttributeDefinitions: [
          { AttributeName: 'recipientKey', AttributeType: 'S' },
          { AttributeName: 'notificationKey', AttributeType: 'S' },
          { AttributeName: 'recipientStatusKey', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'recipientKey', KeyType: 'HASH' },
          { AttributeName: 'notificationKey', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [{
          IndexName: this.statusIndexName,
          KeySchema: [
            { AttributeName: 'recipientStatusKey', KeyType: 'HASH' },
            { AttributeName: 'notificationKey', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }],
        BillingMode: 'PAY_PER_REQUEST',
      }))
    } catch (error) {
      if (!isAwsNamedError(error, 'ResourceInUseException')) {
        throw error
      }
    }

    await waitUntilTableExists(
      { client: this.dynamoDbClient, maxWaitTime: 30 },
      { TableName: this.tableName },
    )
  }
}

/** Process environment から Notifications table 名を解決します。 */
export function getConfiguredNotificationsTableName(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return environment.MUKUROJI_NOTIFICATIONS_TABLE?.trim() ||
    environment.NOTIFICATIONS_TABLE_NAME?.trim() ||
    'mukuroji-notifications-local'
}

/** Workspace/member を Notifications table の recipient partition key に変換します。 */
export function createNotificationRecipientKey(workspaceId: string, memberKey: string) {
  return `${requireText(workspaceId, 'Notification workspace ID')}#${normalizeMemberKey(memberKey)}`
}

/** 保存 row を安全な preference に変換し、invalid row は default へ戻します。 */
export function parseStoredNotificationPreferences(
  value: Record<string, unknown> | undefined,
): NotificationPreferences {
  if (!value || value.itemType !== 'preferences') {
    return cloneDefaultPreferences()
  }

  try {
    const normalized = normalizeNotificationPreferencesInput({
      version: readNonNegativeInteger(value.version) ?? 0,
      channels: value.channels as NotificationChannels,
      frequency: value.frequency as NotificationFrequency,
      quietHours: value.quietHours as NotificationQuietHours,
    })
    return {
      ...normalized,
      ...(readTimestamp(value.updatedAt) ? { updatedAt: readTimestamp(value.updatedAt) } : {}),
    }
  } catch {
    return cloneDefaultPreferences()
  }
}

/** Frequency と quiet hours から channel delivery plan を作成します。 */
export function createNotificationDeliveryPlan(
  preferences: NotificationPreferences,
  occurredAt: string,
): NotificationDeliveryPlan {
  const normalized = normalizeNotificationPreferencesInput(preferences)
  const occurredTime = Date.parse(requireText(occurredAt, 'Notification occurredAt'))
  if (!Number.isFinite(occurredTime)) {
    throw new TypeError('Notification occurredAt must be an ISO 8601 timestamp.')
  }
  const channels = (['inApp', 'email', 'push'] as const).filter(
    (channel) => normalized.channels[channel],
  )
  const frequencyDelay = normalized.frequency === 'hourly'
    ? 60 * 60 * 1_000
    : normalized.frequency === 'daily'
      ? 24 * 60 * 60 * 1_000
      : normalized.frequency === 'weekly'
        ? 7 * 24 * 60 * 60 * 1_000
        : 0
  let deliveryTime = new Date(occurredTime + frequencyDelay)

  if (normalized.quietHours.enabled) {
    for (let minute = 0; minute <= 48 * 60; minute += 1) {
      if (!isInsideQuietHours(deliveryTime, normalized.quietHours)) {
        break
      }
      deliveryTime = new Date(deliveryTime.getTime() + 60 * 1_000)
    }
  }

  return {
    channels,
    deliveryAfter: deliveryTime.toISOString(),
    frequency: normalized.frequency,
  }
}

function applyNotificationAction(
  row: Record<string, unknown>,
  input: UpdateNotificationInput,
  recipientKey: string,
  now: Date,
) {
  const next = { ...row }
  const timestamp = now.toISOString()
  const action = normalizeNotificationAction(input.action)

  if (action === 'mark-read') {
    next.readAt = timestamp
  } else if (action === 'mark-unread') {
    delete next.readAt
  } else if (action === 'archive') {
    next.archivedAt = timestamp
    delete next.snoozedUntil
  } else if (action === 'restore') {
    delete next.archivedAt
    delete next.snoozedUntil
  } else {
    const snoozedUntil = readTimestamp(input.snoozedUntil)
    if (!snoozedUntil) {
      throw new NotificationError(400, 'InvalidNotificationSnooze', 'A valid snooze time is required.')
    }
    const snoozeTime = Date.parse(snoozedUntil)
    if (snoozeTime <= now.getTime() || snoozeTime > now.getTime() + snoozeMaximumMilliseconds) {
      throw new NotificationError(
        400,
        'InvalidNotificationSnooze',
        'Snooze time must be in the next 365 days.',
      )
    }
    next.snoozedUntil = snoozedUntil
    delete next.archivedAt
  }

  const state = resolveNotificationState(next, now)
  next.itemType = 'notification'
  next.inboxState = state
  next.recipientStatusKey = createRecipientStatusKey(recipientKey, state)
  next.version = (readPositiveInteger(row.version) ?? 1) + 1
  next.updatedAt = timestamp
  return next
}

function toNotificationItem(
  value: Record<string, unknown> | undefined,
  recipientKey: string,
  now: Date,
): NotificationItem | undefined {
  if (
    !value ||
    value.recipientKey !== recipientKey ||
    value.itemType === 'preferences' ||
    value.inAppVisible === false
  ) {
    return undefined
  }
  const notificationKey = readText(value.notificationKey)
  const eventId = readText(value.eventId) ?? readText(value.notificationId)
  const eventType = readText(value.eventType)
  const occurredAt = readTimestamp(value.occurredAt) ?? notificationKey?.split('#')[0]
  if (!notificationKey || !eventId || !eventType || !occurredAt) {
    return undefined
  }
  const deepLink = readText(value.deepLink)
  return {
    id: encodeNotificationIdentifier(recipientKey, notificationKey),
    eventId,
    eventType,
    ...(readText(value.entityId) ? { entityId: readText(value.entityId) } : {}),
    reasons: readStringArray(value.reasons),
    ...(readText(value.actorLabel) ?? readText(value.actorMemberKey) ?? readText(value.actorUserId)
      ? { actorLabel: readText(value.actorLabel) ?? readText(value.actorMemberKey) ?? readText(value.actorUserId) }
      : {}),
    ...(readText(value.title) ? { title: readText(value.title) } : {}),
    ...(readText(value.summary) ? { summary: readText(value.summary) } : {}),
    ...(deepLink?.startsWith('/') && !deepLink.startsWith('//') ? { deepLink } : {}),
    ...(readText(value.teamId) ? { teamId: readText(value.teamId) } : {}),
    ...(readText(value.projectId) ? { projectId: readText(value.projectId) } : {}),
    ...(readText(value.issueId) ? { issueId: readText(value.issueId) } : {}),
    ...(readText(value.commentId) ? { commentId: readText(value.commentId) } : {}),
    ...(readText(value.rootCommentId) ? { rootCommentId: readText(value.rootCommentId) } : {}),
    ...(readPlanningTargetType(value.planningTargetType)
      ? { planningTargetType: readPlanningTargetType(value.planningTargetType) }
      : {}),
    ...(readText(value.planningTargetId)
      ? { planningTargetId: readText(value.planningTargetId) }
      : {}),
    ...(readText(value.planningTargetRecordKey)
      ? { planningTargetRecordKey: readText(value.planningTargetRecordKey) }
      : {}),
    ...(readTimestamp(value.planningNextDueAt)
      ? { planningNextDueAt: readTimestamp(value.planningNextDueAt) }
      : {}),
    ...(readPlanningNotificationKind(value.planningNotificationKind)
      ? { planningNotificationKind: readPlanningNotificationKind(value.planningNotificationKind) }
      : {}),
    occurredAt,
    state: resolveNotificationState(value, now),
    ...(readTimestamp(value.readAt) ? { readAt: readTimestamp(value.readAt) } : {}),
    ...(readTimestamp(value.archivedAt) ? { archivedAt: readTimestamp(value.archivedAt) } : {}),
    ...(readTimestamp(value.snoozedUntil) ? { snoozedUntil: readTimestamp(value.snoozedUntil) } : {}),
  }
}

function matchesNotificationFilter(
  notification: NotificationItem,
  filter: NotificationFilter,
  eventType: string | undefined,
) {
  if (filter === 'all' && (notification.state === 'archived' || notification.state === 'snoozed')) {
    return false
  }
  return (filter === 'all' || notification.state === filter) &&
    (!eventType || notification.eventType === eventType)
}

function resolveNotificationState(row: Record<string, unknown>, now: Date): NotificationState {
  if (readTimestamp(row.archivedAt)) {
    return 'archived'
  }
  const snoozedUntil = readTimestamp(row.snoozedUntil)
  if (snoozedUntil && Date.parse(snoozedUntil) > now.getTime()) {
    return 'snoozed'
  }
  return readTimestamp(row.readAt) ? 'read' : 'unread'
}

function normalizeNotificationPreferencesInput(
  value: UpdateNotificationPreferencesInput | NotificationPreferences,
): UpdateNotificationPreferencesInput {
  const version = readNonNegativeInteger(value.version)
  if (version === undefined) {
    throw new NotificationError(400, 'InvalidNotificationPreferences', 'Preference version is invalid.')
  }
  const channels = value.channels
  if (
    !channels ||
    typeof channels.inApp !== 'boolean' ||
    typeof channels.email !== 'boolean' ||
    typeof channels.push !== 'boolean'
  ) {
    throw new NotificationError(400, 'InvalidNotificationPreferences', 'Notification channels are invalid.')
  }
  if (!['instant', 'hourly', 'daily', 'weekly'].includes(value.frequency)) {
    throw new NotificationError(400, 'InvalidNotificationPreferences', 'Notification frequency is invalid.')
  }
  const quietHours = value.quietHours
  if (
    !quietHours ||
    typeof quietHours.enabled !== 'boolean' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(quietHours.start) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(quietHours.end) ||
    !isValidTimeZone(quietHours.timeZone)
  ) {
    throw new NotificationError(400, 'InvalidNotificationPreferences', 'Quiet hours are invalid.')
  }
  return {
    version,
    channels: { ...channels },
    frequency: value.frequency,
    quietHours: { ...quietHours },
  }
}

function notificationPreferencesMatchUpdate(
  current: NotificationPreferences,
  expected: UpdateNotificationPreferencesInput,
) {
  return current.channels.inApp === expected.channels.inApp &&
    current.channels.email === expected.channels.email &&
    current.channels.push === expected.channels.push &&
    current.frequency === expected.frequency &&
    current.quietHours.enabled === expected.quietHours.enabled &&
    current.quietHours.start === expected.quietHours.start &&
    current.quietHours.end === expected.quietHours.end &&
    current.quietHours.timeZone === expected.quietHours.timeZone
}

function isInsideQuietHours(date: Date, quietHours: NotificationQuietHours) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: quietHours.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  const current = hour * 60 + minute
  const start = toMinuteOfDay(quietHours.start)
  const end = toMinuteOfDay(quietHours.end)
  if (start === end) {
    return false
  }
  return start < end ? current >= start && current < end : current >= start || current < end
}

function toMinuteOfDay(value: string) {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function isValidTimeZone(value: unknown) {
  if (!readText(value)) {
    return false
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: String(value) }).format()
    return true
  } catch {
    return false
  }
}

function normalizeNotificationFilter(value: NotificationFilter | undefined): NotificationFilter {
  if (value === undefined) {
    return 'all'
  }
  if (!['all', 'unread', 'read', 'archived', 'snoozed'].includes(value)) {
    throw new NotificationError(400, 'InvalidNotificationFilter', 'Notification filter is invalid.')
  }
  return value
}

function normalizeNotificationAction(value: NotificationAction) {
  if (!['mark-read', 'mark-unread', 'archive', 'restore', 'snooze'].includes(value)) {
    throw new NotificationError(400, 'InvalidNotificationAction', 'Notification action is invalid.')
  }
  return value
}

function normalizeLimit(value: number | undefined) {
  const limit = value ?? defaultPageLimit
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximumPageLimit) {
    throw new NotificationError(
      400,
      'InvalidNotificationLimit',
      `Notification limit must be between 1 and ${maximumPageLimit}.`,
    )
  }
  return limit
}

function encodeNotificationIdentifier(recipientKey: string, notificationKey: string) {
  return encodeOpaque({
    version: notificationIdVersion,
    recipientKey,
    notificationKey,
  } satisfies NotificationIdentifier)
}

function decodeNotificationIdentifier(value: string, recipientKey: string) {
  try {
    const decoded = decodeOpaque(value) as Partial<NotificationIdentifier>
    if (
      decoded.version !== notificationIdVersion ||
      decoded.recipientKey !== recipientKey ||
      !readText(decoded.notificationKey)
    ) {
      throw new Error('Invalid notification identifier')
    }
    return decoded as NotificationIdentifier
  } catch {
    throw new NotificationError(400, 'InvalidNotificationId', 'Notification ID is invalid.')
  }
}

function encodeNotificationCursor(
  recipientKey: string,
  filter: NotificationFilter,
  eventType: string | undefined,
  lastEvaluatedKey: Record<string, unknown>,
) {
  return encodeOpaque({
    version: notificationCursorVersion,
    recipientKey,
    filter,
    ...(eventType ? { eventType } : {}),
    lastEvaluatedKey,
  } satisfies NotificationCursor)
}

function decodeNotificationCursor(
  value: string,
  recipientKey: string,
  filter: NotificationFilter,
  eventType: string | undefined,
) {
  try {
    const decoded = decodeOpaque(value) as Partial<NotificationCursor>
    if (
      decoded.version !== notificationCursorVersion ||
      decoded.recipientKey !== recipientKey ||
      decoded.filter !== filter ||
      decoded.eventType !== eventType ||
      !isRecord(decoded.lastEvaluatedKey)
    ) {
      throw new Error('Invalid notification cursor')
    }
    return decoded.lastEvaluatedKey
  } catch {
    throw new NotificationError(400, 'InvalidNotificationCursor', 'Notification cursor is invalid.')
  }
}

function encodeOpaque(value: unknown) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeOpaque(value: string) {
  return JSON.parse(Buffer.from(requireText(value, 'Opaque value'), 'base64url').toString('utf8')) as unknown
}

function createRecipientStatusKey(recipientKey: string, state: NotificationState) {
  return `${recipientKey}#${state}`
}

function normalizeMemberKey(value: string) {
  return requireText(value, 'Notification member key').toLowerCase()
}

function normalizeDate(value: Date, label: string) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${label} must be a valid date.`)
  }
  return new Date(value.getTime())
}

function cloneDefaultPreferences(): NotificationPreferences {
  return {
    version: DEFAULT_NOTIFICATION_PREFERENCES.version,
    channels: { ...DEFAULT_NOTIFICATION_PREFERENCES.channels },
    frequency: DEFAULT_NOTIFICATION_PREFERENCES.frequency,
    quietHours: { ...DEFAULT_NOTIFICATION_PREFERENCES.quietHours },
  }
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map(readText).filter((item): item is string => Boolean(item)))].sort()
    : []
}

/** Reads a validated Planning health update target type. */
function readPlanningTargetType(value: unknown): 'project' | 'initiative' | undefined {
  return value === 'project' || value === 'initiative' ? value : undefined
}

/** Reads a validated Planning health update notification kind. */
function readPlanningNotificationKind(
  value: unknown,
): 'reminder' | 'overdue' | 'escalation' | undefined {
  return value === 'reminder' || value === 'overdue' || value === 'escalation'
    ? value
    : undefined
}

function readLegacyWorkItemScope(value: Record<string, unknown>) {
  const storedTeamId = readText(value.teamId)
  const storedIssueId = readText(value.issueId)
  if (storedTeamId && storedIssueId) {
    return { teamId: storedTeamId, issueId: storedIssueId }
  }

  const match = readText(value.entityId)?.match(/^team\/([^/]+)\/issue\/([^/]+)$/)
  if (!match?.[1] || !match[2]) {
    return {
      ...(storedTeamId ? { teamId: storedTeamId } : {}),
      ...(storedIssueId ? { issueId: storedIssueId } : {}),
    }
  }
  const entityTeamId = decodePathSegment(match[1])
  const entityIssueId = decodePathSegment(match[2])
  if (!entityTeamId || !entityIssueId || (storedTeamId && storedTeamId !== entityTeamId)) {
    return {
      ...(storedTeamId ? { teamId: storedTeamId } : {}),
      ...(storedIssueId ? { issueId: storedIssueId } : {}),
    }
  }

  return {
    teamId: storedTeamId ?? entityTeamId,
    issueId: storedIssueId ?? entityIssueId,
  }
}

function decodePathSegment(value: string) {
  try {
    return readText(decodeURIComponent(value))
  } catch {
    return undefined
  }
}

function readTimestamp(value: unknown) {
  const text = readText(value)
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : undefined
}

function readPositiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

function readNonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function readText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeOptionalText(value: unknown) {
  return readText(value)
}

function requireText(value: unknown, label: string) {
  const text = readText(value)
  if (!text) {
    throw new TypeError(`${label} is required.`)
  }
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isAwsNamedError(error: unknown, name: string) {
  return error instanceof Error && error.name === name
}
