import type {
  EnterpriseBreakGlassAccount,
  EnterpriseBreakGlassActivation,
  EnterpriseCustomRole,
  EnterpriseDirectoryGroupMapping,
  EnterpriseIdentityProvider,
  EnterpriseIdentitySnapshot,
  EnterpriseIssuedCredential,
  EnterpriseIssuedServiceAccountCredential,
  EnterpriseProvisioningInput,
  EnterpriseProvisioningPreview,
  EnterpriseProvisioningRun,
  EnterpriseScimCredential,
  EnterpriseScimGroup,
  EnterpriseScimGroupInput,
  EnterpriseScimUser,
  EnterpriseScimUserInput,
  EnterpriseSecurityPolicy,
  EnterpriseServiceAccount,
  EnterpriseVerifiedDomain,
} from '@mukuroji/contracts'
import type { MutationAuditContext } from '../../../audit'
import type {
  EnterpriseScimGroupJobApplyUser,
  EnterpriseScimGroupJobProcessResult,
  EnterpriseScimGroupListInput,
  EnterpriseScimGroupPage,
  EnterpriseScimUserListInput,
  EnterpriseScimUserPage,
  EnterpriseScimWorkspaceAuthentication,
} from '../scim-contracts'
import type { EnterpriseScimGroupJobReference } from '../../domain/scim-group-job-reference'

/** Port that reads Enterprise security state without credential-secret capabilities. */
export interface EnterpriseIdentityReadCapability {
  /**
   * Returns the Enterprise Identity and security snapshot for a workspace.
   *
   * @param workspaceId - Workspace identifier.
   * @returns The authoritative snapshot.
   */
  getSnapshot(workspaceId: string): Promise<EnterpriseIdentitySnapshot>
  /**
   * Returns an active elevation for the member's current authentication session.
   *
   * @param workspaceId - Workspace identifier.
   * @param memberKey - Canonical member key.
   * @param authenticationSessionId - Current authentication session identifier.
   * @returns The active elevation when one exists.
   */
  getActiveBreakGlassActivation(
    workspaceId: string,
    memberKey: string,
    authenticationSessionId: string,
  ): Promise<EnterpriseBreakGlassActivation | undefined>
}

/** Read-only application port for public SSO discovery. */
export interface EnterpriseSsoDiscoveryCapability {
  /**
   * Returns the active SSO provider applicable to an email domain.
   *
   * @param email - Email address used for domain discovery.
   * @returns The verified domain and active provider when configured.
   */
  discoverSso(email: string): Promise<{
    /** Verified domain claim selected by the email suffix. */
    domain: EnterpriseVerifiedDomain
    /** Active provider bound to the verified domain. */
    provider: EnterpriseIdentityProvider
  } | undefined>
}

/** Administrative application port for identity providers and verified domains. */
export interface EnterpriseIdentityProviderAdministrationCapability {
  /**
   * Safely upserts a SAML or OIDC provider.
   *
   * @param provider - Validated provider state.
   * @param auditContext - Optional immutable audit context.
   * @returns The persisted provider.
   */
  putIdentityProvider(
    provider: EnterpriseIdentityProvider,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIdentityProvider>
  /**
   * Safely upserts a verified-domain claim.
   *
   * @param domain - Validated domain claim.
   * @param auditContext - Optional immutable audit context.
   * @returns The persisted domain claim.
   */
  putVerifiedDomain(
    domain: EnterpriseVerifiedDomain,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseVerifiedDomain>
  /**
   * Updates SSO enforcement for all verified domains in one transaction.
   *
   * @param workspaceId - Workspace identifier.
   * @param enforced - Whether SSO must be enforced.
   * @param identityProviderId - Provider selected for enforced domains.
   * @param expectedProviderRevision - Provider revision used as a concurrency fence.
   * @param auditContext - Optional immutable audit context.
   * @returns The updated verified domains.
   */
  setSsoEnforcement(
    workspaceId: string,
    enforced: boolean,
    identityProviderId: string | undefined,
    expectedProviderRevision: number,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseVerifiedDomain[]>
}

/** Application port for security policies, custom roles, and directory mappings. */
export interface EnterpriseAuthorizationAdministrationCapability {
  /**
   * Safely upserts an authentication and session policy.
   *
   * @param policy - Validated security policy.
   * @param auditContext - Optional immutable audit context.
   * @returns The persisted policy.
   */
  putSecurityPolicy(
    policy: EnterpriseSecurityPolicy,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseSecurityPolicy>
  /**
   * Safely upserts a custom role.
   *
   * @param role - Validated custom role.
   * @param auditContext - Optional immutable audit context.
   * @returns The persisted role.
   */
  putCustomRole(
    role: EnterpriseCustomRole,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseCustomRole>
  /**
   * Deletes an unused custom role.
   *
   * @param workspaceId - Workspace identifier.
   * @param roleId - Custom role identifier.
   * @param expectedRevision - Role revision used as a concurrency fence.
   * @param auditContext - Optional immutable audit context.
   * @returns A promise that resolves after deletion.
   */
  deleteCustomRole(
    workspaceId: string,
    roleId: string,
    expectedRevision: number,
    auditContext?: MutationAuditContext,
  ): Promise<void>
  /**
   * Safely upserts a directory-group mapping.
   *
   * @param mapping - Validated directory-group mapping.
   * @param auditContext - Optional immutable audit context.
   * @returns The persisted mapping.
   */
  putGroupMapping(
    mapping: EnterpriseDirectoryGroupMapping,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseDirectoryGroupMapping>
  /**
   * Deletes a directory-group mapping.
   *
   * @param workspaceId - Workspace identifier.
   * @param mappingId - Mapping identifier.
   * @param expectedRevision - Mapping revision used as a concurrency fence.
   * @param auditContext - Optional immutable audit context.
   * @returns A promise that resolves after deletion.
   */
  deleteGroupMapping(
    workspaceId: string,
    mappingId: string,
    expectedRevision: number,
    auditContext?: MutationAuditContext,
  ): Promise<void>
}

/** Application port for SCIM user and group desired state. */
export interface EnterpriseScimDirectoryCapability {
  /**
   * Reads one page of a provider-scoped SCIM user collection.
   *
   * @param input - Validated collection and pagination input.
   * @returns One SCIM user page.
   */
  listScimUsers(input: EnterpriseScimUserListInput): Promise<EnterpriseScimUserPage>
  /**
   * Reads one page of a provider-scoped SCIM group collection.
   *
   * @param input - Validated collection and pagination input.
   * @returns One SCIM group page.
   */
  listScimGroups(input: EnterpriseScimGroupListInput): Promise<EnterpriseScimGroupPage>
  /**
   * Idempotently upserts SCIM user desired state.
   *
   * @param input - Validated SCIM user input.
   * @param auditContext - Optional immutable audit context.
   * @returns The desired SCIM user.
   */
  upsertScimUser(
    input: EnterpriseScimUserInput,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimUser>
  /**
   * Idempotently deactivates SCIM user desired state.
   *
   * @param workspaceId - Workspace identifier.
   * @param identityProviderId - Owning provider identifier.
   * @param userId - SCIM user identifier.
   * @param idempotencyKey - Operation-scoped idempotency key.
   * @param auditContext - Optional immutable audit context.
   * @returns The deactivated user when it exists.
   */
  deactivateScimUser(
    workspaceId: string,
    identityProviderId: string,
    userId: string,
    idempotencyKey: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimUser | undefined>
  /**
   * Checkpoints successful workspace application of a SCIM user version.
   *
   * @param workspaceId - Workspace identifier.
   * @param userId - SCIM user identifier.
   * @param desiredVersion - Desired version that was applied.
   * @param auditContext - Optional immutable audit context.
   * @returns The checkpointed user.
   */
  markScimUserApplied(
    workspaceId: string,
    userId: string,
    desiredVersion: number,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimUser>
  /**
   * Idempotently upserts SCIM group desired state.
   *
   * @param input - Validated SCIM group input.
   * @param auditContext - Optional immutable audit context.
   * @returns The desired SCIM group.
   */
  upsertScimGroup(
    input: EnterpriseScimGroupInput,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimGroup>
  /**
   * Idempotently deactivates SCIM group desired state.
   *
   * @param workspaceId - Workspace identifier.
   * @param identityProviderId - Owning provider identifier.
   * @param groupId - SCIM group identifier.
   * @param idempotencyKey - Operation-scoped idempotency key.
   * @param auditContext - Optional immutable audit context.
   * @returns The deactivated group when it exists.
   */
  deactivateScimGroup(
    workspaceId: string,
    identityProviderId: string,
    groupId: string,
    idempotencyKey: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimGroup | undefined>
  /**
   * Checkpoints successful workspace application of a SCIM group version.
   *
   * @param workspaceId - Workspace identifier.
   * @param groupId - SCIM group identifier.
   * @param desiredVersion - Desired version that was applied.
   * @param auditContext - Optional immutable audit context.
   * @returns The checkpointed group.
   */
  markScimGroupApplied(
    workspaceId: string,
    groupId: string,
    desiredVersion: number,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimGroup>
  /**
   * Returns the stream reference for the current pending SCIM group job.
   *
   * @param workspaceId - Workspace identifier.
   * @param groupId - SCIM group identifier.
   * @returns The durable job reference when pending work exists.
   */
  getScimGroupJobReference(
    workspaceId: string,
    groupId: string,
  ): Promise<EnterpriseScimGroupJobReference | undefined>
  /**
   * Applies one durable SCIM group-job page and checkpoints it atomically.
   *
   * @param reference - Durable job reference.
   * @param applyUser - Sequential user-side-effect callback.
   * @param auditContext - Optional immutable audit context.
   * @returns The page processing result.
   */
  processScimGroupJob(
    reference: EnterpriseScimGroupJobReference,
    applyUser: EnterpriseScimGroupJobApplyUser,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseScimGroupJobProcessResult>
}

/** Administrative port for SCIM bearer issuance, rotation, and revocation. */
export interface EnterpriseScimCredentialAdministrationCapability {
  /**
   * Issues a SCIM bearer credential exactly once.
   *
   * @param workspaceId - Workspace identifier.
   * @param identityProviderId - Provider receiving the credential.
   * @param label - Administrative credential label.
   * @param expiresAt - Optional bounded expiry timestamp.
   * @param auditContext - Optional immutable audit context.
   * @returns One plaintext credential and its public metadata.
   */
  issueScimToken(
    workspaceId: string,
    identityProviderId: string,
    label: string,
    expiresAt?: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIssuedCredential>
  /**
   * Atomically revokes active SCIM credentials and issues a replacement.
   *
   * @param workspaceId - Workspace identifier.
   * @param identityProviderId - Provider receiving the replacement.
   * @param label - Administrative credential label.
   * @param expectedGeneration - Credential generation concurrency fence.
   * @param idempotencyKey - Operation-scoped idempotency key.
   * @param requestFingerprint - Canonical request fingerprint.
   * @param auditContext - Optional immutable audit context.
   * @returns One plaintext replacement credential and its metadata.
   */
  rotateScimToken(
    workspaceId: string,
    identityProviderId: string,
    label: string,
    expectedGeneration: number,
    idempotencyKey: string,
    requestFingerprint: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIssuedCredential>
  /**
   * Revokes a SCIM bearer credential.
   *
   * @param workspaceId - Workspace identifier.
   * @param credentialId - Credential identifier.
   * @param auditContext - Optional immutable audit context.
   * @returns A promise that resolves after revocation.
   */
  revokeScimToken(
    workspaceId: string,
    credentialId: string,
    auditContext?: MutationAuditContext,
  ): Promise<void>
}

/** Credential-verification port that cannot issue, rotate, or revoke SCIM tokens. */
export interface EnterpriseScimAuthenticationCapability {
  /**
   * Authenticates a SCIM bearer credential by digest.
   *
   * @param workspaceId - Workspace identifier.
   * @param token - Untrusted plaintext bearer token.
   * @returns Public credential metadata when authentication succeeds.
   */
  authenticateScimToken(
    workspaceId: string,
    token: string,
  ): Promise<EnterpriseScimCredential | undefined>
  /**
   * Authenticates a credential and current provider from the direct auth projection.
   *
   * @param workspaceId - Workspace identifier.
   * @param token - Untrusted plaintext bearer token.
   * @returns Credential and ready provider when authentication succeeds.
   */
  authenticateScimWorkspace(
    workspaceId: string,
    token: string,
  ): Promise<EnterpriseScimWorkspaceAuthentication | undefined>
}

/** Application port for provisioning previews, reconciliation, and retries. */
export interface EnterpriseProvisioningCapability {
  /**
   * Returns a mutation-free reconciliation impact preview.
   *
   * @param input - Validated provisioning input.
   * @param auditContext - Optional immutable audit context.
   * @returns The deterministic preview.
   */
  previewProvisioning(
    input: EnterpriseProvisioningInput,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseProvisioningPreview>
  /**
   * Returns an unexpired provisioning preview by ID.
   *
   * @param workspaceId - Workspace identifier.
   * @param previewId - Preview identifier.
   * @returns The preview when it remains valid.
   */
  getProvisioningPreview(
    workspaceId: string,
    previewId: string,
  ): Promise<EnterpriseProvisioningPreview | undefined>
  /**
   * Idempotently applies a confirmed preview.
   *
   * @param input - Validated provisioning input bound to a preview.
   * @param auditContext - Optional immutable audit context.
   * @returns The reserved provisioning run.
   */
  reconcileProvisioning(
    input: EnterpriseProvisioningInput,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseProvisioningRun>
  /**
   * Finalizes a reserved provisioning run with its side-effect outcome.
   *
   * @param workspaceId - Workspace identifier.
   * @param runId - Provisioning run identifier.
   * @param outcome - Side-effect outcome.
   * @param failureCode - Stable failure code for a failed outcome.
   * @param auditContext - Optional immutable audit context.
   * @returns The finalized run.
   */
  finalizeProvisioningRun(
    workspaceId: string,
    runId: string,
    outcome: 'succeeded' | 'failed',
    failureCode?: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseProvisioningRun>
  /**
   * Retries a failed provisioning run with the same plan.
   *
   * @param workspaceId - Workspace identifier.
   * @param runId - Failed provisioning run identifier.
   * @param auditContext - Optional immutable audit context.
   * @returns The reserved retry run.
   */
  retryProvisioning(
    workspaceId: string,
    runId: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseProvisioningRun>
}

/** Administrative application port for service-account and credential lifecycle. */
export interface EnterpriseServiceAccountAdministrationCapability {
  /**
   * Creates service-account metadata.
   *
   * @param account - Validated service-account metadata.
   * @param auditContext - Optional immutable audit context.
   * @returns The persisted account.
   */
  createServiceAccount(
    account: EnterpriseServiceAccount,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseServiceAccount>
  /**
   * Atomically and idempotently creates an account and its first credential.
   *
   * @param account - Validated service-account metadata.
   * @param idempotencyKey - Operation-scoped idempotency key.
   * @param requestFingerprint - Canonical request fingerprint.
   * @param auditContext - Optional immutable audit context.
   * @returns The account and one-time credential.
   */
  createServiceAccountWithToken(
    account: EnterpriseServiceAccount,
    idempotencyKey: string,
    requestFingerprint: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIssuedServiceAccountCredential & { account: EnterpriseServiceAccount }>
  /**
   * Issues a service-account credential exactly once.
   *
   * @param workspaceId - Workspace identifier.
   * @param accountId - Service-account identifier.
   * @param expiresAt - Optional bounded expiry timestamp.
   * @param auditContext - Optional immutable audit context.
   * @returns The one-time credential and public metadata.
   */
  issueServiceAccountToken(
    workspaceId: string,
    accountId: string,
    expiresAt?: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIssuedServiceAccountCredential>
  /**
   * Atomically revokes existing credentials and issues a replacement.
   *
   * @param workspaceId - Workspace identifier.
   * @param accountId - Service-account identifier.
   * @param expectedRevision - Account revision concurrency fence.
   * @param idempotencyKey - Operation-scoped idempotency key.
   * @param requestFingerprint - Canonical request fingerprint.
   * @param auditContext - Optional immutable audit context.
   * @returns The one-time replacement credential and metadata.
   */
  rotateServiceAccountToken(
    workspaceId: string,
    accountId: string,
    expectedRevision: number,
    idempotencyKey: string,
    requestFingerprint: string,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseIssuedServiceAccountCredential>
  /**
   * Revokes one service-account credential or the entire account.
   *
   * @param workspaceId - Workspace identifier.
   * @param accountId - Service-account identifier.
   * @param credentialId - Optional credential identifier.
   * @param expectedRevision - Optional account revision concurrency fence.
   * @param auditContext - Optional immutable audit context.
   * @returns A promise that resolves after revocation.
   */
  revokeServiceAccountToken(
    workspaceId: string,
    accountId: string,
    credentialId?: string,
    expectedRevision?: number,
    auditContext?: MutationAuditContext,
  ): Promise<void>
}

/** Authentication port that cannot administer service accounts or issue credentials. */
export interface EnterpriseServiceAccountAuthenticationCapability {
  /**
   * Authenticates a service-account bearer credential.
   *
   * @param workspaceId - Workspace identifier.
   * @param token - Untrusted plaintext bearer token.
   * @returns The active account when authentication succeeds.
   */
  authenticateServiceAccountToken(
    workspaceId: string,
    token: string,
  ): Promise<EnterpriseServiceAccount | undefined>
  /**
   * Updates last-used state and audit after all boundary checks succeed.
   *
   * @param workspaceId - Workspace identifier.
   * @param accountId - Service-account identifier.
   * @param auditContext - Optional immutable audit context.
   * @returns A promise that resolves after the update.
   */
  recordServiceAccountUse(
    workspaceId: string,
    accountId: string,
    auditContext?: MutationAuditContext,
  ): Promise<void>
}

/** Application port for break-glass accounts and session-scoped activations. */
export interface EnterpriseBreakGlassCapability {
  /**
   * Upserts break-glass account metadata.
   *
   * @param account - Validated break-glass account metadata.
   * @param auditContext - Optional immutable audit context.
   * @returns The persisted account.
   */
  putBreakGlassAccount(
    account: EnterpriseBreakGlassAccount,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseBreakGlassAccount>
  /**
   * Creates a reasoned, MFA-verified, time-bounded activation.
   *
   * @param workspaceId - Workspace identifier.
   * @param accountId - Break-glass account identifier.
   * @param actorMemberKey - Canonical member key.
   * @param authenticationSessionId - Current authentication session identifier.
   * @param reason - Operator-provided activation reason.
   * @param durationMinutes - Requested bounded duration.
   * @param auditContext - Optional immutable audit context.
   * @returns The active elevation.
   */
  activateBreakGlass(
    workspaceId: string,
    accountId: string,
    actorMemberKey: string,
    authenticationSessionId: string,
    reason: string,
    durationMinutes: number,
    auditContext?: MutationAuditContext,
  ): Promise<EnterpriseBreakGlassActivation>
  /**
   * Ends only the current member's active elevation.
   *
   * @param workspaceId - Workspace identifier.
   * @param actorMemberKey - Canonical member key.
   * @param authenticationSessionId - Current authentication session identifier.
   * @param auditContext - Optional immutable audit context.
   * @returns A promise that resolves after revocation.
   */
  revokeBreakGlassActivation(
    workspaceId: string,
    actorMemberKey: string,
    authenticationSessionId: string,
    auditContext?: MutationAuditContext,
  ): Promise<void>
  /**
   * Revokes an active break-glass account and its activations.
   *
   * @param workspaceId - Workspace identifier.
   * @param accountId - Break-glass account identifier.
   * @param expectedRevision - Account revision concurrency fence.
   * @param auditContext - Optional immutable audit context.
   * @returns A promise that resolves after deactivation.
   */
  deactivateBreakGlass(
    workspaceId: string,
    accountId: string,
    expectedRevision: number,
    auditContext?: MutationAuditContext,
  ): Promise<void>
}

/** Enterprise Identity ports injected as least-privilege runtime views. */
export type EnterpriseIdentityCapabilities = {
  /** Authoritative read port that never handles plaintext credentials. */
  readonly read: EnterpriseIdentityReadCapability
  /** Public SSO discovery port without provider mutation authority. */
  readonly ssoDiscovery: EnterpriseSsoDiscoveryCapability
  /** Identity-provider and verified-domain administration port. */
  readonly identityProviderAdministration: EnterpriseIdentityProviderAdministrationCapability
  /** Role, policy, and directory-mapping administration port. */
  readonly authorization: EnterpriseAuthorizationAdministrationCapability
  /** SCIM directory desired-state administration port. */
  readonly scimDirectory: EnterpriseScimDirectoryCapability
  /** SCIM bearer verification port without credential mutation authority. */
  readonly scimAuthentication: EnterpriseScimAuthenticationCapability
  /** SCIM credential lifecycle administration port. */
  readonly scimCredentialAdministration: EnterpriseScimCredentialAdministrationCapability
  /** Provisioning orchestration port. */
  readonly provisioning: EnterpriseProvisioningCapability
  /** Service-account bearer verification port. */
  readonly serviceAccountAuthentication: EnterpriseServiceAccountAuthenticationCapability
  /** Service-account and credential lifecycle administration port. */
  readonly serviceAccountAdministration: EnterpriseServiceAccountAdministrationCapability
  /** Break-glass account and activation port. */
  readonly breakGlass: EnterpriseBreakGlassCapability
}

/** Aggregate capability implemented by internal Enterprise Identity adapters. */
export type EnterpriseIdentityApplicationCapability =
  EnterpriseIdentityReadCapability &
  EnterpriseSsoDiscoveryCapability &
  EnterpriseIdentityProviderAdministrationCapability &
  EnterpriseAuthorizationAdministrationCapability &
  EnterpriseScimDirectoryCapability &
  EnterpriseScimAuthenticationCapability &
  EnterpriseScimCredentialAdministrationCapability &
  EnterpriseProvisioningCapability &
  EnterpriseServiceAccountAuthenticationCapability &
  EnterpriseServiceAccountAdministrationCapability &
  EnterpriseBreakGlassCapability

/**
 * Splits a compatible client into minimal runtime views for each capability.
 *
 * @param client - Internal client implementing every capability.
 * @returns Immutable capability map injected by HTTP composition.
 */
export function createEnterpriseIdentityCapabilities(
  client: EnterpriseIdentityApplicationCapability,
): EnterpriseIdentityCapabilities {
  return Object.freeze({
    read: Object.freeze({
      getSnapshot: client.getSnapshot.bind(client),
      getActiveBreakGlassActivation:
        client.getActiveBreakGlassActivation.bind(client),
    }),
    ssoDiscovery: Object.freeze({
      discoverSso: client.discoverSso.bind(client),
    }),
    identityProviderAdministration: Object.freeze({
      putIdentityProvider: client.putIdentityProvider.bind(client),
      putVerifiedDomain: client.putVerifiedDomain.bind(client),
      setSsoEnforcement: client.setSsoEnforcement.bind(client),
    }),
    authorization: Object.freeze({
      putSecurityPolicy: client.putSecurityPolicy.bind(client),
      putCustomRole: client.putCustomRole.bind(client),
      deleteCustomRole: client.deleteCustomRole.bind(client),
      putGroupMapping: client.putGroupMapping.bind(client),
      deleteGroupMapping: client.deleteGroupMapping.bind(client),
    }),
    scimDirectory: Object.freeze({
      listScimUsers: client.listScimUsers.bind(client),
      listScimGroups: client.listScimGroups.bind(client),
      upsertScimUser: client.upsertScimUser.bind(client),
      deactivateScimUser: client.deactivateScimUser.bind(client),
      markScimUserApplied: client.markScimUserApplied.bind(client),
      upsertScimGroup: client.upsertScimGroup.bind(client),
      deactivateScimGroup: client.deactivateScimGroup.bind(client),
      markScimGroupApplied: client.markScimGroupApplied.bind(client),
      getScimGroupJobReference: client.getScimGroupJobReference.bind(client),
      processScimGroupJob: client.processScimGroupJob.bind(client),
    }),
    scimAuthentication: Object.freeze({
      authenticateScimToken: client.authenticateScimToken.bind(client),
      authenticateScimWorkspace: client.authenticateScimWorkspace.bind(client),
    }),
    scimCredentialAdministration: Object.freeze({
      issueScimToken: client.issueScimToken.bind(client),
      rotateScimToken: client.rotateScimToken.bind(client),
      revokeScimToken: client.revokeScimToken.bind(client),
    }),
    provisioning: Object.freeze({
      previewProvisioning: client.previewProvisioning.bind(client),
      getProvisioningPreview: client.getProvisioningPreview.bind(client),
      reconcileProvisioning: client.reconcileProvisioning.bind(client),
      finalizeProvisioningRun: client.finalizeProvisioningRun.bind(client),
      retryProvisioning: client.retryProvisioning.bind(client),
    }),
    serviceAccountAuthentication: Object.freeze({
      authenticateServiceAccountToken:
        client.authenticateServiceAccountToken.bind(client),
      recordServiceAccountUse: client.recordServiceAccountUse.bind(client),
    }),
    serviceAccountAdministration: Object.freeze({
      createServiceAccount: client.createServiceAccount.bind(client),
      createServiceAccountWithToken: client.createServiceAccountWithToken.bind(client),
      issueServiceAccountToken: client.issueServiceAccountToken.bind(client),
      rotateServiceAccountToken: client.rotateServiceAccountToken.bind(client),
      revokeServiceAccountToken: client.revokeServiceAccountToken.bind(client),
    }),
    breakGlass: Object.freeze({
      putBreakGlassAccount: client.putBreakGlassAccount.bind(client),
      activateBreakGlass: client.activateBreakGlass.bind(client),
      revokeBreakGlassActivation: client.revokeBreakGlassActivation.bind(client),
      deactivateBreakGlass: client.deactivateBreakGlass.bind(client),
    }),
  })
}
