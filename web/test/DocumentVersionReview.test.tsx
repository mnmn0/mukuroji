import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { SWRConfig, unstable_serialize } from 'swr'
import type { ApprovalRequest, DocumentDetail, DocumentVersion } from '@mukuroji/contracts'
import { documentRecordFixture } from '../src/documents/fixtures'
import { DocumentVersionReviewDialog } from '../src/documents/ui/DocumentVersionReview'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('en')

const pinnedVersion: DocumentVersion = {
  schemaVersion: 1,
  id: `${documentRecordFixture.id}:1`,
  documentId: documentRecordFixture.id,
  revision: 1,
  kind: 'page',
  title: 'Spec v1',
  reason: 'edit',
  createdByUserId: 'owner@example.com',
  createdAt: '2026-11-01T00:00:00.000Z',
  name: 'v1.0 approved',
  pinnedAt: '2026-11-02T00:00:00.000Z',
}

/**
 * Builds the snapshot of the pinned version from the fixture page.
 *
 * @returns A page snapshot with one paragraph.
 */
function createSnapshot(): DocumentDetail {
  if (documentRecordFixture.kind !== 'page') throw new Error('Expected a page fixture.')
  return {
    ...documentRecordFixture,
    revision: 1,
    title: 'Spec v1',
    blocks: [{ id: 'paragraph-v1', type: 'paragraph', text: 'Approved scope text' }],
  }
}

/**
 * Renders the dialog with the pinned version's snapshot already cached.
 *
 * @param props - Tab, approvals, and whether pinning is allowed.
 * @returns Static markup.
 */
function renderDialog(props: {
  initialTab: 'preview' | 'compare' | 'approval'
  approvals?: ApprovalRequest[]
  version?: DocumentVersion
  canEdit?: boolean
}) {
  const version = props.version ?? pinnedVersion
  const fallback = {
    [unstable_serialize(['document-version-detail', 'token', documentRecordFixture.id, version.id])]: {
      version,
      document: createSnapshot(),
    },
  }
  return renderToStaticMarkup(
    <MemoryRouter>
      <SWRConfig value={{ fallback, provider: () => new Map() }}>
        <DocumentVersionReviewDialog
          accessToken="token"
          approvals={props.approvals ?? []}
          document={documentRecordFixture}
          initialTab={props.initialTab}
          locale="en"
          members={[{ memberKey: 'reviewer@example.com', name: 'Rina Reviewer', status: 'active' }]}
          onClose={() => undefined}
          onPin={props.canEdit === false ? undefined : async () => undefined}
          onRequestApproval={props.canEdit === false ? undefined : async () => undefined}
          t={t}
          version={version}
          versions={[version]}
        />
      </SWRConfig>
    </MemoryRouter>,
  )
}

describe('DocumentVersionReviewDialog', () => {
  test('previews the version snapshot read-only', () => {
    const html = renderDialog({ initialTab: 'preview' })
    expect(html).toContain('role="dialog"')
    expect(html).toContain('v1.0 approved')
    expect(html).toContain('Approved scope text')
    expect(html).not.toContain('<textarea')
  })

  test('compares the version with the current content block by block', () => {
    const html = renderDialog({ initialTab: 'compare' })
    expect(html).toContain('Current content')
    expect(html).toContain('data-diff-kind="removed"')
    expect(html).toContain('data-diff-kind="added"')
    expect(html).toContain('Context before execution')
  })

  test('offers pinning for an unnamed version and approval requests for a pinned one', () => {
    const unnamed: DocumentVersion = { ...pinnedVersion, name: undefined, pinnedAt: undefined }
    expect(renderDialog({ initialTab: 'approval', version: unnamed })).toContain('Name and pin')
    expect(renderDialog({ initialTab: 'approval', version: unnamed, canEdit: false }))
      .toContain('must name and pin this version')

    const approval: ApprovalRequest = {
      id: 'approval-1',
      subjectType: 'document-version',
      documentId: documentRecordFixture.id,
      versionId: pinnedVersion.id,
      teamId: 'core',
      issueId: 'ENG-1',
      revision: 2,
      status: 'approved',
      reviewers: [{ memberKey: 'reviewer@example.com', status: 'approved' }],
      dueAt: '2026-11-30T00:00:00.000Z',
      requestedByMemberKey: 'owner@example.com',
      requestedByKind: 'member',
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-03T00:00:00.000Z',
      capabilities: { canDecide: false, canCancel: false },
    }
    const html = renderDialog({ initialTab: 'approval', approvals: [approval] })
    expect(html).toContain('Pinned as “v1.0 approved”')
    expect(html).toContain('data-testid="document-approval-approval-1"')
    expect(html).toContain('Rina Reviewer')
    expect(html).toContain('Request approval')
  })
})
