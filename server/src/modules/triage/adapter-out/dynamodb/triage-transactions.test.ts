import { describe, expect, test } from 'bun:test'
import { TRIAGE_ENTRY_SCHEMA_VERSION, type TriageEntry } from '@mukuroji/contracts'
import { createTriageCapabilities } from '../../domain/triage-entry'
import { createTriageInputFingerprint } from '../../triage'
import {
  createFormTriageEntryTransactionItems,
  createTriageAcceptanceTransactionItems,
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

  test('binds source claims to Workspace, kind, and stable source ID', () => {
    expect(createTriageSourceClaimKey('workspace-1', 'email', 'message-1')).not.toEqual(
      createTriageSourceClaimKey('workspace-2', 'email', 'message-1'),
    )
    expect(createTriageSourceClaimKey('workspace-1', 'email', 'message-1')).not.toEqual(
      createTriageSourceClaimKey('workspace-1', 'webhook', 'message-1'),
    )
  })

  test('decodes stored entries only when their projection matches the physical key', () => {
    const entry = createEntry()
    const storedItem = createFormTriageEntryTransactionItems({
      tableName: 'RequestIntakeTable',
      entry,
      inputFingerprint: createTriageInputFingerprint({ submissionId: 'submission-1' }),
    })[0]?.Put?.Item
    if (!storedItem) throw new TypeError('Expected a stored triage entry fixture.')
    const key = createTriageEntryKey(entry.workspaceId, entry.id)

    expect(decodeTriageEntryRow(storedItem, key)).toMatchObject({ id: entry.id })
    expect(decodeTriageEntryRow(storedItem, {
      ...key,
      recordKey: 'TRIAGE#triage-other',
    })).toBeUndefined()
    expect(decodeTriageEntryRow({
      ...storedItem,
      entry: { ...entry, revision: 0 },
    }, key)).toBeUndefined()
  })
})
