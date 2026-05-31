import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { referoTaskFixtures } from '../src/tasks/fixtures'

const authSession = {
  accessToken: 'test-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  tokenType: 'Bearer',
  remember: true,
}

/**
 * API stub が受けた request 数です。
 */
type MockRequestCounts = {
  /**
   * チーム/プロジェクト一覧 API の request 数です。
   */
  projectDirectory: number
}

const mockRequestCountsByPage = new WeakMap<Page, MockRequestCounts>()

/**
 * 認証済みタスク画面を開くため、localStorage に session を注入し、
 * `/api/auth/me` と `/api/projects/refero/tasks` を stub します。
 */
async function mockAuthenticatedTaskPage(page: Page, taskResponse = referoTaskFixtures) {
  const requestCounts: MockRequestCounts = {
    projectDirectory: 0,
  }

  mockRequestCountsByPage.set(page, requestCounts)

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

  await page.route('**/api/teams/projects**', async (route) => {
    requestCounts.projectDirectory += 1

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        teams: projectDirectoryFixtures,
      },
    })
  })

  await page.route('**/api/projects/refero/tasks', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'refero',
        tasks: taskResponse,
      },
    })
  })

  await page.route('**/api/projects/brand-refresh/tasks', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'brand-refresh',
        tasks: [],
      },
    })
  })

  await page.route('**/api/projects/shared-launch/tasks', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'shared-launch',
        tasks: [],
      },
    })
  })

  await page.route('**/api/dashboard/summary', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projects: 3,
        tasks: 18,
        blocked: 2,
        updatedAt: '2026-05-31T00:00:00.000Z',
        source: 'dynamodb',
      },
    })
  })
}

function getMockRequestCounts(page: Page) {
  const requestCounts = mockRequestCountsByPage.get(page)

  if (!requestCounts) {
    throw new Error('mockAuthenticatedTaskPage must run before reading request counts.')
  }

  return requestCounts
}

test.describe('authenticated task page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedTaskPage(page)
  })

  test('タスク画面で検索、ステータス絞り込み、行選択が動作する', async ({ page }) => {
    await page.goto('/projects/refero/tasks')

    await expect(page.getByTestId('tasks-heading')).toBeVisible()
    await expect(page.getByTestId('task-row-wireframe')).toBeVisible()
    await expect(page.getByTestId('tasks-count')).toContainText('4')

    await page.getByRole('searchbox', { name: '検索...' }).fill('SEO')

    await expect(page.getByTestId('task-row-seo-research')).toBeVisible()
    await expect(page.getByTestId('task-row-brand-guideline')).toBeHidden()
    await expect(page.getByTestId('tasks-count')).toContainText('1')

    await page.getByRole('searchbox', { name: '検索...' }).clear()
    await page.getByRole('button', { name: 'ステータス' }).click()
    await page.getByRole('menuitemradio', { name: '未着手' }).click()

    await expect(page.getByTestId('task-row-seo-research')).toBeVisible()
    await expect(page.getByTestId('task-row-wireframe')).toBeHidden()
    await expect(page.getByTestId('tasks-count')).toContainText('1')

    await page.getByRole('checkbox', { name: 'SEO キーワードリサーチ' }).check()

    await expect(page.getByTestId('task-row-seo-research')).toHaveAttribute(
      'data-selected',
      'true',
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

  test('DB のチーム別プロジェクトをサイドバーに表示し、選択したプロジェクトのタスクへ遷移する', async ({
    page,
  }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await expect(page.getByRole('button', { name: 'コアチーム' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'デザインチーム' })).toBeVisible()
    await expect(page.getByRole('button', { name: '共通ローンチ' })).toHaveCount(2)
    expect(requestCounts.projectDirectory).toBe(1)

    await page.getByRole('button', { name: 'ブランド刷新' }).click()

    await expect(page).toHaveURL('/projects/brand-refresh/tasks?teamId=design-team')
    await expect(page.getByTestId('tasks-heading')).toHaveText('ブランド刷新')
    await expect(page.getByTestId('tasks-empty')).toBeVisible()
    expect(requestCounts.projectDirectory).toBe(1)
  })

  test('同じプロジェクトが複数チームにある場合、選択元チームをタスク画面へ引き継ぐ', async ({
    page,
  }) => {
    await page.goto('/dashboard')

    const sharedLaunchButtons = page.getByRole('button', { name: '共通ローンチ' })

    await expect(sharedLaunchButtons).toHaveCount(2)
    await sharedLaunchButtons.nth(1).click()

    await expect(page).toHaveURL('/projects/shared-launch/tasks?teamId=design-team')
    await expect(page.getByTestId('tasks-heading')).toHaveText('共通ローンチ')
    await expect(page.getByLabel('プロジェクトのパンくずリスト')).toContainText(
      'デザインチーム',
    )
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

    await expect(page.getByTestId('tasks-error')).toHaveText(
      'タスク一覧を取得できませんでした: Lambda returned 500.',
    )
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

    await expect(page.getByTestId('tasks-empty')).toBeVisible()
    await expect(page.getByTestId('tasks-count')).toContainText('0')
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
