import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type WorkItemActionContext,
  type WorkItemActionResult,
  type WorkItemActionTarget,
} from '@mukuroji/contracts'
import { TeamIssuesApiError } from '../src/issues/api'
import { executeMyTaskDirectStatusMove } from '../src/task-views/model/myTaskDirectMove'
import {
  createTaskStatusMoveRequest,
  type TaskStatusMoveRequestSlot,
} from '../src/task-views/model/taskStatusMoveRequest'
import {
  taskViewStoryConfigurationsByTeam,
  taskViewStorySelectedTask,
} from '../src/tasks/ui/TaskView.stories.fixtures'

const messages = {
  conflict: 'conflict',
  failed: 'failed',
  notFound: 'not found',
  unavailable: 'unavailable',
}

/** Creates one revision-bound My Tasks target for direct Move adapter tests. */
function createMoveTarget(
  expectedRevision: number | undefined = taskViewStorySelectedTask.revision,
  teamId = taskViewStorySelectedTask.teamId,
  workItemId = taskViewStorySelectedTask.id,
): WorkItemActionTarget {
  return {
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    teamId,
    workItemId,
  }
}

/** Creates one canonical click context for a direct My Tasks Move request. */
function createMoveContext(target = createMoveTarget()): WorkItemActionContext {
  return {
    actionId: 'move',
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    scope: { kind: 'viewer' },
    selection: {
      focusedTarget: target,
      mode: 'single',
      targets: [target],
    },
    surface: 'my-tasks',
    trigger: 'click',
  }
}

/** Creates one destination-bearing direct Move request slot. */
function createMoveRequestSlot(
  target = createMoveTarget(),
  destinationWorkflowStatusId = 'review',
): TaskStatusMoveRequestSlot {
  return {
    current: createTaskStatusMoveRequest(target, destinationWorkflowStatusId),
  }
}

/** Requires a canonical result when a direct request was installed. */
function requireResult(
  result: WorkItemActionResult | undefined,
): WorkItemActionResult {
  if (!result) throw new Error('Expected a canonical direct My Tasks Move result.')
  return result
}

describe('My Tasks direct Move action', () => {
  test('returns the persisted resulting revision after a successful direct Move', async () => {
    const slot = createMoveRequestSlot()
    const mutations: string[] = []
    const result = requireResult(await executeMyTaskDirectStatusMove(
      createMoveContext(),
      slot,
      [taskViewStorySelectedTask],
      taskViewStoryConfigurationsByTeam,
      async (task, workflowStatusId) => {
        mutations.push(`${task.teamId}:${task.id}:${workflowStatusId}`)
        return {
          ...task,
          revision: task.revision + 1,
          workflowStatusId,
        }
      },
      messages,
    ))

    expect(slot.current).toBeUndefined()
    expect(mutations).toEqual(['core-team:wireframe:review'])
    expect(result.status).toBe('succeeded')
    expect(result.items[0]?.resultingRevision).toBe(taskViewStorySelectedTask.revision + 1)
  })

  test('rejects a destination that is not an editable workflow transition', async () => {
    const slot = createMoveRequestSlot(createMoveTarget(), 'ready')
    let mutationCount = 0
    const result = requireResult(await executeMyTaskDirectStatusMove(
      createMoveContext(),
      slot,
      [taskViewStorySelectedTask],
      taskViewStoryConfigurationsByTeam,
      async () => {
        mutationCount += 1
        return taskViewStorySelectedTask
      },
      messages,
    ))

    expect(mutationCount).toBe(0)
    expect(result.failure).toMatchObject({
      category: 'unavailable',
      code: 'MyTasksMoveUnavailable',
      retryable: false,
    })
  })

  test('rejects a stale current Work Item revision before mutation dispatch', async () => {
    const staleTarget = createMoveTarget(taskViewStorySelectedTask.revision - 1)
    let mutationCount = 0
    const result = requireResult(await executeMyTaskDirectStatusMove(
      createMoveContext(staleTarget),
      createMoveRequestSlot(staleTarget),
      [taskViewStorySelectedTask],
      taskViewStoryConfigurationsByTeam,
      async () => {
        mutationCount += 1
        return taskViewStorySelectedTask
      },
      messages,
    ))

    expect(mutationCount).toBe(0)
    expect(result.failure).toEqual({
      category: 'conflict',
      code: 'WorkItemRevisionConflict',
      message: 'conflict',
      retryable: true,
    })
  })

  test('makes target and request-revision mismatches terminal without mutation', async () => {
    const mismatches = [
      {
        contextTarget: createMoveTarget(),
        requestTarget: createMoveTarget(
          taskViewStorySelectedTask.revision,
          'other-team',
          'other-item',
        ),
      },
      {
        contextTarget: createMoveTarget(taskViewStorySelectedTask.revision + 1),
        requestTarget: createMoveTarget(),
      },
    ]
    const results: WorkItemActionResult[] = []
    let mutationCount = 0

    for (const mismatch of mismatches) {
      results.push(requireResult(await executeMyTaskDirectStatusMove(
        createMoveContext(mismatch.contextTarget),
        createMoveRequestSlot(mismatch.requestTarget),
        [taskViewStorySelectedTask],
        taskViewStoryConfigurationsByTeam,
        async () => {
          mutationCount += 1
          return taskViewStorySelectedTask
        },
        messages,
      )))
    }

    expect(mutationCount).toBe(0)
    expect(results[0]?.failure).toMatchObject({
      category: 'not-found',
      code: 'MyTasksMoveTargetMismatch',
    })
    expect(results[1]?.failure).toMatchObject({
      category: 'conflict',
      code: 'WorkItemRevisionConflict',
      retryable: true,
    })
  })

  test('classifies direct and wrapped API 409 failures as retryable conflicts', async () => {
    const conflict = new TeamIssuesApiError(
      409,
      'revision conflict',
      'WorkItemRevisionConflict',
    )
    const failures: readonly unknown[] = [
      conflict,
      new Error('refresh required', { cause: conflict }),
    ]
    const results: WorkItemActionResult[] = []

    for (const failure of failures) {
      results.push(requireResult(await executeMyTaskDirectStatusMove(
        createMoveContext(),
        createMoveRequestSlot(),
        [taskViewStorySelectedTask],
        taskViewStoryConfigurationsByTeam,
        async () => {
          throw failure
        },
        messages,
      )))
    }

    for (const result of results) {
      expect(result.failure).toEqual({
        category: 'conflict',
        code: 'WorkItemRevisionConflict',
        message: 'conflict',
        retryable: true,
      })
    }
  })
})
