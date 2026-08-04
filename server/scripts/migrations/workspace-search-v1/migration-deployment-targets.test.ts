import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION,
  type WorkspaceSearchMigrationDeploymentTargetDefinition,
} from '@mukuroji/contracts'
import {
  createWorkspaceSearchMigrationDeploymentTrustRoot,
  createWorkspaceSearchMigrationProductionAccountDigest,
  resolveWorkspaceSearchMigrationDeploymentTarget,
  resolveWorkspaceSearchMigrationRehearsalDeploymentTarget,
} from './migration-deployment-targets'

/** Digest independently fixed by the CDK consumer test. */
const disabledTrustRootDigest =
  '190a7f2354e9b1da737e48c9c32b8e54817ed5ca3666fae5bff4dcfda236f3ea'

/** Creates one explicit test-only enabled non-production target. */
function nonProductionDefinition(): WorkspaceSearchMigrationDeploymentTargetDefinition {
  return {
    targetId: 'test-rehearsal',
    version: WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION,
    environment: 'non-production',
    deploymentAccount: '111111111111',
    productionAccountDigest:
      createWorkspaceSearchMigrationProductionAccountDigest('999999999999'),
    region: 'ap-northeast-1',
    rehearsalEnabled: true,
  }
}

describe('shared Workspace Search migration deployment target data', () => {
  test('computes the exact same disabled trust root as the CDK consumer', () => {
    const target = resolveWorkspaceSearchMigrationDeploymentTarget(
      DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID,
    )

    expect(target.digest).toBe(disabledTrustRootDigest)
    expect(target.environment).toBe('production')
    expect(target.rehearsalEnabled).toBe(false)
    expect(Object.isFrozen(target)).toBe(true)
  })

  test('fails closed unless a source-controlled target is enabled', () => {
    expect(() => resolveWorkspaceSearchMigrationRehearsalDeploymentTarget(
      DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID,
    )).toThrow('rehearsal target is not enabled')
    expect(() => resolveWorkspaceSearchMigrationDeploymentTarget(
      'operator-defined-target',
    )).toThrow('Unknown Workspace Search migration deployment target')

    const enabled = createWorkspaceSearchMigrationDeploymentTrustRoot(
      nonProductionDefinition(),
    )
    expect(enabled).toMatchObject({
      deploymentAccount: '111111111111',
      environment: 'non-production',
      region: 'ap-northeast-1',
      rehearsalEnabled: true,
    })
  })
})
