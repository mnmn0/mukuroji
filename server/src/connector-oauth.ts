import { createHash } from 'node:crypto'
import {
  BUILT_IN_CONNECTOR_CATALOG,
  ConnectorAdapterError,
  ConnectorRegistry,
  type ConnectorAdapter,
  type ConnectorAuthorizationInput,
  type ConnectorCredential,
  type ConnectorDefinition,
  type ConnectorExternalRecord,
  type ConnectorOutboundMutation,
  type ConnectorPage,
  type ConnectorProviderId,
  type ExternalResourceType,
} from './connectors'

/** Connector HTTP response から値を読む JSON path です。 */
export type ConnectorJsonPath = string

/** OAuth token response の provider 固有 field mapping です。 */
export type ConnectorOAuthTokenMapping = {
  /** Access token の JSON path です。 */
  accessToken: ConnectorJsonPath
  /** Refresh token の JSON path です。 */
  refreshToken?: ConnectorJsonPath
  /** `expires_in` 秒数の JSON path です。 */
  expiresInSeconds?: ConnectorJsonPath
  /** Space 区切り文字列または文字列配列の scope JSON path です。 */
  scopes?: ConnectorJsonPath
  /** Token response 自体に account ID がある場合の JSON path です。 */
  externalAccountId?: ConnectorJsonPath
  /** Token response 自体に account 名がある場合の JSON path です。 */
  externalAccountName?: ConnectorJsonPath
}

/** Provider account response の identity field mapping です。 */
export type ConnectorOAuthAccountMapping = {
  /** Provider account ID の JSON path です。 */
  externalAccountId: ConnectorJsonPath
  /** Provider account 表示名の JSON path です。 */
  externalAccountName?: ConnectorJsonPath
}

/** Normalized external record を provider JSON から読む field mapping です。 */
export type ConnectorExternalRecordMapping = {
  /** Provider 内の immutable resource ID path です。 */
  externalId: ConnectorJsonPath
  /** Provider UI の HTTPS URL path です。 */
  externalUrl: ConnectorJsonPath
  /** Provider resource version または更新時刻 path です。 */
  externalVersion: ConnectorJsonPath
  /** UI 向け短縮 key path です。 */
  displayKey?: ConnectorJsonPath
  /** Work Item title に対応する path です。 */
  title?: ConnectorJsonPath
  /** Work Item description に対応する path です。 */
  description?: ConnectorJsonPath
  /** Normalized status に対応する path です。 */
  status?: ConnectorJsonPath
  /** Echo-loop marker を返す path です。 */
  originMarker?: ConnectorJsonPath
  /** Secret を含まない metadata へ明示的にコピーする path 一覧です。 */
  metadata?: readonly ConnectorJsonPath[]
}

/** Work Item mutation を provider JSON body へ書く field mapping です。 */
export type ConnectorOutboundMutationMapping = {
  /** Work Item title を送る provider field 名です。 */
  title?: string
  /** Work Item description を送る provider field 名です。 */
  description?: string
  /** Work Item status を送る provider field 名です。 */
  status?: string
  /** Echo-loop marker を送る provider field 名です。 */
  originMarker: string
}

/** Resource type ごとの provider REST binding です。 */
export type ConnectorOAuthResourceBinding = {
  /** Pull collection の API base URL 相対 path です。 */
  collectionPath: string
  /** Push resource の API base URL 相対 path です。 */
  itemPath: string
  /** Pull response 内の item 配列 path です。 */
  itemsPath: ConnectorJsonPath
  /** Pull response 内の次 cursor path です。 */
  nextCursorPath?: ConnectorJsonPath
  /** Pull request の cursor query parameter 名です。 */
  cursorParameter?: string
  /** Push HTTP method です。 */
  pushMethod?: 'PATCH' | 'PUT' | 'POST'
  /** Provider の冪等 write header 名です。 */
  idempotencyHeader?: string
  /** Provider の optimistic concurrency version header 名です。 */
  versionHeader?: string
  /** Provider record の読み取り mapping です。 */
  record: ConnectorExternalRecordMapping
  /** Provider mutation の書き込み mapping です。 */
  mutation: ConnectorOutboundMutationMapping
}

/** Environment 設定から構築する generic OAuth provider adapter の入力です。 */
export type ConfiguredOAuthConnectorOptions = {
  /** Built-in catalog と一致する provider metadata です。 */
  definition: ConnectorDefinition
  /** Public OAuth client ID です。 */
  clientId: string
  /** Server-side OAuth client secret です。 */
  clientSecret: string
  /** OAuth callback の固定 HTTPS URL です。 */
  redirectUri: string
  /** Provider authorization endpoint です。 */
  authorizationEndpoint: string
  /** Provider token endpoint です。 */
  tokenEndpoint: string
  /** RFC 7009 compatible revocation endpoint です。 */
  revocationEndpoint?: string
  /** Provider account profile endpoint です。 */
  accountEndpoint?: string
  /** Provider resource API の base URL です。 */
  apiBaseUrl: string
  /** OAuth client authentication 方式です。 */
  clientAuthentication?: 'body' | 'basic'
  /** Authorization URL に常に加える parameter です。 */
  authorizationParameters?: Readonly<Record<string, string>>
  /** Provider が既定で要求する scope です。 */
  defaultScopes: readonly string[]
  /** Token response field mapping です。 */
  token: ConnectorOAuthTokenMapping
  /** Account endpoint response field mapping です。 */
  account?: ConnectorOAuthAccountMapping
  /** Provider resource type ごとの REST binding です。 */
  resources: Partial<Record<ExternalResourceType, ConnectorOAuthResourceBinding>>
  /** Trusted configuration でも接続を許す host を限定する allowlist です。 */
  allowedHosts: readonly string[]
  /** Test または egress 制御付き runtime が注入する fetch です。 */
  fetch?: typeof fetch
  /** Token expiry と timestamps に使う clock です。 */
  clock?: () => Date
  /** Provider HTTP request の timeout ミリ秒です。 */
  requestTimeoutMilliseconds?: number
}

/** Authorization URL を作る provider-neutral input です。 */
export type ConnectorOAuthAuthorizationRequest = {
  /** HMAC 検証可能な OAuth state token です。 */
  state: string
  /** PKCE S256 code challenge です。 */
  codeChallenge: string
  /** User が要求した provider scope です。 */
  scopes: readonly string[]
}

/** OAuth authorization と ConnectorAdapter を統合する boundary です。 */
export interface ConnectorOAuthAdapter extends ConnectorAdapter {
  /** OAuth callback の固定 redirect URI です。 */
  readonly redirectUri: string
  /** Signed state と PKCE challenge を含む provider authorization URL を作ります。 */
  createAuthorizationUrl(input: ConnectorOAuthAuthorizationRequest): string
}

/** Connector runtime が外部 provider 失敗を分類する stable error です。 */
export class ConnectorRuntimeError extends Error {
  /** Stable internal error code です。 */
  readonly code: string
  /** Retry により回復する可能性です。 */
  readonly retryable: boolean
  /** Credential 再認証が必要かどうかです。 */
  readonly authorizationRequired: boolean
  /** Secret を含まない provider HTTP status です。 */
  readonly providerStatus?: number

  /** Secret-safe connector runtime error を作成します。 */
  constructor(
    code: string,
    message: string,
    options: {
      /** Retry により回復する可能性です。 */
      retryable?: boolean
      /** Credential 再認証が必要かどうかです。 */
      authorizationRequired?: boolean
      /** Secret を含まない provider HTTP status です。 */
      providerStatus?: number
    } = {},
  ) {
    super(message)
    this.name = 'ConnectorRuntimeError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.authorizationRequired = options.authorizationRequired ?? false
    this.providerStatus = options.providerStatus
  }
}

/** HTTPS OAuth と normalized REST mapping を実装する configurable adapter です。 */
export class ConfiguredOAuthConnectorAdapter implements ConnectorOAuthAdapter {
  /** Adapter が実装する built-in provider metadata です。 */
  readonly definition: ConnectorDefinition
  /** OAuth callback の固定 redirect URI です。 */
  readonly redirectUri: string
  /** OAuth client ID です。 */
  private readonly clientId: string
  /** OAuth client secret です。 */
  private readonly clientSecret: string
  /** Provider authorization endpoint です。 */
  private readonly authorizationEndpoint: URL
  /** Provider token endpoint です。 */
  private readonly tokenEndpoint: URL
  /** Provider revocation endpoint です。 */
  private readonly revocationEndpoint?: URL
  /** Provider account endpoint です。 */
  private readonly accountEndpoint?: URL
  /** Provider resource API base URL です。 */
  private readonly apiBaseUrl: URL
  /** OAuth client authentication 方式です。 */
  private readonly clientAuthentication: 'body' | 'basic'
  /** Authorization URL の固定 parameter です。 */
  private readonly authorizationParameters: Readonly<Record<string, string>>
  /** Provider の既定 scope です。 */
  private readonly defaultScopes: readonly string[]
  /** Token response field mapping です。 */
  private readonly tokenMapping: ConnectorOAuthTokenMapping
  /** Account response field mapping です。 */
  private readonly accountMapping?: ConnectorOAuthAccountMapping
  /** Resource type ごとの REST binding です。 */
  private readonly resources: Partial<
    Record<ExternalResourceType, ConnectorOAuthResourceBinding>
  >
  /** Network transport です。 */
  private readonly fetcher: typeof fetch
  /** Token expiry 計算に使う clock です。 */
  private readonly clock: () => Date
  /** Provider HTTP request timeout ミリ秒です。 */
  private readonly requestTimeoutMilliseconds: number

  /** 検証済み provider configuration から adapter を作成します。 */
  constructor(options: ConfiguredOAuthConnectorOptions) {
    this.definition = validateDefinition(options.definition)
    this.clientId = requireNonEmpty(options.clientId, 'OAuth client ID')
    this.clientSecret = requireNonEmpty(options.clientSecret, 'OAuth client secret')
    this.redirectUri = validateHttpsEndpoint(
      options.redirectUri,
      options.allowedHosts,
      'OAuth redirect URI',
    ).toString()
    this.authorizationEndpoint = validateHttpsEndpoint(
      options.authorizationEndpoint,
      options.allowedHosts,
      'OAuth authorization endpoint',
    )
    this.tokenEndpoint = validateHttpsEndpoint(
      options.tokenEndpoint,
      options.allowedHosts,
      'OAuth token endpoint',
    )
    this.revocationEndpoint = options.revocationEndpoint
      ? validateHttpsEndpoint(
          options.revocationEndpoint,
          options.allowedHosts,
          'OAuth revocation endpoint',
        )
      : undefined
    this.accountEndpoint = options.accountEndpoint
      ? validateHttpsEndpoint(
          options.accountEndpoint,
          options.allowedHosts,
          'OAuth account endpoint',
        )
      : undefined
    this.apiBaseUrl = validateHttpsEndpoint(
      options.apiBaseUrl,
      options.allowedHosts,
      'Connector API base URL',
    )
    this.clientAuthentication = options.clientAuthentication ?? 'body'
    this.authorizationParameters = validateFixedParameters(
      options.authorizationParameters ?? {},
    )
    this.defaultScopes = validateScopes(options.defaultScopes)
    this.tokenMapping = validateTokenMapping(options.token)
    this.accountMapping = options.account
    this.resources = validateResourceBindings(options.resources)
    if (
      !this.accountEndpoint &&
      !this.tokenMapping.externalAccountId
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorAccountIdentityMissing',
        'Connector configuration must map an external account identity.',
      )
    }
    if (this.accountEndpoint && !this.accountMapping) {
      throw new ConnectorRuntimeError(
        'ConnectorAccountMappingMissing',
        'Connector account endpoint requires an account field mapping.',
      )
    }
    this.fetcher = options.fetch ?? fetch
    this.clock = options.clock ?? (() => new Date())
    this.requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? 10_000
    if (
      !Number.isSafeInteger(this.requestTimeoutMilliseconds) ||
      this.requestTimeoutMilliseconds < 1_000 ||
      this.requestTimeoutMilliseconds > 30_000
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorRequestTimeoutInvalid',
        'Connector request timeout must be between 1000 and 30000 milliseconds.',
      )
    }
  }

  /** Signed state と PKCE challenge を含む authorization URL を作ります。 */
  createAuthorizationUrl(input: ConnectorOAuthAuthorizationRequest) {
    const url = new URL(this.authorizationEndpoint)
    for (const [name, value] of Object.entries(this.authorizationParameters)) {
      url.searchParams.set(name, value)
    }
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', this.redirectUri)
    url.searchParams.set('state', requireNonEmpty(input.state, 'OAuth state'))
    url.searchParams.set('code_challenge', requireNonEmpty(
      input.codeChallenge,
      'OAuth PKCE code challenge',
    ))
    url.searchParams.set('code_challenge_method', 'S256')
    const scopes = this.validateRequestedScopes(
      input.scopes.length > 0 ? input.scopes : this.defaultScopes,
    )
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '))
    return url.toString()
  }

  /** Authorization code を provider credential へ交換します。 */
  async connect(input: ConnectorAuthorizationInput) {
    if (input.redirectUri !== this.redirectUri) {
      throw new ConnectorRuntimeError(
        'ConnectorRedirectUriMismatch',
        'OAuth callback redirect URI does not match provider configuration.',
      )
    }
    requireNonEmpty(input.state, 'OAuth state')
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: requireNonEmpty(input.code, 'OAuth authorization code'),
      redirect_uri: this.redirectUri,
      code_verifier: requireNonEmpty(input.codeVerifier, 'OAuth PKCE code verifier'),
    })
    const requestedScopes = this.validateRequestedScopes(input.requestedScopes)
    const tokenPayload = await this.requestToken(form)
    return this.readCredential(tokenPayload, undefined, requestedScopes)
  }

  /** Refresh token を使って expiring credential を更新します。 */
  async refresh(credential: ConnectorCredential) {
    if (!credential.refreshToken) {
      throw new ConnectorRuntimeError(
        'ConnectorRefreshTokenMissing',
        'Connector credential cannot be refreshed without a refresh token.',
        { authorizationRequired: true },
      )
    }
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
    })
    const tokenPayload = await this.requestToken(form)
    const refreshed = await this.readCredential(tokenPayload, credential)
    return {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? credential.refreshToken,
      externalAccountId: credential.externalAccountId,
      externalAccountName:
        refreshed.externalAccountName ?? credential.externalAccountName,
    }
  }

  /** Provider 側 credential grant を revoke します。 */
  async disconnect(credential: ConnectorCredential) {
    if (!this.revocationEndpoint) {
      throw new ConnectorRuntimeError(
        'ConnectorRevocationUnsupported',
        'Connector provider does not have a configured revocation endpoint.',
      )
    }
    const accessToken = requireNonEmpty(
      credential.accessToken,
      'Connector access token',
    )
    const refreshToken = credential.refreshToken
      ? requireNonEmpty(credential.refreshToken, 'Connector refresh token')
      : undefined
    if (refreshToken && refreshToken !== accessToken) {
      await this.revokeToken(refreshToken, 'refresh_token')
    }
    await this.revokeToken(accessToken, 'access_token')
  }

  /** Refresh/access token を個別に revoke し、成功 response だけを受理します。 */
  private async revokeToken(
    token: string,
    tokenTypeHint: 'refresh_token' | 'access_token',
  ) {
    const form = new URLSearchParams({
      token: requireNonEmpty(token, 'Connector token'),
      token_type_hint: tokenTypeHint,
    })
    this.addClientAuthentication(form)
    const response = await this.fetchWithTimeout(this.revocationEndpoint!, {
      method: 'POST',
      redirect: 'error',
      headers: this.createFormHeaders(),
      body: form,
    })
    if (!response.ok) {
      throw createProviderHttpError(response.status, 'revoke credential')
    }
  }

  /** Provider resources を cursor page で取得します。 */
  async pull(
    credential: ConnectorCredential,
    resourceType: ExternalResourceType,
    cursor?: string,
  ): Promise<ConnectorPage<ConnectorExternalRecord>> {
    const binding = this.requireResourceBinding(resourceType)
    const url = resolveApiPath(this.apiBaseUrl, binding.collectionPath)
    if (cursor) {
      url.searchParams.set(
        binding.cursorParameter ?? 'cursor',
        requireNonEmpty(cursor, 'Connector cursor'),
      )
    }
    const payload = await this.requestApiJson(url, {
      method: 'GET',
      credential,
    })
    const items = readJsonPath(payload, binding.itemsPath)
    if (!Array.isArray(items)) {
      throw malformedProviderResponse('Connector collection items must be an array.')
    }
    const nextCursorValue = binding.nextCursorPath
      ? readJsonPath(payload, binding.nextCursorPath)
      : undefined
    return {
      items: items.map((item) => mapExternalRecord(item, resourceType, binding.record)),
      ...(nextCursorValue === undefined || nextCursorValue === null || nextCursorValue === ''
        ? {}
        : { nextCursor: readScalarString(nextCursorValue, 'Connector next cursor') }),
    }
  }

  /** Work Item mutation を provider resource へ反映します。 */
  async push(
    credential: ConnectorCredential,
    mutation: ConnectorOutboundMutation,
  ) {
    const binding = this.requireResourceBinding(mutation.resourceType)
    const path = binding.itemPath.replaceAll(
      '{externalId}',
      encodeURIComponent(requireNonEmpty(mutation.externalId, 'External resource ID')),
    )
    if (path.includes('{externalId}')) {
      throw new ConnectorRuntimeError(
        'ConnectorResourcePathInvalid',
        'Connector item path contains an unresolved external resource ID.',
      )
    }
    const body: Record<string, unknown> = {
      [binding.mutation.originMarker]: requireNonEmpty(
        mutation.originMarker,
        'Connector origin marker',
      ),
    }
    setMappedMutation(body, binding.mutation.title, mutation.title)
    setMappedMutation(body, binding.mutation.description, mutation.description)
    setMappedMutation(body, binding.mutation.status, mutation.status)
    const payload = await this.requestApiJson(resolveApiPath(this.apiBaseUrl, path), {
      method: binding.pushMethod ?? 'PATCH',
      credential,
      body,
      originMarker: mutation.originMarker,
      additionalHeaders: {
        ...(binding.idempotencyHeader
          ? { [binding.idempotencyHeader]: requireNonEmpty(
              mutation.operationId,
              'Connector operation ID',
            ) }
          : {}),
        ...(binding.versionHeader && mutation.expectedExternalVersion
          ? { [binding.versionHeader]: mutation.expectedExternalVersion }
          : {}),
      },
    })
    return mapExternalRecord(payload, mutation.resourceType, binding.record)
  }

  /** OAuth token request を実行します。 */
  private async requestToken(form: URLSearchParams) {
    this.addClientAuthentication(form)
    const response = await this.fetchWithTimeout(this.tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: this.createFormHeaders(),
      body: form,
    })
    if (!response.ok) throw createProviderHttpError(response.status, 'exchange OAuth token')
    return readBoundedJson(response)
  }

  /** Token payload と optional account endpoint から credential を読みます。 */
  private async readCredential(
    tokenPayload: unknown,
    previous?: ConnectorCredential,
    requestedScopes?: readonly string[],
  ): Promise<ConnectorCredential> {
    const accessToken = readRequiredPathString(
      tokenPayload,
      this.tokenMapping.accessToken,
      'Connector access token',
    )
    const refreshToken = this.tokenMapping.refreshToken
      ? readOptionalPathString(tokenPayload, this.tokenMapping.refreshToken)
      : undefined
    const expiresInSeconds = this.tokenMapping.expiresInSeconds
      ? readOptionalPositiveNumber(tokenPayload, this.tokenMapping.expiresInSeconds)
      : undefined
    const scopes = this.tokenMapping.scopes
      ? readScopesValue(readJsonPath(tokenPayload, this.tokenMapping.scopes))
      : previous?.scopes ?? requestedScopes?.slice() ?? this.defaultScopes.slice()
    let accountPayload: unknown = tokenPayload
    let accountMapping: ConnectorOAuthAccountMapping | undefined = this.tokenMapping
      .externalAccountId
      ? {
          externalAccountId: this.tokenMapping.externalAccountId,
          ...(this.tokenMapping.externalAccountName
            ? { externalAccountName: this.tokenMapping.externalAccountName }
            : {}),
        }
      : undefined
    if (this.accountEndpoint) {
      accountPayload = await this.requestApiJson(this.accountEndpoint, {
        method: 'GET',
        credential: {
          accessToken,
          externalAccountId: previous?.externalAccountId ?? 'pending-account-lookup',
          scopes,
        },
      })
      accountMapping = this.accountMapping
    }
    if (!accountMapping) {
      throw malformedProviderResponse('Connector account identity mapping is missing.')
    }
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresInSeconds
        ? { expiresAt: new Date(this.clock().getTime() + expiresInSeconds * 1_000).toISOString() }
        : {}),
      externalAccountId: readRequiredPathString(
        accountPayload,
        accountMapping.externalAccountId,
        'Connector external account ID',
      ),
      ...(accountMapping.externalAccountName
        ? {
            externalAccountName: readOptionalPathString(
              accountPayload,
              accountMapping.externalAccountName,
            ),
          }
        : {}),
      scopes,
    }
  }

  /** Provider API JSON request を実行します。 */
  private async requestApiJson(
    url: URL,
    input: {
      /** HTTP method です。 */
      method: 'GET' | 'PATCH' | 'PUT' | 'POST'
      /** Bearer credential です。 */
      credential: ConnectorCredential
      /** Optional JSON body です。 */
      body?: Record<string, unknown>
      /** Echo-loop guard header です。 */
      originMarker?: string
      /** Configuration で明示された provider-specific headers です。 */
      additionalHeaders?: Readonly<Record<string, string>>
    },
  ) {
    const response = await this.fetchWithTimeout(url, {
      method: input.method,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${requireNonEmpty(
          input.credential.accessToken,
          'Connector access token',
        )}`,
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
        ...(input.originMarker ? { 'X-Mukuroji-Origin': input.originMarker } : {}),
        ...input.additionalHeaders,
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    })
    if (!response.ok) throw createProviderHttpError(response.status, 'request provider resource')
    return readBoundedJson(response)
  }

  /** Provider configuration の allowlist に含まれる scopes だけを許可します。 */
  private validateRequestedScopes(value: readonly string[]) {
    const scopes = validateScopes(value)
    const allowed = new Set(this.defaultScopes)
    if (scopes.some((scope) => !allowed.has(scope))) {
      throw new ConnectorRuntimeError(
        'ConnectorScopesUnsupported',
        'Requested connector scopes are not allowed by provider configuration.',
      )
    }
    return scopes
  }

  /** AbortSignal timeout を強制して provider request を実行します。 */
  private async fetchWithTimeout(input: URL | string, init: RequestInit) {
    try {
      return await this.fetcher(input, {
        ...init,
        signal: AbortSignal.timeout(this.requestTimeoutMilliseconds),
      })
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw new ConnectorRuntimeError(
          'ConnectorProviderTimeout',
          'Connector provider request timed out.',
          { retryable: true },
        )
      }
      throw error
    }
  }

  /** Client authentication を token/revocation form へ付与します。 */
  private addClientAuthentication(form: URLSearchParams) {
    if (this.clientAuthentication === 'body') {
      form.set('client_id', this.clientId)
      form.set('client_secret', this.clientSecret)
    }
  }

  /** Form request の secret-safe headers を作ります。 */
  private createFormHeaders() {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(this.clientAuthentication === 'basic'
        ? {
            Authorization: `Basic ${Buffer.from(
              `${this.clientId}:${this.clientSecret}`,
            ).toString('base64')}`,
          }
        : {}),
    }
  }

  /** Resource type に対応する REST binding を返します。 */
  private requireResourceBinding(resourceType: ExternalResourceType) {
    if (!this.definition.resourceTypes.includes(resourceType)) {
      throw new ConnectorRuntimeError(
        'ConnectorCapabilityUnsupported',
        `Connector does not support ${resourceType} resources.`,
      )
    }
    const binding = this.resources[resourceType]
    if (!binding) {
      throw new ConnectorRuntimeError(
        'ConnectorResourceBindingMissing',
        `Connector ${resourceType} resource binding is not configured.`,
      )
    }
    return binding
  }
}

/** Connector credential を platform secret storage 用 JSON へ直列化します。 */
export function serializeConnectorCredential(credential: ConnectorCredential) {
  return JSON.stringify({
    accessToken: requireNonEmpty(credential.accessToken, 'Connector access token'),
    ...(credential.refreshToken
      ? { refreshToken: requireNonEmpty(credential.refreshToken, 'Connector refresh token') }
      : {}),
    ...(credential.expiresAt
      ? { expiresAt: readIsoTimestamp(credential.expiresAt, 'Connector expiry') }
      : {}),
    externalAccountId: requireNonEmpty(
      credential.externalAccountId,
      'Connector external account ID',
    ),
    ...(credential.externalAccountName
      ? {
          externalAccountName: requireNonEmpty(
            credential.externalAccountName,
            'Connector external account name',
          ),
        }
      : {}),
    scopes: validateScopes(credential.scopes),
  })
}

/** Platform secret storage の JSON credential を厳密に復号します。 */
export function deserializeConnectorCredential(value: string): ConnectorCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(requireNonEmpty(value, 'Stored connector credential'))
  } catch {
    throw new ConnectorRuntimeError(
      'ConnectorCredentialMalformed',
      'Stored connector credential is malformed.',
    )
  }
  if (!isRecord(parsed)) {
    throw new ConnectorRuntimeError(
      'ConnectorCredentialMalformed',
      'Stored connector credential is malformed.',
    )
  }
  return {
    accessToken: readRequiredRecordString(parsed, 'accessToken', 'Connector access token'),
    ...(parsed.refreshToken === undefined
      ? {}
      : {
          refreshToken: readRequiredRecordString(
            parsed,
            'refreshToken',
            'Connector refresh token',
          ),
        }),
    ...(parsed.expiresAt === undefined
      ? {}
      : {
          expiresAt: readIsoTimestamp(
            readRequiredRecordString(parsed, 'expiresAt', 'Connector expiry'),
            'Connector expiry',
          ),
        }),
    externalAccountId: readRequiredRecordString(
      parsed,
      'externalAccountId',
      'Connector external account ID',
    ),
    ...(parsed.externalAccountName === undefined
      ? {}
      : {
          externalAccountName: readRequiredRecordString(
            parsed,
            'externalAccountName',
            'Connector external account name',
          ),
        }),
    scopes: readScopesValue(parsed.scopes),
  }
}

/** Unknown adapter が OAuth authorization extension を実装するか判定します。 */
export function isConnectorOAuthAdapter(
  adapter: ConnectorAdapter,
): adapter is ConnectorOAuthAdapter {
  return typeof (adapter as Partial<ConnectorOAuthAdapter>).createAuthorizationUrl ===
      'function' &&
    typeof (adapter as Partial<ConnectorOAuthAdapter>).redirectUri === 'string'
}

/** Configured adapters を既存の category-safe registry へ登録します。 */
export function createConfiguredOAuthConnectorRegistry(
  options: readonly ConfiguredOAuthConnectorOptions[],
) {
  return new ConnectorRegistry(options.map((entry) =>
    new ConfiguredOAuthConnectorAdapter(entry)
  ))
}

function validateDefinition(definition: ConnectorDefinition) {
  const catalog = BUILT_IN_CONNECTOR_CATALOG.find((entry) => entry.id === definition.id)
  if (
    !catalog ||
    catalog.category !== definition.category ||
    catalog.name !== definition.name ||
    catalog.usesOAuthPkce !== definition.usesOAuthPkce ||
    catalog.resourceTypes.some((resourceType) =>
      !definition.resourceTypes.includes(resourceType)
    )
  ) {
    throw new ConnectorAdapterError(
      'ConnectorAdapterDefinitionMismatch',
      'Connector adapter definition does not match the built-in catalog.',
    )
  }
  return definition
}

function validateHttpsEndpoint(value: string, allowedHosts: readonly string[], label: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConnectorRuntimeError('ConnectorEndpointInvalid', `${label} must be a valid URL.`)
  }
  const hosts = new Set(allowedHosts.map((host) => host.trim().toLowerCase()))
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !hosts.has(url.hostname.toLowerCase())
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorEndpointInvalid',
      `${label} must use HTTPS and an explicitly allowed host.`,
    )
  }
  return url
}

function validateFixedParameters(value: Readonly<Record<string, string>>) {
  const result: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    const safeName = requireParameterName(name, 'OAuth authorization parameter')
    if (
      [
        'client_id',
        'code_challenge',
        'code_challenge_method',
        'redirect_uri',
        'response_type',
        'scope',
        'state',
      ].includes(safeName)
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorAuthorizationParameterReserved',
        `OAuth authorization parameter "${safeName}" is managed by the runtime.`,
      )
    }
    result[safeName] = requireNonEmpty(entry, 'OAuth authorization parameter value')
  }
  return result
}

function validateTokenMapping(value: ConnectorOAuthTokenMapping) {
  requireJsonPath(value.accessToken, 'Access token path')
  if (value.refreshToken) requireJsonPath(value.refreshToken, 'Refresh token path')
  if (value.expiresInSeconds) requireJsonPath(value.expiresInSeconds, 'Token expiry path')
  if (value.scopes) requireJsonPath(value.scopes, 'Token scope path')
  if (value.externalAccountId) requireJsonPath(value.externalAccountId, 'Account ID path')
  if (value.externalAccountName) requireJsonPath(value.externalAccountName, 'Account name path')
  return value
}

function validateResourceBindings(
  value: Partial<Record<ExternalResourceType, ConnectorOAuthResourceBinding>>,
) {
  for (const [resourceType, binding] of Object.entries(value)) {
    if (!binding) continue
    validateRelativeApiPath(binding.collectionPath, `${resourceType} collection path`)
    validateRelativeApiPath(binding.itemPath, `${resourceType} item path`)
    if (!binding.itemPath.includes('{externalId}')) {
      throw new ConnectorRuntimeError(
        'ConnectorResourcePathInvalid',
        `${resourceType} item path must contain {externalId}.`,
      )
    }
    requireJsonPath(binding.itemsPath, `${resourceType} item array path`)
    if (binding.nextCursorPath) {
      requireJsonPath(binding.nextCursorPath, `${resourceType} next cursor path`)
    }
    if (binding.cursorParameter) {
      requireParameterName(binding.cursorParameter, `${resourceType} cursor parameter`)
    }
    if (binding.idempotencyHeader) {
      requireProviderHeaderName(
        binding.idempotencyHeader,
        `${resourceType} idempotency header`,
      )
    }
    if (binding.versionHeader) {
      requireProviderHeaderName(binding.versionHeader, `${resourceType} version header`)
    }
    validateRecordMapping(binding.record, resourceType)
    validateMutationMapping(binding.mutation, resourceType)
  }
  return value
}

function validateRecordMapping(
  value: ConnectorExternalRecordMapping,
  resourceType: string,
) {
  for (const [field, path] of Object.entries(value)) {
    if (field === 'metadata') {
      if (!Array.isArray(path)) {
        throw new ConnectorRuntimeError(
          'ConnectorRecordMappingInvalid',
          `${resourceType} metadata mapping must be an array.`,
        )
      }
      if (path.length > 32) {
        throw new ConnectorRuntimeError(
          'ConnectorRecordMappingInvalid',
          `${resourceType} metadata mapping exceeds 32 fields.`,
        )
      }
      for (const metadataPath of path) {
        requireJsonPath(metadataPath, `${resourceType} metadata path`)
      }
    } else {
      requireJsonPath(path as string, `${resourceType} ${field} path`)
    }
  }
}

function validateMutationMapping(
  value: ConnectorOutboundMutationMapping,
  resourceType: string,
) {
  requireBodyFieldName(value.originMarker, `${resourceType} origin marker field`)
  if (value.title) requireBodyFieldName(value.title, `${resourceType} title field`)
  if (value.description) {
    requireBodyFieldName(value.description, `${resourceType} description field`)
  }
  if (value.status) requireBodyFieldName(value.status, `${resourceType} status field`)
}

function validateRelativeApiPath(value: string, label: string) {
  const path = requireNonEmpty(value, label)
  if (
    path.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(path) ||
    path.includes('\\')
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorResourcePathInvalid',
      `${label} must be relative to the configured API base URL.`,
    )
  }
}

function resolveApiPath(baseUrl: URL, path: string) {
  validateRelativeApiPath(path, 'Connector API path')
  const resolved = new URL(path, baseUrl)
  if (resolved.origin !== baseUrl.origin) {
    throw new ConnectorRuntimeError(
      'ConnectorResourcePathInvalid',
      'Connector API path escaped the configured API origin.',
    )
  }
  return resolved
}

async function readBoundedJson(response: Response) {
  const contentLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
    throw malformedProviderResponse('Connector provider response is too large.')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
    throw malformedProviderResponse('Connector provider response is too large.')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw malformedProviderResponse('Connector provider returned malformed JSON.')
  }
}

function createProviderHttpError(status: number, operation: string) {
  const authorizationRequired = status === 401 || status === 403
  return new ConnectorRuntimeError(
    authorizationRequired
      ? 'ConnectorAuthorizationRequired'
      : 'ConnectorProviderUnavailable',
    authorizationRequired
      ? `Connector provider authorization is required to ${operation}.`
      : `Connector provider could not ${operation}.`,
    {
      authorizationRequired,
      retryable: status === 408 || status === 429 || status >= 500,
      providerStatus: status,
    },
  )
}

function malformedProviderResponse(message: string) {
  return new ConnectorRuntimeError('ConnectorProviderResponseMalformed', message)
}

function mapExternalRecord(
  value: unknown,
  resourceType: ExternalResourceType,
  mapping: ConnectorExternalRecordMapping,
): ConnectorExternalRecord {
  if (!isRecord(value)) {
    throw malformedProviderResponse('Connector provider resource must be an object.')
  }
  const metadata: Record<string, unknown> = {}
  for (const path of mapping.metadata ?? []) {
    const metadataValue = readJsonPath(value, path)
    if (metadataValue !== undefined) {
      metadata[path] = readBoundedMetadataScalar(metadataValue, path)
    }
  }
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 16 * 1024) {
    throw malformedProviderResponse('Connector metadata exceeds the safe storage limit.')
  }
  return {
    externalId: readRequiredPathString(value, mapping.externalId, 'External resource ID'),
    resourceType,
    externalUrl: readHttpsValue(
      readRequiredPathString(value, mapping.externalUrl, 'External resource URL'),
    ),
    externalVersion: readRequiredPathString(
      value,
      mapping.externalVersion,
      'External resource version',
    ),
    ...(mapping.displayKey
      ? {
          displayKey: readOptionalPathString(value, mapping.displayKey),
        }
      : {}),
    ...(mapping.title ? { title: readOptionalPathString(value, mapping.title) } : {}),
    ...(mapping.description
      ? { description: readOptionalPathString(value, mapping.description) }
      : {}),
    ...(mapping.status ? { status: readOptionalPathString(value, mapping.status) } : {}),
    metadata,
    ...(mapping.originMarker
      ? { originMarker: readOptionalPathString(value, mapping.originMarker) }
      : {}),
  }
}

function setMappedMutation(
  body: Record<string, unknown>,
  field: string | undefined,
  value: string | undefined,
) {
  if (!field || value === undefined) return
  body[field] = value
}

function readJsonPath(value: unknown, path: ConnectorJsonPath): unknown {
  const segments = requireJsonPath(path, 'Connector JSON path').split('.')
  let current = value
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function readRequiredPathString(value: unknown, path: string, label: string) {
  const result = readOptionalPathString(value, path)
  if (!result) throw malformedProviderResponse(`${label} is missing.`)
  return result
}

function readOptionalPathString(value: unknown, path: string) {
  const result = readJsonPath(value, path)
  if (result === undefined || result === null || result === '') return undefined
  return readScalarString(result, path)
}

function readOptionalPositiveNumber(value: unknown, path: string) {
  const result = readJsonPath(value, path)
  if (result === undefined || result === null || result === '') return undefined
  const numeric = typeof result === 'number' ? result : Number(result)
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > 365 * 24 * 60 * 60) {
    throw malformedProviderResponse('Connector token expiry is invalid.')
  }
  return numeric
}

function readScalarString(value: unknown, label: string) {
  if (typeof value === 'string') return requireNonEmpty(value, label)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw malformedProviderResponse(`${label} must be a string or number.`)
}

function readBoundedMetadataScalar(value: unknown, label: string) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 1_024 || value.includes('\0')) {
      throw malformedProviderResponse(`${label} metadata value is too large.`)
    }
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean' || value === null) return value
  throw malformedProviderResponse(`${label} metadata value must be scalar.`)
}

function readScopesValue(value: unknown): string[] {
  if (typeof value === 'string') {
    return validateScopes(value.split(/[ ,]+/u).filter(Boolean))
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return validateScopes(value)
  }
  throw malformedProviderResponse('Connector token scopes are malformed.')
}

function validateScopes(value: readonly string[]) {
  const scopes = value.map((scope) => requireNonEmpty(scope, 'Connector scope'))
  if (
    scopes.length > 100 ||
    scopes.some((scope) => scope.length > 256 || hasControlCharacters(scope))
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorScopesInvalid',
      'Connector scopes are invalid.',
    )
  }
  return [...new Set(scopes)].sort()
}

function requireJsonPath(value: string, label: string) {
  const path = requireNonEmpty(value, label)
  if (
    path.length > 512 ||
    !path.split('.').every((segment) => /^[A-Za-z0-9_-]+$/u.test(segment)) ||
    ['__proto__', 'constructor', 'prototype'].some((segment) =>
      path.split('.').includes(segment)
    )
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorJsonPathInvalid',
      `${label} is invalid.`,
    )
  }
  return path
}

function requireBodyFieldName(value: string, label: string) {
  const field = requireNonEmpty(value, label)
  if (
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(field) ||
    ['__proto__', 'constructor', 'prototype'].includes(field)
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorMutationMappingInvalid',
      `${label} is invalid.`,
    )
  }
  return field
}

function requireParameterName(value: string, label: string) {
  const name = requireNonEmpty(value, label)
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(name)) {
    throw new ConnectorRuntimeError(
      'ConnectorParameterInvalid',
      `${label} is invalid.`,
    )
  }
  return name
}

function requireProviderHeaderName(value: string, label: string) {
  const name = requireNonEmpty(value, label)
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(name) ||
    ['authorization', 'cookie', 'host', 'content-length', 'content-type']
      .includes(name.toLowerCase())
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorHeaderInvalid',
      `${label} is invalid.`,
    )
  }
  return name
}

function requireNonEmpty(value: string, label: string) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 8_192 ||
    value.includes('\0')
  ) {
    throw new ConnectorRuntimeError('ConnectorValueInvalid', `${label} is invalid.`)
  }
  return value
}

function readHttpsValue(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw malformedProviderResponse('External resource URL is invalid.')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw malformedProviderResponse('External resource URL must use HTTPS.')
  }
  return url.toString()
}

function readIsoTimestamp(value: string, label: string) {
  const timestamp = requireNonEmpty(value, label)
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new ConnectorRuntimeError('ConnectorTimestampInvalid', `${label} is invalid.`)
  }
  return new Date(timestamp).toISOString()
}

function readRequiredRecordString(
  value: Record<string, unknown>,
  field: string,
  label: string,
) {
  const entry = value[field]
  if (typeof entry !== 'string') {
    throw new ConnectorRuntimeError(
      'ConnectorCredentialMalformed',
      `${label} is malformed.`,
    )
  }
  return requireNonEmpty(entry, label)
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

/** Environment JSON に指定できる provider configuration です。 */
export type ConnectorOAuthEnvironmentEntry = Omit<
  ConfiguredOAuthConnectorOptions,
  'clientSecret' | 'definition' | 'fetch' | 'clock'
> & {
  /** Built-in provider ID です。 */
  provider: ConnectorProviderId
  /** Client secret を保持する別 environment variable 名です。 */
  clientSecretEnvironmentVariable: string
}

/** Environment から OAuth provider registry を構築する入力です。 */
export type ConnectorOAuthEnvironmentFactoryOptions = {
  /** `MUKUROJI_CONNECTOR_PROVIDERS_JSON` 等を含む environment です。 */
  environment: Readonly<Record<string, string | undefined>>
  /** Provider configuration JSON を保持する environment variable 名です。 */
  configurationVariable?: string
  /** Test または egress 制御付き runtime が注入する fetch です。 */
  fetch?: typeof fetch
  /** Token expiry 計算に使う clock です。 */
  clock?: () => Date
}

/** Environment 設定から category-safe OAuth connector registry を作成します。 */
export function createOAuthConnectorRegistryFromEnvironment(
  options: ConnectorOAuthEnvironmentFactoryOptions,
) {
  const variable = options.configurationVariable ??
    'MUKUROJI_CONNECTOR_PROVIDERS_JSON'
  const encoded = options.environment[variable]
  if (!encoded) return new ConnectorRegistry()
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    throw new ConnectorRuntimeError(
      'ConnectorEnvironmentConfigurationInvalid',
      `${variable} must contain valid JSON.`,
    )
  }
  if (!Array.isArray(parsed)) {
    throw new ConnectorRuntimeError(
      'ConnectorEnvironmentConfigurationInvalid',
      `${variable} must contain a provider array.`,
    )
  }
  const adapters = parsed.map((value) => {
    const entry = readEnvironmentEntry(value)
    const secret = options.environment[entry.clientSecretEnvironmentVariable]
    if (!secret) {
      throw new ConnectorRuntimeError(
        'ConnectorClientSecretMissing',
        `Connector client secret environment variable is not configured for ${entry.provider}.`,
      )
    }
    const definition = BUILT_IN_CONNECTOR_CATALOG.find(
      (candidate) => candidate.id === entry.provider,
    )
    if (!definition) {
      throw new ConnectorRuntimeError(
        'ConnectorProviderUnsupported',
        'Connector provider is not supported by this runtime.',
      )
    }
    return new ConfiguredOAuthConnectorAdapter({
      ...entry,
      definition,
      clientSecret: secret,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    })
  })
  return new ConnectorRegistry(adapters)
}

function readEnvironmentEntry(value: unknown): ConnectorOAuthEnvironmentEntry {
  if (!isRecord(value)) {
    throw new ConnectorRuntimeError(
      'ConnectorEnvironmentConfigurationInvalid',
      'Connector provider configuration must be an object.',
    )
  }
  const provider = readRequiredRecordString(value, 'provider', 'Connector provider')
  if (!BUILT_IN_CONNECTOR_CATALOG.some((entry) => entry.id === provider)) {
    throw new ConnectorRuntimeError(
      'ConnectorProviderUnsupported',
      'Connector provider is not supported by this runtime.',
    )
  }
  const copy = structuredClone(value) as Record<string, unknown>
  delete copy.definition
  delete copy.fetch
  delete copy.clock
  return {
    ...(copy as Omit<ConnectorOAuthEnvironmentEntry, 'provider'>),
    provider: provider as ConnectorProviderId,
  }
}

/** OAuth PKCE S256 challenge を code verifier から作ります。 */
export function createConnectorPkceChallenge(codeVerifier: string) {
  return createHash('sha256')
    .update(requireNonEmpty(codeVerifier, 'OAuth PKCE code verifier'))
    .digest('base64url')
}
