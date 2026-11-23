import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { PORTFOLIO_WORKSPACE_TEAM_LIMIT, previousPortfolioMonth } from '@mukuroji/contracts'
import { saveTeamPortfolioSnapshot } from '../../features/portfolio-dashboard/api/portfolio'
import { createPortfolioDashboardModel } from '../../features/portfolio-dashboard/model/portfolioDashboard'
import {
  usePortfolioDashboard,
  usePortfolioSnapshots,
} from '../../features/portfolio-dashboard/queries/usePortfolioDashboard'
import { PortfolioDashboardView } from '../../features/portfolio-dashboard/ui/PortfolioDashboardView'
import { usePlanningSnapshot } from '../../planning/queries/usePlanningSnapshot'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import { createTranslator } from '../../shared/i18n/i18n'
import { createProjectOverviewPath } from '../../shared/routing/paths'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/** Number of past months offered for comparison. */
const COMPARE_MONTH_COUNT = 12

/**
 * Returns the reader's IANA timezone, falling back to UTC.
 *
 * @returns The timezone.
 */
function readBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Returns the local date and month of an instant in a timezone.
 *
 * @param now - Instant.
 * @param timeZone - IANA timezone.
 * @returns `YYYY-MM-DD` and `YYYY-MM`.
 */
function readLocalCalendar(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? ''
  const month = `${part('year')}-${part('month')}`
  return { today: `${month}-${part('day')}`, month }
}

/**
 * Renders the Workspace portfolio (PMO) dashboard route.
 *
 * Each Team's portfolio is read on its own through `GET /api/teams/:teamId/portfolio`, so one
 * failed Team is named in a notice instead of hiding the others.
 *
 * @returns Dashboard content inside the shared Workspace shell.
 */
export function PortfolioDashboardPage() {
  const workspace = useWorkspaceRouteContext()
  const navigate = useNavigate()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const timeZone = useMemo(readBrowserTimeZone, [])
  const calendar = useMemo(() => readLocalCalendar(new Date(), timeZone), [timeZone])
  const compareMonthOptions = useMemo(() => {
    const months: string[] = []
    let month = calendar.month
    for (let index = 0; index < COMPARE_MONTH_COUNT; index += 1) {
      month = previousPortfolioMonth(month)
      months.push(month)
    }
    return [calendar.month, ...months]
  }, [calendar.month])
  const [compareMonth, setCompareMonth] = useState<string | undefined>(() => previousPortfolioMonth(calendar.month))
  const [isSavingSnapshot, setIsSavingSnapshot] = useState(false)
  const [snapshotMessage, setSnapshotMessage] = useState<string>()
  const teamIds = useMemo(() => workspace.teams.map((team) => team.id), [workspace.teams])
  const accessToken = workspace.canLoadWorkspaceData ? workspace.accessToken : undefined
  const reads = usePortfolioDashboard(accessToken, teamIds, timeZone, workspace.softwareFactoryEnabled)
  const snapshots = usePortfolioSnapshots(accessToken, teamIds, compareMonth)
  const planning = usePlanningSnapshot(workspace.accessToken, workspace.canLoadWorkspaceData)
  const model = useMemo(
    () => createPortfolioDashboardModel({
      teams: workspace.teams,
      reads: reads.data?.teams ?? [],
      ...(compareMonth && snapshots.data ? { snapshots: snapshots.data } : {}),
      ...(planning.data ? { updateTargets: planning.data.updateTargets, planningEntities: planning.data.entities } : {}),
      today: calendar.today,
    }),
    [calendar.today, compareMonth, planning.data, reads.data, snapshots.data, workspace.teams],
  )
  const capturableTeamIds = (reads.data?.teams ?? [])
    .filter((read) => read.portfolio?.viewer.canCaptureSnapshot === true)
    .map((read) => read.teamId)

  /** Saves this month's snapshot of every Team the reader manages as a whole. */
  const saveSnapshots = async () => {
    const token = workspace.accessToken
    if (!token || capturableTeamIds.length === 0) return
    setIsSavingSnapshot(true)
    setSnapshotMessage(undefined)
    const failed: string[] = []
    for (const teamId of capturableTeamIds) {
      try {
        await saveTeamPortfolioSnapshot(token, teamId, calendar.month, timeZone, createMutationRequestContext())
      } catch {
        failed.push(workspace.teams.find((team) => team.id === teamId)?.name ?? teamId)
      }
    }
    setIsSavingSnapshot(false)
    const savedCount = capturableTeamIds.length - failed.length
    setSnapshotMessage(failed.length > 0
      ? t('portfolioDashboard.snapshot.failed').replace('{teams}', failed.join(', '))
      : t('portfolioDashboard.snapshot.saved').replace('{count}', String(savedCount)))
    if (compareMonth === calendar.month) void snapshots.mutate()
  }

  const isLoading = workspace.isLoading || (Boolean(accessToken) && reads.data === undefined && !reads.error)
  return (
    <WorkspaceRouteContent isLoading={isLoading} sessionErrors={[reads.error, planning.error]}>
      <div className="grid gap-5 px-[clamp(16px,3vw,34px)] py-5">
        {reads.error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-fg-red-700" role="alert">
            {t('portfolioDashboard.error.loading')}
          </p>
        ) : null}
        {reads.data?.tooManyTeams ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-fg-amber-800" role="status">
            {t('portfolioDashboard.error.tooManyTeams').replace('{limit}', String(PORTFOLIO_WORKSPACE_TEAM_LIMIT))}
          </p>
        ) : null}
        <PortfolioDashboardView
          canSaveSnapshot={capturableTeamIds.length > 0}
          compareMonthOptions={compareMonthOptions}
          isPlanningUnavailable={Boolean(planning.error)}
          isSavingSnapshot={isSavingSnapshot}
          locale={workspace.locale}
          model={model}
          showAgentRuns={workspace.softwareFactoryEnabled}
          t={t}
          teams={workspace.teams}
          onCompareMonthChange={setCompareMonth}
          onOpenProject={(teamId, projectId) => navigate(createProjectOverviewPath(projectId, teamId))}
          onSaveSnapshot={() => void saveSnapshots()}
          {...(compareMonth ? { compareMonth } : {})}
          {...(snapshotMessage ? { snapshotMessage } : {})}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
