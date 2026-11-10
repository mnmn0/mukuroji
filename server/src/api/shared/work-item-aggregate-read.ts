import {
  WORKSPACE_WORK_ITEM_PAGE_DEFAULT_LIMIT,
  WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT,
  deriveWorkItemScheduleDueDate,
  type WorkItemSummaryBucket,
  type WorkItemSummaryResponse,
  type WorkflowStatusCategory,
  type WorkspaceWorkItemListFilter,
  type WorkspaceWorkItemPage,
} from '@mukuroji/contracts'
import { createHash } from 'node:crypto'
import { ProjectDataError } from '../../modules/directory'
import {
  workItemScheduleInstantToLocalDate,
  type TeamIssueResponseItem,
} from '../../modules/work-items'
import { mapInOrderWithConcurrency } from './agent-run-access'
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import {
  WORK_ITEMS_AGGREGATE_ITEM_LIMIT,
  WORK_ITEMS_AGGREGATE_READ_CONCURRENCY,
  WORK_ITEMS_AGGREGATE_READ_PAGE_SIZE,
  WORK_ITEMS_AGGREGATE_TEAM_LIMIT,
  WORK_ITEMS_PAGE_SCAN_BUDGET,
  WORK_ITEMS_SUMMARY_SCAN_LIMIT,
} from './constants'
import { getEffectiveProjectAccessList, type ProjectPrincipal } from './project-access'
import {
  createWorkItemListLimitExceededError,
  filterAccessibleTeamIssues,
} from './work-item-access'
import { projectAccessAllows, type TeamPermissionContext } from './workspace-access'

/** Optional Team/Project envelope that bounds an aggregate Work Item read. */
export type WorkItemAggregateReadScope = {
  /** Team whose Work Item partition should be read. */
  teamId?: string
  /** Project whose assigned Work Items should be retained. */
  projectId?: string
}

/** Server-side filter applied after the caller's access filter. */
export type WorkItemAggregateFilter = Omit<WorkspaceWorkItemListFilter, 'involvement'> & {
  /** Normalized member keys; a Work Item matches when its owner or a contributor is one of them. */
  involvedMemberKeys?: readonly string[]
}

/** Options of a paged aggregate read. */
export type WorkItemAggregatePageOptions = {
  /** Largest number of Work Items returned in the page. */
  limit: number
  /** Opaque cursor returned by the previous page. */
  cursor?: string
  /** Whether archived Work Items are included. */
  includeArchived: boolean
  /** Server-side filter. */
  filter: WorkItemAggregateFilter
}

/** Decoded position of a Workspace Work Item page cursor. */
type WorkItemPageCursor = {
  /** Cursor schema version. */
  v: 1
  /** Fingerprint of the filter and archive option the cursor was issued for. */
  f: string
  /** Team partition where the next page resumes. */
  t: string
  /** Last evaluated Work Item ID within that Team partition. */
  a?: string
}

/**
 * Resolves the Team partitions the principal may read, in stable Team ID order.
 *
 * @param principal - Authenticated Workspace principal.
 * @param scope - Optional Team/Project envelope.
 * @returns Team permission contexts limited to readable Teams.
 */
export async function resolveAccessibleWorkItemTeamContexts(
  principal: ProjectPrincipal,
  scope?: WorkItemAggregateReadScope,
): Promise<TeamPermissionContext[]> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const projectAccesses = principal.isSystemAdmin
    ? undefined
    : await getEffectiveProjectAccessList(principal)
  const authorizedTeamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
  const selectedTeams = scope?.teamId === undefined
    ? directory.teams
    : directory.teams.filter((team) => team.id === scope.teamId)
  const contexts: TeamPermissionContext[] = selectedTeams.flatMap((team) => {
    if (principal.isSystemAdmin) {
      return [{ team, directory } satisfies TeamPermissionContext]
    }

    const teamProjectIds = new Set(team.projects.map((project) => project.id))
    const teamProjectAccesses = (projectAccesses ?? []).filter((access) =>
      teamProjectIds.has(access.projectId) &&
      (scope?.projectId === undefined || access.projectId === scope.projectId)
    )
    if (
      !authorizedTeamIds.has(team.id) &&
      !teamProjectAccesses.some((access) => projectAccessAllows(access, 'viewer'))
    ) {
      return []
    }

    return [{ team, directory, projectAccesses: teamProjectAccesses } satisfies TeamPermissionContext]
  })
  if (contexts.length > WORK_ITEMS_AGGREGATE_TEAM_LIMIT) {
    throw createWorkItemListLimitExceededError(
      `Workspace has more than ${WORK_ITEMS_AGGREGATE_TEAM_LIMIT} accessible Teams.`,
    )
  }

  return contexts.sort((left, right) => compareIds(left.team.id, right.team.id))
}

/**
 * Reads every accessible Work Item that matches the filter into memory.
 *
 * Team partitions are read in parallel and fully paged. The result keeps Team ID order, then
 * Work Item ID order. More than {@link WORK_ITEMS_AGGREGATE_ITEM_LIMIT} matches fail closed.
 *
 * @param principal - Authenticated Workspace principal.
 * @param contexts - Readable Team contexts.
 * @param options - Archive option and server-side filter.
 * @returns Matching Work Items.
 */
export async function readAllAccessibleWorkItems(
  principal: ProjectPrincipal,
  contexts: readonly TeamPermissionContext[],
  options: { includeArchived: boolean; filter?: WorkItemAggregateFilter },
): Promise<TeamIssueResponseItem[]> {
  let matchedCount = 0
  const perTeam = await mapInOrderWithConcurrency(
    contexts,
    WORK_ITEMS_AGGREGATE_READ_CONCURRENCY,
    async (context) => {
      const matches: TeamIssueResponseItem[] = []
      await forEachTeamPartitionPage(principal, context, options.includeArchived, (issues) => {
        for (const issue of issues) {
          if (options.filter && !matchesWorkItemAggregateFilter(issue, options.filter)) continue
          matches.push(issue)
          matchedCount += 1
          if (matchedCount > WORK_ITEMS_AGGREGATE_ITEM_LIMIT) {
            throw createWorkItemListLimitExceededError(
              `Workspace has more than ${WORK_ITEMS_AGGREGATE_ITEM_LIMIT} accessible Work Items.`,
            )
          }
        }
      })
      return matches
    },
  )
  return perTeam.flat()
}

/**
 * Reads one page of accessible Work Items in Team ID, then Work Item ID order.
 *
 * The page stops at `limit` matches or after {@link WORK_ITEMS_PAGE_SCAN_BUDGET} evaluated rows,
 * whichever comes first, so a selective filter cannot make one request read the whole Workspace.
 *
 * @param principal - Authenticated Workspace principal.
 * @param contexts - Readable Team contexts in Team ID order.
 * @param options - Page size, cursor, archive option, and filter.
 * @returns The page and the cursor of the next one.
 */
export async function readAccessibleWorkItemPage(
  principal: ProjectPrincipal,
  contexts: readonly TeamPermissionContext[],
  options: WorkItemAggregatePageOptions,
): Promise<WorkspaceWorkItemPage<TeamIssueResponseItem>> {
  const fingerprint = createWorkItemPageFilterFingerprint(options.filter, options.includeArchived)
  const cursor = decodeWorkItemPageCursor(options.cursor, fingerprint)
  const startIndex = cursor === undefined
    ? 0
    : contexts.findIndex((context) => compareIds(context.team.id, cursor.t) >= 0)
  if (startIndex < 0) return { workItems: [] }

  const workItems: TeamIssueResponseItem[] = []
  let evaluated = 0
  for (let index = startIndex; index < contexts.length; index += 1) {
    const context = contexts[index]
    if (!context) continue
    const teamId = context.team.id
    let startAfterIssueId = cursor !== undefined && index === startIndex && teamId === cursor.t
      ? cursor.a
      : undefined
    const isLastTeam = index === contexts.length - 1
    do {
      const remainingBudget = WORK_ITEMS_PAGE_SCAN_BUDGET - evaluated
      if (remainingBudget <= 0) {
        return {
          workItems,
          nextCursor: encodeWorkItemPageCursor({
            v: 1,
            f: fingerprint,
            t: teamId,
            ...(startAfterIssueId ? { a: startAfterIssueId } : {}),
          }),
        }
      }
      const response = await workItemDependencies.teamIssues.getTeamIssues(
        principal.directoryId,
        teamId,
        {
          limit: Math.min(WORK_ITEMS_AGGREGATE_READ_PAGE_SIZE, remainingBudget),
          consistentRead: true,
          includeArchived: options.includeArchived,
          ...(startAfterIssueId ? { startAfterIssueId } : {}),
        },
      )
      evaluated += response.issues.length
      const accessible = new Set(filterAccessibleTeamIssues(response.issues, principal, context))
      for (const [position, issue] of response.issues.entries()) {
        startAfterIssueId = issue.id
        if (!accessible.has(issue) || !matchesWorkItemAggregateFilter(issue, options.filter)) continue
        workItems.push(issue)
        if (workItems.length >= options.limit) {
          const exhausted = isLastTeam &&
            position === response.issues.length - 1 &&
            response.nextStartAfterIssueId === undefined
          return exhausted
            ? { workItems }
            : {
                workItems,
                nextCursor: encodeWorkItemPageCursor({ v: 1, f: fingerprint, t: teamId, a: issue.id }),
              }
        }
      }
      startAfterIssueId = response.nextStartAfterIssueId
    } while (startAfterIssueId !== undefined)
  }

  return { workItems }
}

/**
 * Counts accessible Work Items per Team and Project without holding them in memory.
 *
 * @param principal - Authenticated Workspace principal.
 * @param contexts - Readable Team contexts.
 * @param now - Instant used to decide which Work Items are overdue.
 * @returns Totals and per-bucket counts. Assignee labels are the raw IDs until hydrated.
 */
export async function summarizeAccessibleWorkItems(
  principal: ProjectPrincipal,
  contexts: readonly TeamPermissionContext[],
  now: Date,
): Promise<WorkItemSummaryResponse> {
  let scanned = 0
  const perTeam = await mapInOrderWithConcurrency(
    contexts,
    WORK_ITEMS_AGGREGATE_READ_CONCURRENCY,
    async (context) => {
      const buckets = new Map<string, WorkItemSummaryBucket>()
      await forEachTeamPartitionPage(principal, context, false, (issues, rawCount) => {
        scanned += rawCount
        if (scanned > WORK_ITEMS_SUMMARY_SCAN_LIMIT) {
          throw createWorkItemListLimitExceededError(
            `Workspace has more than ${WORK_ITEMS_SUMMARY_SCAN_LIMIT} Work Items to summarize.`,
          )
        }
        for (const issue of issues) {
          addWorkItemToSummaryBucket(buckets, issue, now)
        }
      })
      return [...buckets.values()]
    },
  )
  const buckets = perTeam.flat()
  return {
    generatedAt: now.toISOString(),
    totals: {
      total: sumBuckets(buckets, 'total'),
      open: sumBuckets(buckets, 'open'),
      completed: sumBuckets(buckets, 'completed'),
    },
    buckets,
  }
}

/**
 * Checks whether a Work Item matches a server-side aggregate filter.
 *
 * @param workItem - Access-filtered Work Item.
 * @param filter - Server-side filter.
 * @returns `true` when every filter condition holds.
 */
function matchesWorkItemAggregateFilter(
  workItem: TeamIssueResponseItem,
  filter: WorkItemAggregateFilter,
): boolean {
  if (filter.teamId !== undefined && workItem.teamId !== filter.teamId) return false
  if (filter.projectId !== undefined && workItem.assignedProjectId !== filter.projectId) return false
  if (
    filter.statusCategories !== undefined &&
    filter.statusCategories.length > 0 &&
    !filter.statusCategories.includes(workItem.statusCategory)
  ) {
    return false
  }
  if (filter.openOnly && !isOpenStatusCategory(workItem.statusCategory)) return false
  if (filter.involvedMemberKeys !== undefined) {
    const memberKeys = new Set(filter.involvedMemberKeys.map(normalizeMemberKey).filter(Boolean))
    const involved = memberKeys.has(normalizeMemberKey(workItem.assigneeUserId)) ||
      (workItem.contributorAssignments ?? []).some((assignment) =>
        assignment.memberUserId !== undefined &&
        memberKeys.has(normalizeMemberKey(assignment.memberUserId))
      )
    if (!involved) return false
  }
  return true
}

/**
 * Pages through one Team partition and hands every page's accessible Work Items to a visitor.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Readable Team context.
 * @param includeArchived - Whether archived Work Items are included.
 * @param visit - Receives each page's accessible Work Items and the number of rows read.
 */
async function forEachTeamPartitionPage(
  principal: ProjectPrincipal,
  context: TeamPermissionContext,
  includeArchived: boolean,
  visit: (issues: TeamIssueResponseItem[], rawCount: number) => void,
): Promise<void> {
  let startAfterIssueId: string | undefined
  do {
    const response = await workItemDependencies.teamIssues.getTeamIssues(
      principal.directoryId,
      context.team.id,
      {
        limit: WORK_ITEMS_AGGREGATE_READ_PAGE_SIZE,
        consistentRead: true,
        includeArchived,
        ...(startAfterIssueId ? { startAfterIssueId } : {}),
      },
    )
    visit(filterAccessibleTeamIssues(response.issues, principal, context), response.issues.length)
    if (
      response.nextStartAfterIssueId !== undefined &&
      response.nextStartAfterIssueId === startAfterIssueId
    ) {
      throw new ProjectDataError(
        503,
        'WorkItemListReadStalled',
        `Team "${context.team.id}" Work Item read did not advance.`,
      )
    }
    startAfterIssueId = response.nextStartAfterIssueId
  } while (startAfterIssueId !== undefined)
}

/**
 * Adds one Work Item to its Team/Project summary bucket.
 *
 * @param buckets - Buckets of one Team keyed by Project ID.
 * @param workItem - Access-filtered, non-archived Work Item.
 * @param now - Instant used to decide whether the Work Item is overdue.
 */
function addWorkItemToSummaryBucket(
  buckets: Map<string, WorkItemSummaryBucket>,
  workItem: TeamIssueResponseItem,
  now: Date,
): void {
  const key = workItem.assignedProjectId ?? ''
  let bucket = buckets.get(key)
  if (bucket === undefined) {
    bucket = {
      teamId: workItem.teamId,
      ...(workItem.assignedProjectId ? { projectId: workItem.assignedProjectId } : {}),
      total: 0,
      open: 0,
      completed: 0,
      highPriorityOpen: 0,
      overdueOpen: 0,
      attentionOpen: 0,
      inReview: 0,
      assignees: [],
    }
    buckets.set(key, bucket)
  }
  bucket.total += 1
  if (workItem.statusCategory === 'completed') bucket.completed += 1
  if (workItem.workflowStatusId === 'review') bucket.inReview += 1
  if (isOpenStatusCategory(workItem.statusCategory)) {
    bucket.open += 1
    const highPriority = workItem.priority === 'high'
    const overdue = isWorkItemOverdue(workItem, now)
    if (highPriority) bucket.highPriorityOpen += 1
    if (overdue) bucket.overdueOpen += 1
    if (highPriority || overdue) bucket.attentionOpen += 1
  }
  const assigneeId = workItem.assigneeUserId.trim()
  if (assigneeId && !bucket.assignees.some((assignee) => assignee.id === assigneeId)) {
    bucket.assignees.push({ id: assigneeId, label: assigneeId })
  }
}

/**
 * Decides whether a Work Item's due date is before today in its schedule calendar.
 *
 * @param workItem - Open Work Item.
 * @param now - Reference instant.
 * @returns `true` when the Work Item is overdue; an unreadable schedule counts as not overdue.
 */
function isWorkItemOverdue(workItem: TeamIssueResponseItem, now: Date): boolean {
  try {
    const dueDate = deriveWorkItemScheduleDueDate(workItem.schedule)
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(dueDate)) return false
    return dueDate < workItemScheduleInstantToLocalDate(now, workItem.schedule.calendarPolicy)
  } catch {
    return false
  }
}

/**
 * Sums one count across summary buckets.
 *
 * @param buckets - Summary buckets.
 * @param field - Count to sum.
 * @returns The sum.
 */
function sumBuckets(
  buckets: readonly WorkItemSummaryBucket[],
  field: 'total' | 'open' | 'completed',
): number {
  return buckets.reduce((sum, bucket) => sum + bucket[field], 0)
}

/**
 * Checks whether a status category counts as open work.
 *
 * @param category - Workflow status category.
 * @returns `true` unless the category is completed or canceled.
 */
function isOpenStatusCategory(category: WorkflowStatusCategory): boolean {
  return category !== 'completed' && category !== 'canceled'
}

/**
 * Normalizes a member key for identity comparison.
 *
 * @param value - Stored or principal member key.
 * @returns Trimmed lowercase key.
 */
function normalizeMemberKey(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Compares IDs by UTF-16 code unit order so cursor positions stay stable.
 *
 * @param left - First ID.
 * @param right - Second ID.
 * @returns Negative, zero, or positive like `Array.prototype.sort` expects.
 */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Normalizes a requested page size.
 *
 * @param value - Raw `limit` query value.
 * @returns A page size between 1 and the contract maximum.
 */
function readWorkItemPageLimit(value: string | undefined): number {
  if (value === undefined || value === '') return WORKSPACE_WORK_ITEM_PAGE_DEFAULT_LIMIT
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemPageLimit',
      `Work Item page limit must be between 1 and ${WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT}.`,
    )
  }
  return limit
}

/**
 * Creates a stable fingerprint that binds a cursor to its filter and archive option.
 *
 * @param filter - Server-side filter.
 * @param includeArchived - Whether archived Work Items are included.
 * @returns A short digest.
 */
function createWorkItemPageFilterFingerprint(
  filter: WorkItemAggregateFilter,
  includeArchived: boolean,
): string {
  const canonical = JSON.stringify([
    includeArchived,
    filter.teamId ?? null,
    filter.projectId ?? null,
    [...(filter.statusCategories ?? [])].sort(),
    filter.openOnly === true,
    [...(filter.involvedMemberKeys ?? [])].map(normalizeMemberKey).sort(),
  ])
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 16)
}

/**
 * Encodes a page cursor.
 *
 * @param cursor - Cursor position.
 * @returns Opaque cursor string.
 */
function encodeWorkItemPageCursor(cursor: WorkItemPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/**
 * Decodes and validates a page cursor.
 *
 * @param value - Opaque cursor from the request.
 * @param fingerprint - Fingerprint of the current request's filter.
 * @returns The cursor position, or `undefined` for the first page.
 */
function decodeWorkItemPageCursor(
  value: string | undefined,
  fingerprint: string,
): WorkItemPageCursor | undefined {
  if (value === undefined || value === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw invalidWorkItemPageCursor()
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('v' in parsed) || parsed.v !== 1 ||
    !('f' in parsed) || parsed.f !== fingerprint ||
    !('t' in parsed) || typeof parsed.t !== 'string' || !parsed.t ||
    ('a' in parsed && parsed.a !== undefined && (typeof parsed.a !== 'string' || !parsed.a))
  ) {
    throw invalidWorkItemPageCursor()
  }
  const afterIssueId = 'a' in parsed && typeof parsed.a === 'string' ? parsed.a : undefined
  return {
    v: 1,
    f: fingerprint,
    t: parsed.t,
    ...(afterIssueId ? { a: afterIssueId } : {}),
  }
}

/**
 * Creates the error for a malformed cursor or one issued for another filter.
 *
 * @returns The 400 project data error.
 */
function invalidWorkItemPageCursor(): ProjectDataError {
  return new ProjectDataError(
    400,
    'InvalidWorkItemPageCursor',
    'Work Item page cursor is invalid or was issued for different filters.',
  )
}

/** Workflow status categories accepted by the `statusCategory` query parameter. */
const WORKFLOW_STATUS_CATEGORY_VALUES: readonly WorkflowStatusCategory[] = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
]

/** Parsed `GET /api/work-items` query. */
export type WorkspaceWorkItemListQuery = {
  /** Whether the request asked for a cursor page instead of the legacy complete list. */
  paged: boolean
  /** Page size when paged. */
  limit: number
  /** Cursor of the requested page. */
  cursor?: string
  /** Server-side filter. */
  filter: WorkItemAggregateFilter
}

/**
 * Parses the paging and filter parameters of `GET /api/work-items`.
 *
 * A request is paged when it carries `limit` or `cursor`. Without either, the legacy complete
 * `{ workItems }` contract applies, still narrowed by any filter.
 *
 * @param readQuery - Reads one query value by name.
 * @param readQueries - Reads every value of a repeatable query parameter.
 * @param principal - Caller whose member keys back `involvement=mine`.
 * @returns The parsed query.
 */
export function readWorkspaceWorkItemListQuery(
  readQuery: (name: string) => string | undefined,
  readQueries: (name: string) => string[] | undefined,
  principal: Pick<ProjectPrincipal, 'userKey' | 'actorId'>,
): WorkspaceWorkItemListQuery {
  const rawLimit = readQuery('limit')
  const cursor = readQuery('cursor') || undefined
  const involvement = readQuery('involvement')
  if (involvement !== undefined && involvement !== 'mine') {
    throw invalidWorkItemListQuery('involvement must be "mine".')
  }
  const teamId = readOptionalIdQuery(readQuery('teamId'), 'teamId')
  const projectId = readOptionalIdQuery(readQuery('projectId'), 'projectId')
  const statusCategories = (readQueries('statusCategory') ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  const unknownCategory = statusCategories.find((value) =>
    !WORKFLOW_STATUS_CATEGORY_VALUES.some((category) => category === value)
  )
  if (unknownCategory !== undefined) {
    throw invalidWorkItemListQuery(`statusCategory "${unknownCategory}" is not supported.`)
  }
  const open = readQuery('open')
  if (open !== undefined && open !== 'true' && open !== 'false') {
    throw invalidWorkItemListQuery('open must be "true" or "false".')
  }
  return {
    paged: rawLimit !== undefined || cursor !== undefined,
    limit: readWorkItemPageLimit(rawLimit),
    ...(cursor ? { cursor } : {}),
    filter: {
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(statusCategories.length > 0
        ? {
            statusCategories: WORKFLOW_STATUS_CATEGORY_VALUES.filter((category) =>
              statusCategories.includes(category)
            ),
          }
        : {}),
      ...(open === 'true' ? { openOnly: true } : {}),
      ...(involvement === 'mine'
        ? { involvedMemberKeys: [...new Set([principal.userKey, principal.actorId])] }
        : {}),
    },
  }
}

/**
 * Reads an optional ID query parameter.
 *
 * @param value - Raw query value.
 * @param name - Parameter name used in the error message.
 * @returns The ID, or `undefined` when absent.
 */
function readOptionalIdQuery(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 256) {
    throw invalidWorkItemListQuery(`${name} must be a non-empty ID.`)
  }
  return trimmed
}

/**
 * Creates the error for an invalid list query parameter.
 *
 * @param message - Reason shown to the client.
 * @returns The 400 project data error.
 */
function invalidWorkItemListQuery(message: string): ProjectDataError {
  return new ProjectDataError(400, 'InvalidWorkItemListQuery', message)
}
