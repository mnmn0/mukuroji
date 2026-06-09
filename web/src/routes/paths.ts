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
 * チーム配下の固定ビュー URL を生成します。
 */
export function createTeamViewPath(teamId: string, viewId: SidebarTeamViewId) {
  return `/teams/${encodeURIComponent(teamId)}/${viewId}`
}
