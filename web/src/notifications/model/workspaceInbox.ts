import type { ProjectTask } from '../../tasks/api'
import {
  createWorkspaceActionQueue,
  hasApprovalAttention,
  isWorkspaceTaskInReview,
  isWorkspaceTaskOverdue,
} from '../../work-items/model/workspaceWorkItems'

/**
 * Attention reason displayed for a Work Item in the Workspace Inbox.
 */
export type WorkspaceInboxReason =
  | 'approval'
  | 'approval-overdue'
  | 'high-priority'
  | 'overdue'
  | 'review'
  | 'watch'

/**
 * Selects Work Items displayed in the Workspace Inbox attention queue.
 *
 * @param tasks - Workspace Work Items to inspect.
 * @param referenceDate - Date used to determine whether a Work Item is overdue.
 * @returns Inbox Work Items ordered by action priority.
 */
export function createWorkspaceInboxTasks(
  tasks: readonly ProjectTask[],
  referenceDate: Date,
) {
  return createWorkspaceActionQueue(tasks, referenceDate)
    .filter((task) =>
      task.priority === 'high' ||
      isWorkspaceTaskInReview(task) ||
      isWorkspaceTaskOverdue(task, referenceDate) ||
      hasApprovalAttention(task),
    )
}

/**
 * Resolves the ordered reasons for displaying a Work Item in the Inbox.
 *
 * @param task - Work Item whose attention reasons are required.
 * @param referenceDate - Date used to determine whether the Work Item is overdue.
 * @returns Reasons representing due date, priority, review, and approval attention.
 */
export function createWorkspaceInboxReasons(
  task: ProjectTask,
  referenceDate: Date,
): WorkspaceInboxReason[] {
  const reasons: WorkspaceInboxReason[] = []

  if (isWorkspaceTaskOverdue(task, referenceDate)) {
    reasons.push('overdue')
  }

  if (task.priority === 'high') {
    reasons.push('high-priority')
  }

  if (isWorkspaceTaskInReview(task)) {
    reasons.push('review')
  }

  if (task.approvalSummary?.overdueCount) {
    reasons.push('approval-overdue')
  } else if (hasApprovalAttention(task)) {
    reasons.push('approval')
  }

  return reasons.length > 0 ? reasons : ['watch']
}
