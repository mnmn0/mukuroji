import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Durable queues shared by the API and asynchronous workers.
 */
export type WorkerChannels = {
  /** Dead-letter queue for scheduled connector polling failures. */
  readonly connectorPollDlq: sqs.Queue;
  /** Dead-letter queue for connector synchronization failures. */
  readonly connectorSyncDlq: sqs.Queue;
  /** Queue that carries connector synchronization work. */
  readonly connectorSyncQueue: sqs.Queue;
  /** Dead-letter queue for outbound webhook delivery failures. */
  readonly webhookDeliveryDlq: sqs.Queue;
  /** Queue that carries outbound webhook deliveries. */
  readonly webhookDeliveryQueue: sqs.Queue;
  /** Dead-letter queue for Work Item import failures. */
  readonly workItemImportDlq: sqs.Queue;
  /** Queue that carries resumable Work Item imports. */
  readonly workItemImportQueue: sqs.Queue;
};

/**
 * Builds durable worker queues with their original construct identifiers.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @returns Shared worker queues and dead-letter queues.
 */
export function buildWorkerChannels(scope: cdk.Stack): WorkerChannels {
  const webhookDeliveryDlq = new sqs.Queue(scope, 'WebhookDeliveryDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const webhookDeliveryQueue = new sqs.Queue(scope, 'WebhookDeliveryQueue', {
    deadLetterQueue: {
      maxReceiveCount: 5,
      queue: webhookDeliveryDlq,
    },
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
    visibilityTimeout: cdk.Duration.minutes(3),
  });
  const workItemImportDlq = new sqs.Queue(scope, 'WorkItemImportDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const workItemImportQueue = new sqs.Queue(scope, 'WorkItemImportQueue', {
    deadLetterQueue: {
      maxReceiveCount: 5,
      queue: workItemImportDlq,
    },
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
    visibilityTimeout: cdk.Duration.minutes(90),
  });
  const connectorSyncDlq = new sqs.Queue(scope, 'ConnectorSyncDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const connectorPollDlq = new sqs.Queue(scope, 'ConnectorPollDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const connectorSyncQueue = new sqs.Queue(scope, 'ConnectorSyncQueue', {
    deadLetterQueue: {
      maxReceiveCount: 5,
      queue: connectorSyncDlq,
    },
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
    visibilityTimeout: cdk.Duration.minutes(30),
  });

  return {
    connectorPollDlq,
    connectorSyncDlq,
    connectorSyncQueue,
    webhookDeliveryDlq,
    webhookDeliveryQueue,
    workItemImportDlq,
    workItemImportQueue,
  };
}
