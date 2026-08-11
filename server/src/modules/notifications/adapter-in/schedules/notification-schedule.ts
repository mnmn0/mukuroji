import { createHash } from 'node:crypto'
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { WORK_ITEM_SCHEDULE_MIN_YEAR } from '@mukuroji/contracts'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createMutationAuditContext,
} from '../../../audit'
import {
  createPlanningUpdateNextNotificationAtRecordKey,
  createPlanningUpdateNotificationAtRecordKey,
  createPlanningUpdateScheduleShard,
  createPlanningUpdateScheduleShardName,
  createPlanningUpdateScheduleUpperBound,
  PLANNING_UPDATE_SCHEDULE_DUE_INDEX_NAME,
  PLANNING_UPDATE_SCHEDULE_SHARD_COUNT,
} from '../../../planning'
import { createPlanningUpdatePublicTargetKey } from '../../../collaboration'
import {
  isCanonicalWorkItemRecord,
  workItemScheduleInstantToLocalDate,
} from '../../../work-items'

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
  /** Canonical source reads と audit event put に使う DocumentClient です。 */
  documentClient: NotificationScheduleDocumentClient
  /** canonical Work Items table 名です。 */
  workItemsTableName: string
  /** Planning update target を due-index query / strong-read する table 名です。 */
  planningTableName?: string
  /** Planning update target の sparse due query に使う GSI 名です。 */
  planningUpdateScheduleIndexName?: string
  /** Project target の current archive state を解決する directory table 名です。 */
  projectDirectoryTableName?: string
  /** schema-v1 event を保存する AuditEvents table 名です。 */
  auditEventsTableName: string
  /** Schedule timezone ごとの日付判定基準となる event 発生時刻です。 */
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
  /** Future deadline、archive、unrelated row など通知対象外だった item 数です。 */
  skippedItems: number
  /** Work Item scan と Planning due-index query で読み終えた page の合計です。 */
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

/** Planning health update の scheduled notification kind です。 */
export type PlanningScheduledNotificationKind = 'reminder' | 'overdue' | 'escalation'

/** Planning health update target の canonical target reference です。 */
export type PlanningUpdateTargetReference =
  | {
    /** Directory Project target です。 */
    type: 'project'
    /** Project を所有する Team ID です。 */
    teamId: string
    /** Canonical Project ID です。 */
    projectId: string
  }
  | {
    /** Planning Initiative target です。 */
    type: 'initiative'
    /** Canonical Planning entity ID です。 */
    entityId: string
  }

/** Planning health update cadence の persisted projection です。 */
export type PlanningUpdateNotificationCadence = {
  /** Update を提出する current Workspace member key です。 */
  updateOwnerMemberKey: string
  /** Cadence unit です。 */
  unit: 'week' | 'month'
  /** Cadence unit ごとの positive interval です。 */
  count: number
  /** Cadence の IANA timezone です。 */
  timeZone: string
  /** Current occurrence の absolute UTC deadline です。 */
  nextDueAt: string
  /** Deadline より何時間前に reminder を発行するかです。 */
  reminderHoursBefore: number
  /** Deadline より何時間後に escalation を発行するかです。 */
  escalationHoursAfter?: number
  /** Escalation の current Workspace member recipient です。 */
  escalationMemberKey?: string
}

/** PlanningTable の canonical update target schedule projection です。 */
export type PlanningUpdateTargetScheduleProjection = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Project または Initiative target です。 */
  target: PlanningUpdateTargetReference
  /** Active cadence。Cadence 未設定 target では省略します。 */
  cadence?: PlanningUpdateNotificationCadence
  /** Latest immutable update version です。 */
  latestVersion: number
  /** Target が通知対象外になった日時です。 */
  archivedAt?: string
  /** Target projection の最終更新日時です。 */
  updatedAt: string
}

/** Physical PlanningTable row used by the schedule adapter after validation. */
type PlanningUpdateTargetScheduleRecord = PlanningUpdateTargetScheduleProjection & {
  /** Physical DynamoDB row key. */
  recordKey: string
  /** Opaque key for the next notification stage, when persisted. */
  nextNotificationAtRecordKey?: string
}

/** Planning update schedule から生成する一つの notification candidate です。 */
type PlanningScheduledNotificationCandidate = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Strong re-read に使う update target record key です。 */
  targetRecordKey: string
  /** Project または Initiative target です。 */
  target: PlanningUpdateTargetReference
  /** Current cadence occurrence deadline です。 */
  nextDueAt: string
  /** Reminder、overdue、または escalation です。 */
  kind: PlanningScheduledNotificationKind
  /** Current notification recipient member key です。 */
  recipientMemberKey: string
  /** Current authorization scope の Team ID です。 */
  teamId?: string
  /** Current authorization scope の Project ID です。 */
  projectId?: string
}

/** Current Project / Initiative scope の canonical lookup result です。 */
type PlanningScheduledTargetScope = {
  /** Target が current source-of-truth 上で active かどうかです。 */
  active: boolean
  /** Current Team scope です。 */
  teamId?: string
  /** Current Project scope です。 */
  projectId?: string
}

const scheduleActorId = 'system:notification-schedule'
const scheduleActorMemberKey = 'system'
const defaultScanPageSize = 100
const defaultMaxScanPages = 1_000
const defaultAuditRetentionDays = 2_555
const maximumPlanningNotificationOffsetHours = 24 * 365

/**
 * 注入された client に束縛された EventBridge schedule adapter を作成します。
 */
export function createNotificationScheduleHandler(
  documentClient: NotificationScheduleDocumentClient,
) {
  return async (
    event: NotificationScheduleEvent = {},
  ): Promise<NotificationScheduleResult> =>
    runNotificationSchedule({
      documentClient,
      workItemsTableName: requireEnvironment(
        'WORK_ITEMS_TABLE_NAME',
        'MUKUROJI_WORK_ITEMS_TABLE',
        'TEAM_ISSUES_TABLE_NAME',
        'MUKUROJI_TEAM_ISSUES_TABLE',
      ),
      planningTableName: requireEnvironment('PLANNING_TABLE_NAME'),
      planningUpdateScheduleIndexName: requireEnvironment(
        'PLANNING_UPDATE_SCHEDULE_INDEX_NAME',
      ),
      projectDirectoryTableName: requireEnvironment('PROJECT_DIRECTORY_TABLE_NAME'),
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
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }))

    result.scannedPages += 1
    result.scannedItems += response.ScannedCount ?? response.Items?.length ?? 0

    for (const item of response.Items ?? []) {
      const candidate = createScheduledNotificationCandidate(item, now)

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

  if (options.planningTableName) {
    await queryDuePlanningUpdateTargets({
      options,
      auditEventsTableName,
      auditRetentionDays,
      maxScanPages,
      now,
      planningTableName: requireText(options.planningTableName, 'Planning table name'),
      scheduleIndexName: requireText(
        options.planningUpdateScheduleIndexName ?? PLANNING_UPDATE_SCHEDULE_DUE_INDEX_NAME,
        'Planning update schedule index name',
      ),
      result,
      scanPageSize,
    })
  }

  return result
}

/** Planning update target due-index query の正規化済み実行入力です。 */
type PlanningUpdateTargetQueryInput = {
  /** Caller's schedule options です。 */
  options: NotificationScheduleRunOptions
  /** Audit outbox table 名です。 */
  auditEventsTableName: string
  /** Audit event retention 日数です。 */
  auditRetentionDays: number
  /** Planning due-index query に適用する page 上限です。 */
  maxScanPages: number
  /** Schedule execution instant です。 */
  now: Date
  /** Canonical Planning table 名です。 */
  planningTableName: string
  /** Sparse Planning update schedule GSI 名です。 */
  scheduleIndexName: string
  /** 呼び出し元と共有する result accumulator です。 */
  result: NotificationScheduleResult
  /** 一度の Planning query page の item 上限です。 */
  scanPageSize: number
}

/**
 * Queries sparse Planning update due-index shards and emits deterministic notification events.
 *
 * Every projected key is strongly re-read from the base table before cadence, recipient,
 * archive state, and canonical target scope are evaluated. This makes an eventually
 * consistent stale GSI entry a safe no-op while keeping immutable history out of the scan path.
 *
 * @param input - Normalized Planning query input and shared result accumulator.
 */
async function queryDuePlanningUpdateTargets(
  input: PlanningUpdateTargetQueryInput,
): Promise<void> {
  const scopeCache = new Map<string, Promise<PlanningScheduledTargetScope>>()
  const activeProjectsByWorkspace = new Map<string, Promise<ReadonlySet<string>>>()
  const upperBound = createPlanningUpdateScheduleUpperBound(input.now.toISOString())
  let queriedPages = 0

  for (let shardIndex = 0; shardIndex < PLANNING_UPDATE_SCHEDULE_SHARD_COUNT; shardIndex += 1) {
    const scheduleShard = createPlanningUpdateScheduleShardName(shardIndex)
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      if (queriedPages >= input.maxScanPages) {
        throw new Error(
          `Notification schedule exceeded the configured ${input.maxScanPages} Planning query page limit.`,
        )
      }
      const response = await input.options.documentClient.send(new QueryCommand({
        TableName: input.planningTableName,
        IndexName: input.scheduleIndexName,
        KeyConditionExpression:
          'updateScheduleShard = :scheduleShard AND nextNotificationAtRecordKey <= :upperBound',
        ExpressionAttributeValues: {
          ':scheduleShard': scheduleShard,
          ':upperBound': upperBound,
        },
        Limit: input.scanPageSize,
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      queriedPages += 1
      input.result.scannedPages += 1
      input.result.scannedItems += response.ScannedCount ?? response.Items?.length ?? 0

      for (const indexedItem of response.Items ?? []) {
        let record: PlanningUpdateTargetScheduleRecord | undefined
        let candidates: PlanningScheduledNotificationCandidate[] = []
        try {
          record = await readCurrentPlanningUpdateTargetFromDueIndex(
            input,
            indexedItem,
            scheduleShard,
            upperBound,
          )
          candidates = record
            ? createPlanningScheduledNotificationCandidates(record, input.now)
            : []
        } catch (error) {
          if (!(error instanceof TypeError)) throw error
          console.error('Planning update schedule row is invalid.', {
            requestId: input.options.requestId,
            scheduleShard,
          })
          throw new Error('Planning update schedule row is invalid.', { cause: error })
        }
        if (!record || candidates.length === 0) {
          if (record) {
            await advancePlanningUpdateNotificationIndex(
              input,
              record,
              requireText(
                indexedItem.nextNotificationAtRecordKey,
                'Indexed Planning next notification key',
              ),
            )
          }
          input.result.skippedItems += 1
          continue
        }

        const scopeCacheKey = `${record.workspaceId}\0${record.recordKey}`
        let scope = scopeCache.get(scopeCacheKey)
        if (!scope) {
          scope = readPlanningScheduledTargetScope(
            input.options,
            input.planningTableName,
            record,
            activeProjectsByWorkspace,
            input.scanPageSize,
            input.maxScanPages,
          )
          scopeCache.set(scopeCacheKey, scope)
        }
        const currentScope = await scope
        if (!currentScope.active) {
          await advancePlanningUpdateNotificationIndex(
            input,
            record,
            requireText(
              indexedItem.nextNotificationAtRecordKey,
              'Indexed Planning next notification key',
            ),
          )
          input.result.skippedItems += 1
          continue
        }

        for (const candidate of candidates) {
          await putPlanningScheduledNotification(
            input,
            candidate,
            currentScope,
          )
        }
        await advancePlanningUpdateNotificationIndex(
          input,
          record,
          requireText(
            indexedItem.nextNotificationAtRecordKey,
            'Indexed Planning next notification key',
          ),
        )
      }

      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
  }
}

/** Strongly re-reads and validates one target key projected by the sparse due index. */
async function readCurrentPlanningUpdateTargetFromDueIndex(
  input: PlanningUpdateTargetQueryInput,
  indexedItem: Record<string, unknown>,
  scheduleShard: string,
  upperBound: string,
) {
  const workspaceId = requireText(indexedItem.workspaceId, 'Indexed Planning Workspace ID')
  const recordKey = requireText(indexedItem.recordKey, 'Indexed Planning target record key')
  const indexedDueKey = requireText(
    indexedItem.nextNotificationAtRecordKey,
    'Indexed Planning next notification key',
  )
  if (
    indexedItem.updateScheduleShard !== scheduleShard ||
    !recordKey.startsWith('UPDATE_TARGET#') ||
    indexedDueKey > upperBound
  ) {
    throw new TypeError('Planning update schedule index returned an invalid target key.')
  }
  const response = await input.options.documentClient.send(new GetCommand({
    TableName: input.planningTableName,
    Key: { workspaceId, recordKey },
    ConsistentRead: true,
  }))
  if (!response.Item) return undefined
  const record = parsePlanningUpdateTargetScheduleRow(response.Item)
  if (
    !record ||
    record.workspaceId !== workspaceId ||
    record.recordKey !== recordKey
  ) {
    throw new TypeError('Planning update schedule target source row is invalid.')
  }
  if (record.nextNotificationAtRecordKey !== undefined) {
    if (record.nextNotificationAtRecordKey !== indexedDueKey) return undefined
  } else if (
    record.cadence &&
    createPlanningUpdateNextNotificationAtRecordKey(
      record.workspaceId,
      record.recordKey,
      record.cadence.nextDueAt,
      record.cadence.reminderHoursBefore,
    ) !== indexedDueKey
  ) {
    return undefined
  }
  return record
}

/**
 * Advances or removes one processed Planning update notification index entry.
 *
 * The target row is conditionally updated with both the indexed key and its
 * source timestamp so a stale due-index result cannot move a newer cadence
 * backward or resurrect an already archived target.
 *
 * @param input - Normalized schedule execution input.
 * @param record - Strongly read target projection.
 * @param expectedIndexKey - Due-index key returned by the query.
 */
async function advancePlanningUpdateNotificationIndex(
  input: PlanningUpdateTargetQueryInput,
  record: PlanningUpdateTargetScheduleRecord,
  expectedIndexKey: string,
) {
  const nextNotificationAt = createNextPlanningNotificationStage(record, input.now)
  const expressionAttributeNames = {
    '#nextNotificationAtRecordKey': 'nextNotificationAtRecordKey',
    '#updateScheduleShard': 'updateScheduleShard',
    '#updatedAt': 'updatedAt',
  }
  const expressionAttributeValues = {
    ':expectedIndexKey': expectedIndexKey,
    ':updatedAt': record.updatedAt,
    ...(nextNotificationAt === undefined
      ? {}
      : {
          ':nextNotificationAtRecordKey': createPlanningUpdateNotificationAtRecordKey(
            record.workspaceId,
            record.recordKey,
            nextNotificationAt,
          ),
          ':scheduleShard': createPlanningUpdateScheduleShard(
            record.workspaceId,
            record.recordKey,
          ),
        }),
  }
  const updateExpression = nextNotificationAt === undefined
    ? 'REMOVE #nextNotificationAtRecordKey, #updateScheduleShard'
    : 'SET #nextNotificationAtRecordKey = :nextNotificationAtRecordKey, ' +
      '#updateScheduleShard = :scheduleShard'
  const indexCondition = record.nextNotificationAtRecordKey === undefined
    ? 'attribute_not_exists(#nextNotificationAtRecordKey)'
    : '#nextNotificationAtRecordKey = :expectedIndexKey'
  try {
    await input.options.documentClient.send(new UpdateCommand({
      TableName: input.planningTableName,
      Key: { workspaceId: record.workspaceId, recordKey: record.recordKey },
      UpdateExpression: updateExpression,
      ConditionExpression:
        `${indexCondition} AND #updatedAt = :updatedAt`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }))
  } catch (error) {
    if (isAwsNamedError(error, 'ConditionalCheckFailedException')) return
    throw error
  }
}

/** Calculates the next strictly future notification stage for a target. */
function createNextPlanningNotificationStage(
  record: PlanningUpdateTargetScheduleRecord,
  now: Date,
) {
  if (record.archivedAt || !record.cadence) return undefined
  const nowTime = normalizeDate(now, 'Planning update notification schedule time').getTime()
  const dueTime = Date.parse(record.cadence.nextDueAt)
  const reminderTime = dueTime - record.cadence.reminderHoursBefore * 3_600_000
  if (nowTime < reminderTime) return new Date(reminderTime).toISOString()
  if (nowTime < dueTime) return new Date(dueTime).toISOString()
  if (record.cadence.escalationHoursAfter !== undefined) {
    const escalationTime = dueTime + record.cadence.escalationHoursAfter * 3_600_000
    if (nowTime < escalationTime) return new Date(escalationTime).toISOString()
  }
  return undefined
}

/** Writes one deterministic Planning scheduled event and classifies duplicate retries. */
async function putPlanningScheduledNotification(
  input: PlanningUpdateTargetQueryInput,
  candidate: PlanningScheduledNotificationCandidate,
  currentScope: PlanningScheduledTargetScope,
) {
  const scopedCandidate = {
    ...candidate,
    ...(currentScope.teamId ? { teamId: currentScope.teamId } : {}),
    ...(currentScope.projectId ? { projectId: currentScope.projectId } : {}),
  }
  const auditEvent = createPlanningScheduledNotificationAuditEvent(
    scopedCandidate,
    input.now,
    input.auditRetentionDays,
    input.options.requestId,
  )
  try {
    await input.options.documentClient.send(new PutCommand({
      TableName: input.auditEventsTableName,
      Item: auditEvent,
      ConditionExpression:
        'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)',
      ExpressionAttributeNames: {
        '#directoryId': 'directoryId',
        '#eventId': 'eventId',
      },
    }))
    input.result.emittedEvents += 1
  } catch (error) {
    if (isAwsNamedError(error, 'ConditionalCheckFailedException')) {
      input.result.duplicateEvents += 1
      return
    }
    throw error
  }
}

/**
 * Validates a canonical `YYYY-MM-DD` UTC date-only value.
 *
 * @param value - Candidate canonical date-only value.
 * @returns The validated date-only value, or undefined when invalid.
 */
export function parseUtcDateOnly(value: unknown): string | undefined {
  const text = readText(value)
  const match = text?.match(/^(\d{4})-(\d{2})-(\d{2})$/)

  if (!match) {
    return undefined
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (
    year < WORK_ITEM_SCHEDULE_MIN_YEAR ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
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

  return text
}

/**
 * Creates a due-notification candidate using the Work Item schedule's local calendar date.
 *
 * @param item - Candidate canonical Work Item row.
 * @param now - Absolute schedule execution instant.
 * @returns A due or overdue candidate, or undefined when no notification is required.
 */
function createScheduledNotificationCandidate(
  item: Record<string, unknown>,
  now: Date,
): ScheduledNotificationCandidate | undefined {
  if (!isCanonicalWorkItemRecord(item)) {
    throw new TypeError(
      'Notification schedule encountered a non-canonical Work Item row.',
    )
  }

  const assigneeMemberKey = item.assigneeUserId.toLowerCase()
  const dueDate = parseUtcDateOnly(item.dueDate)
  const today = workItemScheduleInstantToLocalDate(now, item.schedule.calendarPolicy)

  if (
    !assigneeMemberKey ||
    !isActiveWorkflowStatusCategory(item.statusCategory) ||
    !dueDate ||
    dueDate > today
  ) {
    return undefined
  }

  return {
    workspaceId: item.directoryId,
    teamId: item.teamId,
    issueId: item.issueId,
    assigneeMemberKey,
    ...(item.assignedProjectId ? { projectId: item.assignedProjectId } : {}),
    title: item.title,
    dueDate,
    reason: dueDate === today ? 'due' : 'overdue',
  }
}

/** 期限通知の対象となる非終端 workflow category か判定します。 */
function isActiveWorkflowStatusCategory(value: string | undefined) {
  return value === 'backlog' || value === 'unstarted' || value === 'started'
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

/**
 * Decodes one canonical Planning update target row while ignoring unrelated Planning rows.
 *
 * @param value - Untrusted DynamoDB row from the Planning table.
 * @returns A validated schedule record, or undefined for a non-target row.
 */
export function parsePlanningUpdateTargetScheduleRow(
  value: Record<string, unknown>,
): PlanningUpdateTargetScheduleRecord | undefined {
  const recordKey = readText(value.recordKey)
  if (!recordKey?.startsWith('UPDATE_TARGET#')) {
    return undefined
  }
  if (value.entryType !== 'planning-update-target') {
    throw new TypeError('Planning update target row has an invalid entry type.')
  }

  const workspaceId = requireText(value.workspaceId, 'Planning update target Workspace ID')
  const targetValue = requireRecord(value.target, 'Planning update target')
  const target = parsePlanningUpdateTargetReference(targetValue)
  if (recordKey !== createPlanningUpdateTargetRecordKey(target)) {
    throw new TypeError('Planning update target row key does not match its target.')
  }

  const latestVersion = readNonNegativeInteger(value.latestVersion)
  if (latestVersion === undefined) {
    throw new TypeError('Planning update target latest version must be a non-negative integer.')
  }
  const updatedAt = requireTimestamp(value.updatedAt, 'Planning update target updated timestamp')
  const archivedAt = value.archivedAt === undefined
    ? undefined
    : requireTimestamp(value.archivedAt, 'Planning update target archived timestamp')
  const cadence = value.cadence === undefined
    ? undefined
    : parsePlanningUpdateNotificationCadence(
      requireRecord(value.cadence, 'Planning update target cadence'),
    )
  const nextNotificationAtRecordKey = value.nextNotificationAtRecordKey === undefined
    ? undefined
    : requireText(
        value.nextNotificationAtRecordKey,
        'Planning update next notification key',
      )

  return {
    workspaceId,
    recordKey,
    target,
    ...(cadence ? { cadence } : {}),
    latestVersion,
    ...(nextNotificationAtRecordKey ? { nextNotificationAtRecordKey } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    updatedAt,
  }
}

/**
 * Decodes a canonical schedule projection without exposing its physical row key.
 *
 * @param value - Untrusted DynamoDB row from the Planning table.
 * @returns A validated schedule projection, or undefined for a non-target row.
 */
export function parsePlanningUpdateTargetScheduleProjection(
  value: Record<string, unknown>,
): PlanningUpdateTargetScheduleProjection | undefined {
  const record = parsePlanningUpdateTargetScheduleRow(value)
  if (!record) return undefined
  const {
    recordKey: _recordKey,
    nextNotificationAtRecordKey: _nextNotificationAtRecordKey,
    ...projection
  } = record
  return projection
}

/**
 * Creates every notification stage due at the supplied schedule instant.
 *
 * @param record - Validated canonical Planning update target row.
 * @param now - Absolute schedule execution instant.
 * @returns Due reminder, overdue, and escalation candidates in delivery order.
 */
export function createPlanningScheduledNotificationCandidates(
  record: PlanningUpdateTargetScheduleRecord,
  now: Date,
): PlanningScheduledNotificationCandidate[] {
  const executionTime = normalizeDate(now, 'Planning update notification schedule time').getTime()
  if (record.archivedAt || !record.cadence) {
    return []
  }

  const dueTime = Date.parse(record.cadence.nextDueAt)
  const base = {
    workspaceId: record.workspaceId,
    targetRecordKey: record.recordKey,
    target: record.target,
    nextDueAt: record.cadence.nextDueAt,
  }
  const candidates: PlanningScheduledNotificationCandidate[] = []
  const reminderTime = dueTime - record.cadence.reminderHoursBefore * 3_600_000
  if (executionTime >= reminderTime && executionTime < dueTime) {
    candidates.push({
      ...base,
      kind: 'reminder',
      recipientMemberKey: record.cadence.updateOwnerMemberKey,
    })
  }
  if (executionTime >= dueTime) {
    candidates.push({
      ...base,
      kind: 'overdue',
      recipientMemberKey: record.cadence.updateOwnerMemberKey,
    })
  }
  if (
    record.cadence.escalationHoursAfter !== undefined &&
    record.cadence.escalationMemberKey !== undefined &&
    executionTime >= dueTime + record.cadence.escalationHoursAfter * 3_600_000
  ) {
    candidates.push({
      ...base,
      kind: 'escalation',
      recipientMemberKey: record.cadence.escalationMemberKey,
    })
  }
  return candidates
}

/**
 * Resolves current Project / Initiative scope before emitting a scheduled event.
 *
 * @param options - Schedule dependencies and table names.
 * @param planningTableName - Canonical Planning table name.
 * @param record - Strongly scanned update target record.
 * @param activeProjectsByWorkspace - Workspace-scoped current Project lookup cache.
 * @param pageSize - Directory query page size.
 * @param maxPages - Directory query safety bound.
 * @returns Current active scope for authorization metadata.
 */
async function readPlanningScheduledTargetScope(
  options: NotificationScheduleRunOptions,
  planningTableName: string,
  record: PlanningUpdateTargetScheduleRecord,
  activeProjectsByWorkspace: Map<string, Promise<ReadonlySet<string>>>,
  pageSize: number,
  maxPages: number,
): Promise<PlanningScheduledTargetScope> {
  if (record.target.type === 'project') {
    return await readCurrentScheduledProjectScope(
      options,
      record.workspaceId,
      record.target.teamId,
      record.target.projectId,
      activeProjectsByWorkspace,
      pageSize,
      maxPages,
    )
  }

  const entityRecordKey = `ENTITY#${encodePlanningRecordKeySegment(record.target.entityId)}`
  const response = await options.documentClient.send(new GetCommand({
    TableName: planningTableName,
    Key: { workspaceId: record.workspaceId, recordKey: entityRecordKey },
    ConsistentRead: true,
  }))
  if (!response.Item) {
    return { active: false }
  }
  const entity = response.Item
  if (
    entity.workspaceId !== record.workspaceId ||
    entity.recordKey !== entityRecordKey ||
    entity.entryType !== 'planning-entity' ||
    entity.type !== 'initiative' ||
    entity.id !== record.target.entityId
  ) {
    throw new TypeError('Planning update Initiative source row is invalid.')
  }
  if (entity.archivedAt !== undefined) {
    requireTimestamp(entity.archivedAt, 'Planning Initiative archived timestamp')
    return { active: false }
  }

  const teamId = readText(entity.teamId)
  const projectId = readText(entity.projectId)
  if (projectId && !teamId) {
    throw new TypeError('Planning update Initiative Project scope requires a Team scope.')
  }
  return {
    active: true,
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
  }
}

/**
 * Reads the current Project directory partition and rejects archived or moved targets.
 *
 * @param options - Schedule dependencies and table names.
 * @param workspaceId - Canonical Workspace ID.
 * @param teamId - Expected current Team ID.
 * @param projectId - Expected current Project ID.
 * @param activeProjectsByWorkspace - Workspace-scoped current Project lookup cache.
 * @param pageSize - Directory query page size.
 * @param maxPages - Directory query safety bound.
 * @returns Current active Project scope.
 */
async function readCurrentScheduledProjectScope(
  options: NotificationScheduleRunOptions,
  workspaceId: string,
  teamId: string,
  projectId: string,
  activeProjectsByWorkspace: Map<string, Promise<ReadonlySet<string>>>,
  pageSize: number,
  maxPages: number,
): Promise<PlanningScheduledTargetScope> {
  const tableName = requireText(
    options.projectDirectoryTableName,
    'Project Directory table name for Planning notification schedule',
  )
  let activeProjects = activeProjectsByWorkspace.get(workspaceId)
  if (!activeProjects) {
    activeProjects = readActiveScheduledProjectKeys(
      options,
      tableName,
      workspaceId,
      pageSize,
      maxPages,
    )
    activeProjectsByWorkspace.set(workspaceId, activeProjects)
  }
  const active = (await activeProjects).has(`${teamId}\0${projectId}`)
  return active ? { active: true, teamId, projectId } : { active: false }
}

/**
 * Reads every current Project directory page once for a schedule Workspace.
 *
 * @param options - Schedule dependencies.
 * @param tableName - Canonical Project Directory table name.
 * @param workspaceId - Canonical Workspace ID.
 * @param pageSize - Directory query page size.
 * @param maxPages - Directory query safety bound.
 * @returns Active Team / Project composite keys.
 */
async function readActiveScheduledProjectKeys(
  options: NotificationScheduleRunOptions,
  tableName: string,
  workspaceId: string,
  pageSize: number,
  maxPages: number,
): Promise<ReadonlySet<string>> {
  const activeProjects = new Set<string>()
  let exclusiveStartKey: Record<string, unknown> | undefined
  let pages = 0
  do {
    if (pages >= maxPages) {
      throw new Error(
        `Planning notification Project lookup exceeded the configured ${maxPages} page limit.`,
      )
    }
    const response = await options.documentClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'directoryId = :directoryId',
      ExpressionAttributeValues: { ':directoryId': workspaceId },
      ConsistentRead: true,
      Limit: pageSize,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }))
    pages += 1
    for (const item of response.Items ?? []) {
      if (
        item.entryType === 'project' &&
        typeof item.teamId === 'string' &&
        typeof item.projectId === 'string' &&
        item.archivedAt === undefined
      ) {
        activeProjects.add(`${item.teamId}\0${item.projectId}`)
      }
    }
    exclusiveStartKey = response.LastEvaluatedKey
  } while (exclusiveStartKey)
  return activeProjects
}

/**
 * Creates a deterministic Planning update reminder / overdue / escalation audit outbox event.
 *
 * @param candidate - Current target, occurrence, kind, and recipient.
 * @param now - Schedule execution instant used as the event timestamp.
 * @param auditRetentionDays - Audit retention period.
 * @param requestId - Optional EventBridge request ID for traceability.
 * @returns Immutable schema-v1 audit outbox event.
 */
function createPlanningScheduledNotificationAuditEvent(
  candidate: PlanningScheduledNotificationCandidate,
  now: Date,
  auditRetentionDays: number,
  requestId?: string,
) {
  const targetId = candidate.target.type === 'project'
    ? candidate.target.projectId
    : candidate.target.entityId
  const entityId = createPlanningUpdatePublicTargetKey(candidate.target)
  const occurredAt = now.toISOString()
  const idempotencyDigest = createHash('sha256').update([
    candidate.workspaceId,
    candidate.targetRecordKey,
    candidate.nextDueAt,
    candidate.kind,
    candidate.recipientMemberKey,
  ].join('\0')).digest('hex')
  const idempotencyKey = `planning-update-notification-schedule-v1:${idempotencyDigest}`
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
        targetRecordKey: candidate.targetRecordKey,
        nextDueAt: candidate.nextDueAt,
        kind: candidate.kind,
      },
    },
    source: {
      kind: 'system',
      method: 'SCHEDULE',
      route: '/internal/notification-schedule',
      ...(requestId ? { requestId } : {}),
    },
  })
  const search = candidate.target.type === 'project'
    ? new URLSearchParams({
        targetType: 'project',
        teamId: candidate.target.teamId,
        projectId: candidate.target.projectId,
      })
    : new URLSearchParams({
        targetType: 'initiative',
        entityId: candidate.target.entityId,
      })
  const deepLink = `/planning/portfolio?${search.toString()}`
  const targetLabel = candidate.target.type === 'project' ? 'Project' : 'Initiative'
  const summary = candidate.kind === 'reminder'
    ? `${targetLabel} health update is due soon.`
    : candidate.kind === 'overdue'
    ? `${targetLabel} health update is overdue.`
    : `${targetLabel} health update requires escalation.`

  return createAuditEvent({
    context,
    eventType: `planning-update.${candidate.kind}`,
    entity: { type: 'planning-update-target', id: entityId },
    action: candidate.kind,
    changes: [],
    summary,
    metadata: {
      actorMemberKey: scheduleActorMemberKey,
      ...(candidate.teamId ? { teamId: candidate.teamId } : {}),
      ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
      deepLink,
      notificationTitle: `${targetLabel} health update`,
      planningTargetType: candidate.target.type,
      planningTargetId: targetId,
      planningTargetRecordKey: candidate.targetRecordKey,
      planningNextDueAt: candidate.nextDueAt,
      planningNotificationKind: candidate.kind,
      notificationCandidates: [{
        memberKey: candidate.recipientMemberKey,
        reason: candidate.kind,
      }],
    },
    expiresAt: calculateAuditExpiresAt(occurredAt, auditRetentionDays),
    outboxStatus: 'pending',
  })
}

/** Parses and validates a Planning update target reference. */
function parsePlanningUpdateTargetReference(
  value: Record<string, unknown>,
): PlanningUpdateTargetReference {
  if (value.type === 'project') {
    return {
      type: 'project',
      teamId: requireText(value.teamId, 'Planning update target Team ID'),
      projectId: requireText(value.projectId, 'Planning update target Project ID'),
    }
  }
  if (value.type === 'initiative') {
    return {
      type: 'initiative',
      entityId: requireText(value.entityId, 'Planning update target Initiative ID'),
    }
  }
  throw new TypeError('Planning update target type is invalid.')
}

/** Parses and validates one persisted Planning update cadence. */
function parsePlanningUpdateNotificationCadence(
  value: Record<string, unknown>,
): PlanningUpdateNotificationCadence {
  const cadence = requireRecord(value.cadence, 'Planning update recurrence')
  const unit = cadence.unit
  const count = readPositiveInteger(cadence.count)
  if ((unit !== 'week' && unit !== 'month') || count === undefined) {
    throw new TypeError('Planning update recurrence is invalid.')
  }
  const timeZone = requireText(value.timeZone, 'Planning update timezone')
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format()
  } catch {
    throw new TypeError('Planning update timezone is invalid.')
  }
  const reminderHoursBefore = readNonNegativeInteger(value.reminderHoursBefore)
  if (reminderHoursBefore === undefined) {
    throw new TypeError('Planning update reminder hours must be a non-negative integer.')
  }
  if (reminderHoursBefore > maximumPlanningNotificationOffsetHours) {
    throw new TypeError('Planning update reminder hours exceed the supported maximum.')
  }
  const escalationHoursAfter = value.escalationHoursAfter === undefined
    ? undefined
    : readNonNegativeInteger(value.escalationHoursAfter)
  if (value.escalationHoursAfter !== undefined && escalationHoursAfter === undefined) {
    throw new TypeError('Planning update escalation hours must be a non-negative integer.')
  }
  if (
    escalationHoursAfter !== undefined &&
    escalationHoursAfter > maximumPlanningNotificationOffsetHours
  ) {
    throw new TypeError('Planning update escalation hours exceed the supported maximum.')
  }
  const escalationMemberKey = value.escalationMemberKey === undefined
    ? undefined
    : normalizeMemberKey(value.escalationMemberKey, 'Planning update escalation member')
  if ((escalationHoursAfter === undefined) !== (escalationMemberKey === undefined)) {
    throw new TypeError('Planning update escalation hours and member must be configured together.')
  }

  return {
    updateOwnerMemberKey: normalizeMemberKey(
      value.updateOwnerMemberKey,
      'Planning update owner member',
    ),
    unit,
    count,
    timeZone,
    nextDueAt: requireTimestamp(value.nextDueAt, 'Planning update next deadline'),
    reminderHoursBefore,
    ...(escalationHoursAfter === undefined ? {} : { escalationHoursAfter }),
    ...(escalationMemberKey === undefined ? {} : { escalationMemberKey }),
  }
}

/** Creates the canonical physical key for an update target reference. */
function createPlanningUpdateTargetRecordKey(target: PlanningUpdateTargetReference): string {
  return target.type === 'project'
    ? `UPDATE_TARGET#PROJECT#${encodePlanningRecordKeySegment(target.teamId)}#${encodePlanningRecordKeySegment(target.projectId)}`
    : `UPDATE_TARGET#INITIATIVE#${encodePlanningRecordKeySegment(target.entityId)}`
}

/** Encodes one canonical Planning physical key segment. */
function encodePlanningRecordKeySegment(value: string): string {
  try {
    return encodeURIComponent(requireText(value, 'Planning record key segment'))
  } catch {
    throw new TypeError('Planning record key segment contains invalid Unicode.')
  }
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

/** Requires a non-array object at an untrusted persistence boundary. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object.`)
  }
  return value
}

/** Requires and canonicalizes an ISO timestamp. */
function requireTimestamp(value: unknown, label: string): string {
  const text = requireText(value, label)
  const timestamp = Date.parse(text)
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be a valid timestamp.`)
  }
  return new Date(timestamp).toISOString()
}

/** Reads a positive safe integer from an untrusted value. */
function readPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

/** Reads a non-negative safe integer from an untrusted value. */
function readNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

/** Requires and normalizes a Workspace member key. */
function normalizeMemberKey(value: unknown, label: string): string {
  return requireText(value, label).toLowerCase()
}

function readText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Narrows an untrusted value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAwsNamedError(error: unknown, name: string) {
  return error instanceof Error && error.name === name
}
