import { useState } from 'react'
import type { WorkloadSnapshot } from '@mukuroji/contracts'
import { updateWorkloadAssignment } from '../api'
import { addWorkloadCalendarDays, countWorkloadCalendarDays } from '../model/dateRange'

/** Options used by the workload assignment move mutation. */
export type UseMoveWorkloadAssignmentOptions = {
  /** Authenticated API token. */
  accessToken?: string
  /** Current Team identifier. */
  teamId?: string
  /** Snapshot containing the assignment and optimistic-concurrency revisions. */
  snapshot?: WorkloadSnapshot
  /** Refreshes the authoritative workload snapshot. */
  refresh: () => Promise<unknown>
}

/** Result returned by the workload assignment move mutation. */
export type UseMoveWorkloadAssignmentResult = {
  /** Moves an assignment to another member and start date. */
  move: (assignmentId: string, memberId: string, targetDate: string) => void
  /** Latest mutation error. */
  error?: Error
  /** Whether an assignment move is currently in flight. */
  isPending: boolean
}

/**
 * Coordinates assignment moves with workload-specific optimistic concurrency.
 *
 * @param options - API credentials, current snapshot, and refresh callback.
 * @returns Assignment move action and its current mutation state.
 */
export function useMoveWorkloadAssignment({
  accessToken,
  refresh,
  snapshot,
  teamId,
}: UseMoveWorkloadAssignmentOptions): UseMoveWorkloadAssignmentResult {
  const [error, setError] = useState<Error>()
  const [isPending, setIsPending] = useState(false)

  /** Moves an assignment while retaining its original duration in calendar days. */
  const move = (assignmentId: string, memberId: string, targetDate: string) => {
    const currentSnapshot = snapshot
    const assignment = currentSnapshot?.assignments.find((candidate) => candidate.id === assignmentId)
    if (!assignment || !accessToken || !teamId || !currentSnapshot) return
    setError(undefined)
    setIsPending(true)
    const durationDays = countWorkloadCalendarDays(assignment.fromDate, assignment.toDate)
    void updateWorkloadAssignment(accessToken, teamId, assignment.id, {
      memberId,
      fromDate: targetDate,
      toDate: addWorkloadCalendarDays(targetDate, durationDays - 1),
      expectedRevision: assignment.revision,
      expectedTeamRevision: currentSnapshot.revision,
    }).then(async () => {
      await refresh()
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause : new Error('The workload assignment could not be moved.'))
    }).finally(() => setIsPending(false))
  }

  return { error, isPending, move }
}
