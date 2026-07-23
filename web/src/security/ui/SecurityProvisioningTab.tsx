import { useEffect, useRef, useState } from 'react'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type {
  EnterpriseProvisioningImpact,
  EnterpriseProvisioningLog,
  EnterpriseScimTokenResponse,
  EnterpriseSecuritySnapshot,
} from '../api'
import {
  createEnterpriseSecurityTestId,
  formatEnterpriseSecurityDate,
} from '../model/enterpriseSecurityDisplay'
import { isEnterpriseProvisioningImpactExpired } from '../model/enterpriseProvisioningImpact'
import {
  EnterpriseSecurityDefinition,
  EnterpriseSecurityEmptyState,
  EnterpriseSecurityReadOnlyNotice,
  EnterpriseSecuritySectionHeader,
  EnterpriseSecurityStatusBadge,
} from './EnterpriseSecurityFields'
import { EnterpriseOneTimeSecretNotice } from './EnterpriseOneTimeSecretNotice'

/**
 * Renders SCIM credentials, reconciliation previews, and provisioning logs.
 *
 * @param props - Provisioning snapshot, mutation callbacks, and localized copy.
 * @returns The independently renderable provisioning tab.
 */
export function SecurityProvisioningTab({
  busyOperation,
  locale,
  snapshot,
  t,
  onPreview,
  onRequestApply,
  onRequestRotateToken,
  onRetryLog,
  onRotateToken,
}: {
  busyOperation?: string
  locale: Locale
  snapshot: EnterpriseSecuritySnapshot
  t: (key: MessageKey) => string
  onPreview?: () => Promise<EnterpriseProvisioningImpact>
  onRequestApply: (
    impact: EnterpriseProvisioningImpact,
    onApplied: () => void,
  ) => void
  onRequestRotateToken: (
    onRotated: (response: EnterpriseScimTokenResponse) => void,
  ) => void
  onRetryLog?: (log: EnterpriseProvisioningLog) => Promise<unknown>
  onRotateToken?: () => Promise<EnterpriseScimTokenResponse>
}) {
  const canManage = snapshot.capabilities.canManageProvisioning
  const isBusy = Boolean(busyOperation)
  const [impact, setImpact] = useState<EnterpriseProvisioningImpact>()
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const [oneTimeSecret, setOneTimeSecret] = useState<{
    displayId: number
    label: string
    token: string
  }>()
  const oneTimeSecretDisplayIdRef = useRef(0)
  const impactExpiresAt = impact ? Date.parse(impact.expiresAt) : Number.NaN
  const impactExpiryDelay = Number.isFinite(impactExpiresAt)
    ? Math.max(0, impactExpiresAt - currentTime)
    : 0
  const impactIsExpired = Boolean(
    impact && (!Number.isFinite(impactExpiresAt) || impactExpiryDelay === 0),
  )

  useEffect(() => {
    if (!impact || impactIsExpired) {
      return
    }

    const timeout = window.setTimeout(
      () => setCurrentTime(Date.now()),
      Math.min(impactExpiryDelay, 2_147_483_647),
    )

    return () => window.clearTimeout(timeout)
  }, [impact, impactExpiryDelay, impactIsExpired])

  /** Retains a rotated SCIM token only in the current tab generation. */
  const showOneTimeSecret = (response: EnterpriseScimTokenResponse) => {
    oneTimeSecretDisplayIdRef.current += 1
    setOneTimeSecret({
      displayId: oneTimeSecretDisplayIdRef.current,
      label: t('security.provisioning.scimTokenLabel'),
      token: response.token,
    })
  }

  /** Refreshes the reconciliation preview and resets its expiry clock. */
  const previewProvisioning = async () => {
    setImpact(undefined)
    const nextImpact = await onPreview?.()
    if (nextImpact) {
      setCurrentTime(Date.now())
      setImpact(nextImpact)
    }
  }

  /** Creates or requests confirmation to rotate the SCIM token. */
  const rotateToken = async () => {
    if (snapshot.scim.tokenGeneration > 0) {
      onRequestRotateToken(showOneTimeSecret)
      return
    }

    const response = await onRotateToken?.()
    if (response) {
      showOneTimeSecret(response)
    }
  }

  return (
    <div className="grid gap-5" data-testid="security-provisioning">
      {oneTimeSecret ? (
        <EnterpriseOneTimeSecretNotice
          key={oneTimeSecret.displayId}
          kind="scim"
          label={oneTimeSecret.label}
          locale={locale}
          token={oneTimeSecret.token}
          onDismiss={() => setOneTimeSecret(undefined)}
        />
      ) : null}

      {!canManage ? <EnterpriseSecurityReadOnlyNotice t={t} /> : null}

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <EnterpriseSecuritySectionHeader
          badge={t(`security.scim.status.${snapshot.scim.status}`)}
          description={t('security.provisioning.scimDescription')}
          title={t('security.provisioning.scimTitle')}
        />
        <dl className="grid grid-cols-3 gap-4 border-t border-[var(--workbench-border)] p-5 max-[820px]:grid-cols-1">
          <EnterpriseSecurityDefinition
            code
            label={t('security.provisioning.endpoint')}
            value={
              snapshot.scim.endpointUrl || t('security.value.notConfigured')
            }
          />
          <EnterpriseSecurityDefinition
            label={t('security.provisioning.tokenGeneration')}
            value={t('security.provisioning.generation')
              .replace('{generation}', String(snapshot.scim.tokenGeneration))
              .replace(
                '{lastFour}',
                snapshot.scim.tokenLastFour ?? t('security.value.none'),
              )}
          />
          <EnterpriseSecurityDefinition
            label={t('security.provisioning.lastSync')}
            value={
              snapshot.scim.lastSyncAt
                ? formatEnterpriseSecurityDate(snapshot.scim.lastSyncAt, locale)
                : t('security.value.never')
            }
          />
        </dl>
        {canManage ? (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
            <p className="max-w-[680px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {t('security.provisioning.tokenHelp')}
            </p>
            <button
              className="workbench-button-secondary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55"
              data-testid="security-scim-token-rotate"
              disabled={isBusy}
              type="button"
              onClick={() => void rotateToken().catch(() => undefined)}
            >
              {t(
                busyOperation === 'scim-token:rotate'
                  ? 'security.action.rotating'
                  : snapshot.scim.tokenGeneration > 0
                    ? 'security.provisioning.rotateToken'
                    : 'security.provisioning.createToken',
              )}
            </button>
          </div>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <EnterpriseSecuritySectionHeader
          description={t('security.provisioning.reconcileDescription')}
          title={t('security.provisioning.reconcileTitle')}
        />
        <div className="grid gap-4 border-t border-[var(--workbench-border)] p-5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4">
            <div className="max-w-[680px]">
              <h4 className="text-sm font-semibold text-[var(--workbench-text)]">
                {t('security.provisioning.dryRunTitle')}
              </h4>
              <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t('security.provisioning.dryRunDescription')}
              </p>
            </div>
            {canManage ? (
              <button
                className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55"
                data-testid="security-provisioning-preview"
                disabled={isBusy}
                type="button"
                onClick={() =>
                  void previewProvisioning().catch(() => undefined)
                }
              >
                {t(
                  busyOperation === 'provisioning:preview'
                    ? 'security.action.previewing'
                    : 'security.provisioning.preview',
                )}
              </button>
            ) : null}
          </div>

          {impact ? (
            <ProvisioningImpactPreview
              canApply={canManage && impact.hasChanges}
              impact={impact}
              isBlocking={impact.blocking}
              isBusy={isBusy}
              isExpired={impactIsExpired}
              locale={locale}
              t={t}
              onRequestApply={() => {
                if (
                  !impact.blocking &&
                  !isEnterpriseProvisioningImpactExpired(impact)
                ) {
                  onRequestApply(impact, () => setImpact(undefined))
                }
              }}
            />
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <EnterpriseSecuritySectionHeader
          description={t('security.provisioning.logsDescription')}
          title={t('security.provisioning.logsTitle')}
        />
        <div
          className="grid divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]"
          data-testid="security-provisioning-logs"
        >
          {snapshot.provisioningLogs.map((log) => (
            <article
              className="grid grid-cols-[minmax(160px,0.7fr)_minmax(260px,1.6fr)_minmax(170px,0.7fr)_auto] items-center gap-4 px-4 py-4 max-[980px]:grid-cols-2 max-[600px]:grid-cols-1"
              data-testid={`security-provisioning-log-${createEnterpriseSecurityTestId(log.id)}`}
              key={log.id}
            >
              <div className="grid gap-2">
                <EnterpriseSecurityStatusBadge
                  label={t(`security.provisioning.logStatus.${log.status}`)}
                  tone={
                    log.status === 'succeeded'
                      ? 'success'
                      : log.status === 'failed'
                        ? 'danger'
                        : log.status === 'partial'
                          ? 'warning'
                          : 'neutral'
                  }
                />
                <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
                  {t(`security.provisioning.operation.${log.operation}`)}
                </p>
              </div>
              <div>
                <p className="text-sm font-semibold leading-6 text-[var(--workbench-text)]">
                  {t(`security.provisioning.summary.${log.status}`)}
                </p>
                {log.correlationId ? (
                  <code className="mt-1 block break-all text-xs font-medium text-[var(--workbench-muted)]">
                    {log.correlationId}
                  </code>
                ) : null}
              </div>
              <div className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                <p>{formatEnterpriseSecurityDate(log.createdAt, locale)}</p>
                <p>
                  {t('security.provisioning.attempts').replace(
                    '{count}',
                    String(log.attempts),
                  )}
                </p>
              </div>
              {canManage && log.retryable ? (
                <button
                  aria-label={`${t('security.provisioning.retry')}: ${t(`security.provisioning.operation.${log.operation}`)} · ${formatEnterpriseSecurityDate(log.createdAt, locale)}`}
                  className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                  disabled={isBusy}
                  type="button"
                  onClick={() => void onRetryLog?.(log).catch(() => undefined)}
                >
                  {t(
                    busyOperation === `provisioning-log:retry:${log.id}`
                      ? 'security.action.retrying'
                      : 'security.provisioning.retry',
                  )}
                </button>
              ) : null}
            </article>
          ))}
          {snapshot.provisioningLogs.length === 0 ? (
            <EnterpriseSecurityEmptyState
              text={t('security.provisioning.logsEmpty')}
            />
          ) : null}
        </div>
      </section>
    </div>
  )
}

/**
 * Renders a reconciliation preview and guards its apply action by expiry.
 *
 * @param props - Impact data, derived guards, locale, and apply callback.
 * @returns The provisioning impact preview.
 */
function ProvisioningImpactPreview({
  canApply,
  impact,
  isBlocking,
  isBusy,
  isExpired,
  locale,
  t,
  onRequestApply,
}: {
  canApply: boolean
  impact: EnterpriseProvisioningImpact
  isBlocking: boolean
  isBusy: boolean
  isExpired: boolean
  locale: Locale
  t: (key: MessageKey) => string
  onRequestApply: () => void
}) {
  const countItems: readonly [
    keyof EnterpriseProvisioningImpact['counts'],
    MessageKey,
  ][] = [
    ['usersCreated', 'security.provisioning.impact.usersCreated'],
    ['usersUpdated', 'security.provisioning.impact.usersUpdated'],
    ['usersDeactivated', 'security.provisioning.impact.usersDeactivated'],
    ['groupsCreated', 'security.provisioning.impact.groupsCreated'],
    ['groupsUpdated', 'security.provisioning.impact.groupsUpdated'],
    ['sessionsRevoked', 'security.provisioning.impact.sessionsRevoked'],
  ]

  return (
    <section
      className={`overflow-hidden rounded-lg border ${
        impact.hasChanges
          ? 'border-amber-300 bg-amber-50/40'
          : 'border-emerald-200 bg-emerald-50/40'
      }`}
      data-testid="security-provisioning-impact"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-4 p-4">
        <div>
          <h4 className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('security.provisioning.impactTitle')}
          </h4>
          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
            {t('security.provisioning.previewExpires').replace(
              '{date}',
              formatEnterpriseSecurityDate(impact.expiresAt, locale),
            )}
          </p>
          {isExpired ? (
            <p
              className="mt-2 text-xs font-semibold text-red-700"
              data-testid="security-provisioning-preview-expired"
              role="status"
            >
              {t('security.provisioning.previewExpired')}
            </p>
          ) : null}
          {isBlocking ? (
            <p
              className="mt-2 text-xs font-semibold text-red-700"
              data-testid="security-provisioning-preview-blocked"
              role="alert"
            >
              {t('security.provisioning.previewBlocked')}
            </p>
          ) : null}
        </div>
        <span
          className={
            impact.hasChanges
              ? 'workbench-badge-warning'
              : 'workbench-badge-success'
          }
        >
          {t(
            isBlocking
              ? 'security.provisioning.blockingChanges'
              : impact.hasChanges
                ? 'security.provisioning.changesFound'
                : 'security.provisioning.noChanges',
          )}
        </span>
      </div>
      <dl className="grid grid-cols-3 border-y border-amber-200 bg-white/80 max-[760px]:grid-cols-2">
        {countItems.map(([key, labelKey]) => (
          <div className="border-b border-r border-amber-100 px-3 py-3" key={key}>
            <dt className="text-xs font-semibold text-[var(--workbench-muted)]">
              {t(labelKey)}
            </dt>
            <dd className="mt-1 text-xl font-semibold text-[var(--workbench-text)]">
              {impact.counts[key]}
            </dd>
          </div>
        ))}
      </dl>
      {impact.warnings.length > 0 ? (
        <p className="flex gap-2 px-4 py-4 text-sm font-semibold leading-6 text-amber-900">
          <span aria-hidden="true">!</span>
          <span>
            {t('security.provisioning.warningSummary').replace(
              '{count}',
              String(impact.warnings.length),
            )}
          </span>
        </p>
      ) : null}
      {canApply ? (
        <div className="flex justify-end border-t border-amber-200 px-4 py-4">
          <button
            className="min-h-10 rounded-md border border-red-700 bg-red-700 px-4 text-sm font-semibold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-600"
            data-testid="security-provisioning-apply"
            disabled={isBusy || isExpired || isBlocking}
            type="button"
            onClick={onRequestApply}
          >
            {t(
              isBlocking
                ? 'security.provisioning.previewBlockedAction'
                : isExpired
                  ? 'security.provisioning.previewExpiredAction'
                  : 'security.provisioning.apply',
            )}
          </button>
        </div>
      ) : null}
    </section>
  )
}
