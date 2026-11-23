import {
  PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH,
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
import { ProjectChangeRequestScheduleConflictError } from '../model/projectChangeRequestDecision'
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
 * A change already in place previews no impact and is skipped, so a retried approval does not
 * move anything twice.
 *
 * @param accessToken - Session bearer token.
 * @param teamId - Team that owns the Work Item.
 * @param change - Requested change.
 * @throws ProjectChangeRequestScheduleConflictError when the change conflicts with dependencies.
 */
async function applyScheduleChange(accessToken: string, teamId: string, change: ProjectRaidScheduleChange) {
  const { issue } = await getTeamIssueDetail(teamId, change.workItemId, accessToken)
  const operation = change.operation
  const preview = await previewTeamIssueSchedule(teamId, change.workItemId, accessToken, {
    expectedRevision: issue.revision,
    operation,
  })
  if (preview.conflicts.length > 0 || preview.planningRevision === undefined || preview.relationGraphRevision === undefined) {
    throw new ProjectChangeRequestScheduleConflictError(change.workItemId)
  }
  if (preview.impacts.length === 0) return
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
}

/**
 * Returns a function that approves or rejects a change request (ADR 0078).
 *
 * Approval first applies each requested date change through the Work Item schedule cascade,
 * then, when asked, saves the resulting plan as the new active baseline, and records the decision
 * last. A failure on the way leaves the request open, and approving again skips the date changes
 * already in place. Rejection records the decision only and changes no dates.
 *
 * @param scope - Session, Team, and Project.
 * @returns The decision function, which rethrows the error of a failed step.
 */
export function useDecideProjectChangeRequest({ accessToken, teamId, projectId }: ProjectChangeRequestDecisionScope) {
  const { mutate } = useSWRConfig()
  const pendingDecision = useRef<{ fingerprint: string; context: MutationRequestContext }>(undefined)
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
    let baselineId: string | undefined
    try {
      if (outcome === 'approved') {
        for (const change of entry.scheduleChanges ?? []) {
          await applyScheduleChange(accessToken, teamId, change)
        }
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
    const request = {
      expectedRevision: entry.revision,
      outcome,
      ...(baselineId === undefined ? {} : { baselineId }),
    }
    const fingerprint = JSON.stringify([teamId, projectId, entry.id, request])
    if (pendingDecision.current?.fingerprint !== fingerprint) {
      pendingDecision.current = { fingerprint, context: createMutationRequestContext() }
    }
    const attempt = pendingDecision.current
    try {
      await decideProjectRaidChangeRequest(accessToken, teamId, projectId, entry.id, request, attempt.context)
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
