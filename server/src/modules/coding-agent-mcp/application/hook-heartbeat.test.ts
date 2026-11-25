import { describe, expect, test } from 'bun:test'
import { heartbeatOwnRuns, type HookHeartbeatTeam } from './hook-heartbeat'
import { AgentTaskError, type AgentRunRecord } from './work-item-api'

/**
 * Creates an active run record of the fixture member.
 *
 * @param runId - Run ID.
 * @param assigneeUserId - Member who started it.
 * @returns Run record.
 */
function run(runId: string, assigneeUserId = 'member-1'): AgentRunRecord {
  return {
    schemaVersion: 1, runId, teamId: 'core', workItemId: `task-${runId}`, assigneeUserId, runtime: 'claude-code',
    agentName: 'claude-code', state: 'active', startRevision: 2, leaseMinutes: 30,
    startedAt: '2026-11-25T00:00:00.000Z', lastHeartbeatAt: '2026-11-25T00:00:00.000Z',
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
          return { items: [run('run-1'), run('run-2'), run('run-3', 'member-2'), run('run-4')], hasMore: false }
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

    expect(await heartbeatOwnRuns([team, broken], owner)).toEqual({ renewed: 1, recent: 1, failed: 2 })
    expect(listed).toEqual([owner])
    // A run of another member that the API returned is not renewed.
    expect(renewed).toEqual([['run-1', 'instance-1']])
  })
})
