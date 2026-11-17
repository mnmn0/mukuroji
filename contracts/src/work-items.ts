import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type CustomFieldValue,
  type WorkflowStatusCategory,
} from './work-item-configuration'
import type {
  WorkItemAffectedProject,
  WorkItemScheduleDependencyConflict,
} from './schedule-dependencies'
import type {
  WorkItemContributorAssignment,
  WorkItemContributorAssignmentCreateInput,
  WorkItemContributorAssignmentInput,
} from './work-item-contributors'
import type { WorkItemAcceptanceCriterion, WorkItemAcceptanceCriterionInput } from './work-item-acceptance-criteria'
import type {
  TriageEntryEvent,
  TriagePermissionVisibility,
  TriageSourceKind,
} from './triage'

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

/** Maximum Work Item title length in Unicode code points, matching the coding-agent MCP limit. */
export const WORK_ITEM_TITLE_MAX_LENGTH = 256 as const

/**
 * Shortens text from another source, such as a Triage entry or a request form answer, to a Work Item title.
 *
 * @param title - Trimmed source title.
 * @returns The title itself, or its first code points followed by an ellipsis when it is too long.
 */
export function fitWorkItemTitle(title: string): string {
  const codePoints = [...title]
  if (codePoints.length <= WORK_ITEM_TITLE_MAX_LENGTH) return title
  return `${codePoints.slice(0, WORK_ITEM_TITLE_MAX_LENGTH - 1).join('').trimEnd()}…`
}

/** Highest sequence number a Work Item key can carry within one Team prefix. */
export const WORK_ITEM_KEY_MAX_NUMBER = 999_999_999 as const

/**
 * Short, immutable Work Item reference such as `ABC-123`: a Team key prefix of two to ten
 * uppercase letters or digits that starts with a letter, a hyphen, and a sequence number
 * without leading zeros.
 */
const WORK_ITEM_KEY_PATTERN = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]{0,8})$/u

/** The two parts of a parsed Work Item key. */
export type ParsedWorkItemKey = {
  /** Team key prefix, such as `ABC`. */
  prefix: string
  /** Positive sequence number allocated by the Team counter. */
  number: number
  /** Canonical uppercase key text, such as `ABC-123`. */
  key: string
}

/**
 * Parses a Work Item key, accepting surrounding whitespace and lowercase letters.
 *
 * @param value - Untrusted key text, for example from a URL or a search box.
 * @returns The canonical key parts, or `undefined` when the text is not a Work Item key.
 */
export function parseWorkItemKey(value: unknown): ParsedWorkItemKey | undefined {
  if (typeof value !== 'string') return undefined
  const match = WORK_ITEM_KEY_PATTERN.exec(value.trim().toUpperCase())
  if (!match?.[1] || !match[2]) return undefined
  const number = Number(match[2])
  if (!Number.isSafeInteger(number) || number > WORK_ITEM_KEY_MAX_NUMBER) return undefined
  return { prefix: match[1], number, key: `${match[1]}-${number}` }
}

/**
 * Reports whether a value is a Work Item key in its canonical uppercase form.
 *
 * @param value - Candidate stored or received key.
 * @returns Whether the value is already canonical, so it can be stored or compared as is.
 */
export function isCanonicalWorkItemKey(value: unknown): value is string {
  return typeof value === 'string' && parseWorkItemKey(value)?.key === value
}

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
  /** Team-qualified Projects reached by the direct or propagated impacts. */
  affectedProjects: WorkItemAffectedProject[]
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
  /**
   * 判断待ち approval の期限一覧です。重複値は同一期限の別 approval を表します。
   */
  pendingDueAt?: string[]
  /**
   * Timestamp of the latest approval mutation represented by this aggregate.
   */
  updatedAt?: string
}

/** Stable comment projection returned by the Work Item comment list and create responses. */
export type TeamIssueCommentResponseItem = {
  /** Stable comment identifier. */
  id: string
  /** Workspace member key of the comment author. */
  actorUserId: string
  /** Markdown comment body. */
  body: string
  /** ISO 8601 creation timestamp. */
  createdAt: string
}

/** DynamoDB に保存された canonical Work Item の API contract です。 */
export type CanonicalWorkItem = {
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
   * Short immutable reference such as `ABC-123`, unique in the Workspace. Work Items created
   * before keys existed omit it until they are backfilled.
   */
  key?: string
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
  /** Timestamp of the latest mutation that changed the priority value. */
  priorityUpdatedAt?: string
  /** Timestamp of the latest mutation that changed the derived due date. */
  dueDateUpdatedAt?: string
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
  /** API から取得した literal のタイトルです。 */
  title: string
  /** Canonical Work Item は表示文言 key を持ちません。 */
  titleKey?: never
  /**
   * Workspace user ID of the single accountable owner. Contributors who carry out
   * part of the work are listed separately in `contributorAssignments`.
   */
  assigneeUserId: string
  /** Contributors carrying out the work, separate from the accountable owner; absent when none. */
  contributorAssignments?: WorkItemContributorAssignment[]
  /** Conditions the Work Item must meet before it is accepted; absent when none. */
  acceptanceCriteria?: WorkItemAcceptanceCriterion[]
  /** Work Item を作成した Workspace member key です。 */
  creatorMemberKey: string
  /** Request intake から作成された場合の source submission ID です。 */
  sourceRequestId?: string
  /** Team Triage から作成された場合の source Entry ID です。 */
  sourceTriageEntryId?: string
  /** Canonical Work Item は legacy の担当者 literal を持ちません。 */
  assignee?: never
  /** Canonical Work Item は legacy の担当者表示文言 key を持ちません。 */
  assigneeKey?: never
  /** Canonical Work Item は旧固定 status を持ちません。 */
  status?: never
  /** Configuration workflow 内の status ID です。 */
  workflowStatusId: string
  /** Stable Work Item Type identifier. Legacy rows omit this and resolve to the built-in type. */
  workItemTypeId?: string
  /** List/report の横断集計に利用する標準 status category です。 */
  statusCategory: WorkflowStatusCategory
  /** Value を検証した workflow configuration schema version です。 */
  workflowSchemaVersion: typeof WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  /** Work Item に保存された custom field value です。 */
  customFieldValues: Record<string, CustomFieldValue>
  /**
   * Relation Graph から同期した search/filter 用の派生 relation ID 一覧です。
   *
   * `child` relation は含めません。子は子側の `parent:<id>` で引けるため、親の子の数に上限はありません。
   * それ以外の relation は {@link WORK_ITEM_RELATION_ID_LIMIT} 件までです。
   */
  relationIds: string[]
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 最終更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
  /** Canonical table を保存元とすることを表します。 */
  source: 'dynamodb'
}

/** The permission-safe amount of source context retained with a duplicate Work Item merge. */
export type WorkItemTriageContextAvailability =
  | 'summary-metadata'
  | 'counts-only'
  | 'restricted'
  | 'redacted'

/** One allowlisted Triage history summary retained with a canonical Work Item. */
export type WorkItemTriageContextEventSnapshot = {
  /** Stable Triage event identifier retained for provenance and de-duplication. */
  eventId: string
  /** Provider-neutral Triage lifecycle event type. */
  type: TriageEntryEvent['type']
  /** Bounded provider-secret-free summary captured by Team Triage. */
  summary: string
  /** ISO 8601 instant when the source-side event occurred. */
  createdAt: string
}

/**
 * De-identified source provenance retained atomically on a canonical Work Item duplicate merge.
 *
 * Source bodies, requester identity, raw provider IDs, permalinks, attachment names, and watcher
 * identities are deliberately excluded. Access is therefore governed by the canonical Work Item,
 * while source retention or later redaction cannot erase this bounded operational snapshot.
 */
export type WorkItemTriageContextSnapshot = {
  /** Triage Entry that contributed the duplicate context. */
  triageEntryId: string
  /** Provider-neutral intake channel. */
  sourceKind: TriageSourceKind
  /** Source visibility that was live-authorized when the merge was prepared. */
  visibilityAtMerge: TriagePermissionVisibility
  /** Amount of permission-safe context included in this snapshot. */
  availability: WorkItemTriageContextAvailability
  /** Source receipt instant retained for provenance ordering. */
  receivedAt: string
  /** Most recent source activity instant observed before the merge. */
  lastActivityAt: string
  /** Source retention boundary observed before the merge. */
  sourceRetentionExpiresAt: string
  /** Source redaction instant when redaction had already occurred before the merge. */
  sourceRedactedAt?: string
  /** Number of source comments represented by retained metadata at merge time. */
  commentMetadataCount: number
  /** Number of source attachments represented by retained metadata at merge time. */
  attachmentMetadataCount: number
  /** Number of source watchers represented by retained metadata at merge time. */
  watcherMetadataCount: number
  /** Bounded internal lifecycle summaries included only under full source visibility. */
  events: WorkItemTriageContextEventSnapshot[]
  /** ISO 8601 instant when the snapshot and duplicate resolution committed atomically. */
  mergedAt: string
}

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
   * Workspace user ID of the single accountable owner.
   */
  assigneeUserId: string
  /** Contributors to plan for the new Work Item; new assignments never carry an ID. */
  contributorAssignments?: WorkItemContributorAssignmentCreateInput[]
  /** Stable Work Item Type selected for the new Work Item. */
  workItemTypeId?: string
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
   * Workspace user ID of the new accountable owner.
   */
  assigneeUserId?: string
  /** Complete replacement list of contributors; an empty list removes every contributor. */
  contributorAssignments?: WorkItemContributorAssignmentInput[]
  /**
   * Complete replacement list of acceptance criteria; an empty list removes every criterion. An agent
   * fenced by its Agent Run may only change `satisfied` of the existing criteria.
   */
  acceptanceCriteria?: WorkItemAcceptanceCriterionInput[]
  /** Stable Work Item Type that should replace the current type. */
  workItemTypeId?: string
  /** Explicit acknowledgement for fields or status affected by a type change. */
  typeChangeResolution?: import('./work-item-types').WorkItemTypeChangeResolution
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
 * 1 つの Work Item が `relationIds` に持てる relation の上限です。
 *
 * `child` relation は数えないため、1 つの親に付けられる子の数には上限がありません。
 */
export const WORK_ITEM_RELATION_ID_LIMIT = 100

/**
 * 1 つの Team が保存できる親子・依存・関連 relation（reciprocal の 2 row で 1 link）の上限です。
 *
 * Relation の作成・削除・付け替えはこの件数の全件読み取りに依存しません。Focus や Team 設定の検証のように
 * Team の relation を一括で読む処理の読み取り量を抑えるための上限です。
 */
export const WORK_ITEM_TEAM_RELATION_LINK_LIMIT = 10_000

/**
 * Work Item 間で管理できる relation 種別です。
 *
 * `parent` は 1 つの Work Item につき最大 1 件です。2 つ目の親は作成 API で拒否され、
 * 親の付け替えは {@link WorkItemParentMutationInput} の API で 1 回の原子的な置換として行います。
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
 * 親の設定・付け替え・解除 API の入力です。
 */
export type WorkItemParentMutationInput = {
  /** 新しい親 Work Item ID です。`null` は親を外します。 */
  parentWorkItemId: string | null
  /** 読み込み時点の Team relation graph revision です。 */
  expectedGraphRevision: number
}

/**
 * 親の設定・付け替え・解除 API の response です。
 */
export type WorkItemParentMutationResponse = {
  /** 変更前の親 Work Item ID です。親が無かった場合は `null` です。 */
  previousParentWorkItemId: string | null
  /** 変更後の親 Work Item ID です。親を外した場合は `null` です。 */
  parentWorkItemId: string | null
  /** Mutation 後の Team relation graph revision です。変更が無い場合は読み込み時点の revision です。 */
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

/**
 * Response of `GET /api/work-items/keys/{key}`, which resolves a Work Item key to the Work Item
 * it names so a client can open it.
 */
export type WorkItemKeyLookupResponse = {
  /** Canonical uppercase key that was resolved. */
  key: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID within the Team. */
  workItemId: string
}

/**
 * Response of `GET /api/v1/work-items/{workItemId}/key`, which tells a Public API client the
 * Work Item key without adding a property to the stable `WorkItem` schema.
 */
export type PublicWorkItemKey = {
  /** Response schema version. */
  schemaVersion: 1
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID within the Team. */
  workItemId: string
  /**
   * When the Work Item was created. A Work Item ID created again after deletion has a new value,
   * so a client can tell which Work Item the key belongs to.
   */
  createdAt: string
  /** Canonical key such as `ABC-123`, absent on Work Items created before keys existed. */
  key?: string
}
