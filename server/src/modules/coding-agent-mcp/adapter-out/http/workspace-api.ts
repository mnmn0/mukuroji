import { z } from 'zod'
import {
  isCanonicalWorkItemKey,
  PUBLIC_PLANNING_ENTITY_TYPES,
  PUBLIC_WORK_ITEM_RELATION_TYPES,
  type PublicCredentialOwner,
  type PublicDocumentSummary,
  type PublicWorkItemHierarchy,
  type PublicWorkItemRelationList,
  type PublicWorkItemRelationMutation,
  type PublicProjectMemberList,
  type PublicSubtaskBatch,
  type PublicTeamList,
  type PublicWorkItemKeyLookup,
  type PublicPlanningEntity,
  type PublicPlanningEntityList,
  type PublicPlanningEntityMutation,
  type PublicPlanningStatusUpdate,
  type PublicPlanningStatusUpdateMutation,
  type PublicPlanningStatusUpdatePage,
  type PublicWorkItemPlanning,
  type PlanningUpdateTarget,
} from '@mukuroji/contracts'
import { AgentTaskError, type AgentTask } from '../../application/work-item-api'
import type { WorkspaceApi } from '../../application/workspace-api'
import { createPublicApiRequest, pageSchema } from './public-api-request'
import { catalogSchema, commentSchema, documentSchema, identifier, keySchema, linkedDocumentSchema, taskSchema } from './work-item-api'

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

const relationSchema = z.object({
  type: z.enum(PUBLIC_WORK_ITEM_RELATION_TYPES), targetWorkItemId: identifier, createdAt: z.iso.datetime().optional(),
})
const relationListSchema: z.ZodType<PublicWorkItemRelationList> = z.object({
  schemaVersion: z.literal(1), teamId: identifier, workItemId: identifier, relations: z.array(relationSchema).max(1000),
})
const relationMutationSchema: z.ZodType<PublicWorkItemRelationMutation> = z.object({
  schemaVersion: z.literal(1), teamId: identifier, workItemId: identifier, relation: relationSchema,
})
const subtaskBatchSchema: z.ZodType<PublicSubtaskBatch> = z.object({
  schemaVersion: z.literal(1), teamId: identifier, workItemId: identifier, subtaskCount: z.number().int().min(1),
})
const hierarchySchema: z.ZodType<PublicWorkItemHierarchy> = z.object({
  schemaVersion: z.literal(1), teamId: identifier, workItemId: identifier,
  parentWorkItemId: identifier.nullable(), childWorkItemIds: z.array(identifier), wbsNumber: z.string().optional(),
})

const dateRangeSchema = z.object({ startDate: z.iso.date(), endDate: z.iso.date() })
const healthSchema = z.enum(['unknown', 'on-track', 'at-risk', 'off-track'])
const riskSchema = z.enum(['none', 'low', 'medium', 'high', 'critical'])
const planningEntitySchema: z.ZodType<PublicPlanningEntity> = z.object({
  id: identifier, type: z.enum(PUBLIC_PLANNING_ENTITY_TYPES), title: z.string(), description: z.string().optional(),
  parentId: identifier.optional(), teamId: identifier.optional(), projectId: identifier.optional(),
  ownerMemberId: identifier, status: z.enum(['proposed', 'planned', 'active', 'paused', 'completed', 'canceled']),
  health: healthSchema, risk: riskSchema, progress: z.number().min(0).max(100), linkedWorkItemCount: z.number().int().min(0),
  baseline: dateRangeSchema, forecast: dateRangeSchema,
  cadence: z.object({ unit: z.enum(['week', 'month']), count: z.number().int().positive() }).optional(),
  capacity: z.number().int().min(0).optional(), goalFramework: z.enum(['goal', 'objective', 'key-result']).optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
})
const revision = z.number().int().min(0)
/**
 * Largest Planning entity list the MCP reads. The list is one unpaged read of the Planning graph,
 * which the server bounds at 4,000,000 bytes, so it can exceed the default response limit.
 */
const PLANNING_ENTITY_LIST_MAX_BYTES = 5 * 1024 * 1024

const planningEntityListSchema: z.ZodType<PublicPlanningEntityList> = z.object({
  schemaVersion: z.literal(1), revision, items: z.array(planningEntitySchema).max(10000),
})
const planningEntityMutationSchema: z.ZodType<PublicPlanningEntityMutation> = z.object({
  schemaVersion: z.literal(1), revision, item: planningEntitySchema,
})
const workItemPlanningSchema: z.ZodType<PublicWorkItemPlanning> = z.object({
  schemaVersion: z.literal(1), revision, teamId: identifier, workItemId: identifier,
  cycleId: identifier.optional(), milestoneId: identifier.optional(), goalIds: z.array(identifier).max(1000),
})
const updateTargetSchema: z.ZodType<PlanningUpdateTarget> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('project'), teamId: identifier, projectId: identifier }),
  z.object({ type: z.literal('initiative'), entityId: identifier }),
  z.object({ type: z.literal('team'), teamId: identifier }),
])
const statusUpdateSchema: z.ZodType<PublicPlanningStatusUpdate> = z.object({
  id: identifier, version: z.number().int().positive(), target: updateTargetSchema, health: healthSchema, risk: riskSchema,
  summary: z.string(), riskSummary: z.string(), decisionSummary: z.string(), helpNeeded: z.string(), nextAction: z.string(),
  progress: z.object({ percent: z.number().min(0).max(100), linkedWorkItemCount: z.number().int().min(0) }),
  authorMemberId: identifier, coveredDueAt: z.iso.datetime(), createdAt: z.iso.datetime(), acknowledgedAt: z.iso.datetime().optional(),
})
const statusUpdatePageSchema: z.ZodType<PublicPlanningStatusUpdatePage> = z.object({
  schemaVersion: z.literal(1), revision, items: z.array(statusUpdateSchema).max(100),
  hasMore: z.boolean(), nextCursor: z.string().min(1).max(2048).optional(),
}).refine((page) => page.hasMore === (page.nextCursor !== undefined))
const statusUpdateMutationSchema: z.ZodType<PublicPlanningStatusUpdateMutation> = z.object({
  schemaVersion: z.literal(1), revision, item: statusUpdateSchema,
})

/**
 * Tells whether two update targets name the same Project, Team, or Initiative.
 * @param left - First target.
 * @param right - Second target.
 * @returns Whether they are the same target.
 */
function sameTarget(left: PlanningUpdateTarget, right: PlanningUpdateTarget): boolean {
  if (left.type === 'project') return right.type === 'project' && left.teamId === right.teamId && left.projectId === right.projectId
  if (left.type === 'team') return right.type === 'team' && left.teamId === right.teamId
  return right.type === 'initiative' && left.entityId === right.entityId
}

const documentScopeSchema = z.union([
  z.object({ type: z.literal('workspace') }),
  z.object({ type: z.literal('project'), projectId: identifier }),
])
const documentSummarySchema: z.ZodType<PublicDocumentSummary> = z.object({
  id: identifier, kind: z.enum(['folder', 'page', 'template', 'whiteboard']), title: z.string(),
  scope: documentScopeSchema, parentId: identifier.optional(), revision: z.number().int().positive(),
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

  /**
   * Checks that a relation response belongs to the Work Item that was asked for.
   * @param response - Relation list, mutation, or hierarchy from the response.
   * @param teamId - Requested Team.
   * @param workItemId - Requested Work Item.
   * @returns The response.
   */
  function scopedRelations<T extends { teamId: string, workItemId: string }>(response: T, teamId: string, workItemId: string): T {
    if (response.teamId !== teamId || response.workItemId !== workItemId) {
      throw new AgentTaskError('invalid_response', 'The API returned the relations of another Work Item.')
    }
    return response
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
    /** Reads a Work Item's parent, children, and WBS number; see {@link WorkspaceApi.hierarchy}. */
    async hierarchy(teamId, workItemId) {
      return scopedRelations(await request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}/hierarchy`, hierarchySchema, 'GET', undefined, undefined, {
        teamId: id(teamId, 'teamId'),
      }), teamId, workItemId)
    },
    /** Lists a Work Item's relations other than children; see {@link WorkspaceApi.relations}. */
    async relations(teamId, workItemId) {
      return scopedRelations(await request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}/relations`, relationListSchema, 'GET', undefined, undefined, {
        teamId: id(teamId, 'teamId'),
      }), teamId, workItemId)
    },
    /** Links two Work Items with `POST relations`; see {@link WorkspaceApi.createRelation}. */
    async createRelation(teamId, workItemId, input, key) {
      return scopedRelations(await request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}/relations`, relationMutationSchema, 'POST', {
        type: input.type, targetWorkItemId: id(input.targetWorkItemId, 'relatedIssueId'),
      }, key, { teamId: id(teamId, 'teamId') }), teamId, workItemId)
    },
    /** Removes a relation with `DELETE relations/{target}/{type}`; see {@link WorkspaceApi.deleteRelation}. */
    async deleteRelation(teamId, workItemId, targetWorkItemId, type, key) {
      return scopedRelations(await request(
        `work-items/${encodeURIComponent(id(workItemId, 'id'))}/relations/${encodeURIComponent(id(targetWorkItemId, 'relatedIssueId'))}/${type}`,
        relationMutationSchema, 'DELETE', undefined, key, { teamId: id(teamId, 'teamId') },
      ), teamId, workItemId)
    },
    /** Reserves a subtask batch with `POST subtask-batches`; see {@link WorkspaceApi.reserveSubtaskBatch}. */
    async reserveSubtaskBatch(teamId, workItemId, input, key) {
      return scopedRelations(await request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}/subtask-batches`, subtaskBatchSchema, 'POST', input, key, {
        teamId: id(teamId, 'teamId'),
      }), teamId, workItemId)
    },
    /** Lists Planning entities of one type, checking the type and scope of each; see {@link WorkspaceApi.planningEntities}. */
    async planningEntities(type, scope) {
      const list = await request('planning/entities', planningEntityListSchema, 'GET', undefined, undefined, {
        type,
        ...(scope.teamId === undefined ? {} : { teamId: id(scope.teamId, 'teamId') }),
        ...(scope.projectId === undefined ? {} : { projectId: id(scope.projectId, 'projectId') }),
      }, PLANNING_ENTITY_LIST_MAX_BYTES)
      if (list.items.some((item) => item.type !== type ||
          (scope.teamId !== undefined && item.teamId !== scope.teamId) ||
          (scope.projectId !== undefined && item.projectId !== scope.projectId))) {
        throw new AgentTaskError('invalid_response', 'The API returned Planning entities outside the requested scope.')
      }
      return list
    },
    /** Creates a Milestone with `POST planning/milestones`; see {@link WorkspaceApi.createMilestone}. */
    async createMilestone(input, key) {
      const created = await request('planning/milestones', planningEntityMutationSchema, 'POST', input, key)
      if (created.item.type !== 'milestone') throw new AgentTaskError('invalid_response', 'The API returned another kind of Planning entity.')
      return created
    },
    /** Updates a Milestone with `PATCH`, checking its ID; see {@link WorkspaceApi.updateMilestone}. */
    async updateMilestone(milestoneId, input, key) {
      const updated = await request(`planning/milestones/${encodeURIComponent(id(milestoneId, 'id'))}`, planningEntityMutationSchema, 'PATCH', input, key)
      if (updated.item.id !== milestoneId || updated.item.type !== 'milestone') {
        throw new AgentTaskError('invalid_response', 'The API returned another Planning entity.')
      }
      return updated
    },
    /** Reads a Work Item's Cycle and Milestone; see {@link WorkspaceApi.workItemPlanning}. */
    async workItemPlanning(teamId, workItemId) {
      return scopedRelations(await request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}/planning`, workItemPlanningSchema, 'GET', undefined, undefined, {
        teamId: id(teamId, 'teamId'),
      }), teamId, workItemId)
    },
    /** Changes a Work Item's Cycle or Milestone with `PUT`; see {@link WorkspaceApi.updateWorkItemPlanning}. */
    async updateWorkItemPlanning(teamId, workItemId, input, key) {
      return scopedRelations(await request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}/planning`, workItemPlanningSchema, 'PUT', input, key, {
        teamId: id(teamId, 'teamId'),
      }), teamId, workItemId)
    },
    /** Lists a target's health updates, checking each one's target; see {@link WorkspaceApi.statusUpdates}. */
    async statusUpdates(target, cursor, limit = 20) {
      const query = target.type === 'initiative'
        ? { targetType: 'initiative', entityId: id(target.entityId, 'initiativeId') }
        : target.type === 'team'
          ? { targetType: 'team', teamId: id(target.teamId, 'teamId') }
          : { targetType: 'project', teamId: id(target.teamId, 'teamId'), projectId: id(target.projectId, 'projectId') }
      const page = await request('planning/status-updates', statusUpdatePageSchema, 'GET', undefined, undefined, { ...query, cursor, limit })
      if (page.items.some((item) => !sameTarget(item.target, target))) {
        throw new AgentTaskError('invalid_response', 'The API returned the updates of another target.')
      }
      return page
    },
    /** Publishes a health update, checking its target; see {@link WorkspaceApi.publishStatusUpdate}. */
    async publishStatusUpdate(input, key) {
      const published = await request('planning/status-updates', statusUpdateMutationSchema, 'POST', input, key)
      if (!sameTarget(published.item.target, input.target)) {
        throw new AgentTaskError('invalid_response', 'The API published the update for another target.')
      }
      return published
    },
    /** Lists one page of the Workspace's Documents; see {@link WorkspaceApi.listDocuments}. */
    async listDocuments(filters, cursor, limit = 50) {
      const page = await request('documents', pageSchema(documentSummarySchema), 'GET', undefined, undefined, {
        ...(filters.projectId === undefined ? {} : { projectId: id(filters.projectId, 'projectId') }),
        ...(filters.parentId === undefined ? {} : { parentId: id(filters.parentId, 'parentId') }),
        cursor, limit,
      })
      if (filters.projectId !== undefined && page.items.some((item) => item.scope.type !== 'project' || item.scope.projectId !== filters.projectId)) {
        throw new AgentTaskError('invalid_response', 'The API returned a Document of another Project.')
      }
      return page
    },
    /** Lists one page of a Work Item's linked Documents; see {@link WorkspaceApi.workItemDocuments}. */
    workItemDocuments(teamId, workItemId, cursor, limit = 50) {
      return request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}/documents`, pageSchema(linkedDocumentSchema), 'GET', undefined, undefined, {
        teamId: id(teamId, 'teamId'), cursor, limit,
      })
    },
    /** Reads a Document as Markdown and checks its ID; see {@link WorkspaceApi.getDocument}. */
    async getDocument(documentId) {
      const found = await request(`documents/${encodeURIComponent(id(documentId, 'id'))}`, documentSchema)
      if (found.id !== documentId) throw new AgentTaskError('invalid_response', 'The API returned another Document.')
      return found
    },
    /** Creates a page with `POST documents`; see {@link WorkspaceApi.createDocument}. */
    createDocument(input, key) {
      return request('documents', documentSummarySchema, 'POST', {
        ...input,
        ...(input.projectId === undefined ? {} : { projectId: id(input.projectId, 'projectId') }),
        ...(input.parentId === undefined ? {} : { parentId: id(input.parentId, 'parentId') }),
        ...(input.workItem === undefined
          ? {}
          : { workItem: { teamId: id(input.workItem.teamId, 'teamId'), workItemId: id(input.workItem.workItemId, 'issueId') } }),
      }, key)
    },
    /** Changes a Document with `PATCH documents/{id}` and checks its ID; see {@link WorkspaceApi.updateDocument}. */
    async updateDocument(documentId, input, key) {
      const saved = await request(`documents/${encodeURIComponent(id(documentId, 'id'))}`, documentSummarySchema, 'PATCH', input, key)
      if (saved.id !== documentId) throw new AgentTaskError('invalid_response', 'The API returned another Document.')
      return saved
    },
    /** Adds a comment to a Work Item; see {@link WorkspaceApi.addComment}. */
    addComment(teamId, workItemId, body, key) {
      return request(`work-items/${encodeURIComponent(id(workItemId, 'id'))}/comments`, commentSchema, 'POST', { body }, key, {
        teamId: id(teamId, 'teamId'),
      })
    },
  }
}
