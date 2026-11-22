/**
 * Seeds demo data into the local stack through the running server's API.
 *
 * Usage (with `bun run dev` or `bun run server:dev` running against Floci):
 *   bun run demo-data:seed
 *   MUKUROJI_DEMO_API_URL=http://localhost:5173 bun run demo-data:seed
 *
 * The Floci ready hook already creates the Workspace, the initial owner, two Teams, four Projects
 * and ten Work Items. This script adds a WBS-shaped Team and Projects, parent-child Work Items with
 * date ranges, Work Items in the existing Projects, and a Planning graph (portfolio, roadmap,
 * initiative, objective and key result, milestones, three Cycles, links and dependencies).
 *
 * Every write goes through the same API as the Web, so the server validates the data, writes the
 * audit and search projections, and never needs table-level knowledge here. The script is
 * idempotent: Teams and Projects are matched by name, Work Items by title inside their Project,
 * and Planning records use fixed IDs, so a rerun only fills in what is missing and never edits or
 * deletes what a person changed. Dates are relative to the week of the first run.
 *
 * It only talks to a local HTTP server (`localhost`, `127.0.0.1`, `[::1]`), so it cannot write
 * demo data into a deployed environment.
 */
import { DEFAULT_WORKSPACE_TIME_ZONE } from '../contracts/src/workspace-calendar'
import type {
  CreatePlanningEntityInput,
  PlanningCadence,
  PlanningEntityStatus,
  PlanningEntityType,
  PlanningGoalFramework,
  PlanningHealth,
  PlanningRisk,
} from '../contracts/src/planning'
import type {
  CreateWorkItemInput,
  WorkItemPriority,
  WorkItemSchedule,
  WorkItemScheduleCalendarPolicy,
} from '../contracts/src/work-items'

/** Hosts the script accepts as the local server. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Calendar policy given to every seeded Work Item; matches the ready hook seed. */
const DEMO_CALENDAR_POLICY: WorkItemScheduleCalendarPolicy = {
  timeZone: DEFAULT_WORKSPACE_TIME_ZONE,
  workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  holidays: [],
}

/** Planning statuses that no longer accept Work Item links. */
const closedStatuses: ReadonlySet<string> = new Set<PlanningEntityStatus>(['completed', 'canceled'])

/** Cadence of the seeded Cycles. */
const DEMO_CYCLE_CADENCE: PlanningCadence = { unit: 'week', count: 2 }

/** Usage text printed for `--help` and argument errors. */
const usage = `Usage: bun run demo-data:seed

Environment:
  MUKUROJI_DEMO_API_URL   local server URL (default http://localhost:3000)
  MUKUROJI_DEMO_EMAIL     owner who creates the data (default demo@example.com)
  MUKUROJI_DEMO_PASSWORD  password of that owner (default Password123!)`

/** Built-in workflow status of a seeded Work Item. */
export type DemoWorkflowStatusId = 'todo' | 'in-progress' | 'review' | 'done'

/**
 * Team the demo needs, created when no Team has the same Japanese name.
 */
export interface DemoTeam {
  /** Key other demo records use to refer to this Team. */
  readonly key: string
  /** Japanese display name, also used to find the Team on a rerun. */
  readonly nameJa: string
  /** English display name; its slug becomes the Team ID. */
  readonly nameEn: string
  /** Whether the Team must already exist because the ready hook seeds it. */
  readonly existing: boolean
}

/**
 * Project the demo needs inside one of the demo Teams.
 */
export interface DemoProject {
  /** Key other demo records use to refer to this Project. */
  readonly key: string
  /** Key of the owning demo Team. */
  readonly teamKey: string
  /** Japanese display name, also used to find the Project on a rerun. */
  readonly nameJa: string
  /** English display name; its slug becomes the Project ID. */
  readonly nameEn: string
  /** Whether the Project must already exist because the ready hook seeds it. */
  readonly existing: boolean
}

/**
 * Work Item the demo creates, with dates already resolved.
 */
export interface DemoWorkItem {
  /** Key other demo records use to refer to this Work Item. */
  readonly key: string
  /** Key of the demo Project the Work Item belongs to. */
  readonly projectKey: string
  /** Title, also used to find the Work Item on a rerun. */
  readonly title: string
  /** Optional Markdown description. */
  readonly description?: string
  /** Workspace member key of the assignee. */
  readonly assigneeUserId: string
  /** Workflow status to create the Work Item in. */
  readonly workflowStatusId: DemoWorkflowStatusId
  /** Priority of the Work Item. */
  readonly priority: WorkItemPriority
  /** Complete schedule of the Work Item. */
  readonly schedule: WorkItemSchedule
  /** Key of the parent demo Work Item in the same Team, if any. */
  readonly parentKey?: string
  /** Key of the demo Cycle the Work Item is planned in, if any. */
  readonly cycleKey?: string
  /** Key of the demo Milestone the Work Item contributes to, if any. */
  readonly milestoneKey?: string
  /** Keys of the demo Goals the Work Item contributes to. */
  readonly goalKeys: readonly string[]
}

/**
 * Planning entity the demo creates under a fixed ID.
 */
export interface DemoPlanningEntity {
  /** Key other demo records use to refer to this entity; also its Planning ID. */
  readonly id: string
  /** Planning entity type. */
  readonly type: PlanningEntityType
  /** Title shown in Planning. */
  readonly title: string
  /** Optional description. */
  readonly description?: string
  /** ID of the parent demo entity, if any. */
  readonly parentId?: string
  /** Key of the demo Team that scopes the entity, if any. */
  readonly teamKey?: string
  /** Key of the demo Project that scopes the entity, if any. */
  readonly projectKey?: string
  /** Lifecycle status. */
  readonly status: PlanningEntityStatus
  /** Health. */
  readonly health: PlanningHealth
  /** Risk level. */
  readonly risk: PlanningRisk
  /** Inclusive planned date range. */
  readonly baseline: { readonly startDate: string, readonly endDate: string }
  /** Inclusive forecast date range. */
  readonly forecast: { readonly startDate: string, readonly endDate: string }
  /** Cycle cadence; set only for Cycles. */
  readonly cadence?: PlanningCadence
  /** Cycle capacity in Work Items; set only for Cycles. */
  readonly capacity?: number
  /** Goal/OKR role; set only for Goals. */
  readonly goalFramework?: PlanningGoalFramework
}

/**
 * Dependency between two demo Planning entities.
 */
export interface DemoPlanningDependency {
  /** Fixed dependency ID. */
  readonly id: string
  /** Predecessor entity ID. */
  readonly predecessorId: string
  /** Successor entity ID. */
  readonly successorId: string
}

/**
 * Finish-to-start schedule dependency between two demo Work Items.
 */
export interface DemoWorkItemDependency {
  /** Fixed dependency ID. */
  readonly id: string
  /** Key of the predecessor demo Work Item. */
  readonly predecessorKey: string
  /** Key of the successor demo Work Item. */
  readonly successorKey: string
}

/**
 * Complete demo data set, resolved against one base date.
 */
export interface DemoDataPlan {
  /** Workspace owner who owns the Planning entities and the summary Work Items. */
  readonly ownerMemberKey: string
  /** Teams in creation order. */
  readonly teams: readonly DemoTeam[]
  /** Projects in creation order. */
  readonly projects: readonly DemoProject[]
  /** Work Items in creation order; parents come before their children. */
  readonly workItems: readonly DemoWorkItem[]
  /** Planning entities in creation order; parents come before their children. */
  readonly planningEntities: readonly DemoPlanningEntity[]
  /** Dependencies between Planning entities. */
  readonly planningDependencies: readonly DemoPlanningDependency[]
  /** Schedule dependencies between Work Items. */
  readonly workItemDependencies: readonly DemoWorkItemDependency[]
}

/**
 * Parses a `YYYY-MM-DD` date into a UTC midnight timestamp.
 *
 * @param date - Calendar date.
 * @returns The date as a `Date` at 00:00 UTC.
 */
function parseDate(date: string): Date {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Invalid calendar date: ${date}`)
  }
  return parsed
}

/**
 * Formats a UTC midnight timestamp as `YYYY-MM-DD`.
 *
 * @param date - Date to format.
 * @returns The calendar date.
 */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Adds calendar days to a date.
 *
 * @param date - Start date as `YYYY-MM-DD`.
 * @param days - Signed number of days to add.
 * @returns The shifted date as `YYYY-MM-DD`.
 */
export function addCalendarDays(date: string, days: number): string {
  const parsed = parseDate(date)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return formatDate(parsed)
}

/**
 * Tells whether a date falls on Monday to Friday.
 *
 * @param date - Date as `YYYY-MM-DD`.
 * @returns True for a weekday.
 */
function isWeekday(date: string): boolean {
  const weekday = parseDate(date).getUTCDay()
  return weekday !== 0 && weekday !== 6
}

/**
 * Counts the weekdays in an inclusive date range.
 *
 * @param startDate - First date of the range.
 * @param endDate - Last date of the range.
 * @returns Number of Monday-to-Friday dates in the range.
 */
export function countWorkingDays(startDate: string, endDate: string): number {
  let count = 0
  for (let date = startDate; date <= endDate; date = addCalendarDays(date, 1)) {
    if (isWeekday(date)) count += 1
  }
  return count
}

/**
 * Returns the Monday of the week that contains a date.
 *
 * @param date - Date as `YYYY-MM-DD`.
 * @returns The Monday as `YYYY-MM-DD`.
 */
export function mondayOfWeek(date: string): string {
  const weekday = parseDate(date).getUTCDay()
  return addCalendarDays(date, weekday === 0 ? -6 : 1 - weekday)
}

/**
 * Returns today's date in the Workspace default time zone.
 *
 * @param now - Current instant.
 * @returns Today's date as `YYYY-MM-DD`.
 */
export function todayInWorkspaceTimeZone(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_WORKSPACE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/**
 * Builds a date-range schedule between two weekdays of the demo calendar.
 *
 * @param startDate - First working date.
 * @param endDate - Last working date.
 * @returns The canonical schedule.
 */
function dateRange(startDate: string, endDate: string): WorkItemSchedule {
  return {
    mode: 'date-range',
    startDate,
    endDate,
    durationDays: countWorkingDays(startDate, endDate),
    calendarPolicy: DEMO_CALENDAR_POLICY,
  }
}

/**
 * Builds a zero-duration milestone schedule.
 *
 * @param date - Milestone date.
 * @returns The canonical schedule.
 */
function milestone(date: string): WorkItemSchedule {
  return { mode: 'milestone', startDate: date, endDate: date, durationDays: 0, calendarPolicy: DEMO_CALENDAR_POLICY }
}

/**
 * Builds a deadline-only schedule.
 *
 * @param date - Deadline.
 * @returns The canonical schedule.
 */
function dueDate(date: string): WorkItemSchedule {
  return { mode: 'due-date', dueDate: date, calendarPolicy: DEMO_CALENDAR_POLICY }
}

/**
 * Builds the demo data set around the week of a base date.
 *
 * Week 0 is the week of `baseDate`; work before it is done, work in it is in progress, and work
 * after it is still to do, so Gantt, Focus, Cycles and Analytics all have something to show.
 *
 * @param baseDate - Any date of the week the demo should be centered on, as `YYYY-MM-DD`.
 * @param ownerMemberKey - Workspace owner who owns the Planning entities and the summary Work Items.
 * @returns The resolved demo data set.
 */
export function buildDemoDataPlan(baseDate: string, ownerMemberKey = 'demo@example.com'): DemoDataPlan {
  const week0 = mondayOfWeek(baseDate)
  /** Monday of the week `offset` weeks from week 0, plus `day` days. */
  const day = (weekOffset: number, dayOffset = 0) => addCalendarDays(week0, weekOffset * 7 + dayOffset)
  /** Friday of the week `offset` weeks from week 0. */
  const friday = (weekOffset: number) => day(weekOffset, 4)

  const teams: DemoTeam[] = [
    { key: 'core', nameJa: 'コアチーム', nameEn: 'Core Team', existing: true },
    { key: 'design', nameJa: 'デザインチーム', nameEn: 'Design Team', existing: true },
    { key: 'platform', nameJa: '開発チーム', nameEn: 'Platform Team', existing: false },
  ]
  const projects: DemoProject[] = [
    { key: 'roadmap', teamKey: 'core', nameJa: 'プロダクトロードマップ', nameEn: 'Product Roadmap', existing: true },
    { key: 'brand', teamKey: 'design', nameJa: 'ブランド刷新', nameEn: 'Brand Refresh', existing: true },
    { key: 'wbs', teamKey: 'platform', nameJa: 'WBS 基盤', nameEn: 'WBS Platform', existing: false },
    { key: 'mobile', teamKey: 'platform', nameJa: 'モバイルアプリ', nameEn: 'Mobile App', existing: false },
  ]

  const krGoals = ['demo-kr-adoption']
  const workItems: DemoWorkItem[] = [
    { key: 'req', projectKey: 'wbs', title: '要件定義', assigneeUserId: ownerMemberKey, workflowStatusId: 'done', priority: 'high', schedule: dateRange(day(-4), friday(-3)), milestoneKey: 'demo-milestone-beta', goalKeys: krGoals },
    { key: 'req-hearing', projectKey: 'wbs', parentKey: 'req', title: '業務ヒアリング', assigneeUserId: 'sato@example.com', workflowStatusId: 'done', priority: 'high', schedule: dateRange(day(-4), friday(-4)), goalKeys: [] },
    { key: 'req-doc', projectKey: 'wbs', parentKey: 'req', title: '要件定義書の作成', assigneeUserId: 'suzuki@example.com', workflowStatusId: 'done', priority: 'high', schedule: dateRange(day(-3), friday(-3)), goalKeys: [] },
    { key: 'design', projectKey: 'wbs', title: '設計', assigneeUserId: ownerMemberKey, workflowStatusId: 'in-progress', priority: 'high', schedule: dateRange(day(-2), friday(0)), milestoneKey: 'demo-milestone-beta', goalKeys: krGoals },
    { key: 'design-ui', projectKey: 'wbs', parentKey: 'design', title: '画面設計', assigneeUserId: 'sato@example.com', workflowStatusId: 'done', priority: 'medium', schedule: dateRange(day(-2), friday(-2)), cycleKey: 'demo-cycle-previous', goalKeys: [] },
    { key: 'design-api', projectKey: 'wbs', parentKey: 'design', title: 'API 設計', description: 'WBS・週次進捗・Planning の API を contracts に定義する。', assigneeUserId: 'tanaka@example.com', workflowStatusId: 'in-progress', priority: 'high', schedule: dateRange(day(-1), friday(0)), cycleKey: 'demo-cycle-current', goalKeys: [] },
    { key: 'design-db', projectKey: 'wbs', parentKey: 'design', title: 'DB 設計', assigneeUserId: 'yamamoto@example.com', workflowStatusId: 'review', priority: 'medium', schedule: dateRange(day(-1), day(0, 2)), cycleKey: 'demo-cycle-current', goalKeys: [] },
    { key: 'build', projectKey: 'wbs', title: '実装', assigneeUserId: ownerMemberKey, workflowStatusId: 'todo', priority: 'high', schedule: dateRange(day(1), friday(4)), milestoneKey: 'demo-milestone-ga', goalKeys: krGoals },
    { key: 'build-wbs', projectKey: 'wbs', parentKey: 'build', title: 'WBS 画面の実装', assigneeUserId: 'sato@example.com', workflowStatusId: 'todo', priority: 'high', schedule: dateRange(day(1), friday(2)), cycleKey: 'demo-cycle-next', goalKeys: [] },
    { key: 'build-weekly', projectKey: 'wbs', parentKey: 'build', title: '週次進捗レポートの実装', assigneeUserId: 'suzuki@example.com', workflowStatusId: 'todo', priority: 'medium', schedule: dateRange(day(1), friday(2)), cycleKey: 'demo-cycle-next', goalKeys: [] },
    { key: 'build-access', projectKey: 'wbs', parentKey: 'build', title: '権限管理の実装', assigneeUserId: 'tanaka@example.com', workflowStatusId: 'todo', priority: 'medium', schedule: dateRange(day(3), friday(4)), goalKeys: [] },
    { key: 'test', projectKey: 'wbs', title: 'テスト', assigneeUserId: ownerMemberKey, workflowStatusId: 'todo', priority: 'medium', schedule: dateRange(day(5), friday(6)), milestoneKey: 'demo-milestone-ga', goalKeys: [] },
    { key: 'test-integration', projectKey: 'wbs', parentKey: 'test', title: '結合テスト', assigneeUserId: 'yamamoto@example.com', workflowStatusId: 'todo', priority: 'medium', schedule: dateRange(day(5), friday(5)), goalKeys: [] },
    { key: 'test-acceptance', projectKey: 'wbs', parentKey: 'test', title: '受け入れテスト', assigneeUserId: ownerMemberKey, workflowStatusId: 'todo', priority: 'medium', schedule: dateRange(day(6), friday(6)), goalKeys: [] },
    { key: 'release', projectKey: 'wbs', title: 'リリース判定', assigneeUserId: ownerMemberKey, workflowStatusId: 'todo', priority: 'high', schedule: milestone(friday(6)), milestoneKey: 'demo-milestone-ga', goalKeys: [] },
    { key: 'mobile-research', projectKey: 'mobile', title: 'モバイル利用シーンの調査', assigneeUserId: 'suzuki@example.com', workflowStatusId: 'done', priority: 'medium', schedule: dateRange(day(-2), friday(-2)), goalKeys: [] },
    { key: 'mobile-prototype', projectKey: 'mobile', title: '週次進捗入力のプロトタイプ', assigneeUserId: 'sato@example.com', workflowStatusId: 'in-progress', priority: 'medium', schedule: dateRange(day(-1), friday(1)), goalKeys: [] },
    { key: 'mobile-push', projectKey: 'mobile', title: 'プッシュ通知の検証', assigneeUserId: 'tanaka@example.com', workflowStatusId: 'todo', priority: 'low', schedule: dueDate(friday(2)), goalKeys: [] },
    { key: 'mobile-backlog', projectKey: 'mobile', title: 'オフライン対応の検討', assigneeUserId: 'yamamoto@example.com', workflowStatusId: 'todo', priority: 'low', schedule: { mode: 'unscheduled', calendarPolicy: DEMO_CALENDAR_POLICY }, goalKeys: [] },
    { key: 'roadmap-q1', projectKey: 'roadmap', title: '来期ロードマップの草案', assigneeUserId: ownerMemberKey, workflowStatusId: 'in-progress', priority: 'high', schedule: dateRange(day(0), friday(1)), goalKeys: [] },
    { key: 'roadmap-review', projectKey: 'roadmap', title: '経営会議でのロードマップレビュー', assigneeUserId: ownerMemberKey, workflowStatusId: 'todo', priority: 'high', schedule: milestone(friday(2)), goalKeys: [] },
    { key: 'roadmap-feedback', projectKey: 'roadmap', title: '顧客フィードバックの整理', assigneeUserId: 'tanaka@example.com', workflowStatusId: 'review', priority: 'medium', schedule: dueDate(day(0, 3)), goalKeys: [] },
    { key: 'brand-logo', projectKey: 'brand', title: '新ロゴ案の作成', assigneeUserId: 'sato@example.com', workflowStatusId: 'done', priority: 'medium', schedule: dateRange(day(-3), friday(-2)), goalKeys: [] },
    { key: 'brand-colors', projectKey: 'brand', title: 'カラーパレットの決定', assigneeUserId: 'suzuki@example.com', workflowStatusId: 'in-progress', priority: 'medium', schedule: dateRange(day(-1), friday(0)), goalKeys: [] },
    { key: 'brand-guide', projectKey: 'brand', title: 'ブランドガイドの公開', assigneeUserId: 'yamamoto@example.com', workflowStatusId: 'todo', priority: 'low', schedule: dueDate(friday(3)), goalKeys: [] },
  ]

  /** Cycle of two weeks starting `offset` cycles from the current one. */
  const cycleRange = (cycleOffset: number) => ({
    startDate: day(cycleOffset * 2 - 1),
    endDate: addCalendarDays(day(cycleOffset * 2 - 1), 13),
  })
  const planningEntities: DemoPlanningEntity[] = [
    { id: 'demo-portfolio', type: 'portfolio', title: '全社ポートフォリオ', status: 'active', health: 'on-track', risk: 'low', baseline: { startDate: day(-4), endDate: friday(12) }, forecast: { startDate: day(-4), endDate: friday(12) } },
    { id: 'demo-roadmap', type: 'roadmap', parentId: 'demo-portfolio', title: '社内業務基盤ロードマップ', status: 'active', health: 'on-track', risk: 'low', baseline: { startDate: day(-4), endDate: friday(12) }, forecast: { startDate: day(-4), endDate: friday(12) } },
    { id: 'demo-initiative-wbs', type: 'initiative', parentId: 'demo-roadmap', teamKey: 'platform', projectKey: 'wbs', title: 'WBS 基盤の社内展開', description: '社内のプロジェクトを WBS で一元管理し、週次進捗まで同じ場所で扱えるようにする。', status: 'active', health: 'at-risk', risk: 'medium', baseline: { startDate: day(-4), endDate: friday(6) }, forecast: { startDate: day(-4), endDate: friday(7) } },
    { id: 'demo-objective-adoption', type: 'goal', goalFramework: 'objective', parentId: 'demo-initiative-wbs', teamKey: 'platform', projectKey: 'wbs', title: '全プロジェクトを WBS で管理する', status: 'active', health: 'on-track', risk: 'low', baseline: { startDate: day(-4), endDate: friday(12) }, forecast: { startDate: day(-4), endDate: friday(12) } },
    { id: 'demo-kr-adoption', type: 'goal', goalFramework: 'key-result', parentId: 'demo-objective-adoption', teamKey: 'platform', projectKey: 'wbs', title: '社内プロジェクトの 80% が WBS を週次で更新している', status: 'active', health: 'on-track', risk: 'low', baseline: { startDate: day(-4), endDate: friday(12) }, forecast: { startDate: day(-4), endDate: friday(12) } },
    { id: 'demo-milestone-beta', type: 'milestone', parentId: 'demo-initiative-wbs', teamKey: 'platform', projectKey: 'wbs', title: 'β リリース', status: 'active', health: 'on-track', risk: 'low', baseline: { startDate: friday(0), endDate: friday(0) }, forecast: { startDate: friday(0), endDate: friday(0) } },
    { id: 'demo-milestone-ga', type: 'milestone', parentId: 'demo-initiative-wbs', teamKey: 'platform', projectKey: 'wbs', title: 'GA リリース', status: 'planned', health: 'at-risk', risk: 'medium', baseline: { startDate: friday(6), endDate: friday(6) }, forecast: { startDate: friday(7), endDate: friday(7) } },
    { id: 'demo-cycle-previous', type: 'cycle', teamKey: 'platform', title: 'Sprint 1', status: 'completed', health: 'on-track', risk: 'none', baseline: cycleRange(-1), forecast: cycleRange(-1), cadence: DEMO_CYCLE_CADENCE, capacity: 8 },
    { id: 'demo-cycle-current', type: 'cycle', teamKey: 'platform', title: 'Sprint 2', status: 'active', health: 'on-track', risk: 'low', baseline: cycleRange(0), forecast: cycleRange(0), cadence: DEMO_CYCLE_CADENCE, capacity: 8 },
    { id: 'demo-cycle-next', type: 'cycle', teamKey: 'platform', title: 'Sprint 3', status: 'planned', health: 'unknown', risk: 'none', baseline: cycleRange(1), forecast: cycleRange(1), cadence: DEMO_CYCLE_CADENCE, capacity: 8 },
  ]

  return {
    ownerMemberKey,
    teams,
    projects,
    workItems,
    planningEntities,
    planningDependencies: [
      { id: 'demo-dependency-beta-ga', predecessorId: 'demo-milestone-beta', successorId: 'demo-milestone-ga' },
    ],
    workItemDependencies: [
      { id: 'demo-dependency-api-wbs', predecessorKey: 'design-api', successorKey: 'build-wbs' },
      { id: 'demo-dependency-build-test', predecessorKey: 'build-access', successorKey: 'test-integration' },
    ],
  }
}

/**
 * Error for an invalid script argument or environment.
 */
export class DemoDataUsageError extends Error {}

/**
 * Error for an API response the script cannot continue after.
 */
export class DemoDataApiError extends Error {
  /** HTTP status of the failed response. */
  readonly status: number

  /**
   * Creates the error.
   *
   * @param message - What failed, with the response body.
   * @param status - HTTP status of the failed response.
   */
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * Validates the server URL and allows only a local HTTP server.
 *
 * @param value - URL from the environment, or undefined for the default.
 * @returns The URL origin without a trailing slash.
 * @throws DemoDataUsageError When the URL is malformed or not local.
 */
export function readLocalApiOrigin(value: string | undefined): string {
  let url: URL
  try {
    url = new URL(value ?? 'http://localhost:3000')
  } catch {
    throw new DemoDataUsageError('MUKUROJI_DEMO_API_URL is not a valid URL.')
  }
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== '' ||
    !LOCAL_HOSTS.has(url.hostname)
  ) {
    throw new DemoDataUsageError(
      'MUKUROJI_DEMO_API_URL must be a local http:// server (localhost, 127.0.0.1 or [::1]) without a path.',
    )
  }
  return url.origin
}

/**
 * Minimal HTTP transport, replaceable in tests.
 *
 * @param method - HTTP method.
 * @param path - Absolute API path starting with `/api/`.
 * @param body - JSON body, if any.
 * @returns HTTP status and parsed JSON body (undefined when the body is not JSON).
 */
export type DemoDataTransport = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  body?: unknown,
) => Promise<{ readonly status: number, readonly body: unknown }>

/**
 * Creates a transport that calls the local server with a bearer token.
 *
 * @param origin - Local server origin.
 * @param accessToken - Owner access token, or undefined for the login call.
 * @returns The transport.
 */
function createFetchTransport(origin: string, accessToken: string | undefined): DemoDataTransport {
  return async (method, path, body) => {
    const headers: Record<string, string> = { 'X-Correlation-Id': crypto.randomUUID() }
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`
    if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID()
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text === '' ? undefined : JSON.parse(text)
    } catch {
      parsed = text
    }
    return { status: response.status, body: parsed }
  }
}

/**
 * Tells whether a value is a plain JSON object.
 *
 * @param value - Value to check.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads an array field of a JSON object.
 *
 * @param value - Object to read.
 * @param field - Field name.
 * @returns The array, or an empty array when missing.
 */
function readArray(value: unknown, field: string): unknown[] {
  if (!isRecord(value)) return []
  const items = value[field]
  return Array.isArray(items) ? items : []
}

/**
 * Reads a string field of a JSON object.
 *
 * @param value - Object to read.
 * @param field - Field name.
 * @returns The string, or undefined when missing or not a string.
 */
function readString(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined
  const item = value[field]
  return typeof item === 'string' ? item : undefined
}

/**
 * Reads a non-negative integer field of a JSON object.
 *
 * @param value - Object to read.
 * @param field - Field name.
 * @param context - What the object is, for the error message.
 * @returns The number.
 * @throws DemoDataApiError When the field is missing.
 */
function readRevision(value: unknown, field: string, context: string): number {
  const item = isRecord(value) ? value[field] : undefined
  if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) {
    throw new DemoDataApiError(`${context} did not include ${field}.`, 0)
  }
  return item
}

/**
 * Counts of what one run created and what it found already present.
 */
export interface DemoDataSummary {
  /** Number of records created by this run. */
  created: number
  /** Number of records that already existed and were left unchanged. */
  kept: number
}

/**
 * Applies the demo data plan through the API, creating only what is missing.
 *
 * @param plan - Resolved demo data set.
 * @param request - Authenticated transport.
 * @param log - Receives one line per created record.
 * @returns Counts of created and kept records.
 */
export async function seedDemoData(
  plan: DemoDataPlan,
  request: DemoDataTransport,
  log: (line: string) => void,
): Promise<DemoDataSummary> {
  const summary: DemoDataSummary = { created: 0, kept: 0 }

  /** Sends a request and returns the body, failing on any status other than the expected ones. */
  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    expected: readonly number[],
    body?: unknown,
  ) => {
    const response = await request(method, path, body)
    if (!expected.includes(response.status)) {
      throw new DemoDataApiError(
        `${method} ${path} returned ${response.status}: ${JSON.stringify(response.body)}`,
        response.status,
      )
    }
    return response.body
  }

  const directory = await call('GET', '/api/teams/projects', [200])
  const teamIds = new Map<string, string>()
  const projectIds = new Map<string, string>()
  const directoryTeams = readArray(directory, 'teams')
  for (const team of plan.teams) {
    const found = directoryTeams.find((candidate) => readString(candidate, 'name') === team.nameJa)
    const foundId = readString(found, 'id')
    if (foundId) {
      teamIds.set(team.key, foundId)
      summary.kept += 1
      continue
    }
    if (team.existing) {
      throw new DemoDataApiError(
        `Team "${team.nameJa}" is missing. Start Floci with \`bun run floci:up\` so its ready hook seeds the Workspace first.`,
        404,
      )
    }
    const created = await call('POST', '/api/teams', [201], { name: team.nameJa, nameJa: team.nameJa, nameEn: team.nameEn })
    const id = readString(isRecord(created) ? created.team : undefined, 'id')
    if (!id) throw new DemoDataApiError('POST /api/teams did not return a Team ID.', 201)
    teamIds.set(team.key, id)
    summary.created += 1
    log(`created Team ${team.nameJa} (${id})`)
  }

  for (const project of plan.projects) {
    const teamId = requireKey(teamIds, project.teamKey, 'Team')
    const directoryTeam = directoryTeams.find((candidate) => readString(candidate, 'id') === teamId)
    const found = readArray(directoryTeam, 'projects').find((candidate) => readString(candidate, 'name') === project.nameJa)
    const foundId = readString(found, 'id')
    if (foundId) {
      projectIds.set(project.key, foundId)
      summary.kept += 1
      continue
    }
    if (project.existing) {
      throw new DemoDataApiError(
        `Project "${project.nameJa}" is missing. Start Floci with \`bun run floci:up\` so its ready hook seeds the Workspace first.`,
        404,
      )
    }
    const created = await call('POST', `/api/teams/${encodeURIComponent(teamId)}/projects`, [201], {
      name: project.nameJa,
      nameJa: project.nameJa,
      nameEn: project.nameEn,
    })
    const id = readString(isRecord(created) ? created.project : undefined, 'id')
    if (!id) throw new DemoDataApiError('POST /api/teams/:teamId/projects did not return a Project ID.', 201)
    projectIds.set(project.key, id)
    summary.created += 1
    log(`created Project ${project.nameJa} (${id})`)
  }

  const projectTeamIds = new Map(plan.projects.map((project) => [project.key, requireKey(teamIds, project.teamKey, 'Team')]))
  const existingIssues = new Map<string, unknown[]>()
  for (const teamId of new Set(projectTeamIds.values())) {
    const listed = await call('GET', `/api/teams/${encodeURIComponent(teamId)}/issues?includeArchived=true`, [200])
    existingIssues.set(teamId, readArray(listed, 'issues'))
  }

  const workItemIds = new Map<string, { teamId: string, workItemId: string, projectId: string }>()
  for (const workItem of plan.workItems) {
    const teamId = requireKey(projectTeamIds, workItem.projectKey, 'Project')
    const projectId = requireKey(projectIds, workItem.projectKey, 'Project')
    const found = (existingIssues.get(teamId) ?? []).find((candidate) =>
      readString(candidate, 'title') === workItem.title && readString(candidate, 'assignedProjectId') === projectId,
    )
    const foundId = readString(found, 'id')
    if (foundId) {
      workItemIds.set(workItem.key, { teamId, workItemId: foundId, projectId })
      summary.kept += 1
      continue
    }
    const input: CreateWorkItemInput = {
      title: workItem.title,
      ...(workItem.description === undefined ? {} : { description: workItem.description }),
      assignedProjectId: projectId,
      assigneeUserId: workItem.assigneeUserId,
      workflowStatusId: workItem.workflowStatusId,
      priority: workItem.priority,
      schedule: workItem.schedule,
    }
    const created = await call('POST', `/api/teams/${encodeURIComponent(teamId)}/issues`, [201], input)
    const id = readString(isRecord(created) ? created.issue : undefined, 'id')
    if (!id) throw new DemoDataApiError('POST /api/teams/:teamId/issues did not return a Work Item ID.', 201)
    workItemIds.set(workItem.key, { teamId, workItemId: id, projectId })
    summary.created += 1
    log(`created Work Item ${workItem.title} (${teamId}/${id})`)
  }

  for (const workItem of plan.workItems) {
    if (!workItem.parentKey) continue
    const child = requireKey(workItemIds, workItem.key, 'Work Item')
    const parent = requireKey(workItemIds, workItem.parentKey, 'Work Item')
    const hierarchyPath = `/api/teams/${encodeURIComponent(child.teamId)}/work-item-hierarchy`
    const hierarchy = await call('GET', hierarchyPath, [200])
    const node = readArray(hierarchy, 'nodes').find((candidate) => readString(candidate, 'workItemId') === child.workItemId)
    const currentParent = isRecord(node) ? node.parentWorkItemId : undefined
    if (currentParent !== null && currentParent !== undefined) {
      summary.kept += 1
      continue
    }
    await call(
      'PUT',
      `/api/teams/${encodeURIComponent(child.teamId)}/issues/${encodeURIComponent(child.workItemId)}/parent`,
      [200],
      {
        parentWorkItemId: parent.workItemId,
        expectedGraphRevision: readRevision(hierarchy, 'graphRevision', 'Work Item hierarchy'),
      },
    )
    summary.created += 1
    log(`set parent of ${workItem.title}`)
  }

  let planning = await call('GET', '/api/planning', [200])
  /** Entities created open so Work Items can join them, then closed at the end of this run. */
  const pendingClosures: DemoPlanningEntity[] = []
  const entityIds = new Set(readArray(planning, 'entities').map((entity) => readString(entity, 'id')))
  for (const entity of plan.planningEntities) {
    if (entityIds.has(entity.id)) {
      summary.kept += 1
      continue
    }
    const input: CreatePlanningEntityInput = {
      id: entity.id,
      type: entity.type,
      title: entity.title,
      ...(entity.description === undefined ? {} : { description: entity.description }),
      ...(entity.parentId === undefined ? {} : { parentId: entity.parentId }),
      ...(entity.teamKey === undefined ? {} : { teamId: requireKey(teamIds, entity.teamKey, 'Team') }),
      ...(entity.projectKey === undefined ? {} : { projectId: requireKey(projectIds, entity.projectKey, 'Project') }),
      ownerMemberKey: plan.ownerMemberKey,
      status: closedStatuses.has(entity.status) ? 'active' : entity.status,
      health: entity.health,
      risk: entity.risk,
      progressMode: 'automatic',
      baseline: entity.baseline,
      forecast: entity.forecast,
      ...(entity.cadence === undefined ? {} : { cadence: entity.cadence }),
      ...(entity.capacity === undefined ? {} : { capacity: entity.capacity }),
      ...(entity.type === 'cycle' ? { carryOverPolicy: 'move-incomplete' } : {}),
      ...(entity.goalFramework === undefined ? {} : { goalFramework: entity.goalFramework }),
      expectedRevision: readRevision(planning, 'revision', 'Planning snapshot'),
    }
    planning = await call('POST', '/api/planning/entities', [201], input)
    entityIds.add(entity.id)
    if (closedStatuses.has(entity.status)) pendingClosures.push(entity)
    summary.created += 1
    log(`created Planning ${entity.type} ${entity.title} (${entity.id})`)
  }

  const dependencyIds = new Set(readArray(planning, 'dependencies').map((dependency) => readString(dependency, 'id')))
  for (const dependency of plan.planningDependencies) {
    if (dependencyIds.has(dependency.id)) {
      summary.kept += 1
      continue
    }
    planning = await call('POST', '/api/planning/dependencies', [201], {
      id: dependency.id,
      predecessorId: dependency.predecessorId,
      successorId: dependency.successorId,
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: readRevision(planning, 'revision', 'Planning snapshot'),
    })
    summary.created += 1
    log(`created Planning dependency ${dependency.id}`)
  }

  const linkedWorkItems = new Map(
    readArray(planning, 'workItemLinks').map((link) => [
      `${readString(link, 'teamId')}\0${readString(link, 'workItemId')}`,
      link,
    ]),
  )
  // Milestones and Goals are linked one Work Item at a time; Cycles take a batch below, because
  // the Cycle route is the one that authorizes a Team-scoped Cycle.
  for (const workItem of plan.workItems) {
    if (!workItem.milestoneKey && workItem.goalKeys.length === 0) continue
    const target = requireKey(workItemIds, workItem.key, 'Work Item')
    if (linkedWorkItems.has(`${target.teamId}\0${target.workItemId}`)) {
      summary.kept += 1
      continue
    }
    planning = await call(
      'PUT',
      `/api/planning/work-item-links/${encodeURIComponent(target.teamId)}/${encodeURIComponent(target.workItemId)}`,
      [200],
      {
        teamId: target.teamId,
        workItemId: target.workItemId,
        projectId: target.projectId,
        ...(workItem.milestoneKey === undefined ? {} : { milestoneId: workItem.milestoneKey }),
        goalIds: [...workItem.goalKeys],
        expectedRevision: readRevision(planning, 'revision', 'Planning snapshot'),
      },
    )
    summary.created += 1
    log(`linked ${workItem.title} to Planning`)
  }

  const entities = readArray(planning, 'entities')
  for (const cycle of plan.planningEntities.filter((entity) => entity.type === 'cycle')) {
    const members = plan.workItems.filter((workItem) => workItem.cycleKey === cycle.id)
    const missing = members
      .map((workItem) => requireKey(workItemIds, workItem.key, 'Work Item'))
      .filter((target) => readString(linkedWorkItems.get(`${target.teamId}\0${target.workItemId}`), 'cycleId') === undefined)
    summary.kept += members.length - missing.length
    if (missing.length === 0) continue
    const status = readString(entities.find((entity) => readString(entity, 'id') === cycle.id), 'status')
    if (status !== undefined && closedStatuses.has(status)) {
      // A closed Cycle cannot take Work Items; leave what a person or an earlier run decided.
      summary.kept += missing.length
      continue
    }
    planning = await call('POST', `/api/planning/cycles/${encodeURIComponent(cycle.id)}/work-items`, [200], {
      action: 'add',
      workItems: missing.map(({ teamId, workItemId }) => ({ teamId, workItemId })),
      expectedRevision: readRevision(planning, 'revision', 'Planning snapshot'),
    })
    summary.created += missing.length
    log(`added ${missing.length} Work Items to ${cycle.title}`)
  }

  const workItemDependencyIds = new Set(
    readArray(planning, 'workItemDependencies').map((dependency) => readString(dependency, 'id')),
  )
  for (const dependency of plan.workItemDependencies) {
    if (workItemDependencyIds.has(dependency.id)) {
      summary.kept += 1
      continue
    }
    const predecessor = requireKey(workItemIds, dependency.predecessorKey, 'Work Item')
    const successor = requireKey(workItemIds, dependency.successorKey, 'Work Item')
    planning = await call('POST', '/api/planning/work-item-dependencies', [201], {
      id: dependency.id,
      predecessor: { teamId: predecessor.teamId, workItemId: predecessor.workItemId },
      successor: { teamId: successor.teamId, workItemId: successor.workItemId },
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: readRevision(planning, 'revision', 'Planning snapshot'),
    })
    summary.created += 1
    log(`created Work Item dependency ${dependency.id}`)
  }

  for (const entity of pendingClosures) {
    planning = await call('PATCH', `/api/planning/entities/${encodeURIComponent(entity.id)}`, [200], {
      expectedRevision: readRevision(planning, 'revision', 'Planning snapshot'),
      patch: { status: entity.status },
    })
    log(`marked ${entity.title} ${entity.status}`)
  }

  return summary
}

/**
 * Reads a value that an earlier step stored under a demo key.
 *
 * @param values - Values by demo key.
 * @param key - Demo key.
 * @param kind - What the key names, for the error message.
 * @returns The stored value.
 * @throws Error When an earlier step did not store the key.
 */
function requireKey<T>(values: ReadonlyMap<string, T>, key: string, kind: string): T {
  const value = values.get(key)
  if (value === undefined) throw new Error(`Demo ${kind} "${key}" was not resolved.`)
  return value
}

/**
 * Logs in as the owner and returns an access token.
 *
 * @param request - Unauthenticated transport.
 * @param email - Owner email.
 * @param password - Owner password.
 * @returns The access token.
 * @throws DemoDataApiError When the login does not return a token.
 */
async function login(request: DemoDataTransport, email: string, password: string): Promise<string> {
  const response = await request('POST', '/api/auth/login', { email, password })
  const token = readString(response.body, 'accessToken')
  if (response.status !== 200 || !token) {
    throw new DemoDataApiError(
      `Login as ${email} failed with ${response.status}: ${JSON.stringify(response.body)}`,
      response.status,
    )
  }
  return token
}

/**
 * Runs the script from the command line.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  if (process.argv.length > 2) {
    console.log(usage)
    return process.argv.includes('--help') || process.argv.includes('-h') ? 0 : 2
  }
  try {
    const origin = readLocalApiOrigin(process.env.MUKUROJI_DEMO_API_URL || undefined)
    const email = process.env.MUKUROJI_DEMO_EMAIL || 'demo@example.com'
    const password = process.env.MUKUROJI_DEMO_PASSWORD || 'Password123!'
    const accessToken = await login(createFetchTransport(origin, undefined), email, password)
    const plan = buildDemoDataPlan(todayInWorkspaceTimeZone(new Date()), email)
    const summary = await seedDemoData(plan, createFetchTransport(origin, accessToken), (line) => console.log(line))
    console.log(`Demo data ready: created=${summary.created} kept=${summary.kept}`)
    return 0
  } catch (error) {
    if (error instanceof DemoDataUsageError) {
      console.error(error.message)
      console.error(usage)
      return 2
    }
    if (error instanceof TypeError && /fetch|connect/i.test(error.message)) {
      console.error(`Could not reach the server: ${error.message}. Start it with \`bun run dev\` first.`)
      return 1
    }
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  process.exit(await main())
}
