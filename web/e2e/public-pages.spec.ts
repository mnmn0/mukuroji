import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
  })
})

test('公開ページは390px幅でも実本文と復帰導線を表示する', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })

  const routes = [
    { path: '/forgot-password', heading: 'パスワードを再設定する' },
    { path: '/privacy', heading: 'プライバシーポリシー（ドラフト）' },
    { path: '/terms', heading: '利用規約（ドラフト）' },
    { path: '/support', heading: '困っていることから探す' },
    { path: '/unknown/workspace', heading: 'この経路は存在しません' },
  ]

  for (const route of routes) {
    await page.goto(route.path)

    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible()
    await expect(page.getByRole('link', { name: 'ログイン', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  }

  await expect(page).toHaveURL('/unknown/workspace')
  await expect(page.getByRole('link', { name: 'サポートを開く' })).toBeVisible()
})

test('サポートはURL履歴、検索件数、言語切替を同期する', async ({ page }) => {
  await page.goto('/support?topic=access')

  const accessCategory = page.getByRole('button', { name: /ログインとアカウント/ })

  await expect(accessCategory).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.getByRole('navigation', { name: '公開ページナビゲーション' })
      .getByRole('link', { name: 'サポート' }),
  ).toHaveAttribute('aria-current', 'page')

  await page.goto('/support?topic=workspace')
  await expect(page.getByRole('button', { name: /チームと権限/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page.goBack()
  await expect(page).toHaveURL('/support?topic=access')
  await expect(accessCategory).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('searchbox', { name: 'ヘルプを検索' }).fill('パスワード')
  await expect(page.getByRole('status').filter({ hasText: '1件' })).toBeVisible()

  await page.getByRole('combobox', { name: '表示言語を選択' }).selectOption('en')
  await page.getByRole('searchbox', { name: 'Search help' }).fill('password')
  await expect(page.getByRole('status').filter({ hasText: '1 article' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy support note' })).toBeVisible()
})

test('パスワード再設定は確認コードを送り、新しいパスワードを設定する', async ({ page }) => {
  await page.route('**/api/auth/password-reset/request', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ email: 'demo@example.com' })
    await route.fulfill({ status: 202, json: { accepted: true } })
  })
  await page.route('**/api/auth/password-reset/confirm', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      email: 'demo@example.com',
      code: '123456',
      newPassword: 'NewPassword123!',
    })
    await route.fulfill({ status: 204, body: '' })
  })
  await page.goto('/forgot-password')

  const emailInput = page.getByRole('textbox', { name: 'ログイン用メールアドレス' })

  await emailInput.fill('invalid-address')
  await page.getByRole('button', { name: '確認コードを送る' }).click()
  await expect(page.getByRole('alert')).toContainText('有効なメールアドレス')

  await emailInput.fill('Demo@Example.com')
  await page.getByRole('button', { name: '確認コードを送る' }).click()

  await expect(page.getByRole('heading', { name: '新しいパスワードを設定' })).toBeVisible()
  await page.getByLabel('確認コード').fill('123456')
  await page.getByLabel('新しいパスワード', { exact: true }).fill('NewPassword123!')
  await page.getByLabel('新しいパスワード（確認）').fill('NewPassword123!')
  await page.getByRole('button', { name: 'パスワードを再設定' }).click()

  await expect(page.getByRole('heading', { name: 'パスワードを再設定しました' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'ログインへ進む' })).toBeVisible()
})

test('Issue #349: 社外共有リンクはサインインなしで読み取り専用のレポートを表示し、無効なら理由を区別しない', async ({ page }) => {
  await page.route('**/api/public/project-status/valid-token', async (route) => {
    await route.fulfill({
      json: {
        report: {
          schemaVersion: 1,
          locale: 'ja',
          projectName: 'Refero 導入',
          teamName: 'Core',
          asOf: '2026-11-23T00:00:00.000Z',
          health: { health: 'at-risk', risk: 'medium', summary: '検収の日程を調整中です。', publishedAt: '2026-11-22T00:00:00.000Z' },
        },
        expiresAt: '2026-12-23T00:00:00.000Z',
      },
    })
  })
  await page.route('**/api/public/project-status/revoked-token', async (route) => {
    await route.fulfill({ status: 404, json: { code: 'ProjectStatusShareNotFound', message: 'Not found.' } })
  })
  await page.setViewportSize({ width: 390, height: 844 })

  await page.goto('/share/project-status/valid-token')
  const report = page.getByTestId('project-status-report')
  await expect(report.getByRole('heading', { level: 1 })).toContainText('Refero 導入')
  await expect(report).toContainText('検収の日程を調整中です。')
  await expect(page.getByTestId('project-status-report-progress')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  await page.goto('/share/project-status/revoked-token')
  await expect(page.getByTestId('shared-project-status-unavailable')).toBeVisible()

  let attempts = 0
  await page.route('**/api/public/project-status/flaky-token', async (route) => {
    attempts += 1
    if (attempts === 1) {
      await route.fulfill({ status: 503, json: { code: 'ProjectStatusShareUnavailable', message: 'Unavailable.' } })
      return
    }
    await route.fulfill({ json: { report: { schemaVersion: 1, locale: 'ja', projectName: 'Refero 導入', teamName: 'Core', asOf: '2026-11-23T00:00:00.000Z' }, expiresAt: '2026-12-23T00:00:00.000Z' } })
  })
  await page.goto('/share/project-status/flaky-token')
  await expect(page.getByTestId('shared-project-status-unavailable')).toHaveCount(0)
  await page.getByTestId('shared-project-status-failed').getByRole('button', { name: '再読み込み' }).click()
  await expect(page.getByTestId('project-status-report').getByRole('heading', { level: 1 })).toContainText('Refero 導入')
})
