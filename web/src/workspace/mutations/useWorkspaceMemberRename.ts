import { useCallback } from 'react'
import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import { updateWorkspaceMemberName, WorkspaceAccessApiError } from '../api'

/** Inputs of {@link useWorkspaceMemberRename}. */
export type UseWorkspaceMemberRenameOptions = {
  /** Access token of the administrator's session. */
  accessToken: string
  /** Runner that reuses the idempotency key when a request is retried after a transport failure. */
  requestRunner: MutationRequestRunner
  /** Reloads the member list once the rename settles. */
  reload: () => Promise<unknown>
}

/**
 * Keeps the idempotency context only when the outcome of the rename is unknown, which is the
 * case for a failure that did not come back as an API error.
 *
 * @param error - Error of the failed request.
 * @returns Whether to keep the context for a retry.
 */
function shouldRetainRenameContext(error: unknown) {
  return !(error instanceof WorkspaceAccessApiError)
}

/**
 * Corrects another member's display name as an administrator, and reloads the member list
 * afterwards whether the rename succeeded or not, so that a conflict shows the latest name.
 *
 * @param options - Session, request runner, and the member list reload.
 * @returns The rename action for the member ledger; it rejects with the API error on failure.
 */
export function useWorkspaceMemberRename({ accessToken, requestRunner, reload }: UseWorkspaceMemberRenameOptions) {
  return useCallback(async (memberKey: string, name: string | undefined, expectedVersion: number) => {
    const input = { name: name ?? null, expectedVersion }
    try {
      await requestRunner.run(
        `workspace-member:rename:${memberKey}`,
        JSON.stringify(input),
        (context) => updateWorkspaceMemberName(accessToken, memberKey, input, context),
        shouldRetainRenameContext,
      )
    } finally {
      await reload()
    }
  }, [accessToken, requestRunner, reload])
}
