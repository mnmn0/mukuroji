import type {
  AcceptedResolution,
  CuratedContextCapabilities,
  CuratedContextItem,
  CreateCuratedContextItemRequest,
  SetAcceptedResolutionRequest,
  UpdateCuratedContextItemRequest,
} from '@mukuroji/contracts'
import { useCallback, useMemo, useRef, useState } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import {
  createTeamIssueContextItem,
  setTeamIssueAcceptedResolution,
  TeamIssuesApiError,
  updateTeamIssueContextItem,
} from '../api'
import { useIssueContextPages } from '../queries/useIssueContextPages'
import {
  useIssueAcceptedResolutionPages,
  useIssueContextRevisionPages,
} from '../queries/useIssueContextHistoryPages'

const emptyContextCapabilities: CuratedContextCapabilities = {
  canAcceptResolution: false,
  canCreate: false,
  canEdit: false,
  canReplace: false,
}

/**
 * Input scope for the curated context controller.
 */
export type UseIssueContextOptions = {
  /** Team that owns the Work Item. */
  teamId?: string
  /** Work Item identifier. */
  issueId?: string
  /** Issues API access token. */
  accessToken?: string
  /** Whether the scoped query and mutations may run. */
  enabled?: boolean
}

/**
 * Lazy cursor state for one selected curated context revision history.
 */
export type CuratedContextRevisionHistoryState = {
  /** Curated item whose history is open. */
  contextItemId?: string
  /** Loaded immutable snapshots in newest-first order. */
  items: CuratedContextItem[]
  /** Whether the first revision page is loading. */
  isLoading: boolean
  /** Whether an additional revision page is loading. */
  isLoadingMore: boolean
  /** Whether another opaque revision cursor is available. */
  hasMore: boolean
  /** Whether the selected revision history failed to load. */
  hasLoadError: boolean
}

/**
 * Lazy cursor state for one selected accepted-resolution history.
 */
export type AcceptedResolutionHistoryState = {
  /** Root comment whose accepted-resolution history is open. */
  rootCommentId?: string
  /** Loaded accepted-resolution snapshots in newest-first order. */
  items: AcceptedResolution[]
  /** Whether the first resolution page is loading. */
  isLoading: boolean
  /** Whether an additional resolution page is loading. */
  isLoadingMore: boolean
  /** Whether another opaque resolution cursor is available. */
  hasMore: boolean
  /** Whether the selected resolution history failed to load. */
  hasLoadError: boolean
}

/**
 * Data and actions for the Decisions and Sources tabs.
 */
export type IssueContextController = {
  /** Loaded curated items in deterministic ledger order. */
  items: CuratedContextItem[]
  /** Permission-derived context actions. */
  capabilities: CuratedContextCapabilities
  /** Lazy immutable revision history for the selected curated item. */
  revisionHistory: CuratedContextRevisionHistoryState
  /** Lazy accepted-resolution history for the selected root thread. */
  acceptedResolutionHistory: AcceptedResolutionHistoryState
  /** Whether the first context page is loading. */
  isLoading: boolean
  /** Whether an additional context page is loading. */
  isLoadingMore: boolean
  /** Whether another opaque context cursor is available. */
  hasMore: boolean
  /** Whether the latest context load failed. */
  hasLoadError: boolean
  /** Whether the latest context mutation failed. */
  hasMutationError: boolean
  /** HTTP status from the latest failed context mutation. */
  mutationErrorStatus?: number
  /** Raw errors consumed by the shared session policy handler. */
  sessionErrors?: readonly unknown[]
  /** Creates a curated item, optionally superseding an existing item. */
  createItem: (input: CreateCuratedContextItemRequest) => Promise<boolean>
  /** Updates a curated item behind an optimistic revision fence. */
  updateItem: (
    item: CuratedContextItem,
    input: UpdateCuratedContextItemRequest,
  ) => Promise<boolean>
  /** Selects or replaces one root thread's accepted resolution. */
  setAcceptedResolution: (
    rootCommentId: string,
    input: SetAcceptedResolutionRequest,
  ) => Promise<boolean>
  /** Opens one curated item's revision history and starts its first load. */
  openRevisionHistory: (contextItemId: string) => void
  /** Closes the selected curated item revision history. */
  closeRevisionHistory: () => void
  /** Loads the next opaque revision-history page. */
  loadMoreRevisions: () => Promise<void>
  /** Retries the selected revision history. */
  retryRevisionHistory: () => Promise<void>
  /** Opens one root thread's accepted-resolution history. */
  openAcceptedResolutionHistory: (rootCommentId: string) => void
  /** Closes the selected accepted-resolution history. */
  closeAcceptedResolutionHistory: () => void
  /** Loads the next opaque accepted-resolution page. */
  loadMoreAcceptedResolutions: () => Promise<void>
  /** Retries the selected accepted-resolution history. */
  retryAcceptedResolutionHistory: () => Promise<void>
  /** Loads the next opaque context page. */
  loadMore: () => Promise<void>
  /** Revalidates every loaded context page. */
  refresh: () => Promise<void>
}

/**
 * Loads independently paginated curated context and owns its revision-fenced mutations.
 *
 * @param options - Team, Work Item, token, and enabled scope.
 * @returns Context data and mutation actions for collaboration tabs.
 */
export function useIssueContext({
  accessToken,
  enabled = true,
  issueId,
  teamId,
}: UseIssueContextOptions): IssueContextController {
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const scope = `${enabled ? 'enabled' : 'disabled'}:${teamId ?? ''}:${issueId ?? ''}`
  const [revisionHistoryTarget, setRevisionHistoryTarget] = useState<{
    /** Curated item selected within this controller scope. */
    contextItemId: string
    /** Scope that owns the selection. */
    scope: string
  }>()
  const [acceptedResolutionHistoryTarget, setAcceptedResolutionHistoryTarget] =
    useState<{
      /** Root comment selected within this controller scope. */
      rootCommentId: string
      /** Scope that owns the selection. */
      scope: string
    }>()
  const [mutationFailure, setMutationFailure] = useState<{
    /** Raw error retained for session policy handling. */
    error: unknown
    /** Context scope that owns the failure. */
    scope: string
    /** Optional HTTP status returned by the API. */
    status?: number
  }>()
  const isConfigured = Boolean(enabled && accessToken && teamId && issueId)
  const {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
    setSize,
    size,
  } = useIssueContextPages(accessToken, teamId, issueId, isConfigured)
  const selectedContextItemId =
    revisionHistoryTarget?.scope === scope
      ? revisionHistoryTarget.contextItemId
      : undefined
  const selectedRootCommentId =
    acceptedResolutionHistoryTarget?.scope === scope
      ? acceptedResolutionHistoryTarget.rootCommentId
      : undefined
  const {
    data: revisionPages,
    error: revisionError,
    isLoading: isRevisionLoading,
    isValidating: isRevisionValidating,
    mutate: mutateRevisions,
    setSize: setRevisionSize,
    size: revisionSize,
  } = useIssueContextRevisionPages(
    accessToken,
    teamId,
    issueId,
    selectedContextItemId,
  )
  const {
    data: acceptedResolutionPages,
    error: acceptedResolutionError,
    isLoading: isAcceptedResolutionLoading,
    isValidating: isAcceptedResolutionValidating,
    mutate: mutateAcceptedResolutions,
    setSize: setAcceptedResolutionSize,
    size: acceptedResolutionSize,
  } = useIssueAcceptedResolutionPages(
    accessToken,
    teamId,
    issueId,
    selectedRootCommentId,
  )
  const firstPage = data?.[0]
  const lastPage = data?.at(-1)
  const activeMutationFailure =
    mutationFailure?.scope === scope ? mutationFailure : undefined
  const items = useMemo(
    () =>
      mergeCuratedContextItems(
        data?.flatMap((page) => page.items) ?? [],
      ),
    [data],
  )
  const revisionItems = useMemo(
    () => mergeCuratedContextRevisions(
      revisionPages?.flatMap((page) => page.items) ?? [],
    ),
    [revisionPages],
  )
  const acceptedResolutionItems = useMemo(
    () => mergeAcceptedResolutionHistory(
      acceptedResolutionPages?.flatMap((page) => page.items) ?? [],
    ),
    [acceptedResolutionPages],
  )
  const isLoadingMore = Boolean(
    data && size > 0 && data.length < size && isValidating,
  )
  const isLoadingMoreRevisions = Boolean(
    revisionPages &&
      revisionSize > 0 &&
      revisionPages.length < revisionSize &&
      isRevisionValidating,
  )
  const isLoadingMoreAcceptedResolutions = Boolean(
    acceptedResolutionPages &&
      acceptedResolutionSize > 0 &&
      acceptedResolutionPages.length < acceptedResolutionSize &&
      isAcceptedResolutionValidating,
  )

  const refresh = useCallback(async () => {
    await mutate()
  }, [mutate])

  const runMutation = useCallback(
    async (
      operationKey: string,
      fingerprint: string,
      request: Parameters<typeof mutationRunner.run>[2],
    ) => {
      setMutationFailure((current) =>
        current?.scope === scope ? undefined : current,
      )

      try {
        await mutationRunner.run(operationKey, fingerprint, request)
      } catch (mutationError) {
        console.error('Issue context mutation failed:', mutationError)
        const status =
          mutationError instanceof TeamIssuesApiError
            ? mutationError.status
            : undefined
        setMutationFailure({ error: mutationError, scope, status })
        if (status === 409) await refresh().catch(() => undefined)
        return false
      }

      // The mutation has committed at this point. A transient revalidation
      // failure must not turn a successful request into a retryable failure:
      // the runner has already consumed the idempotency context and retrying
      // could create a duplicate or conflict with the committed revision.
      try {
        await refresh()
      } catch (refreshError) {
        console.error('Issue context revalidation failed:', refreshError)
      }
      return true
    },
    [mutationRunner, refresh, scope],
  )

  const createItem = useCallback(
    async (input: CreateCuratedContextItemRequest) => {
      if (!accessToken || !teamId || !issueId) return false

      const succeeded = await runMutation(
        `issue:context:create:${teamId}:${issueId}:${input.supersedesItemId ?? 'new'}`,
        JSON.stringify(input),
        (context) =>
          createTeamIssueContextItem(
            teamId,
            issueId,
            accessToken,
            input,
            context,
          ),
      )
      if (
        succeeded &&
        selectedContextItemId === input.supersedesItemId
      ) {
        await refreshAuxiliaryContextQuery('revision history', mutateRevisions)
      }
      return succeeded
    },
    [
      accessToken,
      issueId,
      mutateRevisions,
      runMutation,
      selectedContextItemId,
      teamId,
    ],
  )

  const updateItem = useCallback(
    async (
      item: CuratedContextItem,
      input: UpdateCuratedContextItemRequest,
    ) => {
      if (!accessToken || !teamId || !issueId) return false

      const succeeded = await runMutation(
        `issue:context:update:${teamId}:${issueId}:${item.id}`,
        JSON.stringify(input),
        (context) =>
          updateTeamIssueContextItem(
            teamId,
            issueId,
            item.id,
            accessToken,
            input,
            context,
          ),
      )
      if (succeeded && selectedContextItemId === item.id) {
        await refreshAuxiliaryContextQuery('revision history', mutateRevisions)
      }
      return succeeded
    },
    [
      accessToken,
      issueId,
      mutateRevisions,
      runMutation,
      selectedContextItemId,
      teamId,
    ],
  )

  const setAcceptedResolution = useCallback(
    async (rootCommentId: string, input: SetAcceptedResolutionRequest) => {
      if (!accessToken || !teamId || !issueId) return false

      const succeeded = await runMutation(
        `issue:resolution:set:${teamId}:${issueId}:${rootCommentId}`,
        JSON.stringify(input),
        (context) =>
          setTeamIssueAcceptedResolution(
            teamId,
            issueId,
            rootCommentId,
            accessToken,
            input,
            context,
          ),
      )
      if (succeeded && selectedRootCommentId === rootCommentId) {
        await refreshAuxiliaryContextQuery(
          'accepted-resolution history',
          mutateAcceptedResolutions,
        )
      }
      return succeeded
    },
    [
      accessToken,
      issueId,
      mutateAcceptedResolutions,
      runMutation,
      selectedRootCommentId,
      teamId,
    ],
  )

  const openRevisionHistory = useCallback(
    (contextItemId: string) => {
      setRevisionHistoryTarget({ contextItemId, scope })
    },
    [scope],
  )

  const closeRevisionHistory = useCallback(() => {
    setRevisionHistoryTarget((current) =>
      current?.scope === scope ? undefined : current,
    )
  }, [scope])

  const loadMoreRevisions = useCallback(async () => {
    if (!revisionPages?.at(-1)?.nextCursor) return
    await setRevisionSize(revisionSize + 1)
  }, [revisionPages, revisionSize, setRevisionSize])

  const retryRevisionHistory = useCallback(async () => {
    await mutateRevisions()
  }, [mutateRevisions])

  const openAcceptedResolutionHistory = useCallback(
    (rootCommentId: string) => {
      setAcceptedResolutionHistoryTarget({ rootCommentId, scope })
    },
    [scope],
  )

  const closeAcceptedResolutionHistory = useCallback(() => {
    setAcceptedResolutionHistoryTarget((current) =>
      current?.scope === scope ? undefined : current,
    )
  }, [scope])

  const loadMoreAcceptedResolutions = useCallback(async () => {
    if (!acceptedResolutionPages?.at(-1)?.nextCursor) return
    await setAcceptedResolutionSize(acceptedResolutionSize + 1)
  }, [
    acceptedResolutionPages,
    acceptedResolutionSize,
    setAcceptedResolutionSize,
  ])

  const retryAcceptedResolutionHistory = useCallback(async () => {
    await mutateAcceptedResolutions()
  }, [mutateAcceptedResolutions])

  const loadMore = useCallback(async () => {
    if (!lastPage?.nextCursor) return
    await setSize(size + 1)
  }, [lastPage?.nextCursor, setSize, size])

  return {
    acceptedResolutionHistory: {
      hasLoadError: Boolean(acceptedResolutionError),
      hasMore: Boolean(acceptedResolutionPages?.at(-1)?.nextCursor),
      isLoading: Boolean(selectedRootCommentId && isAcceptedResolutionLoading),
      isLoadingMore: isLoadingMoreAcceptedResolutions,
      items: acceptedResolutionItems,
      rootCommentId: selectedRootCommentId,
    },
    capabilities: firstPage?.capabilities ?? emptyContextCapabilities,
    closeAcceptedResolutionHistory,
    closeRevisionHistory,
    createItem,
    hasLoadError: Boolean(error),
    hasMore: Boolean(lastPage?.nextCursor),
    hasMutationError: Boolean(activeMutationFailure),
    isLoading: isConfigured && isLoading,
    isLoadingMore,
    items,
    loadMoreAcceptedResolutions,
    loadMore,
    loadMoreRevisions,
    mutationErrorStatus: activeMutationFailure?.status,
    openAcceptedResolutionHistory,
    openRevisionHistory,
    refresh,
    retryAcceptedResolutionHistory,
    retryRevisionHistory,
    revisionHistory: {
      contextItemId: selectedContextItemId,
      hasLoadError: Boolean(revisionError),
      hasMore: Boolean(revisionPages?.at(-1)?.nextCursor),
      isLoading: Boolean(selectedContextItemId && isRevisionLoading),
      isLoadingMore: isLoadingMoreRevisions,
      items: revisionItems,
    },
    sessionErrors: [
      error,
      revisionError,
      acceptedResolutionError,
      activeMutationFailure?.error,
    ].filter(
      (candidate) => candidate !== undefined,
    ),
    setAcceptedResolution,
    updateItem,
  }
}

/**
 * Revalidates an auxiliary context query without changing a committed mutation result.
 *
 * @param queryName - Safe label used for diagnostic logging.
 * @param revalidate - SWR revalidation operation.
 * @returns A promise that always resolves after logging transient refresh failures.
 */
export async function refreshAuxiliaryContextQuery(
  queryName: string,
  revalidate: () => Promise<unknown>,
): Promise<void> {
  try {
    await revalidate()
  } catch (error) {
    console.error(`Issue context ${queryName} revalidation failed:`, error)
  }
}

/**
 * Merges duplicate context items by stable ID while preserving first-page order.
 *
 * @param items - Items flattened from every loaded opaque-cursor page.
 * @returns One item per ID, preferring the highest revision.
 */
export function mergeCuratedContextItems(
  items: readonly CuratedContextItem[],
): CuratedContextItem[] {
  const merged: CuratedContextItem[] = []
  const indexes = new Map<string, number>()

  for (const item of items) {
    const index = indexes.get(item.id)

    if (index === undefined) {
      indexes.set(item.id, merged.length)
      merged.push(item)
      continue
    }

    const current = merged[index]
    if (!current || item.revision > current.revision) merged[index] = item
  }

  return merged
}

/**
 * Merges revision pages by revision number while preserving newest-first order.
 *
 * @param items - Revision snapshots flattened from loaded pages.
 * @returns One immutable snapshot per revision.
 */
export function mergeCuratedContextRevisions(
  items: readonly CuratedContextItem[],
): CuratedContextItem[] {
  const revisions = new Set<number>()
  return items.filter((item) => {
    if (revisions.has(item.revision)) return false
    revisions.add(item.revision)
    return true
  })
}

/**
 * Merges accepted-resolution pages without losing state-specific snapshots.
 *
 * @param items - Accepted-resolution snapshots flattened from loaded pages.
 * @returns Deduplicated snapshots in server-provided newest-first order.
 */
export function mergeAcceptedResolutionHistory(
  items: readonly AcceptedResolution[],
): AcceptedResolution[] {
  const snapshots = new Set<string>()
  return items.filter((item) => {
    const key = `${item.id}:${item.state}:${item.acceptedAt}:${item.supersededAt ?? ''}`
    if (snapshots.has(key)) return false
    snapshots.add(key)
    return true
  })
}
