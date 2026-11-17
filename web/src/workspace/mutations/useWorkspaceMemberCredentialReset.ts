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
 * is still running, so that a retry reuses its key and resumes the recorded reset instead of
 * starting a new one. A transport failure or a server error (5xx) may come after the server
 * recorded or applied the reset, so its outcome is unknown. Any other API error is a definite
 * answer and is not retried with the same key.
 *
 * @param error - Error of the failed request.
 * @returns Whether to keep the context for a retry.
 */
export function shouldRetainCredentialResetContext(error: unknown) {
  return !(error instanceof WorkspaceAccessApiError) ||
    error.status >= 500 ||
    error.code === 'WorkspaceCredentialActionInProgress'
}

/**
 * Tells whether a failed reset closes its confirmation dialog. An expired reset cannot be
 * resumed, so confirming the same dialog again would only repeat the expired request; the
 * administrator checks the member's state and starts a new reset instead.
 *
 * @param error - Error of the failed request.
 * @returns Whether to close the dialog and show the error outside it.
 */
export function shouldCloseCredentialResetDialog(error: unknown) {
  return error instanceof WorkspaceAccessApiError && error.code === 'WorkspaceCredentialActionExpired'
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
