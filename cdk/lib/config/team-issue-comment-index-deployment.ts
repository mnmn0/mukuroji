/** Ordered rollout stages for the retained Team Issue event table GSIs. */
export type TeamIssueCommentIndexDeploymentStage = 'event' | 'comment'

/** First deploy-safe stage that adds only the event timestamp GSI. */
export const DEFAULT_TEAM_ISSUE_COMMENT_INDEX_DEPLOYMENT_STAGE:
  TeamIssueCommentIndexDeploymentStage = 'event'

/**
 * Validates the explicitly selected Team Issue comment index rollout stage.
 *
 * @param value - Optional CDK context or stack property value.
 * @returns The validated stage, defaulting to the first one-index deployment.
 */
export function resolveTeamIssueCommentIndexDeploymentStage(
  value: unknown,
): TeamIssueCommentIndexDeploymentStage {
  if (value === undefined) return DEFAULT_TEAM_ISSUE_COMMENT_INDEX_DEPLOYMENT_STAGE
  if (value === 'event' || value === 'comment') return value
  throw new Error(
    'teamIssueCommentIndexDeploymentStage must be one of event or comment.',
  )
}

/**
 * Requires an explicit production CDK rollout stage.
 *
 * @param value - CDK context value supplied to the production entrypoint.
 * @returns The validated explicit rollout stage.
 */
export function requireTeamIssueCommentIndexDeploymentStage(
  value: unknown,
): TeamIssueCommentIndexDeploymentStage {
  if (value === undefined) {
    throw new Error(
      'teamIssueCommentIndexDeploymentStage context is required to prevent an accidental Team Issue GSI rollback.',
    )
  }
  return resolveTeamIssueCommentIndexDeploymentStage(value)
}

/**
 * Determines whether a Team Issue event-table GSI is present at a rollout stage.
 *
 * @param stage - Current reviewed rollout stage.
 * @param index - GSI whose presence is being evaluated.
 * @returns Whether the stage includes the requested GSI.
 */
export function teamIssueCommentIndexDeploymentIncludes(
  stage: TeamIssueCommentIndexDeploymentStage,
  index: TeamIssueCommentIndexDeploymentStage,
): boolean {
  const order: Readonly<Record<TeamIssueCommentIndexDeploymentStage, number>> = {
    event: 0,
    comment: 1,
  }
  return order[stage] >= order[index]
}
