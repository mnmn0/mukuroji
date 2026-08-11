import { describe, expect, test } from 'bun:test'
import {
  TRIAGE_CONFIGURATION_SCHEMA_VERSION,
  TRIAGE_ENTRY_SCHEMA_VERSION,
  type TriageConfiguration,
  type TriageEntry,
} from '@mukuroji/contracts'
import {
  applyTriageAction,
  createTriageCapabilities,
  evaluateTriageAdmission,
  evaluateTriageSchedule,
  projectTriageEntryForResponse,
  recordTriageSourceActivity,
  TriageError,
} from './triage-entry'

/** Stable domain test instant. */
const NOW = '2026-08-09T00:00:00.000Z'

/** Creates a complete canonical entry fixture.
 *
 * @param overrides Top-level fixture overrides.
 * @returns A valid pending triage entry.
 */
function createEntry(overrides: Partial<TriageEntry> = {}): TriageEntry {
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
    source: { kind: 'email', sourceId: 'message-1' },
    sourcePreview: {
      title: 'Unable to sign in',
      body: 'Please help.',
      permalink: 'https://mail.example.com/messages/1',
      attachmentCount: 1,
      commentCount: 1,
      watcherCount: 0,
      sanitized: true,
      truncated: false,
    },
    requester: { displayName: 'Requester', email: 'requester@example.com', guest: false },
    receivedAt: NOW,
    lastActivityAt: NOW,
    state: 'pending',
    routing: {
      reason: 'Matched support rule.',
      candidates: [{ teamId: 'support', reason: 'Support keyword.', permitted: true }],
    },
    teamId: 'support',
    permission,
    sla: {
      policyId: 'support-sla',
      dueAt: '2026-08-09T00:30:00.000Z',
      escalationDueAt: '2026-08-09T01:00:00.000Z',
    },
    retention: { expiresAt: '2026-09-09T00:00:00.000Z' },
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
    ...overrides,
  }
}

describe('triage entry state machine', () => {
  test('derives Form routing, rotation owner, SLA, and retention without mutating configuration', () => {
    const configuration: TriageConfiguration = {
      schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
      workspaceId: 'workspace-1',
      teamId: 'support',
      rules: [{
        id: 'form-outage',
        name: 'Form outages',
        enabled: true,
        order: 1,
        sourceKinds: ['form'],
        keywords: ['unable'],
        teamId: 'support',
        projectId: 'project-incidents',
        owner: { type: 'rotation', rotationId: 'primary' },
      }],
      rotations: [{
        id: 'primary',
        name: 'Primary rotation',
        memberUserIds: ['first@example.com', 'second@example.com'],
        nextIndex: 1,
      }],
      slaPolicies: [{
        id: 'form-sla',
        name: 'Form SLA',
        sourceKinds: ['form'],
        responseMinutes: 30,
        escalationMinutes: 15,
        escalationOwnerUserId: 'manager@example.com',
      }],
      allowedBulkActions: ['assign', 'decline', 'snooze'],
      retentionDays: 90,
      revision: 7,
      updatedAt: '2026-08-08T00:00:00.000Z',
    }
    const entry = createEntry({
      source: {
        kind: 'form',
        sourceId: 'submission-1',
        formId: 'form-1',
        submissionId: 'submission-1',
      },
      ownerUserId: 'form-owner@example.com',
      projectId: 'form-project',
    })

    const evaluation = evaluateTriageAdmission(configuration, entry, NOW)

    expect(evaluation.entry).toMatchObject({
      projectId: 'project-incidents',
      ownerUserId: 'second@example.com',
      routing: {
        reason: 'Matched Team Triage routing rule "Form outages".',
        candidates: [{ ruleId: 'form-outage', projectId: 'project-incidents' }],
      },
      sla: {
        policyId: 'form-sla',
        dueAt: '2026-08-09T00:30:00.000Z',
        escalationDueAt: '2026-08-09T00:45:00.000Z',
        escalationOwnerUserId: 'manager@example.com',
      },
      retention: { expiresAt: '2026-11-07T00:00:00.000Z' },
    })
    expect(evaluation.rotationReservation).toMatchObject({
      rotationIndex: 0,
      expectedRevision: 7,
      expectedNextIndex: 1,
      configuration: {
        revision: 7,
        rotations: [{ nextIndex: 0 }],
      },
    })
    expect(configuration).toMatchObject({
      revision: 7,
      rotations: [{ nextIndex: 1 }],
    })
  })

  test('preserves a source owner without a rule and projects the resolved fallback Project', () => {
    const configuration: TriageConfiguration = {
      schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
      workspaceId: 'workspace-1',
      teamId: 'support',
      rules: [{
        id: 'billing-only',
        name: 'Billing only',
        enabled: true,
        order: 1,
        sourceKinds: ['form'],
        keywords: ['billing'],
        teamId: 'support',
        owner: { type: 'fixed', ownerUserId: 'billing@example.com' },
      }],
      rotations: [],
      slaPolicies: [],
      allowedBulkActions: ['assign', 'decline', 'snooze'],
      retentionDays: 30,
      revision: 1,
      updatedAt: '2026-08-08T00:00:00.000Z',
    }
    const entry = createEntry({
      source: {
        kind: 'form',
        sourceId: 'submission-1',
        formId: 'form-1',
        submissionId: 'submission-1',
      },
      ownerUserId: 'form-owner@example.com',
      projectId: 'form-project',
    })

    const unmatched = evaluateTriageAdmission(configuration, entry, NOW)

    expect(unmatched.entry.ownerUserId).toBe('form-owner@example.com')
    expect(unmatched.entry.projectId).toBe('form-project')
    expect(unmatched.entry.routing).toEqual(entry.routing)

    const matched = evaluateTriageAdmission({
      ...configuration,
      rules: [{
        ...configuration.rules[0]!,
        keywords: [],
        owner: { type: 'unowned' },
      }],
    }, entry, NOW)

    expect(matched.entry.ownerUserId).toBeUndefined()
    expect(matched.entry.projectId).toBe('form-project')
    expect(matched.entry.routing.candidates).toEqual([
      expect.objectContaining({ ruleId: 'billing-only', projectId: 'form-project' }),
    ])
  })

  test('resurfaces snoozed and information-waiting entries on new activity', () => {
    const snoozed = applyTriageAction(createEntry(), {
      action: 'snooze',
      expectedRevision: 1,
      until: '2026-08-10T00:00:00.000Z',
    }, { actorId: 'member-1', now: '2026-08-09T00:05:00.000Z' })

    const resurfaced = recordTriageSourceActivity(snoozed, {
      activityId: 'provider-event-2',
      actorId: 'source:email',
      occurredAt: '2026-08-09T00:10:00.000Z',
      summary: 'Requester replied.',
    })

    expect(resurfaced.state).toBe('pending')
    expect(resurfaced.snoozedUntil).toBeUndefined()
    expect(resurfaced.events.slice(-2).map((event) => event.type)).toEqual([
      'activity-received',
      'resurfaced',
    ])

    const waiting = applyTriageAction(createEntry(), {
      action: 'request-information',
      expectedRevision: 1,
      message: 'Please provide the affected account ID.',
    }, { actorId: 'member-1', now: '2026-08-09T00:05:00.000Z' })
    const waitingWithSla = evaluateTriageSchedule(
      waiting,
      '2026-08-09T00:30:00.000Z',
    ).entry
    const delayedReply = recordTriageSourceActivity(waitingWithSla, {
      activityId: 'provider-event-delayed-reply',
      actorId: 'source:email',
      occurredAt: '2026-08-09T00:10:00.000Z',
      summary: 'Requester replied before the SLA worker ran.',
    })

    expect(delayedReply.state).toBe('pending')
    expect(delayedReply.lastActivityAt).toBe('2026-08-09T00:10:00.000Z')
    expect(delayedReply.updatedAt).toBe('2026-08-09T00:30:00.000Z')
  })

  test('retains a bounded decline reason in decision history', () => {
    const reason = '  This request belongs to the billing support workflow.  '

    const declined = applyTriageAction(createEntry(), {
      action: 'decline',
      expectedRevision: 1,
      reason,
    }, { actorId: 'member-1', now: '2026-08-09T00:05:00.000Z' })

    expect(declined.events.at(-1)).toEqual({
      id: 'declined:2:2026-08-09T00:05:00.000Z',
      type: 'declined',
      actorId: 'member-1',
      summary: reason.trim(),
      createdAt: '2026-08-09T00:05:00.000Z',
    })
    const deniedProjection = projectTriageEntryForResponse({
      ...declined,
      permission: {
        visibility: 'denied',
        canReply: false,
        guestVisible: false,
        reasonCode: 'permission-lost',
        checkedAt: '2026-08-09T00:06:00.000Z',
      },
    })
    expect(deniedProjection.events).toEqual([])
    expect(JSON.stringify(deniedProjection)).not.toContain(reason.trim())
    expect(() => applyTriageAction(createEntry(), {
      action: 'decline',
      expectedRevision: 1,
      reason: 'x'.repeat(2_001),
    }, { actorId: 'member-1', now: '2026-08-09T00:05:00.000Z' })).toThrow(TriageError)
  })

  test('records distinct out-of-order activity without regressing timestamps or stale resurfacing', () => {
    const snoozed = applyTriageAction(createEntry({
      lastActivityAt: '2026-08-09T00:20:00.000Z',
      updatedAt: '2026-08-09T00:20:00.000Z',
    }), {
      action: 'snooze',
      expectedRevision: 1,
      until: '2026-08-10T00:00:00.000Z',
    }, { actorId: 'member-1', now: '2026-08-09T00:30:00.000Z' })

    const staleActivity = recordTriageSourceActivity(snoozed, {
      activityId: 'provider-event-distinct-but-old',
      actorId: 'source:email',
      occurredAt: '2026-08-09T00:25:00.000Z',
      summary: 'A delayed provider delivery.',
    })

    expect(staleActivity).toMatchObject({
      state: 'snoozed',
      snoozedUntil: '2026-08-10T00:00:00.000Z',
      lastActivityAt: '2026-08-09T00:25:00.000Z',
      updatedAt: '2026-08-09T00:30:00.000Z',
      revision: 3,
    })
    expect(staleActivity.events.at(-1)?.type).toBe('activity-received')

    const simultaneousActivity = recordTriageSourceActivity(snoozed, {
      activityId: 'provider-event-at-transition',
      actorId: 'source:email',
      occurredAt: '2026-08-09T00:30:00.000Z',
      summary: 'A provider delivery timestamped with the snooze transition.',
    })
    expect(simultaneousActivity.state).toBe('snoozed')

    const pending = createEntry({
      lastActivityAt: '2026-08-09T00:20:00.000Z',
      updatedAt: '2026-08-09T00:30:00.000Z',
    })
    const olderPendingActivity = recordTriageSourceActivity(pending, {
      activityId: 'provider-event-pending-old',
      actorId: 'source:email',
      occurredAt: '2026-08-09T00:10:00.000Z',
      summary: 'Another delayed provider delivery.',
    })
    expect(olderPendingActivity).toMatchObject({
      state: 'pending',
      lastActivityAt: '2026-08-09T00:20:00.000Z',
      updatedAt: '2026-08-09T00:30:00.000Z',
    })
  })

  test('keeps terminal entries closed while retaining later source activity', () => {
    const declined = applyTriageAction(createEntry(), {
      action: 'decline',
      expectedRevision: 1,
      reason: 'Out of scope.',
    }, { actorId: 'member-1', now: '2026-08-09T00:05:00.000Z' })

    expect(() => applyTriageAction(declined, {
      action: 'assign',
      expectedRevision: 2,
      ownerUserId: 'member-2',
    }, { actorId: 'member-1', now: '2026-08-09T00:06:00.000Z' })).toThrow(TriageError)

    const activity = recordTriageSourceActivity(declined, {
      activityId: 'provider-event-3',
      actorId: 'source:email',
      occurredAt: '2026-08-09T00:10:00.000Z',
      summary: 'Requester replied after decline.',
    })
    expect(activity.state).toBe('declined')
    expect(activity.events.at(-1)?.type).toBe('activity-received')
  })

  test('requires duplicate merge proof before resolving to a canonical Work Item', () => {
    expect(() => applyTriageAction(createEntry(), {
      action: 'duplicate',
      expectedRevision: 1,
      canonicalWorkItemId: 'work-item-1',
    }, {
      actorId: 'member-1',
      now: '2026-08-09T00:05:00.000Z',
      canonicalWorkItem: { teamId: 'support', workItemId: 'work-item-1' },
    })).toThrow(TriageError)

    const duplicate = applyTriageAction(createEntry(), {
      action: 'duplicate',
      expectedRevision: 1,
      canonicalWorkItemId: 'work-item-1',
    }, {
      actorId: 'member-1',
      now: '2026-08-09T00:05:00.000Z',
      canonicalWorkItem: { teamId: 'support', workItemId: 'work-item-1' },
      mergeReceipt: {
        canonicalWorkItemId: 'work-item-1',
        mergedSourceCount: 1,
        mergedCommentCount: 1,
        mergedAttachmentCount: 1,
        mergedWatcherCount: 0,
        completedAt: '2026-08-09T00:05:00.000Z',
      },
    })
    expect(duplicate.state).toBe('duplicate')
    expect(duplicate.capabilities.canAssign).toBe(false)
  })

  test('fires snooze, SLA, escalation, and retention deadlines once', () => {
    const snoozed = createEntry({
      state: 'snoozed',
      snoozedUntil: '2026-08-09T00:15:00.000Z',
      retention: { expiresAt: '2026-08-09T00:20:00.000Z' },
    })
    const evaluated = evaluateTriageSchedule(snoozed, '2026-08-09T01:00:00.000Z')

    expect(evaluated).toMatchObject({
      resurfaced: true,
      breached: true,
      escalated: true,
      redacted: true,
      entry: { state: 'pending' },
    })
    expect(evaluated.entry.sourcePreview.permalink).toBeUndefined()
    expect(evaluated.entry.permission).toMatchObject({
      visibility: 'metadata-only',
      canReply: false,
      reasonCode: 'retention-expired',
    })

    const replay = evaluateTriageSchedule(evaluated.entry, '2026-08-09T01:01:00.000Z')
    expect(replay).toMatchObject({
      resurfaced: false,
      breached: false,
      escalated: false,
      redacted: false,
    })
  })

  test('redacts unavailable source content from response projections', () => {
    const metadata = projectTriageEntryForResponse(createEntry({
      permission: {
        visibility: 'metadata-only',
        canReply: false,
        guestVisible: false,
        checkedAt: NOW,
      },
    }))
    expect(metadata.sourcePreview).toMatchObject({ title: 'Unable to sign in', body: '' })
    expect(metadata.sourcePreview.permalink).toBeUndefined()
    expect(metadata.requester).toEqual({ displayName: 'Requester', guest: false })

    const denied = projectTriageEntryForResponse(createEntry({
      permission: {
        visibility: 'denied',
        canReply: false,
        guestVisible: false,
        reasonCode: 'permission-lost',
        checkedAt: NOW,
      },
    }))
    expect(denied.sourcePreview).toMatchObject({
      title: 'Restricted source',
      body: '',
      attachmentCount: 0,
    })
    expect(denied.requester).toEqual({ displayName: 'Restricted requester', guest: false })
    expect(denied.routing.candidates).toEqual([])
    expect(denied.events).toEqual([])
    expect(denied.capabilities.canAcceptCreate).toBe(false)
    expect(denied.capabilities.canViewInternalContext).toBe(false)

    const malformedPermalink = projectTriageEntryForResponse(createEntry({
      sourcePreview: {
        ...createEntry().sourcePreview,
        permalink: 'javascript:alert(1)',
      },
    }))
    expect(malformedPermalink.sourcePreview.permalink).toBeUndefined()

    const expired = projectTriageEntryForResponse(createEntry({
      retention: { expiresAt: '2026-08-09T00:00:00.000Z' },
    }), '2026-08-10T00:00:00.000Z')
    expect(expired).toMatchObject({
      permission: { visibility: 'metadata-only', reasonCode: 'retention-expired' },
      requester: { displayName: 'Redacted requester' },
      sourcePreview: {
        title: 'Retained source',
        body: '',
        attachmentCount: 0,
        commentCount: 0,
        watcherCount: 0,
      },
    })

    const staleRedactionMarker = projectTriageEntryForResponse(createEntry({
      sourcePreview: {
        ...createEntry().sourcePreview,
        body: 'must not escape a stale redaction marker',
        attachmentCount: 2,
        commentCount: 3,
        watcherCount: 4,
        permalink: 'https://example.com/private-source',
      },
      requester: {
        displayName: 'Original requester',
        email: 'requester@example.com',
        externalId: 'external-requester-id',
        guest: false,
      },
      retention: {
        expiresAt: '2026-08-09T00:00:00.000Z',
        redactedAt: '2026-08-09T00:01:00.000Z',
      },
    }), '2026-08-10T00:00:00.000Z')
    expect(staleRedactionMarker).toMatchObject({
      sourcePreview: {
        title: 'Retained source',
        body: '',
        attachmentCount: 0,
        commentCount: 0,
        watcherCount: 0,
      },
      requester: { displayName: 'Redacted requester' },
      permission: { visibility: 'metadata-only', reasonCode: 'retention-expired' },
    })
    expect(staleRedactionMarker.sourcePreview.permalink).toBeUndefined()
    expect(staleRedactionMarker.requester.email).toBeUndefined()
    expect(staleRedactionMarker.requester.externalId).toBeUndefined()
  })
})
