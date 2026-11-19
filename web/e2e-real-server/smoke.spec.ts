import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Floci と実 server に対する最小の smoke suite です（#417）。
 *
 * API を mock せず、Web の dev server の `/api` proxy を通して server を呼びます。
 * Team と Project の ID は名前から決まるので、実行ごとに一意な名前を使います。
 */

const demoEmail = process.env.SMOKE_USER_EMAIL ?? 'demo@example.com'
const demoPassword = process.env.SMOKE_USER_PASSWORD ?? 'Password123!'
const runSuffix = Date.now().toString(36)
const teamName = `Smoke Team ${runSuffix}`
const projectName = `Smoke Project ${runSuffix}`
const workItemTitle = `Smoke Work Item ${runSuffix}`
const calendarPolicy = {
  timeZone: 'UTC',
  workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  holidays: [],
}

/**
 * 順に流す test の間で受け渡す値です。前の test が失敗すると未設定のまま残ります。
 */
type SmokeState = {
  /** API login で受け取った access token です。最初の test で設定します。 */
  accessToken: string
  /** 作成した Team の ID です。Team / Project 作成の test で設定します。 */
  teamId: string
  /** 作成した Project の ID です。Team / Project 作成の test で設定します。 */
  projectId: string
  /** 作成した Work Item の ID です。Work Item 作成の test で設定します。 */
  workItemId: string
  /** 作成直後の Work Item の revision です。Work Item 作成の test で設定します。 */
  workItemRevision: number
}

/** test 間で共有する smoke の状態です。 */
const state: Partial<SmokeState> = {}

test.describe.configure({ mode: 'serial' })

/**
 * 前の test が設定した値を読みます。
 *
 * @param key - 読む値の名前です。
 * @returns 設定済みの値です。
 * @throws 前の test が失敗して値が未設定のときに投げます。
 */
function requireState<K extends keyof SmokeState>(key: K): SmokeState[K] {
  const value = state[key]
  if (value === undefined) {
    throw new Error(`Smoke state ${key} is missing; an earlier step failed.`)
  }
  return value as SmokeState[K]
}

/**
 * 更新系 API に付ける認証と冪等性の header を作ります。
 *
 * @returns Authorization・Idempotency-Key・X-Correlation-Id の header です。
 */
function mutationHeaders() {
  return {
    Authorization: `Bearer ${requireState('accessToken')}`,
    'Idempotency-Key': crypto.randomUUID(),
    'X-Correlation-Id': crypto.randomUUID(),
  }
}

/**
 * response の status を確かめ、JSON body を返します。
 *
 * @param response - API の response です。
 * @param expectedStatus - 期待する HTTP status です。
 * @returns 解析した JSON body です。
 */
async function readJson(response: Awaited<ReturnType<APIRequestContext['get']>>, expectedStatus: number) {
  const body: unknown = await response.json().catch(() => undefined)
  expect(response.status(), JSON.stringify(body)).toBe(expectedStatus)
  return body
}

test('logs in through the API and returns an access token', async ({ request }) => {
  const body = await readJson(
    await request.post('/api/auth/login', { data: { email: demoEmail, password: demoPassword } }),
    200,
  )
  expect(body).toMatchObject({ accessToken: expect.any(String) })
  state.accessToken = (body as { accessToken: string }).accessToken
})

test('creates a Team and a Project', async ({ request }) => {
  const teamBody = await readJson(
    await request.post('/api/teams', {
      headers: mutationHeaders(),
      data: { name: teamName, nameJa: teamName, nameEn: teamName },
    }),
    201,
  )
  expect(teamBody).toMatchObject({
    team: { id: expect.any(String), name: teamName, projects: [] },
  })
  state.teamId = (teamBody as { team: { id: string } }).team.id

  const projectBody = await readJson(
    await request.post(`/api/teams/${encodeURIComponent(requireState('teamId'))}/projects`, {
      headers: mutationHeaders(),
      data: { name: projectName, nameJa: projectName, nameEn: projectName },
    }),
    201,
  )
  expect(projectBody).toMatchObject({
    project: { id: expect.any(String), name: projectName, lifecycleState: 'active' },
  })
  state.projectId = (projectBody as { project: { id: string } }).project.id
})

test('creates a Work Item and moves it to in progress', async ({ request }) => {
  const teamId = requireState('teamId')
  const createBody = await readJson(
    await request.post(`/api/teams/${encodeURIComponent(teamId)}/issues`, {
      headers: mutationHeaders(),
      data: {
        title: workItemTitle,
        assignedProjectId: requireState('projectId'),
        assigneeUserId: demoEmail,
        priority: 'medium',
        schedule: { mode: 'unscheduled', calendarPolicy },
      },
    }),
    201,
  )
  expect(createBody).toMatchObject({
    issue: {
      id: expect.any(String),
      key: expect.any(String),
      teamId,
      title: workItemTitle,
      assignedProjectId: requireState('projectId'),
      schemaVersion: 2,
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      revision: expect.any(Number),
      schedule: { mode: 'unscheduled' },
    },
  })
  const created = (createBody as { issue: { id: string, revision: number } }).issue
  state.workItemId = created.id
  state.workItemRevision = created.revision

  const updateBody = await readJson(
    await request.patch(
      `/api/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(created.id)}`,
      {
        headers: mutationHeaders(),
        data: { workflowStatusId: 'in-progress', expectedRevision: created.revision },
      },
    ),
    200,
  )
  expect(updateBody).toMatchObject({
    issue: {
      id: created.id,
      workflowStatusId: 'in-progress',
      statusCategory: 'started',
      revision: created.revision + 1,
    },
  })

  const listBody = await readJson(
    await request.get(`/api/teams/${encodeURIComponent(teamId)}/issues`, {
      headers: { Authorization: `Bearer ${requireState('accessToken')}` },
    }),
    200,
  )
  expect(listBody).toMatchObject({
    teamId,
    issues: expect.arrayContaining([
      expect.objectContaining({ id: created.id, workflowStatusId: 'in-progress' }),
    ]),
  })
})

test('saves Agent settings and reads them back', async ({ request }) => {
  const teamId = requireState('teamId')
  const settingsPath = `/api/teams/${encodeURIComponent(teamId)}/agent-settings`
  const current = await readJson(
    await request.get(settingsPath, {
      headers: { Authorization: `Bearer ${requireState('accessToken')}` },
    }),
    200,
  ) as Record<string, unknown> & { revision: number }
  expect(current).toMatchObject({
    schemaVersion: 1,
    teamId,
    revision: expect.any(Number),
    leaseMinutes: expect.any(Number),
    readyStatusIds: expect.any(Array),
  })

  const saved = await readJson(
    await request.put(settingsPath, {
      headers: mutationHeaders(),
      data: {
        expectedRevision: current.revision,
        leaseMinutes: 45,
        allowTakeoverAfterLeaseExpiry: true,
        readyStatusIds: ['todo'],
        requireAcceptanceCriteria: false,
        projectBriefs: {},
        fileFailedRunsToTriage: false,
        fileStalledRunsToTriage: false,
      },
    }),
    200,
  )
  expect(saved).toMatchObject({
    teamId,
    revision: current.revision + 1,
    leaseMinutes: 45,
    allowTakeoverAfterLeaseExpiry: true,
    readyStatusIds: ['todo'],
  })

  const reread = await readJson(
    await request.get(settingsPath, {
      headers: { Authorization: `Bearer ${requireState('accessToken')}` },
    }),
    200,
  )
  expect(reread).toMatchObject({ revision: current.revision + 1, leaseMinutes: 45 })
})

test('shows the started Work Item on the Factory board API', async ({ request }) => {
  const teamId = requireState('teamId')
  const board = await readJson(
    await request.get(`/api/teams/${encodeURIComponent(teamId)}/agent-runs`, {
      headers: { Authorization: `Bearer ${requireState('accessToken')}` },
    }),
    200,
  )
  expect(board).toMatchObject({
    generatedAt: expect.any(String),
    items: expect.arrayContaining([
      expect.objectContaining({
        workItem: expect.objectContaining({
          id: requireState('workItemId'),
          title: workItemTitle,
          statusCategory: 'started',
        }),
      }),
    ]),
  })
})

test('logs in through the Web and shows the Work Item on the Factory board', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('メールアドレス').fill(demoEmail)
  await page.getByRole('button', { name: '続行', exact: true }).click()
  await page.getByLabel('パスワード', { exact: true }).fill(demoPassword)
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByLabel('メールアドレス')).toBeHidden()

  await page.goto(`/teams/${encodeURIComponent(requireState('teamId'))}/factory`)
  await expect(page.getByText(workItemTitle).first()).toBeVisible()
})
