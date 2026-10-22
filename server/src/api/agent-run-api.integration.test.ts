import { afterEach, describe, expect, test } from 'bun:test'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicAgentRunService, createCanonicalPublicWorkItemService } from './api-router'
import {
  InMemoryAgentRunStore,
  InMemoryTransactionCanceledError,
  createActiveAgentRun,
  createDefaultAgentSettings,
  finishAgentRun,
  hashAgentInstanceId,
  readStartAgentRunRequest,
  type StoredAgentRun,
} from '../modules/agent-runs'
import { createAgentRunFenceConflictError } from '../modules/work-items/adapter-out/dynamodb/work-item-client'
import { createAuditEventId, createMutationAuditContext } from '../modules/audit/audit'
import {
  AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM,
  createAgentRunAuditPut,
  createAgentRunDeletionFences,
} from './shared/agent-run-access'
import { resolveDeveloperCredentialPrincipal } from './shared/developer-platform-access'
import type { AuthenticatedDeveloperCredential } from '../modules/developer-platform/application/ports'
import type { CollaborationClient } from '../modules/collaboration/collaboration'

const {
  app,
  configureFakeProjectClients,
  createCollaborationStub,
  resetTestApp,
  runWithTestAppDependencies,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const workspaceId = 'user#demo@example.com'
const credential: AuthenticatedDeveloperCredential = {
  kind: 'api-key',
  workspaceId,
  credentialId: 'agent-key',
  subjectUserId: 'demo@example.com',
  scopes: ['work-items:read', 'work-items:write'],
}

/**
 * Creates an active run held by another instance of the same member.
 *
 * @param workItemId - Claimed Work Item.
 * @param instanceId - Raw instance ID of the holder.
 * @returns Stored run.
 */
function createHeldRun(workItemId: string, instanceId = 'other-laptop'): StoredAgentRun {
  return createActiveAgentRun({
    directoryId: workspaceId,
    teamId: 'core-team',
    workItemId,
    assigneeUserId: 'demo@example.com',
    start: readStartAgentRunRequest({
      expectedRevision: 1,
      workflowStatusId: 'in-progress',
      runtime: 'codex',
      agentName: 'Codex',
      instanceId,
    }),
    credentialId: 'agent-key',
    startRevision: 2,
    leaseMinutes: 30,
    // Started a minute ago, so a heartbeat in the same millisecond cannot look like an older renewal.
    now: new Date(Date.now() - 60_000),
  })
}

/**
 * Configures fakes for an unstarted Work Item assigned to the credential owner and an in-memory
 * store that commits Agent Run items when the Work Item update commits.
 *
 * @param overrides - Detail fake options.
 * @returns The store and the Agent Run items observed by updates.
 */
function configureUnstartedAssignedWorkItem(overrides: {
  /** Assignee returned by the detail fake. */
  assigneeUserId?: string
  /** Status category returned by the detail fake. */
  statusCategory?: 'unstarted' | 'started'
  /** Team role of the caller. */
  role?: 'member' | 'manager' | 'viewer'
  /** Runs just before the fenced update applies its Agent Run items, to simulate a concurrent write. */
  beforeCommit?: () => void
} = {}) {
  const store = new InMemoryAgentRunStore()
  const observed: unknown[][] = []
  configureFakeProjectClients(true, {
    directoryId: workspaceId,
    role: overrides.role ?? 'member',
    workspaceRole: 'member',
    detailAssigneeUserId: overrides.assigneeUserId ?? 'demo@example.com',
    detailWorkflowStatusId: overrides.statusCategory === 'started' ? 'in-progress' : 'todo',
    detailStatusCategory: overrides.statusCategory ?? 'unstarted',
    issueUpdateHook(input) {
      const items = input.agentRunTransactItems ?? []
      observed.push(items)
      overrides.beforeCommit?.()
      try {
        store.applyTransactItems(items)
      } catch (error) {
        if (error instanceof InMemoryTransactionCanceledError) throw createAgentRunFenceConflictError()
        throw error
      }
    },
  })
  setTestAppDependencies({ agentRuns: store })
  return { store, observed }
}

describe('public Agent Run service', () => {
  test('starts a run atomically with the started transition and fences other instances', async () => {
    const { store, observed } = configureUnstartedAssignedWorkItem()
    const receipts: unknown[] = []
    setTestAppDependencies({
      transactions: {
        async prepareIdempotencyCompletionTransactWrite(input) {
          receipts.push(input.response)
          return { transactWriteItem: { Put: { TableName: 'DeveloperPlatformTable', Item: { receipt: true } } } }
        },
      },
    })
    const service = createCanonicalPublicAgentRunService()
    const started = await runWithTestAppDependencies(() => service.start(
      credential, 'core-team', 'task-1',
      readStartAgentRunRequest({ expectedRevision: 1, workflowStatusId: 'in-progress', runtime: 'claude-code', agentName: 'Claude Code', instanceId: 'laptop-1' }),
      { requestId: 'start-1', idempotencyKey: 'start-key-1' },
      { credentialId: 'agent-key', idempotencyKey: 'start-key-1', requestFingerprint: 'fp', reservationId: 'reservation-1' },
    ))
    expect(started.run).toMatchObject({
      teamId: 'core-team', workItemId: 'task-1', assigneeUserId: 'demo@example.com', runtime: 'claude-code',
      state: 'active', startRevision: 2, leaseMinutes: 30, stalled: false, reportCount: 0,
    })
    expect(started.run.runId).toMatch(/^run_/u)
    expect(started.workItem).toMatchObject({ id: 'task-1' })
    expect(observed[0]?.length).toBeGreaterThanOrEqual(2)
    expect(store.state.claims.get(`${workspaceId}|core-team|task-1`)?.runId).toBe(started.run.runId)
    // A replay must return the 201 start response, not the bare Work Item.
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ status: 201, body: { run: started.run, workItem: { id: 'task-1', revision: 2 } } })

    const other = await runWithTestAppDependencies(() => service.start(
      credential, 'core-team', 'task-1',
      readStartAgentRunRequest({ expectedRevision: 1, workflowStatusId: 'in-progress', runtime: 'codex', agentName: 'Codex', instanceId: 'laptop-2' }),
      { requestId: 'start-2', idempotencyKey: 'start-key-2' },
      { credentialId: 'agent-key', idempotencyKey: 'start-key-2', requestFingerprint: 'fp2', reservationId: 'reservation-2' },
    )).catch((error: unknown) => error)
    expect(other).toMatchObject({ category: 'conflict', reason: 'agent_run_conflict' })
    expect(other instanceof Error ? other.message : '').toContain('Claude Code (claude-code)')
  })

  test('rejects starts by another member, from a started status, or into a non-started status', async () => {
    const service = createCanonicalPublicAgentRunService()
    /**
     * Starts a run on the fixture task.
     *
     * @param workflowStatusId - Target workflow status.
     * @returns The start response.
     */
    const start = (workflowStatusId = 'in-progress') => runWithTestAppDependencies(() => service.start(
      credential, 'core-team', 'task-1',
      readStartAgentRunRequest({ expectedRevision: 1, workflowStatusId, runtime: 'claude-code', agentName: 'Claude Code', instanceId: 'laptop-1' }),
      { requestId: 'start', idempotencyKey: 'start-key' },
      { credentialId: 'agent-key', idempotencyKey: 'start-key', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))
    configureUnstartedAssignedWorkItem({ assigneeUserId: 'sato@example.com' })
    await expect(start()).rejects.toMatchObject({ category: 'forbidden', reason: 'agent_run_forbidden' })
    resetTestApp()
    configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    await expect(start()).rejects.toMatchObject({ reason: 'invalid_transition' })
    resetTestApp()
    const { store } = configureUnstartedAssignedWorkItem()
    await expect(start('todo')).rejects.toMatchObject({ reason: 'invalid_transition' })
    expect(store.state.runs.size).toBe(0)
  })

  test('fences a public update: another instance conflicts and the holder extends its lease', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const held = createHeldRun('task-1')
    store.seed(held)
    const workItems = createCanonicalPublicWorkItemService()
    /**
     * Renames the fixture task with an Agent Run fence.
     *
     * @param fence - Fence the agent sends.
     * @returns The updated Work Item.
     */
    const update = (fence: { agentRunId?: string, instanceIdHash: string }) => runWithTestAppDependencies(() => workItems.update(
      credential, 'core-team', 'task-1', { expectedRevision: 1, title: 'Renamed' },
      { requestId: 'update', idempotencyKey: `update-${fence.instanceIdHash.slice(0, 6)}` }, undefined, fence,
    ))
    await expect(update({ instanceIdHash: hashAgentInstanceId('laptop-1') }))
      .rejects.toMatchObject({ reason: 'agent_run_conflict' })
    await expect(update({ agentRunId: held.runId, instanceIdHash: hashAgentInstanceId('laptop-1') }))
      .rejects.toMatchObject({ reason: 'agent_run_not_active' })
    const before = (await store.getRun(workspaceId, 'core-team', held.runId))?.lastHeartbeatAt ?? ''
    await new Promise((resolve) => setTimeout(resolve, 5))
    await update({ agentRunId: held.runId, instanceIdHash: held.instanceIdHash })
    const after = (await store.getRun(workspaceId, 'core-team', held.runId))?.lastHeartbeatAt ?? ''
    expect(after > before).toBe(true)
  })

  test('does not let another member reuse the holder instance ID to pass the fence', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const foreign = { ...createHeldRun('task-1', 'laptop-1'), assigneeUserId: 'sato@example.com' }
    store.seed(foreign)
    const workItems = createCanonicalPublicWorkItemService()
    await expect(runWithTestAppDependencies(() => workItems.update(
      credential, 'core-team', 'task-1', { expectedRevision: 1, title: 'Renamed' },
      { requestId: 'update', idempotencyKey: 'shared-instance' }, undefined, { instanceIdHash: hashAgentInstanceId('laptop-1') },
    ))).rejects.toMatchObject({ reason: 'agent_run_conflict' })
  })

  test('fences a public comment with condition checks and keeps unfenced comments unchanged', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const held = createHeldRun('task-1')
    store.seed(held)
    const writes: Parameters<CollaborationClient['createComment']>[0][] = []
    setTestAppDependencies({ collaboration: createCollaborationStub({
      async createComment(input) {
        writes.push(input)
        return {
          id: `comment-${writes.length}`, rootCommentId: `comment-${writes.length}`, authorMemberKey: input.actorMemberKey,
          bodyMarkdown: input.bodyMarkdown, version: 1, mentionMemberKeys: [], reactions: [], acceptedResolutions: [],
          createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
        }
      },
    }) })
    const workItems = createCanonicalPublicWorkItemService()
    await expect(runWithTestAppDependencies(() => workItems.addComment(
      credential, 'core-team', 'task-1', 'progress', { requestId: 'comment', idempotencyKey: 'comment-1' },
      undefined, undefined, { instanceIdHash: hashAgentInstanceId('laptop-1') },
    ))).rejects.toMatchObject({ reason: 'agent_run_conflict' })
    expect(writes).toHaveLength(0)
    await runWithTestAppDependencies(() => workItems.addComment(
      credential, 'core-team', 'task-1', 'progress', { requestId: 'comment', idempotencyKey: 'comment-2' },
      undefined, undefined, { agentRunId: held.runId, instanceIdHash: held.instanceIdHash },
    ))
    await runWithTestAppDependencies(() => workItems.addComment(
      credential, 'core-team', 'task-1', 'human note', { requestId: 'comment', idempotencyKey: 'comment-3' },
    ))
    const fencedKeys = (writes[0]?.authorizationConditionChecks ?? [])
      .map((check) => String(check.ConditionCheck.Key?.recordKey ?? ''))
    expect(fencedKeys).toContain(`agent-run#${held.runId}`)
    expect(fencedKeys).toContain('agent-run-claim#task-1')
    // The comment commits only while the run owner is still the assignee.
    expect(writes[0]?.authorizationConditionChecks?.some((check) =>
      check.ConditionCheck.Key?.issueId === 'task-1' &&
      check.ConditionCheck.ExpressionAttributeValues?.[':assigneeUserId'] === 'demo@example.com')).toBe(true)
    expect((writes[1]?.authorizationConditionChecks ?? [])
      .some((check) => String(check.ConditionCheck.Key?.recordKey ?? '').startsWith('agent-run'))).toBe(false)
  })

  test('heartbeats, finishes, and lists only the caller instance when asked', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const held = createHeldRun('task-1')
    const otherHeld = createHeldRun('task-2', 'third-laptop')
    store.seed(held)
    store.seed(otherHeld)
    const receipts: unknown[] = []
    setTestAppDependencies({
      transactions: {
        async prepareIdempotencyCompletionTransactWrite(input) {
          receipts.push(input.response)
          return { transactWriteItem: { Put: { TableName: 'DeveloperPlatformTable', Item: { receipt: true } } } }
        },
      },
    })
    const service = createCanonicalPublicAgentRunService()
    await expect(runWithTestAppDependencies(() => service.heartbeat(credential, 'core-team', held.runId, hashAgentInstanceId('laptop-1'))))
      .rejects.toMatchObject({ reason: 'agent_run_conflict' })
    await runWithTestAppDependencies(() => service.heartbeat(credential, 'core-team', held.runId, held.instanceIdHash))
    await expect(runWithTestAppDependencies(() => service.heartbeat(credential, 'core-team', held.runId, held.instanceIdHash)))
      .rejects.toMatchObject({ category: 'rate_limited' })

    const own = await runWithTestAppDependencies(() => service.list(
      credential, 'core-team', { state: 'active', instanceIdHash: held.instanceIdHash }, undefined, 50,
    ))
    expect(own.items.map((run) => run.runId)).toEqual([held.runId])

    await expect(runWithTestAppDependencies(() => service.finish(
      credential, 'core-team', held.runId, { outcome: 'completed', instanceIdHash: hashAgentInstanceId('laptop-1') },
      { requestId: 'finish', idempotencyKey: 'finish-0' },
      { credentialId: 'agent-key', idempotencyKey: 'finish-0', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))).rejects.toMatchObject({ reason: 'agent_run_conflict' })
    expect(receipts).toEqual([])
    const finished = await runWithTestAppDependencies(() => service.finish(
      credential, 'core-team', held.runId, { outcome: 'completed', instanceIdHash: held.instanceIdHash },
      { requestId: 'finish', idempotencyKey: 'finish-1' },
      { credentialId: 'agent-key', idempotencyKey: 'finish-1', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))
    expect(finished).toMatchObject({ state: 'finished', outcome: 'completed', finishedBy: 'agent' })
    expect(receipts).toEqual([{ status: 200, body: finished }])
    expect(store.state.claims.has(`${workspaceId}|core-team|task-1`)).toBe(false)
    expect(await runWithTestAppDependencies(() => service.finish(
      credential, 'core-team', held.runId, { outcome: 'completed', instanceIdHash: held.instanceIdHash },
      { requestId: 'finish', idempotencyKey: 'finish-2' },
      { credentialId: 'agent-key', idempotencyKey: 'finish-2', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))).toMatchObject({ outcome: 'completed' })
    await expect(runWithTestAppDependencies(() => service.finish(
      credential, 'core-team', held.runId, { outcome: 'failed', instanceIdHash: held.instanceIdHash },
      { requestId: 'finish', idempotencyKey: 'finish-3' },
      { credentialId: 'agent-key', idempotencyKey: 'finish-3', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))).rejects.toMatchObject({ reason: 'agent_run_not_active' })
    // Once the run is closed, another instance learns only that it is no longer active.
    await expect(runWithTestAppDependencies(() => service.heartbeat(credential, 'core-team', held.runId, hashAgentInstanceId('laptop-1'))))
      .rejects.toMatchObject({ reason: 'agent_run_not_active' })
  })

  test('hides a run the active index still lists after it closed', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const held = createHeldRun('task-1', 'laptop-1')
    store.seed(held)
    store.applyTransactItems(store.createCloseItems(finishAgentRun(held, 'released', 'sato@example.com', new Date())))
    // The index projection lags and still returns the pre-release image.
    store.listActiveRuns = async () => ({ runs: [held] })
    const service = createCanonicalPublicAgentRunService()
    const page = await runWithTestAppDependencies(() => service.list(credential, 'core-team', { state: 'active' }, undefined, 50))
    expect(page.items).toEqual([])
  })

  test('stops an agent whose run a person released, even when it omits the run ID', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const held = createHeldRun('task-1', 'laptop-1')
    store.seed(held)
    store.applyTransactItems(store.createCloseItems(finishAgentRun(held, 'released', 'sato@example.com', new Date())))
    const workItems = createCanonicalPublicWorkItemService()
    /**
     * Renames the fixture task as an agent instance that omits the run ID.
     *
     * @param instanceId - Raw instance ID.
     * @param key - Idempotency key.
     * @returns The updated Work Item.
     */
    const update = (instanceId: string, key: string) => runWithTestAppDependencies(() => workItems.update(
      credential, 'core-team', 'task-1', { expectedRevision: 1, title: 'Renamed' },
      { requestId: 'update', idempotencyKey: key }, undefined, { instanceIdHash: hashAgentInstanceId(instanceId) },
    ))
    await expect(update('laptop-1', 'released-1')).rejects.toMatchObject({ reason: 'agent_run_not_active' })
    // Another instance, and an instance whose newer own run completed, may still update the task.
    await update('laptop-2', 'released-2')
    const next = createHeldRun('task-1', 'laptop-1')
    store.applyTransactItems(store.createStartItems(next))
    store.applyTransactItems(store.createCloseItems(finishAgentRun(next, 'completed', 'agent', new Date())))
    await update('laptop-1', 'released-3')
  })

  test('keeps a released instance stopped after another instance runs the Work Item', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const released = createHeldRun('task-1', 'laptop-1')
    store.seed(released)
    store.applyTransactItems(store.createCloseItems(finishAgentRun(released, 'released', 'sato@example.com', new Date())))
    const other = createHeldRun('task-1', 'laptop-2')
    store.applyTransactItems(store.createStartItems(other))
    store.applyTransactItems(store.createCloseItems(finishAgentRun(other, 'completed', 'agent', new Date())))
    const workItems = createCanonicalPublicWorkItemService()
    await expect(runWithTestAppDependencies(() => workItems.update(
      credential, 'core-team', 'task-1', { expectedRevision: 1, title: 'Renamed' },
      { requestId: 'update', idempotencyKey: 'late-released' }, undefined, { instanceIdHash: hashAgentInstanceId('laptop-1') },
    ))).rejects.toMatchObject({ reason: 'agent_run_not_active' })
  })

  test('fences a held claim through its run and fails closed when that run is inconsistent', async () => {
    const { store, observed } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const held = createHeldRun('task-1', 'laptop-1')
    store.seed(held)
    const workItems = createCanonicalPublicWorkItemService()
    /**
     * Renames the fixture task as the claim holder without naming its run.
     *
     * @param key - Idempotency key.
     * @returns The updated Work Item.
     */
    const update = (key: string) => runWithTestAppDependencies(() => workItems.update(
      credential, 'core-team', 'task-1', { expectedRevision: 1, title: 'Renamed' },
      { requestId: 'update', idempotencyKey: key }, undefined, { instanceIdHash: held.instanceIdHash },
    ))
    await update('held-1')
    expect(JSON.stringify(observed.at(-1))).toContain(`agent-run#${held.runId}`)
    store.state.runs.set(`${workspaceId}|core-team|${held.runId}`, finishAgentRun(held, 'completed', 'agent', new Date()))
    await expect(update('held-2')).rejects.toMatchObject({ category: 'temporarily_unavailable' })
  })

  test('rejects an instance-only update when a person releases the run during the request', async () => {
    let releaseBeforeCommit: (() => void) | undefined
    const { store } = configureUnstartedAssignedWorkItem({
      statusCategory: 'started',
      beforeCommit: () => releaseBeforeCommit?.(),
    })
    const held = createHeldRun('task-1', 'laptop-1')
    store.seed(held)
    releaseBeforeCommit = () => {
      releaseBeforeCommit = undefined
      store.applyTransactItems(store.createCloseItems(finishAgentRun(held, 'released', 'sato@example.com', new Date())))
    }
    const workItems = createCanonicalPublicWorkItemService()
    await expect(runWithTestAppDependencies(() => workItems.update(
      credential, 'core-team', 'task-1', { expectedRevision: 1, title: 'Renamed' },
      { requestId: 'update', idempotencyKey: 'race-1' }, undefined, { instanceIdHash: held.instanceIdHash },
    ))).rejects.toMatchObject({ reason: 'agent_run_not_active' })
  })

  test('releases an active run in the same transaction that deletes its Work Item', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const held = createHeldRun('task-1')
    store.seed(held)
    const fences = await runWithTestAppDependencies(async () => {
      const principal = await resolveDeveloperCredentialPrincipal(credential, { permission: 'work-items.write', teamId: 'core-team', evaluateProjectScopes: true })
      return createAgentRunDeletionFences(principal, 'core-team', 'task-1', createMutationAuditContext({
        workspaceId, actor: { id: 'demo@example.com', kind: 'user' }, idempotencyKey: 'delete-1',
        request: { method: 'DELETE', path: '/api/v1/work-items/task-1', body: {} },
        source: { kind: 'api', requestId: 'delete-request', method: 'DELETE', route: '/api/v1/work-items/task-1' },
      }), new Date())
    })
    expect(fences.every((fence) => fence.kind === 'agent-runs')).toBe(true)
    expect(fences.length).toBeGreaterThanOrEqual(2)
    store.applyTransactItems(fences.map((fence) => fence.transactWriteItem))
    expect(store.state.claims.has(`${workspaceId}|core-team|task-1`)).toBe(false)
    expect(await store.getRun(workspaceId, 'core-team', held.runId)).toMatchObject({ state: 'finished', outcome: 'released', finishedBy: 'demo@example.com' })
    // Work Item IDs can be reused after deletion, so the released instance stays revoked on the ID.
    expect(store.state.revocations.size).toBe(1)
    const workItems = createCanonicalPublicWorkItemService()
    await expect(runWithTestAppDependencies(() => workItems.update(
      credential, 'core-team', 'task-1', { expectedRevision: 1, title: 'Recreated' },
      { requestId: 'update', idempotencyKey: 'after-delete-1' }, undefined, { instanceIdHash: held.instanceIdHash },
    ))).rejects.toMatchObject({ reason: 'agent_run_not_active' })
  })

  test('keeps Agent Run audit events apart from the Work Item event in the same transaction', () => {
    const previous = process.env.MUKUROJI_AUDIT_EVENTS_TABLE
    process.env.MUKUROJI_AUDIT_EVENTS_TABLE = 'AuditEvents'
    try {
      const context = createMutationAuditContext({
        workspaceId, actor: { id: 'demo@example.com', kind: 'user' }, idempotencyKey: 'start-1',
        request: { method: 'POST', path: '/api/v1/work-items/task-1/agent-runs', body: {} },
        source: { kind: 'api', requestId: 'start', method: 'POST', route: '/api/v1/work-items/task-1/agent-runs' },
      })
      const run = createHeldRun('task-1')
      const workItemEventId = createAuditEventId(context, 'work-item.updated', { type: 'work-item', id: 'team/core-team/issue/task-1' })
      const shared = createAgentRunAuditPut(context, run, 'started', 'Agent Run started.', AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM)
      const standalone = createAgentRunAuditPut(context, run, 'finished', 'Agent Run finished.')
      expect(shared?.Put?.Item?.eventId).toBeString()
      expect(shared?.Put?.Item?.eventId).not.toBe(workItemEventId)
      expect(standalone?.Put?.Item?.eventId).toBe(workItemEventId)
    } finally {
      if (previous === undefined) delete process.env.MUKUROJI_AUDIT_EVENTS_TABLE
      else process.env.MUKUROJI_AUDIT_EVENTS_TABLE = previous
    }
  })

  test('stops heartbeats after a reassignment but still lets the former assignee finish', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started', assigneeUserId: 'sato@example.com' })
    const held = createHeldRun('task-1', 'laptop-1')
    store.seed(held)
    setTestAppDependencies({
      transactions: {
        async prepareIdempotencyCompletionTransactWrite() {
          return { transactWriteItem: { Put: { TableName: 'DeveloperPlatformTable', Item: { receipt: true } } } }
        },
      },
    })
    const service = createCanonicalPublicAgentRunService()
    await expect(runWithTestAppDependencies(() => service.heartbeat(credential, 'core-team', held.runId, held.instanceIdHash)))
      .rejects.toMatchObject({ reason: 'agent_run_forbidden' })
    expect(await runWithTestAppDependencies(() => service.finish(
      credential, 'core-team', held.runId, { outcome: 'paused', instanceIdHash: held.instanceIdHash },
      { requestId: 'finish', idempotencyKey: 'finish-reassigned' },
      { credentialId: 'agent-key', idempotencyKey: 'finish-reassigned', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))).toMatchObject({ state: 'finished', outcome: 'paused' })
    expect(store.state.claims.size).toBe(0)
  })

  test('refuses run-fenced updates and comments from the former assignee after a reassignment', async () => {
    const { store, observed } = configureUnstartedAssignedWorkItem({ statusCategory: 'started', assigneeUserId: 'sato@example.com' })
    const held = createHeldRun('task-1', 'laptop-1')
    store.seed(held)
    const writes: unknown[] = []
    setTestAppDependencies({ collaboration: createCollaborationStub({
      async createComment(input) {
        writes.push(input)
        throw new Error('The comment must not be written.')
      },
    }) })
    const workItems = createCanonicalPublicWorkItemService()
    for (const fence of [{ agentRunId: held.runId, instanceIdHash: held.instanceIdHash }, { instanceIdHash: held.instanceIdHash }]) {
      await expect(runWithTestAppDependencies(() => workItems.update(
        credential, 'core-team', 'task-1', { expectedRevision: 1, title: 'Renamed' },
        { requestId: 'update', idempotencyKey: `reassigned-${fence.agentRunId ?? 'instance'}` }, undefined, fence,
      ))).rejects.toMatchObject({ reason: 'agent_run_forbidden' })
      await expect(runWithTestAppDependencies(() => workItems.addComment(
        credential, 'core-team', 'task-1', 'progress', { requestId: 'comment', idempotencyKey: `reassigned-comment-${fence.agentRunId ?? 'instance'}` },
        undefined, undefined, fence,
      ))).rejects.toMatchObject({ reason: 'agent_run_forbidden' })
    }
    expect(observed).toHaveLength(0)
    expect(writes).toHaveLength(0)
    expect(store.state.runs.get(`${workspaceId}|core-team|${held.runId}`)?.leaseExpiresAt).toBe(held.leaseExpiresAt)
  })

  test('rejects a start when Agent settings change before it commits', async () => {
    let saveBeforeCommit = true
    const { store } = configureUnstartedAssignedWorkItem({
      beforeCommit: () => {
        if (!saveBeforeCommit) return
        saveBeforeCommit = false
        store.state.settings.set(`${workspaceId}|core-team`, {
          ...createDefaultAgentSettings('core-team'), revision: 1, leaseMinutes: 5, updatedAt: new Date().toISOString(), updatedBy: 'manager@example.com',
        })
      },
    })
    const service = createCanonicalPublicAgentRunService()
    await expect(runWithTestAppDependencies(() => service.start(
      credential, 'core-team', 'task-1',
      readStartAgentRunRequest({ expectedRevision: 1, workflowStatusId: 'in-progress', runtime: 'codex', agentName: 'Codex', instanceId: 'laptop-1' }),
      { requestId: 'start', idempotencyKey: 'start-settings-race' },
      { credentialId: 'agent-key', idempotencyKey: 'start-settings-race', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))).rejects.toThrow('Agent settings changed during the request. Retry the start.')
    expect(store.state.claims.size).toBe(0)
  })

  test('refuses heartbeats and finishes on another member run', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const foreign = { ...createHeldRun('task-1'), assigneeUserId: 'sato@example.com' }
    store.seed(foreign)
    const service = createCanonicalPublicAgentRunService()
    await expect(runWithTestAppDependencies(() => service.heartbeat(credential, 'core-team', foreign.runId, foreign.instanceIdHash)))
      .rejects.toMatchObject({ reason: 'agent_run_forbidden' })
  })
})

describe('Web Agent Run routes', () => {
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

  test('lists a Work Item history with release permissions and releases an active run', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const held = createHeldRun('task-1')
    store.seed(held)
    const history = await app.request('http://localhost/api/teams/core-team/work-items/task-1/agent-runs', { headers })
    expect(history.status).toBe(200)
    expect(await history.json()).toMatchObject({ items: [{ runId: held.runId, canRelease: true, state: 'active' }] })

    const commits: unknown[][] = []
    const commit = store.commit.bind(store)
    store.commit = async (items, fenceItemCount) => {
      commits.push([...items])
      await commit(items, fenceItemCount)
    }
    const released = await app.request(`http://localhost/api/teams/core-team/agent-runs/${held.runId}/release`, { method: 'POST', headers })
    expect(released.status).toBe(200)
    // The member who started the run keeps the authority after a reassignment, so no revision check is added.
    expect(JSON.stringify(commits[0])).not.toContain('revision = :expectedRevision')
    expect(await released.json()).toMatchObject({ state: 'finished', outcome: 'released', finishedBy: 'demo@example.com', canRelease: false })
    expect(store.state.claims.has(`${workspaceId}|core-team|task-1`)).toBe(false)
    const again = await app.request(`http://localhost/api/teams/core-team/agent-runs/${held.runId}/release`, { method: 'POST', headers })
    expect(again.status).toBe(200)
  })

  test('lets only the assignee or a Team manager release a run', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started', assigneeUserId: 'sato@example.com' })
    const foreign = { ...createHeldRun('task-1'), assigneeUserId: 'sato@example.com' }
    store.seed(foreign)
    const history = await app.request('http://localhost/api/teams/core-team/work-items/task-1/agent-runs', { headers })
    expect(await history.json()).toMatchObject({ items: [{ runId: foreign.runId, canRelease: false }], hasMore: false })
    const denied = await app.request(`http://localhost/api/teams/core-team/agent-runs/${foreign.runId}/release`, { method: 'POST', headers })
    expect(denied.status).toBe(403)
    expect(store.state.claims.has(`${workspaceId}|core-team|task-1`)).toBe(true)
  })

  test('lets the current assignee release a run started before a reassignment', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started', assigneeUserId: 'demo@example.com' })
    const previous = { ...createHeldRun('task-1'), assigneeUserId: 'sato@example.com' }
    store.seed(previous)
    const commits: unknown[][] = []
    const commit = store.commit.bind(store)
    store.commit = async (items, fenceItemCount) => {
      commits.push([...items])
      await commit(items, fenceItemCount)
    }
    const history = await app.request('http://localhost/api/teams/core-team/work-items/task-1/agent-runs', { headers })
    expect(await history.json()).toMatchObject({ items: [{ runId: previous.runId, canRelease: true }] })
    const released = await app.request(`http://localhost/api/teams/core-team/agent-runs/${previous.runId}/release`, { method: 'POST', headers })
    expect(released.status).toBe(200)
    // Only the current assignment grants this release, so it commits only at the revision that was read.
    expect(commits[0]).toContainEqual({
      ConditionCheck: expect.objectContaining({
        Key: expect.objectContaining({ issueId: 'task-1' }),
        ConditionExpression: 'revision = :expectedRevision',
      }),
    })
  })

  test('does not offer a release to an assignee who can only view the Team', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started', role: 'viewer' })
    const held = createHeldRun('task-1')
    store.seed(held)
    const history = await app.request('http://localhost/api/teams/core-team/work-items/task-1/agent-runs', { headers })
    expect(history.status).toBe(200)
    expect(await history.json()).toMatchObject({ items: [{ runId: held.runId, canRelease: false }] })
    const denied = await app.request(`http://localhost/api/teams/core-team/agent-runs/${held.runId}/release`, { method: 'POST', headers })
    expect(denied.status).toBe(403)
  })

  test('reads defaults and saves Agent settings for Team managers with revision CAS', async () => {
    configureUnstartedAssignedWorkItem({ role: 'manager' })
    const read = await app.request('http://localhost/api/teams/core-team/agent-settings', { headers })
    expect(await read.json()).toMatchObject({ revision: 0, leaseMinutes: 30, allowTakeoverAfterLeaseExpiry: false })
    const saved = await app.request('http://localhost/api/teams/core-team/agent-settings', {
      method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, leaseMinutes: 60, allowTakeoverAfterLeaseExpiry: false }),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ revision: 1, leaseMinutes: 60 })
    const stale = await app.request('http://localhost/api/teams/core-team/agent-settings', {
      method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: false }),
    })
    expect(stale.status).toBe(409)
  })

  test('rejects Agent settings changes from Team members', async () => {
    configureUnstartedAssignedWorkItem({ role: 'member' })
    const response = await app.request('http://localhost/api/teams/core-team/agent-settings', {
      method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, leaseMinutes: 60, allowTakeoverAfterLeaseExpiry: false }),
    })
    expect(response.status).toBe(403)
  })
})
