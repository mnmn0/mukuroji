import type { CalendarFeed, IssueCalendarFeedRequest } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { createMutationRequestRunner } from '../../../shared/api/mutationHeaders'
import {
  CalendarFeedsApiError,
  issueCalendarFeed,
  revokeCalendarFeed,
  toCalendarFeedUrl,
} from '../api/calendarFeeds'
import { useCalendarFeedsQuery } from '../queries/useCalendarFeedsQuery'

/** A feed URL shown once after it is issued. */
export type IssuedCalendarFeed = {
  /** Issued feed. */
  feed: CalendarFeed
  /** Absolute URL to paste into a calendar app. */
  url: string
}

/**
 * Returns whether a failed request may be sent again with the same idempotency key.
 *
 * @param error - Thrown error.
 * @returns Whether the request did not reach the server or failed transiently.
 */
function isRetryable(error: unknown): boolean {
  return error instanceof CalendarFeedsApiError && (error.status === 0 || error.status === 503)
}

/**
 * Loads the member's calendar feeds and issues, replaces, and revokes them.
 *
 * @param accessToken - Access token of the signed-in member.
 * @returns The feeds, their load state, the operation state, and the actions.
 */
export function useCalendarFeeds(accessToken: string) {
  const { data, error, isLoading, mutate } = useCalendarFeedsQuery(accessToken)
  const requestRunner = useMemo(() => createMutationRequestRunner(), [])
  const [busyOperation, setBusyOperation] = useState<string>()
  const [hasOperationError, setHasOperationError] = useState(false)
  const [issued, setIssued] = useState<IssuedCalendarFeed>()

  /**
   * Runs one mutation, then reloads the feeds.
   *
   * @param operationKey - Logical mutation key.
   * @param fingerprint - Payload fingerprint.
   * @param request - API call.
   * @returns Whether the mutation succeeded.
   */
  async function run(
    operationKey: string,
    fingerprint: string,
    request: Parameters<typeof requestRunner.run<void>>[2],
  ): Promise<boolean> {
    setBusyOperation(operationKey)
    setHasOperationError(false)
    let succeeded = false
    try {
      await requestRunner.run(operationKey, fingerprint, request, isRetryable)
      succeeded = true
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
    return succeeded
  }

  /**
   * Issues a feed, or replaces its URL, and keeps the new URL until dismissed.
   *
   * @param input - Feed to issue.
   * @returns Whether the feed was issued.
   */
  function issue(input: IssueCalendarFeedRequest) {
    const key = input.kind === 'member' ? 'issue:member' : `issue:${input.teamId}:${input.projectId}`
    return run(key, JSON.stringify(input), async (context) => {
      const result = await issueCalendarFeed(accessToken, input, context)
      setIssued({ feed: result.feed, url: toCalendarFeedUrl(result.feedPath, window.location.origin) })
    })
  }

  /**
   * Revokes a feed; a URL shown for it is dismissed.
   *
   * @param feed - Feed to revoke.
   * @returns Whether the feed was revoked.
   */
  function revoke(feed: CalendarFeed) {
    return run(`revoke:${feed.id}`, feed.id, async (context) => {
      await revokeCalendarFeed(accessToken, feed.id, context)
      setIssued((current) => current?.feed.id === feed.id ? undefined : current)
    })
  }

  return {
    feeds: data?.feeds,
    hasLoadError: Boolean(error),
    isLoading,
    busyOperation,
    hasOperationError,
    issued,
    dismissIssued: () => setIssued(undefined),
    reload: () => mutate(),
    issue,
    revoke,
  }
}
