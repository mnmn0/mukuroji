import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import type {
  DocumentCommentAnchor,
  DocumentMention,
  DocumentRelation,
} from '@mukuroji/contracts'
import { createAiAssistantSessionKey } from '../../features/ai-assistance/model/assistantSessionKey'
import { AiSummaryAssistant } from '../../features/ai-assistance/ui/AiSummaryAssistant'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import {
  createGoalDocumentsPath,
  createProjectSearchPath,
  createWorkItemSearchPath,
} from '../../shared/routing/paths'
import type {
  DocumentBacklink,
  DocumentComment,
  DocumentRecord,
  DocumentVersion,
} from '../api'
import { extractDocumentMentions } from '../model/comments'
import {
  documentContextTabs,
  resolveDocumentContextTabTarget,
  type DocumentContextTab,
} from '../model/contextTabs'
import {
  focusFirstModalElement,
  trapModalFocus,
} from './modalFocus'
import { createDocumentOperationId } from '../model/document'
import { createCanonicalWorkItemId } from '../model/relations'

/** A tab rendered by the Document context panel. */
export type { DocumentContextTab } from '../model/contextTabs'

/**
 * DocumentContextPanel の props です。
 */
export type DocumentContextPanelProps = {
  /** Active Workspace member token; omission removes the AI Brief source and tab. */
  aiAssistanceAccessToken?: string
  /**
   * Panel 対象の Document です。
   */
  document: DocumentRecord
  /**
   * 現在選択中の context tab です。
   */
  activeTab: DocumentContextTab
  /**
   * Document comment 一覧です。
   */
  comments: DocumentComment[]
  /**
   * Document backlink 一覧です。
   */
  backlinks: DocumentBacklink[]
  /**
   * Document version history です。
   */
  versions: DocumentVersion[]
  /**
   * 次の comment page があるかどうかです。
   */
  hasMoreComments?: boolean
  /**
   * 次の backlink page があるかどうかです。
   */
  hasMoreBacklinks?: boolean
  /**
   * 次の version page があるかどうかです。
   */
  hasMoreVersions?: boolean
  /**
   * 新規 comment が anchor する既定 block/object ID です。
   */
  defaultAnchorId?: string
  /**
   * Notification deep link から focus する comment ID です。
   */
  focusedCommentId?: string
  /**
   * Panel data を読み込み中かどうかです。
   */
  isLoading?: boolean
  /** Keeps the Brief assistant mounted while the drawer is temporarily closed. */
  isOpen?: boolean
  /**
   * Mobile drawer として focus を閉じ込めるかどうかです。
   */
  modal?: boolean
  /** Locale sent to Bedrock and used for AI generation metadata. */
  locale?: Locale
  /** Reports authenticated AI failures to the owning document session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Tab 変更 callback です。
   */
  onTabChange: (tab: DocumentContextTab) => void
  /**
   * Panel を閉じる callback です。
   */
  onClose: () => void
  /**
   * Comment 作成 callback です。
   */
  onCreateComment?: (
    body: string,
    mentions: DocumentMention[],
    anchor: DocumentCommentAnchor,
    parentCommentId?: string,
  ) => Promise<void>
  /**
   * Comment resolve callback です。
   */
  onResolveComment?: (commentId: string) => Promise<void>
  /**
   * 次の comment page を取得する callback です。
   */
  onLoadMoreComments?: () => Promise<void>
  /**
   * 過去 revision restore callback です。
   */
  onRestoreVersion?: (versionId: string) => Promise<void>
  /**
   * 次の version page を取得する callback です。
   */
  onLoadMoreVersions?: () => Promise<void>
  /**
   * 次の backlink pages を取得する callback です。
   */
  onLoadMoreBacklinks?: () => Promise<void>
  /**
   * Backlink の application path を開く callback です。
   */
  onNavigate?: (path: string) => void
  /**
   * Outbound relation を追加または置換する callback です。
   */
  onUpsertRelation?: (relation: DocumentRelation) => Promise<void>
  /**
   * Outbound relation を削除する callback です。
   */
  onDeleteRelation?: (relationId: string) => Promise<void>
}

/**
 * Comment、Backlink、Version、Activity を一つにまとめる右 drawer です。
 */
export function DocumentContextPanel({
  activeTab,
  aiAssistanceAccessToken,
  backlinks,
  comments,
  defaultAnchorId,
  document,
  focusedCommentId,
  hasMoreBacklinks = false,
  hasMoreComments = false,
  hasMoreVersions = false,
  isLoading = false,
  isOpen = true,
  locale = 'en',
  modal = true,
  onClose,
  onCreateComment,
  onDeleteRelation,
  onAuthenticatedApiError,
  onNavigate,
  onLoadMoreBacklinks,
  onLoadMoreComments,
  onLoadMoreVersions,
  onResolveComment,
  onRestoreVersion,
  onTabChange,
  onUpsertRelation,
  t,
  versions,
}: DocumentContextPanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const panelIdPrefix = useId()
  const focusedCommentKeyRef =
    useRef<string | undefined>(undefined)
  const visibleContextTabs = aiAssistanceAccessToken
    ? [...documentContextTabs]
    : documentContextTabs.filter((tab) => tab !== 'brief')
  const resolvedActiveTab = activeTab === 'brief' && !aiAssistanceAccessToken
    ? 'comments'
    : activeTab

  useEffect(() => {
    if (!modal || !isOpen) {
      return
    }
    const previousFocusedElement =
      globalThis.document.activeElement instanceof HTMLElement
        ? globalThis.document.activeElement
        : undefined
    focusFirstModalElement(panelRef.current)
    return () => previousFocusedElement?.focus()
  }, [isOpen, modal])

  useEffect(() => {
    if (
      resolvedActiveTab !== 'comments' ||
      !focusedCommentId ||
      isLoading
    ) {
      return
    }
    const focusKey = `${document.id}:${focusedCommentId}`
    if (focusedCommentKeyRef.current === focusKey) return

    const frameId = window.requestAnimationFrame(() => {
      const target = [
        ...(panelRef.current?.querySelectorAll<HTMLElement>(
          '[data-comment-id]',
        ) ?? []),
      ].find(
        (element) =>
          element.dataset.commentId === focusedCommentId,
      )
      if (!target) return
      focusedCommentKeyRef.current = focusKey
      target.focus({ preventScroll: true })
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [
    resolvedActiveTab,
    comments,
    document.id,
    focusedCommentId,
    isLoading,
  ])

  /**
   * Applies roving tab selection and focus for the visible permission-filtered tabs.
   *
   * @param event - Keyboard event raised by the focused context tab.
   * @param tab - Context tab that currently owns focus.
   */
  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    tab: DocumentContextTab,
  ) {
    const target = resolveDocumentContextTabTarget(
      tab,
      event.key,
      visibleContextTabs,
    )
    if (!target) return

    event.preventDefault()
    onTabChange(target)
    globalThis.document
      .getElementById(createDocumentContextTabId(panelIdPrefix, target))
      ?.focus()
  }

  return (
    <aside
      aria-label={t('documents.context.aria')}
      aria-modal={modal ? 'true' : undefined}
      className="flex h-full min-h-0 w-[370px] max-w-full flex-none flex-col border-l border-[var(--workbench-border)] bg-white"
      data-testid="document-context-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          return
        }
        if (modal) trapModalFocus(event, panelRef.current)
      }}
      ref={panelRef}
      role="dialog"
      hidden={!isOpen}
    >
      <div className="flex h-14 flex-none items-center justify-between gap-3 border-b border-[var(--workbench-border)] px-4">
        <strong className="text-sm text-[var(--workbench-text)]">
          {t(`documents.context.${resolvedActiveTab}`)}
        </strong>
        <button
          aria-label={t('documents.context.close')}
          className="grid h-[44px] w-[44px] place-items-center rounded-md text-lg text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </div>
      <div
        aria-label={t('documents.context.tabs')}
        className={`grid flex-none border-b border-[var(--workbench-border)] p-1.5 ${
          aiAssistanceAccessToken ? 'grid-cols-5' : 'grid-cols-4'
        }`}
        role="tablist"
      >
        {visibleContextTabs.map((tab) => (
          <button
            aria-controls={createDocumentContextPanelId(panelIdPrefix)}
            aria-selected={resolvedActiveTab === tab}
            className={`relative min-h-[44px] rounded-md px-1 text-[11px] font-semibold ${
              resolvedActiveTab === tab
                ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
                : 'text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'
            }`}
            id={createDocumentContextTabId(panelIdPrefix, tab)}
            key={tab}
            onClick={() => onTabChange(tab)}
            onKeyDown={(event) => handleTabKeyDown(event, tab)}
            role="tab"
            tabIndex={resolvedActiveTab === tab ? 0 : -1}
            type="button"
          >
            {t(`documents.context.${tab}`)}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={createDocumentContextTabId(
          panelIdPrefix,
          resolvedActiveTab,
        )}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        id={createDocumentContextPanelId(panelIdPrefix)}
        role="tabpanel"
      >
        {isLoading ? (
          <p className="px-5 py-10 text-center text-sm font-medium text-[var(--workbench-muted)]">
            {t('documents.context.loading')}
          </p>
        ) : null}
        {!isLoading && resolvedActiveTab === 'comments' ? (
          <CommentsPanel
            comments={comments}
            defaultAnchorId={defaultAnchorId}
            document={document}
            focusedCommentId={focusedCommentId}
            hasMore={hasMoreComments}
            key={`${document.id}:${defaultAnchorId ?? 'document'}`}
            t={t}
            onCreateComment={onCreateComment}
            onLoadMore={onLoadMoreComments}
            onResolveComment={onResolveComment}
          />
        ) : null}
        {aiAssistanceAccessToken ? (
          <div
            aria-hidden={resolvedActiveTab !== 'brief'}
            className={resolvedActiveTab === 'brief' && !isLoading ? 'p-4' : 'hidden'}
          >
            <AiSummaryAssistant
              accessToken={aiAssistanceAccessToken}
              key={createAiAssistantSessionKey({
                documentId: document.id,
                expectedRevision: document.revision,
                type: 'document',
              })}
              locale={locale}
              onAuthenticatedApiError={onAuthenticatedApiError}
              sources={[{
                documentId: document.id,
                expectedRevision: document.revision,
                type: 'document',
              }]}
              t={t}
            />
          </div>
        ) : null}
        {!isLoading && resolvedActiveTab === 'backlinks' ? (
          <BacklinksPanel
            backlinks={backlinks}
            hasMore={hasMoreBacklinks}
            relations={document.relations}
            t={t}
            onDeleteRelation={onDeleteRelation}
            onNavigate={onNavigate}
            onLoadMore={onLoadMoreBacklinks}
            onUpsertRelation={onUpsertRelation}
          />
        ) : null}
        {!isLoading && resolvedActiveTab === 'versions' ? (
          <VersionsPanel
            currentRevision={document.revision}
            hasMore={hasMoreVersions}
            onLoadMore={onLoadMoreVersions}
            onRestoreVersion={onRestoreVersion}
            t={t}
            versions={versions}
          />
        ) : null}
        {!isLoading && resolvedActiveTab === 'activity' ? (
          <ActivityPanel comments={comments} t={t} versions={versions} />
        ) : null}
      </div>
    </aside>
  )
}

/**
 * Creates a stable DOM ID for one Document context tab.
 *
 * @param prefix - React-generated drawer instance prefix.
 * @param tab - Context tab represented by the button.
 * @returns DOM ID referenced by the active tabpanel.
 */
function createDocumentContextTabId(
  prefix: string,
  tab: DocumentContextTab,
): string {
  return `${prefix}-document-context-tab-${tab}`
}

/**
 * Creates a stable DOM ID for the Document context tabpanel.
 *
 * @param prefix - React-generated drawer instance prefix.
 * @returns DOM ID referenced by the controlling tab.
 */
function createDocumentContextPanelId(prefix: string): string {
  return `${prefix}-document-context-tabpanel`
}

function CommentsPanel({
  comments,
  defaultAnchorId,
  document,
  focusedCommentId,
  hasMore,
  onCreateComment,
  onLoadMore,
  onResolveComment,
  t,
}: {
  comments: DocumentComment[]
  defaultAnchorId?: string
  document: DocumentRecord
  focusedCommentId?: string
  hasMore: boolean
  onCreateComment?: (
    body: string,
    mentions: DocumentMention[],
    anchor: DocumentCommentAnchor,
    parentCommentId?: string,
  ) => Promise<void>
  onLoadMore?: () => Promise<void>
  onResolveComment?: (commentId: string) => Promise<void>
  t: (key: MessageKey) => string
}) {
  const [body, setBody] = useState('')
  const [anchorId, setAnchorId] = useState(defaultAnchorId ?? '')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const [replyingToId, setReplyingToId] = useState<string>()
  const [replyBody, setReplyBody] = useState('')
  const [isReplySubmitting, setIsReplySubmitting] = useState(false)

  const anchors =
    document.kind === 'page' || document.kind === 'template'
      ? document.blocks.map((block, index) => ({
          id: block.id,
          label: `${t(`documents.block.${block.type}`)} ${index + 1}`,
          type: 'block' as const,
        }))
      : document.kind === 'whiteboard'
        ? document.whiteboard.objects.map((object) => ({
            id: object.id,
            label:
              object.type === 'work-item'
                ? object.workItemId
                : object.text || t(`documents.whiteboard.${object.type}`),
            type: 'whiteboard-object' as const,
          }))
        : []
  const commentById = new Map(
    comments.map((comment) => [comment.id, comment]),
  )
  const focusedRootCommentId =
    focusedCommentId === undefined
      ? undefined
      : commentById.get(focusedCommentId)?.parentCommentId ??
        focusedCommentId
  const rootComments = comments.filter(
    (comment) =>
      comment.parentCommentId === undefined &&
      (
        showResolved ||
        !comment.resolved ||
        comment.id === focusedRootCommentId
      ),
  )
  const repliesByRoot = new Map<string, DocumentComment[]>()
  const orphanReplies: DocumentComment[] = []
  for (const comment of comments) {
    if (comment.parentCommentId === undefined) continue
    if (!commentById.has(comment.parentCommentId)) {
      orphanReplies.push(comment)
      continue
    }
    const replies = repliesByRoot.get(comment.parentCommentId) ?? []
    replies.push(comment)
    repliesByRoot.set(comment.parentCommentId, replies)
  }
  const hasVisibleComments =
    rootComments.length > 0 || orphanReplies.length > 0

  const handleReplySubmit = async (
    event: FormEvent<HTMLFormElement>,
    root: DocumentComment,
  ) => {
    event.preventDefault()
    const normalizedBody = replyBody.trim()
    if (
      !onCreateComment ||
      !normalizedBody ||
      isReplySubmitting
    ) {
      return
    }
    setIsReplySubmitting(true)
    try {
      await onCreateComment(
        normalizedBody,
        extractDocumentMentions(normalizedBody),
        root.anchor,
        root.id,
      )
      setReplyBody('')
      setReplyingToId(undefined)
    } finally {
      setIsReplySubmitting(false)
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedBody = body.trim()
    if (!onCreateComment || !normalizedBody || isSubmitting) {
      return
    }

    setIsSubmitting(true)
    try {
      await onCreateComment(
        normalizedBody,
        extractDocumentMentions(normalizedBody),
        anchorId
          ? anchors.find((anchor) => anchor.id === anchorId)?.type ===
            'whiteboard-object'
            ? { objectId: anchorId, type: 'whiteboard-object' as const }
            : { blockId: anchorId, type: 'block' as const }
          : { type: 'document' },
      )
      setBody('')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="grid gap-4 p-4">
      {onCreateComment ? (
        <form
          className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3"
          onSubmit={handleSubmit}
        >
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('documents.comments.anchor')}
            <select
              className="workbench-input min-h-9 px-2 text-xs"
              onChange={(event) => setAnchorId(event.target.value)}
              value={anchorId}
            >
              <option value="">{t('documents.comments.pageAnchor')}</option>
              {anchors.map((anchor) => (
                <option key={anchor.id} value={anchor.id}>
                  {anchor.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('documents.comments.body')}
            <textarea
              className="workbench-input min-h-24 resize-y p-3 text-sm"
              onChange={(event) => setBody(event.target.value)}
              placeholder={t('documents.comments.placeholder')}
              value={body}
            />
          </label>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium text-[var(--workbench-muted)]">
              {t('documents.comments.mentionHint')}
            </span>
            <button
              className="workbench-button-primary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!body.trim() || isSubmitting}
              type="submit"
            >
              {isSubmitting
                ? t('documents.comments.saving')
                : t('documents.comments.submit')}
            </button>
          </div>
        </form>
      ) : null}

      <label className="flex items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
        <input
          checked={showResolved}
          className="accent-[var(--workbench-primary)]"
          onChange={(event) => setShowResolved(event.target.checked)}
          type="checkbox"
        />
        {t('documents.comments.showResolved')}
      </label>

      {hasVisibleComments ? (
        <div className="grid gap-3">
          {rootComments.map((root) => (
            <section className="grid gap-2" key={root.id}>
              <CommentCard
                comment={root}
                focused={focusedCommentId === root.id}
                t={t}
                onReply={
                  onCreateComment && !root.resolved
                    ? () => {
                        setReplyBody('')
                        setReplyingToId(root.id)
                      }
                    : undefined
                }
                onResolve={
                  onResolveComment && !root.resolved
                    ? () => onResolveComment(root.id)
                    : undefined
                }
              />
              {(repliesByRoot.get(root.id) ?? []).length > 0 ? (
                <div
                  className="ml-5 grid gap-2 border-l-2 border-[#cfece7] pl-3"
                  data-testid={`document-comment-replies-${root.id}`}
                >
                  {(repliesByRoot.get(root.id) ?? []).map((reply) => (
                    <CommentCard
                      comment={reply}
                      focused={focusedCommentId === reply.id}
                      isReply
                      key={reply.id}
                      t={t}
                    />
                  ))}
                </div>
              ) : null}
              {replyingToId === root.id && onCreateComment ? (
                <form
                  className="ml-5 grid gap-2 rounded-lg border border-[#cfece7] bg-[#f4fbfa] p-3"
                  onSubmit={(event) => {
                    void handleReplySubmit(event, root)
                  }}
                >
                  <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
                    {t('documents.comments.replyBody')}
                    <textarea
                      autoFocus
                      className="workbench-input min-h-20 resize-y p-3 text-sm"
                      onChange={(event) =>
                        setReplyBody(event.target.value)
                      }
                      placeholder={t('documents.comments.replyPlaceholder')}
                      value={replyBody}
                    />
                  </label>
                  <div className="flex justify-end gap-2">
                    <button
                      className="workbench-button min-h-8 px-3"
                      onClick={() => {
                        setReplyBody('')
                        setReplyingToId(undefined)
                      }}
                      type="button"
                    >
                      {t('documents.comments.cancelReply')}
                    </button>
                    <button
                      className="workbench-button-primary min-h-8 px-3 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={
                        !replyBody.trim() || isReplySubmitting
                      }
                      type="submit"
                    >
                      {isReplySubmitting
                        ? t('documents.comments.saving')
                        : t('documents.comments.submitReply')}
                    </button>
                  </div>
                </form>
              ) : null}
            </section>
          ))}
          {orphanReplies.map((reply) => (
            <div
              className="ml-5 border-l-2 border-[#cfece7] pl-3"
              key={reply.id}
            >
              <CommentCard
                comment={reply}
                focused={focusedCommentId === reply.id}
                isReply
                t={t}
              />
            </div>
          ))}
        </div>
      ) : (
        <EmptyContext
          description={t('documents.comments.emptyDescription')}
          title={t('documents.comments.empty')}
        />
      )}
      {hasMore && onLoadMore ? (
        <LoadMoreButton
          onLoadMore={onLoadMore}
          t={t}
        />
      ) : null}
    </div>
  )
}

function CommentCard({
  comment,
  focused = false,
  isReply = false,
  onReply,
  onResolve,
  t,
}: {
  comment: DocumentComment
  focused?: boolean
  isReply?: boolean
  onReply?: () => void
  onResolve?: () => Promise<void>
  t: (key: MessageKey) => string
}) {
  return (
    <article
      className={`rounded-lg border p-3 outline-none ${
        comment.resolved
          ? 'border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] opacity-75'
          : 'border-[var(--workbench-border)] bg-white'
      } ${
        focused
          ? 'ring-2 ring-[var(--workbench-primary)] ring-offset-2'
          : ''
      }`}
      data-comment-id={comment.id}
      data-focused-comment={focused ? 'true' : undefined}
      tabIndex={-1}
    >
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-[#e5f7f4] text-xs font-bold text-[var(--workbench-primary)]">
          {comment.authorUserId.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-xs font-bold text-[var(--workbench-text)]">
            {comment.authorUserId}
          </p>
          <time className="mt-0.5 block text-[11px] font-medium text-[var(--workbench-muted)]">
            {formatTimestamp(comment.createdAt)}
          </time>
        </div>
        {isReply ? (
          <span className="workbench-badge">
            {t('documents.comments.replyLabel')}
          </span>
        ) : null}
      </div>
      <p className="m-0 mt-3 whitespace-pre-wrap text-sm font-medium leading-6 text-[var(--workbench-text)]">
        {renderCommentBody(comment)}
      </p>
      {comment.anchor.type !== 'document' ? (
        <span className="workbench-badge mt-3">
          #{readCommentAnchorId(comment.anchor)}
        </span>
      ) : null}
      {onReply || onResolve ? (
        <div className="mt-3 flex items-center gap-3">
          {onReply ? (
            <button
              className="text-xs font-semibold text-[var(--workbench-primary)] hover:underline"
              onClick={onReply}
              type="button"
            >
              {t('documents.comments.reply')}
            </button>
          ) : null}
          {onResolve ? (
            <button
              className="text-xs font-semibold text-[var(--workbench-primary)] hover:underline"
              onClick={() => void onResolve()}
              type="button"
            >
              {t('documents.comments.resolve')}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function renderCommentBody(comment: DocumentComment) {
  const content = []
  let offset = 0
  const mentions = [...comment.mentions].sort(
    (left, right) => left.offset - right.offset,
  )
  for (const mention of mentions) {
    if (
      mention.offset < offset ||
      mention.offset + mention.length > comment.body.length
    ) {
      continue
    }
    if (mention.offset > offset) {
      content.push(comment.body.slice(offset, mention.offset))
    }
    content.push(
      <mark
        className="rounded bg-[#dff3ef] px-0.5 font-semibold text-[var(--workbench-primary)]"
        key={`${mention.userId}:${mention.offset}`}
      >
        {comment.body.slice(
          mention.offset,
          mention.offset + mention.length,
        )}
      </mark>,
    )
    offset = mention.offset + mention.length
  }
  if (offset < comment.body.length) {
    content.push(comment.body.slice(offset))
  }
  return content.length > 0 ? content : comment.body
}

function BacklinksPanel({
  backlinks,
  hasMore,
  onDeleteRelation,
  onLoadMore,
  onNavigate,
  onUpsertRelation,
  relations,
  t,
}: {
  backlinks: DocumentBacklink[]
  hasMore: boolean
  onDeleteRelation?: (relationId: string) => Promise<void>
  onLoadMore?: () => Promise<void>
  onNavigate?: (path: string) => void
  onUpsertRelation?: (relation: DocumentRelation) => Promise<void>
  relations: DocumentRelation[]
  t: (key: MessageKey) => string
}) {
  const [targetKind, setTargetKind] =
    useState<DocumentRelation['target']['kind']>('work-item')
  const [teamId, setTeamId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [deletingRelationId, setDeletingRelationId] = useState<string>()

  const createRelation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedTargetId =
      targetKind === 'work-item'
        ? createCanonicalWorkItemId(teamId, targetId)
        : targetId.trim() || undefined
    if (!normalizedTargetId || !onUpsertRelation || isSaving) return

    const target: DocumentRelation['target'] =
      targetKind === 'work-item'
        ? { kind: targetKind, workItemId: normalizedTargetId }
        : targetKind === 'project'
          ? { kind: targetKind, projectId: normalizedTargetId }
          : { goalId: normalizedTargetId, kind: targetKind }
    setIsSaving(true)
    try {
      await onUpsertRelation({
        createdAt: new Date().toISOString(),
        createdByUserId: 'current-user',
        id: createDocumentOperationId(),
        source: { kind: 'document' },
        target,
      })
      setTeamId('')
      setTargetId('')
    } finally {
      setIsSaving(false)
    }
  }

  const deleteRelation = async (relationId: string) => {
    if (!onDeleteRelation || deletingRelationId) return
    setDeletingRelationId(relationId)
    try {
      await onDeleteRelation(relationId)
    } finally {
      setDeletingRelationId(undefined)
    }
  }

  return (
    <div className="grid gap-3 p-4">
      <p className="m-0 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
        {t('documents.backlinks.description')}
      </p>
      {onUpsertRelation ? (
        <form
          className="grid gap-2 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3"
          onSubmit={createRelation}
        >
          <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2">
            <select
              aria-label={t('documents.backlinks.targetType')}
              className="workbench-input h-10 px-2 text-xs"
              onChange={(event) =>
                setTargetKind(
                  event.target.value === 'project'
                    ? 'project'
                    : event.target.value === 'goal'
                      ? 'goal'
                      : 'work-item',
                )
              }
              value={targetKind}
            >
              {(['work-item', 'project', 'goal'] as const).map((kind) => (
                <option key={kind} value={kind}>
                  {t(`documents.backlinks.${kind}`)}
                </option>
              ))}
            </select>
            <div className="grid gap-2">
              {targetKind === 'work-item' ? (
                <input
                  aria-label={t('documents.backlinks.teamId')}
                  className="workbench-input h-10 px-3 text-xs"
                  onChange={(event) => setTeamId(event.target.value)}
                  placeholder={t('documents.backlinks.teamId')}
                  value={teamId}
                />
              ) : null}
              <input
                aria-label={
                  targetKind === 'work-item'
                    ? t('documents.backlinks.issueId')
                    : t('documents.backlinks.targetId')
                }
                className="workbench-input h-10 px-3 text-xs"
                onChange={(event) => setTargetId(event.target.value)}
                placeholder={
                  targetKind === 'work-item'
                    ? t('documents.backlinks.issueId')
                    : t('documents.backlinks.targetId')
                }
                value={targetId}
              />
            </div>
          </div>
          {targetKind === 'work-item' ? (
            <p className="m-0 text-[11px] font-medium leading-5 text-[var(--workbench-muted)]">
              {t('documents.backlinks.workItemHint')}
            </p>
          ) : null}
          <button
            className="workbench-button-primary min-h-9 px-3 disabled:opacity-50"
            disabled={
              isSaving ||
              (targetKind === 'work-item'
                ? createCanonicalWorkItemId(teamId, targetId) ===
                  undefined
                : !targetId.trim())
            }
            type="submit"
          >
            {t('documents.backlinks.add')}
          </button>
        </form>
      ) : null}
      <strong className="mt-2 text-xs uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
        {t('documents.backlinks.outbound')}
      </strong>
      {relations.length > 0 ? (
        relations.map((relation) => {
          const targetPath =
            createRelationTargetPath(relation)
          return (
            <article
              className="workbench-panel flex items-center gap-3 p-3"
              key={relation.id}
            >
            <span className="grid h-8 w-8 flex-none place-items-center rounded-md bg-[var(--workbench-surface-muted)] text-xs font-bold text-[var(--workbench-primary)]">
              {backlinkGlyphs[relation.target.kind]}
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-sm text-[var(--workbench-text)]">
                {readRelationTargetId(relation)}
              </strong>
              <span className="text-xs text-[var(--workbench-muted)]">
                {t(`documents.backlinks.${relation.target.kind}`)}
              </span>
            </span>
            {onNavigate ? (
              <button
                className="text-xs font-semibold text-[var(--workbench-primary)] hover:underline"
                onClick={() => onNavigate(targetPath)}
                type="button"
              >
                {t('documents.backlinks.openTarget')}
              </button>
            ) : null}
            {onDeleteRelation ? (
              <button
                aria-label={t('documents.backlinks.remove')}
                className="grid h-8 w-8 place-items-center rounded-md text-[var(--workbench-muted)] hover:bg-red-50 hover:text-[var(--workbench-danger)]"
                disabled={Boolean(deletingRelationId)}
                onClick={() => void deleteRelation(relation.id)}
                type="button"
              >
                ×
              </button>
            ) : null}
            </article>
          )
        })
      ) : (
        <EmptyContext
          description={t('documents.backlinks.outboundEmptyDescription')}
          title={t('documents.backlinks.outboundEmpty')}
        />
      )}
      <strong className="mt-3 text-xs uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
        {t('documents.backlinks.inbound')}
      </strong>
      {backlinks.length > 0 ? (
        backlinks.map((backlink) => (
          <button
            className="workbench-panel flex items-start gap-3 p-4 text-left transition hover:border-[#99d7cf] disabled:cursor-default"
            key={`${backlink.documentId}-${backlink.relation.id}`}
            onClick={() =>
              onNavigate?.(
                `/documents/${encodeURIComponent(backlink.documentId)}`,
              )
            }
            type="button"
          >
            <span className="grid h-8 w-8 flex-none place-items-center rounded-md bg-[var(--workbench-surface-muted)] text-xs font-bold text-[var(--workbench-primary)]">
              {backlinkGlyphs[backlink.relation.target.kind]}
            </span>
            <span className="min-w-0">
              <strong className="block truncate text-sm text-[var(--workbench-text)]">
                {backlink.documentTitle}
              </strong>
              <span className="mt-1 block text-xs font-medium text-[var(--workbench-muted)]">
                {t(`documents.backlinks.${backlink.relation.target.kind}`)}
              </span>
            </span>
          </button>
        ))
      ) : (
        <EmptyContext
          description={t('documents.backlinks.emptyDescription')}
          title={t('documents.backlinks.empty')}
        />
      )}
      {hasMore && onLoadMore ? (
        <LoadMoreButton
          onLoadMore={onLoadMore}
          t={t}
        />
      ) : null}
    </div>
  )
}

function VersionsPanel({
  currentRevision,
  hasMore,
  onLoadMore,
  onRestoreVersion,
  t,
  versions,
}: {
  currentRevision: number
  hasMore: boolean
  onLoadMore?: () => Promise<void>
  onRestoreVersion?: (versionId: string) => Promise<void>
  t: (key: MessageKey) => string
  versions: DocumentVersion[]
}) {
  const [confirmVersionId, setConfirmVersionId] = useState<string>()
  const [restoringVersionId, setRestoringVersionId] = useState<string>()
  const [restoreErrorMessage, setRestoreErrorMessage] = useState<string>()

  return (
    <div className="grid gap-3 p-4">
      <p className="m-0 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
        {t('documents.versions.description')}
      </p>
      {restoreErrorMessage ? (
        <p
          className="m-0 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold leading-5 text-red-800"
          role="alert"
        >
          {restoreErrorMessage}
        </p>
      ) : null}
      {versions.length > 0 ? (
        versions.map((version) => {
          const current = version.revision === currentRevision
          return (
            <article
              className="relative border-l-2 border-[var(--workbench-border)] py-2 pl-4"
              key={version.id}
            >
              <span className="absolute -left-[6px] top-4 h-2.5 w-2.5 rounded-full border-2 border-white bg-[var(--workbench-primary)]" />
              <div className="flex items-center justify-between gap-3">
                <strong className="text-sm text-[var(--workbench-text)]">
                  {t('documents.versions.revision').replace(
                    '{revision}',
                    String(version.revision),
                  )}
                </strong>
                {current ? (
                  <span className="workbench-badge-primary">
                    {t('documents.versions.current')}
                  </span>
                ) : null}
              </div>
              <time className="mt-1 block text-xs font-medium text-[var(--workbench-muted)]">
                {formatTimestamp(version.createdAt)}
              </time>
              {version.createdByUserId ? (
                <p className="m-0 mt-1 truncate text-xs font-semibold text-[var(--workbench-muted)]">
                  {version.createdByUserId}
                </p>
              ) : null}
              {version.summary ? (
                <p className="m-0 mt-2 text-sm font-medium leading-5 text-[var(--workbench-text)]">
                  {version.summary}
                </p>
              ) : null}
              {!current && onRestoreVersion ? (
                confirmVersionId === version.id ? (
                  <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                    <p className="m-0 text-xs font-semibold leading-5 text-amber-800">
                      {t('documents.versions.restoreConfirm')}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        className="workbench-button-secondary min-h-8 px-2.5 text-xs"
                        disabled={restoringVersionId === version.id}
                        onClick={() => setConfirmVersionId(undefined)}
                        type="button"
                      >
                        {t('documents.action.cancel')}
                      </button>
                      <button
                        className="workbench-button-primary min-h-8 px-2.5 text-xs"
                        disabled={restoringVersionId === version.id}
                        onClick={() => {
                          setRestoringVersionId(version.id)
                          setRestoreErrorMessage(undefined)
                          void onRestoreVersion(version.id)
                            .then(() => setConfirmVersionId(undefined))
                            .catch(() =>
                              setRestoreErrorMessage(
                                t('documents.versions.restoreError'),
                              ),
                            )
                            .finally(() =>
                              setRestoringVersionId(undefined),
                            )
                        }}
                        type="button"
                      >
                        {restoringVersionId === version.id
                          ? t('documents.versions.restoring')
                          : t('documents.versions.restore')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="mt-2 text-xs font-semibold text-[var(--workbench-primary)] hover:underline"
                    onClick={() => setConfirmVersionId(version.id)}
                    type="button"
                  >
                    {t('documents.versions.restore')}
                  </button>
                )
              ) : null}
            </article>
          )
        })
      ) : (
        <EmptyContext
          description={t('documents.versions.emptyDescription')}
          title={t('documents.versions.empty')}
        />
      )}
      {hasMore && onLoadMore ? (
        <LoadMoreButton
          onLoadMore={onLoadMore}
          t={t}
        />
      ) : null}
    </div>
  )
}

function ActivityPanel({
  comments,
  t,
  versions,
}: {
  comments: DocumentComment[]
  t: (key: MessageKey) => string
  versions: DocumentVersion[]
}) {
  const activity = useMemo(
    () =>
      [
        ...versions.map((version) => ({
          actor: version.createdByUserId,
          id: `version-${version.id}`,
          summary:
            version.summary ??
            t('documents.activity.version').replace(
              '{revision}',
              String(version.revision),
            ),
          timestamp: version.createdAt,
          type: 'version' as const,
        })),
        ...comments.map((comment) => ({
          actor: comment.authorUserId,
          id: `comment-${comment.id}`,
          summary: comment.resolved
            ? t('documents.activity.commentResolved')
            : t('documents.activity.commentCreated'),
          timestamp: comment.resolvedAt ?? comment.createdAt,
          type: 'comment' as const,
        })),
      ].sort((left, right) => right.timestamp.localeCompare(left.timestamp)),
    [comments, t, versions],
  )

  return (
    <div className="grid gap-1 p-4">
      {activity.length > 0 ? (
        activity.map((item) => (
          <article
            className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 border-b border-[var(--workbench-border)] py-3 last:border-b-0"
            key={item.id}
          >
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--workbench-surface-muted)] text-xs text-[var(--workbench-primary)]">
              {item.type === 'comment' ? '◌' : '↺'}
            </span>
            <div className="min-w-0">
              <p className="m-0 text-sm font-semibold leading-5 text-[var(--workbench-text)]">
                {item.summary}
              </p>
              <p className="m-0 mt-1 truncate text-xs font-medium text-[var(--workbench-muted)]">
                {item.actor ?? t('documents.activity.system')} ·{' '}
                {formatTimestamp(item.timestamp)}
              </p>
            </div>
          </article>
        ))
      ) : (
        <EmptyContext
          description={t('documents.activity.emptyDescription')}
          title={t('documents.activity.empty')}
        />
      )}
    </div>
  )
}

function LoadMoreButton({
  onLoadMore,
  t,
}: {
  onLoadMore: () => Promise<void>
  t: (key: MessageKey) => string
}) {
  const [isLoading, setIsLoading] = useState(false)

  return (
    <button
      className="workbench-button-secondary min-h-9 w-full px-3 text-xs"
      disabled={isLoading}
      onClick={() => {
        setIsLoading(true)
        void onLoadMore().finally(() =>
          setIsLoading(false),
        )
      }}
      type="button"
    >
      {isLoading
        ? t('documents.context.loading')
        : t('documents.context.loadMore')}
    </button>
  )
}

function EmptyContext({
  description,
  title,
}: {
  description: string
  title: string
}) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center">
      <strong className="block text-sm text-[var(--workbench-text)]">
        {title}
      </strong>
      <p className="m-0 mt-2 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
        {description}
      </p>
    </div>
  )
}

const backlinkGlyphs: Record<
  DocumentBacklink['relation']['target']['kind'],
  string
> = {
  goal: '◎',
  project: '▦',
  'work-item': '✓',
}

function readRelationTargetId(relation: DocumentRelation) {
  if (relation.target.kind === 'work-item') {
    return relation.target.workItemId
  }
  if (relation.target.kind === 'project') {
    return relation.target.projectId
  }
  return relation.target.goalId
}

function createRelationTargetPath(
  relation: DocumentRelation,
) {
  switch (relation.target.kind) {
    case 'work-item':
      return createWorkItemSearchPath(
        relation.target.workItemId,
      )
    case 'project':
      return createProjectSearchPath(
        relation.target.projectId,
      )
    case 'goal':
      return createGoalDocumentsPath(
        relation.target.goalId,
      )
  }
}

function readCommentAnchorId(anchor: DocumentCommentAnchor) {
  if (anchor.type === 'block' || anchor.type === 'text') {
    return anchor.blockId
  }
  if (anchor.type === 'whiteboard-object') {
    return anchor.objectId
  }
  return ''
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
