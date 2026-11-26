import { afterEach, expect, test } from 'bun:test'
import type {
  ApprovalSummary,
  WorkItemAcceptanceCriterion,
  WorkItemCompletionGatePolicy,
} from '@mukuroji/contracts'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicWorkItemService } from './api-router'
import type { AuthenticatedDeveloperCredential } from '../modules/developer-platform/application/ports'
import { WorkItemCompletionGateError } from '../modules/work-items'

const {
  app,
  configureFakeProjectClients,
  createApprovalRequestFixture,
  createFakeWorkItemConfigurationClient,
  createFileProofingStub,
  createTeamIssuesFake,
  createTestWorkItemConfiguration,
  getTestAppDependencies,
  resetTestApp,
  runWithTestAppDependencies,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const openCriterion: WorkItemAcceptanceCriterion = { id: 'a'.repeat(32), text: 'Tests pass', satisfied: false }
const metCriterion: WorkItemAcceptanceCriterion = { id: 'b'.repeat(32), text: 'Docs updated', satisfied: true }

/**
 * Builds approval counts for a Work Item.
 *
 * @param counts - Counts that differ from zero.
 * @returns A complete approval summary.
 */
function approvals(counts: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    pendingCount: 0,
    overdueCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    changesRequestedCount: 0,
    ...counts,
  }
}

/**
 * Configures the Team's completion Gate and the approval counts the Gate reads.
 *
 * @param completionGate - Team completion Gate, or undefined for a Team without one.
 * @param readApprovals - Approval summary read; counts the reads made.
 * @returns Approval summary reads made during the request.
 */
function configureGate(
  completionGate: WorkItemCompletionGatePolicy | undefined,
  readApprovals: () => Promise<ApprovalSummary> = async () => approvals(),
) {
  const approvalReads: string[] = []
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async getApprovalSummary(scope) {
        approvalReads.push(scope.issueId ?? '')
        return readApprovals()
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration(_workspaceId, teamId) {
        return {
          configuration: {
            ...createTestWorkItemConfiguration('team', teamId),
            ...(completionGate === undefined ? {} : { completionGate }),
          },
        }
      },
    }),
  })
  return approvalReads
}

/**
 * Records the configuration condition checks each Work Item update commits with.
 *
 * @returns Condition checks received by the persistence fake.
 */
function captureConfigurationConditionChecks() {
  const teamIssues = getTestAppDependencies().workItems.teamIssues
  const checks: unknown[] = []
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamIssueDetail(...args) {
        return teamIssues.getTeamIssueDetail(...args)
      },
      async updateTeamIssue(directoryId, teamId, issueId, input, ...rest) {
        checks.push(...(input.configurationConditionChecks ?? []))
        return teamIssues.updateTeamIssue(directoryId, teamId, issueId, input, ...rest)
      },
    }),
  })
  return checks
}

/**
 * Sends a Team Work Item update for the first fake Work Item.
 *
 * @param body - JSON update body without the revision.
 * @param expectedRevision - Revision the client read.
 * @returns The HTTP response.
 */
function patchWorkItem(body: Record<string, unknown>, expectedRevision = 1) {
  return app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, expectedRevision }),
  })
}

test('keeps completion unchanged and reads no approvals when the Team sets no Gate', async () => {
  configureFakeProjectClients(true, { detailAcceptanceCriteria: [openCriterion] })
  const approvalReads = configureGate(undefined)

  const response = await patchWorkItem({ workflowStatusId: 'done' })

  expect(response.status).toBe(200)
  expect(approvalReads).toEqual([])
})

test('rejects completing a Work Item with an unsatisfied acceptance criterion and lists the condition', async () => {
  configureFakeProjectClients(true, { detailAcceptanceCriteria: [openCriterion, metCriterion] })
  const approvalReads = configureGate({ acceptanceCriteria: 'required' })

  const response = await patchWorkItem({ workflowStatusId: 'done' })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkItemCompletionGateNotSatisfied',
    message: "The Team's completion Gate is not satisfied: acceptance-criteria.",
    unmetConditions: [{
      condition: 'acceptance-criteria',
      requirement: 'required',
      reason: 'unmet',
      message: '1 of 2 acceptance criteria are not satisfied.',
    }],
  })
  // Acceptance criteria alone need no approval read.
  expect(approvalReads).toEqual([])
})

test('evaluates the criteria the same update marks satisfied', async () => {
  configureFakeProjectClients(true, { detailAcceptanceCriteria: [openCriterion] })
  configureGate({ acceptanceCriteria: 'required' })

  const response = await patchWorkItem({
    workflowStatusId: 'done',
    acceptanceCriteria: [{ ...openCriterion, satisfied: true }],
  })

  expect(response.status).toBe(200)
})

test('judges the Gate at the revision the update is conditioned on', async () => {
  configureFakeProjectClients(true, { detailAcceptanceCriteria: [metCriterion] })
  configureGate({ acceptanceCriteria: 'required' })

  const response = await patchWorkItem({ workflowStatusId: 'done' }, 2)

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'WorkItemRevisionConflict' })
})

test('only checks moves into the completed category, and a warn condition does not block', async () => {
  configureFakeProjectClients(true, { detailAcceptanceCriteria: [openCriterion] })
  configureGate({ acceptanceCriteria: 'warn' })
  expect((await patchWorkItem({ workflowStatusId: 'done' })).status).toBe(200)

  resetTestApp()
  configureFakeProjectClients(true, { detailAcceptanceCriteria: [openCriterion] })
  configureGate({ acceptanceCriteria: 'required' })
  expect((await patchWorkItem({ workflowStatusId: 'review' })).status).toBe(200)
})

test('rejects completion while an approval is pending or no approval has been approved', async () => {
  configureFakeProjectClients(true)
  const approvalReads = configureGate(
    { noPendingApprovals: 'required', humanApproval: 'required' },
    async () => approvals({ pendingCount: 1, changesRequestedCount: 1 }),
  )

  const response = await patchWorkItem({ workflowStatusId: 'done' })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    code: 'WorkItemCompletionGateNotSatisfied',
    unmetConditions: [
      { condition: 'no-pending-approvals', reason: 'unmet', message: '2 approval(s) are pending or have changes requested.' },
      { condition: 'human-approval', reason: 'unmet' },
    ],
  })
  expect(approvalReads).toEqual(['onboarding-friction'])
})

test('allows completion once an approval is approved and none is pending, fencing the counts it judged', async () => {
  configureFakeProjectClients(true)
  configureGate(
    { noPendingApprovals: 'required', humanApproval: 'required' },
    async () => approvals({ approvedCount: 1, rejectedCount: 1 }),
  )
  const fenceChecks = captureConfigurationConditionChecks()

  expect((await patchWorkItem({ workflowStatusId: 'done' })).status).toBe(200)
  expect(fenceChecks).toContainEqual({
    ConditionCheck: expect.objectContaining({ Key: expect.objectContaining({ recordKey: 'APPROVAL_SUMMARY' }) }),
  })
})

test('does not fence approval counts that only a warn condition read', async () => {
  configureFakeProjectClients(true)
  const approvalReads = configureGate({ humanApproval: 'warn' })
  const fenceChecks = captureConfigurationConditionChecks()

  expect((await patchWorkItem({ workflowStatusId: 'done' })).status).toBe(200)
  expect(approvalReads).toEqual(['onboarding-friction'])
  expect(fenceChecks).not.toContainEqual({
    ConditionCheck: expect.objectContaining({ Key: expect.objectContaining({ recordKey: 'APPROVAL_SUMMARY' }) }),
  })
})

test('fails closed when approvals cannot be read', async () => {
  configureFakeProjectClients(true)
  configureGate({ humanApproval: 'required' }, async () => {
    throw new Error('Approval table is unavailable.')
  })
  const logged: unknown[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args[0])
  }
  try {
    const response = await patchWorkItem({ workflowStatusId: 'done' })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      unmetConditions: [{ condition: 'human-approval', reason: 'unavailable' }],
    })
    expect(logged).toEqual(['Work Item approvals could not be read for the completion Gate.'])
  } finally {
    console.error = originalConsoleError
  }
})

/**
 * Configures a completion transition an approval decision applies, and the Team's Gate.
 *
 * @param completionGate - Team completion Gate.
 * @param summary - Approval counts stored before the decision.
 * @returns Completion transitions the decision resolved.
 */
function configureApprovalCompletion(
  completionGate: WorkItemCompletionGatePolicy,
  summary: ApprovalSummary,
) {
  const resolved: unknown[] = []
  const configuration = {
    ...createTestWorkItemConfiguration('team', 'core-team', 4),
    completionGate,
  }
  configuration.workflow.statuses.push({
    id: 'approval-complete',
    name: 'Approval complete',
    category: 'completed',
    sortOrder: 50,
  })
  configuration.workflow.transitions.push({ fromStatusId: 'in-progress', toStatusId: 'approval-complete' })
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async getApprovalSummary() {
        return summary
      },
      async decideApproval(_scope, _actor, _approvalId, _input, _auditContext, resolver) {
        resolved.push(await resolver?.('approval-complete'))
        return createApprovalRequestFixture({ status: 'approved' })
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
  })
  return resolved
}

/**
 * Approves the fixture approval on the fixture Work Item.
 *
 * @returns The HTTP response.
 */
function approve() {
  return app.request('/api/teams/core-team/issues/issue-1/approvals/approval-1/decisions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', expectedRevision: 1 }),
  })
}

test('applies the Gate when an approval decision completes the Work Item', async () => {
  configureFakeProjectClients(true, {
    role: 'member',
    detailWorkflowStatusIds: ['in-progress'],
    detailAcceptanceCriteria: [openCriterion],
  })
  configureApprovalCompletion({ acceptanceCriteria: 'required' }, approvals({ pendingCount: 1 }))

  const response = await approve()

  expect(response.status).toBe(409)
  // The decision reports the Gate like a Work Item update, unmet conditions included.
  expect(await response.json()).toMatchObject({
    code: 'WorkItemCompletionGateNotSatisfied',
    unmetConditions: [{ condition: 'acceptance-criteria', requirement: 'required', reason: 'unmet' }],
  })
})

test('counts the approval being decided as approved', async () => {
  configureFakeProjectClients(true, {
    role: 'member',
    detailWorkflowStatusIds: ['in-progress'],
  })
  const resolved = configureApprovalCompletion(
    { noPendingApprovals: 'required', humanApproval: 'required' },
    approvals({ pendingCount: 1 }),
  )

  const response = await approve()

  expect(response.status).toBe(200)
  // The decision's summary update commits only while the counts the Gate judged are unchanged.
  expect(resolved).toEqual([expect.objectContaining({
    statusCategory: 'completed',
    expectedApprovalSummary: { pendingCount: 1, approvedCount: 0, changesRequestedCount: 0 },
  })])
})

const credential: AuthenticatedDeveloperCredential = {
  kind: 'api-key',
  workspaceId: 'user#demo@example.com',
  credentialId: 'agent-key',
  subjectUserId: 'demo@example.com',
  scopes: ['work-items:read', 'work-items:write'],
}

test('applies the Gate to Public API updates and reads acceptance criterion marks from the request', async () => {
  configureFakeProjectClients(true, {
    directoryId: credential.workspaceId,
    role: 'member',
    workspaceRole: 'member',
    detailAssigneeUserId: 'demo@example.com',
    detailWorkflowStatusId: 'in-progress',
    detailStatusCategory: 'started',
    detailAcceptanceCriteria: [openCriterion],
  })
  configureGate({ acceptanceCriteria: 'required' })
  const workItems = createCanonicalPublicWorkItemService()
  const update = (change: Record<string, unknown>, key: string) =>
    runWithTestAppDependencies(() => workItems.update(
      credential, 'core-team', 'task-1',
      { expectedRevision: 1, workflowStatusId: 'done', ...change },
      { requestId: key, idempotencyKey: key }, undefined,
    ))

  await expect(update({}, 'complete')).rejects.toBeInstanceOf(WorkItemCompletionGateError)
  const completed = await update({ acceptanceCriteriaMarks: [{ id: openCriterion.id, satisfied: true }] }, 'mark-and-complete')
  expect(completed.workflowStatusId).toBe('done')
})

test('reports the Gate state through the Public API without changing the Work Item', async () => {
  configureFakeProjectClients(true, {
    directoryId: credential.workspaceId,
    role: 'member',
    workspaceRole: 'member',
    detailAssigneeUserId: 'demo@example.com',
    detailWorkflowStatusId: 'in-progress',
    detailStatusCategory: 'started',
    detailAcceptanceCriteria: [openCriterion, metCriterion],
  })
  const workItems = createCanonicalPublicWorkItemService()
  const read = () => runWithTestAppDependencies(() => workItems.getCompletionGate(credential, 'core-team', 'task-1'))

  configureGate(undefined)
  expect(await read()).toMatchObject({ teamId: 'core-team', workItemId: 'task-1', conditions: [], blocksCompletion: false })

  configureGate({ acceptanceCriteria: 'warn', humanApproval: 'required' }, async () => approvals({ approvedCount: 1 }))
  expect(await read()).toMatchObject({
    conditions: [
      { condition: 'acceptance-criteria', requirement: 'warn', state: 'unmet' },
      { condition: 'human-approval', requirement: 'required', state: 'met' },
    ],
    // A `warn` condition never blocks completion.
    blocksCompletion: false,
  })

  configureGate({ noPendingApprovals: 'required' }, async () => { throw new Error('approvals unavailable') })
  expect(await read()).toMatchObject({
    conditions: [{ condition: 'no-pending-approvals', requirement: 'required', state: 'unavailable' }],
    blocksCompletion: true,
  })
})

/**
 * Records the completion Gate override, and the caller authorization checks, each Work Item update
 * commits with.
 *
 * @returns `overrides`: what the persistence fake received, `undefined` for an update without one;
 *   `fencedMembers`: the Workspace member keys whose rows each update conditions on.
 */
function captureGateOverrides() {
  const teamIssues = getTestAppDependencies().workItems.teamIssues
  const overrides: unknown[] = []
  const fencedMembers: string[][] = []
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async getTeamIssueDetail(...args) {
        return teamIssues.getTeamIssueDetail(...args)
      },
      async updateTeamIssue(directoryId, teamId, issueId, input, ...rest) {
        overrides.push(input.completionGateOverridden)
        fencedMembers.push((input.authorizationConditionChecks ?? []).flatMap((check) => {
          const recordKey: unknown = check.ConditionCheck?.Key?.recordKey
          return typeof recordKey === 'string' && recordKey.startsWith('MEMBER#') ? [recordKey] : []
        }))
        return teamIssues.updateTeamIssue(directoryId, teamId, issueId, input, ...rest)
      },
    }),
  })
  return { overrides, fencedMembers }
}

test('lets a manager complete past the Gate with a reason and records the overridden conditions', async () => {
  configureFakeProjectClients(true, { role: 'manager', detailAcceptanceCriteria: [openCriterion] })
  configureGate({ acceptanceCriteria: 'required', humanApproval: 'warn' })
  const { overrides, fencedMembers } = captureGateOverrides()

  const response = await patchWorkItem({
    workflowStatusId: 'done',
    completionGateOverride: { reason: '  Customer accepted the release in the review meeting.  ' },
  })

  expect(response.status).toBe(200)
  // Only the required condition that blocked completion is recorded; the reason is trimmed.
  expect(overrides).toEqual([{
    reason: 'Customer accepted the release in the review meeting.',
    conditions: ['acceptance-criteria'],
  }])
  // The manager roles that allowed the override are fenced, so a revocation before commit fails it.
  expect(fencedMembers).toEqual([[expect.stringMatching(/^MEMBER#/)]])
})

test('fences the approval counts of a required condition that passed when an override completes', async () => {
  const approvalSummaryCheck = {
    ConditionCheck: expect.objectContaining({ Key: expect.objectContaining({ recordKey: 'APPROVAL_SUMMARY' }) }),
  }
  configureFakeProjectClients(true, { role: 'manager', detailAcceptanceCriteria: [openCriterion] })
  configureGate({ acceptanceCriteria: 'required', humanApproval: 'required' }, async () => approvals({ approvedCount: 1 }))
  const passedChecks = captureConfigurationConditionChecks()

  const passed = await patchWorkItem({ workflowStatusId: 'done', completionGateOverride: { reason: 'Accepted in review' } })

  expect(passed.status).toBe(200)
  // Only the criteria are overridden, so the approval that passed must still hold at commit.
  expect(passedChecks).toContainEqual(approvalSummaryCheck)

  resetTestApp()
  configureFakeProjectClients(true, { role: 'manager', detailAcceptanceCriteria: [openCriterion] })
  configureGate({ acceptanceCriteria: 'required', humanApproval: 'required' })
  const overriddenChecks = captureConfigurationConditionChecks()

  const overridden = await patchWorkItem({ workflowStatusId: 'done', completionGateOverride: { reason: 'Accepted in review' } })

  expect(overridden.status).toBe(200)
  // The approval condition itself is overridden and recorded, so its counts are not fenced.
  expect(overriddenChecks).not.toContainEqual(approvalSummaryCheck)
})

test('records no override when the Gate does not block the update', async () => {
  configureFakeProjectClients(true, { role: 'manager', detailAcceptanceCriteria: [metCriterion] })
  configureGate({ acceptanceCriteria: 'required' })
  const { overrides, fencedMembers } = captureGateOverrides()

  const response = await patchWorkItem({ workflowStatusId: 'done', completionGateOverride: { reason: 'Not needed' } })

  expect(response.status).toBe(200)
  expect(overrides).toEqual([undefined])
  expect(fencedMembers).toEqual([[]])
})

test('rejects a Gate override from a member and an override without a reason', async () => {
  configureFakeProjectClients(true, { role: 'member', detailAcceptanceCriteria: [openCriterion] })
  configureGate({ acceptanceCriteria: 'required' })
  const denied = await patchWorkItem({ workflowStatusId: 'done', completionGateOverride: { reason: 'Ship it' } })
  expect(denied.status).toBe(403)

  resetTestApp()
  configureFakeProjectClients(true, { role: 'manager', detailAcceptanceCriteria: [openCriterion] })
  configureGate({ acceptanceCriteria: 'required' })
  for (const completionGateOverride of [{ reason: '   ' }, { reason: 'x'.repeat(1001) }, 'Ship it', { reason: 'Ok', by: 'me' }]) {
    const invalid = await patchWorkItem({ workflowStatusId: 'done', completionGateOverride })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'InvalidWorkItemCompletionGateOverride' })
  }
})

test('never takes a recorded override from the request body', async () => {
  configureFakeProjectClients(true, { role: 'manager', detailAcceptanceCriteria: [openCriterion] })
  configureGate({ acceptanceCriteria: 'required' })

  const response = await patchWorkItem({
    workflowStatusId: 'done',
    completionGateOverridden: { reason: 'Forged', conditions: ['acceptance-criteria'] },
  })

  expect(response.status).toBe(400)
})

test('requires the manager role on both Projects when the override update also moves the Work Item', async () => {
  const projectRoles = {
    detailAssignedProjectId: 'project-a',
    detailAcceptanceCriteria: [openCriterion],
    projectAccesses: [
      { teamId: 'core-team', projectId: 'project-a', role: 'manager' as const },
      { teamId: 'core-team', projectId: 'project-b', role: 'member' as const },
    ],
    teamProjects: [
      { id: 'project-a', name: 'Project A', tone: 'blue' as const },
      { id: 'project-b', name: 'Project B', tone: 'green' as const },
    ],
  }
  configureFakeProjectClients(true, projectRoles)
  configureGate({ acceptanceCriteria: 'required' })
  const moved = await patchWorkItem({
    workflowStatusId: 'done',
    assignedProjectId: 'project-b',
    completionGateOverride: { reason: 'Accepted in review' },
  })
  expect(moved.status).toBe(403)

  resetTestApp()
  configureFakeProjectClients(true, projectRoles)
  configureGate({ acceptanceCriteria: 'required' })
  const stayed = await patchWorkItem({ workflowStatusId: 'done', completionGateOverride: { reason: 'Accepted in review' } })
  expect(stayed.status).toBe(200)
})
