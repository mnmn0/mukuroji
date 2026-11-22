import { describe, expect, test } from 'bun:test'
import type { PlanningEntity } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { factoryBoardFixture } from '../src/features/factory-board/fixtures'
import { documentBacklinkFixtures, documentSummaryFixtures } from '../src/documents/fixtures'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import type { ProjectMember } from '../src/projects/api'
import { projectDirectoryFixtures, projectRaidLogFixtures } from '../src/projects/fixtures'
import {
  findProjectOverviewUpdateTarget,
  selectProjectOverviewDocuments,
  selectProjectOverviewSchedule,
  summarizeProjectOverviewAgentRuns,
  summarizeProjectOverviewMembers,
  summarizeProjectOverviewRaid,
  summarizeProjectOverviewWorkItems,
} from '../src/projects/model/projectOverview'
import { resolveWorkflowStatusCategory } from '../src/work-items/model/workItemDisplay'
import { ProjectOverviewView, type ProjectOverviewViewProps } from '../src/projects/ui/ProjectOverviewView'
import { createTranslator } from '../src/shared/i18n/i18n'
import { referoTaskFixtures } from '../src/tasks/fixtures'

const referenceDate = new Date('2026-06-10T00:00:00.000Z')
const coreTeam = projectDirectoryFixtures[0]
const referoProject = coreTeam.projects[0]

/**
 * Builds one Planning entity with schedule defaults.
 *
 * @param overrides - Fields that differ from the defaults.
 * @returns A Planning entity.
 */
function createEntity(overrides: Partial<PlanningEntity> & Pick<PlanningEntity, 'id'>): PlanningEntity {
  return {
    type: 'milestone',
    title: overrides.id,
    teamId: 'core-team',
    projectId: 'refero',
    ownerMemberKey: 'owner@example.com',
    status: 'active',
    health: 'on-track',
    rollupHealth: 'on-track',
    risk: 'none',
    progressMode: 'automatic',
    progress: 0,
    linkedWorkItemCount: 0,
    baseline: { startDate: '2026-07-01', endDate: '2026-07-31' },
    forecast: { startDate: '2026-07-01', endDate: '2026-07-31' },
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Builds one Project member.
 *
 * @param id - Member key.
 * @param role - Project role.
 * @param name - Display name.
 * @returns A Project member.
 */
function createMember(id: string, role: ProjectMember['role'], name?: string): ProjectMember {
  return {
    email: `${id}@example.com`,
    id,
    name,
    role,
    updatedAt: '2026-06-01T00:00:00.000Z',
    workspaceStatus: 'active',
  }
}

/**
 * Renders the overview with English labels inside a router.
 *
 * @param props - Props that differ from a fully loaded overview.
 * @returns Static markup.
 */
function renderOverview(props: Partial<ProjectOverviewViewProps> = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ProjectOverviewView
        agentRuns={summarizeProjectOverviewAgentRuns(factoryBoardFixture, 'refero')}
        isMembersLoading={false}
        isPlanningError={false}
        isPlanningLoading={false}
        isWorkItemsLoading={false}
        locale="en"
        members={summarizeProjectOverviewMembers([createMember('lead', 'manager', 'Lead')])}
        project={referoProject}
        raid={summarizeProjectOverviewRaid(projectRaidLogFixtures, '2026-06-10')}
        documents={selectProjectOverviewDocuments('refero', documentBacklinkFixtures, documentSummaryFixtures, false)}
        schedule={selectProjectOverviewSchedule(planningSnapshotFixture.entities, 'core-team', 'refero')}
        t={createTranslator('en')}
        team={coreTeam}
        workItemSummary={summarizeProjectOverviewWorkItems(referoTaskFixtures, 'core-team', referenceDate)}
        {...props}
      />
    </MemoryRouter>,
  )
}

describe('Project overview model', () => {
  test('counts progress and attention over the Project Work Items', () => {
    const summary = summarizeProjectOverviewWorkItems(referoTaskFixtures, 'core-team', referenceDate)

    expect(summary.totalCount).toBe(referoTaskFixtures.length)
    expect(summary.openCount + summary.doneCount).toBeLessThanOrEqual(summary.totalCount)
    expect(summary.overdueCount).toBeLessThanOrEqual(summary.openCount)
    expect(summary.completionRate).toBe(
      Math.round((summary.doneCount / summary.totalCount) * 100),
    )
    expect(summarizeProjectOverviewWorkItems([], 'core-team', referenceDate).completionRate).toBe(0)
  })

  test('counts only the Work Items of the overview Team when Teams share a Project ID', () => {
    const otherTeamWorkItems = referoTaskFixtures.map((workItem) => ({ ...workItem, teamId: 'design-team' }))
    const summary = summarizeProjectOverviewWorkItems(
      [...referoTaskFixtures, ...otherTeamWorkItems],
      'core-team',
      referenceDate,
    )

    expect(summary).toEqual(summarizeProjectOverviewWorkItems(referoTaskFixtures, 'core-team', referenceDate))
    expect(summarizeProjectOverviewWorkItems(otherTeamWorkItems, 'core-team', referenceDate).totalCount).toBe(0)
  })

  test('keeps only live schedule entities of the Team-qualified Project, nearest end first', () => {
    const schedule = selectProjectOverviewSchedule([
      createEntity({ id: 'late', forecast: { startDate: '2026-07-01', endDate: '2026-08-05' } }),
      createEntity({ id: 'early', type: 'phase', forecast: { startDate: '2026-07-01', endDate: '2026-07-29' } }),
      createEntity({ id: 'other-team', teamId: 'design-team' }),
      createEntity({ id: 'other-project', projectId: 'brand-refresh' }),
      createEntity({ id: 'archived', archivedAt: '2026-06-02T00:00:00.000Z' }),
      createEntity({ id: 'goal', type: 'goal' }),
    ], 'core-team', 'refero')

    expect(schedule.items.map((item) => item.id)).toEqual(['early', 'late'])
    expect(schedule.items.map((item) => item.delayDays)).toEqual([-2, 5])
    expect(schedule.delayedCount).toBe(1)
    expect(schedule.hiddenCount).toBe(0)
  })

  test('reports schedule rows left out by the limit', () => {
    const schedule = selectProjectOverviewSchedule([
      createEntity({ id: 'a', forecast: { startDate: '2026-07-01', endDate: '2026-08-01' } }),
      createEntity({ id: 'b', forecast: { startDate: '2026-07-01', endDate: '2026-08-02' } }),
      createEntity({ id: 'c', forecast: { startDate: '2026-07-01', endDate: '2026-08-03' } }),
    ], 'core-team', 'refero', 2)

    expect(schedule.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(schedule.hiddenCount).toBe(1)
    expect(schedule.delayedCount).toBe(3)
  })

  test('finds the update target only for the same Team and Project', () => {
    expect(findProjectOverviewUpdateTarget(planningSnapshotFixture.updateTargets, 'core-team', 'refero'))
      .toBe(planningSnapshotFixture.updateTargets.find((target) =>
        target.target.type === 'project' &&
        target.target.teamId === 'core-team' &&
        target.target.projectId === 'refero'
      ))
    expect(findProjectOverviewUpdateTarget(planningSnapshotFixture.updateTargets, 'missing-team', 'refero'))
      .toBeUndefined()
  })

  test('groups members by role and lists managers first within the limit', () => {
    const members = summarizeProjectOverviewMembers([
      createMember('viewer', 'viewer', 'Vera'),
      createMember('member', 'member', 'Mina'),
      createMember('manager', 'manager', 'Zoe'),
    ], 2)

    expect(members.roleCounts).toEqual({ manager: 1, member: 1, viewer: 1 })
    expect(members.totalCount).toBe(3)
    expect(members.shown.map((member) => member.id)).toEqual(['manager', 'member'])
    expect(members.hiddenCount).toBe(1)
  })
})

describe('Project overview Agent Run lanes', () => {
  test('counts only the Project Work Items in each Factory board lane at the board read time', () => {
    const summary = summarizeProjectOverviewAgentRuns(factoryBoardFixture, 'refero')

    // release-notes and stalled-import belong to no Project, so they are left out.
    expect(summary.laneCounts).toEqual({
      processing: 1,
      'no-run': 1,
      decision: 2,
      stalled: 0,
      failed: 1,
      completed: 1,
    })
    expect(summary.totalCount).toBe(6)
    expect(summary.isIncomplete).toBe(false)
  })

  test('evaluates lanes at generatedAt so an aged completion leaves the counts', () => {
    const later = { ...factoryBoardFixture, generatedAt: '2026-10-23T23:00:00.000Z' }

    expect(summarizeProjectOverviewAgentRuns(later, 'refero').laneCounts.completed).toBe(0)
  })

  test('marks the counts incomplete when the board stopped at any read bound', () => {
    for (const flag of ['activeRunsHasMore', 'finishedRunsHasMore', 'startedWorkItemsHasMore'] as const) {
      const bounded = { ...factoryBoardFixture, [flag]: true }
      expect(summarizeProjectOverviewAgentRuns(bounded, 'refero').isIncomplete).toBe(true)
    }
  })

  test('counts nothing for a Project without board items', () => {
    const summary = summarizeProjectOverviewAgentRuns(factoryBoardFixture, 'brand-refresh')

    expect(summary.totalCount).toBe(0)
    expect(Object.values(summary.laneCounts).every((count) => count === 0)).toBe(true)
  })
})

describe('Project overview blocked count', () => {
  const openItems = referoTaskFixtures.filter((workItem) => {
    const category = resolveWorkflowStatusCategory(workItem)
    return category !== 'completed' && category !== 'canceled'
  })
  const doneItem = referoTaskFixtures.find((workItem) => resolveWorkflowStatusCategory(workItem) === 'completed')

  test('counts an open Work Item whose blocker is readable and still open', () => {
    expect(openItems.length).toBeGreaterThanOrEqual(2)
    expect(doneItem).toBeDefined()
    const [blocked, blocker] = openItems
    const workItems = referoTaskFixtures.map((workItem) =>
      workItem.id === blocked.id ? { ...workItem, relationIds: [`blockedBy:${blocker.id}`] } : workItem
    )

    expect(summarizeProjectOverviewWorkItems(workItems, 'core-team', referenceDate).blockedCount).toBe(1)
  })

  test('leaves out completed and unreadable blockers', () => {
    const [blocked, other] = openItems
    const workItems = referoTaskFixtures.map((workItem) => {
      if (workItem.id === blocked.id) return { ...workItem, relationIds: [`blockedBy:${doneItem?.id}`] }
      if (workItem.id === other.id) return { ...workItem, relationIds: ['blockedBy:hidden-work-item', 'blocks:x'] }
      return workItem
    })

    expect(summarizeProjectOverviewWorkItems(workItems, 'core-team', referenceDate).blockedCount).toBe(0)
  })

  test('resolves a blocker outside the Project from the Planning snapshot of the same Team', () => {
    const [blocked] = openItems
    const workItems = referoTaskFixtures.map((workItem) =>
      workItem.id === blocked.id ? { ...workItem, relationIds: ['blockedBy:outside'] } : workItem
    )
    const planningItem = { ...planningSnapshotFixture.workItems[0], id: 'outside', statusCategory: 'started' as const }

    expect(summarizeProjectOverviewWorkItems(
      workItems, 'core-team', referenceDate, [{ ...planningItem, teamId: 'core-team' }],
    ).blockedCount).toBe(1)
    expect(summarizeProjectOverviewWorkItems(
      workItems, 'core-team', referenceDate, [{ ...planningItem, teamId: 'design-team' }],
    ).blockedCount).toBe(0)
    expect(summarizeProjectOverviewWorkItems(
      workItems, 'core-team', referenceDate, [{ ...planningItem, statusCategory: 'completed', teamId: 'core-team' }],
    ).blockedCount).toBe(0)
  })
})

describe('Project overview log', () => {
  test('counts open entries and lists the most severe open risks and issues first', () => {
    const raid = summarizeProjectOverviewRaid(projectRaidLogFixtures, '2026-06-10')

    expect(raid.openRiskCount).toBe(2)
    expect(raid.openIssueCount).toBe(1)
    expect(raid.pendingDecisionCount).toBe(1)
    expect(raid.overdueReviewCount).toBe(1)
    expect(raid.attention.map((item) => item.id)).toEqual(['risk-vendor', 'issue-staging', 'risk-capacity'])
    expect(raid.attention[0]).toMatchObject({ isReviewOverdue: true, severity: 'critical' })
    expect(raid.hiddenAttentionCount).toBe(0)
  })

  test('lists closed change requests as decisions, latest first, and leaves out other closed entries', () => {
    const later = {
      ...projectRaidLogFixtures[4],
      id: 'cr-later',
      closedAt: '2026-06-08T00:00:00.000Z',
    }
    const raid = summarizeProjectOverviewRaid([...projectRaidLogFixtures, later], '2026-06-10')

    expect(raid.recentDecisions.map((item) => item.id)).toEqual(['cr-later', 'cr-report'])
    expect(raid.recentDecisions[0]).toMatchObject({
      decidedAt: '2026-06-08T00:00:00.000Z',
      response: '次フェーズで対応することで合意。',
    })
  })

  test('bounds both lists by the limit and reports the open entries left out', () => {
    const raid = summarizeProjectOverviewRaid(projectRaidLogFixtures, '2026-06-10', 1)

    expect(raid.attention).toHaveLength(1)
    expect(raid.hiddenAttentionCount).toBe(2)
    expect(raid.recentDecisions).toHaveLength(1)
  })
})

describe('Project overview Documents', () => {
  const projectScope = { projectId: 'refero', type: 'project' } as const
  const scopedDocuments = [
    ...documentSummaryFixtures.map((document) => ({ ...document, scope: projectScope })),
    { ...documentSummaryFixtures[1], id: 'project-brief', scope: projectScope, title: 'Duplicate of a linked Document' },
    { ...documentSummaryFixtures[1], id: 'other-project-page', scope: { projectId: 'other', type: 'project' } as const },
  ]

  test('lists linked Documents first, then pages in the Project scope, without folders, templates, or archives', () => {
    const documents = selectProjectOverviewDocuments('refero', documentBacklinkFixtures, scopedDocuments, false)
    const ids = documents.items.map((item) => item.id)

    expect(ids[0]).toBe('project-brief')
    expect(documents.items[0].source).toBe('linked')
    expect(documents.items.filter((item) => item.id === 'project-brief')).toHaveLength(1)
    expect(ids).not.toContain('product-handbook')
    expect(ids).not.toContain('weekly-notes-template')
    expect(ids).not.toContain('research-archive')
    expect(ids.slice(1)).toEqual(['product-principles', 'launch-workshop', 'decision-log'])
    expect(documents.items.find((item) => item.id === 'launch-workshop')?.source).toBe('project')
  })

  test('ignores backlinks to other targets and Documents of other scopes', () => {
    const documents = selectProjectOverviewDocuments('refero', documentBacklinkFixtures, scopedDocuments, false)
    const ids = documents.items.map((item) => item.id)

    expect(ids).not.toContain('launch-plan')
    expect(ids).not.toContain('other-project-page')
    expect(selectProjectOverviewDocuments('other', documentBacklinkFixtures, documentSummaryFixtures, false).items)
      .toEqual([])
  })

  test('bounds the list and keeps whether a source has more pages', () => {
    const documents = selectProjectOverviewDocuments('refero', documentBacklinkFixtures, scopedDocuments, true, 1)

    expect(documents.items).toHaveLength(1)
    expect(documents.hiddenCount).toBe(3)
    expect(documents.hasMore).toBe(true)
  })
})

describe('ProjectOverviewView', () => {
  test('shows every widget with deep links to the existing views', () => {
    const html = renderOverview()

    expect(html).toContain('data-testid="project-overview-name"')
    expect(html).toContain('data-testid="project-overview-health"')
    expect(html).toContain('data-testid="project-overview-progress"')
    expect(html).toContain('data-testid="project-overview-schedule"')
    expect(html).toContain('data-testid="project-overview-members"')
    expect(html).toContain('data-testid="project-overview-agent-runs"')
    expect(html).toContain('data-testid="project-overview-agent-lane-decision"')
    expect(html).toContain('href="/projects/refero/issues?teamId=core-team"')
    expect(html).toContain('href="/planning/portfolio?targetType=project&amp;teamId=core-team&amp;projectId=refero"')
    expect(html).toContain('href="/teams/core-team/factory"')
    expect(html).toContain('data-testid="project-overview-raid"')
    expect(html).toContain('data-testid="project-overview-documents"')
    expect(html).toContain('href="/documents?projectId=refero"')
    expect(html).toContain('href="/documents/project-brief"')
  })

  test('hides the Agent Run lanes and the Factory board link without Software factory', () => {
    const html = renderOverview({ showAgentRuns: false })

    expect(html).toContain('data-testid="project-overview-members"')
    expect(html).not.toContain('data-testid="project-overview-agent-runs"')
    expect(html).not.toContain('href="/teams/core-team/factory"')
  })

  test('marks each failed read in its own widget without hiding the others', () => {
    const html = renderOverview({
      membersError: 'load',
      isPlanningError: true,
      members: undefined,
      schedule: undefined,
      workItemSummary: undefined,
      workItemsError: 'limit',
    })

    expect(html).toContain('more work items than the read limit')
    expect(html).toContain('Planning data could not be loaded')
    expect(html).toContain('Members could not be loaded.')
    expect(html).toContain('data-testid="project-overview-documents"')
  })

  test('offers a retry for failed reads but not for a list over the read limit', () => {
    const retryProps = {
      onRetryMembers: () => undefined,
      onRetryPlanning: () => undefined,
      onRetryWorkItems: () => undefined,
    }
    const countRetries = (html: string) => html.split('>Reload</button>').length - 1
    const failed = renderOverview({
      ...retryProps,
      membersError: 'load',
      isPlanningError: true,
      members: undefined,
      schedule: undefined,
      workItemSummary: undefined,
      workItemsError: 'load',
    })
    const overLimit = renderOverview({ ...retryProps, workItemSummary: undefined, workItemsError: 'limit' })

    expect(countRetries(failed)).toBe(4)
    expect(countRetries(overLimit)).toBe(0)
  })

  test('explains a members read denied by the Project role without offering a retry', () => {
    const html = renderOverview({
      members: undefined,
      membersError: 'denied',
      onRetryMembers: () => undefined,
    })

    expect(html).toContain('Your Project role cannot view the member list.')
    expect(html).not.toContain('Members could not be loaded.')
    expect(html).not.toContain('>Reload</button>')
  })

  test('shows the Agent Run read state in its own widget', () => {
    const failed = renderOverview({ agentRuns: undefined, agentRunsError: 'load', onRetryAgentRuns: () => undefined })
    const denied = renderOverview({ agentRuns: undefined, agentRunsError: 'denied', onRetryAgentRuns: () => undefined })
    const bounded = renderOverview({
      agentRuns: summarizeProjectOverviewAgentRuns({ ...factoryBoardFixture, activeRunsHasMore: true }, 'refero'),
    })

    expect(failed).toContain('Agent runs could not be loaded.')
    expect(failed).toContain('>Reload</button>')
    expect(denied).toContain('Your Team role cannot view agent runs.')
    expect(denied).not.toContain('>Reload</button>')
    expect(bounded).toContain('reached its read limit')
  })

  test('shows the log and Document read states in their own widgets', () => {
    const denied = renderOverview({ documents: undefined, documentsError: 'denied', raid: undefined, raidError: 'denied' })
    expect(denied).toContain('Your Project role cannot view risks')
    expect(denied).toContain('Your role cannot view documents.')
    expect(denied).not.toContain('>Reload<')

    const failed = renderOverview({
      documentsError: 'load',
      onRetryDocuments: () => undefined,
      onRetryRaid: () => undefined,
      raid: undefined,
      raidError: 'load',
    })
    expect(failed).toContain('Could not load risks, issues, and change requests.')
    expect(failed).toContain('Some documents could not be loaded.')
    expect(failed).toContain('href="/documents/project-brief"')
    expect(failed.match(/>Reload</g)).toHaveLength(2)

    const empty = renderOverview({
      documents: selectProjectOverviewDocuments('refero', [], [], false),
      raid: summarizeProjectOverviewRaid([], '2026-06-10'),
    })
    expect(empty).toContain('No open risks or issues.')
    expect(empty).toContain('No change requests have been decided yet.')
    expect(empty).toContain('No documents relate to this project yet.')
  })

  test('asks for the owning Team when the route does not name a readable one', () => {
    const html = renderOverview({ team: undefined, project: undefined })

    expect(html).toContain('data-testid="project-overview-missing"')
    expect(html).not.toContain('data-testid="project-overview-health"')
  })
})
