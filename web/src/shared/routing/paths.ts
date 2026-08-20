import type { SidebarNavId, SidebarTeamViewId } from '../ui/sidebar'

/**
 * サイドバーの固定ナビゲーション ID から遷移先 URL を解決する map です。
 */
export const workspaceNavPaths: Record<SidebarNavId, string> = {
  home: '/home',
  focus: '/focus',
  'my-tasks': '/my-tasks',
  inbox: '/inbox',
  requests: '/requests',
  documents: '/documents',
  dashboard: '/dashboard',
  planning: '/planning/timeline',
  reports: '/reports',
  help: '/help',
  settings: '/settings',
}

/**
 * Creates a Focus queue path that can select one Work Item and correlate its source event.
 *
 * @param teamId - Optional owning Team identifier.
 * @param workItemId - Optional canonical Work Item identifier.
 * @param sourceEventId - Optional immutable notification/audit event identifier.
 * @returns The Focus route with permission-safe selection parameters.
 */
export function createFocusPath(
  teamId?: string,
  workItemId?: string,
  sourceEventId?: string,
) {
  const query = new URLSearchParams()
  if (teamId && workItemId) {
    query.set('teamId', teamId)
    query.set('workItemId', workItemId)
  }
  if (sourceEventId) {
    query.set('sourceEventId', sourceEventId)
  }
  const encoded = query.toString()
  return encoded ? `/focus?${encoded}` : '/focus'
}

/**
 * Planning 画面で切り替える表示です。
 */
export type PlanningViewId = 'timeline' | 'roadmap' | 'portfolio'

const planningViewIds: readonly PlanningViewId[] = ['timeline', 'roadmap', 'portfolio']

/**
 * Arrow / Home / End key で移動する Planning view tab を返します。
 *
 * @param currentView - 現在 focus されている Planning view です。
 * @param key - Keyboard event の key です。
 * @returns キーに対応する view。対象外の key では undefined です。
 */
export function resolvePlanningViewTabTarget(currentView: PlanningViewId, key: string) {
  const currentIndex = planningViewIds.indexOf(currentView)
  if (key === 'ArrowRight') {
    return planningViewIds[(currentIndex + 1) % planningViewIds.length]
  }
  if (key === 'ArrowLeft') {
    return planningViewIds[(currentIndex - 1 + planningViewIds.length) % planningViewIds.length]
  }
  if (key === 'Home') return planningViewIds[0]
  if (key === 'End') return planningViewIds.at(-1)
  return undefined
}

/**
 * Planning view と任意の選択 entity に対応する URL を生成します。
 *
 * @param viewId - 表示する Planning view です。
 * @param entityId - 詳細を開く任意の Planning entity ID です。
 * @returns Planning 画面の same-origin path です。
 */
export function createPlanningPath(viewId: PlanningViewId, entityId?: string) {
  const path = `/planning/${viewId}`
  return entityId
    ? `${path}?entityId=${encodeURIComponent(entityId)}`
    : path
}

/**
 * Creates a URL that opens one Team-qualified Project update in the Planning portfolio.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Team-local Project identifier.
 * @returns Same-origin Planning path with an unambiguous Project update target.
 */
export function createPlanningProjectUpdatePath(teamId: string, projectId: string) {
  const parameters = new URLSearchParams({
    targetType: 'project',
    teamId,
    projectId,
  })
  return `/planning/portfolio?${parameters.toString()}`
}

/**
 * Creates the stable DOM anchor used by one Planning dependency ledger row.
 *
 * @param dependencyId - Workspace-local Planning dependency identifier.
 * @returns URL-safe fragment identifier for the Timeline dependency row.
 */
export function createPlanningDependencyAnchorId(dependencyId: string) {
  let encodedDependencyId = ''
  for (let index = 0; index < dependencyId.length; index += 1) {
    encodedDependencyId += dependencyId.charCodeAt(index).toString(16).padStart(4, '0')
  }
  return `planning-dependency-${encodedDependencyId}`
}

/**
 * Creates a Timeline deep link to one Planning dependency ledger row.
 *
 * @param dependencyId - Workspace-local Planning dependency identifier.
 * @returns Same-origin Timeline path with a stable dependency fragment.
 */
export function createPlanningDependencyPath(dependencyId: string) {
  return `/planning/timeline#${createPlanningDependencyAnchorId(dependencyId)}`
}

/**
 * Requests workbench で表示できる tab です。
 */
export type RequestsView = 'queue' | 'forms'

/**
 * Requests workbench の URL を生成します。
 *
 * @param view - 表示する queue または forms tab です。
 * @param selectedId - Queue では submission ID、forms では form ID です。
 * @returns URL state を query に保持した application path です。
 */
export function createRequestsPath(view: RequestsView = 'queue', selectedId?: string) {
  const searchParams = new URLSearchParams()

  if (view !== 'queue') {
    searchParams.set('view', view)
  }

  if (selectedId) {
    searchParams.set(view === 'forms' ? 'formId' : 'submissionId', selectedId)
  }

  const query = searchParams.toString()

  return `/requests${query ? `?${query}` : ''}`
}

/**
 * Opaque link token から公開 request form の URL を生成します。
 *
 * @param linkToken - Request link 発行 API が返す opaque token です。
 * @returns URL encoded token を含む公開 path です。
 */
export function createPublicRequestPath(linkToken: string) {
  return `/request/${encodeURIComponent(linkToken)}`
}

/**
 * Documents home または指定 Document の application URL を生成します。
 *
 * @param documentId - 開く任意の Document ID です。
 * @param projectId - Home の初期 Project scope に使う任意の Project ID です。
 * @returns Documents home または Document detail URL です。
 */
export function createDocumentPath(
  documentId?: string,
  projectId?: string,
) {
  const path = documentId
    ? `/documents/${encodeURIComponent(documentId)}`
    : '/documents'

  if (!projectId) {
    return path
  }

  const searchParams = new URLSearchParams({ projectId })
  return `${path}?${searchParams.toString()}`
}

/**
 * Expiring public share token の read-only URL を生成します。
 *
 * @param shareToken - API が発行した opaque public share token です。
 * @returns Public Document route URL です。
 */
export function createSharedDocumentPath(shareToken: string) {
  return `/share/documents/${encodeURIComponent(shareToken)}`
}

/**
 * Scope 情報を持たない Work Item ID を実在する Workspace search で開く URL
 * を生成します。
 *
 * @param workItemId - 検索対象の canonical Work Item ID です。
 * @returns Work Item に限定した Workspace search URL です。
 */
export function createWorkItemSearchPath(workItemId: string) {
  const canonicalParts = workItemId.split('/')
  if (
    canonicalParts.length === 4 &&
    canonicalParts[0] === 'team' &&
    canonicalParts[1] &&
    canonicalParts[2] === 'issue' &&
    canonicalParts[3]
  ) {
    return createTeamIssuesPath(
      canonicalParts[1],
      canonicalParts[3],
    )
  }
  const searchParams = new URLSearchParams({
    q: workItemId,
    type: 'work-item',
  })
  return `/search?${searchParams.toString()}`
}

/**
 * Project ID を permission-aware Workspace search で開く URL を生成します。
 */
export function createProjectSearchPath(projectId: string) {
  const searchParams = new URLSearchParams({
    q: projectId,
    type: 'project',
  })
  return `/search?${searchParams.toString()}`
}

/**
 * Creates the global or Team-scoped searchable Project directory path.
 *
 * @param teamId - Optional Team whose Project directory should open.
 * @returns A canonical Project directory path.
 */
export function createProjectsPath(teamId?: string) {
  return teamId
    ? `/teams/${encodeURIComponent(teamId)}/projects`
    : '/projects'
}

/**
 * Creates the Workspace-wide Project directory path filtered to Quick Access.
 *
 * @returns A canonical Project directory path with the supported Quick Access query.
 */
export function createQuickAccessProjectsPath() {
  const searchParams = new URLSearchParams({ quickAccess: '1' })
  return `${createProjectsPath()}?${searchParams.toString()}`
}

/**
 * Goal と関連 Documents を開く URL を生成します。
 */
export function createGoalDocumentsPath(goalId: string) {
  return `/goals/${encodeURIComponent(goalId)}/documents`
}

/**
 * プロジェクトの Issue 遂行画面 URL を生成します。
 *
 * @param projectId - Work Item が割り当てられた Project ID です。
 * @param teamId - Work Item を所有する Team ID です。
 * @param issueId - 詳細を初期表示する任意の Work Item ID です。
 * @param commentId - 共同作業パネルで focus する任意の comment ID です。
 * @param rootCommentId - reply page を解決する任意の root comment ID です。
 * @returns Project Issue 一覧または指定詳細への URL です。
 */
export function createProjectIssuesPath(
  projectId: string,
  teamId: string,
  issueId?: string,
  commentId?: string,
  rootCommentId?: string,
) {
  const searchParams = new URLSearchParams({
    teamId,
  })

  if (issueId) {
    searchParams.set('issueId', issueId)
  }

  if (commentId) {
    searchParams.set('commentId', commentId)
  }

  if (rootCommentId) {
    searchParams.set('rootCommentId', rootCommentId)
  }

  return `/projects/${encodeURIComponent(projectId)}/issues?${searchParams.toString()}`
}

/**
 * チーム所有 Issue 画面 URL を生成します。
 *
 * @param teamId - Issue を所有する Team ID です。
 * @param issueId - 詳細を初期表示する任意の Issue ID です。
 * @param commentId - 共同作業パネルで focus する任意の comment ID です。
 * @param rootCommentId - reply page を解決する任意の root comment ID です。
 * @returns Team Issue 一覧または指定 Issue 詳細への URL です。
 */
export function createTeamIssuesPath(
  teamId: string,
  issueId?: string,
  commentId?: string,
  rootCommentId?: string,
) {
  const path = `/teams/${encodeURIComponent(teamId)}/issues`

  if (!issueId && !commentId && !rootCommentId) {
    return path
  }

  const searchParams = new URLSearchParams()

  if (issueId) {
    searchParams.set('issueId', issueId)
  }

  if (commentId) {
    searchParams.set('commentId', commentId)
  }

  if (rootCommentId) {
    searchParams.set('rootCommentId', rootCommentId)
  }

  return `${path}?${searchParams.toString()}`
}

/**
 * Creates a canonical Team triage queue or selected-entry deep link.
 *
 * @param teamId - Team whose intake queue should open.
 * @param entryId - Optional triage entry selected in the detail pane.
 * @returns A same-origin Team triage path.
 */
export function createTeamTriagePath(teamId: string, entryId?: string) {
  const path = `/teams/${encodeURIComponent(teamId)}/triage`
  if (!entryId) return path
  const searchParams = new URLSearchParams({ entryId })
  return `${path}?${searchParams.toString()}`
}

/**
 * チーム配下の固定ビュー URL を生成します。
 */
export function createTeamViewPath(teamId: string, viewId: SidebarTeamViewId) {
  return `/teams/${encodeURIComponent(teamId)}/${viewId}`
}
