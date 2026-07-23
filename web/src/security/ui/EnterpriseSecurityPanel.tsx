import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  createTranslator,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import type {
  CreateEnterpriseDomainClaimInput,
  CreateEnterpriseGroupRoleMappingInput,
  CreateEnterpriseRoleInput,
  CreateEnterpriseServiceAccountInput,
  EnterpriseBreakGlassAdministrator,
  EnterpriseDomainVerificationChallenge,
  EnterpriseGroupRoleMapping,
  EnterpriseProvisioningImpact,
  EnterpriseProvisioningLog,
  EnterpriseRoleDefinition,
  EnterpriseRoleImpact,
  EnterpriseScimTokenResponse,
  EnterpriseSecuritySnapshot,
  EnterpriseServiceAccount,
  EnterpriseServiceAccountCredentialResponse,
  EnterpriseSessionPolicyImpact,
  PreviewEnterpriseRoleImpactInput,
  RegisterEnterpriseBreakGlassAdministratorInput,
  UpdateEnterpriseGroupRoleMappingInput,
  UpdateEnterpriseIdentityProviderInput,
  UpdateEnterpriseRoleInput,
  UpdateEnterpriseSessionPolicyInput,
  UpdateEnterpriseSsoEnforcementInput,
} from '../api'
import {
  createEnterpriseSecurityStateBoundary,
  createSecurityAccessBoundaryKey,
} from '../model/capabilityBoundary'
import type { EnterpriseSecurityConfirmation } from '../model/enterpriseSecurityConfirmation'
import type { EnterpriseSecurityScopeOption } from '../model/enterpriseSecurityForms'
import { isEnterpriseProvisioningImpactExpired } from '../model/enterpriseProvisioningImpact'
import { resolveEnterpriseSsoPrerequisites } from '../model/enterpriseSecurityReadiness'
import {
  resolveEnterpriseSecurityTabTarget,
  resolveVisibleEnterpriseSecurityTab,
  resolveVisibleEnterpriseSecurityTabs,
  type EnterpriseSecurityTab,
} from '../model/tabs'
import { EnterpriseSecurityConfirmationDialog } from './EnterpriseSecurityConfirmationDialog'
import { SecurityAccessTab } from './SecurityAccessTab'
import { SecurityIdentityTab } from './SecurityIdentityTab'
import { SecurityOverviewTab } from './SecurityOverviewTab'
import { SecurityPrivilegedTab } from './SecurityPrivilegedTab'
import { SecurityProvisioningTab } from './SecurityProvisioningTab'
import { SecuritySessionsTab } from './SecuritySessionsTab'

/** Re-exported scope option type for existing panel consumers. */
export type { EnterpriseSecurityScopeOption } from '../model/enterpriseSecurityForms'
/** Re-exported domain challenge notice for existing panel consumers. */
export {
  EnterpriseDomainVerificationChallengeNotice,
  type EnterpriseDomainVerificationChallengeNoticeProps,
} from './EnterpriseDomainVerificationChallengeNotice'
/** Re-exported one-time secret notice for existing panel consumers. */
export {
  EnterpriseOneTimeSecretNotice,
  type EnterpriseOneTimeSecretNoticeProps,
} from './EnterpriseOneTimeSecretNotice'

/**
 * Display state and mutation callbacks consumed by EnterpriseSecurityPanel.
 */
export type EnterpriseSecurityPanelProps = {
  /** Locale used to render the panel. */
  locale: Locale
  /** Enterprise identity and security administration snapshot. */
  snapshot?: EnterpriseSecuritySnapshot
  /** Whether the initial snapshot is loading. */
  isLoading?: boolean
  /** Safe message displayed when the initial snapshot cannot be loaded. */
  loadErrorMessage?: string
  /** Label for an optional load-error recovery action. */
  loadErrorActionLabel?: string
  /** Whether revalidation failed and the displayed snapshot may be stale. */
  isStale?: boolean
  /** Safe message displayed after a mutation failure. */
  mutationErrorMessage?: string
  /** Operation key for the mutation currently in flight. */
  busyOperation?: string
  /** Administration tab selected on the initial mount. */
  initialTab?: EnterpriseSecurityTab
  /** Scopes available to group mappings and service accounts. */
  scopeOptions: EnterpriseSecurityScopeOption[]
  /** Revalidates the enterprise security snapshot. */
  onRefresh?: () => Promise<unknown> | unknown
  /** Replaces reload with a dedicated load-error recovery action. */
  onLoadErrorAction?: () => Promise<unknown> | unknown
  /** Saves and optionally tests the identity provider. */
  onUpdateIdentityProvider?: (
    input: UpdateEnterpriseIdentityProviderInput & { testConnection?: boolean },
  ) => Promise<unknown>
  /** Updates managed-domain SSO enforcement. */
  onUpdateSsoEnforcement?: (
    input: UpdateEnterpriseSsoEnforcementInput,
  ) => Promise<unknown>
  /** Creates a domain claim and returns its one-time DNS challenge. */
  onCreateDomain?: (
    input: CreateEnterpriseDomainClaimInput,
  ) => Promise<EnterpriseDomainVerificationChallenge>
  /** Rechecks domain ownership. */
  onVerifyDomain?: (domain: string, expectedVersion: number) => Promise<unknown>
  /** Creates or rotates the SCIM bearer token. */
  onRotateScimToken?: () => Promise<EnterpriseScimTokenResponse>
  /** Produces a dry-run provisioning reconciliation preview. */
  onPreviewProvisioning?: () => Promise<EnterpriseProvisioningImpact>
  /** Applies a previously confirmed provisioning preview. */
  onApplyProvisioning?: (
    impact: EnterpriseProvisioningImpact,
  ) => Promise<unknown>
  /** Retries a retryable provisioning operation. */
  onRetryProvisioningLog?: (
    log: EnterpriseProvisioningLog,
  ) => Promise<unknown>
  /** Creates a directory-group role mapping. */
  onCreateMapping?: (
    input: CreateEnterpriseGroupRoleMappingInput,
  ) => Promise<unknown>
  /** Deletes a directory-group role mapping. */
  onDeleteMapping?: (
    mapping: EnterpriseGroupRoleMapping,
  ) => Promise<unknown>
  /** Updates a directory-group mapping's scope or role. */
  onUpdateMapping?: (
    mappingId: string,
    input: UpdateEnterpriseGroupRoleMappingInput,
  ) => Promise<unknown>
  /** Creates a custom role. */
  onCreateRole?: (input: CreateEnterpriseRoleInput) => Promise<unknown>
  /** Updates a custom role permission set. */
  onUpdateRole?: (
    roleId: string,
    input: UpdateEnterpriseRoleInput,
  ) => Promise<unknown>
  /** Deletes an unused custom role. */
  onDeleteRole?: (
    role: EnterpriseRoleDefinition,
    impactConfirmationToken: string,
  ) => Promise<unknown>
  /** Previews assignment impact before role update or deletion. */
  onPreviewRoleImpact?: (
    role: EnterpriseRoleDefinition,
    input: PreviewEnterpriseRoleImpactInput,
  ) => Promise<EnterpriseRoleImpact>
  /** Saves MFA, session, network, and guest policy. */
  onUpdateSessionPolicy?: (
    input: UpdateEnterpriseSessionPolicyInput,
  ) => Promise<unknown>
  /** Previews caller-network impact before saving a session policy. */
  onPreviewSessionPolicy?: (
    input: UpdateEnterpriseSessionPolicyInput,
  ) => Promise<EnterpriseSessionPolicyImpact>
  /** Creates a service account and its one-time credential. */
  onCreateServiceAccount?: (
    input: CreateEnterpriseServiceAccountInput,
  ) => Promise<EnterpriseServiceAccountCredentialResponse>
  /** Rotates a service-account credential. */
  onRotateServiceAccount?: (
    account: EnterpriseServiceAccount,
  ) => Promise<EnterpriseServiceAccountCredentialResponse>
  /** Revokes a service account. */
  onRevokeServiceAccount?: (
    account: EnterpriseServiceAccount,
  ) => Promise<unknown>
  /** Pre-registers a break-glass administrator. */
  onRegisterBreakGlass?: (
    input: RegisterEnterpriseBreakGlassAdministratorInput,
  ) => Promise<unknown>
  /** Records a recovery-access self-test from the current session. */
  onTestBreakGlass?: () => Promise<unknown>
  /** Deactivates a break-glass administrator. */
  onDeactivateBreakGlass?: (
    administrator: EnterpriseBreakGlassAdministrator,
  ) => Promise<unknown>
}

const tabLabelKeys: Record<EnterpriseSecurityTab, MessageKey> = {
  overview: 'security.tab.overview',
  identity: 'security.tab.identity',
  provisioning: 'security.tab.provisioning',
  access: 'security.tab.access',
  sessions: 'security.tab.sessions',
  privileged: 'security.tab.privileged',
}

/**
 * Renders the capability-aware enterprise security workspace.
 *
 * @param props - Panel snapshot, loading state, scope options, and mutations.
 * @returns The enterprise security panel.
 */
export function EnterpriseSecurityPanel(props: EnterpriseSecurityPanelProps) {
  const stateBoundary = createEnterpriseSecurityStateBoundary(
    props.snapshot?.capabilities,
    Boolean(props.isStale),
  )

  return <EnterpriseSecurityPanelContent key={stateBoundary} {...props} />
}

/**
 * Owns only navigation and cross-tab confirmation state for the panel.
 *
 * @param props - Panel state and mutation callbacks.
 * @returns The loaded, error, or interactive panel state.
 */
function EnterpriseSecurityPanelContent({
  busyOperation,
  initialTab = 'overview',
  isLoading = false,
  isStale = false,
  loadErrorActionLabel,
  loadErrorMessage,
  locale,
  mutationErrorMessage,
  onRegisterBreakGlass,
  onTestBreakGlass,
  onApplyProvisioning,
  onCreateDomain,
  onCreateMapping,
  onCreateRole,
  onCreateServiceAccount,
  onDeactivateBreakGlass,
  onDeleteMapping,
  onDeleteRole,
  onPreviewProvisioning,
  onPreviewRoleImpact,
  onPreviewSessionPolicy,
  onLoadErrorAction,
  onRefresh,
  onRetryProvisioningLog,
  onRevokeServiceAccount,
  onRotateScimToken,
  onRotateServiceAccount,
  onUpdateIdentityProvider,
  onUpdateMapping,
  onUpdateRole,
  onUpdateSessionPolicy,
  onUpdateSsoEnforcement,
  onVerifyDomain,
  scopeOptions,
  snapshot,
}: EnterpriseSecurityPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [selectedTab, setSelectedTab] = useState<EnterpriseSecurityTab>(() =>
    resolveVisibleEnterpriseSecurityTab(initialTab, snapshot?.capabilities),
  )
  const [confirmation, setConfirmation] =
    useState<EnterpriseSecurityConfirmation>()
  const [isConfirming, setIsConfirming] = useState(false)
  const pendingTabFocus = useRef<EnterpriseSecurityTab | undefined>(undefined)
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (pendingTabFocus.current !== selectedTab) {
      return
    }

    document.getElementById(`security-tab-${selectedTab}`)?.focus()
    pendingTabFocus.current = undefined
  }, [selectedTab])

  if (isLoading && !snapshot) {
    return <EnterpriseSecurityLoadingState locale={locale} />
  }

  if (loadErrorMessage && !snapshot) {
    return (
      <section
        className="workbench-panel grid justify-items-start gap-4 p-5"
        data-testid="enterprise-security-load-error"
      >
        <p className="workbench-eyebrow">{t('security.eyebrow')}</p>
        <h2 className="text-lg font-semibold text-[var(--workbench-text)]">
          {t('security.title')}
        </h2>
        <p className="text-sm font-semibold text-red-700" role="alert">
          {loadErrorMessage}
        </p>
        <button
          className="workbench-button-secondary min-h-10 px-4"
          type="button"
          onClick={() => void (onLoadErrorAction ?? onRefresh)?.()}
        >
          {loadErrorActionLabel ?? t('security.action.retryLoad')}
        </button>
      </section>
    )
  }

  if (!snapshot) {
    return null
  }

  const visibleTabs = resolveVisibleEnterpriseSecurityTabs(
    snapshot.capabilities,
  )
  const prerequisites = resolveEnterpriseSsoPrerequisites(snapshot)

  /** Captures the trigger element before opening a cross-tab confirmation. */
  const requestConfirmation = (next: EnterpriseSecurityConfirmation) => {
    confirmationReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setConfirmation(next)
  }

  /** Selects a visible tab and mirrors it into the route query. */
  const selectTab = (tab: EnterpriseSecurityTab) => {
    if (busyOperation) {
      return
    }

    setSelectedTab(tab)
    updateSecurityTabQuery(tab)
  }

  /** Applies roving-tabindex keyboard navigation. */
  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    tab: EnterpriseSecurityTab,
  ) => {
    if (busyOperation) {
      return
    }

    const nextTab = resolveEnterpriseSecurityTabTarget(
      tab,
      event.key,
      visibleTabs,
    )

    if (!nextTab) {
      return
    }

    event.preventDefault()
    pendingTabFocus.current = nextTab
    selectTab(nextTab)
  }

  /** Executes the operation currently protected by the confirmation dialog. */
  const confirmOperation = async () => {
    if (!confirmation || isConfirming || isStale) {
      return
    }

    if (
      confirmation.kind === 'provisioning' &&
      (confirmation.impact.blocking ||
        isEnterpriseProvisioningImpactExpired(confirmation.impact))
    ) {
      setConfirmation(undefined)
      return
    }

    setIsConfirming(true)

    try {
      if (confirmation.kind === 'sso-enforcement') {
        await onUpdateSsoEnforcement?.({
          enforced: confirmation.enforced,
          expectedVersion: snapshot.identityProvider.version,
        })
      } else if (confirmation.kind === 'provisioning') {
        await onApplyProvisioning?.(confirmation.impact)
        confirmation.onApplied?.()
      } else if (confirmation.kind === 'session-policy') {
        await onUpdateSessionPolicy?.({
          ...confirmation.input,
          callerIpConfirmationToken: confirmation.impact.confirmationToken,
        })
      } else if (confirmation.kind === 'scim-token-rotate') {
        const response = await onRotateScimToken?.()
        if (response) {
          confirmation.onRotated?.(response)
        }
      } else if (confirmation.kind === 'service-account-rotate') {
        const response = await onRotateServiceAccount?.(confirmation.account)
        if (response) {
          confirmation.onRotated?.(response)
        }
      } else if (confirmation.kind === 'service-account-revoke') {
        await onRevokeServiceAccount?.(confirmation.account)
        confirmation.onRevoked?.()
      } else if (confirmation.kind === 'mapping-delete') {
        await onDeleteMapping?.(confirmation.mapping)
      } else if (confirmation.kind === 'mapping-update') {
        await onUpdateMapping?.(
          confirmation.mapping.id,
          confirmation.input,
        )
      } else if (confirmation.kind === 'break-glass') {
        await onDeactivateBreakGlass?.(confirmation.administrator)
      } else if (confirmation.kind === 'role-update') {
        await onUpdateRole?.(confirmation.role.id, {
          ...confirmation.input,
          impactConfirmationToken: confirmation.impact.confirmationToken,
        })
      } else if (confirmation.kind === 'role-delete') {
        await onDeleteRole?.(
          confirmation.role,
          confirmation.impact.confirmationToken ?? '',
        )
      }

      setConfirmation(undefined)
    } catch {
      // Keep the dialog open so the container error banner can support retry.
    } finally {
      setIsConfirming(false)
    }
  }

  return (
    <section
      className="workbench-panel overflow-hidden"
      data-testid="enterprise-security-panel"
    >
      <EnterpriseSecurityHeader snapshot={snapshot} t={t} />

      {loadErrorMessage ? (
        <div
          className="mx-5 mt-5 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
          role="alert"
        >
          <p className="text-sm font-semibold text-amber-900">
            {loadErrorMessage} {t('security.error.stale')}
          </p>
          <button
            className="workbench-button-secondary min-h-9 px-3"
            type="button"
            onClick={() => void onRefresh?.()}
          >
            {t('security.action.refresh')}
          </button>
        </div>
      ) : null}

      <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 pt-3">
        <div
          aria-label={t('security.tabsAria')}
          className="flex min-w-0 gap-1 overflow-x-auto"
          role="tablist"
        >
          {visibleTabs.map((tab) => (
            <button
              aria-controls={`security-panel-${tab}`}
              aria-disabled={
                Boolean(busyOperation) && selectedTab !== tab
              }
              aria-selected={selectedTab === tab}
              className={`min-h-10 whitespace-nowrap border-b-2 px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                selectedTab === tab
                  ? 'border-[var(--workbench-primary)] text-[var(--workbench-primary)]'
                  : 'border-transparent text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'
              }`}
              data-testid={`security-tab-${tab}`}
              disabled={Boolean(busyOperation) && selectedTab !== tab}
              id={`security-tab-${tab}`}
              key={tab}
              role="tab"
              tabIndex={selectedTab === tab ? 0 : -1}
              type="button"
              onClick={() => selectTab(tab)}
              onKeyDown={(event) => handleTabKeyDown(event, tab)}
            >
              {t(tabLabelKeys[tab])}
            </button>
          ))}
        </div>
      </div>

      {mutationErrorMessage ? (
        <div
          className="mx-5 mt-5 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
          role="alert"
        >
          <p className="text-sm font-semibold text-red-700">
            {mutationErrorMessage}
          </p>
          <button
            className="workbench-button-secondary min-h-9 px-3"
            type="button"
            onClick={() => void onRefresh?.()}
          >
            {t('security.action.refresh')}
          </button>
        </div>
      ) : null}

      <fieldset className="contents" disabled={isStale}>
        <div
          aria-labelledby={`security-tab-${selectedTab}`}
          className="grid gap-5 p-5"
          id={`security-panel-${selectedTab}`}
          role="tabpanel"
        >
          {selectedTab === 'overview' ? (
            <SecurityOverviewTab
              prerequisites={prerequisites}
              snapshot={snapshot}
              t={t}
              onSelectTab={(tab) => {
                pendingTabFocus.current = tab
                selectTab(tab)
              }}
            />
          ) : null}
          {selectedTab === 'identity' ? (
            <SecurityIdentityTab
              busyOperation={busyOperation}
              locale={locale}
              prerequisites={prerequisites}
              snapshot={snapshot}
              t={t}
              onCreateDomain={onCreateDomain}
              onRequestEnforcement={(enforced) =>
                requestConfirmation({ enforced, kind: 'sso-enforcement' })
              }
              onUpdateIdentityProvider={onUpdateIdentityProvider}
              onVerifyDomain={onVerifyDomain}
            />
          ) : null}
          {selectedTab === 'provisioning' ? (
            <SecurityProvisioningTab
              busyOperation={busyOperation}
              locale={locale}
              snapshot={snapshot}
              t={t}
              onPreview={onPreviewProvisioning}
              onRequestApply={(impact, onApplied) =>
                requestConfirmation({
                  impact,
                  kind: 'provisioning',
                  onApplied,
                })
              }
              onRequestRotateToken={(onRotated) =>
                requestConfirmation({
                  kind: 'scim-token-rotate',
                  onRotated,
                })
              }
              onRetryLog={onRetryProvisioningLog}
              onRotateToken={onRotateScimToken}
            />
          ) : null}
          {selectedTab === 'access' ? (
            <SecurityAccessTab
              busyOperation={busyOperation}
              key={createSecurityAccessBoundaryKey(snapshot, scopeOptions)}
              scopeOptions={scopeOptions}
              snapshot={snapshot}
              t={t}
              onCreateMapping={onCreateMapping}
              onCreateRole={onCreateRole}
              onDeleteMapping={
                onDeleteMapping
                  ? async (mapping) =>
                      requestConfirmation({
                        kind: 'mapping-delete',
                        mapping,
                      })
                  : undefined
              }
              onPreviewRoleImpact={onPreviewRoleImpact}
              onRequestDeleteRole={(role, impact) =>
                requestConfirmation({
                  impact,
                  kind: 'role-delete',
                  role,
                })
              }
              onRequestUpdateRole={(role, input, impact) =>
                requestConfirmation({
                  impact,
                  input,
                  kind: 'role-update',
                  role,
                })
              }
              onUpdateMapping={
                onUpdateMapping
                  ? async (mappingId, input) => {
                      const mapping = snapshot.mappings.find(
                        (candidate) => candidate.id === mappingId,
                      )
                      if (mapping) {
                        requestConfirmation({
                          input,
                          kind: 'mapping-update',
                          mapping,
                        })
                      }
                    }
                  : undefined
              }
              onUpdateRole={onUpdateRole}
            />
          ) : null}
          {selectedTab === 'sessions' ? (
            <SecuritySessionsTab
              busyOperation={busyOperation}
              key={`sessions:${snapshot.sessionPolicy.version}`}
              snapshot={snapshot}
              t={t}
              onPreview={onPreviewSessionPolicy}
              onRequestConfirmation={(input, impact) =>
                requestConfirmation({
                  impact,
                  input,
                  kind: 'session-policy',
                })
              }
              onUpdate={onUpdateSessionPolicy}
            />
          ) : null}
          {selectedTab === 'privileged' ? (
            <SecurityPrivilegedTab
              busyOperation={busyOperation}
              locale={locale}
              scopeOptions={scopeOptions}
              snapshot={snapshot}
              t={t}
              onCreateServiceAccount={onCreateServiceAccount}
              onRegisterBreakGlass={onRegisterBreakGlass}
              onRequestDeactivateBreakGlass={(administrator) =>
                requestConfirmation({
                  administrator,
                  kind: 'break-glass',
                })
              }
              onRequestRevokeServiceAccount={(account, onRevoked) =>
                requestConfirmation({
                  account,
                  kind: 'service-account-revoke',
                  onRevoked,
                })
              }
              onRequestRotateServiceAccount={(account, onRotated) =>
                requestConfirmation({
                  account,
                  kind: 'service-account-rotate',
                  onRotated,
                })
              }
              onTestBreakGlass={onTestBreakGlass}
            />
          ) : null}
        </div>
      </fieldset>

      {confirmation && !isStale ? (
        <EnterpriseSecurityConfirmationDialog
          confirmation={confirmation}
          errorMessage={mutationErrorMessage}
          isBusy={isConfirming}
          returnFocusRef={confirmationReturnFocusRef}
          t={t}
          onConfirm={confirmOperation}
          onRequestClose={() => {
            if (!isConfirming) {
              setConfirmation(undefined)
            }
          }}
        />
      ) : null}
    </section>
  )
}

/**
 * Renders the panel title and capability-derived administration mode.
 *
 * @param props - Snapshot and localized copy resolver.
 * @returns The enterprise security header.
 */
function EnterpriseSecurityHeader({
  snapshot,
  t,
}: {
  snapshot: EnterpriseSecuritySnapshot
  t: (key: MessageKey) => string
}) {
  const canManage = Object.entries(snapshot.capabilities).some(
    ([key, allowed]) => key.startsWith('canManage') && allowed,
  )

  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b border-[var(--workbench-border)] px-5 py-5">
      <div className="min-w-0 max-w-[760px]">
        <p className="workbench-eyebrow">{t('security.eyebrow')}</p>
        <h2 className="mt-2 text-xl font-semibold text-[var(--workbench-text)]">
          {t('security.title')}
        </h2>
        <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('security.description')}
        </p>
      </div>
      <span
        className={canManage ? 'workbench-badge-primary' : 'workbench-badge'}
      >
        {t(canManage ? 'security.mode.admin' : 'security.mode.readOnly')}
      </span>
    </div>
  )
}

/**
 * Renders the initial skeleton while the security snapshot is unavailable.
 *
 * @param props - Locale used for the accessible label.
 * @returns The panel loading state.
 */
function EnterpriseSecurityLoadingState({ locale }: { locale: Locale }) {
  const t = createTranslator(locale)

  return (
    <section
      aria-label={t('security.title')}
      className="workbench-panel overflow-hidden"
      data-testid="enterprise-security-loading"
      role="status"
    >
      <div className="grid gap-3 p-5">
        <div className="h-3 w-24 animate-pulse rounded bg-slate-200" />
        <div className="h-6 w-72 max-w-full animate-pulse rounded bg-slate-200" />
        <div className="h-4 w-full max-w-[680px] animate-pulse rounded bg-slate-100" />
      </div>
      <div className="grid grid-cols-3 gap-3 border-t border-[var(--workbench-border)] p-5 max-[760px]:grid-cols-1">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            className="h-28 animate-pulse rounded-lg bg-slate-100"
            key={index}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * Mirrors the selected security tab into the current browser URL.
 *
 * @param tab - Visible tab selected by the user.
 */
function updateSecurityTabQuery(tab: EnterpriseSecurityTab) {
  if (typeof window === 'undefined') {
    return
  }

  const url = new URL(window.location.href)
  url.searchParams.set('securityTab', tab)
  window.history.replaceState(window.history.state, '', url)
}
