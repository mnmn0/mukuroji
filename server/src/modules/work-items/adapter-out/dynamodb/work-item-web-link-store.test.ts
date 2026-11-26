import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import { DynamoDbWorkItemWebLinkStore, type WriteWorkItemWebLinksInput } from './work-item-web-link-store'

/** Audit context of the writes. */
const auditContext = createMutationAuditContext({
  workspaceId: 'w',
  actor: { id: 'member', kind: 'user', displayName: 'Member' },
  idempotencyKey: 'key',
  request: { method: 'POST', path: '/x', body: {} },
  source: { kind: 'api' },
})

/** Link saved by the writes. */
const link = {
  id: 'a'.repeat(32),
  url: 'https://docs.example.com/share/secret-token?x=1',
  title: 'Design',
  createdByMemberId: 'member',
  createdAt: '2026-11-26T00:00:00.000Z',
}

/**
 * Builds a write input.
 *
 * @param overrides - Fields that differ from the first link of a Work Item.
 * @returns The input.
 */
function writeInput(overrides: Partial<WriteWorkItemWebLinksInput> = {}): WriteWorkItemWebLinksInput {
  return {
    workspaceId: 'w',
    teamId: 't',
    workItemId: 'i',
    workItemCreatedAt: '2026-11-01T00:00:00.000Z',
    expectedRevision: 0,
    links: [link],
    change: { kind: 'added', link },
    writtenAt: '2026-11-26T00:00:00.000Z',
    conditionChecks: [{ ConditionCheck: { TableName: 'issues', Key: { k: 'v' }, ConditionExpression: 'revision = :r' } }],
    auditContext,
    ...overrides,
  }
}

/**
 * Builds a document client that records the commands it receives.
 *
 * @param respond - Answers each command, or throws.
 * @returns The fake client and the received command inputs.
 */
function fakeClient(respond: (name: string, input: unknown) => unknown) {
  const sent: { name: string, input: unknown }[] = []
  const client: DynamoDBDocumentClient = Object.assign(Object.create(null), {
    async send(command: { constructor: { name: string }, input: unknown }) {
      sent.push({ name: command.constructor.name, input: command.input })
      return respond(command.constructor.name, command.input)
    },
  })
  return { client, sent }
}

test('writes the links with a revision check, the condition checks, and a host-only audit event', async () => {
  const { client, sent } = fakeClient(() => ({}))
  const store = new DynamoDbWorkItemWebLinkStore('planning', client, 'audit')

  const state = await store.write(writeInput())
  await store.write(writeInput({ expectedRevision: 1, links: [], change: { kind: 'removed', link } }))

  expect(state).toEqual({ revision: 1, workItemCreatedAt: '2026-11-01T00:00:00.000Z', links: [link] })
  const first = JSON.stringify(sent[0]?.input)
  const second = JSON.stringify(sent[1]?.input)
  expect(first).toContain('attribute_not_exists(recordKey)')
  expect(first).toContain('WORK_ITEM_WEB_LINKS#t#i')
  expect(first).toContain('"TableName":"issues"')
  expect(first).toContain('work-item.web-link-added')
  expect(first).toContain('"host":"docs.example.com"')
  // The audit event never copies the full URL or the title; only the link row holds them.
  expect(first.split('secret-token').length).toBe(2)
  expect(second).toContain('#revision = :revision')
  expect(second).toContain('work-item.web-link-removed')
})

test('refuses a write without condition checks and a list over the limit', async () => {
  const { client, sent } = fakeClient(() => ({}))
  const store = new DynamoDbWorkItemWebLinkStore('planning', client)

  await expect(store.write(writeInput({ conditionChecks: [] }))).rejects.toMatchObject({ status: 503 })
  const many = Array.from({ length: 51 }, (_, index) => ({ ...link, id: index.toString(16).padStart(32, '0'), url: `https://example.com/${index}` }))
  await expect(store.write(writeInput({ links: many }))).rejects.toMatchObject({ code: 'WorkItemWebLinkLimitExceeded' })
  expect(sent).toEqual([])
})

test('maps a failed condition to a conflict and throttling to a retryable failure', async () => {
  const cancelled = (codes: string[]) => Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  })
  const conflict = new DynamoDbWorkItemWebLinkStore('planning', fakeClient(() => { throw cancelled(['None', 'ConditionalCheckFailed']) }).client)
  const throttled = new DynamoDbWorkItemWebLinkStore('planning', fakeClient(() => { throw cancelled(['ThrottlingError', 'None']) }).client)
  const broken = new DynamoDbWorkItemWebLinkStore('planning', fakeClient(() => { throw new Error('boom') }).client)

  await expect(conflict.write(writeInput())).rejects.toMatchObject({ status: 409, code: 'WorkItemWebLinkConflict' })
  await expect(throttled.write(writeInput())).rejects.toMatchObject({ status: 503, code: 'WorkItemWebLinkRetryable' })
  await expect(broken.write(writeInput())).rejects.toMatchObject({ status: 502, code: 'WorkItemWebLinkStorageFailure' })
})

test('reads a stored row and rejects one whose link is not a safe URL', async () => {
  const row = {
    workspaceId: 'w', recordKey: 'WORK_ITEM_WEB_LINKS#t#i', entryType: 'work-item-web-links', schemaVersion: 1,
    revision: 2, workItemCreatedAt: '2026-11-01T00:00:00.000Z', links: [link],
  }
  const good = new DynamoDbWorkItemWebLinkStore('planning', fakeClient(() => ({ Item: row })).client)
  const empty = new DynamoDbWorkItemWebLinkStore('planning', fakeClient(() => ({})).client)
  const corrupt = new DynamoDbWorkItemWebLinkStore('planning', fakeClient(() => ({
    Item: { ...row, links: [{ ...link, url: 'javascript:alert(1)' }] },
  })).client)

  expect(await good.get('w', 't', 'i')).toEqual({ revision: 2, workItemCreatedAt: '2026-11-01T00:00:00.000Z', links: [link] })
  expect(await empty.get('w', 't', 'i')).toBeNull()
  await expect(corrupt.get('w', 't', 'i')).rejects.toMatchObject({ status: 502 })
})
