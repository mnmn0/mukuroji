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
    port: 3000,
    production: false,
    workspaceSearchProjectionEnabled: false,
  })
  expect(config.allowedOrigins).toContain('http://localhost:5173')
  expect(environment).toEqual({ NODE_ENV: 'test' })
})

test('normalizes explicit endpoints, origins, and production cursor validation', () => {
  const config = loadServerConfig({
    ALLOWED_ORIGINS: ' https://app.example.com,https://admin.example.com ',
    AWS_DEFAULT_REGION: 'ap-northeast-1',
    AWS_LAMBDA_FUNCTION_NAME: 'api',
    COGNITO_ENDPOINT: 'https://cognito.example.com///',
    DYNAMODB_ENDPOINT: 'https://dynamodb.example.com',
    PORT: '8080',
    PUBLIC_API_CURSOR_SECRET: 'production-public-api-cursor-secret-value',
  }, { localBun: false })

  expect(config).toMatchObject({
    allowedOrigins: ['https://app.example.com', 'https://admin.example.com'],
    awsRegion: 'ap-northeast-1',
    cognitoEndpoint: 'https://cognito.example.com',
    dynamoDbEndpoint: 'https://dynamodb.example.com',
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
    AWS_ENDPOINT_URL: 'https://fallback.example.com',
    COGNITO_ENDPOINT: ' ',
    MUKUROJI_RUNTIME_ROLE: ' ',
    PORT: '0',
  }, { localBun: false })

  expect(config.cognitoEndpoint).toBeUndefined()
  expect(config.runtimeRole).toBe(' ')
  expect(config.port).toBe(0)
})
