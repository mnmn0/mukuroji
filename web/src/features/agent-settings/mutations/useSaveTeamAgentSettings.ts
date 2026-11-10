import type { AgentSettings, UpdateAgentSettingsRequest } from '@mukuroji/contracts'
import { useCallback, useRef, useState } from 'react'
import type { KeyedMutator } from 'swr'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
  type MutationRequestRunner,
} from '../../../shared/api/mutationHeaders'
import { updateTeamAgentSettings } from '../api/agentSettings'
import { AgentSettingsApiError } from '../api/errors'

/** Outcome of the latest Agent settings save, shown beside the save action. */
export type AgentSettingsSaveFeedback =
  | {
    /** The settings were saved. */
    kind: 'saved'
  }
  | {
    /** The settings changed since they were loaded; the operator must reload them. */
    kind: 'conflict'
  }
  | {
    /** The operator is not a manager of the Team. */
    kind: 'forbidden'
  }
  | {
    /** The server rejected a value. */
    kind: 'invalid'
    /** Server message that names the rejected value. */
    message: string
  }
  | {
    /** The save failed for another reason and can be retried. */
    kind: 'error'
  }

/** Inputs of the Agent settings save controller. */
export type UseSaveTeamAgentSettingsOptions = {
  /** Session access token of the operator. */
  accessToken: string
  /** Team whose settings are saved. */
  teamId: string
  /** Mutator of the Team's settings query, which receives the saved settings. */
  mutateSettings: KeyedMutator<AgentSettings>
}

/** Save action and its state for one Team's Agent settings. */
export type TeamAgentSettingsSave = {
  /** Whether a save is in flight. */
  isSaving: boolean
  /** Outcome of the latest save, if any. */
  feedback?: AgentSettingsSaveFeedback
  /** Clears the outcome after the operator edits again or switches Team. */
  clearFeedback: () => void
  /** Saves a full replacement and resolves with its outcome, or undefined when a save is already in flight. */
  save: (request: UpdateAgentSettingsRequest) => Promise<AgentSettingsSaveFeedback | undefined>
}

/**
 * Converts a failed save to the feedback the operator sees.
 *
 * @param error - Failure of the save request.
 * @returns Feedback for the failure.
 */
export function readAgentSettingsSaveFailure(error: unknown): AgentSettingsSaveFeedback {
  if (!(error instanceof AgentSettingsApiError)) return { kind: 'error' }
  if (error.status === 409) return { kind: 'conflict' }
  if (error.status === 403) return { kind: 'forbidden' }
  if (error.status === 400) return { kind: 'invalid', message: error.message }
  return { kind: 'error' }
}

/**
 * Returns whether a failed save may have reached the server, so a retry of the same body must reuse
 * its Idempotency-Key and replay the committed save instead of failing the revision check.
 *
 * @param error - Failure of the save request.
 * @returns Whether to keep the request context for a retry.
 */
export function shouldRetainAgentSettingsSaveContext(error: unknown): boolean {
  return !(error instanceof AgentSettingsApiError) || error.status >= 500
}

/**
 * Owns the revision-fenced save of one Team's Agent settings. Each new body gets a fresh
 * Idempotency-Key; retrying the identical body after a network failure reuses the previous one.
 *
 * @param options - Authentication, Team, and the settings query's mutator.
 * @returns Save action, pending state, and feedback.
 */
export function useSaveTeamAgentSettings({
  accessToken,
  mutateSettings,
  teamId,
}: UseSaveTeamAgentSettingsOptions): TeamAgentSettingsSave {
  const runnerRef = useRef<MutationRequestRunner | null>(null)
  if (runnerRef.current === null) runnerRef.current = createMutationRequestRunner()
  const runner = runnerRef.current
  const savingRef = useRef(false)
  const [isSaving, setIsSaving] = useState(false)
  const [feedback, setFeedback] = useState<AgentSettingsSaveFeedback>()

  const save = useCallback(async (
    request: UpdateAgentSettingsRequest,
  ): Promise<AgentSettingsSaveFeedback | undefined> => {
    if (savingRef.current) return undefined
    savingRef.current = true
    setIsSaving(true)
    setFeedback(undefined)
    try {
      const fingerprint = await createMutationFingerprint(accessToken, teamId, JSON.stringify(request))
      const saved = await runner.run(
        `agent-settings:${teamId}`,
        fingerprint,
        (context) => updateTeamAgentSettings(accessToken, teamId, request, context),
        shouldRetainAgentSettingsSaveContext,
      )
      await mutateSettings(saved, { revalidate: false })
      const outcome: AgentSettingsSaveFeedback = { kind: 'saved' }
      setFeedback(outcome)
      return outcome
    } catch (error) {
      const outcome = readAgentSettingsSaveFailure(error)
      setFeedback(outcome)
      return outcome
    } finally {
      savingRef.current = false
      setIsSaving(false)
    }
  }, [accessToken, mutateSettings, runner, teamId])

  return {
    clearFeedback: () => setFeedback(undefined),
    feedback,
    isSaving,
    save,
  }
}
