import { describe, expect, test } from 'bun:test'
import {
  isCanonicalWorkItemDueDate,
  isCanonicalWorkItemRecord,
  isCanonicalWorkItemRelationIds,
} from './canonical-work-item'

function createCanonicalWorkItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 1,
    workflowSchemaVersion: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core',
    directoryProjectId: 'workspace-1#project#platform',
    teamId: 'core',
    assignedProjectId: 'platform',
    issueId: 'example',
    sortOrder: 10,
    title: 'Example',
    description: 'Canonical Work Item',
    assigneeUserId: 'member@example.com',
    creatorMemberKey: 'creator@example.com',
    workflowStatusId: 'in-progress',
    statusCategory: 'started',
    customFieldValues: {
      estimate: 3,
      labels: ['backend', 'urgent'],
    },
    relationIds: ['blocks:blocked-item', 'related:related-item'],
    dueDate: '2026/07/31',
    priority: 'medium',
    createdAt: '2026-07-01T09:00:00.000Z',
    updatedAt: '2026-07-12T09:00:00.000Z',
    ...overrides,
  }
}

describe('canonical Work Item validation', () => {
  test('accepts assigned and unassigned strict canonical rows', () => {
    const unassigned = createCanonicalWorkItem()
    delete unassigned.assignedProjectId
    delete unassigned.directoryProjectId

    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem())).toBe(true)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({ sourceRequestId: 'req_20260716_example' })))
      .toBe(true)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      importRequestDigest: 'a'.repeat(64),
    }))).toBe(true)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      archivedAt: '2026-07-10T09:00:00.000Z',
      archivedBy: 'archiver@example.com',
    }))).toBe(true)
    expect(isCanonicalWorkItemRecord(unassigned)).toBe(true)
  })

  test('rejects an invalid request source reference', () => {
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({ sourceRequestId: '' }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({ sourceRequestId: 42 }))).toBe(false)
  })

  test('rejects legacy and response-only fields', () => {
    const forbiddenFields = [
      'assignee',
      'assigneeKey',
      'customFields',
      'migrationSource',
      'migrationSourceKey',
      'projectId',
      'source',
      'status',
      'titleKey',
      'workItemId',
    ]

    for (const field of forbiddenFields) {
      expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({ [field]: 'legacy' })))
        .toBe(false)
    }
  })

  test('rejects missing required canonical fields and invalid versions', () => {
    const requiredFields = [
      'schemaVersion',
      'revision',
      'workflowSchemaVersion',
      'directoryId',
      'directoryTeamId',
      'teamId',
      'issueId',
      'sortOrder',
      'title',
      'assigneeUserId',
      'creatorMemberKey',
      'workflowStatusId',
      'statusCategory',
      'customFieldValues',
      'relationIds',
      'dueDate',
      'priority',
      'createdAt',
      'updatedAt',
    ]

    for (const field of requiredFields) {
      const item = createCanonicalWorkItem()
      delete item[field]
      expect(isCanonicalWorkItemRecord(item)).toBe(false)
    }

    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({ schemaVersion: 2 }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({ revision: 0 }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({ revision: 1.5 }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({ workflowSchemaVersion: 2 })))
      .toBe(false)
  })

  test('requires exact and bidirectional project key consistency', () => {
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      directoryProjectId: 'workspace-1#project#other',
    }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      assignedProjectId: undefined,
    }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      directoryProjectId: undefined,
    }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      directoryTeamId: 'workspace-1#team#other',
    }))).toBe(false)
  })

  test('requires sorted unique and bounded canonical relation IDs', () => {
    expect(isCanonicalWorkItemRelationIds([])).toBe(true)
    expect(isCanonicalWorkItemRelationIds(['blocks:a', 'related:z'])).toBe(true)
    expect(isCanonicalWorkItemRelationIds(['related:z', 'blocks:a'])).toBe(false)
    expect(isCanonicalWorkItemRelationIds(['blocks:a', 'blocks:a'])).toBe(false)
    expect(isCanonicalWorkItemRelationIds(['unknown:a'])).toBe(false)
    expect(isCanonicalWorkItemRelationIds(['blocks: whitespace'])).toBe(false)
    expect(isCanonicalWorkItemRelationIds(Array.from(
      { length: 101 },
      (_, index) => `related:item-${String(index).padStart(3, '0')}`,
    ))).toBe(false)
  })

  test('requires canonical calendar dates and ordered UTC timestamps', () => {
    expect(isCanonicalWorkItemDueDate('2024/02/29')).toBe(true)
    expect(isCanonicalWorkItemDueDate('2024-02-29')).toBe(true)
    expect(isCanonicalWorkItemDueDate('2026/02/29')).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      dueDate: '2026-07-31',
    }))).toBe(true)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      dueDate: '2026/02/29',
    }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      dueDate: '2026/07-31',
    }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      createdAt: '2026-07-01T09:00:00Z',
    }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      updatedAt: '2026-06-30T09:00:00.000Z',
    }))).toBe(false)
  })

  test('requires canonical import and archive metadata', () => {
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      importRequestDigest: 'not-a-digest',
    }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      archivedAt: '2026-07-10T09:00:00.000Z',
    }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      archivedBy: 'archiver@example.com',
    }))).toBe(false)
    expect(isCanonicalWorkItemRecord(createCanonicalWorkItem({
      archivedAt: '2026-07-13T09:00:00.000Z',
      archivedBy: 'archiver@example.com',
    }))).toBe(false)
  })
})
