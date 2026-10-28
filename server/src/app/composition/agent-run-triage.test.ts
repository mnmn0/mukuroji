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
 * Creates a Workspace lifecycle double.
 *
 * @param active - Whether the Workspace accepts writes.
 * @returns Lifecycle double.
 */
function createTenant(active: boolean) {
  return {
    /**
     * Answers with the fixed lifecycle.
     * @returns Whether the Workspace accepts writes.
     */
    isActive: async () => active,
    /**
     * Creates a recognizable condition.
     * @param workspaceId - Workspace ID.
     * @returns Condition check.
     */
    createActiveWriteCondition: (workspaceId: string) => ({
      ConditionCheck: { TableName: 'Tenants', Key: { workspaceId }, ConditionExpression: 'lifecycleStatus = :active' },
    }),
  }
}

/**
 * Creates a Triage client double that records idempotency and answers with a fixed result.
 *
 * @param result - Error to throw, or nothing to succeed.
 * @returns Client double and the recorded keys.
 */
function createTriage(result?: Error) {
  const keys: string[] = []
  const conditions: unknown[] = []
  return {
    keys,
    conditions,
    client: {
      /**
       * Records the idempotency key, then succeeds or throws.
       * @param _workspaceId - Workspace ID.
       * @param _teamId - Team ID.
       * @param _input - Entry content.
       * @param idempotency - Replay protection.
       * @param idempotency.key - Idempotency key.
       * @param idempotency.fingerprint - Input fingerprint.
       * @param checks - Conditions committed with the entry.
       * @returns A receipt.
       */
      async createAgentRunEntry(_workspaceId: string, _teamId: string, _input: unknown, idempotency: { key: string; fingerprint: string }, checks: unknown[]) {
        keys.push(idempotency.key)
        conditions.push(...checks)
        if (result) throw result
        return { replayed: false, entry: {} }
      },
    },
  }
}

describe('Agent Run triage composition', () => {
  test('files with one key per run, and treats refused input as rejected', async () => {
    const ok = createTriage()
    expect(await createAgentRunTriageFiler(ok.client, createTenant(true)).file('workspace-1', 'core', filing)).toBe('filed')
    expect(ok.keys).toEqual(['agent-run:run_1'])
    // The entry commits only while the Workspace is still active.
    expect(ok.conditions).toEqual([{ ConditionCheck: { TableName: 'Tenants', Key: { workspaceId: 'workspace-1' }, ConditionExpression: 'lifecycleStatus = :active' } }])
    // A run that stalled and then failed replays its first entry instead of opening another.
    expect(await createAgentRunTriageFiler(ok.client, createTenant(true)).file('workspace-1', 'core', { ...filing, reason: 'stalled' })).toBe('filed')
    expect(ok.keys).toEqual(['agent-run:run_1', 'agent-run:run_1'])

    const refused = createTriage(new TriageError(400, 'InvalidTriageInput', 'Agent name is invalid.'))
    expect(await createAgentRunTriageFiler(refused.client, createTenant(true)).file('workspace-1', 'core', filing)).toBe('rejected')
    // A routed owner who left the Workspace needs an administrator, not another attempt.
    const ownerGone = createTriage(new TriageError(409, 'TriageAdmissionOwnerUnavailable', 'A configured Triage owner is not an active Workspace member.'))
    expect(await createAgentRunTriageFiler(ownerGone.client, createTenant(true)).file('workspace-1', 'core', filing)).toBe('rejected')
  })

  test('leaves a transient failure to the next sweep and files nothing for a closing Workspace', async () => {
    const conflict = createTriage(new TriageError(409, 'TriageConfigurationConflict', 'Triage settings changed.'))
    await expect(createAgentRunTriageFiler(conflict.client, createTenant(true)).file('workspace-1', 'core', filing))
      .rejects.toMatchObject({ code: 'TriageConfigurationConflict' })

    const closing = createTriage()
    expect(await createAgentRunTriageFiler(closing.client, createTenant(false)).file('workspace-1', 'core', filing)).toBe('rejected')
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
      return {
        issue: {
          title: `Title of ${workItemId}`,
          assignedProjectId: 'checkout',
          ...(workItemId === 'archived' ? { archivedAt: '2026-10-27T00:00:00.000Z' } : {}),
        },
      }
    }
    const reader = createAgentRunTriageWorkItemReader({ getTeamIssueDetail })
    expect(await reader.read('workspace-1', 'core', 'task-1')).toEqual({ title: 'Title of task-1', path: '/teams/core/issues?issueId=task-1', projectId: 'checkout' })
    expect(await reader.read('workspace-1', 'core', 'archived')).toBeUndefined()
    expect(await reader.read('workspace-1', 'core', 'deleted')).toBeUndefined()
  })
})
