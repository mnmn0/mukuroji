import type { ComponentType } from 'react'
import { Navigate, createBrowserRouter, type LazyRouteFunction, type RouteObject } from 'react-router'
import { LoginPage } from '../pages/auth/LoginPage'
import { NotFoundPage } from '../pages/public/NotFoundPage'
import { RouteErrorPage } from '../pages/public/RouteErrorPage'
import { loadPageWithReload } from './staleChunkReload'
import { WorkspaceCommandMenuLayout } from '../commands/ui/WorkspaceCommandMenu'
import { WorkspaceRoute } from '../workspace/ui/WorkspaceRoute'
import { WorkspaceRouteProvider } from '../workspace/ui/WorkspaceRouteProvider'

/**
 * Loads a page when its route first matches, so each page ships in its own chunk instead of the
 * initial bundle. A failed load reloads the application once, see {@link loadPageWithReload}.
 *
 * @param load - Imports the page module and returns its component.
 * @returns Route `lazy` function that resolves to the page component.
 */
function lazyPage(load: () => Promise<ComponentType>): LazyRouteFunction<RouteObject> {
  return async () => ({ Component: await loadPageWithReload(load) })
}

/**
 * Route definitions for the complete application.
 *
 * The pathless root shows an empty busy page while the first page chunk loads; later navigations
 * keep the current page until the next one is ready. A page that fails to load or render shows
 * {@link RouteErrorPage}.
 */
export const appRoutes: RouteObject[] = [
  {
    hydrateFallbackElement: <div aria-busy="true" className="min-h-svh" />,
    errorElement: <RouteErrorPage />,
    children: [
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
        lazy: lazyPage(async () => (await import('../pages/auth/EnterpriseSsoCallbackPage')).EnterpriseSsoCallbackPage),
      },
      {
        path: '/security/recovery',
        lazy: lazyPage(async () => (await import('../pages/auth/SecurityRecoveryPage')).SecurityRecoveryPage),
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
                    lazy: lazyPage(async () => (await import('../pages/workspace/DashboardPage')).DashboardPage),
                  },
                  {
                    path: '/home',
                    lazy: lazyPage(async () => (await import('../pages/workspace/HomePage')).HomePage),
                  },
                  {
                    path: '/focus',
                    lazy: lazyPage(async () => (await import('../pages/workspace/FocusPage')).FocusPage),
                  },
                  { path: '/updates', lazy: lazyPage(async () => (await import('../pages/workspace/UpdateFeedPage')).UpdateFeedPage) },
                  {
                    path: '/my-tasks',
                    lazy: lazyPage(async () => (await import('../pages/workspace/MyTasksPage')).MyTasksPage),
                  },
                  {
                    path: '/inbox',
                    lazy: lazyPage(async () => (await import('../pages/workspace/InboxPage')).InboxPage),
                  },
                  {
                    path: '/help',
                    lazy: lazyPage(async () => (await import('../pages/workspace/HelpPage')).HelpPage),
                  },
                  {
                    path: '/share',
                    lazy: lazyPage(async () => (await import('../pages/workspace/SharePage')).SharePage),
                  },
                  {
                    path: '/settings',
                    lazy: lazyPage(async () => (await import('../pages/workspace/SettingsPage')).SettingsPage),
                  },
                  {
                    path: '/settings/security',
                    lazy: lazyPage(async () => (await import('../pages/workspace/EnterpriseSecurityPage')).EnterpriseSecurityPage),
                  },
                  {
                    path: '/teams/:teamId/overview',
                    lazy: lazyPage(async () => (await import('../pages/workspace/TeamOverviewPage')).TeamOverviewPage),
                  },
                  {
                    path: '/teams/:teamId/members',
                    lazy: lazyPage(async () => (await import('../pages/workspace/TeamMembersPage')).TeamMembersPage),
                  },
                  {
                    path: '/teams/:teamId/triage',
                    lazy: lazyPage(async () => (await import('../pages/workspace/TeamTriagePage')).TeamTriagePage),
                  },
                  {
                    path: '/teams/:teamId/projects',
                    lazy: lazyPage(async () => (await import('../pages/workspace/ProjectsPage')).ProjectsPage),
                  },
                  {
                    path: '/projects',
                    lazy: lazyPage(async () => (await import('../pages/workspace/ProjectsPage')).ProjectsPage),
                  },
                  {
                    path: '/requests',
                    lazy: lazyPage(async () => (await import('../requests/RequestIntakePage')).RequestIntakePage),
                  },
                  {
                    path: '/customers',
                    lazy: lazyPage(async () => (await import('../pages/workspace/CustomerPage')).CustomerPage),
                  },
                  {
                    path: '/customers/:customerId',
                    lazy: lazyPage(async () => (await import('../pages/workspace/CustomerPage')).CustomerPage),
                  },
                  {
                    path: '/collections',
                    lazy: lazyPage(async () => (await import('../pages/workspace/CollectionsPage')).CollectionsPage),
                  },
                  {
                    path: '/search',
                    lazy: lazyPage(async () => (await import('../search/SearchPage')).SearchPage),
                  },
                  {
                    path: '/planning',
                    element: <Navigate replace to="/planning/timeline" />,
                  },
                  {
                    path: '/planning/timeline',
                    lazy: lazyPage(async () => (await import('../pages/workspace/PlanningPage')).PlanningPage),
                  },
                  {
                    path: '/planning/roadmap',
                    lazy: lazyPage(async () => (await import('../pages/workspace/PlanningPage')).PlanningPage),
                  },
                  {
                    path: '/planning/portfolio',
                    lazy: lazyPage(async () => (await import('../pages/workspace/PlanningPage')).PlanningPage),
                  },
                  {
                    path: '/documents',
                    lazy: lazyPage(async () => (await import('../documents/DocumentPage')).DocumentPage),
                  },
                  {
                    path: '/documents/:documentId',
                    lazy: lazyPage(async () => (await import('../documents/DocumentPage')).DocumentPage),
                  },
                  {
                    path: '/goals/:goalId/documents',
                    lazy: lazyPage(async () => (await import('../pages/workspace/GoalDocumentsPage')).GoalDocumentsPage),
                  },
                  {
                    path: '/reports',
                    lazy: lazyPage(async () => (await import('../pages/workspace/ReportsPage')).ReportsPage),
                  },
                  {
                    path: '/teams/:teamId/issues',
                    lazy: lazyPage(async () => (await import('../pages/workspace/TeamIssuePage')).TeamIssuePage),
                  },
                  {
                    path: '/projects/:projectId/issues',
                    lazy: lazyPage(async () => (await import('../pages/workspace/TaskPage')).TaskPage),
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        path: '/request/:linkToken',
        lazy: lazyPage(async () => (await import('../requests/PublicRequestFormPage')).PublicRequestFormPage),
      },
      {
        path: '/forgot-password',
        lazy: lazyPage(async () => (await import('../pages/auth/ForgotPasswordPage')).ForgotPasswordPage),
      },
      {
        path: '/privacy',
        lazy: lazyPage(async () => (await import('../pages/public/PrivacyPage')).PrivacyPage),
      },
      {
        path: '/terms',
        lazy: lazyPage(async () => (await import('../pages/public/TermsPage')).TermsPage),
      },
      {
        path: '/support',
        lazy: lazyPage(async () => (await import('../pages/public/SupportPage')).SupportPage),
      },
      {
        path: '/share/documents/:shareToken',
        lazy: lazyPage(async () => (await import('../documents/SharedDocumentPage')).SharedDocumentPage),
      },
      {
        path: '*',
        element: <NotFoundPage />,
      },
    ],
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
