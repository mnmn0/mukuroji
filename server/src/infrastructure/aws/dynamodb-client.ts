import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  loadServerConfig,
  type ServerConfig,
} from '../config/server-config'
import {
  bindPlanningRevisionFenceBarrierDocumentClient,
} from '../runtime/planning-revision-fence-barrier'

/**
 * Creates a low-level DynamoDB client from the current server configuration.
 *
 * @param config - One validated configuration snapshot retained by the client.
 * @returns A configured DynamoDB client.
 */
export function createDynamoDbClient(
  config: ServerConfig = loadServerConfig(),
): DynamoDBClient {
  return new DynamoDBClient({
    region: config.awsRegion,
    ...(config.dynamoDbEndpoint
      ? {
          endpoint: config.dynamoDbEndpoint,
          credentials: {
            accessKeyId: config.environment.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: config.environment.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
}

/**
 * Creates a DynamoDB document client with undefined-value removal enabled.
 *
 * @param dynamoDbClient - Low-level DynamoDB client to wrap.
 * @returns A configured DynamoDB document client.
 */
export function createDynamoDbDocumentClient(
  dynamoDbClient: DynamoDBClient = createDynamoDbClient(),
): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(dynamoDbClient, {
    marshallOptions: { removeUndefinedValues: true },
  })
}

/**
 * Creates the scoped DocumentClient used by writers that advance Planning's
 * isolated revision fence.
 *
 * This barrier is intentionally opt-in. Installing it on the generic
 * DynamoDB factory would make unrelated tables depend on Planning migration
 * state and could turn a local migration issue into a repository-wide outage.
 *
 * @param dynamoDbClient - Low-level DynamoDB client to wrap.
 * @param config - Configuration snapshot that supplies the Planning table name.
 * @returns A DocumentClient that rejects direct fenced writes outside transactions.
 */
export function createPlanningRevisionFenceWriterDynamoDbDocumentClient(
  dynamoDbClient: DynamoDBClient = createDynamoDbClient(),
  config: ServerConfig = loadServerConfig(),
): DynamoDBDocumentClient {
  return bindPlanningRevisionFenceBarrierDocumentClient(
    createDynamoDbDocumentClient(dynamoDbClient),
    config.environment.PLANNING_TABLE_NAME,
  )
}

/**
 * Determines whether missing tables may be bootstrapped for the configured local endpoint.
 *
 * @param config - One validated configuration snapshot used by the caller.
 * @returns Whether local DynamoDB table bootstrapping is enabled.
 */
export function shouldBootstrapLocalDynamoDb(
  config: ServerConfig = loadServerConfig(),
): boolean {
  return isExplicitLocalDynamoDbEndpoint(config.dynamoDbEndpoint)
}

/**
 * Validates a loopback or named Floci HTTP DynamoDB endpoint.
 *
 * @param endpoint - Candidate resolved endpoint.
 * @returns Whether it is an exact supported local origin.
 */
function isExplicitLocalDynamoDbEndpoint(
  endpoint: string | undefined,
): boolean {
  if (!endpoint) return false
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname === '/' &&
    !parsed.search &&
    !parsed.hash &&
    [
      'localhost',
      '127.0.0.1',
      '[::1]',
      '0.0.0.0',
      'floci',
      'localstack',
    ].includes(parsed.hostname)
}
