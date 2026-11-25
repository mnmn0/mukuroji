import { describe, expect, test } from 'bun:test'
import { HOOK_HEARTBEAT_MAX_PAGES_PER_TEAM, heartbeatOwnRuns, type HookHeartbeatTeam } from './hook-heartbeat'
import { AgentTaskError, type AgentRunRecord } from './work-item-api'

/**
 * Creates an active run record of the fixture member.
 *
 * @param runId - Run ID.
 * @param assigneeUserId - Member who started it.
 * @returns Run record.
 */
function run(runId: string, assigneeUserId = 'member-1', lastHeartbeatAt = '2026-11-25T00:00:00.000Z'): AgentRunRecord {
  return {
    schemaVersion: 1, runId, teamId: 'core', workItemId: `task-${runId}`, assigneeUserId, runtime: 'claude-code',
    agentName: 'claude-code', state: 'active', startRevision: 2, leaseMinutes: 30,
    startedAt: '2026-11-25T00:00:00.000Z', lastHeartbeatAt,
    leaseExpiresAt: '2026-11-25T00:30:00.000Z', stalled: false, reportCount: 0,
  }
}

describe('hook heartbeat', () => {
  test('renews only the instance\'s own active runs and never throws', async () => {
    const listed: unknown[] = []
    const renewed: [string, string][] = []
    const team: HookHeartbeatTeam = {
      teamId: 'core',
      api: {
        /**
         * Lists the fixture runs and records the filters.
         * @param filters - Owner filters.
         * @returns One page.
         */
        async listActiveRuns(filters) {
          listed.push(filters)
          return { items: [run('run-1'), run('run-2', 'member-1', '2026-11-25T00:00:55.000Z'), run('run-3', 'member-2'), run('run-4')], hasMore: false }
        },
        /**
         * Renews a run, refusing one as rate limited and failing another.
         * @param runId - Run ID.
         * @param instanceId - Instance ID.
         * @returns The run.
         */
        async heartbeat(runId, instanceId) {
          if (runId === 'run-2') throw new AgentTaskError('rate_limited', 'Too many heartbeats.', true, 10)
          if (runId === 'run-4') throw new AgentTaskError('unavailable', 'Server unavailable.', true)
          renewed.push([runId, instanceId])
          return run(runId)
        },
      },
    }
    const broken: HookHeartbeatTeam = {
      teamId: 'other',
      api: {
        /** Fails the list. */
        async listActiveRuns() {
          throw new AgentTaskError('unavailable', 'Server unavailable.', true)
        },
        /** Never called. */
        async heartbeat() {
          throw new Error('A Team whose list failed must not be renewed.')
        },
      },
    }
    const owner = { assigneeUserId: 'member-1', instanceId: 'instance-1' }

    expect(await heartbeatOwnRuns([team, broken], owner, { now: Date.parse('2026-11-25T00:01:00.000Z') })).toEqual({ renewed: 1, recent: 1, failed: 2 })
    expect(listed).toEqual([owner])
    // A run of another member that the API returned is not renewed.
    expect(renewed).toEqual([['run-1', 'instance-1']])
  })

  test('a rate-limited heartbeat without a recent heartbeat is a failure, not a current lease', async () => {
    const team: HookHeartbeatTeam = {
      teamId: 'core',
      api: {
        /** Lists one run whose last heartbeat is old. */
        async listActiveRuns() {
          return { items: [run('run-1', 'member-1', '2026-11-25T00:00:00.000Z')], hasMore: false }
        },
        /** Refuses the heartbeat as the credential's throttle would. */
        async heartbeat() {
          throw new AgentTaskError('rate_limited', 'Too many requests.', true, 10)
        },
      },
    }
    expect(await heartbeatOwnRuns([team], { assigneeUserId: 'member-1', instanceId: 'instance-1' }, { now: Date.parse('2026-11-25T00:05:00.000Z') }))
      .toEqual({ renewed: 0, recent: 0, failed: 1 })
  })

  test('follows run cursors and reports a Team with more pages than one call reads as failed', async () => {
    const renewed: string[] = []
    /**
     * Creates a Team whose runs span the given number of pages.
     * @param pages - Pages of one run each.
     * @returns The Team.
     */
    const paged = (pages: number): HookHeartbeatTeam => ({
      teamId: 'core',
      api: {
        /**
         * Lists one run per page.
         * @param _filters - Owner filters.
         * @param cursor - Page cursor.
         * @returns One page.
         */
        async listActiveRuns(_filters, cursor) {
          const page = cursor === undefined ? 0 : Number(cursor)
          return { items: [run(`run-${pages}-${page}`)], hasMore: page + 1 < pages, ...(page + 1 < pages ? { nextCursor: String(page + 1) } : {}) }
        },
        /**
         * Renews a run.
         * @param runId - Run ID.
         * @returns The run.
         */
        async heartbeat(runId) {
          renewed.push(runId)
          return run(runId)
        },
      },
    })
    const owner = { assigneeUserId: 'member-1', instanceId: 'instance-1' }

    expect(await heartbeatOwnRuns([paged(3)], owner)).toEqual({ renewed: 3, recent: 0, failed: 0 })
    expect(renewed).toEqual(['run-3-0', 'run-3-1', 'run-3-2'])
    renewed.length = 0
    expect(await heartbeatOwnRuns([paged(HOOK_HEARTBEAT_MAX_PAGES_PER_TEAM + 1)], owner)).toEqual({ renewed: 0, recent: 0, failed: 1 })
    expect(renewed).toEqual([])
  })

  test('renews only runs inside the configured Project and counts a failed scope read', async () => {
    const renewed: string[] = []
    const team: HookHeartbeatTeam = {
      teamId: 'core',
      api: {
        /** Lists three runs. */
        async listActiveRuns() {
          return { items: [run('inside'), run('outside'), run('unreadable')], hasMore: false }
        },
        /**
         * Renews a run.
         * @param runId - Run ID.
         * @returns The run.
         */
        async heartbeat(runId) {
          renewed.push(runId)
          return run(runId)
        },
      },
    }
    /**
     * Places only the run `inside` in the Project and fails to read `unreadable`.
     * @param listed - Listed run.
     * @returns Whether the run is in scope.
     */
    const runInScope = async (listed: AgentRunRecord) => {
      if (listed.runId === 'unreadable') throw new AgentTaskError('unavailable', 'Server unavailable.', true)
      return listed.runId === 'inside'
    }

    expect(await heartbeatOwnRuns([team], { assigneeUserId: 'member-1', instanceId: 'instance-1' }, { runInScope }))
      .toEqual({ renewed: 1, recent: 0, failed: 1 })
    expect(renewed).toEqual(['inside'])
  })
})
