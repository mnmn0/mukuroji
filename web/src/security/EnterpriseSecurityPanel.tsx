import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { createTranslator, type Locale, type MessageKey } from '../i18n'
import type {
  CreateEnterpriseDomainClaimInput,
  CreateEnterpriseGroupRoleMappingInput,
  CreateEnterpriseRoleInput,
  CreateEnterpriseServiceAccountInput,
  EnterpriseBreakGlassAdministrator,
  EnterpriseDomainVerificationChallenge,
  EnterpriseGroupRoleMapping,
  EnterpriseIdentityProvider,
  EnterpriseProvisioningImpact,
  EnterpriseProvisioningLog,
  EnterpriseRoleImpact,
  EnterpriseRoleDefinition,
  EnterpriseScimTokenResponse,
  EnterpriseSecuritySnapshot,
  EnterpriseSessionPolicyImpact,
  EnterpriseServiceAccount,
  EnterpriseServiceAccountCredentialResponse,
  EnterpriseSessionPolicy,
  PreviewEnterpriseRoleImpactInput,
  RegisterEnterpriseBreakGlassAdministratorInput,
  UpdateEnterpriseIdentityProviderInput,
  UpdateEnterpriseGroupRoleMappingInput,
  UpdateEnterpriseRoleInput,
  UpdateEnterpriseSessionPolicyInput,
  UpdateEnterpriseSsoEnforcementInput,
} from './api'
import {
  createEnterpriseSecurityStateBoundary,
  createSecurityAccessBoundaryKey,
  resolveServiceAccountAssignableRoleIds,
} from './capabilityBoundary'
import {
  enterpriseSecurityTabs,
  resolveEnterpriseSecurityTabTarget,
  type EnterpriseSecurityTab,
} from './tabs'

/**
 * Group mapping selector に表示する Workspace/Team/Project scope です。
 */
export type EnterpriseSecurityScopeOption = {
  /** Scope の種類です。 */
  type: 'workspace' | 'team' | 'project'
  /** Scope の一意な ID です。 */
  id: string
  /** Selector に表示する scope 名です。 */
  name: string
}

/**
 * EnterpriseSecurityPanel が受け取る表示状態と callback です。
 */
export type EnterpriseSecurityPanelProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Enterprise identity/security の管理 snapshot です。 */
  snapshot?: EnterpriseSecuritySnapshot
  /** 初回 snapshot を取得中かどうかです。 */
  isLoading?: boolean
  /** 初回 snapshot 取得失敗時の表示メッセージです。 */
  loadErrorMessage?: string
  /** 初回 snapshot 取得失敗時の primary action label です。 */
  loadErrorActionLabel?: string
  /** Revalidation failure により表示 snapshot が古い可能性があるかどうかです。 */
  isStale?: boolean
  /** Mutation 失敗時の表示メッセージです。 */
  mutationErrorMessage?: string
  /** 実行中 mutation を識別する operation key です。 */
  busyOperation?: string
  /** 最初に選択する管理 tab です。 */
  initialTab?: EnterpriseSecurityTab
  /** Group mapping の対象にできる scope 一覧です。 */
  scopeOptions: EnterpriseSecurityScopeOption[]
  /** Snapshot を再取得する callback です。 */
  onRefresh?: () => Promise<unknown> | unknown
  /** Load error 専用 action を再読み込み以外へ差し替える callback です。 */
  onLoadErrorAction?: () => Promise<unknown> | unknown
  /** Identity provider を保存し、任意で接続テストする callback です。 */
  onUpdateIdentityProvider?: (
    input: UpdateEnterpriseIdentityProviderInput & { testConnection?: boolean },
  ) => Promise<unknown>
  /** Managed domain の SSO enforcement を更新する callback です。 */
  onUpdateSsoEnforcement?: (
    input: UpdateEnterpriseSsoEnforcementInput,
  ) => Promise<unknown>
  /** Domain claim を作成する callback です。 */
  onCreateDomain?: (
    input: CreateEnterpriseDomainClaimInput,
  ) => Promise<EnterpriseDomainVerificationChallenge>
  /** Domain ownership を再確認する callback です。 */
  onVerifyDomain?: (domain: string, expectedVersion: number) => Promise<unknown>
  /** SCIM bearer token を発行または rotate する callback です。 */
  onRotateScimToken?: () => Promise<EnterpriseScimTokenResponse>
  /** Provisioning reconciliation の dry-run preview callback です。 */
  onPreviewProvisioning?: () => Promise<EnterpriseProvisioningImpact>
  /** 確認済み provisioning preview を適用する callback です。 */
  onApplyProvisioning?: (
    impact: EnterpriseProvisioningImpact,
  ) => Promise<unknown>
  /** Retry 可能な provisioning operation を再実行する callback です。 */
  onRetryProvisioningLog?: (
    log: EnterpriseProvisioningLog,
  ) => Promise<unknown>
  /** Directory group role mapping を作成する callback です。 */
  onCreateMapping?: (
    input: CreateEnterpriseGroupRoleMappingInput,
  ) => Promise<unknown>
  /** Directory group role mapping を削除する callback です。 */
  onDeleteMapping?: (
    mapping: EnterpriseGroupRoleMapping,
  ) => Promise<unknown>
  /** Directory group role mapping の scope または role を更新する callback です。 */
  onUpdateMapping?: (
    mappingId: string,
    input: UpdateEnterpriseGroupRoleMappingInput,
  ) => Promise<unknown>
  /** Custom role を作成する callback です。 */
  onCreateRole?: (input: CreateEnterpriseRoleInput) => Promise<unknown>
  /** Custom role permission set を更新する callback です。 */
  onUpdateRole?: (
    roleId: string,
    input: UpdateEnterpriseRoleInput,
  ) => Promise<unknown>
  /** 未使用の custom role を削除する callback です。 */
  onDeleteRole?: (
    role: EnterpriseRoleDefinition,
    impactConfirmationToken: string,
  ) => Promise<unknown>
  /** Custom role 更新・削除前の assignment impact callback です。 */
  onPreviewRoleImpact?: (
    role: EnterpriseRoleDefinition,
    input: PreviewEnterpriseRoleImpactInput,
  ) => Promise<EnterpriseRoleImpact>
  /** MFA、session、IP、guest policy を保存する callback です。 */
  onUpdateSessionPolicy?: (
    input: UpdateEnterpriseSessionPolicyInput,
  ) => Promise<unknown>
  /** Session/security policy 保存前に caller IP impact を確認する callback です。 */
  onPreviewSessionPolicy?: (
    input: UpdateEnterpriseSessionPolicyInput,
  ) => Promise<EnterpriseSessionPolicyImpact>
  /** Service account と一回限り credential を作成する callback です。 */
  onCreateServiceAccount?: (
    input: CreateEnterpriseServiceAccountInput,
  ) => Promise<EnterpriseServiceAccountCredentialResponse>
  /** Service account credential を rotate する callback です。 */
  onRotateServiceAccount?: (
    account: EnterpriseServiceAccount,
  ) => Promise<EnterpriseServiceAccountCredentialResponse>
  /** Service account を revoke する callback です。 */
  onRevokeServiceAccount?: (
    account: EnterpriseServiceAccount,
  ) => Promise<unknown>
  /** Break-glass administrator account を事前登録する callback です。 */
  onRegisterBreakGlass?: (
    input: RegisterEnterpriseBreakGlassAdministratorInput,
  ) => Promise<unknown>
  /** 現在の break-glass session から recovery access test を記録する callback です。 */
  onTestBreakGlass?: () => Promise<unknown>
  /** Break-glass administrator を無効化する callback です。 */
  onDeactivateBreakGlass?: (
    administrator: EnterpriseBreakGlassAdministrator,
  ) => Promise<unknown>
}

/**
 * 一回限り表示する SCIM/service account secret です。
 */
type OneTimeSecret = {
  /** React state 上で token 自体を識別子に使わないための表示世代です。 */
  displayId: number
  /** Secret の種類です。 */
  kind: 'scim' | 'service-account'
  /** Secret を識別する管理者向け名称です。 */
  label: string
  /** 一回だけ表示する bearer token です。 */
  token: string
}

/**
 * 確認 dialog から実行する高影響 operation です。
 */
type EnterpriseSecurityConfirmation =
  | {
      /** SSO enforcement 更新を表す discriminant です。 */
      kind: 'sso-enforcement'
      /** 更新後の enforcement 状態です。 */
      enforced: boolean
    }
  | {
      /** Provisioning apply を表す discriminant です。 */
      kind: 'provisioning'
      /** 適用する dry-run preview です。 */
      impact: EnterpriseProvisioningImpact
    }
  | {
      /** Caller IP 除外を伴う session policy 更新を表す discriminant です。 */
      kind: 'session-policy'
      /** 保存する session/security policy です。 */
      input: UpdateEnterpriseSessionPolicyInput
      /** Server が preview した caller IP impact です。 */
      impact: EnterpriseSessionPolicyImpact
    }
  | {
      /** SCIM credential rotate を表す discriminant です。 */
      kind: 'scim-token-rotate'
    }
  | {
      /** Service account credential rotate を表す discriminant です。 */
      kind: 'service-account-rotate'
      /** Credential を rotate する service account です。 */
      account: EnterpriseServiceAccount
    }
  | {
      /** Service account revoke を表す discriminant です。 */
      kind: 'service-account-revoke'
      /** Revoke する service account です。 */
      account: EnterpriseServiceAccount
    }
  | {
      /** Directory group mapping 削除を表す discriminant です。 */
      kind: 'mapping-delete'
      /** 削除する directory group mapping です。 */
      mapping: EnterpriseGroupRoleMapping
    }
  | {
      /** Directory group mapping 更新を表す discriminant です。 */
      kind: 'mapping-update'
      /** 更新する directory group mapping です。 */
      mapping: EnterpriseGroupRoleMapping
      /** 確認後に送る更新入力です。 */
      input: UpdateEnterpriseGroupRoleMappingInput
    }
  | {
      /** Break-glass administrator disable を表す discriminant です。 */
      kind: 'break-glass'
      /** 無効化する break-glass administrator です。 */
      administrator: EnterpriseBreakGlassAdministrator
    }
  | {
      /** Custom role 削除を表す discriminant です。 */
      kind: 'role-delete'
      /** 削除する custom role です。 */
      role: EnterpriseRoleDefinition
      /** 削除が assignment と mapping に与える影響です。 */
      impact: EnterpriseRoleImpact
    }
  | {
      /** Custom role permission 更新を表す discriminant です。 */
      kind: 'role-update'
      /** 更新する custom role です。 */
      role: EnterpriseRoleDefinition
      /** 確認後に送る更新入力です。 */
      input: UpdateEnterpriseRoleInput
      /** Permission 削除が assignment と mapping に与える影響です。 */
      impact: EnterpriseRoleImpact
    }

const tabLabelKeys: Record<EnterpriseSecurityTab, MessageKey> = {
  overview: 'security.tab.overview',
  identity: 'security.tab.identity',
  provisioning: 'security.tab.provisioning',
  access: 'security.tab.access',
  sessions: 'security.tab.sessions',
  privileged: 'security.tab.privileged',
}

function resolveVisibleEnterpriseSecurityTabs(
  capabilities: EnterpriseSecuritySnapshot['capabilities'] | undefined,
) {
  if (!capabilities) {
    return ['overview'] satisfies EnterpriseSecurityTab[]
  }

  return enterpriseSecurityTabs.filter((tab) => {
    if (tab === 'overview') {
      return true
    }

    if (tab === 'identity') {
      return capabilities.canViewIdentity
    }

    if (tab === 'provisioning') {
      return capabilities.canViewProvisioning
    }

    if (tab === 'access') {
      return capabilities.canViewAccess
    }

    if (tab === 'sessions') {
      return capabilities.canViewSessions
    }

    return capabilities.canViewPrivileged
  })
}

function resolveVisibleEnterpriseSecurityTab(
  requestedTab: EnterpriseSecurityTab,
  capabilities: EnterpriseSecuritySnapshot['capabilities'] | undefined,
) {
  const visibleTabs = resolveVisibleEnterpriseSecurityTabs(capabilities)

  return visibleTabs.includes(requestedTab) ? requestedTab : 'overview'
}

/**
 * Enterprise identity、provisioning、access、session policy を管理する tabbed panel です。
 */
export function EnterpriseSecurityPanel(
  props: EnterpriseSecurityPanelProps,
) {
  const stateBoundary = createEnterpriseSecurityStateBoundary(
    props.snapshot?.capabilities,
    Boolean(props.isStale),
  )

  return (
    <EnterpriseSecurityPanelContent
      key={stateBoundary}
      {...props}
    />
  )
}

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
    resolveVisibleEnterpriseSecurityTab(
      initialTab,
      snapshot?.capabilities,
    ),
  )
  const [oneTimeSecret, setOneTimeSecret] = useState<OneTimeSecret>()
  const [domainChallenge, setDomainChallenge] =
    useState<EnterpriseDomainVerificationChallenge>()
  const [provisioningImpact, setProvisioningImpact] =
    useState<EnterpriseProvisioningImpact>()
  const [confirmation, setConfirmation] =
    useState<EnterpriseSecurityConfirmation>()
  const [isConfirming, setIsConfirming] = useState(false)
  const pendingTabFocus = useRef<EnterpriseSecurityTab | undefined>(undefined)
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null)
  const oneTimeSecretDisplayIdRef = useRef(0)

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
  const prerequisites = resolveSsoPrerequisites(snapshot)
  const visibleOneTimeSecret =
    (oneTimeSecret?.kind === 'scim' &&
      snapshot.capabilities.canManageProvisioning) ||
    (oneTimeSecret?.kind === 'service-account' &&
      snapshot.capabilities.canManagePrivilegedAccess)
      ? oneTimeSecret
      : undefined
  const visibleDomainChallenge =
    snapshot.capabilities.canManageIdentity ? domainChallenge : undefined
  const rotateScimToken = async () => {
    const response = await onRotateScimToken?.()
    if (response) {
      oneTimeSecretDisplayIdRef.current += 1
      setOneTimeSecret({
        displayId: oneTimeSecretDisplayIdRef.current,
        kind: 'scim',
        label: t('security.provisioning.scimTokenLabel'),
        token: response.token,
      })
    }
  }
  const rotateServiceAccount = async (
    account: EnterpriseServiceAccount,
  ) => {
    const response = await onRotateServiceAccount?.(account)
    if (response) {
      oneTimeSecretDisplayIdRef.current += 1
      setOneTimeSecret({
        displayId: oneTimeSecretDisplayIdRef.current,
        kind: 'service-account',
        label: response.serviceAccount.name,
        token: response.token,
      })
    }
  }
  const requestConfirmation = (next: EnterpriseSecurityConfirmation) => {
    confirmationReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setConfirmation(next)
  }
  const selectTab = (tab: EnterpriseSecurityTab) => {
    setSelectedTab(tab)
    updateSecurityTabQuery(tab)
  }
  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    tab: EnterpriseSecurityTab,
  ) => {
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
        setProvisioningImpact(undefined)
      } else if (confirmation.kind === 'session-policy') {
        await onUpdateSessionPolicy?.({
          ...confirmation.input,
          callerIpConfirmationToken:
            confirmation.impact.confirmationToken,
        })
      } else if (confirmation.kind === 'scim-token-rotate') {
        await rotateScimToken()
      } else if (confirmation.kind === 'service-account-rotate') {
        await rotateServiceAccount(confirmation.account)
      } else if (confirmation.kind === 'service-account-revoke') {
        await onRevokeServiceAccount?.(confirmation.account)
        if (
          oneTimeSecret?.kind === 'service-account' &&
          oneTimeSecret.label === confirmation.account.name
        ) {
          setOneTimeSecret(undefined)
        }
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
          impactConfirmationToken:
            confirmation.impact.confirmationToken,
        })
      } else if (confirmation.kind === 'role-delete') {
        await onDeleteRole?.(
          confirmation.role,
          confirmation.impact.confirmationToken ?? '',
        )
      }

      setConfirmation(undefined)
    } catch {
      // Container の共有 error banner を表示し、同じ dialog から retry できるよう維持します。
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
              aria-selected={selectedTab === tab}
              className={`min-h-10 whitespace-nowrap border-b-2 px-4 text-sm font-semibold transition-colors ${
                selectedTab === tab
                  ? 'border-[var(--workbench-primary)] text-[var(--workbench-primary)]'
                  : 'border-transparent text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'
              }`}
              data-testid={`security-tab-${tab}`}
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

      {visibleOneTimeSecret ? (
        <div className="px-5 pt-5">
          <EnterpriseOneTimeSecretNotice
            key={visibleOneTimeSecret.displayId}
            kind={visibleOneTimeSecret.kind}
            label={visibleOneTimeSecret.label}
            locale={locale}
            token={visibleOneTimeSecret.token}
            onDismiss={() => setOneTimeSecret(undefined)}
          />
        </div>
      ) : null}

      {visibleDomainChallenge ? (
        <div className="px-5 pt-5">
          <EnterpriseDomainVerificationChallengeNotice
            challenge={visibleDomainChallenge}
            locale={locale}
            onDismiss={() => setDomainChallenge(undefined)}
          />
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
            key={`identity:${snapshot.identityProvider.version}`}
            locale={locale}
            prerequisites={prerequisites}
            snapshot={snapshot}
            t={t}
            onCreateDomain={
              onCreateDomain
                ? async (input) => {
                    const challenge = await onCreateDomain(input)
                    setDomainChallenge(challenge)
                    return challenge
                  }
                : undefined
            }
            onRequestEnforcement={(enforced) =>
              requestConfirmation({ enforced, kind: 'sso-enforcement' })
            }
            onUpdateIdentityProvider={onUpdateIdentityProvider}
            onVerifyDomain={
              onVerifyDomain
                ? async (domain, expectedVersion) => {
                    const result = await onVerifyDomain(
                      domain,
                      expectedVersion,
                    )
                    setDomainChallenge((current) =>
                      current?.domain.domain === domain ? undefined : current,
                    )
                    return result
                  }
                : undefined
            }
          />
        ) : null}
        {selectedTab === 'provisioning' ? (
          <SecurityProvisioningTab
            busyOperation={busyOperation}
            impact={provisioningImpact}
            key={`provisioning:${provisioningImpact?.previewId ?? 'none'}`}
            locale={locale}
            snapshot={snapshot}
            t={t}
            onPreview={async () => {
              setProvisioningImpact(undefined)
              const impact = await onPreviewProvisioning?.()
              if (impact) {
                setProvisioningImpact(impact)
              }
            }}
            onRequestApply={(impact) =>
              requestConfirmation({ impact, kind: 'provisioning' })
            }
            onRetryLog={onRetryProvisioningLog}
            onRotateToken={
              snapshot.scim.tokenGeneration > 0
                ? async () =>
                    requestConfirmation({ kind: 'scim-token-rotate' })
                : rotateScimToken
            }
          />
        ) : null}
        {selectedTab === 'access' ? (
          <SecurityAccessTab
            busyOperation={busyOperation}
            key={createSecurityAccessBoundaryKey(
              snapshot,
              scopeOptions,
            )}
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
            key={`privileged:${snapshot.roles
              .map((role) => `${role.id}:${role.version}`)
              .join(',')}:${scopeOptions
              .map((scope) => `${scope.type}:${scope.id}`)
              .join(',')}`}
            locale={locale}
            scopeOptions={scopeOptions}
            snapshot={snapshot}
            t={t}
            onRegisterBreakGlass={onRegisterBreakGlass}
            onTestBreakGlass={onTestBreakGlass}
            onCreateServiceAccount={async (input) => {
              const response = await onCreateServiceAccount?.(input)
              if (response) {
                oneTimeSecretDisplayIdRef.current += 1
                setOneTimeSecret({
                  displayId: oneTimeSecretDisplayIdRef.current,
                  kind: 'service-account',
                  label: response.serviceAccount.name,
                  token: response.token,
                })
              }
            }}
            onRequestDeactivateBreakGlass={(administrator) =>
              requestConfirmation({
                administrator,
                kind: 'break-glass',
              })
            }
            onRequestRevokeServiceAccount={(account) =>
              requestConfirmation({
                account,
                kind: 'service-account-revoke',
              })
            }
            onRotateServiceAccount={
              onRotateServiceAccount
                ? async (account) =>
                    requestConfirmation({
                      account,
                      kind: 'service-account-rotate',
                    })
                : undefined
            }
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
      <span className={canManage ? 'workbench-badge-primary' : 'workbench-badge'}>
        {t(canManage ? 'security.mode.admin' : 'security.mode.readOnly')}
      </span>
    </div>
  )
}

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
 * SSO enforcement を安全に有効化する prerequisite の状態です。
 */
type SsoPrerequisites = {
  /** Identity provider の接続テストが成功済みかどうかです。 */
  identityProviderVerified: boolean
  /** Verified domain が1件以上あるかどうかです。 */
  verifiedDomain: boolean
  /** MFA 済みの active break-glass login 経路が存在するかどうかです。 */
  breakGlassReady: boolean
  /** すべての prerequisite が成立しているかどうかです。 */
  complete: boolean
}

function SecurityOverviewTab({
  prerequisites,
  snapshot,
  t,
  onSelectTab,
}: {
  prerequisites: SsoPrerequisites
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
  const navigationCards = (
    [
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
    ] as const satisfies readonly [
      EnterpriseSecurityTab,
      MessageKey,
      MessageKey,
      boolean,
    ][]
  ).filter(([, , , canView]) => canView)

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
              <p className="workbench-eyebrow">{t('security.overview.readinessEyebrow')}</p>
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
          <SsoPrerequisiteList prerequisites={prerequisites} t={t} />
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

function SsoPrerequisiteList({
  prerequisites,
  t,
}: {
  prerequisites: SsoPrerequisites
  t: (key: MessageKey) => string
}) {
  const items = [
    [
      prerequisites.identityProviderVerified,
      'security.prerequisite.identity',
    ],
    [prerequisites.verifiedDomain, 'security.prerequisite.domain'],
    [prerequisites.breakGlassReady, 'security.prerequisite.breakGlass'],
  ] as const satisfies readonly [boolean, MessageKey][]

  return (
    <ul className="mt-4 grid gap-2">
      {items.map(([complete, labelKey]) => (
        <li
          className="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-3"
          key={labelKey}
        >
          <span
            aria-hidden="true"
            className={`grid h-6 w-6 flex-none place-items-center rounded-full text-xs font-bold ${
              complete
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {complete ? '✓' : '!'}
          </span>
          <span className="text-sm font-semibold text-[var(--workbench-text)]">
            {t(labelKey)}
          </span>
          <span className="ml-auto text-xs font-semibold text-[var(--workbench-muted)]">
            {t(
              complete
                ? 'security.prerequisite.complete'
                : 'security.prerequisite.incomplete',
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function SecurityIdentityTab({
  busyOperation,
  locale,
  prerequisites,
  snapshot,
  t,
  onCreateDomain,
  onRequestEnforcement,
  onUpdateIdentityProvider,
  onVerifyDomain,
}: {
  busyOperation?: string
  locale: Locale
  prerequisites: SsoPrerequisites
  snapshot: EnterpriseSecuritySnapshot
  t: (key: MessageKey) => string
  onCreateDomain?: (
    input: CreateEnterpriseDomainClaimInput,
  ) => Promise<EnterpriseDomainVerificationChallenge>
  onRequestEnforcement: (enforced: boolean) => void
  onUpdateIdentityProvider?: (
    input: UpdateEnterpriseIdentityProviderInput & { testConnection?: boolean },
  ) => Promise<unknown>
  onVerifyDomain?: (domain: string, expectedVersion: number) => Promise<unknown>
}) {
  const canManage = snapshot.capabilities.canManageIdentity
  const [draft, setDraft] = useState(() =>
    cloneIdentityProvider(snapshot.identityProvider),
  )
  const [domain, setDomain] = useState('')
  const isBusy = Boolean(busyOperation)

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
          draft.protocol === 'saml'
            ? (draft.metadataUrl ?? '').trim()
            : '',
        protocol: draft.protocol,
        ssoUrl: draft.ssoUrl.trim(),
        testConnection: true,
      })
    } catch {
      // Container の共有 error banner に委譲します。
    }
  }

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
      // Container の共有 error banner に委譲します。
    }
  }

  return (
    <div className="grid gap-5" data-testid="security-identity">
      {!canManage ? <ReadOnlyNotice t={t} /> : null}

      <form
        className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white"
        data-testid="security-identity-provider-form"
        onSubmit={(event) => void handleProviderSubmit(event)}
      >
        <PanelSectionHeader
          badge={t(`security.identity.status.${snapshot.identityProvider.status}`)}
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
              formatSecurityDate(
                snapshot.identityProvider.lastTestedAt,
                locale,
              ),
            )}
          </p>
        ) : null}
      </form>

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <PanelSectionHeader
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
              data-testid={`security-domain-${createSecurityTestId(claim.domain)}`}
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
              <SecurityStatusBadge
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
                  onClick={() =>
                    void onVerifyDomain?.(claim.domain, claim.version).catch(() => undefined)
                  }
                >
                  {t('security.identity.verifyDomain')}
                </button>
              ) : null}
            </article>
          ))}
          {snapshot.domains.length === 0 ? (
            <EmptyState text={t('security.identity.domainsEmpty')} />
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[#99d7cf] bg-[#f3fbfa]">
        <PanelSectionHeader
          badge={t(
            snapshot.identityProvider.enforced
              ? 'security.overview.enforced'
              : 'security.overview.notEnforced',
          )}
          description={t('security.identity.enforcementDescription')}
          title={t('security.identity.enforcementTitle')}
        />
        <div className="border-t border-[#b8e2dc] p-5">
          <SsoPrerequisiteList prerequisites={prerequisites} t={t} />
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
                  (!snapshot.identityProvider.enforced && !prerequisites.complete)
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
    </div>
  )
}

function SecurityProvisioningTab({
  busyOperation,
  impact,
  locale,
  snapshot,
  t,
  onPreview,
  onRequestApply,
  onRetryLog,
  onRotateToken,
}: {
  busyOperation?: string
  impact?: EnterpriseProvisioningImpact
  locale: Locale
  snapshot: EnterpriseSecuritySnapshot
  t: (key: MessageKey) => string
  onPreview: () => Promise<void>
  onRequestApply: (impact: EnterpriseProvisioningImpact) => void
  onRetryLog?: (log: EnterpriseProvisioningLog) => Promise<unknown>
  onRotateToken: () => Promise<void>
}) {
  const canManage = snapshot.capabilities.canManageProvisioning
  const isBusy = Boolean(busyOperation)
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const impactExpiresAt = impact ? Date.parse(impact.expiresAt) : Number.NaN
  const impactExpiryDelay = Number.isFinite(impactExpiresAt)
    ? Math.max(0, impactExpiresAt - currentTime)
    : 0
  const impactIsExpired = Boolean(
    impact &&
      (!Number.isFinite(impactExpiresAt) || impactExpiryDelay === 0),
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

  return (
    <div className="grid gap-5" data-testid="security-provisioning">
      {!canManage ? <ReadOnlyNotice t={t} /> : null}

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <PanelSectionHeader
          badge={t(`security.scim.status.${snapshot.scim.status}`)}
          description={t('security.provisioning.scimDescription')}
          title={t('security.provisioning.scimTitle')}
        />
        <dl className="grid grid-cols-3 gap-4 border-t border-[var(--workbench-border)] p-5 max-[820px]:grid-cols-1">
          <SecurityDefinition
            label={t('security.provisioning.endpoint')}
            value={snapshot.scim.endpointUrl || t('security.value.notConfigured')}
            code
          />
          <SecurityDefinition
            label={t('security.provisioning.tokenGeneration')}
            value={t('security.provisioning.generation')
              .replace('{generation}', String(snapshot.scim.tokenGeneration))
              .replace(
                '{lastFour}',
                snapshot.scim.tokenLastFour ?? t('security.value.none'),
              )}
          />
          <SecurityDefinition
            label={t('security.provisioning.lastSync')}
            value={
              snapshot.scim.lastSyncAt
                ? formatSecurityDate(snapshot.scim.lastSyncAt, locale)
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
              onClick={() => void onRotateToken().catch(() => undefined)}
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
        <PanelSectionHeader
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
                onClick={() => void onPreview().catch(() => undefined)}
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
                  onRequestApply(impact)
                }
              }}
            />
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <PanelSectionHeader
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
              data-testid={`security-provisioning-log-${createSecurityTestId(log.id)}`}
              key={log.id}
            >
              <div className="grid gap-2">
                <SecurityStatusBadge
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
                <p>{formatSecurityDate(log.createdAt, locale)}</p>
                <p>
                  {t('security.provisioning.attempts').replace(
                    '{count}',
                    String(log.attempts),
                  )}
                </p>
              </div>
              {canManage && log.retryable ? (
                <button
                  aria-label={`${t('security.provisioning.retry')}: ${t(`security.provisioning.operation.${log.operation}`)} · ${formatSecurityDate(log.createdAt, locale)}`}
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
            <EmptyState text={t('security.provisioning.logsEmpty')} />
          ) : null}
        </div>
      </section>
    </div>
  )
}

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
  const countItems = [
    ['usersCreated', 'security.provisioning.impact.usersCreated'],
    ['usersUpdated', 'security.provisioning.impact.usersUpdated'],
    ['usersDeactivated', 'security.provisioning.impact.usersDeactivated'],
    ['groupsCreated', 'security.provisioning.impact.groupsCreated'],
    ['groupsUpdated', 'security.provisioning.impact.groupsUpdated'],
    ['sessionsRevoked', 'security.provisioning.impact.sessionsRevoked'],
  ] as const satisfies readonly [
    keyof EnterpriseProvisioningImpact['counts'],
    MessageKey,
  ][]

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
              formatSecurityDate(impact.expiresAt, locale),
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
            impact.hasChanges ? 'workbench-badge-warning' : 'workbench-badge-success'
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

function SecurityAccessTab({
  busyOperation,
  scopeOptions,
  snapshot,
  t,
  onCreateMapping,
  onCreateRole,
  onDeleteMapping,
  onPreviewRoleImpact,
  onRequestDeleteRole,
  onRequestUpdateRole,
  onUpdateMapping,
  onUpdateRole,
}: {
  busyOperation?: string
  scopeOptions: EnterpriseSecurityScopeOption[]
  snapshot: EnterpriseSecuritySnapshot
  t: (key: MessageKey) => string
  onCreateMapping?: (
    input: CreateEnterpriseGroupRoleMappingInput,
  ) => Promise<unknown>
  onCreateRole?: (input: CreateEnterpriseRoleInput) => Promise<unknown>
  onDeleteMapping?: (
    mapping: EnterpriseGroupRoleMapping,
  ) => Promise<unknown>
  onPreviewRoleImpact?: (
    role: EnterpriseRoleDefinition,
    input: PreviewEnterpriseRoleImpactInput,
  ) => Promise<EnterpriseRoleImpact>
  onRequestDeleteRole: (
    role: EnterpriseRoleDefinition,
    impact: EnterpriseRoleImpact,
  ) => void
  onRequestUpdateRole: (
    role: EnterpriseRoleDefinition,
    input: UpdateEnterpriseRoleInput,
    impact: EnterpriseRoleImpact,
  ) => void
  onUpdateMapping?: (
    mappingId: string,
    input: UpdateEnterpriseGroupRoleMappingInput,
  ) => Promise<unknown>
  onUpdateRole?: (
    roleId: string,
    input: UpdateEnterpriseRoleInput,
  ) => Promise<unknown>
}) {
  const canManageMappings = snapshot.capabilities.canManageMappings
  const canManageRoles = snapshot.capabilities.canManageRoles
  const assignablePermissionIds = new Set(snapshot.assignablePermissionIds)
  const isBusy = Boolean(busyOperation)
  const defaultScope = scopeOptions[0]
  const [directoryGroupId, setDirectoryGroupId] = useState('')
  const [directoryGroupName, setDirectoryGroupName] = useState('')
  const [scopeValue, setScopeValue] = useState(
    defaultScope ? createScopeOptionValue(defaultScope) : '',
  )
  const [mappingRoleId, setMappingRoleId] = useState('')
  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleDescription, setNewRoleDescription] = useState('')
  const [newRolePermissionIds, setNewRolePermissionIds] = useState<string[]>(
    [],
  )
  const [newRoleGuestAssignable, setNewRoleGuestAssignable] = useState(false)
  const [mappingDrafts, setMappingDrafts] = useState(() =>
    createMappingDrafts(snapshot.mappings, scopeOptions),
  )
  const [roleDrafts, setRoleDrafts] = useState<
    Record<string, readonly string[]>
  >(() => createRolePermissionDrafts(snapshot.roles))
  const [roleGuestAssignableDrafts, setRoleGuestAssignableDrafts] = useState<
    Record<string, boolean>
  >(() => createRoleGuestAssignableDrafts(snapshot.roles))
  const [roleImpactMessage, setRoleImpactMessage] = useState<string>()
  const selectedScopeValue = scopeOptions.some(
    (scope) => createScopeOptionValue(scope) === scopeValue,
  )
    ? scopeValue
    : defaultScope
      ? createScopeOptionValue(defaultScope)
      : ''
  const selectedScope = scopeOptions.find(
    (scope) => createScopeOptionValue(scope) === selectedScopeValue,
  )
  const availableMappingRoles = selectedScope
    ? resolveAssignableMappingRoles(snapshot, selectedScope.type)
    : []
  const selectedMappingRoleId = availableMappingRoles.some(
    (role) => role.id === mappingRoleId,
  )
    ? mappingRoleId
    : ''

  const handleMappingSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (
      !canManageMappings ||
      !selectedScope ||
      !selectedMappingRoleId ||
      !snapshot.scim.identityProviderId ||
      !directoryGroupId.trim() ||
      !directoryGroupName.trim() ||
      !onCreateMapping
    ) {
      return
    }

    try {
      await onCreateMapping({
        directoryGroupId: directoryGroupId.trim(),
        directoryGroupName: directoryGroupName.trim(),
        identityProviderId: snapshot.scim.identityProviderId,
        roleId: selectedMappingRoleId,
        scopeId: selectedScope.id,
        scopeName: selectedScope.name,
        scopeType: selectedScope.type,
      })
      setDirectoryGroupId('')
      setDirectoryGroupName('')
      setMappingRoleId('')
    } catch {
      // Container の共有 error banner に委譲します。
    }
  }

  const handleCreateRole = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (
      !canManageRoles ||
      !newRoleName.trim() ||
      newRolePermissionIds.length === 0 ||
      newRolePermissionIds.some(
        (permissionId) => !assignablePermissionIds.has(permissionId),
      ) ||
      !onCreateRole ||
      isBusy
    ) {
      return
    }

    try {
      await onCreateRole({
        description: newRoleDescription.trim(),
        guestAssignable: newRoleGuestAssignable,
        name: newRoleName.trim(),
        permissionIds: newRolePermissionIds,
      })
      setNewRoleName('')
      setNewRoleDescription('')
      setNewRolePermissionIds([])
      setNewRoleGuestAssignable(false)
    } catch {
      // Container の共有 error banner に委譲します。
    }
  }

  const handleUpdateMapping = async (mapping: EnterpriseGroupRoleMapping) => {
    const draft = mappingDrafts[mapping.id]
    const selectedScope = scopeOptions.find(
      (scope) => createScopeOptionValue(scope) === draft?.scopeValue,
    )

    if (!draft || !selectedScope || !draft.roleId || !onUpdateMapping) {
      return
    }

    try {
      await onUpdateMapping(mapping.id, {
        directoryGroupId: mapping.directoryGroupId,
        directoryGroupName: mapping.directoryGroupName,
        expectedVersion: mapping.version,
        identityProviderId: mapping.identityProviderId,
        roleId: draft.roleId,
        scopeId: selectedScope.id,
        scopeName: selectedScope.name,
        scopeType: selectedScope.type,
      })
    } catch {
      // Container の共有 error banner に委譲します。
    }
  }

  const handleUpdateRole = async (role: EnterpriseRoleDefinition) => {
    const permissionIds = [...(roleDrafts[role.id] ?? [])]
    const guestAssignable =
      roleGuestAssignableDrafts[role.id] ?? role.guestAssignable
    if (
      permissionIds.length === 0 ||
      permissionIds.some(
        (permissionId) => !assignablePermissionIds.has(permissionId),
      ) ||
      !onPreviewRoleImpact ||
      !onUpdateRole
    ) {
      return
    }

    const input = {
      description: role.description,
      expectedVersion: role.version,
      guestAssignable,
      name: role.name,
      permissionIds,
    } satisfies UpdateEnterpriseRoleInput

    try {
      const impact = await onPreviewRoleImpact(role, {
        expectedVersion: role.version,
        guestAssignable,
        permissionIds,
      })
      if (impact.blocking) {
        setRoleImpactMessage(formatRoleImpactBlockedMessage(impact, t))
        return
      }

      setRoleImpactMessage(undefined)
      if (
        guestAssignable !== role.guestAssignable ||
        (impact.removedPermissionIds.length > 0 &&
          (impact.assignmentCount > 0 ||
            impact.mappingCount > 0 ||
            impact.serviceAccountCount > 0))
      ) {
        onRequestUpdateRole(role, input, impact)
        return
      }

      await onUpdateRole(role.id, {
        ...input,
        impactConfirmationToken: impact.confirmationToken,
      })
    } catch {
      // Container の共有 error banner に委譲します。
    }
  }

  const handleDeleteRole = async (role: EnterpriseRoleDefinition) => {
    if (!onPreviewRoleImpact) {
      return
    }

    try {
      const impact = await onPreviewRoleImpact(role, {
        delete: true,
        expectedVersion: role.version,
      })
      if (impact.blocking) {
        setRoleImpactMessage(formatRoleImpactBlockedMessage(impact, t))
        return
      }

      setRoleImpactMessage(undefined)
      onRequestDeleteRole(role, impact)
    } catch {
      // Container の共有 error banner に委譲します。
    }
  }

  return (
    <div className="grid gap-5" data-testid="security-access">
      {!canManageMappings && !canManageRoles ? (
        <ReadOnlyNotice t={t} />
      ) : null}

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <PanelSectionHeader
          description={t('security.access.mappingsDescription')}
          title={t('security.access.mappingsTitle')}
        />
        {canManageMappings ? (
          <form
            className="grid grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_minmax(200px,1fr)_minmax(180px,0.8fr)_auto] items-end gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4 max-[1240px]:grid-cols-2 max-[640px]:grid-cols-1"
            data-testid="security-mapping-form"
            onSubmit={(event) => void handleMappingSubmit(event)}
          >
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.directoryGroupName')}
              <input
                className="workbench-input min-h-10 px-3"
                disabled={isBusy}
                required
                value={directoryGroupName}
                onChange={(event) => setDirectoryGroupName(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.directoryGroupId')}
              <input
                className="workbench-input min-h-10 px-3"
                disabled={isBusy}
                required
                value={directoryGroupId}
                onChange={(event) => setDirectoryGroupId(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.scope')}
              <select
                className="workbench-input min-h-10 px-3"
                disabled={isBusy || scopeOptions.length === 0}
                required
                value={selectedScopeValue}
                onChange={(event) => {
                  setScopeValue(event.target.value)
                  setMappingRoleId('')
                }}
              >
                {scopeOptions.map((scope) => (
                  <option key={createScopeOptionValue(scope)} value={createScopeOptionValue(scope)}>
                    {t(`security.scope.${scope.type}`)} · {scope.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.role')}
              <select
                className="workbench-input min-h-10 px-3"
                disabled={isBusy || availableMappingRoles.length === 0}
                required
                value={selectedMappingRoleId}
                onChange={(event) => setMappingRoleId(event.target.value)}
              >
                <option disabled value="">
                  {t('security.access.selectRole')}
                </option>
                {availableMappingRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {formatSecurityRoleName(role, t)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55"
              disabled={
                isBusy ||
                scopeOptions.length === 0 ||
                !directoryGroupId.trim() ||
                !directoryGroupName.trim() ||
                !snapshot.scim.identityProviderId ||
                !selectedMappingRoleId
              }
              type="submit"
            >
              {t('security.access.addMapping')}
            </button>
          </form>
        ) : null}
        <div className="overflow-x-auto border-t border-[var(--workbench-border)]">
          <table
            className="w-full min-w-[820px] border-collapse text-left"
            data-testid="security-mapping-table"
          >
            <thead>
              <tr className="workbench-table-head">
                <th className="px-4 py-3" scope="col">
                  {t('security.access.column.group')}
                </th>
                <th className="px-4 py-3" scope="col">
                  {t('security.access.column.scope')}
                </th>
                <th className="px-4 py-3" scope="col">
                  {t('security.access.column.role')}
                </th>
                <th className="px-4 py-3 text-right" scope="col">
                  {t('security.access.column.action')}
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshot.mappings.map((mapping) => {
                const role = snapshot.roles.find(
                  (candidate) => candidate.id === mapping.roleId,
                )
                const mappingDraft = mappingDrafts[mapping.id]
                const selectedMappingScope = scopeOptions.find(
                  (scope) =>
                    createScopeOptionValue(scope) === mappingDraft?.scopeValue,
                )
                const availableRolesForMapping = selectedMappingScope
                  ? resolveAssignableMappingRoles(
                      snapshot,
                      selectedMappingScope.type,
                    )
                  : []
                const selectedRole = availableRolesForMapping.find(
                  (candidate) => candidate.id === mappingDraft?.roleId,
                )
                const currentDraftRole = snapshot.roles.find(
                  (candidate) => candidate.id === mappingDraft?.roleId,
                )

                return (
                  <tr
                    className="border-t border-[var(--workbench-border)]"
                    data-testid={`security-mapping-${createSecurityTestId(mapping.id)}`}
                    key={mapping.id}
                  >
                    <th className="px-4 py-4 text-left" scope="row">
                      <p className="font-semibold text-[var(--workbench-text)]">
                        {mapping.directoryGroupName}
                      </p>
                      <code className="mt-1 block text-xs text-[var(--workbench-muted)]">
                        {mapping.directoryGroupId}
                      </code>
                    </th>
                    <td className="px-4 py-4">
                      {canManageMappings ? (
                        <select
                          aria-label={`${mapping.directoryGroupName}: ${t('security.access.scope')}`}
                          className="workbench-input min-h-9 w-full px-2 text-sm"
                          disabled={isBusy || scopeOptions.length === 0}
                          value={mappingDraft?.scopeValue ?? ''}
                          onChange={(event) =>
                            setMappingDrafts((current) => ({
                              ...current,
                              [mapping.id]: {
                                roleId: '',
                                scopeValue: event.target.value,
                              },
                            }))
                          }
                        >
                          {scopeOptions.map((scope) => (
                            <option
                              key={createScopeOptionValue(scope)}
                              value={createScopeOptionValue(scope)}
                            >
                              {t(`security.scope.${scope.type}`)} · {scope.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <>
                          <p className="text-sm font-semibold text-[var(--workbench-text)]">
                            {mapping.scopeName}
                          </p>
                          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                            {t(`security.scope.${mapping.scopeType}`)}
                          </p>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {canManageMappings ? (
                        <select
                          aria-label={`${mapping.directoryGroupName}: ${t('security.access.role')}`}
                          className="workbench-input min-h-9 w-full px-2 text-sm"
                          disabled={
                            isBusy || availableRolesForMapping.length === 0
                          }
                          value={mappingDraft?.roleId ?? mapping.roleId}
                          onChange={(event) =>
                            setMappingDrafts((current) => ({
                              ...current,
                              [mapping.id]: {
                                roleId: event.target.value,
                                scopeValue:
                                  current[mapping.id]?.scopeValue ??
                                  resolveMappingScopeValue(
                                    mapping,
                                    scopeOptions,
                                  ),
                              },
                            }))
                          }
                        >
                          <option disabled value="">
                            {t('security.access.selectRole')}
                          </option>
                          {currentDraftRole &&
                          !availableRolesForMapping.some(
                            (candidate) =>
                              candidate.id === currentDraftRole.id,
                          ) ? (
                            <option disabled value={currentDraftRole.id}>
                              {formatSecurityRoleName(currentDraftRole, t)}
                            </option>
                          ) : null}
                          {availableRolesForMapping.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {formatSecurityRoleName(candidate, t)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="workbench-badge-primary">
                          {role
                            ? formatSecurityRoleName(role, t)
                            : mapping.roleId}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right">
                      {canManageMappings ? (
                        <div className="flex justify-end gap-2">
                          <button
                            aria-label={`${t('security.action.save')}: ${mapping.directoryGroupName}`}
                            className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                            disabled={
                              isBusy || !selectedMappingScope || !selectedRole
                            }
                            type="button"
                            onClick={() => void handleUpdateMapping(mapping)}
                          >
                            {t(
                              busyOperation ===
                                `mapping:update:${mapping.id}`
                                ? 'security.action.saving'
                                : 'security.action.save',
                            )}
                          </button>
                          <button
                            aria-label={`${t('security.action.remove')}: ${mapping.directoryGroupName}`}
                            className="workbench-button-secondary min-h-9 px-3 text-red-700 disabled:cursor-not-allowed disabled:opacity-55"
                            disabled={isBusy}
                            type="button"
                            onClick={() =>
                              void onDeleteMapping?.(mapping).catch(
                                () => undefined,
                              )
                            }
                          >
                            {t('security.action.remove')}
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {snapshot.mappings.length === 0 ? (
            <EmptyState text={t('security.access.mappingsEmpty')} />
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <PanelSectionHeader
          description={t('security.access.rolesDescription')}
          title={t('security.access.rolesTitle')}
        />
        {canManageRoles ? (
          <form
            className="grid grid-cols-2 gap-4 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4 max-[760px]:grid-cols-1"
            data-testid="security-role-create-form"
            onSubmit={(event) => void handleCreateRole(event)}
          >
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.roleName')}
              <input
                className="workbench-input min-h-10 px-3"
                disabled={isBusy}
                maxLength={100}
                required
                value={newRoleName}
                onChange={(event) => setNewRoleName(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.roleDescription')}
              <input
                className="workbench-input min-h-10 px-3"
                disabled={isBusy}
                maxLength={240}
                value={newRoleDescription}
                onChange={(event) => setNewRoleDescription(event.target.value)}
              />
            </label>
            <fieldset
              className="col-span-2 grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-white p-4 max-[760px]:col-span-1"
              disabled={isBusy}
            >
              <legend className="px-1 text-xs font-semibold text-[var(--workbench-text)]">
                {t('security.access.rolePermissions')}
              </legend>
              <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                {t('security.access.permissionGrantCeilingHelp')}
              </p>
              <div className="grid grid-cols-2 gap-2 max-[760px]:grid-cols-1">
                {snapshot.permissions.map((permission) => {
                  const assignable = assignablePermissionIds.has(permission.id)

                  return (
                    <label
                      className={`flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 ${
                        assignable
                          ? 'border-[var(--workbench-border)]'
                          : 'cursor-not-allowed border-slate-200 bg-slate-50 text-[var(--workbench-muted)]'
                      }`}
                      key={permission.id}
                      title={
                        assignable
                          ? undefined
                          : t('security.access.permissionOutsideGrantCeiling')
                      }
                    >
                      <input
                        checked={newRolePermissionIds.includes(permission.id)}
                        className="mt-0.5 h-4 w-4 flex-none accent-[var(--workbench-primary)]"
                        disabled={!assignable}
                        type="checkbox"
                        onChange={(event) =>
                          setNewRolePermissionIds((current) =>
                            event.target.checked
                              ? Array.from(new Set([...current, permission.id]))
                              : current.filter((id) => id !== permission.id),
                          )
                        }
                      />
                      <span className="min-w-0 text-xs font-semibold leading-5">
                        {formatSecurityPermissionName(permission, t)}
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
            <label className="col-span-2 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 max-[760px]:col-span-1">
              <input
                checked={newRoleGuestAssignable}
                className="mt-0.5 h-4 w-4 flex-none accent-[var(--workbench-primary)]"
                disabled={isBusy}
                type="checkbox"
                onChange={(event) =>
                  setNewRoleGuestAssignable(event.target.checked)
                }
              />
              <span className="min-w-0">
                <strong className="block text-sm font-semibold text-amber-950">
                  {t('security.access.guestAssignable')}
                </strong>
                <span className="mt-1 block text-xs font-medium leading-5 text-amber-900">
                  {t('security.access.guestAssignableWarning')}
                </span>
              </span>
            </label>
            <div className="col-span-2 flex items-center justify-between gap-3 max-[760px]:col-span-1">
              {newRolePermissionIds.length === 0 ? (
                <p className="text-xs font-semibold text-amber-800" role="status">
                  {t('security.access.permissionRequired')}
                </p>
              ) : (
                <span />
              )}
              <button
                className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55"
                disabled={
                  isBusy ||
                  !newRoleName.trim() ||
                  newRolePermissionIds.length === 0
                }
                type="submit"
              >
                {t('security.access.createRole')}
              </button>
            </div>
          </form>
        ) : null}

        {roleImpactMessage ? (
          <p
            className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900"
            role="alert"
          >
            {roleImpactMessage}
          </p>
        ) : null}

        <RolePermissionMatrix
          busyOperation={busyOperation}
          canManage={canManageRoles}
          canPreviewImpact={Boolean(onPreviewRoleImpact)}
          assignablePermissionIds={snapshot.assignablePermissionIds}
          permissions={snapshot.permissions}
          roleGuestAssignableDrafts={roleGuestAssignableDrafts}
          roleDrafts={roleDrafts}
          roles={snapshot.roles}
          t={t}
          onDelete={handleDeleteRole}
          onGuestAssignableChange={(roleId, checked) =>
            setRoleGuestAssignableDrafts((current) => ({
              ...current,
              [roleId]: checked,
            }))
          }
          onChange={(roleId, permissionId, checked) =>
            setRoleDrafts((current) => {
              const existing = current[roleId] ?? []
              const next = checked
                ? Array.from(new Set([...existing, permissionId]))
                : existing.filter((id) => id !== permissionId)

              return { ...current, [roleId]: next }
            })
          }
          onSave={handleUpdateRole}
        />
      </section>
    </div>
  )
}

function RolePermissionMatrix({
  assignablePermissionIds,
  busyOperation,
  canManage,
  canPreviewImpact,
  permissions,
  roleGuestAssignableDrafts,
  roleDrafts,
  roles,
  t,
  onChange,
  onDelete,
  onGuestAssignableChange,
  onSave,
}: {
  assignablePermissionIds: readonly string[]
  busyOperation?: string
  canManage: boolean
  canPreviewImpact: boolean
  permissions: EnterpriseSecuritySnapshot['permissions']
  roleGuestAssignableDrafts: Readonly<Record<string, boolean>>
  roleDrafts: Readonly<Record<string, readonly string[]>>
  roles: EnterpriseRoleDefinition[]
  t: (key: MessageKey) => string
  onChange: (roleId: string, permissionId: string, checked: boolean) => void
  onDelete: (role: EnterpriseRoleDefinition) => Promise<void>
  onGuestAssignableChange: (roleId: string, checked: boolean) => void
  onSave: (role: EnterpriseRoleDefinition) => Promise<void>
}) {
  const permissionGroups = [
    'workspace',
    'members',
    'content',
    'security',
    'automation',
  ] as const satisfies readonly EnterpriseSecuritySnapshot['permissions'][number]['group'][]
  const isBusy = Boolean(busyOperation)
  const assignablePermissionIdSet = new Set(assignablePermissionIds)
  const roleExceedsGrantCeiling = (roleId: string) =>
    (roleDrafts[roleId] ?? []).some(
      (permissionId) => !assignablePermissionIdSet.has(permissionId),
    )

  return (
    <div className="overflow-x-auto border-t border-[var(--workbench-border)]">
      <table
        className="w-full min-w-[980px] border-collapse text-left"
        data-testid="security-role-permission-matrix"
      >
        <thead>
          <tr className="workbench-table-head">
            <th className="sticky left-0 z-10 min-w-[320px] bg-[var(--workbench-surface-muted)] px-4 py-3" scope="col">
              {t('security.access.permission')}
            </th>
            {roles.map((role) => (
              <th className="min-w-[170px] px-4 py-3 text-center" key={role.id} scope="col">
                <span className="block text-[var(--workbench-text)]">
                  {formatSecurityRoleName(role, t)}
                </span>
                <span className="mt-1 block text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
                  {t(`security.role.kind.${role.kind}`)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {permissionGroups.map((group) => {
            const groupPermissions = permissions.filter(
              (permission) => permission.group === group,
            )

            if (groupPermissions.length === 0) {
              return null
            }

            return [
              <tr key={`${group}-heading`}>
                <th
                  className="bg-slate-50 px-4 py-2 text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]"
                  colSpan={roles.length + 1}
                  scope="rowgroup"
                >
                  {t(`security.permissionGroup.${group}`)}
                </th>
              </tr>,
              ...groupPermissions.map((permission) => (
                <tr
                  className="border-t border-[var(--workbench-border)]"
                  key={permission.id}
                >
                  <th
                    className="sticky left-0 z-10 bg-white px-4 py-4"
                    scope="row"
                  >
                    <span className="block text-sm font-semibold text-[var(--workbench-text)]">
                      {formatSecurityPermissionName(permission, t)}
                    </span>
                    <span className="mt-1 block text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                      {formatSecurityPermissionDescription(permission, t)}
                    </span>
                    {permission.privileged ? (
                      <span className="workbench-badge-warning mt-2">
                        {t('security.access.privilegedPermission')}
                      </span>
                    ) : null}
                    {!assignablePermissionIdSet.has(permission.id) ? (
                      <span className="mt-2 block text-xs font-semibold text-slate-500">
                        {t('security.access.permissionOutsideGrantCeiling')}
                      </span>
                    ) : null}
                  </th>
                  {roles.map((role) => {
                    const checked = (roleDrafts[role.id] ?? []).includes(
                      permission.id,
                    )
                    const editable =
                      canManage &&
                      role.kind === 'custom' &&
                      assignablePermissionIdSet.has(permission.id)

                    return (
                      <td className="px-4 py-4 text-center" key={role.id}>
                        <input
                          aria-label={`${formatSecurityRoleName(role, t)}: ${formatSecurityPermissionName(permission, t)}`}
                          checked={checked}
                          className="h-5 w-5 accent-[var(--workbench-primary)]"
                          disabled={!editable || isBusy}
                          title={
                            assignablePermissionIdSet.has(permission.id)
                              ? undefined
                              : t(
                                  'security.access.permissionOutsideGrantCeiling',
                                )
                          }
                          type="checkbox"
                          onChange={(event) =>
                            onChange(
                              role.id,
                              permission.id,
                              event.target.checked,
                            )
                          }
                        />
                      </td>
                    )
                  })}
                </tr>
              )),
            ]
          })}
          <tr className="border-t-2 border-amber-200 bg-amber-50/60">
            <th
              className="sticky left-0 z-10 bg-amber-50 px-4 py-4"
              scope="row"
            >
              <span className="block text-sm font-semibold text-amber-950">
                {t('security.access.guestAssignable')}
              </span>
              <span className="mt-1 block text-xs font-medium leading-5 text-amber-900">
                {t('security.access.guestAssignableWarning')}
              </span>
            </th>
            {roles.map((role) => (
              <td className="px-4 py-4 text-center" key={role.id}>
                <input
                  aria-label={`${formatSecurityRoleName(role, t)}: ${t('security.access.guestAssignable')}`}
                  checked={
                    roleGuestAssignableDrafts[role.id] ??
                    role.guestAssignable
                  }
                  className="h-5 w-5 accent-[var(--workbench-primary)]"
                  disabled={
                    !canManage ||
                    role.kind !== 'custom' ||
                    roleExceedsGrantCeiling(role.id) ||
                    isBusy
                  }
                  type="checkbox"
                  onChange={(event) =>
                    onGuestAssignableChange(
                      role.id,
                      event.target.checked,
                    )
                  }
                />
              </td>
            ))}
          </tr>
        </tbody>
        {canManage && roles.some((role) => role.kind === 'custom') ? (
          <tfoot>
            <tr className="border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)]">
              <th className="sticky left-0 bg-[var(--workbench-surface-muted)] px-4 py-3 text-sm font-semibold text-[var(--workbench-muted)]">
                {t('security.access.saveCustomRoles')}
              </th>
              {roles.map((role) => (
                <td className="px-3 py-3 text-center" key={role.id}>
                  {role.kind === 'custom' ? (
                    <div className="grid justify-items-center gap-2">
                      <div className="flex justify-center gap-2">
                        <button
                          className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                          disabled={
                            isBusy ||
                            !canPreviewImpact ||
                            roleExceedsGrantCeiling(role.id) ||
                            (roleDrafts[role.id]?.length ?? 0) === 0
                          }
                          type="button"
                          onClick={() => void onSave(role)}
                        >
                          {t(
                            busyOperation === `role:update:${role.id}`
                              ? 'security.action.saving'
                              : 'security.access.saveRole',
                          )}
                        </button>
                        <button
                          className="workbench-button-secondary min-h-9 px-3 text-red-700 disabled:cursor-not-allowed disabled:opacity-55"
                          disabled={isBusy || !canPreviewImpact}
                          type="button"
                          onClick={() => void onDelete(role)}
                        >
                          {t('security.access.deleteRole')}
                        </button>
                      </div>
                      {roleExceedsGrantCeiling(role.id) ? (
                        <span className="max-w-[190px] text-xs font-semibold leading-5 text-slate-600">
                          {t('security.access.roleOutsideGrantCeiling')}
                        </span>
                      ) : (roleDrafts[role.id]?.length ?? 0) === 0 ? (
                        <span className="text-xs font-semibold text-amber-800">
                          {t('security.access.permissionRequired')}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                      {t('security.access.systemManaged')}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  )
}

function SecuritySessionsTab({
  busyOperation,
  snapshot,
  t,
  onPreview,
  onRequestConfirmation,
  onUpdate,
}: {
  busyOperation?: string
  snapshot: EnterpriseSecuritySnapshot
  t: (key: MessageKey) => string
  onPreview?: (
    input: UpdateEnterpriseSessionPolicyInput,
  ) => Promise<EnterpriseSessionPolicyImpact>
  onRequestConfirmation: (
    input: UpdateEnterpriseSessionPolicyInput,
    impact: EnterpriseSessionPolicyImpact,
  ) => void
  onUpdate?: (input: UpdateEnterpriseSessionPolicyInput) => Promise<unknown>
}) {
  const canManage = snapshot.capabilities.canManageSessions
  const [draft, setDraft] = useState(() =>
    cloneSessionPolicy(snapshot.sessionPolicy),
  )
  const isBusy = Boolean(busyOperation)
  const invalidSessionIntervals =
    !Number.isFinite(draft.idleTimeoutMinutes) ||
    !Number.isFinite(draft.reauthenticationMinutes) ||
    !Number.isFinite(draft.sensitiveActionReauthenticationMinutes) ||
    !Number.isFinite(draft.sessionLifetimeMinutes) ||
    draft.idleTimeoutMinutes > draft.sessionLifetimeMinutes ||
    draft.reauthenticationMinutes > draft.sessionLifetimeMinutes ||
    draft.sensitiveActionReauthenticationMinutes >
      draft.reauthenticationMinutes

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (
      !canManage ||
      !onPreview ||
      !onUpdate ||
      isBusy ||
      invalidSessionIntervals
    ) {
      return
    }

    const input = {
      allowedGuestDomains: normalizeLineList(draft.allowedGuestDomains),
      expectedVersion: snapshot.sessionPolicy.version,
      externalCollaboratorsAllowed:
        draft.externalCollaboratorsAllowed,
      guestSessionLifetimeMinutes: draft.guestSessionLifetimeMinutes,
      guestsAllowed: draft.guestsAllowed,
      idleTimeoutMinutes: draft.idleTimeoutMinutes,
      ipAllowlist: normalizeLineList(draft.ipAllowlist),
      mfaRequired: draft.mfaRequired,
      reauthenticationMinutes: draft.reauthenticationMinutes,
      sensitiveActionReauthenticationMinutes:
        draft.sensitiveActionReauthenticationMinutes,
      sessionLifetimeMinutes: draft.sessionLifetimeMinutes,
    } satisfies UpdateEnterpriseSessionPolicyInput

    try {
      const impact = await onPreview(input)
      if (impact.requiresConfirmation) {
        onRequestConfirmation(input, impact)
        return
      }

      await onUpdate(input)
    } catch {
      // Container の共有 error banner に委譲します。
    }
  }

  return (
    <form
      className="grid gap-5"
      data-testid="security-sessions"
      onSubmit={(event) => void handleSubmit(event)}
    >
      {!canManage ? <ReadOnlyNotice t={t} /> : null}

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <PanelSectionHeader
          description={t('security.sessions.authenticationDescription')}
          title={t('security.sessions.authenticationTitle')}
        />
        <div className="grid grid-cols-2 gap-4 border-t border-[var(--workbench-border)] p-5 max-[760px]:grid-cols-1">
          <SecurityToggle
            checked={draft.mfaRequired}
            description={t('security.sessions.mfaDescription')}
            disabled={!canManage || isBusy}
            label={t('security.sessions.mfaRequired')}
            onChange={(checked) =>
              setDraft((current) => ({ ...current, mfaRequired: checked }))
            }
          />
          <SecurityNumberField
            description={t('security.sessions.lifetimeDescription')}
            disabled={!canManage || isBusy}
            label={t('security.sessions.lifetime')}
            max={43_200}
            min={15}
            unit={t('security.unit.minutes')}
            value={draft.sessionLifetimeMinutes}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                sessionLifetimeMinutes: value,
              }))
            }
          />
          <SecurityNumberField
            description={t('security.sessions.idleTimeoutDescription')}
            disabled={!canManage || isBusy}
            label={t('security.sessions.idleTimeout')}
            max={43_200}
            min={5}
            unit={t('security.unit.minutes')}
            value={draft.idleTimeoutMinutes}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                idleTimeoutMinutes: value,
              }))
            }
          />
          <SecurityNumberField
            description={t('security.sessions.reauthenticationDescription')}
            disabled={!canManage || isBusy}
            label={t('security.sessions.reauthentication')}
            max={10_080}
            min={5}
            unit={t('security.unit.minutes')}
            value={draft.reauthenticationMinutes}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                reauthenticationMinutes: value,
              }))
            }
          />
          <SecurityNumberField
            description={t(
              'security.sessions.sensitiveReauthenticationDescription',
            )}
            disabled={!canManage || isBusy}
            label={t('security.sessions.sensitiveReauthentication')}
            max={10_080}
            min={1}
            unit={t('security.unit.minutes')}
            value={draft.sensitiveActionReauthenticationMinutes}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                sensitiveActionReauthenticationMinutes: value,
              }))
            }
          />
          <div className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4">
            <p className="text-sm font-semibold text-[var(--workbench-text)]">
              {t('security.sessions.unitHelpTitle')}
            </p>
            <p className="mt-2 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('security.sessions.unitHelpDescription')}
            </p>
            {invalidSessionIntervals ? (
              <p className="mt-3 text-xs font-semibold text-red-700" role="alert">
                {t('security.sessions.reauthenticationError')}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <PanelSectionHeader
          description={t('security.sessions.networkDescription')}
          title={t('security.sessions.networkTitle')}
        />
        <div className="border-t border-[var(--workbench-border)] p-5">
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('security.sessions.ipAllowlist')}
            <textarea
              className="workbench-input min-h-32 resize-y px-3 py-2 font-mono text-sm"
              disabled={!canManage || isBusy}
              placeholder={'203.0.113.0/24\n2001:db8::/48'}
              value={draft.ipAllowlist.join('\n')}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  ipAllowlist: event.target.value.split('\n'),
                }))
              }
            />
            <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('security.sessions.ipAllowlistHelp')}
            </span>
          </label>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <PanelSectionHeader
          description={t('security.sessions.guestsDescription')}
          title={t('security.sessions.guestsTitle')}
        />
        <div className="grid grid-cols-2 gap-4 border-t border-[var(--workbench-border)] p-5 max-[760px]:grid-cols-1">
          <SecurityToggle
            checked={draft.guestsAllowed}
            description={t('security.sessions.guestsAllowedDescription')}
            disabled={!canManage || isBusy}
            label={t('security.sessions.guestsAllowed')}
            onChange={(checked) =>
              setDraft((current) => ({ ...current, guestsAllowed: checked }))
            }
          />
          <SecurityToggle
            checked={draft.externalCollaboratorsAllowed}
            description={t(
              'security.sessions.externalCollaboratorsAllowedDescription',
            )}
            disabled={!canManage || isBusy}
            label={t('security.sessions.externalCollaboratorsAllowed')}
            onChange={(checked) =>
              setDraft((current) => ({
                ...current,
                externalCollaboratorsAllowed: checked,
              }))
            }
          />
          <SecurityNumberField
            description={t(
              'security.sessions.guestSessionLifetimeDescription',
            )}
            disabled={!canManage || isBusy || !draft.guestsAllowed}
            label={t('security.sessions.guestSessionLifetime')}
            max={43_200}
            min={15}
            unit={t('security.unit.minutes')}
            value={draft.guestSessionLifetimeMinutes}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                guestSessionLifetimeMinutes: value,
              }))
            }
          />
          <label className="col-span-2 grid gap-2 text-sm font-semibold text-[var(--workbench-text)] max-[760px]:col-span-1">
            {t('security.sessions.allowedGuestDomains')}
            <textarea
              className="workbench-input min-h-28 resize-y px-3 py-2 font-mono text-sm"
              disabled={
                !canManage ||
                isBusy ||
                (!draft.guestsAllowed &&
                  !draft.externalCollaboratorsAllowed)
              }
              placeholder={'partner.example\nvendor.example'}
              value={draft.allowedGuestDomains.join('\n')}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  allowedGuestDomains: event.target.value.split('\n'),
                }))
              }
            />
            <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('security.sessions.allowedGuestDomainsHelp')}
            </span>
          </label>
        </div>
      </section>

      {canManage ? (
        <div className="sticky bottom-4 flex justify-end">
          <button
            className="workbench-button-primary min-h-11 px-5 shadow-lg disabled:cursor-not-allowed disabled:opacity-55"
            data-testid="security-session-policy-save"
            disabled={
              isBusy ||
              invalidSessionIntervals ||
              !onPreview ||
              !onUpdate
            }
            type="submit"
          >
            {t(
              busyOperation === 'session-policy:preview'
                ? 'security.action.previewing'
                : busyOperation === 'session-policy:update'
                  ? 'security.action.saving'
                : 'security.sessions.save',
            )}
          </button>
        </div>
      ) : null}
    </form>
  )
}

function SecurityPrivilegedTab({
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
  onRotateServiceAccount,
}: {
  busyOperation?: string
  locale: Locale
  scopeOptions: EnterpriseSecurityScopeOption[]
  snapshot: EnterpriseSecuritySnapshot
  t: (key: MessageKey) => string
  onRegisterBreakGlass?: (
    input: RegisterEnterpriseBreakGlassAdministratorInput,
  ) => Promise<unknown>
  onTestBreakGlass?: () => Promise<unknown>
  onCreateServiceAccount?: (
    input: CreateEnterpriseServiceAccountInput,
  ) => Promise<void>
  onRequestDeactivateBreakGlass: (
    administrator: EnterpriseBreakGlassAdministrator,
  ) => void
  onRequestRevokeServiceAccount: (account: EnterpriseServiceAccount) => void
  onRotateServiceAccount?: (account: EnterpriseServiceAccount) => Promise<void>
}) {
  const canManage = snapshot.capabilities.canManagePrivilegedAccess
  const defaultServiceAccountScope =
    scopeOptions.find((scope) => scope.type === 'workspace') ??
    scopeOptions[0]
  const [serviceAccountName, setServiceAccountName] = useState('')
  const [serviceAccountRoleId, setServiceAccountRoleId] = useState('')
  const [serviceAccountScopeValue, setServiceAccountScopeValue] =
    useState(
      defaultServiceAccountScope
        ? createScopeOptionValue(defaultServiceAccountScope)
        : '',
    )
  const [
    serviceAccountCredentialLifetimeDays,
    setServiceAccountCredentialLifetimeDays,
  ] = useState(90)
  const [serviceAccountSourceCidrs, setServiceAccountSourceCidrs] =
    useState('')
  const [breakGlassEmail, setBreakGlassEmail] = useState('')
  const isBusy = Boolean(busyOperation)
  const selectedServiceAccountScope = scopeOptions.find(
    (scope) =>
      createScopeOptionValue(scope) === serviceAccountScopeValue,
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

  const handleCreateServiceAccount = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    if (
      !canManage ||
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
      await onCreateServiceAccount({
        allowedSourceCidrs: normalizedServiceAccountSourceCidrs,
        credentialLifetimeDays:
          serviceAccountCredentialLifetimeDays,
        name: serviceAccountName.trim(),
        roleId: selectedServiceAccountRoleId,
        scopeId:
          selectedServiceAccountScope.type === 'workspace'
            ? undefined
            : selectedServiceAccountScope.id,
        scopeType: selectedServiceAccountScope.type,
      })
      setServiceAccountName('')
      setServiceAccountRoleId('')
      setServiceAccountCredentialLifetimeDays(90)
      setServiceAccountSourceCidrs('')
    } catch {
      // Container の共有 error banner に委譲します。
    }
  }

  const handleRegisterBreakGlass = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()
    const email = breakGlassEmail.trim().toLowerCase()

    if (!canManage || !email || !onRegisterBreakGlass || isBusy) {
      return
    }

    try {
      await onRegisterBreakGlass({ email })
      setBreakGlassEmail('')
    } catch {
      // Container の共有 error banner に委譲します。
    }
  }

  return (
    <div className="grid gap-5" data-testid="security-privileged">
      {!canManage ? <ReadOnlyNotice t={t} /> : null}

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <PanelSectionHeader
          description={t('security.privileged.serviceAccountsDescription')}
          title={t('security.privileged.serviceAccountsTitle')}
        />
        {canManage ? (
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
                    key={createScopeOptionValue(scope)}
                    value={createScopeOptionValue(scope)}
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
                onChange={(event) => setServiceAccountRoleId(event.target.value)}
              >
                <option disabled value="">
                  {t('security.privileged.selectRole')}
                </option>
                {availableRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {formatSecurityRoleName(role, t)}
                  </option>
                ))}
              </select>
            </label>
            <SecurityNumberField
              description={t(
                'security.privileged.credentialLifetimeHelp',
              )}
              disabled={isBusy}
              label={t(
                'security.privileged.credentialLifetime',
              )}
              max={365}
              min={1}
              unit={t('security.unit.days')}
              value={serviceAccountCredentialLifetimeDays}
              onChange={
                setServiceAccountCredentialLifetimeDays
              }
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
                {t(
                  'security.privileged.allowedSourceCidrsHelp',
                )}
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
                {formatServiceAccountImpactSummary(
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
                data-testid={`security-service-account-${createSecurityTestId(account.id)}`}
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
                  <SecurityStatusBadge
                    label={t(`security.service.status.${account.status}`)}
                    tone={account.status === 'active' ? 'success' : 'neutral'}
                  />
                  <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                    {role
                      ? formatSecurityRoleName(role, t)
                      : account.roleId}
                  </span>
                </div>
                <div className="grid gap-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                  <p>
                    {t('security.privileged.serviceAccountScopeValue').replace(
                      '{scope}',
                      formatServiceAccountScope(
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
                        ? formatSecurityDate(
                            account.credentialExpiresAt,
                            locale,
                          )
                        : t('security.value.notConfigured'),
                    )}
                  </p>
                  <p>
                    {account.allowedSourceCidrs.length > 0
                      ? t(
                          'security.privileged.sourceCidrsRestricted',
                        ).replace(
                          '{count}',
                          String(account.allowedSourceCidrs.length),
                        )
                      : t(
                          'security.privileged.sourceCidrsUnrestricted',
                        )}
                  </p>
                  <p>
                    {t('security.privileged.lastUsed').replace(
                      '{date}',
                      account.lastUsedAt
                        ? formatSecurityDate(
                            account.lastUsedAt,
                            locale,
                          )
                        : t('security.value.never'),
                    )}
                  </p>
                </div>
                {canManage && account.status === 'active' ? (
                  <div className="flex flex-wrap justify-end gap-2 max-[600px]:justify-start">
                    <button
                      aria-label={`${t('security.privileged.rotateCredential')}: ${account.name}`}
                      className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                      disabled={isBusy}
                      type="button"
                      onClick={() =>
                        void onRotateServiceAccount?.(account).catch(
                          () => undefined,
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
                      onClick={() => onRequestRevokeServiceAccount(account)}
                    >
                      {t('security.privileged.revoke')}
                    </button>
                  </div>
                ) : null}
              </article>
            )
          })}
          {snapshot.serviceAccounts.length === 0 ? (
            <EmptyState text={t('security.privileged.serviceAccountsEmpty')} />
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-amber-300 bg-amber-50/40">
        <PanelSectionHeader
          badge={t('security.privileged.recoveryOnly')}
          description={t('security.privileged.breakGlassDescription')}
          title={t('security.privileged.breakGlassTitle')}
        />
        {canManage ? (
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
                onClick={() =>
                  void onTestBreakGlass().catch(() => undefined)
                }
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
              data-testid={`security-break-glass-${createSecurityTestId(administrator.id)}`}
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
              <SecurityStatusBadge
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
                    ? formatSecurityDate(administrator.lastTestedAt, locale)
                    : t('security.value.never'),
                )}
              </p>
              {canManage && administrator.status === 'active' ? (
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
            <EmptyState text={t('security.privileged.breakGlassEmpty')} />
          ) : null}
        </div>
      </section>
    </div>
  )
}

/**
 * Domain claim 作成直後だけ表示する DNS verification challenge の props です。
 */
export type EnterpriseDomainVerificationChallengeNoticeProps = {
  /** DNS record name と一回限りの value を含む challenge です。 */
  challenge: EnterpriseDomainVerificationChallenge
  /** 表示 locale です。 */
  locale: Locale
  /** Challenge を React state から破棄する callback です。 */
  onDismiss: () => void
}

/**
 * Domain claim の DNS TXT record 設定値を一回限り表示します。
 */
export function EnterpriseDomainVerificationChallengeNotice({
  challenge,
  locale,
  onDismiss,
}: EnterpriseDomainVerificationChallengeNoticeProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [copied, setCopied] = useState(false)

  const copyVerificationValue = async () => {
    if (!navigator.clipboard?.writeText) {
      return
    }

    try {
      await navigator.clipboard.writeText(challenge.verificationRecordValue)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section
      className="rounded-lg border border-sky-300 bg-sky-50 p-4"
      data-testid="enterprise-domain-verification-challenge"
      role="status"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-sky-950">
            {t('security.domainChallenge.title').replace(
              '{domain}',
              challenge.domain.domain,
            )}
          </h3>
          <p className="mt-1 text-xs font-medium leading-5 text-sky-900">
            {t('security.domainChallenge.description')}
          </p>
        </div>
        <button
          className="workbench-button-secondary min-h-9 px-3"
          type="button"
          onClick={onDismiss}
        >
          {t('security.action.close')}
        </button>
      </div>
      <dl className="mt-3 grid gap-3 rounded-lg border border-sky-300 bg-white px-3 py-3">
        <div>
          <dt className="text-xs font-semibold text-[var(--workbench-muted)]">
            {t('security.domainChallenge.recordName')}
          </dt>
          <dd className="mt-1">
            <code className="break-all text-sm font-semibold text-[var(--workbench-text)]">
              {challenge.domain.verificationRecordName}
            </code>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-[var(--workbench-muted)]">
            {t('security.domainChallenge.recordValue')}
          </dt>
          <dd className="mt-1 flex min-w-0 flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 break-all text-sm font-semibold text-[var(--workbench-text)]">
              {challenge.verificationRecordValue}
            </code>
            <button
              className="workbench-button-secondary min-h-9 flex-none px-3"
              type="button"
              onClick={() => void copyVerificationValue()}
            >
              {t(copied ? 'security.action.copied' : 'security.action.copy')}
            </button>
          </dd>
        </div>
      </dl>
    </section>
  )
}

/**
 * 一回限り表示する SCIM/service account secret notice の props です。
 */
export type EnterpriseOneTimeSecretNoticeProps = {
  /** Secret の用途です。 */
  kind: 'scim' | 'service-account'
  /** Secret を発行した接続または account 名です。 */
  label: string
  /** 表示 locale です。 */
  locale: Locale
  /** API response から一回だけ受け取る bearer token です。 */
  token: string
  /** Secret を React state から破棄する callback です。 */
  onDismiss: () => void
}

/**
 * Create/rotate 直後だけ bearer token を表示します。
 */
export function EnterpriseOneTimeSecretNotice({
  kind,
  label,
  locale,
  token,
  onDismiss,
}: EnterpriseOneTimeSecretNoticeProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [copied, setCopied] = useState(false)

  const copyToken = async () => {
    if (!navigator.clipboard?.writeText) {
      return
    }

    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section
      className="rounded-lg border border-amber-300 bg-amber-50 p-4"
      data-testid="enterprise-security-one-time-secret"
      role="status"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-amber-950">
            {t('security.secret.title')} · {label}
          </h3>
          <p className="mt-1 text-xs font-medium leading-5 text-amber-900">
            {t(
              kind === 'scim'
                ? 'security.secret.scimDescription'
                : 'security.secret.serviceAccountDescription',
            )}
          </p>
        </div>
        <button
          className="workbench-button-secondary min-h-9 px-3"
          data-testid="enterprise-security-secret-dismiss"
          type="button"
          onClick={onDismiss}
        >
          {t('security.action.close')}
        </button>
      </div>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-white px-3 py-3">
        <code className="min-w-0 flex-1 break-all text-sm font-semibold text-[var(--workbench-text)]">
          {token}
        </code>
        <button
          className="workbench-button-secondary min-h-9 flex-none px-3"
          type="button"
          onClick={() => void copyToken()}
        >
          {t(copied ? 'security.action.copied' : 'security.action.copy')}
        </button>
      </div>
    </section>
  )
}

/**
 * Enterprise security confirmation dialog の props です。
 */
type EnterpriseSecurityConfirmationDialogProps = {
  /** 確認対象の高影響 operation です。 */
  confirmation: EnterpriseSecurityConfirmation
  /** 直前の API failure を示す安全な表示メッセージです。 */
  errorMessage?: string
  /** Operation を実行中かどうかです。 */
  isBusy: boolean
  /** Dialog を閉じたあとに focus を戻す要素です。 */
  returnFocusRef: RefObject<HTMLElement | null>
  /** i18n message 解決関数です。 */
  t: (key: MessageKey) => string
  /** Operation を確定する callback です。 */
  onConfirm: () => Promise<void> | void
  /** Dialog を閉じる callback です。 */
  onRequestClose: () => void
}

/**
 * Enterprise security confirmation dialog の表示 copy です。
 */
type EnterpriseSecurityConfirmationCopy = {
  /** Dialog の見出しです。 */
  title: string
  /** 対象と影響を示す説明です。 */
  description: string
  /** 確定 button の文言です。 */
  confirmLabel: string
  /** 破壊的 operation として表示するかどうかです。 */
  destructive: boolean
}

function EnterpriseSecurityConfirmationDialog({
  confirmation,
  errorMessage,
  isBusy,
  returnFocusRef,
  t,
  onConfirm,
  onRequestClose,
}: EnterpriseSecurityConfirmationDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const dialogId = useId()
  const titleId = `${dialogId}-title`
  const descriptionId = `${dialogId}-description`
  const copy = createEnterpriseSecurityConfirmationCopy(confirmation, t)

  useEffect(() => {
    const returnFocusElement = returnFocusRef.current
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()

    return () => {
      window.requestAnimationFrame(() => {
        if (returnFocusElement?.isConnected) {
          returnFocusElement.focus()
        }
      })
    }
  }, [returnFocusRef])

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const dialog = dialogRef.current

      if (event.key === 'Tab' && dialog) {
        trapEnterpriseSecurityDialogFocus(event, dialog)
        return
      }

      if (event.key === 'Escape' && !isBusy) {
        onRequestClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isBusy, onRequestClose])

  useEffect(() => {
    if (isBusy) {
      dialogRef.current?.focus()
    }
  }, [isBusy])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm"
      onMouseDown={() => {
        if (!isBusy) {
          onRequestClose()
        }
      }}
    >
      <section
        aria-busy={isBusy}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="workbench-panel w-full max-w-[520px] overflow-hidden shadow-[0_24px_72px_rgba(23,32,29,0.28)]"
        data-testid="enterprise-security-confirmation"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-5">
          <h2
            className="text-xl font-semibold text-[var(--workbench-text)]"
            id={titleId}
          >
            {copy.title}
          </h2>
        </div>
        <div className="p-6">
          <p
            className="text-sm font-medium leading-6 text-[var(--workbench-muted)]"
            id={descriptionId}
          >
            {copy.description}
          </p>
          {errorMessage ? (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-semibold text-red-700" role="alert">
                {errorMessage}
              </p>
              <p className="mt-1 text-xs font-medium leading-5 text-red-700">
                {t('security.dialog.retryHint')}
              </p>
            </div>
          ) : null}
          <div className="mt-6 flex justify-end gap-3">
            <button
              className="workbench-button-secondary min-h-10 px-4"
              data-autofocus
              disabled={isBusy}
              type="button"
              onClick={onRequestClose}
            >
              {t('security.action.cancel')}
            </button>
            <button
              className={
                copy.destructive
                  ? 'min-h-10 rounded-md border border-red-700 bg-red-700 px-4 text-sm font-semibold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60'
                  : 'workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60'
              }
              disabled={isBusy}
              type="button"
              onClick={() => void onConfirm()}
            >
              {isBusy ? t('security.action.working') : copy.confirmLabel}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function SecurityToggle({
  checked,
  description,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  description: string
  disabled: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-w-0 items-start gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4">
      <input
        checked={checked}
        className="mt-0.5 h-5 w-5 flex-none accent-[var(--workbench-primary)]"
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-[var(--workbench-text)]">
          {label}
        </span>
        <span className="mt-1 block text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {description}
        </span>
      </span>
    </label>
  )
}

function SecurityNumberField({
  description,
  disabled,
  label,
  max,
  min,
  unit,
  value,
  onChange,
}: {
  description: string
  disabled: boolean
  label: string
  max: number
  min: number
  unit: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="grid gap-2 rounded-lg border border-[var(--workbench-border)] p-4 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <span className="flex min-w-0 overflow-hidden rounded-md border border-[var(--workbench-border)] bg-white focus-within:border-[var(--workbench-primary)]">
        <input
          className="min-h-10 min-w-0 flex-1 border-0 bg-transparent px-3 outline-none"
          disabled={disabled}
          max={max}
          min={min}
          required
          type="number"
          value={Number.isFinite(value) ? value : ''}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="grid flex-none place-items-center border-l border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 text-xs font-semibold text-[var(--workbench-muted)]">
          {unit}
        </span>
      </span>
      <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
        {description}
      </span>
    </label>
  )
}

function PanelSectionHeader({
  badge,
  description,
  title,
}: {
  badge?: string
  description: string
  title: string
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 bg-[var(--workbench-surface-muted)] px-4 py-4">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
          {title}
        </h3>
        <p className="mt-1 max-w-[760px] text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {description}
        </p>
      </div>
      {badge ? <span className="workbench-badge">{badge}</span> : null}
    </div>
  )
}

function ReadOnlyNotice({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div
      className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700"
      role="status"
    >
      {t('security.readOnly')}
    </div>
  )
}

function SecurityStatusBadge({
  label,
  tone,
}: {
  label: string
  tone: 'danger' | 'neutral' | 'success' | 'warning'
}) {
  const toneClassNames = {
    danger: 'border-red-200 bg-red-50 text-red-700',
    neutral: 'border-slate-200 bg-slate-50 text-slate-600',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
  } as const

  return (
    <span
      className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClassNames[tone]}`}
    >
      {label}
    </span>
  )
}

function SecurityDefinition({
  code = false,
  label,
  value,
}: {
  code?: boolean
  label: string
  value: string
}) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4">
      <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
        {label}
      </dt>
      <dd className="mt-2 break-all text-sm font-semibold leading-6 text-[var(--workbench-text)]">
        {code ? <code>{value}</code> : value}
      </dd>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
      {text}
    </p>
  )
}

function resolveSsoPrerequisites(
  snapshot: EnterpriseSecuritySnapshot,
): SsoPrerequisites {
  const identityProviderVerified = snapshot.ssoPrerequisites.providerReady
  const verifiedDomain = snapshot.ssoPrerequisites.domainReady
  const breakGlassReady = snapshot.ssoPrerequisites.breakGlassReady

  return {
    breakGlassReady,
    complete: identityProviderVerified && verifiedDomain && breakGlassReady,
    identityProviderVerified,
    verifiedDomain,
  }
}

function cloneIdentityProvider(
  identityProvider: EnterpriseIdentityProvider,
): EnterpriseIdentityProvider {
  return { ...identityProvider }
}

const securityRoleNameKeys: Readonly<Record<string, MessageKey>> = {
  'project:manager': 'security.role.name.projectManager',
  'project:member': 'security.role.name.projectMember',
  'project:viewer': 'security.role.name.projectViewer',
  'team:manager': 'security.role.name.teamManager',
  'team:member': 'security.role.name.teamMember',
  'workspace:admin': 'security.role.name.workspaceAdmin',
  'workspace:guest': 'security.role.name.workspaceGuest',
  'workspace:member': 'security.role.name.workspaceMember',
  'workspace:owner': 'security.role.name.workspaceOwner',
  'workspace-member': 'security.role.name.workspaceMember',
  'workspace-owner': 'security.role.name.workspaceOwner',
}

const securityPermissionResourceKeys: Readonly<Record<string, MessageKey>> = {
  audit: 'security.permission.resource.audit',
  automation: 'security.permission.resource.automation',
  content: 'security.permission.resource.content',
  files: 'security.permission.resource.files',
  identity: 'security.permission.resource.identity',
  members: 'security.permission.resource.members',
  planning: 'security.permission.resource.planning',
  projects: 'security.permission.resource.projects',
  requests: 'security.permission.resource.requests',
  security: 'security.permission.resource.security',
  'service-accounts': 'security.permission.resource.serviceAccounts',
  teams: 'security.permission.resource.teams',
  'work-items': 'security.permission.resource.workItems',
  workspace: 'security.permission.resource.workspace',
}

const securityPermissionActionKeys: Readonly<Record<string, MessageKey>> = {
  approve: 'security.permission.action.approve',
  configure: 'security.permission.action.configure',
  export: 'security.permission.action.export',
  manage: 'security.permission.action.manage',
  read: 'security.permission.action.read',
  use: 'security.permission.action.use',
  write: 'security.permission.action.write',
}

function formatSecurityRoleName(
  role: EnterpriseRoleDefinition,
  t: (key: MessageKey) => string,
) {
  const messageKey = securityRoleNameKeys[role.id]
  return messageKey ? t(messageKey) : role.name
}

function formatServiceAccountScope(
  account: EnterpriseServiceAccount,
  scopeOptions: EnterpriseSecurityScopeOption[],
  t: (key: MessageKey) => string,
) {
  const scope = scopeOptions.find(
    (candidate) =>
      candidate.type === account.scopeType &&
      (account.scopeType === 'workspace' ||
        candidate.id === account.scopeId),
  )

  return scope
    ? `${t(`security.scope.${scope.type}`)} · ${scope.name}`
    : account.scopeId
      ? `${t(`security.scope.${account.scopeType}`)} · ${account.scopeId}`
      : t(`security.scope.${account.scopeType}`)
}

function formatServiceAccountImpactSummary(
  scope: EnterpriseSecurityScopeOption | undefined,
  credentialLifetimeDays: number,
  sourceCidrCount: number,
  t: (key: MessageKey) => string,
) {
  const scopeLabel = scope
    ? `${t(`security.scope.${scope.type}`)} · ${scope.name}`
    : t('security.privileged.selectScope')
  const sourceBoundary =
    sourceCidrCount > 0
      ? t('security.privileged.sourceCidrsRestricted').replace(
          '{count}',
          String(sourceCidrCount),
        )
      : t('security.privileged.sourceCidrsUnrestricted')

  return t('security.privileged.impactSummaryDescription')
    .replace('{scope}', scopeLabel)
    .replace('{days}', String(credentialLifetimeDays))
    .replace('{source}', sourceBoundary)
}

function formatSecurityPermissionName(
  permission: EnterpriseSecuritySnapshot['permissions'][number],
  t: (key: MessageKey) => string,
) {
  const [resourceId, actionId] = permission.id.split('.')
  const resourceKey = resourceId
    ? securityPermissionResourceKeys[resourceId]
    : undefined
  const actionKey = actionId
    ? securityPermissionActionKeys[actionId]
    : undefined

  if (!resourceKey || !actionKey) {
    return permission.name
  }

  return t('security.permission.localizedName')
    .replace('{resource}', t(resourceKey))
    .replace('{action}', t(actionKey))
}

function formatSecurityPermissionDescription(
  permission: EnterpriseSecuritySnapshot['permissions'][number],
  t: (key: MessageKey) => string,
) {
  const localizedName = formatSecurityPermissionName(permission, t)
  return localizedName === permission.name
    ? permission.description
    : t('security.permission.localizedDescription').replace(
        '{permission}',
        localizedName,
      )
}

function cloneSessionPolicy(
  policy: EnterpriseSessionPolicy,
): EnterpriseSessionPolicy {
  return {
    ...policy,
    allowedGuestDomains: [...policy.allowedGuestDomains],
    ipAllowlist: [...policy.ipAllowlist],
  }
}

function createScopeOptionValue(option: EnterpriseSecurityScopeOption) {
  return `${option.type}:${option.id}`
}

function createRolePermissionDrafts(
  roles: EnterpriseRoleDefinition[],
): Record<string, readonly string[]> {
  return Object.fromEntries(
    roles.map((role) => [role.id, [...role.permissionIds]]),
  )
}

function createRoleGuestAssignableDrafts(
  roles: EnterpriseRoleDefinition[],
): Record<string, boolean> {
  return Object.fromEntries(
    roles.map((role) => [role.id, role.guestAssignable]),
  )
}

function resolveAssignableMappingRoles(
  snapshot: EnterpriseSecuritySnapshot,
  scopeType: EnterpriseSecurityScopeOption['type'],
) {
  const assignableRoleIds = new Set(
    snapshot.assignableRoleIds.groupMappings[scopeType],
  )

  return snapshot.roles.filter((role) => assignableRoleIds.has(role.id))
}

function createMappingDrafts(
  mappings: EnterpriseGroupRoleMapping[],
  scopeOptions: EnterpriseSecurityScopeOption[],
) {
  return Object.fromEntries(
    mappings.map((mapping) => [
      mapping.id,
      {
        roleId: mapping.roleId,
        scopeValue: resolveMappingScopeValue(mapping, scopeOptions),
      },
    ]),
  )
}

function resolveMappingScopeValue(
  mapping: EnterpriseGroupRoleMapping,
  scopeOptions: EnterpriseSecurityScopeOption[],
) {
  const exactScope = scopeOptions.find(
    (scope) =>
      scope.type === mapping.scopeType && scope.id === mapping.scopeId,
  )
  const workspaceScope =
    mapping.scopeType === 'workspace'
      ? scopeOptions.find((scope) => scope.type === 'workspace')
      : undefined

  return exactScope
    ? createScopeOptionValue(exactScope)
    : workspaceScope
      ? createScopeOptionValue(workspaceScope)
      : ''
}

function normalizeLineList(values: readonly string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)),
  )
}

function isEnterpriseProvisioningImpactExpired(
  impact: EnterpriseProvisioningImpact,
  currentTime = Date.now(),
) {
  const expiresAt = Date.parse(impact.expiresAt)

  return !Number.isFinite(expiresAt) || expiresAt <= currentTime
}

function formatSecurityDate(value: string, locale: Locale = 'ja') {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function updateSecurityTabQuery(tab: EnterpriseSecurityTab) {
  if (typeof window === 'undefined') {
    return
  }

  const url = new URL(window.location.href)
  url.searchParams.set('securityTab', tab)
  window.history.replaceState(window.history.state, '', url)
}

function createSecurityTestId(value: string) {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function formatRoleImpactBlockedMessage(
  impact: EnterpriseRoleImpact,
  t: (key: MessageKey) => string,
) {
  return t('security.access.roleImpactBlocked')
    .replace('{assignments}', String(impact.assignmentCount))
    .replace('{mappings}', String(impact.mappingCount))
    .replace('{serviceAccounts}', String(impact.serviceAccountCount))
}

function createEnterpriseSecurityConfirmationCopy(
  confirmation: EnterpriseSecurityConfirmation,
  t: (key: MessageKey) => string,
): EnterpriseSecurityConfirmationCopy {
  if (confirmation.kind === 'sso-enforcement') {
    return {
      confirmLabel: t(
        confirmation.enforced
          ? 'security.identity.enableEnforcement'
          : 'security.identity.disableEnforcement',
      ),
      description: t(
        confirmation.enforced
          ? 'security.dialog.ssoEnableDescription'
          : 'security.dialog.ssoDisableDescription',
      ),
      destructive: true,
      title: t(
        confirmation.enforced
          ? 'security.dialog.ssoEnableTitle'
          : 'security.dialog.ssoDisableTitle',
      ),
    }
  }

  if (confirmation.kind === 'provisioning') {
    const totalChanges = Object.values(confirmation.impact.counts).reduce(
      (total, count) => total + count,
      0,
    )

    return {
      confirmLabel: t('security.provisioning.apply'),
      description: t('security.dialog.provisioningDescription').replace(
        '{count}',
        String(totalChanges),
      ),
      destructive: true,
      title: t('security.dialog.provisioningTitle'),
    }
  }

  if (confirmation.kind === 'session-policy') {
    return {
      confirmLabel: t('security.dialog.sessionPolicyConfirm'),
      description: t('security.dialog.sessionPolicyDescription').replace(
        '{ip}',
        confirmation.impact.callerIp ||
          t('security.dialog.sessionPolicyUnknownIp'),
      ),
      destructive: true,
      title: t('security.dialog.sessionPolicyTitle'),
    }
  }

  if (confirmation.kind === 'scim-token-rotate') {
    return {
      confirmLabel: t('security.provisioning.rotateToken'),
      description: t('security.dialog.scimRotateDescription'),
      destructive: true,
      title: t('security.dialog.scimRotateTitle'),
    }
  }

  if (confirmation.kind === 'service-account-rotate') {
    return {
      confirmLabel: t('security.privileged.rotateCredential'),
      description: t('security.dialog.serviceAccountRotateDescription').replace(
        '{name}',
        confirmation.account.name,
      ),
      destructive: true,
      title: t('security.dialog.serviceAccountRotateTitle'),
    }
  }

  if (confirmation.kind === 'service-account-revoke') {
    return {
      confirmLabel: t('security.privileged.revoke'),
      description: t('security.dialog.serviceAccountDescription').replace(
        '{name}',
        confirmation.account.name,
      ),
      destructive: true,
      title: t('security.dialog.serviceAccountTitle'),
    }
  }

  if (confirmation.kind === 'mapping-delete') {
    return {
      confirmLabel: t('security.action.remove'),
      description: t('security.dialog.mappingDeleteDescription')
        .replace('{group}', confirmation.mapping.directoryGroupName)
        .replace('{scope}', confirmation.mapping.scopeName)
        .replace('{role}', confirmation.mapping.roleId),
      destructive: true,
      title: t('security.dialog.mappingDeleteTitle'),
    }
  }

  if (confirmation.kind === 'mapping-update') {
    return {
      confirmLabel: t('security.action.save'),
      description: t('security.dialog.mappingUpdateDescription')
        .replace('{group}', confirmation.mapping.directoryGroupName)
        .replace('{scope}', confirmation.input.scopeName)
        .replace('{role}', confirmation.input.roleId),
      destructive: true,
      title: t('security.dialog.mappingUpdateTitle'),
    }
  }

  if (confirmation.kind === 'break-glass') {
    return {
      confirmLabel: t('security.privileged.deactivate'),
      description: t('security.dialog.breakGlassDescription').replace(
        '{email}',
        confirmation.administrator.email,
      ),
      destructive: true,
      title: t('security.dialog.breakGlassTitle'),
    }
  }

  if (confirmation.kind === 'role-update') {
    if (
      confirmation.input.guestAssignable !==
      confirmation.role.guestAssignable
    ) {
      return {
        confirmLabel: t('security.access.saveRole'),
        description: t(
          confirmation.input.guestAssignable
            ? 'security.dialog.roleGuestEnableDescription'
            : 'security.dialog.roleGuestDisableDescription',
        ).replace('{name}', confirmation.role.name),
        destructive: true,
        title: t('security.dialog.roleGuestTitle'),
      }
    }

    return {
      confirmLabel: t('security.access.saveRole'),
      description: t('security.dialog.roleUpdateDescription')
        .replace('{name}', confirmation.role.name)
        .replace(
          '{permissions}',
          String(confirmation.impact.removedPermissionIds.length),
        )
        .replace(
          '{assignments}',
          String(confirmation.impact.assignmentCount),
        )
        .replace('{mappings}', String(confirmation.impact.mappingCount))
        .replace(
          '{serviceAccounts}',
          String(confirmation.impact.serviceAccountCount),
        ),
      destructive: true,
      title: t('security.dialog.roleUpdateTitle'),
    }
  }

  return {
    confirmLabel: t('security.access.deleteRole'),
    description: t('security.dialog.roleDescription')
      .replace('{name}', confirmation.role.name)
      .replace(
        '{assignments}',
        String(confirmation.impact.assignmentCount),
      )
      .replace('{mappings}', String(confirmation.impact.mappingCount))
      .replace(
        '{serviceAccounts}',
        String(confirmation.impact.serviceAccountCount),
      ),
    destructive: true,
    title: t('security.dialog.roleTitle'),
  }
}

function trapEnterpriseSecurityDialogFocus(
  event: KeyboardEvent | globalThis.KeyboardEvent,
  dialog: HTMLElement,
) {
  const focusableElements = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  )

  if (focusableElements.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }

  const firstElement = focusableElements[0]
  const lastElement = focusableElements.at(-1)

  if (event.shiftKey && document.activeElement === firstElement) {
    event.preventDefault()
    lastElement?.focus()
  } else if (!event.shiftKey && document.activeElement === lastElement) {
    event.preventDefault()
    firstElement?.focus()
  }
}
