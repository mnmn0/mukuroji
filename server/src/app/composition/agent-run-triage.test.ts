import { describe, expect, test } from 'bun:test'
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import {
  createActiveAgentRun,
  readStartAgentRunRequest,
  type AgentRunTriageFiling,
} from '../../modules/agent-runs'
import { TriageError } from '../../modules/triage'
import { createAgentRunStallNotifier, createAgentRunTriageFiler, createAgentRunTriageWorkItemReader } from './agent-run-triage'

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

  test('notifies a stalled run once through an audit event that holds no instance secret', async () => {
    const run = createActiveAgentRun({
      directoryId: 'workspace-1',
      teamId: 'core',
      workItemId: 'task-1',
      assigneeUserId: 'member-1',
      start: readStartAgentRunRequest({ expectedRevision: 1, workflowStatusId: 'doing', runtime: 'codex', agentName: 'Codex', instanceId: 'laptop-1' }),
      credentialId: 'key-1',
      startRevision: 2,
      leaseMinutes: 30,
      now: new Date('2026-11-25T00:00:00.000Z'),
    })
    const workItem = { title: 'Fix checkout', path: '/teams/core/issues?issueId=task-1', projectId: 'checkout' }
    const commands: TransactWriteCommand[] = []
    let failure: unknown
    const writer = {
      /**
       * Records the transaction, then succeeds or fails.
       * @param command - Transaction.
       */
      async send(command: TransactWriteCommand) {
        commands.push(command)
        if (failure) throw failure
      },
    }
    const notifier = createAgentRunStallNotifier(writer, createTenant(true), 'AuditEvents')
    await notifier.notifyStalled(run, workItem)
    const [put, condition] = commands[0]?.input.TransactItems ?? []
    expect(condition).toEqual({ ConditionCheck: expect.objectContaining({ TableName: 'Tenants' }) })
    const event = put?.Put?.Item
    expect(event).toMatchObject({
      eventType: 'agent-run.stalled',
      outboxStatus: 'pending',
      metadata: {
        teamId: 'core',
        issueId: 'task-1',
        projectId: 'checkout',
        notificationTitle: 'Agent Run stalled',
        notificationCandidates: [{ memberKey: 'member-1', reason: 'agent-run-stalled' }],
      },
    })
    expect(JSON.stringify(event)).not.toContain(run.instanceIdHash)
    expect(JSON.stringify(event)).not.toContain('laptop-1')

    // A retried sweep writes the same event ID, and an existing event means it was already sent.
    failure = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    })
    await notifier.notifyStalled(run, workItem)
    expect(commands[1]?.input.TransactItems?.[0]?.Put?.Item?.eventId).toBe(event?.eventId)

    // A transient failure leaves the run for the next sweep.
    failure = Object.assign(new Error('throttled'), { name: 'ThrottlingException' })
    await expect(notifier.notifyStalled(run, workItem)).rejects.toThrow('throttled')

    // A closing Workspace is not notified.
    const closing: TransactWriteCommand[] = []
    await createAgentRunStallNotifier({
      /**
       * Records the transaction.
       * @param command - Transaction.
       */
      async send(command: TransactWriteCommand) {
        closing.push(command)
      },
    }, createTenant(false), 'AuditEvents').notifyStalled(run, workItem)
    expect(closing).toEqual([])
  })
})
