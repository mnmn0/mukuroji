import type { SlackChannelSummary, SlackChannelTarget, SlackIngestStatusResponse } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { createMutationRequestRunner, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import { SlackIngestApiError, updateSlackChannelTarget, updateSlackIngestSettings } from '../api/slackIngest'
import { useSlackIngestStatus } from '../queries/useSlackIngestStatus'

/** Slack ingest status with the administrator's changes. */
export type SlackIngestChanges = {
  /** Status, or `undefined` while loading. */
  status?: SlackIngestStatusResponse
  /** Whether the status failed to load. */
  hasLoadError: boolean
  /** Whether the last change failed. */
  hasOperationError: boolean
  /** Key of the running change. */
  busyOperation?: string
  /** Loads the status again. */
  reload: () => void
  /** Saves the retention. */
  saveRetention: (retentionDays: number) => void
  /** Maps or unmaps a channel. */
  setTarget: (channel: SlackChannelSummary, target: SlackChannelTarget | null) => void
}

/**
 * Returns whether a failed change may be sent again with the same idempotency key.
 *
 * @param error - Thrown error.
 * @returns Whether the request did not reach the server or failed transiently.
 */
function isRetryable(error: unknown): boolean {
  return error instanceof SlackIngestApiError && (error.status === 0 || error.status === 503)
}

/**
 * Reads the Slack ingest status and runs the administrator's changes, reloading the status after
 * each one.
 *
 * @param accessToken - Administrator access token.
 * @returns The status and the change actions.
 */
export function useSlackIngestChanges(accessToken: string): SlackIngestChanges {
  const { data, error, mutate } = useSlackIngestStatus(accessToken)
  const requestRunner = useMemo(() => createMutationRequestRunner(), [])
  const [busyOperation, setBusyOperation] = useState<string>()
  const [hasOperationError, setHasOperationError] = useState(false)

  /**
   * Runs one change, then reloads the status.
   *
   * @param operationKey - Logical change key.
   * @param fingerprint - Payload fingerprint.
   * @param request - API call.
   */
  async function run(
    operationKey: string,
    fingerprint: string,
    request: (context: MutationRequestContext) => Promise<void>,
  ): Promise<void> {
    setBusyOperation(operationKey)
    setHasOperationError(false)
    try {
      await requestRunner.run(operationKey, fingerprint, request, isRetryable)
    } catch {
      setHasOperationError(true)
    }
    try {
      await mutate()
    } catch {
      // The load error is shown by the query state.
    } finally {
      setBusyOperation(undefined)
    }
  }

  return {
    ...(data ? { status: data } : {}),
    hasLoadError: Boolean(error) && !data,
    hasOperationError,
    ...(busyOperation ? { busyOperation } : {}),
    reload: () => void mutate(),
    saveRetention: (retentionDays) => {
      if (!data) return
      const revision = data.settingsRevision
      void run('retention', `${retentionDays}:${revision}`, async (context) => {
        await updateSlackIngestSettings(accessToken, retentionDays, revision, context)
      })
    },
    setTarget: (channel, target) => {
      void run(`channel:${channel.channelId}`, JSON.stringify(target), async (context) => {
        await updateSlackChannelTarget(accessToken, channel.channelId, target, context)
      })
    },
  }
}
