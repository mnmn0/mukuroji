import { useRef, useState } from 'react'
import type {
  TenantGovernancePolicy,
  TenantOperation,
  TenantProfile,
} from '@mukuroji/contracts'
import {
  pauseTenantOperation,
  requestTenantClosure,
  requestTenantExport,
  resumeTenantOperation,
  updateTenantGovernance,
  updateTenantProfile,
  verifyTenantClosure,
  WorkspaceAccessApiError,
} from '../api'
import {
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'

/** Stable error view returned by tenant administration mutations. */
export type TenantAdministrationMutationError = {
  /** Whether the API supplied a safe user-facing message. */
  kind: 'api' | 'unexpected'
  /** Safe API message when the error came from the authenticated API boundary. */
  message?: string
}

/** Dependencies used by tenant administration mutations. */
type TenantAdministrationMutationInput = {
  /** Bearer token used for authenticated tenant mutations. */
  accessToken: string
  /** Revalidates the tenant aggregate after a successful mutation. */
  refresh(): Promise<unknown>
}

/** Supported active-operation control actions. */
type TenantOperationAction = 'pause' | 'resume' | 'verify'

/**
 * Owns tenant administration mutation requests, deduplication, and cache refresh.
 *
 * @param input - Authentication and query-refresh dependencies.
 * @returns Mutation state and tenant administration commands.
 */
export function useTenantAdministrationMutations({
  accessToken,
  refresh,
}: TenantAdministrationMutationInput) {
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const [isSaving, setIsSaving] = useState(false)
  const [actionError, setActionError] =
    useState<TenantAdministrationMutationError>()

  /** Executes one deduplicated mutation and optionally refreshes the tenant aggregate. */
  async function runMutation<Result>(
    operationKey: string,
    fingerprint: string,
    request: (context: MutationRequestContext) => Promise<Result>,
    refreshAfterSuccess = true,
  ): Promise<boolean> {
    setIsSaving(true)
    setActionError(undefined)
    try {
      await mutationRunner.run(operationKey, fingerprint, request)
      if (refreshAfterSuccess) await refresh()
      return true
    } catch (error) {
      setActionError(error instanceof WorkspaceAccessApiError
        ? { kind: 'api', message: error.message }
        : { kind: 'unexpected' })
      return false
    } finally {
      setIsSaving(false)
    }
  }

  /** Saves the current tenant profile draft. */
  async function saveProfile(profile: TenantProfile): Promise<boolean> {
    return await runMutation(
      'tenant-profile',
      JSON.stringify(profile),
      (context) => updateTenantProfile(accessToken, {
        region: profile.region,
        locale: profile.locale,
        defaultPolicy: profile.defaultPolicy,
        expectedRevision: profile.revision,
      }, context),
    )
  }

  /** Saves the current tenant governance draft. */
  async function saveGovernance(
    governance: TenantGovernancePolicy,
  ): Promise<boolean> {
    return await runMutation(
      'tenant-governance',
      JSON.stringify(governance),
      (context) => updateTenantGovernance(accessToken, {
        auditRetentionDays: governance.auditRetentionDays,
        legalHold: governance.legalHold,
        dataResidency: governance.dataResidency,
        encryptionKeyPolicy: governance.encryptionKeyPolicy,
        expectedRevision: governance.revision,
      }, context),
    )
  }

  /** Pauses, resumes, or verifies one tenant lifecycle operation. */
  async function runOperation(
    operation: TenantOperation,
    action: TenantOperationAction,
  ): Promise<boolean> {
    return await runMutation(
      `tenant-operation-${operation.operationId}`,
      `${operation.operationId}:${action}:${operation.revision}`,
      (context) => {
        const request = action === 'pause'
          ? pauseTenantOperation
          : action === 'resume'
            ? resumeTenantOperation
            : verifyTenantClosure
        return request(accessToken, operation.operationId, context)
      },
      action !== 'verify',
    )
  }

  /** Requests a tenant export in the selected format. */
  async function requestExport(format: 'jsonl' | 'csv'): Promise<boolean> {
    return await runMutation(
      'tenant-export',
      `export:${format}`,
      (context) => requestTenantExport(accessToken, { format }, context),
    )
  }

  /** Requests account closure after exact confirmation. */
  async function requestClosure(confirmation: string): Promise<boolean> {
    if (confirmation !== 'CLOSE') return false
    return await runMutation(
      'tenant-closure',
      'closure:CLOSE',
      (context) => requestTenantClosure(accessToken, { confirmation }, context),
    )
  }

  return {
    actionError,
    isSaving,
    requestClosure,
    requestExport,
    runOperation,
    saveGovernance,
    saveProfile,
  }
}
