import type {
  AnalyticsEvidenceInput,
  AnalyticsEvidenceResponse,
  AnalyticsFilter,
  AnalyticsQueryInput,
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
import { useNavigate, useSearchParams } from 'react-router'
import useSWR from 'swr'
import {
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../api/mutationHeaders'
import {
  canMutateWorkspaceContent,
  getCurrentUser,
} from '../auth/api'
import {
  clearAuthSession,
  getAuthSession,
  type AuthSession,
} from '../auth/session'
import {
  MobileSidebarButton,
  MobileSidebarDrawer,
  Sidebar,
} from '../components/sidebar'
import {
  createSidebarLabels,
  createTranslator,
  getInitialLocale,
  type Locale,
} from '../i18n'
import {
  AnalyticsApiError,
  createAnalyticsExportInput,
  createAnalyticsReport,
  createAnalyticsSnapshot,
  deleteAnalyticsReport,
  exportAnalytics,
  getAnalyticsEvidence,
  getAnalyticsReports,
  getAnalyticsSnapshots,
  queryAnalytics,
  updateAnalyticsReport,
} from '../analytics/api'
import { shouldClearAnalyticsAuthSession } from '../analytics/authError'
import {
  createDefaultAnalyticsWidgets,
  getDefaultAnalyticsTimeZone,
} from '../analytics/defaults'
import { AnalyticsWorkbench } from '../analytics/AnalyticsWorkbench'
import {
  createDefaultAnalyticsFilter,
  parseAnalyticsRouteState,
  serializeAnalyticsRouteState,
  type AnalyticsRouteState,
} from '../analytics/queryState'
import {
  getProjectDirectory,
  type ProjectDirectoryTeam,
} from '../projects/api'
import {
  createProjectIssuesPath,
  createTeamIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../routes/paths'

const apiSWRConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const
const emptyReports: AnalyticsReport[] = []
const emptyTeams: ProjectDirectoryTeam[] = []

/**
 * 認証済み Workspace の analytics report viewer / builder です。
 */
export function ReportsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
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
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [mutationErrorMessage, setMutationErrorMessage] = useState<string>()
  const [noticeMessage, setNoticeMessage] = useState<string>()
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const accessToken = session?.accessToken

  const currentUserKey = accessToken
    ? ['analytics-current-user', accessToken] as const
    : null
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
    mutate: mutateCurrentUser,
  } = useSWR(
    currentUserKey,
    ([, token]) => getCurrentUser(token),
    apiSWRConfig,
  )
  const projectDirectoryKey = accessToken && user && !currentUserError
    ? ['analytics-project-directory', accessToken, locale] as const
    : null
  const {
    data: teams = emptyTeams,
    error: projectDirectoryError,
    isLoading: isProjectDirectoryLoading,
    mutate: mutateProjectDirectory,
  } = useSWR(
    projectDirectoryKey,
    ([, token, currentLocale]) => getProjectDirectory(token, currentLocale),
    apiSWRConfig,
  )
  const reportsKey = accessToken && user && !currentUserError
    ? ['analytics-reports', accessToken] as const
    : null
  const {
    data: reportResponse,
    error: reportsError,
    isLoading: isReportsLoading,
    mutate: mutateReports,
  } = useSWR(
    reportsKey,
    ([, token]) => getAnalyticsReports(token),
    apiSWRConfig,
  )
  const reports = reportResponse?.reports ?? emptyReports
  const searchParamString = searchParams.toString()
  const requestedReportId = searchParams.get('report')?.trim() || undefined
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
  const routeState = useMemo(
    () => parseAnalyticsRouteState(
      new URLSearchParams(searchParamString),
      selectedReport?.filter ?? initialFilter,
      selectedReport?.timeZone ?? initialTimeZone,
      selectedReport?.forecastBaseline,
    ),
    [
      initialFilter,
      initialTimeZone,
      searchParamString,
      selectedReport?.filter,
      selectedReport?.forecastBaseline,
      selectedReport?.timeZone,
    ],
  )

  const commitRouteState = useCallback((
    nextState: AnalyticsRouteState,
    replace = true,
  ) => {
    setSearchParams(serializeAnalyticsRouteState(nextState), { replace })
  }, [setSearchParams])

  const snapshotsKey = accessToken && selectedReport
    ? ['analytics-snapshots', accessToken, selectedReport.id] as const
    : null
  const {
    data: snapshots = [],
    error: snapshotsError,
    isLoading: isSnapshotsLoading,
    mutate: mutateSnapshots,
  } = useSWR(
    snapshotsKey,
    ([, token, reportId]) => getAnalyticsSnapshots(token, reportId),
    apiSWRConfig,
  )
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
  const queryInput = useMemo(() => ({
    asOf: routeState.asOf ?? queryAsOf,
    filter: routeState.filter,
    ...(routeState.forecastBaseline
      ? { forecastBaseline: routeState.forecastBaseline }
      : {}),
    timeZone: routeState.timezone,
    widgets,
  } satisfies AnalyticsQueryInput), [
    queryAsOf,
    routeState.asOf,
    routeState.filter,
    routeState.forecastBaseline,
    routeState.timezone,
    widgets,
  ])
  const shouldRunLiveQuery = Boolean(
    accessToken &&
    user &&
    widgets.length > 0 &&
    widgets.every(isAnalyticsWidgetReady) &&
    (selectedReport || hasStartedAdHoc) &&
    !routeState.snapshotId,
  )
  const queryKey = shouldRunLiveQuery && accessToken
    ? ['analytics-query', accessToken, JSON.stringify(queryInput)] as const
    : null
  const {
    data: liveSnapshot,
    error: queryError,
    isLoading: isQueryLoading,
    mutate: mutateQuery,
  } = useSWR(
    queryKey,
    ([, token, serializedQuery]) =>
      queryAnalytics(token, JSON.parse(serializedQuery) as AnalyticsQueryInput),
    apiSWRConfig,
  )
  const snapshot = selectedSnapshotRecord?.snapshot ?? liveSnapshot
  const loadError = currentUserError ??
    reportsError ??
    projectDirectoryError ??
    snapshotsError ??
    queryError
  const loadErrorMessage = loadError
    ? resolveAnalyticsErrorMessage(loadError, t, 'load')
    : undefined
  const isLoading = !session ||
    isCurrentUserLoading ||
    Boolean(projectDirectoryKey && isProjectDirectoryLoading) ||
    Boolean(reportsKey && isReportsLoading) ||
    Boolean(routeState.snapshotId && snapshotsKey && isSnapshotsLoading) ||
    Boolean(queryKey && isQueryLoading)

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${t('analytics.title')} | ${t('app.title')}`
  }, [locale, t])

  useEffect(() => () => {
    evidenceRequest.current?.abort()
  }, [])

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
    reports,
    requestedReportId,
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
      (current) => [
        record,
        ...(current ?? []).filter((item) => item.id !== record.id),
      ],
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

  return (
    <main className="workbench-shell flex h-svh min-h-0 overflow-hidden">
      <Sidebar
        activeNavId="reports"
        className="max-[980px]:hidden"
        labels={sidebarLabels}
        teams={teams}
        onSelectNav={(navId) => navigate(workspaceNavPaths[navId])}
        onSelectProject={(projectId, teamId) =>
          navigate(createProjectIssuesPath(projectId, teamId))}
        onSelectTeamView={(teamId, viewId) =>
          navigate(createTeamViewPath(teamId, viewId))}
      />
      <MobileSidebarDrawer
        closeLabel={t('sidebar.mobileClose')}
        dialogLabel={t('sidebar.mobileDialog')}
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
      >
        <Sidebar
          activeNavId="reports"
          labels={sidebarLabels}
          teams={teams}
          onSelectNav={(navId) => {
            setIsMobileSidebarOpen(false)
            navigate(workspaceNavPaths[navId])
          }}
          onSelectProject={(projectId, teamId) => {
            setIsMobileSidebarOpen(false)
            navigate(createProjectIssuesPath(projectId, teamId))
          }}
          onSelectTeamView={(teamId, viewId) => {
            setIsMobileSidebarOpen(false)
            navigate(createTeamViewPath(teamId, viewId))
          }}
        />
      </MobileSidebarDrawer>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
        <div className="absolute left-4 top-4 z-30 min-[981px]:hidden">
          <MobileSidebarButton
            label={t('sidebar.mobileOpen')}
            onClick={() => setIsMobileSidebarOpen(true)}
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
          teams={teams}
          timeZone={displayedTimeZone}
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
          onOpenEvidence={(input) => void openEvidence(input)}
          onOpenWorkItem={(item) => navigate(
            createTeamIssuesPath(item.teamId, item.workItemId),
          )}
          onRetry={() => {
            resetFeedback()
            void Promise.all([
              mutateCurrentUser(),
              mutateProjectDirectory(),
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
    </main>
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
