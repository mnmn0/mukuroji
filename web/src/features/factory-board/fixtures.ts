import type { AgentRunReport, AgentRunView, FactoryBoardItem, FactoryBoardReportSummary, TeamAgentRunBoardResponse, TeamFactoryAnalyticsResponse } from '@mukuroji/contracts'

/** Read time of the fixture board. */
export const factoryBoardFixtureNow = '2026-10-22T02:00:00.000Z'

/**
 * Creates a fixture run of the board's Team.
 *
 * @param workItemId - Claimed Work Item.
 * @param index - Distinguishes the run ID.
 * @param overrides - Fields that differ from an active, healthy run.
 * @returns Run view.
 */
function createRun(workItemId: string, index: number, overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    schemaVersion: 1,
    runId: `run_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    teamId: 'core',
    workItemId,
    assigneeUserId: 'sato@example.com',
    runtime: 'claude-code',
    agentName: 'Claude Code',
    state: 'active',
    startRevision: 4,
    leaseMinutes: 30,
    startedAt: '2026-10-22T01:00:00.000Z',
    lastHeartbeatAt: '2026-10-22T01:42:00.000Z',
    leaseExpiresAt: '2026-10-22T02:12:00.000Z',
    stalled: false,
    reportCount: 0,
    canRelease: true,
    ...overrides,
  }
}

/** Work Items on the fixture board, one or more per lane. */
export const factoryBoardFixtureItems: FactoryBoardItem[] = [
  {
    workItem: { id: 'auth-flow', title: 'API の認証フローを整理する', workflowStatusId: 'in-progress', statusCategory: 'started', assignedProjectId: 'refero', assigneeUserId: 'sato@example.com', assigneeName: '佐藤 花子', assigneeEmail: 'sato@example.com' },
    run: createRun('auth-flow', 1, { reportCount: 2 }),
    latestReport: {
      runId: createRun('auth-flow', 1).runId, sequence: 2, kind: 'verification', createdAt: '2026-10-22T01:40:00.000Z',
      excerpt: 'Token refresh のテストを追加し、server test を実行しました。', verificationCounts: { passed: 2, failed: 0, skipped: 0 }, artifactCount: 1, changedFileCount: 4,
    },
  },
  {
    workItem: { id: 'release-notes', title: 'リリースノートの下書きを作る', workflowStatusId: 'in-progress', statusCategory: 'started', assigneeUserId: 'tanaka@example.com' },
    // Resumed after an earlier paused run of the same Work Item.
    run: createRun('release-notes', 2, {
      runtime: 'codex', agentName: 'Codex', assigneeUserId: 'tanaka@example.com', leaseExpiresAt: '2026-10-22T02:25:00.000Z',
      resumedFromRunId: 'run_00000000-0000-4000-8000-000000000099',
    }),
  },
  {
    workItem: { id: 'manual-start', title: '人が開始した調査タスク', workflowStatusId: 'in-progress', statusCategory: 'started', assignedProjectId: 'refero', assigneeUserId: 'sato@example.com', assigneeName: '佐藤 花子', assigneeEmail: 'sato@example.com' },
  },
  {
    workItem: { id: 'schema-change', title: 'Work Item schema の移行方針を決める', workflowStatusId: 'in-progress', statusCategory: 'started', assignedProjectId: 'refero', assigneeUserId: 'sato@example.com', assigneeName: '佐藤 花子', assigneeEmail: 'sato@example.com' },
    run: createRun('schema-change', 3, { reportCount: 1, runtime: 'kiro', agentName: 'Kiro' }),
    latestReport: {
      runId: createRun('schema-change', 3).runId, sequence: 1, kind: 'blocker', createdAt: '2026-10-22T01:50:00.000Z',
      excerpt: '既存 row の backfill が必要です。dry-run の範囲を決めてください。', verificationCounts: { passed: 0, failed: 1, skipped: 0 }, artifactCount: 0,
    },
  },
  {
    workItem: { id: 'review-wait', title: 'レビュー待ちで中断した PR', workflowStatusId: 'review', statusCategory: 'started', assignedProjectId: 'refero', assigneeUserId: 'sato@example.com', assigneeName: '佐藤 花子', assigneeEmail: 'sato@example.com' },
    run: createRun('review-wait', 4, { state: 'finished', outcome: 'paused', finishedAt: '2026-10-22T01:30:00.000Z', finishedBy: 'agent', canRelease: false }),
  },
  {
    workItem: { id: 'stalled-import', title: 'CSV インポートの文字コード対応', workflowStatusId: 'in-progress', statusCategory: 'started', assigneeUserId: 'tanaka@example.com' },
    run: createRun('stalled-import', 5, { assigneeUserId: 'tanaka@example.com', lastHeartbeatAt: '2026-10-22T01:10:00.000Z', leaseExpiresAt: '2026-10-22T01:40:00.000Z', stalled: true }),
  },
  {
    workItem: { id: 'flaky-test', title: 'flaky な e2e test を直す', workflowStatusId: 'in-progress', statusCategory: 'started', assignedProjectId: 'refero', assigneeUserId: 'sato@example.com', assigneeName: '佐藤 花子', assigneeEmail: 'sato@example.com' },
    run: createRun('flaky-test', 6, { state: 'finished', outcome: 'failed', finishedAt: '2026-10-22T00:20:00.000Z', finishedBy: 'agent', canRelease: false, runtime: 'codex', agentName: 'Codex' }),
  },
  {
    workItem: { id: 'docs-link', title: 'ドキュメントのリンク切れを直す', workflowStatusId: 'done', statusCategory: 'completed', assignedProjectId: 'refero', assigneeUserId: 'sato@example.com', assigneeName: '佐藤 花子', assigneeEmail: 'sato@example.com' },
    run: createRun('docs-link', 7, { state: 'finished', outcome: 'completed', finishedAt: '2026-10-21T23:00:00.000Z', finishedBy: 'agent', canRelease: false }),
  },
]

/** Fixture board with every lane populated. */
export const factoryBoardFixture: TeamAgentRunBoardResponse = {
  generatedAt: factoryBoardFixtureNow,
  items: factoryBoardFixtureItems,
  activeRunsHasMore: false,
  finishedRunsHasMore: false,
  startedWorkItemsHasMore: false,
}

/**
 * Creates a fixture report summary of a run.
 *
 * @param runIndex - Index of the run the report belongs to.
 * @param workItemId - Work Item of the run.
 * @param kind - Report kind.
 * @param excerpt - Start of the report comment.
 * @returns Report summary.
 */
function createReport(runIndex: number, workItemId: string, kind: FactoryBoardReportSummary['kind'], excerpt: string): FactoryBoardReportSummary {
  return {
    runId: createRun(workItemId, runIndex).runId, sequence: 1, kind, createdAt: '2026-10-22T01:45:00.000Z',
    excerpt, verificationCounts: kind === 'verification' ? { passed: 3, failed: 0, skipped: 0 } : { passed: 0, failed: 0, skipped: 0 }, artifactCount: kind === 'artifact' ? 1 : 0,
  }
}

/** Extra Work Items that fill every station of the line view, beside the lane fixtures. */
const factoryLineExtraItems: FactoryBoardItem[] = [
  {
    workItem: { id: 'refund-ids', title: '返金一覧に取引 ID の検索を足す', workflowStatusId: 'in-progress', statusCategory: 'started', assignedProjectId: 'refero', assigneeUserId: 'suzuki@example.com', assigneeName: '鈴木 一郎' },
    run: createRun('refund-ids', 8, { assigneeUserId: 'suzuki@example.com', reportCount: 1 }),
    latestReport: createReport(8, 'refund-ids', 'progress', 'specs/T-128.md に受け入れ条件 3 件を書き、actions/list-refunds.ts を変更しています。'),
  },
  {
    workItem: { id: 'audit-export', title: '監査ログの CSV 出力を足す', workflowStatusId: 'in-progress', statusCategory: 'started', assigneeUserId: 'tanaka@example.com' },
    run: createRun('audit-export', 9, { runtime: 'kiro', agentName: 'Kiro', assigneeUserId: 'tanaka@example.com', reportCount: 1 }),
    latestReport: createReport(9, 'audit-export', 'verification', 'bun run server:test と dry-run で受け入れ条件 3/3 を確認しました。'),
  },
  {
    workItem: { id: 'onboarding-copy', title: 'オンボーディングの文言を直す', workflowStatusId: 'in-progress', statusCategory: 'started', assignedProjectId: 'refero', assigneeUserId: 'sato@example.com', assigneeName: '佐藤 花子', assigneeEmail: 'sato@example.com' },
    run: createRun('onboarding-copy', 10, { runtime: 'codex', agentName: 'Codex', reportCount: 2 }),
    latestReport: createReport(10, 'onboarding-copy', 'artifact', 'Pull Request #42 を作りました。レビューをお願いします。'),
  },
  {
    workItem: { id: 'intake-search', title: '検索結果の並び順を選べるようにする', workflowStatusId: 'in-progress', statusCategory: 'started', assigneeUserId: 'suzuki@example.com', assigneeName: '鈴木 一郎' },
  },
]

/** Fixture board that fills every station of the line view. */
export const factoryLineFixture: TeamAgentRunBoardResponse = {
  ...factoryBoardFixture,
  items: [...factoryBoardFixtureItems, ...factoryLineExtraItems],
}

/** Reports of the `auth-flow` fixture Work Item, newest first. */
export const factoryBoardFixtureReports: AgentRunReport[] = [
  {
    schemaVersion: 1, runId: createRun('auth-flow', 1).runId, teamId: 'core', workItemId: 'auth-flow', sequence: 2, kind: 'verification',
    commentId: 'comment-2', createdAt: '2026-10-22T01:40:00.000Z', changedFileCount: 4,
    verifications: [{ command: 'bun run server:test', status: 'passed' }, { command: 'bun run typecheck:server', status: 'passed' }],
    artifacts: [{ type: 'pull-request', url: 'https://github.com/example/mukuroji/pull/42', label: '#42' }],
  },
  {
    schemaVersion: 1, runId: createRun('auth-flow', 1).runId, teamId: 'core', workItemId: 'auth-flow', sequence: 1, kind: 'progress',
    commentId: 'comment-1', createdAt: '2026-10-22T01:10:00.000Z', verifications: [], artifacts: [],
  },
]

/** Project names of the fixture Team. */
export const factoryBoardFixtureProjectNames: Record<string, string> = { refero: 'Refero' }

/** Factory analytics of the fixture Team for the last 30 days. */
export const factoryAnalyticsFixture: TeamFactoryAnalyticsResponse = {
  generatedAt: factoryBoardFixtureNow,
  from: '2026-09-22T02:00:00.000Z',
  to: factoryBoardFixtureNow,
  finishedRuns: 42,
  outcomes: { completed: 30, paused: 4, failed: 5, released: 2, superseded: 1 },
  successRate: 78.9,
  reworkRuns: 6,
  reworkRate: 14.3,
  interventions: 3,
  stageLeadTimes: [
    { stage: 'build', medianHours: 1.75, sampleSize: 42 },
    { stage: 'verify', medianHours: 0.4, sampleSize: 31 },
    { stage: 'artifact', medianHours: 0.25, sampleSize: 28 },
    { stage: 'decision', medianHours: 5.5, sampleSize: 9 },
  ],
  runtimes: [
    { runtime: 'claude-code', finishedRuns: 30, outcomes: { completed: 23, paused: 3, failed: 3, released: 1, superseded: 0 }, successRate: 85.2, reworkRuns: 4, reworkRate: 13.3, interventions: 1 },
    { runtime: 'codex', finishedRuns: 12, outcomes: { completed: 7, paused: 1, failed: 2, released: 1, superseded: 1 }, successRate: 63.6, reworkRuns: 2, reworkRate: 16.7, interventions: 2 },
  ],
  finishedRunsHasMore: false,
  workItemsHasMore: false,
  historyHasMore: false,
}

/** Factory analytics of the fixture Team with telemetry usage, as a Team manager sees it. */
export const factoryAnalyticsWithUsageFixture: TeamFactoryAnalyticsResponse = {
  ...factoryAnalyticsFixture,
  usage: {
    total: { inputTokens: 182_000, outputTokens: 64_500, cacheReadTokens: 2_410_000, cacheCreationTokens: 120_000, requestCount: 386, estimatedCostMicroUsd: 18_420_000, models: ['claude-opus-4-8', 'claude-sonnet-4-6'], aiDurationMs: 0, byModel: [], hasMore: false },
    projects: [
      { projectId: 'refero', usage: { inputTokens: 140_000, outputTokens: 50_000, cacheReadTokens: 1_900_000, cacheCreationTokens: 90_000, requestCount: 290, estimatedCostMicroUsd: 14_100_000, models: ['claude-opus-4-8'], aiDurationMs: 0, byModel: [], hasMore: false } },
      { usage: { inputTokens: 42_000, outputTokens: 14_500, cacheReadTokens: 510_000, cacheCreationTokens: 30_000, requestCount: 96, estimatedCostMicroUsd: 4_320_000, models: ['claude-sonnet-4-6'], aiDurationMs: 0, byModel: [], hasMore: false } },
    ],
    workItems: [
      { workItemId: 'auth-flow', title: 'API の認証フローを整理する', projectId: 'refero', usage: { inputTokens: 96_000, outputTokens: 31_000, cacheReadTokens: 1_250_000, cacheCreationTokens: 60_000, requestCount: 180, estimatedCostMicroUsd: 9_300_000, models: ['claude-opus-4-8'], aiDurationMs: 0, byModel: [], hasMore: false } },
      { workItemId: 'release-notes', title: 'リリースノートを書く', usage: { inputTokens: 42_000, outputTokens: 14_500, cacheReadTokens: 510_000, cacheCreationTokens: 30_000, requestCount: 96, estimatedCostMicroUsd: 4_320_000, models: ['claude-sonnet-4-6'], aiDurationMs: 0, byModel: [], hasMore: false } },
    ],
    runsHasMore: false,
  },
  activity: {
    aiDurationMs: 5_520_000,
    total: {
      toolCount: 1_204,
      toolDurationMs: 7_380_000,
      toolFailureCount: 37,
      tools: [],
      approvalWait: { count: 42, durationMs: 1_260_000 },
      promptWait: { count: 18, durationMs: 2_700_000 },
      hasMore: false,
    },
    topTools: [
      { kind: 'builtin', name: 'Bash', count: 410, durationMs: 4_200_000, failureCount: 21 },
      { kind: 'mcp', name: 'github/get_pull_request', count: 96, durationMs: 1_020_000, failureCount: 3 },
      { kind: 'skill', name: 'mukuroji-review', count: 12, durationMs: 960_000, failureCount: 0 },
      { kind: 'builtin', name: 'Edit', count: 380, durationMs: 610_000, failureCount: 8 },
    ],
    agentWorkShare: 76.5,
    runsHasMore: false,
  },
  comparison: {
    axis: { kind: 'size' },
    groups: [
      {
        workItemTypeId: 'task', value: 'up-to-1d', workItemCount: 9, medianRunMinutes: 42, medianTokens: 310_000, medianCostMicroUsd: 1_200_000,
        models: [
          { model: 'claude-opus-4-8', workItemCount: 6, medianTokens: 340_000, medianAiDurationMs: 600_000 },
          { model: 'claude-sonnet-4-6', workItemCount: 4, medianTokens: 150_000, medianAiDurationMs: 300_000 },
        ],
      },
      { workItemTypeId: 'bug', value: 'up-to-2h', workItemCount: 5, medianRunMinutes: 18, medianTokens: 90_000, medianCostMicroUsd: 400_000, models: [] },
    ],
    outliers: [
      {
        workItemId: 'auth-flow', title: 'API の認証フローを整理する', projectId: 'refero', workItemTypeId: 'task', value: 'up-to-1d',
        runMinutes: 128, aiDurationMs: 2_400_000, toolDurationMs: 3_100_000, waitDurationMs: 1_500_000, tokens: 1_437_000,
        estimatedCostMicroUsd: 9_300_000, ratio: 4.6, models: ['claude-opus-4-8'], runtimes: ['claude-code'],
        assigneeUserId: 'member', runCount: 3, reworkRuns: 2,
      },
    ],
    unsizedWorkItems: 4,
  },
}
