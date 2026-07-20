import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb'

/**
 * Enterprise interactive session の idle activity 更新入力です。
 */
export type EnterpriseSessionActivityInput = {
  /** Workspace ごとに分離された session scope です。 */
  workspaceId: string
  /** Raw access token を含まない SHA-256 session identifier です。 */
  sessionId: string
  /** Cognito `auth_time` または `iat` の epoch seconds です。 */
  authenticatedAt: number
  /** Server current time の epoch seconds です。 */
  now: number
  /** 許容する idle interval の分数です。 */
  idleTimeoutMinutes: number
  /** Activity record を保持する session absolute lifetime の分数です。 */
  sessionLifetimeMinutes: number
  /** Token claim から安全に確認できた authentication method 一覧です。 */
  authenticationMethods: string[]
}

/**
 * Authentication 完了直後に session と結び付ける assurance 入力です。
 */
export type EnterpriseSessionAssuranceInput = {
  /** Workspace ごとに分離された session scope です。 */
  workspaceId: string
  /** Raw access token を含まない SHA-256 session identifier です。 */
  sessionId: string
  /** Server が実際に完了させた authentication method 一覧です。 */
  authenticationMethods: string[]
  /** Authentication 完了時刻の epoch seconds です。 */
  authenticatedAt: number
  /** Cognito access token の expiry epoch seconds です。 */
  expiresAt: number
}

/**
 * Session activity store の最小契約です。
 */
export interface EnterpriseSessionActivityClient {
  /** Idle timeout を検査し、許可された request の activity を記録します。 */
  validateAndTouch(input: EnterpriseSessionActivityInput): Promise<string[]>
  /** Server が完了を確認した MFA/SSO method を access token digest と結び付けます。 */
  recordAuthenticationAssurance(input: EnterpriseSessionAssuranceInput): Promise<void>
  /** Access token digest に結び付いた server-verified method を返します。 */
  getAuthenticationMethods(workspaceId: string, sessionId: string): Promise<string[]>
}

/**
 * Session activity 検査の stable error です。
 */
export class EnterpriseSessionActivityError extends Error {
  /** HTTP response に対応する status code です。 */
  readonly status: number
  /** Web が分岐できる stable error code です。 */
  readonly code: string

  /**
   * Session activity error を作成します。
   */
  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EnterpriseSessionActivityError'
    this.status = status
    this.code = code
  }
}

/**
 * DynamoDB-backed session activity client です。
 */
export class DynamoDbEnterpriseSessionActivityClient
implements EnterpriseSessionActivityClient {
  /** Realtime connection と session activity を共有する table 名です。 */
  private readonly tableName: string
  /** Session activity record を強整合 read/write する client です。 */
  private readonly documentClient: DynamoDBDocumentClient

  /**
   * DynamoDB-backed session activity client を作成します。
   */
  constructor(
    tableName: string,
    documentClient = createEnterpriseSessionActivityDocumentClient(),
  ) {
    this.tableName = requireText(tableName, 'Session activity table name')
    this.documentClient = documentClient
  }

  /** Idle timeout を検査し、許可された request の activity を記録します。 */
  async validateAndTouch(input: EnterpriseSessionActivityInput) {
    validateInput(input)
    const connectionId = `HTTP_SESSION#${input.workspaceId}#${input.sessionId}`
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { connectionId },
        ConsistentRead: true,
      }))
      const storedLastSeenAt = response.Item?.workspaceId === input.workspaceId &&
          Number.isSafeInteger(response.Item.lastSeenAt)
        ? response.Item.lastSeenAt as number
        : input.authenticatedAt
      const authenticationMethods = readAuthenticationMethods(
        response.Item?.authenticationMethods,
        input.authenticationMethods,
      )
      if (input.now - storedLastSeenAt > input.idleTimeoutMinutes * 60) {
        throw new EnterpriseSessionActivityError(
          403,
          'EnterpriseSessionIdleTimeout',
          'Current session exceeded the Workspace idle timeout.',
        )
      }
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          connectionId,
          itemType: 'http-session-activity',
          workspaceId: input.workspaceId,
          lastSeenAt: input.now,
          authenticationMethods,
          expiresAt: input.authenticatedAt + input.sessionLifetimeMinutes * 60,
        },
        ConditionExpression:
          'attribute_not_exists(lastSeenAt) OR lastSeenAt <= :currentTime',
        ExpressionAttributeValues: { ':currentTime': input.now },
      }))
      return authenticationMethods
    } catch (error) {
      if (error instanceof EnterpriseSessionActivityError) throw error
      if (isConditionalWriteError(error)) return [...input.authenticationMethods]
      throw new EnterpriseSessionActivityError(
        503,
        'EnterpriseSessionActivityUnavailable',
        'Session activity could not be verified.',
        { cause: error },
      )
    }
  }

  /** Server が完了を確認した MFA/SSO method を access token digest と結び付けます。 */
  async recordAuthenticationAssurance(input: EnterpriseSessionAssuranceInput) {
    validateAssuranceInput(input)
    const connectionId = `HTTP_SESSION#${input.workspaceId}#${input.sessionId}`
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          connectionId,
          itemType: 'http-session-activity',
          workspaceId: input.workspaceId,
          lastSeenAt: input.authenticatedAt,
          authenticationMethods: [...new Set(input.authenticationMethods)],
          expiresAt: input.expiresAt,
        },
      }))
    } catch (error) {
      throw new EnterpriseSessionActivityError(
        503,
        'EnterpriseSessionActivityUnavailable',
        'Authentication assurance could not be recorded.',
        { cause: error },
      )
    }
  }

  /** Access token digest に結び付いた server-verified method を返します。 */
  async getAuthenticationMethods(workspaceId: string, sessionId: string) {
    const connectionId = `HTTP_SESSION#${requireText(workspaceId, 'Workspace ID')}#${requireText(
      sessionId,
      'Session ID',
    )}`
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { connectionId },
        ConsistentRead: true,
      }))
      return response.Item?.workspaceId === workspaceId
        ? readAuthenticationMethods(response.Item.authenticationMethods, [])
        : []
    } catch (error) {
      throw new EnterpriseSessionActivityError(
        503,
        'EnterpriseSessionActivityUnavailable',
        'Authentication assurance could not be verified.',
        { cause: error },
      )
    }
  }
}

/**
 * Test/local 用 memory-backed session activity client です。
 */
export class InMemoryEnterpriseSessionActivityClient
implements EnterpriseSessionActivityClient {
  /** Session identifier ごとの last activity と assurance です。 */
  private readonly sessions = new Map<string, {
    /** 最終 activity epoch seconds です。 */
    lastSeenAt: number
    /** Server-verified authentication method 一覧です。 */
    authenticationMethods: string[]
  }>()

  /** Idle timeout を検査し、許可された request の activity を記録します。 */
  async validateAndTouch(input: EnterpriseSessionActivityInput) {
    validateInput(input)
    const key = `${input.workspaceId}\0${input.sessionId}`
    const current = this.sessions.get(key)
    const lastSeenAt = current?.lastSeenAt ?? input.authenticatedAt
    if (input.now - lastSeenAt > input.idleTimeoutMinutes * 60) {
      throw new EnterpriseSessionActivityError(
        403,
        'EnterpriseSessionIdleTimeout',
        'Current session exceeded the Workspace idle timeout.',
      )
    }
    const authenticationMethods = [
      ...new Set([
        ...(current?.authenticationMethods ?? []),
        ...input.authenticationMethods,
      ]),
    ]
    this.sessions.set(key, {
      lastSeenAt: Math.max(lastSeenAt, input.now),
      authenticationMethods,
    })
    return authenticationMethods
  }

  /** Server が完了を確認した MFA/SSO method を access token digest と結び付けます。 */
  async recordAuthenticationAssurance(input: EnterpriseSessionAssuranceInput) {
    validateAssuranceInput(input)
    this.sessions.set(`${input.workspaceId}\0${input.sessionId}`, {
      lastSeenAt: input.authenticatedAt,
      authenticationMethods: [...new Set(input.authenticationMethods)],
    })
  }

  /** Access token digest に結び付いた server-verified method を返します。 */
  async getAuthenticationMethods(workspaceId: string, sessionId: string) {
    return [...(this.sessions.get(
      `${requireText(workspaceId, 'Workspace ID')}\0${requireText(sessionId, 'Session ID')}`,
    )?.authenticationMethods ?? [])]
  }
}

/**
 * Environment に応じた session activity client を作成します。
 */
export function createEnterpriseSessionActivityClient() {
  const tableName = process.env.REALTIME_SESSIONS_TABLE_NAME?.trim() ??
    process.env.MUKUROJI_REALTIME_SESSIONS_TABLE?.trim()
  return tableName
    ? new DynamoDbEnterpriseSessionActivityClient(tableName)
    : new InMemoryEnterpriseSessionActivityClient()
}

function validateInput(input: EnterpriseSessionActivityInput) {
  requireText(input.workspaceId, 'Workspace ID')
  requireText(input.sessionId, 'Session ID')
  if (
    !Number.isSafeInteger(input.authenticatedAt) ||
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(input.idleTimeoutMinutes) ||
    !Number.isSafeInteger(input.sessionLifetimeMinutes) ||
    input.authenticatedAt > input.now ||
    input.idleTimeoutMinutes < 1 ||
    input.sessionLifetimeMinutes < 1
  ) {
    throw new EnterpriseSessionActivityError(
      403,
      'EnterpriseSessionDenied',
      'Session activity context is invalid.',
    )
  }
  if (
    !Array.isArray(input.authenticationMethods) ||
    input.authenticationMethods.some((method) => typeof method !== 'string')
  ) {
    throw new EnterpriseSessionActivityError(
      403,
      'EnterpriseSessionDenied',
      'Session authentication methods are invalid.',
    )
  }
}

function validateAssuranceInput(input: EnterpriseSessionAssuranceInput) {
  requireText(input.workspaceId, 'Workspace ID')
  requireText(input.sessionId, 'Session ID')
  if (
    !Array.isArray(input.authenticationMethods) ||
    input.authenticationMethods.length === 0 ||
    input.authenticationMethods.some((method) => typeof method !== 'string' || !method.trim()) ||
    !Number.isSafeInteger(input.authenticatedAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.authenticatedAt >= input.expiresAt
  ) {
    throw new EnterpriseSessionActivityError(
      503,
      'EnterpriseSessionAssuranceInvalid',
      'Authentication assurance is invalid.',
    )
  }
}

function readAuthenticationMethods(value: unknown, fallback: string[]) {
  return [
    ...new Set([
      ...(Array.isArray(value)
        ? value.filter((method): method is string => typeof method === 'string')
        : []),
      ...fallback,
    ]),
  ]
}

function createEnterpriseSessionActivityDocumentClient() {
  const endpoint = process.env.DYNAMODB_ENDPOINT ??
    process.env.AWS_ENDPOINT_URL_DYNAMODB ??
    process.env.AWS_ENDPOINT_URL
  return DynamoDBDocumentClient.from(new DynamoDBClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-northeast-1',
    ...(endpoint ? { endpoint } : {}),
  }), {
    marshallOptions: { removeUndefinedValues: true },
  })
}

function isConditionalWriteError(error: unknown) {
  return error instanceof Error && (
    error.name === 'ConditionalCheckFailedException' ||
    error.name === 'TransactionCanceledException'
  )
}

function requireText(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized) {
    throw new EnterpriseSessionActivityError(
      403,
      'EnterpriseSessionDenied',
      `${label} is required.`,
    )
  }
  return normalized
}
