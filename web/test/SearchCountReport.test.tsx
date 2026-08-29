import { describe, expect, test } from 'bun:test'
import type { WorkspaceSearchResult } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createLoadedSearchCountReport } from '../src/search/model/searchCountReport'
import { SearchCountReport } from '../src/search/ui/SearchCountReport'

const results = [
  createResult('launch-1', 'core-team'),
  createResult('launch-2', 'core-team'),
  createResult('launch-3', undefined),
]

describe('approved Search count report', () => {
  test('counts only loaded results and groups them through the existing layout field alias', () => {
    expect(createLoadedSearchCountReport(results, 'team', true)).toEqual({
      groups: [
        { count: 2, value: 'core-team' },
        { count: 1, value: undefined },
      ],
      isComplete: false,
      loadedCount: 3,
    })
  })

  test('visibly marks a cursor-backed count as partial', () => {
    const html = renderToStaticMarkup(
      <SearchCountReport
        groupBy="team"
        hasMore
        results={results}
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('Search count report')
    expect(html).toContain('3 currently loaded results')
    expect(html).toContain('Group by Team ID')
    expect(html).toContain('includes only the results loaded in this view')
    expect(html).toContain('core-team')
    expect(html).toContain('Not set')
  })

  test('shows a complete count only when the Search response has no next cursor', () => {
    const html = renderToStaticMarkup(
      <SearchCountReport
        hasMore={false}
        results={results}
        t={createTranslator('en')}
      />,
    )

    expect(html).toContain('3 matching results')
    expect(html).not.toContain('currently loaded')
  })
})

/** Creates one permission-filtered Search result for count report tests. */
function createResult(id: string, teamId: string | undefined): WorkspaceSearchResult {
  return {
    entityType: 'work-item',
    highlights: [],
    id,
    teamId,
    title: id,
    url: `/work-items/${id}`,
  }
}
