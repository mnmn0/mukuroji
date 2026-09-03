/** Stable categories emitted by a cross-domain check or source/restore comparison. */
export type CrossDomainIntegrityFailureCode =
  | 'AUDIT_RESOURCE_MISSING'
  | 'AUDIT_TENANT_MISMATCH'
  | 'CONFIGURATION_DUPLICATE_SCOPE'
  | 'CURSOR_LOOP'
  | 'DUPLICATE_RECORD'
  | 'FILE_METADATA_OBJECT_MISMATCH'
  | 'FILE_METADATA_OBJECT_MISSING'
  | 'FILE_METADATA_REFERENCE_MISSING'
  | 'FILE_METADATA_TENANT_MISMATCH'
  | 'FILE_OBJECT_METADATA_MISSING'
  | 'INTEGRITY_LIMIT_EXCEEDED'
  | 'RELATION_ENDPOINT_MISSING'
  | 'RELATION_ENDPOINT_TEAM_MISMATCH'
  | 'RELATION_PROJECT_MISSING'
  | 'RELATION_PROJECT_TEAM_MISMATCH'
  | 'RELATION_RECIPROCAL_MISSING'
  | 'RELATION_TEAM_MISSING'
  | 'RELATION_TENANT_MISMATCH'
  | 'RELATION_WORK_ITEM_TYPE_MISMATCH'
  | 'RESTORE_AUDIT_DIFFERENCE'
  | 'RESTORE_CHECK_FAILED'
  | 'RESTORE_CONFIGURATION_DIFFERENCE'
  | 'RESTORE_FILE_DIFFERENCE'
  | 'RESTORE_RELATION_DIFFERENCE'
  | 'RESTORE_RESOURCE_DIFFERENCE'
  | 'RESTORE_WORK_ITEM_DIFFERENCE'
  | 'SOURCE_CHECK_FAILED'
  | 'SOURCE_RESULT_AUTHENTICATION_FAILED'
  | 'SOURCE_RESTORE_CHECKED_AT_MISMATCH'
  | 'SOURCE_RESTORE_KEY_MISMATCH'
  | 'SOURCE_RESTORE_LIMITS_MISMATCH'
  | 'SOURCE_RESTORE_RESOURCE_BINDING_MISMATCH'
  | 'SOURCE_RESTORE_RESOURCE_IDENTITY_REUSED'
  | 'SOURCE_RESTORE_ROLE_MISMATCH'
  | 'RESTORE_RESULT_AUTHENTICATION_FAILED'
  | 'WORK_ITEM_CREATOR_MEMBER_MISSING'
  | 'WORK_ITEM_CREATOR_TENANT_MISMATCH'
  | 'WORK_ITEM_PROJECT_MISSING'
  | 'WORK_ITEM_PROJECT_TEAM_MISMATCH'
  | 'WORK_ITEM_RELATION_PROJECTION_MISMATCH'
  | 'WORK_ITEM_STATUS_CATEGORY_MISMATCH'
  | 'WORK_ITEM_TEAM_MISSING'
  | 'WORK_ITEM_TENANT_MISMATCH'
  | 'WORK_ITEM_TYPE_UNKNOWN'
  | 'WORK_ITEM_WORKFLOW_STATUS_UNKNOWN'

/** Canonical workflow status category used by Work Items and configuration. */
export type CrossDomainWorkflowStatusCategory =
  | 'backlog'
  | 'canceled'
  | 'completed'
  | 'started'
  | 'unstarted'

/** One normalized configuration workflow status. */
export type CrossDomainWorkflowStatus = {
  /** Stable workflow status ID. */
  statusId: string
  /** Canonical category projected to Work Items. */
  category: CrossDomainWorkflowStatusCategory
  /** Workflow that owns this status. */
  workflowId: string
}

/** One normalized Work Item Type to Workflow assignment. */
export type CrossDomainWorkItemTypeWorkflow = {
  /** Stable Work Item Type ID. */
  workItemTypeId: string
  /** Workflow selected by the Work Item Type. */
  workflowId: string
  /** Work Item Type IDs accepted as direct children of this type. */
  allowedChildTypeIds: readonly string[]
}

/** A normalized workflow configuration row. */
export type CrossDomainConfigurationItem = {
  /** Item discriminator. */
  kind: 'configuration'
  /** Owning Workspace, which is the checker tenant boundary. */
  workspaceId: string
  /** Team override owner, or null for a Workspace default. */
  teamId: string | null
  /** Status IDs and canonical categories accepted by this configuration snapshot. */
  workflowStatuses: readonly CrossDomainWorkflowStatus[]
  /** Workflow selected by each Work Item Type in this configuration snapshot. */
  workItemTypeWorkflows: readonly CrossDomainWorkItemTypeWorkflow[]
}

/** A normalized canonical Work Item row. */
export type CrossDomainWorkItem = {
  /** Item discriminator. */
  kind: 'work-item'
  /** Owning Workspace. */
  workspaceId: string
  /** Owning Team. */
  teamId: string
  /** Stable Work Item ID. */
  workItemId: string
  /** Stable Work Item Type ID, including the built-in fallback for legacy rows. */
  workItemTypeId: string
  /** Workspace member key captured when the Work Item was created. */
  creatorMemberKey: string
  /** Workflow status stored on the Work Item. */
  workflowStatusId: string
  /** Canonical category stored beside the status projection. */
  statusCategory: CrossDomainWorkflowStatusCategory
  /** Optional assigned Project. */
  projectId: string | null
  /** Sorted relation projection stored on the canonical Work Item. */
  relationIds: readonly string[]
}

/** A normalized Workspace membership row. */
export type CrossDomainWorkspaceMember = {
  /** Item discriminator. */
  kind: 'workspace-member'
  /** Owning Workspace. */
  workspaceId: string
  /** Stable member key, including deactivated historical members. */
  memberKey: string
}

/** A normalized Team resource. */
export type CrossDomainTeam = {
  /** Item discriminator. */
  kind: 'team'
  /** Owning Workspace. */
  workspaceId: string
  /** Stable Team ID. */
  teamId: string
}

/** A normalized Project resource. */
export type CrossDomainProject = {
  /** Item discriminator. */
  kind: 'project'
  /** Owning Workspace. */
  workspaceId: string
  /** Owning Team. */
  teamId: string
  /** Stable Project ID. */
  projectId: string
}

/** Relation types stored as reciprocal graph projections. */
export type CrossDomainRelationType =
  | 'blockedBy'
  | 'blocks'
  | 'child'
  | 'duplicate'
  | 'parent'
  | 'related'

/** A normalized relation graph projection. */
export type CrossDomainRelation = {
  /** Item discriminator. */
  kind: 'relation'
  /** Owning Workspace. */
  workspaceId: string
  /** Owning Team scope. */
  teamId: string
  /** Source Work Item ID. */
  sourceWorkItemId: string
  /** Target Work Item ID. */
  targetWorkItemId: string
  /** Directional relation type. */
  relationType: CrossDomainRelationType
}

/** Current resource kinds whose audit references can be joined mechanically. */
export type CrossDomainAuditResourceType =
  | 'file'
  | 'project'
  | 'team'
  | 'work-item'
  | 'workspace-member'

/** A normalized audit resource reference. */
export type CrossDomainAuditReference = {
  /** Item discriminator. */
  kind: 'audit-reference'
  /** Workspace that owns the audit event. */
  workspaceId: string
  /** Workspace encoded by the referenced resource. */
  referencedWorkspaceId: string
  /** Known resource kind. */
  resourceType: CrossDomainAuditResourceType
  /** Stable resource ID normalized by the audit adapter. */
  resourceId: string
  /** Team required to disambiguate Team-owned resources. */
  teamId: string | null
  /** Whether the resource must still exist for this event lifecycle. */
  resourceState: 'current' | 'historical'
}

/** Canonical scan status compared between file metadata and an exact object version. */
export type CrossDomainFileScanStatus =
  | 'available'
  | 'blocked'
  | 'failed'
  | 'pending'
  | 'scanning'

/** One normalized file metadata version reference. */
export type CrossDomainFileMetadata = {
  /** Item discriminator. */
  kind: 'file-metadata'
  /** Owning Workspace. */
  workspaceId: string
  /** Owning Team. */
  teamId: string
  /** Stable File ID. */
  fileId: string
  /** Stable application File version ID. */
  versionId: string
  /** Attachment target kind. */
  targetType: 'project' | 'work-item'
  /** Project or Work Item target ID. */
  targetId: string
  /** Exact internal object key; retained in memory only. */
  objectKey: string
  /** Exact immutable object-store version ID. */
  objectVersionId: string
  /** Expected media type. */
  contentType: string
  /** Expected byte count. */
  sizeBytes: number
  /** Expected malware scan state. */
  scanStatus: CrossDomainFileScanStatus
}

/** Metadata observed from one exact object-store version. */
export type CrossDomainFileObject = {
  /** Item discriminator. */
  kind: 'file-object'
  /** Exact internal object key; retained in memory only. */
  objectKey: string
  /** Exact immutable object-store version ID. */
  objectVersionId: string
  /** Workspace encoded by the object namespace or trusted metadata. */
  workspaceId: string
  /** File ID encoded by the object namespace or trusted metadata. */
  fileId: string
  /** Application File version ID encoded by the object namespace or metadata. */
  versionId: string
  /** Observed media type. */
  contentType: string
  /** Observed byte count. */
  sizeBytes: number
  /** Observed malware scan state. */
  scanStatus: CrossDomainFileScanStatus
}

/** Normalized records shared by integrity scripts and restore-drill verification. */
export type CrossDomainIntegrityItem =
  | CrossDomainAuditReference
  | CrossDomainConfigurationItem
  | CrossDomainFileMetadata
  | CrossDomainFileObject
  | CrossDomainProject
  | CrossDomainRelation
  | CrossDomainTeam
  | CrossDomainWorkItem
  | CrossDomainWorkspaceMember
