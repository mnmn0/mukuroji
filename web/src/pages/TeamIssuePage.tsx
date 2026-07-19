import type {
  ResolvedWorkItemConfiguration,
  WorkflowStatusDefinition,
  WorkItemConfiguration,
  WorkItemRelation,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import useSWR from 'swr'
import {
  canManageWorkspaceStructure,
  canMutateWorkspaceContent,
  getCurrentUser,
} from '../auth/api'
import { clearAuthSession, getAuthSession } from '../auth/session'
import { createMutationRequestRunner } from '../api/mutationHeaders'
import { IssueArtifactsPanel } from '../files/IssueArtifactsPanel'
import {
  type FileArtifactScope,
  type FileArtifactsController,
  useFileArtifacts,
} from '../files/useFileArtifacts'
import {
  MobileSidebarButton,
  MobileSidebarDrawer,
  Sidebar,
  type SidebarNavId,
  type SidebarTeamViewId,
} from '../components/sidebar'
import {
  createSidebarLabels,
  createTranslator,
  getInitialLocale,
  type Locale,
  type MessageKey,
} from '../i18n'
import { useUnreadNotificationCount } from '../notifications/useNotifications'
import {
  createTeamIssue,
  getTeamIssueDetail,
  getTeamIssues,
  TeamIssuesApiError,
  type CreateTeamIssueInput,
  type TeamIssue,
  type UpdateTeamIssueInput,
  updateTeamIssue,
} from '../issues/api'
import { IssueCollaborationPanel } from '../issues/IssueCollaborationPanel'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../issues/workItemDisplay'
import {
  type IssueCollaborationController,
  useIssueCollaboration,
} from '../issues/useIssueCollaboration'
import {
  archiveProjectDirectoryProject,
  archiveProjectDirectoryTeam,
  createProjectDirectoryProject,
  createProjectDirectoryTeam,
  getProjectDirectory,
  getProjectMembers,
  isActiveProjectAssignmentCandidate,
  type CreateProjectDirectoryProjectInput,
  type CreateProjectDirectoryTeamInput,
  type ProjectDirectoryTeam,
  type ProjectMember,
} from '../projects/api'
import {
  createProjectIssuesPath,
  createTeamIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../routes/paths'
import type { TaskPriority } from '../tasks/api'
import { getWorkspaceAccess, type WorkspaceMember } from '../workspace/api'
import { useWorkspaceCommandMenu } from '../commands/WorkspaceCommandMenuContext'
import {
  createWorkItemRelation,
  deleteWorkItemRelation,
  getWorkItemConfiguration,
} from '../work-items/api'
import { WorkItemExternalLinksPanelContainer } from '../work-items/WorkItemExternalLinksPanel'
import {
  createDefaultCustomFieldValues,
  isCustomFieldApplicable,
  parseCustomFieldFormData,
  sortCustomFieldDefinitions,
} from '../work-items/customFields'
import { WorkItemFieldsEditor } from '../work-items/WorkItemFieldsEditor'
import {
  WorkItemDefinitionFilters,
} from '../work-items/WorkItemDefinitionFilters'
import {
  matchesWorkItemDefinitionFilter,
  type WorkItemDefinitionFilter,
} from '../work-items/workItemFilters'
import {
  WorkItemRelationsEditor,
  type WorkItemRelationEditorInput,
} from '../work-items/WorkItemRelationsEditor'
import {
  createCustomFieldErrorMessages,
  createCustomFieldValuePatch,
  formatWorkItemCustomFieldValue,
  readSelectedRelationGraphRevision,
  refreshRelationDetailAfterConflict,
  resolveCreateWorkflowStatuses,
  resolveDisplayWorkflowStatuses,
  resolveEditableWorkflowStatuses,
  resolveWorkItemPersonOptions,
  resolveWorkItemWorkflowStatusId,
  resolveWorkItemWorkflowStatusLabel,
  resolveWorkflowCategoryToneClassName,
  resolveWorkflowStatusCategory,
  resolveWorkflowStatusDefinition,
} from '../work-items/workItemDisplay'
import { RelatedDocuments } from '../documents/RelatedDocuments'

const issuePriorities = ['high', 'medium', 'low'] as const satisfies readonly TaskPriority[]
const emptyTeams: ProjectDirectoryTeam[] = []
const emptyIssues: TeamIssue[] = []
const emptyMembers: ProjectMember[] = []
const emptyWorkspaceMembers: WorkspaceMember[] = []
const apiSWRConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

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
   * サイドバーに表示する通知の実未読件数です。
   */
  inboxCount?: number
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
  /**
   * サイドバーからプロジェクトを選択したときの callback です。
   */
  onSelectProject?: (projectId: string, teamId: string) => void
  /**
   * サイドバーの固定ナビを選択したときの callback です。
   */
  onSelectNav?: (navId: SidebarNavId) => void
  /**
   * サイドバーのチーム固定ビューを選択したときの callback です。
   */
  onSelectTeamView?: (teamId: string, viewId: SidebarTeamViewId) => void
  /**
   * チーム新規登録時の callback です。
   */
  onCreateTeam?: (input: CreateProjectDirectoryTeamInput) => Promise<void>
  /**
   * プロジェクト新規登録時の callback です。
   */
  onCreateProject?: (teamId: string, input: CreateProjectDirectoryProjectInput) => Promise<void>
  /**
   * チームアーカイブ時の callback です。
   */
  onArchiveTeam?: (teamId: string) => Promise<void>
  /**
   * プロジェクトアーカイブ時の callback です。
   */
  onArchiveProject?: (teamId: string, projectId: string) => Promise<void>
}

/**
 * Cognito 認証後に表示するチーム所有 Issue ページです。
 */
export function TeamIssuePage() {
  const navigate = useNavigate()
  const params = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const teamId = params.teamId ?? 'core-team'
  const [session] = useState(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const requestedIssueId = searchParams.get('issueId')?.trim() || undefined
  const focusedCommentId = searchParams.get('commentId')?.trim() || undefined
  const focusedRootCommentId = searchParams.get('rootCommentId')?.trim() || undefined
  const isCreateIssueRequested = searchParams.get('create') === '1'
  const t = useMemo(() => createTranslator(locale), [locale])
  const accessToken = session?.accessToken
  const currentUserKey = accessToken ? (['current-user', accessToken] as const) : null
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useSWR(currentUserKey, ([, token]) => getCurrentUser(token), apiSWRConfig)
  const inboxCount = useUnreadNotificationCount(
    accessToken,
    Boolean(user && !currentUserError),
  )
  const workspaceAccessKey = accessToken && user && !currentUserError
    ? (['workspace-access', accessToken] as const)
    : null
  const { data: workspaceAccess } = useSWR(
    workspaceAccessKey,
    ([, token]) => getWorkspaceAccess(token),
    apiSWRConfig,
  )
  const projectDirectoryKey = accessToken && user && !currentUserError
    ? (['project-directory', accessToken, locale] as const)
    : null
  const {
    data: teams = emptyTeams,
    isLoading: isProjectDirectoryLoading,
    mutate: mutateProjectDirectory,
  } = useSWR(
    projectDirectoryKey,
    ([, token, currentLocale]) => getProjectDirectory(token, currentLocale),
    apiSWRConfig,
  )
  const activeTeam = teams.find((team) => team.id === teamId)
  const issueKey = accessToken && user && !currentUserError
    ? (['team-issues', accessToken, teamId] as const)
    : null
  const {
    data: issues = emptyIssues,
    error: issueError,
    isLoading: isIssuesLoading,
    mutate: mutateIssues,
  } = useSWR(issueKey, ([, token, currentTeamId]) => getTeamIssues(currentTeamId, token), apiSWRConfig)
  const workItemConfigurationKey = accessToken && user && !currentUserError
    ? (['work-item-configuration', accessToken, teamId] as const)
    : null
  const {
    data: resolvedConfiguration,
    error: workItemConfigurationError,
    isLoading: isWorkItemConfigurationLoading,
  } = useSWR(
    workItemConfigurationKey,
    ([, token, currentTeamId]) => getWorkItemConfiguration(token, {
      kind: 'team',
      teamId: currentTeamId,
    }),
    apiSWRConfig,
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
  const detailKey = accessToken && resolvedSelectedIssueId
    ? (['team-issue-detail', accessToken, teamId, resolvedSelectedIssueId] as const)
    : null
  const {
    data: issueDetail,
    error: detailError,
    isLoading: isIssueDetailLoading,
    mutate: mutateIssueDetail,
  } = useSWR(
    detailKey,
    ([, token, currentTeamId, issueId]) => getTeamIssueDetail(currentTeamId, issueId, token),
    apiSWRConfig,
  )
  const screenIssues = issueDetail?.issue
    ? issues.map((issue) => issue.id === issueDetail.issue.id ? issueDetail.issue : issue)
    : issues
  const memberKey = accessToken && activeTeam
    ? (['team-issue-members', accessToken, activeTeam.projects.map((project) => project.id).join('\u0000')] as const)
    : null
  const { data: assigneeOptions = emptyMembers } = useSWR(
    memberKey,
    ([, token]) => loadTeamProjectMembers(token, activeTeam?.projects.map((project) => project.id) ?? []),
    apiSWRConfig,
  )
  const userInitial =
    (user?.attributes.name ?? user?.attributes.email ?? user?.username ?? 'J')
      .trim()
      .charAt(0)
      .toUpperCase() || 'J'
  const canManageStructure = canManageWorkspaceStructure(user)
  const canMutateContent = canMutateWorkspaceContent(user)
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(currentUserError) ||
    Boolean(user && isProjectDirectoryLoading) ||
    Boolean(user && isIssuesLoading) ||
    Boolean(user && isWorkItemConfigurationLoading)
  const issueErrorMessage = issueError
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
    if (currentUserError) {
      clearAuthSession()
      navigate('/', { replace: true })
    }
  }, [currentUserError, navigate])

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

    const issue = await mutationRequestRunner.run(
      `issue:create:${teamId}`,
      JSON.stringify(input),
      (context) => createTeamIssue(teamId, accessToken, input, context),
    )
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
      await mutationRequestRunner.run(
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
      )
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
      await mutationRequestRunner.run(
        `issue:relation:create:${teamId}:${issueId}`,
        JSON.stringify([graphRevision, input]),
        (context) => createWorkItemRelation(
          teamId,
          issueId,
          accessToken,
          { ...input, expectedGraphRevision: graphRevision },
          context,
        ),
      )
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
      await mutationRequestRunner.run(
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
      )
      await mutateIssueDetail()
    } catch (error) {
      await refreshRelationDetailAfterConflict(error, mutateIssueDetail)
      throw error
    }
  }

  const handleCreateTeam = async (input: CreateProjectDirectoryTeamInput) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run('team:create', JSON.stringify(input), (context) =>
      createProjectDirectoryTeam(accessToken, input, context),
    )
    await mutateProjectDirectory()
  }

  const handleCreateProject = async (
    nextTeamId: string,
    input: CreateProjectDirectoryProjectInput,
  ) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run(
      'project:create',
      JSON.stringify([nextTeamId, input]),
      (context) => createProjectDirectoryProject(accessToken, nextTeamId, input, context),
    )
    await mutateProjectDirectory()
  }

  const handleArchiveTeam = async (nextTeamId: string) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run('team:archive', nextTeamId, (context) =>
      archiveProjectDirectoryTeam(accessToken, nextTeamId, context),
    )
    await mutateProjectDirectory()

    if (nextTeamId === teamId) {
      navigate(workspaceNavPaths.home)
    }
  }

  const handleArchiveProject = async (nextTeamId: string, projectId: string) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run(
      'project:archive',
      JSON.stringify([nextTeamId, projectId]),
      (context) => archiveProjectDirectoryProject(accessToken, nextTeamId, projectId, context),
    )
    await mutateProjectDirectory()
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
      inboxCount={inboxCount}
      issueErrorMessage={issueErrorMessage}
      issues={screenIssues}
      isLoading={isLoading}
      isRelationsLoading={Boolean(detailKey && isIssueDetailLoading)}
      key={teamId}
      locale={locale}
      onAddRelation={canMutateContent ? handleAddRelation : undefined}
      onArchiveProject={canManageStructure ? handleArchiveProject : undefined}
      onArchiveTeam={canManageStructure ? handleArchiveTeam : undefined}
      onCreateIssue={canMutateContent && !workItemConfigurationError ? handleCreateIssue : undefined}
      onCreateProject={canManageStructure ? handleCreateProject : undefined}
      onCreateTeam={canManageStructure ? handleCreateTeam : undefined}
      onDeleteRelation={canMutateContent ? handleDeleteRelation : undefined}
      onSelectIssue={(issueId) => navigate(createTeamIssuesPath(teamId, issueId))}
      onSelectNav={(navId) => navigate(workspaceNavPaths[navId])}
      onSelectProject={(projectId, nextTeamId) => navigate(createProjectIssuesPath(projectId, nextTeamId))}
      onSelectTeamView={(nextTeamId, viewId) => navigate(createTeamViewPath(nextTeamId, viewId))}
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
  inboxCount = 0,
  initialViewMode = 'table',
  issueErrorMessage,
  issues = [],
  isLoading = false,
  isRelationsLoading = false,
  locale,
  onAddRelation,
  onArchiveProject,
  onArchiveTeam,
  onCreateIssue,
  onCreateProject,
  onCreateTeam,
  onDeleteRelation,
  onSelectIssue,
  onSelectNav,
  onSelectProject,
  onSelectTeamView,
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
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [viewMode, setViewMode] = useState<IssueViewMode>(initialViewMode)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [definitionFilter, setDefinitionFilter] = useState<WorkItemDefinitionFilter>({
    category: 'all',
    customFieldId: '',
  })
  const [isCreateOpen, setIsCreateOpen] = useState(defaultCreateIssueOpen)
  const [createErrorMessage, setCreateErrorMessage] = useState<string | undefined>()
  const [detailUpdateError, setDetailUpdateError] = useState<readonly [string, string] | undefined>()
  const commandMenu = useWorkspaceCommandMenu()
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
    <main className="workbench-shell flex h-svh min-h-0 overflow-hidden">
      <Sidebar
        activeTeamId={teamId}
        activeTeamViewId="issues"
        className="max-[980px]:hidden"
        inboxCount={inboxCount}
        labels={sidebarLabels}
        onArchiveProject={onArchiveProject}
        onArchiveTeam={onArchiveTeam}
        onCreateProject={onCreateProject}
        onCreateTeam={onCreateTeam}
        onOpenSearch={commandMenu.open}
        onSelectNav={onSelectNav}
        onSelectProject={onSelectProject}
        onSelectTeamView={onSelectTeamView}
        teams={teams}
      />
      <MobileSidebarDrawer
        closeLabel={t('sidebar.mobileClose')}
        dialogLabel={t('sidebar.mobileDialog')}
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
      >
        <Sidebar
          activeTeamId={teamId}
          activeTeamViewId="issues"
          inboxCount={inboxCount}
          labels={sidebarLabels}
          onArchiveProject={onArchiveProject}
          onArchiveTeam={onArchiveTeam}
          onCreateProject={onCreateProject}
          onCreateTeam={onCreateTeam}
          onOpenSearch={commandMenu.open
            ? () => {
                setIsMobileSidebarOpen(false)
                commandMenu.open?.()
              }
            : undefined}
          onSelectNav={(navId) => {
            setIsMobileSidebarOpen(false)
            onSelectNav?.(navId)
          }}
          onSelectProject={(projectId, nextTeamId) => {
            setIsMobileSidebarOpen(false)
            onSelectProject?.(projectId, nextTeamId)
          }}
          onSelectTeamView={(nextTeamId, viewId) => {
            setIsMobileSidebarOpen(false)
            onSelectTeamView?.(nextTeamId, viewId)
          }}
          teams={teams}
        />
      </MobileSidebarDrawer>

      <section className="workbench-main flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="workbench-header flex-none px-[clamp(20px,3vw,34px)] py-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <MobileSidebarButton
                label={t('sidebar.mobileOpen')}
                onClick={() => setIsMobileSidebarOpen(true)}
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
                  onClick={() => setIsCreateOpen(!isCreateOpen)}
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
          <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
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
                    assigneeOptions={assigneeOptions}
                    configuration={configuration}
                    errorMessage={createErrorMessage}
                    locale={locale}
                    onCancel={() => {
                      setCreateErrorMessage(undefined)
                      setIsCreateOpen(false)
                    }}
                    onSubmit={async (input) => {
                      if (!onCreateIssue) {
                        return
                      }

                      setCreateErrorMessage(undefined)

                      try {
                        await onCreateIssue(input)
                        setIsCreateOpen(false)
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
                      onSelectIssue={(issueId) => {
                        setDetailUpdateError(undefined)
                        onSelectIssue?.(issueId)
                      }}
                      selectedIssueId={selectedIssueId}
                      t={t}
                      workflowStatuses={workflowStatuses}
                      workspaceMembers={workspaceMembers}
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
      </section>
    </main>
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
  workspaceMembers: WorkspaceMember[]
}) {
  const today = formatLocalDateInputValue()
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const workflowStatuses = resolveCreateWorkflowStatuses(configuration)
  const initialWorkflowStatusId = configuration?.workflow.initialStatusId ?? ''
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
          const dueDate = String(formData.get('dueDate') ?? today).replaceAll('-', '/')
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
            dueDate,
            priority: resolveIssuePriority(formData.get('priority')),
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
            <input className="workbench-input h-10 w-full min-w-0 px-3" defaultValue={today} name="dueDate" required type="date" />
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
  onSelectIssue,
  selectedIssueId,
  t,
  workflowStatuses,
  workspaceMembers,
}: {
  activeTeam?: ProjectDirectoryTeam
  configuration?: WorkItemConfiguration
  issues: TeamIssue[]
  locale: Locale
  onSelectIssue?: (issueId: string) => void
  selectedIssueId?: string
  t: (key: MessageKey) => string
  workflowStatuses: readonly WorkflowStatusDefinition[]
  workspaceMembers: WorkspaceMember[]
}) {
  const personLabels = Object.fromEntries(
    workspaceMembers.map((member) => [member.email, member.name ?? member.email]),
  )

  return (
    <section className="mt-5 flex min-w-0 gap-4 overflow-x-auto pb-2">
      {workflowStatuses.map((status) => {
        const columnIssues = issues.filter(
          (issue) => resolveWorkItemWorkflowStatusId(issue) === status.id,
        )

        return (
          <div className="workbench-panel min-h-[420px] w-[min(320px,82vw)] flex-none" key={status.id}>
            <div className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] px-4 py-3">
              <IssueStatusBadge status={status} />
              <span className="text-sm font-semibold text-[var(--workbench-muted)]">{columnIssues.length}</span>
            </div>
            <div className="grid gap-3 p-3">
              {columnIssues.length > 0 ? (
                columnIssues.map((issue) => (
                  <button
                    className={`rounded-lg border p-4 text-left transition ${
                      selectedIssueId === issue.id
                        ? 'border-[#99d7cf] bg-[#e5f7f4]'
                        : 'border-[var(--workbench-border)] bg-white hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]'
                    }`}
                    key={issue.id}
                    onClick={() => onSelectIssue?.(issue.id)}
                    type="button"
                  >
                    <p className="text-sm font-semibold leading-6 text-[var(--workbench-text)]">{resolveIssueTitle(issue, t)}</p>
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
                  </button>
                ))
              ) : (
                <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
                  {t('tasks.board.empty')}
                </p>
              )}
            </div>
          </div>
        )
      })}
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
            dueDate: String(formData.get('dueDate') ?? '').replaceAll('-', '/'),
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
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.column.dueDate')}
              <input className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]" defaultValue={issue.dueDate.replaceAll('/', '-')} name="dueDate" type="date" />
            </label>
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

async function loadTeamProjectMembers(accessToken: string, projectIds: string[]) {
  const responses = await Promise.allSettled(projectIds.map((projectId) => getProjectMembers(accessToken, projectId)))
  const membersById = new Map<string, ProjectMember>()

  for (const response of responses) {
    if (response.status !== 'fulfilled') {
      continue
    }

    for (const member of response.value) {
      membersById.set(member.id, member)
    }
  }

  return Array.from(membersById.values()).filter(isActiveProjectAssignmentCandidate)
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
