import type { ProjectRaidEntry, ProjectRaidEntryResponse } from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../audit'
import { ProjectDataError } from '../directory'
import { InMemoryProjectRaidLogStore } from './adapter-out/dynamodb/project-raid-log-store'
import {
  decideProjectRaidChangeRequestUseCase,
  holdProjectRaidChangeRequestUseCase,
  updateProjectRaidEntryUseCase,
} from './application/project-raid-log-use-cases'

/** Scope shared by every test. */
const scope = { workspaceId: 'w', teamId: 't', projectId: 'p' }

/** Caller fence included in every write. */
const callerAuthorization = [{ ConditionCheck: { TableName: 'access', Key: { k: 'v' }, ConditionExpression: 'attribute_exists(k)' } }]

/** Audit context of the writes. */
const auditContext = createMutationAuditContext({
  workspaceId: 'w',
  actor: { id: 'u', kind: 'user', displayName: 'U' },
  idempotencyKey: 'key',
  request: { method: 'POST', path: '/x', body: {} },
  source: { kind: 'api' },
})

/** Time the change request is held. */
const heldAt = '2026-11-20T00:00:00.000Z'

/**
 * Builds a store holding one open change request at revision 1.
 *
 * @returns The store.
 */
async function storeWithChangeRequest() {
  const store = new InMemoryProjectRaidLogStore()
  const entry: ProjectRaidEntry = {
    id: 'cr',
    kind: 'change-request',
    title: 'Move the launch',
    impact: 3,
    status: 'open',
    revision: 1,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
  }
  await store.create({ ...scope, now: entry.createdAt, callerAuthorization, auditContext, entry, creationFingerprint: 'f' })
  return store
}

/**
 * Builds the mutation context of one request by a member at a time.
 *
 * @param memberId - Member key of the caller.
 * @param now - Request time.
 * @param key - Request key, which also names its receipt.
 * @returns The shared mutation fields.
 */
function mutationOf(memberId: string, now: string, key: string) {
  return { now, callerAuthorization, auditContext, updateReceipt: `${key}-receipt`, updateKey: key, memberId }
}

/**
 * Holds the change request for a member.
 *
 * @param store - Store with the change request.
 * @param memberId - Member about to approve.
 * @param expectedRevision - Revision the member read.
 * @param now - Request time.
 * @param key - Request key.
 * @returns The response.
 */
function hold(store: InMemoryProjectRaidLogStore, memberId: string, expectedRevision: number, now: string, key: string) {
  return holdProjectRaidChangeRequestUseCase(store, scope, 'cr', { expectedRevision }, {
    ...mutationOf(memberId, now, key),
    holderMemberId: memberId,
  })
}

/**
 * Decides the change request as a member.
 *
 * @param store - Store with the change request.
 * @param memberId - Member deciding.
 * @param body - Decision body.
 * @param now - Request time.
 * @param key - Request key.
 * @returns The response.
 */
function decide(store: InMemoryProjectRaidLogStore, memberId: string, body: Record<string, unknown>, now: string, key: string) {
  return decideProjectRaidChangeRequestUseCase(store, scope, 'cr', body, {
    ...mutationOf(memberId, now, key),
    deciderMemberId: memberId,
    verifyBaseline: async () => [],
  })
}

/**
 * Edits the change request title as a member.
 *
 * @param store - Store with the change request.
 * @param memberId - Member editing.
 * @param expectedRevision - Revision the member read.
 * @param now - Request time.
 * @param key - Request key.
 * @returns The response.
 */
function edit(store: InMemoryProjectRaidLogStore, memberId: string, expectedRevision: number, now: string, key: string) {
  return updateProjectRaidEntryUseCase(store, scope, 'cr', {
    expectedRevision,
    entry: { kind: 'change-request', title: 'Move the launch later', impact: 3, status: 'open' },
  }, {
    ...mutationOf(memberId, now, key),
    editorMemberId: memberId,
    verifyReferences: async () => [],
  })
}

/**
 * Reads the error code of a rejected request.
 *
 * @param pending - Request that should fail.
 * @returns The status and code of the error.
 */
async function failure(pending: Promise<ProjectRaidEntryResponse>) {
  const error = await pending.then(() => undefined, (reason: unknown) => reason)
  if (!(error instanceof ProjectDataError)) throw new Error('Expected a ProjectDataError.')
  return { status: error.status, code: error.code }
}

test('refuses an approval without the approving member hold', async () => {
  const store = await storeWithChangeRequest()
  expect(await failure(decide(store, 'a@example.com', { expectedRevision: 1, outcome: 'approved' }, heldAt, 'd1')))
    .toEqual({ status: 409, code: 'ProjectRaidApprovalHoldRequired' })
  await hold(store, 'b@example.com', 1, heldAt, 'h1')
  expect(await failure(decide(store, 'a@example.com', { expectedRevision: 2, outcome: 'approved' }, heldAt, 'd2')))
    .toEqual({ status: 409, code: 'ProjectRaidApprovalHoldRequired' })
})

test('keeps another member from rejecting or editing while the hold is active', async () => {
  const store = await storeWithChangeRequest()
  const held = (await hold(store, 'a@example.com', 1, heldAt, 'h1')).entry
  expect(held).toMatchObject({
    revision: 2,
    approvalHold: { heldByMemberId: 'a@example.com', heldAt, expiresAt: '2026-11-20T00:10:00.000Z' },
  })
  const during = '2026-11-20T00:05:00.000Z'
  expect(await failure(decide(store, 'b@example.com', { expectedRevision: 2, outcome: 'rejected' }, during, 'd1')))
    .toEqual({ status: 409, code: 'ProjectRaidChangeRequestHeld' })
  expect(await failure(edit(store, 'b@example.com', 2, during, 'e1')))
    .toEqual({ status: 409, code: 'ProjectRaidChangeRequestHeld' })
  expect(await failure(hold(store, 'b@example.com', 2, during, 'h2')))
    .toEqual({ status: 409, code: 'ProjectRaidChangeRequestHeld' })

  const approved = (await decide(store, 'a@example.com', { expectedRevision: 2, outcome: 'approved' }, during, 'd2')).entry
  expect(approved).toMatchObject({ status: 'closed', revision: 3, decision: { outcome: 'approved', decidedByMemberId: 'a@example.com' } })
  expect(approved.approvalHold).toBeUndefined()
})

test('lets the holder renew, and others act once the hold expires', async () => {
  const store = await storeWithChangeRequest()
  await hold(store, 'a@example.com', 1, heldAt, 'h1')
  const renewed = (await hold(store, 'a@example.com', 2, '2026-11-20T00:04:00.000Z', 'h2')).entry
  expect(renewed).toMatchObject({ revision: 3, approvalHold: { expiresAt: '2026-11-20T00:14:00.000Z' } })
  // A retried hold request returns the hold it already took.
  expect((await hold(store, 'a@example.com', 2, '2026-11-20T00:05:00.000Z', 'h2')).entry).toEqual(renewed)

  const later = '2026-11-20T00:20:00.000Z'
  const edited = (await edit(store, 'b@example.com', 3, later, 'e1')).entry
  expect(edited).toMatchObject({ revision: 4, title: 'Move the launch later' })
  expect(edited.approvalHold).toBeUndefined()
  // The edit dropped the hold, so the first member can no longer approve without holding again.
  expect(await failure(decide(store, 'a@example.com', { expectedRevision: 4, outcome: 'approved' }, later, 'd1')))
    .toEqual({ status: 409, code: 'ProjectRaidApprovalHoldRequired' })
  const rejected = (await decide(store, 'b@example.com', { expectedRevision: 4, outcome: 'rejected' }, later, 'd2')).entry
  expect(rejected).toMatchObject({ status: 'closed', decision: { outcome: 'rejected' } })
  expect(await failure(hold(store, 'a@example.com', 5, later, 'h3')))
    .toEqual({ status: 409, code: 'ProjectRaidChangeRequestDecided' })
})
