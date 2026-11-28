import useSWR from 'swr'
import { getSlackIngestStatus } from '../api/slackIngest'

/**
 * Loads the Slack app status, retention, and channels of the Workspace.
 *
 * @param accessToken - Administrator access token.
 * @returns The SWR state of the status.
 */
export function useSlackIngestStatus(accessToken: string) {
  return useSWR(
    ['slack-ingest-status', accessToken] as const,
    ([, token]) => getSlackIngestStatus(token),
    { shouldRetryOnError: false },
  )
}
