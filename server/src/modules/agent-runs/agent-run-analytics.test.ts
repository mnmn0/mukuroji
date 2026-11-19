import { describe, expect, test } from 'bun:test'
import type { AgentRunOutcome, AgentRunReport, AgentRunReportKind } from '@mukuroji/contracts'
import { calculateFactoryAnalytics } from './domain/agent-run-analytics'
import { createActiveAgentRun, finishAgentRun, readStartAgentRunRequest, type StoredAgentRun } from './domain/agent-run'

const hourMs = 3_600_000
const end = Date.parse('2026-11-01T00:00:00.000Z')
const period = { from: end - 24 * hourMs, to: end }

/**
 * Creates a finished run of one Work Item.
 *
 * @param workItemId - Work Item ID.
 * @param startHoursAgo - Start time in hours before the period end.
 * @param finishHoursAgo - Finish time in hours before the period end.
 * @param outcome - Outcome.
 * @param reportCount - Number of saved reports.
 * @returns Finished run.
 */
function finishedRun(workItemId: string, startHoursAgo: number, finishHoursAgo: number, outcome: AgentRunOutcome, reportCount = 0): StoredAgentRun {
  const run = createActiveAgentRun({
    directoryId: 'workspace',
    teamId: 'team',
    workItemId,
    assigneeUserId: 'member',
    start: readStartAgentRunRequest({ expectedRevision: 1, workflowStatusId: 'in-progress', runtime: 'claude-code', agentName: 'Claude Code', instanceId: 'laptop' }),
    credentialId: 'key',
    startRevision: 2,
    leaseMinutes: 30,
    now: new Date(end - startHoursAgo * hourMs),
  })
  return { ...finishAgentRun(run, outcome, 'agent', new Date(end - finishHoursAgo * hourMs)), reportCount }
}

/**
 * Creates a report of a run.
 *
 * @param run - Run.
 * @param sequence - Position within the run.
 * @param kind - Report kind.
 * @param hoursAgo - Report time in hours before the period end.
 * @returns Report.
 */
function report(run: StoredAgentRun, sequence: number, kind: AgentRunReportKind, hoursAgo: number): AgentRunReport {
  return {
    schemaVersion: 1, runId: run.runId, teamId: 'team', workItemId: run.workItemId, sequence, kind,
    commentId: `cmt_${sequence}`, verifications: [], artifacts: [], createdAt: new Date(end - hoursAgo * hourMs).toISOString(),
  }
}

describe('calculateFactoryAnalytics', () => {
  test('returns empty rates and stations without runs', () => {
    expect(calculateFactoryAnalytics({ ...period, histories: [] })).toEqual({
      finishedRuns: 0,
      outcomes: { completed: 0, paused: 0, failed: 0, released: 0, superseded: 0 },
      successRate: null,
      reworkRuns: 0,
      reworkRate: null,
      interventions: 0,
      stageLeadTimes: [
        { stage: 'build', medianHours: null, sampleSize: 0 },
        { stage: 'verify', medianHours: null, sampleSize: 0 },
        { stage: 'artifact', medianHours: null, sampleSize: 0 },
        { stage: 'decision', medianHours: null, sampleSize: 0 },
      ],
      runtimes: [],
      historyHasMore: false,
    })
  })

  test('counts decisions from blocker reports and resumed pauses, and leaves an open pause out', () => {
    const blocked = finishedRun('task-1', 10, 4, 'completed', 2)
    const paused = finishedRun('task-2', 10, 9, 'paused')
    const waiting = finishedRun('task-3', 6, 5, 'paused')
    const result = calculateFactoryAnalytics({
      ...period,
      histories: [
        { runs: [blocked], runsComplete: true, reports: [report(blocked, 2, 'progress', 6), report(blocked, 1, 'blocker', 8)] },
        // The run after a pause can still be active; only its start matters.
        { runs: [paused, { ...finishedRun('task-2', 6, 1, 'completed'), state: 'active' }], runsComplete: true, reports: [] },
        { runs: [waiting], runsComplete: true, reports: [] },
      ],
    })
    // build: 2h + 2h for the blocked run, 1h for each paused run. decision: 2h blocked, 3h until the resume.
    expect(result.stageLeadTimes).toEqual([
      { stage: 'build', medianHours: 1, sampleSize: 3 },
      { stage: 'verify', medianHours: null, sampleSize: 0 },
      { stage: 'artifact', medianHours: null, sampleSize: 0 },
      { stage: 'decision', medianHours: 2.5, sampleSize: 2 },
    ])
    expect(result).toMatchObject({ finishedRuns: 3, successRate: 100, historyHasMore: false })
  })

  test('counts runs after a completion as rework and says when a run history was cut', () => {
    const done = finishedRun('task-1', 20, 19, 'completed')
    const again = finishedRun('task-1', 18, 17, 'superseded')
    const partial = finishedRun('task-2', 5, 4, 'failed', 2)
    const result = calculateFactoryAnalytics({
      ...period,
      histories: [
        { runs: [again, done], runsComplete: true, reports: [] },
        // The previous run and one report of this run were not read.
        { runs: [partial], runsComplete: false, reports: [report(partial, 2, 'verification', 4.5)] },
      ],
    })
    expect(result).toMatchObject({
      finishedRuns: 3,
      outcomes: { completed: 1, failed: 1, superseded: 1 },
      successRate: 33.3,
      reworkRuns: 1,
      reworkRate: 33.3,
      interventions: 1,
      historyHasMore: true,
    })
    expect(result.stageLeadTimes[0]).toEqual({ stage: 'build', medianHours: 1, sampleSize: 2 })
  })

  test('says when a cut run history may hold older runs that finished in the period', () => {
    const recent = finishedRun('task-1', 3, 2, 'completed')
    const older = finishedRun('task-1', 6, 5, 'completed')
    const result = calculateFactoryAnalytics({ ...period, histories: [{ runs: [recent, older], runsComplete: false, reports: [] }] })
    // The previous run of `recent` was read, but runs before `older` were not.
    expect(result).toMatchObject({ finishedRuns: 2, reworkRuns: 1, historyHasMore: true })
    const beforePeriod = finishedRun('task-1', 30, 29, 'completed')
    const complete = calculateFactoryAnalytics({ ...period, histories: [{ runs: [recent, beforePeriod], runsComplete: false, reports: [] }] })
    expect(complete).toMatchObject({ finishedRuns: 1, reworkRuns: 1, historyHasMore: false })
  })

  test('counts only runs that finished inside the period', () => {
    const before = finishedRun('task-1', 30, 25, 'completed')
    const after = finishedRun('task-2', 1, -1, 'completed')
    const result = calculateFactoryAnalytics({
      ...period,
      histories: [{ runs: [before], runsComplete: true, reports: [] }, { runs: [after], runsComplete: true, reports: [] }],
    })
    expect(result.finishedRuns).toBe(0)
  })
})
