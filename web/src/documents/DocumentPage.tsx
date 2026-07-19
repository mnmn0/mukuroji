import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  DocumentExportFormat,
  DocumentKind,
  DocumentPermission,
  DocumentRelation,
  DocumentScope,
  WhiteboardFrame,
} from '@mukuroji/contracts'
import {
  useBlocker,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router'
import useSWR from 'swr'
import {
  createMutationRequestContext,
  createMutationRequestRunner,
} from '../api/mutationHeaders'
import {
  canMutateWorkspaceContent,
  getCurrentUser,
} from '../auth/api'
import { clearAuthSession, getAuthSession } from '../auth/session'
import {
  MobileSidebarButton,
  MobileSidebarDrawer,
  Sidebar,
  type SidebarNavId,
  type SidebarTeamViewId,
} from '../components/sidebar'
import { useWorkspaceCommandMenu } from '../commands/WorkspaceCommandMenuContext'
import {
  createSidebarLabels,
  createTranslator,
  getInitialLocale,
  type Locale,
  type MessageKey,
} from '../i18n'
import { useUnreadNotificationCount } from '../notifications/useNotifications'
import {
  getProjectDirectory,
  type ProjectDirectoryTeam,
} from '../projects/api'
import {
  createDocumentPath,
  createProjectIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../routes/paths'
import {
  applyDocumentOperations,
  applyDocumentOperationsWithConflictAwareness,
  archiveDocument,
  createDocument,
  createDocumentComment,
  createDocumentShare,
  deleteDocumentPresence,
  deleteDocumentShare,
  exportDocument,
  favoriteDocument,
  getDocument,
  getDocumentCommentThread,
  getDocumentCollection,
  getNextDocumentCollectionPage,
  getDocumentBacklinks,
  getDocumentComments,
  getDocumentPresence,
  getDocumentShares,
  getDocumentVersions,
  instantiateDocument,
  markDocumentRecent,
  resolveDocumentComment,
  restoreDocument,
  restoreDocumentVersion,
  unfavoriteDocument,
  updateDocument,
  updateDocumentPresence,
  DocumentsApiError,
  DocumentRevisionConflictError,
  type CreateDocumentCommentInput,
  type CreateDocumentInput,
  type CreateDocumentShareInput,
  type DocumentBacklink,
  type DocumentComment,
  type DocumentCollection,
  type DocumentOperation,
  type DocumentOperationSaveResult,
  type DocumentPresence,
  type DocumentRecord,
  type DocumentShare,
  type DocumentSummary,
  type DocumentVersion,
  type RevokeDocumentShareInput,
  type WhiteboardConnector,
  type WhiteboardObject,
} from './api'
import {
  DocumentContextPanel,
  type DocumentContextTab,
} from './DocumentContextPanel'
import { DocumentEditor } from './DocumentEditor'
import { DocumentHome } from './DocumentHome'
import {
  DocumentShareDialog,
  type CreateDocumentShareDraftInput,
} from './DocumentShareDialog'
import {
  DocumentTree,
} from './DocumentTree'
import {
  focusFirstModalElement,
  trapModalFocus,
} from './modalFocus'
import {
  applyDocumentOperationsLocally,
  createDocumentMutationQueue,
  createDefaultDocumentTitle,
  createDocumentOperationId,
  deduplicateDocumentRelationTargets,
  DocumentOperationChunkSaveError,
  isDocumentTitleCommitCurrent,
  isDocumentTitleDirty,
  resolvePendingPublicShareCreateRequest,
  runAfterSavingDocumentDraft,
  saveAllPendingDocumentChanges,
  saveDocumentOperationChunks,
  shouldAdoptIncomingDocument,
  shouldScheduleDocumentAutosave,
  type DocumentDraftSaveGuard,
  type PendingPublicShareCreateRequest,
  type DocumentSaveStatus,
} from './model'
import { WhiteboardCanvas } from './WhiteboardCanvas'

const emptyTeams: ProjectDirectoryTeam[] = []
const emptyDocuments: DocumentSummary[] = []
const emptyComments: DocumentComment[] = []
const emptyVersions: DocumentVersion[] = []
const emptyPresence: DocumentPresence[] = []
const emptyShares: DocumentShare[] = []
const emptyBacklinks: DocumentBacklink[] = []
const apiSWRConfig = {
  dedupingInterval: 5_000,
  shouldRetryOnError: false,
} as const
const documentPresenceRefreshInterval = 4_000
const documentPresenceHeartbeatInterval = 12_000
const documentAutosaveDelay = 550
const documentBacklinkRequestConcurrency = 4

/**
 * DocumentScreen が描画する API-backed data です。
 */
export type DocumentScreenData = {
  /**
   * 現在 user が Workspace/Project scope に Document を作成できるかどうかです。
   */
  canCreateDocuments: boolean
  /**
   * Sidebar と Project scope に表示する directory です。
   */
  teams: ProjectDirectoryTeam[]
  /**
   * Document tree/home に表示する node 一覧です。
   */
  documents: DocumentSummary[]
  /**
   * Active tree にさらに node があるかどうかです。
   */
  hasMoreActiveDocuments?: boolean
  /**
   * Archive tree にさらに node があるかどうかです。
   */
  hasMoreArchivedDocuments?: boolean
  /**
   * URL で選択された Document detail です。
   */
  selectedDocument?: DocumentRecord
  /**
   * 選択中 Document の comments です。
   */
  comments: DocumentComment[]
  /**
   * Notification deep link から focus する comment ID です。
   */
  focusedCommentId?: string
  /**
   * さらに古い comments を取得できるかどうかです。
   */
  hasMoreComments?: boolean
  /**
   * 選択中 Document の versions です。
   */
  versions: DocumentVersion[]
  /**
   * さらに古い versions を取得できるかどうかです。
   */
  hasMoreVersions?: boolean
  /**
   * 選択中 Document の active presence です。
   */
  presence: DocumentPresence[]
  /**
   * 選択中 Document の guest/public shares です。
   */
  shares: DocumentShare[]
  /**
   * 選択中 Document の backlinks です。
   */
  backlinks: DocumentBacklink[]
  /**
   * さらに backlinks を取得できるかどうかです。
   */
  hasMoreBacklinks?: boolean
}

/**
 * DocumentScreen から API container へ通知する action です。
 */
export type DocumentScreenActions = {
  /**
   * Document detail を選択する action です。
   */
  selectDocument: (documentId?: string) => void
  /**
   * Active または archive tree の次 page を取得する action です。
   */
  loadMoreDocuments?: (archived: boolean) => Promise<void>
  /**
   * Document node を作成する action です。
   */
  createDocument?: (
    kind: DocumentKind,
    scope: DocumentScope,
    parentId?: string,
  ) => Promise<void>
  /**
   * Template を instantiate する action です。
   */
  instantiateTemplate?: (templateId: string) => Promise<void>
  /**
   * Document metadata/permission を更新する action です。
   */
  updateDocument?: (
    documentId: string,
    expectedRevision: number,
    input: {
      /**
       * 変更後 title です。
       */
      title?: string
      /**
       * 変更後 permission です。
       */
      permission?: DocumentPermission
      /**
       * 移動先 parent ID です。
       */
      parentId?: string | null
      /**
       * 移動先 scope です。
       */
      scope?: DocumentScope
    },
  ) => Promise<DocumentRecord>
  /**
   * Block/whiteboard operation を保存する action です。
   */
  applyOperations?: (
    documentId: string,
    expectedRevision: number,
    operations: DocumentOperation[],
  ) => Promise<DocumentOperationSaveResult>
  /**
   * Tree node を別 folder/scope へ移動する action です。
   */
  moveDocument?: (
    document: DocumentSummary,
    parentId: string | undefined,
    scope: DocumentScope,
  ) => Promise<void>
  /**
   * Document archive action です。
   */
  archiveDocument?: (document: DocumentRecord) => Promise<void>
  /**
   * Document restore action です。
   */
  restoreDocument?: (document: DocumentRecord) => Promise<void>
  /**
   * Favorite 状態変更 action です。
   */
  setFavorite?: (
    document: DocumentRecord,
    favorite: boolean,
  ) => Promise<void>
  /**
   * Comment 作成 action です。
   */
  createComment?: (
    documentId: string,
    input: CreateDocumentCommentInput,
  ) => Promise<void>
  /**
   * Comment resolve action です。
   */
  resolveComment?: (
    documentId: string,
    commentId: string,
  ) => Promise<void>
  /**
   * 次の comment page を取得する action です。
   */
  loadMoreComments?: () => Promise<void>
  /**
   * Version restore action です。
   */
  restoreVersion?: (
    documentId: string,
    versionId: string,
  ) => Promise<DocumentRecord>
  /**
   * 次の version page を取得する action です。
   */
  loadMoreVersions?: () => Promise<void>
  /**
   * 次の backlink pages を取得する action です。
   */
  loadMoreBacklinks?: () => Promise<void>
  /**
   * Share 作成 action です。
   */
  createShare?: (
    documentId: string,
    input: CreateDocumentShareDraftInput,
  ) => Promise<void>
  /**
   * Share revoke action です。
   */
  deleteShare?: (
    documentId: string,
    input: RevokeDocumentShareInput,
  ) => Promise<void>
  /**
   * Document export action です。
   */
  exportDocument?: (
    documentId: string,
    format: DocumentExportFormat,
  ) => Promise<void>
  /**
   * Focus 中 block/object を presence へ反映する action です。
   */
  setActiveAnchor?: (anchorId?: string) => void
  /**
   * Sidebar 固定 nav 選択 action です。
   */
  selectNav?: (navId: SidebarNavId) => void
  /**
   * Sidebar Team view 選択 action です。
   */
  selectTeamView?: (teamId: string, viewId: SidebarTeamViewId) => void
  /**
   * Sidebar Project 選択 action です。
   */
  selectProject?: (projectId: string, teamId: string) => void
  /**
   * Backlink/Whiteboard link navigation action です。
   */
  navigate?: (path: string) => void
  /**
   * Logout action です。
   */
  logout?: () => void
}

/**
 * Storybook 兼用 DocumentScreen の props です。
 */
export type DocumentScreenProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * ヘッダーに表示する user label です。
   */
  userLabel: string
  /**
   * User avatar の頭文字です。
   */
  userInitial: string
  /**
   * Sidebar unread notification count です。
   */
  inboxCount?: number
  /**
   * API-backed screen data です。
   */
  data: DocumentScreenData
  /**
   * Container へ通知する actions です。
   */
  actions: DocumentScreenActions
  /**
   * 初回 data を読み込み中かどうかです。
   */
  isLoading?: boolean
  /**
   * Document/list load error message です。
   */
  errorMessage?: string
  /**
   * Context panel data を読み込み中かどうかです。
   */
  isContextLoading?: boolean
  /**
   * Storybook で初期表示する context tab です。
   */
  initialContextTab?: DocumentContextTab
  /**
   * Context tab の表示状態を API container へ通知する callback です。
   */
  onContextTabChange?: (tab?: DocumentContextTab) => void
  /**
   * Storybook で share dialog を初期表示するかどうかです。
   */
  initialShareDialogOpen?: boolean
  /**
   * Browser back を含む route 遷移へ現在の draft guard を登録する callback です。
   */
  onNavigationGuardChange?: (
    guard?: DocumentDraftSaveGuard,
  ) => void
}

/**
 * 認証・SWR・Documents API を presentation screen へ接続する route page です。
 */
export function DocumentPage() {
  const navigate = useNavigate()
  const params = useParams()
  const [searchParams] = useSearchParams()
  const [session] = useState(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [presenceClientId] = useState(createPresenceClientId)
  const [activeAnchorId, setActiveAnchorId] = useState<string>()
  const activeAnchorRef = useRef(activeAnchorId)
  const [mutationRunner] = useState(createMutationRequestRunner)
  const pendingPublicShareCreateRef = useRef<
    PendingPublicShareCreateRequest | undefined
  >(undefined)
  const [enqueueDocumentMutation] = useState(
    createDocumentMutationQueue,
  )
  const navigationGuardRef = useRef<
    DocumentDraftSaveGuard | undefined
  >(undefined)
  const isResolvingBlockedNavigationRef = useRef(false)
  const blocker = useBlocker(
    useCallback(
      () =>
        navigationGuardRef.current?.hasUnsavedChanges() ?? false,
      [],
    ),
  )
  const handleNavigationGuardChange = useCallback(
    (guard?: DocumentDraftSaveGuard) => {
      navigationGuardRef.current = guard
    },
    [],
  )
  const accessToken = session?.accessToken
  const documentId = params.documentId
  const routeContext = searchParams.get('context')
  const initialContextTab: DocumentContextTab | undefined =
    routeContext === 'comments' ? 'comments' : undefined
  const focusedCommentId =
    routeContext === 'comments'
      ? readOptionalDocumentCommentId(
          searchParams.get('commentId'),
        )
      : undefined
  const focusedRootCommentId =
    readOptionalDocumentCommentId(
      searchParams.get('rootCommentId'),
    ) ?? focusedCommentId
  const contextInstanceKey =
    `${documentId ?? 'home'}:${routeContext ?? ''}:${focusedCommentId ?? ''}`
  const [
    contextPanelSelection,
    setContextPanelSelection,
  ] = useState<
    readonly [string, DocumentContextTab | undefined]
  >(() => [contextInstanceKey, initialContextTab])
  // Route transition の描画中に破棄し、古い SWR key を commit させません。
  if (contextPanelSelection[0] !== contextInstanceKey) {
    setContextPanelSelection([
      contextInstanceKey,
      initialContextTab,
    ])
  }
  const t = useMemo(() => createTranslator(locale), [locale])
  const currentUserKey = accessToken
    ? (['current-user', accessToken] as const)
    : null
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useSWR(
    currentUserKey,
    ([, token]) => getCurrentUser(token),
    apiSWRConfig,
  )
  const directoryKey =
    accessToken && user && !currentUserError
      ? (['project-directory', accessToken, locale] as const)
      : null
  const {
    data: teams = emptyTeams,
    error: directoryError,
    isLoading: isDirectoryLoading,
  } = useSWR(
    directoryKey,
    ([, token, currentLocale]) =>
      getProjectDirectory(token, currentLocale),
    apiSWRConfig,
  )
  const documentsKey =
    accessToken && user && !currentUserError
      ? (['documents', accessToken] as const)
      : null
  const {
    data: collection,
    error: documentsError,
    isLoading: isDocumentsLoading,
    mutate: mutateDocuments,
  } = useSWR(
    documentsKey,
    ([, token]) => getDocumentCollection(token),
    apiSWRConfig,
  )
  const detailKey =
    accessToken && user && !currentUserError && documentId
      ? (['document', accessToken, documentId] as const)
      : null
  const {
    data: selectedDocument,
    error: detailError,
    isLoading: isDetailLoading,
    mutate: mutateSelectedDocument,
  } = useSWR(
    detailKey,
    ([, token, selectedId]) => getDocument(token, selectedId),
    {
      ...apiSWRConfig,
      refreshInterval: 3_500,
      refreshWhenHidden: false,
    },
  )
  const commentsKey =
    accessToken && selectedDocument
      ? (['document-comments', accessToken, selectedDocument.id] as const)
      : null
  const {
    data: latestCommentsPage,
    isLoading: isCommentsLoading,
    mutate: mutateComments,
  } = useSWR(
    commentsKey,
    ([, token, selectedId]) =>
      getDocumentComments(token, selectedId),
    {
      ...apiSWRConfig,
      refreshInterval: 4_000,
      refreshWhenHidden: false,
    },
  )
  const [
    olderComments,
    setOlderComments,
  ] = useState<DocumentComment[]>([])
  const [
    olderCommentsCursor,
    setOlderCommentsCursor,
  ] = useState<string>()
  const [
    olderCommentsDocumentId,
    setOlderCommentsDocumentId,
  ] = useState<string>()
  const focusedThreadKey =
    accessToken &&
    selectedDocument &&
    focusedCommentId &&
    focusedRootCommentId
      ? ([
          'document-comment-thread',
          accessToken,
          selectedDocument.id,
          focusedRootCommentId,
          focusedCommentId,
        ] as const)
      : null
  const {
    data: focusedThreadComments = emptyComments,
    isLoading: isFocusedThreadLoading,
  } = useSWR(
    focusedThreadKey,
    ([, token, selectedId, rootId, targetId]) =>
      getDocumentCommentThread(
        token,
        selectedId,
        rootId,
        targetId,
      ),
    apiSWRConfig,
  )
  const comments = mergeById(
    mergeById(
      latestCommentsPage?.comments ?? emptyComments,
      olderCommentsDocumentId === selectedDocument?.id
        ? olderComments
        : emptyComments,
    ),
    focusedThreadComments,
  )
  const versionsKey =
    accessToken && selectedDocument
      ? (['document-versions', accessToken, selectedDocument.id] as const)
      : null
  const {
    data: versionsPage,
    isLoading: isVersionsLoading,
    mutate: mutateVersions,
  } = useSWR(
    versionsKey,
    ([, token, selectedId]) => getDocumentVersions(token, selectedId),
    apiSWRConfig,
  )
  const versions =
    versionsPage?.versions ?? emptyVersions
  const presenceKey =
    accessToken && selectedDocument
      ? (['document-presence', accessToken, selectedDocument.id] as const)
      : null
  const { data: presence = emptyPresence, mutate: mutatePresence } = useSWR(
    presenceKey,
    ([, token, selectedId]) => getDocumentPresence(token, selectedId),
    {
      ...apiSWRConfig,
      dedupingInterval: 1_000,
      refreshInterval: documentPresenceRefreshInterval,
      refreshWhenHidden: false,
    },
  )
  const sharesKey =
    accessToken && selectedDocument
      ? (['document-shares', accessToken, selectedDocument.id] as const)
      : null
  const {
    data: shares = emptyShares,
    isLoading: isSharesLoading,
    mutate: mutateShares,
  } = useSWR(
    sharesKey,
    ([, token, selectedId]) => getDocumentShares(token, selectedId),
    apiSWRConfig,
  )
  const backlinkTargets = useMemo(
    () => deduplicateDocumentRelationTargets(
      selectedDocument?.relations ?? [],
    ),
    [selectedDocument?.relations],
  )
  const isBacklinkContextOpen =
    contextPanelSelection[0] === contextInstanceKey &&
    contextPanelSelection[1] === 'backlinks'
  const backlinksKey =
    accessToken &&
    isBacklinkContextOpen &&
    backlinkTargets.length > 0
      ? ([
          'document-backlinks',
          accessToken,
          JSON.stringify(backlinkTargets),
        ] as const)
      : null
  const {
    data: backlinkCollection,
    isLoading: isBacklinksLoading,
    mutate: mutateBacklinks,
  } = useSWR(
    backlinksKey,
    async ([, token]) => {
      const pages = await mapWithBoundedConcurrency(
        backlinkTargets,
        documentBacklinkRequestConcurrency,
        (target) =>
          getDocumentBacklinks(
            token,
            target.kind,
            readRelationTargetId(target),
          ),
      )
      return {
        backlinks: [
          ...new Map(
            pages
              .flatMap(({ backlinks }) => backlinks)
              .map((backlink) => [
                `${backlink.documentId}:${backlink.relation.id}`,
                backlink,
              ]),
          ).values(),
        ],
        pending: pages.flatMap((page, index) =>
          page.nextCursor && backlinkTargets[index]
            ? [{
                cursor: page.nextCursor,
                target: backlinkTargets[index],
              }]
            : [],
        ),
      }
    },
    apiSWRConfig,
  )
  const backlinks =
    backlinkCollection?.backlinks ?? emptyBacklinks
  const handleLoadMoreComments = async () => {
    if (!accessToken || !selectedDocument) return
    const cursor =
      olderCommentsDocumentId ===
      selectedDocument.id
        ? olderCommentsCursor
        : latestCommentsPage?.nextCursor
    if (!cursor) return
    const next = await getDocumentComments(
      accessToken,
      selectedDocument.id,
      cursor,
    )
    setOlderComments((current) =>
      mergeById(
        olderCommentsDocumentId ===
          selectedDocument.id
          ? current
          : emptyComments,
        next.comments,
      ),
    )
    setOlderCommentsCursor(next.nextCursor)
    setOlderCommentsDocumentId(selectedDocument.id)
  }
  const handleLoadMoreVersions = async () => {
    if (!accessToken || !selectedDocument) return
    await mutateVersions(
      async (current) => {
        if (!current?.nextCursor) return current
        const next = await getDocumentVersions(
          accessToken,
          selectedDocument.id,
          current.nextCursor,
        )
        return {
          versions: mergeById(
            current.versions,
            next.versions,
          ),
          nextCursor: next.nextCursor,
        }
      },
      { revalidate: false },
    )
  }
  const handleLoadMoreBacklinks = async () => {
    if (!accessToken) return
    await mutateBacklinks(
      async (current) => {
        if (!current || current.pending.length === 0) {
          return current
        }
        const pages = await mapWithBoundedConcurrency(
          current.pending,
          documentBacklinkRequestConcurrency,
          async ({ cursor, target }) => ({
            page: await getDocumentBacklinks(
              accessToken,
              target.kind,
              readRelationTargetId(target),
              cursor,
            ),
            target,
          }),
        )
        return {
          backlinks: mergeBacklinks(
            current.backlinks,
            pages.flatMap(({ page }) => page.backlinks),
          ),
          pending: pages.flatMap(({ page, target }) =>
            page.nextCursor
              ? [{
                  cursor: page.nextCursor,
                  target,
                }]
              : [],
          ),
        }
      },
      { revalidate: false },
    )
  }
  const inboxCount = useUnreadNotificationCount(
    accessToken,
    Boolean(user && !currentUserError),
  )
  const userLabel =
    user?.attributes.email ??
    user?.attributes.name ??
    user?.username ??
    t('workspace.user.fallback')
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || 'M'
  const documents = collection?.documents ?? emptyDocuments
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(user && (isDirectoryLoading || isDocumentsLoading)) ||
    Boolean(documentId && isDetailLoading)
  const error =
    documentsError ?? directoryError ?? detailError
  const errorMessage =
    error instanceof Error ? error.message : undefined
  const canCreateDocuments =
    user?.workspaceMemberStatus === 'active' &&
    canMutateWorkspaceContent(user)

  useEffect(() => {
    if (
      blocker.state !== 'blocked' ||
      isResolvingBlockedNavigationRef.current
    ) {
      return
    }

    isResolvingBlockedNavigationRef.current = true
    void runAfterSavingDocumentDraft(
      navigationGuardRef.current,
      () => undefined,
    )
      .then((saved) => {
        if (saved) blocker.proceed()
        else blocker.reset()
      })
      .catch(() => blocker.reset())
      .finally(() => {
        isResolvingBlockedNavigationRef.current = false
      })
  }, [blocker])

  useEffect(() => {
    activeAnchorRef.current = activeAnchorId
  }, [activeAnchorId])

  useEffect(() => {
    globalThis.document.documentElement.lang = locale
    globalThis.document.title = `${selectedDocument?.title ?? t('documents.title')} | ${t('app.title')}`
  }, [locale, selectedDocument?.title, t])

  useEffect(() => {
    if (!session) {
      navigate('/', { replace: true })
    }
  }, [navigate, session])

  useEffect(() => {
    if (currentUserError) {
      clearAuthSession()
      navigate('/', { replace: true })
    }
  }, [currentUserError, navigate])

  useEffect(() => {
    if (!accessToken || !documentId) {
      return
    }

    void mutationRunner.run(
      `document:recent:${documentId}`,
      documentId,
      (context) => markDocumentRecent(accessToken, documentId, context),
    ).then(() => mutateDocuments()).catch(() => undefined)
  }, [accessToken, documentId, mutateDocuments, mutationRunner])

  useEffect(() => {
    if (!accessToken || !documentId) {
      return
    }

    const heartbeat = () =>
      updateDocumentPresence(
        accessToken,
        documentId,
        {
          clientId: presenceClientId,
          selection: activeAnchorRef.current
            ? selectedDocument?.kind === 'whiteboard'
              ? {
                  objectIds: [activeAnchorRef.current],
                  type: 'whiteboard',
                }
              : {
                  anchorOffset: 0,
                  blockId: activeAnchorRef.current,
                  focusOffset: 0,
                  type: 'text',
                }
            : null,
        },
        createMutationRequestContext(),
      )
        .then(() => mutatePresence())
        .catch(() => undefined)

    void heartbeat()
    const intervalId = window.setInterval(
      heartbeat,
      documentPresenceHeartbeatInterval,
    )

    return () => {
      window.clearInterval(intervalId)
      void deleteDocumentPresence(
        accessToken,
        documentId,
        presenceClientId,
        createMutationRequestContext(),
      ).catch(() => undefined)
    }
  }, [
    accessToken,
    documentId,
    mutatePresence,
    presenceClientId,
    selectedDocument?.kind,
  ])

  const handleCreateDocument = async (
    kind: DocumentKind,
    scope: DocumentScope,
    parentId?: string,
  ) => {
    if (!accessToken) return
    const labels: Record<DocumentKind, string> = {
      folder: t('documents.new.folder'),
      page: t('documents.new.page'),
      template: t('documents.new.template'),
      whiteboard: t('documents.new.whiteboard'),
    }
    const baseInput = {
      parentId,
      scope,
      title: createDefaultDocumentTitle(kind, labels),
    }
    const input: CreateDocumentInput =
      kind === 'folder'
        ? { ...baseInput, kind }
        : kind === 'whiteboard'
          ? {
              ...baseInput,
              kind,
              whiteboard: { connectors: [], frames: [], objects: [] },
            }
          : { ...baseInput, blocks: [], kind }
    const created = await mutationRunner.run(
      `document:create:${kind}:${parentId ?? 'root'}`,
      JSON.stringify(input),
      (context) => createDocument(accessToken, input, context),
    )
    await mutateDocuments()
    navigate(createDocumentPath(created.id))
  }

  const handleInstantiateTemplate = async (templateId: string) => {
    if (!accessToken) return
    const input = {
      scope: { type: 'workspace' } as const,
      templateId,
    }
    const created = await mutationRunner.run(
      `document:instantiate:${templateId}`,
      JSON.stringify(input),
      (context) => instantiateDocument(accessToken, input, context),
    )
    await mutateDocuments()
    navigate(createDocumentPath(created.id))
  }

  const handleUpdateDocument = async (
    selectedId: string,
    expectedRevision: number,
    input: {
      title?: string
      permission?: DocumentPermission
      parentId?: string | null
      scope?: DocumentScope
    },
  ) => {
    if (!accessToken) {
      throw new Error('Missing access token.')
    }
    return enqueueDocumentMutation(async () => {
      const executeUpdate = (revision: number) => {
        const updateInput = { ...input, expectedRevision: revision }
        return mutationRunner.run(
          `document:update:${selectedId}`,
          JSON.stringify(updateInput),
          (context) =>
            updateDocument(accessToken, selectedId, updateInput, context),
        )
      }
      let updated: DocumentRecord
      try {
        updated = await executeUpdate(expectedRevision)
      } catch (error) {
        if (!(error instanceof DocumentsApiError) || error.status !== 409) {
          throw error
        }
        const latest = await getDocument(accessToken, selectedId)
        throw new DocumentRevisionConflictError(
          latest,
          error.message,
          error.code,
        )
      }
      await Promise.all([
        mutateDocuments(),
        selectedId === documentId
          ? mutateSelectedDocument(updated, { revalidate: false })
          : Promise.resolve(),
      ])
      return updated
    })
  }

  const handleApplyOperations = async (
    selectedId: string,
    expectedRevision: number,
    operations: DocumentOperation[],
  ) => {
    if (!accessToken) {
      throw new Error('Missing access token.')
    }
    return enqueueDocumentMutation(async () => {
      const saved = await saveDocumentOperationChunks(
        operations,
        expectedRevision,
        (revision, chunk) => {
          const input = {
            baseRevision: revision,
            clientId: presenceClientId,
            operations: chunk,
          }
          return applyDocumentOperationsWithConflictAwareness(
            accessToken,
            selectedId,
            input,
            (candidateInput) =>
              mutationRunner.run(
                `document:operations:${selectedId}`,
                JSON.stringify(candidateInput),
                (context) =>
                  applyDocumentOperations(
                    accessToken,
                    selectedId,
                    candidateInput,
                    context,
                  ),
              ),
          )
        },
      )
      if (!saved) {
        throw new Error('Document operation batch was empty.')
      }
      const updated = saved.document
      if (selectedId === documentId) {
        await mutateSelectedDocument(updated, { revalidate: false })
      }
      await Promise.all([mutateDocuments(), mutateVersions()])
      return saved
    })
  }

  const handleMoveDocument = async (
    document: DocumentSummary,
    parentId: string | undefined,
    scope: DocumentScope,
  ) => {
    if (!accessToken) {
      throw new Error('Missing access token.')
    }
    if (!document.capabilities.canManagePermissions) {
      throw new DocumentsApiError(
        403,
        'Manager access is required to move this document.',
        'DocumentPermissionDenied',
      )
    }

    await enqueueDocumentMutation(async () => {
      const latest = await getDocument(accessToken, document.id)
      if (!latest.capabilities.canManagePermissions) {
        throw new DocumentsApiError(
          403,
          'Manager access is required to move this document.',
          'DocumentPermissionDenied',
        )
      }
      const input = {
        expectedRevision: latest.revision,
        parentId: parentId ?? null,
        scope,
      }
      const updated = await mutationRunner.run(
        `document:update:${document.id}`,
        JSON.stringify(input),
        (context) =>
          updateDocument(accessToken, document.id, input, context),
      )
      await Promise.all([
        mutateDocuments(),
        document.id === documentId
          ? mutateSelectedDocument(updated, { revalidate: false })
          : Promise.resolve(),
      ])
    })
  }

  const handleArchiveDocument = async (document: DocumentRecord) => {
    if (!accessToken) {
      throw new Error('Missing access token.')
    }
    await enqueueDocumentMutation(async () => {
      const latest = await getDocument(accessToken, document.id)
      await mutationRunner.run(
        `document:archive:${document.id}`,
        String(latest.revision),
        (context) =>
          archiveDocument(
            accessToken,
            document.id,
            latest.revision,
            context,
          ),
      )
      await mutateDocuments()
      if (document.id === documentId) {
        navigate(createDocumentPath())
      }
    })
  }

  const handleRestoreDocument = async (document: DocumentRecord) => {
    if (!accessToken) {
      throw new Error('Missing access token.')
    }
    await enqueueDocumentMutation(async () => {
      const latest = await getDocument(accessToken, document.id)
      const restored = await mutationRunner.run(
        `document:restore:${document.id}`,
        String(latest.revision),
        (context) =>
          restoreDocument(
            accessToken,
            document.id,
            latest.revision,
            context,
          ),
      )
      await Promise.all([
        mutateDocuments(),
        document.id === documentId
          ? mutateSelectedDocument(restored, { revalidate: false })
          : Promise.resolve(),
      ])
    })
  }

  const handleSetFavorite = async (
    document: DocumentRecord,
    favorite: boolean,
  ) => {
    if (!accessToken) return
    await mutationRunner.run(
      `document:favorite:${document.id}`,
      String(favorite),
      (context) =>
        favorite
          ? favoriteDocument(accessToken, document.id, context)
          : unfavoriteDocument(accessToken, document.id, context),
    )
    await Promise.all([mutateDocuments(), mutateSelectedDocument()])
  }

  const handleLoadMoreDocuments = async (archived: boolean) => {
    if (!accessToken) return
    await mutateDocuments(
      async (current?: DocumentCollection) => {
        const collection =
          current ??
          await getDocumentCollection(accessToken)
        return getNextDocumentCollectionPage(
          accessToken,
          collection,
          archived,
        )
      },
      { revalidate: false },
    )
  }

  const handleCreateComment = async (
    selectedId: string,
    input: CreateDocumentCommentInput,
  ) => {
    if (!accessToken) return
    await mutationRunner.run(
      `document:comment:create:${selectedId}:${input.parentCommentId ?? 'root'}:${input.anchor.type}`,
      JSON.stringify(input),
      (context) =>
        createDocumentComment(accessToken, selectedId, input, context),
    )
    await mutateComments()
  }

  const handleResolveComment = async (
    selectedId: string,
    commentId: string,
  ) => {
    if (!accessToken) return
    const resolved = await mutationRunner.run(
      `document:comment:resolve:${selectedId}:${commentId}`,
      commentId,
      (context) =>
        resolveDocumentComment(
          accessToken,
          selectedId,
          commentId,
          context,
      ),
    )
    setOlderComments((current) =>
      current.map((comment) =>
        comment.id === resolved.id
          ? resolved
          : comment,
      ),
    )
    await mutateComments()
  }

  const handleRestoreVersion = async (
    selectedId: string,
    versionId: string,
  ) => {
    if (!accessToken) {
      throw new Error('Missing access token.')
    }
    return enqueueDocumentMutation(async () => {
      const latest = await getDocument(accessToken, selectedId)
      const restored = await mutationRunner.run(
        `document:version:restore:${selectedId}`,
        `${versionId}:${latest.revision}`,
        (context) =>
          restoreDocumentVersion(
            accessToken,
            selectedId,
            versionId,
            latest.revision,
            context,
          ),
      )
      await Promise.all([
        mutateDocuments(),
        mutateVersions(),
        selectedId === documentId
          ? mutateSelectedDocument(restored, { revalidate: false })
          : Promise.resolve(),
      ])
      return restored
    })
  }

  const handleCreateShare = async (
    selectedId: string,
    input: CreateDocumentShareDraftInput,
  ) => {
    if (!accessToken) {
      throw new Error('Missing access token.')
    }
    await enqueueDocumentMutation(async () => {
      const pendingPublicShare =
        input.type === 'public'
          ? resolvePendingPublicShareCreateRequest(
              pendingPublicShareCreateRef.current,
              selectedId,
              input.expiresInDays,
              input.allowExport,
            )
          : undefined
      if (pendingPublicShare) {
        pendingPublicShareCreateRef.current = pendingPublicShare
      }
      const apiInput: CreateDocumentShareInput =
        input.type === 'member'
          ? input
          : pendingPublicShare!.input
      const fingerprint =
        pendingPublicShare?.fingerprint ?? JSON.stringify(apiInput)
      const created = await mutationRunner.run(
        `document:share:create:${selectedId}:${apiInput.type}`,
        fingerprint,
        (context) =>
          createDocumentShare(
            accessToken,
            selectedId,
            apiInput,
            context,
          ),
      )
      const updateCachedShares = () =>
        mutateShares(
          (current = []) => [
            ...current.filter((share) =>
              created.type === 'member'
                ? !(
                    share.type === 'member' &&
                    share.grant.memberKey ===
                      created.grant.memberKey
                  )
                : !(
                    share.type === 'public' &&
                    share.id === created.id
                  ),
            ),
            created,
          ],
          { revalidate: false },
        )
      if (apiInput.type === 'public') {
        await updateCachedShares().catch(() => undefined)
        if (
          pendingPublicShare &&
          pendingPublicShareCreateRef.current === pendingPublicShare
        ) {
          pendingPublicShareCreateRef.current = undefined
        }
        void mutateDocuments()
        return
      }
      if (
        pendingPublicShare &&
        pendingPublicShareCreateRef.current === pendingPublicShare
      ) {
        pendingPublicShareCreateRef.current = undefined
      }
      await updateCachedShares()
      const latest = await getDocument(accessToken, selectedId)
      await Promise.all([
        mutateDocuments(),
        selectedId === documentId
          ? mutateSelectedDocument(latest, { revalidate: false })
          : Promise.resolve(),
      ])
    })
  }

  const handleDeleteShare = async (
    selectedId: string,
    input: RevokeDocumentShareInput,
  ) => {
    if (!accessToken) {
      throw new Error('Missing access token.')
    }
    const shareId =
      input.type === 'public'
        ? input.publicShareId
        : `member:${input.memberKey}`
    await enqueueDocumentMutation(async () => {
      await mutationRunner.run(
        `document:share:delete:${selectedId}:${shareId}`,
        shareId,
        (context) =>
          deleteDocumentShare(accessToken, selectedId, input, context),
      )
      const latest = await getDocument(accessToken, selectedId)
      await Promise.all([
        mutateShares(),
        mutateDocuments(),
        selectedId === documentId
          ? mutateSelectedDocument(latest, { revalidate: false })
          : Promise.resolve(),
      ])
    })
  }

  const handleExport = async (
    selectedId: string,
    format: DocumentExportFormat,
  ) => {
    if (!accessToken) return
    const result = await exportDocument(accessToken, selectedId, format)
    const link = globalThis.document.createElement('a')
    link.download = result.fileName
    const objectUrl =
      result.delivery === 'inline'
        ? URL.createObjectURL(
            new Blob([result.content], { type: result.mimeType }),
          )
        : undefined
    link.href =
      result.delivery === 'inline' ? objectUrl! : result.url
    link.rel = 'noopener noreferrer'
    link.click()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }

  return (
    <DocumentScreen
      key={contextInstanceKey}
      actions={{
        applyOperations: handleApplyOperations,
        archiveDocument: handleArchiveDocument,
        createComment: handleCreateComment,
        createDocument: handleCreateDocument,
        createShare: handleCreateShare,
        deleteShare: handleDeleteShare,
        exportDocument: handleExport,
        instantiateTemplate: handleInstantiateTemplate,
        loadMoreBacklinks: handleLoadMoreBacklinks,
        loadMoreComments: handleLoadMoreComments,
        loadMoreDocuments: handleLoadMoreDocuments,
        loadMoreVersions: handleLoadMoreVersions,
        logout: () => {
          clearAuthSession()
          navigate('/', { replace: true })
        },
        moveDocument: handleMoveDocument,
        navigate,
        restoreDocument: handleRestoreDocument,
        restoreVersion: handleRestoreVersion,
        resolveComment: handleResolveComment,
        selectDocument: (selectedId) =>
          navigate(createDocumentPath(selectedId)),
        selectNav: (navId) => navigate(workspaceNavPaths[navId]),
        selectProject: (selectedProjectId, teamId) =>
          navigate(createProjectIssuesPath(selectedProjectId, teamId)),
        selectTeamView: (teamId, viewId) =>
          navigate(createTeamViewPath(teamId, viewId)),
        setActiveAnchor: setActiveAnchorId,
        setFavorite: handleSetFavorite,
        updateDocument: handleUpdateDocument,
      }}
      data={{
        backlinks,
        canCreateDocuments,
        comments,
        documents,
        focusedCommentId,
        hasMoreActiveDocuments:
          collection?.activeCursor !== undefined,
        hasMoreArchivedDocuments:
          collection?.archivedCursor !== undefined,
        hasMoreBacklinks:
          (backlinkCollection?.pending.length ?? 0) > 0,
        hasMoreComments:
          (
            olderCommentsDocumentId ===
            selectedDocument?.id
              ? olderCommentsCursor
              : latestCommentsPage?.nextCursor
          ) !== undefined,
        hasMoreVersions:
          versionsPage?.nextCursor !== undefined,
        presence,
        selectedDocument,
        shares,
        teams,
        versions,
      }}
      errorMessage={errorMessage}
      inboxCount={inboxCount}
      initialContextTab={
        initialContextTab
      }
      isContextLoading={
        isCommentsLoading ||
        isFocusedThreadLoading ||
        isVersionsLoading ||
        isSharesLoading ||
        isBacklinksLoading
      }
      isLoading={isLoading}
      locale={locale}
      onContextTabChange={(tab) =>
        setContextPanelSelection([
          contextInstanceKey,
          tab,
        ])
      }
      onNavigationGuardChange={handleNavigationGuardChange}
      userInitial={userInitial}
      userLabel={userLabel}
    />
  )
}

/**
 * Global sidebar、secondary tree、editor、context drawer を描画する screen です。
 */
export function DocumentScreen({
  actions,
  data,
  errorMessage,
  inboxCount = 0,
  initialContextTab,
  initialShareDialogOpen = false,
  isContextLoading = false,
  isLoading = false,
  locale,
  onContextTabChange,
  onNavigationGuardChange,
  userInitial,
  userLabel,
}: DocumentScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const commandMenu = useWorkspaceCommandMenu()
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isTreeDrawerOpen, setIsTreeDrawerOpen] = useState(false)
  const treeDrawerRef = useRef<HTMLDivElement>(null)
  const treeDrawerPreviousFocusRef =
    useRef<HTMLElement | undefined>(undefined)
  const [contextTab, setContextTab] =
    useState<DocumentContextTab | undefined>(initialContextTab)
  const [isShareDialogOpen, setIsShareDialogOpen] =
    useState(initialShareDialogOpen)
  const hasUnsavedChangesRef = useRef(false)
  const draftGuardRef = useRef<
    DocumentDraftSaveGuard | undefined
  >(undefined)
  const [actionErrorMessage, setActionErrorMessage] =
    useState<string>()
  const [defaultCommentAnchorId, setDefaultCommentAnchorId] =
    useState<string>()
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false)
  const selectedDocument = data.selectedDocument
  const isContextModal = useMediaQuery('(max-width: 1279px)')

  const ensureDraftSaved = useCallback(async () => {
    const guard = draftGuardRef.current
    const hasPendingDraft =
      hasUnsavedChangesRef.current ||
      guard?.hasUnsavedChanges() === true
    if (!hasPendingDraft) {
      return true
    }
    const saved = await guard?.savePendingChanges().catch(
      () => false,
    ) ?? false
    if (!saved) {
      setActionErrorMessage(
        t('documents.editor.saveBeforeActionError'),
      )
      return false
    }
    hasUnsavedChangesRef.current = false
    return true
  }, [t])

  const runGuardedAction = useCallback(
    async (action: () => void | Promise<void>) => {
      setActionErrorMessage(undefined)
      if (!(await ensureDraftSaved())) {
        return false
      }
      try {
        await action()
        return true
      } catch {
        setActionErrorMessage(t('documents.action.failed'))
        return false
      }
    },
    [ensureDraftSaved, t],
  )

  const requireSavedDraft = useCallback(async () => {
    if (!(await ensureDraftSaved())) {
      throw new Error(t('documents.editor.saveBeforeActionError'))
    }
  }, [ensureDraftSaved, t])

  const handleUnsavedStateChange = useCallback(
    (nextHasUnsavedChanges: boolean) => {
      hasUnsavedChangesRef.current = nextHasUnsavedChanges
    },
    [],
  )
  const handleDraftGuardChange = useCallback(
    (guard?: DocumentDraftSaveGuard) => {
      draftGuardRef.current = guard
    },
    [],
  )

  const createDocumentAction =
    data.canCreateDocuments && actions.createDocument
      ? async (
          kind: DocumentKind,
          scope: DocumentScope,
          parentId?: string,
        ) => {
          await runGuardedAction(() =>
            actions.createDocument?.(kind, scope, parentId),
          )
        }
      : undefined

  useEffect(() => {
    if (isTreeDrawerOpen) {
      focusFirstModalElement(treeDrawerRef.current)
    }
  }, [isTreeDrawerOpen])

  useEffect(() => {
    if (!onNavigationGuardChange) {
      return
    }
    const guard: DocumentDraftSaveGuard = {
      hasUnsavedChanges: () =>
        hasUnsavedChangesRef.current ||
        draftGuardRef.current?.hasUnsavedChanges() === true,
      savePendingChanges: ensureDraftSaved,
    }
    onNavigationGuardChange(guard)
    return () => onNavigationGuardChange(undefined)
  }, [
    ensureDraftSaved,
    onNavigationGuardChange,
  ])

  const openTreeDrawer = () => {
    treeDrawerPreviousFocusRef.current =
      globalThis.document.activeElement instanceof HTMLElement
        ? globalThis.document.activeElement
        : undefined
    setIsTreeDrawerOpen(true)
  }

  const closeTreeDrawer = () => {
    setIsTreeDrawerOpen(false)
    treeDrawerPreviousFocusRef.current?.focus()
  }

  const changeContextTab = useCallback(
    (tab?: DocumentContextTab) => {
      setContextTab(tab)
      onContextTabChange?.(tab)
    },
    [onContextTabChange],
  )

  const openContext = (
    tab: DocumentContextTab,
    anchorId?: string,
  ) => {
    setDefaultCommentAnchorId(anchorId)
    changeContextTab(tab)
  }

  const selectDocument = (selectedId: string) =>
    runGuardedAction(() => actions.selectDocument(selectedId))

  const globalSidebar = (
    <Sidebar
      activeNavId="documents"
      inboxCount={inboxCount}
      labels={sidebarLabels}
      onOpenSearch={commandMenu.open}
      onSelectNav={(navId) =>
        void runGuardedAction(() => actions.selectNav?.(navId))
      }
      onSelectProject={(projectId, teamId) =>
        void runGuardedAction(() =>
          actions.selectProject?.(projectId, teamId),
        )
      }
      onSelectTeamView={(teamId, viewId) =>
        void runGuardedAction(() =>
          actions.selectTeamView?.(teamId, viewId),
        )
      }
      teams={data.teams}
    />
  )

  return (
    <main className="workbench-shell flex h-svh min-h-0 overflow-hidden">
      <div className="max-[980px]:hidden">{globalSidebar}</div>
      <MobileSidebarDrawer
        closeLabel={t('sidebar.mobileClose')}
        dialogLabel={t('sidebar.mobileDialog')}
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
      >
        <Sidebar
          activeNavId="documents"
          inboxCount={inboxCount}
          labels={sidebarLabels}
          onOpenSearch={() => {
            setIsMobileSidebarOpen(false)
            commandMenu.open?.()
          }}
          onSelectNav={(navId) => {
            void runGuardedAction(() => actions.selectNav?.(navId))
              .then((completed) => {
                if (completed) setIsMobileSidebarOpen(false)
              })
          }}
          onSelectProject={(projectId, teamId) => {
            void runGuardedAction(() =>
              actions.selectProject?.(projectId, teamId),
            ).then((completed) => {
              if (completed) setIsMobileSidebarOpen(false)
            })
          }}
          onSelectTeamView={(teamId, viewId) => {
            void runGuardedAction(() =>
              actions.selectTeamView?.(teamId, viewId),
            ).then((completed) => {
              if (completed) setIsMobileSidebarOpen(false)
            })
          }}
          teams={data.teams}
        />
      </MobileSidebarDrawer>

      <section className="workbench-main flex min-w-0 flex-1 flex-col overflow-hidden">
        <DocumentHeader
          contextTab={contextTab}
          isExportMenuOpen={isExportMenuOpen}
          presence={data.presence}
          selectedDocument={selectedDocument}
          t={t}
          userInitial={userInitial}
          userLabel={userLabel}
          onArchive={
            selectedDocument?.capabilities.canArchive &&
            actions.archiveDocument
              ? async () => {
                  await runGuardedAction(() =>
                    actions.archiveDocument?.(selectedDocument),
                  )
                }
              : undefined
          }
          onContextOpen={openContext}
          onExport={
            selectedDocument?.capabilities.canExport &&
            actions.exportDocument
              ? (format) =>
                  actions.exportDocument!(selectedDocument.id, format)
              : undefined
          }
          onExportMenuOpenChange={setIsExportMenuOpen}
          onFavoriteChange={
            selectedDocument && actions.setFavorite
              ? (favorite) =>
                  actions.setFavorite!(selectedDocument, favorite)
              : undefined
          }
          onLogout={
            actions.logout
              ? () => {
                  void runGuardedAction(() => actions.logout?.())
                }
              : undefined
          }
          onMobileSidebarOpen={() => setIsMobileSidebarOpen(true)}
          onRestore={
            selectedDocument?.capabilities.canRestore &&
            actions.restoreDocument
              ? async () => {
                  await runGuardedAction(() =>
                    actions.restoreDocument?.(selectedDocument),
                  )
                }
              : undefined
          }
          onShareOpen={
            selectedDocument?.capabilities.canShare
              ? () => {
                  void runGuardedAction(() =>
                    setIsShareDialogOpen(true),
                  )
                }
              : undefined
          }
          onTreeOpen={openTreeDrawer}
        />

        {actionErrorMessage ? (
          <div
            className="flex flex-none items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-800"
            role="alert"
          >
            <span className="min-w-0 flex-1">
              {actionErrorMessage}
            </span>
            <button
              aria-label={t('documents.action.dismissError')}
              className="grid h-8 w-8 flex-none place-items-center rounded-md hover:bg-red-100"
              onClick={() => setActionErrorMessage(undefined)}
              type="button"
            >
              ×
            </button>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <DocumentTree
            className="max-[1099px]:hidden"
            documents={data.documents}
            hasMoreActive={data.hasMoreActiveDocuments}
            hasMoreArchived={data.hasMoreArchivedDocuments}
            selectedDocumentId={selectedDocument?.id}
            t={t}
            teams={data.teams}
            onCreateDocument={createDocumentAction}
            onMoveDocument={
              actions.moveDocument
                ? async (document, parentId, scope) => {
                    await requireSavedDraft()
                    await actions.moveDocument?.(
                      document,
                      parentId,
                      scope,
                    )
                  }
                : undefined
            }
            onLoadMore={
              actions.loadMoreDocuments
                ? async (archived) => {
                    await runGuardedAction(() =>
                      actions.loadMoreDocuments?.(archived),
                    )
                  }
                : undefined
            }
            onSelectDocument={(selectedId) => {
              void selectDocument(selectedId)
            }}
          />

          {isTreeDrawerOpen ? (
            <div
              aria-label={t('documents.tree.aria')}
              aria-modal="true"
              className="fixed inset-0 z-[60] min-[1100px]:hidden"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeTreeDrawer()
                  return
                }
                trapModalFocus(event, treeDrawerRef.current)
              }}
              ref={treeDrawerRef}
              role="dialog"
              tabIndex={-1}
            >
              <button
                aria-label={t('documents.tree.close')}
                className="absolute inset-0 bg-slate-950/45"
                onClick={closeTreeDrawer}
                type="button"
              />
              <DocumentTree
                className="relative z-10 max-w-[calc(100vw-42px)] shadow-2xl"
                documents={data.documents}
                hasMoreActive={data.hasMoreActiveDocuments}
                hasMoreArchived={data.hasMoreArchivedDocuments}
                selectedDocumentId={selectedDocument?.id}
                t={t}
                teams={data.teams}
                onCreateDocument={createDocumentAction}
                onMoveDocument={
                  actions.moveDocument
                    ? async (document, parentId, scope) => {
                        await requireSavedDraft()
                        await actions.moveDocument?.(
                          document,
                          parentId,
                          scope,
                        )
                      }
                    : undefined
                }
                onRequestClose={closeTreeDrawer}
                onLoadMore={
                  actions.loadMoreDocuments
                    ? async (archived) => {
                        await runGuardedAction(() =>
                          actions.loadMoreDocuments?.(archived),
                        )
                      }
                    : undefined
                }
                onSelectDocument={(selectedId) => {
                  void selectDocument(selectedId).then((completed) => {
                    if (completed) closeTreeDrawer()
                  })
                }}
              />
            </div>
          ) : null}

          <div className="relative min-w-0 flex-1 overflow-hidden">
            {isLoading ? (
              <div className="grid h-full place-items-center px-6 text-sm font-semibold text-[var(--workbench-muted)]">
                {t('documents.loading')}
              </div>
            ) : errorMessage ? (
              <div className="grid h-full place-items-center px-6 py-12">
                <section className="workbench-panel max-w-[560px] p-8 text-center">
                  <h1 className="text-xl font-semibold text-[var(--workbench-text)]">
                    {t('documents.error.title')}
                  </h1>
                  <p
                    className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]"
                    role="alert"
                  >
                    {errorMessage}
                  </p>
                </section>
              </div>
            ) : selectedDocument ? (
              <DocumentWorkspace
                key={selectedDocument.id}
                selectedDocument={selectedDocument}
                t={t}
                onActiveAnchorChange={actions.setActiveAnchor}
                onApplyOperations={actions.applyOperations}
                onContextOpen={openContext}
                onDraftGuardChange={handleDraftGuardChange}
                onNavigate={
                  actions.navigate
                    ? (path) => {
                        void runGuardedAction(() =>
                          actions.navigate?.(path),
                        )
                      }
                    : undefined
                }
                onUnsavedStateChange={handleUnsavedStateChange}
                onUpdateDocument={actions.updateDocument}
              />
            ) : (
              <div className="h-full overflow-y-auto overscroll-contain">
                <DocumentHome
                  documents={data.documents}
                  t={t}
                  teams={data.teams}
                  onCreateDocument={createDocumentAction}
                  onInstantiateTemplate={
                    data.canCreateDocuments
                      ? actions.instantiateTemplate
                        ? (templateId) => {
                            void runGuardedAction(() =>
                              actions.instantiateTemplate?.(
                                templateId,
                              ),
                            )
                          }
                        : undefined
                      : undefined
                  }
                  onSelectDocument={(selectedId) => {
                    void selectDocument(selectedId)
                  }}
                />
              </div>
            )}
          </div>

          {contextTab && selectedDocument ? (
            <>
              <button
                aria-label={t('documents.context.close')}
                className="fixed inset-0 z-40 bg-slate-950/35 min-[1280px]:hidden"
                onClick={() => changeContextTab(undefined)}
                type="button"
              />
              <div className="fixed inset-y-0 right-0 z-50 max-w-[calc(100vw-24px)] shadow-2xl min-[1280px]:static min-[1280px]:z-auto min-[1280px]:shadow-none">
                <DocumentContextPanel
                  activeTab={contextTab}
                  backlinks={data.backlinks}
                  comments={data.comments}
                  defaultAnchorId={defaultCommentAnchorId}
                  document={selectedDocument}
                  focusedCommentId={data.focusedCommentId}
                  hasMoreBacklinks={
                    data.hasMoreBacklinks
                  }
                  hasMoreComments={data.hasMoreComments}
                  hasMoreVersions={data.hasMoreVersions}
                  isLoading={isContextLoading}
                  modal={isContextModal}
                  t={t}
                  versions={data.versions}
                  onClose={() => changeContextTab(undefined)}
                  onCreateComment={
                    selectedDocument.capabilities.canComment &&
                    actions.createComment
                      ? async (
                          body,
                          mentions,
                          anchor,
                          parentCommentId,
                        ) => {
                          await actions.createComment!(selectedDocument.id, {
                            anchor,
                            body,
                            mentions,
                            ...(parentCommentId === undefined
                              ? {}
                              : { parentCommentId }),
                          })
                        }
                      : undefined
                  }
                  onNavigate={
                    actions.navigate
                      ? (path) => {
                          void runGuardedAction(() =>
                            actions.navigate?.(path),
                          )
                        }
                      : undefined
                  }
                  onLoadMoreBacklinks={
                    actions.loadMoreBacklinks
                  }
                  onLoadMoreComments={
                    actions.loadMoreComments
                  }
                  onLoadMoreVersions={
                    actions.loadMoreVersions
                  }
                  onDeleteRelation={
                    selectedDocument.capabilities.canEdit &&
                    actions.applyOperations
                      ? async (relationId) => {
                          await requireSavedDraft()
                          await actions.applyOperations!(
                            selectedDocument.id,
                            selectedDocument.revision,
                            [{
                              operationId: createDocumentOperationId(),
                              relationId,
                              type: 'delete-relation',
                            }],
                          )
                        }
                      : undefined
                  }
                  onResolveComment={
                    selectedDocument.capabilities.canComment &&
                    actions.resolveComment
                      ? (commentId) =>
                          actions.resolveComment?.(
                            selectedDocument.id,
                            commentId,
                          ) ?? Promise.resolve()
                      : undefined
                  }
                  onRestoreVersion={
                    selectedDocument.capabilities.canEdit &&
                    actions.restoreVersion
                      ? async (versionId) => {
                          await requireSavedDraft()
                          await actions.restoreVersion!(
                            selectedDocument.id,
                            versionId,
                          )
                        }
                      : undefined
                  }
                  onUpsertRelation={
                    selectedDocument.capabilities.canEdit &&
                    actions.applyOperations
                      ? async (relation: DocumentRelation) => {
                          await requireSavedDraft()
                          await actions.applyOperations!(
                            selectedDocument.id,
                            selectedDocument.revision,
                            [{
                              operationId: createDocumentOperationId(),
                              relation,
                              type: 'upsert-relation',
                            }],
                          )
                        }
                      : undefined
                  }
                  onTabChange={changeContextTab}
                />
              </div>
            </>
          ) : null}
        </div>
      </section>

      {isShareDialogOpen && selectedDocument ? (
        <DocumentShareDialog
          document={selectedDocument}
          shares={data.shares}
          t={t}
          onClose={() => setIsShareDialogOpen(false)}
          onCreateShare={
            actions.createShare
              ? (input) =>
                  actions.createShare!(selectedDocument.id, input)
              : undefined
          }
          onDeleteShare={
            actions.deleteShare
              ? (input) =>
                  actions.deleteShare!(selectedDocument.id, input)
              : undefined
          }
          onPermissionChange={
            actions.updateDocument
              ? async (permission) => {
                  await actions.updateDocument?.(
                    selectedDocument.id,
                    selectedDocument.revision,
                    { permission },
                  )
                }
              : undefined
          }
        />
      ) : null}
    </main>
  )
}

/**
 * Document detail 内の local operation queue と autosave を管理します。
 */
type DocumentWorkspaceProps = {
  /**
   * API から取得した選択中 Document です。
   */
  selectedDocument: DocumentRecord
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Focus 中 anchor 変更 callback です。
   */
  onActiveAnchorChange?: (anchorId?: string) => void
  /**
   * Operation batch 保存 callback です。
   */
  onApplyOperations?: (
    documentId: string,
    expectedRevision: number,
    operations: DocumentOperation[],
  ) => Promise<DocumentOperationSaveResult>
  /**
   * Context drawer open callback です。
   */
  onContextOpen: (tab: DocumentContextTab, anchorId?: string) => void
  /**
   * Route navigation と破壊的操作へ現在の draft guard を登録します。
   */
  onDraftGuardChange?: (guard?: DocumentDraftSaveGuard) => void
  /**
   * Work Item link navigation callback です。
   */
  onNavigate?: (path: string) => void
  /**
   * Navigation guard 用の未保存状態変更 callback です。
   */
  onUnsavedStateChange?: (hasUnsavedChanges: boolean) => void
  /**
   * Title/permission 更新 callback です。
   */
  onUpdateDocument?: (
    documentId: string,
    expectedRevision: number,
    input: {
      /**
       * 変更後 title です。
       */
      title?: string
      /**
       * 変更後 permission です。
       */
      permission?: DocumentPermission
      /**
       * 移動先 parent ID です。
       */
      parentId?: string | null
      /**
       * 移動先 scope です。
       */
      scope?: DocumentScope
    },
  ) => Promise<DocumentRecord>
}

function DocumentWorkspace({
  onActiveAnchorChange,
  onApplyOperations,
  onContextOpen,
  onDraftGuardChange,
  onNavigate,
  onUnsavedStateChange,
  onUpdateDocument,
  selectedDocument,
  t,
}: DocumentWorkspaceProps) {
  const [localDocument, setLocalDocument] = useState(selectedDocument)
  const [saveStatus, setSaveStatus] =
    useState<DocumentSaveStatus>('idle')
  const saveStatusRef = useRef<DocumentSaveStatus>('idle')
  const [titleDirty, setTitleDirty] = useState(false)
  const titleDirtyRef = useRef(false)
  const titleGenerationRef = useRef(0)
  const titleValueRef = useRef(selectedDocument.title)
  const committedTitleRef = useRef(selectedDocument.title)
  const pendingOperationsRef = useRef<DocumentOperation[]>([])
  const saveTimerRef = useRef<number | undefined>(undefined)
  const revisionRef = useRef(selectedDocument.revision)
  const generationRef = useRef(0)
  const activeFlushRef = useRef<Promise<boolean> | undefined>(
    undefined,
  )
  const activeTitleCommitRef = useRef<
    Promise<boolean> | undefined
  >(undefined)
  const flushRef = useRef<() => Promise<boolean>>(
    async () => true,
  )
  const editable =
    localDocument.capabilities.canEdit && Boolean(onApplyOperations)
  const hasUnsavedChanges =
    titleDirty ||
    pendingOperationsRef.current.length > 0 ||
    saveStatus === 'saving' ||
    saveStatus === 'conflict' ||
    saveStatus === 'error'

  useEffect(() => {
    onUnsavedStateChange?.(hasUnsavedChanges)
    if (!hasUnsavedChanges) return

    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventUnload)
    return () => window.removeEventListener('beforeunload', preventUnload)
  }, [hasUnsavedChanges, onUnsavedStateChange])

  useEffect(() => {
    saveStatusRef.current = saveStatus
  }, [saveStatus])

  useEffect(() => {
    if (shouldAdoptIncomingDocument({
      hasDirtyTitle: titleDirty,
      incomingRevision: selectedDocument.revision,
      localRevision: revisionRef.current,
      pendingOperationCount: pendingOperationsRef.current.length,
      saveStatus,
    })) {
      setLocalDocument(selectedDocument)
      revisionRef.current = selectedDocument.revision
      titleValueRef.current = selectedDocument.title
      committedTitleRef.current = selectedDocument.title
      titleDirtyRef.current = false
      setTitleDirty(false)
    }
  }, [saveStatus, selectedDocument, titleDirty])

  const flushOperations = useCallback(async () => {
    if (!onApplyOperations) {
      return pendingOperationsRef.current.length === 0
    }

    if (activeFlushRef.current) {
      return activeFlushRef.current
    }

    if (pendingOperationsRef.current.length === 0) {
      return true
    }

    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = undefined
    }

    const activeFlush = (async () => {
      saveStatusRef.current = 'saving'
      setSaveStatus('saving')
      while (pendingOperationsRef.current.length > 0) {
        const operations = pendingOperationsRef.current
        pendingOperationsRef.current = []
        const savedGeneration = generationRef.current
        const expectedRevision = revisionRef.current

        try {
          const saved = await onApplyOperations(
            localDocument.id,
            expectedRevision,
            operations,
          )
          const updated = saved.document
          const canAdoptSavedDocument =
            generationRef.current === savedGeneration &&
            !titleDirtyRef.current
          revisionRef.current = canAdoptSavedDocument
            ? updated.revision
            : saved.committedRevision
          setLocalDocument((current) =>
            canAdoptSavedDocument
              ? updated
              : {
                  ...current,
                  capabilities: updated.capabilities,
                  revision: saved.committedRevision,
                  updatedAt: updated.updatedAt,
                },
          )
        } catch (error) {
          const chunkError =
            error instanceof DocumentOperationChunkSaveError
              ? error
              : new DocumentOperationChunkSaveError(error, operations)
          const originalError = chunkError.originalError
          pendingOperationsRef.current = coalesceDocumentOperations([
            ...chunkError.remainingOperations,
            ...pendingOperationsRef.current,
          ])
          if (
            chunkError.lastSavedDocument &&
            chunkError.lastCommittedRevision !== undefined
          ) {
            revisionRef.current =
              chunkError.lastCommittedRevision
            setLocalDocument((current) => ({
              ...current,
              capabilities:
                chunkError.lastSavedDocument!.capabilities,
              revision: chunkError.lastCommittedRevision!,
              updatedAt: chunkError.lastSavedDocument!.updatedAt,
            }))
          }
          if (
            originalError instanceof DocumentRevisionConflictError
          ) {
            revisionRef.current =
              originalError.latestDocument.revision
            setLocalDocument((current) => ({
              ...current,
              capabilities:
                originalError.latestDocument.capabilities,
              revision: originalError.latestDocument.revision,
              updatedAt: originalError.latestDocument.updatedAt,
            }))
          }
          const nextSaveStatus =
            originalError instanceof DocumentsApiError &&
            originalError.status === 409
              ? 'conflict'
              : 'error'
          saveStatusRef.current = nextSaveStatus
          setSaveStatus(nextSaveStatus)
          return false
        }
      }
      saveStatusRef.current = 'saved'
      setSaveStatus('saved')
      return true
    })()
    activeFlushRef.current = activeFlush

    try {
      return await activeFlush
    } finally {
      if (activeFlushRef.current === activeFlush) {
        activeFlushRef.current = undefined
      }
    }
  }, [localDocument.id, onApplyOperations])

  useEffect(() => {
    flushRef.current = flushOperations
  }, [flushOperations])

  useEffect(
    () => () => {
      if (saveTimerRef.current !== undefined) {
        window.clearTimeout(saveTimerRef.current)
      }
    },
    [],
  )

  const queueOperation = (operation: DocumentOperation) => {
    onUnsavedStateChange?.(true)
    generationRef.current += 1
    pendingOperationsRef.current = coalesceDocumentOperations([
      ...pendingOperationsRef.current,
      operation,
    ])
    setLocalDocument((current) =>
      applyDocumentOperationsLocally(current, [operation]),
    )
    if (!shouldScheduleDocumentAutosave(saveStatusRef.current)) {
      return
    }
    saveStatusRef.current = 'saving'
    setSaveStatus('saving')
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined
      void flushRef.current()
    }, documentAutosaveDelay)
  }

  const performTitleCommit = useCallback(async () => {
    const title = titleValueRef.current.trim()
    const savedTitleGeneration = titleGenerationRef.current
    if (
      !onUpdateDocument ||
      !localDocument.capabilities.canEdit
    ) {
      return !titleDirtyRef.current
    }
    if (!title) {
      return false
    }
    if (!titleDirtyRef.current) {
      return true
    }

    const operationsSaved = await flushRef.current()
    if (!operationsSaved || pendingOperationsRef.current.length > 0) {
      return false
    }
    if (
      !isDocumentTitleCommitCurrent(
        savedTitleGeneration,
        titleGenerationRef.current,
      )
    ) {
      return true
    }
    saveStatusRef.current = 'saving'
    setSaveStatus('saving')
    try {
      const updated = await onUpdateDocument(
        localDocument.id,
        revisionRef.current,
        { title },
      )
      revisionRef.current = updated.revision
      committedTitleRef.current = updated.title
      const titleIsStillCurrent =
        isDocumentTitleCommitCurrent(
          savedTitleGeneration,
          titleGenerationRef.current,
        )
      setLocalDocument((current) => ({
        ...current,
        capabilities: updated.capabilities,
        revision: updated.revision,
        ...(titleIsStillCurrent ? { title: updated.title } : {}),
        updatedAt: updated.updatedAt,
      }))
      if (titleIsStillCurrent) {
        titleValueRef.current = updated.title
        titleDirtyRef.current = false
        setTitleDirty(false)
      }
      saveStatusRef.current = 'saved'
      setSaveStatus('saved')
      return true
    } catch (error) {
      if (error instanceof DocumentRevisionConflictError) {
        revisionRef.current = error.latestDocument.revision
        committedTitleRef.current =
          error.latestDocument.title
        setLocalDocument((current) => ({
          ...current,
          capabilities: error.latestDocument.capabilities,
          revision: error.latestDocument.revision,
          updatedAt: error.latestDocument.updatedAt,
        }))
      }
      const nextSaveStatus =
        error instanceof DocumentsApiError && error.status === 409
          ? 'conflict'
          : 'error'
      saveStatusRef.current = nextSaveStatus
      setSaveStatus(nextSaveStatus)
      return false
    }
  }, [
    localDocument.capabilities.canEdit,
    localDocument.id,
    onUpdateDocument,
  ])

  const commitTitle = useCallback(async () => {
    while (true) {
      const existingCommit = activeTitleCommitRef.current
      if (existingCommit) {
        if (!(await existingCommit)) return false
        if (!titleDirtyRef.current) return true
        continue
      }

      const activeCommit = performTitleCommit()
      activeTitleCommitRef.current = activeCommit
      try {
        if (!(await activeCommit)) return false
      } finally {
        if (activeTitleCommitRef.current === activeCommit) {
          activeTitleCommitRef.current = undefined
        }
      }
      if (!titleDirtyRef.current) return true
    }
  }, [performTitleCommit])

  const savePendingChanges = useCallback(
    () =>
      saveAllPendingDocumentChanges({
        commitTitle,
        flushOperations: () => flushRef.current(),
        getActiveOperationFlush: () => activeFlushRef.current,
        getActiveTitleCommit: () => activeTitleCommitRef.current,
        getSaveStatus: () => saveStatusRef.current,
        hasDirtyTitle: () => titleDirtyRef.current,
        hasPendingOperations: () =>
          pendingOperationsRef.current.length > 0,
      }),
    [commitTitle],
  )

  const retryPendingChanges = useCallback(
    () => {
      if (
        saveStatusRef.current === 'conflict' ||
        saveStatusRef.current === 'error'
      ) {
        saveStatusRef.current = 'idle'
        setSaveStatus('idle')
      }
      return titleDirtyRef.current
        ? commitTitle()
        : flushRef.current()
    },
    [commitTitle],
  )

  useEffect(() => {
    if (!onDraftGuardChange) {
      return
    }
    const guard: DocumentDraftSaveGuard = {
      hasUnsavedChanges: () =>
        titleDirtyRef.current ||
        pendingOperationsRef.current.length > 0 ||
        activeFlushRef.current !== undefined ||
        activeTitleCommitRef.current !== undefined ||
        saveStatusRef.current === 'conflict' ||
        saveStatusRef.current === 'error',
      savePendingChanges,
    }
    onDraftGuardChange(guard)
    return () => onDraftGuardChange(undefined)
  }, [onDraftGuardChange, savePendingChanges])

  const upsertWhiteboardObject = (object: WhiteboardObject) => {
    const existing =
      localDocument.kind === 'whiteboard' &&
      localDocument.whiteboard.objects.some(
        (candidate) => candidate.id === object.id,
      )
    queueOperation(
      existing
        ? {
            object,
            objectId: object.id,
            operationId: createDocumentOperationId(),
            type: 'update-object',
          }
        : {
            object,
            operationId: createDocumentOperationId(),
            type: 'insert-object',
          },
    )
  }
  const upsertWhiteboardConnector = (connector: WhiteboardConnector) =>
    queueOperation({
      connector,
      operationId: createDocumentOperationId(),
      type: 'upsert-connector',
    })
  const upsertWhiteboardFrame = (frame: WhiteboardFrame) =>
    queueOperation({
      frame,
      operationId: createDocumentOperationId(),
      type: 'upsert-frame',
    })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-start gap-3 border-b border-[var(--workbench-border)] bg-white px-[clamp(20px,3vw,36px)] py-4">
        <span className="mt-1 text-2xl" aria-hidden="true">
          {localDocument.kind === 'whiteboard' ? '⌘' : '▤'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-xs font-semibold text-[var(--workbench-muted)]">
            {localDocument.scope.type === 'project'
              ? `${t('documents.scope.project')} · ${localDocument.scope.projectId}`
              : t('documents.scope.workspace')}
          </p>
          <input
            aria-label={t('documents.editor.title')}
            className="mt-1 w-full border-0 bg-transparent p-0 text-xl font-semibold text-[var(--workbench-text)] outline-none placeholder:text-[var(--workbench-muted-soft)]"
            disabled={!localDocument.capabilities.canEdit}
            onBlur={() => void commitTitle()}
            onChange={(event) => {
              titleGenerationRef.current += 1
              titleValueRef.current = event.target.value
              const dirty = isDocumentTitleDirty(
                event.target.value,
                committedTitleRef.current,
                activeTitleCommitRef.current !== undefined,
              )
              if (dirty) onUnsavedStateChange?.(true)
              titleDirtyRef.current = dirty
              setTitleDirty(dirty)
              setLocalDocument((current) => ({
                ...current,
                title: event.target.value,
              }))
            }}
            value={localDocument.title}
          />
        </div>
        {saveStatus === 'conflict' || saveStatus === 'error' ? (
          <button
            className="workbench-button-secondary mt-0.5 min-h-9 px-3 text-xs"
            onClick={() => void retryPendingChanges()}
            type="button"
          >
            {saveStatus === 'conflict'
              ? t('documents.editor.overwriteRetry')
              : t('documents.editor.retrySave')}
          </button>
        ) : null}
        <span className="workbench-badge mt-1">
          r{localDocument.revision}
        </span>
      </div>
      {localDocument.kind === 'whiteboard' ? (
        <div className="min-h-0 flex-1">
          <WhiteboardCanvas
            content={localDocument.whiteboard}
            editable={editable}
            t={t}
            onActiveAnchorChange={onActiveAnchorChange}
            onDeleteConnector={(connectorId) =>
              queueOperation({
                connectorId,
                operationId: createDocumentOperationId(),
                type: 'delete-connector',
              })
            }
            onDeleteFrame={(frameId) =>
              queueOperation({
                frameId,
                operationId: createDocumentOperationId(),
                type: 'delete-frame',
              })
            }
            onDeleteObject={(objectId) =>
              queueOperation({
                objectId,
                operationId: createDocumentOperationId(),
                type: 'delete-object',
              })
            }
            onNavigate={onNavigate}
            onUpsertConnector={upsertWhiteboardConnector}
            onUpsertFrame={upsertWhiteboardFrame}
            onUpsertObject={upsertWhiteboardObject}
          />
        </div>
      ) : localDocument.kind === 'page' ||
        localDocument.kind === 'template' ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <DocumentEditor
            document={localDocument}
            editable={editable}
            saveStatus={saveStatus}
            t={t}
            onActiveAnchorChange={onActiveAnchorChange}
            onDeleteBlock={(blockId) =>
              queueOperation({
                blockId,
                operationId: createDocumentOperationId(),
                type: 'delete-block',
              })
            }
            onMoveBlock={(blockId, index) =>
              queueOperation({
                blockId,
                index,
                operationId: createDocumentOperationId(),
                type: 'move-block',
              })
            }
            onOpenComments={(anchorId) =>
              onContextOpen('comments', anchorId)
            }
            onUpsertBlock={(block, index) =>
              queueOperation(
                index === undefined
                  ? {
                      block,
                      blockId: block.id,
                      operationId: createDocumentOperationId(),
                      type: 'update-block',
                    }
                  : {
                      block,
                      index,
                      operationId: createDocumentOperationId(),
                      type: 'insert-block',
                    },
              )
            }
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center px-6 text-sm font-semibold text-[var(--workbench-muted)]">
          {t('documents.kind.folder')}
        </div>
      )}
    </div>
  )
}

function DocumentHeader({
  contextTab,
  isExportMenuOpen,
  onArchive,
  onContextOpen,
  onExport,
  onExportMenuOpenChange,
  onFavoriteChange,
  onLogout,
  onMobileSidebarOpen,
  onRestore,
  onShareOpen,
  onTreeOpen,
  presence,
  selectedDocument,
  t,
  userInitial,
  userLabel,
}: {
  contextTab?: DocumentContextTab
  isExportMenuOpen: boolean
  onArchive?: () => Promise<void>
  onContextOpen: (tab: DocumentContextTab) => void
  onExport?: (format: DocumentExportFormat) => Promise<void>
  onExportMenuOpenChange: (open: boolean) => void
  onFavoriteChange?: (favorite: boolean) => Promise<void>
  onLogout?: () => void
  onMobileSidebarOpen: () => void
  onRestore?: () => Promise<void>
  onShareOpen?: () => void
  onTreeOpen: () => void
  presence: DocumentPresence[]
  selectedDocument?: DocumentRecord
  t: (key: MessageKey) => string
  userInitial: string
  userLabel: string
}) {
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false)
  const uniquePresence = [
    ...new Map(
      presence.map((entry) => [entry.userId, entry]),
    ).values(),
  ]
  const exportFormats: DocumentExportFormat[] =
    selectedDocument?.kind === 'whiteboard'
      ? ['svg', 'json']
      : selectedDocument?.kind === 'page' ||
          selectedDocument?.kind === 'template'
        ? ['markdown', 'json']
        : ['json']
  const hasOverflowActions = Boolean(
    onShareOpen || onExport || onArchive || onRestore || onLogout,
  )

  return (
    <header className="workbench-header relative z-20 flex min-h-[64px] flex-none items-center gap-3 px-[clamp(14px,2vw,26px)] py-2.5">
      <MobileSidebarButton
        label={t('sidebar.mobileOpen')}
        onClick={onMobileSidebarOpen}
      />
      <button
        aria-label={t('documents.tree.open')}
        className="grid h-10 w-10 flex-none place-items-center rounded-md border border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:text-[var(--workbench-primary)] min-[1100px]:hidden"
        onClick={onTreeOpen}
        type="button"
      >
        ☰
      </button>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--workbench-primary)]">
          mukuroji · {t('documents.title')}
        </p>
        <p className="m-0 mt-1 truncate text-sm font-semibold text-[var(--workbench-text)]">
          {selectedDocument?.title ?? t('documents.home.title')}
        </p>
      </div>

      {selectedDocument ? (
        <div className="flex flex-none items-center gap-1.5">
          <div
            aria-label={t('documents.presence.aria')}
            className="mr-1 hidden items-center -space-x-2 sm:flex"
          >
            {uniquePresence.slice(0, 4).map((entry) => (
              <span
                className="grid h-8 w-8 place-items-center rounded-full border-2 border-white bg-[#e5f7f4] text-[11px] font-bold text-[var(--workbench-primary)]"
                key={entry.userId}
                style={{ color: entry.color }}
                title={entry.displayName}
              >
                {entry.displayName.charAt(0).toUpperCase()}
              </span>
            ))}
            {uniquePresence.length > 4 ? (
              <span className="grid h-8 w-8 place-items-center rounded-full border-2 border-white bg-[var(--workbench-surface-muted)] text-[10px] font-bold text-[var(--workbench-muted)]">
                +{uniquePresence.length - 4}
              </span>
            ) : null}
          </div>
          <button
            aria-label={
              selectedDocument.favorite
                ? t('documents.favorite.remove')
                : t('documents.favorite.add')
            }
            className={`grid h-9 w-9 place-items-center rounded-md border border-[var(--workbench-border)] bg-white ${
              selectedDocument.favorite
                ? 'text-amber-500'
                : 'text-[var(--workbench-muted)]'
            }`}
            disabled={!onFavoriteChange}
            onClick={() =>
              void onFavoriteChange?.(!selectedDocument.favorite)
            }
            type="button"
          >
            {selectedDocument.favorite ? '★' : '☆'}
          </button>
          <button
            aria-pressed={contextTab === 'comments'}
            className="workbench-button-secondary hidden min-h-9 px-3 sm:inline-flex"
            onClick={() => onContextOpen('comments')}
            type="button"
          >
            {t('documents.context.comments')}
          </button>
          <button
            aria-label={t('documents.context.aria')}
            aria-pressed={Boolean(contextTab)}
            className="grid h-9 w-9 place-items-center rounded-md border border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:text-[var(--workbench-primary)]"
            onClick={() => onContextOpen(contextTab ?? 'activity')}
            type="button"
          >
            ◫
          </button>
          {onShareOpen ? (
            <button
              className="workbench-button-primary hidden min-h-9 px-3 sm:inline-flex"
              onClick={onShareOpen}
              type="button"
            >
              {t('documents.share.action')}
            </button>
          ) : null}
          {onExport ? (
            <div className="relative hidden md:block">
              <button
                aria-expanded={isExportMenuOpen}
                aria-haspopup="menu"
                className="workbench-button-secondary min-h-9 px-3"
                onClick={() =>
                  onExportMenuOpenChange(!isExportMenuOpen)
                }
                type="button"
              >
                {t('documents.export.action')} ▾
              </button>
              {isExportMenuOpen ? (
                <div
                  className="absolute right-0 top-11 z-30 w-40 rounded-lg border border-[var(--workbench-border)] bg-white p-1.5 shadow-xl"
                  role="menu"
                >
                  {exportFormats.map((format) => (
                    <button
                      className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]"
                      key={format}
                      onClick={() => {
                        onExportMenuOpenChange(false)
                        void onExport(format)
                      }}
                      role="menuitem"
                      type="button"
                    >
                      {format.toUpperCase()}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {selectedDocument.archivedAt ? (
            onRestore ? (
              <button
                className="workbench-button-secondary hidden min-h-9 px-3 lg:inline-flex"
                onClick={() => void onRestore()}
                type="button"
              >
                {t('documents.action.restore')}
              </button>
            ) : null
          ) : onArchive ? (
            <button
              aria-label={t('documents.action.archive')}
              className="hidden h-9 w-9 place-items-center rounded-md border border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:text-[var(--workbench-danger)] lg:grid"
              onClick={() => void onArchive()}
              type="button"
            >
              ▣
            </button>
          ) : null}
        </div>
      ) : null}

      {hasOverflowActions ? (
        <div
          className="relative flex-none xl:hidden"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setIsActionMenuOpen(false)
            }
          }}
        >
          <button
            aria-expanded={isActionMenuOpen}
            aria-haspopup="menu"
            aria-label={t('documents.action.more')}
            className="grid h-9 w-9 place-items-center rounded-md border border-[var(--workbench-border)] bg-white text-lg font-bold text-[var(--workbench-muted)]"
            onClick={() => setIsActionMenuOpen((current) => !current)}
            type="button"
          >
            ⋯
          </button>
          {isActionMenuOpen ? (
            <div
              className="absolute right-0 top-11 z-40 min-w-52 rounded-lg border border-[var(--workbench-border)] bg-white p-1.5 shadow-xl"
              role="menu"
            >
              {onShareOpen ? (
                <button
                  className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold hover:bg-[var(--workbench-surface-muted)]"
                  onClick={() => {
                    setIsActionMenuOpen(false)
                    onShareOpen()
                  }}
                  role="menuitem"
                  type="button"
                >
                  {t('documents.share.action')}
                </button>
              ) : null}
              {onExport
                ? exportFormats.map((format) => (
                    <button
                      className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold hover:bg-[var(--workbench-surface-muted)]"
                      key={format}
                      onClick={() => {
                        setIsActionMenuOpen(false)
                        void onExport(format)
                      }}
                      role="menuitem"
                      type="button"
                    >
                      {t('documents.export.action')} · {format.toUpperCase()}
                    </button>
                  ))
                : null}
              {onRestore ? (
                <button
                  className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold hover:bg-[var(--workbench-surface-muted)]"
                  onClick={() => {
                    setIsActionMenuOpen(false)
                    void onRestore()
                  }}
                  role="menuitem"
                  type="button"
                >
                  {t('documents.action.restore')}
                </button>
              ) : null}
              {onArchive ? (
                <button
                  className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold text-[var(--workbench-danger)] hover:bg-red-50"
                  onClick={() => {
                    setIsActionMenuOpen(false)
                    void onArchive()
                  }}
                  role="menuitem"
                  type="button"
                >
                  {t('documents.action.archive')}
                </button>
              ) : null}
              {onLogout ? (
                <button
                  className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold hover:bg-[var(--workbench-surface-muted)]"
                  onClick={() => {
                    setIsActionMenuOpen(false)
                    onLogout()
                  }}
                  role="menuitem"
                  type="button"
                >
                  {t('dashboard.logout')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="ml-1 hidden items-center gap-2 xl:flex">
        <div className="hidden text-right 2xl:block">
          <p className="m-0 max-w-[170px] truncate text-xs font-semibold text-[var(--workbench-text)]">
            {userLabel}
          </p>
        </div>
        <span className="grid h-9 w-9 place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-xs font-bold text-[var(--workbench-primary)]">
          {userInitial}
        </span>
        {onLogout ? (
          <button
            className="workbench-button-secondary min-h-9 px-3"
            onClick={onLogout}
            type="button"
          >
            {t('dashboard.logout')}
          </button>
        ) : null}
      </div>
    </header>
  )
}

/**
 * API 呼び出しを入力順のまま指定並列数以内で実行します。
 */
async function mapWithBoundedConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results: Output[] = []
  let nextIndex = 0
  const workerCount = Math.min(
    Math.max(1, Math.trunc(concurrency)),
    values.length,
  )
  const workers = Array.from(
    { length: workerCount },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(values[index]!, index)
      }
    },
  )

  await Promise.all(workers)
  return results
}

function readRelationTargetId(
  target: DocumentRelation['target'],
): string {
  switch (target.kind) {
    case 'work-item':
      return target.workItemId
    case 'project':
      return target.projectId
    case 'goal':
      return target.goalId
  }
}

function readOptionalDocumentCommentId(
  value: string | null,
) {
  const normalized = value?.trim()
  return normalized &&
      normalized.length <= 500 &&
      ![...normalized].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint <= 31 || codePoint === 127
      })
    ? normalized
    : undefined
}

function mergeById<Value extends { id: string }>(
  current: readonly Value[],
  next: readonly Value[],
): Value[] {
  return [
    ...new Map(
      [...current, ...next].map((value) => [
        value.id,
        value,
      ]),
    ).values(),
  ]
}

function mergeBacklinks(
  current: readonly DocumentBacklink[],
  next: readonly DocumentBacklink[],
): DocumentBacklink[] {
  return [
    ...new Map(
      [...current, ...next].map((backlink) => [
        `${backlink.documentId}:${backlink.relation.id}`,
        backlink,
      ]),
    ).values(),
  ]
}

function coalesceDocumentOperations(
  operations: readonly DocumentOperation[],
) {
  const coalesced: DocumentOperation[] = []
  const replaceableOperationIndex = new Map<string, number>()

  for (const operation of operations) {
    const key =
      operation.type === 'update-block'
        ? `block:${operation.block.id}`
        : operation.type === 'update-object'
          ? `object:${operation.object.id}`
          : operation.type === 'upsert-connector'
            ? `connector:${operation.connector.id}`
            : operation.type === 'upsert-frame'
              ? `frame:${operation.frame.id}`
              : undefined

    if (key && replaceableOperationIndex.has(key)) {
      coalesced[replaceableOperationIndex.get(key)!] = operation
    } else {
      if (key) {
        replaceableOperationIndex.set(key, coalesced.length)
      }
      coalesced.push(operation)
    }
  }

  return coalesced
}

function createPresenceClientId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `document-presence-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => globalThis.matchMedia?.(query).matches ?? false,
  )

  useEffect(() => {
    const mediaQuery = globalThis.matchMedia?.(query)
    if (!mediaQuery) return
    const handleChange = () => setMatches(mediaQuery.matches)
    handleChange()
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [query])

  return matches
}
