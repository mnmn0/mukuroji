/** Environment values used to decide whether the AI assistance UI may mount. */
export type AiAssistanceRolloutEnvironment = Record<string, string | boolean | undefined>

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

/** Explicit build-time rollout decision consumed by route-level integrations. */
export const aiAssistanceUiEnabled = isAiAssistanceUiEnabled(import.meta.env)
