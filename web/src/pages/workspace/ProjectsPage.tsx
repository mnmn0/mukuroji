import { useCallback, useEffect, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router'
import {
  createProjectDirectoryAssigneeOptions,
  createProjectDirectoryRows,
  filterProjectDirectoryRows,
  paginateProjectDirectoryRows,
  parseProjectDirectoryPage,
  type ProjectDirectoryStatusFilter,
} from '../../projects/model/projectDirectoryView'
import { ProjectDirectoryView } from '../../projects/ui/ProjectDirectoryView'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  MobileSidebarButton,
  useWorkspaceSidebarController,
} from '../../shared/ui/sidebar'
import { useWorkspaceWorkItemData } from '../../workspace/queries/useWorkspaceWorkItemData'
import { WorkspaceTaskLoadNotice } from '../../workspace/ui/WorkspaceDataNotices'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/** Supported Project status values persisted in the route query string. */
const projectDirectoryStatusFilters: readonly ProjectDirectoryStatusFilter[] = [
  'all',
  'active',
  'attention',
  'completed',
  'not-started',
]

/**
 * Renders the searchable Project directory for the Workspace or one selected Team.
 *
 * @returns URL-backed Project discovery inside the persistent Workspace shell.
 */
export function ProjectsPage() {
  const workspace = useWorkspaceRouteContext()
  const { openMobileSidebar } = useWorkspaceSidebarController()
  const { teamId: routeTeamId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const workItems = useWorkspaceWorkItemData(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
    workspace.teams,
  )
  const routeTeam = workspace.teams.find((team) => team.id === routeTeamId)
  const selectedTeamId = routeTeamId ?? searchParams.get('teamId') ?? undefined
  const status = parseProjectDirectoryStatus(searchParams.get('status'))
  const assigneeId = searchParams.get('assignee') ?? undefined
  const query = searchParams.get('q') ?? ''
  const quickAccessValue = searchParams.get('quickAccess')
  const quickAccessOnly = quickAccessValue === 'true' || quickAccessValue === '1'
  const filters = useMemo(() => ({
    assigneeId,
    query,
    quickAccessOnly,
    status,
    teamId: selectedTeamId,
  }), [assigneeId, query, quickAccessOnly, selectedTeamId, status])
  const rows = useMemo(
    () => createProjectDirectoryRows(
      workspace.teams,
      workItems.tasks,
      workspace.isProjectQuickAccess,
    ),
    [
      workItems.tasks,
      workspace.isProjectQuickAccess,
      workspace.teams,
    ],
  )
  const routeRows = useMemo(
    () => routeTeamId
      ? rows.filter((row) => row.teamId === routeTeamId)
      : rows,
    [routeTeamId, rows],
  )
  const filteredRows = useMemo(
    () => filterProjectDirectoryRows(routeRows, filters),
    [filters, routeRows],
  )
  const assigneeOptions = useMemo(
    () => createProjectDirectoryAssigneeOptions(selectedTeamId
      ? routeRows.filter((row) => row.teamId === selectedTeamId)
      : routeRows),
    [routeRows, selectedTeamId],
  )
  const page = paginateProjectDirectoryRows(
    filteredRows,
    parseProjectDirectoryPage(searchParams.get('page')),
  )
  const teamLabel = routeTeam?.name ?? t('workspace.team.missing')
  const title = routeTeamId
    ? t('projects.directory.teamTitle').replace('{team}', teamLabel)
    : t('projects.directory.title')
  const description = routeTeamId
    ? t('projects.directory.teamDescription').replace('{team}', teamLabel)
    : t('projects.directory.description')

  useEffect(() => {
    document.title = `${title} | ${t('app.title')}`
  }, [t, title])

  /** Replaces one URL-backed filter and returns to the first result page. */
  const replaceFilter = useCallback((key: string, value?: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (value) {
        next.set(key, value)
      } else {
        next.delete(key)
      }
      next.delete('page')
      return next
    }, { replace: true })
  }, [setSearchParams])

  /** Changes only the bounded page while preserving active filters. */
  const replacePage = useCallback((nextPage: number) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (nextPage <= 1) {
        next.delete('page')
      } else {
        next.set('page', String(nextPage))
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  /** Clears optional facets while retaining the Team encoded in the route itself. */
  const clearFilters = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true })
  }, [setSearchParams])

  return (
    <>
      <header className="workbench-header flex-none px-[clamp(20px,3vw,34px)] py-4">
        <div className="flex min-w-0 items-start gap-3">
          <MobileSidebarButton
            label={t('sidebar.mobileOpen')}
            onClick={openMobileSidebar}
          />
          <div className="min-w-0">
            <p className="workbench-eyebrow">{t('projects.directory.eyebrow')}</p>
            <h1 className="workbench-title mt-2 text-page-title" id="project-directory-title">
              {title}
            </h1>
            <p className="workbench-description mt-2 max-w-[760px]">{description}</p>
          </div>
        </div>
      </header>

      <WorkspaceRouteContent
        isLoading={workItems.isLoading}
        sessionErrors={[
          workItems.workItemsError,
          workItems.configurationsError,
          ...workItems.configurationErrors,
        ]}
      >
        <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
          <WorkspaceTaskLoadNotice
            failedProjectCount={workItems.failedProjectCount}
            t={t}
          />
          <ProjectDirectoryView
            assignees={assigneeOptions.assignees}
            filteredCount={filteredRows.length}
            filters={filters}
            hasUnassignedProjects={assigneeOptions.hasUnassignedProjects}
            isQuickAccessSaving={workspace.isQuickAccessSaving}
            isQuickAccessUnavailable={workspace.hasQuickAccessLoadError}
            isTeamFilterLocked={routeTeamId !== undefined}
            page={page.page}
            pageCount={page.pageCount}
            rows={page.rows}
            t={t}
            teams={routeTeamId
              ? routeTeam
                ? [routeTeam]
                : []
              : workspace.teams}
            totalCount={routeRows.length}
            onArchiveProject={workspace.onArchiveProject
              ? async (project) => workspace.onArchiveProject?.(
                  project.teamId,
                  project.projectId,
                )
              : undefined}
            onAssigneeChange={(assigneeId) => replaceFilter('assignee', assigneeId)}
            onClearFilters={clearFilters}
            onOpenProject={(project) => workspace.onSelectProject(
              project.projectId,
              project.teamId,
            )}
            onPageChange={replacePage}
            onQuickAccessOnlyChange={(quickAccessOnly) =>
              replaceFilter('quickAccess', quickAccessOnly ? 'true' : undefined)}
            onSearchChange={(query) => replaceFilter('q', query)}
            onStatusChange={(nextStatus) =>
              replaceFilter('status', nextStatus === 'all' ? undefined : nextStatus)}
            onTeamChange={(teamId) => replaceFilter('teamId', teamId)}
            onToggleQuickAccess={(project) => workspace.onToggleProjectQuickAccess(
              { projectId: project.projectId, teamId: project.teamId },
              project.projectName,
            )}
          />
        </div>
      </WorkspaceRouteContent>
    </>
  )
}

/**
 * Parses a raw status query value while ignoring unsupported deep-link values.
 *
 * @param value - Raw status query value.
 * @returns A supported status filter, or the unfiltered value.
 */
function parseProjectDirectoryStatus(
  value: string | null,
): ProjectDirectoryStatusFilter {
  return projectDirectoryStatusFilters.find((status) => status === value) ?? 'all'
}
