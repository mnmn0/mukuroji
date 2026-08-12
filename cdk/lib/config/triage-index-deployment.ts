/** Ordered rollout stages for the retained Request Intake table's Triage indexes. */
export type TriageIndexDeploymentStage = 'team' | 'owner' | 'wake';

/** First deploy-safe stage that adds only one GSI to an existing table. */
export const DEFAULT_TRIAGE_INDEX_DEPLOYMENT_STAGE: TriageIndexDeploymentStage =
  'team';

/**
 * Validates the explicitly selected Triage index rollout stage.
 *
 * @param value - Optional CDK context or stack property value.
 * @returns The validated stage, defaulting to the one-index first deployment.
 */
export function resolveTriageIndexDeploymentStage(
  value: unknown,
): TriageIndexDeploymentStage {
  if (value === undefined) return DEFAULT_TRIAGE_INDEX_DEPLOYMENT_STAGE;
  if (value === 'team' || value === 'owner' || value === 'wake') {
    return value;
  }
  throw new Error(
    'triageIndexDeploymentStage must be one of team, owner, or wake.',
  );
}

/**
 * Requires an explicit production CDK rollout stage.
 *
 * @param value - CDK context value supplied to the production entrypoint.
 * @returns The validated explicit rollout stage.
 */
export function requireTriageIndexDeploymentStage(
  value: unknown,
): TriageIndexDeploymentStage {
  if (value === undefined) {
    throw new Error(
      'triageIndexDeploymentStage context is required to prevent an accidental Triage GSI rollback.',
    );
  }
  return resolveTriageIndexDeploymentStage(value);
}

/**
 * Determines whether one index is present at a reviewed rollout stage.
 *
 * @param stage - Current reviewed rollout stage.
 * @param index - Triage index whose presence is being evaluated.
 * @returns Whether the stage includes the requested index.
 */
export function triageIndexDeploymentIncludes(
  stage: TriageIndexDeploymentStage,
  index: TriageIndexDeploymentStage,
): boolean {
  const order: Readonly<Record<TriageIndexDeploymentStage, number>> = {
    team: 0,
    owner: 1,
    wake: 2,
  };
  return order[stage] >= order[index];
}
