import {
  DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY,
  type AutomationProjectTemplateWorkItem,
  type AutomationTemplateApplication,
  type DateRangeWorkItemSchedule,
  type WorkItemRelation,
} from '@mukuroji/contracts'
import type { Context } from 'hono'
import {
  calculateWorkItemScheduleEndDate,
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
 * days follow the default Work Item calendar (Monday to Friday, no holidays).
 *
 * @param workItems - Top-level template Work Items with their children.
 * @param startDate - Project start date in `YYYY-MM-DD` form.
 * @returns Every Work Item in depth-first order, parents before their children.
 */
export function expandProjectTemplateWorkItems(
  workItems: readonly AutomationProjectTemplateWorkItem[],
  startDate: string,
): ExpandedProjectTemplateWorkItem[] {
  const calendarPolicy = {
    timeZone: DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY.timeZone,
    workingWeekdays: [...DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY.workingWeekdays],
    holidays: [],
  }
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
 * Creates a template's Work Items in the new Project and links each child to its parent.
 *
 * Each Work Item uses an ID derived from the application and its expansion index, and a child
 * that already has a parent is not linked again, so a retried application finishes the remaining
 * work instead of creating duplicates.
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

  const graph = await workItemDependencies.workItemConfigurations.listRelationGraph(directoryId, teamId)
  const linkedChildIds = new Set(graph.relations
    .filter((relation: WorkItemRelation) => relation.type === 'parent')
    .map((relation) => relation.sourceWorkItemId))
  let graphRevision = graph.graphRevision
  for (const workItem of workItems) {
    if (workItem.parentIndex === undefined) continue
    const childId = createdIds[workItem.index]
    const parentId = createdIds[workItem.parentIndex]
    if (!childId || !parentId || linkedChildIds.has(childId)) continue
    graphRevision = await linkTemplateWorkItemToParent(
      directoryId,
      teamId,
      childId,
      parentId,
      graphRevision,
      configuration,
    )
    linkedChildIds.add(childId)
  }
  return createdIds
}

/**
 * Links a template child Work Item to its parent.
 *
 * The Team's relation graph revision moves with every relation change in the Team. A concurrent
 * change is not retried here; it is reported as retryable so the application returns to pending
 * and the client's retry with the same Idempotency-Key resumes from the remaining links.
 *
 * @param directoryId - Workspace directory identifier.
 * @param teamId - Team that owns both Work Items.
 * @param childId - Child Work Item ID.
 * @param parentId - Parent Work Item ID.
 * @param graphRevision - Team relation graph revision observed by this application.
 * @param configuration - Team configuration that the child type is checked against.
 * @returns The graph revision after the link.
 */
async function linkTemplateWorkItemToParent(
  directoryId: string,
  teamId: string,
  childId: string,
  parentId: string,
  graphRevision: number,
  configuration: Awaited<ReturnType<typeof workItemDependencies.workItemConfigurations.getTeamConfiguration>>,
): Promise<number> {
  const [child, parent] = await Promise.all([childId, parentId].map((workItemId) =>
    workItemDependencies.teamIssues.getTeamIssueDetail(directoryId, teamId, workItemId, {
      consistentIssueRead: true,
      includeEvents: false,
    })
  ))
  if (!child || !parent) {
    throw new AutomationError(
      'unavailable',
      'AutomationTemplateWorkItemUnavailable',
      'A Work Item created from the template could not be read. Retry with the same Idempotency-Key.',
      true,
    )
  }
  assertWorkItemChildTypeAllowed(
    configuration.configuration,
    parent.issue.workItemTypeId,
    child.issue.workItemTypeId,
  )
  try {
    const response = await workItemDependencies.workItemConfigurations.createRelation(
      directoryId,
      teamId,
      {
        sourceWorkItemId: childId,
        targetWorkItemId: parentId,
        type: 'parent',
        expectedGraphRevision: graphRevision,
        sourceExpectedRevision: child.issue.revision,
        targetExpectedRevision: parent.issue.revision,
        sourceAssignedProjectId: child.issue.assignedProjectId,
        targetAssignedProjectId: parent.issue.assignedProjectId,
      },
      createWorkItemConfigurationGuardConditionChecks(
        getWorkItemConfigurationTableName(),
        directoryId,
        teamId,
        configuration,
      ),
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
