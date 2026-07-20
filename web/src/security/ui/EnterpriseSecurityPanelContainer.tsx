import { useEffect, useMemo, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import {
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { requiresFreshEnterpriseAuthentication } from '../model/enterpriseAuthentication'
import { clearAuthSession } from '../../auth/session'
import { parseActiveEnterpriseRecoveryExpiry } from '../model/capabilityBoundary'
import {
  EnterpriseSecurityPanel,
  type EnterpriseSecurityScopeOption,
} from './EnterpriseSecurityPanel'
import {
  createEnterpriseDomainClaim,
  createEnterpriseGroupRoleMapping,
  createEnterpriseRole,
  createEnterpriseServiceAccount,
  deactivateEnterpriseBreakGlassAdministrator,
  deleteEnterpriseGroupRoleMapping,
  deleteEnterpriseRole,
  EnterpriseSecurityApiError,
  getEnterpriseSecuritySnapshot as loadEnterpriseSecuritySnapshot,
  previewEnterpriseProvisioning,
  previewEnterpriseRoleImpact,
  previewEnterpriseSessionPolicy,
  reconcileEnterpriseProvisioning,
  retryEnterpriseProvisioningLog,
  registerEnterpriseBreakGlassAdministrator,
  revokeEnterpriseBreakGlassAccess,
  revokeEnterpriseServiceAccount,
  rotateEnterpriseScimToken,
  rotateEnterpriseServiceAccountCredential,
  testEnterpriseBreakGlassAccess,
  updateEnterpriseIdentityProvider,
  updateEnterpriseGroupRoleMapping,
  updateEnterpriseRole,
  updateEnterpriseSessionPolicy,
  updateEnterpriseSsoEnforcement,
  verifyEnterpriseDomainClaim,
} from '../api'
import { useEnterpriseSecurity } from '../queries/useEnterpriseSecurity'
import { readEnterpriseSecurityTab } from '../model/tabs'

/**
 * Enterprise security API と管理 panel を接続する container の props です。
 */
export type EnterpriseSecurityPanelContainerProps = {
  /** Enterprise security API の Authorization header に使う access token です。 */
  accessToken: string
  /** 管理 panel の表示 locale です。 */
  locale: Locale
  /** Group mapping の対象にできる Workspace/Team/Project scope です。 */
  scopeOptions: EnterpriseSecurityScopeOption[]
}

/**
 * Mutation 中に発生した authorization boundary failure です。
 */
type EnterpriseSecurityAuthorizationFailure = {
  /** Failure が対応する access token です。 */
  accessToken: string
  /** Status/code を保持する API error です。 */
  error: EnterpriseSecurityApiError
}

/**
 * Enterprise security snapshot、mutation retry、再検証を管理します。
 */
export function EnterpriseSecurityPanelContainer({
  accessToken,
  locale,
  scopeOptions,
}: EnterpriseSecurityPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const { mutate: mutateCache } = useSWRConfig()
  const mutationSession = useMemo(
    () => ({
      accessToken,
      requestRunner: createMutationRequestRunner(),
    }),
    [accessToken],
  )
  const mutationRequestRunner = mutationSession.requestRunner
  const {
    data: snapshot,
    error,
    isLoading,
    key: securityKey,
  } = useEnterpriseSecurity(
    mutationSession.accessToken,
    loadEnterpriseSecuritySnapshot,
  )
  const [busyOperation, setBusyOperation] = useState<string>()
  const [mutationErrorMessage, setMutationErrorMessage] = useState<string>()
  const [authorizationFailure, setAuthorizationFailure] =
    useState<EnterpriseSecurityAuthorizationFailure>()
  const operationGenerationRef = useRef(0)

  const refresh = async (discardRetainedContexts = true) => {
    await mutateCache(
      securityKey,
      () => loadEnterpriseSecuritySnapshot(mutationSession.accessToken),
      { revalidate: false },
    )
    if (discardRetainedContexts) {
      mutationRequestRunner.discardRetainedContexts()
    }
  }

  const retryLoad = async () => {
    const operationGeneration = ++operationGenerationRef.current

    try {
      await refresh()
      setAuthorizationFailure(undefined)
      if (operationGenerationRef.current === operationGeneration) {
        setMutationErrorMessage(undefined)
      }
    } catch {
      // SWR が保持する load error を表示したまま unhandled rejection を防ぎます。
    }
  }

  const runMutation = async <TResult,>(
    operationKey: string,
    input: unknown,
    request: (context: MutationRequestContext) => Promise<TResult>,
    refreshStrategy: 'background' | 'none' | 'required' = 'required',
  ) => {
    const operationGeneration = ++operationGenerationRef.current
    setBusyOperation(operationKey)
    setMutationErrorMessage(undefined)

    try {
      const result = await mutationRequestRunner.run(
        operationKey,
        JSON.stringify(input),
        request,
        shouldRetainEnterpriseSecurityMutationContext,
      )

      if (refreshStrategy === 'required') {
        try {
          await refresh()
        } catch {
          if (operationGenerationRef.current === operationGeneration) {
            setMutationErrorMessage(t('security.error.refreshAfterMutation'))
          }
        }
      } else if (refreshStrategy === 'background') {
        void refresh(false).catch(() => {
          if (operationGenerationRef.current === operationGeneration) {
            setMutationErrorMessage(
              t('security.error.refreshAfterCredential'),
            )
          }
        })
      }

      return result
    } catch (mutationError) {
      if (
        mutationError instanceof EnterpriseSecurityApiError &&
        (mutationError.status === 401 || mutationError.status === 403)
      ) {
        setAuthorizationFailure({
          accessToken: mutationSession.accessToken,
          error: mutationError,
        })
        await mutateCache(securityKey, undefined, { revalidate: false })
      }
      if (operationGenerationRef.current === operationGeneration) {
        setMutationErrorMessage(
          readEnterpriseSecurityErrorMessage(mutationError, t),
        )
      }
      throw mutationError
    } finally {
      setBusyOperation((current) =>
        current === operationKey ? undefined : current,
      )
    }
  }

  const revokeActiveRecoveryAccess = async () => {
    try {
      await runMutation(
        'break-glass:revoke-activation',
        {},
        (context) =>
          revokeEnterpriseBreakGlassAccess(
            mutationSession.accessToken,
            context,
          ),
        'none',
      )
      window.location.assign('/dashboard')
    } catch {
      // runMutation が localized error と retry context を保持します。
    }
  }

  const canManageIdentity = snapshot?.capabilities.canManageIdentity ?? false
  const canManageProvisioning =
    snapshot?.capabilities.canManageProvisioning ?? false
  const canManageMappings =
    snapshot?.capabilities.canManageMappings ?? false
  const canManageRoles = snapshot?.capabilities.canManageRoles ?? false
  const canManageSessions = snapshot?.capabilities.canManageSessions ?? false
  const canManagePrivilegedAccess =
    snapshot?.capabilities.canManagePrivilegedAccess ?? false
  const canManageBreakGlass =
    snapshot?.capabilities.canManageBreakGlass ?? false
  const mutationAuthorizationError =
    authorizationFailure?.accessToken === mutationSession.accessToken
      ? authorizationFailure.error
      : undefined
  const loadAuthorizationError =
    error instanceof EnterpriseSecurityApiError &&
      (error.status === 401 || error.status === 403)
      ? error
      : undefined
  const authorizationError =
    mutationAuthorizationError ?? loadAuthorizationError
  const isAuthorizationError = authorizationError !== undefined
  const requiresFreshAuthentication =
    requiresFreshEnterpriseAuthentication(authorizationError)
  const isIpDenied =
    authorizationError?.code === 'EnterpriseSessionIpDenied'
  const activeRecoveryExpiryMilliseconds =
    parseActiveEnterpriseRecoveryExpiry(
      snapshot?.activeBreakGlassActivation?.expiresAt,
    )
  const activeRecoveryNotice = activeRecoveryExpiryMilliseconds
    ? {
        expiresAtMilliseconds:
          activeRecoveryExpiryMilliseconds,
      }
    : undefined
  const recoveryExpiryLabel = activeRecoveryNotice
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(activeRecoveryNotice.expiresAtMilliseconds)
    : undefined

  useEffect(() => {
    if (requiresFreshAuthentication) {
      clearAuthSession()
    }
  }, [requiresFreshAuthentication])

  useEffect(() => {
    scrubEnterpriseRecoveryRedirectParameters()
  }, [])

  useEffect(() => {
    if (!activeRecoveryExpiryMilliseconds) {
      return
    }

    const remainingMilliseconds =
      activeRecoveryExpiryMilliseconds - Date.now()
    const timeoutId = window.setTimeout(
      () => {
        void mutateCache(securityKey, undefined, {
          revalidate: false,
        }).finally(() => {
          window.location.replace(
            readScrubbedEnterpriseSecurityLocation(),
          )
        })
      },
      Math.max(0, remainingMilliseconds),
    )

    return () => window.clearTimeout(timeoutId)
  }, [
    activeRecoveryExpiryMilliseconds,
    mutateCache,
    securityKey,
  ])

  return (
    <div className="grid gap-4">
      {activeRecoveryNotice && recoveryExpiryLabel && !isAuthorizationError ? (
        <section
          aria-live="polite"
          className="flex flex-col gap-4 rounded-xl border border-[#eab8ad] bg-[#fff5f2] p-4 text-[#713128] sm:flex-row sm:items-center"
          data-testid="enterprise-recovery-active"
        >
          <span
            aria-hidden="true"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#f9ddd6] text-lg font-black"
          >
            !
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-sm font-bold">
              {t('security.recovery.active.title')}
            </h2>
            <p className="mb-0 mt-1 text-sm font-medium leading-6">
              {t('security.recovery.active.description').replace(
                '{time}',
                recoveryExpiryLabel,
              )}
            </p>
          </div>
          <button
            className="min-h-10 shrink-0 cursor-pointer rounded-md border border-[#c66352] bg-white px-4 text-sm font-bold text-[#8c382b] hover:bg-[#fffaf8] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busyOperation === 'break-glass:revoke-activation'}
            type="button"
            onClick={() => void revokeActiveRecoveryAccess()}
          >
            {t(
              busyOperation === 'break-glass:revoke-activation'
                ? 'security.recovery.active.revoking'
                : 'security.recovery.active.revoke',
            )}
          </button>
        </section>
      ) : null}
      <EnterpriseSecurityPanel
      busyOperation={busyOperation}
      initialTab={readInitialEnterpriseSecurityTab()}
      isLoading={isLoading}
      isStale={Boolean(error && snapshot && !isAuthorizationError)}
      key={`${mutationSession.accessToken}:${authorizationError?.code ?? isAuthorizationError}`}
      loadErrorActionLabel={
        requiresFreshAuthentication
          ? t('security.action.signInAgain')
          : isIpDenied
            ? t('security.action.recoverAccess')
            : undefined
      }
      loadErrorMessage={
        requiresFreshAuthentication
          ? t('security.error.authenticationRequired')
          : isIpDenied
            ? t('security.error.ipDeniedRecovery')
            : mutationAuthorizationError
              ? t('security.error.forbidden')
          : error
              ? loadAuthorizationError
                ? t('security.error.forbidden')
                : t('security.error.load')
            : undefined
      }
      locale={locale}
      mutationErrorMessage={mutationErrorMessage}
      scopeOptions={scopeOptions}
      snapshot={isAuthorizationError ? undefined : snapshot}
      onLoadErrorAction={
        requiresFreshAuthentication
          ? redirectToFreshEnterpriseAuthentication
          : isIpDenied
            ? redirectToEnterpriseRecovery
            : undefined
      }
      onRegisterBreakGlass={
        canManageBreakGlass
          ? (input) =>
              runMutation('break-glass:register', input, (context) =>
                registerEnterpriseBreakGlassAdministrator(
                  mutationSession.accessToken,
                  input,
                  context,
                ),
              )
          : undefined
      }
      onTestBreakGlass={
        canManageBreakGlass
          ? () =>
              runMutation('break-glass:test', {}, (context) =>
                testEnterpriseBreakGlassAccess(
                  mutationSession.accessToken,
                  context,
                ),
              )
          : undefined
      }
      onApplyProvisioning={
        canManageProvisioning
          ? (impact) =>
              runMutation('provisioning:reconcile', impact, (context) =>
                reconcileEnterpriseProvisioning(
                  mutationSession.accessToken,
                  impact,
                  context,
                ),
              )
          : undefined
      }
      onCreateDomain={
        canManageIdentity
          ? (input) =>
              runMutation('domain:create', input, (context) =>
                createEnterpriseDomainClaim(
                  mutationSession.accessToken,
                  input,
                  context,
                ),
              )
          : undefined
      }
      onCreateMapping={
        canManageMappings
          ? (input) =>
              runMutation('mapping:create', input, (context) =>
                createEnterpriseGroupRoleMapping(
                  mutationSession.accessToken,
                  input,
                  context,
                ),
              )
          : undefined
      }
      onCreateRole={
        canManageRoles
          ? (input) =>
              runMutation('role:create', input, (context) =>
                createEnterpriseRole(
                  mutationSession.accessToken,
                  input,
                  context,
                ),
              )
          : undefined
      }
      onCreateServiceAccount={
        canManagePrivilegedAccess
          ? (input) =>
              runMutation('service-account:create', input, (context) =>
                createEnterpriseServiceAccount(
                  mutationSession.accessToken,
                  input,
                  context,
                ),
                'background',
              )
          : undefined
      }
      onDeactivateBreakGlass={
        canManageBreakGlass
          ? (administrator) =>
              runMutation(
                `break-glass:deactivate:${administrator.id}`,
                administrator,
                (context) =>
                  deactivateEnterpriseBreakGlassAdministrator(
                    mutationSession.accessToken,
                    administrator,
                    context,
                  ),
              )
          : undefined
      }
      onDeleteMapping={
        canManageMappings
          ? (mapping) =>
              runMutation(`mapping:delete:${mapping.id}`, mapping, (context) =>
                deleteEnterpriseGroupRoleMapping(
                  mutationSession.accessToken,
                  mapping,
                  context,
                ),
              )
          : undefined
      }
      onDeleteRole={
        canManageRoles
          ? (role, impactConfirmationToken) =>
              runMutation(
                `role:delete:${role.id}`,
                { impactConfirmationToken, role },
                (context) =>
                  deleteEnterpriseRole(
                    mutationSession.accessToken,
                    role,
                    impactConfirmationToken,
                    context,
                  ),
              )
          : undefined
      }
      onPreviewProvisioning={
        canManageProvisioning
          ? () =>
              runMutation(
                'provisioning:preview',
                { mode: 'reconcile' },
                (context) =>
                  previewEnterpriseProvisioning(
                    mutationSession.accessToken,
                    context,
                  ),
                'none',
              )
          : undefined
      }
      onPreviewSessionPolicy={
        canManageSessions
          ? (input) =>
              runMutation(
                'session-policy:preview',
                input,
                (context) =>
                  previewEnterpriseSessionPolicy(
                    mutationSession.accessToken,
                    input,
                    context,
                  ),
                'none',
              )
          : undefined
      }
      onPreviewRoleImpact={
        canManageRoles
          ? (role, input) =>
              runMutation(
                `role:impact:${role.id}`,
                input,
                (context) =>
                  previewEnterpriseRoleImpact(
                    mutationSession.accessToken,
                    role.id,
                    input,
                    context,
                  ),
                'none',
              )
          : undefined
      }
      onRefresh={retryLoad}
      onRetryProvisioningLog={
        canManageProvisioning
          ? (log) =>
              runMutation(
                `provisioning-log:retry:${log.id}`,
                log,
                (context) =>
                  retryEnterpriseProvisioningLog(
                    mutationSession.accessToken,
                    log.id,
                    context,
                  ),
              )
          : undefined
      }
      onRevokeServiceAccount={
        canManagePrivilegedAccess
          ? (account) =>
              runMutation(
                `service-account:revoke:${account.id}`,
                account,
                (context) =>
                  revokeEnterpriseServiceAccount(
                    mutationSession.accessToken,
                    account,
                    context,
                  ),
              )
          : undefined
      }
      onRotateScimToken={
        canManageProvisioning && snapshot
          ? () =>
              runMutation(
                'scim-token:rotate',
                { expectedVersion: snapshot.scim.version },
                (context) =>
                  rotateEnterpriseScimToken(
                    mutationSession.accessToken,
                    snapshot.scim.version,
                    snapshot.scim.identityProviderId,
                    context,
                  ),
                'background',
              )
          : undefined
      }
      onRotateServiceAccount={
        canManagePrivilegedAccess
          ? (account) =>
              runMutation(
                `service-account:rotate:${account.id}`,
                account,
                (context) =>
                  rotateEnterpriseServiceAccountCredential(
                    mutationSession.accessToken,
                    account,
                    context,
                  ),
                'background',
              )
          : undefined
      }
      onUpdateIdentityProvider={
        canManageIdentity
          ? (input) =>
              runMutation('identity-provider:update', input, (context) =>
                updateEnterpriseIdentityProvider(
                  mutationSession.accessToken,
                  input,
                  context,
                ),
              )
          : undefined
      }
      onUpdateMapping={
        canManageMappings
          ? (mappingId, input) =>
              runMutation(`mapping:update:${mappingId}`, input, (context) =>
                updateEnterpriseGroupRoleMapping(
                  mutationSession.accessToken,
                  mappingId,
                  input,
                  context,
                ),
              )
          : undefined
      }
      onUpdateRole={
        canManageRoles
          ? (roleId, input) =>
              runMutation(`role:update:${roleId}`, input, (context) =>
                updateEnterpriseRole(
                  mutationSession.accessToken,
                  roleId,
                  input,
                  context,
                ),
              )
          : undefined
      }
      onUpdateSessionPolicy={
        canManageSessions
          ? (input) =>
              runMutation('session-policy:update', input, (context) =>
                updateEnterpriseSessionPolicy(
                  mutationSession.accessToken,
                  input,
                  context,
                ),
              )
          : undefined
      }
      onUpdateSsoEnforcement={
        canManageIdentity
          ? (input) =>
              runMutation('sso-enforcement:update', input, (context) =>
                updateEnterpriseSsoEnforcement(
                  mutationSession.accessToken,
                  input,
                  context,
                ),
              )
          : undefined
      }
      onVerifyDomain={
        canManageIdentity
          ? (domain, expectedVersion) =>
              runMutation(
                `domain:verify:${domain}`,
                { domain, expectedVersion },
                (context) =>
                  verifyEnterpriseDomainClaim(
                    mutationSession.accessToken,
                    domain,
                    expectedVersion,
                    context,
                  ),
              )
          : undefined
      }
      />
    </div>
  )
}

function readInitialEnterpriseSecurityTab() {
  return typeof window === 'undefined'
    ? ('overview' as const)
    : readEnterpriseSecurityTab(
        new URLSearchParams(window.location.search).get('securityTab'),
      )
}

function scrubEnterpriseRecoveryRedirectParameters() {
  if (typeof window === 'undefined') {
    return
  }

  const scrubbedLocation =
    readScrubbedEnterpriseSecurityLocation()
  const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (scrubbedLocation !== currentLocation) {
    window.history.replaceState(
      window.history.state,
      '',
      scrubbedLocation,
    )
  }
}

function readScrubbedEnterpriseSecurityLocation() {
  const url = new URL(window.location.href)
  url.searchParams.delete('recovery')
  url.searchParams.delete('recoveryExpiresAt')
  return `${url.pathname}${url.search}${url.hash}`
}

function shouldRetainEnterpriseSecurityMutationContext(error: unknown) {
  return !(error instanceof EnterpriseSecurityApiError)
}

function redirectToFreshEnterpriseAuthentication() {
  if (typeof window === 'undefined') {
    return
  }

  const returnTo = `/settings/security${window.location.search}`
  window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`)
}

function redirectToEnterpriseRecovery() {
  if (typeof window === 'undefined') {
    return
  }

  window.location.assign('/security/recovery')
}

function readEnterpriseSecurityErrorMessage(
  error: unknown,
  t: ReturnType<typeof createTranslator>,
) {
  if (error instanceof EnterpriseSecurityApiError) {
    if (requiresFreshEnterpriseAuthentication(error)) {
      return t('security.error.authenticationRequired')
    }

    if (error.code === 'EnterpriseSessionIpDenied') {
      return t('security.error.ipDenied')
    }

    if (
      error.code === 'EnterpriseIdentityPrerequisiteRequired' ||
      error.code === 'EnterpriseSsoPrerequisiteMissing' ||
      error.code === 'EnterpriseBreakGlassRequired'
    ) {
      return t('security.error.prerequisite')
    }

    if (error.status === 403) {
      return t('security.error.forbidden')
    }

    if (error.status === 409 || error.status === 412) {
      return t('security.error.conflict')
    }

    if (error.status === 400 || error.status === 422) {
      return t('security.error.invalid')
    }

  }

  return t('security.error.operation')
}
