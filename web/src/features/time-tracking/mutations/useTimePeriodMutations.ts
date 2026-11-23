import type { TimePeriodClose, WorkspaceTimePeriodResult } from '@mukuroji/contracts'
import { useMemo } from 'react'
import {
  closeTeamTimePeriod,
  closeWorkspaceTimePeriod,
  reopenTeamTimePeriod,
  reopenWorkspaceTimePeriod,
} from '../api/timePeriods'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/** Month close actions of one Team and of the whole Workspace. */
export type TimePeriodMutations = {
  /** Closes a month of the Team. */
  closeTeamMonth: (month: string, timeZone: string) => Promise<TimePeriodClose>
  /** Reopens a closed month of the Team with a reason. */
  reopenTeamMonth: (month: string, reason: string) => Promise<TimePeriodClose>
  /** Closes a month for every Team of the Workspace. */
  closeWorkspaceMonth: (month: string, timeZone: string) => Promise<WorkspaceTimePeriodResult>
  /** Reopens a month for every Team of the Workspace with a reason. */
  reopenWorkspaceMonth: (month: string, reason: string) => Promise<WorkspaceTimePeriodResult>
}

/**
 * Creates the month close actions, refreshing every time tracking query after each settles so the
 * lists, entries, and their actions agree with the new close state.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team whose months are changed.
 * @returns Month close actions.
 */
export function useTimePeriodMutations(accessToken: string | undefined, teamId: string): TimePeriodMutations {
  const refresh = useRefreshTimeTrackingQueries()
  return useMemo(() => {
    /**
     * Runs one action with the session token and refreshes afterwards.
     *
     * @param operation - Request that takes the token.
     * @returns The request's result.
     */
    const run = async <Result>(operation: (token: string) => Promise<Result>): Promise<Result> => {
      if (!accessToken) throw new TimeTrackingApiError(401, 'Sign in again to change month closes.')
      try {
        return await operation(accessToken)
      } finally {
        await refresh()
      }
    }
    return {
      closeTeamMonth: (month, timeZone) => run((token) => closeTeamTimePeriod(token, teamId, month, timeZone)),
      reopenTeamMonth: (month, reason) => run((token) => reopenTeamTimePeriod(token, teamId, month, reason)),
      closeWorkspaceMonth: (month, timeZone) => run((token) => closeWorkspaceTimePeriod(token, month, timeZone)),
      reopenWorkspaceMonth: (month, reason) => run((token) => reopenWorkspaceTimePeriod(token, month, reason)),
    }
  }, [accessToken, refresh, teamId])
}
