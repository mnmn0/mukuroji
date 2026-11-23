import { createHash } from 'node:crypto'
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
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
import { isCanonicalWorkItemRecord, isWorkItemKeyRegistryRecord } from '../../../work-items'
import { NOTIFICATION_REMINDER_DAYS_MAXIMUM } from '@mukuroji/contracts'
import { normalizeTeamReminderDays } from '../../domain/reminder-days'
import { loadServerConfig } from '../../../../infrastructure/config/server-config'
import type { ScheduledProjectManagerReader } from '../../application/ports/project-manager-reader'
import type { ScheduledReminderSettingsReader } from '../../application/ports/reminder-settings-reader'
import type {
  ScheduledReadProgress,
  ScheduledWorkItemSource,
} from '../../application/ports/scheduled-work-item-source'
import type { ScheduledTimesheetReader } from '../../application/ports/timesheet-reminder-reader'
import {
  DEFAULT_TIMESHEET_REMINDER_HOUR,
  TIMESHEET_REMINDER_LOOKBACK_DAYS,
  evaluateTimesheetReminders,
  isTimesheetReminderHour,
  type TimesheetReminderCandidate,
} from '../../application/timesheet-reminders'
import type { ScheduledWeeklyReportReader } from '../../application/ports/weekly-report-reminder-reader'
import {
  evaluateWeeklyReportReminders,
  resolveWeeklyReportReminderRun,
  toWeeklyReportReminderTiming,
  weeklyReportWeekStart,
  type WeeklyReportReminderCandidate,
} from '../../application/weekly-report-reminders'
import {
  DEFAULT_WORK_ITEM_REMINDER_POLICY,
  createReminderPolicyResolver,
  evaluateScheduledWorkItemNotifications,
  normalizeWorkItemReminderPolicy,
  type ScheduledNotificationCandidate,
  type ScheduledNotificationReason,
  type WorkItemReminderPolicy,
} from '../../application/work-item-reminders'

/** EventBridge scheduled event から利用する最小入力です。 */
export type NotificationScheduleEvent = {
  /** EventBridge event ID です。 */
  id?: string
  /** EventBridge が schedule を発火した ISO 8601 timestamp です。 */
  time?: string
}

/** Notification schedule から利用する DynamoDB DocumentClient です。 */
export type NotificationScheduleDocumentClient = Pick<DynamoDBDocumentClient, 'send'>

/** Durable Work Item marker handed to Customer completion preparation. */
export type CustomerCompletionPreparation = {
  /** Workspace containing the completed Work Item. */
  workspaceId: string
  /** Team owning the completed Work Item. */
  teamId: string
  /** Completed Work Item identifier. */
  workItemId: string
  /** Work Item revision that created the marker. */
  revision: number
  /** Physical Work Item partition key. */
  directoryTeamId: string
  /** Physical Work Item sort key. */
  issueId: string
}

/** Handler that prepares idempotent Customer completion notification candidates.
 *
 * @param preparation Durable Work Item marker handed to the Customer adapter.
 * @returns A promise that resolves after candidates are durably prepared.
 */
export type CustomerCompletionPreparationHandler = (
  preparation: CustomerCompletionPreparation,
) => Promise<void>

/** 期限通知 schedule の実行設定です。 */
export type NotificationScheduleRunOptions = {
  /** Canonical source reads と audit event put に使う DocumentClient です。 */
  documentClient: NotificationScheduleDocumentClient
  /** Reads the Work Items and Teams the schedule evaluates. */
  workItemSource: ScheduledWorkItemSource
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
  /** 一度の DynamoDB Query / Scan page で評価する最大 item 数です。 */
  scanPageSize?: number
  /**
   * Planning と Project directory の読み取りで一度の invocation に読む最大 page 数です。
   * Work Item の期限 index は index 自体が対象を絞るため、この上限を適用しません。
   */
  maxScanPages?: number
  /** Audit event を保持する日数です。 */
  auditRetentionDays?: number
  /** EventBridge event ID などの schedule 実行 ID です。 */
  requestId?: string
  /** Prepares Customer completion candidates for a durable Work Item marker. */
  prepareCustomerCompletionNotifications?: CustomerCompletionPreparationHandler
  /** Reminder thresholds; omitted fields use {@link DEFAULT_WORK_ITEM_REMINDER_POLICY}. */
  reminderPolicy?: Partial<WorkItemReminderPolicy>
  /** Resolves Project managers for overdue escalation; without it no escalation is emitted. */
  projectManagerReader?: ScheduledProjectManagerReader
  /** Reads Team and personal reminder overrides; without it every recipient gets the defaults. */
  reminderSettingsReader?: ScheduledReminderSettingsReader
  /** Reads unsubmitted time entries; without it no timesheet reminder is emitted. */
  timesheetReader?: ScheduledTimesheetReader
  /**
   * Local hour (0-23) in the Workspace time zone of the one hourly run per day that sends
   * timesheet reminders. Defaults to {@link DEFAULT_TIMESHEET_REMINDER_HOUR}.
   */
  timesheetReminderHour?: number
  /**
   * Reads Workspace reminder settings, rosters, and submissions; without it no weekly report
   * reminder is emitted.
   */
  weeklyReportReader?: ScheduledWeeklyReportReader
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
  | {
    /** Directory Team target です。 */
    type: 'team'
    /** Canonical Team ID です。 */
    teamId: string
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

/** Audit event type of a timesheet submission reminder. */
export const TIMESHEET_REMINDER_EVENT_TYPE = 'timesheet.submission-reminder'

/** Audit event type that reminds an author to submit their weekly report. */
export const WEEKLY_REPORT_REMINDER_EVENT_TYPE = 'weekly-report.submission-reminder'

/** Audit event type that tells a manager a member's weekly report is still unsubmitted. */
export const WEEKLY_REPORT_ESCALATION_EVENT_TYPE = 'weekly-report.submission-escalation'

/** Recipient reason of a weekly report reminder to its author. */
export const WEEKLY_REPORT_REMINDER_REASON = 'weekly-report'

/** Recipient reason of a weekly report escalation to a manager. */
export const WEEKLY_REPORT_ESCALATION_REASON = 'weekly-report-escalation'

const scheduleActorId = 'system:notification-schedule'
const scheduleActorMemberKey = 'system'
const defaultScanPageSize = 100
const defaultMaxScanPages = 1_000
const defaultAuditRetentionDays = 2_555
const maximumPlanningNotificationOffsetHours = 24 * 365

/**
 * Creates an EventBridge schedule adapter bound to an injected DocumentClient.
 *
 * @param documentClient DocumentClient used by the schedule.
 * @param workItemSource Reads the Work Item notification indexes and the Team list.
 * @param prepareCustomerCompletionNotifications Optional durable Customer preparation handler.
 * @param projectManagerReader Optional Project manager reader for overdue escalation.
 * @param reminderSettingsReader Optional Team and personal reminder override reader.
 * @param timesheetReader Optional unsubmitted time entry reader for timesheet reminders.
 * @param weeklyReportReader Optional roster and submission reader for weekly report reminders.
 * @returns An EventBridge-compatible notification schedule handler.
 */
export function createNotificationScheduleHandler(
  documentClient: NotificationScheduleDocumentClient,
  workItemSource: ScheduledWorkItemSource,
  prepareCustomerCompletionNotifications?: CustomerCompletionPreparationHandler,
  projectManagerReader?: ScheduledProjectManagerReader,
  reminderSettingsReader?: ScheduledReminderSettingsReader,
  timesheetReader?: ScheduledTimesheetReader,
  weeklyReportReader?: ScheduledWeeklyReportReader,
) {
  return async (
    event: NotificationScheduleEvent = {},
  ): Promise<NotificationScheduleResult> =>
    runNotificationSchedule({
      documentClient,
      workItemSource,
      planningTableName: requireEnvironment('PLANNING_TABLE_NAME'),
      planningUpdateScheduleIndexName: requireEnvironment(
        'PLANNING_UPDATE_SCHEDULE_INDEX_NAME',
      ),
      projectDirectoryTableName: requireEnvironment('PROJECT_DIRECTORY_TABLE_NAME'),
      auditEventsTableName: requireEnvironment('AUDIT_EVENTS_TABLE_NAME'),
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
      ),
      ...(readText(event.id) ? { requestId: readText(event.id) } : {}),
      ...(prepareCustomerCompletionNotifications
        ? { prepareCustomerCompletionNotifications }
        : {}),
      ...(projectManagerReader ? { projectManagerReader } : {}),
      ...(reminderSettingsReader ? { reminderSettingsReader } : {}),
      ...(timesheetReader ? { timesheetReader } : {}),
      timesheetReminderHour: readTimesheetReminderHour(),
      ...(weeklyReportReader ? { weeklyReportReader } : {}),
      reminderPolicy: readReminderPolicyDefaultsFromEnvironment(),
    })
}

/** Environment variable that holds the deployment default reminder days for every Lambda. */
export const NOTIFICATION_REMINDER_DEFAULT_DAYS_ENVIRONMENT = 'NOTIFICATION_REMINDER_DEFAULT_DAYS'

/**
 * Reads the deployment default reminder thresholds. They come from one stack parameter that the
 * schedule and API Lambdas both receive as {@link NOTIFICATION_REMINDER_DEFAULT_DAYS_ENVIRONMENT},
 * a JSON object with the same fields as a Team's settings (`{"dueSoonDays":5}`). Omitted fields,
 * or a blank value, use {@link DEFAULT_WORK_ITEM_REMINDER_POLICY}; Teams and members override the
 * result.
 *
 * @returns Validated default thresholds.
 * @throws RangeError when the value is not such an object or a day count is out of range.
 */
export function readReminderPolicyDefaultsFromEnvironment(): WorkItemReminderPolicy {
  const configured = loadServerConfig().environment[NOTIFICATION_REMINDER_DEFAULT_DAYS_ENVIRONMENT]?.trim()
  return normalizeWorkItemReminderPolicy(configured ? parseReminderDefaultDays(configured) : undefined)
}

/**
 * Parses the deployment default reminder days.
 *
 * @param value - Non-blank JSON text.
 * @returns The fields it sets.
 * @throws RangeError when the text is not a JSON object of valid reminder day fields.
 */
function parseReminderDefaultDays(value: string): Partial<WorkItemReminderPolicy> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new RangeError(`${NOTIFICATION_REMINDER_DEFAULT_DAYS_ENVIRONMENT} must be a JSON object.`)
  }
  try {
    return normalizeTeamReminderDays(parsed)
  } catch {
    throw new RangeError(
      `${NOTIFICATION_REMINDER_DEFAULT_DAYS_ENVIRONMENT} must set only reminder day fields to valid day counts.`,
    )
  }
}

/**
 * Reads the local hour, in the Workspace time zone, of the daily timesheet reminder run.
 *
 * @returns Hour from 0 to 23.
 * @throws RangeError when the configured value is not an hour.
 */
function readTimesheetReminderHour() {
  const configured = loadServerConfig().environment.NOTIFICATION_TIMESHEET_REMINDER_HOUR?.trim()
  if (!configured) return DEFAULT_TIMESHEET_REMINDER_HOUR
  return readHour(Number(configured))
}

/**
 * Validates an hour of the day.
 *
 * @param value - Candidate hour.
 * @returns The hour.
 * @throws RangeError when the value is not an integer from 0 to 23.
 */
function readHour(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 23) {
    throw new RangeError('Timesheet reminder hour must be an integer between 0 and 23.')
  }
  return value
}

/**
 * 注入された DocumentClient で期限通知 schedule を最後の scan page まで実行します。
 */
export async function runNotificationSchedule(
  options: NotificationScheduleRunOptions,
): Promise<NotificationScheduleResult> {
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
  const reminderPolicy = normalizeWorkItemReminderPolicy(options.reminderPolicy)
  const resolveReminderPolicy = createReminderPolicyResolver(
    reminderPolicy,
    options.reminderSettingsReader,
  )
  const timesheetReminderHour = readHour(
    options.timesheetReminderHour ?? DEFAULT_TIMESHEET_REMINDER_HOUR,
  )
  const projectManagersByWorkspace = new Map<
    string,
    Promise<ReadonlyMap<string, readonly string[]>>
  >()
  const result: NotificationScheduleResult = {
    scannedItems: 0,
    emittedEvents: 0,
    duplicateEvents: 0,
    skippedItems: 0,
    scannedPages: 0,
  }
  const documentClient = options.documentClient

  /**
   * Evaluates one open Work Item from the due index and emits its scheduled notifications.
   *
   * The index copy is eventually consistent, so a row that yields any stage is read again with
   * a strongly consistent get and evaluated from that copy instead.
   *
   * @param indexedItem - Work Item row projected by the due index.
   */
  const emitWorkItemNotifications = async (indexedItem: Record<string, unknown>) => {
    if (isWorkItemKeyRegistryRecord(indexedItem)) return
    const evaluate = async (item: Record<string, unknown>) => {
      const itemScope = readWorkItemReminderScope(item)
      return evaluateScheduledWorkItemNotifications(
        item,
        now,
        itemScope?.assigneeMemberKey
          ? await resolveReminderPolicy(
              itemScope.workspaceId,
              itemScope.teamId,
              itemScope.assigneeMemberKey,
            )
          : reminderPolicy,
      )
    }
    const indexed = await evaluate(indexedItem)
    if (indexed.candidates.length === 0 && !indexed.escalation) {
      result.skippedItems += 1
      return
    }
    const current = await options.workItemSource.readCurrentWorkItem(indexedItem)
    if (!current) {
      result.skippedItems += 1
      return
    }
    const evaluation = await evaluate(current)
    const candidates = [...evaluation.candidates]
    const managerReader = options.projectManagerReader
    if (evaluation.escalation?.projectId && managerReader) {
      const escalation = evaluation.escalation
      let managers = projectManagersByWorkspace.get(escalation.workspaceId)
      if (!managers) {
        managers = managerReader.readActiveProjectManagers(escalation.workspaceId)
        projectManagersByWorkspace.set(escalation.workspaceId, managers)
      }
      const recipients = ((await managers).get(escalation.projectId ?? '') ?? [])
        .filter((memberKey) => memberKey !== escalation.assigneeMemberKey)
      // One event per manager keeps each recipient's dedupe independent, so a manager who
      // joins after the first escalation still receives one.
      for (const memberKey of recipients) {
        candidates.push({ ...escalation, escalationMemberKey: memberKey })
      }
    }

    if (candidates.length === 0) {
      result.skippedItems += 1
      return
    }

    for (const candidate of candidates) {
      await putScheduledAuditEvent(
        documentClient,
        auditEventsTableName,
        createScheduledNotificationAuditEvent(
          candidate,
          now,
          auditRetentionDays,
          options.requestId,
        ),
        result,
      )
    }
  }

  const readOptions = { pageSize: scanPageSize, maxPages: maxScanPages }
  addReadProgress(result, await options.workItemSource.readCompletionMarkerWorkItems(
    readOptions,
    async (current) => {
      const completionPreparation = readCustomerCompletionPreparation(current)
      if (!completionPreparation) return
      const prepare = options.prepareCustomerCompletionNotifications
      if (!prepare) {
        throw new Error(
          'Customer completion preparation is required for a durable Work Item marker.',
        )
      }
      await prepare(completionPreparation)
      await options.workItemSource.clearCompletionMarker(completionPreparation)
    },
  ))

  // Every open Work Item that can be due soon for any recipient is at or below this key; a
  // calendar day of slack covers Work Item time zones ahead of UTC.
  addReadProgress(result, await options.workItemSource.readDueWorkItems(
    addUtcDays(now, NOTIFICATION_REMINDER_DAYS_MAXIMUM + 1),
    readOptions,
    emitWorkItemNotifications,
  ))

  let teamList: Awaited<ReturnType<ScheduledWorkItemSource['listTeams']>>['teams'] | undefined
  /**
   * Lists the Teams once per run, for whichever daily or weekly pass needs them first.
   *
   * @returns Distinct Workspace and Team pairs.
   */
  const listTeams = async () => {
    if (!teamList) {
      const { teams, progress } = await options.workItemSource.listTeams(readOptions)
      addReadProgress(result, progress)
      teamList = teams
    }
    return teamList
  }

  // Every Workspace keeps its wall clock in the Workspace time zone (DEFAULT_WORKSPACE_TIME_ZONE),
  // so one local-hour check covers all of them and the directory is read only in that run.
  if (options.timesheetReader && isTimesheetReminderHour(now, timesheetReminderHour)) {
    const from = new Date(now.getTime() - TIMESHEET_REMINDER_LOOKBACK_DAYS * 86_400_000)
    for (const { workspaceId, teamId } of await listTeams()) {
      const entries = await options.timesheetReader.listUnsubmittedEntries(
        workspaceId,
        teamId,
        from,
        now,
      )
      const reminders = await evaluateTimesheetReminders(
        workspaceId,
        teamId,
        entries,
        now,
        async (memberKey) =>
          (await resolveReminderPolicy(workspaceId, teamId, memberKey)).timesheetReminderDays,
      )
      for (const reminder of reminders) {
        await putScheduledAuditEvent(
          options.documentClient,
          auditEventsTableName,
          createTimesheetReminderAuditEvent(reminder, now, auditRetentionDays, options.requestId),
          result,
        )
      }
    }
  }

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

  // Weekly report reminders run last, so a failure here cannot hold back the other notifications
  // of the run; a retry of the same scheduled event reaches the same slot again.
  const weeklyReportReader = options.weeklyReportReader
  if (weeklyReportReader) {
    // Each Workspace chooses its own hours, so its settings are read on every run; the rosters
    // and weeks are read only in a Workspace whose slot this hour is.
    const workspaceIds = [...new Set((await listTeams()).map((team) => team.workspaceId))].sort()
    for (const workspaceId of workspaceIds) {
      const settings = await weeklyReportReader.readWorkspaceSettings(workspaceId)
      const timing = toWeeklyReportReminderTiming(settings.reminders)
      const run = timing ? resolveWeeklyReportReminderRun(now, timing) : undefined
      if (!run) continue
      const weekStart = weeklyReportWeekStart(run.date, settings.weekStartDay)
      for (const roster of await weeklyReportReader.readTeamRosters(workspaceId)) {
        const memberKeys = [...new Set(roster.projects.flatMap((project) =>
          project.writers.map((writer) => writer.memberKey)))]
        if (memberKeys.length === 0) continue
        const submitted = await weeklyReportReader.readSubmittedMembers(
          workspaceId,
          roster.teamId,
          memberKeys,
          weekStart,
        )
        for (const candidate of evaluateWeeklyReportReminders(roster, run.kind, weekStart, submitted)) {
          await putScheduledAuditEvent(
            options.documentClient,
            auditEventsTableName,
            createWeeklyReportReminderAuditEvent(candidate, now, auditRetentionDays, options.requestId),
            result,
          )
        }
      }
    }
  }

  return result
}

/**
 * Reads the Workspace, Team, and owner of a canonical Work Item row for reminder resolution.
 *
 * @param item - Untrusted Work Items table row.
 * @returns The scope, or undefined for a row that is not a canonical Work Item.
 */
function readWorkItemReminderScope(item: Record<string, unknown>) {
  if (!isCanonicalWorkItemRecord(item)) return undefined
  return {
    workspaceId: item.directoryId,
    teamId: item.teamId,
    assigneeMemberKey: item.assigneeUserId.toLowerCase(),
  }
}

/**
 * Adds one source call's reads to the run result.
 *
 * @param result - Run result accumulator.
 * @param progress - Pages and items the call read.
 */
function addReadProgress(result: NotificationScheduleResult, progress: ScheduledReadProgress) {
  result.scannedPages += progress.pages
  result.scannedItems += progress.items
}

/**
 * Returns the UTC calendar date a number of days after an instant.
 *
 * @param instant - Starting instant.
 * @param days - Days to add.
 * @returns `YYYY-MM-DD` date.
 */
function addUtcDays(instant: Date, days: number): string {
  return new Date(instant.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Stores one scheduled audit event unless an earlier run already stored it.
 *
 * @param documentClient - DocumentClient used for the put.
 * @param tableName - AuditEvents table name.
 * @param auditEvent - Event with a deterministic ID.
 * @param result - Run counters updated in place.
 * @returns A promise that resolves after the event is stored or found to be a duplicate.
 */
async function putScheduledAuditEvent(
  documentClient: NotificationScheduleDocumentClient,
  tableName: string,
  auditEvent: Record<string, unknown>,
  result: NotificationScheduleResult,
) {
  try {
    await documentClient.send(new PutCommand({
      TableName: tableName,
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
      return
    }

    throw error
  }
}

/** Reads and validates the durable Customer completion marker on a Work Item row.
 *
 * @param value - Untrusted Work Item row returned by DynamoDB.
 * @returns The normalized preparation input, or undefined when no marker is present.
 */
function readCustomerCompletionPreparation(
  value: Record<string, unknown>,
): CustomerCompletionPreparation | undefined {
  const preparationAt = value.customerCompletionPreparationAt
  const preparationRevision = value.customerCompletionPreparationRevision
  if (preparationAt === undefined && preparationRevision === undefined) return undefined
  if (!isCanonicalWorkItemRecord(value)) {
    throw new TypeError(
      'Notification schedule encountered an invalid Work Item completion marker row.',
    )
  }
  requireTimestamp(
    preparationAt,
    'Customer completion preparation timestamp',
  )
  const revision = readPositiveInteger(preparationRevision)
  if (revision === undefined) {
    throw new TypeError('Customer completion preparation revision must be a positive integer.')
  }
  return {
    workspaceId: value.directoryId,
    teamId: value.teamId,
    workItemId: value.issueId,
    revision,
    directoryTeamId: value.directoryTeamId,
    issueId: value.issueId,
  }
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
  let planningScannedPages = 0
  for (let shardIndex = 0; shardIndex < PLANNING_UPDATE_SCHEDULE_SHARD_COUNT; shardIndex += 1) {
    const scheduleShard = createPlanningUpdateScheduleShardName(shardIndex)
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      if (planningScannedPages >= input.maxScanPages) {
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
      planningScannedPages += 1
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
        let currentScope: PlanningScheduledTargetScope
        try {
          currentScope = await scope
        } catch (error) {
          if (!(error instanceof TypeError)) throw error
          console.error('Planning update schedule row is invalid.', {
            requestId: input.options.requestId,
            scheduleShard,
          })
          throw new Error('Planning update schedule row is invalid.', { cause: error })
        }
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
    ':updatedAt': record.updatedAt,
    ...(record.nextNotificationAtRecordKey === undefined
      ? {}
      : { ':expectedIndexKey': expectedIndexKey }),
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
 * Creates the deterministic audit outbox event for one scheduled Work Item stage.
 *
 * The idempotency key binds the Work Item, the due date (or the last update for a stale
 * reminder), the stage, the recipient scope, and the repetition index, so retries and
 * overlapping runs emit each stage once. `due` and `overdue` keep their original key inputs.
 *
 * @param candidate - Work Item stage and its recipients.
 * @param now - Schedule execution instant used as the event timestamp.
 * @param auditRetentionDays - Audit retention period.
 * @param requestId - Optional EventBridge request ID for traceability.
 * @returns Immutable schema-v1 audit outbox event.
 */
function createScheduledNotificationAuditEvent(
  candidate: ScheduledNotificationCandidate,
  now: Date,
  auditRetentionDays: number,
  requestId?: string,
) {
  const entityId = `team/${candidate.teamId}/issue/${candidate.issueId}`
  const occurredAt = now.toISOString()
  const idempotencyParts = candidate.reason === 'due' || candidate.reason === 'overdue'
    ? [candidate.workspaceId, entityId, candidate.dueDate, candidate.reason, candidate.assigneeMemberKey]
    : candidate.reason === 'overdue-escalation'
      ? [
          candidate.workspaceId,
          entityId,
          candidate.dueDate,
          candidate.reason,
          candidate.projectId ?? '',
          candidate.escalationMemberKey ?? '',
          // Delivery drops a stage that a calendar change moved out of its window, so a new
          // calendar gets its own key and can emit the stage again once it is eligible.
          candidate.calendarTimeZone ?? '',
          // Delivery also drops it once the item closes, so reopening starts a new escalation.
          ...(candidate.reopenedAt ? [candidate.reopenedAt] : []),
        ]
      : candidate.reason === 'due-soon'
        ? [
            candidate.workspaceId,
            entityId,
            candidate.dueDate,
            candidate.reason,
            candidate.assigneeMemberKey,
            String(candidate.repetition ?? 0),
            candidate.calendarTimeZone ?? '',
          ]
      : candidate.reason === 'stale'
        ? [
            candidate.workspaceId,
            entityId,
            candidate.workItemUpdatedAt ?? '',
            candidate.reason,
            candidate.assigneeMemberKey,
            String(candidate.repetition ?? 0),
            ...reminderIntervalKeyParts(candidate, DEFAULT_WORK_ITEM_REMINDER_POLICY.staleStartedDays),
          ]
        : [
            candidate.workspaceId,
            entityId,
            candidate.dueDate,
            candidate.reason,
            candidate.assigneeMemberKey,
            String(candidate.repetition ?? 0),
            ...(candidate.reason === 'overdue-reminder'
              ? reminderIntervalKeyParts(
                  candidate,
                  DEFAULT_WORK_ITEM_REMINDER_POLICY.overdueReminderIntervalDays,
                )
              : []),
          ]
  const idempotencyDigest = createHash('sha256').update(idempotencyParts.join('\0')).digest('hex')
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
        ...(candidate.repetition === undefined ? {} : { repetition: candidate.repetition }),
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
  const notificationCandidates = candidate.reason === 'overdue-escalation'
    ? [{ memberKey: candidate.escalationMemberKey ?? '', reason: 'escalation' }]
    : [{
        memberKey: candidate.assigneeMemberKey,
        reason: scheduledNotificationCandidateReason(candidate.reason),
      }]

  return createAuditEvent({
    context,
    eventType: `work-item.${candidate.reason}`,
    entity: { type: 'work-item', id: entityId },
    action: candidate.reason,
    changes: [],
    summary: createScheduledNotificationSummary(candidate),
    metadata: {
      actorMemberKey: scheduleActorMemberKey,
      teamId: candidate.teamId,
      issueId: candidate.issueId,
      ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
      deepLink,
      title: candidate.title,
      ...(candidate.dueDate ? { dueDate: candidate.dueDate } : {}),
      ...(candidate.workItemUpdatedAt
        ? { workItemUpdatedAt: candidate.workItemUpdatedAt }
        : {}),
      ...(candidate.daysUntilDue === undefined ? {} : { daysUntilDue: candidate.daysUntilDue }),
      ...(candidate.reopenedAt ? { workItemReopenedAt: candidate.reopenedAt } : {}),
      ...(candidate.repetition === undefined ? {} : { repetition: candidate.repetition }),
      notificationCandidates,
    },
    expiresAt: calculateAuditExpiresAt(occurredAt, auditRetentionDays),
    outboxStatus: 'pending',
  })
}

/**
 * Returns the interval key part of a numbered reminder.
 *
 * A reminder is numbered by how many intervals have passed, so the same number means a different
 * day once a Team or member changes the interval. A non-default interval joins the key so its
 * numbering does not collide with reminders sent under another interval; the default interval
 * adds nothing, which keeps the keys of reminders sent before intervals became configurable.
 *
 * @param candidate - Numbered reminder stage.
 * @param defaultIntervalDays - Built-in default interval for the stage.
 * @returns Extra key parts.
 */
function reminderIntervalKeyParts(
  candidate: ScheduledNotificationCandidate,
  defaultIntervalDays: number,
) {
  const interval = candidate.reminderIntervalDays
  return interval === undefined || interval === defaultIntervalDays
    ? []
    : [`interval:${interval}`]
}

/**
 * Creates the audit event that reminds one member to submit a Team's time entries.
 *
 * The event ID is derived from the Workspace, Team, member, threshold, and the threshold-long
 * period since the Unix epoch, so retries and the other hourly runs of the same period are
 * duplicates. The event names the oldest unsubmitted entries so delivery can drop the reminder
 * once they are all submitted.
 *
 * @param candidate - Member, entries, and period.
 * @param now - Schedule execution instant.
 * @param auditRetentionDays - Audit event retention.
 * @param requestId - Schedule execution ID.
 * @returns Audit event row.
 */
function createTimesheetReminderAuditEvent(
  candidate: TimesheetReminderCandidate,
  now: Date,
  auditRetentionDays: number,
  requestId?: string,
) {
  const entityId = `team/${candidate.teamId}/timesheet`
  const occurredAt = now.toISOString()
  const idempotencyDigest = createHash('sha256').update([
    candidate.workspaceId,
    entityId,
    TIMESHEET_REMINDER_EVENT_TYPE,
    candidate.memberKey,
    candidate.projectId,
    String(candidate.reminderDays),
    String(candidate.cycle),
  ].join('\0')).digest('hex')
  const context = createMutationAuditContext({
    workspaceId: candidate.workspaceId,
    actor: {
      id: scheduleActorId,
      kind: 'system',
      displayName: 'Mukuroji notification schedule',
    },
    idempotencyKey: `notification-schedule-v1:${idempotencyDigest}`,
    occurredAt,
    request: {
      method: 'SCHEDULE',
      path: '/internal/notification-schedule',
      body: { entityId, projectId: candidate.projectId, reason: 'timesheet', cycle: candidate.cycle },
    },
    source: {
      kind: 'system',
      method: 'SCHEDULE',
      route: '/internal/notification-schedule',
      ...(requestId ? { requestId } : {}),
    },
  })
  // The browser resolves the instant to the week in the reader's own timezone.
  const search = new URLSearchParams({ week: candidate.oldestStartAt })
  const oldestDate = candidate.oldestStartAt.slice(0, 10)
  return createAuditEvent({
    context,
    eventType: TIMESHEET_REMINDER_EVENT_TYPE,
    entity: { type: 'timesheet', id: entityId },
    action: 'submission-reminder',
    changes: [],
    summary: candidate.unsubmittedCount === 1
      ? `1 time entry from ${oldestDate} has not been submitted.`
      : `${candidate.unsubmittedCount} time entries since ${oldestDate} have not been submitted.`,
    metadata: {
      actorMemberKey: scheduleActorMemberKey,
      teamId: candidate.teamId,
      // Recipients are authorized against the entries' Project, which the timesheet lists.
      projectId: candidate.projectId,
      deepLink: `/teams/${encodeURIComponent(candidate.teamId)}/timesheet?${search.toString()}`,
      timeEntryIds: candidate.entryIds,
      timesheetDueBefore: candidate.dueBefore,
      notificationCandidates: [{ memberKey: candidate.memberKey, reason: 'timesheet' }],
    },
    expiresAt: calculateAuditExpiresAt(occurredAt, auditRetentionDays),
    outboxStatus: 'pending',
  })
}

/**
 * Creates the audit event that reminds an author, or tells one manager, about an unsubmitted
 * weekly report.
 *
 * The event ID is derived from the Workspace, Team, author, recipient, week, and kind, so retries
 * and later runs for the same week are duplicates. Delivery reads the week again and drops the
 * notification once the week has been submitted.
 *
 * @param candidate - Author, recipient, Project, and week.
 * @param now - Schedule execution instant.
 * @param auditRetentionDays - Audit event retention.
 * @param requestId - Schedule execution ID.
 * @returns Audit event row.
 */
function createWeeklyReportReminderAuditEvent(
  candidate: WeeklyReportReminderCandidate,
  now: Date,
  auditRetentionDays: number,
  requestId?: string,
) {
  const escalation = candidate.kind === 'escalation'
  const eventType = escalation ? WEEKLY_REPORT_ESCALATION_EVENT_TYPE : WEEKLY_REPORT_REMINDER_EVENT_TYPE
  const reason = escalation ? WEEKLY_REPORT_ESCALATION_REASON : WEEKLY_REPORT_REMINDER_REASON
  // Member keys may be email addresses, so the entity ID names only the Team and the week.
  const entityId = `team/${candidate.teamId}/weekly-report/${candidate.weekStart}`
  const occurredAt = now.toISOString()
  const idempotencyDigest = createHash('sha256').update([
    candidate.workspaceId,
    entityId,
    eventType,
    candidate.authorMemberKey,
    candidate.recipientMemberKey,
  ].join('\0')).digest('hex')
  const context = createMutationAuditContext({
    workspaceId: candidate.workspaceId,
    actor: {
      id: scheduleActorId,
      kind: 'system',
      displayName: 'Mukuroji notification schedule',
    },
    idempotencyKey: `notification-schedule-v1:${idempotencyDigest}`,
    occurredAt,
    request: {
      method: 'SCHEDULE',
      path: '/internal/notification-schedule',
      body: { entityId, projectId: candidate.projectId, reason, weekStart: candidate.weekStart },
    },
    source: {
      kind: 'system',
      method: 'SCHEDULE',
      route: '/internal/notification-schedule',
      ...(requestId ? { requestId } : {}),
    },
  })
  const search = new URLSearchParams({
    view: escalation ? 'team-weekly-reports' : 'weekly-report',
    week: candidate.weekStart,
  })
  const author = candidate.authorDisplayName ?? 'A member'
  return createAuditEvent({
    context,
    eventType,
    entity: { type: 'weekly-report', id: entityId },
    action: escalation ? 'submission-escalation' : 'submission-reminder',
    changes: [],
    summary: escalation
      ? `${author} has not submitted the weekly report for the week of ${candidate.weekStart}.`
      : `Your weekly report for the week of ${candidate.weekStart} has not been submitted.`,
    metadata: {
      actorMemberKey: scheduleActorMemberKey,
      teamId: candidate.teamId,
      // The author writes in this Project and, for an escalation, the recipient manages it.
      projectId: candidate.projectId,
      deepLink: `/teams/${encodeURIComponent(candidate.teamId)}/timesheet?${search.toString()}`,
      weeklyReportWeekStart: candidate.weekStart,
      weeklyReportAuthorMemberKey: candidate.authorMemberKey,
      notificationCandidates: [{ memberKey: candidate.recipientMemberKey, reason }],
    },
    expiresAt: calculateAuditExpiresAt(occurredAt, auditRetentionDays),
    outboxStatus: 'pending',
  })
}

/**
 * Maps a schedule stage to the recipient reason stored on the notification.
 *
 * @param stage - Scheduled Work Item stage.
 * @returns Recipient reason; repeated overdue reminders keep the `overdue` reason.
 */
function scheduledNotificationCandidateReason(stage: ScheduledNotificationReason) {
  if (stage === 'overdue-reminder') return 'overdue'
  if (stage === 'overdue-escalation') return 'escalation'
  return stage
}

/**
 * Creates the short Inbox summary for a scheduled Work Item stage.
 *
 * Reminder stages name the absolute due date instead of a countdown, because quiet hours,
 * digests, and retries can deliver them on a later calendar day than the scan.
 *
 * @param candidate - Work Item stage and its day offsets.
 * @returns English summary stored on the audit event.
 */
function createScheduledNotificationSummary(candidate: ScheduledNotificationCandidate) {
  const overdueDays = -(candidate.daysUntilDue ?? 0)
  switch (candidate.reason) {
    case 'due':
      return `Work Item "${candidate.title}" is due today.`
    case 'due-soon':
      return `Work Item "${candidate.title}" is due on ${candidate.dueDate}.`
    case 'overdue':
      return `Work Item "${candidate.title}" is overdue.`
    case 'overdue-reminder':
      return `Work Item "${candidate.title}" was due on ${candidate.dueDate} and is still overdue.`
    case 'overdue-escalation':
      // Escalations are delivered only while at least this overdue, so the lower bound holds.
      return `Work Item "${candidate.title}" was due on ${candidate.dueDate} and has been overdue for at least ${overdueDays} days.`
    case 'stale':
      return `Work Item "${candidate.title}" is in progress and has not been updated since ${(candidate.workItemUpdatedAt ?? '').slice(0, 10)}.`
  }
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
  if (record.target.type === 'team') {
    return await readCurrentScheduledTeamScope(
      options,
      record.workspaceId,
      record.target.teamId,
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

  const teamId = readOptionalPlanningScopeId(
    entity.teamId,
    'Planning Initiative Team scope',
  )
  const projectId = readOptionalPlanningScopeId(
    entity.projectId,
    'Planning Initiative Project scope',
  )
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
 * Reads the current Team directory row through the shared Workspace directory cache.
 *
 * @param options - Schedule dependencies and table names.
 * @param workspaceId - Canonical Workspace ID.
 * @param teamId - Expected current Team ID.
 * @param activeDirectoryByWorkspace - Workspace-scoped current Team / Project lookup cache.
 * @param pageSize - Directory query page size.
 * @param maxPages - Directory query safety bound.
 * @returns Current active Team scope.
 */
async function readCurrentScheduledTeamScope(
  options: NotificationScheduleRunOptions,
  workspaceId: string,
  teamId: string,
  activeDirectoryByWorkspace: Map<string, Promise<ReadonlySet<string>>>,
  pageSize: number,
  maxPages: number,
): Promise<PlanningScheduledTargetScope> {
  const tableName = requireText(
    options.projectDirectoryTableName,
    'Project Directory table name for Planning notification schedule',
  )
  let activeDirectory = activeDirectoryByWorkspace.get(workspaceId)
  if (!activeDirectory) {
    activeDirectory = readActiveScheduledProjectKeys(
      options,
      tableName,
      workspaceId,
      pageSize,
      maxPages,
    )
    activeDirectoryByWorkspace.set(workspaceId, activeDirectory)
  }
  const active = (await activeDirectory).has(createScheduledTeamKey(teamId))
  return active ? { active: true, teamId } : { active: false }
}

/**
 * Creates the directory cache key of one active Team, distinct from Team / Project keys.
 *
 * @param teamId - Canonical Team ID.
 * @returns Cache key that cannot collide with a `teamId\0projectId` key.
 */
function createScheduledTeamKey(teamId: string) {
  return `\0team\0${teamId}`
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
      if (item.entryType === 'team') {
        const teamId = requireText(item.teamId, 'Team directory team ID')
        if (item.archivedAt !== undefined) {
          requireTimestamp(item.archivedAt, 'Team directory archived timestamp')
          continue
        }
        activeProjects.add(createScheduledTeamKey(teamId))
        continue
      }
      if (item.entryType !== 'project') continue
      const teamId = requireText(item.teamId, 'Project directory team ID')
      const projectId = requireText(item.projectId, 'Project directory project ID')
      if (item.archivedAt !== undefined) {
        requireTimestamp(item.archivedAt, 'Project directory archived timestamp')
        continue
      }
      activeProjects.add(teamId + '\0' + projectId)
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
    : candidate.target.type === 'team'
    ? candidate.target.teamId
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
    : candidate.target.type === 'team'
    ? new URLSearchParams({ targetType: 'team', teamId: candidate.target.teamId })
    : new URLSearchParams({
        targetType: 'initiative',
        entityId: candidate.target.entityId,
      })
  const deepLink = `/planning/portfolio?${search.toString()}`
  const targetLabel = candidate.target.type === 'project'
    ? 'Project'
    : candidate.target.type === 'team'
    ? 'Team'
    : 'Initiative'
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
  if (value.type === 'team') {
    return {
      type: 'team',
      teamId: requireText(value.teamId, 'Planning update target Team ID'),
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
  if (target.type === 'team') {
    return `UPDATE_TARGET#TEAM#${encodePlanningRecordKeySegment(target.teamId)}`
  }
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
    const value = readText(loadServerConfig().environment[name])

    if (value) {
      return value
    }
  }

  throw new Error(`${names.join(' or ')} is required.`)
}

/**
 * Reads a positive integer environment value, treating unset or blank values as unset.
 *
 * @param name - Environment variable name.
 * @param fallback - Value used when the variable is unset or blank.
 * @returns The configured positive integer or the fallback.
 */
function readPositiveIntegerEnvironment(name: string, fallback: number) {
  const configured = loadServerConfig().environment[name]?.trim()

  if (!configured) {
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

/**
 * Reads an optional persisted Planning scope field without treating malformed values as absent.
 *
 * @param value - Raw persisted scope value.
 * @param label - Field name used in the schedule error.
 * @returns A trimmed scope identifier, or undefined when the field is absent.
 */
function readOptionalPlanningScopeId(value: unknown, label: string) {
  return value === undefined ? undefined : requireText(value, label)
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
