import { describe, expect, test } from 'bun:test'
import type { CanonicalWorkItem, ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import {
  createCrossProjectWorkItemBoardLane,
  createCrossProjectWorkItemGanttGrouping,
  createCrossProjectWorkItemJobRoleOptions,
  createCrossProjectWorkItemListSearchParams,
  createCrossProjectWorkItemMemberOptions,
  createCrossProjectWorkItemProjectOptions,
  createCrossProjectWorkItemServerFilter,
  defaultCrossProjectWorkItemListState,
  filterCrossProjectWorkItems,
  groupCrossProjectWorkItems,
  parseCrossProjectWorkItemListState,
  type CrossProjectWorkItemListState,
} from '../src/features/cross-project-work-items/model/crossProjectWorkItems'
import type { ProjectDirectoryTeam } from '../src/projects/api/directory'
import { taskViewStorySelectedTask } from '../src/tasks/ui/TaskView.stories.fixtures'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'

const teams: ProjectDirectoryTeam[] = [
  {
    id: 'core',
    name: 'Core',
    projects: [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' },
    ],
  },
  {
    id: 'ops',
    name: 'Ops',
    projects: [{ id: 'alpha', name: 'Ops Alpha' }],
  },
]

/**
 * Creates a Work Item based on the shared story fixture.
 *
 * @param overrides - Fields that differ from the fixture.
 * @returns A canonical Work Item.
 */
function createWorkItem(overrides: Partial<CanonicalWorkItem>): CanonicalWorkItem {
  return { ...taskViewStorySelectedTask, ...overrides }
}

const workItems: CanonicalWorkItem[] = [
  createWorkItem({ id: 'a1', teamId: 'core', assignedProjectId: 'alpha', title: 'A1', assigneeUserId: 'me@example.com', dueDate: '2026-12-02' }),
  createWorkItem({
    id: 'a2',
    teamId: 'core',
    assignedProjectId: 'alpha',
    title: 'A2',
    assigneeUserId: 'sato@example.com',
    dueDate: '2026-12-01',
    contributorAssignments: [
      { assignmentId: 'c1', memberUserId: 'me@example.com', jobRoleId: 'designer', status: 'planned' },
    ],
  }),
  createWorkItem({ id: 'b1', teamId: 'core', assignedProjectId: 'beta', title: 'B1', assigneeUserId: 'sato@example.com', statusCategory: 'completed', workflowStatusId: 'done' }),
  createWorkItem({
    id: 'o1',
    teamId: 'ops',
    assignedProjectId: 'alpha',
    title: 'O1',
    assigneeUserId: 'suzuki@example.com',
    contributorAssignments: [{ assignmentId: 'c2', jobRoleId: 'qa', status: 'planned' }],
  }),
  createWorkItem({ id: 'n1', teamId: 'core', assignedProjectId: undefined, title: 'N1', assigneeUserId: 'suzuki@example.com' }),
]

describe('cross-Project Work Item list state', () => {
  test('round-trips every filter through the URL', () => {
    const state: CrossProjectWorkItemListState = {
      projects: [
        { teamId: 'core', projectId: 'alpha' },
        { teamId: 'ops:x', projectId: 'a/b' },
      ],
      openOnly: false,
      mine: true,
      contributorMemberId: 'me@example.com',
      contributorJobRole: { teamId: 'core:x', jobRoleId: 'design/er' },
      grouping: 'assignee',
      layout: 'gantt',
    }
    const params = createCrossProjectWorkItemListSearchParams(state)
    expect(parseCrossProjectWorkItemListState(new URLSearchParams(params.toString()))).toEqual(state)
  })

  test('uses defaults and leaves them out of the URL', () => {
    expect(parseCrossProjectWorkItemListState(new URLSearchParams())).toEqual(defaultCrossProjectWorkItemListState)
    expect(createCrossProjectWorkItemListSearchParams(defaultCrossProjectWorkItemListState).toString()).toBe('')
  })

  test('ignores malformed and duplicate Project references', () => {
    const state = parseCrossProjectWorkItemListState(
      new URLSearchParams('project=core:alpha&project=core:alpha&project=broken&project=:x&project=%E0%A4%A:x&group=other'),
    )
    expect(state.projects).toEqual([{ teamId: 'core', projectId: 'alpha' }])
    expect(state.grouping).toBe('project')
  })

  test('reads the board and Gantt layouts and falls back to the table', () => {
    expect(parseCrossProjectWorkItemListState(new URLSearchParams('layout=board')).layout).toBe('board')
    expect(parseCrossProjectWorkItemListState(new URLSearchParams('layout=calendar')).layout).toBe('table')
  })
})

describe('createCrossProjectWorkItemServerFilter', () => {
  test('narrows the read to one Team and Project when possible', () => {
    expect(createCrossProjectWorkItemServerFilter({
      ...defaultCrossProjectWorkItemListState,
      projects: [{ teamId: 'core', projectId: 'alpha' }],
      mine: true,
    })).toEqual({ involvement: 'mine', openOnly: true, teamId: 'core', projectId: 'alpha' })
    expect(createCrossProjectWorkItemServerFilter({
      ...defaultCrossProjectWorkItemListState,
      projects: [{ teamId: 'core', projectId: 'alpha' }, { teamId: 'core', projectId: 'beta' }],
    })).toEqual({ openOnly: true, teamId: 'core' })
    expect(createCrossProjectWorkItemServerFilter({
      ...defaultCrossProjectWorkItemListState,
      openOnly: false,
      projects: [{ teamId: 'core', projectId: 'alpha' }, { teamId: 'ops', projectId: 'alpha' }],
    })).toEqual({})
  })
})

describe('filterCrossProjectWorkItems', () => {
  const ids = (state: Partial<CrossProjectWorkItemListState>) => filterCrossProjectWorkItems(
    workItems,
    { ...defaultCrossProjectWorkItemListState, ...state },
    ['me@example.com'],
  ).map((workItem) => workItem.id)

  test('keeps open Work Items of every readable Project by default', () => {
    expect(ids({})).toEqual(['a1', 'a2', 'o1', 'n1'])
    expect(ids({ openOnly: false })).toEqual(['a1', 'a2', 'b1', 'o1', 'n1'])
  })

  test('keeps only the selected Team-qualified Projects', () => {
    expect(ids({ projects: [{ teamId: 'core', projectId: 'alpha' }], openOnly: false })).toEqual(['a1', 'a2'])
    expect(ids({ projects: [{ teamId: 'ops', projectId: 'alpha' }, { teamId: 'core', projectId: 'beta' }], openOnly: false }))
      .toEqual(['b1', 'o1'])
  })

  test('filters by owner or contributor, contributor member, and job role', () => {
    expect(ids({ mine: true })).toEqual(['a1', 'a2'])
    expect(ids({ contributorMemberId: 'me@example.com' })).toEqual(['a2'])
    expect(ids({ contributorJobRole: { teamId: 'ops', jobRoleId: 'qa' } })).toEqual(['o1'])
    expect(ids({ contributorMemberId: 'me@example.com', contributorJobRole: { teamId: 'ops', jobRoleId: 'qa' } })).toEqual([])
  })

  test('matches a job role only within its own Team', () => {
    expect(ids({ contributorJobRole: { teamId: 'core', jobRoleId: 'designer' } })).toEqual(['a2'])
    expect(ids({ contributorJobRole: { teamId: 'ops', jobRoleId: 'designer' } })).toEqual([])
    expect(ids({ contributorJobRole: { teamId: 'core', jobRoleId: 'qa' } })).toEqual([])
  })
})

describe('groupCrossProjectWorkItems', () => {
  test('groups by Team-qualified Project with Work Items without a Project last', () => {
    const groups = groupCrossProjectWorkItems(workItems, 'project', teams)
    expect(groups.map((group) => [group.label, group.detail, group.workItems.map((workItem) => workItem.id)])).toEqual([
      ['Alpha', 'Core', ['a2', 'a1']],
      ['Beta', 'Core', ['b1']],
      ['Ops Alpha', 'Ops', ['o1']],
      ['', undefined, ['n1']],
    ])
    expect(groups.at(-1)?.isUnassigned).toBe(true)
  })

  test('groups by accountable owner', () => {
    const groups = groupCrossProjectWorkItems(workItems, 'assignee', teams)
    expect(groups.map((group) => [group.label, group.workItems.length])).toEqual([
      ['me@example.com', 1],
      ['sato@example.com', 2],
      ['suzuki@example.com', 2],
    ])
  })
})

describe('filter options', () => {
  test('lists readable Projects with Team-qualified keys', () => {
    expect(createCrossProjectWorkItemProjectOptions(teams).map((option) => [option.key, option.name])).toEqual([
      ['core:alpha', 'Alpha'],
      ['core:beta', 'Beta'],
      ['ops:alpha', 'Ops Alpha'],
    ])
  })

  test('lists contributor members with known labels and keeps the selected one', () => {
    expect(createCrossProjectWorkItemMemberOptions(
      workItems,
      new Map([['me@example.com', 'Me']]),
      'gone@example.com',
    )).toEqual([
      { id: 'gone@example.com', label: 'gone@example.com' },
      { id: 'me@example.com', label: 'Me' },
    ])
  })

  test('keeps job roles with the same ID in different Teams apart', () => {
    const configurationFor = (teamId: string, name: string): ResolvedWorkItemConfiguration => ({
      configuration: {
        scopeType: 'team',
        scopeId: teamId,
        schemaVersion: taskViewStorySelectedTask.workflowSchemaVersion,
        revision: 1,
        workflow: { id: 'default', name: 'Default', statuses: [], transitions: [] },
        customFields: [],
        jobRoles: [{ id: 'designer', name }],
      },
    })
    expect(createCrossProjectWorkItemJobRoleOptions(
      workItems,
      { core: configurationFor('core', 'Designer'), ops: configurationFor('ops', 'UX designer') },
      teams,
      { teamId: 'gone', jobRoleId: 'old' },
    ).map((option) => [option.key, option.name, option.teamName])).toEqual([
      ['core:designer', 'Designer', 'Core'],
      ['gone:old', 'old', 'gone'],
      ['ops:qa', 'qa', 'Ops'],
      ['ops:designer', 'UX designer', 'Ops'],
    ])
  })
})

describe('createCrossProjectWorkItemBoardLane', () => {
  test('shows every status of the Team and keeps Work Items without a column apart', () => {
    const configurationsByTeam: Record<string, ResolvedWorkItemConfiguration> = {
      core: { configuration: { ...teamWorkItemConfigurationFixture, scopeId: 'core' } },
    }
    const lane = createCrossProjectWorkItemBoardLane(
      [
        createWorkItem({ id: 'x1', teamId: 'core', workflowStatusId: 'active' }),
        createWorkItem({ id: 'x2', teamId: 'core', workflowStatusId: 'retired' }),
        createWorkItem({ id: 'x3', teamId: 'ops', workflowStatusId: 'active' }),
      ],
      configurationsByTeam,
      teams,
    )
    const active = lane.columns.find((column) => column.workItems.length > 0)
    expect(lane.columns.map((column) => column.label)).toContain('Core · Done')
    expect(active?.label).toBe('Core · In progress')
    expect(active?.workItems.map((workItem) => workItem.id)).toEqual(['x1'])
    expect(lane.unplacedWorkItems.map((workItem) => workItem.id)).toEqual(['x2', 'x3'])
  })
})

describe('createCrossProjectWorkItemGanttGrouping', () => {
  const labels = { noAssignee: 'No owner', noProject: 'No Project' }

  test('names Project groups with their Team and labels the unassigned group', () => {
    const grouping = createCrossProjectWorkItemGanttGrouping('project', teams, labels)
    expect(grouping.resolve(workItems[3]!)).toEqual({ key: 'project:ops:alpha', label: 'Ops Alpha · Ops' })
    expect(grouping.resolve(workItems[4]!)).toEqual({ key: 'project:', label: 'No Project' })
  })

  test('groups by owner', () => {
    const grouping = createCrossProjectWorkItemGanttGrouping('assignee', teams, labels)
    expect(grouping.resolve(createWorkItem({ assigneeUserId: undefined })).label).toBe('No owner')
    expect(grouping.resolve(workItems[0]!).key).toBe('assignee:me@example.com')
  })
})
