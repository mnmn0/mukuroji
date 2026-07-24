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

  expect(Object.keys(alarms)).toHaveLength(21);
  synthesizedTemplate.resourceCountIs('AWS::SNS::Topic', 0);
  synthesizedTemplate.resourceCountIs('AWS::SNS::Subscription', 0);
  for (const [logicalId, alarm] of Object.entries(alarms)) {
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
