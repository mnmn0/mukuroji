import { mutate as mutateGlobalCache } from 'swr'

/** First element of every Workspace key prefix list cache key. */
const WORK_ITEM_KEY_PREFIXES_KEY = 'work-item-key-prefixes'

/**
 * Builds the SWR key of the Workspace's Work Item key prefix list.
 *
 * @param accessToken - Session access token.
 * @returns The scope-bound cache key.
 */
export function workItemKeyPrefixesKey(accessToken: string) {
  return [WORK_ITEM_KEY_PREFIXES_KEY, accessToken] as const
}

/**
 * Reads the Workspace's key prefix list again in every session scope.
 *
 * Called after a Work Item is created or a Team's prefix changes, because a Team gets its prefix
 * with its first key and key links only follow prefixes in the list.
 *
 * @returns A promise that settles once the list is read again; failures are ignored.
 */
export async function revalidateWorkItemKeyPrefixes(): Promise<void> {
  await mutateGlobalCache(
    (key) => Array.isArray(key) && key[0] === WORK_ITEM_KEY_PREFIXES_KEY,
  ).catch(() => undefined)
}
