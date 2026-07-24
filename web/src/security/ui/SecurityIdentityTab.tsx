import { useState, type FormEvent } from 'react'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type {
  CreateEnterpriseDomainClaimInput,
  EnterpriseDomainVerificationChallenge,
  EnterpriseSecuritySnapshot,
  UpdateEnterpriseIdentityProviderInput,
} from '../api'
import {
  formatEnterpriseSecurityDate,
  createEnterpriseSecurityTestId,
} from '../model/enterpriseSecurityDisplay'
import { createIdentityProviderDraft } from '../model/enterpriseSecurityForms'
import type { EnterpriseSsoPrerequisites } from '../model/enterpriseSecurityReadiness'
import {
  EnterpriseSecurityEmptyState,
  EnterpriseSecurityReadOnlyNotice,
  EnterpriseSecuritySectionHeader,
  EnterpriseSecurityStatusBadge,
  EnterpriseSsoPrerequisiteList,
} from './EnterpriseSecurityFields'

/** Props consumed by the independently renderable identity tab. */
type SecurityIdentityTabProps = {
  /** Operation key for the mutation currently in flight. */
  busyOperation?: string
  /** Locale used for dates and one-time challenge copy. */
  locale: Locale
  /** Resolved SSO enforcement prerequisites. */
  prerequisites: EnterpriseSsoPrerequisites
  /** Enterprise security snapshot visible to the tab. */
  snapshot: EnterpriseSecuritySnapshot
  /** Resolves localized security messages. */
  t: (key: MessageKey) => string
  /** Creates a managed-domain claim and returns its one-time DNS value. */
  onCreateDomain?: (
    input: CreateEnterpriseDomainClaimInput,
  ) => Promise<EnterpriseDomainVerificationChallenge>
  /** Routes an SSO enforcement change through the panel confirmation. */
  onRequestEnforcement: (enforced: boolean) => void
  /** Saves and optionally tests the identity provider. */
  onUpdateIdentityProvider?: (
    input: UpdateEnterpriseIdentityProviderInput & { testConnection?: boolean },
  ) => Promise<unknown>
  /** Rechecks ownership of a managed domain. */
  onVerifyDomain?: (domain: string, expectedVersion: number) => Promise<unknown>
}

/**
 * Renders identity-provider, managed-domain, and SSO-enforcement forms.
 *
 * @param props - Identity snapshot, readiness, mutation callbacks, and copy.
 * @returns The independently renderable identity tab.
 */
export function SecurityIdentityTab({
  busyOperation,
  locale,
  prerequisites,
  snapshot,
  t,
  onCreateDomain,
  onRequestEnforcement,
  onUpdateIdentityProvider,
  onVerifyDomain,
}: SecurityIdentityTabProps) {
  return (
    <div className="grid gap-5" data-testid="security-identity">
      <SecurityIdentityTabContent
        busyOperation={busyOperation}
        key={`identity:${snapshot.identityProvider.version}`}
        locale={locale}
        prerequisites={prerequisites}
        snapshot={snapshot}
        t={t}
        onCreateDomain={onCreateDomain}
        onRequestEnforcement={onRequestEnforcement}
        onUpdateIdentityProvider={onUpdateIdentityProvider}
        onVerifyDomain={onVerifyDomain}
      />
    </div>
  )
}

/**
 * Owns identity form drafts within the identity-provider version boundary.
 *
 * @param props - Identity tab props and mutation callbacks.
 * @returns Identity forms and managed-domain controls.
 */
function SecurityIdentityTabContent({
  busyOperation,
  locale,
  prerequisites,
  snapshot,
  t,
  onCreateDomain,
  onRequestEnforcement,
  onUpdateIdentityProvider,
  onVerifyDomain,
}: SecurityIdentityTabProps) {
  const canManage = snapshot.capabilities.canManageIdentity
  const [draft, setDraft] = useState(() =>
    createIdentityProviderDraft(snapshot.identityProvider),
  )
  const [domain, setDomain] = useState('')
  const isBusy = Boolean(busyOperation)

  /** Saves and tests the identity-provider draft. */
  const handleProviderSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!onUpdateIdentityProvider || isBusy) {
      return
    }

    try {
      await onUpdateIdentityProvider({
        clientId: draft.clientId.trim(),
        displayName: draft.displayName.trim(),
        expectedVersion: snapshot.identityProvider.version,
        issuer: draft.issuer.trim(),
        metadataUrl:
          draft.protocol === 'saml' ? (draft.metadataUrl ?? '').trim() : '',
        protocol: draft.protocol,
        ssoUrl: draft.ssoUrl.trim(),
        testConnection: true,
      })
    } catch {
      // The container owns the shared mutation error banner.
    }
  }

  /** Creates a managed-domain claim through the panel-owned challenge handler. */
  const handleDomainSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedDomain = domain.trim().toLowerCase()

    if (!normalizedDomain || !onCreateDomain || isBusy) {
      return
    }

    try {
      await onCreateDomain({ domain: normalizedDomain })
      setDomain('')
    } catch {
      // The container owns the shared mutation error banner.
    }
  }

  return (
    <>
      {!canManage ? <EnterpriseSecurityReadOnlyNotice t={t} /> : null}

      <form
        className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white"
        data-testid="security-identity-provider-form"
        onSubmit={(event) => void handleProviderSubmit(event)}
      >
        <EnterpriseSecuritySectionHeader
          badge={t(
            `security.identity.status.${snapshot.identityProvider.status}`,
          )}
          description={t('security.identity.providerDescription')}
          title={t('security.identity.providerTitle')}
        />
        <div className="grid grid-cols-2 gap-4 border-t border-[var(--workbench-border)] p-5 max-[760px]:grid-cols-1">
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('security.identity.protocol')}
            <select
              className="workbench-input min-h-10 px-3"
              disabled={!canManage || isBusy}
              value={draft.protocol}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  protocol: event.target.value === 'oidc' ? 'oidc' : 'saml',
                }))
              }
            >
              <option value="saml">SAML 2.0</option>
              <option value="oidc">OpenID Connect</option>
            </select>
          </label>
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('security.identity.displayName')}
            <input
              className="workbench-input min-h-10 px-3"
              disabled={!canManage || isBusy}
              required
              value={draft.displayName}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  displayName: event.target.value,
                }))
              }
            />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('security.identity.issuer')}
            <input
              className="workbench-input min-h-10 px-3"
              disabled={!canManage || isBusy}
              inputMode={draft.protocol === 'oidc' ? 'url' : undefined}
              required
              type={draft.protocol === 'oidc' ? 'url' : 'text'}
              value={draft.issuer}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  issuer: event.target.value,
                }))
              }
            />
          </label>
          {draft.protocol === 'saml' ? (
            <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('security.identity.metadataUrl')}
              <input
                className="workbench-input min-h-10 px-3"
                disabled={!canManage || isBusy}
                inputMode="url"
                placeholder="https://idp.example.com/saml/metadata"
                required
                type="url"
                value={draft.metadataUrl ?? ''}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    metadataUrl: event.target.value,
                  }))
                }
              />
              <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                {t('security.identity.metadataUrlHelp')}
              </span>
            </label>
          ) : null}
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('security.identity.ssoUrl')}
            <input
              className="workbench-input min-h-10 px-3"
              disabled={!canManage || isBusy}
              inputMode="url"
              required
              type="url"
              value={draft.ssoUrl}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  ssoUrl: event.target.value,
                }))
              }
            />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('security.identity.clientId')}
            <input
              className="workbench-input min-h-10 px-3"
              disabled={!canManage || isBusy}
              required
              value={draft.clientId}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  clientId: event.target.value,
                }))
              }
            />
          </label>
          <div className="flex items-end justify-end">
            <button
              className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
              data-testid="security-identity-save-test"
              disabled={!canManage || isBusy}
              type="submit"
            >
              {t(
                busyOperation === 'identity-provider:update'
                  ? 'security.action.testing'
                  : 'security.identity.saveAndTest',
              )}
            </button>
          </div>
        </div>
        {snapshot.identityProvider.lastTestedAt ? (
          <p className="border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-3 text-xs font-medium text-[var(--workbench-muted)]">
            {t('security.identity.lastTested').replace(
              '{date}',
              formatEnterpriseSecurityDate(
                snapshot.identityProvider.lastTestedAt,
                locale,
              ),
            )}
          </p>
        ) : null}
      </form>

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <EnterpriseSecuritySectionHeader
          description={t('security.identity.domainsDescription')}
          title={t('security.identity.domainsTitle')}
        />
        {canManage ? (
          <form
            className="flex min-w-0 flex-wrap items-end gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4"
            onSubmit={(event) => void handleDomainSubmit(event)}
          >
            <label className="grid min-w-[240px] flex-1 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('security.identity.domainLabel')}
              <input
                className="workbench-input min-h-10 px-3"
                data-testid="security-domain-input"
                disabled={isBusy}
                placeholder="example.com"
                required
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
              />
            </label>
            <button
              className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55 max-[1240px]:col-span-2 max-[640px]:col-span-1"
              disabled={isBusy || !domain.trim()}
              type="submit"
            >
              {t('security.identity.claimDomain')}
            </button>
          </form>
        ) : null}
        <div className="grid divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
          {snapshot.domains.map((claim) => (
            <article
              className="grid grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)_auto] items-center gap-4 px-4 py-4 max-[760px]:grid-cols-1"
              data-testid={`security-domain-${createEnterpriseSecurityTestId(claim.domain)}`}
              key={claim.id}
            >
              <div>
                <p className="font-semibold text-[var(--workbench-text)]">
                  {claim.domain}
                </p>
                <p className="mt-2 text-xs font-semibold text-[var(--workbench-muted)]">
                  {t('security.identity.verificationRecordName')}
                </p>
                <code className="mt-1 block break-all rounded-md bg-[var(--workbench-surface-muted)] px-2 py-2 text-xs font-semibold text-[var(--workbench-muted)]">
                  {claim.verificationRecordName}
                </code>
              </div>
              <EnterpriseSecurityStatusBadge
                label={t(`security.domain.status.${claim.status}`)}
                tone={
                  claim.status === 'verified'
                    ? 'success'
                    : claim.status === 'conflict'
                      ? 'danger'
                      : 'warning'
                }
              />
              {canManage && claim.status !== 'verified' ? (
                <button
                  aria-label={`${t('security.identity.verifyDomain')}: ${claim.domain}`}
                  className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                  disabled={isBusy}
                  type="button"
                  onClick={() => {
                    if (!onVerifyDomain) {
                      return
                    }

                    void onVerifyDomain(
                      claim.domain,
                      claim.version,
                    ).catch(() => undefined)
                  }}
                >
                  {t('security.identity.verifyDomain')}
                </button>
              ) : null}
            </article>
          ))}
          {snapshot.domains.length === 0 ? (
            <EnterpriseSecurityEmptyState
              text={t('security.identity.domainsEmpty')}
            />
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[#99d7cf] bg-[#f3fbfa]">
        <EnterpriseSecuritySectionHeader
          badge={t(
            snapshot.identityProvider.enforced
              ? 'security.overview.enforced'
              : 'security.overview.notEnforced',
          )}
          description={t('security.identity.enforcementDescription')}
          title={t('security.identity.enforcementTitle')}
        />
        <div className="border-t border-[#b8e2dc] p-5">
          <EnterpriseSsoPrerequisiteList prerequisites={prerequisites} t={t} />
          <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-lg border border-[#b8e2dc] bg-white p-4">
            <p className="max-w-[680px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {t(
                prerequisites.complete
                  ? 'security.identity.enforcementReady'
                  : 'security.identity.enforcementBlocked',
              )}
            </p>
            {canManage ? (
              <button
                className={
                  snapshot.identityProvider.enforced
                    ? 'workbench-button-secondary min-h-10 px-4 text-red-700'
                    : 'workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55'
                }
                data-testid="security-sso-enforcement"
                disabled={
                  isBusy ||
                  (!snapshot.identityProvider.enforced &&
                    !prerequisites.complete)
                }
                type="button"
                onClick={() =>
                  onRequestEnforcement(!snapshot.identityProvider.enforced)
                }
              >
                {t(
                  snapshot.identityProvider.enforced
                    ? 'security.identity.disableEnforcement'
                    : 'security.identity.enableEnforcement',
                )}
              </button>
            ) : null}
          </div>
        </div>
      </section>
    </>
  )
}
