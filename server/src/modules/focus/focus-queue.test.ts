import {
  FOCUS_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type ApprovalRequest,
  type CanonicalWorkItem,
  type FocusItem,
  type FocusPolicy,
  type FocusPolicyTarget,
  type FocusQueueResponse,
  type PlanningSnapshot,
} from '@mukuroji/contracts'
import { describe, expect, test } from 'bun:test'
import type { NotificationItem } from '../notifications'
import type { FocusSnoozeRecord } from './focus-state'
import {
  createFocusCauseFingerprint,
  createFocusQueue,
  resolveFocusEffectivePolicies,
  type FocusRelationGraphSource,
} from './focus-queue'

/** Optional canonical sources and recipient state used by test projections. */
type QueueFixture = {
  /** Canonical Work Items supplied to the projector. */
  workItems: readonly CanonicalWorkItem[]
  /** Optional ACL-filtered Planning snapshot. */
  planning?: PlanningSnapshot
  /** Optional authoritative semantic relation graphs. */
  relationGraphs?: readonly FocusRelationGraphSource[]
  /** Optional current-reviewer approval requests. */
  approvals?: readonly ApprovalRequest[]
  /** Optional permission-filtered notification events. */
  notifications?: readonly NotificationItem[]
  /** Optional Team policy overrides. */
  teamPolicies?: readonly FocusPolicy[]
  /** Optional current-user policy override. */
  userPolicy?: FocusPolicy
  /** Optional persisted snooze or tombstone records. */
  snoozes?: readonly FocusSnoozeRecord[]
  /** Optional write-state replacements keyed by Team-qualified Work Item identity. */
  canWrite?: Readonly<Record<string, boolean>>
  /** Optional complete watch-permission map; omission grants fixtures permission by default. */
  canWatch?: Readonly<Record<string, boolean>>
  /** Optional watcher-state replacements keyed by Team-qualified Work Item identity. */
  watching?: Readonly<Record<string, boolean>>
  /** Optional evaluation instant. */
  now?: string
  /** Optional viewer key used to verify identity normalization. */
  viewerMemberKey?: string
}

describe('Focus queue projection', () => {
  test('uses real visible unresolved predecessors instead of a priority proxy', () => {
    const predecessor = createWorkItem('predecessor', 'other-member')
    const successor = createWorkItem('successor')
    const dependency: PlanningSnapshot['workItemDependencies'][number] = {
      id: 'dependency-1',
      predecessor: { teamId: 'team-a', workItemId: predecessor.id },
      successor: { teamId: 'team-a', workItemId: successor.id },
      type: 'finish-to-start',
      lagDays: 0,
      createdAt: '2026-08-09T09:00:00.000Z',
      updatedAt: '2026-08-09T09:00:00.000Z',
    }
    const queue = projectQueue({
      workItems: [predecessor, successor],
      planning: createPlanningSnapshot([predecessor, successor], [dependency]),
    })
    const blocked = findFocusItem(queue, successor.id)

    expect(blocked.section).toBe('waiting')
    expect(blocked.actionability).toEqual({ actionable: false, reasons: ['blocked'] })
    expect(blocked.signals.map((signal) => signal.type)).toEqual(['blocker'])
    expect(blocked.signals[0]?.source.id).toBe(
      'dependency-1:occurred-at:2026-08-09T09%3A00%3A00.000Z',
    )
    expect(queue.metrics.blocked).toBe(1)

    const completedPredecessor = createWorkItem(
      'predecessor',
      'other-member',
      'medium',
      'completed',
    )
    const unblockedQueue = projectQueue({
      workItems: [completedPredecessor, successor],
      planning: createPlanningSnapshot(
        [completedPredecessor, successor],
        [dependency],
      ),
    })
    expect(findOptionalFocusItem(unblockedQueue, successor.id)).toBeUndefined()
    expect(unblockedQueue.metrics.blocked).toBe(0)
  })

  test('keeps review and mention actions available when a Work Item is blocked', () => {
    const predecessor = createWorkItem('review-predecessor', 'other-member')
    const successor = createWorkItem('blocked-review', 'viewer')
    const dependency: PlanningSnapshot['workItemDependencies'][number] = {
      id: 'review-blocker',
      predecessor: { teamId: 'team-a', workItemId: predecessor.id },
      successor: { teamId: 'team-a', workItemId: successor.id },
      type: 'finish-to-start',
      lagDays: 0,
      createdAt: '2026-08-09T09:00:00.000Z',
      updatedAt: '2026-08-09T09:00:00.000Z',
    }
    const item = findFocusItem(projectQueue({
      workItems: [predecessor, successor],
      planning: createPlanningSnapshot([predecessor, successor], [dependency]),
      notifications: [createMentionNotification(successor, 'blocked-mention')],
      canWrite: { [createTestWorkItemKey(successor)]: false },
    }), successor.id)

    expect(item.actionability).toEqual({ actionable: true, reasons: [] })
    expect(item.section).toBe('now')
  })

  test('deduplicates equivalent semantic and schedule blocker sources', () => {
    const predecessor = createWorkItem('semantic-predecessor', 'other-member')
    const baseSuccessor = createWorkItem('semantic-successor')
    const successor: CanonicalWorkItem = {
      ...baseSuccessor,
      relationIds: [`blockedBy:${predecessor.id}`],
    }
    const dependency: PlanningSnapshot['workItemDependencies'][number] = {
      id: 'schedule-copy-of-semantic-blocker',
      predecessor: { teamId: 'team-a', workItemId: predecessor.id },
      successor: { teamId: 'team-a', workItemId: successor.id },
      type: 'finish-to-start',
      lagDays: 0,
      createdAt: '2026-08-09T09:00:00.000Z',
      updatedAt: '2026-08-09T09:00:00.000Z',
    }
    const queue = projectQueue({
      workItems: [predecessor, successor],
      planning: createPlanningSnapshot([predecessor, successor], [dependency]),
      relationGraphs: [createRelationGraphSource(
        predecessor,
        successor,
        4,
        '2026-08-09T08:30:00.000Z',
      )],
    })
    const blockerSignals = findFocusItem(queue, successor.id).signals.filter((signal) =>
      signal.type === 'blocker'
    )

    expect(blockerSignals).toHaveLength(1)
    expect(blockerSignals[0]?.source.kind).toBe('work-item-relation')
    expect(blockerSignals[0]?.source.occurredAt).toBe('2026-08-09T08:30:00.000Z')
  })

  test('resurfaces a semantic blocker recreated after an exact-cause snooze', () => {
    const predecessor = createWorkItem('recurring-predecessor', 'other-member')
    const baseSuccessor = createWorkItem('recurring-successor')
    const successor: CanonicalWorkItem = {
      ...baseSuccessor,
      relationIds: [`blockedBy:${predecessor.id}`],
    }
    const firstGraph = createRelationGraphSource(
      predecessor,
      successor,
      1,
      '2026-08-09T08:30:00.000Z',
    )
    const initial = projectQueue({
      workItems: [predecessor, successor],
      relationGraphs: [firstGraph],
    })
    const initialItem = findFocusItem(initial, successor.id)
    const snooze: FocusSnoozeRecord = {
      teamId: successor.teamId,
      workItemId: successor.id,
      version: 2,
      causeFingerprint: createFocusCauseFingerprint(initialItem.signals),
      snoozedUntil: '2026-08-10T12:00:00.000Z',
      updatedAt: '2026-08-09T10:00:00.000Z',
    }

    expect(findFocusItem(projectQueue({
      workItems: [predecessor, successor],
      relationGraphs: [firstGraph],
      snoozes: [snooze],
    }), successor.id).section).toBe('snoozed')

    const recurrent = findFocusItem(projectQueue({
      workItems: [predecessor, successor],
      relationGraphs: [createRelationGraphSource(
        predecessor,
        successor,
        3,
        '2026-08-09T11:00:00.000Z',
      )],
      snoozes: [snooze],
    }), successor.id)
    expect(recurrent.section).toBe('waiting')
    expect(recurrent.snoozedUntil).toBeUndefined()
    expect(recurrent.signals[0]?.source.occurredAt).toBe('2026-08-09T11:00:00.000Z')
  })

  test('omits relation-only blockers when source occurrence evidence is unavailable', () => {
    const predecessor = createWorkItem('legacy-predecessor', 'other-member')
    const successor: CanonicalWorkItem = {
      ...createWorkItem('legacy-successor'),
      relationIds: [`blockedBy:${predecessor.id}`],
    }

    const queue = projectQueue({ workItems: [predecessor, successor] })

    expect(findOptionalFocusItem(queue, successor.id)).toBeUndefined()
  })

  test('deduplicates mention events and ranks overdue reviews transparently', () => {
    const workItem = createWorkItem(
      'review-me',
      'other-member',
      'medium',
      'started',
      '2026-08-08',
    )
    const approval: ApprovalRequest = {
      id: 'approval-1',
      teamId: 'team-a',
      issueId: workItem.id,
      revision: 4,
      status: 'pending',
      reviewers: [{ memberKey: ' Viewer ', status: 'pending' }],
      dueAt: '2026-08-08T12:00:00.000Z',
      requestedByMemberKey: 'requester',
      requestedByKind: 'member',
      createdAt: '2026-08-09T08:00:00.000Z',
      updatedAt: '2026-08-09T08:00:00.000Z',
      capabilities: { canDecide: true, canCancel: false },
      subjectType: 'work-item',
    }
    const notification: NotificationItem = {
      ...createMentionNotification(workItem, 'notification-1'),
      state: 'read',
    }
    const duplicateNotification: NotificationItem = {
      ...notification,
      id: 'notification-duplicate',
      state: 'read',
    }
    const archivedNotification: NotificationItem = {
      ...notification,
      id: 'notification-archived',
      state: 'archived',
    }
    const queue = projectQueue({
      workItems: [workItem],
      approvals: [approval],
      notifications: [notification, duplicateNotification, archivedNotification],
      canWrite: { [createTestWorkItemKey(workItem)]: false },
      viewerMemberKey: 'VIEWER',
    })
    const item = findFocusItem(queue, workItem.id)

    expect(item.section).toBe('now')
    expect(item.signals.map((signal) => signal.type)).toEqual([
      'overdue',
      'review-request',
      'mention',
    ])
    expect(item.signals.filter((signal) => signal.type === 'mention')).toHaveLength(1)
    expect(item.rank.score).toBe(220)
    expect(item.rank.components).toEqual([
      expect.objectContaining({ signalType: 'overdue', weight: 90, contribution: 90 }),
      expect.objectContaining({ signalType: 'review-request', weight: 85, contribution: 85 }),
      expect.objectContaining({ signalType: 'mention', weight: 45, contribution: 45 }),
    ])
    expect(item.actionability).toEqual({ actionable: true, reasons: [] })
    expect(queue.viewerMemberKey).toBe('viewer')
  })

  test('keeps mention attention after Inbox read or archive presentation changes', () => {
    const workItem = createWorkItem('archived-mention', 'other-member')
    const archivedNotification: NotificationItem = {
      ...createMentionNotification(workItem, 'archived-notification'),
      deepLink: '/\\evil.example/hidden-source',
      state: 'archived',
    }
    const item = findFocusItem(projectQueue({
      workItems: [workItem],
      notifications: [archivedNotification],
      canWrite: { [createTestWorkItemKey(workItem)]: false },
    }), workItem.id)

    expect(item.signals.map((signal) => signal.type)).toEqual(['mention'])
    expect(item.signals[0]?.source.eventId).toBe(archivedNotification.eventId)
    expect(item.signals[0]?.permission.canOpenSource).toBe(true)
    expect(item.signals[0]?.source.deepLink).toBe(
      '/inbox?eventId=mention-event-1&filter=archived',
    )
    expect(item.signals[0]?.resolution.condition).toBe('source-removed')
  })

  test('projects an owned pending approval aggregate as external waiting work', () => {
    const baseWorkItem = createWorkItem('awaiting-approval')
    const workItem: CanonicalWorkItem = {
      ...baseWorkItem,
      approvalSummary: {
        pendingCount: 2,
        overdueCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        changesRequestedCount: 0,
        nextDueAt: '2026-08-10T12:00:00.000Z',
        updatedAt: '2026-08-09T10:30:00.000Z',
      },
    }
    const item = findFocusItem(projectQueue({ workItems: [workItem] }), workItem.id)

    expect(item.signals.map((signal) => signal.type)).toEqual(['approval'])
    expect(item.rank.score).toBe(60)
    expect(item.section).toBe('waiting')
    expect(item.actionability).toEqual({
      actionable: false,
      reasons: ['awaiting-external-action'],
    })
    expect(item.capabilities.assign).toBe(false)
    expect(item.signals[0]?.source.occurredAt).toBe('2026-08-09T10:30:00.000Z')
    expect(item.signals[0]?.freshness.sourceVersion).toBeUndefined()
  })

  test('projects SLA breaches and near active cycle boundaries from effective policy', () => {
    const workItem = createWorkItem(
      'cycle-item',
      'viewer',
      'medium',
      'started',
      '',
      2,
      '2026-08-09T08:00:00.000Z',
      '2026-08-05T08:00:00.000Z',
    )
    const cycle: PlanningSnapshot['entities'][number] = {
      id: 'cycle-1',
      type: 'cycle',
      title: 'Current cycle',
      ownerMemberKey: 'viewer',
      status: 'active',
      health: 'on-track',
      rollupHealth: 'on-track',
      risk: 'none',
      progressMode: 'automatic',
      progress: 50,
      linkedWorkItemCount: 1,
      baseline: { startDate: '2026-08-01', endDate: '2026-08-10' },
      forecast: { startDate: '2026-08-01', endDate: '2026-08-10' },
      statusUpdates: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    }
    const planning = createPlanningSnapshot([workItem], [], [{
      teamId: 'team-a',
      workItemId: workItem.id,
      cycleId: cycle.id,
      goalIds: [],
      createdAt: '2026-08-01T00:00:00.000Z',
    }], [cycle])
    const queue = projectQueue({ workItems: [workItem], planning })
    const item = findFocusItem(queue, workItem.id)

    expect(item.signals.map((signal) => signal.type)).toEqual(['sla', 'cycle'])
    expect(item.rank.score).toBe(100)
    expect(item.section).toBe('now')
    expect(item.signals.find((signal) => signal.type === 'sla')?.source.occurredAt)
      .toBe('2026-08-08T08:00:00.000Z')
    const slaSignal = item.signals.find((signal) => signal.type === 'sla')
    const effectivePolicy = queue.effectivePolicies.find((policy) =>
      policy.id === item.effectivePolicyId
    )
    expect(slaSignal?.source.id).toContain(effectivePolicy?.fingerprint)
    expect(slaSignal?.freshness.sourceVersion).toBeUndefined()
  })

  test('applies Team overrides before user overrides and preserves deterministic Team order', () => {
    const teamPolicy = createPolicy(
      'team-policy',
      { type: 'team', teamId: 'team-a' },
      2,
      { weights: { urgent: 120 }, dueSoonDays: 8 },
    )
    const userPolicy = createPolicy(
      'user-policy',
      { type: 'user' },
      3,
      { weights: { urgent: 130 }, dueSoonDays: 5 },
    )
    const policies = resolveFocusEffectivePolicies({
      teamIds: ['team-b', 'team-a', 'team-a'],
      teamPolicies: [teamPolicy],
      userPolicy,
    })

    expect(policies.map((policy) => policy.teamId)).toEqual(['team-a', 'team-b'])
    expect(policies[0]?.settings.weights.urgent).toBe(130)
    expect(policies[0]?.settings.dueSoonDays).toBe(5)
    expect(policies[0]?.provenance.map((entry) => entry.source)).toEqual([
      'default',
      'team',
      'user',
    ])
    expect(policies[1]?.settings.weights.urgent).toBe(130)
    expect(policies[1]?.provenance.map((entry) => entry.source)).toEqual([
      'default',
      'user',
    ])
  })

  test('keeps snooze across unrelated revisions and wakes for a changed cause set', () => {
    const original: CanonicalWorkItem = {
      ...createWorkItem('snoozed', 'viewer', 'high'),
      priorityUpdatedAt: '2026-08-09T08:30:00.000Z',
    }
    const initial = projectQueue({ workItems: [original] })
    const initialItem = findFocusItem(initial, original.id)
    const fingerprint = createFocusCauseFingerprint(initialItem.signals)
    const refreshedItem = findFocusItem(projectQueue({
      workItems: [original],
      now: '2026-08-09T12:01:00.000Z',
    }), original.id)
    expect(refreshedItem.version).toBe(initialItem.version)
    expect(fingerprint).toMatch(/^focus-cause-v2-[0-9a-f]{64}$/u)
    const snooze: FocusSnoozeRecord = {
      teamId: original.teamId,
      workItemId: original.id,
      version: 7,
      causeFingerprint: fingerprint,
      snoozedUntil: '2026-08-10T12:00:00.000Z',
      updatedAt: '2026-08-09T10:00:00.000Z',
    }
    const snoozedQueue = projectQueue({ workItems: [original], snoozes: [snooze] })
    const snoozedItem = findFocusItem(snoozedQueue, original.id)

    expect(snoozedItem.section).toBe('snoozed')
    expect(snoozedItem.snoozeRevision).toBe(7)
    expect(snoozedItem.snoozedUntil).toBe(snooze.snoozedUntil)

    const unrelatedRevision: CanonicalWorkItem = {
      ...original,
      revision: 2,
      title: 'Unrelated title edit',
      updatedAt: '2026-08-09T11:00:00.000Z',
    }
    const revisedQueue = projectQueue({ workItems: [unrelatedRevision], snoozes: [snooze] })
    const revisedItem = findFocusItem(revisedQueue, unrelatedRevision.id)
    expect(revisedItem.section).toBe('snoozed')
    expect(revisedItem.snoozeRevision).toBe(7)
    expect(revisedItem.version).not.toBe(snoozedItem.version)

    const recurrent: CanonicalWorkItem = {
      ...unrelatedRevision,
      revision: 3,
      priorityUpdatedAt: '2026-08-09T11:30:00.000Z',
      updatedAt: '2026-08-09T11:30:00.000Z',
    }
    const recurrentItem = findFocusItem(projectQueue({
      workItems: [recurrent],
      snoozes: [snooze],
    }), recurrent.id)
    expect(recurrentItem.section).toBe('now')
    expect(recurrentItem.snoozedUntil).toBeUndefined()

    const changedCause = createWorkItem(
      'snoozed',
      'viewer',
      'high',
      'started',
      '2026-08-10',
      4,
      '2026-08-09T11:30:00.000Z',
    )
    changedCause.dueDateUpdatedAt = '2026-08-09T11:30:00.000Z'
    const changedQueue = projectQueue({ workItems: [changedCause], snoozes: [snooze] })
    const changedItem = findFocusItem(changedQueue, changedCause.id)
    expect(changedItem.section).toBe('now')
    expect(changedItem.snoozedUntil).toBeUndefined()

    const expiredQueue = projectQueue({
      workItems: [original],
      snoozes: [snooze],
      now: '2026-08-11T12:00:00.000Z',
    })
    expect(findFocusItem(expiredQueue, original.id).section).toBe('now')
  })

  test('versions the full Work Item snapshot with canonical object ordering', () => {
    const base: CanonicalWorkItem = {
      ...createWorkItem('aggregate-version', 'viewer', 'high'),
      priorityUpdatedAt: '2026-08-09T08:30:00.000Z',
      customFieldValues: { beta: 2, alpha: 1 },
      approvalSummary: {
        pendingCount: 1,
        overdueCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        changesRequestedCount: 0,
        updatedAt: '2026-08-09T09:30:00.000Z',
      },
    }
    const initial = findFocusItem(projectQueue({ workItems: [base] }), base.id)
    const reordered: CanonicalWorkItem = {
      ...base,
      customFieldValues: { alpha: 1, beta: 2 },
    }
    const reorderedItem = findFocusItem(
      projectQueue({ workItems: [reordered] }),
      reordered.id,
    )
    expect(reorderedItem.version).toBe(initial.version)

    const currentSummary = reordered.approvalSummary
    if (currentSummary === undefined) throw new Error('Expected approval summary fixture.')
    const changedDerivedSnapshot: CanonicalWorkItem = {
      ...reordered,
      approvalSummary: {
        ...currentSummary,
        approvedCount: 1,
      },
    }
    const changedItem = findFocusItem(
      projectQueue({ workItems: [changedDerivedSnapshot] }),
      changedDerivedSnapshot.id,
    )
    expect(changedItem.version).not.toBe(initial.version)
  })

  test('places read-only active work in Waiting and terminal owned work in Done', () => {
    const readOnly = createWorkItem('read-only', 'viewer', 'high')
    const completed = createWorkItem('completed', 'viewer', 'medium', 'completed')
    const queue = projectQueue({
      workItems: [readOnly, completed],
      canWrite: { [createTestWorkItemKey(readOnly)]: false },
      canWatch: {},
    })

    expect(findFocusItem(queue, readOnly.id).actionability).toEqual({
      actionable: false,
      reasons: ['no-permitted-primary-action'],
    })
    expect(findFocusItem(queue, completed.id).capabilities.changeStatus).toBe(true)
    expect(findFocusItem(queue, readOnly.id).capabilities.watch).toBe(false)
    expect(findFocusItem(queue, readOnly.id).section).toBe('waiting')
    expect(findFocusItem(queue, completed.id).section).toBe('done')
    expect(queue.sections.map((section) => section.section)).toEqual([
      'now',
      'next',
      'waiting',
      'snoozed',
      'done',
    ])
  })

  test('retains Done inclusively for 30 days without aging active signals out', () => {
    const recentTerminal = createWorkItem(
      'recent-terminal',
      'viewer',
      'medium',
      'completed',
      '',
      1,
      '2026-07-20T12:00:00.000Z',
      '2026-07-01T12:00:00.000Z',
    )
    const boundaryTerminal = createWorkItem(
      'boundary-terminal',
      'viewer',
      'medium',
      'canceled',
      '',
      1,
      '2026-07-10T12:00:00.000Z',
      '2026-07-01T12:00:00.000Z',
    )
    const oldTerminal = createWorkItem(
      'old-terminal',
      'viewer',
      'medium',
      'completed',
      '',
      1,
      '2026-07-10T11:59:59.999Z',
      '2026-07-01T12:00:00.000Z',
    )
    const oldActive: CanonicalWorkItem = {
      ...createWorkItem(
        'old-active',
        'viewer',
        'high',
        'started',
        '',
        1,
        '2025-01-01T12:00:00.000Z',
        '2025-01-01T12:00:00.000Z',
      ),
      priorityUpdatedAt: '2025-01-01T12:00:00.000Z',
    }
    const queue = projectQueue({
      workItems: [recentTerminal, boundaryTerminal, oldTerminal, oldActive],
      now: '2026-08-09T12:00:00.000Z',
    })

    expect(findFocusItem(queue, recentTerminal.id).section).toBe('done')
    expect(findFocusItem(queue, boundaryTerminal.id).section).toBe('done')
    expect(findOptionalFocusItem(queue, oldTerminal.id)).toBeUndefined()
    expect(findFocusItem(queue, oldActive.id).section).toBe('now')
  })

  test('orders equal-rank items by stable tie evidence', () => {
    const later = createWorkItem(
      'z-item',
      'viewer',
      'high',
      'started',
      '',
      1,
      '2026-08-09T10:00:00.000Z',
    )
    const earlier = createWorkItem(
      'a-item',
      'viewer',
      'high',
      'started',
      '',
      1,
      '2026-08-09T09:00:00.000Z',
    )
    const first = projectQueue({ workItems: [later, earlier] })
    const second = projectQueue({ workItems: [earlier, later] })
    const firstOrder = first.sections
      .find((section) => section.section === 'now')
      ?.items.map((item) => item.workItem.id)
    const secondOrder = second.sections
      .find((section) => section.section === 'now')
      ?.items.map((item) => item.workItem.id)

    expect(firstOrder).toEqual(['a-item', 'z-item'])
    expect(secondOrder).toEqual(firstOrder)
  })
})

/**
 * Projects a queue fixture with stable defaults.
 *
 * @param fixture - Canonical sources and optional recipient state.
 * @returns Focus queue response.
 */
function projectQueue(fixture: QueueFixture): FocusQueueResponse {
  const canWriteByWorkItemKey = Object.fromEntries(
    fixture.workItems.map((workItem) => [createTestWorkItemKey(workItem), true]),
  )
  const canWatchByWorkItemKey = Object.fromEntries(
    fixture.workItems.map((workItem) => [createTestWorkItemKey(workItem), true]),
  )
  return createFocusQueue({
    now: fixture.now ?? '2026-08-09T12:00:00.000Z',
    viewerMemberKey: fixture.viewerMemberKey ?? 'viewer',
    workItems: fixture.workItems,
    planning: fixture.planning ?? createPlanningSnapshot(fixture.workItems),
    ...(fixture.relationGraphs === undefined
      ? {}
      : { relationGraphs: fixture.relationGraphs }),
    reviewerApprovals: fixture.approvals ?? [],
    notifications: fixture.notifications ?? [],
    teamPolicies: fixture.teamPolicies ?? [],
    ...(fixture.userPolicy === undefined ? {} : { userPolicy: fixture.userPolicy }),
    snoozeRecords: fixture.snoozes ?? [],
    canWriteByWorkItemKey: {
      ...canWriteByWorkItemKey,
      ...fixture.canWrite,
    },
    canWatchByWorkItemKey: fixture.canWatch ?? canWatchByWorkItemKey,
    watchingByWorkItemKey: fixture.watching ?? {},
  })
}

/**
 * Creates one authoritative semantic blocker graph for a Team.
 *
 * @param predecessor - Visible blocking Work Item.
 * @param successor - Visible blocked Work Item.
 * @param graphRevision - Monotonic relation graph generation.
 * @param createdAt - Canonical relation occurrence time.
 * @returns Permission-filtered semantic relation graph source.
 */
function createRelationGraphSource(
  predecessor: CanonicalWorkItem,
  successor: CanonicalWorkItem,
  graphRevision: number,
  createdAt: string,
): FocusRelationGraphSource {
  return {
    teamId: successor.teamId,
    graphRevision,
    relations: [{
      sourceWorkItemId: successor.id,
      targetWorkItemId: predecessor.id,
      type: 'blockedBy',
      createdAt,
    }],
  }
}

/**
 * Creates a canonical Work Item fixture.
 *
 * @param id - Team-local identifier.
 * @param assigneeUserId - Assigned member key.
 * @param priority - Canonical priority.
 * @param statusCategory - Canonical workflow category.
 * @param dueDate - Optional local deadline.
 * @param revision - Canonical revision.
 * @param updatedAt - Last update timestamp.
 * @param createdAt - Creation timestamp.
 * @returns Canonical Work Item.
 */
function createWorkItem(
  id: string,
  assigneeUserId = 'viewer',
  priority: CanonicalWorkItem['priority'] = 'medium',
  statusCategory: CanonicalWorkItem['statusCategory'] = 'started',
  dueDate = '',
  revision = 1,
  updatedAt = '2026-08-09T09:00:00.000Z',
  createdAt = '2026-08-09T08:00:00.000Z',
): CanonicalWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision,
    id,
    teamId: 'team-a',
    title: id,
    assigneeUserId,
    creatorMemberKey: 'creator',
    dueDate,
    schedule: dueDate === ''
      ? {
          mode: 'unscheduled',
          calendarPolicy: {
            timeZone: 'UTC',
            workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
            holidays: [],
          },
        }
      : {
          mode: 'due-date',
          dueDate,
          calendarPolicy: {
            timeZone: 'UTC',
            workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
            holidays: [],
          },
        },
    priority,
    workflowStatusId: statusCategory,
    statusCategory,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: {},
    relationIds: [],
    createdAt,
    updatedAt,
    source: 'dynamodb',
  }
}

/**
 * Creates a Planning snapshot consistent enough for Focus projection tests.
 *
 * @param workItems - Canonical Work Items projected into Planning.
 * @param dependencies - Visible Work Item schedule dependencies.
 * @param links - Visible Work Item planning links.
 * @param entities - Visible Planning entities.
 * @returns ACL-filtered Planning snapshot.
 */
function createPlanningSnapshot(
  workItems: readonly CanonicalWorkItem[],
  dependencies: PlanningSnapshot['workItemDependencies'] = [],
  links: PlanningSnapshot['workItemLinks'] = [],
  entities: PlanningSnapshot['entities'] = [],
): PlanningSnapshot {
  const planningWorkItems = workItems.map((workItem) => ({
    id: workItem.id,
    revision: workItem.revision,
    teamId: workItem.teamId,
    title: workItem.title,
    statusCategory: workItem.statusCategory,
    dueDate: workItem.dueDate,
    schedule: workItem.schedule,
  }))
  const unresolvedBlockerCount = dependencies.filter((dependency) => {
    const predecessor = planningWorkItems.find((workItem) =>
      workItem.teamId === dependency.predecessor.teamId &&
      workItem.id === dependency.predecessor.workItemId
    )
    return predecessor !== undefined &&
      predecessor.statusCategory !== 'completed' &&
      predecessor.statusCategory !== 'canceled'
  }).length
  return {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    revision: 3,
    entities: [...entities],
    dependencies: [],
    workItemDependencies: [...dependencies],
    workItemLinks: [...links],
    workItems: planningWorkItems,
    criticalPath: { entityIds: [], totalDurationDays: 0, slackByEntityId: {} },
    workItemDependencySummary: {
      criticalPath: { workItems: [], totalDurationDays: 0, slackByWorkItemKey: {} },
      conflicts: [],
      unresolvedBlockerCount,
      affectedProjects: [],
      affectedProjectIds: [],
      affectedMilestoneIds: [],
    },
    updatedAt: '2026-08-09T09:00:00.000Z',
  }
}

/**
 * Creates one durable mention notification fixture.
 *
 * @param workItem - Mentioned Work Item.
 * @param id - Notification row identifier.
 * @returns Visible mention notification.
 */
function createMentionNotification(
  workItem: CanonicalWorkItem,
  id: string,
): NotificationItem {
  return {
    id,
    eventId: 'mention-event-1',
    eventType: 'comment.created',
    reasons: ['mention'],
    teamId: workItem.teamId,
    issueId: workItem.id,
    occurredAt: '2026-08-09T09:30:00.000Z',
    state: 'unread',
    deepLink: `/teams/${workItem.teamId}/issues?issueId=${workItem.id}`,
  }
}

/**
 * Creates a valid stored Focus policy fixture.
 *
 * @param id - Stable policy identifier.
 * @param target - User or Team target.
 * @param version - Stored policy version.
 * @param overrides - Complete override replacement.
 * @returns Focus policy fixture.
 */
function createPolicy(
  id: string,
  target: FocusPolicyTarget,
  version: number,
  overrides: FocusPolicy['overrides'],
): FocusPolicy {
  return {
    schemaVersion: FOCUS_SCHEMA_VERSION,
    id,
    target,
    version,
    overrides,
    updatedAt: '2026-08-09T09:00:00.000Z',
  }
}

/**
 * Returns one projected item or fails the test with a precise error.
 *
 * @param queue - Projected Focus response.
 * @param workItemId - Team-local Work Item identifier.
 * @returns Matching Focus item.
 */
function findFocusItem(queue: FocusQueueResponse, workItemId: string): FocusItem {
  const item = findOptionalFocusItem(queue, workItemId)
  if (item !== undefined) return item
  throw new Error(`Focus item ${workItemId} was not projected.`)
}

/**
 * Finds a projected item without requiring its presence.
 *
 * @param queue - Projected Focus response.
 * @param workItemId - Team-local Work Item identifier.
 * @returns Matching item or undefined when the source has no active reason.
 */
function findOptionalFocusItem(
  queue: FocusQueueResponse,
  workItemId: string,
): FocusItem | undefined {
  for (const section of queue.sections) {
    const item = section.items.find((candidate) => candidate.workItem.id === workItemId)
    if (item !== undefined) return item
  }
  return undefined
}

/**
 * Creates the in-memory map key documented by the queue input contract.
 *
 * @param workItem - Canonical Work Item.
 * @returns Team-qualified state key.
 */
function createTestWorkItemKey(workItem: CanonicalWorkItem): string {
  return `${workItem.teamId}\0${workItem.id}`
}
