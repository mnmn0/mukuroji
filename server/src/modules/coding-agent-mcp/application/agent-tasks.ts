import {
  DEFAULT_WORK_ITEM_TYPE_ID,
  type AgentRunFinishOutcome,
  type AgentRunMutationFence,
  type AgentRunRuntime,
  type UpdatePublicWorkItemRequest,
  type WorkflowStatusCategory,
} from '@mukuroji/contracts'
import {
  AgentTaskError,
  type AgentRunRecord,
  type AgentTask,
  type AgentTaskFilters,
  type AgentWorkItemApi,
} from './work-item-api'

/** Operator-selected assignment and optional project scope for agent mutations. */
export type AgentTaskScope = {
  /** Existing Workspace member assigned to work performed by this connection. */
  assigneeUserId: string
  /** Optional restriction of all task operations to one Project. */
  assignedProjectId?: string
  /** Human-readable agent label included in progress comments. */
  agentName: string
  /** Client runtime recorded on runs started by this process. */
  runtime: AgentRunRuntime
  /** Stable identifier of this agent instance; the server stores only its hash. */
  instanceId: string
}

/** Summary of a run held by another instance, without identifying that instance. */
export type OtherAgentRun = Pick<AgentRunRecord, 'runId' | 'workItemId' | 'runtime' | 'agentName' | 'startedAt' | 'leaseExpiresAt' | 'stalled'>

/** Why a candidate task was not selected. */
export type SkippedTaskReason = 'blocked' | 'active_run'

/** Maximum number of skipped candidates reported by task selection. */
const maximumSkippedReports = 5

/** Maximum number of active-run pages read before reporting a limit. */
const maximumRunPages = 10

/**
 * Started tasks whose claim is read directly during one selection. The run index can briefly miss a
 * run started just before this process restarted; that task is among the most recently updated.
 */
const maximumClaimReads = 10

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

  /**
   * Checks whether a run's task is inside the optional process-wide Project restriction.
   *
   * @param run - Run to check.
   * @returns True when no Project is configured or the run's task belongs to it.
   */
  async function runInScope(run: AgentRunRecord): Promise<boolean> {
    if (scope.assignedProjectId === undefined) return true
    try {
      inScope(await api.get(run.workItemId))
      return true
    } catch (error) {
      if (error instanceof AgentTaskError && ['not_found', 'forbidden', 'out_of_scope'].includes(error.code)) return false
      throw error
    }
  }

  /**
   * Drops runs whose task is outside the configured Project, reading at most ten tasks at a time.
   *
   * @param runs - Active runs of the assignee.
   * @returns Runs inside the configured Project.
   */
  async function scopedRuns(runs: AgentRunRecord[]): Promise<AgentRunRecord[]> {
    if (scope.assignedProjectId === undefined) return runs
    const kept: AgentRunRecord[] = []
    for (let index = 0; index < runs.length; index += 10) {
      const batch = runs.slice(index, index + 10)
      const inside = await Promise.all(batch.map(runInScope))
      kept.push(...batch.filter((_, position) => inside[position]))
    }
    return kept
  }

  /** Reads every active run of the configured assignee in the configured Project, optionally only this instance's runs. */
  async function activeRuns(onlyThisInstance: boolean): Promise<AgentRunRecord[]> {
    const runs: AgentRunRecord[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < maximumRunPages; page += 1) {
      const result = await api.listActiveRuns({
        assigneeUserId: scope.assigneeUserId,
        ...(onlyThisInstance ? { instanceId: scope.instanceId } : {}),
      }, cursor)
      runs.push(...result.items.filter((run) => run.state === 'active'))
      if (!result.hasMore) return scopedRuns(runs)
      if (!result.nextCursor || cursors.has(result.nextCursor)) {
        throw new AgentTaskError('invalid_response', 'The API returned a missing or repeated run cursor.')
      }
      cursor = result.nextCursor
      cursors.add(cursor)
    }
    throw new AgentTaskError('queue_limit', 'More active runs exist than one selection can read. Ask the user to release finished work.')
  }

  /**
   * Strongly reads the run that claims a task, read from the claim rather than the run index.
   *
   * @param taskId - Task to inspect.
   * @param onlyThisInstance - Returns the run only when this instance started it.
   * @returns The claiming run, or undefined.
   */
  async function claimedRun(taskId: string, onlyThisInstance: boolean): Promise<AgentRunRecord | undefined> {
    const run = await api.claimedRun(taskId, onlyThisInstance ? scope.instanceId : undefined)
    return run?.state === 'active' ? run : undefined
  }

  /**
   * Splits active runs into this instance's runs and other instances' runs.
   *
   * @param startedTasks - Started tasks of the queue whose claims are also read directly when they are
   * missing from this instance's runs, because the run index can miss a run started just before this
   * process restarted, or show it in one of the two concurrent reads but not the other.
   * @returns This instance's runs and summaries of other instances' runs.
   */
  async function runsByOwner(startedTasks: readonly AgentTask[] = []): Promise<{
    /** Runs this instance started. */
    own: AgentRunRecord[]
    /** Runs of other instances of the same assignee. */
    others: OtherAgentRun[]
  }> {
    const [own, all] = await Promise.all([activeRuns(true), activeRuns(false)])
    const ownIds = new Set(own.map((run) => run.runId))
    const ownTaskIds = new Set(own.map((run) => run.workItemId))
    const unconfirmed = startedTasks
      .filter((task) => !ownTaskIds.has(task.id))
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
      .slice(0, maximumClaimReads)
    for (const run of await Promise.all(unconfirmed.map((task) => claimedRun(task.id, true)))) {
      if (!run || ownIds.has(run.runId)) continue
      own.push(run)
      ownIds.add(run.runId)
    }
    return {
      own,
      others: all.filter((run) => !ownIds.has(run.runId)).map((run) => ({
        runId: run.runId, workItemId: run.workItemId, runtime: run.runtime, agentName: run.agentName,
        startedAt: run.startedAt, leaseExpiresAt: run.leaseExpiresAt, stalled: run.stalled,
      })),
    }
  }

  /** Builds the fence sent with every mutation of a task. */
  async function fenceFor(taskId: string): Promise<AgentRunMutationFence> {
    const run = await claimedRun(taskId, true)
    return { agentInstanceId: scope.instanceId, ...(run ? { agentRunId: run.runId } : {}) }
  }

  /** Requires that an active run belongs to this instance before acting on it. */
  async function ownRun(runId: string): Promise<AgentRunRecord | undefined> {
    const run = await api.getRun(runId)
    if (run.state !== 'active') return undefined
    if (!(await runInScope(run))) {
      throw new AgentTaskError('out_of_scope', 'This run belongs to a task outside the configured Project.')
    }
    if ((await claimedRun(run.workItemId, true))?.runId === runId) return run
    // A release, finish, or take over may have closed the run between the two reads.
    if ((await api.getRun(runId)).state !== 'active') return undefined
    throw new AgentTaskError('not_own_run', 'This run belongs to another agent instance. Do not operate on it; ask the user.')
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
  async function transition(id: string, expectedRevision: number, workflowStatusId: string, action: AgentTransition, key: string): Promise<AgentTask | {
    /** Started task. */
    task: AgentTask
    /** Run claimed by this instance. */
    run: AgentRunRecord
  }> {
    const task = await owned(id)
    if (expectedRevision > task.revision) {
      throw new AgentTaskError('conflict', 'The supplied revision has not been observed. Reload the task before choosing a transition.')
    }
    // A stale revision is forwarded unchanged so the API can replay a successful receipt.
    // Without that exact receipt the canonical CAS rejects it, including concurrent starts.
    if (task.revision === expectedRevision) {
      const catalog = await api.catalog(scope.assignedProjectId)
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
        if (action === 'start' && task.statusCategory === 'started') {
          const holder = await claimedRun(id, false)
          if (holder && (await claimedRun(id, true))?.runId !== holder.runId) {
            throw new AgentTaskError('agent_run_conflict', 'Another agent instance holds this task. Inspect it with get_task and ask the user before continuing; take it over only when the user asks and its run is stalled.')
          }
        }
        throw new AgentTaskError('invalid_transition', 'The task is not in a state that permits this operation. Reload its current status.')
      }
      if (action === 'start' && (await blockers(task)).unresolvedCount > 0) {
        throw new AgentTaskError('blocked', 'This task has unfinished or inaccessible blockers.')
      }
    }
    if (action === 'start') {
      return api.startRun(id, {
        expectedRevision, workflowStatusId, runtime: scope.runtime, agentName: scope.agentName, instanceId: scope.instanceId,
      }, key)
    }
    return api.update(id, { expectedRevision, workflowStatusId }, key, await fenceFor(id))
  }

  return {
    /** Returns configured ownership, Agent settings, and current workflow/field requirements. */
    async configuration() {
      const [catalog, agentSettings] = await Promise.all([api.catalog(scope.assignedProjectId), api.agentSettings()])
      return {
        assigneeUserId: scope.assigneeUserId,
        ...(scope.assignedProjectId ? { assignedProjectId: scope.assignedProjectId } : {}),
        agentName: scope.agentName,
        runtime: scope.runtime,
        agentSettings: {
          leaseMinutes: agentSettings.leaseMinutes,
          allowTakeoverAfterLeaseExpiry: agentSettings.allowTakeoverAfterLeaseExpiry,
        },
        catalog,
      }
    },
    /** Returns one page, preserving continuation even when no items are returned. */
    async list(input: AgentTaskFilters, cursor?: string, limit?: number) {
      const page = await api.list(filters(input), cursor, limit)
      return { ...page, items: page.items.map(inScope) }
    },
    /** Returns canonical details, dependency readiness, and the task's active run. */
    async get(id: string) {
      const task = inScope(await api.get(id))
      // The claim is read directly, so a run started moments ago or before a restart is found.
      const own = await claimedRun(id, true)
      const holder = own ?? await claimedRun(id, false)
      const activeRun = holder ? { ...holder, ownedByThisInstance: own !== undefined } : null
      return { task, blockers: await blockers(task), activeRun }
    },
    /** Resumes this instance's run first, then selects ready work by priority, deadline, creation time, and ID. */
    async next(input: AgentTaskFilters) {
      const tasks = (await queue(input)).sort(compareTasks)
      const { own, others } = await runsByOwner(tasks.filter((task) => task.statusCategory === 'started'))
      const claimed = new Set([...own.map((run) => run.workItemId), ...others.map((run) => run.workItemId)])
      const runSummary = { ownRuns: own, otherRuns: others, selectionIsAdvisory: true }
      // A run whose task is no longer started is reported in ownRuns so the agent closes it with finish_run.
      const resumed = own
        .map((run) => tasks.find((task) => task.id === run.workItemId && task.statusCategory === 'started'))
        .find((task) => task !== undefined)
      if (resumed) return { action: 'in_progress', task: resumed, blockedCount: 0, skipped: [], ...runSummary }
      const skipped: { taskId: string; reason: SkippedTaskReason }[] = []
      /**
       * Records a skipped task while the report stays within its size limit.
       *
       * @param taskId - Skipped task.
       * @param reason - Why the task was skipped.
       */
      const skip = (taskId: string, reason: SkippedTaskReason) => {
        if (skipped.length < maximumSkippedReports) skipped.push({ taskId, reason })
      }
      let blockedCount = 0
      let dependencyReads = 0
      for (const task of tasks) {
        if (task.statusCategory !== 'unstarted' && task.statusCategory !== 'backlog') continue
        if (claimed.has(task.id)) { skip(task.id, 'active_run'); continue }
        dependencyReads += task.relationIds.filter((relation) => relation.startsWith('blockedBy:')).length
        if (dependencyReads > 100) throw new AgentTaskError('dependency_limit', 'Selection exceeded 100 dependency reads. Narrow the queue filter.')
        if ((await blockers(task)).unresolvedCount > 0) { blockedCount += 1; skip(task.id, 'blocked'); continue }
        return { action: 'start', task, blockedCount, skipped, ...runSummary }
      }
      return { action: 'none', task: null, blockedCount, skipped, ...runSummary }
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
      return api.update(id, input, key, await fenceFor(id))
    },
    /** Creates assigned work within the operator-selected Project boundary. */
    async create(input: Parameters<AgentWorkItemApi['create']>[0], key: string) {
      const selection = filters({ assignedProjectId: input.assignedProjectId })
      return api.create({ ...input, assignedProjectId: selection.assignedProjectId, assigneeUserId: scope.assigneeUserId }, key)
    },
    /** Adds a durable progress, blocker, or completion report to the existing discussion. */
    async report(id: string, message: string, key: string) {
      await owned(id)
      return api.comment(id, `[${scope.agentName}]\n\n${message}`, key, scope.assignedProjectId, scope.assigneeUserId, await fenceFor(id))
    },
    /** Extends the lease of this instance's own run. */
    async heartbeat(runId: string) {
      if (!(await ownRun(runId))) {
        throw new AgentTaskError('agent_run_not_active', 'This run is finished. Do not continue its work without the user.')
      }
      return api.heartbeat(runId, scope.instanceId)
    },
    /** Closes this instance's own run; a finished run is forwarded so an identical retry can replay. */
    async finishRun(runId: string, outcome: AgentRunFinishOutcome, key: string) {
      await ownRun(runId)
      return api.finishRun(runId, outcome, scope.instanceId, key)
    },
    /** Takes over a stalled run of another instance of this assignee; the server enforces the Team setting and the stalled lease. */
    async takeOver(id: string, runId: string, key: string) {
      await owned(id)
      return api.takeOverRun(id, runId, { runtime: scope.runtime, agentName: scope.agentName, instanceId: scope.instanceId }, key)
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
