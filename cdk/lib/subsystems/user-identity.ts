import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';

/** Inputs that choose between a stack-owned and an existing Cognito user pool. */
export type UserIdentityInput = Readonly<{
  /** Existing user pool ID, or blank to let the stack create one. */
  readonly userPoolIdParameter: cdk.CfnParameter;
  /** Existing password app client ID, or blank to let the stack create one. */
  readonly userPoolClientIdParameter: cdk.CfnParameter;
}>;

/** Cognito identifiers the API and workers use, whichever pool the deployment picked. */
export type UserIdentityResources = Readonly<{
  /** True when both Cognito parameters are blank and the stack owns the user pool. */
  readonly userPoolCreated: cdk.CfnCondition;
  /** Stack-owned user pool, created only under `userPoolCreated`. */
  readonly userPool: cognito.UserPool;
  /** User pool ID the API trusts. */
  readonly userPoolId: string;
  /** Password app client ID the API uses. */
  readonly userPoolClientId: string;
  /** ARN of the user pool the API trusts. */
  readonly userPoolArn: string;
}>;

/**
 * Creates the Cognito user pool and password client unless the deployment passes existing ones.
 *
 * Leaving `CognitoUserPoolId` and `CognitoUserPoolClientId` blank makes the stack own a user
 * pool with email invitations, the Workspace custom attributes and a public password client.
 * Passing both keeps the existing pool, as earlier deployments did. The pool is retained when
 * the stack is deleted because it holds every user's sign-in.
 *
 * @param scope Stack scope used directly to keep construct paths flat.
 * @param input Parameters that pick an existing pool and client.
 * @returns Conditions and the resolved Cognito identifiers, also published as stack outputs.
 */
export function buildUserIdentity(
  scope: cdk.Stack,
  input: UserIdentityInput,
): UserIdentityResources {
  const userPoolIdBlank = cdk.Fn.conditionEquals(input.userPoolIdParameter.valueAsString, '');
  const userPoolCreated = new cdk.CfnCondition(scope, 'CognitoUserPoolCreated', {
    expression: userPoolIdBlank,
  });

  const userPool = new cognito.UserPool(scope, 'UserPool', {
    selfSignUpEnabled: false,
    signInCaseSensitive: false,
    // Email is not a required schema attribute, because Cognito expects a client to write every
    // required attribute and the password client must not write email. The API and the owner
    // invitation always set it.
    standardAttributes: {
      email: { required: false, mutable: true },
    },
    customAttributes: {
      directory_id: new cognito.StringAttribute({ mutable: true }),
      workspace_id: new cognito.StringAttribute({ mutable: true }),
    },
    autoVerify: { email: true },
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    passwordPolicy: {
      minLength: 12,
      requireDigits: true,
      requireLowercase: true,
      requireSymbols: true,
      requireUppercase: true,
      tempPasswordValidity: cdk.Duration.days(7),
    },
    mfa: cognito.Mfa.OPTIONAL,
    mfaSecondFactor: { otp: true, sms: false },
    featurePlan: cognito.FeaturePlan.ESSENTIALS,
    deletionProtection: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  const userPoolClient = userPool.addClient('UserPoolPasswordClient', {
    authFlows: { userPassword: true },
    // The API authorizes by email and the Workspace attributes, so a user's own access token
    // must not rewrite them. Only the display name stays writable.
    writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ fullname: true }),
    disableOAuth: true,
    generateSecret: false,
    preventUserExistenceErrors: true,
  });
  for (const resource of [userPool, userPoolClient]) {
    (resource.node.defaultChild as cdk.CfnResource).cfnOptions.condition = userPoolCreated;
  }

  const userPoolId = cdk.Token.asString(cdk.Fn.conditionIf(
    userPoolCreated.logicalId,
    userPool.userPoolId,
    input.userPoolIdParameter.valueAsString,
  ));
  const userPoolClientId = cdk.Token.asString(cdk.Fn.conditionIf(
    userPoolCreated.logicalId,
    userPoolClient.userPoolClientId,
    input.userPoolClientIdParameter.valueAsString,
  ));
  const userPoolArn = scope.formatArn({
    service: 'cognito-idp',
    resource: 'userpool',
    resourceName: userPoolId,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });

  new cdk.CfnOutput(scope, 'UserPoolId', {
    description: 'Cognito user pool the API trusts.',
    value: userPoolId,
  });
  new cdk.CfnOutput(scope, 'UserPoolClientId', {
    description: 'Cognito password app client the API uses.',
    value: userPoolClientId,
  });

  return {
    userPoolCreated,
    userPool,
    userPoolId,
    userPoolClientId,
    userPoolArn,
  };
}
