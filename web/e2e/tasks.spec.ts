import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import type { ProjectDirectoryTeam, ProjectMember, ProjectMemberRole, ProjectUser } from '../src/projects/api'
import type { ProjectTask } from '../src/tasks/api'
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
  /**
   * プロジェクト別タスク API の request 数です。
   */
  projectTasks: Record<string, number>
  /**
   * チーム作成 API の request 数です。
   */
  teamCreates: number
  /**
   * プロジェクト作成 API の request 数です。
   */
  projectCreates: number
  /**
   * チームアーカイブ API の request 数です。
   */
  teamArchives: number
  /**
   * プロジェクトアーカイブ API の request 数です。
   */
  projectArchives: number
  /**
   * プロジェクトメンバー一覧 API の request 数です。
   */
  projectMemberReads: number
  /**
   * Cognito user 一覧 API の request 数です。
   */
  projectUserReads: number
  /**
   * プロジェクトメンバー更新 API の request 数です。
   */
  projectMemberUpdates: number
  /**
   * プロジェクトメンバー削除 API の request 数です。
   */
  projectMemberRemoves: number
  /**
   * タスク作成 API の request 数です。
   */
  taskCreates: number
  /**
   * タスク状態更新 API の request 数です。
   */
  taskStatusUpdates: number
}

const mockRequestCountsByPage = new WeakMap<Page, MockRequestCounts>()

/**
 * 認証済みタスク画面を開くため、localStorage に session を注入し、
 * `/api/auth/me` と `/api/projects/refero/tasks` を stub します。
 */
async function mockAuthenticatedTaskPage(
  page: Page,
  taskResponse = referoTaskFixtures,
  onTaskStatusUpdate?: (
    taskId: string,
    status: ProjectTask['status'],
  ) => Promise<'fail' | undefined> | 'fail' | undefined,
) {
  const requestCounts: MockRequestCounts = {
    projectDirectory: 0,
    projectTasks: {},
    teamCreates: 0,
    projectCreates: 0,
    teamArchives: 0,
    projectArchives: 0,
    projectMemberReads: 0,
    projectUserReads: 0,
    projectMemberUpdates: 0,
    projectMemberRemoves: 0,
    taskCreates: 0,
    taskStatusUpdates: 0,
  }
  const projectDirectory: ProjectDirectoryTeam[] = projectDirectoryFixtures.map((team) => ({
    ...team,
    projects: [...team.projects],
  }))
  const taskResponsesByProject: Record<string, ProjectTask[]> = {
    refero: taskResponse.map((task) => ({ ...task })),
    'product-roadmap': [],
    'brand-refresh': [],
    'shared-launch': [],
  }
  const projectMembersByProject: Record<string, ProjectMember[]> = {
    refero: [
      {
        id: 'demo@example.com',
        email: 'demo@example.com',
        name: 'Demo User',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
      {
        id: 'sato@example.com',
        email: 'sato@example.com',
        name: '佐藤 花子',
        role: 'member',
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
    ],
  }
  const projectUsers: ProjectUser[] = [
    {
      id: 'demo@example.com',
      username: 'demo@example.com',
      email: 'demo@example.com',
      name: 'Demo User',
      enabled: true,
      status: 'CONFIRMED',
    },
    {
      id: 'sato@example.com',
      username: 'sato@example.com',
      email: 'sato@example.com',
      name: '佐藤 花子',
      enabled: true,
      status: 'CONFIRMED',
    },
    {
      id: 'viewer2@example.com',
      username: 'viewer2@example.com',
      email: 'viewer2@example.com',
      name: 'Viewer Two',
      enabled: true,
      status: 'CONFIRMED',
    },
  ]

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
        groups: ['mukuroji-system-admins'],
        isSystemAdmin: true,
      },
    })
  })

  await page.route('**/api/teams/projects**', async (route) => {
    requestCounts.projectDirectory += 1

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        teams: projectDirectory,
      },
    })
  })

  await page.route('**/api/teams', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }

    requestCounts.teamCreates += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const body = route.request().postDataJSON() as { name?: string }
    const name = body.name ?? '新規チーム'
    const team = {
      id: 'new-team',
      name,
      expanded: true,
      projects: [],
    }

    projectDirectory.push(team)

    await route.fulfill({
      status: 201,
      json: {
        team,
      },
    })
  })

  await page.route('**/api/teams/core-team/projects', async (route) => {
    requestCounts.projectCreates += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const body = route.request().postDataJSON() as { name?: string; tone?: string }
    const name = body.name ?? '新規プロジェクト'
    const project = {
      id: 'new-project',
      name,
      tone: 'green' as const,
    }

    projectDirectory[0]?.projects.push(project)
    taskResponsesByProject[project.id] = []

    await route.fulfill({
      status: 201,
      json: {
        project,
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/archive$/, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }

    requestCounts.teamArchives += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const teamId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '')
    const teamIndex = projectDirectory.findIndex((team) => team.id === teamId)

    if (teamIndex >= 0) {
      projectDirectory.splice(teamIndex, 1)
    }

    await route.fulfill({
      json: {
        teamId,
        archivedAt: '2026-06-06T00:00:00.000Z',
      },
    })
  })

  await page.route(/.*\/api\/teams\/[^/]+\/projects\/[^/]+\/archive$/, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }

    requestCounts.projectArchives += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const teamId = decodeURIComponent(pathSegments[3] ?? '')
    const projectId = decodeURIComponent(pathSegments[5] ?? '')
    const team = projectDirectory.find((candidate) => candidate.id === teamId)

    if (team) {
      team.projects = team.projects.filter((project) => project.id !== projectId)
    }

    await route.fulfill({
      json: {
        teamId,
        projectId,
        archivedAt: '2026-06-06T00:00:00.000Z',
      },
    })
  })

  await page.route('**/api/projects/refero/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'refero')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    if (route.request().method() === 'POST') {
      requestCounts.taskCreates += 1
      const body = route.request().postDataJSON() as {
        assigneeUserId?: string
        dueDate?: string
        priority?: ProjectTask['priority']
        status?: ProjectTask['status']
        title?: string
      }
      const assigneeUser = projectUsers.find((user) => user.id === body.assigneeUserId)
      const task = {
        id: 'new-task',
        title: body.title ?? '新規タスク',
        assigneeUserId: assigneeUser?.id ?? 'sato@example.com',
        assigneeEmail: assigneeUser?.email ?? 'sato@example.com',
        assigneeName: assigneeUser?.name ?? '佐藤 花子',
        status: body.status ?? 'todo',
        dueDate: body.dueDate ?? '2026/06/20',
        priority: body.priority ?? 'medium',
      } satisfies ProjectTask

      taskResponsesByProject.refero.push(task)

      await route.fulfill({
        status: 201,
        json: {
          task,
        },
      })
      return
    }

    await route.fulfill({
      json: {
        projectId: 'refero',
        tasks: taskResponsesByProject.refero,
      },
    })
  })

  await page.route(/.*\/api\/projects\/refero\/tasks\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }

    requestCounts.taskStatusUpdates += 1
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const taskId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[5] ?? '')
    const body = route.request().postDataJSON() as { status?: ProjectTask['status'] }
    const status = body.status ?? 'todo'
    const task = taskResponsesByProject.refero.find((candidate) => candidate.id === taskId)
    const updateResult = await onTaskStatusUpdate?.(taskId, status)

    if (updateResult === 'fail') {
      await route.fulfill({
        status: 500,
        json: {
          message: 'tasks.error.loading',
        },
      })
      return
    }

    if (!task) {
      await route.fulfill({
        status: 404,
        json: {
          message: 'Task was not found.',
        },
      })
      return
    }

    task.status = status

    await route.fulfill({
      json: {
        task,
      },
    })
  })

  await page.route(/.*\/api\/projects\/[^/]+\/users(?:\?.*)?$/, async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const url = new URL(route.request().url())
    const query = url.searchParams.get('query')?.trim().toLowerCase() ?? ''
    const nextToken = url.searchParams.get('nextToken')
    let users = query
      ? projectUsers.filter((user) => user.email.toLowerCase().startsWith(query))
      : projectUsers
    const responseNextToken = !query && !nextToken ? 'project-users-page-2' : undefined

    if (!query && !nextToken) {
      users = projectUsers.slice(0, 2)
    } else if (!query && nextToken === 'project-users-page-2') {
      users = projectUsers.slice(2)
    }

    requestCounts.projectUserReads += 1

    await route.fulfill({
      json: {
        nextToken: responseNextToken,
        users,
      },
    })
  })

  await page.route(/.*\/api\/projects\/[^/]+\/members(?:\/[^/]+)?$/, async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    const pathSegments = new URL(route.request().url()).pathname.split('/')
    const projectId = decodeURIComponent(pathSegments[3] ?? '')
    const memberKey = pathSegments[5] ? decodeURIComponent(pathSegments[5]) : undefined
    const members = projectMembersByProject[projectId] ?? []

    if (route.request().method() === 'GET') {
      requestCounts.projectMemberReads += 1
      await route.fulfill({
        json: {
          projectId,
          members,
        },
      })
      return
    }

    if (route.request().method() === 'PATCH' && memberKey) {
      requestCounts.projectMemberUpdates += 1
      const body = route.request().postDataJSON() as {
        role?: ProjectMemberRole
      }
      const existingMember = members.find((member) => member.id === memberKey)
      const projectUser = projectUsers.find((user) => user.id === memberKey)
      const member = {
        id: memberKey,
        email: projectUser?.email ?? memberKey,
        name: projectUser?.name,
        username: projectUser?.username,
        enabled: projectUser?.enabled,
        status: projectUser?.status,
        role: body.role ?? 'viewer',
        updatedAt: '2026-06-08T00:00:00.000Z',
      } satisfies ProjectMember

      if (existingMember) {
        Object.assign(existingMember, member)
      } else {
        members.push(member)
        projectMembersByProject[projectId] = members
      }

      await route.fulfill({
        json: {
          member,
        },
      })
      return
    }

    if (route.request().method() === 'DELETE' && memberKey) {
      requestCounts.projectMemberRemoves += 1
      projectMembersByProject[projectId] = members.filter((member) => member.id !== memberKey)
      await route.fulfill({
        json: {
          projectId,
          memberId: memberKey,
        },
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/product-roadmap/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'product-roadmap')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'product-roadmap',
        tasks: taskResponsesByProject['product-roadmap'],
      },
    })
  })

  await page.route('**/api/projects/brand-refresh/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'brand-refresh')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'brand-refresh',
        tasks: taskResponsesByProject['brand-refresh'],
      },
    })
  })

  await page.route('**/api/projects/shared-launch/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'shared-launch')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'shared-launch',
        tasks: taskResponsesByProject['shared-launch'],
      },
    })
  })

  await page.route('**/api/projects/new-project/tasks', async (route) => {
    recordProjectTaskRequest(requestCounts, 'new-project')

    expect(route.request().headers().authorization).toBe('Bearer test-access-token')

    await route.fulfill({
      json: {
        projectId: 'new-project',
        tasks: taskResponsesByProject['new-project'] ?? [],
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

/**
 * サイドバーの新規登録パネルを開きます。
 */
async function openSidebarCreatePanel(page: Page) {
  await page.getByRole('button', { name: '新規登録' }).click()
  await expect(page.getByLabel('チーム名')).toBeVisible()
}

function recordProjectTaskRequest(requestCounts: MockRequestCounts, projectId: string) {
  requestCounts.projectTasks[projectId] = (requestCounts.projectTasks[projectId] ?? 0) + 1
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

    await expect(page.getByRole('button', { name: 'コアチーム', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'デザインチーム', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '共通ローンチ', exact: true })).toHaveCount(2)
    expect(requestCounts.projectDirectory).toBe(1)
    await expect.poll(() => requestCounts.projectTasks).toEqual({
      refero: 1,
      'product-roadmap': 1,
      'shared-launch': 1,
      'brand-refresh': 1,
    })

    await page.getByRole('button', { name: 'ブランド刷新', exact: true }).click()

    await expect(page).toHaveURL('/projects/brand-refresh/tasks?teamId=design-team')
    await expect(page.getByTestId('tasks-heading')).toHaveText('ブランド刷新')
    await expect(page.getByTestId('tasks-empty')).toBeVisible()
    expect(requestCounts.projectDirectory).toBe(1)
  })

  test('サイドバーからマイタスクへ移動するとタスクをカンバンで表示する', async ({ page }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: 'マイタスク', exact: true }).click()

    await expect(page).toHaveURL('/my-tasks')
    await expect(page.getByTestId('my-tasks-kanban')).toBeVisible()
    await expect(page.getByTestId('my-tasks-column-todo')).toContainText('未着手')
    await expect(page.getByTestId('my-tasks-column-in-progress')).toContainText('進行中')
    await expect(page.getByTestId('my-tasks-column-review')).toContainText('レビュー中')
    await expect(page.getByTestId('my-tasks-column-done')).toContainText('完了')
    await expect(
      page.getByTestId('my-tasks-column-in-progress').getByTestId('my-tasks-card-refero-wireframe'),
    ).toBeVisible()
    await expect(
      page.getByTestId('my-tasks-column-todo').getByTestId('my-tasks-card-refero-seo-research'),
    ).toBeVisible()
    await expect(
      page.getByTestId('my-tasks-column-review').getByTestId('my-tasks-card-refero-brand-guideline'),
    ).toBeVisible()
    await expect(
      page.getByTestId('my-tasks-column-done').getByTestId('my-tasks-card-refero-competitor-report'),
    ).toBeVisible()

    await page
      .getByTestId('my-tasks-card-refero-brand-guideline-status-select')
      .selectOption('todo')
    await expect(
      page.getByTestId('my-tasks-column-todo').getByTestId('my-tasks-card-refero-brand-guideline'),
    ).toBeVisible()
    await expect(
      page.getByTestId('my-tasks-column-review').getByTestId('my-tasks-card-refero-brand-guideline'),
    ).toHaveCount(0)

    await page
      .getByTestId('my-tasks-card-refero-wireframe')
      .dragTo(page.getByTestId('my-tasks-column-done'))

    await expect(
      page.getByTestId('my-tasks-column-done').getByTestId('my-tasks-card-refero-wireframe'),
    ).toBeVisible()
    await expect(
      page.getByTestId('my-tasks-column-in-progress').getByTestId('my-tasks-card-refero-wireframe'),
    ).toHaveCount(0)
    await expect.poll(() => requestCounts.taskStatusUpdates).toBe(2)
  })

  test('権限管理画面でプロジェクトメンバーのロールを変更できる', async ({ page }) => {
    await page.goto('/permissions')
    const requestCounts = getMockRequestCounts(page)

    await expect(page.getByTestId('permissions-view')).toBeVisible()
    await expect(page.getByTestId('permissions-project-select')).toHaveValue('refero')
    await expect(page.getByTestId('permission-member-row-sato-example-com')).toBeVisible()
    await expect.poll(() => requestCounts.projectUserReads).toBeGreaterThanOrEqual(1)
    await expect(page.getByTestId('permissions-load-more-users')).toBeVisible()
    await page.getByTestId('permissions-load-more-users').click()
    await expect.poll(() => requestCounts.projectUserReads).toBeGreaterThanOrEqual(2)

    await page.getByTestId('permission-role-select-sato-example-com').selectOption('manager')

    await expect.poll(() => requestCounts.projectMemberUpdates).toBe(1)

    await page.getByTestId('permissions-user-search').fill('viewer2')
    await expect.poll(() => requestCounts.projectUserReads).toBeGreaterThanOrEqual(3)
    await page.getByTestId('permissions-user-select').selectOption('viewer2@example.com')
    await page.locator('#permissions-member-role').selectOption('viewer')
    await page.getByTestId('permissions-submit').click()

    await expect(page.getByTestId('permission-member-row-viewer2-example-com')).toBeVisible()
    await expect.poll(() => requestCounts.projectMemberUpdates).toBe(2)

    await page.getByTestId('permission-remove-sato-example-com').click()

    await expect(page.getByTestId('permission-member-row-sato-example-com')).toHaveCount(0)
    await expect.poll(() => requestCounts.projectMemberRemoves).toBe(1)
  })

  test('ダッシュボードからチームとプロジェクトを新規登録できる', async ({ page }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await openSidebarCreatePanel(page)
    await page.getByLabel('チーム名').fill('新規チーム')
    await page.getByRole('button', { name: 'チームを登録' }).click()

    await expect(page.getByRole('button', { name: '新規チーム', exact: true })).toBeVisible()
    expect(requestCounts.teamCreates).toBe(1)

    await page.getByLabel('プロジェクト名').fill('新規プロジェクト')
    await page.getByRole('button', { name: 'プロジェクトを登録' }).click()

    await expect(page.getByRole('button', { name: '新規プロジェクト', exact: true })).toBeVisible()
    expect(requestCounts.projectCreates).toBe(1)
  })

  test('ダッシュボードからプロジェクトをアーカイブできる', async ({ page }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: 'Refero をアーカイブ' }).click()

    await expect(page.getByRole('button', { name: 'Refero', exact: true })).toHaveCount(0)
    expect(requestCounts.projectArchives).toBe(1)
  })

  test('ダッシュボードからチームをアーカイブできる', async ({ page }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await expect(page.getByRole('button', { name: '共通ローンチ', exact: true })).toHaveCount(2)

    await page.getByRole('button', { name: 'デザインチーム をアーカイブ' }).click()

    await expect(page.getByRole('button', { name: 'デザインチーム', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '共通ローンチ', exact: true })).toHaveCount(1)
    expect(requestCounts.teamArchives).toBe(1)
  })

  test('ダッシュボードの登録フォームは空白のみの名前を API に送信しない', async ({ page }) => {
    await page.goto('/dashboard')
    const requestCounts = getMockRequestCounts(page)

    await openSidebarCreatePanel(page)
    await page.getByLabel('チーム名').fill('   ')
    await page.getByRole('button', { name: 'チームを登録' }).click()

    await expect(page.getByText('チーム名を入力してください。')).toBeVisible()
    expect(requestCounts.teamCreates).toBe(0)

    await page.getByLabel('プロジェクト名').fill('   ')
    await page.getByRole('button', { name: 'プロジェクトを登録' }).click()

    await expect(page.getByText('プロジェクト名を入力してください。')).toBeVisible()
    expect(requestCounts.projectCreates).toBe(0)
  })

  test('同じプロジェクトが複数チームにある場合、選択元チームをタスク画面へ引き継ぐ', async ({
    page,
  }) => {
    await page.goto('/dashboard')

    const sharedLaunchButtons = page.getByRole('button', { name: '共通ローンチ', exact: true })

    await expect(sharedLaunchButtons).toHaveCount(2)
    await sharedLaunchButtons.nth(1).click()

    await expect(page).toHaveURL('/projects/shared-launch/tasks?teamId=design-team')
    await expect(page.getByTestId('tasks-heading')).toHaveText('共通ローンチ')
    await expect(page.getByLabel('プロジェクトのパンくずリスト')).toContainText(
      'デザインチーム',
    )
  })

  test('チーム概要では選択チームのプロジェクトタスクだけを集計する', async ({ page }) => {
    await page.goto('/teams/design-team/overview')

    await expect(page.getByTestId('team-overview-projects').locator('p').last()).toHaveText('2')
    await expect(page.getByTestId('team-overview-open-tasks').locator('p').last()).toHaveText('0')
    await expect(page.getByTestId('team-overview-blocked').locator('p').last()).toHaveText('0')
  })

  test('タスク画面から新規タスクを登録できる', async ({ page }) => {
    await page.goto('/projects/refero/tasks')
    const requestCounts = getMockRequestCounts(page)

    await page.getByRole('button', { name: '新規タスク' }).click()
    await page.locator('input[name="title"]').fill('新規タスク')
    await page.locator('select[name="assigneeUserId"]').selectOption('sato@example.com')
    await page.locator('input[name="dueDate"]').fill('2026-06-20')
    await page.getByRole('button', { name: '登録', exact: true }).click()

    await expect(page.getByTestId('task-row-new-task').getByText('新規タスク')).toBeVisible()
    expect(requestCounts.taskCreates).toBe(1)
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

test('マイタスクの片方の移動が失敗しても別タスクの成功済み移動を維持する', async ({ page }) => {
  let markWireframeUpdateStarted!: () => void
  let releaseWireframeFailure!: () => void
  const wireframeUpdateStarted = new Promise<void>((resolve) => {
    markWireframeUpdateStarted = resolve
  })
  const wireframeFailureReleased = new Promise<void>((resolve) => {
    releaseWireframeFailure = resolve
  })

  await mockAuthenticatedTaskPage(page, referoTaskFixtures, async (taskId) => {
    if (taskId !== 'wireframe') {
      return undefined
    }

    markWireframeUpdateStarted()
    await wireframeFailureReleased
    return 'fail'
  })

  await page.goto('/my-tasks')

  await page
    .getByTestId('my-tasks-card-refero-wireframe')
    .dragTo(page.getByTestId('my-tasks-column-done'))
  await wireframeUpdateStarted

  await page
    .getByTestId('my-tasks-card-refero-seo-research')
    .dragTo(page.getByTestId('my-tasks-column-done'))
  await expect(
    page.getByTestId('my-tasks-column-done').getByTestId('my-tasks-card-refero-seo-research'),
  ).toBeVisible()

  releaseWireframeFailure()

  await expect(page.getByTestId('my-tasks-move-error')).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-in-progress').getByTestId('my-tasks-card-refero-wireframe'),
  ).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-done').getByTestId('my-tasks-card-refero-seo-research'),
  ).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-column-todo').getByTestId('my-tasks-card-refero-seo-research'),
  ).toHaveCount(0)
  expect(getMockRequestCounts(page).taskStatusUpdates).toBe(2)
})

test('マイタスクでは同一タスクの移動中に追加移動を開始できない', async ({ page }) => {
  let markWireframeDoneUpdateStarted!: () => void
  let releaseWireframeDoneUpdate!: () => void
  const wireframeDoneUpdateStarted = new Promise<void>((resolve) => {
    markWireframeDoneUpdateStarted = resolve
  })
  const wireframeDoneUpdateReleased = new Promise<void>((resolve) => {
    releaseWireframeDoneUpdate = resolve
  })

  await mockAuthenticatedTaskPage(page, referoTaskFixtures, async (taskId, status) => {
    if (taskId !== 'wireframe' || status !== 'done') {
      return undefined
    }

    markWireframeDoneUpdateStarted()
    await wireframeDoneUpdateReleased
    return undefined
  })

  await page.goto('/my-tasks')

  await page
    .getByTestId('my-tasks-card-refero-wireframe')
    .dragTo(page.getByTestId('my-tasks-column-done'))
  await wireframeDoneUpdateStarted
  await expect(
    page.getByTestId('my-tasks-column-done').getByTestId('my-tasks-card-refero-wireframe'),
  ).toBeVisible()
  await expect(
    page.getByTestId('my-tasks-card-refero-wireframe-status-select'),
  ).toBeDisabled()
  expect(getMockRequestCounts(page).taskStatusUpdates).toBe(1)

  releaseWireframeDoneUpdate()

  await expect(
    page.getByTestId('my-tasks-card-refero-wireframe-status-select'),
  ).toBeEnabled()
  expect(getMockRequestCounts(page).taskStatusUpdates).toBe(1)
  expect(getMockRequestCounts(page).projectTasks.refero).toBe(1)
})

test('未認証の場合はログイン画面へ戻す', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('mukuroji.locale', 'ja')
  })

  await page.goto('/projects/refero/tasks')

  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible()
})
