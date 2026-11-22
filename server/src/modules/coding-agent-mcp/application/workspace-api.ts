import {
  parseWorkItemKey,
  type PublicCredentialOwner,
  type PublicProjectMemberList,
  type PublicTeamList,
  type PublicWorkItemKeyLookup,
  type TeamIssueCommentResponseItem,
  type WorkflowStatusCategory,
} from '@mukuroji/contracts'
import { AgentTaskError, type AgentCatalog, type AgentPage, type AgentTask } from './work-item-api'

/** Filters for listing a Team's Work Items through the Workspace tools. */
export type WorkspaceIssueFilters = {
  /** Project restriction within the Team. */
  assignedProjectId?: string
  /** Assignee member ID. */
  assigneeUserId?: string
  /** Exact workflow status ID. */
  workflowStatusId?: string
  /** Work Item Type ID. */
  workItemTypeId?: string
  /** Only Work Items updated at or after this ISO 8601 instant. */
  updatedAfter?: string
}

/**
 * Public API port of the Workspace tools. Unlike the coding agent port, no Team is fixed: each
 * call names the Team it reads, and the server checks the credential owner's current access.
 */
export interface WorkspaceApi {
  /**
   * Reads the credential owner.
   * @returns The owner's Workspace, member ID, name, and email.
   */
  me(): Promise<PublicCredentialOwner>
  /**
   * Lists the Teams and Projects the credential owner can view.
   * @returns Readable Teams with their Projects.
   */
  teams(): Promise<PublicTeamList>
  /**
   * Lists the active members of a Project.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project ID.
   * @returns Active Project members.
   */
  projectMembers(teamId: string, projectId: string): Promise<PublicProjectMemberList>
  /**
   * Resolves a Work Item key such as `ABC-123`.
   * @param key - Work Item key.
   * @returns The key's Team and Work Item.
   */
  lookupKey(key: string): Promise<PublicWorkItemKeyLookup>
  /**
   * Reads the Team's Work Item Types with their workflows.
   * @param teamId - Team ID.
   * @param assignedProjectId - Optional Project whose Types apply.
   * @returns The Team catalog.
   */
  catalog(teamId: string, assignedProjectId?: string): Promise<AgentCatalog>
  /**
   * Lists one page of a Team's Work Items.
   * @param teamId - Team ID.
   * @param filters - Server-side filters.
   * @param cursor - Cursor of the previous page.
   * @param limit - Page size.
   * @returns One page of Work Items.
   */
  listIssues(teamId: string, filters: WorkspaceIssueFilters, cursor?: string, limit?: number): Promise<AgentPage<AgentTask>>
  /**
   * Reads one Work Item.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @returns The Work Item.
   */
  getIssue(teamId: string, workItemId: string): Promise<AgentTask>
  /**
   * Reads a Work Item's key.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @returns The key, or undefined for Work Items created before keys or on servers without the endpoint.
   */
  getKey(teamId: string, workItemId: string): Promise<string | undefined>
  /**
   * Lists one page of a Work Item's comments, newest first.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @param cursor - Cursor of the previous page.
   * @param limit - Page size.
   * @returns One page of comments.
   */
  comments(teamId: string, workItemId: string, cursor?: string, limit?: number): Promise<AgentPage<TeamIssueCommentResponseItem>>
}

/** Work Item reference resolved to its Team and ID. */
export type ResolvedIssueReference = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
}

/** Workflow status of one Work Item Type, as `list_issue_statuses` returns it. */
export type WorkspaceIssueStatus = {
  /** Status ID, used as `statusId` by the other tools. */
  id: string
  /** Display name. */
  name: string
  /** Common category of the status. */
  category: WorkflowStatusCategory
  /** Whether new Work Items of the Type start in this status. */
  initial: boolean
}

/**
 * Creates the read use cases of the Workspace tools on top of the Public API port.
 * @param api - Workspace Public API port.
 * @returns Use cases that resolve human-readable references such as keys and `me`.
 */
export function createWorkspaceIssues(api: WorkspaceApi) {
  /**
   * Resolves a key such as `ABC-123`, or a Work Item ID with its Team, to the Work Item.
   * @param reference - Key or Work Item ID.
   * @param teamId - Team of a Work Item ID; not needed for a key.
   * @returns The Team and Work Item ID.
   */
  async function resolveIssue(reference: string, teamId?: string): Promise<ResolvedIssueReference> {
    const key = parseWorkItemKey(reference)
    if (key) {
      const found = await api.lookupKey(key.key)
      return { teamId: found.teamId, workItemId: found.workItemId }
    }
    if (teamId === undefined) {
      throw new AgentTaskError('invalid_request', 'Pass a key such as ABC-123, or pass teamId with a Work Item ID.')
    }
    return { teamId, workItemId: reference }
  }

  /**
   * Replaces `me` with the credential owner's member ID.
   * @param memberId - Member ID or `me`.
   * @returns The member ID.
   */
  async function resolveMember(memberId: string): Promise<string> {
    return memberId === 'me' ? (await api.me()).memberId : memberId
  }

  return {
    /** Reads the credential owner. */
    whoami: () => api.me(),
    /** Lists readable Teams with their Projects. */
    listTeams: () => api.teams(),
    /**
     * Lists readable Projects, optionally of one Team.
     * @param teamId - Optional Team restriction.
     * @returns Projects with their Team.
     */
    async listProjects(teamId?: string) {
      const { items } = await api.teams()
      return items
        .filter((team) => teamId === undefined || team.id === teamId)
        .flatMap((team) => team.projects.map((project) => ({ ...project, teamId: team.id, teamName: team.name })))
    },
    /**
     * Lists the active members of a Project.
     * @param teamId - Team that owns the Project.
     * @param projectId - Project ID.
     * @returns Active Project members.
     */
    listUsers: (teamId: string, projectId: string) => api.projectMembers(teamId, projectId),
    /**
     * Lists each Work Item Type's workflow statuses.
     * @param teamId - Team ID.
     * @param projectId - Optional Project whose Types apply.
     * @returns Types with their statuses in workflow order.
     */
    async listStatuses(teamId: string, projectId?: string) {
      const catalog = await api.catalog(teamId, projectId)
      return {
        teamId: catalog.teamId,
        workItemTypes: catalog.workItemTypes.map((type) => ({
          id: type.id,
          name: type.name,
          statuses: [...type.workflow.statuses]
            .sort((left, right) => left.sortOrder - right.sortOrder)
            .map((status): WorkspaceIssueStatus => ({
              id: status.id,
              name: status.name,
              category: status.category,
              initial: status.id === type.workflow.initialStatusId,
            })),
        })),
      }
    },
    /**
     * Lists one page of a Team's Work Items.
     * @param teamId - Team ID.
     * @param filters - Filters; `assigneeUserId` may be `me`.
     * @param cursor - Cursor of the previous page.
     * @param limit - Page size.
     * @returns One page of Work Items.
     */
    async listIssues(teamId: string, filters: WorkspaceIssueFilters, cursor?: string, limit?: number) {
      const assigneeUserId = filters.assigneeUserId === undefined ? undefined : await resolveMember(filters.assigneeUserId)
      return api.listIssues(teamId, { ...filters, ...(assigneeUserId === undefined ? {} : { assigneeUserId }) }, cursor, limit)
    },
    /**
     * Reads one Work Item by key or ID, with its key.
     * @param reference - Key or Work Item ID.
     * @param teamId - Team of a Work Item ID.
     * @returns The Work Item and its key.
     */
    async getIssue(reference: string, teamId?: string) {
      const resolved = await resolveIssue(reference, teamId)
      const [issue, key] = await Promise.all([
        api.getIssue(resolved.teamId, resolved.workItemId),
        api.getKey(resolved.teamId, resolved.workItemId),
      ])
      return { ...issue, ...(key === undefined ? {} : { key }) }
    },
    /**
     * Lists one page of a Work Item's comments by key or ID.
     * @param reference - Key or Work Item ID.
     * @param teamId - Team of a Work Item ID.
     * @param cursor - Cursor of the previous page.
     * @param limit - Page size.
     * @returns One page of comments, newest first.
     */
    async listComments(reference: string, teamId?: string, cursor?: string, limit?: number) {
      const resolved = await resolveIssue(reference, teamId)
      return { ...resolved, ...await api.comments(resolved.teamId, resolved.workItemId, cursor, limit) }
    },
  }
}
