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
  /** Reports whether one of the three local comment composer slots has input to retain. */
  onDraftDirtyChange?: (isDirty: boolean) => void
}

/** Values retained for one root, reply, or edit composer slot. */
type CommentComposerDraft = {
  /** Raw Markdown text currently entered by the viewer. */
  bodyMarkdown: string
  /** Mention member keys selected while editing the raw text. */
  mentionMemberKeys: string[]
  /** Whether the viewer has changed this slot since it was opened. */
  isDirty: boolean
  /** Monotonic lifetime identity used to reject stale asynchronous results. */
  lifetimeId: number
}

/** A reply or edit slot together with the exact target it started from. */
type TargetedCommentComposerDraft = CommentComposerDraft & {
  /** Comment identity receiving the reply or edit. */
  commentId: string
  /** Canonical version captured when an edit began. */
  originalVersion?: number
  /** Canonical body captured when an edit began. */
  originalBodyMarkdown?: string
  /** Mention keys captured when an edit began. */
  originalMentionMemberKeys?: string[]
}

/** Fixed local composer slots that can own an asynchronous request. */
type CommentComposerSlot = 'root' | 'reply' | 'edit'

/** Pending lifetime identities owned by the persistent Conversation tab. */
type PendingComposerSlotLifetimes = Partial<Record<CommentComposerSlot, number>>

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
  /** Route target that was active when this local source was selected. */
  routeTargetKey: string
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
  onDraftDirtyChange,
}: IssueConversationTabProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | undefined>()
  const [reactionMenuId, setReactionMenuId] = useState<string | undefined>()
  const [resolutionEditor, setResolutionEditor] = useState<ResolutionEditorState>()
  const [resolutionSourceTarget, setResolutionSourceTarget] =
    useState<ResolutionSourceTarget>()
  const [isResolutionSaving, setIsResolutionSaving] = useState(false)
  const [rootDraft, setRootDraft] = useState<CommentComposerDraft>({
    bodyMarkdown: '',
    isDirty: false,
    lifetimeId: 0,
    mentionMemberKeys: [],
  })
  const [replyDraft, setReplyDraft] = useState<TargetedCommentComposerDraft>()
  const [editDraft, setEditDraft] = useState<TargetedCommentComposerDraft>()
  const replyingToId = replyDraft?.commentId
  const editingId = editDraft?.commentId
  const draftStateRef = useRef<{
    /** Current root composer slot used by asynchronous ownership checks. */
    root: CommentComposerDraft
    /** Current reply composer slot, when a reply is open. */
    reply?: TargetedCommentComposerDraft
    /** Current edit composer slot, when an edit is open. */
    edit?: TargetedCommentComposerDraft
  }>({ root: rootDraft })
  const mountedRef = useRef(false)
  /** Ref-backed pending ownership blocks duplicate submits synchronously. */
  const pendingSlotLifetimesRef = useRef<PendingComposerSlotLifetimes>({})
  const [pendingSlotLifetimes, setPendingSlotLifetimes] = useState<PendingComposerSlotLifetimes>({})
  const nextDraftLifetimeIdRef = useRef(1)
  const focusLoadRequestRef = useRef<string | undefined>(undefined)
  const focusedCommentTargetRef = useRef<string | undefined>(undefined)
  const focusedCommentElementRef = useRef<HTMLElement | undefined>(undefined)
  const rootDeepLinkTraversalRef = useRef<DeepLinkTraversalState>({
    requestedPages: 0,
  })
  const replyDeepLinkTraversalRef = useRef<DeepLinkTraversalState>({
    requestedPages: 0,
  })
  const [deepLinkExhausted, setDeepLinkExhausted] = useState(false)
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
  const routeTargetKey = JSON.stringify([focusedCommentId ?? null, focusedRootCommentId ?? null])
  const activeResolutionSourceTarget = resolutionSourceTarget?.routeTargetKey === routeTargetKey
    ? resolutionSourceTarget
    : undefined
  const resolutionSourceAuthorMemberKey = resolutionEditor?.sourceComment.authorMemberKey
  const focusedCommentTargetId = activeResolutionSourceTarget?.commentId ?? focusedCommentId
  const focusedRootTargetId = activeResolutionSourceTarget?.rootCommentId ?? focusedRootCommentId
  const retainedReplyDraft = replyDraft && !isReplyDraftWritable(replyDraft, controller, readOnlyMessage)
    ? replyDraft
    : undefined
  const retainedEditDraft = editDraft && !isEditDraftWritable(editDraft, controller, readOnlyMessage)
    ? editDraft
    : undefined

  /** Creates an identity for a newly opened local composer slot. */
  function createDraftLifetimeId() {
    const lifetimeId = nextDraftLifetimeIdRef.current
    nextDraftLifetimeIdRef.current += 1
    return lifetimeId
  }

  /** Claims one fixed composer slot synchronously before starting its request. */
  function beginSlotSubmission(slot: CommentComposerSlot, lifetimeId: number) {
    if (pendingSlotLifetimesRef.current[slot] !== undefined) return false
    pendingSlotLifetimesRef.current[slot] = lifetimeId
    setPendingSlotLifetimes({ ...pendingSlotLifetimesRef.current })
    if (mountedRef.current) onDraftDirtyChange?.(true)
    return true
  }

  /** Releases a slot only when the completion belongs to its active request. */
  function finishSlotSubmission(slot: CommentComposerSlot, lifetimeId: number) {
    if (pendingSlotLifetimesRef.current[slot] !== lifetimeId) return
    delete pendingSlotLifetimesRef.current[slot]
    if (mountedRef.current) {
      setPendingSlotLifetimes({ ...pendingSlotLifetimesRef.current })
    }
    const current = draftStateRef.current
    if (mountedRef.current) {
      onDraftDirtyChange?.(
        current.root.isDirty ||
        Boolean(current.reply?.isDirty || current.edit?.isDirty) ||
        Object.keys(pendingSlotLifetimesRef.current).length > 0,
      )
    }
  }

  /** Clears the root slot with a new lifetime so an old request cannot clear it. */
  function discardRootDraft() {
    const nextDraft: CommentComposerDraft = {
      bodyMarkdown: '',
      isDirty: false,
      lifetimeId: createDraftLifetimeId(),
      mentionMemberKeys: [],
    }
    setRootDraft(nextDraft)
    const current = draftStateRef.current
    reportDraftDirty(nextDraft, current.reply, current.edit)
  }

  /** Reports the aggregate state of the fixed local composer slots. */
  function reportDraftDirty(nextRoot: CommentComposerDraft, nextReply?: TargetedCommentComposerDraft, nextEdit?: TargetedCommentComposerDraft) {
    draftStateRef.current = { edit: nextEdit, reply: nextReply, root: nextRoot }
    if (mountedRef.current) {
      onDraftDirtyChange?.(
        nextRoot.isDirty ||
        Boolean(nextReply?.isDirty || nextEdit?.isDirty) ||
        Object.keys(pendingSlotLifetimesRef.current).length > 0,
      )
    }
  }

  /** Updates the root slot without losing raw text when its tab is hidden. */
  function updateRootDraft(next: Pick<CommentComposerDraft, 'bodyMarkdown' | 'mentionMemberKeys'>) {
    const normalizedNext = next.bodyMarkdown.trim()
      ? next
      : { ...next, mentionMemberKeys: [] }
    const nextWithDirty: CommentComposerDraft = {
      ...normalizedNext,
      isDirty: hasDraftContentValue(normalizedNext),
      lifetimeId: draftStateRef.current.root.lifetimeId,
    }
    setRootDraft(nextWithDirty)
    const current = draftStateRef.current
    reportDraftDirty(nextWithDirty, current.reply, current.edit)
  }

  /** Updates one fixed targeted slot while retaining raw input across refreshes. */
  function updateTargetedDraft(
    slot: 'edit' | 'reply',
    next: Pick<CommentComposerDraft, 'bodyMarkdown' | 'mentionMemberKeys'>,
  ) {
    const normalizedNext = next.bodyMarkdown.trim()
      ? next
      : { ...next, mentionMemberKeys: [] }
    const current = draftStateRef.current
    if (slot === 'edit' && current.edit) {
      const nextDraft = {
        ...current.edit,
        ...normalizedNext,
        isDirty: isTargetedDraftDirty({ ...current.edit, ...normalizedNext }),
      }
      setEditDraft(nextDraft)
      reportDraftDirty(current.root, current.reply, nextDraft)
      return
    }
    if (slot === 'reply' && current.reply) {
      const nextDraft = {
        ...current.reply,
        ...normalizedNext,
        isDirty: hasDraftContentValue(normalizedNext),
      }
      setReplyDraft(nextDraft)
      reportDraftDirty(current.root, nextDraft, current.edit)
    }
  }

  /** Confirms and closes a reply slot when closing it would discard entered input. */
  function handleReplyingChange(
    commentId?: string,
    discardWithoutConfirmation = false,
    expectedOwnerId?: string,
    expectedBodyMarkdown?: string,
  ) {
    const current = draftStateRef.current
    if (
      commentId === undefined &&
      expectedOwnerId &&
      (String(current.reply?.lifetimeId) !== expectedOwnerId ||
        (expectedBodyMarkdown !== undefined && current.reply?.bodyMarkdown.trim() !== expectedBodyMarkdown))
    ) return
    if (!discardWithoutConfirmation && commentId !== undefined && current.reply?.isDirty && current.reply.commentId !== commentId) {
      if (!window.confirm(t('collaboration.composer.discardConfirm'))) return
    }
    if (!discardWithoutConfirmation && commentId === undefined && current.reply?.isDirty) {
      if (!window.confirm(t('collaboration.composer.discardConfirm'))) return
    }
    if (commentId === undefined) {
      setReplyDraft(undefined)
      reportDraftDirty(current.root, undefined, current.edit)
      return
    }
    if (current.reply?.commentId === commentId) {
      return
    }
    const existing = controller.comments.find((comment) => comment.id === commentId)
    if (!existing) return
    const nextDraft: TargetedCommentComposerDraft = {
      bodyMarkdown: '',
      commentId,
      isDirty: false,
      lifetimeId: createDraftLifetimeId(),
      mentionMemberKeys: [],
    }
    setReplyDraft(nextDraft)
    reportDraftDirty(current.root, nextDraft, current.edit)
  }

  /** Confirms and closes an edit slot when closing it would discard entered input. */
  function handleEditingChange(
    commentId?: string,
    discardWithoutConfirmation = false,
    expectedOwnerId?: string,
    expectedBodyMarkdown?: string,
  ) {
    const current = draftStateRef.current
    if (
      commentId === undefined &&
      expectedOwnerId &&
      (String(current.edit?.lifetimeId) !== expectedOwnerId ||
        (expectedBodyMarkdown !== undefined && current.edit?.bodyMarkdown.trim() !== expectedBodyMarkdown))
    ) return
    if (!discardWithoutConfirmation && commentId === undefined && current.edit?.isDirty) {
      if (!window.confirm(t('collaboration.composer.discardConfirm'))) return
    }
    if (!discardWithoutConfirmation && commentId !== undefined && current.edit?.isDirty && current.edit.commentId !== commentId) {
      if (!window.confirm(t('collaboration.composer.discardConfirm'))) return
    }
    if (commentId === undefined) {
      setEditDraft(undefined)
      reportDraftDirty(current.root, current.reply, undefined)
      return
    }
    if (current.edit?.commentId === commentId) {
      return
    }
    const comment = controller.comments.find((candidate) => candidate.id === commentId)
    if (!comment) return
    const bodyMarkdown = resolveCommentBody(comment)
    const nextDraft: TargetedCommentComposerDraft = {
      bodyMarkdown,
      commentId,
      isDirty: false,
      lifetimeId: createDraftLifetimeId(),
      mentionMemberKeys: [...comment.mentionMemberKeys],
      originalBodyMarkdown: bodyMarkdown,
      originalMentionMemberKeys: [...comment.mentionMemberKeys],
      originalVersion: comment.version ?? 1,
    }
    setEditDraft(nextDraft)
    reportDraftDirty(current.root, current.reply, nextDraft)
  }

  /** Acknowledges the displayed canonical revision before an explicit edit retry. */
  function handleEditConflictRetry(commentId: string) {
    if (pendingSlotLifetimesRef.current.edit !== undefined) return
    const current = draftStateRef.current.edit
    const canonical = controller.comments.find((comment) => comment.id === commentId)
    if (!current || current.commentId !== commentId || !canonical) return

    const nextDraftBaseline: TargetedCommentComposerDraft = {
      ...current,
      originalBodyMarkdown: resolveCommentBody(canonical),
      originalMentionMemberKeys: [...canonical.mentionMemberKeys],
      originalVersion: canonical.version,
    }
    const nextDraft: TargetedCommentComposerDraft = {
      ...nextDraftBaseline,
      isDirty: isTargetedDraftDirty(nextDraftBaseline),
    }
    setEditDraft(nextDraft)
    reportDraftDirty(draftStateRef.current.root, draftStateRef.current.reply, nextDraft)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => {
      setResolutionSourceTarget((target) =>
        target?.routeTargetKey === routeTargetKey ? target : undefined
      )
    })
  }, [routeTargetKey])

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
      focusedCommentElementRef.current = undefined
      rootDeepLinkTraversalRef.current = { requestedPages: 0 }
      replyDeepLinkTraversalRef.current = { requestedPages: 0 }
      queueMicrotask(() => setDeepLinkExhausted(false))
      return
    }

    const target = document.getElementById(
      createCommentAnchorId(focusedCommentTargetId),
    )

    // A collaboration refresh can replace the focused comment node without
    // changing its ID. Remember the node itself so the route focus is restored
    // for the replacement, while leaving focus alone when the viewer moved to
    // another control intentionally (for example, the watch button).
    const previousTarget = focusedCommentElementRef.current
    const activeElement = document.activeElement
    const viewerMovedFocus =
      focusedCommentTargetRef.current === focusedCommentTargetId &&
      previousTarget !== undefined &&
      previousTarget !== target &&
      activeElement !== previousTarget &&
      activeElement !== document.body &&
      activeElement !== document.documentElement
    if (
      (focusedCommentTargetRef.current === focusedCommentTargetId &&
        previousTarget === target) ||
      viewerMovedFocus ||
      focusIsLoading ||
      focusHasLoadError
    ) {
      return
    }

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
          if (traversal.exhausted) queueMicrotask(() => setDeepLinkExhausted(true))

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
          if (traversal.exhausted) queueMicrotask(() => setDeepLinkExhausted(true))

          if (traversal.shouldLoad) {
            focusLoadRequestRef.current = requestKey
            void focusLoadMore()
          }
        }
      }

      return
    }

    focusLoadRequestRef.current = undefined
    queueMicrotask(() => setDeepLinkExhausted(false))
    const frameId = window.requestAnimationFrame(() => {
      if (!target.isConnected) return
      target.scrollIntoView({ behavior: 'auto', block: 'center' })
      target.focus({ preventScroll: true })
      focusedCommentTargetRef.current = focusedCommentTargetId
      focusedCommentElementRef.current = target
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
      {deepLinkExhausted ? (
        <p className="m-5 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
          {t('collaboration.deepLink.exhausted')}
        </p>
      ) : null}
      <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
        {canCreateComment ? (
          <CommentComposer
            key="root-comment-composer"
            labelKey="collaboration.composer.label"
            members={members}
            onCancel={undefined}
            draft={rootDraft}
            externallySubmitting={pendingSlotLifetimes.root !== undefined}
            onDraftChange={updateRootDraft}
            onSubmit={async (input) => {
              const submittedDraft = draftStateRef.current.root
              if (!beginSlotSubmission('root', submittedDraft.lifetimeId)) return false
              try {
                const submittedBodyMarkdown = submittedDraft.bodyMarkdown
                const submittedMentionMemberKeys = [...submittedDraft.mentionMemberKeys]
                const succeeded = await controller.createComment(input)
                const current = draftStateRef.current
                if (
                  succeeded &&
                  current.root.lifetimeId === submittedDraft.lifetimeId &&
                  current.root.bodyMarkdown === submittedBodyMarkdown &&
                  JSON.stringify(current.root.mentionMemberKeys) === JSON.stringify(submittedMentionMemberKeys)
                ) {
                  discardRootDraft()
                }
                return succeeded
              } finally {
                finishSlotSubmission('root', submittedDraft.lifetimeId)
              }
            }}
            onTyping={controller.markTyping}
            submitKey="collaboration.composer.submit"
            t={t}
          />
        ) : rootDraft.isDirty ? (
          <div className="grid gap-2">
            <p className="text-sm font-medium text-[var(--workbench-muted)]">
              {readOnlyMessage ?? t('collaboration.readOnly')}
            </p>
            <textarea
              aria-label={t('collaboration.composer.label')}
              className="workbench-input min-h-20 w-full resize-y bg-white px-3 py-2.5 text-sm leading-6"
              readOnly
              value={rootDraft.bodyMarkdown}
            />
            <button
              className="min-h-[44px] justify-self-start rounded px-3 text-xs font-semibold text-[var(--workbench-muted)] underline underline-offset-2"
              onClick={discardRootDraft}
              type="button"
            >
              {t('collaboration.composer.discardDraft')}
            </button>
          </div>
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

      {[retainedReplyDraft, retainedEditDraft].filter(
        (draft): draft is TargetedCommentComposerDraft => draft !== undefined,
      ).map((draft) => (
        <div
          className="mx-5 mt-4 grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3"
          key={`retained-draft-${draft === retainedEditDraft ? 'edit' : 'reply'}-${draft.commentId}`}
        >
          <p className="text-xs font-semibold text-amber-900">
            {t('collaboration.composer.targetUnavailable')}
          </p>
          <textarea
            aria-label={t(draft === retainedEditDraft
              ? 'collaboration.edit.label'
              : 'collaboration.reply.label')}
            className="workbench-input min-h-20 w-full resize-y bg-white px-3 py-2.5 text-sm leading-6"
            readOnly
            value={draft.bodyMarkdown}
          />
          <button
              className="min-h-[44px] justify-self-start rounded px-3 text-xs font-semibold text-amber-900 underline underline-offset-2"
            onClick={() => draft === retainedEditDraft
              ? handleEditingChange(undefined, true)
              : handleReplyingChange(undefined, true)}
            type="button"
          >
            {t('collaboration.composer.discardDraft')}
          </button>
        </div>
      ))}

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
              !thread.root.deletedAt &&
              Boolean(onSetAcceptedResolution) &&
              (canAcceptResolution ||
                (currentMemberKey !== undefined &&
                  thread.root.authorMemberKey === currentMemberKey &&
                  thread.root.capabilities?.canResolve === true))
            const threadDetailsOpen =
              !thread.root.resolvedAt ||
              focusedCommentTargetId === thread.root.id ||
              thread.replies.some(
                (reply) => reply.id === focusedCommentTargetId,
              ) ||
              resolutionEditor?.rootComment.id === thread.root.id

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
                      routeTargetKey,
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
                    )
                      .then((succeeded) => {
                        if (succeeded) closeResolutionEditor()
                      })
                      .catch((error: unknown) => {
                        console.error('Accepted resolution save failed:', error)
                      })
                      .finally(() => setIsResolutionSaving(false))
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
                  {resolutionSourceAuthorMemberKey ? (
                    <p className="text-[0.68rem] text-[var(--workbench-muted)]">
                      {t('collaboration.resolution.sourceReply')}: {formatMemberName(
                        findWorkspaceMember(resolutionSourceAuthorMemberKey, members),
                        resolutionSourceAuthorMemberKey,
                      )}
                    </p>
                  ) : null}
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
                data-testid={`comment-thread-details-${thread.root.id}`}
                key={`thread-details-${thread.root.id}-${threadDetailsOpen ? 'open' : 'closed'}`}
                open={threadDetailsOpen}
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
                editDraft={editDraft?.commentId === thread.root.id ? editDraft : undefined}
                pendingSlotLifetimes={pendingSlotLifetimes}
                beginSlotSubmission={beginSlotSubmission}
                finishSlotSubmission={finishSlotSubmission}
                readOnlyMessage={readOnlyMessage}
                onEditDraftChange={(next) => updateTargetedDraft('edit', next)}
                onEditConflictRetry={handleEditConflictRetry}
                onReplyDraftChange={(next) => updateTargetedDraft('reply', next)}
                replyDraft={replyDraft?.commentId === thread.root.id ? replyDraft : undefined}
                deleteConfirmationId={deleteConfirmationId}
                editingId={editingId}
                focused={focusedCommentTargetId === thread.root.id}
                locale={locale}
                members={members}
                onDeleteConfirmationChange={setDeleteConfirmationId}
                onEditingChange={handleEditingChange}
                onReactionMenuChange={setReactionMenuId}
                onReplyingChange={handleReplyingChange}
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
                      editDraft={editDraft?.commentId === reply.id ? editDraft : undefined}
                      pendingSlotLifetimes={pendingSlotLifetimes}
                      beginSlotSubmission={beginSlotSubmission}
                      finishSlotSubmission={finishSlotSubmission}
                      readOnlyMessage={readOnlyMessage}
                      onEditDraftChange={(next) => updateTargetedDraft('edit', next)}
                      onEditConflictRetry={handleEditConflictRetry}
                      onReplyDraftChange={(next) => updateTargetedDraft('reply', next)}
                      replyDraft={replyDraft?.commentId === reply.id ? replyDraft : undefined}
                      deleteConfirmationId={deleteConfirmationId}
                      editingId={editingId}
                      focused={focusedCommentTargetId === reply.id}
                      isReply
                      key={reply.id}
                      locale={locale}
                      members={members}
                      onDeleteConfirmationChange={setDeleteConfirmationId}
                      onEditingChange={handleEditingChange}
                      onReactionMenuChange={setReactionMenuId}
                      onReplyingChange={handleReplyingChange}
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
  /** Controlled edit draft for this comment, when its editor is open. */
  editDraft?: TargetedCommentComposerDraft
  /** Current issue-level reason writes are unavailable. */
  readOnlyMessage?: string
  /** Current pending request owners for the fixed composer slots. */
  pendingSlotLifetimes: PendingComposerSlotLifetimes
  /** Claims a slot before starting its asynchronous request. */
  beginSlotSubmission: (slot: CommentComposerSlot, lifetimeId: number) => boolean
  /** Releases a slot only when its owning request has settled. */
  finishSlotSubmission: (slot: CommentComposerSlot, lifetimeId: number) => void
  /** Retains raw edit text after a comment refresh or tab switch. */
  onEditDraftChange: (draft: Pick<CommentComposerDraft, 'bodyMarkdown' | 'mentionMemberKeys'>) => void
  /** Explicitly adopts the displayed canonical revision for a conflict retry. */
  onEditConflictRetry: (commentId: string) => void
  /** Controlled reply draft for this comment, when its editor is open. */
  replyDraft?: TargetedCommentComposerDraft
  /** Retains raw reply text after a comment refresh or tab switch. */
  onReplyDraftChange: (draft: Pick<CommentComposerDraft, 'bodyMarkdown' | 'mentionMemberKeys'>) => void
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
  onEditingChange: (
    commentId?: string,
    discardWithoutConfirmation?: boolean,
    expectedOwnerId?: string,
    expectedBodyMarkdown?: string,
  ) => void
  /**
   * reply 対象を変更します。
   */
  onReplyingChange: (
    commentId?: string,
    discardWithoutConfirmation?: boolean,
    expectedOwnerId?: string,
    expectedBodyMarkdown?: string,
  ) => void
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

/**
 * Renders one root comment or reply with its available collaboration actions.
 *
 * @param props - Comment content, permissions, and interaction callbacks.
 * @returns A comment card.
 */
function CommentCard({
  artifacts,
  comment,
  controller,
  deleteConfirmationId,
  editDraft,
  editingId,
  focused = false,
  isReply = false,
  locale,
  members,
  onDeleteConfirmationChange,
  onAcceptResolution,
  onEditDraftChange,
  onEditConflictRetry,
  onEditingChange,
  onPromote,
  onReplyDraftChange,
  onReactionMenuChange,
  onReplyingChange,
  pendingSlotLifetimes,
  beginSlotSubmission,
  finishSlotSubmission,
  reactionMenuId,
  readOnlyMessage,
  replyingToId,
  replyDraft,
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
  const isLegacyComment = comment.source === 'legacy'
  const canReply = controller.capabilities.canComment &&
    !isLegacyComment
    && (capabilities?.canReply ?? true)
    && !rootComment.resolvedAt
    && !comment.deletedAt
  const canReact = controller.capabilities.canReact &&
    !isLegacyComment
    && (capabilities?.canReact ?? true)
    && !comment.deletedAt
  const bodyMarkdown = resolveCommentBody(comment)
  const acceptedResolution = resolveCurrentAcceptedResolution(rootComment)
  const isAcceptedResolution =
    acceptedResolution?.sourceCommentId === comment.id
  const hasEditConflict = Boolean(
    isEditing &&
    editDraft &&
    editDraft.originalVersion !== undefined &&
    comment.version > editDraft.originalVersion,
  )

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

          {isEditing && editDraft && isEditDraftWritable(editDraft, controller, readOnlyMessage) ? (
            <div className="mt-2">
              {hasEditConflict ? (
                <div className="mb-2 grid gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950" role="status">
                  <p className="font-semibold">{t('collaboration.error.conflictLatest')}</p>
                  <SafeCommentBody bodyMarkdown={bodyMarkdown} />
                  <button
                    className="min-h-[44px] justify-self-start rounded px-3 text-xs font-semibold underline underline-offset-2"
                    disabled={pendingSlotLifetimes.edit !== undefined}
                    onClick={() => onEditConflictRetry(comment.id)}
                    type="button"
                  >
                    {t('collaboration.error.conflictRetry')}
                  </button>
                </div>
              ) : null}
              <CommentComposer
                draft={editDraft}
                externallySubmitting={pendingSlotLifetimes.edit !== undefined}
                key={`edit-${comment.id}`}
                labelKey="collaboration.edit.label"
                members={members}
                onCancel={() => onEditingChange(undefined)}
                onDraftChange={onEditDraftChange}
                onSubmit={async (input) => {
                  const submittedLifetimeId = editDraft.lifetimeId
                  if (!beginSlotSubmission('edit', submittedLifetimeId)) return false
                  try {
                    const succeeded = await controller.updateComment(comment, {
                      bodyMarkdown: input.bodyMarkdown,
                      expectedVersion: editDraft.originalVersion ?? comment.version ?? 1,
                      mentionMemberKeys: input.mentionMemberKeys,
                    })

                    if (succeeded) {
                      onEditingChange(undefined, true, String(submittedLifetimeId), input.bodyMarkdown)
                    }

                    return succeeded
                  } finally {
                    finishSlotSubmission('edit', submittedLifetimeId)
                  }
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
              {onPromote && !comment.deletedAt && !isLegacyComment && (capabilities?.canPromote ?? true) ? (
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

          {isReplying && replyDraft && isReplyDraftWritable(replyDraft, controller, readOnlyMessage) ? (
            <div className="mt-3 rounded-md border border-[#c6e8e3] bg-[#f4fbfa] p-3">
              <CommentComposer
                draft={replyDraft}
                externallySubmitting={pendingSlotLifetimes.reply !== undefined}
                key={`reply-${comment.id}`}
                labelKey="collaboration.reply.label"
                members={members}
                onCancel={() => onReplyingChange(undefined)}
                onDraftChange={onReplyDraftChange}
                onSubmit={async (input) => {
                  const submittedLifetimeId = replyDraft.lifetimeId
                  if (!beginSlotSubmission('reply', submittedLifetimeId)) return false
                  try {
                    const succeeded = await controller.createComment({
                      ...input,
                      parentCommentId: comment.id,
                    })

                    if (succeeded) {
                      onReplyingChange(undefined, true, String(submittedLifetimeId), input.bodyMarkdown)
                    }

                    return succeeded
                  } finally {
                    finishSlotSubmission('reply', submittedLifetimeId)
                  }
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

/** Props for comment attachment controls. */
type CommentFileAttachmentsProps = {
  /** File controller scoped to the current Work Item. */
  artifacts: FileArtifactsController
  /** Comment whose attachments are displayed. */
  comment: TeamIssueComment
  /** Translator for attachment labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders downloadable attachments and the scoped upload control for a comment.
 *
 * @param props - Attachment controller, comment, and translator.
 * @returns Attachment controls or nothing when no action is available.
 */
function CommentFileAttachments({
  artifacts,
  comment,
  t,
}: CommentFileAttachmentsProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [guestAccess, setGuestAccess] = useState(false)
  const files = artifacts.files.filter((file) =>
    file.targetType === 'comment' && file.targetId === comment.id && !file.deletedAt
  )
  const canAttach = artifacts.capabilities.canUpload &&
    comment.source !== 'legacy' &&
    (comment.capabilities?.canAttach ?? true)
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
  /** Fixed slot state owned by the persistent conversation tab. */
  draft: CommentComposerDraft
  /** Keeps a remounted composer disabled while its owner request is pending. */
  externallySubmitting?: boolean
  /** Stores raw text and mentions in the persistent conversation slot. */
  onDraftChange: (draft: Pick<CommentComposerDraft, 'bodyMarkdown' | 'mentionMemberKeys'>) => void
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

/**
 * Renders the Markdown comment composer and mention picker.
 *
 * @param props - Persistent slot state, mention candidates, and composer actions.
 * @returns Comment composer form.
 */
function CommentComposer({
  draft,
  externallySubmitting = false,
  labelKey,
  members,
  onCancel,
  onDraftChange,
  onSubmit,
  onTyping,
  submitKey,
  t,
}: CommentComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [mentionQuery, setMentionQuery] = useState<string | undefined>()
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submitInFlightRef = useRef(false)
  const currentBodyMarkdown = draft.bodyMarkdown
  const currentMentionMemberKeys = draft.mentionMemberKeys

  /** Applies one atomic body-and-mention update to the persistent composer slot. */
  const updateDraft = (
    nextBodyMarkdown: string,
    nextMentionMemberKeys = currentMentionMemberKeys,
  ) => {
    onDraftChange({ bodyMarkdown: nextBodyMarkdown, mentionMemberKeys: nextMentionMemberKeys })
  }
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
    const selectionStart = textarea?.selectionStart ?? currentBodyMarkdown.length
    const selectionEnd = textarea?.selectionEnd ?? selectionStart
    const selectedText = currentBodyMarkdown.slice(selectionStart, selectionEnd) || placeholder
    const insertion = `${prefix}${selectedText}${suffix}`
    const nextBody = `${currentBodyMarkdown.slice(0, selectionStart)}${insertion}${currentBodyMarkdown.slice(selectionEnd)}`

    updateDraft(nextBody)
    onTyping()
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(selectionStart + prefix.length, selectionStart + prefix.length + selectedText.length)
    })
  }

  const insertMention = (member: WorkspaceMember) => {
    const textarea = textareaRef.current
    const cursor = textarea?.selectionStart ?? currentBodyMarkdown.length
    const mention = readMentionAtCursor(currentBodyMarkdown, cursor)
    const token = `@${formatIssueMentionLabel(member, activeMembers)}`
    const start = mention?.start ?? cursor
    const nextBody = `${currentBodyMarkdown.slice(0, start)}${token} ${currentBodyMarkdown.slice(cursor)}`

    updateDraft(
      nextBody,
      Array.from(new Set([...currentMentionMemberKeys, member.memberKey])),
    )
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
    const trimmedBody = currentBodyMarkdown.trim()

    if (!trimmedBody || isSubmitting || externallySubmitting || submitInFlightRef.current) {
      textareaRef.current?.focus()
      return
    }

    submitInFlightRef.current = true
    setIsSubmitting(true)
    let succeeded = false
    try {
      succeeded = await onSubmit({
        bodyMarkdown: trimmedBody,
        mentionMemberKeys: resolveIssueMentionMemberKeys(
          trimmedBody,
          currentMentionMemberKeys,
          members,
        ),
      })
    } catch (error) {
      console.error('Failed to submit collaboration comment.', error)
    } finally {
      submitInFlightRef.current = false
      setIsSubmitting(false)
    }
    if (succeeded) setIsPreviewing(false)
  }

  return (
    <form className="grid min-w-0 gap-2.5" onSubmit={(event) => void handleSubmit(event)}>
      <fieldset className="contents" disabled={isSubmitting || externallySubmitting}>
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
          const cursor = textarea?.selectionStart ?? currentBodyMarkdown.length
          const previousCharacter = currentBodyMarkdown.charAt(cursor - 1)
          const prefix = previousCharacter && /[\p{L}\p{N}_@]/u.test(previousCharacter) ? ' @' : '@'
          const nextBody = `${currentBodyMarkdown.slice(0, cursor)}${prefix}${currentBodyMarkdown.slice(cursor)}`

          updateDraft(nextBody)
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
          className="ml-auto min-h-[44px] min-w-[44px] rounded px-2 py-1 text-[0.68rem] font-semibold text-[var(--workbench-muted)] transition hover:bg-white hover:text-[var(--workbench-text)]"
          onClick={() => setIsPreviewing((current) => !current)}
          type="button"
        >
          {t(isPreviewing ? 'collaboration.composer.write' : 'collaboration.composer.preview')}
        </button>
      </div>
      {isPreviewing ? (
        <div className="min-h-20 rounded-md border border-[var(--workbench-border)] bg-white px-3 py-2.5">
          {currentBodyMarkdown.trim() ? (
            <SafeCommentBody bodyMarkdown={currentBodyMarkdown} />
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

              updateDraft(nextBody)
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
            value={currentBodyMarkdown}
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
          className="workbench-button-primary min-h-[44px] px-3 text-xs disabled:border-slate-300 disabled:bg-slate-300"
          disabled={isSubmitting || externallySubmitting || !currentBodyMarkdown.trim()}
          type="submit"
        >
          {t(isSubmitting || externallySubmitting ? 'collaboration.saving' : submitKey)}
        </button>
        {onCancel ? (
          <button
            className="min-h-[44px] rounded px-2.5 text-xs font-semibold text-[var(--workbench-muted)] hover:bg-white"
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
      </fieldset>
    </form>
  )
}

/** Props for a reaction toggle. */
type ReactionButtonProps = {
  /** Whether the current viewer may change reactions. */
  canReact: boolean
  /** Comment receiving the reaction. */
  comment: TeamIssueComment
  /** Collaboration controller that performs the mutation. */
  controller: IssueCollaborationController
  /** Emoji reaction rendered by the button. */
  reaction: TeamIssueCommentReaction
  /** Translator for reaction labels. */
  t: (key: MessageKey) => string
}

/** Renders one accessible reaction toggle. */
function ReactionButton({
  canReact,
  comment,
  controller,
  reaction,
  t,
}: ReactionButtonProps) {
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

/** Props for a compact comment action button. */
type CommentActionButtonProps = {
  /** Visible action label. */
  label: string
  /** Callback receiving the activated button. */
  onClick: (trigger: HTMLButtonElement) => void
  /** Semantic emphasis for the action. */
  tone?: 'default' | 'primary'
}

/** Renders a compact action button for a comment. */
function CommentActionButton({
  label,
  onClick,
  tone = 'default',
}: CommentActionButtonProps) {
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

/** Props for a non-submitting composer toolbar control. */
type ComposerToolButtonProps = {
  /** Short content rendered inside the control. */
  children: string
  /** Accessible and tooltip label. */
  label: string
  /** Callback for the toolbar action. */
  onClick: () => void
}

/** Renders one compact composer toolbar control. */
function ComposerToolButton({
  children,
  label,
  onClick,
}: ComposerToolButtonProps) {
  return (
    <button
      aria-label={label}
      className="grid min-h-[44px] min-w-[44px] place-items-center rounded px-1.5 text-[0.7rem] font-bold text-[var(--workbench-muted)] transition hover:bg-white hover:text-[var(--workbench-text)]"
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

/** Props for a member avatar with a stable accessible name. */
type MemberAvatarProps = {
  /** Stable member identifier to resolve. */
  memberKey: string
  /** Workspace members available to the current viewer. */
  members: WorkspaceMember[]
  /** Whether to render the compact avatar size. */
  small?: boolean
}

/** Renders a text-based member avatar. */
function MemberAvatar({
  memberKey,
  members,
  small = false,
}: MemberAvatarProps) {
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

/** Renders the loading placeholders for the conversation feed. */
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

/** Checks whether a targeted draft differs from its captured canonical values. */
function isTargetedDraftDirty(draft: TargetedCommentComposerDraft) {
  if (draft.originalBodyMarkdown === undefined) {
    return hasDraftContentValue(draft)
  }

  return draft.bodyMarkdown !== draft.originalBodyMarkdown ||
    JSON.stringify(draft.mentionMemberKeys) !== JSON.stringify(draft.originalMentionMemberKeys ?? [])
}

/** Returns whether a local slot contains user-owned text or mention state. */
function hasDraftContentValue(draft: Pick<CommentComposerDraft, 'bodyMarkdown' | 'mentionMemberKeys'>) {
  return Boolean(draft.bodyMarkdown.trim() || draft.mentionMemberKeys.length)
}

/** Checks whether a retained reply still has an authorized, visible target. */
function isReplyDraftWritable(
  draft: TargetedCommentComposerDraft,
  controller: IssueCollaborationController,
  readOnlyMessage?: string,
) {
  const comment = controller.comments.find((candidate) => candidate.id === draft.commentId)
  const rootComment = comment?.parentCommentId
    ? controller.comments.find((candidate) => candidate.id === (comment.rootCommentId ?? comment.parentCommentId))
    : comment
  return Boolean(
    comment &&
    !comment.deletedAt &&
    comment.source !== 'legacy' &&
    !rootComment?.resolvedAt &&
    !readOnlyMessage &&
    controller.capabilities.canComment &&
    (comment.capabilities?.canReply ?? true),
  )
}

/** Checks whether a retained edit still has an authorized, visible target. */
function isEditDraftWritable(
  draft: TargetedCommentComposerDraft,
  controller: IssueCollaborationController,
  readOnlyMessage?: string,
) {
  const comment = controller.comments.find((candidate) => candidate.id === draft.commentId)
  return Boolean(
    comment &&
    !comment.deletedAt &&
    comment.source !== 'legacy' &&
    !readOnlyMessage &&
    comment.capabilities?.canEdit,
  )
}

/**
 * Groups a flat comment page into roots and chronologically ordered replies.
 *
 * @param comments - Comments returned by the collaboration API.
 * @returns Thread rows suitable for the comment feed.
 */
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

/** Creates the DOM anchor ID for one comment. */
function createCommentAnchorId(commentId: string) {
  return `comment-${encodeURIComponent(commentId)}`
}

/** Resolves the stable author key for a canonical collaboration comment. */
function resolveCommentAuthorKey(comment: TeamIssueComment) {
  return comment.authorMemberKey
}

/** Resolves the Markdown body for a canonical collaboration comment. */
function resolveCommentBody(comment: TeamIssueComment) {
  return comment.bodyMarkdown
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
    authorMemberKey: resolution.capturedCommentAuthorMemberKey ?? '',
    bodyMarkdown: resolution.capturedCommentBody,
    capabilities: {
      canDelete: false,
      canEdit: false,
      canResolve: false,
    },
    createdAt: resolution.acceptedAt,
    id: resolution.sourceCommentId,
    mentionMemberKeys: [],
    parentCommentId:
      resolution.sourceCommentId === resolution.sourceRootCommentId
        ? undefined
        : resolution.sourceRootCommentId,
    rootCommentId: resolution.sourceRootCommentId,
    reactions: [],
    updatedAt: resolution.acceptedAt,
    version: resolution.capturedCommentRevision,
  }
}

/** Finds a workspace member by key, ID, or email. */
function findWorkspaceMember(memberKey: string, members: WorkspaceMember[]) {
  return members.find((member) => member.memberKey === memberKey || member.id === memberKey || member.email === memberKey)
}

/** Formats a member display name with a stable fallback. */
function formatMemberName(member: WorkspaceMember | undefined, fallback: string) {
  return member?.name?.trim() || member?.email || fallback
}

/** Formats one comment timestamp for the current locale. */
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

/** Formats the current typing-member status announcement. */
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

/** Reads the mention query immediately before a composer cursor. */
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
