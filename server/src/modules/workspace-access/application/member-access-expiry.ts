import { createHash } from 'node:crypto'
import { createMutationAuditContext, type MutationAuditContext } from '../../audit'
import {
  requirePrivateDocumentManagerContinuity,
  type DocumentManagerLifecycleDependencies,
} from '../document-manager-lifecycle'
import {
  WorkspaceAccessError,
  type ExpireWorkspaceMemberInput,
  type WorkspaceMember,
} from '../workspace-access'
import { isMemberAccessExpired } from '../domain/member-access-expiry'

/** Planning reference the expiry job reads to find entities the member still owns. */
export type MemberAccessExpiryPlanningEntity = {
  /** Owner of the entity. */
  ownerMemberKey: string
  /** Set when the entity is archived; an archived entity needs no owner. */
  archivedAt?: string
}

/** Ports the scheduled deactivation of expired members uses. */
export type MemberAccessExpiryPorts = {
  /** Workspace members: expiring rows, the deactivation, and manager candidates for Documents. */
  workspaceAccess: DocumentManagerLifecycleDependencies['workspaceAccess'] & {
    /** Lists active members whose access expires at or before an instant. */
    listMembersWithAccessExpiringBefore(before: Date): Promise<Array<{
      /** Workspace of the member. */
      workspaceId: string
      /** Member whose access expires. */
      member: WorkspaceMember
    }>>
    /** Deactivates a member whose access expired, fenced by the versions read. */
    expireMember(
      workspaceId: string,
      memberKey: string,
      input: ExpireWorkspaceMemberInput,
      auditContext?: MutationAuditContext,
    ): Promise<WorkspaceMember | undefined>
  }
  /** Document ACL generation and manager projection. */
  documents: DocumentManagerLifecycleDependencies['documents']
  /** Planning owner references and the revision read with them. */
  planning: {
    /** Reads every Planning entity owner with the revision of the same read. */
    getAuthorizationState(workspaceId: string): Promise<{
      /** Planning revision of the read. */
      revision: number
      /** Entity owner references. */
      entities: readonly MemberAccessExpiryPlanningEntity[]
    }>
  }
  /** Reports whether the member still manages an active Project. */
  projectManagerGuard: {
    /** Returns true while the member holds a manager role in an active Project. */
    hasManagedProject(workspaceId: string, memberKey: string): Promise<boolean>
  }
  /** Current instant. */
  now: () => Date
}

/** Why an expired member was left active by one run. */
export type MemberAccessExpiryBlocker =
  | 'manages-projects'
  | 'owns-planning-entities'
  | 'manages-private-documents'

/** Outcome of one scheduled run. */
export type MemberAccessExpiryResult = {
  /** Members deactivated in this run. */
  deactivated: number
  /**
   * Expired members left active because they still manage or own something; they cannot sign
   * in, and an administrator hands their work over before deactivating them.
   */
  blocked: Array<{
    /** Workspace of the member. */
    workspaceId: string
    /** What still needs a handover. */
    blocker: MemberAccessExpiryBlocker
  }>
  /**
   * Members that changed while the run read them, or whose tenant is closing; the next run
   * tries again.
   */
  deferred: number
}

/**
 * Builds the audit context of one member's scheduled deactivation.
 *
 * The idempotency key names the member and the expiry it acted on, so a retried run records the
 * same event.
 *
 * @param workspaceId - Workspace of the member.
 * @param member - Member being deactivated.
 * @returns Deterministic system audit context.
 */
export function createMemberAccessExpiryAuditContext(
  workspaceId: string,
  member: Pick<WorkspaceMember, 'memberKey' | 'accessExpiresAt'>,
): MutationAuditContext {
  // Member keys are email addresses, so they appear only inside the digest.
  const digest = createHash('sha256')
    .update([workspaceId, member.memberKey, member.accessExpiresAt ?? ''].join('\0'))
    .digest('hex')
  const operationId = `member-access-expiry-v1:${digest}`
  return createMutationAuditContext({
    workspaceId,
    actor: {
      id: 'system:member-access-expiry',
      kind: 'system',
      displayName: 'Mukuroji member access expiry',
    },
    idempotencyKey: operationId,
    request: {
      method: 'SCHEDULE',
      path: '/internal/member-access-expiry',
      body: { operationId },
    },
    source: {
      kind: 'system',
      requestId: operationId,
      method: 'SCHEDULE',
      route: '/internal/member-access-expiry',
    },
  })
}

/**
 * Finds what keeps an expired member from being deactivated, reading the versions that fence
 * the deactivation.
 *
 * @param ports - Planning, Documents, Project directory, and Workspace member ports.
 * @param workspaceId - Workspace of the member.
 * @param memberKey - Expired member.
 * @returns The blocker, or the Planning revision and Document ACL generation to fence.
 */
async function readExpiryFences(
  ports: MemberAccessExpiryPorts,
  workspaceId: string,
  memberKey: string,
): Promise<
  | { blocker: MemberAccessExpiryBlocker }
  | { expectedPlanningRevision: number; expectedDocumentAuthorizationRevision: number }
> {
  if (await ports.projectManagerGuard.hasManagedProject(workspaceId, memberKey)) {
    return { blocker: 'manages-projects' }
  }
  const planning = await ports.planning.getAuthorizationState(workspaceId)
  if (planning.entities.some((entity) => !entity.archivedAt && entity.ownerMemberKey === memberKey)) {
    return { blocker: 'owns-planning-entities' }
  }
  try {
    const expectedDocumentAuthorizationRevision = await requirePrivateDocumentManagerContinuity(
      ports,
      workspaceId,
      memberKey,
    )
    return { expectedPlanningRevision: planning.revision, expectedDocumentAuthorizationRevision }
  } catch (error) {
    if (error instanceof WorkspaceAccessError && error.code === 'WorkspaceMemberManagesPrivateDocuments') {
      return { blocker: 'manages-private-documents' }
    }
    throw error
  }
}

/**
 * Deactivates every member whose access expiry has passed.
 *
 * A member is deactivated only when nothing would be left without a manager or owner, as when
 * an administrator deactivates them. Otherwise the member stays active but cannot sign in or
 * use an API key, because every membership check treats them as deactivated, and the member is
 * reported as blocked until an administrator hands their work over. A member that changed while
 * it was read is retried by the next run.
 *
 * @param ports - Workspace members, Planning, Documents, and Project directory ports.
 * @returns Counts of deactivated, blocked, and deferred members.
 * @throws The first unexpected error, after every member was tried.
 */
export async function deactivateExpiredMembers(
  ports: MemberAccessExpiryPorts,
): Promise<MemberAccessExpiryResult> {
  const now = ports.now()
  const result: MemberAccessExpiryResult = { deactivated: 0, blocked: [], deferred: 0 }
  const failures: unknown[] = []
  for (const { workspaceId, member } of await ports.workspaceAccess.listMembersWithAccessExpiringBefore(now)) {
    if (!isMemberAccessExpired(member, now) || member.role === 'owner') continue
    try {
      const fences = await readExpiryFences(ports, workspaceId, member.memberKey)
      if ('blocker' in fences) {
        result.blocked.push({ workspaceId, blocker: fences.blocker })
        continue
      }
      const deactivated = await ports.workspaceAccess.expireMember(
        workspaceId,
        member.memberKey,
        { expectedVersion: member.version, ...fences },
        createMemberAccessExpiryAuditContext(workspaceId, member),
      )
      if (deactivated) result.deactivated += 1
    } catch (error) {
      // A conflict is retried by the next run. A closing tenant refuses membership writes, and its
      // members cannot sign in anyway, so it is skipped rather than failing every run.
      if (
        error instanceof WorkspaceAccessError &&
        (error.status === 409 || error.code === 'TenantClosed' || error.code === 'TenantClosing')
      ) {
        result.deferred += 1
        continue
      }
      failures.push(error)
    }
  }
  if (failures.length > 0) throw failures[0]
  return result
}
