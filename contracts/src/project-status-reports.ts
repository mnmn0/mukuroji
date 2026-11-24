import type { PlanningEntityStatus, PlanningHealth, PlanningRisk } from './planning'
import type { ProjectRaidEntryKind, ProjectRaidSeverity } from './project-raid-log'

/** Schema version of a stored Project status report snapshot. */
export const PROJECT_STATUS_REPORT_SCHEMA_VERSION = 1 as const

/** Sections of a Project status report, in display order. */
export type ProjectStatusReportSection = 'health' | 'schedule' | 'progress' | 'risks' | 'nextActions'

/** Every report section in display order. */
export const PROJECT_STATUS_REPORT_SECTIONS: readonly ProjectStatusReportSection[] = [
  'health',
  'schedule',
  'progress',
  'risks',
  'nextActions',
]

/** Languages a report is written in. */
export type ProjectStatusReportLocale = 'ja' | 'en'

/** Most rows one list section of a report holds. */
export const PROJECT_STATUS_REPORT_MAX_ROWS = 50
/** Longest title, name, or label in a report. */
export const PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH = 300
/** Longest free text, such as the update summary, in a report. */
export const PROJECT_STATUS_REPORT_TEXT_MAX_LENGTH = 4_000
/** Largest serialized report, in UTF-8 bytes, that a share stores. */
export const PROJECT_STATUS_REPORT_MAX_BYTES = 96 * 1_024
/** Longest time a share link can stay open, in days. */
export const PROJECT_STATUS_SHARE_MAX_DAYS = 90
/** Most open (unrevoked and unexpired) share links one Project can have. */
export const PROJECT_STATUS_SHARE_MAX_PER_PROJECT = 50

/** Latest published Project update, as the report shows it. */
export type ProjectStatusReportHealth = {
  /** Health the author chose. */
  health: PlanningHealth
  /** Risk level the author chose. */
  risk: PlanningRisk
  /** Executive summary of the update. */
  summary: string
  /** ISO timestamp when the update was published. */
  publishedAt: string
  /** Display name of the author; removed when a share hides people's names. */
  authorName?: string
}

/** Planning entity kinds listed in the schedule section. */
export type ProjectStatusReportScheduleType = 'phase' | 'milestone' | 'release'

/** One Phase, Milestone, or Release row of the schedule section. */
export type ProjectStatusReportScheduleItem = {
  /** Planning entity kind. */
  type: ProjectStatusReportScheduleType
  /** Display title. */
  title: string
  /** Lifecycle status. */
  status: PlanningEntityStatus
  /** Health rolled up from the entity and its descendants. */
  health: PlanningHealth
  /** Progress from 0 to 100. */
  progress: number
  /** Forecast end date in `YYYY-MM-DD`. */
  forecastEndDate: string
  /** Baseline end date in `YYYY-MM-DD`. */
  baselineEndDate: string
  /** Days the forecast end is after the baseline end; negative when earlier. */
  delayDays: number
}

/** Schedule section: Phases, Milestones, and Releases with their delays. */
export type ProjectStatusReportSchedule = {
  /** Rows, nearest forecast end first. */
  items: ProjectStatusReportScheduleItem[]
  /** Rows left out of the report. */
  hiddenCount: number
  /** Rows whose forecast end is after their baseline end. */
  delayedCount: number
}

/** Progress section: Work Item counts. */
export type ProjectStatusReportProgress = {
  /** Every Work Item counted. */
  totalCount: number
  /** Work Items not completed or canceled. */
  openCount: number
  /** Work Items in progress. */
  inProgressCount: number
  /** Completed Work Items. */
  doneCount: number
  /** Rounded percentage of completed Work Items. */
  completionRate: number
  /** Open Work Items past their due date. */
  overdueCount: number
  /** Open Work Items waiting on an open blocker. */
  blockedCount: number
}

/** One open risk or issue of the risks section. */
export type ProjectStatusReportRiskItem = {
  /** Risk or issue. */
  kind: Exclude<ProjectRaidEntryKind, 'change-request'>
  /** Short name of the entry. */
  title: string
  /** Severity derived from probability and impact. */
  severity: ProjectRaidSeverity
  /** Mitigation or resolution, when recorded. */
  response?: string
  /** Review date in `YYYY-MM-DD`, when set. */
  reviewDueDate?: string
}

/** Risks section: open counts and the most severe open risks and issues. */
export type ProjectStatusReportRisks = {
  /** Open risks. */
  openRiskCount: number
  /** Open issues. */
  openIssueCount: number
  /** Change requests waiting for a decision. */
  pendingDecisionCount: number
  /** Open risks and issues, most severe first. */
  items: ProjectStatusReportRiskItem[]
  /** Open risks and issues left out of the report. */
  hiddenCount: number
}

/** One open action item of the next actions section. */
export type ProjectStatusReportActionItem = {
  /** Action text. */
  text: string
  /** Deadline in `YYYY-MM-DD`, when set. */
  dueDate?: string
  /** Owner display name; removed when a share hides people's names. */
  ownerName?: string
  /** Whether the deadline has passed. */
  overdue: boolean
}

/** Next actions section: open Document action items, earliest deadline first. */
export type ProjectStatusReportNextActions = {
  /** Open items. */
  items: ProjectStatusReportActionItem[]
  /** Open items left out of the report. */
  hiddenCount: number
  /**
   * Whether some Documents could not be read or were not scanned, so open items may be missing
   * beyond `hiddenCount`.
   */
  incomplete?: boolean
}

/**
 * Point-in-time status report of one Project.
 *
 * The report is a snapshot of what its author could read when it was made. Sharing stores the
 * snapshot, so a share link never reads live Project data.
 */
export type ProjectStatusReport = {
  /** Snapshot schema version. */
  schemaVersion: typeof PROJECT_STATUS_REPORT_SCHEMA_VERSION
  /** Language of the report labels. */
  locale: ProjectStatusReportLocale
  /** Project display name. */
  projectName: string
  /** Team display name. */
  teamName: string
  /** ISO timestamp when the snapshot was made. */
  asOf: string
  /** Latest published Project update. */
  health?: ProjectStatusReportHealth
  /** Phases, Milestones, and Releases. */
  schedule?: ProjectStatusReportSchedule
  /** Work Item progress. */
  progress?: ProjectStatusReportProgress
  /** Open risks and issues. */
  risks?: ProjectStatusReportRisks
  /** Open action items. */
  nextActions?: ProjectStatusReportNextActions
}

/** What a share link publishes from a report. */
export type ProjectStatusShareScope = {
  /** Sections the link shows; every other section is removed before the report is stored. */
  sections: ProjectStatusReportSection[]
  /** Whether people's names stay in the report. */
  showPeopleNames: boolean
}

/** One read-only share link of a Project status report. */
export type ProjectStatusShare = ProjectStatusShareScope & {
  /** Share ID. */
  id: string
  /** Team that owns the Project. */
  teamId: string
  /** Shared Project. */
  projectId: string
  /** Label the creator gave the link, such as the recipient's company. */
  label: string
  /** ISO timestamp after which the link stops working. */
  expiresAt: string
  /** ISO timestamp of the creation. */
  createdAt: string
  /** Workspace member key of the creator. */
  createdByMemberKey: string
  /** ISO timestamp of the report snapshot. */
  reportAsOf: string
  /** ISO timestamp of the revocation, when the link was revoked. */
  revokedAt?: string
  /** Customer the link was sent to, when one was chosen. */
  customerId?: string
  /** Customer contact the link was sent to, when one was chosen. */
  contactId?: string
  /** Times the link was opened, counted at most once a minute. */
  viewCount: number
  /** ISO timestamp of the latest counted view. */
  lastViewedAt?: string
}

/** Request body that creates a share link. */
export type CreateProjectStatusShareRequest = ProjectStatusShareScope & {
  /** Report snapshot to publish. */
  report: ProjectStatusReport
  /** Label for the link. */
  label: string
  /** Days from now until the link expires, from 1 to {@link PROJECT_STATUS_SHARE_MAX_DAYS}. */
  expiresInDays: number
  /** Customer the link is sent to. */
  customerId?: string
  /** Contact of that customer the link is sent to. */
  contactId?: string
}

/** Response to a share link creation; the URL is returned only here. */
export type CreateProjectStatusShareResponse = {
  /** Created share. */
  share: ProjectStatusShare
  /** Relative URL of the public page, which carries the secret token. */
  url: string
}

/** Share links of one Project, newest first. */
export type ProjectStatusShareListResponse = {
  /** Shares, including revoked and expired ones. */
  shares: ProjectStatusShare[]
}

/** Response of the public share page. */
export type PublicProjectStatusReportResponse = {
  /** Report as the share publishes it. */
  report: ProjectStatusReport
  /** ISO timestamp after which the link stops working. */
  expiresAt: string
}

/** Request body that renders a report as a PDF. */
export type ProjectStatusReportPdfRequest = {
  /** Report to render. */
  report: ProjectStatusReport
}

/** Result of validating untrusted input. */
export type ProjectStatusReportParseResult<T> =
  | {
      /** The input is valid. */
      ok: true
      /** Normalized value. */
      value: T
    }
  | {
      /** The input is invalid. */
      ok: false
      /** First problem found. */
      message: string
    }

/** Pattern of a `YYYY-MM-DD` date. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
/** UTC ISO 8601 timestamp. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u
/** Control characters other than tab, line feed, and carriage return. */
// eslint-disable-next-line no-control-regex -- these control characters are what the check rejects.
const DISALLOWED_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
/** A UTF-16 surrogate without its pair. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

const HEALTHS: readonly PlanningHealth[] = ['unknown', 'on-track', 'at-risk', 'off-track']
const RISKS: readonly PlanningRisk[] = ['none', 'low', 'medium', 'high', 'critical']
const ENTITY_STATUSES: readonly PlanningEntityStatus[] = ['proposed', 'planned', 'active', 'paused', 'completed', 'canceled']
const SCHEDULE_TYPES: readonly ProjectStatusReportScheduleType[] = ['phase', 'milestone', 'release']
const SEVERITIES: readonly ProjectRaidSeverity[] = ['low', 'medium', 'high', 'critical']
const RISK_KINDS: readonly ProjectStatusReportRiskItem['kind'][] = ['risk', 'issue']

/** Error raised inside the parser and turned into a parse result. */
class ReportShapeError extends Error {}

/**
 * Validates an untrusted Project status report and rebuilds it with only the known fields.
 *
 * @param value - Untrusted input, such as a request body field or a stored row.
 * @returns The rebuilt report or the first problem found.
 */
export function parseProjectStatusReport(value: unknown): ProjectStatusReportParseResult<ProjectStatusReport> {
  try {
    return { ok: true, value: readReport(value) }
  } catch (error) {
    if (error instanceof ReportShapeError) return { ok: false, message: error.message }
    throw error
  }
}

/**
 * Validates the scope of a share link.
 *
 * @param sections - Untrusted section list.
 * @param showPeopleNames - Untrusted name visibility flag.
 * @returns The scope with sections in display order, or the first problem found.
 */
export function parseProjectStatusShareScope(
  sections: unknown,
  showPeopleNames: unknown,
): ProjectStatusReportParseResult<ProjectStatusShareScope> {
  if (!Array.isArray(sections) || sections.length === 0) {
    return { ok: false, message: 'Choose at least one section.' }
  }
  const chosen = new Set<ProjectStatusReportSection>()
  for (const section of sections) {
    const known = PROJECT_STATUS_REPORT_SECTIONS.find((candidate) => candidate === section)
    if (known === undefined) return { ok: false, message: 'A section is unknown.' }
    chosen.add(known)
  }
  if (typeof showPeopleNames !== 'boolean') {
    return { ok: false, message: 'showPeopleNames must be true or false.' }
  }
  return {
    ok: true,
    value: {
      sections: PROJECT_STATUS_REPORT_SECTIONS.filter((section) => chosen.has(section)),
      showPeopleNames,
    },
  }
}

/**
 * Tells whether a report holds nothing outside a share scope, that is, whether redacting it again
 * would change nothing.
 *
 * @param report - Validated report.
 * @param scope - Sections and name visibility of the share.
 * @returns Whether the report already matches the scope.
 */
export function isProjectStatusReportWithinScope(
  report: ProjectStatusReport,
  scope: ProjectStatusShareScope,
): boolean {
  const canonical = (value: ProjectStatusReport) => {
    const parsed = parseProjectStatusReport(value)
    return parsed.ok ? JSON.stringify(parsed.value) : undefined
  }
  const stored = canonical(report)
  return stored !== undefined && stored === canonical(redactProjectStatusReport(report, scope))
}

/**
 * Tells whether a value is a UTC ISO timestamp, such as `2026-11-24T03:00:00Z`, that names a real
 * calendar date and time.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a valid UTC timestamp.
 */
export function isProjectStatusReportTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false
  const time = Date.parse(value)
  // Date.parse accepts days past the end of a month, such as February 30, so compare the fields.
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
}

/**
 * Removes from a report every section outside a share scope and, unless the scope keeps them,
 * every person's name.
 *
 * @param report - Validated report.
 * @param scope - Sections and name visibility of the share.
 * @returns A new report holding only what the share publishes.
 */
export function redactProjectStatusReport(
  report: ProjectStatusReport,
  scope: ProjectStatusShareScope,
): ProjectStatusReport {
  const included = new Set(scope.sections)
  const redacted: ProjectStatusReport = {
    schemaVersion: report.schemaVersion,
    locale: report.locale,
    projectName: report.projectName,
    teamName: report.teamName,
    asOf: report.asOf,
  }
  if (included.has('health') && report.health) {
    const { authorName, ...health } = report.health
    redacted.health = scope.showPeopleNames && authorName !== undefined ? { ...health, authorName } : health
  }
  if (included.has('schedule') && report.schedule) {
    redacted.schedule = { ...report.schedule, items: report.schedule.items.map((item) => ({ ...item })) }
  }
  if (included.has('progress') && report.progress) redacted.progress = { ...report.progress }
  if (included.has('risks') && report.risks) {
    redacted.risks = { ...report.risks, items: report.risks.items.map((item) => ({ ...item })) }
  }
  if (included.has('nextActions') && report.nextActions) {
    redacted.nextActions = {
      hiddenCount: report.nextActions.hiddenCount,
      items: report.nextActions.items.map(({ ownerName, ...item }) =>
        scope.showPeopleNames && ownerName !== undefined ? { ...item, ownerName } : item),
      ...(report.nextActions.incomplete ? { incomplete: true } : {}),
    }
  }
  return redacted
}

/** One section of a report as plain text, shared by the Markdown, PDF, and slide exports. */
export type ProjectStatusReportOutlineSection = {
  /** Section key. */
  section: ProjectStatusReportSection
  /** Section heading. */
  heading: string
  /** Lines of the section, without list markers. */
  lines: string[]
  /**
   * How many of the last `lines` are notes about the section, such as rows left out or Documents
   * that could not be read, rather than report items. A shortened view keeps them.
   */
  noteCount: number
}

/** Report as plain text, shared by the Markdown, PDF, and slide exports. */
export type ProjectStatusReportOutline = {
  /** Report title. */
  title: string
  /** Team and snapshot time. */
  subtitle: string
  /** Sections present in the report, in display order. */
  sections: ProjectStatusReportOutlineSection[]
}

/** Labels of one report language. */
type OutlineMessages = {
  title: (projectName: string) => string
  subtitle: (teamName: string, asOf: string) => string
  headings: Record<ProjectStatusReportSection, string>
  health: Record<PlanningHealth, string>
  risk: Record<PlanningRisk, string>
  status: Record<PlanningEntityStatus, string>
  scheduleType: Record<ProjectStatusReportScheduleType, string>
  severity: Record<ProjectRaidSeverity, string>
  riskKind: Record<ProjectStatusReportRiskItem['kind'], string>
  healthLine: (health: string, risk: string) => string
  published: (at: string, author?: string) => string
  scheduleLine: (item: ProjectStatusReportScheduleItem, type: string, status: string, health: string) => string
  delayedCount: (count: number) => string
  progressLines: (progress: ProjectStatusReportProgress) => string[]
  riskCounts: (risks: ProjectStatusReportRisks) => string
  riskLine: (item: ProjectStatusReportRiskItem, kind: string, severity: string) => string
  response: (text: string) => string
  actionLine: (item: ProjectStatusReportActionItem) => string
  hidden: (count: number) => string
  incompleteActions: string
  empty: string
}

const OUTLINE_MESSAGES: Record<ProjectStatusReportLocale, OutlineMessages> = {
  ja: {
    title: (projectName) => `${projectName} 進捗レポート`,
    subtitle: (teamName, asOf) => `${teamName} ・ ${asOf} 時点`,
    headings: {
      health: '状況',
      schedule: 'マイルストーンと遅延',
      progress: '進捗',
      risks: 'リスク・課題',
      nextActions: '次のアクション',
    },
    health: { unknown: '未評価', 'on-track': '順調', 'at-risk': '要注意', 'off-track': '計画外' },
    risk: { none: 'なし', low: '低', medium: '中', high: '高', critical: '重大' },
    status: {
      proposed: '提案',
      planned: '計画済み',
      active: '進行中',
      paused: '一時停止',
      completed: '完了',
      canceled: '中止',
    },
    scheduleType: { phase: 'フェーズ', milestone: 'マイルストーン', release: 'リリース' },
    severity: { low: '低', medium: '中', high: '高', critical: '重大' },
    riskKind: { risk: 'リスク', issue: '課題' },
    healthLine: (health, risk) => `健全性: ${health} ／ リスク: ${risk}`,
    published: (at, author) => `${at} 更新${author ? `（${author}）` : ''}`,
    scheduleLine: (item, type, status, health) =>
      `[${type}] ${item.title}: 予定 ${item.forecastEndDate}（基準 ${item.baselineEndDate}、` +
      `${item.delayDays > 0 ? `${item.delayDays}日遅れ` : item.delayDays < 0 ? `${-item.delayDays}日前倒し` : '予定どおり'}）` +
      ` ${status} ・ ${health} ・ ${item.progress}%`,
    delayedCount: (count) => `遅延 ${count}件`,
    progressLines: (progress) => [
      `完了率 ${progress.completionRate}%（完了 ${progress.doneCount} ／ 全 ${progress.totalCount}件）`,
      `未完了 ${progress.openCount}件（進行中 ${progress.inProgressCount}件）`,
      `期限超過 ${progress.overdueCount}件 ・ ブロック中 ${progress.blockedCount}件`,
    ],
    riskCounts: (risks) =>
      `未解決のリスク ${risks.openRiskCount}件 ・ 課題 ${risks.openIssueCount}件 ・ 判断待ち ${risks.pendingDecisionCount}件`,
    riskLine: (item, kind, severity) =>
      `[${kind}・${severity}] ${item.title}${item.reviewDueDate ? `（見直し ${item.reviewDueDate}）` : ''}`,
    response: (text) => `対応: ${text}`,
    actionLine: (item) =>
      `${singleLine(item.text)}${item.dueDate ? `（期限 ${item.dueDate}${item.overdue ? '・超過' : ''}）` : ''}` +
      `${item.ownerName ? ` 担当: ${item.ownerName}` : ''}`,
    hidden: (count) => `ほか ${count}件`,
    incompleteActions: '一部のドキュメントを読めなかったため、ほかにも未完了の項目があるかもしれません。',
    empty: 'なし',
  },
  en: {
    title: (projectName) => `${projectName} status report`,
    subtitle: (teamName, asOf) => `${teamName} - as of ${asOf}`,
    headings: {
      health: 'Status',
      schedule: 'Milestones and delays',
      progress: 'Progress',
      risks: 'Risks and issues',
      nextActions: 'Next actions',
    },
    health: { unknown: 'Not rated', 'on-track': 'On track', 'at-risk': 'At risk', 'off-track': 'Off track' },
    risk: { none: 'None', low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' },
    status: {
      proposed: 'Proposed',
      planned: 'Planned',
      active: 'Active',
      paused: 'Paused',
      completed: 'Completed',
      canceled: 'Canceled',
    },
    scheduleType: { phase: 'Phase', milestone: 'Milestone', release: 'Release' },
    severity: { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' },
    riskKind: { risk: 'Risk', issue: 'Issue' },
    healthLine: (health, risk) => `Health: ${health} / Risk: ${risk}`,
    published: (at, author) => `Updated ${at}${author ? ` by ${author}` : ''}`,
    scheduleLine: (item, type, status, health) =>
      `[${type}] ${item.title}: forecast ${item.forecastEndDate} (baseline ${item.baselineEndDate}, ` +
      `${item.delayDays > 0 ? `${item.delayDays} days late` : item.delayDays < 0 ? `${-item.delayDays} days early` : 'on schedule'})` +
      ` ${status} - ${health} - ${item.progress}%`,
    delayedCount: (count) => `${count} delayed`,
    progressLines: (progress) => [
      `${progress.completionRate}% complete (${progress.doneCount} of ${progress.totalCount} done)`,
      `${progress.openCount} open (${progress.inProgressCount} in progress)`,
      `${progress.overdueCount} overdue - ${progress.blockedCount} blocked`,
    ],
    riskCounts: (risks) =>
      `${risks.openRiskCount} open risks - ${risks.openIssueCount} open issues - ${risks.pendingDecisionCount} decisions pending`,
    riskLine: (item, kind, severity) =>
      `[${kind}, ${severity}] ${item.title}${item.reviewDueDate ? ` (review ${item.reviewDueDate})` : ''}`,
    response: (text) => `Response: ${text}`,
    actionLine: (item) =>
      `${singleLine(item.text)}${item.dueDate ? ` (due ${item.dueDate}${item.overdue ? ', overdue' : ''})` : ''}` +
      `${item.ownerName ? ` - ${item.ownerName}` : ''}`,
    hidden: (count) => `${count} more`,
    incompleteActions: 'Some Documents could not be read, so other open items may be missing.',
    empty: 'None',
  },
}

/**
 * Writes a report as plain text lines grouped by section.
 *
 * @param report - Validated report.
 * @returns Title, subtitle, and the lines of each present section.
 */
export function createProjectStatusReportOutline(report: ProjectStatusReport): ProjectStatusReportOutline {
  const messages = OUTLINE_MESSAGES[report.locale]
  const sections: ProjectStatusReportOutlineSection[] = []
  const push = (section: ProjectStatusReportSection, lines: string[], notes: string[] = []) => {
    sections.push({
      section,
      heading: messages.headings[section],
      lines: lines.length + notes.length > 0 ? [...lines, ...notes] : [messages.empty],
      noteCount: notes.length,
    })
  }
  if (report.health) {
    const health = report.health
    push('health', [
      messages.healthLine(messages.health[health.health], messages.risk[health.risk]),
      ...splitLines(health.summary),
      messages.published(formatTimestamp(health.publishedAt), health.authorName),
    ])
  }
  if (report.schedule) {
    const schedule = report.schedule
    push('schedule', [
      ...(schedule.items.length > 0 ? [messages.delayedCount(schedule.delayedCount)] : []),
      ...schedule.items.map((item) => messages.scheduleLine(
        item,
        messages.scheduleType[item.type],
        messages.status[item.status],
        messages.health[item.health],
      )),
    ], schedule.hiddenCount > 0 ? [messages.hidden(schedule.hiddenCount)] : [])
  }
  if (report.progress) push('progress', messages.progressLines(report.progress))
  if (report.risks) {
    const risks = report.risks
    push('risks', [
      messages.riskCounts(risks),
      ...risks.items.flatMap((item) => [
        messages.riskLine(item, messages.riskKind[item.kind], messages.severity[item.severity]),
        ...(item.response ? [`  ${messages.response(singleLine(item.response))}`] : []),
      ]),
    ], risks.hiddenCount > 0 ? [messages.hidden(risks.hiddenCount)] : [])
  }
  if (report.nextActions) {
    const actions = report.nextActions
    push('nextActions', actions.items.map((item) => messages.actionLine(item)), [
      ...(actions.hiddenCount > 0 ? [messages.hidden(actions.hiddenCount)] : []),
      ...(actions.incomplete ? [messages.incompleteActions] : []),
    ])
  }
  return {
    title: messages.title(report.projectName),
    subtitle: messages.subtitle(report.teamName, formatTimestamp(report.asOf)),
    sections,
  }
}

/**
 * Joins the lines of a free-text item into one, so that a line break inside it does not start a
 * new list item.
 *
 * @param text - Item text.
 * @returns The text with every run of whitespace replaced by one space.
 */
function singleLine(text: string) {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Writes a report as Markdown.
 *
 * @param report - Validated report.
 * @returns Markdown text ending with a line feed.
 */
export function renderProjectStatusReportMarkdown(report: ProjectStatusReport): string {
  const outline = createProjectStatusReportOutline(report)
  const blocks = [`# ${escapeMarkdown(outline.title)}`, escapeMarkdown(outline.subtitle)]
  for (const section of outline.sections) {
    blocks.push(
      `## ${escapeMarkdown(section.heading)}`,
      // A line break inside a line would end its list item, so each line is joined into one.
      section.lines.map((line) => line.startsWith('  ')
        ? `  - ${escapeMarkdown(singleLine(line))}`
        : `- ${escapeMarkdown(singleLine(line))}`).join('\n'),
    )
  }
  return `${blocks.join('\n\n')}\n`
}

/**
 * Splits free text into its non-empty lines.
 *
 * @param text - Text that may hold line breaks.
 * @returns Trimmed non-empty lines.
 */
function splitLines(text: string) {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
}

/**
 * Formats an ISO timestamp as `YYYY-MM-DD HH:mm UTC`.
 *
 * @param value - UTC ISO timestamp.
 * @returns The shortened timestamp.
 */
function formatTimestamp(value: string) {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`
}

/**
 * Escapes the characters that would start Markdown or HTML syntax inside report text.
 *
 * @param text - Plain text.
 * @returns Text that renders literally.
 */
function escapeMarkdown(text: string) {
  return text.replace(/[\\`*_{}[\]<>#|!~]/gu, (character) => `\\${character}`)
}

/**
 * Rebuilds a report from untrusted input.
 *
 * @param value - Untrusted input.
 * @returns The report.
 * @throws ReportShapeError for the first problem found.
 */
function readReport(value: unknown): ProjectStatusReport {
  const record = readRecord(value, 'report')
  if (record.schemaVersion !== PROJECT_STATUS_REPORT_SCHEMA_VERSION) throw new ReportShapeError('Report schema version is unknown.')
  const locale = readChoice(record.locale, ['ja', 'en'] as const, 'report.locale')
  const report: ProjectStatusReport = {
    schemaVersion: PROJECT_STATUS_REPORT_SCHEMA_VERSION,
    locale,
    projectName: readText(record.projectName, 'report.projectName', PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH),
    teamName: readText(record.teamName, 'report.teamName', PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH),
    asOf: readTimestamp(record.asOf, 'report.asOf'),
  }
  if (record.health !== undefined) report.health = readHealth(record.health)
  if (record.schedule !== undefined) report.schedule = readSchedule(record.schedule)
  if (record.progress !== undefined) report.progress = readProgress(record.progress)
  if (record.risks !== undefined) report.risks = readRisks(record.risks)
  if (record.nextActions !== undefined) report.nextActions = readNextActions(record.nextActions)
  return report
}

/**
 * Rebuilds the health section.
 *
 * @param value - Untrusted section.
 * @returns The section.
 */
function readHealth(value: unknown): ProjectStatusReportHealth {
  const record = readRecord(value, 'report.health')
  const authorName = readOptionalText(record.authorName, 'report.health.authorName', PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH)
  return {
    health: readChoice(record.health, HEALTHS, 'report.health.health'),
    risk: readChoice(record.risk, RISKS, 'report.health.risk'),
    summary: readText(record.summary, 'report.health.summary', PROJECT_STATUS_REPORT_TEXT_MAX_LENGTH, true),
    publishedAt: readTimestamp(record.publishedAt, 'report.health.publishedAt'),
    ...(authorName === undefined ? {} : { authorName }),
  }
}

/**
 * Rebuilds the schedule section.
 *
 * @param value - Untrusted section.
 * @returns The section.
 */
function readSchedule(value: unknown): ProjectStatusReportSchedule {
  const record = readRecord(value, 'report.schedule')
  return {
    items: readRows(record.items, 'report.schedule.items', (item, path) => {
      const row = readRecord(item, path)
      return {
        type: readChoice(row.type, SCHEDULE_TYPES, `${path}.type`),
        title: readText(row.title, `${path}.title`, PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH),
        status: readChoice(row.status, ENTITY_STATUSES, `${path}.status`),
        health: readChoice(row.health, HEALTHS, `${path}.health`),
        progress: readInteger(row.progress, `${path}.progress`, 0, 100),
        forecastEndDate: readDate(row.forecastEndDate, `${path}.forecastEndDate`),
        baselineEndDate: readDate(row.baselineEndDate, `${path}.baselineEndDate`),
        delayDays: readInteger(row.delayDays, `${path}.delayDays`, -36_600, 36_600),
      }
    }),
    hiddenCount: readCount(record.hiddenCount, 'report.schedule.hiddenCount'),
    delayedCount: readCount(record.delayedCount, 'report.schedule.delayedCount'),
  }
}

/**
 * Rebuilds the progress section.
 *
 * @param value - Untrusted section.
 * @returns The section.
 */
function readProgress(value: unknown): ProjectStatusReportProgress {
  const record = readRecord(value, 'report.progress')
  return {
    totalCount: readCount(record.totalCount, 'report.progress.totalCount'),
    openCount: readCount(record.openCount, 'report.progress.openCount'),
    inProgressCount: readCount(record.inProgressCount, 'report.progress.inProgressCount'),
    doneCount: readCount(record.doneCount, 'report.progress.doneCount'),
    completionRate: readInteger(record.completionRate, 'report.progress.completionRate', 0, 100),
    overdueCount: readCount(record.overdueCount, 'report.progress.overdueCount'),
    blockedCount: readCount(record.blockedCount, 'report.progress.blockedCount'),
  }
}

/**
 * Rebuilds the risks section.
 *
 * @param value - Untrusted section.
 * @returns The section.
 */
function readRisks(value: unknown): ProjectStatusReportRisks {
  const record = readRecord(value, 'report.risks')
  return {
    openRiskCount: readCount(record.openRiskCount, 'report.risks.openRiskCount'),
    openIssueCount: readCount(record.openIssueCount, 'report.risks.openIssueCount'),
    pendingDecisionCount: readCount(record.pendingDecisionCount, 'report.risks.pendingDecisionCount'),
    items: readRows(record.items, 'report.risks.items', (item, path) => {
      const row = readRecord(item, path)
      const response = readOptionalText(row.response, `${path}.response`, PROJECT_STATUS_REPORT_TEXT_MAX_LENGTH)
      const reviewDueDate = row.reviewDueDate === undefined ? undefined : readDate(row.reviewDueDate, `${path}.reviewDueDate`)
      return {
        kind: readChoice(row.kind, RISK_KINDS, `${path}.kind`),
        title: readText(row.title, `${path}.title`, PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH),
        severity: readChoice(row.severity, SEVERITIES, `${path}.severity`),
        ...(response === undefined ? {} : { response }),
        ...(reviewDueDate === undefined ? {} : { reviewDueDate }),
      }
    }),
    hiddenCount: readCount(record.hiddenCount, 'report.risks.hiddenCount'),
  }
}

/**
 * Rebuilds the next actions section.
 *
 * @param value - Untrusted section.
 * @returns The section.
 */
function readNextActions(value: unknown): ProjectStatusReportNextActions {
  const record = readRecord(value, 'report.nextActions')
  return {
    items: readRows(record.items, 'report.nextActions.items', (item, path) => {
      const row = readRecord(item, path)
      const dueDate = row.dueDate === undefined ? undefined : readDate(row.dueDate, `${path}.dueDate`)
      const ownerName = readOptionalText(row.ownerName, `${path}.ownerName`, PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH)
      if (typeof row.overdue !== 'boolean') throw new ReportShapeError(`${path}.overdue must be true or false.`)
      return {
        text: readText(row.text, `${path}.text`, PROJECT_STATUS_REPORT_TEXT_MAX_LENGTH),
        ...(dueDate === undefined ? {} : { dueDate }),
        ...(ownerName === undefined ? {} : { ownerName }),
        overdue: row.overdue,
      }
    }),
    hiddenCount: readCount(record.hiddenCount, 'report.nextActions.hiddenCount'),
    ...readIncomplete(record.incomplete),
  }
}

/**
 * Reads a bounded list of rows.
 *
 * @param value - Untrusted list.
 * @param path - Field path used in messages.
 * @param readRow - Rebuilds one row.
 * @returns The rows.
 */
function readRows<T>(value: unknown, path: string, readRow: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new ReportShapeError(`${path} must be a list.`)
  if (value.length > PROJECT_STATUS_REPORT_MAX_ROWS) {
    throw new ReportShapeError(`${path} must hold at most ${PROJECT_STATUS_REPORT_MAX_ROWS} rows.`)
  }
  return value.map((item, index) => readRow(item, `${path}[${index}]`))
}

/**
 * Narrows untrusted input to a plain object.
 *
 * @param value - Untrusted input.
 * @param path - Field path used in messages.
 * @returns The object.
 */
function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReportShapeError(`${path} must be an object.`)
  }
  return Object.fromEntries(Object.entries(value))
}

/**
 * Reads one of a fixed set of values.
 *
 * @param value - Untrusted input.
 * @param choices - Allowed values.
 * @param path - Field path used in messages.
 * @returns The value.
 */
function readChoice<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  const found = choices.find((choice) => choice === value)
  if (found === undefined) throw new ReportShapeError(`${path} is not one of the known values.`)
  return found
}

/**
 * Reads trimmed, bounded text without control characters.
 *
 * @param value - Untrusted input.
 * @param path - Field path used in messages.
 * @param maxLength - Longest allowed text.
 * @param allowEmpty - Whether empty text is allowed.
 * @returns The trimmed text.
 */
function readText(value: unknown, path: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new ReportShapeError(`${path} must be text.`)
  const text = value.trim()
  if (!allowEmpty && text.length === 0) throw new ReportShapeError(`${path} is required.`)
  if (text.length > maxLength) throw new ReportShapeError(`${path} must be at most ${maxLength} characters.`)
  if (DISALLOWED_CONTROL_CHARACTER.test(text) || LONE_SURROGATE.test(text)) {
    throw new ReportShapeError(`${path} must not contain control characters.`)
  }
  return text
}

/**
 * Reads optional text; empty text counts as absent.
 *
 * @param value - Untrusted input.
 * @param path - Field path used in messages.
 * @param maxLength - Longest allowed text.
 * @returns The trimmed text, or `undefined`.
 */
function readOptionalText(value: unknown, path: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  const text = readText(value, path, maxLength, true)
  return text.length === 0 ? undefined : text
}

/**
 * Reads a `YYYY-MM-DD` calendar date.
 *
 * @param value - Untrusted input.
 * @param path - Field path used in messages.
 * @returns The date.
 */
function readDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ReportShapeError(`${path} must be a date in YYYY-MM-DD.`)
  }
  return value
}

/**
 * Reads a UTC ISO timestamp.
 *
 * @param value - Untrusted input.
 * @param path - Field path used in messages.
 * @returns The timestamp.
 */
function readTimestamp(value: unknown, path: string): string {
  if (!isProjectStatusReportTimestamp(value)) {
    throw new ReportShapeError(`${path} must be a UTC ISO timestamp.`)
  }
  return value
}

/**
 * Reads an integer within a range.
 *
 * @param value - Untrusted input.
 * @param path - Field path used in messages.
 * @param min - Smallest allowed value.
 * @param max - Largest allowed value.
 * @returns The integer.
 */
function readInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ReportShapeError(`${path} must be an integer from ${min} to ${max}.`)
  }
  return value
}

/**
 * Reads a non-negative count.
 *
 * @param value - Untrusted input.
 * @param path - Field path used in messages.
 * @returns The count.
 */
function readCount(value: unknown, path: string): number {
  return readInteger(value, path, 0, 1_000_000_000)
}

/**
 * Validates one share link from an API response.
 *
 * @param value - Untrusted value.
 * @returns The share, or `undefined` when the value is malformed.
 */
export function parseProjectStatusShare(value: unknown): ProjectStatusShare | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = Object.fromEntries(Object.entries(value))
  const scope = parseProjectStatusShareScope(record.sections, record.showPeopleNames)
  const text = (field: unknown): field is string => typeof field === 'string' && field.length > 0
  const optional = (field: unknown) => field === undefined || text(field)
  if (
    !scope.ok ||
    !text(record.id) ||
    !text(record.teamId) ||
    !text(record.projectId) ||
    !text(record.label) ||
    !isProjectStatusReportTimestamp(record.expiresAt) ||
    !text(record.createdAt) ||
    !text(record.createdByMemberKey) ||
    !text(record.reportAsOf) ||
    !optional(record.revokedAt) ||
    !optional(record.customerId) ||
    !optional(record.contactId) ||
    !optional(record.lastViewedAt) ||
    typeof record.viewCount !== 'number' ||
    !Number.isSafeInteger(record.viewCount) ||
    record.viewCount < 0
  ) {
    return undefined
  }
  const share: ProjectStatusShare = {
    id: record.id,
    teamId: record.teamId,
    projectId: record.projectId,
    label: record.label,
    sections: scope.value.sections,
    showPeopleNames: scope.value.showPeopleNames,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    createdByMemberKey: record.createdByMemberKey,
    reportAsOf: record.reportAsOf,
    viewCount: record.viewCount,
  }
  if (text(record.revokedAt)) share.revokedAt = record.revokedAt
  if (text(record.customerId)) share.customerId = record.customerId
  if (text(record.contactId)) share.contactId = record.contactId
  if (text(record.lastViewedAt)) share.lastViewedAt = record.lastViewedAt
  return share
}

/**
 * Validates the share list response.
 *
 * @param value - Untrusted response body.
 * @returns The response, or `undefined` when it is malformed.
 */
export function parseProjectStatusShareListResponse(value: unknown): ProjectStatusShareListResponse | undefined {
  if (typeof value !== 'object' || value === null || !('shares' in value) || !Array.isArray(value.shares)) return undefined
  const shares = value.shares.map(parseProjectStatusShare)
  return shares.every((share) => share !== undefined) ? { shares } : undefined
}

/**
 * Validates the share creation response.
 *
 * @param value - Untrusted response body.
 * @returns The response, or `undefined` when it is malformed.
 */
export function parseCreateProjectStatusShareResponse(value: unknown): CreateProjectStatusShareResponse | undefined {
  if (typeof value !== 'object' || value === null || !('share' in value) || !('url' in value)) return undefined
  const share = parseProjectStatusShare(value.share)
  const url = value.url
  if (!share || typeof url !== 'string' || !url.startsWith('/share/project-status/')) return undefined
  return { share, url }
}

/**
 * Validates the public share page response.
 *
 * @param value - Untrusted response body.
 * @returns The response, or `undefined` when it is malformed.
 */
export function parsePublicProjectStatusReportResponse(value: unknown): PublicProjectStatusReportResponse | undefined {
  if (typeof value !== 'object' || value === null || !('report' in value) || !('expiresAt' in value)) return undefined
  const report = parseProjectStatusReport(value.report)
  const expiresAt = value.expiresAt
  if (!report.ok || !isProjectStatusReportTimestamp(expiresAt)) return undefined
  return { report: report.value, expiresAt }
}

/**
 * Reads the optional flag that marks the next actions as possibly incomplete.
 *
 * @param value - Raw flag.
 * @returns The flag to spread into the section, set only when true.
 * @throws ReportShapeError when the flag is present but not a boolean.
 */
function readIncomplete(value: unknown): { incomplete?: true } {
  if (value === undefined || value === false) return {}
  if (value !== true) throw new ReportShapeError('report.nextActions.incomplete must be true or false.')
  return { incomplete: true }
}
