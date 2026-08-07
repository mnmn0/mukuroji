import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type CustomFieldValue,
  type WorkflowStatusCategory,
} from './work-item-configuration'
import type { WorkItemScheduleDependencyConflict } from './schedule-dependencies'

/**
 * 現在の canonical Work Item schema version です。
 */
export const WORK_ITEM_SCHEMA_VERSION = 2 as const

/** Maximum inclusive calendar span accepted by Work Item schedule arithmetic. */
export const WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS = 36_600 as const

/** Maximum distinct holiday dates stored in one Work Item calendar policy. */
export const WORK_ITEM_SCHEDULE_MAX_HOLIDAYS = 512 as const

/** Earliest four-digit Gregorian year accepted by every Work Item schedule boundary. */
export const WORK_ITEM_SCHEDULE_MIN_YEAR = 1_000 as const

/** Weekday names used by a Work Item schedule calendar policy. */
export type WorkItemScheduleWeekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday'

/** Calendar rules captured with a Work Item schedule for reproducible date arithmetic. */
export type WorkItemScheduleCalendarPolicy = {
  /** IANA timezone used when an instant must be mapped to a local calendar date. */
  timeZone: string
  /** Weekdays that count toward a task duration. */
  workingWeekdays: WorkItemScheduleWeekday[]
  /** Local `YYYY-MM-DD` dates excluded from working-duration calculations. */
  holidays: string[]
}

/** Default calendar policy used when a caller creates a new Work Item schedule. */
export const DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY: WorkItemScheduleCalendarPolicy = {
  timeZone: 'UTC',
  workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  holidays: [],
}

/** Fields shared by every explicit Work Item schedule state. */
type WorkItemScheduleBase = {
  /** Calendar policy applied to date movement and duration calculations. */
  calendarPolicy: WorkItemScheduleCalendarPolicy
  /** Planned effort independent from elapsed or working-day duration. */
  plannedEffortMinutes?: number
}

/** A Work Item with no planned calendar placement. */
export type UnscheduledWorkItemSchedule = WorkItemScheduleBase & {
  /** Explicitly distinguishes an item with no dates from incomplete date data. */
  mode: 'unscheduled'
}

/** A Work Item that has only a deadline and no inferred start date or duration. */
export type DueDateWorkItemSchedule = WorkItemScheduleBase & {
  /** Identifies a deadline-only schedule. */
  mode: 'due-date'
  /** Deadline as a local `YYYY-MM-DD` calendar date. */
  dueDate: string
}

/** A task occupying an inclusive working-date range. */
export type DateRangeWorkItemSchedule = WorkItemScheduleBase & {
  /** Identifies a duration-bearing task schedule. */
  mode: 'date-range'
  /** Inclusive local start date in `YYYY-MM-DD` form. */
  startDate: string
  /** Inclusive local end date in `YYYY-MM-DD` form. */
  endDate: string
  /** Number of working dates in the inclusive range under `calendarPolicy`. */
  durationDays: number
}

/** A zero-duration milestone placed on one local calendar date. */
export type MilestoneWorkItemSchedule = WorkItemScheduleBase & {
  /** Identifies a zero-duration milestone. */
  mode: 'milestone'
  /** Milestone date in `YYYY-MM-DD` form. */
  startDate: string
  /** Same date as `startDate`, retained for uniform range rendering. */
  endDate: string
  /** Milestones always have zero duration. */
  durationDays: 0
}

/** Canonical schedule states supported by Work Items. */
export type WorkItemSchedule =
  | UnscheduledWorkItemSchedule
  | DueDateWorkItemSchedule
  | DateRangeWorkItemSchedule
  | MilestoneWorkItemSchedule

/**
 * Derives the deadline-oriented read projection from a canonical schedule.
 *
 * @param schedule - Canonical schedule to project.
 * @returns The deadline or inclusive end date, or an empty string when unscheduled.
 */
export function deriveWorkItemScheduleDueDate(schedule: WorkItemSchedule): string {
  switch (schedule.mode) {
    case 'unscheduled':
      return ''
    case 'due-date':
      return schedule.dueDate
    case 'date-range':
    case 'milestone':
      return schedule.endDate
  }
}

/**
 * Creates an explicit unscheduled state under the default calendar policy.
 *
 * @param plannedEffortMinutes - Optional effort estimate independent from calendar placement.
 * @returns A detached unscheduled Work Item schedule.
 */
export function createDefaultUnscheduledWorkItemSchedule(
  plannedEffortMinutes?: number,
): UnscheduledWorkItemSchedule {
  if (
    plannedEffortMinutes !== undefined &&
    (!Number.isSafeInteger(plannedEffortMinutes) || plannedEffortMinutes < 0)
  ) {
    throw new RangeError('Planned effort minutes must be a nonnegative integer.')
  }

  return {
    calendarPolicy: {
      holidays: [],
      timeZone: DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY.timeZone,
      workingWeekdays: [...DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY.workingWeekdays],
    },
    mode: 'unscheduled',
    ...(plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes }),
  }
}

/**
 * Creates a deadline-only schedule under the default calendar policy.
 *
 * @param dueDate - Real calendar date in `YYYY-MM-DD` form.
 * @returns A due-date schedule using the default UTC Monday-to-Friday policy.
 */
export function createDefaultDueDateWorkItemSchedule(
  dueDate: string,
): DueDateWorkItemSchedule {
  if (!isIsoCalendarDate(dueDate)) {
    throw new RangeError(`Invalid Work Item schedule date: ${dueDate}`)
  }

  return {
    calendarPolicy: {
      holidays: [],
      timeZone: DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY.timeZone,
      workingWeekdays: [...DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY.workingWeekdays],
    },
    dueDate,
    mode: 'due-date',
  }
}

/**
 * Checks whether a value is a real ISO calendar date.
 *
 * @param value - Candidate `YYYY-MM-DD` value.
 * @returns True when the date round-trips through UTC calendar arithmetic.
 */
function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number(value.slice(0, 4)) >= WORK_ITEM_SCHEDULE_MIN_YEAR &&
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
}

/** A schedule operation shared by Gantt, Calendar, Table, and detail surfaces. */
export type WorkItemScheduleOperation =
  | {
      /** Replaces the complete schedule after server-side validation. */
      type: 'replace'
      /** Candidate schedule to validate and preview. */
      schedule: WorkItemSchedule
    }
  | {
      /** Moves a scheduled item while preserving its mode and duration. */
      type: 'move'
      /** New local date for the deadline, milestone, or range start. */
      targetDate: string
    }
  | {
      /** Changes the end of a date-range task and recalculates its duration. */
      type: 'resize'
      /** New inclusive local end date. */
      endDate: string
    }

/** Request used to preview one canonical Work Item schedule operation. */
export type PreviewWorkItemScheduleInput = {
  /** Revision observed before the preview request. */
  expectedRevision: number
  /** Schedule operation evaluated by the server domain logic. */
  operation: WorkItemScheduleOperation
}

/** One direct or dependency-propagated schedule change in a preview. */
export type WorkItemScheduleImpact = {
  /** Team that owns the affected Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  workItemId: string
  /** Whether the item is the mutation target or a dependency-propagated item. */
  kind: 'direct' | 'dependency'
  /** Revision that must still match before this impact can be applied safely. */
  expectedRevision: number
  /** Schedule before the proposed operation. */
  before: WorkItemSchedule
  /** Schedule after the proposed operation. */
  after: WorkItemSchedule
  /** Signed calendar-day movement of the affected schedule's primary date. */
  dateDeltaDays: number
  /** Canonical dependency that caused a propagated impact. */
  dependencyId?: string
}

/** One Work Item revision whose schedule participated in a server preview evaluation. */
export type WorkItemScheduleEvaluationRevision = {
  /** Team that owns the evaluated Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  workItemId: string
  /** Exact canonical revision observed while evaluating the preview. */
  expectedRevision: number
}

/** Server-validated preview shared by every schedule editing surface. */
export type WorkItemScheduleChangePreview = {
  /** Revision that must still match when the preview is applied. */
  expectedRevision: number
  /** Target Work Item followed by any dependency-propagated impacts. */
  impacts: WorkItemScheduleImpact[]
  /** Sorted revisions for every Work Item schedule that influenced this preview. */
  evaluatedRevisions: WorkItemScheduleEvaluationRevision[]
  /** Relation graph revision used to enumerate dependency impacts, when evaluated. */
  relationGraphRevision?: number
  /** Planning graph revision used to enumerate canonical schedule dependencies. */
  planningRevision?: number
  /** Conflicts that prevent automatic dependency propagation from being applied. */
  conflicts: WorkItemScheduleDependencyConflict[]
  /** Projects reached by the direct or propagated impacts. */
  affectedProjectIds: string[]
  /** Milestones reached through Planning Work Item links. */
  affectedMilestoneIds: string[]
  /** Whether applying this preview requires an explicit confirmation request. */
  requiresConfirmation: boolean
  /** Stable warning codes suitable for localized presentation. */
  warnings: string[]
}

/** Explicit confirmation request for a server-recomputed schedule change preview. */
export type ConfirmWorkItemScheduleChangeInput = PreviewWorkItemScheduleInput & {
  /** Planning graph revision returned by the preview. */
  expectedPlanningRevision: number
  /** Relation graph revision returned by the preview. */
  expectedRelationGraphRevision: number
  /** Exact evaluated Work Item revisions returned by the preview. */
  expectedEvaluatedRevisions: WorkItemScheduleEvaluationRevision[]
  /** Exact direct and propagated impacts returned by the preview. */
  expectedImpacts: WorkItemScheduleImpact[]
  /** Literal acknowledgement that the previewed ripple should be persisted. */
  confirmed: true
}

/** Result of applying every revision-bound schedule impact after confirmation. */
export type ConfirmWorkItemScheduleChangeResponse = {
  /** Compact, deterministic schedule results committed by the confirmed dependency cascade. */
  workItems: ConfirmedWorkItemSchedule[]
}

/** Compact canonical projection of one Work Item changed by schedule confirmation. */
export type ConfirmedWorkItemSchedule = {
  /** Team-local Work Item identifier. */
  id: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Revision committed by the schedule cascade. */
  revision: number
  /** Complete canonical schedule committed by the cascade. */
  schedule: WorkItemSchedule
  /** Deadline projection derived from the committed schedule. */
  dueDate: string
  /** Assigned Project at the instant the schedule result was committed. */
  assignedProjectId?: string
}

/**
 * Work Item の進捗状態です。
 */
export type WorkItemStatus = 'in-progress' | 'review' | 'todo' | 'done'

/**
 * Work Item の優先度です。
 */
export type WorkItemPriority = 'high' | 'medium' | 'low'

/**
 * Work Item に関連する approval の集計です。
 */
export type ApprovalSummary = {
  /**
   * 判断待ち approval 件数です。
   */
  pendingCount: number
  /**
   * 期限を過ぎた判断待ち approval 件数です。
   */
  overdueCount: number
  /**
   * 承認済み approval 件数です。
   */
  approvedCount: number
  /**
   * 却下済み approval 件数です。
   */
  rejectedCount: number
  /**
   * 変更要求中 approval 件数です。
   */
  changesRequestedCount: number
  /**
   * 判断待ち approval の最も近い期限です。
   */
  nextDueAt?: string
}

/**
 * Canonical Work Item が共有する field です。
 */
type WorkItemBase = {
  /**
   * contract の schema version です。
   */
  schemaVersion: typeof WORK_ITEM_SCHEMA_VERSION
  /**
   * optimistic concurrency に使う単調増加 revision です。
   */
  revision: number
  /**
   * Work Item を識別する ID です。
   */
  id: string
  /**
   * Work Item を所有する Team ID です。
   */
  teamId: string
  /**
   * Work Item の遂行先として割り当てられた Project ID です。
   */
  assignedProjectId?: string
  /**
   * Work Item の詳細説明です。
   */
  description?: string
  /**
   * 担当者を参照する Workspace user ID です。
   */
  assigneeUserId?: string
  /**
   * 担当者のメールアドレスです。
   */
  assigneeEmail?: string
  /**
   * 担当者の表示名です。
   */
  assigneeName?: string
  /**
   * Deadline-oriented read projection derived from `schedule`; empty only for `unscheduled`.
   */
  dueDate: string
  /** Canonical schedule shared by every Work Item view and mutation surface. */
  schedule: WorkItemSchedule
  /**
   * Work Item の優先度です。
   */
  priority: WorkItemPriority
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt?: string
  /**
   * 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt?: string
  /**
   * Reversible bulk archive を適用した ISO 8601 timestamp です。
   */
  archivedAt?: string
  /**
   * Archive mutation を実行した Workspace member key です。
   */
  archivedBy?: string
  /**
   * Work Item approval の現在状態を Workspace Inbox / report へ投影する集計です。
   */
  approvalSummary?: ApprovalSummary
}

/** DynamoDB に保存された canonical Work Item の API contract です。 */
export type CanonicalWorkItem = WorkItemBase & {
  /** API から取得した literal のタイトルです。 */
  title: string
  /** Canonical Work Item は表示文言 key を持ちません。 */
  titleKey?: never
  /** 担当者を参照する Workspace user ID です。 */
  assigneeUserId: string
  /** Work Item を作成した Workspace member key です。 */
  creatorMemberKey: string
  /** Request intake から作成された場合の source submission ID です。 */
  sourceRequestId?: string
  /** Canonical Work Item は legacy の担当者 literal を持ちません。 */
  assignee?: never
  /** Canonical Work Item は legacy の担当者表示文言 key を持ちません。 */
  assigneeKey?: never
  /** Canonical Work Item は旧固定 status を持ちません。 */
  status?: never
  /** Configuration workflow 内の status ID です。 */
  workflowStatusId: string
  /** List/report の横断集計に利用する標準 status category です。 */
  statusCategory: WorkflowStatusCategory
  /** Value を検証した workflow configuration schema version です。 */
  workflowSchemaVersion: typeof WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  /** Work Item に保存された custom field value です。 */
  customFieldValues: Record<string, CustomFieldValue>
  /** Relation Graph から同期した search/filter 用の派生 relation ID 一覧です。 */
  relationIds: string[]
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 最終更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
  /** Canonical table を保存元とすることを表します。 */
  source: 'dynamodb'
}

/** Canonical Team/project/Workspace API と画面が共有する Work Item です。 */
export type WorkItem = CanonicalWorkItem

/**
 * canonical Work Item 作成 API の入力です。
 */
export type CreateWorkItemInput = {
  /**
   * Work Item のタイトルです。
   */
  title: string
  /**
   * Work Item の詳細説明です。
   */
  description?: string
  /**
   * 遂行先 Project ID です。
   */
  assignedProjectId?: string
  /**
   * 担当者を参照する Workspace user ID です。
   */
  assigneeUserId: string
  /**
   * 作成時に適用する workflow status ID です。
   */
  workflowStatusId?: string
  /**
   * 作成時に保存する custom field value です。
   */
  customFieldValues?: Record<string, CustomFieldValue>
  /**
   * Backlog/Triage に required custom field を未入力のまま仮保存するかどうかです。
   */
  quickCapture?: boolean
  /** Complete canonical schedule for the new Work Item. */
  schedule: WorkItemSchedule
  /**
   * Work Item の優先度です。
   */
  priority: WorkItemPriority
}

/**
 * canonical Work Item に適用できる変更内容です。
 */
export type WorkItemPatch = {
  /**
   * 変更後のタイトルです。
   */
  title?: string
  /**
   * 変更後の詳細説明です。
   */
  description?: string
  /**
   * 変更後の遂行先 Project ID です。null で未割り当てに戻します。
   */
  assignedProjectId?: string | null
  /**
   * 変更後の担当者 ID です。
   */
  assigneeUserId?: string
  /**
   * 変更後の workflow status ID です。
   */
  workflowStatusId?: string
  /**
   * Field ID ごとの変更値です。null は value の削除を表します。
   */
  customFieldValues?: Record<string, CustomFieldValue | null>
  /** Complete replacement schedule used by all interactive planning views. */
  schedule?: WorkItemSchedule
  /**
   * 変更後の優先度です。
   */
  priority?: WorkItemPriority
}

/**
 * optimistic concurrency を伴う canonical Work Item 更新 API の入力です。
 */
export type UpdateWorkItemInput = WorkItemPatch & {
  /**
   * 読み込み時点の Work Item revision です。
   */
  expectedRevision: number
}

/**
 * Work Item 間で管理できる relation 種別です。
 */
export type WorkItemRelationType =
  | 'parent'
  | 'child'
  | 'blocks'
  | 'blockedBy'
  | 'related'
  | 'duplicate'

/**
 * Work Item から別の Work Item への relation です。
 */
export type WorkItemRelation = {
  /** Relation の起点 Work Item ID です。 */
  sourceWorkItemId: string
  /** Relation の向きと意味です。 */
  type: WorkItemRelationType
  /** Relation の終点 Work Item ID です。 */
  targetWorkItemId: string
  /** Relation の作成日時です。 */
  createdAt?: string
}

/**
 * Relation 作成・削除 API の共通入力です。
 */
export type WorkItemRelationMutationInput = {
  /** 起点から見た relation 種別です。 */
  type: WorkItemRelationType
  /** Relation の終点 Work Item ID です。 */
  targetWorkItemId: string
  /** 読み込み時点の Team relation graph revision です。 */
  expectedGraphRevision: number
}

/**
 * Relation 作成・削除 API の response です。
 */
export type WorkItemRelationMutationResponse = {
  /** 起点 Work Item から見た relation です。 */
  relation: WorkItemRelation
  /** 終点 Work Item に保存する reciprocal relation です。 */
  reciprocalRelation: WorkItemRelation
  /** Mutation 後の Team relation graph revision です。 */
  graphRevision: number
}

/**
 * Work Item relation 一覧 API の response です。
 */
export type WorkItemRelationsResponse = {
  /** 起点 Work Item に保存された relation 一覧です。 */
  relations: WorkItemRelation[]
  /** 読み込み時点の Team relation graph revision です。 */
  graphRevision: number
}
