import type { UpdateFeedResponse } from '@mukuroji/contracts'

/** Representative independent health/submission and personal read states for UI verification. */
export const updateFeedFixture: UpdateFeedResponse = {
  view: 'for-me', revision: 7, total: 3, truncated: false,
  entries: [
    { target: { type: 'project', teamId: 'core-team', projectId: 'refero' }, title: 'Customer onboarding', health: 'on-track', updateState: 'overdue', relevance: 3, reasons: ['update-owner', 'latest-author'], readState: { read: false, revision: 0 }, latestUpdate: { id: 'update-1', version: 1, health: 'on-track', risk: 'low', summary: 'The pilot is ready for the next customer cohort. The support handoff is complete; the next report is due.', authorMemberKey: 'publisher@example.com', createdAt: '2026-08-10T09:00:00Z', coveredDueAt: '2026-08-10T09:00:00Z', progressSnapshot: { percent: 65, linkedWorkItemCount: 12 } } },
    { target: { type: 'initiative', entityId: 'reliability' }, title: 'Reliability across customer workspaces', health: 'at-risk', updateState: 'current', relevance: 2, reasons: ['update-owner'], readState: { read: true, revision: 1 }, latestUpdate: { id: 'update-1', version: 2, health: 'at-risk', risk: 'high', summary: 'Load testing found a capacity limit. The team is validating the mitigation before expanding the rollout.', authorMemberKey: 'engineer@example.com', createdAt: '2026-08-09T09:00:00Z', coveredDueAt: '2026-08-09T09:00:00Z', progressSnapshot: { percent: 40, linkedWorkItemCount: 8 } } },
    { target: { type: 'initiative', entityId: 'research' }, title: 'Next quarter research', health: 'unknown', updateState: 'missing', relevance: 2, reasons: ['update-owner'] },
  ],
}
