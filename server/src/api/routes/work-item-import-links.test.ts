import { expect, test } from 'bun:test'
import {
  DEFAULT_WORK_ITEM_TYPE,
  createDefaultDueDateWorkItemSchedule,
  type PlanningWorkItemSummary,
  type ResolvedWorkItemConfiguration,
  type WorkItemScheduleDependency,
} from '@mukuroji/contracts'
import { DEFAULT_WORK_ITEM_CONFIGURATION } from '../../modules/work-items/work-item-configuration'
import { findWorkItemDependencyScheduleConflicts } from '../../modules/planning'
import { validateWorkItemImportParentLinks } from './work-item-import-links'

const configuration: ResolvedWorkItemConfiguration = {
  configuration: {
    ...DEFAULT_WORK_ITEM_CONFIGURATION,
    workItemTypes: [
      { ...DEFAULT_WORK_ITEM_TYPE, id: 'epic', name: 'Epic', allowedChildTypeIds: ['task'], sortOrder: 0 },
      { ...DEFAULT_WORK_ITEM_TYPE, id: 'task', name: 'Task', allowedChildTypeIds: [], sortOrder: 1 },
    ],
  },
}

test('rejects a parent link that the Work Item Types do not allow', () => {
  const schedule = createDefaultDueDateWorkItemSchedule('2026-08-01')
  const errors = validateWorkItemImportParentLinks(
    configuration,
    [
      { kind: 'parent', childRow: 2, parentRow: 1 },
      { kind: 'parent', childRow: 3, parentRow: 2 },
    ],
    new Map([
      [1, { row: 1, workItemTypeId: 'epic', schedule }],
      [2, { row: 2, workItemTypeId: 'task', schedule }],
      [3, { row: 3, workItemTypeId: 'task', schedule }],
    ]),
  )

  expect(errors).toEqual([expect.objectContaining({ row: 3, field: 'parentKey', code: 'WorkItemChildTypeDenied' })])
})

test('finds the schedule conflicts that would reject an imported dependency', () => {
  const summary = (id: string, dueDate: string): PlanningWorkItemSummary => ({
    id,
    revision: 0,
    teamId: 'team-1',
    title: '',
    statusCategory: 'unstarted',
    dueDate: '',
    schedule: createDefaultDueDateWorkItemSchedule(dueDate),
  })
  const dependency: WorkItemScheduleDependency = {
    id: 'import-dry-run',
    predecessor: { teamId: 'team-1', workItemId: 'a' },
    successor: { teamId: 'team-1', workItemId: 'b' },
    type: 'finish-to-finish',
    lagDays: 2,
    createdAt: '',
    updatedAt: '',
  }

  expect(findWorkItemDependencyScheduleConflicts(dependency, summary('a', '2026-08-01'), summary('b', '2026-08-03')))
    .toEqual([])
  expect(findWorkItemDependencyScheduleConflicts(dependency, summary('a', '2026-08-01'), summary('b', '2026-08-02')))
    .toEqual([expect.objectContaining({ code: 'dependency-violation', requiredDate: '2026-08-03' })])
  expect(findWorkItemDependencyScheduleConflicts(
    { ...dependency, type: 'finish-to-start' },
    summary('a', '2026-08-01'),
    summary('b', '2026-08-09'),
  )).toEqual([expect.objectContaining({ code: 'missing-schedule' })])
})
