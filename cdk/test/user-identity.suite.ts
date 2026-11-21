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
        Match.objectLike({ Name: 'email', Required: false, Mutable: true }),
        Match.objectLike({ Name: 'directory_id', AttributeDataType: 'String', Mutable: true }),
        Match.objectLike({ Name: 'workspace_id', AttributeDataType: 'String', Mutable: true }),
      ]),
    }),
  });
  synthesizedTemplate.hasResource('AWS::Cognito::UserPoolClient', {
    Condition: 'CognitoUserPoolCreated',
    Properties: Match.objectLike({
      // Users must not rewrite the email or Workspace attributes the API authorizes by.
      WriteAttributes: ['name'],
      ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      GenerateSecret: false,
      PreventUserExistenceErrors: 'ENABLED',
      AllowedOAuthFlowsUserPoolClient: false,
      // Sessions refresh for up to 30 days, and sign-out revokes the refresh token.
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 43200,
      TokenValidityUnits: {
        AccessToken: 'minutes',
        IdToken: 'minutes',
        RefreshToken: 'minutes',
      },
      EnableTokenRevocation: true,
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
  // The invitation runs once; stack updates must not resend it. Its physical ID is the
  // username, so consumers read it through Ref instead of a create-only response field.
  expect(createOwner.Properties.Update).toBeUndefined();
  expect(create).toContain('"physicalResourceId":{"id":"{{Ref:InitialOwnerUsername}}"}');

  const [, updateOwner] = findCustomResource(synthesizedTemplate, 'adminUpdateUserAttributes');
  // An existing pool keeps its own owner, so the update has no condition and orders itself after
  // the invitation through the Fn::If on the username instead of a DependsOn.
  expect(updateOwner.Condition).toBeUndefined();
  expect(updateOwner.DependsOn).not.toContain(ownerLogicalId);
  expect(JSON.stringify(updateOwner.Properties.Create)).toContain(JSON.stringify({
    'Fn::If': [
      'CognitoUserPoolCreated',
      { Ref: ownerLogicalId },
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
  const [ownerLogicalId] = findCustomResource(synthesizedTemplate, 'adminCreateUser');
  const [, addToGroup] = findCustomResource(synthesizedTemplate, 'adminAddUserToGroup');
  expect(addToGroup.Condition).toBe('CognitoUserPoolCreated');
  // Membership follows a renamed group, so the idempotent call also runs on update.
  expect(addToGroup.Properties.Update).toEqual(addToGroup.Properties.Create);
  expect(serializeAwsSdkCall(addToGroup.Properties.Create))
    .toContain(`"Username":"{{Ref:${ownerLogicalId}}}"`);
});

test('publishes the Cognito IDs the deployment uses', () => {
  synthesizedTemplate.hasOutput('UserPoolId', { Value: COGNITO_USER_POOL_ID_VALUE });
  synthesizedTemplate.hasOutput('UserPoolClientId', {});
});

/**
 * Returns the properties of the only synthesized Cognito user pool.
 *
 * @returns The user pool's CloudFormation properties.
 */
function requireUserPoolProperties(): Record<string, unknown> {
  const pools = Object.values(synthesizedTemplate.findResources('AWS::Cognito::UserPool'));
  expect(pools).toHaveLength(1);
  return pools[0].Properties;
}

test('sends the stack-owned pool email through SES only when CognitoEmailSender is set', () => {
  const template = synthesizedTemplate.toJSON();
  expect(template.Parameters.CognitoEmailSender).toEqual(expect.objectContaining({
    Type: 'String',
    Default: '',
  }));
  expect(template.Parameters.CognitoEmailSesIdentity).toEqual(expect.objectContaining({
    Type: 'String',
    Default: '',
  }));
  expect(template.Conditions).toEqual(expect.objectContaining({
    CognitoEmailSentThroughSes: {
      'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'CognitoEmailSender' }, ''] }],
    },
    CognitoEmailSesIdentityDefaulted: {
      'Fn::Equals': [{ Ref: 'CognitoEmailSesIdentity' }, ''],
    },
  }));
  // Without a sender the property is absent, so Cognito keeps its default email sending.
  expect(requireUserPoolProperties().EmailConfiguration).toEqual({
    'Fn::If': [
      'CognitoEmailSentThroughSes',
      {
        EmailSendingAccount: 'DEVELOPER',
        From: { Ref: 'CognitoEmailSender' },
        SourceArn: {
          'Fn::Join': ['', [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':ses:',
            { Ref: 'AWS::Region' },
            ':',
            { Ref: 'AWS::AccountId' },
            ':identity/',
            {
              'Fn::If': [
                'CognitoEmailSesIdentityDefaulted',
                { Ref: 'CognitoEmailSender' },
                { Ref: 'CognitoEmailSesIdentity' },
              ],
            },
          ]],
        },
      },
      { Ref: 'AWS::NoValue' },
    ],
  });
});

test('rejects SES email parameters that would be ignored', () => {
  expect(synthesizedTemplate.toJSON().Rules.CognitoEmailParametersValid).toEqual({
    Assertions: [
      {
        Assert: {
          'Fn::Or': [
            { 'Fn::Equals': [{ Ref: 'CognitoEmailSesIdentity' }, ''] },
            { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'CognitoEmailSender' }, ''] }] },
          ],
        },
        AssertDescription: expect.any(String),
      },
      {
        Assert: {
          'Fn::Or': [
            { 'Fn::Equals': [{ Ref: 'CognitoEmailSender' }, ''] },
            { 'Fn::Equals': [{ Ref: 'CognitoUserPoolId' }, ''] },
          ],
        },
        AssertDescription: expect.any(String),
      },
    ],
  });
});

test('writes bilingual invitation and verification email that link to the app', () => {
  const properties = requireUserPoolProperties();
  const serialized = JSON.stringify(properties);
  const adminCreateUser = JSON.stringify(properties.AdminCreateUserConfig);
  expect(adminCreateUser).toContain('"AllowAdminCreateUserOnly":true');
  expect(adminCreateUser).toContain('Mukuroji への招待 / Your Mukuroji invitation');
  expect(adminCreateUser).toContain('{username}');
  expect(adminCreateUser).toContain('{####}');
  expect(adminCreateUser).toContain('仮パスワードの有効期限は 7 日です');
  expect(adminCreateUser).toContain('The temporary password expires in 7 days');
  expect(adminCreateUser).toContain('/login');
  // The link follows the canonical app URL, the custom domain when one is configured.
  expect(adminCreateUser).toContain('"WebCustomDomainConfigured"');

  const verification = JSON.stringify(properties.VerificationMessageTemplate);
  expect(verification).toContain('Mukuroji の確認コード / Your Mukuroji verification code');
  expect(verification).toContain('{####}');
  expect(verification).toContain('/forgot-password');
  expect(verification).toContain('"WebCustomDomainConfigured"');
  // CloudFormation sends the legacy fields too, so they carry the same text.
  expect(properties.VerificationMessageTemplate).toEqual(expect.objectContaining({
    EmailSubject: properties.EmailVerificationSubject,
    EmailMessage: properties.EmailVerificationMessage,
  }));
  expect(serialized).not.toContain('Verify your new account');
});
