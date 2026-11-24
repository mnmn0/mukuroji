import {
  PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH,
  type DecideProjectRaidChangeRequest,
  type ProjectRaidChangeDecisionOutcome,
  type ProjectRaidEntry,
  type ProjectRaidLogResponse,
  type ProjectRaidScheduleChange,
} from '@mukuroji/contracts'
import { useCallback, useRef } from 'react'
import { useSWRConfig } from 'swr'
import { confirmTeamIssueSchedule, getTeamIssueDetail, previewTeamIssueSchedule } from '../../issues/api/workItems'
import { createMutationRequestContext, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { captureProjectScheduleBaseline } from '../../work-items/api/scheduleBaseline'
import { PROJECT_SCHEDULE_BASELINE_KEY } from '../../work-items/queries/useProjectScheduleBaseline'
import { WORK_ITEM_SCHEDULE_BASELINES_KEY } from '../../work-items/queries/useWorkItemScheduleBaselines'
import { decideProjectRaidChangeRequest, holdProjectRaidChangeRequest } from '../api/raidLog'
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
 * @param affected - Collects the Teams and Projects the cascade reaches, whose views are refreshed
 * afterwards.
 * @returns Whether the change could be applied now; `false` when it conflicts with the plan as
 * it stands, which another requested change may still resolve.
 * @throws ProjectChangeRequestWorkItemMovedError when the Work Item left the Project.
 */
async function applyScheduleChange(
  accessToken: string,
  teamId: string,
  projectId: string,
  change: ProjectRaidScheduleChange,
  affected: AffectedScopes,
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
  // Recorded before confirming, so that a confirm that fails after the change was saved still
  // refreshes every view it may have changed.
  for (const reached of preview.affectedProjects) {
    affected.teamIds.add(reached.teamId)
    affected.projectIds.add(reached.projectId)
  }
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
 * @param affected - Collects the Teams and Projects the cascade reaches.
 * @param beforeRound - Runs before every round after the first, such as renewing the approval
 * hold; an error stops the approval before any more dates move.
 * @throws ProjectChangeRequestScheduleConflictError when the requested dates cannot all hold.
 * @throws ProjectChangeRequestWorkItemMovedError when a Work Item left the Project.
 */
export async function applyScheduleChanges(
  accessToken: string,
  teamId: string,
  projectId: string,
  changes: readonly ProjectRaidScheduleChange[],
  affected: AffectedScopes,
  beforeRound: () => Promise<void> = async () => undefined,
) {
  for (let round = 0; round <= changes.length; round += 1) {
    if (round > 0) await beforeRound()
    for (const change of changes) {
      await applyScheduleChange(accessToken, teamId, projectId, change, affected)
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

/** Teams and Projects whose Work Item views a decision may have changed. */
export type AffectedScopes = {
  /** Teams whose Work Item details are refreshed. */
  teamIds: Set<string>
  /** Projects whose Work Item lists are refreshed. */
  projectIds: Set<string>
}

/**
 * Builds the cache filter for the views a decision may have changed, so that dates moved by the
 * cascade show everywhere they appear.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project of the request.
 * @param projectId - Project of the request.
 * @param affected - Teams and Projects the cascade reached, including the request's own.
 * @returns A filter that accepts the SWR keys to revalidate.
 */
export function createDecisionRefreshFilter(
  accessToken: string,
  teamId: string,
  projectId: string,
  affected: AffectedScopes,
): (key: unknown) => boolean {
  return (key: unknown) => Array.isArray(key) && (
    // Dependency conflicts and the critical path come from the Planning snapshot.
    (key[0] === 'planning-snapshot' && key[1] === accessToken) ||
    // Work Item details of the Teams reached. The cascade can move successors that the request
    // does not list, and a detail kept from before would bring their old dates back into the list.
    ((key[0] === 'project-issue-detail' || key[0] === 'team-issue-detail') && affected.teamIds.has(key[2])) ||
    (key[0] === 'project-issues' && affected.projectIds.has(key[2])) ||
    (key[0] === PROJECT_SCHEDULE_BASELINE_KEY && key[2] === teamId && key[3] === projectId) ||
    // Baseline comparisons across Projects, such as the table's baseline delay column.
    key[0] === WORK_ITEM_SCHEDULE_BASELINES_KEY
  )
}

/** A decision request whose outcome is not known yet, kept to send again unchanged. */
type PendingDecision = {
  /** Team, Project, entry, and revision the request decides. */
  entryKey: string
  /** The decision request, including the baseline captured for it. */
  request: DecideProjectRaidChangeRequest
  /** Idempotency context of the request. */
  context: MutationRequestContext
}

/**
 * Drops a retained decision once its outcome is known, unless a newer attempt replaced it.
 *
 * @param pending - Retained decisions by entry key.
 * @param attempt - The attempt whose outcome is known.
 */
function forgetDecision(pending: Map<string, PendingDecision>, attempt: PendingDecision) {
  if (pending.get(attempt.entryKey) === attempt) pending.delete(attempt.entryKey)
}

/**
 * Replaces one entry of a loaded log with its stored version.
 *
 * @param log - The loaded log.
 * @param stored - The entry the server returned.
 * @returns The log with that entry replaced.
 */
function replaceLogEntry(log: ProjectRaidLogResponse, stored: ProjectRaidEntry): ProjectRaidLogResponse {
  return { ...log, entries: log.entries.map((current) => current.id === stored.id ? stored : current) }
}

/**
 * Returns a function that approves or rejects a change request (ADR 0078).
 *
 * Approval first holds the request so nobody else rejects or edits it, then applies the requested
 * date changes through the Work Item schedule cascade and
 * checks that all of them hold, then, when asked, saves the resulting plan as the new active baseline, and records the decision
 * last. A failure on the way leaves the request open, and approving again skips the date changes
 * already in place. Rejection records the decision only and changes no dates.
 *
 * @param scope - Session, Team, and Project.
 * @returns The decision function, which rethrows the error of a failed step.
 */
export function useDecideProjectChangeRequest({ accessToken, teamId, projectId }: ProjectChangeRequestDecisionScope) {
  const { mutate } = useSWRConfig()
  // Decisions whose outcome is unknown, by entry key. The log shares this hook across its rows, so
  // deciding another request must not drop one still waiting to be sent again.
  const pendingDecisions = useRef(new Map<string, PendingDecision>())
  return useCallback(async (
    entry: ProjectRaidEntry,
    outcome: ProjectRaidChangeDecisionOutcome,
    options: ProjectChangeRequestDecisionOptions,
  ) => {
    if (!accessToken || !teamId) return
    // The cascade can reach successors in other Projects and Teams, which are added as the
    // previews report them.
    const affected: AffectedScopes = { teamIds: new Set([teamId]), projectIds: new Set([projectId]) }
    /** Revalidates the views the decision may have changed. */
    const refresh = () => Promise.all([
      mutate(projectRaidLogKey(accessToken, teamId, projectId)),
      mutate(createDecisionRefreshFilter(accessToken, teamId, projectId, affected)),
    ])
    const entryKey = JSON.stringify([teamId, projectId, entry.id, entry.revision])
    // A decision whose outcome is unknown is sent again as it was, with its own outcome, before
    // any date change or baseline capture runs, so a lost response neither repeats them nor
    // changes the plan of a request that may already be rejected. A different outcome can be
    // chosen only once the server has answered the retained one.
    let attempt = pendingDecisions.current.get(entryKey)
    if (attempt === undefined) {
      let baselineId: string | undefined
      let expectedRevision = entry.revision
      try {
        if (outcome === 'approved') {
          // The hold refuses a request someone else has since edited, decided, or closed, and keeps
          // others from rejecting or editing it until the decision, so no rejection can land
          // after its dates have moved.
          /**
           * Takes or renews the hold at the revision last seen. Renewing before each further round
           * and before the capture keeps the hold from expiring mid-approval, and a refused renewal
           * stops the approval before anything else moves.
           */
          const renewHold = async () => {
            const held = await holdProjectRaidChangeRequest(
              accessToken, teamId, projectId, entry.id, { expectedRevision }, createMutationRequestContext(),
            )
            expectedRevision = held.entry.revision
          }
          await renewHold()
          await applyScheduleChanges(accessToken, teamId, projectId, entry.scheduleChanges ?? [], affected, renewHold)
          if (options.replaceBaseline) {
            await renewHold()
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
          expectedRevision,
          outcome,
          ...(baselineId === undefined ? {} : { baselineId }),
        },
        context: createMutationRequestContext(),
      }
      pendingDecisions.current.set(entryKey, attempt)
    }
    let decided: ProjectRaidEntry
    try {
      decided = (await decideProjectRaidChangeRequest(
        accessToken, teamId, projectId, entry.id, attempt.request, attempt.context,
      )).entry
    } catch (error) {
      if (error instanceof ProjectDirectoryApiError && error.status < 500) {
        forgetDecision(pendingDecisions.current, attempt)
      }
      void refresh()
      throw error
    }
    forgetDecision(pendingDecisions.current, attempt)
    // The closed entry is shown before the log reloads, so a failed reload cannot leave the
    // request open with its approval controls enabled.
    await mutate<ProjectRaidLogResponse>(
      projectRaidLogKey(accessToken, teamId, projectId),
      (current) => current === undefined ? current : replaceLogEntry(current, decided),
      { revalidate: false },
    )
    await refresh()
  }, [accessToken, mutate, projectId, teamId])
}
