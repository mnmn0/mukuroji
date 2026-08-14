import { createHash } from 'node:crypto'
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi'
import {
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  DescribeIdentityProviderCommand,
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
import type {
  EnterpriseIdentitySnapshot,
  EnterprisePermissionId,
  EnterpriseSecurityPolicy,
} from '@mukuroji/contracts'
import {
  isCanonicalWorkItemRecord,
  type CanonicalWorkItemRecord,
} from '../../../work-items'
import {
  DynamoDbEnterpriseIdentityReadClient,
  assertEnterpriseCognitoFederationBinding,
  assertEnterpriseIdentityProviderReady,
  evaluateEnterpriseAccess,
  resolveEnterpriseDirectoryPrincipal,
  validateEnterpriseSession,
  type EnterpriseCognitoFederationBinding,
  type EnterpriseIdentityReadClient,
  type EnterprisePrincipalContext,
} from '../../../enterprise-identity'
import { createEnterpriseCognitoInspectionCache } from '../../../enterprise-identity'
import { createEnterpriseSsoAuthenticationMethod } from '../../../enterprise-identity'

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
  /** API Gateway が検証済み transport source として渡す接続情報です。 */
  identity?: {
    /** WebSocket client の source IP です。 */
    sourceIp?: string
  }
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
  /** Cognito session が認証を完了した epoch seconds です。 */
  authenticatedAt: number
  /** Cognito access token が失効する epoch seconds です。 */
  tokenExpiresAt: number
  /** Access token を plaintext 保存せず session-bound elevation に使う SHA-256 digest です。 */
  authenticationSessionId: string
  /** Ticket 発行時に検証した authentication method 一覧です。 */
  authenticationMethods: string[]
  /** Current IP allowlist を評価する trusted client IP です。 */
  clientIp: string
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
export type RealtimeWorkItemRecord = CanonicalWorkItemRecord

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

/** Cognito federation provider の実設定を遅延取得する reader です。 */
export type RealtimeCognitoProviderBindingReader = (
  providerName: string,
) => Promise<EnterpriseCognitoFederationBinding>

/**
 * Realtime authorization 用 Cognito provider reader に短期 raw-binding cache を追加します。
 *
 * @remarks
 * Cache hit 後も caller が current enterprise provider に対する binding validation を実行します。
 */
export function createCachedRealtimeCognitoProviderBindingReader(
  readBinding: RealtimeCognitoProviderBindingReader,
  now: () => number = Date.now,
): RealtimeCognitoProviderBindingReader {
  const cache = createEnterpriseCognitoInspectionCache<EnterpriseCognitoFederationBinding>({
    now,
  })
  return (providerName) => cache.read(
    providerName,
    () => readBinding(providerName),
  )
}

/**
 * Enterprise evaluator が認識する Workspace member role です。
 */
export type RealtimeWorkspaceRole = 'owner' | 'admin' | 'member' | 'guest'

/**
 * Realtime read/write を current enterprise state で評価する入力です。
 */
export type EvaluateRealtimeEnterpriseAccessInput = {
  /** Current enterprise identity/security snapshot です。 */
  snapshot: EnterpriseIdentitySnapshot
  /** Realtime session の member key です。 */
  memberKey: string
  /** Current Workspace access row の email です。 */
  memberEmail: string
  /** Current Workspace access row の role です。 */
  workspaceRole: RealtimeWorkspaceRole
  /** Cognito から強整合に近い形で再取得した current group names です。 */
  cognitoGroupIds: string[]
  /** Ticket 上の system-admin flag が current Cognito groups でも確認済みかどうかです。 */
  currentSystemAdministrator: boolean
  /** Current break-glass activation が存在するかどうかです。 */
  breakGlass: boolean
  /** Authoritative enterprise grant がない場合に使う legacy project read ACL です。 */
  legacyReadAllowed: boolean
  /** Authoritative enterprise grant がない場合に使う legacy project write ACL です。 */
  legacyWriteAllowed: boolean
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Assigned Project がある場合の Project ID です。 */
  projectId?: string
  /** Team ID uniquely resolved from the current Project Directory for a legacy Project scope. */
  projectScopeOwnerTeamId?: string
}

/**
 * Current enterprise state を反映した realtime authorization result です。
 */
export type RealtimeEnterpriseAccess = {
  /** Realtime scope の購読を継続できるかどうかです。 */
  allowed: boolean
  /** Typing event を送信できるかどうかです。 */
  canWrite: boolean
  /** Current Cognito token から取得した directory group IDs です。 */
  directoryGroupIds: string[]
  /** Guest または verified domain 外の principal かどうかです。 */
  external: boolean
  /** Workspace scope の authoritative mapping により legacy role を抑制したかどうかです。 */
  workspaceRoleSuppressed: boolean
}

const dynamoDbClient = new DynamoDBClient({ region: getAwsRegion() })
const cognitoClient = new CognitoIdentityProviderClient({ region: getAwsRegion() })
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})
const managementApiClients = new Map<string, ApiGatewayManagementApiClient>()
let enterpriseIdentityClient: EnterpriseIdentityReadClient | undefined
const defaultExternalPermissionCeiling = [
  'workspace.read',
  'members.read',
  'teams.read',
  'projects.read',
  'work-items.read',
  'files.read',
  'planning.read',
] satisfies EnterprisePermissionId[]

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
 * Realtime principal が依存する provider と Cognito の実 provider が一致するか返します。
 */
export async function hasValidRealtimeCognitoProviderBindings(
  snapshot: EnterpriseIdentitySnapshot,
  memberKey: string,
  memberEmail: string,
  configuredProviderName: string,
  readBinding: RealtimeCognitoProviderBindingReader,
) {
  const normalizedMemberKey = normalizeMemberKey(memberKey)
  const providerIds = new Set(
    snapshot.scimUsers
      .filter((user) =>
        user.active &&
        user.appliedVersion >= user.version &&
        normalizeMemberKey(user.linkedMemberKey ?? '') === normalizedMemberKey
      )
      .map((user) => user.identityProviderId),
  )
  const memberDomain = normalizeEmailDomain(memberEmail)
  for (const domain of snapshot.domains) {
    if (
      domain.status !== 'verified' ||
      !domain.enforceSso ||
      domain.domain.trim().toLowerCase() !== memberDomain
    ) continue
    if (!domain.identityProviderId) return false
    providerIds.add(domain.identityProviderId)
  }
  if (providerIds.size === 0) return true

  try {
    for (const providerId of providerIds) {
      const provider = snapshot.identityProviders.find((candidate) =>
        candidate.providerId === providerId
      )
      assertEnterpriseIdentityProviderReady(provider)
      assertEnterpriseCognitoFederationBinding(
        provider,
        configuredProviderName,
        await readBinding(provider.cognitoProviderName),
      )
    }
    return true
  } catch {
    return false
  }
}

/**
 * Current verified/enforced domain が要求する provider revision marker を ticket が持つか返します。
 */
export function hasCurrentRealtimeEnterpriseSsoAssurance(
  snapshot: EnterpriseIdentitySnapshot,
  memberEmail: string,
  authenticationMethods: readonly string[],
) {
  const memberDomain = normalizeEmailDomain(memberEmail)
  const methods = new Set(authenticationMethods)

  return snapshot.domains
    .filter((domain) =>
      domain.status === 'verified' &&
      domain.enforceSso &&
      domain.domain.trim().toLowerCase() === memberDomain
    )
    .every((domain) => {
      if (!domain.identityProviderId) return false
      const provider = snapshot.identityProviders.find((candidate) =>
        candidate.providerId === domain.identityProviderId
      )
      if (!provider) return false
      try {
        return methods.has(createEnterpriseSsoAuthenticationMethod(
          provider.providerId,
          provider.revision,
        ))
      } catch {
        return false
      }
    })
}

/**
 * Current SCIM/Cognito groups、custom roles、authoritative mappings、external ceiling を統合し、
 * authoritative enterprise authorization または legacy project ACL のどちらかを選択します。
 */
export function evaluateRealtimeEnterpriseAccess(
  input: EvaluateRealtimeEnterpriseAccessInput,
): RealtimeEnterpriseAccess {
  const memberKey = normalizeMemberKey(input.memberKey)
  const memberDomain = normalizeEmailDomain(input.memberEmail)
  const directoryPrincipal = resolveEnterpriseDirectoryPrincipal(
    input.snapshot,
    memberKey,
    input.cognitoGroupIds,
  )
  const {
    compatibleGroupMappings,
    compatibleRoleAssignments,
    directoryGroupIds,
    directoryGroupMemberships,
  } = directoryPrincipal
  const verifiedDomains = input.snapshot.domains.filter((domain) =>
    domain.status === 'verified'
  )
  const managedDomain = verifiedDomains.length === 0 || verifiedDomains.some((domain) =>
    domain.domain.trim().toLowerCase() === memberDomain
  )
  const external = input.workspaceRole === 'guest' || !managedDomain
  const recoveryAccount = input.snapshot.breakGlassAccounts.some((account) =>
    account.status === 'active' &&
    normalizeMemberKey(account.linkedMemberKey) === memberKey
  )
  const externalPolicy = input.snapshot.policy?.externalAccess
  const guestDenied = input.workspaceRole === 'guest' && externalPolicy !== undefined &&
    (
      !externalPolicy.allowGuests ||
      externalPolicy.allowedGuestDomains.length > 0 &&
        !externalPolicy.allowedGuestDomains.some((domain) =>
          domain.trim().toLowerCase() === memberDomain
        )
    )
  const collaboratorDenied =
    input.workspaceRole !== 'guest' &&
    !managedDomain &&
    externalPolicy?.allowExternalCollaborators === false &&
    !recoveryAccount
  const workspaceRoleSuppressed = directoryPrincipal.directoryManaged ||
    compatibleRoleAssignments.some((assignment) =>
      assignment.principalKind === 'member' &&
        normalizeMemberKey(assignment.principalId) === memberKey ||
      assignment.principalKind === 'directory-group' &&
      (
        assignment.source === 'directory-mapping' ||
        directoryGroupIds.includes(assignment.principalId)
      )
    ) || compatibleGroupMappings.some((mapping) => mapping.enabled)
  const permissionCeiling = external && !input.breakGlass
    ? input.snapshot.policy?.externalAccess.permissionCeiling ??
      defaultExternalPermissionCeiling
    : undefined
  const principal = {
    kind: input.breakGlass ? 'break-glass' : 'member',
    principalId: memberKey,
    directoryGroupIds,
    directoryGroupMemberships,
    workspaceRole: input.workspaceRole,
    includeWorkspaceRolePermissions: !workspaceRoleSuppressed,
    systemAdministrator: input.currentSystemAdministrator,
    ...(permissionCeiling ? { permissionCeiling } : {}),
  } satisfies EnterprisePrincipalContext
  const resource = input.projectId
    ? {
        workspaceId: input.snapshot.workspaceId,
        kind: 'project' as const,
        targetId: input.projectId,
        parentTeamId: input.teamId,
      }
    : {
        workspaceId: input.snapshot.workspaceId,
        kind: 'team' as const,
        targetId: input.teamId,
      }
  const readAccess = evaluateEnterpriseAccess({
    permission: 'work-items.read',
    principal,
    assignments: compatibleRoleAssignments,
    customRoles: input.snapshot.customRoles,
    groupMappings: compatibleGroupMappings,
    resource,
    ...(input.projectScopeOwnerTeamId !== undefined
      ? { projectScopeOwnerTeamId: input.projectScopeOwnerTeamId }
      : {}),
  })
  const writeAccess = evaluateEnterpriseAccess({
    permission: 'work-items.write',
    principal,
    assignments: compatibleRoleAssignments,
    customRoles: input.snapshot.customRoles,
    groupMappings: compatibleGroupMappings,
    resource,
    ...(input.projectScopeOwnerTeamId !== undefined
      ? { projectScopeOwnerTeamId: input.projectScopeOwnerTeamId }
      : {}),
  })
  const enterpriseBoundaryDenied =
    guestDenied || collaboratorDenied || directoryPrincipal.deprovisioned
  const enterpriseAuthorizationAuthoritative = workspaceRoleSuppressed ||
    input.currentSystemAdministrator || input.breakGlass
  const ceilingAllowsRead = permissionCeiling === undefined ||
    permissionCeiling.includes('work-items.read')
  const ceilingAllowsWrite = permissionCeiling === undefined ||
    permissionCeiling.includes('work-items.write')
  const allowed =
    !enterpriseBoundaryDenied &&
    ceilingAllowsRead &&
    (
      enterpriseAuthorizationAuthoritative
        ? readAccess.allowed
        : input.legacyReadAllowed
    )

  return {
    allowed,
    canWrite:
      allowed &&
      ceilingAllowsWrite &&
      (
        enterpriseAuthorizationAuthoritative
          ? writeAccess.allowed
          : input.legacyWriteAllowed
      ),
    directoryGroupIds,
    external,
    workspaceRoleSuppressed,
  }
}

/**
 * Current policy の absolute/idle/re-authentication deadline を realtime session age に適用します。
 *
 * @remarks
 * Ticket 発行側は access-token expiry と authentication age でも
 * `authorizationExpiresAt` を短くする必要があります。この check は policy reduction 後に
 * 既存 connection が古い deadline を使い続けることを防ぐ defense-in-depth です。
 */
export function isRealtimeEnterpriseSessionFresh(
  policy: EnterpriseSecurityPolicy | undefined,
  session: Pick<
    RealtimeSessionItem,
    | 'authenticationMethods'
    | 'authenticatedAt'
    | 'authorizationExpiresAt'
    | 'clientIp'
    | 'connectedAt'
    | 'createdAt'
    | 'lastSeenAt'
    | 'tokenExpiresAt'
  >,
  external: boolean,
  privileged: boolean,
  breakGlass: boolean,
  nowEpochSeconds = currentEpochSeconds(),
) {
  if (
    session.authorizationExpiresAt <= nowEpochSeconds ||
    session.tokenExpiresAt <= nowEpochSeconds
  ) return false
  if (!policy) return true
  const createdAt = parseRealtimeTimestamp(session.createdAt ?? session.connectedAt)
  const lastSeenAt = parseRealtimeTimestamp(
    session.lastSeenAt ?? session.connectedAt ?? session.createdAt,
  )
  if (
    createdAt === undefined ||
    lastSeenAt === undefined ||
    createdAt > nowEpochSeconds ||
    lastSeenAt > nowEpochSeconds
  ) {
    return false
  }
  const absoluteLifetimeMinutes = external
    ? Math.min(
        policy.sessionLifetimeMinutes,
        policy.externalAccess.maximumSessionLifetimeMinutes,
      )
    : policy.sessionLifetimeMinutes
  const sessionValidation = validateEnterpriseSession(policy, {
    authenticatedAt: session.authenticatedAt,
    now: nowEpochSeconds,
    authenticationMethods: session.authenticationMethods,
    clientIp: session.clientIp,
    privileged,
    external,
    breakGlass,
  })
  if (!sessionValidation.valid) return false
  const reauthenticationMinutes = privileged
    ? policy.sensitiveActionReauthenticationMinutes
    : policy.reauthenticationIntervalMinutes
  const maximumConnectionAgeSeconds = Math.min(
    absoluteLifetimeMinutes,
    reauthenticationMinutes,
  ) * 60
  const maximumIdleAgeSeconds = policy.idleTimeoutMinutes * 60
  return (
    nowEpochSeconds - createdAt <= maximumConnectionAgeSeconds &&
    nowEpochSeconds - lastSeenAt <= maximumIdleAgeSeconds
  )
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
  const cognitoGroupCache = new Map<string, Promise<string[]>>()
  const enterpriseSnapshotCache = new Map<string, Promise<EnterpriseIdentitySnapshot>>()
  const breakGlassCache = new Map<string, Promise<boolean>>()
  const authorizedConnections = await Promise.all(
    connections.map(async (connection) => {
      if (await isRealtimeSessionAuthorized(
        connection,
        directoryCache,
        cognitoGroupCache,
        enterpriseSnapshotCache,
        breakGlassCache,
      )) {
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
                createdAt: ticket.createdAt ?? now.toISOString(),
                connectedAt: now.toISOString(),
                lastSeenAt: now.toISOString(),
                expiresAt,
                authorizationExpiresAt: ticket.authorizationExpiresAt,
                authenticatedAt: ticket.authenticatedAt,
                tokenExpiresAt: ticket.tokenExpiresAt,
                authenticationSessionId: ticket.authenticationSessionId,
                authenticationMethods: ticket.authenticationMethods,
                clientIp:
                  event.requestContext?.identity?.sourceIp?.trim() || ticket.clientIp,
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
    typeof item.authorizationExpiresAt !== 'number' ||
    typeof item.authenticatedAt !== 'number' ||
    typeof item.tokenExpiresAt !== 'number' ||
    typeof item.authenticationSessionId !== 'string' ||
    !item.authenticationSessionId ||
    !Array.isArray(item.authenticationMethods) ||
    item.authenticationMethods.some((method) => typeof method !== 'string') ||
    typeof item.clientIp !== 'string'
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
    authenticatedAt: item.authenticatedAt,
    tokenExpiresAt: item.tokenExpiresAt,
    authenticationSessionId: item.authenticationSessionId,
    authenticationMethods: item.authenticationMethods as string[],
    clientIp: item.clientIp,
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
  return hasActiveRealtimeResourceScope(session, items) &&
    hasRealtimeLegacyDirectoryAccess(session, items)
}

/** Realtime session が参照する Team/Project が archive されず存在するかを判定します。 */
export function hasActiveRealtimeResourceScope(
  session: Pick<RealtimeSessionItem, 'projectId' | 'teamId'>,
  items: RealtimeAuthorizationDirectoryItem[],
) {
  const activeTeam = items.some((item) =>
    item.entryType === 'team' && item.teamId === session.teamId && !item.archivedAt
  )

  if (!activeTeam) {
    return false
  }

  if (!session.projectId) {
    return true
  }

  return items.some((item) =>
    item.entryType === 'project' &&
    item.teamId === session.teamId &&
    item.projectId === session.projectId &&
    !item.archivedAt
  )
}

/**
 * Resolves a Project's owner Team only when the active directory contains one owner.
 *
 * @param session - Realtime session scope containing the Project identifier.
 * @param items - Current Project Directory rows.
 * @returns The unique owner Team ID, or undefined for an absent or ambiguous Project.
 */
function readUniqueRealtimeProjectOwnerTeamId(
  session: Pick<RealtimeSessionItem, 'projectId'>,
  items: RealtimeAuthorizationDirectoryItem[],
) {
  if (session.projectId === undefined) return undefined
  const ownerTeamIds = new Set(
    items
      .filter((item) =>
        item.entryType === 'project' &&
        item.projectId === session.projectId &&
        typeof item.teamId === 'string' &&
        !item.archivedAt
      )
      .flatMap((item) => typeof item.teamId === 'string' ? [item.teamId] : []),
  )
  return ownerTeamIds.size === 1 ? [...ownerTeamIds][0] : undefined
}

/** Authoritative enterprise grant がない principal の legacy Project ACL を判定します。 */
export function hasRealtimeLegacyDirectoryAccess(
  session: Pick<RealtimeSessionItem, 'memberKey' | 'projectId' | 'systemAdmin' | 'teamId'>,
  items: RealtimeAuthorizationDirectoryItem[],
) {
  if (session.systemAdmin) {
    return true
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

    return hasViewerProjectRole(items, session.projectId, session.memberKey)
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
  item: unknown,
) {
  if (!isCanonicalWorkItemRecord(item) ||
    item.directoryTeamId !== `${session.workspaceId}#team#${session.teamId}` ||
    item.issueId !== session.issueId) {
    return false
  }

  return item.assignedProjectId === session.projectId
}

async function isRealtimeSessionAuthorized(
  session: RealtimeSessionItem,
  directoryCache = new Map<string, Promise<RealtimeAuthorizationDirectoryItem[]>>(),
  cognitoGroupCache = new Map<string, Promise<string[]>>(),
  enterpriseSnapshotCache = new Map<string, Promise<EnterpriseIdentitySnapshot>>(),
  breakGlassCache = new Map<string, Promise<boolean>>(),
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

  const memberEmail = readOptionalString(member.email) ?? memberKey
  const username = readOptionalString(member.username) ?? memberEmail
  let cognitoGroupsPromise = cognitoGroupCache.get(username)
  if (!cognitoGroupsPromise) {
    cognitoGroupsPromise = readCurrentRealtimeCognitoGroups(username)
    cognitoGroupCache.set(username, cognitoGroupsPromise)
  }
  const cognitoGroupIds = await cognitoGroupsPromise
  const currentSystemAdministrator = session.systemAdmin &&
    hasConfiguredRealtimeSystemAdminGroup(cognitoGroupIds)
  if (session.systemAdmin && !currentSystemAdministrator) {
    return false
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
  if (!hasActiveRealtimeResourceScope(session, directoryItems)) {
    return false
  }
  const legacyReadAllowed = hasRealtimeLegacyDirectoryAccess(session, directoryItems)
  const projectScopeOwnerTeamId = readUniqueRealtimeProjectOwnerTeamId(
    session,
    directoryItems,
  )

  let snapshotPromise = enterpriseSnapshotCache.get(session.workspaceId)
  if (!snapshotPromise) {
    snapshotPromise = getEnterpriseIdentityClient().getSnapshot(session.workspaceId)
    enterpriseSnapshotCache.set(session.workspaceId, snapshotPromise)
  }
  const snapshot = await snapshotPromise
  const breakGlassKey =
    `${session.workspaceId}\0${memberKey}\0${session.authenticationSessionId}`
  let breakGlassPromise = breakGlassCache.get(breakGlassKey)
  if (!breakGlassPromise) {
    const registeredRecoveryAccount = snapshot.breakGlassAccounts.some((account) =>
      account.status === 'active' &&
      normalizeMemberKey(account.linkedMemberKey) === memberKey
    )
    breakGlassPromise = registeredRecoveryAccount
      ? getEnterpriseIdentityClient()
        .getActiveBreakGlassActivation(
          session.workspaceId,
          memberKey,
          session.authenticationSessionId,
        )
        .then((activation) => activation !== undefined)
      : Promise.resolve(false)
    breakGlassCache.set(breakGlassKey, breakGlassPromise)
  }
  const workspaceRole = readRealtimeWorkspaceRole(member.role)
  if (!workspaceRole) return false
  const breakGlass = await breakGlassPromise
  if (!breakGlass) {
    if (!hasCurrentRealtimeEnterpriseSsoAssurance(
      snapshot,
      memberEmail,
      session.authenticationMethods,
    )) return false
    if (!await hasValidRealtimeCognitoProviderBindings(
      snapshot,
      memberKey,
      memberEmail,
      process.env.COGNITO_ENTERPRISE_IDP_NAME?.trim() ?? '',
      readRealtimeCognitoProviderBinding,
    )) return false
  }
  const authorization = evaluateRealtimeEnterpriseAccess({
    snapshot,
    memberKey,
    memberEmail,
    workspaceRole,
    cognitoGroupIds,
    currentSystemAdministrator,
    breakGlass,
    legacyReadAllowed,
    legacyWriteAllowed: hasRealtimeDirectoryWriteAccess(
      session,
      directoryItems,
      workspaceRole,
    ),
    teamId: session.teamId,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(projectScopeOwnerTeamId !== undefined ? { projectScopeOwnerTeamId } : {}),
  })
  session.canWrite = authorization.canWrite
  return authorization.allowed && isRealtimeEnterpriseSessionFresh(
    snapshot.policy,
    session,
    authorization.external,
    currentSystemAdministrator || breakGlass,
    breakGlass,
  )
}

async function readCurrentRealtimeCognitoGroups(username: string) {
  const groups: string[] = []
  let nextToken: string | undefined
  try {
    do {
      const response = await cognitoClient.send(new AdminListGroupsForUserCommand({
        UserPoolId: requireEnv('COGNITO_USER_POOL_ID'),
        Username: username,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }))
      groups.push(...(response.Groups ?? [])
        .map((group) => group.GroupName)
        .filter((groupName): groupName is string => typeof groupName === 'string'))
      nextToken = response.NextToken?.trim() || undefined
    } while (nextToken)
  } catch (error) {
    if (isAwsNamedError(error, 'UserNotFoundException')) {
      return []
    }
    throw error
  }
  return [...new Set(groups)]
}

async function readUncachedRealtimeCognitoProviderBinding(providerName: string) {
  const response = await cognitoClient.send(new DescribeIdentityProviderCommand({
    UserPoolId: requireEnv('COGNITO_USER_POOL_ID'),
    ProviderName: providerName,
  }))
  const provider = response.IdentityProvider
  if (!provider?.ProviderName || !provider.ProviderType) {
    throw new Error('Cognito identity provider response is incomplete.')
  }
  return {
    providerName: provider.ProviderName,
    providerType: provider.ProviderType,
    providerDetails: Object.fromEntries(
      Object.entries(provider.ProviderDetails ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  }
}

const readRealtimeCognitoProviderBinding =
  createCachedRealtimeCognitoProviderBindingReader(
    readUncachedRealtimeCognitoProviderBinding,
  )

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

function normalizeEmailDomain(value: string) {
  const atIndex = value.lastIndexOf('@')
  return atIndex > 0 ? value.slice(atIndex + 1).trim().toLowerCase() : ''
}

function readRealtimeWorkspaceRole(value: unknown): RealtimeWorkspaceRole | undefined {
  return value === 'owner' ||
      value === 'admin' ||
      value === 'member' ||
      value === 'guest'
    ? value
    : undefined
}

function hasConfiguredRealtimeSystemAdminGroup(groupIds: readonly string[]) {
  const configuredGroups = new Set(
    requireEnv('SYSTEM_ADMIN_GROUPS').split(',').map((group) => group.trim()).filter(Boolean),
  )
  return groupIds.some((groupId) => configuredGroups.has(groupId))
}

function getEnterpriseIdentityClient() {
  if (!enterpriseIdentityClient) {
    enterpriseIdentityClient = new DynamoDbEnterpriseIdentityReadClient(
      requireEnv('ENTERPRISE_IDENTITY_TABLE_NAME'),
      documentClient,
    )
  }
  return enterpriseIdentityClient
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

function parseRealtimeTimestamp(value: string | undefined) {
  if (!value) return undefined
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds)
    ? Math.floor(milliseconds / 1_000)
    : undefined
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
