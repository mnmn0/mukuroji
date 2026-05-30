import { createBrowserRouter, Navigate } from 'react-router'
import { DashboardPage } from '../pages/DashboardPage'
import { LoginPage } from '../pages/LoginPage'
import { PlaceholderPage } from '../pages/PlaceholderPage'
import { TaskPage } from '../pages/TaskPage'

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
    element: <DashboardPage />,
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
