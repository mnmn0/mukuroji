import type {
  CanonicalWorkItem,
  ResolvedWorkItemConfiguration,
} from '@mukuroji/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyedMutator } from 'swr'
import { TeamIssuesApiError } from '../../issues/api'
import {
  confirmParentCompletion,
  confirmParentCompletionInBrowser,
} from '../../issues/mutations/confirmParentCompletion'
import {
  CANCELLED_TEAM_ISSUE_UPDATE,
  type CancelledTeamIssueUpdate,
} from '../../issues/model/teamIssueUpdateOutcome'
import { updateWorkspaceTaskRemote } from '../../issues/mutations/updateWorkspaceTask'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createWorkspaceTaskKey,
  replaceWorkspaceTask,
  updateWorkspaceTaskStatus,
} from '../../work-items/model/workspaceWorkItems'
import { resolveWorkItemTypeWorkflow } from '../../work-items/model/workItemDisplay'

/**
 * Inputs for the My Tasks status mutation controller.
 */
export type UseWorkspaceTaskStatusMutationOptions = {
  /** Access token used to update canonical Work Items. */
  accessToken?: string
  /** Whether the current user may mutate Workspace content. */
  enabled: boolean
  /** Team configuration map used to validate target statuses. */
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Wrapper that applies Enterprise session policy to authenticated requests. */
  guardAuthenticatedRequest: <Result>(request: Promise<Result>) => Promise<Result>
  /** SWR mutator for the canonical Workspace Work Item cache. */
  mutateWorkItems: KeyedMutator<CanonicalWorkItem[]>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Current canonical Workspace Work Item projection. */
  tasks: readonly CanonicalWorkItem[]
}

/**
 * Return value for the My Tasks status mutation controller.
 */
export type WorkspaceTaskStatusMutationController = {
  /** Latest user-facing optimistic update error message. */
  errorMessage?: string
  /**
   * Moves a Work Item to a validated workflow status and returns its persisted snapshot, the
   * cancelled outcome when the person declined the parent completion warning, or `undefined` when
   * the move was not applied.
   */
  moveTaskStatus?: (
    task: CanonicalWorkItem,
    workflowStatusId: string,
  ) => Promise<CanonicalWorkItem | CancelledTeamIssueUpdate | undefined>
}

/**
 * Owns optimistic status updates for the My Tasks route.
 *
 * @param options - Authentication, permission, cache, configuration, and task inputs.
 * @returns A route-scoped mutation callback and its latest error message.
 */
export function useWorkspaceTaskStatusMutation({
  accessToken,
  configurationsByTeam,
  enabled,
  guardAuthenticatedRequest,
  mutateWorkItems,
  t,
  tasks,
}: UseWorkspaceTaskStatusMutationOptions): WorkspaceTaskStatusMutationController {
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const pendingTaskMoveKeysRef = useRef(new Set<string>())
  const [errorMessage, setErrorMessage] = useState<string>()
  // Latest list, read after the parent completion warning, which can stay open while the list
  // refreshes.
  const latestTasksRef = useRef(tasks)
  useEffect(() => {
    latestTasksRef.current = tasks
  }, [tasks])

  const moveTaskStatus = useCallback(async (
    task: CanonicalWorkItem,
    workflowStatusId: string,
  ) => {
    const canonicalTask = tasks.find(
      (candidate) => createWorkspaceTaskKey(candidate) === createWorkspaceTaskKey(task),
    )

    if (
      !enabled ||
      !accessToken ||
      !canonicalTask ||
      canonicalTask.workflowStatusId === workflowStatusId
    ) {
      return
    }

    const configuration = configurationsByTeam[canonicalTask.teamId]?.configuration
    const nextStatus = resolveWorkItemTypeWorkflow(
      configuration,
      canonicalTask.workItemTypeId,
    )?.statuses.find((status) => status.id === workflowStatusId)

    if (!nextStatus) {
      return
    }

    const taskKey = createWorkspaceTaskKey(canonicalTask)

    if (pendingTaskMoveKeysRef.current.has(taskKey)) {
      return
    }
    // Hold the move while the person decides, so a second drag cannot start another one.
    pendingTaskMoveKeysRef.current.add(taskKey)
    const confirmed = await confirmParentCompletion({
      workItem: canonicalTask,
      nextStatusCategory: nextStatus.category,
      configuration,
      accessToken,
      confirm: (openChildCount) => confirmParentCompletionInBrowser(t, openChildCount),
    })
    if (!confirmed) {
      pendingTaskMoveKeysRef.current.delete(taskKey)
      return CANCELLED_TEAM_ISSUE_UPDATE
    }
    // A newer revision that arrived while the person decided would make this request stale, so
    // it is reported as the conflict the server would return instead of being sent.
    const latestTask = latestTasksRef.current.find((candidate) =>
      createWorkspaceTaskKey(candidate) === taskKey
    )
    if (!latestTask || latestTask.revision !== canonicalTask.revision) {
      pendingTaskMoveKeysRef.current.delete(taskKey)
      setErrorMessage(t('workspace.myTasks.conflict'))
      throw new TeamIssuesApiError(409, t('workspace.myTasks.conflict'), 'WorkItemRevisionConflict')
    }

    setErrorMessage(undefined)
    const nextTasks = updateWorkspaceTaskStatus(
      tasks,
      canonicalTask,
      nextStatus,
      canonicalTask.workflowStatusId,
    )

    try {
      await mutateWorkItems(
        (currentTasks = [...tasks]) => updateWorkspaceTaskStatus(
          currentTasks,
          canonicalTask,
          nextStatus,
          canonicalTask.workflowStatusId,
        ),
        { revalidate: false },
      )
      const updatedTask = await guardAuthenticatedRequest(mutationRequestRunner.run(
        `task:status:${taskKey}`,
        JSON.stringify([canonicalTask.revision, workflowStatusId]),
        (context) => updateWorkspaceTaskRemote(
          canonicalTask,
          accessToken,
          workflowStatusId,
          context,
        ),
      ))

      await mutateWorkItems(
        (currentTasks = nextTasks) => replaceWorkspaceTask(currentTasks, updatedTask),
        { revalidate: false },
      )
      return updatedTask
    } catch (error) {
      // Only this attempt's optimistic status is undone, and only while the row still shows it;
      // a newer row read meanwhile is kept as it is.
      await mutateWorkItems(
        (currentTasks = nextTasks) => currentTasks.some((candidate) =>
          createWorkspaceTaskKey(candidate) === taskKey &&
          candidate.revision === canonicalTask.revision &&
          candidate.workflowStatusId === workflowStatusId
        )
          ? replaceWorkspaceTask(currentTasks, canonicalTask)
          : currentTasks,
        { revalidate: false },
      )

      if (error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict') {
        setErrorMessage(t('workspace.myTasks.conflict'))
        await mutateWorkItems()
      } else if (error instanceof TeamIssuesApiError && error.code === 'WorkItemOpenChildren') {
        setErrorMessage(t('issues.error.openChildren'))
      } else {
        setErrorMessage(t('workspace.myTasks.moveError'))
      }

      throw error
    } finally {
      pendingTaskMoveKeysRef.current.delete(taskKey)
    }
  }, [
    accessToken,
    configurationsByTeam,
    enabled,
    guardAuthenticatedRequest,
    mutateWorkItems,
    mutationRequestRunner,
    t,
    tasks,
  ])

  return {
    errorMessage,
    moveTaskStatus: enabled ? moveTaskStatus : undefined,
  }
}
