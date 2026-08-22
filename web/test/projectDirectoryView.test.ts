import { describe, expect, test } from 'bun:test'
import type { ProjectDirectoryTeam } from '../src/projects/api/directory'
import {
  PROJECT_DIRECTORY_UNASSIGNED_ID,
  createProjectDirectoryAssigneeOptions,
  createProjectDirectoryRows,
  filterProjectDirectoryRows,
  parseProjectDirectoryStatusFilter,
  paginateProjectDirectoryRows,
  parseProjectDirectoryPage,
} from '../src/projects/model/projectDirectoryView'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import type { CanonicalWorkItem } from '../src/tasks/api/tasks'
import { referoTaskFixtures } from '../src/tasks/fixtures'

const baseTask = referoTaskFixtures.find((task) => task.id === 'wireframe')

if (!baseTask) {
  throw new Error('Expected the wireframe task fixture.')
}

/**
 * Creates a canonical Work Item fixture with focused field overrides.
 *
 * @param overrides - Fields that differ from the shared base fixture.
 * @returns A complete canonical Project Work Item.
 */
function createTask(overrides: Partial<CanonicalWorkItem>): CanonicalWorkItem {
  return {
    ...baseTask,
    ...overrides,
  }
}

/**
 * Creates a large directory equivalent to the Issue #176 acceptance fixture.
 *
 * @returns Twenty Teams with twenty Projects each.
 */
function createLargeProjectDirectory(): ProjectDirectoryTeam[] {
  return Array.from({ length: 20 }, (_, teamIndex): ProjectDirectoryTeam => ({
    id: `team-${teamIndex + 1}`,
    name: `Team ${teamIndex + 1}`,
    projects: Array.from({ length: 20 }, (_, projectIndex) => ({
      id: `project-${teamIndex + 1}-${projectIndex + 1}`,
      name: `Project ${teamIndex + 1}.${projectIndex + 1}`,
      tone: projectIndex % 2 === 0 ? 'blue' : 'green',
    })),
  }))
}

describe('Project directory model', () => {
  test('derives Team-scoped status, progress, assignees, and quick access', () => {
    const coreCompleted = createTask({
      assignedProjectId: 'shared-launch',
      assigneeName: 'Aoi Sato',
      assigneeUserId: 'aoi',
      id: 'core-completed',
      priority: 'low',
      statusCategory: 'completed',
      teamId: 'core-team',
    })
    const designAttention = createTask({
      assignedProjectId: 'shared-launch',
      assigneeEmail: 'ren@example.com',
      assigneeName: undefined,
      assigneeUserId: 'ren',
      id: 'design-attention',
      priority: 'high',
      statusCategory: 'started',
      teamId: 'design-team',
    })
    const rows = createProjectDirectoryRows(
      projectDirectoryFixtures,
      [coreCompleted, designAttention],
      (item) => item.projectId === 'brand-refresh' || (
        item.projectId === 'shared-launch' && item.teamId === 'design-team'
      ),
    )
    const coreRow = rows.find((row) =>
      row.teamId === 'core-team' && row.projectId === 'shared-launch')
    const designRow = rows.find((row) =>
      row.teamId === 'design-team' && row.projectId === 'shared-launch')

    expect(coreRow).toMatchObject({
      assignees: [{ id: 'aoi', label: 'Aoi Sato' }],
      progress: 100,
      status: 'completed',
    })
    expect(designRow).toMatchObject({
      assignees: [{ id: 'ren', label: 'ren@example.com' }],
      isQuickAccess: true,
      progress: 0,
      status: 'attention',
    })
    expect(coreRow?.isQuickAccess).toBe(false)
    expect(rows.find((row) => row.projectId === 'brand-refresh')?.isQuickAccess).toBe(true)
  })

  test('combines search, Team, status, assignee, and quick-access filters', () => {
    const rows = createProjectDirectoryRows(
      projectDirectoryFixtures,
      [
        createTask({
          assignedProjectId: 'brand-refresh',
          assigneeName: 'Mika Ito',
          assigneeUserId: 'mika',
          id: 'brand-task',
          priority: 'low',
          statusCategory: 'started',
          teamId: 'design-team',
        }),
      ],
      (item) => item.projectId === 'brand-refresh' && item.teamId === 'design-team',
    )

    expect(filterProjectDirectoryRows(rows, {
      assigneeId: 'mika',
      query: 'mika',
      quickAccessOnly: true,
      status: 'active',
      teamId: 'design-team',
    }).map((row) => row.projectId)).toEqual(['brand-refresh'])

    expect(filterProjectDirectoryRows(rows, {
      assigneeId: PROJECT_DIRECTORY_UNASSIGNED_ID,
      query: 'refero',
      quickAccessOnly: false,
      status: 'not-started',
      teamId: 'core-team',
    }).map((row) => row.projectId)).toEqual(['refero'])
  })

  test('collects unique assignee options and recognizes unassigned Projects', () => {
    const rows = createProjectDirectoryRows(projectDirectoryFixtures, [
      createTask({
        assignedProjectId: 'refero',
        assigneeName: 'Zed',
        assigneeUserId: 'zed',
        id: 'zed-1',
        teamId: 'core-team',
      }),
      createTask({
        assignedProjectId: 'product-roadmap',
        assigneeName: 'Zed',
        assigneeUserId: 'zed',
        id: 'zed-2',
        teamId: 'core-team',
      }),
    ])
    const options = createProjectDirectoryAssigneeOptions(rows)

    expect(options.assignees).toEqual([{ id: 'zed', label: 'Zed' }])
    expect(options.hasUnassignedProjects).toBe(true)
  })

  test('bounds the 20-by-20 acceptance fixture to fifty rows per page', () => {
    const rows = createProjectDirectoryRows(createLargeProjectDirectory(), [])
    const firstPage = paginateProjectDirectoryRows(rows, 1)
    const lastPage = paginateProjectDirectoryRows(rows, 999)

    expect(rows).toHaveLength(400)
    expect(firstPage).toMatchObject({ page: 1, pageCount: 8 })
    expect(firstPage.rows).toHaveLength(50)
    expect(lastPage).toMatchObject({ page: 8, pageCount: 8 })
    expect(lastPage.rows).toHaveLength(50)
  })

  test('parses only safe positive page values', () => {
    expect(parseProjectDirectoryPage('3')).toBe(3)
    expect(parseProjectDirectoryPage('0')).toBe(1)
    expect(parseProjectDirectoryPage('-2')).toBe(1)
    expect(parseProjectDirectoryPage('not-a-page')).toBe(1)
    expect(parseProjectDirectoryPage(undefined)).toBe(1)
  })

  test('parses status filters through the exhaustive lookup', () => {
    expect(parseProjectDirectoryStatusFilter('attention')).toBe('attention')
    expect(parseProjectDirectoryStatusFilter('unsupported')).toBe('all')
    expect(parseProjectDirectoryStatusFilter(null)).toBe('all')
  })
})
