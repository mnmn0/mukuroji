import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createAuditEvent, createMutationAuditContext } from '../../modules/audit/audit'
import { shouldEvaluateAllPlanningHistoryScopes } from './planning-access'
import {
  readPlanningEntityAuditScopes,
  redactPlanningEntityAuditReferences,
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
