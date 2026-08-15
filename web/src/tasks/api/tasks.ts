import type {
  CanonicalWorkItem,
  CreateWorkItemInput,
  WorkItemPriority,
  WorkItemStatus,
} from '@mukuroji/contracts'

/** Canonical Work Item status consumed by the Task UI. */
export type TaskStatus = WorkItemStatus

/** Canonical Work Item priority consumed by the Task UI. */
export type TaskPriority = WorkItemPriority

/** Canonical Work Item model consumed by the Task UI. */
export type ProjectTask = CanonicalWorkItem

/** Canonical Work Item creation input consumed by the Task UI form. */
export type CreateProjectTaskInput = CreateWorkItemInput
