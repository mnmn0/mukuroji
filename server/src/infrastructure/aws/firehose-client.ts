import { FirehoseClient } from '@aws-sdk/client-firehose'
import { loadServerConfig } from '../config/server-config'

/**
 * Creates an Amazon Data Firehose client from the centralized server configuration. A local
 * emulator is used when `AWS_ENDPOINT_URL_FIREHOSE` or `AWS_ENDPOINT_URL` is set.
 *
 * @returns A configured Firehose client.
 */
export function createFirehoseClient(): FirehoseClient {
  const config = loadServerConfig()
  const endpoint = config.environment.AWS_ENDPOINT_URL_FIREHOSE?.trim() || config.environment.AWS_ENDPOINT_URL?.trim() || undefined
  return new FirehoseClient({
    region: config.awsRegion,
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: config.environment.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: config.environment.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
}

