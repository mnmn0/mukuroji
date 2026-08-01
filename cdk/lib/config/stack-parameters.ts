import * as cdk from 'aws-cdk-lib';

/**
 * CloudFormation parameters and derived values shared by stack subsystems.
 */
export interface StackParameters {
  /** Primary and secondary same-environment SNS topic ARNs for alarm actions. */
  readonly alarmNotificationTopicArns: readonly [string, string];
  /** Origins accepted by the public API and file storage CORS policies. */
  readonly taskApiAllowedOrigins: cdk.CfnParameter;
  /** Tokenized list derived from the allowed origins parameter. */
  readonly taskApiAllowedOriginList: string[];
  /** Response headers exposed by both HTTP transports. */
  readonly taskApiExposedHeaders: string[];
  /** Secrets Manager prefix for outbound automation Webhook secrets. */
  readonly automationWebhookSecretPrefix: string;
  /** ARN pattern covering outbound automation Webhook secrets. */
  readonly automationWebhookSecretArn: string;
  /** Secrets Manager prefix for inbound automation Webhook secrets. */
  readonly automationInboundWebhookSecretPrefix: string;
  /** ARN pattern covering inbound automation Webhook secrets. */
  readonly automationInboundWebhookSecretArn: string;
  /** Comma-separated Cognito groups with system administrator access. */
  readonly systemAdminGroups: cdk.CfnParameter;
  /** Audit event retention period in days. */
  readonly auditRetentionDays: cdk.CfnParameter;
  /** Secret JSON configuration loaded by connector runtimes. */
  readonly connectorRuntimeConfiguration: cdk.CfnParameter;
  /** Stable HMAC key used to pseudonymize workspace audit identities. */
  readonly workspaceAuditPseudonymKey: cdk.CfnParameter;
  /** Existing IAM role exclusively authorized to approve restore-drill cleanup. */
  readonly restoreDrillCleanupApproverRoleArn: cdk.CfnParameter;
  /** Operator-incremented immutable API configuration revision. */
  readonly apiRuntimeConfigurationRevision: cdk.CfnParameter;
  /** Explicit two-phase production writer-fence rollout mode. */
  readonly workspaceSearchWriterFenceMode: cdk.CfnParameter;
  /** Anonymous request submission limit per capability and hour. */
  readonly requestRateLimitPerHour: cdk.CfnParameter;
  /** Secret authenticating request intake email Webhooks. */
  readonly requestEmailWebhookSecret: cdk.CfnParameter;
  /** Secret used to hash public request and reply tokens. */
  readonly requestTokenHashSecret: cdk.CfnParameter;
  /** Secret used to hash enterprise identity credentials. */
  readonly enterpriseIdentityTokenHashSecret: cdk.CfnParameter;
  /** File metadata and noncurrent object retention period in days. */
  readonly fileRetentionDays: cdk.CfnParameter;
  /** Presigned file upload URL lifetime in seconds. */
  readonly fileUploadUrlTtlSeconds: cdk.CfnParameter;
  /** Presigned file download URL lifetime in seconds. */
  readonly fileDownloadUrlTtlSeconds: cdk.CfnParameter;
  /** Existing Cognito user pool identifier. */
  readonly cognitoUserPoolId: cdk.CfnParameter;
  /** Existing Cognito application client identifier used by the API. */
  readonly cognitoUserPoolClientId: cdk.CfnParameter;
  /** Dedicated Cognito application client identifier used by enterprise SSO. */
  readonly cognitoSsoUserPoolClientId: cdk.CfnParameter;
  /** Cognito managed-login domain used by enterprise federation. */
  readonly cognitoHostedUiDomain: cdk.CfnParameter;
  /** Exact SPA callback URI registered for enterprise SSO. */
  readonly cognitoSsoRedirectUri: cdk.CfnParameter;
  /** Cognito identity-provider name used by enterprise federation. */
  readonly cognitoEnterpriseIdpName: cdk.CfnParameter;
  /** Secret used to sign enterprise SSO state. */
  readonly enterpriseSsoStateSecret: cdk.CfnParameter;
  /** Canonical workspace directory identifier. */
  readonly workspaceDirectoryId: cdk.CfnParameter;
  /** Lowercase email address of the initial workspace owner. */
  readonly initialOwnerEmail: cdk.CfnParameter;
  /** Cognito username of the initial workspace owner. */
  readonly initialOwnerUsername: cdk.CfnParameter;
  /** ARN of the existing Cognito user pool. */
  readonly cognitoUserPoolArn: string;
}

/**
 * Creates stack-level CloudFormation parameters without introducing a nested construct scope.
 *
 * @param stack - Stack that directly owns the parameters and validation rules.
 * @returns Parameters and derived values consumed by the stack subsystems.
 */
export function buildStackParameters(stack: cdk.Stack): StackParameters {
  const alarmPrimaryTopicName = new cdk.CfnParameter(
    stack,
    'AlarmPrimaryTopicName',
    {
      type: 'String',
      minLength: 1,
      maxLength: 256,
      allowedPattern: '^[A-Za-z0-9_-]+$',
      constraintDescription:
        'AlarmPrimaryTopicName must be the name of a standard SNS topic in this stack account and region.',
      description:
        'Existing standard SNS topic used as the primary destination for every CloudWatch alarm.',
    },
  );
  const alarmSecondaryTopicName = new cdk.CfnParameter(
    stack,
    'AlarmSecondaryTopicName',
    {
      type: 'String',
      minLength: 1,
      maxLength: 256,
      allowedPattern: '^[A-Za-z0-9_-]+$',
      constraintDescription:
        'AlarmSecondaryTopicName must be the name of a standard SNS topic in this stack account and region.',
      description:
        'Existing standard SNS topic used as the secondary destination for every CloudWatch alarm.',
    },
  );
  new cdk.CfnRule(stack, 'AlarmNotificationTopicSeparation', {
    assertions: [{
      assert: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(
        alarmPrimaryTopicName.valueAsString,
        alarmSecondaryTopicName.valueAsString,
      )),
      assertDescription:
        'AlarmPrimaryTopicName must differ from AlarmSecondaryTopicName.',
    }],
  });
  const alarmNotificationTopicArns: readonly [string, string] = [
    stack.formatArn({
      service: 'sns',
      resource: alarmPrimaryTopicName.valueAsString,
    }),
    stack.formatArn({
      service: 'sns',
      resource: alarmSecondaryTopicName.valueAsString,
    }),
  ];
  const taskApiAllowedOrigins = new cdk.CfnParameter(stack, 'TaskApiAllowedOrigins', {
    type: 'String',
    default: 'http://localhost:5173,http://127.0.0.1:5173',
    allowedPattern: '^https?://[^,\\s]+(,https?://[^,\\s]+)*$',
    constraintDescription:
      'TaskApiAllowedOrigins must be a comma-separated list of HTTP(S) origins without whitespace.',
    description: 'Comma-separated CORS origins allowed to call the mukuroji API.',
  });
  const taskApiAllowedOriginList = cdk.Fn.split(',', taskApiAllowedOrigins.valueAsString);
  const taskApiExposedHeaders = [
    'content-disposition',
    'idempotency-replayed',
    'ratelimit-limit',
    'ratelimit-remaining',
    'ratelimit-reset',
    'retry-after',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'x-correlation-id',
    'x-request-id',
  ];
  const automationWebhookSecretPrefix = 'mukuroji/automation-webhooks';
  const automationWebhookSecretArn = stack.formatArn({
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    service: 'secretsmanager',
    resource: 'secret',
    resourceName: `${automationWebhookSecretPrefix}/*`,
  });
  const automationInboundWebhookSecretPrefix = 'mukuroji/automation-inbound-webhooks';
  const automationInboundWebhookSecretArn = stack.formatArn({
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    service: 'secretsmanager',
    resource: 'secret',
    resourceName: `${automationInboundWebhookSecretPrefix}/*`,
  });
  const systemAdminGroups = new cdk.CfnParameter(stack, 'SystemAdminGroups', {
    type: 'String',
    default: 'mukuroji-system-admins',
    description: 'Comma-separated Cognito group names that grant system administrator privileges.',
  });
  const auditRetentionDays = new cdk.CfnParameter(stack, 'AuditRetentionDays', {
    type: 'Number',
    default: 2555,
    minValue: 1,
    description: 'Number of days immutable audit events are retained before DynamoDB TTL expiry.',
  });
  const connectorRuntimeConfiguration = new cdk.CfnParameter(
    stack,
    'ConnectorRuntimeConfiguration',
    {
      type: 'String',
      default: '{}',
      noEcho: true,
      description:
        'Secret JSON object whose string properties are loaded as connector runtime environment variables.',
    },
  );
  const workspaceAuditPseudonymKey = new cdk.CfnParameter(
    stack,
    'WorkspaceAuditPseudonymKey',
    {
      type: 'String',
      noEcho: true,
      allowedPattern: '^[0-9a-f]{64}$',
      constraintDescription:
        'WorkspaceAuditPseudonymKey must be exactly 64 lowercase hexadecimal characters.',
      description:
        'Stable 32-byte random HMAC key encoded as lowercase hexadecimal for non-PII Workspace member and invitation audit identifiers.',
    },
  );
  const restoreDrillCleanupApproverRoleArn = new cdk.CfnParameter(
    stack,
    'RestoreDrillCleanupApproverRoleArn',
    {
      type: 'String',
      allowedPattern:
        '^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$',
      constraintDescription:
        'RestoreDrillCleanupApproverRoleArn must be an explicit IAM role ARN.',
      description:
        'Existing data-owner IAM role exclusively authorized to create and admit immutable restore-drill cleanup approvals.',
    },
  );
  const apiRuntimeConfigurationRevision = new cdk.CfnParameter(
    stack,
    'ApiRuntimeConfigurationRevision',
    {
      type: 'String',
      minLength: 1,
      maxLength: 32,
      allowedPattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$',
      constraintDescription:
        'ApiRuntimeConfigurationRevision must be a 1-32 character deployment revision.',
      description:
        'Operator-incremented revision that replaces immutable API configuration secrets and publishes a matching Lambda version.',
    },
  );
  const workspaceSearchWriterFenceMode = new cdk.CfnParameter(
    stack,
    'WorkspaceSearchWriterFenceMode',
    {
      type: 'String',
      allowedValues: ['rollout-pending', 'required'],
      description:
        'Explicit writer-fence rollout phase. Use rollout-pending only while AppConfig is disabled and writers are drained before the first open-row bootstrap; use required after bootstrap.',
    },
  );
  const requestRateLimitPerHour = new cdk.CfnParameter(stack, 'RequestRateLimitPerHour', {
    type: 'Number',
    default: 10,
    minValue: 1,
    maxValue: 10_000,
    description: 'Maximum anonymous request submissions accepted per capability and hour.',
  });
  const requestEmailWebhookSecret = new cdk.CfnParameter(stack, 'RequestEmailWebhookSecret', {
    type: 'String',
    minLength: 32,
    maxLength: 256,
    noEcho: true,
    description: 'Secret used to authenticate request intake email envelopes.',
  });
  const requestTokenHashSecret = new cdk.CfnParameter(stack, 'RequestTokenHashSecret', {
    type: 'String',
    minLength: 32,
    maxLength: 256,
    noEcho: true,
    description: 'Secret used to hash public request and reply capability tokens.',
  });
  const enterpriseIdentityTokenHashSecret = new cdk.CfnParameter(
    stack,
    'EnterpriseIdentityTokenHashSecret',
    {
      type: 'String',
      minLength: 32,
      maxLength: 256,
      noEcho: true,
      description:
        'Stable secret used to HMAC enterprise identity bearer and service-account credentials.',
    },
  );
  const fileRetentionDays = new cdk.CfnParameter(stack, 'FileRetentionDays', {
    type: 'Number',
    default: 30,
    minValue: 1,
    description:
      'Number of days deleted file metadata and noncurrent S3 object versions are retained.',
  });
  const fileUploadUrlTtlSeconds = new cdk.CfnParameter(stack, 'FileUploadUrlTtlSeconds', {
    type: 'Number',
    default: 600,
    minValue: 60,
    maxValue: 3600,
    description: 'Lifetime in seconds for direct-to-S3 upload URLs.',
  });
  const fileDownloadUrlTtlSeconds = new cdk.CfnParameter(stack, 'FileDownloadUrlTtlSeconds', {
    type: 'Number',
    default: 300,
    minValue: 60,
    maxValue: 3600,
    description: 'Lifetime in seconds for clean-file download URLs.',
  });
  const cognitoUserPoolId = new cdk.CfnParameter(stack, 'CognitoUserPoolId', {
    type: 'String',
    allowedPattern: '^[a-z]{2}(?:-[a-z0-9]+)+_[A-Za-z0-9]+$',
    description: 'Existing Cognito user pool ID trusted by the mukuroji API.',
  });
  const cognitoUserPoolClientId = new cdk.CfnParameter(stack, 'CognitoUserPoolClientId', {
    type: 'String',
    allowedPattern: '^[A-Za-z0-9]+$',
    description: 'Existing Cognito app client ID used by the mukuroji API.',
  });
  const cognitoSsoUserPoolClientId = new cdk.CfnParameter(
    stack,
    'CognitoSsoUserPoolClientId',
    {
      type: 'String',
      allowedPattern: '^[A-Za-z0-9]+$',
      description:
        'Dedicated public Cognito app client ID restricted to enterprise Hosted UI login.',
    },
  );
  const cognitoHostedUiDomain = new cdk.CfnParameter(stack, 'CognitoHostedUiDomain', {
    type: 'String',
    minLength: 1,
    description: 'HTTPS Cognito managed-login domain used for enterprise federation.',
  });
  const cognitoSsoRedirectUri = new cdk.CfnParameter(stack, 'CognitoSsoRedirectUri', {
    type: 'String',
    allowedPattern: '^https://[^\\s]+$',
    description: 'Exact SPA callback URI registered on the Cognito app client.',
  });
  const cognitoEnterpriseIdpName = new cdk.CfnParameter(
    stack,
    'CognitoEnterpriseIdpName',
    {
      type: 'String',
      minLength: 1,
      maxLength: 128,
      description: 'Cognito identity-provider name used by enterprise SAML/OIDC federation.',
    },
  );
  const enterpriseSsoStateSecret = new cdk.CfnParameter(
    stack,
    'EnterpriseSsoStateSecret',
    {
      type: 'String',
      minLength: 32,
      maxLength: 256,
      noEcho: true,
      description: 'Secret used only to sign short-lived enterprise SSO state.',
    },
  );
  new cdk.CfnRule(stack, 'EnterpriseSecretSeparation', {
    assertions: [{
      assert: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(
        enterpriseSsoStateSecret.valueAsString,
        enterpriseIdentityTokenHashSecret.valueAsString,
      )),
      assertDescription:
        'EnterpriseSsoStateSecret must differ from EnterpriseIdentityTokenHashSecret.',
    }],
  });
  new cdk.CfnRule(stack, 'CognitoClientSeparation', {
    assertions: [{
      assert: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(
        cognitoSsoUserPoolClientId.valueAsString,
        cognitoUserPoolClientId.valueAsString,
      )),
      assertDescription:
        'CognitoSsoUserPoolClientId must differ from CognitoUserPoolClientId.',
    }],
  });
  const workspaceDirectoryId = new cdk.CfnParameter(stack, 'WorkspaceDirectoryId', {
    type: 'String',
    minLength: 1,
    allowedPattern: '^\\S+$',
    constraintDescription: 'WorkspaceDirectoryId must not contain whitespace.',
    description: 'Canonical workspace directory ID shared by Cognito claims and DynamoDB partitions.',
  });
  const initialOwnerEmail = new cdk.CfnParameter(stack, 'InitialOwnerEmail', {
    type: 'String',
    allowedPattern: '^[^A-Z\\s@]+@[^A-Z\\s@]+$',
    constraintDescription: 'InitialOwnerEmail must be a lowercase email address.',
    description: 'Canonical lowercase email address stored for the initial workspace owner.',
  });
  const initialOwnerUsername = new cdk.CfnParameter(stack, 'InitialOwnerUsername', {
    type: 'String',
    minLength: 1,
    allowedPattern: '^\\S+$',
    constraintDescription: 'InitialOwnerUsername must not contain whitespace.',
    description: 'Cognito username targeted when bootstrapping the initial owner attributes.',
  });
  const cognitoUserPoolArn = cdk.Stack.of(stack).formatArn({
    service: 'cognito-idp',
    resource: 'userpool',
    resourceName: cognitoUserPoolId.valueAsString,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });

  return {
    alarmNotificationTopicArns,
    taskApiAllowedOrigins,
    taskApiAllowedOriginList,
    taskApiExposedHeaders,
    automationWebhookSecretPrefix,
    automationWebhookSecretArn,
    automationInboundWebhookSecretPrefix,
    automationInboundWebhookSecretArn,
    systemAdminGroups,
    auditRetentionDays,
    connectorRuntimeConfiguration,
    workspaceAuditPseudonymKey,
    restoreDrillCleanupApproverRoleArn,
    apiRuntimeConfigurationRevision,
    workspaceSearchWriterFenceMode,
    requestRateLimitPerHour,
    requestEmailWebhookSecret,
    requestTokenHashSecret,
    enterpriseIdentityTokenHashSecret,
    fileRetentionDays,
    fileUploadUrlTtlSeconds,
    fileDownloadUrlTtlSeconds,
    cognitoUserPoolId,
    cognitoUserPoolClientId,
    cognitoSsoUserPoolClientId,
    cognitoHostedUiDomain,
    cognitoSsoRedirectUri,
    cognitoEnterpriseIdpName,
    enterpriseSsoStateSecret,
    workspaceDirectoryId,
    initialOwnerEmail,
    initialOwnerUsername,
    cognitoUserPoolArn,
  };
}
