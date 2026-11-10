/** Registers tests for the stack with every optional module left off. */
import { expect, test } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeKnownNagFindings } from '../lib/acknowledge-nag-findings';
import {
  DEMO_DATA_CONTEXT_KEY,
  RESTORE_DRILL_CONTEXT_KEY,
  readStackModuleProps,
} from '../bin/stack-modules';
import { MukurojiStack, type MukurojiStackProps } from '../lib/stacks/mukuroji-stack';

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

const defaultStack = synthesizeDefaultStack();

test('leaves the restore drill out by default', () => {
  const { template } = defaultStack;
  const json = template.toJSON();

  template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  expect(Object.keys(json.Resources).filter((id) => id.startsWith('RestoreDrill'))).toEqual([]);
  expect(Object.keys(json.Outputs).filter((id) => id.startsWith('RestoreDrill'))).toEqual([]);
  // Without the drill no approver role is needed for a deploy.
  expect(json.Parameters.RestoreDrillCleanupApproverRoleArn).toBeUndefined();
});

test('keeps deleted file versions unreadable for everyone without the restore drill', () => {
  const bucketPolicy = Object.values(defaultStack.template.findResources('AWS::S3::BucketPolicy'))
    .map((resource) => resource.Properties.PolicyDocument.Statement as Record<string, unknown>[])
    .flat()
    .find((statement) => statement.Sid === 'DeletedObjectsCannotBeRead');

  expect(bucketPolicy?.Effect).toBe('Deny');
  expect(bucketPolicy?.Condition).toEqual({
    StringEquals: { 's3:ExistingObjectTag/mukuroji-deleted': 'true' },
  });
});

test('passes cdk-nag with the restore drill left out', () => {
  expect(defaultStack.errors).toEqual([]);
});

test('turns the restore drill on through CDK context', () => {
  const { template } = synthesizeDefaultStack({ [RESTORE_DRILL_CONTEXT_KEY]: 'true' });

  expect(template.toJSON().Parameters.RestoreDrillCleanupApproverRoleArn).toBeDefined();
  template.hasOutput('RestoreDrillStateMachineArn', {});
});

test('ignores restore drill context the composition root did not pass to the stack', () => {
  const { template } = synthesizeDefaultStack(
    { [RESTORE_DRILL_CONTEXT_KEY]: 'true' },
    { restoreDrillEnabled: false },
  );

  expect(template.toJSON().Parameters.RestoreDrillCleanupApproverRoleArn).toBeUndefined();
});

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

test('seeds only the Workspace and its owner by default', () => {
  const { template } = defaultStack;
  const payloads = JSON.stringify(template.findResources('Custom::AWS'));

  expect(findDemoSeedLogicalIds(template)).toEqual([]);
  // The owner still gets the Workspace metadata, owner, and email alias rows.
  expect(payloads).toContain('workspace-bootstrap');
  expect(payloads).toContain('workspace-access-seed');
  expect(payloads).not.toContain('@example.com');
  expect(payloads).not.toContain('PROJECT_MEMBER#');
  expect(payloads).not.toContain('core-team');
});

test('turns the demo data on through CDK context', () => {
  const { template, errors } = synthesizeDefaultStack({ [DEMO_DATA_CONTEXT_KEY]: 'true' });
  const payloads = JSON.stringify(template.findResources('Custom::AWS'));

  expect(errors).toEqual([]);
  for (const prefix of DEMO_SEED_PREFIXES) {
    expect(findDemoSeedLogicalIds(template).some((id) => id.startsWith(prefix))).toBe(true);
  }
  expect(payloads).toContain('sato@example.com');
  expect(payloads).toContain('PROJECT_MEMBER#refero#');
});

test('ignores demo data context the composition root did not pass to the stack', () => {
  const { template } = synthesizeDefaultStack(
    { [DEMO_DATA_CONTEXT_KEY]: true },
    { demoDataEnabled: false },
  );

  expect(findDemoSeedLogicalIds(template)).toEqual([]);
});
