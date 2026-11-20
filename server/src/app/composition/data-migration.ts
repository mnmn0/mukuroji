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
  DataMigrationFailure,
  ensureLocalDataMigrationCheckpointTable,
  type DataMigrationCheckpointStore,
  type DataMigrationRowStore,
} from '../../modules/data-migration'

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
