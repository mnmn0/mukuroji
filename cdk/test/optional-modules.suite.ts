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

  test('omits every restore-drill, connector, and request email resource and output', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    for (const prefix of [
      'RestoreDrill',
      'ConnectorSync',
      'ConnectorPoll',
      'ConnectorRuntimeSecret',
      'RequestEmailIngestion',
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
        [DEMO_DATA_CONTEXT_KEY]: 'true',
      },
      {},
    );
    const { Parameters: parameters } = template.toJSON();

    expect(parameters.RestoreDrillCleanupApproverRoleArn).toBeUndefined();
    expect(parameters.ConnectorRuntimeConfiguration).toBeUndefined();
    expect(parameters.RequestEmailWebhookSecret).toBeUndefined();
    expect(findDemoSeedLogicalIds(template)).toEqual([]);
  });
});
