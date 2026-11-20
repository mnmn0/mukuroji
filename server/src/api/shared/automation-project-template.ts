import {
  createWorkItemHierarchyRankBetween,
  DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY,
  WORK_ITEM_HIERARCHY_MAX_ITEMS,
  type AutomationProjectTemplateWorkItem,
  type AutomationTemplateApplication,
  type DateRangeWorkItemSchedule,
  type WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'
import type { Context } from 'hono'
import {
  calculateWorkItemScheduleEndDate,
  isTeamIssueNotFoundError,
  type CreateTeamIssueRequestBody,
} from '../../modules/work-items'
import {
  assertWorkItemChildTypeAllowed,
  createWorkItemConfigurationGuardConditionChecks,
  WorkItemConfigurationError,
} from '../../modules/work-items/work-item-configuration'
import { AutomationError } from '../../modules/automation'
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import { projectWorkItemSearchDocumentBestEffort } from './document-access'
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
    for (const item of items) {
      const itemStartDate = calculateWorkItemScheduleEndDate(
        startDate,
        item.startOffsetWorkingDays + 1,
        calendarPolicy,
      )
      const index = expanded.length
      expanded.push({
        index,
        ...(parentIndex === undefined ? {} : { parentIndex }),
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
 */
export async function preflightProjectTemplateWorkItems(
  principal: WorkspacePrincipal,
  teamId: string,
  workItems: readonly ExpandedProjectTemplateWorkItem[],
) {
  const team = await readTemplateTargetTeam(principal.directoryId, teamId)
  const configuration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
    principal.directoryId,
    teamId,
  )
  await requireActiveWorkspaceAssignee(principal.directoryId, principal.userKey)
  const typeIds: unknown[] = []
  for (const workItem of workItems) {
    const configured = await prepareConfiguredCreateWorkItem(
      principal.directoryId,
      teamId,
      normalizeTeamIssueInput(createTemplateWorkItemBody(principal, workItem), team),
      configuration,
    )
    typeIds.push(configured.workItemTypeId)
    if (workItem.parentIndex !== undefined) {
      assertWorkItemChildTypeAllowed(
        configuration.configuration,
        typeIds[workItem.parentIndex],
        configured.workItemTypeId,
      )
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
