import { Navigate, createBrowserRouter, type RouteObject } from 'react-router'
import { ForgotPasswordPage } from '../pages/auth/ForgotPasswordPage'
import { LoginPage } from '../pages/auth/LoginPage'
import { NotFoundPage } from '../pages/public/NotFoundPage'
import { PrivacyPage } from '../pages/public/PrivacyPage'
import { SupportPage } from '../pages/public/SupportPage'
import { TermsPage } from '../pages/public/TermsPage'
import { DashboardPage } from '../pages/workspace/DashboardPage'
import { EnterpriseSecurityPage } from '../pages/workspace/EnterpriseSecurityPage'
import { GoalDocumentsPage } from '../pages/workspace/GoalDocumentsPage'
import { HelpPage } from '../pages/workspace/HelpPage'
import { HomePage } from '../pages/workspace/HomePage'
import { FocusPage } from '../pages/workspace/FocusPage'
import { InboxPage } from '../pages/workspace/InboxPage'
import { MyTasksPage } from '../pages/workspace/MyTasksPage'
import { PlanningPage } from '../pages/workspace/PlanningPage'
import { ProjectsPage } from '../pages/workspace/ProjectsPage'
import { ReportsPage } from '../pages/workspace/ReportsPage'
import { SettingsPage } from '../pages/workspace/SettingsPage'
import { TaskPage } from '../pages/workspace/TaskPage'
import { TeamIssuePage } from '../pages/workspace/TeamIssuePage'
import { TeamMembersPage } from '../pages/workspace/TeamMembersPage'
import { TeamOverviewPage } from '../pages/workspace/TeamOverviewPage'
import { ProjectTasksRedirect } from './ProjectTasksRedirect'
import { WorkspaceCommandMenuLayout } from '../commands/ui/WorkspaceCommandMenu'
import { SearchPage } from '../search/SearchPage'
import { PublicRequestFormPage } from '../requests/PublicRequestFormPage'
import { RequestIntakePage } from '../requests/RequestIntakePage'
import { EnterpriseSsoCallbackPage } from '../pages/auth/EnterpriseSsoCallbackPage'
import { DocumentPage } from '../documents/DocumentPage'
import { SharedDocumentPage } from '../documents/SharedDocumentPage'
import { SecurityRecoveryPage } from '../pages/auth/SecurityRecoveryPage'
import { WorkspaceRoute } from '../workspace/ui/WorkspaceRoute'
import { WorkspaceRouteProvider } from '../workspace/ui/WorkspaceRouteProvider'

/**
 * Route definitions for the complete application.
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
        element: <WorkspaceRouteProvider />,
        children: [
          {
            element: <WorkspaceRoute />,
            children: [
              {
                path: '/dashboard',
                element: <DashboardPage />,
              },
              {
                path: '/home',
                element: <HomePage />,
              },
              {
                path: '/focus',
                element: <FocusPage />,
              },
              {
                path: '/my-tasks',
                element: <MyTasksPage />,
              },
              {
                path: '/inbox',
                element: <InboxPage />,
              },
              {
                path: '/help',
                element: <HelpPage />,
              },
              {
                path: '/settings',
                element: <SettingsPage />,
              },
              {
                path: '/settings/security',
                element: <EnterpriseSecurityPage />,
              },
              {
                path: '/teams/:teamId/overview',
                element: <TeamOverviewPage />,
              },
              {
                path: '/teams/:teamId/members',
                element: <TeamMembersPage />,
              },
              {
                path: '/teams/:teamId/projects',
                element: <ProjectsPage />,
              },
              {
                path: '/projects',
                element: <ProjectsPage />,
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
                path: '/teams/:teamId/issues',
                element: <TeamIssuePage />,
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
        ],
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
