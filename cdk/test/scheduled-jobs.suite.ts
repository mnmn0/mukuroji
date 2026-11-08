/** Registers tests for the one Lambda that runs every periodic job. */
import { expect, test } from '@jest/globals';
import { Match } from 'aws-cdk-lib/assertions';
import {
  expectQueueRequiresSsl,
  findScheduledJobsFunctionLogicalId,
  synthesizedTemplate,
} from './test-support';

const scheduledJobIds = [
  'AutomationSchedule',
  'TriageSchedule',
  'AgentRunTriage',
  'SlackNotification',
  'AnalyticsSchedule',
  'NotificationSchedule',
];

test('runs every periodic job from one Lambda on one every-minute rule', () => {
  const template = synthesizedTemplate;
  const functionLogicalId = findScheduledJobsFunctionLogicalId(template);
  const rules = Object.values(template.findResources('AWS::Events::Rule'))
    .filter((rule) => JSON.stringify(rule).includes(functionLogicalId));

  expect(rules).toHaveLength(1);
  expect(rules[0]?.Properties).toMatchObject({
    ScheduleExpression: 'rate(1 minute)',
    State: 'ENABLED',
  });
  for (const removedRule of [
    'AutomationScheduleRule',
    'AnalyticsScheduleRule',
    'NotificationScheduleRule',
    'SlackNotificationSchedule',
    'TriageScheduleRule',
    'AgentRunTriageRule',
  ]) {
    expect(Object.keys(template.findResources('AWS::Events::Rule'))
      .some((logicalId) => logicalId.startsWith(removedRule))).toBe(false);
  }
});

test('retries jobs in the handler, not the Lambda, and keeps failures in a retained DLQ', () => {
  const template = synthesizedTemplate;
  const functionLogicalId = findScheduledJobsFunctionLogicalId(template);

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    MemorySize: 1024,
    Timeout: 900,
    TracingConfig: { Mode: 'Active' },
    Environment: { Variables: Match.objectLike({ MUKUROJI_RUNTIME_ROLE: 'scheduled-jobs-worker' }) },
  });
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    FunctionName: { Ref: functionLogicalId },
    MaximumRetryAttempts: 0,
    DestinationConfig: {
      OnFailure: { Destination: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ScheduledJobsDlq'), 'Arn'] } },
    },
  });
  const [, dlq] = Object.entries(template.findResources('AWS::SQS::Queue'))
    .find(([logicalId]) => logicalId.startsWith('ScheduledJobsDlq')) ?? [];
  expect(dlq).toMatchObject({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: { MessageRetentionPeriod: 14 * 24 * 60 * 60, SqsManagedSseEnabled: true },
  });
  expectQueueRequiresSsl(template, 'ScheduledJobsDlq');
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'ApproximateNumberOfMessagesVisible',
    Namespace: 'AWS/SQS',
    Dimensions: [{
      Name: 'QueueName',
      Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ScheduledJobsDlq'), 'QueueName'] },
    }],
    Threshold: 1,
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'DestinationDeliveryFailures',
    Namespace: 'AWS/Lambda',
    Dimensions: [{ Name: 'FunctionName', Value: { Ref: functionLogicalId } }],
    Threshold: 1,
  });
  template.hasOutput('ScheduledJobsFunctionName', {});
  template.hasOutput('ScheduledJobsDlqUrl', {});
});

test('keeps each job in its own policy on the shared role, in place before the first run', () => {
  const template = synthesizedTemplate;
  const functionLogicalId = findScheduledJobsFunctionLogicalId(template);
  const scheduledJobsFunction = template.toJSON().Resources[functionLogicalId];
  const roleLogicalId: unknown = scheduledJobsFunction.Properties.Role['Fn::GetAtt'][0];
  const policies = template.findResources('AWS::IAM::Policy');
  const managedPolicies = template.findResources('AWS::IAM::ManagedPolicy');

  for (const jobId of scheduledJobIds) {
    const entry = Object.entries(managedPolicies)
      .find(([logicalId]) => logicalId.startsWith(`${jobId}JobPolicy`));
    expect(entry?.[1].Properties.Roles).toEqual([{ Ref: roleLogicalId }]);
    expect(scheduledJobsFunction.DependsOn).toContain(entry?.[0]);
  }
  // Automation keeps its narrowly scoped secret and transaction policies.
  for (const policyPrefix of [
    'AutomationScheduleTransactWritePolicy',
    'AutomationScheduleWebhookSecretPolicy',
    'AutomationScheduleInboundWebhookSecretCleanupPolicy',
  ]) {
    const entry = Object.entries(policies).find(([logicalId]) => logicalId.startsWith(policyPrefix));
    expect(entry?.[1].Properties.Roles).toEqual([{ Ref: roleLogicalId }]);
    expect(scheduledJobsFunction.DependsOn).toContain(entry?.[0]);
  }
});

test('grants the jobs through the role only, never through table resource policies', () => {
  const template = synthesizedTemplate;
  const functionLogicalId = findScheduledJobsFunctionLogicalId(template);
  const roleLogicalId: unknown =
    template.toJSON().Resources[functionLogicalId].Properties.Role['Fn::GetAtt'][0];
  const tablesTrustingRole = Object.entries(template.findResources('AWS::DynamoDB::Table'))
    .filter(([, table]) =>
      JSON.stringify(table.Properties?.ResourcePolicy ?? {}).includes(String(roleLogicalId)))
    .map(([logicalId]) => logicalId);

  expect(tablesTrustingRole).toEqual([]);
});

/**
 * Replaces CloudFormation intrinsics with values at least as long as the deployed ones, so a
 * policy's length approximates the size IAM counts after deployment.
 *
 * @param value Policy document fragment.
 * @returns The fragment with intrinsics resolved to placeholder strings.
 */
function resolveConservatively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveConservatively);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if ('Fn::GetAtt' in record) return 'a'.repeat(128);
  if ('Ref' in record) return record.Ref === 'AWS::Partition' ? 'aws-us-gov' : 'r'.repeat(64);
  if ('Fn::Join' in record) {
    const [separator, parts] = record['Fn::Join'] as [string, unknown[]];
    return parts.map((part) => String(resolveConservatively(part))).join(separator);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, resolveConservatively(entry)]),
  );
}

test('keeps the shared role within the IAM policy size quotas', () => {
  const template = synthesizedTemplate;
  const functionLogicalId = findScheduledJobsFunctionLogicalId(template);
  const roleLogicalId: unknown =
    template.toJSON().Resources[functionLogicalId].Properties.Role['Fn::GetAtt'][0];
  const attachedToRole = (resource: Record<string, unknown>) =>
    JSON.stringify(Reflect.get(Object(resource.Properties), 'Roles') ?? [])
      .includes(String(roleLogicalId));
  const policySize = (resource: Record<string, unknown>) =>
    JSON.stringify(resolveConservatively(
      Reflect.get(Object(resource.Properties), 'PolicyDocument'),
    )).length;

  const inlinePolicies = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(attachedToRole);
  const managedPolicies = Object.values(template.findResources('AWS::IAM::ManagedPolicy'))
    .filter(attachedToRole);
  const awsManagedPolicies: unknown =
    template.toJSON().Resources[String(roleLogicalId)].Properties.ManagedPolicyArns;

  // Inline policies share one 10,240-character budget per role.
  expect(inlinePolicies.reduce((total, policy) => total + policySize(policy), 0))
    .toBeLessThan(10_240);
  // Each customer-managed policy has its own 6,144-character budget.
  for (const policy of managedPolicies) expect(policySize(policy)).toBeLessThan(6_144);
  // A role holds at most 10 managed policies by default.
  expect(managedPolicies.length + (Array.isArray(awsManagedPolicies) ? awsManagedPolicies.length : 0))
    .toBeLessThanOrEqual(10);
});
