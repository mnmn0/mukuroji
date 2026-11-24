import {
  createDefaultDueDateWorkItemSchedule,
  createDefaultUnscheduledWorkItemSchedule,
  type WorkItemPriority,
  type WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'
import { createTeamIssue } from '../../issues/api'
import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import type { MyTasksQuickCreateInput } from '../model/myTasksQuickCreate'
import { revalidateWorkItemKeyPrefixes } from '../../issues/queries/workItemKeyPrefixesCache'

/** Inputs for creating one Work Item from the My Tasks quick create form. */
export type CreateMyTasksQuickCreateWorkItemOptions = {
  /** Access token used to create the Work Item. */
  accessToken: string
  /** Person the new Work Item is assigned to. */
  assigneeUserId: string
  /** Workspace calendar copied into the new schedule; the default calendar when omitted. */
  calendarPolicy?: WorkItemScheduleCalendarPolicy
  /** Wrapper that applies Enterprise session policy to the request. */
  guardRequest: <Result>(request: Promise<Result>) => Promise<Result>
  /** Values submitted by the form. */
  input: MyTasksQuickCreateInput
  /** Runner that keeps one idempotency key per repeated submit. */
  mutationRequestRunner: MutationRequestRunner
  /** Reads the My Tasks list again after the Work Item is created; a failed read is ignored. */
  refreshWorkItems: () => Promise<unknown>
}

/**
 * Creates a Work Item assigned to the current person and reads the My Tasks list again.
 *
 * Rejects only when the create itself fails.
 *
 * @param options - Request inputs, the submitted form values, and the list refresh.
 * @returns A promise that resolves once the Work Item is created and the list is read again.
 */
export async function createMyTasksQuickCreateWorkItem({
  accessToken,
  assigneeUserId,
  calendarPolicy,
  guardRequest,
  input: { destination, dueDate, title },
  mutationRequestRunner,
  refreshWorkItems,
}: CreateMyTasksQuickCreateWorkItemOptions): Promise<void> {
  const defaultSchedule = dueDate
    ? createDefaultDueDateWorkItemSchedule(dueDate)
    : createDefaultUnscheduledWorkItemSchedule()
  const schedule = calendarPolicy
    ? { ...defaultSchedule, calendarPolicy: structuredClone(calendarPolicy) }
    : defaultSchedule
  const priority: WorkItemPriority = 'medium'
  const request = {
    ...(destination.projectId ? { assignedProjectId: destination.projectId } : {}),
    assigneeUserId,
    priority,
    schedule,
    title,
  }
  await guardRequest(mutationRequestRunner.run(
    `my-tasks:quick-create:${destination.key}`,
    JSON.stringify(request),
    (context) => createTeamIssue(destination.teamId, accessToken, request, context),
  ))
  // The Work Item exists once the create succeeds; a failed read must not invite a duplicate
  // submit, so the list is left to its next revalidation.
  void revalidateWorkItemKeyPrefixes()
  await refreshWorkItems().catch(() => undefined)
}
