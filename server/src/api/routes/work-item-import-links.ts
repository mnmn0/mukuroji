import { createHash } from 'node:crypto'
import type {
  PlanningWorkItemSummary,
  ResolvedWorkItemConfiguration,
  WorkItemRelationType,
  WorkItemSchedule,
} from '@mukuroji/contracts'
import {
  findWorkItemDependencyScheduleConflicts,
} from '../../modules/planning'
import {
  assertWorkItemChildTypeAllowed,
  createWorkItemConfigurationGuardConditionChecks,
} from '../../modules/work-items/work-item-configuration'
import type { WorkItemImportLink } from '../../modules/work-items/work-item-import-structure'
import type { MutationAuditContext } from '../../modules/audit/audit'
import { workItemDependencies } from '../shared/app-dependencies'
import { projectWorkItemSearchDocumentBestEffort } from '../shared/document-access'
import { prepareConfiguredUpdateWorkItem } from '../shared/file-approval-access'
import {
  createPlanningCallerAuthorizationConditionChecks,
  readPlanningWorkItemState,
  requirePlanningWorkItemEndpointPermission,
} from '../shared/planning-access'
import {
  requireAssignedProjectPermission,
  requireTeamPermission,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { readAcceptanceCriteriaChange } from '../shared/work-item-acceptance-criteria'
import { getWorkItemConfigurationTableName } from '../shared/work-item-configuration'

/** One imported row as the dry run resolved it, used to check the links that name it. */
export type WorkItemImportLinkRow = {
  /** One-based data row number. */
  row: number
  /** Work Item Type the row is created with. */
  workItemTypeId: string
  /** Project the row is assigned to, if any. */
  assignedProjectId?: string
  /** Schedule the row is created with. */
  schedule: WorkItemSchedule
}

/** Link error found by a dry run. */
export type WorkItemImportLinkError = {
  /** Row the error is reported on. */
  row: number
  /** Target field of the link. */
  field: string
  /** Stable error code. */
  code: string
  /** Explanation. */
  message: string
}

/** Input for applying one link after every row of an import exists. */
export type ApplyWorkItemImportLinkRequest = {
  /** Principal the import runs as. */
  principal: WorkspacePrincipal
  /** Team that owns every imported Work Item. */
  teamId: string
  /** Link to apply. */
  link: WorkItemImportLink
  /** Work Item ID created for each row. */
  workItemIdForRow: (row: number) => string
  /** Identity of the link that stays the same across retries. */
  linkIdentity: string
  /** Audit context recorded with the change. */
  audit: MutationAuditContext
}

/**
 * Checks the links of a dry run against Team configuration, access, and the imported schedules.
 *
 * A parent link must be allowed by the Work Item Types, a schedule dependency needs manager access
 * and the imported dates must already satisfy it, as creating it later requires.
 *
 * @param principal - Principal running the import.
 * @param teamId - Team that owns the imported Work Items.
 * @param configuration - Team Work Item configuration.
 * @param links - Links resolved from the source.
 * @param rows - Valid rows by row number.
 * @returns Errors to report on the rows.
 */
export async function validateWorkItemImportLinks(
  principal: WorkspacePrincipal,
  teamId: string,
  configuration: ResolvedWorkItemConfiguration,
  links: readonly WorkItemImportLink[],
  rows: ReadonlyMap<number, WorkItemImportLinkRow>,
): Promise<WorkItemImportLinkError[]> {
  const errors: WorkItemImportLinkError[] = []
  let managerAccess: Awaited<ReturnType<typeof requireTeamPermission>> | Error | undefined
  for (const link of links) {
    if (link.kind === 'parent') {
      const child = rows.get(link.childRow)
      const parent = rows.get(link.parentRow)
      if (!child || !parent) continue
      try {
        assertWorkItemChildTypeAllowed(configuration.configuration, parent.workItemTypeId, child.workItemTypeId)
      } catch (error) {
        errors.push({
          row: link.childRow,
          field: 'parentKey',
          code: readErrorCode(error, 'WorkItemChildTypeDenied'),
          message: error instanceof Error ? error.message : 'The parent Work Item Type does not allow this child.',
        })
      }
      continue
    }
    if (link.kind !== 'dependency') continue
    const predecessor = rows.get(link.predecessorRow)
    const successor = rows.get(link.successorRow)
    if (!predecessor || !successor) continue
    if (managerAccess === undefined) {
      try {
        managerAccess = await requireTeamPermission(principal, teamId, 'manager')
      } catch (error) {
        if (!(error instanceof Error) || readStatus(error) >= 500) throw error
        managerAccess = error
      }
    }
    const access = managerAccess
    let accessError: Error | undefined = access instanceof Error ? access : undefined
    if (!accessError && !(access instanceof Error)) {
      try {
        requireAssignedProjectPermission(principal, access, predecessor.assignedProjectId, 'manager')
        requireAssignedProjectPermission(principal, access, successor.assignedProjectId, 'manager')
      } catch (error) {
        if (!(error instanceof Error) || readStatus(error) >= 500) throw error
        accessError = error
      }
    }
    if (accessError) {
      errors.push({
        row: link.successorRow,
        field: 'dependencies',
        code: readErrorCode(accessError, 'ImportDependencyAccessDenied'),
        message: 'Schedule dependencies need manager access to both Work Items.',
      })
      continue
    }
    const conflicts = findWorkItemDependencyScheduleConflicts(
      {
        id: 'import-dry-run',
        predecessor: { teamId, workItemId: `row-${link.predecessorRow}` },
        successor: { teamId, workItemId: `row-${link.successorRow}` },
        type: link.type,
        lagDays: link.lagDays,
        createdAt: '',
        updatedAt: '',
      },
      toPlanningSummary(teamId, predecessor),
      toPlanningSummary(teamId, successor),
    )
    const conflict = conflicts[0]
    if (conflict) {
      errors.push({
        row: link.successorRow,
        field: 'dependencies',
        code: 'ImportDependencyScheduleConflict',
        message: conflict.code === 'missing-schedule'
          ? 'Both Work Items of a schedule dependency need a schedule.'
          : `The schedule must start or finish on or after ${conflict.requiredDate ?? 'the date the dependency requires'}.`,
      })
    }
  }
  return errors
}

/**
 * Applies one link of an import whose rows all exist; a link that is already in place is left as is.
 *
 * @param request - Link and the identity of the import.
 */
export async function applyWorkItemImportLink(request: ApplyWorkItemImportLinkRequest): Promise<void> {
  const { link } = request
  if (link.kind === 'parent') {
    await createImportRelation(request, request.workItemIdForRow(link.childRow), request.workItemIdForRow(link.parentRow), 'parent')
    return
  }
  if (link.kind === 'relation') {
    await createImportRelation(request, request.workItemIdForRow(link.sourceRow), request.workItemIdForRow(link.targetRow), link.type)
    return
  }
  if (link.kind === 'dependency') {
    await createImportDependency(request, link)
    return
  }
  await replaceImportAcceptanceCriteria(request, link)
}

/**
 * Creates the dependency ID of one import link.
 *
 * @param linkIdentity - Retry-stable link identity.
 * @returns A dependency ID that a retry reuses.
 */
export function createWorkItemImportDependencyId(linkIdentity: string) {
  return `import-${createHash('sha256').update(`work-item-import-dependency-v1\n${linkIdentity}`).digest('hex').slice(0, 48)}`
}

/**
 * Creates one relation between imported Work Items unless it already exists.
 *
 * @param request - Link request.
 * @param sourceWorkItemId - Relation source; the child of a parent link.
 * @param targetWorkItemId - Relation target; the parent of a parent link.
 * @param type - Relation type from the source.
 */
async function createImportRelation(
  request: ApplyWorkItemImportLinkRequest,
  sourceWorkItemId: string,
  targetWorkItemId: string,
  type: Extract<WorkItemRelationType, 'parent' | 'blocks' | 'related' | 'duplicate'>,
) {
  const { principal, teamId } = request
  const directoryId = principal.directoryId
  const permission = await requireTeamPermission(principal, teamId, 'member')
  const [source, target, current] = await Promise.all([
    workItemDependencies.teamIssues.getTeamIssueDetail(directoryId, teamId, sourceWorkItemId, {
      consistentIssueRead: true,
      includeEvents: false,
    }),
    workItemDependencies.teamIssues.getTeamIssueDetail(directoryId, teamId, targetWorkItemId, {
      consistentIssueRead: true,
      includeEvents: false,
    }),
    workItemDependencies.workItemConfigurations.listRelations(directoryId, teamId, sourceWorkItemId, { types: [type] }),
  ])
  requireAssignedProjectPermission(principal, permission, source.issue.assignedProjectId, 'member')
  requireAssignedProjectPermission(principal, permission, target.issue.assignedProjectId, 'member')
  if (current.relations.some((relation) => relation.targetWorkItemId === targetWorkItemId && relation.type === type)) return
  const resolvedConfiguration = type === 'parent'
    ? await workItemDependencies.workItemConfigurations.getTeamConfiguration(directoryId, teamId)
    : undefined
  if (resolvedConfiguration) {
    assertWorkItemChildTypeAllowed(
      resolvedConfiguration.configuration,
      target.issue.workItemTypeId,
      source.issue.workItemTypeId,
    )
  }
  await workItemDependencies.workItemConfigurations.createRelation(
    directoryId,
    teamId,
    {
      sourceWorkItemId,
      targetWorkItemId,
      type,
      expectedGraphRevision: current.graphRevision,
      sourceExpectedRevision: source.issue.revision,
      targetExpectedRevision: target.issue.revision,
      ...(source.issue.assignedProjectId ? { sourceAssignedProjectId: source.issue.assignedProjectId } : {}),
      ...(target.issue.assignedProjectId ? { targetAssignedProjectId: target.issue.assignedProjectId } : {}),
    },
    resolvedConfiguration
      ? createWorkItemConfigurationGuardConditionChecks(
          getWorkItemConfigurationTableName(),
          directoryId,
          teamId,
          resolvedConfiguration,
        )
      : undefined,
    { context: request.audit, actorMemberKey: principal.userKey },
  )
  await Promise.all([source.issue, target.issue].map((issue) =>
    projectWorkItemSearchDocumentBestEffort(directoryId, issue, 'Work Item import relation creation')))
}

/**
 * Creates one schedule dependency between imported Work Items unless it already exists.
 *
 * @param request - Link request.
 * @param link - Dependency link.
 */
async function createImportDependency(
  request: ApplyWorkItemImportLinkRequest,
  link: Extract<WorkItemImportLink, { kind: 'dependency' }>,
) {
  const { principal, teamId } = request
  const id = createWorkItemImportDependencyId(request.linkIdentity)
  const predecessor = { teamId, workItemId: request.workItemIdForRow(link.predecessorRow) }
  const successor = { teamId, workItemId: request.workItemIdForRow(link.successorRow) }
  await Promise.all([
    requirePlanningWorkItemEndpointPermission(principal, predecessor, 'manager'),
    requirePlanningWorkItemEndpointPermission(principal, successor, 'manager'),
  ])
  const workItemState = await readPlanningWorkItemState(principal)
  const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
  if (snapshot.workItemDependencies.some((dependency) => dependency.id === id)) return
  await workItemDependencies.planning.createWorkItemDependency(
    principal.directoryId,
    {
      id,
      predecessor,
      successor,
      type: link.type,
      lagDays: link.lagDays,
      expectedRevision: snapshot.revision,
    },
    workItemState,
    createPlanningCallerAuthorizationConditionChecks(principal),
  )
}

/**
 * Stores the acceptance criteria of one imported Work Item unless it already has them.
 *
 * @param request - Link request.
 * @param link - Acceptance criteria link.
 */
async function replaceImportAcceptanceCriteria(
  request: ApplyWorkItemImportLinkRequest,
  link: Extract<WorkItemImportLink, { kind: 'acceptance-criteria' }>,
) {
  const { principal, teamId } = request
  const directoryId = principal.directoryId
  const workItemId = request.workItemIdForRow(link.row)
  const permission = await requireTeamPermission(principal, teamId, 'member')
  const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(directoryId, teamId, workItemId, {
    consistentIssueRead: true,
    includeEvents: false,
  })
  requireAssignedProjectPermission(principal, permission, detail.issue.assignedProjectId, 'member')
  const existing = detail.issue.acceptanceCriteria ?? []
  if (
    existing.length === link.criteria.length &&
    existing.every((criterion, index) =>
      criterion.text === link.criteria[index]?.text && criterion.satisfied === link.criteria[index]?.satisfied)
  ) return
  const body = {
    acceptanceCriteria: link.criteria.map((criterion) => ({ text: criterion.text, satisfied: criterion.satisfied })),
    expectedRevision: detail.issue.revision,
  }
  const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(directoryId, teamId)
  const configuredBody = await prepareConfiguredUpdateWorkItem(directoryId, teamId, detail.issue, body, resolvedConfiguration)
  const acceptanceCriteria = readAcceptanceCriteriaChange(configuredBody, existing, false)
  const response = await workItemDependencies.teamIssues.updateTeamIssue(
    directoryId,
    teamId,
    workItemId,
    {
      ...configuredBody,
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
      expectedRevision: detail.issue.revision,
    },
    principal.userKey,
    request.audit,
  )
  await projectWorkItemSearchDocumentBestEffort(directoryId, response.issue, 'Work Item import acceptance criteria')
}

/**
 * Builds the planning summary of a row that does not exist yet.
 *
 * @param teamId - Owning Team.
 * @param row - Dry-run row.
 * @returns The summary the dependency check reads.
 */
function toPlanningSummary(teamId: string, row: WorkItemImportLinkRow): PlanningWorkItemSummary {
  return {
    id: `row-${row.row}`,
    revision: 0,
    teamId,
    title: '',
    ...(row.assignedProjectId ? { projectId: row.assignedProjectId } : {}),
    statusCategory: 'unstarted',
    // The dependency check reads the schedule only.
    dueDate: '',
    schedule: row.schedule,
  }
}

/**
 * Reads the stable code of a rejected operation.
 *
 * @param error - Thrown value.
 * @param fallback - Code used when the value has none.
 * @returns The code.
 */
function readErrorCode(error: unknown, fallback: string) {
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  return typeof code === 'string' && code ? code : fallback
}

/**
 * Reads the HTTP status of a rejected operation.
 *
 * @param error - Thrown value.
 * @returns The status, or 500 when the value has none.
 */
function readStatus(error: unknown) {
  const status: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'status') : undefined
  return typeof status === 'number' ? status : 500
}
