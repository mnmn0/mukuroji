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
  runWithTestAppDependencies,
  setTestAppDependencies,
} = createApiTestHarness()
import { readWorkItemHierarchyLinks } from '../../../../api/shared/work-item-hierarchy'
import { ProjectDataError } from '../../../directory'
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
import { WorkItemConfigurationError } from '../../index'
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
          // Its parent is archived, so it is not in the tree.
          hierarchyEntry(base, 'stray', 'z', { parentId: 'archived-phase' }),
        ]
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getRelationGraphRevision() {
        return 7
      },
    }),
  })

  const response = await request('/api/teams/core-team/work-item-hierarchy')

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
    ['stray', '3', 0],
  ])
  expect(body.nodes.find((node) => node.workItemId === 'stray')).toMatchObject({
    parentWorkItemId: null,
    parentHidden: true,
  })
  expect(body.nodes.find((node) => node.workItemId === 'phase-2')?.parentHidden).toBeUndefined()
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

test('reads the Team hierarchy through the adapter as its receiver', async () => {
  configureFakeProjectClients(true)
  const receivers: unknown[] = []
  const teamIssues = createTeamIssuesFake({
    // A plain method like the DynamoDB client's, which reads its tables through `this`.
    async getTeamHierarchyEntries(this: unknown) {
      receivers.push(this)
      return []
    },
  })
  setTestAppDependencies({
    teamIssues,
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getRelationGraphRevision() {
        return 3
      },
    }),
  })

  const response = await request('/api/teams/core-team/work-item-hierarchy')

  expect(response.status).toBe(200)
  expect(receivers).toEqual([teamIssues])
})

test('reads the Team hierarchy again when the graph moved while it was read', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  const revisions = [7, 8, 8]
  const reads: number[] = []
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamHierarchyEntries() {
        reads.push(reads.length)
        // The first read sees the tree before a move, the second the tree after it.
        return reads.length === 1
          ? [hierarchyEntry(base, 'phase-1', 'a'), hierarchyEntry(base, 'task-1', 'b')]
          : [hierarchyEntry(base, 'phase-1', 'a'), hierarchyEntry(base, 'task-1', 'a', { parentId: 'phase-1' })]
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getRelationGraphRevision() {
        return revisions.shift() ?? 8
      },
    }),
  })

  const response = await request('/api/teams/core-team/work-item-hierarchy')

  expect(response.status).toBe(200)
  const body = await response.json() as TeamWorkItemHierarchyResponse
  expect(reads).toHaveLength(2)
  // The tree and the revision both come from after the move.
  expect(body.graphRevision).toBe(8)
  expect(body.nodes.map((node) => [node.workItemId, node.wbsNumber])).toEqual([['phase-1', '1'], ['task-1', '1.1']])
})

test('returns the revision read before the last tree when the graph keeps moving', async () => {
  configureFakeProjectClients(true)
  let revision = 10
  let reads = 0
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamHierarchyEntries() {
        reads += 1
        return []
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getRelationGraphRevision() {
        revision += 1
        return revision
      },
    }),
  })

  const response = await request('/api/teams/core-team/work-item-hierarchy')

  expect(response.status).toBe(200)
  // Three reads at most; the older revision makes the reader's next move a graph conflict.
  expect(reads).toBe(3)
  expect((await response.json() as TeamWorkItemHierarchyResponse).graphRevision).toBe(13)
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

  const response = await request('/api/teams/core-team/work-item-hierarchy')

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ code: 'WorkItemListLimitExceeded' })
})

test('keeps the status and code of a relation graph failure while reading the Team hierarchy', async () => {
  configureFakeProjectClients(true)
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({ getTeamHierarchyEntries: async () => [] }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getRelationGraphRevision() {
        throw new WorkItemConfigurationError(409, 'WorkItemRelationGraphConflict', 'The graph changed.')
      },
    }),
  })

  const response = await request('/api/teams/core-team/work-item-hierarchy')

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'WorkItemRelationGraphConflict' })
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
 * Configures a Team whose Work Item has one child under a completion policy.
 *
 * @param policy - Team parent completion policy.
 * @param teamIssues - Work Item persistence to use; the default fake when omitted.
 * @param childIds - Children listed under the Work Item; one `open-child` when omitted.
 * @returns Child relation reads made by the update.
 */
function configureParentWithOpenChild(
  policy: WorkItemParentCompletionPolicy,
  teamIssues?: ReturnType<typeof createTeamIssuesFake>,
  childIds: string[] = ['open-child'],
) {
  const childReads: string[] = []
  setTestAppDependencies({
    ...(teamIssues ? { teamIssues } : {}),
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
            ? childIds.map((childId) => ({ sourceWorkItemId: workItemId, targetWorkItemId: childId, type: 'child' }))
            : [],
          graphRevision: 6,
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
  const body: unknown = await response.json()
  // Unreadable children count too, so the public message must not reveal how many are open.
  expect(body).toEqual({
    code: 'WorkItemOpenChildren',
    message: 'A child Work Item is still open. Complete or cancel the children before completing the parent.',
  })
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

test('fences the relation graph and the closed children into completing a parent the Team guards', async () => {
  configureFakeProjectClients(true)
  const teamIssues = getTestAppDependencies().workItems.teamIssues
  const fenceChecks: unknown[] = []
  configureParentWithOpenChild('reject', createTeamIssuesFake({
    async getTeamIssueDetail(directoryId, teamId, issueId, options) {
      if (issueId !== 'open-child') return teamIssues.getTeamIssueDetail(directoryId, teamId, issueId, options)
      const detail = await teamIssues.getTeamIssueDetail(directoryId, teamId, 'onboarding-friction', options)
      return { ...detail, issue: { ...detail.issue, id: 'open-child', statusCategory: 'completed', revision: 4 } }
    },
    async updateTeamIssue(directoryId, teamId, issueId, input, ...rest) {
      fenceChecks.push(...(input.configurationConditionChecks ?? []))
      return teamIssues.updateTeamIssue(directoryId, teamId, issueId, input, ...rest)
    },
  }))

  const response = await request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    body: { workflowStatusId: 'done', expectedRevision: 1 },
  })

  expect(response.status).toBe(200)
  expect(fenceChecks).toContainEqual({
    ConditionCheck: expect.objectContaining({
      ConditionExpression: expect.stringContaining('#revision = :expectedRevision'),
      ExpressionAttributeValues: expect.objectContaining({ ':expectedRevision': 6 }),
    }),
  })
  expect(fenceChecks).toContainEqual({
    ConditionCheck: expect.objectContaining({
      Key: expect.objectContaining({ issueId: 'open-child' }),
      ExpressionAttributeValues: { ':expectedRevision': 4 },
    }),
  })
})

/**
 * Completes a guarded parent whose children are all closed and records the update's checks.
 *
 * @param childCount - Closed children listed under the parent.
 * @returns The response status and the configuration condition checks sent with the update.
 */
async function completeParentWithClosedChildren(childCount: number) {
  const teamIssues = getTestAppDependencies().workItems.teamIssues
  const fenceChecks: unknown[] = []
  const childIds = Array.from({ length: childCount }, (_, index) => `closed-child-${index}`)
  configureParentWithOpenChild('reject', createTeamIssuesFake({
    async getTeamIssueDetail(directoryId, teamId, issueId, options) {
      if (!issueId.startsWith('closed-child-')) {
        return teamIssues.getTeamIssueDetail(directoryId, teamId, issueId, options)
      }
      const detail = await teamIssues.getTeamIssueDetail(directoryId, teamId, 'onboarding-friction', options)
      return { ...detail, issue: { ...detail.issue, id: issueId, statusCategory: 'completed', revision: 4 } }
    },
    async updateTeamIssue(directoryId, teamId, issueId, input, ...rest) {
      fenceChecks.push(...(input.configurationConditionChecks ?? []))
      return teamIssues.updateTeamIssue(directoryId, teamId, issueId, input, ...rest)
    },
  }), childIds)
  const response = await request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    body: { workflowStatusId: 'done', expectedRevision: 1 },
  })
  const childFenceCount = fenceChecks.filter((check) =>
    JSON.stringify(check).includes('"issueId":"closed-child-')
  ).length
  return { status: response.status, checkCount: fenceChecks.length, childFenceCount }
}

test('fences closed children only while their checks fit the update transaction', async () => {
  configureFakeProjectClients(true)
  const fitting = await completeParentWithClosedChildren(60)
  expect(fitting).toMatchObject({ status: 200, childFenceCount: 60 })

  // Too many children for the transaction: only the graph revision fences the completion.
  const crowded = await completeParentWithClosedChildren(70)
  expect(crowded).toMatchObject({ status: 200, childFenceCount: 0 })
  expect(crowded.checkCount).toBeGreaterThan(0)
  expect(crowded.checkCount).toBeLessThanOrEqual(70)
})

test('completes a parent whose only child was deleted but left its relation behind', async () => {
  configureFakeProjectClients(true)
  const teamIssues = getTestAppDependencies().workItems.teamIssues
  const detailReads: string[] = []
  configureParentWithOpenChild('reject', createTeamIssuesFake({
    async getTeamIssueDetail(directoryId, teamId, issueId, options) {
      detailReads.push(issueId)
      if (issueId === 'open-child') throw new ProjectDataError(404, 'TeamIssueNotFound', 'Missing.')
      return teamIssues.getTeamIssueDetail(directoryId, teamId, issueId, options)
    },
    async updateTeamIssue(...args) {
      return teamIssues.updateTeamIssue(...args)
    },
  }))

  const response = await request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    body: { workflowStatusId: 'done', expectedRevision: 1 },
  })

  expect(response.status).toBe(200)
  expect(detailReads).toContain('open-child')
})

test('reads the readable parent and children of one Work Item without the Team tree', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  const issues: Record<string, TeamIssueResponseItem> = {
    parent: { ...base, id: 'parent' },
    'child-b': { ...base, id: 'child-b' },
    'child-a': { ...base, id: 'child-a' },
    archived: { ...base, id: 'archived', archivedAt: '2026-11-01T00:00:00.000Z' },
    secret: { ...base, id: 'secret', assignedProjectId: 'secret-project' },
  }
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamIssueDetail(_directoryId, _teamId, issueId) {
        const issue = issues[issueId]
        if (!issue) throw new ProjectDataError(404, 'TeamIssueNotFound', 'Missing.')
        return { issue, activity: [] }
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations(_workspaceId, _teamId, workItemId) {
        return {
          relations: ['child-b', 'archived', 'missing', 'secret', 'child-a'].map((targetWorkItemId) => ({
            sourceWorkItemId: workItemId,
            targetWorkItemId,
            type: 'child' as const,
          })),
          graphRevision: 3,
        }
      },
    }),
  })

  const links = await runWithTestAppDependencies(() => readWorkItemHierarchyLinks(
    'user#demo@example.com',
    'core-team',
    { ...base, id: 'middle', relationIds: ['parent:parent'] },
    (issue) => issue.assignedProjectId !== 'secret-project',
  ))

  expect(links).toEqual({ parentWorkItemId: 'parent', childWorkItemIds: ['child-a', 'child-b'] })
  const archivedLinks = await runWithTestAppDependencies(() => readWorkItemHierarchyLinks(
    'user#demo@example.com',
    'core-team',
    { ...base, id: 'middle', relationIds: ['parent:parent'], archivedAt: '2026-11-01T00:00:00.000Z' },
    () => true,
  ))
  expect(archivedLinks).toEqual({ parentWorkItemId: null, childWorkItemIds: [] })
})

test('counts the open readable children of a Work Item for the completion warning', async () => {
  configureFakeProjectClients(true)
  const base = await readBaseIssue()
  const issues: Record<string, TeamIssueResponseItem> = {
    parent: { ...base, id: 'parent' },
    open: { ...base, id: 'open', statusCategory: 'started' },
    done: { ...base, id: 'done', statusCategory: 'completed' },
    canceled: { ...base, id: 'canceled', statusCategory: 'canceled' },
    archived: { ...base, id: 'archived', statusCategory: 'started', archivedAt: '2026-11-01T00:00:00.000Z' },
    secret: { ...base, id: 'secret', statusCategory: 'started', assignedProjectId: 'secret-project' },
  }
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamIssueDetail(_directoryId, _teamId, issueId) {
        const issue = issues[issueId]
        if (!issue) throw new ProjectDataError(404, 'TeamIssueNotFound', 'Missing.')
        return { issue, activity: [] }
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations(_workspaceId, _teamId, workItemId) {
        return {
          relations: ['open', 'done', 'canceled', 'archived', 'missing', 'secret'].map((targetWorkItemId) => ({
            sourceWorkItemId: workItemId,
            targetWorkItemId,
            type: 'child' as const,
          })),
          graphRevision: 3,
        }
      },
    }),
  })

  const response = await request('/api/teams/core-team/issues/parent/children/open-count')

  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  // Only `open` counts: the others are closed, archived, missing, or in a Project the reader cannot see.
  expect(body).toEqual({ openChildCount: 1 })
  const missing = await request('/api/teams/core-team/issues/missing/children/open-count')
  expect(missing.status).toBe(404)
})
