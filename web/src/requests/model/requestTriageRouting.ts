import type {
  AiTriageDraft,
  RequestFormRoutingTarget,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { RequestSubmissionModel } from './requestForm'

/** Team-scoped Project IDs available to the current Request conversion form. */
export type RequestRoutingProjectDirectory = ReadonlyMap<string, ReadonlySet<string>>

/** Active non-guest Workspace member keys that may be copied into a Request conversion form. */
export type RequestRoutingAssigneeDirectory = ReadonlySet<string>

/**
 * Resolves the Work Item configuration for the current Request conversion target.
 *
 * @param configurations - Team-scoped configurations loaded by the Request Intake page.
 * @param submission - Current Request submission whose routing is used as the fallback target.
 * @param currentOverride - Local partial routing override currently applied to the conversion form.
 * @returns The configuration for the effective Team, or undefined when it is unavailable.
 */
export function resolveRequestWorkItemConfiguration(
  configurations: Readonly<Record<string, WorkItemConfiguration>> | undefined,
  submission: RequestSubmissionModel,
  currentOverride: Partial<RequestFormRoutingTarget> = {},
): WorkItemConfiguration | undefined {
  const effectiveTeamId = currentOverride.teamId ?? submission.routing.teamId
  return configurations?.[effectiveTeamId]
}

/** Checks whether a proposed assignee is present in the current active-member directory. */
function isActiveAssignee(
  assigneeUserId: string,
  assigneeDirectory: RequestRoutingAssigneeDirectory | undefined,
): boolean {
  if (!assigneeDirectory) return false
  const normalizedAssignee = assigneeUserId.trim().toLowerCase()
  return normalizedAssignee.length > 0 && assigneeDirectory.has(normalizedAssignee)
}

/** Checks whether a proposed Project belongs to the effective Team in the current directory. */
function isProjectInEffectiveTeam(
  projectId: string,
  teamId: string | undefined,
  projectDirectory: RequestRoutingProjectDirectory | undefined,
): boolean {
  if (!teamId || !projectDirectory) return false
  return projectDirectory.get(teamId)?.has(projectId) ?? false
}

/**
 * Builds a conversion routing override without carrying Team-dependent values across Teams.
 *
 * The conversion endpoint merges partial targets with the submission's stored target and does
 * not provide a client-side clear sentinel. A proposed Team change is therefore applied only
 * when the inherited Project and workflow status are absent, or when the draft supplies a new
 * Project and no workflow status would be inherited. Otherwise the Team-dependent proposal is
 * kept review-only and unrelated title/description/priority fields remain adoptable.
 *
 * @param submission - Current immutable Request submission and routing target.
 * @param draft - Validated AI triage draft under review.
 * @param currentOverride - Existing local conversion routing overrides.
 * @param projectDirectory - Team-scoped Project IDs used to validate proposed routing.
 * @param assigneeDirectory - Active Workspace member keys used to validate proposed assignees.
 * @returns Safe partial routing target for the conversion action.
 */
export function createSafeTriageRoutingOverride(
  submission: RequestSubmissionModel,
  draft: AiTriageDraft,
  currentOverride: Partial<RequestFormRoutingTarget> = {},
  projectDirectory?: RequestRoutingProjectDirectory,
  assigneeDirectory?: RequestRoutingAssigneeDirectory,
): Partial<RequestFormRoutingTarget> {
  const proposedTeamId = draft.teamId?.value
  const currentTeamId = currentOverride.teamId ?? submission.routing.teamId
  const effectiveTeamId = proposedTeamId ?? currentTeamId
  const proposedProjectId = draft.projectId?.value
  const inheritedProjectId = currentOverride.projectId ?? submission.routing.projectId
  const inheritedWorkflowStatusId = currentOverride.workflowStatusId ?? submission.routing.workflowStatusId
  const teamChanged = proposedTeamId !== undefined && proposedTeamId !== currentTeamId
  const canApplyProject = proposedProjectId !== undefined && isProjectInEffectiveTeam(
    proposedProjectId,
    effectiveTeamId,
    projectDirectory,
  )
  const canApplyTeamChange = !teamChanged || (
    inheritedWorkflowStatusId === undefined &&
    (draft.projectId !== undefined || inheritedProjectId === undefined) &&
    (draft.projectId === undefined || canApplyProject)
  )

  return {
    ...currentOverride,
    ...(canApplyTeamChange && draft.teamId ? { teamId: draft.teamId.value } : {}),
    ...(canApplyTeamChange && canApplyProject && draft.projectId
      ? { projectId: draft.projectId.value }
      : {}),
    ...(draft.assigneeUserId && isActiveAssignee(draft.assigneeUserId.value, assigneeDirectory)
      ? { assigneeUserId: draft.assigneeUserId.value }
      : {}),
    ...(draft.priority ? { priority: draft.priority.value } : {}),
  }
}

/**
 * Checks whether a Request conversion draft has at least one safely adoptable field.
 *
 * A changed Team cannot be copied when the current submission would carry a Project or
 * workflow status from the old Team. In that case a Team-only proposal remains review-only
 * instead of presenting an adoption action that would open an unchanged form.
 *
 * @param submission - Current immutable Request submission and routing target.
 * @param draft - Validated AI triage draft under review.
 * @param currentOverride - Existing local conversion routing overrides.
 * @param projectDirectory - Team-scoped Project IDs used to validate proposed routing.
 * @param assigneeDirectory - Active Workspace member keys used to validate proposed assignees.
 * @returns Whether adopting the draft would change at least one supported form field.
 */
export function canAdoptRequestTriageDraft(
  submission: RequestSubmissionModel,
  draft: AiTriageDraft,
  currentOverride: Partial<RequestFormRoutingTarget> = {},
  projectDirectory?: RequestRoutingProjectDirectory,
  assigneeDirectory?: RequestRoutingAssigneeDirectory,
): boolean {
  const hasInvalidAssignee = draft.assigneeUserId !== undefined &&
    !isActiveAssignee(draft.assigneeUserId.value, assigneeDirectory)
  if (hasInvalidAssignee) return false

  const safeRouting = createSafeTriageRoutingOverride(
    submission,
    draft,
    currentOverride,
    projectDirectory,
    assigneeDirectory,
  )
  const currentTeamId = currentOverride.teamId ?? submission.routing.teamId
  const proposedTeamId = draft.teamId?.value
  const effectiveTeamId = proposedTeamId ?? currentTeamId
  const teamChanged = proposedTeamId !== undefined && proposedTeamId !== currentTeamId
  const hasNonRoutingProposal = draft.title !== undefined ||
    draft.description !== undefined ||
    draft.priority !== undefined ||
    draft.assigneeUserId !== undefined
  const hasSafeProjectProposal = draft.projectId !== undefined &&
    safeRouting.projectId === draft.projectId.value &&
    isProjectInEffectiveTeam(
      draft.projectId.value,
      effectiveTeamId,
      projectDirectory,
    )
  const hasSafeTeamProposal = draft.teamId !== undefined &&
    teamChanged &&
    safeRouting.teamId === draft.teamId.value &&
    (draft.projectId === undefined || hasSafeProjectProposal)

  return hasNonRoutingProposal || hasSafeTeamProposal || hasSafeProjectProposal
}
