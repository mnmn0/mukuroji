import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import type { AuthSession } from '../src/auth/session'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

/**
 * HTTP failure returned by an authenticated Workspace API stub.
 */
type WorkspaceApiFailure = {
  /** Stable machine-readable error code returned in the response body. */
  code?: string
  /** HTTP status returned by the API. */
  status: number
}

/**
 * Failure injection options for the Workspace session boundary.
 */
type WorkspaceSessionMockOptions = {
  /** Optional current-user API failure handled by the shared provider. */
  currentUserFailure?: WorkspaceApiFailure
  /** Optional Work Item API failure handled by route-specific content. */
  workItemsFailure?: WorkspaceApiFailure
}

const activeAuthSession = {
  accessToken: 'workspace-session-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  remember: true,
  tokenType: 'Bearer',
} satisfies AuthSession

const expiredAuthSession = {
  ...activeAuthSession,
  expiresAt: Date.now() - 60 * 1000,
} satisfies AuthSession

/**
 * Opens a protected route from a public history entry with an optional stored session.
 *
 * @param page - Playwright page used by the session scenario.
 * @param path - Protected Workspace path to open.
 * @param session - Session to persist before opening the protected route.
 */
async function openProtectedRoute(
  page: Page,
  path: string,
  session?: AuthSession,
) {
  await page.goto('/support')
  await page.evaluate((storedSession) => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
    window.localStorage.removeItem('mukuroji.auth')
    window.sessionStorage.removeItem('mukuroji.auth')

    if (storedSession) {
      window.localStorage.setItem('mukuroji.auth', JSON.stringify(storedSession))
    }
  }, session)
  await page.goto(path, { waitUntil: 'domcontentloaded' })
}

/**
 * Installs the common Workspace API stubs and an optional route-specific failure.
 *
 * @param page - Playwright page whose requests are intercepted.
 * @param options - Failure injection options for current-user and Work Item APIs.
 */
async function mockWorkspaceSessionApis(
  page: Page,
  options: WorkspaceSessionMockOptions = {},
) {
  await page.route('**/api/auth/me', async (route) => {
    if (options.currentUserFailure) {
      await fulfillWorkspaceApiFailure(route, options.currentUserFailure)
      return
    }

    await route.fulfill({
      json: {
        attributes: {
          'custom:workspace_id': 'workspace-demo',
          email: 'demo@example.com',
          name: 'Demo User',
        },
        groups: ['mukuroji-system-admins'],
        isSystemAdmin: true,
        username: 'demo@example.com',
        workspaceMemberStatus: 'active',
        workspaceRole: 'owner',
      },
    })
  })

  await page.route('**/api/teams/projects**', async (route) => {
    await route.fulfill({
      json: {
        teams: projectDirectoryFixtures,
      },
    })
  })

  await page.route('**/api/notifications/unread-count', async (route) => {
    await route.fulfill({
      json: {
        unreadCount: 0,
      },
    })
  })

  await page.route('**/api/work-items', async (route) => {
    if (options.workItemsFailure) {
      await fulfillWorkspaceApiFailure(route, options.workItemsFailure)
      return
    }

    await route.fulfill({
      json: {
        workItems: [],
      },
    })
  })
}

/**
 * Returns an authenticated API error body with the requested status and code.
 *
 * @param route - Intercepted Playwright route.
 * @param failure - HTTP status and optional stable error code.
 */
async function fulfillWorkspaceApiFailure(
  route: Route,
  failure: WorkspaceApiFailure,
) {
  await route.fulfill({
    json: {
      code: failure.code,
      message: 'Workspace session test failure.',
    },
    status: failure.status,
  })
}

/**
 * Reads both browser storage locations used by the authentication session.
 *
 * @param page - Playwright page on the resulting route.
 * @returns Stored local and session values for the authentication key.
 */
async function readStoredAuthSession(page: Page) {
  return page.evaluate(() => ({
    local: window.localStorage.getItem('mukuroji.auth'),
    session: window.sessionStorage.getItem('mukuroji.auth'),
  }))
}

/**
 * Verifies that a redirect replaced the protected route's history entry.
 *
 * @param page - Playwright page after the redirect.
 */
async function expectProtectedHistoryEntryReplaced(page: Page) {
  await page.goBack()
  await expect(page).toHaveURL('/support')
}

test('missing session replaces a protected Workspace route with login entry', async ({ page }) => {
  await openProtectedRoute(page, '/help')

  await expect(page).toHaveURL('/')
  await expect(readStoredAuthSession(page)).resolves.toEqual({
    local: null,
    session: null,
  })
  await expectProtectedHistoryEntryReplaced(page)
})

test('expired session is cleared before replacing a protected Workspace route', async ({ page }) => {
  await openProtectedRoute(page, '/help', expiredAuthSession)

  await expect(page).toHaveURL('/')
  await expect(readStoredAuthSession(page)).resolves.toEqual({
    local: null,
    session: null,
  })
  await expectProtectedHistoryEntryReplaced(page)
})

test('current-user 401 clears the session and replaces history with fresh login', async ({ page }) => {
  await mockWorkspaceSessionApis(page, {
    currentUserFailure: {
      status: 401,
    },
  })
  await openProtectedRoute(page, '/help', activeAuthSession)

  await expect(page).toHaveURL('/login?returnTo=%2Fhelp')
  await expect(readStoredAuthSession(page)).resolves.toEqual({
    local: null,
    session: null,
  })
  await expectProtectedHistoryEntryReplaced(page)
})

test('route-specific MFA step-up clears the session and preserves the deep return path', async ({
  page,
}) => {
  await mockWorkspaceSessionApis(page, {
    workItemsFailure: {
      code: 'EnterpriseSessionMfaRequired',
      status: 403,
    },
  })
  await openProtectedRoute(
    page,
    '/dashboard?source=session-test#attention',
    activeAuthSession,
  )

  await expect(page).toHaveURL(
    '/login?returnTo=%2Fdashboard%3Fsource%3Dsession-test%23attention',
  )
  await expect(readStoredAuthSession(page)).resolves.toEqual({
    local: null,
    session: null,
  })
  await expectProtectedHistoryEntryReplaced(page)
})

test('route-specific IP denial keeps the session and replaces history with recovery', async ({
  page,
}) => {
  await mockWorkspaceSessionApis(page, {
    workItemsFailure: {
      code: 'EnterpriseSessionIpDenied',
      status: 403,
    },
  })
  await openProtectedRoute(page, '/dashboard', activeAuthSession)

  await expect(page).toHaveURL('/security/recovery')
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: '安全に管理アクセスを復旧する',
    }),
  ).toBeVisible()
  await expect(readStoredAuthSession(page)).resolves.toEqual({
    local: JSON.stringify(activeAuthSession),
    session: null,
  })
  await expectProtectedHistoryEntryReplaced(page)
})

test('generic route failure stays on the Workspace route and keeps the session', async ({
  page,
}) => {
  await mockWorkspaceSessionApis(page, {
    workItemsFailure: {
      code: 'InternalFailure',
      status: 500,
    },
  })
  await openProtectedRoute(page, '/dashboard', activeAuthSession)

  await expect(page).toHaveURL('/dashboard')
  await expect(
    page.getByRole('heading', { level: 1, name: 'ダッシュボード' }),
  ).toBeVisible()
  await expect(page.getByTestId('workspace-task-partial-error')).toBeVisible()
  await expect(readStoredAuthSession(page)).resolves.toEqual({
    local: JSON.stringify(activeAuthSession),
    session: null,
  })
})
