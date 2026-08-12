import { describe, expect, test } from 'bun:test'
import { TRIAGE_ENTRY_SCHEMA_VERSION, type TriageEntry } from '@mukuroji/contracts'
import { createMutationAuditContext } from '../../../audit'
import { createTriageCapabilities, redactExpiredTriageEntry } from '../../domain/triage-entry'
import {
  createTriageActionAuditIdempotencyKey,
  createTriageInputFingerprint,
} from '../../triage'
import {
  createFormTriageEntryTransactionItems,
  createTriageAcceptanceTransactionItems,
  createTriageActionTransactionItems,
  createTriageEntryKey,
  createTriageSourceActivityTransactionItems,
  createTriageSourceClaimKey,
  decodeTriageEntryRow,
} from './triage-transactions'

/** Stable transaction test instant. */
const NOW = '2026-08-09T00:00:00.000Z'

/** Creates a complete form-source entry fixture. */
function createEntry(): TriageEntry {
  const permission = {
    visibility: 'full',
    canReply: true,
    guestVisible: false,
    checkedAt: NOW,
  } satisfies TriageEntry['permission']
  return {
    schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
    id: 'triage-form-1',
    workspaceId: 'workspace-1',
    source: {
      kind: 'form',
      sourceId: 'submission-1',
      formId: 'form-1',
      submissionId: 'submission-1',
    },
    sourcePreview: {
      title: 'Access request',
      body: 'Please grant access.',
      attachmentCount: 1,
      commentCount: 1,
      watcherCount: 1,
      sanitized: true,
      truncated: false,
    },
    requester: { displayName: 'Requester', guest: false },
    receivedAt: NOW,
    lastActivityAt: NOW,
    state: 'pending',
    routing: {
      reason: 'Matched access form.',
      candidates: [{ teamId: 'support', reason: 'Form default.', permitted: true }],
    },
    teamId: 'support',
    permission,
    retention: { expiresAt: '2027-08-09T00:00:00.000Z' },
    capabilities: createTriageCapabilities({ state: 'pending', permission }),
    events: [{
      id: 'created-1',
      type: 'created',
      actorId: 'system:intake',
      summary: 'Entry created.',
      createdAt: NOW,
    }],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/** Creates a stable request-derived audit context for one transaction test.
 *
 * @param body Semantic HTTP request body captured by the adapter.
 * @param path Actual HTTP request path.
 * @param idempotencyKey Target-specific replay key.
 * @param correlationId Correlation ID shared by the logical API request.
 * @param receiptFingerprint Fingerprint binding the receipt to target and semantic input.
 * @param entryId Stable target Entry used by the audit idempotency namespace.
 * @returns Immutable mutation context supplied to the Triage transaction builder.
 */
function createAssignmentAuditContext(
  body: unknown,
  path = '/api/teams/support/triage-entries/triage-form-1/actions',
  idempotencyKey = 'assign-1',
  correlationId = 'correlation-assign-1',
  receiptFingerprint = createTriageInputFingerprint(body),
  entryId = 'triage-form-1',
) {
  return createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-1', kind: 'user' },
    idempotencyKey: createTriageActionAuditIdempotencyKey(
      entryId,
      {
        key: idempotencyKey,
        fingerprint: receiptFingerprint,
      },
    ),
    correlationId,
    occurredAt: '2026-08-09T00:04:59.000Z',
    request: { method: 'POST', path, body },
    source: {
      kind: 'api',
      requestId: 'request-1',
      method: 'POST',
      route: path,
    },
  })
}

describe('triage DynamoDB transaction contributions', () => {
  test('creates an entry, source uniqueness claim, and immutable event in the submit transaction', () => {
    const entry = createEntry()
    const fingerprint = createTriageInputFingerprint({ submissionId: 'submission-1' })
    const items = createFormTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: fingerprint,
    })

    expect(items).toHaveLength(3)
    expect(items[0]?.Put?.Item).toMatchObject({
      entryType: 'triage-entry',
      scopeKey: 'WORKSPACE#workspace-1',
      recordKey: 'TRIAGE#triage-form-1',
      revision: 1,
      triageTeamKey: 'WORKSPACE#workspace-1#TEAM#support',
    })
    expect(items[1]?.Put?.Item).toMatchObject({
      entryType: 'triage-source-claim',
      entryId: 'triage-form-1',
      inputFingerprint: fingerprint,
    })
    expect(items[2]?.Put?.Item).toMatchObject({
      entryType: 'triage-entry-event',
      entryId: 'triage-form-1',
    })
  })

  test('builds an unexecuted atomic acceptance contribution with reverse association and receipt', () => {
    const entry = createEntry()
    const contribution = createTriageAcceptanceTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      action: { action: 'accept', mode: 'create', expectedRevision: 1 },
      canonicalWorkItem: { teamId: 'support', workItemId: 'work-item-1' },
      actorId: 'member-1',
      now: '2026-08-09T00:05:00.000Z',
      idempotency: {
        key: 'accept-1',
        fingerprint: createTriageInputFingerprint({ action: 'accept', entryId: entry.id }),
      },
    })

    expect(contribution.entry).toMatchObject({
      state: 'accepted',
      revision: 2,
      canonicalWorkItem: { teamId: 'support', workItemId: 'work-item-1' },
    })
    expect(contribution.transactItems).toHaveLength(4)
    expect(contribution.transactItems[0]?.Update).toMatchObject({
      ConditionExpression: '#revision = :expectedRevision AND teamId = :teamId',
      ExpressionAttributeValues: { ':expectedRevision': 1 },
    })
    expect(contribution.transactItems[2]?.Put?.Item).toMatchObject({
      entryType: 'triage-work-item-source',
      workItemId: 'work-item-1',
      entryId: 'triage-form-1',
    })
    expect(contribution.transactItems[3]?.Put?.Item).toMatchObject({
      entryType: 'triage-operation-receipt',
      operation: 'action',
      resultRevision: 2,
    })
    expect(contribution.transactItems[3]?.Put?.Item).not.toHaveProperty('receipt')
  })

  test('atomically appends a deterministic assignment outbox event for the new owner', () => {
    const entry = createEntry()
    entry.ownerUserId = 'previous@example.com'
    entry.projectId = 'intake'
    const idempotency = {
      key: 'assign-1',
      fingerprint: createTriageInputFingerprint({
        action: 'assign',
        entryId: entry.id,
        ownerUserId: 'next@example.com',
      }),
    }
    const createContribution = () => createTriageActionTransactionItems({
      tableName: 'RequestIntakeTable',
      audit: { tableName: 'AuditEventsTable', retentionDays: 365 },
      entry,
      action: {
        action: 'assign',
        expectedRevision: 1,
        ownerUserId: 'next@example.com',
      },
      actorId: 'operator@example.com',
      now: '2026-08-09T00:05:00.000Z',
      idempotency,
      auditContext: createAssignmentAuditContext({
        action: 'assign',
        expectedRevision: 1,
        ownerUserId: 'next@example.com',
      }),
    })

    const contribution = createContribution()
    const replayContribution = createContribution()
    const auditPut = contribution.transactItems.find((item) =>
      item.Put?.TableName === 'AuditEventsTable'
    )?.Put
    const replayAuditPut = replayContribution.transactItems.find((item) =>
      item.Put?.TableName === 'AuditEventsTable'
    )?.Put

    expect(contribution.entry).toMatchObject({
      ownerUserId: 'next@example.com',
      revision: 2,
    })
    expect(contribution.transactItems).toHaveLength(4)
    expect(contribution.transactItems.some((item) =>
      item.Put?.Item?.entryType === 'triage-operation-receipt'
    )).toBe(true)
    expect(auditPut?.Item).toMatchObject({
      eventType: 'triage.assigned',
      entity: { type: 'triage-entry', id: 'triage-form-1' },
      outboxStatus: 'pending',
      metadata: {
        actorMemberKey: 'operator@example.com',
        teamId: 'support',
        projectId: 'intake',
        triageEntryId: 'triage-form-1',
        deepLink: '/teams/support/triage?entryId=triage-form-1',
        notificationTitle: 'Triage assignment',
        notificationCandidates: [{
          memberKey: 'next@example.com',
          reason: 'triage-assignment',
        }],
      },
    })
    expect(replayAuditPut?.Item?.eventId).toBe(auditPut?.Item?.eventId)
    expect(auditPut?.Item).toMatchObject({
      correlationId: 'correlation-assign-1',
      source: 'api',
      sourceDetails: {
        kind: 'api',
        requestId: 'request-1',
        method: 'POST',
        route: '/api/teams/support/triage-entries/triage-form-1/actions',
      },
    })
    expect(JSON.stringify(auditPut?.Item)).not.toContain('Please grant access.')
  })

  test('audits assignment clearing without producing a notification candidate', () => {
    const entry = createEntry()
    entry.ownerUserId = 'previous@example.com'
    const contribution = createTriageActionTransactionItems({
      tableName: 'RequestIntakeTable',
      audit: { tableName: 'AuditEventsTable', retentionDays: 365 },
      entry,
      action: { action: 'assign', expectedRevision: 1, ownerUserId: null },
      actorId: 'operator@example.com',
      now: '2026-08-09T00:05:00.000Z',
      idempotency: {
        key: 'unassign-1',
        fingerprint: createTriageInputFingerprint({
          action: 'assign',
          entryId: entry.id,
          ownerUserId: null,
        }),
      },
      auditContext: createAssignmentAuditContext(
        { action: 'assign', expectedRevision: 1, ownerUserId: null },
        undefined,
        'unassign-1',
      ),
    })
    const auditItem = contribution.transactItems.find((item) =>
      item.Put?.TableName === 'AuditEventsTable'
    )?.Put?.Item

    expect(contribution.entry.ownerUserId).toBeUndefined()
    expect(auditItem).toMatchObject({
      eventType: 'triage.assigned',
      summary: 'Triage assignment changed.',
      metadata: { notificationCandidates: [] },
    })
  })

  test('preserves single, bulk, and legacy request context without inventing Project input', () => {
    const cases = [
      {
        name: 'single',
        path: '/api/teams/support/triage-entries/triage-form-1/actions',
        body: { action: 'assign', expectedRevision: 1, ownerUserId: 'next@example.com' },
      },
      {
        name: 'bulk',
        path: '/api/teams/support/triage-entries/bulk-actions',
        body: {
          targets: [{ entryId: 'triage-form-1', expectedRevision: 1 }],
          operation: { action: 'assign', ownerUserId: 'next@example.com' },
        },
      },
      {
        name: 'legacy',
        path: '/api/requests/submission-1/actions',
        body: {
          action: 'assign',
          expectedRevision: 1,
          assigneeUserId: 'next@example.com',
        },
      },
    ]

    for (const requestCase of cases) {
      const entry = createEntry()
      entry.projectId = 'intake'
      const idempotencyKey = `assign-${requestCase.name}`
      const auditContext = createAssignmentAuditContext(
        requestCase.body,
        requestCase.path,
        idempotencyKey,
        'correlation-shared-request',
      )
      const contribution = createTriageActionTransactionItems({
        tableName: 'RequestIntakeTable',
        audit: { tableName: 'AuditEventsTable', retentionDays: 365 },
        entry,
        action: {
          action: 'assign',
          expectedRevision: 1,
          ownerUserId: 'next@example.com',
        },
        actorId: 'operator@example.com',
        now: '2026-08-09T00:05:00.000Z',
        idempotency: {
          key: idempotencyKey,
          fingerprint: createTriageInputFingerprint(requestCase.body),
        },
        auditContext,
      })
      const auditItem = contribution.transactItems.find((item) =>
        item.Put?.TableName === 'AuditEventsTable'
      )?.Put?.Item

      expect(auditItem).toMatchObject({
        correlationId: 'correlation-shared-request',
        requestFingerprint: auditContext.requestFingerprint,
        source: 'api',
        sourceDetails: { method: 'POST', route: requestCase.path },
      })
    }

    const omittedProjectContext = createAssignmentAuditContext(
      { action: 'assign', expectedRevision: 1, ownerUserId: 'next@example.com' },
    )
    const inventedProjectContext = createAssignmentAuditContext({
      action: 'assign',
      expectedRevision: 1,
      ownerUserId: 'next@example.com',
      projectId: 'intake',
    })
    expect(omittedProjectContext.requestFingerprint).not.toBe(
      inventedProjectContext.requestFingerprint,
    )
  })

  test('describes a Project-only assignment without claiming an ownership change', () => {
    const entry = createEntry()
    entry.ownerUserId = 'owner@example.com'
    entry.projectId = 'intake'
    const contribution = createTriageActionTransactionItems({
      tableName: 'RequestIntakeTable',
      audit: { tableName: 'AuditEventsTable', retentionDays: 365 },
      entry,
      action: {
        action: 'assign',
        expectedRevision: 1,
        ownerUserId: 'owner@example.com',
        projectId: 'other-project',
      },
      actorId: 'operator@example.com',
      now: '2026-08-09T00:05:00.000Z',
      idempotency: {
        key: 'assign-project-only',
        fingerprint: createTriageInputFingerprint({ projectId: 'other-project' }),
      },
      auditContext: createAssignmentAuditContext(
        {
          action: 'assign',
          expectedRevision: 1,
          ownerUserId: 'owner@example.com',
          projectId: 'other-project',
        },
        undefined,
        'assign-project-only',
      ),
    })
    const auditItem = contribution.transactItems.find((item) =>
      item.Put?.TableName === 'AuditEventsTable'
    )?.Put?.Item

    expect(auditItem).toMatchObject({
      summary: 'Triage assignment changed.',
      changes: [{ field: 'projectId', before: 'intake', after: 'other-project' }],
    })
  })

  test('keeps single and legacy assignment event IDs distinct across Entries sharing a raw key', () => {
    const requestCases = [
      {
        name: 'single',
        path: '/api/teams/support/triage-entries/triage-form-1/actions',
        body: { action: 'assign', expectedRevision: 1, ownerUserId: 'next@example.com' },
      },
      {
        name: 'legacy',
        path: '/api/requests/submission-1/actions',
        body: {
          action: 'assign',
          expectedRevision: 1,
          assigneeUserId: 'next@example.com',
        },
      },
    ]

    for (const requestCase of requestCases) {
      const entries = [
        createEntry(),
        { ...createEntry(), id: 'triage-form-2' },
      ]
      const eventIds = entries.map((entry) => {
        const receiptFingerprint = createTriageInputFingerprint({
          workspaceId: entry.workspaceId,
          teamId: entry.teamId,
          entryId: entry.id,
          action: requestCase.body,
        })
        const contribution = createTriageActionTransactionItems({
          tableName: 'RequestIntakeTable',
          audit: { tableName: 'AuditEventsTable', retentionDays: 365 },
          entry,
          action: {
            action: 'assign',
            expectedRevision: 1,
            ownerUserId: 'next@example.com',
          },
          actorId: 'operator@example.com',
          now: '2026-08-09T00:05:00.000Z',
          idempotency: {
            key: 'same-raw-key',
            fingerprint: receiptFingerprint,
          },
          auditContext: createAssignmentAuditContext(
            requestCase.body,
            requestCase.path.replace('triage-form-1', entry.id),
            'same-raw-key',
            `correlation-${requestCase.name}`,
            receiptFingerprint,
            entry.id,
          ),
        })
        return contribution.transactItems.find((item) =>
          item.Put?.TableName === 'AuditEventsTable'
        )?.Put?.Item?.eventId
      })

      expect(eventIds[0]).toBeString()
      expect(eventIds[1]).toBeString()
      expect(eventIds[1]).not.toBe(eventIds[0])
    }
  })

  test('builds activity dedupe and resurface writes without reopening terminal entries', () => {
    const entry = { ...createEntry(), state: 'needs-information' } satisfies TriageEntry
    const contribution = createTriageSourceActivityTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      activity: {
        activityId: 'email-message-2',
        actorId: 'source:email',
        occurredAt: '2026-08-09T00:10:00.000Z',
        summary: 'Requester replied.',
      },
      idempotency: {
        key: 'email-message-2',
        fingerprint: createTriageInputFingerprint({ messageId: 'email-message-2' }),
      },
    })

    expect(contribution.entry.state).toBe('pending')
    expect(contribution.transactItems.map((item) => item.Put?.Item?.entryType ?? 'update'))
      .toEqual(['update', 'triage-entry-event', 'triage-entry-event', 'triage-operation-receipt'])
  })

  test('persists a delayed retention redaction audit event with a source activity', () => {
    const expired = redactExpiredTriageEntry(
      createEntry(),
      '2028-08-09T00:00:00.000Z',
    )
    const contribution = createTriageSourceActivityTransactionItems({
      tableName: 'RequestIntakeTable',
      entry: expired,
      activity: {
        activityId: 'email-message-retained',
        actorId: 'source:email',
        occurredAt: '2028-08-09T00:10:00.000Z',
        summary: 'Requester replied after retention elapsed.',
      },
      idempotency: {
        key: 'email-message-retained',
        fingerprint: createTriageInputFingerprint({ messageId: 'email-message-retained' }),
      },
      now: '2028-08-09T00:10:05.000Z',
    })

    expect(contribution.entry.events.map((event) => event.type)).toEqual([
      'created',
      'activity-received',
      'retention-redacted',
    ])
    expect(contribution.transactItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            entryType: 'triage-entry-event',
            event: expect.objectContaining({ type: 'retention-redacted' }),
          }),
        }),
      }),
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            entryType: 'triage-operation-receipt',
            expiresAt: Math.floor(Date.parse('2028-11-07T00:10:05.000Z') / 1_000),
          }),
        }),
      }),
    ]))
  })

  test('persists a delayed retention redaction audit event with an operator action', () => {
    const expired = redactExpiredTriageEntry(
      createEntry(),
      '2028-08-09T00:00:00.000Z',
    )
    const contribution = createTriageActionTransactionItems({
      tableName: 'RequestIntakeTable',
      entry: expired,
      action: {
        action: 'decline',
        expectedRevision: expired.revision,
        reason: 'No longer actionable.',
      },
      actorId: 'operator@example.com',
      now: '2028-08-09T00:10:00.000Z',
      idempotency: {
        key: 'decline-retained',
        fingerprint: createTriageInputFingerprint({ entryId: expired.id, action: 'decline' }),
      },
      audit: { tableName: 'AuditEventsTable', retentionDays: 365 },
      auditContext: createAssignmentAuditContext({
        entryId: expired.id,
        idempotencyKey: 'decline-retained',
      }),
    })

    expect(contribution.entry.events.map((event) => event.type)).toEqual([
      'created',
      'declined',
      'retention-redacted',
    ])
    expect(contribution.transactItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            entryType: 'triage-entry-event',
            event: expect.objectContaining({ type: 'retention-redacted' }),
          }),
        }),
      }),
    ]))
  })

  test('binds source claims to Workspace, kind, and stable source ID', () => {
    expect(createTriageSourceClaimKey('workspace-1', 'email', 'message-1')).not.toEqual(
      createTriageSourceClaimKey('workspace-2', 'email', 'message-1'),
    )
    expect(createTriageSourceClaimKey('workspace-1', 'email', 'message-1')).not.toEqual(
      createTriageSourceClaimKey('workspace-1', 'webhook', 'message-1'),
    )
  })

  test('decodes stored entries only when their complete projection matches the physical key', () => {
    const entry = createEntry()
    const storedItem = createFormTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: createTriageInputFingerprint({ submissionId: 'submission-1' }),
    })[0]?.Put?.Item
    if (!storedItem) throw new TypeError('Expected a stored triage entry fixture.')
    const key = createTriageEntryKey(entry.workspaceId, entry.id)

    expect(decodeTriageEntryRow(storedItem, key)).toMatchObject({ id: entry.id })
    expect(decodeTriageEntryRow({
      ...storedItem,
      entry: {
        ...entry,
        events: [{ ...entry.events[0], id: '<message/2@example.com>' }],
      },
    }, key)).toMatchObject({
      events: [{ id: '<message/2@example.com>' }],
    })
    expect(decodeTriageEntryRow(storedItem, {
      ...key,
      recordKey: 'TRIAGE#triage-other',
    })).toBeUndefined()
    expect(decodeTriageEntryRow({
      ...storedItem,
      entry: { ...entry, revision: 0 },
    }, key)).toBeUndefined()
    expect(decodeTriageEntryRow({
      ...storedItem,
      entry: { ...entry, internalSecret: 'must-not-cross-the-boundary' },
    }, key)).toBeUndefined()
    expect(decodeTriageEntryRow({
      ...storedItem,
      entry: {
        ...entry,
        routing: { ...entry.routing, candidates: [{}] },
      },
    }, key)).toBeUndefined()
    expect(decodeTriageEntryRow({
      ...storedItem,
      entry: {
        ...entry,
        sourcePreview: { ...entry.sourcePreview, attachmentCount: -1 },
      },
    }, key)).toBeUndefined()
    expect(decodeTriageEntryRow({
      ...storedItem,
      entry: {
        ...entry,
        state: 'snoozed',
        snoozedUntil: undefined,
      },
    }, key)).toBeUndefined()
    expect(decodeTriageEntryRow({
      ...storedItem,
      entry: {
        ...entry,
        state: 'pending',
        snoozedUntil: '2026-08-09T00:10:00.000Z',
      },
    }, key)).toBeUndefined()
    expect(decodeTriageEntryRow({
      ...storedItem,
      entry: {
        ...entry,
        events: [{ ...entry.events[0], type: 'unrecognized-event' }],
      },
    }, key)).toBeUndefined()
  })
})
