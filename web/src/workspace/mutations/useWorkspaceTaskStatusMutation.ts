import type {
  ResolvedWorkItemConfiguration,
} from '@mukuroji/contracts'
import { useCallback, useRef, useState } from 'react'
import type { KeyedMutator } from 'swr'
import { TeamIssuesApiError } from '../../issues/api'
import { updateWorkspaceTaskRemote } from '../../issues/mutations/updateWorkspaceTask'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { CanonicalWorkItem } from '../../tasks/api'
import {
  createWorkspaceTaskKey,
  replaceWorkspaceTask,
  updateWorkspaceTaskStatus,
} from '../../work-items/model/workspaceWorkItems'

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
  /** Moves a Work Item to a validated workflow status and returns its persisted snapshot. */
  moveTaskStatus?: (
    task: CanonicalWorkItem,
    workflowStatusId: string,
  ) => Promise<CanonicalWorkItem | undefined>
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
    const nextStatus = configuration?.workflow.statuses.find(
      (status) => status.id === workflowStatusId,
    )

    if (!nextStatus) {
      return
    }

    const taskKey = createWorkspaceTaskKey(canonicalTask)

    if (pendingTaskMoveKeysRef.current.has(taskKey)) {
      return
    }

    setErrorMessage(undefined)
    pendingTaskMoveKeysRef.current.add(taskKey)
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
      await mutateWorkItems(
        (currentTasks = nextTasks) => replaceWorkspaceTask(currentTasks, canonicalTask),
        { revalidate: false },
      )

      if (error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict') {
        setErrorMessage(t('workspace.myTasks.conflict'))
        await mutateWorkItems()
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
