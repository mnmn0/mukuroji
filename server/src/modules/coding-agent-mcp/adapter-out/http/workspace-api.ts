import { z } from 'zod'
import {
  isCanonicalWorkItemKey,
  type PublicCredentialOwner,
  type PublicProjectMemberList,
  type PublicTeamList,
  type PublicWorkItemKeyLookup,
} from '@mukuroji/contracts'
import { AgentTaskError, type AgentTask } from '../../application/work-item-api'
import type { WorkspaceApi } from '../../application/workspace-api'
import { createPublicApiRequest, pageSchema } from './public-api-request'
import { catalogSchema, commentSchema, identifier, keySchema, taskSchema } from './work-item-api'

const ownerSchema: z.ZodType<PublicCredentialOwner> = z.object({
  schemaVersion: z.literal(1), workspaceId: identifier, memberId: identifier,
  name: z.string().optional(), email: z.string(),
})
const lifecycleState = z.enum(['proposed', 'approved', 'active', 'on-hold', 'closed', 'archived'])
const teamsSchema: z.ZodType<PublicTeamList> = z.object({
  schemaVersion: z.literal(1),
  items: z.array(z.object({
    id: identifier, name: z.string(),
    projects: z.array(z.object({
      id: identifier, name: z.string(), lifecycleState,
      code: z.string().optional(), ownerMemberId: identifier.optional(),
      plannedStartDate: z.iso.date().optional(), plannedEndDate: z.iso.date().optional(),
    })),
  })),
})
const membersSchema: z.ZodType<PublicProjectMemberList> = z.object({
  schemaVersion: z.literal(1), teamId: identifier, projectId: identifier,
  items: z.array(z.object({
    id: identifier, name: z.string().optional(), email: z.string(), role: z.enum(['manager', 'member', 'viewer']),
  })),
})
const keyLookupSchema: z.ZodType<PublicWorkItemKeyLookup> = z.object({
  schemaVersion: z.literal(1), key: z.string().refine(isCanonicalWorkItemKey), teamId: identifier, workItemId: identifier,
})

/** Trusted operator configuration of a Workspace connection, which fixes no Team. */
export type WorkspaceApiConfiguration = {
  /** Origin of the Mukuroji deployment, with no path, query, or embedded credentials. */
  origin: string
  /** Scoped API key or OAuth access token; never returned through MCP. */
  token: string
}

/**
 * Builds the HTTP adapter of the Workspace tools with a fixed origin, bounded bodies, deadlines,
 * and safe errors. Every response is checked to belong to the Team and Work Item that was asked for.
 * @param config - Validated operator configuration.
 * @param fetcher - HTTP transport, injectable for isolated tests.
 * @returns Workspace Public API port.
 */
export function createWorkspaceApi(
  config: WorkspaceApiConfiguration,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): WorkspaceApi {
  const request = createPublicApiRequest(config, fetcher)

  /**
   * Checks that a Work Item belongs to the Team and ID that were asked for.
   * @param issue - Work Item from the response.
   * @param teamId - Requested Team.
   * @param workItemId - Requested Work Item, when one was named.
   * @returns The Work Item.
   */
  function scoped(issue: AgentTask, teamId: string, workItemId?: string): AgentTask {
    if (issue.teamId !== teamId || (workItemId !== undefined && issue.id !== workItemId)) {
      throw new AgentTaskError('invalid_response', 'The API returned a Work Item of another Team.')
    }
    return issue
  }

  /**
   * Validates an identifier before it is placed in a path or query.
   * @param value - Identifier from the tool input.
   * @param label - Name used in the error.
   * @returns The identifier.
   */
  function id(value: string, label: string): string {
    if (!identifier.safeParse(value).success) throw new AgentTaskError('invalid_request', `${label} is invalid.`)
    return value
  }

  return {
    /** Reads the credential owner from `GET me`; see {@link WorkspaceApi.me}. */
    me: () => request('me', ownerSchema),
    /** Lists readable Teams and Projects from `GET teams`; see {@link WorkspaceApi.teams}. */
    teams: () => request('teams', teamsSchema),
    /** Lists Project members and rejects a response for another Team or Project; see {@link WorkspaceApi.projectMembers}. */
    async projectMembers(teamId, projectId) {
      const members = await request(`projects/${encodeURIComponent(id(projectId, 'projectId'))}/members`, membersSchema, 'GET', undefined, undefined, { teamId: id(teamId, 'teamId') })
      if (members.teamId !== teamId || members.projectId !== projectId) {
        throw new AgentTaskError('invalid_response', 'The API returned the members of another Project.')
      }
      return members
    },
    /** Resolves a key and rejects a response that names another key; see {@link WorkspaceApi.lookupKey}. */
    async lookupKey(key) {
      const found = await request(`work-item-keys/${encodeURIComponent(key)}`, keyLookupSchema)
      if (found.key !== key) throw new AgentTaskError('invalid_response', 'The API resolved another key.')
      return found
    },
    /** Reads the Team's Work Item types and statuses, checking the Team; see {@link WorkspaceApi.catalog}. */
    async catalog(teamId, assignedProjectId) {
      const catalog = await request('work-item-types', catalogSchema, 'GET', undefined, undefined, {
        teamId: id(teamId, 'teamId'),
        ...(assignedProjectId === undefined ? {} : { assignedProjectId: id(assignedProjectId, 'projectId') }),
      })
      if (catalog.teamId !== teamId) throw new AgentTaskError('invalid_response', 'The API returned the catalog of another Team.')
      return catalog
    },
    /** Lists one page of the Team's Work Items, checking each item's Team; see {@link WorkspaceApi.listIssues}. */
    async listIssues(teamId, filters, cursor, limit = 50) {
      const page = await request('work-items', pageSchema(taskSchema), 'GET', undefined, undefined, {
        teamId: id(teamId, 'teamId'), ...filters, cursor, limit,
      })
      return { ...page, items: page.items.map((item) => scoped(item, teamId)) }
    },
    /** Reads one Work Item and checks its Team and ID; see {@link WorkspaceApi.getIssue}. */
    async getIssue(teamId, workItemId) {
      return scoped(await request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}`, taskSchema, 'GET', undefined, undefined, {
        teamId: id(teamId, 'teamId'),
      }), teamId, workItemId)
    },
    /** Reads a Work Item's key, or undefined when the server predates keys (404); see {@link WorkspaceApi.getKey}. */
    async getKey(teamId, workItemId) {
      let found
      try {
        found = await request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}/key`, keySchema, 'GET', undefined, undefined, {
          teamId: id(teamId, 'teamId'),
        })
      } catch (error) {
        // A server older than keys has no key endpoint.
        if (error instanceof AgentTaskError && error.code === 'not_found') return undefined
        throw error
      }
      if (found.teamId !== teamId || found.workItemId !== workItemId) {
        throw new AgentTaskError('invalid_response', 'The API returned the key of another Work Item.')
      }
      return found.key
    },
    /** Lists one page of a Work Item's comments; see {@link WorkspaceApi.comments}. */
    comments(teamId, workItemId, cursor, limit = 50) {
      return request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}/comments`, pageSchema(commentSchema), 'GET', undefined, undefined, {
        teamId: id(teamId, 'teamId'), cursor, limit,
      })
    },
    /** Creates a Work Item with `POST work-items` and checks its Team; see {@link WorkspaceApi.createIssue}. */
    async createIssue(input, key) {
      return scoped(await request('work-items', taskSchema, 'POST', { ...input, teamId: id(input.teamId, 'teamId') }, key), input.teamId)
    },
    /** Updates a Work Item with `PATCH` and checks its Team and ID; see {@link WorkspaceApi.updateIssue}. */
    async updateIssue(teamId, workItemId, input, key) {
      return scoped(await request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}`, taskSchema, 'PATCH', input, key, {
        teamId: id(teamId, 'teamId'),
      }), teamId, workItemId)
    },
    /** Adds a comment to a Work Item; see {@link WorkspaceApi.addComment}. */
    addComment(teamId, workItemId, body, key) {
      return request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}/comments`, commentSchema, 'POST', { body }, key, {
        teamId: id(teamId, 'teamId'),
      })
    },
  }
}
