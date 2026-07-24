import type { ApiKeySummary, OAuthAppSummary } from '@mukuroji/contracts'
import {
  ActionButtons,
  EmptyState,
  SectionHeader,
} from './DeveloperPlatformSectionParts'
import {
  ScopeBadges,
  StatusBadge,
} from './DeveloperPlatformStatus'
import type { DeveloperPlatformLabels } from './DeveloperPlatformView'

/**
 * Data and actions rendered by the pure Developer Platform credentials view.
 */
export type CredentialsSectionProps = {
  /** API keys displayed in the credential ledger. */
  apiKeys: ApiKeySummary[]
  /** Identifier of the credential mutation currently in progress. */
  busyOperation?: string
  /** Whether credential management actions are available. */
  canManage: boolean
  /** Formats an ISO 8601 timestamp for display. */
  formatDateTime: (value: string) => string
  /** Localized labels used by the credentials section. */
  labels: DeveloperPlatformLabels
  /** OAuth applications displayed in the credential ledger. */
  oauthApps: OAuthAppSummary[]
  /** Opens the API key creation flow. */
  onCreateApiKey?: () => void
  /** Opens the OAuth application creation flow. */
  onCreateOAuthApp?: () => void
  /** Revokes the selected API key. */
  onRevokeApiKey?: (apiKey: ApiKeySummary) => void
  /** Revokes the selected OAuth application. */
  onRevokeOAuthApp?: (oauthApp: OAuthAppSummary) => void
  /** Rotates the selected API key secret. */
  onRotateApiKey?: (apiKey: ApiKeySummary) => void
  /** Rotates the selected OAuth application secret. */
  onRotateOAuthApp?: (oauthApp: OAuthAppSummary) => void
}

/**
 * Renders API key and OAuth application ledgers without API or cache access.
 *
 * @param props - Credential data, capability state, labels, and action callbacks.
 * @returns The pure credentials section view.
 */
export function CredentialsSection({
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
}: CredentialsSectionProps) {
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
                      <dt className="font-semibold">
                        {labels.tableHeaders.created}
                      </dt>
                      <dd>{formatDateTime(apiKey.createdAt)}</dd>
                    </div>
                    <div>
                      <dt className="font-semibold">
                        {labels.tableHeaders.creator}
                      </dt>
                      <dd className="break-all">{apiKey.createdByUserId}</dd>
                    </div>
                    <div>
                      <dt className="font-semibold">
                        {labels.tableHeaders.lastUsed}
                      </dt>
                      <dd>
                        {apiKey.lastUsedAt
                          ? formatDateTime(apiKey.lastUsedAt)
                          : labels.helpText.never}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold">
                        {labels.tableHeaders.expiry}
                      </dt>
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
