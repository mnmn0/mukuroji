import { randomUUID } from 'node:crypto'
import type {
  ConnectorAuthorizationOutput,
  ConnectorInstallation,
  CreateConnectorInstallationInput,
  ResolveWorkItemSyncConflictInput,
  WorkItemSyncConflict,
} from '@mukuroji/contracts'
import {
  DeveloperPlatformError,
  type DeveloperPlatformClient,
} from './developer-platform'
import type {
  ConnectorAuthorizationService,
  DeveloperManagementPrincipal,
} from './public-api'
import {
  BUILT_IN_CONNECTOR_CATALOG,
  ConnectorRegistry,
  type ConnectorProviderId,
} from './connectors'
import {
  ConnectorRuntimeError,
  deserializeConnectorCredential,
  isConnectorOAuthAdapter,
  serializeConnectorCredential,
} from './connector-oauth'
import {
  ConnectorOAuthStateManager,
  type ConnectorOAuthFlow,
} from './connector-oauth-state'
import type {
  ConnectorConflictActor,
  ConnectorSyncConflictPage,
  ConnectorSyncEngine,
  ConnectorSyncHealthReporter,
} from './connector-sync-runtime'

/** OAuth callback を current Workspace membership/RBAC で再検証する boundary です。 */
export interface ConnectorOAuthCallbackAuthorizer {
  /** Flow actor が今も connector を管理できることを検証します。 */
  authorize(
    workspaceId: string,
    userId: string,
  ): Promise<void>
}

/** OAuth provider callback handler の入力です。 */
export type CompleteConnectorOAuthCallbackInput = {
  /** Provider が返した authorization code です。 */
  code: string
  /** Provider がそのまま返した signed state token です。 */
  state: string
}

/** OAuth provider callback handler の secret-free result です。 */
export type CompleteConnectorOAuthCallbackResult = {
  /** 作成または復旧した connector installation です。 */
  installation: ConnectorInstallation
  /** Callback 後に UI へ戻す application-relative URL です。 */
  returnUrl: string
}

/** Authorization service が利用する sync-conflict runtime boundary です。 */
export interface ConnectorConflictRuntime {
  /** Workspace 内の permission-filtered conflict page を返します。 */
  listConflicts(
    workspaceId: string,
    input: {
      /** Optional conflict status filter です。 */
      status?: WorkItemSyncConflict['status']
      /** Durable store cursor です。 */
      cursor?: string
      /** Page size です。 */
      limit: number
    },
  ): Promise<ConnectorSyncConflictPage>
  /** Conflict 配下 Work Item の current viewer access を判定します。 */
  canAccessConflict(
    actor: ConnectorConflictActor,
    conflictId: string,
  ): Promise<boolean>
  /** Current actor RBAC を再評価して conflict を解決します。 */
  resolveConflict(
    actor: ConnectorConflictActor,
    conflictId: string,
    input: ResolveWorkItemSyncConflictInput,
  ): Promise<WorkItemSyncConflict>
}

/** Connector authorization runtime の構築 dependencies です。 */
export type ConnectorAuthorizationRuntimeOptions = {
  /** Connector installation と encrypted credential store です。 */
  platform: DeveloperPlatformClient
  /** Configured OAuth provider registry です。 */
  registry: ConnectorRegistry
  /** Encrypted, signed, single-use OAuth state manager です。 */
  state: ConnectorOAuthStateManager
  /** Callback 時の current membership/RBAC authorizer です。 */
  callbackAuthorizer: ConnectorOAuthCallbackAuthorizer
  /** Durable sync conflict runtime です。 */
  conflicts: ConnectorConflictRuntime
  /** Worker が作る reauthorization flow の戻り先です。 */
  reauthorizationReturnUrl?: string
}

/** OAuth lifecycle、disconnect、reauth、conflict recovery を実装します。 */
export class ConnectorAuthorizationRuntime
  implements ConnectorAuthorizationService, ConnectorSyncHealthReporter {
  /** Connector installation と encrypted credential store です。 */
  private readonly platform: DeveloperPlatformClient
  /** Configured provider adapter registry です。 */
  private readonly registry: ConnectorRegistry
  /** Signed single-use OAuth state manager です。 */
  private readonly state: ConnectorOAuthStateManager
  /** Callback current membership/RBAC authorizer です。 */
  private readonly callbackAuthorizer: ConnectorOAuthCallbackAuthorizer
  /** Durable conflict runtime です。 */
  private readonly conflicts: ConnectorConflictRuntime
  /** Worker-initiated reauthorization flow の UI return URL です。 */
  private readonly reauthorizationReturnUrl: string

  /** Production-wiring-ready connector authorization runtime を作成します。 */
  constructor(options: ConnectorAuthorizationRuntimeOptions) {
    this.platform = options.platform
    this.registry = options.registry
    this.state = options.state
    this.callbackAuthorizer = options.callbackAuthorizer
    this.conflicts = options.conflicts
    this.reauthorizationReturnUrl = options.reauthorizationReturnUrl ??
      '/settings?developerSection=connectors'
    validateApplicationReturnUrl(this.reauthorizationReturnUrl)
  }

  /** New connector OAuth authorization flow を開始します。 */
  async begin(
    principal: DeveloperManagementPrincipal,
    input: CreateConnectorInstallationInput,
    operationId?: string,
  ): Promise<ConnectorAuthorizationOutput> {
    const provider = readSupportedProvider(input.provider)
    const adapter = this.requireOAuthAdapter(provider)
    const flow = await this.state.create({
      kind: 'install',
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      provider,
      name: input.name,
      scopes: input.scopes,
      returnUrl: input.returnUrl,
      redirectUri: adapter.redirectUri,
      ...(operationId ? { operationId } : {}),
    })
    return {
      authorizationUrl: adapter.createAuthorizationUrl({
        state: flow.state,
        codeChallenge: flow.codeChallenge,
        scopes: input.scopes,
      }),
      stateId: flow.stateId,
      expiresAt: flow.expiresAt,
    }
  }

  /** Existing connector の OAuth reauthorization flow を開始します。 */
  async reauthorize(
    principal: DeveloperManagementPrincipal,
    installationId: string,
    operationId?: string,
  ): Promise<ConnectorAuthorizationOutput> {
    const snapshot = await this.requireInstallationSnapshot(
      principal.workspaceId,
      installationId,
    )
    return this.createReauthorizationFlow(
      principal.workspaceId,
      principal.userId,
      snapshot.installation,
      this.reauthorizationReturnUrl,
      snapshot.lifecycleRevision,
      undefined,
      principal.userId,
      operationId,
    )
  }

  /** Provider credential を先に revoke し、成功時だけ local deletion を許可します。 */
  async disconnect(
    principal: DeveloperManagementPrincipal,
    installationId: string,
  ) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = await this.requireInstallationSnapshot(
        principal.workspaceId,
        installationId,
      )
      if (snapshot.installation.status === 'disconnected') {
        await this.platform.updateConnectorStatus({
          workspaceId: principal.workspaceId,
          installationId,
          status: 'disconnected',
          updatedByUserId: principal.userId,
        })
        return
      }
      let serialized: string
      try {
        serialized = await this.platform.readConnectorCredential({
          workspaceId: principal.workspaceId,
          installationId,
        })
      } catch (error) {
        if (
          error instanceof DeveloperPlatformError &&
          error.code === 'ConnectorDisconnected'
        ) continue
        throw error
      }
      const credential = deserializeConnectorCredential(serialized)
      const adapter = this.registry.get(
        readSupportedProvider(snapshot.installation.provider),
      )
      await adapter.disconnect(credential)
      try {
        await this.platform.updateConnectorStatus({
          workspaceId: principal.workspaceId,
          installationId,
          status: 'disconnected',
          updatedByUserId: principal.userId,
          expectedCredential: serialized,
        })
        return
      } catch (error) {
        if (
          error instanceof DeveloperPlatformError &&
          (
            error.code === 'ConnectorCredentialChanged' ||
            error.code === 'DeveloperPlatformConcurrentMutation'
          )
        ) continue
        throw error
      }
    }
    throw new ConnectorRuntimeError(
      'ConnectorDisconnectConcurrentMutation',
      'Connector credential kept changing while disconnect was in progress.',
      { retryable: true },
    )
  }

  /** Durable conflict page を Workspace scope 内で返します。 */
  async listConflicts(
    principal: DeveloperManagementPrincipal,
    input: {
      /** Optional conflict status filter です。 */
      status?: 'open' | 'resolved' | 'ignored'
      /** Durable store cursor です。 */
      cursor?: string
      /** Page size です。 */
      limit: number
    },
  ) {
    const items: WorkItemSyncConflict[] = []
    let continuation = input.cursor
    const seenCursors = new Set<string>()
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await this.conflicts.listConflicts(principal.workspaceId, {
        ...(input.status ? { status: input.status } : {}),
        ...(continuation ? { cursor: continuation } : {}),
        limit: Math.max(1, input.limit - items.length),
      })
      for (const conflict of page.items) {
        if (await this.conflicts.canAccessConflict(
          { workspaceId: principal.workspaceId, userId: principal.userId },
          conflict.id,
        )) items.push(conflict)
      }
      if (!page.hasMore) return { items, hasMore: false }
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
        throw new ConnectorRuntimeError(
          'ConnectorSyncCursorInvalid',
          'Connector sync conflict cursor did not advance.',
        )
      }
      seenCursors.add(page.nextCursor)
      continuation = page.nextCursor
      if (items.length >= input.limit) {
        return { items, hasMore: true, nextCursor: continuation }
      }
    }
    throw new ConnectorRuntimeError(
      'ConnectorSyncPageLimitExceeded',
      'Connector sync conflict filtering exceeded its safe page limit.',
      { retryable: true },
    )
  }

  /** Current actor RBAC で conflict recovery を実行します。 */
  async resolveConflict(
    principal: DeveloperManagementPrincipal,
    conflictId: string,
    input: ResolveWorkItemSyncConflictInput,
  ) {
    return this.conflicts.resolveConflict(
      {
        workspaceId: principal.workspaceId,
        userId: principal.userId,
      },
      conflictId,
      input,
    )
  }

  /** Signed callback state を consume し、installation を作成または復旧します。 */
  async completeCallback(
    input: CompleteConnectorOAuthCallbackInput,
  ): Promise<CompleteConnectorOAuthCallbackResult> {
    const flow = await this.state.consume(input.state)
    await this.callbackAuthorizer.authorize(flow.workspaceId, flow.userId)
    const adapter = this.requireOAuthAdapter(flow.provider)
    if (adapter.redirectUri !== flow.redirectUri) {
      throw new ConnectorRuntimeError(
        'ConnectorRedirectUriMismatch',
        'Connector OAuth redirect URI changed during authorization.',
      )
    }
    if (flow.kind === 'reauthorize') {
      if (!flow.installationId) {
        throw new ConnectorRuntimeError(
          'ConnectorOAuthStateInvalid',
          'Connector reauthorization state has no installation ID.',
        )
      }
      await this.platform.assertConnectorReauthorizationState({
        workspaceId: flow.workspaceId,
        installationId: flow.installationId,
        stateId: flow.stateId,
      })
    }
    const credential = await adapter.connect({
      code: readAuthorizationCode(input.code),
      state: input.state,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
      requestedScopes: flow.scopes,
    })
    try {
      assertGrantedScopes(flow.scopes, credential.scopes)
      const installation = flow.kind === 'install'
        ? await this.platform.installConnector({
            workspaceId: flow.workspaceId,
            installedByUserId: flow.userId,
            input: {
              category: adapter.definition.category,
              provider: adapter.definition.id,
              name: flow.name,
              scopes: credential.scopes,
              externalAccountId: credential.externalAccountId,
              ...(credential.externalAccountName
                ? { externalAccountName: credential.externalAccountName }
                : {}),
              credential: serializeConnectorCredential(credential),
            },
          })
        : await this.completeReauthorization(flow, credential)
      return { installation, returnUrl: flow.returnUrl }
    } catch (error) {
      await adapter.disconnect(credential).catch(() => undefined)
      throw error
    }
  }

  /** Provider denial でも state を exactly once consume し、safe return URL を復元します。 */
  async abortCallback(input: { /** Signed OAuth state です。 */ state: string }) {
    const flow = await this.state.consume(input.state)
    await this.callbackAuthorizer.authorize(flow.workspaceId, flow.userId)
    return { returnUrl: flow.returnUrl }
  }

  /** Worker が認証失敗を検出した connector へ signed reauthorization URL を保存します。 */
  async authorizationRequired(
    workspaceId: string,
    installation: ConnectorInstallation,
    lifecycleRevision?: number,
  ) {
    const snapshot = await this.requireInstallationSnapshot(
      workspaceId,
      installation.id,
    )
    if (
      (
        lifecycleRevision !== undefined &&
        snapshot.lifecycleRevision !== lifecycleRevision
      ) ||
      snapshot.installation.status === 'disconnected' ||
      snapshot.installation.status === 'needs-reauth'
    ) return
    try {
      await this.createReauthorizationFlow(
        workspaceId,
        snapshot.installation.installedByUserId,
        snapshot.installation,
        this.reauthorizationReturnUrl,
        snapshot.lifecycleRevision,
        {
          type: 'https://docs.mukuroji.app/problems/authentication_required',
          title: 'Provider authorization required',
          status: 401,
          code: 'authentication_required',
          detail: 'Reconnect the provider before retrying this operation.',
          requestId: 'connector-worker',
          retryable: false,
        },
      )
    } catch (error) {
      if (
        error instanceof DeveloperPlatformError &&
        error.code === 'ConnectorLifecycleChanged'
      ) return
      throw error
    }
  }

  /** Worker が transient provider failure を検出した connector を degraded にします。 */
  async degraded(
    workspaceId: string,
    installation: ConnectorInstallation,
    error: ConnectorRuntimeError,
    lifecycleRevision?: number,
  ) {
    const snapshot = await this.requireInstallationSnapshot(
      workspaceId,
      installation.id,
    )
    if (
      (
        lifecycleRevision !== undefined &&
        snapshot.lifecycleRevision !== lifecycleRevision
      ) ||
      snapshot.installation.status === 'disconnected' ||
      snapshot.installation.status === 'needs-reauth'
    ) return
    try {
      await this.platform.updateConnectorStatus({
        workspaceId,
        installationId: installation.id,
        status: 'degraded',
        expectedLifecycleRevision: snapshot.lifecycleRevision,
        lastError: {
          type: 'https://docs.mukuroji.app/problems/temporarily_unavailable',
          title: 'Provider temporarily unavailable',
          status: error.providerStatus === 429 ? 429 : 503,
          code: error.providerStatus === 429
            ? 'rate_limited'
            : 'temporarily_unavailable',
          detail: 'The provider request could not be completed and may be retried.',
          requestId: 'connector-worker',
          retryable: true,
        },
      })
    } catch (statusError) {
      if (
        statusError instanceof DeveloperPlatformError &&
        statusError.code === 'ConnectorLifecycleChanged'
      ) return
      throw statusError
    }
  }

  /** Installation credential を provider refresh token で更新します。 */
  async refreshCredential(workspaceId: string, installationId: string) {
    const installation = await this.requireInstallation(workspaceId, installationId)
    const serialized = await this.platform.readConnectorCredential({
      workspaceId,
      installationId,
    })
    const adapter = this.registry.get(readSupportedProvider(installation.provider))
    const claimId = randomUUID()
    const claim = await this.platform.claimConnectorCredentialRefresh({
      workspaceId,
      installationId,
      expectedCredential: serialized,
      claimId,
    })
    if (claim === 'busy' || claim === 'credential-changed') {
      const winner = await this.platform.readConnectorCredential({
        workspaceId,
        installationId,
      })
      deserializeConnectorCredential(winner)
      if (winner === serialized && claim === 'busy') {
        throw new ConnectorRuntimeError(
          'ConnectorCredentialRefreshInProgress',
          'Connector credential refresh is already in progress.',
          { retryable: true },
        )
      }
      return this.requireInstallation(workspaceId, installationId)
    }
    let credential: ReturnType<typeof deserializeConnectorCredential>
    try {
      credential = await adapter.refresh(
        deserializeConnectorCredential(serialized),
      )
    } catch (error) {
      await this.platform.releaseConnectorCredentialRefresh({
        workspaceId,
        installationId,
        claimId,
      }).catch(() => false)
      throw error
    }
    try {
      return await this.platform.recoverConnector({
        workspaceId,
        installationId,
        credential: serializeConnectorCredential(credential),
        expectedCredential: serialized,
        refreshClaimId: claimId,
        reason: 'refresh',
      })
    } catch (error) {
      await this.platform.releaseConnectorCredentialRefresh({
        workspaceId,
        installationId,
        claimId,
      }).catch(() => false)
      if (
        !(error instanceof DeveloperPlatformError) ||
        (
          error.code !== 'ConnectorCredentialChanged' &&
          error.code !== 'ConnectorCredentialRefreshClaimLost' &&
          error.code !== 'DeveloperPlatformConcurrentMutation' &&
          error.code !== 'ConnectorReauthorizationStateRequired'
        )
      ) {
        throw error
      }
      let winner: string
      try {
        winner = await this.platform.readConnectorCredential({
          workspaceId,
          installationId,
        })
      } catch (reloadError) {
        if (
          reloadError instanceof DeveloperPlatformError &&
          reloadError.code === 'ConnectorDisconnected'
        ) {
          await adapter.disconnect(credential).catch(() => undefined)
        }
        throw reloadError
      }
      deserializeConnectorCredential(winner)
      return this.requireInstallation(workspaceId, installationId)
    }
  }

  /** Worker/user initiated reauthorization flow を作ります。 */
  private async createReauthorizationFlow(
    workspaceId: string,
    userId: string,
    installation: ConnectorInstallation,
    returnUrl: string,
    expectedLifecycleRevision: number,
    lastError?: ConnectorInstallation['lastError'],
    updatedByUserId?: string,
    operationId?: string,
  ) {
    const provider = readSupportedProvider(installation.provider)
    const adapter = this.requireOAuthAdapter(provider)
    const flow = await this.state.create({
      kind: 'reauthorize',
      workspaceId,
      userId,
      provider,
      name: installation.name,
      scopes: installation.scopes,
      returnUrl,
      redirectUri: adapter.redirectUri,
      installationId: installation.id,
      ...(operationId ? { operationId } : {}),
    })
    const output = {
      authorizationUrl: adapter.createAuthorizationUrl({
        state: flow.state,
        codeChallenge: flow.codeChallenge,
        scopes: installation.scopes,
      }),
      stateId: flow.stateId,
      expiresAt: flow.expiresAt,
    }
    await this.platform.updateConnectorStatus({
      workspaceId,
      installationId: installation.id,
      status: 'needs-reauth',
      reauthorizationUrl: output.authorizationUrl,
      reauthorizationStateId: flow.stateId,
      expectedLifecycleRevision,
      ...(lastError ? { lastError } : {}),
      ...(updatedByUserId ? { updatedByUserId } : {}),
    })
    return output
  }

  /** Reauthorization callback を same provider/account installation へ適用します。 */
  private async completeReauthorization(
    flow: ConnectorOAuthFlow,
    credential: ReturnType<typeof deserializeConnectorCredential>,
  ) {
    if (!flow.installationId) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateInvalid',
        'Connector reauthorization state has no installation ID.',
      )
    }
    const installation = await this.requireInstallation(
      flow.workspaceId,
      flow.installationId,
    )
    if (installation.provider !== flow.provider) {
      throw new ConnectorRuntimeError(
        'ConnectorProviderMismatch',
        'Connector provider changed during reauthorization.',
      )
    }
    if (
      installation.externalAccountId &&
      installation.externalAccountId !== credential.externalAccountId
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorAccountMismatch',
        'Reauthorization must use the same external provider account.',
      )
    }
    return this.platform.recoverConnector({
      workspaceId: flow.workspaceId,
      installationId: flow.installationId,
      credential: serializeConnectorCredential(credential),
      expectedReauthorizationStateId: flow.stateId,
      reason: 'reauthorization',
      updatedByUserId: flow.userId,
    })
  }

  /** Workspace-bound installation を取得します。 */
  private async requireInstallation(workspaceId: string, installationId: string) {
    return (await this.requireInstallationSnapshot(
      workspaceId,
      installationId,
    )).installation
  }

  /** Workspace-bound installation と lifecycle revision を取得します。 */
  private async requireInstallationSnapshot(
    workspaceId: string,
    installationId: string,
  ) {
    return this.platform.readConnectorLifecycleSnapshot({
      workspaceId,
      installationId,
    })
  }

  /** Provider の OAuth extension を取得します。 */
  private requireOAuthAdapter(provider: ConnectorProviderId) {
    const adapter = this.registry.get(provider)
    if (!isConnectorOAuthAdapter(adapter)) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthUnavailable',
        'Connector provider OAuth is not configured.',
      )
    }
    return adapter
  }
}

/** ConnectorSyncEngine を authorization runtime の conflict boundary へ適合させます。 */
export function createConnectorConflictRuntime(
  engine: ConnectorSyncEngine,
): ConnectorConflictRuntime {
  return {
    listConflicts: (workspaceId, input) =>
      engine.listConflicts(workspaceId, input),
    canAccessConflict: (actor, conflictId) =>
      engine.canAccessConflict(actor, conflictId),
    resolveConflict: (actor, conflictId, input) =>
      engine.resolveConflict(actor, conflictId, input),
  }
}

function readSupportedProvider(provider: ConnectorInstallation['provider']) {
  if (BUILT_IN_CONNECTOR_CATALOG.some((entry) => entry.id === provider)) {
    return provider as ConnectorProviderId
  }
  throw new ConnectorRuntimeError(
    'ConnectorProviderUnsupported',
    'Connector provider is not configured in this runtime.',
  )
}

function readAuthorizationCode(value: string) {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 8_192 ||
    hasControlCharacters(value)
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorAuthorizationCodeInvalid',
      'Connector authorization code is invalid.',
    )
  }
  return value
}

function assertGrantedScopes(requested: readonly string[], granted: readonly string[]) {
  const grantedSet = new Set(granted)
  const missing = requested.filter((scope) => !grantedSet.has(scope))
  if (missing.length > 0) {
    throw new ConnectorRuntimeError(
      'ConnectorScopesInsufficient',
      'Provider did not grant every requested connector scope.',
      { authorizationRequired: true },
    )
  }
}

function validateApplicationReturnUrl(value: string) {
  if (
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

function hasControlCharacters(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint < 0x20 || codePoint === 0x7f
  })
}
