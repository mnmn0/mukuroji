import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const authSession = {
  accessToken: 'test-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  tokenType: 'Bearer',
  remember: true,
}

const tasks = [
  {
    id: 'wireframe',
    titleKey: 'tasks.item.wireframe',
    assigneeKey: 'tasks.assignee.sato',
    status: 'in-progress',
    dueDate: '2025/05/26',
    priority: 'high',
  },
  {
    id: 'brand-guideline',
    titleKey: 'tasks.item.brandGuideline',
    assigneeKey: 'tasks.assignee.suzuki',
    status: 'review',
    dueDate: '2025/05/27',
    priority: 'medium',
  },
  {
    id: 'seo-research',
    titleKey: 'tasks.item.seoResearch',
    assigneeKey: 'tasks.assignee.yamamoto',
    status: 'todo',
    dueDate: '2025/05/29',
    priority: 'medium',
  },
  {
    id: 'competitor-report',
    titleKey: 'tasks.item.competitorReport',
    assigneeKey: 'tasks.assignee.tanaka',
    status: 'done',
    dueDate: '2025/06/03',
    priority: 'low',
  },
]

async function mockAuthenticatedTaskPage(page: Page, taskResponse = tasks) {
  await page.addInitScript((session) => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
    window.localStorage.setItem('mukuroji.auth', JSON.stringify(session))
  }, authSession)

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      json: {
        username: 'demo@example.com',
        attributes: {
          email: 'demo@example.com',
          name: 'Demo User',
        },
      },
    })
  })

  await page.route('**/api/projects/refero/tasks', async (route) => {
    await route.fulfill({
      json: {
        projectId: 'refero',
        tasks: taskResponse,
      },
    })
  })
}

test.describe('authenticated task page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedTaskPage(page)
  })

  test('タスク画面で検索、ステータス絞り込み、行選択が動作する', async ({ page }) => {
    await page.goto('/projects/refero/tasks')

    await expect(page.getByRole('heading', { name: 'Refero' })).toBeVisible()
    await expect(page.getByRole('row', { name: /新しいランディングページ/ })).toBeVisible()
    await expect(page.getByText('4件のタスク')).toBeVisible()

    await page.getByRole('searchbox', { name: '検索...' }).fill('SEO')

    await expect(page.getByRole('row', { name: /SEO キーワードリサーチ/ })).toBeVisible()
    await expect(page.getByRole('row', { name: /ブランドガイドライン/ })).toBeHidden()
    await expect(page.getByText('1件のタスク')).toBeVisible()

    await page.getByRole('searchbox', { name: '検索...' }).clear()
    await page.getByRole('button', { name: 'ステータス' }).click()
    await page.getByRole('menuitemradio', { name: '未着手' }).click()

    await expect(page.getByRole('row', { name: /SEO キーワードリサーチ/ })).toBeVisible()
    await expect(page.getByRole('row', { name: /新しいランディングページ/ })).toBeHidden()
    await expect(page.getByText('1件のタスク')).toBeVisible()

    await page.getByRole('checkbox', { name: 'SEO キーワードリサーチ' }).check()

    await expect(page.getByRole('row', { name: /SEO キーワードリサーチ/ })).toContainText(
      '行を選択済み',
    )
  })

  test('タブ切り替えとサイドバーの折りたたみが動作する', async ({ page }) => {
    await page.goto('/projects/refero/tasks')

    await page.getByRole('tab', { name: 'ボード' }).click()

    await expect(page.getByRole('tab', { name: 'ボード' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByText('ボードビュー')).toBeVisible()

    await page.getByRole('button', { name: 'サイドバーを折りたたむ' }).click()

    await expect(page.getByLabel('メインサイドバー')).toHaveAttribute('data-collapsed', 'true')
    await expect(page.getByRole('button', { name: 'サイドバーを展開する' })).toBeVisible()
  })

  test('タスク API 失敗時にエラーを表示する', async ({ page }) => {
    await page.route('**/api/projects/refero/tasks', async (route) => {
      await route.fulfill({
        status: 500,
        json: {
          message: 'Lambda returned 500.',
        },
      })
    })

    await page.goto('/projects/refero/tasks')

    await expect(page.getByText('タスク一覧を取得できませんでした: Lambda returned 500.')).toBeVisible()
  })

  test('タスクが空の場合に empty 表示を出す', async ({ page }) => {
    await page.route('**/api/projects/refero/tasks', async (route) => {
      await route.fulfill({
        json: {
          projectId: 'refero',
          tasks: [],
        },
      })
    })

    await page.goto('/projects/refero/tasks')

    await expect(page.getByText('表示できるタスクはまだありません。')).toBeVisible()
    await expect(page.getByText('0件のタスク')).toBeVisible()
  })
})

test('未認証の場合はログイン画面へ戻す', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
  })

  await page.goto('/projects/refero/tasks')

  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible()
})
