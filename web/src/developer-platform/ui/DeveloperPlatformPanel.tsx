import {
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { useSWRConfig } from 'swr'
import type {
  ApiKeySummary,
  ApiScope,
  ConnectorInstallation,
  ImportDryRunReport,
  ImportJob,
  OAuthAppSummary,
  WebhookDelivery,
  WebhookSubscription,
  WorkItemSyncConflict,
} from '@mukuroji/contracts'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../shared/api/mutationHeaders'
import {
  connectDeveloperConnector,
  createDeveloperImport,
  createDeveloperApiKey,
  createDeveloperOAuthApp,
  createDeveloperWebhook,
  shouldRetainDeveloperPlatformMutationContext,
  disconnectDeveloperConnector,
  dryRunDeveloperImport,
  exportDeveloperWorkItems,
  getDeveloperPlatformResources,
  replayDeveloperWebhookDelivery,
  reauthorizeDeveloperConnector,
  resolveDeveloperSyncConflict,
  revokeDeveloperApiKey,
  revokeDeveloperOAuthApp,
  revokeDeveloperWebhook,
  rotateDeveloperApiKey,
  rotateDeveloperOAuthApp,
  rotateDeveloperWebhook,
  type ConnectDeveloperConnectorInput,
  type CreateDeveloperApiKeyInput,
  type CreateDeveloperOAuthAppInput,
  type CreateDeveloperWebhookInput,
  type DeveloperSyncConflictResolution,
  type DeveloperConnectorProvider,
  type DeveloperExportFormat,
  type DeveloperImportFieldMapping,
  type DeveloperImportFormat,
  type DeveloperOAuthGrantType,
  type DeveloperPlatformResources,
  type DeveloperWebhookEventType,
  type DryRunDeveloperImportInput,
  type IssuedApiKeySecret,
  type IssuedOAuthClientSecret,
  type IssuedWebhookSigningSecret,
  type ResolveDeveloperSyncConflictInput,
} from '../api'
import {
  useDeveloperPlatformResources,
  useDeveloperSyncConflicts,
} from '../queries/useDeveloperPlatform'

/**
 * Developer Platform panel の表示 section です。
 */
export type DeveloperPlatformSection =
  | 'credentials'
  | 'webhooks'
  | 'connectors'
  | 'imports'

/**
 * Checkbox、select、source card に表示する値と説明です。
 */
export type DeveloperPlatformOption<TValue extends string = string> = {
  /**
   * API input に渡す安定 identifier です。
   */
  value: TValue
  /**
   * ユーザー向け表示名です。
   */
  label: string
  /**
   * 選択肢の影響または用途を示す補助説明です。
   */
  description: string
}

/**
 * Import destination の Team に属する Project 選択肢です。
 */
export type DeveloperImportProjectOption = DeveloperPlatformOption & {
  /**
   * Project を所有する Team ID です。
   */
  teamId: string
}

/**
 * 未接続状態も含めて表示する connector catalog item です。
 */
export type DeveloperConnectorCatalogItem = {
  /**
   * Connector API path に使う provider identifier です。
   */
  provider: DeveloperConnectorProvider
  /**
   * Connector card の表示名です。
   */
  name: string
  /**
   * Connector が同期する resource の説明です。
   */
  description: string
  /**
   * Connector category の表示名です。
   */
  categoryLabel: string
  /**
   * 新規接続時に要求する scope 一覧です。
   */
  scopes: string[]
  /**
   * Resource mapping 検索の対象になる語句です。
   */
  searchTerms: string[]
}

/**
 * Developer Platform panel の全表示文言です。
 *
 * コンポーネント内に locale 固定文言を持たせず、親画面の i18n から注入します。
 */
export type DeveloperPlatformLabels = {
  /**
   * Panel の eyebrow です。
   */
  eyebrow: string
  /**
   * Panel の見出しです。
   */
  title: string
  /**
   * Panel 全体の説明です。
   */
  description: string
  /**
   * Mutation 権限が無い状態の badge です。
   */
  readOnly: string
  /**
   * Loading 中の screen reader 向け文言です。
   */
  loading: string
  /**
   * Aggregate resource 取得失敗時の文言です。
   */
  loadError: string
  /**
   * API mutation 失敗時の文言です。
   */
  operationError: string
  /**
   * Aggregate resource を再取得する button 文言です。
   */
  retry: string
  /**
   * Section tab の表示名です。
   */
  tabs: Record<DeveloperPlatformSection, string>
  /**
   * Entity status の表示名です。
   */
  statusLabels: Record<string, string>
  /**
   * API scope の選択肢です。
   */
  scopeOptions: DeveloperPlatformOption<ApiScope>[]
  /**
   * OAuth grant type の選択肢です。
   */
  grantTypeOptions: DeveloperPlatformOption<DeveloperOAuthGrantType>[]
  /**
   * Webhook event type の選択肢です。
   */
  webhookEventOptions: DeveloperPlatformOption<DeveloperWebhookEventType>[]
  /**
   * Connector catalog です。
   */
  connectorCatalog: DeveloperConnectorCatalogItem[]
  /**
   * Import mapping の target Work Item field 選択肢です。
   */
  importFieldOptions: DeveloperPlatformOption[]
  /**
   * Table column の表示名です。
   */
  tableHeaders: Record<string, string>
  /**
   * Button と link action の表示名です。
   */
  actions: Record<string, string>
  /**
   * Form field の表示名です。
   */
  fields: Record<string, string>
  /**
   * Input placeholder です。
   */
  placeholders: Record<string, string>
  /**
   * Section と empty state の見出しです。
   */
  headings: Record<string, string>
  /**
   * Section、empty state、security notice の説明です。
   */
  helpText: Record<string, string>
  /**
   * One-time secret dialog の見出しです。
   */
  secretTitles: Record<SecretDialogKind, string>
  /**
   * One-time secret dialog の説明です。
   */
  secretDescriptions: Record<SecretDialogKind, string>
  /**
   * One-time secret の共通 warning です。
   */
  secretWarning: string
  /**
   * One-time secret を安全に保存したことを確認する checkbox 文言です。
   */
  secretStoredConfirmation: string
  /**
   * Secret を clipboard へ copy する button 文言です。
   */
  copySecret: string
  /**
   * Secret copy 完了後の button 文言です。
   */
  copiedSecret: string
  /**
   * Modal を閉じる button 文言です。
   */
  closeDialog: string
  /**
   * Import report summary の placeholder 付き文言です。
   */
  importReportSummary: string
}

/**
 * One-time secret dialog の種別です。
 */
export type SecretDialogKind = 'api-key' | 'oauth-app' | 'webhook'

/**
 * One-time secret dialog だけが保持する state です。
 */
type SecretDialogState = {
  /**
   * Secret の credential 種別です。
   */
  kind: SecretDialogKind
  /**
   * Secret の対象を識別する表示名です。
   */
  name: string
  /**
   * Modal を閉じるまで一度だけ表示する secret value です。
   */
  value: string
}

/**
 * Create form modal の種別です。
 */
type EditorDialogKind = 'api-key' | 'oauth-app' | 'webhook'

/**
 * DeveloperPlatformPanel が受け取る aggregate state と mutation callback です。
 */
export type DeveloperPlatformPanelProps = {
  /**
   * Developer Platform aggregate resource です。
   */
  resources?: DeveloperPlatformResources
  /**
   * Connector の双方向同期で検出された conflict 一覧です。
   */
  syncConflicts?: WorkItemSyncConflict[]
  /**
   * Sync conflict 一覧を取得中かどうかです。
   */
  isSyncConflictsLoading?: boolean
  /**
   * Sync conflict 一覧取得失敗時の安全な表示メッセージです。
   */
  syncConflictsErrorMessage?: string
  /**
   * 取得済み conflict を保持したまま表示する追加 page error です。
   */
  syncConflictsLoadMoreErrorMessage?: string
  /**
   * Sync conflict の次 page が存在するかどうかです。
   */
  syncConflictsHasMore?: boolean
  /**
   * Sync conflict の次 page を取得中かどうかです。
   */
  isLoadingMoreSyncConflicts?: boolean
  /**
   * Aggregate resource を取得中かどうかです。
   */
  isLoading?: boolean
  /**
   * Aggregate resource 取得失敗時の安全な表示メッセージです。
   */
  loadErrorMessage?: string
  /**
   * Panel の全表示文言と選択肢です。
   */
  labels: DeveloperPlatformLabels
  /**
   * 初期表示する section です。
   */
  initialSection?: DeveloperPlatformSection
  /**
   * Import destination として選択できる Team 一覧です。
   */
  importTeamOptions?: DeveloperPlatformOption[]
  /**
   * Import destination として選択できる Project 一覧です。
   */
  importProjectOptions?: DeveloperImportProjectOption[]
  /**
   * ISO 8601 timestamp をユーザー向けに整形する callback です。
   */
  formatDateTime?: (value: string) => string
  /**
   * Aggregate resource を再取得する callback です。
   */
  onRetry?: () => Promise<void> | void
  /**
   * API key を作成し one-time secret を返す callback です。
   */
  onCreateApiKey?: (
    input: CreateDeveloperApiKeyInput,
  ) => Promise<IssuedApiKeySecret>
  /**
   * API key secret を rotation する callback です。
   */
  onRotateApiKey?: (apiKeyId: string) => Promise<IssuedApiKeySecret>
  /**
   * API key を revoke する callback です。
   */
  onRevokeApiKey?: (apiKeyId: string) => Promise<void>
  /**
   * OAuth app を作成し one-time client secret を返す callback です。
   */
  onCreateOAuthApp?: (
    input: CreateDeveloperOAuthAppInput,
  ) => Promise<IssuedOAuthClientSecret>
  /**
   * OAuth client secret を rotation する callback です。
   */
  onRotateOAuthApp?: (
    oauthAppId: string,
  ) => Promise<IssuedOAuthClientSecret>
  /**
   * OAuth app を revoke する callback です。
   */
  onRevokeOAuthApp?: (oauthAppId: string) => Promise<void>
  /**
   * Webhook subscription を作成し signing secret を返す callback です。
   */
  onCreateWebhook?: (
    input: CreateDeveloperWebhookInput,
  ) => Promise<IssuedWebhookSigningSecret>
  /**
   * Webhook signing secret を rotation する callback です。
   */
  onRotateWebhook?: (
    subscriptionId: string,
  ) => Promise<IssuedWebhookSigningSecret>
  /**
   * Webhook subscription を revoke する callback です。
   */
  onRevokeWebhook?: (subscriptionId: string) => Promise<void>
  /**
   * Failed webhook delivery を replay する callback です。
   */
  onReplayDelivery?: (deliveryId: string) => Promise<void>
  /**
   * Provider connector を新規接続する callback です。
   */
  onConnectConnector?: (
    provider: DeveloperConnectorProvider,
    input: ConnectDeveloperConnectorInput,
  ) => Promise<void>
  /**
   * Connector installation の再認証を開始する callback です。
   */
  onReauthorizeConnector?: (installationId: string) => Promise<void>
  /**
   * Connector installation を切断する callback です。
   */
  onDisconnectConnector?: (installationId: string) => Promise<void>
  /**
   * Work Item の同期競合を解決する callback です。
   */
  onResolveSyncConflict?: (
    input: ResolveDeveloperSyncConflictInput,
  ) => Promise<void>
  /**
   * Sync conflict 一覧を再取得する callback です。
   */
  onRetrySyncConflicts?: () => Promise<void> | void
  /**
   * Sync conflict の次 page を取得する callback です。
   */
  onLoadMoreSyncConflicts?: () => Promise<void> | void
  /**
   * Import source の mapping を dry-run する callback です。
   */
  onDryRunImport?: (
    input: DryRunDeveloperImportInput,
  ) => Promise<ImportDryRunReport>
  /**
   * 検証済み import job を commit する callback です。
   */
  onCommitImport?: (
    input: DryRunDeveloperImportInput,
  ) => Promise<ImportJob>
  /**
   * Work Item export download を開始する callback です。
   */
  onExport?: (format: DeveloperExportFormat) => Promise<void>
}

/**
 * DeveloperPlatformPanelContainer の props です。
 */
export type DeveloperPlatformPanelContainerProps = {
  /**
   * Developer Platform API の Bearer Authorization に使う access token です。
   */
  accessToken: string
  /**
   * Panel の全表示文言と選択肢です。
   */
  labels: DeveloperPlatformLabels
  /**
   * 初期表示する section です。
   */
  initialSection?: DeveloperPlatformSection
  /**
   * Import destination として選択できる Team 一覧です。
   */
  importTeamOptions?: DeveloperPlatformOption[]
  /**
   * Import destination として選択できる Project 一覧です。
   */
  importProjectOptions?: DeveloperImportProjectOption[]
  /**
   * ISO 8601 timestamp をユーザー向けに整形する callback です。
   */
  formatDateTime?: (value: string) => string
  /**
   * Connector OAuth authorization URL へ遷移する callback です。
   */
  onAuthorizationRedirect?: (authorizationUrl: string) => void
}

/**
 * Developer Platform API を SWR と mutation request runner で panel へ接続します。
 */
export function DeveloperPlatformPanelContainer({
  accessToken,
  formatDateTime,
  initialSection,
  importProjectOptions,
  importTeamOptions,
  labels,
  onAuthorizationRedirect = (authorizationUrl) => {
    window.location.assign(authorizationUrl)
  },
}: DeveloperPlatformPanelContainerProps) {
  const { mutate: mutateCache } = useSWRConfig()
  const mutationSession = useMemo(
    () => ({
      accessToken,
      requestRunner: createMutationRequestRunner(),
    }),
    [accessToken],
  )
  const {
    data: resources,
    error,
    isLoading,
    key: resourceKey,
  } = useDeveloperPlatformResources(mutationSession.accessToken)
  const {
    data: syncConflictPages,
    error: syncConflictError,
    isLoading: isSyncConflictsLoading,
    isValidating: isSyncConflictsValidating,
    mutate: mutateSyncConflicts,
    setSize: setSyncConflictPageCount,
    size: syncConflictPageCount,
  } = useDeveloperSyncConflicts(mutationSession.accessToken)
  const syncConflicts = useMemo(() => {
    const items = syncConflictPages?.flatMap((page) => page.items) ?? []

    return [
      ...new Map(items.map((item) => [item.id, item] as const)).values(),
    ]
  }, [syncConflictPages])
  const syncConflictsHasMore = Boolean(syncConflictPages?.at(-1)?.nextCursor)
  const hasLoadedSyncConflictPage = syncConflictPages !== undefined
  const isLoadingMoreSyncConflicts = Boolean(
    isSyncConflictsValidating &&
      syncConflictPages &&
      syncConflictPages.length < syncConflictPageCount,
  )

  const refresh = async () => {
    if (!resourceKey) {
      return
    }

    await mutateCache(
      resourceKey,
      () => getDeveloperPlatformResources(mutationSession.accessToken),
      { revalidate: false },
    )
  }

  const refreshAfterMutation = async () => {
    try {
      await refresh()
    } catch {
      // Secret 発行 response を refresh failure で失わないよう、mutation result は返します。
    }
  }

  const resetSyncConflicts = async () => {
    await setSyncConflictPageCount(1)
    await mutateSyncConflicts()
  }

  const retrySyncConflicts = async () => {
    await mutateSyncConflicts()
  }

  const runMutation = async <TResult,>(
    operationKey: string,
    fingerprint: string,
    request: Parameters<
      typeof mutationSession.requestRunner.run<TResult>
    >[2],
  ) => {
    const result = await mutationSession.requestRunner.run(
      operationKey,
      fingerprint,
      request,
      shouldRetainDeveloperPlatformMutationContext,
    )

    await refreshAfterMutation()
    return result
  }

  const downloadExport = async (format: DeveloperExportFormat) => {
    const exportedFile = await exportDeveloperWorkItems(
      mutationSession.accessToken,
      format,
    )
    const objectUrl = URL.createObjectURL(exportedFile.blob)
    const anchor = document.createElement('a')

    anchor.href = objectUrl
    anchor.download = exportedFile.fileName
    anchor.click()
    URL.revokeObjectURL(objectUrl)
  }

  return (
    <DeveloperPlatformPanel
      formatDateTime={formatDateTime}
      initialSection={initialSection}
      importProjectOptions={importProjectOptions}
      importTeamOptions={importTeamOptions}
      isLoading={isLoading}
      isLoadingMoreSyncConflicts={isLoadingMoreSyncConflicts}
      isSyncConflictsLoading={isSyncConflictsLoading}
      key={mutationSession.accessToken}
      labels={labels}
      loadErrorMessage={error ? labels.loadError : undefined}
      resources={resources}
      syncConflicts={syncConflicts}
      syncConflictsErrorMessage={
        !hasLoadedSyncConflictPage && syncConflictError
          ? labels.helpText.syncConflictsError
          : undefined
      }
      syncConflictsHasMore={syncConflictsHasMore}
      syncConflictsLoadMoreErrorMessage={
        hasLoadedSyncConflictPage && syncConflictError
          ? labels.helpText.syncConflictsLoadMoreError
          : undefined
      }
      onCommitImport={async (input) => {
        const fingerprint = await createMutationFingerprint(
          input.source.fileName,
          input.source.content,
          JSON.stringify(input.mapping),
          input.teamId,
          input.assignedProjectId ?? '',
        )

        return runMutation(
          'developer-import:create',
          fingerprint,
          (context) =>
            createDeveloperImport(
              mutationSession.accessToken,
              input,
              context,
            ),
        )
      }}
      onConnectConnector={async (provider, input) => {
        const currentUrl = new URL(window.location.href)
        currentUrl.searchParams.set('developerSection', 'connectors')
        const returnUrl =
          `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`
        const authorization = await runMutation(
          `developer-connector:connect:${provider}`,
          JSON.stringify({ ...input, returnUrl }),
          (context) =>
            connectDeveloperConnector(
              mutationSession.accessToken,
              provider,
              { ...input, returnUrl },
              context,
            ),
        )

        onAuthorizationRedirect(authorization.authorizationUrl)
      }}
      onCreateApiKey={(input) =>
        runMutation(
          'developer-api-key:create',
          JSON.stringify(input),
          (context) =>
            createDeveloperApiKey(
              mutationSession.accessToken,
              input,
              context,
            ),
        )
      }
      onCreateOAuthApp={(input) =>
        runMutation(
          'developer-oauth-app:create',
          JSON.stringify(input),
          (context) =>
            createDeveloperOAuthApp(
              mutationSession.accessToken,
              input,
              context,
            ),
        )
      }
      onCreateWebhook={(input) =>
        runMutation(
          'developer-webhook:create',
          JSON.stringify(input),
          (context) =>
            createDeveloperWebhook(
              mutationSession.accessToken,
              input,
              context,
            ),
        )
      }
      onDisconnectConnector={(installationId) =>
        runMutation(
          `developer-connector:disconnect:${installationId}`,
          installationId,
          async (context) => {
            await disconnectDeveloperConnector(
              mutationSession.accessToken,
              installationId,
              context,
            )
          },
        )
      }
      onDryRunImport={async (input) => {
        const fingerprint = await createMutationFingerprint(
          input.source.fileName,
          input.source.content,
          JSON.stringify(input.mapping),
          input.teamId,
          input.assignedProjectId ?? '',
        )

        return runMutation(
          'developer-import:dry-run',
          fingerprint,
          (context) =>
            dryRunDeveloperImport(
              mutationSession.accessToken,
              input,
              context,
            ),
        )
      }}
      onExport={downloadExport}
      onReauthorizeConnector={async (installationId) => {
        const authorization = await runMutation(
          `developer-connector:reauth:${installationId}`,
          installationId,
          (context) =>
            reauthorizeDeveloperConnector(
              mutationSession.accessToken,
              installationId,
              context,
            ),
        )

        onAuthorizationRedirect(authorization.authorizationUrl)
      }}
      onReplayDelivery={(deliveryId) =>
        runMutation(
          `developer-webhook-delivery:replay:${deliveryId}`,
          deliveryId,
          async (context) => {
            await replayDeveloperWebhookDelivery(
              mutationSession.accessToken,
              deliveryId,
              context,
            )
          },
        )
      }
      onResolveSyncConflict={async (input) => {
        const resolvedConflict = await runMutation(
          `developer-sync-conflict:resolve:${input.conflictId}`,
          JSON.stringify(input),
          (context) =>
            resolveDeveloperSyncConflict(
              mutationSession.accessToken,
              input,
              context,
            ),
        )

        await mutateSyncConflicts(
          (current) => current?.map((page) => ({
            ...page,
            items: page.items.map((conflict) =>
              conflict.id === resolvedConflict.id
                ? resolvedConflict
                : conflict,
            ),
          })),
          { revalidate: false },
        )

        try {
          await resetSyncConflicts()
        } catch {
          // Mutation response で状態は更新済みのため、再取得だけ失敗しても成功扱いにします。
        }
      }}
      onRetry={refresh}
      onLoadMoreSyncConflicts={syncConflictsHasMore
        ? async () => {
            await setSyncConflictPageCount(syncConflictPageCount + 1)
          }
        : undefined}
      onRetrySyncConflicts={retrySyncConflicts}
      onRevokeApiKey={(apiKeyId) =>
        runMutation(
          `developer-api-key:revoke:${apiKeyId}`,
          apiKeyId,
          async (context) => {
            await revokeDeveloperApiKey(
              mutationSession.accessToken,
              apiKeyId,
              context,
            )
          },
        )
      }
      onRevokeOAuthApp={(oauthAppId) =>
        runMutation(
          `developer-oauth-app:revoke:${oauthAppId}`,
          oauthAppId,
          async (context) => {
            await revokeDeveloperOAuthApp(
              mutationSession.accessToken,
              oauthAppId,
              context,
            )
          },
        )
      }
      onRevokeWebhook={(subscriptionId) =>
        runMutation(
          `developer-webhook:revoke:${subscriptionId}`,
          subscriptionId,
          async (context) => {
            await revokeDeveloperWebhook(
              mutationSession.accessToken,
              subscriptionId,
              context,
            )
          },
        )
      }
      onRotateApiKey={(apiKeyId) =>
        runMutation(
          `developer-api-key:rotate:${apiKeyId}`,
          apiKeyId,
          (context) =>
            rotateDeveloperApiKey(
              mutationSession.accessToken,
              apiKeyId,
              context,
            ),
        )
      }
      onRotateOAuthApp={(oauthAppId) =>
        runMutation(
          `developer-oauth-app:rotate:${oauthAppId}`,
          oauthAppId,
          (context) =>
            rotateDeveloperOAuthApp(
              mutationSession.accessToken,
              oauthAppId,
              context,
            ),
        )
      }
      onRotateWebhook={(subscriptionId) =>
        runMutation(
          `developer-webhook:rotate:${subscriptionId}`,
          subscriptionId,
          (context) =>
            rotateDeveloperWebhook(
              mutationSession.accessToken,
              subscriptionId,
              context,
            ),
        )
      }
    />
  )
}

/**
 * Credential、webhook、connector、import/export を capability-aware に管理する pure panel です。
 */
export function DeveloperPlatformPanel({
  formatDateTime = formatDeveloperTimestamp,
  initialSection = 'credentials',
  importProjectOptions = [],
  importTeamOptions = [],
  isLoading,
  isLoadingMoreSyncConflicts,
  isSyncConflictsLoading,
  labels,
  loadErrorMessage,
  resources,
  syncConflicts = [],
  syncConflictsErrorMessage,
  syncConflictsHasMore,
  syncConflictsLoadMoreErrorMessage,
  onCommitImport,
  onConnectConnector,
  onCreateApiKey,
  onCreateOAuthApp,
  onCreateWebhook,
  onDisconnectConnector,
  onDryRunImport,
  onExport,
  onLoadMoreSyncConflicts,
  onReauthorizeConnector,
  onReplayDelivery,
  onResolveSyncConflict,
  onRetry,
  onRetrySyncConflicts,
  onRevokeApiKey,
  onRevokeOAuthApp,
  onRevokeWebhook,
  onRotateApiKey,
  onRotateOAuthApp,
  onRotateWebhook,
}: DeveloperPlatformPanelProps) {
  const [activeSection, setActiveSection] =
    useState<DeveloperPlatformSection>(initialSection)
  const [editorDialog, setEditorDialog] = useState<EditorDialogKind>()
  const [secretDialog, setSecretDialog] = useState<SecretDialogState>()
  const [secretCopied, setSecretCopied] = useState(false)
  const [secretCopyError, setSecretCopyError] = useState<string>()
  const [secretStored, setSecretStored] = useState(false)
  const [dialogTrigger, setDialogTrigger] = useState<HTMLElement | null>(null)
  const [busyOperation, setBusyOperation] = useState<string>()
  const [exportingFormat, setExportingFormat] =
    useState<DeveloperExportFormat>()
  const [operationError, setOperationError] = useState<string>()
  const [apiKeyName, setApiKeyName] = useState('')
  const [apiKeyExpiry, setApiKeyExpiry] = useState('')
  const [apiKeyScopes, setApiKeyScopes] = useState<ApiScope[]>(
    labels.scopeOptions[0] ? [labels.scopeOptions[0].value] : [],
  )
  const [oauthName, setOAuthName] = useState('')
  const [oauthExpiry, setOAuthExpiry] = useState('')
  const [oauthScopes, setOAuthScopes] = useState<ApiScope[]>(
    labels.scopeOptions[0] ? [labels.scopeOptions[0].value] : [],
  )
  const [oauthGrantTypes, setOAuthGrantTypes] = useState<
    DeveloperOAuthGrantType[]
  >(
    labels.grantTypeOptions[0] ? [labels.grantTypeOptions[0].value] : [],
  )
  const [webhookName, setWebhookName] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookTeamIds, setWebhookTeamIds] = useState<string[]>(
    importTeamOptions[0] ? [importTeamOptions[0].value] : [],
  )
  const [webhookEvents, setWebhookEvents] = useState<
    DeveloperWebhookEventType[]
  >(
    labels.webhookEventOptions[0]
      ? [labels.webhookEventOptions[0].value]
      : [],
  )
  const [webhookScopes, setWebhookScopes] = useState<ApiScope[]>([
    'work-items:read',
  ])
  const [connectorQuery, setConnectorQuery] = useState('')
  const [conflictResolutions, setConflictResolutions] = useState<
    Partial<Record<string, DeveloperSyncConflictResolution>>
  >({})
  const [conflictMergedValueDrafts, setConflictMergedValueDrafts] =
    useState<Record<string, Record<string, string>>>({})
  const [conflictMergeErrors, setConflictMergeErrors] =
    useState<Record<string, string | undefined>>({})
  const [importFormat, setImportFormat] =
    useState<DeveloperImportFormat>('csv')
  const [importFile, setImportFile] = useState<File>()
  const [importMappings, setImportMappings] = useState<
    DeveloperImportFieldMapping[]
  >([])
  const [importTeamId, setImportTeamId] = useState(
    importTeamOptions[0]?.value ?? '',
  )
  const [importProjectId, setImportProjectId] = useState(
    importProjectOptions.find(
      (option) => option.teamId === importTeamOptions[0]?.value,
    )?.value ?? '',
  )
  const [previewImportReport, setPreviewImportReport] =
    useState<ImportDryRunReport>()
  const [validatedImportInput, setValidatedImportInput] =
    useState<DryRunDeveloperImportInput>()
  const availableImportProjectOptions = importProjectOptions.filter(
    (option) => option.teamId === importTeamId,
  )

  if (isLoading) {
    return (
      <section
        aria-label={labels.loading}
        className="workbench-panel overflow-hidden"
        role="status"
      >
        <div className="border-b border-[var(--workbench-border)] p-6">
          <div className="h-3 w-32 animate-pulse rounded bg-slate-200" />
          <div className="mt-3 h-7 w-72 max-w-full animate-pulse rounded bg-slate-200" />
          <div className="mt-3 h-4 w-[560px] max-w-full animate-pulse rounded bg-slate-100" />
        </div>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] max-[780px]:grid-cols-1">
          <div className="grid content-start gap-2 border-r border-[var(--workbench-border)] p-4 max-[780px]:grid-cols-2 max-[780px]:border-b max-[780px]:border-r-0">
            {Array.from({ length: 4 }, (_, index) => (
              <div
                className="h-10 animate-pulse rounded bg-slate-100"
                key={index}
              />
            ))}
          </div>
          <div className="grid gap-3 p-5">
            {Array.from({ length: 3 }, (_, index) => (
              <div
                className="h-20 animate-pulse rounded-lg bg-slate-100"
                key={index}
              />
            ))}
          </div>
        </div>
      </section>
    )
  }

  if (loadErrorMessage || !resources) {
    return (
      <section className="workbench-panel grid justify-items-start gap-3 p-6">
        <p className="workbench-eyebrow">{labels.eyebrow}</p>
        <h2 className="text-xl font-semibold text-[var(--workbench-text)]">
          {labels.title}
        </h2>
        <p className="text-sm font-semibold text-red-700">
          {loadErrorMessage ?? labels.loadError}
        </p>
        {onRetry ? (
          <button
            className="workbench-button-secondary min-h-10 px-4"
            onClick={() => void onRetry()}
            type="button"
          >
            {labels.retry}
          </button>
        ) : null}
      </section>
    )
  }

  const canManageCredentials =
    resources.capabilities.canManageCredentials
  const canManageWebhooks = resources.capabilities.canManageWebhooks
  const canManageIntegrations =
    resources.capabilities.canManageIntegrations
  const hasAnyMutationCapability = Object.values(
    resources.capabilities,
  ).some(Boolean)
  const latestImport =
    [...resources.imports].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )[0]
  const completeConnectorCatalog = [
    ...labels.connectorCatalog,
    ...resources.connectors
      .filter((installation, index, installations) =>
        !labels.connectorCatalog.some(
          (item) => item.provider === installation.provider,
        ) &&
        installations.findIndex(
          (item) => item.provider === installation.provider,
        ) === index,
      )
      .map((installation) => ({
        provider: installation.provider,
        name: formatConnectorProviderName(installation.provider),
        description: labels.helpText.installedConnector,
        categoryLabel: formatConnectorProviderName(installation.category),
        scopes: installation.scopes,
        searchTerms: [installation.provider, installation.category],
      } satisfies DeveloperConnectorCatalogItem)),
  ]
  const filteredConnectorCatalog = completeConnectorCatalog.filter((item) => {
    const query = connectorQuery.trim().toLocaleLowerCase()

    if (!query) {
      return true
    }

    const installations = resources.connectors.filter(
      (connector) => connector.provider === item.provider,
    )
    const haystack = [
      item.name,
      item.description,
      item.categoryLabel,
      ...item.searchTerms,
      ...installations.flatMap((installation) => [
        installation.name,
        installation.externalAccountName,
        installation.externalAccountId,
      ]),
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()

    return haystack.includes(query)
  })

  const runAction = async <TResult,>(
    operationKey: string,
    action: () => Promise<TResult>,
  ) => {
    setBusyOperation(operationKey)
    setOperationError(undefined)

    try {
      return await action()
    } catch {
      setOperationError(labels.operationError)
      return undefined
    } finally {
      setBusyOperation(undefined)
    }
  }

  const rememberDialogTrigger = () => {
    if (document.activeElement instanceof HTMLElement) {
      setDialogTrigger(document.activeElement)
    }
  }

  const restoreDialogTrigger = () => {
    setDialogTrigger(null)
    window.requestAnimationFrame(() => dialogTrigger?.focus())
  }

  const openEditor = (kind: EditorDialogKind) => {
    rememberDialogTrigger()
    setEditorDialog(kind)
  }

  const closeEditor = () => {
    setEditorDialog(undefined)
    restoreDialogTrigger()
  }

  const openSecret = (
    kind: SecretDialogKind,
    name: string,
    value: string,
  ) => {
    if (!editorDialog) {
      rememberDialogTrigger()
    }
    setEditorDialog(undefined)
    setSecretCopied(false)
    setSecretCopyError(undefined)
    setSecretStored(false)
    setSecretDialog({ kind, name, value })
  }

  const handleCreateApiKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!onCreateApiKey) {
      return
    }

    const result = await runAction('api-key:create', () =>
      onCreateApiKey({
        name: apiKeyName,
        scopes: apiKeyScopes,
        expiresAt: apiKeyExpiry
          ? toLocalEndOfDayIso(apiKeyExpiry)
          : undefined,
      }),
    )

    if (result) {
      setApiKeyName('')
      openSecret('api-key', result.apiKey.name, result.secret)
    }
  }

  const handleCreateOAuthApp = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    if (!onCreateOAuthApp) {
      return
    }

    const result = await runAction('oauth-app:create', () =>
      onCreateOAuthApp({
        name: oauthName,
        grantTypes: oauthGrantTypes,
        scopes: oauthScopes,
        expiresAt: oauthExpiry
          ? toLocalEndOfDayIso(oauthExpiry)
          : undefined,
      }),
    )

    if (result) {
      setOAuthName('')
      setOAuthExpiry('')
      openSecret(
        'oauth-app',
        result.oauthApp.name,
        result.clientSecret,
      )
    }
  }

  const handleCreateWebhook = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    if (!onCreateWebhook) {
      return
    }

    const result = await runAction('webhook:create', () =>
      onCreateWebhook({
        name: webhookName,
        url: webhookUrl,
        teamIds: webhookTeamIds,
        eventTypes: webhookEvents,
        scopes: webhookScopes,
      }),
    )

    if (result) {
      setWebhookName('')
      setWebhookUrl('')
      openSecret(
        'webhook',
        result.subscription.name,
        result.signingSecret,
      )
    }
  }

  const handleDryRun = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!importFile || !onDryRunImport) {
      return
    }

    const content = await importFile.text()
    const input = {
      format: importFormat,
      mapping: importMappings,
      source: {
        content,
        fileName: importFile.name,
        mediaType:
          importFormat === 'csv'
            ? 'text/csv'
            : 'application/json',
      },
      teamId: importTeamId,
      assignedProjectId: importProjectId || undefined,
    } satisfies DryRunDeveloperImportInput
    const result = await runAction('import:dry-run', () =>
      onDryRunImport(input),
    )

    if (result) {
      setPreviewImportReport(result)
      setValidatedImportInput(input)
    }
  }

  const handleExport = async (format: DeveloperExportFormat) => {
    if (!onExport) {
      return
    }

    setExportingFormat(format)
    try {
      await runAction(`export:${format}`, () => onExport(format))
    } finally {
      setExportingFormat((current) =>
        current === format ? undefined : current,
      )
    }
  }

  return (
    <section
      className="workbench-panel overflow-hidden"
      data-testid="developer-platform-panel"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b border-[var(--workbench-border)] px-6 py-5">
        <div className="min-w-0 max-w-[760px]">
          <p className="workbench-eyebrow">{labels.eyebrow}</p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--workbench-text)]">
            {labels.title}
          </h2>
          <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {labels.description}
          </p>
        </div>
        {!hasAnyMutationCapability ? (
          <span className="workbench-badge">{labels.readOnly}</span>
        ) : null}
      </header>

      <div className="grid grid-cols-[220px_minmax(0,1fr)] max-[860px]:grid-cols-1">
        <nav
          aria-label={labels.title}
          className="grid content-start gap-1 border-r border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3 max-[860px]:grid-cols-2 max-[860px]:border-b max-[860px]:border-r-0 max-[520px]:grid-cols-1"
        >
          {(
            [
              'credentials',
              'webhooks',
              'connectors',
              'imports',
            ] as const
          ).map((section) => (
            <button
              aria-current={activeSection === section ? 'page' : undefined}
              className={`min-h-10 rounded-md px-3 text-left text-sm font-semibold transition ${
                activeSection === section
                  ? 'bg-white text-[var(--workbench-primary)] shadow-sm'
                  : 'text-[var(--workbench-muted)] hover:bg-white/70 hover:text-[var(--workbench-text)]'
              }`}
              key={section}
              onClick={() => {
                setActiveSection(section)
                setOperationError(undefined)
              }}
              type="button"
            >
              {labels.tabs[section]}
            </button>
          ))}
        </nav>

        <div className="min-w-0 overflow-hidden p-5 max-[600px]:p-3">
          {operationError ? (
            <div
              className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800"
              role="alert"
            >
              {operationError}
            </div>
          ) : null}

          {activeSection === 'credentials'
            ? renderCredentialsSection({
                apiKeys: resources.apiKeys,
                busyOperation,
                canManage: canManageCredentials,
                formatDateTime,
                labels,
                oauthApps: resources.oauthApps,
                onCreateApiKey: onCreateApiKey
                  ? () => openEditor('api-key')
                  : undefined,
                onCreateOAuthApp: onCreateOAuthApp
                  ? () => openEditor('oauth-app')
                  : undefined,
                onRevokeApiKey: onRevokeApiKey
                  ? (apiKey) =>
                      void runAction(
                        `api-key:revoke:${apiKey.id}`,
                        () => onRevokeApiKey(apiKey.id),
                      )
                  : undefined,
                onRevokeOAuthApp: onRevokeOAuthApp
                  ? (oauthApp) =>
                      void runAction(
                        `oauth-app:revoke:${oauthApp.id}`,
                        () => onRevokeOAuthApp(oauthApp.id),
                      )
                  : undefined,
                onRotateApiKey: onRotateApiKey
                  ? async (apiKey) => {
                      const result = await runAction(
                        `api-key:rotate:${apiKey.id}`,
                        () => onRotateApiKey(apiKey.id),
                      )

                      if (result) {
                        openSecret(
                          'api-key',
                          result.apiKey.name,
                          result.secret,
                        )
                      }
                    }
                  : undefined,
                onRotateOAuthApp: onRotateOAuthApp
                  ? async (oauthApp) => {
                      const result = await runAction(
                        `oauth-app:rotate:${oauthApp.id}`,
                        () => onRotateOAuthApp(oauthApp.id),
                      )

                      if (result) {
                        openSecret(
                          'oauth-app',
                          result.oauthApp.name,
                          result.clientSecret,
                        )
                      }
                    }
                  : undefined,
              })
            : null}

          {activeSection === 'webhooks'
            ? renderWebhooksSection({
                busyOperation,
                canManage: canManageWebhooks,
                deliveries: resources.webhookDeliveries,
                formatDateTime,
                labels,
                onCreate: onCreateWebhook
                  ? () => openEditor('webhook')
                  : undefined,
                onReplay: onReplayDelivery
                  ? (delivery) =>
                      void runAction(
                        `delivery:replay:${delivery.id}`,
                        () => onReplayDelivery(delivery.id),
                      )
                  : undefined,
                onRevoke: onRevokeWebhook
                  ? (subscription) =>
                      void runAction(
                        `webhook:revoke:${subscription.id}`,
                        () => onRevokeWebhook(subscription.id),
                      )
                  : undefined,
                onRotate: onRotateWebhook
                  ? async (subscription) => {
                      const result = await runAction(
                        `webhook:rotate:${subscription.id}`,
                        () => onRotateWebhook(subscription.id),
                      )

                      if (result) {
                        openSecret(
                          'webhook',
                          result.subscription.name,
                          result.signingSecret,
                        )
                      }
                    }
                  : undefined,
                subscriptions: resources.webhookSubscriptions,
              })
            : null}

          {activeSection === 'connectors'
            ? renderConnectorsSection({
                busyOperation,
                canManage: canManageIntegrations,
                catalog: filteredConnectorCatalog,
                conflictMergeErrors,
                conflictMergedValueDrafts,
                conflictResolutions,
                connectors: resources.connectors,
                formatDateTime,
                isLoadingMoreSyncConflicts,
                isSyncConflictsLoading,
                labels,
                query: connectorQuery,
                syncConflicts,
                syncConflictsErrorMessage,
                syncConflictsHasMore,
                syncConflictsLoadMoreErrorMessage,
                onConnect: onConnectConnector
                  ? (item) =>
                      void runAction(
                        `connector:connect:${item.provider}`,
                        () =>
                          onConnectConnector(item.provider, {
                            name: item.name,
                            scopes: item.scopes,
                          }),
                      )
                  : undefined,
                onDisconnect: onDisconnectConnector
                  ? (connector) => {
                      const account =
                        connector.externalAccountName ??
                        connector.externalAccountId ??
                        connector.name
                      if (!window.confirm(
                        labels.helpText.disconnectConfirm.replace(
                          '{name}',
                          account,
                        ),
                      )) {
                        return
                      }
                      void runAction(
                        `connector:disconnect:${connector.id}`,
                        () => onDisconnectConnector(connector.id),
                      )
                    }
                  : undefined,
                onQueryChange: setConnectorQuery,
                onReauthorize: onReauthorizeConnector
                  ? (connector) =>
                      void runAction(
                        `connector:reauth:${connector.id}`,
                        () => onReauthorizeConnector(connector.id),
                      )
                  : undefined,
                onResolveSyncConflict: onResolveSyncConflict
                  ? (conflict) => {
                      const resolution =
                        conflictResolutions[conflict.id]
                      if (!resolution) {
                        return
                      }
                      let mergedValues: Record<string, unknown> | undefined

                      if (resolution === 'merge') {
                        try {
                          mergedValues = parseConflictMergedValues(
                            conflict,
                            conflictMergedValueDrafts[conflict.id],
                          )
                          setConflictMergeErrors((current) => ({
                            ...current,
                            [conflict.id]: undefined,
                          }))
                        } catch {
                          setConflictMergeErrors((current) => ({
                            ...current,
                            [conflict.id]: labels.helpText.mergeInvalid,
                          }))
                          return
                        }
                      }

                      if (!window.confirm(
                        interpolate(
                          labels.helpText.conflictResolveConfirm,
                          {
                            resolution:
                              labels.actions[resolution] ?? resolution,
                            workItem: conflict.workItemId,
                          },
                        ),
                      )) {
                        return
                      }

                      void runAction(
                        `sync-conflict:resolve:${conflict.id}`,
                        () =>
                          onResolveSyncConflict({
                            conflictId: conflict.id,
                            resolution,
                            ...(mergedValues ? { mergedValues } : {}),
                          }),
                      )
                    }
                  : undefined,
                onConflictResolutionChange: (conflictId, resolution) =>
                  setConflictResolutions((current) => ({
                    ...current,
                    [conflictId]: resolution,
                  })),
                onConflictMergedValueChange: (
                  conflictId,
                  field,
                  value,
                ) => {
                  setConflictMergedValueDrafts((current) => ({
                    ...current,
                    [conflictId]: {
                      ...current[conflictId],
                      [field]: value,
                    },
                  }))
                  setConflictMergeErrors((current) => ({
                    ...current,
                    [conflictId]: undefined,
                  }))
                },
                onLoadMoreSyncConflicts,
                onRetrySyncConflicts,
              })
            : null}

          {activeSection === 'imports'
            ? renderImportSection({
                busyOperation,
                canExport: resources.capabilities.canExport,
                canImport: resources.capabilities.canImport,
                format: importFormat,
                exportingFormat,
                importFile,
                importMappings,
                importProjectId,
                importProjectOptions: availableImportProjectOptions,
                importTeamId,
                importTeamOptions,
                labels,
                latestImport,
                previewReport: previewImportReport,
                onCommit:
                  onCommitImport &&
                  validatedImportInput &&
                  previewImportReport?.valid
                    ? () =>
                        void runAction(
                          'import:commit',
                          async () => {
                            await onCommitImport(validatedImportInput)
                            setPreviewImportReport(undefined)
                            setValidatedImportInput(undefined)
                          },
                        )
                    : undefined,
                onExport: onExport ? handleExport : undefined,
                onFileChange: (file) => {
                  setImportFile(file)
                  setPreviewImportReport(undefined)
                  setValidatedImportInput(undefined)
                },
                onFormatChange: (format) => {
                  setImportFormat(format)
                  setPreviewImportReport(undefined)
                  setValidatedImportInput(undefined)
                },
                onMappingChange: (mappings) => {
                  setImportMappings(mappings)
                  setPreviewImportReport(undefined)
                  setValidatedImportInput(undefined)
                },
                onProjectChange: (projectId) => {
                  setImportProjectId(projectId)
                  setPreviewImportReport(undefined)
                  setValidatedImportInput(undefined)
                },
                onSubmit: onDryRunImport ? handleDryRun : undefined,
                onTeamChange: (teamId) => {
                  setImportTeamId(teamId)
                  if (!importProjectOptions.some(
                    (option) =>
                      option.teamId === teamId &&
                      option.value === importProjectId,
                  )) {
                    setImportProjectId('')
                  }
                  setPreviewImportReport(undefined)
                  setValidatedImportInput(undefined)
                },
              })
            : null}
        </div>
      </div>

      {editorDialog ? (
        <EditorDialog
          apiKeyExpiry={apiKeyExpiry}
          apiKeyName={apiKeyName}
          apiKeyScopes={apiKeyScopes}
          busyOperation={busyOperation}
          kind={editorDialog}
          labels={labels}
          oauthExpiry={oauthExpiry}
          oauthGrantTypes={oauthGrantTypes}
          oauthName={oauthName}
          oauthScopes={oauthScopes}
          webhookEvents={webhookEvents}
          webhookName={webhookName}
          webhookScopes={webhookScopes}
          webhookTeamIds={webhookTeamIds}
          webhookTeamOptions={importTeamOptions}
          webhookUrl={webhookUrl}
          onApiKeyExpiryChange={setApiKeyExpiry}
          onApiKeyNameChange={setApiKeyName}
          onApiKeyScopesChange={setApiKeyScopes}
          onOAuthExpiryChange={setOAuthExpiry}
          onOAuthGrantTypesChange={setOAuthGrantTypes}
          onOAuthNameChange={setOAuthName}
          onOAuthScopesChange={setOAuthScopes}
          onRequestClose={closeEditor}
          onSubmitApiKey={handleCreateApiKey}
          onSubmitOAuthApp={handleCreateOAuthApp}
          onSubmitWebhook={handleCreateWebhook}
          onWebhookEventsChange={setWebhookEvents}
          onWebhookNameChange={setWebhookName}
          onWebhookScopesChange={setWebhookScopes}
          onWebhookTeamIdsChange={setWebhookTeamIds}
          onWebhookUrlChange={setWebhookUrl}
        />
      ) : null}

      {secretDialog ? (
        <SecretDialog
          copied={secretCopied}
          copyErrorMessage={secretCopyError}
          labels={labels}
          state={secretDialog}
          stored={secretStored}
          onCopy={async () => {
            try {
              await navigator.clipboard.writeText(secretDialog.value)
              setSecretCopied(true)
              setSecretCopyError(undefined)
            } catch {
              setSecretCopyError(labels.helpText.secretCopyError)
            }
          }}
          onStoredChange={setSecretStored}
          onRequestClose={() => {
            setSecretDialog(undefined)
            setSecretCopied(false)
            setSecretCopyError(undefined)
            setSecretStored(false)
            restoreDialogTrigger()
          }}
        />
      ) : null}
    </section>
  )
}

function renderCredentialsSection({
  apiKeys,
  busyOperation,
  canManage,
  formatDateTime,
  labels,
  oauthApps,
  onCreateApiKey,
  onCreateOAuthApp,
  onRevokeApiKey,
  onRevokeOAuthApp,
  onRotateApiKey,
  onRotateOAuthApp,
}: {
  apiKeys: ApiKeySummary[]
  busyOperation?: string
  canManage: boolean
  formatDateTime: (value: string) => string
  labels: DeveloperPlatformLabels
  oauthApps: OAuthAppSummary[]
  onCreateApiKey?: () => void
  onCreateOAuthApp?: () => void
  onRevokeApiKey?: (apiKey: ApiKeySummary) => void
  onRevokeOAuthApp?: (oauthApp: OAuthAppSummary) => void
  onRotateApiKey?: (apiKey: ApiKeySummary) => void
  onRotateOAuthApp?: (oauthApp: OAuthAppSummary) => void
}) {
  return (
    <div className="grid min-w-0 gap-6">
      <section className="min-w-0">
        <SectionHeader
          action={
            canManage && onCreateApiKey
              ? {
                  label: labels.actions.createApiKey,
                  onClick: onCreateApiKey,
                }
              : undefined
          }
          description={labels.helpText.apiKeys}
          title={labels.headings.apiKeys}
        />
        {apiKeys.length ? (
          <>
          <div className="mt-4 w-full min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--workbench-border)] max-[700px]:hidden">
            <table className="w-full min-w-[920px] border-collapse text-left text-sm">
              <thead className="bg-[var(--workbench-surface-muted)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
                <tr>
                  {[
                    'name',
                    'fingerprint',
                    'created',
                    'creator',
                    'lastUsed',
                    'expiry',
                    'scopes',
                    'actions',
                  ].map((header) => (
                    <th className="px-4 py-3" key={header} scope="col">
                      {labels.tableHeaders[header]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--workbench-border)]">
                {apiKeys.map((apiKey) => (
                  <tr key={apiKey.id}>
                    <td className="px-4 py-3 font-semibold text-[var(--workbench-text)]">
                      <span className="block">{apiKey.name}</span>
                      <StatusBadge
                        labels={labels}
                        status={apiKey.status}
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--workbench-muted)]">
                      {apiKey.prefix}
                    </td>
                    <td className="px-4 py-3 text-[var(--workbench-muted)]">
                      {formatDateTime(apiKey.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-[var(--workbench-muted)]">
                      {apiKey.createdByUserId}
                    </td>
                    <td className="px-4 py-3 text-[var(--workbench-muted)]">
                      {apiKey.lastUsedAt
                        ? formatDateTime(apiKey.lastUsedAt)
                        : labels.helpText.never}
                    </td>
                    <td className="px-4 py-3 text-[var(--workbench-muted)]">
                      {apiKey.expiresAt
                        ? formatDateTime(apiKey.expiresAt)
                        : labels.helpText.noExpiry}
                    </td>
                    <td className="px-4 py-3">
                      <ScopeBadges labels={labels} scopes={apiKey.scopes} />
                    </td>
                    <td className="px-4 py-3">
                      {canManage && apiKey.status === 'active' ? (
                        <ActionButtons
                          busy={busyOperation?.endsWith(apiKey.id)}
                          labels={labels}
                          onRevoke={
                            onRevokeApiKey
                              ? () => onRevokeApiKey(apiKey)
                              : undefined
                          }
                          onRotate={
                            onRotateApiKey
                              ? () => onRotateApiKey(apiKey)
                              : undefined
                          }
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 hidden gap-3 max-[700px]:grid">
            {apiKeys.map((apiKey) => (
              <article
                className="rounded-lg border border-[var(--workbench-border)] p-4"
                key={apiKey.id}
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="font-semibold text-[var(--workbench-text)]">
                      {apiKey.name}
                    </h4>
                    <p className="mt-1 break-all font-mono text-xs text-[var(--workbench-muted)]">
                      {apiKey.prefix}
                    </p>
                  </div>
                  <StatusBadge labels={labels} status={apiKey.status} />
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs text-[var(--workbench-muted)]">
                  <div>
                    <dt className="font-semibold">{labels.tableHeaders.created}</dt>
                    <dd>{formatDateTime(apiKey.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold">{labels.tableHeaders.creator}</dt>
                    <dd className="break-all">{apiKey.createdByUserId}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold">{labels.tableHeaders.lastUsed}</dt>
                    <dd>
                      {apiKey.lastUsedAt
                        ? formatDateTime(apiKey.lastUsedAt)
                        : labels.helpText.never}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold">{labels.tableHeaders.expiry}</dt>
                    <dd>
                      {apiKey.expiresAt
                        ? formatDateTime(apiKey.expiresAt)
                        : labels.helpText.noExpiry}
                    </dd>
                  </div>
                </dl>
                <div className="mt-4">
                  <ScopeBadges labels={labels} scopes={apiKey.scopes} />
                </div>
                {canManage && apiKey.status === 'active' ? (
                  <div className="mt-4 border-t border-[var(--workbench-border)] pt-3">
                    <ActionButtons
                      busy={busyOperation?.endsWith(apiKey.id)}
                      labels={labels}
                      onRevoke={
                        onRevokeApiKey
                          ? () => onRevokeApiKey(apiKey)
                          : undefined
                      }
                      onRotate={
                        onRotateApiKey
                          ? () => onRotateApiKey(apiKey)
                          : undefined
                      }
                    />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          </>
        ) : (
          <EmptyState
            description={labels.helpText.apiKeysEmpty}
            title={labels.headings.apiKeysEmpty}
          />
        )}
      </section>

      <section className="min-w-0 border-t border-[var(--workbench-border)] pt-6">
        <SectionHeader
          action={
            canManage && onCreateOAuthApp
              ? {
                  label: labels.actions.createOAuthApp,
                  onClick: onCreateOAuthApp,
                }
              : undefined
          }
          description={labels.helpText.oauthApps}
          title={labels.headings.oauthApps}
        />
        {oauthApps.length ? (
          <div className="mt-4 grid gap-3">
            {oauthApps.map((oauthApp) => (
              <article
                className="rounded-lg border border-[var(--workbench-border)] p-4"
                key={oauthApp.id}
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-semibold text-[var(--workbench-text)]">
                        {oauthApp.name}
                      </h4>
                      <StatusBadge
                        labels={labels}
                        status={oauthApp.status}
                      />
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-[var(--workbench-muted)]">
                      {oauthApp.clientId}
                    </p>
                    <div className="mt-3">
                      <ScopeBadges
                        labels={labels}
                        scopes={oauthApp.scopes}
                      />
                    </div>
                    <dl className="mt-3 grid gap-x-5 gap-y-2 text-xs text-[var(--workbench-muted)] sm:grid-cols-3">
                      <div>
                        <dt className="font-semibold">
                          {labels.tableHeaders.updated}
                        </dt>
                        <dd>{formatDateTime(oauthApp.updatedAt)}</dd>
                      </div>
                      <div>
                        <dt className="font-semibold">
                          {labels.tableHeaders.lastUsed}
                        </dt>
                        <dd>
                          {oauthApp.lastUsedAt
                            ? formatDateTime(oauthApp.lastUsedAt)
                            : labels.helpText.never}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-semibold">
                          {labels.tableHeaders.expiry}
                        </dt>
                        <dd>
                          {oauthApp.expiresAt
                            ? formatDateTime(oauthApp.expiresAt)
                            : labels.helpText.noExpiry}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  {canManage && oauthApp.status === 'active' ? (
                    <ActionButtons
                      busy={busyOperation?.endsWith(oauthApp.id)}
                      labels={labels}
                      onRevoke={
                        onRevokeOAuthApp
                          ? () => onRevokeOAuthApp(oauthApp)
                          : undefined
                      }
                      onRotate={
                        onRotateOAuthApp
                          ? () => onRotateOAuthApp(oauthApp)
                          : undefined
                      }
                    />
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            description={labels.helpText.oauthAppsEmpty}
            title={labels.headings.oauthAppsEmpty}
          />
        )}
      </section>
    </div>
  )
}

function renderWebhooksSection({
  busyOperation,
  canManage,
  deliveries,
  formatDateTime,
  labels,
  onCreate,
  onReplay,
  onRevoke,
  onRotate,
  subscriptions,
}: {
  busyOperation?: string
  canManage: boolean
  deliveries: WebhookDelivery[]
  formatDateTime: (value: string) => string
  labels: DeveloperPlatformLabels
  onCreate?: () => void
  onReplay?: (delivery: WebhookDelivery) => void
  onRevoke?: (subscription: WebhookSubscription) => void
  onRotate?: (subscription: WebhookSubscription) => void
  subscriptions: WebhookSubscription[]
}) {
  return (
    <div className="grid min-w-0 gap-6">
      <section className="min-w-0">
        <SectionHeader
          action={
            canManage && onCreate
              ? { label: labels.actions.createWebhook, onClick: onCreate }
              : undefined
          }
          description={labels.helpText.webhooks}
          title={labels.headings.webhooks}
        />
        <p className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs font-medium leading-5 text-blue-900">
          {labels.helpText.webhookSigning}
        </p>
        {subscriptions.length ? (
          <div className="mt-4 grid gap-3">
            {subscriptions.map((subscription) => (
              <article
                className="rounded-lg border border-[var(--workbench-border)] p-4"
                key={subscription.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-semibold text-[var(--workbench-text)]">
                        {subscription.name}
                      </h4>
                      <StatusBadge
                        labels={labels}
                        status={subscription.status}
                      />
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-[var(--workbench-muted)]">
                      {subscription.url}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {subscription.eventTypes.map((eventType) => (
                        <span className="workbench-badge" key={eventType}>
                          {labels.webhookEventOptions.find(
                            (option) => option.value === eventType,
                          )?.label ?? eventType}
                        </span>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-[var(--workbench-muted)]">
                      {labels.tableHeaders.failures}:{' '}
                      {subscription.failureCount}
                      {' · '}
                      {labels.tableHeaders.lastDelivery}:{' '}
                      {subscription.lastDeliveryAt
                        ? formatDateTime(subscription.lastDeliveryAt)
                        : labels.helpText.never}
                    </p>
                  </div>
                  {canManage && subscription.status === 'active' ? (
                    <ActionButtons
                      busy={busyOperation?.endsWith(subscription.id)}
                      labels={labels}
                      onRevoke={
                        onRevoke
                          ? () => onRevoke(subscription)
                          : undefined
                      }
                      onRotate={
                        onRotate
                          ? () => onRotate(subscription)
                          : undefined
                      }
                    />
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            description={labels.helpText.webhooksEmpty}
            title={labels.headings.webhooksEmpty}
          />
        )}
      </section>

      <section className="min-w-0 border-t border-[var(--workbench-border)] pt-6">
        <SectionHeader
          description={labels.helpText.deliveries}
          title={labels.headings.deliveries}
        />
        {deliveries.length ? (
          <div className="mt-4 w-full min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--workbench-border)]">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead className="bg-[var(--workbench-surface-muted)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
                <tr>
                  {[
                    'event',
                    'status',
                    'attempts',
                    'response',
                    'created',
                    'actions',
                  ].map((header) => (
                    <th className="px-4 py-3" key={header} scope="col">
                      {labels.tableHeaders[header]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--workbench-border)]">
                {deliveries.map((delivery) => (
                  <tr
                    className={
                      delivery.status === 'failed' ? 'bg-red-50/60' : ''
                    }
                    key={delivery.id}
                  >
                    <td className="px-4 py-3">
                      <span className="block font-semibold">
                        {delivery.eventType}
                      </span>
                      <span className="mt-1 block font-mono text-xs text-[var(--workbench-muted)]">
                        {delivery.eventId}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        labels={labels}
                        status={delivery.status}
                      />
                    </td>
                    <td className="px-4 py-3 text-[var(--workbench-muted)]">
                      {delivery.attempts}
                    </td>
                    <td className="px-4 py-3 text-[var(--workbench-muted)]">
                      {delivery.responseStatus ?? labels.helpText.pending}
                    </td>
                    <td className="px-4 py-3 text-[var(--workbench-muted)]">
                      {formatDateTime(delivery.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      {canManage &&
                      onReplay &&
                      delivery.status === 'failed' ? (
                        <button
                          className="workbench-button-secondary min-h-9 px-3 disabled:opacity-50"
                          disabled={busyOperation?.endsWith(delivery.id)}
                          onClick={() => onReplay(delivery)}
                          type="button"
                        >
                          {labels.actions.replay}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            description={labels.helpText.deliveriesEmpty}
            title={labels.headings.deliveriesEmpty}
          />
        )}
      </section>
    </div>
  )
}

function renderConnectorsSection({
  busyOperation,
  canManage,
  catalog,
  conflictMergeErrors,
  conflictMergedValueDrafts,
  conflictResolutions,
  connectors,
  formatDateTime,
  isLoadingMoreSyncConflicts,
  isSyncConflictsLoading,
  labels,
  query,
  syncConflicts,
  syncConflictsErrorMessage,
  syncConflictsHasMore,
  syncConflictsLoadMoreErrorMessage,
  onConnect,
  onConflictMergedValueChange,
  onConflictResolutionChange,
  onDisconnect,
  onLoadMoreSyncConflicts,
  onQueryChange,
  onReauthorize,
  onResolveSyncConflict,
  onRetrySyncConflicts,
}: {
  busyOperation?: string
  canManage: boolean
  catalog: DeveloperConnectorCatalogItem[]
  conflictMergeErrors: Record<string, string | undefined>
  conflictMergedValueDrafts: Record<string, Record<string, string>>
  conflictResolutions: Partial<
    Record<string, DeveloperSyncConflictResolution>
  >
  connectors: ConnectorInstallation[]
  formatDateTime: (value: string) => string
  isLoadingMoreSyncConflicts?: boolean
  isSyncConflictsLoading?: boolean
  labels: DeveloperPlatformLabels
  query: string
  syncConflicts: WorkItemSyncConflict[]
  syncConflictsErrorMessage?: string
  syncConflictsHasMore?: boolean
  syncConflictsLoadMoreErrorMessage?: string
  onConnect?: (item: DeveloperConnectorCatalogItem) => void
  onConflictMergedValueChange: (
    conflictId: string,
    field: string,
    value: string,
  ) => void
  onConflictResolutionChange: (
    conflictId: string,
    value: DeveloperSyncConflictResolution,
  ) => void
  onDisconnect?: (connector: ConnectorInstallation) => void
  onLoadMoreSyncConflicts?: () => Promise<void> | void
  onQueryChange: (value: string) => void
  onReauthorize?: (connector: ConnectorInstallation) => void
  onResolveSyncConflict?: (conflict: WorkItemSyncConflict) => void
  onRetrySyncConflicts?: () => Promise<void> | void
}) {
  return (
    <div className="grid min-w-0 gap-8">
      <section className="min-w-0">
        <SectionHeader
          description={labels.helpText.syncConflicts}
          title={labels.headings.syncConflicts}
        />

        {isSyncConflictsLoading ? (
          <div
            aria-label={labels.helpText.syncConflictsLoading}
            className="mt-4 grid gap-3"
            role="status"
          >
            <div className="h-28 animate-pulse rounded-lg bg-slate-100" />
            <div className="h-28 animate-pulse rounded-lg bg-slate-100" />
          </div>
        ) : syncConflictsErrorMessage ? (
          <div
            className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
            role="alert"
          >
            <p className="text-sm font-semibold text-red-800">
              {syncConflictsErrorMessage}
            </p>
            {onRetrySyncConflicts ? (
              <button
                className="workbench-button-secondary min-h-9 px-3"
                onClick={() => void onRetrySyncConflicts()}
                type="button"
              >
                {labels.retry}
              </button>
            ) : null}
          </div>
        ) : syncConflicts.length ? (
          <div className="mt-4 grid gap-3">
            {syncConflicts.map((conflict) => {
              const resolution = conflictResolutions[conflict.id]
              const isOpen = conflict.status === 'open'

              return (
                <article
                  className={`rounded-lg border p-4 ${
                    isOpen
                      ? 'border-amber-300 bg-amber-50/50'
                      : 'border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)]'
                  }`}
                  key={conflict.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--workbench-text)]">
                        {labels.fields.workItem}:{' '}
                        <span className="font-mono">
                          {conflict.workItemId}
                        </span>
                      </p>
                      <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                        {labels.fields.detectedAt}:{' '}
                        {formatDateTime(conflict.detectedAt)}
                      </p>
                    </div>
                    <StatusBadge labels={labels} status={conflict.status} />
                  </div>

                  <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-[var(--workbench-border)] pt-4 text-xs max-[640px]:grid-cols-1">
                    <div>
                      <dt className="font-semibold text-[var(--workbench-muted)]">
                        {labels.fields.externalLink}
                      </dt>
                      <dd className="mt-1 break-all font-mono text-[var(--workbench-text)]">
                        {conflict.externalLinkId}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-[var(--workbench-muted)]">
                        {labels.fields.revisions}
                      </dt>
                      <dd className="mt-1 text-[var(--workbench-text)]">
                        {labels.fields.localRevision}{' '}
                        <span className="font-mono">
                          {conflict.localRevision}
                        </span>
                        {' · '}
                        {labels.fields.externalRevision}{' '}
                        <span className="font-mono">
                          {conflict.externalRevision}
                        </span>
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-4 grid gap-2">
                    {conflict.fields.map((field) => (
                      <div
                        className="rounded-md border border-[var(--workbench-border)] bg-white p-3"
                        key={field.field}
                      >
                        <p className="font-mono text-xs font-semibold text-[var(--workbench-text)]">
                          {field.field}
                        </p>
                        <dl className="mt-2 grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
                          <div>
                            <dt className="text-xs font-semibold text-[var(--workbench-muted)]">
                              {labels.fields.localValue}
                            </dt>
                            <dd className="mt-1 break-words whitespace-pre-wrap text-sm text-[var(--workbench-text)]">
                              {formatSyncConflictValue(
                                field.localValue,
                                labels.helpText.notAvailable,
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs font-semibold text-[var(--workbench-muted)]">
                              {labels.fields.externalValue}
                            </dt>
                            <dd className="mt-1 break-words whitespace-pre-wrap text-sm text-[var(--workbench-text)]">
                              {formatSyncConflictValue(
                                field.externalValue,
                                labels.helpText.notAvailable,
                              )}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    ))}
                  </div>

                  {isOpen && resolution === 'merge' ? (
                    <fieldset className="mt-4 grid gap-3 rounded-lg border border-[#99d7cf] bg-[#f4fbfa] p-3">
                      <legend className="px-1 text-xs font-semibold text-[#116b63]">
                        {labels.fields.mergedValues}
                      </legend>
                      <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                        {labels.helpText.mergedValues}
                      </p>
                      {conflict.fields.map((field) => (
                        <label
                          className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]"
                          key={field.field}
                        >
                          <span className="font-mono">{field.field}</span>
                          <textarea
                            className="workbench-input min-h-20 px-3 py-2 font-mono text-xs"
                            spellCheck={false}
                            value={
                              conflictMergedValueDrafts[conflict.id]?.[
                                field.field
                              ] ?? formatConflictMergeDraft(field.localValue)
                            }
                            onChange={(event) =>
                              onConflictMergedValueChange(
                                conflict.id,
                                field.field,
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      ))}
                      {conflictMergeErrors[conflict.id] ? (
                        <p className="text-xs font-semibold text-red-700" role="alert">
                          {conflictMergeErrors[conflict.id]}
                        </p>
                      ) : null}
                    </fieldset>
                  ) : null}

                  {isOpen && canManage && onResolveSyncConflict ? (
                    <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-[var(--workbench-border)] pt-4">
                      <label className="grid min-w-[220px] flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
                        {labels.fields.conflictResolution}
                        <select
                          className="workbench-input min-h-9 px-3"
                          value={resolution ?? ''}
                          onChange={(event) =>
                            onConflictResolutionChange(
                              conflict.id,
                              event.target
                                .value as DeveloperSyncConflictResolution,
                            )
                          }
                        >
                          <option disabled value="">
                            {labels.actions.chooseResolution}
                          </option>
                          {(
                            [
                              'keep-local',
                              'keep-remote',
                              'merge',
                              'ignore',
                            ] as const
                          ).map((option) => (
                            <option key={option} value={option}>
                              {labels.actions[option]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="workbench-button-primary min-h-9 px-3"
                        disabled={
                          !resolution ||
                          busyOperation?.endsWith(conflict.id)
                        }
                        onClick={() => onResolveSyncConflict(conflict)}
                        type="button"
                      >
                        {labels.actions.resolve}
                      </button>
                    </div>
                  ) : null}
                </article>
              )
            })}
            {syncConflictsLoadMoreErrorMessage ? (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
                role="alert"
              >
                <p className="text-sm font-semibold text-red-800">
                  {syncConflictsLoadMoreErrorMessage}
                </p>
                {onRetrySyncConflicts ? (
                  <button
                    className="workbench-button-secondary min-h-9 px-3"
                    onClick={() => void onRetrySyncConflicts()}
                    type="button"
                  >
                    {labels.retry}
                  </button>
                ) : null}
              </div>
            ) : null}
            {syncConflictsHasMore && onLoadMoreSyncConflicts ? (
              <button
                className="workbench-button-secondary min-h-10 w-full px-4 disabled:opacity-50"
                disabled={isLoadingMoreSyncConflicts}
                onClick={() => void onLoadMoreSyncConflicts()}
                type="button"
              >
                {isLoadingMoreSyncConflicts
                  ? labels.actions.loadingMore
                  : labels.actions.loadMore}
              </button>
            ) : null}
          </div>
        ) : (
          <EmptyState
            description={labels.helpText.syncConflictsEmpty}
            title={labels.headings.syncConflictsEmpty}
          />
        )}
      </section>

      <section className="min-w-0">
        <SectionHeader
          description={labels.helpText.connectors}
          title={labels.headings.connectors}
        />
        <label className="mt-4 grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {labels.fields.resourceSearch}
          <input
            className="workbench-input min-h-10 px-3 normal-case tracking-normal"
            placeholder={labels.placeholders.resourceSearch}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>

        {catalog.length ? (
          <div className="mt-4 grid grid-cols-2 gap-4 max-[1180px]:grid-cols-1">
            {catalog.map((item) => {
              const providerConnectors = connectors.filter(
                (installation) => installation.provider === item.provider,
              )
              const needsAttention = providerConnectors.some(
                (connector) =>
                  connector.status === 'needs-reauth' ||
                  connector.status === 'degraded' ||
                  connector.status === 'conflict',
              )

              return (
                <article
                  className={`rounded-lg border p-4 ${
                    needsAttention
                      ? 'border-amber-300 bg-amber-50/50'
                      : 'border-[var(--workbench-border)]'
                  }`}
                  key={item.provider}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="workbench-badge">
                        {item.categoryLabel}
                      </span>
                      <h4 className="mt-3 font-semibold text-[var(--workbench-text)]">
                        {item.name}
                      </h4>
                      <p className="mt-1 text-sm font-medium leading-5 text-[var(--workbench-muted)]">
                        {item.description}
                      </p>
                    </div>
                    <span className="workbench-badge">
                      {labels.helpText.connectorCount.replace(
                        '{count}',
                        String(providerConnectors.length),
                      )}
                    </span>
                  </div>

                  {providerConnectors.length ? (
                    <div className="mt-4 grid gap-3 border-t border-[var(--workbench-border)] pt-4">
                      {providerConnectors.map((connector) => {
                        const needsRecovery =
                          connector.status === 'needs-reauth' ||
                          connector.status === 'degraded'
                        const hasConflict = connector.status === 'conflict'
                        const isDisconnected =
                          connector.status === 'disconnected'

                        return (
                          <div
                            className="rounded-md border border-[var(--workbench-border)] bg-white p-3"
                            data-testid={`connector-installation-${connector.id}`}
                            key={connector.id}
                          >
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-[var(--workbench-text)]">
                                  {connector.externalAccountName ??
                                    connector.externalAccountId ??
                                    connector.name}
                                </p>
                                <p className="mt-1 truncate text-xs font-medium text-[var(--workbench-muted)]">
                                  {connector.name}
                                </p>
                              </div>
                              <StatusBadge labels={labels} status={connector.status} />
                            </div>
                            <p className="mt-3 text-xs font-medium text-[var(--workbench-muted)]">
                              {labels.tableHeaders.lastSync}:{' '}
                              {connector.lastSyncAt
                                ? formatDateTime(connector.lastSyncAt)
                                : labels.helpText.never}
                            </p>
                            {connector.lastError ? (
                              <p className="mt-2 text-xs font-semibold text-amber-800">
                                {connector.lastError.detail ?? connector.lastError.title}
                              </p>
                            ) : null}
                            {hasConflict ? (
                              <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs font-semibold text-amber-900">
                                {labels.helpText.connectorConflict}
                              </p>
                            ) : null}
                            {canManage ? (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {isDisconnected && onReauthorize ? (
                                  <button
                                    className="workbench-button-primary min-h-9 px-3"
                                    disabled={busyOperation?.endsWith(connector.id)}
                                    onClick={() => onReauthorize(connector)}
                                    type="button"
                                  >
                                    {labels.actions.connectAgain}
                                  </button>
                                ) : null}
                                {!isDisconnected && needsRecovery && onReauthorize ? (
                                  <button
                                    className="workbench-button-primary min-h-9 px-3"
                                    disabled={busyOperation?.endsWith(connector.id)}
                                    onClick={() => onReauthorize(connector)}
                                    type="button"
                                  >
                                    {labels.actions.reauthorize}
                                  </button>
                                ) : null}
                                {!isDisconnected && onDisconnect ? (
                                  <button
                                    className="workbench-button-secondary min-h-9 px-3"
                                    disabled={busyOperation?.endsWith(connector.id)}
                                    onClick={() => onDisconnect(connector)}
                                    type="button"
                                  >
                                    {labels.actions.disconnect}
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="mt-4 border-t border-[var(--workbench-border)] pt-4 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                      {labels.helpText.noConnectorAccounts}
                    </p>
                  )}

                  {canManage && onConnect ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        className={providerConnectors.length
                          ? 'workbench-button-secondary min-h-9 px-3'
                          : 'workbench-button-primary min-h-9 px-3'}
                        disabled={busyOperation?.endsWith(item.provider)}
                        onClick={() => onConnect(item)}
                        type="button"
                      >
                        {providerConnectors.length
                          ? labels.actions.addAccount
                          : labels.actions.connect}
                      </button>
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
        ) : (
          <EmptyState
            description={labels.helpText.connectorSearchEmpty}
            title={labels.headings.connectorSearchEmpty}
          />
        )}
      </section>
    </div>
  )
}

function renderImportSection({
  busyOperation,
  canExport,
  canImport,
  exportingFormat,
  format,
  importFile,
  importMappings,
  importProjectId,
  importProjectOptions,
  importTeamId,
  importTeamOptions,
  labels,
  latestImport,
  previewReport,
  onCommit,
  onExport,
  onFileChange,
  onFormatChange,
  onMappingChange,
  onProjectChange,
  onSubmit,
  onTeamChange,
}: {
  busyOperation?: string
  canExport: boolean
  canImport: boolean
  exportingFormat?: DeveloperExportFormat
  format: DeveloperImportFormat
  importFile?: File
  importMappings: DeveloperImportFieldMapping[]
  importProjectId: string
  importProjectOptions: DeveloperImportProjectOption[]
  importTeamId: string
  importTeamOptions: DeveloperPlatformOption[]
  labels: DeveloperPlatformLabels
  latestImport?: ImportJob
  previewReport?: ImportDryRunReport
  onCommit?: () => void
  onExport?: (format: DeveloperExportFormat) => Promise<void>
  onFileChange: (file?: File) => void
  onFormatChange: (format: DeveloperImportFormat) => void
  onMappingChange: (mapping: DeveloperImportFieldMapping[]) => void
  onProjectChange: (projectId: string) => void
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
  onTeamChange: (teamId: string) => void
}) {
  const report = previewReport ?? latestImport?.report
  const reportStatus = previewReport
    ? previewReport.valid
      ? 'completed'
      : 'failed'
    : latestImport?.status

  return (
    <div className="grid min-w-0 gap-6">
      <section className="min-w-0">
        <SectionHeader
          description={labels.helpText.imports}
          title={labels.headings.imports}
        />
        <div className="mt-4 grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
          {(['csv', 'json'] as const).map((sourceFormat) => (
            <button
              aria-pressed={format === sourceFormat}
              className={`rounded-lg border p-4 text-left transition ${
                format === sourceFormat
                  ? 'border-[var(--workbench-primary)] bg-teal-50'
                  : 'border-[var(--workbench-border)] hover:border-[var(--workbench-border-strong)]'
              }`}
              disabled={!canImport}
              key={sourceFormat}
              onClick={() => onFormatChange(sourceFormat)}
              type="button"
            >
              <strong className="block text-sm text-[var(--workbench-text)]">
                {labels.headings[`source-${sourceFormat}`]}
              </strong>
              <span className="mt-2 block text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                {labels.helpText[`source-${sourceFormat}`]}
              </span>
            </button>
          ))}
        </div>

        {canImport && onSubmit ? (
          <form
            className="mt-4 grid gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4"
            onSubmit={onSubmit}
          >
            {importTeamOptions.length || importProjectOptions.length ? (
              <div className="grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
                {importTeamOptions.length ? (
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                    {labels.fields.importTeam}
                    <select
                      className="workbench-input min-h-10 bg-white px-3 normal-case tracking-normal"
                      required
                      value={importTeamId}
                      onChange={(event) =>
                        onTeamChange(event.target.value)
                      }
                    >
                      {importTeamOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {importProjectOptions.length ? (
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                    {labels.fields.importProject}
                    <select
                      className="workbench-input min-h-10 bg-white px-3 normal-case tracking-normal"
                      value={importProjectId}
                      onChange={(event) =>
                        onProjectChange(event.target.value)
                      }
                    >
                      <option value="">
                        {labels.placeholders.importProject}
                      </option>
                      {importProjectOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            ) : null}
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
              {labels.fields.importFile}
              <input
                accept={format === 'csv' ? '.csv,text/csv' : '.json,application/json'}
                className="workbench-input min-h-10 bg-white px-3 py-2 normal-case tracking-normal"
                required
                type="file"
                onChange={(event) => onFileChange(event.target.files?.[0])}
              />
            </label>

            <div className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-[var(--workbench-text)]">
                    {labels.headings.mapping}
                  </h4>
                  <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                    {labels.helpText.mapping}
                  </p>
                </div>
                <button
                  className="workbench-button-secondary min-h-9 px-3"
                  onClick={() =>
                    onMappingChange([
                      ...importMappings,
                      { sourceField: '', targetField: '' },
                    ])
                  }
                  type="button"
                >
                  {labels.actions.addMapping}
                </button>
              </div>

              {importMappings.map((mapping, index) => (
                <div
                  className="grid grid-cols-[1fr_24px_1fr_auto] items-end gap-2 max-[660px]:grid-cols-1"
                  key={index}
                >
                  <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
                    {labels.fields.sourceField}
                    <input
                      className="workbench-input min-h-9 bg-white px-3"
                      placeholder={labels.placeholders.sourceField}
                      required
                      value={mapping.sourceField}
                      onChange={(event) =>
                        onMappingChange(
                          updateImportMapping(
                            importMappings,
                            index,
                            'sourceField',
                            event.target.value,
                          ),
                        )
                      }
                    />
                  </label>
                  <span
                    aria-hidden="true"
                    className="pb-2 text-center text-[var(--workbench-muted)] max-[660px]:hidden"
                  >
                    →
                  </span>
                  <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
                    {labels.fields.targetField}
                    <select
                      className="workbench-input min-h-9 bg-white px-3"
                      required
                      value={mapping.targetField}
                      onChange={(event) =>
                        onMappingChange(
                          updateImportMapping(
                            importMappings,
                            index,
                            'targetField',
                            event.target.value,
                          ),
                        )
                      }
                    >
                      <option value="">
                        {labels.placeholders.targetField}
                      </option>
                      {labels.importFieldOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="workbench-button-secondary min-h-9 px-3"
                    onClick={() =>
                      onMappingChange(
                        importMappings.filter(
                          (_, mappingIndex) => mappingIndex !== index,
                        ),
                      )
                    }
                    type="button"
                  >
                    {labels.actions.removeMapping}
                  </button>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--workbench-border)] pt-4">
              <p className="text-xs font-medium text-[var(--workbench-muted)]">
                {importFile?.name ?? labels.helpText.noFile}
              </p>
              <button
                className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
                disabled={
                  !importFile ||
                  !importTeamId ||
                  !importMappings.length ||
                  busyOperation === 'import:dry-run'
                }
                type="submit"
              >
                {labels.actions.dryRun}
              </button>
            </div>
          </form>
        ) : (
          <p className="mt-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4 text-sm font-medium text-[var(--workbench-muted)]">
            {labels.helpText.importReadOnly}
          </p>
        )}
      </section>

      {report || latestImport ? (
        <section className="border-t border-[var(--workbench-border)] pt-6">
          <SectionHeader
            description={labels.helpText.importReport}
            title={labels.headings.importReport}
          />
          <div
            className={`mt-4 rounded-lg border p-4 ${
              report?.invalidRows
                ? 'border-red-200 bg-red-50'
                : 'border-emerald-200 bg-emerald-50'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[var(--workbench-text)]">
                {report
                  ? interpolate(labels.importReportSummary, {
                      invalid: report.invalidRows,
                      total: report.totalRows,
                      valid: report.validRows,
                    })
                  : latestImport?.error?.detail ??
                    latestImport?.error?.title ??
                    labels.helpText.importPending}
              </p>
              {reportStatus ? (
                <StatusBadge
                  labels={labels}
                  status={reportStatus}
                />
              ) : null}
            </div>
            {report?.errors.length ? (
              <ul className="mt-4 grid gap-2">
                {report.errors.map((error, index) => (
                  <li
                    className="rounded-md border border-red-200 bg-white px-3 py-2 text-xs text-red-800"
                    key={`${error.row}-${error.code}-${index}`}
                  >
                    <strong>
                      {labels.tableHeaders.row} {error.row}
                      {error.field ? ` · ${error.field}` : ''}
                    </strong>
                    <span className="ml-2">{error.message}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {canImport &&
            onCommit &&
            report &&
            report.invalidRows === 0 &&
            previewReport?.valid ? (
              <button
                className="workbench-button-primary mt-4 min-h-10 px-4"
                disabled={busyOperation?.startsWith('import:commit')}
                onClick={onCommit}
                type="button"
              >
                {labels.actions.commitImport}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="border-t border-[var(--workbench-border)] pt-6">
        <SectionHeader
          description={labels.helpText.exports}
          title={labels.headings.exports}
        />
        <div className="mt-4 flex flex-wrap gap-3">
          {(['csv', 'json'] as const).map((exportFormat) => (
            <button
              className="workbench-button-secondary min-h-10 px-4 disabled:opacity-50"
              disabled={
                !canExport ||
                !onExport ||
                exportingFormat === exportFormat
              }
              key={exportFormat}
              onClick={() => void onExport?.(exportFormat)}
              type="button"
            >
              {labels.actions[`export-${exportFormat}`]}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function EditorDialog({
  apiKeyExpiry,
  apiKeyName,
  apiKeyScopes,
  busyOperation,
  kind,
  labels,
  oauthExpiry,
  oauthGrantTypes,
  oauthName,
  oauthScopes,
  webhookEvents,
  webhookName,
  webhookScopes,
  webhookTeamIds,
  webhookTeamOptions,
  webhookUrl,
  onApiKeyExpiryChange,
  onApiKeyNameChange,
  onApiKeyScopesChange,
  onOAuthExpiryChange,
  onOAuthGrantTypesChange,
  onOAuthNameChange,
  onOAuthScopesChange,
  onRequestClose,
  onSubmitApiKey,
  onSubmitOAuthApp,
  onSubmitWebhook,
  onWebhookEventsChange,
  onWebhookNameChange,
  onWebhookScopesChange,
  onWebhookTeamIdsChange,
  onWebhookUrlChange,
}: {
  apiKeyExpiry: string
  apiKeyName: string
  apiKeyScopes: ApiScope[]
  busyOperation?: string
  kind: EditorDialogKind
  labels: DeveloperPlatformLabels
  oauthExpiry: string
  oauthGrantTypes: DeveloperOAuthGrantType[]
  oauthName: string
  oauthScopes: ApiScope[]
  webhookEvents: DeveloperWebhookEventType[]
  webhookName: string
  webhookScopes: ApiScope[]
  webhookTeamIds: string[]
  webhookTeamOptions: DeveloperPlatformOption[]
  webhookUrl: string
  onApiKeyExpiryChange: (value: string) => void
  onApiKeyNameChange: (value: string) => void
  onApiKeyScopesChange: (value: ApiScope[]) => void
  onOAuthExpiryChange: (value: string) => void
  onOAuthGrantTypesChange: (value: DeveloperOAuthGrantType[]) => void
  onOAuthNameChange: (value: string) => void
  onOAuthScopesChange: (value: ApiScope[]) => void
  onRequestClose: () => void
  onSubmitApiKey: (event: FormEvent<HTMLFormElement>) => void
  onSubmitOAuthApp: (event: FormEvent<HTMLFormElement>) => void
  onSubmitWebhook: (event: FormEvent<HTMLFormElement>) => void
  onWebhookEventsChange: (value: DeveloperWebhookEventType[]) => void
  onWebhookNameChange: (value: string) => void
  onWebhookScopesChange: (value: ApiScope[]) => void
  onWebhookTeamIdsChange: (value: string[]) => void
  onWebhookUrlChange: (value: string) => void
}) {
  const title = labels.headings[`create-${kind}`]
  const description = labels.helpText[`create-${kind}`]
  const isBusy = busyOperation === `${kind}:create`

  return (
    <div
      aria-describedby="developer-editor-description"
      aria-labelledby="developer-editor-title"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/45 p-4"
      onKeyDown={(event) => {
        trapDialogFocus(event)
        if (event.key === 'Escape' && !isBusy) {
          onRequestClose()
        }
      }}
      role="dialog"
    >
      <form
        className="workbench-panel my-auto w-full max-w-[620px] overflow-hidden shadow-xl"
        onSubmit={
          kind === 'api-key'
            ? onSubmitApiKey
            : kind === 'oauth-app'
              ? onSubmitOAuthApp
              : onSubmitWebhook
        }
      >
        <div className="border-b border-[var(--workbench-border)] px-5 py-4">
          <h3
            className="text-lg font-semibold text-[var(--workbench-text)]"
            id="developer-editor-title"
          >
            {title}
          </h3>
          <p
            className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]"
            id="developer-editor-description"
          >
            {description}
          </p>
        </div>

        <div className="grid max-h-[65vh] gap-4 overflow-y-auto p-5">
          {kind === 'api-key' ? (
            <>
              <TextField
                autoFocus
                label={labels.fields.name}
                placeholder={labels.placeholders.apiKeyName}
                value={apiKeyName}
                onChange={onApiKeyNameChange}
              />
              <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                {labels.fields.expiry}
                <input
                  className="workbench-input min-h-10 px-3 normal-case tracking-normal"
                  type="date"
                  value={apiKeyExpiry}
                  onChange={(event) =>
                    onApiKeyExpiryChange(event.target.value)
                  }
                />
              </label>
              <OptionChecklist
                errorMessage={
                  apiKeyScopes.length === 0
                    ? labels.helpText.selectionRequired
                    : undefined
                }
                legend={labels.fields.scopes}
                options={labels.scopeOptions}
                value={apiKeyScopes}
                onChange={onApiKeyScopesChange}
              />
            </>
          ) : null}

          {kind === 'oauth-app' ? (
            <>
              <TextField
                autoFocus
                label={labels.fields.name}
                placeholder={labels.placeholders.oauthName}
                value={oauthName}
                onChange={onOAuthNameChange}
              />
              <OptionChecklist
                disabled
                legend={labels.fields.grantTypes}
                options={labels.grantTypeOptions}
                value={oauthGrantTypes}
                onChange={onOAuthGrantTypesChange}
              />
              <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                {labels.fields.expiry}
                <input
                  className="workbench-input min-h-10 px-3 normal-case tracking-normal"
                  type="date"
                  value={oauthExpiry}
                  onChange={(event) =>
                    onOAuthExpiryChange(event.target.value)
                  }
                />
              </label>
              <OptionChecklist
                errorMessage={
                  oauthScopes.length === 0
                    ? labels.helpText.selectionRequired
                    : undefined
                }
                legend={labels.fields.scopes}
                options={labels.scopeOptions}
                value={oauthScopes}
                onChange={onOAuthScopesChange}
              />
            </>
          ) : null}

          {kind === 'webhook' ? (
            <>
              <TextField
                autoFocus
                label={labels.fields.name}
                placeholder={labels.placeholders.webhookName}
                value={webhookName}
                onChange={onWebhookNameChange}
              />
              <TextField
                label={labels.fields.url}
                placeholder={labels.placeholders.webhookUrl}
                type="url"
                value={webhookUrl}
                onChange={onWebhookUrlChange}
              />
              <OptionChecklist
                legend={labels.fields.webhookTeams}
                options={webhookTeamOptions}
                value={webhookTeamIds}
                onChange={onWebhookTeamIdsChange}
              />
              <OptionChecklist
                errorMessage={
                  webhookEvents.length === 0
                    ? labels.helpText.selectionRequired
                    : undefined
                }
                legend={labels.fields.events}
                options={labels.webhookEventOptions}
                value={webhookEvents}
                onChange={onWebhookEventsChange}
              />
              <OptionChecklist
                errorMessage={
                  webhookScopes.length === 0
                    ? labels.helpText.selectionRequired
                    : undefined
                }
                legend={labels.fields.scopes}
                options={labels.scopeOptions}
                value={webhookScopes}
                onChange={onWebhookScopesChange}
              />
              <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium leading-5 text-blue-900">
                {labels.helpText.webhookDelivery}
              </p>
            </>
          ) : null}
        </div>

        <div className="flex justify-end gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
          <button
            className="workbench-button-secondary min-h-10 px-4"
            disabled={isBusy}
            onClick={onRequestClose}
            type="button"
          >
            {labels.actions.cancel}
          </button>
          <button
            className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
            disabled={
              isBusy ||
              (kind === 'api-key' && apiKeyScopes.length === 0) ||
              (kind === 'oauth-app' && oauthScopes.length === 0) ||
              (
                kind === 'webhook' &&
                (
                  webhookTeamIds.length === 0 ||
                  webhookEvents.length === 0 ||
                  webhookScopes.length === 0
                )
              )
            }
            type="submit"
          >
            {labels.actions[`submit-${kind}`]}
          </button>
        </div>
      </form>
    </div>
  )
}

function SecretDialog({
  copied,
  copyErrorMessage,
  labels,
  state,
  stored,
  onCopy,
  onRequestClose,
  onStoredChange,
}: {
  copied: boolean
  copyErrorMessage?: string
  labels: DeveloperPlatformLabels
  state: SecretDialogState
  stored: boolean
  onCopy: () => Promise<void>
  onRequestClose: () => void
  onStoredChange: (stored: boolean) => void
}) {
  return (
    <div
      aria-describedby="developer-secret-description developer-secret-warning"
      aria-labelledby="developer-secret-title"
      aria-modal="true"
      className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/55 p-4"
      onKeyDown={(event) => {
        trapDialogFocus(event)
        if (event.key === 'Escape' && stored) {
          onRequestClose()
        }
      }}
      role="dialog"
    >
      <div className="workbench-panel w-full max-w-[620px] overflow-hidden shadow-xl">
        <div className="border-b border-[var(--workbench-border)] px-5 py-4">
          <p className="workbench-eyebrow">{state.name}</p>
          <h3
            className="mt-2 text-lg font-semibold text-[var(--workbench-text)]"
            id="developer-secret-title"
          >
            {labels.secretTitles[state.kind]}
          </h3>
          <p
            className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]"
            id="developer-secret-description"
          >
            {labels.secretDescriptions[state.kind]}
          </p>
        </div>
        <div className="grid gap-4 p-5">
          <p
            className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900"
            id="developer-secret-warning"
          >
            {labels.secretWarning}
          </p>
          <code className="overflow-x-auto rounded-lg border border-[var(--workbench-border-strong)] bg-slate-950 px-4 py-3 text-sm text-emerald-300">
            {state.value}
          </code>
          {copyErrorMessage ? (
            <p
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700"
              role="alert"
            >
              {copyErrorMessage}
            </p>
          ) : null}
          <label className="flex items-start gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3 text-sm font-semibold text-[var(--workbench-text)]">
            <input
              checked={stored}
              className="mt-0.5 h-5 w-5 flex-none accent-[var(--workbench-primary)]"
              type="checkbox"
              onChange={(event) =>
                onStoredChange(event.target.checked)
              }
            />
            <span>{labels.secretStoredConfirmation}</span>
          </label>
        </div>
        <div className="flex justify-end gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
          <button
            autoFocus
            className="workbench-button-secondary min-h-10 px-4"
            onClick={() => void onCopy()}
            type="button"
          >
            {copied ? labels.copiedSecret : labels.copySecret}
          </button>
          <button
            className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!stored}
            onClick={onRequestClose}
            type="button"
          >
            {labels.closeDialog}
          </button>
        </div>
      </div>
    </div>
  )
}

function trapDialogFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hasAttribute('hidden'))
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) {
    event.preventDefault()
    return
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function SectionHeader({
  action,
  description,
  title,
}: {
  action?: { label: string; onClick: () => void }
  description: string
  title: string
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-[680px]">
        <h3 className="text-lg font-semibold text-[var(--workbench-text)]">
          {title}
        </h3>
        <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {description}
        </p>
      </div>
      {action ? (
        <button
          className="workbench-button-primary min-h-10 px-4"
          onClick={action.onClick}
          type="button"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  )
}

function EmptyState({
  description,
  title,
}: {
  description: string
  title: string
}) {
  return (
    <div className="mt-4 rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] px-5 py-8 text-center">
      <h4 className="font-semibold text-[var(--workbench-text)]">{title}</h4>
      <p className="mx-auto mt-2 max-w-[540px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
        {description}
      </p>
    </div>
  )
}

function StatusBadge({
  labels,
  status,
}: {
  labels: DeveloperPlatformLabels
  status: string
}) {
  const className =
    status === 'active' ||
    status === 'connected' ||
    status === 'delivered' ||
    status === 'completed' ||
    status === 'resolved'
      ? 'workbench-badge-success'
      : status === 'failed' ||
          status === 'revoked' ||
          status === 'error'
        ? 'workbench-badge-danger'
        : status === 'needs-reauth' ||
            status === 'conflict' ||
            status === 'open'
          ? 'workbench-badge-warning'
          : 'workbench-badge'

  return (
    <span className={className}>
      {labels.statusLabels[status] ?? status}
    </span>
  )
}

function ScopeBadges({
  labels,
  scopes,
}: {
  labels: DeveloperPlatformLabels
  scopes: ApiScope[]
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {scopes.map((scope) => (
        <span className="workbench-badge-primary" key={scope}>
          {labels.scopeOptions.find((option) => option.value === scope)
            ?.label ?? scope}
        </span>
      ))}
    </div>
  )
}

function ActionButtons({
  busy,
  labels,
  onRevoke,
  onRotate,
}: {
  busy?: boolean
  labels: DeveloperPlatformLabels
  onRevoke?: () => void
  onRotate?: () => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {onRotate ? (
        <button
          className="workbench-button-secondary min-h-9 px-3 disabled:opacity-50"
          disabled={busy}
          onClick={onRotate}
          type="button"
        >
          {labels.actions.rotate}
        </button>
      ) : null}
      {onRevoke ? (
        <button
          className="min-h-9 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            if (window.confirm(labels.helpText.revokeConfirm)) {
              onRevoke()
            }
          }}
          type="button"
        >
          {labels.actions.revoke}
        </button>
      ) : null}
    </div>
  )
}

function TextField({
  autoFocus,
  label,
  placeholder,
  type = 'text',
  value,
  onChange,
}: {
  autoFocus?: boolean
  label: string
  placeholder: string
  type?: 'text' | 'url'
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
      {label}
      <input
        autoFocus={autoFocus}
        className="workbench-input min-h-10 px-3 normal-case tracking-normal"
        placeholder={placeholder}
        required
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function OptionChecklist<TValue extends string>({
  disabled = false,
  errorMessage,
  legend,
  options,
  value,
  onChange,
}: {
  disabled?: boolean
  errorMessage?: string
  legend: string
  options: DeveloperPlatformOption<TValue>[]
  value: TValue[]
  onChange: (value: TValue[]) => void
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
        {legend}
      </legend>
      <div className="grid gap-2">
        {options.map((option) => (
          <label
            className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] bg-white px-3 py-2"
            key={option.value}
          >
            <span className="min-w-0">
              <strong className="block text-sm font-semibold text-[var(--workbench-text)]">
                {option.label}
              </strong>
              <span className="mt-0.5 block text-xs font-medium text-[var(--workbench-muted)]">
                {option.description}
              </span>
            </span>
            <input
              checked={value.includes(option.value)}
              className="h-5 w-5 flex-none accent-[var(--workbench-primary)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={disabled}
              type="checkbox"
              onChange={() =>
                onChange(toggleSelection(value, option.value))
              }
            />
          </label>
        ))}
      </div>
      {errorMessage ? (
        <p className="text-xs font-semibold text-red-700" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </fieldset>
  )
}

function toggleSelection<TValue>(
  current: TValue[],
  value: TValue,
) {
  return current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value]
}

function updateImportMapping(
  mappings: DeveloperImportFieldMapping[],
  index: number,
  property: keyof DeveloperImportFieldMapping,
  value: string,
) {
  return mappings.map((mapping, mappingIndex) =>
    mappingIndex === index
      ? { ...mapping, [property]: value }
      : mapping,
  )
}

function interpolate(
  template: string,
  values: Record<string, string | number>,
) {
  return Object.entries(values).reduce(
    (result, [key, value]) =>
      result.replaceAll(`{${key}}`, String(value)),
    template,
  )
}

function formatSyncConflictValue(value: unknown, fallback: string) {
  if (typeof value === 'string') {
    return value === '' ? '""' : value
  }

  if (value === undefined) {
    return fallback
  }

  try {
    return JSON.stringify(value, null, 2) ?? fallback
  } catch {
    return fallback
  }
}

function formatConflictMergeDraft(value: unknown) {
  if (value === undefined) {
    return 'null'
  }

  return JSON.stringify(value, null, 2) ?? 'null'
}

function parseConflictMergedValues(
  conflict: WorkItemSyncConflict,
  drafts?: Record<string, string>,
) {
  return Object.fromEntries(
    conflict.fields.map((field) => [
      field.field,
      JSON.parse(
        drafts?.[field.field] ??
          formatConflictMergeDraft(field.localValue),
      ) as unknown,
    ]),
  )
}

function formatDeveloperTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function toLocalEndOfDayIso(value: string) {
  return new Date(`${value}T23:59:59.999`).toISOString()
}

function formatConnectorProviderName(value: string) {
  return value
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}
