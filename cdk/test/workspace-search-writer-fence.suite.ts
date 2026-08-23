/** Registers regression coverage for the retired Workspace Search writer fence. */
import { expect, test } from '@jest/globals';
import { synthesizedTemplate } from './test-support';

test('does not synthesize the retired writer-fence gate or application IAM', () => {
  const synthesized = synthesizedTemplate.toJSON();
  const serialized = JSON.stringify(synthesized);
  const migrationStateTableId = synthesized.Outputs
    .WorkspaceSearchMigrationStateTableName?.Value?.Ref;

  expect(synthesized.Parameters.WorkspaceSearchWriterFenceMode).toBeUndefined();
  expect(serialized)
    .not.toContain('MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE');
  expect(serialized)
    .not.toContain('WORKSPACE_SEARCH_MIGRATION_STATE_TABLE_NAME');
  expect(typeof migrationStateTableId).toBe('string');
  if (typeof migrationStateTableId !== 'string') {
    throw new Error('Workspace Search migration state table output is missing.');
  }

  const applicationRolePrefixes = [
    'CollaborationProjectionFunctionServiceRole',
    'ListProjectTasksFunctionServiceRole',
    'EnterpriseScimGroupJobFunctionServiceRole',
    'WorkItemImportFunctionServiceRole',
    'AutomationEventFunctionServiceRole',
    'AutomationScheduleFunctionServiceRole',
    'WebhookDeliveryFunctionServiceRole',
    'ConnectorSyncFunctionServiceRole',
    'ConnectorPollFunctionServiceRole',
    'AnalyticsScheduleFunctionServiceRole',
  ];
  const applicationRoleIds = Object.keys(
    synthesizedTemplate.findResources('AWS::IAM::Role'),
  ).filter((logicalId) =>
    applicationRolePrefixes.some((prefix) => logicalId.startsWith(prefix))
  );
  expect(applicationRoleIds).toHaveLength(applicationRolePrefixes.length);

  const stateAwareApplicationPolicies = Object.values(
    synthesizedTemplate.findResources('AWS::IAM::Policy'),
  ).filter((policy) => {
    const serializedPolicy = JSON.stringify(policy);
    return serializedPolicy.includes(migrationStateTableId) &&
      applicationRoleIds.some((roleId) =>
        serializedPolicy.includes(`"Ref":"${roleId}"`)
      );
  });
  expect(stateAwareApplicationPolicies).toEqual([]);
});

test('retains conditional Workspace Search projection IAM', () => {
  const synthesized = synthesizedTemplate.toJSON();
  const workspaceSearchTableId = synthesized.Outputs
    .WorkspaceSearchTableName?.Value?.Ref;
  expect(typeof workspaceSearchTableId).toBe('string');
  if (typeof workspaceSearchTableId !== 'string') {
    throw new Error('Workspace Search table output is missing.');
  }

  const projectionPolicies = Object.entries(
    synthesizedTemplate.findResources('AWS::IAM::Policy'),
  ).filter(([logicalId]) =>
    logicalId.startsWith(
      'CollaborationProjectionFunctionServiceRoleDefaultPolicy',
    )
  );
  expect(projectionPolicies).toHaveLength(1);
  const statements = projectionPolicies.flatMap(([, policy]) =>
    policy.Properties?.PolicyDocument?.Statement ?? []
  );
  const projectionStatement = statements.find((statement: unknown) => {
    if (typeof statement !== 'object' || statement === null) return false;
    const action = Reflect.get(statement, 'Action');
    const actions = Array.isArray(action) ? action : [action];
    return actions.includes('dynamodb:PutItem') &&
      actions.includes('dynamodb:DeleteItem') &&
      JSON.stringify(Reflect.get(statement, 'Resource'))
        .includes(workspaceSearchTableId);
  });

  expect(projectionStatement).toEqual(expect.objectContaining({
    Condition: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
    Effect: 'Allow',
  }));
});
