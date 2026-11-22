import {
  classifyFactoryBoardItem,
  deriveProjectRaidSeverity,
  isProjectRaidReviewOverdue,
  PROJECT_RAID_SEVERITIES,
  summarizeProjectRaidLog,
  type CanonicalWorkItem,
  type DocumentKind,
  type FactoryBoardLane,
  type PlanningEntity,
  type PlanningEntityType,
  type PlanningUpdateTargetSummary,
  type PlanningWorkItemSummary,
  type ProjectRaidEntry,
  type ProjectRaidEntryKind,
  type ProjectRaidSeverity,
  type TeamAgentRunBoardResponse,
  type WorkflowStatusCategory,
} from '@mukuroji/contracts'
import type { DocumentBacklink } from '../../documents/api/backlinks'
import type { DocumentSummary } from '../../documents/api/documents'
import type { ProjectActionItem } from '../../documents/model/projectActionItems'
import type { ProjectMember, ProjectMemberRole } from '../api/members'
import { resolveWorkflowStatusCategory } from '../../work-items/model/workItemDisplay'
import { isWorkspaceTaskOverdue } from '../../work-items/model/workspaceWorkItems'

/** Most schedule entities (Phase, Milestone, Release) shown on the Project overview. */
export const PROJECT_OVERVIEW_SCHEDULE_LIMIT = 6

/** Most open Document action items listed on the Project overview. */
export const PROJECT_OVERVIEW_ACTION_ITEM_LIMIT = 15

/** Most Project members listed by name on the Project overview. */
export const PROJECT_OVERVIEW_MEMBER_LIMIT = 8

/** Most open risks and issues, and most recent decisions, listed on the Project overview. */
export const PROJECT_OVERVIEW_RAID_LIMIT = 3

/** Most related Documents listed on the Project overview. */
export const PROJECT_OVERVIEW_DOCUMENT_LIMIT = 6

/** Planning entity types shown as the Project schedule on the overview. */
const projectOverviewScheduleTypes: ReadonlySet<PlanningEntityType> = new Set<PlanningEntityType>([
  'phase',
  'milestone',
  'release',
])

/** Work Item counts shown by the Project overview progress widget. */
export type ProjectOverviewWorkItemSummary = {
  /** Every readable Work Item of the Project. */
  totalCount: number
  /** Work Items outside completed and canceled workflow categories. */
  openCount: number
  /** Work Items in the started workflow category. */
  inProgressCount: number
  /** Work Items in the completed workflow category. */
  doneCount: number
  /** Rounded percentage of completed Work Items among all Work Items. */
  completionRate: number
  /** Open Work Items whose due date has passed. */
  overdueCount: number
  /** Open Work Items with high priority. */
  highPriorityOpenCount: number
  /** Open Work Items blocked by at least one readable Work Item that is not completed or canceled. */
  blockedCount: number
}

/** One Phase, Milestone, or Release row shown on the Project overview. */
export type ProjectOverviewScheduleItem = {
  /** Planning entity identifier. */
  id: string
  /** Planning entity type. */
  type: PlanningEntityType
  /** Display title. */
  title: string
  /** Lifecycle status of the entity. */
  status: PlanningEntity['status']
  /** Health rolled up from the entity and its descendants. */
  health: PlanningEntity['rollupHealth']
  /** Read-time progress from 0 to 100. */
  progress: number
  /** Forecast end date in `YYYY-MM-DD`. */
  forecastEndDate: string
  /** Baseline end date in `YYYY-MM-DD`. */
  baselineEndDate: string
  /** Days the forecast end is after the baseline end; negative when earlier. */
  delayDays: number
}

/** Bounded Phase, Milestone, and Release list of one Project. */
export type ProjectOverviewSchedule = {
  /** Rows shown on the overview, nearest forecast end first. */
  items: ProjectOverviewScheduleItem[]
  /** Rows left out because of the overview limit. */
  hiddenCount: number
  /** Rows whose forecast end is after their baseline end, counted over every row. */
  delayedCount: number
}

/** Project members grouped by role, with a bounded named list. */
export type ProjectOverviewMembers = {
  /** Number of members for each Project role. */
  roleCounts: Record<ProjectMemberRole, number>
  /** Every member counted by the summary. */
  totalCount: number
  /** Members shown by name, managers first. */
  shown: ProjectMember[]
  /** Members left out because of the overview limit. */
  hiddenCount: number
}

/**
 * Counts the Project's Work Items for the overview progress and attention widgets.
 *
 * Two Teams can use the same Project ID, and the Project list returns both Teams' Work
 * Items, so only the Work Items of the overview's Team are counted.
 *
 * A Work Item counts as blocked when one of its `blockedBy` relations names a Work Item of the
 * same Team that is readable and still open. Blockers outside the Project are looked up in the
 * Planning snapshot's Work Items. A blocker the viewer cannot read is left out, the same way
 * Focus leaves it out, so the count never reveals a hidden Work Item.
 *
 * @param projectWorkItems - Readable Work Items assigned to the Project.
 * @param teamId - Team that owns the Project shown by the overview.
 * @param referenceDate - Instant that decides whether a due date has passed.
 * @param planningWorkItems - Readable Work Items of the Planning snapshot, used to resolve the
 * status of blockers outside the Project; empty while the snapshot is unavailable.
 * @returns Progress and attention counts.
 */
export function summarizeProjectOverviewWorkItems(
  projectWorkItems: readonly CanonicalWorkItem[],
  teamId: string,
  referenceDate: Date,
  planningWorkItems: readonly PlanningWorkItemSummary[] = [],
): ProjectOverviewWorkItemSummary {
  const workItems = projectWorkItems.filter((workItem) => workItem.teamId === teamId)
  const statusById = new Map<string, WorkflowStatusCategory>()
  for (const workItem of planningWorkItems) {
    if (workItem.teamId === teamId) statusById.set(workItem.id, workItem.statusCategory)
  }
  for (const workItem of workItems) statusById.set(workItem.id, resolveWorkflowStatusCategory(workItem))
  let openCount = 0
  let inProgressCount = 0
  let doneCount = 0
  let overdueCount = 0
  let highPriorityOpenCount = 0
  let blockedCount = 0

  for (const workItem of workItems) {
    const category = resolveWorkflowStatusCategory(workItem)
    if (category === 'completed') doneCount += 1
    if (category === 'started') inProgressCount += 1
    if (isTerminalStatusCategory(category)) continue
    openCount += 1
    if (workItem.priority === 'high') highPriorityOpenCount += 1
    if (isWorkspaceTaskOverdue(workItem, referenceDate)) overdueCount += 1
    if (hasOpenBlocker(workItem, statusById)) blockedCount += 1
  }

  const totalCount = workItems.length
  return {
    blockedCount,
    completionRate: totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0,
    doneCount,
    highPriorityOpenCount,
    inProgressCount,
    openCount,
    overdueCount,
    totalCount,
  }
}

/**
 * Tells whether a workflow status category ends the Work Item.
 *
 * @param category - Workflow status category.
 * @returns Whether the category is completed or canceled.
 */
function isTerminalStatusCategory(category: WorkflowStatusCategory) {
  return category === 'completed' || category === 'canceled'
}

/** Prefix of the projected relation IDs that name a blocking Work Item. */
const blockedByRelationPrefix = 'blockedBy:'

/**
 * Tells whether one of a Work Item's recorded blockers is readable and still open.
 *
 * @param workItem - Work Item whose `blockedBy` relations are checked.
 * @param statusById - Status categories of the readable Work Items of the same Team.
 * @returns Whether an open blocker exists.
 */
function hasOpenBlocker(workItem: CanonicalWorkItem, statusById: ReadonlyMap<string, WorkflowStatusCategory>) {
  return workItem.relationIds.some((relationId) => {
    if (!relationId.startsWith(blockedByRelationPrefix)) return false
    const category = statusById.get(relationId.slice(blockedByRelationPrefix.length))
    return category !== undefined && !isTerminalStatusCategory(category)
  })
}

/**
 * Finds the update target of one Team-qualified Project.
 *
 * @param targets - Update target summaries from the Planning snapshot.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @returns The Project's update target, or `undefined` when none is configured or readable.
 */
export function findProjectOverviewUpdateTarget(
  targets: readonly PlanningUpdateTargetSummary[],
  teamId: string,
  projectId: string,
): PlanningUpdateTargetSummary | undefined {
  return targets.find((candidate) =>
    candidate.target.type === 'project' &&
    candidate.target.teamId === teamId &&
    candidate.target.projectId === projectId
  )
}

/**
 * Selects the Project's live Phases, Milestones, and Releases, nearest forecast end first.
 *
 * @param entities - Planning entities from the snapshot.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param limit - Most rows to return.
 * @returns The bounded schedule with the number of rows left out and of delayed rows.
 */
export function selectProjectOverviewSchedule(
  entities: readonly PlanningEntity[],
  teamId: string,
  projectId: string,
  limit = PROJECT_OVERVIEW_SCHEDULE_LIMIT,
): ProjectOverviewSchedule {
  const rows = entities
    .filter((entity) =>
      projectOverviewScheduleTypes.has(entity.type) &&
      entity.teamId === teamId &&
      entity.projectId === projectId &&
      entity.archivedAt === undefined
    )
    .map((entity): ProjectOverviewScheduleItem => ({
      baselineEndDate: entity.baseline.endDate,
      delayDays: countCalendarDaysBetween(entity.baseline.endDate, entity.forecast.endDate),
      forecastEndDate: entity.forecast.endDate,
      health: entity.rollupHealth,
      id: entity.id,
      progress: entity.progress,
      status: entity.status,
      title: entity.title,
      type: entity.type,
    }))
    .sort((left, right) =>
      left.forecastEndDate.localeCompare(right.forecastEndDate) ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id)
    )
  const boundedLimit = Math.max(0, limit)

  return {
    delayedCount: rows.filter((row) => row.delayDays > 0).length,
    hiddenCount: Math.max(0, rows.length - boundedLimit),
    items: rows.slice(0, boundedLimit),
  }
}

/**
 * Groups Project members by role and keeps a bounded list, managers first.
 *
 * @param members - Project members returned by the member API.
 * @param limit - Most members to list by name.
 * @returns Role counts and the bounded member list.
 */
export function summarizeProjectOverviewMembers(
  members: readonly ProjectMember[],
  limit = PROJECT_OVERVIEW_MEMBER_LIMIT,
): ProjectOverviewMembers {
  const roleOrder: Record<ProjectMemberRole, number> = { manager: 0, member: 1, viewer: 2 }
  const roleCounts: Record<ProjectMemberRole, number> = { manager: 0, member: 0, viewer: 0 }
  for (const member of members) {
    roleCounts[member.role] += 1
  }
  const sorted = [...members].sort((left, right) =>
    roleOrder[left.role] - roleOrder[right.role] ||
    resolveProjectOverviewMemberName(left).localeCompare(resolveProjectOverviewMemberName(right)) ||
    left.id.localeCompare(right.id)
  )
  const boundedLimit = Math.max(0, limit)

  return {
    hiddenCount: Math.max(0, sorted.length - boundedLimit),
    roleCounts,
    shown: sorted.slice(0, boundedLimit),
    totalCount: members.length,
  }
}

/** Agent Run lane counts of one Project, taken from its Team's Factory board. */
export type ProjectOverviewAgentRuns = {
  /** Work Items of the Project in each Factory board lane. */
  laneCounts: Record<FactoryBoardLane, number>
  /** Work Items of the Project on the board, across every lane. */
  totalCount: number
  /** Whether the board stopped at a read bound, so the counts can be low. */
  isIncomplete: boolean
}

/**
 * Counts one Project's Work Items in each Factory board lane.
 *
 * The lanes come from the shared `classifyFactoryBoardItem` rule evaluated at the board's
 * `generatedAt`, the same way the Factory board places its tiles, so both screens agree.
 *
 * @param board - The Team's Factory board.
 * @param projectId - Project whose Work Items are counted.
 * @returns Lane counts and whether the board read was bounded.
 */
export function summarizeProjectOverviewAgentRuns(
  board: TeamAgentRunBoardResponse,
  projectId: string,
): ProjectOverviewAgentRuns {
  const laneCounts: Record<FactoryBoardLane, number> = {
    processing: 0,
    'no-run': 0,
    decision: 0,
    stalled: 0,
    failed: 0,
    completed: 0,
  }
  const evaluatedAt = new Date(board.generatedAt)
  const now = Number.isFinite(evaluatedAt.getTime()) ? evaluatedAt : new Date()
  let totalCount = 0
  for (const item of board.items) {
    if (item.workItem.assignedProjectId !== projectId) continue
    const lane = classifyFactoryBoardItem(item, now)
    if (lane === undefined) continue
    laneCounts[lane] += 1
    totalCount += 1
  }
  return {
    isIncomplete: board.activeRunsHasMore || board.finishedRunsHasMore || board.startedWorkItemsHasMore,
    laneCounts,
    totalCount,
  }
}

/** One risk, issue, or decided change request listed on the Project overview. */
export type ProjectOverviewRaidItem = {
  /** Entry ID. */
  id: string
  /** Whether the entry is a risk, an issue, or a change request. */
  kind: ProjectRaidEntryKind
  /** Short name of the entry. */
  title: string
  /** Severity derived from probability and impact. */
  severity: ProjectRaidSeverity
  /** Mitigation, resolution, or decision, when recorded. */
  response?: string
  /** Review date in `YYYY-MM-DD`, when set. */
  reviewDueDate?: string
  /** Whether the entry is open and its review date has passed. */
  isReviewOverdue: boolean
  /** ISO timestamp of the decision; set only on decided change requests. */
  decidedAt?: string
}

/** Open counts and the entries of a Project log that ask for attention on the overview. */
export type ProjectOverviewRaid = {
  /** Open risks. */
  openRiskCount: number
  /** Open issues. */
  openIssueCount: number
  /** Open change requests, which still wait for a decision. */
  pendingDecisionCount: number
  /** Open entries whose review date has passed. */
  overdueReviewCount: number
  /** Open risks and issues, most severe first, within the overview limit. */
  attention: ProjectOverviewRaidItem[]
  /** Open risks and issues left out because of the overview limit. */
  hiddenAttentionCount: number
  /** Closed change requests, most recently decided first, within the overview limit. */
  recentDecisions: ProjectOverviewRaidItem[]
}

/**
 * Picks the open risks and issues and the recent decisions of a Project log for the overview.
 *
 * Open risks and issues are ordered by severity, then by the nearest review date, then by the
 * latest change. A decision is a closed change request; the most recently closed comes first.
 *
 * @param entries - Every entry of the Project log.
 * @param today - Today in `YYYY-MM-DD`, in the viewer's calendar.
 * @param limit - Most entries to list in each group.
 * @returns Open counts and the bounded entry lists.
 */
export function summarizeProjectOverviewRaid(
  entries: readonly ProjectRaidEntry[],
  today: string,
  limit = PROJECT_OVERVIEW_RAID_LIMIT,
): ProjectOverviewRaid {
  const summary = summarizeProjectRaidLog(entries, today)
  const boundedLimit = Math.max(0, limit)
  const attention = entries
    .filter((entry) => entry.status === 'open' && entry.kind !== 'change-request')
    .map((entry) => toProjectOverviewRaidItem(entry, today))
    .sort((left, right) =>
      PROJECT_RAID_SEVERITIES.indexOf(right.severity) - PROJECT_RAID_SEVERITIES.indexOf(left.severity) ||
      compareOptionalDates(left.reviewDueDate, right.reviewDueDate) ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id)
    )
  const recentDecisions = entries
    .filter((entry) => entry.status === 'closed' && entry.kind === 'change-request')
    .map((entry) => toProjectOverviewRaidItem(entry, today))
    .sort((left, right) =>
      (right.decidedAt ?? '').localeCompare(left.decidedAt ?? '') ||
      left.id.localeCompare(right.id)
    )

  return {
    attention: attention.slice(0, boundedLimit),
    hiddenAttentionCount: Math.max(0, attention.length - boundedLimit),
    openIssueCount: summary.openCounts.issue,
    openRiskCount: summary.openCounts.risk,
    overdueReviewCount: summary.overdueReviewCount,
    pendingDecisionCount: summary.openCounts['change-request'],
    recentDecisions: recentDecisions.slice(0, boundedLimit),
  }
}

/**
 * Builds the overview row of one log entry.
 *
 * @param entry - Log entry.
 * @param today - Today in `YYYY-MM-DD`, used to mark an overdue review.
 * @returns The overview row.
 */
function toProjectOverviewRaidItem(entry: ProjectRaidEntry, today: string): ProjectOverviewRaidItem {
  const decidedAt = entry.kind === 'change-request' && entry.status === 'closed'
    ? entry.closedAt ?? entry.updatedAt
    : undefined
  return {
    id: entry.id,
    isReviewOverdue: isProjectRaidReviewOverdue(entry, today),
    kind: entry.kind,
    severity: deriveProjectRaidSeverity(entry),
    title: entry.title,
    ...(entry.response ? { response: entry.response } : {}),
    ...(entry.reviewDueDate ? { reviewDueDate: entry.reviewDueDate } : {}),
    ...(decidedAt ? { decidedAt } : {}),
  }
}

/**
 * Orders two optional `YYYY-MM-DD` dates, earliest first and missing dates last.
 *
 * @param left - First date.
 * @param right - Second date.
 * @returns A negative, zero, or positive sort value.
 */
function compareOptionalDates(left: string | undefined, right: string | undefined) {
  if (left === right) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  return left.localeCompare(right)
}

/**
 * Tells whether a Document kind holds content listed on the Project overview.
 *
 * @param kind - Document kind.
 * @returns Whether the kind is a page or a whiteboard, not a folder or a template.
 */
function isListedDocumentKind(kind: DocumentKind) {
  return kind === 'page' || kind === 'whiteboard'
}

/** One Document listed on the Project overview. */
export type ProjectOverviewDocument = {
  /** Document ID. */
  id: string
  /** Document title. */
  title: string
  /** Whether the Document links to the Project, or only sits in the Project's scope. */
  source: 'linked' | 'project'
}

/** Bounded list of the Documents related to one Project. */
export type ProjectOverviewDocuments = {
  /** Documents shown, linked ones first. */
  items: ProjectOverviewDocument[]
  /** Documents read but left out because of the overview limit. */
  hiddenCount: number
  /** Whether a source has more pages that the overview did not read. */
  hasMore: boolean
}

/**
 * Lists the Documents related to a Project: the ones that link to it, then the pages in its scope.
 *
 * A Document that both links to the Project and sits in its scope is listed once, as linked.
 * Folders, templates, and archived Documents are left out. Pages in the scope are ordered by their latest change.
 * Backlinks to another target and Documents of another scope are ignored, so a response for a
 * different Project never shows up here.
 *
 * @param projectId - Project whose Documents are listed.
 * @param backlinks - Readable Documents that link to the Project, in the API order.
 * @param projectDocuments - Readable Documents in the Project's scope.
 * @param hasMore - Whether either source returned a continuation cursor.
 * @param limit - Most Documents to list.
 * @returns The bounded Document list.
 */
export function selectProjectOverviewDocuments(
  projectId: string,
  backlinks: readonly DocumentBacklink[],
  projectDocuments: readonly DocumentSummary[],
  hasMore: boolean,
  limit = PROJECT_OVERVIEW_DOCUMENT_LIMIT,
): ProjectOverviewDocuments {
  const seen = new Set<string>()
  const rows: ProjectOverviewDocument[] = []
  for (const backlink of backlinks) {
    const target = backlink.relation.target
    if (target.kind !== 'project' || target.projectId !== projectId) continue
    if (backlink.documentKind !== undefined && !isListedDocumentKind(backlink.documentKind)) continue
    if (seen.has(backlink.documentId)) continue
    seen.add(backlink.documentId)
    rows.push({ id: backlink.documentId, source: 'linked', title: backlink.documentTitle })
  }
  const scoped = projectDocuments
    .filter((document) =>
      document.scope.type === 'project' &&
      document.scope.projectId === projectId &&
      isListedDocumentKind(document.kind) &&
      document.archivedAt === undefined
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
  for (const document of scoped) {
    if (seen.has(document.id)) continue
    seen.add(document.id)
    rows.push({ id: document.id, source: 'project', title: document.title })
  }
  const boundedLimit = Math.max(0, limit)
  return {
    hasMore,
    hiddenCount: Math.max(0, rows.length - boundedLimit),
    items: rows.slice(0, boundedLimit),
  }
}

/**
 * Resolves the label shown for one Project member.
 *
 * @param member - Project member.
 * @returns The display name, or the email address when no name is set.
 */
export function resolveProjectOverviewMemberName(member: ProjectMember) {
  return member.name?.trim() || member.email
}

/**
 * Counts calendar days from one `YYYY-MM-DD` date to another.
 *
 * @param from - Start date.
 * @param to - End date.
 * @returns Whole days from `from` to `to`, or 0 when either date is invalid.
 */
function countCalendarDaysBetween(from: string, to: string) {
  const fromTime = Date.parse(`${from}T00:00:00.000Z`)
  const toTime = Date.parse(`${to}T00:00:00.000Z`)
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return 0
  return Math.round((toTime - fromTime) / 86_400_000)
}

/** One open Document action item as the Project overview shows it. */
export type ProjectOverviewActionItem = ProjectActionItem & {
  /** Owner name, or the saved member key when the owner is not a Project member. */
  ownerLabel?: string
  /** Whether the deadline is before today. */
  overdue: boolean
}

/** Bounded list of a Project's open Document action items. */
export type ProjectOverviewActionItems = {
  /** Items shown, earliest deadline first. */
  items: ProjectOverviewActionItem[]
  /** Open items read but left out because of the overview limit. */
  hiddenCount: number
  /** Pages that could not be read or were left out, so items may be missing. */
  unreadDocumentCount: number
}

/**
 * Prepares a Project's open Document action items for the overview.
 *
 * @param items - Open action items, earliest deadline first.
 * @param unreadDocumentCount - Pages whose items could not be read or were left out.
 * @param members - Project members used to show owner names.
 * @param today - Viewer's local `YYYY-MM-DD` date.
 * @param limit - Most items to show.
 * @returns Items with owner names and overdue state, and what was left out.
 */
export function summarizeProjectOverviewActionItems(
  items: readonly ProjectActionItem[],
  unreadDocumentCount: number,
  members: readonly ProjectMember[],
  today: string,
  limit = PROJECT_OVERVIEW_ACTION_ITEM_LIMIT,
): ProjectOverviewActionItems {
  const names = new Map(members.map((member) => [member.id, resolveProjectOverviewMemberName(member)]))
  return {
    hiddenCount: Math.max(0, items.length - limit),
    items: items.slice(0, limit).map((item) => {
      const ownerLabel = item.assigneeMemberKey
        ? names.get(item.assigneeMemberKey) ?? item.assigneeMemberKey
        : undefined
      return {
        ...item,
        ...(ownerLabel ? { ownerLabel } : {}),
        overdue: item.dueDate !== undefined && item.dueDate < today,
      }
    }),
    unreadDocumentCount,
  }
}
