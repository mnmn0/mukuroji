import { createBrowserRouter, Navigate } from 'react-router'
import { LoginPage } from '../pages/LoginPage'
import { PlaceholderPage } from '../pages/PlaceholderPage'
import { TaskPage } from '../pages/TaskPage'
import { WorkspacePage } from '../pages/WorkspacePage'

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
    path: '/invite',
    element: <WorkspacePage view="invite" />,
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
    path: '/teams/:teamId/members',
    element: <WorkspacePage view="team-members" />,
  },
  {
    path: '/projects/:projectId/tasks',
    element: <TaskPage />,
  },
  {
    path: '/forgot-password',
    element: (
      <PlaceholderPage
        titleKey="placeholder.forgotPassword.title"
        descriptionKey="placeholder.forgotPassword.description"
      />
    ),
  },
  {
    path: '/privacy',
    element: (
      <PlaceholderPage
        titleKey="placeholder.privacy.title"
        descriptionKey="placeholder.privacy.description"
      />
    ),
  },
  {
    path: '/terms',
    element: (
      <PlaceholderPage
        titleKey="placeholder.terms.title"
        descriptionKey="placeholder.terms.description"
      />
    ),
  },
  {
    path: '/support',
    element: (
      <PlaceholderPage
        titleKey="placeholder.support.title"
        descriptionKey="placeholder.support.description"
      />
    ),
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
])
