import type {
  PlanningSnapshot,
  PlanningUpdate,
  PlanningUpdateComment,
  PlanningUpdateReaction,
  PlanningUpdateTarget,
  PlanningUpdateTargetSummary,
} from '@mukuroji/contracts'
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
  addPlanningUpdateReaction,
  configurePlanningUpdateCadence,
  createPlanningUpdateComment,
  createPlanningDependency,
  createPlanningEntity,
  createWorkItemScheduleDependency,
  deletePlanningDependency,
  deletePlanningWorkItemLink,
  deleteWorkItemScheduleDependency,
  duplicatePlanningEntity,
  exportPlanningUpdates,
  movePlanningEntity,
  publishPlanningUpdate,
  putPlanningWorkItemLink,
  resolvePlanningErrorMessageKey,
  rolloverPlanningCycle,
  removePlanningUpdateReaction,
  updatePlanningEntity,
  updateWorkItemScheduleDependency,
  subscribePlanningUpdateWatch,
  unsubscribePlanningUpdateWatch,
} from '../../planning/api'
import {
  createMissingPlanningTargetUpdateView,
  createPlanningTargetUpdateView,
  planningUpdateTargetsAreEqual,
  type PlanningUpdateTargetDetailView,
  type PlanningUpdateTargetSummaryView,
  type PlanningUpdateCollaborationController,
  type PlanningUpdateCommentView,
  type PlanningUpdateReactionView,
} from '../../planning/model/statusUpdateView'
import { createPlanningUpdateTargetKey } from '../../planning/model/targetKey'
import { usePlanningSnapshot } from '../../planning/queries/usePlanningSnapshot'
import {
  revalidatePlanningUpdateHistoryAfterPublish,
  usePlanningUpdateAnnotations,
  usePlanningUpdates,
  usePlanningUpdateWatch,
} from '../../planning/queries/usePlanningUpdates'
import {
  canAnnotatePlanningUpdateTarget,
  canLinkPlanningEntity,
  canManageAnyPlanningScope,
  canManagePlanningScope,
  canManagePlanningUpdateTarget,
  canManagePlanningWorkItemDependency,
  canManagePlanningWorkItemDependencyEndpoint,
  canPublishPlanningUpdateTarget,
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
  const [isUpdateCollaborationPending, setIsUpdateCollaborationPending] = useState(false)
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
    mutate: mutateProjectDirectory,
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
  const projectScopes = useMemo(
    () => teams.flatMap((team) => team.projects.map((project) => ({
      teamId: team.id,
      projectId: project.id,
    }))),
    [teams],
  )
  const currentUserProjectKey = resolveCurrentUserProjectKey(user)
  const {
    data: projectRolesResult,
    error: projectRolesError,
    isLoading: isProjectRolesLoading,
    key: planningProjectRolesKey,
    mutate: mutateProjectRoles,
  } = usePlanningProjectRoles(
    accessToken,
    currentUserProjectKey,
    projectScopes,
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
  const selectedUpdateTarget = resolveSelectedPlanningUpdateTarget(
    searchParams,
    selectedEntityId,
    snapshot,
  )
  const updateHistory = usePlanningUpdates(
    accessToken,
    selectedUpdateTarget,
    Boolean(user && !currentUserError),
  )
  const updateWatch = usePlanningUpdateWatch(
    accessToken,
    selectedUpdateTarget,
    Boolean(user && !currentUserError),
  )
  const updateAnnotations = usePlanningUpdateAnnotations(
    accessToken,
    selectedUpdateTarget,
    updateHistory.data?.updates,
    Boolean(user && !currentUserError),
  )
  const updateAnnotationViews = useMemo(
    () => createPlanningUpdateAnnotationViews(
      updateHistory.data?.updates,
      updateAnnotations.data?.comments,
      updateAnnotations.data?.reactions,
      currentUserProjectKey,
    ),
    [
      updateAnnotations.data?.comments,
      updateAnnotations.data?.reactions,
      updateHistory.data?.updates,
      currentUserProjectKey,
    ],
  )
  const updateTargetDetails = useMemo(
    () => createPlanningUpdateTargetDetails(
      snapshot,
      teams,
      selectedUpdateTarget,
      updateHistory.data?.updates,
    ),
    [selectedUpdateTarget, snapshot, teams, updateHistory.data?.updates],
  )
  const canManagePlanning = canManageAnyPlanningScope(user, planningAccess)
  const canMutatePlanningContent = canMutateWorkspaceContent(user)
  const currentPath = `${location.pathname}${location.search}${location.hash}`
  const currentUserErrorAction = resolveEnterpriseSessionErrorsAction(
    currentUserError,
    [
      planningError,
      projectDirectoryError,
      projectRolesError,
      updateHistory.error,
      updateWatch.error,
      updateAnnotations.error,
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
  const updateHistoryErrorMessage = updateHistory.error
    ? labels.historyError
    : undefined
  const accessErrorMessage = [
    projectDirectoryError ? t('planning.access.directoryError') : undefined,
    projectRolesError || (projectRolesResult?.errors.length ?? 0) > 0
      ? t('planning.access.rolesError')
      : undefined,
  ].filter(Boolean).join(' ')

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

  /** Runs one Planning mutation and updates the authoritative bounded snapshot on success. */
  const runMutation = async (
    key: string,
    payload: unknown,
    request: (context: MutationRequestContext) => ReturnType<typeof archivePlanningEntity>,
    afterSuccess?: () => Promise<unknown>,
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
      if (afterSuccess) {
        await revalidatePlanningUpdateHistoryAfterPublish(afterSuccess)
      }
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

  /** Toggles the current viewer's watch state for the route-selected update target. */
  const togglePlanningUpdateWatch = async () => {
    const currentWatch = updateWatch.data
    if (!accessToken || !selectedUpdateTarget || !currentWatch) return
    setMutationErrorMessage(undefined)
    setIsUpdateCollaborationPending(true)
    try {
      const nextWatch = await mutationRequestRunner.run(
        `planning:update:${createPlanningUpdateTargetKey(selectedUpdateTarget)}:watch`,
        String(!currentWatch.subscribed),
        (context) => currentWatch.subscribed
          ? unsubscribePlanningUpdateWatch(accessToken, selectedUpdateTarget, context)
          : subscribePlanningUpdateWatch(accessToken, selectedUpdateTarget, context),
      )
      await updateWatch.mutate(nextWatch, { revalidate: false })
    } catch (error) {
      const sessionErrorAction = resolveEnterpriseSessionErrorsAction(
        undefined,
        [error],
        currentPath,
      )
      if (sessionErrorAction?.redirectTo) {
        if (sessionErrorAction.clearSession) clearAuthSession()
        navigate(sessionErrorAction.redirectTo, { replace: true })
        return
      }
      setMutationErrorMessage(t(resolvePlanningErrorMessageKey(error, 'mutation')))
    } finally {
      setIsUpdateCollaborationPending(false)
    }
  }

  /** Downloads the complete immutable history for the route-selected update target. */
  const exportPlanningUpdateHistory = async () => {
    if (!accessToken || !selectedUpdateTarget) return
    setMutationErrorMessage(undefined)
    setIsUpdateCollaborationPending(true)
    try {
      const artifact = await exportPlanningUpdates(accessToken, selectedUpdateTarget)
      downloadPlanningUpdateArtifact(artifact.blob, artifact.filename)
    } catch (error) {
      setMutationErrorMessage(t(resolvePlanningErrorMessageKey(error, 'mutation')))
    } finally {
      setIsUpdateCollaborationPending(false)
    }
  }

  /** Appends a comment to the selected target's referenced immutable update. */
  const submitPlanningUpdateComment = async (
    updateId: string,
    bodyMarkdown: string,
  ) => {
    const update = updateHistory.data?.updates.find((candidate) => candidate.id === updateId)
    if (!accessToken || !selectedUpdateTarget || !update) return
    const input = {
      body: bodyMarkdown,
      id: createPlanningClientId('planning-update-comment'),
      target: selectedUpdateTarget,
      updateVersion: update.version,
    }
    setMutationErrorMessage(undefined)
    setIsUpdateCollaborationPending(true)
    try {
      await updateAnnotations.loadVersion(update.version)
      await mutationRequestRunner.run(
        `planning:update:${createPlanningUpdateTargetKey(selectedUpdateTarget)}:${update.version}:comment:${input.id}`,
        JSON.stringify(input),
        (context) => createPlanningUpdateComment(accessToken, input, context),
      )
      try {
        await updateAnnotations.loadVersion(update.version)
        await updateAnnotations.mutate()
      } catch {
        // SWR preserves the annotation query error for the recoverable collaboration alert.
      }
    } catch (error) {
      const sessionErrorAction = resolveEnterpriseSessionErrorsAction(
        undefined,
        [error],
        currentPath,
      )
      if (sessionErrorAction?.redirectTo) {
        if (sessionErrorAction.clearSession) clearAuthSession()
        navigate(sessionErrorAction.redirectTo, { replace: true })
        return
      }
      setMutationErrorMessage(t(resolvePlanningErrorMessageKey(error, 'mutation')))
      throw error
    } finally {
      setIsUpdateCollaborationPending(false)
    }
  }

  /** Toggles the current member's reaction on one selected immutable update. */
  const togglePlanningUpdateReaction = async (
    updateId: string,
    emoji: string,
  ) => {
    const update = updateHistory.data?.updates.find((candidate) => candidate.id === updateId)
    if (!accessToken || !selectedUpdateTarget || !update) return
    const input = {
      emoji,
      target: selectedUpdateTarget,
      updateVersion: update.version,
    }
    setMutationErrorMessage(undefined)
    setIsUpdateCollaborationPending(true)
    try {
      const loadedAnnotations = await updateAnnotations.loadVersion(update.version)
      const hasCurrentMemberReaction = (loadedAnnotations?.reactions ?? updateAnnotations.data?.reactions ?? [])
        .some((reaction) =>
          reaction.updateVersion === update.version &&
          reaction.emoji === emoji &&
          reaction.memberKey.trim().toLowerCase() === currentUserProjectKey
        )
      await mutationRequestRunner.run(
        `planning:update:${createPlanningUpdateTargetKey(selectedUpdateTarget)}:${update.version}:reaction:${emoji}`,
        JSON.stringify([input, hasCurrentMemberReaction]),
        async (context) => {
          if (hasCurrentMemberReaction) {
            await removePlanningUpdateReaction(accessToken, input, context)
          } else {
            await addPlanningUpdateReaction(accessToken, input, context)
          }
        },
      )
      try {
        await updateAnnotations.loadVersion(update.version)
        await updateAnnotations.mutate()
      } catch {
        // SWR preserves the annotation query error for the recoverable collaboration alert.
      }
    } catch (error) {
      const sessionErrorAction = resolveEnterpriseSessionErrorsAction(
        undefined,
        [error],
        currentPath,
      )
      if (sessionErrorAction?.redirectTo) {
        if (sessionErrorAction.clearSession) clearAuthSession()
        navigate(sessionErrorAction.redirectTo, { replace: true })
        return
      }
      setMutationErrorMessage(t(resolvePlanningErrorMessageKey(error, 'mutation')))
    } finally {
      setIsUpdateCollaborationPending(false)
    }
  }

  const canAnnotateSelectedUpdate = Boolean(
    canMutatePlanningContent &&
    selectedUpdateTarget &&
    !planningUpdateTargetIsArchived(snapshot, selectedUpdateTarget) &&
    canAnnotatePlanningUpdateTarget(
      user,
      selectedUpdateTarget,
      snapshot?.entities ?? [],
      planningAccess,
    ),
  )

  const updateCollaboration: PlanningUpdateCollaborationController | undefined =
    selectedUpdateTarget && accessToken
      ? {
          commentsByUpdateId: updateAnnotationViews.commentsByUpdateId,
          errorMessage: updateWatch.error || updateAnnotations.error
            ? labels.collaborationError
            : undefined,
          isLoading: Boolean(
            updateWatch.key && updateWatch.isLoading ||
            updateAnnotations.key && updateAnnotations.isLoading,
          ),
          isPending: isUpdateCollaborationPending,
          onAddComment: canAnnotateSelectedUpdate
            ? submitPlanningUpdateComment
            : undefined,
          onExport: exportPlanningUpdateHistory,
          onRetry: updateWatch.error || updateAnnotations.error
            ? () => void Promise.all([
                updateWatch.mutate(),
                updateAnnotations.mutate(),
              ])
            : undefined,
          onToggleReaction: canAnnotateSelectedUpdate
            ? togglePlanningUpdateReaction
            : undefined,
          onToggleWatch: updateWatch.data && canMutatePlanningContent
            ? togglePlanningUpdateWatch
            : undefined,
          reactionsByUpdateId: updateAnnotationViews.reactionsByUpdateId,
          watch: updateWatch.data
            ? {
                subscribed: updateWatch.data.subscribed,
                watcherCount: updateWatch.data.watcherCount,
              }
            : undefined,
        }
      : undefined

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
        <div className="absolute left-4 top-4 z-20 min-[981px]:hidden">
          <MobileSidebarButton label={t('sidebar.mobileOpen')} onClick={openMobileSidebar} />
        </div>
        <PlanningScreen
          accessErrorMessage={accessErrorMessage || undefined}
          activeView={activeView}
          errorMessage={mutationErrorMessage ?? loadErrorMessage}
          initialSelectedEntityId={selectedEntityId}
          initialSelectedUpdateTarget={selectedUpdateTarget}
          hasMoreUpdateHistory={updateHistory.hasMore}
          isLoading={isLoading}
          isLoadingMoreUpdateHistory={updateHistory.isLoadingMore}
          isUpdateHistoryLoading={Boolean(updateHistory.key && updateHistory.isLoading)}
          key={`${selectedEntityId ?? ''}:${selectedUpdateTarget ? createPlanningUpdateTargetKey(selectedUpdateTarget) : ''}`}
          labels={labels}
          snapshot={snapshot}
          updateHistoryErrorMessage={updateHistoryErrorMessage}
          updateCollaboration={updateCollaboration}
          updateTargetDetails={updateTargetDetails}
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
          canManageUpdateCadence={(target) =>
            !planningUpdateTargetIsArchived(snapshot, target) &&
            canManagePlanningUpdateTarget(
              user,
              target,
              snapshot?.entities ?? [],
              planningAccess,
            )}
          canPublishUpdate={(target) =>
            !planningUpdateTargetIsArchived(snapshot, target) &&
            canPublishPlanningUpdateTarget(
              user,
              target,
              snapshot?.entities ?? [],
              snapshot?.updateTargets ?? [],
              planningAccess,
            )}
          canUpdateWorkItemLink={(workItem) =>
            canUpdatePlanningWorkItemLink(user, workItem, planningAccess)}
          createScopeTeams={manageableCreateScopeTeams}
          onRetry={loadErrorMessage && !mutationErrorMessage
            ? () => void mutatePlanning()
            : undefined}
          onRetryAccess={accessErrorMessage
            ? () => {
                void Promise.all([
                  mutateProjectDirectory(),
                  mutateProjectRoles(),
                ])
              }
            : undefined}
          onRetryUpdateHistory={updateHistory.error
            ? () => void updateHistory.mutate()
            : undefined}
          onLoadMoreUpdateHistory={updateHistory.hasMore
            ? () => updateHistory.loadMore().then(() => undefined)
            : undefined}
          onViewChange={(view) => navigate(
            selectedUpdateTarget
              ? createPlanningUpdateTargetPath(view, selectedUpdateTarget)
              : createPlanningPath(view, selectedEntityId),
          )}
          onSelectUpdateTarget={(target) => navigate(
            createPlanningUpdateTargetPath(activeView, target),
          )}
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
          onSaveUpdateCadence={canMutatePlanningContent && snapshot && accessToken
            ? (target, cadence) => {
                const input = {
                  cadence,
                  expectedRevision: snapshot.revision,
                  target,
                }
                return runMutation(
                  `planning:update:${createPlanningUpdateTargetKey(target)}:cadence`,
                  input,
                  (context) => configurePlanningUpdateCadence(
                    accessToken,
                    input,
                    context,
                  ).then((result) => result.planning),
                )
              }
            : undefined}
          onPublishUpdate={canMutatePlanningContent && snapshot && accessToken
            ? (target, draft) => {
                const input = {
                  ...draft,
                  expectedRevision: snapshot.revision,
                  id: createPlanningClientId('planning-update'),
                  target,
                }
                return runMutation(
                  `planning:update:${createPlanningUpdateTargetKey(target)}:publish:${input.id}`,
                  input,
                  (context) => publishPlanningUpdate(
                    accessToken,
                    input,
                    context,
                  ).then((result) => result.planning),
                  () => updateHistory.mutate(),
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

/**
 * Resolves the Project or Initiative update target encoded by the Planning route.
 *
 * @param searchParams - Current Planning query parameters.
 * @param selectedEntityId - Optional entity selected by the legacy entity route.
 * @param snapshot - Current Planning snapshot used to recognize an Initiative.
 * @returns An unambiguous update target, or undefined.
 */
function resolveSelectedPlanningUpdateTarget(
  searchParams: URLSearchParams,
  selectedEntityId: string | undefined,
  snapshot: PlanningSnapshot | undefined,
): PlanningUpdateTarget | undefined {
  const targetType = searchParams.get('targetType')
  if (targetType === 'project') {
    const teamId = searchParams.get('teamId')?.trim()
    const projectId = searchParams.get('projectId')?.trim()
    return teamId && projectId
      ? { type: 'project', projectId, teamId }
      : undefined
  }
  const entityId = searchParams.get('entityId')?.trim() || selectedEntityId
  if (targetType === 'initiative' && entityId) {
    return { type: 'initiative', entityId }
  }
  const selectedEntity = snapshot?.entities.find((entity) =>
    entity.id === entityId && entity.type === 'initiative'
  )
  return selectedEntity
    ? { type: 'initiative', entityId: selectedEntity.id }
    : undefined
}

/**
 * Builds visible target metadata and joins full history only to the selected stream.
 *
 * @param snapshot - Current authoritative Planning snapshot.
 * @param teams - Permission-filtered Workspace directory.
 * @param selectedTarget - Route-selected Project or Initiative target.
 * @param selectedUpdates - Full immutable history for the selected target.
 * @returns Detail projections for list summaries and the selected pane.
 */
function createPlanningUpdateTargetDetails(
  snapshot: PlanningSnapshot | undefined,
  teams: readonly ProjectDirectoryTeam[],
  selectedTarget: PlanningUpdateTarget | undefined,
  selectedUpdates: readonly PlanningUpdate[] = [],
): PlanningUpdateTargetDetailView[] {
  if (!snapshot) return []
  const details = snapshot.updateTargets.flatMap((summary) => {
    const summaryView = createPlanningUpdateTargetSummaryView(
      summary.target,
      summary,
      snapshot,
      teams,
    )
    if (!summaryView) return []
    const updates = selectedTarget && planningUpdateTargetsAreEqual(
      selectedTarget,
      summary.target,
    )
      ? selectedUpdates
      : []
    return [{
      summary: summaryView,
      updateView: createPlanningTargetUpdateView(summary, updates),
    }]
  })
  if (!selectedTarget || details.some((detail) =>
    planningUpdateTargetsAreEqual(detail.summary.target, selectedTarget)
  )) {
    return details
  }
  const selectedSummary = createPlanningUpdateTargetSummaryView(
    selectedTarget,
    undefined,
    snapshot,
    teams,
  )
  return selectedSummary
    ? [...details, {
        summary: selectedSummary,
        updateView: createMissingPlanningTargetUpdateView(selectedTarget),
      }]
    : details
}

/**
 * Adapts contract annotations to immutable ledger rows and aggregates reactions by emoji.
 *
 * @param updates - Visible immutable updates that own annotation rows.
 * @param comments - Loaded append-only comments across the visible versions.
 * @param reactions - Loaded member reactions across the visible versions.
 * @param currentMemberKey - Normalized Workspace member key for viewer-state projection.
 * @returns Comment and reaction maps keyed by immutable update ID.
 */
function createPlanningUpdateAnnotationViews(
  updates: readonly PlanningUpdate[] = [],
  comments: readonly PlanningUpdateComment[] = [],
  reactions: readonly PlanningUpdateReaction[] = [],
  currentMemberKey = '',
) {
  const commentsByUpdateId: Record<string, PlanningUpdateCommentView[]> = {}
  const reactionsByUpdateId: Record<string, PlanningUpdateReactionView[]> = {}

  for (const update of updates) {
    commentsByUpdateId[update.id] = comments
      .filter((comment) => comment.updateVersion === update.version)
      .map((comment) => ({
        authorMemberKey: comment.authorMemberKey,
        bodyMarkdown: comment.body,
        createdAt: comment.createdAt,
        id: comment.id,
        updateId: update.id,
      }))
    const reactionCounts = new Map<string, { count: number; reactedByViewer: boolean }>()
    for (const reaction of reactions) {
      if (reaction.updateVersion !== update.version) continue
      const current = reactionCounts.get(reaction.emoji)
      reactionCounts.set(reaction.emoji, {
        count: (current?.count ?? 0) + 1,
        reactedByViewer: Boolean(
          current?.reactedByViewer ||
          currentMemberKey && reaction.memberKey.trim().toLowerCase() === currentMemberKey,
        ),
      })
    }
    reactionsByUpdateId[update.id] = [...reactionCounts].map(([reaction, aggregate]) => ({
      count: aggregate.count,
      reaction,
      reactedByViewer: aggregate.reactedByViewer,
    }))
  }

  return { commentsByUpdateId, reactionsByUpdateId }
}

/**
 * Resolves user-facing metadata for one visible Project or Initiative target.
 *
 * @param target - Canonical target identity.
 * @param updateSummary - Optional cadence and latest-update projection.
 * @param snapshot - Current Planning snapshot.
 * @param teams - Permission-filtered Workspace directory.
 * @returns Display metadata, or undefined when the target is not visible.
 */
function createPlanningUpdateTargetSummaryView(
  target: PlanningUpdateTarget,
  updateSummary: PlanningUpdateTargetSummary | undefined,
  snapshot: PlanningSnapshot,
  teams: readonly ProjectDirectoryTeam[],
): PlanningUpdateTargetSummaryView | undefined {
  if (target.type === 'project') {
    const team = teams.find((candidate) => candidate.id === target.teamId)
    const project = team?.projects.find((candidate) => candidate.id === target.projectId)
    if (!team || !project) return undefined
    return {
      context: team.name,
      health: updateSummary?.latestUpdate?.health ?? 'unknown',
      ownerMemberKey: updateSummary?.cadence?.updateOwnerMemberKey ?? '',
      progress: updateSummary?.latestUpdate?.progressSnapshot.percent ?? 0,
      target,
      title: project.name,
    }
  }
  const entity = snapshot.entities.find((candidate) =>
    candidate.type === 'initiative' && candidate.id === target.entityId
  )
  if (!entity) return undefined
  const context = [entity.teamId, entity.projectId].filter(Boolean).join(' / ')
  return {
    context: context || undefined,
    health: entity.health,
    ownerMemberKey: updateSummary?.cadence?.updateOwnerMemberKey ?? entity.ownerMemberKey,
    progress: entity.progress,
    target,
    title: entity.title,
  }
}

/**
 * Creates a Planning route that preserves a Team-qualified update target.
 *
 * @param view - Planning view to open.
 * @param target - Project or Initiative update target.
 * @returns Same-origin Planning path.
 */
function createPlanningUpdateTargetPath(
  view: PlanningViewId,
  target: PlanningUpdateTarget,
) {
  const parameters = new URLSearchParams({ targetType: target.type })
  if (target.type === 'project') {
    parameters.set('teamId', target.teamId)
    parameters.set('projectId', target.projectId)
  } else {
    parameters.set('entityId', target.entityId)
  }
  return `/planning/${view}?${parameters.toString()}`
}

/**
 * Returns whether a target summary has stopped accepting updates after archive.
 *
 * @param snapshot - Current Planning snapshot.
 * @param target - Project or Initiative target.
 * @returns True when the target summary is archived.
 */
function planningUpdateTargetIsArchived(
  snapshot: PlanningSnapshot | undefined,
  target: PlanningUpdateTarget,
) {
  return snapshot?.updateTargets.some((summary) =>
    planningUpdateTargetsAreEqual(summary.target, target) && Boolean(summary.archivedAt)
  ) ?? false
}

/**
 * Creates a Team-qualified mutation and component key for one update target.
 *
 * @param target - Canonical update target.
 * @returns Stable string key.
 */
/**
 * Starts a browser download for one exported Planning update artifact.
 *
 * @param blob - Exported file body.
 * @param filename - Server-supplied safe filename.
 */
function downloadPlanningUpdateArtifact(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function resolveCurrentUserProjectKey(user: CurrentUser | undefined) {
  return (user?.attributes.email ?? user?.username ?? '').trim().toLowerCase()
}
