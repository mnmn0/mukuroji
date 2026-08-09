import {
  FOCUS_SCHEMA_VERSION,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  type FocusItem,
  type FocusQueueResponse,
  type FocusQueueSection,
  type FocusSignal,
  type FocusSignalResolutionCondition,
  type FocusSignalType,
  type ResolvedWorkItemConfiguration,
} from '@mukuroji/contracts'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'

const focusSignalWeightByType = {
  approval: 5,
  blocker: 10,
  cycle: 3,
  'due-soon': 4,
  mention: 5,
  overdue: 9,
  'review-request': 6,
  sla: 8,
  urgent: 8,
} satisfies Record<FocusSignalType, number>

/** Resolved Team configuration used by Focus stories and view tests. */
export const focusConfigurationFixture = {
  configuration: teamWorkItemConfigurationFixture,
} satisfies ResolvedWorkItemConfiguration

const nowBlockedItem = createFocusFixtureItem(
  'WI-194',
  'now',
  'Unblock the release approval flow',
  ['blocker', 'overdue', 'review-request'],
)
const nowMentionItem = createFocusFixtureItem(
  'WI-202',
  'now',
  'Answer the enterprise rollout question',
  ['mention', 'sla'],
)
const nextItem = createFocusFixtureItem(
  'WI-205',
  'next',
  'Prepare the onboarding experiment',
  ['due-soon', 'cycle'],
)
const waitingItem = {
  ...createFocusFixtureItem(
    'WI-207',
    'waiting',
    'Wait for legal approval',
    ['approval'],
  ),
  actionability: {
    actionable: false,
    reasons: ['awaiting-external-action'],
  },
} satisfies FocusItem
const snoozedItem = {
  ...createFocusFixtureItem(
    'WI-209',
    'snoozed',
    'Review post-launch metrics',
    ['due-soon'],
  ),
  snoozedUntil: '2026-08-11T00:00:00.000Z',
} satisfies FocusItem
const doneItem = {
  ...createFocusFixtureItem(
    'WI-190',
    'done',
    'Resolve the dependency incident',
    ['blocker'],
  ),
  actionability: {
    actionable: false,
    reasons: ['work-item-completed'],
  },
  workItem: {
    ...createFocusFixtureItem(
      'WI-190',
      'done',
      'Resolve the dependency incident',
      ['blocker'],
    ).workItem,
    statusCategory: 'completed',
    workflowStatusId: 'done',
  },
} satisfies FocusItem

/** Complete Focus response used by Storybook and focused tests. */
export const focusQueueResponseFixture = {
  effectivePolicies: [{
    baseSettings: {
      cycleDueSoonDays: 3,
      dueSoonDays: 3,
      nowScoreThreshold: 12,
      slaHours: 24,
      weights: {
        approval: focusSignalWeightByType.approval,
        blocker: focusSignalWeightByType.blocker,
        cycle: focusSignalWeightByType.cycle,
        dueSoon: focusSignalWeightByType['due-soon'],
        mention: focusSignalWeightByType.mention,
        overdue: focusSignalWeightByType.overdue,
        reviewRequest: focusSignalWeightByType['review-request'],
        sla: focusSignalWeightByType.sla,
        urgent: focusSignalWeightByType.urgent,
      },
    },
    fingerprint: 'policy-fingerprint-v3',
    id: 'effective-core-team',
    provenance: [
      { source: 'default', version: 1 },
      {
        policyId: 'team-policy-core',
        source: 'team',
        teamId: 'core-team',
        version: 2,
      },
      { policyId: 'user-policy-demo', source: 'user', version: 3 },
    ],
    settings: {
      cycleDueSoonDays: 3,
      dueSoonDays: 2,
      nowScoreThreshold: 12,
      slaHours: 24,
      weights: {
        approval: focusSignalWeightByType.approval,
        blocker: focusSignalWeightByType.blocker,
        cycle: focusSignalWeightByType.cycle,
        dueSoon: focusSignalWeightByType['due-soon'],
        mention: focusSignalWeightByType.mention,
        overdue: focusSignalWeightByType.overdue,
        reviewRequest: focusSignalWeightByType['review-request'],
        sla: focusSignalWeightByType.sla,
        urgent: focusSignalWeightByType.urgent,
      },
    },
    teamSettings: {
      cycleDueSoonDays: 3,
      dueSoonDays: 2,
      nowScoreThreshold: 12,
      slaHours: 24,
      weights: {
        approval: focusSignalWeightByType.approval,
        blocker: focusSignalWeightByType.blocker,
        cycle: focusSignalWeightByType.cycle,
        dueSoon: focusSignalWeightByType['due-soon'],
        mention: focusSignalWeightByType.mention,
        overdue: focusSignalWeightByType.overdue,
        reviewRequest: focusSignalWeightByType['review-request'],
        sla: focusSignalWeightByType.sla,
        urgent: focusSignalWeightByType.urgent,
      },
    },
    teamId: 'core-team',
  }],
  generatedAt: '2026-08-09T04:30:00.000Z',
  metrics: {
    blocked: 1,
  },
  policyCapabilities: {
    canEditPersonal: true,
    editableTeamIds: ['core-team'],
  },
  schemaVersion: FOCUS_SCHEMA_VERSION,
  sections: [
    { items: [nowBlockedItem, nowMentionItem], section: 'now' },
    { items: [nextItem], section: 'next' },
    { items: [waitingItem], section: 'waiting' },
    { items: [snoozedItem], section: 'snoozed' },
    { items: [doneItem], section: 'done' },
  ],
  teamPolicies: [{
    id: 'team-policy-core',
    overrides: { dueSoonDays: 2 },
    schemaVersion: FOCUS_SCHEMA_VERSION,
    target: { teamId: 'core-team', type: 'team' },
    updatedAt: '2026-08-08T04:00:00.000Z',
    version: 2,
  }],
  userPolicy: {
    id: 'user-policy-demo',
    overrides: {
      weights: { urgent: focusSignalWeightByType.urgent },
    },
    schemaVersion: FOCUS_SCHEMA_VERSION,
    target: { type: 'user' },
    updatedAt: '2026-08-09T04:00:00.000Z',
    version: 3,
  },
  viewerMemberKey: 'demo@example.com',
} satisfies FocusQueueResponse

/**
 * Creates one fully versioned Focus item fixture with deterministic signal evidence.
 *
 * @param id - Canonical and Focus item suffix.
 * @param section - Queue section containing the item.
 * @param title - Work Item title shown by the row.
 * @param signalTypes - Ordered signal reasons shown as chips.
 * @returns A complete authorized Focus item.
 */
function createFocusFixtureItem(
  id: string,
  section: FocusQueueSection,
  title: string,
  signalTypes: readonly FocusSignalType[],
): FocusItem {
  const signals: FocusSignal[] = signalTypes.map((type, index) => ({
    freshness: {
      evaluatedAt: `2026-08-09T04:${String(20 + index).padStart(2, '0')}:00.000Z`,
      sourceVersion: index + 1,
      validUntil: '2026-08-09T04:45:00.000Z',
    },
    id: `${id}-${type}`,
    permission: {
      canOpenSource: true,
    },
    resolution: {
      condition: getFixtureResolutionCondition(type),
      status: section === 'done' ? 'resolved' : 'open',
      ...(section === 'done' ? { resolvedAt: '2026-08-09T04:25:00.000Z' } : {}),
    },
    source: {
      deepLink: `/projects/refero/issues?teamId=core-team&issueId=${encodeURIComponent(id)}`,
      eventId: `event-${id}-${type}`,
      id: `source-${id}-${type}`,
      kind: type === 'blocker' ? 'planning-dependency' : 'notification',
      occurredAt: '2026-08-09T03:30:00.000Z',
    },
    type,
  }))
  const rankComponents = signals.map((signal) => {
    const weight = focusSignalWeightByType[signal.type]
    const value = section === 'done' ? 0 : 1
    return {
      contribution: weight * value,
      signalId: signal.id,
      signalType: signal.type,
      value,
      weight,
    }
  })

  return {
    actionability: { actionable: true, reasons: [] },
    capabilities: {
      assign: true,
      changeStatus: true,
      complete: true,
      openSource: true,
      schedule: true,
      snooze: true,
      watch: true,
    },
    effectivePolicyId: 'effective-core-team',
    id: `focus-${id}`,
    rank: {
      components: rankComponents,
      score: rankComponents.reduce((total, component) => total + component.contribution, 0),
      tieBreaker: `core-team\0${id}`,
    },
    schemaVersion: FOCUS_SCHEMA_VERSION,
    section,
    signals,
    snoozeRevision: 3,
    updatedAt: '2026-08-09T04:30:00.000Z',
    version: 3,
    watching: id === 'WI-202',
    workItem: {
      assignedProjectId: 'refero',
      assigneeEmail: 'demo@example.com',
      assigneeName: 'Demo User',
      assigneeUserId: 'demo@example.com',
      createdAt: '2026-08-01T00:00:00.000Z',
      creatorMemberKey: 'lead@example.com',
      customFieldValues: {},
      dueDate: '2026-08-12',
      id,
      priority: signalTypes.includes('urgent') ? 'high' : 'medium',
      relationIds: signalTypes.includes('blocker') ? ['blockedBy:WI-100'] : [],
      revision: 7,
      schedule: createDefaultDueDateWorkItemSchedule('2026-08-12'),
      schemaVersion: WORK_ITEM_SCHEMA_VERSION,
      source: 'dynamodb',
      statusCategory: 'started',
      teamId: 'core-team',
      title,
      updatedAt: '2026-08-09T04:20:00.000Z',
      workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
      workflowStatusId: 'active',
    },
  }
}

/** Returns the representative resolution condition for one fixture signal. */
function getFixtureResolutionCondition(
  type: FocusSignalType,
): FocusSignalResolutionCondition {
  switch (type) {
    case 'blocker': return 'blocker-completed'
    case 'urgent': return 'priority-lowered'
    case 'overdue':
    case 'due-soon': return 'deadline-changed'
    case 'approval': return 'approval-decided'
    case 'review-request': return 'review-completed'
    case 'mention': return 'mention-acknowledged'
    case 'sla': return 'sla-restored'
    case 'cycle': return 'cycle-changed'
  }
}
