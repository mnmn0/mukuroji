import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  collaborationWorkspaceMemberFixtures,
  issueCollaborationControllerFixture,
} from './fixtures'
import { IssueCollaborationPanel } from './IssueCollaborationPanel'
import { fileArtifactsControllerFixture, imageFileFixture } from '../files/fixtures'

const meta = {
  title: 'Application/Issues/Collaboration Panel',
  component: IssueCollaborationPanel,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="workbench-shell w-[440px] max-w-[100vw] overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white shadow-sm">
        <Story />
      </div>
    ),
  ],
  args: {
    controller: issueCollaborationControllerFixture,
    currentMemberKey: 'demo@example.com',
    locale: 'ja',
    members: collaborationWorkspaceMemberFixtures,
  },
} satisfies Meta<typeof IssueCollaborationPanel>

/**
 * IssueCollaborationPanel の Storybook metadata です。
 */
export default meta

/**
 * IssueCollaborationPanel Story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * thread、mention、reaction、watcher、typing をまとめた標準状態です。
 */
export const Default: Story = {}

/**
 * resolve された thread の状態です。
 */
export const ResolvedThread: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      comments: issueCollaborationControllerFixture.comments.map((comment) =>
        comment.parentCommentId
          ? comment
          : {
              ...comment,
              resolvedAt: '2026-06-08T01:30:00.000Z',
              resolvedByMemberKey: 'demo@example.com',
            },
      ),
    },
  },
}

/**
 * guest や legacy Work Item で変更できない状態です。
 */
export const ReadOnly: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      capabilities: { canComment: false, canReact: false, canWatch: false },
      comments: issueCollaborationControllerFixture.comments.map((comment) => ({
        ...comment,
        capabilities: { canEdit: false, canDelete: false, canResolve: false },
      })),
    },
    readOnlyMessage: 'この Work Item のディスカッションは参照専用です。',
  },
}

/**
 * コメントと activity の最初の page を読み込んでいる状態です。
 */
export const Loading: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      activity: [],
      comments: [],
      isActivityLoading: true,
      isLoading: true,
    },
  },
}

/**
 * soft delete された root と残った reply を表示する状態です。
 */
export const DeletedRoot: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      comments: issueCollaborationControllerFixture.comments.map((comment) =>
        comment.parentCommentId
          ? comment
          : {
              ...comment,
              bodyMarkdown: '',
              deletedAt: '2026-06-08T01:35:00.000Z',
              version: 3,
            },
      ),
    },
  },
}

/**
 * 保存済み comment に file が添付された状態です。
 */
export const WithFileAttachment: Story = {
  args: {
    artifacts: {
      ...fileArtifactsControllerFixture,
      files: [
        {
          ...imageFileFixture,
          targetId: 'comment-1',
          targetType: 'comment',
        },
      ],
    },
  },
}
