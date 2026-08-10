import { describe, expect, test } from 'bun:test'
import type { WorkItemActionTarget } from '@mukuroji/contracts'
import {
  clearTaskStatusMoveRequest,
  consumeTaskStatusMoveRequest,
  createTaskStatusMoveRequest,
  type TaskStatusMoveRequestSlot,
} from '../src/task-views/model/taskStatusMoveRequest'
import {
  createFailedTaskActionResult,
  createSucceededTaskActionMutationResult,
  denyTaskAction,
  executeTaskAction,
} from '../src/task-views/model/taskActionRegistry'
import {
  createTaskSurfaceActionBaseContext,
  createTaskSurfaceActionContext,
  createTaskSurfaceActionRegistry,
  resolveTaskSurfaceActionTarget,
} from '../src/task-views/mutations/useTaskSurfaceActions'

const disabledReasons = {
  selectionRequired: 'Select one item.',
  singleSelectionRequired: 'Select only one item.',
  unavailable: 'Unavailable here.',
}

/** Creates one revision-bound target used by direct Move request tests. */
function createMoveTarget(expectedRevision = 4): WorkItemActionTarget {
  return {
    expectedRevision,
    teamId: 'team-a',
    workItemId: 'item-a',
  }
}

describe('task status Move request', () => {
  test('snapshots its target and consumes the exact revision only once', () => {
    const sourceTarget = createMoveTarget()
    const request = createTaskStatusMoveRequest(sourceTarget, 'status-done')
    const slot: TaskStatusMoveRequestSlot = { current: request }
    sourceTarget.expectedRevision = 99

    expect(request.target.expectedRevision).toBe(4)
    expect(consumeTaskStatusMoveRequest(slot, createMoveTarget())).toBe(request)
    expect(slot.current).toBeUndefined()
    expect(consumeTaskStatusMoveRequest(slot, createMoveTarget())).toBeUndefined()
  })

  test('consumes a mismatched target or revision as stale', () => {
    const request = createTaskStatusMoveRequest(createMoveTarget(), 'status-done')
    const slot: TaskStatusMoveRequestSlot = { current: request }

    expect(consumeTaskStatusMoveRequest(slot, createMoveTarget(5))).toBeUndefined()
    expect(slot.current).toBeUndefined()
  })

  test('rejects a direct request without an expected revision', () => {
    const target = { teamId: 'team-a', workItemId: 'item-a' }
    const request = createTaskStatusMoveRequest(target, 'status-done')
    const slot: TaskStatusMoveRequestSlot = { current: request }

    expect(consumeTaskStatusMoveRequest(slot, target)).toBeUndefined()
    expect(slot.current).toBeUndefined()
  })

  test('exact cleanup cannot erase a newer direct Move request', () => {
    const first = createTaskStatusMoveRequest(createMoveTarget(), 'status-review')
    const second = createTaskStatusMoveRequest(createMoveTarget(), 'status-done')
    const slot: TaskStatusMoveRequestSlot = { current: second }

    expect(clearTaskStatusMoveRequest(slot, first)).toBe(false)
    expect(slot.current).toBe(second)
    expect(clearTaskStatusMoveRequest(slot, second)).toBe(true)
    expect(slot.current).toBeUndefined()
  })

  test('leaves a denied request for exact finally cleanup without invoking Move', async () => {
    const target = createMoveTarget()
    const request = createTaskStatusMoveRequest(target, 'status-done')
    const slot: TaskStatusMoveRequestSlot = { current: request }
    let moveInvoked = false
    const registry = createTaskSurfaceActionRegistry({
      disabledReasons,
      handlers: {
        move: (context) => {
          moveInvoked = true
          return createSucceededTaskActionMutationResult(
            context.actionId,
            target,
            target.expectedRevision + 1,
          )
        },
      },
      permissions: {
        move: () => denyTaskAction('Move denied.'),
      },
    })
    const context = createTaskSurfaceActionContext(
      createTaskSurfaceActionBaseContext('my-tasks', { kind: 'viewer' }, {
        focusedTarget: target,
        mode: 'single',
        targets: [target],
      }),
      'move',
      'click',
    )

    expect(await executeTaskAction(registry, context)).toEqual({
      actionId: 'move',
      reason: 'Move denied.',
      status: 'denied',
    })
    expect(moveInvoked).toBe(false)
    expect(slot.current).toBe(request)
    expect(clearTaskStatusMoveRequest(slot, request)).toBe(true)
  })

  test('consumes an accepted destination synchronously before mutation await', async () => {
    const target = createMoveTarget()
    const request = createTaskStatusMoveRequest(target, 'status-done')
    const slot: TaskStatusMoveRequestSlot = { current: request }
    let consumedDestination: string | undefined
    const registry = createTaskSurfaceActionRegistry({
      disabledReasons,
      handlers: {
        move: async (context) => {
          const actionTarget = resolveTaskSurfaceActionTarget(context)
          const consumedRequest = actionTarget
            ? consumeTaskStatusMoveRequest(slot, actionTarget)
            : undefined
          consumedDestination = consumedRequest?.destinationWorkflowStatusId
          await Promise.resolve()
          return createSucceededTaskActionMutationResult(
            context.actionId,
            target,
            target.expectedRevision + 1,
          )
        },
      },
    })
    const context = createTaskSurfaceActionContext(
      createTaskSurfaceActionBaseContext('my-tasks', { kind: 'viewer' }, {
        focusedTarget: target,
        mode: 'single',
        targets: [target],
      }),
      'move',
      'click',
    )

    const resultPromise = executeTaskAction(registry, context)
    expect(consumedDestination).toBe('status-done')
    expect(slot.current).toBeUndefined()
    expect(await resultPromise).toMatchObject({
      result: {
        actionId: 'move',
        items: [{ resultingRevision: 5, status: 'succeeded', target }],
        status: 'succeeded',
      },
      status: 'executed',
    })
  })

  test('returns a terminal failure instead of opening a selector after target mismatch', async () => {
    const requestTarget = createMoveTarget()
    const contextTarget: WorkItemActionTarget = {
      expectedRevision: 2,
      teamId: 'team-b',
      workItemId: 'item-b',
    }
    const request = createTaskStatusMoveRequest(requestTarget, 'status-done')
    const slot: TaskStatusMoveRequestSlot = { current: request }
    let selectorOpened = false
    const registry = createTaskSurfaceActionRegistry({
      disabledReasons,
      handlers: {
        move: (context) => {
          const pendingRequest = slot.current
          const actionTarget = resolveTaskSurfaceActionTarget(context)
          const consumedRequest = actionTarget
            ? consumeTaskStatusMoveRequest(slot, actionTarget)
            : undefined
          if (pendingRequest && !consumedRequest) {
            return createFailedTaskActionResult(
              context.actionId,
              actionTarget,
              'MyTasksMoveTargetMismatch',
              'not-found',
              'Move target not found.',
            )
          }
          selectorOpened = true
          return createSucceededTaskActionMutationResult(
            context.actionId,
            contextTarget,
            contextTarget.expectedRevision + 1,
          )
        },
      },
    })
    const context = createTaskSurfaceActionContext(
      createTaskSurfaceActionBaseContext('my-tasks', { kind: 'viewer' }, {
        focusedTarget: contextTarget,
        mode: 'single',
        targets: [contextTarget],
      }),
      'move',
      'click',
    )

    expect(await executeTaskAction(registry, context)).toMatchObject({
      result: {
        actionId: 'move',
        failure: { category: 'not-found', code: 'MyTasksMoveTargetMismatch' },
        status: 'failed',
      },
      status: 'executed',
    })
    expect(selectorOpened).toBe(false)
    expect(slot.current).toBeUndefined()
  })
})
