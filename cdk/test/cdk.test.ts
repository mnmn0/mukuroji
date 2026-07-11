import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { expect, test } from '@jest/globals';
import { CdkStack } from '../lib/cdk-stack';

/**
 * 各 test で使用する synthesized CloudFormation template を作成します。
 */
function createTemplate() {
  const app = new cdk.App();
  const stack = new CdkStack(app, 'TestStack');

  return Template.fromStack(stack);
}

/**
 * 指定した AWS SDK action を実行する custom resource を取得します。
 */
function findCustomResource(template: Template, action: string) {
  const resource = Object.entries(template.findResources('Custom::AWS')).find(([, candidate]) =>
    JSON.stringify(candidate).includes(action),
  );

  if (!resource) {
    throw new Error(`Custom resource for ${action} was not found.`);
  }

  return resource;
}

/**
 * CloudFormation intrinsic を含む AWS SDK call を検証用文字列に変換します。
 */
function serializeAwsSdkCall(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(serializeAwsSdkCall).join('');
  }

  if (!value || typeof value !== 'object') {
    return String(value ?? '');
  }

  const record = value as Record<string, unknown>;
  const join = record['Fn::Join'];

  if (Array.isArray(join) && Array.isArray(join[1])) {
    return join[1].map(serializeAwsSdkCall).join(String(join[0] ?? ''));
  }

  if (typeof record.Ref === 'string') {
    return `{{Ref:${record.Ref}}}`;
  }

  return Object.entries(record)
    .map(([key, entry]) => `${key}:${serializeAwsSdkCall(entry)}`)
    .join('');
}

const synthesizedTemplate = createTemplate();

test('fresh deployment requires explicit external Cognito and workspace parameters', () => {
  const template = synthesizedTemplate;
  const parameters = template.toJSON().Parameters;

  expect(parameters.CognitoUserPoolId).toEqual(expect.objectContaining({
    Type: 'String',
    AllowedPattern: '^[a-z]{2}(?:-[a-z0-9]+)+_[A-Za-z0-9]+$',
  }));
  expect(parameters.CognitoUserPoolClientId).toEqual(expect.objectContaining({
    Type: 'String',
    AllowedPattern: '^[A-Za-z0-9]+$',
  }));
  expect(parameters.WorkspaceDirectoryId).toEqual(expect.objectContaining({
    Type: 'String',
    MinLength: 1,
    AllowedPattern: '^\\S+$',
  }));
  expect(parameters.InitialOwnerEmail).toEqual(expect.objectContaining({
    Type: 'String',
    ConstraintDescription: 'InitialOwnerEmail must be a lowercase email address.',
  }));
  expect(parameters.InitialOwnerUsername).toEqual(expect.objectContaining({
    Type: 'String',
    MinLength: 1,
    AllowedPattern: '^\\S+$',
  }));
  expect(parameters.TaskApiAllowedOrigins).toEqual(expect.objectContaining({
    Type: 'String',
    AllowedPattern: '^https?://[^,\\s]+(,https?://[^,\\s]+)*$',
  }));

  for (const parameterName of [
    'CognitoUserPoolId',
    'CognitoUserPoolClientId',
    'WorkspaceDirectoryId',
    'InitialOwnerEmail',
    'InitialOwnerUsername',
  ]) {
    expect(parameters[parameterName].Default).toBeUndefined();
  }

  template.resourceCountIs('AWS::Cognito::UserPool', 0);
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
});

test('upgrade keeps stateful resource logical IDs and enables retain with PITR', () => {
  const template = synthesizedTemplate;
  const resources = template.toJSON().Resources;
  const stableResourceIds = [
    'ProjectTasksTableE21F6637',
    'TeamIssuesTable189D851D',
    'TeamIssueEventsTableDD2B0F96',
    'ProjectDirectoryTable9ED01C01',
    'ListProjectTasksFunction2134AF4A',
  ];

  for (const logicalId of stableResourceIds) {
    expect(resources[logicalId]).toBeDefined();
  }

  const tables = template.findResources('AWS::DynamoDB::Table');

  expect(Object.keys(tables)).toHaveLength(4);

  for (const table of Object.values(tables)) {
    expect(table).toEqual(expect.objectContaining({
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: expect.objectContaining({
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      }),
    }));
  }
});

test('shared server handler is bundled as a Lambda asset with production environment', () => {
  const template = synthesizedTemplate;

  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: Match.anyValue(),
      S3Key: Match.stringLikeRegexp('\\.zip$'),
    },
    Description: 'Bundled shared Hono handler for the mukuroji Function URL and HTTP API.',
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: Match.objectLike({
        COGNITO_CLIENT_ID: {
          Ref: 'CognitoUserPoolClientId',
        },
        COGNITO_USER_POOL_ID: {
          Ref: 'CognitoUserPoolId',
        },
        MUKUROJI_PROJECT_DIRECTORY_ID: {
          Ref: 'WorkspaceDirectoryId',
        },
        MUKUROJI_WORKSPACE_DIRECTORY_ID: {
          Ref: 'WorkspaceDirectoryId',
        },
        MUKUROJI_PROJECT_DIRECTORY_TABLE: {
          Ref: 'ProjectDirectoryTable9ED01C01',
        },
        MUKUROJI_PROJECT_TASKS_TABLE: {
          Ref: 'ProjectTasksTableE21F6637',
        },
        MUKUROJI_TEAM_ISSUES_TABLE: {
          Ref: 'TeamIssuesTable189D851D',
        },
      }),
    },
  });

  const lambdaResource = template.toJSON().Resources.ListProjectTasksFunction2134AF4A;

  expect(lambdaResource.Properties.Code.ZipFile).toBeUndefined();
});

test('Function URL and API Gateway invoke the same Lambda handler', () => {
  const template = synthesizedTemplate;
  const functionLogicalId = 'ListProjectTasksFunction2134AF4A';

  template.hasResourceProperties('AWS::Lambda::Url', {
    AuthType: 'NONE',
    TargetFunctionArn: {
      'Fn::GetAtt': [functionLogicalId, 'Arn'],
    },
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
    IntegrationType: 'AWS_PROXY',
    IntegrationUri: {
      'Fn::GetAtt': [functionLogicalId, 'Arn'],
    },
    PayloadFormatVersion: '2.0',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    AuthorizationType: 'NONE',
    RouteKey: '$default',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    AutoDeploy: true,
    StageName: '$default',
  });
  template.hasResourceProperties('AWS::Lambda::Permission', {
    Action: 'lambda:InvokeFunction',
    FunctionName: {
      'Fn::GetAtt': [functionLogicalId, 'Arn'],
    },
    Principal: 'apigateway.amazonaws.com',
    SourceArn: Match.anyValue(),
  });
  template.hasOutput('ProjectTasksFunctionUrl', {});
  template.hasOutput('ProjectTasksApiGatewayUrl', {});
  template.hasOutput('WorkspaceDirectoryId', {
    Value: {
      Ref: 'WorkspaceDirectoryId',
    },
  });
  template.hasOutput('ProjectTasksApiUrl', {
    Description: 'Backward-compatible alias for the Lambda Function URL.',
  });
});

test('Function URL and API Gateway expose the same restricted CORS contract', () => {
  const template = synthesizedTemplate;
  const allowedOrigins = {
    'Fn::Split': [
      ',',
      {
        Ref: 'TaskApiAllowedOrigins',
      },
    ],
  };

  template.hasResourceProperties('AWS::Lambda::Url', {
    Cors: {
      AllowHeaders: ['authorization', 'content-type'],
      AllowMethods: Match.arrayWith(['GET', 'POST', 'PATCH', 'DELETE']),
      AllowOrigins: allowedOrigins,
    },
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    CorsConfiguration: {
      AllowHeaders: ['authorization', 'content-type'],
      AllowMethods: Match.arrayWith(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']),
      AllowOrigins: allowedOrigins,
    },
    ProtocolType: 'HTTP',
  });
});

test('API IAM is limited to the data tables and configured Cognito user pool', () => {
  const template = synthesizedTemplate;

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'dynamodb:TransactWriteItems',
          Effect: 'Allow',
          Resource: Match.arrayWith([
            {
              'Fn::GetAtt': ['ProjectTasksTableE21F6637', 'Arn'],
            },
            {
              'Fn::GetAtt': ['ProjectDirectoryTable9ED01C01', 'Arn'],
            },
          ]),
        }),
        Match.objectLike({
          Action: Match.arrayWith([
            'cognito-idp:AdminGetUser',
            'cognito-idp:ListUsers',
          ]),
          Effect: 'Allow',
          Resource: {
            'Fn::Join': [
              '',
              Match.arrayWith([
                ':userpool/',
                {
                  Ref: 'CognitoUserPoolId',
                },
              ]),
            ],
          },
        }),
      ]),
    },
  });
});

test('external Cognito client and initial owner attributes are validated on create and update', () => {
  const template = synthesizedTemplate;
  const [, clientValidation] = findCustomResource(template, 'describeUserPoolClient');
  const [, ownerAttributes] = findCustomResource(template, 'adminUpdateUserAttributes');
  const clientCreate = serializeAwsSdkCall(clientValidation.Properties.Create);
  const ownerCreate = serializeAwsSdkCall(ownerAttributes.Properties.Create);

  expect(clientCreate).toContain('describeUserPoolClient');
  expect(clientCreate).toContain('CognitoUserPoolId');
  expect(clientCreate).toContain('CognitoUserPoolClientId');
  expect(clientValidation.Properties.Update).toEqual(clientValidation.Properties.Create);

  expect(ownerCreate).toContain('adminUpdateUserAttributes');
  expect(ownerCreate).toContain('InitialOwnerUsername');
  expect(ownerCreate).toContain('custom:directory_id');
  expect(ownerCreate).toContain('custom:workspace_id');
  expect(ownerCreate.match(/WorkspaceDirectoryId/g)).toHaveLength(2);
  expect(ownerAttributes.Properties.Update).toEqual(ownerAttributes.Properties.Create);

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            'cognito-idp:AdminUpdateUserAttributes',
            'cognito-idp:DescribeUserPoolClient',
          ]),
          Effect: 'Allow',
          Resource: Match.anyValue(),
        }),
      ]),
    },
  });
});

test('workspace metadata owner alias and project manager rows are idempotently bootstrapped', () => {
  const template = synthesizedTemplate;
  const [, bootstrap] = Object.entries(template.findResources('Custom::AWS')).find(([, candidate]) =>
    JSON.stringify(candidate).includes('workspace-bootstrap-v1'),
  ) ?? [];

  if (!bootstrap) {
    throw new Error('Workspace bootstrap custom resource was not found.');
  }

  const createPayload = serializeAwsSdkCall(bootstrap.Properties.Create);

  expect(createPayload).toContain('transactWriteItems');
  expect(createPayload).toContain('WORKSPACE#METADATA');
  expect(createPayload).toContain('workspace-metadata');
  expect(createPayload).toContain('WORKSPACE_MEMBER#');
  expect(createPayload).toContain('workspace-member');
  expect(createPayload).toContain('EMAIL_ALIAS#');
  expect(createPayload).toContain('email-alias');
  expect(createPayload).toContain('InitialOwnerEmail');
  expect(createPayload).toContain('InitialOwnerUsername');
  expect(createPayload).toContain('WorkspaceDirectoryId');
  expect(createPayload).toContain('PROJECT_MEMBER#refero#');
  expect(createPayload).toContain('PROJECT_MEMBER#product-roadmap#');
  expect(createPayload).toContain('PROJECT_MEMBER#shared-launch#');
  expect(createPayload).toContain('PROJECT_MEMBER#brand-refresh#');
  expect(createPayload.match(/":role":\{"S":"manager"\}/g)).toHaveLength(4);
  expect(createPayload.match(/":timestamp":\{"S":"2026-07-11T00:00:00.000Z"\}/g)).toHaveLength(5);
  expect(createPayload.match(/"Update"/g)).toHaveLength(7);
  expect(createPayload).not.toContain('"Item"');
  expect(createPayload).toContain('createdAt = if_not_exists(createdAt, :timestamp)');
  expect(createPayload).toContain('updatedAt = if_not_exists(updatedAt, :timestamp)');
  expect(createPayload).toContain('#role = :role');
  expect(createPayload).toContain('attribute_not_exists(directoryId) OR');
  expect(bootstrap.Properties.Update).toEqual(bootstrap.Properties.Create);
});

test('legacy demo seeds use the workspace partition without replacing update-time data', () => {
  const template = synthesizedTemplate;
  const transactWriteResources = Object.values(template.findResources('Custom::AWS')).filter((resource) =>
    JSON.stringify(resource).includes('transactWriteItems'),
  );
  const projectTaskSeed = transactWriteResources.find((resource) =>
    JSON.stringify(resource).includes('refero-project-tasks-seed-v3'),
  );
  const projectDirectorySeed = transactWriteResources.find((resource) =>
    JSON.stringify(resource).includes('project-directory-seed-v3'),
  );

  expect(projectTaskSeed).toBeDefined();
  expect(projectDirectorySeed).toBeDefined();

  const taskPayload = serializeAwsSdkCall(projectTaskSeed?.Properties.Create);
  const directoryPayload = serializeAwsSdkCall(projectDirectorySeed?.Properties.Create);

  expect(taskPayload).toContain('WorkspaceDirectoryId');
  expect(directoryPayload).toContain('WorkspaceDirectoryId');
  expect(taskPayload).not.toContain('user#demo@example.com');
  expect(directoryPayload).not.toContain('user#demo@example.com');
  expect(projectTaskSeed?.Properties.Update).toBeUndefined();
  expect(projectDirectorySeed?.Properties.Update).toBeUndefined();
});
