/**
 * Runs a Developer Platform mutation and refreshes aggregate resources afterward.
 *
 * A refresh failure is intentionally ignored so a successful one-time-secret
 * response or authorization URL is never lost.
 *
 * @param mutation - Mutation request that produces the authoritative result.
 * @param refresh - Best-effort aggregate resource refresh.
 * @returns The successful mutation result even when refresh fails.
 */
export async function runDeveloperPlatformMutation<TResult>(
  mutation: () => Promise<TResult>,
  refresh: () => Promise<void>,
) {
  const result = await mutation()

  try {
    await refresh()
  } catch {
    // Mutation results can contain data that cannot be recovered by refreshing.
  }

  return result
}
