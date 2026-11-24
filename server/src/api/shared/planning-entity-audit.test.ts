import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createAuditEvent, createMutationAuditContext } from '../../modules/audit/audit'
import { shouldEvaluateAllPlanningHistoryScopes } from './planning-access'
import type {
  PlanningEntityChangeAction,
  PlanningEntityTransactionSnapshot,
} from '../../modules/planning'
import {
  createPlanningEntityAuditEvent,
  readPlanningEntityAuditScopes,
  readPlanningMilestoneNotificationKind,
  redactPlanningEntityAuditReferences,
  toPlanningEntityActivityPageView,
} from './planning-entity-audit'

/**
 * Creates one stored Planning entity audit event.
 *
 * @param action - Recorded lifecycle action.
 * @param changes - Recorded field changes.
 * @param metadata - Recorded scope metadata.
 * @returns The schema v1 event.
 */
function createEntityEvent(
  action: string,
  changes: { field: string; before?: string; after?: string }[],
  metadata: Record<string, string>,
) {
  return createAuditEvent({
    context: createMutationAuditContext({
      workspaceId: 'workspace-1',
      actor: { id: 'actor-1', kind: 'user' },
      idempotencyKey: `key-${action}`,
      request: { method: 'POST', path: '/api/planning/entities' },
      source: { kind: 'api' },
    }),
    eventType: `planning-entity.${action}`,
    entity: { type: 'planning-entity', id: 'entity-1' },
    action,
    changes,
    metadata,
    expiresAt: 2_000_000_000,
  })
}

test('authorizes only the recorded scope of an entity created inside a Project', () => {
  const event = createEntityEvent('created', [
    { field: 'projectId', after: 'project-1' },
    { field: 'teamId', after: 'team-1' },
  ], { teamId: 'team-1', projectId: 'project-1' })

  expect(readPlanningEntityAuditScopes(event)).toEqual([{ teamId: 'team-1', projectId: 'project-1' }])
})

test('authorizes the scope a move left as well as the scope it entered', () => {
  const event = createEntityEvent('moved', [
    { field: 'projectId', before: 'project-a', after: 'project-b' },
  ], { teamId: 'team-1', projectId: 'project-b' })

  expect(readPlanningEntityAuditScopes(event)).toEqual([
    { teamId: 'team-1', projectId: 'project-b' },
    { teamId: 'team-1', projectId: 'project-a' },
  ])
  expect(readPlanningEntityAuditScopes(createEntityEvent('moved', [
    { field: 'teamId', after: 'team-1' },
  ], { teamId: 'team-1' }))).toEqual([{ teamId: 'team-1' }, {}])
})

test('loads every Enterprise Project scope for Planning entity activity reads', async () => {
  const app = new Hono()
  app.get('*', (c) => c.json(shouldEvaluateAllPlanningHistoryScopes(c)))
  /** Reads the decision for one path. */
  const decide = async (path: string) => (await app.request(path)).json()

  expect(await decide('/api/planning/entities/entity-1/activity')).toBe(true)
  expect(await decide('/api/planning/updates')).toBe(true)
  expect(await decide('/api/planning/entities/entity-1')).toBe(false)
})

test('hides references to Planning entities the reader cannot see', () => {
  const event = createEntityEvent('moved', [
    { field: 'parentId', before: 'hidden-portfolio', after: 'visible-roadmap' },
    { field: 'title', before: 'Old', after: 'New' },
  ], { teamId: 'team-1', sourceEntityId: 'hidden-source' })

  const redacted = redactPlanningEntityAuditReferences(event, new Set(['visible-roadmap']))

  expect(redacted.changes).toEqual([
    { field: 'parentId', before: '[REDACTED]', after: 'visible-roadmap', redacted: true },
    { field: 'title', before: 'Old', after: 'New' },
  ])
  expect(redacted.metadata).toEqual({ teamId: 'team-1' })
  // The stored event is not changed.
  expect(event.metadata).toEqual({ teamId: 'team-1', sourceEntityId: 'hidden-source' })
})

test('shows the other end of a dependency only when the reader can see it', () => {
  const event = createEntityEvent('dependency-removed', [], {
    teamId: 'team-1',
    dependencyId: 'dependency-1',
    dependencyRole: 'predecessor',
    relatedEntityId: 'visible-successor',
  })

  const visible = toPlanningEntityActivityPageView({
    events: [redactPlanningEntityAuditReferences(event, new Set(['visible-successor']))],
  })
  const hidden = toPlanningEntityActivityPageView({
    events: [redactPlanningEntityAuditReferences(event, new Set())],
  })

  expect(visible.events[0]?.metadata).toEqual({
    teamId: 'team-1',
    dependencyId: 'dependency-1',
    dependencyRole: 'predecessor',
    relatedEntityId: 'visible-successor',
  })
  expect(hidden.events[0]?.metadata).toEqual({ teamId: 'team-1', dependencyId: 'dependency-1', dependencyRole: 'predecessor' })
})

/**
 * Creates a stored Milestone value for the audit event builder.
 *
 * @param overrides - Fields that differ from a planned Milestone on 2026-07-14.
 * @returns Milestone snapshot.
 */
function createMilestone(overrides: Partial<PlanningEntityTransactionSnapshot> = {}): PlanningEntityTransactionSnapshot {
  return {
    id: 'milestone-1',
    type: 'milestone',
    title: 'Beta launch',
    teamId: 'team-1',
    projectId: 'project-1',
    ownerMemberKey: 'owner@example.com',
    status: 'planned',
    health: 'on-track',
    risk: 'none',
    progressMode: 'automatic',
    baseline: { startDate: '2026-07-14', endDate: '2026-07-14' },
    forecast: { startDate: '2026-07-14', endDate: '2026-07-14' },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  }
}

test('tells the Milestone watchers when it is completed or its day changes', () => {
  const previous = createMilestone()
  /** Builds the audit event of one update from the planned Milestone. */
  const updated = (entity: PlanningEntityTransactionSnapshot, action: PlanningEntityChangeAction = 'updated') =>
    createPlanningEntityAuditEvent({
      workspaceId: 'workspace-1',
      actorMemberKey: 'Editor@Example.com',
      result: { kind: 'entity', revision: 2, action, entity, previous },
    })

  const completed = updated(createMilestone({
    status: 'completed',
    forecast: { startDate: '2026-07-15', endDate: '2026-07-15' },
  }))
  expect(completed.eventType).toBe('planning-entity.milestone-completed')
  expect(completed.action).toBe('updated')
  expect(completed.metadata).toMatchObject({
    actorMemberKey: 'editor@example.com',
    teamId: 'team-1',
    projectId: 'project-1',
    deepLink: '/planning/timeline?entityId=milestone-1',
    notificationTitle: 'Beta launch',
    notificationCandidates: [],
  })
  expect(updated(createMilestone({ forecast: { startDate: '2026-07-21', endDate: '2026-07-21' } })).eventType)
    .toBe('planning-entity.milestone-rescheduled')
  expect(updated(createMilestone({ baseline: { startDate: '2026-07-07', endDate: '2026-07-07' } })).eventType)
    .toBe('planning-entity.milestone-rescheduled')

  // Other edits, other entities, and other actions stay plain entity events without recipients.
  for (const event of [
    updated(createMilestone({ title: 'Beta' })),
    updated(createMilestone({ type: 'phase', status: 'completed' })),
    updated(createMilestone({ status: 'completed' }), 'moved'),
    updated(createMilestone({ status: 'completed', archivedAt: '2026-07-11T00:00:00.000Z' })),
  ]) {
    expect(event.eventType.startsWith('planning-entity.milestone-')).toBe(false)
    expect(event.metadata?.notificationCandidates).toBeUndefined()
  }
  expect(readPlanningMilestoneNotificationKind({
    action: 'updated',
    entity: createMilestone({ status: 'completed' }),
    previous: createMilestone({ status: 'completed' }),
  })).toBeUndefined()
})
