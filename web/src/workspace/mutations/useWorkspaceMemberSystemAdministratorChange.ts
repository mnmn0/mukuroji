import { useCallback } from 'react'
import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import { setWorkspaceMemberSystemAdministrator } from '../api'
import { shouldRetainCredentialResetContext } from './useWorkspaceMemberCredentialReset'

/** Inputs of {@link useWorkspaceMemberSystemAdministratorChange}. */
export type UseWorkspaceMemberSystemAdministratorChangeOptions = {
  /** Access token of the owner's session. */
  accessToken: string
  /** Runner that reuses the idempotency key when a request is retried after a transport failure. */
  requestRunner: MutationRequestRunner
  /** Reloads the members' sign-in security, which lists the system administrators. */
  revalidateSignInSecurity: () => Promise<unknown>
}

/**
 * Grants or revokes system administrator access for a member, and reloads the sign-in security
 * afterwards, whether the change succeeded or not.
 *
 * A request whose outcome is unknown keeps its idempotency context, as an administrator
 * credential reset does, so that a retry resumes the recorded change instead of starting a new
 * one.
 *
 * @param options - Session, request runner, and the sign-in security reload.
 * @returns The change action for the member ledger.
 */
export function useWorkspaceMemberSystemAdministratorChange({
  accessToken,
  requestRunner,
  revalidateSignInSecurity,
}: UseWorkspaceMemberSystemAdministratorChangeOptions) {
  return useCallback(async (memberKey: string, systemAdministrator: boolean) => {
    try {
      await requestRunner.run(
        `workspace-member:system-administrator:${memberKey}`,
        JSON.stringify({ memberKey, systemAdministrator }),
        (context) => setWorkspaceMemberSystemAdministrator(
          accessToken,
          memberKey,
          systemAdministrator,
          context,
        ),
        shouldRetainCredentialResetContext,
      )
    } finally {
      void revalidateSignInSecurity()
    }
  }, [accessToken, requestRunner, revalidateSignInSecurity])
}
