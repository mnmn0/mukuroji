import type { ProjectRaidEntry } from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import { createFocusProjectLogEntries } from './focus-project-log'

/**
 * Builds one open entry owned by the viewer.
 *
 * @param overrides - Fields replacing the defaults.
 * @returns The entry.
 */
function entry(overrides: Partial<ProjectRaidEntry>): ProjectRaidEntry {
  return {
    id: 'entry',
    kind: 'risk',
    title: 'Vendor delay',
    probability: 3,
    impact: 3,
    ownerMemberId: 'viewer@example.com',
    status: 'open',
    revision: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

test('lists overdue reviews and pending change requests the viewer owns, most severe first', () => {
  const source = (value: ProjectRaidEntry) => ({ teamId: 'core', projectId: 'web app', projectTitle: 'Web', entry: value })
  const items = createFocusProjectLogEntries([
    source(entry({ id: 'overdue-medium', reviewDueDate: '2026-11-20' })),
    source(entry({ id: 'due-today', reviewDueDate: '2026-11-23' })),
    source(entry({ id: 'no-review' })),
    source(entry({ id: 'other-owner', reviewDueDate: '2026-11-01', ownerMemberId: 'someone@example.com' })),
    source(entry({ id: 'closed', reviewDueDate: '2026-11-01', status: 'closed' })),
    source(entry({ id: 'change', kind: 'change-request', probability: undefined, impact: 5, title: 'Add export' })),
    source(entry({ id: 'issue-overdue', kind: 'issue', probability: undefined, impact: 4, reviewDueDate: '2026-11-22', ownerMemberId: ' Viewer@example.com' })),
  ], 'viewer@example.com', '2026-11-23')

  expect(items.map((item) => [item.entryId, item.reason, item.severity])).toEqual([
    ['change', 'decision-pending', 'critical'],
    ['issue-overdue', 'review-overdue', 'high'],
    ['overdue-medium', 'review-overdue', 'medium'],
  ])
  expect(items[2]).toEqual({
    id: 'project-log:core:web%20app:overdue-medium',
    teamId: 'core',
    projectId: 'web app',
    projectTitle: 'Web',
    entryId: 'overdue-medium',
    kind: 'risk',
    title: 'Vendor delay',
    severity: 'medium',
    reason: 'review-overdue',
    reviewDueDate: '2026-11-20',
    deepLink: '/projects/web%20app/issues?teamId=core&tab=permissions',
  })
})
