import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type ApprovalSummary,
  type ResolvedWorkItemConfiguration,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { Context } from 'hono'
import { type WorkItemDependencies } from '../../app/composition/app-dependencies'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import {
  readAssignedProjectId,
  type TeamIssueResponseItem,
  type UpdateTeamIssueRequestBody,
} from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  FileProofingError,
  type PendingWorkItemApprovalCompletionTransition,
  type ListReviewerApprovalsOptions,
  type ReviewerApprovalPage,
} from '../../modules/files/file-proofing'
import {
  WorkItemConfigurationError,
  assertWorkItemTypeChangeResolution,
  assertWorkflowTransitionAllowed,
  createWorkItemConfigurationGuardConditionChecks,
  normalizeCustomFieldValues,
  previewWorkItemTypeChange,
  resolveWorkItemType,
  resolveWorkItemTypeWorkflow,
  resolveWorkflowStatus,
  type WorkItemConfigurationTransactionItems,
} from '../../modules/work-items/work-item-configuration'
import {
  ambientAutomationActionExecutorDependencies,
  type AutomationActionExecutorDependencies,
  workItemDependencies,
} from './app-dependencies'
import { toCognitoDirectoryErrorResponse } from './enterprise-access'
import { readJson } from './http'
import { toProjectDataErrorResponse, type WorkspacePrincipal } from './project-access'
import { isRecord } from './value-guards'
import { loadAuthorizedTeamIssue } from './work-item-access'
import {
  createWorkItemTypeRelationConfigurationTransactionItems,
  getWorkItemConfigurationTableName,
  readWorkItemTypeChangeResolution,
  requireActiveCustomFieldPeople,
} from './work-item-configuration'
import { projectAccessAllows, toWorkspaceAccessErrorResponse } from './workspace-access'

/**
 * Requires every approval reviewer to be active and able to view the target Work Item.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Owning Team identifier.
 * @param assignedProjectId - Optional assigned Project identifier.
 * @param reviewerMemberKeys - Normalized reviewer member keys.
 * @param dependencies - Ports used for membership and access checks.
 * @returns Active reviewer membership records.
 */
export async function requireApprovalReviewers(
  workspaceId: string,
  teamId: string,
  assignedProjectId: string | undefined,
  reviewerMemberKeys: readonly string[],
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
) {
  const directory = assignedProjectId
    ? undefined
    : await dependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja', true)
  const teamProjectIds = new Set(
    directory?.teams.find((team) => team.id === teamId)?.projects.map((project) => project.id) ?? [],
  )
  return await Promise.all(reviewerMemberKeys.map(async (memberKey) => {
    const member = await dependencies.workspaceAccess.getActiveMember(
      workspaceId,
      memberKey,
    )
    if (!member) {
      throw new FileProofingError(
        409,
        'ApprovalReviewerInactive',
        `Reviewer "${memberKey}" is not an active Workspace member.`,
      )
    }
    const reviewerIsSystemAdmin = await dependencies.cognito.isSystemAdmin(
      member.memberKey,
    )
    if (assignedProjectId && !reviewerIsSystemAdmin) {
      const projectAccess = await dependencies.projectDirectory.getProjectAccess(
        workspaceId,
        assignedProjectId,
        member.memberKey,
      )
      if (!projectAccess || !projectAccessAllows(projectAccess, 'viewer')) {
        throw new FileProofingError(
          409,
          'ApprovalReviewerAccessDenied',
          `Reviewer "${memberKey}" cannot view the assigned project.`,
        )
      }
    } else if (!assignedProjectId && !reviewerIsSystemAdmin) {
      const projectAccesses = await dependencies.projectDirectory.getProjectAccessList(
        workspaceId,
        member.memberKey,
      )
      if (!projectAccesses.some((access) =>
        teamProjectIds.has(access.projectId) && projectAccessAllows(access, 'viewer')
      )) {
        throw new FileProofingError(
          409,
          'ApprovalReviewerAccessDenied',
          `Reviewer "${memberKey}" cannot view the Work Item team.`,
        )
      }
    }
    return member
  }))
}

/**
 * Lists reviewer approvals after current Work Item authorization checks.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param options - Reviewer projection cursor and requested authorized result limit.
 * @param sourcePageBudget - Optional shared raw-port page budget decremented by each source read.
 * @returns Current authorized approvals and the next unconsumed source cursor when present.
 */
export async function listAuthorizedReviewerApprovals(
  principal: WorkspacePrincipal,
  options: ListReviewerApprovalsOptions,
  sourcePageBudget?: { remaining: number },
): Promise<ReviewerApprovalPage> {
  const limit = options.limit ?? 50
  const approvals: ReviewerApprovalPage['approvals'] = []
  let cursor = options.cursor
  const visitedCursors = new Set<string>()

  do {
    if (sourcePageBudget !== undefined && sourcePageBudget.remaining <= 0) break
    const page = await workItemDependencies.fileProofing.listReviewerApprovals(
      principal.directoryId,
      {
        memberKey: principal.userKey,
        guest: principal.workspaceRole === 'guest',
        canWrite: false,
        canManage: false,
      },
      {
        ...(cursor ? { cursor } : {}),
        limit: limit - approvals.length,
      },
    )
    if (sourcePageBudget !== undefined) sourcePageBudget.remaining -= 1
    const authorized = await Promise.all(page.approvals.map(async (approval) => {
      if (!approval.teamId || !approval.issueId) {
        return undefined
      }
      try {
        await loadAuthorizedTeamIssue(
          principal,
          approval.teamId,
          approval.issueId,
          'viewer',
        )
        return approval
      } catch (error) {
        if (isReviewerApprovalAuthorizationMiss(error)) {
          return undefined
        }
        throw error
      }
    }))
    approvals.push(...authorized.filter((approval) => approval !== undefined))

    if (page.nextCursor && (page.nextCursor === cursor || visitedCursors.has(page.nextCursor))) {
      throw new FileProofingError(
        503,
        'ReviewerApprovalCursorStalled',
        'Reviewer approvals could not advance to the next page.',
      )
    }
    if (cursor) {
      visitedCursors.add(cursor)
    }
    cursor = page.nextCursor
  } while (
    approvals.length < limit &&
    cursor &&
    (sourcePageBudget === undefined || sourcePageBudget.remaining > 0)
  )

  return {
    approvals,
    ...(cursor ? { nextCursor: cursor } : {}),
  }
}

function isReviewerApprovalAuthorizationMiss(error: unknown) {
  return (error instanceof ProjectDataError || isRecord(error)) &&
    (error.status === 403 || error.status === 404)
}

/**
 * Reads a file proofing JSON object body.
 *
 * @param request - Request whose body is read.
 * @returns The parsed object body.
 */
export async function readFileProofingJson<T>(request: { json: () => Promise<unknown> }) {
  const body = await readJson<unknown>(request)
  if (!isRecord(body)) {
    throw new FileProofingError(
      400,
      'InvalidFileProofingInput',
      'A JSON object request body is required.',
    )
  }
  return body as T
}

/**
 * Converts file proofing failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @returns The HTTP error response.
 */
export function toFileProofingErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }
  if (error instanceof WorkspaceAccessError) {
    return toWorkspaceAccessErrorResponse(c, error)
  }
  if (error instanceof ProjectDataError) {
    return toProjectDataErrorResponse(c, error)
  }
  if (!(error instanceof FileProofingError)) {
    console.error(error)
    return c.json({ message: 'File proofing data is unavailable.' }, 502)
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 410 ||
    error.status === 413 ||
    error.status === 415 ||
    error.status === 422 ||
    error.status === 423 ||
    error.status === 503
    ? error.status
    : 502

  return c.json({ code: error.code, message: error.message }, status)
}

/** File approval mutation が canonical Work Item だけを対象にすることを保証します。 */
export function requireCanonicalFileProofingWorkItem(
  workItem: TeamIssueResponseItem | undefined,
) {
  if (!workItem) {
    throw new FileProofingError(
      404,
      'WorkItemNotFound',
      'Work Item was not found.',
    )
  }
  return workItem
}

/**
 * Resolves an approval completion transition against current workflow state.
 *
 * @param directoryId - Owning Workspace directory identifier.
 * @param teamId - Owning Team identifier.
 * @param workItem - Canonical Work Item being approved.
 * @param completionTransition - Requested target workflow status.
 * @param dependencies - Ports used to read workflow configuration.
 * @returns A transaction-ready completion transition snapshot.
 */
export async function resolveFileApprovalCompletionTransition(
  directoryId: string,
  teamId: string,
  workItem: ReturnType<typeof requireCanonicalFileProofingWorkItem>,
  completionTransition: string,
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
) {
  try {
    const resolved = await dependencies.workItemConfigurations.getTeamConfiguration(
      directoryId,
      teamId,
    )
    const currentStatus = resolveWorkflowStatus(
      resolved.configuration,
      workItem.workflowStatusId,
      workItem.workItemTypeId,
    )
    const nextStatus = resolveWorkflowStatus(
      resolved.configuration,
      completionTransition,
      workItem.workItemTypeId,
    )
    assertWorkflowTransitionAllowed(
      resolved.configuration,
      currentStatus.workflowStatusId,
      nextStatus.workflowStatusId,
      workItem.workItemTypeId,
    )
    return {
      workflowStatusId: nextStatus.workflowStatusId,
      statusCategory: nextStatus.statusCategory,
      workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
      expectedRevision: workItem.revision,
      configurationConditionChecks: createWorkItemConfigurationGuardConditionChecks(
        getWorkItemConfigurationTableName(),
        directoryId,
        teamId,
        resolved,
      ),
    }
  } catch (error) {
    if (error instanceof WorkItemConfigurationError) {
      throw new FileProofingError(error.status, error.code, error.message, { cause: error })
    }
    throw error
  }
}

/**
 * Checks whether an approval summary contains any approval.
 *
 * @param summary - Approval summary.
 * @returns `true` when at least one approval exists.
 */
export function hasApprovalSummaryContent(summary: ApprovalSummary) {
  return summary.pendingCount + summary.approvedCount + summary.rejectedCount +
    summary.changesRequestedCount > 0
}

/**
 * Prepares a Work Item update against the resolved Work Item configuration.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team that owns the resource.
 * @param current - Current Work Item.
 * @param input - Request input.
 * @param resolved - Resolved Work Item configuration.
 * @param options - Optional dependency overrides for relation validation.
 * @returns The validated update and its configuration transaction items.
 */
export async function prepareConfiguredUpdateWorkItem(
  directoryId: string,
  teamId: string,
  current: TeamIssueResponseItem,
  input: UpdateTeamIssueRequestBody,
  resolved: ResolvedWorkItemConfiguration,
  options: {
    relationDependencies?: Pick<WorkItemDependencies, 'teamIssues' | 'workItemConfigurations'>
  } = {},
): Promise<UpdateTeamIssueRequestBody> {
  const currentWorkItemType = resolveWorkItemType(
    resolved.configuration,
    current.workItemTypeId,
    { allowArchived: true },
  )
  const requestedWorkItemTypeId = 'workItemTypeId' in input
    ? input.workItemTypeId
    : currentWorkItemType.id
  const targetWorkItemType = resolveWorkItemType(
    resolved.configuration,
    requestedWorkItemTypeId,
    { allowArchived: true },
  )
  const currentWorkflowStatus = resolveWorkflowStatus(
    resolved.configuration,
    current.workflowStatusId,
    currentWorkItemType.id,
  )
  const currentWorkflow = resolveWorkItemTypeWorkflow(
    resolved.configuration,
    currentWorkItemType.id,
    { allowArchived: true },
  )
  const typeChanged = currentWorkItemType.id !== targetWorkItemType.id
  if (typeChanged && targetWorkItemType.status === 'archived') {
    resolveWorkItemType(resolved.configuration, targetWorkItemType.id)
  }
  const typeChangeResolution = readWorkItemTypeChangeResolution(input.typeChangeResolution)
  const typeChangePreview = typeChanged
    ? previewWorkItemTypeChange(
        resolved.configuration,
        currentWorkItemType.id,
        current.workflowStatusId,
        current.customFieldValues,
        targetWorkItemType.id,
        'assignedProjectId' in input
          ? readAssignedProjectId(input.assignedProjectId) ?? undefined
          : current.assignedProjectId,
        current.revision,
      )
    : undefined
  const requestedWorkflowStatusId = typeChangePreview
    ? assertWorkItemTypeChangeResolution(
        typeChangePreview,
        typeChangeResolution,
        input.workflowStatusId ?? (
          typeChangePreview.invalidWorkflowStatusId === undefined
            ? currentWorkflowStatus.workflowStatusId
            : undefined
        ),
      )
    : input.workflowStatusId ?? currentWorkflowStatus.workflowStatusId
  const nextWorkflowStatus = resolveWorkflowStatus(
    resolved.configuration,
    requestedWorkflowStatusId,
    targetWorkItemType.id,
  )
  const targetWorkflow = resolveWorkItemTypeWorkflow(
    resolved.configuration,
    targetWorkItemType.id,
    { allowArchived: true },
  )
  if (!typeChanged || currentWorkflow.id === targetWorkflow.id) {
    assertWorkflowTransitionAllowed(
      resolved.configuration,
      currentWorkflowStatus.workflowStatusId,
      nextWorkflowStatus.workflowStatusId,
      targetWorkItemType.id,
    )
  }
  const projectId = 'assignedProjectId' in input
    ? readAssignedProjectId(input.assignedProjectId) ?? undefined
    : current.assignedProjectId
  const existingValues = typeChangePreview
    ? Object.fromEntries(Object.entries(current.customFieldValues).filter(([fieldId]) =>
        !typeChangePreview.lostCustomFieldIds.includes(fieldId),
      ))
    : current.customFieldValues
  const inputWithoutTypeChangeResolution = { ...input }
  delete inputWithoutTypeChangeResolution.typeChangeResolution
  if (
    typeChangePreview &&
    isRecord(inputWithoutTypeChangeResolution.customFieldValues)
  ) {
    inputWithoutTypeChangeResolution.customFieldValues = Object.fromEntries(
      Object.entries(inputWithoutTypeChangeResolution.customFieldValues).filter(([fieldId]) =>
        !typeChangePreview.lostCustomFieldIds.includes(fieldId),
      ),
    )
  }
  const customFieldValues = normalizeCustomFieldValues(
    resolved.configuration,
    inputWithoutTypeChangeResolution.customFieldValues,
    {
      allowRequiredMissing:
        currentWorkflowStatus.statusCategory === 'backlog' &&
        nextWorkflowStatus.statusCategory === 'backlog',
      mode: 'update',
      existingValues,
      projectId,
      workItemTypeId: targetWorkItemType.id,
    },
  )
  await requireActiveCustomFieldPeople(
    directoryId,
    resolved.configuration,
    customFieldValues,
    projectId,
    targetWorkItemType.id,
  )
  const relationTransactionItems = typeChanged
    ? await createWorkItemTypeRelationConfigurationTransactionItems(
        directoryId,
        teamId,
        current,
        targetWorkItemType.id,
        resolved.configuration,
        options.relationDependencies,
      )
    : []
  const approvalTransitionConditionChecks = typeChanged
    ? await createWorkItemApprovalTypeChangeConfigurationTransactionItems(
        directoryId,
        teamId,
        current.id,
        targetWorkItemType.id,
        nextWorkflowStatus.workflowStatusId,
        resolved.configuration,
      )
    : []
  return {
    ...inputWithoutTypeChangeResolution,
    workItemTypeId: targetWorkItemType.id,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: nextWorkflowStatus.workflowStatusId,
    statusCategory: nextWorkflowStatus.statusCategory,
    customFieldValues,
    configurationConditionChecks: createWorkItemConfigurationGuardConditionChecks(
      getWorkItemConfigurationTableName(),
      directoryId,
      teamId,
      resolved,
    ).concat(relationTransactionItems, approvalTransitionConditionChecks),
  }
}

/**
 * Reads pending Work Item approval transitions needed by a type-change check.
 *
 * @param directoryId - Workspace whose Work Item is being changed.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item whose approvals are inspected.
 * @returns Pending approval transitions and their commit-time row fences.
 * @throws WorkItemConfigurationError when approval storage cannot be inspected.
 */
async function readPendingWorkItemApprovalCompletionTransitions(
  directoryId: string,
  teamId: string,
  issueId: string,
): Promise<PendingWorkItemApprovalCompletionTransition[]> {
  try {
    return await workItemDependencies.fileProofing.listPendingWorkItemApprovalCompletionTransitions({
      workspaceId: directoryId,
      teamId,
      kind: 'work-item',
      issueId,
    })
  } catch {
    throw new WorkItemConfigurationError(
      503,
      'WorkItemConfigurationDependencyUnavailable',
      'Pending Work Item approval transitions could not be inspected.',
    )
  }
}

/**
 * Validates one pending approval transition against the post-change Work Item state.
 *
 * @param configuration - Candidate Work Item configuration.
 * @param reference - Pending approval transition read from durable storage.
 * @param targetWorkItemTypeId - Work Item Type after the change.
 * @param targetWorkflowStatusId - Workflow status after the change.
 * @returns Nothing when the completion transition remains usable.
 * @throws WorkItemConfigurationError when the transition is no longer allowed.
 */
function assertWorkItemApprovalCompletionTransitionCompatible(
  configuration: WorkItemConfiguration,
  reference: PendingWorkItemApprovalCompletionTransition,
  targetWorkItemTypeId: string,
  targetWorkflowStatusId: string,
): void {
  const completionStatus = resolveWorkflowStatus(
    configuration,
    reference.completionTransition,
    targetWorkItemTypeId,
  )
  assertWorkflowTransitionAllowed(
    configuration,
    targetWorkflowStatusId,
    completionStatus.workflowStatusId,
    targetWorkItemTypeId,
  )
}

/**
 * Validates pending approval transitions and returns their commit-time row fences.
 *
 * @param directoryId - Workspace whose Work Item is being changed.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item whose approvals are inspected.
 * @param targetWorkItemTypeId - Work Item Type after the change.
 * @param targetWorkflowStatusId - Workflow status after the change.
 * @param configuration - Candidate Work Item configuration.
 * @returns Approval row condition checks for the Work Item transaction.
 * @throws WorkItemConfigurationError when a pending approval would be broken.
 */
async function createWorkItemApprovalTypeChangeConfigurationTransactionItems(
  directoryId: string,
  teamId: string,
  issueId: string,
  targetWorkItemTypeId: string,
  targetWorkflowStatusId: string,
  configuration: WorkItemConfiguration,
): Promise<WorkItemConfigurationTransactionItems> {
  const references = await readPendingWorkItemApprovalCompletionTransitions(
    directoryId,
    teamId,
    issueId,
  )
  for (const reference of references) {
    try {
      assertWorkItemApprovalCompletionTransitionCompatible(
        configuration,
        reference,
        targetWorkItemTypeId,
        targetWorkflowStatusId,
      )
    } catch (error) {
      if (error instanceof WorkItemConfigurationError) {
        throw new WorkItemConfigurationError(
          409,
          'WorkItemApprovalCompletionTransitionConflict',
          `Pending approval "${reference.approvalId}" cannot complete after this Work Item Type change.`,
        )
      }
      throw error
    }
  }
  return references.map((reference) => reference.conditionCheck)
}

/**
 * Checks whether a previewed type/status pair would break a pending approval transition.
 *
 * @param directoryId - Workspace whose Work Item is being previewed.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item whose approvals are inspected.
 * @param targetWorkItemTypeId - Previewed Work Item Type.
 * @param targetWorkflowStatusId - Previewed workflow status.
 * @param configuration - Current Work Item configuration.
 * @returns Whether any pending approval cannot complete after the preview.
 */
export async function hasWorkItemApprovalCompletionTransitionConflict(
  directoryId: string,
  teamId: string,
  issueId: string,
  targetWorkItemTypeId: string,
  targetWorkflowStatusId: string,
  configuration: WorkItemConfiguration,
): Promise<boolean> {
  const references = await readPendingWorkItemApprovalCompletionTransitions(
    directoryId,
    teamId,
    issueId,
  )
  return references.some((reference) => {
    try {
      assertWorkItemApprovalCompletionTransitionCompatible(
        configuration,
        reference,
        targetWorkItemTypeId,
        targetWorkflowStatusId,
      )
      return false
    } catch (error) {
      if (error instanceof WorkItemConfigurationError) return true
      throw error
    }
  })
}
