import { describe, expect, test } from 'bun:test'
import { PLANNING_UPDATE_CONTENT_VERSION } from '@mukuroji/contracts'
import type { PlanningUpdate, PlanningUpdateComment } from '@mukuroji/contracts'
import { createMutationAuditContext } from '../../modules/audit/audit'
import { isPlanningHealthDegraded } from '../../modules/planning'
import {
  createPlanningUpdateCommentAuditEvent,
  createPlanningUpdatePublishAuditEvent,
  readPlanningUpdateCommentMentions,
  withPlanningAuditOutbox,
} from './planning-update-notifications'

/** Creates a complete committed update; tests override only the fields they exercise. */
function createUpdate(overrides: Partial<PlanningUpdate> = {}): PlanningUpdate {
  const progressSnapshot = { percent: 40, linkedWorkItemCount: 5 }
  const update: PlanningUpdate = {
    id: 'update-1',
    target: { type: 'project', teamId: 'core', projectId: 'platform' },
    version: 3,
    contentVersion: PLANNING_UPDATE_CONTENT_VERSION,
    origin: 'manual',
    health: 'off-track',
    risk: 'high',
    summary: 'Vendor delay pushes the launch.\nNeed a decision.',
    riskSummary: '',
    decisionSummary: '',
    helpNeeded: '',
    nextAction: '',
    progressSnapshot,
    contextSnapshot: createContextSnapshot({ teamId: 'core', projectId: 'platform' }),
    changes: [],
    evidence: [],
    authorMemberKey: 'owner@example.com',
    coveredDueAt: '2026-07-16T00:00:00.000Z',
    createdAt: '2026-07-16T09:00:00.000Z',
  }
  return { ...update, ...overrides }
}

/** Creates a complete context snapshot for one target scope. */
function createContextSnapshot(scope: PlanningUpdate['contextSnapshot']['scope']): PlanningUpdate['contextSnapshot'] {
  return {
    health: 'off-track',
    risk: 'high',
    progress: { percent: 40, linkedWorkItemCount: 5 },
    scope,
    milestones: [],
    dependencies: [],
  }
}

/** Creates an audit context for transaction tests. */
function createContext() {
  return createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'owner-sub', kind: 'user', displayName: 'owner@example.com' },
    idempotencyKey: 'publish-1',
    occurredAt: '2026-07-16T09:00:00.000Z',
    request: { method: 'POST', path: '/api/planning/updates' },
    source: { kind: 'api', requestId: 'publish-1' },
  })
}

describe('Planning update notifications', () => {
  test('treats only a worse at-risk or off-track health as degraded', () => {
    expect(isPlanningHealthDegraded('on-track', 'at-risk')).toBe(true)
    expect(isPlanningHealthDegraded('at-risk', 'off-track')).toBe(true)
    expect(isPlanningHealthDegraded(undefined, 'off-track')).toBe(true)
    expect(isPlanningHealthDegraded('off-track', 'off-track')).toBe(false)
    expect(isPlanningHealthDegraded('off-track', 'at-risk')).toBe(false)
    expect(isPlanningHealthDegraded('at-risk', 'on-track')).toBe(false)
  })

  test('notifies the owner and escalation recipient with a link when health degrades', () => {
    expect(createPlanningUpdatePublishAuditEvent({
      workspaceId: 'workspace-1',
      update: createUpdate(),
      notification: {
        previousHealth: 'on-track',
        healthDegraded: true,
        updateOwnerMemberKey: 'Owner@Example.com',
        escalationMemberKey: 'Lead@Example.com',
      },
    })).toMatchObject({
      eventType: 'planning-update.health-degraded',
      entityType: 'planning-update',
      entityId: 'project/core/platform',
      target: { type: 'planning-update-version', id: 'project/core/platform/version/3' },
      changes: [{ field: 'health', before: 'on-track', after: 'off-track' }],
      summary: 'Health changed to off-track: Vendor delay pushes the launch. Need a decision.',
      metadata: {
        planningTargetType: 'project',
        planningTargetId: 'platform',
        planningTargetRecordKey: 'UPDATE_TARGET#PROJECT#core#platform',
        teamId: 'core',
        projectId: 'platform',
        deepLink: '/planning/portfolio?targetType=project&teamId=core&projectId=platform',
        notificationCandidates: [
          { memberKey: 'lead@example.com', reason: 'escalation' },
          { memberKey: 'owner@example.com', reason: 'update-owner' },
        ],
      },
    })
  })

  test('publishes a routine update without the owner candidate', () => {
    const event = createPlanningUpdatePublishAuditEvent({
      workspaceId: 'workspace-1',
      update: createUpdate({
        health: 'on-track',
        target: { type: 'initiative', entityId: 'launch' },
        contextSnapshot: createContextSnapshot({}),
      }),
      notification: {
        previousHealth: 'on-track',
        healthDegraded: false,
        updateOwnerMemberKey: 'owner@example.com',
      },
    })
    expect(event).toMatchObject({
      eventType: 'planning-update.published',
      entityId: 'initiative/launch',
      changes: [],
      metadata: {
        planningTargetType: 'initiative',
        planningTargetId: 'launch',
        planningTargetRecordKey: 'UPDATE_TARGET#INITIATIVE#launch',
        deepLink: '/planning/portfolio?targetType=initiative&entityId=launch',
        notificationCandidates: [],
      },
    })
    expect(event.metadata).not.toHaveProperty('teamId')
  })

  test('notifies the update author and mentioned members of a comment', () => {
    const comment: PlanningUpdateComment = {
      id: 'comment-1',
      target: { type: 'project', teamId: 'core', projectId: 'platform' },
      updateVersion: 3,
      body: 'Can we pull in design?',
      authorMemberKey: 'pm@example.com',
      createdAt: '2026-07-16T10:00:00.000Z',
    }
    expect(createPlanningUpdateCommentAuditEvent({
      workspaceId: 'workspace-1',
      comment,
      updateAuthorMemberKey: 'Owner@Example.com',
      mentionMemberKeys: ['designer@example.com'],
      scope: { teamId: 'core', projectId: 'platform' },
    })).toMatchObject({
      eventType: 'planning-update.commented',
      target: { type: 'planning-update-comment', id: 'project/core/platform/version/3/comment/comment-1' },
      metadata: {
        actorMemberKey: 'pm@example.com',
        commentId: 'comment-1',
        notificationCandidates: [
          { memberKey: 'owner@example.com', reason: 'update-author' },
          { memberKey: 'designer@example.com', reason: 'mention' },
        ],
      },
    })
  })

  test('normalizes bounded mention lists and rejects malformed ones', () => {
    expect(readPlanningUpdateCommentMentions(undefined)).toEqual([])
    expect(readPlanningUpdateCommentMentions([' B@Example.com', 'a@example.com', 'b@example.com']))
      .toEqual(['a@example.com', 'b@example.com'])
    for (const invalid of [
      'a@example.com',
      [1],
      [''],
      ['two words'],
      ['WORKSPACE#a@example.com'],
      Array.from({ length: 21 }, (_, index) => `m${index}@example.com`),
    ]) {
      expect(() => readPlanningUpdateCommentMentions(invalid)).toThrow()
    }
  })

  test('adds the audit write after a receipt or uses it alone without one', async () => {
    const previous = process.env.AUDIT_EVENTS_TABLE_NAME
    // A local DynamoDB endpoint makes the audit table name default, so isolate it for the no-table case.
    const endpointKeys = ['DYNAMODB_ENDPOINT', 'AWS_ENDPOINT_URL_DYNAMODB', 'AWS_ENDPOINT_URL']
    const previousEndpoints = endpointKeys.map((key): [string, string | undefined] => [key, process.env[key]])
    for (const key of endpointKeys) delete process.env[key]
    process.env.AUDIT_EVENTS_TABLE_NAME = 'AuditEventsTable'
    try {
      const result = {
        kind: 'publish' as const,
        revision: 2,
        update: createUpdate(),
        notification: {
          previousHealth: 'on-track' as const,
          healthDegraded: true,
          updateOwnerMemberKey: 'owner@example.com',
        },
      }
      const event = () => createPlanningUpdatePublishAuditEvent({
        workspaceId: 'workspace-1',
        update: result.update,
        notification: result.notification,
      })
      const receipt = { Put: { TableName: 'IdempotencyTable', Item: { key: 'receipt' } } }
      const withReceipt = await withPlanningAuditOutbox(
        { prepare: async () => ({ transactWriteItem: receipt }) },
        createContext(),
        event,
      )?.prepare(result)
      const alone = await withPlanningAuditOutbox(undefined, createContext(), event)?.prepare(result)

      expect(withReceipt).toMatchObject({
        transactWriteItem: receipt,
        additionalTransactWriteItems: [{
          Put: { TableName: 'AuditEventsTable', Item: { eventType: 'planning-update.health-degraded' } },
        }],
      })
      expect(alone).toMatchObject({
        transactWriteItem: {
          Put: { TableName: 'AuditEventsTable', Item: { eventType: 'planning-update.health-degraded' } },
        },
      })

      delete process.env.AUDIT_EVENTS_TABLE_NAME
      const base = { prepare: async () => ({ transactWriteItem: receipt }) }
      expect(withPlanningAuditOutbox(base, createContext(), event)).toBe(base)
    } finally {
      if (previous === undefined) delete process.env.AUDIT_EVENTS_TABLE_NAME
      else process.env.AUDIT_EVENTS_TABLE_NAME = previous
      for (const [key, value] of previousEndpoints) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
