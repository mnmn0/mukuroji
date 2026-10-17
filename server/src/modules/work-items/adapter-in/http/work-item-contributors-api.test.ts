import { afterEach, expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  type WorkItemContributorAssignment,
  type WorkItemJobRoleDefinition,
} from '@mukuroji/contracts'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'

const {
  app,
  configureFakeProjectClients,
  createFakeWorkItemConfigurationClient,
  createTestWorkItemConfiguration,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const jobRoles: WorkItemJobRoleDefinition[] = [
  { id: 'designer', name: 'Designer' },
  { id: 'qa', name: 'QA' },
  { id: 'legacy-writer', name: 'Writer', archived: true },
]

const storedContributor: WorkItemContributorAssignment = {
  assignmentId: 'a'.repeat(32),
  memberUserId: 'suzuki@example.com',
  jobRoleId: 'legacy-writer',
  plannedEffortMinutes: 120,
  status: 'in-progress',
}

/**
 * Sends a Work Item update to the first fake Team Work Item.
 *
 * @param body - JSON update body without the revision.
 * @returns The HTTP response.
 */
function patchWorkItem(body: Record<string, unknown>) {
  return app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, expectedRevision: 1 }),
  })
}

test('replaces contributors while keeping the single accountable owner', async () => {
  const updates: unknown[] = []
  configureFakeProjectClients(true, {
    jobRoles,
    issueContributorAssignments: [storedContributor],
    issueUpdateHook: (input) => {
      updates.push(input.contributorAssignments)
    },
  })

  const response = await patchWorkItem({
    assigneeUserId: 'sato@example.com',
    contributorAssignments: [
      { assignmentId: storedContributor.assignmentId, memberUserId: 'suzuki@example.com', jobRoleId: 'legacy-writer', status: 'done' },
      { jobRoleId: 'designer', plannedEffortMinutes: 240 },
    ],
  })

  expect(response.status).toBe(200)
  const { issue } = await response.json()
  expect(issue.assigneeUserId).toBe('sato@example.com')
  expect(issue.contributorAssignments).toEqual([
    { assignmentId: storedContributor.assignmentId, memberUserId: 'suzuki@example.com', jobRoleId: 'legacy-writer', status: 'done' },
    { assignmentId: expect.stringMatching(/^[0-9a-f]{32}$/u), jobRoleId: 'designer', plannedEffortMinutes: 240, status: 'planned' },
  ])
  expect(updates).toEqual([issue.contributorAssignments])
})

test('leaves stored contributors untouched when an update omits them', async () => {
  const updates: Array<{ hasContributors: boolean }> = []
  configureFakeProjectClients(true, {
    jobRoles,
    issueContributorAssignments: [storedContributor],
    issueUpdateHook: (input) => {
      updates.push({ hasContributors: 'contributorAssignments' in input })
    },
  })

  const response = await patchWorkItem({ title: 'Renamed' })

  expect(response.status).toBe(200)
  expect(updates).toEqual([{ hasContributors: false }])
})

test('rejects job roles the configuration does not allow', async () => {
  const updates: unknown[] = []
  configureFakeProjectClients(true, {
    jobRoles,
    issueUpdateHook: (input) => {
      updates.push(input)
    },
  })

  for (const contributorAssignments of [
    [{ jobRoleId: 'architect' }],
    [{ jobRoleId: 'legacy-writer' }],
    [{ assignmentId: 'b'.repeat(32), jobRoleId: 'qa' }],
  ]) {
    const response = await patchWorkItem({ contributorAssignments })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'InvalidContributorAssignments' })
  }
  expect(updates).toEqual([])
})

test('requires newly added contributors to be active non-guest members', async () => {
  const updates: unknown[] = []
  configureFakeProjectClients(true, {
    jobRoles,
    issueContributorAssignments: [storedContributor],
    inactiveWorkspaceMemberKeys: ['suzuki@example.com', 'former@example.com'],
    guestWorkspaceMemberKeys: ['guest@example.com'],
    issueUpdateHook: (input) => {
      updates.push(input.contributorAssignments)
    },
  })

  for (const memberUserId of ['former@example.com', 'guest@example.com']) {
    const response = await patchWorkItem({ contributorAssignments: [{ memberUserId }] })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'WorkspaceAssigneeInactive' })
  }
  expect(updates).toEqual([])

  // A contributor who was deactivated after being assigned can stay while the rest changes.
  const kept = await patchWorkItem({
    contributorAssignments: [
      { assignmentId: storedContributor.assignmentId, memberUserId: 'suzuki@example.com', jobRoleId: 'legacy-writer', status: 'done' },
      { memberUserId: 'sato@example.com', jobRoleId: 'qa' },
    ],
  })
  expect(kept.status).toBe(200)
  expect(updates).toHaveLength(1)

  // Dropping the assignment ID makes it a new assignment, so the deactivated member is checked again.
  const readded = await patchWorkItem({ contributorAssignments: [{ memberUserId: 'suzuki@example.com' }] })
  expect(readded.status).toBe(409)
  expect(await readded.json()).toMatchObject({ code: 'WorkspaceAssigneeInactive' })
  expect(updates).toHaveLength(1)
})

test('creates a Work Item with planned contributors', async () => {
  const creates: unknown[] = []
  configureFakeProjectClients(true, {
    jobRoles,
    issueCreateHook: (input) => {
      creates.push(input.contributorAssignments)
    },
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Plan the launch',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      contributorAssignments: [
        { memberUserId: 'suzuki@example.com', jobRoleId: 'designer', plannedEffortMinutes: 90 },
        { jobRoleId: 'qa', status: 'planned' },
      ],
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-20'),
      priority: 'medium',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(201)
  const { issue } = await response.json()
  expect(issue.assigneeUserId).toBe('sato@example.com')
  expect(issue.contributorAssignments).toEqual([
    { assignmentId: expect.stringMatching(/^[0-9a-f]{32}$/u), memberUserId: 'suzuki@example.com', jobRoleId: 'designer', plannedEffortMinutes: 90, status: 'planned' },
    { assignmentId: expect.stringMatching(/^[0-9a-f]{32}$/u), jobRoleId: 'qa', status: 'planned' },
  ])
  expect(creates).toEqual([issue.contributorAssignments])
})

test('keeps job roles that contributors still use from being removed', async () => {
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    jobRoles,
    issueContributorAssignments: [storedContributor],
  })
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

  /**
   * Saves the Team configuration with the given job roles.
   *
   * @param roles - Job roles of the candidate configuration.
   * @returns The HTTP response.
   */
  const save = (roles: WorkItemJobRoleDefinition[]) => app.request('/api/teams/core-team/work-item-configuration', {
    method: 'PUT',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...createTestWorkItemConfiguration('team', 'core-team'), jobRoles: roles }),
  })

  const removed = await save(jobRoles.filter((role) => role.id !== 'legacy-writer'))
  expect(removed.status).toBe(409)
  expect(await removed.json()).toMatchObject({ code: 'WorkItemConfigurationInUse' })
  expect(writes).toBe(0)
  expect((await save(jobRoles)).status).toBe(200)
  expect(writes).toBe(1)
})

test('reports a stale revision before validating contributor assignment IDs', async () => {
  configureFakeProjectClients(true, { jobRoles, issueContributorAssignments: [] })
  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contributorAssignments: [{ assignmentId: storedContributor.assignmentId, jobRoleId: 'qa' }],
      expectedRevision: 7,
    }),
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'WorkItemRevisionConflict' })
})

/**
 * Lists the Workspace member rows that a set of ConditionChecks fences.
 *
 * @param checks - Transaction items supplied to the Work Item adapter.
 * @returns Record keys of the guarded Workspace member rows, in order.
 */
function fencedMemberRecordKeys(checks: readonly { ConditionCheck?: { Key?: Record<string, unknown> } }[] | undefined) {
  return (checks ?? []).flatMap((check) => {
    const recordKey = check.ConditionCheck?.Key?.recordKey
    return typeof recordKey === 'string' && recordKey.startsWith('MEMBER#') ? [recordKey] : []
  })
}

/**
 * Lists the configuration rows that a set of ConditionChecks fences.
 *
 * @param checks - Transaction items supplied to the Work Item adapter.
 * @returns Record keys of the guarded configuration rows, in order.
 */
function fencedConfigurationRecordKeys(checks: readonly { ConditionCheck?: { Key?: Record<string, unknown> } }[] | undefined) {
  return (checks ?? []).flatMap((check) => {
    const recordKey = check.ConditionCheck?.Key?.recordKey
    return recordKey === 'CONFIG' || recordKey === 'CONFIG_WRITE_LOCK' ? [recordKey] : []
  })
}

test('fences newly added contributor members in the Work Item write', async () => {
  const updates: unknown[] = []
  const creates: unknown[] = []
  configureFakeProjectClients(true, {
    jobRoles,
    issueContributorAssignments: [storedContributor],
    issueUpdateHook: (input) => {
      updates.push(fencedMemberRecordKeys(input.authorizationConditionChecks))
    },
    issueCreateHook: (input) => {
      creates.push(fencedMemberRecordKeys(input.authorizationConditionChecks))
    },
  })

  const updated = await patchWorkItem({
    contributorAssignments: [
      { assignmentId: storedContributor.assignmentId, memberUserId: 'suzuki@example.com', jobRoleId: 'legacy-writer', status: 'done' },
      { memberUserId: 'sato@example.com', jobRoleId: 'qa' },
    ],
  })
  expect(updated.status).toBe(200)
  // Only the added member is fenced; the kept contributor is not re-checked.
  expect(updates).toEqual([['MEMBER#sato@example.com']])

  const created = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Plan the launch',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      contributorAssignments: [{ memberUserId: 'suzuki@example.com', jobRoleId: 'designer' }],
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-20'),
      priority: 'medium',
      workflowStatusId: 'todo',
    }),
  })
  expect(created.status).toBe(201)
  expect(creates).toEqual([['MEMBER#suzuki@example.com']])
})

test('rejects a contributor deactivated before the membership fence is built', async () => {
  const updates: unknown[] = []
  configureFakeProjectClients(true, {
    jobRoles,
    deactivatedBeforeFenceMemberKeys: ['sato@example.com'],
    issueUpdateHook: (input) => {
      updates.push(input)
    },
  })

  const response = await patchWorkItem({ contributorAssignments: [{ memberUserId: 'sato@example.com' }] })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'WorkspaceAssigneeInactive' })
  expect(updates).toEqual([])
})

test('fences contributor job roles to the configuration revision they were validated against', async () => {
  const updates: unknown[] = []
  configureFakeProjectClients(true, {
    jobRoles,
    issueUpdateHook: (input) => {
      updates.push(fencedConfigurationRecordKeys(input.configurationConditionChecks))
    },
  })

  const response = await patchWorkItem({ contributorAssignments: [{ jobRoleId: 'designer' }] })

  expect(response.status).toBe(200)
  // A configuration save holds CONFIG_WRITE_LOCK while it scans contributor usage and bumps
  // CONFIG's revision when it commits, so either check fails a concurrent role assignment.
  expect(updates).toHaveLength(1)
  expect(updates[0]).toEqual(expect.arrayContaining(['CONFIG_WRITE_LOCK', 'CONFIG']))
})
