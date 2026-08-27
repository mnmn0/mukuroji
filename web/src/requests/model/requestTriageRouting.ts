import type {
  AiTriageDraft,
  RequestFormRoutingTarget,
} from '@mukuroji/contracts'
import type { RequestSubmissionModel } from './requestForm'

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
 * @returns Safe partial routing target for the conversion action.
 */
export function createSafeTriageRoutingOverride(
  submission: RequestSubmissionModel,
  draft: AiTriageDraft,
  currentOverride: Partial<RequestFormRoutingTarget> = {},
): Partial<RequestFormRoutingTarget> {
  const proposedTeamId = draft.teamId?.value
  const currentTeamId = currentOverride.teamId ?? submission.routing.teamId
  const inheritedProjectId = currentOverride.projectId ?? submission.routing.projectId
  const inheritedWorkflowStatusId = currentOverride.workflowStatusId ?? submission.routing.workflowStatusId
  const teamChanged = proposedTeamId !== undefined && proposedTeamId !== currentTeamId
  const canApplyTeamChange = !teamChanged || (
    inheritedWorkflowStatusId === undefined &&
    (draft.projectId !== undefined || inheritedProjectId === undefined)
  )

  return {
    ...currentOverride,
    ...(canApplyTeamChange && draft.teamId ? { teamId: draft.teamId.value } : {}),
    ...(canApplyTeamChange && draft.projectId ? { projectId: draft.projectId.value } : {}),
    ...(draft.assigneeUserId ? { assigneeUserId: draft.assigneeUserId.value } : {}),
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
 * @returns Whether adopting the draft would change at least one supported form field.
 */
export function canAdoptRequestTriageDraft(
  submission: RequestSubmissionModel,
  draft: AiTriageDraft,
  currentOverride: Partial<RequestFormRoutingTarget> = {},
): boolean {
  const safeRouting = createSafeTriageRoutingOverride(
    submission,
    draft,
    currentOverride,
  )
  const hasNonRoutingProposal = draft.title !== undefined ||
    draft.description !== undefined ||
    draft.priority !== undefined ||
    draft.assigneeUserId !== undefined
  const hasSafeRoutingProposal = (draft.teamId !== undefined && safeRouting.teamId !== undefined) ||
    (draft.projectId !== undefined && safeRouting.projectId !== undefined)

  return hasNonRoutingProposal || hasSafeRoutingProposal
}
