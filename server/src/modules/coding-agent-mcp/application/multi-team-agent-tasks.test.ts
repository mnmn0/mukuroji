import { describe, expect, test } from 'bun:test'
import { createMultiTeamAgentTasks } from './multi-team-agent-tasks'
import { AgentTaskError, type AgentRunRecord, type AgentTask, type AgentWorkItemApi } from './work-item-api'

const scope = { assigneeUserId: 'agent-member', agentName: 'test-agent', runtime: 'claude-code', instanceId: 'instance-a' } as const

/**
 * Creates an assigned task of a Team.
 *
 * @param teamId - Team that holds the task.
 * @param id - Task ID.
 * @param patch - Fields to override.
 * @returns The task.
 */
function task(teamId: string, id: string, patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id, teamId, revision: 1, title: id, description: '',
    assigneeUserId: 'agent-member', workflowStatusId: 'todo', statusCategory: 'unstarted',
    priority: 'medium', dueDate: '', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    schedule: { mode: 'unscheduled', calendarPolicy: { timeZone: 'UTC', workingWeekdays: ['monday'], holidays: [] } },
    relationIds: [], customFieldValues: {}, ...patch,
  }
}

/**
 * Creates an active run of this instance on a task.
 *
 * @param teamId - Team of the run.
 * @param workItemId - Task the run claims.
 * @param sequence - Distinguishes run IDs.
 * @returns The run.
 */
function run(teamId: string, workItemId: string, sequence: number): AgentRunRecord {
  return {
    schemaVersion: 1, runId: `run_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    teamId, workItemId, assigneeUserId: 'agent-member', runtime: 'claude-code', agentName: 'test-agent',
    state: 'active', startRevision: 2, leaseMinutes: 30, startedAt: '2026-09-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-09-01T00:00:00.000Z', leaseExpiresAt: '2026-09-01T00:30:00.000Z', stalled: false, reportCount: 0,
  }
}

/**
 * Builds the port of one Team: it answers not found for tasks and runs of other Teams, as the
 * server does, and pages its tasks one at a time.
 *
 * @param teamId - Team of the port.
 * @param tasks - Tasks the Team holds.
 * @param runs - Active runs of this instance in the Team.
 * @param projects - Projects of the Team, whose charters it shows.
 * @returns The port and the calls it received.
 */
function teamApi(teamId: string, tasks: AgentTask[], runs: AgentRunRecord[] = [], projects: string[] = []) {
  const calls: string[] = []
  /** Fails a call the scenario does not expect. */
  const unexpected = async (): Promise<never> => { throw new Error(`Unexpected call in ${teamId}`) }
  const api: AgentWorkItemApi = {
    async catalog() { return { teamId, configurationRevision: 1, workItemTypes: [], templates: [] } },
    async get(id) {
      calls.push(`get:${id}`)
      const found = tasks.find((item) => item.id === id)
      if (!found) throw new AgentTaskError('not_found', 'Not found')
      return structuredClone(found)
    },
    async list(_filters, cursor) {
      const index = cursor === undefined ? 0 : Number(cursor)
      const items = tasks.slice(index, index + 1)
      return index + 1 < tasks.length ? { items, hasMore: true, nextCursor: String(index + 1) } : { items, hasMore: false }
    },
    async create(input) {
      calls.push(`create:${input.title}`)
      return task(teamId, `${teamId}-created`, { title: input.title })
    },
    update: unexpected,
    async comments(id) { calls.push(`comments:${id}`); return { items: [], hasMore: false } },
    comment: unexpected,
    startRun: unexpected,
    async listActiveRuns() { return { items: runs, hasMore: false } },
    async claimedRun(id) { return runs.find((item) => item.workItemId === id) },
    takeOverRun: unexpected,
    resumeRun: unexpected,
    async latestRun() { return undefined },
    reportRun: unexpected,
    async getRun(runId) {
      calls.push(`getRun:${runId}`)
      const found = runs.find((item) => item.runId === runId)
      if (!found) throw new AgentTaskError('not_found', 'Not found')
      return found
    },
    async heartbeat(runId) {
      calls.push(`heartbeat:${runId}`)
      const found = runs.find((item) => item.runId === runId)
      if (!found) throw new AgentTaskError('not_found', 'Not found')
      return found
    },
    finishRun: unexpected,
    async agentSettings() {
      const projectBriefs: Record<string, string> = teamId === 'team-b' ? { project: 'Project brief' } : {}
      return {
        schemaVersion: 1, teamId, revision: 0, leaseMinutes: 30, allowTakeoverAfterLeaseExpiry: false,
        readyStatusIds: [], resumableStatusIds: [], requireAcceptanceCriteria: false, acceptNewRuns: true,
        brief: `${teamId} brief`, projectBriefs,
      }
    },
    async acceptanceCriteria() { return [] },
    async effort() { return undefined },
    async actualDates() { return undefined },
    async taskKey() { return undefined },
    async hierarchy() { return undefined },
    async relatedDocuments() { return undefined },
    async projectCharter(projectId) {
      if (!projects.includes(projectId)) return undefined
      return { schemaVersion: 1, teamId, projectId, lifecycleState: 'active', revision: 1, tags: [], repositoryUrls: [] }
    },
    document: unexpected,
    async attachments(id) { calls.push(`attachments:${id}`); return [] },
    async attachmentDownload(id, fileId) {
      calls.push(`download:${id}/${fileId}`)
      return { fileId, versionId: `${fileId}-v1`, url: `https://files.example.test/${teamId}/${fileId}`, expiresAt: '2026-11-25T00:05:00.000Z' }
    },
  }
  return { teamId, api, calls }
}

describe('multi-Team agent tasks', () => {
  test('lists every configured Team in order through one cursor', async () => {
    const tasks = createMultiTeamAgentTasks([
      teamApi('team-a', [task('team-a', 'a1'), task('team-a', 'a2')]),
      teamApi('team-b', [task('team-b', 'b1')]),
    ], scope)
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page += 1) {
      const result = await tasks.list({}, cursor, 10)
      seen.push(...result.items.map((item) => item.id))
      if (!result.hasMore) break
      cursor = result.nextCursor
    }
    expect(seen).toEqual(['a1', 'a2', 'b1'])
    await expect(tasks.list({}, Buffer.from(JSON.stringify({ teamId: 'team-z' })).toString('base64url'))).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(tasks.list({}, 'not a cursor')).rejects.toMatchObject({ code: 'invalid_request' })
  })

  test('routes a task to the Team that holds it', async () => {
    const teamA = teamApi('team-a', [task('team-a', 'a1')])
    const teamB = teamApi('team-b', [task('team-b', 'b1')])
    const tasks = createMultiTeamAgentTasks([teamA, teamB], scope)
    expect((await tasks.get('b1')).task.teamId).toBe('team-b')
    await tasks.comments('b1')
    expect(teamB.calls).toContain('comments:b1')
    expect(teamA.calls).not.toContain('comments:b1')
    await tasks.attachments('b1')
    expect((await tasks.attachmentDownload('b1', 'file-1')).url).toBe('https://files.example.test/team-b/file-1')
    expect(teamB.calls).toEqual(expect.arrayContaining(['attachments:b1', 'download:b1/file-1']))
    expect(teamA.calls.filter((call) => call.startsWith('attachments:') || call.startsWith('download:'))).toEqual([])
    // The Team is remembered, so the second call does not ask the first Team again.
    expect(teamA.calls.filter((call) => call === 'get:b1')).toHaveLength(1)
    await expect(tasks.get('missing')).rejects.toMatchObject({ code: 'not_found' })
  })

  test('offers work from any Team and reports which Team holds it', async () => {
    const tasks = createMultiTeamAgentTasks([
      teamApi('team-a', [task('team-a', 'a1', { statusCategory: 'completed', workflowStatusId: 'done' })]),
      teamApi('team-b', [task('team-b', 'b1')]),
    ], scope)
    const next = await tasks.next({})
    expect(next.action).toBe('start')
    expect(next.task?.id).toBe('b1')
    expect(next.teamId).toBe('team-b')
  })

  test('reports intake stopped only when every Team has stopped new runs', async () => {
    /**
     * Builds a Team with no ready work whose intake switch is set.
     *
     * @param teamId - Team ID.
     * @param acceptNewRuns - Whether the Team accepts new runs.
     * @returns The Team port.
     */
    const idleTeam = (teamId: string, acceptNewRuns: boolean) => {
      const team = teamApi(teamId, [task(teamId, `${teamId}-done`, { statusCategory: 'completed', workflowStatusId: 'done' })])
      const settings = team.api.agentSettings
      team.api.agentSettings = async () => ({ ...(await settings()), acceptNewRuns })
      return team
    }
    const mixed = await createMultiTeamAgentTasks([idleTeam('team-a', false), idleTeam('team-b', true)], scope).next({})
    expect(mixed).toMatchObject({ action: 'none', teamId: 'team-b' })
    expect(mixed).not.toHaveProperty('acceptingNewRuns')
    const stopped = await createMultiTeamAgentTasks([idleTeam('team-a', false), idleTeam('team-b', false)], scope).next({})
    expect(stopped).toMatchObject({ action: 'none', acceptingNewRuns: false })
  })

  test('prefers an active run in a later Team over new work in an earlier Team', async () => {
    const active = run('team-b', 'b1', 1)
    const tasks = createMultiTeamAgentTasks([
      teamApi('team-a', [task('team-a', 'a1')]),
      teamApi('team-b', [task('team-b', 'b1', { statusCategory: 'started', workflowStatusId: 'coding' })], [active]),
    ], scope)
    const next = await tasks.next({})
    expect(next.action).toBe('in_progress')
    expect(next.teamId).toBe('team-b')
    expect(next.ownRuns.map((item) => item.runId)).toEqual([active.runId])
  })

  test('adds up work status across Teams', async () => {
    const tasks = createMultiTeamAgentTasks([
      teamApi('team-a', [task('team-a', 'a1'), task('team-a', 'a2', { statusCategory: 'started', workflowStatusId: 'coding' })]),
      teamApi('team-b', [task('team-b', 'b1', { statusCategory: 'started', workflowStatusId: 'coding' })]),
    ], scope)
    const status = await tasks.status({})
    expect(status.total).toBe(3)
    expect(status.counts.started).toBe(2)
    expect(status.inProgress.map((item) => [item.teamId, item.id])).toEqual([['team-a', 'a2'], ['team-b', 'b1']])
  })

  test('creates in the requested Team and refuses a Team that is not configured', async () => {
    const teamA = teamApi('team-a', [])
    const teamB = teamApi('team-b', [])
    const tasks = createMultiTeamAgentTasks([teamA, teamB], scope)
    const input = { title: 'New', assigneeUserId: 'agent-member', priority: 'medium' as const }
    expect((await tasks.create({ ...input, teamId: 'team-b' }, 'key-1')).teamId).toBe('team-b')
    expect((await tasks.create(input, 'key-2')).teamId).toBe('team-a')
    await expect(tasks.create({ ...input, teamId: 'team-z' }, 'key-3')).rejects.toMatchObject({ code: 'out_of_scope' })
    expect(teamB.calls).toEqual(['create:New'])
  })

  test('routes a heartbeat to the Team that holds the run', async () => {
    const active = run('team-b', 'b1', 2)
    const teamA = teamApi('team-a', [])
    const teamB = teamApi('team-b', [task('team-b', 'b1', { statusCategory: 'started', workflowStatusId: 'coding' })], [active])
    const tasks = createMultiTeamAgentTasks([teamA, teamB], scope)
    expect((await tasks.heartbeat(active.runId)).runId).toBe(active.runId)
    expect(teamA.calls).not.toContain(`heartbeat:${active.runId}`)
    expect(teamB.calls).toContain(`heartbeat:${active.runId}`)
  })

  test('returns the brief of the Team that keeps the Project brief', async () => {
    const tasks = createMultiTeamAgentTasks([teamApi('team-a', []), teamApi('team-b', [])], scope)
    expect(await tasks.brief('project')).toBe('team-b brief\n\nProject brief')
    expect(await tasks.brief('other')).toBe('team-a brief')
  })

  test('returns the owning Team\'s brief for a Project without its own brief', async () => {
    const tasks = createMultiTeamAgentTasks([teamApi('team-a', []), teamApi('team-b', [], [], ['owned'])], scope)
    // team-b owns the Project, so its Team brief applies even though only team-a comes first.
    expect(await tasks.brief('owned')).toBe('team-b brief')
  })

  test('refuses a task ID that two configured Teams hold instead of routing it to either', async () => {
    const teamA = teamApi('team-a', [task('team-a', 'shared')])
    const teamB = teamApi('team-b', [task('team-b', 'shared')])
    const tasks = createMultiTeamAgentTasks([teamA, teamB], scope)
    await expect(tasks.comments('shared')).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(tasks.attachments('shared')).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(tasks.attachmentDownload('shared', 'file-1')).rejects.toMatchObject({ code: 'invalid_request' })
    expect([...teamA.calls, ...teamB.calls].filter((call) => /^(comments|attachments|download):/u.test(call))).toEqual([])

    // A listing that sees the same ID in two Teams marks it ambiguous too.
    const listed = createMultiTeamAgentTasks([teamApi('team-a', [task('team-a', 'shared')]), teamApi('team-b', [task('team-b', 'shared')])], scope)
    let cursor: string | undefined
    for (let page = 0; page < 3; page += 1) {
      const result = await listed.list({}, cursor, 10)
      if (!result.hasMore) break
      cursor = result.nextCursor
    }
    await expect(listed.comments('shared')).rejects.toMatchObject({ code: 'invalid_request' })
  })

  test('returns each Team configuration', async () => {
    const tasks = createMultiTeamAgentTasks([teamApi('team-a', []), teamApi('team-b', [])], scope)
    const configuration = await tasks.configuration()
    expect(configuration.teams.map((team) => team.teamId)).toEqual(['team-a', 'team-b'])
    expect(configuration.assigneeUserId).toBe('agent-member')
  })

  test('rejects an empty, duplicated, or oversized Team list', () => {
    expect(() => createMultiTeamAgentTasks([], scope)).toThrow(AgentTaskError)
    const duplicate = teamApi('team-a', [])
    expect(() => createMultiTeamAgentTasks([duplicate, duplicate], scope)).toThrow(AgentTaskError)
  })
})
