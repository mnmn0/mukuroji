import { Navigate, createBrowserRouter, type RouteObject } from 'react-router'
import { ForgotPasswordPage } from '../pages/auth/ForgotPasswordPage'
import { LoginPage } from '../pages/auth/LoginPage'
import { NotFoundPage } from '../pages/public/NotFoundPage'
import { PrivacyPage } from '../pages/public/PrivacyPage'
import { SupportPage } from '../pages/public/SupportPage'
import { TermsPage } from '../pages/public/TermsPage'
import { GoalDocumentsPage } from '../pages/workspace/GoalDocumentsPage'
import { PlanningPage } from '../pages/workspace/PlanningPage'
import { ReportsPage } from '../pages/workspace/ReportsPage'
import { TaskPage } from '../pages/workspace/TaskPage'
import { TeamIssuePage } from '../pages/workspace/TeamIssuePage'
import { WorkspacePage } from '../pages/workspace/WorkspacePage'
import { ProjectTasksRedirect } from './ProjectTasksRedirect'
import { WorkspaceCommandMenuLayout } from '../commands/ui/WorkspaceCommandMenu'
import { SearchPage } from '../search/SearchPage'
import { PublicRequestFormPage } from '../requests/PublicRequestFormPage'
import { RequestIntakePage } from '../requests/RequestIntakePage'
import { EnterpriseSsoCallbackPage } from '../pages/auth/EnterpriseSsoCallbackPage'
import { DocumentPage } from '../documents/DocumentPage'
import { SharedDocumentPage } from '../documents/SharedDocumentPage'
import { SecurityRecoveryPage } from '../pages/auth/SecurityRecoveryPage'

/**
 * アプリケーション全体の画面ルーティング定義です。
 */
export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <LoginPage />,
  },
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/auth/sso/callback',
    element: <EnterpriseSsoCallbackPage />,
  },
  {
    path: '/security/recovery',
    element: <SecurityRecoveryPage />,
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
        path: '/documents',
        element: <DocumentPage />,
      },
      {
        path: '/documents/:documentId',
        element: <DocumentPage />,
      },
      {
        path: '/goals/:goalId/documents',
        element: <GoalDocumentsPage />,
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
        path: '/settings/security',
        element: <WorkspacePage view="enterprise-security" />,
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
    path: '/share/documents/:shareToken',
    element: <SharedDocumentPage />,
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
