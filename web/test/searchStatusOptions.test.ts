import { describe, expect, test } from 'bun:test'
import {
  createSearchWorkItemStatusKey,
  DEFAULT_WORK_ITEM_TYPE,
  type ResolvedWorkItemConfiguration,
  type WorkflowDefinition,
} from '@mukuroji/contracts'
import { createSearchStatusOptions } from '../src/search/model/statusOptions'

describe('Workspace search status options', () => {
  test('qualifies configured statuses by Team and Work Item Type', () => {
    const options = createSearchStatusOptions({
      alpha: createResolvedConfiguration('alpha', [
        { id: 'triage', name: 'Triage', sortOrder: 0 },
        { id: 'ready-for-qa', name: 'Ready for QA', sortOrder: 1 },
      ]),
      beta: createResolvedConfiguration('beta', [
        { id: 'ready-for-qa', name: 'QA ready', sortOrder: 0 },
        { id: 'released', name: 'Released', sortOrder: 1 },
      ]),
    }, [], { alpha: 'Alpha', beta: 'Beta' })

    expect(options).toEqual([
      {
        id: createSearchWorkItemStatusKey('alpha', DEFAULT_WORK_ITEM_TYPE.id, 'triage'),
        label: 'Alpha · Work Item · Triage',
      },
      {
        id: createSearchWorkItemStatusKey('alpha', DEFAULT_WORK_ITEM_TYPE.id, 'ready-for-qa'),
        label: 'Alpha · Work Item · Ready for QA',
      },
      {
        id: createSearchWorkItemStatusKey('beta', DEFAULT_WORK_ITEM_TYPE.id, 'ready-for-qa'),
        label: 'Beta · Work Item · QA ready',
      },
      {
        id: createSearchWorkItemStatusKey('beta', DEFAULT_WORK_ITEM_TYPE.id, 'released'),
        label: 'Beta · Work Item · Released',
      },
    ])
  })

  test('keeps statuses with the same ID separate across Work Item Types', () => {
    const options = createSearchStatusOptions({
      alpha: createResolvedConfiguration('alpha', [], {
        types: [
          { id: 'bug', name: 'Bug', statuses: [{ id: 'ready', name: 'Ready', sortOrder: 0 }] },
          { id: 'feature', name: 'Feature', statuses: [{ id: 'ready', name: 'Ready for build', sortOrder: 0 }] },
        ],
      }),
    }, [])

    expect(options.map((option) => option.id)).toEqual([
      createSearchWorkItemStatusKey('alpha', 'bug', 'ready'),
      createSearchWorkItemStatusKey('alpha', 'feature', 'ready'),
    ])
    expect(options.map((option) => option.label)).toEqual([
      'alpha · Bug · Ready',
      'alpha · Feature · Ready for build',
    ])
  })

  test('keeps a legacy bare status visible when restoring an older Search URL', () => {
    const options = createSearchStatusOptions({
      alpha: createResolvedConfiguration('alpha', [
        { id: 'ready', name: 'Ready', sortOrder: 0 },
      ]),
    }, ['ready'])

    expect(options.map((option) => option.id)).toEqual([
      createSearchWorkItemStatusKey('alpha', DEFAULT_WORK_ITEM_TYPE.id, 'ready'),
      'ready',
    ])
  })

  test('keeps URL and result statuses visible when their configuration is unavailable', () => {
    expect(createSearchStatusOptions({}, ['blocked.external', 'ready-for-qa'])).toEqual([
      { id: 'blocked.external', label: 'blocked.external' },
      { id: 'ready-for-qa', label: 'ready-for-qa' },
    ])
  })
})

function createResolvedConfiguration(
  teamId: string,
  statuses: Array<{ id: string; name: string; sortOrder: number }>,
  options: {
    types?: Array<{
      id: string
      name: string
      statuses: Array<{ id: string; name: string; sortOrder: number }>
    }>
  } = {},
): ResolvedWorkItemConfiguration {
  const workflows: WorkflowDefinition[] = [
    {
      id: `${teamId}-workflow`,
      initialStatusId: statuses[0]?.id ?? 'todo',
      name: `${teamId} workflow`,
      statuses: statuses.map((status) => ({
        ...status,
        category: 'unstarted',
      })),
      transitions: [],
    },
    ...(options.types ?? []).map((type) => ({
      id: `${teamId}-${type.id}-workflow`,
      initialStatusId: type.statuses[0]?.id ?? 'todo',
      name: `${type.name} workflow`,
      statuses: type.statuses.map((status) => ({
        ...status,
        category: 'unstarted',
      })),
      transitions: [],
    })),
  ]

  const workflow = workflows[0]
  if (!workflow) throw new Error('Expected a base workflow.')

  return {
    configuration: {
      customFields: [],
      revision: 1,
      schemaVersion: 1,
      scopeId: teamId,
      scopeType: 'team',
      workflow,
      ...(options.types ? {
        workItemTypes: options.types.map((type, index) => ({
          ...DEFAULT_WORK_ITEM_TYPE,
          defaultWorkflowId: `${teamId}-${type.id}-workflow`,
          id: type.id,
          name: type.name,
          sortOrder: index,
        })),
      } : {}),
      ...(workflows.length > 1 ? { workflows } : {}),
    },
  }
}
