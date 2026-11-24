import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SWRConfig, unstable_serialize } from 'swr'
import type { DocumentComment } from '@mukuroji/contracts'
import { documentRecordFixture } from '../src/documents/fixtures'
import { replaceLoadedDocumentComment, resolveEditedDocumentMentions } from '../src/documents/model/comments'
import { useDocumentCommentChanges } from '../src/documents/mutations/useDocumentCommentChanges'
import { convertMarkdownToDocument } from '../src/documents/model/markdownImport'
import { DocumentContextPanel } from '../src/documents/ui/DocumentContextPanel'
import { DocumentEditor, DocumentReadOnlyContent } from '../src/documents/ui/DocumentEditor'
import { DocumentShareDialog } from '../src/documents/ui/DocumentShareDialog'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('en')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Builds the fixture page with the given blocks.
 *
 * @param blocks - Blocks of the page.
 * @returns A page Document.
 */
function createPage(blocks: Extract<typeof documentRecordFixture, { kind: 'page' }>['blocks']) {
  if (documentRecordFixture.kind !== 'page') throw new Error('Expected a page fixture.')
  return { ...documentRecordFixture, blocks }
}

const members = [
  { memberKey: 'owner@example.com', name: 'Owner Name', email: 'owner@example.com', status: 'active' },
  { memberKey: 'mina@example.com', name: 'Mina Sato', email: 'mina@example.com', status: 'active' },
]

/**
 * Builds a comment for the comments panel.
 *
 * @param overrides - Fields that differ from the default comment.
 * @returns The comment.
 */
function createComment(overrides: Partial<DocumentComment>): DocumentComment {
  return {
    id: 'comment-1',
    documentId: documentRecordFixture.id,
    anchor: { type: 'document' },
    body: 'Looks good',
    mentions: [],
    authorUserId: 'owner@example.com',
    resolved: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('Document editing and comments (#422)', () => {
  test('renders paragraph Markdown with lists, links, emphasis, and quotes and keeps raw HTML as text', () => {
    const html = renderToStaticMarkup(
      <DocumentReadOnlyContent
        document={createPage([{
          id: 'markdown',
          type: 'paragraph',
          text: '- first\n- [spec](https://example.com/spec)\n\n> **decided** <div>\n\nline one\nline two',
        }])}
        t={t}
      />,
    )

    expect(html).toContain('<ul>')
    expect(html).toContain('<li>first</li>')
    expect(html).toContain('href="https://example.com/spec"')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<strong>decided</strong>')
    expect(html).toContain('&lt;div&gt;')
    expect(html).not.toContain('<div>\n')
    expect(html).toContain('line one\nline two')
  })

  test('keeps Markdown escapes of an imported paragraph so escaped text renders literally', () => {
    let next = 0
    const imported = convertMarkdownToDocument('\\*literal\\* and **bold**', {
      createId: (prefix) => `${prefix}-${(next += 1)}`,
      fallbackTitle: 'Imported',
    })
    if (!imported.ok) throw new Error('The Markdown should import.')
    expect(imported.blocks).toMatchObject([{ type: 'paragraph', text: '\\*literal\\* and **bold**' }])

    const html = renderToStaticMarkup(
      <DocumentReadOnlyContent document={createPage(imported.blocks)} t={t} />,
    )
    expect(html).toContain('*literal* and <strong>bold</strong>')
    expect(html).not.toContain('<em>literal</em>')
  })

  test('replaces an edited or deleted comment in the focused thread cache', () => {
    const root = createComment({ id: 'root' })
    const reply = createComment({ id: 'reply', parentCommentId: 'root', body: 'Before' })
    const thread = [root, reply]
    const edited = { ...reply, body: 'After', editedAt: '2026-11-02T00:00:00.000Z' }
    const deleted = { ...reply, body: '', deletedAt: '2026-11-03T00:00:00.000Z' }

    expect(replaceLoadedDocumentComment(thread, edited)).toEqual([root, edited])
    expect(replaceLoadedDocumentComment(thread, deleted)).toEqual([root, deleted])
    // A thread without the comment, or one not read yet, is left as it is.
    expect(replaceLoadedDocumentComment([root], edited)).toEqual([root])
    expect(replaceLoadedDocumentComment(undefined, edited)).toBeUndefined()
  })

  test('keeps the stored mention of a renamed member when an unrelated part is edited', () => {
    // Mina was mentioned as "Mina Sato" and has since been renamed to "Mina Ito".
    const renamed = [
      ...members.filter(({ memberKey }) => memberKey !== 'mina@example.com'),
      { memberKey: 'mina@example.com', name: 'Mina Ito', email: 'mina@example.com', status: 'active' },
    ]
    const original = {
      body: 'Ask @Mina Sato about it',
      mentions: [{ userId: 'mina@example.com', offset: 4, length: 10 }],
    }

    expect(resolveEditedDocumentMentions(original, 'Please ask @Mina Sato about it today', ['mina@example.com'], renamed))
      .toEqual([{ userId: 'mina@example.com', offset: 11, length: 10 }])
    // A newly picked mention in the edited span is resolved with the current name.
    expect(resolveEditedDocumentMentions(original, 'Ask @Mina Sato and @Owner Name', ['mina@example.com', 'owner@example.com'], renamed))
      .toEqual([
        { userId: 'mina@example.com', offset: 4, length: 10 },
        { userId: 'owner@example.com', offset: 19, length: 11 },
      ])
    // Editing the token itself drops the stored mention.
    expect(resolveEditedDocumentMentions(original, 'Ask Mina about it', [], renamed)).toEqual([])
  })

  test('puts an edited comment into the cached thread opened by a deep link', async () => {
    const root = createComment({ id: 'root' })
    const reply = createComment({ id: 'reply', parentCommentId: 'root', body: 'Before' })
    const edited = { ...reply, body: 'After', editedAt: '2026-11-02T00:00:00.000Z' }
    const threadKey = ['document-comment-thread', 'token', documentRecordFixture.id, 'root', 'reply']
    // SWR keeps each entry's original key under `_k`, which key matchers read.
    const cache = new Map<string, object>([[unstable_serialize(threadKey), { data: [root, reply], _k: threadKey }]])
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return Response.json({ comment: edited })
    }) as typeof fetch
    let actions: ReturnType<typeof useDocumentCommentChanges> | undefined
    /** Captures the mutation actions inside the test SWR cache. */
    function Probe() {
      actions = useDocumentCommentChanges('token')
      return null
    }
    renderToStaticMarkup(<SWRConfig value={{ provider: () => cache }}><Probe /></SWRConfig>)
    if (!actions) throw new Error('The mutation hook did not render.')

    expect(await actions.editComment(documentRecordFixture.id, 'reply', { body: 'After', mentions: [] })).toEqual(edited)
    expect(requests).toEqual([
      `PATCH /api/documents/${encodeURIComponent(documentRecordFixture.id)}/comments/reply`,
    ])
    expect(cache.get(unstable_serialize(threadKey))).toMatchObject({ data: [root, edited] })
  })

  test('shows Mermaid source as source and no longer offers Mermaid for a text diagram', () => {
    const readOnly = renderToStaticMarkup(
      <DocumentReadOnlyContent
        document={createPage([{ id: 'diagram', type: 'diagram', format: 'mermaid', source: 'graph TD; A-->B' }])}
        t={t}
      />,
    )
    const editor = renderToStaticMarkup(
      <DocumentEditor
        document={createPage([{ id: 'diagram', type: 'diagram', format: 'text', source: 'A → B' }])}
        editable
        saveStatus="saved"
        t={t}
        onDeleteBlock={() => undefined}
        onMoveBlock={() => undefined}
        onUpsertBlock={() => undefined}
      />,
    )

    expect(readOnly).toContain('Mermaid source (not drawn as a diagram)')
    expect(readOnly).toContain('graph TD; A--&gt;B')
    expect(editor).not.toContain('value="mermaid"')
  })

  test('offers row and column deletion and insertion below each block', () => {
    const html = renderToStaticMarkup(
      <DocumentEditor
        document={createPage([{
          id: 'table',
          type: 'table',
          columns: ['Name', 'Owner'],
          rows: [{ id: 'row-1', cells: [{ id: 'cell-1', text: 'A' }, { id: 'cell-2', text: 'B' }] }],
        }])}
        editable
        saveStatus="saved"
        t={t}
        onDeleteBlock={() => undefined}
        onMoveBlock={() => undefined}
        onUpsertBlock={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="Delete row 1"')
    expect(html).toContain('aria-label="Delete column 2"')
    expect(html).toContain('aria-label="Insert a block below"')
    expect(html).toContain('aria-pressed="false"')
  })

  test('shows author names and offers edit and delete only on the viewer’s own comments', () => {
    const html = renderToStaticMarkup(
      <DocumentContextPanel
        activeTab="comments"
        backlinks={[]}
        comments={[
          createComment({ id: 'own' }),
          createComment({ id: 'other', authorUserId: 'mina@example.com', body: 'Other comment' }),
          createComment({
            id: 'deleted',
            body: '',
            deletedAt: '2026-11-01T01:00:00.000Z',
            parentCommentId: 'other',
          }),
        ]}
        currentMemberKey="owner@example.com"
        document={documentRecordFixture}
        locale="en"
        mentionMembers={members}
        t={t}
        versions={[]}
        onClose={() => undefined}
        onDeleteComment={async () => undefined}
        onEditComment={async () => undefined}
        onTabChange={() => undefined}
      />,
    )

    expect(html).toContain('Owner Name')
    expect(html).toContain('Mina Sato')
    expect(html).toContain('This comment was deleted.')
    expect(html.match(/>Edit</g)?.length).toBe(1)
    expect(html.match(/>Delete</g)?.length).toBe(1)
  })

  test('offers Workspace members by name in the share dialog', () => {
    const html = renderToStaticMarkup(
      <DocumentShareDialog
        document={{
          ...documentRecordFixture,
          capabilities: { ...documentRecordFixture.capabilities, canShare: true },
        }}
        members={members}
        shares={[{ type: 'member', grant: { memberKey: 'mina@example.com', role: 'viewer' } }]}
        t={t}
        onClose={() => undefined}
        onCreateShare={async () => undefined}
      />,
    )

    expect(html).toContain('<datalist')
    expect(html).toContain('value="mina@example.com"')
    expect(html).toContain('Mina Sato (mina@example.com)')
    expect(html).toContain('title="mina@example.com">Mina Sato</p>')
  })
})
