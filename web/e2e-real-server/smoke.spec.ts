import { expect, test, type APIRequestContext } from '@playwright/test'
import { publishCoverageSummary, summarizeJsCoverage } from './coverageSummary'
import { McpStdioClient } from './mcpStdioClient'

/**
 * Minimal smoke suite against the real server running on Floci (#417).
 *
 * Calls the server through the Web dev server's `/api` proxy without mocking the API.
 * Team and Project IDs derive from their names, so each run uses unique names.
 */

const demoEmail = process.env.SMOKE_USER_EMAIL ?? 'demo@example.com'
const demoPassword = process.env.SMOKE_USER_PASSWORD ?? 'Password123!'
const runSuffix = Date.now().toString(36)
const teamName = `Smoke Team ${runSuffix}`
const projectName = `Smoke Project ${runSuffix}`
const workItemTitle = `Smoke Work Item ${runSuffix}`
const agentWorkItemTitle = `Smoke Agent Task ${runSuffix}`
const agentName = `smoke-agent-${runSuffix}`
const calendarPolicy = {
  timeZone: 'UTC',
  workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  holidays: [],
}

/**
 * Values passed between the serial tests. They stay unset when an earlier test fails.
 */
type SmokeState = {
  /** Access token from the API login; set by the first test. */
  accessToken: string
  /** ID of the created Team; set by the Team and Project test. */
  teamId: string
  /** ID of the created Project; set by the Team and Project test. */
  projectId: string
  /** ID of the created Work Item; set by the Work Item test. */
  workItemId: string
  /** Revision of the Work Item right after creation; set by the Work Item test. */
  workItemRevision: number
  /** ID of the Work Item the coding agent starts; set by the MCP test. */
  agentWorkItemId: string
  /** ID of the Agent Run the MCP server started; set by the MCP test. */
  agentRunId: string
}

/** Smoke state shared between tests. */
const state: Partial<SmokeState> = {}

test.describe.configure({ mode: 'serial' })

/**
 * Reads a value that an earlier test stored.
 *
 * @param key - Name of the value to read.
 * @returns The stored value.
 * @throws When an earlier test failed and left the value unset.
 */
function requireState<K extends keyof SmokeState>(key: K): SmokeState[K] {
  const value = state[key]
  if (value === undefined) {
    throw new Error(`Smoke state ${key} is missing; an earlier step failed.`)
  }
  return value as SmokeState[K]
}

/**
 * Builds the auth and idempotency headers for mutating API calls.
 *
 * @returns Authorization, Idempotency-Key and X-Correlation-Id headers.
 */
function mutationHeaders() {
  return {
    Authorization: `Bearer ${requireState('accessToken')}`,
    'Idempotency-Key': crypto.randomUUID(),
    'X-Correlation-Id': crypto.randomUUID(),
  }
}

/**
 * Asserts the response status and returns the parsed JSON body.
 *
 * @param response - API response.
 * @param expectedStatus - Expected HTTP status.
 * @returns Parsed JSON body.
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

test('publishes a health update for the Project', async ({ request }) => {
  const auth = { Authorization: `Bearer ${requireState('accessToken')}` }
  const planning = await readJson(await request.get('/api/planning', { headers: auth }), 200)
  expect(planning).toMatchObject({ revision: expect.any(Number) })
  const target = { type: 'project', teamId: requireState('teamId'), projectId: requireState('projectId') }
  const updateId = `update-smoke-${runSuffix}`

  // Publishing requires a cadence on the target, as in the Web composer.
  const configured = await readJson(
    await request.put('/api/planning/updates/cadence', {
      headers: mutationHeaders(),
      data: {
        target,
        cadence: {
          updateOwnerMemberKey: demoEmail,
          cadence: { unit: 'week', count: 1 },
          timeZone: 'Asia/Tokyo',
          nextDueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          reminderHoursBefore: 24,
        },
        expectedRevision: (planning as { revision: number }).revision,
      },
    }),
    200,
  )
  expect(configured).toMatchObject({ planning: { revision: expect.any(Number) } })

  const published = await readJson(
    await request.post('/api/planning/updates', {
      headers: mutationHeaders(),
      data: {
        target,
        id: updateId,
        health: 'at-risk',
        risk: 'medium',
        summary: 'Smoke health update',
        riskSummary: 'Agent work is still in review.',
        decisionSummary: 'Keep the release date.',
        helpNeeded: '',
        nextAction: 'Finish the agent task.',
        evidence: [{ type: 'work-item', teamId: requireState('teamId'), workItemId: requireState('workItemId') }],
        expectedRevision: (configured as { planning: { revision: number } }).planning.revision,
      },
    }),
    201,
  )
  expect(published).toMatchObject({
    planning: { revision: expect.any(Number) },
    update: { id: updateId, target, health: 'at-risk', risk: 'medium', summary: 'Smoke health update' },
  })

  const history = await readJson(
    await request.get('/api/planning/updates', {
      headers: auth,
      params: { targetType: 'project', teamId: target.teamId, projectId: target.projectId },
    }),
    200,
  )
  expect(history).toMatchObject({
    updates: [expect.objectContaining({ id: updateId, health: 'at-risk' })],
  })
})

test('starts and reports on a Work Item through the MCP server', async ({ request }, testInfo) => {
  const teamId = requireState('teamId')
  const auth = { Authorization: `Bearer ${requireState('accessToken')}` }
  const connection = await readJson(await request.get('/api/developer/me/agent-connection', { headers: auth }), 200)
  expect(connection).toMatchObject({ memberId: expect.any(String), canIssue: true })
  const memberId = (connection as { memberId: string }).memberId

  // The agent only starts Work Items assigned to its member in a ready status (`todo`, saved above).
  const createBody = await readJson(
    await request.post(`/api/teams/${encodeURIComponent(teamId)}/issues`, {
      headers: mutationHeaders(),
      data: {
        title: agentWorkItemTitle,
        assignedProjectId: requireState('projectId'),
        assigneeUserId: memberId,
        priority: 'medium',
        schedule: { mode: 'unscheduled', calendarPolicy },
      },
    }),
    201,
  )
  const agentWorkItem = (createBody as { issue: { id: string, revision: number } }).issue
  state.agentWorkItemId = agentWorkItem.id

  const issued = await readJson(
    await request.post('/api/developer/me/api-keys', {
      headers: mutationHeaders(),
      data: { name: `Smoke MCP ${runSuffix}`, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    }),
    201,
  )
  expect(issued).toMatchObject({ secret: expect.any(String), apiKey: { id: expect.any(String) } })
  const { secret, apiKey } = issued as { secret: string, apiKey: { id: string } }

  const baseURL = testInfo.project.use.baseURL
  if (!baseURL) throw new Error('The real-server config must set use.baseURL.')
  const mcp = await McpStdioClient.connect({
    MUKUROJI_MCP_URL: new URL(baseURL).origin,
    MUKUROJI_MCP_TOKEN: secret,
    MUKUROJI_MCP_TEAM_ID: teamId,
    MUKUROJI_MCP_ASSIGNEE_ID: memberId,
    MUKUROJI_MCP_PROJECT_ID: requireState('projectId'),
    MUKUROJI_MCP_AGENT_NAME: agentName,
    MUKUROJI_MCP_RUNTIME: 'claude-code',
  })
  try {
    const configuration = await mcp.callTool('get_configuration')
    expect(configuration).toMatchObject({
      isError: false,
      structuredContent: { data: { mcp: { serverCompatibility: { status: 'compatible' } } } },
    })

    const next = await mcp.callTool('get_next_task')
    expect(next).toMatchObject({
      isError: false,
      structuredContent: { data: { action: 'start', task: { id: agentWorkItem.id, title: agentWorkItemTitle } } },
    })

    const started = await mcp.callTool('start_task', {
      taskId: agentWorkItem.id,
      expectedRevision: agentWorkItem.revision,
      workflowStatusId: 'in-progress',
      idempotencyKey: crypto.randomUUID(),
    })
    expect(started).toMatchObject({
      isError: false,
      structuredContent: {
        data: {
          task: { id: agentWorkItem.id, statusCategory: 'started' },
          run: { runId: expect.any(String), state: 'active', runtime: 'claude-code', agentName },
        },
      },
    })
    state.agentRunId = (started.structuredContent as { data: { run: { runId: string } } }).data.run.runId

    const reported = await mcp.callTool('report_progress', {
      taskId: agentWorkItem.id,
      message: 'Smoke tests passed.',
      kind: 'verification',
      verifications: [{ command: 'bun run web:e2e:real-server', status: 'passed' }],
      idempotencyKey: crypto.randomUUID(),
    })
    expect(reported).toMatchObject({
      isError: false,
      structuredContent: { data: { report: { kind: 'verification', sequence: 1 } } },
    })
  } finally {
    await mcp.close()
    await request.delete(`/api/developer/me/api-keys/${encodeURIComponent(apiKey.id)}`, { headers: mutationHeaders() })
  }
})

test('shows the started Work Items and the agent run on the Factory board API', async ({ request }) => {
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
      expect.objectContaining({
        workItem: expect.objectContaining({ id: requireState('agentWorkItemId'), statusCategory: 'started' }),
        run: expect.objectContaining({
          runId: requireState('agentRunId'),
          state: 'active',
          agentName,
          reportCount: 1,
        }),
        latestReport: expect.objectContaining({
          runId: requireState('agentRunId'),
          kind: 'verification',
          verificationCounts: { passed: 1, failed: 0, skipped: 0 },
        }),
      }),
    ]),
  })
})

test('logs in through the Web and shows the agent run on the Factory board', async ({ page }, testInfo) => {
  await page.coverage.startJSCoverage({ resetOnNavigation: false })
  await page.goto('/')
  await page.getByLabel('メールアドレス').fill(demoEmail)
  await page.getByRole('button', { name: '続行', exact: true }).click()
  await page.getByLabel('パスワード', { exact: true }).fill(demoPassword)
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByLabel('メールアドレス')).toBeHidden()

  await page.goto(`/teams/${encodeURIComponent(requireState('teamId'))}/factory`)
  await expect(page.getByText(workItemTitle).first()).toBeVisible()
  await expect(page.getByText(agentWorkItemTitle).first()).toBeVisible()
  await expect(page.getByText(agentName).first()).toBeVisible()

  await publishCoverageSummary(summarizeJsCoverage(await page.coverage.stopJSCoverage()), testInfo)
})
