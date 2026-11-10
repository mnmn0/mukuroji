import type { ApiKeySummary } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import {
  createPersonalApiKey,
  revokePersonalApiKey,
  rotatePersonalApiKey,
} from '../api/apiKeys'
import { shouldRetainDeveloperPlatformMutationContext } from '../api/errors'
import { usePersonalAgentConnection } from '../queries/usePersonalAgentConnection'

/** A token secret shown once after issuance or reissue. */
export type IssuedPersonalAgentToken = {
  /** Name of the token. */
  name: string
  /** One-time secret. */
  secret: string
}

/**
 * Loads the member's agent connection and issues, reissues, and revokes their own tokens.
 *
 * Each action keeps its operation busy until its result is applied and the token list has
 * reloaded, and a transient failure is retried with the same idempotency key.
 *
 * @param accessToken - Access token of the signed-in member.
 * @returns The connection overview, its load state, the operation state, and the actions.
 */
export function usePersonalAgentCredentials(accessToken: string) {
  const { data, error, isLoading, mutate } = usePersonalAgentConnection(accessToken)
  const requestRunner = useMemo(() => createMutationRequestRunner(), [])
  const [busyOperation, setBusyOperation] = useState<string>()
  const [hasOperationError, setHasOperationError] = useState(false)
  const [issuedToken, setIssuedToken] = useState<IssuedPersonalAgentToken>()

  /**
   * Runs one mutation, applies its result, then reloads the member's tokens.
   *
   * @param operationKey - Logical mutation key.
   * @param fingerprint - Payload fingerprint for the logical mutation.
   * @param request - API call.
   * @param onSuccess - Applies the API result before the reload.
   * @returns Whether the mutation succeeded.
   */
  async function runMutation<TResult>(
    operationKey: string,
    fingerprint: string,
    request: Parameters<typeof requestRunner.run<TResult>>[2],
    onSuccess?: (result: TResult) => void,
  ) {
    setBusyOperation(operationKey)
    setHasOperationError(false)
    let succeeded = false
    try {
      const result = await requestRunner.run(
        operationKey,
        fingerprint,
        request,
        shouldRetainDeveloperPlatformMutationContext,
      )
      onSuccess?.(result)
      succeeded = true
    } catch {
      setHasOperationError(true)
    }
    try {
      await mutate()
    } catch {
      // The load error is shown by the query state.
    } finally {
      setBusyOperation(undefined)
    }
    return succeeded
  }

  /**
   * Issues a token and keeps its secret until dismissed.
   *
   * @param input - Token name and expiry.
   * @param onIssued - Runs with the secret, before the reload, so the caller can clear its form
   *   while the operation is still busy.
   * @returns Whether the token was issued.
   */
  function issue(input: { name: string; expiresAt: string }, onIssued?: () => void) {
    return runMutation('issue', JSON.stringify(input), (context) =>
      createPersonalApiKey(accessToken, input, context), (result) => {
      setIssuedToken({ name: result.apiKey.name, secret: result.secret })
      onIssued?.()
    })
  }

  /**
   * Reissues a token with a new expiry and keeps the new secret until dismissed.
   *
   * @param apiKey - Token to reissue.
   * @param expiresAt - New expiry.
   * @returns Whether the token was reissued.
   */
  function rotate(apiKey: ApiKeySummary, expiresAt: string) {
    const input = { expiresAt }
    return runMutation(`rotate:${apiKey.id}`, JSON.stringify(input), (context) =>
      rotatePersonalApiKey(accessToken, apiKey.id, input, context), (result) => {
      setIssuedToken({ name: result.apiKey.name, secret: result.secret })
    })
  }

  /**
   * Revokes a token.
   *
   * @param apiKey - Token to revoke.
   * @returns Whether the token was revoked.
   */
  function revoke(apiKey: ApiKeySummary) {
    return runMutation(`revoke:${apiKey.id}`, apiKey.id, (context) =>
      revokePersonalApiKey(accessToken, apiKey.id, context))
  }

  return {
    overview: data,
    hasLoadError: Boolean(error),
    isLoading,
    busyOperation,
    hasOperationError,
    issuedToken,
    dismissIssuedToken: () => setIssuedToken(undefined),
    reload: () => mutate(),
    issue,
    rotate,
    revoke,
  }
}
