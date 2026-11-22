import {
  createWorkItemHierarchyRankBetween,
  DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY,
  WORK_ITEM_HIERARCHY_MAX_ITEMS,
  type AutomationProjectTemplateApplicationPreview,
  type AutomationProjectTemplateDependency,
  type AutomationProjectTemplateMilestone,
  type AutomationProjectTemplatePayload,
  type AutomationProjectTemplatePreviewError,
  type AutomationProjectTemplateWorkItem,
  type AutomationTemplateApplication,
  type AutomationTemplateApplicationTarget,
  type DateRangeWorkItemSchedule,
  type PlanningDateRange,
  type WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'
import type { Context } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import {
  calculateWorkItemScheduleEndDate,
  isTeamIssueNotFoundError,
  WorkItemScheduleError,
  type CreateTeamIssueRequestBody,
} from '../../modules/work-items'
import {
  assertWorkItemChildTypeAllowed,
  createWorkItemConfigurationGuardConditionChecks,
  WorkItemConfigurationError,
} from '../../modules/work-items/work-item-configuration'
import { AutomationError } from '../../modules/automation'
import { PlanningError, type PlanningEntityCreation } from '../../modules/planning'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import { projectWorkItemSearchDocumentBestEffort } from './document-access'
import {
  createPlanningCallerAuthorizationConditionChecks,
  readPlanningWorkItemState,
  requirePlanningWorkItemEndpointPermission,
} from './planning-access'
import { createPlanningEntityAuditTransaction } from './planning-entity-audit'
import {
  requirePlanningActiveOwner,
  requirePlanningEntityPermission,
  requirePlanningScopePermission,
} from './planning-scope-access'
import { createApiMutationContext, type WorkspacePrincipal } from './project-access'
import {
  normalizeTeamIssueInput,
  requireAssignedProjectAcceptsNewWorkItems,
} from './work-item-access'
import {
  getWorkItemConfigurationTableName,
  prepareConfiguredCreateWorkItem,
} from './work-item-configuration'
import { requireActiveWorkspaceAssignee } from './workspace-access'

/** One Project template Work Item placed on real dates, in parent-before-child order. */
export type ExpandedProjectTemplateWorkItem = {
  /** Zero-based position in the depth-first expansion; stable for one template version. */
  index: number
  /** Expansion index of the parent Work Item, or undefined for a top-level item. */
  parentIndex?: number
  /** WBS number in the template outline, such as `1` or `2.3`. */
  wbsNumber: string
  /** Title of the Work Item to create. */
  title: string
  /** Date-range schedule counted in working days from the Project start date. */
  schedule: DateRangeWorkItemSchedule
}

/**
 * Places a Project template's WBS on real dates.
 *
 * A start offset of `n` puts the Work Item on the `(n + 1)`th working day on or after the Project
 * start date, and its end is the last of `durationWorkingDays` working days from there. Working
 * days follow the given calendar, which is the Workspace working calendar when a template is
 * applied, and every Work Item keeps a copy of it.
 *
 * @param workItems - Top-level template Work Items with their children.
 * @param startDate - Project start date in `YYYY-MM-DD` form.
 * @param calendarPolicy - Working calendar that counts the days; defaults to Monday to Friday
 *   without holidays.
 * @returns Every Work Item in depth-first order, parents before their children.
 */
export function expandProjectTemplateWorkItems(
  workItems: readonly AutomationProjectTemplateWorkItem[],
  startDate: string,
  calendarPolicy: WorkItemScheduleCalendarPolicy = DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY,
): ExpandedProjectTemplateWorkItem[] {
  const expanded: ExpandedProjectTemplateWorkItem[] = []
  const visit = (items: readonly AutomationProjectTemplateWorkItem[], parentIndex?: number) => {
    const prefix = parentIndex === undefined ? '' : `${expanded[parentIndex]?.wbsNumber ?? ''}.`
    for (const [position, item] of items.entries()) {
      const itemStartDate = calculateWorkItemScheduleEndDate(
        startDate,
        item.startOffsetWorkingDays + 1,
        calendarPolicy,
      )
      const index = expanded.length
      expanded.push({
        index,
        ...(parentIndex === undefined ? {} : { parentIndex }),
        wbsNumber: `${prefix}${position + 1}`,
        title: item.title,
        schedule: {
          mode: 'date-range',
          calendarPolicy: structuredClone(calendarPolicy),
          startDate: itemStartDate,
          endDate: calculateWorkItemScheduleEndDate(
            itemStartDate,
            item.durationWorkingDays,
            calendarPolicy,
          ),
          durationDays: item.durationWorkingDays,
        },
      })
      if (item.children) visit(item.children, index)
    }
  }
  visit(workItems)
  return expanded
}

/**
 * Reads the Project start date a WBS template application needs.
 *
 * @param startDate - Start date from the application target.
 * @returns The start date.
 * @throws AutomationError when the target has no start date.
 */
export function requireProjectTemplateStartDate(startDate: string | undefined): string {
  if (!startDate) {
    throw new AutomationError(
      'invalid-input',
      'AutomationProjectTemplateStartDateRequired',
      'A Project start date is required to apply a template with Work Items.',
    )
  }
  return startDate
}

/**
 * Checks that every template Work Item can be created in the Team before anything is written.
 *
 * The check uses the Team's current Work Item configuration, so a required custom field, an
 * unusable default type, or a type that cannot be a child of its parent's type fails the
 * application before the Project exists.
 *
 * @param principal - Workspace administrator applying the template.
 * @param teamId - Team that receives the Project.
 * @param workItems - Expanded template Work Items.
 * @param report - Receives each problem with the WBS number it belongs to; throwing stops the check.
 */
export async function preflightProjectTemplateWorkItems(
  principal: WorkspacePrincipal,
  teamId: string,
  workItems: readonly ExpandedProjectTemplateWorkItem[],
  report: ProjectTemplateIssueReporter = throwProjectTemplateIssue,
) {
  const team = await readTemplateTargetTeam(principal.directoryId, teamId)
  const configuration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
    principal.directoryId,
    teamId,
  )
  try {
    await requireActiveWorkspaceAssignee(principal.directoryId, principal.userKey)
  } catch (error) {
    report(error)
  }
  const typeIds: unknown[] = []
  for (const workItem of workItems) {
    try {
      const configured = await prepareConfiguredCreateWorkItem(
        principal.directoryId,
        teamId,
        normalizeTeamIssueInput(createTemplateWorkItemBody(principal, workItem), team),
        configuration,
      )
      typeIds[workItem.index] = configured.workItemTypeId
      const parentTypeId = workItem.parentIndex === undefined ? undefined : typeIds[workItem.parentIndex]
      if (workItem.parentIndex !== undefined && parentTypeId !== undefined) {
        assertWorkItemChildTypeAllowed(configuration.configuration, parentTypeId, configured.workItemTypeId)
      }
    } catch (error) {
      report(error, { wbsNumber: workItem.wbsNumber })
    }
  }
}

/**
 * Creates a template's Work Items in the new Project, links each child to its parent, and stores
 * sibling ranks in outline order.
 *
 * Each Work Item uses an ID derived from the application and its expansion index. A Work Item
 * that already exists under that ID is reused as is, even if someone edited it in the meantime,
 * and parent links and ranks are set declaratively, so a retried application finishes the
 * remaining work instead of creating duplicates or failing on an edited item.
 *
 * @param c - Hono request context used for audit metadata.
 * @param principal - Workspace administrator applying the template.
 * @param application - Running template application that owns the Project.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project created by the application.
 * @param workItems - Expanded template Work Items in parent-before-child order.
 * @returns IDs of the created Work Items in expansion order.
 */
export async function createProjectTemplateWorkItems(
  c: Context,
  principal: WorkspacePrincipal,
  application: AutomationTemplateApplication,
  teamId: string,
  projectId: string,
  workItems: readonly ExpandedProjectTemplateWorkItem[],
): Promise<string[]> {
  const directoryId = principal.directoryId
  const team = await readTemplateTargetTeam(directoryId, teamId)
  const configuration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
    directoryId,
    teamId,
  )
  const createdIds: string[] = []
  for (const workItem of workItems) {
    const idempotencyResourceId = `${application.id}_wbs_${workItem.index}`
    const existing = await readTemplateWorkItem(directoryId, teamId, idempotencyResourceId)
    if (existing) {
      createdIds.push(existing.id)
      continue
    }
    const body = normalizeTeamIssueInput(
      {
        ...createTemplateWorkItemBody(principal, workItem),
        assignedProjectId: projectId,
        idempotencyResourceId,
      },
      team,
    )
    const projectFence = await requireAssignedProjectAcceptsNewWorkItems(directoryId, team, projectId)
    const configuredBody = await prepareConfiguredCreateWorkItem(directoryId, teamId, body, configuration)
    const response = await workItemDependencies.teamIssues.createTeamIssue(
      directoryId,
      teamId,
      { ...configuredBody, ...projectFence },
      principal.userKey,
      createApiMutationContext(
        c,
        principal,
        { teamId, applicationId: application.id, ...configuredBody },
        idempotencyResourceId,
      ),
    )
    createdIds.push(response.issue.id)
    await projectWorkItemSearchDocumentBestEffort(
      directoryId,
      response.issue,
      'template Work Item creation',
      [],
    )
  }

  const ranks = await createTemplateWorkItemRanks(directoryId, teamId, workItems, createdIds)
  const graph = await workItemDependencies.workItemConfigurations.listRelationGraph(directoryId, teamId)
  const storedParentIds = new Map(graph.relations
    .filter((relation) => relation.type === 'parent')
    .map((relation) => [relation.sourceWorkItemId, relation.targetWorkItemId]))
  let graphRevision = graph.graphRevision
  for (const workItem of workItems) {
    const childId = createdIds[workItem.index]
    const parentId = workItem.parentIndex === undefined ? undefined : createdIds[workItem.parentIndex]
    const hierarchyRank = ranks[workItem.index]
    if (!childId || (workItem.parentIndex !== undefined && !parentId)) continue
    // A top-level item without a rank keeps its creation order; there is nothing to link.
    if (!parentId && hierarchyRank === undefined) continue
    // Someone moved this item under another parent after an earlier attempt; keep their change.
    const storedParentId = storedParentIds.get(childId)
    if (storedParentId !== undefined && storedParentId !== parentId) continue
    graphRevision = await placeTemplateWorkItem(
      c,
      principal,
      application,
      teamId,
      childId,
      parentId,
      hierarchyRank,
      graphRevision,
      configuration,
    )
  }
  return createdIds
}

/**
 * Reads a Work Item created by an earlier attempt of the same application.
 *
 * @param directoryId - Workspace directory identifier.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Deterministic template Work Item ID.
 * @returns The Work Item, or undefined when it does not exist yet.
 */
async function readTemplateWorkItem(directoryId: string, teamId: string, workItemId: string) {
  try {
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(directoryId, teamId, workItemId, {
      consistentIssueRead: true,
      includeEvents: false,
    })
    return detail.issue
  } catch (error) {
    if (isTeamIssueNotFoundError(error)) return undefined
    throw error
  }
}

/**
 * Chooses sibling ranks that keep the template's outline order.
 *
 * Children only have template siblings, so their ranks start fresh under each parent. Top-level
 * items share the Team's top level, so they start at the lowest current rank among them and keep
 * their place relative to other Work Items. Creation order alone cannot be trusted because
 * consecutive creates can share a sort order.
 *
 * @param directoryId - Workspace directory identifier.
 * @param teamId - Team that owns the Work Items.
 * @param workItems - Expanded template Work Items.
 * @param createdIds - Work Item IDs in expansion order.
 * @returns Rank per expansion index; top-level ranks are undefined when their current ranks cannot
 *   all be read, for example in a Team larger than the hierarchy read limit.
 */
async function createTemplateWorkItemRanks(
  directoryId: string,
  teamId: string,
  workItems: readonly ExpandedProjectTemplateWorkItem[],
  createdIds: readonly string[],
): Promise<Array<string | undefined>> {
  const readHierarchyEntries = workItemDependencies.teamIssues.getTeamHierarchyEntries
  const entries = readHierarchyEntries
    ? await readHierarchyEntries.call(
        workItemDependencies.teamIssues,
        directoryId,
        teamId,
        WORK_ITEM_HIERARCHY_MAX_ITEMS,
      )
    : []
  const currentRanks = new Map(entries.map((entry) => [entry.issue.id, entry.hierarchyRank]))
  const topLevelRanks = workItems
    .filter((workItem) => workItem.parentIndex === undefined)
    .map((workItem) => currentRanks.get(createdIds[workItem.index] ?? ''))
  const topLevelStart = topLevelRanks.every((rank) => rank !== undefined)
    ? [...topLevelRanks].sort()[0]
    : undefined
  const previousRankByParent = new Map<number, string>()
  return workItems.map((workItem) => {
    const parentKey = workItem.parentIndex ?? -1
    const previous = previousRankByParent.get(parentKey)
    const rank = previous !== undefined
      ? createWorkItemHierarchyRankBetween(previous)
      : workItem.parentIndex === undefined
        ? topLevelStart
        : createWorkItemHierarchyRankBetween()
    if (rank !== undefined) previousRankByParent.set(parentKey, rank)
    return rank
  })
}

/**
 * Sets a template Work Item's parent and sibling rank.
 *
 * Setting the parent is declarative, so a link made by an earlier attempt succeeds again. The
 * Team's relation graph revision moves with every relation change in the Team. A concurrent
 * change is not retried here; it is reported as retryable so the application returns to pending
 * and the client's retry with the same Idempotency-Key resumes.
 *
 * @param c - Hono request context used for audit metadata.
 * @param principal - Workspace administrator applying the template; recorded as the actor.
 * @param application - Running template application, recorded in the audit context.
 * @param teamId - Team that owns both Work Items.
 * @param childId - Work Item to place.
 * @param parentId - Parent Work Item ID, or undefined for a top-level item.
 * @param hierarchyRank - Sibling rank to store, or undefined to keep creation order.
 * @param graphRevision - Team relation graph revision observed by this application.
 * @param configuration - Team configuration that the child type is checked against.
 * @returns The graph revision after the change.
 */
async function placeTemplateWorkItem(
  c: Context,
  principal: WorkspacePrincipal,
  application: AutomationTemplateApplication,
  teamId: string,
  childId: string,
  parentId: string | undefined,
  hierarchyRank: string | undefined,
  graphRevision: number,
  configuration: Awaited<ReturnType<typeof workItemDependencies.workItemConfigurations.getTeamConfiguration>>,
): Promise<number> {
  const directoryId = principal.directoryId
  const [child, parent] = await Promise.all([
    readTemplateWorkItem(directoryId, teamId, childId),
    parentId ? readTemplateWorkItem(directoryId, teamId, parentId) : undefined,
  ])
  if (!child || (parentId && !parent)) {
    throw new AutomationError(
      'unavailable',
      'AutomationTemplateWorkItemUnavailable',
      'A Work Item created from the template could not be read. Retry with the same Idempotency-Key.',
      true,
    )
  }
  if (parent) {
    assertWorkItemChildTypeAllowed(configuration.configuration, parent.workItemTypeId, child.workItemTypeId)
  }
  const toEndpoint = (issue: typeof child) => ({
    workItemId: issue.id,
    expectedRevision: issue.revision,
    ...(issue.assignedProjectId ? { assignedProjectId: issue.assignedProjectId } : {}),
  })
  try {
    const response = await workItemDependencies.workItemConfigurations.replaceParent(
      directoryId,
      teamId,
      {
        child: toEndpoint(child),
        ...(parent ? { nextParent: toEndpoint(parent) } : {}),
        expectedGraphRevision: graphRevision,
        ...(hierarchyRank === undefined ? {} : { hierarchyRank }),
      },
      createWorkItemConfigurationGuardConditionChecks(
        getWorkItemConfigurationTableName(),
        directoryId,
        teamId,
        configuration,
      ),
      {
        context: createApiMutationContext(c, principal, {
          teamId,
          applicationId: application.id,
          issueId: childId,
          parentWorkItemId: parentId ?? null,
          ...(hierarchyRank === undefined ? {} : { hierarchyRank }),
        },
        // Audit event IDs come from the idempotency key, so each placement needs its own. The
        // revisions change with every committed placement, so a later write never reuses a key.
        `${childId}_place_${graphRevision}_${child.revision}`),
        actorMemberKey: principal.userKey,
      },
    )
    return response.graphRevision
  } catch (error) {
    if (error instanceof WorkItemConfigurationError && error.code === 'WorkItemRelationGraphConflict') {
      throw new AutomationError(
        'conflict',
        'AutomationTemplateWorkItemLinkConflict',
        'Work Item relations in the Team changed while the template was applied. Retry with the same Idempotency-Key.',
        true,
      )
    }
    throw error
  }
}

/**
 * Builds the create body shared by preflight and creation.
 *
 * @param principal - Workspace administrator who becomes the accountable owner.
 * @param workItem - Expanded template Work Item.
 * @returns Create body without a Project assignment.
 */
function createTemplateWorkItemBody(
  principal: WorkspacePrincipal,
  workItem: ExpandedProjectTemplateWorkItem,
): CreateTeamIssueRequestBody {
  return {
    title: workItem.title,
    assigneeUserId: principal.userKey,
    priority: 'medium',
    schedule: structuredClone(workItem.schedule),
  }
}

/**
 * Finds the Project that an earlier attempt of a WBS application already created.
 *
 * The Project ID is the application ID, which only template application can assign, so an
 * existing Project with that ID is this application's, even if someone renamed or recolored it
 * before the retry. Comparing its mutable display fields would block the remaining WBS.
 *
 * @param directoryId - Workspace directory identifier.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID derived from the application.
 * @returns The Project, or undefined when the application has not created it yet.
 */
export async function findProjectTemplateProject(directoryId: string, teamId: string, projectId: string) {
  const team = await readTemplateTargetTeam(directoryId, teamId)
  return team.projects.find((project) => project.id === projectId)
}

/**
 * Reads the active Team a Project template is applied to.
 *
 * @param directoryId - Workspace directory identifier.
 * @param teamId - Target Team identifier.
 * @returns The Team directory entry, read consistently so a just-created Project is listed.
 */
async function readTemplateTargetTeam(directoryId: string, teamId: string) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(directoryId, 'ja', true)
  const team = directory.teams.find((candidate) => candidate.id === teamId)
  if (!team) {
    throw new AutomationError(
      'conflict',
      'AutomationTeamUnavailable',
      'The selected Team is unavailable.',
    )
  }
  return team
}

/** Where a Project template problem was found, for the dry-run preview. */
export type ProjectTemplateIssueContext = {
  /** WBS number of the Work Item the problem belongs to. */
  wbsNumber?: string
  /** Position of the template dependency the problem belongs to, counted from 1. */
  dependencyNumber?: number
}

/**
 * Receives one problem found while checking a Project template application.
 *
 * Applying throws the first problem; the dry-run preview collects them all.
 */
export type ProjectTemplateIssueReporter = (error: unknown, context?: ProjectTemplateIssueContext) => void

/**
 * Stops a template application at its first problem.
 *
 * @param error - Problem found by a check.
 */
function throwProjectTemplateIssue(error: unknown): never {
  throw error
}

/** One Planning Phase or Milestone of a Project template placed on real dates. */
export type ExpandedProjectTemplatePlanningEntity = {
  /** Zero-based position in creation order; stable for one template version. */
  index: number
  /** Planning entity type. */
  type: 'phase' | 'milestone'
  /** Title of the entity. */
  title: string
  /** Expansion index of the Phase that holds a Milestone; undefined under the Planning parent. */
  parentIndex?: number
  /** Inclusive date range; a Milestone starts and ends on the same day. */
  range: PlanningDateRange
}

/**
 * Places a Project template's Phases and Milestones on real dates.
 *
 * Offsets count working days of the given calendar from the Project start date, like the WBS.
 * Each Phase comes before its Milestones, and Milestones outside any Phase come last.
 *
 * @param payload - Phases and top-level Milestones of the template.
 * @param startDate - Project start date in `YYYY-MM-DD` form.
 * @param calendarPolicy - Working calendar that counts the days.
 * @returns Every Phase and Milestone in creation order.
 */
export function expandProjectTemplatePlanningEntities(
  payload: Pick<AutomationProjectTemplatePayload, 'phases' | 'milestones'>,
  startDate: string,
  calendarPolicy: WorkItemScheduleCalendarPolicy = DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY,
): ExpandedProjectTemplatePlanningEntity[] {
  const expanded: ExpandedProjectTemplatePlanningEntity[] = []
  const workingDay = (offset: number) => calculateWorkItemScheduleEndDate(startDate, offset + 1, calendarPolicy)
  const addMilestones = (
    milestones: readonly AutomationProjectTemplateMilestone[] | undefined,
    parentIndex?: number,
  ) => {
    for (const milestone of milestones ?? []) {
      const date = workingDay(milestone.offsetWorkingDays)
      expanded.push({
        index: expanded.length,
        type: 'milestone',
        title: milestone.title,
        ...(parentIndex === undefined ? {} : { parentIndex }),
        range: { startDate: date, endDate: date },
      })
    }
  }
  for (const phase of payload.phases ?? []) {
    const phaseStart = workingDay(phase.startOffsetWorkingDays)
    const index = expanded.length
    expanded.push({
      index,
      type: 'phase',
      title: phase.title,
      range: {
        startDate: phaseStart,
        endDate: calculateWorkItemScheduleEndDate(phaseStart, phase.durationWorkingDays, calendarPolicy),
      },
    })
    addMilestones(phase.milestones, index)
  }
  addMilestones(payload.milestones)
  return expanded
}

/** One template dependency that the expanded WBS dates do not satisfy. */
export type ProjectTemplateDependencyConflict = {
  /** Position of the template dependency, counted from 1. */
  dependencyNumber: number
  /** Earliest date the successor boundary may fall on. */
  requiredDate: string
  /** Date the successor boundary falls on. */
  actualDate: string
}

/**
 * Finds template dependencies that the expanded WBS dates break.
 *
 * The rule matches the Planning check for a new Work Item dependency: the successor boundary must
 * fall on or after the predecessor boundary shifted by the lag in calendar days, plus one day for
 * finish-to-start.
 *
 * @param dependencies - Template dependencies.
 * @param workItems - Expanded template Work Items.
 * @returns One conflict per broken dependency, in template order.
 */
export function findProjectTemplateDependencyConflicts(
  dependencies: readonly AutomationProjectTemplateDependency[],
  workItems: readonly ExpandedProjectTemplateWorkItem[],
): ProjectTemplateDependencyConflict[] {
  const byWbsNumber = new Map(workItems.map((workItem) => [workItem.wbsNumber, workItem]))
  const conflicts: ProjectTemplateDependencyConflict[] = []
  dependencies.forEach((dependency, index) => {
    const predecessor = byWbsNumber.get(dependency.predecessor)
    const successor = byWbsNumber.get(dependency.successor)
    if (!predecessor || !successor) return
    const predecessorDate = dependency.type === 'finish-to-start' || dependency.type === 'finish-to-finish'
      ? predecessor.schedule.endDate
      : predecessor.schedule.startDate
    const actualDate = dependency.type === 'finish-to-start' || dependency.type === 'start-to-start'
      ? successor.schedule.startDate
      : successor.schedule.endDate
    const requiredDate = shiftCalendarDate(
      predecessorDate,
      dependency.lagDays + (dependency.type === 'finish-to-start' ? 1 : 0),
    )
    if (actualDate < requiredDate) {
      conflicts.push({ dependencyNumber: index + 1, requiredDate, actualDate })
    }
  })
  return conflicts
}

/**
 * Moves a calendar date by whole days.
 *
 * @param date - Date in `YYYY-MM-DD` form.
 * @param days - Signed number of days.
 * @returns The shifted date.
 */
function shiftCalendarDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

/**
 * Creates the error that stops an application whose WBS dates break a template dependency.
 *
 * @param conflict - Broken dependency.
 * @returns A terminal invalid-input error.
 */
function createProjectTemplateDependencyConflictError(conflict: ProjectTemplateDependencyConflict) {
  return new AutomationError(
    'invalid-input',
    'AutomationProjectTemplateDependencyConflict',
    `Dependency ${conflict.dependencyNumber} needs its successor on or after ${conflict.requiredDate}, ` +
      `but the template places it on ${conflict.actualDate}.`,
  )
}

/** Planning entity types a template's Phases and top-level Milestones can be placed under. */
const PROJECT_TEMPLATE_PLANNING_PARENT_TYPES: ReadonlySet<string> = new Set(['roadmap', 'initiative', 'goal'])

/**
 * Checks everything a Project template application needs beyond its Work Items: the start date,
 * the Planning parent of its Phases and Milestones, and the dates its dependencies need.
 *
 * The Planning parent is checked with the same scope permission as creating a child entity
 * through the Planning API, and it must accept the new Project's Phases: an active roadmap,
 * initiative, or goal outside any Project, and in no Team other than the target.
 *
 * @param principal - Workspace administrator applying the template.
 * @param target - Project application target.
 * @param payload - Template payload.
 * @param workItems - Expanded template Work Items.
 * @param planningEntities - Expanded template Phases and Milestones.
 * @param report - Receives each problem; throwing stops the check.
 */
export async function preflightProjectTemplatePlanning(
  principal: WorkspacePrincipal,
  target: Extract<AutomationTemplateApplicationTarget, { kind: 'project' }>,
  payload: AutomationProjectTemplatePayload,
  workItems: readonly ExpandedProjectTemplateWorkItem[],
  planningEntities: readonly ExpandedProjectTemplatePlanningEntity[],
  report: ProjectTemplateIssueReporter = throwProjectTemplateIssue,
) {
  for (const conflict of findProjectTemplateDependencyConflicts(payload.dependencies ?? [], workItems)) {
    report(createProjectTemplateDependencyConflictError(conflict), { dependencyNumber: conflict.dependencyNumber })
  }
  if (planningEntities.length === 0) return
  if (!target.planningParentId) {
    report(new AutomationError(
      'invalid-input',
      'AutomationProjectTemplatePlanningParentRequired',
      'Choose a Planning roadmap, initiative, or goal to hold the template Phases and Milestones.',
    ))
    return
  }
  try {
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, { workItems: [] })
    const parent = await requirePlanningEntityPermission(
      principal,
      snapshot.entities,
      target.planningParentId,
      'member',
    )
    if (
      parent.archivedAt !== undefined ||
      !PROJECT_TEMPLATE_PLANNING_PARENT_TYPES.has(parent.type) ||
      parent.projectId !== undefined ||
      (parent.teamId !== undefined && parent.teamId !== target.teamId)
    ) {
      throw new AutomationError(
        'invalid-input',
        'AutomationProjectTemplatePlanningParentInvalid',
        'The Planning parent must be an active roadmap, initiative, or goal outside any Project and in no other Team.',
      )
    }
  } catch (error) {
    report(toProjectTemplatePlanningError(error))
  }
}

/**
 * Creates a template's Phases and Milestones in Planning for the new Project.
 *
 * Each entity uses an ID derived from the application and its creation index. An entity that
 * already exists under that ID, even archived, is left as it is, so a retried application creates
 * only the missing ones.
 *
 * @param c - Hono request context used for audit metadata.
 * @param principal - Workspace administrator applying the template; becomes the owner.
 * @param application - Running template application.
 * @param target - Project application target with the Planning parent.
 * @param projectId - Project created by the application.
 * @param planningEntities - Expanded template Phases and Milestones.
 */
export async function createProjectTemplatePlanningEntities(
  c: Context,
  principal: WorkspacePrincipal,
  application: AutomationTemplateApplication,
  target: Extract<AutomationTemplateApplicationTarget, { kind: 'project' }>,
  projectId: string,
  planningEntities: readonly ExpandedProjectTemplatePlanningEntity[],
) {
  if (planningEntities.length === 0) return
  const directoryId = principal.directoryId
  const parentId = target.planningParentId
  if (!parentId) {
    throw new AutomationError(
      'invalid-input',
      'AutomationProjectTemplatePlanningParentRequired',
      'Choose a Planning roadmap, initiative, or goal to hold the template Phases and Milestones.',
    )
  }
  const scope = { teamId: target.teamId, projectId }
  try {
    await requirePlanningScopePermission(principal, scope, 'member')
    await requirePlanningActiveOwner(principal, principal.userKey)
    const workItemState = await readPlanningWorkItemState(principal, scope)
    let snapshot = await workItemDependencies.planning.get(directoryId, workItemState)
    // Entities an earlier attempt created that someone archived since; their Milestones are left out.
    const archivedIndexes = new Set<number>()
    for (const entity of planningEntities) {
      const id = createProjectTemplatePlanningEntityId(application, entity.index)
      if (snapshot.entities.some((candidate) => candidate.id === id)) continue
      if (entity.parentIndex !== undefined && archivedIndexes.has(entity.parentIndex)) {
        archivedIndexes.add(entity.index)
        continue
      }
      const creation: PlanningEntityCreation = {
        id,
        type: entity.type,
        title: entity.title,
        parentId: entity.parentIndex === undefined
          ? parentId
          : createProjectTemplatePlanningEntityId(application, entity.parentIndex),
        ...scope,
        ownerMemberKey: principal.userKey,
        status: 'planned',
        health: 'unknown',
        risk: 'none',
        progressMode: 'automatic',
        baseline: structuredClone(entity.range),
        forecast: structuredClone(entity.range),
        expectedRevision: snapshot.revision,
      }
      try {
        const response = await workItemDependencies.planning.create(
          directoryId,
          creation,
          workItemState,
          createPlanningEntityAuditTransaction(
            directoryId,
            createApiMutationContext(c, principal, { applicationId: application.id, ...creation }, `${id}_create`),
            principal.userKey,
          ),
        )
        snapshot = response.planning
      } catch (error) {
        // The live graph leaves out archived entities, but the ID stays taken; keep the archive.
        if (!(error instanceof PlanningError) || error.code !== 'PlanningEntityExists') throw error
        archivedIndexes.add(entity.index)
      }
    }
  } catch (error) {
    throw toProjectTemplatePlanningError(error)
  }
}

/**
 * Creates the schedule dependencies between a template's Work Items.
 *
 * Both ends are checked with the same manager permission as the Planning dependency API. Each
 * dependency uses an ID derived from the application and its position, and one that already
 * exists is left as it is, so a retried application creates only the missing ones.
 *
 * @param principal - Workspace administrator applying the template.
 * @param application - Running template application.
 * @param teamId - Team that owns the Work Items.
 * @param projectId - Project that holds the Work Items.
 * @param dependencies - Template dependencies.
 * @param workItems - Expanded template Work Items.
 * @param workItemIds - Created Work Item IDs in expansion order.
 */
export async function createProjectTemplateDependencies(
  principal: WorkspacePrincipal,
  application: AutomationTemplateApplication,
  teamId: string,
  projectId: string,
  dependencies: readonly AutomationProjectTemplateDependency[],
  workItems: readonly ExpandedProjectTemplateWorkItem[],
  workItemIds: readonly string[],
) {
  if (dependencies.length === 0) return
  const directoryId = principal.directoryId
  const idByWbsNumber = new Map(workItems.map((workItem) => [workItem.wbsNumber, workItemIds[workItem.index]]))
  try {
    // Creating the Project advanced the applier's Workspace member version, so guard the writes
    // with the member as it is now rather than as it was when the request was authenticated.
    const currentMember = await requirePlanningActiveOwner(principal, principal.userKey)
    const authorizationConditionChecks = createPlanningCallerAuthorizationConditionChecks(
      principal,
      [currentMember],
      false,
    )
    const workItemState = await readPlanningWorkItemState(principal, { teamId, projectId })
    let snapshot = await workItemDependencies.planning.get(directoryId, workItemState)
    for (const [position, dependency] of dependencies.entries()) {
      const id = `${application.id}_dep_${position}`
      if (snapshot.workItemDependencies.some((candidate) => candidate.id === id)) continue
      const predecessorId = idByWbsNumber.get(dependency.predecessor)
      const successorId = idByWbsNumber.get(dependency.successor)
      if (
        !predecessorId ||
        !successorId ||
        !workItemState.workItems.some((workItem) => workItem.teamId === teamId && workItem.id === predecessorId) ||
        !workItemState.workItems.some((workItem) => workItem.teamId === teamId && workItem.id === successorId)
      ) {
        throw new AutomationError(
          'unavailable',
          'AutomationTemplateWorkItemUnavailable',
          'A Work Item created from the template could not be read. Retry with the same Idempotency-Key.',
          true,
        )
      }
      const predecessor = { teamId, workItemId: predecessorId }
      const successor = { teamId, workItemId: successorId }
      await Promise.all([
        requirePlanningWorkItemEndpointPermission(principal, predecessor, 'manager'),
        requirePlanningWorkItemEndpointPermission(principal, successor, 'manager'),
      ])
      const response = await workItemDependencies.planning.createWorkItemDependency(
        directoryId,
        {
          id,
          predecessor,
          successor,
          type: dependency.type,
          lagDays: dependency.lagDays,
          expectedRevision: snapshot.revision,
        },
        workItemState,
        authorizationConditionChecks,
      )
      snapshot = response.planning
    }
  } catch (error) {
    throw toProjectTemplatePlanningError(error)
  }
}

/**
 * Derives the ID of a Planning entity created by a template application.
 *
 * @param application - Template application.
 * @param index - Creation index of the entity.
 * @returns Deterministic Planning entity ID.
 */
function createProjectTemplatePlanningEntityId(application: AutomationTemplateApplication, index: number) {
  return `${application.id}_plan_${index}`
}

/**
 * Converts a Planning failure into the Automation error contract.
 *
 * A concurrent Planning change is retryable with the same Idempotency-Key; other client errors
 * keep their code and stop the application, and server errors stay retryable.
 *
 * @param error - Failure raised while checking or writing Planning.
 * @returns The error to throw.
 */
function toProjectTemplatePlanningError(error: unknown): unknown {
  if (!(error instanceof PlanningError)) return error
  if (
    error.code === 'PlanningRevisionConflict' ||
    error.code === 'PlanningWorkItemChanged' ||
    error.code === 'PlanningAuthorizationChanged'
  ) {
    return new AutomationError(
      'conflict',
      'AutomationTemplatePlanningConflict',
      'Planning changed while the template was applied. Retry with the same Idempotency-Key.',
      true,
    )
  }
  if (error.status >= 500) return new AutomationError('unavailable', error.code, error.message, true)
  const category = error.status === 403
    ? 'forbidden'
    : error.status === 404
      ? 'not-found'
      : error.status === 409
        ? 'conflict'
        : error.status === 413
          ? 'payload-too-large'
          : 'invalid-input'
  return new AutomationError(category, error.code, error.message)
}

/**
 * Computes what applying a Project template would create, and every problem that would stop it,
 * without writing anything.
 *
 * It runs the same checks as applying: the start date, the Team's Work Item configuration for each
 * WBS item, the dependency dates, and the Planning parent. A failure that is not about the
 * template or target, such as an unavailable store, is thrown instead of listed.
 *
 * @param principal - Workspace administrator previewing the application.
 * @param template - Project template, at its current version.
 * @param target - Project application target.
 * @param name - Name the Project would get.
 * @param calendarPolicy - Workspace working calendar that counts the days.
 * @returns The preview.
 */
export async function previewProjectTemplateApplication(
  principal: WorkspacePrincipal,
  template: { version: number, payload: AutomationProjectTemplatePayload },
  target: Extract<AutomationTemplateApplicationTarget, { kind: 'project' }>,
  name: string,
  calendarPolicy: WorkItemScheduleCalendarPolicy,
): Promise<AutomationProjectTemplateApplicationPreview> {
  const payload = template.payload
  const errors: AutomationProjectTemplatePreviewError[] = []
  const report: ProjectTemplateIssueReporter = (error, context) => {
    errors.push({ ...readProjectTemplatePreviewError(error), ...context })
  }
  const needsStartDate = (payload.workItems?.length ?? 0) > 0 ||
    (payload.phases?.length ?? 0) > 0 ||
    (payload.milestones?.length ?? 0) > 0
  let workItems: ExpandedProjectTemplateWorkItem[] = []
  let planningEntities: ExpandedProjectTemplatePlanningEntity[] = []
  if (needsStartDate) {
    try {
      const startDate = requireProjectTemplateStartDate(target.startDate)
      workItems = expandProjectTemplateWorkItems(payload.workItems ?? [], startDate, calendarPolicy)
      planningEntities = expandProjectTemplatePlanningEntities(payload, startDate, calendarPolicy)
    } catch (error) {
      report(error)
    }
  }
  try {
    if (workItems.length > 0) await preflightProjectTemplateWorkItems(principal, target.teamId, workItems, report)
    else await readTemplateTargetTeam(principal.directoryId, target.teamId)
  } catch (error) {
    report(error)
  }
  await preflightProjectTemplatePlanning(principal, target, payload, workItems, planningEntities, report)
  const dates = [
    ...workItems.map((workItem) => workItem.schedule.endDate),
    ...planningEntities.map((entity) => entity.range.endDate),
  ].sort()
  const endDate = dates.at(-1)
  return {
    kind: 'project',
    teamId: target.teamId,
    name,
    templateVersion: template.version,
    ...(needsStartDate && target.startDate ? { startDate: target.startDate } : {}),
    ...(endDate === undefined ? {} : { endDate }),
    workItems: workItems.map((workItem) => ({
      wbsNumber: workItem.wbsNumber,
      title: workItem.title,
      startDate: workItem.schedule.startDate,
      endDate: workItem.schedule.endDate,
    })),
    planningEntities: planningEntities.map((entity) => {
      const phaseTitle = entity.parentIndex === undefined ? undefined : planningEntities[entity.parentIndex]?.title
      return {
        type: entity.type,
        title: entity.title,
        ...(phaseTitle === undefined ? {} : { phaseTitle }),
        startDate: entity.range.startDate,
        endDate: entity.range.endDate,
      }
    }),
    dependencyCount: payload.dependencies?.length ?? 0,
    errors,
  }
}

/**
 * Turns a problem found by a check into a preview error.
 *
 * @param error - Problem raised by a check.
 * @returns Its stable code and safe message.
 * @throws The error itself when it is not about the template or target, such as a server failure.
 */
function readProjectTemplatePreviewError(error: unknown): Pick<AutomationProjectTemplatePreviewError, 'code' | 'message'> {
  const converted = toProjectTemplatePlanningError(error)
  if (converted instanceof AutomationError && converted.category !== 'unavailable') {
    return { code: converted.code, message: converted.message }
  }
  if (
    (
      converted instanceof WorkItemConfigurationError ||
      converted instanceof ProjectDataError ||
      converted instanceof WorkspaceAccessError ||
      converted instanceof WorkItemScheduleError
    ) &&
    converted.status < 500
  ) {
    return { code: converted.code, message: converted.message }
  }
  throw converted
}
