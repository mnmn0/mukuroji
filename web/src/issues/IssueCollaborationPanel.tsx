import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../i18n'
import type { WorkspaceMember } from '../workspace/api'
import type { FileArtifactsController } from '../files/useFileArtifacts'
import type {
  CreateTeamIssueCommentInput,
  TeamIssueActivityEvent,
  TeamIssueComment,
  TeamIssueCommentReaction,
} from './api'
import { SafeCommentBody } from './SafeCommentBody'
import type { IssueCollaborationController } from './useIssueCollaboration'

const supportedReactions = ['👍', '❤️', '🎉', '👀', '✅'] as const

/**
 * IssueCollaborationPanel の props です。
 */
export type IssueCollaborationPanelProps = {
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
}

/**
 * comment thread、mention、reaction、watcher、presence をひとつにまとめた共同作業パネルです。
 */
export function IssueCollaborationPanel({
  artifacts,
  className = '',
  controller,
  currentMemberKey,
  focusedCommentId,
  focusedRootCommentId,
  locale,
  members,
  readOnlyMessage,
}: IssueCollaborationPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [replyingToId, setReplyingToId] = useState<string | undefined>()
  const [editingId, setEditingId] = useState<string | undefined>()
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | undefined>()
  const [reactionMenuId, setReactionMenuId] = useState<string | undefined>()
  const focusLoadRequestRef = useRef<string | undefined>(undefined)
  const focusedCommentTargetRef = useRef<string | undefined>(undefined)
  const threads = useMemo(() => createCommentThreads(controller.comments), [controller.comments])
  const uniquePresence = useMemo(
    () => Array.from(new Map(controller.presence.map((presence) => [presence.memberKey, presence])).values()),
    [controller.presence],
  )
  const typingPresence = uniquePresence.filter((presence) =>
    presence.typing && presence.memberKey !== currentMemberKey,
  )
  const visiblePresence = uniquePresence.filter((presence) => presence.memberKey !== currentMemberKey)
  const canCreateComment = controller.capabilities.canComment && !readOnlyMessage
  const focusComments = controller.comments
  const focusHasLoadError = controller.hasLoadError
  const focusHasMore = controller.hasMore
  const focusIsLoading = controller.isLoading
  const focusIsLoadingMore = controller.isLoadingMore
  const focusLoadMore = controller.loadMore
  const focusLoadMoreReplies = controller.loadMoreReplies
  const focusReplyPagination = controller.replyPagination

  useEffect(() => {
    if (!focusedCommentId) {
      focusLoadRequestRef.current = undefined
      focusedCommentTargetRef.current = undefined
      return
    }

    if (
      focusedCommentTargetRef.current === focusedCommentId ||
      focusIsLoading ||
      focusHasLoadError
    ) {
      return
    }

    const target = document.getElementById(createCommentAnchorId(focusedCommentId))

    if (!target) {
      const rootLoaded = focusedRootCommentId
        ? focusComments.some((comment) => comment.id === focusedRootCommentId)
        : false
      const replyPagination = focusedRootCommentId
        ? focusReplyPagination[focusedRootCommentId]
        : undefined

      if (
        focusedRootCommentId &&
        rootLoaded &&
        replyPagination?.hasMore &&
        !replyPagination.isLoading
      ) {
        const requestKey = `reply:${focusedCommentId}:${focusedRootCommentId}:${focusComments.length}`

        if (focusLoadRequestRef.current !== requestKey) {
          focusLoadRequestRef.current = requestKey
          void focusLoadMoreReplies(focusedRootCommentId)
        }
      } else if (!rootLoaded && focusHasMore && !focusIsLoadingMore) {
        const requestKey = `root:${focusedCommentId}:${focusComments.length}`

        if (focusLoadRequestRef.current !== requestKey) {
          focusLoadRequestRef.current = requestKey
          void focusLoadMore()
        }
      }

      return
    }

    focusLoadRequestRef.current = undefined
    const frameId = window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.focus({ preventScroll: true })
      focusedCommentTargetRef.current = focusedCommentId
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
    focusedCommentId,
    focusedRootCommentId,
  ])

  return (
    <section
      className={`border-t border-[var(--workbench-border)] bg-white ${className}`}
      data-testid="issue-collaboration-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="workbench-eyebrow text-[var(--workbench-muted)]">
              {t('collaboration.title')}
            </h2>
            <span className="rounded-full border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-2 py-0.5 text-[0.68rem] font-semibold text-[var(--workbench-muted)]">
              {t('collaboration.threadCount').replace('{count}', String(threads.length))}
            </span>
          </div>
          {visiblePresence.length > 0 ? (
            <div className="mt-2 flex min-w-0 items-center gap-2" data-testid="collaboration-presence">
              <div className="flex -space-x-1.5" aria-hidden="true">
                {visiblePresence.slice(0, 4).map((presence) => (
                  <MemberAvatar
                    key={presence.memberKey}
                    memberKey={presence.memberKey}
                    members={members}
                    small
                  />
                ))}
              </div>
              <p className="truncate text-xs font-medium text-[var(--workbench-muted)]">
                {t('collaboration.presence.viewing').replace('{count}', String(visiblePresence.length))}
              </p>
            </div>
          ) : null}
        </div>
        {controller.watch ? (
          <button
            aria-pressed={controller.watch.subscribed}
            className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-semibold transition focus:outline-none focus:ring-4 focus:ring-[#0f8f83]/10 disabled:cursor-not-allowed disabled:opacity-55 ${
              controller.watch.subscribed
                ? 'border-[#72c9bf] bg-[#e5f7f4] text-[#116b63]'
                : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:border-[#99d7cf] hover:text-[var(--workbench-text)]'
            }`}
            disabled={!controller.capabilities.canWatch}
            onClick={() => void controller.toggleWatch()}
            title={formatWatchTitle(
              controller.watch.subscribed ? controller.watch.reasons : [],
              t,
            )}
            type="button"
          >
            <WatchIcon filled={controller.watch.subscribed} />
            {t(controller.watch.subscribed ? 'collaboration.watch.watching' : 'collaboration.watch.watch')}
            <span className="text-[0.68rem] opacity-75">{controller.watch.watcherCount}</span>
          </button>
        ) : null}
      </div>

      {controller.watch?.subscribed && controller.watch.automatic ? (
        <p className="mx-5 -mt-2 mb-3 text-xs font-medium text-[var(--workbench-muted)]">
          {t('collaboration.watch.automatic')}
        </p>
      ) : null}
      {controller.watch?.projectSubscribed !== undefined && controller.toggleProjectWatch ? (
        <div className="mx-5 -mt-2 mb-3">
          <button
            aria-pressed={controller.watch.projectSubscribed}
            className={`inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-[0.7rem] font-semibold transition disabled:cursor-not-allowed disabled:opacity-55 ${
              controller.watch.projectSubscribed
                ? 'border-[#99d7cf] bg-[#f4fbfa] text-[#116b63]'
                : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:border-[#99d7cf]'
            }`}
            data-testid="project-watch-toggle"
            disabled={!controller.capabilities.canWatch}
            onClick={() => void controller.toggleProjectWatch?.()}
            title={controller.watch.projectSubscribed
              ? t('collaboration.watch.projectWatching')
                  .replace('{count}', String(controller.watch.projectWatcherCount ?? 0))
              : t('collaboration.watch.projectWatch')}
            type="button"
          >
            <WatchIcon filled={controller.watch.projectSubscribed} />
            {t(controller.watch.projectSubscribed
              ? 'collaboration.watch.projectWatchingButton'
              : 'collaboration.watch.projectWatch')}
            <span className="opacity-70">{controller.watch.projectWatcherCount ?? 0}</span>
          </button>
        </div>
      ) : null}

      <div className="border-y border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
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
        {controller.isLoading ? (
          <CollaborationSkeleton />
        ) : threads.length > 0 ? (
          threads.map((thread) => {
            const replyPagination = controller.replyPagination[thread.root.id]

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
              {thread.root.resolvedAt ? (
                <div className="flex items-center gap-2 border-b border-[#c6e8e3] bg-[#e5f7f4] px-3 py-2 text-xs font-semibold text-[#116b63]">
                  <ResolvedIcon />
                  {t('collaboration.thread.resolved')}
                </div>
              ) : null}
              <CommentCard
                artifacts={artifacts}
                comment={thread.root}
                controller={controller}
                deleteConfirmationId={deleteConfirmationId}
                editingId={editingId}
                focused={focusedCommentId === thread.root.id}
                locale={locale}
                members={members}
                onDeleteConfirmationChange={setDeleteConfirmationId}
                onEditingChange={setEditingId}
                onReactionMenuChange={setReactionMenuId}
                onReplyingChange={setReplyingToId}
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
                      focused={focusedCommentId === reply.id}
                      isReply
                      key={reply.id}
                      locale={locale}
                      members={members}
                      onDeleteConfirmationChange={setDeleteConfirmationId}
                      onEditingChange={setEditingId}
                      onReactionMenuChange={setReactionMenuId}
                      onReplyingChange={setReplyingToId}
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
            </article>
            )
          })
        ) : (
          <div className="rounded-md border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] px-4 py-7 text-center">
            <p className="text-sm font-semibold text-[var(--workbench-text)]">{t('collaboration.empty.title')}</p>
            <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">{t('collaboration.empty.description')}</p>
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
      <div className="border-t border-[var(--workbench-border)] px-5 py-4" data-testid="issue-collaboration-activity">
        <div className="flex items-center justify-between gap-3">
          <h3 className="workbench-eyebrow text-[var(--workbench-muted)]">{t('issues.activity.title')}</h3>
          <span className="text-[0.68rem] font-semibold text-[var(--workbench-muted-soft)]">
            {t('collaboration.activity.appendOnly')}
          </span>
        </div>
        {controller.hasActivityLoadError ? (
          <p className="mt-3 text-sm font-semibold text-red-700">{t('collaboration.activity.error')}</p>
        ) : controller.isActivityLoading ? (
          <div className="mt-3 h-9 animate-pulse rounded-md bg-[var(--workbench-surface-muted)]" />
        ) : controller.activity.length > 0 ? (
          <ol className="mt-3 grid gap-1.5">
            {controller.activity.map((event) => (
              <li
                className="grid grid-cols-[7px_minmax(0,1fr)] gap-2.5 text-xs"
                data-event-type={event.eventType}
                key={event.eventId}
              >
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[#72c9bf]" aria-hidden="true" />
                <p className="min-w-0 font-medium leading-5 text-[var(--workbench-muted)]">
                  {formatActivityLabel(event, members, t)}
                  <time
                    className="ml-2 whitespace-nowrap text-[0.68rem] text-[var(--workbench-muted-soft)]"
                    dateTime={event.occurredAt}
                    title={formatCommentDate(event.occurredAt, locale, true)}
                  >
                    {formatCommentDate(event.occurredAt, locale, false)}
                  </time>
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 text-sm font-medium text-[var(--workbench-muted)]">
            {t('tasks.detail.activityEmpty')}
          </p>
        )}
        {controller.hasMoreActivity ? (
          <button
            className="mt-3 text-xs font-semibold text-[#16766f] underline decoration-[#99d7cf] underline-offset-2 disabled:opacity-60"
            disabled={controller.isLoadingMoreActivity}
            onClick={() => void controller.loadMoreActivity()}
            type="button"
          >
            {t(controller.isLoadingMoreActivity ? 'collaboration.loadingMore' : 'collaboration.activity.loadMore')}
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
  onEditingChange,
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
    const token = `@${formatMentionLabel(member, activeMembers)}`
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
      mentionMemberKeys: resolveSubmittedMentionKeys(trimmedBody, mentionMemberKeys, members),
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
  onClick: () => void
  tone?: 'default' | 'primary'
}) {
  return (
    <button
      className={`rounded px-1.5 py-1 text-[0.68rem] font-semibold transition hover:bg-[var(--workbench-surface-muted)] ${
        tone === 'primary' ? 'text-[#16766f]' : 'text-[var(--workbench-muted)]'
      }`}
      onClick={onClick}
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
        <div className="animate-pulse rounded-md border border-[var(--workbench-border)] bg-white p-3" key={item}>
          <div className="h-3 w-32 rounded bg-[#e4e7ec]" />
          <div className="mt-3 h-3 w-full rounded bg-[#eef1f4]" />
          <div className="mt-2 h-3 w-3/4 rounded bg-[#eef1f4]" />
        </div>
      ))}
    </div>
  )
}

function WatchIcon({ filled }: { filled: boolean }) {
  return (
    <svg aria-hidden="true" className={`h-4 w-4 ${filled ? 'fill-current' : 'fill-none'}`} viewBox="0 0 24 24">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  )
}

function ResolvedIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 fill-none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8 12 2.5 2.5L16.5 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
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

function findWorkspaceMember(memberKey: string, members: WorkspaceMember[]) {
  return members.find((member) => member.memberKey === memberKey || member.id === memberKey || member.email === memberKey)
}

function formatMemberName(member: WorkspaceMember | undefined, fallback: string) {
  return member?.name?.trim() || member?.email || fallback
}

function formatMentionLabel(member: WorkspaceMember, members: WorkspaceMember[]) {
  const displayName = formatMemberName(member, member.memberKey)
  const duplicateCount = members.filter((candidate) =>
    candidate.status === 'active' && formatMemberName(candidate, candidate.memberKey) === displayName,
  ).length

  if (duplicateCount < 2) {
    return displayName
  }

  const discriminator = member.email && member.email !== displayName
    ? member.email
    : member.memberKey

  return `${displayName} (${discriminator})`
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

function formatWatchTitle(reasons: string[], t: (key: MessageKey) => string) {
  return reasons.length > 0
    ? `${t('collaboration.watch.automatic')}: ${reasons.join(', ')}`
    : t('collaboration.watch.watch')
}

const activityLabelKeys: Record<string, MessageKey> = {
  'comment.created': 'collaboration.activity.commentCreated',
  'comment.replied': 'collaboration.activity.replyCreated',
  'comment.updated': 'collaboration.activity.commentEdited',
  'comment.edited': 'collaboration.activity.commentEdited',
  'comment.deleted': 'collaboration.activity.commentDeleted',
  'comment.resolved': 'collaboration.activity.commentResolved',
  'comment.reopened': 'collaboration.activity.commentReopened',
  'comment.reaction.added': 'collaboration.activity.reactionAdded',
  'comment.reaction.removed': 'collaboration.activity.reactionRemoved',
  'watch.subscribed': 'collaboration.activity.watchSubscribed',
  'watch.unsubscribed': 'collaboration.activity.watchUnsubscribed',
  'work-item.created': 'collaboration.activity.workItemCreated',
  'work-item.updated': 'collaboration.activity.workItemUpdated',
  'file.created': 'collaboration.activity.fileCreated',
  'file.version-created': 'collaboration.activity.fileVersionCreated',
  'file.upload-completed': 'collaboration.activity.fileUploadCompleted',
  'file.deleted': 'collaboration.activity.fileDeleted',
  'file.download-accessed': 'collaboration.activity.fileDownloaded',
  'file.preview-accessed': 'collaboration.activity.filePreviewed',
  'annotation.created': 'collaboration.activity.annotationCreated',
  'approval.requested': 'collaboration.activity.approvalRequested',
  'approval.approved': 'collaboration.activity.approvalApproved',
  'approval.completed': 'collaboration.activity.approvalCompleted',
  'approval.cancelled': 'collaboration.activity.approvalCancelled',
  'approval.rejected': 'collaboration.activity.approvalRejected',
  'approval.changes-requested': 'collaboration.activity.approvalChangesRequested',
}

function formatActivityLabel(
  event: TeamIssueActivityEvent,
  members: WorkspaceMember[],
  t: (key: MessageKey) => string,
) {
  const labelKey = activityLabelKeys[event.eventType] ?? inferActivityLabelKey(event.eventType)

  if (!labelKey) {
    return event.summary ?? event.eventType
  }

  const actor = formatMemberName(findWorkspaceMember(event.actorUserId, members), event.actorUserId)

  return t(labelKey).replace('{actor}', actor)
}

function inferActivityLabelKey(eventType: string): MessageKey | undefined {
  const normalizedType = eventType.toLowerCase()

  if (normalizedType.includes('comment') && (normalizedType.includes('edit') || normalizedType.includes('update'))) {
    return 'collaboration.activity.commentEdited'
  }

  if (normalizedType.includes('comment') && normalizedType.includes('delete')) {
    return 'collaboration.activity.commentDeleted'
  }

  if (normalizedType.includes('comment') && normalizedType.includes('reopen')) {
    return 'collaboration.activity.commentReopened'
  }

  if (normalizedType.includes('comment') && normalizedType.includes('resolve')) {
    return 'collaboration.activity.commentResolved'
  }

  if (normalizedType.includes('reaction')) {
    return normalizedType.includes('remove')
      ? 'collaboration.activity.reactionRemoved'
      : 'collaboration.activity.reactionAdded'
  }

  if (normalizedType.includes('watch')) {
    return normalizedType.includes('unsubscribe') || normalizedType.includes('remove')
      ? 'collaboration.activity.watchUnsubscribed'
      : 'collaboration.activity.watchSubscribed'
  }

  if (normalizedType.includes('file')) {
    if (normalizedType.includes('download')) {
      return 'collaboration.activity.fileDownloaded'
    }

    if (normalizedType.includes('preview')) {
      return 'collaboration.activity.filePreviewed'
    }

    if (normalizedType.includes('delete')) {
      return 'collaboration.activity.fileDeleted'
    }

    if (normalizedType.includes('upload') && normalizedType.includes('complete')) {
      return 'collaboration.activity.fileUploadCompleted'
    }

    return normalizedType.includes('version')
      ? 'collaboration.activity.fileVersionCreated'
      : 'collaboration.activity.fileCreated'
  }

  if (normalizedType.includes('annotation')) {
    return 'collaboration.activity.annotationCreated'
  }

  if (normalizedType.includes('approval')) {
    if (normalizedType.includes('reject')) {
      return 'collaboration.activity.approvalRejected'
    }

    if (normalizedType.includes('change')) {
      return 'collaboration.activity.approvalChangesRequested'
    }

    return normalizedType.includes('request')
      ? 'collaboration.activity.approvalRequested'
      : 'collaboration.activity.approvalApproved'
  }

  return undefined
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

function resolveSubmittedMentionKeys(
  bodyMarkdown: string,
  selectedMemberKeys: string[],
  members: WorkspaceMember[],
) {
  return Array.from(new Set(selectedMemberKeys)).filter((memberKey) => {
    const member = findWorkspaceMember(memberKey, members)

    if (!member || member.status !== 'active') {
      return false
    }

    const escapedName = escapeRegExp(formatMentionLabel(member, members))
    const mentionPattern = new RegExp(
      `(^|[^\\p{L}\\p{N}_@])@${escapedName}(?=$|[^\\p{L}\\p{N}_@])`,
      'u',
    )

    return mentionPattern.test(bodyMarkdown)
  })
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
