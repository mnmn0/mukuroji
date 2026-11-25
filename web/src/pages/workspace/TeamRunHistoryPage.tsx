import type { AgentRunHistoryFilters } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { DEFAULT_RUN_HISTORY_PERIOD_DAYS, toRunHistoryCsv } from '../../features/factory-board/model/runHistory'
import { useAgentRunHistory } from '../../features/factory-board/queries/useFactoryBoard'
import { RunHistoryView, type RunHistoryFilterState } from '../../features/factory-board/ui/RunHistoryView'
import { createRunHistoryLabels } from '../../features/factory-board/ui/runHistoryLabels'
import { createProjectIssuesPath, createTeamIssuesPath, createTeamViewPath } from '../../shared/routing/paths'
import { SoftwareFactoryGate } from '../../workspace/ui/SoftwareFactoryGate'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/** Filters the history opens with: every Team the viewer can view, the last week. */
const initialFilters: RunHistoryFilterState = {
  days: DEFAULT_RUN_HISTORY_PERIOD_DAYS,
  teamId: '',
  outcome: '',
  runtime: '',
  projectId: '',
  mineOnly: false,
}

/**
 * Offers CSV text as a UTF-8 file download.
 *
 * @param csv - CSV text.
 * @param fileName - Offered file name.
 */
function downloadCsv(csv: string, fileName: string) {
  // The byte order mark makes Excel read the UTF-8 file, including Japanese text, correctly.
  const objectUrl = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

/**
 * Renders the Run history across the Teams the viewer can view, opened from a Team's Factory board.
 *
 * @returns Run history content.
 */
export function TeamRunHistoryPage() {
  const teamId = useParams().teamId
  return (
    <SoftwareFactoryGate fallbackPath={teamId ? createTeamIssuesPath(teamId) : '/'}>
      <TeamRunHistoryContent teamId={teamId} />
    </SoftwareFactoryGate>
  )
}

/** Props of the Run history content. */
type TeamRunHistoryContentProps = {
  /** Team whose Factory board opened the history; the back link returns to it. */
  teamId: string | undefined
}

/**
 * Reads and shows the Run history with its filters and CSV download.
 *
 * @param props - Team whose board opened the history.
 * @returns Run history content.
 */
function TeamRunHistoryContent({ teamId }: TeamRunHistoryContentProps) {
  const workspace = useWorkspaceRouteContext()
  const navigate = useNavigate()
  const [filters, setFilters] = useState<RunHistoryFilterState>(initialFilters)
  const labels = useMemo(() => createRunHistoryLabels(workspace.locale), [workspace.locale])
  const teams = useMemo(() => workspace.teams.map((team) => ({ id: team.id, name: team.name })), [workspace.teams])
  const teamNames = useMemo(() => Object.fromEntries(teams.map((team) => [team.id, team.name])), [teams])
  const projectNames = useMemo(
    () => Object.fromEntries(workspace.teams.flatMap((team) => (team.projects ?? []).map((project) => [project.id, project.name]))),
    [workspace.teams],
  )
  const projects = useMemo(
    () => workspace.teams
      .filter((team) => filters.teamId === '' || team.id === filters.teamId)
      .flatMap((team) => (team.projects ?? []).map((project) => ({ id: project.id, name: project.name }))),
    [workspace.teams, filters.teamId],
  )
  const teamIds = useMemo(
    () => filters.teamId === '' ? teams.map((team) => team.id) : [filters.teamId],
    [teams, filters.teamId],
  )
  const requestFilters = useMemo<AgentRunHistoryFilters>(() => ({
    ...(filters.outcome === '' ? {} : { outcome: filters.outcome }),
    ...(filters.runtime === '' ? {} : { runtime: filters.runtime }),
    ...(filters.projectId === '' ? {} : { projectId: filters.projectId }),
    ...(filters.mineOnly && workspace.userKey ? { assigneeUserId: workspace.userKey } : {}),
  }), [filters, workspace.userKey])
  const accessToken = workspace.canLoadWorkspaceData ? workspace.accessToken : undefined
  const history = useAgentRunHistory(accessToken, teamIds, filters.days, requestFilters, teamNames)
  const formatDateTime = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(workspace.locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
    return (value: string) => formatter.format(new Date(value))
  }, [workspace.locale])

  return (
    <WorkspaceRouteContent isLoading={false} sessionErrors={[history.error]}>
      <div className="flex flex-col gap-4 px-[clamp(16px,3vw,34px)] py-5">
        {teamId ? (
          <Link className="w-fit text-sm text-[var(--workbench-primary-text)] underline-offset-2 hover:underline" to={createTeamViewPath(teamId, 'factory')}>
            {labels.backToBoard}
          </Link>
        ) : null}
        <RunHistoryView
          errorMessage={history.error ? labels.loadError : undefined}
          filters={filters}
          formatDateTime={formatDateTime}
          getWorkItemHref={(row) => row.projectId
            ? createProjectIssuesPath(row.projectId, row.teamId, row.workItemId)
            : createTeamIssuesPath(row.teamId, row.workItemId)}
          history={history.data}
          isLoading={history.isLoading}
          labels={labels}
          onDownload={() => {
            if (!history.data) return
            const memberNames: Record<string, string> = workspace.userKey ? { [workspace.userKey]: workspace.userLabel } : {}
            const csv = toRunHistoryCsv(history.data.rows, labels, projectNames, memberNames)
            downloadCsv(csv, `run-history-${new Date().toISOString().slice(0, 10)}.csv`)
          }}
          onFiltersChange={setFilters}
          onNavigate={(href) => { void navigate(href) }}
          onRetry={() => { void history.mutate() }}
          projectNames={projectNames}
          projects={projects}
          teams={teams}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
