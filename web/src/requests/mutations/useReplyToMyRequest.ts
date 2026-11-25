import { useCallback, useRef } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { replyToMyRequest } from '../api/myRequests'

/** Cache revalidation the reply needs after it is saved. */
export type ReplyToMyRequestRevalidation = {
  /** Reloads the selected request, so the reply appears in its thread. */
  revalidateDetail: () => Promise<unknown>
  /** Reloads the request list, so its status and awaiting-reply badge update. */
  revalidateList: () => Promise<unknown>
}

/**
 * Sends the member's reply to their own request with a stable idempotency key, then reloads
 * the request and the list.
 *
 * @param accessToken - Workspace access token, absent until signed in.
 * @param revalidation - Revalidators of the request detail and list queries.
 * @returns A callback that sends one reply and rejects when it fails.
 */
export function useReplyToMyRequest(
  accessToken: string | undefined,
  { revalidateDetail, revalidateList }: ReplyToMyRequestRevalidation,
) {
  const mutationRunner = useRef(createMutationRequestRunner()).current
  return useCallback(async (requestId: string, body: string) => {
    if (!accessToken) throw new Error('Not signed in.')
    await mutationRunner.run(
      `my-request:reply:${requestId}`,
      body,
      (context) => replyToMyRequest(accessToken, requestId, { body }, context),
    )
    await Promise.all([revalidateDetail(), revalidateList()])
  }, [accessToken, mutationRunner, revalidateDetail, revalidateList])
}
