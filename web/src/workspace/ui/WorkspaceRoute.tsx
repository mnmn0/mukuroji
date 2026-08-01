import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { matchPath, Outlet, useLocation } from 'react-router'
import { useWorkspaceCommandMenu } from '../../commands/ui/WorkspaceCommandMenuContext'
import type { ProjectDirectoryTeam } from '../../projects/api'
import {
  createSidebarLabels,
  createTranslator,
  type MessageKey,
} from '../../shared/i18n/i18n'
import {
  MobileSidebarButton,
  WorkspaceSidebar,
  WorkspaceSidebarProvider,
  useWorkspaceSidebarRouteState,
  type SidebarNavId,
  type SidebarTeamViewId,
} from '../../shared/ui/sidebar'
import { useWorkspaceRouteContext } from './WorkspaceRouteProvider'

/** Header and sidebar metadata owned by one authenticated workspace route. */
export type WorkspaceRouteMetadata = {
  /** The fixed sidebar navigation item highlighted for the route. */
  activeNavId?: SidebarNavId
  /** The active team ID extracted from a team-scoped route. */
  activeTeamId?: string
  /** The team view highlighted for a team-scoped route. */
  activeTeamViewId?: SidebarTeamViewId
  /** The active project ID highlighted by a project-scoped route. */
  activeProjectId?: string
  /** The team that owns the project highlighted by a project-scoped route. */
  activeProjectTeamId?: string | null
  /** Whether the route owns its own header and only uses the shared sidebar shell. */
  customHeader?: boolean
  /** Whether mobile sidebar selection closes the drawer before navigation completes. */
  closeMobileOnSelect?: boolean
  /** The translation key for the route header's eyebrow label. */
  eyebrowKey: MessageKey
  /** The translation key for the route's document and visible title. */
  titleKey: MessageKey
  /** The translation key for the route header's supporting description. */
  descriptionKey: MessageKey
}

/** Props accepted by content rendered inside the persistent Workspace route shell. */
export type WorkspaceRouteContentProps = {
  /** Route-specific content rendered inside the shared scroll container. */
  children: ReactNode
  /** Whether route-specific data is still loading. */
  isLoading?: boolean
  /** Route-specific errors considered only for enterprise session redirects. */
  sessionErrors?: readonly unknown[]
}

const dashboardRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'dashboard',
  eyebrowKey: 'workspace.dashboard.eyebrow',
  titleKey: 'workspace.dashboard.title',
  descriptionKey: 'workspace.dashboard.description',
}
const homeRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'home',
  eyebrowKey: 'workspace.home.eyebrow',
  titleKey: 'workspace.home.title',
  descriptionKey: 'workspace.home.description',
}
const myTasksRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'my-tasks',
  eyebrowKey: 'workspace.myTasks.eyebrow',
  titleKey: 'workspace.myTasks.title',
  descriptionKey: 'workspace.myTasks.description',
}
const inboxRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'inbox',
  eyebrowKey: 'workspace.inbox.eyebrow',
  titleKey: 'workspace.inbox.title',
  descriptionKey: 'workspace.inbox.description',
}
const helpRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'help',
  eyebrowKey: 'workspace.help.eyebrow',
  titleKey: 'workspace.help.title',
  descriptionKey: 'workspace.help.description',
}
const settingsRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'settings',
  eyebrowKey: 'workspace.settings.eyebrow',
  titleKey: 'workspace.settings.title',
  descriptionKey: 'workspace.settings.description',
}
const enterpriseSecurityRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'settings',
  eyebrowKey: 'security.page.eyebrow',
  titleKey: 'security.page.title',
  descriptionKey: 'security.page.description',
}
const teamOverviewRouteMetadata: WorkspaceRouteMetadata = {
  activeTeamViewId: 'overview',
  eyebrowKey: 'workspace.teamOverview.eyebrow',
  titleKey: 'workspace.teamOverview.title',
  descriptionKey: 'workspace.teamOverview.description',
}
const teamMembersRouteMetadata: WorkspaceRouteMetadata = {
  activeTeamViewId: 'members',
  eyebrowKey: 'workspace.teamMembers.eyebrow',
  titleKey: 'workspace.teamMembers.title',
  descriptionKey: 'workspace.teamMembers.description',
}
const requestRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'requests',
  customHeader: true,
  eyebrowKey: 'requests.eyebrow',
  titleKey: 'requests.title',
  descriptionKey: 'requests.description',
}
const searchRouteMetadata: WorkspaceRouteMetadata = {
  customHeader: true,
  eyebrowKey: 'search.eyebrow',
  titleKey: 'search.title',
  descriptionKey: 'search.description',
}
const planningRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'planning',
  customHeader: true,
  eyebrowKey: 'planning.eyebrow',
  titleKey: 'planning.title',
  descriptionKey: 'planning.description',
}
const documentRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'documents',
  closeMobileOnSelect: false,
  customHeader: true,
  eyebrowKey: 'documents.home.eyebrow',
  titleKey: 'documents.title',
  descriptionKey: 'documents.home.description',
}
const goalDocumentsRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'documents',
  customHeader: true,
  eyebrowKey: 'documents.backlinks.goal',
  titleKey: 'documents.related.title',
  descriptionKey: 'documents.backlinks.description',
}
const reportsRouteMetadata: WorkspaceRouteMetadata = {
  activeNavId: 'reports',
  customHeader: true,
  eyebrowKey: 'workspace.reports.eyebrow',
  titleKey: 'workspace.reports.title',
  descriptionKey: 'workspace.reports.description',
}
const teamIssuesRouteMetadata: WorkspaceRouteMetadata = {
  activeTeamViewId: 'issues',
  customHeader: true,
  eyebrowKey: 'issues.eyebrow',
  titleKey: 'issues.title',
  descriptionKey: 'issues.description',
}
const projectIssuesRouteMetadata: WorkspaceRouteMetadata = {
  customHeader: true,
  eyebrowKey: 'workspace.myTasks.eyebrow',
  titleKey: 'workspace.myTasks.title',
  descriptionKey: 'workspace.myTasks.description',
}
const emptySessionErrors: readonly unknown[] = []

/**
 * Renders the persistent authenticated sidebar, header, common boundary, and route outlet.
 *
 * @returns The shared Workspace shell used by all authenticated Workspace routes.
 */
export function WorkspaceRoute() {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  /**
   * Opens the persistent mobile sidebar drawer.
   *
   * @returns Nothing.
   */
  const openMobileSidebar = useCallback(() => {
    setIsMobileSidebarOpen(true)
  }, [])
  /**
   * Closes the persistent mobile sidebar drawer.
   *
   * @returns Nothing.
   */
  const closeMobileSidebar = useCallback(() => {
    setIsMobileSidebarOpen(false)
  }, [])
  const sidebarController = useMemo(
    () => ({ closeMobileSidebar, openMobileSidebar }),
    [closeMobileSidebar, openMobileSidebar],
  )

  return (
    <WorkspaceSidebarProvider controller={sidebarController}>
      <WorkspaceRouteShell
        closeMobileSidebar={closeMobileSidebar}
        isMobileSidebarOpen={isMobileSidebarOpen}
        openMobileSidebar={openMobileSidebar}
      />
    </WorkspaceSidebarProvider>
  )
}

/** Props accepted by the persistent Workspace shell implementation. */
type WorkspaceRouteShellProps = {
  /** Closes the shared mobile sidebar drawer. */
  closeMobileSidebar: () => void
  /** Whether the shared mobile sidebar drawer is open. */
  isMobileSidebarOpen: boolean
  /** Opens the shared mobile sidebar drawer. */
  openMobileSidebar: () => void
}

/**
 * Renders the Workspace shell after its shared sidebar context is available.
 *
 * @param props - Mobile sidebar state and controls owned by the shell.
 * @returns The persistent sidebar, route header, boundaries, and outlet.
 */
function WorkspaceRouteShell({
  closeMobileSidebar,
  isMobileSidebarOpen,
  openMobileSidebar,
}: WorkspaceRouteShellProps) {
  const workspace = useWorkspaceRouteContext()
  const location = useLocation()
  const commandMenu = useWorkspaceCommandMenu()
  const routeState = useWorkspaceSidebarRouteState()
  const t = useMemo(
    () => createTranslator(workspace.locale),
    [workspace.locale],
  )
  const sidebarLabels = useMemo(
    () => createSidebarLabels(workspace.locale),
    [workspace.locale],
  )
  const metadata = resolveWorkspaceRouteMetadata(
    location.pathname,
    location.search,
  )
  const activeTeam = resolveWorkspaceRouteActiveTeam(
    workspace.teams,
    metadata?.activeTeamId,
  )
  const activeProjectTeamId = resolveWorkspaceRouteProjectTeamId(
    workspace.teams,
    metadata?.activeProjectId,
    metadata?.activeProjectTeamId,
  ) ?? routeState.activeProjectTeamId
  const onArchiveTeam = workspace.onArchiveTeam
  const onArchiveProject = workspace.onArchiveProject
  const onSelectNav = workspace.onSelectNav
  /**
   * Archives a Team and leaves the route when the archived Team is visible.
   *
   * @param teamId - The Team ID to archive.
   * @returns A promise that resolves after the archive operation completes.
   */
  const handleArchiveTeam = async (teamId: string) => {
    if (!onArchiveTeam) {
      return
    }

    await onArchiveTeam(teamId)

    const isActiveTeamArchived =
      metadata?.activeTeamId === teamId ||
      (metadata?.activeProjectId !== undefined &&
        activeProjectTeamId === teamId)

    if (isActiveTeamArchived) {
      onSelectNav('dashboard')
    }
  }
  /**
   * Archives a Project and leaves the route when the archived Project is visible.
   *
   * @param teamId - The owning Team ID.
   * @param projectId - The Project ID to archive.
   * @returns A promise that resolves after the archive operation completes.
   */
  const handleArchiveProject = async (
    teamId: string,
    projectId: string,
  ) => {
    if (!onArchiveProject) {
      return
    }

    await onArchiveProject(teamId, projectId)

    if (
      metadata?.activeProjectId === projectId &&
      activeProjectTeamId === teamId
    ) {
      onSelectNav('dashboard')
    }
  }
  const activeTeamLabel = activeTeam?.name ?? t('workspace.team.missing')
  const title = metadata
    ? formatWorkspaceTeamText(t(metadata.titleKey), activeTeamLabel)
    : t('app.title')
  const description = metadata
    ? formatWorkspaceTeamText(t(metadata.descriptionKey), activeTeamLabel)
    : ''
  const commonSessionErrorAction = workspace.resolveSessionErrors()
  const commonSessionRedirectTo = commonSessionErrorAction?.redirectTo
  const commonSessionErrorActionKind = commonSessionErrorAction?.kind
  const shouldClearCommonSession =
    commonSessionErrorAction?.clearSession ?? false
  const onCommonSessionErrorAction = workspace.onSessionErrorAction
  const isCommonSessionRedirecting = commonSessionRedirectTo !== undefined
  const commonErrorMessage = workspace.commonErrorKey &&
    !isCommonSessionRedirecting
    ? t(workspace.commonErrorKey)
    : undefined

  useEffect(() => {
    document.documentElement.lang = workspace.locale
    if (metadata?.customHeader) {
      return
    }

    document.title = metadata
      ? `${title} | ${t('app.title')}`
      : t('app.title')
  }, [metadata, t, title, workspace.locale])

  useEffect(() => {
    if (!commonSessionRedirectTo || !commonSessionErrorActionKind) {
      return
    }

    onCommonSessionErrorAction({
      clearSession: shouldClearCommonSession,
      kind: commonSessionErrorActionKind,
      redirectTo: commonSessionRedirectTo,
    })
  }, [
    commonSessionErrorActionKind,
    commonSessionRedirectTo,
    onCommonSessionErrorAction,
    shouldClearCommonSession,
  ])

  return (
      <main className="workbench-shell flex h-svh min-h-0 overflow-hidden">
        <WorkspaceSidebar
          activeNavId={metadata?.activeNavId}
          activeTeamId={metadata?.activeTeamViewId ? activeTeam?.id : undefined}
          activeTeamViewId={metadata?.activeTeamViewId}
          activeProjectId={metadata?.activeProjectId}
          activeProjectTeamId={metadata?.activeProjectId
            ? activeProjectTeamId ?? null
            : undefined}
          closeMobileOnSelect={metadata?.closeMobileOnSelect}
          inboxCount={workspace.inboxCount}
          isMobileOpen={isMobileSidebarOpen}
          labels={sidebarLabels}
          mobileCloseLabel={t('sidebar.mobileClose')}
          mobileDialogLabel={t('sidebar.mobileDialog')}
          onArchiveProject={onArchiveProject ? handleArchiveProject : undefined}
          onArchiveTeam={onArchiveTeam ? handleArchiveTeam : undefined}
          onCreateProject={workspace.onCreateProject}
          onCreateTeam={workspace.onCreateTeam}
          onMobileClose={closeMobileSidebar}
          onOpenSearch={() => {
            closeMobileSidebar()
            commandMenu.open?.()
          }}
          onSelectNav={workspace.onSelectNav}
          onSelectProject={workspace.onSelectProject}
          onSelectTeamView={workspace.onSelectTeamView}
          teams={workspace.teams}
        />

        <section
          aria-busy={routeState.isBusy}
          className="workbench-main flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          {metadata && !metadata.customHeader ? (
            <header className="workbench-header flex-none px-[clamp(20px,3vw,34px)] py-4">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <MobileSidebarButton
                    label={t('sidebar.mobileOpen')}
                    onClick={openMobileSidebar}
                  />
                  <div className="min-w-0">
                    <p className="workbench-eyebrow">
                      {t(metadata.eyebrowKey)}
                    </p>
                    <h1 className="workbench-title mt-2 text-page-title">
                      {title}
                    </h1>
                    <p className="workbench-description mt-2 max-w-[760px]">
                      {description}
                    </p>
                  </div>
                </div>

                <div className="flex flex-none items-center gap-3">
                  <div className="hidden text-right max-[720px]:sr-only min-[721px]:block">
                    <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                      {t('workspace.user.label')}
                    </p>
                    <p className="mt-1 max-w-[220px] truncate text-sm font-semibold text-[var(--workbench-text)]">
                      {workspace.userLabel}
                    </p>
                  </div>
                  <div className="grid h-10 w-10 place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-sm font-semibold text-[var(--workbench-primary)]">
                    {workspace.userInitial}
                  </div>
                  <button
                    className="workbench-button-secondary min-h-10 px-4"
                    type="button"
                    onClick={workspace.onLogout}
                  >
                    {t('dashboard.logout')}
                  </button>
                </div>
              </div>
            </header>
          ) : null}

        {commonErrorMessage ? (
          <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-[clamp(20px,3vw,34px)] py-7">
            <div
              className="grid justify-items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700"
              data-testid="workspace-common-error"
              role="alert"
            >
              <p>{commonErrorMessage}</p>
              <button
                className="workbench-button-secondary min-h-10 px-4"
                onClick={() => void workspace.onRetryCommonData()}
                type="button"
              >
                {t('workspace.error.retry')}
              </button>
            </div>
          </div>
        ) : workspace.isLoading || isCommonSessionRedirecting ? (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-sm font-medium text-[var(--workbench-muted)]">
            {t('workspace.loading')}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain">
            {/* Child screens use this shell-owned container as their sole page scroller. */}
            <Outlet context={workspace} />
          </div>
        )}
        </section>
      </main>
  )
}

/**
 * Applies route-specific loading and enterprise session handling within the shared shell.
 *
 * @param props - Route content, loading state, and errors eligible for session redirects.
 * @returns Route content or the shared loading indicator while the route is unavailable.
 */
export function WorkspaceRouteContent({
  children,
  isLoading = false,
  sessionErrors = emptySessionErrors,
}: WorkspaceRouteContentProps) {
  const workspace = useWorkspaceRouteContext()
  const t = useMemo(
    () => createTranslator(workspace.locale),
    [workspace.locale],
  )
  const sessionErrorAction = workspace.resolveSessionErrors(sessionErrors)
  const sessionRedirectTo = sessionErrorAction?.redirectTo
  const sessionErrorActionKind = sessionErrorAction?.kind
  const shouldClearSession = sessionErrorAction?.clearSession ?? false
  const onSessionErrorAction = workspace.onSessionErrorAction
  const isRedirecting = sessionRedirectTo !== undefined

  useEffect(() => {
    if (!sessionRedirectTo || !sessionErrorActionKind) {
      return
    }

    onSessionErrorAction({
      clearSession: shouldClearSession,
      kind: sessionErrorActionKind,
      redirectTo: sessionRedirectTo,
    })
  }, [
    onSessionErrorAction,
    sessionErrorActionKind,
    sessionRedirectTo,
    shouldClearSession,
  ])

  if (isLoading || isRedirecting) {
    return (
      <div className="grid min-h-full place-items-center px-6 text-sm font-medium text-[var(--workbench-muted)]">
        {t('workspace.loading')}
      </div>
    )
  }

  return children
}

/**
 * Resolves static route metadata and dynamic team parameters for the current pathname.
 *
 * @param pathname - The current URL pathname.
 * @param search - The current URL query string.
 * @returns Metadata for a supported split Workspace route, or `undefined`.
 */
function resolveWorkspaceRouteMetadata(
  pathname: string,
  search: string,
): WorkspaceRouteMetadata | undefined {
  if (matchPath('/settings/security', pathname)) {
    return enterpriseSecurityRouteMetadata
  }

  if (matchPath('/dashboard', pathname)) {
    return dashboardRouteMetadata
  }

  if (matchPath('/home', pathname)) {
    return homeRouteMetadata
  }

  if (matchPath('/my-tasks', pathname)) {
    return myTasksRouteMetadata
  }

  if (matchPath('/inbox', pathname)) {
    return inboxRouteMetadata
  }

  if (matchPath('/help', pathname)) {
    return helpRouteMetadata
  }

  if (matchPath('/settings', pathname)) {
    return settingsRouteMetadata
  }

  if (matchPath('/requests', pathname)) {
    return requestRouteMetadata
  }

  if (matchPath('/search', pathname)) {
    return searchRouteMetadata
  }

  if (
    matchPath('/planning', pathname) ||
    matchPath('/planning/*', pathname)
  ) {
    return planningRouteMetadata
  }

  if (
    matchPath('/documents', pathname) ||
    matchPath('/documents/*', pathname)
  ) {
    return documentRouteMetadata
  }

  const goalDocumentsMatch = matchPath('/goals/:goalId/documents', pathname)

  if (goalDocumentsMatch) {
    return goalDocumentsRouteMetadata
  }

  if (matchPath('/reports', pathname)) {
    return reportsRouteMetadata
  }

  const teamIssuesMatch = matchPath('/teams/:teamId/issues', pathname)

  if (teamIssuesMatch?.params.teamId) {
    return {
      ...teamIssuesRouteMetadata,
      activeTeamId: decodeWorkspaceRouteParameter(teamIssuesMatch.params.teamId),
    }
  }

  const projectIssuesMatch = matchPath('/projects/:projectId/issues', pathname)

  if (projectIssuesMatch?.params.projectId) {
    const teamId = new URLSearchParams(search).get('teamId')

    return {
      ...projectIssuesRouteMetadata,
      activeProjectId: decodeWorkspaceRouteParameter(projectIssuesMatch.params.projectId),
      activeProjectTeamId: teamId ?? null,
    }
  }

  const teamOverviewMatch = matchPath('/teams/:teamId/overview', pathname)
  const overviewTeamId = teamOverviewMatch?.params.teamId

  if (overviewTeamId) {
    return {
      ...teamOverviewRouteMetadata,
      activeTeamId: decodeWorkspaceRouteParameter(overviewTeamId),
    }
  }

  const teamMembersMatch = matchPath('/teams/:teamId/members', pathname)
  const membersTeamId = teamMembersMatch?.params.teamId

  if (membersTeamId) {
    return {
      ...teamMembersRouteMetadata,
      activeTeamId: decodeWorkspaceRouteParameter(membersTeamId),
    }
  }

  return undefined
}

/**
 * Decodes a route parameter while preserving malformed input for the missing-team state.
 *
 * @param value - The encoded parameter captured from the pathname.
 * @returns The decoded parameter, or the original value when decoding fails.
 */
function decodeWorkspaceRouteParameter(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Resolves the team represented by a route without falling back from an invalid explicit ID.
 *
 * @param teams - The shared workspace team directory.
 * @param activeTeamId - The optional team ID supplied by the current route.
 * @returns The exact matching team, the first team when no ID is supplied, or `undefined`.
 */
function resolveWorkspaceRouteActiveTeam(
  teams: readonly ProjectDirectoryTeam[],
  activeTeamId?: string,
) {
  if (activeTeamId !== undefined) {
    return teams.find((team) => team.id === activeTeamId)
  }

  return teams[0]
}

/**
 * Resolves the Team that owns the active Project route when that scope is unambiguous.
 *
 * @param teams - The shared workspace team directory.
 * @param projectId - The active Project route parameter.
 * @param selectedTeamId - The optional Team selected by the route query string.
 * @returns The selected or sole owning Team ID, or `undefined` for an ambiguous scope.
 */
function resolveWorkspaceRouteProjectTeamId(
  teams: readonly ProjectDirectoryTeam[],
  projectId?: string,
  selectedTeamId?: string | null,
) {
  if (!projectId) {
    return undefined
  }

  if (
    selectedTeamId &&
    teams.some((team) =>
      team.id === selectedTeamId &&
      team.projects.some((project) => project.id === projectId),
    )
  ) {
    return selectedTeamId
  }

  const projectTeamIds = teams
    .filter((team) => team.projects.some((project) => project.id === projectId))
    .map((team) => team.id)

  return projectTeamIds.length === 1 ? projectTeamIds[0] : undefined
}

/**
 * Replaces the team placeholder used by team-scoped workspace route messages.
 *
 * @param value - A translated route header string.
 * @param teamName - The resolved team label shown by the route.
 * @returns The translated string with its first team placeholder replaced.
 */
function formatWorkspaceTeamText(value: string, teamName: string) {
  return value.replace('{team}', teamName)
}
