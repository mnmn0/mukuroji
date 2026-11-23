import {
  PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH,
  type DecideProjectRaidChangeRequest,
  type ProjectRaidChangeDecisionOutcome,
  type ProjectRaidEntry,
  type ProjectRaidScheduleChange,
} from '@mukuroji/contracts'
import { useCallback, useRef } from 'react'
import { useSWRConfig } from 'swr'
import { confirmTeamIssueSchedule, getTeamIssueDetail, previewTeamIssueSchedule } from '../../issues/api/workItems'
import { createMutationRequestContext, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { captureProjectScheduleBaseline } from '../../work-items/api/scheduleBaseline'
import { PROJECT_SCHEDULE_BASELINE_KEY } from '../../work-items/queries/useProjectScheduleBaseline'
import { decideProjectRaidChangeRequest } from '../api/raidLog'
import { ProjectDirectoryApiError } from '../api/errors'
import {
  isScheduleChangeInPlace,
  ProjectChangeRequestScheduleConflictError,
  ProjectChangeRequestWorkItemMovedError,
} from '../model/projectChangeRequestDecision'
import { projectRaidLogKey } from '../queries/useProjectRaidLog'

/** Session, Team, and Project of the change requests being decided. */
export type ProjectChangeRequestDecisionScope = {
  /** Cognito access token. */
  accessToken?: string
  /** Team that owns the Project. */
  teamId?: string
  /** Project identifier. */
  projectId: string
}

/** Options of one decision. */
export type ProjectChangeRequestDecisionOptions = {
  /** On approval, saves the plan after the date changes as the Project's new active baseline. */
  replaceBaseline: boolean
  /** Name of that baseline, in the display language; it is shortened to the name limit. */
  baselineName: string
}

/**
 * Shortens text to a maximum length without splitting a surrogate pair.
 *
 * @param text - Text to shorten.
 * @param maxLength - Longest allowed length in UTF-16 code units.
 * @returns The text, cut at a character boundary when it is too long.
 */
function truncate(text: string, maxLength: number) {
  if (text.length <= maxLength) return text
  let end = maxLength
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/**
 * Applies one requested date change through the Work Item schedule cascade, as the Work Item
 * screen does: preview against the current revision, then confirm the exact previewed impacts.
 * A change already in place is skipped, so a retried approval does not move anything twice.
 *
 * @param accessToken - Session bearer token.
 * @param teamId - Team that owns the Work Item.
 * @param projectId - Project of the change request; the Work Item must still belong to it.
 * @param change - Requested change.
 * @returns Whether the change could be applied now; `false` when it conflicts with the plan as
 * it stands, which another requested change may still resolve.
 * @throws ProjectChangeRequestWorkItemMovedError when the Work Item left the Project.
 */
async function applyScheduleChange(
  accessToken: string,
  teamId: string,
  projectId: string,
  change: ProjectRaidScheduleChange,
): Promise<boolean> {
  const { issue } = await getTeamIssueDetail(teamId, change.workItemId, accessToken)
  if (issue.assignedProjectId !== projectId) throw new ProjectChangeRequestWorkItemMovedError(change.workItemId)
  const operation = change.operation
  if (isScheduleChangeInPlace(issue.schedule, operation)) return true
  const preview = await previewTeamIssueSchedule(teamId, change.workItemId, accessToken, {
    expectedRevision: issue.revision,
    operation,
  })
  if (preview.conflicts.length > 0 || preview.planningRevision === undefined || preview.relationGraphRevision === undefined) {
    return false
  }
  if (preview.impacts.length === 0) return true
  await confirmTeamIssueSchedule(
    teamId,
    change.workItemId,
    accessToken,
    {
      confirmed: true,
      expectedEvaluatedRevisions: preview.evaluatedRevisions,
      expectedImpacts: preview.impacts,
      expectedPlanningRevision: preview.planningRevision,
      expectedRelationGraphRevision: preview.relationGraphRevision,
      expectedRevision: preview.expectedRevision,
      operation,
    },
    createMutationRequestContext(),
  )
  return true
}

/**
 * Applies every requested date change and checks that the plan holds all of them.
 *
 * The changes are applied in rounds. A change that conflicts with the plan as it stands is tried
 * again after the others, since moving a predecessor can make room for it, and a change that a
 * later cascade moved away is applied again. Approval stops when a round changes nothing while a
 * request is still not in place.
 *
 * @param accessToken - Session bearer token.
 * @param teamId - Team that owns the Work Items.
 * @param projectId - Project of the change request.
 * @param changes - Requested changes.
 * @throws ProjectChangeRequestScheduleConflictError when the requested dates cannot all hold.
 * @throws ProjectChangeRequestWorkItemMovedError when a Work Item left the Project.
 */
async function applyScheduleChanges(
  accessToken: string,
  teamId: string,
  projectId: string,
  changes: readonly ProjectRaidScheduleChange[],
) {
  for (let round = 0; round <= changes.length; round += 1) {
    for (const change of changes) {
      await applyScheduleChange(accessToken, teamId, projectId, change)
    }
    const pending: ProjectRaidScheduleChange[] = []
    for (const change of changes) {
      const { issue } = await getTeamIssueDetail(teamId, change.workItemId, accessToken)
      if (issue.assignedProjectId !== projectId) throw new ProjectChangeRequestWorkItemMovedError(change.workItemId)
      if (!isScheduleChangeInPlace(issue.schedule, change.operation)) pending.push(change)
    }
    const [first] = pending
    if (first === undefined) return
    if (round === changes.length) throw new ProjectChangeRequestScheduleConflictError(first.workItemId)
  }
}

/** A decision request whose outcome is not known yet, kept to send again unchanged. */
type PendingDecision = {
  /** Team, Project, entry, revision, and outcome the request decides. */
  entryKey: string
  /** The decision request, including the baseline captured for it. */
  request: DecideProjectRaidChangeRequest
  /** Idempotency context of the request. */
  context: MutationRequestContext
}

/**
 * Returns a function that approves or rejects a change request (ADR 0078).
 *
 * Approval first applies the requested date changes through the Work Item schedule cascade and
 * checks that all of them hold, then, when asked, saves the resulting plan as the new active baseline, and records the decision
 * last. A failure on the way leaves the request open, and approving again skips the date changes
 * already in place. Rejection records the decision only and changes no dates.
 *
 * @param scope - Session, Team, and Project.
 * @returns The decision function, which rethrows the error of a failed step.
 */
export function useDecideProjectChangeRequest({ accessToken, teamId, projectId }: ProjectChangeRequestDecisionScope) {
  const { mutate } = useSWRConfig()
  const pendingDecision = useRef<PendingDecision>(undefined)
  return useCallback(async (
    entry: ProjectRaidEntry,
    outcome: ProjectRaidChangeDecisionOutcome,
    options: ProjectChangeRequestDecisionOptions,
  ) => {
    if (!accessToken || !teamId) return
    /** Revalidates the views the decision may have changed. */
    const refresh = () => Promise.all([
      mutate(projectRaidLogKey(accessToken, teamId, projectId)),
      mutate((key: unknown) => Array.isArray(key) && (
        (key[0] === 'project-issues' && key[2] === projectId) ||
        (key[0] === PROJECT_SCHEDULE_BASELINE_KEY && key[2] === teamId && key[3] === projectId)
      )),
    ])
    const entryKey = JSON.stringify([teamId, projectId, entry.id, entry.revision, outcome])
    // A decision whose outcome is unknown is sent again as it was, before any date change or
    // baseline capture runs again, so a lost response neither repeats them nor changes the key.
    let attempt = pendingDecision.current?.entryKey === entryKey ? pendingDecision.current : undefined
    if (attempt === undefined) {
      let baselineId: string | undefined
      try {
        if (outcome === 'approved') {
          await applyScheduleChanges(accessToken, teamId, projectId, entry.scheduleChanges ?? [])
          if (options.replaceBaseline) {
            const captured = await captureProjectScheduleBaseline(
              teamId,
              projectId,
              accessToken,
              truncate(options.baselineName, PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH),
            )
            baselineId = captured.activeBaselineId
          }
        }
      } catch (error) {
        void refresh()
        throw error
      }
      attempt = {
        entryKey,
        request: {
          expectedRevision: entry.revision,
          outcome,
          ...(baselineId === undefined ? {} : { baselineId }),
        },
        context: createMutationRequestContext(),
      }
      pendingDecision.current = attempt
    }
    try {
      await decideProjectRaidChangeRequest(accessToken, teamId, projectId, entry.id, attempt.request, attempt.context)
    } catch (error) {
      if (error instanceof ProjectDirectoryApiError && error.status < 500 && pendingDecision.current === attempt) {
        pendingDecision.current = undefined
      }
      void refresh()
      throw error
    }
    if (pendingDecision.current === attempt) pendingDecision.current = undefined
    await refresh()
  }, [accessToken, mutate, projectId, teamId])
}
