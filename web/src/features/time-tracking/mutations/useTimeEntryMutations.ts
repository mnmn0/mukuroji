import type { TimeEntry } from '@mukuroji/contracts'
import { useMemo } from 'react'
import { createMutationRequestRunner, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import {
  createIndirectTimeEntry,
  createTimeEntry,
  deleteTimeEntry,
  transitionTimeEntry,
  transitionTimesheet,
  updateIndirectTimeEntry,
  updateTimeEntry,
  type IndirectTimeEntryInput,
  type SavedTimeEntry,
  type TimeEntryDraftInput,
  type TimeEntryTransitionAction,
  type TimesheetTransitionResult,
} from '../api/timeEntries'
import { classifyTimeTrackingFailure, shouldRetainTimeTrackingMutation } from '../model/timeTrackingFailure'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/** Time entry mutations bound to the signed-in member. */
export type TimeEntryMutations = {
  /** Creates a manual draft. */
  create: (teamId: string, input: TimeEntryDraftInput) => Promise<SavedTimeEntry>
  /** Edits a draft or rejected entry. */
  update: (entry: TimeEntry, input: TimeEntryDraftInput) => Promise<SavedTimeEntry>
  /** Records indirect work without a Work Item. */
  createIndirect: (teamId: string, input: IndirectTimeEntryInput) => Promise<SavedTimeEntry>
  /** Edits a draft or rejected indirect-work entry. */
  updateIndirect: (entry: TimeEntry, input: IndirectTimeEntryInput) => Promise<SavedTimeEntry>
  /** Deletes the member's own draft or rejected entry. */
  remove: (entry: TimeEntry) => Promise<void>
  /** Applies one lifecycle action to one entry. */
  transition: (entry: TimeEntry, action: TimeEntryTransitionAction, reason?: string) => Promise<TimeEntry>
  /** Applies one lifecycle action to every eligible entry of a period. */
  transitionPeriod: (
    teamId: string,
    action: TimeEntryTransitionAction,
    period: { from: string; to: string },
  ) => Promise<TimesheetTransitionResult>
}

/**
 * Creates time entry mutations that send an `Idempotency-Key`, keep it for a retry after a network
 * or server failure, and refresh every time tracking query after a success or a revision conflict.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @returns Entry mutations.
 */
export function useTimeEntryMutations(accessToken: string | undefined): TimeEntryMutations {
  const runner = useMemo(() => createMutationRequestRunner(), [])
  const refresh = useRefreshTimeTrackingQueries()

  return useMemo(() => {
    /**
     * Runs one logical mutation and refreshes the cache after it settles in a way that changes it.
     *
     * @param operationKey - Logical operation identity.
     * @param fingerprint - Input identity; a different input starts a new logical mutation.
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
        if (classifyTimeTrackingFailure(error) === 'conflict') await refresh()
        throw error
      }
    }

    return {
      create: (teamId, input) => run(
        `time-entry:create:${teamId}`,
        JSON.stringify(input),
        (context) => createTimeEntry(accessToken ?? '', teamId, input, context),
      ),
      update: (entry, input) => run(
        `time-entry:update:${entry.teamId}:${entry.id}`,
        JSON.stringify([entry.revision, input]),
        (context) => updateTimeEntry(accessToken ?? '', entry, input, context),
      ),
      createIndirect: (teamId, input) => run(
        `time-entry:create-indirect:${teamId}`,
        JSON.stringify(input),
        (context) => createIndirectTimeEntry(accessToken ?? '', teamId, input, context),
      ),
      updateIndirect: (entry, input) => run(
        `time-entry:update:${entry.teamId}:${entry.id}`,
        JSON.stringify([entry.revision, input]),
        (context) => updateIndirectTimeEntry(accessToken ?? '', entry, input, context),
      ),
      remove: (entry) => run(
        `time-entry:delete:${entry.teamId}:${entry.id}`,
        JSON.stringify([entry.revision]),
        (context) => deleteTimeEntry(accessToken ?? '', entry, context),
      ),
      transition: (entry, action, reason) => run(
        `time-entry:${action}:${entry.teamId}:${entry.id}`,
        JSON.stringify([entry.revision, reason ?? '']),
        (context) => transitionTimeEntry(accessToken ?? '', entry, action, context, reason),
      ),
      transitionPeriod: (teamId, action, period) => run(
        `timesheet:${action}:${teamId}`,
        JSON.stringify(period),
        (context) => transitionTimesheet(accessToken ?? '', teamId, action, period, context),
      ),
    }
  }, [accessToken, refresh, runner])
}
