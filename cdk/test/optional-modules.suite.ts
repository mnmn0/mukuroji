/** Registers tests for the stack with every optional module left off. */
import { describe, expect, test } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeKnownNagFindings } from '../lib/acknowledge-nag-findings';
import {
  CONNECTORS_CONTEXT_KEY,
  REQUEST_EMAIL_CONTEXT_KEY,
  RESTORE_DRILL_CONTEXT_KEY,
  TENANT_LIFECYCLE_CONTEXT_KEY,
  readStackModuleProps,
} from '../bin/stack-modules';
import { MukurojiStack, type MukurojiStackProps } from '../lib/stacks/mukuroji-stack';
import {
  API_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
  findApiRuntimeConfigurationSource,
} from './test-support';

/**
 * Synthesizes the stack the way `bin/cdk.ts` composes it.
 *
 * @param context - Extra CDK context values.
 * @param props - Stack Props in place of the ones `bin/cdk.ts` reads from context.
 * @returns The synthesized template and the stack's error annotations.
 */
function synthesizeDefaultStack(
  context: Record<string, unknown> = {},
  props?: MukurojiStackProps,
) {
  const app = new cdk.App({
    context: {
      // The feature flags cdk.json sets for every synthesis.
      '@aws-cdk/aws-iam:minimizePolicies': true,
      '@aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy': false,
      '@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy': true,
      ...context,
    },
  });
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const stack = new MukurojiStack(app, 'OptionalModules', props ?? readStackModuleProps(app));
  acknowledgeKnownNagFindings(stack);
  const template = Template.fromStack(stack);
  const errors = app.synth().getStackArtifact(stack.artifactId).messages
    .filter((message) => message.level === 'error')
    .map((message) => String(message.entry.data));
  return { template, errors };
}

describe('default deployment without optional modules', () => {
  const { template, errors } = synthesizeDefaultStack();
  const json = template.toJSON();
  const resources = json.Resources as Record<string, {
    Type: string;
    Properties?: Record<string, unknown>;
  }>;
  const logicalIds = Object.keys(resources);

  test('creates one KMS key shared by the developer platform', () => {
    template.resourceCountIs('AWS::KMS::Key', 1);
    expect(logicalIds.filter((id) => id.startsWith('DeveloperPlatformKey')))
      .toHaveLength(1);
  });

  test('omits every restore-drill, connector, request email, and tenant lifecycle resource and output', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    for (const prefix of [
      'RestoreDrill',
      'ConnectorSync',
      'ConnectorPoll',
      'ConnectorRuntimeSecret',
      'RequestEmailIngestion',
      'TenantExport',
      'TenantAccess',
      'TenantIdentity',
      'TenantData',
      'TenantSecrets',
      'TenantVerification',
    ]) {
      expect(logicalIds.filter((id) => id.startsWith(prefix))).toEqual([]);
      expect(Object.keys(json.Outputs).filter((id) => id.startsWith(prefix)))
        .toEqual([]);
    }
  });

  test('declares no parameter that only an omitted module reads', () => {
    for (const parameterName of [
      'ConnectorRuntimeConfiguration',
      'RequestEmailWebhookSecret',
      'RestoreDrillCleanupApproverRoleArn',
    ]) {
      expect(json.Parameters).not.toHaveProperty(parameterName);
    }
  });

  test('turns off the connector projection and loads no connector provider', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CONNECTOR_SYNC_ENABLED: 'false',
          MUKUROJI_RUNTIME_ROLE: 'audit-projection',
        }),
      },
    });
    const projection = Object.values(resources).find((resource) =>
      resource.Type === 'AWS::Lambda::Function' &&
      JSON.stringify(resource.Properties).includes('"MUKUROJI_RUNTIME_ROLE":"audit-projection"'));
    expect(JSON.stringify(projection)).not.toContain('CONNECTOR_SYNC_QUEUE_URL');

    const configuration = resources[API_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID];
    expect(findApiRuntimeConfigurationSource(
      configuration.Properties?.SecretString,
      'CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN',
    )).toEqual({ 'Fn::Base64': '' });
  });

  test('tells the API to refuse tenant export and closure, and grants it no export bucket', () => {
    const api = Object.values(resources).find((resource) =>
      resource.Type === 'AWS::Lambda::Function' &&
      JSON.stringify(resource.Properties).includes('"TENANT_LIFECYCLE_OPERATIONS"'));
    const environment = api?.Properties?.Environment as
      | { Variables: Record<string, unknown> }
      | undefined;
    const variables = environment?.Variables ?? {};

    expect(variables.TENANT_LIFECYCLE_OPERATIONS).toBe('disabled');
    expect(variables).not.toHaveProperty('TENANT_EXPORT_BUCKET_NAME');
    expect(JSON.stringify(json)).not.toContain('tenant-exports/*');
  });

  test('keeps audit-retention reconciliation and starts no tenant operation', () => {
    const worker = Object.entries(resources).find(([id]) =>
      id.startsWith('TenantOperationFunction') && !id.includes('ServiceRole'));
    const workerProperties = JSON.stringify(worker?.[1].Properties);

    expect(workerProperties).not.toContain('EXECUTION_QUEUE_URL');
    const tenantStreamMappings = Object.values(resources).filter((resource) =>
      resource.Type === 'AWS::Lambda::EventSourceMapping' &&
      JSON.stringify(resource.Properties).includes(String(worker?.[0])) &&
      JSON.stringify(resource.Properties).includes('TenantAdministrationTable'));
    expect(tenantStreamMappings).toHaveLength(1);
    const filters = JSON.stringify(tenantStreamMappings[0].Properties?.FilterCriteria);
    expect(filters).toContain('RETENTION_JOB');
    expect(filters).not.toContain('OPERATION#');
    expect(Object.values(resources).filter((resource) =>
      resource.Type === 'AWS::Lambda::EventSourceMapping' &&
      JSON.stringify(resource.Properties).includes(String(worker?.[0])) &&
      JSON.stringify(resource.Properties).includes('AuditEventsTable'))).toHaveLength(1);
  });

  test('keeps deleted file versions unreadable for everyone without the restore drill', () => {
    const bucketPolicy = Object.values(template.findResources('AWS::S3::BucketPolicy'))
      .map((resource) => resource.Properties.PolicyDocument.Statement as Record<string, unknown>[])
      .flat()
      .find((statement) => statement.Sid === 'DeletedObjectsCannotBeRead');

    expect(bucketPolicy?.Effect).toBe('Deny');
    expect(bucketPolicy?.Condition).toEqual({
      StringEquals: { 's3:ExistingObjectTag/mukuroji-deleted': 'true' },
    });
  });

  test('passes cdk-nag with every optional module left out', () => {
    expect(errors).toEqual([]);
  });
});

describe('optional modules selected through CDK context', () => {
  test('turns the restore drill on', () => {
    const { template } = synthesizeDefaultStack({ [RESTORE_DRILL_CONTEXT_KEY]: 'true' });

    expect(template.toJSON().Parameters.RestoreDrillCleanupApproverRoleArn).toBeDefined();
    template.hasOutput('RestoreDrillStateMachineArn', {});
  });

  test('turns the connector workers on', () => {
    const { template } = synthesizeDefaultStack({ [CONNECTORS_CONTEXT_KEY]: true });

    expect(template.toJSON().Parameters.ConnectorRuntimeConfiguration).toBeDefined();
    template.hasOutput('ConnectorSyncQueueUrl', {});
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CONNECTOR_SYNC_ENABLED: 'true',
          MUKUROJI_RUNTIME_ROLE: 'audit-projection',
        }),
      },
    });
  });

  test('turns request email ingestion on', () => {
    const { template } = synthesizeDefaultStack({ [REQUEST_EMAIL_CONTEXT_KEY]: 'true' });

    expect(template.toJSON().Parameters.RequestEmailWebhookSecret).toBeDefined();
    template.hasOutput('RequestEmailIngestionFunctionName', {});
  });

  test('turns tenant export and closure on', () => {
    const { template } = synthesizeDefaultStack({ [TENANT_LIFECYCLE_CONTEXT_KEY]: 'true' });

    template.hasOutput('TenantExportCapabilityFunctionName', {});
    template.hasOutput('TenantVerificationCapabilityFunctionName', {});
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TENANT_EXPORT_BUCKET_NAME: Match.anyValue(),
          TENANT_LIFECYCLE_OPERATIONS: 'enabled',
        }),
      },
    });
  });

  test('ignores module context the composition root did not pass to the stack', () => {
    const { template } = synthesizeDefaultStack(
      {
        [RESTORE_DRILL_CONTEXT_KEY]: 'true',
        [CONNECTORS_CONTEXT_KEY]: 'true',
        [REQUEST_EMAIL_CONTEXT_KEY]: 'true',
        [TENANT_LIFECYCLE_CONTEXT_KEY]: 'true',
      },
      {},
    );
    const { Parameters: parameters } = template.toJSON();

    expect(parameters.RestoreDrillCleanupApproverRoleArn).toBeUndefined();
    expect(parameters.ConnectorRuntimeConfiguration).toBeUndefined();
    expect(parameters.RequestEmailWebhookSecret).toBeUndefined();
    expect(template.toJSON().Outputs).not.toHaveProperty('TenantExportCapabilityFunctionName');
  });
});
