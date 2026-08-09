import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { AcceptedResolution } from '@mukuroji/contracts'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../../workspace/api'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { CheckCircleIcon } from '../../shared/ui/icons'
import type {
  CreateTeamIssueCommentInput,
  TeamIssueComment,
  TeamIssueCommentReaction,
} from '../api'
import { SafeCommentBody } from './SafeCommentBody'
import type { IssueCollaborationController } from '../mutations/useIssueCollaboration'
import type { AcceptedResolutionHistoryState } from '../mutations/useIssueContext'
import {
  formatIssueMentionLabel,
  resolveIssueMentionMemberKeys,
} from '../model/commentMentions'
import {
  advanceDeepLinkTraversal,
  type DeepLinkTraversalState,
} from '../model/deepLinkTraversal'

const supportedReactions = ['👍', '❤️', '🎉', '👀', '✅'] as const

/**
 * Conversation tab props for Work Item collaboration.
 */
export type IssueConversationTabProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * mention 候補と actor 表示に使う Workspace member 一覧です。
   */
  members: WorkspaceMember[]
  /**
   * 現在の Workspace member key です。
   */
  currentMemberKey?: string
  /**
   * polling data と collaboration action をまとめた controller です。
   */
  controller: IssueCollaborationController
  /**
   * 保存済み comment の file 添付と表示に使う controller です。
   */
  artifacts?: FileArtifactsController
  /**
   * 権限不足などで comment が使えない理由です。
   */
  readOnlyMessage?: string
  /**
   * notification deep link から focus する comment ID です。
   */
  focusedCommentId?: string
  /**
   * notification deep link の reply が属する root comment ID です。
   */
  focusedRootCommentId?: string
  /**
   * 外側の layout から追加する class name です。
   */
  className?: string
  /**
   * Promotes a comment or reply into a human-curated context item draft.
   */
  onPromoteComment?: (comment: TeamIssueComment) => void
  /**
   * Whether the current viewer may choose or replace an accepted resolution.
   */
  canAcceptResolution?: boolean
  /**
   * Persists a required manual summary for a selected resolution comment.
   */
  onSetAcceptedResolution?: (
    rootComment: TeamIssueComment,
    sourceComment: TeamIssueComment,
    summary: string,
  ) => Promise<boolean>
  /**
   * Whether the latest accepted-resolution mutation failed.
   */
  hasResolutionError?: boolean
  /**
   * HTTP status from the latest accepted-resolution mutation failure.
   */
  resolutionErrorStatus?: number
}

/**
 * Inline editor state for selecting, replacing, or editing an accepted resolution.
 */
type ResolutionEditorState = {
  /** Root thread that owns the resolution. */
  rootComment: TeamIssueComment
  /** Exact comment or reply selected as the conclusion. */
  sourceComment: TeamIssueComment
  /** Required human-authored summary. */
  summary: string
}

/**
 * Accepted-resolution source requested from a summary link, including unloaded replies.
 */
type ResolutionSourceTarget = {
  /** Accepted comment or reply to load and focus. */
  commentId: string
  /** Root thread that owns the accepted source. */
  rootCommentId: string
}

/**
 * Renders comment threads, mentions, reactions, files, and the comment composer.
 */
export function IssueConversationTab({
  artifacts,
  canAcceptResolution = false,
  className = '',
  controller,
  currentMemberKey,
  focusedCommentId,
  focusedRootCommentId,
  hasResolutionError = false,
  locale,
  members,
  onPromoteComment,
  onSetAcceptedResolution,
  readOnlyMessage,
  resolutionErrorStatus,
}: IssueConversationTabProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [replyingToId, setReplyingToId] = useState<string | undefined>()
  const [editingId, setEditingId] = useState<string | undefined>()
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | undefined>()
  const [reactionMenuId, setReactionMenuId] = useState<string | undefined>()
  const [resolutionEditor, setResolutionEditor] = useState<ResolutionEditorState>()
  const [resolutionSourceTarget, setResolutionSourceTarget] =
    useState<ResolutionSourceTarget>()
  const [isResolutionSaving, setIsResolutionSaving] = useState(false)
  const focusLoadRequestRef = useRef<string | undefined>(undefined)
  const focusedCommentTargetRef = useRef<string | undefined>(undefined)
  const rootDeepLinkTraversalRef = useRef<DeepLinkTraversalState>({
    requestedPages: 0,
  })
  const replyDeepLinkTraversalRef = useRef<DeepLinkTraversalState>({
    requestedPages: 0,
  })
  const resolutionReturnFocusRef = useRef<HTMLElement | undefined>(undefined)
  const threads = useMemo(() => createCommentThreads(controller.comments), [controller.comments])
  const uniquePresence = useMemo(
    () => Array.from(new Map(controller.presence.map((presence) => [presence.memberKey, presence])).values()),
    [controller.presence],
  )
  const typingPresence = uniquePresence.filter((presence) =>
    presence.typing && presence.memberKey !== currentMemberKey,
  )
  const canCreateComment = controller.capabilities.canComment && !readOnlyMessage
  const focusComments = controller.comments
  const focusHasLoadError = controller.hasLoadError
  const focusHasMore = controller.hasMore
  const focusIsLoading = controller.isLoading
  const focusIsLoadingMore = controller.isLoadingMore
  const focusLoadMore = controller.loadMore
  const focusLoadMoreReplies = controller.loadMoreReplies
  const focusReplyPagination = controller.replyPagination
  const focusedCommentTargetId =
    focusedCommentId ?? resolutionSourceTarget?.commentId
  const focusedRootTargetId =
    focusedRootCommentId ?? resolutionSourceTarget?.rootCommentId

  /**
   * Opens the accepted-resolution editor and remembers its keyboard trigger.
   *
   * @param editor - Resolution source and manual summary starting values.
   * @param trigger - Control that should regain focus after close.
   */
  function openResolutionEditor(
    editor: ResolutionEditorState,
    trigger: HTMLElement,
  ) {
    resolutionReturnFocusRef.current = trigger
    setResolutionEditor(editor)
  }

  /**
   * Closes the accepted-resolution editor and restores keyboard focus.
   */
  function closeResolutionEditor() {
    const returnTarget = resolutionReturnFocusRef.current
    setResolutionEditor(undefined)
    window.requestAnimationFrame(() => {
      if (returnTarget?.isConnected) {
        returnTarget.focus()
        return
      }
      const sourceId = resolutionEditor?.sourceComment.id
      if (sourceId) {
        document.getElementById(createCommentAnchorId(sourceId))?.focus()
      }
    })
  }

  useEffect(() => {
    if (!focusedCommentTargetId) {
      focusLoadRequestRef.current = undefined
      focusedCommentTargetRef.current = undefined
      rootDeepLinkTraversalRef.current = { requestedPages: 0 }
      replyDeepLinkTraversalRef.current = { requestedPages: 0 }
      return
    }

    if (
      focusedCommentTargetRef.current === focusedCommentTargetId ||
      focusIsLoading ||
      focusHasLoadError
    ) {
      return
    }

    const target = document.getElementById(
      createCommentAnchorId(focusedCommentTargetId),
    )

    if (!target) {
      const rootLoaded = focusedRootTargetId
        ? focusComments.some((comment) => comment.id === focusedRootTargetId)
        : false
      const replyPagination = focusedRootTargetId
        ? focusReplyPagination[focusedRootTargetId]
        : undefined

      if (
        focusedRootTargetId &&
        rootLoaded &&
        replyPagination?.hasMore &&
        !replyPagination.isLoading
      ) {
        const requestKey = `reply:${focusedCommentTargetId}:${focusedRootTargetId}:${focusComments.length}`

        if (focusLoadRequestRef.current !== requestKey) {
          const traversal = advanceDeepLinkTraversal(
            replyDeepLinkTraversalRef.current,
            `reply:${focusedRootTargetId}:${focusedCommentTargetId}`,
            true,
          )
          replyDeepLinkTraversalRef.current = traversal.state

          if (traversal.shouldLoad) {
            focusLoadRequestRef.current = requestKey
            void focusLoadMoreReplies(focusedRootTargetId)
          }
        }
      } else if (!rootLoaded && focusHasMore && !focusIsLoadingMore) {
        const requestKey = `root:${focusedCommentTargetId}:${focusComments.length}`

        if (focusLoadRequestRef.current !== requestKey) {
          const traversal = advanceDeepLinkTraversal(
            rootDeepLinkTraversalRef.current,
            `root:${focusedRootTargetId ?? '*'}:${focusedCommentTargetId}`,
            true,
          )
          rootDeepLinkTraversalRef.current = traversal.state

          if (traversal.shouldLoad) {
            focusLoadRequestRef.current = requestKey
            void focusLoadMore()
          }
        }
      }

      return
    }

    focusLoadRequestRef.current = undefined
    const frameId = window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'auto', block: 'center' })
      target.focus({ preventScroll: true })
      focusedCommentTargetRef.current = focusedCommentTargetId
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [
    focusComments,
    focusHasLoadError,
    focusHasMore,
    focusIsLoading,
    focusIsLoadingMore,
    focusLoadMore,
    focusLoadMoreReplies,
    focusReplyPagination,
    focusedCommentTargetId,
    focusedRootTargetId,
  ])

  return (
    <section
      aria-label={t('collaboration.tabs.conversation')}
      className={`bg-white ${className}`}
      data-testid="issue-conversation-tab"
    >
      <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
        {canCreateComment ? (
          <CommentComposer
            key="root-comment-composer"
            labelKey="collaboration.composer.label"
            members={members}
            onCancel={undefined}
            onSubmit={controller.createComment}
            onTyping={controller.markTyping}
            submitKey="collaboration.composer.submit"
            t={t}
          />
        ) : (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">
            {readOnlyMessage ?? t('collaboration.readOnly')}
          </p>
        )}
        {typingPresence.length > 0 ? (
          <p className="mt-2 text-xs font-semibold text-[#16766f]" aria-live="polite">
            {formatTypingLabel(typingPresence.map((presence) => presence.memberKey), members, t)}
          </p>
        ) : null}
      </div>

      {controller.hasLoadError ? (
        <div className="mx-5 mt-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2.5">
          <p className="text-sm font-semibold text-red-700">{t('collaboration.error.load')}</p>
          <button
            className="text-xs font-bold text-red-700 underline underline-offset-2"
            onClick={() => void controller.refresh()}
            type="button"
          >
            {t('collaboration.retry')}
          </button>
        </div>
      ) : null}
      {controller.hasMutationError ? (
        <p className="mx-5 mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-700" role="alert">
          {t(controller.mutationErrorStatus === 409
            ? 'collaboration.error.conflict'
            : 'collaboration.error.mutation')}
        </p>
      ) : null}

      <div className="grid gap-3 px-5 py-4">
        {controller.hasLoadError ? null : controller.isLoading ? (
          <CollaborationSkeleton />
        ) : threads.length > 0 ? (
          threads.map((thread) => {
            const replyPagination = controller.replyPagination[thread.root.id]
            const acceptedResolution = resolveCurrentAcceptedResolution(
              thread.root,
            )
            const canManageAcceptedResolution =
              Boolean(onSetAcceptedResolution) &&
              controller.capabilities.canComment &&
              (canAcceptResolution ||
                (currentMemberKey !== undefined &&
                  thread.root.authorMemberKey === currentMemberKey))

            return (
              <article
              className={`overflow-hidden rounded-md border ${
                thread.root.resolvedAt
                  ? 'border-[#99d7cf] bg-[#f4fbfa]'
                  : 'border-[var(--workbench-border)] bg-white'
              }`}
              data-testid={`comment-thread-${thread.root.id}`}
              key={thread.root.id}
            >
              {acceptedResolution ? (
                <AcceptedResolutionSummary
                  canEdit={canManageAcceptedResolution}
                  history={controller.context.acceptedResolutionHistory}
                  locale={locale}
                  onEdit={(trigger) => {
                    const sourceComment = controller.comments.find(
                      (comment) =>
                        comment.id ===
                        acceptedResolution.sourceCommentId,
                    )
                    openResolutionEditor(
                      {
                        rootComment: thread.root,
                        sourceComment:
                          sourceComment ??
                          createCapturedResolutionSourceComment(
                            acceptedResolution,
                          ),
                        summary: acceptedResolution.summary,
                      },
                      trigger,
                    )
                  }}
                  onOpenSource={(resolution) =>
                    setResolutionSourceTarget({
                      commentId: resolution.sourceCommentId,
                      rootCommentId: resolution.sourceRootCommentId,
                    })
                  }
                  onLoadMoreHistory={
                    controller.context.loadMoreAcceptedResolutions
                  }
                  onRetryHistory={
                    controller.context.retryAcceptedResolutionHistory
                  }
                  onToggleHistory={() => {
                    if (
                      controller.context.acceptedResolutionHistory
                        .rootCommentId === thread.root.id
                    ) {
                      controller.context.closeAcceptedResolutionHistory()
                    } else {
                      controller.context.openAcceptedResolutionHistory(
                        thread.root.id,
                      )
                    }
                  }}
                  resolution={acceptedResolution}
                  t={t}
                />
              ) : null}
              {resolutionEditor?.rootComment.id === thread.root.id ? (
                <form
                  className="grid gap-2 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (
                      !onSetAcceptedResolution ||
                      !resolutionEditor.summary.trim()
                    ) {
                      return
                    }
                    setIsResolutionSaving(true)
                    void onSetAcceptedResolution(
                      resolutionEditor.rootComment,
                      resolutionEditor.sourceComment,
                      resolutionEditor.summary.trim(),
                    ).then((succeeded) => {
                      setIsResolutionSaving(false)
                      if (succeeded) closeResolutionEditor()
                    })
                  }}
                >
                  <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
                    {t('collaboration.resolution.summary')}
                    <textarea
                      autoFocus
                      className="workbench-input min-h-24 resize-y py-2"
                      disabled={isResolutionSaving}
                      maxLength={20_000}
                      onChange={(event) =>
                        setResolutionEditor((current) =>
                          current
                            ? { ...current, summary: event.target.value }
                            : current,
                        )
                      }
                      placeholder={t('collaboration.resolution.summaryPlaceholder')}
                      required
                      value={resolutionEditor.summary}
                    />
                  </label>
                  <p className="text-[0.68rem] text-[var(--workbench-muted)]">
                    {t('collaboration.resolution.sourceReply')}: {formatMemberName(
                      findWorkspaceMember(
                        resolveCommentAuthorKey(resolutionEditor.sourceComment),
                        members,
                      ),
                      resolveCommentAuthorKey(resolutionEditor.sourceComment),
                    )}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className="workbench-button-primary min-h-[44px] px-3 text-xs"
                      disabled={
                        isResolutionSaving ||
                        !resolutionEditor.summary.trim()
                      }
                      type="submit"
                    >
                      {t(
                        isResolutionSaving
                          ? 'collaboration.saving'
                          : 'collaboration.resolution.save',
                      )}
                    </button>
                    <button
                      className="min-h-[44px] px-2 text-xs font-semibold text-[var(--workbench-muted)]"
                      disabled={isResolutionSaving}
                      onClick={closeResolutionEditor}
                      type="button"
                    >
                      {t('collaboration.cancel')}
                    </button>
                  </div>
                  {hasResolutionError ? (
                    <p
                      className="border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"
                      role="alert"
                    >
                      {t(
                        resolutionErrorStatus === 409
                          ? 'collaboration.error.conflict'
                          : 'collaboration.error.mutation',
                      )}
                    </p>
                  ) : null}
                </form>
              ) : null}
              <details
                className="group"
                open={
                  !thread.root.resolvedAt ||
                  focusedCommentTargetId === thread.root.id ||
                  thread.replies.some(
                    (reply) => reply.id === focusedCommentTargetId,
                  ) ||
                  resolutionEditor?.rootComment.id === thread.root.id
                }
              >
                {thread.root.resolvedAt ? (
                  <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 border-b border-[#c6e8e3] bg-[#e5f7f4] px-3 py-2 text-xs font-semibold text-[#116b63] marker:hidden">
                    <CheckCircleIcon className="h-4 w-4 fill-none stroke-current stroke-[1.8]" />
                    <span>{t('collaboration.thread.resolved')}</span>
                    <span className="ml-auto text-[0.68rem] text-[var(--workbench-muted)]">
                      {t('collaboration.thread.commentCount').replace(
                        '{count}',
                        String(thread.replies.length + 1),
                      )}
                    </span>
                  </summary>
                ) : null}
              <CommentCard
                artifacts={artifacts}
                comment={thread.root}
                controller={controller}
                deleteConfirmationId={deleteConfirmationId}
                editingId={editingId}
                focused={focusedCommentTargetId === thread.root.id}
                locale={locale}
                members={members}
                onDeleteConfirmationChange={setDeleteConfirmationId}
                onEditingChange={setEditingId}
                onReactionMenuChange={setReactionMenuId}
                onReplyingChange={setReplyingToId}
                onPromote={onPromoteComment}
                reactionMenuId={reactionMenuId}
                replyingToId={replyingToId}
                rootComment={thread.root}
                t={t}
              />
              {thread.replies.length > 0 || replyPagination?.hasMore ? (
                <div className="ml-5 border-l-2 border-[#c6e8e3] bg-[#fbfcfd]">
                  {thread.replies.map((reply) => (
                    <CommentCard
                      artifacts={artifacts}
                      comment={reply}
                      controller={controller}
                      deleteConfirmationId={deleteConfirmationId}
                      editingId={editingId}
                      focused={focusedCommentTargetId === reply.id}
                      isReply
                      key={reply.id}
                      locale={locale}
                      members={members}
                      onDeleteConfirmationChange={setDeleteConfirmationId}
                      onEditingChange={setEditingId}
                      onReactionMenuChange={setReactionMenuId}
                      onReplyingChange={setReplyingToId}
                      onPromote={onPromoteComment}
                      onAcceptResolution={
                        canManageAcceptedResolution
                          ? (sourceComment, trigger) =>
                              openResolutionEditor(
                                {
                                  rootComment: thread.root,
                                  sourceComment,
                                  summary: '',
                                },
                                trigger,
                              )
                          : undefined
                      }
                      reactionMenuId={reactionMenuId}
                      replyingToId={replyingToId}
                      rootComment={thread.root}
                      t={t}
                    />
                  ))}
                  {replyPagination?.hasMore ? (
                    <button
                      className="mx-3 mb-3 mt-2 text-xs font-semibold text-[#16766f] underline decoration-[#99d7cf] underline-offset-2 disabled:opacity-60"
                      disabled={replyPagination.isLoading}
                      onClick={() => void controller.loadMoreReplies(thread.root.id)}
                      type="button"
                    >
                      {t(replyPagination.isLoading
                        ? 'collaboration.loadingMore'
                        : 'collaboration.reply.loadMore')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              </details>
            </article>
            )
          })
        ) : (
          <div className="rounded-md border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] px-4 py-7 text-center">
            <p className="text-sm font-semibold text-[var(--workbench-text)]">{t('collaboration.empty.title')}</p>
            <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
              {t(
                canCreateComment
                  ? 'collaboration.empty.description'
                  : 'collaboration.empty.readOnlyDescription',
              )}
            </p>
          </div>
        )}
        {controller.hasMore ? (
          <button
            className="workbench-button-secondary h-9 justify-self-center px-4 disabled:opacity-60"
            disabled={controller.isLoadingMore}
            onClick={() => void controller.loadMore()}
            type="button"
          >
            {t(controller.isLoadingMore ? 'collaboration.loadingMore' : 'collaboration.loadMore')}
          </button>
        ) : null}
      </div>
    </section>
  )
}

/**
 * ルートコメントとその reply です。
 */
type CommentThread = {
  /**
   * thread のルートコメントです。
   */
  root: TeamIssueComment
  /**
   * thread に属する reply です。
   */
  replies: TeamIssueComment[]
}

/**
 * CommentCard の props です。
 */
type CommentCardProps = {
  /**
   * Comment file attachment を読み書きする controller です。
   */
  artifacts?: FileArtifactsController
  /**
   * 表示する comment です。
   */
  comment: TeamIssueComment
  /**
   * thread root です。
   */
  rootComment: TeamIssueComment
  /**
   * collaboration data と action です。
   */
  controller: IssueCollaborationController
  /**
   * Workspace member 一覧です。
   */
  members: WorkspaceMember[]
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * reply 表示かどうかです。
   */
  isReply?: boolean
  /**
   * 編集中の comment ID です。
   */
  editingId?: string
  /**
   * notification deep link の focus 対象かどうかです。
   */
  focused?: boolean
  /**
   * reply composer を開いている comment ID です。
   */
  replyingToId?: string
  /**
   * reaction menu を開いている comment ID です。
   */
  reactionMenuId?: string
  /**
   * delete 確認中の comment ID です。
   */
  deleteConfirmationId?: string
  /**
   * 編集対象を変更します。
   */
  onEditingChange: (commentId?: string) => void
  /**
   * reply 対象を変更します。
   */
  onReplyingChange: (commentId?: string) => void
  /**
   * reaction menu 対象を変更します。
   */
  onReactionMenuChange: (commentId?: string) => void
  /**
   * delete 確認対象を変更します。
   */
  onDeleteConfirmationChange: (commentId?: string) => void
  /**
   * Promotes the comment into a curated context draft.
   */
  onPromote?: (comment: TeamIssueComment) => void
  /**
   * Opens the required-summary editor for this resolution candidate.
   */
  onAcceptResolution?: (
    comment: TeamIssueComment,
    trigger: HTMLButtonElement,
  ) => void
  /**
   * i18n translator です。
   */
  t: (key: MessageKey) => string
}

function CommentCard({
  artifacts,
  comment,
  controller,
  deleteConfirmationId,
  editingId,
  focused = false,
  isReply = false,
  locale,
  members,
  onDeleteConfirmationChange,
  onAcceptResolution,
  onEditingChange,
  onPromote,
  onReactionMenuChange,
  onReplyingChange,
  reactionMenuId,
  replyingToId,
  rootComment,
  t,
}: CommentCardProps) {
  const authorMemberKey = resolveCommentAuthorKey(comment)
  const author = findWorkspaceMember(authorMemberKey, members)
  const capabilities = comment.capabilities
  const isEditing = editingId === comment.id
  const isReplying = replyingToId === comment.id
  const isConfirmingDelete = deleteConfirmationId === comment.id
  const isReactionMenuOpen = reactionMenuId === comment.id
  const canReply = controller.capabilities.canComment
    && (capabilities?.canReply ?? comment.source !== 'legacy')
    && !rootComment.resolvedAt
    && !comment.deletedAt
  const canReact = controller.capabilities.canReact
    && (capabilities?.canReact ?? comment.source !== 'legacy')
    && !comment.deletedAt
  const bodyMarkdown = resolveCommentBody(comment)
  const acceptedResolution = resolveCurrentAcceptedResolution(rootComment)
  const isAcceptedResolution =
    acceptedResolution?.sourceCommentId === comment.id

  return (
    <div
      className={`min-w-0 p-3 outline-none transition ${
        isReply ? 'border-t border-[var(--workbench-border)] first:border-t-0' : ''
      } ${focused ? 'bg-[#e5f7f4] ring-2 ring-inset ring-[#72c9bf]' : ''}`}
      data-focused={focused || undefined}
      id={createCommentAnchorId(comment.id)}
      tabIndex={-1}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <MemberAvatar memberKey={authorMemberKey} members={members} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-xs font-semibold text-[var(--workbench-text)]">
              {formatMemberName(author, authorMemberKey)}
            </p>
            {author?.status === 'deactivated' || !author ? (
              <span className="rounded bg-[#eef2f5] px-1.5 py-0.5 text-[0.65rem] font-semibold text-[var(--workbench-muted)]">
                {t('collaboration.member.inactive')}
              </span>
            ) : null}
            <time
              className="text-[0.68rem] font-medium text-[var(--workbench-muted-soft)]"
              dateTime={comment.createdAt}
              title={formatCommentDate(comment.createdAt, locale, true)}
            >
              {formatCommentDate(comment.createdAt, locale, false)}
            </time>
            {comment.editedAt ? (
              <span className="text-[0.68rem] font-medium text-[var(--workbench-muted-soft)]">
                {t('collaboration.comment.edited')}
              </span>
            ) : null}
            {isAcceptedResolution ? (
              <span className="workbench-badge-success">
                {t('collaboration.resolution.accepted')}
              </span>
            ) : null}
          </div>

          {isEditing ? (
            <div className="mt-2">
              <CommentComposer
                initialBodyMarkdown={bodyMarkdown}
                initialMentionMemberKeys={comment.mentionMemberKeys}
                key={`edit-${comment.id}-${comment.version ?? 1}`}
                labelKey="collaboration.edit.label"
                members={members}
                onCancel={() => onEditingChange(undefined)}
                onSubmit={async (input) => {
                  const succeeded = await controller.updateComment(comment, {
                    bodyMarkdown: input.bodyMarkdown,
                    expectedVersion: comment.version ?? 1,
                    mentionMemberKeys: input.mentionMemberKeys,
                  })

                  if (succeeded) {
                    onEditingChange(undefined)
                  }

                  return succeeded
                }}
                onTyping={controller.markTyping}
                submitKey="collaboration.edit.save"
                t={t}
              />
            </div>
          ) : comment.deletedAt ? (
            <p className="mt-2 rounded-md border border-dashed border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2 text-sm italic text-[var(--workbench-muted)]">
              {t('collaboration.comment.deleted')}
            </p>
          ) : (
            <SafeCommentBody bodyMarkdown={bodyMarkdown} className="mt-2" />
          )}

          {!comment.deletedAt && artifacts ? (
            <CommentFileAttachments
              artifacts={artifacts}
              comment={comment}
              t={t}
            />
          ) : null}

          {!isEditing ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {(comment.reactions ?? []).map((reaction) => (
                <ReactionButton
                  canReact={canReact}
                  comment={comment}
                  controller={controller}
                  key={reaction.emoji}
                  reaction={reaction}
                  t={t}
                />
              ))}
              {canReact ? (
                <div className="relative">
                  <button
                    aria-expanded={isReactionMenuOpen}
                    aria-label={t('collaboration.reaction.add')}
                    className="grid h-7 w-7 place-items-center rounded-full border border-[var(--workbench-border)] bg-white text-sm text-[var(--workbench-muted)] transition hover:border-[#99d7cf] hover:bg-[#e5f7f4]"
                    onClick={() => onReactionMenuChange(isReactionMenuOpen ? undefined : comment.id)}
                    type="button"
                  >
                    +
                  </button>
                  {isReactionMenuOpen ? (
                    <div
                      aria-label={t('collaboration.reaction.menu')}
                      className="absolute bottom-9 left-0 z-20 flex gap-1 rounded-md border border-[var(--workbench-border)] bg-white p-1.5 shadow-[0_12px_30px_rgba(38,51,63,0.16)]"
                      role="menu"
                    >
                      {supportedReactions.map((emoji) => {
                        const reaction = comment.reactions?.find((item) => item.emoji === emoji)

                        return (
                          <button
                            aria-label={`${t('collaboration.reaction.add')} ${emoji}`}
                            className="grid h-8 w-8 place-items-center rounded text-base hover:bg-[var(--workbench-surface-muted)]"
                            key={emoji}
                            onClick={() => {
                              onReactionMenuChange(undefined)
                              void controller.toggleReaction(comment, emoji, reaction?.reactedByMe ?? false)
                            }}
                            role="menuitem"
                            type="button"
                          >
                            {emoji}
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {canReply ? (
                <CommentActionButton
                  label={t('collaboration.comment.reply')}
                  onClick={() => onReplyingChange(isReplying ? undefined : comment.id)}
                />
              ) : null}
              {onPromote && !comment.deletedAt && comment.source !== 'legacy' ? (
                <CommentActionButton
                  label={t('collaboration.comment.promote')}
                  onClick={() => onPromote(comment)}
                  tone="primary"
                />
              ) : null}
              {isReply && onAcceptResolution && !comment.deletedAt ? (
                <CommentActionButton
                  label={t(
                    acceptedResolution
                      ? 'collaboration.resolution.replace'
                      : 'collaboration.resolution.select',
                  )}
                  onClick={(trigger) => onAcceptResolution(comment, trigger)}
                  tone="primary"
                />
              ) : null}
              {capabilities?.canEdit && !comment.deletedAt ? (
                <CommentActionButton
                  label={t('collaboration.comment.edit')}
                  onClick={() => onEditingChange(comment.id)}
                />
              ) : null}
              {capabilities?.canDelete && !comment.deletedAt ? (
                <CommentActionButton
                  label={t('collaboration.comment.delete')}
                  onClick={() => onDeleteConfirmationChange(comment.id)}
                />
              ) : null}
              {!isReply && capabilities?.canResolve && !comment.deletedAt ? (
                <CommentActionButton
                  label={t(comment.resolvedAt ? 'collaboration.thread.reopen' : 'collaboration.thread.resolve')}
                  onClick={() => void controller.setResolved(comment, !comment.resolvedAt)}
                  tone="primary"
                />
              ) : null}
            </div>
          ) : null}

          {isConfirmingDelete ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
              <p className="mr-auto text-xs font-semibold text-red-700">{t('collaboration.delete.confirm')}</p>
              <button
                className="text-xs font-semibold text-[var(--workbench-muted)]"
                onClick={() => onDeleteConfirmationChange(undefined)}
                type="button"
              >
                {t('collaboration.cancel')}
              </button>
              <button
                className="rounded bg-red-700 px-2.5 py-1.5 text-xs font-semibold text-white"
                onClick={() => {
                  void controller.deleteComment(comment).then((succeeded) => {
                    if (succeeded) {
                      onDeleteConfirmationChange(undefined)
                    }
                  })
                }}
                type="button"
              >
                {t('collaboration.delete.action')}
              </button>
            </div>
          ) : null}

          {isReplying ? (
            <div className="mt-3 rounded-md border border-[#c6e8e3] bg-[#f4fbfa] p-3">
              <CommentComposer
                key={`reply-${comment.id}`}
                labelKey="collaboration.reply.label"
                members={members}
                onCancel={() => onReplyingChange(undefined)}
                onSubmit={async (input) => {
                  const succeeded = await controller.createComment({
                    ...input,
                    parentCommentId: comment.id,
                  })

                  if (succeeded) {
                    onReplyingChange(undefined)
                  }

                  return succeeded
                }}
                onTyping={controller.markTyping}
                submitKey="collaboration.reply.submit"
                t={t}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Props for the accepted-resolution summary attached to one root thread.
 */
type AcceptedResolutionSummaryProps = {
  /** Current accepted resolution. */
  resolution: AcceptedResolution
  /** Independently loaded accepted-resolution history. */
  history: AcceptedResolutionHistoryState
  /** Whether the viewer may replace the summary or source reply. */
  canEdit: boolean
  /** Locale used for timestamps. */
  locale: Locale
  /** Opens the required manual summary editor. */
  onEdit: (trigger: HTMLButtonElement) => void
  /** Loads and focuses a current or superseded source reply. */
  onOpenSource: (resolution: AcceptedResolution) => void
  /** Toggles the independently paginated audit history. */
  onToggleHistory: () => void
  /** Loads the next page of older accepted resolutions. */
  onLoadMoreHistory: () => Promise<void>
  /** Retries the selected accepted-resolution history. */
  onRetryHistory: () => Promise<void>
  /** Collaboration translator. */
  t: (key: MessageKey) => string
}

/**
 * Renders the authoritative thread conclusion and its superseded history.
 *
 * @param props - Current resolution, history, locale, and edit action.
 * @returns A compact accepted-resolution strip.
 */
function AcceptedResolutionSummary({
  canEdit,
  history,
  locale,
  onEdit,
  onLoadMoreHistory,
  onOpenSource,
  onRetryHistory,
  onToggleHistory,
  resolution,
  t,
}: AcceptedResolutionSummaryProps) {
  const historyIsOpen =
    history.rootCommentId === resolution.sourceRootCommentId
  const priorResolutions = history.items.filter(
    (item) => item.id !== resolution.id || item.state !== resolution.state,
  )

  return (
    <div
      className="border-b border-[#c6e8e3] border-l-[3px] border-l-[var(--workbench-primary)] bg-[#f4fbfa] px-3 py-3"
      data-testid="accepted-resolution-summary"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[#116b63]">
        <CheckCircleIcon className="h-4 w-4 fill-none stroke-current stroke-[1.8]" />
        <span>{t('collaboration.resolution.accepted')}</span>
        <time
          className="ml-auto text-[0.68rem] font-medium text-[var(--workbench-muted)]"
          dateTime={resolution.acceptedAt}
        >
          {formatCommentDate(resolution.acceptedAt, locale, true)}
        </time>
      </div>
      <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-text)]">
        {resolution.summary}
      </p>
      <CapturedResolutionSource resolution={resolution} t={t} />
      <p className="mt-1 text-[0.68rem] font-medium text-[var(--workbench-muted)]">
        {t('collaboration.resolution.acceptedBy').replace(
          '{actor}',
          resolution.acceptedBy.displayName,
        )}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3">
        <a
          className="inline-flex min-h-[44px] items-center text-xs font-semibold text-[var(--workbench-primary)] underline underline-offset-2"
          href={createResolutionSourcePermalink(resolution)}
          onClick={(event) => {
            event.preventDefault()
            onOpenSource(resolution)
          }}
        >
          {t('collaboration.resolution.openReply')}
        </a>
        {canEdit ? (
          <button
            className="min-h-[44px] text-xs font-semibold text-[var(--workbench-primary)] underline underline-offset-2"
            onClick={(event) => onEdit(event.currentTarget)}
            type="button"
          >
            {t('collaboration.resolution.editSummary')}
          </button>
        ) : null}
        <button
          aria-controls={createResolutionHistoryPanelId(resolution.sourceRootCommentId)}
          aria-expanded={historyIsOpen}
          className="min-h-[44px] text-xs font-semibold text-[var(--workbench-primary)] underline underline-offset-2"
          id={createResolutionHistoryButtonId(resolution.sourceRootCommentId)}
          onClick={onToggleHistory}
          type="button"
        >
          {t(
            historyIsOpen
              ? 'collaboration.resolution.history.hide'
              : 'collaboration.resolution.history.show',
          )}
        </button>
      </div>
      {historyIsOpen ? (
        <section
          aria-busy={history.isLoading || history.isLoadingMore}
          aria-labelledby={createResolutionHistoryButtonId(
            resolution.sourceRootCommentId,
          )}
          className="border-t border-[#c6e8e3] pt-1"
          id={createResolutionHistoryPanelId(resolution.sourceRootCommentId)}
        >
          <h4 className="py-2 text-xs font-semibold text-[var(--workbench-text)]">
            {t('collaboration.resolution.history.title')}
          </h4>
          {history.hasLoadError ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3 border-y border-red-200 bg-red-50 py-2"
              role="alert"
            >
              <p className="text-xs font-semibold text-red-700">
                {t('collaboration.resolution.history.error')}
              </p>
              <button
                className="min-h-[44px] text-xs font-bold text-red-700 underline underline-offset-2"
                onClick={() => void onRetryHistory()}
                type="button"
              >
                {t('collaboration.retry')}
              </button>
            </div>
          ) : history.isLoading ? (
            <p
              className="min-h-[44px] py-3 text-xs font-medium text-[var(--workbench-muted)]"
              role="status"
            >
              {t('collaboration.resolution.history.loading')}
            </p>
          ) : priorResolutions.length === 0 ? (
            <p className="min-h-[44px] py-3 text-xs font-medium text-[var(--workbench-muted)]">
              {t('collaboration.resolution.history.empty')}
            </p>
          ) : (
            <ol className="divide-y divide-[#c6e8e3] border-y border-[#c6e8e3]">
              {priorResolutions.map((item) => (
                <li className="py-2" key={`${item.id}:${item.state}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.68rem] font-semibold text-[var(--workbench-muted)]">
                      {t(`collaboration.resolution.state.${item.state}`)}
                    </span>
                    <time
                      className="ml-auto text-[0.68rem] text-[var(--workbench-muted)]"
                      dateTime={item.acceptedAt}
                    >
                      {formatCommentDate(item.acceptedAt, locale, true)}
                    </time>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--workbench-text)]">
                    {item.summary}
                  </p>
                  <CapturedResolutionSource resolution={item} t={t} />
                  <p className="mt-1 text-[0.68rem] text-[var(--workbench-muted)]">
                    {t('collaboration.resolution.acceptedBy').replace(
                      '{actor}',
                      item.acceptedBy.displayName,
                    )}
                  </p>
                  {item.supersededBy && item.supersededAt ? (
                    <p className="mt-1 text-[0.68rem] text-[var(--workbench-muted)]">
                      {t('collaboration.resolution.history.supersededBy')
                        .replace('{actor}', item.supersededBy.displayName)
                        .replace(
                          '{time}',
                          formatCommentDate(item.supersededAt, locale, true),
                        )}
                    </p>
                  ) : null}
                  <a
                    className="inline-flex min-h-[44px] items-center text-xs font-semibold text-[var(--workbench-primary)] underline underline-offset-2"
                    href={createResolutionSourcePermalink(item)}
                    onClick={(event) => {
                      event.preventDefault()
                      onOpenSource(item)
                    }}
                  >
                    {t('collaboration.resolution.openReply')}
                  </a>
                </li>
              ))}
            </ol>
          )}
          {!history.hasLoadError && !history.isLoading && history.hasMore ? (
            <button
              className="min-h-[44px] text-xs font-semibold text-[var(--workbench-primary)] underline underline-offset-2 disabled:opacity-60"
              disabled={history.isLoadingMore}
              onClick={() => void onLoadMoreHistory()}
              type="button"
            >
              {t(
                history.isLoadingMore
                  ? 'collaboration.loadingMore'
                  : 'collaboration.resolution.history.loadEarlier',
              )}
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

/**
 * Props for an immutable reply snapshot retained with an accepted resolution.
 */
type CapturedResolutionSourceProps = {
  /** Resolution that owns the captured reply body and revision. */
  resolution: AcceptedResolution
  /** Collaboration translator. */
  t: (key: MessageKey) => string
}

/**
 * Renders the captured source reply so audit history stays readable after edits or deletion.
 *
 * @param props - Resolution snapshot and translator.
 * @returns Captured reply revision and immutable Markdown body.
 */
function CapturedResolutionSource({
  resolution,
  t,
}: CapturedResolutionSourceProps) {
  return (
    <div className="mt-2 border-l-[3px] border-[#99d7cf] pl-3">
      <p className="text-[0.68rem] font-semibold text-[var(--workbench-muted)]">
        {t('collaboration.resolution.capturedReply').replace(
          '{revision}',
          String(resolution.capturedCommentRevision),
        )}
      </p>
      <SafeCommentBody
        bodyMarkdown={resolution.capturedCommentBody}
        className="mt-1"
      />
    </div>
  )
}

/**
 * Creates a canonical same-pane route for an accepted resolution's source reply.
 *
 * @param resolution - Resolution whose immutable source should be opened.
 * @returns Query route that preserves a copyable deep link to the reply thread.
 */
function createResolutionSourcePermalink(
  resolution: AcceptedResolution,
): string {
  const search = new URLSearchParams({
    ...(typeof window === 'undefined'
      ? {}
      : Object.fromEntries(new URLSearchParams(window.location.search))),
    collaborationTab: 'conversation',
    commentId: resolution.sourceCommentId,
    rootCommentId: resolution.sourceRootCommentId,
  })
  search.delete('activityEventId')
  search.delete('contextItemId')
  search.delete('sourceId')
  search.delete('sourceKind')
  return `?${search.toString()}`
}

/**
 * Creates the toggle ID that labels a root thread's resolution history.
 *
 * @param rootCommentId - Root comment identifier.
 * @returns DOM-safe history button ID.
 */
function createResolutionHistoryButtonId(rootCommentId: string): string {
  return `resolution-history-toggle-${encodeURIComponent(rootCommentId)}`
}

/**
 * Creates the controlled region ID for a root thread's resolution history.
 *
 * @param rootCommentId - Root comment identifier.
 * @returns DOM-safe history panel ID.
 */
function createResolutionHistoryPanelId(rootCommentId: string): string {
  return `resolution-history-panel-${encodeURIComponent(rootCommentId)}`
}

function CommentFileAttachments({
  artifacts,
  comment,
  t,
}: {
  artifacts: FileArtifactsController
  comment: TeamIssueComment
  t: (key: MessageKey) => string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [guestAccess, setGuestAccess] = useState(false)
  const files = artifacts.files.filter((file) =>
    file.targetType === 'comment' && file.targetId === comment.id && !file.deletedAt
  )
  const canAttach = artifacts.capabilities.canUpload && comment.source !== 'legacy'
  const canGrantGuestAccess = canAttach && artifacts.capabilities.canGrantGuestAccess

  return files.length > 0 || canAttach ? (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid={`comment-files-${comment.id}`}>
      {files.map((file) => {
        const availableVersion = file.versions.find((version) => version.scanStatus === 'available')

        return (
          <button
            className="inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-2 text-[0.68rem] font-semibold text-[var(--workbench-text)] disabled:opacity-50"
            disabled={!file.capabilities.canDownload || !availableVersion}
            key={file.id}
            onClick={() => {
              if (!availableVersion) {
                return
              }

              void artifacts.getVersionAccess(file, availableVersion, 'attachment').then((access) => {
                if (!access) {
                  return
                }

                const link = document.createElement('a')
                link.href = access.url
                link.download = availableVersion.fileName
                link.rel = 'noopener noreferrer'
                link.click()
              })
            }}
            type="button"
          >
            <span aria-hidden="true">↗</span>
            <span className="truncate">{file.name}</span>
            <span className="text-[var(--workbench-muted)]">v{availableVersion?.number ?? file.currentVersion.number}</span>
          </button>
        )
      })}
      {canAttach ? (
        <>
          {canGrantGuestAccess ? (
            <label
              className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-[var(--workbench-border)] bg-white px-2 text-[0.68rem] font-semibold text-[var(--workbench-muted)]"
              htmlFor={`comment-guest-access-${comment.id}`}
            >
              <input
                checked={guestAccess}
                className="h-3.5 w-3.5 accent-[var(--workbench-primary)]"
                id={`comment-guest-access-${comment.id}`}
                onChange={(event) => setGuestAccess(event.target.checked)}
                type="checkbox"
              />
              {t('files.guestAccess')}
            </label>
          ) : null}
          <button
            aria-controls={`comment-file-input-${comment.id}`}
            className="min-h-7 rounded-md px-2 text-[0.68rem] font-semibold text-[var(--workbench-primary)] hover:bg-[#e5f7f4] disabled:opacity-50"
            disabled={artifacts.isMutating}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            + {t('files.comment.attach')}
          </button>
          <input
            aria-label={t('files.comment.attach')}
            data-testid={`comment-file-input-${comment.id}`}
            disabled={artifacts.isMutating}
            hidden
            id={`comment-file-input-${comment.id}`}
            multiple
            onChange={(event) => {
              const selectedFiles = Array.from(event.target.files ?? [])
              event.target.value = ''
              void artifacts.uploadFiles(selectedFiles, {
                commentId: comment.id,
                guestAccess: canGrantGuestAccess ? guestAccess : false,
              })
            }}
            ref={inputRef}
            type="file"
          />
        </>
      ) : null}
    </div>
  ) : null
}

/**
 * CommentComposer の props です。
 */
type CommentComposerProps = {
  /**
   * textarea に表示する label key です。
   */
  labelKey: MessageKey
  /**
   * submit button の label key です。
   */
  submitKey: MessageKey
  /**
   * mention 候補の Workspace member 一覧です。
   */
  members: WorkspaceMember[]
  /**
   * 編集時の初期 Markdown です。
   */
  initialBodyMarkdown?: string
  /**
   * 編集時の初期 mention member key です。
   */
  initialMentionMemberKeys?: string[]
  /**
   * 作成または更新 action です。
   */
  onSubmit: (input: CreateTeamIssueCommentInput) => Promise<boolean>
  /**
   * composer を閉じる action です。
   */
  onCancel?: () => void
  /**
   * typing 状態を通知する action です。
   */
  onTyping: () => void
  /**
   * i18n translator です。
   */
  t: (key: MessageKey) => string
}

function CommentComposer({
  initialBodyMarkdown = '',
  initialMentionMemberKeys = [],
  labelKey,
  members,
  onCancel,
  onSubmit,
  onTyping,
  submitKey,
  t,
}: CommentComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [bodyMarkdown, setBodyMarkdown] = useState(initialBodyMarkdown)
  const [mentionMemberKeys, setMentionMemberKeys] = useState(initialMentionMemberKeys)
  const [mentionQuery, setMentionQuery] = useState<string | undefined>()
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const activeMembers = useMemo(
    () => members.filter((member) => member.status === 'active'),
    [members],
  )
  const mentionSuggestions = useMemo(() => {
    if (mentionQuery === undefined) {
      return []
    }

    const normalizedQuery = mentionQuery.trim().toLowerCase()

    return activeMembers
      .filter((member) => !normalizedQuery || [member.name, member.email]
        .some((value) => value?.toLowerCase().includes(normalizedQuery)))
      .slice(0, 6)
  }, [activeMembers, mentionQuery])

  const insertTemplate = (prefix: string, suffix: string, placeholder: string) => {
    const textarea = textareaRef.current
    const selectionStart = textarea?.selectionStart ?? bodyMarkdown.length
    const selectionEnd = textarea?.selectionEnd ?? selectionStart
    const selectedText = bodyMarkdown.slice(selectionStart, selectionEnd) || placeholder
    const insertion = `${prefix}${selectedText}${suffix}`
    const nextBody = `${bodyMarkdown.slice(0, selectionStart)}${insertion}${bodyMarkdown.slice(selectionEnd)}`

    setBodyMarkdown(nextBody)
    onTyping()
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(selectionStart + prefix.length, selectionStart + prefix.length + selectedText.length)
    })
  }

  const insertMention = (member: WorkspaceMember) => {
    const textarea = textareaRef.current
    const cursor = textarea?.selectionStart ?? bodyMarkdown.length
    const mention = readMentionAtCursor(bodyMarkdown, cursor)
    const token = `@${formatIssueMentionLabel(member, activeMembers)}`
    const start = mention?.start ?? cursor
    const nextBody = `${bodyMarkdown.slice(0, start)}${token} ${bodyMarkdown.slice(cursor)}`

    setBodyMarkdown(nextBody)
    setMentionMemberKeys((current) => Array.from(new Set([...current, member.memberKey])))
    setMentionQuery(undefined)
    onTyping()
    requestAnimationFrame(() => {
      const nextCursor = start + token.length + 1
      textarea?.focus()
      textarea?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedBody = bodyMarkdown.trim()

    if (!trimmedBody || isSubmitting) {
      textareaRef.current?.focus()
      return
    }

    setIsSubmitting(true)
    const succeeded = await onSubmit({
      bodyMarkdown: trimmedBody,
      mentionMemberKeys: resolveIssueMentionMemberKeys(
        trimmedBody,
        mentionMemberKeys,
        members,
      ),
    })
    setIsSubmitting(false)

    if (succeeded && !initialBodyMarkdown) {
      setBodyMarkdown('')
      setMentionMemberKeys([])
      setIsPreviewing(false)
    }
  }

  return (
    <form className="grid min-w-0 gap-2.5" onSubmit={(event) => void handleSubmit(event)}>
      <div className="flex min-w-0 flex-wrap items-center gap-1 border-b border-[var(--workbench-border)] pb-2">
        <ComposerToolButton label={t('collaboration.toolbar.bold')} onClick={() => insertTemplate('**', '**', t('collaboration.toolbar.text'))}>
          B
        </ComposerToolButton>
        <ComposerToolButton label={t('collaboration.toolbar.code')} onClick={() => insertTemplate('`', '`', t('collaboration.toolbar.codePlaceholder'))}>
          {'</>'}
        </ComposerToolButton>
        <ComposerToolButton label={t('collaboration.toolbar.link')} onClick={() => insertTemplate('[', '](https://)', t('collaboration.toolbar.linkText'))}>
          ↗
        </ComposerToolButton>
        <ComposerToolButton label={t('collaboration.toolbar.checklist')} onClick={() => insertTemplate('- [ ] ', '', t('collaboration.toolbar.checklistItem'))}>
          ☑
        </ComposerToolButton>
        <ComposerToolButton label={t('collaboration.toolbar.mention')} onClick={() => {
          const textarea = textareaRef.current
          const cursor = textarea?.selectionStart ?? bodyMarkdown.length
          const previousCharacter = bodyMarkdown.charAt(cursor - 1)
          const prefix = previousCharacter && /[\p{L}\p{N}_@]/u.test(previousCharacter) ? ' @' : '@'
          const nextBody = `${bodyMarkdown.slice(0, cursor)}${prefix}${bodyMarkdown.slice(cursor)}`

          setBodyMarkdown(nextBody)
          setMentionQuery('')
          requestAnimationFrame(() => {
            textarea?.focus()
            textarea?.setSelectionRange(cursor + prefix.length, cursor + prefix.length)
          })
        }}>
          @
        </ComposerToolButton>
        <button
          aria-pressed={isPreviewing}
          className="ml-auto rounded px-2 py-1 text-[0.68rem] font-semibold text-[var(--workbench-muted)] transition hover:bg-white hover:text-[var(--workbench-text)]"
          onClick={() => setIsPreviewing((current) => !current)}
          type="button"
        >
          {t(isPreviewing ? 'collaboration.composer.write' : 'collaboration.composer.preview')}
        </button>
      </div>
      {isPreviewing ? (
        <div className="min-h-20 rounded-md border border-[var(--workbench-border)] bg-white px-3 py-2.5">
          {bodyMarkdown.trim() ? (
            <SafeCommentBody bodyMarkdown={bodyMarkdown} />
          ) : (
            <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('collaboration.preview.empty')}</p>
          )}
        </div>
      ) : (
        <label className="relative grid min-w-0 gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
          <span className="sr-only">{t(labelKey)}</span>
          <textarea
            aria-label={t(labelKey)}
            className="workbench-input min-h-20 w-full min-w-0 resize-y px-3 py-2.5 text-sm leading-6"
            onChange={(event) => {
              const nextBody = event.target.value

              setBodyMarkdown(nextBody)
              setMentionQuery(readMentionAtCursor(nextBody, event.target.selectionStart)?.query)
              onTyping()
            }}
            onClick={(event) => setMentionQuery(
              readMentionAtCursor(event.currentTarget.value, event.currentTarget.selectionStart)?.query,
            )}
            name="body"
            placeholder={t('collaboration.composer.placeholder')}
            ref={textareaRef}
            required
            value={bodyMarkdown}
          />
          {mentionQuery !== undefined && mentionSuggestions.length > 0 ? (
            <div
              aria-label={t('collaboration.mention.suggestions')}
              className="absolute inset-x-0 top-full z-20 mt-1 max-h-52 overflow-y-auto rounded-md border border-[var(--workbench-border)] bg-white p-1.5 shadow-[0_12px_30px_rgba(38,51,63,0.16)]"
              role="listbox"
            >
              {mentionSuggestions.map((member) => (
                <button
                  aria-selected="false"
                  className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-[var(--workbench-surface-muted)]"
                  key={member.memberKey}
                  onMouseDown={(event) => {
                    event.preventDefault()
                  }}
                  onClick={() => insertMention(member)}
                  role="option"
                  type="button"
                >
                  <MemberAvatar memberKey={member.memberKey} members={members} small />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-[var(--workbench-text)]">
                      {formatMemberName(member, member.memberKey)}
                    </span>
                    <span className="block truncate text-[0.68rem] font-medium text-[var(--workbench-muted)]">
                      {member.email}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="workbench-button-primary h-8 px-3 text-xs disabled:border-slate-300 disabled:bg-slate-300"
          disabled={isSubmitting || !bodyMarkdown.trim()}
          type="submit"
        >
          {t(isSubmitting ? 'collaboration.saving' : submitKey)}
        </button>
        {onCancel ? (
          <button
            className="h-8 rounded px-2.5 text-xs font-semibold text-[var(--workbench-muted)] hover:bg-white"
            onClick={onCancel}
            type="button"
          >
            {t('collaboration.cancel')}
          </button>
        ) : null}
        <p className="ml-auto text-[0.68rem] font-medium text-[var(--workbench-muted-soft)]">
          {t('collaboration.composer.markdown')}
        </p>
      </div>
    </form>
  )
}

function ReactionButton({
  canReact,
  comment,
  controller,
  reaction,
  t,
}: {
  canReact: boolean
  comment: TeamIssueComment
  controller: IssueCollaborationController
  reaction: TeamIssueCommentReaction
  t: (key: MessageKey) => string
}) {
  return (
    <button
      aria-label={`${reaction.emoji} ${t(reaction.reactedByMe ? 'collaboration.reaction.remove' : 'collaboration.reaction.add')}`}
      aria-pressed={reaction.reactedByMe}
      className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-xs font-semibold transition ${
        reaction.reactedByMe
          ? 'border-[#72c9bf] bg-[#e5f7f4] text-[#116b63]'
          : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:border-[#99d7cf]'
      }`}
      disabled={!canReact}
      onClick={() => void controller.toggleReaction(comment, reaction.emoji, reaction.reactedByMe)}
      type="button"
    >
      <span>{reaction.emoji}</span>
      <span>{reaction.count}</span>
    </button>
  )
}

function CommentActionButton({
  label,
  onClick,
  tone = 'default',
}: {
  label: string
  onClick: (trigger: HTMLButtonElement) => void
  tone?: 'default' | 'primary'
}) {
  return (
    <button
      className={`min-h-11 rounded px-1.5 py-1 text-[0.68rem] font-semibold transition hover:bg-[var(--workbench-surface-muted)] ${
        tone === 'primary' ? 'text-[#16766f]' : 'text-[var(--workbench-muted)]'
      }`}
      onClick={(event) => onClick(event.currentTarget)}
      type="button"
    >
      {label}
    </button>
  )
}

function ComposerToolButton({
  children,
  label,
  onClick,
}: {
  children: string
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      className="grid h-7 min-w-7 place-items-center rounded px-1.5 text-[0.7rem] font-bold text-[var(--workbench-muted)] transition hover:bg-white hover:text-[var(--workbench-text)]"
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

function MemberAvatar({
  memberKey,
  members,
  small = false,
}: {
  memberKey: string
  members: WorkspaceMember[]
  small?: boolean
}) {
  const member = findWorkspaceMember(memberKey, members)
  const name = formatMemberName(member, memberKey)

  return (
    <span
      aria-label={name}
      className={`grid flex-none place-items-center rounded-full border border-white bg-[#d9f1ee] font-semibold text-[#116b63] ring-1 ring-[#99d7cf] ${
        small ? 'h-6 w-6 text-[0.62rem]' : 'h-8 w-8 text-xs'
      }`}
      title={name}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

function CollaborationSkeleton() {
  return (
    <div className="grid gap-3" aria-hidden="true">
      {[0, 1].map((item) => (
        <div className="motion-safe:animate-pulse rounded-md border border-[var(--workbench-border)] bg-white p-3" key={item}>
          <div className="h-3 w-32 rounded bg-[#e4e7ec]" />
          <div className="mt-3 h-3 w-full rounded bg-[#eef1f4]" />
          <div className="mt-2 h-3 w-3/4 rounded bg-[#eef1f4]" />
        </div>
      ))}
    </div>
  )
}

function createCommentThreads(comments: TeamIssueComment[]) {
  const rootComments = comments.filter((comment) => !comment.parentCommentId)
  const knownRootIds = new Set(rootComments.map((comment) => comment.id))
  const orphanReplies = comments.filter((comment) =>
    comment.parentCommentId && !knownRootIds.has(comment.rootCommentId ?? ''),
  )
  const roots = [...rootComments, ...orphanReplies].sort((first, second) =>
    second.createdAt.localeCompare(first.createdAt) || first.id.localeCompare(second.id),
  )

  return roots.map((root) => ({
    root,
    replies: comments
      .filter((comment) => comment.parentCommentId && (comment.rootCommentId ?? comment.parentCommentId) === root.id)
      .sort((first, second) => first.createdAt.localeCompare(second.createdAt)),
  })) satisfies CommentThread[]
}

function createCommentAnchorId(commentId: string) {
  return `comment-${encodeURIComponent(commentId)}`
}

function resolveCommentAuthorKey(comment: TeamIssueComment) {
  return comment.authorMemberKey ?? comment.actorUserId ?? 'unknown-member'
}

function resolveCommentBody(comment: TeamIssueComment) {
  return comment.bodyMarkdown ?? comment.body ?? ''
}

/**
 * Resolves the current accepted resolution from server append-only history.
 *
 * @param rootComment - Root comment that owns resolution history.
 * @returns The current accepted resolution, when one exists.
 */
function resolveCurrentAcceptedResolution(
  rootComment: TeamIssueComment,
): AcceptedResolution | undefined {
  return rootComment.acceptedResolutions?.find(
    (resolution) => resolution.state === 'accepted',
  )
}

/**
 * Reconstructs the minimum source-comment model required to edit a resolution summary.
 *
 * The append-only resolution snapshot remains sufficient even when the original reply has not
 * been loaded yet or is no longer readable through the current comment page.
 *
 * @param resolution - Accepted resolution with an immutable reply snapshot.
 * @returns Comment-shaped source used only to preserve the selected reply ID during the update.
 */
function createCapturedResolutionSourceComment(
  resolution: AcceptedResolution,
): TeamIssueComment {
  return {
    bodyMarkdown: resolution.capturedCommentBody,
    createdAt: resolution.acceptedAt,
    id: resolution.sourceCommentId,
    mentionMemberKeys: [],
    parentCommentId:
      resolution.sourceCommentId === resolution.sourceRootCommentId
        ? undefined
        : resolution.sourceRootCommentId,
    rootCommentId: resolution.sourceRootCommentId,
    updatedAt: resolution.acceptedAt,
    version: resolution.capturedCommentRevision,
  }
}

function findWorkspaceMember(memberKey: string, members: WorkspaceMember[]) {
  return members.find((member) => member.memberKey === memberKey || member.id === memberKey || member.email === memberKey)
}

function formatMemberName(member: WorkspaceMember | undefined, fallback: string) {
  return member?.name?.trim() || member?.email || fallback
}

function formatCommentDate(value: string, locale: Locale, includeYear: boolean) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    ...(includeYear ? { year: 'numeric' as const } : {}),
  }).format(date)
}

function formatTypingLabel(
  memberKeys: string[],
  members: WorkspaceMember[],
  t: (key: MessageKey) => string,
) {
  const names = memberKeys
    .slice(0, 2)
    .map((memberKey) => formatMemberName(findWorkspaceMember(memberKey, members), memberKey))
    .join(', ')

  return t(memberKeys.length > 2 ? 'collaboration.presence.typingMany' : 'collaboration.presence.typing')
    .replace('{names}', names)
    .replace('{count}', String(Math.max(0, memberKeys.length - 2)))
}

/**
 * cursor 直前の mention query です。
 */
type MentionAtCursor = {
  /**
   * `@` の位置です。
   */
  start: number
  /**
   * `@` より後ろの検索文字列です。
   */
  query: string
}

function readMentionAtCursor(value: string, cursor: number): MentionAtCursor | undefined {
  const prefix = value.slice(0, cursor)
  const match = prefix.match(/(?:^|[^\p{L}\p{N}_@])@([^@\n]*)$/u)

  if (!match) {
    return undefined
  }

  const query = match[1] ?? ''

  return {
    query,
    start: cursor - query.length - 1,
  }
}
