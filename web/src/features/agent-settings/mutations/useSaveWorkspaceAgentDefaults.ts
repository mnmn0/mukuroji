import type { UpdateWorkspaceAgentDefaultsRequest, WorkspaceAgentDefaults } from '@mukuroji/contracts'
import { useCallback, useRef, useState } from 'react'
import type { KeyedMutator } from 'swr'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
  type MutationRequestRunner,
} from '../../../shared/api/mutationHeaders'
import { updateWorkspaceAgentDefaults } from '../api/agentSettings'
import {
  readAgentSettingsSaveFailure,
  shouldRetainAgentSettingsSaveContext,
  type AgentSettingsSaveFeedback,
} from './useSaveTeamAgentSettings'

/** Inputs of the Workspace agent defaults save controller. */
export type UseSaveWorkspaceAgentDefaultsOptions = {
  /** Session access token of the Workspace administrator. */
  accessToken: string
  /** Mutator of the defaults query, which receives the saved defaults. */
  mutateDefaults: KeyedMutator<WorkspaceAgentDefaults>
}

/** Save action and its state for the Workspace agent defaults. */
export type WorkspaceAgentDefaultsSave = {
  /** Whether a save is in flight. */
  isSaving: boolean
  /** Outcome of the latest save, if any. */
  feedback?: AgentSettingsSaveFeedback
  /** Clears the outcome after the administrator edits again. */
  clearFeedback: () => void
  /** Saves a full replacement and resolves with its outcome, or undefined when a save is already in flight. */
  save: (request: UpdateWorkspaceAgentDefaultsRequest) => Promise<AgentSettingsSaveFeedback | undefined>
}

/**
 * Owns the revision-fenced save of the Workspace agent defaults. Each new body gets a fresh
 * Idempotency-Key; retrying the identical body after a network failure reuses the previous one.
 *
 * @param options - Authentication and the defaults query's mutator.
 * @returns Save action, pending state, and feedback.
 */
export function useSaveWorkspaceAgentDefaults({
  accessToken,
  mutateDefaults,
}: UseSaveWorkspaceAgentDefaultsOptions): WorkspaceAgentDefaultsSave {
  const runnerRef = useRef<MutationRequestRunner | null>(null)
  if (runnerRef.current === null) runnerRef.current = createMutationRequestRunner()
  const runner = runnerRef.current
  const savingRef = useRef(false)
  const [isSaving, setIsSaving] = useState(false)
  const [feedback, setFeedback] = useState<AgentSettingsSaveFeedback>()

  const save = useCallback(async (
    request: UpdateWorkspaceAgentDefaultsRequest,
  ): Promise<AgentSettingsSaveFeedback | undefined> => {
    if (savingRef.current) return undefined
    savingRef.current = true
    setIsSaving(true)
    setFeedback(undefined)
    try {
      const fingerprint = await createMutationFingerprint(accessToken, 'workspace-agent-defaults', JSON.stringify(request))
      const saved = await runner.run(
        'workspace-agent-defaults',
        fingerprint,
        (context) => updateWorkspaceAgentDefaults(accessToken, request, context),
        shouldRetainAgentSettingsSaveContext,
      )
      await mutateDefaults(saved, { revalidate: false })
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
  }, [accessToken, mutateDefaults, runner])

  return {
    clearFeedback: () => setFeedback(undefined),
    feedback,
    isSaving,
    save,
  }
}
