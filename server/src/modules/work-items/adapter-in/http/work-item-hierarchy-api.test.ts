import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createFakeWorkItemConfigurationClient,
  createTeamIssuesFake,
  createTestWorkItemConfiguration,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  WORK_ITEM_HIERARCHY_MAX_ITEMS,
  createDefaultDueDateWorkItemSchedule,
  type TeamWorkItemHierarchyResponse,
  type WorkItemParentCompletionPolicy,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'
import type { TeamIssueResponseItem, TeamWorkItemHierarchyEntry } from '../../index'

afterEach(() => {
  resetTestApp()
})

/**
 * Reads one fake Team Work Item to copy into hierarchy fixtures.
 *
 * @returns The first fake Work Item of the Team.
 */
async function readBaseIssue(): Promise<TeamIssueResponseItem> {
  const { issues } = await getTestAppDependencies().workItems.teamIssues.getTeamIssues(
    'user#demo@example.com',
    'core-team',
  )
  const issue = issues[0]
  if (!issue) throw new Error('The fake Team has no Work Item.')
  return issue
}

/**
 * Builds one hierarchy entry from a base Work Item.
 *
 * @param base - Work Item copied for the entry.
 * @param id - Work Item ID.
 * @param rank - Effective sibling rank.
 * @param overrides - Fields replacing the base values.
 * @returns The entry.
 */
function hierarchyEntry(
  base: TeamIssueResponseItem,
  id: string,
  rank: string,
  overrides: Partial<TeamIssueResponseItem> & { parentId?: string } = {},
): TeamWorkItemHierarchyEntry {
  const { parentId, ...issueOverrides } = overrides
  return {
    issue: {
      ...base,
      ...issueOverrides,
      id,
      relationIds: parentId ? [`parent:${parentId}`] : [],
    },
    hierarchyRank: rank,
  }
}

/**
 * Sends an authenticated request.
 *
 * @param path - Request path.
 * @param init - Method and JSON body.
 * @returns The response.
 */
function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
}

test('returns the Team hierarchy with WBS numbers and roll-ups of readable Work Items', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  const reads: unknown[] = []
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamHierarchyEntries(directoryId, teamId, limit) {
        reads.push({ directoryId, teamId, limit })
        return [
          hierarchyEntry(base, 'phase-2', 'b'),
          hierarchyEntry(base, 'task-1', 'a', {
            parentId: 'phase-1',
            statusCategory: 'completed',
            schedule: { ...createDefaultDueDateWorkItemSchedule('2026-12-10'), plannedEffortMinutes: 120 },
          }),
          hierarchyEntry(base, 'phase-1', 'a'),
          hierarchyEntry(base, 'secret', 'b', { parentId: 'phase-1', assignedProjectId: 'secret-project' }),
          hierarchyEntry(base, 'task-2', 'c', {
            parentId: 'phase-1',
            schedule: { ...createDefaultDueDateWorkItemSchedule('2026-12-01'), plannedEffortMinutes: 60 },
          }),
        ]
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getRelationGraphRevision() {
        return 7
      },
    }),
  })

  const response = await request('/api/teams/core-team/issues/hierarchy')

  expect(response.status).toBe(200)
  const body = await response.json() as TeamWorkItemHierarchyResponse
  expect(reads).toEqual([{
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    limit: WORK_ITEM_HIERARCHY_MAX_ITEMS,
  }])
  expect(body.graphRevision).toBe(7)
  expect(body.nodes.map((node) => [node.workItemId, node.wbsNumber, node.depth])).toEqual([
    ['phase-1', '1', 0],
    ['task-1', '1.1', 1],
    ['task-2', '1.3', 1],
    ['phase-2', '2', 0],
  ])
  expect(body.nodes[0]).toMatchObject({
    parentWorkItemId: null,
    childWorkItemIds: ['task-1', 'task-2'],
    rollup: {
      childCount: 2,
      descendantCount: 2,
      openDescendantCount: 1,
      plannedEffortMinutes: 180,
      startDate: '2026-12-01',
      endDate: '2026-12-10',
    },
  })
  expect(body.nodes[1]?.rollup).toBeUndefined()
})

test('rejects a Team hierarchy larger than the read model bound', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamHierarchyEntries(_directoryId, _teamId, limit) {
        return Array.from({ length: limit + 1 }, (_, index) =>
          hierarchyEntry(base, `item-${index}`, 'i'))
      },
    }),
  })

  const response = await request('/api/teams/core-team/issues/hierarchy')

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ code: 'WorkItemListLimitExceeded' })
})

test('passes a sibling order rank to the parent replacement and rejects an invalid one', async () => {
  configureFakeProjectClients(true)
  const replacements: unknown[] = []
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations() {
        return { relations: [], graphRevision: 3 }
      },
      async replaceParent(_workspaceId, _teamId, input) {
        replacements.push(input)
        return { previousParentWorkItemId: null, parentWorkItemId: 'new-parent', graphRevision: 4 }
      },
    }),
  })
  const path = '/api/teams/core-team/issues/onboarding-friction/parent'

  const moved = await request(path, {
    method: 'PUT',
    body: { parentWorkItemId: 'new-parent', expectedGraphRevision: 3, hierarchyRank: 'k' },
  })
  const invalid = await request(path, {
    method: 'PUT',
    body: { parentWorkItemId: 'new-parent', expectedGraphRevision: 3, hierarchyRank: 'K0' },
  })

  expect(moved.status).toBe(200)
  expect(replacements).toEqual([expect.objectContaining({ hierarchyRank: 'k' })])
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ code: 'InvalidWorkItemHierarchyRank' })
})

/**
 * Configures a Team whose Work Item has one open child under a completion policy.
 *
 * @param policy - Team parent completion policy.
 * @returns Child relation reads made by the update.
 */
function configureParentWithOpenChild(policy: WorkItemParentCompletionPolicy) {
  const childReads: string[] = []
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration(_workspaceId, teamId) {
        return {
          configuration: {
            ...createTestWorkItemConfiguration('team', teamId),
            parentCompletionPolicy: policy,
          },
        }
      },
      async listRelations(_workspaceId, _teamId, workItemId, options) {
        if (options?.types?.includes('child')) childReads.push(workItemId)
        return {
          relations: options?.types?.includes('child')
            ? [{ sourceWorkItemId: workItemId, targetWorkItemId: 'open-child', type: 'child' }]
            : [],
          graphRevision: 1,
        }
      },
    }),
  })
  return childReads
}

test('rejects completing a parent with an open child when the Team rejects it', async () => {
  configureFakeProjectClients(true)
  const childReads = configureParentWithOpenChild('reject')

  const response = await request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    body: { workflowStatusId: 'done', expectedRevision: 1 },
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'WorkItemOpenChildren' })
  expect(childReads).toEqual(['onboarding-friction'])
})

test('allows completing a parent with an open child when the Team only warns', async () => {
  configureFakeProjectClients(true)
  const childReads = configureParentWithOpenChild('warn')

  const response = await request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    body: { workflowStatusId: 'done', expectedRevision: 1 },
  })

  expect(response.status).toBe(200)
  expect(childReads).toEqual([])
})
