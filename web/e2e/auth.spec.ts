import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
  })
})

test('初回ログイン失敗後は新しいパスワードで通常ログインから再開できると案内する', async ({ page }) => {
  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({
      json: {
        challenge: 'NEW_PASSWORD_REQUIRED',
        email: 'invited@example.com',
        session: 'cognito-challenge-session',
      },
    })
  })
  await page.route('**/api/auth/challenge/new-password', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      email: 'invited@example.com',
      newPassword: 'NewPassword123!',
      session: 'cognito-challenge-session',
    })
    await route.fulfill({
      status: 500,
      json: {
        message: 'workspace.provisioning_failed',
      },
    })
  })

  await page.goto('/')
  await page.getByLabel('メールアドレス').fill('invited@example.com')
  await page.getByLabel('パスワード', { exact: true }).fill('Temporary123!')
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()

  await expect(page.getByRole('heading', { name: '新しいパスワードを設定' })).toBeVisible()
  await page.getByLabel('新しいパスワード', { exact: true }).fill('NewPassword123!')
  await page.getByLabel('新しいパスワード（確認）').fill('NewPassword123!')
  await page.getByRole('button', { name: 'パスワードを設定して続行' }).click()

  await expect(page.getByRole('alert')).toContainText('新しいパスワードが保存済みの場合があります')
  await expect(page.getByText('通常ログインから処理を再開できます')).toBeVisible()
  await page.getByRole('button', { name: '通常ログインへ戻る' }).click()

  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible()
  await expect(page.getByLabel('メールアドレス')).toHaveValue('invited@example.com')
  await expect(page.getByLabel('パスワード', { exact: true })).toHaveValue('')
})

test('初回パスワードのポリシー違反は同じ画面で再入力を促す', async ({ page }) => {
  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({
      json: {
        challenge: 'NEW_PASSWORD_REQUIRED',
        email: 'invited@example.com',
        session: 'cognito-challenge-session',
      },
    })
  })
  await page.route('**/api/auth/challenge/new-password', async (route) => {
    await route.fulfill({
      status: 400,
      json: {
        code: 'InvalidNewPassword',
        message: 'New password does not meet the password policy.',
      },
    })
  })

  await page.goto('/')
  await page.getByLabel('メールアドレス').fill('invited@example.com')
  await page.getByLabel('パスワード', { exact: true }).fill('Temporary123!')
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await page.getByLabel('新しいパスワード', { exact: true }).fill('weakpass')
  await page.getByLabel('新しいパスワード（確認）').fill('weakpass')
  await page.getByRole('button', { name: 'パスワードを設定して続行' }).click()

  await expect(page.getByRole('alert')).toContainText('パスワードポリシーを満たしていません')
  await expect(page.getByText('通常ログインから処理を再開できます')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '新しいパスワードを設定' })).toBeVisible()
})
