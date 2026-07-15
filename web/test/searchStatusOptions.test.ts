import { describe, expect, test } from 'bun:test'
import type { ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import { createSearchStatusOptions } from '../src/search/statusOptions'

describe('Workspace search status options', () => {
  test('uses configured dynamic statuses and merges names for a shared status ID', () => {
    const options = createSearchStatusOptions({
      alpha: createResolvedConfiguration('alpha', [
        { id: 'triage', name: 'Triage', sortOrder: 0 },
        { id: 'ready-for-qa', name: 'Ready for QA', sortOrder: 1 },
      ]),
      beta: createResolvedConfiguration('beta', [
        { id: 'ready-for-qa', name: 'QA ready', sortOrder: 0 },
        { id: 'released', name: 'Released', sortOrder: 1 },
      ]),
    }, [])

    expect(options).toEqual([
      { id: 'triage', label: 'Triage' },
      { id: 'ready-for-qa', label: 'QA ready / Ready for QA' },
      { id: 'released', label: 'Released' },
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
): ResolvedWorkItemConfiguration {
  return {
    configuration: {
      customFields: [],
      revision: 1,
      schemaVersion: 1,
      scopeId: teamId,
      scopeType: 'team',
      workflow: {
        id: `${teamId}-workflow`,
        initialStatusId: statuses[0]?.id ?? 'todo',
        name: `${teamId} workflow`,
        statuses: statuses.map((status) => ({
          ...status,
          category: 'unstarted',
        })),
        transitions: [],
      },
    },
  }
}
