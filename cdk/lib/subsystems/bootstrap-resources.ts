import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  createCanonicalWorkItemTransactItems,
  createIdempotentAwsCustomResourceProps,
  createCreateOnlyBootstrapAwsCustomResourceProps,
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
 * Builds Cognito validation, create-only table seeds, and idempotent
 * workspace-access seed custom resources.
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
    systemAdminGroups,
    userIdentity,
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
      UserPoolId: cognitoUserPoolId,
      ClientId: cognitoUserPoolClientId,
    },
    logging: customResources.Logging.withDataHidden(),
    physicalResourceId: customResources.PhysicalResourceId.of('mukuroji-cognito-client-validation'),
  };
  const validateCognitoClient = new customResources.AwsCustomResource(
    scope,
    'ValidateCognitoUserPoolClient',
    createIdempotentAwsCustomResourceProps(validateCognitoClientCall, cognitoPolicy),
  );
  // A stack-owned pool starts empty, so the stack invites the initial owner by email. Cognito
  // sends a temporary password that the owner replaces at the first sign-in.
  const createInitialOwnerCall: customResources.AwsSdkCall = {
    service: 'CognitoIdentityServiceProvider',
    action: 'adminCreateUser',
    parameters: {
      UserPoolId: userIdentity.userPool.userPoolId,
      Username: initialOwnerUsername.valueAsString,
      DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [
        { Name: 'email', Value: initialOwnerEmail.valueAsString },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:directory_id', Value: workspaceDirectoryId.valueAsString },
        { Name: 'custom:workspace_id', Value: workspaceDirectoryId.valueAsString },
      ],
    },
    logging: customResources.Logging.withDataHidden(),
    // Keep the stored response small; the user record carries the owner's email.
    outputPaths: ['User.Username'],
    // The physical ID is the username, so `Ref` returns it on every lifecycle event. A response
    // field would be missing after an update, because the invitation never runs again.
    physicalResourceId: customResources.PhysicalResourceId.of(initialOwnerUsername.valueAsString),
  };
  const createInitialOwner = new customResources.AwsCustomResource(
    scope,
    'CreateInitialOwner',
    createCreateOnlyBootstrapAwsCustomResourceProps(
      createInitialOwnerCall,
      customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminCreateUser'],
          resources: [cognitoUserPoolArn],
        }),
      ]),
    ),
  );
  const createInitialOwnerResource = createInitialOwner.node.findChild('Resource') as cdk.CustomResource;
  (createInitialOwnerResource.node.defaultChild as cdk.CfnResource)
    .cfnOptions.condition = userIdentity.userPoolCreated;
  // The owner also gets the first system-admin group, so team creation works without a CLI step.
  // Adding a member is idempotent, so the call also runs on update and follows a renamed group.
  const systemAdminGroup = new cognito.CfnUserPoolGroup(scope, 'SystemAdminGroup', {
    userPoolId: userIdentity.userPool.userPoolId,
    groupName: cdk.Fn.select(0, cdk.Fn.split(',', systemAdminGroups.valueAsString)),
    description: 'mukuroji system administrators.',
  });
  systemAdminGroup.cfnOptions.condition = userIdentity.userPoolCreated;
  const addInitialOwnerToSystemAdminGroup = new customResources.AwsCustomResource(
    scope,
    'AddInitialOwnerToSystemAdminGroup',
    createIdempotentAwsCustomResourceProps(
      {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminAddUserToGroup',
        parameters: {
          UserPoolId: userIdentity.userPool.userPoolId,
          Username: createInitialOwnerResource.ref,
          GroupName: systemAdminGroup.ref,
        },
        logging: customResources.Logging.withDataHidden(),
        physicalResourceId: customResources.PhysicalResourceId.of(
          'mukuroji-initial-owner-system-admin',
        ),
      },
      customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminAddUserToGroup'],
          resources: [cognitoUserPoolArn],
        }),
      ]),
    ),
  );
  (addInitialOwnerToSystemAdminGroup.node.findChild('Resource').node.defaultChild as cdk.CfnResource)
    .cfnOptions.condition = userIdentity.userPoolCreated;
  // CloudFormation rejects a DependsOn on a resource whose condition is false, so the owner
  // update reads the invited username through Fn::If to order itself after the invitation.
  const initialOwnerCognitoUsername = cdk.Token.asString(cdk.Fn.conditionIf(
    userIdentity.userPoolCreated.logicalId,
    createInitialOwnerResource.ref,
    initialOwnerUsername.valueAsString,
  ));
  const updateInitialOwnerAttributesCall: customResources.AwsSdkCall = {
    service: 'CognitoIdentityServiceProvider',
    action: 'adminUpdateUserAttributes',
    parameters: {
      UserPoolId: cognitoUserPoolId,
      Username: initialOwnerCognitoUsername,
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
    physicalResourceId: customResources.PhysicalResourceId.of('mukuroji-initial-owner-attributes'),
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
    physicalResourceId: customResources.PhysicalResourceId.of('canonical-work-items-seed'),
  };
  const seedCanonicalWorkItems = new customResources.AwsCustomResource(
    scope,
    'SeedWorkItems',
    createCreateOnlyBootstrapAwsCustomResourceProps(
      seedCanonicalWorkItemsCall,
      customResources.AwsCustomResourcePolicy.fromStatements([
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
    ),
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
    physicalResourceId: customResources.PhysicalResourceId.of('project-directory-seed'),
  };
  const seedProjectDirectory = new customResources.AwsCustomResource(
    scope,
    'SeedProjectDirectory',
    createCreateOnlyBootstrapAwsCustomResourceProps(
      seedProjectDirectoryCall,
      customResources.AwsCustomResourcePolicy.fromStatements([
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
    physicalResourceId: customResources.PhysicalResourceId.of('workspace-access-seed'),
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
    physicalResourceId: customResources.PhysicalResourceId.of('workspace-bootstrap'),
  };
  const bootstrapWorkspace = new customResources.AwsCustomResource(
    scope,
    'BootstrapWorkspace',
    createCreateOnlyBootstrapAwsCustomResourceProps(
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
    physicalResourceId: customResources.PhysicalResourceId.of('workspace-access-demo-members-seed'),
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
