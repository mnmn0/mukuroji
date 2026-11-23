import type {
  CanonicalWorkItem,
  WorkItemScheduleChangePreview,
  WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import { TeamIssuesApiError } from '../../issues/api'
import {
  beginProjectTaskDirectSchedulePreview,
  completeProjectTaskDirectScheduleMutation,
  createProjectTaskDirectScheduleHandle,
  createProjectTaskDirectScheduleRequest,
  failProjectTaskDirectSchedule,
  publishProjectTaskDirectSchedulePreview,
  waitForProjectTaskDirectScheduleDecision,
  type ProjectTaskDirectScheduleHandle,
} from './projectTaskDirectActionRequest'

/** Server preview and confirmation used by one Work Item list surface. */
export type WorkItemListScheduleChangeCallbacks = {
  /** Requests the server-authoritative before/after preview. */
  preview: (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
  ) => Promise<WorkItemScheduleChangePreview>
  /** Persists the previewed operation and returns the confirmed Work Item. */
  confirm: (
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
    preview: WorkItemScheduleChangePreview,
  ) => Promise<CanonicalWorkItem>
}

/**
 * Starts a schedule change from the Calendar, Gantt, or table of a Team or My Tasks surface.
 *
 * These surfaces have no Project action registry, so the change runs the shared direct
 * schedule state machine on its own: it previews, waits for the confirmation dialog of the
 * view, and persists only a confirmed preview. The view owns the returned handle exactly as
 * it does on the Project screen.
 *
 * @param scopeKey - Surface scope that owns the change, such as a Team ID or `my-tasks`.
 * @param task - Revision-bound Work Item selected by the gesture.
 * @param operation - Move, resize, or replacement operation chosen by the gesture.
 * @param callbacks - Preview and confirmation API calls of the route.
 * @param canChange - Whether the person may change this Work Item's schedule.
 * @param unavailableMessage - Message reported when `canChange` is false.
 * @returns Handle whose preview resolves to the confirm/cancel controller.
 */
export function startWorkItemListScheduleChange(
  scopeKey: string,
  task: CanonicalWorkItem,
  operation: WorkItemScheduleOperation,
  callbacks: WorkItemListScheduleChangeCallbacks,
  canChange: boolean,
  unavailableMessage: string,
): ProjectTaskDirectScheduleHandle {
  const request = createProjectTaskDirectScheduleRequest(
    scopeKey,
    { expectedRevision: task.revision, teamId: task.teamId, workItemId: task.id },
    operation,
  )
  const handle = createProjectTaskDirectScheduleHandle(request)
  // The view observes failures through the preview or confirmation promise it holds.
  handle.preview.catch(() => undefined)

  void (async () => {
    if (!canChange) {
      // Reported like the server's refusal, so the view shows its permission message.
      failProjectTaskDirectSchedule(
        request,
        new TeamIssuesApiError(403, unavailableMessage, 'WorkItemScheduleForbidden'),
      )
      return
    }
    if (!beginProjectTaskDirectSchedulePreview(request)) return
    try {
      const preview = await callbacks.preview(task, operation)
      if (!publishProjectTaskDirectSchedulePreview(request, preview)) return
      const decision = await waitForProjectTaskDirectScheduleDecision(request)
      if (decision !== 'confirmed') return
      const confirmedTask = await callbacks.confirm(task, operation, preview)
      completeProjectTaskDirectScheduleMutation(request, confirmedTask)
    } catch (error) {
      failProjectTaskDirectSchedule(request, error)
    }
  })()

  return handle
}
