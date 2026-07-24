import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect } from '@jest/globals';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeKnownNagFindings } from '../lib/acknowledge-nag-findings';
import { CdkStack } from '../lib/cdk-stack';

/**
 * Synthesizes the application stack for infrastructure assertions.
 *
 * @returns The synthesized CloudFormation template.
 */
export function createTemplate(): Template {
  const app = new cdk.App({
    context: {
      '@aws-cdk/aws-iam:minimizePolicies': true,
      '@aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy': false,
      '@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy': true,
    },
  });
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const stack = new CdkStack(app, 'Test');
  acknowledgeKnownNagFindings(stack);

  return Template.fromStack(stack);
}

/**
 * Finds the custom resource that invokes a specified AWS SDK action.
 *
 * @param template - The synthesized template to search.
 * @param action - The AWS SDK action expected in the custom resource.
 * @returns The matching logical ID and custom resource definition.
 */
export function findCustomResource(template: Template, action: string) {
  const resource = Object.entries(template.findResources('Custom::AWS')).find(([, candidate]) =>
    JSON.stringify(candidate).includes(action),
  );

  if (!resource) {
    throw new Error(`Custom resource for ${action} was not found.`);
  }

  return resource;
}

/**
 * Serializes an AWS SDK call containing CloudFormation intrinsic functions.
 *
 * @param value - The SDK call fragment to serialize.
 * @returns A deterministic string representation for assertions.
 */
export function serializeAwsSdkCall(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(serializeAwsSdkCall).join('');
  }

  if (!value || typeof value !== 'object') {
    return String(value ?? '');
  }

  const entries = Object.entries(value);
  const join = entries.find(([key]) => key === 'Fn::Join')?.[1];

  if (Array.isArray(join) && Array.isArray(join[1])) {
    return join[1].map(serializeAwsSdkCall).join(String(join[0] ?? ''));
  }

  const ref = entries.find(([key]) => key === 'Ref')?.[1];
  if (typeof ref === 'string') {
    return `{{Ref:${ref}}}`;
  }

  return entries
    .map(([key, entry]) => `${key}:${serializeAwsSdkCall(entry)}`)
    .join('');
}

/**
 * Verifies that an SQS queue rejects requests made without TLS.
 *
 * @param template - The synthesized template containing the queue.
 * @param logicalIdPrefix - The logical ID prefix of the queue under test.
 * @returns Nothing.
 */
export function expectQueueRequiresSsl(template: Template, logicalIdPrefix: string): void {
  const queueEntry = Object.entries(template.findResources('AWS::SQS::Queue'))
    .find(([logicalId]) => logicalId.startsWith(logicalIdPrefix));
  expect(queueEntry).toBeDefined();
  if (!queueEntry) {
    throw new Error(`${logicalIdPrefix} was not synthesized.`);
  }
  const [queueId] = queueEntry;
  const queuePolicy = Object.values(template.findResources('AWS::SQS::QueuePolicy'))
    .find((resource) => JSON.stringify(resource.Properties?.Queues).includes(queueId));

  expect(queuePolicy).toEqual(expect.objectContaining({
    Properties: expect.objectContaining({
      PolicyDocument: expect.objectContaining({
        Statement: expect.arrayContaining([
          expect.objectContaining({
            Action: 'sqs:*',
            Condition: {
              Bool: {
                'aws:SecureTransport': 'false',
              },
            },
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Resource: { 'Fn::GetAtt': [queueId, 'Arn'] },
          }),
        ]),
      }),
      Queues: expect.arrayContaining([{ Ref: queueId }]),
    }),
  }));
}

/** The synthesized CloudFormation template shared by tests in a Jest module. */
export const synthesizedTemplate = createTemplate();
