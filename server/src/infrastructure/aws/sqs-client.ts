import { SQSClient } from '@aws-sdk/client-sqs'
import { loadServerConfig } from '../config/server-config'

/**
 * Creates an SQS client from the centralized server configuration.
 *
 * @returns A configured SQS client.
 */
export function createSqsClient(): SQSClient {
  const config = loadServerConfig()

  return new SQSClient({
    region: config.awsRegion,
    ...(config.sqsEndpoint
      ? {
          endpoint: config.sqsEndpoint,
          credentials: {
            accessKeyId: config.environment.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: config.environment.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
}
