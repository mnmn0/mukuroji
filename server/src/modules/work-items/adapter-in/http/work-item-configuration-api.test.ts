import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createFakeWorkItemConfigurationClient,
  createTestWorkItemConfiguration,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  createWorkspaceSearchDocument,
} from '../../../workspace-search/workspace-search'
import type {
  WorkspaceSearchClient,
} from '../../../workspace-search/workspace-search'
import {
  WorkItemConfigurationError,
} from '../../work-item-configuration'
import type {
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/**
 * Fails when a projection-focused test invokes another Search capability.
 *
 * @returns Never returns because the operation is unexpected.
 */
function failUnexpectedWorkspaceSearchOperation(): never {
  throw new Error('Unexpected Workspace Search operation.')
}

/**
 * Creates a complete Workspace Search client with a focused projection override.
 *
 * @param upsertDocument - Projection behavior exercised by the test.
 * @returns A fail-closed client for the projection behavior under test.
 */
function createWorkspaceSearchProjectionClient(
  upsertDocument: WorkspaceSearchClient['upsertDocument'],
): WorkspaceSearchClient {
  return {
    upsertDocument,
    async deleteDocument() {
      failUnexpectedWorkspaceSearchOperation()
    },
    async search() {
      return failUnexpectedWorkspaceSearchOperation()
    },
    async listSavedViews() {
      return failUnexpectedWorkspaceSearchOperation()
    },
    async createSavedView() {
      return failUnexpectedWorkspaceSearchOperation()
    },
    async updateSavedView() {
      return failUnexpectedWorkspaceSearchOperation()
    },
    async deleteSavedView() {
      return failUnexpectedWorkspaceSearchOperation()
    },
  }
}

test('reads and saves Workspace Work Item configuration through the authenticated scope', async () => {
  configureFakeProjectClients(true)
  const stored = createTestWorkItemConfiguration('workspace', 'user#demo@example.com', 3)
  const reads: string[] = []
  const writes: Array<{ configuration: WorkItemConfiguration; workspaceId: string }> = []
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getWorkspaceConfiguration(workspaceId) {
        reads.push(workspaceId)
        return { configuration: stored }
      },
      async saveWorkspaceConfiguration(workspaceId, configuration, compatibilityCheck) {
        await compatibilityCheck()
        writes.push({ workspaceId, configuration })
        return {
          configuration: {
            ...configuration,
            revision: configuration.revision + 1,
          },
        }
      },
    }),
  })

  const readResponse = await app.request('/api/work-item-configuration', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const writeResponse = await app.request('/api/work-item-configuration', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createTestWorkItemConfiguration('team', 'foreign-team', 3)),
  })

  expect(readResponse.status).toBe(200)
  expect(await readResponse.json()).toEqual({ configuration: stored })
  expect(writeResponse.status).toBe(200)
  expect(await writeResponse.json()).toMatchObject({
    configuration: {
      scopeType: 'workspace',
      scopeId: 'user#demo@example.com',
      revision: 4,
    },
  })
  expect(reads).toEqual(['user#demo@example.com'])
  expect(writes).toEqual([{
    workspaceId: 'user#demo@example.com',
    configuration: expect.objectContaining({
      scopeType: 'workspace',
      scopeId: 'user#demo@example.com',
      revision: 3,
    }),
  }])
})

test('reads and saves Team Work Item configuration for a Team manager', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const stored = createTestWorkItemConfiguration('team', 'core-team', 2)
  const reads: Array<{ teamId: string; workspaceId: string }> = []
  const writes: Array<{
    configuration: WorkItemConfiguration
    teamId: string
    workspaceId: string
  }> = []
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration(workspaceId, teamId) {
        reads.push({ workspaceId, teamId })
        return { configuration: stored }
      },
      async saveTeamConfiguration(workspaceId, teamId, configuration, compatibilityCheck) {
        await compatibilityCheck()
        writes.push({ workspaceId, teamId, configuration })
        return {
          configuration: {
            ...configuration,
            revision: configuration.revision + 1,
          },
        }
      },
    }),
  })

  const readResponse = await app.request('/api/teams/core-team/work-item-configuration', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const writeResponse = await app.request('/api/teams/core-team/work-item-configuration', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createTestWorkItemConfiguration('workspace', 'foreign-workspace', 2)),
  })

  expect(readResponse.status).toBe(200)
  expect(await readResponse.json()).toEqual({ configuration: stored })
  expect(writeResponse.status).toBe(200)
  expect(reads).toEqual([{ workspaceId: 'user#demo@example.com', teamId: 'core-team' }])
  expect(writes).toEqual([{
    workspaceId: 'user#demo@example.com',
    teamId: 'core-team',
    configuration: expect.objectContaining({
      scopeType: 'team',
      scopeId: 'core-team',
      revision: 2,
    }),
  }])
})

test('denies Work Item configuration writes outside the required administration roles', async () => {
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  let writes = 0
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async saveWorkspaceConfiguration(workspaceId, configuration) {
        writes += 1
        return { configuration: { ...configuration, scopeId: workspaceId } }
      },
      async saveTeamConfiguration(_workspaceId, teamId, configuration, compatibilityCheck) {
        await compatibilityCheck()
        writes += 1
        return { configuration: { ...configuration, scopeId: teamId } }
      },
    }),
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }

  const workspaceResponse = await app.request('/api/work-item-configuration', {
    method: 'PUT',
    headers,
    body: JSON.stringify(createTestWorkItemConfiguration('workspace', 'user#demo@example.com')),
  })
  const teamResponse = await app.request('/api/teams/core-team/work-item-configuration', {
    method: 'PUT',
    headers,
    body: JSON.stringify(createTestWorkItemConfiguration('team', 'core-team')),
  })

  expect(workspaceResponse.status).toBe(403)
  expect(teamResponse.status).toBe(403)
  expect(writes).toBe(0)
})

test('rejects a configuration change that conflicts with an existing Work Item', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  let writes = 0
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async saveTeamConfiguration(_workspaceId, teamId, configuration, compatibilityCheck) {
        await compatibilityCheck()
        writes += 1
        return { configuration: { ...configuration, scopeId: teamId } }
      },
    }),
  })
  const configuration = createTestWorkItemConfiguration('team', 'core-team')
  configuration.customFields = [{
    id: 'required-reviewer',
    name: 'Required reviewer',
    type: 'person',
    sortOrder: 0,
    required: true,
  }]

  const response = await app.request('/api/teams/core-team/work-item-configuration', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(configuration),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    code: 'WorkItemConfigurationInUse',
  })
  expect(writes).toBe(0)
})

test('rejects missing required custom fields before creating a Work Item', async () => {
  const calls = configureFakeProjectClients(true)
  const configuration = createTestWorkItemConfiguration('team', 'core-team')
  configuration.customFields = [{
    id: 'effort',
    name: 'Effort',
    type: 'number',
    sortOrder: 10,
    required: true,
    validation: { min: 1, max: 8 },
  }]
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Missing effort',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
      workflowStatusId: 'todo',
      customFieldValues: {},
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidCustomFieldValue',
    message: 'Custom field "effort" is required.',
  })
  expect(calls.issueCreates).toEqual([])
})

test('allows quick capture to defer required custom fields only in a backlog status', async () => {
  const calls = configureFakeProjectClients(true)
  const configuration = createTestWorkItemConfiguration('team', 'core-team')
  configuration.customFields = [{
    id: 'effort',
    name: 'Effort',
    type: 'number',
    sortOrder: 10,
    required: true,
  }]
  configuration.workflow.statuses.unshift({
    id: 'triage',
    name: 'Triage',
    category: 'backlog',
    sortOrder: 5,
  })
  configuration.workflow.initialStatusId = 'triage'
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Quick capture',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
      quickCapture: true,
      workflowStatusId: 'triage',
      customFieldValues: {},
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.issueCreates).toContainEqual(expect.objectContaining({
    statusCategory: 'backlog',
    workflowStatusId: 'triage',
  }))

  const invalidStatusResponse = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Invalid quick capture',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
      quickCapture: true,
      workflowStatusId: 'todo',
      customFieldValues: {},
    }),
  })

  expect(invalidStatusResponse.status).toBe(400)
  expect(await invalidStatusResponse.json()).toEqual({
    code: 'InvalidQuickCaptureStatus',
    message: 'Quick capture is only available in a backlog workflow status.',
  })
})

test('uses the configured initial workflow status when create omits legacy status', async () => {
  const calls = configureFakeProjectClients(true)
  const configuration = createTestWorkItemConfiguration('team', 'core-team')
  configuration.workflow.initialStatusId = 'triage'
  configuration.workflow.statuses.unshift({
    id: 'triage',
    name: 'Triage',
    category: 'backlog',
    sortOrder: 5,
  })
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Starts in triage',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.issueCreates).toContainEqual(expect.objectContaining({
    statusCategory: 'backlog',
    workflowStatusId: 'triage',
  }))
})

test('rejects a disallowed configured workflow transition before updating a Work Item', async () => {
  const calls = configureFakeProjectClients(true)
  const configuration = createTestWorkItemConfiguration('team', 'core-team')
  configuration.workflow.transitions = configuration.workflow.transitions.filter((transition) =>
    !(transition.fromStatusId === 'in-progress' && transition.toStatusId === 'done')
  )
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workflowStatusId: 'done', expectedRevision: 1 }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkflowTransitionDenied',
    message: 'Transition from "in-progress" to "done" is not allowed.',
  })
  expect(calls.issueUpdates).toEqual([])
})

test('calls reciprocal relation mutations and preserves their stable conflict response', async () => {
  configureFakeProjectClients(true)
  const creates: Array<{ input: unknown; teamId: string; workspaceId: string }> = []
  let deletes = 0
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async createRelation(workspaceId, teamId, input) {
        creates.push({ workspaceId, teamId, input })
        return {
          relation: {
            sourceWorkItemId: input.sourceWorkItemId,
            targetWorkItemId: input.targetWorkItemId,
            type: input.type,
          },
          reciprocalRelation: {
            sourceWorkItemId: input.targetWorkItemId,
            targetWorkItemId: input.sourceWorkItemId,
            type: 'blockedBy',
          },
          graphRevision: input.expectedGraphRevision + 1,
        }
      },
      async deleteRelation() {
        deletes += 1
        throw new WorkItemConfigurationError(
          409,
          'RelationGraphRevisionConflict',
          'Relation graph changed. Reload and try again.',
        )
      },
    }),
  })

  const createResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/relations',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'blocks',
        targetWorkItemId: 'target-issue',
        expectedGraphRevision: 4,
      }),
    },
  )
  const deleteResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/relations/target-issue/blocks',
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedGraphRevision: 4 }),
    },
  )

  expect(createResponse.status).toBe(201)
  expect(await createResponse.json()).toMatchObject({
    relation: {
      sourceWorkItemId: 'onboarding-friction',
      targetWorkItemId: 'target-issue',
      type: 'blocks',
    },
    reciprocalRelation: { type: 'blockedBy' },
    graphRevision: 5,
  })
  expect(creates).toEqual([{
    workspaceId: 'user#demo@example.com',
    teamId: 'core-team',
    input: {
      sourceWorkItemId: 'onboarding-friction',
      targetWorkItemId: 'target-issue',
      type: 'blocks',
      expectedGraphRevision: 4,
      sourceExpectedRevision: 1,
      targetExpectedRevision: 1,
      sourceAssignedProjectId: 'refero',
      targetAssignedProjectId: 'refero',
    },
  }])
  expect(deleteResponse.status).toBe(409)
  expect(await deleteResponse.json()).toEqual({
    code: 'RelationGraphRevisionConflict',
    message: 'Relation graph changed. Reload and try again.',
  })
  expect(deletes).toBe(1)
})

test('reprojects both Work Item relation endpoints after relation creation and deletion', async () => {
  const calls = configureFakeProjectClients(true)
  let graphRevision = 4
  let relations: Array<{
    sourceWorkItemId: string
    targetWorkItemId: string
    type: 'blocks' | 'blockedBy'
  }> = []
  const projectedDocuments: Array<ReturnType<typeof createWorkspaceSearchDocument>> = []
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations(_workspaceId, _teamId, workItemId) {
        return {
          graphRevision,
          relations: relations.filter((relation) => relation.sourceWorkItemId === workItemId),
        }
      },
      async createRelation(_workspaceId, _teamId, input) {
        const response = {
          relation: {
            sourceWorkItemId: input.sourceWorkItemId,
            targetWorkItemId: input.targetWorkItemId,
            type: 'blocks' as const,
          },
          reciprocalRelation: {
            sourceWorkItemId: input.targetWorkItemId,
            targetWorkItemId: input.sourceWorkItemId,
            type: 'blockedBy' as const,
          },
          graphRevision: input.expectedGraphRevision + 1,
        }
        relations = [response.relation, response.reciprocalRelation]
        graphRevision = response.graphRevision
        return response
      },
      async deleteRelation(_workspaceId, _teamId, input) {
        const response = {
          relation: relations[0]!,
          reciprocalRelation: relations[1]!,
          graphRevision: input.expectedGraphRevision + 1,
        }
        relations = []
        graphRevision = response.graphRevision
        return response
      },
    }),
    workspaceSearch: createWorkspaceSearchProjectionClient(
      async (document) => {
        const projected = createWorkspaceSearchDocument(document)
        projectedDocuments.push(projected)
        return projected
      },
    ),
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }

  const createResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/relations',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'blocks',
        targetWorkItemId: 'target-issue',
        expectedGraphRevision: 4,
      }),
    },
  )
  const deleteResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/relations/target-issue/blocks',
    {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ expectedGraphRevision: 5 }),
    },
  )

  expect([createResponse.status, deleteResponse.status]).toEqual([201, 200])
  expect(projectedDocuments.slice(0, 2)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      entityId: 'team/core-team/issue/onboarding-friction',
      relationIds: ['blocks:target-issue'],
    }),
    expect.objectContaining({
      entityId: 'team/core-team/issue/target-issue',
      relationIds: ['blockedBy:onboarding-friction'],
    }),
  ]))
  expect(projectedDocuments.slice(2)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      entityId: 'team/core-team/issue/onboarding-friction',
      relationIds: [],
    }),
    expect.objectContaining({
      entityId: 'team/core-team/issue/target-issue',
      relationIds: [],
    }),
  ]))
  expect(calls.issueDetails).toHaveLength(8)
  expect([2, 3, 6, 7].map((index) => calls.issueDetails[index]?.readOptions)).toEqual([
    { consistentIssueRead: true, eventLimit: 0 },
    { consistentIssueRead: true, eventLimit: 0 },
    { consistentIssueRead: true, eventLimit: 0 },
    { consistentIssueRead: true, eventLimit: 0 },
  ])
})

test('keeps a relation mutation successful when current relation projection reads fail', async () => {
  configureFakeProjectClients(true)
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations() {
        throw new Error('Relation graph unavailable')
      },
    }),
    workspaceSearch: createWorkspaceSearchProjectionClient(
      async (document) => {
        return createWorkspaceSearchDocument(document)
      },
    ),
  })
  const originalConsoleError = console.error
  let projectionErrors = 0
  console.error = () => {
    projectionErrors += 1
  }
  try {
    const response = await app.request(
      '/api/teams/core-team/issues/onboarding-friction/relations',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'blocks',
          targetWorkItemId: 'target-issue',
          expectedGraphRevision: 4,
        }),
      },
    )

    expect(response.status).toBe(201)
    expect(projectionErrors).toBe(2)
  } finally {
    console.error = originalConsoleError
  }
})
