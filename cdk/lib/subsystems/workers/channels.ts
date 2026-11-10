import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Queues owned by the optional connectors module.
 */
export type ConnectorChannels = {
  /** Dead-letter queue for scheduled connector polling failures. */
  readonly connectorPollDlq: sqs.Queue;
  /** Dead-letter queue for connector synchronization failures. */
  readonly connectorSyncDlq: sqs.Queue;
  /** Queue that carries connector synchronization work. */
  readonly connectorSyncQueue: sqs.Queue;
};

/**
 * Durable queues shared by the API and asynchronous workers.
 */
export type WorkerChannels = {
  /** Connector queues, present only when the optional connectors module is deployed. */
  readonly connectorChannels: ConnectorChannels | undefined;
  /** Dead-letter queue for outbound webhook delivery failures. */
  readonly webhookDeliveryDlq: sqs.Queue;
  /** Queue that carries outbound webhook deliveries. */
  readonly webhookDeliveryQueue: sqs.Queue;
  /** Dead-letter queue for Work Item import failures. */
  readonly workItemImportDlq: sqs.Queue;
  /** Queue that carries resumable Work Item imports. */
  readonly workItemImportQueue: sqs.Queue;
  /** Dead-letter queue for asynchronous audit export steps. */
  readonly auditExportDlq: sqs.Queue;
  /** Queue that carries asynchronous audit export steps. */
  readonly auditExportQueue: sqs.Queue;
};

/**
 * Builds durable worker queues with their original construct identifiers.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param connectorsEnabled Whether the optional connectors module is deployed.
 * @returns Shared worker queues and dead-letter queues.
 */
export function buildWorkerChannels(
  scope: cdk.Stack,
  connectorsEnabled: boolean,
): WorkerChannels {
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
  const auditExportDlq = new sqs.Queue(scope, 'AuditExportDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const auditExportQueue = new sqs.Queue(scope, 'AuditExportQueue', {
    deadLetterQueue: {
      maxReceiveCount: 5,
      queue: auditExportDlq,
    },
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    // Outlives the seven-day job lifetime so an unreceived step message is never dropped
    // while its job still looks queued or running.
    retentionPeriod: cdk.Duration.days(8),
    // Six times the five-minute worker timeout, as AWS recommends for SQS event sources.
    visibilityTimeout: cdk.Duration.minutes(30),
  });
  return {
    connectorChannels: connectorsEnabled ? buildConnectorChannels(scope) : undefined,
    webhookDeliveryDlq,
    webhookDeliveryQueue,
    workItemImportDlq,
    workItemImportQueue,
    auditExportDlq,
    auditExportQueue,
  };
}

/**
 * Builds the connector sync queue and its dead-letter queues.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @returns Connector queues consumed by the connector workers and audit projection.
 */
function buildConnectorChannels(scope: cdk.Stack): ConnectorChannels {
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
  return { connectorPollDlq, connectorSyncDlq, connectorSyncQueue };
}
