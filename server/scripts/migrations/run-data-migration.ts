import { randomUUID } from 'node:crypto'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb,
} from '../../src/infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../src/infrastructure/config/server-config'
import {
  assertValidDataMigrationRegistry,
  createDynamoDbDataMigrationCheckpointStore,
  createDynamoDbDataMigrationRowStore,
  DATA_MIGRATION_MAX_PAGE_SIZE,
  DATA_MIGRATION_MAX_SEGMENTS,
  DataMigrationFailure,
  ensureLocalDataMigrationCheckpointTable,
  runDataMigration,
  verifyDataMigration,
  type DataMigrationCheckpointStore,
  type DataMigrationClock,
  type DataMigrationDefinition,
  type DataMigrationRowStore,
} from '../../src/modules/data-migration'
import { dataMigrationRegistry } from './registry'

/** Process exit status: 0 done, 1 failed, 2 usage error, 3 paused or incomplete. */
export type DataMigrationCliExitCode = 0 | 1 | 2 | 3

/** Default rows per page for `run`. */
const DEFAULT_RUN_PAGE_SIZE = 25

/** Default rows per page for `verify`. */
const DEFAULT_VERIFY_PAGE_SIZE = DATA_MIGRATION_MAX_PAGE_SIZE

/** Default page budget for `run`. */
const DEFAULT_RUN_MAX_PAGES = 200

/** Default page budget for `verify`. */
const DEFAULT_VERIFY_MAX_PAGES = 10_000

/** Default parallel scan segments. */
const DEFAULT_SEGMENTS = 4

/** Default write budget. */
const DEFAULT_MAX_WRITES_PER_SECOND = 25

/** Flags that take a value. */
const VALUE_FLAGS = new Set([
  '--migration',
  '--table-name',
  '--checkpoint-table-name',
  '--segments',
  '--page-size',
  '--max-pages',
  '--max-writes-per-second',
])

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(['--apply'])

/** Parsed command line. */
type DataMigrationCliCommand =
  | {
      /** Prints usage. */
      readonly command: 'help'
    }
  | {
      /** Lists registered migrations. */
      readonly command: 'list'
    }
  | {
      /** Runs or checks one migration. */
      readonly command: 'run' | 'verify'
      /** Migration identifier. */
      readonly migrationId: string
      /** Physical target table name. */
      readonly tableName: string
      /** Physical checkpoint table name. */
      readonly checkpointTableName: string
      /** Parallel scan segments. */
      readonly segments: number
      /** Rows per page. */
      readonly pageSize: number
      /** Page budget. */
      readonly maxPages: number
      /** Write budget. */
      readonly maxWritesPerSecond: number
      /** Whether `run` writes; without it `run` is a dry run. */
      readonly apply: boolean
    }

/** Ports the CLI builds for one invocation. */
type DataMigrationCliStores = {
  /** Target table rows. */
  readonly rowStore: DataMigrationRowStore
  /** Checkpoint table. */
  readonly checkpointStore: DataMigrationCheckpointStore
}

/** Injectable dependencies of the CLI. */
export type DataMigrationCliDependencies = {
  /** Registered migrations. */
  readonly registry: readonly DataMigrationDefinition[]
  /**
   * Builds the stores for one invocation.
   *
   * @param request - Table names and segment count.
   * @returns The stores.
   */
  readonly createStores: (request: {
    /** Physical target table name. */
    readonly tableName: string
    /** Physical checkpoint table name. */
    readonly checkpointTableName: string
    /** Parallel scan segments. */
    readonly segments: number
  }) => Promise<DataMigrationCliStores>
  /** Time source and delay. */
  readonly clock: DataMigrationClock
  /**
   * Creates a run identifier.
   *
   * @returns A unique identifier.
   */
  readonly createRunId: () => string
  /**
   * Writes one stdout line.
   *
   * @param line - Line text.
   */
  readonly writeOutput: (line: string) => void
  /**
   * Writes one stderr line.
   *
   * @param line - Line text.
   */
  readonly writeError: (line: string) => void
}

/** Usage text printed by `help`. */
const USAGE = [
  'Usage: bun run data:migrate <command> [flags]',
  '',
  'Commands:',
  '  list                     List registered migrations.',
  '  run                      Dry run a migration; add --apply to write rows and checkpoints.',
  '  verify                   Check that every partition is completed and no row is pending.',
  '',
  'Flags for run and verify:',
  '  --migration <id>                 Migration identifier (required).',
  '  --table-name <name>              Physical target table name (required).',
  '  --checkpoint-table-name <name>   Physical checkpoint table name (required).',
  `  --segments <n>                   Parallel scan segments, 1-${DATA_MIGRATION_MAX_SEGMENTS} (default ${DEFAULT_SEGMENTS}).`,
  `  --page-size <n>                  Rows per page, 1-${DATA_MIGRATION_MAX_PAGE_SIZE}.`,
  '  --max-pages <n>                  Page budget of this invocation.',
  `  --max-writes-per-second <n>      Write budget for run (default ${DEFAULT_MAX_WRITES_PER_SECOND}).`,
  '  --apply                          run only: write rows and checkpoints.',
  '',
  'Exit status: 0 completed or pass, 1 failed, 2 usage error, 3 paused or incomplete.',
].join('\n')

/** Default dependencies bound to the server configuration. */
const defaultDependencies: DataMigrationCliDependencies = {
  registry: dataMigrationRegistry,
  createStores: async ({ tableName, checkpointTableName, segments }) => {
    const config = loadServerConfig()
    const dynamoDbClient = createDynamoDbClient(config)
    const documentClient = createDynamoDbDocumentClient(dynamoDbClient)
    if (shouldBootstrapLocalDynamoDb(config)) {
      await ensureLocalDataMigrationCheckpointTable(dynamoDbClient, checkpointTableName)
    }
    return {
      rowStore: createDynamoDbDataMigrationRowStore({ documentClient, tableName, totalSegments: segments }),
      checkpointStore: createDynamoDbDataMigrationCheckpointStore({ documentClient, tableName: checkpointTableName }),
    }
  },
  clock: {
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  },
  createRunId: () => randomUUID(),
  writeOutput: (line) => console.log(line),
  writeError: (line) => console.error(line),
}

/** Usage error raised while parsing the command line. */
class DataMigrationCliUsageError extends Error {
  /**
   * Creates a usage error.
   */
  constructor() {
    super('INVALID_USAGE')
    this.name = 'DataMigrationCliUsageError'
  }
}

/**
 * Parses the command line.
 *
 * @param arguments_ - Arguments after the script path.
 * @returns The parsed command.
 * @throws DataMigrationCliUsageError for unknown commands, flags or values.
 */
export function parseDataMigrationCliArguments(arguments_: readonly string[]): DataMigrationCliCommand {
  const [command, ...rest] = arguments_
  if (command === 'help' || command === '--help') {
    if (rest.length > 0) throw new DataMigrationCliUsageError()
    return { command: 'help' }
  }
  if (command === 'list') {
    if (rest.length > 0) throw new DataMigrationCliUsageError()
    return { command: 'list' }
  }
  if (command !== 'run' && command !== 'verify') throw new DataMigrationCliUsageError()
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? ''
    if (BOOLEAN_FLAGS.has(flag) && !booleans.has(flag)) {
      booleans.add(flag)
      continue
    }
    const value = rest[index + 1]
    if (!VALUE_FLAGS.has(flag) || values.has(flag) || value === undefined || value.startsWith('--')) {
      throw new DataMigrationCliUsageError()
    }
    values.set(flag, value)
    index += 1
  }
  if (command === 'verify' && (booleans.has('--apply') || values.has('--max-writes-per-second'))) {
    throw new DataMigrationCliUsageError()
  }
  return {
    command,
    migrationId: requireText(values.get('--migration')),
    tableName: requireText(values.get('--table-name')),
    checkpointTableName: requireText(values.get('--checkpoint-table-name')),
    segments: readInteger(values.get('--segments'), DEFAULT_SEGMENTS, DATA_MIGRATION_MAX_SEGMENTS),
    pageSize: readInteger(
      values.get('--page-size'),
      command === 'run' ? DEFAULT_RUN_PAGE_SIZE : DEFAULT_VERIFY_PAGE_SIZE,
      DATA_MIGRATION_MAX_PAGE_SIZE,
    ),
    maxPages: readInteger(
      values.get('--max-pages'),
      command === 'run' ? DEFAULT_RUN_MAX_PAGES : DEFAULT_VERIFY_MAX_PAGES,
      Number.MAX_SAFE_INTEGER,
    ),
    maxWritesPerSecond: readInteger(
      values.get('--max-writes-per-second'),
      DEFAULT_MAX_WRITES_PER_SECOND,
      1000,
    ),
    apply: booleans.has('--apply'),
  }
}

/**
 * Requires a non-blank flag value.
 *
 * @param value - Flag value.
 * @returns The value.
 */
function requireText(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0 || value.trim() !== value) {
    throw new DataMigrationCliUsageError()
  }
  return value
}

/**
 * Reads a positive integer flag within bounds.
 *
 * @param value - Flag value, if given.
 * @param fallback - Value when the flag is absent.
 * @param maximum - Largest accepted value.
 * @returns The integer.
 */
function readInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!/^[1-9][0-9]*$/u.test(value)) throw new DataMigrationCliUsageError()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new DataMigrationCliUsageError()
  return parsed
}

/**
 * Runs the migration CLI and reports one JSON line.
 *
 * @param arguments_ - Arguments after the script path.
 * @param dependencies - Injectable dependencies used by tests.
 * @returns Process exit status.
 */
export async function runDataMigrationCli(
  arguments_: readonly string[],
  dependencies: DataMigrationCliDependencies = defaultDependencies,
): Promise<DataMigrationCliExitCode> {
  let command: DataMigrationCliCommand
  try {
    command = parseDataMigrationCliArguments(arguments_)
  } catch {
    dependencies.writeError(JSON.stringify({ status: 'error', code: 'INVALID_USAGE' }))
    dependencies.writeError(USAGE)
    return 2
  }
  if (command.command === 'help') {
    dependencies.writeOutput(USAGE)
    return 0
  }
  try {
    assertValidDataMigrationRegistry(dependencies.registry)
    if (command.command === 'list') {
      dependencies.writeOutput(JSON.stringify({
        operation: 'list',
        migrations: dependencies.registry.map((definition) => ({
          id: definition.id,
          description: definition.description,
          table: definition.table,
          fromSchemaVersion: definition.fromSchemaVersion,
          toSchemaVersion: definition.toSchemaVersion,
          writerPolicy: definition.writerPolicy,
        })),
      }))
      return 0
    }
    const definition = dependencies.registry.find((candidate) => candidate.id === command.migrationId)
    if (definition === undefined) {
      dependencies.writeError(JSON.stringify({ operation: command.command, status: 'error', code: 'MIGRATION_NOT_FOUND' }))
      return 2
    }
    const stores = await dependencies.createStores(command)
    if (command.command === 'verify') {
      const report = await verifyDataMigration({
        definition,
        ...stores,
        pageSize: command.pageSize,
        maxPages: command.maxPages,
      })
      dependencies.writeOutput(JSON.stringify({ operation: 'verify', ...report }))
      return report.status === 'pass' ? 0 : report.status === 'incomplete' ? 3 : 1
    }
    const report = await runDataMigration({
      definition,
      ...stores,
      clock: dependencies.clock,
      runId: dependencies.createRunId(),
      mode: command.apply ? 'apply' : 'dry-run',
      pageSize: command.pageSize,
      maxPages: command.maxPages,
      maxWritesPerSecond: command.maxWritesPerSecond,
    })
    dependencies.writeOutput(JSON.stringify({ operation: 'run', ...report }))
    return report.status === 'completed' ? 0 : report.status === 'paused' ? 3 : 1
  } catch (error: unknown) {
    dependencies.writeError(JSON.stringify({
      operation: command.command,
      status: 'error',
      code: error instanceof DataMigrationFailure ? error.code : 'UPSTREAM_FAILURE',
      ...(error instanceof DataMigrationFailure && error.detail !== undefined ? { detail: error.detail } : {}),
    }))
    return 1
  }
}

if (import.meta.main) {
  void runDataMigrationCli(Bun.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
