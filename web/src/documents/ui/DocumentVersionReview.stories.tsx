import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { SWRConfig, unstable_serialize } from 'swr'
import type { ApprovalRequest, DocumentDetail, DocumentVersion } from '@mukuroji/contracts'
import { documentRecordFixture } from '../fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import { DocumentVersionReviewDialog } from './DocumentVersionReview'

const t = createTranslator('ja')

/** Pinned version under review in these stories. */
const pinnedVersion: DocumentVersion = {
  schemaVersion: 1,
  id: `${documentRecordFixture.id}:12`,
  documentId: documentRecordFixture.id,
  revision: 12,
  kind: 'page',
  title: documentRecordFixture.title,
  reason: 'edit',
  createdByUserId: 'sato@example.com',
  createdAt: '2026-11-10T09:30:00.000Z',
  name: 'v1.0 承認版',
  pinnedAt: '2026-11-10T10:00:00.000Z',
  pinnedByUserId: 'sato@example.com',
}

/** Approved request shown for the pinned version. */
const approvedRequest: ApprovalRequest = {
  id: 'approval-design-v1',
  subjectType: 'document-version',
  documentId: documentRecordFixture.id,
  versionId: pinnedVersion.id,
  teamId: 'core',
  issueId: 'ENG-128',
  revision: 3,
  status: 'approved',
  reviewers: [
    { memberKey: 'yamada@example.com', status: 'approved', decidedAt: '2026-11-11T02:00:00.000Z' },
    { memberKey: 'suzuki@example.com', status: 'approved', decidedAt: '2026-11-11T03:00:00.000Z' },
  ],
  dueAt: '2026-11-14T14:59:59.000Z',
  requestedByMemberKey: 'sato@example.com',
  requestedByKind: 'member',
  createdAt: '2026-11-10T10:05:00.000Z',
  updatedAt: '2026-11-11T03:00:00.000Z',
  completedAt: '2026-11-11T03:00:00.000Z',
  capabilities: { canDecide: false, canCancel: false },
}

/**
 * Builds the pinned version's snapshot: an older draft of the fixture page.
 *
 * @returns The version snapshot.
 */
function createPinnedSnapshot(): DocumentDetail {
  if (documentRecordFixture.kind !== 'page') throw new Error('Expected a page fixture.')
  const [first, ...rest] = documentRecordFixture.blocks
  return {
    ...documentRecordFixture,
    revision: 12,
    blocks: [
      ...(first ? [first] : []),
      { id: 'paragraph-scope-v1', type: 'paragraph', text: '対象範囲は社内向けの申請フローに限定する。' },
      ...rest.slice(1),
    ],
  }
}

/**
 * Supplies the cached version snapshot and a router to the dialog.
 *
 * @param props - Story content.
 * @returns The wrapped story.
 */
function VersionReviewStoryFrame({ children }: { /** Story content. */ children: ReactNode }) {
  const fallback = {
    [unstable_serialize(['document-version-detail', 'story-token', documentRecordFixture.id, pinnedVersion.id])]: {
      version: pinnedVersion,
      document: createPinnedSnapshot(),
    },
    [unstable_serialize(['document-link-work-item', 'story-token', 'core', 'ENG-128'])]: {
      issue: { id: 'ENG-128', title: '申請フロー設計書を承認する' },
    },
  }
  return (
    <MemoryRouter>
      {/* The fixtures stand in for the API, so the story never revalidates against it. */}
      <SWRConfig
        value={{
          fallback,
          provider: () => new Map(),
          revalidateOnMount: false,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        }}
      >
        {children}
      </SWRConfig>
    </MemoryRouter>
  )
}

const meta = {
  title: 'Documents/DocumentVersionReviewDialog',
  component: DocumentVersionReviewDialog,
  decorators: [(Story) => <VersionReviewStoryFrame><Story /></VersionReviewStoryFrame>],
  args: {
    accessToken: 'story-token',
    approvals: [approvedRequest],
    document: documentRecordFixture,
    locale: 'ja',
    members: [
      { memberKey: 'yamada@example.com', name: '山田 花子', status: 'active' },
      { memberKey: 'suzuki@example.com', name: '鈴木 次郎', status: 'active' },
      { memberKey: 'sato@example.com', name: '佐藤 一郎', status: 'active' },
    ],
    onClose: () => undefined,
    onPin: async () => undefined,
    onRequestApproval: async () => undefined,
    t,
    version: pinnedVersion,
    versions: [pinnedVersion],
  },
} satisfies Meta<typeof DocumentVersionReviewDialog>

export default meta

/** Story type shared by the version review dialog stories, typed from {@link meta}. */
type Story = StoryObj<typeof meta>

/** Read-only preview of the pinned version. */
export const Preview: Story = { args: { initialTab: 'preview' } }

/** Block-level changes from the pinned version to the current content. */
export const Compare: Story = { args: { initialTab: 'compare' } }

/** Pinned version with its approval result and the request form. */
export const Approval: Story = { args: { initialTab: 'approval' } }
