import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CreateCuratedContextItemRequest } from '@mukuroji/contracts'
import { expect, fn, userEvent, within } from 'storybook/test'
import {
  acceptedResolutionHistoryFixtures,
  collaborationWorkspaceMemberFixtures,
  curatedContextRevisionFixtures,
  issueCollaborationControllerFixture,
} from '../fixtures'
import { IssueCollaborationPanel } from './IssueCollaborationPanel'
import { fileArtifactsControllerFixture, imageFileFixture } from '../../files/fixtures'

const meta = {
  title: 'Application/Issues/Collaboration Panel',
  component: IssueCollaborationPanel,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="workbench-shell w-[440px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white shadow-sm">
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

const setAcceptedResolution = fn(async () => true)
const loadAcceptedResolutionReplies = fn(async () => undefined)
const createEvidenceReplacement = fn(
  async (input: CreateCuratedContextItemRequest) => {
    void input
    return true
  },
)
const createInheritedSourceReplacement = fn(
  async (input: CreateCuratedContextItemRequest) => {
    void input
    return true
  },
)

/**
 * thread、mention、reaction、watcher、typing をまとめた標準状態です。
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const conversationTab = canvas.getByRole('tab', { name: /会話/ })
    conversationTab.focus()
    await userEvent.keyboard('{ArrowRight}')
    await expect(canvas.getByRole('tab', { name: /判断/ })).toHaveFocus()
    await expect(canvas.getByRole('tab', { name: /判断/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await userEvent.keyboard('{End}')
    await expect(canvas.getByRole('tab', { name: /情報源/ })).toHaveFocus()
  },
}

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
 * guest など権限不足で変更できない状態です。
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

/**
 * Accepted reply, manual summary, and superseded resolution history.
 */
export const AcceptedResolution: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      context: {
        ...issueCollaborationControllerFixture.context,
        acceptedResolutionHistory: {
          hasLoadError: false,
          hasMore: true,
          isLoading: false,
          isLoadingMore: false,
          items: acceptedResolutionHistoryFixtures,
          rootCommentId: 'comment-1',
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('accepted-resolution-summary')).toBeVisible()
    await expect(canvas.getByText('解決策の履歴')).toBeVisible()
    await expect(canvas.getByText('旧案では説明文だけを更新する。')).toBeVisible()
    await expect(
      canvas.getByRole('button', { name: 'さらに前の解決策を読み込む' }),
    ).toBeVisible()
  },
}

/**
 * Resolution summary edits and source links remain usable before its source reply page is loaded.
 */
export const AcceptedResolutionSourceNotLoaded: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      comments: issueCollaborationControllerFixture.comments.filter(
        (comment) => !comment.parentCommentId,
      ),
      loadMoreReplies: loadAcceptedResolutionReplies,
      replyPagination: {
        'comment-1': { hasMore: true, isLoading: false },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    loadAcceptedResolutionReplies.mockClear()
    await userEvent.click(
      canvas.getByRole('button', { name: '要約を編集' }),
    )
    await expect(
      canvas.getByRole('textbox', { name: '手動の解決要約' }),
    ).toHaveValue(
      '空状態の表示条件を含めてモバイルとデスクトップで確認する。',
    )
    await userEvent.click(
      within(canvas.getByTestId('accepted-resolution-summary')).getByRole(
        'link',
        { name: '元の返信を開く' },
      ),
    )
    await expect(loadAcceptedResolutionReplies).toHaveBeenCalledWith(
      'comment-1',
    )
  },
}

/**
 * A reply is the only accepted-resolution candidate and requires a manual summary.
 */
export const SelectAcceptedResolution: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      comments: issueCollaborationControllerFixture.comments.map((comment) =>
        comment.parentCommentId
          ? comment
          : {
              ...comment,
              acceptedResolutions: [],
              resolvedAt: undefined,
              resolvedByMemberKey: undefined,
            },
      ),
      context: {
        ...issueCollaborationControllerFixture.context,
        setAcceptedResolution,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    setAcceptedResolution.mockClear()
    await expect(
      canvas.queryByRole('button', { name: '解決策として採用' }),
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole('button', { name: '解決策として採用' }),
    )
    const summary = canvas.getByRole('textbox', { name: '手動の解決要約' })
    const save = canvas.getByRole('button', { name: '解決策を保存' })
    await expect(save).toBeDisabled()
    await userEvent.type(summary, '表示条件を含めて両方の viewport で確認する。')
    await userEvent.click(save)
    await expect(setAcceptedResolution).toHaveBeenCalledWith(
      'comment-1',
      expect.objectContaining({
        commentId: 'comment-2',
        summary: '表示条件を含めて両方の viewport で確認する。',
      }),
    )
  },
}

/**
 * Flat decision ledger containing an explicitly superseded item.
 */
export const SupersededDecision: Story = {
  args: {
    defaultTab: 'decisions',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('置き換え済み')).toBeVisible()
    await expect(canvas.getByText('置き換え先を開く')).toBeVisible()
  },
}

/**
 * One decision exposes independently paginated immutable revisions.
 */
export const DecisionRevisionHistory: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      context: {
        ...issueCollaborationControllerFixture.context,
        revisionHistory: {
          contextItemId: 'context-action-1',
          hasLoadError: false,
          hasMore: true,
          isLoading: false,
          isLoadingMore: false,
          items: curatedContextRevisionFixtures,
        },
      },
    },
    defaultTab: 'decisions',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('変更履歴')).toBeVisible()
    await expect(canvas.getByText('顧客ヒアリングを確認する')).toBeVisible()
    await expect(canvas.getByText('アクセス権を喪失')).toBeVisible()
    await expect(
      canvas.getByRole('button', { name: 'さらに前の変更を読み込む' }),
    ).toBeVisible()
  },
}

/**
 * Permission loss retains non-sensitive provenance while hiding quote, original, and permalink.
 */
export const PermissionLostSource: Story = {
  args: {
    defaultTab: 'sources',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('アクセス権を喪失')).toBeVisible()
    await expect(
      canvas.getByText(/情報源への権限がないため/),
    ).toBeVisible()
    await expect(
      canvas.queryByText('最初に何をすればよいか分かりませんでした。'),
    ).toBeNull()
    await expect(canvas.queryByText(/messages\/42/)).toBeNull()
  },
}

/**
 * Large activity history collapses consecutive mechanical changes.
 */
export const LargeActivity: Story = {
  args: {
    defaultTab: 'activity',
    controller: {
      ...issueCollaborationControllerFixture,
      activity: Array.from({ length: 48 }, (_, index) => ({
        actorUserId: 'system:workflow',
        eventId: `system-change-${index + 1}`,
        eventType: 'work-item.updated',
        occurredAt: `2026-06-08T01:${String(index).padStart(2, '0')}:00.000Z`,
        summary: `Workflow field change ${index + 1}`,
      })),
      hasMoreActivity: true,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('activity-system-group')).toBeVisible()
    await expect(canvas.getByText('連続するシステム変更 48 件')).toBeVisible()
  },
}

/**
 * Narrow detail pane keeps the tab strip horizontally scrollable and actions touch-sized.
 */
export const Mobile: Story = {
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
}

/**
 * Adjacent document integrations can open a source-backed human editor without generated copy.
 */
export const DocumentSourceDraft: Story = {
  args: {
    contextDraft: {
      body: '',
      kind: 'context',
      source: {
        actor: { displayName: '佐藤 花子', id: 'sato@example.com' },
        availability: 'available',
        capturedRevision: 7,
        containerId: 'document-onboarding-research',
        kind: 'document',
        occurredAt: '2026-06-08T02:00:00.000Z',
        originalBody: '初回利用者は次に何をすべきかを最初の画面で判断できる必要があります。',
        permalink: '/documents/document-onboarding-research',
        quote: { text: '次に何をすべきか' },
        sourceId: 'document-onboarding-research',
      },
      title: '',
    },
  },
}

/**
 * A promoted Document can atomically supersede an active item while retaining new evidence.
 */
export const DocumentEvidenceReplacement: Story = {
  args: {
    contextDraft: DocumentSourceDraft.args?.contextDraft,
    controller: {
      ...issueCollaborationControllerFixture,
      context: {
        ...issueCollaborationControllerFixture.context,
        createItem: createEvidenceReplacement,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    createEvidenceReplacement.mockClear()
    await userEvent.type(
      canvas.getByRole('textbox', { name: '短いタイトル' }),
      '調査結果で判断を更新する',
    )
    await userEvent.selectOptions(
      canvas.getByRole('combobox', {
        name: '既存の項目を置き換える（任意）',
      }),
      'context-action-1',
    )
    await userEvent.type(
      canvas.getByRole('textbox', { name: '説明と判断理由' }),
      '権限付きで取得したドキュメントの引用を新しい根拠として採用します。',
    )
    await userEvent.click(
      canvas.getByRole('button', { name: '判断を保存' }),
    )
    await expect(createEvidenceReplacement).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          kind: 'document',
          sourceId: 'document-onboarding-research',
        }),
        supersedesItemId: 'context-action-1',
      }),
    )
  },
}

/**
 * A standard Replace operation inherits the stored source snapshot without recapturing it.
 */
export const InheritedSourceReplacement: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      context: {
        ...issueCollaborationControllerFixture.context,
        createItem: createInheritedSourceReplacement,
      },
    },
    defaultTab: 'decisions',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    createInheritedSourceReplacement.mockClear()
    const replaceButton = canvas
      .getAllByRole('button', { name: '置き換え' })
      .at(0)
    if (!replaceButton) throw new Error('Missing Replace action.')
    await userEvent.click(replaceButton)
    await userEvent.click(
      canvas.getByRole('button', { name: '判断を保存' }),
    )
    await expect(createInheritedSourceReplacement).toHaveBeenCalled()
    const request = createInheritedSourceReplacement.mock.calls[0]?.[0]
    await expect(request).toHaveProperty(
      'supersedesItemId',
      'context-decision-1',
    )
    await expect(request).not.toHaveProperty('source')
  },
}
