import type { RunningTimer, TimeEntry } from '@mukuroji/contracts'
import { useMemo } from 'react'
import { createMutationRequestRunner, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import { discardTimer, startTimer, stopTimer, type StartTimerInput } from '../api/timers'
import { classifyTimeTrackingFailure, shouldRetainTimeTrackingMutation } from '../model/timeTrackingFailure'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/** Timer mutations bound to the signed-in member. */
export type TimerMutations = {
  /** Starts a timer on a Work Item. */
  start: (teamId: string, input: StartTimerInput) => Promise<RunningTimer>
  /** Stops a timer and creates its draft entry. */
  stop: (timer: RunningTimer) => Promise<TimeEntry>
  /** Discards a timer without creating an entry. */
  discard: (timer: RunningTimer) => Promise<void>
}

/**
 * Creates timer mutations with retry-safe idempotency keys that refresh every time tracking query.
 *
 * A 404 or 409 on stop or discard means another tab or device already changed the timer, so the
 * cache is refreshed before the failure is reported.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @returns Timer mutations.
 */
export function useTimerMutations(accessToken: string | undefined): TimerMutations {
  const runner = useMemo(() => createMutationRequestRunner(), [])
  const refresh = useRefreshTimeTrackingQueries()

  return useMemo(() => {
    /**
     * Runs one logical timer mutation and refreshes the cache when its outcome is known.
     *
     * @param operationKey - Logical operation identity.
     * @param fingerprint - Input identity.
     * @param request - Request that receives the shared idempotency context.
     * @returns Request result.
     */
    async function run<Result>(
      operationKey: string,
      fingerprint: string,
      request: (context: MutationRequestContext) => Promise<Result>,
    ): Promise<Result> {
      if (!accessToken) throw new Error('A signed-in session is required.')
      try {
        const result = await runner.run(operationKey, fingerprint, request, shouldRetainTimeTrackingMutation)
        await refresh()
        return result
      } catch (error) {
        const kind = classifyTimeTrackingFailure(error)
        if (kind === 'conflict' || kind === 'invalid') await refresh()
        throw error
      }
    }

    return {
      start: (teamId, input) => run(
        `timer:start:${teamId}`,
        JSON.stringify(input),
        (context) => startTimer(accessToken ?? '', teamId, input, context),
      ),
      stop: (timer) => run(`timer:stop:${timer.id}`, timer.id, (context) => stopTimer(accessToken ?? '', timer.id, context)),
      discard: (timer) => run(`timer:discard:${timer.id}`, timer.id, (context) => discardTimer(accessToken ?? '', timer.id, context)),
    }
  }, [accessToken, refresh, runner])
}
