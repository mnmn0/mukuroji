import { describe, expect, test } from 'bun:test'
import {
  AUTOMATION_SCHEMA_VERSION,
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type BulkOperation,
  type WorkItemActionContext,
  type WorkItemActionResult,
  type WorkItemActionSelection,
} from '@mukuroji/contracts'
import {
  createBulkOperationTaskActionResult,
  resolveBulkOperationTaskActionUndoToken,
} from '../src/bulk-operations/model/bulkOperationTaskAction'
import {
  cancelPendingTaskActionContext,
  canDismissCompletedTaskActionOwner,
  createTaskActionCompletionBridge,
  isPendingTaskActionExplicitSelectionCurrent,
  isPendingTaskActionFocusCurrent,
} from '../src/task-views/model/taskActionCompletion'
import {
  createFailedTaskActionResult,
  createSucceededTaskActionMutationResult,
  createSucceededTaskCreateActionResult,
} from '../src/task-views/model/taskActionRegistry'
import { createTaskActionInvocationContext } from '../src/task-views/mutations/useTaskSurfaceActions'

/** Creates one reusable command context for completion-race regression tests. */
function createMoveContext(): WorkItemActionContext {
  return {
    actionId: 'move',
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    scope: { kind: 'viewer' },
    selection: {
      focusedTarget: { expectedRevision: 4, teamId: 'team-a', workItemId: 'item-a' },
      mode: 'single',
      targets: [{ expectedRevision: 4, teamId: 'team-a', workItemId: 'item-a' }],
    },
    surface: 'my-tasks',
    trigger: 'command-menu',
  }
}

/** Flushes promise continuations without depending on timer behavior. */
async function flushPromiseContinuations(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('task action completion bridge', () => {
  test('keeps same-context in-flight and waiting invocations independently settleable', async () => {
    const bridge = createTaskActionCompletionBridge()
    const reusedContext = createMoveContext()
    let firstResult: WorkItemActionResult | undefined
    let secondResult: WorkItemActionResult | undefined

    const firstPromise = bridge.begin(reusedContext)
    const firstInvocation = bridge.current()
    expect(firstInvocation).toBeDefined()
    expect(firstInvocation && bridge.claim(firstInvocation)).toBe(true)
    void firstPromise.then((result) => {
      firstResult = result
    })

    const secondPromise = bridge.begin(reusedContext)
    const secondInvocation = bridge.current()
    expect(secondInvocation).toBeDefined()
    expect(secondInvocation).not.toBe(firstInvocation)
    void secondPromise.then((result) => {
      secondResult = result
    })

    if (!firstInvocation || !secondInvocation) throw new Error('Missing invocation context.')
    expect(canDismissCompletedTaskActionOwner(bridge, firstInvocation)).toBe(false)
    expect(bridge.settle(firstInvocation, createSucceededTaskActionMutationResult(
      'move',
      firstInvocation.selection.targets[0],
      5,
    ))).toBe(true)
    await flushPromiseContinuations()

    expect(firstResult?.status).toBe('succeeded')
    expect(secondResult).toBeUndefined()
    expect(canDismissCompletedTaskActionOwner(bridge, firstInvocation)).toBe(false)
    expect(bridge.cancelContext(firstInvocation)).toBe(false)
    expect(bridge.cancelContext(secondInvocation)).toBe(true)
    await flushPromiseContinuations()
    expect(secondResult?.status).toBe('cancelled')
  })

  test('cancels only awaiting input and settles an in-flight mutation exactly once', async () => {
    const bridge = createTaskActionCompletionBridge()
    const completion = bridge.begin(createMoveContext())
    const invocation = bridge.current()
    if (!invocation) throw new Error('Missing invocation context.')

    expect(bridge.claim(invocation)).toBe(true)
    expect(bridge.cancel()).toBe(false)
    const success = createSucceededTaskActionMutationResult(
      'move',
      invocation.selection.targets[0],
      7,
    )
    expect(bridge.settle(invocation, success)).toBe(true)
    expect(bridge.settle(invocation, success)).toBe(false)
    expect(await completion).toEqual(success)
  })

  test('runs owner cleanup for a superseded editor but not for an in-flight mutation', () => {
    const bridge = createTaskActionCompletionBridge()
    const cancelledOwners: WorkItemActionContext[] = []
    bridge.begin(createMoveContext(), (context) => cancelledOwners.push(context))
    const waitingInvocation = bridge.current()
    bridge.begin({ ...createMoveContext(), actionId: 'edit' })
    expect(cancelledOwners).toEqual(waitingInvocation ? [waitingInvocation] : [])

    const editInvocation = bridge.current()
    if (!editInvocation) throw new Error('Missing invocation context.')
    expect(bridge.claim(editInvocation)).toBe(true)
    bridge.begin({ ...createMoveContext(), actionId: 'assign' })
    expect(cancelledOwners).toHaveLength(1)
  })

  test('keeps context-menu focus independent from unrelated checkbox selection', () => {
    const context = createMoveContext()
    const focusedTarget = context.selection.targets[0]
    const selection: WorkItemActionSelection = {
      focusedTarget,
      mode: 'multiple',
      targets: [
        { teamId: 'team-x', workItemId: 'item-x' },
        { teamId: 'team-y', workItemId: 'item-y' },
      ],
    }

    expect(isPendingTaskActionFocusCurrent(context, selection)).toBe(true)
    expect(isPendingTaskActionFocusCurrent(context, {
      ...selection,
      focusedTarget: { teamId: 'team-b', workItemId: 'item-b' },
    })).toBe(false)
    expect(isPendingTaskActionExplicitSelectionCurrent(context, selection)).toBe(false)
    expect(isPendingTaskActionExplicitSelectionCurrent(context, context.selection)).toBe(true)
  })

  test('creates fresh command invocation snapshots from a reused resolved context', () => {
    const reusedContext = createMoveContext()
    const first = createTaskActionInvocationContext(reusedContext)
    const second = createTaskActionInvocationContext(reusedContext)

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first.selection).not.toBe(second.selection)
    expect(first.selection.targets[0]).not.toBe(second.selection.targets[0])
  })

  test('returns canonical Create close and mutation failure outcomes', async () => {
    const closeBridge = createTaskActionCompletionBridge()
    let closeCount = 0
    const closeResult = closeBridge.begin(
      { ...createMoveContext(), actionId: 'create', selection: { mode: 'none', targets: [] } },
      () => {
        closeCount += 1
      },
    )
    expect(closeBridge.cancel('create')).toBe(true)
    expect((await closeResult).status).toBe('cancelled')
    expect(closeCount).toBe(1)

    const failureBridge = createTaskActionCompletionBridge()
    const failureResult = failureBridge.begin({
      ...createMoveContext(),
      actionId: 'create',
      selection: { mode: 'none', targets: [] },
    })
    const failureInvocation = failureBridge.current()
    if (!failureInvocation) throw new Error('Missing Create invocation context.')
    expect(failureBridge.claim(failureInvocation)).toBe(true)
    expect(failureBridge.settle(failureInvocation, createFailedTaskActionResult(
      'create',
      undefined,
      'CreateFailed',
      'unknown',
      'Create failed.',
    ))).toBe(true)
    expect((await failureResult).status).toBe('failed')
  })

  test('cancels an awaiting semantic action before an unrelated mutation continues', async () => {
    const bridge = createTaskActionCompletionBridge()
    let ownerDismissed = false
    const completion = bridge.begin(createMoveContext(), () => {
      ownerDismissed = true
    })
    const pendingInvocation = bridge.current()
    if (!pendingInvocation) throw new Error('Missing invocation context.')

    expect(bridge.cancelContext(pendingInvocation)).toBe(true)
    const unrelatedMutationRan = true

    expect((await completion).status).toBe('cancelled')
    expect(ownerDismissed).toBe(true)
    expect(unrelatedMutationRan).toBe(true)
  })

  test('settles an explicit Schedule save with no changes as cancelled', async () => {
    const bridge = createTaskActionCompletionBridge()
    const completion = bridge.begin({ ...createMoveContext(), actionId: 'schedule' })

    expect(cancelPendingTaskActionContext(
      bridge,
      ['schedule'],
      { teamId: 'team-a', workItemId: 'item-a' },
    )).toBe(true)
    expect((await completion).status).toBe('cancelled')
    expect(cancelPendingTaskActionContext(
      bridge,
      ['schedule'],
      { teamId: 'team-a', workItemId: 'item-a' },
    )).toBe(false)
  })
})

describe('canonical mutation result adapters', () => {
  test('retains created target and navigation metadata', () => {
    expect(createSucceededTaskCreateActionResult(
      { expectedRevision: 1, teamId: 'team-a', workItemId: 'created-item' },
      '/teams/team-a/issues?issueId=created-item',
    )).toMatchObject({
      actionId: 'create',
      createdTarget: {
        expectedRevision: 1,
        teamId: 'team-a',
        workItemId: 'created-item',
      },
      navigationPath: '/teams/team-a/issues?issueId=created-item',
      status: 'succeeded',
    })
  })

  test('maps a running durable operation to partial with its consumable undo token', () => {
    const operation: BulkOperation = {
      action: { archived: true, type: 'archive' },
      actorMemberKey: 'member-a',
      createdAt: '2026-08-09T00:00:00.000Z',
      id: 'operation-a',
      items: [
        {
          expectedRevision: 1,
          resultingRevision: 2,
          retryable: false,
          status: 'succeeded',
          teamId: 'team-a',
          undoable: true,
          workItemId: 'item-a',
        },
        {
          expectedRevision: 3,
          retryable: false,
          status: 'ready',
          teamId: 'team-b',
          undoable: false,
          workItemId: 'item-b',
        },
      ],
      revision: 2,
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      status: 'running',
      updatedAt: '2026-08-09T00:00:01.000Z',
      workspaceId: 'workspace-a',
    }

    expect(resolveBulkOperationTaskActionUndoToken(operation)).toBe('operation-a')
    expect(createBulkOperationTaskActionResult('archive', operation, 'Not applied.')).toMatchObject({
      actionId: 'archive',
      status: 'partial',
      undoToken: 'operation-a',
      items: [
        { resultingRevision: 2, status: 'succeeded' },
        { status: 'skipped' },
      ],
    })
  })

  test('does not report a resumable all-ready checkpoint as failed', () => {
    const operation: BulkOperation = {
      action: { targetProjectId: 'project-b', type: 'move' },
      actorMemberKey: 'member-a',
      createdAt: '2026-08-09T00:00:00.000Z',
      id: 'operation-ready',
      items: [{
        expectedRevision: 3,
        retryable: false,
        status: 'ready',
        teamId: 'team-b',
        undoable: false,
        workItemId: 'item-b',
      }],
      revision: 1,
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      status: 'running',
      updatedAt: '2026-08-09T00:00:01.000Z',
      workspaceId: 'workspace-a',
    }

    expect(createBulkOperationTaskActionResult('move', operation, 'Not applied.').status)
      .toBe('partial')
  })
})
