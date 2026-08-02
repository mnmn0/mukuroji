/** Registers stack parameter and configuration tests. */
import { expect, test } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildStackParameters } from '../lib/config/stack-parameters';
import { synthesizedTemplate } from './test-support';

test('fresh deployment requires explicit Cognito workspace and runtime secrets parameters', () => {
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
  expect(parameters.CognitoSsoUserPoolClientId).toEqual(expect.objectContaining({
    Type: 'String',
    AllowedPattern: '^[A-Za-z0-9]+$',
  }));
  expect(parameters.WorkspaceDirectoryId).toEqual(expect.objectContaining({
    Type: 'String',
    MinLength: 1,
    AllowedPattern: '^\\S+$',
  }));
  expect(parameters.WorkspaceAuditPseudonymKey).toEqual(expect.objectContaining({
    Type: 'String',
    NoEcho: true,
    AllowedPattern: '^[0-9a-f]{64}$',
    ConstraintDescription:
      'WorkspaceAuditPseudonymKey must be exactly 64 lowercase hexadecimal characters.',
  }));
  expect(parameters.ApiRuntimeConfigurationRevision).toEqual({
    AllowedPattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$',
    ConstraintDescription:
      'ApiRuntimeConfigurationRevision must be a 1-32 character deployment revision.',
    Description:
      'Operator-incremented revision that replaces immutable API configuration secrets and publishes a matching Lambda version.',
    MaxLength: 32,
    MinLength: 1,
    Type: 'String',
  });
  expect(parameters.WorkspaceSearchMigrationEnvironment).toBeUndefined();
  expect(
    parameters.WorkspaceSearchMigrationProductionAccountId,
  ).toBeUndefined();
  expect(parameters.RestoreDrillCleanupApproverRoleArn).toEqual({
    AllowedPattern:
      '^arn:(?:aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$',
    ConstraintDescription:
      'RestoreDrillCleanupApproverRoleArn must be an explicit IAM role ARN in the supported deployment partition.',
    Description:
      'Existing data-owner IAM role exclusively authorized to create and admit immutable restore-drill cleanup approvals.',
    Type: 'String',
  });
  expect(parameters.ConnectorRuntimeConfiguration).toEqual(expect.objectContaining({
    Type: 'String',
    Default: '{}',
    NoEcho: true,
  }));
  expect(parameters.DeveloperPlatformSecretProtectorKey).toBeUndefined();
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
    'AlarmPrimaryTopicName',
    'AlarmSecondaryTopicName',
  ]) {
    expect(parameters[parameterName]).toEqual(expect.objectContaining({
      Type: 'String',
      MinLength: 1,
      MaxLength: 256,
      AllowedPattern: '^[A-Za-z0-9_-]+$',
    }));
  }
  expect(parameters.FileRetentionDays).toEqual(expect.objectContaining({
    Type: 'Number',
    Default: 30,
    MinValue: 1,
  }));
  expect(parameters.FileUploadUrlTtlSeconds).toEqual(expect.objectContaining({
    Type: 'Number',
    Default: 600,
    MinValue: 60,
    MaxValue: 3600,
  }));
  expect(parameters.FileDownloadUrlTtlSeconds).toEqual(expect.objectContaining({
    Type: 'Number',
    Default: 300,
    MinValue: 60,
    MaxValue: 3600,
  }));
  expect(parameters.RequestRateLimitPerHour).toEqual(expect.objectContaining({
    Type: 'Number',
    Default: 10,
    MinValue: 1,
    MaxValue: 10000,
  }));
  for (const secretParameterName of [
    'EnterpriseIdentityTokenHashSecret',
    'EnterpriseSsoStateSecret',
    'RequestEmailWebhookSecret',
    'RequestTokenHashSecret',
  ]) {
    expect(parameters[secretParameterName]).toEqual(expect.objectContaining({
      Type: 'String',
      MinLength: 32,
      MaxLength: 256,
      NoEcho: true,
    }));
  }

  for (const parameterName of [
    'CognitoUserPoolId',
    'CognitoUserPoolClientId',
    'CognitoSsoUserPoolClientId',
    'EnterpriseIdentityTokenHashSecret',
    'EnterpriseSsoStateSecret',
    'WorkspaceDirectoryId',
    'WorkspaceAuditPseudonymKey',
    'InitialOwnerEmail',
    'InitialOwnerUsername',
    'RequestEmailWebhookSecret',
    'RequestTokenHashSecret',
    'AlarmPrimaryTopicName',
    'AlarmSecondaryTopicName',
    'ApiRuntimeConfigurationRevision',
  ]) {
    expect(parameters[parameterName].Default).toBeUndefined();
  }
  expect(template.toJSON().Rules.AlarmNotificationTopicSeparation).toEqual({
    Assertions: [{
      Assert: {
        'Fn::Not': [{
          'Fn::Equals': [
            { Ref: 'AlarmPrimaryTopicName' },
            { Ref: 'AlarmSecondaryTopicName' },
          ],
        }],
      },
      AssertDescription:
        'AlarmPrimaryTopicName must differ from AlarmSecondaryTopicName.',
    }],
  });
  expect(
    template.toJSON().Rules.WorkspaceSearchMigrationAccountSeparation,
  ).toBeUndefined();
  expect(template.toJSON().Rules.EnterpriseSecretSeparation).toEqual({
    Assertions: [{
      Assert: {
        'Fn::Not': [{
          'Fn::Equals': [
            { Ref: 'EnterpriseSsoStateSecret' },
            { Ref: 'EnterpriseIdentityTokenHashSecret' },
          ],
        }],
      },
      AssertDescription:
        'EnterpriseSsoStateSecret must differ from EnterpriseIdentityTokenHashSecret.',
    }],
  });
  expect(template.toJSON().Rules.CognitoClientSeparation).toEqual({
    Assertions: [{
      Assert: {
        'Fn::Not': [{
          'Fn::Equals': [
            { Ref: 'CognitoSsoUserPoolClientId' },
            { Ref: 'CognitoUserPoolClientId' },
          ],
        }],
      },
      AssertDescription:
        'CognitoSsoUserPoolClientId must differ from CognitoUserPoolClientId.',
    }],
  });

  template.resourceCountIs('AWS::Cognito::UserPool', 0);
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
});

test('derives restore-drill approver ARN partitions from concrete stack Regions', () => {
  const commercialStack = new cdk.Stack(
    new cdk.App(),
    'CommercialPartitionFixture',
    { env: { account: '123456789012', region: 'ap-northeast-1' } },
  );
  const govCloudStack = new cdk.Stack(
    new cdk.App(),
    'GovCloudPartitionFixture',
    { env: { account: '123456789012', region: 'us-gov-west-1' } },
  );
  const chinaStack = new cdk.Stack(
    new cdk.App(),
    'ChinaPartitionFixture',
    { env: { account: '123456789012', region: 'cn-north-1' } },
  );

  for (const { partition, stack } of [
    { partition: 'aws', stack: commercialStack },
    { partition: 'aws-us-gov', stack: govCloudStack },
    { partition: 'aws-cn', stack: chinaStack },
  ]) {
    buildStackParameters(stack);
    expect(
      Template.fromStack(stack).toJSON()
        .Parameters.RestoreDrillCleanupApproverRoleArn.AllowedPattern,
    ).toBe(
      `^arn:${partition}:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$`,
    );
  }
});

test('rejects concrete restore-drill stacks in unsupported ARN partitions', () => {
  const stack = new cdk.Stack(
    new cdk.App(),
    'UnsupportedPartitionFixture',
    { env: { account: '123456789012', region: 'us-iso-east-1' } },
  );

  expect(() => buildStackParameters(stack)).toThrow(
    'Restore drill does not support the aws-iso AWS partition.',
  );

  const unknownRegionStack = new cdk.Stack(
    new cdk.App(),
    'UnknownPartitionFixture',
    { env: { account: '123456789012', region: 'xx-unknown-1' } },
  );
  expect(() => buildStackParameters(unknownRegionStack)).toThrow(
    'Unable to resolve an AWS partition for concrete Region xx-unknown-1.',
  );
});
