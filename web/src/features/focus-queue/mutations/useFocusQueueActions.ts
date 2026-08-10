import type {
  FocusItem,
  FocusPolicyOverrides,
  FocusPolicyTarget,
  FocusQueueResponse,
  WorkItemScheduleChangePreview,
  WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import { useCallback, useRef, useState } from 'react'
import type { KeyedMutator } from 'swr'
import { useSWRConfig } from 'swr'
import {
  confirmTeamIssueSchedule,
  previewTeamIssueSchedule,
  updateTeamIssue,
} from '../../../issues/api/workItems'
import { createMutationRequestRunner } from '../../../shared/api/mutationHeaders'
import {
  updateFocusPolicy,
  updateFocusSnooze,
  updateFocusWatch,
} from '../api/focusQueue'
import {
  isFocusAffectedCacheKey,
  isFocusMutationConflict,
  revalidateFocusCachesOnConflict,
  type FocusCacheRevalidationScope,
} from './focusCacheRevalidation'

const focusOnlyCacheRevalidationScope: FocusCacheRevalidationScope = {
  includePlanning: false,
  projectIds: [],
  workItems: [],
}

/** Queue mutations that can independently report pending state. */
export type FocusQueueActionId =
  | 'assign'
  | 'complete'
  | 'policy'
  | 'schedule'
  | 'snooze'
  | 'status'
  | 'watch'

/** Feedback retained after a successful snooze so the user can undo it. */
export type FocusQueueSnoozeFeedback = {
  /** Item returned after the snooze mutation. */
  item: FocusItem
  /** Wake time applied by the successful mutation. */
  snoozedUntil: string | null
  /** Wake time observed before the mutation. */
  previousSnoozedUntil: string | null
}

/** Error category shown after a failed non-policy queue action. */
export type FocusQueueMutationError = 'conflict' | 'failure'

/** Inputs required by the route-scoped Focus mutation controller. */
export type UseFocusQueueActionsOptions = {
  /** Session bearer token used by Focus and Work Item APIs. */
  accessToken?: string
  /** Applies enterprise-session policy to authenticated requests. */
  guardAuthenticatedRequest: <Result>(request: Promise<Result>) => Promise<Result>
  /** Revalidates the authoritative Focus queue snapshot. */
  mutateFocusQueue: KeyedMutator<FocusQueueResponse>
}

/** Actions and transient feedback consumed by the Focus queue view. */
export type FocusQueueMutationController = {
  /** Assigns one Work Item to the current queue viewer. */
  assignToViewer: (item: FocusItem, viewerMemberKey: string) => Promise<void>
  /** Completes one Work Item through its resolved completed workflow status. */
  complete: (item: FocusItem, completedStatusId: string) => Promise<void>
  /** Confirms a previously previewed schedule change. */
  confirmSchedule: (
    item: FocusItem,
    operation: WorkItemScheduleOperation,
    preview: WorkItemScheduleChangePreview,
  ) => Promise<void>
  /** Latest non-policy Focus action failure when present. */
  error?: FocusQueueMutationError
  /** Returns whether one item action is currently in flight. */
  isPending: (itemId: string, action: FocusQueueActionId) => boolean
  /** Latest successful snooze available for Undo. */
  snoozeFeedback?: FocusQueueSnoozeFeedback
  /** Requests a server-authoritative schedule impact preview. */
  previewSchedule: (
    item: FocusItem,
    operation: WorkItemScheduleOperation,
  ) => Promise<WorkItemScheduleChangePreview>
  /** Removes the latest mutation error notice. */
  clearError: () => void
  /** Removes the latest snooze feedback without changing server state. */
  dismissSnoozeFeedback: () => void
  /** Changes one canonical Work Item workflow status. */
  updateStatus: (item: FocusItem, workflowStatusId: string) => Promise<void>
  /** Whether the latest policy replacement failed. */
  policyError: boolean
  /** Replaces one authorized personal or Team Focus policy layer. */
  updatePolicy: (
    target: FocusPolicyTarget,
    expectedVersion: number,
    overrides: FocusPolicyOverrides,
  ) => Promise<void>
  /** Snoozes or unsnoozes one Focus item. */
  updateSnooze: (item: FocusItem, snoozedUntil: string | null) => Promise<void>
  /** Changes one Focus item's watch state. */
  updateWatching: (item: FocusItem, watching: boolean) => Promise<void>
  /** Restores the snooze state that preceded the latest successful change. */
  undoSnooze: () => Promise<void>
}

/**
 * Owns revision-bound Focus and canonical Work Item mutations for the Focus route.
 *
 * @param options - Authentication guard and Focus cache ownership.
 * @returns Queue action callbacks, pending state, errors, and snooze Undo feedback.
 */
export function useFocusQueueActions({
  accessToken,
  guardAuthenticatedRequest,
  mutateFocusQueue,
}: UseFocusQueueActionsOptions): FocusQueueMutationController {
  const { mutate: mutateSWR } = useSWRConfig()
  const mutationRunnerRef = useRef<ReturnType<typeof createMutationRequestRunner> | null>(null)
  if (mutationRunnerRef.current === null) {
    mutationRunnerRef.current = createMutationRequestRunner()
  }
  const mutationRunner = mutationRunnerRef.current
  const pendingKeysRef = useRef(new Set<string>())
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set())
  const [failedAction, setFailedAction] = useState<{
    /** Action that failed. */
    action: FocusQueueActionId
    /** User-facing failure category. */
    kind: FocusQueueMutationError
  }>()
  const [snoozeFeedback, setSnoozeFeedback] = useState<FocusQueueSnoozeFeedback>()

  /** Revalidates Focus and every loaded canonical projection affected by one action. */
  const refreshAffectedCaches = useCallback(async (
    scope: FocusCacheRevalidationScope,
  ) => {
    await Promise.all([
      mutateFocusQueue(),
      mutateSWR(
        (key) => isFocusAffectedCacheKey(key, scope),
        undefined,
        { revalidate: true },
      ),
    ])
  }, [mutateFocusQueue, mutateSWR])

  /** Runs one item action once while publishing pending and failure state. */
  const runItemAction = useCallback(async <Result,>(
    itemId: string,
    action: FocusQueueActionId,
    conflictScope: FocusCacheRevalidationScope,
    request: () => Promise<Result>,
  ): Promise<Result | undefined> => {
    const pendingKey = createPendingKey(itemId, action)
    if (!accessToken || pendingKeysRef.current.has(pendingKey)) return undefined

    pendingKeysRef.current.add(pendingKey)
    setPendingKeys(new Set(pendingKeysRef.current))
    setFailedAction(undefined)
    try {
      return await request()
    } catch (error) {
      await revalidateFocusCachesOnConflict(
        error,
        () => refreshAffectedCaches(conflictScope),
      )
      setFailedAction({
        action,
        kind: isFocusMutationConflict(error) ? 'conflict' : 'failure',
      })
      throw error
    } finally {
      pendingKeysRef.current.delete(pendingKey)
      setPendingKeys(new Set(pendingKeysRef.current))
    }
  }, [accessToken, refreshAffectedCaches])

  /** Applies one canonical Work Item patch and refreshes every affected queue cache. */
  const updateWorkItem = useCallback(async (
    item: FocusItem,
    action: 'assign' | 'complete' | 'status',
    patch: { assigneeUserId?: string; workflowStatusId?: string },
  ): Promise<void> => {
    if (!accessToken) return
    const cacheScope = createFocusItemCacheRevalidationScope(item)
    await runItemAction(item.id, action, cacheScope, async () => {
      await guardAuthenticatedRequest(mutationRunner.run(
        `focus:${action}:${item.workItem.teamId}:${item.workItem.id}`,
        JSON.stringify([item.workItem.revision, patch]),
        (context) => updateTeamIssue(
          item.workItem.teamId,
          item.workItem.id,
          accessToken,
          { expectedRevision: item.workItem.revision, ...patch },
          context,
        ),
      ))
      await refreshAffectedCaches(cacheScope)
    })
  }, [
    accessToken,
    guardAuthenticatedRequest,
    mutationRunner,
    refreshAffectedCaches,
    runItemAction,
  ])

  /** Assigns the item to the viewer identifier authorized by the Focus response. */
  const assignToViewer = useCallback(async (
    item: FocusItem,
    viewerMemberKey: string,
  ): Promise<void> => {
    if (!item.capabilities.assign || !viewerMemberKey) return
    await updateWorkItem(item, 'assign', { assigneeUserId: viewerMemberKey })
  }, [updateWorkItem])

  /** Updates one Work Item workflow status through the canonical endpoint. */
  const updateStatus = useCallback(async (
    item: FocusItem,
    workflowStatusId: string,
  ): Promise<void> => {
    if (!item.capabilities.changeStatus || !workflowStatusId) return
    await updateWorkItem(item, 'status', { workflowStatusId })
  }, [updateWorkItem])

  /** Completes one item through the Team workflow status resolved by the route. */
  const complete = useCallback(async (
    item: FocusItem,
    completedStatusId: string,
  ): Promise<void> => {
    if (!item.capabilities.complete || !completedStatusId) return
    await updateWorkItem(item, 'complete', { workflowStatusId: completedStatusId })
  }, [updateWorkItem])

  /** Loads one dependency-aware schedule preview without changing server state. */
  const previewSchedule = useCallback(async (
    item: FocusItem,
    operation: WorkItemScheduleOperation,
  ): Promise<WorkItemScheduleChangePreview> => {
    if (!accessToken || !item.capabilities.schedule) {
      throw new Error('Focus schedule action is unavailable.')
    }
    const preview = await runItemAction(
      item.id,
      'schedule',
      createFocusItemCacheRevalidationScope(item),
      () => guardAuthenticatedRequest(previewTeamIssueSchedule(
          item.workItem.teamId,
          item.workItem.id,
          accessToken,
          { expectedRevision: item.workItem.revision, operation },
        )),
    )
    if (!preview) throw new Error('Focus schedule preview was not returned.')
    return preview
  }, [accessToken, guardAuthenticatedRequest, runItemAction])

  /** Confirms one unchanged schedule preview and refreshes all affected items. */
  const confirmSchedule = useCallback(async (
    item: FocusItem,
    operation: WorkItemScheduleOperation,
    preview: WorkItemScheduleChangePreview,
  ): Promise<void> => {
    if (
      !accessToken ||
      !item.capabilities.schedule ||
      preview.planningRevision === undefined ||
      preview.relationGraphRevision === undefined
    ) {
      throw new Error('Focus schedule confirmation is unavailable.')
    }
    const expectedPlanningRevision = preview.planningRevision
    const expectedRelationGraphRevision = preview.relationGraphRevision
    const cacheScope = createFocusScheduleCacheRevalidationScope(item, preview)
    await runItemAction(item.id, 'schedule', cacheScope, async () => {
      await guardAuthenticatedRequest(mutationRunner.run(
        `focus:schedule:${item.workItem.teamId}:${item.workItem.id}`,
        JSON.stringify([
          preview.expectedRevision,
          preview.evaluatedRevisions,
          preview.impacts,
          expectedPlanningRevision,
          expectedRelationGraphRevision,
          operation,
        ]),
        (context) => confirmTeamIssueSchedule(
          item.workItem.teamId,
          item.workItem.id,
          accessToken,
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
      await refreshAffectedCaches(cacheScope)
    })
  }, [
    accessToken,
    guardAuthenticatedRequest,
    mutationRunner,
    refreshAffectedCaches,
    runItemAction,
  ])

  /** Applies one Focus snooze change and retains its inverse for Undo. */
  const updateSnooze = useCallback(async (
    item: FocusItem,
    snoozedUntil: string | null,
  ): Promise<void> => {
    if (!accessToken || !item.capabilities.snooze) return
    await runItemAction(
      item.id,
      'snooze',
      createFocusItemCacheRevalidationScope(item),
      async () => {
        const response = await guardAuthenticatedRequest(mutationRunner.run(
          `focus:snooze:${item.workItem.teamId}:${item.workItem.id}`,
          JSON.stringify([item.version, snoozedUntil]),
          (context) => updateFocusSnooze(
            item.workItem.teamId,
            item.workItem.id,
            accessToken,
            { expectedVersion: item.version, snoozedUntil },
            context,
          ),
        ))
        setSnoozeFeedback({
          item: response.item,
          previousSnoozedUntil: item.snoozedUntil ?? null,
          snoozedUntil,
        })
        await mutateFocusQueue()
      },
    )
  }, [
    accessToken,
    guardAuthenticatedRequest,
    mutateFocusQueue,
    mutationRunner,
    runItemAction,
  ])

  /** Applies one Focus watch-state change through its versioned aggregate endpoint. */
  const updateWatching = useCallback(async (
    item: FocusItem,
    watching: boolean,
  ): Promise<void> => {
    if (!accessToken || !item.capabilities.watch) return
    await runItemAction(
      item.id,
      'watch',
      createFocusItemCacheRevalidationScope(item),
      async () => {
        await guardAuthenticatedRequest(mutationRunner.run(
          `focus:watch:${item.workItem.teamId}:${item.workItem.id}`,
          JSON.stringify([item.version, watching]),
          (context) => updateFocusWatch(
            item.workItem.teamId,
            item.workItem.id,
            accessToken,
            { expectedVersion: item.version, watching },
            context,
          ),
        ))
        await mutateFocusQueue()
      },
    )
  }, [
    accessToken,
    guardAuthenticatedRequest,
    mutateFocusQueue,
    mutationRunner,
    runItemAction,
  ])

  /** Replaces one authorized personal or Team policy layer and reloads server ranking. */
  const updatePolicy = useCallback(async (
    target: FocusPolicyTarget,
    expectedVersion: number,
    overrides: FocusPolicyOverrides,
  ): Promise<void> => {
    if (!accessToken) return
    const targetKey = target.type === 'user' ? 'user' : `team:${target.teamId}`
    await runItemAction('policy-editor', 'policy', focusOnlyCacheRevalidationScope, async () => {
      await guardAuthenticatedRequest(mutationRunner.run(
        `focus:policy:${targetKey}`,
        JSON.stringify([target, expectedVersion, overrides]),
        (context) => updateFocusPolicy(
          accessToken,
          { expectedVersion, overrides, target },
          context,
        ),
      ))
      await mutateFocusQueue()
    })
  }, [
    accessToken,
    guardAuthenticatedRequest,
    mutateFocusQueue,
    mutationRunner,
    runItemAction,
  ])

  /** Restores the snooze value observed immediately before the latest mutation. */
  const undoSnooze = useCallback(async (): Promise<void> => {
    if (!snoozeFeedback) return
    const feedback = snoozeFeedback
    setSnoozeFeedback(undefined)
    try {
      await updateSnooze(feedback.item, feedback.previousSnoozedUntil)
    } catch (error) {
      setSnoozeFeedback(feedback)
      throw error
    }
    setSnoozeFeedback(undefined)
  }, [snoozeFeedback, updateSnooze])

  return {
    assignToViewer,
    clearError: () => setFailedAction(undefined),
    complete,
    confirmSchedule,
    dismissSnoozeFeedback: () => setSnoozeFeedback(undefined),
    ...(failedAction !== undefined && failedAction.action !== 'policy'
      ? { error: failedAction.kind }
      : {}),
    isPending: (itemId, action) => pendingKeys.has(createPendingKey(itemId, action)),
    previewSchedule,
    policyError: failedAction?.action === 'policy',
    snoozeFeedback,
    undoSnooze,
    updatePolicy,
    updateSnooze,
    updateStatus,
    updateWatching,
  }
}

/** Creates one collision-free pending-state key. */
function createPendingKey(itemId: string, action: FocusQueueActionId): string {
  return `${itemId}\0${action}`
}

/** Creates the canonical cache scope for one direct Focus Work Item action. */
function createFocusItemCacheRevalidationScope(
  item: FocusItem,
): FocusCacheRevalidationScope {
  return {
    includePlanning: false,
    projectIds: item.workItem.assignedProjectId
      ? [item.workItem.assignedProjectId]
      : [],
    workItems: [{
      teamId: item.workItem.teamId,
      workItemId: item.workItem.id,
    }],
  }
}

/** Creates the cache scope for every direct and propagated schedule impact. */
function createFocusScheduleCacheRevalidationScope(
  item: FocusItem,
  preview: WorkItemScheduleChangePreview,
): FocusCacheRevalidationScope {
  const projectIds = new Set(preview.affectedProjects.map((project) => project.projectId))
  const workItems = new Map<string, FocusCacheRevalidationScope['workItems'][number]>()
  if (item.workItem.assignedProjectId) projectIds.add(item.workItem.assignedProjectId)
  workItems.set(JSON.stringify([item.workItem.teamId, item.workItem.id]), {
    teamId: item.workItem.teamId,
    workItemId: item.workItem.id,
  })
  for (const impact of preview.impacts) {
    workItems.set(JSON.stringify([impact.teamId, impact.workItemId]), {
      teamId: impact.teamId,
      workItemId: impact.workItemId,
    })
  }
  return {
    includePlanning: true,
    projectIds: Array.from(projectIds),
    workItems: Array.from(workItems.values()),
  }
}
