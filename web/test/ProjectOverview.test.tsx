import { describe, expect, test } from 'bun:test'
import type { PlanningEntity } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import type { ProjectMember } from '../src/projects/api'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import {
  findProjectOverviewUpdateTarget,
  selectProjectOverviewSchedule,
  summarizeProjectOverviewMembers,
  summarizeProjectOverviewWorkItems,
} from '../src/projects/model/projectOverview'
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
        isMembersError={false}
        isMembersLoading={false}
        isPlanningError={false}
        isPlanningLoading={false}
        isWorkItemsLoading={false}
        locale="en"
        members={summarizeProjectOverviewMembers([createMember('lead', 'manager', 'Lead')])}
        project={referoProject}
        schedule={selectProjectOverviewSchedule(planningSnapshotFixture.entities, 'core-team', 'refero')}
        t={createTranslator('en')}
        team={coreTeam}
        workItemSummary={summarizeProjectOverviewWorkItems(referoTaskFixtures, referenceDate)}
        {...props}
      />
    </MemoryRouter>,
  )
}

describe('Project overview model', () => {
  test('counts progress and attention over the Project Work Items', () => {
    const summary = summarizeProjectOverviewWorkItems(referoTaskFixtures, referenceDate)

    expect(summary.totalCount).toBe(referoTaskFixtures.length)
    expect(summary.openCount + summary.doneCount).toBeLessThanOrEqual(summary.totalCount)
    expect(summary.overdueCount).toBeLessThanOrEqual(summary.openCount)
    expect(summary.completionRate).toBe(
      Math.round((summary.doneCount / summary.totalCount) * 100),
    )
    expect(summarizeProjectOverviewWorkItems([], referenceDate).completionRate).toBe(0)
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

describe('ProjectOverviewView', () => {
  test('shows every widget with deep links to the existing views', () => {
    const html = renderOverview()

    expect(html).toContain('data-testid="project-overview-name"')
    expect(html).toContain('data-testid="project-overview-health"')
    expect(html).toContain('data-testid="project-overview-progress"')
    expect(html).toContain('data-testid="project-overview-schedule"')
    expect(html).toContain('data-testid="project-overview-members"')
    expect(html).toContain('href="/projects/refero/issues?teamId=core-team"')
    expect(html).toContain('href="/planning/portfolio?targetType=project&amp;teamId=core-team&amp;projectId=refero"')
    expect(html).toContain('href="/teams/core-team/factory"')
    expect(html).toContain('href="/documents"')
  })

  test('marks each failed read in its own widget without hiding the others', () => {
    const html = renderOverview({
      isMembersError: true,
      isPlanningError: true,
      members: undefined,
      schedule: undefined,
      workItemSummary: undefined,
      workItemsError: 'limit',
    })

    expect(html).toContain('more work items than the read limit')
    expect(html).toContain('Planning data could not be loaded')
    expect(html).toContain('Members could not be loaded.')
    expect(html).toContain('data-testid="project-overview-links"')
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
      isMembersError: true,
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

  test('asks for the owning Team when the route does not name a readable one', () => {
    const html = renderOverview({ team: undefined, project: undefined })

    expect(html).toContain('data-testid="project-overview-missing"')
    expect(html).not.toContain('data-testid="project-overview-health"')
  })
})
