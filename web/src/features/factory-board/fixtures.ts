import type { AgentRunReport, AgentRunView, FactoryBoardItem, FactoryBoardReportSummary, TeamAgentRunBoardResponse } from '@mukuroji/contracts'

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
    run: createRun('release-notes', 2, { runtime: 'codex', agentName: 'Codex', assigneeUserId: 'tanaka@example.com', leaseExpiresAt: '2026-10-22T02:25:00.000Z' }),
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
