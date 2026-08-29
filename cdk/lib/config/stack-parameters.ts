import * as cdk from 'aws-cdk-lib';
import { RegionInfo } from 'aws-cdk-lib/region-info';

const restoreDrillApproverRoleArnSuffix =
  'iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$';
const defaultAiBedrockModelId = 'jp.anthropic.claude-sonnet-4-6';
const bedrockResourceNamePattern = '[A-Za-z0-9._:-]+';
/** Positive decimal price range accepted by both CloudFormation and the runtime. */
const aiBedrockTokenPricePattern =
  '^(?:(?:0\\.[0-9]*[1-9][0-9]*)|(?:[1-9][0-9]{0,5}(?:\\.[0-9]+)?|1000000(?:\\.0+)?))$';

/**
 * Resolves a literal stack partition when CDK has a concrete deployment identity.
 *
 * Environment-agnostic stacks intentionally retain the deploy-time `AWS::Partition`
 * token, which cannot be embedded in a CloudFormation parameter regex.
 *
 * @param stack Stack owning the restore-drill parameter.
 * @returns Literal partition for a concrete stack, otherwise undefined.
 */
function resolveLiteralStackPartition(stack: cdk.Stack): string | undefined {
  const identity = cdk.Stack.of(stack);
  if (!cdk.Token.isUnresolved(identity.partition)) return identity.partition;
  if (cdk.Token.isUnresolved(identity.region)) return undefined;
  const partition = RegionInfo.get(identity.region).partition;
  if (partition === undefined) {
    throw new Error(
      `Unable to resolve an AWS partition for concrete Region ${identity.region}.`,
    );
  }
  return partition;
}

/**
 * Builds an IAM role ARN pattern consistent with the stack deployment identity.
 *
 * @param stack Stack owning the restore-drill parameter.
 * @returns Exact concrete-partition pattern or the supported agnostic partition set.
 */
function buildRestoreDrillApproverRoleArnPattern(stack: cdk.Stack): string {
  const partition = resolveLiteralStackPartition(stack);
  if (partition === undefined) {
    return `^arn:(?:aws|aws-us-gov|aws-cn):${restoreDrillApproverRoleArnSuffix}`;
  }
  if (partition !== 'aws' && partition !== 'aws-us-gov' && partition !== 'aws-cn') {
    throw new Error(`Restore drill does not support the ${partition} AWS partition.`);
  }
  return `^arn:${partition}:${restoreDrillApproverRoleArnSuffix}`;
}

/**
 * Builds a pattern for one exact invokable Bedrock model or inference-profile ARN.
 *
 * @param stack Stack owning the Bedrock model parameter.
 * @returns Pattern restricted to supported partitions and invokable resource types.
 */
function buildAiBedrockModelArnPattern(stack: cdk.Stack): string {
  const partition = resolveLiteralStackPartition(stack);
  const partitionPattern = partition ?? '(?:aws|aws-us-gov|aws-cn)';
  if (partition !== undefined &&
      partition !== 'aws' && partition !== 'aws-us-gov' && partition !== 'aws-cn') {
    throw new Error(`AI assistance does not support the ${partition} AWS partition.`);
  }
  return `^arn:${partitionPattern}:bedrock:(?:[a-z0-9-]*::foundation-model/${bedrockResourceNamePattern}|[a-z0-9-]+:[0-9]{12}:(?:inference-profile|application-inference-profile)/${bedrockResourceNamePattern})$`;
}

/**
 * Builds a pattern for an optional exact comma-separated destination model ARN list.
 *
 * @param stack Stack owning the destination-model parameter.
 * @returns Pattern accepting an empty value or exact foundation-model ARNs only.
 */
function buildAiBedrockDestinationModelArnsPattern(stack: cdk.Stack): string {
  const partition = resolveLiteralStackPartition(stack);
  const partitionPattern = partition ?? '(?:aws|aws-us-gov|aws-cn)';
  if (partition !== undefined &&
      partition !== 'aws' && partition !== 'aws-us-gov' && partition !== 'aws-cn') {
    throw new Error(`AI assistance does not support the ${partition} AWS partition.`);
  }
  const arn = `arn:${partitionPattern}:bedrock:[a-z0-9-]*::foundation-model/${bedrockResourceNamePattern}`;
  return `^(?:|${arn}(?:,${arn})*)$`;
}

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
  /** Exact Bedrock model identifier allowed for AI assistance. */
  readonly aiBedrockModelId: cdk.CfnParameter;
  /** Reviewed Bedrock input-token price in USD per one million tokens. */
  readonly aiBedrockInputPricePerMillionTokensUsd: cdk.CfnParameter;
  /** Reviewed Bedrock output-token price in USD per one million tokens. */
  readonly aiBedrockOutputPricePerMillionTokensUsd: cdk.CfnParameter;
  /** Exact invokable Bedrock model or inference-profile ARN. */
  readonly aiBedrockModelArn: cdk.CfnParameter;
  /** Optional comma-separated exact destination foundation-model ARNs. */
  readonly aiBedrockDestinationModelArns: cdk.CfnParameter;
  /** Whether destination foundation-model permissions must be synthesized. */
  readonly aiBedrockDestinationModelArnsConfigured: cdk.CfnCondition;
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
      allowedPattern: buildRestoreDrillApproverRoleArnPattern(stack),
      constraintDescription:
        'RestoreDrillCleanupApproverRoleArn must be an explicit IAM role ARN in the supported deployment partition.',
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
  const aiBedrockModelId = new cdk.CfnParameter(stack, 'AiBedrockModelId', {
    type: 'String',
    default: defaultAiBedrockModelId,
    minLength: 1,
    maxLength: 256,
    allowedPattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$',
    constraintDescription:
      'AiBedrockModelId must be one exact Bedrock model or inference-profile identifier.',
    description:
      'Exact Bedrock model identifier allowlisted for every AI assistance request.',
  });
  const aiBedrockInputPricePerMillionTokensUsd = new cdk.CfnParameter(
    stack,
    'AiBedrockInputPricePerMillionTokensUsd',
    {
      type: 'String',
      minLength: 1,
      maxLength: 32,
      allowedPattern: aiBedrockTokenPricePattern,
      constraintDescription:
        'AiBedrockInputPricePerMillionTokensUsd must be a positive decimal number no greater than 1000000.',
      description:
        'Deployment-reviewed Bedrock standard input-token price in USD per one million tokens for AiBedrockModelId.',
    },
  );
  const aiBedrockOutputPricePerMillionTokensUsd = new cdk.CfnParameter(
    stack,
    'AiBedrockOutputPricePerMillionTokensUsd',
    {
      type: 'String',
      minLength: 1,
      maxLength: 32,
      allowedPattern: aiBedrockTokenPricePattern,
      constraintDescription:
        'AiBedrockOutputPricePerMillionTokensUsd must be a positive decimal number no greater than 1000000.',
      description:
        'Deployment-reviewed Bedrock standard output-token price in USD per one million tokens for AiBedrockModelId.',
    },
  );
  const aiBedrockModelArn = new cdk.CfnParameter(stack, 'AiBedrockModelArn', {
    type: 'String',
    minLength: 1,
    maxLength: 2_048,
    allowedPattern: buildAiBedrockModelArnPattern(stack),
    constraintDescription:
      'AiBedrockModelArn must be one exact foundation-model or inference-profile ARN in the deployment partition.',
    description:
      'Exact Bedrock model or inference-profile ARN that the API Lambda may invoke.',
  });
  const aiBedrockDestinationModelArns = new cdk.CfnParameter(
    stack,
    'AiBedrockDestinationModelArns',
    {
      type: 'String',
      default: '',
      maxLength: 4_096,
      allowedPattern: buildAiBedrockDestinationModelArnsPattern(stack),
      constraintDescription:
        'AiBedrockDestinationModelArns must be empty or comma-separated exact foundation-model ARNs without whitespace.',
      description:
        'Exact destination foundation-model ARNs required by the configured inference profile; leave empty for direct model invocation.',
    },
  );
  const aiBedrockDestinationModelArnsConfigured = new cdk.CfnCondition(
    stack,
    'AiBedrockDestinationModelArnsConfigured',
    {
      expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(
        aiBedrockDestinationModelArns.valueAsString,
        '',
      )),
    },
  );
  new cdk.CfnRule(stack, 'DefaultAiBedrockModelCompatibility', {
    ruleCondition: cdk.Fn.conditionEquals(
      aiBedrockModelId.valueAsString,
      defaultAiBedrockModelId,
    ),
    assertions: [
      {
        assert: cdk.Fn.conditionOr(
          cdk.Fn.conditionEquals(cdk.Aws.REGION, 'ap-northeast-1'),
          cdk.Fn.conditionEquals(cdk.Aws.REGION, 'ap-northeast-3'),
        ),
        assertDescription:
          'The default JP Claude Sonnet 4.6 profile must be invoked from Tokyo or Osaka.',
      },
      {
        assert: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(
          aiBedrockDestinationModelArns.valueAsString,
          '',
        )),
        assertDescription:
          'The default JP Claude Sonnet 4.6 profile requires exact Tokyo and Osaka destination foundation-model ARNs.',
      },
      {
        assert: cdk.Fn.conditionEquals(
          aiBedrockModelArn.valueAsString,
          cdk.Fn.sub(
            `arn:\${AWS::Partition}:bedrock:\${AWS::Region}:\${AWS::AccountId}:inference-profile/${defaultAiBedrockModelId}`,
          ),
        ),
        assertDescription:
          'The default JP Claude Sonnet 4.6 model ARN must be the regional inference-profile ARN.',
      },
      {
        assert: cdk.Fn.conditionOr(
          cdk.Fn.conditionEquals(
            aiBedrockDestinationModelArns.valueAsString,
            cdk.Fn.join(',', [
              cdk.Fn.sub(
                'arn:${AWS::Partition}:bedrock:ap-northeast-1::foundation-model/anthropic.claude-sonnet-4-6',
              ),
              cdk.Fn.sub(
                'arn:${AWS::Partition}:bedrock:ap-northeast-3::foundation-model/anthropic.claude-sonnet-4-6',
              ),
            ]),
          ),
          cdk.Fn.conditionEquals(
            aiBedrockDestinationModelArns.valueAsString,
            cdk.Fn.join(',', [
              cdk.Fn.sub(
                'arn:${AWS::Partition}:bedrock:ap-northeast-3::foundation-model/anthropic.claude-sonnet-4-6',
              ),
              cdk.Fn.sub(
                'arn:${AWS::Partition}:bedrock:ap-northeast-1::foundation-model/anthropic.claude-sonnet-4-6',
              ),
            ]),
          ),
        ),
        assertDescription:
          'The default JP Claude Sonnet 4.6 profile must include exactly the Tokyo and Osaka foundation-model destinations.',
      },
    ],
  });
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
    aiBedrockModelId,
    aiBedrockInputPricePerMillionTokensUsd,
    aiBedrockOutputPricePerMillionTokensUsd,
    aiBedrockModelArn,
    aiBedrockDestinationModelArns,
    aiBedrockDestinationModelArnsConfigured,
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
