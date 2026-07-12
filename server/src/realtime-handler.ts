import { createHash } from 'node:crypto'
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi'
import {
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'

/**
 * API Gateway WebSocket event の request context です。
 */
type WebSocketRequestContext = {
  /** 実行された WebSocket route key です。 */
  routeKey?: string
  /** API Gateway が払い出した connection ID です。 */
  connectionId?: string
  /** callback endpoint の domain name です。 */
  domainName?: string
  /** callback endpoint の stage name です。 */
  stage?: string
}

/**
 * realtime Lambda が受け取る API Gateway WebSocket event です。
 */
type WebSocketEvent = {
  /** WebSocket route と connection を識別する context です。 */
  requestContext?: WebSocketRequestContext
  /** `$connect` に渡された query parameter です。 */
  queryStringParameters?: Record<string, string | undefined> | null
  /** `$default` route が受け取った message body です。 */
  body?: string | null
  /** message body が base64 encoding されているかどうかです。 */
  isBase64Encoded?: boolean
}

/**
 * API Gateway WebSocket integration が返す response です。
 */
type WebSocketResponse = {
  /** API Gateway に返す HTTP status code です。 */
  statusCode: number
  /** 診断用の短い response body です。 */
  body?: string
}

/**
 * RealtimeSessionsTable に保存する ticket または connection row です。
 */
export type RealtimeSessionItem = {
  /** ticket row または接続済み connection row の識別 key です。 */
  connectionId: string
  /** row の用途です。 */
  itemType: 'ticket' | 'connection'
  /** canonical Workspace ID です。 */
  workspaceId: string
  /** 認証済み Workspace member key です。 */
  memberKey: string
  /** 接続 scope を所有する active team ID です。 */
  teamId: string
  /** 接続 scope の Work Item ID です。 */
  issueId: string
  /** Assigned project がある場合の active project ID です。 */
  projectId?: string
  /** Project membership を bypass できる system admin ticket かどうかです。 */
  systemAdmin: boolean
  /** Typing 更新を送信できる書き込み権限があるかどうかです。 */
  canWrite: boolean
  /** ticket が接続を許可する scope key です。 */
  ticketScopeKey?: string
  /** 接続済み client が購読する scope key です。 */
  scopeKey?: string
  /** ticket または connection の作成日時です。 */
  createdAt?: string
  /** connection の接続日時です。 */
  connectedAt?: string
  /** connection の最終 heartbeat 日時です。 */
  lastSeenAt?: string
  /** DynamoDB TTL に渡す epoch seconds です。 */
  expiresAt: number
  /** Ticket 発行時の権限 snapshot を利用できる絶対期限です。 */
  authorizationExpiresAt: number
}

/** Realtime scope の再認可に使う ProjectDirectory row です。 */
export type RealtimeAuthorizationDirectoryItem = {
  /** team、project、project-member などの row type です。 */
  entryType?: string
  /** row が属する team ID です。 */
  teamId?: string
  /** row が属する project ID です。 */
  projectId?: string
  /** project member key です。 */
  memberKey?: string
  /** project member role です。 */
  role?: string
  /** archive 済み row の timestamp です。 */
  archivedAt?: string
}

/** Realtime session の現在 scope を確認する TeamIssues row です。 */
export type RealtimeWorkItemRecord = {
  /** Workspace/team 複合 partition key です。 */
  directoryTeamId?: string
  /** Work Item ID です。 */
  issueId?: string
  /** 現在の assigned project ID です。 */
  assignedProjectId?: string
}

/**
 * `$default` route で受け付ける realtime message です。
 */
type RealtimeMessage = {
  /** 実行する realtime action です。 */
  action?: unknown
  /** typing action の入力状態です。 */
  isTyping?: unknown
  /** presence action の入力状態です。 */
  state?: unknown
}

/**
 * API Gateway Management API への送信結果です。
 */
export type RealtimePostResult = {
  /** message が接続へ配信されたかどうかです。 */
  delivered: boolean
  /** API Gateway が接続消失を返したかどうかです。 */
  gone: boolean
}

/** Realtime system-admin 再検証で読む Cognito group page です。 */
export type RealtimeCognitoGroupPage = {
  /** Page 内の Cognito group names です。 */
  groupNames: string[]
  /** 次 page の opaque token です。 */
  nextToken?: string
}

/** Cognito group page を遅延取得する reader です。 */
export type RealtimeCognitoGroupPageReader = (
  nextToken?: string,
) => Promise<RealtimeCognitoGroupPage>

const dynamoDbClient = new DynamoDBClient({ region: getAwsRegion() })
const cognitoClient = new CognitoIdentityProviderClient({ region: getAwsRegion() })
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})
const managementApiClients = new Map<string, ApiGatewayManagementApiClient>()

/**
 * 生の one-time ticket を DynamoDB key に保存できる固定長 digest へ変換します。
 */
export function hashRealtimeTicket(ticket: string) {
  return createHash('sha256').update(ticket, 'utf8').digest('hex')
}

/** Cognito の全 group pages から現在の realtime system-admin membership を判定します。 */
export async function hasCurrentRealtimeSystemAdminMembership(
  configuredGroups: string[],
  readPage: RealtimeCognitoGroupPageReader,
) {
  const allowedGroups = new Set(configuredGroups.map((group) => group.trim()).filter(Boolean))
  let nextToken: string | undefined

  if (allowedGroups.size === 0) {
    return false
  }

  do {
    const page = await readPage(nextToken)
    if (page.groupNames.some((groupName) => allowedGroups.has(groupName))) {
      return true
    }
    nextToken = page.nextToken?.trim() || undefined
  } while (nextToken)

  return false
}

/**
 * 指定 scope を購読中の有効な realtime connection を全件取得します。
 */
export async function listScopeConnections(scopeKey: string) {
  const tableName = requireEnv('REALTIME_SESSIONS_TABLE_NAME')
  const connections: RealtimeSessionItem[] = []
  let exclusiveStartKey: Record<string, unknown> | undefined

  do {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'ScopeConnectionsIndex',
        KeyConditionExpression: 'scopeKey = :scopeKey',
        ExpressionAttributeValues: { ':scopeKey': scopeKey },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )

    for (const item of response.Items ?? []) {
      const connection = toRealtimeSessionItem(item)

      if (connection?.itemType === 'connection' && connection.expiresAt > currentEpochSeconds()) {
        connections.push(connection)
      }
    }

    exclusiveStartKey = response.LastEvaluatedKey
  } while (exclusiveStartKey)

  const directoryCache = new Map<string, Promise<RealtimeAuthorizationDirectoryItem[]>>()
  const systemAdminCache = new Map<string, Promise<boolean>>()
  const authorizedConnections = await Promise.all(
    connections.map(async (connection) => {
      if (await isRealtimeSessionAuthorized(connection, directoryCache, systemAdminCache)) {
        return connection
      }

      await deleteRealtimeConnection(connection.connectionId)
      return undefined
    }),
  )

  return authorizedConnections.filter(isDefined)
}

/**
 * expired または API Gateway から消失済みの connection row を削除します。
 */
export async function deleteRealtimeConnection(connectionId: string) {
  await documentClient.send(
    new DeleteCommand({
      TableName: requireEnv('REALTIME_SESSIONS_TABLE_NAME'),
      Key: { connectionId },
    }),
  )
}

/**
 * AWS SDK の SigV4 signer を使い、API Gateway Management API へ message を送ります。
 */
export async function postRealtimeMessage(
  callbackEndpoint: string,
  connectionId: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<RealtimePostResult> {
  const endpoint = callbackEndpoint.replace(/\/+$/, '')
  const client = getManagementApiClient(endpoint)

  try {
    await client.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(JSON.stringify(payload), 'utf8'),
    }))
  } catch (error) {
    if (!isGoneConnectionError(error)) {
      throw error
    }

    await deleteRealtimeConnection(connectionId)
    return { delivered: false, gone: true }
  }

  return { delivered: true, gone: false }
}

/**
 * API Gateway WebSocket の connect、disconnect、typing/presence message を処理します。
 */
export async function handler(event: WebSocketEvent): Promise<WebSocketResponse> {
  const routeKey = event.requestContext?.routeKey
  const connectionId = event.requestContext?.connectionId

  if (!routeKey || !connectionId) {
    return response(400, 'WebSocket context is required.')
  }

  try {
    if (routeKey === '$connect') {
      return await connect(event, connectionId)
    }

    if (routeKey === '$disconnect') {
      await deleteRealtimeConnection(connectionId)
      return response(200)
    }

    if (routeKey === '$default') {
      return await handleMessage(event, connectionId)
    }

    return response(404, 'Realtime route was not found.')
  } catch (error) {
    console.error('Realtime handler failed:', error)
    return response(500, 'Realtime service is unavailable.')
  }
}

async function connect(event: WebSocketEvent, connectionId: string): Promise<WebSocketResponse> {
  const rawTicket = event.queryStringParameters?.ticket?.trim()

  if (!rawTicket || rawTicket.length < 32 || rawTicket.length > 512) {
    return response(401, 'A valid realtime ticket is required.')
  }

  const tableName = requireEnv('REALTIME_SESSIONS_TABLE_NAME')
  const ticketKey = `TICKET#${hashRealtimeTicket(rawTicket)}`
  const ticketResponse = await documentClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { connectionId: ticketKey },
      ConsistentRead: true,
    }),
  )
  const ticket = toRealtimeSessionItem(ticketResponse.Item)
  const now = new Date()
  const nowEpochSeconds = Math.floor(now.getTime() / 1_000)

  if (
    !ticket ||
    ticket.itemType !== 'ticket' ||
    !ticket.ticketScopeKey ||
    ticket.expiresAt <= nowEpochSeconds ||
    ticket.authorizationExpiresAt <= nowEpochSeconds
  ) {
    return response(401, 'Realtime ticket is invalid or expired.')
  }

  if (!await isRealtimeSessionAuthorized(ticket)) {
    await deleteRealtimeConnection(ticketKey)
    return response(401, 'Realtime ticket is no longer authorized.')
  }

  const expiresAt = capRealtimeSessionExpiry(
    nowEpochSeconds + readPositiveIntegerEnv('REALTIME_SESSION_TTL_SECONDS', 3_600),
    ticket.authorizationExpiresAt,
  )

  try {
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: tableName,
              Key: { connectionId: ticketKey },
              ConditionExpression: '#itemType = :ticket AND expiresAt > :now',
              ExpressionAttributeNames: { '#itemType': 'itemType' },
              ExpressionAttributeValues: { ':ticket': 'ticket', ':now': nowEpochSeconds },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                connectionId,
                itemType: 'connection',
                workspaceId: ticket.workspaceId,
                memberKey: ticket.memberKey,
                teamId: ticket.teamId,
                issueId: ticket.issueId,
                projectId: ticket.projectId,
                systemAdmin: ticket.systemAdmin,
                canWrite: ticket.canWrite,
                scopeKey: ticket.ticketScopeKey,
                connectedAt: now.toISOString(),
                lastSeenAt: now.toISOString(),
                expiresAt,
                authorizationExpiresAt: ticket.authorizationExpiresAt,
              } satisfies RealtimeSessionItem,
              ConditionExpression: 'attribute_not_exists(connectionId)',
            },
          },
        ],
        ClientRequestToken: createConnectTransactionToken(connectionId, ticketKey),
      }),
    )
  } catch (error) {
    if (isConditionalTransactionCancellation(error)) {
      return response(401, 'Realtime ticket was already consumed.')
    }

    throw error
  }

  return response(200)
}

async function handleMessage(event: WebSocketEvent, connectionId: string): Promise<WebSocketResponse> {
  const session = await getActiveConnection(connectionId)

  if (!session) {
    return response(401, 'Realtime connection is invalid or expired.')
  }

  const message = parseMessageBody(event)

  if (message.action === 'ping') {
    await refreshConnection(session)
    return response(200)
  }

  if (message.action !== 'typing' && message.action !== 'presence') {
    return response(400, 'Realtime action is invalid.')
  }

  if (message.action === 'typing' && !isRealtimeTypingAllowed(session.canWrite, message.isTyping)) {
    return response(403, 'Typing requires write access.')
  }

  if (!session.scopeKey) {
    return response(409, 'Realtime connection has no active scope.')
  }

  const callbackEndpoint = getCallbackEndpoint(event)
  const connections = await listScopeConnections(session.scopeKey)
  const occurredAt = new Date().toISOString()
  const payload = message.action === 'typing'
    ? {
        type: 'typing',
        scopeKey: session.scopeKey,
        memberKey: session.memberKey,
        isTyping: message.isTyping === true,
        occurredAt,
      }
    : {
        type: 'presence',
        scopeKey: session.scopeKey,
        memberKey: session.memberKey,
        state: message.state === 'idle' ? 'idle' : 'active',
        occurredAt,
      }

  await Promise.all(
    connections
      .filter((connection) => connection.connectionId !== connectionId)
      .map((connection) => postRealtimeMessage(callbackEndpoint, connection.connectionId, payload)),
  )
  await refreshConnection(session)

  return response(200)
}

async function getActiveConnection(connectionId: string) {
  const result = await documentClient.send(
    new GetCommand({
      TableName: requireEnv('REALTIME_SESSIONS_TABLE_NAME'),
      Key: { connectionId },
      ConsistentRead: true,
    }),
  )
  const connection = toRealtimeSessionItem(result.Item)

  if (
    connection?.itemType !== 'connection' ||
    !connection.scopeKey ||
    connection.expiresAt <= currentEpochSeconds()
  ) {
    if (connection) {
      await deleteRealtimeConnection(connectionId)
    }

    return undefined
  }

  if (!await isRealtimeSessionAuthorized(connection)) {
    await deleteRealtimeConnection(connectionId)
    return undefined
  }

  return connection
}

async function refreshConnection(connection: RealtimeSessionItem) {
  const now = new Date()

  await documentClient.send(
    new UpdateCommand({
      TableName: requireEnv('REALTIME_SESSIONS_TABLE_NAME'),
      Key: { connectionId: connection.connectionId },
      UpdateExpression: 'SET lastSeenAt = :lastSeenAt, expiresAt = :expiresAt',
      ConditionExpression: '#itemType = :connection',
      ExpressionAttributeNames: { '#itemType': 'itemType' },
      ExpressionAttributeValues: {
        ':connection': 'connection',
        ':lastSeenAt': now.toISOString(),
        ':expiresAt': capRealtimeSessionExpiry(
          Math.floor(now.getTime() / 1_000) + readPositiveIntegerEnv(
            'REALTIME_SESSION_TTL_SECONDS',
            3_600,
          ),
          connection.authorizationExpiresAt,
        ),
      },
    }),
  )
}

/** Viewer は typing 開始を送信できず、終了通知だけを送信できるかを判定します。 */
export function isRealtimeTypingAllowed(canWrite: boolean, isTyping: unknown) {
  return isTyping !== true || canWrite
}

/** Refresh 後の TTL を ticket 発行時の絶対 authorization 期限以内に収めます。 */
export function capRealtimeSessionExpiry(
  candidateExpiresAt: number,
  authorizationExpiresAt: number,
) {
  return Math.min(candidateExpiresAt, authorizationExpiresAt)
}

function parseMessageBody(event: WebSocketEvent): RealtimeMessage {
  if (!event.body) {
    return {}
  }

  const decoded = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body

  if (Buffer.byteLength(decoded, 'utf8') > 16_384) {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(decoded)
    return parsed && typeof parsed === 'object' ? parsed as RealtimeMessage : {}
  } catch {
    return {}
  }
}

function getCallbackEndpoint(event: WebSocketEvent) {
  const configured = process.env.WEBSOCKET_CALLBACK_ENDPOINT?.trim()

  if (configured) {
    return configured
  }

  const domainName = event.requestContext?.domainName
  const stage = event.requestContext?.stage

  if (!domainName || !stage) {
    throw new Error('WebSocket callback endpoint is not configured.')
  }

  return `https://${domainName}/${stage}`
}

function toRealtimeSessionItem(value: unknown): RealtimeSessionItem | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const item = value as Record<string, unknown>

  if (
    typeof item.connectionId !== 'string' ||
    (item.itemType !== 'ticket' && item.itemType !== 'connection') ||
    typeof item.workspaceId !== 'string' ||
    typeof item.memberKey !== 'string' ||
    typeof item.teamId !== 'string' ||
    typeof item.issueId !== 'string' ||
    typeof item.systemAdmin !== 'boolean' ||
    typeof item.canWrite !== 'boolean' ||
    typeof item.expiresAt !== 'number' ||
    typeof item.authorizationExpiresAt !== 'number'
  ) {
    return undefined
  }

  return {
    connectionId: item.connectionId,
    itemType: item.itemType,
    workspaceId: item.workspaceId,
    memberKey: item.memberKey,
    teamId: item.teamId,
    issueId: item.issueId,
    systemAdmin: item.systemAdmin,
    canWrite: item.canWrite,
    expiresAt: item.expiresAt,
    authorizationExpiresAt: item.authorizationExpiresAt,
    ...(typeof item.projectId === 'string' ? { projectId: item.projectId } : {}),
    ...(typeof item.ticketScopeKey === 'string' ? { ticketScopeKey: item.ticketScopeKey } : {}),
    ...(typeof item.scopeKey === 'string' ? { scopeKey: item.scopeKey } : {}),
    ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}),
    ...(typeof item.connectedAt === 'string' ? { connectedAt: item.connectedAt } : {}),
    ...(typeof item.lastSeenAt === 'string' ? { lastSeenAt: item.lastSeenAt } : {}),
  }
}

/**
 * Session metadata と現在の ProjectDirectory snapshot から realtime scope の権限を判定します。
 */
export function hasRealtimeDirectoryAccess(
  session: Pick<RealtimeSessionItem, 'memberKey' | 'projectId' | 'systemAdmin' | 'teamId'>,
  items: RealtimeAuthorizationDirectoryItem[],
) {
  const activeTeam = items.some((item) =>
    item.entryType === 'team' && item.teamId === session.teamId && !item.archivedAt
  )

  if (!activeTeam) {
    return false
  }

  const activeProjects = items.filter((item) =>
    item.entryType === 'project' &&
    item.teamId === session.teamId &&
    typeof item.projectId === 'string' &&
    !item.archivedAt
  )

  if (session.projectId) {
    if (!activeProjects.some((item) => item.projectId === session.projectId)) {
      return false
    }

    return session.systemAdmin || hasViewerProjectRole(items, session.projectId, session.memberKey)
  }

  if (session.systemAdmin) {
    return true
  }

  return activeProjects.some((project) =>
    project.projectId !== undefined &&
    hasViewerProjectRole(items, project.projectId, session.memberKey)
  )
}

/** 現在の Workspace/project role から typing に必要な書き込み権限を判定します。 */
export function hasRealtimeDirectoryWriteAccess(
  session: Pick<RealtimeSessionItem, 'memberKey' | 'projectId' | 'systemAdmin' | 'teamId'>,
  items: RealtimeAuthorizationDirectoryItem[],
  workspaceRole: unknown,
) {
  if (workspaceRole === 'guest') {
    return false
  }
  if (session.systemAdmin) {
    return true
  }

  const activeProjectIds = new Set(items.filter((item) =>
    item.entryType === 'project' &&
    item.teamId === session.teamId &&
    typeof item.projectId === 'string' &&
    !item.archivedAt
  ).map((item) => item.projectId as string))
  const writableProjectIds = new Set(items.filter((item) =>
    item.entryType === 'project-member' &&
    normalizeMemberKey(item.memberKey ?? '') === normalizeMemberKey(session.memberKey) &&
    (item.role === 'member' || item.role === 'manager') &&
    typeof item.projectId === 'string' &&
    activeProjectIds.has(item.projectId)
  ).map((item) => item.projectId as string))

  return session.projectId
    ? writableProjectIds.has(session.projectId)
    : writableProjectIds.size > 0
}

/** Session 発行後も Work Item が同じ team/project scope にあるかを判定します。 */
export function hasCurrentRealtimeWorkItemScope(
  session: Pick<RealtimeSessionItem, 'issueId' | 'projectId' | 'teamId' | 'workspaceId'>,
  item: RealtimeWorkItemRecord | undefined,
) {
  if (!item ||
    item.directoryTeamId !== `${session.workspaceId}#team#${session.teamId}` ||
    item.issueId !== session.issueId) {
    return false
  }

  return item.assignedProjectId === session.projectId
}

async function isRealtimeSessionAuthorized(
  session: RealtimeSessionItem,
  directoryCache = new Map<string, Promise<RealtimeAuthorizationDirectoryItem[]>>(),
  systemAdminCache = new Map<string, Promise<boolean>>(),
) {
  const memberKey = normalizeMemberKey(session.memberKey)
  const memberResult = await documentClient.send(new GetCommand({
    TableName: requireEnv('WORKSPACE_ACCESS_TABLE_NAME'),
    Key: {
      workspaceId: session.workspaceId,
      recordKey: `MEMBER#${memberKey}`,
    },
    ConsistentRead: true,
  }))
  const member = memberResult.Item

  if (
    !member ||
    member.entryType !== 'workspace-member' ||
    member.status !== 'active' ||
    normalizeMemberKey(String(member.memberKey ?? member.email ?? '')) !== memberKey
  ) {
    return false
  }

  if (session.systemAdmin) {
    const username = readOptionalString(member.username) ?? readOptionalString(member.email) ?? memberKey
    let currentSystemAdmin = systemAdminCache.get(username)
    if (!currentSystemAdmin) {
      currentSystemAdmin = readCurrentRealtimeSystemAdmin(username)
      systemAdminCache.set(username, currentSystemAdmin)
    }
    if (!await currentSystemAdmin) {
      return false
    }
  }

  const workItemResult = await documentClient.send(new GetCommand({
    TableName: requireEnv('TEAM_ISSUES_TABLE_NAME'),
    Key: {
      directoryTeamId: `${session.workspaceId}#team#${session.teamId}`,
      issueId: session.issueId,
    },
    ConsistentRead: true,
  }))

  if (!hasCurrentRealtimeWorkItemScope(session, workItemResult.Item)) {
    return false
  }

  let directoryPromise = directoryCache.get(session.workspaceId)

  if (!directoryPromise) {
    directoryPromise = readRealtimeDirectory(session.workspaceId)
    directoryCache.set(session.workspaceId, directoryPromise)
  }

  const directoryItems = await directoryPromise
  if (!hasRealtimeDirectoryAccess(session, directoryItems)) {
    return false
  }

  session.canWrite = hasRealtimeDirectoryWriteAccess(session, directoryItems, member.role)
  return true
}

async function readCurrentRealtimeSystemAdmin(username: string) {
  try {
    return await hasCurrentRealtimeSystemAdminMembership(
      requireEnv('SYSTEM_ADMIN_GROUPS').split(','),
      async (nextToken) => {
        const response = await cognitoClient.send(new AdminListGroupsForUserCommand({
          UserPoolId: requireEnv('COGNITO_USER_POOL_ID'),
          Username: username,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }))
        return {
          groupNames: (response.Groups ?? [])
            .map((group) => group.GroupName)
            .filter((groupName): groupName is string => typeof groupName === 'string'),
          ...(response.NextToken ? { nextToken: response.NextToken } : {}),
        }
      },
    )
  } catch (error) {
    if (isAwsNamedError(error, 'UserNotFoundException')) {
      return false
    }
    throw error
  }
}

async function readRealtimeDirectory(workspaceId: string) {
  const items: RealtimeAuthorizationDirectoryItem[] = []
  let exclusiveStartKey: Record<string, unknown> | undefined

  do {
    const result = await documentClient.send(new QueryCommand({
      TableName: requireEnv('PROJECT_DIRECTORY_TABLE_NAME'),
      KeyConditionExpression: 'directoryId = :directoryId',
      ExpressionAttributeValues: { ':directoryId': workspaceId },
      ConsistentRead: true,
      ExclusiveStartKey: exclusiveStartKey,
    }))

    for (const item of result.Items ?? []) {
      items.push({
        ...(typeof item.entryType === 'string' ? { entryType: item.entryType } : {}),
        ...(typeof item.teamId === 'string' ? { teamId: item.teamId } : {}),
        ...(typeof item.projectId === 'string' ? { projectId: item.projectId } : {}),
        ...(typeof item.memberKey === 'string' ? { memberKey: item.memberKey } : {}),
        ...(typeof item.role === 'string' ? { role: item.role } : {}),
        ...(typeof item.archivedAt === 'string' ? { archivedAt: item.archivedAt } : {}),
      })
    }

    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey)

  return items
}

function hasViewerProjectRole(
  items: RealtimeAuthorizationDirectoryItem[],
  projectId: string,
  memberKey: string,
) {
  const normalizedMemberKey = normalizeMemberKey(memberKey)

  return items.some((item) =>
    item.entryType === 'project-member' &&
    item.projectId === projectId &&
    normalizeMemberKey(item.memberKey ?? '') === normalizedMemberKey &&
    (item.role === 'viewer' || item.role === 'member' || item.role === 'manager')
  )
}

function getManagementApiClient(endpoint: string) {
  const existing = managementApiClients.get(endpoint)

  if (existing) {
    return existing
  }

  const client = new ApiGatewayManagementApiClient({
    endpoint,
    region: getAwsRegion(),
  })
  managementApiClients.set(endpoint, client)
  return client
}

function createConnectTransactionToken(connectionId: string, ticketKey: string) {
  return createHash('sha256')
    .update(`realtime-connect-v1\0${connectionId}\0${ticketKey}`, 'utf8')
    .digest('hex')
    .slice(0, 36)
}

function isGoneConnectionError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false
  }

  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return candidate.name === 'GoneException' || candidate.$metadata?.httpStatusCode === 410
}

function normalizeMemberKey(value: string) {
  return value.trim().toLowerCase()
}

function readOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1_000)
}

function getAwsRegion() {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1'
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`${name} is required.`)
  }

  return value
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function response(statusCode: number, body?: string): WebSocketResponse {
  return {
    statusCode,
    ...(body ? { body } : {}),
  }
}

function isAwsNamedError(error: unknown, name: string) {
  return error instanceof Error && error.name === name
}

function isConditionalTransactionCancellation(error: unknown) {
  if (!isAwsNamedError(error, 'TransactionCanceledException') || !error || typeof error !== 'object') {
    return false
  }

  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons
  return Array.isArray(reasons) && reasons.some((reason) => reason.Code === 'ConditionalCheckFailed')
}
