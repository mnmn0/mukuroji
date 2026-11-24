/** Workspace Access module public application and domain surface. */
export type { WorkspaceRole } from './domain/workspace-role'
export {
  canMemberAccessExpire,
  isMemberAccessExpired,
  readMemberAccessExpiry,
} from './domain/member-access-expiry'
export {
  requirePrivateDocumentManagerContinuity,
  type DocumentManagerLifecycleDependencies,
} from './document-manager-lifecycle'
export {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
  createWorkspaceMemberVersionConditionCheck,
  isWorkspaceIdentitySafeToDelete,
  type CreateWorkspaceInvitationInput,
  type DeprovisionDirectoryWorkspaceMemberInput,
  type ExpireWorkspaceMemberInput,
  type MarkWorkspaceInvitationCleanupFailureInput,
  type MarkWorkspaceInvitationDeliveryInput,
  type ReconcileAuthenticatedWorkspaceMemberInput,
  type ReconcileDirectoryWorkspaceMemberInput,
  type UpdateWorkspaceMemberAccessExpiryInput,
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
  type WorkspaceMemberCredentialAction,
  type WorkspaceMemberCredentialProgress,
  type WorkspaceMemberCredentialRecord,
  type WorkspaceMemberProvisioningSource,
  type WorkspaceMemberResponse,
  type WorkspaceMemberVersionConditionInput,
  type WorkspaceMemberStatus,
  type WorkspaceAccessTransactWriteItem,
} from './workspace-access'
export {
  resetMemberCredential,
  type MemberCredentialResetInput,
  type MemberCredentialResetPorts,
  type MemberSignInAccount,
} from './application/member-credential-reset'
export {
  listMembersSignInSecurity,
  summarizeMfaEnrollment,
  type MemberSignInProfile,
  type MemberSignInSecurityPorts,
} from './application/member-sign-in-security'
