import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { AuthSession } from '../src/auth/session'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

const authSession = {
  accessToken: 'connector-oauth-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  remember: true,
  tokenType: 'Bearer',
} satisfies AuthSession

/**
 * Stores a signed-in session and stubs the APIs the Workspace shell loads.
 *
 * @param page - Playwright page whose requests are intercepted.
 */
async function signInWithWorkspaceStubs(page: Page) {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      json: {
        attributes: {
          'custom:workspace_id': 'workspace-demo',
          email: 'demo@example.com',
          name: 'Demo User',
        },
        groups: [],
        isSystemAdmin: false,
        username: 'demo@example.com',
        workspaceMemberStatus: 'active',
        workspaceRole: 'owner',
      },
    })
  })
  await page.route('**/api/teams/projects**', async (route) => {
    await route.fulfill({ json: { teams: projectDirectoryFixtures } })
  })
  await page.route('**/api/projects/quick-access', async (route) => {
    await route.fulfill({ json: { items: [], revision: 0 } })
  })
  await page.route('**/api/notifications/unread-count', async (route) => {
    await route.fulfill({ json: { unreadCount: 0 } })
  })

  await page.goto('/support')
  await page.evaluate((storedSession) => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
    window.localStorage.setItem('mukuroji.auth', JSON.stringify(storedSession))
  }, authSession)
}

test('finishes a connector OAuth flow with the signed-in member session', async ({ page }) => {
  await signInWithWorkspaceStubs(page)
  const completions: Array<{ authorization?: string; body: unknown; idempotencyKey?: string }> = []
  await page.route('**/api/developer/connector-oauth/complete', async (route) => {
    const request = route.request()
    completions.push({
      authorization: request.headers().authorization,
      body: request.postDataJSON(),
      idempotencyKey: request.headers()['idempotency-key'],
    })
    await route.fulfill({
      json: { outcome: 'connected', returnUrl: '/help?connectorOAuth=connected' },
    })
  })

  await page.goto('/settings/connectors/oauth-callback#state=v1.signed-state&code=provider-code')

  await expect(page).toHaveURL('/help?connectorOAuth=connected')
  expect(completions).toHaveLength(1)
  expect(completions[0]).toMatchObject({
    authorization: 'Bearer connector-oauth-access-token',
    body: { state: 'v1.signed-state', code: 'provider-code' },
  })
  expect(completions[0]?.idempotencyKey).toBeTruthy()
  await page.goBack()
  await expect(page).toHaveURL('/support')
})

test('shows a way back when the server refuses to finish the flow', async ({ page }) => {
  await signInWithWorkspaceStubs(page)
  await page.route('**/api/developer/connector-oauth/complete', async (route) => {
    await route.fulfill({
      json: {
        code: 'forbidden',
        message: 'Connector authorization must be completed by the user who started it.',
      },
      status: 403,
    })
  })

  await page.goto('/settings/connectors/oauth-callback#state=v1.forwarded&code=provider-code')

  await expect(page.getByRole('alert')).toContainText('接続を完了できませんでした。')
  await expect(page).toHaveURL('/settings/connectors/oauth-callback')
  await expect(page.getByRole('link', { name: '連携の設定に戻る' }))
    .toHaveAttribute('href', '/settings?developerSection=connectors')
})

test('does not send anything when the callback values are missing', async ({ page }) => {
  await signInWithWorkspaceStubs(page)
  let completions = 0
  await page.route('**/api/developer/connector-oauth/complete', async (route) => {
    completions += 1
    await route.fulfill({ json: {} })
  })

  await page.goto('/settings/connectors/oauth-callback')

  await expect(page.getByRole('alert')).toContainText('接続を完了できませんでした。')
  expect(completions).toBe(0)
})
