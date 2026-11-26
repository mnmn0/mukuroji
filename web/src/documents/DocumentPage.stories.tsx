import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { projectDirectoryFixtures } from '../projects/fixtures'
import {
  documentBacklinkFixtures,
  documentCommentFixtures,
  documentPresenceFixtures,
  documentRecordFixture,
  documentShareFixtures,
  documentSummaryFixtures,
  documentVersionFixtures,
  readOnlyDocumentCapabilities,
  whiteboardRecordFixture,
} from './fixtures'
import {
  DocumentScreen,
  type DocumentScreenActions,
  type DocumentScreenData,
} from './DocumentPage'
import { applyDocumentOperationsLocally } from './model/document'

const screenData: DocumentScreenData = {
  backlinks: documentBacklinkFixtures,
  canCreateDocuments: true,
  comments: documentCommentFixtures,
  documents: documentSummaryFixtures,
  presence: documentPresenceFixtures,
  selectedDocument: documentRecordFixture,
  shares: documentShareFixtures,
  teams: projectDirectoryFixtures,
  versions: documentVersionFixtures,
}

const screenActions: DocumentScreenActions = {
  applyOperations: async (documentId, revision, operations) => {
    const source =
      documentId === whiteboardRecordFixture.id
        ? whiteboardRecordFixture
        : documentRecordFixture
    const document = {
      ...applyDocumentOperationsLocally(source, operations),
      revision: revision + 1,
    }
    return {
      committedRevision: document.revision,
      document,
    }
  },
  archiveDocument: async () => undefined,
  createComment: async () => undefined,
  createDocument: async () => undefined,
  createShare: async () => undefined,
  deleteShare: async () => undefined,
  exportDocument: async () => undefined,
  exportDocumentSubtree: async () => undefined,
  instantiateTemplate: async () => undefined,
  moveDocument: async () => undefined,
  restoreDocument: async () => undefined,
  restoreVersion: async () => documentRecordFixture,
  selectDocument: () => undefined,
  setFavorite: async () => undefined,
  updateDocument: async (_documentId, revision, input) => ({
    ...documentRecordFixture,
    permission: input.permission ?? documentRecordFixture.permission,
    revision: revision + 1,
    title: input.title ?? documentRecordFixture.title,
  }),
}

/**
 * Documents workspace の Storybook metadata です。
 */
const meta = {
  args: {
    actions: screenActions,
    data: screenData,
    locale: 'ja',
    userInitial: 'D',
    userLabel: 'demo@example.com',
  },
  component: DocumentScreen,
  parameters: {
    layout: 'fullscreen',
  },
  title: 'Application/Documents/Workspace',
} satisfies Meta<typeof DocumentScreen>

export default meta

/**
 * Documents workspace stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Typed blocks を編集できる page の既定状態です。
 */
export const RichTextPage: Story = {}

/** Rich text and wide tables remain contained within the phone editor canvas. */
export const MobileEditor: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const editor = canvas.getByTestId('document-editor')
    await expect(editor.scrollWidth).toBeLessThanOrEqual(editor.clientWidth)
    await expect(canvasElement.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
  },
}

/**
 * Export menu with Markdown/JSON, print / PDF, and subtree Markdown actions.
 */
export const ExportMenu: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /書き出す/ }))
    await expect(
      canvas.getByRole('menuitem', { name: '印刷 / PDF' }),
    ).toBeVisible()
    await expect(
      canvas.getByRole('menuitem', { name: '配下ページをまとめて Markdown' }),
    ).toBeVisible()
  },
}

/**
 * Favorites、recent、templates、Project spaces をまとめた landing です。
 */
export const LibraryHome: Story = {
  args: {
    data: {
      ...screenData,
      selectedDocument: undefined,
    },
  },
}

/**
 * Object、connector、frame、Work Item card を持つ Whiteboard です。
 */
export const Whiteboard: Story = {
  args: {
    data: {
      ...screenData,
      selectedDocument: whiteboardRecordFixture,
    },
  },
}

/**
 * Whiteboard の付箋から Work Item を作れる状態です。付箋を選ぶと inspector に作成 action が出ます。
 */
export const WhiteboardNoteWorkItem: Story = {
  args: {
    actions: {
      ...screenActions,
      createWorkItem: async () => 'team/core/issue/ISSUE-42',
    },
    data: {
      ...screenData,
      selectedDocument: whiteboardRecordFixture,
    },
  },
}

/**
 * Work Item の完了で付箋が完了になった Whiteboard です。付箋に「✓ 完了」と取り消し線が付きます。
 */
export const WhiteboardNoteDone: Story = {
  args: {
    data: {
      ...screenData,
      selectedDocument: whiteboardRecordFixture.kind === 'whiteboard'
        ? {
            ...whiteboardRecordFixture,
            whiteboard: {
              ...whiteboardRecordFixture.whiteboard,
              objects: whiteboardRecordFixture.whiteboard.objects.map((object) =>
                object.type === 'note' ? { ...object, done: true } : object),
            },
          }
        : whiteboardRecordFixture,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText(/✓ 完了/u)).toBeInTheDocument()
  },
}

/**
 * Comment と version history を右 drawer で確認する状態です。
 */
export const VersionHistory: Story = {
  args: {
    initialContextTab: 'versions',
  },
}

/**
 * Mention と reply を含む comment thread を表示する状態です。
 */
export const CommentThread: Story = {
  args: {
    initialContextTab: 'comments',
  },
}

/** Explicit Document Brief generation entry point with no automatic request. */
export const AiBrief: Story = {
  args: {
    aiAssistanceAccessToken: 'storybook-access-token',
    initialContextTab: 'brief',
  },
}

/**
 * Permission、member grant、expiring public link を管理する dialog です。
 */
export const ShareAccess: Story = {
  args: {
    initialShareDialogOpen: true,
  },
}

/**
 * Capability が read-only の page を確認する状態です。
 */
export const ReadOnly: Story = {
  args: {
    data: {
      ...screenData,
      selectedDocument: {
        ...documentRecordFixture,
        capabilities: readOnlyDocumentCapabilities,
      },
    },
  },
}

/** Members whose names stand in for member keys in comments and the share dialog. */
const storyMembers = [
  { memberKey: 'demo-user', name: 'デモ ユーザー', email: 'demo@example.com', status: 'active' },
  { memberKey: 'sato-user', name: '佐藤 一郎', email: 'sato@example.com', status: 'active' },
  { memberKey: 'guest@example.com', name: 'ゲスト 花子', email: 'guest@example.com', status: 'active' },
]

/**
 * Design spec page that uses Markdown lists, links, emphasis, and quotes, a table, and a flow diagram.
 */
export const MarkdownDesignSpec: Story = {
  args: {
    data: {
      ...screenData,
      selectedDocument: documentRecordFixture.kind === 'page'
        ? {
            ...documentRecordFixture,
            title: '申請フロー設計書',
            blocks: [
              { id: 'spec-heading', type: 'heading', level: 1, text: '概要' },
              {
                id: 'spec-markdown',
                type: 'paragraph',
                text: '社内向けの申請フローを **3 段階** で承認する。\n\n- 申請者が [申請フォーム](https://example.com/form) から送る\n- 上長が承認する\n- 経理が支払いを確定する\n\n> 承認の期限は **5 営業日** とする',
              },
              {
                id: 'spec-table',
                type: 'table',
                columns: ['役割', '担当'],
                rows: [
                  { id: 'row-1', cells: [{ id: 'c-1', text: '上長' }, { id: 'c-2', text: '佐藤' }] },
                  { id: 'row-2', cells: [{ id: 'c-3', text: '経理' }, { id: 'c-4', text: '山田' }] },
                ],
              },
              { id: 'spec-diagram', type: 'diagram', format: 'text', source: '申請 → 上長承認 → 経理確定' },
            ],
          }
        : documentRecordFixture,
    },
  },
}

/**
 * Comment thread where the viewer edits and deletes their own comments and sees author names.
 */
export const CommentOwnActions: Story = {
  args: {
    actions: {
      ...screenActions,
      deleteComment: async () => undefined,
      editComment: async () => undefined,
    },
    data: {
      ...screenData,
      comments: [
        ...documentCommentFixtures,
        {
          anchor: { type: 'document' },
          authorUserId: 'sato-user',
          body: '',
          createdAt: '2026-07-18T08:50:00.000Z',
          deletedAt: '2026-07-18T09:10:00.000Z',
          documentId: 'product-principles',
          id: 'comment-deleted',
          mentions: [],
          parentCommentId: 'comment-context',
          resolved: false,
          updatedAt: '2026-07-18T09:10:00.000Z',
        },
      ],
      currentUserKey: 'demo-user',
    },
    initialContextTab: 'comments',
    mentionMembers: storyMembers,
  },
}

/**
 * Share dialog that offers Workspace members by name.
 */
export const ShareMemberPicker: Story = {
  args: {
    initialShareDialogOpen: true,
    mentionMembers: storyMembers,
  },
}
