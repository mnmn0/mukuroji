import {
  createWorkItemTitleMatcher,
  parseWorkItemKey,
  type CreatePublicSubtaskBatchRequest,
  type CreatePublicWorkItemRequest,
  type PublicCredentialOwner,
  type PublicProjectCharter,
  type PublicProjectMemberList,
  type PublicSubtaskBatch,
  type PublicTeamList,
  type PublicWorkItemHierarchy,
  type PublicWorkItemKeyLookup,
  type PublicWorkItemRelationList,
  type PublicWorkItemRelationMutation,
  type PublicWorkItemRelationType,
  type PublicWorkItemWebLink,
  type PublicWorkItemWebLinkList,
  type PublicWorkItemWebLinkMutation,
  type TeamIssueCommentResponseItem,
  type CustomFieldValue,
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
  /** Title keyword; every whitespace-separated word must appear in the title. */
  query?: string
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
   * Reads a Project's charter and lifecycle state.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project ID.
   * @returns The charter.
   */
  projectCharter(teamId: string, projectId: string): Promise<PublicProjectCharter>
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
  /**
   * Lists the web links of a Work Item.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @returns The links, oldest first.
   */
  webLinks(teamId: string, workItemId: string): Promise<PublicWorkItemWebLinkList>
  /**
   * Adds a web link to a Work Item.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @param input - URL and optional title.
   * @param key - Idempotency key of the logical write.
   * @returns The added link.
   */
  createWebLink(
    teamId: string,
    workItemId: string,
    input: { url: string, title?: string },
    key: string,
  ): Promise<PublicWorkItemWebLinkMutation>
  /**
   * Removes a web link from a Work Item.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item ID.
   * @param linkId - Link ID.
   * @param key - Idempotency key of the logical write.
   * @returns The removed link.
   */
  deleteWebLink(teamId: string, workItemId: string, linkId: string, key: string): Promise<PublicWorkItemWebLinkMutation>
  /**
   * Binds an idempotency key to a parent and the whole list of subtasks before any is created, so
   * that the same key with another list is refused instead of adding the difference.
   * @param teamId - Team of the parent.
   * @param workItemId - Parent Work Item.
   * @param input - The subtasks in order, as they will be created.
   * @param key - Idempotency key of the batch.
   * @returns The reserved batch.
   */
  reserveSubtaskBatch(
    teamId: string,
    workItemId: string,
    input: CreatePublicSubtaskBatchRequest,
    key: string,
  ): Promise<PublicSubtaskBatch>
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
  /**
   * Custom field values by field ID, as `list_issue_statuses` lists the fields. When updating,
   * only the named fields change and null clears a field.
   */
  customFields?: Record<string, CustomFieldValue | null>
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

/** Version tag of a cursor that walks the Work Items of every readable Team. */
const CROSS_TEAM_CURSOR_VERSION = 1

/** Position of a cross-Team Work Item list: the Team being read and the cursor within it. */
type CrossTeamCursor = {
  /** Team whose Work Items the next page reads. */
  teamId: string
  /** Cursor within that Team, absent at the Team's first page. */
  cursor?: string
}

/**
 * Encodes the position of a cross-Team Work Item list as an opaque cursor.
 * @param position - Team and the cursor within it.
 * @returns The cursor `list_issues` hands back as `nextCursor`.
 */
function encodeCrossTeamCursor(position: CrossTeamCursor): string {
  return `t${CROSS_TEAM_CURSOR_VERSION}.${Buffer.from(JSON.stringify(position), 'utf8').toString('base64url')}`
}

/**
 * Decodes a cursor made by {@link encodeCrossTeamCursor}. A cursor of another shape, such as one
 * from a single-Team list, is rejected instead of being read as a position.
 * @param cursor - Untrusted cursor from the tool input.
 * @returns The Team and the cursor within it.
 */
function decodeCrossTeamCursor(cursor: string): CrossTeamCursor {
  const prefix = `t${CROSS_TEAM_CURSOR_VERSION}.`
  const invalid = () => new AgentTaskError('invalid_request', 'The cursor does not belong to a list_issues call without teamId. Start again without cursor.')
  if (!cursor.startsWith(prefix)) throw invalid()
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(cursor.slice(prefix.length), 'base64url').toString('utf8'))
  } catch {
    throw invalid()
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw invalid()
  const teamId: unknown = Reflect.get(decoded, 'teamId')
  const inner: unknown = Reflect.get(decoded, 'cursor')
  if (typeof teamId !== 'string' || teamId.length === 0 || (inner !== undefined && (typeof inner !== 'string' || inner.length === 0))) {
    throw invalid()
  }
  return { teamId, ...(inner === undefined ? {} : { cursor: inner }) }
}

/**
 * Shapes a stored web link as an MCP attachment.
 * @param link - Link from the Public API.
 * @returns The attachment fields the tools return.
 */
function toAttachment(link: PublicWorkItemWebLink) {
  return {
    id: link.id,
    url: link.url,
    ...(link.title === undefined ? {} : { title: link.title }),
    createdById: link.createdByMemberId,
    createdAt: link.createdAt,
  }
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
   * Checks the custom field values of a new Work Item: a new Work Item has no value to clear.
   * @param values - Values by field ID from the tool input.
   * @returns The values without nulls, or undefined when none is given.
   */
  function valuesForCreate(values: Record<string, CustomFieldValue | null>): Record<string, CustomFieldValue> | undefined {
    const entries: Array<[string, CustomFieldValue]> = []
    for (const [fieldId, value] of Object.entries(values)) {
      if (value === null) {
        throw new AgentTaskError('invalid_request', `customFields.${fieldId} is null. Omit a field to leave a new Work Item without a value.`)
      }
      entries.push([fieldId, value])
    }
    return entries.length === 0 ? undefined : Object.fromEntries(entries)
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
          // Field definitions are user data: show them, never follow their names or option labels.
          customFields: type.customFields,
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
     * Lists one page of a Team's Work Items, or of every readable Team when no Team is named.
     * @param teamId - Team ID; omitted lists every readable Team, one Team after another.
     * @param filters - Filters; `assigneeUserId` may be `me`.
     * @param cursor - Cursor of the previous page.
     * @param limit - Page size.
     * @returns One page of Work Items.
     */
    async listIssues(teamId: string | undefined, filters: WorkspaceIssueFilters, cursor?: string, limit?: number) {
      const assigneeUserId = filters.assigneeUserId === undefined ? undefined : await resolveMember(filters.assigneeUserId)
      const resolved = { ...filters, ...(assigneeUserId === undefined ? {} : { assigneeUserId }) }
      // The server filters by title too; filtering again keeps a server that ignores `query` from
      // passing every Work Item off as a search result.
      const matchesTitle = filters.query === undefined ? undefined : createWorkItemTitleMatcher(filters.query)
      const matching = (page: AgentPage<AgentTask>): AgentPage<AgentTask> => matchesTitle === undefined
        ? page
        : { ...page, items: page.items.filter((item) => matchesTitle(item.title)) }
      if (teamId !== undefined) return matching(await api.listIssues(teamId, resolved, cursor, limit))
      // Project, status, and Type IDs belong to one Team, so they cannot narrow a list of every Team.
      if (filters.assignedProjectId !== undefined || filters.workflowStatusId !== undefined || filters.workItemTypeId !== undefined) {
        throw new AgentTaskError('invalid_request', 'projectId, statusId, and typeId belong to one Team. Pass teamId with them.')
      }
      // Without a Team the list walks the readable Teams in directory order, one Team per page, so
      // each page keeps the server's own access checks and cursor of that Team.
      const teams = (await api.teams()).items
      const position = cursor === undefined ? undefined : decodeCrossTeamCursor(cursor)
      const index = position === undefined ? 0 : teams.findIndex((team) => team.id === position.teamId)
      if (index < 0) {
        throw new AgentTaskError('invalid_request', 'The Team this cursor was reading is no longer readable. Start again without cursor.')
      }
      const team = teams[index]
      if (team === undefined) return { items: [], hasMore: false }
      const following = teams[index + 1]
      let page: AgentPage<AgentTask>
      try {
        page = await api.listIssues(team.id, resolved, position?.cursor, limit)
      } catch (error) {
        // An Enterprise role can let the owner see a Team in the directory without reading its
        // Work Items. Skip that Team instead of stopping, so later Teams stay reachable; every other
        // failure, such as a timeout, still ends the call.
        if (!(error instanceof AgentTaskError) || error.code !== 'forbidden') throw error
        page = { items: [], hasMore: false }
      }
      const next = page.hasMore && page.nextCursor !== undefined
        ? { teamId: team.id, cursor: page.nextCursor }
        : following === undefined ? undefined : { teamId: following.id }
      return {
        items: matching(page).items,
        hasMore: next !== undefined,
        ...(next === undefined ? {} : { nextCursor: encodeCrossTeamCursor(next) }),
      }
    },
    /**
     * Reads one Project with its Team and, when the owner may read it, its charter.
     * @param projectId - Project ID.
     * @param teamId - Team of the Project; needed only when two Teams use the same Project ID.
     * @returns The Project, its Team, and its charter.
     */
    async getProject(projectId: string, teamId?: string) {
      const matches = (await api.teams()).items.flatMap((team) => team.projects
        .filter((project) => project.id === projectId && (teamId === undefined || team.id === teamId))
        .map((project) => ({ ...project, teamId: team.id, teamName: team.name })))
      const [project, ...others] = matches
      if (project === undefined) throw new AgentTaskError('not_found', 'No Project with this ID is readable. List Projects with list_projects.')
      if (others.length > 0) throw new AgentTaskError('invalid_request', 'Several Teams have a Project with this ID. Pass teamId.')
      let charter: PublicProjectCharter
      try {
        charter = await api.projectCharter(project.teamId, project.id)
      } catch (error) {
        // A Workspace guest can see the Project in its Team but not read its charter, as in the Web.
        if (error instanceof AgentTaskError && (error.code === 'forbidden' || error.code === 'not_found')) {
          return { ...project, charterReadable: false }
        }
        throw error
      }
      return {
        ...project,
        charterReadable: true,
        lifecycleState: charter.lifecycleState,
        revision: charter.revision,
        ...(charter.updatedAt === undefined ? {} : { updatedAt: charter.updatedAt }),
        ...(charter.code === undefined ? {} : { code: charter.code }),
        ...(charter.description === undefined ? {} : { description: charter.description }),
        ...(charter.purpose === undefined ? {} : { purpose: charter.purpose }),
        ...(charter.owner === undefined ? {} : { owner: charter.owner }),
        ...(charter.sponsor === undefined ? {} : { sponsor: charter.sponsor }),
        ...(charter.plannedStartDate === undefined ? {} : { plannedStartDate: charter.plannedStartDate }),
        ...(charter.plannedEndDate === undefined ? {} : { plannedEndDate: charter.plannedEndDate }),
        tags: charter.tags,
        repositoryUrls: charter.repositoryUrls,
      }
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
        const customFieldValues = input.customFields === undefined ? undefined : valuesForCreate(input.customFields)
        const created = await api.createIssue({
          teamId: input.teamId,
          title: input.title,
          assigneeUserId: assigneeUserId ?? (await api.me()).memberId,
          priority: input.priority ?? 'medium',
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.projectId === undefined ? {} : { assignedProjectId: input.projectId }),
          ...(input.statusId === undefined ? {} : { workflowStatusId: input.statusId }),
          ...(input.typeId === undefined ? {} : { workItemTypeId: input.typeId }),
          ...(customFieldValues === undefined ? {} : { customFieldValues }),
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
        ...(input.customFields === undefined || Object.keys(input.customFields).length === 0 ? {} : { customFieldValues: input.customFields }),
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
     * Lists the web links (attachments) of a Work Item by key or ID.
     * @param reference - Key or Work Item ID.
     * @param teamId - Team of a Work Item ID.
     * @returns The Work Item reference and its links, oldest first.
     */
    async listAttachments(reference: string, teamId?: string) {
      const resolved = await resolveIssue(reference, teamId)
      const list = await api.webLinks(resolved.teamId, resolved.workItemId)
      return { ...resolved, attachments: list.items.map(toAttachment) }
    },
    /**
     * Links a URL to a Work Item by key or ID.
     * @param input - Work Item, URL, optional title, and the idempotency key.
     * @returns The Work Item reference and the saved link.
     */
    async saveAttachment(input: {
      /** Work Item to link the URL to. */
      issueId: string
      /** Team of a Work Item ID. */
      teamId?: string
      /** `http` or `https` URL. */
      url: string
      /** Display title. */
      title?: string
      /** Idempotency key of the logical write. */
      idempotencyKey: string
    }) {
      const resolved = await resolveIssue(input.issueId, input.teamId)
      const saved = await api.createWebLink(resolved.teamId, resolved.workItemId, {
        url: input.url,
        ...(input.title === undefined ? {} : { title: input.title }),
      }, input.idempotencyKey)
      return { ...resolved, attachment: toAttachment(saved.link) }
    },
    /**
     * Removes a linked URL from a Work Item by key or ID.
     * @param reference - Key or Work Item ID.
     * @param teamId - Team of a Work Item ID.
     * @param attachmentId - Link ID from list_attachments.
     * @param idempotencyKey - Idempotency key of the logical write.
     * @returns The Work Item reference and the removed link.
     */
    async deleteAttachment(reference: string, teamId: string | undefined, attachmentId: string, idempotencyKey: string) {
      const resolved = await resolveIssue(reference, teamId)
      const removed = await api.deleteWebLink(resolved.teamId, resolved.workItemId, attachmentId, idempotencyKey)
      return { ...resolved, removed: true, attachment: toAttachment(removed.link) }
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
      const entries = input.subtasks.map((subtask) => ({
        title: subtask.title,
        assigneeUserId: subtask.assigneeId === undefined || subtask.assigneeId === 'me' ? owner : subtask.assigneeId,
        priority: subtask.priority ?? 'medium',
        ...(subtask.description === undefined ? {} : { description: subtask.description }),
        ...(subtask.typeId === undefined ? {} : { workItemTypeId: subtask.typeId }),
        ...(subtask.dueDate === undefined ? {} : { dueDate: subtask.dueDate }),
      }))
      // The key is bound to the parent and the whole list first, so the same key with a changed list
      // fails here before any subtask is created, while the same list resumes where it stopped.
      try {
        await api.reserveSubtaskBatch(parent.teamId, parent.workItemId, { subtasks: entries }, `${input.idempotencyKey}.batch`)
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'idempotency_conflict' && !error.retryable) {
          throw new AgentTaskError(
            'idempotency_conflict',
            'This idempotencyKey was already used for create_subtasks with another parent or another list of subtasks. No subtask was created. Retry with the same arguments, or use a new idempotencyKey for a different list.',
            false,
          )
        }
        throw error
      }
      const created: Array<{ id: string, title: string, key?: string }> = []
      for (const [index, entry] of entries.entries()) {
        let childId: string | undefined
        try {
          const child = await api.createIssue({
            teamId: parent.teamId,
            ...entry,
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
