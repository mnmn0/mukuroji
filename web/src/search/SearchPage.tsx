import {
  createSearchWorkItemStatusKey,
  createSearchWorkItemTypeKey,
  DEFAULT_WORK_ITEM_TYPE,
  DEFAULT_WORK_ITEM_TYPE_ID,
  readSearchWorkItemTypeKey,
  SAVED_VIEW_SCHEMA_VERSION,
  type CreateSavedWorkspaceViewInput,
  type ResolvedWorkItemConfiguration,
  type SavedViewVisibility,
  type SavedWorkspaceView,
  type SearchCustomFieldFilter,
  type SearchEntityType,
  type SearchViewLayout,
  type SearchViewLayoutMode,
  type UpdateSavedWorkspaceViewInput,
  type WorkspaceSearchDateField,
  type WorkspaceSearchFilters,
  type WorkspaceSearchResult,
  type WorkItemTypeDefinition,
} from '@mukuroji/contracts'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { aiAssistanceUiEnabled } from '../features/ai-assistance/model/aiAssistanceRollout'
import { createMutationRequestRunner } from '../shared/api/mutationHeaders'
import { useCurrentUser } from '../auth/queries/useCurrentUser'
import { resolveEnterpriseSessionErrorsAction } from '../auth/enterpriseSessionErrors'
import { clearAuthSession, getAuthSession } from '../auth/session'
import {
  MobileSidebarButton,
  useWorkspaceSidebarController,
} from '../shared/ui/sidebar'
import {
  createTranslator,
  getInitialLocale,
  type Locale,
  type MessageKey,
} from '../shared/i18n/i18n'
import type { ProjectDirectoryTeam } from '../projects/api'
import { useProjectDirectory } from '../projects/queries/useProjectDirectory'
import {
  useTeamWorkItemConfigurations,
} from '../work-items/queries/useWorkItemConfigurations'
import { resolveWorkItemTypes } from '../work-items/model/workItemDisplay'
import {
  createSavedWorkspaceView,
  deleteSavedWorkspaceView,
  searchWorkspace,
  updateSavedWorkspaceView,
} from './api'
import {
  useSavedWorkspaceViews,
} from './queries/useSavedWorkspaceViews'
import {
  deduplicateSearchMigrationWarnings,
  getSearchColumns,
  getSearchCustomFields,
  getSearchDateField,
  getSearchDateValue,
  getSearchEntityTypes,
  getSearchFilterValues,
  getSearchGroup,
  getSearchKeyword,
  getSearchLayoutMode,
  getSearchSort,
  getSearchStatuses,
  parseSearchRouteState,
  serializeSearchRouteState,
  updateSearchRouteState,
  type SearchRouteState,
} from './model/queryState'
import { applyApprovedAiSearchToRouteStateIfCurrent } from './model/aiSearchApplication'
import { SearchResultCollection } from './ui/SearchResultCollection'
import {
  NaturalLanguageSearchComposer,
  type NaturalLanguageSearchComposerProps,
} from './ui/NaturalLanguageSearchComposer'
import { SearchCountReport } from './ui/SearchCountReport'
import { createSearchStatusOptions, type SearchStatusOption } from './model/statusOptions'
import { useOptionalWorkspaceRouteContext } from '../workspace/ui/WorkspaceRouteProvider'

/**
 * Saved view作成フォームの入力stateです。
 */
type SavedViewDraft = {
  /**
   * Saved viewの表示名です。
   */
  name: string
  /**
   * Saved viewの説明です。
   */
  description: string
  /**
   * Saved viewの共有範囲です。
   */
  visibility: SavedViewVisibility
  /**
   * Team visibilityで共有先にするTeam IDです。
   */
  teamId: string
}

const searchEntityTypes = ['work-item', 'project', 'team', 'comment', 'context-item', 'file', 'document'] as const satisfies readonly SearchEntityType[]
const searchLayoutModes = ['table', 'board', 'calendar', 'timeline'] as const satisfies readonly SearchViewLayoutMode[]
const searchCustomFieldOperators = [
  'equals',
  'not-equals',
  'contains',
  'greater-than',
  'greater-than-or-equal',
  'less-than',
  'less-than-or-equal',
  'is-empty',
  'is-not-empty',
] as const satisfies readonly SearchCustomFieldFilter['operator'][]
const savedViewVisibilities = ['personal', 'team', 'shared'] as const satisfies readonly SavedViewVisibility[]
const selectableColumns = ['type', 'workItemType', 'status', 'assignee', 'creator', 'project', 'team', 'dueDate', 'updatedAt'] as const
const emptyTeams: ProjectDirectoryTeam[] = []
const emptyResolvedWorkItemConfigurations: Record<string, ResolvedWorkItemConfiguration> = {}

/** One Team-qualified Work Item Type option shown by Workspace Search. */
type SearchWorkItemTypeOption = {
  /** Canonical filter value containing the owning Team and Work Item Type IDs. */
  filterValue: string
  /** Team that owns the configured Work Item Type. */
  teamId: string
  /** Configuration-derived or fallback Work Item Type definition. */
  type: WorkItemTypeDefinition
  /** Human-readable Team and Work Item Type label. */
  label: string
}

/**
 * Renders permission-aware Workspace search, saved views, and cursor pagination.
 *
 * @returns The Search route surface with optional AI-assisted review controls.
 */
export function SearchPage() {
  const workspaceContext = useOptionalWorkspaceRouteContext()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const [session] = useState(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])
  const [completedRouteSignature, setCompletedRouteSignature] = useState<string | undefined>()
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [isSearchLoading, setIsSearchLoading] = useState(false)
  const [nextPageLoadingSignature, setNextPageLoadingSignature] = useState<string | undefined>()
  const [searchErrorMessage, setSearchErrorMessage] = useState<string | undefined>()
  const [savedViewErrorMessage, setSavedViewErrorMessage] = useState<string | undefined>()
  const [authenticatedApiError, setAuthenticatedApiError] = useState<unknown>()
  const [isSavedViewFormOpen, setIsSavedViewFormOpen] = useState(false)
  const [savedViewDraft, setSavedViewDraft] = useState<SavedViewDraft>({
    description: '',
    name: '',
    teamId: '',
    visibility: 'personal',
  })
  const [deleteConfirmationViewId, setDeleteConfirmationViewId] = useState<string | undefined>()
  const activeRouteSignatureRef = useRef('')
  const [isAiOperationPending, setIsAiOperationPending] = useState(false)
  const isAiOperationPendingRef = useRef(false)
  const nextPageAbortControllerRef = useRef<AbortController | undefined>(undefined)
  const t = useMemo(() => createTranslator(locale), [locale])
  const { openMobileSidebar } = useWorkspaceSidebarController()
  const accessToken = session?.accessToken
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useCurrentUser(accessToken)
  const {
    data: teams = emptyTeams,
    error: projectDirectoryError,
    isLoading: isProjectDirectoryLoading,
  } = useProjectDirectory({
    accessToken,
    enabled: Boolean(user && !currentUserError),
    locale,
  })
  const {
    data: workItemConfigurationLoadResult,
    error: workItemConfigurationsError,
  } = useTeamWorkItemConfigurations(
    accessToken,
    'search',
    teams.map((team) => team.id).sort(),
    Boolean(user && !currentUserError && !isProjectDirectoryLoading),
  )
  const workItemConfigurationsByTeam = workItemConfigurationLoadResult?.configurationsByTeam ??
    emptyResolvedWorkItemConfigurations
  const {
    data: savedViews = [],
    error: savedViewsError,
    mutate: mutateSavedViews,
  } = useSavedWorkspaceViews(accessToken, Boolean(user && !currentUserError))
  const routeState = useMemo(
    () => parseSearchRouteState(searchParams),
    [searchParams],
  )
  const routeSignature = serializeSearchRouteState(routeState).toString()
  const isNextPageLoading = nextPageLoadingSignature === routeSignature
  const selectedSavedView = savedViews.find((view) => view.id === routeState.savedViewId)
  const migrationWarnings = deduplicateSearchMigrationWarnings(
    routeState.migrationWarnings,
    selectedSavedView ? formatSavedViewMigrationWarnings(selectedSavedView) : [],
  )
  const canWriteSavedViews = Boolean(user && user.workspaceRole !== 'guest')
  const canManageSharedViews = Boolean(
    user && (user.isSystemAdmin || user.workspaceRole === 'owner' || user.workspaceRole === 'admin'),
  )
  const currentUserErrorAction = resolveEnterpriseSessionErrorsAction(
    currentUserError,
    [
      projectDirectoryError,
      workItemConfigurationsError,
      ...(workItemConfigurationLoadResult?.errors ?? []),
      savedViewsError,
      authenticatedApiError,
    ],
    `${location.pathname}${location.search}${location.hash}`,
  )
  const isLoading = !session || isCurrentUserLoading || Boolean(user && isProjectDirectoryLoading)
  const userLabel = user?.attributes.email ?? user?.attributes.name ?? user?.username ?? t('workspace.user.fallback')
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || 'M'
  const statusOptions = useMemo(() => createSearchStatusOptions(
    workItemConfigurationsByTeam,
    [
      ...getSearchStatuses(routeState.filters),
      ...results.flatMap((result) => result.status
        ? [result.entityType === 'work-item' && result.teamId
          ? createSearchWorkItemStatusKey(
              result.teamId,
              result.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID,
              result.status,
            )
          : result.status]
        : []),
    ],
    Object.fromEntries(teams.map((team) => [team.id, team.name])),
  ), [results, routeState.filters, teams, workItemConfigurationsByTeam])
  const statusLabels = useMemo(
    () => Object.fromEntries(statusOptions.map((status) => [status.id, status.label])),
    [statusOptions],
  )
  const workItemTypes = useMemo<SearchWorkItemTypeOption[]>(() => {
    const teamNamesById = new Map(teams.map((team) => [team.id, team.name]))
    const optionsByFilterValue = new Map<string, SearchWorkItemTypeOption>()
    for (const team of teams) {
      const resolvedConfiguration = workItemConfigurationsByTeam[team.id]
      const types = resolvedConfiguration
        ? resolveWorkItemTypes(resolvedConfiguration)
        : [DEFAULT_WORK_ITEM_TYPE]
      for (const type of types) {
        const filterValue = createSearchWorkItemTypeKey(team.id, type.id)
        optionsByFilterValue.set(filterValue, {
          filterValue,
          label: `${team.name} · ${type.name}`,
          teamId: team.id,
          type,
        })
      }
    }
    const visibleFilterValues = [
      ...getSearchFilterValues(routeState.filters, 'workItemTypeIds'),
      ...results
        .filter((result) => result.entityType === 'work-item' && result.teamId)
        .map((result) => createSearchWorkItemTypeKey(
          result.teamId ?? '',
          result.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE.id,
        )),
    ]
    for (const filterValue of visibleFilterValues) {
      const parts = readSearchWorkItemTypeKey(filterValue)
      if (!parts || optionsByFilterValue.has(filterValue)) continue
      const type: WorkItemTypeDefinition = {
        ...DEFAULT_WORK_ITEM_TYPE,
        id: parts.workItemTypeId,
        name: parts.workItemTypeId,
        sortOrder: Number.MAX_SAFE_INTEGER,
      }
      const teamName = teamNamesById.get(parts.teamId) ?? parts.teamId
      optionsByFilterValue.set(filterValue, {
        filterValue,
        label: `${teamName} · ${type.name}`,
        teamId: parts.teamId,
        type,
      })
    }
    return [...optionsByFilterValue.values()].sort((left, right) =>
      left.label.localeCompare(right.label) || left.filterValue.localeCompare(right.filterValue),
    )
  }, [results, routeState.filters, teams, workItemConfigurationsByTeam])
  const workItemTypeLabels = useMemo(
    () => Object.fromEntries(workItemTypes.map((option) => [option.filterValue, option.label])),
    [workItemTypes],
  )
  const visibleSearchErrorMessage = currentUserErrorAction?.kind === 'stay'
    ? t('search.error')
    : searchErrorMessage

  useLayoutEffect(() => {
    activeRouteSignatureRef.current = routeSignature
    nextPageAbortControllerRef.current?.abort()
    nextPageAbortControllerRef.current = undefined

    return () => {
      nextPageAbortControllerRef.current?.abort()
    }
  }, [routeSignature])

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${t('search.title')} | ${t('app.title')}`
  }, [locale, t])

  useEffect(() => {
    if (!session) {
      navigate('/', { replace: true })
    }
  }, [navigate, session])

  useEffect(() => {
    if (currentUserErrorAction?.redirectTo) {
      if (currentUserErrorAction.clearSession) {
        clearAuthSession()
      }
      navigate(currentUserErrorAction.redirectTo, { replace: true })
    }
  }, [
    currentUserErrorAction?.clearSession,
    currentUserErrorAction?.redirectTo,
    navigate,
  ])

  useEffect(() => {
    if (!accessToken || !user || currentUserError) {
      return undefined
    }

    const abortController = new AbortController()
    const timeoutId = window.setTimeout(() => {
      setIsSearchLoading(true)
      setSearchErrorMessage(undefined)
      setAuthenticatedApiError(undefined)
      void searchWorkspace(accessToken, routeState.filters, {
        limit: 30,
        signal: abortController.signal,
      })
        .then((response) => {
          setResults(response.results)
          setNextCursor(response.nextCursor)
          setCompletedRouteSignature(routeSignature)
        })
        .catch((error: unknown) => {
          if (!abortController.signal.aborted) {
            setAuthenticatedApiError(() => error)
            setResults([])
            setNextCursor(undefined)
            setCompletedRouteSignature(undefined)
            setSearchErrorMessage(error instanceof Error ? error.message : t('search.error'))
          }
        })
        .finally(() => {
          if (!abortController.signal.aborted) {
            setIsSearchLoading(false)
          }
        })
    }, 180)

    return () => {
      window.clearTimeout(timeoutId)
      abortController.abort()
    }
  }, [accessToken, currentUserError, routeSignature, routeState.filters, t, user])

  useEffect(() => {
    if (!routeState.savedViewId || !selectedSavedView || hasExplicitSearchState(searchParams)) {
      return
    }

    setSearchParams(serializeSearchRouteState({
      filters: selectedSavedView.filters,
      layout: selectedSavedView.layout,
      migrationWarnings: formatSavedViewMigrationWarnings(selectedSavedView),
      savedViewId: selectedSavedView.id,
    }), { replace: true })
  }, [routeState.savedViewId, searchParams, selectedSavedView, setSearchParams])

  useEffect(() => {
    if (searchParams.toString() || savedViews.length === 0) {
      return
    }

    const defaultView = savedViews.find((view) => view.isDefault)
    if (defaultView) {
      setSearchParams(serializeSearchRouteState({
        filters: defaultView.filters,
        layout: defaultView.layout,
        migrationWarnings: formatSavedViewMigrationWarnings(defaultView),
        savedViewId: defaultView.id,
      }), { replace: true })
    }
  }, [savedViews, searchParams, setSearchParams])

  const commitRouteState = (nextState: SearchRouteState) => {
    if (isAiOperationPendingRef.current) return
    setSearchParams(serializeSearchRouteState(nextState), { replace: true })
  }

  const updateFilters = (patch: Record<string, unknown>) => {
    if (isAiOperationPendingRef.current) return
    commitRouteState(updateSearchRouteState(routeState, {
      filters: {
        ...asRecord(routeState.filters),
        ...patch,
      } as WorkspaceSearchFilters,
    }))
  }

  const updateLayout = (patch: Record<string, unknown>) => {
    if (isAiOperationPendingRef.current) return
    commitRouteState(updateSearchRouteState(routeState, {
      layout: {
        ...asRecord(routeState.layout),
        ...patch,
      } as SearchViewLayout,
    }))
  }

  const loadNextPage = async () => {
    if (!accessToken || !nextCursor || isNextPageLoading) {
      return
    }

    const requestRouteSignature = routeSignature
    const abortController = new AbortController()
    nextPageAbortControllerRef.current?.abort()
    nextPageAbortControllerRef.current = abortController
    setNextPageLoadingSignature(requestRouteSignature)
    setSearchErrorMessage(undefined)
    setAuthenticatedApiError(undefined)
    try {
      const response = await searchWorkspace(accessToken, routeState.filters, {
        cursor: nextCursor,
        limit: 30,
        signal: abortController.signal,
      })

      if (abortController.signal.aborted || activeRouteSignatureRef.current !== requestRouteSignature) {
        return
      }

      setResults((currentResults) => mergeSearchResults(currentResults, response.results))
      setNextCursor(response.nextCursor)
    } catch (error) {
      if (!abortController.signal.aborted && activeRouteSignatureRef.current === requestRouteSignature) {
        setAuthenticatedApiError(() => error)
        setSearchErrorMessage(error instanceof Error ? error.message : t('search.error'))
      }
    } finally {
      if (nextPageAbortControllerRef.current === abortController) {
        nextPageAbortControllerRef.current = undefined
        setNextPageLoadingSignature(undefined)
      }
    }
  }

  const saveCurrentView = async () => {
    if (
      isAiOperationPendingRef.current ||
      !accessToken ||
      !savedViewDraft.name.trim() ||
      (savedViewDraft.visibility === 'team' && !savedViewDraft.teamId)
    ) {
      return
    }

    setSavedViewErrorMessage(undefined)
    setAuthenticatedApiError(undefined)
    const input = {
      description: savedViewDraft.description.trim() || undefined,
      filters: routeState.filters,
      layout: routeState.layout,
      name: savedViewDraft.name.trim(),
      teamId: savedViewDraft.visibility === 'team'
        ? savedViewDraft.teamId || undefined
        : undefined,
      visibility: savedViewDraft.visibility,
    } as CreateSavedWorkspaceViewInput

    try {
      const view = await mutationRequestRunner.run(
        'saved-view:create',
        JSON.stringify(input),
        (context) => createSavedWorkspaceView(accessToken, input, context),
      )
      await mutateSavedViews()
      setIsSavedViewFormOpen(false)
      setSavedViewDraft({ description: '', name: '', teamId: '', visibility: 'personal' })
      commitRouteState({
        ...routeState,
        savedViewId: view.id,
      })
    } catch (error) {
      setAuthenticatedApiError(() => error)
      setSavedViewErrorMessage(error instanceof Error ? error.message : t('search.error'))
    }
  }

  const patchSavedView = async (view: SavedWorkspaceView, patch: Record<string, unknown>) => {
    if (isAiOperationPendingRef.current || !accessToken) {
      return
    }

    setSavedViewErrorMessage(undefined)
    setAuthenticatedApiError(undefined)
    const input = {
      expectedRevision: view.revision,
      ...patch,
    } as UpdateSavedWorkspaceViewInput

    try {
      await mutationRequestRunner.run(
        `saved-view:update:${view.id}`,
        JSON.stringify(input),
        (context) => updateSavedWorkspaceView(accessToken, view.id, input, context),
      )
      await mutateSavedViews()
    } catch (error) {
      setAuthenticatedApiError(() => error)
      setSavedViewErrorMessage(error instanceof Error ? error.message : t('search.error'))
    }
  }

  const removeSavedView = async (view: SavedWorkspaceView) => {
    if (isAiOperationPendingRef.current || !accessToken) {
      return
    }

    setSavedViewErrorMessage(undefined)
    setAuthenticatedApiError(undefined)
    try {
      await mutationRequestRunner.run(
        `saved-view:delete:${view.id}`,
        String(view.revision),
        (context) => deleteSavedWorkspaceView(accessToken, view.id, view.revision, context),
      )
      await mutateSavedViews()
      setDeleteConfirmationViewId(undefined)
      if (routeState.savedViewId === view.id) {
        commitRouteState({ ...routeState, savedViewId: undefined })
      }
    } catch (error) {
      setAuthenticatedApiError(() => error)
      setSavedViewErrorMessage(error instanceof Error ? error.message : t('search.error'))
    }
  }

  const selectSavedView = (view: SavedWorkspaceView) => {
    if (isAiOperationPendingRef.current) return
    commitRouteState({
      filters: view.filters,
      layout: view.layout,
      migrationWarnings: formatSavedViewMigrationWarnings(view),
      savedViewId: view.id,
    })
  }

  /** Keeps Search route controls fenced while an AI operation is pending. */
  const reportAiOperationPending = (pending: boolean) => {
    isAiOperationPendingRef.current = pending
    setIsAiOperationPending(pending)
  }

  /** Navigates to a Search result only when no AI operation is in flight. */
  const navigateToSearchResult = (path: string) => {
    if (isAiOperationPendingRef.current) return
    navigate(path)
  }

  return (
    <>
        <header className="workbench-header flex-none px-[clamp(20px,3vw,34px)] py-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <MobileSidebarButton label={t('sidebar.mobileOpen')} onClick={openMobileSidebar} />
              <div className="min-w-0">
                <p className="workbench-eyebrow">{t('search.eyebrow')}</p>
                <h1 className="workbench-title mt-2 text-page-title">{t('search.title')}</h1>
                <p className="workbench-description mt-2 max-w-[760px]">{t('search.description')}</p>
              </div>
            </div>
            <div className="flex flex-none items-center gap-3">
              <div className="hidden text-right min-[721px]:block">
                <p className="max-w-[220px] truncate text-sm font-semibold text-[var(--workbench-text)]">{userLabel}</p>
              </div>
              <div className="grid h-10 w-10 place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-sm font-semibold text-[var(--workbench-primary)]">
                {userInitial}
              </div>
              <button
                className="workbench-button-secondary min-h-10 px-4"
                onClick={() => {
                  clearAuthSession()
                  navigate('/', { replace: true })
                }}
                type="button"
              >
                {t('dashboard.logout')}
              </button>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-sm font-semibold text-[var(--workbench-muted)]">
            {t('workspace.loading')}
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <div className="grid grid-cols-[250px_minmax(0,1fr)] gap-5 px-[clamp(20px,3vw,34px)] py-5 max-[1080px]:grid-cols-1">
              <SavedViewsPanel
                canManageShared={canManageSharedViews}
                canWrite={canWriteSavedViews}
                deleteConfirmationViewId={deleteConfirmationViewId}
                draft={savedViewDraft}
                errorMessage={savedViewErrorMessage ?? (savedViewsError ? t('search.error') : undefined)}
                isFormOpen={isSavedViewFormOpen}
                isAiOperationPending={isAiOperationPending}
                selectedViewId={routeState.savedViewId}
                t={t}
                teams={teams}
                views={savedViews}
                onClone={(view) => {
                  setSavedViewDraft({
                    description: view.description ?? '',
                    name: t('search.saved.copyName').replace('{name}', view.name),
                    teamId: '',
                    visibility: 'personal',
                  })
                  setIsSavedViewFormOpen(true)
                }}
                onDelete={removeSavedView}
                onDeleteConfirmationChange={setDeleteConfirmationViewId}
                onDraftChange={setSavedViewDraft}
                onFormOpenChange={setIsSavedViewFormOpen}
                onPatch={patchSavedView}
                onSave={saveCurrentView}
                onSelect={selectSavedView}
              />

              <div className="grid min-w-0 content-start gap-4">
                <SearchToolbar
                  accessToken={accessToken}
                  aiAssistanceEnabled={workspaceContext?.isAiAssistanceTaskEnabled?.('search') ?? aiAssistanceUiEnabled}
                  locale={locale}
                  onAuthenticatedApiError={setAuthenticatedApiError}
                  isAiOperationPending={isAiOperationPending}
                  onAiOperationPendingChange={reportAiOperationPending}
                  onAiFiltersApply={(application, expectedRouteSignature) => {
                    const nextRouteState = applyApprovedAiSearchToRouteStateIfCurrent(
                      routeState,
                      expectedRouteSignature,
                      activeRouteSignatureRef.current,
                      application,
                    )
                    if (nextRouteState) commitRouteState(nextRouteState)
                  }}
                  onFiltersChange={updateFilters}
                  onLayoutChange={updateLayout}
                  onUpdateSelectedView={selectedSavedView?.canEdit
                    ? () => patchSavedView(selectedSavedView, {
                        filters: routeState.filters,
                        layout: routeState.layout,
                      })
                    : undefined}
                  routeSignature={routeSignature}
                  routeState={routeState}
                  selectedSavedView={selectedSavedView}
                  statusOptions={statusOptions}
                  workItemTypes={workItemTypes}
                  t={t}
                />
                {migrationWarnings.map((warning) => (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800" key={warning} role="status">
                    {t('search.saved.migration')} {warning}
                  </p>
                ))}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-[var(--workbench-muted)]" role="status">
                    {t('search.resultsMeta').replace('{count}', String(results.length))}
                  </p>
                  {selectedSavedView ? (
                    <span className="workbench-badge-primary">
                      {selectedSavedView.name}
                    </span>
                  ) : null}
                </div>
                {visibleSearchErrorMessage ? (
                  <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
                    {currentUserErrorAction?.kind === 'stay'
                      ? visibleSearchErrorMessage
                      : `${t('search.error')} ${visibleSearchErrorMessage}`}
                  </p>
                ) : null}
                {routeState.reportMetric === 'count' &&
                completedRouteSignature === routeSignature &&
                !isSearchLoading &&
                !visibleSearchErrorMessage ? (
                  <SearchCountReport
                    groupBy={getSearchGroup(routeState.layout) || undefined}
                    hasMore={Boolean(nextCursor)}
                    results={results}
                    t={t}
                    workItemTypeLabels={workItemTypeLabels}
                  />
                ) : null}
                {isSearchLoading ? (
                  <SearchLoadingState t={t} />
                ) : results.length > 0 ? (
                  <SearchResultCollection
                    isAiOperationPending={isAiOperationPending}
                    layout={routeState.layout}
                    locale={locale}
                    onNavigate={navigateToSearchResult}
                    results={results}
                    statusLabels={statusLabels}
                    workItemTypeLabels={workItemTypeLabels}
                  />
                ) : !visibleSearchErrorMessage ? (
                  <section className="workbench-panel px-6 py-14 text-center">
                    <h2 className="text-base font-semibold text-[var(--workbench-text)]">{t('search.emptyTitle')}</h2>
                    <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">{t('search.emptyDescription')}</p>
                  </section>
                ) : null}
                {nextCursor ? (
                  <button
                    className="workbench-button-secondary min-h-10 justify-self-center px-5"
                    disabled={isNextPageLoading}
                    onClick={() => void loadNextPage()}
                    type="button"
                  >
                    {isNextPageLoading ? t('search.pagination.loading') : t('search.pagination.more')}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        )}
    </>
  )
}

/** Props for the canonical Search controls and optional AI-assisted mode. */
type SearchToolbarProps = {
  /** Whether the deployment and Workspace policy expose AI Search. */
  aiAssistanceEnabled?: boolean
  /** Whether Search route controls are fenced during an AI operation. */
  isAiOperationPending?: boolean
  /** Active Workspace member bearer token. */
  accessToken?: string
  /** Reports authenticated API failures to the route session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Locale used for labels and generated metadata. */
  locale: Locale
  /** Applies an approved AI Search draft after route freshness validation. */
  onAiFiltersApply: NaturalLanguageSearchComposerProps['onApply']
  /** Reports AI operation state so Search can fence route mutations. */
  onAiOperationPendingChange?: (pending: boolean) => void
  /** Applies a patch to the canonical Search filters. */
  onFiltersChange: (patch: Record<string, unknown>) => void
  /** Applies a patch to the canonical Search layout. */
  onLayoutChange: (patch: Record<string, unknown>) => void
  /** Refreshes the selected saved view after a successful edit. */
  onUpdateSelectedView?: () => void
  /** Current canonical Search route state. */
  routeState: SearchRouteState
  /** Stable signature used to fence an AI generation against route changes. */
  routeSignature: string
  /** Selected saved view, when one is active. */
  selectedSavedView?: SavedWorkspaceView
  /** Server-authorized workflow status options. */
  statusOptions: readonly SearchStatusOption[]
  /** Team-qualified Work Item Types available in the visible Team configurations. */
  workItemTypes: readonly SearchWorkItemTypeOption[]
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders the canonical Search controls and the optional AI-assisted mode.
 *
 * @param props - Route state, permissions, callbacks, and localized labels.
 * @returns Search toolbar controls with optional natural-language review.
 */
function SearchToolbar({
  aiAssistanceEnabled = true,
  accessToken,
  isAiOperationPending = false,
  locale,
  onAuthenticatedApiError,
  onAiFiltersApply,
  onAiOperationPendingChange,
  onFiltersChange,
  onLayoutChange,
  onUpdateSelectedView,
  routeState,
  routeSignature,
  selectedSavedView,
  statusOptions,
  workItemTypes,
  t,
}: SearchToolbarProps) {
  const entityTypes = getSearchEntityTypes(routeState.filters)
  const statuses = getSearchStatuses(routeState.filters)
  const selectedWorkItemTypeIds = getSearchFilterValues(routeState.filters, 'workItemTypeIds')
  const columns = getSearchColumns(routeState.layout)
  const routeDateField = getSearchDateField(routeState.filters)
  const [dateFieldOverride, setDateFieldOverride] = useState<{
    routeSignature: string
    value: WorkspaceSearchDateField
  }>()
  const [inputMode, setInputMode] = useState<'keyword' | 'plain-language'>('keyword')
  const dateField = dateFieldOverride?.routeSignature === routeSignature
    ? dateFieldOverride.value
    : routeDateField

  return (
    <section className="workbench-toolbar grid gap-4 p-4" data-testid="search-toolbar">
      {aiAssistanceEnabled ? <div
        aria-label={t('ai.search.mode')}
        className="flex w-fit max-w-full gap-1 rounded-lg border border-[var(--workbench-border-strong)] bg-white p-1"
        role="group"
      >
        <button
          aria-pressed={inputMode === 'keyword'}
          className={`min-h-[44px] rounded-md px-4 text-app-caption font-semibold transition ${
            inputMode === 'keyword'
              ? 'bg-[var(--workbench-primary)] text-white'
              : 'text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'
          }`}
          disabled={isAiOperationPending}
          onClick={() => setInputMode('keyword')}
          type="button"
        >
          {t('ai.search.mode.keyword')}
        </button>
        <button
          aria-pressed={inputMode === 'plain-language'}
          className={`min-h-[44px] rounded-md px-4 text-app-caption font-semibold transition ${
            inputMode === 'plain-language'
              ? 'bg-[var(--workbench-primary)] text-white'
              : 'text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'
          }`}
          disabled={isAiOperationPending}
          onClick={() => setInputMode('plain-language')}
          type="button"
        >
          {t('ai.search.mode.plainLanguage')}
        </button>
      </div> : null}

      {aiAssistanceEnabled ? (
        <div
          aria-hidden={inputMode !== 'plain-language'}
          className={inputMode === 'plain-language' ? undefined : 'hidden'}
        >
          <NaturalLanguageSearchComposer
            accessToken={accessToken}
            locale={locale}
            onAuthenticatedApiError={onAuthenticatedApiError}
            onApply={onAiFiltersApply}
            onOperationPendingChange={onAiOperationPendingChange}
            routeSignature={routeSignature}
            t={t}
          />
        </div>
      ) : null}

      <div
        aria-hidden={aiAssistanceEnabled && inputMode === 'plain-language'}
        className={aiAssistanceEnabled && inputMode === 'plain-language' ? 'hidden' : undefined}
      >
        <fieldset className="contents" disabled={isAiOperationPending}>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <label className="relative min-w-[260px] flex-1">
          <span className="sr-only">{t('search.input.label')}</span>
          <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--workbench-muted)]">⌕</span>
          <input
            aria-label={t('search.input.label')}
            className="workbench-input min-h-11 w-full pl-10 pr-3"
            data-testid="workspace-search-input"
            onChange={(event) => onFiltersChange({ keyword: event.target.value || undefined })}
            placeholder={t('search.input.placeholder')}
            type="search"
            value={getSearchKeyword(routeState.filters)}
          />
        </label>
        {onUpdateSelectedView && selectedSavedView ? (
          <button className="workbench-button-primary min-h-10 px-4" onClick={onUpdateSelectedView} type="button">
            {t('search.saved.update')}
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label={t('search.filters.types')}>
        {searchEntityTypes.map((type) => (
          <ToggleChip
            active={entityTypes.includes(type)}
            key={type}
            label={t(`search.entity.${type}`)}
            onToggle={() => onFiltersChange({
              entityTypes: toggleValue(entityTypes, type),
            })}
          />
        ))}
      </div>

      <details className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3">
        <summary className="cursor-pointer text-sm font-semibold text-[var(--workbench-text)]">{t('search.filters.title')}</summary>
        <div className="mt-4 grid gap-4">
          <div className="grid gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{t('search.filters.status')}</span>
            <div className="flex flex-wrap gap-2">
              {statusOptions.map((status) => (
                <ToggleChip
                  active={statuses.includes(status.id)}
                  key={status.id}
                  label={status.label}
                  onToggle={() => onFiltersChange({ statuses: toggleValue(statuses, status.id) })}
                />
              ))}
            </div>
          </div>
          <div className="grid gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{t('search.filters.workItemType')}</span>
            <div className="flex flex-wrap gap-2">
              {workItemTypes.map((option) => (
                <ToggleChip
                  active={selectedWorkItemTypeIds.includes(option.filterValue)}
                  key={option.filterValue}
                  label={option.label}
                  onToggle={() => onFiltersChange({
                    workItemTypeIds: toggleValue(selectedWorkItemTypeIds, option.filterValue),
                  })}
                />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
            <CommaSeparatedInput filterKey="assigneeUserIds" label={t('search.filters.assignee')} routeState={routeState} onFiltersChange={onFiltersChange} />
            <CommaSeparatedInput filterKey="creatorUserIds" label={t('search.filters.creator')} routeState={routeState} onFiltersChange={onFiltersChange} />
            <CommaSeparatedInput filterKey="teamIds" label={t('search.filters.team')} routeState={routeState} onFiltersChange={onFiltersChange} />
            <CommaSeparatedInput filterKey="projectIds" label={t('search.filters.project')} routeState={routeState} onFiltersChange={onFiltersChange} />
            <CommaSeparatedInput filterKey="relationIds" label={t('search.filters.relation')} routeState={routeState} onFiltersChange={onFiltersChange} />
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
              {t('search.filters.dateField')}
              <select
                className="workbench-input min-h-10 px-3 normal-case tracking-normal"
                onChange={(event) => {
                  const nextDateField: WorkspaceSearchDateField = event.target.value === 'createdAt'
                    ? 'createdAt'
                    : event.target.value === 'dueDate'
                      ? 'dueDate'
                      : 'updatedAt'
                  const currentDate = asRecord(asRecord(routeState.filters).date)
                  setDateFieldOverride({ routeSignature, value: nextDateField })
                  if (currentDate.from || currentDate.to) {
                    onFiltersChange({ date: { ...currentDate, field: nextDateField } })
                  }
                }}
                value={dateField}
              >
                <option value="updatedAt">{t('search.columns.updatedAt')}</option>
                <option value="createdAt">{t('search.columns.createdAt')}</option>
                <option value="dueDate">{t('tasks.column.dueDate')}</option>
              </select>
            </label>
            <DateInput dateField={dateField} filterKey="dateFrom" label={t('search.filters.dateFrom')} routeState={routeState} onFiltersChange={onFiltersChange} />
            <DateInput dateField={dateField} filterKey="dateTo" label={t('search.filters.dateTo')} routeState={routeState} onFiltersChange={onFiltersChange} />
          </div>
          <CustomFieldFilterBuilder
            filters={getSearchCustomFields(routeState.filters)}
            onChange={(customFields) => onFiltersChange({ customFields })}
            t={t}
          />
          <button
            className="workbench-button-secondary min-h-9 justify-self-start px-3"
            onClick={() => onFiltersChange({
              assigneeUserIds: [],
              creatorUserIds: [],
              customFields: [],
              date: undefined,
              entityTypes: [],
              projectIds: [],
              relationIds: [],
              statuses: [],
              teamIds: [],
              workItemTypeIds: [],
            })}
            type="button"
          >
            {t('search.filters.reset')}
          </button>
        </div>
      </details>

      <div className="grid grid-cols-[auto_minmax(170px,auto)_minmax(130px,1fr)] items-end gap-3 max-[720px]:grid-cols-1">
        <div className="flex flex-wrap gap-1 rounded-lg border border-[var(--workbench-border-strong)] bg-white p-1" role="group" aria-label={t('search.layout.label')}>
          {searchLayoutModes.map((mode) => (
            <button
              aria-pressed={getSearchLayoutMode(routeState.layout) === mode}
              className={`min-h-8 rounded-md px-3 text-xs font-semibold transition ${
                getSearchLayoutMode(routeState.layout) === mode
                  ? 'bg-[var(--workbench-primary)] text-white'
                  : 'text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'
              }`}
              key={mode}
              onClick={() => onLayoutChange({ mode })}
              type="button"
            >
              {t(`search.layout.${mode}`)}
            </button>
          ))}
        </div>
        <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {t('search.sort.label')}
          <select
            className="workbench-input min-h-9 px-3 normal-case tracking-normal"
            onChange={(event) => {
              const [field, direction] = event.target.value.split(':')
              onLayoutChange({ sort: [{ field, direction }] })
            }}
            value={getSearchSort(routeState.layout)}
          >
            <option value="relevance:desc">{t('search.sort.relevance')} ↓</option>
            <option value="updatedAt:desc">{t('search.columns.updatedAt')} ↓</option>
            <option value="dueDate:asc">{t('tasks.column.dueDate')} ↑</option>
            <option value="createdAt:desc">{t('search.columns.createdAt')} ↓</option>
          </select>
        </label>
        <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {t('search.group.label')}
          <input
            className="workbench-input min-h-9 px-3 normal-case tracking-normal"
            onChange={(event) => onLayoutChange({ groupBy: event.target.value || undefined })}
            placeholder="status / teamId / projectId"
            value={getSearchGroup(routeState.layout)}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('search.columns.label')}>
        {selectableColumns.map((column) => (
          <ToggleChip
            active={columns.includes(column)}
            key={column}
            label={formatSelectableColumnLabel(column, t)}
            onToggle={() => onLayoutChange({ columns: toggleValue(columns, column) })}
          />
        ))}
      </div>
        </fieldset>
      </div>
    </section>
  )
}

function SavedViewsPanel({
  canManageShared,
  canWrite,
  deleteConfirmationViewId,
  draft,
  errorMessage,
  isAiOperationPending,
  isFormOpen,
  onClone,
  onDelete,
  onDeleteConfirmationChange,
  onDraftChange,
  onFormOpenChange,
  onPatch,
  onSave,
  onSelect,
  selectedViewId,
  t,
  teams,
  views,
}: {
  canManageShared: boolean
  canWrite: boolean
  deleteConfirmationViewId?: string
  draft: SavedViewDraft
  errorMessage?: string
  isAiOperationPending?: boolean
  isFormOpen: boolean
  onClone: (view: SavedWorkspaceView) => void
  onDelete: (view: SavedWorkspaceView) => Promise<void>
  onDeleteConfirmationChange: (viewId?: string) => void
  onDraftChange: (draft: SavedViewDraft) => void
  onFormOpenChange: (isOpen: boolean) => void
  onPatch: (view: SavedWorkspaceView, patch: Record<string, unknown>) => Promise<void>
  onSave: () => Promise<void>
  onSelect: (view: SavedWorkspaceView) => void
  selectedViewId?: string
  t: (key: MessageKey) => string
  teams: ProjectDirectoryTeam[]
  views: SavedWorkspaceView[]
}) {
  const sortedViews = [...views].sort((left, right) =>
    Number(right.pinned) - Number(left.pinned) ||
    Number(right.favorite) - Number(left.favorite) ||
    left.name.localeCompare(right.name),
  )

  return (
    <aside className="grid content-start gap-4">
      <fieldset className="contents" disabled={isAiOperationPending}>
      <section className="workbench-panel overflow-hidden">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--workbench-text)]">{t('search.saved.title')}</h2>
          {canWrite ? (
            <button
              aria-expanded={isFormOpen}
              className="grid h-8 w-8 place-items-center rounded-lg text-lg text-[var(--workbench-primary)] transition hover:bg-[#e5f7f4]"
              onClick={() => onFormOpenChange(!isFormOpen)}
              type="button"
            >
              <span aria-hidden="true">+</span>
              <span className="sr-only">{t('search.saved.new')}</span>
            </button>
          ) : null}
        </header>
        <div className="grid gap-1 p-2" data-testid="saved-view-list">
          {sortedViews.map((view) => (
            <div className={`rounded-lg border p-2 ${selectedViewId === view.id ? 'border-[#99d7cf] bg-[#e5f7f4]' : 'border-transparent'}`} key={view.id}>
              <button className="w-full px-1 py-1 text-left" onClick={() => onSelect(view)} type="button">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-[var(--workbench-text)]">{view.name}</span>
                  {view.pinned || view.favorite ? (
                    <span
                      aria-label={view.pinned ? t('search.saved.pinned') : t('search.saved.favorites')}
                      className="text-xs text-[var(--workbench-primary)]"
                      role="img"
                    >
                      {view.pinned ? '●' : '★'}
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
                  {t(`search.saved.${view.visibility}`)}{view.isDefault ? ` · ${t('search.saved.default')}` : ''}
                </span>
              </button>
              {selectedViewId === view.id && (canWrite || view.canEdit) ? (
                <div className="mt-2 flex flex-wrap gap-1 border-t border-[#99d7cf]/50 pt-2">
                  {canWrite ? (
                    <>
                      <SmallAction label={t('search.saved.favorite')} onClick={() => void onPatch(view, { favorite: !view.favorite })} pressed={view.favorite} />
                      <SmallAction label={t('search.saved.pin')} onClick={() => void onPatch(view, { pinned: !view.pinned })} pressed={view.pinned} />
                      <SmallAction label={t('search.saved.makeDefault')} onClick={() => void onPatch(view, { isDefault: true })} pressed={view.isDefault} />
                      <SmallAction label={t('search.saved.clone')} onClick={() => onClone(view)} />
                    </>
                  ) : null}
                  {view.canEdit ? deleteConfirmationViewId === view.id ? (
                    <>
                      <SmallAction label={t('sidebar.archive.cancel')} onClick={() => onDeleteConfirmationChange(undefined)} />
                      <SmallAction danger label={t('search.saved.delete')} onClick={() => void onDelete(view)} />
                    </>
                  ) : (
                    <SmallAction danger label={t('search.saved.delete')} onClick={() => onDeleteConfirmationChange(view.id)} />
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
          {views.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs font-semibold text-[var(--workbench-muted)]">{t('search.saved.empty')}</p>
          ) : null}
        </div>
      </section>
      {canWrite && isFormOpen ? (
        <section className="workbench-panel grid gap-3 p-4" data-testid="saved-view-form">
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('search.saved.name')}
            <input className="workbench-input min-h-10 px-3" onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} value={draft.name} />
          </label>
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('search.saved.description')}
            <textarea className="workbench-input min-h-20 resize-y px-3 py-2" onChange={(event) => onDraftChange({ ...draft, description: event.target.value })} value={draft.description} />
          </label>
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('search.saved.visibility')}
            <select className="workbench-input min-h-10 px-3" onChange={(event) => onDraftChange({ ...draft, visibility: event.target.value as SavedViewVisibility })} value={draft.visibility}>
              {savedViewVisibilities
                .filter((visibility) => visibility !== 'shared' || canManageShared)
                .map((visibility) => <option key={visibility} value={visibility}>{t(`search.saved.${visibility}`)}</option>)}
            </select>
          </label>
          {draft.visibility === 'team' ? (
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('search.filters.team')}
              <select className="workbench-input min-h-10 px-3" onChange={(event) => onDraftChange({ ...draft, teamId: event.target.value })} value={draft.teamId}>
                <option value="">{t('search.filters.team')}</option>
                {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            </label>
          ) : null}
          <button
            className="workbench-button-primary min-h-10 px-4"
            disabled={!draft.name.trim() || (draft.visibility === 'team' && !draft.teamId)}
            onClick={() => void onSave()}
            type="button"
          >
            {t('search.saved.save')}
          </button>
          {errorMessage ? <p className="text-xs font-semibold text-red-700" role="alert">{errorMessage}</p> : null}
        </section>
      ) : errorMessage ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700" role="alert">{errorMessage}</p>
      ) : null}
      </fieldset>
    </aside>
  )
}

function CustomFieldFilterBuilder({
  filters,
  onChange,
  t,
}: {
  filters: SearchCustomFieldFilter[]
  onChange: (filters: SearchCustomFieldFilter[]) => void
  t: (key: MessageKey) => string
}) {
  const [draftFieldId, setDraftFieldId] = useState('')
  const [draftOperator, setDraftOperator] = useState<SearchCustomFieldFilter['operator']>('equals')
  const [draftValue, setDraftValue] = useState('')

  const updateFilter = (index: number, patch: Partial<SearchCustomFieldFilter>) => {
    onChange(filters.map((filter, filterIndex) => filterIndex === index
      ? (() => {
          const nextFilter = { ...filter, ...patch }
          if (Object.hasOwn(patch, 'value') && patch.value === undefined) {
            delete nextFilter.value
          }
          return nextFilter
        })()
      : filter))
  }

  return (
    <fieldset className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-white p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
        {t('search.filters.customField')}
      </legend>
      {filters.map((filter, index) => {
        const doesNotNeedValue = filter.operator === 'is-empty' || filter.operator === 'is-not-empty'

        return (
          <div className="grid grid-cols-[minmax(120px,1fr)_minmax(170px,0.8fr)_minmax(120px,1fr)_auto] items-end gap-2 max-[760px]:grid-cols-1" key={`${filter.fieldId}-${index}`}>
            <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
              {t('search.filters.customFieldId')}
              <input
                className="workbench-input min-h-9 px-3"
                onChange={(event) => updateFilter(index, { fieldId: event.target.value })}
                value={filter.fieldId}
              />
            </label>
            <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
              {t('search.filters.operator')}
              <select
                className="workbench-input min-h-9 px-3"
                onChange={(event) => {
                  const operator = event.target.value as SearchCustomFieldFilter['operator']
                  updateFilter(index, {
                    operator,
                    value: ['is-empty', 'is-not-empty'].includes(operator)
                      ? undefined
                      : filter.value ?? '',
                  })
                }}
                value={filter.operator}
              >
                {searchCustomFieldOperators.map((operator) => (
                  <option key={operator} value={operator}>{t(`search.operator.${operator}`)}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
              {t('search.filters.value')}
              <input
                className="workbench-input min-h-9 px-3 disabled:bg-[var(--workbench-surface-muted)]"
                disabled={doesNotNeedValue}
                onChange={(event) => updateFilter(index, { value: parseSearchCustomFieldValue(event.target.value) })}
                value={formatSearchCustomFieldValue(filter.value)}
              />
            </label>
            <button
              aria-label={`${t('search.filters.remove')}: ${filter.fieldId}`}
              className="grid h-9 w-9 place-items-center rounded-lg text-red-700 transition hover:bg-red-50 max-[760px]:w-full"
              onClick={() => onChange(filters.filter((_, filterIndex) => filterIndex !== index))}
              type="button"
            >
              ×
            </button>
          </div>
        )
      })}
      <div className="grid grid-cols-[minmax(120px,1fr)_minmax(170px,0.8fr)_minmax(120px,1fr)_auto] items-end gap-2 rounded-lg bg-[var(--workbench-surface-muted)] p-2 max-[760px]:grid-cols-1">
        <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
          {t('search.filters.customFieldId')}
          <input className="workbench-input min-h-9 px-3" onChange={(event) => setDraftFieldId(event.target.value)} value={draftFieldId} />
        </label>
        <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
          {t('search.filters.operator')}
          <select className="workbench-input min-h-9 px-3" onChange={(event) => setDraftOperator(event.target.value as SearchCustomFieldFilter['operator'])} value={draftOperator}>
            {searchCustomFieldOperators.map((operator) => (
              <option key={operator} value={operator}>{t(`search.operator.${operator}`)}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
          {t('search.filters.value')}
          <input
            className="workbench-input min-h-9 px-3 disabled:bg-white/60"
            disabled={draftOperator === 'is-empty' || draftOperator === 'is-not-empty'}
            onChange={(event) => setDraftValue(event.target.value)}
            value={draftValue}
          />
        </label>
        <button
          className="workbench-button-secondary min-h-9 px-3"
          disabled={!draftFieldId.trim()}
          onClick={() => {
            const doesNotNeedValue = draftOperator === 'is-empty' || draftOperator === 'is-not-empty'
            onChange([...filters, {
              fieldId: draftFieldId.trim(),
              operator: draftOperator,
              ...(doesNotNeedValue ? {} : { value: parseSearchCustomFieldValue(draftValue) }),
            }])
            setDraftFieldId('')
            setDraftOperator('equals')
            setDraftValue('')
          }}
          type="button"
        >
          + {t('search.filters.add')}
        </button>
      </div>
    </fieldset>
  )
}

function CommaSeparatedInput({
  filterKey,
  label,
  onFiltersChange,
  routeState,
}: {
  filterKey: string
  label: string
  onFiltersChange: (patch: Record<string, unknown>) => void
  routeState: SearchRouteState
}) {
  return (
    <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
      {label}
      <input
        className="workbench-input min-h-10 px-3 normal-case tracking-normal"
        onChange={(event) => onFiltersChange({ [filterKey]: parseCommaSeparated(event.target.value) })}
        value={getSearchFilterValues(routeState.filters, filterKey).join(', ')}
      />
    </label>
  )
}

function DateInput({
  dateField,
  filterKey,
  label,
  onFiltersChange,
  routeState,
}: {
  dateField: 'createdAt' | 'updatedAt' | 'dueDate'
  filterKey: 'dateFrom' | 'dateTo'
  label: string
  onFiltersChange: (patch: Record<string, unknown>) => void
  routeState: SearchRouteState
}) {
  return (
    <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
      {label}
      <input
        className="workbench-input min-h-10 px-3 normal-case tracking-normal"
        onChange={(event) => {
          const currentDate = asRecord(asRecord(routeState.filters).date)
          const boundKey = filterKey === 'dateFrom' ? 'from' : 'to'
          const nextDate = {
            ...currentDate,
            field: dateField,
            [boundKey]: event.target.value || undefined,
          }
          onFiltersChange({
            date: nextDate.from || nextDate.to ? nextDate : undefined,
          })
        }}
        type="date"
        value={getSearchDateValue(routeState.filters, filterKey)}
      />
    </label>
  )
}

function ToggleChip({
  active,
  label,
  onToggle,
}: {
  active: boolean
  label: string
  onToggle: () => void
}) {
  return (
    <button
      aria-pressed={active}
      className={`min-h-8 rounded-lg border px-3 text-xs font-semibold transition ${
        active
          ? 'border-[var(--workbench-primary)] bg-[#e5f7f4] text-[var(--workbench-primary)]'
          : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:border-[var(--workbench-border-strong)]'
      }`}
      onClick={onToggle}
      type="button"
    >
      {label}
    </button>
  )
}

function SmallAction({
  danger = false,
  label,
  onClick,
  pressed,
}: {
  danger?: boolean
  label: string
  onClick: () => void
  pressed?: boolean
}) {
  return (
    <button
      aria-pressed={pressed}
      className={`rounded-md px-2 py-1 text-[10px] font-semibold transition ${danger ? 'text-red-700 hover:bg-red-50' : 'text-[var(--workbench-muted)] hover:bg-white'}`}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  )
}

function SearchLoadingState({ t }: { t: (key: MessageKey) => string }) {
  return (
    <section aria-label={t('search.loading')} className="workbench-panel grid gap-3 p-5" role="status">
      {[0, 1, 2, 3].map((item) => (
        <span className="h-14 animate-pulse rounded-lg bg-[var(--workbench-surface-muted)]" key={item} />
      ))}
      <span className="sr-only">{t('search.loading')}</span>
    </section>
  )
}

function mergeSearchResults(currentResults: WorkspaceSearchResult[], nextResults: WorkspaceSearchResult[]) {
  const resultsByKey = new Map(currentResults.map((result) => [createResultKey(result), result]))
  for (const result of nextResults) {
    resultsByKey.set(createResultKey(result), result)
  }
  return Array.from(resultsByKey.values())
}

function createResultKey(result: WorkspaceSearchResult) {
  return `${result.entityType}:${result.teamId ?? ''}:${result.id}`
}

function parseCommaSeparated(value: string) {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
}

function parseSearchCustomFieldValue(value: string) {
  const normalized = value.trim()

  if (normalized === 'true') {
    return true
  }
  if (normalized === 'false') {
    return false
  }
  if (normalized === 'null') {
    return null
  }
  if (normalized && Number.isFinite(Number(normalized))) {
    return Number(normalized)
  }
  if (normalized.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(normalized)
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed
      }
    } catch {
      return value
    }
  }

  return value
}

function formatSearchCustomFieldValue(value: SearchCustomFieldFilter['value']) {
  return Array.isArray(value) ? JSON.stringify(value) : value === null ? 'null' : String(value ?? '')
}

function toggleValue<TValue extends string>(values: readonly TValue[], value: TValue) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

function hasExplicitSearchState(searchParams: URLSearchParams) {
  return Array.from(searchParams.keys()).some((key) => key !== 'v' && key !== 'view')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function formatSavedViewMigrationWarnings(view: SavedWorkspaceView) {
  const warnings = (view.migrationWarnings ?? []).map((warning) =>
    `${warning.code}: ${warning.fieldId} (${warning.section})`,
  )

  if (view.schemaVersion !== SAVED_VIEW_SCHEMA_VERSION) {
    warnings.unshift(`Saved view schema v${view.schemaVersion} → v${SAVED_VIEW_SCHEMA_VERSION}`)
  }

  return warnings
}

function formatSelectableColumnLabel(column: string, t: (key: MessageKey) => string) {
  const labels: Record<string, MessageKey> = {
    type: 'search.filters.types',
    status: 'tasks.column.status',
    assignee: 'tasks.column.assignee',
    creator: 'search.filters.creator',
    project: 'issues.column.project',
    team: 'workspace.column.team',
    dueDate: 'tasks.column.dueDate',
    updatedAt: 'search.columns.updatedAt',
  }
  const key = labels[column]
  return key ? t(key) : column
}
