import type { Meta, StoryObj } from '@storybook/react-vite'
import { collaborationWorkspaceMemberFixtures } from '../issues/fixtures'
import {
  blockedVideoFileFixture,
  fileArtifactsControllerFixture,
  imageFileFixture,
  scanningPdfFileFixture,
} from './fixtures'
import { IssueArtifactsPanel } from './IssueArtifactsPanel'

const meta = {
  title: 'Application/Files/Issue Artifacts Panel',
  component: IssueArtifactsPanel,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="workbench-shell w-[440px] max-w-[100vw] overflow-hidden rounded-xl border border-[var(--workbench-border)] bg-white shadow-sm">
        <Story />
      </div>
    ),
  ],
  args: {
    controller: fileArtifactsControllerFixture,
    currentMemberKey: 'demo@example.com',
    locale: 'ja',
    members: collaborationWorkspaceMemberFixtures,
  },
} satisfies Meta<typeof IssueArtifactsPanel>

/**
 * IssueArtifactsPanel の Storybook metadata です。
 */
export default meta

/**
 * IssueArtifactsPanel Story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Version、scan、approval が混在する標準状態です。
 */
export const Default: Story = {}

/**
 * Requester が pending approval を取り消せる状態です。
 */
export const CancelableApproval: Story = {
  args: { currentMemberKey: 'sato@example.com' },
}

/**
 * File がまだ添付されていない空状態です。
 */
export const Empty: Story = {
  args: {
    controller: {
      ...fileArtifactsControllerFixture,
      approvals: [],
      files: [],
    },
  },
}

/**
 * Upload と mutation が許可されていない参照専用状態です。
 */
export const ReadOnly: Story = {
  args: {
    controller: {
      ...fileArtifactsControllerFixture,
      capabilities: { canRequestApproval: false, canUpload: false },
      files: [imageFileFixture].map((file) => ({
        ...file,
        capabilities: {
          canAnnotate: false,
          canDelete: false,
          canDownload: true,
          canRequestApproval: false,
          canUploadVersion: false,
        },
      })),
    },
  },
}

/**
 * Scan 中と block 済みの file だけを表示する状態です。
 */
export const ScanAttention: Story = {
  args: {
    controller: {
      ...fileArtifactsControllerFixture,
      approvals: [],
      files: [scanningPdfFileFixture, blockedVideoFileFixture],
    },
  },
}

/**
 * Project File tab と同じ広幅 table layout です。
 */
export const Expanded: Story = {
  args: {
    expanded: true,
  },
  decorators: [
    (Story) => (
      <div className="workbench-shell w-[980px] max-w-[100vw] bg-[var(--workbench-canvas)] p-5">
        <Story />
      </div>
    ),
  ],
}
