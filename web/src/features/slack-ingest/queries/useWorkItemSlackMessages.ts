import useSWR from 'swr'
import { listWorkItemSlackMessages } from '../api/slackIngest'

/**
 * Loads the Slack messages that mention a Work Item's key.
 *
 * @param accessToken - Access token.
 * @param teamId - Team of the Work Item.
 * @param workItemId - Work Item ID.
 * @returns The SWR state of the messages.
 */
export function useWorkItemSlackMessages(accessToken: string, teamId: string, workItemId: string) {
  return useSWR(
    ['work-item-slack-messages', accessToken, teamId, workItemId] as const,
    ([, token, team, item]) => listWorkItemSlackMessages(token, team, item),
    { shouldRetryOnError: false, revalidateOnFocus: false },
  )
}
