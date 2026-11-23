import type {
  CanonicalWorkItem,
  PlanningSnapshot,
  WorkspaceWorkItemListFilter,
  WorkItemScheduleChangePreview,
  WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import type { Key, ScopedMutator } from 'swr'
import {
  confirmTeamIssueSchedule,
  getTeamIssueDetail,
  previewTeamIssueSchedule,
  TeamIssuesApiError,
  type TeamIssueDetail,
} from '../../issues/api'
import { loadTeamIssues } from '../../issues/queries/scopedWorkItemLoader'
import { loadWorkspaceWorkItems } from '../../issues/queries/workspaceWorkItemLoader'
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
  /**
   * SWR cache mutator, used with the cache keys below. The keys are those of the render that
   * started the change, so a later Team or selection change cannot redirect a background write.
   */
  mutateCache: ScopedMutator
  /** Cache key of the Work Item list shown by the route; nothing is published without one. */
  tasksCacheKey: Key
  /** Which list the route reads, so a refresh after a confirmation reads the same rows. */
  listScope: WorkItemListScheduleScope
  /** Cache key of the selected Work Item detail, when the route shows one. */
  selectedDetailCacheKey?: Key
  /** Cache key of the Planning snapshot, when the route reads one. */
  planningCacheKey?: Key
  /** Reads the Work Item hierarchy again, whose summary rows roll up the changed dates. */
  refreshHierarchy?: () => Promise<unknown>
  /** Observes background refresh errors. */
  onBackgroundRefreshError: (error: unknown) => void
  /** Resolves localized fallback messages. */
  t: (key: MessageKey) => string
}

/** List a schedule route reads, and the Work Item whose detail it shows. */
export type WorkItemListScheduleScope =
  | {
      /** One Team's Work Item list. */
      kind: 'team'
      /** Team whose Work Items are listed. */
      teamId: string
      /** Whether archived Work Items are listed. */
      includeArchived: boolean
      /** Work Item whose detail the route shows, read with the list. */
      selectedIssueId?: string
    }
  | {
      /** A Workspace-wide list such as My Tasks. */
      kind: 'workspace'
      /** Whether archived Work Items are listed. */
      includeArchived: boolean
      /** Server-side filter of the list. */
      filter: WorkspaceWorkItemListFilter
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
  mutateCache,
  mutationRequestRunner,
  onBackgroundRefreshError,
  planningCacheKey,
  listScope,
  refreshHierarchy,
  selectedDetailCacheKey,
  t,
  tasksCacheKey,
}: WorkItemListScheduleMutationOptions): WorkItemListScheduleMutations {
  /** Throws the localized task mutation fallback when no session token is available. */
  const requireAccessToken = (): string => {
    if (!accessToken) throw new Error(t('tasks.action.updateError'))
    return accessToken
  }

  /** Reads the route's list from its endpoint; unlike SWR's `mutate()`, a failure rejects. */
  const readTasks = (token: string): Promise<CanonicalWorkItem[]> => listScope.kind === 'team'
    ? loadTeamIssues(listScope.teamId, token, listScope.includeArchived)
    : loadWorkspaceWorkItems(token, listScope.includeArchived, listScope.filter)
  /** Reads the detail the route shows, when it shows one. */
  const readSelectedDetail = async (token: string): Promise<TeamIssueDetail | undefined> =>
    listScope.kind === 'team' && listScope.selectedIssueId
      ? getTeamIssueDetail(listScope.teamId, listScope.selectedIssueId, token)
      : undefined

  /** Revalidates every cache that shows schedules after a stale preview or confirmation. */
  const revalidateAll = () => Promise.all([
    tasksCacheKey ? mutateCache(tasksCacheKey) : undefined,
    selectedDetailCacheKey ? mutateCache(selectedDetailCacheKey) : undefined,
    planningCacheKey ? mutateCache(planningCacheKey) : undefined,
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
    const preserveConfirmedTasks = async () => {
      if (!tasksCacheKey) return
      await mutateCache<CanonicalWorkItem[]>(
        tasksCacheKey,
        (currentTasks = []) => applyConfirmedSchedulesToTasks(currentTasks, response.workItems),
        { revalidate: false },
      )
    }
    /**
     * Reapplies a matching committed result to the selected detail, which the Team screen shows
     * in place of the list row; an older detail must not bring back the previous schedule.
     */
    const preserveConfirmedSelectedDetail = async () => {
      if (!selectedDetailCacheKey) return
      await mutateCache<TeamIssueDetail>(
        selectedDetailCacheKey,
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
    const refreshTasks = async () => {
      if (!tasksCacheKey) return
      await refreshScheduleConfirmationCache(
        () => guardEnterpriseSession(readTasks(token)),
        (tasks) => assertConfirmedScheduleRevisionsObserved(
          tasks,
          // A cascade can reach Work Items this list does not show, such as another person's.
          response.workItems.filter((item) => tasks.some((listed) =>
            listed.teamId === item.teamId && listed.id === item.id
          )),
          'Work Item list',
        ),
        (tasks) => mutateCache<CanonicalWorkItem[]>(
          tasksCacheKey,
          (currentTasks) => keepNewerCachedWorkItems(tasks, currentTasks),
          { revalidate: false },
        ),
      )
    }
    /** Fetches and publishes the selected detail only after it observes a matching commit. */
    const refreshSelectedDetail = async () => {
      if (!selectedDetailCacheKey) return
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
        (detail) => detail
          ? mutateCache<TeamIssueDetail>(
              selectedDetailCacheKey,
              (currentDetail) => currentDetail &&
                currentDetail.issue.teamId === detail.issue.teamId &&
                currentDetail.issue.id === detail.issue.id &&
                currentDetail.issue.revision > detail.issue.revision
                ? currentDetail
                : detail,
              { revalidate: false },
            )
          : Promise.resolve(),
      )
    }
    /** Fetches and publishes a complete, internally consistent Planning snapshot. */
    const refreshPlanning = async () => {
      if (!planningCacheKey) return
      await refreshScheduleConfirmationCache(
        () => guardEnterpriseSession(getPlanningSnapshot(token)),
        (planning) => assertConfirmedScheduleRevisionsObserved(
          planning.workItems,
          response.workItems,
          'Planning snapshot',
        ),
        (planning) => mutateCache<PlanningSnapshot>(
          planningCacheKey,
          // A snapshot is published whole, so one that misses a newer cached revision is dropped.
          (currentPlanning) => currentPlanning &&
            hasNewerCachedWorkItem(planning.workItems, currentPlanning.workItems)
            ? currentPlanning
            : planning,
          { revalidate: false },
        ),
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
      {
        // Summary rows are derived on the server, so the hierarchy is only read again.
        preserveConfirmedState: async () => undefined,
        refresh: async () => {
          await refreshHierarchy?.()
        },
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

/** Identity and revision of one Work Item, as list rows and Planning entries carry it. */
type RevisionedWorkItem = {
  /** Owning Team. */
  teamId: string
  /** Work Item ID within the Team. */
  id: string
  /** Revision the row was read at. */
  revision: number
}

/**
 * Returns a refreshed list in which rows the cache already holds at a newer revision are kept.
 *
 * Two confirmations can refresh at once; the first read must not roll back the second commit.
 *
 * @param refreshed - Rows read from the endpoint.
 * @param cached - Rows currently in the cache.
 * @returns The refreshed rows, each replaced by its cached row when that one is newer.
 */
function keepNewerCachedWorkItems(
  refreshed: CanonicalWorkItem[],
  cached: CanonicalWorkItem[] | undefined,
): CanonicalWorkItem[] {
  if (!cached) return refreshed
  const cachedByKey = new Map(cached.map((item) => [`${item.teamId}\0${item.id}`, item]))
  return refreshed.map((item) => {
    const cachedItem = cachedByKey.get(`${item.teamId}\0${item.id}`)
    return cachedItem && cachedItem.revision > item.revision ? cachedItem : item
  })
}

/**
 * Returns whether the cache holds any Work Item at a newer revision than a refreshed read.
 *
 * @param refreshed - Work Items read from the endpoint.
 * @param cached - Work Items currently in the cache.
 * @returns Whether publishing the read would roll a cached Work Item back.
 */
function hasNewerCachedWorkItem(
  refreshed: readonly RevisionedWorkItem[],
  cached: readonly RevisionedWorkItem[],
): boolean {
  const refreshedRevisions = new Map(refreshed.map((item) => [`${item.teamId}\0${item.id}`, item.revision]))
  return cached.some((item) => {
    const refreshedRevision = refreshedRevisions.get(`${item.teamId}\0${item.id}`)
    return refreshedRevision !== undefined && item.revision > refreshedRevision
  })
}
