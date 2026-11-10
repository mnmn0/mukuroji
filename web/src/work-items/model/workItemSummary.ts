import type {
  WorkItemSummaryBucket,
  WorkItemSummaryResponse,
} from '@mukuroji/contracts'
import type { CanonicalWorkItem } from '../../tasks/api'
import {
  isCompletedWorkItem,
  isOpenWorkItem,
  resolveWorkItemAssignee,
} from './workItemDisplay'
import {
  isWorkspaceTaskInReview,
  isWorkspaceTaskOverdue,
} from './workspaceWorkItems'

/**
 * Counts already loaded Work Items with the same rules as `GET /api/work-items/summary`.
 *
 * Views that hold a complete, small Work Item list (Storybook fixtures, a single Team) can reuse
 * the summary-based components without another request.
 *
 * @param workItems - Non-archived Work Items to count.
 * @param now - Instant used to decide which Work Items are overdue.
 * @returns Totals and one bucket per Team and Project.
 */
export function createWorkItemSummaryFromWorkItems(
  workItems: readonly CanonicalWorkItem[],
  now: Date,
): WorkItemSummaryResponse {
  const buckets = new Map<string, WorkItemSummaryBucket>()

  for (const workItem of workItems) {
    if (workItem.archivedAt !== undefined) continue
    const key = `${workItem.teamId}\0${workItem.assignedProjectId ?? ''}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        teamId: workItem.teamId,
        ...(workItem.assignedProjectId ? { projectId: workItem.assignedProjectId } : {}),
        total: 0,
        open: 0,
        completed: 0,
        highPriorityOpen: 0,
        overdueOpen: 0,
        attentionOpen: 0,
        inReview: 0,
        assignees: [],
      }
      buckets.set(key, bucket)
    }
    bucket.total += 1
    if (isCompletedWorkItem(workItem)) bucket.completed += 1
    if (isWorkspaceTaskInReview(workItem)) bucket.inReview += 1
    if (isOpenWorkItem(workItem)) {
      bucket.open += 1
      const highPriority = workItem.priority === 'high'
      const overdue = isWorkspaceTaskOverdue(workItem, now)
      if (highPriority) bucket.highPriorityOpen += 1
      if (overdue) bucket.overdueOpen += 1
      if (highPriority || overdue) bucket.attentionOpen += 1
    }
    const assigneeId = workItem.assigneeUserId.trim()
    if (assigneeId && !bucket.assignees.some((assignee) => assignee.id === assigneeId)) {
      bucket.assignees.push({ id: assigneeId, label: resolveWorkItemAssignee(workItem) })
    }
  }

  const summaryBuckets = [...buckets.values()]
  return {
    generatedAt: now.toISOString(),
    totals: {
      total: summaryBuckets.reduce((sum, bucket) => sum + bucket.total, 0),
      open: summaryBuckets.reduce((sum, bucket) => sum + bucket.open, 0),
      completed: summaryBuckets.reduce((sum, bucket) => sum + bucket.completed, 0),
    },
    buckets: summaryBuckets,
  }
}
