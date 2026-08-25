/** Registers Bedrock AI assistance deployment-boundary tests. */
import { expect, test } from '@jest/globals';
import { synthesizedTemplate } from './test-support';

/**
 * Narrows an unknown value to a string-keyed record.
 *
 * @param value Value to inspect.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Requires an unknown synthesized value to be a string-keyed record.
 *
 * @param value Value to validate.
 * @param label Diagnostic label used when validation fails.
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
 * Requires a named record property to contain another record.
 *
 * @param record Parent record.
 * @param name Property name to read.
 * @returns The validated child record.
 */
function requireRecordProperty(
  record: Readonly<Record<string, unknown>>,
  name: string,
): Record<string, unknown> {
  return requireRecord(record[name], name);
}

test('AI assistance parameters pin one exact model and validate the JP default', () => {
  const document = synthesizedTemplate.toJSON();
  const parameters = document.Parameters;

  expect(parameters.AiBedrockModelId).toEqual({
    AllowedPattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$',
    ConstraintDescription:
      'AiBedrockModelId must be one exact Bedrock model or inference-profile identifier.',
    Default: 'jp.anthropic.claude-sonnet-4-6',
    Description:
      'Exact Bedrock model identifier allowlisted for every AI assistance request.',
    MaxLength: 256,
    MinLength: 1,
    Type: 'String',
  });
  expect(parameters.AiBedrockInputPricePerMillionTokensUsd).toEqual({
    AllowedPattern:
      '^(?:0\\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(?:\\.[0-9]+)?)$',
    ConstraintDescription:
      'AiBedrockInputPricePerMillionTokensUsd must be a positive decimal number.',
    Description:
      'Deployment-reviewed Bedrock standard input-token price in USD per one million tokens for AiBedrockModelId.',
    MaxLength: 32,
    MinLength: 1,
    Type: 'String',
  });
  expect(parameters.AiBedrockOutputPricePerMillionTokensUsd).toEqual({
    AllowedPattern:
      '^(?:0\\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(?:\\.[0-9]+)?)$',
    ConstraintDescription:
      'AiBedrockOutputPricePerMillionTokensUsd must be a positive decimal number.',
    Description:
      'Deployment-reviewed Bedrock standard output-token price in USD per one million tokens for AiBedrockModelId.',
    MaxLength: 32,
    MinLength: 1,
    Type: 'String',
  });
  expect(parameters.AiBedrockModelArn).toEqual({
    AllowedPattern:
      '^arn:(?:aws|aws-us-gov|aws-cn):bedrock:(?:[a-z0-9-]*::foundation-model/[A-Za-z0-9._:-]+|[a-z0-9-]+:[0-9]{12}:(?:inference-profile|application-inference-profile)/[A-Za-z0-9._:-]+)$',
    ConstraintDescription:
      'AiBedrockModelArn must be one exact foundation-model or inference-profile ARN in the deployment partition.',
    Description:
      'Exact Bedrock model or inference-profile ARN that the API Lambda may invoke.',
    MaxLength: 2_048,
    MinLength: 1,
    Type: 'String',
  });
  expect(parameters.AiBedrockModelArn.Default).toBeUndefined();
  expect(parameters.AiBedrockDestinationModelArns).toEqual({
    AllowedPattern:
      '^(?:|arn:(?:aws|aws-us-gov|aws-cn):bedrock:[a-z0-9-]*::foundation-model/[A-Za-z0-9._:-]+(?:,arn:(?:aws|aws-us-gov|aws-cn):bedrock:[a-z0-9-]*::foundation-model/[A-Za-z0-9._:-]+)*)$',
    ConstraintDescription:
      'AiBedrockDestinationModelArns must be empty or comma-separated exact foundation-model ARNs without whitespace.',
    Default: '',
    Description:
      'Exact destination foundation-model ARNs required by the configured inference profile; leave empty for direct model invocation.',
    MaxLength: 4_096,
    Type: 'String',
  });
  expect(document.Conditions.AiBedrockDestinationModelArnsConfigured).toEqual({
    'Fn::Not': [{
      'Fn::Equals': [
        { Ref: 'AiBedrockDestinationModelArns' },
        '',
      ],
    }],
  });
  expect(document.Rules.DefaultAiBedrockModelCompatibility).toEqual({
    Assertions: [
      {
        Assert: {
          'Fn::Or': [
            {
              'Fn::Equals': [
                { Ref: 'AWS::Region' },
                'ap-northeast-1',
              ],
            },
            {
              'Fn::Equals': [
                { Ref: 'AWS::Region' },
                'ap-northeast-3',
              ],
            },
          ],
        },
        AssertDescription:
          'The default JP Claude Sonnet 4.6 profile must be invoked from Tokyo or Osaka.',
      },
      {
        Assert: {
          'Fn::Not': [{
            'Fn::Equals': [
              { Ref: 'AiBedrockDestinationModelArns' },
              '',
            ],
          }],
        },
        AssertDescription:
          'The default JP Claude Sonnet 4.6 profile requires exact Tokyo and Osaka destination foundation-model ARNs.',
      },
    ],
    RuleCondition: {
      'Fn::Equals': [
        { Ref: 'AiBedrockModelId' },
        'jp.anthropic.claude-sonnet-4-6',
      ],
    },
  });
});

test('API Lambda receives only the deployed Bedrock allowlist and existing durable table', () => {
  const resources = synthesizedTemplate.toJSON().Resources;
  const apiFunction = requireRecord(
    resources.ListProjectTasksFunction2134AF4A,
    'API Lambda',
  );
  const functionProperties = requireRecordProperty(apiFunction, 'Properties');
  const environment = requireRecordProperty(functionProperties, 'Environment');
  const variables = requireRecordProperty(environment, 'Variables');

  expect(functionProperties.Timeout).toBe(20);
  expect(variables).toEqual(
    expect.objectContaining({
      AI_ASSISTANCE_ALLOWED_MODEL_IDS: { Ref: 'AiBedrockModelId' },
      AI_ASSISTANCE_BEDROCK_REGION: { Ref: 'AWS::Region' },
      AI_ASSISTANCE_BEDROCK_INPUT_PRICE_PER_MILLION_TOKENS_USD: {
        Ref: 'AiBedrockInputPricePerMillionTokensUsd',
      },
      AI_ASSISTANCE_BEDROCK_OUTPUT_PRICE_PER_MILLION_TOKENS_USD: {
        Ref: 'AiBedrockOutputPricePerMillionTokensUsd',
      },
      AI_ASSISTANCE_DEFAULT_MODEL_ID: { Ref: 'AiBedrockModelId' },
      AI_ASSISTANCE_TABLE_NAME: {
        Ref: 'WorkspaceSearchTable2575AD6B',
      },
    }),
  );
  expect(JSON.stringify(variables))
    .not.toContain('AWS_BEARER_TOKEN_BEDROCK');

  const aiEnabledFunctions = Object.values(resources).filter((resource) => {
    if (!isRecord(resource) || resource.Type !== 'AWS::Lambda::Function') {
      return false;
    }
    if (!isRecord(resource.Properties) ||
        !isRecord(resource.Properties.Environment) ||
        !isRecord(resource.Properties.Environment.Variables)) {
      return false;
    }
    return resource.Properties.Environment.Variables
      .AI_ASSISTANCE_DEFAULT_MODEL_ID !== undefined;
  });
  expect(aiEnabledFunctions).toHaveLength(1);
});

test('API role invokes only exact configured Bedrock resources without streaming access', () => {
  const resources = synthesizedTemplate.toJSON().Resources;
  const modelPolicyEntry = Object.entries(resources).find(
    ([logicalId, resource]) =>
      logicalId.startsWith('ApiBedrockModelInvokePolicy') &&
      isRecord(resource) && resource.Type === 'AWS::IAM::Policy',
  );
  const destinationPolicyEntry = Object.entries(resources).find(
    ([logicalId, resource]) =>
      logicalId.startsWith('ApiBedrockDestinationModelInvokePolicy') &&
      isRecord(resource) && resource.Type === 'AWS::IAM::Policy',
  );

  expect(modelPolicyEntry).toBeDefined();
  expect(destinationPolicyEntry).toBeDefined();
  if (!modelPolicyEntry || !destinationPolicyEntry) {
    throw new Error('The API Bedrock invoke policies were not synthesized.');
  }
  const modelPolicy = requireRecord(modelPolicyEntry[1], 'Bedrock model policy');
  const modelPolicyProperties = requireRecordProperty(modelPolicy, 'Properties');
  const modelPolicyDocument = requireRecordProperty(
    modelPolicyProperties,
    'PolicyDocument',
  );
  const destinationPolicy = requireRecord(
    destinationPolicyEntry[1],
    'Bedrock destination-model policy',
  );
  const destinationPolicyProperties = requireRecordProperty(
    destinationPolicy,
    'Properties',
  );
  const destinationPolicyDocument = requireRecordProperty(
    destinationPolicyProperties,
    'PolicyDocument',
  );

  expect(modelPolicy.Condition).toBeUndefined();
  expect(modelPolicyDocument.Statement).toEqual([{
    Action: 'bedrock:InvokeModel',
    Effect: 'Allow',
    Resource: { Ref: 'AiBedrockModelArn' },
  }]);
  expect(destinationPolicy.Condition).toBe(
    'AiBedrockDestinationModelArnsConfigured',
  );
  expect(destinationPolicyDocument.Statement).toEqual([{
    Action: 'bedrock:InvokeModel',
    Condition: {
      StringEquals: {
        'bedrock:InferenceProfileArn': { Ref: 'AiBedrockModelArn' },
      },
    },
    Effect: 'Allow',
    Resource: {
      'Fn::Split': [
        ',',
        { Ref: 'AiBedrockDestinationModelArns' },
      ],
    },
  }]);

  const bedrockPolicyDocument = JSON.stringify([
    modelPolicy,
    destinationPolicy,
  ]);
  expect(bedrockPolicyDocument).not.toContain('bedrock:InvokeModelWithResponseStream');
  expect(bedrockPolicyDocument).not.toContain('bedrock:InvokeModel*');
  expect(bedrockPolicyDocument).not.toContain('"Resource":"*"');
  expect(bedrockPolicyDocument).not.toContain('foundation-model/*');
  expect(bedrockPolicyDocument).not.toContain('inference-profile/*');
});
