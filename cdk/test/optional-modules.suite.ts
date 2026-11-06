/** Registers tests for the stack with every optional module left off. */
import { expect, test } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeKnownNagFindings } from '../lib/acknowledge-nag-findings';
import { RESTORE_DRILL_CONTEXT_KEY, readStackModuleProps } from '../bin/stack-modules';
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
