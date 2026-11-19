import { useState } from 'react'
import { useSWRConfig } from 'swr'
import type { DirectoryProjectTone } from '@mukuroji/contracts'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  renameDirectoryProject,
  renameDirectoryTeam,
  reorderDirectoryProjects,
  reorderDirectoryTeams,
  restoreDirectoryProject,
  restoreDirectoryTeam,
} from '../api/directoryAdministration'
import { ProjectDirectoryApiError } from '../api/errors'
import { useDirectoryAdministration } from '../queries/useDirectoryAdministration'
import { isProjectDirectoryKey } from '../queries/useProjectDirectory'

/** Directory administration query plus the rename, restore, and reorder actions. */
export type DirectoryAdministrationActions = {
  /** Every Team and Project, archived ones included. */
  query: ReturnType<typeof useDirectoryAdministration>
  /** Key of the row whose change is in flight. */
  pendingKey?: string
  /** Message of the last failed change. */
  errorMessageKey?: MessageKey
  /** Renames a Team; resolves to whether it succeeded. */
  renameTeam: (teamId: string, input: { nameJa: string; nameEn: string }) => Promise<boolean>
  /** Renames a Project or changes its color; resolves to whether it succeeded. */
  renameProject: (
    teamId: string,
    projectId: string,
    input: { nameJa: string; nameEn: string; tone: DirectoryProjectTone },
  ) => Promise<boolean>
  /** Stores a new order of every active Team. */
  reorderTeams: (teamIds: string[]) => Promise<boolean>
  /** Stores a new order of every active Project of a Team. */
  reorderProjects: (teamId: string, projectIds: string[]) => Promise<boolean>
  /** Restores an archived Team. */
  restoreTeam: (teamId: string) => Promise<boolean>
  /** Restores an archived Project. */
  restoreProject: (teamId: string, projectId: string) => Promise<boolean>
}

/**
 * Loads every Team and Project for administrators and runs their rename, restore, and reorder.
 *
 * One change runs at a time. After each change the administration list and the sidebar directory
 * are revalidated; a conflict with a concurrent change is reported separately so the panel can ask
 * the administrator to retry on the reloaded list.
 *
 * @param accessToken - Bearer token of the Workspace administrator.
 * @returns The query, the pending and error state, and the actions.
 */
export function useDirectoryAdministrationActions(
  accessToken: string,
): DirectoryAdministrationActions {
  const { mutate: mutateGlobal } = useSWRConfig()
  const query = useDirectoryAdministration(accessToken)
  const [pendingKey, setPendingKey] = useState<string>()
  const [errorMessageKey, setErrorMessageKey] = useState<MessageKey>()

  /**
   * Runs one change, then refreshes this list and the sidebar directory.
   *
   * @param key - Key of the row being changed.
   * @param action - API call of the change.
   * @returns Whether the change succeeded.
   */
  const run = async (key: string, action: () => Promise<void>) => {
    if (pendingKey) return false
    setPendingKey(key)
    setErrorMessageKey(undefined)
    try {
      await action()
      await Promise.all([query.mutate(), mutateGlobal(isProjectDirectoryKey)])
      return true
    } catch (error) {
      setErrorMessageKey(readDirectoryAdministrationErrorKey(error))
      await query.mutate()
      return false
    } finally {
      setPendingKey(undefined)
    }
  }

  return {
    query,
    pendingKey,
    errorMessageKey,
    renameTeam: (teamId, input) => run(
      `team:${teamId}`,
      () => renameDirectoryTeam(accessToken, teamId, input, createMutationRequestContext()),
    ),
    renameProject: (teamId, projectId, input) => run(
      `project:${teamId}:${projectId}`,
      () => renameDirectoryProject(
        accessToken,
        teamId,
        projectId,
        input,
        createMutationRequestContext(),
      ),
    ),
    reorderTeams: (teamIds) => run(
      'team-order',
      () => reorderDirectoryTeams(accessToken, teamIds, createMutationRequestContext()),
    ),
    reorderProjects: (teamId, projectIds) => run(
      `project-order:${teamId}`,
      () => reorderDirectoryProjects(accessToken, teamId, projectIds, createMutationRequestContext()),
    ),
    restoreTeam: (teamId) => run(
      `team:${teamId}`,
      () => restoreDirectoryTeam(accessToken, teamId, createMutationRequestContext()),
    ),
    restoreProject: (teamId, projectId) => run(
      `project:${teamId}:${projectId}`,
      () => restoreDirectoryProject(accessToken, teamId, projectId, createMutationRequestContext()),
    ),
  }
}

/**
 * Chooses the message of a failed directory change.
 *
 * @param error - Failure raised by the API call.
 * @returns The message key shown in the panel.
 */
function readDirectoryAdministrationErrorKey(error: unknown): MessageKey {
  if (!(error instanceof ProjectDirectoryApiError) || error.status !== 409) {
    return 'projects.administration.error.action'
  }
  return error.code === 'DirectoryArchiveCleanupPending'
    ? 'projects.administration.error.cleanupPending'
    : 'projects.administration.error.conflict'
}
