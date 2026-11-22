import { describe, expect, test } from 'bun:test'
import type {
  ApplyDocumentOperationsInput,
  CreateDocumentInput,
  DocumentBlock,
} from '@mukuroji/contracts'
import {
  hasImportPlaceholder,
  isImportableMarkdownPath,
  MARKDOWN_FOLDER_IMPORT_MAX_FILES,
  planMarkdownFolderImport,
  resolveImportedPageLinks,
  type MarkdownFolderFile,
  type MarkdownFolderImportPlan,
} from '../src/documents/model/markdownFolderImport'
import { convertMarkdownToDocument } from '../src/documents/model/markdownImport'
import {
  createMarkdownFolderImportProgress,
  runMarkdownFolderImport,
  type MarkdownFolderImportRequests,
} from '../src/documents/mutations/markdownFolderImportRunner'

/**
 * Returns sequential IDs so planned blocks are deterministic.
 *
 * @returns ID factory.
 */
function createSequentialId() {
  let next = 0
  return (prefix: string) => `${prefix}-${++next}`
}

/**
 * Plans a folder import, failing the test when planning fails.
 *
 * @param files - Markdown files of the folder.
 * @returns The plan.
 */
function plan(files: MarkdownFolderFile[]): MarkdownFolderImportPlan {
  const result = planMarkdownFolderImport(files, { createId: createSequentialId() })
  if (!result.ok) throw new Error(`planning failed: ${result.code}`)
  return result.plan
}

/**
 * Returns the blocks of a planned page with every link resolved, using
 * `id:<key>` as the ID of each page.
 *
 * @param planned - Folder import plan.
 * @param key - Page key.
 * @returns Resolved blocks.
 */
function resolvedBlocks(planned: MarkdownFolderImportPlan, key: string): DocumentBlock[] {
  const page = planned.pages.find((candidate) => candidate.key === key)
  if (!page) throw new Error(`missing page ${key}`)
  const ids = new Map(planned.pages.map((candidate) => [candidate.key, `id:${candidate.key}`]))
  return resolveImportedPageLinks(page.blocks, planned.placeholders, ids)
}

describe('folder Markdown import', () => {
  test('keeps the directory tree as folders and pages', () => {
    const planned = plan([
      { path: 'docs/guide/setup.md', source: '# Setup\n\nSteps.' },
      { path: 'docs/README.md', source: 'Overview' },
      { path: 'docs/guide/usage.md', source: '# Usage' },
    ])

    expect(planned.folders.map(({ key, parentKey, title }) => ({ key, parentKey, title }))).toEqual([
      { key: 'docs', parentKey: undefined, title: 'docs' },
      { key: 'docs/guide', parentKey: 'docs', title: 'guide' },
    ])
    expect(
      planned.pages
        .map(({ key, parentKey, title }) => ({ key, parentKey, title }))
        .sort((left, right) => (left.key < right.key ? -1 : 1)),
    ).toEqual([
      { key: 'docs/README.md', parentKey: 'docs', title: 'README' },
      { key: 'docs/guide/setup.md', parentKey: 'docs/guide', title: 'Setup' },
      { key: 'docs/guide/usage.md', parentKey: 'docs/guide', title: 'Usage' },
    ])
    expect(planned.rootKey).toBe('docs')
    const orders = [...planned.folders, ...planned.pages]
      .sort((left, right) => left.order - right.order)
      .map(({ key }) => key)
    expect(orders).toEqual([
      'docs',
      'docs/README.md',
      'docs/guide',
      'docs/guide/setup.md',
      'docs/guide/usage.md',
    ])
  })

  test('points relative links between files at the imported pages', () => {
    const planned = plan([
      {
        path: 'docs/README.md',
        source: [
          '# Docs',
          '',
          '[Setup](guide/setup.md)',
          '',
          'See [usage](./guide/usage.md#run) and [the site](https://example.com).',
          '',
          '- [ ] read [setup](guide/setup.md)',
          '',
          '| Page | Link |',
          '| --- | --- |',
          '| Guide | [guide](guide/) |',
          '',
          '[Missing](missing.md)',
        ].join('\n'),
      },
      { path: 'docs/guide/README.md', source: '# Guide\n\n[Back](../README.md)' },
      { path: 'docs/guide/setup.md', source: '# Setup' },
      { path: 'docs/guide/usage.md', source: '# Usage\n\n`[code](setup.md)` and \\[not](setup.md)' },
    ])

    expect(resolvedBlocks(planned, 'docs/README.md')).toMatchObject([
      { type: 'embed', url: '/documents/id%3Adocs%2Fguide%2Fsetup.md', title: 'Setup' },
      {
        type: 'paragraph',
        text: 'See [usage](/documents/id%3Adocs%2Fguide%2Fusage.md) and [the site](https://example.com).',
      },
      { type: 'checklist', items: [{ text: 'read [setup](/documents/id%3Adocs%2Fguide%2Fsetup.md)' }] },
      {
        type: 'table',
        rows: [{ cells: [{ text: 'Guide' }, { text: '[guide](/documents/id%3Adocs%2Fguide%2FREADME.md)' }] }],
      },
      { type: 'paragraph', text: '[Missing](missing.md)' },
    ])
    expect(resolvedBlocks(planned, 'docs/guide/README.md')).toMatchObject([
      { type: 'embed', url: '/documents/id%3Adocs%2FREADME.md', title: 'Back' },
    ])
    expect(resolvedBlocks(planned, 'docs/guide/usage.md')).toMatchObject([
      { type: 'paragraph', text: '`[code](setup.md)` and [not](setup.md)' },
    ])
  })

  test('creates linked pages first and leaves links in cycles for later', () => {
    const planned = plan([
      { path: 'a.md', source: '[B](b.md)' },
      { path: 'b.md', source: '[C](c.md)' },
      { path: 'c.md', source: '[A](a.md)' },
    ])

    expect(planned.pages.map(({ key }) => key)).toEqual(['c.md', 'b.md', 'a.md'])
    expect(planned.rootKey).toBeUndefined()

    const ids = new Map<string, string>()
    const created = new Map<string, DocumentBlock[]>()
    for (const page of planned.pages) {
      created.set(page.key, resolveImportedPageLinks(page.blocks, planned.placeholders, ids))
      ids.set(page.key, `id-${page.key}`)
    }
    const pending = [...created].filter(([, blocks]) =>
      blocks.some((block) => hasImportPlaceholder(block, planned.placeholders)),
    )
    expect(pending.map(([key]) => key)).toEqual(['c.md'])
    expect(
      resolveImportedPageLinks(created.get('c.md') ?? [], planned.placeholders, ids),
    ).toMatchObject([{ type: 'embed', url: '/documents/id-a.md' }])
  })

  test('reports the file that cannot become a page and creates nothing', () => {
    const result = planMarkdownFolderImport(
      [
        { path: 'docs/a.md', source: '# A' },
        { path: 'docs/empty.md', source: '  \n' },
      ],
      { createId: createSequentialId() },
    )

    expect(result).toEqual({ ok: false, code: 'empty', path: 'docs/empty.md' })
  })

  test('rejects an empty selection, too many files, and too deep a tree', () => {
    const createId = createSequentialId()
    expect(planMarkdownFolderImport([], { createId })).toEqual({
      ok: false,
      code: 'no-markdown-files',
    })
    const many = Array.from({ length: MARKDOWN_FOLDER_IMPORT_MAX_FILES + 1 }, (_, index) => ({
      path: `docs/${index}.md`,
      source: 'x',
    }))
    expect(planMarkdownFolderImport(many, { createId })).toEqual({
      ok: false,
      code: 'too-many-files',
    })
    const deep = `${Array.from({ length: 32 }, (_, index) => `d${index}`).join('/')}/a.md`
    expect(planMarkdownFolderImport([{ path: deep, source: 'x' }], { createId })).toEqual({
      ok: false,
      code: 'too-deep',
      path: deep,
    })
  })

  test('imports Markdown files outside hidden directories and node_modules', () => {
    expect(isImportableMarkdownPath('docs/a.md')).toBe(true)
    expect(isImportableMarkdownPath('docs/b.MARKDOWN')).toBe(true)
    expect(isImportableMarkdownPath('docs/c.txt')).toBe(false)
    expect(isImportableMarkdownPath('docs/.github/d.md')).toBe(false)
    expect(isImportableMarkdownPath('docs/node_modules/pkg/e.md')).toBe(false)
    expect(isImportableMarkdownPath('docs/.hidden.md')).toBe(false)
  })
})

describe('single-page Markdown links', () => {
  test('turns a paragraph that is only an HTTPS or application link into an embed', () => {
    const result = convertMarkdownToDocument(
      [
        '[Spec](https://example.com/spec)',
        '',
        '[Page](/documents/doc-1)',
        '',
        '[Plain](http://example.com)',
        '',
        '\\[Escaped\\](https://example.com)',
        '',
        '[Relative](other.md)',
      ].join('\n'),
      { createId: createSequentialId(), fallbackTitle: 'Links' },
    )

    expect(result.ok && result.blocks).toMatchObject([
      { type: 'embed', url: 'https://example.com/spec', title: 'Spec' },
      { type: 'embed', url: '/documents/doc-1', title: 'Page' },
      { type: 'paragraph', text: '[Plain](http://example.com)' },
      { type: 'paragraph', text: '[Escaped](https://example.com)' },
      { type: 'paragraph', text: '[Relative](other.md)' },
    ])
  })
})

describe('folder import runner', () => {
  test('creates parents first, links pages, and resumes after a failure', async () => {
    const planned = plan([
      { path: 'docs/a.md', source: '# A\n\n[B](b.md)' },
      { path: 'docs/b.md', source: '# B\n\n[A](a.md)' },
    ])
    const progress = createMarkdownFolderImportProgress({
      clientId: 'client-1',
      fingerprint: 'fp',
      plan: planned,
      positionBase: '2026-11-22T00:00:00.000Z',
      scope: { projectId: 'project-1', type: 'project' },
    })
    const created: CreateDocumentInput[] = []
    const operations: { documentId: string; input: ApplyDocumentOperationsInput }[] = []
    let failNextCreate = true
    const requests: MarkdownFolderImportRequests = {
      applyOperations: async (_key, _fingerprint, documentId, input) => {
        operations.push({ documentId, input })
        return { committedRevision: input.baseRevision + 1 }
      },
      create: async (_key, _fingerprint, input) => {
        if (input.kind === 'page' && failNextCreate) {
          failNextCreate = false
          throw new Error('network')
        }
        created.push(input)
        return { id: `id-${created.length}`, revision: 1 }
      },
    }

    await expect(runMarkdownFolderImport(progress, requests)).rejects.toThrow('network')
    await runMarkdownFolderImport(progress, requests)

    expect(created.map((input) => [input.kind, input.title, input.parentId])).toEqual([
      ['folder', 'docs', undefined],
      ['page', 'B', 'id-1'],
      ['page', 'A', 'id-1'],
    ])
    expect(created[0]).toMatchObject({
      position: '2026-11-22T00:00:00.000Z#0000',
      scope: { projectId: 'project-1', type: 'project' },
    })
    const pageA = created[2]
    expect(pageA?.kind === 'page' && pageA.blocks).toMatchObject([
      { type: 'embed', url: '/documents/id-2' },
    ])
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({
      documentId: 'id-2',
      input: {
        baseRevision: 1,
        clientId: 'client-1',
        operations: [{ type: 'update-block', block: { type: 'embed', url: '/documents/id-3' } }],
      },
    })

    await runMarkdownFolderImport(progress, requests)
    expect(created).toHaveLength(3)
    expect(operations).toHaveLength(1)
  })
})
