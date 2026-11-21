import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';

/** Days an invited user's temporary password stays valid; the invitation email states it. */
const TEMPORARY_PASSWORD_VALIDITY_DAYS = 7;

/** Pattern for an empty value or one email address, the same as `NotificationEmailSender`. */
const OPTIONAL_EMAIL_ADDRESS_PATTERN = '^(?:|[^\\s@,;<>"]+@[^\\s@,;<>"]+\\.[^\\s@,;<>"]+)$';

/** Pattern for an empty value, one email address, or one lowercase domain name. */
const OPTIONAL_SES_IDENTITY_PATTERN =
  '^(?:|[^\\s@,;<>"]+@[^\\s@,;<>"]+\\.[^\\s@,;<>"]+|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$';

/** Inputs that choose between a stack-owned and an existing Cognito user pool. */
export type UserIdentityInput = Readonly<{
  /** Existing user pool ID, or blank to let the stack create one. */
  readonly userPoolIdParameter: cdk.CfnParameter;
  /** Existing password app client ID, or blank to let the stack create one. */
  readonly userPoolClientIdParameter: cdk.CfnParameter;
  /**
   * Canonical app URL, without a trailing slash, that the invitation and verification email
   * link to. The stack passes a lazy value because the Web distribution is built later.
   */
  readonly webOrigin: string;
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
 * The stack-owned pool sends bilingual invitation and verification email that link to the app.
 * With `CognitoEmailSender` empty it keeps Cognito's own email sending, which allows only a few
 * messages a day. With it set the pool sends from that address through SES in the stack's
 * region, authorized by `CognitoEmailSesIdentity`, or by the address itself when that is empty.
 * An existing user pool keeps its own email settings, so a rule rejects a sender for it instead
 * of ignoring the value.
 *
 * @param scope Stack scope used directly to keep construct paths flat.
 * @param input Parameters that pick an existing pool and client, and the app URL.
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
    userInvitation: buildInvitationEmail(input.webOrigin),
    // Cognito sends the verification template for password reset codes, including the one an
    // administrator's reset sends, and for email address verification.
    userVerification: {
      ...buildVerificationEmail(input.webOrigin),
      emailStyle: cognito.VerificationEmailStyle.CODE,
    },
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    passwordPolicy: {
      minLength: 12,
      requireDigits: true,
      requireLowercase: true,
      requireSymbols: true,
      requireUppercase: true,
      tempPasswordValidity: cdk.Duration.days(TEMPORARY_PASSWORD_VALIDITY_DAYS),
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
    // The Web refreshes the access token before it expires, so one sign-in lasts as long as the
    // refresh token while the user keeps working. "Keep me signed in" keeps the tokens in
    // localStorage across browser restarts; without it they live only in the tab's
    // sessionStorage. A Workspace security policy can still end a session earlier through its
    // session lifetime and idle timeout. Sign-out revokes the refresh token, which needs
    // revocation enabled.
    accessTokenValidity: cdk.Duration.minutes(60),
    idTokenValidity: cdk.Duration.minutes(60),
    refreshTokenValidity: cdk.Duration.days(30),
    enableTokenRevocation: true,
  });
  for (const resource of [userPool, userPoolClient]) {
    (resource.node.defaultChild as cdk.CfnResource).cfnOptions.condition = userPoolCreated;
  }
  const cfnUserPool = userPool.node.defaultChild;
  if (!(cfnUserPool instanceof cognito.CfnUserPool)) {
    throw new Error('The stack-owned user pool must have a CfnUserPool default child.');
  }
  cfnUserPool.emailConfiguration = declareUserPoolEmailSending(scope, userPoolIdBlank);

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

/**
 * Declares the parameters, rule, and conditions that send the stack-owned pool's email through
 * SES, and returns the pool's `EmailConfiguration`.
 *
 * Without `CognitoEmailSender` the value resolves to no property, which keeps Cognito's default
 * email sending.
 *
 * @param scope Stack that directly owns the parameters, rule, and conditions.
 * @param userPoolIdBlank Condition that is true when the stack creates the user pool.
 * @returns The conditional `EmailConfiguration` of the stack-owned user pool.
 */
function declareUserPoolEmailSending(
  scope: cdk.Stack,
  userPoolIdBlank: cdk.ICfnConditionExpression,
): cdk.IResolvable {
  const sender = new cdk.CfnParameter(scope, 'CognitoEmailSender', {
    type: 'String',
    default: '',
    minLength: 0,
    maxLength: 254,
    allowedPattern: OPTIONAL_EMAIL_ADDRESS_PATTERN,
    constraintDescription: 'CognitoEmailSender must be empty or one email address.',
    description:
      'SES-verified sender address for the stack-owned user pool\'s invitation and password reset email. Empty keeps Cognito\'s default email, which sends only a few messages a day.',
  });
  const sesIdentity = new cdk.CfnParameter(scope, 'CognitoEmailSesIdentity', {
    type: 'String',
    default: '',
    minLength: 0,
    maxLength: 254,
    allowedPattern: OPTIONAL_SES_IDENTITY_PATTERN,
    constraintDescription:
      'CognitoEmailSesIdentity must be empty, one email address, or one lowercase domain name.',
    description:
      'Verified SES identity that authorizes CognitoEmailSender: the address itself or its domain. Empty uses CognitoEmailSender.',
  });
  const senderBlank = cdk.Fn.conditionEquals(sender.valueAsString, '');
  const sesIdentityBlank = cdk.Fn.conditionEquals(sesIdentity.valueAsString, '');
  new cdk.CfnRule(scope, 'CognitoEmailParametersValid', {
    assertions: [
      {
        assert: cdk.Fn.conditionOr(sesIdentityBlank, cdk.Fn.conditionNot(senderBlank)),
        assertDescription: 'CognitoEmailSesIdentity needs CognitoEmailSender.',
      },
      {
        assert: cdk.Fn.conditionOr(senderBlank, userPoolIdBlank),
        assertDescription:
          'CognitoEmailSender applies only to a user pool the stack creates. Configure SES on an existing user pool in Cognito instead.',
      },
    ],
  });
  const sendsThroughSes = new cdk.CfnCondition(scope, 'CognitoEmailSentThroughSes', {
    expression: cdk.Fn.conditionNot(senderBlank),
  });
  const sesIdentityDefaulted = new cdk.CfnCondition(scope, 'CognitoEmailSesIdentityDefaulted', {
    expression: sesIdentityBlank,
  });
  const sourceArn = scope.formatArn({
    service: 'ses',
    resource: 'identity',
    resourceName: cdk.Token.asString(cdk.Fn.conditionIf(
      sesIdentityDefaulted.logicalId,
      sender.valueAsString,
      sesIdentity.valueAsString,
    )),
  });
  return cdk.Fn.conditionIf(
    sendsThroughSes.logicalId,
    {
      EmailSendingAccount: 'DEVELOPER',
      From: sender.valueAsString,
      SourceArn: sourceArn,
    },
    cdk.Aws.NO_VALUE,
  );
}

/** Subject and HTML body of one Cognito email template. */
type CognitoEmailTemplate = Readonly<{
  /** Subject line, in Japanese and English. */
  readonly emailSubject: string;
  /** HTML body, in Japanese and then English. */
  readonly emailBody: string;
}>;

/**
 * Builds the invitation Cognito sends with a temporary password.
 *
 * Cognito replaces `{username}` with the sign-in name and `{####}` with the temporary password.
 *
 * @param webOrigin Canonical app URL without a trailing slash.
 * @returns The bilingual subject and HTML body.
 */
function buildInvitationEmail(webOrigin: string): CognitoEmailTemplate {
  const loginUrl = `${webOrigin}/login`;
  const link = `<a href="${loginUrl}">${loginUrl}</a>`;
  return {
    emailSubject: 'Mukuroji への招待 / Your Mukuroji invitation',
    emailBody: [
      '<p>Mukuroji に招待されました。</p>',
      '<p>ユーザー名: {username}<br>仮パスワード: {####}</p>',
      `<p>${link} でサインインし、新しいパスワードを設定してください。`
        + `仮パスワードの有効期限は ${TEMPORARY_PASSWORD_VALIDITY_DAYS} 日です。`
        + '期限が切れた場合は、招待した管理者に再送を依頼してください。</p>',
      '<hr>',
      '<p>You have been invited to Mukuroji.</p>',
      '<p>Username: {username}<br>Temporary password: {####}</p>',
      `<p>Sign in at ${link} and set a new password. `
        + `The temporary password expires in ${TEMPORARY_PASSWORD_VALIDITY_DAYS} days. `
        + 'If it has expired, ask the administrator who invited you to send it again.</p>',
    ].join('\n'),
  };
}

/**
 * Builds the verification email Cognito sends for a password reset or an email change.
 *
 * Cognito replaces `{####}` with the code; this template has no username placeholder.
 *
 * @param webOrigin Canonical app URL without a trailing slash.
 * @returns The bilingual subject and HTML body.
 */
function buildVerificationEmail(webOrigin: string): CognitoEmailTemplate {
  const resetUrl = `${webOrigin}/forgot-password`;
  const link = `<a href="${resetUrl}">${resetUrl}</a>`;
  return {
    emailSubject: 'Mukuroji の確認コード / Your Mukuroji verification code',
    emailBody: [
      '<p>Mukuroji の確認コード: {####}</p>',
      '<p>パスワードを再設定するときは、再設定画面でこのコードと新しいパスワードを入力してください。'
        + `画面を開いていない場合は ${link} から始めると、新しいコードが届きます。`
        + '心当たりがない場合は、このメールを無視してください。</p>',
      '<hr>',
      '<p>Your Mukuroji verification code: {####}</p>',
      '<p>To reset your password, enter this code and a new password on the reset page. '
        + `If the page is not open, start at ${link} and a new code will be sent. `
        + 'If you did not request this, you can ignore this email.</p>',
    ].join('\n'),
  };
}
