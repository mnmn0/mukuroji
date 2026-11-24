import { afterEach, expect, test } from 'bun:test'
import type {
  WorkflowStatusDefinition,
  WorkflowTransitionActorRole,
  WorkItemAcceptanceCriterion,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicWorkItemService } from './api-router'
import type { AuthenticatedDeveloperCredential } from '../modules/developer-platform/application/ports'
import { WorkflowRuleError } from '../modules/work-items'
import { toPublicWorkflowRuleError } from './routes/public-api-routes'

const {
  app,
  configureFakeProjectClients,
  createApprovalRequestFixture,
  createFakeWorkItemConfigurationClient,
  createFileProofingStub,
  createTestWorkItemConfiguration,
  resetTestApp,
  runWithTestAppDependencies,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const criterion: Pick<WorkItemAcceptanceCriterion, 'text'> = { text: 'Reviewed' }

/**
 * Configures the Team workflow with optional actor roles on `in-progress → review` and optional
 * requirements on `review`.
 *
 * @param rules - Rules to add to the default workflow.
 * @param rules.allowedActorRoles - Roles that may move a Work Item from in progress to review.
 * @param rules.review - Requirements of the review status.
 * @returns The configuration the Team resolves.
 */
function configureRules(rules: {
  allowedActorRoles?: WorkflowTransitionActorRole[]
  review?: Pick<WorkflowStatusDefinition, 'requiredFields' | 'requiredCustomFieldIds'>
}): WorkItemConfiguration {
  const configuration: WorkItemConfiguration = {
    ...createTestWorkItemConfiguration('team', 'core-team', 4),
    customFields: [{ id: 'review-note', name: 'Review note', type: 'text', sortOrder: 0, required: false }],
  }
  configuration.workflow.transitions = configuration.workflow.transitions.map((transition) =>
    transition.fromStatusId === 'in-progress' && transition.toStatusId === 'review' && rules.allowedActorRoles
      ? { ...transition, allowedActorRoles: rules.allowedActorRoles }
      : transition)
  configuration.workflow.statuses = configuration.workflow.statuses.map((status) =>
    status.id === 'review' ? { ...status, ...rules.review } : status)
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
  })
  return configuration
}

/**
 * Sends a Team Work Item update for the first fake Work Item.
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

test('leaves a workflow without rules unchanged', async () => {
  configureFakeProjectClients(true, { role: 'member', detailAssigneeUserId: 'sato@example.com' })
  configureRules({})

  expect((await patchWorkItem({ workflowStatusId: 'review' })).status).toBe(200)
})

test('rejects a member moving a Work Item through a manager-only transition, with the reason', async () => {
  configureFakeProjectClients(true, { role: 'member', detailAssigneeUserId: 'sato@example.com' })
  configureRules({ allowedActorRoles: ['project-manager'] })

  const response = await patchWorkItem({ workflowStatusId: 'review' })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    code: 'WorkflowTransitionActorDenied',
    message: 'The workflow does not let this actor make the status change.',
    unmetConditions: [{
      rule: 'transition-actor',
      allowedActorRoles: ['project-manager'],
      message: 'Only project-manager may make this transition.',
    }],
  })
  // Other transitions stay open to the member.
  expect((await patchWorkItem({ workflowStatusId: 'done' })).status).toBe(200)
})

test('lets a Project manager or the assignee run a restricted transition', async () => {
  configureFakeProjectClients(true, { role: 'manager', detailAssigneeUserId: 'sato@example.com' })
  configureRules({ allowedActorRoles: ['project-manager'] })
  expect((await patchWorkItem({ workflowStatusId: 'review' })).status).toBe(200)

  resetTestApp()
  configureFakeProjectClients(true, { role: 'member', detailAssigneeUserId: 'demo@example.com' })
  configureRules({ allowedActorRoles: ['project-manager', 'assignee'] })
  expect((await patchWorkItem({ workflowStatusId: 'review' })).status).toBe(200)
})

test('judges the assignee before the change, so reassigning oneself does not unlock the transition', async () => {
  configureFakeProjectClients(true, { role: 'member', detailAssigneeUserId: 'sato@example.com' })
  configureRules({ allowedActorRoles: ['assignee'] })

  const response = await patchWorkItem({ workflowStatusId: 'review', assigneeUserId: 'demo@example.com' })

  expect(response.status).toBe(403)
})

test('rejects entering a status while a field it requires is empty, and lists every empty field', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  configureRules({ review: { requiredFields: ['acceptance-criteria'], requiredCustomFieldIds: ['review-note'] } })

  const response = await patchWorkItem({ workflowStatusId: 'review' })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkflowStatusRequirementsNotMet',
    message: 'Fields required in the target status are empty: acceptance-criteria, review-note.',
    unmetConditions: [
      { rule: 'required-field', field: 'acceptance-criteria', message: 'acceptance-criteria is required in this status.' },
      { rule: 'required-custom-field', customFieldId: 'review-note', message: 'Custom field "review-note" is required in this status.' },
    ],
  })
})

test('judges required fields against the values the same update sets', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  configureRules({ review: { requiredFields: ['acceptance-criteria', 'due-date'], requiredCustomFieldIds: ['review-note'] } })

  const response = await patchWorkItem({
    workflowStatusId: 'review',
    acceptanceCriteria: [{ text: criterion.text, satisfied: false }],
    customFieldValues: { 'review-note': 'Ready' },
  })

  expect(response.status).toBe(200)
})

test('does not check required fields when the status does not change', async () => {
  configureFakeProjectClients(true, { role: 'member', detailWorkflowStatusId: 'review' })
  configureRules({ allowedActorRoles: ['project-manager'], review: { requiredFields: ['acceptance-criteria'] } })

  expect((await patchWorkItem({ title: 'Renamed' })).status).toBe(200)
})

const credential: AuthenticatedDeveloperCredential = {
  kind: 'api-key',
  workspaceId: 'user#demo@example.com',
  credentialId: 'agent-key',
  subjectUserId: 'demo@example.com',
  scopes: ['work-items:read', 'work-items:write'],
}

test('rejects a restricted transition from a developer credential even when its subject is a manager', async () => {
  configureFakeProjectClients(true, {
    directoryId: credential.workspaceId,
    role: 'manager',
    workspaceRole: 'member',
    detailAssigneeUserId: 'demo@example.com',
    detailWorkflowStatusId: 'in-progress',
    detailStatusCategory: 'started',
  })
  configureRules({ allowedActorRoles: ['project-manager', 'assignee'] })
  const workItems = createCanonicalPublicWorkItemService()

  const update = runWithTestAppDependencies(() => workItems.update(
    credential, 'core-team', 'task-1',
    { expectedRevision: 1, workflowStatusId: 'review' },
    { requestId: 'restricted', idempotencyKey: 'restricted' }, undefined,
  ))

  await expect(update).rejects.toBeInstanceOf(WorkflowRuleError)
  await expect(update).rejects.toMatchObject({
    status: 403,
    unmetConditions: [{ rule: 'transition-actor', allowedActorRoles: ['project-manager', 'assignee'] }],
  })
})

test('applies transition actor roles to the person whose approval decision changes the status', async () => {
  configureFakeProjectClients(true, {
    role: 'member',
    detailAssigneeUserId: 'sato@example.com',
    detailWorkflowStatusIds: ['in-progress'],
  })
  const configuration = configureRules({ allowedActorRoles: ['project-manager'] })
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async decideApproval(_scope, _actor, _approvalId, _input, _auditContext, resolver) {
        await resolver?.('review')
        return createApprovalRequestFixture({ status: 'approved' })
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/issue-1/approvals/approval-1/decisions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', expectedRevision: 1 }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'WorkflowTransitionActorDenied' })
})

test('rejects creating a Work Item in a restricted status even when the creator assigns themselves', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  const configuration = configureRules({})
  configuration.workflow.transitions = configuration.workflow.transitions.map((transition) =>
    transition.toStatusId === 'review' ? { ...transition, allowedActorRoles: ['project-manager', 'assignee'] } : transition)

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Approved without review',
      assignedProjectId: 'refero',
      assigneeUserId: 'demo@example.com',
      schedule: { mode: 'unscheduled', calendarPolicy: { kind: 'all-days' } },
      priority: 'medium',
      workflowStatusId: 'review',
    }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'WorkflowTransitionActorDenied' })
})

test('maps workflow rule rejections to Public API problems with one pointer per unmet rule', () => {
  const denied = toPublicWorkflowRuleError(new WorkflowRuleError([
    { rule: 'transition-actor', allowedActorRoles: ['project-manager'], message: 'Only a manager may move it.' },
    { rule: 'required-field', field: 'due-date', message: 'Set a due date.' },
  ]))
  expect(denied).toMatchObject({ status: 403, code: 'forbidden', retryable: false })
  expect(denied.violations?.map(({ pointer, code }) => ({ pointer, code }))).toEqual([
    { pointer: '/workflowStatusId', code: 'transition_actor_denied' },
    { pointer: '/schedule', code: 'status_field_required' },
  ])

  const missing = toPublicWorkflowRuleError(new WorkflowRuleError([
    { rule: 'required-field', field: 'acceptance-criteria', message: 'Add acceptance criteria.' },
    { rule: 'required-custom-field', customFieldId: 'review-note', message: 'Fill Review note.' },
  ]))
  expect(missing).toMatchObject({ status: 409, code: 'conflict', retryable: false })
  expect(missing.violations?.map(({ pointer, code }) => ({ pointer, code }))).toEqual([
    { pointer: '/acceptanceCriteria', code: 'status_field_required' },
    { pointer: '/customFieldValues/review-note', code: 'status_field_required' },
  ])
})

test('does not require a custom field that the Work Item\'s Project cannot hold', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  const configuration = configureRules({ review: { requiredCustomFieldIds: ['review-note'] } })
  // The field belongs to another Project only, so this Work Item could never fill it.
  configuration.customFields = configuration.customFields.map((field) => ({ ...field, projectIds: ['other-project'] }))

  const response = await patchWorkItem({ workflowStatusId: 'review' })

  expect(response.status).toBe(200)
})
