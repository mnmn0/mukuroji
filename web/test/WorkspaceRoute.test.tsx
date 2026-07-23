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
  canMutateTeamConfiguration: false,
  commonErrorKey: 'projects.error.loading',
  fontSizePreference: 'standard',
  guardEnterpriseSession: (request) => request,
  inboxCount: 0,
  isLoading: false,
  locale: 'en',
  onFontSizePreferenceChange: () => undefined,
  onLocaleChange: () => undefined,
  onLogout: () => undefined,
  onOpenNotification: () => undefined,
  onOpenTask: () => undefined,
  onRetryCommonData: async () => undefined,
  onSelectNav: () => undefined,
  onSelectProject: () => undefined,
  onSelectTeamView: () => undefined,
  onSessionErrorAction: () => undefined,
  reportAuthenticatedApiError: () => undefined,
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
})
