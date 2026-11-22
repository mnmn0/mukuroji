import { useCallback, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import type { TeamWorkItemKeyPrefixSettings } from '@mukuroji/contracts'
import { TeamIssuesApiError, updateTeamWorkItemKeyPrefix } from '../../issues/api'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { teamWorkItemKeyPrefixKey, useTeamWorkItemKeyPrefix } from '../queries/useTeamWorkItemKeyPrefix'

/** Outcome of the last prefix change shown to the viewer. */
export type TeamWorkItemKeyPrefixSaveResult = 'saved' | 'taken' | 'conflict' | 'error'

/** Save progress of one Team. */
type TeamSaveState = {
  /** Whether a change is in flight. */
  isSaving: boolean
  /** Outcome of the last finished change. */
  result?: TeamWorkItemKeyPrefixSaveResult
}

/** State and actions of one Team's key prefix setting. */
export type TeamWorkItemKeyPrefixController = {
  /** Loaded setting, when available. */
  settings?: TeamWorkItemKeyPrefixSettings
  /** Whether the setting is loading. */
  isLoading: boolean
  /** Whether the setting failed to load. */
  hasLoadError: boolean
  /** Whether a change of this Team is in flight. */
  isSaving: boolean
  /** Outcome of this Team's last finished change. */
  saveResult?: TeamWorkItemKeyPrefixSaveResult
  /** Reads the setting again. */
  retry: () => void
  /** Changes the prefix against the loaded one. */
  save: (keyPrefix: string) => void
}

/**
 * Reads and changes one Team's Work Item key prefix.
 *
 * A change stores its response under the cache key of the Team it was made for, so a change that
 * finishes after the viewer switched Teams never shows on another Team.
 *
 * @param accessToken - Session access token.
 * @param teamId - Selected Team ID.
 * @returns The setting and its actions.
 */
export function useTeamWorkItemKeyPrefixController(
  accessToken: string,
  teamId: string | undefined,
): TeamWorkItemKeyPrefixController {
  const { data, error, isLoading, mutate: reload } = useTeamWorkItemKeyPrefix(accessToken, teamId)
  const { mutate } = useSWRConfig()
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const [saveStates, setSaveStates] = useState<Readonly<Record<string, TeamSaveState>>>({})

  const save = useCallback((keyPrefix: string) => {
    if (!teamId || !data) return
    const savedTeamId = teamId
    const key = teamWorkItemKeyPrefixKey(accessToken, savedTeamId)
    const request = { keyPrefix, expectedKeyPrefix: data.keyPrefix ?? null }
    setSaveStates((states) => ({ ...states, [savedTeamId]: { isSaving: true } }))
    void (async () => {
      try {
        const saved = await mutationRunner.run(
          `work-item-key-prefix:${savedTeamId}`,
          JSON.stringify(request),
          (context) => updateTeamWorkItemKeyPrefix(savedTeamId, accessToken, request, context),
        )
        await mutate(key, saved, { revalidate: false })
        setSaveStates((states) => ({ ...states, [savedTeamId]: { isSaving: false, result: 'saved' } }))
      } catch (caught) {
        const code = caught instanceof TeamIssuesApiError ? caught.code : undefined
        const result: TeamWorkItemKeyPrefixSaveResult = code === 'WorkItemKeyPrefixTaken'
          ? 'taken'
          : code === 'WorkItemKeyPrefixChanged' ? 'conflict' : 'error'
        if (result === 'conflict') await mutate(key).catch(() => undefined)
        setSaveStates((states) => ({ ...states, [savedTeamId]: { isSaving: false, result } }))
      }
    })()
  }, [accessToken, data, mutate, mutationRunner, teamId])

  const saveState = teamId ? saveStates[teamId] : undefined
  return {
    ...(data ? { settings: data } : {}),
    isLoading,
    hasLoadError: Boolean(error),
    isSaving: saveState?.isSaving ?? false,
    ...(saveState?.result ? { saveResult: saveState.result } : {}),
    retry: () => { void reload() },
    save,
  }
}
