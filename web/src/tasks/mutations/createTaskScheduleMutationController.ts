import type {
  ConfirmedWorkItemSchedule,
  PlanningSnapshot,
  WorkItemScheduleChangePreview,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
  WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import type { KeyedMutator } from 'swr'
import type { CurrentUser } from '../../auth/api'
import {
  confirmTeamIssueSchedule,
  getProjectIssues,
  getTeamIssueDetail,
  previewTeamIssueSchedule,
  TeamIssuesApiError,
  type TeamIssueDetail,
} from '../../issues/api'
import { getPlanningSnapshot } from '../../planning/api/snapshot'
import type { PlanningAccessSnapshot } from '../../planning/model/permissions'
import { createWorkItemDependencyMutationController } from '../../planning/mutations/createWorkItemDependencyMutationController'
import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { WorkItemDependencyCreateDraft } from '../../work-items/model/workItemDependencies'
import type { CanonicalWorkItem } from '../api'
import { applyConfirmedSchedulesToTasks } from '../model/scheduleConfirmation'
import {
  refreshScheduleConfirmationCache,
  revalidateScheduleConfirmationCachesBestEffort,
} from './scheduleConfirmationCache'

/** Dependencies used by the Project task schedule and dependency mutation controller. */
export type TaskScheduleMutationControllerOptions = {
  /** Session bearer token used by Work Item and Planning APIs. */
  accessToken?: string
  /** Applies enterprise-session redirect policy to one API promise. */
  guardEnterpriseSession: <Result>(request: Promise<Result>) => Promise<Result>
  /** Retains idempotency context for retryable logical mutations. */
  mutationRequestRunner: MutationRequestRunner
  /** Project whose Work Item list cache is owned by the current route. */
  projectId: string
  /** Revalidates or updates the authoritative Planning snapshot cache. */
  mutatePlanning: KeyedMutator<PlanningSnapshot>
  /** Revalidates or updates the current Project Work Item cache. */
  mutateProjectTasks: KeyedMutator<CanonicalWorkItem[]>
  /** Revalidates or updates the selected Work Item detail cache. */
  mutateSelectedIssueDetail: KeyedMutator<TeamIssueDetail>
  /** Observes background refresh errors for enterprise-session redirects. */
  onBackgroundRefreshError: (error: unknown) => void
  /** Current user's Team and Project management scope. */
  planningAccess: PlanningAccessSnapshot
  /** Latest authoritative Planning snapshot. */
  planningSnapshot?: PlanningSnapshot
  /** Resolves localized fallback messages. */
  t: (key: MessageKey) => string
  /** Authenticated user whose endpoint authority is checked before mutations. */
  user?: CurrentUser | null
}

/** Schedule and dependency mutation callbacks consumed by the Project task page. */
export type TaskScheduleMutationController = {
  /** Confirms a revision-bound schedule preview and publishes every cascade result. */
  confirmScheduleChange: (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
    preview: WorkItemScheduleChangePreview,
  ) => Promise<CanonicalWorkItem>
  /** Creates one canonical Work Item schedule dependency. */
  createScheduleDependency: (input: WorkItemDependencyCreateDraft) => Promise<void>
  /** Deletes one canonical Work Item schedule dependency. */
  deleteScheduleDependency: (dependency: WorkItemScheduleDependency) => Promise<void>
  /** Requests a server-authoritative preview for one schedule operation. */
  previewScheduleChange: (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
  ) => Promise<WorkItemScheduleChangePreview>
  /** Updates one canonical Work Item schedule dependency rule. */
  updateScheduleDependency: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => Promise<void>
}

/**
 * Creates focused schedule-confirmation and dependency mutation orchestration for a task route.
 *
 * @param options - API authority, cache mutators, session policy, and revision context.
 * @returns Mutation callbacks that keep route pages free of transport and cache choreography.
 */
export function createTaskScheduleMutationController({
  accessToken,
  guardEnterpriseSession,
  mutatePlanning,
  mutateProjectTasks,
  mutateSelectedIssueDetail,
  mutationRequestRunner,
  onBackgroundRefreshError,
  planningAccess,
  planningSnapshot,
  projectId,
  t,
  user,
}: TaskScheduleMutationControllerOptions): TaskScheduleMutationController {
  const dependencyMutations = createWorkItemDependencyMutationController({
    accessToken,
    guardEnterpriseSession,
    mutatePlanning,
    mutationRequestRunner,
    planningAccess,
    planningSnapshot,
    t,
    user,
  })
  /** Throws the localized task mutation fallback when no session token is available. */
  const requireAccessToken = (): string => {
    if (!accessToken) throw new Error(t('tasks.action.updateError'))
    return accessToken
  }

  /** Validates one interactive schedule operation against its observed revision. */
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
        await Promise.all([mutateProjectTasks(), mutateSelectedIssueDetail()])
      }
      throw error
    }
  }

  /** Confirms the original operation against both Planning and relation graph revisions. */
  const confirmScheduleChange = async (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
    preview: WorkItemScheduleChangePreview,
  ): Promise<CanonicalWorkItem> => {
    const token = requireAccessToken()
    if (
      preview.planningRevision === undefined ||
      preview.relationGraphRevision === undefined
    ) {
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
      if (isSchedulePreviewStaleError(error)) {
        await Promise.all([
          mutateProjectTasks(),
          mutateSelectedIssueDetail(),
          mutatePlanning(),
        ])
      }
      throw error
    }

    const confirmedTask = response.workItems.find((item) =>
      item.teamId === task.teamId && item.id === task.id
    )
    if (!confirmedTask) throw new Error(t('tasks.action.updateError'))

    const updatedTask: CanonicalWorkItem = {
      ...task,
      assignedProjectId: confirmedTask.assignedProjectId,
      dueDate: confirmedTask.dueDate,
      revision: confirmedTask.revision,
      schedule: confirmedTask.schedule,
    }
    /** Reapplies every committed cascade result to the current Project task cache. */
    const preserveConfirmedProjectTasks = () => mutateProjectTasks(
      (currentTasks = []) => applyConfirmedSchedulesToTasks(
        currentTasks,
        response.workItems,
      ),
      { revalidate: false },
    )
    /** Reapplies a matching committed result to the selected Work Item detail cache. */
    const preserveConfirmedSelectedIssueDetail = () => mutateSelectedIssueDetail(
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
    /** Fetches and publishes the Project list only after it observes committed revisions. */
    const refreshProjectTasks = () => refreshScheduleConfirmationCache(
      () => guardEnterpriseSession(getProjectIssues(projectId, token, true)),
      (refreshedTasks) => assertConfirmedScheduleRevisionsObserved(
        refreshedTasks,
        response.workItems.filter((item) => item.assignedProjectId === projectId),
        'Project Work Item list',
      ),
      (refreshedTasks) => mutateProjectTasks(refreshedTasks, { revalidate: false }),
    )
    /** Fetches and publishes the selected detail only after it observes the direct commit. */
    const refreshSelectedIssueDetail = () => refreshScheduleConfirmationCache(
      () => guardEnterpriseSession(getTeamIssueDetail(task.teamId, task.id, token)),
      (refreshedDetail) => assertConfirmedScheduleRevisionsObserved(
        [refreshedDetail.issue],
        response.workItems.filter((item) =>
          item.teamId === task.teamId && item.id === task.id
        ),
        'selected Work Item detail',
      ),
      (refreshedDetail) => mutateSelectedIssueDetail(refreshedDetail, { revalidate: false }),
    )
    /** Fetches and publishes a complete internally consistent Planning snapshot. */
    const refreshPlanning = () => refreshScheduleConfirmationCache(
      () => guardEnterpriseSession(getPlanningSnapshot(token)),
      (refreshedPlanning) => assertConfirmedScheduleRevisionsObserved(
        refreshedPlanning.workItems,
        response.workItems,
        'Planning snapshot',
      ),
      (refreshedPlanning) => mutatePlanning(refreshedPlanning, { revalidate: false }),
    )

    void revalidateScheduleConfirmationCachesBestEffort([
      {
        preserveConfirmedState: preserveConfirmedProjectTasks,
        refresh: refreshProjectTasks,
      },
      {
        preserveConfirmedState: preserveConfirmedSelectedIssueDetail,
        refresh: refreshSelectedIssueDetail,
      },
      {
        // A partial Planning patch would mix new Work Items with stale summaries.
        preserveConfirmedState: async () => undefined,
        refresh: refreshPlanning,
      },
    ], onBackgroundRefreshError)

    return updatedTask
  }

  return {
    confirmScheduleChange,
    createScheduleDependency: dependencyMutations.create,
    deleteScheduleDependency: dependencyMutations.delete,
    previewScheduleChange,
    updateScheduleDependency: dependencyMutations.update,
  }
}

/**
 * Requires a GET projection to include every schedule revision committed by confirmation.
 *
 * @param currentItems - Items returned by one authoritative read endpoint.
 * @param confirmedSchedules - Committed items expected to be visible in that endpoint.
 * @param source - Human-readable endpoint name included in the diagnostic error.
 * @returns Nothing after every confirmed revision has been observed.
 */
export function assertConfirmedScheduleRevisionsObserved(
  currentItems: readonly { id: string; revision: number; teamId: string }[],
  confirmedSchedules: readonly ConfirmedWorkItemSchedule[],
  source: string,
): void {
  const currentRevisions = new Map(currentItems.map((item) => [
    createConfirmedScheduleKey(item.teamId, item.id),
    item.revision,
  ]))
  const hasEveryConfirmedRevision = confirmedSchedules.every((item) =>
    (currentRevisions.get(createConfirmedScheduleKey(item.teamId, item.id)) ?? -1) >= item.revision
  )
  if (!hasEveryConfirmedRevision) {
    throw new Error(`${source} has not observed the confirmed schedule revisions yet.`)
  }
}

/** Creates an unambiguous cache-local key for one Team-qualified Work Item. */
function createConfirmedScheduleKey(teamId: string, workItemId: string): string {
  return JSON.stringify([teamId, workItemId])
}

/** Returns whether a server conflict invalidates the currently displayed schedule preview. */
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
