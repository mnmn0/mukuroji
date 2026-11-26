import { createApiTestHarness } from '../test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import type {
  FileVersion,
  ProjectBudgetReport,
  ProjectExpense,
  ProjectExpenseListResponse,
  ProjectExpenseResponse,
} from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../modules/audit'
import type { FileProofingFileLookup, FileProofingScope } from '../../modules/files'
import { InMemoryProjectExpenseStore } from '../../modules/project-budget'

const workspaceId = 'user#demo@example.com'

afterEach(() => {
  resetTestApp()
})

/**
 * Reads the Project of the first fake Work Item.
 *
 * @returns The Project ID.
 */
async function readProjectId(): Promise<string> {
  const { issues } = await getTestAppDependencies().workItems.teamIssues.getTeamIssues(workspaceId, 'core-team')
  const projectId = issues[0]?.assignedProjectId
  if (!projectId) throw new Error('The fake Team has no Project Work Item.')
  return projectId
}

/**
 * Sends an authenticated request.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - JSON body, if any.
 * @param idempotencyKey - Idempotency key header, if any.
 * @returns The response.
 */
function request(path: string, method = 'GET', body?: unknown, idempotencyKey?: string) {
  return app.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * Replaces the file lookup so the named files belong to the given Project scope.
 *
 * @param files - File ID to the Team and Project that own it.
 * @param projectFileIds - Files the consistent Project file list returns while the File ID index
 * has not caught up.
 */
function stubFiles(files: Record<string, { teamId: string; projectId: string }>, projectFileIds: readonly string[] = []) {
  const fileProofing = getTestAppDependencies().workItems.fileProofing
  setTestAppDependencies({
    fileProofing: new Proxy(fileProofing, {
      get(target, property, receiver) {
        if (property === 'list') {
          return async (scope: FileProofingScope) => ({
            scope,
            files: projectFileIds.map((id) => ({ id })),
            approvals: [],
          })
        }
        if (property !== 'findFileById') return Reflect.get(target, property, receiver)
        return async (_workspaceId: string, _actor: unknown, fileId: string): Promise<FileProofingFileLookup | undefined> => {
          const owner = files[fileId]
          if (!owner) return undefined
          const version: FileVersion = {
            id: `${fileId}-v1`,
            number: 1,
            fileName: 'receipt.pdf',
            contentType: 'application/pdf',
            sizeBytes: 10,
            scanStatus: 'available',
            previewKind: 'pdf',
            createdByMemberKey: 'demo@example.com',
            createdAt: '2026-01-06T00:00:00.000Z',
          }
          return {
            file: {
              id: fileId,
              name: 'receipt.pdf',
              targetType: 'project',
              targetId: owner.projectId,
              versionCount: 1,
              versions: [version],
              currentVersion: version,
              createdAt: version.createdAt,
              updatedAt: version.createdAt,
              capabilities: { canDownload: true, canUploadVersion: false, canDelete: false, canAnnotate: false, canRequestApproval: false },
            },
            scope: { workspaceId, teamId: owner.teamId, kind: 'project', projectId: owner.projectId },
          }
        }
      },
    }),
  })
}

test('submits, lists, resubmits, and deletes a Project expense for its manager', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  stubFiles({ 'receipt-1': { teamId: 'core-team', projectId } })
  const path = `/api/teams/core-team/projects/${projectId}/expenses`

  const created = await request(path, 'POST', {
    date: '2026-01-06',
    category: ' 外注費 ',
    amountMinor: 50_000,
    currency: 'JPY',
    receiptFileIds: ['receipt-1'],
  }, 'expense-1')
  expect(created.status).toBe(201)
  const expense = (await created.json() as ProjectExpenseResponse).expense
  expect(expense).toMatchObject({
    teamId: 'core-team',
    projectId,
    category: '外注費',
    amountMinor: 50_000,
    status: 'submitted',
    receiptFileIds: ['receipt-1'],
    revision: 1,
  })

  const retried = await request(path, 'POST', {
    date: '2026-01-06',
    category: ' 外注費 ',
    amountMinor: 50_000,
    currency: 'JPY',
    receiptFileIds: ['receipt-1'],
  }, 'expense-1')
  expect(retried.status).toBe(201)
  expect((await retried.json() as ProjectExpenseResponse).expense.id).toBe(expense.id)

  const listed = await request(path)
  expect(listed.status).toBe(200)
  const list = await listed.json() as ProjectExpenseListResponse
  expect(list.expenses.map((item) => item.id)).toEqual([expense.id])
  expect(list.viewerMemberId).toBe(expense.submittedByMemberId)

  const updated = await request(`${path}/${expense.id}`, 'PUT', {
    date: '2026-01-07',
    category: 'License',
    amountMinor: 40_000,
    currency: 'JPY',
    expectedRevision: 1,
  }, 'expense-1-update')
  expect(updated.status).toBe(200)
  expect((await updated.json() as ProjectExpenseResponse).expense).toMatchObject({ revision: 2, receiptFileIds: [], status: 'submitted' })

  const stale = await request(`${path}/${expense.id}`, 'DELETE', { expectedRevision: 1 }, 'expense-1-delete-stale')
  expect(stale.status).toBe(409)
  const deleted = await request(`${path}/${expense.id}`, 'DELETE', { expectedRevision: 2 }, 'expense-1-delete')
  expect(deleted.status).toBe(204)
  // A retry of the removal after a lost response succeeds again; another request finds nothing.
  expect((await request(`${path}/${expense.id}`, 'DELETE', { expectedRevision: 2 }, 'expense-1-delete')).status).toBe(204)
  expect((await request(`${path}/${expense.id}`, 'DELETE', { expectedRevision: 2 }, 'expense-1-delete-again')).status).toBe(404)
  // A late retry of the original creation does not bring the removed expense back.
  const recreated = await request(path, 'POST', {
    date: '2026-01-06',
    category: ' 外注費 ',
    amountMinor: 50_000,
    currency: 'JPY',
    receiptFileIds: ['receipt-1'],
  }, 'expense-1')
  expect(recreated.status).toBe(409)
  expect(await recreated.json()).toMatchObject({ code: 'ProjectExpenseDeleted' })
  expect((await request(`${path}/${expense.id}`, 'DELETE', { expectedRevision: 2 }, 'expense-1-delete')).status).toBe(204)
  expect((await (await request(path)).json() as ProjectExpenseListResponse).expenses).toEqual([])
})

test('refuses a receipt or a Work Item of another Project and an invalid amount', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  stubFiles({ 'other-receipt': { teamId: 'other-team', projectId } })
  const path = `/api/teams/core-team/projects/${projectId}/expenses`
  const base = { date: '2026-01-06', category: '外注費', amountMinor: 1_000, currency: 'JPY' }

  const foreignReceipt = await request(path, 'POST', { ...base, receiptFileIds: ['other-receipt'] }, 'bad-1')
  expect(foreignReceipt.status).toBe(400)
  const missingReceipt = await request(path, 'POST', { ...base, receiptFileIds: ['missing'] }, 'bad-2')
  expect(missingReceipt.status).toBe(400)
  // A receipt the File ID index does not show yet is found in the Project's own file list.
  stubFiles({}, ['fresh-receipt'])
  const freshReceipt = await request(path, 'POST', { ...base, receiptFileIds: ['fresh-receipt'] }, 'fresh-1')
  expect(freshReceipt.status).toBe(201)
  stubFiles({ 'other-receipt': { teamId: 'other-team', projectId } })
  const missingWorkItem = await request(path, 'POST', { ...base, workItemId: 'wireframe' }, 'bad-3')
  expect(missingWorkItem.status).toBe(400)
  const { issues } = await getTestAppDependencies().workItems.teamIssues.getTeamIssues(workspaceId, 'core-team')
  const sameProject = issues.find((issue) => issue.assignedProjectId === projectId)
  if (!sameProject) throw new Error('The fake Project has no Work Item.')
  const linked = await request(path, 'POST', { ...base, workItemId: sameProject.id }, 'good-1')
  expect(linked.status).toBe(201)
  expect((await linked.json() as ProjectExpenseResponse).expense.workItemId).toBe(sameProject.id)
  const zero = await request(path, 'POST', { ...base, amountMinor: 0 }, 'bad-4')
  expect(zero.status).toBe(400)
  const fraction = await request(path, 'POST', { ...base, amountMinor: 1.5 }, 'bad-5')
  expect(fraction.status).toBe(400)
})

test('lets another manager approve an expense, which then counts toward the budget report and stays fixed', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const store = new InMemoryProjectExpenseStore()
  setTestAppDependencies({ projectExpenses: store })
  const now = '2026-01-06T00:00:00.000Z'
  const submitted: ProjectExpense = {
    id: 'expense-by-other',
    teamId: 'core-team',
    projectId,
    date: '2026-01-06',
    category: '外注費',
    amountMinor: 30_000,
    currency: 'JPY',
    receiptFileIds: [],
    status: 'submitted',
    submittedByMemberId: 'other-manager@example.com',
    submittedAt: now,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  await store.create({
    workspaceId,
    teamId: 'core-team',
    projectId,
    now,
    callerAuthorization: [{ ConditionCheck: { TableName: 't', Key: {}, ConditionExpression: 'attribute_exists(a)' } }],
    auditContext: createMutationAuditContext({
      workspaceId,
      actor: { id: 'other-manager', kind: 'user', displayName: 'Other manager' },
      idempotencyKey: 'seed',
      request: { method: 'POST', path: '/seed', body: {} },
      source: { kind: 'api' },
    }),
    expense: submitted,
    creationFingerprint: 'seed',
  })
  await getTestAppDependencies().timeTracking.timeTrackingService.saveBudget({
    workspaceId,
    teamId: 'core-team',
    scopeType: 'project',
    scopeId: projectId,
    amountMinor: 100_000,
    currency: 'JPY',
    expectedRevision: 0,
    updatedBy: 'manager',
  })
  const path = `/api/teams/core-team/projects/${projectId}/expenses`

  const approved = await request(`${path}/${submitted.id}/decision`, 'POST', { outcome: 'approved', expectedRevision: 1 }, 'decide-1')
  expect(approved.status).toBe(200)
  const decided = (await approved.json() as ProjectExpenseResponse).expense
  expect(decided).toMatchObject({ status: 'approved', revision: 2, decision: { outcome: 'approved' } })

  const replayed = await request(`${path}/${submitted.id}/decision`, 'POST', { outcome: 'approved', expectedRevision: 1 }, 'decide-1')
  expect(replayed.status).toBe(200)
  const again = await request(`${path}/${submitted.id}/decision`, 'POST', { outcome: 'rejected', expectedRevision: 2 }, 'decide-2')
  expect(again.status).toBe(409)
  const edit = await request(`${path}/${submitted.id}`, 'PUT', { ...submitted, expectedRevision: 2 }, 'edit-approved')
  expect(edit.status).toBe(409)
  const remove = await request(`${path}/${submitted.id}`, 'DELETE', { expectedRevision: 2 }, 'delete-approved')
  expect(remove.status).toBe(409)

  const report = await request(`/api/teams/core-team/projects/${projectId}/budget-report?from=2026-01-05&to=2026-01-08&timeZone=Asia/Tokyo`)
  expect(report.status).toBe(200)
  const body = await report.json() as ProjectBudgetReport
  expect(body.approvedExpenseByCurrency).toEqual({ JPY: 30_000 })
  expect(body.budgetConsumedPercent).toBe(30)
})

test('refuses a decision by the manager who submitted the expense', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const path = `/api/teams/core-team/projects/${projectId}/expenses`
  const created = await request(path, 'POST', { date: '2026-01-06', category: '外注費', amountMinor: 1_000, currency: 'JPY' }, 'own-1')
  const expense = (await created.json() as ProjectExpenseResponse).expense

  const decision = await request(`${path}/${expense.id}/decision`, 'POST', { outcome: 'approved', expectedRevision: 1 }, 'own-decision')
  expect(decision.status).toBe(403)
  expect(await decision.json()).toMatchObject({ code: 'ProjectExpenseSelfDecisionForbidden' })
})

test('hides expenses of a Project outside the Team', async () => {
  configureFakeProjectClients(true)
  const response = await request('/api/teams/core-team/projects/no-such-project/expenses')
  expect(response.status).toBe(404)
})
