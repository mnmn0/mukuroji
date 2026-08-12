/** Current schema version of reviewed Workspace Search migration targets. */
export const WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION = 1

/** Source-controlled target selected when no reviewed target is requested. */
export const DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID =
  'production-disabled'

/** Symbolic account used by the deployment-agnostic disabled target. */
export const WORKSPACE_SEARCH_MIGRATION_DISABLED_ACCOUNT = 'AWS::AccountId'

/** Symbolic Region used by the deployment-agnostic disabled target. */
export const WORKSPACE_SEARCH_MIGRATION_DISABLED_REGION = 'AWS::Region'

/** Domain separating a deployment trust root from every other digest. */
export const WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_ROOT_DIGEST_DOMAIN =
  'mukuroji-workspace-search-migration-deployment-trust-root/v1\0'

/** Domain separating a production-account projection from other digests. */
export const WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_DOMAIN =
  'mukuroji-workspace-search-migration-production-account/v1\0'

/** Supported environments for Workspace Search migration resources. */
export type WorkspaceSearchMigrationDeploymentEnvironment =
  | 'non-production'
  | 'production'

/** Canonical source-controlled claims for one reviewed deployment target. */
export type WorkspaceSearchMigrationDeploymentTargetDefinition = {
  /** Stable source-controlled target identifier. */
  readonly targetId: string
  /** Deployment-target schema version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION
  /** Exact environment classification. */
  readonly environment: WorkspaceSearchMigrationDeploymentEnvironment
  /** Exact deployment account, or the disabled production sentinel. */
  readonly deploymentAccount: string
  /** Domain-separated digest of the exact protected production account. */
  readonly productionAccountDigest: string
  /** Exact deployment Region, or the disabled production sentinel. */
  readonly region: string
  /** Whether the reviewed target may run rehearsal-only operations. */
  readonly rehearsalEnabled: boolean
}

/**
 * Repository-owned deployment targets accepted by every consumer.
 *
 * A real non-production target can be enabled only by adding a fully reviewed
 * frozen definition here, so CDK and server preflight cannot select different
 * accounts or Regions from ambient configuration.
 */
export const WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_DEFINITIONS: Readonly<
  Record<string, WorkspaceSearchMigrationDeploymentTargetDefinition>
> = Object.freeze({
    [DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID]: Object.freeze({
      targetId: DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID,
      version: WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION,
      environment: 'production',
      deploymentAccount: WORKSPACE_SEARCH_MIGRATION_DISABLED_ACCOUNT,
      productionAccountDigest:
        '7dab946a4c33ab11e64196426288ef5bccc897736aebb8f9e256f0f00ee7caca',
      region: WORKSPACE_SEARCH_MIGRATION_DISABLED_REGION,
      rehearsalEnabled: false,
    }),
})
