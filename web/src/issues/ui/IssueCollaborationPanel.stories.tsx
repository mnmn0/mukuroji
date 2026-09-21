import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef, useState, type ComponentProps } from 'react'
import type {
  AiWorkItemSource,
  CreateCuratedContextItemRequest,
  CuratedContextItem,
  UpdateCuratedContextItemRequest,
} from '@mukuroji/contracts'
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test'
import { createAiAssistantSessionKey } from '../../features/ai-assistance/model/assistantSessionKey'
import { AiSummaryAssistant } from '../../features/ai-assistance/ui/AiSummaryAssistant'
import {
  acceptedResolutionHistoryFixtures,
  collaborationWorkspaceMemberFixtures,
  curatedContextRevisionFixtures,
  issueCollaborationControllerFixture,
} from '../fixtures'
import { IssueCollaborationPanel } from './IssueCollaborationPanel'
import { fileArtifactsControllerFixture, imageFileFixture } from '../../files/fixtures'
import { createTranslator } from '../../shared/i18n/i18n'
import type { TeamIssueComment, UpdateTeamIssueCommentInput } from '../api/comments'

const aiBriefSource = {
  expectedRevision: 7,
  teamId: 'core-team',
  type: 'work-item',
  workItemId: 'launch-review',
} satisfies AiWorkItemSource
const aiBriefT = createTranslator('ja')

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
const updateDecisionState = fn(
  async (
    item: CuratedContextItem,
    input: UpdateCuratedContextItemRequest,
  ) => {
    void item
    void input
    return true
  },
)
const createStoryComment = fn(async () => true)

/** Renders the collaboration panel while its comment capability is reloaded. */
function DraftCapabilityLossHarness(props: ComponentProps<typeof IssueCollaborationPanel>) {
  const [canComment, setCanComment] = useState(true)

  return (
    <>
      <button
        className="min-h-11 px-3 text-xs"
        onClick={() => setCanComment((current) => !current)}
        type="button"
      >
        権限を一時停止
      </button>
      <IssueCollaborationPanel
        {...props}
        controller={{
          ...props.controller,
          capabilities: { ...props.controller.capabilities, canComment },
        }}
      />
    </>
  )
}

/** Renders a pending root request across a temporary capability loss. */
function DraftPendingCapabilityHarness(props: ComponentProps<typeof IssueCollaborationPanel>) {
  const [canComment, setCanComment] = useState(true)
  const [requestCount, setRequestCount] = useState(0)
  const resolveRequestRef = useRef<((succeeded: boolean) => void) | undefined>(undefined)
  const controller = {
    ...props.controller,
    capabilities: { ...props.controller.capabilities, canComment },
    createComment: async () => {
      setRequestCount((current) => current + 1)
      return new Promise<boolean>((resolve) => {
        resolveRequestRef.current = resolve
      })
    },
  }

  return (
    <>
      <div className="flex gap-2">
        <button
          className="min-h-11 px-3 text-xs"
          onClick={() => setCanComment((current) => !current)}
          type="button"
        >
          権限を一時停止
        </button>
        <button
          className="min-h-11 px-3 text-xs"
          onClick={() => resolveRequestRef.current?.(true)}
          type="button"
        >
          保存を完了
        </button>
        <output data-testid="comment-request-count">{requestCount}</output>
      </div>
      <IssueCollaborationPanel {...props} controller={controller} />
    </>
  )
}

/** Renders an edit slot while the target capability is temporarily removed. */
function DraftEditCapabilityLossHarness(props: ComponentProps<typeof IssueCollaborationPanel>) {
  const [canEdit, setCanEdit] = useState(true)
  const controller = {
    ...props.controller,
    comments: props.controller.comments.map((comment) => comment.id === 'comment-1'
      ? {
          ...comment,
          capabilities: { ...comment.capabilities, canEdit },
        }
      : comment),
  }

  return (
    <>
      <button
        className="min-h-11 px-3 text-xs"
        onClick={() => setCanEdit((current) => !current)}
        type="button"
      >
        編集権限を一時停止
      </button>
      <IssueCollaborationPanel {...props} controller={controller} />
    </>
  )
}

/** Renders an unresolved thread with a gated reply request for slot ownership checks. */
function DraftTargetOwnerHarness(props: ComponentProps<typeof IssueCollaborationPanel>) {
  const [requestCount, setRequestCount] = useState(0)
  const resolveRequestRef = useRef<((succeeded: boolean) => void) | undefined>(undefined)
  const controller = {
    ...props.controller,
    comments: props.controller.comments.map((comment) =>
      comment.parentCommentId
        ? comment
        : { ...comment, resolvedAt: undefined, resolvedByMemberKey: undefined },
    ),
    createComment: async () => {
      setRequestCount((current) => current + 1)
      return new Promise<boolean>((resolve) => {
        resolveRequestRef.current = resolve
      })
    },
  }

  return (
    <>
      <button
        className="min-h-11 px-3 text-xs"
        onClick={() => resolveRequestRef.current?.(true)}
        type="button"
      >
        保存を完了
      </button>
      <output data-testid="comment-request-count">{requestCount}</output>
      <IssueCollaborationPanel {...props} controller={controller} />
    </>
  )
}

/** Renders a conflict response with a newer canonical edit revision. */
function DraftConflictHarness(props: ComponentProps<typeof IssueCollaborationPanel>) {
  const [attempts, setAttempts] = useState(0)
  const [hasConflict, setHasConflict] = useState(false)
  const [versions, setVersions] = useState<number[]>([])
  const controller = {
    ...props.controller,
    comments: props.controller.comments.map((comment) =>
      comment.id === 'comment-1' && hasConflict
        ? { ...comment, bodyMarkdown: '別のメンバーが保存した最新本文です。', version: comment.version + 1 }
        : comment,
    ),
    hasMutationError: hasConflict,
    mutationErrorStatus: hasConflict ? 409 : undefined,
    updateComment: async (_comment: TeamIssueComment, input: UpdateTeamIssueCommentInput) => {
      setAttempts((current) => current + 1)
      setVersions((current) => [...current, input.expectedVersion])
      if (!hasConflict && input.expectedVersion === 2) {
        setHasConflict(true)
        return false
      }
      if (hasConflict && input.expectedVersion === 3) {
        setHasConflict(false)
        return true
      }
      return false
    },
  }

  return (
    <>
      <output data-testid="conflict-attempt-count">{attempts}</output>
      <output data-testid="conflict-version-attempts">{versions.join(',')}</output>
      <IssueCollaborationPanel {...props} controller={controller} />
    </>
  )
}

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

/** Verifies that root text and mention insertion survive an internal tab round trip. */
export const DraftRoundTrip: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = canvas.getByRole('textbox', { name: 'コメント本文' })
    await userEvent.type(body, '保存前のコメント下書き')
    await userEvent.click(canvas.getByRole('tab', { name: /活動/ }))
    await userEvent.click(canvas.getByRole('tab', { name: /会話/ }))
    await expect(canvas.getByRole('textbox', { name: 'コメント本文' })).toHaveValue(
      '保存前のコメント下書き',
    )
    await userEvent.click(canvas.getByRole('button', { name: 'メンバーを mention' }))
    await userEvent.click(canvas.getByRole('option', { name: /佐藤 花子/ }))
    await expect(canvas.getByRole('textbox', { name: 'コメント本文' })).toHaveValue(
      '保存前のコメント下書き @佐藤 花子 ',
    )
  },
}

/** Verifies a successful root submission clears only its owned slot. */
export const DraftSuccessClearsOwnedSlot: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      createComment: createStoryComment,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    createStoryComment.mockClear()
    const body = canvas.getByRole('textbox', { name: 'コメント本文' })
    await userEvent.type(body, '送信後に消える下書き')
    await userEvent.click(canvas.getByRole('button', { name: 'プレビュー' }))
    await expect(canvas.queryByRole('textbox', { name: 'コメント本文' })).toBeNull()
    await userEvent.click(canvas.getByRole('button', { name: 'コメントを追加' }))
    await expect(createStoryComment).toHaveBeenCalledTimes(1)
    const clearedBody = await canvas.findByRole('textbox', { name: 'コメント本文' })
    await expect(clearedBody).toHaveValue('')
    await userEvent.type(clearedBody, '次の入力を受け付ける')
    await expect(clearedBody).toHaveValue('次の入力を受け付ける')
  },
}

/** Verifies that a second synchronous submit event cannot start another request. */
export const DraftSynchronousDuplicateGuard: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      createComment: createStoryComment,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    createStoryComment.mockClear()
    const body = canvas.getByRole('textbox', { name: 'コメント本文' })
    await userEvent.type(body, '同時送信を一度だけ実行')
    const form = body.closest('form')
    if (!form) throw new Error('Comment composer form is missing.')
    fireEvent.submit(form)
    fireEvent.submit(form)
    await expect(createStoryComment).toHaveBeenCalledTimes(1)
  },
}

/** Verifies that a root draft remains selectable while comment permission reloads. */
export const DraftCapabilityLossRetainsRoot: Story = {
  render: (args) => <DraftCapabilityLossHarness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = canvas.getByRole('textbox', { name: 'コメント本文' })
    await userEvent.type(body, '権限更新中も保持する本文')
    await userEvent.click(canvas.getByRole('button', { name: '権限を一時停止' }))
    await expect(canvas.getByRole('textbox', { name: 'コメント本文' })).toHaveValue(
      '権限更新中も保持する本文',
    )
    await expect(canvas.getByRole('textbox', { name: 'コメント本文' })).toHaveAttribute('readonly')
    await userEvent.click(canvas.getByRole('button', { name: '権限を一時停止' }))
    await expect(canvas.getByRole('textbox', { name: 'コメント本文' })).not.toHaveAttribute('readonly')
  },
}

/** Verifies pending ownership survives capability loss without allowing a second POST. */
export const DraftPendingCapabilityGuard: Story = {
  render: (args) => <DraftPendingCapabilityHarness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = canvas.getByRole('textbox', { name: 'コメント本文' })
    await userEvent.type(body, '権限再取得中も一度だけ送信')
    await userEvent.click(canvas.getByRole('button', { name: 'コメントを追加' }))
    await expect(canvas.getByTestId('comment-request-count')).toHaveTextContent('1')
    await userEvent.click(canvas.getByRole('button', { name: '権限を一時停止' }))
    await userEvent.click(canvas.getByRole('button', { name: '権限を一時停止' }))
    await expect(canvas.getByRole('textbox', { name: 'コメント本文' })).toBeDisabled()
    const form = canvas.getByRole('textbox', { name: 'コメント本文' }).closest('form')
    if (!form) throw new Error('Comment composer form is missing.')
    fireEvent.submit(form)
    await expect(canvas.getByTestId('comment-request-count')).toHaveTextContent('1')
    await userEvent.click(canvas.getByRole('button', { name: '保存を完了' }))
    await expect(canvas.getByRole('textbox', { name: 'コメント本文' })).toHaveValue('')
  },
}

/** Verifies mention metadata removed from an empty draft cannot prevent a later clear. */
export const DraftMentionRemovalSuccessClears: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      createComment: createStoryComment,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    createStoryComment.mockClear()
    const body = canvas.getByRole('textbox', { name: 'コメント本文' })
    await userEvent.type(body, '@')
    await userEvent.click(canvas.getByRole('option', { name: /佐藤 花子/ }))
    await userEvent.clear(body)
    await userEvent.type(body, 'メンション削除後の本文')
    await userEvent.click(canvas.getByRole('button', { name: 'コメントを追加' }))
    await expect(createStoryComment).toHaveBeenCalledTimes(1)
    await expect(canvas.getByRole('textbox', { name: 'コメント本文' })).toHaveValue('')
  },
}

/** Verifies an edit slot keeps its owned text across an internal tab round trip. */
export const DraftSameEditActivationPreservesSlot: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const threadDetails = canvas.getByTestId('comment-thread-details-comment-1')
    const summary = threadDetails.querySelector('summary')
    if (!(summary instanceof HTMLElement)) throw new Error('Resolved thread summary is missing.')
    await userEvent.click(summary)
    const commentCard = canvas.getByTestId('comment-thread-comment-1')
    const editButton = within(commentCard).getByRole('button', { name: '編集' })
    await userEvent.click(editButton)
    const editor = await canvas.findByRole('textbox', { name: 'コメントを編集' })
    if (!(editor instanceof HTMLTextAreaElement)) throw new Error('Edit composer textarea is missing.')
    fireEvent.change(editor, { target: { value: `${editor.value} 同じ編集枠を保持` } })
    await expect(editor.value).toContain('同じ編集枠を保持')
    await userEvent.click(editButton)
    const reactivatedEditor = await canvas.findByRole('textbox', { name: 'コメントを編集' })
    if (!(reactivatedEditor instanceof HTMLTextAreaElement)) throw new Error('Reactivated edit composer textarea is missing.')
    await expect(reactivatedEditor.value).toContain('同じ編集枠を保持')
    await userEvent.click(canvas.getByRole('tab', { name: /活動/ }))
    await userEvent.click(canvas.getByRole('tab', { name: /会話/ }))
    const retainedEditor = await canvas.findByRole('textbox', { name: 'コメントを編集' })
    if (!(retainedEditor instanceof HTMLTextAreaElement)) throw new Error('Retained edit composer textarea is missing.')
    await expect(retainedEditor.value).toContain('同じ編集枠を保持')
  },
}

/** Verifies an old reply completion cannot clear a replacement reply slot. */
export const DraftTargetOwnerGuard: Story = {
  render: (args) => <DraftTargetOwnerHarness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const replyButtons = canvas.getAllByRole('button', { name: '返信' })
    await userEvent.click(replyButtons[0])
    await userEvent.type(canvas.getByRole('textbox', { name: '返信本文' }), '古い返信')
    await userEvent.click(canvas.getByRole('button', { name: '返信する' }))
    await expect(canvas.getByTestId('comment-request-count')).toHaveTextContent('1')
    await expect(canvas.getByRole('textbox', { name: '返信本文' })).toBeDisabled()
    let replacementConfirmCount = 0
    let replacementConfirmMessage = ''
    const previousConfirm = window.confirm
    window.confirm = (message) => {
      replacementConfirmCount += 1
      replacementConfirmMessage = message ?? ''
      return true
    }
    try {
      await userEvent.click(canvas.getAllByRole('button', { name: '返信' })[1])
      await userEvent.click(canvas.getAllByRole('button', { name: '返信' })[0])
    } finally {
      window.confirm = previousConfirm
    }
    expect(replacementConfirmCount).toBe(1)
    expect(replacementConfirmMessage).toContain('保存していないコメントの下書きを破棄しますか？')
    await expect(canvas.getByRole('textbox', { name: '返信本文' })).toBeDisabled()
    await expect(canvas.getByRole('textbox', { name: '返信本文' })).toHaveValue('')
    await userEvent.click(canvas.getByRole('button', { name: '保存を完了' }))
    await expect(canvas.getByRole('textbox', { name: '返信本文' })).toHaveValue('')
    await userEvent.type(canvas.getByRole('textbox', { name: '返信本文' }), '新しい返信')
    await expect(canvas.getByRole('textbox', { name: '返信本文' })).toHaveValue('新しい返信')
  },
}

/** Verifies a 409 keeps the old draft until the viewer explicitly adopts the latest revision. */
export const DraftConflictRequiresExplicitRetry: Story = {
  render: (args) => <DraftConflictHarness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const details = canvas.getByTestId('comment-thread-details-comment-1')
    const summary = details.querySelector('summary')
    if (!(summary instanceof HTMLElement)) throw new Error('Resolved thread summary is missing.')
    await userEvent.click(summary)
    const commentCard = canvas.getByTestId('comment-thread-comment-1')
    await userEvent.click(within(commentCard).getByRole('button', { name: '編集' }))
    const editor = await canvas.findByRole('textbox', { name: 'コメントを編集' })
    if (!(editor instanceof HTMLTextAreaElement)) throw new Error('Edit composer textarea is missing.')
    fireEvent.change(editor, { target: { value: `${editor.value} 自分の変更` } })
    await userEvent.click(canvas.getByRole('button', { name: '編集を保存' }))
    await expect(canvas.getByRole('alert')).toHaveTextContent('別のメンバーが先に更新しました')
    await expect(canvas.getByText('別のメンバーが保存した最新本文です。')).toBeVisible()
    await expect(canvas.getByRole('button', { name: '表示した最新版を確認して編集を続ける' })).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: '編集を保存' }))
    await expect(canvas.getByTestId('conflict-attempt-count')).toHaveTextContent('2')
    await expect(canvas.getByTestId('conflict-version-attempts')).toHaveTextContent('2,2')
    const retainedEditor = canvas.getByRole('textbox', { name: 'コメントを編集' })
    if (!(retainedEditor instanceof HTMLTextAreaElement)) throw new Error('Edit composer textarea is missing after conflict.')
    await waitFor(() => expect(retainedEditor.value).toContain('自分の変更'))
    await userEvent.click(canvas.getByRole('button', { name: '表示した最新版を確認して編集を続ける' }))
    await userEvent.click(canvas.getByRole('button', { name: '編集を保存' }))
    await expect(canvas.getByTestId('conflict-attempt-count')).toHaveTextContent('3')
    await expect(canvas.getByTestId('conflict-version-attempts')).toHaveTextContent('2,2,3')
    await expect(canvas.queryByRole('textbox', { name: 'コメントを編集' })).toBeNull()
  },
}

/** Verifies an existing author can edit while creating new comments is unavailable. */
export const DraftEditRetainsWhenCommentCreationUnavailable: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      capabilities: {
        ...issueCollaborationControllerFixture.capabilities,
        canComment: false,
      },
    },
  },
  render: (args) => <DraftEditCapabilityLossHarness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const details = canvas.getByTestId('comment-thread-details-comment-1')
    const summary = details.querySelector('summary')
    if (!(summary instanceof HTMLElement)) throw new Error('Resolved thread summary is missing.')
    await userEvent.click(summary)
    const commentCard = canvas.getByTestId('comment-thread-comment-1')
    await userEvent.click(within(commentCard).getByRole('button', { name: '編集' }))
    const editor = await canvas.findByRole('textbox', { name: 'コメントを編集' })
    if (!(editor instanceof HTMLTextAreaElement)) throw new Error('Edit composer textarea is missing.')
    await userEvent.type(editor, ' 編集可能')
    await waitFor(() => expect(editor.value).toContain('編集可能'))
    await userEvent.click(canvas.getByRole('button', { name: '編集権限を一時停止' }))
    const retainedEditor = canvas.getByRole('textbox', { name: 'コメントを編集' })
    await expect(retainedEditor).toHaveAttribute('readonly')
    await expect(canvas.getByRole('status')).toHaveTextContent('現在編集できません')
    if (!(retainedEditor instanceof HTMLTextAreaElement)) throw new Error('Retained edit composer textarea is missing.')
    await expect(retainedEditor.value).toContain('編集可能')
    await userEvent.click(canvas.getByRole('button', { name: '編集権限を一時停止' }))
    await expect(canvas.getByRole('textbox', { name: 'コメントを編集' })).not.toHaveAttribute('readonly')
    await userEvent.click(canvas.getByRole('tab', { name: /活動/ }))
    await userEvent.click(canvas.getByRole('tab', { name: /会話/ }))
    const restoredEditor = await canvas.findByRole('textbox', { name: 'コメントを編集' })
    if (!(restoredEditor instanceof HTMLTextAreaElement)) throw new Error('Edit composer textarea is missing after tab switch.')
    await waitFor(() => expect(restoredEditor.value).toContain('編集可能'))
    await userEvent.click(canvas.getByRole('button', { name: '編集を保存' }))
    await expect(canvas.queryByRole('textbox', { name: 'コメントを編集' })).toBeNull()
  },
}

/** Explicit, revision-fenced Work Item Brief generation entry point. */
export const AiBrief: Story = {
  args: {
    aiAssistance: {
      renderBrief: (onAdopt) => (
        <AiSummaryAssistant
          accessToken="storybook-access-token"
          adoptLabel={aiBriefT('ai.summary.adoptContext')}
          key={createAiAssistantSessionKey(aiBriefSource)}
          locale="ja"
          onAdopt={onAdopt}
          sources={[aiBriefSource]}
          t={aiBriefT}
        />
      ),
      sessionKey: createAiAssistantSessionKey(aiBriefSource),
    },
    defaultTab: 'brief',
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
 * An in-place edit can move a non-superseded decision through its lifecycle.
 */
export const EditDecisionState: Story = {
  args: {
    controller: {
      ...issueCollaborationControllerFixture,
      context: {
        ...issueCollaborationControllerFixture.context,
        updateItem: updateDecisionState,
      },
    },
    defaultTab: 'decisions',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    updateDecisionState.mockClear()
    const editButton = canvas.getAllByRole('button', { name: '編集' }).at(0)
    if (!editButton) throw new Error('Missing Edit action.')
    await userEvent.click(editButton)
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: '状態' }),
      'completed',
    )
    await userEvent.click(
      canvas.getByRole('button', { name: '判断を保存' }),
    )
    await expect(updateDecisionState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'context-decision-1' }),
      expect.objectContaining({ state: 'completed' }),
    )
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
