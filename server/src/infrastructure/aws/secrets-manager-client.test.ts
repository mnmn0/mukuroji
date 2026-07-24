import { expect, test } from 'bun:test'
import { loadServerConfig } from '../config/server-config'
import { createSecretsManagerClientConfig } from './secrets-manager-client'

test('omits credentials so a regional AWS endpoint uses the SDK provider chain', () => {
  const config = loadServerConfig({
    AWS_REGION: 'us-east-1',
    SECRETS_MANAGER_ENDPOINT: 'https://secretsmanager.us-east-1.amazonaws.com',
  }, { localBun: false })

  expect(createSecretsManagerClientConfig(config)).toEqual({
    endpoint: 'https://secretsmanager.us-east-1.amazonaws.com',
    region: 'us-east-1',
  })
})

test('uses non-secret fallback credentials only for a validated local emulator', () => {
  const config = loadServerConfig({
    AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-backend-local',
    MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
    SECRETS_MANAGER_ENDPOINT: 'http://floci:4566',
  }, { localBun: false })

  expect(createSecretsManagerClientConfig(config)).toEqual({
    credentials: {
      accessKeyId: 'test',
      secretAccessKey: 'test',
    },
    endpoint: 'http://floci:4566',
    region: 'us-east-1',
  })
})

test('preserves an explicit static credential pair and session token', () => {
  const config = loadServerConfig({
    AWS_ACCESS_KEY_ID: ' access-key ',
    AWS_REGION: 'ap-northeast-1',
    AWS_SECRET_ACCESS_KEY: ' secret-key ',
    AWS_SESSION_TOKEN: ' session-token ',
  }, { localBun: false })

  expect(createSecretsManagerClientConfig(config)).toEqual({
    credentials: {
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      sessionToken: 'session-token',
    },
    region: 'ap-northeast-1',
  })
})

for (const environment of [
  { AWS_ACCESS_KEY_ID: 'access-key' },
  { AWS_SECRET_ACCESS_KEY: 'secret-key' },
  { AWS_SESSION_TOKEN: 'session-token' },
  {
    AWS_ACCESS_KEY_ID: 'access-key',
    AWS_SESSION_TOKEN: 'session-token',
  },
]) {
  test(`rejects incomplete explicit static credentials: ${JSON.stringify(environment)}`, () => {
    const config = loadServerConfig(environment, { localBun: false })
    expect(() => createSecretsManagerClientConfig(config)).toThrow(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be configured together',
    )
  })
}
