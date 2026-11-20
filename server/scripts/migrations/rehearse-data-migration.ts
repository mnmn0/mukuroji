import { randomUUID } from 'node:crypto'
import {
  CreateTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import { PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb,
} from '../../src/infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../src/infrastructure/config/server-config'
import { createDataMigrationRehearsalDependencies } from '../../src/app/composition/data-migration'
import {
  ensureLocalDataMigrationCheckpointTable,
  handleDataMigrationInvocation,
  type DataMigrationInvocationResponse,
} from '../../src/modules/data-migration'
import { createRehearsalMigration, createRehearsalSeed, REHEARSAL_TABLE } from './rehearsal-migration'

/** Old-schema rows seeded by default. */
const DEFAULT_PENDING_ROWS = 60

/** Rows per page in the rehearsal, small enough to span several pages. */
const PAGE_SIZE = 10

/** Operator the stub verifier reports; STS is not available on the emulator. */
const REHEARSAL_OPERATOR = 'local-emulator'

/** One checked step of the rehearsal. */
type RehearsalStep = {
  /** Step name. */
  readonly step: string
  /** Whether the outcome matched the expectation. */
  readonly ok: boolean
  /** Content-free response or observation. */
  readonly result: Readonly<Record<string, unknown>>
}

/** Parsed command line. */
type RehearsalOptions = {
  /** Old-schema rows to seed. */
  readonly pendingRows: number
  /** Keep the rehearsal tables instead of deleting them. */
  readonly keep: boolean
}

/**
 * Parses the command line.
 *
 * @param arguments_ - Arguments after the script path.
 * @returns The options, or `undefined` when they are invalid.
 */
function parseOptions(arguments_: readonly string[]): RehearsalOptions | undefined {
  let pendingRows = DEFAULT_PENDING_ROWS
  let keep = false
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index]
    if (flag === '--keep' && !keep) {
      keep = true
      continue
    }
    const value = arguments_[index + 1] ?? ''
    if (flag !== '--rows' || !/^[1-9][0-9]{0,3}$/u.test(value)) return undefined
    pendingRows = Number(value)
    // The first page of an interrupted apply must leave pending rows behind.
    if (pendingRows <= PAGE_SIZE) return undefined
    index += 1
  }
  return { pendingRows, keep }
}

/**
 * Creates a rehearsal target table keyed by `pk` and `sk`.
 *
 * @param client - Client bound to the local emulator.
 * @param tableName - Table name.
 */
async function createTargetTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(new CreateTableCommand({
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  }))
  await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: tableName })
}

/**
 * Counts the run records stored for a migration and the operators they name.
 *
 * @param documentClient - Document client bound to the local emulator.
 * @param checkpointTableName - Checkpoint table name.
 * @param migrationId - Migration identifier.
 * @returns Run record count, statuses and operators.
 */
async function readRunRecords(
  documentClient: DynamoDBDocumentClient,
  checkpointTableName: string,
  migrationId: string,
): Promise<{
  /** Number of run records. */
  readonly count: number
  /** Final statuses in start order. */
  readonly statuses: readonly unknown[]
  /** Distinct operators. */
  readonly operators: readonly unknown[]
}> {
  const output = await documentClient.send(new QueryCommand({
    TableName: checkpointTableName,
    KeyConditionExpression: 'migrationId = :id',
    ExpressionAttributeValues: { ':id': `RUN#${migrationId}` },
    ConsistentRead: true,
  }))
  const items = output.Items ?? []
  return {
    count: items.length,
    statuses: items.map((item) => item.status),
    operators: [...new Set(items.map((item) => item.operator))],
  }
}

/**
 * Seeds an old-schema table on the local emulator, then drives the same
 * adapter the data migration Lambda runs through dry run, an interrupted
 * apply, a resumed apply and verify, checking each outcome and the run
 * records. Only an explicit local emulator endpoint is accepted.
 *
 * @param arguments_ - Arguments after the script path.
 * @returns Process exit status: 0 pass, 1 fail, 2 usage or not a local emulator.
 */
export async function rehearseDataMigration(arguments_: readonly string[]): Promise<0 | 1 | 2> {
  const options = parseOptions(arguments_)
  if (options === undefined) {
    console.error(JSON.stringify({ status: 'error', code: 'INVALID_USAGE' }))
    console.error(`Usage: bun run data:migrate:rehearsal [--rows <${PAGE_SIZE + 1}-9999>] [--keep]`)
    return 2
  }
  const config = loadServerConfig()
  if (!shouldBootstrapLocalDynamoDb(config)) {
    console.error(JSON.stringify({ status: 'error', code: 'LOCAL_EMULATOR_REQUIRED' }))
    return 2
  }
  const client = createDynamoDbClient(config)
  const documentClient = createDynamoDbDocumentClient(client)
  const suffix = randomUUID().slice(0, 8)
  const tableName = `mukuroji-data-migration-rehearsal-${suffix}`
  const checkpointTableName = `mukuroji-data-migration-rehearsal-checkpoints-${suffix}`
  const definition = createRehearsalMigration()
  const seed = createRehearsalSeed(options.pendingRows)
  const steps: RehearsalStep[] = []
  const created: string[] = []
  let invocation = 0
  try {
    await createTargetTable(client, tableName)
    created.push(tableName)
    await ensureLocalDataMigrationCheckpointTable(client, checkpointTableName)
    created.push(checkpointTableName)
    for (const row of seed.rows) {
      await documentClient.send(new PutCommand({ TableName: tableName, Item: row }))
    }
    const dependencies = createDataMigrationRehearsalDependencies({
      documentClient,
      registry: [definition],
      targetTables: new Map([[REHEARSAL_TABLE, tableName]]),
      checkpointTableName,
      operator: REHEARSAL_OPERATOR,
    })
    /**
     * Invokes the Lambda adapter in-process with a synthetic context: a fresh
     * request ID per call, a placeholder function and account, and the full
     * 15 minutes of a Lambda invocation remaining.
     *
     * @param payload - Invocation payload, as an operator would send it.
     * @returns The adapter response.
     */
    const invoke = async (payload: Readonly<Record<string, unknown>>): Promise<DataMigrationInvocationResponse> => {
      invocation += 1
      return await handleDataMigrationInvocation(payload, {
        requestId: `rehearsal-${invocation}`,
        functionName: 'data-migration-rehearsal',
        accountId: '000000000000',
        remainingMilliseconds: 15 * 60 * 1000,
      }, dependencies)
    }
    // Enough pages to read the whole seed in one invocation, plus the empty last page.
    const fullPages = Math.ceil(seed.rows.length / PAGE_SIZE) + 1
    /**
     * Builds an applying run payload. Each call carries a new nonce, as each
     * operator invocation does; the stub verifier accepts the placeholder proof.
     *
     * @param maxPages - Page budget of the invocation.
     * @returns The payload.
     */
    const applyPayload = (maxPages: number) => ({
      command: 'run',
      migrationId: definition.id,
      apply: true,
      segments: 1,
      pageSize: PAGE_SIZE,
      maxWritesPerSecond: 1000,
      maxPages,
      nonce: randomUUID(),
      operatorProof: 'local-rehearsal',
    })
    /**
     * Records and prints the outcome of one rehearsal step.
     *
     * @param step - Step name.
     * @param ok - Whether the outcome matched the expectation.
     * @param result - Content-free response or observation.
     */
    const check = (step: string, ok: boolean, result: Readonly<Record<string, unknown>>) => {
      steps.push({ step, ok, result })
      console.log(JSON.stringify({ step, ok, result }))
    }
    /**
     * Reads the counters of a run response.
     *
     * @param response - Adapter response.
     * @returns The counters, or `undefined` when the response has none.
     */
    const counters = (response: DataMigrationInvocationResponse) => response.counters

    const listed = await invoke({ command: 'list' })
    check('list', JSON.stringify(listed).includes(definition.id), listed)

    const dryRun = await invoke({
      command: 'run', migrationId: definition.id, segments: 1, pageSize: PAGE_SIZE, maxPages: fullPages,
    })
    check('dry-run', dryRun.status === 'completed' &&
      JSON.stringify(counters(dryRun)) === JSON.stringify({
        scanned: seed.rows.length,
        migrated: seed.pending,
        alreadyMigrated: seed.migrated,
        unrelated: seed.unrelated,
        vanished: 0,
      }), dryRun)

    const unverified = await invoke({ ...applyPayload(fullPages), operatorProof: undefined })
    check('apply-without-proof-refused', unverified.status === 'error' && unverified.code === 'INVALID_REQUEST', unverified)

    const interrupted = await invoke(applyPayload(1))
    check('apply-interrupted', interrupted.status === 'paused' && interrupted.pagesRead === 1, interrupted)

    const midway = await invoke({ command: 'verify', migrationId: definition.id, segments: 1, maxPages: fullPages })
    check('verify-before-resume', midway.status === 'fail' && typeof midway.pendingRows === 'number' && midway.pendingRows > 0, midway)

    const resumed = await invoke(applyPayload(fullPages))
    check('apply-resumed', resumed.status === 'completed', resumed)

    const verified = await invoke({ command: 'verify', migrationId: definition.id, segments: 1, maxPages: fullPages })
    check('verify', verified.status === 'pass' &&
      verified.migratedRows === seed.pending + seed.migrated &&
      verified.pendingRows === 0, verified)

    const records = await readRunRecords(documentClient, checkpointTableName, definition.id)
    check('run-records', records.count === 2 &&
      JSON.stringify(records.operators) === JSON.stringify([REHEARSAL_OPERATOR]) &&
      records.statuses.includes('paused') &&
      records.statuses.includes('completed'), records)
  } catch (error: unknown) {
    steps.push({ step: 'unexpected-error', ok: false, result: { name: error instanceof Error ? error.name : 'unknown' } })
  } finally {
    if (!options.keep) {
      for (const name of created) {
        try {
          await client.send(new DeleteTableCommand({ TableName: name }))
        } catch {
          console.error(JSON.stringify({ status: 'warning', code: 'TABLE_NOT_DELETED' }))
        }
      }
    }
  }
  const passed = steps.length > 0 && steps.every((step) => step.ok)
  console.log(JSON.stringify({
    operation: 'rehearsal',
    status: passed ? 'pass' : 'fail',
    steps: steps.map((step) => ({ step: step.step, ok: step.ok })),
    ...(options.keep ? { tableName, checkpointTableName } : {}),
  }))
  return passed ? 0 : 1
}

if (import.meta.main) {
  void rehearseDataMigration(Bun.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
