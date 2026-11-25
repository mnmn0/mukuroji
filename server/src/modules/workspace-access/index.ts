/** Workspace Access module public application and domain surface. */
export type { WorkspaceRole } from './domain/workspace-role'
export {
  canMemberAccessExpire,
  isMemberAccessExpired,
  isWorkspaceMemberRowActive,
  readMemberAccessExpiry,
} from './domain/member-access-expiry'
export {
  isActivePlanningEntityOwnedBy,
  isManagerProjectAccess,
  listMemberDeactivationBlockers,
  type MemberDeactivationBlocker,
  type MemberDeactivationBlockerState,
} from './domain/member-deactivation-blockers'
export {
  requirePrivateDocumentManagerContinuity,
  type DocumentManagerLifecycleDependencies,
} from './document-manager-lifecycle'
export {
  readMemberOffboarding,
  type MemberOffboardingPorts,
} from './application/member-offboarding'
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
  type WorkspaceMemberSystemAdministratorAction,
  type WorkspaceMemberProvisioningSource,
  type WorkspaceMemberResponse,
  type WorkspaceMemberVersionConditionInput,
  type WorkspaceMemberStatus,
  type WorkspaceAccessTransactWriteItem,
  type MemberCredentialRevocationRecord,
} from './workspace-access'
export type {
  MemberCredentialRevoker,
  RevokedMemberCredentials,
} from './application/member-credential-revoker'
export {
  revokeManagedMemberCredentials,
  type ManagedMemberCredentialRevocationInput,
  type ManagedMemberCredentialRevocationPorts,
} from './application/managed-member-credential-revocation'
export {
  reconcileDirectoryMemberAccess,
  type DirectoryMemberReconciliationInput,
  type DirectoryMemberReconciliationPorts,
} from './application/directory-member-reconciliation'
export {
  updateMemberMembership,
  type MemberMembershipUpdateInput,
  type MemberMembershipUpdatePorts,
} from './application/member-membership-update'
export {
  resetMemberCredential,
  type MemberCredentialResetInput,
  type MemberCredentialResetPorts,
  type MemberSignInAccount,
} from './application/member-credential-reset'
export {
  changeMemberSystemAdministrator,
  type MemberSystemAdministratorInput,
  type MemberSystemAdministratorPorts,
  type MemberSystemAdministratorResult,
} from './application/member-system-administrator'
export {
  listMembersSignInSecurity,
  summarizeMfaEnrollment,
  type MemberSignInProfile,
  type MemberSignInSecurityPorts,
} from './application/member-sign-in-security'
