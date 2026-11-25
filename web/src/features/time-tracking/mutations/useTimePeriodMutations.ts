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

/** Month close actions of one Team. */
export type TimePeriodMutations = {
  /** Closes a month of the Team. */
  closeTeamMonth: (month: string, timeZone: string) => Promise<TimePeriodClose>
  /** Reopens a closed month of the Team with a reason. */
  reopenTeamMonth: (month: string, reason: string) => Promise<TimePeriodClose>
}

/** Month close actions for every Team of the Workspace. */
export type WorkspaceTimePeriodMutations = {
  /** Closes a month for every Team of the Workspace. */
  closeWorkspaceMonth: (month: string, timeZone: string) => Promise<WorkspaceTimePeriodResult>
  /** Reopens a month for every Team of the Workspace with a reason. */
  reopenWorkspaceMonth: (month: string, reason: string) => Promise<WorkspaceTimePeriodResult>
}

/** Runs one month close request with the session token. */
type TimePeriodRunner = <Result>(operation: (token: string) => Promise<Result>) => Promise<Result>

/**
 * Creates the runner of month close requests, refreshing every time tracking query after each
 * settles so the lists, entries, and their actions agree with the new close state.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @returns The runner.
 */
function useTimePeriodRunner(accessToken: string | undefined): TimePeriodRunner {
  const refresh = useRefreshTimeTrackingQueries()
  return useMemo<TimePeriodRunner>(() => async (operation) => {
    if (!accessToken) throw new TimeTrackingApiError(401, 'Sign in again to change month closes.')
    try {
      return await operation(accessToken)
    } finally {
      await refresh()
    }
  }, [accessToken, refresh])
}

/**
 * Creates the month close actions of one Team.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team whose months are changed.
 * @returns Month close actions.
 */
export function useTimePeriodMutations(accessToken: string | undefined, teamId: string): TimePeriodMutations {
  const run = useTimePeriodRunner(accessToken)
  return useMemo<TimePeriodMutations>(() => ({
    closeTeamMonth: (month, timeZone) => run((token) => closeTeamTimePeriod(token, teamId, month, timeZone)),
    reopenTeamMonth: (month, reason) => run((token) => reopenTeamTimePeriod(token, teamId, month, reason)),
  }), [run, teamId])
}

/**
 * Creates the month close actions for every Team of the Workspace.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @returns Workspace month close actions.
 */
export function useWorkspaceTimePeriodMutations(accessToken: string | undefined): WorkspaceTimePeriodMutations {
  const run = useTimePeriodRunner(accessToken)
  return useMemo<WorkspaceTimePeriodMutations>(() => ({
    closeWorkspaceMonth: (month, timeZone) => run((token) => closeWorkspaceTimePeriod(token, month, timeZone)),
    reopenWorkspaceMonth: (month, reason) => run((token) => reopenWorkspaceTimePeriod(token, month, reason)),
  }), [run])
}
