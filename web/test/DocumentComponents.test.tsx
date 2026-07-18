import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { DocumentReadOnlyContent } from '../src/documents/DocumentEditor'
import { DocumentScreen } from '../src/documents/DocumentPage'
import { SharedDocumentScreen } from '../src/documents/SharedDocumentPage'
import { DocumentTree } from '../src/documents/DocumentTree'
import { WhiteboardCanvas } from '../src/documents/WhiteboardCanvas'
import {
  documentCommentFixtures,
  documentRecordFixture,
  documentSummaryFixtures,
  editableDocumentCapabilities,
  publicDocumentFixture,
  publicWhiteboardFixture,
  whiteboardRecordFixture,
} from '../src/documents/fixtures'
import { createTranslator } from '../src/i18n'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

const t = createTranslator('en')

describe('Document components', () => {
  test('renders a nested scoped tree with favorites and archived nodes', () => {
    const html = renderToStaticMarkup(
      <DocumentTree
        documents={documentSummaryFixtures}
        hasMoreActive
        t={t}
        teams={projectDirectoryFixtures}
        onLoadMore={async () => undefined}
        onSelectDocument={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="Document tree"')
    expect(html).toContain('Product handbook')
    expect(html).toContain('Launch workshop')
    expect(html).toContain('Load more')
  })

  test('escapes untrusted block text in the read-only renderer', () => {
    if (documentRecordFixture.kind !== 'page') {
      throw new Error('Expected a page fixture.')
    }
    const document = {
      ...documentRecordFixture,
      blocks: [{
        id: 'unsafe-paragraph',
        text: '<script>alert("unsafe")</script>',
        type: 'paragraph' as const,
      }],
    }
    const html = renderToStaticMarkup(
      <DocumentReadOnlyContent document={document} t={t} />,
    )

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('keeps mobile actions reachable and hides denied document actions', () => {
    const readOnlyDocument = {
      ...documentRecordFixture,
      capabilities: {
        ...editableDocumentCapabilities,
        canArchive: false,
        canExport: false,
        canRestore: false,
        canShare: false,
      },
    }
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DocumentScreen
          actions={{
            archiveDocument: async () => undefined,
            exportDocument: async () => undefined,
            logout: () => undefined,
            restoreDocument: async () => undefined,
            selectDocument: () => undefined,
          }}
          data={{
            backlinks: [],
            canCreateDocuments: false,
            comments: [],
            documents: documentSummaryFixtures,
            presence: [],
            selectedDocument: readOnlyDocument,
            shares: [],
            teams: projectDirectoryFixtures,
            versions: [],
          }}
          locale="en"
          userInitial="D"
          userLabel="demo@example.com"
        />
      </MemoryRouter>,
    )

    expect(html).toContain('aria-label="More actions"')
    expect(html).not.toContain('aria-label="Archive"')
    expect(html).not.toContain('>Export <!-- -->▾<')
  })

  test('allows an active workspace member to create the first document', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DocumentScreen
          actions={{
            createDocument: async () => undefined,
            selectDocument: () => undefined,
          }}
          data={{
            backlinks: [],
            canCreateDocuments: true,
            comments: [],
            documents: [],
            presence: [],
            shares: [],
            teams: [],
            versions: [],
          }}
          locale="en"
          userInitial="D"
          userLabel="demo@example.com"
        />
      </MemoryRouter>,
    )

    expect(html).toContain('New page')
    expect(html).toContain('New whiteboard')
  })

  test('groups comment replies and emphasizes mention ranges', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DocumentScreen
          actions={{
            createComment: async () => undefined,
            resolveComment: async () => undefined,
            selectDocument: () => undefined,
          }}
          data={{
            backlinks: [],
            canCreateDocuments: true,
            comments: documentCommentFixtures,
            documents: documentSummaryFixtures,
            focusedCommentId: 'comment-context-reply',
            presence: [],
            selectedDocument: documentRecordFixture,
            shares: [],
            teams: projectDirectoryFixtures,
            versions: [],
          }}
          initialContextTab="comments"
          locale="en"
          userInitial="D"
          userLabel="demo@example.com"
        />
      </MemoryRouter>,
    )

    expect(html).toContain(
      'data-testid="document-comment-replies-comment-context"',
    )
    expect(html).toContain('data-comment-id="comment-context-reply"')
    expect(html).toContain('data-focused-comment="true"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('<mark')
    expect(html).toContain('>Reply</button>')
  })

  test('keeps a resolved notification comment visible while focused', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DocumentScreen
          actions={{
            selectDocument: () => undefined,
          }}
          data={{
            backlinks: [],
            canCreateDocuments: true,
            comments: documentCommentFixtures,
            documents: documentSummaryFixtures,
            focusedCommentId: 'comment-resolved',
            presence: [],
            selectedDocument: documentRecordFixture,
            shares: [],
            teams: projectDirectoryFixtures,
            versions: [],
          }}
          initialContextTab="comments"
          locale="en"
          userInitial="D"
          userLabel="demo@example.com"
        />
      </MemoryRouter>,
    )

    expect(html).toContain('data-comment-id="comment-resolved"')
    expect(html).toContain('data-focused-comment="true"')
  })

  test('requires permission management capability before enabling tree drag', () => {
    const source = documentSummaryFixtures[0]!
    const html = renderToStaticMarkup(
      <DocumentTree
        documents={[{
          ...source,
          capabilities: {
            ...source.capabilities,
            canEdit: true,
            canManagePermissions: false,
          },
          kind: 'page',
          parentId: undefined,
        }]}
        t={t}
        teams={[]}
        onMoveDocument={async () => undefined}
        onSelectDocument={() => undefined}
      />,
    )

    expect(html).toContain('draggable="false"')

    const managerHtml = renderToStaticMarkup(
      <DocumentTree
        documents={[{
          ...source,
          kind: 'page',
          parentId: undefined,
        }]}
        t={t}
        teams={[]}
        onMoveDocument={async () => undefined}
        onSelectDocument={() => undefined}
      />,
    )
    expect(managerHtml).toContain('draggable="true"')
  })

  test('exposes mobile multi-select and keyboard whiteboard controls', () => {
    if (whiteboardRecordFixture.kind !== 'whiteboard') {
      throw new Error('Expected a whiteboard fixture.')
    }
    const html = renderToStaticMarkup(
      <WhiteboardCanvas
        content={whiteboardRecordFixture.whiteboard}
        editable
        t={t}
        onDeleteConnector={() => undefined}
        onDeleteFrame={() => undefined}
        onDeleteObject={() => undefined}
        onUpsertConnector={() => undefined}
        onUpsertFrame={() => undefined}
        onUpsertObject={() => undefined}
      />,
    )

    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('title="Multi-select"')
    expect(html).toContain('role="application"')
  })
})

describe('Shared document read-only surface', () => {
  test('renders a public page without authenticated editing controls', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SharedDocumentScreen
          document={publicDocumentFixture}
          locale="en"
        />
      </MemoryRouter>,
    )

    expect(html).toContain('Product principles')
    expect(html).toContain('Read only')
    expect(html).not.toContain('Add block')
  })

  test('renders a public whiteboard as SVG without the edit toolbar', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SharedDocumentScreen
          document={publicWhiteboardFixture}
          locale="en"
        />
      </MemoryRouter>,
    )

    expect(html).toContain('aria-label="Whiteboard"')
    expect(html).toContain('Launch readiness')
    expect(html).not.toContain('launch-review')
    expect(html).not.toContain('aria-label="Whiteboard tools"')
  })

  test('hides public export unless the share explicitly allows it', () => {
    const hiddenHtml = renderToStaticMarkup(
      <MemoryRouter>
        <SharedDocumentScreen
          document={publicDocumentFixture}
          locale="en"
        />
      </MemoryRouter>,
    )
    const visibleHtml = renderToStaticMarkup(
      <MemoryRouter>
        <SharedDocumentScreen
          allowExport
          document={publicDocumentFixture}
          locale="en"
          onExport={async () => undefined}
        />
      </MemoryRouter>,
    )

    expect(hiddenHtml).not.toContain('Export')
    expect(visibleHtml).toContain('Export')
  })
})
