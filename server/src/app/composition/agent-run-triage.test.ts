import { describe, expect, test } from 'bun:test'
import type { AgentRunTriageFiling } from '../../modules/agent-runs'
import { TriageError } from '../../modules/triage'
import { createAgentRunTriageFiler, createAgentRunTriageWorkItemReader } from './agent-run-triage'

const filing: AgentRunTriageFiling = {
  runId: 'run_1',
  reason: 'failed',
  title: 'Agent run failed: Fix checkout',
  body: 'Codex (codex) finished its run as failed.',
  agentName: 'Codex',
  assigneeUserId: 'member-1',
}

/**
 * Creates a Triage client double that records idempotency and answers with a fixed result.
 *
 * @param result - Error to throw, or nothing to succeed.
 * @returns Client double and the recorded keys.
 */
function createTriage(result?: Error) {
  const keys: string[] = []
  return {
    keys,
    client: {
      /**
       * Records the idempotency key, then succeeds or throws.
       * @param _workspaceId - Workspace ID.
       * @param _teamId - Team ID.
       * @param _input - Entry content.
       * @param idempotency - Replay protection.
       * @param idempotency.key - Idempotency key.
       * @param idempotency.fingerprint - Input fingerprint.
       * @returns A receipt.
       */
      async createAgentRunEntry(_workspaceId: string, _teamId: string, _input: unknown, idempotency: { key: string; fingerprint: string }) {
        keys.push(idempotency.key)
        if (result) throw result
        return { replayed: false, entry: {} }
      },
    },
  }
}

describe('Agent Run triage composition', () => {
  test('files with one key per run and reason, and treats refused input as rejected', async () => {
    const ok = createTriage()
    expect(await createAgentRunTriageFiler(ok.client, async () => true).file('workspace-1', 'core', filing)).toBe('filed')
    expect(ok.keys).toEqual(['agent-run:run_1:failed'])

    const refused = createTriage(new TriageError(400, 'InvalidTriageInput', 'Agent name is invalid.'))
    expect(await createAgentRunTriageFiler(refused.client, async () => true).file('workspace-1', 'core', filing)).toBe('rejected')
  })

  test('leaves a transient failure to the next sweep and files nothing for a closing Workspace', async () => {
    const conflict = createTriage(new TriageError(409, 'TriageConfigurationConflict', 'Triage settings changed.'))
    await expect(createAgentRunTriageFiler(conflict.client, async () => true).file('workspace-1', 'core', filing))
      .rejects.toMatchObject({ code: 'TriageConfigurationConflict' })

    const closing = createTriage()
    expect(await createAgentRunTriageFiler(closing.client, async () => false).file('workspace-1', 'core', filing)).toBe('rejected')
    expect(closing.keys).toEqual([])
  })

  test('reads archived and deleted Work Items as missing', async () => {
    /**
     * Reads a fixture Work Item by ID.
     * @param _directoryId - Workspace ID.
     * @param _teamId - Team ID.
     * @param workItemId - Work Item ID.
     * @returns The fixture Work Item.
     */
    const getTeamIssueDetail = async (_directoryId: string, _teamId: string, workItemId: string) => {
      if (workItemId === 'deleted') throw Object.assign(new Error('Not found'), { status: 404, code: 'TeamIssueNotFound' })
      return { issue: { title: `Title of ${workItemId}`, ...(workItemId === 'archived' ? { archivedAt: '2026-10-27T00:00:00.000Z' } : {}) } }
    }
    const reader = createAgentRunTriageWorkItemReader({ getTeamIssueDetail })
    expect(await reader.read('workspace-1', 'core', 'task-1')).toEqual({ title: 'Title of task-1', path: '/teams/core/issues?issueId=task-1' })
    expect(await reader.read('workspace-1', 'core', 'archived')).toBeUndefined()
    expect(await reader.read('workspace-1', 'core', 'deleted')).toBeUndefined()
  })
})
