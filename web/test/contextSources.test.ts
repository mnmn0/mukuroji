import { describe, expect, test } from 'bun:test'
import { curatedContextItemFixtures } from '../src/issues/fixtures'
import {
  createIssueSourceAnchorId,
  createIssueSourceEntries,
  readIssueSourceKind,
  resolveIssueSourceFocus,
} from '../src/issues/model/contextSources'

describe('curated context sources', () => {
  test('retains every item snapshot when two items reference the same source', () => {
    const sourceItem = curatedContextItemFixtures.find((item) => item.source)
    if (!sourceItem?.source) throw new Error('Missing source fixture.')
    const entries = createIssueSourceEntries([
      {
        ...sourceItem,
        id: 'older-high-revision',
        revision: 99,
        updatedAt: '2026-08-08T00:00:00.000Z',
      },
      {
        ...sourceItem,
        id: 'newer-low-revision',
        revision: 1,
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
    ])

    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.item.id)).toEqual([
      'older-high-revision',
      'newer-low-revision',
    ])
  })

  test('keeps DOM anchors unique for distinct item snapshots', () => {
    expect(
      createIssueSourceAnchorId('context-one'),
    ).not.toBe(
      createIssueSourceAnchorId('context-two'),
    )
  })

  test('validates optional source-kind route state', () => {
    expect(readIssueSourceKind('document')).toBe('document')
    expect(readIssueSourceKind('unknown')).toBeUndefined()
    expect(readIssueSourceKind(null)).toBeUndefined()
  })

  test('prioritizes a coherent in-panel source target over a stale route kind', () => {
    expect(
      resolveIssueSourceFocus(
        {
          kind: 'comment',
        },
        {
          contextItemId: 'selected-item',
          kind: 'document',
          sourceId: 'selected-source',
        },
      ),
    ).toEqual({
      contextItemId: 'selected-item',
      kind: 'document',
      sourceId: 'selected-source',
    })
  })

  test('prioritizes a newly routed source target over an older in-panel selection', () => {
    expect(
      resolveIssueSourceFocus(
        {
          contextItemId: 'route-item',
          kind: 'comment',
          sourceId: 'route-source',
        },
        {
          contextItemId: 'selected-item',
          kind: 'document',
          sourceId: 'selected-source',
        },
      ),
    ).toEqual({
      contextItemId: 'route-item',
      kind: 'comment',
      sourceId: 'route-source',
    })
  })
})
