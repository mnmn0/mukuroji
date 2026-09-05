import type { KeyedMutator } from 'swr'
import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import { createTeamIssue } from '../../issues/api/workItems'
import type { CreateWorkItemInput, CanonicalWorkItem } from '../api/tasks'

/** Dependencies used by the Project task create mutation controller. */
export type TaskCreateMutationControllerOptions = {
  /** Session bearer token used by the Work Item API. */
  accessToken?: string
  /** Applies the page's enterprise-session policy to the create request. */
  guardEnterpriseSession: <Result>(request: Promise<Result>) => Promise<Result>
  /** Project whose Work Item list cache is owned by the current route. */
  projectId: string
  /** Revalidates or updates the current Project Work Item cache. */
  mutateProjectTasks: KeyedMutator<CanonicalWorkItem[]>
  /** Retains idempotency context for one logical create mutation. */
  mutationRequestRunner: MutationRequestRunner
  /** Localized fallback used when the session token is unavailable. */
  createErrorMessage: string
}

/** Target identity used by one create request. */
export type TaskCreateMutationTarget = {
  /** Project that receives the created Work Item. */
  projectId: string
  /** Team that owns the created Work Item. */
  teamId: string
}

/** Result of a confirmed create, including a best-effort list refresh failure. */
export type TaskCreateMutationResult = {
  /** Work Item confirmed by the create endpoint. */
  task: CanonicalWorkItem
  /** List refresh failure after the create was already confirmed, when present. */
  refreshError?: unknown
}

/**
 * Creates the transport and cache choreography for one Project Work Item create.
 *
 * @param options - API authority, cache mutator, and idempotency dependencies.
 * @returns A create operation that preserves confirmed writes across refresh failures.
 */
export function createTaskMutationController({
  accessToken,
  createErrorMessage,
  guardEnterpriseSession,
  mutateProjectTasks,
  mutationRequestRunner,
  projectId,
}: TaskCreateMutationControllerOptions) {
  /** Creates one Work Item and preserves it in the current Project cache. */
  const createTask = async (
    input: CreateWorkItemInput,
    target: TaskCreateMutationTarget,
  ): Promise<TaskCreateMutationResult> => {
    if (!accessToken) throw new Error(createErrorMessage)

    const task = await guardEnterpriseSession(mutationRequestRunner.run(
      `issue:create:${target.teamId}:${target.projectId}`,
      JSON.stringify([target.teamId, target.projectId, input]),
      (context) => createTeamIssue(
        target.teamId,
        accessToken,
        {
          ...input,
          assignedProjectId: target.projectId,
        },
        context,
      ),
    ))

    let hasRefreshError = false
    let refreshError: unknown
    try {
      if (
        projectId === target.projectId &&
        task.assignedProjectId === target.projectId &&
        task.teamId === target.teamId
      ) {
        await mutateProjectTasks(
          (currentTasks = []) => {
            const existingIndex = currentTasks.findIndex((candidate) =>
              candidate.id === task.id && candidate.teamId === task.teamId,
            )
            if (existingIndex < 0) return [task, ...currentTasks]
            return currentTasks.map((candidate, index) => index === existingIndex ? task : candidate)
          },
          { revalidate: false },
        )
      }
      const refreshedTasks = await mutateProjectTasks()
      if (
        projectId === target.projectId &&
        task.assignedProjectId === target.projectId &&
        task.teamId === target.teamId &&
        Array.isArray(refreshedTasks) &&
        !refreshedTasks.some((candidate) =>
          candidate.id === task.id && candidate.teamId === task.teamId,
        )
      ) {
        await mutateProjectTasks(
          (currentTasks = []) => currentTasks.some((candidate) =>
            candidate.id === task.id && candidate.teamId === task.teamId,
          ) ? currentTasks : [task, ...currentTasks],
          { revalidate: false },
        )
      }
    } catch (error: unknown) {
      hasRefreshError = true
      refreshError = error
    }

    return !hasRefreshError
      ? { task }
      : { refreshError, task }
  }

  return { createTask }
}
