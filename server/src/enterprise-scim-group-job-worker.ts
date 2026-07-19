import type {
  EnterpriseIdentitySnapshot,
  EnterpriseScimGroup,
  EnterpriseScimUser,
} from '@mukuroji/contracts'
import {
  createMutationAuditContext,
  type MutationAuditContext,
} from './audit'
import type {
  EnterpriseIdentityClient,
  EnterpriseScimGroupJobApplyInput,
} from './enterprise-identity'
import {
  requirePrivateDocumentManagerContinuity,
} from './document-manager-lifecycle'
import type { DocumentClient } from './documents'
import type {
  EnterpriseScimGroupJobProcessor,
  EnterpriseScimGroupJobReference,
} from './enterprise-scim-group-job-handler'
import type { PlanningClient } from './planning'
import {
  WorkspaceAccessError,
  type WorkspaceAccessClient,
  type WorkspaceRole,
} from './workspace-access'

/**
 * SCIM group worker が利用する enterprise identity client の最小契約です。
 */
export type EnterpriseScimGroupJobIdentityClient = Pick<
  EnterpriseIdentityClient,
  'processScimGroupJob'
>

/**
 * SCIM group worker が利用する Workspace access client の最小契約です。
 */
export type EnterpriseScimGroupJobWorkspaceAccessClient = Required<Pick<
  WorkspaceAccessClient,
  'deprovisionDirectoryMember' | 'getMember' | 'listActiveMembers' |
    'reconcileDirectoryMember'
>>

/**
 * SCIM group worker が利用する private Document manager guard client です。
 */
export type EnterpriseScimGroupJobDocumentClient = Pick<
  DocumentClient,
  'getAuthorizationRevision' | 'getManagerLifecycleSnapshot'
>

/**
 * SCIM group worker が利用する Planning client の最小契約です。
 */
export type EnterpriseScimGroupJobPlanningClient = Pick<
  PlanningClient,
  'getAuthorizationState'
>

/**
 * SCIM group worker が参照する Project manager guard です。
 */
export type EnterpriseScimGroupJobProjectManagerGuard = {
  /**
   * Active project の manager role が残っている場合に true を返します。
   */
  hasManagedProject(workspaceId: string, memberKey: string): Promise<boolean>
}

/**
 * SCIM group worker が利用する Cognito user lifecycle 操作です。
 */
export type EnterpriseScimGroupJobCognitoClient = {
  /** Directory deprovisioning 後に新規認証を停止します。 */
  disableWorkspaceUser(userId: string): Promise<void>
  /** Directory reactivation 後に認証を再開します。 */
  enableWorkspaceUser(userId: string): Promise<void>
  /** Directory deprovisioning 後に refresh token を全失効させます。 */
  globallySignOutWorkspaceUser(userId: string): Promise<void>
}

/**
 * SCIM group worker processor の dependency です。
 */
export type EnterpriseScimGroupJobWorkerDependencies = {
  /** Durable group job と enterprise identity snapshot を管理します。 */
  enterpriseIdentity: EnterpriseScimGroupJobIdentityClient
  /** Workspace member を directory authority から収束させます。 */
  workspaceAccess: EnterpriseScimGroupJobWorkspaceAccessClient
  /** Private Document manager 継続性と ACL generation を読みます。 */
  documents: EnterpriseScimGroupJobDocumentClient
  /** Planning owner guard と revision fence を読み取ります。 */
  planning: EnterpriseScimGroupJobPlanningClient
  /** Active Project manager role の有無を確認します。 */
  projectManagerGuard: EnterpriseScimGroupJobProjectManagerGuard
  /** Cognito user の認証 lifecycle を収束させます。 */
  cognito: EnterpriseScimGroupJobCognitoClient
}

/**
 * Durable SCIM group job の一 page を処理する専用 processor を作成します。
 */
export function createEnterpriseScimGroupJobProcessor(
  dependencies: EnterpriseScimGroupJobWorkerDependencies,
): EnterpriseScimGroupJobProcessor {
  return {
    async processJob(reference) {
      return await dependencies.enterpriseIdentity.processScimGroupJob(
        reference,
        async (input) => {
          await applyEnterpriseScimGroupJobUser(input, dependencies)
        },
        createEnterpriseScimGroupJobCheckpointContext(reference),
      )
    },
  }
}

/**
 * 一つの group job user を Workspace access と Cognito へ収束させます。
 */
export async function applyEnterpriseScimGroupJobUser(
  input: EnterpriseScimGroupJobApplyInput,
  dependencies: EnterpriseScimGroupJobWorkerDependencies,
) {
  const { user } = input
  const memberKey = user.linkedMemberKey ??
    user.emails[0]?.trim().toLowerCase() ??
    user.userName.trim().toLowerCase()
  const existing = await dependencies.workspaceAccess.getMember(
    user.workspaceId,
    memberKey,
  )
  const auditContext = createEnterpriseScimGroupJobUserContext(input)

  if (user.active) {
    const workspaceRole = resolveEnterpriseScimWorkspaceRole(
      input.snapshot,
      user,
      [input.group],
    )
    requireEnterpriseExternalAccessAllowed(
      input.snapshot,
      user.emails[0] ?? user.userName,
      workspaceRole,
    )
    const expectedPlanningRevision = (
      await dependencies.planning.getAuthorizationState(user.workspaceId)
    ).revision
    const expectedDocumentAuthorizationRevision =
      existing?.status === 'active' &&
        existing.role !== 'guest' &&
        workspaceRole === 'guest'
        ? await requirePrivateDocumentManagerContinuity(
            dependencies,
            user.workspaceId,
            memberKey,
          )
        : undefined
    await dependencies.workspaceAccess.reconcileDirectoryMember(
      user.workspaceId,
      {
        memberKey,
        email: user.emails[0] ?? user.userName,
        name: user.displayName,
        role: workspaceRole,
        externalIdentityId: user.userId,
        expectedVersion: existing?.version,
        expectedPlanningRevision,
        ...(expectedDocumentAuthorizationRevision === undefined
          ? {}
          : { expectedDocumentAuthorizationRevision }),
      },
      auditContext,
    )
    await dependencies.cognito.enableWorkspaceUser(memberKey)
    return
  }

  if (!existing) return
  if (
    await dependencies.projectManagerGuard.hasManagedProject(
      user.workspaceId,
      memberKey,
    )
  ) {
    throw new WorkspaceAccessError(
      409,
      'WorkspaceMemberManagesProjects',
      'Transfer or remove all active project manager roles before deactivating this member.',
    )
  }
  const authorizationState = await dependencies.planning.getAuthorizationState(
    user.workspaceId,
  )
  if (
    authorizationState.entities.some((entity) =>
      !entity.archivedAt && entity.ownerMemberKey === memberKey
    )
  ) {
    throw new WorkspaceAccessError(
      409,
      'WorkspaceMemberOwnsPlanningEntities',
      'Transfer or archive all owned Planning entities before deactivating this member.',
    )
  }
  const expectedDocumentAuthorizationRevision =
    await requirePrivateDocumentManagerContinuity(
      dependencies,
      user.workspaceId,
      memberKey,
    )
  await dependencies.workspaceAccess.deprovisionDirectoryMember(
    user.workspaceId,
    memberKey,
    {
      externalIdentityId: user.userId,
      expectedVersion: existing.version,
      expectedPlanningRevision: authorizationState.revision,
      expectedDocumentAuthorizationRevision,
    },
    auditContext,
  )
  await dependencies.cognito.disableWorkspaceUser(memberKey)
  await dependencies.cognito.globallySignOutWorkspaceUser(memberKey)
}

/**
 * Group job checkpoint mutation の deterministic audit context を作成します。
 */
export function createEnterpriseScimGroupJobCheckpointContext(
  reference: EnterpriseScimGroupJobReference,
): MutationAuditContext {
  const operationId = `${reference.jobId}:${reference.revision}`
  return createMutationAuditContext({
    workspaceId: reference.workspaceId,
    actor: {
      id: `scim-group-job:${reference.jobId}`,
      kind: 'service',
      displayName: 'SCIM group reconciliation worker',
    },
    idempotencyKey: operationId,
    request: {
      method: 'DYNAMODB_STREAM',
      path: '/internal/enterprise/scim/group-jobs',
      body: reference,
    },
    source: {
      kind: 'system',
      requestId: operationId,
      method: 'DYNAMODB_STREAM',
      route: '/internal/enterprise/scim/group-jobs',
    },
  })
}

/**
 * Group job user side effect の deterministic audit context を作成します。
 */
export function createEnterpriseScimGroupJobUserContext(
  input: EnterpriseScimGroupJobApplyInput,
): MutationAuditContext {
  const operationId = `${
    input.reference.jobId
  }:${input.reference.revision}:${input.snapshotRevision}:${
    input.user.userId
  }:${input.user.version}`
  return createMutationAuditContext({
    workspaceId: input.reference.workspaceId,
    actor: {
      id: `scim-directory:${input.group.identityProviderId}`,
      kind: 'service',
      displayName: `SCIM directory (${input.group.identityProviderId})`,
    },
    idempotencyKey: operationId,
    occurredAt: input.jobUpdatedAt,
    request: {
      method: 'DYNAMODB_STREAM',
      path: '/internal/enterprise/scim/group-jobs/users',
      body: {
        groupId: input.group.groupId,
        groupVersion: input.group.version,
        phase: input.phase,
        snapshotRevision: input.snapshotRevision,
        userId: input.user.userId,
        userVersion: input.user.version,
      },
    },
    source: {
      kind: 'system',
      requestId: operationId,
      method: 'DYNAMODB_STREAM',
      route: '/internal/enterprise/scim/group-jobs/users',
    },
  })
}

function resolveEnterpriseScimWorkspaceRole(
  snapshot: EnterpriseIdentitySnapshot,
  user: EnterpriseScimUser,
  desiredGroupOverlays: readonly EnterpriseScimGroup[],
): Extract<WorkspaceRole, 'guest' | 'member'> {
  const desiredGroupsById = new Map(
    desiredGroupOverlays.map((group) => [group.groupId, group]),
  )
  const externalGroupIds = snapshot.scimGroups
    .map((group) => desiredGroupsById.get(group.groupId) ?? group)
    .filter((group) =>
      group.active &&
      (
        desiredGroupsById.has(group.groupId) ||
        group.appliedVersion >= group.version
      ) &&
      group.identityProviderId === user.identityProviderId &&
      group.memberUserIds.includes(user.userId)
    )
    .flatMap((group) => [group.groupId, group.externalId])
  const roles = snapshot.groupMappings
    .filter((mapping) =>
      mapping.enabled &&
      mapping.identityProviderId === user.identityProviderId &&
      mapping.scope.kind === 'workspace' &&
      externalGroupIds.includes(mapping.directoryGroupId)
    )
    .map((mapping) => mapping.roleId)
  return roles.includes('workspace:guest') ? 'guest' : 'member'
}

function requireEnterpriseExternalAccessAllowed(
  snapshot: EnterpriseIdentitySnapshot,
  email: string,
  role: Extract<WorkspaceRole, 'guest' | 'member'>,
) {
  const policy = snapshot.policy?.externalAccess
  if (!policy) return
  const domain = normalizeEnterpriseEmailDomain(email)
  const verifiedDomains = snapshot.domains.filter((candidate) =>
    candidate.status === 'verified'
  )
  const managedDomain = verifiedDomains.length === 0 ||
    verifiedDomains.some((candidate) => candidate.domain === domain)
  if (role === 'guest') {
    if (
      !policy.allowGuests ||
      policy.allowedGuestDomains.length > 0 &&
        !policy.allowedGuestDomains.includes(domain)
    ) {
      throw new WorkspaceAccessError(
        403,
        'EnterpriseGuestAccessDenied',
        'Workspace guest policy does not allow this account.',
      )
    }
    return
  }
  if (!managedDomain && !policy.allowExternalCollaborators) {
    throw new WorkspaceAccessError(
      403,
      'EnterpriseExternalAccessDenied',
      'Workspace external collaborator policy does not allow this account.',
    )
  }
}

function normalizeEnterpriseEmailDomain(email: string) {
  const atIndex = email.lastIndexOf('@')
  return atIndex > 0 ? email.slice(atIndex + 1).trim().toLowerCase() : ''
}
