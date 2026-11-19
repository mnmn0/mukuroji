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
  createTestWorkItemConfiguration,
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

test('allows completion once an approval is approved and none is pending', async () => {
  configureFakeProjectClients(true)
  configureGate(
    { noPendingApprovals: 'required', humanApproval: 'required' },
    async () => approvals({ approvedCount: 1, rejectedCount: 1 }),
  )

  expect((await patchWorkItem({ workflowStatusId: 'done' })).status).toBe(200)
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
  expect(await response.json()).toMatchObject({ code: 'WorkItemCompletionGateNotSatisfied' })
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
  expect(resolved).toEqual([expect.objectContaining({ statusCategory: 'completed' })])
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
