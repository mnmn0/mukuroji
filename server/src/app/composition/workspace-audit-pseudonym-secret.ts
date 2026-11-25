import { createWorkerSecretEnvironmentHydrator } from './worker-secret-environment'

/**
 * Restores `MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY` from its secret ARN once per process.
 *
 * The scheduled-jobs Lambda runs both the member access expiry job and the notification schedule,
 * and both name members by the Workspace audit pseudonym. They share this one hydrator, because a
 * second hydrator would find the value already restored next to its ARN and refuse it.
 */
export const hydrateWorkspaceAuditPseudonymSecret = createWorkerSecretEnvironmentHydrator([
  'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY',
])
