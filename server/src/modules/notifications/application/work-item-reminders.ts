import {
  NOTIFICATION_REMINDER_DAY_FIELDS,
  NOTIFICATION_REMINDER_DAYS_MAXIMUM,
  PERSONAL_NOTIFICATION_REMINDER_DAY_FIELDS,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  type NotificationReminderDays,
  type PersonalNotificationReminderDays,
  type TeamNotificationReminderDays,
} from '@mukuroji/contracts'
import {
  isCanonicalWorkItemRecord,
  workItemScheduleInstantToLocalDate,
} from '../../work-items'
import { isNotificationReminderDayCount } from '../domain/reminder-days'
import type { ScheduledReminderSettingsReader } from './ports/reminder-settings-reader'

/**
 * Work Item notification stages emitted by the schedule. Each stage maps to the audit event type
 * `work-item.<stage>`.
 */
export type ScheduledNotificationReason =
  | 'due'
  | 'due-soon'
  | 'overdue'
  | 'overdue-reminder'
  | 'overdue-escalation'
  | 'stale'

/**
 * Day-based thresholds for scheduled Work Item and timesheet reminders. The schedule resolves one
 * policy per recipient from the member's own overrides, the Team's overrides, and the deployment
 * defaults, in that order.
 */
export type WorkItemReminderPolicy = NotificationReminderDays

/** Default reminder thresholds used when no environment override is configured. */
export const DEFAULT_WORK_ITEM_REMINDER_POLICY: WorkItemReminderPolicy = Object.freeze({
  dueSoonDays: 3,
  overdueReminderIntervalDays: 7,
  overdueEscalationDays: 7,
  staleStartedDays: 7,
  timesheetReminderDays: 7,
})

/**
 * Resolves the effective thresholds for one recipient.
 *
 * A member's own value wins over the Team's, which wins over the deployment default. Overdue
 * escalation is not a personal setting, so it always comes from the Team or the default.
 *
 * @param defaults - Validated deployment defaults.
 * @param team - Team overrides, when the Team saved any.
 * @param personal - The recipient's own overrides, when they saved any.
 * @returns Complete thresholds for the recipient.
 */
export function resolveWorkItemReminderPolicy(
  defaults: WorkItemReminderPolicy,
  team: TeamNotificationReminderDays | undefined,
  personal: PersonalNotificationReminderDays | undefined,
): WorkItemReminderPolicy {
  const resolved: WorkItemReminderPolicy = { ...defaults }
  for (const field of NOTIFICATION_REMINDER_DAY_FIELDS) {
    const teamValue = team?.[field]
    if (teamValue !== undefined) resolved[field] = teamValue
  }
  for (const field of PERSONAL_NOTIFICATION_REMINDER_DAY_FIELDS) {
    const personalValue = personal?.[field]
    if (personalValue !== undefined) resolved[field] = personalValue
  }
  return resolved
}

/** Work Item から正規化した期限通知 candidate です。 */
export type ScheduledNotificationCandidate = {
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
  /** schedule が生成する notification stage です。 */
  reason: ScheduledNotificationReason
  /** Whole days between today and the due date (positive before, negative after). */
  daysUntilDue?: number
  /** Repetition index for overdue reminders and stale reminders. */
  repetition?: number
  /** Work Item `updatedAt` that a stale reminder was computed from. */
  workItemUpdatedAt?: string
  /** Interval in days that numbered a repeated overdue or stale reminder. */
  reminderIntervalDays?: number
  /** Project manager notified by an escalation stage; other stages notify the owner. */
  escalationMemberKey?: string
  /** IANA time zone of the Work Item calendar the stage was evaluated in. */
  calendarTimeZone?: string
  /** When the Work Item last reopened; a new value restarts the escalation stage. */
  reopenedAt?: string
}

/** Work Item stage evaluation before Project managers are resolved for escalation. */
export type ScheduledWorkItemEvaluation = {
  /** Owner-facing stages ready to emit. */
  candidates: ScheduledNotificationCandidate[]
  /** Escalation stage waiting for the current Project managers. */
  escalation?: ScheduledNotificationCandidate
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
 * Evaluates every scheduled notification stage for one Work Item at the schedule instant.
 *
 * Dates use the Work Item schedule's local calendar. The owner gets `due-soon` within the
 * configured window, `due` on the due date, `overdue` once per due date (its deterministic key makes
 * later runs duplicates), and `overdue-reminder` once per reminder interval after that. Archived
 * Work Items get nothing. A started Work Item that is not
 * overdue and has not been updated for the stale window gets one `stale` reminder per window.
 * Project managers are resolved by the caller for the escalation stage.
 *
 * @param item - Candidate canonical Work Item row.
 * @param now - Absolute schedule execution instant.
 * @param policy - Normalized reminder thresholds.
 * @returns Owner-facing candidates and an optional escalation stage.
 * @throws TypeError when the row is not a canonical Work Item.
 */
export function evaluateScheduledWorkItemNotifications(
  item: Record<string, unknown>,
  now: Date,
  policy: WorkItemReminderPolicy = DEFAULT_WORK_ITEM_REMINDER_POLICY,
): ScheduledWorkItemEvaluation {
  if (!isCanonicalWorkItemRecord(item)) {
    throw new TypeError(
      'Notification schedule encountered a non-canonical Work Item row.',
    )
  }

  const assigneeMemberKey = item.assigneeUserId.toLowerCase()
  if (
    item.archivedAt !== undefined ||
    !assigneeMemberKey ||
    !isActiveWorkflowStatusCategory(item.statusCategory)
  ) {
    return { candidates: [] }
  }

  const today = workItemScheduleInstantToLocalDate(now, item.schedule.calendarPolicy)
  const dueDate = parseUtcDateOnly(item.dueDate)
  const base = {
    workspaceId: item.directoryId,
    teamId: item.teamId,
    issueId: item.issueId,
    assigneeMemberKey,
    ...(item.assignedProjectId ? { projectId: item.assignedProjectId } : {}),
    title: item.title,
    calendarTimeZone: item.schedule.calendarPolicy.timeZone,
  }
  const candidates: ScheduledNotificationCandidate[] = []
  let escalation: ScheduledNotificationCandidate | undefined

  if (dueDate) {
    const daysUntilDue = daysBetweenDateOnly(today, dueDate)
    if (daysUntilDue === 0) {
      candidates.push({ ...base, dueDate, reason: 'due', daysUntilDue })
    } else if (daysUntilDue > 0 && daysUntilDue <= policy.dueSoonDays) {
      candidates.push({ ...base, dueDate, reason: 'due-soon', daysUntilDue })
    } else if (daysUntilDue < 0) {
      const overdueDays = -daysUntilDue
      const repetition = Math.floor(overdueDays / policy.overdueReminderIntervalDays)
      // The initial overdue event keeps its once-per-due-date key on every run, so an item first
      // scanned long after its due date still emits it for Automation overdue triggers.
      candidates.push({ ...base, dueDate, reason: 'overdue', daysUntilDue })
      if (repetition > 0) {
        candidates.push({
          ...base,
          dueDate,
          reason: 'overdue-reminder',
          daysUntilDue,
          repetition,
          reminderIntervalDays: policy.overdueReminderIntervalDays,
        })
      }
      if (overdueDays >= policy.overdueEscalationDays && base.projectId) {
        escalation = {
          ...base,
          dueDate,
          reason: 'overdue-escalation',
          daysUntilDue,
          ...(typeof item.reopenedAt === 'string' ? { reopenedAt: item.reopenedAt } : {}),
        }
      }
    }
  }

  // Overdue reminders already nag the owner, so a stale reminder only covers open-dated work.
  const overdue = dueDate !== undefined && daysBetweenDateOnly(today, dueDate) < 0
  if (item.statusCategory === 'started' && !overdue) {
    const updatedAt = Date.parse(item.updatedAt)
    const idleDays = Number.isFinite(updatedAt)
      ? Math.floor((now.getTime() - updatedAt) / 86_400_000)
      : 0
    const repetition = Math.floor(idleDays / policy.staleStartedDays)
    if (repetition >= 1) {
      candidates.push({
        ...base,
        dueDate: dueDate ?? '',
        reason: 'stale',
        repetition,
        reminderIntervalDays: policy.staleStartedDays,
        workItemUpdatedAt: item.updatedAt,
      })
    }
  }

  return { candidates, ...(escalation ? { escalation } : {}) }
}

/**
 * Counts whole calendar days from one canonical date-only value to another.
 *
 * @param from - Start date in `YYYY-MM-DD` form.
 * @param to - End date in `YYYY-MM-DD` form.
 * @returns Days from `from` to `to`; negative when `to` is earlier.
 */
function daysBetweenDateOnly(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * Fills omitted reminder thresholds with defaults and validates configured values.
 *
 * @param policy - Partial reminder thresholds from the caller.
 * @returns Complete, validated reminder thresholds.
 * @throws RangeError when a threshold is not a positive integer.
 */
export function normalizeWorkItemReminderPolicy(
  policy: Partial<WorkItemReminderPolicy> | undefined,
): WorkItemReminderPolicy {
  const merged = { ...DEFAULT_WORK_ITEM_REMINDER_POLICY, ...policy }
  return {
    dueSoonDays: readPolicyDays(merged.dueSoonDays, 'Due-soon days'),
    overdueReminderIntervalDays: readPolicyDays(
      merged.overdueReminderIntervalDays,
      'Overdue reminder interval days',
    ),
    overdueEscalationDays: readPolicyDays(merged.overdueEscalationDays, 'Overdue escalation days'),
    staleStartedDays: readPolicyDays(merged.staleStartedDays, 'Stale started days'),
    timesheetReminderDays: readPolicyDays(merged.timesheetReminderDays, 'Timesheet reminder days'),
  }
}

/** 期限通知の対象となる非終端 workflow category か判定します。 */
function isActiveWorkflowStatusCategory(value: string | undefined) {
  return value === 'backlog' || value === 'unstarted' || value === 'started'
}

/**
 * Validates one reminder threshold.
 *
 * @param value - Configured number of days.
 * @param label - Threshold name used in the error.
 * @returns The validated number of days.
 * @throws RangeError when the value is not an integer from 1 to the shared maximum.
 */
function readPolicyDays(value: number, label: string) {
  if (!isNotificationReminderDayCount(value)) {
    throw new RangeError(
      `${label} must be an integer between 1 and ${NOTIFICATION_REMINDER_DAYS_MAXIMUM}.`,
    )
  }

  return value
}

/** Reads a non-blank string with surrounding whitespace removed. */
function readText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Resolves the effective reminder thresholds for one Work Item owner in one Team. */
export type ReminderPolicyResolver = (
  workspaceId: string,
  teamId: string,
  memberKey: string,
) => Promise<WorkItemReminderPolicy>

/**
 * Creates a resolver that reads Team and personal overrides once per schedule run.
 *
 * Without a reader every recipient gets the deployment defaults. Reads are cached for the run, so
 * a Team or member read by many Work Items costs one lookup.
 *
 * @param defaults - Validated deployment defaults.
 * @param reader - Saved override reader, when settings are configured.
 * @returns Resolver for one schedule run.
 */
export function createReminderPolicyResolver(
  defaults: WorkItemReminderPolicy,
  reader: ScheduledReminderSettingsReader | undefined,
): ReminderPolicyResolver {
  const teams = new Map<string, Promise<TeamNotificationReminderDays | undefined>>()
  const members = new Map<string, Promise<PersonalNotificationReminderDays | undefined>>()
  return async (workspaceId, teamId, memberKey) => {
    if (!reader) return defaults
    const teamKey = `${workspaceId}\0${teamId}`
    let team = teams.get(teamKey)
    if (!team) {
      team = reader.readTeamReminderDays(workspaceId, teamId)
      teams.set(teamKey, team)
    }
    const memberCacheKey = `${workspaceId}\0${memberKey}`
    let personal = members.get(memberCacheKey)
    if (!personal) {
      personal = reader.readPersonalReminderDays(workspaceId, memberKey)
      members.set(memberCacheKey, personal)
    }
    return resolveWorkItemReminderPolicy(defaults, await team, await personal)
  }
}
