import { afterEach, expect, test } from 'bun:test'
import {
  AUTOMATION_SCHEMA_VERSION,
  createDefaultUnscheduledWorkItemSchedule,
  type AutomationTemplate,
  type CreatePublicWorkItemRequest,
} from '@mukuroji/contracts'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicWorkItemService } from './api-router'
import type { AuthenticatedDeveloperCredential } from '../modules/developer-platform/application/ports'

const {
  configureFakeProjectClients,
  getTestAppDependencies,
  resetTestApp,
  runWithTestAppDependencies,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const credential: AuthenticatedDeveloperCredential = {
  kind: 'api-key',
  workspaceId: 'user#demo@example.com',
  credentialId: 'agent-key',
  subjectUserId: 'demo@example.com',
  scopes: ['work-items:read', 'work-items:write'],
}

/**
 * Builds a Work Item template version.
 *
 * @param overrides - Template fields replacing the defaults.
 * @param payload - Payload fields replacing the defaults.
 * @returns The template.
 */
function workItemTemplate(
  overrides: Partial<Omit<AutomationTemplate, 'kind' | 'payload'>> = {},
  payload: Record<string, unknown> = {},
): AutomationTemplate {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'release-check',
    workspaceId: credential.workspaceId,
    name: 'Release check',
    enabled: true,
    version: 3,
    revision: 3,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
    kind: 'work-item',
    payload: {
      title: 'Release check',
      description: 'Check the release.',
      priority: 'high',
      acceptanceCriteria: ['Tests pass', 'Docs updated'],
      assigneeUserId: 'someone-else@example.com',
      schedule: createDefaultUnscheduledWorkItemSchedule(),
      ...payload,
    },
  }
}

/**
 * Serves the given templates from the Automation template store and records created Work Items.
 *
 * @param templates - Templates the Workspace holds.
 * @param workspaceRole - Workspace role of the credential's user.
 * @returns Create inputs sent to storage.
 */
function configureTemplates(
  templates: AutomationTemplate[],
  workspaceRole: 'member' | 'guest' = 'member',
): Record<string, unknown>[] {
  const creates: Record<string, unknown>[] = []
  configureFakeProjectClients(true, {
    directoryId: credential.workspaceId,
    role: 'member',
    workspaceRole,
    issueCreateHook(input) {
      creates.push({ ...input })
    },
  })
  const teamIssues = getTestAppDependencies().workItems.teamIssues
  const stored = new Map<string, Awaited<ReturnType<typeof teamIssues.createTeamIssue>>>()
  setTestAppDependencies({
    // Like the storage adapter, a deterministic Work Item ID is created once and then returned again.
    teamIssues: {
      ...teamIssues,
      async getTeamIssueDetail(workspaceId, teamId, issueId, readOptions) {
        if (issueId.startsWith('api-') && !stored.has(issueId)) {
          throw { status: 404, code: 'TeamIssueNotFound', message: 'Issue was not found.' }
        }
        return await teamIssues.getTeamIssueDetail(workspaceId, teamId, issueId, readOptions)
      },
      async createTeamIssue(workspaceId, teamId, input, actorUserId, auditContext) {
        const issueId = input.idempotentIssueId
        const existing = issueId === undefined ? undefined : stored.get(issueId)
        if (existing) {
          creates.push({ ...input })
          return existing
        }
        const response = await teamIssues.createTeamIssue(workspaceId, teamId, input, actorUserId, auditContext)
        const created = issueId === undefined ? response : { ...response, issue: { ...response.issue, id: issueId } }
        if (issueId !== undefined) stored.set(issueId, created)
        return created
      },
    },
    ruleTemplates: new Proxy(getTestAppDependencies().automation.ruleTemplates, {
      get(target, property, receiver) {
        if (property === 'listTemplates') return async () => templates
        if (property === 'getTemplate') {
          return async (_workspaceId: string, templateId: string) =>
            templates.find((template) => template.id === templateId)
        }
        return Reflect.get(target, property, receiver)
      },
    }),
  })
  return creates
}

/**
 * Creates a Work Item through the Public API service.
 *
 * @param fields - Body fields beyond the Team, title, and assignee.
 * @param key - Idempotency key.
 * @returns The created Work Item.
 */
async function createWorkItem(fields: Partial<CreatePublicWorkItemRequest>, key: string) {
  const workItems = createCanonicalPublicWorkItemService()
  return await runWithTestAppDependencies(() => workItems.create(
    credential,
    { teamId: 'core-team', title: 'Ship 1.2', assigneeUserId: 'demo@example.com', ...fields },
    { requestId: key, idempotencyKey: key },
  ))
}

test('fills a created Work Item from its template while the body wins', async () => {
  const creates = configureTemplates([workItemTemplate()])

  await createWorkItem({ templateId: 'release-check' }, 'template-defaults')
  await createWorkItem({ templateId: 'release-check', priority: 'low', description: 'Own text' }, 'template-body-wins')

  expect(creates).toHaveLength(2)
  expect(creates[0]).toMatchObject({
    title: 'Ship 1.2',
    assigneeUserId: 'demo@example.com',
    description: 'Check the release.',
    priority: 'high',
    acceptanceCriteria: [
      { id: expect.stringMatching(/^[0-9a-f]{32}$/u), text: 'Tests pass', satisfied: false },
      { id: expect.stringMatching(/^[0-9a-f]{32}$/u), text: 'Docs updated', satisfied: false },
    ],
  })
  expect(creates[0]).not.toHaveProperty('templateId')
  expect(creates[1]).toMatchObject({ description: 'Own text', priority: 'low' })
})

test('rejects a disabled, other-Team, or non-Work-Item template before writing', async () => {
  const creates = configureTemplates([
    workItemTemplate({ id: 'disabled', enabled: false }),
    workItemTemplate({ id: 'other-team' }, { teamId: 'other-team' }),
    workItemTemplate({ id: 'owned-by-other', ownerTeamId: 'other-team' }),
  ])

  for (const templateId of ['disabled', 'other-team', 'owned-by-other', 'missing']) {
    await expect(createWorkItem({ templateId }, `template-${templateId}`)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
  }
  expect(creates).toEqual([])
})

test('lists the enabled Work Item templates of a Team', async () => {
  configureTemplates([
    workItemTemplate({ id: 'z-check', name: 'Z check' }),
    workItemTemplate({ id: 'a-check', name: 'A check' }, { acceptanceCriteria: undefined }),
    workItemTemplate({ id: 'disabled', enabled: false }),
    workItemTemplate({ id: 'other-team' }, { teamId: 'other-team' }),
    workItemTemplate({ id: 'owned-by-other', ownerTeamId: 'other-team' }),
  ])

  const catalog = await runWithTestAppDependencies(() =>
    createCanonicalPublicWorkItemService().listWorkItemTemplates(credential, 'core-team'))

  expect(catalog.teamId).toBe('core-team')
  expect(catalog.templates).toEqual([
    { id: 'a-check', version: 3, name: 'A check', title: 'Release check', description: 'Check the release.', priority: 'high', acceptanceCriteria: [] },
    { id: 'z-check', version: 3, name: 'Z check', title: 'Release check', description: 'Check the release.', priority: 'high', acceptanceCriteria: ['Tests pass', 'Docs updated'] },
  ])
  expect(JSON.stringify(catalog.templates)).not.toContain('someone-else')
})

test('keeps templates from guests, who cannot read Workspace business data', async () => {
  const creates = configureTemplates([workItemTemplate()], 'guest')

  const catalog = await runWithTestAppDependencies(() =>
    createCanonicalPublicWorkItemService().listWorkItemTemplates(credential, 'core-team'))
  expect(catalog.templates).toEqual([])
  await expect(createWorkItem({ templateId: 'release-check' }, 'template-guest')).rejects.toMatchObject({ status: 403 })
  expect(creates).toEqual([])
})

test('authorizes a replay from the request as sent, even after its template is gone', async () => {
  configureTemplates([])

  await expect(runWithTestAppDependencies(() => createCanonicalPublicWorkItemService().authorizeCreate(
    credential,
    { teamId: 'core-team', title: 'Ship 1.2', assigneeUserId: 'demo@example.com', templateId: 'release-check' },
  ))).resolves.toBeUndefined()
})

test('returns an already-created Work Item on retry after its template is disabled', async () => {
  const templates = [workItemTemplate()]
  const creates = configureTemplates(templates)

  const first = await createWorkItem({ templateId: 'release-check' }, 'template-retry')
  templates[0] = workItemTemplate({ enabled: false })
  const retry = await createWorkItem({ templateId: 'release-check' }, 'template-retry')

  expect(retry.id).toBe(first.id)
  expect(retry.acceptanceCriteria).toEqual(first.acceptanceCriteria)
  expect(creates).toHaveLength(2)
  expect(creates[1]?.idempotentRequestDigest).toBe(creates[0]?.idempotentRequestDigest)
  await expect(createWorkItem({ templateId: 'release-check' }, 'template-retry-new')).rejects.toMatchObject({
    status: 404,
    code: 'not_found',
  })
})
