import type { CustomFieldDefinition } from './work-item-configuration'

/** Server-calculated impact of changing a Work Item Type. */
export type WorkItemTypeChangePreview = {
  /** Revision that must still match when the change is applied. */
  expectedRevision: number
  /** Current stable type identifier, including the built-in fallback for legacy rows. */
  currentWorkItemTypeId: string
  /** Current workflow status identifier on the Work Item. */
  currentWorkflowStatusId: string
  /** Proposed stable type identifier. */
  targetWorkItemTypeId: string
  /** Fields that are not available in the target type and would be removed. */
  lostCustomFieldIds: string[]
  /** Current status when it is not defined by the target workflow. */
  invalidWorkflowStatusId?: string
  /** Target workflow's initial status. */
  targetInitialWorkflowStatusId: string
  /** Required target fields that are currently missing. */
  missingRequiredCustomFieldIds: string[]
  /** Definitions needed to collect the currently missing required target fields. */
  missingRequiredCustomFieldDefinitions: CustomFieldDefinition[]
  /** Whether an explicit resolution is required before mutation. */
  requiresResolution: boolean
}
