import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../shared/api/mutationHeaders'
import {
  applyTriageBulkAction,
  applyTriageEntryAction,
  TriageApiError,
  updateTriageSettings,
  type TriageActionInput,
  type TriageBulkActionInput,
  type TriageBulkItemResult,
  type TriageConfiguration,
  type TriageEntry,
  type UpdateTriageConfigurationInput,
} from '../api'

/** Cache refresh callbacks used by the triage mutation controller. */
export type TriageMutationRefreshers = {
  /** Revalidates the active queue pages. */
  readonly refreshQueue: () => Promise<unknown>
  /** Revalidates the selected entry after a conflict. */
  readonly refreshEntry: () => Promise<unknown>
  /** Revalidates Team settings after a revision conflict. */
  readonly refreshSettings: () => Promise<unknown>
  /** Updates the selected entry cache after a successful action. */
  readonly updateEntry: (entry: TriageEntry) => Promise<unknown>
  /** Updates the Team settings cache after a successful save. */
  readonly updateSettings: (settings: TriageConfiguration) => Promise<unknown>
}

/** Inputs required to operate one Team triage mutation controller. */
export type UseTriageMutationsOptions = TriageMutationRefreshers & {
  /** Access token used by the triage API. */
  readonly accessToken?: string
  /** Team whose triage queue is being operated. */
  readonly teamId?: string
}

/** State and commands exposed by the Team triage mutation controller. */
export type TriageMutationController = {
  /** Last action or settings error. */
  readonly error?: unknown
  /** Entry currently running a single-entry action. */
  readonly pendingEntryId?: string
  /** Whether a bulk action is running. */
  readonly isBulkPending: boolean
  /** Whether settings are being saved. */
  readonly isSavingSettings: boolean
  /** Whether the latest settings replacement completed successfully. */
  readonly didSaveSettings: boolean
  /** Latest per-entry bulk results. */
  readonly bulkResults: readonly TriageBulkItemResult[]
  /** Clears current mutation feedback. */
  readonly clearFeedback: () => void
  /** Applies one explicit entry action. */
  readonly applyAction: (
    entryId: string,
    input: TriageActionInput,
  ) => Promise<TriageEntry>
  /** Applies one bulk action to selected entries. */
  readonly applyBulkAction: (
    input: TriageBulkActionInput,
  ) => Promise<readonly TriageBulkItemResult[]>
  /** Persists versioned Team triage settings. */
  readonly saveSettings: (
    input: UpdateTriageConfigurationInput,
  ) => Promise<TriageConfiguration>
}

/**
 * Creates an idempotent mutation controller for entry, bulk, and settings operations.
 *
 * @param options - Team scope, credentials, and cache refresh callbacks.
 * @returns Mutation commands and feedback state for the Team triage page.
 */
export function useTriageMutations(
  options: UseTriageMutationsOptions,
): TriageMutationController {
  const [runner] = useState(createMutationRequestRunner)
  const activeScope = useRef<{ teamId?: string; active: boolean }>({
    teamId: options.teamId,
    active: true,
  })
  const [stateTeamId, setStateTeamId] = useState(options.teamId)
  const [error, setError] = useState<unknown>()
  const [pendingEntryId, setPendingEntryId] = useState<string>()
  const [isBulkPending, setIsBulkPending] = useState(false)
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [didSaveSettings, setDidSaveSettings] = useState(false)
  const [bulkResults, setBulkResults] = useState<readonly TriageBulkItemResult[]>([])

  useEffect(() => {
    const scope = { teamId: options.teamId, active: true }
    activeScope.current = scope
    runner.discardRetainedContexts()
    return () => {
      scope.active = false
    }
  }, [options.teamId, runner])

  const applyAction = useCallback(async (
    entryId: string,
    input: TriageActionInput,
  ) => {
    if (!options.accessToken || !options.teamId) {
      throw new TriageApiError(401, 'Team triage requires an authenticated session.')
    }
    const teamId = options.teamId
    const scope = activeScope.current
    const isCurrentScope = () => activeScope.current === scope && scope.active && scope.teamId === teamId

    setStateTeamId(teamId)
    setError(undefined)
    setIsBulkPending(false)
    setIsSavingSettings(false)
    setDidSaveSettings(false)
    setBulkResults([])
    setPendingEntryId(entryId)
    try {
      const fingerprint = await createMutationFingerprint(
        teamId,
        entryId,
        JSON.stringify(input),
      )
      const receipt = await runner.run(
        `triage-entry:${teamId}:${entryId}:${input.action}`,
        fingerprint,
        (context) => applyTriageEntryAction(
          teamId,
          entryId,
          input,
          options.accessToken ?? '',
          context,
        ),
        shouldRetainMutationContext,
      )
      if (isCurrentScope()) {
        await Promise.allSettled([
          options.updateEntry(receipt.entry),
          options.refreshQueue(),
        ])
      }
      return receipt.entry
    } catch (actionError) {
      if (isCurrentScope()) setError(actionError)
      if (isCurrentScope() && isConflict(actionError)) {
        await Promise.all([
          options.refreshEntry().catch(() => undefined),
          options.refreshQueue().catch(() => undefined),
        ])
      }
      throw actionError
    } finally {
      if (isCurrentScope()) setPendingEntryId(undefined)
    }
  }, [options, runner])

  const applyBulkAction = useCallback(async (input: TriageBulkActionInput) => {
    if (!options.accessToken || !options.teamId) {
      throw new TriageApiError(401, 'Team triage requires an authenticated session.')
    }
    const teamId = options.teamId
    const scope = activeScope.current
    const isCurrentScope = () => activeScope.current === scope && scope.active && scope.teamId === teamId

    setStateTeamId(teamId)
    setError(undefined)
    setPendingEntryId(undefined)
    setBulkResults([])
    setIsSavingSettings(false)
    setDidSaveSettings(false)
    setIsBulkPending(true)
    try {
      const fingerprint = await createMutationFingerprint(
        teamId,
        JSON.stringify(input),
      )
      const results = await runner.run(
        `triage-bulk:${teamId}:${input.operation.action}`,
        fingerprint,
        (context) => applyTriageBulkAction(
          teamId,
          input,
          options.accessToken ?? '',
          context,
        ),
        shouldRetainMutationContext,
      )
      if (isCurrentScope()) setBulkResults(results.results)
      if (isCurrentScope()) {
        await Promise.allSettled([
          options.refreshQueue(),
          options.refreshEntry(),
        ])
      }
      return results.results
    } catch (bulkError) {
      if (isCurrentScope()) setError(bulkError)
      throw bulkError
    } finally {
      if (isCurrentScope()) setIsBulkPending(false)
    }
  }, [options, runner])

  const saveSettings = useCallback(async (input: UpdateTriageConfigurationInput) => {
    if (!options.accessToken || !options.teamId) {
      throw new TriageApiError(401, 'Team triage requires an authenticated session.')
    }
    const teamId = options.teamId
    const scope = activeScope.current
    const isCurrentScope = () => activeScope.current === scope && scope.active && scope.teamId === teamId

    setStateTeamId(teamId)
    setError(undefined)
    setPendingEntryId(undefined)
    setIsBulkPending(false)
    setDidSaveSettings(false)
    setBulkResults([])
    setIsSavingSettings(true)
    try {
      const fingerprint = await createMutationFingerprint(
        teamId,
        JSON.stringify(input),
      )
      const settings = await runner.run(
        `triage-settings:${teamId}`,
        fingerprint,
        (context) => updateTriageSettings(
          teamId,
          input,
          options.accessToken ?? '',
          context,
        ),
        shouldRetainMutationContext,
      )
      if (isCurrentScope()) await options.updateSettings(settings)
      if (isCurrentScope()) setDidSaveSettings(true)
      return settings
    } catch (settingsError) {
      if (isCurrentScope()) setError(settingsError)
      if (isCurrentScope() && isConflict(settingsError)) {
        await options.refreshSettings().catch(() => undefined)
      }
      throw settingsError
    } finally {
      if (isCurrentScope()) setIsSavingSettings(false)
    }
  }, [options, runner])

  return {
    applyAction,
    applyBulkAction,
    bulkResults: stateTeamId === options.teamId ? bulkResults : [],
    clearFeedback: () => {
      setStateTeamId(options.teamId)
      setBulkResults([])
      setDidSaveSettings(false)
      setError(undefined)
      runner.discardRetainedContexts()
    },
    error: stateTeamId === options.teamId ? error : undefined,
    didSaveSettings: stateTeamId === options.teamId && didSaveSettings,
    isBulkPending: stateTeamId === options.teamId && isBulkPending,
    isSavingSettings: stateTeamId === options.teamId && isSavingSettings,
    pendingEntryId: stateTeamId === options.teamId ? pendingEntryId : undefined,
    saveSettings,
  }
}

/** Checks whether a mutation failed its revision fence. */
function isConflict(error: unknown) {
  return error instanceof TriageApiError && error.status === 409
}

/** Retains idempotency context only when retry safety is uncertain. */
function shouldRetainMutationContext(error: unknown) {
  if (!(error instanceof TriageApiError)) return true
  return error.status === 408 || error.status === 429 || error.status >= 500
}
