import type { SidebarNavId, SidebarTeamViewId } from '../components/sidebar'

/**
 * サイドバーの固定ナビゲーション ID から遷移先 URL を解決する map です。
 */
export const workspaceNavPaths: Record<SidebarNavId, string> = {
  home: '/home',
  'my-tasks': '/my-tasks',
  inbox: '/inbox',
  dashboard: '/dashboard',
  planning: '/planning/timeline',
  reports: '/reports',
  help: '/help',
  settings: '/settings',
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
 * プロジェクトのタスク画面 URL を生成します。
 */
export function createProjectTasksPath(projectId: string, teamId: string) {
  return `/projects/${encodeURIComponent(projectId)}/tasks?teamId=${encodeURIComponent(teamId)}`
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
 * チーム配下の固定ビュー URL を生成します。
 */
export function createTeamViewPath(teamId: string, viewId: SidebarTeamViewId) {
  return `/teams/${encodeURIComponent(teamId)}/${viewId}`
}
