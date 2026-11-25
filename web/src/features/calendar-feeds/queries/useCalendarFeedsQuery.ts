import useSWR from 'swr'
import { listCalendarFeeds } from '../api/calendarFeeds'

/**
 * Loads the signed-in member's calendar feeds.
 *
 * @param accessToken - Access token of the signed-in member.
 * @returns The SWR state of the feed list.
 */
export function useCalendarFeedsQuery(accessToken: string) {
  return useSWR(
    ['calendar-feeds', accessToken] as const,
    ([, token]) => listCalendarFeeds(token),
    { shouldRetryOnError: false },
  )
}
