import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router'
import {
  WorkspaceRoute,
  WorkspaceRouteContent,
} from '../src/workspace/ui/WorkspaceRoute'
import type { WorkspaceRouteContextValue } from '../src/workspace/ui/WorkspaceRouteProvider'

const routeContext: WorkspaceRouteContextValue = {
  canLoadWorkspaceData: true,
  canManageWorkspaceConfiguration: false,
  canReadCustomers: true,
  canManageCustomerRequests: true,
  canViewCustomerSensitiveData: true,
  canManageCustomerViews: true,
  canMutateTeamConfiguration: false,
  commonErrorKey: 'projects.error.loading',
  fontSizePreference: 'standard',
  guardEnterpriseSession: (request) => request,
  hasQuickAccessLoadError: false,
  inboxCount: 0,
  isProjectQuickAccess: () => false,
  isLoading: false,
  isQuickAccessLoading: false,
  isQuickAccessSaving: false,
  locale: 'en',
  onFontSizePreferenceChange: () => undefined,
  onLocaleChange: () => undefined,
  onLogout: () => undefined,
  onOpenNotification: () => undefined,
  onOpenTask: () => undefined,
  onDismissProjectQuickAccessFeedback: () => undefined,
  onMoveProjectQuickAccess: async () => undefined,
  onRemoveProjectQuickAccess: async () => undefined,
  onRetryCommonData: async () => undefined,
  onRetryProjectQuickAccess: async () => undefined,
  onSelectNav: () => undefined,
  onSelectProject: () => undefined,
  onSelectTeamView: () => undefined,
  onSessionErrorAction: () => undefined,
  onToggleProjectQuickAccess: async () => undefined,
  onUndoProjectQuickAccess: async () => undefined,
  quickAccessItems: [],
  quickAccessProjects: [],
  reportNotificationPreferencesError: () => undefined,
  resolveSessionErrors: () => undefined,
  teams: [],
  userIdentityAliases: ['demo@example.com'],
  userInitial: 'D',
  userLabel: 'demo@example.com',
}

/**
 * Supplies a typed React Router outlet context to the route under test.
 *
 * @param props - Shared Workspace context exposed to the nested route.
 * @returns An outlet carrying the supplied context.
 */
function WorkspaceContextOutlet({
  context,
}: {
  context: WorkspaceRouteContextValue
}) {
  return <Outlet context={context} />
}

describe('WorkspaceRoute', () => {
  test('renders the shared common-data error boundary with a retry action', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/home']}>
        <Routes>
          <Route element={<WorkspaceContextOutlet context={routeContext} />}>
            <Route element={<WorkspaceRoute />}>
              <Route
                element={(
                  <WorkspaceRouteContent>
                    <p>Route content</p>
                  </WorkspaceRouteContent>
                )}
                path="/home"
              />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(html).toContain('data-testid="workspace-common-error"')
    expect(html).toContain('Failed to load teams and projects')
    expect(html).toContain('Reload')
    expect(html).not.toContain('Route content')
  })

  test('forwards shared context to route content below the persistent shell', () => {
    const context: WorkspaceRouteContextValue = {
      ...routeContext,
      commonErrorKey: undefined,
    }
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/home']}>
        <Routes>
          <Route element={<WorkspaceContextOutlet context={context} />}>
            <Route element={<WorkspaceRoute />}>
              <Route
                element={(
                  <WorkspaceRouteContent>
                    <p>Route content</p>
                  </WorkspaceRouteContent>
                )}
                path="/home"
              />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(html).toContain('Route content')
    expect(html).toContain('Home')
    expect(html).not.toContain('data-testid="workspace-common-error"')
  })

  test('keeps route content available while exposing a retryable Quick Access error', () => {
    const context: WorkspaceRouteContextValue = {
      ...routeContext,
      commonErrorKey: undefined,
      hasQuickAccessLoadError: true,
    }
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/home']}>
        <Routes>
          <Route element={<WorkspaceContextOutlet context={context} />}>
            <Route element={<WorkspaceRoute />}>
              <Route element={<p>Route content</p>} path="/home" />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(html).toContain('data-testid="quick-access-load-error"')
    expect(html).toContain('Quick access could not be loaded')
    expect(html).toContain('Retry quick access')
    expect(html).toContain('Route content')
  })

  test('uses the feedback role as the sole live-region contract', () => {
    const context: WorkspaceRouteContextValue = {
      ...routeContext,
      commonErrorKey: undefined,
      quickAccessFeedback: { kind: 'error' },
    }
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/home']}>
        <Routes>
          <Route element={<WorkspaceContextOutlet context={context} />}>
            <Route element={<WorkspaceRoute />}>
              <Route element={<p>Route content</p>} path="/home" />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(html).toContain('role="alert"')
    expect(html).not.toContain('aria-live="polite"')
  })
})
