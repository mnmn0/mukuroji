import {
  DEFAULT_WORK_ITEM_TYPE_ID,
  type UpdatePublicWorkItemRequest,
  type WorkflowStatusCategory,
} from '@mukuroji/contracts'
import { AgentTaskError, type AgentTask, type AgentTaskFilters, type AgentWorkItemApi } from './work-item-api'

/** Operator-selected assignment and optional project scope for agent mutations. */
export type AgentTaskScope = {
  /** Existing Workspace member assigned to work performed by this connection. */
  assigneeUserId: string
  /** Optional restriction of all task operations to one Project. */
  assignedProjectId?: string
  /** Human-readable agent label included in progress comments. */
  agentName: string
}

/** Explicit lifecycle intent; the target status is always selected from current configuration. */
export type AgentTransition = 'start' | 'complete' | 'reopen' | 'cancel' | 'move'

/** Safe read-time dependency result; restricted or missing blockers stay unresolved. */
export type AgentBlockers = {
  /** Number of unfinished, missing, or inaccessible dependency targets. */
  unresolvedCount: number
}

/**
 * Creates coding-agent use cases over the authenticated public API.
 * @param api - Canonical persistence and authorization boundary.
 * @param scope - Operator-selected assignee and optional project restriction.
 * @returns Task selection, lifecycle, progress, and status operations.
 */
export function createAgentTasks(api: AgentWorkItemApi, scope: AgentTaskScope) {
  /** Verifies the optional process-wide Project restriction. */
  function inScope(task: AgentTask): AgentTask {
    if (scope.assignedProjectId !== undefined && task.assignedProjectId !== scope.assignedProjectId) {
      throw new AgentTaskError('out_of_scope', 'This task is outside the configured Project.')
    }
    return task
  }

  /** Requires current assignment before any agent-owned mutation. */
  async function owned(id: string): Promise<AgentTask> {
    const task = inScope(await api.get(id))
    if (task.assigneeUserId !== scope.assigneeUserId) {
      throw new AgentTaskError('not_assigned', 'Assign this task to the configured Workspace member before using agent mutation tools.')
    }
    return task
  }

  /** Pins Project filtering so tool arguments cannot escape operator configuration. */
  function filters(input: AgentTaskFilters = {}): AgentTaskFilters {
    if (scope.assignedProjectId && input.assignedProjectId && input.assignedProjectId !== scope.assignedProjectId) {
      throw new AgentTaskError('out_of_scope', 'The requested Project differs from the configured Project.')
    }
    return { ...input, ...(scope.assignedProjectId ? { assignedProjectId: scope.assignedProjectId } : {}) }
  }

  /** Scans a complete bounded assignment queue; partial scans never masquerade as empty work. */
  async function queue(input: AgentTaskFilters = {}): Promise<AgentTask[]> {
    for (const limit of [50, 10, 2, 1]) {
      try {
        return await queueAtPageSize(input, limit)
      } catch (error) {
        if (!(error instanceof AgentTaskError) || error.code !== 'response_limit' || limit === 1) throw error
        // Cursors bind the page size, so restart the read from the beginning.
      }
    }
    throw new AgentTaskError('response_limit', 'A single task exceeds the response limit.')
  }

  /** Reads at most 1,000 result slots, retaining a stable page size for every cursor. */
  async function queueAtPageSize(input: AgentTaskFilters, limit: number): Promise<AgentTask[]> {
    const tasks = new Map<string, AgentTask>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    const selection = filters({ ...input, assigneeUserId: scope.assigneeUserId })
    for (let pageNumber = 0; pageNumber < 1_000 / limit; pageNumber += 1) {
      const page = await api.list(selection, cursor, limit)
      for (const task of page.items) {
        inScope(task)
        if (task.assigneeUserId !== scope.assigneeUserId) {
          throw new AgentTaskError('invalid_response', 'The API returned a task outside the requested assignment.')
        }
        tasks.set(task.id, task)
      }
      if (!page.hasMore) return [...tasks.values()]
      if (!page.nextCursor || cursors.has(page.nextCursor)) {
        throw new AgentTaskError('invalid_response', 'The API returned a missing or repeated cursor.')
      }
      cursor = page.nextCursor
      cursors.add(cursor)
    }
    throw new AgentTaskError('queue_limit', 'The queue exceeded 1,000 result slots. Narrow the Project or Work Item Type filter and retry.')
  }

  /** Resolves semantic blockers through authorized reads, without leaking inaccessible targets. */
  async function blockers(task: AgentTask): Promise<AgentBlockers> {
    let unresolvedCount = 0
    for (const relation of task.relationIds) {
      if (!relation.startsWith('blockedBy:')) continue
      try {
        const dependency = inScope(await api.get(relation.slice('blockedBy:'.length)))
        if (dependency.statusCategory !== 'completed') unresolvedCount += 1
      } catch (error) {
        if (error instanceof AgentTaskError && ['not_found', 'forbidden', 'out_of_scope'].includes(error.code)) {
          unresolvedCount += 1
        } else throw error
      }
    }
    return { unresolvedCount }
  }

  /** Changes state using the caller's explicit revision, never a silently refreshed revision. */
  async function transition(id: string, expectedRevision: number, workflowStatusId: string, action: AgentTransition, key: string) {
    const task = await owned(id)
    if (expectedRevision > task.revision) {
      throw new AgentTaskError('conflict', 'The supplied revision has not been observed. Reload the task before choosing a transition.')
    }
    // A stale revision is forwarded unchanged so the API can replay a successful receipt.
    // Without that exact receipt the canonical CAS rejects it, including concurrent starts.
    if (task.revision === expectedRevision) {
      const catalog = await api.catalog()
      const type = catalog.workItemTypes.find((item) => item.id === (task.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID))
      const target = type?.workflow.statuses.find((status) => status.id === workflowStatusId)
      const categories: Record<AgentTransition, WorkflowStatusCategory[]> = {
        start: ['started'], complete: ['completed'], reopen: ['backlog', 'unstarted'],
        cancel: ['canceled'], move: ['started'],
      }
      if (!target || !categories[action].includes(target.category)) {
        throw new AgentTaskError('invalid_status', 'Select a status in the requested category from get_configuration.')
      }
      const sources: Record<AgentTransition, WorkflowStatusCategory[]> = {
        start: ['backlog', 'unstarted'], complete: ['started'], reopen: ['completed', 'canceled'],
        cancel: ['backlog', 'unstarted', 'started'], move: ['started'],
      }
      if (!sources[action].includes(task.statusCategory)) {
        throw new AgentTaskError('invalid_transition', 'The task is not in a state that permits this operation. Reload its current status.')
      }
      if (action === 'start' && (await blockers(task)).unresolvedCount > 0) {
        throw new AgentTaskError('blocked', 'This task has unfinished or inaccessible blockers.')
      }
    }
    return api.update(id, { expectedRevision, workflowStatusId }, key)
  }

  return {
    /** Returns configured ownership and current workflow/field requirements. */
    async configuration() { return { ...scope, catalog: await api.catalog() } },
    /** Returns one page, preserving continuation even when no items are returned. */
    async list(input: AgentTaskFilters, cursor?: string, limit?: number) {
      const page = await api.list(filters(input), cursor, limit)
      return { ...page, items: page.items.map(inScope) }
    },
    /** Returns canonical details plus read-time dependency readiness. */
    async get(id: string) {
      const task = inScope(await api.get(id))
      return { task, blockers: await blockers(task) }
    },
    /** Selects existing work first, then ready work by priority, deadline, creation time, and ID. */
    async next(input: AgentTaskFilters) {
      const tasks = (await queue(input)).sort(compareTasks)
      const started = tasks.find((task) => task.statusCategory === 'started')
      if (started) return { action: 'in_progress', task: started, blockedCount: 0, selectionIsAdvisory: true }
      let blockedCount = 0
      let dependencyReads = 0
      for (const task of tasks) {
        if (task.statusCategory !== 'unstarted' && task.statusCategory !== 'backlog') continue
        dependencyReads += task.relationIds.filter((relation) => relation.startsWith('blockedBy:')).length
        if (dependencyReads > 100) throw new AgentTaskError('dependency_limit', 'Selection exceeded 100 dependency reads. Narrow the queue filter.')
        if ((await blockers(task)).unresolvedCount > 0) { blockedCount += 1; continue }
        return { action: 'start', task, blockedCount, selectionIsAdvisory: true }
      }
      return { action: 'none', task: null, blockedCount, selectionIsAdvisory: true }
    },
    /** Summarizes assigned task states without claiming to monitor process liveness. */
    async status(input: AgentTaskFilters) {
      const tasks = await queue(input)
      const counts: Record<WorkflowStatusCategory, number> = { backlog: 0, unstarted: 0, started: 0, completed: 0, canceled: 0 }
      for (const task of tasks) counts[task.statusCategory] += 1
      return { counts, total: tasks.length, inProgress: tasks.filter((task) => task.statusCategory === 'started').map((task) => ({
        id: task.id, title: task.title, workflowStatusId: task.workflowStatusId, revision: task.revision, updatedAt: task.updatedAt,
      })) }
    },
    transition,
    /** Applies metadata changes using revision CAS; assignment and workflow changes have dedicated paths. */
    async update(id: string, input: Pick<UpdatePublicWorkItemRequest, 'expectedRevision' | 'title' | 'description' | 'priority' | 'customFieldValues'>, key: string) {
      const task = await owned(id)
      if (input.expectedRevision > task.revision) {
        throw new AgentTaskError('conflict', 'The supplied revision has not been observed. Reload the task before updating it.')
      }
      return api.update(id, input, key)
    },
    /** Creates assigned work within the operator-selected Project boundary. */
    async create(input: Parameters<AgentWorkItemApi['create']>[0], key: string) {
      const selection = filters({ assignedProjectId: input.assignedProjectId })
      return api.create({ ...input, assignedProjectId: selection.assignedProjectId, assigneeUserId: scope.assigneeUserId }, key)
    },
    /** Adds a durable progress, blocker, or completion report to the existing discussion. */
    async report(id: string, message: string, key: string) {
      await owned(id)
      return api.comment(id, `[${scope.agentName}]\n\n${message}`, key, scope.assignedProjectId, scope.assigneeUserId)
    },
    /** Reads existing discussion without changing the task description or state. */
    async comments(id: string, cursor?: string, limit?: number) {
      inScope(await api.get(id))
      return api.comments(id, cursor, limit, scope.assignedProjectId)
    },
  }
}

/** Orders ready work deterministically; undated work follows dated work at equal priority. */
function compareTasks(first: AgentTask, second: AgentTask): number {
  const priorities = { high: 0, medium: 1, low: 2 }
  return priorities[first.priority] - priorities[second.priority] ||
    (first.dueDate || '9999-12-31').localeCompare(second.dueDate || '9999-12-31') ||
    first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id)
}
