import type { AgentRunReport, AgentRunView } from '@mukuroji/contracts'

/** Base fields shared by Agent Run fixtures. */
const baseRun: AgentRunView = {
  schemaVersion: 1,
  runId: 'run_00000000-0000-4000-8000-000000000001',
  teamId: 'core',
  workItemId: 'onboarding-friction',
  assigneeUserId: 'sato@example.com',
  runtime: 'claude-code',
  agentName: 'Claude Code',
  state: 'active',
  startRevision: 4,
  leaseMinutes: 30,
  startedAt: '2026-10-22T01:00:00.000Z',
  lastHeartbeatAt: '2026-10-22T01:20:00.000Z',
  leaseExpiresAt: '2026-10-22T01:50:00.000Z',
  stalled: false,
  reportCount: 2,
  canRelease: true,
}

/** Active run followed by finished runs, newest first. */
export const agentRunFixtures: AgentRunView[] = [
  baseRun,
  {
    ...baseRun,
    runId: 'run_00000000-0000-4000-8000-000000000002',
    runtime: 'codex',
    agentName: 'Codex',
    state: 'finished',
    outcome: 'paused',
    startedAt: '2026-10-21T08:00:00.000Z',
    finishedAt: '2026-10-21T09:30:00.000Z',
    finishedBy: 'agent',
    canRelease: false,
  },
  {
    ...baseRun,
    runId: 'run_00000000-0000-4000-8000-000000000003',
    state: 'finished',
    outcome: 'released',
    startedAt: '2026-10-20T08:00:00.000Z',
    finishedAt: '2026-10-20T10:00:00.000Z',
    finishedBy: 'sato@example.com',
    canRelease: false,
  },
]

/** Active run whose lease has expired. */
export const stalledAgentRunFixture: AgentRunView = { ...baseRun, stalled: true }

/** Structured report saved with the `comment-1` fixture comment. */
export const agentRunReportFixture: AgentRunReport = {
  schemaVersion: 1,
  runId: baseRun.runId,
  teamId: baseRun.teamId,
  workItemId: baseRun.workItemId,
  sequence: 2,
  kind: 'verification',
  commentId: 'comment-1',
  verifications: [
    { command: 'bun run server:test', status: 'passed', summary: '3,890 tests passed' },
    { command: 'bun run web:build', status: 'failed' },
  ],
  artifacts: [
    { type: 'pull-request', url: 'https://github.com/example/repo/pull/12', label: 'PR #12' },
    { type: 'commit', url: 'https://github.com/example/repo/commit/4746f37f339d66b46db70292caf750400cb61cb0' },
  ],
  changedFileCount: 7,
  createdAt: '2026-10-22T01:20:00.000Z',
}

/** Hand-off report that asks a person to decide. */
export const agentRunHandoffReportFixture: AgentRunReport = {
  ...agentRunReportFixture,
  sequence: 3,
  kind: 'handoff',
  verifications: [],
  artifacts: [],
}
