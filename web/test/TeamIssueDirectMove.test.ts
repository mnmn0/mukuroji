import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type WorkItemActionContext,
  type WorkItemActionResult,
} from '@mukuroji/contracts'
import { TeamIssuesApiError } from '../src/issues/api'
import { teamIssueFixtures } from '../src/issues/fixtures'
import { executeTeamIssueDirectStatusMove } from '../src/task-views/model/teamIssueDirectMove'
import {
  createTaskStatusMoveRequest,
  type TaskStatusMoveRequestSlot,
} from '../src/task-views/model/taskStatusMoveRequest'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'

const messages = {
  conflict: 'conflict',
  failed: 'failed',
  unavailable: 'unavailable',
}

/** Creates a revision-bound Team Move context for direct Board entrance tests. */
function createMoveContext(expectedRevision: number): WorkItemActionContext {
  const target = {
    expectedRevision,
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
  }
  return {
    actionId: 'move',
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    scope: { kind: 'team', teamId: 'core-team' },
    selection: {
      focusedTarget: target,
      mode: 'single',
      targets: [target],
    },
    surface: 'team',
    trigger: 'click',
  }
}

/** Creates a one-shot direct destination request for the fixture Team Issue. */
function createMoveRequestSlot(expectedRevision: number): TaskStatusMoveRequestSlot {
  return {
    current: createTaskStatusMoveRequest({
      expectedRevision,
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
    }, 'review'),
  }
}

/** Requires a direct helper outcome when the test installed a destination request. */
function requireResult(
  result: WorkItemActionResult | undefined,
): WorkItemActionResult {
  if (!result) throw new Error('Expected a canonical direct Move result.')
  return result
}

describe('Team Issue direct Move action', () => {
  test('returns the same canonical mutation result for status-select and drop requests', async () => {
    const issue = teamIssueFixtures[0]
    if (!issue) throw new Error('Expected one Team Issue fixture.')

    const results: WorkItemActionResult[] = []
    const patches: string[] = []
    for (const entrance of ['status-select', 'drop']) {
      const slot = createMoveRequestSlot(issue.revision)
      const result = await executeTeamIssueDirectStatusMove(
        createMoveContext(issue.revision),
        slot,
        [issue],
        teamWorkItemConfigurationFixture,
        async (issueId, input) => {
          patches.push(`${entrance}:${issueId}:${input.workflowStatusId}`)
          return {
            ...issue,
            revision: issue.revision + 1,
            workflowStatusId: input.workflowStatusId ?? issue.workflowStatusId,
          }
        },
        messages,
      )
      results.push(requireResult(result))
      expect(slot.current).toBeUndefined()
    }

    expect(patches).toEqual([
      'status-select:onboarding-friction:review',
      'drop:onboarding-friction:review',
    ])
    expect(results[0]).toEqual(results[1])
    expect(results[0]?.status).toBe('succeeded')
    expect(results[0]?.items[0]?.resultingRevision).toBe(issue.revision + 1)
  })

  test('classifies a mismatched request revision without mutating', async () => {
    const issue = teamIssueFixtures[0]
    if (!issue) throw new Error('Expected one Team Issue fixture.')
    const slot = createMoveRequestSlot(issue.revision)
    let mutationCount = 0

    const result = requireResult(await executeTeamIssueDirectStatusMove(
      createMoveContext(issue.revision + 1),
      slot,
      [issue],
      teamWorkItemConfigurationFixture,
      async () => {
        mutationCount += 1
      },
      messages,
    ))

    expect(slot.current).toBeUndefined()
    expect(mutationCount).toBe(0)
    expect(result.status).toBe('failed')
    expect(result.failure).toMatchObject({
      category: 'conflict',
      code: 'WorkItemRevisionConflict',
      retryable: true,
    })
  })

  test('classifies direct API revision conflicts as retryable canonical conflicts', async () => {
    const issue = teamIssueFixtures[0]
    if (!issue) throw new Error('Expected one Team Issue fixture.')

    const result = requireResult(await executeTeamIssueDirectStatusMove(
      createMoveContext(issue.revision),
      createMoveRequestSlot(issue.revision),
      [issue],
      teamWorkItemConfigurationFixture,
      async () => {
        throw new Error('refresh required', {
          cause: new TeamIssuesApiError(409, 'revision conflict', 'WorkItemRevisionConflict'),
        })
      },
      messages,
    ))

    expect(result.status).toBe('failed')
    expect(result.failure).toEqual({
      category: 'conflict',
      code: 'WorkItemRevisionConflict',
      message: 'conflict',
      retryable: true,
    })
    expect(result.items[0]?.failure).toEqual(result.failure)
  })

  test('rejects a stale visible revision before dispatching the direct mutation', async () => {
    const issue = teamIssueFixtures[0]
    if (!issue) throw new Error('Expected one Team Issue fixture.')
    let mutationCount = 0

    const result = requireResult(await executeTeamIssueDirectStatusMove(
      createMoveContext(issue.revision - 1),
      createMoveRequestSlot(issue.revision - 1),
      [issue],
      teamWorkItemConfigurationFixture,
      async () => {
        mutationCount += 1
      },
      messages,
    ))

    expect(mutationCount).toBe(0)
    expect(result.failure).toMatchObject({
      category: 'conflict',
      code: 'WorkItemRevisionConflict',
      retryable: true,
    })
  })

  test('reserves an empty destination slot for the existing detail Move flow', () => {
    const issue = teamIssueFixtures[0]
    if (!issue) throw new Error('Expected one Team Issue fixture.')

    expect(executeTeamIssueDirectStatusMove(
      createMoveContext(issue.revision),
      { current: undefined },
      [issue],
      teamWorkItemConfigurationFixture,
      async () => issue,
      messages,
    )).toBeUndefined()
  })
})
