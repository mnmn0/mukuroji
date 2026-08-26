import type { AiAssistancePolicy, AiAssistanceTask } from '@mukuroji/contracts'

/** Environment values used to decide whether the AI assistance UI may mount. */
export type AiAssistanceRolloutEnvironment = Record<string, string | boolean | undefined>

/** Saved settings and session state used to gate one AI workflow in the UI. */
export type AiAssistanceTaskGate = {
  /** Whether the deployment build has explicitly opted into AI assistance. */
  rolloutEnabled: boolean
  /** Whether the current route has a verified authenticated Workspace member. */
  authenticated: boolean
  /** Personal preference value; undefined means it has not been loaded safely. */
  preferenceEnabled?: boolean
  /** Whether the active member may read the Workspace-wide AI policy. */
  canManagePolicy: boolean
  /** Workspace policy fields needed by the manager-side gate. */
  policy?: Pick<AiAssistancePolicy, 'enabled' | 'enabledTasks'>
}

/**
 * Resolves the explicit UI rollout flag for AI assistance.
 *
 * The flag defaults to disabled so a UI deployment cannot expose controls that
 * target an API route before the dependent backend deployment is live. The
 * backend-dependent UI is enabled by setting `VITE_AI_ASSISTANCE_ENABLED=true`.
 *
 * @param environment - Vite environment values available to the current build.
 * @returns Whether route-level AI assistance controls may be rendered.
 */
export function isAiAssistanceUiEnabled(
  environment: AiAssistanceRolloutEnvironment,
): boolean {
  return environment.VITE_AI_ASSISTANCE_ENABLED === true ||
    environment.VITE_AI_ASSISTANCE_ENABLED === 'true'
}

/**
 * Returns whether saved rollout, preference, and (when visible) policy permit a task.
 *
 * Non-managers cannot read the Workspace policy and therefore rely on the
 * server-side policy check; managers fail closed until their policy is loaded.
 *
 * @param task - AI workflow whose controls are being mounted.
 * @param gate - Verified route and saved-settings state.
 * @returns Whether the workflow may issue an explicit generation request.
 */
export function isAiAssistanceTaskEnabled(
  task: AiAssistanceTask,
  gate: AiAssistanceTaskGate,
): boolean {
  if (!gate.rolloutEnabled || !gate.authenticated || gate.preferenceEnabled !== true) {
    return false
  }
  if (!gate.canManagePolicy) return true
  return gate.policy?.enabled === true && gate.policy.enabledTasks.includes(task)
}

/** Explicit build-time rollout decision consumed by route-level integrations. */
export const aiAssistanceUiEnabled = isAiAssistanceUiEnabled(import.meta.env)
