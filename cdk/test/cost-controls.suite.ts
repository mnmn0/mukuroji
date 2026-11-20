/** Registers tests for the monthly cost budget and the cost allocation tag. */
import { expect, test } from '@jest/globals';
import { Match } from 'aws-cdk-lib/assertions';
import {
  COST_ALLOCATION_TAG_KEY,
  COST_ALLOCATION_TAG_VALUE,
} from '../lib/aspects/cost-allocation-tags';
import { synthesizedTemplate } from './test-support';

/** Synthesized CloudFormation resource with optional properties. */
type TemplateResource = Readonly<{
  /** CloudFormation resource type. */
  readonly Type: string;
  /** Resource properties. */
  readonly Properties?: Readonly<Record<string, unknown>>;
}>;

/** Resource types that must carry the cost allocation tag because they bill on their own. */
const BILLED_RESOURCE_TYPES = [
  'AWS::DynamoDB::Table',
  'AWS::Lambda::Function',
  'AWS::S3::Bucket',
  'AWS::SQS::Queue',
  'AWS::KMS::Key',
  'AWS::SecretsManager::Secret',
  'AWS::CloudWatch::Alarm',
  'AWS::Logs::LogGroup',
  'AWS::CloudFront::Distribution',
  'AWS::GuardDuty::MalwareProtectionPlan',
  'AWS::StepFunctions::StateMachine',
];

/**
 * Narrows an unknown value to a CloudFormation resource.
 *
 * @param value - Template value to inspect.
 * @returns Whether the value has a string `Type`.
 */
function isTemplateResource(value: unknown): value is TemplateResource {
  return typeof value === 'object' && value !== null
    && typeof Reflect.get(value, 'Type') === 'string';
}

/**
 * Returns whether a resource's tags include the cost allocation tag.
 *
 * Most resources use a `[{ Key, Value }]` list; Cognito and a few others use a map.
 *
 * @param resource - Synthesized resource.
 * @returns Whether the tag is present with the expected value.
 */
function hasCostAllocationTag(resource: TemplateResource): boolean {
  const properties = resource.Properties ?? {};
  const tags: unknown = properties.Tags ?? properties.UserPoolTags;
  if (Array.isArray(tags)) {
    return tags.some((tag: unknown) =>
      typeof tag === 'object' && tag !== null
      && Reflect.get(tag, 'Key') === COST_ALLOCATION_TAG_KEY
      && Reflect.get(tag, 'Value') === COST_ALLOCATION_TAG_VALUE);
  }
  return typeof tags === 'object' && tags !== null
    && Reflect.get(tags, COST_ALLOCATION_TAG_KEY) === COST_ALLOCATION_TAG_VALUE;
}

test('creates one monthly account cost budget from the budget parameter', () => {
  synthesizedTemplate.resourceCountIs('AWS::Budgets::Budget', 1);
  synthesizedTemplate.hasParameter('MonthlyCostBudgetUsd', {
    Type: 'Number',
    Default: 20,
    MinValue: 1,
  });
  synthesizedTemplate.hasResourceProperties('AWS::Budgets::Budget', {
    Budget: {
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: { Ref: 'MonthlyCostBudgetUsd' }, Unit: 'USD' },
      CostFilters: Match.absent(),
    },
  });
});

test('emails 80% and 100% actual and 100% forecast alerts, falling back to the initial owner', () => {
  const recipient = {
    'Fn::If': [
      'CostBudgetAlertEmailBlank',
      { Ref: 'InitialOwnerEmail' },
      { Ref: 'CostBudgetAlertEmail' },
    ],
  };
  const alerts = [
    ['ACTUAL', 80],
    ['ACTUAL', 100],
    ['FORECASTED', 100],
  ].map(([notificationType, threshold]) => ({
    Notification: {
      NotificationType: notificationType,
      ComparisonOperator: 'GREATER_THAN',
      Threshold: threshold,
      ThresholdType: 'PERCENTAGE',
    },
    Subscribers: [{ SubscriptionType: 'EMAIL', Address: recipient }],
  }));

  synthesizedTemplate.hasResourceProperties('AWS::Budgets::Budget', {
    NotificationsWithSubscribers: alerts,
  });
  synthesizedTemplate.hasParameter('CostBudgetAlertEmail', { Default: '' });
  synthesizedTemplate.hasCondition('CostBudgetAlertEmailBlank', {
    'Fn::Equals': [{ Ref: 'CostBudgetAlertEmail' }, ''],
  });
});

test('tags every billed resource for cost allocation', () => {
  const resources: unknown = synthesizedTemplate.toJSON().Resources;
  if (typeof resources !== 'object' || resources === null) {
    throw new Error('The template has no resources.');
  }
  const untagged = Object.entries(resources)
    .filter((entry): entry is [string, TemplateResource] => isTemplateResource(entry[1]))
    .filter(([, resource]) => BILLED_RESOURCE_TYPES.includes(resource.Type))
    .filter(([, resource]) => !hasCostAllocationTag(resource))
    .map(([logicalId]) => logicalId);

  expect(untagged).toEqual([]);
  synthesizedTemplate.hasResourceProperties('AWS::Cognito::UserPool', {
    UserPoolTags: { [COST_ALLOCATION_TAG_KEY]: COST_ALLOCATION_TAG_VALUE },
  });
});

test('leaves the AppConfig deployment untagged so the tag never replaces it', () => {
  synthesizedTemplate.hasResourceProperties('AWS::AppConfig::Deployment', {
    Tags: Match.absent(),
  });
});
