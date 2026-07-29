/** Registers Workspace Search application writer-fence infrastructure tests. */
import { expect, test } from '@jest/globals';
import {
  API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
  API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
  findApiRuntimeConfigurationSource,
  synthesizedTemplate,
} from './test-support';

/** Exact application writer Lambda and execution-role construct prefixes. */
const writerFunctions: ReadonlyArray<readonly [string, string]> = [
  [
    'ListProjectTasksFunction2134AF4A',
    'ListProjectTasksFunctionServiceRole',
  ],
  [
    'EnterpriseScimGroupJobFunction351DCF72',
    'EnterpriseScimGroupJobFunctionServiceRole',
  ],
  [
    'WorkItemImportFunction651B2883',
    'WorkItemImportFunctionServiceRole',
  ],
  [
    'AutomationEventFunction5E8CB543',
    'AutomationEventFunctionServiceRole',
  ],
  [
    'AutomationScheduleFunction29B41328',
    'AutomationScheduleFunctionServiceRole',
  ],
  [
    'WebhookAuthorizationBackfillFunction5ABBA705',
    'WebhookAuthorizationBackfillFunctionServiceRole',
  ],
  [
    'WebhookAuthorizationBackfillProgressFunction1FF04FD2',
    'WebhookAuthorizationBackfillProgressFunctionServiceRole',
  ],
  [
    'WebhookDeliveryFunctionEA305509',
    'WebhookDeliveryFunctionServiceRole',
  ],
  [
    'ConnectorSyncFunctionA70281DA',
    'ConnectorSyncFunctionServiceRole',
  ],
];

/** Strict writer-client compositions that do not write fenced tables. */
const configurationOnlyFunctions: ReadonlyArray<
  readonly [string, string]
> = [
  [
    'CollaborationProjectionFunction1AAC5764',
    'CollaborationProjectionFunctionServiceRole',
  ],
  [
    'ConnectorPollFunctionB3EBB19B',
    'ConnectorPollFunctionServiceRole',
  ],
  [
    'AnalyticsScheduleFunctionBB9E6044',
    'AnalyticsScheduleFunctionServiceRole',
  ],
];

/** Every Lambda whose composition constructs a strict writer client. */
const strictConfigurationFunctions: ReadonlyArray<
  readonly [string, string]
> = [
  ...writerFunctions,
  ...configurationOnlyFunctions,
];

const apiFunctionLogicalId = 'ListProjectTasksFunction2134AF4A';
const directlyConfiguredStrictFunctions = strictConfigurationFunctions
  .filter(([functionLogicalId]) =>
    functionLogicalId !== apiFunctionLogicalId
  );

/**
 * Finds one synthesized resource by its stable construct prefix and type.
 *
 * @param logicalIdPrefix - Stable logical-ID prefix to locate.
 * @param resourceType - Exact CloudFormation resource type.
 * @returns Exact synthesized logical ID.
 */
function requireResourceId(
  logicalIdPrefix: string,
  resourceType: string,
): string {
  const logicalId = Object.keys(
    synthesizedTemplate.findResources(resourceType),
  ).find((candidate) => candidate.startsWith(logicalIdPrefix));
  if (!logicalId) {
    throw new Error(`${logicalIdPrefix} ${resourceType} was not synthesized.`);
  }
  return logicalId;
}

/**
 * Finds every Lambda configured with one environment variable.
 *
 * @param variableName - Exact environment-variable name.
 * @returns Sorted Lambda logical IDs containing the variable.
 */
function findLambdaIdsWithEnvironmentVariable(
  variableName: string,
): string[] {
  return Object.entries(
    synthesizedTemplate.findResources('AWS::Lambda::Function'),
  )
    .filter(([, resource]) =>
      resource.Properties?.Environment?.Variables?.[variableName] !==
        undefined
    )
    .map(([logicalId]) => logicalId)
    .sort();
}

/**
 * Reads one property from an unknown synthesized template value.
 *
 * @param value - Unknown template fragment.
 * @param propertyName - Exact property name to read.
 * @returns The property value, or undefined for a non-object fragment.
 */
function readProperty(
  value: unknown,
  propertyName: string,
): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return Reflect.get(value, propertyName);
}

/**
 * Reads the statements from the inline policy attached to one execution role.
 *
 * @param roleLogicalId - Exact Lambda execution-role logical ID.
 * @returns Synthesized IAM policy statements for the role.
 */
function requirePolicyStatementsForRole(
  roleLogicalId: string,
): readonly unknown[] {
  const policy = Object.values(
    synthesizedTemplate.findResources('AWS::IAM::Policy'),
  ).find((candidate) => {
    const properties = readProperty(candidate, 'Properties');
    return JSON.stringify(readProperty(properties, 'Roles'))
      .includes(`"Ref":"${roleLogicalId}"`);
  });
  if (!policy) {
    throw new Error(`Inline policy for ${roleLogicalId} was not synthesized.`);
  }
  const properties = readProperty(policy, 'Properties');
  const policyDocument = readProperty(properties, 'PolicyDocument');
  const statements = readProperty(policyDocument, 'Statement');
  if (!Array.isArray(statements)) {
    throw new Error(`Inline policy for ${roleLogicalId} has no statements.`);
  }
  return statements;
}

/**
 * Tests whether one IAM statement contains an exact action.
 *
 * @param statement - Unknown synthesized IAM statement.
 * @param action - Exact IAM action.
 * @returns True when the statement grants the action.
 */
function statementHasAction(
  statement: unknown,
  action: string,
): boolean {
  const actions = readProperty(statement, 'Action');
  return actions === action ||
    (Array.isArray(actions) && actions.includes(action));
}

/**
 * Tests whether one IAM statement targets an exact synthesized resource.
 *
 * @param statement - Unknown synthesized IAM statement.
 * @param resource - Exact CloudFormation resource expression.
 * @returns True when the statement includes the resource.
 */
function statementHasResource(
  statement: unknown,
  resource: Readonly<Record<string, unknown>>,
): boolean {
  const configured = readProperty(statement, 'Resource');
  const resources = Array.isArray(configured) ? configured : [configured];
  const expected = JSON.stringify(resource);
  return resources.some((candidate) => JSON.stringify(candidate) === expected);
}

test('strict writer-client compositions receive canonical tables and the explicit rollout parameter', () => {
  const parameters = synthesizedTemplate.toJSON().Parameters;
  const resources = synthesizedTemplate.toJSON().Resources;
  const expectedDirectConfigurationIds = directlyConfiguredStrictFunctions
    .map(([functionLogicalId]) => functionLogicalId)
    .sort();
  const projectDirectoryTableId = requireResourceId(
    'ProjectDirectoryTable',
    'AWS::DynamoDB::Table',
  );
  const workItemsTableId = requireResourceId(
    'TeamIssuesTable',
    'AWS::DynamoDB::Table',
  );
  const collaborationTableId = requireResourceId(
    'WorkItemCollaborationTable',
    'AWS::DynamoDB::Table',
  );
  const documentsTableId = requireResourceId(
    'DocumentsTable',
    'AWS::DynamoDB::Table',
  );
  const workspaceSearchTableId = requireResourceId(
    'WorkspaceSearchTable',
    'AWS::DynamoDB::Table',
  );
  const migrationStateTableId = requireResourceId(
    'WorkspaceSearchMigrationStateTable',
    'AWS::DynamoDB::Table',
  );

  expect(findLambdaIdsWithEnvironmentVariable(
    'MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE',
  )).toEqual(expectedDirectConfigurationIds);
  expect(findLambdaIdsWithEnvironmentVariable(
    'WORKSPACE_SEARCH_MIGRATION_STATE_TABLE_NAME',
  )).toEqual(expectedDirectConfigurationIds);
  expect(parameters.WorkspaceSearchWriterFenceMode).toEqual({
    AllowedValues: ['rollout-pending', 'required'],
    Description:
      'Explicit writer-fence rollout phase. Use rollout-pending only while AppConfig is disabled and writers are drained before the first open-row bootstrap; use required after bootstrap.',
    Type: 'String',
  });

  for (const [functionLogicalId] of directlyConfiguredStrictFunctions) {
    expect(
      resources[functionLogicalId].Properties.Environment.Variables,
    ).toEqual(expect.objectContaining({
      COLLABORATION_TABLE_NAME: { Ref: collaborationTableId },
      DOCUMENTS_TABLE_NAME: { Ref: documentsTableId },
      MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: {
        Ref: 'WorkspaceSearchWriterFenceMode',
      },
      PROJECT_DIRECTORY_TABLE_NAME: { Ref: projectDirectoryTableId },
      WORKSPACE_SEARCH_MIGRATION_STATE_TABLE_NAME: {
        Ref: migrationStateTableId,
      },
      WORKSPACE_SEARCH_TABLE_NAME: { Ref: workspaceSearchTableId },
      WORK_ITEMS_TABLE_NAME: { Ref: workItemsTableId },
    }));
  }

  const coreConfigurationSecretId =
    API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID;
  const dataConfigurationSecretId =
    API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID;
  const coreConfiguration = resources[coreConfigurationSecretId]
    .Properties.SecretString;
  const dataConfiguration = resources[dataConfigurationSecretId]
    .Properties.SecretString;
  expect(findApiRuntimeConfigurationSource(
    coreConfiguration,
    'MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE',
  )).toEqual({
      'Fn::Base64': { Ref: 'WorkspaceSearchWriterFenceMode' },
    });
  const expectedDataSources: Readonly<Record<string, string>> = {
    COLLABORATION_TABLE_NAME: collaborationTableId,
    DOCUMENTS_TABLE_NAME: documentsTableId,
    PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTableId,
    WORKSPACE_SEARCH_MIGRATION_STATE_TABLE_NAME: migrationStateTableId,
    WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTableId,
    WORK_ITEMS_TABLE_NAME: workItemsTableId,
  };
  for (const [name, logicalId] of Object.entries(expectedDataSources)) {
    expect(findApiRuntimeConfigurationSource(
      dataConfiguration,
      name,
    )).toEqual({
      'Fn::Base64': { Ref: logicalId },
    });
  }
  expect(
    resources[apiFunctionLogicalId].Properties.Environment.Variables,
  ).toEqual(expect.objectContaining({
    MUKUROJI_API_CORE_CONFIG_SECRET_ARN: {
      Ref: coreConfigurationSecretId,
    },
    MUKUROJI_API_DATA_CONFIG_SECRET_ARN: {
      Ref: dataConfigurationSecretId,
    },
  }));

  expect(
    resources.WebhookAuthorizationBackfill.Properties,
  ).toEqual(expect.objectContaining({
    MigrationVersion: 'v3',
    WorkspaceSearchWriterFenceMode: {
      Ref: 'WorkspaceSearchWriterFenceMode',
    },
  }));
  expect(resources.WebhookAuthorizationBackfill.DependsOn).toEqual(
    expect.arrayContaining([
      'ApiLiveAlias3A796568',
      'WebhookAuthorizationBackfillFunction5ABBA705',
      'WebhookAuthorizationBackfillProgressFunction1FF04FD2',
    ]),
  );
});

test('writer-fence grants describe exact six tables and read or condition-check migration state', () => {
  const projectDirectoryTableId = requireResourceId(
    'ProjectDirectoryTable',
    'AWS::DynamoDB::Table',
  );
  const workItemsTableId = requireResourceId(
    'TeamIssuesTable',
    'AWS::DynamoDB::Table',
  );
  const collaborationTableId = requireResourceId(
    'WorkItemCollaborationTable',
    'AWS::DynamoDB::Table',
  );
  const documentsTableId = requireResourceId(
    'DocumentsTable',
    'AWS::DynamoDB::Table',
  );
  const workspaceSearchTableId = requireResourceId(
    'WorkspaceSearchTable',
    'AWS::DynamoDB::Table',
  );
  const migrationStateTableId = requireResourceId(
    'WorkspaceSearchMigrationStateTable',
    'AWS::DynamoDB::Table',
  );
  const migrationStateTableArn = {
    'Fn::GetAtt': [migrationStateTableId, 'Arn'],
  };
  const describedTableArns = [
    { 'Fn::GetAtt': [documentsTableId, 'Arn'] },
    { 'Fn::GetAtt': [projectDirectoryTableId, 'Arn'] },
    { 'Fn::GetAtt': [workItemsTableId, 'Arn'] },
    { 'Fn::GetAtt': [collaborationTableId, 'Arn'] },
    migrationStateTableArn,
    { 'Fn::GetAtt': [workspaceSearchTableId, 'Arn'] },
  ];

  for (const [, roleLogicalIdPrefix] of writerFunctions) {
    const roleLogicalId = requireResourceId(
      roleLogicalIdPrefix,
      'AWS::IAM::Role',
    );
    const statements = requirePolicyStatementsForRole(roleLogicalId);
    const describeStatement = statements.find((statement) =>
      statementHasAction(statement, 'dynamodb:DescribeTable') &&
      statementHasResource(statement, migrationStateTableArn)
    );
    const getStateStatement = statements.find((statement) =>
      statementHasAction(statement, 'dynamodb:GetItem') &&
      statementHasResource(statement, migrationStateTableArn)
    );
    const conditionStateStatement = statements.find((statement) =>
      statementHasAction(statement, 'dynamodb:ConditionCheckItem') &&
      statementHasResource(statement, migrationStateTableArn)
    );

    expect(readProperty(describeStatement, 'Effect')).toBe('Allow');
    expect(readProperty(describeStatement, 'Resource'))
      .toEqual(describedTableArns);
    expect(readProperty(getStateStatement, 'Effect')).toBe('Allow');
    expect(readProperty(conditionStateStatement, 'Effect')).toBe('Allow');
    expect(readProperty(conditionStateStatement, 'Condition')).toEqual({
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    });
  }

  const stateAwarePolicies = Object.entries(
    synthesizedTemplate.findResources('AWS::IAM::Policy'),
  ).filter(([, policy]) =>
    JSON.stringify(policy.Properties?.PolicyDocument)
      .includes(migrationStateTableId)
  );
  expect(stateAwarePolicies).toHaveLength(writerFunctions.length);
  const expectedWriterRoleIds = writerFunctions
    .map(([, roleLogicalIdPrefix]) =>
      requireResourceId(roleLogicalIdPrefix, 'AWS::IAM::Role')
    )
    .sort();
  const stateAwareRoleIds = stateAwarePolicies
    .flatMap(([, policy]) => {
      const properties = readProperty(policy, 'Properties');
      const roles = readProperty(properties, 'Roles');
      if (!Array.isArray(roles)) {
        throw new Error('State-aware inline policy has no execution role.');
      }
      return roles
        .map((role) => readProperty(role, 'Ref'))
        .filter((role): role is string => typeof role === 'string');
    })
    .sort();
  expect(stateAwareRoleIds).toEqual(expectedWriterRoleIds);
});

test('configuration-only strict compositions have no migration-state IAM access', () => {
  const migrationStateTableId = requireResourceId(
    'WorkspaceSearchMigrationStateTable',
    'AWS::DynamoDB::Table',
  );
  const policies = Object.values(
    synthesizedTemplate.findResources('AWS::IAM::Policy'),
  );

  for (const [, roleLogicalIdPrefix] of configurationOnlyFunctions) {
    const roleLogicalId = requireResourceId(
      roleLogicalIdPrefix,
      'AWS::IAM::Role',
    );
    const rolePolicies = policies.filter((candidate) => {
      const properties = readProperty(candidate, 'Properties');
      return JSON.stringify(readProperty(properties, 'Roles'))
        .includes(`"Ref":"${roleLogicalId}"`);
    });
    expect(rolePolicies.length).toBeGreaterThan(0);
    expect(JSON.stringify(rolePolicies)).not.toContain(
      migrationStateTableId,
    );
  }
});
