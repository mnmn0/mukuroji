import { createHash } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createMutationAuditContext,
  getConfiguredDynamoDbEndpoint,
} from './audit'

/** 期限通知 schedule が生成する通知理由です。 */
export type ScheduledNotificationReason = 'due' | 'overdue'

/** EventBridge scheduled event から利用する最小入力です。 */
export type NotificationScheduleEvent = {
  /** EventBridge event ID です。 */
  id?: string
  /** EventBridge が schedule を発火した ISO 8601 timestamp です。 */
  time?: string
}

/** Notification schedule から利用する DynamoDB DocumentClient です。 */
export type NotificationScheduleDocumentClient = Pick<DynamoDBDocumentClient, 'send'>

/** 期限通知 schedule の実行設定です。 */
export type NotificationScheduleRunOptions = {
  /** Work Item scan と audit event put に使う DocumentClient です。 */
  documentClient: NotificationScheduleDocumentClient
  /** canonical Work Items table 名です。 */
  workItemsTableName: string
  /** schema-v1 event を保存する AuditEvents table 名です。 */
  auditEventsTableName: string
  /** UTC date-only の判定基準と event 発生時刻です。 */
  now: Date
  /** 一度の DynamoDB Scan で評価する最大 item 数です。 */
  scanPageSize?: number
  /** 一度の invocation で読み取る最大 page 数です。 */
  maxScanPages?: number
  /** Audit event を保持する日数です。 */
  auditRetentionDays?: number
  /** EventBridge event ID などの schedule 実行 ID です。 */
  requestId?: string
}

/** 期限通知 schedule の完了結果です。 */
export type NotificationScheduleResult = {
  /** DynamoDB が scan で評価した item 数です。 */
  scannedItems: number
  /** AuditEvents table へ新規保存した event 数です。 */
  emittedEvents: number
  /** 再実行時に既存 event として重複排除した件数です。 */
  duplicateEvents: number
  /** malformed、完了済み、未来期限などで通知しなかった item 数です。 */
  skippedItems: number
  /** 読み終えた DynamoDB scan page 数です。 */
  scannedPages: number
}

/** Work Item から正規化した期限通知 candidate です。 */
type ScheduledNotificationCandidate = {
  /** Work Item が属する Workspace ID です。 */
  workspaceId: string
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** canonical Work Item ID です。 */
  issueId: string
  /** 現在の担当 Workspace member key です。 */
  assigneeMemberKey: string
  /** 現在割り当てられている Project ID です。 */
  projectId?: string
  /** Inbox で表示する Work Item title です。 */
  title: string
  /** `YYYY-MM-DD` に正規化した期限です。 */
  dueDate: string
  /** schedule が生成する notification reason です。 */
  reason: ScheduledNotificationReason
}

const scheduleActorId = 'system:notification-schedule'
const scheduleActorMemberKey = 'system'
const defaultScanPageSize = 100
const defaultMaxScanPages = 1_000
const defaultAuditRetentionDays = 2_555

const configuredDynamoDbEndpoint = getConfiguredDynamoDbEndpoint()
const dynamoDbClient = new DynamoDBClient({
  region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  ...(configuredDynamoDbEndpoint ? { endpoint: configuredDynamoDbEndpoint } : {}),
})
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})

/**
 * Canonical Work Items を走査し、当日期限と期限超過を immutable audit/outbox event にします。
 */
export async function handler(
  event: NotificationScheduleEvent = {},
): Promise<NotificationScheduleResult> {
  return runNotificationSchedule({
    documentClient,
    workItemsTableName: requireEnvironment(
      'WORK_ITEMS_TABLE_NAME',
      'MUKUROJI_WORK_ITEMS_TABLE',
      'TEAM_ISSUES_TABLE_NAME',
      'MUKUROJI_TEAM_ISSUES_TABLE',
    ),
    auditEventsTableName: requireEnvironment(
      'AUDIT_EVENTS_TABLE_NAME',
      'MUKUROJI_AUDIT_EVENTS_TABLE',
    ),
    now: readScheduleTime(event.time),
    scanPageSize: readPositiveIntegerEnvironment(
      'NOTIFICATION_SCHEDULE_SCAN_PAGE_SIZE',
      defaultScanPageSize,
    ),
    maxScanPages: readPositiveIntegerEnvironment(
      'NOTIFICATION_SCHEDULE_MAX_PAGES',
      defaultMaxScanPages,
    ),
    auditRetentionDays: readPositiveIntegerEnvironment(
      'AUDIT_RETENTION_DAYS',
      defaultAuditRetentionDays,
      'MUKUROJI_AUDIT_RETENTION_DAYS',
    ),
    ...(readText(event.id) ? { requestId: readText(event.id) } : {}),
  })
}

/**
 * 注入された DocumentClient で期限通知 schedule を最後の scan page まで実行します。
 */
export async function runNotificationSchedule(
  options: NotificationScheduleRunOptions,
): Promise<NotificationScheduleResult> {
  const workItemsTableName = requireText(options.workItemsTableName, 'Work Items table name')
  const auditEventsTableName = requireText(options.auditEventsTableName, 'Audit Events table name')
  const now = normalizeDate(options.now, 'Notification schedule time')
  const today = now.toISOString().slice(0, 10)
  const scanPageSize = normalizePositiveInteger(
    options.scanPageSize ?? defaultScanPageSize,
    'Notification schedule scan page size',
    1_000,
  )
  const maxScanPages = normalizePositiveInteger(
    options.maxScanPages ?? defaultMaxScanPages,
    'Notification schedule maximum scan pages',
    10_000,
  )
  const auditRetentionDays = normalizePositiveInteger(
    options.auditRetentionDays ?? defaultAuditRetentionDays,
    'Audit retention days',
    100_000,
  )
  const result: NotificationScheduleResult = {
    scannedItems: 0,
    emittedEvents: 0,
    duplicateEvents: 0,
    skippedItems: 0,
    scannedPages: 0,
  }
  let exclusiveStartKey: Record<string, unknown> | undefined

  do {
    if (result.scannedPages >= maxScanPages) {
      throw new Error(
        `Notification schedule exceeded the configured ${maxScanPages} scan page limit.`,
      )
    }

    const response = await options.documentClient.send(new ScanCommand({
      TableName: workItemsTableName,
      ConsistentRead: true,
      Limit: scanPageSize,
      ProjectionExpression: [
        '#directoryId',
        '#teamId',
        '#issueId',
        '#title',
        '#titleKey',
        '#assigneeUserId',
        '#status',
        '#dueDate',
        '#assignedProjectId',
      ].join(', '),
      FilterExpression:
        'attribute_exists(#assigneeUserId) AND attribute_exists(#dueDate) AND #status <> :done',
      ExpressionAttributeNames: {
        '#directoryId': 'directoryId',
        '#teamId': 'teamId',
        '#issueId': 'issueId',
        '#title': 'title',
        '#titleKey': 'titleKey',
        '#assigneeUserId': 'assigneeUserId',
        '#status': 'status',
        '#dueDate': 'dueDate',
        '#assignedProjectId': 'assignedProjectId',
      },
      ExpressionAttributeValues: { ':done': 'done' },
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }))

    result.scannedPages += 1
    result.scannedItems += response.ScannedCount ?? response.Items?.length ?? 0

    for (const item of response.Items ?? []) {
      const candidate = createScheduledNotificationCandidate(item, today)

      if (!candidate) {
        result.skippedItems += 1
        continue
      }

      const auditEvent = createScheduledNotificationAuditEvent(
        candidate,
        now,
        auditRetentionDays,
        options.requestId,
      )

      try {
        await options.documentClient.send(new PutCommand({
          TableName: auditEventsTableName,
          Item: auditEvent,
          ConditionExpression:
            'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)',
          ExpressionAttributeNames: {
            '#directoryId': 'directoryId',
            '#eventId': 'eventId',
          },
        }))
        result.emittedEvents += 1
      } catch (error) {
        if (isAwsNamedError(error, 'ConditionalCheckFailedException')) {
          result.duplicateEvents += 1
          continue
        }

        throw error
      }
    }

    exclusiveStartKey = response.LastEvaluatedKey
  } while (exclusiveStartKey)

  return result
}

/**
 * `YYYY/MM/DD` または `YYYY-MM-DD` を UTC の ISO date-only へ正規化します。
 */
export function parseUtcDateOnly(value: unknown): string | undefined {
  const text = readText(value)
  const match = text?.match(/^(\d{4})([-/])(\d{2})\2(\d{2})$/)

  if (!match) {
    return undefined
  }

  const year = Number(match[1])
  const month = Number(match[3])
  const day = Number(match[4])

  if (year < 1_000 || month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined
  }

  const date = new Date(Date.UTC(year, month - 1, day))

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined
  }

  return `${match[1]}-${match[3]}-${match[4]}`
}

function createScheduledNotificationCandidate(
  item: Record<string, unknown>,
  today: string,
): ScheduledNotificationCandidate | undefined {
  const workspaceId = readText(item.directoryId)
  const teamId = readText(item.teamId)
  const issueId = readText(item.issueId)
  const assigneeMemberKey = readText(item.assigneeUserId)?.toLowerCase()
  const status = readText(item.status)
  const dueDate = parseUtcDateOnly(item.dueDate)

  if (
    !workspaceId ||
    !teamId ||
    !issueId ||
    !assigneeMemberKey ||
    !status ||
    status === 'done' ||
    !dueDate ||
    dueDate > today
  ) {
    return undefined
  }

  return {
    workspaceId,
    teamId,
    issueId,
    assigneeMemberKey,
    ...(readText(item.assignedProjectId)
      ? { projectId: readText(item.assignedProjectId) }
      : {}),
    title: readText(item.title) ?? readText(item.titleKey) ?? issueId,
    dueDate,
    reason: dueDate === today ? 'due' : 'overdue',
  }
}

function createScheduledNotificationAuditEvent(
  candidate: ScheduledNotificationCandidate,
  now: Date,
  auditRetentionDays: number,
  requestId?: string,
) {
  const entityId = `team/${candidate.teamId}/issue/${candidate.issueId}`
  const occurredAt = now.toISOString()
  const idempotencyDigest = createHash('sha256').update([
    candidate.workspaceId,
    entityId,
    candidate.dueDate,
    candidate.reason,
    candidate.assigneeMemberKey,
  ].join('\0')).digest('hex')
  const idempotencyKey = `notification-schedule-v1:${idempotencyDigest}`
  const context = createMutationAuditContext({
    workspaceId: candidate.workspaceId,
    actor: {
      id: scheduleActorId,
      kind: 'system',
      displayName: 'Mukuroji notification schedule',
    },
    idempotencyKey,
    occurredAt,
    request: {
      method: 'SCHEDULE',
      path: '/internal/notification-schedule',
      body: {
        entityId,
        dueDate: candidate.dueDate,
        reason: candidate.reason,
      },
    },
    source: {
      kind: 'system',
      method: 'SCHEDULE',
      route: '/internal/notification-schedule',
      ...(requestId ? { requestId } : {}),
    },
  })
  const search = new URLSearchParams({ issueId: candidate.issueId })
  const deepLink = `/teams/${encodeURIComponent(candidate.teamId)}/issues?${search.toString()}`

  return createAuditEvent({
    context,
    eventType: `work-item.${candidate.reason}`,
    entity: { type: 'work-item', id: entityId },
    action: candidate.reason,
    changes: [],
    summary: candidate.reason === 'due'
      ? `Work Item "${candidate.title}" is due today.`
      : `Work Item "${candidate.title}" is overdue.`,
    metadata: {
      actorMemberKey: scheduleActorMemberKey,
      teamId: candidate.teamId,
      issueId: candidate.issueId,
      ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
      deepLink,
      title: candidate.title,
      dueDate: candidate.dueDate,
      notificationCandidates: [{
        memberKey: candidate.assigneeMemberKey,
        reason: candidate.reason,
      }],
    },
    expiresAt: calculateAuditExpiresAt(occurredAt, auditRetentionDays),
    outboxStatus: 'pending',
  })
}

function readScheduleTime(value: string | undefined) {
  if (!value) {
    return new Date()
  }

  return normalizeDate(new Date(value), 'Notification schedule event time')
}

function normalizeDate(value: Date, label: string) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${label} must be a valid date.`)
  }

  return new Date(value.getTime())
}

function requireEnvironment(...names: string[]) {
  for (const name of names) {
    const value = readText(process.env[name])

    if (value) {
      return value
    }
  }

  throw new Error(`${names.join(' or ')} is required.`)
}

function readPositiveIntegerEnvironment(
  name: string,
  fallback: number,
  alternateName?: string,
) {
  const configured = process.env[alternateName ?? name] ?? process.env[name]

  if (configured === undefined) {
    return fallback
  }

  return normalizePositiveInteger(Number(configured), name, 100_000)
}

function normalizePositiveInteger(value: number, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}.`)
  }

  return value
}

function requireText(value: unknown, label: string) {
  const text = readText(value)

  if (!text) {
    throw new TypeError(`${label} is required.`)
  }

  return text
}

function readText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isAwsNamedError(error: unknown, name: string) {
  return error instanceof Error && error.name === name
}
