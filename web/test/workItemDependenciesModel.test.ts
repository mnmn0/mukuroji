import { describe, expect, test } from 'bun:test'
import type { WorkItemScheduleDependencyConflict } from '@mukuroji/contracts'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import {
  createWorkItemDependencyMutationId,
  createWorkItemDependencyRows,
  createWorkItemDependencySummaries,
  createWorkItemScheduleDependencyPatch,
  filterWorkItemDependencyRows,
  resolveWorkItemDependencySummary,
} from '../src/work-items/model/workItemDependencies'
import {
  createMutationHeaders,
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../src/shared/api/mutationHeaders'

describe('Work Item dependency view model', () => {
  test('derives blocker, successor, and critical-path chips from the planning snapshot', () => {
    const summaries = createWorkItemDependencySummaries(planningSnapshotFixture)

    expect(resolveWorkItemDependencySummary(summaries, {
      teamId: 'core-team',
      workItemId: 'journey-copy',
    })).toMatchObject({
      blockedByCount: 0,
      blocksCount: 1,
      critical: true,
    })
    expect(resolveWorkItemDependencySummary(summaries, {
      teamId: 'core-team',
      workItemId: 'journey-events',
    })).toMatchObject({
      blockedByCount: 1,
      blocksCount: 0,
      critical: true,
    })
  })

  test('projects edge conflicts and filters by Team-qualified endpoint', () => {
    const conflict = {
      actualDate: '2026-07-25',
      code: 'dependency-violation',
      dependencyId: 'work-item-dependency-copy-events',
      requiredDate: '2026-07-28',
      workItem: { teamId: 'core-team', workItemId: 'journey-events' },
    } satisfies WorkItemScheduleDependencyConflict
    const snapshot = {
      ...planningSnapshotFixture,
      workItemDependencySummary: {
        ...planningSnapshotFixture.workItemDependencySummary,
        conflicts: [conflict],
      },
    }
    const rows = createWorkItemDependencyRows(snapshot)
    const selected = filterWorkItemDependencyRows(rows, {
      teamId: 'core-team',
      workItemId: 'journey-events',
    })
    const summaries = createWorkItemDependencySummaries(snapshot)

    expect(selected).toHaveLength(1)
    expect(selected[0]?.conflicts).toHaveLength(1)
    expect(resolveWorkItemDependencySummary(summaries, {
      teamId: 'core-team',
      workItemId: 'journey-events',
    })).toMatchObject({ conflictCount: 1, requiredShiftDays: 3 })
  })

  test('marks only consecutive critical-path edges as critical', () => {
    const thirdWorkItem = {
      ...planningSnapshotFixture.workItems[1],
      id: 'journey-launch',
      revision: 1,
      title: 'Launch the onboarding journey',
    }
    const consecutiveDependency = {
      ...planningSnapshotFixture.workItemDependencies[0],
      id: 'work-item-dependency-events-launch',
      predecessor: { teamId: 'core-team', workItemId: 'journey-events' },
      successor: { teamId: 'core-team', workItemId: 'journey-launch' },
    }
    const skipDependency = {
      ...planningSnapshotFixture.workItemDependencies[0],
      id: 'work-item-dependency-copy-launch',
      successor: { teamId: 'core-team', workItemId: 'journey-launch' },
    }
    const snapshot = {
      ...planningSnapshotFixture,
      workItems: [...planningSnapshotFixture.workItems, thirdWorkItem],
      workItemDependencies: [
        ...planningSnapshotFixture.workItemDependencies,
        consecutiveDependency,
        skipDependency,
      ],
      workItemDependencySummary: {
        ...planningSnapshotFixture.workItemDependencySummary,
        criticalPath: {
          ...planningSnapshotFixture.workItemDependencySummary.criticalPath,
          workItems: [
            { teamId: 'core-team', workItemId: 'journey-copy' },
            { teamId: 'core-team', workItemId: 'journey-events' },
            { teamId: 'core-team', workItemId: 'journey-launch' },
          ],
        },
      },
    }

    const rows = createWorkItemDependencyRows(snapshot)

    expect(rows.find((row) => row.dependency.id === consecutiveDependency.id)?.critical).toBeTrue()
    expect(rows.find((row) => row.dependency.id === skipDependency.id)?.critical).toBeFalse()
  })

  test('sends null when an update form selects no explicit constraint', () => {
    expect(createWorkItemScheduleDependencyPatch({
      lagDays: -2,
      type: 'start-to-finish',
    })).toEqual({
      constraint: null,
      lagDays: -2,
      type: 'start-to-finish',
    })
  })

  test('reuses the dependency ID and request headers after a response-loss retry', async () => {
    const contexts: MutationRequestContext[] = [
      { correlationId: 'correlation-1', idempotencyKey: 'request-1' },
      { correlationId: 'correlation-2', idempotencyKey: 'request-2' },
    ]
    let contextIndex = 0
    const runner = createMutationRequestRunner(() => {
      const context = contexts[contextIndex]
      if (!context) throw new Error('Unexpected request context allocation')
      contextIndex += 1
      return context
    })
    const observedRequests: Array<{
      /** Dependency ID sent in the create body. */
      id: string
      /** Mutation headers sent with the create request. */
      headers: Record<string, string>
    }> = []
    const runCreate = (loseResponse: boolean) => runner.run(
      'planning:work-item-dependency:create',
      JSON.stringify([12, {
        lagDays: 0,
        predecessor: { teamId: 'team-a', workItemId: 'item-a' },
        successor: { teamId: 'team-b', workItemId: 'item-b' },
        type: 'finish-to-start',
      }]),
      async (requestContext) => {
        observedRequests.push({
          headers: createMutationHeaders(requestContext),
          id: createWorkItemDependencyMutationId(requestContext.idempotencyKey),
        })
        if (loseResponse) throw new TypeError('response lost')
      },
    )

    await expect(runCreate(true)).rejects.toThrow('response lost')
    await runCreate(false)

    expect(contextIndex).toBe(1)
    expect(observedRequests).toEqual([
      {
        headers: {
          'Idempotency-Key': 'request-1',
          'X-Correlation-Id': 'correlation-1',
        },
        id: 'work-item-dependency-request-1',
      },
      {
        headers: {
          'Idempotency-Key': 'request-1',
          'X-Correlation-Id': 'correlation-1',
        },
        id: 'work-item-dependency-request-1',
      },
    ])
  })
})
