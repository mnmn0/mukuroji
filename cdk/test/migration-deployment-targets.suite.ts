/** Registers source-controlled Workspace Search migration target tests. */
import { expect, test } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import {
  DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID,
  WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION,
  bindWorkspaceSearchMigrationStackEnvironment,
  createWorkspaceSearchMigrationDeploymentTrustRoot,
  createWorkspaceSearchMigrationProductionAccountDigest,
  resolveWorkspaceSearchMigrationDeploymentTarget,
  type WorkspaceSearchMigrationDeploymentTargetDefinition,
} from '../lib/config/workspace-search-migration-deployment-targets';
import { CdkStack } from '../lib/cdk-stack';
import { synthesizedTemplate } from './test-support';

/** Creates one explicit test-only non-production target definition. */
function createNonProductionTargetDefinition(
  overrides: Partial<WorkspaceSearchMigrationDeploymentTargetDefinition> = {},
): WorkspaceSearchMigrationDeploymentTargetDefinition {
  return {
    targetId: 'test-rehearsal',
    version: WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION,
    environment: 'non-production',
    deploymentAccount: '111111111111',
    productionAccountDigest:
      createWorkspaceSearchMigrationProductionAccountDigest(
        '999999999999',
      ),
    region: 'ap-northeast-1',
    rehearsalEnabled: true,
    ...overrides,
  };
}

test('normal resolution accepts only the source-controlled disabled production target', () => {
  const first = resolveWorkspaceSearchMigrationDeploymentTarget(
    DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID,
  );
  const second = resolveWorkspaceSearchMigrationDeploymentTarget(
    DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID,
  );

  expect(first).toEqual(second);
  expect(first).toEqual(expect.objectContaining({
    environment: 'production',
    rehearsalEnabled: false,
    targetId: 'production-disabled',
    version: 1,
  }));
  expect(first.digest).toMatch(/^[0-9a-f]{64}$/u);
  expect(first.digest).toBe(
    '190a7f2354e9b1da737e48c9c32b8e54817ed5ca3666fae5bff4dcfda236f3ea',
  );
  expect(first.productionAccountDigest).toMatch(/^[0-9a-f]{64}$/u);
  expect(Object.isFrozen(first)).toBe(true);

  expect(() => resolveWorkspaceSearchMigrationDeploymentTarget(
    'operator-defined-non-production',
  )).toThrow('Unknown Workspace Search migration deployment target.');
  expect(() => new CdkStack(new cdk.App(), 'UnknownTarget', {
    workspaceSearchMigrationDeploymentTargetId:
      'operator-defined-non-production',
  })).toThrow('Unknown Workspace Search migration deployment target.');
});

test('test-only non-production target roots are deterministic and tamper-sensitive', () => {
  const definition = createNonProductionTargetDefinition();
  const first = createWorkspaceSearchMigrationDeploymentTrustRoot(definition);
  const second = createWorkspaceSearchMigrationDeploymentTrustRoot(definition);
  const changedRegion = createWorkspaceSearchMigrationDeploymentTrustRoot(
    createNonProductionTargetDefinition({ region: 'us-east-1' }),
  );
  const changedAccount = createWorkspaceSearchMigrationDeploymentTrustRoot(
    createNonProductionTargetDefinition({
      deploymentAccount: '222222222222',
    }),
  );
  const changedProductionAccount =
    createWorkspaceSearchMigrationDeploymentTrustRoot(
      createNonProductionTargetDefinition({
        productionAccountDigest:
          createWorkspaceSearchMigrationProductionAccountDigest(
            '888888888888',
          ),
      }),
    );

  expect(first).toEqual(second);
  expect(changedRegion.digest).not.toBe(first.digest);
  expect(changedAccount.digest).not.toBe(first.digest);
  expect(changedAccount.productionAccountDigest).toBe(
    first.productionAccountDigest,
  );
  expect(changedProductionAccount.digest).not.toBe(first.digest);
});

test('rejects incomplete isolation and mismatched stack account or Region', () => {
  for (const definition of [
    createNonProductionTargetDefinition({
      productionAccountDigest:
        createWorkspaceSearchMigrationProductionAccountDigest(
          '111111111111',
        ),
    }),
    createNonProductionTargetDefinition({
      deploymentAccount: '000000000000',
    }),
    createNonProductionTargetDefinition({ region: 'not-a-region' }),
    createNonProductionTargetDefinition({ rehearsalEnabled: false }),
    createNonProductionTargetDefinition({ environment: 'production' }),
  ]) {
    expect(() => createWorkspaceSearchMigrationDeploymentTrustRoot(
      definition,
    )).toThrow();
  }

  const trustRoot = createWorkspaceSearchMigrationDeploymentTrustRoot(
    createNonProductionTargetDefinition(),
  );
  expect(bindWorkspaceSearchMigrationStackEnvironment(trustRoot)).toEqual({
    account: '111111111111',
    region: 'ap-northeast-1',
  });
  expect(() => bindWorkspaceSearchMigrationStackEnvironment(trustRoot, {
    account: '222222222222',
    region: 'ap-northeast-1',
  })).toThrow('stack account does not match');
  expect(() => bindWorkspaceSearchMigrationStackEnvironment(trustRoot, {
    account: '111111111111',
    region: 'us-east-1',
  })).toThrow('stack Region does not match');
});

test('template removes free-form migration trust parameters and publishes the root', () => {
  const template = synthesizedTemplate.toJSON();

  expect(template.Parameters.WorkspaceSearchMigrationEnvironment)
    .toBeUndefined();
  expect(template.Parameters.WorkspaceSearchMigrationProductionAccountId)
    .toBeUndefined();
  expect(template.Rules.WorkspaceSearchMigrationAccountSeparation)
    .toBeUndefined();
  expect(
    template.Outputs.WorkspaceSearchMigrationDeploymentTargetId.Value,
  ).toBe('production-disabled');
  expect(
    template.Outputs.WorkspaceSearchMigrationDeploymentTrustVersion.Value,
  ).toBe('1');
  expect(
    template.Outputs.WorkspaceSearchMigrationDeploymentTrustRootDigest.Value,
  ).toMatch(/^[0-9a-f]{64}$/u);
  expect(
    template.Outputs.WorkspaceSearchMigrationProductionAccountDigest.Value,
  ).toMatch(/^[0-9a-f]{64}$/u);
  expect(JSON.stringify(template)).not.toContain(
    '"Key":"mukuroji:workspace-search-migration-production-account","Value"',
  );
});
