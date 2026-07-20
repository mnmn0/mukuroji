import type {
  ConnectorInstallation,
  ExternalResourceType,
  ExternalSyncDirection,
  ExternalWorkItemLink,
} from '@mukuroji/contracts'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import { createMutationRequestRunner } from '../api/mutationHeaders'
import type { Locale } from '../i18n'
import {
  createDeveloperExternalLink,
  deleteDeveloperExternalLink,
  getDeveloperPlatformResources,
  listDeveloperExternalLinks,
  updateDeveloperExternalLink,
} from '../developer-platform/api'
import { createWorkItemExternalLinksLabels } from './externalLinkLabels'

/**
 * External link panel で表示する locale-aware 文言です。
 */
export type WorkItemExternalLinksLabels = {
  /** Section 見出しです。 */
  title: string
  /** Section の用途説明です。 */
  description: string
  /** Mutation が許可されていない状態です。 */
  readOnly: string
  /** 初期読み込み中の文言です。 */
  loading: string
  /** 一覧読み込み失敗時の文言です。 */
  loadError: string
  /** 追加 page の読み込み失敗時の文言です。 */
  loadMoreError: string
  /** Mutation 失敗時の文言です。 */
  operationError: string
  /** 再読み込み action です。 */
  retry: string
  /** Link が無い状態の見出しです。 */
  emptyTitle: string
  /** Link が無い状態の説明です。 */
  emptyDescription: string
  /** Connected installation が無い状態の見出しです。 */
  noInstallationsTitle: string
  /** Connected installation が無い状態の説明です。 */
  noInstallationsDescription: string
  /** Link 追加 form を開く action です。 */
  addLink: string
  /** Link 作成 action です。 */
  createLink: string
  /** Link 作成 form を閉じる action です。 */
  cancel: string
  /** Connector installation field です。 */
  installation: string
  /** External resource type field です。 */
  resourceType: string
  /** External resource ID field です。 */
  externalId: string
  /** External HTTPS URL field です。 */
  externalUrl: string
  /** Provider UI の表示 key field です。 */
  displayKey: string
  /** Synchronization direction field です。 */
  syncDirection: string
  /** 最終同期日時の label です。 */
  lastSynced: string
  /** 同期実績が無い状態です。 */
  never: string
  /** Link を解除する action です。 */
  unlink: string
  /** Link 解除前に表示する確認文言です。 */
  unlinkConfirm: string
  /** Connector recovery 後に同期方向を変更できることを説明します。 */
  reconnectRequired: string
  /** Provider snapshot も取得できない場合の表示名です。 */
  unknownProvider: string
  /** 次 page を取得する action です。 */
  loadMore: string
  /** 次 page を取得中の文言です。 */
  loadingMore: string
  /** External ID input placeholder です。 */
  externalIdPlaceholder: string
  /** External URL input placeholder です。 */
  externalUrlPlaceholder: string
  /** Display key input placeholder です。 */
  displayKeyPlaceholder: string
  /** Resource type の表示名です。 */
  resourceTypeLabels: Record<ExternalResourceType, string>
  /** Sync direction の表示名です。 */
  syncDirectionLabels: Record<ExternalSyncDirection, string>
  /** Link status の表示名です。 */
  statusLabels: Record<string, string>
}

/**
 * WorkItemExternalLinksPanel の pure view props です。
 */
export type WorkItemExternalLinksPanelProps = {
  /** 表示する Work Item の外部 link 一覧です。 */
  links: readonly ExternalWorkItemLink[]
  /** Provider account を識別する connector installation 一覧です。 */
  installations: readonly ConnectorInstallation[]
  /** 外部 link を管理できるかどうかです。 */
  canManage: boolean
  /** Locale-aware 表示文言です。 */
  labels: WorkItemExternalLinksLabels
  /** 初期読み込み中かどうかです。 */
  isLoading?: boolean
  /** 次 page を読み込み中かどうかです。 */
  isLoadingMore?: boolean
  /** 次 page が存在するかどうかです。 */
  hasMore?: boolean
  /** 一覧取得失敗時の安全な表示文言です。 */
  errorMessage?: string
  /** 取得済み一覧を保持したまま表示する追加 page error です。 */
  loadMoreErrorMessage?: string
  /** ISO 8601 timestamp を表示用に整形します。 */
  formatDateTime?: (value: string) => string
  /** 一覧を再取得します。 */
  onRetry?: () => Promise<void> | void
  /** External link を作成します。 */
  onCreate?: (input: {
    /** 使用する connector installation ID です。 */
    installationId: string
    /** 外部 resource の種別です。 */
    resourceType: ExternalResourceType
    /** Provider 内の resource ID です。 */
    externalId: string
    /** Provider UI の HTTPS URL です。 */
    externalUrl: string
    /** Provider UI の表示 key です。 */
    displayKey?: string
    /** Link の同期方向です。 */
    syncDirection: ExternalSyncDirection
  }) => Promise<void>
  /** External link の同期方向を更新します。 */
  onUpdateDirection?: (
    link: ExternalWorkItemLink,
    syncDirection: ExternalSyncDirection,
  ) => Promise<void>
  /** Work Item と外部 resource の link を解除します。 */
  onUnlink?: (link: ExternalWorkItemLink) => Promise<void>
  /** 次 page を取得します。 */
  onLoadMore?: () => Promise<void> | void
}

/**
 * Management API へ接続する external link panel の props です。
 */
export type WorkItemExternalLinksPanelContainerProps = {
  /** Management API の Bearer token です。 */
  accessToken: string
  /** External link の作成、更新、解除が許可されているかどうかです。 */
  canManage: boolean
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** 外部 link を表示する Work Item ID です。 */
  workItemId: string
  /** 表示 locale です。 */
  locale: Locale
  /** ISO 8601 timestamp を表示用に整形します。 */
  formatDateTime?: (value: string) => string
}

const externalLinkSWRConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Work Item 詳細から管理 API の external link resource を操作します。
 */
export function WorkItemExternalLinksPanelContainer({
  accessToken,
  canManage,
  formatDateTime,
  locale,
  teamId,
  workItemId,
}: WorkItemExternalLinksPanelContainerProps) {
  const labels = useMemo(
    () => createWorkItemExternalLinksLabels(locale),
    [locale],
  )
  const localizedDateTimeFormatter = useMemo(
    () =>
      formatDateTime ??
      ((value: string) => formatExternalLinkTimestamp(value, locale)),
    [formatDateTime, locale],
  )
  const mutationRunner = useMemo(
    () => createMutationRequestRunner(),
    [],
  )
  const resourceKey = accessToken && canManage
    ? (['work-item-external-link-resources', accessToken] as const)
    : null
  const {
    data: resources,
    error: resourceError,
    isLoading: isResourcesLoading,
    mutate: mutateResources,
  } = useSWR(
    resourceKey,
    ([, token]) => getDeveloperPlatformResources(token),
    externalLinkSWRConfig,
  )
  const canOperate = canManage && Boolean(resources)
  const {
    data: linkPages,
    error: linkError,
    isLoading: isLinksLoading,
    isValidating: isLinksValidating,
    mutate: mutateLinks,
    setSize,
    size,
  } = useSWRInfinite(
    (pageIndex, previousPage) => {
      if (!accessToken) {
        return null
      }
      if (pageIndex > 0 && !previousPage?.nextCursor) {
        return null
      }

      return [
        'work-item-external-links',
        accessToken,
        teamId,
        workItemId,
        previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, currentTeamId, currentWorkItemId, cursor]) =>
      listDeveloperExternalLinks(
        token,
        currentTeamId,
        currentWorkItemId,
        { ...(cursor ? { cursor } : {}), limit: 50 },
      ),
    externalLinkSWRConfig,
  )
  const links = useMemo(() => {
    const items = linkPages?.flatMap((page) => page.items) ?? []

    return [
      ...new Map(items.map((item) => [item.id, item] as const)).values(),
    ]
  }, [linkPages])
  const hasLoadedLinkPage = linkPages !== undefined
  const hasMore = Boolean(linkPages?.at(-1)?.nextCursor)
  const isLoadingMore = Boolean(
    isLinksValidating && linkPages && linkPages.length < size,
  )

  const refresh = async () => {
    await Promise.all([
      ...(canManage ? [mutateResources()] : []),
      mutateLinks(),
    ])
  }

  const runMutation = async (
    operationKey: string,
    fingerprint: string,
    request: Parameters<typeof mutationRunner.run<unknown>>[2],
  ) => {
    await mutationRunner.run(operationKey, fingerprint, request)
    await mutateLinks()
  }

  return (
    <WorkItemExternalLinksPanel
      canManage={canOperate}
      errorMessage={!hasLoadedLinkPage && (resourceError || linkError)
        ? labels.loadError
        : undefined}
      formatDateTime={localizedDateTimeFormatter}
      hasMore={hasMore}
      installations={resources?.connectors ?? []}
      isLoading={(canManage && isResourcesLoading) || isLinksLoading}
      isLoadingMore={isLoadingMore}
      labels={labels}
      links={links}
      loadMoreErrorMessage={hasLoadedLinkPage && linkError
        ? labels.loadMoreError
        : undefined}
      onCreate={canOperate ? (input) =>
        runMutation(
          `external-link:create:${teamId}:${workItemId}`,
          JSON.stringify(input),
          (context) => createDeveloperExternalLink(
            accessToken,
            workItemId,
            { ...input, teamId },
            context,
          ),
        ) : undefined}
      onLoadMore={hasMore ? async () => {
        await setSize(size + 1)
      } : undefined}
      onRetry={refresh}
      onUnlink={canOperate ? (link) =>
        runMutation(
          `external-link:delete:${link.id}`,
          link.id,
          (context) => deleteDeveloperExternalLink(
            accessToken,
            teamId,
            workItemId,
            link.id,
            context,
          ),
        ) : undefined}
      onUpdateDirection={canOperate ? (link, syncDirection) =>
        runMutation(
          `external-link:update:${link.id}`,
          JSON.stringify({ linkId: link.id, syncDirection }),
          (context) => updateDeveloperExternalLink(
            accessToken,
            link.id,
            { syncDirection },
            context,
          ),
        ) : undefined}
    />
  )
}

/**
 * Work Item の provider source card と同期方向を管理する pure panel です。
 */
export function WorkItemExternalLinksPanel({
  canManage,
  errorMessage,
  formatDateTime = formatExternalLinkTimestamp,
  hasMore,
  installations,
  isLoading,
  isLoadingMore,
  labels,
  links,
  loadMoreErrorMessage,
  onCreate,
  onLoadMore,
  onRetry,
  onUnlink,
  onUpdateDirection,
}: WorkItemExternalLinksPanelProps) {
  const connectedInstallations = installations.filter(
    (installation) =>
      installation.status === 'connected' &&
      installation.category === 'source-control',
  )
  const [isAdding, setIsAdding] = useState(false)
  const [installationId, setInstallationId] = useState(
    connectedInstallations[0]?.id ?? '',
  )
  const [resourceType, setResourceType] =
    useState<ExternalResourceType>('issue')
  const [externalId, setExternalId] = useState('')
  const [externalUrl, setExternalUrl] = useState('')
  const [displayKey, setDisplayKey] = useState('')
  const [syncDirection, setSyncDirection] =
    useState<ExternalSyncDirection>('bidirectional')
  const [busyOperations, setBusyOperations] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [operationError, setOperationError] = useState<string>()
  const selectedInstallationId = connectedInstallations.some(
    (installation) => installation.id === installationId,
  )
    ? installationId
    : connectedInstallations[0]?.id ?? ''

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusyOperations((current) => new Set(current).add(key))
    setOperationError(undefined)

    try {
      await action()
      return true
    } catch {
      setOperationError(labels.operationError)
      return false
    } finally {
      setBusyOperations((current) => {
        const next = new Set(current)

        next.delete(key)
        return next
      })
    }
  }

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!onCreate || !isHttpsUrl(externalUrl)) {
      setOperationError(labels.operationError)
      return
    }

    const succeeded = await runAction('external-link:create', () => onCreate({
      installationId: selectedInstallationId,
      resourceType,
      externalId: externalId.trim(),
      externalUrl: externalUrl.trim(),
      ...(displayKey.trim() ? { displayKey: displayKey.trim() } : {}),
      syncDirection,
    }))

    if (succeeded) {
      setExternalId('')
      setExternalUrl('')
      setDisplayKey('')
      setIsAdding(false)
    }
  }

  return (
    <section
      className="border-t border-[var(--workbench-border)] bg-white px-6 py-6"
      data-testid="work-item-external-links-panel"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="workbench-eyebrow text-[var(--workbench-muted)]">
              {labels.title}
            </h2>
            {!canManage ? (
              <span className="workbench-badge">{labels.readOnly}</span>
            ) : null}
          </div>
          <p className="mt-2 text-sm font-medium leading-5 text-[var(--workbench-muted)]">
            {labels.description}
          </p>
        </div>
        {canManage && onCreate && connectedInstallations.length ? (
          <button
            aria-expanded={isAdding}
            className="workbench-button-secondary min-h-9 px-3"
            onClick={() => {
              setOperationError(undefined)
              setIsAdding((current) => !current)
            }}
            type="button"
          >
            {labels.addLink}
          </button>
        ) : null}
      </div>

      {operationError ? (
        <p
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700"
          role="alert"
        >
          {operationError}
        </p>
      ) : null}

      {isAdding && canManage && onCreate ? (
        <form
          className="mt-4 grid gap-3 rounded-lg border border-[#99d7cf] bg-[#f4fbfa] p-4"
          onSubmit={(event) => void handleCreate(event)}
        >
          <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
            <ExternalLinkSelect
              label={labels.installation}
              value={selectedInstallationId}
              onChange={setInstallationId}
            >
              {connectedInstallations.map((installation) => (
                <option key={installation.id} value={installation.id}>
                  {formatInstallationLabel(installation)}
                </option>
              ))}
            </ExternalLinkSelect>
            <ExternalLinkSelect
              label={labels.resourceType}
              value={resourceType}
              onChange={(value) => setResourceType(value as ExternalResourceType)}
            >
              {externalResourceTypes.map((type) => (
                <option key={type} value={type}>
                  {labels.resourceTypeLabels[type]}
                </option>
              ))}
            </ExternalLinkSelect>
          </div>
          <ExternalLinkInput
            label={labels.externalId}
            placeholder={labels.externalIdPlaceholder}
            value={externalId}
            onChange={setExternalId}
          />
          <ExternalLinkInput
            label={labels.externalUrl}
            placeholder={labels.externalUrlPlaceholder}
            type="url"
            value={externalUrl}
            onChange={setExternalUrl}
          />
          <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
            <ExternalLinkInput
              label={labels.displayKey}
              placeholder={labels.displayKeyPlaceholder}
              required={false}
              value={displayKey}
              onChange={setDisplayKey}
            />
            <ExternalLinkSelect
              label={labels.syncDirection}
              value={syncDirection}
              onChange={(value) => setSyncDirection(value as ExternalSyncDirection)}
            >
              {externalSyncDirections.map((direction) => (
                <option key={direction} value={direction}>
                  {labels.syncDirectionLabels[direction]}
                </option>
              ))}
            </ExternalLinkSelect>
          </div>
          <div className="flex justify-end gap-2">
            <button
              className="workbench-button-secondary min-h-9 px-3"
              disabled={busyOperations.has('external-link:create')}
              onClick={() => setIsAdding(false)}
              type="button"
            >
              {labels.cancel}
            </button>
            <button
              className="workbench-button-primary min-h-9 px-3 disabled:opacity-50"
              disabled={busyOperations.has('external-link:create')}
              type="submit"
            >
              {labels.createLink}
            </button>
          </div>
        </form>
      ) : null}

      {isLoading ? (
        <div aria-label={labels.loading} className="mt-4 grid gap-3" role="status">
          <div className="h-28 animate-pulse rounded-lg bg-slate-100" />
          <div className="h-28 animate-pulse rounded-lg bg-slate-100" />
        </div>
      ) : errorMessage ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3" role="alert">
          <p className="text-sm font-semibold text-red-800">{errorMessage}</p>
          {onRetry ? (
            <button className="workbench-button-secondary min-h-9 px-3" onClick={() => void onRetry()} type="button">
              {labels.retry}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {canManage && connectedInstallations.length === 0 ? (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <h3 className="text-sm font-semibold text-amber-900">{labels.noInstallationsTitle}</h3>
              <p className="mt-1 text-xs font-medium leading-5 text-amber-800">{labels.noInstallationsDescription}</p>
            </div>
          ) : null}

          {links.length ? (
            <div className="mt-4 grid gap-3">
              {links.map((link) => {
                const installation = installations.find((item) => item.id === link.installationId)
                const busy =
                  busyOperations.has(`external-link:update:${link.id}`) ||
                  busyOperations.has(`external-link:delete:${link.id}`)
                const canUpdateDirection =
                  canManage &&
                  Boolean(onUpdateDirection) &&
                  installation?.status === 'connected'
                const providerName =
                  installation?.provider ??
                  link.provider ??
                  labels.unknownProvider

                return (
                  <article
                    className="rounded-lg border border-[var(--workbench-border)] bg-white p-4"
                    data-testid={`external-link-${link.id}`}
                    key={link.id}
                  >
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="workbench-badge">{providerName}</span>
                          <span className="workbench-badge-primary">{labels.resourceTypeLabels[link.resourceType]}</span>
                        </div>
                        <a
                          className="mt-2 block break-all text-sm font-semibold text-[var(--workbench-primary)] underline decoration-[#99d7cf] underline-offset-2"
                          href={link.externalUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {link.displayKey ?? link.externalId}
                        </a>
                        <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                          {installation
                            ? formatInstallationLabel(installation)
                            : formatExternalLinkSnapshot(link)}
                        </p>
                      </div>
                      <ExternalLinkStatusBadge labels={labels} status={link.syncStatus} />
                    </div>
                    <div className="mt-4 flex min-w-0 flex-wrap items-end justify-between gap-3 border-t border-[var(--workbench-border)] pt-3">
                      <label className="grid min-w-[200px] flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
                        {labels.syncDirection}
                        <select
                          className="workbench-input min-h-9 px-3 disabled:bg-[var(--workbench-surface-muted)]"
                          disabled={!canUpdateDirection || busy}
                          value={link.syncDirection}
                          onChange={(event) => {
                            const direction = event.target.value as ExternalSyncDirection
                            if (!onUpdateDirection) return
                            void runAction(
                              `external-link:update:${link.id}`,
                              () => onUpdateDirection(link, direction),
                            )
                          }}
                        >
                          {externalSyncDirections.map((direction) => (
                            <option key={direction} value={direction}>{labels.syncDirectionLabels[direction]}</option>
                          ))}
                        </select>
                        {canManage && installation?.status !== 'connected' ? (
                          <span className="font-medium normal-case leading-5 text-amber-800">
                            {labels.reconnectRequired}
                          </span>
                        ) : null}
                      </label>
                      <div className="grid justify-items-end gap-1">
                        <p className="text-xs font-medium text-[var(--workbench-muted)]">
                          {labels.lastSynced}: {link.lastSyncedAt ? formatDateTime(link.lastSyncedAt) : labels.never}
                        </p>
                        {canManage && onUnlink ? (
                          <button
                            className="min-h-9 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                            disabled={busy}
                            onClick={() => {
                              const name = link.displayKey ?? link.externalId
                              if (!window.confirm(labels.unlinkConfirm.replace('{name}', name))) {
                                return
                              }
                              void runAction(`external-link:delete:${link.id}`, () => onUnlink(link))
                            }}
                            type="button"
                          >
                            {labels.unlink}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] px-5 py-6 text-center">
              <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{labels.emptyTitle}</h3>
              <p className="mx-auto mt-2 max-w-[420px] text-xs font-medium leading-5 text-[var(--workbench-muted)]">{labels.emptyDescription}</p>
            </div>
          )}

          {loadMoreErrorMessage ? (
            <div
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
              role="alert"
            >
              <p className="text-sm font-semibold text-red-800">
                {loadMoreErrorMessage}
              </p>
              {onRetry ? (
                <button
                  className="workbench-button-secondary min-h-9 px-3"
                  onClick={() => void onRetry()}
                  type="button"
                >
                  {labels.retry}
                </button>
              ) : null}
            </div>
          ) : null}

          {hasMore && onLoadMore ? (
            <button
              className="workbench-button-secondary mt-4 min-h-9 w-full px-3 disabled:opacity-50"
              disabled={isLoadingMore}
              onClick={() => void onLoadMore()}
              type="button"
            >
              {isLoadingMore ? labels.loadingMore : labels.loadMore}
            </button>
          ) : null}
        </>
      )}
    </section>
  )
}

const externalResourceTypes = [
  'issue',
  'merge-request',
  'commit',
  'deploy',
] as const satisfies readonly ExternalResourceType[]

const externalSyncDirections = [
  'bidirectional',
  'inbound',
  'outbound',
  'none',
] as const satisfies readonly ExternalSyncDirection[]

function ExternalLinkInput({
  label,
  placeholder,
  required = true,
  type = 'text',
  value,
  onChange,
}: {
  label: string
  placeholder: string
  required?: boolean
  type?: 'text' | 'url'
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
      {label}
      <input
        className="workbench-input min-h-9 min-w-0 px-3"
        placeholder={placeholder}
        required={required}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function ExternalLinkSelect({
  children,
  label,
  value,
  onChange,
}: {
  children: ReactNode
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
      {label}
      <select className="workbench-input min-h-9 min-w-0 px-3" required value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  )
}

function ExternalLinkStatusBadge({
  labels,
  status,
}: {
  labels: WorkItemExternalLinksLabels
  status: ExternalWorkItemLink['syncStatus']
}) {
  const className = status === 'synced'
    ? 'workbench-badge-success'
    : status === 'failed'
      ? 'workbench-badge-danger'
      : status === 'conflict'
        ? 'workbench-badge-warning'
        : 'workbench-badge'

  return <span className={className}>{labels.statusLabels[status] ?? status}</span>
}

function formatInstallationLabel(installation: ConnectorInstallation) {
  return `${installation.name} · ${installation.externalAccountName ?? installation.externalAccountId ?? installation.provider}`
}

function formatExternalLinkSnapshot(
  link: ExternalWorkItemLink,
) {
  const names = [link.installationName, link.externalAccountName].filter(Boolean)

  return names.length ? names.join(' · ') : link.installationId
}

function formatExternalLinkTimestamp(value: string, locale: Locale = 'en') {
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
