import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkspaceSearchResult } from '@mukuroji/contracts'
import { documentSummaryFixtures } from '../src/documents/fixtures'
import {
  createDocumentRelationTargetKey,
  hasDocumentLevelRelationTo,
  parseDocumentLinkTargetQuery,
  toDocumentLinkTargetOptions,
} from '../src/documents/model/linkTargets'
import { DocumentRelationTargetPicker } from '../src/documents/ui/DocumentLinkPicker'
import { getProjectDocumentsPage } from '../src/documents/queries/projectDocumentsLoader'
import { RelatedDocuments } from '../src/documents/ui/RelatedDocuments'
import { WhiteboardCanvas } from '../src/documents/ui/WhiteboardCanvas'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('ja')

/**
 * Builds a Workspace search result with only the fields the link picker reads.
 *
 * @param result - Fields that differ between results.
 * @returns A complete search result.
 */
function searchResult(
  result: Pick<WorkspaceSearchResult, 'entityType' | 'id' | 'title'> &
    Partial<WorkspaceSearchResult>,
): WorkspaceSearchResult {
  return {
    highlights: [],
    url: '/',
    ...result,
  }
}

describe('Document link targets', () => {
  test('turns permission-filtered search results into link candidates of the chosen kind', () => {
    const results = [
      searchResult({
        entityType: 'work-item',
        id: 'team/core/issue/issue-1',
        status: 'started',
        subtitle: 'CORE-1',
        title: '議事録の確認',
      }),
      searchResult({
        entityType: 'work-item',
        id: 'not-canonical',
        title: 'Legacy',
      }),
      searchResult({
        entityType: 'project',
        id: 'project-1',
        title: '基盤刷新',
      }),
      searchResult({
        entityType: 'work-item',
        id: 'team/core/issue/issue-1',
        title: 'Duplicate',
      }),
    ]

    expect(toDocumentLinkTargetOptions('work-item', results)).toEqual([{
      status: 'started',
      subtitle: 'CORE-1',
      target: {
        kind: 'work-item',
        workItemId: 'team/core/issue/issue-1',
      },
      title: '議事録の確認',
    }])
    expect(toDocumentLinkTargetOptions('project', results)).toEqual([{
      target: { kind: 'project', projectId: 'project-1' },
      title: '基盤刷新',
    }])
  })

  test('accepts a canonical ID typed into the picker as a fallback', () => {
    expect(
      parseDocumentLinkTargetQuery('work-item', ' team/core/issue/issue-9 '),
    ).toEqual({
      kind: 'work-item',
      workItemId: 'team/core/issue/issue-9',
    })
    expect(parseDocumentLinkTargetQuery('work-item', 'issue-9')).toBeUndefined()
    expect(parseDocumentLinkTargetQuery('goal', 'goal-1')).toEqual({
      goalId: 'goal-1',
      kind: 'goal',
    })
    expect(parseDocumentLinkTargetQuery('project', 'a/b')).toBeUndefined()
    expect(parseDocumentLinkTargetQuery('project', 'two words')).toBeUndefined()
    expect(
      createDocumentRelationTargetKey({ kind: 'project', projectId: 'p-1' }),
    ).toBe('project:p-1')
  })
})

describe('Existing Document links', () => {
  test('counts only a page-level link to the same target as already linked', () => {
    const target = { kind: 'project', projectId: 'project-1' } as const
    const relation = {
      createdAt: '2026-11-19T00:00:00.000Z',
      createdByUserId: 'user-1',
      id: 'relation-1',
      target,
    }

    expect(hasDocumentLevelRelationTo([
      { ...relation, source: { kind: 'document' } },
    ], target)).toBe(true)
    expect(hasDocumentLevelRelationTo([
      { ...relation, source: { blockId: 'block-1', kind: 'block' } },
    ], target)).toBe(false)
    expect(hasDocumentLevelRelationTo([
      { ...relation, source: { kind: 'document' } },
    ], { kind: 'project', projectId: 'project-2' })).toBe(false)
  })
})

describe('Document link UI', () => {
  test('offers a search box instead of Team and Issue ID fields', () => {
    const html = renderToStaticMarkup(
      <DocumentRelationTargetPicker
        accessToken="token"
        onSelect={async () => {}}
        t={t}
      />,
    )

    expect(html).toContain('aria-label="リンク先を検索"')
    expect(html).toContain('placeholder="タイトルやキーで検索"')
    expect(html).not.toContain('チーム ID')
  })

  test('hides the kind selector when only Work Items can be chosen', () => {
    const html = renderToStaticMarkup(
      <DocumentRelationTargetPicker
        kinds={['work-item']}
        onSelect={async () => {}}
        t={t}
      />,
    )

    expect(html).not.toContain('<select')
  })

  test('lets a Work Item link an existing Document or create one', () => {
    const html = renderToStaticMarkup(
      <RelatedDocuments
        accessToken="token"
        t={t}
        targetId="team/core/issue/issue-1"
        targetKind="work-item"
      />,
    )

    expect(html).toContain('既存のドキュメントをリンク')
    expect(html).toContain('新しいドキュメントを作成')
  })

  test('shows the stored Work Item ID on a public Whiteboard card without reading it', () => {
    const html = renderToStaticMarkup(
      <WhiteboardCanvas
        content={{
          connectors: [],
          frames: [],
          objects: [{
            bounds: { height: 100, width: 200, x: 0, y: 0 },
            id: 'object-1',
            type: 'work-item',
            workItemId: 'team/core/issue/issue-1',
            zIndex: 0,
          }],
        }}
        editable={false}
        onDeleteConnector={() => {}}
        onDeleteFrame={() => {}}
        onDeleteObject={() => {}}
        onUpsertConnector={() => {}}
        onUpsertFrame={() => {}}
        onUpsertObject={() => {}}
        t={t}
      />,
    )

    expect(html).toContain('team/core/issue/issue-1')
  })
})

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Project Documents page', () => {
  test('keeps the continuation cursor when every tree page is still filtered out', async () => {
    const urls: URL[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        'https://app.example.test',
      )
      urls.push(url)
      return Response.json({
        nodes: [],
        nextCursor: `cursor-${urls.length}`,
      })
    }) as typeof fetch

    const page = await getProjectDocumentsPage('token', 'project-1')

    expect(page).toEqual({ documents: [], nextCursor: 'cursor-5' })
    expect(urls).toHaveLength(5)
    expect(urls[0]?.searchParams.get('scope')).toBe('project')
    expect(urls[0]?.searchParams.get('projectId')).toBe('project-1')
    expect(urls[1]?.searchParams.get('cursor')).toBe('cursor-1')

    urls.length = 0
    globalThis.fetch = (async () =>
      Response.json({ nodes: documentSummaryFixtures.slice(0, 1) })
    ) as typeof fetch
    await expect(
      getProjectDocumentsPage('token', 'project-1', 'cursor-5'),
    ).resolves.toEqual({ documents: documentSummaryFixtures.slice(0, 1) })
  })
})
