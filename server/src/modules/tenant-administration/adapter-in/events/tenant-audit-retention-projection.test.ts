import { expect, test } from 'bun:test'
import {
  processTenantAuditRetentionProjectionBatch,
  readTenantAuditRetentionEvent,
} from './tenant-audit-retention-projection'

/** Creates one AuditEvents stream record. */
function auditRecord(
  sequenceNumber: string,
  eventId: string,
  eventName = 'INSERT',
) {
  return {
    eventName,
    dynamodb: {
      SequenceNumber: sequenceNumber,
      NewImage: {
        schemaVersion: { N: '1' },
        directoryId: { S: 'workspace-1' },
        workspaceId: { S: 'workspace-1' },
        eventId: { S: eventId },
        occurredAt: { S: '2026-08-02T00:00:00.000Z' },
      },
    },
  }
}

test('applies tenant retention to newly inserted audit events', async () => {
  const reconciled: string[] = []
  const record = auditRecord('audit-sequence-1', 'event-1')
  const result = await processTenantAuditRetentionProjectionBatch({
    Records: [record, auditRecord('audit-sequence-2', 'event-2', 'MODIFY')],
  }, {
    async reconcileAuditEventRetention(workspaceId, eventId, occurredAt) {
      reconciled.push(`${workspaceId}/${eventId}/${occurredAt}`)
    },
  })

  expect(readTenantAuditRetentionEvent(record)).toEqual({
    workspaceId: 'workspace-1',
    eventId: 'event-1',
    occurredAt: '2026-08-02T00:00:00.000Z',
  })
  expect(result).toEqual({ batchItemFailures: [] })
  expect(reconciled).toEqual(['workspace-1/event-1/2026-08-02T00:00:00.000Z'])
})

test('ignores stream records that are not audit events', async () => {
  let calls = 0
  const result = await processTenantAuditRetentionProjectionBatch({
    Records: [{
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: 'other-1',
        NewImage: { recordKey: { S: 'SOMETHING' } },
      },
    }],
  }, {
    async reconcileAuditEventRetention() {
      calls += 1
    },
  })

  expect(result).toEqual({ batchItemFailures: [] })
  expect(calls).toBe(0)
})

test('stops at the first failure and returns its stream checkpoint', async () => {
  const reconciled: string[] = []
  const result = await processTenantAuditRetentionProjectionBatch({
    Records: [
      auditRecord('audit-sequence-1', 'event-1'),
      auditRecord('audit-sequence-2', 'event-2'),
      auditRecord('audit-sequence-3', 'event-3'),
    ],
  }, {
    async reconcileAuditEventRetention(_workspaceId, eventId) {
      if (eventId === 'event-2') throw new Error('conflict')
      reconciled.push(eventId)
    },
  })

  expect(result).toEqual({
    batchItemFailures: [{ itemIdentifier: 'audit-sequence-2' }],
  })
  expect(reconciled).toEqual(['event-1'])
})

test('fails closed on a missing or unknown audit schema version', async () => {
  const unknown = auditRecord('audit-sequence-1', 'event-1')
  unknown.dynamodb.NewImage.schemaVersion = { N: '2' }
  const missing = auditRecord('audit-sequence-2', 'event-2')
  const { schemaVersion: _omitted, ...withoutVersion } = missing.dynamodb.NewImage
  const reconciled: string[] = []
  const reconciler = {
    async reconcileAuditEventRetention(_workspaceId: string, eventId: string) {
      reconciled.push(eventId)
    },
  }

  expect(await processTenantAuditRetentionProjectionBatch({ Records: [unknown] }, reconciler))
    .toEqual({ batchItemFailures: [{ itemIdentifier: 'audit-sequence-1' }] })
  expect(await processTenantAuditRetentionProjectionBatch({
    Records: [{ ...missing, dynamodb: { ...missing.dynamodb, NewImage: withoutVersion } }],
  }, reconciler)).toEqual({ batchItemFailures: [{ itemIdentifier: 'audit-sequence-2' }] })
  expect(reconciled).toEqual([])
})

test('fails closed on a malformed audit event', async () => {
  const record = auditRecord('audit-sequence-1', ' ')
  expect(() => readTenantAuditRetentionEvent(record)).toThrow()
  const result = await processTenantAuditRetentionProjectionBatch({
    Records: [record],
  }, {
    async reconcileAuditEventRetention() {},
  })
  expect(result).toEqual({
    batchItemFailures: [{ itemIdentifier: 'audit-sequence-1' }],
  })
})
