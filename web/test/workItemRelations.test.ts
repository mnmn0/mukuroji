import { describe, expect, test } from 'bun:test'
import {
  type WorkItemRelationCandidate,
} from '../src/work-items/ui/WorkItemRelationsEditor'
import { resolveAvailableWorkItemRelationCandidates } from '../src/work-items/model/workItemRelations'

const candidates = [
  { id: 'issue-current', title: 'Current' },
  { id: 'issue-related', title: 'Alpha' },
  { id: 'issue-blocked', title: 'Beta' },
] satisfies readonly WorkItemRelationCandidate[]

describe('Work Item relation candidates', () => {
  test('excludes an existing target only for the selected relation type', () => {
    const relations = [
      {
        sourceWorkItemId: 'issue-current',
        targetWorkItemId: 'issue-related',
        type: 'related' as const,
      },
      {
        sourceWorkItemId: 'issue-current',
        targetWorkItemId: 'issue-blocked',
        type: 'blocks' as const,
      },
    ]

    expect(resolveAvailableWorkItemRelationCandidates(
      candidates,
      'issue-current',
      relations,
      'related',
    )).toEqual([{ id: 'issue-blocked', title: 'Beta' }])
    expect(resolveAvailableWorkItemRelationCandidates(
      candidates,
      'issue-current',
      relations,
      'blocks',
    )).toEqual([{ id: 'issue-related', title: 'Alpha' }])
  })
})
