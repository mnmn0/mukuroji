import {
  parseWorkItemKey,
  type CreatePublicWorkItemRequest,
  type PublicCredentialOwner,
  type PublicProjectMemberList,
  type PublicTeamList,
  type PublicWorkItemHierarchy,
  type PublicWorkItemKeyLookup,
  type PublicWorkItemRelationList,
  type PublicWorkItemRelationMutation,
  type PublicWorkItemRelationType,
  type TeamIssueCommentResponseItem,
  type UpdatePublicWorkItemRequest,
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
  /**
   * Creates a Work Item in the Team named by the input.
   * @param input - Work Item fields, including its Team.
   * @param key - Idempotency key of the logical write.
   * @returns The created Work Item.
   */
  createIssue(input: CreatePublicWorkItemRequest, key: string): Promise<AgentTask>
  /**
   * Updates a Work Item with revision conflict protection.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @param input - Changed fields and the expected revision.
   * @param key - Idempotency key of the logical write.
   * @returns The updated Work Item.
   */
  updateIssue(teamId: string, workItemId: string, input: UpdatePublicWorkItemRequest, key: string): Promise<AgentTask>
  /**
   * Adds a comment to a Work Item.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @param body - Comment text.
   * @param key - Idempotency key of the logical write.
   * @returns The saved comment.
   */
  addComment(teamId: string, workItemId: string, body: string, key: string): Promise<TeamIssueCommentResponseItem>
  /**
   * Reads a Work Item's parent, children, and WBS number.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @returns The readable parent and children.
   */
  hierarchy(teamId: string, workItemId: string): Promise<PublicWorkItemHierarchy>
  /**
   * Lists a Work Item's relations other than children.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @returns Relations whose other Work Item the owner can read.
   */
  relations(teamId: string, workItemId: string): Promise<PublicWorkItemRelationList>
  /**
   * Links two Work Items of one Team.
   * @param teamId - Team that owns both Work Items.
   * @param workItemId - Work Item the relation is named from.
   * @param input - Relation type and the other Work Item.
   * @param key - Idempotency key of the logical write.
   * @returns The created relation.
   */
  createRelation(
    teamId: string,
    workItemId: string,
    input: { type: PublicWorkItemRelationType, targetWorkItemId: string },
    key: string,
  ): Promise<PublicWorkItemRelationMutation>
  /**
   * Removes a relation between two Work Items of one Team.
   * @param teamId - Team that owns both Work Items.
   * @param workItemId - Work Item the relation is named from.
   * @param targetWorkItemId - Other Work Item.
   * @param type - Relation type from the first Work Item's point of view.
   * @param key - Idempotency key of the logical write.
   * @returns The removed relation.
   */
  deleteRelation(
    teamId: string,
    workItemId: string,
    targetWorkItemId: string,
    type: PublicWorkItemRelationType,
    key: string,
  ): Promise<PublicWorkItemRelationMutation>
}

/** One Work Item `create_subtasks` creates under the parent. */
export type WorkspaceSubtaskInput = {
  /** Title. */
  title: string
  /** Description text. */
  description?: string
  /** Assignee member ID, or `me`; defaults to `me`. */
  assigneeId?: string
  /** Work Item Type ID; the parent's Type must allow it as a child. */
  typeId?: string
  /** Priority; defaults to medium. */
  priority?: 'high' | 'medium' | 'low'
  /** Due date as `YYYY-MM-DD`. */
  dueDate?: string
}

/** Most Work Items one `create_subtasks` call creates. */
export const WORKSPACE_SUBTASK_LIMIT = 20

/** Fields of `save_issue`; an `id` updates that Work Item, no `id` creates one. */
export type WorkspaceIssueSaveInput = {
  /** Key such as `ABC-123`, or Work Item ID with `teamId`; omitted creates a Work Item. */
  id?: string
  /** Team of a new Work Item, or of a Work Item ID. */
  teamId?: string
  /** Title; required when creating. */
  title?: string
  /** Full description text, replacing the current one. */
  description?: string
  /** Project of the Work Item; null removes it from its Project when updating. */
  projectId?: string | null
  /** Assignee member ID, or `me`; a new Work Item defaults to `me`. */
  assigneeId?: string
  /** Workflow status ID. */
  statusId?: string
  /** Work Item Type ID. */
  typeId?: string
  /** Priority. */
  priority?: 'high' | 'medium' | 'low'
  /** Due date of a new Work Item, as `YYYY-MM-DD`. */
  dueDate?: string
  /** Revision read before the update; required when updating. */
  expectedRevision?: number
  /** Idempotency key of the logical write. */
  idempotencyKey: string
}

/** Longest description `PATCH /api/v1/work-items/{id}` accepts; creation allows 100000. */
const UPDATE_DESCRIPTION_MAX_LENGTH = 4096

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
   * Reads a Work Item's key after a write has already succeeded. A failed read must not hide the
   * saved Work Item, because the caller would otherwise retry a write that already happened.
   * @param teamId - Team of the saved Work Item.
   * @param workItemId - Saved Work Item ID.
   * @returns The key, nothing when the Work Item has none, or a warning when the read failed.
   */
  async function keyAfterWrite(teamId: string, workItemId: string): Promise<{ key?: string, warning?: string }> {
    try {
      const key = await api.getKey(teamId, workItemId)
      return key === undefined ? {} : { key }
    } catch {
      return { warning: 'The Work Item was saved, but its key could not be read. Read it again with get_issue.' }
    }
  }

  /**
   * Resolves a key such as `ABC-123`, or a Work Item ID with its Team, to the Work Item.
   * With a Team the reference is always an ID, because an older Work Item ID such as `task-1`
   * can look like a key of another Work Item.
   * @param reference - Key, or Work Item ID when `teamId` is given.
   * @param teamId - Team of a Work Item ID; omitted for a key.
   * @returns The Team and Work Item ID.
   */
  async function resolveIssue(reference: string, teamId?: string): Promise<ResolvedIssueReference> {
    if (teamId !== undefined) return { teamId, workItemId: reference }
    const key = parseWorkItemKey(reference)
    if (!key) {
      throw new AgentTaskError('invalid_request', 'Pass a key such as ABC-123, or pass teamId with a Work Item ID.')
    }
    const found = await api.lookupKey(key.key)
    return { teamId: found.teamId, workItemId: found.workItemId }
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
    /**
     * Creates a Work Item when no `id` is given, otherwise updates the named one.
     * @param input - Fields to save.
     * @returns The saved Work Item and its key.
     */
    async saveIssue(input: WorkspaceIssueSaveInput) {
      const assigneeUserId = input.assigneeId === undefined ? undefined : await resolveMember(input.assigneeId)
      if (input.id === undefined) {
        if (input.teamId === undefined || input.title === undefined) {
          throw new AgentTaskError('invalid_request', 'Creating a Work Item needs teamId and title. Pass id to update one instead.')
        }
        if (input.expectedRevision !== undefined) {
          throw new AgentTaskError('invalid_request', 'expectedRevision applies only to updates. Pass id to update a Work Item.')
        }
        if (input.projectId === null) {
          throw new AgentTaskError('invalid_request', 'Omit projectId to create a Work Item without a Project.')
        }
        const created = await api.createIssue({
          teamId: input.teamId,
          title: input.title,
          assigneeUserId: assigneeUserId ?? (await api.me()).memberId,
          priority: input.priority ?? 'medium',
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.projectId === undefined ? {} : { assignedProjectId: input.projectId }),
          ...(input.statusId === undefined ? {} : { workflowStatusId: input.statusId }),
          ...(input.typeId === undefined ? {} : { workItemTypeId: input.typeId }),
          // Without a schedule the server uses the Workspace working calendar, as the Web does.
          ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
        }, input.idempotencyKey)
        return { ...created, ...await keyAfterWrite(created.teamId, created.id) }
      }
      if (input.expectedRevision === undefined) {
        throw new AgentTaskError('invalid_request', 'Updating needs expectedRevision. Read it with get_issue first.')
      }
      if (input.dueDate !== undefined) {
        throw new AgentTaskError('invalid_request', 'dueDate can be set only when creating a Work Item.')
      }
      // The Public API accepts a long description only when creating; an update takes up to 4096 characters.
      if (input.description !== undefined && input.description.length > UPDATE_DESCRIPTION_MAX_LENGTH) {
        throw new AgentTaskError('invalid_request', `An updated description can be at most ${UPDATE_DESCRIPTION_MAX_LENGTH} characters.`)
      }
      const resolved = await resolveIssue(input.id, input.teamId)
      const patch: UpdatePublicWorkItemRequest = {
        expectedRevision: input.expectedRevision,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.projectId === undefined ? {} : { assignedProjectId: input.projectId }),
        ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
        ...(input.statusId === undefined ? {} : { workflowStatusId: input.statusId }),
        ...(input.typeId === undefined ? {} : { workItemTypeId: input.typeId }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
      }
      if (Object.keys(patch).length === 1) {
        throw new AgentTaskError('invalid_request', 'Pass at least one field to change.')
      }
      const updated = await api.updateIssue(resolved.teamId, resolved.workItemId, patch, input.idempotencyKey)
      return { ...updated, ...await keyAfterWrite(resolved.teamId, resolved.workItemId) }
    },
    /**
     * Adds a comment to a Work Item by key or ID.
     * @param reference - Key or Work Item ID.
     * @param teamId - Team of a Work Item ID.
     * @param body - Comment text.
     * @param idempotencyKey - Idempotency key of the logical write.
     * @returns The Work Item reference and the saved comment.
     */
    async saveComment(reference: string, teamId: string | undefined, body: string, idempotencyKey: string) {
      const resolved = await resolveIssue(reference, teamId)
      return { ...resolved, comment: await api.addComment(resolved.teamId, resolved.workItemId, body, idempotencyKey) }
    },
    /**
     * Reads a Work Item's parent, children, WBS number, and other relations by key or ID.
     * @param reference - Key or Work Item ID.
     * @param teamId - Team of a Work Item ID.
     * @returns The hierarchy and the relations other than children.
     */
    async listRelations(reference: string, teamId?: string) {
      const resolved = await resolveIssue(reference, teamId)
      const [hierarchy, list] = await Promise.all([
        api.hierarchy(resolved.teamId, resolved.workItemId),
        api.relations(resolved.teamId, resolved.workItemId),
      ])
      return {
        ...resolved,
        parentId: hierarchy.parentWorkItemId,
        childIds: hierarchy.childWorkItemIds,
        ...(hierarchy.wbsNumber === undefined ? {} : { wbsNumber: hierarchy.wbsNumber }),
        relations: list.relations.map((relation) => ({
          type: relation.type,
          relatedIssueId: relation.targetWorkItemId,
          ...(relation.createdAt === undefined ? {} : { createdAt: relation.createdAt }),
        })),
      }
    },
    /**
     * Links or unlinks two Work Items of one Team by key or ID.
     * @param input - Both Work Items, the relation type, whether to remove it, and the idempotency key.
     * @returns The Work Item reference and the changed relation.
     */
    async saveRelation(input: {
      /** Work Item the relation is named from. */
      issueId: string
      /** Team of Work Item IDs. */
      teamId?: string
      /** Relation type from the first Work Item's point of view. */
      type: PublicWorkItemRelationType
      /** Other Work Item, by key or by ID in the same Team. */
      relatedIssueId: string
      /** Whether to remove the relation instead of adding it. */
      remove?: boolean
      /** Idempotency key of the logical write. */
      idempotencyKey: string
    }) {
      const resolved = await resolveIssue(input.issueId, input.teamId)
      const related = await resolveIssue(input.relatedIssueId, input.teamId)
      if (related.teamId !== resolved.teamId) {
        throw new AgentTaskError('invalid_request', 'Relations link Work Items of one Team. Both Work Items must be in the same Team.')
      }
      const result = input.remove === true
        ? await api.deleteRelation(resolved.teamId, resolved.workItemId, related.workItemId, input.type, input.idempotencyKey)
        : await api.createRelation(resolved.teamId, resolved.workItemId, {
            type: input.type,
            targetWorkItemId: related.workItemId,
          }, input.idempotencyKey)
      return {
        ...resolved,
        removed: input.remove === true,
        relation: { type: result.relation.type, relatedIssueId: result.relation.targetWorkItemId },
      }
    },
    /**
     * Creates Work Items under a parent, one by one, each with a key derived from the call's key, so
     * that a retry with the same arguments and key finishes the remaining ones without duplicates.
     * @param input - Parent, the new Work Items, and the idempotency key.
     * @returns The parent reference and the created children in input order.
     */
    async createSubtasks(input: {
      /** Parent Work Item by key or ID. */
      parentId: string
      /** Team of a Work Item ID. */
      teamId?: string
      /** Work Items to create under the parent. */
      subtasks: WorkspaceSubtaskInput[]
      /** Idempotency key of the logical write. */
      idempotencyKey: string
    }) {
      if (input.subtasks.length === 0 || input.subtasks.length > WORKSPACE_SUBTASK_LIMIT) {
        throw new AgentTaskError('invalid_request', `Pass 1 to ${WORKSPACE_SUBTASK_LIMIT} subtasks.`)
      }
      const parent = await resolveIssue(input.parentId, input.teamId)
      // Children join the parent's Project so that the people who see the parent also see them.
      const [{ memberId: owner }, parentIssue] = await Promise.all([api.me(), api.getIssue(parent.teamId, parent.workItemId)])
      const created: Array<{ id: string, title: string, key?: string }> = []
      for (const [index, subtask] of input.subtasks.entries()) {
        let childId: string | undefined
        try {
          const assigneeUserId = subtask.assigneeId === undefined || subtask.assigneeId === 'me' ? owner : subtask.assigneeId
          const child = await api.createIssue({
            teamId: parent.teamId,
            title: subtask.title,
            assigneeUserId,
            priority: subtask.priority ?? 'medium',
            ...(subtask.description === undefined ? {} : { description: subtask.description }),
            ...(subtask.typeId === undefined ? {} : { workItemTypeId: subtask.typeId }),
            ...(subtask.dueDate === undefined ? {} : { dueDate: subtask.dueDate }),
            ...(parentIssue.assignedProjectId ? { assignedProjectId: parentIssue.assignedProjectId } : {}),
          }, `${input.idempotencyKey}.subtask.${index}`)
          childId = child.id
          await api.createRelation(parent.teamId, child.id, {
            type: 'parent',
            targetWorkItemId: parent.workItemId,
          }, `${input.idempotencyKey}.subtask.${index}.parent`)
          created.push({ id: child.id, title: child.title, ...await keyAfterWrite(parent.teamId, child.id) })
        } catch (error) {
          const done = created.length === 0 ? 'No subtask was finished.' : `Subtasks 1 to ${created.length} were created under the parent.`
          // The child creation key replays only the same body, and the body carries the parent's Project. A
          // non-retryable conflict there means the body changed, usually because the parent moved to another
          // Project after the first attempt created this child. A retryable one is an attempt still in progress,
          // which the same key finishes, so it keeps the ordinary retry guidance below.
          const projectChanged = childId === undefined && error instanceof AgentTaskError
            && error.code === 'idempotency_conflict' && !error.retryable
          if (projectChanged) {
            throw new AgentTaskError(
              'idempotency_conflict',
              `${done} Subtask ${index + 1} was already created by an earlier attempt with this idempotencyKey, but the parent's Project (or this subtask's arguments) has changed since then. Move the parent back to its earlier Project and retry with the same arguments and idempotencyKey, or check the parent's subtasks with list_relations before retrying with a new idempotencyKey.`,
              false,
            )
          }
          const message = error instanceof AgentTaskError ? error.message : 'The request failed.'
          // The child exists once its creation succeeded, so name it: a Type the parent does not allow can be
          // changed with save_issue, and the same arguments and key then replay the creation and link it.
          const unlinked = childId === undefined
            ? ''
            : ` Work Item ${childId} was created but is not linked to the parent yet; if its Type is not allowed under the parent, change it with save_issue and retry.`
          throw new AgentTaskError(
            error instanceof AgentTaskError ? error.code : 'transport',
            `${done} Subtask ${index + 1} failed: ${message}${unlinked} Retry with the same arguments and idempotencyKey to finish without duplicates.`,
            error instanceof AgentTaskError ? error.retryable : true,
          )
        }
      }
      return { ...parent, subtasks: created }
    },
  }
}
