import { afterEach, describe, expect, test } from 'bun:test'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicAgentRunService, createCanonicalPublicWorkItemService } from './api-router'
import {
  InMemoryAgentRunStore,
  InMemoryTransactionCanceledError,
  createActiveAgentRun,
  createAgentRunCommitConflictError,
  createDefaultAgentSettings,
  finishAgentRun,
  hashAgentInstanceId,
  readReportAgentRunRequest,
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
import {
  CollaborationError,
  deriveAuditedCommentId,
  type CollaborationClient,
} from '../modules/collaboration/collaboration'

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
  // The fake reads these options on every call, so a test can change the Work Item mid-request.
  const projectOptions: NonNullable<Parameters<typeof configureFakeProjectClients>[1]> = {
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
  }
  configureFakeProjectClients(true, projectOptions)
  setTestAppDependencies({ agentRuns: store })
  return { store, observed, projectOptions }
}

describe('public Agent Run service', () => {
  test('starts a run atomically with the started transition and fences other instances', async () => {
    const { store, observed } = configureUnstartedAssignedWorkItem()
    const receipts: unknown[] = []
    setTestAppDependencies({
      transactions: {
        /**
         * Records the receipt request and returns a receipt write for the transaction.
         *
         * @param input - Receipt to write.
         * @returns The receipt write.
         */
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
    // The comment writer conditions on the assignee it is given; the fence must not add a second
    // operation on the Work Item row, which DynamoDB rejects in one transaction.
    expect(writes[0]?.assigneeMemberKey).toBe('demo@example.com')
    expect(writes[0]?.authorizationConditionChecks?.some((check) => check.ConditionCheck.Key?.issueId !== undefined)).toBe(false)
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
        /**
         * Records the receipt request and returns a receipt write for the transaction.
         *
         * @param input - Receipt to write.
         * @returns The receipt write.
         */
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
    const committed: unknown[][] = []
    const commit = store.commit.bind(store)
    store.commit = async (items, fenceItemCount) => {
      committed.push([...items])
      return commit(items, fenceItemCount)
    }
    const finished = await runWithTestAppDependencies(() => service.finish(
      credential, 'core-team', held.runId, { outcome: 'completed', instanceIdHash: held.instanceIdHash },
      { requestId: 'finish', idempotencyKey: 'finish-1' },
      { credentialId: 'agent-key', idempotencyKey: 'finish-1', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))
    expect(finished).toMatchObject({ state: 'finished', outcome: 'completed', finishedBy: 'agent' })
    // The close commits only against the Work Item revision the finish was authorized on.
    expect(committed[0]).toContainEqual({ ConditionCheck: expect.objectContaining({
      Key: expect.objectContaining({ issueId: 'task-1' }), ConditionExpression: 'revision = :expectedRevision',
    }) })
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

  test('finds the run that claims a Work Item before the active index lists it', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const held = createHeldRun('task-1', 'laptop-1')
    store.seed(held)
    // The index has not caught up with the start yet.
    store.listActiveRuns = async () => ({ runs: [] })
    const service = createCanonicalPublicAgentRunService()
    /**
     * Lists the active run of the fixture Work Item, optionally for one instance.
     *
     * @param instanceId - Raw instance ID to filter by.
     * @returns Listed run IDs.
     */
    const claimedBy = async (instanceId?: string) => (await runWithTestAppDependencies(() => service.list(credential, 'core-team', {
      state: 'active', workItemId: 'task-1', ...(instanceId ? { instanceIdHash: hashAgentInstanceId(instanceId) } : {}),
    }, undefined, 50))).items.map((run) => run.runId)
    expect(await claimedBy()).toEqual([held.runId])
    expect(await claimedBy('laptop-1')).toEqual([held.runId])
    expect(await claimedBy('other-laptop')).toEqual([])
    store.applyTransactItems(store.createCloseItems(finishAgentRun(held, 'completed', 'agent', new Date())))
    expect(await claimedBy('laptop-1')).toEqual([])

    // A claim read just before its run closed is read again rather than reported as inconsistent.
    const successor = createHeldRun('task-1', 'laptop-2')
    store.seed(successor)
    const getClaim = store.getClaim.bind(store)
    let staleReads = 1
    store.getClaim = async (directoryId, teamId, workItemId) => {
      const claim = await getClaim(directoryId, teamId, workItemId)
      if (staleReads === 0 || !claim) return claim
      staleReads -= 1
      return { ...claim, runId: held.runId }
    }
    expect(await claimedBy()).toEqual([successor.runId])
    // A claim that keeps naming a finished run is still an integrity failure.
    staleReads = 2
    await expect(claimedBy()).rejects.toMatchObject({ category: 'temporarily_unavailable' })
    // So is a claim whose recorded holder differs from the active run it names.
    store.getClaim = async (directoryId, teamId, workItemId) => {
      const claim = await getClaim(directoryId, teamId, workItemId)
      return claim ? { ...claim, instanceIdHash: hashAgentInstanceId('someone-else') } : claim
    }
    await expect(claimedBy()).rejects.toMatchObject({ category: 'temporarily_unavailable' })
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
        /**
         * Returns a receipt write for the transaction.
         *
         * @returns The receipt write.
         */
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

  test('takes over a stalled run of another instance only when the Team allows it', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const stalled = { ...createHeldRun('task-1', 'laptop-1'), leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }
    store.seed(stalled)
    const receipts: unknown[] = []
    setTestAppDependencies({
      transactions: {
        /**
         * Records the receipt request and returns a receipt write for the transaction.
         *
         * @param input - Receipt to write.
         * @returns The receipt write.
         */
        async prepareIdempotencyCompletionTransactWrite(input) {
          receipts.push(input.response)
          return { transactWriteItem: { Put: { TableName: 'DeveloperPlatformTable', Item: { receipt: true } } } }
        },
      },
    })
    const service = createCanonicalPublicAgentRunService()
    /**
     * Takes over the stalled run as an instance.
     *
     * @param instanceId - Raw instance ID taking over.
     * @param key - Idempotency key.
     * @returns The take over response.
     */
    const takeOver = (instanceId: string, key: string) => runWithTestAppDependencies(() => service.takeOver(
      credential, 'core-team', 'task-1', stalled.runId,
      { runtime: 'codex', agentName: 'Codex', instanceIdHash: hashAgentInstanceId(instanceId) },
      { requestId: 'take-over', idempotencyKey: key },
      { credentialId: 'agent-key', idempotencyKey: key, requestFingerprint: 'fp', reservationId: 'reservation' },
    ))
    await expect(takeOver('laptop-2', 'take-over-0')).rejects.toMatchObject({ reason: 'agent_run_takeover_disabled' })
    store.state.settings.set(`${workspaceId}|core-team`, {
      ...createDefaultAgentSettings('core-team'), revision: 1, allowTakeoverAfterLeaseExpiry: true,
      updatedAt: new Date().toISOString(), updatedBy: 'manager@example.com',
    })
    await expect(takeOver('laptop-1', 'take-over-1')).rejects.toMatchObject({ reason: 'agent_run_conflict' })

    const taken = await takeOver('laptop-2', 'take-over-2')
    expect(taken.supersededRun).toMatchObject({ runId: stalled.runId, state: 'finished', outcome: 'superseded', finishedBy: 'demo@example.com' })
    expect(taken.run).toMatchObject({ workItemId: 'task-1', state: 'active', runtime: 'codex', stalled: false })
    expect(receipts).toEqual([{ status: 201, body: taken }])
    expect(store.state.claims.get(`${workspaceId}|core-team|task-1`)).toMatchObject({
      runId: taken.run.runId, instanceIdHash: hashAgentInstanceId('laptop-2'),
    })
    // The successor's claim fences the superseded instance, and its revocation keeps fencing it later.
    expect(store.state.revocations.size).toBe(1)
    const workItems = createCanonicalPublicWorkItemService()
    await expect(runWithTestAppDependencies(() => workItems.update(
      credential, 'core-team', 'task-1', { expectedRevision: 1, title: 'Renamed' },
      { requestId: 'update', idempotencyKey: 'after-take-over' }, undefined, { instanceIdHash: stalled.instanceIdHash },
    ))).rejects.toMatchObject({ reason: 'agent_run_conflict' })
    await expect(runWithTestAppDependencies(() => service.heartbeat(credential, 'core-team', stalled.runId, stalled.instanceIdHash)))
      .rejects.toMatchObject({ reason: 'agent_run_not_active' })
    await expect(takeOver('laptop-3', 'take-over-3')).rejects.toMatchObject({ reason: 'agent_run_not_active' })
  })

  test('audits a take over with stable event types and points conflicts at instanceId', async () => {
    const previous = process.env.MUKUROJI_AUDIT_EVENTS_TABLE
    process.env.MUKUROJI_AUDIT_EVENTS_TABLE = 'AuditEvents'
    try {
      const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
      store.state.settings.set(`${workspaceId}|core-team`, {
        ...createDefaultAgentSettings('core-team'), revision: 1, allowTakeoverAfterLeaseExpiry: true,
        updatedAt: new Date().toISOString(), updatedBy: 'manager@example.com',
      })
      const live = createHeldRun('task-1', 'laptop-1')
      store.seed(live)
      setTestAppDependencies({
        transactions: {
          /**
           * Returns a receipt write for the transaction.
           *
           * @returns The receipt write.
           */
          async prepareIdempotencyCompletionTransactWrite() {
            return { transactWriteItem: { Put: { TableName: 'DeveloperPlatformTable', Item: { receipt: true } } } }
          },
        },
      })
      const committed: unknown[][] = []
      const commit = store.commit.bind(store)
      store.commit = async (items, fenceItemCount) => {
        committed.push([...items])
        return commit(items, fenceItemCount)
      }
      const service = createCanonicalPublicAgentRunService()
      /**
       * Takes over the fixture run as another instance.
       *
       * @param key - Idempotency key.
       * @returns The take over response.
       */
      const takeOver = (key: string) => runWithTestAppDependencies(() => service.takeOver(
        credential, 'core-team', 'task-1', live.runId,
        { runtime: 'codex', agentName: 'Codex', instanceIdHash: hashAgentInstanceId('laptop-2') },
        { requestId: 'take-over', idempotencyKey: key },
        { credentialId: 'agent-key', idempotencyKey: key, requestFingerprint: 'fp', reservationId: 'reservation' },
      ))
      await expect(takeOver('live')).rejects.toMatchObject({ reason: 'agent_run_conflict', pointer: '/instanceId' })
      store.state.runs.set(`${workspaceId}|core-team|${live.runId}`, { ...live, leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() })
      await takeOver('stalled')
      const auditTypes = (committed[0] ?? []).flatMap((item) => {
        if (typeof item !== 'object' || item === null || !('Put' in item)) return []
        const put = item.Put
        if (typeof put !== 'object' || put === null || !('TableName' in put) || put.TableName !== 'AuditEvents') return []
        return 'Item' in put && typeof put.Item === 'object' && put.Item !== null && 'eventType' in put.Item ? [put.Item.eventType] : []
      })
      expect(auditTypes).toEqual(['agent-run.taken-over', 'agent-run.started'])
    } finally {
      if (previous === undefined) delete process.env.MUKUROJI_AUDIT_EVENTS_TABLE
      else process.env.MUKUROJI_AUDIT_EVENTS_TABLE = previous
    }
  })

  test('classifies a take over cancelled by a concurrent settings change', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const settingsKey = `${workspaceId}|core-team`
    const enabled = {
      ...createDefaultAgentSettings('core-team'), revision: 1, allowTakeoverAfterLeaseExpiry: true,
      updatedAt: new Date().toISOString(), updatedBy: 'manager@example.com',
    }
    store.state.settings.set(settingsKey, enabled)
    const stalled = { ...createHeldRun('task-1', 'laptop-1'), leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }
    store.seed(stalled)
    setTestAppDependencies({
      transactions: {
        /**
         * Returns a receipt write for the transaction.
         *
         * @returns The receipt write.
         */
        async prepareIdempotencyCompletionTransactWrite() {
          return { transactWriteItem: { Put: { TableName: 'DeveloperPlatformTable', Item: { receipt: true } } } }
        },
      },
    })
    const service = createCanonicalPublicAgentRunService()
    /**
     * Takes over the stalled run while a concurrent change cancels the transaction.
     *
     * @param change - Settings written by the concurrent request, or undefined for an unrelated cancellation.
     * @param key - Idempotency key.
     * @returns The take over response.
     */
    const takeOverDuring = (change: typeof enabled | undefined, key: string) => {
      store.state.settings.set(settingsKey, enabled)
      store.commit = async () => {
        if (change) store.state.settings.set(settingsKey, change)
        throw createAgentRunCommitConflictError()
      }
      return runWithTestAppDependencies(() => service.takeOver(
        credential, 'core-team', 'task-1', stalled.runId,
        { runtime: 'codex', agentName: 'Codex', instanceIdHash: hashAgentInstanceId('laptop-2') },
        { requestId: 'take-over', idempotencyKey: key },
        { credentialId: 'agent-key', idempotencyKey: key, requestFingerprint: 'fp', reservationId: 'reservation' },
      ))
    }
    await expect(takeOverDuring({ ...enabled, revision: 2, allowTakeoverAfterLeaseExpiry: false }, 'disabled'))
      .rejects.toMatchObject({ reason: 'agent_run_takeover_disabled' })
    await expect(takeOverDuring({ ...enabled, revision: 2, leaseMinutes: 45 }, 'changed'))
      .rejects.toMatchObject({ category: 'conflict' })
    // A cancellation with nothing changed, such as an identical request's receipt, stays retryable.
    await expect(takeOverDuring(undefined, 'unrelated')).rejects.toMatchObject({ category: 'temporarily_unavailable' })
  })

  test('does not take over a run on a Work Item that is no longer started', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'unstarted' })
    store.state.settings.set(`${workspaceId}|core-team`, {
      ...createDefaultAgentSettings('core-team'), revision: 1, allowTakeoverAfterLeaseExpiry: true,
      updatedAt: new Date().toISOString(), updatedBy: 'manager@example.com',
    })
    const stalled = { ...createHeldRun('task-1', 'laptop-1'), leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }
    store.seed(stalled)
    const service = createCanonicalPublicAgentRunService()
    await expect(runWithTestAppDependencies(() => service.takeOver(
      credential, 'core-team', 'task-1', stalled.runId,
      { runtime: 'codex', agentName: 'Codex', instanceIdHash: hashAgentInstanceId('laptop-2') },
      { requestId: 'take-over', idempotencyKey: 'not-started' },
      { credentialId: 'agent-key', idempotencyKey: 'not-started', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))).rejects.toMatchObject({ reason: 'invalid_transition' })
    expect(store.state.claims.get(`${workspaceId}|core-team|task-1`)).toMatchObject({ runId: stalled.runId })
  })

  test('does not take over a run that renewed its lease or belongs to another member', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    store.state.settings.set(`${workspaceId}|core-team`, {
      ...createDefaultAgentSettings('core-team'), revision: 1, allowTakeoverAfterLeaseExpiry: true,
      updatedAt: new Date().toISOString(), updatedBy: 'manager@example.com',
    })
    const live = createHeldRun('task-1', 'laptop-1')
    store.seed(live)
    setTestAppDependencies({
      transactions: {
        /**
         * Returns a receipt write for the transaction.
         *
         * @returns The receipt write.
         */
        async prepareIdempotencyCompletionTransactWrite() {
          return { transactWriteItem: { Put: { TableName: 'DeveloperPlatformTable', Item: { receipt: true } } } }
        },
      },
    })
    const service = createCanonicalPublicAgentRunService()
    /**
     * Takes over a run as another instance.
     *
     * @param runId - Run to take over.
     * @param key - Idempotency key.
     * @returns The take over response.
     */
    const takeOver = (runId: string, key: string) => runWithTestAppDependencies(() => service.takeOver(
      credential, 'core-team', 'task-1', runId,
      { runtime: 'codex', agentName: 'Codex', instanceIdHash: hashAgentInstanceId('laptop-2') },
      { requestId: 'take-over', idempotencyKey: key },
      { credentialId: 'agent-key', idempotencyKey: key, requestFingerprint: 'fp', reservationId: 'reservation' },
    ))
    await expect(takeOver(live.runId, 'live')).rejects.toMatchObject({ reason: 'agent_run_conflict' })

    // A heartbeat that lands before the take over commits keeps the run.
    store.state.runs.set(`${workspaceId}|core-team|${live.runId}`, { ...live, leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() })
    const commit = store.commit.bind(store)
    store.commit = async (items, fenceItemCount) => {
      store.state.runs.set(`${workspaceId}|core-team|${live.runId}`, { ...live, leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() })
      return commit(items, fenceItemCount)
    }
    await expect(takeOver(live.runId, 'renewed')).rejects.toMatchObject({ reason: 'agent_run_conflict' })
    expect(store.state.claims.get(`${workspaceId}|core-team|task-1`)).toMatchObject({ runId: live.runId })
    store.commit = commit

    const foreign = { ...createHeldRun('task-1', 'laptop-9'), assigneeUserId: 'sato@example.com', leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }
    store.state.claims.clear()
    store.seed(foreign)
    await expect(takeOver(foreign.runId, 'foreign')).rejects.toMatchObject({ reason: 'agent_run_forbidden' })
  })

  test('re-reads a take over whose run closed first, and refuses a claim held by another instance', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    store.state.settings.set(`${workspaceId}|core-team`, {
      ...createDefaultAgentSettings('core-team'), revision: 1, allowTakeoverAfterLeaseExpiry: true,
      updatedAt: new Date().toISOString(), updatedBy: 'manager@example.com',
    })
    const stalled = { ...createHeldRun('task-1', 'laptop-1'), leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }
    const runKey = `${workspaceId}|core-team|${stalled.runId}`
    const claimKey = `${workspaceId}|core-team|task-1`
    store.seed(stalled)
    setTestAppDependencies({
      transactions: {
        /**
         * Returns a receipt write for the transaction.
         *
         * @returns The receipt write.
         */
        async prepareIdempotencyCompletionTransactWrite() {
          return { transactWriteItem: { Put: { TableName: 'DeveloperPlatformTable', Item: { receipt: true } } } }
        },
      },
    })
    const service = createCanonicalPublicAgentRunService()
    /**
     * Takes over the stalled run as another instance.
     *
     * @param key - Idempotency key.
     * @returns The take over response.
     */
    const takeOver = (key: string) => runWithTestAppDependencies(() => service.takeOver(
      credential, 'core-team', 'task-1', stalled.runId,
      { runtime: 'codex', agentName: 'Codex', instanceIdHash: hashAgentInstanceId('laptop-2') },
      { requestId: 'take-over', idempotencyKey: key },
      { credentialId: 'agent-key', idempotencyKey: key, requestFingerprint: 'fp', reservationId: 'reservation' },
    ))

    // The run finishes between the run read and the claim read.
    const getClaim = store.getClaim.bind(store)
    store.getClaim = async (directoryId, teamId, workItemId) => {
      store.state.runs.set(runKey, finishAgentRun(stalled, 'completed', 'agent', new Date()))
      store.state.claims.delete(claimKey)
      return getClaim(directoryId, teamId, workItemId)
    }
    await expect(takeOver('finished-first')).rejects.toMatchObject({ reason: 'agent_run_not_active' })
    store.getClaim = getClaim

    // A claim that names the run but another instance or member is not the run's to give away.
    store.state.claims.clear()
    store.seed(stalled)
    const claim = store.state.claims.get(claimKey)
    if (!claim) throw new Error('The stalled run must hold its claim.')
    store.state.claims.set(claimKey, { ...claim, instanceIdHash: hashAgentInstanceId('laptop-9') })
    await expect(takeOver('other-instance')).rejects.toMatchObject({ category: 'temporarily_unavailable' })
    store.state.claims.set(claimKey, { ...claim, assigneeUserId: 'sato@example.com' })
    await expect(takeOver('other-member')).rejects.toMatchObject({ category: 'temporarily_unavailable' })

    // The transaction checks the whole holder too, when the claim changes after the precheck.
    store.state.claims.set(claimKey, claim)
    const commit = store.commit.bind(store)
    store.commit = async (items, fenceItemCount) => {
      store.state.claims.set(claimKey, { ...claim, instanceIdHash: hashAgentInstanceId('laptop-9') })
      return commit(items, fenceItemCount)
    }
    await expect(takeOver('changed-claim')).rejects.toMatchObject({ category: 'temporarily_unavailable' })
    store.commit = commit
    expect(store.state.runs.get(runKey)).toMatchObject({ state: 'active' })
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

describe('Agent Run reports', () => {
  /**
   * Prepares a started Work Item held by a run, a receipt writer, and a comment writer that commits
   * the report's co-writes against the in-memory store the way the real transaction does.
   *
   * @param beforeCommit - Runs before the co-writes apply, to simulate a concurrent write.
   * @param assigneeUserId - Current assignee of the Work Item; the run's member by default.
   * @returns Store, held run, recorded comment writes, and a report call.
   */
  function configureReport(beforeCommit?: () => void, assigneeUserId?: string) {
    const { store, projectOptions } = configureUnstartedAssignedWorkItem({ statusCategory: 'started', ...(assigneeUserId ? { assigneeUserId } : {}) })
    const held = createHeldRun('task-1', 'laptop-1')
    store.seed(held)
    const comments: Parameters<CollaborationClient['createComment']>[0][] = []
    setTestAppDependencies({
      transactions: {
        /**
         * Returns a receipt write for the transaction.
         *
         * @returns The receipt write.
         */
        async prepareIdempotencyCompletionTransactWrite() {
          return { transactWriteItem: { Put: { TableName: 'DeveloperPlatformTable', Item: { receipt: true } } } }
        },
      },
      collaboration: createCollaborationStub({
        /**
         * Commits the co-writes with the comment, failing like the real writer on a cancelled condition.
         *
         * @param input - Comment write.
         * @returns The stored comment.
         */
        async createComment(input) {
          if (!input.auditContext) throw new Error('A report comment must be audited.')
          beforeCommit?.()
          try {
            store.applyTransactItems(input.coWrites ?? [])
          } catch (error) {
            if (error instanceof InMemoryTransactionCanceledError) {
              throw new CollaborationError(409, 'CollaborationConflict', 'Collaboration mutation conflicted.')
            }
            throw error
          }
          comments.push(input)
          const id = deriveAuditedCommentId(input.entityKey, input.auditContext)
          return {
            id, rootCommentId: id, authorMemberKey: input.actorMemberKey, bodyMarkdown: input.bodyMarkdown, version: 1,
            mentionMemberKeys: [], reactions: [], acceptedResolutions: [],
            createdAt: input.auditContext.occurredAt, updatedAt: input.auditContext.occurredAt,
          }
        },
      }),
    })
    const service = createCanonicalPublicAgentRunService()
    /**
     * Reports on the held run.
     *
     * @param body - Raw report body.
     * @param key - Idempotency key.
     * @returns The report response.
     */
    const report = (body: Record<string, unknown>, key: string) => runWithTestAppDependencies(() => service.report(
      credential, 'core-team', held.runId, readReportAgentRunRequest({ instanceId: 'laptop-1', ...body }),
      { requestId: 'report', idempotencyKey: key },
      { credentialId: 'agent-key', idempotencyKey: key, requestFingerprint: 'fp', reservationId: 'reservation' },
    ))
    return { store, held, comments, report, service, projectOptions }
  }

  test('saves a numbered report with its labelled comment and renews the lease in one transaction', async () => {
    const { store, held, comments, report } = configureReport()
    const first = await report({
      kind: 'verification', message: 'Tests passed',
      verifications: [{ command: 'bun run server:test', status: 'passed' }],
      artifacts: [{ type: 'pull-request', url: 'https://github.com/example/repo/pull/1', label: 'PR 1' }],
      changedFileCount: 4,
    }, 'report-1')
    expect(first).toMatchObject({
      report: {
        runId: held.runId, workItemId: 'task-1', sequence: 1, kind: 'verification', changedFileCount: 4,
        verifications: [{ command: 'bun run server:test', status: 'passed' }],
        artifacts: [{ type: 'pull-request', url: 'https://github.com/example/repo/pull/1', label: 'PR 1' }],
      },
      comment: { body: '[Codex]\n\nTests passed', actorUserId: 'demo@example.com' },
      run: { reportCount: 1, state: 'active' },
    })
    expect(first.report.commentId).toBe(first.comment.id)
    expect(comments[0]?.bodyMarkdown).toBe('[Codex]\n\nTests passed')
    expect(comments[0]?.coWrites?.some((item) => item.Put?.TableName === 'DeveloperPlatformTable')).toBe(true)
    const stored = store.state.runs.get(`${workspaceId}|core-team|${held.runId}`)
    expect(stored).toMatchObject({ reportCount: 1, lastReportKind: 'verification' })
    expect(Date.parse(stored?.leaseExpiresAt ?? '')).toBeGreaterThan(Date.parse(held.leaseExpiresAt))
    // The agent's instance ID never reaches the audit record of the request.
    expect(JSON.stringify(comments[0]?.auditContext)).not.toContain('laptop-1')

    const second = await report({ kind: 'blocker', message: 'Need a decision' }, 'report-2')
    expect(second.report).toMatchObject({ sequence: 2, kind: 'blocker', verifications: [], artifacts: [] })
    expect(store.state.reports.size).toBe(2)
  })

  test('refuses reports from another instance, after the run closed, or after a reassignment', async () => {
    const { store, held, comments, service } = configureReport()
    await expect(runWithTestAppDependencies(() => service.report(
      credential, 'core-team', held.runId, readReportAgentRunRequest({ instanceId: 'laptop-2', message: 'Not mine' }),
      { requestId: 'report', idempotencyKey: 'other' },
      { credentialId: 'agent-key', idempotencyKey: 'other', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))).rejects.toMatchObject({ reason: 'agent_run_conflict', pointer: '/instanceId' })
    store.applyTransactItems(store.createCloseItems(finishAgentRun(held, 'released', 'sato@example.com', new Date())))
    await expect(runWithTestAppDependencies(() => service.report(
      credential, 'core-team', held.runId, readReportAgentRunRequest({ instanceId: 'laptop-1', message: 'Late' }),
      { requestId: 'report', idempotencyKey: 'late' },
      { credentialId: 'agent-key', idempotencyKey: 'late', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))).rejects.toMatchObject({ reason: 'agent_run_not_active' })
    expect(comments).toHaveLength(0)

    const scoped = configureReport()
    await expect(runWithTestAppDependencies(() => scoped.service.report(
      credential, 'core-team', scoped.held.runId, readReportAgentRunRequest({ instanceId: 'laptop-1', message: 'Moved' }),
      { requestId: 'report', idempotencyKey: 'moved' },
      { credentialId: 'agent-key', idempotencyKey: 'moved', requestFingerprint: 'fp', reservationId: 'reservation' },
      'another-project',
    ))).rejects.toMatchObject({ category: 'forbidden' })
    await expect(runWithTestAppDependencies(() => scoped.service.authorizeReport(
      credential, 'core-team', scoped.held.runId, scoped.held.instanceIdHash, 'another-project',
    ))).rejects.toMatchObject({ category: 'forbidden' })
    expect(scoped.comments).toHaveLength(0)

    const reassigned = configureReport(undefined, 'sato@example.com')
    await expect(reassigned.report({ message: 'Still mine?' }, 'reassigned')).rejects.toMatchObject({ reason: 'agent_run_forbidden' })
  })

  test('classifies a concurrent report or close that wins the transaction', async () => {
    let interfere: (() => void) | undefined
    const { store, held, report } = configureReport(() => interfere?.())
    const runKey = `${workspaceId}|core-team|${held.runId}`
    interfere = () => {
      const current = store.state.runs.get(runKey)
      if (current) store.state.runs.set(runKey, { ...current, reportCount: current.reportCount + 1 })
    }
    // Retrying with the same key renumbers the report after the one that won.
    await expect(report({ message: 'Raced' }, 'raced')).rejects.toMatchObject({ category: 'temporarily_unavailable' })
    // A heartbeat that commits after the report read its time keeps its later lease; the retry reports from a later time.
    interfere = () => {
      const current = store.state.runs.get(runKey)
      if (current) store.state.runs.set(runKey, { ...current, lastHeartbeatAt: new Date(Date.now() + 60_000).toISOString() })
    }
    await expect(report({ message: 'Behind a heartbeat' }, 'heartbeat')).rejects.toMatchObject({ category: 'temporarily_unavailable' })
    interfere = () => {
      const current = store.state.runs.get(runKey)
      if (current) store.applyTransactItems(store.createCloseItems(finishAgentRun(current, 'released', 'sato@example.com', new Date())))
    }
    await expect(report({ message: 'Closed' }, 'closed')).rejects.toMatchObject({ reason: 'agent_run_not_active' })
  })

  test('reports a reassignment that wins the transaction as forbidden', async () => {
    let interfere: (() => void) | undefined
    const { report, projectOptions } = configureReport(() => interfere?.())
    interfere = () => {
      projectOptions.detailAssigneeUserId = 'sato@example.com'
      throw new CollaborationError(409, 'CollaborationConflict', 'Collaboration mutation conflicted.')
    }
    await expect(report({ message: 'Reassigned meanwhile' }, 'reassigned')).rejects.toMatchObject({ reason: 'agent_run_forbidden' })
  })

  test('rebuilds a finish that a concurrent report overtakes so its response matches the closed row', async () => {
    const { store, held, report, service } = configureReport()
    let interfere: (() => Promise<unknown>) | undefined
    const commit = store.commit.bind(store)
    const attempts: unknown[][] = []
    store.commit = async (items, fenceItemCount) => {
      attempts.push([...items])
      const pending = interfere
      interfere = undefined
      await pending?.()
      return commit(items, fenceItemCount)
    }
    interfere = () => report({ message: 'Just before finishing' }, 'overtaking')
    const finished = await runWithTestAppDependencies(() => service.finish(
      credential, 'core-team', held.runId, { outcome: 'completed', instanceIdHash: held.instanceIdHash },
      { requestId: 'finish', idempotencyKey: 'finish-overtaken' },
      { credentialId: 'agent-key', idempotencyKey: 'finish-overtaken', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))
    const stored = store.state.runs.get(`${workspaceId}|core-team|${held.runId}`)
    expect(stored).toMatchObject({ state: 'finished', outcome: 'completed', reportCount: 1 })
    expect(finished).toMatchObject({ state: 'finished', reportCount: 1, lastHeartbeatAt: stored?.lastHeartbeatAt, leaseExpiresAt: stored?.leaseExpiresAt })
    expect(attempts).toHaveLength(2)
    expect(JSON.stringify(attempts[0])).toContain('#reportCount = :reportCount AND #lastHeartbeatAt = :lastHeartbeatAt')
  })

  test('reports a finish that keeps losing to the run\'s progress as retryable and leaves the run active', async () => {
    const { store, held, service } = configureReport()
    const runKey = `${workspaceId}|core-team|${held.runId}`
    const commit = store.commit.bind(store)
    let beats = 0
    store.commit = async (items, fenceItemCount) => {
      const current = store.state.runs.get(runKey)
      beats += 1
      if (current) store.state.runs.set(runKey, { ...current, lastHeartbeatAt: new Date(Date.now() + beats * 1_000).toISOString() })
      return commit(items, fenceItemCount)
    }
    await expect(runWithTestAppDependencies(() => service.finish(
      credential, 'core-team', held.runId, { outcome: 'completed', instanceIdHash: held.instanceIdHash },
      { requestId: 'finish', idempotencyKey: 'finish-starved' },
      { credentialId: 'agent-key', idempotencyKey: 'finish-starved', requestFingerprint: 'fp', reservationId: 'reservation' },
    ))).rejects.toMatchObject({ category: 'temporarily_unavailable' })
    expect(beats).toBe(3)
    expect(store.state.runs.get(runKey)).toMatchObject({ state: 'active' })
  })
})

describe('Web Agent Run routes', () => {
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

  test('lists a Work Item\'s structured reports newest first for its viewers', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started', role: 'viewer' })
    const held = createHeldRun('task-1')
    store.seed(held)
    for (const [sequence, createdAt] of [[1, '2026-10-22T00:00:00.000Z'], [2, '2026-10-22T00:05:00.000Z']] as const) {
      store.state.reports.set(`${workspaceId}|core-team|${held.runId}|${sequence}`, {
        schemaVersion: 1, runId: held.runId, directoryId: workspaceId, teamId: 'core-team', workItemId: 'task-1', sequence,
        kind: sequence === 1 ? 'verification' : 'handoff', commentId: `cmt_${sequence}`,
        verifications: [], artifacts: [{ type: 'url', url: 'https://example.test/log' }], createdAt, createdBy: 'demo@example.com',
      })
    }
    const listed = await app.request('http://localhost/api/teams/core-team/work-items/task-1/agent-run-reports?limit=1', { headers })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({
      items: [{
        schemaVersion: 1, runId: held.runId, teamId: 'core-team', workItemId: 'task-1', sequence: 2, kind: 'handoff', commentId: 'cmt_2',
        verifications: [], artifacts: [{ type: 'url', url: 'https://example.test/log' }], createdAt: '2026-10-22T00:05:00.000Z',
      }],
      hasMore: true,
    })
    const invalid = await app.request('http://localhost/api/teams/core-team/work-items/task-1/agent-run-reports?limit=0', { headers })
    expect(invalid.status).toBe(400)
  })

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

  test('rebuilds a release that a concurrent report overtakes so it returns the closed row', async () => {
    const { store } = configureUnstartedAssignedWorkItem({ statusCategory: 'started' })
    const held = createHeldRun('task-1')
    store.seed(held)
    const runKey = `${workspaceId}|core-team|${held.runId}`
    const commit = store.commit.bind(store)
    let overtaken = false
    store.commit = async (items, fenceItemCount) => {
      const current = store.state.runs.get(runKey)
      if (!overtaken && current) {
        overtaken = true
        const reportedAt = new Date(Date.now() + 1_000)
        store.applyTransactItems(store.createReportItems(current, {
          schemaVersion: 1, runId: held.runId, directoryId: workspaceId, teamId: 'core-team', workItemId: 'task-1',
          sequence: current.reportCount + 1, kind: 'progress', commentId: 'cmt_overtaking', verifications: [], artifacts: [],
          createdAt: reportedAt.toISOString(), createdBy: 'demo@example.com',
        }, reportedAt))
      }
      return commit(items, fenceItemCount)
    }
    const released = await app.request(`http://localhost/api/teams/core-team/agent-runs/${held.runId}/release`, { method: 'POST', headers })
    expect(released.status).toBe(200)
    const stored = store.state.runs.get(runKey)
    expect(stored).toMatchObject({ state: 'finished', outcome: 'released', reportCount: 1 })
    expect(await released.json()).toMatchObject({ state: 'finished', reportCount: 1, leaseExpiresAt: stored?.leaseExpiresAt })
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
    const keyed = { ...headers, 'Idempotency-Key': 'settings-1' }
    const saved = await app.request('http://localhost/api/teams/core-team/agent-settings', {
      method: 'PUT', headers: keyed, body: JSON.stringify({ expectedRevision: 0, leaseMinutes: 60, allowTakeoverAfterLeaseExpiry: false }),
    })
    expect(saved.status).toBe(200)
    const savedBody = await saved.json()
    expect(savedBody).toMatchObject({ revision: 1, leaseMinutes: 60 })
    // A retry after a lost response replays the committed save.
    const retried = await app.request('http://localhost/api/teams/core-team/agent-settings', {
      method: 'PUT', headers: keyed, body: JSON.stringify({ expectedRevision: 0, leaseMinutes: 60, allowTakeoverAfterLeaseExpiry: false }),
    })
    expect(retried.status).toBe(200)
    expect(await retried.json()).toEqual(savedBody)
    const changedRetry = await app.request('http://localhost/api/teams/core-team/agent-settings', {
      method: 'PUT', headers: keyed, body: JSON.stringify({ expectedRevision: 0, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: false }),
    })
    expect(changedRetry.status).toBe(409)
    // Reusing the key for a different save against the current revision is a conflict, not a second save.
    const reusedKey = await app.request('http://localhost/api/teams/core-team/agent-settings', {
      method: 'PUT', headers: keyed, body: JSON.stringify({ expectedRevision: 1, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: false }),
    })
    expect(reusedKey.status).toBe(409)
    const stale = await app.request('http://localhost/api/teams/core-team/agent-settings', {
      method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, leaseMinutes: 60, allowTakeoverAfterLeaseExpiry: false }),
    })
    expect(stale.status).toBe(409)
    // An older key stays spent after a later save with another key.
    const later = await app.request('http://localhost/api/teams/core-team/agent-settings', {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': 'settings-2' },
      body: JSON.stringify({ expectedRevision: 1, leaseMinutes: 90, allowTakeoverAfterLeaseExpiry: false }),
    })
    expect(later.status).toBe(200)
    const olderKey = await app.request('http://localhost/api/teams/core-team/agent-settings', {
      method: 'PUT', headers: keyed, body: JSON.stringify({ expectedRevision: 2, leaseMinutes: 45, allowTakeoverAfterLeaseExpiry: true }),
    })
    expect(olderKey.status).toBe(409)
    const current = await app.request('http://localhost/api/teams/core-team/agent-settings', { headers })
    expect(await current.json()).toMatchObject({ revision: 2, leaseMinutes: 90, allowTakeoverAfterLeaseExpiry: false })
  })

  test('rejects Agent settings changes from Team members', async () => {
    configureUnstartedAssignedWorkItem({ role: 'member' })
    const response = await app.request('http://localhost/api/teams/core-team/agent-settings', {
      method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, leaseMinutes: 60, allowTakeoverAfterLeaseExpiry: false }),
    })
    expect(response.status).toBe(403)
  })
})
