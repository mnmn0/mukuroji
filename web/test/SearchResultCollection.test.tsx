import { describe, expect, test } from 'bun:test'
import type { SearchViewLayout, WorkspaceSearchResult } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { SearchResultCollection } from '../src/search/ui/SearchResultCollection'

const tableLayout = {
  columns: ['title'],
  mode: 'table',
  sort: [{ direction: 'desc', field: 'relevance' }],
} satisfies SearchViewLayout

describe('SearchResultCollection', () => {
  test('falls back to the source field when highlight fragments are empty', () => {
    const result = {
      entityType: 'work-item',
      highlights: [{ field: 'title', fragments: [] }],
      id: 'launch-review',
      title: 'Workspace launch review',
      url: '/projects/refero/issues?teamId=core-team&issueId=launch-review',
    } satisfies WorkspaceSearchResult

    const html = renderToStaticMarkup(
      <SearchResultCollection
        layout={tableLayout}
        locale="en"
        onNavigate={() => undefined}
        results={[result]}
      />,
    )

    expect(html).toContain('Workspace launch review')
  })

  test('renders custom field columns for every supported value type', () => {
    const html = renderToStaticMarkup(
      <SearchResultCollection
        layout={{
          ...tableLayout,
          columns: ['title', 'custom:risk', 'approved', 'tags', 'empty'],
        }}
        locale="en"
        onNavigate={() => undefined}
        results={[createResult('launch-review', {
          approved: false,
          empty: null,
          risk: 8,
          tags: ['web', 'mobile'],
        })]}
      />,
    )

    expect(html).toContain('>risk<')
    expect(html).toContain('>8<')
    expect(html).toContain('>false<')
    expect(html).toContain('>web, mobile<')
    expect(html).toContain('>—<')
  })

  test('groups board results by custom field values and keeps missing values separate', () => {
    const html = renderToStaticMarkup(
      <SearchResultCollection
        layout={{
          columns: ['title'],
          groupBy: 'custom:risk',
          mode: 'board',
          sort: [{ direction: 'desc', field: 'relevance' }],
        }}
        locale="en"
        onNavigate={() => undefined}
        results={[
          createResult('high-risk', { risk: 'High' }),
          createResult('low-risk', { risk: 'Low' }),
          createResult('missing-risk'),
        ]}
      />,
    )

    expect(html).toContain('>High<')
    expect(html).toContain('>Low<')
    expect(html).toContain('>—<')
  })

  test('renders configured names for dynamic workflow statuses', () => {
    const html = renderToStaticMarkup(
      <SearchResultCollection
        layout={{ ...tableLayout, columns: ['title', 'status'] }}
        locale="en"
        onNavigate={() => undefined}
        results={[{
          ...createResult('qa-ready'),
          status: 'ready-for-qa',
        }]}
        statusLabels={{ 'ready-for-qa': 'Ready for QA' }}
      />,
    )

    expect(html).toContain('>Ready for QA<')
    expect(html).not.toContain('>ready-for-qa<')
  })

  test('disables result navigation while an AI operation is pending', () => {
    const html = renderToStaticMarkup(
      <SearchResultCollection
        isAiOperationPending
        layout={tableLayout}
        locale="en"
        onNavigate={() => undefined}
        results={[createResult('pending-review')]}
      />,
    )

    expect(html).toContain('disabled=""')
  })

  test('localizes context-item kind subtitles when no body is available', () => {
    const html = renderToStaticMarkup(
      <SearchResultCollection
        layout={tableLayout}
        locale="ja"
        onNavigate={() => undefined}
        results={[{
          entityType: 'context-item',
          highlights: [],
          id: 'decision-1',
          subtitle: 'decision',
          title: 'リリース判断',
          url: '/teams/core-team/issues?issueId=issue-1&contextItemId=decision-1',
        }]}
      />,
    )

    expect(html).toContain('判断')
    expect(html).not.toContain('>decision<')
  })
})

function createResult(
  id: string,
  customFields?: WorkspaceSearchResult['customFields'],
): WorkspaceSearchResult {
  return {
    customFields,
    entityType: 'work-item',
    highlights: [],
    id,
    title: id,
    url: `/teams/core-team/issues?issueId=${id}`,
  }
}
