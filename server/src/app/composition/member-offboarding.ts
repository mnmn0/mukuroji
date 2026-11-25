import { listMemberActiveCredentials } from '../../modules/developer-platform'
import type { MemberOffboardingPorts } from '../../modules/workspace-access'
import type {
  DeveloperPlatformDependencies,
  WorkItemDependencies,
  WorkspaceDependencies,
} from './app-dependencies'

/** Adapters the member handover summary is wired to. */
export type MemberOffboardingAdapters = {
  /** Workspace members and the Project directory. */
  workspace: Pick<WorkspaceDependencies, 'workspaceAccess' | 'projectDirectory'>
  /** Planning and Documents. */
  workItems: Pick<WorkItemDependencies, 'planning' | 'documents'>
  /** API keys, OAuth applications, and Webhooks. */
  developerPlatform: Pick<DeveloperPlatformDependencies, 'apiKeys' | 'oauthCredentials' | 'webhookSubscriptions'>
}

/**
 * Connects the member handover summary use case to the Workspace, Project directory, Planning,
 * Document, and developer platform adapters.
 *
 * @param adapters - Concrete adapters bound to the request.
 * @returns The ports.
 */
export function createMemberOffboardingPorts({
  workspace,
  workItems,
  developerPlatform,
}: MemberOffboardingAdapters): MemberOffboardingPorts {
  return {
    workspaceAccess: workspace.workspaceAccess,
    documents: workItems.documents,
    projects: {
      listProjectAccesses: (workspaceId, memberKey) =>
        workspace.projectDirectory.getProjectAccessList(workspaceId, memberKey),
      listTeams: async (workspaceId) =>
        (await workspace.projectDirectory.getProjectDirectory(workspaceId, 'ja', true)).teams,
    },
    planning: {
      // Titles are read without Work Items: only the entities the member owns are shown.
      readEntities: (workspaceId) => workItems.planning.get(workspaceId, { workItems: [] }),
    },
    developerPlatform: {
      listActiveCredentials: (workspaceId, memberKey) =>
        listMemberActiveCredentials(developerPlatform, workspaceId, memberKey),
      listWebhooks: (workspaceId) => developerPlatform.webhookSubscriptions.listWebhookSubscriptions(workspaceId),
    },
    now: () => new Date(),
  }
}
