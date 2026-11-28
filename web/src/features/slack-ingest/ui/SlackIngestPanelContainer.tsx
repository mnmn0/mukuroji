import type { SlackChannelSummary, SlackChannelTarget } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { createMutationRequestRunner } from '../../../shared/api/mutationHeaders'
import { createTranslator, type Locale } from '../../../shared/i18n/i18n'
import {
  getSlackIngestStatus,
  SlackIngestApiError,
  updateSlackChannelTarget,
  updateSlackIngestSettings,
} from '../api/slackIngest'
import { SlackIngestPanel, type SlackIngestTeamOption } from './SlackIngestPanel'

/** Inputs of the Slack ingest settings container. */
export type SlackIngestPanelContainerProps = {
  /** Administrator access token. */
  accessToken: string
  /** Display locale. */
  locale: Locale
  /** Teams and Projects offered as targets. */
  teams: readonly SlackIngestTeamOption[]
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
 * Connects the Slack ingest settings to the Workspace API.
 *
 * @param props - Session, locale, and Teams.
 * @returns The settings section.
 */
export function SlackIngestPanelContainer({ accessToken, locale, teams }: SlackIngestPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const { data, error, mutate } = useSWR(
    ['slack-ingest-status', accessToken] as const,
    ([, token]) => getSlackIngestStatus(token),
    { shouldRetryOnError: false },
  )
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
    request: Parameters<typeof requestRunner.run<void>>[2],
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

  return (
    <SlackIngestPanel
      busyOperation={busyOperation}
      hasLoadError={Boolean(error) && !data}
      hasOperationError={hasOperationError}
      onReload={() => void mutate()}
      onSaveRetention={(retentionDays) => {
        if (!data) return
        const revision = data.settingsRevision
        void run('retention', `${retentionDays}:${revision}`, async (context) => {
          await updateSlackIngestSettings(accessToken, retentionDays, revision, context)
        })
      }}
      onSetTarget={(channel: SlackChannelSummary, target: SlackChannelTarget | null) => {
        void run(`channel:${channel.channelId}`, JSON.stringify(target), async (context) => {
          await updateSlackChannelTarget(accessToken, channel.channelId, target, context)
        })
      }}
      status={data}
      t={t}
      teams={teams}
    />
  )
}
