/** Registers tests for the stack-owned or existing Cognito user pool. */
import { expect, test } from '@jest/globals';
import { Match } from 'aws-cdk-lib/assertions';
import {
  COGNITO_USER_POOL_ID_VALUE,
  findCustomResource,
  serializeAwsSdkCall,
  synthesizedTemplate,
} from './test-support';

test('creates the user pool and password client only when the Cognito IDs are blank', () => {
  expect(synthesizedTemplate.toJSON().Conditions).toEqual(expect.objectContaining({
    CognitoUserPoolCreated: { 'Fn::Equals': [{ Ref: 'CognitoUserPoolId' }, ''] },
  }));
  synthesizedTemplate.hasResource('AWS::Cognito::UserPool', {
    Condition: 'CognitoUserPoolCreated',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: Match.objectLike({
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      DeletionProtection: 'ACTIVE',
      UsernameConfiguration: { CaseSensitive: false },
      UserPoolTier: 'ESSENTIALS',
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 12,
          TemporaryPasswordValidityDays: 7,
        }),
      },
      Schema: Match.arrayWith([
        Match.objectLike({ Name: 'email', Required: true, Mutable: true }),
        Match.objectLike({ Name: 'directory_id', AttributeDataType: 'String', Mutable: true }),
        Match.objectLike({ Name: 'workspace_id', AttributeDataType: 'String', Mutable: true }),
      ]),
    }),
  });
  synthesizedTemplate.hasResource('AWS::Cognito::UserPoolClient', {
    Condition: 'CognitoUserPoolCreated',
    Properties: Match.objectLike({
      ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      GenerateSecret: false,
      PreventUserExistenceErrors: 'ENABLED',
      AllowedOAuthFlowsUserPoolClient: false,
    }),
  });
});

test('invites the initial owner only into a stack-owned user pool', () => {
  const [ownerLogicalId, createOwner] = findCustomResource(
    synthesizedTemplate,
    'adminCreateUser',
  );
  expect(createOwner.Condition).toBe('CognitoUserPoolCreated');
  const create = serializeAwsSdkCall(createOwner.Properties.Create);
  expect(create).toContain('"DesiredDeliveryMediums":["EMAIL"]');
  expect(create).toContain('{{Ref:InitialOwnerUsername}}');
  expect(create).toContain('{{Ref:InitialOwnerEmail}}');
  expect(create).toContain('"Name":"email_verified","Value":"true"');
  expect(create).toContain('{{Ref:WorkspaceDirectoryId}}');
  // The invitation runs once; stack updates must not resend it.
  expect(createOwner.Properties.Update).toBeUndefined();

  const [, updateOwner] = findCustomResource(synthesizedTemplate, 'adminUpdateUserAttributes');
  // An existing pool keeps its own owner, so the update has no condition and orders itself after
  // the invitation through the Fn::If on the username instead of a DependsOn.
  expect(updateOwner.Condition).toBeUndefined();
  expect(updateOwner.DependsOn).not.toContain(ownerLogicalId);
  expect(JSON.stringify(updateOwner.Properties.Create)).toContain(JSON.stringify({
    'Fn::If': [
      'CognitoUserPoolCreated',
      { 'Fn::GetAtt': [ownerLogicalId, 'User.Username'] },
      { Ref: 'InitialOwnerUsername' },
    ],
  }));
  expect(JSON.stringify(updateOwner.Properties.Create))
    .toContain(JSON.stringify(COGNITO_USER_POOL_ID_VALUE));
});

test('adds the invited owner to the first system-admin group of a stack-owned pool', () => {
  synthesizedTemplate.hasResource('AWS::Cognito::UserPoolGroup', {
    Condition: 'CognitoUserPoolCreated',
    Properties: Match.objectLike({
      GroupName: {
        'Fn::Select': [0, { 'Fn::Split': [',', { Ref: 'SystemAdminGroups' }] }],
      },
    }),
  });
  const [, addToGroup] = findCustomResource(synthesizedTemplate, 'adminAddUserToGroup');
  expect(addToGroup.Condition).toBe('CognitoUserPoolCreated');
  expect(addToGroup.Properties.Update).toBeUndefined();
});

test('publishes the Cognito IDs the deployment uses', () => {
  synthesizedTemplate.hasOutput('UserPoolId', { Value: COGNITO_USER_POOL_ID_VALUE });
  synthesizedTemplate.hasOutput('UserPoolClientId', {});
});
