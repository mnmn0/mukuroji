import { expect, test } from 'bun:test'
import type {
  DirectoryAdministrationResponse,
  DirectoryArchiveImpactTarget,
  WebhookSubscription,
} from '@mukuroji/contracts'
import type { AgentRunPage, StoredAgentRun } from '../../modules/agent-runs'
import type { PlanningAuthorizationState } from '../../modules/planning'
import type { SortedWorkItemPage, TeamIssueResponseItem } from '../../modules/work-items'
import {
  readDirectoryArchiveImpact,
  type DirectoryArchiveImpactSources,
} from './directory-archive-impact'

const directoryId = 'workspace-1'

/** Directory with one active Team, one active Project, and one archived Project. */
const directory: DirectoryAdministrationResponse = {
  teams: [{
    id: 'core',
    nameJa: 'コア',
    nameEn: 'Core',
    projects: [
      { id: 'alpha', nameJa: 'A', nameEn: 'A', tone: 'blue' },
      { id: 'old', nameJa: 'O', nameEn: 'O', tone: 'blue', archivedAt: '2026-01-01T00:00:00.000Z' },
    ],
  }],
}

/**
 * Builds a Work Item row with only the fields the impact count reads.
 *
 * @param id - Team-local Work Item ID.
 * @param statusCategory - Status category.
 * @param extra - Other overridden fields.
 * @returns The Work Item row.
 */
function workItem(
  id: string,
  statusCategory: TeamIssueResponseItem['statusCategory'],
  extra: Partial<TeamIssueResponseItem> = {},
): TeamIssueResponseItem {
  // Only `id`, `teamId`, `archivedAt`, and `statusCategory` are read by the count.
  return Object.assign(Object.create(null), {
    id,
    teamId: 'core',
    statusCategory,
    ...extra,
  })
}

/**
 * Builds an active run on a Work Item.
 *
 * @param workItemId - Work Item the run claims.
 * @returns The run, with only the fields the count reads.
 */
function activeRun(workItemId: string): StoredAgentRun {
  return Object.assign(Object.create(null), { workItemId, state: 'active' })
}

/** Options of {@link createSources}. */
type SourceOptions = {
  /** Work Item pages, returned in order. */
  workItemPages?: SortedWorkItemPage[]
  /** Active run pages, returned in order. */
  runPages?: AgentRunPage[]
  /** Planning state. */
  planning?: Partial<PlanningAuthorizationState>
  /** Assigned Project of each Work Item read one by one; `null` means the Work Item is gone. */
  assignments?: Record<string, string | null>
  /** Webhook subscriptions. */
  subscriptions?: Array<Pick<WebhookSubscription, 'status' | 'teamIds'>>
}

/**
 * Creates fake sources that record the Work Item scopes they were asked for.
 *
 * @param options - Records each source returns.
 * @returns The sources and the recorded Work Item reads.
 */
function createSources(options: SourceOptions = {}) {
  const workItemReads: DirectoryArchiveImpactTarget[] = []
  let workItemPage = 0
  let runPage = 0
  const sources: DirectoryArchiveImpactSources = {
    readDirectory: async () => directory,
    readPlanning: async () => ({
      revision: 1,
      entities: [],
      workItemLinks: [],
      workItemDependencies: [],
      updateTargets: [],
      ...options.planning,
    }),
    readWorkItemPage: async (_directoryId, target) => {
      workItemReads.push(target)
      const pages = options.workItemPages ?? [{ issues: [] }]
      const page = pages[workItemPage] ?? { issues: [] }
      workItemPage += 1
      return page
    },
    readActiveRunPage: async () => {
      const pages = options.runPages ?? [{ runs: [] }]
      const page = pages[runPage] ?? { runs: [] }
      runPage += 1
      return page
    },
    readWorkItemAssignment: async (_directoryId, _teamId, workItemId) => {
      const assignment = options.assignments?.[workItemId]
      if (assignment === null) return undefined
      return assignment === undefined ? {} : { assignedProjectId: assignment }
    },
    listWebhookSubscriptions: async () =>
      (options.subscriptions ?? []).map((subscription) =>
        Object.assign(Object.create(null), subscription)
      ),
  }
  return { sources, workItemReads }
}

test('counts open Work Items, active runs, and active Webhooks of a Team as warnings', async () => {
  const { sources, workItemReads } = createSources({
    workItemPages: [{
      issues: [
        workItem('1', 'started'),
        workItem('2', 'backlog'),
        workItem('3', 'completed'),
        workItem('4', 'canceled'),
      ],
    }],
    runPages: [{ runs: [activeRun('1'), activeRun('9')] }],
    subscriptions: [
      { status: 'active', teamIds: ['core'] },
      { status: 'paused', teamIds: ['core'] },
      { status: 'active', teamIds: ['other'] },
    ],
  })

  const impact = await readDirectoryArchiveImpact(directoryId, { kind: 'team', teamId: 'core' }, sources)

  expect(impact).toEqual({
    openWorkItems: { count: 2, hasMore: false },
    activeAgentRuns: { count: 2, hasMore: false },
    planningEntities: 0,
    planningWorkItemLinks: 0,
    planningDependencies: 0,
    webhookSubscriptions: 1,
    archiveBlocked: false,
  })
  expect(workItemReads).toEqual([{ kind: 'team', teamId: 'core' }])
})

test('reports the Planning references that block a Team archive', async () => {
  const { sources } = createSources({
    planning: {
      entities: [
        { id: 'p1', teamId: 'core' },
        { id: 'p2', teamId: 'core', archivedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'p3', teamId: 'other' },
      ].map((entity) => Object.assign(Object.create(null), entity)),
      workItemLinks: [{ teamId: 'core', projectId: 'alpha' }]
        .map((link) => Object.assign(Object.create(null), link)),
      workItemDependencies: [{
        predecessor: { teamId: 'other', workItemId: '1' },
        successor: { teamId: 'core', workItemId: '2' },
      }].map((dependency) => Object.assign(Object.create(null), dependency)),
    },
  })

  const impact = await readDirectoryArchiveImpact(directoryId, { kind: 'team', teamId: 'core' }, sources)

  expect(impact).toMatchObject({
    planningEntities: 1,
    planningWorkItemLinks: 1,
    planningDependencies: 1,
    archiveBlocked: true,
  })
})

test('counts a Project archive by the Project, including dependencies on its Work Items', async () => {
  const { sources, workItemReads } = createSources({
    workItemPages: [{
      issues: [
        workItem('1', 'started'),
        workItem('2', 'completed'),
        workItem('7', 'started', { teamId: 'other' }),
      ],
    }],
    runPages: [{ runs: [activeRun('1'), activeRun('2'), activeRun('5')] }],
    assignments: { '1': 'alpha', '2': 'beta' },
    planning: {
      entities: [{ id: 'p1', teamId: 'core', projectId: 'beta' }]
        .map((entity) => Object.assign(Object.create(null), entity)),
      workItemDependencies: [{
        predecessor: { teamId: 'core', workItemId: '1' },
        successor: { teamId: 'core', workItemId: '2' },
      }].map((dependency) => Object.assign(Object.create(null), dependency)),
    },
  })
  const target: DirectoryArchiveImpactTarget = { kind: 'project', teamId: 'core', projectId: 'alpha' }

  const impact = await readDirectoryArchiveImpact(directoryId, target, sources)

  expect(impact).toMatchObject({
    openWorkItems: { count: 1, hasMore: false },
    activeAgentRuns: { count: 2, hasMore: false },
    planningEntities: 0,
    planningDependencies: 1,
    archiveBlocked: true,
  })
  expect(workItemReads).toEqual([target])
})

test('reports a floor when counting stops before the last page', async () => {
  const page: SortedWorkItemPage = {
    issues: [workItem('1', 'started')],
    nextPosition: { kind: 'after-sort-order', sortOrder: 1 },
  }
  const { sources } = createSources({
    workItemPages: Array.from({ length: 20 }, () => page),
    runPages: Array.from({ length: 20 }, () => ({ runs: [activeRun('9')], nextCursor: 'next' })),
  })

  const team = await readDirectoryArchiveImpact(directoryId, { kind: 'team', teamId: 'core' }, sources)

  expect(team.openWorkItems).toEqual({ count: 10, hasMore: true })
  expect(team.activeAgentRuns).toEqual({ count: 5, hasMore: true })
})

test('refuses a missing or archived Team or Project', async () => {
  const { sources } = createSources()

  await expect(readDirectoryArchiveImpact(directoryId, { kind: 'team', teamId: 'gone' }, sources))
    .rejects.toMatchObject({ status: 404, code: 'TeamNotFound' })
  await expect(readDirectoryArchiveImpact(
    directoryId,
    { kind: 'project', teamId: 'core', projectId: 'old' },
    sources,
  )).rejects.toMatchObject({ status: 404, code: 'ProjectNotFound' })
})

test('ignores dependencies off the Project but blocks a Team with too many endpoints', async () => {
  const dependency = (workItemId: string) => Object.assign(Object.create(null), {
    predecessor: { teamId: 'core', workItemId },
    successor: { teamId: 'other', workItemId: 'x' },
  })
  const target: DirectoryArchiveImpactTarget = { kind: 'project', teamId: 'core', projectId: 'alpha' }
  const few = createSources({
    workItemPages: [{ issues: [workItem('1', 'started')] }],
    planning: { workItemDependencies: [dependency('elsewhere')] },
  })
  const many = createSources({
    workItemPages: [{ issues: [workItem('1', 'started')] }],
    planning: {
      workItemDependencies: Array.from({ length: 97 }, (_, index) => dependency(`d${index}`)),
    },
  })

  expect(await readDirectoryArchiveImpact(directoryId, target, few.sources)).toMatchObject({
    planningDependencies: 0,
    archiveBlocked: false,
  })
  expect(await readDirectoryArchiveImpact(directoryId, target, many.sources)).toMatchObject({
    planningDependencies: 0,
    archiveBlocked: true,
  })
})

test('counts archived Work Items for dependencies but not as open', async () => {
  const { sources } = createSources({
    workItemPages: [{
      issues: [workItem('1', 'started', { archivedAt: '2026-01-01T00:00:00.000Z' })],
    }],
    assignments: { '1': 'alpha' },
    planning: {
      workItemDependencies: [{
        predecessor: { teamId: 'core', workItemId: '1' },
        successor: { teamId: 'other', workItemId: 'x' },
      }].map((dependency) => Object.assign(Object.create(null), dependency)),
    },
  })

  const impact = await readDirectoryArchiveImpact(
    directoryId,
    { kind: 'project', teamId: 'core', projectId: 'alpha' },
    sources,
  )

  expect(impact.openWorkItems).toEqual({ count: 0, hasMore: false })
  expect(impact).toMatchObject({ planningDependencies: 1, archiveBlocked: true })
})

test('finds Project dependency blockers beyond the counted Work Items and missing ones', async () => {
  const dependency = (workItemId: string) => Object.assign(Object.create(null), {
    predecessor: { teamId: 'core', workItemId },
    successor: { teamId: 'other', workItemId: 'x' },
  })
  const { sources } = createSources({
    // The count stops before reaching either endpoint.
    workItemPages: Array.from({ length: 20 }, () => ({
      issues: [workItem('counted', 'started')],
      nextPosition: { kind: 'after-sort-order' as const, sortOrder: 1 },
    })),
    assignments: { far: 'alpha', gone: null, other: 'beta' },
    planning: { workItemDependencies: [dependency('far'), dependency('gone'), dependency('other')] },
  })

  const impact = await readDirectoryArchiveImpact(
    directoryId,
    { kind: 'project', teamId: 'core', projectId: 'alpha' },
    sources,
  )

  expect(impact).toMatchObject({ planningDependencies: 2, archiveBlocked: true })
})
