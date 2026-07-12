import { describe, expect, test } from 'bun:test'
import type { SearchViewLayout, WorkspaceSearchResult } from '@mukuroji/contracts'
import { sortWorkspaceSearchResults } from '../src/search/sortResults'
import {
  deduplicateSearchMigrationWarnings,
  getSearchColumns,
  getSearchCustomFields,
  getSearchDateField,
  getSearchEntityTypes,
  getSearchGroup,
  getSearchKeyword,
  getSearchLayoutMode,
  getSearchSort,
  getSearchStatuses,
  parseSearchRouteState,
  serializeSearchRouteState,
} from '../src/search/queryState'

describe('Workspace search URL state', () => {
  test('migration warnings keep first-seen order without duplicates', () => {
    expect(deduplicateSearchMigrationWarnings(
      ['URL schema migrated', 'Deleted field: risk'],
      ['Deleted field: risk', 'Deleted field: score'],
    )).toEqual([
      'URL schema migrated',
      'Deleted field: risk',
      'Deleted field: score',
    ])
  })

  test('keyword, filters, layout, sort, group, and columns round-trip canonically', () => {
    const source = new URLSearchParams(
      'q=launch&type=comment&type=work-item&status=review&assignee=demo%40example.com&creator=owner%40example.com&team=core-team&project=shared-launch&dateField=dueDate&dateFrom=2026-07-01&dateTo=2026-07-31&relation=blocks%3A42&customField=%7B%22fieldId%22%3A%22risk%22%2C%22operator%22%3A%22equals%22%2C%22value%22%3A%22high%22%7D&layout=board&sort=updatedAt%3Adesc&sort=title%3Aasc&sort=custom%3Arisk%3Aasc&group=status&columns=title%2Cstatus%2Cassignee&view=review-view&v=1',
    )
    const parsed = parseSearchRouteState(source)

    expect(getSearchKeyword(parsed.filters)).toBe('launch')
    expect(getSearchEntityTypes(parsed.filters)).toEqual(['comment', 'work-item'])
    expect(getSearchStatuses(parsed.filters)).toEqual(['review'])
    expect(getSearchCustomFields(parsed.filters)).toEqual([
      { fieldId: 'risk', operator: 'equals', value: 'high' },
    ])
    expect(getSearchDateField(parsed.filters)).toBe('dueDate')
    expect(getSearchLayoutMode(parsed.layout)).toBe('board')
    expect(getSearchSort(parsed.layout)).toBe('updatedAt:desc')
    expect(getSearchGroup(parsed.layout)).toBe('status')
    expect(getSearchColumns(parsed.layout)).toEqual(['title', 'status', 'assignee'])
    expect(parsed.savedViewId).toBe('review-view')

    const canonical = serializeSearchRouteState(parsed)
    const reparsed = parseSearchRouteState(canonical)

    expect(reparsed.filters).toEqual(parsed.filters)
    expect(reparsed.layout).toEqual(parsed.layout)
    expect(canonical.getAll('sort')).toEqual(['updatedAt:desc', 'title:asc', 'custom:risk:asc'])
    expect(canonical.getAll('type')).toEqual(['comment', 'work-item'])
  })

  test('unknown version and invalid custom field are reported without throwing', () => {
    const parsed = parseSearchRouteState(new URLSearchParams(
      'v=99&customField=%7Bnot-json&customField=%7B%22fieldId%22%3A%22risk%22%2C%22operator%22%3A%22equals%22%7D',
    ))

    expect(parsed.migrationWarnings).toHaveLength(2)
    expect(parsed.migrationWarnings[0]).toContain('v99')
    expect(getSearchCustomFields(parsed.filters)).toEqual([])
  })

  test('value-less custom field operators round-trip without invalid JSON', () => {
    const state = parseSearchRouteState(new URLSearchParams(
      'customField=%7B%22fieldId%22%3A%22risk%22%2C%22operator%22%3A%22is-empty%22%7D',
    ))
    const restored = parseSearchRouteState(serializeSearchRouteState(state))

    expect(getSearchCustomFields(restored.filters)).toEqual([
      { fieldId: 'risk', operator: 'is-empty' },
    ])
    expect(restored.migrationWarnings).toEqual([])
  })
})

describe('Workspace search result sorting', () => {
  const results = [
    createResult('z-result', 'work-item', '2026-07-10T00:00:00.000Z', 'review'),
    createResult('b-result', 'comment', '2026-07-12T00:00:00.000Z', 'todo'),
    createResult('a-result', 'comment', '2026-07-12T00:00:00.000Z', 'todo'),
    createResult('c-result', 'project', undefined, undefined),
  ]

  test('multi-sort uses rule order and deterministic entity/team/id tie-breakers', () => {
    const layout = createLayout([
      { field: 'updatedAt', direction: 'desc' },
    ])

    expect(sortWorkspaceSearchResults(results, layout).map((result) => result.id)).toEqual([
      'a-result',
      'b-result',
      'z-result',
      'c-result',
    ])
  })

  test('relevance preserves permission-aware API order', () => {
    const layout = createLayout([{ field: 'relevance', direction: 'desc' }])

    expect(sortWorkspaceSearchResults(results, layout).map((result) => result.id)).toEqual(
      results.map((result) => result.id),
    )
  })

  test('custom field sort reads the stored result value and keeps missing values last', () => {
    const customResults = [
      createResult('high-risk', 'work-item', undefined, undefined, { risk: 10 }),
      createResult('missing-risk', 'work-item'),
      createResult('low-risk', 'work-item', undefined, undefined, { risk: 2 }),
    ]
    const prefixedLayout = createLayout([{ field: 'custom:risk', direction: 'asc' }])

    expect(sortWorkspaceSearchResults(customResults, prefixedLayout).map((result) => result.id)).toEqual([
      'low-risk',
      'high-risk',
      'missing-risk',
    ])
  })
})

function createLayout(sort: SearchViewLayout['sort']): SearchViewLayout {
  return {
    columns: ['title', 'type'],
    mode: 'table',
    sort,
  }
}

function createResult(
  id: string,
  entityType: WorkspaceSearchResult['entityType'],
  updatedAt?: string,
  status?: string,
  customFields?: WorkspaceSearchResult['customFields'],
): WorkspaceSearchResult {
  return {
    customFields,
    entityType,
    highlights: [],
    id,
    status,
    teamId: 'core-team',
    title: id,
    updatedAt,
    url: `/search/${id}`,
  }
}
