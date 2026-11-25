import type { AgentRunFinishOutcome, WorkflowStatusCategory } from '@mukuroji/contracts'
import { createAgentTasks, type AgentTaskScope, type AgentTaskUpdate, type AgentTransition } from './agent-tasks'
import {
  AgentTaskError,
  type AgentPage,
  type AgentRunReportInput,
  type AgentTask,
  type AgentTaskFilters,
  type AgentWorkItemApi,
} from './work-item-api'

/** Agent task operations bound to one Team. */
export type AgentTasks = ReturnType<typeof createAgentTasks>

/** Public API port of one configured Team. */
export type TeamWorkItemApi = {
  /** Team the port is bound to. */
  teamId: string
  /** Public API port that sends every request with this Team. */
  api: AgentWorkItemApi
}

/** Task creation input, with the Team to create the task in when several are configured. */
export type MultiTeamCreateInput = Parameters<AgentTasks['create']>[0] & {
  /** Configured Team to create the task in; the first configured Team when omitted. */
  teamId?: string
}

/** One configured Team's task operations. */
type TeamTasks = {
  /** Team ID. */
  teamId: string
  /** Port of the Team, for read-only lookups. */
  api: AgentWorkItemApi
  /** Task operations bound to the Team. */
  tasks: AgentTasks
}

/** Decoded `list_tasks` continuation across Teams. */
type MultiTeamCursor = {
  /** Team the next page is read from. */
  teamId: string
  /** That Team's own continuation, absent at its first page. */
  cursor?: string
}

/**
 * Tells whether a Team answered that it does not hold, or does not show, a task or run.
 *
 * @param error - Error of a lookup in one Team.
 * @returns True for not found or forbidden.
 */
function isAbsent(error: unknown): boolean {
  return error instanceof AgentTaskError && (error.code === 'not_found' || error.code === 'forbidden')
}

/** Maximum number of Teams one MCP process may serve. */
export const maximumAgentTeams = 10

/** Status categories counted by `get_work_status`. */
const workflowStatusCategories: readonly WorkflowStatusCategory[] = ['backlog', 'unstarted', 'started', 'completed', 'canceled']

/**
 * Ranks `get_next_task` actions; the lowest rank across Teams is offered.
 *
 * @param action - Action one Team's selection returned.
 * @returns 0 for an active run, 1 for resume, 2 for new work, and 3 otherwise.
 */
function actionRank(action: string): number {
  if (action === 'in_progress') return 0
  if (action === 'resume') return 1
  if (action === 'start') return 2
  return 3
}

/**
 * Creates task operations for one assignee across several Teams. Each Team keeps its own port,
 * workflow, and Agent settings; a task or run is routed to the Team that the server reports it in,
 * and selection and listings cover the Teams in the configured order.
 *
 * @param teams - Ports of the configured Teams, in the operator's order of preference.
 * @param scope - Assignee, optional Project, and run identity shared by every Team.
 * @returns Task operations with the same shape as one Team's, plus Team-aware creation.
 */
export function createMultiTeamAgentTasks(teams: readonly TeamWorkItemApi[], scope: AgentTaskScope) {
  if (teams.length === 0 || teams.length > maximumAgentTeams) {
    throw new AgentTaskError('configuration', `Configure between 1 and ${maximumAgentTeams} Teams.`)
  }
  if (new Set(teams.map((team) => team.teamId)).size !== teams.length) {
    throw new AgentTaskError('configuration', 'Each Team may be configured only once.')
  }
  const bound: TeamTasks[] = teams.map((team) => ({ ...team, tasks: createAgentTasks(team.api, scope) }))
  const teamOfTask = new Map<string, TeamTasks>()
  const teamOfRun = new Map<string, TeamTasks>()
  /** Task IDs that more than one configured Team holds; operations on them are refused. */
  const ambiguousTasks = new Set<string>()

  /**
   * Builds the refusal for a task ID that several configured Teams hold.
   *
   * @returns The error.
   */
  function ambiguousTask(): AgentTaskError {
    return new AgentTaskError(
      'invalid_request',
      'More than one configured Team has a task with this ID. Run the MCP server for one of those Teams to work on it.',
    )
  }

  /**
   * Remembers the Team of each listed task, so later calls on it need no lookup. A task ID seen in
   * two Teams is marked ambiguous instead of being routed to either.
   *
   * @param team - Team the tasks were read from.
   * @param ids - Task IDs.
   */
  function rememberTasks(team: TeamTasks, ids: readonly string[]): void {
    for (const id of ids) {
      if (ambiguousTasks.has(id)) continue
      const known = teamOfTask.get(id)
      if (known !== undefined && known !== team) {
        ambiguousTasks.add(id)
        teamOfTask.delete(id)
        continue
      }
      teamOfTask.set(id, team)
    }
  }

  /**
   * Finds the configured Team a task belongs to. A Team that does not hold the task answers
   * not found (or forbidden). Task IDs are unique only within a Team, so every Team is asked, and an
   * ID that several Teams hold is refused instead of being routed to one of them.
   *
   * @param id - Task ID.
   * @returns The Team of the task.
   * @throws AgentTaskError not_found when no configured Team holds the task, or invalid_request when
   * several do.
   */
  async function teamForTask(id: string): Promise<TeamTasks> {
    if (ambiguousTasks.has(id)) throw ambiguousTask()
    const known = teamOfTask.get(id)
    if (known) return known
    const holders = (await Promise.all(bound.map(async (team) => {
      try {
        await team.api.get(id)
      } catch (error) {
        if (isAbsent(error)) return undefined
        throw error
      }
      return team
    }))).filter((team) => team !== undefined)
    const [holder, ...others] = holders
    if (!holder) throw new AgentTaskError('not_found', 'No configured Team has this task, or you cannot view it.')
    if (others.length > 0) {
      ambiguousTasks.add(id)
      throw ambiguousTask()
    }
    teamOfTask.set(id, holder)
    return holder
  }

  /**
   * Finds the configured Team a run belongs to by reading the run in each Team.
   *
   * @param runId - Run ID.
   * @returns The Team of the run.
   * @throws AgentTaskError not_found when no configured Team holds the run.
   */
  async function teamForRun(runId: string): Promise<TeamTasks> {
    const known = teamOfRun.get(runId)
    if (known) return known
    for (const team of bound) {
      try {
        await team.api.getRun(runId)
      } catch (error) {
        if (isAbsent(error)) continue
        throw error
      }
      teamOfRun.set(runId, team)
      return team
    }
    throw new AgentTaskError('not_found', 'No configured Team has this run.')
  }

  /**
   * Returns the configured Team with the given ID.
   *
   * @param teamId - Team ID, or undefined for the first configured Team.
   * @returns The Team.
   * @throws AgentTaskError out_of_scope for a Team that is not configured.
   */
  function configuredTeam(teamId: string | undefined): TeamTasks {
    const team = teamId === undefined ? bound[0] : bound.find((candidate) => candidate.teamId === teamId)
    if (!team) throw new AgentTaskError('out_of_scope', 'The requested Team is not configured for this MCP server.')
    return team
  }

  /**
   * Encodes a continuation that names the Team to read next.
   *
   * @param next - Team and its own continuation.
   * @returns Opaque cursor.
   */
  function encodeCursor(next: MultiTeamCursor): string {
    return Buffer.from(JSON.stringify(next)).toString('base64url')
  }

  /**
   * Decodes a continuation from `encodeCursor`.
   *
   * @param cursor - Opaque cursor, or undefined for the first page.
   * @returns The Team and its continuation.
   * @throws AgentTaskError invalid_request for a malformed cursor or a Team no longer configured.
   */
  function decodeCursor(cursor: string | undefined): { team: TeamTasks; cursor?: string } {
    if (cursor === undefined) return { team: bound[0] }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    } catch {
      parsed = undefined
    }
    if (typeof parsed !== 'object' || parsed === null || !('teamId' in parsed) || typeof parsed.teamId !== 'string') {
      throw new AgentTaskError('invalid_request', 'The cursor is not valid. Start the listing again without a cursor.')
    }
    const inner = 'cursor' in parsed ? parsed.cursor : undefined
    if (inner !== undefined && typeof inner !== 'string') {
      throw new AgentTaskError('invalid_request', 'The cursor is not valid. Start the listing again without a cursor.')
    }
    const team = bound.find((candidate) => candidate.teamId === parsed.teamId)
    if (!team) throw new AgentTaskError('invalid_request', 'The cursor names a Team that is not configured. Start the listing again without a cursor.')
    return inner === undefined ? { team } : { team, cursor: inner }
  }

  return {
    /** Returns the shared assignment and each Team's settings, brief, charter, and catalog. */
    async configuration() {
      const configurations = await Promise.all(bound.map(async (team) => ({ teamId: team.teamId, ...await team.tasks.configuration() })))
      return {
        assigneeUserId: scope.assigneeUserId,
        ...(scope.assignedProjectId ? { assignedProjectId: scope.assignedProjectId } : {}),
        agentName: scope.agentName,
        runtime: scope.runtime,
        teams: configurations.map(({ teamId, agentSettings, brief, projectCharter, catalog }) => ({
          teamId, agentSettings, brief, projectCharter, catalog,
        })),
      }
    },
    /**
     * Returns the brief of the Team that owns the Project: that Team's brief followed by its Project
     * brief. The owner is the first configured Team that shows the Project's charter. When no Team
     * shows it (an older server), the first Team that keeps a brief for the Project is used, then the
     * first Team.
     *
     * @param projectId - Project ID.
     * @returns The brief, or null when neither brief exists.
     */
    async brief(projectId: string) {
      const owners = await Promise.all(bound.map(async (team) => {
        try {
          return await team.api.projectCharter(projectId) === undefined ? undefined : team
        } catch (error) {
          if (isAbsent(error)) return undefined
          throw error
        }
      }))
      const owner = owners.find((team) => team !== undefined)
      if (owner) return owner.tasks.brief(projectId)
      for (const team of bound) {
        const settings = await team.api.agentSettings()
        if (Object.hasOwn(settings.projectBriefs, projectId)) return team.tasks.brief(projectId)
      }
      return bound[0].tasks.brief(projectId)
    },
    /** Lists the configured Teams one after another; the cursor carries the Team to continue. */
    async list(input: AgentTaskFilters, cursor?: string, limit?: number): Promise<AgentPage<AgentTask>> {
      const start = decodeCursor(cursor)
      const page = await start.team.tasks.list(input, start.cursor, limit)
      rememberTasks(start.team, page.items.map((task) => task.id))
      const nextTeam = bound[bound.indexOf(start.team) + 1]
      const { nextCursor, ...rest } = page
      if (page.hasMore && nextCursor !== undefined) {
        return { ...rest, hasMore: true, nextCursor: encodeCursor({ teamId: start.team.teamId, cursor: nextCursor }) }
      }
      if (nextTeam) return { ...rest, hasMore: true, nextCursor: encodeCursor({ teamId: nextTeam.teamId }) }
      return { ...rest, hasMore: false }
    },
    /** Reads a task from the Team that holds it. */
    async get(id: string) {
      return (await teamForTask(id)).tasks.get(id)
    },
    /**
     * Selects across Teams: an active run first, then resume, then new work. Within the same action
     * the earlier configured Team wins; runs and skipped candidates of every Team are reported.
     */
    async next(input: AgentTaskFilters) {
      const selections = await Promise.all(bound.map(async (team) => ({ team, selection: await team.tasks.next(input) })))
      let chosen = selections[0]
      for (const candidate of selections) {
        if (actionRank(candidate.selection.action) < actionRank(chosen.selection.action)) chosen = candidate
      }
      for (const { team, selection } of selections) {
        rememberTasks(team, [
          ...(selection.task ? [selection.task.id] : []),
          ...selection.skipped.map((skipped) => skipped.taskId),
          ...selection.ownRuns.map((run) => run.workItemId),
        ])
        for (const run of [...selection.ownRuns, ...selection.otherRuns]) teamOfRun.set(run.runId, team)
      }
      return {
        ...chosen.selection,
        teamId: chosen.team.teamId,
        blockedCount: selections.reduce((total, { selection }) => total + selection.blockedCount, 0),
        skipped: selections.flatMap(({ selection }) => selection.skipped),
        ownRuns: selections.flatMap(({ selection }) => selection.ownRuns),
        otherRuns: selections.flatMap(({ selection }) => selection.otherRuns),
      }
    },
    /** Adds up assigned task states across the configured Teams. */
    async status(input: AgentTaskFilters) {
      const statuses = await Promise.all(bound.map(async (team) => ({ team, status: await team.tasks.status(input) })))
      const counts: Record<WorkflowStatusCategory, number> = { backlog: 0, unstarted: 0, started: 0, completed: 0, canceled: 0 }
      for (const { status } of statuses) {
        for (const category of workflowStatusCategories) counts[category] += status.counts[category]
      }
      return {
        counts,
        total: statuses.reduce((total, { status }) => total + status.total, 0),
        inProgress: statuses.flatMap(({ team, status }) => status.inProgress.map((task) => ({ ...task, teamId: team.teamId }))),
      }
    },
    /** Moves a task in the workflow of the Team that holds it. */
    async transition(id: string, expectedRevision: number, workflowStatusId: string, action: AgentTransition, key: string) {
      const team = await teamForTask(id)
      const moved = await team.tasks.transition(id, expectedRevision, workflowStatusId, action, key)
      if ('run' in moved && moved.run) teamOfRun.set(moved.run.runId, team)
      return moved
    },
    /** Updates a task in the Team that holds it. */
    async update(id: string, input: AgentTaskUpdate, key: string) {
      return (await teamForTask(id)).tasks.update(id, input, key)
    },
    /** Creates assigned work in the requested configured Team, or the first one. */
    async create(input: MultiTeamCreateInput, key: string) {
      const { teamId, ...rest } = input
      const team = configuredTeam(teamId)
      const created = await team.tasks.create(rest, key)
      rememberTasks(team, [created.id])
      return created
    },
    /** Reports progress on a task in the Team that holds it. */
    async report(id: string, input: AgentRunReportInput, key: string, runId?: string) {
      return (await teamForTask(id)).tasks.report(id, input, key, runId)
    },
    /** Extends the lease of a run in the Team that holds it. */
    async heartbeat(runId: string) {
      return (await teamForRun(runId)).tasks.heartbeat(runId)
    },
    /** Closes a run in the Team that holds it. */
    async finishRun(runId: string, outcome: AgentRunFinishOutcome, key: string) {
      return (await teamForRun(runId)).tasks.finishRun(runId, outcome, key)
    },
    /** Takes over a stalled run in the Team that holds the task. */
    async takeOver(id: string, runId: string, key: string) {
      const team = await teamForTask(id)
      const taken = await team.tasks.takeOver(id, runId, key)
      teamOfRun.set(taken.run.runId, team)
      return taken
    },
    /** Resumes a started task in the Team that holds it. */
    async resume(id: string, expectedRevision: number, key: string, previousRunId?: string) {
      const team = await teamForTask(id)
      const resumed = await team.tasks.resume(id, expectedRevision, key, previousRunId)
      teamOfRun.set(resumed.run.runId, team)
      return resumed
    },
    /** Reads a task's discussion in the Team that holds it. */
    async comments(id: string, cursor?: string, limit?: number) {
      return (await teamForTask(id)).tasks.comments(id, cursor, limit)
    },
    /** Lists a task's linked Documents in the Team that holds it. */
    async documents(id: string, cursor?: string, limit?: number) {
      return (await teamForTask(id)).tasks.documents(id, cursor, limit)
    },
    /** Reads a linked Document of a task in the Team that holds it. */
    async document(id: string, documentId: string) {
      return (await teamForTask(id)).tasks.document(id, documentId)
    },
  }
}
