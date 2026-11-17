import { createMutationRequestRunner, type MutationRequestRunner } from '../../shared/api/mutationHeaders'

/** Mutation runners of one Workspace access session, bound to one access token. */
export type WorkspaceAccessMutationSession = {
  /** Access token the session's mutations send. */
  accessToken: string
  /**
   * Runner of membership and invitation mutations. A successful refresh of the access snapshot
   * discards its retained contexts, because the snapshot shows their outcome.
   */
  requestRunner: MutationRequestRunner
  /**
   * Runner of administrator credential resets. It is kept apart so that a refresh never
   * discards the context of a reset whose outcome is unknown: a retry must send the same
   * idempotency key, or it could reset a password or app the member has set up since.
   */
  credentialResetRunner: MutationRequestRunner
}

/**
 * Creates the mutation runners of a Workspace access session.
 *
 * @param accessToken - Access token of the session.
 * @returns The session.
 */
export function createWorkspaceAccessMutationSession(accessToken: string): WorkspaceAccessMutationSession {
  return {
    accessToken,
    requestRunner: createMutationRequestRunner(),
    credentialResetRunner: createMutationRequestRunner(),
  }
}
