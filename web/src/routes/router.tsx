import { Navigate, createBrowserRouter, type RouteObject } from 'react-router'
import { ForgotPasswordPage } from '../pages/ForgotPasswordPage'
import { LoginPage } from '../pages/LoginPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { PrivacyPage } from '../pages/PrivacyPage'
import { SupportPage } from '../pages/SupportPage'
import { TaskPage } from '../pages/TaskPage'
import { TeamIssuePage } from '../pages/TeamIssuePage'
import { TermsPage } from '../pages/TermsPage'
import { WorkspacePage } from '../pages/WorkspacePage'
import { PlanningPage } from '../pages/PlanningPage'
import { ProjectTasksRedirect } from './ProjectTasksRedirect'
import { WorkspaceCommandMenuLayout } from '../commands/WorkspaceCommandMenu'
import { SearchPage } from '../search/SearchPage'
import { PublicRequestFormPage } from '../requests/PublicRequestFormPage'
import { RequestIntakePage } from '../requests/RequestIntakePage'
import { ReportsPage } from '../pages/ReportsPage'

/**
 * アプリケーション全体の画面ルーティング定義です。
 */
export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <LoginPage />,
  },
  {
    element: <WorkspaceCommandMenuLayout />,
    children: [
      {
        path: '/dashboard',
        element: <WorkspacePage view="dashboard" />,
      },
      {
        path: '/home',
        element: <WorkspacePage view="home" />,
      },
      {
        path: '/my-tasks',
        element: <WorkspacePage view="my-tasks" />,
      },
      {
        path: '/inbox',
        element: <WorkspacePage view="inbox" />,
      },
      {
        path: '/requests',
        element: <RequestIntakePage />,
      },
      {
        path: '/search',
        element: <SearchPage />,
      },
      {
        path: '/planning',
        element: <Navigate replace to="/planning/timeline" />,
      },
      {
        path: '/planning/timeline',
        element: <PlanningPage />,
      },
      {
        path: '/planning/roadmap',
        element: <PlanningPage />,
      },
      {
        path: '/planning/portfolio',
        element: <PlanningPage />,
      },
      {
        path: '/reports',
        element: <ReportsPage />,
      },
      {
        path: '/help',
        element: <WorkspacePage view="help" />,
      },
      {
        path: '/settings',
        element: <WorkspacePage view="settings" />,
      },
      {
        path: '/teams/:teamId/overview',
        element: <WorkspacePage view="team-overview" />,
      },
      {
        path: '/teams/:teamId/issues',
        element: <TeamIssuePage />,
      },
      {
        path: '/teams/:teamId/members',
        element: <WorkspacePage view="team-members" />,
      },
      {
        path: '/projects/:projectId/issues',
        element: <TaskPage />,
      },
      {
        path: '/projects/:projectId/tasks',
        element: <ProjectTasksRedirect />,
      },
    ],
  },
  {
    path: '/request/:linkToken',
    element: <PublicRequestFormPage />,
  },
  {
    path: '/forgot-password',
    element: <ForgotPasswordPage />,
  },
  {
    path: '/privacy',
    element: <PrivacyPage />,
  },
  {
    path: '/terms',
    element: <TermsPage />,
  },
  {
    path: '/support',
    element: <SupportPage />,
  },
  {
    path: '*',
    element: <NotFoundPage />,
  },
]

/**
 * Browser history を利用する application router を作成します。
 *
 * @returns App で利用する browser router です。
 */
export function createAppRouter() {
  return createBrowserRouter(appRoutes)
}
