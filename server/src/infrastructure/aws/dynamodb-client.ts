import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { loadServerConfig } from '../config/server-config'

/**
 * Creates a low-level DynamoDB client from the current server configuration.
 *
 * @returns A configured DynamoDB client.
 */
export function createDynamoDbClient(): DynamoDBClient {
  const config = loadServerConfig()

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
 * Determines whether missing tables may be bootstrapped for the configured local endpoint.
 *
 * @returns Whether local DynamoDB table bootstrapping is enabled.
 */
export function shouldBootstrapLocalDynamoDb(): boolean {
  const endpoint = loadServerConfig().dynamoDbEndpoint

  return Boolean(
    endpoint &&
    /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|floci)(?::|\/|$)/.test(endpoint),
  )
}
