/** Registers stack parameter and configuration tests. */
import { expect, test } from '@jest/globals';
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
