import { createBrowserRouter } from 'react-router'
import { ForgotPasswordPage } from '../pages/ForgotPasswordPage'
import { LoginPage } from '../pages/LoginPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { PrivacyPage } from '../pages/PrivacyPage'
import { SupportPage } from '../pages/SupportPage'
import { TaskPage } from '../pages/TaskPage'
import { TeamIssuePage } from '../pages/TeamIssuePage'
import { TermsPage } from '../pages/TermsPage'
import { WorkspacePage } from '../pages/WorkspacePage'
import { ProjectTasksRedirect } from './ProjectTasksRedirect'

/**
 * アプリケーション全体の画面ルーティング定義です。
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <LoginPage />,
  },
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
    path: '/reports',
    element: <WorkspacePage view="reports" />,
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
])
