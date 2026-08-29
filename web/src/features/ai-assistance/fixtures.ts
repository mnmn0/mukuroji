import type {
  AiAssistanceGeneration,
  AiAssistancePolicy,
  AiAssistancePreference,
} from '@mukuroji/contracts'

/** Available intake triage generation used by Request and Team adoption stories. */
export const aiTriageGenerationFixture = {
  schemaVersion: 1,
  id: 'ai-generation-triage-1',
  task: 'triage',
  revision: 1,
  content: {
    availability: 'available',
    draft: {
      kind: 'triage',
      title: {
        value: 'Unblock customer Workspace provisioning',
        reason: 'The latest authorized message identifies provisioning as the launch blocker.',
        confidence: 'high',
        citationIds: ['citation-triage-1'],
      },
      description: {
        value: 'Investigate the failed provisioning step and confirm access with the requester.',
        reason: 'The source body and recent activity describe a repeatable access failure.',
        confidence: 'medium',
        citationIds: ['citation-triage-1'],
      },
      priority: {
        value: 'high',
        reason: 'The request blocks a scheduled customer launch.',
        confidence: 'high',
        citationIds: ['citation-triage-1'],
      },
      assigneeUserId: {
        value: 'member-ada',
        reason: 'This member owns the currently permitted routing destination.',
        confidence: 'medium',
        citationIds: ['citation-triage-1'],
      },
      teamId: {
        value: 'core-team',
        reason: 'The entry is already authorized in the Core Team queue.',
        confidence: 'high',
        citationIds: ['citation-triage-1'],
      },
      projectId: {
        value: 'launch-readiness',
        reason: 'The source is explicitly tied to the launch readiness project.',
        confidence: 'medium',
        citationIds: ['citation-triage-1'],
      },
      customFields: [],
    },
    citations: [{
      id: 'citation-triage-1',
      sourceType: 'triage-entry',
      label: 'Provisioning intake source',
      href: '/teams/core-team/triage?entryId=triage-chat-1',
      excerpt: 'Workspace provisioning is blocking the customer launch.',
      capturedRevision: 4,
    }],
    uncertainty: {
      level: 'medium',
      reason: 'The authorized context does not confirm whether the failure affects other customers.',
    },
  },
  details: {
    provider: 'bedrock',
    modelId: 'jp.anthropic.claude-sonnet-4-6',
    promptVersion: 'triage-v1',
    traceId: 'trace-triage-1',
    usage: {
      inputTokens: 630,
      outputTokens: 240,
      latencyMs: 1_120,
      costUnavailableReason: 'pricing-not-configured',
    },
  },
  createdAt: '2026-08-25T01:15:00.000Z',
  expiresAt: '2026-09-24T01:15:00.000Z',
} satisfies AiAssistanceGeneration

/** Available grounded summary generation used by focused review stories and tests. */
export const aiSummaryGenerationFixture = {
  schemaVersion: 1,
  id: 'ai-generation-summary-1',
  task: 'summary',
  revision: 1,
  content: {
    availability: 'available',
    draft: {
      kind: 'summary',
      overview: {
        id: 'overview-1',
        text: 'The launch review is waiting on the final accessibility sign-off.',
        confidence: 'high',
        citationIds: ['citation-1'],
      },
      decisions: [{
        id: 'decision-1',
        text: 'Keep the staged rollout for the first release window.',
        confidence: 'medium',
        citationIds: ['citation-1'],
      }],
      actions: [{
        id: 'action-1',
        text: 'Confirm the keyboard review before Thursday.',
        confidence: 'high',
        citationIds: ['citation-1'],
      }],
      risks: [],
    },
    citations: [{
      id: 'citation-1',
      sourceType: 'document',
      label: 'Launch readiness notes',
      href: '/documents/launch-readiness',
      excerpt: 'Accessibility sign-off remains the final launch gate.',
      capturedRevision: 7,
    }],
    uncertainty: {
      level: 'medium',
      reason: 'The owner for the final sign-off is not named in the available sources.',
    },
  },
  details: {
    provider: 'bedrock',
    modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
    promptVersion: 'summary-v1',
    traceId: 'trace-summary-1',
    usage: {
      inputTokens: 820,
      outputTokens: 214,
      latencyMs: 1480,
      costUsd: 0.0092,
    },
  },
  createdAt: '2026-08-25T01:30:00.000Z',
  expiresAt: '2026-09-24T01:30:00.000Z',
} satisfies AiAssistanceGeneration

/** Available low-confidence Search generation used by the plain-language preview. */
export const aiSearchGenerationFixture = {
  schemaVersion: 1,
  id: 'ai-generation-search-1',
  task: 'search',
  revision: 3,
  content: {
    availability: 'available',
    draft: {
      kind: 'search',
      interpretation: 'Find incomplete Work Items updated this month for the Core team.',
      filters: {
        entityTypes: ['work-item'],
        statuses: ['todo', 'in-progress'],
        teamIds: ['core-team'],
        date: {
          field: 'updatedAt',
          from: '2026-08-01',
          to: '2026-08-31',
        },
      },
      report: { metric: 'count', groupBy: 'team' },
      caveats: ['“Incomplete” was mapped to the visible todo and in-progress statuses.'],
    },
    citations: [],
    uncertainty: {
      level: 'low',
      reason: 'The phrase “this month” depends on the Workspace timezone and should be checked.',
    },
  },
  details: {
    provider: 'bedrock',
    modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
    promptVersion: 'search-v1',
    traceId: 'trace-search-1',
    usage: {
      inputTokens: 142,
      outputTokens: 96,
      latencyMs: 640,
      costUnavailableReason: 'pricing-not-configured',
    },
  },
  createdAt: '2026-08-25T02:00:00.000Z',
  expiresAt: '2026-09-24T02:00:00.000Z',
} satisfies AiAssistanceGeneration

/** Available planning generation with fields, a child item, dependency, and status update. */
export const aiPlanningGenerationFixture = {
  schemaVersion: 1,
  id: 'ai-generation-planning-1',
  task: 'planning',
  revision: 2,
  content: {
    availability: 'available',
    draft: {
      kind: 'planning',
      title: {
        value: 'Complete launch accessibility review',
        reason: 'The remaining launch gate is consistently described as accessibility sign-off.',
        confidence: 'high',
        citationIds: ['citation-plan-1'],
      },
      priority: {
        value: 'high',
        reason: 'The review blocks the staged launch window.',
        confidence: 'medium',
        citationIds: ['citation-plan-1'],
      },
      status: {
        value: 'review',
        reason: 'The implementation is complete and the final review is active.',
        confidence: 'medium',
        citationIds: ['citation-plan-1'],
      },
      plannedEffortMinutes: {
        value: 240,
        reason: 'The prior keyboard and screen-reader passes each required about two hours.',
        confidence: 'low',
        citationIds: ['citation-plan-2'],
      },
      subtasks: [{
        id: 'subtask-1',
        title: 'Verify keyboard navigation findings',
        description: 'Re-run the documented keyboard paths and record any regressions.',
        priority: 'high',
        plannedEffortMinutes: 120,
        reason: 'Keyboard verification is the only incomplete review step.',
        confidence: 'high',
        citationIds: ['citation-plan-1'],
      }],
      dependencies: [{
        id: 'dependency-1',
        predecessor: { teamId: 'core-team', workItemId: 'accessibility-review' },
        successor: { teamId: 'core-team', workItemId: 'staged-launch' },
        type: 'finish-to-start',
        lagDays: 1,
        reason: 'The rollout starts after the accessibility approval is recorded.',
        confidence: 'medium',
        citationIds: ['citation-plan-2'],
      }],
      statusUpdate: {
        health: 'at-risk',
        risk: 'medium',
        summary: 'The launch remains staged while accessibility sign-off is completed.',
        riskSummary: 'A failed keyboard regression could move the release window.',
        decisionSummary: 'Keep the staged rollout sequence.',
        helpNeeded: 'Confirm a reviewer for Thursday.',
        nextAction: 'Complete keyboard verification and record the decision.',
        confidence: 'medium',
        citationIds: ['citation-plan-1', 'citation-plan-2'],
      },
    },
    citations: [{
      id: 'citation-plan-1',
      sourceType: 'work-item',
      label: 'Accessibility review Work Item',
      href: '/search?q=accessibility-review&type=work-item',
      excerpt: 'Keyboard verification remains open before final sign-off.',
      capturedRevision: 8,
    }, {
      id: 'citation-plan-2',
      sourceType: 'planning-target',
      label: 'Staged launch update',
      href: '/planning/timeline',
      excerpt: 'The rollout begins after accessibility approval and one day of release preparation.',
      capturedRevision: 12,
    }],
    uncertainty: {
      level: 'medium',
      reason: 'The effort estimate is based on two earlier review passes rather than a current estimate.',
    },
  },
  details: {
    provider: 'bedrock',
    modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
    promptVersion: 'planning-v1',
    traceId: 'trace-planning-1',
    usage: {
      inputTokens: 1_240,
      outputTokens: 486,
      latencyMs: 1_920,
      costUsd: 0.0154,
    },
  },
  createdAt: '2026-08-25T02:30:00.000Z',
  expiresAt: '2026-09-24T02:30:00.000Z',
} satisfies AiAssistanceGeneration

/** Withheld generation that deliberately contains no previously authorized draft or citation. */
export const aiWithheldGenerationFixture = {
  ...aiSummaryGenerationFixture,
  id: 'ai-generation-withheld-1',
  revision: 2,
  content: {
    availability: 'withheld',
    reasonCode: 'permission-changed',
  },
} satisfies AiAssistanceGeneration

/** Enabled personal AI preference used by Settings stories and focused tests. */
export const aiAssistancePreferenceFixture = {
  schemaVersion: 1,
  enabled: true,
  revision: 2,
  updatedAt: '2026-08-25T02:15:00.000Z',
} satisfies AiAssistancePreference

/** Workspace Bedrock policy used by administrator Settings stories and focused tests. */
export const aiAssistancePolicyFixture = {
  schemaVersion: 1,
  enabled: true,
  allowedModelIds: [
    'anthropic.claude-sonnet-4-20250514-v1:0',
    'amazon.nova-pro-v1:0',
  ],
  defaultModelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
  enabledTasks: ['triage', 'summary', 'search', 'planning'],
  retentionDays: 30,
  revision: 4,
  updatedAt: '2026-08-25T02:20:00.000Z',
} satisfies AiAssistancePolicy
