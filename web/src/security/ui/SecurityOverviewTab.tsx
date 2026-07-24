import type { MessageKey } from '../../shared/i18n/i18n'
import type { EnterpriseSecuritySnapshot } from '../api'
import type { EnterpriseSsoPrerequisites } from '../model/enterpriseSecurityReadiness'
import type { EnterpriseSecurityTab } from '../model/tabs'
import { EnterpriseSsoPrerequisiteList } from './EnterpriseSecurityFields'

/**
 * Renders enterprise security posture metrics and navigation shortcuts.
 *
 * @param props - Snapshot, readiness, translator, and tab-selection callback.
 * @returns The independently renderable overview tab.
 */
export function SecurityOverviewTab({
  prerequisites,
  snapshot,
  t,
  onSelectTab,
}: {
  prerequisites: EnterpriseSsoPrerequisites
  snapshot: EnterpriseSecuritySnapshot
  t: (key: MessageKey) => string
  onSelectTab: (tab: EnterpriseSecurityTab) => void
}) {
  const {
    canViewIdentity,
    canViewPrivileged,
    canViewProvisioning,
    canViewSessions,
  } = snapshot.capabilities
  const failedProvisioningCount = canViewProvisioning
    ? snapshot.provisioningLogs.filter(
        (log) => log.status === 'failed' || log.status === 'partial',
      ).length
    : 0
  const activeServiceAccounts = canViewPrivileged
    ? snapshot.serviceAccounts.filter((account) => account.status === 'active')
        .length
    : 0
  const activeBreakGlass = canViewPrivileged
    ? snapshot.breakGlassAdministrators.filter(
        (administrator) => administrator.status === 'active',
      ).length
    : 0
  const privilegedBreakGlassReady = canViewPrivileged
    ? snapshot.breakGlassAdministrators.some(
        (administrator) =>
          administrator.status === 'active' && administrator.mfaConfigured,
      )
    : false
  const hasOverviewMetrics =
    canViewIdentity || canViewProvisioning || canViewPrivileged
  const allNavigationCards: readonly [
    EnterpriseSecurityTab,
    MessageKey,
    MessageKey,
    boolean,
  ][] = [
    [
      'identity',
      'security.overview.card.identityTitle',
      'security.overview.card.identityDescription',
      canViewIdentity,
    ],
    [
      'provisioning',
      'security.overview.card.provisioningTitle',
      'security.overview.card.provisioningDescription',
      canViewProvisioning,
    ],
    [
      'sessions',
      'security.overview.card.sessionsTitle',
      'security.overview.card.sessionsDescription',
      canViewSessions,
    ],
  ]
  const navigationCards = allNavigationCards.filter(
    ([, , , canView]) => canView,
  )

  return (
    <div className="grid gap-5" data-testid="security-overview">
      {hasOverviewMetrics ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)]">
          {canViewIdentity ? (
            <OverviewMetric
              label={t('security.overview.metric.sso')}
              tone={snapshot.identityProvider.enforced ? 'success' : 'warning'}
              value={t(
                snapshot.identityProvider.enforced
                  ? 'security.overview.enforced'
                  : 'security.overview.notEnforced',
              )}
            />
          ) : null}
          {canViewProvisioning ? (
            <>
              <OverviewMetric
                label={t('security.overview.metric.scim')}
                tone={
                  snapshot.scim.status === 'ready'
                    ? 'success'
                    : snapshot.scim.status === 'error'
                      ? 'danger'
                      : 'warning'
                }
                value={t(`security.scim.status.${snapshot.scim.status}`)}
              />
              <OverviewMetric
                label={t('security.overview.metric.provisioningErrors')}
                tone={failedProvisioningCount > 0 ? 'danger' : 'success'}
                value={String(failedProvisioningCount)}
              />
            </>
          ) : null}
          {canViewPrivileged ? (
            <OverviewMetric
              label={t('security.overview.metric.privileged')}
              tone={privilegedBreakGlassReady ? 'success' : 'danger'}
              value={t('security.overview.privilegedCount')
                .replace('{service}', String(activeServiceAccounts))
                .replace('{breakGlass}', String(activeBreakGlass))}
            />
          ) : null}
        </div>
      ) : null}

      {canViewIdentity && canViewPrivileged ? (
        <section className="rounded-lg border border-[var(--workbench-border)] bg-white p-5">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 max-w-[700px]">
              <p className="workbench-eyebrow">
                {t('security.overview.readinessEyebrow')}
              </p>
              <h3 className="mt-2 text-lg font-semibold text-[var(--workbench-text)]">
                {t('security.overview.readinessTitle')}
              </h3>
              <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t('security.overview.readinessDescription')}
              </p>
            </div>
            <span
              className={
                prerequisites.complete
                  ? 'workbench-badge-success'
                  : 'workbench-badge-warning'
              }
            >
              {t(
                prerequisites.complete
                  ? 'security.prerequisite.ready'
                  : 'security.prerequisite.actionRequired',
              )}
            </span>
          </div>
          <EnterpriseSsoPrerequisiteList prerequisites={prerequisites} t={t} />
        </section>
      ) : null}

      {navigationCards.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          {navigationCards.map(([tab, titleKey, descriptionKey]) => (
            <button
              className="group rounded-lg border border-[var(--workbench-border)] bg-white p-4 text-left transition hover:border-[#99d7cf] hover:shadow-sm"
              key={tab}
              type="button"
              onClick={() => onSelectTab(tab)}
            >
              <strong className="block text-sm font-semibold text-[var(--workbench-text)]">
                {t(titleKey)}
              </strong>
              <span className="mt-2 block text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t(descriptionKey)}
              </span>
              <span className="mt-4 inline-flex text-sm font-semibold text-[var(--workbench-primary)]">
                {t('security.overview.open')} →
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Renders one posture metric with a severity-aware value.
 *
 * @param props - Metric label, value, and tone.
 * @returns The overview metric cell.
 */
function OverviewMetric({
  label,
  tone,
  value,
}: {
  label: string
  tone: 'success' | 'warning' | 'danger'
  value: string
}) {
  const toneClassName = {
    danger: 'text-red-700',
    success: 'text-emerald-700',
    warning: 'text-amber-700',
  }[tone]

  return (
    <div className="border-r border-[var(--workbench-border)] px-4 py-4 last:border-r-0 max-[980px]:border-b">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
        {label}
      </p>
      <p className={`mt-2 text-base font-semibold ${toneClassName}`}>{value}</p>
    </div>
  )
}
