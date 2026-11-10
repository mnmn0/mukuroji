import type { AgentRunView } from '@mukuroji/contracts'
import { useMemo } from 'react'
import { createMutationRequestRunner } from '../../../shared/api/mutationHeaders'
import { releaseAgentRun } from '../../../work-items/api/agentRuns'

/**
 * Creates the board's release action. A retry of the same run reuses its idempotency context, and
 * the released run from the response is handed to `onReleased` once the release commits.
 *
 * @param accessToken - Session access token; releasing is unavailable without it.
 * @param teamId - Team that owns the runs.
 * @param onReleased - Shows the released run and reads the board again; its failure never reports the release as failed.
 * @returns Release action, or undefined when it cannot be sent.
 */
export function useReleaseFactoryBoardRun(
  accessToken: string | undefined,
  teamId: string | undefined,
  onReleased: (released: AgentRunView) => Promise<unknown>,
): ((run: AgentRunView) => Promise<void>) | undefined {
  const mutationRunner = useMemo(() => createMutationRequestRunner(), [])
  if (!accessToken || !teamId) return undefined
  return async (run) => {
    const released = await mutationRunner.run(
      `agent-run:release:${teamId}:${run.runId}`,
      run.runId,
      (context) => releaseAgentRun(accessToken, teamId, run.runId, context),
    )
    await onReleased(released).catch(() => undefined)
  }
}
