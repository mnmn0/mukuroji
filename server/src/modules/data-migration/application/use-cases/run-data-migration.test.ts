import { describe, expect, test } from 'bun:test'
import {
  createManualClock,
  createMemoryCheckpointStore,
  createMemoryRowStore,
  createPendingTaskRow,
  createTaskEstimateMigration,
} from '../../test-support/data-migration-fakes'
import { runDataMigration, type RunDataMigrationInput } from './run-data-migration'
import { verifyDataMigration } from './verify-data-migration'

/**
 * Builds run input with test defaults.
 *
 * @param overrides - Fields to replace.
 * @returns Run input.
 */
function createInput(overrides: Partial<RunDataMigrationInput> & Pick<RunDataMigrationInput, 'rowStore'>): RunDataMigrationInput {
  return {
    definition: createTaskEstimateMigration(),
    checkpointStore: createMemoryCheckpointStore(),
    clock: createManualClock(),
    runId: 'run-1',
    mode: 'apply',
    pageSize: 2,
    maxPages: 100,
    maxWritesPerSecond: 1000,
    ...overrides,
  }
}

describe('runDataMigration', () => {
  test('migrates every pending row, counts other rows and completes each partition', async () => {
    const rowStore = createMemoryRowStore({
      'segment-0-of-2': [
        createPendingTaskRow(1),
        { pk: 'TEAM#a', sk: 'META', entity: 'team', name: 'A' },
        createPendingTaskRow(2),
      ],
      'segment-1-of-2': [
        { pk: 'TEAM#b', sk: 'TASK#001', entity: 'task', schemaVersion: 2, estimatePoints: 5 },
      ],
    })
    const checkpointStore = createMemoryCheckpointStore()
    const report = await runDataMigration(createInput({ rowStore, checkpointStore }))

    expect(report.status).toBe('completed')
    expect(report.counters).toEqual({ scanned: 4, migrated: 2, alreadyMigrated: 1, unrelated: 1, vanished: 0 })
    expect(report.pagesRead).toBe(3)
    expect(rowStore.rows.get('TEAM#a|TASK#001')).toEqual({
      pk: 'TEAM#a', sk: 'TASK#001', entity: 'task', schemaVersion: 2, estimatePoints: 1,
    })
    const checkpoints = [...checkpointStore.checkpoints.values()]
    expect(checkpoints.map((checkpoint) => [checkpoint.partitionId, checkpoint.status, checkpoint.cursor, checkpoint.leaseOwner]))
      .toEqual([
        ['segment-0-of-2', 'completed', undefined, undefined],
        ['segment-1-of-2', 'completed', undefined, undefined],
      ])
    expect(JSON.stringify(report)).not.toContain('TEAM#')

    const verification = await verifyDataMigration({
      definition: createTaskEstimateMigration(),
      rowStore,
      checkpointStore,
      pageSize: 100,
      maxPages: 100,
    })
    expect(verification).toMatchObject({ status: 'pass', partitions: 2, completedPartitions: 2, pendingRows: 0, migratedRows: 3 })
  })

  test('pauses when the page budget runs out and resumes from the checkpoint', async () => {
    const rowStore = createMemoryRowStore({
      'segment-0-of-1': [1, 2, 3, 4, 5].map(createPendingTaskRow),
    })
    const checkpointStore = createMemoryCheckpointStore()
    const first = await runDataMigration(createInput({ rowStore, checkpointStore, maxPages: 2 }))

    expect(first.status).toBe('paused')
    expect(first.counters.migrated).toBe(4)
    const paused = checkpointStore.checkpoints.get('0001-task-estimate-points|segment-0-of-1')
    expect(paused).toMatchObject({ status: 'in-progress', cursor: '4' })
    expect(paused?.leaseOwner).toBeUndefined()

    const verificationWhilePaused = await verifyDataMigration({
      definition: createTaskEstimateMigration(), rowStore, checkpointStore, pageSize: 100, maxPages: 100,
    })
    expect(verificationWhilePaused).toMatchObject({ status: 'fail', pendingRows: 1, completedPartitions: 0 })

    const second = await runDataMigration(createInput({ rowStore, checkpointStore, runId: 'run-2' }))
    expect(second.status).toBe('completed')
    expect(second.counters).toMatchObject({ scanned: 1, migrated: 1 })
    expect(checkpointStore.checkpoints.get('0001-task-estimate-points|segment-0-of-1')?.counters)
      .toEqual({ scanned: 5, migrated: 5, alreadyMigrated: 0, unrelated: 0, vanished: 0 })
  })

  test('repeats a page safely after a failure in the middle of it', async () => {
    const rowStore = createMemoryRowStore({
      'segment-0-of-1': [1, 2].map(createPendingTaskRow),
    })
    const checkpointStore = createMemoryCheckpointStore()
    let failSecond = true
    rowStore.beforeReplace = (row) => !(failSecond && row.sk === 'TASK#002')
    const failed = await runDataMigration(createInput({ rowStore, checkpointStore }))
    expect(failed).toMatchObject({ status: 'failed', failureCode: 'WRITE_CONFLICT' })
    expect(checkpointStore.checkpoints.get('0001-task-estimate-points|segment-0-of-1')?.leaseOwner).toBeUndefined()

    failSecond = false
    const resumed = await runDataMigration(createInput({ rowStore, checkpointStore, runId: 'run-2' }))
    expect(resumed.status).toBe('completed')
    expect(resumed.counters).toMatchObject({ migrated: 1, alreadyMigrated: 1 })
  })

  test('dry run validates transforms and writes neither rows nor checkpoints', async () => {
    const rowStore = createMemoryRowStore({ 'segment-0-of-1': [1, 2, 3].map(createPendingTaskRow) })
    const checkpointStore = createMemoryCheckpointStore()
    const report = await runDataMigration(createInput({ rowStore, checkpointStore, mode: 'dry-run' }))

    expect(report).toMatchObject({ status: 'completed', mode: 'dry-run' })
    expect(report.counters.migrated).toBe(3)
    expect(rowStore.replaceCalls).toBe(0)
    expect(checkpointStore.checkpoints.size).toBe(0)
  })

  test('stops on an unknown row before writing any row of the page', async () => {
    const rowStore = createMemoryRowStore({
      'segment-0-of-1': [createPendingTaskRow(1), { pk: 'TEAM#a', sk: 'TASK#009', entity: 'task', schemaVersion: 7 }],
    })
    const report = await runDataMigration(createInput({ rowStore }))

    expect(report).toMatchObject({ status: 'failed', failureCode: 'UNKNOWN_ROW' })
    expect(rowStore.replaceCalls).toBe(0)
  })

  test('rejects a transform that changes the key or does not reach the target version', async () => {
    const rowStore = createMemoryRowStore({ 'segment-0-of-1': [createPendingTaskRow(1)] })
    const changesKey = createTaskEstimateMigration({
      transform: (row) => ({ ...row, sk: 'OTHER', schemaVersion: 2, estimatePoints: 1, estimate: undefined }),
    })
    expect(await runDataMigration(createInput({ rowStore, definition: changesKey })))
      .toMatchObject({ status: 'failed', failureCode: 'TRANSFORM_INVALID' })
    const keepsVersion = createTaskEstimateMigration({ transform: (row) => ({ ...row }) })
    expect(await runDataMigration(createInput({ rowStore, definition: keepsVersion, mode: 'dry-run' })))
      .toMatchObject({ status: 'failed', failureCode: 'TRANSFORM_INVALID' })
    expect(rowStore.replaceCalls).toBe(0)
  })

  test('counts a row a writer migrated or deleted after the page was read', async () => {
    const rowStore = createMemoryRowStore({ 'segment-0-of-1': [1, 2].map(createPendingTaskRow) })
    rowStore.beforeReplace = (row) => {
      if (row.sk === 'TASK#001') {
        rowStore.rows.set('TEAM#a|TASK#001', { ...row, estimatePoints: 9 })
        return false
      }
      rowStore.rows.delete('TEAM#a|TASK#002')
      return false
    }
    const report = await runDataMigration(createInput({ rowStore }))
    expect(report.status).toBe('completed')
    expect(report.counters).toMatchObject({ migrated: 0, alreadyMigrated: 1, vanished: 1 })
    expect(rowStore.rows.get('TEAM#a|TASK#001')?.estimatePoints).toBe(9)
  })

  test('retries a revision-fenced row with the revision a writer advanced', async () => {
    const definition = createTaskEstimateMigration({ writerPolicy: 'revision-fenced', revisionAttribute: 'revision' })
    const rowStore = createMemoryRowStore({ 'segment-0-of-1': [{ ...createPendingTaskRow(1), revision: 3 }] })
    let writerRan = false
    rowStore.beforeReplace = () => {
      if (!writerRan) {
        writerRan = true
        rowStore.rows.set('TEAM#a|TASK#001', { ...createPendingTaskRow(1), estimate: '8', revision: 4 })
      }
      return true
    }
    const report = await runDataMigration(createInput({ rowStore, definition }))
    expect(report.counters.migrated).toBe(1)
    expect(rowStore.replaceCalls).toBe(2)
    expect(rowStore.rows.get('TEAM#a|TASK#001')).toMatchObject({ schemaVersion: 2, estimatePoints: 8, revision: 4 })
  })

  test('refuses a partition leased by another live run and takes over an expired lease', async () => {
    const rowStore = createMemoryRowStore({ 'segment-0-of-1': [1, 2, 3].map(createPendingTaskRow) })
    const checkpointStore = createMemoryCheckpointStore()
    const clock = createManualClock()
    await runDataMigration(createInput({ rowStore, checkpointStore, clock, maxPages: 1 }))
    const stored = checkpointStore.checkpoints.get('0001-task-estimate-points|segment-0-of-1')
    if (stored === undefined) throw new Error('missing checkpoint')
    checkpointStore.checkpoints.set('0001-task-estimate-points|segment-0-of-1', {
      ...stored,
      leaseOwner: 'other-run',
      leaseExpiresAt: new Date(clock.current + 60_000).toISOString(),
    })

    expect(await runDataMigration(createInput({ rowStore, checkpointStore, clock, runId: 'run-2' })))
      .toMatchObject({ status: 'failed', failureCode: 'LEASE_HELD' })
    clock.current += 120_000
    expect(await runDataMigration(createInput({ rowStore, checkpointStore, clock, runId: 'run-2' })))
      .toMatchObject({ status: 'completed' })
  })

  test('rejects checkpoints written for another partition plan or version', async () => {
    const checkpointStore = createMemoryCheckpointStore()
    await runDataMigration(createInput({
      rowStore: createMemoryRowStore({ 'segment-0-of-1': [createPendingTaskRow(1), createPendingTaskRow(2), createPendingTaskRow(3)] }),
      checkpointStore,
      maxPages: 1,
    }))
    const replanned = createMemoryRowStore({ 'segment-0-of-2': [], 'segment-1-of-2': [] })
    expect(await runDataMigration(createInput({ rowStore: replanned, checkpointStore })))
      .toMatchObject({ status: 'failed', failureCode: 'PARTITION_PLAN_MISMATCH' })

    const sameIdNewVersion = createTaskEstimateMigration({ fromSchemaVersion: 2, toSchemaVersion: 3 })
    expect(await runDataMigration(createInput({
      rowStore: createMemoryRowStore({ 'segment-0-of-1': [] }),
      checkpointStore,
      definition: sameIdNewVersion,
    }))).toMatchObject({ status: 'failed', failureCode: 'DEFINITION_MISMATCH' })
  })

  test('spaces writes by the write budget', async () => {
    const clock = createManualClock()
    const rowStore = createMemoryRowStore({ 'segment-0-of-1': [1, 2, 3].map(createPendingTaskRow) })
    await runDataMigration(createInput({ rowStore, clock, maxWritesPerSecond: 10, pageSize: 10 }))
    expect(clock.sleeps).toEqual([100, 100])
  })

  test('fails on a repeated cursor and on invalid bounds', async () => {
    const rowStore = createMemoryRowStore({ 'segment-0-of-1': [1, 2, 3].map(createPendingTaskRow) })
    const looping = { ...rowStore, readPage: async () => ({ rows: [], nextCursor: 'same' }) }
    expect(await runDataMigration(createInput({ rowStore: looping, mode: 'dry-run' })))
      .toMatchObject({ status: 'failed', failureCode: 'CURSOR_REPEATED' })
    expect(await runDataMigration(createInput({ rowStore, pageSize: 101 })))
      .toMatchObject({ status: 'failed', failureCode: 'DEFINITION_INVALID' })
    expect(await runDataMigration(createInput({ rowStore, maxWritesPerSecond: 0 })))
      .toMatchObject({ status: 'failed', failureCode: 'DEFINITION_INVALID' })
  })
})

describe('verifyDataMigration', () => {
  test('reports incomplete when the page budget runs out and fails on unknown rows', async () => {
    const checkpointStore = createMemoryCheckpointStore()
    const rowStore = createMemoryRowStore({ 'segment-0-of-1': [1, 2, 3].map(createPendingTaskRow) })
    expect(await verifyDataMigration({
      definition: createTaskEstimateMigration(), rowStore, checkpointStore, pageSize: 1, maxPages: 2,
    })).toMatchObject({ status: 'incomplete', scanned: 2 })

    const unknown = createMemoryRowStore({ 'segment-0-of-1': [{ pk: 'TEAM#a', sk: 'TASK#1', entity: 'task', schemaVersion: 9 }] })
    expect(await verifyDataMigration({
      definition: createTaskEstimateMigration(), rowStore: unknown, checkpointStore, pageSize: 10, maxPages: 10,
    })).toMatchObject({ status: 'fail', unknownRows: 1 })
  })
})
