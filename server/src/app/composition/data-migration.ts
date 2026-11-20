import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb,
} from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import {
  createDynamoDbDataMigrationCheckpointStore,
  createDynamoDbDataMigrationRowStore,
  createStsDataMigrationOperatorVerifier,
  DataMigrationFailure,
  ensureLocalDataMigrationCheckpointTable,
  type DataMigrationCheckpointStore,
  type DataMigrationInvocationDependencies,
  type DataMigrationRowStore,
} from '../../modules/data-migration'
import { dataMigrationRegistry } from './data-migration-registry'

/** Physical tables and plan of one migration invocation. */
export type DataMigrationStoreRequest = {
  /** Physical target table name. */
  readonly tableName: string
  /** Physical checkpoint table name. */
  readonly checkpointTableName: string
  /** Parallel scan segments. */
  readonly segments: number
}

/** Stores the migration use cases run against. */
export type DataMigrationStores = {
  /** Target table rows. */
  readonly rowStore: DataMigrationRowStore
  /** Checkpoints and run records. */
  readonly checkpointStore: DataMigrationCheckpointStore
}

/**
 * Builds the DynamoDB stores for one migration invocation from the server
 * configuration. The checkpoint table is created only on an explicit local
 * emulator endpoint.
 *
 * @param request - Physical tables and plan.
 * @returns The stores.
 */
export async function createProductionDataMigrationStores(
  request: DataMigrationStoreRequest,
): Promise<DataMigrationStores> {
  const config = loadServerConfig()
  const dynamoDbClient = createDynamoDbClient(config)
  const documentClient = createDynamoDbDocumentClient(dynamoDbClient)
  if (shouldBootstrapLocalDynamoDb(config)) {
    await ensureLocalDataMigrationCheckpointTable(dynamoDbClient, request.checkpointTableName)
  }
  return {
    rowStore: createDynamoDbDataMigrationRowStore({
      documentClient,
      tableName: request.tableName,
      totalSegments: request.segments,
    }),
    checkpointStore: createDynamoDbDataMigrationCheckpointStore({
      documentClient,
      tableName: request.checkpointTableName,
    }),
  }
}

/**
 * Resolves the authenticated principal recorded with an applying migration
 * run: the STS caller ARN, or `local-emulator` on an explicit local endpoint.
 *
 * @returns The principal.
 * @throws DataMigrationFailure with `RUN_LOG_FAILED` when the caller cannot be resolved.
 */
export async function resolveProductionDataMigrationOperator(): Promise<string> {
  const config = loadServerConfig()
  if (shouldBootstrapLocalDynamoDb(config)) return 'local-emulator'
  let arn: string | undefined
  try {
    const identity = await new STSClient({ region: config.awsRegion }).send(new GetCallerIdentityCommand({}))
    arn = identity.Arn
  } catch (error: unknown) {
    throw new DataMigrationFailure('RUN_LOG_FAILED', error)
  }
  if (arn === undefined || arn.length === 0) throw new DataMigrationFailure('RUN_LOG_FAILED')
  return arn
}

/** Environment variables the data migration Lambda reads. */
export type DataMigrationLambdaEnvironment = Readonly<Record<string, string | undefined>>

/** Pattern of a DynamoDB table name. */
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/u

/** Pattern of a logical table name used by migration definitions. */
const LOGICAL_TABLE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u

/**
 * Builds the dependencies of the data migration Lambda from its environment:
 * the checkpoint table, the allowlist of target tables by logical name, and
 * an STS operator verifier for the function's region. Every store uses the
 * function's own role; the operator's identity comes only from the verified
 * proof.
 *
 * @param environment - Lambda environment.
 * @returns The adapter dependencies.
 * @throws TypeError when the environment is incomplete or malformed.
 */
export function createDataMigrationLambdaDependencies(
  environment: DataMigrationLambdaEnvironment = process.env,
): DataMigrationInvocationDependencies {
  const region = environment.AWS_REGION ?? ''
  const checkpointTableName = environment.DATA_MIGRATION_CHECKPOINT_TABLE_NAME ?? ''
  if (!TABLE_NAME_PATTERN.test(checkpointTableName)) {
    throw new TypeError('DATA_MIGRATION_CHECKPOINT_TABLE_NAME is invalid.')
  }
  const targetTables = parseDataMigrationTargetTables(environment.DATA_MIGRATION_TARGET_TABLES)
  const documentClient = createDynamoDbDocumentClient(new DynamoDBClient({ region }))
  return {
    registry: dataMigrationRegistry,
    targetTables,
    checkpointTableName,
    createStores: async (request) => ({
      rowStore: createDynamoDbDataMigrationRowStore({
        documentClient,
        tableName: request.tableName,
        totalSegments: request.segments,
      }),
      checkpointStore: createDynamoDbDataMigrationCheckpointStore({
        documentClient,
        tableName: request.checkpointTableName,
      }),
    }),
    verifyOperator: createStsDataMigrationOperatorVerifier({ region }),
    clock: {
      now: () => Date.now(),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    },
    createRunId: () => randomUUID(),
    writeAuditLog: (line) => console.log(line),
  }
}

/**
 * Parses the JSON allowlist of migratable tables, `{ "<logical>": "<physical>" }`.
 *
 * @param value - Environment value.
 * @returns Physical table names by logical name.
 * @throws TypeError when the value is not such an object.
 */
export function parseDataMigrationTargetTables(value: string | undefined): ReadonlyMap<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value ?? '')
  } catch {
    throw new TypeError('DATA_MIGRATION_TARGET_TABLES is invalid.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('DATA_MIGRATION_TARGET_TABLES is invalid.')
  }
  const tables = new Map<string, string>()
  for (const [logical, physical] of Object.entries(parsed)) {
    if (!LOGICAL_TABLE_PATTERN.test(logical) || typeof physical !== 'string' || !TABLE_NAME_PATTERN.test(physical)) {
      throw new TypeError('DATA_MIGRATION_TARGET_TABLES is invalid.')
    }
    tables.set(logical, physical)
  }
  return tables
}
