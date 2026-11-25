import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { ScheduledJobGrant } from './scheduled-jobs';
import type { ScheduleWorkerInput } from './schedules';

/** Resources that carry SES bounce and complaint feedback back to the application. */
export type EmailFeedbackResources = {
  /** Configuration set every notification email is sent through. */
  readonly configurationSet: ses.ConfigurationSet;
  /** Queue EventBridge fills with bounce and complaint events. */
  readonly feedbackQueue: sqs.Queue;
  /** Dead-letter queue for events the job could not read. */
  readonly feedbackDlq: sqs.Queue;
  /** Every-minute job that records the events as suppressions. */
  readonly job: ScheduledJobGrant;
};

/**
 * Builds the SES configuration set whose bounce and complaint events EventBridge queues for the
 * every-minute feedback job, which records them as per-recipient suppressions.
 *
 * The resources cost nothing while no email is sent, so they exist in every deployment; the job
 * reads the queue only when `NotificationEmailSender` is set.
 *
 * @param scope - Stack scope used to preserve stable construct identities.
 * @param input - Shared storage and configuration.
 * @returns The configuration set for the Email job and the feedback job.
 */
export function defineEmailFeedback(scope: cdk.Stack, input: ScheduleWorkerInput): EmailFeedbackResources {
  const stores = input.dataStores;
  const configurationSet = new ses.ConfigurationSet(scope, 'NotificationEmailConfigurationSet', {
    // SES also stops mail to addresses on the account-level suppression list.
    suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
  });
  configurationSet.addEventDestination('NotificationEmailFeedbackDestination', {
    destination: ses.EventDestination.eventBus(events.EventBus.fromEventBusName(scope, 'DefaultEventBus', 'default')),
    events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT],
  });

  const feedbackDlq = new sqs.Queue(scope, 'NotificationEmailFeedbackDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const feedbackQueue = new sqs.Queue(scope, 'NotificationEmailFeedbackQueue', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    retentionPeriod: cdk.Duration.days(14),
    // Longer than one job run, so a message is never handled twice within a run.
    visibilityTimeout: cdk.Duration.minutes(5),
    deadLetterQueue: { queue: feedbackDlq, maxReceiveCount: 5 },
  });
  new events.Rule(scope, 'NotificationEmailFeedbackRule', {
    description: 'Queues SES bounce and complaint events of notification email for the suppression job.',
    eventPattern: {
      source: ['aws.ses'],
      detailType: ['Email Bounced', 'Email Complaint Received'],
      detail: { mail: { tags: { 'ses:configuration-set': [configurationSet.configurationSetName] } } },
    },
    targets: [new eventsTargets.SqsQueue(feedbackQueue)],
  });
  new cloudwatch.Alarm(scope, 'NotificationEmailFeedbackDlqAlarm', {
    alarmDescription: 'An SES bounce or complaint event could not be read after five tries; inspect the feedback dead-letter queue.',
    metric: feedbackDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
    threshold: 1, evaluationPeriods: 1, datapointsToAlarm: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  return {
    configurationSet,
    feedbackQueue,
    feedbackDlq,
    job: {
      id: 'EmailFeedback',
      runtimeScope: 'notification-schedule',
      // Two small statements, so they stay in the shared role's inline policy.
      policy: 'shared-role',
      environment: {
        NOTIFICATION_EMAIL_SENDER: input.parameters.notificationEmailSender.valueAsString,
        NOTIFICATION_EMAIL_FEEDBACK_QUEUE_URL: feedbackQueue.queueUrl,
        NOTIFICATIONS_TABLE_NAME: stores.notificationsTable.tableName,
      },
      grant: (grantee) => {
        grantee.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage'], resources: [feedbackQueue.queueArn],
        }));
        // Writes only the recipient's suppression row beside the notification preferences.
        grantee.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['dynamodb:UpdateItem'], resources: [stores.notificationsTable.tableArn],
        }));
      },
    },
  };
}
