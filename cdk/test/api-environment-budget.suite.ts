/** Registers API runtime configuration quota and rollout tests. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import {
  API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
  API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
  synthesizedTemplate,
} from './test-support';

const API_FUNCTION_LOGICAL_ID = 'ListProjectTasksFunction2134AF4A';
const API_IDENTITY_SECRET_LOGICAL_ID =
  'ApiIdentityRuntimeConfigurationSecret9BDC16DA';
const API_WORKFLOW_SECRET_LOGICAL_ID =
  'ApiWorkflowRuntimeConfigurationSecret225372D1';
const API_ENTERPRISE_IDENTITY_TOKEN_HASH_VALUE_SECRET_LOGICAL_ID =
  'ApiEnterpriseIdentityTokenHashValueSecretD05ED67C';
const API_ENTERPRISE_SSO_STATE_VALUE_SECRET_LOGICAL_ID =
  'ApiEnterpriseSsoStateValueSecret52653A73';
const API_REQUEST_TOKEN_HASH_VALUE_SECRET_LOGICAL_ID =
  'ApiRequestTokenHashValueSecret1C7880D4';
const API_WORKSPACE_AUDIT_PSEUDONYM_VALUE_SECRET_LOGICAL_ID =
  'ApiWorkspaceAuditPseudonymValueSecretC16FD0F8';
const DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET_LOGICAL_ID =
  'DocumentPublicShareTokenSecret3151B43C';
const API_CONFIGURATION_ENVELOPE_HEADER =
  'mukuroji-api-runtime-configuration-v2\n';
const API_CONFIGURATION_SECRET_LIMIT_BYTES = 65_536;
const LAMBDA_ENVIRONMENT_LIMIT_BYTES = 4_096;
const CLOUDFORMATION_PARAMETER_LIMIT_BYTES = 4_096;

/**
 * Reads the shared API runtime-name declaration without importing another
 * workspace's TypeScript source into the NodeNext CDK compiler.
 *
 * @returns Canonical names extracted from the deliberately simple declaration.
 */
function readSharedApiRuntimeEnvironmentVariableNames(): string[] {
  const source = readFileSync(
    resolve(
      __dirname,
      '../../contracts/src/api-runtime-configuration.ts',
    ),
    'utf8',
  );
  const declaration = source.match(
    /Object\.freeze\(\[([\s\S]*?)\]\)/u,
  );
  if (!declaration?.[1]) {
    throw new Error('The shared API runtime-name declaration is invalid.');
  }
  const names = [...declaration[1].matchAll(
    /^\s*'([A-Z0-9_]+)',\s*$/gmu,
  )].map((match) => match[1]).filter((name) => name !== undefined);
  if (names.length === 0) {
    throw new Error('The shared API runtime-name declaration is empty.');
  }
  return names;
}

/**
 * Narrows an unknown value to a string-keyed record.
 *
 * @param value - Value to inspect.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Requires an unknown value to be a string-keyed record.
 *
 * @param value - Value to validate.
 * @param label - Diagnostic label used when validation fails.
 * @returns The validated record.
 */
function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

/**
 * Requires one record property to contain another record.
 *
 * @param record - Parent record.
 * @param name - Property name to read.
 * @returns The validated child record.
 */
function requireRecordProperty(
  record: Readonly<Record<string, unknown>>,
  name: string,
): Record<string, unknown> {
  return requireRecord(record[name], name);
}

/**
 * Wraps an expected deployment-time source in Fn::Base64.
 *
 * @param value - Plain source value or intrinsic expression.
 * @returns The exact CloudFormation Base64 expression.
 */
function base64(value: unknown): Record<string, unknown> {
  return { 'Fn::Base64': value };
}

/**
 * Marks one encoded configuration source as a nested secret ARN.
 *
 * @param value - Secret resource Ref encoded for the line envelope.
 * @returns Expected nested-secret marker used only by this test.
 */
function nestedSecret(value: unknown): Record<string, unknown> {
  return { NestedSecret: base64(value) };
}

/**
 * Creates an exact CloudFormation Ref expression.
 *
 * @param logicalId - Parameter or resource logical identifier.
 * @returns The Ref expression.
 */
function ref(logicalId: string): Record<string, unknown> {
  return { Ref: logicalId };
}

/**
 * Creates an exact CloudFormation Fn::GetAtt expression.
 *
 * @param logicalId - Resource logical identifier.
 * @param attribute - Attribute name.
 * @returns The Fn::GetAtt expression.
 */
function getAtt(
  logicalId: string,
  attribute: string,
): Record<string, unknown> {
  return { 'Fn::GetAtt': [logicalId, attribute] };
}

/**
 * Creates an exact CloudFormation Fn::Join expression.
 *
 * @param delimiter - Join delimiter.
 * @param parts - Values concatenated by CloudFormation.
 * @returns The Fn::Join expression.
 */
function join(
  delimiter: string,
  parts: readonly unknown[],
): Record<string, unknown> {
  return { 'Fn::Join': [delimiter, parts] };
}

const expectedCoreConfiguration = {
  ALLOWED_ORIGINS: base64(ref('TaskApiAllowedOrigins')),
  AUTOMATION_INBOUND_WEBHOOK_BASE_URL: base64(
    getAtt('ProjectTasksHttpApi4BD7BB44', 'ApiEndpoint'),
  ),
  MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID: base64(
    ref('RuntimeControlApplication'),
  ),
  MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID: base64(
    ref('RuntimeControlConfigurationProfile'),
  ),
  MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID: base64(
    ref('RuntimeControlEnvironment'),
  ),
  MUKUROJI_RUNTIME_CONTROL_MAX_STALE_SECONDS: base64('60'),
  MUKUROJI_RUNTIME_CONTROL_MIN_POLL_INTERVAL_SECONDS: base64('15'),
  MUKUROJI_RUNTIME_CONTROL_SCOPE: base64('api'),
  MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: base64(
    ref('WorkspaceSearchWriterFenceMode'),
  ),
  REALTIME_WEBSOCKET_URL: base64(join('', [
    'wss://',
    ref('RealtimeWebSocketApiC99C6240'),
    '.execute-api.',
    ref('AWS::Region'),
    '.',
    ref('AWS::URLSuffix'),
    '/production',
  ])),
};

const expectedIdentityConfiguration = {
  COGNITO_CLIENT_ID: base64(ref('CognitoUserPoolClientId')),
  COGNITO_ENTERPRISE_IDP_NAME: base64(ref('CognitoEnterpriseIdpName')),
  COGNITO_HOSTED_UI_DOMAIN: base64(ref('CognitoHostedUiDomain')),
  COGNITO_SSO_CLIENT_ID: base64(ref('CognitoSsoUserPoolClientId')),
  COGNITO_SSO_REDIRECT_URI: base64(ref('CognitoSsoRedirectUri')),
  COGNITO_USER_POOL_ID: base64(ref('CognitoUserPoolId')),
  MUKUROJI_SYSTEM_ADMIN_GROUPS: base64(ref('SystemAdminGroups')),
  MUKUROJI_WORKSPACE_DIRECTORY_ID: base64(ref('WorkspaceDirectoryId')),
};

const expectedDataConfiguration = {
  ANALYTICS_SCHEDULE_INDEX_NAME: base64('ScheduleDueIndex'),
  ANALYTICS_TABLE_NAME: base64(ref('AnalyticsTable3F84C304')),
  AUDIT_EVENTS_TABLE_NAME: base64(ref('AuditEventsTable0723963E')),
  AUDIT_RETENTION_DAYS: base64(ref('AuditRetentionDays')),
  AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX: base64(
    'mukuroji/automation-inbound-webhooks',
  ),
  AUTOMATION_TABLE_NAME: base64(ref('AutomationTableE3D67F0D')),
  AUTOMATION_WEBHOOK_SECRET_PREFIX: base64(
    'mukuroji/automation-webhooks',
  ),
  COLLABORATION_TABLE_NAME: base64(
    ref('WorkItemCollaborationTableFDECF217'),
  ),
  CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN: base64(
    ref('ConnectorRuntimeSecret7993B96D'),
  ),
  DEVELOPER_PLATFORM_CONNECTOR_KMS_KEY_ID: base64(
    getAtt('DeveloperPlatformConnectorKey7AD18512', 'Arn'),
  ),
  DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: base64('LookupKeyIndex'),
  DEVELOPER_PLATFORM_STATE_KMS_KEY_ID: base64(
    getAtt('DeveloperPlatformStateKey5AAD6FB8', 'Arn'),
  ),
  DEVELOPER_PLATFORM_TABLE_NAME: base64(
    ref('DeveloperPlatformTable772E085C'),
  ),
  DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID: base64(
    getAtt('DeveloperPlatformWebhookKey6B581CD4', 'Arn'),
  ),
  DOCUMENTS_TABLE_NAME: base64(ref('DocumentsTable7E808EE5')),
  ENTERPRISE_IDENTITY_TABLE_NAME: base64(
    ref('EnterpriseIdentityTable7491FB7A'),
  ),
  MUKUROJI_PROJECT_TASKS_TABLE: base64(ref('ProjectTasksTableE21F6637')),
  MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: base64(
    ref('TeamIssueEventsTableDD2B0F96'),
  ),
  PROJECT_DIRECTORY_TABLE_NAME: base64(
    ref('ProjectDirectoryTable9ED01C01'),
  ),
  WORKSPACE_ACCESS_TABLE_NAME: base64(ref('WorkspaceAccessTableD7C8D2C7')),
  WORKSPACE_SEARCH_MIGRATION_STATE_TABLE_NAME: base64(
    ref('WorkspaceSearchMigrationStateTable34132530'),
  ),
  WORKSPACE_SEARCH_TABLE_NAME: base64(
    ref('WorkspaceSearchTable2575AD6B'),
  ),
  WORK_ITEMS_TABLE_NAME: base64(ref('TeamIssuesTable189D851D')),
};

const expectedWorkflowConfiguration = {
  DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET: nestedSecret(
    ref(DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET_LOGICAL_ID),
  ),
  ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET: nestedSecret(
    ref(API_ENTERPRISE_IDENTITY_TOKEN_HASH_VALUE_SECRET_LOGICAL_ID),
  ),
  ENTERPRISE_SSO_STATE_SECRET: nestedSecret(
    ref(API_ENTERPRISE_SSO_STATE_VALUE_SECRET_LOGICAL_ID),
  ),
  FILE_BUCKET_NAME: base64(ref('FileBucketCDFCD6DE')),
  FILE_DOWNLOAD_URL_TTL_SECONDS: base64(
    ref('FileDownloadUrlTtlSeconds'),
  ),
  FILE_PROOFING_TABLE_NAME: base64(ref('FileProofingTable81DA272F')),
  FILE_RETENTION_DAYS: base64(ref('FileRetentionDays')),
  FILE_UPLOAD_URL_TTL_SECONDS: base64(ref('FileUploadUrlTtlSeconds')),
  MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY: nestedSecret(
    ref(API_WORKSPACE_AUDIT_PSEUDONYM_VALUE_SECRET_LOGICAL_ID),
  ),
  NOTIFICATIONS_STATUS_INDEX_NAME: base64('RecipientStatusIndex'),
  NOTIFICATIONS_TABLE_NAME: base64(ref('NotificationsTable76DCFC6C')),
  CAPACITY_PLANNING_TABLE_NAME: base64(ref('CapacityPlanningTable0EECD517')),
  PLANNING_TABLE_NAME: base64(ref('PlanningTable2A0D4CC5')),
  REALTIME_SESSIONS_TABLE_NAME: base64(
    ref('RealtimeSessionsTable607096EB'),
  ),
  REQUEST_INTAKE_TABLE_NAME: base64(ref('RequestIntakeTable608708D4')),
  REQUEST_QUEUE_INDEX_NAME: base64('RequestQueueIndex'),
  REQUEST_RATE_LIMIT_PER_HOUR: base64(ref('RequestRateLimitPerHour')),
  REQUEST_TOKEN_HASH_SECRET: nestedSecret(
    ref(API_REQUEST_TOKEN_HASH_VALUE_SECRET_LOGICAL_ID),
  ),
  WEBHOOK_DELIVERY_QUEUE_URL: base64(
    ref('WebhookDeliveryQueue2A244492'),
  ),
  WORK_ITEM_CONFIGURATION_TABLE_NAME: base64(
    ref('WorkItemConfigurationTable35E94558'),
  ),
  WORK_ITEM_IMPORT_BUCKET_NAME: base64(
    ref('WorkItemImportBucket14068778'),
  ),
  WORK_ITEM_IMPORT_QUEUE_URL: base64(ref('WorkItemImportQueueA2F07A30')),
};

const expectedConfigurations = {
  [API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID]:
    expectedCoreConfiguration,
  [API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID]:
    expectedDataConfiguration,
  [API_IDENTITY_SECRET_LOGICAL_ID]: expectedIdentityConfiguration,
  [API_WORKFLOW_SECRET_LOGICAL_ID]: expectedWorkflowConfiguration,
};

/** Exact group identity emitted by each configuration secret. */
const expectedConfigurationGroups: Readonly<Record<string, string>> = {
  [API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID]: 'core',
  [API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID]: 'data',
  [API_IDENTITY_SECRET_LOGICAL_ID]: 'identity',
  [API_WORKFLOW_SECRET_LOGICAL_ID]: 'workflow',
};

/**
 * Builds the exact transform-free line envelope for one expected group.
 *
 * @param configuration - Canonical names mapped to encoded value sources.
 * @param group - Exact configuration-group identity.
 * @returns Exact Fn::Join expression synthesized for SecretString.
 */
function createExpectedConfigurationEnvelope(
  configuration: Readonly<Record<string, unknown>>,
  group: string,
): Record<string, unknown> {
  const entries = Object.entries(configuration).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  const parts: unknown[] = [
    `${API_CONFIGURATION_ENVELOPE_HEADER}group:${group}\nrevision:`,
    base64(ref('ApiRuntimeConfigurationRevision')),
  ];
  for (const [name, candidate] of entries) {
    const nested = isRecord(candidate) &&
      Object.keys(candidate).length === 1 &&
      Object.hasOwn(candidate, 'NestedSecret')
      ? candidate.NestedSecret
      : undefined;
    parts.push(
      `\n${nested === undefined ? 'value' : 'secret'}:${name}:`,
    );
    parts.push(nested ?? candidate);
  }
  parts.push('\n');
  return join('', parts);
}

/**
 * Resolves the largest supported string represented by an intrinsic expression.
 *
 * CloudFormation parameter references use their declared MaxLength when
 * available and otherwise fall back to the documented 4,096-byte
 * parameter-value maximum. Resource bounds intentionally exceed the service's
 * generated-name lengths where a smaller fixed bound is not encoded in this
 * stack.
 *
 * @param value - Literal or supported CloudFormation intrinsic.
 * @param parameters - Synthesized CloudFormation parameters.
 * @param resources - Synthesized CloudFormation resources.
 * @returns A conservative resolved string.
 */
function resolveMaximumString(
  value: unknown,
  parameters: Readonly<Record<string, unknown>>,
  resources: Readonly<Record<string, unknown>>,
): string {
  if (typeof value === 'string') {
    return value;
  }
  const expression = requireRecord(value, 'Configuration expression');
  if (Object.hasOwn(expression, 'Fn::Base64')) {
    if (Object.keys(expression).length !== 1) {
      throw new Error('Fn::Base64 must be the only property in its object.');
    }
    return Buffer.from(
      resolveMaximumString(
        expression['Fn::Base64'],
        parameters,
        resources,
      ),
      'utf8',
    ).toString('base64');
  }
  if (typeof expression.Ref === 'string') {
    const logicalId = expression.Ref;
    const pseudoParameterLengths: Readonly<Record<string, number>> = {
      'AWS::AccountId': 12,
      'AWS::Partition': 32,
      'AWS::Region': 32,
      'AWS::URLSuffix': 32,
    };
    const pseudoLength = pseudoParameterLengths[logicalId];
    if (pseudoLength !== undefined) {
      return 'X'.repeat(pseudoLength);
    }
    const parameter = parameters[logicalId];
    if (parameter !== undefined) {
      const definition = requireRecord(
        parameter,
        `Referenced parameter ${logicalId}`,
      );
      const maxLength = definition.MaxLength;
      if (maxLength !== undefined) {
        if (typeof maxLength !== 'number' ||
            !Number.isInteger(maxLength) ||
            maxLength < 0) {
          throw new Error(
            `Referenced parameter ${logicalId} has invalid MaxLength.`,
          );
        }
        return 'X'.repeat(maxLength);
      }
      return 'X'.repeat(CLOUDFORMATION_PARAMETER_LIMIT_BYTES);
    }
    const resource = requireRecord(
      resources[logicalId],
      `Referenced resource ${logicalId}`,
    );
    switch (resource.Type) {
      case 'AWS::DynamoDB::Table':
        return 'X'.repeat(255);
      case 'AWS::S3::Bucket':
        return 'X'.repeat(63);
      case 'AWS::SQS::Queue':
      case 'AWS::AppConfig::Application':
      case 'AWS::AppConfig::ConfigurationProfile':
      case 'AWS::AppConfig::Environment':
      case 'AWS::ApiGatewayV2::Api':
        return 'X'.repeat(4_096);
      case 'AWS::SecretsManager::Secret':
        return 'X'.repeat(2_048);
      default:
        throw new Error(
          `Unsupported Ref resource type ${String(resource.Type)} for ${logicalId}.`,
        );
    }
  }

  const getAttExpression = expression['Fn::GetAtt'];
  if (Array.isArray(getAttExpression) &&
      typeof getAttExpression[0] === 'string' &&
      typeof getAttExpression[1] === 'string') {
    const [logicalId, attribute] = getAttExpression;
    const resource = requireRecord(
      resources[logicalId],
      `GetAtt resource ${logicalId}`,
    );
    if (resource.Type === 'AWS::KMS::Key' && attribute === 'Arn') {
      return 'X'.repeat(2_048);
    }
    if (resource.Type === 'AWS::ApiGatewayV2::Api' &&
        attribute === 'ApiEndpoint') {
      return 'X'.repeat(4_096);
    }
    throw new Error(
      `Unsupported Fn::GetAtt ${logicalId}.${attribute}.`,
    );
  }

  const joinExpression = expression['Fn::Join'];
  if (Array.isArray(joinExpression) &&
      typeof joinExpression[0] === 'string' &&
      Array.isArray(joinExpression[1])) {
    return joinExpression[1]
      .map((part) => resolveMaximumString(part, parameters, resources))
      .join(joinExpression[0]);
  }

  throw new Error(
    `Unsupported configuration expression ${JSON.stringify(expression)}.`,
  );
}

/**
 * Resolves a revisioned configuration-secret name at its declared maximum.
 *
 * @param value - Secret Name expression.
 * @param parameters - Synthesized CloudFormation parameters.
 * @returns A maximum-length secret name.
 */
function resolveMaximumSecretName(
  value: unknown,
  parameters: Readonly<Record<string, unknown>>,
): string {
  if (typeof value === 'string') {
    return value;
  }
  const expression = requireRecord(value, 'Secret name expression');
  if (typeof expression.Ref === 'string') {
    const parameter = requireRecord(
      parameters[expression.Ref],
      `Secret-name parameter ${expression.Ref}`,
    );
    if (typeof parameter.MaxLength !== 'number') {
      throw new Error(`${expression.Ref} must declare MaxLength.`);
    }
    return 'X'.repeat(parameter.MaxLength);
  }
  const joinExpression = expression['Fn::Join'];
  if (Array.isArray(joinExpression) &&
      typeof joinExpression[0] === 'string' &&
      Array.isArray(joinExpression[1])) {
    return joinExpression[1]
      .map((part) => resolveMaximumSecretName(part, parameters))
      .join(joinExpression[0]);
  }
  throw new Error(
    `Unsupported secret name expression ${JSON.stringify(expression)}.`,
  );
}

/**
 * Resolves an API configuration-secret Ref to a conservative complete ARN.
 *
 * @param value - Lambda environment value.
 * @param parameters - Synthesized CloudFormation parameters.
 * @param resources - Synthesized CloudFormation resources.
 * @returns A conservative Secrets Manager ARN.
 */
function resolveApiEnvironmentValue(
  value: unknown,
  parameters: Readonly<Record<string, unknown>>,
  resources: Readonly<Record<string, unknown>>,
): string {
  const expression = requireRecord(value, 'API environment value');
  if (typeof expression.Ref !== 'string') {
    throw new Error('Every API environment value must Ref a configuration secret.');
  }
  const secret = requireRecord(
    resources[expression.Ref],
    `API configuration secret ${expression.Ref}`,
  );
  if (secret.Type !== 'AWS::SecretsManager::Secret') {
    throw new Error(`${expression.Ref} is not a Secrets Manager secret.`);
  }
  const properties = requireRecordProperty(secret, 'Properties');
  const secretName = resolveMaximumSecretName(
    properties.Name,
    parameters,
  );
  return [
    'arn:',
    'X'.repeat(32),
    ':secretsmanager:',
    'X'.repeat(32),
    ':',
    '0'.repeat(12),
    ':secret:',
    secretName,
    '-',
    'X'.repeat(6),
  ].join('');
}

describe('API runtime configuration externalization', () => {
  test('maps every canonical runtime name to its exact deployment source', () => {
    const template = requireRecord(
      synthesizedTemplate.toJSON(),
      'CloudFormation template',
    );
    const resources = requireRecordProperty(template, 'Resources');

    for (const [logicalId, expectedConfiguration] of
      Object.entries(expectedConfigurations)) {
      const secret = requireRecord(resources[logicalId], logicalId);
      expect(secret.Type).toBe('AWS::SecretsManager::Secret');
      expect(secret.UpdateReplacePolicy).toBe('Retain');
      expect(secret.DeletionPolicy).toBe('Retain');

      const properties = requireRecordProperty(secret, 'Properties');
      const group = expectedConfigurationGroups[logicalId];
      if (group === undefined) {
        throw new Error(`Configuration group ${logicalId} is missing.`);
      }
      expect(properties.SecretString).toEqual(
        createExpectedConfigurationEnvelope(expectedConfiguration, group),
      );
      expect(properties.Name).toEqual({
        'Fn::Join': [
          '-',
          [
            expect.stringMatching(/^Test-api-(?:core|data|identity|workflow)-config-v2$/),
            { Ref: 'ApiRuntimeConfigurationRevision' },
          ],
        ],
      });
    }

    const canonicalNames = Object.values(expectedConfigurations)
      .flatMap((configuration) => Object.keys(configuration));
    const sharedCanonicalNames =
      readSharedApiRuntimeEnvironmentVariableNames();
    expect(canonicalNames.sort()).toEqual(
      sharedCanonicalNames.sort(),
    );
    expect(new Set(canonicalNames).size).toBe(
      sharedCanonicalNames.length,
    );
  });

  test('keeps every conservatively resolved secret document below 64 KiB', () => {
    const template = requireRecord(
      synthesizedTemplate.toJSON(),
      'CloudFormation template',
    );
    const parameters = requireRecordProperty(template, 'Parameters');
    const resources = requireRecordProperty(template, 'Resources');

    for (const logicalId of Object.keys(expectedConfigurations)) {
      const secret = requireRecord(resources[logicalId], logicalId);
      const properties = requireRecordProperty(secret, 'Properties');
      const resolved = resolveMaximumString(
        properties.SecretString,
        parameters,
        resources,
      );
      expect(Buffer.byteLength(resolved, 'utf8'))
        .toBeLessThanOrEqual(API_CONFIGURATION_SECRET_LIMIT_BYTES);
    }
  });

  test('uses declared parameter string bounds before the CloudFormation fallback', () => {
    const template = requireRecord(
      synthesizedTemplate.toJSON(),
      'CloudFormation template',
    );
    const parameters = requireRecordProperty(template, 'Parameters');
    const resources = requireRecordProperty(template, 'Resources');

    expect(resolveMaximumString(
      ref('ApiRuntimeConfigurationRevision'),
      parameters,
      resources,
    )).toHaveLength(32);
    expect(resolveMaximumString(
      ref('TaskApiAllowedOrigins'),
      parameters,
      resources,
    )).toHaveLength(CLOUDFORMATION_PARAMETER_LIMIT_BYTES);
  });

  test('keeps sensitive values outside processed configuration documents', () => {
    const template = requireRecord(
      synthesizedTemplate.toJSON(),
      'CloudFormation template',
    );
    expect(template.Transform).toBeUndefined();
    const parameters = requireRecordProperty(template, 'Parameters');
    const resources = requireRecordProperty(template, 'Resources');
    const sensitiveValueSecrets: Readonly<Record<string, string>> = {
      [API_ENTERPRISE_IDENTITY_TOKEN_HASH_VALUE_SECRET_LOGICAL_ID]:
        'EnterpriseIdentityTokenHashSecret',
      [API_ENTERPRISE_SSO_STATE_VALUE_SECRET_LOGICAL_ID]:
        'EnterpriseSsoStateSecret',
      [API_REQUEST_TOKEN_HASH_VALUE_SECRET_LOGICAL_ID]:
        'RequestTokenHashSecret',
      [API_WORKSPACE_AUDIT_PSEUDONYM_VALUE_SECRET_LOGICAL_ID]:
        'WorkspaceAuditPseudonymKey',
    };

    for (const [logicalId, parameterLogicalId] of
      Object.entries(sensitiveValueSecrets)) {
      const parameter = requireRecord(
        parameters[parameterLogicalId],
        parameterLogicalId,
      );
      expect(parameter.NoEcho).toBe(true);
      const secret = requireRecord(resources[logicalId], logicalId);
      expect(secret.Type).toBe('AWS::SecretsManager::Secret');
      expect(secret.UpdateReplacePolicy).toBe('Retain');
      expect(secret.DeletionPolicy).toBe('Retain');
      const properties = requireRecordProperty(secret, 'Properties');
      expect(properties.SecretString).toEqual(ref(parameterLogicalId));
      expect(properties.Name).toEqual({
        'Fn::Join': [
          '-',
          [
            expect.stringMatching(/^Test-api-[a-z-]+-v1$/),
            { Ref: 'ApiRuntimeConfigurationRevision' },
          ],
        ],
      });
    }

    const sensitiveParameterRefs = Object.values(sensitiveValueSecrets)
      .map((logicalId) => JSON.stringify(ref(logicalId)));
    for (const logicalId of Object.keys(expectedConfigurations)) {
      const secret = requireRecord(resources[logicalId], logicalId);
      const properties = requireRecordProperty(secret, 'Properties');
      const serializedSecretString = JSON.stringify(properties.SecretString);
      expect(serializedSecretString).not.toContain('{{resolve:');
      for (const sensitiveParameterRef of sensitiveParameterRefs) {
        expect(serializedSecretString).not.toContain(sensitiveParameterRef);
      }
    }

    const apiPolicy = requireRecord(
      resources.ListProjectTasksFunctionServiceRoleDefaultPolicy5F0F81CE,
      'API default role policy',
    );
    const policyProperties = requireRecordProperty(apiPolicy, 'Properties');
    const policyDocument = requireRecordProperty(
      policyProperties,
      'PolicyDocument',
    );
    const statements = policyDocument.Statement;
    if (!Array.isArray(statements)) {
      throw new Error('API default role statements are invalid.');
    }
    const secretReadStatement = statements.find((statement) =>
      isRecord(statement) &&
      Array.isArray(statement.Action) &&
      statement.Action.includes('secretsmanager:GetSecretValue'));
    if (!isRecord(secretReadStatement)) {
      throw new Error('API secret-read statement is missing.');
    }
    expect(secretReadStatement.Resource).toEqual(expect.arrayContaining([
      ref(API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID),
      ref(API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID),
      ref(API_IDENTITY_SECRET_LOGICAL_ID),
      ref(API_WORKFLOW_SECRET_LOGICAL_ID),
      ref(API_ENTERPRISE_IDENTITY_TOKEN_HASH_VALUE_SECRET_LOGICAL_ID),
      ref(API_ENTERPRISE_SSO_STATE_VALUE_SECRET_LOGICAL_ID),
      ref(API_REQUEST_TOKEN_HASH_VALUE_SECRET_LOGICAL_ID),
      ref(API_WORKSPACE_AUDIT_PSEUDONYM_VALUE_SECRET_LOGICAL_ID),
      ref(DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET_LOGICAL_ID),
    ]));
  });

  test('publishes a revision-bound version and routes both transports through live', () => {
    const template = requireRecord(
      synthesizedTemplate.toJSON(),
      'CloudFormation template',
    );
    expect(template.Transform).toBeUndefined();
    const parameters = requireRecordProperty(template, 'Parameters');
    const resources = requireRecordProperty(template, 'Resources');
    const apiFunction = requireRecord(
      resources[API_FUNCTION_LOGICAL_ID],
      API_FUNCTION_LOGICAL_ID,
    );
    const functionProperties = requireRecordProperty(apiFunction, 'Properties');
    expect(functionProperties.FunctionName).toBe('Test-api-v2');
    const environment = requireRecordProperty(functionProperties, 'Environment');
    const variables = requireRecordProperty(environment, 'Variables');
    expect(variables).toEqual({
      MUKUROJI_API_CORE_CONFIG_SECRET_ARN:
        ref(API_CORE_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID),
      MUKUROJI_API_DATA_CONFIG_SECRET_ARN:
        ref(API_DATA_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID),
      MUKUROJI_API_IDENTITY_CONFIG_SECRET_ARN:
        ref(API_IDENTITY_SECRET_LOGICAL_ID),
      MUKUROJI_API_WORKFLOW_CONFIG_SECRET_ARN:
        ref(API_WORKFLOW_SECRET_LOGICAL_ID),
    });

    const resolvedVariables: Record<string, string> = {};
    for (const [name, value] of Object.entries(variables)) {
      resolvedVariables[name] = resolveApiEnvironmentValue(
        value,
        parameters,
        resources,
      );
    }
    expect(Buffer.byteLength(JSON.stringify(resolvedVariables), 'utf8'))
      .toBeLessThanOrEqual(LAMBDA_ENVIRONMENT_LIMIT_BYTES);

    const versionEntries = Object.entries(resources)
      .filter(([, resource]) =>
        isRecord(resource) &&
        resource.Type === 'AWS::Lambda::Version' &&
        isRecord(resource.Properties) &&
        isRecord(resource.Properties.FunctionName) &&
        resource.Properties.FunctionName.Ref === API_FUNCTION_LOGICAL_ID);
    expect(versionEntries).toHaveLength(1);
    const [versionLogicalId, version] = versionEntries[0] ?? [];
    if (typeof versionLogicalId !== 'string' || !isRecord(version)) {
      throw new Error('The API Lambda version was not synthesized.');
    }
    expect(requireRecordProperty(version, 'Properties').Description).toEqual(
      join(' ', [
        'API runtime configuration revision',
        ref('ApiRuntimeConfigurationRevision'),
      ]),
    );

    const aliasEntries = Object.entries(resources)
      .filter(([, resource]) =>
        isRecord(resource) &&
        resource.Type === 'AWS::Lambda::Alias' &&
        isRecord(resource.Properties) &&
        resource.Properties.Name === 'live');
    expect(aliasEntries).toHaveLength(1);
    const [aliasLogicalId, alias] = aliasEntries[0] ?? [];
    if (typeof aliasLogicalId !== 'string' || !isRecord(alias)) {
      throw new Error('The live API alias was not synthesized.');
    }
    expect(requireRecordProperty(alias, 'Properties')).toEqual({
      FunctionName: ref(API_FUNCTION_LOGICAL_ID),
      FunctionVersion: getAtt(versionLogicalId, 'Version'),
      Name: 'live',
    });

    const integrations = Object.values(resources)
      .filter((resource) =>
        isRecord(resource) &&
        resource.Type === 'AWS::ApiGatewayV2::Integration' &&
        isRecord(resource.Properties) &&
        resource.Properties.IntegrationUri !== undefined);
    expect(integrations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Properties: expect.objectContaining({
          IntegrationUri: ref(aliasLogicalId),
          PayloadFormatVersion: '2.0',
        }),
      }),
    ]));

    const functionUrls = Object.values(resources)
      .filter((resource) =>
        isRecord(resource) && resource.Type === 'AWS::Lambda::Url');
    expect(functionUrls).toEqual([
      expect.objectContaining({
        DependsOn: expect.arrayContaining([aliasLogicalId]),
        Properties: expect.objectContaining({
          Qualifier: 'live',
          TargetFunctionArn: getAtt(API_FUNCTION_LOGICAL_ID, 'Arn'),
        }),
      }),
    ]);
  });
});
