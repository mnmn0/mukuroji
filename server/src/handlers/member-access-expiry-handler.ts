import { createLazySingleton } from '../app/composition/lazy-singleton'
import { createProductionMemberAccessExpiryRun } from '../app/composition/member-access-expiry'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'
import { hydrateWorkspaceAuditPseudonymSecret } from '../app/composition/workspace-audit-pseudonym-secret'

const getProductionRun = createLazySingleton(createProductionMemberAccessExpiryRun)
// The deactivation audit event pseudonymizes the member with the Workspace audit key.
const hydrateSecrets = hydrateWorkspaceAuditPseudonymSecret

/**
 * Deactivates the members whose access expiry has passed after admission.
 *
 * @returns Counts of the run.
 */
async function processMemberAccessExpiry() {
  // The Workspace access client reads the key when it is created, so secrets come first.
  await hydrateSecrets()
  return await getProductionRun()()
}

/**
 * Runtime-control guarded member access expiry entrypoint. It shares the notification schedule
 * scope, as the hourly membership job of the scheduled-jobs Lambda.
 */
export const handler = createRuntimeControlGuardedHandler(
  'notification-schedule',
  processMemberAccessExpiry,
)
