import { createHash } from 'node:crypto'
import {
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_DEFINITIONS,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_ROOT_DIGEST_DOMAIN,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION,
  WORKSPACE_SEARCH_MIGRATION_DISABLED_ACCOUNT,
  WORKSPACE_SEARCH_MIGRATION_DISABLED_REGION,
  WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_DOMAIN,
  type WorkspaceSearchMigrationDeploymentTargetDefinition,
} from '@mukuroji/contracts'

/** Validated deployment target plus its canonical trust-root digest. */
export type WorkspaceSearchMigrationDeploymentTrustRoot =
  WorkspaceSearchMigrationDeploymentTargetDefinition & {
    /** SHA-256 of the canonical versioned target claims. */
    readonly digest: string
  }

/** Enabled concrete non-production target admitted to rehearsal preflight. */
export type WorkspaceSearchMigrationRehearsalDeploymentTrustRoot =
  WorkspaceSearchMigrationDeploymentTrustRoot & {
    /** Fixed non-production classification. */
    readonly environment: 'non-production'
    /** Explicit source-controlled rehearsal enablement. */
    readonly rehearsalEnabled: true
  }

/** Conservative identifier syntax for source-controlled deployment targets. */
const deploymentTargetIdPattern = /^[a-z][a-z0-9-]{0,62}$/u

/** Exact twelve-digit AWS account syntax. */
const awsAccountPattern = /^\d{12}$/u

/** Conservative explicit AWS Region syntax. */
const awsRegionPattern =
  /^[a-z]{2}(?:-gov)?-[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*$/u

/**
 * Resolves a target only from the repository-owned shared definitions map.
 *
 * @param targetId - Exact source-controlled target identifier.
 * @returns Validated immutable deployment trust root.
 */
export function resolveWorkspaceSearchMigrationDeploymentTarget(
  targetId: string,
): WorkspaceSearchMigrationDeploymentTrustRoot {
  const definition =
    WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_DEFINITIONS[targetId]
  if (definition === undefined) {
    throw new Error('Unknown Workspace Search migration deployment target.')
  }
  return createWorkspaceSearchMigrationDeploymentTrustRoot(definition)
}

/**
 * Resolves only an explicitly enabled concrete non-production target.
 *
 * @param targetId - Exact source-controlled target identifier.
 * @returns Validated target safe for rehearsal-only preflight composition.
 */
export function resolveWorkspaceSearchMigrationRehearsalDeploymentTarget(
  targetId: string,
): WorkspaceSearchMigrationRehearsalDeploymentTrustRoot {
  const target = resolveWorkspaceSearchMigrationDeploymentTarget(targetId)
  if (
    target.environment !== 'non-production' ||
    target.rehearsalEnabled !== true
  ) {
    throw new Error(
      'Workspace Search migration rehearsal target is not enabled.',
    )
  }
  return Object.freeze({
    targetId: target.targetId,
    version: target.version,
    environment: 'non-production',
    deploymentAccount: target.deploymentAccount,
    productionAccountDigest: target.productionAccountDigest,
    region: target.region,
    rehearsalEnabled: true,
    digest: target.digest,
  })
}

/**
 * Validates canonical reviewed target claims and creates their trust root.
 *
 * @param definition - Complete source-like versioned target definition.
 * @returns Validated immutable target and canonical digest.
 */
export function createWorkspaceSearchMigrationDeploymentTrustRoot(
  definition: WorkspaceSearchMigrationDeploymentTargetDefinition,
): WorkspaceSearchMigrationDeploymentTrustRoot {
  validateWorkspaceSearchMigrationDeploymentTarget(definition)
  const canonicalClaims = Object.freeze({
    deploymentAccount: definition.deploymentAccount,
    environment: definition.environment,
    productionAccountDigest: definition.productionAccountDigest,
    region: definition.region,
    rehearsalEnabled: definition.rehearsalEnabled,
    targetId: definition.targetId,
    version: definition.version,
  })
  const digest = createHash('sha256')
    .update(
      WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_ROOT_DIGEST_DOMAIN,
      'utf8',
    )
    .update(JSON.stringify(canonicalClaims), 'utf8')
    .digest('hex')
  return Object.freeze({ ...canonicalClaims, digest })
}

/**
 * Creates the shared domain-separated production-account digest.
 *
 * @param account - Exact reviewed twelve-digit production account.
 * @returns Lowercase SHA-256 digest safe for source-controlled comparison.
 */
export function createWorkspaceSearchMigrationProductionAccountDigest(
  account: string,
): string {
  if (!awsAccountPattern.test(account) || account === '000000000000') {
    throw new Error('Production account identifier is invalid.')
  }
  return digestProductionAccount(account)
}

/**
 * Validates disabled production and enabled isolated non-production targets.
 *
 * @param definition - Candidate typed source-controlled target definition.
 */
function validateWorkspaceSearchMigrationDeploymentTarget(
  definition: WorkspaceSearchMigrationDeploymentTargetDefinition,
): void {
  if (
    !deploymentTargetIdPattern.test(definition.targetId) ||
    definition.version !==
      WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION
  ) {
    throw new Error('Workspace Search migration deployment target is invalid.')
  }
  if (definition.environment === 'production') {
    if (
      definition.rehearsalEnabled ||
      definition.deploymentAccount !==
        WORKSPACE_SEARCH_MIGRATION_DISABLED_ACCOUNT ||
      definition.productionAccountDigest !== digestProductionAccount(
        WORKSPACE_SEARCH_MIGRATION_DISABLED_ACCOUNT,
      ) ||
      definition.region !== WORKSPACE_SEARCH_MIGRATION_DISABLED_REGION
    ) {
      throw new Error(
        'The default production target must remain rehearsal-disabled.',
      )
    }
    return
  }
  if (
    definition.environment !== 'non-production' ||
    !definition.rehearsalEnabled ||
    !awsAccountPattern.test(definition.deploymentAccount) ||
    definition.deploymentAccount === '000000000000' ||
    !/^[0-9a-f]{64}$/u.test(definition.productionAccountDigest) ||
    digestProductionAccount(definition.deploymentAccount) ===
      definition.productionAccountDigest ||
    !awsRegionPattern.test(definition.region)
  ) {
    throw new Error(
      'A non-production migration target requires distinct concrete accounts and an explicit Region.',
    )
  }
}

/**
 * Hashes an already controlled production-account representation.
 *
 * @param account - Concrete account or the disabled production sentinel.
 * @returns Domain-separated lowercase SHA-256 digest.
 */
function digestProductionAccount(account: string): string {
  return createHash('sha256')
    .update(
      WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_DOMAIN,
      'utf8',
    )
    .update(account, 'utf8')
    .digest('hex')
}
