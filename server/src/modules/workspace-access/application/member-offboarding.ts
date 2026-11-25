import type {
  PlanningEntityType,
  WorkspaceMemberOffboarding,
  WorkspaceMemberOffboardingCredential,
  WorkspaceMemberOffboardingProject,
} from '@mukuroji/contracts'
import {
  readPrivateDocumentManagerContinuity,
  type DocumentManagerLifecycleDependencies,
} from '../document-manager-lifecycle'
import { isMemberAccessExpired } from '../domain/member-access-expiry'
import {
  isActivePlanningEntityOwnedBy,
  isManagerProjectAccess,
  listMemberDeactivationBlockers,
} from '../domain/member-deactivation-blockers'
import { WorkspaceAccessError, type WorkspaceMember } from '../workspace-access'

/** A Project role of the member, as the Project directory reports it. */
export type MemberOffboardingProjectAccess = {
  /** Owner Team, when the access source knows it. */
  teamId?: string
  /** Active Project. */
  projectId: string
  /** The member's role in the Project. */
  role?: string
}

/** Team of the Project directory, with the names of its Projects. */
export type MemberOffboardingDirectoryTeam = {
  /** Team ID. */
  id: string
  /** Active Projects of the Team. */
  projects: ReadonlyArray<{
    /** Project ID. */
    id: string
    /** Project display name. */
    name: string
  }>
}

/** Planning entity as the handover summary reads it. */
export type MemberOffboardingPlanningEntity = {
  /** Entity ID. */
  id: string
  /** Entity type. */
  type: PlanningEntityType
  /** Entity title. */
  title: string
  /** Owner of the entity. */
  ownerMemberKey?: string
  /** Set when the entity is archived. */
  archivedAt?: string
}

/** Credential the member created, as the summary lists it. */
export type MemberOffboardingCredentialEntry = {
  /** Credential ID. */
  id: string
  /** Credential name. */
  name: string
}

/** Webhook subscription of the Workspace. */
export type MemberOffboardingWebhook = {
  /** Subscription ID. */
  id: string
  /** Subscription name. */
  name: string
  /** Delivery state; only active subscriptions are listed. */
  status: string
  /** Member who created the subscription. */
  createdByUserId: string
}

/** Ports the member handover summary reads. */
export type MemberOffboardingPorts = {
  /** Workspace members, and the replacement managers of private Documents. */
  workspaceAccess: DocumentManagerLifecycleDependencies['workspaceAccess'] & {
    /** Reads one member, whatever its status. */
    getMember(workspaceId: string, memberKey: string): Promise<WorkspaceMember | undefined>
  }
  /** Document ACL generation and manager projection. */
  documents: DocumentManagerLifecycleDependencies['documents']
  /** Project roles and names. */
  projects: {
    /** Lists the member's roles in active Projects. */
    listProjectAccesses(workspaceId: string, memberKey: string): Promise<readonly MemberOffboardingProjectAccess[]>
    /** Lists the Teams of the Workspace with their Project names. */
    listTeams(workspaceId: string): Promise<readonly MemberOffboardingDirectoryTeam[]>
  }
  /** Planning entities and the revision of the same read. */
  planning: {
    /** Reads every Planning entity with the Planning revision. */
    readEntities(workspaceId: string): Promise<{
      /** Planning revision of the read. */
      revision: number
      /** Planning entities. */
      entities: readonly MemberOffboardingPlanningEntity[]
    }>
  }
  /** Developer credentials and Webhooks. */
  developerPlatform: {
    /** Lists the active API keys and OAuth applications the member created. */
    listActiveCredentials(workspaceId: string, memberKey: string): Promise<{
      /** Active API keys. */
      apiKeys: readonly MemberOffboardingCredentialEntry[]
      /** Active OAuth applications. */
      oauthApps: readonly MemberOffboardingCredentialEntry[]
    }>
    /** Lists the Webhook subscriptions of the Workspace. */
    listWebhooks(workspaceId: string): Promise<readonly MemberOffboardingWebhook[]>
  }
  /** Current instant. */
  now: () => Date
}

/**
 * Names the Project of a manager role, finding its Team in the directory.
 *
 * A Project ID is reserved across the Workspace, so at most one Team holds it. When the access
 * names no Team and more than one Team holds the ID anyway, the Team is left unresolved rather
 * than guessed.
 *
 * @param access - The member's manager role.
 * @param teams - Teams of the Project directory.
 * @returns The Project row of the summary.
 */
function toOffboardingProject(
  access: MemberOffboardingProjectAccess,
  teams: readonly MemberOffboardingDirectoryTeam[],
): WorkspaceMemberOffboardingProject {
  const holders = teams.filter((candidate) =>
    (access.teamId === undefined || candidate.id === access.teamId) &&
    candidate.projects.some((project) => project.id === access.projectId)
  )
  const team = holders.length === 1 ? holders[0] : undefined
  const name = team?.projects.find((project) => project.id === access.projectId)?.name
  const teamId = access.teamId ?? team?.id
  return {
    ...(teamId === undefined ? {} : { teamId }),
    projectId: access.projectId,
    ...(name === undefined ? {} : { name }),
  }
}

/**
 * Collects everything a member must hand over before deactivation, and whether the member can
 * be deactivated now.
 *
 * The deactivation blockers are the ones an administrator's deactivation and the scheduled
 * expiry job check (ADR 0095).
 *
 * @param ports - Member, Project, Planning, Document, and developer platform readers.
 * @param workspaceId - Workspace of the member.
 * @param memberKey - Member being offboarded.
 * @returns The handover summary.
 * @throws WorkspaceAccessError 404 `WorkspaceMemberNotFound` when the member does not exist.
 */
export async function readMemberOffboarding(
  ports: MemberOffboardingPorts,
  workspaceId: string,
  memberKey: string,
): Promise<WorkspaceMemberOffboarding> {
  const member = await ports.workspaceAccess.getMember(workspaceId, memberKey)
  if (!member) {
    throw new WorkspaceAccessError(404, 'WorkspaceMemberNotFound', 'Workspace member was not found.')
  }
  const [accesses, teams, planning, documents, credentials, webhooks] = await Promise.all([
    ports.projects.listProjectAccesses(workspaceId, member.memberKey),
    ports.projects.listTeams(workspaceId),
    ports.planning.readEntities(workspaceId),
    readPrivateDocumentManagerContinuity(ports, workspaceId, member.memberKey),
    ports.developerPlatform.listActiveCredentials(workspaceId, member.memberKey),
    ports.developerPlatform.listWebhooks(workspaceId),
  ])
  const managedProjects = accesses
    .filter(isManagerProjectAccess)
    .map((access) => toOffboardingProject(access, teams))
  const ownedPlanningEntities = planning.entities
    .filter((entity) => isActivePlanningEntityOwnedBy(entity, member.memberKey))
    .map((entity) => ({ id: entity.id, type: entity.type, title: entity.title }))
  const blockers = listMemberDeactivationBlockers({
    managesProjects: managedProjects.length > 0,
    ownsPlanningEntities: ownedPlanningEntities.length > 0,
    managesPrivateDocuments: documents.managesPrivateDocuments,
  })
  const credentialRows: WorkspaceMemberOffboardingCredential[] = [
    ...credentials.apiKeys.map((apiKey): WorkspaceMemberOffboardingCredential => ({
      id: apiKey.id,
      kind: 'api-key',
      name: apiKey.name,
    })),
    ...credentials.oauthApps.map((oauthApp): WorkspaceMemberOffboardingCredential => ({
      id: oauthApp.id,
      kind: 'oauth-app',
      name: oauthApp.name,
    })),
  ]
  return {
    memberKey: member.memberKey,
    ...(member.accessExpiresAt === undefined ? {} : { accessExpiresAt: member.accessExpiresAt }),
    accessExpired: isMemberAccessExpired(member, ports.now()),
    managedProjects,
    ownedPlanningEntities,
    planningRevision: planning.revision,
    managesPrivateDocuments: documents.managesPrivateDocuments,
    credentials: credentialRows,
    webhooks: webhooks
      .filter((webhook) => webhook.status === 'active' && webhook.createdByUserId === member.memberKey)
      .map((webhook) => ({ id: webhook.id, name: webhook.name })),
    canDeactivate: member.status === 'active' && blockers.length === 0,
  }
}
