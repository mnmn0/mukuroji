import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { getConfiguredDynamoDbEndpoint } from '../audit'

const localDynamoDbTableInitializers = new Map<string, Promise<void>>()

/**
 * 実行環境の設定に合わせた low-level DynamoDB client を生成します。
 */
export function createDynamoDbClient() {
  const endpoint = getDynamoDbEndpoint()

  return new DynamoDBClient({
    region: getAwsRegion(),
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: getEnv('AWS_ACCESS_KEY_ID') ?? 'test',
            secretAccessKey: getEnv('AWS_SECRET_ACCESS_KEY') ?? 'test',
          },
        }
      : {}),
  })
}

/**
 * undefined 値を除外して marshal する DynamoDB document client を生成します。
 */
export function createDynamoDbDocumentClient(
  dynamoDbClient = createDynamoDbClient(),
) {
  return DynamoDBDocumentClient.from(dynamoDbClient, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  })
}

/**
 * ローカル DynamoDB の table を一度だけ初期化し、schema が一致するまで待機します。
 */
export async function ensureLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  createCommand: () => CreateTableCommand,
  validateTable: (table: TableDescription | undefined) => boolean,
) {
  if (!shouldBootstrapLocalDynamoDb()) {
    return false
  }

  const initializerKey = `${getDynamoDbEndpoint()}#${tableName}`
  const existingInitializer = localDynamoDbTableInitializers.get(initializerKey)

  if (existingInitializer) {
    await existingInitializer
    return true
  }

  const initializer = createLocalDynamoDbTable(
    tableName,
    dynamoDbClient,
    createCommand,
    validateTable,
  ).finally(() => {
    localDynamoDbTableInitializers.delete(initializerKey)
  })

  localDynamoDbTableInitializers.set(initializerKey, initializer)
  await initializer

  return true
}

/**
 * 現在の endpoint がローカル DynamoDB の自動初期化対象かを返します。
 */
export function shouldBootstrapLocalDynamoDb() {
  const endpoint = getDynamoDbEndpoint()

  return Boolean(
    endpoint &&
    /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|floci)(?::|\/|$)/.test(endpoint),
  )
}

/**
 * AWS SDK error が resource 未検出を表すかを返します。
 */
export function isResourceNotFoundError(error: unknown) {
  return isAwsNamedError(error, 'ResourceNotFoundException')
}

/**
 * AWS SDK error の name が指定値と一致するかを返します。
 */
export function isAwsNamedError(error: unknown, name: string) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name
}

async function createLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  createCommand: () => CreateTableCommand,
  validateTable: (table: TableDescription | undefined) => boolean,
) {
  try {
    await dynamoDbClient.send(createCommand())
  } catch (error) {
    if (!isResourceInUseError(error)) {
      throw error
    }
  }

  await waitForLocalDynamoDbTable(tableName, dynamoDbClient, validateTable)
}

async function waitForLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  validateTable: (table: TableDescription | undefined) => boolean,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await dynamoDbClient.send(
      new DescribeTableCommand({
        TableName: tableName,
      }),
    )

    if (response.Table?.TableStatus === 'ACTIVE' && validateTable(response.Table)) {
      return
    }

    if (response.Table?.TableStatus === 'ACTIVE') {
      throw new Error(`Local DynamoDB table "${tableName}" does not match the expected schema.`)
    }

    await sleep(100)
  }

  throw new Error(`Local DynamoDB table "${tableName}" did not become active.`)
}

function isResourceInUseError(error: unknown) {
  return isAwsNamedError(error, 'ResourceInUseException')
}

function getAwsRegion() {
  return getEnv('AWS_REGION') ?? getEnv('AWS_DEFAULT_REGION') ?? 'us-east-1'
}

function getDynamoDbEndpoint() {
  const configuredEndpoint = getConfiguredDynamoDbEndpoint({
    DYNAMODB_ENDPOINT: getEnv('DYNAMODB_ENDPOINT'),
    AWS_ENDPOINT_URL_DYNAMODB: getEnv('AWS_ENDPOINT_URL_DYNAMODB'),
    AWS_ENDPOINT_URL: getEnv('AWS_ENDPOINT_URL'),
  })

  if (configuredEndpoint) {
    return configuredEndpoint
  }

  return typeof Bun !== 'undefined' && !getEnv('AWS_LAMBDA_FUNCTION_NAME')
    ? 'http://localhost:4566'
    : undefined
}

function getEnv(name: string) {
  if (typeof Bun !== 'undefined') {
    return Bun.env[name]
  }

  return process.env[name]
}

async function sleep(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}
