import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import {
  canMutateWorkspaceContent,
  type CurrentUser,
} from '../../auth/api'
import { useCurrentUser } from '../../auth/queries/useCurrentUser'
import { resolveEnterpriseSessionErrorsAction } from '../../auth/enterpriseSessionErrors'
import { clearAuthSession, getAuthSession, type AuthSession } from '../../auth/session'
import {
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import {
  MobileSidebarButton,
} from '../../shared/ui/sidebar'
import {
  createTranslator,
  getInitialLocale,
  type Locale,
} from '../../shared/i18n/i18n'
import {
  archivePlanningEntity,
  addPlanningStatusUpdate,
  createPlanningDependency,
  createPlanningEntity,
  createWorkItemScheduleDependency,
  deletePlanningDependency,
  deletePlanningWorkItemLink,
  deleteWorkItemScheduleDependency,
  duplicatePlanningEntity,
  movePlanningEntity,
  putPlanningWorkItemLink,
  resolvePlanningErrorMessageKey,
  rolloverPlanningCycle,
  updatePlanningEntity,
  updateWorkItemScheduleDependency,
} from '../../planning/api'
import { usePlanningSnapshot } from '../../planning/queries/usePlanningSnapshot'
import {
  canLinkPlanningEntity,
  canManageAnyPlanningScope,
  canManagePlanningScope,
  canManagePlanningWorkItemDependency,
  canManagePlanningWorkItemDependencyEndpoint,
  canUpdatePlanningEntityStatus,
  canUpdatePlanningWorkItemLink,
  createPlanningAccessSnapshot,
  filterManageablePlanningScopeTeams,
} from '../../planning/model/permissions'
import {
  PlanningScreen,
} from '../../planning/ui/PlanningScreen'
import { createPlanningLabels } from '../../planning/ui/labels'
import {
  type ProjectDirectoryTeam,
  type ProjectMemberRole,
} from '../../projects/api'
import { usePlanningProjectRoles } from '../../projects/queries/useProjectMembers'
import { useProjectDirectory } from '../../projects/queries/useProjectDirectory'
import { createWorkItemDependencyMutationId } from '../../work-items/model/workItemDependencies'
import {
  createPlanningPath,
  createProjectIssuesPath,
  createProjectTasksPath,
  createTeamIssuesPath,
  type PlanningViewId,
} from '../../shared/routing/paths'
import { useWorkspaceSidebarController } from '../../shared/ui/sidebar'

const emptyTeams: ProjectDirectoryTeam[] = []
const emptyProjectRoles: Readonly<Record<string, ProjectMemberRole>> = {}

/**
 * 認証済み Workspace の Planning workbench です。
 */
export function PlanningPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const [session] = useState<AuthSession | null>(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [mutationErrorMessage, setMutationErrorMessage] = useState<string>()
  const t = useMemo(() => createTranslator(locale), [locale])
  const labels = useMemo(() => createPlanningLabels(locale), [locale])
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
    data: snapshot,
    error: planningError,
    isLoading: isPlanningLoading,
    mutate: mutatePlanning,
    key: planningKey,
  } = usePlanningSnapshot(accessToken, Boolean(user && !currentUserError))
  const projectIds = useMemo(
    () => [...new Set(teams.flatMap((team) => team.projects.map((project) => project.id)))],
    [teams],
  )
  const currentUserProjectKey = resolveCurrentUserProjectKey(user)
  const {
    data: projectRolesResult,
    error: projectRolesError,
    isLoading: isProjectRolesLoading,
    key: planningProjectRolesKey,
  } = usePlanningProjectRoles(
    accessToken,
    currentUserProjectKey,
    projectIds,
    Boolean(
      user &&
      !currentUserError &&
      !isProjectDirectoryLoading &&
      !user.isSystemAdmin &&
      canMutateWorkspaceContent(user)
    ),
  )
  const projectRoles = projectRolesResult?.roles ?? emptyProjectRoles
  const planningAccess = useMemo(
    () => createPlanningAccessSnapshot(teams, projectRoles),
    [projectRoles, teams],
  )
  const manageableCreateScopeTeams = useMemo(
    () => filterManageablePlanningScopeTeams(user, teams, planningAccess),
    [planningAccess, teams, user],
  )
  const activeView = resolvePlanningView(location.pathname)
  const selectedEntityId = searchParams.get('entityId') ?? undefined
  const canManagePlanning = canManageAnyPlanningScope(user, planningAccess)
  const canMutatePlanningContent = canMutateWorkspaceContent(user)
  const currentPath = `${location.pathname}${location.search}${location.hash}`
  const currentUserErrorAction = resolveEnterpriseSessionErrorsAction(
    currentUserError,
    [
      planningError,
      projectDirectoryError,
      projectRolesError,
      ...(projectRolesResult?.errors ?? []),
    ],
    currentPath,
  )
  const isLoading = !session || isCurrentUserLoading ||
    Boolean(user && isProjectDirectoryLoading) ||
    Boolean(planningProjectRolesKey && isProjectRolesLoading) ||
    Boolean(planningKey && isPlanningLoading)
  const loadError = planningError ?? currentUserError
  const loadErrorMessage = loadError
    ? t(resolvePlanningErrorMessageKey(loadError))
    : undefined

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${labels.title} | ${t('app.title')}`
  }, [labels.title, locale, t])

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

  const runMutation = async (
    key: string,
    payload: unknown,
    request: (context: MutationRequestContext) => ReturnType<typeof archivePlanningEntity>,
  ) => {
    if (!accessToken) {
      return
    }

    setMutationErrorMessage(undefined)
    try {
      const result = await mutationRequestRunner.run(
        key,
        JSON.stringify(payload),
        request,
      )
      await mutatePlanning(result, { revalidate: false })
    } catch (error) {
      const sessionErrorAction = resolveEnterpriseSessionErrorsAction(
        undefined,
        [error],
        currentPath,
      )
      if (sessionErrorAction?.redirectTo) {
        if (sessionErrorAction.clearSession) {
          clearAuthSession()
        }
        navigate(sessionErrorAction.redirectTo, { replace: true })
        return
      }

      const messageKey = resolvePlanningErrorMessageKey(error, 'mutation')
      setMutationErrorMessage(t(messageKey))
      if (messageKey === 'planning.conflict') {
        await mutatePlanning()
      }
    }
  }

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
        <div className="absolute left-4 top-4 z-20 min-[981px]:hidden">
          <MobileSidebarButton label={t('sidebar.mobileOpen')} onClick={openMobileSidebar} />
        </div>
        <PlanningScreen
          activeView={activeView}
          errorMessage={mutationErrorMessage ?? loadErrorMessage}
          initialSelectedEntityId={selectedEntityId}
          isLoading={isLoading}
          key={selectedEntityId ?? ''}
          labels={labels}
          snapshot={snapshot}
          canLinkEntity={(entity) => canLinkPlanningEntity(user, entity, planningAccess)}
          canCreateInScope={(scope) => canManagePlanningScope(user, scope, planningAccess)}
          canManageEntity={(entity) => canManagePlanningScope(user, entity, planningAccess)}
          canManageWorkItemDependencyEndpoint={(endpoint) =>
            canManagePlanningWorkItemDependencyEndpoint(
              user,
              endpoint,
              snapshot?.workItems ?? [],
              planningAccess,
            )}
          canUpdateEntityStatus={(entity) =>
            canUpdatePlanningEntityStatus(user, entity, planningAccess)}
          canUpdateWorkItemLink={(workItem) =>
            canUpdatePlanningWorkItemLink(user, workItem, planningAccess)}
          createScopeTeams={manageableCreateScopeTeams}
          onRetry={loadErrorMessage && !mutationErrorMessage
            ? () => void mutatePlanning()
            : undefined}
          onViewChange={(view) => navigate(createPlanningPath(view, selectedEntityId))}
          onOpenWorkItem={(workItem) => navigate(
            workItem.projectId
              ? createProjectIssuesPath(workItem.projectId, workItem.teamId, workItem.id)
              : createTeamIssuesPath(workItem.teamId, workItem.id),
          )}
          onOpenMilestone={(milestoneId) => navigate(createPlanningPath('timeline', milestoneId))}
          onOpenProject={(project) => navigate(
            createProjectTasksPath(project.projectId, project.teamId),
          )}
          onCreateEntity={canManagePlanning && snapshot && accessToken
            ? (input) => {
                if (!canManagePlanningScope(user, input, planningAccess)) return
                return runMutation(
                  `planning:entity:${input.id}:create`,
                  [snapshot.revision, input],
                  (context) => createPlanningEntity(accessToken, {
                    ...input,
                    expectedRevision: snapshot.revision,
                  }, context),
                )
              }
            : undefined}
          onChangeMilestoneDate={canManagePlanning && snapshot && accessToken
            ? (entity, date) => runMutation(
                `planning:entity:${entity.id}:date`,
                [snapshot.revision, date],
                (context) => updatePlanningEntity(accessToken, entity.id, {
                  expectedRevision: snapshot.revision,
                  patch: {
                    forecast: { startDate: date, endDate: date },
                  },
                }, context),
              )
            : undefined}
          onCreateDependency={canManagePlanning && snapshot && accessToken
            ? (predecessorId, successorId, type, lagDays, constraint) => {
                const input = {
                  id: createPlanningClientId('dependency'),
                  predecessorId,
                  successorId,
                  type,
                  lagDays,
                  constraint,
                  expectedRevision: snapshot.revision,
                }
                return runMutation(
                  `planning:dependency:${input.id}`,
                  input,
                  (context) => createPlanningDependency(accessToken, input, context),
                )
              }
            : undefined}
          onDeleteDependency={canManagePlanning && snapshot && accessToken
            ? (dependency) => runMutation(
                `planning:dependency:${dependency.id}:delete`,
                snapshot.revision,
                (context) => deletePlanningDependency(accessToken, dependency.id, {
                  expectedRevision: snapshot.revision,
                }, context),
              )
            : undefined}
          onCreateWorkItemDependency={canManagePlanning && snapshot && accessToken
            ? (draft) => {
                if (!canManagePlanningWorkItemDependency(user, draft, snapshot.workItems, planningAccess)) {
                  return
                }
                return runMutation(
                  'planning:work-item-dependency:create',
                  [snapshot.revision, draft],
                  (context) => createWorkItemScheduleDependency(accessToken, {
                    ...draft,
                    expectedRevision: snapshot.revision,
                    id: createWorkItemDependencyMutationId(context.idempotencyKey),
                  }, context),
                )
              }
            : undefined}
          onUpdateWorkItemDependency={canManagePlanning && snapshot && accessToken
            ? (dependency, patch) => {
                if (!canManagePlanningWorkItemDependency(
                  user,
                  dependency,
                  snapshot.workItems,
                  planningAccess,
                )) return
                return runMutation(
                  `planning:work-item-dependency:${dependency.id}:update`,
                  [snapshot.revision, patch],
                  (context) => updateWorkItemScheduleDependency(accessToken, dependency.id, {
                    expectedRevision: snapshot.revision,
                    patch,
                  }, context),
                )
              }
            : undefined}
          onDeleteWorkItemDependency={canManagePlanning && snapshot && accessToken
            ? (dependency) => {
                if (!canManagePlanningWorkItemDependency(
                  user,
                  dependency,
                  snapshot.workItems,
                  planningAccess,
                )) return
                return runMutation(
                  `planning:work-item-dependency:${dependency.id}:delete`,
                  snapshot.revision,
                  (context) => deleteWorkItemScheduleDependency(accessToken, dependency.id, {
                    expectedRevision: snapshot.revision,
                  }, context),
                )
              }
            : undefined}
          onRolloverCycle={canManagePlanning && snapshot && accessToken
            ? (sourceCycle, targetCycleId) => runMutation(
                `planning:cycle:${sourceCycle.id}:rollover`,
                [snapshot.revision, targetCycleId],
                (context) => rolloverPlanningCycle(accessToken, sourceCycle.id, {
                  expectedRevision: snapshot.revision,
                  targetCycleId,
                }, context).then((result) => result.planning),
              )
            : undefined}
          onArchiveEntity={canManagePlanning && snapshot && accessToken
            ? (entity) => runMutation(
                `planning:entity:${entity.id}:archive`,
                snapshot.revision,
                (context) => archivePlanningEntity(accessToken, entity.id, {
                  expectedRevision: snapshot.revision,
                }, context),
              )
            : undefined}
          onDuplicateEntity={canManagePlanning && snapshot && accessToken
            ? (entity, targetId) => runMutation(
                `planning:entity:${entity.id}:duplicate:${targetId}`,
                [snapshot.revision, targetId],
                (context) => duplicatePlanningEntity(accessToken, entity.id, {
                  expectedRevision: snapshot.revision,
                  targetId,
                }, context),
              )
            : undefined}
          onMoveEntity={canManagePlanning && snapshot && accessToken
            ? (entity, target) => {
                if (!canManagePlanningScope(user, target, planningAccess)) return
                return runMutation(
                  `planning:entity:${entity.id}:move`,
                  [snapshot.revision, target.parent?.id, target.teamId, target.projectId],
                  (context) => movePlanningEntity(accessToken, entity.id, {
                    expectedRevision: snapshot.revision,
                    parentId: target.parent?.id,
                    teamId: target.teamId,
                    projectId: target.projectId,
                  }, context),
                )
              }
            : undefined}
          onAddStatusUpdate={canMutatePlanningContent && snapshot && accessToken
            ? (entity, message, health, risk) => {
                const input = {
                  id: createPlanningClientId('status-update'),
                  message,
                  health,
                  risk,
                  expectedRevision: snapshot.revision,
                }
                return runMutation(
                  `planning:entity:${entity.id}:status-update:${input.id}`,
                  input,
                  (context) => addPlanningStatusUpdate(accessToken, entity.id, input, context),
                )
              }
            : undefined}
          onSaveWorkItemLink={canMutatePlanningContent && snapshot && accessToken
            ? (workItem, cycleId, milestoneId, goalIds) => {
                const input = {
                  teamId: workItem.teamId,
                  workItemId: workItem.id,
                  projectId: workItem.projectId,
                  cycleId,
                  milestoneId,
                  goalIds,
                  expectedRevision: snapshot.revision,
                }
                return runMutation(
                  `planning:work-item-link:${workItem.teamId}:${workItem.id}`,
                  input,
                  (context) => putPlanningWorkItemLink(
                    accessToken,
                    workItem.teamId,
                    workItem.id,
                    input,
                    context,
                  ),
                )
              }
            : undefined}
          onDeleteWorkItemLink={canMutatePlanningContent && snapshot && accessToken
            ? (workItem) => runMutation(
                `planning:work-item-link:${workItem.teamId}:${workItem.id}:delete`,
                snapshot.revision,
                (context) => deletePlanningWorkItemLink(
                  accessToken,
                  workItem.teamId,
                  workItem.id,
                  { expectedRevision: snapshot.revision },
                  context,
                ),
              )
            : undefined}
        />
    </div>
  )
}

function resolvePlanningView(pathname: string): PlanningViewId {
  const lastSegment = pathname.split('/').filter(Boolean).at(-1)
  return lastSegment === 'roadmap' || lastSegment === 'portfolio' ? lastSegment : 'timeline'
}

function createPlanningClientId(prefix: string) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${suffix}`
}

function resolveCurrentUserProjectKey(user: CurrentUser | undefined) {
  return (user?.attributes.email ?? user?.username ?? '').trim().toLowerCase()
}
