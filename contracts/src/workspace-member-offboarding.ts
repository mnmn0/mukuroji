import type { PlanningEntityType } from './planning'

/** A Project the member manages, which needs another manager before the member is deactivated. */
export type WorkspaceMemberOffboardingProject = {
  /** Owning Team, when the Project directory identifies it. */
  teamId?: string
  /** Project ID. */
  projectId: string
  /** Project name, when the Project is still in the directory. */
  name?: string
}

/** A Planning entity the member owns, which needs another owner before deactivation. */
export type WorkspaceMemberOffboardingPlanningEntity = {
  /** Planning entity ID. */
  id: string
  /** Planning entity kind. */
  type: PlanningEntityType
  /** Title shown in the Planning views. */
  title: string
}

/** A credential the member created, which is revoked when the member is deactivated. */
export type WorkspaceMemberOffboardingCredential = {
  /** Credential ID. */
  id: string
  /** Whether the credential is an API key or an OAuth application. */
  kind: 'api-key' | 'oauth-app'
  /** Name given when the credential was created. */
  name: string
}

/** A webhook subscription the member created; its deliveries stop when the member is deactivated. */
export type WorkspaceMemberOffboardingWebhook = {
  /** Webhook subscription ID. */
  id: string
  /** Name given when the subscription was created. */
  name: string
}

/**
 * Everything that needs a handover before a member is deactivated, read by a Workspace
 * administrator (`GET /api/workspace/members/{memberKey}/offboarding`).
 */
export type WorkspaceMemberOffboarding = {
  /** Member the summary is about. */
  memberKey: string
  /** When the member's access ends, if an expiry is set. */
  accessExpiresAt?: string
  /** Whether the expiry has passed, so the member can no longer sign in. */
  accessExpired: boolean
  /** Projects the member manages; each needs another manager first. */
  managedProjects: WorkspaceMemberOffboardingProject[]
  /** Unarchived Planning entities the member owns; each needs another owner first. */
  ownedPlanningEntities: WorkspaceMemberOffboardingPlanningEntity[]
  /** Planning revision read with the entities, sent back when an owner is changed. */
  planningRevision: number
  /** Whether a private Document would be left without a manager. */
  managesPrivateDocuments: boolean
  /** Active API keys and OAuth applications the member created. */
  credentials: WorkspaceMemberOffboardingCredential[]
  /** Active webhook subscriptions the member created. */
  webhooks: WorkspaceMemberOffboardingWebhook[]
  /** Whether nothing blocks deactivating the member now. */
  canDeactivate: boolean
}
