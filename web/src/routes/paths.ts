import type { SidebarNavId, SidebarTeamViewId } from '../components/sidebar'

/**
 * サイドバーの固定ナビゲーション ID から遷移先 URL を解決する map です。
 */
export const workspaceNavPaths: Record<SidebarNavId, string> = {
  home: '/home',
  'my-tasks': '/my-tasks',
  inbox: '/inbox',
  dashboard: '/dashboard',
  reports: '/reports',
  help: '/help',
  settings: '/settings',
}

/**
 * プロジェクトのタスク画面 URL を生成します。
 */
export function createProjectTasksPath(projectId: string, teamId: string) {
  return `/projects/${encodeURIComponent(projectId)}/tasks?teamId=${encodeURIComponent(teamId)}`
}

/**
 * プロジェクトの Issue 遂行画面 URL を生成します。
 */
export function createProjectIssuesPath(projectId: string, teamId: string, issueId?: string) {
  const searchParams = new URLSearchParams({
    teamId,
  })

  if (issueId) {
    searchParams.set('issueId', issueId)
  }

  return `/projects/${encodeURIComponent(projectId)}/issues?${searchParams.toString()}`
}

/**
 * チーム所有 Issue 画面 URL を生成します。
 *
 * @param teamId - Issue を所有する Team ID です。
 * @param issueId - 詳細を初期表示する任意の Issue ID です。
 * @returns Team Issue 一覧または指定 Issue 詳細への URL です。
 */
export function createTeamIssuesPath(teamId: string, issueId?: string) {
  const path = `/teams/${encodeURIComponent(teamId)}/issues`

  if (!issueId) {
    return path
  }

  return `${path}?${new URLSearchParams({ issueId }).toString()}`
}

/**
 * チーム配下の固定ビュー URL を生成します。
 */
export function createTeamViewPath(teamId: string, viewId: SidebarTeamViewId) {
  return `/teams/${encodeURIComponent(teamId)}/${viewId}`
}
