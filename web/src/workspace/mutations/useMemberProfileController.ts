import { useMemo } from 'react'
import { useSWRConfig } from 'swr'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { WorkspaceAccessApiError } from '../api/errors'
import { updateMemberProfile, type MemberProfile } from '../api/memberProfile'
import { isMemberProfileKey, memberProfileKey, useMemberProfile } from '../queries/useMemberProfile'

/** Signed-in member's profile together with its load state and name change. */
export type MemberProfileController = {
  /** Loaded profile, or undefined while it loads or after a failed load. */
  profile?: MemberProfile
  /** Whether the profile failed to load and none is cached. */
  loadFailed: boolean
  /** Loads the profile again. */
  retry: () => void
  /**
   * Saves a new display name; undefined removes it. Rejects with the API error on failure, after
   * reloading the profile when it changed elsewhere.
   */
  saveName: (name: string | undefined, expectedVersion: number) => Promise<void>
}

/**
 * Loads the signed-in member's profile and changes the display name.
 *
 * A saved name replaces the cached profile read with the token the save used, and reloads the
 * Workspace member list, which shows the name too. A token refreshed during the save has its own
 * cache entry, so the profile shown under that token is reloaded rather than overwritten with a
 * response read under another token. A conflict reloads the profile so the form shows the latest name.
 *
 * @param accessToken - Cognito access token.
 * @returns The profile controller.
 */
export function useMemberProfileController(accessToken: string): MemberProfileController {
  const { data, error, mutate } = useMemberProfile(accessToken)
  const { mutate: mutateCache } = useSWRConfig()
  const runner = useMemo(() => createMutationRequestRunner(), [])

  return {
    profile: data,
    loadFailed: Boolean(error) && !data,
    retry: () => void mutate(),
    saveName: async (name, expectedVersion) => {
      const input = { name: name ?? null, expectedVersion }
      try {
        const profile = await runner.run(
          'member-profile:name',
          JSON.stringify(input),
          (context) => updateMemberProfile(accessToken, input, context),
          // Only transport failures keep the idempotency key for a retry.
          (failure) => !(failure instanceof WorkspaceAccessApiError),
        )
        await mutateCache(memberProfileKey(accessToken), profile, { revalidate: false })
        void mutateCache((key) => isMemberProfileKey(key) && key[1] !== accessToken)
        void mutateCache(
          (key) => Array.isArray(key) && key[0] === 'workspace-access',
          undefined,
          { revalidate: true },
        )
      } catch (failure) {
        if (failure instanceof WorkspaceAccessApiError && failure.status === 409) void mutate()
        throw failure
      }
    },
  }
}
