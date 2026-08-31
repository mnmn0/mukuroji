/** Registers mandatory CloudWatch alarm routing tests. */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { expect, test } from '@jest/globals';
import { configureAlarmRouting } from '../lib/aspects/alarm-routing';
import { synthesizedTemplate } from './test-support';

test('routes every CloudWatch alarm to distinct primary and secondary SNS topics', () => {
  const alarms = synthesizedTemplate.findResources('AWS::CloudWatch::Alarm');
  const compositeAlarms = synthesizedTemplate.findResources(
    'AWS::CloudWatch::CompositeAlarm',
  );
  const expectedPrimaryAction = {
    'Fn::Join': [
      '',
      [
        'arn:',
        { Ref: 'AWS::Partition' },
        ':sns:',
        { Ref: 'AWS::Region' },
        ':',
        { Ref: 'AWS::AccountId' },
        ':',
        { Ref: 'AlarmPrimaryTopicName' },
      ],
    ],
  };
  const expectedSecondaryAction = {
    'Fn::Join': [
      '',
      [
        'arn:',
        { Ref: 'AWS::Partition' },
        ':sns:',
        { Ref: 'AWS::Region' },
        ':',
        { Ref: 'AWS::AccountId' },
        ':',
        { Ref: 'AlarmSecondaryTopicName' },
      ],
    ],
  };

  expect(Object.keys(alarms)).toHaveLength(51);
  expect(Object.keys(compositeAlarms)).toHaveLength(1);
  synthesizedTemplate.resourceCountIs('AWS::SNS::Topic', 0);
  synthesizedTemplate.resourceCountIs('AWS::SNS::Subscription', 0);
  expect(JSON.stringify(synthesizedTemplate.toJSON()))
    .not.toContain('WorkspaceSearchMigrationAlarmEvidence');
  for (
    const [logicalId, alarm]
    of Object.entries({ ...alarms, ...compositeAlarms })
  ) {
    const actions = alarm.Properties?.AlarmActions;

    expect(Array.isArray(actions)).toBe(true);
    if (!Array.isArray(actions)) {
      throw new Error(`${logicalId} does not define alarm actions.`);
    }
    expect(actions).toEqual(expect.arrayContaining([
      expectedPrimaryAction,
      expectedSecondaryAction,
    ]));
  }
});

test('routes composite alarms while preserving an existing metric alarm action', () => {
  const account = '111122223333';
  const region = 'us-east-1';
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'AlarmRoutingFixture', {
    env: { account, region },
  });
  const metricAlarm = new cloudwatch.Alarm(stack, 'MetricAlarm', {
    metric: new cloudwatch.Metric({
      metricName: 'FailureCount',
      namespace: 'Mukuroji/Test',
    }),
    evaluationPeriods: 1,
    threshold: 1,
  });
  const existingTopicArn = `arn:aws:sns:${region}:${account}:existing`;
  const primaryTopicArn = `arn:aws:sns:${region}:${account}:primary`;
  const secondaryTopicArn = `arn:aws:sns:${region}:${account}:secondary`;
  const existingTopic = sns.Topic.fromTopicArn(
    stack,
    'ExistingNotificationTopic',
    existingTopicArn,
  );
  metricAlarm.addAlarmAction(new cloudwatchActions.SnsAction(existingTopic));
  new cloudwatch.CompositeAlarm(stack, 'CompositeAlarm', {
    alarmRule: cloudwatch.AlarmRule.anyOf(metricAlarm),
  });

  configureAlarmRouting(stack, {
    notificationTopicArns: [primaryTopicArn, secondaryTopicArn],
  });

  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmActions: Match.arrayWith([
      existingTopicArn,
      primaryTopicArn,
      secondaryTopicArn,
    ]),
  });
  template.hasResourceProperties('AWS::CloudWatch::CompositeAlarm', {
    AlarmActions: Match.arrayWith([
      primaryTopicArn,
      secondaryTopicArn,
    ]),
  });
});

test('does not duplicate a mandatory action already attached to an alarm', () => {
  const account = '111122223333';
  const region = 'us-east-1';
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'ExistingMandatoryActionFixture', {
    env: { account, region },
  });
  const metricAlarm = new cloudwatch.Alarm(stack, 'MetricAlarm', {
    metric: new cloudwatch.Metric({
      metricName: 'FailureCount',
      namespace: 'Mukuroji/Test',
    }),
    evaluationPeriods: 1,
    threshold: 1,
  });
  const primaryTopicArn = `arn:aws:sns:${region}:${account}:primary`;
  const secondaryTopicArn = `arn:aws:sns:${region}:${account}:secondary`;
  const primaryTopic = sns.Topic.fromTopicArn(
    stack,
    'ExistingPrimaryNotificationTopic',
    primaryTopicArn,
  );
  metricAlarm.addAlarmAction(new cloudwatchActions.SnsAction(primaryTopic));

  configureAlarmRouting(stack, {
    notificationTopicArns: [primaryTopicArn, secondaryTopicArn],
  });

  Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmActions: [primaryTopicArn, secondaryTopicArn],
  });
});

test('rejects duplicate existing alarm destinations', () => {
  const account = '111122223333';
  const region = 'us-east-1';
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'DuplicateAlarmActionFixture', {
    env: { account, region },
  });
  const metricAlarm = new cloudwatch.Alarm(stack, 'MetricAlarm', {
    metric: new cloudwatch.Metric({
      metricName: 'FailureCount',
      namespace: 'Mukuroji/Test',
    }),
    evaluationPeriods: 1,
    threshold: 1,
  });
  const existingTopic = sns.Topic.fromTopicArn(
    stack,
    'ExistingNotificationTopic',
    `arn:aws:sns:${region}:${account}:existing`,
  );
  const existingAction = new cloudwatchActions.SnsAction(existingTopic);
  metricAlarm.addAlarmAction(existingAction, existingAction);

  configureAlarmRouting(stack, {
    notificationTopicArns: [
      `arn:aws:sns:${region}:${account}:primary`,
      `arn:aws:sns:${region}:${account}:secondary`,
    ],
  });

  expect(() => Template.fromStack(stack)).toThrow(
    'AlarmActions must contain unique destinations',
  );
});

test('rejects alarm routing that would exceed the five-action limit', () => {
  const account = '111122223333';
  const region = 'us-east-1';
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'AlarmActionLimitFixture', {
    env: { account, region },
  });
  const metricAlarm = new cloudwatch.Alarm(stack, 'MetricAlarm', {
    metric: new cloudwatch.Metric({
      metricName: 'FailureCount',
      namespace: 'Mukuroji/Test',
    }),
    evaluationPeriods: 1,
    threshold: 1,
  });
  const existingTopics = [
    sns.Topic.fromTopicArn(
      stack,
      'ExistingOneNotificationTopic',
      `arn:aws:sns:${region}:${account}:existing-one`,
    ),
    sns.Topic.fromTopicArn(
      stack,
      'ExistingTwoNotificationTopic',
      `arn:aws:sns:${region}:${account}:existing-two`,
    ),
    sns.Topic.fromTopicArn(
      stack,
      'ExistingThreeNotificationTopic',
      `arn:aws:sns:${region}:${account}:existing-three`,
    ),
    sns.Topic.fromTopicArn(
      stack,
      'ExistingFourNotificationTopic',
      `arn:aws:sns:${region}:${account}:existing-four`,
    ),
  ];
  for (const topic of existingTopics) {
    metricAlarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));
  }

  configureAlarmRouting(stack, {
    notificationTopicArns: [
      `arn:aws:sns:${region}:${account}:primary`,
      `arn:aws:sns:${region}:${account}:secondary`,
    ],
  });

  expect(() => Template.fromStack(stack)).toThrow(
    'AlarmActions supports at most 5 destinations',
  );
});

test('rejects identical primary and secondary alarm destinations', () => {
  const account = '111122223333';
  const region = 'us-east-1';
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'IdenticalAlarmDestinationFixture', {
    env: { account, region },
  });
  new cloudwatch.Alarm(stack, 'MetricAlarm', {
    metric: new cloudwatch.Metric({
      metricName: 'FailureCount',
      namespace: 'Mukuroji/Test',
    }),
    evaluationPeriods: 1,
    threshold: 1,
  });
  const sharedTopicArn = `arn:aws:sns:${region}:${account}:shared`;

  configureAlarmRouting(stack, {
    notificationTopicArns: [sharedTopicArn, sharedTopicArn],
  });

  expect(() => Template.fromStack(stack)).toThrow(
    'Primary and secondary notification destinations must be distinct',
  );
});

test('rejects a direct L1 alarm that bypasses mandatory routing', () => {
  const account = '111122223333';
  const region = 'us-east-1';
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'DirectAlarmFixture', {
    env: { account, region },
  });
  new cloudwatch.CfnAlarm(stack, 'DirectAlarm', {
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'FailureCount',
    namespace: 'Mukuroji/Test',
    period: 60,
    statistic: 'Sum',
    threshold: 1,
  });

  configureAlarmRouting(stack, {
    notificationTopicArns: [
      `arn:aws:sns:${region}:${account}:primary`,
      `arn:aws:sns:${region}:${account}:secondary`,
    ],
  });

  expect(() => Template.fromStack(stack)).toThrow(
    'AlarmActions must retain both mandatory notification destinations',
  );
});

test('rejects an AlarmActions override that removes mandatory routing', () => {
  const account = '111122223333';
  const region = 'us-east-1';
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'AlarmActionOverrideFixture', {
    env: { account, region },
  });
  const metricAlarm = new cloudwatch.Alarm(stack, 'MetricAlarm', {
    metric: new cloudwatch.Metric({
      metricName: 'FailureCount',
      namespace: 'Mukuroji/Test',
    }),
    evaluationPeriods: 1,
    threshold: 1,
  });
  const alarmResource = metricAlarm.node.defaultChild;
  if (!(alarmResource instanceof cloudwatch.CfnAlarm)) {
    throw new Error('MetricAlarm must own a CfnAlarm resource.');
  }
  alarmResource.addPropertyOverride('AlarmActions', [
    `arn:aws:sns:${region}:${account}:override-only`,
  ]);

  configureAlarmRouting(stack, {
    notificationTopicArns: [
      `arn:aws:sns:${region}:${account}:primary`,
      `arn:aws:sns:${region}:${account}:secondary`,
    ],
  });

  expect(() => Template.fromStack(stack)).toThrow(
    'AlarmActions must retain both mandatory notification destinations',
  );
});

test('rejects an AlarmActions override that drops an existing destination', () => {
  const account = '111122223333';
  const region = 'us-east-1';
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'ExistingAlarmActionOverrideFixture', {
    env: { account, region },
  });
  const metricAlarm = new cloudwatch.Alarm(stack, 'MetricAlarm', {
    metric: new cloudwatch.Metric({
      metricName: 'FailureCount',
      namespace: 'Mukuroji/Test',
    }),
    evaluationPeriods: 1,
    threshold: 1,
  });
  const existingTopic = sns.Topic.fromTopicArn(
    stack,
    'ExistingNotificationTopic',
    `arn:aws:sns:${region}:${account}:existing`,
  );
  metricAlarm.addAlarmAction(new cloudwatchActions.SnsAction(existingTopic));
  const alarmResource = metricAlarm.node.defaultChild;
  if (!(alarmResource instanceof cloudwatch.CfnAlarm)) {
    throw new Error('MetricAlarm must own a CfnAlarm resource.');
  }
  alarmResource.addPropertyOverride('AlarmActions', [
    `arn:aws:sns:${region}:${account}:primary`,
    `arn:aws:sns:${region}:${account}:secondary`,
  ]);

  configureAlarmRouting(stack, {
    notificationTopicArns: [
      `arn:aws:sns:${region}:${account}:primary`,
      `arn:aws:sns:${region}:${account}:secondary`,
    ],
  });

  expect(() => Template.fromStack(stack)).toThrow(
    'AlarmActions must preserve every pre-routing destination',
  );
});

test('recognizes equivalent Fn::Sub and Fn::Join alarm destinations', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'EquivalentAlarmDestinationFixture');
  const metricAlarm = new cloudwatch.Alarm(stack, 'MetricAlarm', {
    metric: new cloudwatch.Metric({
      metricName: 'FailureCount',
      namespace: 'Mukuroji/Test',
    }),
    evaluationPeriods: 1,
    threshold: 1,
  });
  const primaryTopicArn = stack.formatArn({
    resource: 'primary',
    service: 'sns',
  });
  const secondaryTopicArn = stack.formatArn({
    resource: 'secondary',
    service: 'sns',
  });
  const primaryTopic = sns.Topic.fromTopicArn(
    stack,
    'ExistingPrimaryNotificationTopic',
    cdk.Fn.sub(
      'arn:${AWS::Partition}:sns:${AWS::Region}:${AWS::AccountId}:primary',
    ),
  );
  metricAlarm.addAlarmAction(new cloudwatchActions.SnsAction(primaryTopic));

  configureAlarmRouting(stack, {
    notificationTopicArns: [primaryTopicArn, secondaryTopicArn],
  });

  const alarms = Template.fromStack(stack).findResources(
    'AWS::CloudWatch::Alarm',
  );
  const [alarm] = Object.values(alarms);
  const actions = alarm?.Properties?.AlarmActions;
  if (!Array.isArray(actions)) {
    throw new Error('MetricAlarm must define alarm actions.');
  }
  expect(actions).toHaveLength(2);
});
