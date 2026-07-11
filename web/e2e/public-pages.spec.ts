import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
  })
})

test('公開ページは390px幅でも実本文と復帰導線を表示する', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })

  const routes = [
    { path: '/forgot-password', heading: '安全な復旧経路を確認する' },
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

test('パスワード復旧は未送信を明示し、安全な依頼メモだけを作る', async ({ page }) => {
  await page.goto('/forgot-password')

  const emailInput = page.getByRole('textbox', { name: 'ログイン用メールアドレス' })

  await emailInput.fill('invalid-address')
  await page.getByRole('button', { name: '復旧手順を確認' }).click()
  await expect(page.getByRole('alert')).toContainText('有効なメールアドレス')

  await emailInput.fill('demo@example.com')
  await page.getByRole('button', { name: '復旧手順を確認' }).click()

  await expect(page.getByRole('heading', { name: '管理者へ渡す連絡メモ' })).toBeVisible()
  await expect(page.getByText('再設定メールは送信されません')).toBeVisible()
  await expect(page.getByText(/ログイン用メールアドレス: demo@example.com/)).toBeVisible()
})
