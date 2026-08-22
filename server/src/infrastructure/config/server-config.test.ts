import { expect, test } from 'bun:test'
import { loadServerConfig } from './server-config'

test('loads stable local server defaults without mutating the environment', () => {
  const environment = {
    NODE_ENV: 'test',
  }
  const config = loadServerConfig(environment, { localBun: true })

  expect(config).toMatchObject({
    awsRegion: 'us-east-1',
    cognitoEndpoint: 'http://localhost:4566',
    dynamoDbEndpoint: 'http://localhost:4566',
    secretsManagerEndpoint: undefined,
    secretsManagerEndpointIsLocal: false,
    sqsEndpoint: undefined,
    port: 3000,
    production: false,
    workspaceSearchProjectionEnabled: false,
  })
  expect(config.allowedOrigins).toContain('http://localhost:5173')
  expect(environment).toEqual({ NODE_ENV: 'test' })
})

for (const legacyName of [
  'MUKUROJI_WORK_ITEMS_TABLE',
  'MUKUROJI_TEAM_ISSUES_TABLE',
  'TEAM_ISSUES_TABLE_NAME',
]) {
  test(`rejects the removed Work Items environment alias: ${legacyName}`, () => {
    expect(() => loadServerConfig({
      [legacyName]: 'legacy-work-items-table',
    }, { localBun: true })).toThrow(
      `${legacyName} is no longer supported. Use WORK_ITEMS_TABLE_NAME.`,
    )
  })
}

test('normalizes explicit endpoints, origins, and production cursor validation', () => {
  const config = loadServerConfig({
    ALLOWED_ORIGINS: ' https://app.example.com,https://admin.example.com ',
    AWS_DEFAULT_REGION: 'ap-northeast-1',
    AWS_LAMBDA_FUNCTION_NAME: 'api',
    COGNITO_ENDPOINT: 'https://cognito.example.com///',
    DYNAMODB_ENDPOINT: 'https://dynamodb.example.com',
    SECRETS_MANAGER_ENDPOINT: ' https://secretsmanager.ap-northeast-1.amazonaws.com ',
    SQS_ENDPOINT: 'https://sqs.example.com',
    PORT: '8080',
    PUBLIC_API_CURSOR_SECRET: 'production-public-api-cursor-secret-value',
  }, { localBun: false })

  expect(config).toMatchObject({
    allowedOrigins: ['https://app.example.com', 'https://admin.example.com'],
    awsRegion: 'ap-northeast-1',
    cognitoEndpoint: 'https://cognito.example.com',
    dynamoDbEndpoint: 'https://dynamodb.example.com',
    secretsManagerEndpoint: 'https://secretsmanager.ap-northeast-1.amazonaws.com',
    secretsManagerEndpointIsLocal: false,
    sqsEndpoint: 'https://sqs.example.com',
    port: 8080,
    production: true,
    publicApiCursorSecret: 'production-public-api-cursor-secret-value',
  })
  expect(() => loadServerConfig({
    NODE_ENV: 'production',
  }, { localBun: false }).publicApiCursorSecret).toThrow(
    'A 32-byte Public API cursor signing secret is required.',
  )
})

test('preserves legacy blank Cognito endpoint, runtime role, and port semantics', () => {
  const config = loadServerConfig({
    COGNITO_ENDPOINT: ' ',
    MUKUROJI_RUNTIME_ROLE: ' ',
    PORT: '0',
  }, { localBun: false })

  expect(config.cognitoEndpoint).toBeUndefined()
  expect(config.secretsManagerEndpoint).toBeUndefined()
  expect(config.runtimeRole).toBe(' ')
  expect(config.port).toBe(0)
})

test('preserves Secrets Manager endpoint precedence and accepts regional FIPS endpoints', () => {
  const config = loadServerConfig({
    AWS_REGION: 'us-east-1',
    SECRETS_MANAGER_ENDPOINT: ' https://secretsmanager-fips.us-east-1.amazonaws.com ',
    AWS_ENDPOINT_URL_SECRETS_MANAGER: 'https://secretsmanager.us-east-1.amazonaws.com',
    AWS_ENDPOINT_URL_SECRETSMANAGER: 'https://secretsmanager.us-east-1.amazonaws.com',
    AWS_ENDPOINT_URL: 'https://secretsmanager.us-east-1.amazonaws.com',
  }, { localBun: false })

  expect(config.secretsManagerEndpoint).toBe(
    'https://secretsmanager-fips.us-east-1.amazonaws.com',
  )
  expect(config.secretsManagerEndpointIsLocal).toBeFalse()
})

test('uses the next non-blank Secrets Manager endpoint without changing legacy precedence', () => {
  const config = loadServerConfig({
    AWS_REGION: 'cn-north-1',
    SECRETS_MANAGER_ENDPOINT: ' ',
    AWS_ENDPOINT_URL_SECRETS_MANAGER:
      ' https://secretsmanager.cn-north-1.amazonaws.com.cn ',
    AWS_ENDPOINT_URL_SECRETSMANAGER:
      'https://secretsmanager-fips.cn-north-1.amazonaws.com.cn',
  }, { localBun: false })

  expect(config.secretsManagerEndpoint).toBe(
    'https://secretsmanager.cn-north-1.amazonaws.com.cn',
  )
})

test('uses the shared AWS endpoint only after service-specific values are blank', () => {
  const config = loadServerConfig({
    AWS_REGION: 'us-east-1',
    SECRETS_MANAGER_ENDPOINT: '',
    AWS_ENDPOINT_URL_SECRETS_MANAGER: ' ',
    AWS_ENDPOINT_URL_SECRETSMANAGER: '\t',
    AWS_ENDPOINT_URL: ' https://secretsmanager.us-east-1.amazonaws.com ',
  }, { localBun: false })

  expect(config.secretsManagerEndpoint).toBe(
    'https://secretsmanager.us-east-1.amazonaws.com',
  )
})

test('fails closed on a malformed higher-precedence endpoint', () => {
  expect(() => loadServerConfig({
    AWS_REGION: 'us-east-1',
    SECRETS_MANAGER_ENDPOINT: 'not a URL',
    AWS_ENDPOINT_URL: 'https://secretsmanager.us-east-1.amazonaws.com',
  }, { localBun: false })).toThrow('Secrets Manager endpoint')
})

for (const endpoint of [
  'not a URL',
  'http://secretsmanager.us-east-1.amazonaws.com',
  'https://secretsmanager.us-west-2.amazonaws.com',
  'https://secrets.example.com',
  'https://secretsmanager.us-east-1.amazonaws.com.evil.example',
  'https://user@secretsmanager.us-east-1.amazonaws.com',
  'https://secretsmanager.us-east-1.amazonaws.com:443',
  'https://secretsmanager.us-east-1.amazonaws.com:8443',
  'https://secretsmanager.us-east-1.amazonaws.com/v1',
  'https://secretsmanager.us-east-1.amazonaws.com?version=1',
  'https://secretsmanager.us-east-1.amazonaws.com#fragment',
]) {
  test(`rejects an unsafe production Secrets Manager endpoint: ${endpoint}`, () => {
    expect(() => loadServerConfig({
      AWS_REGION: 'us-east-1',
      NODE_ENV: 'production',
      SECRETS_MANAGER_ENDPOINT: endpoint,
    }, { localBun: false })).toThrow('Secrets Manager endpoint')
  })
}

for (const endpoint of [
  'http://localhost:4566',
  'http://127.0.0.1:4566',
  'http://[::1]:4566',
  'http://floci:4566',
  'http://localstack:4566',
]) {
  test(`allows an explicit local Secrets Manager endpoint: ${endpoint}`, () => {
    const config = loadServerConfig({
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-backend-local',
      MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
      SECRETS_MANAGER_ENDPOINT: endpoint,
    }, { localBun: false })

    expect(config.production).toBeTrue()
    expect(config.secretsManagerEndpoint).toBe(endpoint)
    expect(config.secretsManagerEndpointIsLocal).toBeTrue()
  })
}

test('requires the exact local runtime marker for local Secrets Manager endpoints', () => {
  expect(() => loadServerConfig({
    AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-backend-local',
    SECRETS_MANAGER_ENDPOINT: 'http://floci:4566',
  }, { localBun: false })).toThrow('MUKUROJI_LOCAL_AWS_RUNTIME=floci')

  expect(() => loadServerConfig({
    MUKUROJI_LOCAL_AWS_RUNTIME: 'true',
    SECRETS_MANAGER_ENDPOINT: 'http://127.0.0.1:4566',
  }, { localBun: false })).toThrow('MUKUROJI_LOCAL_AWS_RUNTIME=floci')
})

test('never allows the local runtime marker to bypass NODE_ENV production', () => {
  expect(() => loadServerConfig({
    MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
    NODE_ENV: 'production',
    SECRETS_MANAGER_ENDPOINT: 'http://localhost:4566',
  }, { localBun: false })).toThrow('MUKUROJI_LOCAL_AWS_RUNTIME=floci')
})
