import { afterEach, describe, expect, test } from 'bun:test'
import type { DocumentNode } from '@mukuroji/contracts'
import {
  DocumentSubtreeExportLimitError,
  exportDocumentSubtreeMarkdown,
} from '../src/documents/queries/documentSubtreeExport'
import {
  editableDocumentCapabilities,
  readOnlyDocumentCapabilities,
} from '../src/documents/fixtures'
import {
  buildSubtreeMarkdown,
  collectSubtreeEntries,
  demoteMarkdownHeadings,
  subtreeExportFileName,
} from '../src/documents/model/subtreeExport'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Builds a tree node fixture.
 *
 * @param overrides - Fields that differ from the default page node.
 * @returns Document tree node.
 */
function node(
  overrides: Partial<DocumentNode> & Pick<DocumentNode, 'id'>,
): DocumentNode {
  return {
    capabilities: editableDocumentCapabilities,
    childCount: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    createdByUserId: 'user',
    favorite: false,
    kind: 'page',
    position: '000010',
    revision: 1,
    schemaVersion: 1,
    scope: { type: 'workspace' },
    title: overrides.id,
    updatedAt: '2026-11-01T00:00:00.000Z',
    updatedByUserId: 'user',
    ...overrides,
  }
}

const tree: DocumentNode[] = [
  node({ id: 'specs', kind: 'folder', title: 'Specs' }),
  node({ id: 'b', parentId: 'specs', position: '000020', title: 'B' }),
  node({ id: 'a', parentId: 'specs', position: '000010', title: 'A' }),
  node({ id: 'a-1', parentId: 'a', title: 'A-1' }),
  node({
    archivedAt: '2026-11-02T00:00:00.000Z',
    id: 'old',
    parentId: 'specs',
    title: 'Old',
  }),
  node({ id: 'board', kind: 'whiteboard', parentId: 'specs', position: '000030' }),
  node({ id: 'other', title: 'Other root' }),
]

describe('collectSubtreeEntries', () => {
  test('walks visible active descendants depth-first in position order', () => {
    expect(
      collectSubtreeEntries('specs', tree).map(
        (entry) => `${entry.depth}:${entry.node.id}`,
      ),
    ).toEqual(['0:specs', '1:a', '2:a-1', '1:b', '1:board'])
  })

  test('returns nothing when the root is not in the permission-filtered tree', () => {
    expect(collectSubtreeEntries('hidden', tree)).toEqual([])
  })
})

describe('demoteMarkdownHeadings', () => {
  test('demotes headings outside code fences and caps at h6', () => {
    expect(
      demoteMarkdownHeadings(
        ['# Title', 'text #1', '```', '# not a heading', '```', '##### deep'].join('\n'),
        2,
      ),
    ).toBe(
      ['### Title', 'text #1', '```', '# not a heading', '```', '###### deep'].join('\n'),
    )
  })
})

describe('buildSubtreeMarkdown', () => {
  test('nests page headings under folder headings by depth', () => {
    const entries = collectSubtreeEntries('specs', tree)
    const markdown = buildSubtreeMarkdown(
      entries.map((entry) =>
        entry.node.kind === 'page'
          ? { ...entry, markdown: `# ${entry.node.title}\n\nBody\n` }
          : entry,
      ),
    )
    expect(markdown).toBe(
      '# Specs\n\n## A\n\nBody\n\n### A-1\n\nBody\n\n## B\n\nBody\n\n## board\n',
    )
  })
})

describe('buildSubtreeMarkdown title escaping', () => {
  test('escapes Markdown and HTML punctuation in heading-only titles', () => {
    expect(
      buildSubtreeMarkdown([
        { depth: 0, node: node({ id: 'f', kind: 'folder', title: 'API <T> *v1*' }) },
      ]),
    ).toBe('# API \\<T\\> \\*v1\\*\n')
  })
})

describe('subtreeExportFileName', () => {
  test('replaces unsafe characters', () => {
    expect(subtreeExportFileName('設計/書: v1')).toBe('設計_書_ v1.md')
    expect(subtreeExportFileName('  ')).toBe('documents.md')
  })
})

describe('exportDocumentSubtreeMarkdown', () => {
  test('pages through the tree and exports only pages the user may export', async () => {
    const nodes = [
      node({ id: 'root', kind: 'folder', title: 'Root' }),
      node({ id: 'p1', parentId: 'root', title: 'P1' }),
      node({
        capabilities: { ...readOnlyDocumentCapabilities, canExport: false },
        id: 'p2',
        parentId: 'root',
        position: '000020',
        title: 'P2',
      }),
    ]
    const requested: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'http://localhost',
      )
      requested.push(`${url.pathname}${url.search}`)
      if (url.pathname.endsWith('/export')) {
        return Response.json({
          content: '# P1\n\nHello\n',
          delivery: 'inline',
          fileName: 'P1.md',
          format: 'markdown',
          mimeType: 'text/markdown; charset=utf-8',
        })
      }
      return url.searchParams.get('cursor')
        ? Response.json({ nodes: nodes.slice(2) })
        : Response.json({ nextCursor: 'next', nodes: nodes.slice(0, 2) })
    }) as typeof fetch

    const result = await exportDocumentSubtreeMarkdown('token', {
      id: 'root',
      scope: { type: 'workspace' },
      title: 'Root',
    })

    expect(result).toEqual({
      content: '# Root\n\n## P1\n\nHello\n\n## P2\n',
      fileName: 'Root.md',
      pageCount: 1,
    })
    expect(requested.filter((path) => path.includes('/export'))).toEqual([
      '/api/documents/p1/export?format=markdown',
    ])
  })
  test('rejects instead of returning an incomplete export', async () => {
    globalThis.fetch = (async () =>
      Response.json({ nextCursor: 'more', nodes: [] })) as typeof fetch
    await expect(
      exportDocumentSubtreeMarkdown('token', {
        id: 'root',
        scope: { type: 'workspace' },
        title: 'Root',
      }),
    ).rejects.toBeInstanceOf(DocumentSubtreeExportLimitError)
  })

  test('rejects a root that is not in the active tree', async () => {
    globalThis.fetch = (async () => Response.json({ nodes: [] })) as typeof fetch
    await expect(
      exportDocumentSubtreeMarkdown('token', {
        id: 'archived',
        scope: { type: 'workspace' },
        title: 'Archived',
      }),
    ).rejects.toBeInstanceOf(DocumentSubtreeExportLimitError)
  })
})
