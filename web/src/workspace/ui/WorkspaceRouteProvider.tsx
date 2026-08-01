import {
  PROJECT_QUICK_ACCESS_MAX_ITEMS,
  type ProjectQuickAccessItem,
  type ProjectQuickAccessPreferences,
} from '@mukuroji/contracts'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Navigate,
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
  useOutletContext,
} from 'react-router'
import {
  canManageWorkspaceStructure,
  canMutateWorkspaceContent,
} from '../../auth/api'
import {
  resolveEnterpriseSessionErrorAction,
  resolveEnterpriseSessionErrorsAction,
  type EnterpriseSessionErrorAction,
} from '../../auth/enterpriseSessionErrors'
import { useCurrentUser } from '../../auth/queries/useCurrentUser'
import { clearAuthSession, getAuthSession, type AuthSession } from '../../auth/session'
import type { InboxNotification } from '../../notifications/api'
import { resolveNotificationPath } from '../../notifications/model/paths'
import { useNotificationUnreadCount } from '../../notifications/queries/useNotificationUnreadCount'
import type {
  NotificationPreferencesSessionErrorReporter,
} from '../../notifications/queries/useNotificationPreferences'
import {
  archiveProjectDirectoryProject,
  archiveProjectDirectoryTeam,
  createProjectDirectoryProject,
  createProjectDirectoryTeam,
  type CreateProjectDirectoryProjectInput,
  type CreateProjectDirectoryTeamInput,
  type ProjectDirectoryTeam,
  replaceProjectQuickAccess,
} from '../../projects/api'
import {
  canUndoProjectQuickAccess,
  isProjectInQuickAccess,
  moveProjectQuickAccessItem,
  resolveProjectQuickAccessItems,
  toggleProjectQuickAccess,
  type ProjectQuickAccessFeedback,
  type ResolvedProjectQuickAccessItem,
} from '../../projects/model/projectQuickAccess'
import { useProjectDirectory } from '../../projects/queries/useProjectDirectory'
import { useProjectQuickAccess } from '../../projects/queries/useProjectQuickAccess'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import {
  createTranslator,
  getInitialLocale,
  setLocalePreference,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import {
  getInitialFontSizePreference,
  setFontSizePreference,
  type FontSizePreference,
} from '../../shared/lib/preferences/fontSize'
import {
  createProjectIssuesPath,
  createTeamIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../../shared/routing/paths'
import type { SidebarNavId, SidebarTeamViewId } from '../../shared/ui/sidebar'
import type { ProjectTask } from '../../tasks/api'
import {
  type AuthenticatedApiErrorReports,
  listAuthenticatedApiErrors,
  updateAuthenticatedApiErrorReport,
} from '../model/authenticatedApiErrors'
import { resolveWorkspaceCommonErrorKey } from '../model/workspaceRouteErrors'

/** Shared data and actions exposed to authenticated workspace routes. */
export type WorkspaceRouteContextValue = {
  /** The access token used by authenticated workspace API requests. */
  accessToken?: string
  /** The locale selected for workspace content and controls. */
  locale: Locale
  /** The selected application font-size preference. */
  fontSizePreference: FontSizePreference
  /** The best available display label for the current user. */
  userLabel: string
  /** Stable identifiers that route models may use to recognize the current user. */
  userIdentityAliases: string[]
  /** The uppercase initial displayed by the shared workspace header. */
  userInitial: string
  /** The team and project directory displayed by the shared sidebar. */
  teams: ProjectDirectoryTeam[]
  /** Stored Team/Project references in the viewer's stable quick-access order. */
  quickAccessItems: ProjectQuickAccessItem[]
  /** Quick-access references resolved against the current readable directory. */
  quickAccessProjects: ResolvedProjectQuickAccessItem[]
  /** Whether a quick-access replacement is currently being saved. */
  isQuickAccessSaving: boolean
  /** Whether the initial non-blocking quick-access preference is still loading. */
  isQuickAccessLoading: boolean
  /** Whether quick access could not be loaded and mutations are unavailable. */
  hasQuickAccessLoadError: boolean
  /** Latest quick-access mutation feedback shown by the shared shell. */
  quickAccessFeedback?: ProjectQuickAccessFeedback
  /** The current user's unread notification count. */
  inboxCount: number
  /** Whether the current user may create or archive workspace structure. */
  canManageWorkspaceConfiguration: boolean
  /** Whether the current user may perform team-scoped content mutations. */
  canMutateTeamConfiguration: boolean
  /** Whether route-specific workspace queries may load authenticated data. */
  canLoadWorkspaceData: boolean
  /** Whether authentication or common workspace data is still loading. */
  isLoading: boolean
  /** The shared error message shown for a generic common-data load failure. */
  commonErrorKey?: MessageKey
  /** Runs an authenticated request and reports failures to the session guard. */
  guardEnterpriseSession: <Result>(request: Promise<Result>) => Promise<Result>
  /** Reports notification-preference errors for enterprise session policy handling. */
  reportNotificationPreferencesError: NotificationPreferencesSessionErrorReporter
  /** Resolves common and route errors into one prioritized session action. */
  resolveSessionErrors: (
    routeSessionErrors?: readonly unknown[],
  ) => EnterpriseSessionErrorAction | undefined
  /** Applies a resolved session redirect and clears stored credentials when required. */
  onSessionErrorAction: (action: EnterpriseSessionErrorAction) => void
  /** Retries the common query that produced the shared error boundary. */
  onRetryCommonData: () => Promise<void>
  /** Retries the non-blocking quick-access query after a load failure. */
  onRetryProjectQuickAccess: () => Promise<void>
  /** Persists and applies a new font-size preference. */
  onFontSizePreferenceChange: (preference: FontSizePreference) => void
  /** Persists and applies a new workspace locale. */
  onLocaleChange: (locale: Locale) => void
  /** Clears the authentication session and returns to the public entry route. */
  onLogout: () => void
  /** Navigates to a fixed workspace sidebar destination. */
  onSelectNav: (navId: SidebarNavId) => void
  /** Navigates to a fixed view owned by a team. */
  onSelectTeamView: (teamId: string, viewId: SidebarTeamViewId) => void
  /** Navigates to a project's issue route within its owning team. */
  onSelectProject: (projectId: string, teamId: string) => void
  /** Tests whether one Team-owned Project is currently starred. */
  isProjectQuickAccess: (item: ProjectQuickAccessItem) => boolean
  /** Adds or removes one Team-owned Project from quick access. */
  onToggleProjectQuickAccess: (
    item: ProjectQuickAccessItem,
    projectName: string,
  ) => Promise<void>
  /** Moves one starred Project by one stable-order position. */
  onMoveProjectQuickAccess: (
    item: ProjectQuickAccessItem,
    direction: 'up' | 'down',
  ) => Promise<void>
  /** Removes one Project from quick access and exposes Undo feedback. */
  onRemoveProjectQuickAccess: (
    item: ProjectQuickAccessItem,
    projectName: string,
  ) => Promise<void>
  /** Restores the quick-access order captured by the latest feedback. */
  onUndoProjectQuickAccess: () => Promise<void>
  /** Dismisses the current quick-access feedback surface. */
  onDismissProjectQuickAccessFeedback: () => void
  /** Navigates to the issue route represented by a workspace task. */
  onOpenTask: (task: ProjectTask) => void
  /** Navigates to the supported workspace destination represented by a notification. */
  onOpenNotification: (notification: InboxNotification) => void
  /** Creates a team when the current user may manage workspace structure. */
  onCreateTeam?: (input: CreateProjectDirectoryTeamInput) => Promise<void>
  /** Creates a project when the current user may manage workspace structure. */
  onCreateProject?: (
    teamId: string,
    input: CreateProjectDirectoryProjectInput,
  ) => Promise<void>
  /** Archives a team when the current user may manage workspace structure. */
  onArchiveTeam?: (teamId: string) => Promise<void>
  /** Archives a project when the current user may manage workspace structure. */
  onArchiveProject?: (teamId: string, projectId: string) => Promise<void>
}

const emptyProjectDirectory: ProjectDirectoryTeam[] = []
const emptySessionErrors: readonly unknown[] = []
const emptyProjectQuickAccess: ProjectQuickAccessPreferences = {
  items: [],
  revision: 0,
}

/**
 * Provides authentication, common workspace data, and shared actions to pathless child routes.
 *
 * @returns A React Router outlet carrying the shared workspace route context.
 */
export function WorkspaceRouteProvider() {
  const location = useLocation()
  const navigate = useNavigate()
  const activeTeamMatch = useMatch('/teams/:teamId/*')
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const [session] = useState<AuthSession | null>(() => getAuthSession())
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale())
  const [fontSizePreference, setFontSizePreferenceState] =
    useState<FontSizePreference>(() => getInitialFontSizePreference())
  const [authenticatedApiErrorReports, setAuthenticatedApiErrorReports] =
    useState<AuthenticatedApiErrorReports>({
      guardedSessionErrors: [],
    })
  const [isQuickAccessSaving, setIsQuickAccessSaving] = useState(false)
  const quickAccessSaveInFlightRef = useRef(false)
  const [quickAccessFeedback, setQuickAccessFeedback] =
    useState<ProjectQuickAccessFeedback>()
  const t = useMemo(() => createTranslator(locale), [locale])
  const accessToken = session?.accessToken
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
    mutate: mutateCurrentUser,
  } = useCurrentUser(accessToken)
  const {
    data: teams = emptyProjectDirectory,
    error: projectDirectoryError,
    isLoading: isProjectDirectoryLoading,
    mutate: mutateProjectDirectory,
  } = useProjectDirectory({
    accessToken,
    enabled: Boolean(user && !currentUserError),
    locale,
  })
  const {
    data: quickAccessPreference = emptyProjectQuickAccess,
    error: quickAccessError,
    isLoading: isQuickAccessLoading,
    mutate: mutateProjectQuickAccess,
  } = useProjectQuickAccess({
    accessToken,
    enabled: Boolean(user && !currentUserError),
  })
  const {
    data: inboxCount = 0,
    error: notificationUnreadCountError,
  } = useNotificationUnreadCount(
    accessToken,
    Boolean(user && !currentUserError),
  )
  const userLabel =
    user?.attributes.email ??
    user?.attributes.name ??
    user?.username ??
    t('workspace.user.fallback')
  const userIdentityAliases = useMemo(
    () => [user?.username, user?.attributes.email, user?.attributes.sub]
      .filter(isNonEmptyString),
    [user],
  )
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || 'M'
  const canLoadWorkspaceData = Boolean(user && !currentUserError)
  const canManageWorkspaceConfiguration = canManageWorkspaceStructure(user)
  const canMutateTeamConfiguration = canMutateWorkspaceContent(user)
  const hasQuickAccessLoadError = Boolean(quickAccessError)
  const quickAccessProjects = useMemo(
    () => resolveProjectQuickAccessItems(quickAccessPreference.items, teams),
    [quickAccessPreference.items, teams],
  )
  const currentPath = `${location.pathname}${location.search}${location.hash}`

  /** Records a notification-preference result without clearing guarded mutation failures. */
  const reportNotificationPreferencesError = useCallback<
    NotificationPreferencesSessionErrorReporter
  >((source, error) => {
    setAuthenticatedApiErrorReports((reports) =>
      updateAuthenticatedApiErrorReport(
        reports,
        source === 'query'
          ? 'notification-preferences-query'
          : 'notification-preferences-save',
        error,
      ),
    )
  }, [])

  /** Reports a rejected authenticated request and preserves its rejection for its caller. */
  const guardEnterpriseSession = useCallback(async <Result,>(request: Promise<Result>) => {
    try {
      return await request
    } catch (error) {
      if (resolveEnterpriseSessionErrorAction(error, currentPath).kind !== 'stay') {
        setAuthenticatedApiErrorReports((reports) =>
          updateAuthenticatedApiErrorReport(
            reports,
            'guarded-session-error',
            error,
          ),
        )
      }
      throw error
    }
  }, [currentPath])

  /** Combines common and route errors before applying enterprise session precedence. */
  const resolveSessionErrors = useCallback((
    routeSessionErrors: readonly unknown[] = emptySessionErrors,
  ) => resolveEnterpriseSessionErrorsAction(
    currentUserError,
    [
      projectDirectoryError,
      notificationUnreadCountError,
      quickAccessError,
      ...listAuthenticatedApiErrors(authenticatedApiErrorReports),
      ...routeSessionErrors,
    ],
    currentPath,
  ), [
    authenticatedApiErrorReports,
    currentPath,
    currentUserError,
    notificationUnreadCountError,
    projectDirectoryError,
    quickAccessError,
  ])

  const commonSessionErrorAction = resolveSessionErrors()
  const commonErrorKey = resolveWorkspaceCommonErrorKey(
    currentUserError,
    projectDirectoryError,
    commonSessionErrorAction,
  )
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(
      currentUserError && commonSessionErrorAction?.kind !== 'stay',
    ) ||
    Boolean(user && isProjectDirectoryLoading)

  /** Clears the current session and replaces browser history with the public entry route. */
  const handleLogout = useCallback(() => {
    clearAuthSession()
    navigate('/', { replace: true })
  }, [navigate])

  /** Applies the navigation and storage policy of a resolved enterprise session action. */
  const handleSessionErrorAction = useCallback((action: EnterpriseSessionErrorAction) => {
    if (!action.redirectTo) {
      return
    }

    if (action.clearSession) {
      clearAuthSession()
    }

    navigate(action.redirectTo, { replace: true })
  }, [navigate])

  /** Retries the common query represented by the current shared error boundary. */
  const handleRetryCommonData = useCallback(async () => {
    if (currentUserError) {
      await mutateCurrentUser()
      return
    }

    if (projectDirectoryError) {
      await mutateProjectDirectory()
      return
    }

    if (quickAccessError) {
      await mutateProjectQuickAccess()
    }
  }, [
    currentUserError,
    mutateCurrentUser,
    mutateProjectDirectory,
    mutateProjectQuickAccess,
    projectDirectoryError,
    quickAccessError,
  ])

  /** Retries the viewer's quick-access preference without blocking other workspace data. */
  const handleRetryProjectQuickAccess = useCallback(async () => {
    await mutateProjectQuickAccess()
  }, [mutateProjectQuickAccess])

  /** Saves a font preference and updates provider state for the active route. */
  const handleFontSizePreferenceChange = useCallback((preference: FontSizePreference) => {
    setFontSizePreferenceState(preference)
    setFontSizePreference(preference)
  }, [])

  /** Saves a locale preference and updates provider state for the active route. */
  const handleLocaleChange = useCallback((nextLocale: Locale) => {
    setLocale(nextLocale)
    setLocalePreference(nextLocale)
  }, [])

  /** Replaces the complete quick-access order with optimistic rollback semantics. */
  const persistProjectQuickAccess = useCallback(async (
    nextItems: ProjectQuickAccessItem[],
    feedback?: ProjectQuickAccessFeedback,
  ) => {
    if (!accessToken || quickAccessError || quickAccessSaveInFlightRef.current) {
      return false
    }

    const previous = quickAccessPreference
    if (projectQuickAccessItemsEqual(previous.items, nextItems)) {
      return true
    }

    quickAccessSaveInFlightRef.current = true
    setIsQuickAccessSaving(true)
    setQuickAccessFeedback(undefined)
    await mutateProjectQuickAccess(
      { items: nextItems, revision: previous.revision },
      { revalidate: false },
    )

    try {
      const input = { items: nextItems, revision: previous.revision }
      const committed = await guardEnterpriseSession(mutationRequestRunner.run(
        `project-quick-access:${previous.revision}`,
        JSON.stringify(input),
        (context) => replaceProjectQuickAccess(accessToken, input, context),
      ))
      await mutateProjectQuickAccess(committed, { revalidate: false })
      if (feedback) {
        setQuickAccessFeedback({
          ...feedback,
          undoItems: previous.items.map((item) => ({ ...item })),
          undoRevision: committed.revision,
        })
      }
      return true
    } catch (error) {
      await mutateProjectQuickAccess(previous, { revalidate: false })
      setQuickAccessFeedback({ kind: 'error' })
      if (resolveEnterpriseSessionErrorAction(error, currentPath).kind === 'stay') {
        await mutateProjectQuickAccess().catch(() => undefined)
      }
      return false
    } finally {
      quickAccessSaveInFlightRef.current = false
      setIsQuickAccessSaving(false)
    }
  }, [
    accessToken,
    currentPath,
    guardEnterpriseSession,
    mutateProjectQuickAccess,
    mutationRequestRunner,
    quickAccessPreference,
    quickAccessError,
  ])

  /** Adds or removes one Project from quick access. */
  const handleToggleProjectQuickAccess = useCallback(async (
    item: ProjectQuickAccessItem,
    projectName: string,
  ) => {
    const result = toggleProjectQuickAccess(quickAccessPreference.items, item)
    if (result.added && result.items.length > PROJECT_QUICK_ACCESS_MAX_ITEMS) {
      setQuickAccessFeedback({ kind: 'error' })
      return
    }
    await persistProjectQuickAccess(result.items, {
      kind: result.added ? 'added' : 'removed',
      projectName,
    })
  }, [persistProjectQuickAccess, quickAccessPreference.items])

  /** Removes one starred Project while preserving successful Undo feedback. */
  const handleRemoveProjectQuickAccess = useCallback(async (
    item: ProjectQuickAccessItem,
    projectName: string,
  ) => {
    if (!isProjectInQuickAccess(quickAccessPreference.items, item)) {
      return
    }
    const result = toggleProjectQuickAccess(quickAccessPreference.items, item)
    await persistProjectQuickAccess(result.items, {
      focusUndo: true,
      kind: 'removed',
      projectName,
    })
  }, [persistProjectQuickAccess, quickAccessPreference.items])

  /** Moves one Project by a single position in the saved stable order. */
  const handleMoveProjectQuickAccess = useCallback(async (
    item: ProjectQuickAccessItem,
    direction: 'up' | 'down',
  ) => {
    await persistProjectQuickAccess(moveProjectQuickAccessItem(
      quickAccessPreference.items,
      item,
      direction,
    ))
  }, [persistProjectQuickAccess, quickAccessPreference.items])

  /** Restores the quick-access order captured by the latest add/remove feedback. */
  const handleUndoProjectQuickAccess = useCallback(async () => {
    const undoItems = quickAccessFeedback?.undoItems
    if (
      !canUndoProjectQuickAccess(
        quickAccessFeedback,
        quickAccessPreference.revision,
      ) || !undoItems
    ) {
      setQuickAccessFeedback({ kind: 'error' })
      return
    }
    if (await persistProjectQuickAccess(undoItems)) {
      setQuickAccessFeedback(undefined)
    }
  }, [persistProjectQuickAccess, quickAccessFeedback, quickAccessPreference.revision])

  /** Returns whether one Team-owned Project is currently present in quick access. */
  const handleIsProjectQuickAccess = useCallback((item: ProjectQuickAccessItem) =>
    isProjectInQuickAccess(quickAccessPreference.items, item),
  [quickAccessPreference.items])

  /** Dismisses the shell-level quick-access feedback. */
  const handleDismissProjectQuickAccessFeedback = useCallback(() => {
    setQuickAccessFeedback(undefined)
  }, [])

  /** Creates a team and refreshes the shared project directory cache. */
  const handleCreateTeam = useCallback(async (
    input: CreateProjectDirectoryTeamInput,
  ) => {
    if (!accessToken) {
      return
    }

    await guardEnterpriseSession(mutationRequestRunner.run(
      'team:create',
      JSON.stringify(input),
      (context) => createProjectDirectoryTeam(accessToken, input, context),
    ))
    await mutateProjectDirectory()
  }, [
    accessToken,
    guardEnterpriseSession,
    mutateProjectDirectory,
    mutationRequestRunner,
  ])

  /** Creates a project and refreshes the shared project directory cache. */
  const handleCreateProject = useCallback(async (
    teamId: string,
    input: CreateProjectDirectoryProjectInput,
  ) => {
    if (!accessToken) {
      return
    }

    await guardEnterpriseSession(mutationRequestRunner.run(
      'project:create',
      JSON.stringify([teamId, input]),
      (context) => createProjectDirectoryProject(
        accessToken,
        teamId,
        input,
        context,
      ),
    ))
    await mutateProjectDirectory()
  }, [
    accessToken,
    guardEnterpriseSession,
    mutateProjectDirectory,
    mutationRequestRunner,
  ])

  /** Archives a team, refreshes the directory, and leaves an archived active team route. */
  const handleArchiveTeam = useCallback(async (teamId: string) => {
    if (!accessToken) {
      return
    }

    await guardEnterpriseSession(mutationRequestRunner.run(
      'team:archive',
      teamId,
      (context) => archiveProjectDirectoryTeam(accessToken, teamId, context),
    ))
    await Promise.all([
      mutateProjectDirectory(),
      mutateProjectQuickAccess(),
    ])

    if (activeTeamMatch?.params.teamId === teamId) {
      navigate(workspaceNavPaths.home)
    }
  }, [
    accessToken,
    activeTeamMatch?.params.teamId,
    guardEnterpriseSession,
    mutateProjectDirectory,
    mutateProjectQuickAccess,
    mutationRequestRunner,
    navigate,
  ])

  /** Archives a project and refreshes the shared project directory cache. */
  const handleArchiveProject = useCallback(async (
    teamId: string,
    projectId: string,
  ) => {
    if (!accessToken) {
      return
    }

    await guardEnterpriseSession(mutationRequestRunner.run(
      'project:archive',
      JSON.stringify([teamId, projectId]),
      (context) => archiveProjectDirectoryProject(
        accessToken,
        teamId,
        projectId,
        context,
      ),
    ))
    await Promise.all([
      mutateProjectDirectory(),
      mutateProjectQuickAccess(),
    ])
  }, [
    accessToken,
    guardEnterpriseSession,
    mutateProjectDirectory,
    mutateProjectQuickAccess,
    mutationRequestRunner,
  ])

  /** Navigates to a fixed workspace destination selected from the sidebar. */
  const handleSelectNav = useCallback((navId: SidebarNavId) => {
    navigate(workspaceNavPaths[navId])
  }, [navigate])

  /** Navigates to the selected fixed team view. */
  const handleSelectTeamView = useCallback((
    teamId: string,
    viewId: SidebarTeamViewId,
  ) => {
    navigate(createTeamViewPath(teamId, viewId))
  }, [navigate])

  /** Navigates to the selected project's issue route. */
  const handleSelectProject = useCallback((projectId: string, teamId: string) => {
    navigate(createProjectIssuesPath(projectId, teamId))
  }, [navigate])

  /** Navigates to the assigned project or owning team route represented by a task. */
  const handleOpenTask = useCallback((task: ProjectTask) => {
    if (!task.teamId) {
      return
    }

    navigate(
      task.assignedProjectId
        ? createProjectIssuesPath(task.assignedProjectId, task.teamId, task.id)
        : createTeamIssuesPath(task.teamId, task.id),
    )
  }, [navigate])

  /** Navigates to a notification target when its presentation model supports a route. */
  const handleOpenNotification = useCallback((notification: InboxNotification) => {
    const path = resolveNotificationPath(notification)

    if (path) {
      navigate(path)
    }
  }, [navigate])

  const contextValue = useMemo<WorkspaceRouteContextValue>(() => ({
    accessToken,
    canLoadWorkspaceData,
    canManageWorkspaceConfiguration,
    canMutateTeamConfiguration,
    commonErrorKey,
    fontSizePreference,
    guardEnterpriseSession,
    inboxCount,
    hasQuickAccessLoadError,
    isProjectQuickAccess: handleIsProjectQuickAccess,
    isLoading,
    isQuickAccessLoading,
    isQuickAccessSaving,
    locale,
    onArchiveProject: canManageWorkspaceConfiguration
      ? handleArchiveProject
      : undefined,
    onArchiveTeam: canManageWorkspaceConfiguration
      ? handleArchiveTeam
      : undefined,
    onCreateProject: canManageWorkspaceConfiguration
      ? handleCreateProject
      : undefined,
    onCreateTeam: canManageWorkspaceConfiguration
      ? handleCreateTeam
      : undefined,
    onDismissProjectQuickAccessFeedback: handleDismissProjectQuickAccessFeedback,
    onFontSizePreferenceChange: handleFontSizePreferenceChange,
    onLocaleChange: handleLocaleChange,
    onLogout: handleLogout,
    onOpenNotification: handleOpenNotification,
    onOpenTask: handleOpenTask,
    onMoveProjectQuickAccess: handleMoveProjectQuickAccess,
    onRemoveProjectQuickAccess: handleRemoveProjectQuickAccess,
    onRetryCommonData: handleRetryCommonData,
    onRetryProjectQuickAccess: handleRetryProjectQuickAccess,
    onSelectNav: handleSelectNav,
    onSelectProject: handleSelectProject,
    onSelectTeamView: handleSelectTeamView,
    onSessionErrorAction: handleSessionErrorAction,
    onToggleProjectQuickAccess: handleToggleProjectQuickAccess,
    onUndoProjectQuickAccess: handleUndoProjectQuickAccess,
    quickAccessFeedback,
    quickAccessItems: quickAccessPreference.items,
    quickAccessProjects,
    reportNotificationPreferencesError,
    resolveSessionErrors,
    teams,
    userIdentityAliases,
    userInitial,
    userLabel,
  }), [
    accessToken,
    canLoadWorkspaceData,
    canManageWorkspaceConfiguration,
    canMutateTeamConfiguration,
    commonErrorKey,
    fontSizePreference,
    guardEnterpriseSession,
    handleArchiveProject,
    handleArchiveTeam,
    handleCreateProject,
    handleCreateTeam,
    handleDismissProjectQuickAccessFeedback,
    handleFontSizePreferenceChange,
    handleIsProjectQuickAccess,
    handleLocaleChange,
    handleLogout,
    handleOpenNotification,
    handleOpenTask,
    handleMoveProjectQuickAccess,
    handleRemoveProjectQuickAccess,
    handleRetryCommonData,
    handleRetryProjectQuickAccess,
    handleSelectNav,
    handleSelectProject,
    handleSelectTeamView,
    handleSessionErrorAction,
    handleToggleProjectQuickAccess,
    handleUndoProjectQuickAccess,
    inboxCount,
    hasQuickAccessLoadError,
    isLoading,
    isQuickAccessLoading,
    isQuickAccessSaving,
    locale,
    quickAccessFeedback,
    quickAccessPreference.items,
    quickAccessProjects,
    reportNotificationPreferencesError,
    resolveSessionErrors,
    teams,
    userIdentityAliases,
    userInitial,
    userLabel,
  ])

  if (!session) {
    return <Navigate replace to="/" />
  }

  return <Outlet context={contextValue} />
}

/**
 * Reads the common authenticated workspace context supplied by the pathless route provider.
 *
 * @returns Shared workspace data, permissions, navigation, and mutation callbacks.
 * @throws When the calling route is not nested below `WorkspaceRouteProvider`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspaceRouteContext() {
  const context = useOutletContext<WorkspaceRouteContextValue | undefined>()

  if (!context) {
    throw new Error('useWorkspaceRouteContext must be used below WorkspaceRouteProvider.')
  }

  return context
}

/**
 * Narrows a possible current-user identity value to a non-empty string.
 *
 * @param value - A possible current-user identity attribute.
 * @returns Whether the value is a non-empty string.
 */
function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Compares ordered quick-access references without depending on object identity.
 *
 * @param first - First ordered preference.
 * @param second - Second ordered preference.
 * @returns Whether the same Project references appear in the same order.
 */
function projectQuickAccessItemsEqual(
  first: readonly ProjectQuickAccessItem[],
  second: readonly ProjectQuickAccessItem[],
) {
  return first.length === second.length && first.every((item, index) => {
    const candidate = second[index]
    return candidate?.projectId === item.projectId && candidate.teamId === item.teamId
  })
}
