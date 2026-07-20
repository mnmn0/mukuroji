import { createHash, randomBytes } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  PutCommand,
} from '@aws-sdk/lib-dynamodb'
import { getConfiguredDynamoDbEndpoint } from '../audit'

/** Realtime WebSocket 接続 ticket の有効秒数です。 */
export const REALTIME_TICKET_TTL_SECONDS = 60

/** Ticket 発行時の権限 snapshot を realtime session が利用できる最大秒数です。 */
export const REALTIME_AUTHORIZATION_TTL_SECONDS = 60 * 60

/** Realtime ticket 作成入力です。 */
export type CreateRealtimeTicketInput = {
  /** Ticket を発行する canonical Workspace ID です。 */
  workspaceId: string
  /** 認証済み Workspace member key です。 */
  memberKey: string
  /** 購読対象 Work Item を所有する active team ID です。 */
  teamId: string
  /** 購読対象 Work Item ID です。 */
  issueId: string
  /** Work Item が assigned project を持つ場合の project ID です。 */
  projectId?: string
  /** Project membership を bypass できる system admin かどうかです。 */
  systemAdmin: boolean
  /** Typing 更新を送信できる書き込み権限があるかどうかです。 */
  canWrite: boolean
  /** 接続後に購読できる collaboration scope key です。 */
  scopeKey: string
  /** Cognito `auth_time` または `iat` の epoch seconds です。 */
  authenticatedAt: number
  /** Cognito access token の `exp` epoch seconds です。 */
  tokenExpiresAt: number
  /** Access token を plaintext 保存せず session-bound policy に使う SHA-256 digest です。 */
  authenticationSessionId: string
  /** Access token で確認した authentication method 一覧です。 */
  authenticationMethods: string[]
  /** Ticket 発行 request の trusted client IP です。 */
  clientIp: string
}

/** Browser に一度だけ返す Realtime ticket です。 */
export type RealtimeTicket = {
  /** WebSocket `$connect` query に渡す高 entropy ticket です。 */
  ticket: string
  /** Ticket を受け付ける production WebSocket URL です。 */
  websocketUrl: string
  /** Ticket の有効期限を表す ISO 8601 timestamp です。 */
  expiresAt: string
}

/** API handler から利用する Realtime ticket store の契約です。 */
export interface RealtimeTicketsClient {
  /** 認証済み scope 用の一回限り ticket を保存します。 */
  createTicket(input: CreateRealtimeTicketInput): Promise<RealtimeTicket>
}

/** Realtime ticket 作成時の安定した API error です。 */
export class RealtimeTicketError extends Error {
  /** HTTP response に対応する status code です。 */
  readonly status: number
  /** Client が分岐に利用できる error code です。 */
  readonly code: string

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RealtimeTicketError'
    this.status = status
    this.code = code
  }
}

/** DynamoDB に one-time Realtime ticket を保存する client です。 */
export class DynamoDbRealtimeTicketsClient implements RealtimeTicketsClient {
  /** Ticket と connection を共有する DynamoDB table 名です。 */
  private readonly tableName: string
  /** Ticket row を保存する DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Browser が接続する production WebSocket URL です。 */
  private readonly websocketUrl?: string
  /** Test から差し替え可能な clock です。 */
  private readonly clock: () => Date

  constructor(
    tableName = readEnvironment('MUKUROJI_REALTIME_SESSIONS_TABLE') ??
      readEnvironment('REALTIME_SESSIONS_TABLE_NAME') ??
      'mukuroji-realtime-sessions-local',
    documentClient = createRealtimeDocumentClient(),
    websocketUrl = readEnvironment('REALTIME_WEBSOCKET_URL'),
    clock: () => Date = () => new Date(),
  ) {
    this.tableName = requireText(tableName, 'Realtime sessions table name')
    this.documentClient = documentClient
    this.websocketUrl = websocketUrl?.trim() || undefined
    this.clock = clock
  }

  /** 認証済み scope 用の一回限り ticket を保存します。 */
  async createTicket(input: CreateRealtimeTicketInput) {
    if (!this.websocketUrl) {
      throw new RealtimeTicketError(
        503,
        'RealtimeUnavailable',
        'Realtime WebSocket is not configured; use the polling fallback.',
      )
    }

    const workspaceId = requireText(input.workspaceId, 'Realtime workspace ID')
    const memberKey = requireText(input.memberKey, 'Realtime member key')
    const teamId = requireText(input.teamId, 'Realtime team ID')
    const issueId = requireText(input.issueId, 'Realtime issue ID')
    const projectId = input.projectId === undefined
      ? undefined
      : requireText(input.projectId, 'Realtime project ID')

    if (typeof input.systemAdmin !== 'boolean') {
      throw new RealtimeTicketError(
        400,
        'InvalidRealtimeTicket',
        'Realtime system admin flag is required.',
      )
    }

    if (typeof input.canWrite !== 'boolean') {
      throw new RealtimeTicketError(
        400,
        'InvalidRealtimeTicket',
        'Realtime write capability is required.',
      )
    }

    const scopeKey = requireText(input.scopeKey, 'Realtime scope key')
    const authenticationSessionId = requireText(
      input.authenticationSessionId,
      'Realtime authentication session ID',
    )
    if (
      !Number.isSafeInteger(input.authenticatedAt) ||
      !Number.isSafeInteger(input.tokenExpiresAt) ||
      input.authenticatedAt > input.tokenExpiresAt ||
      !Array.isArray(input.authenticationMethods) ||
      input.authenticationMethods.some((method) => typeof method !== 'string') ||
      !input.clientIp.trim()
    ) {
      throw new RealtimeTicketError(
        400,
        'InvalidRealtimeTicket',
        'Realtime authentication context is invalid.',
      )
    }
    const rawTicket = randomBytes(32).toString('base64url')
    const ticketDigest = createHash('sha256').update(rawTicket).digest('hex')
    const createdAt = this.clock()
    const expiresAtEpoch = Math.floor(createdAt.getTime() / 1000) + REALTIME_TICKET_TTL_SECONDS
    const authorizationExpiresAt = Math.min(
      Math.floor(createdAt.getTime() / 1000) + REALTIME_AUTHORIZATION_TTL_SECONDS,
      input.tokenExpiresAt,
    )
    const expiresAt = new Date(expiresAtEpoch * 1000).toISOString()

    try {
      await this.documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            connectionId: `TICKET#${ticketDigest}`,
            itemType: 'ticket',
            workspaceId,
            memberKey,
            teamId,
            issueId,
            projectId,
            systemAdmin: input.systemAdmin,
            canWrite: input.canWrite,
            ticketScopeKey: scopeKey,
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAtEpoch,
            authorizationExpiresAt,
            authenticatedAt: input.authenticatedAt,
            tokenExpiresAt: input.tokenExpiresAt,
            authenticationSessionId,
            authenticationMethods: [...input.authenticationMethods],
            clientIp: input.clientIp.trim(),
          },
          ConditionExpression: 'attribute_not_exists(connectionId)',
        }),
      )
    } catch (error) {
      throw new RealtimeTicketError(
        503,
        'RealtimeTicketUnavailable',
        'Realtime ticket could not be created.',
        { cause: error },
      )
    }

    return {
      ticket: rawTicket,
      websocketUrl: this.websocketUrl,
      expiresAt,
    } satisfies RealtimeTicket
  }
}

function createRealtimeDocumentClient() {
  const endpoint = getConfiguredDynamoDbEndpoint()
  const client = new DynamoDBClient({
    region: readEnvironment('AWS_REGION') ?? readEnvironment('AWS_DEFAULT_REGION') ?? 'us-east-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: readEnvironment('AWS_ACCESS_KEY_ID') ?? 'test',
            secretAccessKey: readEnvironment('AWS_SECRET_ACCESS_KEY') ?? 'test',
          },
        }
      : {}),
  })

  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  })
}

function readEnvironment(name: string) {
  if (typeof Bun !== 'undefined') {
    return Bun.env[name]
  }

  return process.env[name]
}

function requireText(value: string, label: string) {
  const normalized = value.trim()

  if (!normalized) {
    throw new RealtimeTicketError(400, 'InvalidRealtimeTicket', `${label} is required.`)
  }

  return normalized
}
