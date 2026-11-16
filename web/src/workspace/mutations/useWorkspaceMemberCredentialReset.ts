import { useCallback } from 'react'
import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import {
  resetWorkspaceMemberCredential,
  WorkspaceAccessApiError,
  type WorkspaceMemberCredentialAction,
} from '../api'

/** Inputs of {@link useWorkspaceMemberCredentialReset}. */
export type UseWorkspaceMemberCredentialResetOptions = {
  /** Access token of the administrator's session. */
  accessToken: string
  /** Runner that reuses the idempotency key when a request is retried after a transport failure. */
  requestRunner: MutationRequestRunner
  /** Reloads every member's MFA enrollment once the reset settles. */
  revalidateSignInSecurity: () => Promise<unknown>
}

/**
 * Keeps the idempotency context of a reset whose outcome is unknown, or that another attempt
 * is still running, so that a retry reuses its key. Any other API error is a definite answer
 * and is not retried with the same key.
 *
 * @param error - Error of the failed request.
 * @returns Whether to keep the context for a retry.
 */
function shouldRetainCredentialResetContext(error: unknown) {
  return !(error instanceof WorkspaceAccessApiError) ||
    error.code === 'WorkspaceCredentialActionInProgress'
}

/**
 * Sends a password reset code to a member or resets the member's authenticator app, and
 * reloads the members' MFA enrollment afterwards, whether the reset succeeded or not.
 *
 * @param options - Session, request runner, and the sign-in security reload.
 * @returns The reset action for the member ledger.
 */
export function useWorkspaceMemberCredentialReset({
  accessToken,
  requestRunner,
  revalidateSignInSecurity,
}: UseWorkspaceMemberCredentialResetOptions) {
  return useCallback(async (memberKey: string, credentialAction: WorkspaceMemberCredentialAction) => {
    try {
      await requestRunner.run(
        `workspace-member:${credentialAction}:${memberKey}`,
        JSON.stringify({ memberKey, credentialAction }),
        (context) => resetWorkspaceMemberCredential(accessToken, memberKey, credentialAction, context),
        shouldRetainCredentialResetContext,
      )
    } finally {
      void revalidateSignInSecurity()
    }
  }, [accessToken, requestRunner, revalidateSignInSecurity])
}
