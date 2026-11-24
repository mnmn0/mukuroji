import { useState } from 'react'
import type { ResourceAssignmentStatus, WorkloadSnapshot } from '@mukuroji/contracts'
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
  /** Confirms, returns to tentative, or cancels an assignment. */
  setStatus: (assignmentId: string, status: ResourceAssignmentStatus) => void
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
    if (isPending) return
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

  /** Changes an assignment's lifecycle state at its current revision. */
  const setStatus = (assignmentId: string, status: ResourceAssignmentStatus) => {
    if (isPending) return
    const currentSnapshot = snapshot
    const assignment = currentSnapshot?.assignments.find((candidate) => candidate.id === assignmentId)
    if (!assignment || !accessToken || !teamId || !currentSnapshot) return
    setError(undefined)
    setIsPending(true)
    void updateWorkloadAssignment(accessToken, teamId, assignment.id, {
      status,
      expectedRevision: assignment.revision,
      expectedTeamRevision: currentSnapshot.revision,
    }).then(async () => {
      await refresh()
    }).catch(async (cause: unknown) => {
      setError(cause instanceof Error ? cause : new Error('The workload assignment could not be changed.'))
      await refresh().catch(() => undefined)
    }).finally(() => setIsPending(false))
  }

  return { error, isPending, move, setStatus }
}
