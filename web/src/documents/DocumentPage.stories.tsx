import type { Meta, StoryObj } from '@storybook/react-vite'
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
import { applyDocumentOperationsLocally } from './model'

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
    inboxCount: 3,
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
