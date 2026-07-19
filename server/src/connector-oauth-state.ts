import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb'
import type { SecretProtector } from './developer-platform'
import {
  BUILT_IN_CONNECTOR_CATALOG,
  type ConnectorProviderId,
} from './connectors'
import {
  ConnectorRuntimeError,
  createConnectorPkceChallenge,
} from './connector-oauth'

/** OAuth state の既定有効期間です。 */
export const CONNECTOR_OAUTH_STATE_TTL_SECONDS = 10 * 60

/** OAuth state に許可する最大有効期間です。 */
export const CONNECTOR_OAUTH_STATE_MAX_TTL_SECONDS = 15 * 60

/** OAuth state store に保存する暗号化済み envelope です。 */
export type StoredConnectorOAuthState = {
  /** Replay protection に使う random state ID です。 */
  stateId: string
  /** SecretProtector で暗号化された flow payload です。 */
  protectedPayload: string
  /** DynamoDB TTL と application expiry に使う epoch seconds です。 */
  expiresAtEpochSeconds: number
}

/** OAuth state の durable single-use storage boundary です。 */
export interface ConnectorOAuthStateStore {
  /** State ID が未使用の場合だけ暗号化済み flow を保存します。 */
  put(state: StoredConnectorOAuthState): Promise<void>
  /** State を consume せず強整合で取得します。 */
  get(stateId: string): Promise<StoredConnectorOAuthState | undefined>
  /** State を一度だけ原子的に取り出して削除します。 */
  consume(stateId: string): Promise<StoredConnectorOAuthState | undefined>
}

/** OAuth callback が復号して利用する provider-bound flow です。 */
export type ConnectorOAuthFlow = {
  /** Flow schema version です。 */
  version: 1
  /** Installation 作成または既存 installation 再認証です。 */
  kind: 'install' | 'reauthorize'
  /** Replay protection に使う random state ID です。 */
  stateId: string
  /** Flow を開始した Workspace ID です。 */
  workspaceId: string
  /** Flow を開始した current Workspace user ID です。 */
  userId: string
  /** OAuth provider ID です。 */
  provider: ConnectorProviderId
  /** Installation の表示名です。 */
  name: string
  /** User が要求した provider scope です。 */
  scopes: string[]
  /** OAuth callback 後に戻す application-relative URL です。 */
  returnUrl: string
  /** Provider configuration に固定された callback URL です。 */
  redirectUri: string
  /** Provider に送らず callback まで保護する PKCE verifier です。 */
  codeVerifier: string
  /** Reauthorization 対象 installation ID です。 */
  installationId?: string
  /** Flow 作成時刻の epoch seconds です。 */
  createdAtEpochSeconds: number
  /** Flow 失効時刻の epoch seconds です。 */
  expiresAtEpochSeconds: number
}

/** Authorization URL 構築に使う新しい OAuth flow です。 */
export type CreatedConnectorOAuthFlow = {
  /** State store の random state ID です。 */
  stateId: string
  /** Provider callback で検証する HMAC-signed state token です。 */
  state: string
  /** PKCE S256 challenge です。 */
  codeChallenge: string
  /** Flow 失効日時です。 */
  expiresAt: string
}

/** 新しい OAuth flow を作る入力です。 */
export type CreateConnectorOAuthFlowInput = {
  /** Installation 作成または既存 installation 再認証です。 */
  kind: 'install' | 'reauthorize'
  /** Flow を開始する Workspace ID です。 */
  workspaceId: string
  /** Flow を開始する current Workspace user ID です。 */
  userId: string
  /** OAuth provider ID です。 */
  provider: ConnectorProviderId
  /** Installation の表示名です。 */
  name: string
  /** User が要求する provider scope です。 */
  scopes: readonly string[]
  /** OAuth callback 後の application-relative URL です。 */
  returnUrl: string
  /** Provider configuration に固定された callback URL です。 */
  redirectUri: string
  /** Reauthorization 対象 installation ID です。 */
  installationId?: string
  /** Idempotent flow creation に使う stable internal operation ID です。 */
  operationId?: string
}

/** Signed OAuth state manager の構築 options です。 */
export type ConnectorOAuthStateManagerOptions = {
  /** Single-use state storage です。 */
  store: ConnectorOAuthStateStore
  /** PKCE verifier を含む flow payload の protector です。 */
  protector: SecretProtector
  /** State token の HMAC secret です。 */
  signingSecret: string
  /** Key rotation 中に既存 state token の検証だけへ使う旧 HMAC secrets です。 */
  previousSigningSecrets?: readonly string[]
  /** Flow lifetime 秒数です。 */
  ttlSeconds?: number
  /** Expiry 判定に使う clock です。 */
  clock?: () => Date
  /** Test で random bytes を固定する generator です。 */
  randomBytes?: (size: number) => Buffer
}

/** PKCE verifier を暗号化し、state を署名して replay-safe に管理します。 */
export class ConnectorOAuthStateManager {
  /** Single-use state storage です。 */
  private readonly store: ConnectorOAuthStateStore
  /** Flow payload の context-bound protector です。 */
  private readonly protector: SecretProtector
  /** State token の HMAC secret です。 */
  private readonly signingSecret: Buffer
  /** Current key と rotation grace period 中の旧 key を含む検証用 secrets です。 */
  private readonly verificationSigningSecrets: readonly Buffer[]
  /** Flow lifetime 秒数です。 */
  private readonly ttlSeconds: number
  /** Expiry 判定に使う clock です。 */
  private readonly clock: () => Date
  /** State ID と PKCE verifier を作る random generator です。 */
  private readonly random: (size: number) => Buffer

  /** Durable OAuth state manager を作成します。 */
  constructor(options: ConnectorOAuthStateManagerOptions) {
    this.store = options.store
    this.protector = options.protector
    this.signingSecret = Buffer.from(options.signingSecret, 'utf8')
    const previousSigningSecrets = options.previousSigningSecrets ?? []
    if (previousSigningSecrets.length > 3) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateSecretInvalid',
        'Connector OAuth state cannot retain more than three previous signing secrets.',
      )
    }
    this.verificationSigningSecrets = [
      this.signingSecret,
      ...previousSigningSecrets.map((secret) => Buffer.from(secret, 'utf8')),
    ].filter((secret, index, secrets) =>
      secrets.findIndex((candidate) => candidate.equals(secret)) === index
    )
    if (this.verificationSigningSecrets.some((secret) => secret.byteLength < 32)) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateSecretInvalid',
        'Connector OAuth state signing secrets must be at least 32 bytes.',
      )
    }
    this.ttlSeconds = options.ttlSeconds ?? CONNECTOR_OAUTH_STATE_TTL_SECONDS
    if (
      !Number.isSafeInteger(this.ttlSeconds) ||
      this.ttlSeconds < 60 ||
      this.ttlSeconds > CONNECTOR_OAUTH_STATE_MAX_TTL_SECONDS
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateTtlInvalid',
        'Connector OAuth state TTL is invalid.',
      )
    }
    this.clock = options.clock ?? (() => new Date())
    this.random = options.randomBytes ?? randomBytes
  }

  /** Encrypted PKCE flow と signed state token を作成します。 */
  async create(input: CreateConnectorOAuthFlowInput): Promise<CreatedConnectorOAuthFlow> {
    validateFlowInput(input)
    const stateId = input.operationId
      ? createDeterministicStateId(input.operationId, this.signingSecret)
      : this.random(24).toString('base64url')
    const nowEpochSeconds = Math.floor(this.clock().getTime() / 1_000)
    const existing = await this.readReusableFlow(input, stateId, nowEpochSeconds)
    if (existing) return existing
    const codeVerifier = input.operationId
      ? createDeterministicCodeVerifier(input.operationId, this.signingSecret)
      : this.random(48).toString('base64url')
    const createdAtEpochSeconds = nowEpochSeconds
    const expiresAtEpochSeconds = createdAtEpochSeconds + this.ttlSeconds
    const flow: ConnectorOAuthFlow = {
      version: 1,
      kind: input.kind,
      stateId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: input.provider,
      name: input.name,
      scopes: [...new Set(input.scopes)].sort(),
      returnUrl: input.returnUrl,
      redirectUri: input.redirectUri,
      codeVerifier,
      ...(input.installationId ? { installationId: input.installationId } : {}),
      createdAtEpochSeconds,
      expiresAtEpochSeconds,
    }
    const protectedPayload = await this.protector.protect(
      JSON.stringify(flow),
      stateProtectionContext(stateId),
    )
    try {
      await this.store.put({
        stateId,
        protectedPayload,
        expiresAtEpochSeconds,
      })
    } catch (error) {
      if (
        input.operationId &&
        error instanceof ConnectorRuntimeError &&
        error.code === 'ConnectorOAuthStateCollision'
      ) {
        const winner = await this.readReusableFlow(
          input,
          stateId,
          nowEpochSeconds,
        )
        if (winner) return winner
      }
      throw error
    }
    const state = createSignedStateToken(
      stateId,
      expiresAtEpochSeconds,
      this.signingSecret,
    )
    return {
      stateId,
      state,
      codeChallenge: createConnectorPkceChallenge(codeVerifier),
      expiresAt: new Date(expiresAtEpochSeconds * 1_000).toISOString(),
    }
  }

  /** 同一 operation の未失効 flow を復元し、期限切れ record は除去します。 */
  private async readReusableFlow(
    input: CreateConnectorOAuthFlowInput,
    stateId: string,
    nowEpochSeconds: number,
  ): Promise<CreatedConnectorOAuthFlow | undefined> {
    if (!input.operationId) return undefined
    const stored = await this.store.get(stateId)
    if (!stored) return undefined
    if (stored.expiresAtEpochSeconds < nowEpochSeconds) {
      await this.store.consume(stateId)
      return undefined
    }
    let flow: ConnectorOAuthFlow
    try {
      flow = readOAuthFlow(JSON.parse(await this.protector.unprotect(
        stored.protectedPayload,
        stateProtectionContext(stateId),
      )))
    } catch (error) {
      if (error instanceof ConnectorRuntimeError) throw error
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateInvalid',
        'Connector OAuth state payload is invalid.',
      )
    }
    if (
      flow.stateId !== stateId ||
      flow.expiresAtEpochSeconds !== stored.expiresAtEpochSeconds ||
      !matchesFlowInput(flow, input)
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateCollision',
        'Connector OAuth operation ID belongs to another flow.',
      )
    }
    return {
      stateId,
      state: createSignedStateToken(
        stateId,
        flow.expiresAtEpochSeconds,
        this.signingSecret,
      ),
      codeChallenge: createConnectorPkceChallenge(flow.codeVerifier),
      expiresAt: new Date(flow.expiresAtEpochSeconds * 1_000).toISOString(),
    }
  }

  /** Signed state を検証し、暗号化 flow を一度だけ consume します。 */
  async consume(state: string): Promise<ConnectorOAuthFlow> {
    const token = parseAndVerifyStateToken(
      state,
      this.verificationSigningSecrets,
    )
    const nowEpochSeconds = Math.floor(this.clock().getTime() / 1_000)
    if (token.expiresAtEpochSeconds < nowEpochSeconds) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateExpired',
        'Connector OAuth state has expired.',
      )
    }
    const stored = await this.store.consume(token.stateId)
    if (!stored) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateConsumed',
        'Connector OAuth state is invalid or was already consumed.',
      )
    }
    if (
      stored.stateId !== token.stateId ||
      stored.expiresAtEpochSeconds !== token.expiresAtEpochSeconds
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateInvalid',
        'Connector OAuth state binding is invalid.',
      )
    }
    let flowValue: unknown
    try {
      const plaintext = await this.protector.unprotect(
        stored.protectedPayload,
        stateProtectionContext(token.stateId),
      )
      flowValue = JSON.parse(plaintext)
    } catch (error) {
      if (error instanceof ConnectorRuntimeError) throw error
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateInvalid',
        'Connector OAuth state payload is invalid.',
      )
    }
    const flow = readOAuthFlow(flowValue)
    if (
      flow.stateId !== token.stateId ||
      flow.expiresAtEpochSeconds !== token.expiresAtEpochSeconds ||
      flow.expiresAtEpochSeconds < nowEpochSeconds
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateInvalid',
        'Connector OAuth state payload binding is invalid.',
      )
    }
    return flow
  }
}

/** Test/local development 用 single-process atomic OAuth state store です。 */
export class InMemoryConnectorOAuthStateStore implements ConnectorOAuthStateStore {
  /** State ID ごとの encrypted envelope です。 */
  private readonly states = new Map<string, StoredConnectorOAuthState>()

  /** 未使用 state を保存します。 */
  async put(state: StoredConnectorOAuthState) {
    if (this.states.has(state.stateId)) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateCollision',
        'Connector OAuth state ID already exists.',
      )
    }
    this.states.set(state.stateId, structuredClone(state))
  }

  /** State snapshot を consume せず返します。 */
  async get(stateId: string) {
    const state = this.states.get(stateId)
    return state ? structuredClone(state) : undefined
  }

  /** State を一度だけ取り出して削除します。 */
  async consume(stateId: string) {
    const state = this.states.get(stateId)
    if (!state) return undefined
    this.states.delete(stateId)
    return structuredClone(state)
  }
}

/** DynamoDB OAuth state store の構築 options です。 */
export type DynamoDbConnectorOAuthStateStoreOptions = {
  /** Developer platform compatible table 名です。 */
  tableName: string
  /** Test または production runtime が注入する document client です。 */
  documentClient?: DynamoDBDocumentClient
}

/** DynamoDB に encrypted single-use OAuth state と TTL を保存します。 */
export class DynamoDbConnectorOAuthStateStore implements ConnectorOAuthStateStore {
  /** DynamoDB table 名です。 */
  private readonly tableName: string
  /** DynamoDB document client です。 */
  private readonly documentClient: DynamoDBDocumentClient

  /** DynamoDB-backed OAuth state store を作成します。 */
  constructor(options: DynamoDbConnectorOAuthStateStoreOptions) {
    if (!options.tableName.trim()) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateStoreInvalid',
        'Connector OAuth state table name is required.',
      )
    }
    this.tableName = options.tableName
    this.documentClient = options.documentClient ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}))
  }

  /** State ID collision を conditionally 拒否して encrypted flow を保存します。 */
  async put(state: StoredConnectorOAuthState) {
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          workspaceId: statePartitionKey(state.stateId),
          recordKey: stateRecordKey(state.stateId),
          entryType: 'connector-oauth-state',
          protectedPayload: state.protectedPayload,
          expiresAt: state.expiresAtEpochSeconds,
          version: 1,
        },
        ConditionExpression:
          'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
      }))
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        throw new ConnectorRuntimeError(
          'ConnectorOAuthStateCollision',
          'Connector OAuth state ID already exists.',
        )
      }
      throw error
    }
  }

  /** DynamoDB から state snapshot を強整合取得します。 */
  async get(stateId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId: statePartitionKey(stateId),
        recordKey: stateRecordKey(stateId),
      },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredState(response.Item, stateId) : undefined
  }

  /** DynamoDB DeleteItem return-old-value で state を exactly once consume します。 */
  async consume(stateId: string) {
    const response = await this.documentClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: {
        workspaceId: statePartitionKey(stateId),
        recordKey: stateRecordKey(stateId),
      },
      ReturnValues: 'ALL_OLD',
    }))
    if (!response.Attributes) return undefined
    return readStoredState(response.Attributes, stateId)
  }
}

/** Environment から durable OAuth state store を作成します。 */
export function createDynamoDbConnectorOAuthStateStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  documentClient?: DynamoDBDocumentClient,
) {
  const tableName = environment.DEVELOPER_PLATFORM_TABLE_NAME
  if (!tableName) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthStateStoreInvalid',
      'DEVELOPER_PLATFORM_TABLE_NAME is required for connector OAuth state.',
    )
  }
  return new DynamoDbConnectorOAuthStateStore({
    tableName,
    ...(documentClient ? { documentClient } : {}),
  })
}

function createSignedStateToken(
  stateId: string,
  expiresAtEpochSeconds: number,
  signingSecret: Buffer,
) {
  const payload = `v1.${stateId}.${expiresAtEpochSeconds}`
  const signature = createHmac('sha256', signingSecret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function createDeterministicStateId(operationId: string, signingSecret: Buffer) {
  return createHmac('sha256', signingSecret)
    .update(`connector-oauth-state-id-v1\0${operationId}`)
    .digest()
    .subarray(0, 24)
    .toString('base64url')
}

function createDeterministicCodeVerifier(
  operationId: string,
  signingSecret: Buffer,
) {
  return createHmac('sha512', signingSecret)
    .update(`connector-oauth-pkce-v1\0${operationId}`)
    .digest()
    .subarray(0, 48)
    .toString('base64url')
}

function matchesFlowInput(
  flow: ConnectorOAuthFlow,
  input: CreateConnectorOAuthFlowInput,
) {
  return flow.kind === input.kind &&
    flow.workspaceId === input.workspaceId &&
    flow.userId === input.userId &&
    flow.provider === input.provider &&
    flow.name === input.name &&
    flow.returnUrl === input.returnUrl &&
    flow.redirectUri === input.redirectUri &&
    flow.installationId === input.installationId &&
    JSON.stringify(flow.scopes) === JSON.stringify([...new Set(input.scopes)].sort())
}

function parseAndVerifyStateToken(
  value: string,
  signingSecrets: readonly Buffer[],
) {
  const parts = value.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthStateInvalid',
      'Connector OAuth state token is invalid.',
    )
  }
  const stateId = parts[1]!
  const expiresAtEpochSeconds = Number(parts[2])
  const signature = parts[3]!
  if (
    !/^[A-Za-z0-9_-]{32}$/u.test(stateId) ||
    !Number.isSafeInteger(expiresAtEpochSeconds) ||
    expiresAtEpochSeconds <= 0 ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signature)
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthStateInvalid',
      'Connector OAuth state token is invalid.',
    )
  }
  const actual = Buffer.from(signature, 'base64url')
  let validSignature = false
  for (const signingSecret of signingSecrets) {
    const expected = createHmac('sha256', signingSecret)
      .update(`v1.${stateId}.${expiresAtEpochSeconds}`)
      .digest()
    const matches = actual.byteLength === expected.byteLength &&
      timingSafeEqual(actual, expected)
    validSignature = matches || validSignature
  }
  if (!validSignature) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthStateInvalid',
      'Connector OAuth state signature is invalid.',
    )
  }
  return { stateId, expiresAtEpochSeconds }
}

function validateFlowInput(input: CreateConnectorOAuthFlowInput) {
  requireIdentifier(input.workspaceId, 'Workspace ID')
  requireIdentifier(input.userId, 'Workspace user ID')
  requireIdentifier(input.name, 'Connector name', 200)
  if (!BUILT_IN_CONNECTOR_CATALOG.some((entry) => entry.id === input.provider)) {
    throw new ConnectorRuntimeError(
      'ConnectorProviderUnsupported',
      'Connector provider is not supported by this runtime.',
    )
  }
  if (
    input.scopes.length > 100 ||
    input.scopes.some((scope) =>
      typeof scope !== 'string' ||
      !scope.trim() ||
      scope !== scope.trim() ||
      scope.length > 256 ||
      hasControlCharacters(scope)
    )
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorScopesInvalid',
      'Connector scopes are invalid.',
    )
  }
  validateReturnUrl(input.returnUrl)
  validateRedirectUri(input.redirectUri)
  if (input.operationId !== undefined) {
    requireIdentifier(input.operationId, 'OAuth flow operation ID', 512)
  }
  if (input.kind === 'reauthorize') {
    requireIdentifier(input.installationId ?? '', 'Connector installation ID')
  } else if (input.installationId !== undefined) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthFlowInvalid',
      'New connector flow cannot target an existing installation.',
    )
  }
}

function validateReturnUrl(value: string) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.length > 2_048
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorReturnUrlInvalid',
      'Connector return URL must be application-relative.',
    )
  }
}

function validateRedirectUri(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConnectorRuntimeError(
      'ConnectorRedirectUriInvalid',
      'Connector redirect URI is invalid.',
    )
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorRedirectUriInvalid',
      'Connector redirect URI must use HTTPS.',
    )
  }
}

function readOAuthFlow(value: unknown): ConnectorOAuthFlow {
  if (!isRecord(value)) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthStateInvalid',
      'Connector OAuth state payload is malformed.',
    )
  }
  const kind = value.kind
  const provider = value.provider
  if (
    value.version !== 1 ||
    (kind !== 'install' && kind !== 'reauthorize') ||
    typeof provider !== 'string' ||
    !BUILT_IN_CONNECTOR_CATALOG.some((entry) => entry.id === provider) ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => typeof scope === 'string') ||
    !Number.isSafeInteger(value.createdAtEpochSeconds) ||
    !Number.isSafeInteger(value.expiresAtEpochSeconds)
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthStateInvalid',
      'Connector OAuth state payload is malformed.',
    )
  }
  const flow: ConnectorOAuthFlow = {
    version: 1,
    kind,
    stateId: requireIdentifier(value.stateId, 'OAuth state ID'),
    workspaceId: requireIdentifier(value.workspaceId, 'Workspace ID'),
    userId: requireIdentifier(value.userId, 'Workspace user ID'),
    provider: provider as ConnectorProviderId,
    name: requireIdentifier(value.name, 'Connector name', 200),
    scopes: value.scopes as string[],
    returnUrl: requireString(value.returnUrl, 'Connector return URL'),
    redirectUri: requireString(value.redirectUri, 'Connector redirect URI'),
    codeVerifier: requireString(value.codeVerifier, 'OAuth PKCE code verifier'),
    ...(value.installationId === undefined
      ? {}
      : {
          installationId: requireIdentifier(
            value.installationId,
            'Connector installation ID',
          ),
        }),
    createdAtEpochSeconds: value.createdAtEpochSeconds as number,
    expiresAtEpochSeconds: value.expiresAtEpochSeconds as number,
  }
  validateFlowInput(flow)
  return flow
}

function readStoredState(
  value: Record<string, unknown>,
  expectedStateId: string,
): StoredConnectorOAuthState {
  if (
    value.entryType !== 'connector-oauth-state' ||
    typeof value.protectedPayload !== 'string' ||
    !value.protectedPayload ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthStateInvalid',
      'Stored connector OAuth state is malformed.',
    )
  }
  return {
    stateId: expectedStateId,
    protectedPayload: value.protectedPayload,
    expiresAtEpochSeconds: value.expiresAt as number,
  }
}

function statePartitionKey(stateId: string) {
  const safeStateId = requireIdentifier(stateId, 'OAuth state ID')
  return `CONNECTOR-OAUTH-STATE#${safeStateId.slice(0, 2)}`
}

function stateRecordKey(stateId: string) {
  return `STATE#${requireIdentifier(stateId, 'OAuth state ID')}`
}

function stateProtectionContext(stateId: string) {
  return `mukuroji:platform-state:connector-oauth:v1\0${stateId}`
}

function requireIdentifier(value: unknown, label: string, maximum = 512) {
  const result = requireString(value, label)
  if (
    result.length > maximum ||
    result !== result.trim() ||
    hasControlCharacters(result)
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthFlowInvalid',
      `${label} is invalid.`,
    )
  }
  return result
}

function requireString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value || value.length > 8_192) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthFlowInvalid',
      `${label} is invalid.`,
    )
  }
  return value
}

function isConditionalCheckFailure(error: unknown) {
  return isRecord(error) && error.name === 'ConditionalCheckFailedException'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlCharacters(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint < 0x20 || codePoint === 0x7f
  })
}
