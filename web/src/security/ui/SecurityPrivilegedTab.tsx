import { useRef, useState, type FormEvent } from 'react'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type {
  CreateEnterpriseServiceAccountInput,
  EnterpriseBreakGlassAdministrator,
  EnterpriseSecuritySnapshot,
  EnterpriseServiceAccount,
  EnterpriseServiceAccountCredentialResponse,
  RegisterEnterpriseBreakGlassAdministratorInput,
} from '../api'
import {
  createEnterpriseSecurityTestId,
  formatEnterpriseSecurityDate,
  formatEnterpriseSecurityRoleName,
  formatEnterpriseServiceAccountImpactSummary,
  formatEnterpriseServiceAccountScope,
} from '../model/enterpriseSecurityDisplay'
import {
  createEnterpriseSecurityScopeValue,
  type EnterpriseSecurityScopeOption,
} from '../model/enterpriseSecurityForms'
import { resolveServiceAccountAssignableRoleIds } from '../model/capabilityBoundary'
import {
  EnterpriseSecurityEmptyState,
  EnterpriseSecurityReadOnlyNotice,
  EnterpriseSecuritySectionHeader,
  EnterpriseSecurityStatusBadge,
  SecurityNumberField,
} from './EnterpriseSecurityFields'
import { EnterpriseOneTimeSecretNotice } from './EnterpriseOneTimeSecretNotice'

/** Props consumed by the independently renderable privileged-access tab. */
type SecurityPrivilegedTabProps = {
  /** Operation key for the mutation currently in flight. */
  busyOperation?: string
  /** Locale used for dates and one-time credential copy. */
  locale: Locale
  /** Scopes available to service accounts. */
  scopeOptions: EnterpriseSecurityScopeOption[]
  /** Enterprise security snapshot visible to the tab. */
  snapshot: EnterpriseSecuritySnapshot
  /** Resolves localized security messages. */
  t: (key: MessageKey) => string
  /** Pre-registers an emergency administrator. */
  onRegisterBreakGlass?: (
    input: RegisterEnterpriseBreakGlassAdministratorInput,
  ) => Promise<unknown>
  /** Records a recovery-access self-test. */
  onTestBreakGlass?: () => Promise<unknown>
  /** Creates a service account and returns its one-time credential. */
  onCreateServiceAccount?: (
    input: CreateEnterpriseServiceAccountInput,
  ) => Promise<EnterpriseServiceAccountCredentialResponse>
  /** Routes emergency-administrator deactivation through confirmation. */
  onRequestDeactivateBreakGlass: (
    administrator: EnterpriseBreakGlassAdministrator,
  ) => void
  /** Routes service-account revocation through confirmation. */
  onRequestRevokeServiceAccount: (
    account: EnterpriseServiceAccount,
    onRevoked: () => void,
  ) => void
  /** Routes credential rotation through confirmation. */
  onRequestRotateServiceAccount: (
    account: EnterpriseServiceAccount,
    onRotated: (
      response: EnterpriseServiceAccountCredentialResponse,
    ) => void,
  ) => void
}

/**
 * Renders service-account credentials and break-glass administrator controls.
 *
 * @param props - Privileged snapshot, scope options, mutations, and localized copy.
 * @returns The independently renderable privileged-access tab.
 */
export function SecurityPrivilegedTab({
  busyOperation,
  locale,
  scopeOptions,
  snapshot,
  t,
  onRegisterBreakGlass,
  onTestBreakGlass,
  onCreateServiceAccount,
  onRequestDeactivateBreakGlass,
  onRequestRevokeServiceAccount,
  onRequestRotateServiceAccount,
}: SecurityPrivilegedTabProps) {
  const [oneTimeSecret, setOneTimeSecret] = useState<{
    accountId: string
    displayId: number
    label: string
    token: string
  }>()
  const oneTimeSecretDisplayIdRef = useRef(0)
  const formBoundary = `${snapshot.roles
    .map((role) => `${role.id}:${role.version}`)
    .join(',')}:${scopeOptions
    .map((scope) => `${scope.type}:${scope.id}`)
    .join(',')}`

  /** Retains a service-account credential across form-boundary remounts. */
  const showOneTimeSecret = (
    response: EnterpriseServiceAccountCredentialResponse,
  ) => {
    oneTimeSecretDisplayIdRef.current += 1
    setOneTimeSecret({
      accountId: response.serviceAccount.id,
      displayId: oneTimeSecretDisplayIdRef.current,
      label: response.serviceAccount.name,
      token: response.token,
    })
  }

  return (
    <div className="grid gap-5" data-testid="security-privileged">
      {oneTimeSecret ? (
        <EnterpriseOneTimeSecretNotice
          key={oneTimeSecret.displayId}
          kind="service-account"
          label={oneTimeSecret.label}
          locale={locale}
          token={oneTimeSecret.token}
          onDismiss={() => setOneTimeSecret(undefined)}
        />
      ) : null}

      <SecurityPrivilegedTabContent
        busyOperation={busyOperation}
        key={formBoundary}
        locale={locale}
        scopeOptions={scopeOptions}
        snapshot={snapshot}
        t={t}
        onCreateServiceAccount={onCreateServiceAccount}
        onRegisterBreakGlass={onRegisterBreakGlass}
        onRequestDeactivateBreakGlass={onRequestDeactivateBreakGlass}
        onRequestRevokeServiceAccount={onRequestRevokeServiceAccount}
        onRequestRotateServiceAccount={onRequestRotateServiceAccount}
        onSecretIssued={showOneTimeSecret}
        onServiceAccountRevoked={(accountId) =>
          setOneTimeSecret((current) =>
            current?.accountId === accountId ? undefined : current,
          )
        }
        onTestBreakGlass={onTestBreakGlass}
      />
    </div>
  )
}

/**
 * Owns privileged form drafts within the current role and scope boundary.
 *
 * @param props - Privileged tab props and one-time credential callbacks.
 * @returns Service-account and emergency-administrator controls.
 */
function SecurityPrivilegedTabContent({
  busyOperation,
  locale,
  scopeOptions,
  snapshot,
  t,
  onRegisterBreakGlass,
  onTestBreakGlass,
  onCreateServiceAccount,
  onRequestDeactivateBreakGlass,
  onRequestRevokeServiceAccount,
  onRequestRotateServiceAccount,
  onSecretIssued,
  onServiceAccountRevoked,
}: SecurityPrivilegedTabProps & {
  onSecretIssued: (
    response: EnterpriseServiceAccountCredentialResponse,
  ) => void
  onServiceAccountRevoked: (accountId: string) => void
}) {
  const canManageServiceAccounts =
    snapshot.capabilities.canManagePrivilegedAccess
  const canManageBreakGlass = snapshot.capabilities.canManageBreakGlass
  const defaultServiceAccountScope =
    scopeOptions.find((scope) => scope.type === 'workspace') ?? scopeOptions[0]
  const [serviceAccountName, setServiceAccountName] = useState('')
  const [serviceAccountRoleId, setServiceAccountRoleId] = useState('')
  const [serviceAccountScopeValue, setServiceAccountScopeValue] = useState(
    defaultServiceAccountScope
      ? createEnterpriseSecurityScopeValue(defaultServiceAccountScope)
      : '',
  )
  const [
    serviceAccountCredentialLifetimeDays,
    setServiceAccountCredentialLifetimeDays,
  ] = useState(90)
  const [serviceAccountSourceCidrs, setServiceAccountSourceCidrs] = useState('')
  const [breakGlassEmail, setBreakGlassEmail] = useState('')
  const isBusy = Boolean(busyOperation)
  const selectedServiceAccountScope = scopeOptions.find(
    (scope) =>
      createEnterpriseSecurityScopeValue(scope) === serviceAccountScopeValue,
  )
  const assignableRoleIds = new Set(
    selectedServiceAccountScope
      ? resolveServiceAccountAssignableRoleIds(
          snapshot,
          selectedServiceAccountScope.type,
        )
      : [],
  )
  const availableRoles = snapshot.roles.filter((role) =>
    assignableRoleIds.has(role.id),
  )
  const selectedServiceAccountRoleId = availableRoles.some(
    (role) => role.id === serviceAccountRoleId,
  )
    ? serviceAccountRoleId
    : ''
  const normalizedServiceAccountSourceCidrs = Array.from(
    new Set(
      serviceAccountSourceCidrs
        .split(/\r?\n/)
        .map((cidr) => cidr.trim())
        .filter(Boolean),
    ),
  )

  /** Creates a scoped service account and displays its credential once. */
  const handleCreateServiceAccount = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    if (
      !canManageServiceAccounts ||
      !serviceAccountName.trim() ||
      !selectedServiceAccountRoleId ||
      !selectedServiceAccountScope ||
      serviceAccountCredentialLifetimeDays < 1 ||
      serviceAccountCredentialLifetimeDays > 365 ||
      !onCreateServiceAccount ||
      isBusy
    ) {
      return
    }

    try {
      const response = await onCreateServiceAccount({
        allowedSourceCidrs: normalizedServiceAccountSourceCidrs,
        credentialLifetimeDays: serviceAccountCredentialLifetimeDays,
        name: serviceAccountName.trim(),
        roleId: selectedServiceAccountRoleId,
        scopeId:
          selectedServiceAccountScope.type === 'workspace'
            ? undefined
            : selectedServiceAccountScope.id,
        scopeType: selectedServiceAccountScope.type,
      })
      onSecretIssued(response)
      setServiceAccountName('')
      setServiceAccountRoleId('')
      setServiceAccountCredentialLifetimeDays(90)
      setServiceAccountSourceCidrs('')
    } catch {
      // The container owns the shared mutation error banner.
    }
  }

  /** Registers a break-glass administrator from the local form state. */
  const handleRegisterBreakGlass = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()
    const email = breakGlassEmail.trim().toLowerCase()

    if (!canManageBreakGlass || !email || !onRegisterBreakGlass || isBusy) {
      return
    }

    try {
      await onRegisterBreakGlass({ email })
      setBreakGlassEmail('')
    } catch {
      // The container owns the shared mutation error banner.
    }
  }

  return (
    <>
      {!canManageServiceAccounts && !canManageBreakGlass ? (
        <EnterpriseSecurityReadOnlyNotice t={t} />
      ) : null}

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <EnterpriseSecuritySectionHeader
          description={t('security.privileged.serviceAccountsDescription')}
          title={t('security.privileged.serviceAccountsTitle')}
        />
        {canManageServiceAccounts ? (
          <form
            className="grid grid-cols-2 items-end gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4 max-[760px]:grid-cols-1"
            onSubmit={(event) => void handleCreateServiceAccount(event)}
          >
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.privileged.serviceAccountName')}
              <input
                className="workbench-input min-h-10 px-3"
                disabled={isBusy}
                maxLength={100}
                required
                value={serviceAccountName}
                onChange={(event) => setServiceAccountName(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.privileged.serviceAccountScope')}
              <select
                className="workbench-input min-h-10 px-3"
                disabled={isBusy || scopeOptions.length === 0}
                required
                value={serviceAccountScopeValue}
                onChange={(event) => {
                  setServiceAccountScopeValue(event.target.value)
                  setServiceAccountRoleId('')
                }}
              >
                {scopeOptions.map((scope) => (
                  <option
                    key={createEnterpriseSecurityScopeValue(scope)}
                    value={createEnterpriseSecurityScopeValue(scope)}
                  >
                    {t(`security.scope.${scope.type}`)} · {scope.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.privileged.role')}
              <select
                className="workbench-input min-h-10 px-3"
                disabled={isBusy || availableRoles.length === 0}
                required
                value={selectedServiceAccountRoleId}
                onChange={(event) =>
                  setServiceAccountRoleId(event.target.value)
                }
              >
                <option disabled value="">
                  {t('security.privileged.selectRole')}
                </option>
                {availableRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {formatEnterpriseSecurityRoleName(role, t)}
                  </option>
                ))}
              </select>
            </label>
            <SecurityNumberField
              description={t('security.privileged.credentialLifetimeHelp')}
              disabled={isBusy}
              label={t('security.privileged.credentialLifetime')}
              max={365}
              min={1}
              unit={t('security.unit.days')}
              value={serviceAccountCredentialLifetimeDays}
              onChange={setServiceAccountCredentialLifetimeDays}
            />
            <label className="col-span-2 grid gap-2 text-xs font-semibold text-[var(--workbench-muted)] max-[760px]:col-span-1">
              {t('security.privileged.allowedSourceCidrs')}
              <textarea
                className="workbench-input min-h-24 resize-y px-3 py-2 font-mono text-sm"
                disabled={isBusy}
                placeholder={'203.0.113.0/24\n2001:db8::/48'}
                value={serviceAccountSourceCidrs}
                onChange={(event) =>
                  setServiceAccountSourceCidrs(event.target.value)
                }
              />
              <span className="font-medium leading-5">
                {t('security.privileged.allowedSourceCidrsHelp')}
              </span>
            </label>
            <div
              className={`col-span-2 rounded-lg border p-3 text-sm font-semibold leading-6 max-[760px]:col-span-1 ${
                normalizedServiceAccountSourceCidrs.length > 0
                  ? 'border-[#99d7cf] bg-[#e8f6f3] text-[#285f59]'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
              }`}
            >
              <strong className="block">
                {t('security.privileged.impactSummary')}
              </strong>
              <span>
                {formatEnterpriseServiceAccountImpactSummary(
                  selectedServiceAccountScope,
                  serviceAccountCredentialLifetimeDays,
                  normalizedServiceAccountSourceCidrs.length,
                  t,
                )}
              </span>
            </div>
            <button
              className="workbench-button-primary col-span-2 min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55 max-[760px]:col-span-1"
              disabled={
                isBusy ||
                !serviceAccountName.trim() ||
                !selectedServiceAccountRoleId ||
                !selectedServiceAccountScope ||
                serviceAccountCredentialLifetimeDays < 1 ||
                serviceAccountCredentialLifetimeDays > 365
              }
              type="submit"
            >
              {t('security.privileged.createServiceAccount')}
            </button>
          </form>
        ) : null}
        <div className="grid divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
          {snapshot.serviceAccounts.map((account) => {
            const role = snapshot.roles.find(
              (candidate) => candidate.id === account.roleId,
            )

            return (
              <article
                className="grid grid-cols-[minmax(200px,1.1fr)_minmax(160px,0.7fr)_minmax(220px,0.8fr)_auto] items-center gap-4 px-4 py-4 max-[980px]:grid-cols-2 max-[600px]:grid-cols-1"
                data-testid={`security-service-account-${createEnterpriseSecurityTestId(account.id)}`}
                key={account.id}
              >
                <div>
                  <p className="font-semibold text-[var(--workbench-text)]">
                    {account.name}
                  </p>
                  <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                    {t('security.privileged.credentialGeneration').replace(
                      '{generation}',
                      String(account.credentialGeneration),
                    )}
                  </p>
                </div>
                <div className="grid gap-2">
                  <EnterpriseSecurityStatusBadge
                    label={t(`security.service.status.${account.status}`)}
                    tone={account.status === 'active' ? 'success' : 'neutral'}
                  />
                  <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                    {role
                      ? formatEnterpriseSecurityRoleName(role, t)
                      : account.roleId}
                  </span>
                </div>
                <div className="grid gap-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                  <p>
                    {t('security.privileged.serviceAccountScopeValue').replace(
                      '{scope}',
                      formatEnterpriseServiceAccountScope(
                        account,
                        scopeOptions,
                        t,
                      ),
                    )}
                  </p>
                  <p>
                    {t('security.privileged.credentialExpires').replace(
                      '{date}',
                      account.credentialExpiresAt
                        ? formatEnterpriseSecurityDate(
                            account.credentialExpiresAt,
                            locale,
                          )
                        : t('security.value.notConfigured'),
                    )}
                  </p>
                  <p>
                    {account.allowedSourceCidrs.length > 0
                      ? t('security.privileged.sourceCidrsRestricted').replace(
                          '{count}',
                          String(account.allowedSourceCidrs.length),
                        )
                      : t('security.privileged.sourceCidrsUnrestricted')}
                  </p>
                  <p>
                    {t('security.privileged.lastUsed').replace(
                      '{date}',
                      account.lastUsedAt
                        ? formatEnterpriseSecurityDate(account.lastUsedAt, locale)
                        : t('security.value.never'),
                    )}
                  </p>
                </div>
                {canManageServiceAccounts && account.status === 'active' ? (
                  <div className="flex flex-wrap justify-end gap-2 max-[600px]:justify-start">
                    <button
                      aria-label={`${t('security.privileged.rotateCredential')}: ${account.name}`}
                      className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                      disabled={isBusy}
                      type="button"
                      onClick={() =>
                        onRequestRotateServiceAccount(
                          account,
                          onSecretIssued,
                        )
                      }
                    >
                      {t(
                        busyOperation ===
                          `service-account:rotate:${account.id}`
                          ? 'security.action.rotating'
                          : 'security.privileged.rotateCredential',
                      )}
                    </button>
                    <button
                      aria-label={`${t('security.privileged.revoke')}: ${account.name}`}
                      className="workbench-button-secondary min-h-9 px-3 text-red-700 disabled:cursor-not-allowed disabled:opacity-55"
                      disabled={isBusy}
                      type="button"
                      onClick={() =>
                        onRequestRevokeServiceAccount(account, () =>
                          onServiceAccountRevoked(account.id),
                        )
                      }
                    >
                      {t('security.privileged.revoke')}
                    </button>
                  </div>
                ) : null}
              </article>
            )
          })}
          {snapshot.serviceAccounts.length === 0 ? (
            <EnterpriseSecurityEmptyState
              text={t('security.privileged.serviceAccountsEmpty')}
            />
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-amber-300 bg-amber-50/40">
        <EnterpriseSecuritySectionHeader
          badge={t('security.privileged.recoveryOnly')}
          description={t('security.privileged.breakGlassDescription')}
          title={t('security.privileged.breakGlassTitle')}
        />
        {canManageBreakGlass ? (
          <form
            className="flex min-w-0 flex-wrap items-end gap-3 border-t border-amber-200 bg-amber-50 p-4"
            onSubmit={(event) => void handleRegisterBreakGlass(event)}
          >
            <label className="grid min-w-[260px] flex-1 gap-2 text-xs font-semibold text-amber-950">
              {t('security.privileged.breakGlassEmail')}
              <input
                className="workbench-input min-h-10 px-3"
                disabled={isBusy}
                required
                type="email"
                value={breakGlassEmail}
                onChange={(event) => setBreakGlassEmail(event.target.value)}
              />
            </label>
            <button
              className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55"
              disabled={isBusy || !breakGlassEmail.trim()}
              type="submit"
            >
              {t('security.privileged.registerBreakGlass')}
            </button>
            {onTestBreakGlass ? (
              <button
                className="workbench-button-secondary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55"
                data-testid="security-break-glass-test"
                disabled={isBusy}
                type="button"
                onClick={() => void onTestBreakGlass().catch(() => undefined)}
              >
                {t(
                  busyOperation === 'break-glass:test'
                    ? 'security.privileged.testingBreakGlass'
                    : 'security.privileged.testBreakGlass',
                )}
              </button>
            ) : null}
          </form>
        ) : null}
        <div className="grid divide-y divide-amber-200 border-t border-amber-200 bg-white">
          {snapshot.breakGlassAdministrators.map((administrator) => (
            <article
              className="grid grid-cols-[minmax(240px,1fr)_minmax(170px,0.7fr)_minmax(220px,0.8fr)_auto] items-center gap-4 px-4 py-4 max-[980px]:grid-cols-2 max-[600px]:grid-cols-1"
              data-testid={`security-break-glass-${createEnterpriseSecurityTestId(administrator.id)}`}
              key={administrator.id}
            >
              <div>
                <p className="break-all font-semibold text-[var(--workbench-text)]">
                  {administrator.email}
                </p>
                <p className="mt-1 text-xs font-semibold text-[var(--workbench-muted)]">
                  {t(
                    administrator.mfaConfigured
                      ? 'security.privileged.mfaConfigured'
                      : 'security.privileged.mfaRequired',
                  )}
                </p>
              </div>
              <EnterpriseSecurityStatusBadge
                label={t(
                  `security.breakGlass.status.${administrator.status}`,
                )}
                tone={
                  administrator.status === 'active' ? 'warning' : 'neutral'
                }
              />
              <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                {t('security.privileged.lastTested').replace(
                  '{date}',
                  administrator.lastTestedAt
                    ? formatEnterpriseSecurityDate(
                        administrator.lastTestedAt,
                        locale,
                      )
                    : t('security.value.never'),
                )}
              </p>
              {canManageBreakGlass && administrator.status === 'active' ? (
                <button
                  aria-label={`${t('security.privileged.deactivate')}: ${administrator.email}`}
                  className="workbench-button-secondary min-h-9 px-3 text-red-700 disabled:cursor-not-allowed disabled:opacity-55"
                  disabled={isBusy}
                  type="button"
                  onClick={() =>
                    onRequestDeactivateBreakGlass(administrator)
                  }
                >
                  {t('security.privileged.deactivate')}
                </button>
              ) : null}
            </article>
          ))}
          {snapshot.breakGlassAdministrators.length === 0 ? (
            <EnterpriseSecurityEmptyState
              text={t('security.privileged.breakGlassEmpty')}
            />
          ) : null}
        </div>
      </section>
    </>
  )
}
