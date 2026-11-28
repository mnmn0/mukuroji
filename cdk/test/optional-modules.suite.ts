/** Registers tests for the stack with every optional module left off. */
import { describe, expect, test } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeKnownNagFindings } from '../lib/acknowledge-nag-findings';
import {
  CONNECTORS_CONTEXT_KEY,
  DEMO_DATA_CONTEXT_KEY,
  REQUEST_EMAIL_CONTEXT_KEY,
  RESTORE_DRILL_CONTEXT_KEY,
  SOFTWARE_FACTORY_CONTEXT_KEY,
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
      '@aws-cdk/aws-lambda:useCdkManagedLogGroup': true,
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

/** Logical ID prefixes of the custom resources that only demo deployments create. */
const DEMO_SEED_PREFIXES = [
  'SeedWorkItems',
  'SeedProjectDirectory',
  'SeedDemoProjectOwnerAccess',
  'SeedWorkspaceDemoMembers',
] as const;

/**
 * Lists the demo seed custom resources in a template.
 *
 * @param template - Synthesized template to search.
 * @returns Logical IDs of the demo seed custom resources and their policies.
 */
function findDemoSeedLogicalIds(template: Template): string[] {
  return Object.keys(template.toJSON().Resources)
    .filter((id) => DEMO_SEED_PREFIXES.some((prefix) => id.startsWith(prefix)));
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
    // Per-event audit retention runs in the audit projection fan-out (#491).
    expect(Object.values(resources).filter((resource) =>
      resource.Type === 'AWS::Lambda::EventSourceMapping' &&
      JSON.stringify(resource.Properties).includes(String(worker?.[0])) &&
      JSON.stringify(resource.Properties).includes('AuditEventsTable'))).toHaveLength(0);
  });

  test('tells the API and the scheduled jobs that Software factory is off, and skips Agent Run triage', () => {
    const withSwitch = (value: unknown) => ({
      Properties: { Environment: { Variables: Match.objectLike({ SOFTWARE_FACTORY: value }) } },
    });

    expect(Object.keys(template.findResources('AWS::Lambda::Function', withSwitch(Match.anyValue()))))
      .toHaveLength(2);
    expect(Object.keys(template.findResources('AWS::Lambda::Function', withSwitch('disabled'))))
      .toHaveLength(2);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          AGENT_RUNS_TABLE_NAME: Match.absent(),
          MUKUROJI_RUNTIME_ROLE: 'scheduled-jobs-worker',
          SOFTWARE_FACTORY: 'disabled',
        }),
      },
    });
    expect(logicalIds.filter((id) => id.startsWith('AgentRunTriageJobPolicy'))).toEqual([]);
    // Budget threshold alerts count no Agent Run cost without the Software factory (ADR 0119).
    expect(JSON.stringify(Object.entries(template.toJSON().Resources)
      .filter(([id]) => id.startsWith('NotificationScheduleJobPolicy')))).not.toContain('FinishedRunIndex');
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

  test('seeds only the Workspace and its owner', () => {
    const payloads = JSON.stringify(template.findResources('Custom::AWS'));

    expect(findDemoSeedLogicalIds(template)).toEqual([]);
    // The owner still gets the Workspace metadata, owner, and email alias rows.
    expect(payloads).toContain('workspace-bootstrap');
    expect(payloads).toContain('workspace-access-seed');
    expect(payloads).not.toContain('@example.com');
    expect(payloads).not.toContain('PROJECT_MEMBER#');
    expect(payloads).not.toContain('core-team');
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

  test('turns Software factory on', () => {
    const { template } = synthesizeDefaultStack({ [SOFTWARE_FACTORY_CONTEXT_KEY]: 'true' });
    const logicalIds = Object.keys(template.toJSON().Resources);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          AGENT_RUNS_TABLE_NAME: Match.anyValue(),
          MUKUROJI_RUNTIME_ROLE: 'scheduled-jobs-worker',
          SOFTWARE_FACTORY: 'enabled',
        }),
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          SOFTWARE_FACTORY: 'enabled',
          TENANT_LIFECYCLE_OPERATIONS: 'disabled',
        }),
      },
    });
    expect(logicalIds.some((id) => id.startsWith('AgentRunTriageJobPolicy'))).toBe(true);
    // Budget threshold alerts read finished runs and their usage to count Agent Run cost (ADR 0119).
    const notificationPolicies = Object.entries(template.toJSON().Resources)
      .filter(([id]) => id.startsWith('NotificationScheduleJobPolicy'));
    expect(notificationPolicies.length).toBeGreaterThan(0);
    const indexStatements = notificationPolicies
      .flatMap(([, policy]) => readStatementList(policy))
      .filter((statement) => JSON.stringify(readField(statement, 'Resource')).includes('/index/FinishedRunIndex'));
    // One read-only statement covers the Agent Runs table and its finished-run index. CDK may merge
    // it with other read-only statements of the same actions, so the resources are checked by item.
    expect(indexStatements).toHaveLength(1);
    expect(readField(indexStatements[0], 'Effect')).toBe('Allow');
    expect(readField(indexStatements[0], 'Action')).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
    const resources = readField(indexStatements[0], 'Resource');
    expect(resources).toEqual(expect.arrayContaining([
      { 'Fn::GetAtt': [expect.stringMatching(/^AgentRunsTable/), 'Arn'] },
      { 'Fn::Join': ['', [{ 'Fn::GetAtt': [expect.stringMatching(/^AgentRunsTable/), 'Arn'] }, '/index/FinishedRunIndex']] },
    ]));
  });

  test('turns the demo data on', () => {
    const { template, errors } = synthesizeDefaultStack({ [DEMO_DATA_CONTEXT_KEY]: 'true' });
    const payloads = JSON.stringify(template.findResources('Custom::AWS'));

    expect(errors).toEqual([]);
    for (const prefix of DEMO_SEED_PREFIXES) {
      expect(findDemoSeedLogicalIds(template).some((id) => id.startsWith(prefix))).toBe(true);
    }
    expect(payloads).toContain('sato@example.com');
    expect(payloads).toContain('PROJECT_MEMBER#refero#');
  });

  test('ignores module context the composition root did not pass to the stack', () => {
    const { template } = synthesizeDefaultStack(
      {
        [RESTORE_DRILL_CONTEXT_KEY]: 'true',
        [CONNECTORS_CONTEXT_KEY]: 'true',
        [REQUEST_EMAIL_CONTEXT_KEY]: 'true',
        [TENANT_LIFECYCLE_CONTEXT_KEY]: 'true',
        [SOFTWARE_FACTORY_CONTEXT_KEY]: 'true',
        [DEMO_DATA_CONTEXT_KEY]: 'true',
      },
      {},
    );
    const { Parameters: parameters } = template.toJSON();

    expect(parameters.RestoreDrillCleanupApproverRoleArn).toBeUndefined();
    expect(parameters.ConnectorRuntimeConfiguration).toBeUndefined();
    expect(parameters.RequestEmailWebhookSecret).toBeUndefined();
    expect(template.toJSON().Outputs).not.toHaveProperty('TenantExportCapabilityFunctionName');
    expect(findDemoSeedLogicalIds(template)).toEqual([]);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          MUKUROJI_RUNTIME_ROLE: 'scheduled-jobs-worker',
          SOFTWARE_FACTORY: 'disabled',
        }),
      },
    });
  });
});

/**
 * Reads one field of an untrusted synthesized object.
 *
 * @param value - Synthesized value.
 * @param key - Field name.
 * @returns The field, or undefined when the value is not an object.
 */
function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * Reads the statements of a synthesized IAM policy resource.
 *
 * @param resource - Synthesized `AWS::IAM::Policy` resource.
 * @returns The statements, or none when the resource has no statement list.
 */
function readStatementList(resource: unknown): readonly unknown[] {
  const statements = readField(readField(readField(resource, 'Properties'), 'PolicyDocument'), 'Statement');
  return Array.isArray(statements) ? statements : [];
}
