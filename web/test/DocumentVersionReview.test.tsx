import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { SWRConfig, unstable_serialize } from 'swr'
import type { ApprovalRequest, DocumentBlock, DocumentDetail, DocumentVersion } from '@mukuroji/contracts'
import { documentRecordFixture, whiteboardRecordFixture } from '../src/documents/fixtures'
import {
  listEnteredReviewerKeys,
  listReviewerCandidates,
  readEnteredReviewerKey,
} from '../src/documents/model/versionApprovals'
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
function createChecklist(ownership: {
  /** Member key of the item's owner. */
  assigneeMemberKey?: string
  /** Deadline of the item as `YYYY-MM-DD`. */
  dueDate?: string
}): DocumentBlock {
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
  /** Tab opened first. */
  initialTab: 'preview' | 'compare' | 'approval'
  /** Approvals of the version; none when omitted. */
  approvals?: ApprovalRequest[]
  /** Version under review; the pinned version when omitted. */
  version?: DocumentVersion
  /** False omits the pin and request callbacks, as for a viewer who cannot edit. */
  canEdit?: boolean
  /** Read state of the approvals. */
  approvalsStatus?: ApprovalsReadStatus
  /** Seeds the SWR cache with a failed version detail read instead of the snapshot. */
  detailFailed?: boolean
  /** Blocks of the version snapshot; one paragraph when omitted. */
  snapshotBlocks?: DocumentBlock[]
  /** Snapshot of the version, replacing the page built from `snapshotBlocks`. */
  snapshot?: DocumentDetail
  /** Blocks of the current content; the fixture page when omitted. */
  currentBlocks?: DocumentBlock[]
  /** Current Document, replacing the page built from `currentBlocks`. */
  current?: DocumentDetail
  /** Workspace members offered as reviewers. */
  members?: MentionableMember[]
  /** Whether an approval request for the version is still being sent. */
  isRequestingApproval?: boolean
}) {
  const version = props.version ?? pinnedVersion
  const detailKey = unstable_serialize(['document-version-detail', 'token', documentRecordFixture.id, version.id])
  const fallback = props.detailFailed ? {} : {
    [detailKey]: {
      version,
      document: props.snapshot ?? createSnapshot(props.snapshotBlocks),
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
          document={props.current ?? (props.currentBlocks ? createCurrentPage(props.currentBlocks) : documentRecordFixture)}
          initialTab={props.initialTab}
          isRequestingApproval={props.isRequestingApproval}
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

  test('lets a requester without the member list add a reviewer by member key', () => {
    // Without members.read the Workspace member list is empty, yet the server still accepts any
    // active member who can view the Work Item as a reviewer.
    const html = renderDialog({ initialTab: 'approval', members: [] })
    expect(html).toContain('enter a reviewer&#x27;s member email and add it')
    expect(html).toContain('>Add reviewer<')

    expect(readEnteredReviewerKey('  Ann@Example.com ', [])).toBe('ann@example.com')
    expect(readEnteredReviewerKey('ann@example.com', ['ann@example.com'])).toBeUndefined()
    expect(readEnteredReviewerKey('   ', [])).toBeUndefined()
    expect(readEnteredReviewerKey(`${'a'.repeat(310)}@example.com`, [])).toBeUndefined()
    expect(listEnteredReviewerKeys(
      ['ann@example.com', 'reviewer@example.com', 'bob@example.com'],
      ['reviewer@example.com'],
    )).toEqual(['ann@example.com', 'bob@example.com'])
  })

  test('previews a whiteboard version with its saved objects', () => {
    if (whiteboardRecordFixture.kind !== 'whiteboard') throw new Error('Expected a Whiteboard fixture.')
    const html = renderDialog({
      initialTab: 'preview',
      snapshot: { ...whiteboardRecordFixture, id: documentRecordFixture.id, revision: 1 },
    })
    expect(html).toContain('<svg')
    expect(html).toContain('Clarify the launch decision')
  })

  test('shows both titles when the title changed', () => {
    if (documentRecordFixture.kind !== 'page') throw new Error('Expected a page fixture.')
    const html = renderDialog({
      initialTab: 'compare',
      current: { ...documentRecordFixture, revision: 2, title: 'Approved spec' },
    })
    expect(html).toContain('The title changed from “Spec v1” to “Approved spec”.')

    // A title is inserted as it is, even when it holds a placeholder or a replacement pattern.
    const tricky = renderDialog({
      initialTab: 'compare',
      snapshot: { ...createSnapshot(), title: 'Plan {after} $& $1' },
      current: { ...documentRecordFixture, revision: 2, title: 'Final $` {before}' },
    })
    expect(tricky).toContain('The title changed from “Plan {after} $&amp; $1” to “Final $` {before}”.')
  })

  test('orders the comparison by the revisions of the shown snapshots', () => {
    if (documentRecordFixture.kind !== 'page') throw new Error('Expected a page fixture.')
    // The client copy of the Document is older than the reviewed version from the history.
    const html = renderDialog({
      initialTab: 'compare',
      version: { ...pinnedVersion, id: `${documentRecordFixture.id}:8`, revision: 8 },
      snapshot: {
        ...documentRecordFixture,
        revision: 8,
        blocks: [{ id: 'added-in-8', type: 'paragraph', text: 'Added in revision 8' }],
      },
      current: { ...documentRecordFixture, revision: 7, blocks: [] },
    })
    expect(html).toContain('data-diff-kind="added"')
    expect(html).not.toContain('data-diff-kind="removed"')
  })

  test('keeps every selected reviewer listed beyond the candidate limit', () => {
    const members: MentionableMember[] = Array.from({ length: 40 }, (_value, index) => ({
      memberKey: `member-${index}@example.com`,
      name: `Member ${index}`,
      status: 'active',
    }))
    const html = renderDialog({ initialTab: 'approval', members })
    expect(html).toContain('Member 29<')
    expect(html).not.toContain('Member 30<')

    // Member 35 was found by a search and chosen; clearing the search keeps it listed.
    const listed = listReviewerCandidates(members, ['member-35@example.com'], '')
    expect(listed[0]?.memberKey).toBe('member-35@example.com')
    expect(listed).toHaveLength(31)
    expect(listReviewerCandidates(members, ['member-35@example.com'], 'member 1').map(({ name }) => name))
      .toEqual(['Member 35', 'Member 1', ...Array.from({ length: 10 }, (_value, index) => `Member ${10 + index}`)])
  })

  test('keeps the request button busy while a request sent before a tab switch is in flight', () => {
    const html = renderDialog({ initialTab: 'approval', isRequestingApproval: true })
    expect(html).toContain('disabled="" type="submit">Saving…</button>')
  })

  test('shows a failed refresh with a retry above the last loaded approvals', () => {
    const approval: ApprovalRequest = {
      id: 'approval-stale',
      subjectType: 'document-version',
      documentId: documentRecordFixture.id,
      versionId: pinnedVersion.id,
      revision: 1,
      status: 'pending',
      reviewers: [{ memberKey: 'reviewer@example.com', status: 'pending' }],
      dueAt: '2026-11-30T00:00:00.000Z',
      requestedByMemberKey: 'owner@example.com',
      requestedByKind: 'member',
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      capabilities: { canDecide: false, canCancel: false },
    }
    const html = renderDialog({
      initialTab: 'approval',
      approvals: [approval],
      approvalsStatus: { kind: 'stale', onRetry: () => undefined },
    })
    expect(html).toContain('Approval statuses could not be refreshed.')
    expect(html).toContain('>Retry<')
    expect(html).toContain('data-testid="document-approval-approval-stale"')
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
