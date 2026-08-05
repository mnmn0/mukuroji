import type {
  ResolvedWorkItemConfiguration,
  WorkflowStatusDefinition,
  WorkItemConfiguration,
  WorkItemRelation,
  WorkItemSchedule,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  canManageWorkspaceStructure,
  canMutateWorkspaceContent,
} from '../../auth/api'
import { useCurrentUser } from '../../auth/queries/useCurrentUser'
import { resolveEnterpriseSessionErrorsAction } from '../../auth/enterpriseSessionErrors'
import { clearAuthSession, getAuthSession } from '../../auth/session'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { IssueArtifactsPanel } from '../../files/ui/IssueArtifactsPanel'
import {
  type FileArtifactScope,
  type FileArtifactsController,
  useFileArtifacts,
} from '../../files/mutations/useFileArtifacts'
import {
  MobileSidebarButton,
} from '../../shared/ui/sidebar'
import {
  createTranslator,
  getInitialLocale,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import {
  createTeamIssue,
  TeamIssuesApiError,
  type CreateTeamIssueInput,
  type TeamIssue,
  type UpdateTeamIssueInput,
  updateTeamIssue,
} from '../../issues/api'
import {
  useTeamIssueDetail,
  useTeamIssues,
} from '../../issues/queries/useWorkItems'
import { IssueCollaborationPanel } from '../../issues/ui/IssueCollaborationPanel'
import {
  type IssueCollaborationController,
  useIssueCollaboration,
} from '../../issues/mutations/useIssueCollaboration'
import {
  type ProjectDirectoryTeam,
  type ProjectMember,
} from '../../projects/api'
import { useProjectDirectory } from '../../projects/queries/useProjectDirectory'
import { useActiveProjectMembers } from '../../projects/queries/useProjectMembers'
import {
  createTeamIssuesPath,
} from '../../shared/routing/paths'
import type { TaskPriority } from '../../tasks/api'
import {
  createDefaultDueDateTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
  formatTaskScheduleRange,
  taskScheduleModeLabelKeys,
} from '../../tasks/model/taskSchedule'
import type { WorkspaceMember } from '../../workspace/api'
import { useWorkspaceAccess } from '../../workspace/queries/useWorkspaceAccess'
import { useWorkspaceSidebarController } from '../../shared/ui/sidebar'
import {
  createWorkItemRelation,
  deleteWorkItemRelation,
} from '../../work-items/api'
import {
  useWorkItemConfiguration,
} from '../../work-items/queries/useWorkItemConfigurations'
import { WorkItemExternalLinksPanelContainer } from '../../work-items/ui/WorkItemExternalLinksPanel'
import {
  createDefaultCustomFieldValues,
  isCustomFieldApplicable,
  parseCustomFieldFormData,
  sortCustomFieldDefinitions,
} from '../../work-items/model/customFields'
import { WorkItemFieldsEditor } from '../../work-items/ui/WorkItemFieldsEditor'
import {
  WorkItemDefinitionFilters,
} from '../../work-items/ui/WorkItemDefinitionFilters'
import {
  matchesWorkItemDefinitionFilter,
  type WorkItemDefinitionFilter,
} from '../../work-items/model/workItemFilters'
import {
  WorkItemRelationsEditor,
  type WorkItemRelationEditorInput,
} from '../../work-items/ui/WorkItemRelationsEditor'
import {
  createCustomFieldErrorMessages,
  createCustomFieldValuePatch,
  formatWorkItemCustomFieldValue,
  readSelectedRelationGraphRevision,
  refreshRelationDetailAfterConflict,
  resolveCreateWorkflowStatuses,
  resolveDisplayWorkflowStatuses,
  resolveEditableWorkflowStatuses,
  resolveWorkItemAssignee,
  resolveWorkItemPersonOptions,
  resolveWorkItemTitle,
  resolveWorkItemWorkflowStatusId,
  resolveWorkItemWorkflowStatusLabel,
  resolveWorkflowCategoryToneClassName,
  resolveWorkflowStatusCategory,
  resolveWorkflowStatusDefinition,
} from '../../work-items/model/workItemDisplay'
import { RelatedDocuments } from '../../documents/ui/RelatedDocuments'

const issuePriorities = ['high', 'medium', 'low'] as const satisfies readonly TaskPriority[]
const emptyTeams: ProjectDirectoryTeam[] = []
const emptyIssues: TeamIssue[] = []
const emptyMembers: ProjectMember[] = []
const emptyWorkspaceMembers: WorkspaceMember[] = []
/**
 * TeamIssueScreen で切り替える Issue 表示モードです。
 */
type IssueViewMode = 'table' | 'board'

const issueViewPanelId = 'team-issue-view-panel'

/**
 * チーム所有 Issue 画面を描画する props です。
 */
type TeamIssueScreenProps = {
  /**
   * Related Documents を取得する access token です。
   */
  accessToken?: string
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * 表示中のチーム ID です。
   */
  teamId: string
  /**
   * サイドバーとプロジェクト selector に表示するチーム一覧です。
   */
  teams: ProjectDirectoryTeam[]
  /**
   * 表示中のチーム名です。
   */
  teamName?: string
  /**
   * Issue 一覧です。
   */
  issues?: TeamIssue[]
  /**
   * Team / Workspace から解決した workflow と custom field configuration です。
   */
  resolvedConfiguration?: ResolvedWorkItemConfiguration
  /**
   * 選択中 Work Item から見た relation 一覧です。
   */
  relations?: readonly WorkItemRelation[]
  /**
   * 選択中 Issue の comment thread、watcher、presence です。
   */
  collaboration?: IssueCollaborationController
  /**
   * 選択中 Work Item の file/version/annotation/approval controller です。
   */
  artifacts?: FileArtifactsController
  /**
   * mention 候補と actor 表示に使う Workspace member 一覧です。
   */
  workspaceMembers?: WorkspaceMember[]
  /**
   * 現在の Workspace member key です。
   */
  currentWorkspaceMemberKey?: string
  /**
   * External link read API の Bearer token です。
   */
  externalLinksAccessToken?: string
  /**
   * External link の作成、更新、解除が許可されているかどうかです。
   */
  canManageExternalLinks?: boolean
  /**
   * notification deep link から focus する comment ID です。
   */
  focusedCommentId?: string
  /**
   * notification deep link の reply が属する root comment ID です。
   */
  focusedRootCommentId?: string
  /**
   * タスク担当者として選択できる project member 一覧です。
   */
  assigneeOptions?: ProjectMember[]
  /**
   * ログインユーザーのアバター頭文字です。
   */
  userInitial: string
  /**
   * 認証または API 確認中の loading 表示に切り替えるかどうかです。
   */
  isLoading?: boolean
  /**
   * Issue 一覧の取得失敗時に表示するエラーメッセージです。
   */
  issueErrorMessage?: string
  /**
   * Issue 詳細の取得失敗時に表示するエラーメッセージです。
   */
  detailErrorMessage?: string
  /**
   * Work Item configuration の取得失敗時に表示するエラーメッセージです。
   */
  configurationErrorMessage?: string
  /**
   * Relation 候補の取得中かどうかです。
   */
  isRelationsLoading?: boolean
  /**
   * Storybook などで初期表示に使う Issue 一覧モードです。
   */
  initialViewMode?: IssueViewMode
  /**
   * 初期表示時に Issue 作成フォームを開くかどうかです。
   */
  defaultCreateIssueOpen?: boolean
  /**
   * 現在選択中の Issue ID です。
   */
  selectedIssueId?: string
  /**
   * Issue を選択したときの callback です。
   */
  onSelectIssue?: (issueId: string) => void
  /**
   * Issue 作成時の callback です。
   */
  onCreateIssue?: (input: CreateTeamIssueInput) => Promise<void>
  /**
   * Issue 更新時の callback です。
   */
  onUpdateIssue?: (issueId: string, input: UpdateTeamIssueInput) => Promise<void>
  /**
   * 選択中 Work Item へ relation を追加する callback です。
   */
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /**
   * 選択中 Work Item の relation を解除する callback です。
   */
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
}

/**
 * Cognito 認証後に表示するチーム所有 Issue ページです。
 */
export function TeamIssuePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const teamId = params.teamId ?? 'core-team'
  const [session] = useState(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [authenticatedApiError, setAuthenticatedApiError] = useState<unknown>()
  const requestedIssueId = searchParams.get('issueId')?.trim() || undefined
  const focusedCommentId = searchParams.get('commentId')?.trim() || undefined
  const focusedRootCommentId = searchParams.get('rootCommentId')?.trim() || undefined
  const isCreateIssueRequested = searchParams.get('create') === '1'
  const t = useMemo(() => createTranslator(locale), [locale])
  const accessToken = session?.accessToken
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useCurrentUser(accessToken)
  const { data: workspaceAccess, error: workspaceAccessError } = useWorkspaceAccess(
    accessToken,
    Boolean(user && !currentUserError),
  )
  const {
    data: teams = emptyTeams,
    error: projectDirectoryError,
    isLoading: isProjectDirectoryLoading,
  } = useProjectDirectory({
    accessToken,
    enabled: Boolean(user && !currentUserError),
    locale,
  })
  const activeTeam = teams.find((team) => team.id === teamId)
  const {
    data: issues = emptyIssues,
    error: issueError,
    isLoading: isIssuesLoading,
    mutate: mutateIssues,
  } = useTeamIssues(accessToken, teamId, Boolean(user && !currentUserError))
  const {
    data: resolvedConfiguration,
    error: workItemConfigurationError,
    isLoading: isWorkItemConfigurationLoading,
  } = useWorkItemConfiguration(
    accessToken,
    teamId,
    Boolean(user && !currentUserError),
  )
  const resolvedSelectedIssueId = requestedIssueId && issues.some((issue) => issue.id === requestedIssueId)
    ? requestedIssueId
    : issues[0]?.id
  const resolvedSelectedIssue = issues.find((issue) => issue.id === resolvedSelectedIssueId)
  const collaboration = useIssueCollaboration({
    accessToken,
    issueId: resolvedSelectedIssueId,
    projectId: resolvedSelectedIssue?.assignedProjectId,
    teamId,
  })
  const artifactIssueId = resolvedSelectedIssueId
  const issueFileScope = useMemo<FileArtifactScope | undefined>(() =>
    artifactIssueId
      ? { issueId: artifactIssueId, kind: 'work-item', teamId }
      : undefined,
  [artifactIssueId, teamId])
  const artifacts = useFileArtifacts({
    accessToken,
    scope: issueFileScope,
  })
  const {
    data: issueDetail,
    error: detailError,
    isLoading: isIssueDetailLoading,
    mutate: mutateIssueDetail,
    key: detailKey,
  } = useTeamIssueDetail(
    accessToken,
    teamId,
    resolvedSelectedIssueId,
  )
  const screenIssues = issueDetail?.issue
    ? issues.map((issue) => issue.id === issueDetail.issue.id ? issueDetail.issue : issue)
    : issues
  const { data: assigneeOptionsResult, error: assigneeOptionsError } = useActiveProjectMembers(
    accessToken,
    activeTeam?.projects.map((project) => project.id) ?? [],
    Boolean(activeTeam),
  )
  const assigneeOptions = assigneeOptionsResult?.members ?? emptyMembers
  const userInitial =
    (user?.attributes.name ?? user?.attributes.email ?? user?.username ?? 'J')
      .trim()
      .charAt(0)
      .toUpperCase() || 'J'
  const canManageStructure = canManageWorkspaceStructure(user)
  const canMutateContent = canMutateWorkspaceContent(user)
  const currentUserErrorAction = resolveEnterpriseSessionErrorsAction(
    currentUserError,
    [
      workspaceAccessError,
      projectDirectoryError,
      issueError,
      workItemConfigurationError,
      detailError,
      assigneeOptionsError,
      ...(assigneeOptionsResult?.errors ?? []),
      authenticatedApiError,
      ...(artifacts.sessionErrors ?? []),
      ...(collaboration.sessionErrors ?? []),
    ],
    `${location.pathname}${location.search}${location.hash}`,
  )
  const guardEnterpriseSession = async <Result,>(request: Promise<Result>) => {
    try {
      return await request
    } catch (error) {
      setAuthenticatedApiError(() => error)
      throw error
    }
  }
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(currentUserError && currentUserErrorAction?.kind !== 'stay') ||
    Boolean(user && isProjectDirectoryLoading) ||
    Boolean(user && isIssuesLoading) ||
    Boolean(user && isWorkItemConfigurationLoading)
  const issueErrorMessage = currentUserErrorAction?.kind === 'stay' || issueError
    ? t('issues.error.loading')
    : undefined
  const detailErrorMessage = detailError
    ? t('issues.error.detail')
    : undefined
  const configurationErrorMessage = workItemConfigurationError
    ? t('workItems.configuration.loadError')
    : undefined

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${activeTeam?.name ?? t('issues.title')} | ${t('app.title')}`
  }, [activeTeam?.name, locale, t])

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
    if (!isCreateIssueRequested) {
      return
    }

    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.delete('create')
    setSearchParams(nextSearchParams, { replace: true })
  }, [isCreateIssueRequested, searchParams, setSearchParams])

  const handleCreateIssue = async (input: CreateTeamIssueInput) => {
    if (!accessToken) {
      return
    }

    const issue = await guardEnterpriseSession(mutationRequestRunner.run(
      `issue:create:${teamId}`,
      JSON.stringify(input),
      (context) => createTeamIssue(teamId, accessToken, input, context),
    ))
    navigate(createTeamIssuesPath(teamId, issue.id))
    await mutateIssues()
  }

  const handleUpdateIssue = async (issueId: string, input: UpdateTeamIssueInput) => {
    if (!accessToken) {
      return
    }

    const currentIssue = issueDetail?.issue.id === issueId
      ? issueDetail.issue
      : issues.find((issue) => issue.id === issueId)

    if (!currentIssue) {
      return
    }

    try {
      await guardEnterpriseSession(mutationRequestRunner.run(
        `issue:update:${teamId}:${issueId}`,
        JSON.stringify([currentIssue.revision, input]),
        (context) => updateTeamIssue(
          teamId,
          issueId,
          accessToken,
          {
            ...input,
            expectedRevision: currentIssue.revision,
          },
          context,
        ),
      ))
      await mutateIssues()
      await mutateIssueDetail()
    } catch (error) {
      if (error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict') {
        await Promise.all([mutateIssues(), mutateIssueDetail()])
        throw new Error(t('issues.error.conflict'), { cause: error })
      }

      throw error
    }
  }

  const handleAddRelation = async (
    issueId: string,
    input: WorkItemRelationEditorInput,
  ) => {
    if (!accessToken) {
      return
    }

    const graphRevision = readSelectedRelationGraphRevision(issueDetail, issueId, t)

    try {
      await guardEnterpriseSession(mutationRequestRunner.run(
        `issue:relation:create:${teamId}:${issueId}`,
        JSON.stringify([graphRevision, input]),
        (context) => createWorkItemRelation(
          teamId,
          issueId,
          accessToken,
          { ...input, expectedGraphRevision: graphRevision },
          context,
        ),
      ))
      await mutateIssueDetail()
    } catch (error) {
      await refreshRelationDetailAfterConflict(error, mutateIssueDetail)
      throw error
    }
  }

  const handleDeleteRelation = async (issueId: string, relation: WorkItemRelation) => {
    if (!accessToken) {
      return
    }

    const graphRevision = readSelectedRelationGraphRevision(issueDetail, issueId, t)

    try {
      await guardEnterpriseSession(mutationRequestRunner.run(
        `issue:relation:delete:${teamId}:${issueId}`,
        JSON.stringify([graphRevision, relation.type, relation.targetWorkItemId]),
        (context) => deleteWorkItemRelation(
          teamId,
          issueId,
          accessToken,
          {
            expectedGraphRevision: graphRevision,
            targetWorkItemId: relation.targetWorkItemId,
            type: relation.type,
          },
          context,
        ),
      ))
      await mutateIssueDetail()
    } catch (error) {
      await refreshRelationDetailAfterConflict(error, mutateIssueDetail)
      throw error
    }
  }

  return (
    <TeamIssueScreen
      accessToken={accessToken}
      assigneeOptions={assigneeOptions}
      artifacts={artifacts}
      collaboration={collaboration}
      canManageExternalLinks={canManageStructure}
      configurationErrorMessage={configurationErrorMessage}
      currentWorkspaceMemberKey={workspaceAccess?.currentMember.memberKey}
      detailErrorMessage={detailErrorMessage}
      externalLinksAccessToken={accessToken}
      defaultCreateIssueOpen={isCreateIssueRequested}
      focusedCommentId={focusedCommentId}
      focusedRootCommentId={focusedRootCommentId}
      issueErrorMessage={issueErrorMessage}
      issues={screenIssues}
      isLoading={isLoading}
      isRelationsLoading={Boolean(detailKey && isIssueDetailLoading)}
      key={teamId}
      locale={locale}
      onAddRelation={canMutateContent ? handleAddRelation : undefined}
      onCreateIssue={canMutateContent && !workItemConfigurationError ? handleCreateIssue : undefined}
      onDeleteRelation={canMutateContent ? handleDeleteRelation : undefined}
      onSelectIssue={(issueId) => navigate(createTeamIssuesPath(teamId, issueId))}
      onUpdateIssue={canMutateContent && !workItemConfigurationError ? handleUpdateIssue : undefined}
      selectedIssueId={resolvedSelectedIssueId}
      relations={issueDetail && issueDetail.issue.id === resolvedSelectedIssueId
        ? issueDetail.relations ?? []
        : []}
      resolvedConfiguration={resolvedConfiguration ?? issueDetail?.resolvedConfiguration}
      teamId={teamId}
      teamName={activeTeam?.name}
      teams={teams}
      userInitial={userInitial}
      workspaceMembers={workspaceAccess?.members ?? emptyWorkspaceMembers}
    />
  )
}

/**
 * チーム所有 Issue の管理 UI を描画する Storybook 兼用 screen です。
 */
export function TeamIssueScreen({
  accessToken,
  assigneeOptions = [],
  artifacts,
  canManageExternalLinks = false,
  collaboration,
  configurationErrorMessage,
  currentWorkspaceMemberKey,
  defaultCreateIssueOpen = false,
  detailErrorMessage,
  externalLinksAccessToken,
  focusedCommentId,
  focusedRootCommentId,
  initialViewMode = 'table',
  issueErrorMessage,
  issues = [],
  isLoading = false,
  isRelationsLoading = false,
  locale,
  onAddRelation,
  onCreateIssue,
  onDeleteRelation,
  onSelectIssue,
  onUpdateIssue,
  relations = [],
  resolvedConfiguration,
  selectedIssueId,
  teamId,
  teamName,
  teams,
  userInitial,
  workspaceMembers = emptyWorkspaceMembers,
}: TeamIssueScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const { openMobileSidebar } = useWorkspaceSidebarController()
  const [viewMode, setViewMode] = useState<IssueViewMode>(initialViewMode)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [definitionFilter, setDefinitionFilter] = useState<WorkItemDefinitionFilter>({
    category: 'all',
    customFieldId: '',
  })
  const [isCreateOpen, setIsCreateOpen] = useState(defaultCreateIssueOpen)
  const [createWorkflowStatusId, setCreateWorkflowStatusId] = useState<string>()
  const [createErrorMessage, setCreateErrorMessage] = useState<string | undefined>()
  const [detailUpdateError, setDetailUpdateError] = useState<readonly [string, string] | undefined>()
  const activeTeam = teams.find((team) => team.id === teamId)
  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId)

  useEffect(() => {
    if (defaultCreateIssueOpen) {
      queueMicrotask(() => setIsCreateOpen(true))
    }
  }, [defaultCreateIssueOpen])

  const configuration = resolvedConfiguration?.configuration
  const workflowStatuses = useMemo(
    () => resolveDisplayWorkflowStatuses(configuration),
    [configuration],
  )
  const effectiveStatusFilter = statusFilter === 'all' ||
    workflowStatuses.some((status) => status.id === statusFilter)
    ? statusFilter
    : 'all'
  const effectiveDefinitionFilter = useMemo(() =>
    !definitionFilter.customFieldId ||
      configuration?.customFields.some((field) => field.id === definitionFilter.customFieldId)
      ? definitionFilter
      : {
          category: definitionFilter.category,
          customFieldId: '',
        },
  [configuration?.customFields, definitionFilter])
  const personLabels = useMemo(
    () => Object.fromEntries(workspaceMembers.map((member) => [member.email, member.name ?? member.email])),
    [workspaceMembers],
  )
  const selectedIssueUpdateErrorKey = selectedIssue
    ? JSON.stringify([selectedIssue.teamId, selectedIssue.id])
    : undefined
  const detailErrorMessageLocal = detailUpdateError && detailUpdateError[0] === selectedIssueUpdateErrorKey
    ? detailUpdateError[1]
    : undefined

  /** Opens the Team create form with an optional Board-column status context. */
  const openCreateIssue = (workflowStatusId?: string) => {
    setCreateErrorMessage(undefined)
    setCreateWorkflowStatusId(workflowStatusId)
    setIsCreateOpen(true)
  }

  /** Closes the Team create form and clears its contextual defaults. */
  const closeCreateIssue = () => {
    setCreateErrorMessage(undefined)
    setCreateWorkflowStatusId(undefined)
    setIsCreateOpen(false)
  }

  const visibleIssues = useMemo(
    () =>
      issues.filter((issue) => {
        const matchesStatus = effectiveStatusFilter === 'all' ||
          resolveWorkItemWorkflowStatusId(issue) === effectiveStatusFilter
        const matchesDefinition = matchesWorkItemDefinitionFilter(
          issue,
          configuration,
          effectiveDefinitionFilter,
        )
        const normalizedQuery = searchQuery.trim().toLowerCase()

        if (!matchesStatus || !matchesDefinition) {
          return false
        }

        if (!normalizedQuery) {
          return true
        }

        return [
          resolveIssueTitle(issue, t),
          resolveWorkItemAssignee(issue),
          resolveAssignedProjectName(issue, activeTeam, t),
          resolveWorkItemWorkflowStatusLabel(issue, configuration),
          t(`tasks.priority.${issue.priority}`),
          ...resolveIssueCustomFieldSearchValues(
            issue,
            configuration,
            locale,
            personLabels,
          ),
        ].some((value) => value.toLowerCase().includes(normalizedQuery))
      }),
    [
      activeTeam,
      configuration,
      effectiveDefinitionFilter,
      effectiveStatusFilter,
      issues,
      locale,
      personLabels,
      searchQuery,
      t,
    ],
  )

  return (
    <>
        <header className="workbench-header flex-none px-[clamp(20px,3vw,34px)] py-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <MobileSidebarButton
                label={t('sidebar.mobileOpen')}
                onClick={openMobileSidebar}
              />
              <div className="min-w-0">
                <p className="workbench-eyebrow">
                  {t('issues.eyebrow')}
                </p>
                <h1
                  className="workbench-title mt-2 truncate text-page-title"
                  data-testid="team-issues-heading"
                >
                  {teamName ?? t('issues.title')}
                </h1>
                <p className="workbench-description mt-2 max-w-[760px]">
                  {t('issues.description')}
                </p>
              </div>
            </div>
            <div className="flex flex-none items-center gap-3">
              {onCreateIssue ? (
                <button
                  aria-expanded={isCreateOpen}
                  className="workbench-button-primary inline-flex h-10 items-center gap-2 px-4"
                  onClick={() => isCreateOpen ? closeCreateIssue() : openCreateIssue()}
                  type="button"
                >
                  + {t('issues.action.new')}
                </button>
              ) : null}
              <div className="grid h-10 w-10 place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-sm font-semibold text-[var(--workbench-primary)]">
                {userInitial}
              </div>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-sm font-medium text-[var(--workbench-muted)]">
            {t('issues.loading')}
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <div className="grid min-h-full grid-cols-[minmax(0,1fr)_minmax(360px,440px)] gap-0 max-[1080px]:grid-cols-1">
              <section className="min-w-0 px-[clamp(20px,3vw,34px)] py-5">
                {configurationErrorMessage ? (
                  <p
                    className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"
                    role="alert"
                  >
                    {configurationErrorMessage}
                  </p>
                ) : null}
                {isCreateOpen && onCreateIssue ? (
                  <CreateIssuePanel
                    key={`create-issue-${createWorkflowStatusId ?? ''}`}
                    assigneeOptions={assigneeOptions}
                    configuration={configuration}
                    errorMessage={createErrorMessage}
                    workflowStatusId={createWorkflowStatusId}
                    locale={locale}
                    onCancel={() => {
                      closeCreateIssue()
                    }}
                    onSubmit={async (input) => {
                      if (!onCreateIssue) {
                        return
                      }

                      setCreateErrorMessage(undefined)

                      try {
                        await onCreateIssue(input)
                        closeCreateIssue()
                      } catch (error) {
                        setCreateErrorMessage(error instanceof Error ? error.message : t('issues.error.create'))
                      }
                    }}
                    projects={activeTeam?.projects ?? []}
                    t={t}
                    workspaceMembers={workspaceMembers}
                  />
                ) : null}
                <IssueToolbar
                  onSearchQueryChange={setSearchQuery}
                  onStatusFilterChange={setStatusFilter}
                  onViewModeChange={setViewMode}
                  searchQuery={searchQuery}
                  statusFilter={effectiveStatusFilter}
                  t={t}
                  viewMode={viewMode}
                  workflowStatuses={workflowStatuses}
                />
                <div className="workbench-toolbar mt-3 px-3 py-2">
                  <WorkItemDefinitionFilters
                    configuration={configuration}
                    idPrefix="team-issues"
                    locale={locale}
                    onChange={setDefinitionFilter}
                    personOptions={resolveWorkItemPersonOptions(workspaceMembers)}
                    value={effectiveDefinitionFilter}
                  />
                </div>
                {issueErrorMessage ? (
                  <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
                    {issueErrorMessage}
                  </p>
                ) : null}
                <div
                  aria-label={t(`issues.view.${viewMode}`)}
                  id={issueViewPanelId}
                  role="region"
                >
                  {viewMode === 'table' ? (
                    <IssueTable
                      activeTeam={activeTeam}
                      configuration={configuration}
                      issues={visibleIssues}
                      locale={locale}
                      onSelectIssue={(issueId) => {
                        setDetailUpdateError(undefined)
                        onSelectIssue?.(issueId)
                      }}
                      selectedIssueId={selectedIssueId}
                      t={t}
                      workspaceMembers={workspaceMembers}
                    />
                  ) : (
                    <IssueBoard
                      activeTeam={activeTeam}
                      configuration={configuration}
                      issues={visibleIssues}
                      locale={locale}
                      onCreateIssueOpen={onCreateIssue ? openCreateIssue : undefined}
                      onSelectIssue={(issueId) => {
                        setDetailUpdateError(undefined)
                        onSelectIssue?.(issueId)
                      }}
                      selectedIssueId={selectedIssueId}
                      t={t}
                      workflowStatuses={workflowStatuses}
                      workspaceMembers={workspaceMembers}
                      onUpdateIssue={onUpdateIssue}
                    />
                  )}
                </div>
              </section>
              <IssueDetailPane
                accessToken={accessToken}
                assigneeOptions={assigneeOptions}
                artifacts={artifacts}
                canManageExternalLinks={canManageExternalLinks}
                collaboration={collaboration}
                configuration={configuration}
                currentWorkspaceMemberKey={currentWorkspaceMemberKey}
                detailErrorMessage={detailErrorMessage ?? detailErrorMessageLocal}
                externalLinksAccessToken={externalLinksAccessToken}
                focusedCommentId={focusedCommentId}
                focusedRootCommentId={focusedRootCommentId}
                issue={selectedIssue}
                isRelationsLoading={isRelationsLoading}
                locale={locale}
                onAddRelation={onAddRelation}
                onDeleteRelation={onDeleteRelation}
                onUpdateIssue={onUpdateIssue ? async (issueId, input) => {
                  setDetailUpdateError(undefined)

                  try {
                    await onUpdateIssue(issueId, input)
                  } catch (error) {
                    if (selectedIssueUpdateErrorKey) {
                      setDetailUpdateError([
                        selectedIssueUpdateErrorKey,
                        error instanceof Error ? error.message : t('issues.error.update'),
                      ])
                    }
                  }
                } : undefined}
                projects={activeTeam?.projects ?? []}
                relationCandidates={issues}
                relations={relations}
                t={t}
                workspaceMembers={workspaceMembers}
              />
            </div>
          </div>
        )}
    </>
  )
}

/**
 * Issue 一覧の検索、status filter、表示切り替えをまとめた toolbar です。
 */
function IssueToolbar({
  onSearchQueryChange,
  onStatusFilterChange,
  onViewModeChange,
  searchQuery,
  statusFilter,
  t,
  viewMode,
  workflowStatuses,
}: {
  /**
   * 検索 query を更新する callback です。
   */
  onSearchQueryChange: (query: string) => void
  /**
   * Workflow status filter を更新する callback です。
   */
  onStatusFilterChange: (status: string) => void
  /**
   * Issue 表示 mode を更新する callback です。
   */
  onViewModeChange: (mode: IssueViewMode) => void
  /**
   * 検索 input の現在値です。
   */
  searchQuery: string
  /**
   * Status select の現在値です。
   */
  statusFilter: string
  /**
   * 画面文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * 現在表示中の Issue view mode です。
   */
  viewMode: IssueViewMode
  /**
   * Status filter に表示する workflow status です。
   */
  workflowStatuses: readonly WorkflowStatusDefinition[]
}) {
  return (
    <div className="workbench-toolbar flex flex-wrap items-center justify-between gap-3 px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <label className="grid gap-1">
          <span className="sr-only">{t('issues.search')}</span>
          <input
            aria-label={t('issues.search')}
            className="workbench-input h-9 w-[min(260px,calc(100vw-52px))] px-3.5 placeholder:text-[var(--workbench-muted-soft)]"
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder={t('issues.search')}
            type="search"
            value={searchQuery}
          />
        </label>
        <select
          aria-label={t('issues.filter.status')}
          className="workbench-input h-9 px-3"
          onChange={(event) => onStatusFilterChange(event.target.value)}
          value={statusFilter}
        >
          <option value="all">{t('tasks.filter.statusAll')}</option>
          {workflowStatuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
      </div>
      <div className="inline-flex h-9 overflow-hidden rounded-[7px] border border-[var(--workbench-border-strong)] bg-white">
        {(['table', 'board'] as const).map((mode) => (
          <button
            aria-controls={issueViewPanelId}
            aria-pressed={viewMode === mode}
            className={`px-3.5 text-sm font-semibold transition ${
              viewMode === mode ? 'bg-[var(--workbench-primary)] text-white' : 'text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]'
            }`}
            key={mode}
            onClick={() => onViewModeChange(mode)}
            type="button"
          >
            {t(`issues.view.${mode}`)}
          </button>
        ))}
      </div>
    </div>
  )
}

function CreateIssuePanel({
  assigneeOptions,
  configuration,
  errorMessage,
  locale,
  onCancel,
  onSubmit,
  projects,
  t,
  workflowStatusId,
  workspaceMembers,
}: {
  assigneeOptions: ProjectMember[]
  configuration?: WorkItemConfiguration
  errorMessage?: string
  locale: Locale
  onCancel: () => void
  onSubmit: (input: CreateTeamIssueInput) => Promise<void>
  projects: ProjectDirectoryTeam['projects']
  t: (key: MessageKey) => string
  workflowStatusId?: string
  workspaceMembers: WorkspaceMember[]
}) {
  const today = formatLocalDateInputValue()
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const workflowStatuses = resolveCreateWorkflowStatuses(configuration)
  const contextualWorkflowStatusId = workflowStatusId && workflowStatuses.some((status) => status.id === workflowStatusId)
    ? workflowStatusId
    : undefined
  const initialWorkflowStatusId = contextualWorkflowStatusId ?? configuration?.workflow.initialStatusId ?? workflowStatuses[0]?.id ?? ''
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const defaultCustomFieldValues = configuration
    ? createDefaultCustomFieldValues(configuration.customFields, selectedProjectId || undefined)
    : {}
  const hasCustomFields = configuration?.customFields.some((definition) =>
    isCustomFieldApplicable(definition, selectedProjectId || undefined),
  ) ?? false

  return (
    <section className="workbench-panel mb-5 min-w-0 p-5">
      <form
        className="grid min-w-0 gap-4"
        data-testid="create-issue-form"
        onSubmit={(event) => {
          event.preventDefault()
          const formData = new FormData(event.currentTarget)
          const title = String(formData.get('title') ?? '').trim()
          const description = String(formData.get('description') ?? '').trim()
          const assignedProjectId = String(formData.get('assignedProjectId') ?? '').trim()
          const assigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const dueDate = String(formData.get('dueDate') ?? '').trim()
          const schedule = dueDate
            ? createDefaultDueDateTaskSchedule(dueDate)
            : createDefaultUnscheduledTaskSchedule()
          const workflowStatusId = String(
            formData.get('workflowStatusId') ?? initialWorkflowStatusId,
          ).trim()
          const workflowStatus = workflowStatuses.find((status) => status.id === workflowStatusId)
          const parsedCustomFields = configuration
            ? parseCustomFieldFormData(formData, configuration.customFields, {
                applyDefaults: true,
                projectId: assignedProjectId || undefined,
              })
            : { errors: [], values: {} }

          if (!workflowStatus || parsedCustomFields.errors.length > 0) {
            setFieldErrors(createCustomFieldErrorMessages(
              parsedCustomFields.errors,
              configuration?.customFields ?? [],
              locale,
            ))
            return
          }

          setFieldErrors({})

          void onSubmit({
            title,
            description,
            assignedProjectId: assignedProjectId || undefined,
            assigneeUserId,
            customFieldValues: parsedCustomFields.values,
            priority: resolveIssuePriority(formData.get('priority')),
            schedule,
            workflowStatusId,
          })
        }}
      >
        <div className="grid grid-cols-1 gap-3 min-[1180px]:grid-cols-2">
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.create.title')}
            <input
              className="workbench-input h-10 w-full min-w-0 px-3"
              name="title"
              placeholder={t('issues.create.titlePlaceholder')}
              required
            />
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.create.project')}
            <select
              className="workbench-input h-10 w-full min-w-0 px-3"
              name="assignedProjectId"
              onChange={(event) => setSelectedProjectId(event.target.value)}
              value={selectedProjectId}
            >
              <option value="">{t('issues.project.unassigned')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.create.assignee')}
            <select className="workbench-input h-10 w-full min-w-0 px-3" name="assigneeUserId" required>
              <option disabled hidden value="">
                {t('tasks.create.assigneeSelectPlaceholder')}
              </option>
              {assigneeOptions.map((member) => (
                <option key={member.id} value={member.id}>
                  {formatProjectMemberOption(member)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.column.dueDate')}
            <input className="workbench-input h-10 w-full min-w-0 px-3" defaultValue={today} name="dueDate" type="date" />
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.column.status')}
            <select
              className="workbench-input h-10 w-full min-w-0 px-3"
              defaultValue={initialWorkflowStatusId}
              name="workflowStatusId"
            >
              {workflowStatuses.map((status) => (
                <option key={status.id} value={status.id}>
                  {status.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.column.priority')}
            <select className="workbench-input h-10 w-full min-w-0 px-3" defaultValue="medium" name="priority">
              {issuePriorities.map((priority) => (
                <option key={priority} value={priority}>
                  {t(`tasks.priority.${priority}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {t('issues.create.description')}
          <textarea
            className="workbench-input min-h-20 w-full min-w-0 px-3 py-2"
            name="description"
            placeholder={t('issues.create.descriptionPlaceholder')}
          />
        </label>
        {hasCustomFields ? (
          <div className="workbench-panel-muted p-4">
            <WorkItemFieldsEditor
              definitions={configuration?.customFields ?? []}
              errors={fieldErrors}
              locale={locale}
              personOptions={personOptions}
              projectId={selectedProjectId || undefined}
              values={defaultCustomFieldValues}
            />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <button className="workbench-button-primary h-10 px-4" type="submit">
            {t('issues.create.submit')}
          </button>
          <button className="workbench-button-secondary h-10 px-4" onClick={onCancel} type="button">
            {t('tasks.create.cancel')}
          </button>
          {errorMessage ? <p className="text-sm font-bold text-red-600">{errorMessage}</p> : null}
        </div>
      </form>
    </section>
  )
}

function IssueTable({
  activeTeam,
  configuration,
  issues,
  locale,
  onSelectIssue,
  selectedIssueId,
  t,
  workspaceMembers,
}: {
  activeTeam?: ProjectDirectoryTeam
  configuration?: WorkItemConfiguration
  issues: TeamIssue[]
  locale: Locale
  onSelectIssue?: (issueId: string) => void
  selectedIssueId?: string
  t: (key: MessageKey) => string
  workspaceMembers: WorkspaceMember[]
}) {
  const personLabels = Object.fromEntries(
    workspaceMembers.map((member) => [member.email, member.name ?? member.email]),
  )

  return (
    <section className="workbench-table mt-5 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] border-collapse">
          <thead>
            <tr className="workbench-table-head text-left">
              <th className="px-5 py-4" scope="col">{t('issues.column.title')}</th>
              <th className="px-4 py-4" scope="col">{t('issues.column.project')}</th>
              <th className="px-4 py-4" scope="col">{t('tasks.column.assignee')}</th>
              <th className="px-4 py-4" scope="col">{t('tasks.column.status')}</th>
              <th className="px-4 py-4" scope="col">{t('workItems.fields.title')}</th>
              <th className="px-4 py-4" scope="col">{t('tasks.column.dueDate')}</th>
              <th className="px-4 py-4" scope="col">{t('tasks.column.priority')}</th>
            </tr>
          </thead>
          <tbody>
            {issues.length > 0 ? (
              issues.map((issue) => (
                <tr
                  className={`border-b border-slate-100 transition last:border-b-0 ${
                    selectedIssueId === issue.id ? 'workbench-row-selected' : ''
                  }`}
                  key={issue.id}
                >
                  <td className="p-0 text-sm font-semibold text-[var(--workbench-text)]">
                    <button
                      aria-pressed={selectedIssueId === issue.id}
                      className="w-full rounded-sm px-5 py-3 text-left font-semibold transition hover:text-[var(--workbench-primary)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#2563eb]/10 disabled:cursor-default disabled:text-[var(--workbench-text)]"
                      data-testid={`issue-row-${issue.id}`}
                      disabled={!onSelectIssue}
                      onClick={() => onSelectIssue?.(issue.id)}
                      type="button"
                    >
                      {resolveIssueTitle(issue, t)}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-[var(--workbench-muted)]">{resolveAssignedProjectName(issue, activeTeam, t)}</td>
                  <td className="px-4 py-3 text-sm font-medium text-[var(--workbench-muted)]">{resolveWorkItemAssignee(issue)}</td>
                  <td className="px-4 py-4">
                    <IssueStatusBadge configuration={configuration} issue={issue} />
                  </td>
                  <td className="max-w-64 px-4 py-3">
                    <IssueCustomFieldSummary
                      configuration={configuration}
                      issue={issue}
                      locale={locale}
                      personLabels={personLabels}
                    />
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-[var(--workbench-muted)]">{issue.dueDate}</td>
                  <td className="px-4 py-4"><IssuePriorityBadge priority={issue.priority} t={t} /></td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]" colSpan={7} data-testid="team-issues-empty">
                  {t('issues.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t border-[var(--workbench-border)] px-5 py-3 text-sm font-medium text-[var(--workbench-muted)]" data-testid="team-issues-count">
        {t('issues.count').replace('{count}', String(issues.length))}
      </div>
    </section>
  )
}

function IssueBoard({
  activeTeam,
  configuration,
  issues,
  locale,
  onCreateIssueOpen,
  onSelectIssue,
  onUpdateIssue,
  selectedIssueId,
  t,
  workflowStatuses,
  workspaceMembers,
}: {
  activeTeam?: ProjectDirectoryTeam
  configuration?: WorkItemConfiguration
  issues: TeamIssue[]
  locale: Locale
  onCreateIssueOpen?: (workflowStatusId: string) => void
  onSelectIssue?: (issueId: string) => void
  onUpdateIssue?: (issueId: string, input: UpdateTeamIssueInput) => Promise<void>
  selectedIssueId?: string
  t: (key: MessageKey) => string
  workflowStatuses: readonly WorkflowStatusDefinition[]
  workspaceMembers: WorkspaceMember[]
}) {
  const personLabels = Object.fromEntries(
    workspaceMembers.map((member) => [member.email, member.name ?? member.email]),
  )
  const [draggedIssueId, setDraggedIssueId] = useState<string>()
  const [dropTargetStatusId, setDropTargetStatusId] = useState<string>()
  const [movingIssueIds, setMovingIssueIds] = useState<ReadonlySet<string>>(() => new Set())
  const [moveErrorMessage, setMoveErrorMessage] = useState<string>()

  /** Validates and requests a Team workflow status change. */
  const moveIssueToStatus = (issue: TeamIssue, workflowStatusId: string) => {
    if (!onUpdateIssue || issue.workflowStatusId === workflowStatusId) {
      return
    }

    const editableStatuses = resolveEditableWorkflowStatuses(issue, configuration)

    if (!editableStatuses.some((status) => status.id === workflowStatusId)) {
      return
    }

    const issueId = issue.id
    setMoveErrorMessage(undefined)
    setMovingIssueIds((currentIds) => new Set(currentIds).add(issueId))
    void onUpdateIssue(issueId, { workflowStatusId })
      .catch((error) => {
        const cause = error instanceof Error ? error.cause : undefined
        const isConflict = (error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict') ||
          (cause instanceof TeamIssuesApiError && cause.code === 'WorkItemRevisionConflict')

        setMoveErrorMessage(isConflict
          ? t('tasks.action.conflict')
          : t('tasks.action.updateError'))
      })
      .finally(() => {
        setMovingIssueIds((currentIds) => {
          const nextIds = new Set(currentIds)
          nextIds.delete(issueId)
          return nextIds
        })
      })
  }

  /** Starts a native drag for a Team Work Item. */
  const handleDragStart = (event: DragEvent<HTMLElement>, issue: TeamIssue) => {
    if (!onUpdateIssue) {
      return
    }

    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-mukuroji-team-issue-id', issue.id)
    event.dataTransfer.setData('text/plain', issue.id)
    setDraggedIssueId(issue.id)
  }

  /** Resolves a dropped Team Work Item and requests a validated status change. */
  const handleDrop = (event: DragEvent<HTMLElement>, status: WorkflowStatusDefinition) => {
    event.preventDefault()
    const issueId = event.dataTransfer.getData('application/x-mukuroji-team-issue-id') ||
      event.dataTransfer.getData('text/plain') ||
      draggedIssueId
    const issue = issueId ? issues.find((candidate) => candidate.id === issueId) : undefined

    setDraggedIssueId(undefined)
    setDropTargetStatusId(undefined)

    if (issue) {
      moveIssueToStatus(issue, status.id)
    }
  }

  return (
    <section className="mt-5 grid min-w-0 gap-3">
      {moveErrorMessage ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700" role="alert">
          {moveErrorMessage}
        </p>
      ) : null}
      <div className="flex min-w-0 gap-4 overflow-x-auto pb-2">
        {workflowStatuses.map((status) => {
          const columnIssues = issues.filter(
            (issue) => resolveWorkItemWorkflowStatusId(issue) === status.id,
          )

          return (
            <div
              className={`workbench-panel min-h-[420px] w-[min(320px,82vw)] flex-none transition ${dropTargetStatusId === status.id ? 'border-[#99d7cf] bg-[#e5f7f4] ring-2 ring-[#99d7cf]/40' : ''}`}
              key={status.id}
              onDragLeave={() => setDropTargetStatusId(undefined)}
              onDragOver={(event) => {
                if (!onUpdateIssue || !draggedIssueId) {
                  return
                }

                const issue = issues.find((candidate) => candidate.id === draggedIssueId)

                if (!issue || !resolveEditableWorkflowStatuses(issue, configuration).some((candidate) => candidate.id === status.id)) {
                  return
                }

                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropTargetStatusId(status.id)
              }}
              onDrop={(event) => handleDrop(event, status)}
            >
              <div className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] px-4 py-3">
                <IssueStatusBadge status={status} />
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--workbench-muted)]">{columnIssues.length}</span>
                  {onCreateIssueOpen ? (
                    <button
                      aria-label={`${t('tasks.board.addInColumn')}: ${status.name}`}
                      className="grid h-7 w-7 place-items-center rounded-md border border-[var(--workbench-border-strong)] bg-white text-lg leading-none text-[var(--workbench-primary)] hover:border-[#99d7cf] hover:bg-[#e5f7f4]"
                      data-testid={`team-issue-add-${status.id}`}
                      onClick={() => onCreateIssueOpen(status.id)}
                      type="button"
                    >
                      +
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="grid gap-3 p-3">
                {columnIssues.length > 0 ? (
                  columnIssues.map((issue) => {
                    const isMoving = movingIssueIds.has(issue.id)
                    const editableStatuses = resolveEditableWorkflowStatuses(issue, configuration)

                    return (
                      <article
                        aria-grabbed={draggedIssueId === issue.id || undefined}
                        className={`rounded-lg border p-4 text-left transition ${
                          selectedIssueId === issue.id
                            ? 'border-[#99d7cf] bg-[#e5f7f4]'
                            : 'border-[var(--workbench-border)] bg-white hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]'
                        } ${draggedIssueId === issue.id ? 'opacity-50 ring-2 ring-[#99d7cf]' : ''} ${isMoving ? 'opacity-70' : ''}`}
                        data-testid={`team-issue-card-${issue.id}`}
                        draggable={Boolean(onUpdateIssue) && !isMoving}
                        key={issue.id}
                        onDragEnd={() => {
                          setDraggedIssueId(undefined)
                          setDropTargetStatusId(undefined)
                        }}
                        onDragStart={(event) => handleDragStart(event, issue)}
                      >
                        <button
                          aria-pressed={selectedIssueId === issue.id}
                          className="w-full text-left text-sm font-semibold leading-6 text-[var(--workbench-text)] hover:text-[var(--workbench-primary)] disabled:cursor-default disabled:text-[var(--workbench-text)]"
                          disabled={!onSelectIssue}
                          onClick={() => onSelectIssue?.(issue.id)}
                          type="button"
                        >
                          {resolveIssueTitle(issue, t)}
                        </button>
                        <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">{resolveAssignedProjectName(issue, activeTeam, t)}</p>
                        <div className="mt-3">
                          <IssueCustomFieldSummary
                            configuration={configuration}
                            issue={issue}
                            locale={locale}
                            personLabels={personLabels}
                          />
                        </div>
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <IssuePriorityBadge priority={issue.priority} t={t} />
                          <span className="text-xs font-semibold text-[var(--workbench-muted)]">{issue.dueDate}</span>
                        </div>
                        {onUpdateIssue && editableStatuses.length > 0 ? (
                          <select
                            aria-label={`${resolveIssueTitle(issue, t)}: ${t('tasks.column.status')}`}
                            className="workbench-input mt-3 h-8 w-full px-2 text-xs"
                            disabled={isMoving}
                            onChange={(event) => moveIssueToStatus(issue, event.target.value)}
                            value={issue.workflowStatusId}
                          >
                            {editableStatuses.map((editableStatus) => (
                              <option key={editableStatus.id} value={editableStatus.id}>
                                {editableStatus.name}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {onUpdateIssue ? (
                          <p className="mt-2 text-[11px] font-medium text-[var(--workbench-muted)]">
                            {t('tasks.board.dragHint')}
                          </p>
                        ) : null}
                      </article>
                    )
                  })
                ) : (
                  <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
                    {t('tasks.board.empty')}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function IssueDetailPane({
  accessToken,
  assigneeOptions,
  artifacts,
  canManageExternalLinks,
  collaboration,
  configuration,
  currentWorkspaceMemberKey,
  detailErrorMessage,
  externalLinksAccessToken,
  focusedCommentId,
  focusedRootCommentId,
  issue,
  isRelationsLoading,
  locale,
  onAddRelation,
  onDeleteRelation,
  onUpdateIssue,
  projects,
  relationCandidates,
  relations,
  t,
  workspaceMembers,
}: {
  accessToken?: string
  assigneeOptions: ProjectMember[]
  artifacts?: FileArtifactsController
  canManageExternalLinks: boolean
  collaboration?: IssueCollaborationController
  configuration?: WorkItemConfiguration
  currentWorkspaceMemberKey?: string
  detailErrorMessage?: string
  externalLinksAccessToken?: string
  focusedCommentId?: string
  focusedRootCommentId?: string
  issue?: TeamIssue
  isRelationsLoading: boolean
  locale: Locale
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
  onUpdateIssue?: (issueId: string, input: UpdateTeamIssueInput) => Promise<void>
  projects: ProjectDirectoryTeam['projects']
  relationCandidates: TeamIssue[]
  relations: readonly WorkItemRelation[]
  t: (key: MessageKey) => string
  workspaceMembers: WorkspaceMember[]
}) {
  if (!issue) {
    return (
      <aside className="workbench-detail-pane min-h-0 min-w-0 px-6 py-7 max-[1080px]:border-l-0 max-[1080px]:border-t">
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('issues.detail.empty')}</p>
      </aside>
    )
  }

  return (
    <IssueDetailContent
      accessToken={accessToken}
      assigneeOptions={assigneeOptions}
      artifacts={artifacts}
      canManageExternalLinks={canManageExternalLinks}
      collaboration={collaboration}
      configuration={configuration}
      currentWorkspaceMemberKey={currentWorkspaceMemberKey}
      detailErrorMessage={detailErrorMessage}
      externalLinksAccessToken={externalLinksAccessToken}
      focusedCommentId={focusedCommentId}
      focusedRootCommentId={focusedRootCommentId}
      issue={issue}
      isRelationsLoading={isRelationsLoading}
      key={issue.id}
      locale={locale}
      onAddRelation={onAddRelation}
      onDeleteRelation={onDeleteRelation}
      onUpdateIssue={onUpdateIssue}
      projects={projects}
      relationCandidates={relationCandidates}
      relations={relations}
      t={t}
      workspaceMembers={workspaceMembers}
    />
  )
}

function IssueDetailContent({
  accessToken,
  assigneeOptions,
  artifacts,
  canManageExternalLinks,
  collaboration,
  configuration,
  currentWorkspaceMemberKey,
  detailErrorMessage,
  externalLinksAccessToken,
  focusedCommentId,
  focusedRootCommentId,
  issue,
  isRelationsLoading,
  locale,
  onAddRelation,
  onDeleteRelation,
  onUpdateIssue,
  projects,
  relationCandidates,
  relations,
  t,
  workspaceMembers,
}: {
  /** Related Documents を取得する access token です。 */
  accessToken?: string
  /** 担当者 selector の候補です。 */
  assigneeOptions: ProjectMember[]
  /** 選択中 Issue の file/version/annotation/approval controller です。 */
  artifacts?: FileArtifactsController
  /** External link の作成、更新、解除が許可されているかどうかです。 */
  canManageExternalLinks: boolean
  /** 選択中 Issue の discussion controller です。 */
  collaboration?: IssueCollaborationController
  /** 選択中 Issue に適用する configuration です。 */
  configuration?: WorkItemConfiguration
  /** 現在の Workspace member key です。 */
  currentWorkspaceMemberKey?: string
  /** Detail mutation error の表示文言です。 */
  detailErrorMessage?: string
  /** External link management API の Bearer token です。 */
  externalLinksAccessToken?: string
  /** notification deep link から focus する comment ID です。 */
  focusedCommentId?: string
  /** notification deep link の reply が属する root comment ID です。 */
  focusedRootCommentId?: string
  /** 編集対象 Issue です。 */
  issue: TeamIssue
  /** Relation 候補の取得中かどうかです。 */
  isRelationsLoading: boolean
  /** 表示 locale です。 */
  locale: Locale
  /** Relation 追加 callback です。 */
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /** Relation 解除 callback です。 */
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
  /** Issue 更新 callback です。 */
  onUpdateIssue?: (issueId: string, input: UpdateTeamIssueInput) => Promise<void>
  /** Project selector の候補です。 */
  projects: ProjectDirectoryTeam['projects']
  /** Relation target の候補です。 */
  relationCandidates: TeamIssue[]
  /** 選択中 Issue の relation 一覧です。 */
  relations: readonly WorkItemRelation[]
  /** i18n translator です。 */
  t: (key: MessageKey) => string
  /** Person field と discussion で使う Workspace member 一覧です。 */
  workspaceMembers: WorkspaceMember[]
}) {
  const [selectedProject, setSelectedProject] = useState({
    revision: issue.revision,
    value: issue.assignedProjectId ?? '',
  })
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const selectedProjectId = selectedProject.revision === issue.revision
    ? selectedProject.value
    : issue.assignedProjectId ?? ''

  const isIssueReadOnly = !onUpdateIssue
  const hasSelectedAssigneeOption = assigneeOptions.some((member) => member.id === issue.assigneeUserId)
  const currentWorkflowStatusId = resolveWorkItemWorkflowStatusId(issue)
  const workflowStatuses = resolveEditableWorkflowStatuses(
    issue,
    configuration,
  )
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const hasCustomFields = configuration?.customFields.some((definition) =>
    isCustomFieldApplicable(definition, selectedProjectId || undefined)
  ) ?? false

  return (
    <aside className="workbench-detail-pane min-h-0 min-w-0 max-[1080px]:border-l-0 max-[1080px]:border-t">
      <form
        className="grid min-w-0 gap-4 px-6 py-7"
        key={`${issue.id}:${issue.revision}`}
        onSubmit={(event) => {
          event.preventDefault()

          if (!onUpdateIssue) {
            return
          }

          const formData = new FormData(event.currentTarget)
          const assignedProjectId = String(formData.get('assignedProjectId') ?? '').trim()
          const selectedAssigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const workflowStatusId = String(
            formData.get('workflowStatusId') ?? currentWorkflowStatusId,
          ).trim()
          const parsedCustomFields = configuration
            ? parseCustomFieldFormData(formData, configuration.customFields, {
                projectId: assignedProjectId || undefined,
              })
            : { errors: [], values: {} }

          if (parsedCustomFields.errors.length > 0) {
            setFieldErrors(createCustomFieldErrorMessages(
              parsedCustomFields.errors,
              configuration?.customFields ?? [],
              locale,
            ))
            return
          }

          setFieldErrors({})
          const nextIssueInput: UpdateTeamIssueInput = {
            assignedProjectId: assignedProjectId || null,
            customFieldValues: createCustomFieldValuePatch(
              configuration?.customFields ?? [],
              issue.customFieldValues,
              parsedCustomFields.values,
              assignedProjectId || undefined,
            ),
            description: String(formData.get('description') ?? '').trim(),
            priority: resolveIssuePriority(formData.get('priority')),
            title: String(formData.get('title') ?? '').trim(),
            workflowStatusId,
          }

          if (assigneeOptions.some((member) => member.id === selectedAssigneeUserId)) {
            nextIssueInput.assigneeUserId = selectedAssigneeUserId
          }

          void onUpdateIssue?.(issue.id, nextIssueInput).catch(() => undefined)
        }}
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="workbench-eyebrow">{t('tasks.detail.title')}</p>
            <p className="mt-1 truncate text-lg font-semibold leading-6 text-[var(--workbench-text)]">
              {resolveIssueTitle(issue, t)}
            </p>
          </div>
          <IssuePriorityBadge priority={issue.priority} t={t} />
        </div>
        <fieldset className="contents" disabled={isIssueReadOnly}>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.column.title')}
            <input className="workbench-input w-full min-w-0 px-3 py-2 text-lg font-semibold disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]" defaultValue={resolveIssueTitle(issue, t)} name="title" required />
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.create.description')}
            <textarea className="workbench-input min-h-28 w-full min-w-0 px-3 py-2 leading-6 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]" defaultValue={issue.description} name="description" />
          </label>
          <div className="workbench-panel-muted grid grid-cols-1 gap-3 p-3">
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('issues.create.project')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                name="assignedProjectId"
                onChange={(event) => setSelectedProject({
                  revision: issue.revision,
                  value: event.target.value,
                })}
                value={selectedProjectId}
              >
                <option value="">{t('issues.project.unassigned')}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('issues.create.assignee')}
              <select className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]" defaultValue={issue.assigneeUserId} name="assigneeUserId">
                {!hasSelectedAssigneeOption ? (
                  <option value={issue.assigneeUserId}>{resolveWorkItemAssignee(issue)}</option>
                ) : null}
                {assigneeOptions.map((member) => (
                  <option key={member.id} value={member.id}>{formatProjectMemberOption(member)}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.column.status')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={currentWorkflowStatusId}
                name="workflowStatusId"
              >
                {workflowStatuses.map((status) => (
                  <option key={status.id} value={status.id}>{status.name}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.column.priority')}
              <select className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]" defaultValue={issue.priority} name="priority">
                {issuePriorities.map((priority) => (
                  <option key={priority} value={priority}>{t(`tasks.priority.${priority}`)}</option>
                ))}
              </select>
            </label>
            <div className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              <span>{t('tasks.schedule.title')}</span>
              <output className="min-h-9 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2 font-medium text-[var(--workbench-muted)]">
                {describeTeamIssueSchedule(issue.schedule, t)}
              </output>
            </div>
          </div>
          {hasCustomFields ? (
            <div className="workbench-panel-muted p-4">
              <WorkItemFieldsEditor
                definitions={configuration?.customFields ?? []}
                errors={fieldErrors}
                locale={locale}
                personOptions={personOptions}
                projectId={selectedProjectId || undefined}
                values={issue.customFieldValues}
              />
            </div>
          ) : null}
        </fieldset>
        <button className="workbench-button-primary h-10 px-4 disabled:border-slate-300 disabled:bg-slate-300" disabled={isIssueReadOnly} type="submit">
          {t('issues.detail.save')}
        </button>
        {isIssueReadOnly ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">
            {t('issues.detail.readOnlyPermission')}
          </p>
        ) : null}
        {detailErrorMessage ? <p className="text-sm font-bold text-red-600">{detailErrorMessage}</p> : null}
      </form>
      {artifacts ? (
        <IssueArtifactsPanel
          completionTransitions={workflowStatuses.filter(
            (status) => status.id !== currentWorkflowStatusId,
          )}
          controller={artifacts}
          currentMemberKey={currentWorkspaceMemberKey}
          locale={locale}
          members={workspaceMembers}
        />
      ) : null}
      {externalLinksAccessToken ? (
        <WorkItemExternalLinksPanelContainer
          accessToken={externalLinksAccessToken}
          canManage={canManageExternalLinks}
          locale={locale}
          teamId={issue.teamId}
          workItemId={issue.id}
        />
      ) : null}
      <div className="border-t border-[var(--workbench-border)] px-6 py-6">
        <WorkItemRelationsEditor
          candidates={relationCandidates.map((candidate) => ({
            id: candidate.id,
            title: resolveIssueTitle(candidate, t),
          }))}
          currentWorkItemId={issue.id}
          isLoading={isRelationsLoading}
          locale={locale}
          onAddRelation={onAddRelation
            ? (input) => onAddRelation(issue.id, input)
            : undefined}
          onDeleteRelation={onDeleteRelation
            ? (relation) => onDeleteRelation(issue.id, relation)
            : undefined}
          readOnly={!onAddRelation && !onDeleteRelation}
          relations={relations}
        />
      </div>
      <RelatedDocuments
        accessToken={accessToken}
        t={t}
        targetId={`team/${issue.teamId}/issue/${issue.id}`}
        targetKind="work-item"
      />
      {collaboration ? (
        <IssueCollaborationPanel
          artifacts={artifacts}
          key={`${issue.teamId}:${issue.id}`}
          controller={collaboration}
          currentMemberKey={currentWorkspaceMemberKey}
          focusedCommentId={focusedCommentId}
          focusedRootCommentId={focusedRootCommentId}
          locale={locale}
          members={workspaceMembers}
        />
      ) : null}
    </aside>
  )
}

function formatLocalDateInputValue(date = new Date()) {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function resolveIssueTitle(issue: TeamIssue, t: (key: MessageKey) => string) {
  void t
  return resolveWorkItemTitle(issue)
}

/**
 * Formats an explicit schedule without collapsing its mode into a deadline projection.
 *
 * @param schedule - Canonical schedule displayed by the read-only Team detail summary.
 * @param t - Translator used for the schedule mode label.
 * @returns A compact localized mode and date-range description.
 */
function describeTeamIssueSchedule(
  schedule: WorkItemSchedule,
  t: (key: MessageKey) => string,
): string {
  const range = formatTaskScheduleRange(schedule)
  return `${t(taskScheduleModeLabelKeys[schedule.mode])}${range ? `: ${range}` : ''}`
}

function resolveAssignedProjectName(
  issue: TeamIssue,
  team: ProjectDirectoryTeam | undefined,
  t: (key: MessageKey) => string,
) {
  if (!issue.assignedProjectId) {
    return t('issues.project.unassigned')
  }

  return team?.projects.find((project) => project.id === issue.assignedProjectId)?.name ?? issue.assignedProjectId
}

function resolveIssuePriority(value: FormDataEntryValue | null): TaskPriority {
  return typeof value === 'string' && issuePriorities.includes(value as TaskPriority)
    ? value as TaskPriority
    : 'medium'
}

function formatProjectMemberOption(member: ProjectMember) {
  return member.name ? `${member.name} (${member.email})` : member.email
}

function IssueStatusBadge({
  configuration,
  issue,
  status,
}: {
  /** Status definition の解決に使う configuration です。 */
  configuration?: WorkItemConfiguration
  /** 一覧で status を表示する Issue です。 */
  issue?: TeamIssue
  /** Board column で直接表示する status definition です。 */
  status?: WorkflowStatusDefinition
}) {
  const resolvedStatus = status ?? (issue
    ? resolveWorkflowStatusDefinition(issue, configuration)
    : undefined)
  const category = resolvedStatus?.category ?? (issue
    ? resolveWorkflowStatusCategory(issue)
    : 'backlog')
  const label = resolvedStatus?.name ?? (issue
    ? resolveWorkItemWorkflowStatusLabel(issue, configuration)
    : '')

  return (
    <span className={resolveWorkflowCategoryToneClassName(category)}>
      {label}
    </span>
  )
}

function IssueCustomFieldSummary({
  configuration,
  issue,
  locale,
  personLabels,
}: {
  /** Custom field definition を含む configuration です。 */
  configuration?: WorkItemConfiguration
  /** 表示対象 Issue です。 */
  issue: TeamIssue
  /** 値の format locale です。 */
  locale: Locale
  /** Person field ID を表示名へ解決する map です。 */
  personLabels: Readonly<Record<string, string>>
}) {
  const values = resolveIssueCustomFieldEntries(issue, configuration, locale, personLabels)

  if (values.length === 0) {
    return null
  }

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {values.slice(0, 2).map(({ definition, value }) => (
        <span
          className="workbench-badge max-w-full truncate"
          key={definition.id}
          title={`${definition.name}: ${value}`}
        >
          {definition.name}: {value}
        </span>
      ))}
      {values.length > 2 ? (
        <span className="workbench-badge">+{values.length - 2}</span>
      ) : null}
    </div>
  )
}

function IssuePriorityBadge({ priority, t }: { priority: TaskPriority; t: (key: MessageKey) => string }) {
  const classes: Record<TaskPriority, string> = {
    high: 'workbench-badge-danger',
    low: 'workbench-badge-success',
    medium: 'workbench-badge-warning',
  }

  return (
    <span className={classes[priority]}>
      {t(`tasks.priority.${priority}`)}
    </span>
  )
}

function resolveIssueCustomFieldEntries(
  issue: TeamIssue,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
) {
  if (!configuration) {
    return []
  }

  const t = createTranslator(locale)

  return sortCustomFieldDefinitions(configuration.customFields).flatMap((definition) => {
    const value = issue.customFieldValues?.[definition.id]

    if (
      value === undefined ||
      !isCustomFieldApplicable(definition, issue.assignedProjectId)
    ) {
      return []
    }

    return [{
      definition,
      value: formatWorkItemCustomFieldValue(issue, definition, {
        durationUnitLabels: {
          days: t('workItems.durationUnit.days'),
          hours: t('workItems.durationUnit.hours'),
          minutes: t('workItems.durationUnit.minutes'),
        },
        falseLabel: t('workItems.fields.booleanFalse'),
        locale,
        personLabels,
        trueLabel: t('workItems.fields.booleanTrue'),
      }),
    }]
  })
}

function resolveIssueCustomFieldSearchValues(
  issue: TeamIssue,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
) {
  return resolveIssueCustomFieldEntries(issue, configuration, locale, personLabels)
    .flatMap(({ definition, value }) => [definition.name, value])
}
