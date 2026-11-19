import type {
  EnterpriseIdentitySnapshot,
  EnterpriseScimUser,
  EnterpriseScimUserInput,
} from '@mukuroji/contracts'
import type { MutationAuditContext } from '../../../audit'
import type { WorkspaceAccessClient } from '../../../workspace-access'
import { EnterpriseIdentityError } from '../../errors'
import type {
  EnterpriseScimDirectoryCapability,
} from '../ports/enterprise-identity-capabilities'

/** SCIM user fields that decide which Workspace member the desired state is applied to. */
export type EnterpriseScimMemberLink = Pick<
  EnterpriseScimUserInput,
  | 'workspaceId'
  | 'userId'
  | 'identityProviderId'
  | 'externalId'
  | 'linkedMemberKey'
  | 'emails'
  | 'userName'
>

/** Ports used to store SCIM user desired state only after its member link is checked. */
export type EnterpriseScimUserDesiredStateDependencies = {
  /** Stores SCIM user desired state. */
  scimDirectory: Pick<
    EnterpriseScimDirectoryCapability,
    'upsertScimUser' | 'deactivateScimUser'
  >
  /** Reads the Workspace member the desired state would be linked to. */
  workspaceAccess: Pick<WorkspaceAccessClient, 'getMember'>
}

/**
 * Resolves the Workspace member key that SCIM desired state for a user is applied to.
 *
 * @param user - SCIM user desired state, stored or about to be stored.
 * @returns The linked member key, or the normalized primary email or userName.
 */
export function resolveEnterpriseScimMemberKey(
  user: Pick<EnterpriseScimUserInput, 'linkedMemberKey' | 'emails' | 'userName'>,
) {
  return user.linkedMemberKey ??
    user.emails[0]?.trim().toLowerCase() ??
    user.userName.trim().toLowerCase()
}

/**
 * Rejects SCIM user desired state that would be linked to a Workspace member this directory
 * identity does not own.
 *
 * @remarks
 * Stored SCIM desired state marks its member as directory-managed. If it were stored first and
 * the member update then failed, a SCIM credential could still take away the role of an owner or
 * of a manually invited member by sending their email. A member key may only be linked when no
 * member exists yet, or when the member was provisioned by this same SCIM user.
 *
 * @param workspaceAccess - Reads the linked Workspace member.
 * @param snapshot - Enterprise Identity snapshot read for this operation.
 * @param user - SCIM user desired state about to be stored.
 * @throws EnterpriseIdentityError 409 `EnterpriseProvisioningProtectedOwner` when the member is
 *   a Workspace owner, and 409 `EnterpriseScimMemberNotDirectoryManaged` when the member is not
 *   provisioned by this SCIM user.
 */
export async function requireEnterpriseScimMemberLinkAllowed(
  workspaceAccess: EnterpriseScimUserDesiredStateDependencies['workspaceAccess'],
  snapshot: EnterpriseIdentitySnapshot,
  user: EnterpriseScimMemberLink,
) {
  const memberKey = resolveEnterpriseScimMemberKey(user)
  const member = await workspaceAccess.getMember(user.workspaceId, memberKey)
  if (!member) return
  if (member.role === 'owner') {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseProvisioningProtectedOwner',
      'Directory provisioning cannot manage a Workspace owner.',
    )
  }
  const scimUserId = user.userId ?? snapshot.scimUsers.find((candidate) =>
    candidate.identityProviderId === user.identityProviderId &&
    candidate.externalId === user.externalId
  )?.userId
  if (
    scimUserId === undefined ||
    member.provisioningSource !== 'directory' ||
    member.externalIdentityId !== scimUserId
  ) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseScimMemberNotDirectoryManaged',
      'This Workspace member is not managed by this directory user.',
    )
  }
}

/**
 * Stores SCIM user desired state after checking that its member link is owned by this
 * directory identity.
 *
 * @param dependencies - Directory store and Workspace member reader.
 * @param snapshot - Enterprise Identity snapshot read for this operation.
 * @param input - Validated SCIM user desired state.
 * @param auditContext - Optional immutable audit context.
 * @returns The stored SCIM user desired state.
 * @throws EnterpriseIdentityError 409 when the member link is not allowed; see
 *   {@link requireEnterpriseScimMemberLinkAllowed}.
 */
export async function saveEnterpriseScimUserDesiredState(
  dependencies: EnterpriseScimUserDesiredStateDependencies,
  snapshot: EnterpriseIdentitySnapshot,
  input: EnterpriseScimUserInput,
  auditContext?: MutationAuditContext,
): Promise<EnterpriseScimUser> {
  await requireEnterpriseScimMemberLinkAllowed(dependencies.workspaceAccess, snapshot, input)
  return await dependencies.scimDirectory.upsertScimUser(input, auditContext)
}

/**
 * Deactivates stored SCIM user desired state after checking that its member link is owned by
 * this directory identity.
 *
 * @param dependencies - Directory store and Workspace member reader.
 * @param snapshot - Enterprise Identity snapshot read for this operation.
 * @param existing - Stored SCIM user desired state to deactivate.
 * @param idempotencyKey - Operation-scoped idempotency key.
 * @param auditContext - Optional immutable audit context.
 * @returns The deactivated SCIM user, when it still exists.
 * @throws EnterpriseIdentityError 409 when the member link is not allowed; see
 *   {@link requireEnterpriseScimMemberLinkAllowed}.
 */
export async function deactivateEnterpriseScimUserDesiredState(
  dependencies: EnterpriseScimUserDesiredStateDependencies,
  snapshot: EnterpriseIdentitySnapshot,
  existing: EnterpriseScimUser,
  idempotencyKey: string,
  auditContext?: MutationAuditContext,
): Promise<EnterpriseScimUser | undefined> {
  await requireEnterpriseScimMemberLinkAllowed(dependencies.workspaceAccess, snapshot, existing)
  return await dependencies.scimDirectory.deactivateScimUser(
    existing.workspaceId,
    existing.identityProviderId,
    existing.userId,
    idempotencyKey,
    auditContext,
  )
}
