import { describe, expect, test } from 'bun:test'
import {
  createActiveAgentRun,
  finishAgentRun,
  readStartAgentRunRequest,
  readUpdateAgentSettingsRequest,
  type StoredAgentRun,
} from '../../domain/agent-run'
import { InMemoryAgentRunStore } from '../../adapter-out/in-memory/agent-run-store'
import {
  createAgentRunTriageFiling,
  runAgentRunTriageSweep,
  type AgentRunTriageFiling,
  type AgentRunTriageSweepFailure,
} from './agent-run-triage-sweep'

const now = new Date('2026-10-28T03:00:00.000Z')
const minute = 60_000

/**
 * Creates a run of the fixture Team started at a given time.
 *
 * @param runNumber - Distinguishes the run and its Work Item.
 * @param startedAt - Start time; the lease is 30 minutes.
 * @returns Active run.
 */
function createRun(runNumber: number, startedAt: Date): StoredAgentRun {
  return createActiveAgentRun({
    directoryId: 'workspace-1',
    teamId: 'core',
    workItemId: `task-${runNumber}`,
    assigneeUserId: 'member-1',
    start: readStartAgentRunRequest({ expectedRevision: 1, workflowStatusId: 'in-progress', runtime: 'codex', agentName: 'Codex', instanceId: 'laptop-1' }),
    credentialId: 'key-1',
    startRevision: 2,
    leaseMinutes: 30,
    now: startedAt,
    runId: `run_00000000-0000-4000-8000-00000000000${runNumber}`,
  })
}

/**
 * Saves the fixture Team's Triage filing settings.
 *
 * @param store - Store.
 * @param flags - Which runs the Team files.
 * @param flags.failed - Whether failed runs are filed.
 * @param flags.stalled - Whether stalled runs are filed.
 */
async function saveFlags(store: InMemoryAgentRunStore, flags: { failed: boolean; stalled: boolean }): Promise<void> {
  const current = await store.getSettings('workspace-1', 'core')
  await store.saveSettings('workspace-1', 'core', readUpdateAgentSettingsRequest({
    expectedRevision: current.revision,
    leaseMinutes: 30,
    allowTakeoverAfterLeaseExpiry: false,
    fileFailedRunsToTriage: flags.failed,
    fileStalledRunsToTriage: flags.stalled,
  }), 'manager-1', now, `save-${current.revision}`)
}

/**
 * Seeds a run that failed, through the same close writes a finish commits.
 *
 * @param store - Store.
 * @param run - Active run to finish.
 * @param finishedAt - Finish time.
 */
function seedFailed(store: InMemoryAgentRunStore, run: StoredAgentRun, finishedAt: Date): void {
  store.seed(run)
  store.applyTransactItems(store.createCloseItems(finishAgentRun(run, 'failed', 'agent', finishedAt)))
}

/**
 * Creates sweep dependencies that record filings.
 *
 * @param store - Store.
 * @param options - Filer behavior and missing Work Items.
 * @param options.file - Replaces the recording filer.
 * @param options.missingWorkItems - Work Item IDs that read as deleted.
 * @returns Dependencies, filings, and failures.
 */
function createDependencies(
  store: InMemoryAgentRunStore,
  options: {
    file?: (filing: AgentRunTriageFiling) => Promise<'filed' | 'rejected'>
    missingWorkItems?: string[]
  } = {},
) {
  const filings: AgentRunTriageFiling[] = []
  const failures: AgentRunTriageSweepFailure[] = []
  return {
    filings,
    failures,
    dependencies: {
      store,
      now,
      workItems: {
        /**
         * Reads a fixture Work Item.
         * @param _directoryId - Workspace ID.
         * @param teamId - Team ID.
         * @param workItemId - Work Item ID.
         * @returns Title and path, unless the Work Item is missing.
         */
        async read(_directoryId: string, teamId: string, workItemId: string) {
          if (options.missingWorkItems?.includes(workItemId)) return undefined
          return { title: `Title of ${workItemId}`, path: `/teams/${teamId}/issues?issueId=${workItemId}` }
        },
      },
      triage: {
        /**
         * Records a filing.
         * @param _directoryId - Workspace ID.
         * @param _teamId - Team ID.
         * @param filing - Entry content.
         * @returns Filing outcome.
         */
        async file(_directoryId: string, _teamId: string, filing: AgentRunTriageFiling) {
          filings.push(filing)
          return options.file ? options.file(filing) : 'filed'
        },
      },
      /**
       * Records a failure.
       * @param failure - Failure without content.
       */
      onError(failure: AgentRunTriageSweepFailure) {
        failures.push(failure)
      },
    },
  }
}

describe('Agent Run triage sweep', () => {
  test('files a failed run once and removes it from the outbox', async () => {
    const store = new InMemoryAgentRunStore()
    await saveFlags(store, { failed: true, stalled: false })
    seedFailed(store, createRun(1, new Date(now.getTime() - 20 * minute)), new Date(now.getTime() - 10 * minute))
    const first = createDependencies(store)

    expect(await runAgentRunTriageSweep(first.dependencies)).toMatchObject({ failedFiled: 1, failedSkipped: 0, errors: 0, truncated: false })
    expect(first.filings).toEqual([expect.objectContaining({ reason: 'failed', title: 'Agent run failed: Title of task-1', agentName: 'Codex', assigneeUserId: 'member-1' })])
    expect(first.filings[0]?.body).toContain('Path: /teams/core/issues?issueId=task-1')
    expect(await store.listFailedRunsToTriage(10)).toEqual([])

    const second = createDependencies(store)
    await runAgentRunTriageSweep(second.dependencies)
    expect(second.filings).toEqual([])
  })

  test('drops failed runs without filing when the Team does not file them or the Work Item is gone', async () => {
    const store = new InMemoryAgentRunStore()
    seedFailed(store, createRun(1, new Date(now.getTime() - 20 * minute)), new Date(now.getTime() - 10 * minute))
    const disabled = createDependencies(store)
    expect(await runAgentRunTriageSweep(disabled.dependencies)).toMatchObject({ failedFiled: 0, failedSkipped: 1 })
    expect(disabled.filings).toEqual([])
    expect(await store.listFailedRunsToTriage(10)).toEqual([])

    await saveFlags(store, { failed: true, stalled: false })
    seedFailed(store, createRun(2, new Date(now.getTime() - 20 * minute)), new Date(now.getTime() - 5 * minute))
    const gone = createDependencies(store, { missingWorkItems: ['task-2'] })
    expect(await runAgentRunTriageSweep(gone.dependencies)).toMatchObject({ failedFiled: 0, failedSkipped: 1 })
    expect(gone.filings).toEqual([])
  })

  test('keeps a failed run for the next sweep when filing fails, and drops one Triage refuses', async () => {
    const store = new InMemoryAgentRunStore()
    await saveFlags(store, { failed: true, stalled: false })
    seedFailed(store, createRun(1, new Date(now.getTime() - 20 * minute)), new Date(now.getTime() - 10 * minute))
    const failing = createDependencies(store, {
      /**
       * Fails like an unavailable table.
       * @returns Never; always rejects.
       */
      file: async () => {
        throw Object.assign(new Error('Service unavailable'), { name: 'ProvisionedThroughputExceededException' })
      },
    })
    expect(await runAgentRunTriageSweep(failing.dependencies)).toMatchObject({ failedFiled: 0, errors: 1 })
    expect(failing.failures).toEqual([{ directoryId: 'workspace-1', teamId: 'core', runId: 'run_00000000-0000-4000-8000-000000000001', code: 'ProvisionedThroughputExceededException' }])
    expect(await store.listFailedRunsToTriage(10)).toHaveLength(1)

    const refusing = createDependencies(store, {
      /**
       * Refuses the input.
       * @returns The refused outcome.
       */
      file: async () => 'rejected',
    })
    expect(await runAgentRunTriageSweep(refusing.dependencies)).toMatchObject({ rejected: 1, errors: 0 })
    expect(await store.listFailedRunsToTriage(10)).toEqual([])
  })

  test('files each stalled run once and leaves runs within their lease alone', async () => {
    const store = new InMemoryAgentRunStore()
    await saveFlags(store, { failed: false, stalled: true })
    store.seed(createRun(1, new Date(now.getTime() - 45 * minute)))
    store.seed(createRun(2, new Date(now.getTime() - 5 * minute)))
    const first = createDependencies(store)

    expect(await runAgentRunTriageSweep(first.dependencies)).toMatchObject({ stalledFiled: 1, errors: 0, truncated: false })
    expect(first.filings).toEqual([expect.objectContaining({ runId: 'run_00000000-0000-4000-8000-000000000001', reason: 'stalled', title: 'Agent run stalled: Title of task-1' })])
    expect(first.filings[0]?.body).toContain('its lease expired at 2026-10-28T02:45:00.000Z')
    expect((await store.getRun('workspace-1', 'core', 'run_00000000-0000-4000-8000-000000000001'))?.stallTriagedAt).toBe(now.toISOString())

    const second = createDependencies(store)
    expect(await runAgentRunTriageSweep(second.dependencies)).toMatchObject({ stalledFiled: 0 })
    expect(second.filings).toEqual([])
  })

  test('does not file stalled runs of a Team that only files failed runs', async () => {
    const store = new InMemoryAgentRunStore()
    await saveFlags(store, { failed: true, stalled: false })
    store.seed(createRun(1, new Date(now.getTime() - 45 * minute)))
    const sweep = createDependencies(store)
    expect(await runAgentRunTriageSweep(sweep.dependencies)).toMatchObject({ stalledFiled: 0 })
    expect(sweep.filings).toEqual([])
  })

  test('keeps report text out of the entry and shows the latest report kind', () => {
    const run: StoredAgentRun = { ...createRun(1, now), lastReportKind: 'blocker', lastReportAt: now.toISOString() }
    const filing = createAgentRunTriageFiling(run, 'stalled', { title: 'x'.repeat(600), path: '/teams/core/issues?issueId=task-1' })
    expect(filing.title).toHaveLength(500)
    expect(filing.body).toContain(`Latest report: blocker at ${now.toISOString()}`)
  })
})
