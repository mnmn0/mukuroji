import { describe, expect, test } from 'bun:test'
import {
  createManualClock,
  createMemoryCheckpointStore,
  createMemoryRowStore,
  createPendingTaskRow,
  createTaskEstimateMigration,
} from '../../src/modules/data-migration/test-support/data-migration-fakes'
import type { DataMigrationDefinition } from '../../src/modules/data-migration'
import { dataMigrationRegistry } from '../../src/app/composition/data-migration-registry'
import {
  parseDataMigrationCliArguments,
  runDataMigrationCli,
  type DataMigrationCliDependencies,
} from './run-data-migration'

/**
 * Builds CLI dependencies over in-memory stores.
 *
 * @param registry - Registered migrations.
 * @returns The dependencies, the stores and the captured output.
 */
function createDependencies(registry: readonly DataMigrationDefinition[] = [createTaskEstimateMigration()]) {
  const rowStore = createMemoryRowStore({ 'segment-0-of-1': [1, 2, 3].map(createPendingTaskRow) })
  const checkpointStore = createMemoryCheckpointStore()
  const output: string[] = []
  const errors: string[] = []
  const storeRequests: unknown[] = []
  const dependencies: DataMigrationCliDependencies = {
    registry,
    createStores: async (request) => {
      storeRequests.push({ ...request })
      return { rowStore, checkpointStore }
    },
    clock: createManualClock(),
    resolveOperator: async () => 'arn:aws:sts::123456789012:assumed-role/operator/session',
    createRunId: () => 'run-1',
    writeOutput: (line) => output.push(line),
    writeError: (line) => errors.push(line),
  }
  return { dependencies, rowStore, checkpointStore, output, errors, storeRequests }
}

/** Required flags of `run` and `verify`. */
const tableFlags = [
  '--migration', '0001-task-estimate-points',
  '--table-name', 'work-items',
  '--checkpoint-table-name', 'migrations',
]

describe('data migration CLI', () => {
  test('the shipped registry is valid', async () => {
    const { dependencies, output } = createDependencies(dataMigrationRegistry)
    expect(await runDataMigrationCli(['list'], dependencies)).toBe(0)
    expect(JSON.parse(output[0] ?? '{}')).toEqual({ operation: 'list', migrations: [] })
  })

  test('dry-runs by default and writes nothing', async () => {
    const { dependencies, rowStore, checkpointStore, output } = createDependencies()
    expect(await runDataMigrationCli(['run', ...tableFlags], dependencies)).toBe(0)
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({ operation: 'run', mode: 'dry-run', status: 'completed' })
    expect(rowStore.replaceCalls).toBe(0)
    expect(checkpointStore.checkpoints.size).toBe(0)
  })

  test('applies, pauses on the page budget, resumes and verifies', async () => {
    const { dependencies, output, storeRequests } = createDependencies()
    expect(await runDataMigrationCli(['verify', ...tableFlags], dependencies)).toBe(1)
    expect(await runDataMigrationCli(
      ['run', ...tableFlags, '--apply', '--page-size', '2', '--max-pages', '1', '--segments', '1'],
      dependencies,
    )).toBe(3)
    expect(await runDataMigrationCli(['run', ...tableFlags, '--apply', '--segments', '1'], dependencies)).toBe(0)
    expect(await runDataMigrationCli(['verify', ...tableFlags, '--segments', '1'], dependencies)).toBe(0)
    expect(output.map((line) => JSON.parse(line).status)).toEqual(['fail', 'paused', 'completed', 'pass'])
    expect(storeRequests[1]).toMatchObject({ tableName: 'work-items', checkpointTableName: 'migrations', segments: 1 })
    expect(output.join('\n')).not.toContain('TEAM#')
  })

  test('reports usage errors and unknown migrations with stable codes', async () => {
    const { dependencies, errors } = createDependencies()
    expect(await runDataMigrationCli(['run', '--migration'], dependencies)).toBe(2)
    expect(JSON.parse(errors[0] ?? '{}')).toEqual({ status: 'error', code: 'INVALID_USAGE' })
    expect(await runDataMigrationCli(['run', ...tableFlags.slice(0, 1), '0009-missing', ...tableFlags.slice(2)], dependencies)).toBe(2)
    expect(errors.some((line) => line.includes('MIGRATION_NOT_FOUND'))).toBe(true)
  })

  test('rejects invalid registries without touching stores', async () => {
    const { dependencies, errors, storeRequests } = createDependencies([createTaskEstimateMigration(), createTaskEstimateMigration()])
    expect(await runDataMigrationCli(['run', ...tableFlags], dependencies)).toBe(1)
    expect(JSON.parse(errors[0] ?? '{}')).toMatchObject({ code: 'DEFINITION_INVALID' })
    expect(storeRequests).toHaveLength(0)
  })

  test.each([
    [['unknown']],
    [['list', '--apply']],
    [['run', ...tableFlags, '--page-size', '101']],
    [['run', ...tableFlags, '--segments', '0']],
    [['run', ...tableFlags, '--segments', '65']],
    [['run', ...tableFlags, '--apply', '--apply']],
    [['run', ...tableFlags, '--migration', 'again']],
    [['verify', ...tableFlags, '--apply']],
    [['verify', ...tableFlags, '--max-writes-per-second', '5']],
    [['run', '--table-name', 'work-items', '--checkpoint-table-name', 'migrations']],
  ])('rejects %j', (arguments_) => {
    expect(() => parseDataMigrationCliArguments(arguments_)).toThrow('INVALID_USAGE')
  })
})
