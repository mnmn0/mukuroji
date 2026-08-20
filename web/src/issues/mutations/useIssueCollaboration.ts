import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import {
  addTeamIssueCommentReaction,
  createTeamIssueRealtimeTicket,
  createTeamIssueComment,
  deleteTeamIssueComment,
  deleteTeamIssuePresence,
  removeTeamIssueCommentReaction,
  reopenTeamIssueComment,
  resolveTeamIssueComment,
  subscribeProjectWatch,
  subscribeTeamIssueWatch,
  type CreateTeamIssueCommentInput,
  type TeamIssueCollaborationCapabilities,
  type TeamIssueCollaborationPage,
  type TeamIssueComment,
  type TeamIssueActivityEvent,
  type TeamIssuePresence,
  type TeamIssueWatchState,
  TeamIssuesApiError,
  type UpdateTeamIssueCommentInput,
  unsubscribeTeamIssueWatch,
  unsubscribeProjectWatch,
  updateTeamIssueComment,
  updateTeamIssuePresence,
} from '../api'
import { getTeamIssueCollaboration } from '../api/collaboration'
import {
  useIssueActivityPages,
  useIssueCollaborationPages,
} from '../queries/useIssueCollaborationPages'
import {
  useIssueContext,
  type IssueContextController,
} from './useIssueContext'

const presenceHeartbeatInterval = 12_000
const typingIdleDelay = 1_800

const emptyCapabilities: TeamIssueCollaborationCapabilities = {
  canComment: false,
  canReact: false,
  canWatch: false,
}

/**
 * thread ごとの reply pagination 状態です。
 */
export type TeamIssueReplyPagination = {
  /**
   * 過去の reply page が残っているかどうかです。
   */
  hasMore: boolean
  /**
   * reply page を読み込み中かどうかです。
   */
  isLoading: boolean
}

/**
 * Work Item collaboration hook の入力です。
 */
export type UseIssueCollaborationOptions = {
  /**
   * Team-owned Work Item の team ID です。
   */
  teamId?: string
  /**
   * Team-owned Work Item の issue ID です。
   */
  issueId?: string
  /**
   * API 認証に使う Cognito access token です。
   */
  accessToken?: string
  /**
   * legacy row などで取得と heartbeat を停止するかどうかです。
   */
  enabled?: boolean
  /**
   * Work Item の割り当て先 Project ID です。
   */
  projectId?: string
}

/**
 * IssueCollaborationPanel が利用する data と action です。
 */
export type IssueCollaborationController = {
  /**
   * Independently paginated human-curated decisions and sources.
   */
  context: IssueContextController
  /**
   * 読み込み済みの comment / reply 一覧です。
   */
  comments: TeamIssueComment[]
  /**
   * append-only audit 基盤から取得した activity です。
   */
  activity: TeamIssueActivityEvent[]
  /**
   * watcher 状態です。
   */
  watch?: TeamIssueWatchState
  /**
   * アクティブな member の presence です。
   */
  presence: TeamIssuePresence[]
  /**
   * 共同作業パネル全体の操作権限です。
   */
  capabilities: TeamIssueCollaborationCapabilities
  /**
   * 最初の page を読み込み中かどうかです。
   */
  isLoading: boolean
  /**
   * 追加 page を読み込み中かどうかです。
   */
  isLoadingMore: boolean
  /**
   * activity の最初の page を読み込み中かどうかです。
   */
  isActivityLoading: boolean
  /**
   * activity の追加 page を読み込み中かどうかです。
   */
  isLoadingMoreActivity: boolean
  /**
   * 追加 page があるかどうかです。
   */
  hasMore: boolean
  /**
   * activity の追加 page があるかどうかです。
   */
  hasMoreActivity: boolean
  /**
   * collaboration の取得に失敗したかどうかです。
   */
  hasLoadError: boolean
  /**
   * activity の取得に失敗したかどうかです。
   */
  hasActivityLoadError: boolean
  /**
   * 直近の collaboration mutation に失敗したかどうかです。
   */
  hasMutationError: boolean
  /**
   * 直近の mutation が失敗した HTTP status code です。
   */
  mutationErrorStatus?: number
  /**
   * Shell が認証 policy error を一元処理するための raw load/mutation errors です。
   */
  sessionErrors?: readonly unknown[]
  /**
   * root comment ID ごとの reply pagination 状態です。
   */
  replyPagination: Record<string, TeamIssueReplyPagination>
  /**
   * comment または reply を作成します。
   */
  createComment: (input: CreateTeamIssueCommentInput) => Promise<boolean>
  /**
   * comment の本文と mention を更新します。
   */
  updateComment: (comment: TeamIssueComment, input: UpdateTeamIssueCommentInput) => Promise<boolean>
  /**
   * comment を soft delete します。
   */
  deleteComment: (comment: TeamIssueComment) => Promise<boolean>
  /**
   * comment thread の resolve / reopen を切り替えます。
   */
  setResolved: (comment: TeamIssueComment, resolved: boolean) => Promise<boolean>
  /**
   * emoji reaction を追加または削除します。
   */
  toggleReaction: (comment: TeamIssueComment, emoji: string, reactedByMe: boolean) => Promise<boolean>
  /**
   * 現在のユーザーの watcher 状態を切り替えます。
   */
  toggleWatch: () => Promise<boolean>
  /**
   * 割り当て先 Project の watcher 状態を切り替えます。
   */
  toggleProjectWatch?: () => Promise<boolean>
  /**
   * cursor の次 page を読み込みます。
   */
  loadMore: () => Promise<void>
  /**
   * activity cursor の次 page を読み込みます。
   */
  loadMoreActivity: () => Promise<void>
  /**
   * 指定 thread の過去の reply page を読み込みます。
   */
  loadMoreReplies: (rootCommentId: string) => Promise<void>
  /**
   * comment composer の typing を heartbeat に反映します。
   */
  markTyping: () => void
  /**
   * 表示中の collaboration page を即時再検証します。
   */
  refresh: () => Promise<void>
}

/**
 * comment thread を issue detail と分離して polling し、共同作業 mutation をまとめます。
 */
export function useIssueCollaboration({
  accessToken,
  enabled = true,
  issueId,
  projectId,
  teamId,
}: UseIssueCollaborationOptions): IssueCollaborationController {
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const [clientId] = useState(createPresenceClientId)
  const realtimeSocketRef = useRef<WebSocket | null>(null)
  const lastReplyRevalidatedPagesRef = useRef<TeamIssueCollaborationPage[] | undefined>(undefined)
  const replyRevalidationIdRef = useRef(0)
  const typingTimeoutRef = useRef<number | undefined>(undefined)
  const typingRef = useRef(false)
  const collaborationScope = `${enabled ? 'enabled' : 'disabled'}:${teamId ?? ''}:${issueId ?? ''}:${projectId ?? ''}`
  const [typingState, setTypingState] = useState({ active: false, scope: '' })
  const [mutationError, setMutationError] = useState<{
    /** API が返した安定 error code です。 */
    code?: string
    /** Error が属する collaboration scope です。 */
    scope: string
    /** API が返した HTTP status です。 */
    status?: number
  }>()
  const [replyPageState, setReplyPageState] = useState({
    comments: [] as TeamIssueComment[],
    cursors: {} as Record<string, string | undefined>,
    loadingRootIds: [] as string[],
    pageCounts: {} as Record<string, number>,
    scope: '',
  })
  const replyPageStateRef = useRef(replyPageState)
  const typing = typingState.scope === collaborationScope && typingState.active
  const activeMutationError = mutationError?.scope === collaborationScope ? mutationError : undefined
  const isConfigured = Boolean(enabled && accessToken && teamId && issueId)
  const context = useIssueContext({
    accessToken,
    enabled,
    issueId,
    teamId,
  })
  const refreshContext = context.refresh

  useEffect(() => {
    replyPageStateRef.current = replyPageState
  }, [replyPageState])

  const {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
    setSize,
    size,
  } = useIssueCollaborationPages(accessToken, teamId, issueId, isConfigured)
  const {
    data: activityPages,
    error: activityError,
    isLoading: isActivityLoading,
    isValidating: isActivityValidating,
    mutate: mutateActivity,
    setSize: setActivitySize,
    size: activitySize,
  } = useIssueActivityPages(accessToken, teamId, issueId, isConfigured)
  const comments = useMemo(() => {
    const loadedReplyComments = replyPageState.scope === collaborationScope
      ? replyPageState.comments
      : []

    return deduplicateIssueComments([
      ...(data?.flatMap((page) => page.comments) ?? []),
      ...loadedReplyComments,
    ])
  }, [collaborationScope, data, replyPageState.comments, replyPageState.scope])
  const activity = useMemo(
    () => mergeActivity(activityPages?.flatMap((page) => page.events) ?? []),
    [activityPages],
  )
  const firstPage = data?.[0]
  const lastPage = data?.at(-1)
  const lastActivityPage = activityPages?.at(-1)
  const initialReplyNextCursors = useMemo(
    () => collectReplyNextCursors(data),
    [data],
  )
  const replyPagination = useMemo(() => {
    const loadedCursors = replyPageState.scope === collaborationScope
      ? replyPageState.cursors
      : {}
    const loadingRootIds = new Set(
      replyPageState.scope === collaborationScope ? replyPageState.loadingRootIds : [],
    )
    const rootCommentIds = new Set([
      ...Object.keys(initialReplyNextCursors),
      ...Object.keys(loadedCursors),
      ...loadingRootIds,
    ])

    return Object.fromEntries(Array.from(rootCommentIds, (rootCommentId) => {
      const cursor = Object.hasOwn(loadedCursors, rootCommentId)
        ? loadedCursors[rootCommentId]
        : initialReplyNextCursors[rootCommentId]

      return [rootCommentId, {
        hasMore: Boolean(cursor),
        isLoading: loadingRootIds.has(rootCommentId),
      }]
    }))
  }, [collaborationScope, initialReplyNextCursors, replyPageState])

  const revalidateLoadedReplyPages = useCallback(async (
    currentPages: TeamIssueCollaborationPage[] | undefined,
    force = false,
  ) => {
    if (!accessToken || !teamId || !issueId) {
      return
    }

    const currentReplyState = replyPageStateRef.current

    if (currentReplyState.scope !== collaborationScope) {
      return
    }

    const pageCounts = Object.entries(currentReplyState.pageCounts)

    if (pageCounts.length === 0) {
      return
    }

    if (!force && currentPages && lastReplyRevalidatedPagesRef.current === currentPages) {
      return
    }

    lastReplyRevalidatedPagesRef.current = currentPages

    const firstReplyCursors = collectReplyNextCursors(currentPages)
    const revalidationId = replyRevalidationIdRef.current + 1

    replyRevalidationIdRef.current = revalidationId
    const refreshedThreads = await Promise.all(pageCounts.map(async ([rootCommentId, pageCount]) => {
      let cursor: string | undefined = firstReplyCursors[rootCommentId]
      const refreshedComments: TeamIssueComment[] = []

      try {
        for (let pageIndex = 0; pageIndex < pageCount && cursor; pageIndex += 1) {
          const page = await getTeamIssueCollaboration(teamId, issueId, accessToken, {
            cursor,
            limit: 100,
            rootCommentId,
          })

          refreshedComments.push(...page.comments)
          cursor = page.replyNextCursors?.[rootCommentId] ?? page.nextCursor
        }

        return { comments: refreshedComments, cursor, rootCommentId }
      } catch (replyPageError) {
        console.error('Issue collaboration replies failed to refresh:', replyPageError)
        return undefined
      }
    }))
    const successfulThreads = refreshedThreads.filter((thread) => thread !== undefined)

    if (successfulThreads.length === 0) {
      return
    }

    setReplyPageState((current) => {
      if (current.scope !== collaborationScope || replyRevalidationIdRef.current !== revalidationId) {
        return current
      }

      const refreshedRootIds = new Set(successfulThreads.map((thread) => thread.rootCommentId))
      const retainedComments = current.comments.filter((comment) =>
        !refreshedRootIds.has(comment.rootCommentId ?? comment.parentCommentId ?? ''),
      )
      const cursors = { ...current.cursors }

      for (const thread of successfulThreads) {
        cursors[thread.rootCommentId] = thread.cursor
      }

      return {
        ...current,
        comments: deduplicateIssueComments([
          ...retainedComments,
          ...successfulThreads.flatMap((thread) => thread.comments),
        ]),
        cursors,
      }
    })
  }, [accessToken, collaborationScope, issueId, teamId])

  useEffect(() => {
    void revalidateLoadedReplyPages(data)
  }, [data, revalidateLoadedReplyPages])

  const isLoadingMore = Boolean(data && size > 0 && data.length < size && isValidating)
  const isLoadingMoreActivity = Boolean(
    activityPages && activitySize > 0 && activityPages.length < activitySize && isActivityValidating,
  )

  const refresh = useCallback(async () => {
    const [refreshedCollaboration] = await Promise.all([mutate(), mutateActivity()])

    await revalidateLoadedReplyPages(refreshedCollaboration, true)
  }, [mutate, mutateActivity, revalidateLoadedReplyPages])

  const runMutation = useCallback(async (
    operationKey: string,
    fingerprint: string,
    request: Parameters<typeof mutationRunner.run>[2],
  ) => {
    setMutationError((current) => current?.scope === collaborationScope ? undefined : current)

    try {
      await mutationRunner.run(operationKey, fingerprint, request)
      await refresh()
      return true
    } catch (mutationError) {
      console.error('Issue collaboration mutation failed:', mutationError)
      const mutationErrorStatus = mutationError instanceof TeamIssuesApiError
        ? mutationError.status
        : undefined
      const mutationErrorCode = mutationError instanceof TeamIssuesApiError
        ? mutationError.code
        : undefined

      setMutationError({
        code: mutationErrorCode,
        scope: collaborationScope,
        status: mutationErrorStatus,
      })
      if (mutationErrorStatus === 409) {
        await refresh().catch(() => undefined)
      }
      return false
    }
  }, [collaborationScope, mutationRunner, refresh])

  const createComment = useCallback(async (input: CreateTeamIssueCommentInput) => {
    if (!accessToken || !teamId || !issueId) {
      return false
    }

    const succeeded = await runMutation(
      `issue:comment:create:${teamId}:${issueId}:${input.parentCommentId ?? 'root'}`,
      JSON.stringify(input),
      (context) => createTeamIssueComment(teamId, issueId, accessToken, input, context),
    )

    if (succeeded) {
      setTypingState({ active: false, scope: collaborationScope })
    }

    return succeeded
  }, [accessToken, collaborationScope, issueId, runMutation, teamId])

  const updateComment = useCallback(async (
    comment: TeamIssueComment,
    input: UpdateTeamIssueCommentInput,
  ) => {
    if (!accessToken || !teamId || !issueId) {
      return false
    }

    return runMutation(
      `issue:comment:update:${teamId}:${issueId}:${comment.id}`,
      JSON.stringify(input),
      (context) => updateTeamIssueComment(teamId, issueId, comment.id, accessToken, input, context),
    )
  }, [accessToken, issueId, runMutation, teamId])

  const deleteComment = useCallback(async (comment: TeamIssueComment) => {
    if (!accessToken || !teamId || !issueId) {
      return false
    }

    const expectedVersion = resolveCommentVersion(comment)

    return runMutation(
      `issue:comment:delete:${teamId}:${issueId}:${comment.id}`,
      String(expectedVersion),
      (context) => deleteTeamIssueComment(
        teamId,
        issueId,
        comment.id,
        accessToken,
        expectedVersion,
        context,
      ),
    )
  }, [accessToken, issueId, runMutation, teamId])

  const setResolved = useCallback(async (comment: TeamIssueComment, resolved: boolean) => {
    if (!accessToken || !teamId || !issueId) {
      return false
    }

    const expectedVersion = resolveCommentVersion(comment)
    const action = resolved ? 'resolve' : 'reopen'

    return runMutation(
      `issue:comment:${action}:${teamId}:${issueId}:${comment.id}`,
      String(expectedVersion),
      (context) => resolved
        ? resolveTeamIssueComment(teamId, issueId, comment.id, accessToken, expectedVersion, context)
        : reopenTeamIssueComment(teamId, issueId, comment.id, accessToken, expectedVersion, context),
    )
  }, [accessToken, issueId, runMutation, teamId])

  const toggleReaction = useCallback(async (
    comment: TeamIssueComment,
    emoji: string,
    reactedByMe: boolean,
  ) => {
    if (!accessToken || !teamId || !issueId) {
      return false
    }

    return runMutation(
      `issue:comment:reaction:${teamId}:${issueId}:${comment.id}:${emoji}`,
      JSON.stringify({ emoji, reactedByMe }),
      (context) => reactedByMe
        ? removeTeamIssueCommentReaction(teamId, issueId, comment.id, emoji, accessToken, context)
        : addTeamIssueCommentReaction(teamId, issueId, comment.id, emoji, accessToken, context),
    )
  }, [accessToken, issueId, runMutation, teamId])

  const toggleWatch = useCallback(async () => {
    if (!accessToken || !teamId || !issueId || !firstPage?.watch) {
      return false
    }

    return runMutation(
      `issue:watch:${teamId}:${issueId}`,
      String(!firstPage.watch.subscribed),
      (context) => firstPage.watch.subscribed
        ? unsubscribeTeamIssueWatch(teamId, issueId, accessToken, context)
        : subscribeTeamIssueWatch(teamId, issueId, accessToken, context),
    )
  }, [accessToken, firstPage, issueId, runMutation, teamId])

  const toggleProjectWatch = useCallback(async () => {
    if (!accessToken || !projectId || !firstPage?.watch || firstPage.watch.projectSubscribed === undefined) {
      return false
    }

    return runMutation(
      `project:watch:${projectId}`,
      String(!firstPage.watch.projectSubscribed),
      (context) => firstPage.watch.projectSubscribed
        ? unsubscribeProjectWatch(projectId, accessToken, context)
        : subscribeProjectWatch(projectId, accessToken, context),
    )
  }, [accessToken, firstPage, projectId, runMutation])

  const loadMore = useCallback(async () => {
    if (!lastPage?.nextCursor) {
      return
    }

    await setSize(size + 1)
  }, [lastPage?.nextCursor, setSize, size])

  const loadMoreActivity = useCallback(async () => {
    if (!lastActivityPage?.nextCursor) {
      return
    }

    await setActivitySize(activitySize + 1)
  }, [activitySize, lastActivityPage?.nextCursor, setActivitySize])

  const loadMoreReplies = useCallback(async (rootCommentId: string) => {
    if (!accessToken || !teamId || !issueId) {
      return
    }

    const scopedReplyState = replyPageState.scope === collaborationScope
      ? replyPageState
      : undefined
    const cursor = scopedReplyState && Object.hasOwn(scopedReplyState.cursors, rootCommentId)
      ? scopedReplyState.cursors[rootCommentId]
      : initialReplyNextCursors[rootCommentId]

    if (!cursor || scopedReplyState?.loadingRootIds.includes(rootCommentId)) {
      return
    }

    replyRevalidationIdRef.current += 1
    lastReplyRevalidatedPagesRef.current = undefined

    setReplyPageState((current) => {
      const scopedCurrent = current.scope === collaborationScope
        ? current
        : {
            comments: [],
            cursors: {},
            loadingRootIds: [],
            pageCounts: {},
            scope: collaborationScope,
          }

      return {
        ...scopedCurrent,
        loadingRootIds: Array.from(new Set([...scopedCurrent.loadingRootIds, rootCommentId])),
      }
    })

    try {
      const page = await getTeamIssueCollaboration(teamId, issueId, accessToken, {
        cursor,
        limit: 100,
        rootCommentId,
      })

      setReplyPageState((current) => {
        if (current.scope !== collaborationScope) {
          return current
        }

        return {
          ...current,
          comments: deduplicateIssueComments([...current.comments, ...page.comments]),
          cursors: {
            ...current.cursors,
            [rootCommentId]: page.replyNextCursors?.[rootCommentId] ?? page.nextCursor,
          },
          loadingRootIds: current.loadingRootIds.filter((id) => id !== rootCommentId),
          pageCounts: {
            ...current.pageCounts,
            [rootCommentId]: (current.pageCounts[rootCommentId] ?? 0) + 1,
          },
        }
      })
    } catch (replyPageError) {
      console.error('Issue collaboration replies failed to load:', replyPageError)
      setReplyPageState((current) => current.scope === collaborationScope
        ? {
            ...current,
            loadingRootIds: current.loadingRootIds.filter((id) => id !== rootCommentId),
          }
        : current)
    }
  }, [
    accessToken,
    collaborationScope,
    initialReplyNextCursors,
    issueId,
    replyPageState,
    teamId,
  ])

  const markTyping = useCallback(() => {
    if (!isConfigured) {
      return
    }

    setTypingState({ active: true, scope: collaborationScope })

    if (typingTimeoutRef.current !== undefined) {
      window.clearTimeout(typingTimeoutRef.current)
    }

    typingTimeoutRef.current = window.setTimeout(() => {
      setTypingState((current) => current.scope === collaborationScope
        ? { ...current, active: false }
        : current)
    }, typingIdleDelay)
  }, [collaborationScope, isConfigured])

  useEffect(() => {
    typingRef.current = typing
  }, [typing])

  useEffect(() => {
    if (!isConfigured || !accessToken || !teamId || !issueId || typeof WebSocket === 'undefined') {
      return
    }

    let disposed = false

    void createTeamIssueRealtimeTicket(teamId, issueId, accessToken)
      .then((realtimeTicket) => {
        if (disposed) {
          return
        }

        const websocketUrl = new URL(realtimeTicket.websocketUrl)
        websocketUrl.searchParams.set('ticket', realtimeTicket.ticket)
        const socket = new WebSocket(websocketUrl)

        realtimeSocketRef.current = socket
        socket.addEventListener('open', () => {
          sendRealtimePresence(socket, clientId, typingRef.current)
        })
        socket.addEventListener('message', (event) => {
          const realtimeMessage = parseRealtimePresenceMessage(event.data)

          if (realtimeMessage) {
            void mutate(
              (currentPages) => updateRealtimePresencePages(currentPages, realtimeMessage),
              { revalidate: false },
            )
            return
          }

          void Promise.all([refresh(), refreshContext()])
        })
        socket.addEventListener('close', () => {
          if (realtimeSocketRef.current === socket) {
            realtimeSocketRef.current = null
          }
        })
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      realtimeSocketRef.current?.close()
      realtimeSocketRef.current = null
    }
  }, [accessToken, clientId, isConfigured, issueId, mutate, refresh, refreshContext, teamId])

  useEffect(() => {
    if (!isConfigured || !accessToken || !teamId || !issueId) {
      return
    }

    const heartbeat = () => {
      void updateTeamIssuePresence(teamId, issueId, accessToken, clientId, typingRef.current)
        .catch(() => undefined)
      sendRealtimePresence(realtimeSocketRef.current, clientId, typingRef.current)
    }

    heartbeat()
    const intervalId = window.setInterval(heartbeat, presenceHeartbeatInterval)

    return () => {
      window.clearInterval(intervalId)
      void deleteTeamIssuePresence(teamId, issueId, accessToken, clientId).catch(() => undefined)
    }
  }, [accessToken, clientId, isConfigured, issueId, teamId])

  useEffect(() => {
    if (!isConfigured || !accessToken || !teamId || !issueId) {
      return
    }

    void updateTeamIssuePresence(teamId, issueId, accessToken, clientId, typing)
      .catch(() => undefined)
    sendRealtimePresence(realtimeSocketRef.current, clientId, typing)
  }, [accessToken, clientId, isConfigured, issueId, teamId, typing])

  useEffect(() => () => {
    if (typingTimeoutRef.current !== undefined) {
      window.clearTimeout(typingTimeoutRef.current)
    }
  }, [])

  return {
    activity,
    capabilities: firstPage?.capabilities ?? emptyCapabilities,
    comments,
    context,
    createComment,
    deleteComment,
    hasActivityLoadError: Boolean(activityError),
    hasLoadError: Boolean(error),
    hasMore: Boolean(lastPage?.nextCursor),
    hasMoreActivity: Boolean(lastActivityPage?.nextCursor),
    hasMutationError: Boolean(activeMutationError),
    isActivityLoading: Boolean(isConfigured && isActivityLoading),
    isLoading: Boolean(isConfigured && isLoading),
    isLoadingMore,
    isLoadingMoreActivity,
    loadMore,
    loadMoreActivity,
    loadMoreReplies,
    markTyping,
    mutationErrorStatus: activeMutationError?.status,
    presence: firstPage?.presence ?? [],
    refresh,
    replyPagination,
    sessionErrors: [
      error,
      activityError,
      activeMutationError,
      ...(context.sessionErrors ?? []),
    ],
    setResolved,
    toggleReaction,
    toggleProjectWatch: projectId ? toggleProjectWatch : undefined,
    toggleWatch,
    updateComment,
    watch: firstPage?.watch,
  }
}

function createPresenceClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `presence-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function resolveCommentVersion(comment: TeamIssueComment) {
  return Number.isInteger(comment.version) && (comment.version ?? 0) > 0 ? comment.version ?? 1 : 1
}

/** Deduplicates canonical comments loaded from overlapping pages or refreshes. */
function deduplicateIssueComments(comments: TeamIssueComment[]) {
  const commentsById = new Map<string, TeamIssueComment>()

  for (const comment of comments) {
    commentsById.set(comment.id, comment)
  }

  return Array.from(commentsById.values())
}

/** Merges paginated canonical comments by their stable identifier. */
export function mergeIssueComments(comments: TeamIssueComment[]) {
  return deduplicateIssueComments(comments)
}

function mergeActivity(events: TeamIssueActivityEvent[]) {
  const eventsById = new Map<string, TeamIssueActivityEvent>()

  for (const event of events) {
    eventsById.set(event.eventId, event)
  }

  return Array.from(eventsById.values())
}

function collectReplyNextCursors(pages: TeamIssueCollaborationPage[] | undefined) {
  return Object.assign(
    {},
    ...(pages?.map((page) => page.replyNextCursors ?? {}) ?? []),
  ) as Record<string, string>
}

function parseRealtimePresenceMessage(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  try {
    const message: unknown = JSON.parse(value)

    if (!message || typeof message !== 'object') {
      return undefined
    }

    if (
      'type' in message && message.type === 'typing' &&
      'memberKey' in message && typeof message.memberKey === 'string' &&
      'isTyping' in message && typeof message.isTyping === 'boolean' &&
      'occurredAt' in message && typeof message.occurredAt === 'string'
    ) {
      return {
        isTyping: message.isTyping,
        memberKey: message.memberKey,
        occurredAt: message.occurredAt,
        type: 'typing' as const,
      }
    }

    if (
      'type' in message && message.type === 'presence' &&
      'memberKey' in message && typeof message.memberKey === 'string' &&
      'state' in message && (message.state === 'active' || message.state === 'idle') &&
      'occurredAt' in message && typeof message.occurredAt === 'string'
    ) {
      return {
        memberKey: message.memberKey,
        occurredAt: message.occurredAt,
        state: message.state,
        type: 'presence' as const,
      }
    }
  } catch {
    return undefined
  }

  return undefined
}

function updateRealtimePresencePages(
  pages: TeamIssueCollaborationPage[] | undefined,
  message: NonNullable<ReturnType<typeof parseRealtimePresenceMessage>>,
) {
  const firstPage = pages?.[0]

  if (!firstPage) {
    return pages
  }

  const currentPresence = firstPage.presence.find((presence) => presence.memberKey === message.memberKey)
  const presence = message.type === 'presence' && message.state === 'idle'
    ? firstPage.presence.filter((item) => item.memberKey !== message.memberKey)
    : [
        ...firstPage.presence.filter((item) => item.memberKey !== message.memberKey),
        {
          lastSeenAt: message.occurredAt,
          memberKey: message.memberKey,
          typing: message.type === 'typing' ? message.isTyping : currentPresence?.typing ?? false,
        },
      ]

  return [{ ...firstPage, presence }, ...pages.slice(1)]
}

function sendRealtimePresence(socket: WebSocket | null, clientId: string, typing: boolean) {
  if (socket?.readyState !== WebSocket.OPEN) {
    return
  }

  socket.send(JSON.stringify({
    action: 'typing',
    isTyping: typing,
  }))
  socket.send(JSON.stringify({
    action: 'presence',
    clientId,
    state: 'active',
  }))
}
