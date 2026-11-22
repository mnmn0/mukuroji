import { useState } from 'react'
import { useSWRConfig } from 'swr'
import type {
  AddDirectoryTeamMemberInput,
  AddDirectoryTeamMemberResponse,
  UpdateDirectoryTeamProfileInput,
} from '@mukuroji/contracts'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import type { MessageKey } from '../../shared/i18n/i18n'
import { addDirectoryTeamMember, updateDirectoryTeamProfile } from '../api/directoryAdministration'
import { ProjectDirectoryApiError } from '../api/errors'
import { isDirectoryAdministrationKey } from '../queries/useDirectoryAdministration'

/** Team profile save and Team-wide member add, with their shared pending and error state. */
export type TeamProfileActions = {
  /** Whether a change is in flight. */
  pending: boolean
  /** Message of the last failed change. */
  errorMessageKey?: MessageKey
  /** Saves the description and leader; resolves to whether it succeeded. */
  saveProfile: (teamId: string, input: UpdateDirectoryTeamProfileInput) => Promise<boolean>
  /** Adds a member to every active Project of the Team; resolves to the result, or undefined. */
  addMember: (
    teamId: string,
    input: AddDirectoryTeamMemberInput,
  ) => Promise<AddDirectoryTeamMemberResponse | undefined>
}

/**
 * Runs the Team settings changes of a Workspace administrator, one at a time, and refreshes the
 * directory and Project member lists after each one.
 *
 * @param accessToken - Bearer token of the Workspace administrator.
 * @returns The pending and error state and the actions.
 */
export function useTeamProfileActions(accessToken: string): TeamProfileActions {
  const { mutate } = useSWRConfig()
  const [pending, setPending] = useState(false)
  const [errorMessageKey, setErrorMessageKey] = useState<MessageKey>()

  /**
   * Runs one change and refreshes the lists it affects.
   *
   * @param action - API call of the change.
   * @returns The change result, or undefined when it failed or another change is running.
   */
  const run = async <Result>(action: () => Promise<Result>): Promise<Result | undefined> => {
    if (pending) return undefined
    setPending(true)
    setErrorMessageKey(undefined)
    try {
      const result = await action()
      await Promise.all([mutate(isDirectoryAdministrationKey), mutate(isProjectMemberKey)])
      return result
    } catch (error) {
      setErrorMessageKey(readTeamProfileErrorKey(error))
      return undefined
    } finally {
      setPending(false)
    }
  }

  return {
    pending,
    errorMessageKey,
    saveProfile: async (teamId, input) => {
      const saved = await run(async () => {
        await updateDirectoryTeamProfile(accessToken, teamId, input, createMutationRequestContext())
        return true
      })
      return saved === true
    },
    addMember: (teamId, input) => run(
      () => addDirectoryTeamMember(accessToken, teamId, input, createMutationRequestContext()),
    ),
  }
}

/** Query key prefixes of the Project member lists that a Team-wide member add changes. */
const projectMemberKeyPrefixes = new Set([
  'project-members',
  'team-qualified-project-members',
  'workspace-team-project-members',
])

/**
 * Tells whether an SWR key belongs to a Project member list.
 *
 * @param key - SWR cache key.
 * @returns Whether the key is a Project member list key.
 */
function isProjectMemberKey(key: unknown): boolean {
  return Array.isArray(key) && projectMemberKeyPrefixes.has(String(key[0]))
}

/**
 * Chooses the message of a failed Team settings change.
 *
 * @param error - Failure raised by the API call.
 * @returns The message key shown in the panel.
 */
function readTeamProfileErrorKey(error: unknown): MessageKey {
  if (error instanceof ProjectDirectoryApiError) {
    if (error.code === 'WorkspaceMemberInactive') return 'projects.teamProfile.error.memberInactive'
    if (error.status === 409) return 'projects.administration.error.conflict'
  }
  return 'projects.administration.error.action'
}
