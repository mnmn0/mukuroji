import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { SWRConfig, unstable_serialize } from 'swr'
import type { ApprovalRequest, DocumentBlock, DocumentDetail, DocumentVersion } from '@mukuroji/contracts'
import { documentRecordFixture } from '../src/documents/fixtures'
import { DocumentVersionReviewDialog, type ApprovalsReadStatus } from '../src/documents/ui/DocumentVersionReview'
import { DocumentContextPanel } from '../src/documents/ui/DocumentContextPanel'
import { createTranslator } from '../src/shared/i18n/i18n'
import type { MentionableMember } from '../src/shared/lib/memberMentions'

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
 * @param blocks - Snapshot blocks; one paragraph when omitted.
 * @returns A page snapshot.
 */
function createSnapshot(blocks?: DocumentBlock[]): DocumentDetail {
  if (documentRecordFixture.kind !== 'page') throw new Error('Expected a page fixture.')
  return {
    ...documentRecordFixture,
    revision: 1,
    title: 'Spec v1',
    blocks: blocks ?? [{ id: 'paragraph-v1', type: 'paragraph', text: 'Approved scope text' }],
  }
}

/**
 * Builds the current fixture page with other blocks.
 *
 * @param blocks - Current blocks.
 * @returns The current page.
 */
function createCurrentPage(blocks: DocumentBlock[]) {
  if (documentRecordFixture.kind !== 'page') throw new Error('Expected a page fixture.')
  return { ...documentRecordFixture, blocks }
}

/**
 * Builds a checklist block with one item.
 *
 * @param ownership - Owner and deadline saved on the item.
 * @returns The checklist block.
 */
function createChecklist(ownership: { assigneeMemberKey?: string; dueDate?: string }): DocumentBlock {
  return {
    id: 'checklist-1',
    type: 'checklist',
    items: [{ id: 'item-1', text: 'Sign the contract', checked: false, ...ownership }],
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
  approvalsStatus?: ApprovalsReadStatus
  detailFailed?: boolean
  snapshotBlocks?: DocumentBlock[]
  currentBlocks?: DocumentBlock[]
  members?: MentionableMember[]
}) {
  const version = props.version ?? pinnedVersion
  const detailKey = unstable_serialize(['document-version-detail', 'token', documentRecordFixture.id, version.id])
  const fallback = props.detailFailed ? {} : {
    [detailKey]: {
      version,
      document: createSnapshot(props.snapshotBlocks),
    },
  }
  // A failed read is seeded as the cached SWR state of the version detail.
  const cache = new Map<string, object>(
    props.detailFailed ? [[detailKey, { error: new Error('Version read failed.') }]] : [],
  )
  return renderToStaticMarkup(
    <MemoryRouter>
      <SWRConfig value={{ fallback, provider: () => cache }}>
        <DocumentVersionReviewDialog
          accessToken="token"
          approvals={props.approvals ?? []}
          approvalsStatus={props.approvalsStatus}
          document={props.currentBlocks ? createCurrentPage(props.currentBlocks) : documentRecordFixture}
          initialTab={props.initialTab}
          locale="en"
          members={props.members ?? [{ memberKey: 'reviewer@example.com', name: 'Rina Reviewer', status: 'active' }]}
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

  test('shows a checklist owner or deadline change on both sides of the comparison', () => {
    const before = createChecklist({ assigneeMemberKey: 'ann@example.com', dueDate: '2099-01-10' })
    const after = createChecklist({ assigneeMemberKey: 'bob@example.com', dueDate: '2099-02-20' })
    const named = renderDialog({
      initialTab: 'compare',
      snapshotBlocks: [before],
      currentBlocks: [after],
      members: [{ memberKey: 'ann@example.com', name: 'Ann Smith', status: 'active' }],
    })
    expect(named).toContain('data-diff-kind="changed"')
    expect(named).toContain('Owner: Ann Smith')
    expect(named).toContain('Due 2099-01-10')
    // A member missing from the list, such as one who left, is shown by the saved key.
    expect(named).toContain('Owner: bob@example.com')
    expect(named).toContain('Due 2099-02-20')

    const unnamed = renderDialog({
      initialTab: 'compare',
      snapshotBlocks: [createChecklist({})],
      currentBlocks: [createChecklist({ assigneeMemberKey: 'ann@example.com' })],
      members: [],
    })
    expect(unnamed).toContain('data-diff-kind="changed"')
    expect(unnamed).toContain('Owner: ann@example.com')
    expect(unnamed.match(/Owner: /g)).toHaveLength(1)
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

  test('offers a retry when the version detail of the preview or comparison fails to load', () => {
    for (const initialTab of ['preview', 'compare'] as const) {
      const html = renderDialog({ initialTab, detailFailed: true })
      expect(html).toContain('role="alert"')
      expect(html).toContain('>Retry<')
    }
  })

  test('shows a failed approvals read with a retry instead of an empty list', () => {
    const html = renderDialog({ initialTab: 'approval', approvalsStatus: { kind: 'error', onRetry: () => undefined } })
    expect(html).toContain('Approval statuses could not be loaded.')
    expect(html).toContain('>Retry<')
    expect(html).not.toContain('No approval has been requested yet.')
  })

  test('opens a deep-linked version that is not on the loaded history page through its detail', () => {
    const olderVersion: DocumentVersion = { ...pinnedVersion, id: `${documentRecordFixture.id}:0`, revision: 0, name: 'v0.9 draft' }
    const fallback = {
      [unstable_serialize(['document-version-detail', 'token', documentRecordFixture.id, olderVersion.id])]: {
        version: olderVersion,
        document: createSnapshot(),
      },
      [unstable_serialize(['document-approvals', 'token', documentRecordFixture.id])]: [],
    }
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SWRConfig value={{ fallback, provider: () => new Map() }}>
          <DocumentContextPanel
            activeTab="versions"
            backlinks={[]}
            comments={[]}
            document={documentRecordFixture}
            focusedVersionId={olderVersion.id}
            linkAccessToken="token"
            locale="en"
            t={t}
            versions={[pinnedVersion]}
            onClose={() => undefined}
            onTabChange={() => undefined}
          />
        </SWRConfig>
      </MemoryRouter>,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('v0.9 draft')
  })
})
