import type { AgentRunView } from '@mukuroji/contracts'

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
