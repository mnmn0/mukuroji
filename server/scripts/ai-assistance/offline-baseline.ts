import { aiAssistanceOfflineInputDataset } from './offline-input-dataset'
import type {
  AiAssistanceOfflineBaseline,
  AiAssistanceOfflineRecordedOutputDataset,
} from './offline-evaluation-types'

/** Reviewed deterministic outputs recorded for the sanitized four-workflow dataset. */
export const aiAssistanceOfflineRecordedOutputs: AiAssistanceOfflineRecordedOutputDataset = {
  outputRevision: 'reviewed-structured-outputs-2026-08-25.v1',
  cases: [
    {
      id: 'triage-grounded-routing-v2',
      modelOutput: {
        draft: {
          kind: 'triage',
          title: {
            value: 'Investigate checkout timeout',
            reason: 'The intake describes repeated checkout timeouts.',
            confidence: 'high',
            citationIds: ['R1'],
          },
          priority: {
            value: 'high',
            reason: 'The failure blocks a core purchase flow.',
            confidence: 'medium',
            citationIds: ['R1'],
          },
          teamId: {
            value: 'team-payments',
            reason: 'The cited route is owned by the Payments team.',
            confidence: 'high',
            citationIds: ['R1'],
          },
          customFields: [],
        },
        uncertainty: {
          level: 'medium',
          reason: 'No production error trace was included in the intake.',
        },
      },
      usage: {
        inputTokens: 780,
        outputTokens: 220,
        latencyMs: 2_100,
      },
    },
    {
      id: 'summary-grounded-actions-v2',
      modelOutput: {
        draft: {
          kind: 'summary',
          overview: {
            id: 'overview-1',
            text: 'The launch is blocked by an unresolved migration risk.',
            confidence: 'high',
            citationIds: ['D1'],
          },
          decisions: [{
            id: 'decision-1',
            text: 'The team chose a staged launch.',
            confidence: 'high',
            citationIds: ['D1'],
          }],
          actions: [{
            id: 'action-1',
            text: 'Validate the migration rollback before launch.',
            confidence: 'medium',
            citationIds: ['D2'],
          }],
          risks: [{
            id: 'risk-1',
            text: 'Rollback time remains unverified.',
            confidence: 'medium',
            citationIds: ['D2'],
          }],
        },
        uncertainty: {
          level: 'medium',
          reason: 'The latest rollback rehearsal is not in the authorized sources.',
        },
      },
      usage: {
        inputTokens: 1_150,
        outputTokens: 310,
        latencyMs: 2_800,
      },
    },
    {
      id: 'search-safe-filter-translation-v2',
      modelOutput: {
        draft: {
          kind: 'search',
          interpretation: 'Open high-priority Payments work updated this month.',
          filters: {
            entityTypes: ['work-item'],
            teamIds: ['team-payments'],
            statuses: ['open'],
            date: { field: 'updatedAt', from: '2026-08-01', to: '2026-08-31' },
          },
          report: { metric: 'count', groupBy: 'assignee' },
          caveats: ['Open uses the current configured workflow status.'],
        },
        uncertainty: {
          level: 'medium',
          reason: 'The query did not specify a timezone.',
        },
      },
      usage: {
        inputTokens: 620,
        outputTokens: 190,
        latencyMs: 1_900,
      },
    },
    {
      id: 'planning-review-only-draft-v2',
      modelOutput: {
        draft: {
          kind: 'planning',
          plannedEffortMinutes: {
            value: 240,
            reason: 'The cited work contains two bounded implementation steps.',
            confidence: 'medium',
            citationIds: ['W1'],
          },
          subtasks: [{
            id: 'subtask-1',
            title: 'Add migration validation',
            priority: 'high',
            plannedEffortMinutes: 120,
            reason: 'The validation is independently reviewable.',
            confidence: 'high',
            citationIds: ['W1'],
          }],
          dependencies: [],
        },
        uncertainty: {
          level: 'medium',
          reason: 'The estimate excludes deployment waiting time.',
        },
      },
      usage: {
        inputTokens: 930,
        outputTokens: 240,
        latencyMs: 2_400,
      },
    },
  ],
}

/** Complete default offline baseline with independently versioned input and output records. */
export const aiAssistanceOfflineBaseline: AiAssistanceOfflineBaseline = {
  inputDataset: aiAssistanceOfflineInputDataset,
  recordedOutputs: aiAssistanceOfflineRecordedOutputs,
}
