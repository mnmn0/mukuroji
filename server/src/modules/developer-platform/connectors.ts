import { createHmac, timingSafeEqual } from 'node:crypto'

/** Connector が接続する外部 service category です。 */
export type ConnectorCategory =
  | 'source-control'
  | 'chat'
  | 'email'
  | 'calendar'
  | 'cloud-storage'

/** Built-in connector provider ID です。 */
export type ConnectorProviderId =
  | 'github'
  | 'gitlab'
  | 'slack'
  | 'microsoft-teams'
  | 'gmail'
  | 'outlook'
  | 'google-calendar'
  | 'outlook-calendar'
  | 'google-drive'
  | 'onedrive'
  | 'dropbox'

/** External system と同期できる resource type です。 */
export type ExternalResourceType =
  | 'issue'
  | 'merge-request'
  | 'commit'
  | 'deploy'
  | 'message'
  | 'email'
  | 'calendar-event'
  | 'file'

/** Connector catalog の provider metadata です。 */
export type ConnectorDefinition = {
  /** Stable provider ID です。 */
  id: ConnectorProviderId
  /** Provider の category です。 */
  category: ConnectorCategory
  /** UI に表示する provider 名です。 */
  name: string
  /** OAuth authorization code + PKCE を利用する場合は true です。 */
  usesOAuthPkce: boolean
  /** Provider が inbound/outbound sync できる resources です。 */
  resourceTypes: ExternalResourceType[]
}

/** Connector authorization callback の provider-neutral input です。 */
export type ConnectorAuthorizationInput = {
  /** OAuth authorization code です。 */
  code: string
  /** CSRF 防止の signed OAuth state です。 */
  state: string
  /** PKCE code verifier です。 */
  codeVerifier: string
  /** Allowlist 済み callback URL です。 */
  redirectUri: string
  /** Authorization URL で要求した provider scopes です。 */
  requestedScopes: readonly string[]
}

/** 暗号化前に短時間だけ扱う provider credential です。 */
export type ConnectorCredential = {
  /** Provider access token です。 */
  accessToken: string
  /** Long-lived refresh token です。 */
  refreshToken?: string
  /** Credential の失効日時です。 */
  expiresAt?: string
  /** Provider account ID です。 */
  externalAccountId: string
  /** Provider account の表示名です。 */
  externalAccountName?: string
  /** Provider が付与した scopes です。 */
  scopes: string[]
}

/** Connector から Work Item へ取り込む normalized external record です。 */
export type ConnectorExternalRecord = {
  /** Provider 内で一意な resource ID です。 */
  externalId: string
  /** Resource の種別です。 */
  resourceType: ExternalResourceType
  /** Provider UI の canonical URL です。 */
  externalUrl: string
  /** UI に表示する issue number 等の短い key です。 */
  displayKey?: string
  /** Provider が採番する monotonic version または updated timestamp です。 */
  externalVersion: string
  /** Work Item title へ mapping できる summary です。 */
  title?: string
  /** Work Item description へ mapping できる body です。 */
  description?: string
  /** Provider status の normalized value です。 */
  status?: string
  /** Provider payload の non-secret metadata です。 */
  metadata: Record<string, unknown>
  /** mukuroji が送信した更新を識別する loop guard です。 */
  originMarker?: string
}

/** Work Item から provider へ送る normalized mutation です。 */
export type ConnectorOutboundMutation = {
  /** Link 先の external resource ID です。 */
  externalId: string
  /** Resource の種別です。 */
  resourceType: ExternalResourceType
  /** Work Item の現在 revision です。 */
  workItemRevision: number
  /** Provider へ反映する title です。 */
  title?: string
  /** Provider へ反映する description です。 */
  description?: string
  /** Provider へ反映する normalized status です。 */
  status?: string
  /** Echo webhook を識別する loop guard です。 */
  originMarker: string
  /** Provider retry に渡す stable idempotency operation ID です。 */
  operationId: string
  /** Provider conditional write に使う直前 external version です。 */
  expectedExternalVersion?: string
}

/** Provider page の normalized cursor response です。 */
export type ConnectorPage<T> = {
  /** Permission-filtered page items です。 */
  items: T[]
  /** Provider が返した opaque cursor です。 */
  nextCursor?: string
}

/** Connector provider adapter の共通 boundary です。 */
export interface ConnectorAdapter {
  /** Adapter が実装する provider metadata です。 */
  readonly definition: ConnectorDefinition
  /** OAuth callback を credential へ交換します。 */
  connect(input: ConnectorAuthorizationInput): Promise<ConnectorCredential>
  /** Expiring credential を refresh します。 */
  refresh(credential: ConnectorCredential): Promise<ConnectorCredential>
  /** Provider 側 credential/grant を revoke します。 */
  disconnect(credential: ConnectorCredential): Promise<void>
  /** Provider resources を cursor page で読み取ります。 */
  pull(
    credential: ConnectorCredential,
    resourceType: ExternalResourceType,
    cursor?: string,
  ): Promise<ConnectorPage<ConnectorExternalRecord>>
  /** Work Item mutation を provider resource へ反映します。 */
  push(
    credential: ConnectorCredential,
    mutation: ConnectorOutboundMutation,
  ): Promise<ConnectorExternalRecord>
}

/** Inbound sync の重複・順序・競合判定に必要な state です。 */
export type ConnectorSyncState = {
  /** Link の installation ID です。 */
  installationId: string
  /** Link の安定した ID です。 */
  linkId: string
  /** Work Item の現在 revision です。 */
  workItemRevision: number
  /** 最後に同期した external version です。 */
  lastExternalVersion?: string
  /** 最後に処理した provider event ID です。 */
  lastExternalEventId?: string
}

/** Inbound sync を適用するかどうかの決定です。 */
export type ConnectorSyncDecision =
  | { /** Decision 種別です。 */ kind: 'apply' }
  | { /** Decision 種別です。 */ kind: 'duplicate'; /** Skip 理由です。 */ reason: string }
  | { /** Decision 種別です。 */ kind: 'self-origin'; /** Skip 理由です。 */ reason: string }
  | { /** Decision 種別です。 */ kind: 'stale'; /** Skip 理由です。 */ reason: string }
  | {
    /** Decision 種別です。 */
    kind: 'conflict'
    /** User が解消する競合理由です。 */
    reason: string
    /** Link 読み込み時点の Work Item revision です。 */
    expectedWorkItemRevision: number
    /** 現在の Work Item revision です。 */
    actualWorkItemRevision: number
  }

/** Adapter が未登録の場合に返す stable error です。 */
export class ConnectorAdapterError extends Error {
  /** Stable error code です。 */
  readonly code: string

  /** Connector adapter error を作成します。 */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ConnectorAdapterError'
    this.code = code
  }
}

/** Source control/chat/email/calendar/storage の built-in catalog です。 */
export const BUILT_IN_CONNECTOR_CATALOG: readonly ConnectorDefinition[] = [
  {
    id: 'github',
    category: 'source-control',
    name: 'GitHub',
    usesOAuthPkce: true,
    resourceTypes: ['issue', 'merge-request', 'commit', 'deploy'],
  },
  {
    id: 'gitlab',
    category: 'source-control',
    name: 'GitLab',
    usesOAuthPkce: true,
    resourceTypes: ['issue', 'merge-request', 'commit', 'deploy'],
  },
  {
    id: 'slack',
    category: 'chat',
    name: 'Slack',
    usesOAuthPkce: true,
    resourceTypes: ['message'],
  },
  {
    id: 'microsoft-teams',
    category: 'chat',
    name: 'Microsoft Teams',
    usesOAuthPkce: true,
    resourceTypes: ['message'],
  },
  {
    id: 'gmail',
    category: 'email',
    name: 'Gmail',
    usesOAuthPkce: true,
    resourceTypes: ['email'],
  },
  {
    id: 'outlook',
    category: 'email',
    name: 'Outlook',
    usesOAuthPkce: true,
    resourceTypes: ['email'],
  },
  {
    id: 'google-calendar',
    category: 'calendar',
    name: 'Google Calendar',
    usesOAuthPkce: true,
    resourceTypes: ['calendar-event'],
  },
  {
    id: 'outlook-calendar',
    category: 'calendar',
    name: 'Outlook Calendar',
    usesOAuthPkce: true,
    resourceTypes: ['calendar-event'],
  },
  {
    id: 'google-drive',
    category: 'cloud-storage',
    name: 'Google Drive',
    usesOAuthPkce: true,
    resourceTypes: ['file'],
  },
  {
    id: 'onedrive',
    category: 'cloud-storage',
    name: 'OneDrive',
    usesOAuthPkce: true,
    resourceTypes: ['file'],
  },
  {
    id: 'dropbox',
    category: 'cloud-storage',
    name: 'Dropbox',
    usesOAuthPkce: true,
    resourceTypes: ['file'],
  },
] as const

/**
 * Provider definition が built-in catalog の capability contract と完全一致することを検証します。
 *
 * @param definition 検証する adapter definition です。
 * @returns 検証済み definition です。
 */
export function validateConnectorDefinition(
  definition: ConnectorDefinition,
): ConnectorDefinition {
  const catalog = BUILT_IN_CONNECTOR_CATALOG.find(
    (entry) => entry.id === definition.id,
  )
  const resourceTypes = definition.resourceTypes
  const uniqueResourceTypes = new Set(resourceTypes)
  if (
    !catalog ||
    catalog.category !== definition.category ||
    catalog.name !== definition.name ||
    catalog.usesOAuthPkce !== definition.usesOAuthPkce ||
    uniqueResourceTypes.size !== resourceTypes.length ||
    resourceTypes.some((resourceType) =>
      !catalog.resourceTypes.includes(resourceType)
    ) ||
    catalog.resourceTypes.some((resourceType) =>
      !uniqueResourceTypes.has(resourceType)
    )
  ) {
    throw new ConnectorAdapterError(
      'ConnectorAdapterDefinitionMismatch',
      'Connector adapter definition does not match the built-in catalog.',
    )
  }
  return definition
}

/** Provider adapters を category-safe に解決する registry です。 */
export class ConnectorRegistry {
  /** Provider ID ごとの adapter です。 */
  private readonly adapters = new Map<ConnectorProviderId, ConnectorAdapter>()

  /** Adapter 一覧を重複なく登録します。 */
  constructor(adapters: readonly ConnectorAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  /** Provider adapter を登録します。 */
  register(adapter: ConnectorAdapter) {
    if (this.adapters.has(adapter.definition.id)) {
      throw new ConnectorAdapterError(
        'ConnectorAdapterDuplicate',
        `Connector adapter "${adapter.definition.id}" is already registered.`,
      )
    }
    validateConnectorDefinition(adapter.definition)
    this.adapters.set(adapter.definition.id, adapter)
  }

  /** Provider ID に対応する adapter を返します。 */
  get(provider: ConnectorProviderId) {
    const adapter = this.adapters.get(provider)
    if (!adapter) {
      throw new ConnectorAdapterError(
        'ConnectorAdapterUnavailable',
        `Connector adapter "${provider}" is not configured.`,
      )
    }
    return adapter
  }
}

/** Installation/link/revision を束縛した echo-loop guard を作成します。 */
export function createConnectorOriginMarker(
  installationId: string,
  linkId: string,
  workItemRevision: number,
  operationId: string,
  signingSecret: string,
) {
  const payload = Buffer.from(JSON.stringify({
    installationId: requireMarkerText(installationId),
    linkId: requireMarkerText(linkId),
    workItemRevision: requireMarkerRevision(workItemRevision),
    operationId: requireMarkerText(operationId),
  })).toString('base64url')
  const signature = createHmac('sha256', readOriginSigningSecret(signingSecret))
    .update(`v1.${payload}`)
    .digest('base64url')
  return `v1.${payload}.${signature}`
}

/** Inbound event を duplicate/out-of-order/self-origin/revision conflict として判定します。 */
export function decideConnectorInboundSync(input: {
  /** 保存済み link sync state です。 */
  state: ConnectorSyncState
  /** Provider webhook event ID です。 */
  eventId: string
  /** Provider resource version です。 */
  externalVersion: string
  /** Event に含まれた origin marker です。 */
  originMarker?: string
  /** 直前の outbound operation で送信した未消費 marker です。 */
  expectedOriginMarker?: string
  /** Link 読み込み後に取得した現在 Work Item revision です。 */
  actualWorkItemRevision: number
  /** Origin marker を認証する HMAC secret です。 */
  originSigningSecret: string
  /** Rotation grace period 中に検証だけ許可する旧 HMAC secrets です。 */
  previousOriginSigningSecrets?: readonly string[]
}): ConnectorSyncDecision {
  if (input.eventId === input.state.lastExternalEventId) {
    return { kind: 'duplicate', reason: 'External event was already processed.' }
  }
  if (
    input.originMarker &&
    input.originMarker === input.expectedOriginMarker &&
    input.externalVersion === input.state.lastExternalVersion &&
    isAuthenticConnectorOriginMarker(
      input.originMarker,
      input.state,
      [
        input.originSigningSecret,
        ...(input.previousOriginSigningSecrets ?? []),
      ],
    )
  ) {
    return { kind: 'self-origin', reason: 'Event echoes a mukuroji outbound mutation.' }
  }
  if (
    input.state.lastExternalVersion &&
    compareExternalVersions(input.externalVersion, input.state.lastExternalVersion) <= 0
  ) {
    return { kind: 'stale', reason: 'External resource version is not newer than the synced version.' }
  }
  if (input.actualWorkItemRevision !== input.state.workItemRevision) {
    return {
      kind: 'conflict',
      reason: 'Work Item changed after the connector link was read.',
      expectedWorkItemRevision: input.state.workItemRevision,
      actualWorkItemRevision: input.actualWorkItemRevision,
    }
  }
  return { kind: 'apply' }
}

function isAuthenticConnectorOriginMarker(
  marker: string,
  state: ConnectorSyncState,
  signingSecrets: readonly string[],
) {
  const [version, payload, signature, extra] = marker.split('.')
  if (version !== 'v1' || !payload || !signature || extra !== undefined) return false
  let actual: Buffer
  try {
    actual = Buffer.from(signature, 'base64url')
  } catch {
    return false
  }
  const authentic = signingSecrets.some((signingSecret) => {
    const expected = createHmac(
      'sha256',
      readOriginSigningSecret(signingSecret),
    )
      .update(`v1.${payload}`)
      .digest()
    return actual.byteLength === expected.byteLength &&
      timingSafeEqual(actual, expected)
  })
  if (!authentic) {
    return false
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    return isRecord(parsed) &&
      parsed.installationId === state.installationId &&
      parsed.linkId === state.linkId &&
      parsed.workItemRevision === state.workItemRevision &&
      typeof parsed.operationId === 'string' &&
      parsed.operationId.length > 0
  } catch {
    return false
  }
}

function readOriginSigningSecret(value: string) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) {
    throw new ConnectorAdapterError(
      'ConnectorOriginSigningSecretInvalid',
      'Connector origin signing secret must contain at least 32 bytes.',
    )
  }
  return value
}

function requireMarkerText(value: string) {
  if (!value || value.length > 512 || value.includes('\0')) {
    throw new ConnectorAdapterError(
      'ConnectorOriginMarkerInvalid',
      'Connector origin marker input is invalid.',
    )
  }
  return value
}

function requireMarkerRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConnectorAdapterError(
      'ConnectorOriginMarkerInvalid',
      'Connector origin marker revision is invalid.',
    )
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareExternalVersions(left: string, right: string) {
  if (/^[+-]?\d+$/u.test(left) && /^[+-]?\d+$/u.test(right)) {
    const leftInteger = BigInt(left)
    const rightInteger = BigInt(right)
    return leftInteger === rightInteger ? 0 : leftInteger > rightInteger ? 1 : -1
  }
  return left.localeCompare(right)
}
