import { createMutationRequestRunner, type MutationRequestRunner } from '../../shared/api/mutationHeaders'

/** Mutation runner of one Workspace access session, bound to one access token. */
export type WorkspaceAccessMutationSession = {
  /** Access token the session's mutations send. */
  accessToken: string
  /**
   * Runner of membership and invitation mutations. A successful refresh of the access snapshot
   * discards its retained contexts, because the snapshot shows their outcome.
   */
  requestRunner: MutationRequestRunner
}

/**
 * Creates the mutation runner of a Workspace access session.
 *
 * @param accessToken - Access token of the session.
 * @returns The session.
 */
export function createWorkspaceAccessMutationSession(accessToken: string): WorkspaceAccessMutationSession {
  return {
    accessToken,
    requestRunner: createMutationRequestRunner(),
  }
}

/** Credential reset runners of this page, by the administrator's member key. */
const credentialResetRunners = new Map<string, MutationRequestRunner>()

/**
 * Returns the runner of an administrator's credential resets.
 *
 * Unlike the session runner, it outlives an access token refresh and a Workspace snapshot
 * refresh, and lasts as long as the page. A reset whose outcome is unknown must be retried with
 * the same idempotency key, or the retry could reset a password or app the member has set up
 * since. Each administrator gets their own runner, so another account signed in on the same
 * page never reuses their keys.
 *
 * @param administratorKey - Member key of the signed-in administrator.
 * @returns The administrator's runner.
 */
export function getCredentialResetRunner(administratorKey: string) {
  const existing = credentialResetRunners.get(administratorKey)
  if (existing) return existing
  const runner = createMutationRequestRunner()
  credentialResetRunners.set(administratorKey, runner)
  return runner
}

/** Bulk invitation runners of this page, by the administrator's member key. */
const bulkInvitationRunners = new Map<string, MutationRequestRunner>()

/**
 * Returns the runner of an administrator's bulk invitations.
 *
 * Unlike the session runner, a snapshot refresh after another mutation does not discard its
 * retained contexts: a row whose response was lost may still be running on the server, so a
 * retry of that row must reuse its idempotency key even after other changes on the page. Each
 * administrator gets their own runner, so another account signed in on the same page never
 * reuses their keys.
 *
 * @param administratorKey - Member key of the signed-in administrator.
 * @returns The administrator's runner.
 */
export function getBulkInvitationRunner(administratorKey: string) {
  const existing = bulkInvitationRunners.get(administratorKey)
  if (existing) return existing
  const runner = createMutationRequestRunner()
  bulkInvitationRunners.set(administratorKey, runner)
  return runner
}
