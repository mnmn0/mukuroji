import { createSearchWorkItemTypeKey } from '@mukuroji/contracts'
import type {
  AnalyticsEvidenceInput,
  AnalyticsEvidenceResponse,
  AnalyticsFilter,
  AnalyticsReport,
  AnalyticsSchedule,
  AnalyticsWidget,
  CreateAnalyticsReportInput,
} from '@mukuroji/contracts'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import {
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import {
  canMutateWorkspaceContent,
} from '../../auth/api'
import { useCurrentUser } from '../../auth/queries/useCurrentUser'
import {
  clearAuthSession,
  getAuthSession,
  type AuthSession,
} from '../../auth/session'
import {
  MobileSidebarButton,
} from '../../shared/ui/sidebar'
import {
  createTranslator,
  getInitialLocale,
  type Locale,
} from '../../shared/i18n/i18n'
import {
  AnalyticsApiError,
  collectAnalyticsSnapshotPages,
  createAnalyticsExportInput,
  createAnalyticsReport,
  createAnalyticsSnapshot,
  deleteAnalyticsReport,
  exportAnalytics,
  getAnalyticsEvidence,
  updateAnalyticsReport,
} from '../../analytics/api'
import {
  useAnalyticsQuery,
  useAnalyticsReports,
} from '../../analytics/queries/useAnalyticsQueries'
import {
  useAnalyticsSnapshots,
} from '../../analytics/queries/useAnalyticsSnapshots'
import { shouldClearAnalyticsAuthSession } from '../../analytics/model/authError'
import {
  createDefaultAnalyticsWidgets,
  getDefaultAnalyticsTimeZone,
} from '../../analytics/model/defaults'
import {
  AnalyticsWorkbench,
  type AnalyticsWorkItemTypeOption,
} from '../../analytics/ui/AnalyticsWorkbench'
import { createAnalyticsLiveQueryRunner } from '../../analytics/liveQuery'
import {
  createAnalyticsQueryInput,
  createDefaultAnalyticsFilter,
  parseAnalyticsRouteState,
  serializeAnalyticsRouteState,
  type AnalyticsRouteState,
} from '../../analytics/model/queryState'
import { resolveAnalyticsSnapshotAutoPagination } from '../../analytics/model/snapshotPagination'
import {
  type ProjectDirectoryTeam,
} from '../../projects/api'
import { useProjectDirectory } from '../../projects/queries/useProjectDirectory'
import {
  createTeamIssuesPath,
} from '../../shared/routing/paths'
import { useWorkspaceSidebarController } from '../../shared/ui/sidebar'
import { resolveWorkItemTypes } from '../../work-items/model/workItemDisplay'
import { useTeamWorkItemConfigurations } from '../../work-items/queries/useWorkItemConfigurations'

const emptyReports: AnalyticsReport[] = []
const emptyTeams: ProjectDirectoryTeam[] = []

/**
 * 認証済み Workspace の analytics report viewer / builder です。
 */
export function ReportsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const [liveQueryRunner] = useState(() => createAnalyticsLiveQueryRunner())
  const [session] = useState<AuthSession | null>(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [initialTimeZone] = useState(() => getDefaultAnalyticsTimeZone())
  const [initialFilter] = useState(() =>
    createDefaultAnalyticsFilter(new Date(), initialTimeZone))
  const [widgetDraft, setWidgetDraft] = useState(() => ({
    sourceKey: 'ad-hoc',
    widgets: [] as AnalyticsWidget[],
  }))
  const [queryAsOf, setQueryAsOf] = useState(() => new Date().toISOString())
  const [hasStartedAdHoc, setHasStartedAdHoc] = useState(false)
  const [evidence, setEvidence] = useState<AnalyticsEvidenceResponse>()
  const [evidenceInput, setEvidenceInput] = useState<AnalyticsEvidenceInput>()
  const [isEvidenceLoading, setIsEvidenceLoading] = useState(false)
  const evidenceRequest = useRef<AbortController | undefined>(undefined)
  const [mutationErrorMessage, setMutationErrorMessage] = useState<string>()
  const [noticeMessage, setNoticeMessage] = useState<string>()
  const t = useMemo(() => createTranslator(locale), [locale])
  const { openMobileSidebar } = useWorkspaceSidebarController()
  const accessToken = session?.accessToken

  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
    mutate: mutateCurrentUser,
  } = useCurrentUser(accessToken)
  const {
    data: teams = emptyTeams,
    error: projectDirectoryError,
    isLoading: isProjectDirectoryLoading,
    key: projectDirectoryKey,
    mutate: mutateProjectDirectory,
  } = useProjectDirectory({
    accessToken,
    enabled: Boolean(user && !currentUserError),
    locale,
  })
  const {
    data: workItemConfigurationLoadResult,
    error: workItemConfigurationsError,
    isLoading: isWorkItemConfigurationsLoading,
    key: workItemConfigurationsKey,
    mutate: mutateWorkItemConfigurations,
  } = useTeamWorkItemConfigurations(
    accessToken,
    'reports',
    teams.map((team) => team.id).sort(),
    Boolean(user && !currentUserError && !isProjectDirectoryLoading),
  )
  const workItemTypes = useMemo<AnalyticsWorkItemTypeOption[]>(() =>
    teams
      .flatMap((team) => resolveWorkItemTypes(
        workItemConfigurationLoadResult?.configurationsByTeam[team.id],
      ).map((type) => ({
        filterValue: createSearchWorkItemTypeKey(team.id, type.id),
        label: `${team.name} · ${type.name}`,
      })))
      .sort((left, right) => left.label.localeCompare(right.label)),
  [teams, workItemConfigurationLoadResult?.configurationsByTeam])
  const {
    data: reportResponse,
    error: reportsError,
    isLoading: isReportsLoading,
    mutate: mutateReports,
    key: reportsKey,
  } = useAnalyticsReports(accessToken, Boolean(user && !currentUserError))
  const reports = reportResponse?.reports ?? emptyReports
  const searchParamString = searchParams.toString()
  const parsedRouteState = useMemo<AnalyticsRouteState | null | undefined>(() => {
    if (searchParamString.length === 0) return undefined
    try {
      return parseAnalyticsRouteState(new URLSearchParams(searchParamString))
    } catch {
      return null
    }
  }, [searchParamString])
  const requestedReportId = parsedRouteState?.reportId
  const selectedReport = reports.find((report) => report.id === requestedReportId)
  const widgetSourceKey = selectedReport
    ? `report:${selectedReport.id}:${selectedReport.revision}`
    : 'ad-hoc'
  const widgets = useMemo(
    () => widgetDraft.sourceKey === widgetSourceKey
      ? widgetDraft.widgets
      : selectedReport?.widgets ?? [],
    [selectedReport?.widgets, widgetDraft, widgetSourceKey],
  )
  const routeState = useMemo<AnalyticsRouteState>(
    () => parsedRouteState ?? {
      builder: false,
      filter: selectedReport?.filter ?? initialFilter,
      forecastBaseline: selectedReport?.forecastBaseline,
      reportId: selectedReport?.id,
      snapshotId: undefined,
      timezone: selectedReport?.timeZone ?? initialTimeZone,
    },
    [
      initialFilter,
      initialTimeZone,
      parsedRouteState,
      selectedReport?.filter,
      selectedReport?.forecastBaseline,
      selectedReport?.id,
      selectedReport?.timeZone,
    ],
  )

  const commitRouteState = useCallback((
    nextState: AnalyticsRouteState,
    replace = true,
  ) => {
    setSearchParams(serializeAnalyticsRouteState(nextState), { replace })
  }, [setSearchParams])

  const {
    data: snapshotPages,
    error: snapshotsError,
    isLoading: isSnapshotsLoading,
    mutate: mutateSnapshots,
    setSize: setSnapshotPageCount,
    size: snapshotPageCount,
  } = useAnalyticsSnapshots(accessToken, selectedReport?.id)
  const snapshots = useMemo(
    () => collectAnalyticsSnapshotPages(snapshotPages ?? []),
    [snapshotPages],
  )
  const snapshotNextCursor = snapshotPages?.at(-1)?.nextCursor
  const snapshotCursorRepeated = snapshotNextCursor !== undefined &&
    Boolean(snapshotPages?.slice(0, -1).some(
      (page) => page.nextCursor === snapshotNextCursor,
    ))
  const hasMoreSnapshots = snapshotNextCursor !== undefined &&
    !snapshotCursorRepeated
  const isLoadingMoreSnapshots = isSnapshotsLoading || (
    snapshotPageCount > 0 &&
    snapshotPages !== undefined &&
    snapshotPages[snapshotPageCount - 1] === undefined
  )
  const snapshotAutoPagination = resolveAnalyticsSnapshotAutoPagination(
    snapshotPages,
    routeState.snapshotId,
    snapshotPageCount,
  )
  const snapshotPaginationGuardError = snapshotCursorRepeated
    ? new TypeError('Analytics snapshot pagination exceeded its safe bounds.')
    : undefined
  const selectedSnapshotRecord = snapshots.find(
    (record) => record.id === routeState.snapshotId,
  )
  const displayedFilter = selectedSnapshotRecord?.query.filter ??
    routeState.filter
  const displayedForecastBaseline = selectedSnapshotRecord
    ? selectedSnapshotRecord.query.forecastBaseline
    : routeState.forecastBaseline
  const displayedTimeZone = selectedSnapshotRecord?.query.timeZone ??
    routeState.timezone
  const displayedWidgets = selectedSnapshotRecord?.query.widgets ?? widgets
  const queryInput = useMemo(() => createAnalyticsQueryInput(
    routeState,
    queryAsOf,
    widgets,
  ), [queryAsOf, routeState, widgets])
  const shouldRunLiveQuery = Boolean(
    accessToken &&
    user &&
    widgets.length > 0 &&
    widgets.every(isAnalyticsWidgetReady) &&
    (selectedReport || hasStartedAdHoc) &&
    !routeState.snapshotId,
  )
  const serializedQuery = useMemo(() => JSON.stringify(queryInput), [queryInput])
  const {
    data: liveSnapshot,
    error: queryError,
    isLoading: isQueryLoading,
    mutate: mutateQuery,
    key: queryKey,
  } = useAnalyticsQuery(
    accessToken,
    serializedQuery,
    shouldRunLiveQuery,
    (token, currentSerializedQuery) =>
      liveQueryRunner.run(token, currentSerializedQuery),
  )
  const snapshot = selectedSnapshotRecord?.snapshot ?? liveSnapshot
  const loadError = currentUserError ??
    reportsError ??
    projectDirectoryError ??
    workItemConfigurationsError ??
    workItemConfigurationLoadResult?.errors[0] ??
    snapshotsError ??
    snapshotPaginationGuardError ??
    queryError
  const loadErrorMessage = loadError
    ? resolveAnalyticsErrorMessage(loadError, t, 'load')
    : undefined
  const isLoading = !session ||
    isCurrentUserLoading ||
    Boolean(projectDirectoryKey && isProjectDirectoryLoading) ||
    Boolean(workItemConfigurationsKey && isWorkItemConfigurationsLoading) ||
    Boolean(reportsKey && isReportsLoading) ||
    Boolean(
      routeState.snapshotId &&
      (
        isSnapshotsLoading ||
        isLoadingMoreSnapshots ||
        snapshotAutoPagination === 'load-next-page'
      )
    ) ||
    Boolean(queryKey && isQueryLoading)

  useEffect(() => {
    if (
      snapshotAutoPagination !== 'load-next-page' ||
      isLoadingMoreSnapshots
    ) {
      return
    }
    void setSnapshotPageCount(snapshotPageCount + 1)
  }, [
    isLoadingMoreSnapshots,
    setSnapshotPageCount,
    snapshotAutoPagination,
    snapshotPageCount,
  ])

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${t('analytics.title')} | ${t('app.title')}`
  }, [locale, t])

  useEffect(() => () => {
    evidenceRequest.current?.abort()
    liveQueryRunner.abort()
  }, [liveQueryRunner])

  useEffect(() => {
    if (!queryKey) {
      liveQueryRunner.abort()
    }
  }, [liveQueryRunner, queryKey])

  useEffect(() => {
    if (!session) {
      navigate('/', { replace: true })
    }
  }, [navigate, session])

  useEffect(() => {
    if (shouldClearAnalyticsAuthSession(currentUserError)) {
      clearAuthSession()
      navigate('/', { replace: true })
    }
  }, [currentUserError, navigate])

  useEffect(() => {
    if (
      parsedRouteState === null ||
      requestedReportId ||
      reports.length === 0 ||
      isReportsLoading ||
      hasStartedAdHoc
    ) {
      return
    }

    const report = reports[0]
    if (!report) return
    commitRouteState({
      asOf: undefined,
      builder: false,
      filter: report.filter,
      forecastBaseline: report.forecastBaseline,
      reportId: report.id,
      snapshotId: undefined,
      timezone: report.timeZone,
    })
  }, [
    commitRouteState,
    hasStartedAdHoc,
    isReportsLoading,
    parsedRouteState,
    reports,
    requestedReportId,
  ])

  useEffect(() => {
    if (
      searchParamString ||
      isReportsLoading ||
      reports.length > 0 ||
      hasStartedAdHoc
    ) {
      return
    }

    commitRouteState({
      asOf: undefined,
      builder: false,
      filter: initialFilter,
      forecastBaseline: undefined,
      reportId: undefined,
      snapshotId: undefined,
      timezone: initialTimeZone,
    })
  }, [
    commitRouteState,
    hasStartedAdHoc,
    initialFilter,
    initialTimeZone,
    isReportsLoading,
    reports.length,
    searchParamString,
  ])

  const resetFeedback = () => {
    setMutationErrorMessage(undefined)
    setNoticeMessage(undefined)
  }

  const closeEvidence = () => {
    evidenceRequest.current?.abort()
    evidenceRequest.current = undefined
    setEvidence(undefined)
    setEvidenceInput(undefined)
    setIsEvidenceLoading(false)
  }

  const refreshQuery = (
    patch: Partial<AnalyticsRouteState>,
    nextWidgets?: AnalyticsWidget[],
    nextWidgetSourceKey = widgetSourceKey,
  ) => {
    resetFeedback()
    closeEvidence()
    setQueryAsOf(new Date().toISOString())
    const restoredWidgets = nextWidgets ??
      selectedSnapshotRecord?.query.widgets
    if (restoredWidgets) {
      setWidgetDraft({
        sourceKey: nextWidgetSourceKey,
        widgets: restoredWidgets,
      })
    }
    commitRouteState({
      ...routeState,
      filter: selectedSnapshotRecord?.query.filter ?? routeState.filter,
      forecastBaseline: selectedSnapshotRecord
        ? selectedSnapshotRecord.query.forecastBaseline
        : routeState.forecastBaseline,
      timezone: selectedSnapshotRecord?.query.timeZone ?? routeState.timezone,
      ...patch,
      snapshotId: undefined,
    })
  }

  const runReportMutation = async <TResult,>(
    operationKey: string,
    payload: unknown,
    request: (context: MutationRequestContext) => Promise<TResult>,
  ) => {
    resetFeedback()
    try {
      return await mutationRequestRunner.run(
        operationKey,
        JSON.stringify(payload),
        request,
      )
    } catch (error) {
      setMutationErrorMessage(resolveAnalyticsErrorMessage(error, t, 'mutation'))
      if (error instanceof AnalyticsApiError && error.status === 409) {
        await mutateReports()
      }
      return undefined
    }
  }

  const saveReport = async (input: CreateAnalyticsReportInput) => {
    if (!accessToken) return
    const current = reports.find((report) => report.id === routeState.reportId)
    const saved = current
      ? await runReportMutation(
          `analytics:report:${current.id}:update`,
          [current.revision, input],
          (context) => updateAnalyticsReport(accessToken, current.id, {
            description: input.description ?? null,
            expectedRevision: current.revision,
            filter: input.filter,
            forecastBaseline: input.forecastBaseline ?? null,
            name: input.name,
            schedule: input.schedule ?? null,
            teamId: input.teamId ?? null,
            timeZone: input.timeZone,
            visibility: input.visibility,
            widgets: input.widgets,
          }, context),
        )
      : await runReportMutation(
          `analytics:report:${input.id}:create`,
          input,
          (context) => createAnalyticsReport(accessToken, input, context),
        )

    if (!saved) return
    await mutateReports(
      (response) => ({
        reports: upsertReport(response?.reports ?? reports, saved),
      }),
      { revalidate: false },
    )
    setHasStartedAdHoc(false)
    commitRouteState({
      asOf: undefined,
      builder: false,
      filter: saved.filter,
      forecastBaseline: saved.forecastBaseline,
      reportId: saved.id,
      snapshotId: undefined,
      timezone: saved.timeZone,
    })
    setNoticeMessage(t('analytics.notice.saved'))
  }

  const removeReport = async (report: AnalyticsReport) => {
    if (!accessToken) return
    const deleted = await runReportMutation(
      `analytics:report:${report.id}:delete`,
      report.revision,
      async (context) => {
        await deleteAnalyticsReport(
          accessToken,
          report.id,
          report.revision,
          context,
        )
        return true
      },
    )
    if (!deleted) return

    const remainingReports = reports.filter((item) => item.id !== report.id)
    await mutateReports(
      { reports: remainingReports },
      { revalidate: false },
    )
    const nextReport = remainingReports[0]
    if (nextReport) {
      commitRouteState({
        asOf: undefined,
        builder: false,
        filter: nextReport.filter,
        forecastBaseline: nextReport.forecastBaseline,
        reportId: nextReport.id,
        snapshotId: undefined,
        timezone: nextReport.timeZone,
      })
    } else {
      setHasStartedAdHoc(false)
      commitRouteState({
        builder: false,
        filter: initialFilter,
        forecastBaseline: undefined,
        timezone: initialTimeZone,
      })
    }
    setNoticeMessage(t('analytics.notice.deleted'))
  }

  const saveSchedule = async (schedule: AnalyticsSchedule | null) => {
    if (!accessToken || !selectedReport) return false
    const updated = await runReportMutation(
      `analytics:report:${selectedReport.id}:schedule`,
      [selectedReport.revision, schedule],
      (context) => updateAnalyticsReport(accessToken, selectedReport.id, {
        expectedRevision: selectedReport.revision,
        schedule,
      }, context),
    )
    if (!updated) return false
    await mutateReports(
      (response) => ({
        reports: upsertReport(response?.reports ?? reports, updated),
      }),
      { revalidate: false },
    )
    setNoticeMessage(t('analytics.notice.scheduleSaved'))
    return true
  }

  const saveSnapshot = async () => {
    if (!accessToken || !selectedReport) return
    const record = await runReportMutation(
      `analytics:report:${selectedReport.id}:snapshot`,
      queryInput,
      (context) => createAnalyticsSnapshot(
        accessToken,
        selectedReport.id,
        queryInput,
        context,
      ),
    )
    if (!record) return
    await mutateSnapshots(
      (currentPages) => {
        const pages = currentPages ?? []
        const firstPage = pages[0]
        const updatedFirstPage = {
          inspectedCount: firstPage?.inspectedCount ?? 0,
          snapshots: [
            record,
            ...(firstPage?.snapshots ?? []).filter(
              (item) => item.id !== record.id,
            ),
          ],
          ...(firstPage?.nextCursor === undefined
            ? {}
            : { nextCursor: firstPage.nextCursor }),
        }
        return [updatedFirstPage, ...pages.slice(1)]
      },
      { revalidate: false },
    )
    commitRouteState({
      ...routeState,
      snapshotId: record.id,
    })
    setNoticeMessage(t('analytics.notice.snapshotSaved'))
  }

  const openEvidence = async (input: AnalyticsEvidenceInput) => {
    if (!accessToken) return
    resetFeedback()
    evidenceRequest.current?.abort()
    const controller = new AbortController()
    evidenceRequest.current = controller
    setEvidence(undefined)
    setEvidenceInput(input)
    setIsEvidenceLoading(true)
    try {
      const nextEvidence = await getAnalyticsEvidence(
        accessToken,
        input,
        controller.signal,
      )
      if (evidenceRequest.current === controller) {
        setEvidence(nextEvidence)
      }
    } catch (error) {
      if (
        evidenceRequest.current === controller &&
        !isAbortError(error)
      ) {
        setMutationErrorMessage(
          resolveAnalyticsErrorMessage(error, t, 'evidence'),
        )
      }
    } finally {
      if (evidenceRequest.current === controller) {
        evidenceRequest.current = undefined
        setIsEvidenceLoading(false)
      }
    }
  }

  const loadMoreEvidence = async () => {
    if (!accessToken || !evidenceInput || !evidence?.nextCursor) return
    evidenceRequest.current?.abort()
    const controller = new AbortController()
    evidenceRequest.current = controller
    setIsEvidenceLoading(true)
    const nextInput = {
      ...evidenceInput,
      cursor: evidence.nextCursor,
    }
    try {
      const nextPage = await getAnalyticsEvidence(
        accessToken,
        nextInput,
        controller.signal,
      )
      if (evidenceRequest.current === controller) {
        setEvidence({
          items: [...evidence.items, ...nextPage.items],
          nextCursor: nextPage.nextCursor,
        })
        setEvidenceInput(nextInput)
      }
    } catch (error) {
      if (
        evidenceRequest.current === controller &&
        !isAbortError(error)
      ) {
        setMutationErrorMessage(
          resolveAnalyticsErrorMessage(error, t, 'evidence'),
        )
      }
    } finally {
      if (evidenceRequest.current === controller) {
        evidenceRequest.current = undefined
        setIsEvidenceLoading(false)
      }
    }
  }

  const shareReport = async () => {
    resetFeedback()
    try {
      const shareData = {
        title: selectedReport?.name ?? t('analytics.title'),
        url: window.location.href,
      }
      if (navigator.share) {
        await navigator.share(shareData)
      } else {
        await navigator.clipboard.writeText(shareData.url)
      }
      setNoticeMessage(t('analytics.notice.linkCopied'))
    } catch (error) {
      if (isAbortError(error)) return
      setMutationErrorMessage(t('analytics.error.share'))
    }
  }

  const exportReport = async (format: 'csv' | 'pdf') => {
    if (!accessToken) return
    resetFeedback()
    try {
      const artifact = await exportAnalytics(accessToken, {
        ...createAnalyticsExportInput(
          format,
          locale,
          queryInput,
          routeState.snapshotId,
        ),
      })
      downloadArtifact(artifact.blob, artifact.filename)
      setNoticeMessage(t('analytics.notice.exportStarted'))
    } catch (error) {
      setMutationErrorMessage(resolveAnalyticsErrorMessage(error, t, 'export'))
    }
  }

  if (parsedRouteState === null) {
    return <Navigate replace to="/reports" />
  }

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
        <div className="absolute left-4 top-4 z-30 min-[981px]:hidden">
          <MobileSidebarButton
            label={t('sidebar.mobileOpen')}
            onClick={openMobileSidebar}
          />
        </div>
        <AnalyticsWorkbench
          key={`${selectedReport?.id ?? 'ad-hoc'}:${selectedReport?.revision ?? 0}`}
          builder={routeState.builder}
          canManageReports={canMutateWorkspaceContent(user)}
          errorMessage={mutationErrorMessage ?? loadErrorMessage}
          evidence={evidence}
          evidenceMetric={evidenceInput?.metric}
          filter={displayedFilter}
          forecastBaseline={displayedForecastBaseline}
          isEvidenceLoading={isEvidenceLoading}
          isLoading={isLoading}
          locale={locale}
          noticeMessage={noticeMessage}
          reports={reports}
          selectedReportId={selectedReport?.id}
          selectedSnapshotId={routeState.snapshotId}
          snapshot={snapshot}
          snapshots={snapshots}
          hasMoreSnapshots={hasMoreSnapshots}
          isLoadingMoreSnapshots={isLoadingMoreSnapshots}
          teams={teams}
          timeZone={displayedTimeZone}
          workItemTypes={workItemTypes}
          widgets={displayedWidgets}
          onBuilderChange={(builder) => {
            if (selectedSnapshotRecord) {
              refreshQuery(
                { builder },
                selectedSnapshotRecord.query.widgets,
              )
              return
            }
            commitRouteState({ ...routeState, builder })
          }}
          onCloseEvidence={closeEvidence}
          onCreateBlank={() => {
            setHasStartedAdHoc(true)
            refreshQuery({
              asOf: undefined,
              builder: true,
              filter: initialFilter,
              forecastBaseline: undefined,
              reportId: undefined,
              timezone: initialTimeZone,
            }, [], 'ad-hoc')
          }}
          onCreateSnapshot={saveSnapshot}
          onDeleteReport={removeReport}
          onExport={exportReport}
          onFilterChange={(filter: AnalyticsFilter) =>
            refreshQuery({ filter })}
          onForecastBaselineChange={(forecastBaseline) =>
            refreshQuery({ forecastBaseline })}
          onLoadMoreEvidence={loadMoreEvidence}
          onLoadMoreSnapshots={() => {
            if (!hasMoreSnapshots || isLoadingMoreSnapshots) return
            resetFeedback()
            void setSnapshotPageCount(snapshotPageCount + 1)
          }}
          onOpenEvidence={(input) => void openEvidence(input)}
          onOpenWorkItem={(item) => navigate(
            createTeamIssuesPath(item.teamId, item.workItemId),
          )}
          onRetry={() => {
            resetFeedback()
            void Promise.all([
              mutateCurrentUser(),
              mutateProjectDirectory(),
              mutateWorkItemConfigurations(),
              mutateReports(),
              mutateSnapshots(),
              mutateQuery(),
            ])
          }}
          onSaveReport={saveReport}
          onSaveSchedule={saveSchedule}
          onSelectReport={(reportId) => {
            const report = reports.find((item) => item.id === reportId)
            if (report) {
              setHasStartedAdHoc(false)
              setQueryAsOf(new Date().toISOString())
              commitRouteState({
                asOf: undefined,
                builder: false,
                filter: report.filter,
                forecastBaseline: report.forecastBaseline,
                reportId: report.id,
                snapshotId: undefined,
                timezone: report.timeZone,
              }, false)
              return
            }
            setHasStartedAdHoc(true)
            refreshQuery({
              asOf: undefined,
              builder: false,
              filter: initialFilter,
              forecastBaseline: undefined,
              reportId: undefined,
              timezone: initialTimeZone,
            }, createDefaultAnalyticsWidgets(locale), 'ad-hoc')
          }}
          onSelectSnapshot={(snapshotId) =>
            commitRouteState({ ...routeState, snapshotId })}
          onShare={shareReport}
          onStartExample={() => {
            setHasStartedAdHoc(true)
            refreshQuery({
              asOf: undefined,
              builder: false,
              filter: initialFilter,
              forecastBaseline: undefined,
              reportId: undefined,
              timezone: initialTimeZone,
            }, createDefaultAnalyticsWidgets(locale), 'ad-hoc')
          }}
          onTimeZoneChange={(timezone) =>
            refreshQuery({ timezone })}
          onWidgetsChange={(nextWidgets) =>
            refreshQuery({}, nextWidgets)}
        />
    </div>
  )
}

function upsertReport(
  reports: readonly AnalyticsReport[],
  report: AnalyticsReport,
) {
  const nextReports = reports.filter((item) => item.id !== report.id)
  return [report, ...nextReports].sort((first, second) =>
    second.updatedAt.localeCompare(first.updatedAt))
}

function resolveAnalyticsErrorMessage(
  error: unknown,
  t: ReturnType<typeof createTranslator>,
  scope: 'load' | 'mutation' | 'evidence' | 'export',
) {
  if (error instanceof AnalyticsApiError) {
    if (error.status === 409) return t('analytics.error.conflict')
    if (error.status === 403) return t('analytics.error.forbidden')
    if (error.status === 401) return t('analytics.error.session')
  }
  if (scope === 'evidence') return t('analytics.error.evidence')
  if (scope === 'export') return t('analytics.error.export')
  if (scope === 'mutation') return t('analytics.error.mutation')
  return t('analytics.error.load')
}

function downloadArtifact(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.download = filename
  anchor.href = objectUrl
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isAnalyticsWidgetReady(widget: AnalyticsWidget) {
  return widget.groupBy?.dimension !== 'custom-field' ||
    widget.groupBy.customFieldId.trim().length > 0
}
