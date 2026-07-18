import { createHash, randomUUID } from 'node:crypto'
import type {
  CanonicalWorkItem,
  ConnectorInstallation,
  ExternalWorkItemLink,
  ResolveWorkItemSyncConflictInput,
  WorkItemSyncConflict,
  WorkItemSyncConflictField,
} from '@mukuroji/contracts'
import {
  DeveloperPlatformError,
  type ConnectorLifecycleSnapshot,
  type DeveloperPlatformClient,
} from './developer-platform'
import {
  BUILT_IN_CONNECTOR_CATALOG,
  ConnectorRegistry,
  createConnectorOriginMarker,
  decideConnectorInboundSync,
  type ConnectorExternalRecord,
  type ConnectorOutboundMutation,
  type ConnectorSyncState,
  type ExternalResourceType,
} from './connectors'
import {
  ConnectorRuntimeError,
  deserializeConnectorCredential,
  serializeConnectorCredential,
} from './connector-oauth'

/** Work Item link で同期できる source-control resource type です。 */
export type ConnectorWorkItemResourceType =
  | 'issue'
  | 'merge-request'
  | 'commit'
  | 'deploy'

/** Sync engine が Work Item から利用する normalized snapshot です。 */
export type ConnectorWorkItemSnapshot = {
  /** Work Item ID です。 */
  id: string
  /** Owner Team ID です。 */
  teamId: string
  /** Optimistic concurrency revision です。 */
  revision: number
  /** Work Item title です。 */
  title: string
  /** Work Item description です。 */
  description?: string
  /** Provider adapter が理解する normalized status です。 */
  status?: string
}

/** External record から Work Item へ適用する canonical fields です。 */
export type ConnectorWorkItemPatch = {
  /** External title が存在する場合の title です。 */
  title?: string
  /** External description が存在する場合の description です。 */
  description?: string
  /** External status が存在する場合の normalized status です。 */
  status?: string
}

/** CAS 付き external patch の結果です。 */
export type ConnectorWorkItemApplyResult =
  | {
    /** Patch が適用された結果です。 */
    kind: 'applied'
    /** 更新後 Work Item snapshot です。 */
    workItem: ConnectorWorkItemSnapshot
  }
  | {
    /** Work Item revision が変化した結果です。 */
    kind: 'conflict'
    /** Current Work Item snapshot です。 */
    workItem: ConnectorWorkItemSnapshot
  }

/** Connector worker と canonical Work Item service の境界です。 */
export interface ConnectorWorkItemGateway {
  /** Installation actor の current Team/Work Item RBAC を再評価します。 */
  authorize(
    workspaceId: string,
    actorUserId: string,
    teamId: string,
    workItemId: string,
    write: boolean,
  ): Promise<void>
  /** Current Work Item snapshot を取得します。 */
  get(
    workspaceId: string,
    teamId: string,
    workItemId: string,
  ): Promise<ConnectorWorkItemSnapshot>
  /**
   * Expected revision が一致する場合だけ external patch を適用します。
   * 同じ operationId の再試行は、既に適用済みなら同じ applied result を返します。
   */
  applyExternal(
    input: {
      /** Workspace ID です。 */
      workspaceId: string
      /** Owner Team ID です。 */
      teamId: string
      /** Work Item ID です。 */
      workItemId: string
      /** Installation actor user ID です。 */
      actorUserId: string
      /** Expected Work Item revision です。 */
      expectedRevision: number
      /** External record から作った patch です。 */
      patch: ConnectorWorkItemPatch
      /** Audit correlation に使う stable operation ID です。 */
      operationId: string
    },
  ): Promise<ConnectorWorkItemApplyResult>
}

/** Durable link sync state です。 */
export type PersistedConnectorSyncState = ConnectorSyncState & {
  /** Store-level optimistic concurrency revision です。 */
  storageRevision: number
  /** 最後に provider と一致したsnapshotで、outbound直後は返却versionと組にした未消費markerを含みます。 */
  lastExternalRecord?: ConnectorExternalRecord
  /** 最後に同期へ成功した日時です。 */
  lastSyncedAt?: string
}

/** Sync state commit 入力です。 */
export type CommitConnectorSyncStateInput = {
  /** Workspace ID です。 */
  workspaceId: string
  /** Existing link です。 */
  link: ExternalWorkItemLink
  /** State が存在した場合の expected store revision です。 */
  expectedStorageRevision?: number
  /** 同期後 Work Item revision です。 */
  workItemRevision: number
  /** 同期後 external record です。 */
  externalRecord: ConnectorExternalRecord
  /** Inbound provider event ID です。 */
  eventId?: string
  /** 同期完了日時です。 */
  syncedAt: string
  /** Sync state だけを保存し、public link status 更新を遅延する場合は true です。 */
  deferLinkStatus?: boolean
}

/** Public conflict に resolution 用 private snapshot を付けた durable record です。 */
export type StoredConnectorSyncConflict = {
  /** Conflict が属する Workspace ID です。 */
  workspaceId: string
  /** Public API に返す redact 済み conflict です。 */
  conflict: WorkItemSyncConflict
  /** Owner Team ID です。 */
  teamId: string
  /** Connector installation ID です。 */
  installationId: string
  /** External resource type です。 */
  resourceType: ConnectorWorkItemResourceType
  /** Conflict 検出時の external record です。 */
  externalRecord: ConnectorExternalRecord
  /** Conflict 検出時の local snapshot です。 */
  localWorkItem: ConnectorWorkItemSnapshot
  /** Side effect を fencing する deterministic resolution operation ID です。 */
  resolutionOperationId?: string
  /** Resolution claim を取得した日時です。 */
  resolutionStartedAt?: string
}

/** Conflict cursor page です。 */
export type ConnectorSyncConflictPage = {
  /** Permission scope 内の conflict 一覧です。 */
  items: WorkItemSyncConflict[]
  /** 次 page があるかどうかです。 */
  hasMore: boolean
  /** Store 固有の opaque cursor です。 */
  nextCursor?: string
}

/** Durable connector sync state/conflict persistence boundary です。 */
export interface ConnectorSyncPersistence {
  /** Link の current sync state を取得します。 */
  getLinkState(
    workspaceId: string,
    linkId: string,
  ): Promise<PersistedConnectorSyncState | undefined>
  /** Expected state revision と一致する場合だけ success state を保存します。 */
  commitLinkState(input: CommitConnectorSyncStateInput): Promise<boolean>
  /** Link の user-visible sync status を更新します。 */
  setLinkStatus(
    workspaceId: string,
    linkId: string,
    status: ExternalWorkItemLink['syncStatus'],
    updatedAt: string,
  ): Promise<void>
  /** Poll generation と一致する pending link だけを synced へ CAS 遷移します。 */
  acknowledgePendingLink(
    workspaceId: string,
    linkId: string,
    expectedUpdatedAt: string,
    expectedExternalVersion: string,
    expectedStateRevision: number,
    syncedAt: string,
  ): Promise<boolean>
  /** Deterministic conflict ID で open conflict を冪等に保存します。 */
  createConflict(record: StoredConnectorSyncConflict): Promise<WorkItemSyncConflict>
  /** Workspace 内の conflict page を返します。 */
  listConflicts(
    workspaceId: string,
    input: {
      /** Optional status filter です。 */
      status?: WorkItemSyncConflict['status']
      /** Store 固有 cursor です。 */
      cursor?: string
      /** Page size です。 */
      limit: number
    },
  ): Promise<ConnectorSyncConflictPage>
  /** Workspace-bound conflict record を取得します。 */
  getConflict(
    workspaceId: string,
    conflictId: string,
  ): Promise<StoredConnectorSyncConflict | undefined>
  /** Open conflict の side effect 実行権を operation ID で一度だけ claim します。 */
  claimConflictResolution(
    workspaceId: string,
    conflictId: string,
    input: {
      /** Retry 間で固定する operation ID です。 */
      operationId: string
      /** Claim timestamp です。 */
      startedAt: string
    },
  ): Promise<'claimed' | 'same-operation' | 'busy' | undefined>
  /** Side effect 前に失敗した current resolution claim を解放します。 */
  releaseConflictResolution(
    workspaceId: string,
    conflictId: string,
    operationId: string,
  ): Promise<boolean>
  /** Open conflict を一度だけ resolved/ignored へ遷移させます。 */
  completeConflict(
    workspaceId: string,
    conflictId: string,
    input: {
      /** 解決後 status です。 */
      status: 'resolved' | 'ignored'
      /** 解決した Workspace user ID です。 */
      resolvedByUserId: string
      /** 解決日時です。 */
      resolvedAt: string
      /** Claim と一致させる operation ID です。 */
      operationId: string
    },
  ): Promise<WorkItemSyncConflict | undefined>
}

/** Connector sync が必要とする developer platform client subset です。 */
export type ConnectorSyncPlatform = Pick<
  DeveloperPlatformClient,
  | 'readConnectorLifecycleSnapshot'
  | 'listExternalWorkItemLinks'
  | 'readConnectorCredential'
  | 'updateConnectorStatus'
  | 'recoverConnector'
  | 'claimConnectorCredentialRefresh'
  | 'releaseConnectorCredentialRefresh'
>

/** Authorization failure と connector health を永続化する hook です。 */
export interface ConnectorSyncHealthReporter {
  /** Credential 再認証が必要な connector を user-visible state へ遷移させます。 */
  authorizationRequired(
    workspaceId: string,
    installation: ConnectorInstallation,
    lifecycleRevision: number,
  ): Promise<void>
  /** Secret-free provider failure を degraded state へ遷移させます。 */
  degraded(
    workspaceId: string,
    installation: ConnectorInstallation,
    error: ConnectorRuntimeError,
    lifecycleRevision: number,
  ): Promise<void>
}

/** Inbound sync worker input です。 */
export type ProcessConnectorInboundInput = {
  /** Link が属する Workspace ID です。 */
  workspaceId: string
  /** Provider webhook event ID です。 */
  eventId: string
  /** Target external link です。 */
  link: ExternalWorkItemLink
  /** Provider webhook または polling から正規化した record です。 */
  record: ConnectorExternalRecord
  /** Pending link を安全に acknowledge できる poll inventory generation です。 */
  pollGeneration?: string
}

/** Outbound sync worker input です。 */
export type ProcessConnectorOutboundInput = {
  /** Link が属する Workspace ID です。 */
  workspaceId: string
  /** Target external link です。 */
  link: ExternalWorkItemLink
  /** Audit/idempotency に使う stable operation ID です。 */
  operationId: string
}

/** Connector sync worker の処理結果です。 */
export type ConnectorSyncResult =
  | {
    /** Provider/Work Item state を同期しました。 */
    kind: 'synced'
    /** 更新した link ID です。 */
    linkId: string
    /** 同期後 Work Item revision です。 */
    workItemRevision: number
    /** 同期後 external version です。 */
    externalVersion: string
  }
  | {
    /** Event を安全に skip しました。 */
    kind: 'skipped'
    /** Skip 対象 link ID です。 */
    linkId: string
    /** Skip 理由です。 */
    reason:
      | 'direction'
      | 'duplicate'
      | 'self-origin'
      | 'stale'
      | 'paused'
      | 'conflict'
  }
  | {
    /** User-visible conflict を保存しました。 */
    kind: 'conflict'
    /** 保存した public conflict です。 */
    conflict: WorkItemSyncConflict
  }

/** Installation polling input です。 */
export type PollConnectorInstallationInput = {
  /** Installation が属する Workspace ID です。 */
  workspaceId: string
  /** Poll 対象 installation ID です。 */
  installationId: string
  /** Poll 対象 external resource type です。 */
  resourceType: ConnectorWorkItemResourceType
  /** Provider cursor です。 */
  cursor?: string
  /** 1 invocation で読む最大 page 数です。 */
  maximumPages?: number
}

/** Installation polling output です。 */
export type PollConnectorInstallationResult = {
  /** 各 linked resource の sync result です。 */
  results: ConnectorSyncResult[]
  /** 続行用 provider cursor です。 */
  nextCursor?: string
}

/** Conflict resolution actor です。 */
export type ConnectorConflictActor = {
  /** Actor Workspace ID です。 */
  workspaceId: string
  /** Current Workspace user ID です。 */
  userId: string
}

/** Connector sync engine の構築 dependencies です。 */
export type ConnectorSyncEngineOptions = {
  /** Connector installation と encrypted credential store です。 */
  platform: ConnectorSyncPlatform
  /** Configured provider adapter registry です。 */
  registry: ConnectorRegistry
  /** Canonical Work Item gateway です。 */
  workItems: ConnectorWorkItemGateway
  /** Durable sync state/conflict persistence です。 */
  persistence: ConnectorSyncPersistence
  /** Connector health transition hook です。 */
  health: ConnectorSyncHealthReporter
  /** Provider が返す loop guard を認証する HMAC secret です。 */
  originSigningSecret: string
  /** Rotation grace period 中に inbound 検証だけ許可する旧 HMAC secrets です。 */
  previousOriginSigningSecrets?: readonly string[]
  /** Sync timestamps に使う clock です。 */
  clock?: () => Date
}

/** issue/MR/commit/deploy と canonical Work Item を双方向同期します。 */
export class ConnectorSyncEngine {
  /** Connector installation と encrypted credential store です。 */
  private readonly platform: ConnectorSyncPlatform
  /** Provider adapter registry です。 */
  private readonly registry: ConnectorRegistry
  /** Canonical Work Item gateway です。 */
  private readonly workItems: ConnectorWorkItemGateway
  /** Durable state/conflict store です。 */
  private readonly persistence: ConnectorSyncPersistence
  /** Connector health transition hook です。 */
  private readonly health: ConnectorSyncHealthReporter
  /** Origin marker HMAC secret です。 */
  private readonly originSigningSecret: string
  /** Rotation grace period 中に inbound 検証だけ許可する旧 HMAC secrets です。 */
  private readonly previousOriginSigningSecrets: readonly string[]
  /** Sync timestamps に使う clock です。 */
  private readonly clock: () => Date

  /** Connector sync engine を作成します。 */
  constructor(options: ConnectorSyncEngineOptions) {
    this.platform = options.platform
    this.registry = options.registry
    this.workItems = options.workItems
    this.persistence = options.persistence
    this.health = options.health
    if (Buffer.byteLength(options.originSigningSecret, 'utf8') < 32) {
      throw new ConnectorRuntimeError(
        'ConnectorOriginSigningSecretInvalid',
        'Connector origin signing secret must contain at least 32 bytes.',
      )
    }
    this.originSigningSecret = options.originSigningSecret
    this.previousOriginSigningSecrets = options.previousOriginSigningSecrets ?? []
    if (
      this.previousOriginSigningSecrets.length > 3 ||
      this.previousOriginSigningSecrets.some((secret) =>
        Buffer.byteLength(secret, 'utf8') < 32
      )
    ) {
      throw new ConnectorRuntimeError(
        'ConnectorOriginSigningSecretInvalid',
        'Previous connector origin signing secrets are invalid.',
      )
    }
    this.clock = options.clock ?? (() => new Date())
  }

  /** Provider record を current RBAC/CAS 付きで Work Item へ同期します。 */
  async processInbound(
    input: ProcessConnectorInboundInput,
  ): Promise<ConnectorSyncResult> {
    const link = await this.requireLink(input.workspaceId, input.link.id)
    validateLinkRecordBinding(link, input.record)
    if (
      link.syncDirection !== 'inbound' &&
      link.syncDirection !== 'bidirectional'
    ) {
      return { kind: 'skipped', linkId: link.id, reason: 'direction' }
    }
    if (link.syncStatus === 'paused' || link.syncStatus === 'conflict') {
      return { kind: 'skipped', linkId: link.id, reason: link.syncStatus }
    }
    const installationSnapshot = await this.requireInstallationSnapshot(
      input.workspaceId,
      link.installationId,
    )
    const installation = installationSnapshot.installation
    await this.workItems.authorize(
      input.workspaceId,
      installation.installedByUserId,
      link.teamId,
      link.workItemId,
      true,
    )
    const workItem = await this.workItems.get(
      input.workspaceId,
      link.teamId,
      link.workItemId,
    )
    const persisted = await this.persistence.getLinkState(
      input.workspaceId,
      link.id,
    )
    const state = persisted ?? createInitialSyncState(link, workItem.revision)
    const operationId = createSyncOperationId(
      'inbound',
      input.workspaceId,
      link.id,
      input.eventId,
      input.record.externalVersion,
    )
    const decision = decideConnectorInboundSync({
      state,
      eventId: requireStableValue(input.eventId, 'Connector event ID'),
      externalVersion: input.record.externalVersion,
      originMarker: input.record.originMarker,
      expectedOriginMarker: persisted?.lastExternalRecord?.originMarker,
      actualWorkItemRevision: workItem.revision,
      originSigningSecret: this.originSigningSecret,
      previousOriginSigningSecrets: this.previousOriginSigningSecrets,
    })
    const pollGeneration = input.pollGeneration
    const isCurrentExactPoll =
      link.syncStatus === 'pending' &&
      pollGeneration === link.updatedAt &&
      state.lastExternalVersion !== undefined &&
      input.record.externalVersion === state.lastExternalVersion &&
      state.workItemRevision === workItem.revision
    if (decision.kind === 'self-origin') {
      await this.commitSyncedState(
        input.workspaceId,
        link,
        persisted,
        state.workItemRevision,
        input.record,
        input.eventId,
        !isCurrentExactPoll,
      )
      return { kind: 'skipped', linkId: link.id, reason: decision.kind }
    }
    if (decision.kind === 'duplicate' || decision.kind === 'stale') {
      if (isCurrentExactPoll && pollGeneration && persisted) {
        const syncedAt = this.clock().toISOString()
        const acknowledged = await this.persistence.acknowledgePendingLink(
          input.workspaceId,
          link.id,
          pollGeneration,
          input.record.externalVersion,
          persisted.storageRevision,
          syncedAt,
        )
        if (acknowledged) {
          await this.platform.updateConnectorStatus({
            workspaceId: input.workspaceId,
            installationId: link.installationId,
            status: 'connected',
            lastSyncAt: syncedAt,
          })
        }
      }
      return { kind: 'skipped', linkId: link.id, reason: decision.kind }
    }
    // A revision conflict intentionally reaches the idempotent gateway. If a
    // previous attempt applied the same operation but crashed before the sync
    // state commit, its receipt wins over the now-stale revision snapshot.
    const applied = await this.workItems.applyExternal({
      workspaceId: input.workspaceId,
      teamId: link.teamId,
      workItemId: link.workItemId,
      actorUserId: installation.installedByUserId,
      expectedRevision: state.workItemRevision,
      patch: recordToPatch(input.record),
      operationId,
    })
    if (applied.kind === 'conflict') {
      return this.persistConflict(
        input.workspaceId,
        link,
        installation,
        applied.workItem,
        input.record,
        input.eventId,
      )
    }
    await this.commitSyncedState(
      input.workspaceId,
      link,
      persisted,
      applied.workItem.revision,
      input.record,
      input.eventId,
    )
    return {
      kind: 'synced',
      linkId: link.id,
      workItemRevision: applied.workItem.revision,
      externalVersion: input.record.externalVersion,
    }
  }

  /** Current Work Item snapshot を provider resource へ同期します。 */
  async processOutbound(
    input: ProcessConnectorOutboundInput,
  ): Promise<ConnectorSyncResult> {
    requireStableValue(input.operationId, 'Connector outbound operation ID')
    const link = await this.requireLink(input.workspaceId, input.link.id)
    if (
      link.syncDirection !== 'outbound' &&
      link.syncDirection !== 'bidirectional'
    ) {
      return { kind: 'skipped', linkId: link.id, reason: 'direction' }
    }
    if (link.syncStatus === 'paused' || link.syncStatus === 'conflict') {
      return { kind: 'skipped', linkId: link.id, reason: link.syncStatus }
    }
    const installationSnapshot = await this.requireInstallationSnapshot(
      input.workspaceId,
      link.installationId,
    )
    const installation = installationSnapshot.installation
    await this.workItems.authorize(
      input.workspaceId,
      installation.installedByUserId,
      link.teamId,
      link.workItemId,
      true,
    )
    const workItem = await this.workItems.get(
      input.workspaceId,
      link.teamId,
      link.workItemId,
    )
    const persisted = await this.persistence.getLinkState(
      input.workspaceId,
      link.id,
    )
    const mutation = createOutboundMutation(
      link,
      workItem,
      input.operationId,
      this.originSigningSecret,
      persisted?.lastExternalVersion,
    )
    const record = await this.withConnectorCredential(
      input.workspaceId,
      installation,
      installationSnapshot.lifecycleRevision,
      async (adapter, credential) => adapter.push(credential, mutation),
    )
    validateLinkRecordBinding(link, record)
    await this.commitSyncedState(
      input.workspaceId,
      link,
      persisted,
      workItem.revision,
      record,
      undefined,
      false,
      mutation.originMarker,
    )
    return {
      kind: 'synced',
      linkId: link.id,
      workItemRevision: workItem.revision,
      externalVersion: record.externalVersion,
    }
  }

  /** Provider pages を bounded に poll し、既存 links だけを inbound sync します。 */
  async pollInstallation(
    input: PollConnectorInstallationInput,
  ): Promise<PollConnectorInstallationResult> {
    const installationSnapshot = await this.requireInstallationSnapshot(
      input.workspaceId,
      input.installationId,
    )
    const installation = installationSnapshot.installation
    const links = await this.platform.listExternalWorkItemLinks({
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      resourceType: input.resourceType,
    })
    const linkByExternalId = new Map(
      links
        .filter((link) =>
          link.resourceType === input.resourceType &&
          link.syncStatus !== 'paused' &&
          link.syncStatus !== 'conflict' &&
          (
            link.syncDirection === 'inbound' ||
            link.syncDirection === 'bidirectional'
          )
        )
        .map((link) => [link.externalId, link]),
    )
    const maximumPages = input.maximumPages ?? 10
    if (!Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > 100) {
      throw new ConnectorRuntimeError(
        'ConnectorPollLimitInvalid',
        'Connector polling page limit is invalid.',
      )
    }
    if (linkByExternalId.size === 0) return { results: [] }
    let cursor = input.cursor
    const results: ConnectorSyncResult[] = []
    for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
      const page = await this.withConnectorCredential(
        input.workspaceId,
        installation,
        installationSnapshot.lifecycleRevision,
        async (adapter, credential) =>
          adapter.pull(credential, input.resourceType, cursor),
      )
      for (const record of page.items) {
        const link = linkByExternalId.get(record.externalId)
        if (!link) continue
        results.push(await this.processInbound({
          workspaceId: input.workspaceId,
          link,
          record,
          ...(link.syncStatus === 'pending'
            ? { pollGeneration: link.updatedAt }
            : {}),
          eventId: createSyncOperationId(
            'poll',
            input.workspaceId,
            link.id,
            record.externalId,
            record.externalVersion,
          ),
        }))
      }
      cursor = page.nextCursor
      if (!cursor) return { results }
    }
    return {
      results,
      ...(cursor ? { nextCursor: cursor } : {}),
    }
  }

  /** Current actor の RBAC を再評価して open conflict を解決します。 */
  async resolveConflict(
    actor: ConnectorConflictActor,
    conflictId: string,
    input: ResolveWorkItemSyncConflictInput,
  ): Promise<WorkItemSyncConflict> {
    const resolution = validateConflictResolution(input)
    const operationId = createSyncOperationId(
      'resolve',
      actor.workspaceId,
      conflictId,
      actor.userId,
      JSON.stringify(resolution),
    )
    const stored = await this.persistence.getConflict(actor.workspaceId, conflictId)
    if (!stored) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncConflictNotFound',
        'Connector sync conflict was not found.',
      )
    }
    if (stored.conflict.status !== 'open') {
      if (stored.resolutionOperationId === operationId) {
        return structuredClone(stored.conflict)
      }
      throw new ConnectorRuntimeError(
        'ConnectorSyncConflictNotFound',
        'Open connector sync conflict was not found.',
      )
    }
    await this.workItems.authorize(
      actor.workspaceId,
      actor.userId,
      stored.teamId,
      stored.conflict.workItemId,
      true,
    )
    const resolvedAt = this.clock().toISOString()
    const claim = await this.persistence.claimConflictResolution(
      actor.workspaceId,
      conflictId,
      { operationId, startedAt: resolvedAt },
    )
    if (claim === 'busy') {
      throw new ConnectorRuntimeError(
        'ConnectorSyncConflictResolutionInProgress',
        'Another connector conflict resolution is already in progress.',
        { retryable: true },
      )
    }
    if (claim === undefined) {
      const latest = await this.persistence.getConflict(actor.workspaceId, conflictId)
      if (
        latest?.resolutionOperationId === operationId &&
        latest.conflict.status !== 'open'
      ) return structuredClone(latest.conflict)
      throw conflictResolutionRace()
    }
    if (resolution.resolution === 'ignore') {
      const ignored = await this.persistence.completeConflict(
        actor.workspaceId,
        conflictId,
        {
          status: 'ignored',
          resolvedByUserId: actor.userId,
          resolvedAt,
          operationId,
        },
      )
      if (!ignored) throw conflictResolutionRace()
      return ignored
    }
    let link: ExternalWorkItemLink
    let installationSnapshot: ConnectorLifecycleSnapshot
    let current: ConnectorWorkItemSnapshot
    try {
      link = await this.requireLink(
        actor.workspaceId,
        stored.conflict.externalLinkId,
      )
      installationSnapshot = await this.requireInstallationSnapshot(
        actor.workspaceId,
        stored.installationId,
      )
      current = await this.workItems.get(
        actor.workspaceId,
        stored.teamId,
        stored.conflict.workItemId,
      )
    } catch (error) {
      await this.persistence.releaseConflictResolution(
        actor.workspaceId,
        conflictId,
        operationId,
      )
      throw error
    }
    const installation = installationSnapshot.installation
    if (
      resolution.resolution === 'use-local' &&
      current.revision !== stored.conflict.localRevision
    ) {
      await this.persistence.releaseConflictResolution(
        actor.workspaceId,
        conflictId,
        operationId,
      )
      throw new ConnectorRuntimeError(
        'ConnectorSyncConflictChanged',
        'Work Item changed after this sync conflict was detected.',
      )
    }
    let synchronizedWorkItem = current
    let synchronizedRecord = stored.externalRecord
    let outboundOriginMarker: string | undefined
    if (resolution.resolution === 'use-external' || resolution.resolution === 'merge') {
      const patch = resolution.resolution === 'merge'
        ? resolution.mergedValues
        : recordToPatch(stored.externalRecord)
      const applied = await this.workItems.applyExternal({
        workspaceId: actor.workspaceId,
        teamId: stored.teamId,
        workItemId: stored.conflict.workItemId,
        actorUserId: actor.userId,
        expectedRevision: stored.conflict.localRevision,
        patch,
        operationId: createSyncOperationId(
          'resolve-local',
          actor.workspaceId,
          conflictId,
          resolution.resolution,
          stored.externalRecord.externalVersion,
        ),
      })
      if (applied.kind === 'conflict') {
        await this.persistence.releaseConflictResolution(
          actor.workspaceId,
          conflictId,
          operationId,
        )
        throw new ConnectorRuntimeError(
          'ConnectorSyncConflictChanged',
          'Work Item changed while resolving this sync conflict.',
        )
      }
      synchronizedWorkItem = applied.workItem
    }
    if (resolution.resolution === 'use-local' || resolution.resolution === 'merge') {
      const mutation = createOutboundMutation(
        link,
        synchronizedWorkItem,
        operationId,
        this.originSigningSecret,
        stored.externalRecord.externalVersion,
      )
      outboundOriginMarker = mutation.originMarker
      synchronizedRecord = await this.withConnectorCredential(
        actor.workspaceId,
        installation,
        installationSnapshot.lifecycleRevision,
        async (adapter, credential) =>
          adapter.push(credential, mutation),
      )
    }
    const persisted = await this.persistence.getLinkState(
      actor.workspaceId,
      link.id,
    )
    await this.commitSyncedState(
      actor.workspaceId,
      link,
      persisted,
      synchronizedWorkItem.revision,
      synchronizedRecord,
      undefined,
      true,
      outboundOriginMarker,
    )
    const resolved = await this.persistence.completeConflict(
      actor.workspaceId,
      conflictId,
      {
        status: 'resolved',
        resolvedByUserId: actor.userId,
        resolvedAt,
        operationId,
      },
    )
    if (!resolved) throw conflictResolutionRace()
    return resolved
  }

  /** Workspace-scoped conflict page を返します。 */
  async listConflicts(
    workspaceId: string,
    input: {
      /** Optional status filter です。 */
      status?: WorkItemSyncConflict['status']
      /** Store cursor です。 */
      cursor?: string
      /** Page size です。 */
      limit: number
    },
  ) {
    return this.persistence.listConflicts(workspaceId, input)
  }

  /** Current actor が conflict の Work Item を参照できるかを current RBAC で判定します。 */
  async canAccessConflict(actor: ConnectorConflictActor, conflictId: string) {
    const stored = await this.persistence.getConflict(actor.workspaceId, conflictId)
    if (!stored) return false
    try {
      await this.workItems.authorize(
        actor.workspaceId,
        actor.userId,
        stored.teamId,
        stored.conflict.workItemId,
        false,
      )
      return true
    } catch (error) {
      if (
        error instanceof ConnectorRuntimeError &&
        error.code === 'ConnectorWorkItemAccessDenied'
      ) return false
      throw error
    }
  }

  /** Installation と lifecycle revision を検証します。 */
  private async requireInstallationSnapshot(
    workspaceId: string,
    installationId: string,
  ): Promise<ConnectorLifecycleSnapshot> {
    const snapshot = await this.platform.readConnectorLifecycleSnapshot({
      workspaceId,
      installationId,
    })
    if (snapshot.installation.status !== 'connected') {
      throw new ConnectorRuntimeError(
        'ConnectorNotConnected',
        'Connector installation is not connected.',
        {
          authorizationRequired:
            snapshot.installation.status === 'needs-reauth',
        },
      )
    }
    return snapshot
  }

  /** Workspace-bound external link を取得します。 */
  private async requireLink(workspaceId: string, linkId: string) {
    const link = (await this.platform.listExternalWorkItemLinks({
      workspaceId,
      linkId,
    }))[0]
    if (!link) {
      throw new ConnectorRuntimeError(
        'ExternalWorkItemLinkNotFound',
        'External Work Item link was not found.',
      )
    }
    return link
  }

  /** Encrypted credential を worker 内だけで復号して adapter operation を実行します。 */
  private async withConnectorCredential<T>(
    workspaceId: string,
    installation: ConnectorInstallation,
    lifecycleRevision: number,
    operation: (
      adapter: ReturnType<ConnectorRegistry['get']>,
      credential: ReturnType<typeof deserializeConnectorCredential>,
    ) => Promise<T>,
  ) {
    try {
      const serialized = await this.platform.readConnectorCredential({
        workspaceId,
        installationId: installation.id,
      })
      const credential = deserializeConnectorCredential(serialized)
      const adapter = this.registry.get(readSupportedProvider(installation.provider))
      let operationCredential = credential
      if (shouldRefreshCredential(credential, this.clock())) {
        const claimId = randomUUID()
        const claim = await this.platform.claimConnectorCredentialRefresh({
          workspaceId,
          installationId: installation.id,
          expectedCredential: serialized,
          claimId,
        })
        if (claim === 'busy' || claim === 'credential-changed') {
          const winner = await this.platform.readConnectorCredential({
            workspaceId,
            installationId: installation.id,
          })
          if (winner === serialized && claim === 'busy') {
            throw new ConnectorRuntimeError(
              'ConnectorCredentialRefreshInProgress',
              'Connector credential refresh is already in progress.',
              { retryable: true },
            )
          }
          operationCredential = deserializeConnectorCredential(winner)
          return await operation(adapter, operationCredential)
        }
        let refreshed: ReturnType<typeof deserializeConnectorCredential>
        try {
          refreshed = await adapter.refresh(credential)
        } catch (error) {
          await this.platform.releaseConnectorCredentialRefresh({
            workspaceId,
            installationId: installation.id,
            claimId,
          }).catch(() => false)
          throw error
        }
        operationCredential = refreshed
        try {
          await this.platform.recoverConnector({
            workspaceId,
            installationId: installation.id,
            credential: serializeConnectorCredential(refreshed),
            expectedCredential: serialized,
            refreshClaimId: claimId,
            reason: 'refresh',
          })
        } catch (error) {
          await this.platform.releaseConnectorCredentialRefresh({
            workspaceId,
            installationId: installation.id,
            claimId,
          }).catch(() => false)
          if (!isConnectorCredentialCasConflict(error)) throw error
          try {
            operationCredential = deserializeConnectorCredential(
              await this.platform.readConnectorCredential({
                workspaceId,
                installationId: installation.id,
              }),
            )
          } catch (reloadError) {
            if (
              reloadError instanceof DeveloperPlatformError &&
              reloadError.code === 'ConnectorDisconnected'
            ) {
              await adapter.disconnect(refreshed).catch(() => undefined)
            }
            throw reloadError
          }
        }
      }
      return await operation(adapter, operationCredential)
    } catch (error) {
      if (error instanceof ConnectorRuntimeError) {
        const latestSnapshot = await this.platform.readConnectorLifecycleSnapshot({
          workspaceId,
          installationId: installation.id,
        }).catch(() => undefined)
        const healthInstallation = latestSnapshot?.installation ?? installation
        const healthLifecycleRevision =
          latestSnapshot?.lifecycleRevision ?? lifecycleRevision
        if (error.authorizationRequired) {
          await this.health.authorizationRequired(
            workspaceId,
            healthInstallation,
            healthLifecycleRevision,
          )
        } else if (
          error.retryable &&
          error.code !== 'ConnectorCredentialRefreshInProgress'
        ) {
          await this.health.degraded(
            workspaceId,
            healthInstallation,
            error,
            healthLifecycleRevision,
          )
        }
      }
      throw error
    }
  }

  /** User-visible conflict を deterministic ID で保存します。 */
  private async persistConflict(
    workspaceId: string,
    link: ExternalWorkItemLink,
    installation: ConnectorInstallation,
    workItem: ConnectorWorkItemSnapshot,
    record: ConnectorExternalRecord,
    eventId: string,
  ): Promise<ConnectorSyncResult> {
    const conflict = createStoredConflict(
      workspaceId,
      link,
      installation.id,
      workItem,
      record,
      eventId,
      this.clock(),
    )
    const created = await this.persistence.createConflict(conflict)
    return { kind: 'conflict', conflict: created }
  }

  /** Link state と user-visible status を success へ commit します。 */
  private async commitSyncedState(
    workspaceId: string,
    link: ExternalWorkItemLink,
    persisted: PersistedConnectorSyncState | undefined,
    workItemRevision: number,
    record: ConnectorExternalRecord,
    eventId?: string,
    deferLinkStatus = false,
    outboundOriginMarker?: string,
  ) {
    const syncedAt = this.clock().toISOString()
    const committed = await this.persistence.commitLinkState({
      workspaceId,
      link,
      ...(persisted
        ? { expectedStorageRevision: persisted.storageRevision }
        : {}),
      workItemRevision,
      externalRecord: createPersistedConnectorExternalRecord(
        record,
        outboundOriginMarker,
      ),
      ...(eventId ? { eventId } : {}),
      syncedAt,
      ...(deferLinkStatus ? { deferLinkStatus: true } : {}),
    })
    if (!committed) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncStateConflict',
        'Connector sync state changed concurrently.',
        { retryable: true },
      )
    }
    await this.platform.updateConnectorStatus({
      workspaceId,
      installationId: link.installationId,
      status: 'connected',
      lastSyncAt: syncedAt,
    })
  }
}

/** Test/local development 用 optimistic connector sync persistence です。 */
export class InMemoryConnectorSyncPersistence implements ConnectorSyncPersistence {
  /** Workspace + link ID ごとの sync state です。 */
  private readonly states = new Map<string, PersistedConnectorSyncState>()
  /** Workspace + conflict ID ごとの private conflict record です。 */
  private readonly conflicts = new Map<string, StoredConnectorSyncConflict>()
  /** Workspace + link ID ごとの user-visible status です。 */
  private readonly statuses = new Map<string, ExternalWorkItemLink['syncStatus']>()

  /** Link state snapshot を返します。 */
  async getLinkState(workspaceId: string, linkId: string) {
    const value = this.states.get(syncStateKey(workspaceId, linkId))
    return value ? structuredClone(value) : undefined
  }

  /** Expected storage revision が一致する場合だけ link state を commit します。 */
  async commitLinkState(input: CommitConnectorSyncStateInput) {
    const key = syncStateKey(input.workspaceId, input.link.id)
    const current = this.states.get(key)
    if (
      (current?.storageRevision ?? undefined) !== input.expectedStorageRevision
    ) {
      return false
    }
    this.states.set(key, {
      installationId: input.link.installationId,
      linkId: input.link.id,
      workItemRevision: input.workItemRevision,
      lastExternalVersion: input.externalRecord.externalVersion,
      ...(input.eventId ? { lastExternalEventId: input.eventId } : {}),
      storageRevision: (current?.storageRevision ?? 0) + 1,
      lastExternalRecord: structuredClone(input.externalRecord),
      lastSyncedAt: input.syncedAt,
    })
    if (!input.deferLinkStatus) {
      this.statuses.set(key, 'synced')
    }
    return true
  }

  /** Link status を保存します。 */
  async setLinkStatus(
    workspaceId: string,
    linkId: string,
    status: ExternalWorkItemLink['syncStatus'],
  ) {
    this.statuses.set(syncStateKey(workspaceId, linkId), status)
  }

  /** Engine で検証済みの pending poll generation を synced へ保存します。 */
  async acknowledgePendingLink(
    workspaceId: string,
    linkId: string,
    _expectedUpdatedAt: string,
    expectedExternalVersion: string,
    expectedStateRevision: number,
    _syncedAt: string,
  ) {
    const state = this.states.get(syncStateKey(workspaceId, linkId))
    if (
      state?.lastExternalVersion !== expectedExternalVersion ||
      state.storageRevision !== expectedStateRevision
    ) return false
    this.statuses.set(syncStateKey(workspaceId, linkId), 'synced')
    return true
  }

  /** Deterministic conflict ID で record を冪等保存します。 */
  async createConflict(record: StoredConnectorSyncConflict) {
    const key = conflictKey(record.workspaceId, record.conflict.id)
    const existing = this.conflicts.get(key)
    if (existing) return structuredClone(existing.conflict)
    this.conflicts.set(key, structuredClone(record))
    this.statuses.set(
      syncStateKey(record.workspaceId, record.conflict.externalLinkId),
      'conflict',
    )
    return structuredClone(record.conflict)
  }

  /** Workspace-scoped offset cursor page を返します。 */
  async listConflicts(
    workspaceId: string,
    input: {
      /** Optional status filter です。 */
      status?: WorkItemSyncConflict['status']
      /** Numeric opaque cursor です。 */
      cursor?: string
      /** Page size です。 */
      limit: number
    },
  ) {
    const offset = input.cursor ? Number(input.cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncCursorInvalid',
        'Connector sync conflict cursor is invalid.',
      )
    }
    const records = [...this.conflicts.values()]
      .filter((record) =>
        record.workspaceId === workspaceId &&
        (input.status === undefined || record.conflict.status === input.status)
      )
      .sort((left, right) =>
        right.conflict.detectedAt.localeCompare(left.conflict.detectedAt) ||
        right.conflict.id.localeCompare(left.conflict.id)
      )
    const items = records.slice(offset, offset + input.limit)
      .map((record) => structuredClone(record.conflict))
    const nextOffset = offset + items.length
    return {
      items,
      hasMore: nextOffset < records.length,
      ...(nextOffset < records.length ? { nextCursor: String(nextOffset) } : {}),
    }
  }

  /** Workspace-bound conflict record を返します。 */
  async getConflict(workspaceId: string, conflictId: string) {
    const value = this.conflicts.get(conflictKey(workspaceId, conflictId))
    return value ? structuredClone(value) : undefined
  }

  /** Resolution operation を open conflict に一度だけ claim します。 */
  async claimConflictResolution(
    workspaceId: string,
    conflictId: string,
    input: {
      /** Stable resolution operation ID です。 */
      operationId: string
      /** Claim timestamp です。 */
      startedAt: string
    },
  ) {
    const key = conflictKey(workspaceId, conflictId)
    const current = this.conflicts.get(key)
    if (!current || current.conflict.status !== 'open') return undefined
    if (current.resolutionOperationId) {
      return current.resolutionOperationId === input.operationId
        ? 'same-operation' as const
        : 'busy' as const
    }
    this.conflicts.set(key, {
      ...current,
      resolutionOperationId: input.operationId,
      resolutionStartedAt: input.startedAt,
    })
    return 'claimed' as const
  }

  /** Side effect 前に失敗した current resolution claim を解放します。 */
  async releaseConflictResolution(
    workspaceId: string,
    conflictId: string,
    operationId: string,
  ) {
    const key = conflictKey(workspaceId, conflictId)
    const current = this.conflicts.get(key)
    if (
      !current ||
      current.conflict.status !== 'open' ||
      current.resolutionOperationId !== operationId
    ) return false
    const next = { ...current }
    delete next.resolutionOperationId
    delete next.resolutionStartedAt
    this.conflicts.set(key, next)
    return true
  }

  /** Open conflict を一度だけ terminal status へ遷移させます。 */
  async completeConflict(
    workspaceId: string,
    conflictId: string,
    input: {
      /** Terminal status です。 */
      status: 'resolved' | 'ignored'
      /** Resolver user ID です。 */
      resolvedByUserId: string
      /** Resolution timestamp です。 */
      resolvedAt: string
      /** Claimed resolution operation ID です。 */
      operationId: string
    },
  ) {
    const key = conflictKey(workspaceId, conflictId)
    const current = this.conflicts.get(key)
    if (
      !current ||
      current.conflict.status !== 'open' ||
      current.resolutionOperationId !== input.operationId
    ) return undefined
    const next: StoredConnectorSyncConflict = {
      ...current,
      conflict: {
        ...current.conflict,
        status: input.status,
        resolvedByUserId: input.resolvedByUserId,
        resolvedAt: input.resolvedAt,
      },
    }
    this.conflicts.set(key, next)
    this.statuses.set(
      syncStateKey(workspaceId, current.conflict.externalLinkId),
      input.status === 'ignored' ? 'paused' : 'synced',
    )
    return structuredClone(next.conflict)
  }

  /** Test assertion 用に current link status を返します。 */
  getLinkStatus(workspaceId: string, linkId: string) {
    return this.statuses.get(syncStateKey(workspaceId, linkId))
  }
}

/** Canonical API contract から sync snapshot を作成します。 */
export function createConnectorWorkItemSnapshot(
  workItem: CanonicalWorkItem,
): ConnectorWorkItemSnapshot {
  return {
    id: workItem.id,
    teamId: workItem.teamId,
    revision: workItem.revision,
    title: workItem.title,
    description: workItem.description,
    status: workItem.workflowStatusId,
  }
}

function createInitialSyncState(
  link: ExternalWorkItemLink,
  workItemRevision: number,
): PersistedConnectorSyncState {
  return {
    installationId: link.installationId,
    linkId: link.id,
    workItemRevision,
    storageRevision: 0,
  }
}

/** Outbound marker を返却versionと組で保存し、inbound commit で消費します。 */
function createPersistedConnectorExternalRecord(
  record: ConnectorExternalRecord,
  outboundOriginMarker?: string,
) {
  const persisted = structuredClone(record)
  if (outboundOriginMarker) persisted.originMarker = outboundOriginMarker
  else delete persisted.originMarker
  return persisted
}

function createOutboundMutation(
  link: ExternalWorkItemLink,
  workItem: ConnectorWorkItemSnapshot,
  operationId: string,
  originSigningSecret: string,
  expectedExternalVersion?: string,
): ConnectorOutboundMutation {
  return {
    externalId: link.externalId,
    resourceType: readWorkItemResourceType(link.resourceType),
    workItemRevision: workItem.revision,
    title: workItem.title,
    description: workItem.description,
    status: workItem.status,
    originMarker: createConnectorOriginMarker(
      link.installationId,
      link.id,
      workItem.revision,
      operationId,
      originSigningSecret,
    ),
    operationId,
    ...(expectedExternalVersion ? { expectedExternalVersion } : {}),
  }
}

function createStoredConflict(
  workspaceId: string,
  link: ExternalWorkItemLink,
  installationId: string,
  workItem: ConnectorWorkItemSnapshot,
  record: ConnectorExternalRecord,
  eventId: string,
  now: Date,
): StoredConnectorSyncConflict {
  const id = `sync-conflict-${createHash('sha256')
    .update(
      `connector-sync-conflict-v1\0${workspaceId}\0${link.id}\0` +
        `${eventId}\0${record.externalVersion}`,
    )
    .digest('hex')
    .slice(0, 40)}`
  const fields = createConflictFields(workItem, record)
  return {
    workspaceId,
    teamId: link.teamId,
    installationId,
    resourceType: readWorkItemResourceType(link.resourceType),
    externalRecord: structuredClone(record),
    localWorkItem: structuredClone(workItem),
    conflict: {
      id,
      externalLinkId: link.id,
      workItemId: link.workItemId,
      localRevision: workItem.revision,
      externalRevision: record.externalVersion,
      fields,
      status: 'open',
      detectedAt: now.toISOString(),
    },
  }
}

function createConflictFields(
  workItem: ConnectorWorkItemSnapshot,
  record: ConnectorExternalRecord,
) {
  const fields: WorkItemSyncConflictField[] = []
  appendConflictField(fields, 'title', workItem.title, record.title)
  appendConflictField(fields, 'description', workItem.description, record.description)
  appendConflictField(fields, 'status', workItem.status, record.status)
  if (fields.length === 0) {
    fields.push({
      field: 'revision',
      localValue: workItem.revision,
      externalValue: record.externalVersion,
    })
  }
  return fields
}

function appendConflictField(
  fields: WorkItemSyncConflictField[],
  field: string,
  localValue: unknown,
  externalValue: unknown,
) {
  if (externalValue !== undefined && externalValue !== localValue) {
    fields.push({ field, localValue, externalValue })
  }
}

function recordToPatch(record: ConnectorExternalRecord): ConnectorWorkItemPatch {
  return {
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(record.status !== undefined ? { status: record.status } : {}),
  }
}

function validateConflictResolution(
  input: ResolveWorkItemSyncConflictInput,
):
  | {
    /** Non-merge resolution です。 */
    resolution: 'use-local' | 'use-external' | 'ignore'
  }
  | {
    /** Merge resolution です。 */
    resolution: 'merge'
    /** Canonical fields だけを含む merge patch です。 */
    mergedValues: ConnectorWorkItemPatch
  } {
  if (
    input.resolution === 'use-local' ||
    input.resolution === 'use-external' ||
    input.resolution === 'ignore'
  ) {
    if (input.mergedValues !== undefined) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncResolutionInvalid',
        'Merged values are only allowed for merge resolution.',
      )
    }
    return { resolution: input.resolution }
  }
  if (input.resolution !== 'merge' || !input.mergedValues) {
    throw new ConnectorRuntimeError(
      'ConnectorSyncResolutionInvalid',
      'Merge resolution requires merged values.',
    )
  }
  const keys = Object.keys(input.mergedValues)
  if (
    keys.length === 0 ||
    keys.some((key) => !['title', 'description', 'status'].includes(key))
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorSyncResolutionInvalid',
      'Merge resolution contains unsupported fields.',
    )
  }
  const mergedValues: ConnectorWorkItemPatch = {}
  for (const key of keys) {
    const value = input.mergedValues[key]
    if (typeof value !== 'string' || value.length > 100_000 || value.includes('\0')) {
      throw new ConnectorRuntimeError(
        'ConnectorSyncResolutionInvalid',
        'Merged connector field value is invalid.',
      )
    }
    mergedValues[key as keyof ConnectorWorkItemPatch] = value
  }
  return { resolution: 'merge', mergedValues }
}

function validateLinkRecordBinding(
  link: ExternalWorkItemLink,
  record: ConnectorExternalRecord,
) {
  if (
    link.externalId !== record.externalId ||
    link.resourceType !== record.resourceType
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorExternalRecordMismatch',
      'Connector external record does not match its Work Item link.',
    )
  }
}

function shouldRefreshCredential(
  credential: ReturnType<typeof deserializeConnectorCredential>,
  now: Date,
) {
  return credential.expiresAt !== undefined &&
    Date.parse(credential.expiresAt) <= now.getTime() + 5 * 60 * 1_000
}

function isConnectorCredentialCasConflict(error: unknown) {
  return error instanceof DeveloperPlatformError &&
    (
      error.code === 'ConnectorCredentialChanged' ||
      error.code === 'ConnectorCredentialRefreshClaimLost' ||
      error.code === 'DeveloperPlatformConcurrentMutation' ||
      error.code === 'ConnectorReauthorizationStateRequired'
    )
}

function readSupportedProvider(provider: ConnectorInstallation['provider']) {
  const definition = BUILT_IN_CONNECTOR_CATALOG.find(
    (candidate) =>
      candidate.id === provider && candidate.category === 'source-control',
  )
  if (definition) return definition.id
  throw new ConnectorRuntimeError(
    'ConnectorProviderUnsupported',
    'Connector provider is not configured in this runtime.',
  )
}

function readWorkItemResourceType(value: ExternalResourceType) {
  if (
    value === 'issue' ||
    value === 'merge-request' ||
    value === 'commit' ||
    value === 'deploy'
  ) {
    return value
  }
  throw new ConnectorRuntimeError(
    'ConnectorCapabilityUnsupported',
    'External resource cannot be linked to a Work Item.',
  )
}

function createSyncOperationId(kind: string, ...parts: string[]) {
  return `connector-${kind}-${createHash('sha256')
    .update(`connector-sync-operation-v1\0${parts.join('\0')}`)
    .digest('hex')}`
}

function requireStableValue(value: string, label: string) {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 512 ||
    hasControlCharacters(value)
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorSyncInputInvalid',
      `${label} is invalid.`,
    )
  }
  return value
}

function syncStateKey(workspaceId: string, linkId: string) {
  return `${workspaceId}\0${linkId}`
}

function conflictKey(workspaceId: string, conflictId: string) {
  return `${workspaceId}\0${conflictId}`
}

function conflictResolutionRace() {
  return new ConnectorRuntimeError(
    'ConnectorSyncConflictChanged',
    'Connector sync conflict was resolved concurrently.',
  )
}

function hasControlCharacters(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint < 0x20 || codePoint === 0x7f
  })
}
