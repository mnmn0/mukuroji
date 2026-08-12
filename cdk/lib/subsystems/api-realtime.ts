import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import {
  resolveLambdaHandlerEntry,
  type LambdaBuildPaths,
} from '../config/lambda-build-paths';
import type { StackParameters } from '../config/stack-parameters';
import {
  grantWorkspaceSearchWriterFenceAccess,
  type WorkspaceSearchWriterFenceResources,
} from '../policies/workspace-search-writer-fence';
import type { DataStoreResources } from './data-stores';
import type { FileStorageResources } from './file-storage';
import {
  bindRuntimeControls,
  RUNTIME_CONTROL_MAXIMUM_STALENESS_SECONDS,
  RUNTIME_CONTROL_MINIMUM_POLL_INTERVAL_SECONDS,
  type RuntimeControlResources,
} from './runtime-controls';
import type { WorkerChannels } from './workers/channels';

/**
 * Inputs required to build the shared API Lambda runtime.
 */
export interface ApiRuntimeInput {
  /** Shared data stores used by API operations. */
  readonly dataStores: DataStoreResources;
  /** File storage resources used by upload, proofing, and import operations. */
  readonly fileStorage: FileStorageResources;
  /** Stable paths used to bundle the API Lambda. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters and derived security configuration. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Durable queues targeted by API mutations. */
  readonly workerChannels: WorkerChannels;
  /** Exact source, target, and state tables protected by the writer fence. */
  readonly workspaceSearchWriterFence: WorkspaceSearchWriterFenceResources;
}

/**
 * Shared API runtime resources used by transports and storage policy configuration.
 */
export type ApiRuntimeResources = Readonly<{
  /** Lambda that runs the shared Hono API handler. */
  readonly apiFunction: lambdaNodejs.NodejsFunction;
}>;

/**
 * Inputs required to expose the API and build realtime WebSocket transport.
 */
export interface ApiTransportsAndRealtimeInput {
  /** Shared API Lambda runtime. */
  readonly apiRuntime: ApiRuntimeResources;
  /** Shared data stores used by realtime authentication and session handling. */
  readonly dataStores: DataStoreResources;
  /** File storage resources exposed through API configuration. */
  readonly fileStorage: FileStorageResources;
  /** Stable paths used to bundle the realtime Lambda. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters and derived transport configuration. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Durable queues exposed through API configuration. */
  readonly workerChannels: WorkerChannels;
  /** Exact tables and rollout mode protected by the writer fence. */
  readonly workspaceSearchWriterFence: WorkspaceSearchWriterFenceResources;
}

/**
 * Public API and realtime transport resources consumed by workers and outputs.
 */
export type ApiTransportsAndRealtimeResources = Readonly<{
  /** Live alias receiving all public API traffic. */
  readonly apiLiveAlias: lambda.Alias;
  /** Public Lambda Function URL for the shared API handler. */
  readonly functionUrl: lambda.FunctionUrl;
  /** HTTP API Gateway backed by the shared API handler. */
  readonly httpApi: apigatewayv2.HttpApi;
  /** Auto-deployed production WebSocket stage. */
  readonly realtimeWebSocketStage: apigatewayv2.WebSocketStage;
  /** Retained Workspace audit pseudonym secret shared with lifecycle workers. */
  readonly workspaceAuditPseudonymSecret: secretsmanager.ISecret;
}>;

/**
 * Creates an error-ratio expression for eligible API server errors.
 *
 * @param period - Aggregation window used for both eligible request metrics.
 * @returns A metric-math expression for the eligible server-error ratio.
 */
function createApiAvailabilityErrorRatioMetric(
  period: cdk.Duration,
): cloudwatch.MathExpression {
  const metricConfiguration = {
    namespace: 'Mukuroji/API',
    dimensionsMap: {
      Service: 'mukuroji-api',
    },
    period,
    statistic: 'Sum',
  };

  return new cloudwatch.MathExpression({
    expression: 'eligibleErrors / eligibleRequests',
    label: 'API availability error ratio',
    period,
    usingMetrics: {
      eligibleErrors: new cloudwatch.Metric({
        ...metricConfiguration,
        metricName: 'EligibleServerErrorCount',
      }),
      eligibleRequests: new cloudwatch.Metric({
        ...metricConfiguration,
        metricName: 'EligibleRequestCount',
      }),
    },
  });
}

/**
 * Creates one retained secret containing a single sensitive API value.
 *
 * Keeping NoEcho parameter references outside the configuration envelope
 * prevents macro processing from materializing plaintext into a processed
 * CloudFormation template.
 *
 * @param scope - Stack that owns the sensitive-value secret.
 * @param constructId - Stable construct identifier.
 * @param nameSegment - Bounded physical-name segment for this sensitive value.
 * @param configurationRevision - Operator-incremented immutable configuration revision.
 * @param description - Operational purpose shown in Secrets Manager.
 * @param value - NoEcho parameter value stored without JSON transformation.
 * @returns The retained sensitive-value secret.
 */
function createApiRuntimeSensitiveValueSecret(
  scope: cdk.Stack,
  constructId: string,
  nameSegment: string,
  configurationRevision: string,
  description: string,
  value: string,
): secretsmanager.Secret {
  const secretNamePrefix = cdk.Names.uniqueResourceName(scope, {
    allowedSpecialCharacters: '-',
    maxLength: 36,
    separator: '-',
  });

  return new secretsmanager.Secret(scope, constructId, {
    description,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    secretName: cdk.Fn.join('-', [
      secretNamePrefix,
      nameSegment,
      'v1',
      configurationRevision,
    ]),
    secretStringValue: cdk.SecretValue.unsafePlainText(value),
  });
}

/** Exact transform-free header required by the API configuration loader. */
const apiRuntimeConfigurationEnvelopeHeader =
  'mukuroji-api-runtime-configuration-v2\n';

/**
 * Creates one encoded line tuple for deterministic configuration ordering.
 *
 * @param name - Canonical environment-variable name.
 * @param kind - Whether the decoded payload is a value or nested secret ARN.
 * @param source - Deployment-time string encoded by CloudFormation.
 * @returns Sortable immutable line tuple.
 */
function createApiRuntimeConfigurationLine(
  name: string,
  kind: 'secret' | 'value',
  source: string,
): readonly [string, 'secret' | 'value', string] {
  return [name, kind, source];
}

/**
 * Creates one retained, versioned-schema API configuration secret.
 *
 * The line envelope uses ordinary Fn::Join and Fn::Base64 intrinsics so
 * arbitrary parameter values remain JSON-independent without a macro that
 * resolves NoEcho parameters into the processed template. Sensitive values
 * are represented only by nested Secrets Manager ARNs.
 *
 * @param scope - Stack that owns the configuration secret.
 * @param constructId - Stable construct identifier.
 * @param nameSegment - Bounded physical-name segment for this configuration group.
 * @param group - Exact group identity validated by the runtime loader.
 * @param configurationRevision - Operator-incremented immutable configuration revision.
 * @param description - Operational purpose shown in Secrets Manager.
 * @param values - Canonical API environment names and non-secret deployment-time values.
 * @param secretValues - Canonical names whose values are loaded from nested secrets.
 * @returns The retained configuration secret.
 */
function createApiRuntimeConfigurationSecret(
  scope: cdk.Stack,
  constructId: string,
  nameSegment: string,
  group: 'core' | 'data' | 'identity' | 'workflow',
  configurationRevision: string,
  description: string,
  values: Readonly<Record<string, string>>,
  secretValues: Readonly<Record<string, secretsmanager.ISecret>> = {},
): secretsmanager.Secret {
  const secretNamePrefix = cdk.Names.uniqueResourceName(scope, {
    allowedSpecialCharacters: '-',
    maxLength: 36,
    separator: '-',
  });
  const duplicateName = Object.keys(secretValues)
    .find((name) => Object.hasOwn(values, name));
  if (duplicateName) {
    throw new Error(
      `API runtime configuration source ${duplicateName} is duplicated.`,
    );
  }
  const lines = [
    ...Object.entries(values).map(([name, value]) =>
      createApiRuntimeConfigurationLine(name, 'value', value)),
    ...Object.entries(secretValues).map(([name, secret]) =>
      createApiRuntimeConfigurationLine(name, 'secret', secret.secretArn)),
  ].sort(([leftName], [rightName]) =>
    leftName < rightName ? -1 : leftName > rightName ? 1 : 0);
  if (lines.length === 0 ||
      lines.some(([name]) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new Error('API runtime configuration names are invalid.');
  }
  const secretStringParts: string[] = [
    `${apiRuntimeConfigurationEnvelopeHeader}group:${group}\nrevision:`,
    cdk.Fn.base64(configurationRevision),
  ];
  for (const [name, kind, source] of lines) {
    secretStringParts.push(`\n${kind}:${name}:`);
    secretStringParts.push(cdk.Fn.base64(source));
  }
  secretStringParts.push('\n');

  return new secretsmanager.Secret(scope, constructId, {
    description,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    secretName: cdk.Fn.join('-', [
      secretNamePrefix,
      nameSegment,
      'v2',
      configurationRevision,
    ]),
    secretStringValue: cdk.SecretValue.unsafePlainText(
      cdk.Fn.join('', secretStringParts),
    ),
  });
}

/**
 * Stores complete API configuration outside Lambda's 4 KB environment quota
 * and grants the API execution role read access to each bounded group.
 *
 * @param scope - Stack that owns the configuration secrets.
 * @param input - API resources, parameters, controls, and writer-fence values.
 * @param apiFunction - Replacement API function receiving only secret ARNs.
 * @param httpApi - HTTP API whose stable endpoint is exposed to automation.
 * @param realtimeWebSocketStage - WebSocket stage exposed to the API.
 * @returns The retained pseudonym secret shared with trusted lifecycle workers.
 */
function bindApiRuntimeConfiguration(
  scope: cdk.Stack,
  input: ApiTransportsAndRealtimeInput,
  apiFunction: lambdaNodejs.NodejsFunction,
  httpApi: apigatewayv2.HttpApi,
  realtimeWebSocketStage: apigatewayv2.WebSocketStage,
): secretsmanager.ISecret {
  const {
    analyticsTable,
    auditEventsTable,
    automationTable,
    capacityPlanningTable,
    collaborationTable,
    connectorRuntimeSecret,
    developerPlatformConnectorKey,
    developerPlatformStateKey,
    developerPlatformTable,
    developerPlatformWebhookKey,
    documentPublicShareTokenSecret,
    documentsTable,
    enterpriseIdentityTable,
    tenantAdministrationTable,
    legacyTasksTable,
    notificationsTable,
    focusTable,
    planningTable,
    projectDirectoryTable,
    realtimeSessionsTable,
    requestIntakeTable,
    teamIssueEventsTable,
    workItemConfigurationTable,
    workItemsTable,
    workspaceAccessTable,
    workspaceSearchTable,
  } = input.dataStores;
  const {
    fileBucket,
    fileProofingTable,
    workItemImportBucket,
  } = input.fileStorage;
  const {
    auditRetentionDays,
    apiRuntimeConfigurationRevision,
    automationInboundWebhookSecretPrefix,
    automationWebhookSecretPrefix,
    cognitoEnterpriseIdpName,
    cognitoHostedUiDomain,
    cognitoSsoRedirectUri,
    cognitoSsoUserPoolClientId,
    cognitoUserPoolClientId,
    cognitoUserPoolId,
    enterpriseIdentityTokenHashSecret,
    enterpriseSsoStateSecret,
    fileDownloadUrlTtlSeconds,
    fileRetentionDays,
    fileUploadUrlTtlSeconds,
    requestRateLimitPerHour,
    requestTokenHashSecret,
    systemAdminGroups,
    taskApiAllowedOrigins,
    workspaceAuditPseudonymKey,
    workspaceDirectoryId,
  } = input.parameters;
  const {
    webhookDeliveryQueue,
    workItemImportQueue,
  } = input.workerChannels;
  const enterpriseIdentityTokenHashValueSecret =
    createApiRuntimeSensitiveValueSecret(
      scope,
      'ApiEnterpriseIdentityTokenHashValueSecret',
      'api-enterprise-identity-token-hash',
      apiRuntimeConfigurationRevision.valueAsString,
      'Revision-bound Enterprise Identity token-hash value consumed by the API.',
      enterpriseIdentityTokenHashSecret.valueAsString,
    );
  const enterpriseSsoStateValueSecret =
    createApiRuntimeSensitiveValueSecret(
      scope,
      'ApiEnterpriseSsoStateValueSecret',
      'api-enterprise-sso-state',
      apiRuntimeConfigurationRevision.valueAsString,
      'Revision-bound Enterprise SSO state-signing value consumed by the API.',
      enterpriseSsoStateSecret.valueAsString,
    );
  const requestTokenHashValueSecret =
    createApiRuntimeSensitiveValueSecret(
      scope,
      'ApiRequestTokenHashValueSecret',
      'api-request-token-hash',
      apiRuntimeConfigurationRevision.valueAsString,
      'Revision-bound request capability token-hash value consumed by the API.',
      requestTokenHashSecret.valueAsString,
    );
  const workspaceAuditPseudonymValueSecret =
    createApiRuntimeSensitiveValueSecret(
      scope,
      'ApiWorkspaceAuditPseudonymValueSecret',
      'api-workspace-audit-pseudonym',
      apiRuntimeConfigurationRevision.valueAsString,
      'Revision-bound Workspace audit pseudonym value consumed by the API.',
      workspaceAuditPseudonymKey.valueAsString,
    );

  const coreConfigurationSecret = createApiRuntimeConfigurationSecret(
    scope,
    'ApiCoreRuntimeConfigurationSecret',
    'api-core-config',
    'core',
    apiRuntimeConfigurationRevision.valueAsString,
    'Versioned core, identity, transport, and runtime-control configuration for the API.',
    {
      ALLOWED_ORIGINS: taskApiAllowedOrigins.valueAsString,
      AUTOMATION_INBOUND_WEBHOOK_BASE_URL: httpApi.apiEndpoint,
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID:
        input.runtimeControls.applicationId,
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID:
        input.runtimeControls.configurationProfileId,
      MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID:
        input.runtimeControls.environmentId,
      MUKUROJI_RUNTIME_CONTROL_MAX_STALE_SECONDS:
        String(RUNTIME_CONTROL_MAXIMUM_STALENESS_SECONDS),
      MUKUROJI_RUNTIME_CONTROL_MIN_POLL_INTERVAL_SECONDS:
        String(RUNTIME_CONTROL_MINIMUM_POLL_INTERVAL_SECONDS),
      MUKUROJI_RUNTIME_CONTROL_SCOPE: 'api',
      MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE:
        input.workspaceSearchWriterFence.runtimeMode,
      REALTIME_WEBSOCKET_URL: realtimeWebSocketStage.url,
    },
  );
  const identityConfigurationSecret = createApiRuntimeConfigurationSecret(
    scope,
    'ApiIdentityRuntimeConfigurationSecret',
    'api-identity-config',
    'identity',
    apiRuntimeConfigurationRevision.valueAsString,
    'Versioned identity, federation, and workspace configuration for the API.',
    {
      COGNITO_CLIENT_ID: cognitoUserPoolClientId.valueAsString,
      COGNITO_ENTERPRISE_IDP_NAME:
        cognitoEnterpriseIdpName.valueAsString,
      COGNITO_HOSTED_UI_DOMAIN: cognitoHostedUiDomain.valueAsString,
      COGNITO_SSO_CLIENT_ID: cognitoSsoUserPoolClientId.valueAsString,
      COGNITO_SSO_REDIRECT_URI: cognitoSsoRedirectUri.valueAsString,
      COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
      MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
      MUKUROJI_WORKSPACE_DIRECTORY_ID: workspaceDirectoryId.valueAsString,
    },
  );
  const dataConfigurationSecret = createApiRuntimeConfigurationSecret(
    scope,
    'ApiDataRuntimeConfigurationSecret',
    'api-data-config',
    'data',
    apiRuntimeConfigurationRevision.valueAsString,
    'Versioned table, index, encryption-key, and durable data configuration for the API.',
    {
      ANALYTICS_SCHEDULE_INDEX_NAME: 'ScheduleDueIndex',
      ANALYTICS_TABLE_NAME: analyticsTable.tableName,
      AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
      AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
      AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX:
        automationInboundWebhookSecretPrefix,
      AUTOMATION_TABLE_NAME: automationTable.tableName,
      AUTOMATION_WEBHOOK_SECRET_PREFIX: automationWebhookSecretPrefix,
      COLLABORATION_TABLE_NAME: collaborationTable.tableName,
      CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN:
        connectorRuntimeSecret.secretArn,
      DEVELOPER_PLATFORM_CONNECTOR_KMS_KEY_ID:
        developerPlatformConnectorKey.keyArn,
      DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
      DEVELOPER_PLATFORM_STATE_KMS_KEY_ID:
        developerPlatformStateKey.keyArn,
      DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
      DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID:
        developerPlatformWebhookKey.keyArn,
      DOCUMENTS_TABLE_NAME: documentsTable.tableName,
      ENTERPRISE_IDENTITY_TABLE_NAME: enterpriseIdentityTable.tableName,
      TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
      MUKUROJI_PROJECT_TASKS_TABLE: legacyTasksTable.tableName,
      MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
      PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
      WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
      WORKSPACE_SEARCH_MIGRATION_STATE_TABLE_NAME:
        input.workspaceSearchWriterFence.migrationStateTable.tableName,
      WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
      WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
    },
  );
  const workflowConfigurationSecret = createApiRuntimeConfigurationSecret(
    scope,
    'ApiWorkflowRuntimeConfigurationSecret',
    'api-workflow-config',
    'workflow',
    apiRuntimeConfigurationRevision.valueAsString,
    'Versioned workflow, file, queue, and sensitive runtime configuration for the API.',
    {
      FILE_BUCKET_NAME: fileBucket.bucketName,
      FILE_DOWNLOAD_URL_TTL_SECONDS:
        fileDownloadUrlTtlSeconds.valueAsString,
      FILE_PROOFING_TABLE_NAME: fileProofingTable.tableName,
      FILE_RETENTION_DAYS: fileRetentionDays.valueAsString,
      FILE_UPLOAD_URL_TTL_SECONDS: fileUploadUrlTtlSeconds.valueAsString,
      NOTIFICATIONS_STATUS_INDEX_NAME: 'RecipientStatusIndex',
      NOTIFICATIONS_TABLE_NAME: notificationsTable.tableName,
      FOCUS_TABLE_NAME: focusTable.tableName,
      CAPACITY_PLANNING_TABLE_NAME: capacityPlanningTable.tableName,
      PLANNING_TABLE_NAME: planningTable.tableName,
      REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
      REQUEST_INTAKE_TABLE_NAME: requestIntakeTable.tableName,
      REQUEST_QUEUE_INDEX_NAME: 'RequestQueueIndex',
      REQUEST_RATE_LIMIT_PER_HOUR: requestRateLimitPerHour.valueAsString,
      TRIAGE_OWNER_ACTIVITY_INDEX_NAME: 'triage-owner-activity-index',
      TRIAGE_TEAM_ACTIVITY_INDEX_NAME: 'triage-team-activity-index',
      TRIAGE_WAKE_INDEX_NAME: 'triage-wake-index',
      WEBHOOK_DELIVERY_QUEUE_URL: webhookDeliveryQueue.queueUrl,
      WORK_ITEM_CONFIGURATION_TABLE_NAME:
        workItemConfigurationTable.tableName,
      WORK_ITEM_IMPORT_BUCKET_NAME: workItemImportBucket.bucketName,
      WORK_ITEM_IMPORT_QUEUE_URL: workItemImportQueue.queueUrl,
    },
    {
      DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET:
        documentPublicShareTokenSecret,
      ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET:
        enterpriseIdentityTokenHashValueSecret,
      ENTERPRISE_SSO_STATE_SECRET: enterpriseSsoStateValueSecret,
      MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY:
        workspaceAuditPseudonymValueSecret,
      REQUEST_TOKEN_HASH_SECRET: requestTokenHashValueSecret,
    },
  );

  apiFunction.addEnvironment(
    'MUKUROJI_API_CORE_CONFIG_SECRET_ARN',
    coreConfigurationSecret.secretArn,
  );
  apiFunction.addEnvironment(
    'MUKUROJI_API_DATA_CONFIG_SECRET_ARN',
    dataConfigurationSecret.secretArn,
  );
  apiFunction.addEnvironment(
    'MUKUROJI_API_IDENTITY_CONFIG_SECRET_ARN',
    identityConfigurationSecret.secretArn,
  );
  apiFunction.addEnvironment(
    'MUKUROJI_API_WORKFLOW_CONFIG_SECRET_ARN',
    workflowConfigurationSecret.secretArn,
  );
  coreConfigurationSecret.grantRead(apiFunction);
  dataConfigurationSecret.grantRead(apiFunction);
  identityConfigurationSecret.grantRead(apiFunction);
  workflowConfigurationSecret.grantRead(apiFunction);
  documentPublicShareTokenSecret.grantRead(apiFunction);
  enterpriseIdentityTokenHashValueSecret.grantRead(apiFunction);
  enterpriseSsoStateValueSecret.grantRead(apiFunction);
  requestTokenHashValueSecret.grantRead(apiFunction);
  workspaceAuditPseudonymValueSecret.grantRead(apiFunction);
  return workspaceAuditPseudonymValueSecret;
}

/**
 * Builds the shared API Lambda, environment, grants, and focused IAM policies.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Shared parameters, stores, file resources, queues, and Lambda build paths.
 * @returns API runtime resources consumed by transports and file policy configuration.
 */
export function buildApiRuntime(
  scope: cdk.Stack,
  input: ApiRuntimeInput,
): ApiRuntimeResources {
  const {
    analyticsTable,
    auditEventsTable,
    automationTable,
    capacityPlanningTable,
    collaborationTable,
    connectorRuntimeSecret,
    developerPlatformConnectorKey,
    developerPlatformStateKey,
    developerPlatformTable,
    developerPlatformWebhookKey,
    documentsTable,
    enterpriseIdentityTable,
    tenantAdministrationTable,
    legacyTasksTable,
    notificationsTable,
    focusTable,
    planningTable,
    projectDirectoryTable,
    realtimeSessionsTable,
    requestIntakeTable,
    teamIssueEventsTable,
    workItemConfigurationTable,
    workItemsTable,
    workspaceAccessTable,
    workspaceSearchTable,
  } = input.dataStores;
  const {
    fileBucket,
    fileProofingTable,
    workItemImportBucket,
  } = input.fileStorage;
  const {
    automationInboundWebhookSecretArn,
    automationWebhookSecretArn,
    cognitoUserPoolArn,
  } = input.parameters;
  const {
    webhookDeliveryQueue,
    workItemImportQueue,
  } = input.workerChannels;
  const {
    depsLockFilePath,
    projectRoot,
  } = input.lambdaBuildPaths;
  const apiFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'ListProjectTasksFunction',
    {
      entry: resolveLambdaHandlerEntry(input.lambdaBuildPaths, 'api.handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      functionName: `${cdk.Names.uniqueResourceName(scope, {
        allowedSpecialCharacters: '-',
        maxLength: 56,
        separator: '-',
      })}-api-v2`,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      description: 'Bundled shared Hono handler for the mukuroji Function URL and HTTP API.',
      currentVersionOptions: {
        description: cdk.Fn.join(' ', [
          'API runtime configuration revision',
          input.parameters.apiRuntimeConfigurationRevision.valueAsString,
        ]),
      },
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    },
  );
  grantWorkspaceSearchWriterFenceAccess(
    input.workspaceSearchWriterFence,
    apiFunction,
  );
  bindRuntimeControls(input.runtimeControls, apiFunction, 'api', false);

  legacyTasksTable.grants.readData(apiFunction);
  workItemsTable.grants.readWriteData(apiFunction);
  teamIssueEventsTable.grants.readWriteData(apiFunction);
  projectDirectoryTable.grants.readWriteData(apiFunction);
  auditEventsTable.grants.readWriteData(apiFunction);
  workspaceAccessTable.grants.readWriteData(apiFunction);
  tenantAdministrationTable.grants.readWriteData(apiFunction);
  documentsTable.grants.readWriteData(apiFunction);
  collaborationTable.grants.readWriteData(apiFunction);
  fileProofingTable.grants.readWriteData(apiFunction);
  notificationsTable.grants.readWriteData(apiFunction);
  apiFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
    ],
    resources: [focusTable.tableArn],
  }));
  workspaceSearchTable.grants.readWriteData(apiFunction);
  realtimeSessionsTable.grants.readWriteData(apiFunction);
  const apiCapacityPlanningDataPolicy = new iam.Policy(
    scope,
    'ApiCapacityPlanningDataPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: [
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
        ],
        resources: [capacityPlanningTable.tableArn],
      })],
    },
  );
  const apiAutomationDataPolicy = new iam.Policy(
    scope,
    'ApiAutomationDataPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: [
          'dynamodb:ConditionCheckItem',
          'dynamodb:DeleteItem',
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:UpdateItem',
        ],
        resources: [automationTable.tableArn, `${automationTable.tableArn}/index/*`],
      })],
    },
  );
  const apiEnterpriseIdentityDataPolicy = new iam.Policy(
    scope,
    'ApiEnterpriseIdentityDataPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: [
          'dynamodb:BatchWriteItem',
          'dynamodb:DeleteItem',
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:UpdateItem',
        ],
        resources: [enterpriseIdentityTable.tableArn],
      })],
    },
  );
  const apiWorkItemConfigurationDataPolicy = new iam.Policy(
    scope,
    'ApiWorkItemConfigurationDataPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: [
          'dynamodb:DeleteItem',
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:UpdateItem',
        ],
        resources: [workItemConfigurationTable.tableArn],
      })],
    },
  );
  const apiRequestIntakeDataPolicy = new iam.Policy(
    scope,
    'ApiRequestIntakeDataPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: [
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:UpdateItem',
        ],
        resources: [
          requestIntakeTable.tableArn,
          `${requestIntakeTable.tableArn}/index/*`,
        ],
      })],
    },
  );
  const apiTransactionConditionCheckPolicy = new iam.Policy(
    scope,
    'ApiTransactWritePolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: ['dynamodb:ConditionCheckItem'],
        resources: [
          workItemsTable.tableArn,
          requestIntakeTable.tableArn,
          projectDirectoryTable.tableArn,
          workspaceAccessTable.tableArn,
          planningTable.tableArn,
          enterpriseIdentityTable.tableArn,
          workItemConfigurationTable.tableArn,
          documentsTable.tableArn,
          collaborationTable.tableArn,
          fileProofingTable.tableArn,
          focusTable.tableArn,
          workspaceSearchTable.tableArn,
        ],
        conditions: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
      })],
    },
  );
  const apiDeveloperPlatformDataPolicy = new iam.Policy(
    scope,
    'ApiDeveloperPlatformDataPolicy',
    {
      statements: [
        new iam.PolicyStatement({
          actions: [
            'dynamodb:ConditionCheckItem',
            'dynamodb:DeleteItem',
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:Query',
            'dynamodb:UpdateItem',
          ],
          resources: [developerPlatformTable.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ['dynamodb:Query'],
          resources: [
            `${developerPlatformTable.tableArn}/index/LookupKeyIndex`,
          ],
        }),
        new iam.PolicyStatement({
          actions: ['sqs:SendMessage'],
          resources: [
            webhookDeliveryQueue.queueArn,
            workItemImportQueue.queueArn,
          ],
        }),
      ],
    },
  );
  if (!apiFunction.role) {
    throw new Error('API Lambda execution role was not created.');
  }
  apiFunction.role.attachInlinePolicy(new iam.Policy(
    scope,
    'ApiDeveloperPlatformKmsPolicy',
    {
      statements: [
        new iam.PolicyStatement({
          actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
          resources: [developerPlatformWebhookKey.keyArn],
          conditions: {
            StringEquals: {
              'kms:EncryptionContext:mukuroji:purpose': 'webhook',
              'kms:EncryptionContext:mukuroji:service':
                'developer-platform',
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
          resources: [developerPlatformConnectorKey.keyArn],
          conditions: {
            StringEquals: {
              'kms:EncryptionContext:mukuroji:purpose': 'connector',
              'kms:EncryptionContext:mukuroji:service':
                'developer-platform',
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
          resources: [developerPlatformStateKey.keyArn],
          conditions: {
            StringEquals: {
              'kms:EncryptionContext:mukuroji:purpose': 'platform-state',
              'kms:EncryptionContext:mukuroji:service':
                'developer-platform',
            },
          },
        }),
      ],
    },
  ));
  const apiPlanningDataPolicy = new iam.Policy(scope, 'ApiPlanningDataPolicy', {
    statements: [new iam.PolicyStatement({
      actions: [
        'dynamodb:DeleteItem',
        'dynamodb:DescribeTable',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
      ],
      resources: [planningTable.tableArn],
    })],
  });
  const apiAnalyticsDataPolicy = new iam.Policy(scope, 'ApiAnalyticsDataPolicy', {
    statements: [
      new iam.PolicyStatement({
        actions: [
          'dynamodb:DeleteItem',
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:UpdateItem',
        ],
        resources: [analyticsTable.tableArn],
      }),
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${analyticsTable.tableArn}/index/TimeEntryTeamDateIndex`],
      }),
    ],
  });
  const apiAuditTransactionDataPolicy = new iam.Policy(
    scope,
    'ApiAuditTransactionDataPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: ['dynamodb:ConditionCheckItem', 'dynamodb:PutItem'],
        resources: [auditEventsTable.tableArn],
        conditions: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
      })],
    },
  );
  apiFunction.role.attachInlinePolicy(apiAutomationDataPolicy);
  apiFunction.role.attachInlinePolicy(apiEnterpriseIdentityDataPolicy);
  apiFunction.role.attachInlinePolicy(apiWorkItemConfigurationDataPolicy);
  apiFunction.role.attachInlinePolicy(apiDeveloperPlatformDataPolicy);
  apiFunction.role.attachInlinePolicy(apiPlanningDataPolicy);
  apiFunction.role.attachInlinePolicy(apiCapacityPlanningDataPolicy);
  apiFunction.role.attachInlinePolicy(apiAnalyticsDataPolicy);
  apiFunction.role.attachInlinePolicy(apiAuditTransactionDataPolicy);
  apiFunction.role.attachInlinePolicy(apiRequestIntakeDataPolicy);
  apiFunction.role.attachInlinePolicy(apiTransactionConditionCheckPolicy);
  connectorRuntimeSecret.grantRead(apiFunction);
  apiFunction.role.attachInlinePolicy(new iam.Policy(
    scope,
    'ApiAutomationWebhookSecretPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [automationWebhookSecretArn],
      })],
    },
  ));
  apiFunction.role.attachInlinePolicy(new iam.Policy(
    scope,
    'ApiAutomationInboundWebhookSecretPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:DeleteSecret',
          'secretsmanager:DescribeSecret',
          'secretsmanager:GetSecretValue',
          'secretsmanager:PutSecretValue',
        ],
        resources: [automationInboundWebhookSecretArn],
      })],
    },
  ));
  apiFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        's3:DeleteObject',
        's3:GetObject',
        's3:GetObjectAttributes',
        's3:GetObjectVersion',
        's3:GetObjectVersionTagging',
        's3:PutObject',
        's3:PutObjectVersionTagging',
      ],
      resources: [fileBucket.arnForObjects('workspaces/*')],
    }),
  );
  apiFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        's3:DeleteObjectVersion',
        's3:GetObject',
        's3:GetObjectVersion',
        's3:PutObject',
      ],
      resources: [workItemImportBucket.arnForObjects('work-item-imports/*')],
    }),
  );
  apiFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminDeleteUserAttributes',
        'cognito-idp:AdminDisableUser',
        'cognito-idp:AdminEnableUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminListGroupsForUser',
        'cognito-idp:AdminUserGlobalSignOut',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:DescribeIdentityProvider',
        'cognito-idp:DescribeUserPoolClient',
        'cognito-idp:GetUser',
        'cognito-idp:ListUsers',
      ],
      resources: [cognitoUserPoolArn],
    }),
  );
  apiFunction.role.attachInlinePolicy(new iam.Policy(
    scope,
    'ApiReadinessPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: ['dynamodb:DescribeTable'],
        resources: [
          auditEventsTable.tableArn,
          workItemsTable.tableArn,
          workspaceAccessTable.tableArn,
        ],
      })],
    },
  ));

  new cloudwatch.Alarm(scope, 'ApiFunctionErrorAlarm', {
    alarmDescription:
      'Detects unhandled or infrastructure errors returned by the shared API Lambda.',
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: apiFunction.metric('Errors', {
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  new cloudwatch.Alarm(scope, 'ApiFunctionThrottleAlarm', {
    alarmDescription:
      'Detects shared API Lambda requests rejected by concurrency throttling.',
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: apiFunction.metricThrottles({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  new cloudwatch.Alarm(scope, 'ApiFunctionLatencyAlarm', {
    alarmDescription:
      'Detects sustained p95 shared API Lambda latency above the operational budget.',
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 2,
    evaluationPeriods: 3,
    metric: apiFunction.metricDuration({
      period: cdk.Duration.minutes(5),
      statistic: 'p95',
    }),
    threshold: cdk.Duration.seconds(12).toMilliseconds(),
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  new cloudwatch.Alarm(scope, 'ApiApplicationServerErrorAlarm', {
    alarmDescription:
      'Detects API requests that the application completed with a server-error response.',
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: new cloudwatch.Metric({
      namespace: 'Mukuroji/API',
      metricName: 'ServerErrorCount',
      dimensionsMap: {
        Service: 'mukuroji-api',
      },
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  const apiAvailabilityFastBurnFiveMinuteAlarm = new cloudwatch.Alarm(
    scope,
    'ApiAvailabilityFastBurnFiveMinuteAlarm',
    {
      actionsEnabled: false,
      alarmDescription:
        'Detects a 14.4x API availability error-budget burn over five minutes.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: createApiAvailabilityErrorRatioMetric(cdk.Duration.minutes(5)),
      threshold: 0.0144,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    },
  );
  const apiAvailabilityFastBurnOneHourAlarm = new cloudwatch.Alarm(
    scope,
    'ApiAvailabilityFastBurnOneHourAlarm',
    {
      actionsEnabled: false,
      alarmDescription:
        'Detects a 14.4x API availability error-budget burn over one hour.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: createApiAvailabilityErrorRatioMetric(cdk.Duration.hours(1)),
      threshold: 0.0144,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    },
  );
  new cloudwatch.CompositeAlarm(scope, 'ApiAvailabilityFastBurnAlarm', {
    alarmDescription:
      'Pages when both API availability fast-burn windows exceed 14.4x.',
    alarmRule: cloudwatch.AlarmRule.allOf(
      apiAvailabilityFastBurnFiveMinuteAlarm,
      apiAvailabilityFastBurnOneHourAlarm,
    ),
  });

  return { apiFunction };
}

/**
 * Builds the API HTTP transports and realtime WebSocket runtime.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input API runtime, shared stores, parameters, and Lambda build paths.
 * @returns Public API transports and the realtime WebSocket stage.
 */
export function buildApiTransportsAndRealtime(
  scope: cdk.Stack,
  input: ApiTransportsAndRealtimeInput,
): ApiTransportsAndRealtimeResources {
  const { apiFunction } = input.apiRuntime;
  const {
    enterpriseIdentityTable,
    projectDirectoryTable,
    realtimeSessionsTable,
    workItemsTable,
    workspaceAccessTable,
  } = input.dataStores;
  const {
    cognitoEnterpriseIdpName,
    cognitoUserPoolArn,
    cognitoUserPoolId,
    systemAdminGroups,
    taskApiAllowedOriginList,
    taskApiExposedHeaders,
  } = input.parameters;
  const {
    depsLockFilePath,
    projectRoot,
  } = input.lambdaBuildPaths;

  const httpApi = new apigatewayv2.HttpApi(scope, 'ProjectTasksHttpApi', {
    description: 'HTTP API backed by the same bundled Hono Lambda as the Function URL.',
    corsPreflight: {
      allowOrigins: taskApiAllowedOriginList,
      allowMethods: [
        apigatewayv2.CorsHttpMethod.GET,
        apigatewayv2.CorsHttpMethod.POST,
        apigatewayv2.CorsHttpMethod.PUT,
        apigatewayv2.CorsHttpMethod.PATCH,
        apigatewayv2.CorsHttpMethod.DELETE,
        apigatewayv2.CorsHttpMethod.OPTIONS,
      ],
      allowHeaders: [
        'authorization',
        'content-type',
        'idempotency-key',
        'x-correlation-id',
        'x-request-id',
      ],
      exposeHeaders: taskApiExposedHeaders,
    },
  });
  new cloudwatch.Alarm(scope, 'ApiGatewayServerErrorAlarm', {
    alarmDescription:
      'Detects HTTP API responses that fail before or within the shared API integration.',
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: httpApi.metricServerError({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  const realtimeFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'RealtimeHandlerFunction',
    {
      entry: resolveLambdaHandlerEntry(input.lambdaBuildPaths, 'realtime-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      description: 'Consumes one-time tickets and handles mukuroji WebSocket presence events.',
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        COGNITO_ENTERPRISE_IDP_NAME: cognitoEnterpriseIdpName.valueAsString,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        ENTERPRISE_IDENTITY_TABLE_NAME: enterpriseIdentityTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
        REALTIME_SESSION_TTL_SECONDS: '3600',
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
      },
    },
  );
  bindRuntimeControls(input.runtimeControls, realtimeFunction, 'realtime');
  const realtimeIntegration = new apigatewayv2Integrations.WebSocketLambdaIntegration(
    'RealtimeLambdaIntegration',
    realtimeFunction,
  );
  const realtimeWebSocketApi = new apigatewayv2.WebSocketApi(
    scope,
    'RealtimeWebSocketApi',
    {
      connectRouteOptions: { integration: realtimeIntegration },
      disconnectRouteOptions: { integration: realtimeIntegration },
      defaultRouteOptions: { integration: realtimeIntegration },
    },
  );
  const realtimeWebSocketStage = new apigatewayv2.WebSocketStage(
    scope,
    'RealtimeWebSocketStage',
    {
      webSocketApi: realtimeWebSocketApi,
      stageName: 'production',
      autoDeploy: true,
    },
  );

  realtimeSessionsTable.grants.readWriteData(realtimeFunction);
  projectDirectoryTable.grants.readData(realtimeFunction);
  realtimeFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query'],
    resources: [enterpriseIdentityTable.tableArn],
  }));
  workItemsTable.grants.readData(realtimeFunction);
  workspaceAccessTable.grants.readData(realtimeFunction);
  realtimeFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminListGroupsForUser',
        'cognito-idp:DescribeIdentityProvider',
      ],
      resources: [cognitoUserPoolArn],
    }),
  );
  realtimeWebSocketStage.grantManagementApiAccess(realtimeFunction);

  const workspaceAuditPseudonymSecret = bindApiRuntimeConfiguration(
    scope,
    input,
    apiFunction,
    httpApi,
    realtimeWebSocketStage,
  );
  const apiVersion = apiFunction.currentVersion;
  const apiLiveAlias = new lambda.Alias(scope, 'ApiLiveAlias', {
    aliasName: 'live',
    version: apiVersion,
  });
  new apigatewayv2.HttpRoute(httpApi, 'DefaultRoute', {
    httpApi,
    integration: new apigatewayv2Integrations.HttpLambdaIntegration(
      'SharedHonoHandlerIntegration',
      apiLiveAlias,
      {
        payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
        scopePermissionToRoute: false,
      },
    ),
    routeKey: apigatewayv2.HttpRouteKey.DEFAULT,
  });
  const functionUrl = apiLiveAlias.addFunctionUrl({
    authType: lambda.FunctionUrlAuthType.NONE,
    cors: {
      allowedOrigins: taskApiAllowedOriginList,
      allowedMethods: [
        lambda.HttpMethod.GET,
        lambda.HttpMethod.POST,
        lambda.HttpMethod.PUT,
        lambda.HttpMethod.PATCH,
        lambda.HttpMethod.DELETE,
      ],
      allowedHeaders: [
        'authorization',
        'content-type',
        'idempotency-key',
        'x-correlation-id',
        'x-request-id',
      ],
      exposedHeaders: taskApiExposedHeaders,
    },
  });

  return {
    apiLiveAlias,
    functionUrl,
    httpApi,
    realtimeWebSocketStage,
    workspaceAuditPseudonymSecret,
  };
}
