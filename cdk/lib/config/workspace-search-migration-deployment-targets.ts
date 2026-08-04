import { createHash } from 'node:crypto';
import {
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_DEFINITIONS,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_ROOT_DIGEST_DOMAIN,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION,
  WORKSPACE_SEARCH_MIGRATION_DISABLED_ACCOUNT,
  WORKSPACE_SEARCH_MIGRATION_DISABLED_REGION,
  WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_DOMAIN,
  type WorkspaceSearchMigrationDeploymentTargetDefinition,
} from '@mukuroji/contracts/workspace-search-migration-deployment-target';

export {
  DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION,
  WORKSPACE_SEARCH_MIGRATION_DISABLED_ACCOUNT,
  WORKSPACE_SEARCH_MIGRATION_DISABLED_REGION,
  WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_DOMAIN,
} from '@mukuroji/contracts/workspace-search-migration-deployment-target';
export type {
  WorkspaceSearchMigrationDeploymentEnvironment,
  WorkspaceSearchMigrationDeploymentTargetDefinition,
} from '@mukuroji/contracts/workspace-search-migration-deployment-target';

/** Validated deployment target plus its canonical trust-root digest. */
export type WorkspaceSearchMigrationDeploymentTrustRoot =
  WorkspaceSearchMigrationDeploymentTargetDefinition & {
    /** SHA-256 of the canonical versioned target claims. */
    readonly digest: string;
  };

/** Optional stack environment supplied before reviewed target binding. */
export type WorkspaceSearchMigrationStackEnvironment = {
  /** Candidate concrete AWS account. */
  readonly account?: string;
  /** Candidate concrete AWS Region. */
  readonly region?: string;
};

/** Conservative identifier syntax for source-controlled deployment targets. */
const deploymentTargetIdPattern = /^[a-z][a-z0-9-]{0,62}$/u;

/** Exact twelve-digit AWS account syntax. */
const awsAccountPattern = /^\d{12}$/u;

/** Conservative explicit AWS Region syntax. */
const awsRegionPattern =
  /^[a-z]{2}(?:-gov)?-[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*$/u;

/**
 * Resolves a target only from the repository-owned reviewed target map.
 *
 * Adding a real target therefore requires a reviewed source change. A free-form
 * CDK context value can select an existing target but cannot define or enable one.
 *
 * @param targetId - Exact source-controlled target identifier.
 * @returns Validated immutable deployment trust root.
 */
export function resolveWorkspaceSearchMigrationDeploymentTarget(
  targetId: string,
): WorkspaceSearchMigrationDeploymentTrustRoot {
  const definition =
    WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_DEFINITIONS[targetId];
  if (definition === undefined) {
    throw new Error(
      'Unknown Workspace Search migration deployment target.',
    );
  }
  return createWorkspaceSearchMigrationDeploymentTrustRoot(definition);
}

/**
 * Validates canonical reviewed target claims and creates their trust root.
 *
 * This constructor is exported for explicit CDK unit-test fixtures and for a
 * future source-reviewed target-map entry. It accepts no environment variables,
 * CloudFormation parameters, or untyped context payload.
 *
 * @param definition - Complete source-like versioned target definition.
 * @returns Validated immutable deployment trust root.
 */
export function createWorkspaceSearchMigrationDeploymentTrustRoot(
  definition: WorkspaceSearchMigrationDeploymentTargetDefinition,
): WorkspaceSearchMigrationDeploymentTrustRoot {
  validateWorkspaceSearchMigrationDeploymentTarget(definition);
  const canonicalClaims = Object.freeze({
    deploymentAccount: definition.deploymentAccount,
    environment: definition.environment,
    productionAccountDigest: definition.productionAccountDigest,
    region: definition.region,
    rehearsalEnabled: definition.rehearsalEnabled,
    targetId: definition.targetId,
    version: definition.version,
  });
  const digest = createHash('sha256')
    .update(
      WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_ROOT_DIGEST_DOMAIN,
      'utf8',
    )
    .update(JSON.stringify(canonicalClaims), 'utf8')
    .digest('hex');
  return Object.freeze({
    ...canonicalClaims,
    digest,
  });
}

/**
 * Creates the exact domain-separated digest stored for a production account.
 *
 * @param account - Exact reviewed twelve-digit production account identifier.
 * @returns Lowercase SHA-256 digest safe for source control and templates.
 */
export function createWorkspaceSearchMigrationProductionAccountDigest(
  account: string,
): string {
  if (!awsAccountPattern.test(account) || account === '000000000000') {
    throw new Error('Production account identifier is invalid.');
  }
  return digestProductionAccount(account);
}

/**
 * Fixes an enabled rehearsal stack to its source-controlled account and Region.
 *
 * A supplied environment may omit both values, but any supplied value must
 * already match the reviewed target. The returned non-production environment
 * is always concrete and cannot inherit ambient CDK defaults.
 *
 * @param trustRoot - Validated reviewed deployment trust root.
 * @param environment - Optional caller-supplied stack environment.
 * @returns Environment that may be passed to the CDK Stack constructor.
 */
export function bindWorkspaceSearchMigrationStackEnvironment(
  trustRoot: WorkspaceSearchMigrationDeploymentTrustRoot,
  environment: WorkspaceSearchMigrationStackEnvironment = {},
): WorkspaceSearchMigrationStackEnvironment {
  if (!trustRoot.rehearsalEnabled) {
    return Object.freeze({ ...environment });
  }
  if (
    environment.account !== undefined &&
    environment.account !== trustRoot.deploymentAccount
  ) {
    throw new Error(
      'The stack account does not match the reviewed migration deployment target.',
    );
  }
  if (
    environment.region !== undefined &&
    environment.region !== trustRoot.region
  ) {
    throw new Error(
      'The stack Region does not match the reviewed migration deployment target.',
    );
  }
  return Object.freeze({
    account: trustRoot.deploymentAccount,
    region: trustRoot.region,
  });
}

/**
 * Validates fail-closed production and concrete isolated non-production targets.
 *
 * @param definition - Candidate typed source-controlled target definition.
 * @returns Nothing.
 */
function validateWorkspaceSearchMigrationDeploymentTarget(
  definition: WorkspaceSearchMigrationDeploymentTargetDefinition,
): void {
  if (
    !deploymentTargetIdPattern.test(definition.targetId) ||
    definition.version !==
      WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION
  ) {
    throw new Error('Workspace Search migration deployment target is invalid.');
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
      );
    }
    return;
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
    );
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
    .update(WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_DOMAIN, 'utf8')
    .update(account, 'utf8')
    .digest('hex');
}
