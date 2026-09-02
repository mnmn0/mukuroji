/** Schema version for Work Item Type definitions. */
export const WORK_ITEM_TYPE_SCHEMA_VERSION = 1 as const

/** Stable identifier of the built-in Work Item Type. */
export const DEFAULT_WORK_ITEM_TYPE_ID = 'default'

/** Lifecycle state of a Work Item Type definition. */
export type WorkItemTypeStatus = 'active' | 'archived'

/** Detail-pane sections that a Work Item Type may expose. */
export type WorkItemDetailSectionId =
  | 'overview'
  | 'description'
  | 'custom-fields'
  | 'workflow'
  | 'schedule'
  | 'relations'
  | 'files'
  | 'activity'

/**
 * Workspace- or Team-scoped definition of a canonical Work Item Type.
 */
export type WorkItemType = {
  /** Stable identifier referenced by canonical Work Items and automations. */
  id: string
  /** Human-readable name shown in Work Item creation and list surfaces. */
  name: string
  /** Shared icon token rendered by the client icon registry. */
  iconToken: string
  /** Optional explanatory text shown by the type picker and administration UI. */
  description?: string
  /** Whether new Work Items may use this definition. */
  status: WorkItemTypeStatus
  /** Workflow identifier selected when a Work Item of this type is created. */
  defaultWorkflowId: string
  /** Custom field definitions available to this type. Empty means none for user-defined types. */
  customFieldIds: string[]
  /** Subset of `customFieldIds` that must be present before saving. */
  requiredCustomFieldIds: string[]
  /** Ordered detail-pane sections rendered for this type. */
  detailSections: WorkItemDetailSectionId[]
  /** Type identifiers that may be used for direct child Work Items. */
  allowedChildTypeIds: string[]
  /** Stable administration and picker ordering. */
  sortOrder: number
}

/** Explicit name used by configuration APIs for a Work Item Type definition. */
export type WorkItemTypeDefinition = WorkItemType

/** Built-in fallback type retained for legacy Work Items and empty configurations. */
export const DEFAULT_WORK_ITEM_TYPE: WorkItemType = {
  id: DEFAULT_WORK_ITEM_TYPE_ID,
  name: 'Work Item',
  iconToken: 'work-item',
  status: 'active',
  defaultWorkflowId: 'default-workflow',
  customFieldIds: [],
  requiredCustomFieldIds: [],
  detailSections: [
    'overview',
    'description',
    'custom-fields',
    'workflow',
    'schedule',
    'relations',
    'files',
    'activity',
  ],
  allowedChildTypeIds: [DEFAULT_WORK_ITEM_TYPE_ID],
  sortOrder: 0,
}

/** Client-supplied acknowledgement for data affected by a type change. */
export type WorkItemTypeChangeResolution = {
  /** Field identifiers the user explicitly accepts removing. */
  discardCustomFieldIds: string[]
  /** Replacement status when the current status is not in the target workflow. */
  workflowStatusId?: string
}

/** Request used to calculate a non-mutating Work Item Type change preview. */
export type PreviewWorkItemTypeChangeInput = {
  /** Revision observed before previewing the change. */
  expectedRevision: number
  /** Type that would replace the current Work Item Type. */
  targetWorkItemTypeId: string
  /** Proposed Project assignment; `null` previews clearing the assignment. */
  assignedProjectId?: string | null
}

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
  /** Whether an explicit resolution is required before mutation. */
  requiresResolution: boolean
}
