import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { describe, expect, spyOn, test } from 'bun:test'
import { TRIAGE_ENTRY_SCHEMA_VERSION, type TriageEntry } from '@mukuroji/contracts'
import { createTriageCapabilities } from '../../domain/triage-entry'
import { createTriageInputFingerprint } from '../../triage'
import {
  createTriageEntryTransactionItems,
} from '../../adapter-out/dynamodb/triage-transactions'
import { runTriageSchedule } from './triage-schedule'

/** Stable schedule test instant. */
const NOW = '2026-08-09T00:00:00.000Z'

/** Checks whether a captured SDK value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Creates a due snoozed entry fixture. */
function createEntry(): TriageEntry {
  const permission = {
    visibility: 'full',
    canReply: true,
    guestVisible: false,
    checkedAt: NOW,
  } satisfies TriageEntry['permission']
  return {
    schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
    id: 'triage-1',
    workspaceId: 'workspace-1',
    source: { kind: 'webhook', sourceId: 'event-1', connectorId: 'connector-1' },
    sourcePreview: {
      title: 'Webhook alert',
      body: 'Service unavailable.',
      attachmentCount: 0,
      commentCount: 0,
      watcherCount: 0,
      sanitized: true,
      truncated: false,
    },
    requester: { displayName: 'Monitoring', guest: false },
    receivedAt: NOW,
    lastActivityAt: NOW,
    state: 'snoozed',
    snoozedUntil: '2026-08-09T00:10:00.000Z',
    routing: {
      reason: 'Monitoring alert.',
      candidates: [{ teamId: 'platform', reason: 'Connector route.', permitted: true }],
    },
    teamId: 'platform',
    permission,
    retention: { expiresAt: '2027-08-09T00:00:00.000Z' },
    capabilities: createTriageCapabilities({ state: 'snoozed', permission }),
    events: [{
      id: 'created-1',
      type: 'created',
      actorId: 'system:webhook',
      summary: 'Entry created.',
      createdAt: NOW,
    }],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/** Creates a real SDK client with a deterministic send script. */
function createHarness(
  respond: (commandName: string, input: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  const lowLevelClient = new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })
  const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
  const calls: string[] = []
  const inputs: Record<string, unknown>[] = []
  const sendSpy = spyOn(documentClient, 'send')
  sendSpy.mockImplementation(async (command) => {
    const constructorValue = Reflect.get(command, 'constructor')
    if (typeof constructorValue !== 'function' || typeof constructorValue.name !== 'string') {
      throw new TypeError('Expected an AWS command.')
    }
    const input = Reflect.get(command, 'input')
    if (!isRecord(input)) throw new TypeError('Expected an AWS command input.')
    calls.push(constructorValue.name)
    inputs.push(input)
    return await respond(constructorValue.name, input)
  })
  return { documentClient, calls, inputs, restore: () => sendSpy.mockRestore() }
}

describe('triage schedule adapter', () => {
  test('strongly reads KEYS_ONLY candidates and conditionally resurfaces due entries', async () => {
    const entry = createEntry()
    const storedItem = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: entry.source.sourceId }),
    })[0]?.Put?.Item
    if (!storedItem) throw new TypeError('Expected a stored triage entry fixture.')
    const harness = createHarness((commandName) => {
      if (commandName === 'QueryCommand') {
        return { Items: [{ scopeKey: 'WORKSPACE#workspace-1', recordKey: 'TRIAGE#triage-1' }] }
      }
      if (commandName === 'GetCommand') return { Item: storedItem }
      return {}
    })

    try {
      const result = await runTriageSchedule({
        documentClient: harness.documentClient,
        tableName: 'RequestIntakeTable',
        auditTableName: 'AuditEventsTable',
        auditRetentionDays: 365,
        wakeIndexName: 'triage-wake-index',
        wakeShardCount: 8,
        batchSize: 1,
        now: '2026-08-09T00:10:00.000Z',
      })

      expect(result).toMatchObject({
        disabled: false,
        evaluatedCandidates: 1,
        resurfacedEntries: 1,
        conflicts: 0,
      })
      expect(harness.calls).toEqual(['QueryCommand', 'GetCommand', 'TransactWriteCommand'])
    } finally {
      harness.restore()
    }
  })

  test('disables safely instead of scanning while the wake index is unavailable', async () => {
    const harness = createHarness(() => {
      const error = new Error('The table does not have the specified index.')
      error.name = 'ValidationException'
      throw error
    })

    try {
      await expect(runTriageSchedule({
        documentClient: harness.documentClient,
        tableName: 'RequestIntakeTable',
        auditTableName: 'AuditEventsTable',
        auditRetentionDays: 365,
        wakeIndexName: 'triage-wake-index',
        wakeShardCount: 8,
        batchSize: 100,
        now: '2026-08-09T00:10:00.000Z',
      })).resolves.toMatchObject({ disabled: true, evaluatedCandidates: 0 })
      expect(harness.calls).toEqual(['QueryCommand'])
    } finally {
      harness.restore()
    }
  })

  test('atomically appends SLA and escalation audit outbox events with deep-link recipients', async () => {
    const entry = createEntry()
    entry.state = 'pending'
    delete entry.snoozedUntil
    entry.ownerUserId = 'triager@example.com'
    entry.sla = {
      policyId: 'support-sla',
      dueAt: '2026-08-09T00:05:00.000Z',
      escalationDueAt: '2026-08-09T00:09:00.000Z',
    }
    entry.capabilities = createTriageCapabilities(entry)
    const storedItem = createTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: createTriageInputFingerprint({ sourceId: entry.source.sourceId }),
    })[0]?.Put?.Item
    if (!storedItem) throw new TypeError('Expected a stored triage entry fixture.')
    const harness = createHarness((commandName, input) => {
      if (commandName === 'QueryCommand') {
        return { Items: [{ scopeKey: 'WORKSPACE#workspace-1', recordKey: 'TRIAGE#triage-1' }] }
      }
      if (commandName === 'GetCommand') {
        const key = isRecord(input.Key) ? input.Key : {}
        if (key.recordKey === 'TRIAGE_CONFIG#TEAM#platform') {
          return {
            Item: {
              entryType: 'triage-configuration',
              configuration: {
                workspaceId: 'workspace-1',
                teamId: 'platform',
                slaPolicies: [{
                  id: 'support-sla',
                  escalationOwnerUserId: 'incident-manager@example.com',
                }],
              },
            },
          }
        }
        return { Item: storedItem }
      }
      return {}
    })

    try {
      const result = await runTriageSchedule({
        documentClient: harness.documentClient,
        tableName: 'RequestIntakeTable',
        auditTableName: 'AuditEventsTable',
        auditRetentionDays: 365,
        wakeIndexName: 'triage-wake-index',
        wakeShardCount: 8,
        batchSize: 1,
        now: '2026-08-09T00:10:00.000Z',
      })

      expect(result).toMatchObject({ breachedEntries: 1, escalatedEntries: 1, conflicts: 0 })
      expect(harness.calls).toEqual([
        'QueryCommand',
        'GetCommand',
        'GetCommand',
        'TransactWriteCommand',
      ])
      const transactionInput = harness.inputs.at(-1)
      const transactItems = transactionInput?.TransactItems
      if (!Array.isArray(transactItems)) throw new TypeError('Expected transaction items.')
      const auditEvents = transactItems.flatMap((item) => {
        if (!isRecord(item) || !isRecord(item.Put) || item.Put.TableName !== 'AuditEventsTable') {
          return []
        }
        return isRecord(item.Put.Item) ? [item.Put.Item] : []
      })
      expect(auditEvents).toHaveLength(2)
      expect(auditEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventType: 'triage.sla-breached',
          outboxStatus: 'pending',
          metadata: expect.objectContaining({
            triageEntryId: 'triage-1',
            deepLink: '/teams/platform/triage?entryId=triage-1',
            notificationCandidates: [{
              memberKey: 'triager@example.com',
              reason: 'triage-sla',
            }],
          }),
        }),
        expect.objectContaining({
          eventType: 'triage.escalated',
          outboxStatus: 'pending',
          metadata: expect.objectContaining({
            triageEntryId: 'triage-1',
            deepLink: '/teams/platform/triage?entryId=triage-1',
            notificationCandidates: [{
              memberKey: 'incident-manager@example.com',
              reason: 'triage-escalation',
            }],
          }),
        }),
      ]))
    } finally {
      harness.restore()
    }
  })
})
