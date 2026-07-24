import * as cdk from 'aws-cdk-lib';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  createCanonicalWorkItemTransactItems,
  createIdempotentAwsCustomResourceProps,
  createProjectDirectoryTransactItems,
  createWorkspaceAccessTransactItems,
  createWorkspaceBootstrapTransactItems,
  createWorkspaceDemoMemberTransactItems,
} from '../bootstrap-data';
import type { StackParameters } from '../config/stack-parameters';
import type { DataStoreResources } from './data-stores';

/**
 * Inputs required to build Cognito validation and deterministic workspace bootstrap resources.
 */
export interface BootstrapResourcesInput {
  /** Shared data stores seeded by the bootstrap custom resources. */
  readonly dataStores: DataStoreResources;
  /** Stack parameters used to validate Cognito and identify the initial workspace owner. */
  readonly parameters: StackParameters;
}

/**
 * Builds Cognito validation and idempotent workspace seed custom resources.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Shared parameters and data stores consumed by bootstrap operations.
 * @returns Nothing; the custom resources are attached directly to the stack.
 */
export function buildBootstrapResources(
  scope: cdk.Stack,
  input: BootstrapResourcesInput,
): void {
  const {
    projectDirectoryTable,
    workItemsTable,
    workspaceAccessTable,
  } = input.dataStores;
  const {
    cognitoUserPoolArn,
    cognitoUserPoolClientId,
    cognitoUserPoolId,
    initialOwnerEmail,
    initialOwnerUsername,
    workspaceDirectoryId,
  } = input.parameters;

  const cognitoPolicy = customResources.AwsCustomResourcePolicy.fromStatements([
    new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:DescribeUserPoolClient',
      ],
      resources: [cognitoUserPoolArn],
    }),
  ]);
  const validateCognitoClientCall: customResources.AwsSdkCall = {
    service: 'CognitoIdentityServiceProvider',
    action: 'describeUserPoolClient',
    parameters: {
      UserPoolId: cognitoUserPoolId.valueAsString,
      ClientId: cognitoUserPoolClientId.valueAsString,
    },
    logging: customResources.Logging.withDataHidden(),
    physicalResourceId: customResources.PhysicalResourceId.of('mukuroji-cognito-client-validation-v1'),
  };
  const validateCognitoClient = new customResources.AwsCustomResource(
    scope,
    'ValidateCognitoUserPoolClient',
    createIdempotentAwsCustomResourceProps(validateCognitoClientCall, cognitoPolicy),
  );
  const updateInitialOwnerAttributesCall: customResources.AwsSdkCall = {
    service: 'CognitoIdentityServiceProvider',
    action: 'adminUpdateUserAttributes',
    parameters: {
      UserPoolId: cognitoUserPoolId.valueAsString,
      Username: initialOwnerUsername.valueAsString,
      UserAttributes: [
        {
          Name: 'custom:directory_id',
          Value: workspaceDirectoryId.valueAsString,
        },
        {
          Name: 'custom:workspace_id',
          Value: workspaceDirectoryId.valueAsString,
        },
      ],
    },
    logging: customResources.Logging.withDataHidden(),
    physicalResourceId: customResources.PhysicalResourceId.of('mukuroji-initial-owner-attributes-v1'),
  };
  const updateInitialOwnerAttributes = new customResources.AwsCustomResource(
    scope,
    'UpdateInitialOwnerAttributes',
    createIdempotentAwsCustomResourceProps(updateInitialOwnerAttributesCall, cognitoPolicy),
  );

  updateInitialOwnerAttributes.node.addDependency(validateCognitoClient);

  const seedCanonicalWorkItemsCall: customResources.AwsSdkCall = {
    service: 'DynamoDB',
    action: 'transactWriteItems',
    parameters: {
      TransactItems: createCanonicalWorkItemTransactItems(
        workItemsTable.tableName,
        workspaceDirectoryId.valueAsString,
      ),
    },
    physicalResourceId: customResources.PhysicalResourceId.of('canonical-work-items-seed-v1'),
  };
  const seedCanonicalWorkItems = new customResources.AwsCustomResource(
    scope,
    'SeedProjectTasks',
    {
      onCreate: seedCanonicalWorkItemsCall,
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem'],
          resources: [workItemsTable.tableArn],
          conditions: {
            'ForAnyValue:StringEquals': {
              'dynamodb:EnclosingOperation': ['TransactWriteItems'],
            },
          },
        }),
      ]),
      installLatestAwsSdk: false,
    },
  );

  seedCanonicalWorkItems.node.addDependency(workItemsTable);

  const seedProjectDirectoryCall: customResources.AwsSdkCall = {
    service: 'DynamoDB',
    action: 'transactWriteItems',
    parameters: {
      TransactItems: createProjectDirectoryTransactItems(
        projectDirectoryTable.tableName,
        workspaceDirectoryId.valueAsString,
      ),
    },
    physicalResourceId: customResources.PhysicalResourceId.of('project-directory-seed-v3'),
  };
  const seedProjectDirectory = new customResources.AwsCustomResource(
    scope,
    'SeedProjectDirectory',
    {
      onCreate: seedProjectDirectoryCall,
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem'],
          resources: [projectDirectoryTable.tableArn],
          conditions: {
            'ForAnyValue:StringEquals': {
              'dynamodb:EnclosingOperation': ['TransactWriteItems'],
            },
          },
        }),
      ]),
      installLatestAwsSdk: false,
    },
  );

  seedProjectDirectory.node.addDependency(projectDirectoryTable);
  seedCanonicalWorkItems.node.addDependency(seedProjectDirectory);

  const seedWorkspaceAccessCall: customResources.AwsSdkCall = {
    service: 'DynamoDB',
    action: 'transactWriteItems',
    parameters: {
      TransactItems: createWorkspaceAccessTransactItems(
        workspaceAccessTable.tableName,
        workspaceDirectoryId.valueAsString,
        initialOwnerEmail.valueAsString,
      ),
    },
    physicalResourceId: customResources.PhysicalResourceId.of('workspace-access-seed-v2'),
  };
  const seedWorkspaceAccess = new customResources.AwsCustomResource(
    scope,
    'SeedWorkspaceAccess',
    createIdempotentAwsCustomResourceProps(
      seedWorkspaceAccessCall,
      customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:UpdateItem'],
          resources: [workspaceAccessTable.tableArn],
          conditions: {
            'ForAnyValue:StringEquals': {
              'dynamodb:EnclosingOperation': ['TransactWriteItems'],
            },
          },
        }),
      ]),
    ),
  );
  seedWorkspaceAccess.node.addDependency(workspaceAccessTable);

  const bootstrapWorkspaceCall: customResources.AwsSdkCall = {
    service: 'DynamoDB',
    action: 'transactWriteItems',
    parameters: {
      TransactItems: createWorkspaceBootstrapTransactItems(
        projectDirectoryTable.tableName,
        workspaceDirectoryId.valueAsString,
        initialOwnerEmail.valueAsString,
        initialOwnerUsername.valueAsString,
      ),
    },
    physicalResourceId: customResources.PhysicalResourceId.of('workspace-bootstrap-v2'),
  };
  const bootstrapWorkspace = new customResources.AwsCustomResource(
    scope,
    'BootstrapWorkspace',
    createIdempotentAwsCustomResourceProps(
      bootstrapWorkspaceCall,
      customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:UpdateItem'],
          resources: [projectDirectoryTable.tableArn],
          conditions: {
            'ForAnyValue:StringEquals': {
              'dynamodb:EnclosingOperation': ['TransactWriteItems'],
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem'],
          resources: [projectDirectoryTable.tableArn],
          conditions: {
            'ForAnyValue:StringEquals': {
              'dynamodb:EnclosingOperation': ['TransactWriteItems'],
            },
          },
        }),
      ]),
    ),
  );

  bootstrapWorkspace.node.addDependency(seedProjectDirectory);
  bootstrapWorkspace.node.addDependency(updateInitialOwnerAttributes);

  const seedWorkspaceDemoMembersCall: customResources.AwsSdkCall = {
    service: 'DynamoDB',
    action: 'transactWriteItems',
    parameters: {
      TransactItems: createWorkspaceDemoMemberTransactItems(
        workspaceAccessTable.tableName,
        workspaceDirectoryId.valueAsString,
      ),
    },
    physicalResourceId: customResources.PhysicalResourceId.of(
      'workspace-access-demo-members-seed-v2',
    ),
  };
  const seedWorkspaceDemoMembers = new customResources.AwsCustomResource(
    scope,
    'SeedWorkspaceDemoMembers',
    createIdempotentAwsCustomResourceProps(
      seedWorkspaceDemoMembersCall,
      customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:UpdateItem'],
          resources: [workspaceAccessTable.tableArn],
          conditions: {
            'ForAnyValue:StringEquals': {
              'dynamodb:EnclosingOperation': ['TransactWriteItems'],
            },
          },
        }),
      ]),
    ),
  );

  seedWorkspaceDemoMembers.node.addDependency(seedWorkspaceAccess);
}
