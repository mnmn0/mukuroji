import type {
  CanonicalWorkItem,
  PlanningSnapshot,
  WorkItemScheduleChangePreview,
  WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import type { KeyedMutator } from 'swr'
import {
  confirmTeamIssueSchedule,
  previewTeamIssueSchedule,
  TeamIssuesApiError,
  type TeamIssueDetail,
} from '../../issues/api'
import { getPlanningSnapshot } from '../../planning/api/snapshot'
import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import type { MessageKey } from '../../shared/i18n/i18n'
import { applyConfirmedSchedulesToTasks } from '../model/scheduleConfirmation'
import { assertConfirmedScheduleRevisionsObserved } from './createTaskScheduleMutationController'
import {
  refreshScheduleConfirmationCache,
  revalidateScheduleConfirmationCachesBestEffort,
} from './scheduleConfirmationCache'

/** Dependencies of the schedule mutations used by the Team Work Item screen and My Tasks. */
export type WorkItemListScheduleMutationOptions = {
  /** Session bearer token used by the Work Item schedule API. */
  accessToken?: string
  /** Applies the enterprise-session redirect policy to one API promise. */
  guardEnterpriseSession: <Result>(request: Promise<Result>) => Promise<Result>
  /** Retains idempotency context for retryable logical mutations. */
  mutationRequestRunner: MutationRequestRunner
  /** Revalidates or updates the Work Item list shown by the route. */
  mutateTasks: KeyedMutator<CanonicalWorkItem[]>
  /**
   * Reads the route's Work Item list from its backing endpoint. The read rejects on failure, unlike
   * SWR's no-argument `mutate()`, so a failed refresh after a confirmation is retried and reported.
   */
  readTasks: (accessToken: string) => Promise<CanonicalWorkItem[]>
  /** Revalidates or updates the selected Work Item detail, when the route shows one. */
  mutateSelectedDetail?: KeyedMutator<TeamIssueDetail>
  /** Reads the selected Work Item detail from its endpoint; resolves nothing without a selection. */
  readSelectedDetail?: (accessToken: string) => Promise<TeamIssueDetail | undefined>
  /** Updates the Planning snapshot, when the route reads one. */
  mutatePlanning?: KeyedMutator<PlanningSnapshot>
  /** Observes background refresh errors. */
  onBackgroundRefreshError: (error: unknown) => void
  /** Resolves localized fallback messages. */
  t: (key: MessageKey) => string
}

/** Preview and confirmation callbacks for one Work Item list route. */
export type WorkItemListScheduleMutations = {
  /** Requests a server-authoritative preview for one schedule operation. */
  previewScheduleChange: (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
  ) => Promise<WorkItemScheduleChangePreview>
  /** Confirms a revision-bound preview and publishes every cascade result to the list. */
  confirmScheduleChange: (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
    preview: WorkItemScheduleChangePreview,
  ) => Promise<CanonicalWorkItem>
}

/**
 * Creates the schedule preview and confirmation of a route whose list is not windowed by Project.
 *
 * The Project route keeps its own controller because its list is read per Project and period.
 * The Team Work Item screen and My Tasks read one complete list, so a confirmation publishes the
 * committed schedules to that list, then revalidates it and restores the committed revisions in
 * case the revalidation read an older row.
 *
 * @param options - API authority, cache mutators, and session policy.
 * @returns Preview and confirmation callbacks.
 */
export function createWorkItemListScheduleMutations({
  accessToken,
  guardEnterpriseSession,
  mutatePlanning,
  mutateSelectedDetail,
  mutateTasks,
  mutationRequestRunner,
  onBackgroundRefreshError,
  readSelectedDetail,
  readTasks,
  t,
}: WorkItemListScheduleMutationOptions): WorkItemListScheduleMutations {
  /** Throws the localized task mutation fallback when no session token is available. */
  const requireAccessToken = (): string => {
    if (!accessToken) throw new Error(t('tasks.action.updateError'))
    return accessToken
  }

  /** Revalidates every cache that shows schedules after a stale preview or confirmation. */
  const revalidateAll = () => Promise.all([
    mutateTasks(),
    mutateSelectedDetail?.(),
    mutatePlanning?.(),
  ])

  /** Validates one schedule operation against the observed revision. */
  const previewScheduleChange = async (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
  ): Promise<WorkItemScheduleChangePreview> => {
    const token = requireAccessToken()
    try {
      return await guardEnterpriseSession(previewTeamIssueSchedule(
        task.teamId,
        task.id,
        token,
        { expectedRevision: task.revision, operation },
      ))
    } catch (error) {
      if (error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict') {
        await revalidateAll()
      }
      throw error
    }
  }

  /** Confirms the original operation against the revisions its preview evaluated. */
  const confirmScheduleChange = async (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
    preview: WorkItemScheduleChangePreview,
  ): Promise<CanonicalWorkItem> => {
    const token = requireAccessToken()
    if (preview.planningRevision === undefined || preview.relationGraphRevision === undefined) {
      throw new Error(t('tasks.action.updateError'))
    }
    const expectedPlanningRevision = preview.planningRevision
    const expectedRelationGraphRevision = preview.relationGraphRevision

    let response: Awaited<ReturnType<typeof confirmTeamIssueSchedule>>
    try {
      response = await guardEnterpriseSession(mutationRequestRunner.run(
        `issue:schedule:confirm:${task.teamId}:${task.id}`,
        JSON.stringify([
          preview.expectedRevision,
          preview.evaluatedRevisions,
          preview.impacts,
          expectedPlanningRevision,
          expectedRelationGraphRevision,
          operation,
        ]),
        (context) => confirmTeamIssueSchedule(
          task.teamId,
          task.id,
          token,
          {
            confirmed: true,
            expectedEvaluatedRevisions: preview.evaluatedRevisions,
            expectedImpacts: preview.impacts,
            expectedPlanningRevision,
            expectedRelationGraphRevision,
            expectedRevision: preview.expectedRevision,
            operation,
          },
          context,
        ),
      ))
    } catch (error) {
      if (isSchedulePreviewStaleError(error)) await revalidateAll()
      throw error
    }

    const confirmedTask = response.workItems.find((item) =>
      item.teamId === task.teamId && item.id === task.id
    )
    if (!confirmedTask) throw new Error(t('tasks.action.updateError'))

    /** Reapplies every committed cascade result to the list cache. */
    const preserveConfirmedTasks = () => mutateTasks(
      (currentTasks = []) => applyConfirmedSchedulesToTasks(currentTasks, response.workItems),
      { revalidate: false },
    )
    /**
     * Reapplies a matching committed result to the selected detail, which the Team screen shows
     * in place of the list row; an older detail must not bring back the previous schedule.
     */
    const preserveConfirmedSelectedDetail = async () => {
      await mutateSelectedDetail?.(
        (currentDetail) => {
          if (!currentDetail) return currentDetail
          const [updatedIssue] = applyConfirmedSchedulesToTasks(
            [currentDetail.issue],
            response.workItems,
          )
          return updatedIssue ? { ...currentDetail, issue: updatedIssue } : currentDetail
        },
        { revalidate: false },
      )
    }
    /** Fetches and publishes the list only after it observes the committed revisions it lists. */
    const refreshTasks = () => refreshScheduleConfirmationCache(
      () => guardEnterpriseSession(readTasks(token)),
      (tasks) => assertConfirmedScheduleRevisionsObserved(
        tasks,
        // A cascade can reach Work Items this list does not show, such as another person's.
        response.workItems.filter((item) => tasks.some((listed) =>
          listed.teamId === item.teamId && listed.id === item.id
        )),
        'Work Item list',
      ),
      (tasks) => mutateTasks(tasks, { revalidate: false }),
    )
    /** Fetches and publishes the selected detail only after it observes a matching commit. */
    const refreshSelectedDetail = async () => {
      if (!readSelectedDetail || !mutateSelectedDetail) return
      await refreshScheduleConfirmationCache(
        () => guardEnterpriseSession(readSelectedDetail(token)),
        (detail) => {
          if (!detail) return
          assertConfirmedScheduleRevisionsObserved(
            [detail.issue],
            response.workItems.filter((item) =>
              item.teamId === detail.issue.teamId && item.id === detail.issue.id
            ),
            'selected Work Item detail',
          )
        },
        (detail) => detail ? mutateSelectedDetail(detail, { revalidate: false }) : Promise.resolve(),
      )
    }
    /** Fetches and publishes a complete, internally consistent Planning snapshot. */
    const refreshPlanning = async () => {
      if (!mutatePlanning) return
      await refreshScheduleConfirmationCache(
        () => guardEnterpriseSession(getPlanningSnapshot(token)),
        (planning) => assertConfirmedScheduleRevisionsObserved(
          planning.workItems,
          response.workItems,
          'Planning snapshot',
        ),
        (planning) => mutatePlanning(planning, { revalidate: false }),
      )
    }
    void revalidateScheduleConfirmationCachesBestEffort([
      {
        preserveConfirmedState: preserveConfirmedTasks,
        refresh: refreshTasks,
      },
      {
        preserveConfirmedState: preserveConfirmedSelectedDetail,
        refresh: refreshSelectedDetail,
      },
      {
        // A partial Planning patch would mix new Work Items with stale summaries.
        preserveConfirmedState: async () => undefined,
        refresh: refreshPlanning,
      },
    ], onBackgroundRefreshError)

    return {
      ...task,
      assignedProjectId: confirmedTask.assignedProjectId,
      dueDate: confirmedTask.dueDate,
      revision: confirmedTask.revision,
      schedule: confirmedTask.schedule,
    }
  }

  return { confirmScheduleChange, previewScheduleChange }
}

/**
 * Returns whether a server conflict invalidates the displayed schedule preview.
 *
 * @param error - Failure raised by the confirmation request.
 * @returns Whether the caches that showed the preview should be revalidated.
 */
function isSchedulePreviewStaleError(error: unknown): boolean {
  if (!(error instanceof TeamIssuesApiError)) return false
  return error.code === 'WorkItemRevisionConflict' ||
    error.code === 'WorkItemSchedulePreviewStale' ||
    error.code === 'PlanningRevisionConflict' ||
    error.code === 'PlanningWorkItemChanged' ||
    error.code === 'WorkItemRelationGraphConflict' ||
    error.code === 'WorkItemAuthorizationChanged' ||
    error.code === 'WorkItemScheduleDependencyConflict' ||
    error.code === 'WorkItemScheduleCascadeConflict'
}
