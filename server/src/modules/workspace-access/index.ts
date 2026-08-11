/** Workspace Access module public application and domain surface. */
export type { WorkspaceRole } from './domain/workspace-role'
export {
  requirePrivateDocumentManagerContinuity,
  type DocumentManagerLifecycleDependencies,
} from './document-manager-lifecycle'
export {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
  isWorkspaceIdentitySafeToDelete,
  type CreateWorkspaceInvitationInput,
  type DeprovisionDirectoryWorkspaceMemberInput,
  type MarkWorkspaceInvitationCleanupFailureInput,
  type MarkWorkspaceInvitationDeliveryInput,
  type ReconcileAuthenticatedWorkspaceMemberInput,
  type ReconcileDirectoryWorkspaceMemberInput,
  type UpdateWorkspaceMemberInput,
  type WorkspaceAccessCapabilities,
  type WorkspaceAccessClient,
  type WorkspaceAccessResponse,
  type WorkspaceActiveMemberConditionOptions,
  type WorkspaceIdentityOwnership,
  type WorkspaceInvitation,
  type WorkspaceInvitationDeliveryStatus,
  type WorkspaceInvitationResponse,
  type WorkspaceInvitationStatus,
  type WorkspaceMember,
  type WorkspaceMemberProvisioningSource,
  type WorkspaceMemberResponse,
  type WorkspaceMemberStatus,
  type WorkspaceAccessTransactWriteItem,
} from './workspace-access'
