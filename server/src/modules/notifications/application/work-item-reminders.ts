import { WORK_ITEM_SCHEDULE_MIN_YEAR } from '@mukuroji/contracts'
import {
  isCanonicalWorkItemRecord,
  workItemScheduleInstantToLocalDate,
} from '../../work-items'

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

/** Day-based thresholds for scheduled Work Item reminders. */
export type WorkItemReminderPolicy = {
  /** Days before the due date when the owner gets the due-soon notification. */
  dueSoonDays: number
  /** Interval in days between repeated overdue notifications to the owner. */
  overdueReminderIntervalDays: number
  /** Days past the due date after which Project managers are notified once. */
  overdueEscalationDays: number
  /** Days without an update after which a started Work Item's owner is reminded. */
  staleStartedDays: number
}

/** Default reminder thresholds used when no environment override is configured. */
export const DEFAULT_WORK_ITEM_REMINDER_POLICY: WorkItemReminderPolicy = {
  dueSoonDays: 3,
  overdueReminderIntervalDays: 7,
  overdueEscalationDays: 7,
  staleStartedDays: 7,
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
        candidates.push({ ...base, dueDate, reason: 'overdue-reminder', daysUntilDue, repetition })
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
    dueSoonDays: readPolicyDays(merged.dueSoonDays, 'Due-soon days', 365),
    overdueReminderIntervalDays: readPolicyDays(
      merged.overdueReminderIntervalDays,
      'Overdue reminder interval days',
      365,
    ),
    overdueEscalationDays: readPolicyDays(
      merged.overdueEscalationDays,
      'Overdue escalation days',
      365,
    ),
    staleStartedDays: readPolicyDays(merged.staleStartedDays, 'Stale started days', 365),
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
 * @param maximum - Largest accepted number of days.
 * @returns The validated number of days.
 * @throws RangeError when the value is not an integer from 1 to `maximum`.
 */
function readPolicyDays(value: number, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}.`)
  }

  return value
}

/** Reads a non-blank string with surrounding whitespace removed. */
function readText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
