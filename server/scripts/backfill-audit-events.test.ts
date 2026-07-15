import { describe, expect, test } from 'bun:test'
import { mapCurrentTeamIssue } from './backfill-audit-events'

function createCanonicalWorkItem(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    revision: 1,
    workflowSchemaVersion: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'release-checklist',
    sortOrder: 10,
    title: 'Release checklist',
    description: 'Verify the release candidate.',
    assigneeUserId: 'member@example.com',
    creatorMemberKey: 'creator@example.com',
    workflowStatusId: 'review',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/07/31',
    priority: 'high',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  }
}

describe('audit backfill canonical Work Item mapping', () => {
  test('includes the required creator as a redacted snapshot change', () => {
    const event = mapCurrentTeamIssue(createCanonicalWorkItem())

    expect(event).toBeDefined()
    expect(event?.changes).toEqual(expect.arrayContaining([{
      field: 'creatorMemberKey',
      after: '[REDACTED]',
      redacted: true,
    }]))
  })

  test('rejects non-canonical Work Item rows instead of backfilling them', () => {
    expect(mapCurrentTeamIssue(createCanonicalWorkItem({ creatorMemberKey: undefined })))
      .toBeUndefined()
    expect(mapCurrentTeamIssue(createCanonicalWorkItem({ relationIds: undefined })))
      .toBeUndefined()
    expect(mapCurrentTeamIssue(createCanonicalWorkItem({ status: 'review' })))
      .toBeUndefined()
  })
})
