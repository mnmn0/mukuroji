import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { IConstruct } from 'constructs';

/**
 * Required notification destinations for every CloudWatch alarm in the stack.
 */
export interface AlarmRoutingConfiguration {
  /** Primary and secondary SNS topic ARNs for redundant notification paths. */
  readonly notificationTopicArns: readonly [string, string];
}

/**
 * Adds the mandatory notification destinations to each synthesized CloudWatch alarm.
 */
class AlarmRoutingAspect implements cdk.IAspect {
  /** Primary and secondary alarm actions for redundant notification paths. */
  private readonly alarmActions: readonly [
    cloudwatch.IAlarmAction,
    cloudwatch.IAlarmAction,
  ];

  /**
   * Creates an alarm-routing aspect for the supplied actions.
   *
   * @param alarmActions - Primary and secondary notification actions.
   */
  constructor(
    alarmActions: readonly [
      cloudwatch.IAlarmAction,
      cloudwatch.IAlarmAction,
    ],
  ) {
    this.alarmActions = alarmActions;
  }

  /**
   * Adds primary and secondary actions to a CloudWatch alarm.
   *
   * @param node - Construct currently visited during synthesis.
   * @returns Nothing.
   */
  public visit(node: IConstruct): void {
    if (!(node instanceof cloudwatch.AlarmBase)) {
      return;
    }

    for (const action of this.alarmActions) {
      node.addAlarmAction(action);
    }
  }
}

/**
 * Routes all CloudWatch alarms below a stack to mandatory SNS destinations.
 *
 * @param scope - Stack whose alarms receive the notification actions.
 * @param configuration - Primary and secondary notification topic ARNs.
 * @returns Nothing.
 */
export function configureAlarmRouting(
  scope: cdk.Stack,
  configuration: AlarmRoutingConfiguration,
): void {
  const primaryTopic = sns.Topic.fromTopicArn(
    scope,
    'AlarmPrimaryNotificationTopic',
    configuration.notificationTopicArns[0],
  );
  const secondaryTopic = sns.Topic.fromTopicArn(
    scope,
    'AlarmSecondaryNotificationTopic',
    configuration.notificationTopicArns[1],
  );
  cdk.Aspects.of(scope).add(
    new AlarmRoutingAspect([
      new cloudwatchActions.SnsAction(primaryTopic),
      new cloudwatchActions.SnsAction(secondaryTopic),
    ]),
  );
}
