import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Inputs required to create the stack data stores.
 */
export interface DataStoreBuilderInput {
  /** Secret JSON configuration persisted for connector runtimes. */
  readonly connectorRuntimeConfiguration: cdk.CfnParameter;
}

/**
 * Stateful resources shared by API, worker, storage, bootstrap, and output subsystems.
 */
export type DataStoreResources = {
  /** Legacy project task table retained for compatibility reads. */
  readonly legacyTasksTable: dynamodb.Table;
  /** Canonical team-owned Work Item table. */
  readonly workItemsTable: dynamodb.Table;
  /** Work Item field and workflow configuration table. */
  readonly workItemConfigurationTable: dynamodb.Table;
  /** Automation rules, schedules, and execution state table. */
  readonly automationTable: dynamodb.Table;
  /** Planning domain state table. */
  readonly planningTable: dynamodb.Table;
  /** Capacity planning availability, request, and assignment state table. */
  readonly capacityPlanningTable: dynamodb.Table;
  /** Developer platform configuration and execution state table. */
  readonly developerPlatformTable: dynamodb.Table;
  /** Analytics definitions and scheduled delivery state table. */
  readonly analyticsTable: dynamodb.Table;
  /** Public request intake state table. */
  readonly requestIntakeTable: dynamodb.Table;
  /** Envelope key for developer platform Webhook secrets. */
  readonly developerPlatformWebhookKey: kms.Key;
  /** Envelope key for developer platform connector credentials. */
  readonly developerPlatformConnectorKey: kms.Key;
  /** Envelope key for developer platform cursor and idempotency state. */
  readonly developerPlatformStateKey: kms.Key;
  /** Encryption key for connector runtime configuration. */
  readonly connectorRuntimeConfigurationKey: kms.Key;
  /** Secret containing connector provider runtime configuration. */
  readonly connectorRuntimeSecret: secretsmanager.Secret;
  /** Append-only Work Item event table. */
  readonly teamIssueEventsTable: dynamodb.Table;
  /** Workspace team, project, and membership directory table. */
  readonly projectDirectoryTable: dynamodb.Table;
  /** Immutable audit event outbox table. */
  readonly auditEventsTable: dynamodb.Table;
  /** Idempotency receipts for audit projection consumers. */
  readonly processedAuditEventsTable: dynamodb.Table;
  /** Workspace membership and invitation lifecycle table. */
  readonly workspaceAccessTable: dynamodb.Table;
  /** Enterprise identity configuration and maintenance table. */
  readonly enterpriseIdentityTable: dynamodb.Table;
  /** Tenant profile, entitlement, governance, and lifecycle table. */
  readonly tenantAdministrationTable: dynamodb.Table;
  /** Collaborative documents and whiteboards table. */
  readonly documentsTable: dynamodb.Table;
  /** HMAC secret for public document share tokens. */
  readonly documentPublicShareTokenSecret: secretsmanager.Secret;
  /** Work Item collaboration records table. */
  readonly collaborationTable: dynamodb.Table;
  /** Workspace search documents, views, and preferences table. */
  readonly workspaceSearchTable: dynamodb.Table;
  /** Durable collaboration notification table. */
  readonly notificationsTable: dynamodb.Table;
  /** Realtime connection and one-time ticket table. */
  readonly realtimeSessionsTable: dynamodb.Table;
  /** File upload, proofing, and retention metadata table. */
  readonly fileProofingTable: dynamodb.Table;
};

/**
 * Creates all shared stateful stores with their existing stack scope and construct identifiers.
 *
 * @param stack - Stack that directly owns every data resource.
 * @param input - Parameter values needed by encrypted data resources.
 * @returns Typed references consumed by the remaining stack subsystems.
 */
export function buildDataStores(
  stack: cdk.Stack,
  input: DataStoreBuilderInput,
): DataStoreResources {
  const legacyTasksTable = new dynamodb.Table(stack, 'ProjectTasksTable', {
    partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  legacyTasksTable.addGlobalSecondaryIndex({
    indexName: 'ProjectSortOrderIndex',
    partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  const workItemsTable = new dynamodb.Table(stack, 'TeamIssuesTable', {
    partitionKey: { name: 'directoryTeamId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'issueId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  workItemsTable.addGlobalSecondaryIndex({
    indexName: 'TeamIssueSortOrderIndex',
    partitionKey: { name: 'directoryTeamId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  workItemsTable.addGlobalSecondaryIndex({
    indexName: 'TeamIssueUpdatedAtIndex',
    partitionKey: { name: 'directoryTeamId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  workItemsTable.addGlobalSecondaryIndex({
    indexName: 'AssignedProjectIssueIndex',
    partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  const workItemConfigurationTable = new dynamodb.Table(stack, 'WorkItemConfigurationTable', {
    partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    timeToLiveAttribute: 'expiresAtEpochSeconds',
  });

  const automationTable = new dynamodb.Table(stack, 'AutomationTable', {
    partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    timeToLiveAttribute: 'expiresAt',
  });

  automationTable.addGlobalSecondaryIndex({
    indexName: 'ScheduleDueIndex',
    partitionKey: { name: 'scheduleShard', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'nextRunAtRecordKey', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  automationTable.addGlobalSecondaryIndex({
    indexName: 'RuleExecutionIndex',
    partitionKey: { name: 'ruleExecutionKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'startedAtExecutionId', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  automationTable.addGlobalSecondaryIndex({
    indexName: 'WorkspaceExecutionIndex',
    partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'startedAtExecutionId', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  const planningTable = new dynamodb.Table(stack, 'PlanningTable', {
    partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  planningTable.addGlobalSecondaryIndex({
    indexName: 'UpdateScheduleDueIndex',
    partitionKey: { name: 'updateScheduleShard', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'nextNotificationAtRecordKey', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.KEYS_ONLY,
  });

  const capacityPlanningTable = new dynamodb.Table(stack, 'CapacityPlanningTable', {
    partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    encryption: dynamodb.TableEncryption.AWS_MANAGED,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const developerPlatformTable = new dynamodb.Table(stack, 'DeveloperPlatformTable', {
    partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    encryption: dynamodb.TableEncryption.AWS_MANAGED,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    timeToLiveAttribute: 'expiresAt',
  });

  const analyticsTable = new dynamodb.Table(stack, 'AnalyticsTable', {
    partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  analyticsTable.addGlobalSecondaryIndex({
    indexName: 'ScheduleDueIndex',
    partitionKey: { name: 'scheduleShard', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'nextDeliveryAtRecordKey', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.KEYS_ONLY,
  });

  analyticsTable.addGlobalSecondaryIndex({
    indexName: 'TimeEntryTeamDateIndex',
    partitionKey: { name: 'teamId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'startAt', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  const requestIntakeTable = new dynamodb.Table(stack, 'RequestIntakeTable', {
    partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    timeToLiveAttribute: 'expiresAt',
  });

  developerPlatformTable.addGlobalSecondaryIndex({
    indexName: 'LookupKeyIndex',
    partitionKey: { name: 'lookupKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'lookupSortKey', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.KEYS_ONLY,
  });

  const developerPlatformWebhookKey = new kms.Key(
    stack,
    'DeveloperPlatformWebhookKey',
    {
      description: 'Envelope key for developer platform Webhook signing secrets.',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
  );
  const developerPlatformConnectorKey = new kms.Key(
    stack,
    'DeveloperPlatformConnectorKey',
    {
      description: 'Envelope key for developer platform connector credentials.',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
  );
  const developerPlatformStateKey = new kms.Key(
    stack,
    'DeveloperPlatformStateKey',
    {
      description: 'Envelope key for developer platform cursors and idempotency state.',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
  );
  const connectorRuntimeConfigurationKey = new kms.Key(
    stack,
    'ConnectorRuntimeConfigurationKey',
    {
      description: 'Encryption key for connector provider runtime configuration.',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
  );
  const connectorRuntimeSecret = new secretsmanager.Secret(
    stack,
    'ConnectorRuntimeSecret',
    {
      description:
        'Provider configuration and signing secrets loaded only by connector runtimes.',
      encryptionKey: connectorRuntimeConfigurationKey,
      secretStringValue: cdk.SecretValue.cfnParameter(input.connectorRuntimeConfiguration),
    },
  );
  connectorRuntimeSecret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  requestIntakeTable.addGlobalSecondaryIndex({
    indexName: 'RequestQueueIndex',
    partitionKey: { name: 'queueKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'queueRecordKey', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  const teamIssueEventsTable = new dynamodb.Table(stack, 'TeamIssueEventsTable', {
    partitionKey: { name: 'directoryTeamIssueId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const projectDirectoryTable = new dynamodb.Table(stack, 'ProjectDirectoryTable', {
    partitionKey: { name: 'directoryId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'entryKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  projectDirectoryTable.addGlobalSecondaryIndex({
    indexName: 'WebhookAuthorizationIndex',
    partitionKey: {
      name: 'webhookAuthorizationKey',
      type: dynamodb.AttributeType.STRING,
    },
    sortKey: {
      name: 'webhookAuthorizationSortKey',
      type: dynamodb.AttributeType.STRING,
    },
    projectionType: dynamodb.ProjectionType.KEYS_ONLY,
  });

  const auditEventsTable = new dynamodb.Table(stack, 'AuditEventsTable', {
    partitionKey: { name: 'directoryId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    stream: dynamodb.StreamViewType.NEW_IMAGE,
    timeToLiveAttribute: 'expiresAt',
  });

  for (const [id, partitionKey, sortKey] of [
    ['WorkspaceOccurredAtIndex', 'workspaceKey', 'workspaceEventKey'],
    ['EntityOccurredAtIndex', 'entityKey', 'entityEventKey'],
    ['ActorOccurredAtIndex', 'actorKey', 'actorEventKey'],
    ['TargetOccurredAtIndex', 'targetKey', 'targetEventKey'],
  ] as const) {
    auditEventsTable.addGlobalSecondaryIndex({
      indexName: id,
      partitionKey: { name: partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }

  const processedAuditEventsTable = new dynamodb.Table(stack, 'ProcessedAuditEventsTable', {
    partitionKey: { name: 'consumerName', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    timeToLiveAttribute: 'expiresAt',
  });

  const workspaceAccessTable = new dynamodb.Table(stack, 'WorkspaceAccessTable', {
    partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const enterpriseIdentityTable = new dynamodb.Table(stack, 'EnterpriseIdentityTable', {
    partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    deletionProtection: true,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    stream: dynamodb.StreamViewType.NEW_IMAGE,
    timeToLiveAttribute: 'expiresAt',
  });

  const tenantAdministrationTable = new dynamodb.Table(stack, 'TenantAdministrationTable', {
    partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    encryption: dynamodb.TableEncryption.AWS_MANAGED,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    stream: dynamodb.StreamViewType.NEW_IMAGE,
    timeToLiveAttribute: 'expiresAt',
  });

  const documentsTable = new dynamodb.Table(stack, 'DocumentsTable', {
    partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    encryption: dynamodb.TableEncryption.AWS_MANAGED,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    timeToLiveAttribute: 'expiresAtEpoch',
  });
  const documentPublicShareTokenSecret = new secretsmanager.Secret(
    stack,
    'DocumentPublicShareTokenSecret',
    {
      description:
        'Server-only HMAC key for idempotent mukuroji public document links.',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
    },
  );
  documentPublicShareTokenSecret.applyRemovalPolicy(
    cdk.RemovalPolicy.RETAIN,
  );

  const collaborationTable = new dynamodb.Table(stack, 'WorkItemCollaborationTable', {
    partitionKey: { name: 'entityKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    timeToLiveAttribute: 'expiresAt',
  });

  const workspaceSearchTable = new dynamodb.Table(stack, 'WorkspaceSearchTable', {
    partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const notificationsTable = new dynamodb.Table(stack, 'NotificationsTable', {
    partitionKey: { name: 'recipientKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'notificationKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    timeToLiveAttribute: 'expiresAt',
  });

  notificationsTable.addGlobalSecondaryIndex({
    indexName: 'RecipientStatusIndex',
    partitionKey: { name: 'recipientStatusKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'notificationKey', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  const realtimeSessionsTable = new dynamodb.Table(stack, 'RealtimeSessionsTable', {
    partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    timeToLiveAttribute: 'expiresAt',
  });

  const fileProofingTable = new dynamodb.Table(stack, 'FileProofingTable', {
    partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    timeToLiveAttribute: 'expiresAt',
  });

  return {
    legacyTasksTable,
    workItemsTable,
    workItemConfigurationTable,
    automationTable,
    planningTable,
    capacityPlanningTable,
    developerPlatformTable,
    analyticsTable,
    requestIntakeTable,
    developerPlatformWebhookKey,
    developerPlatformConnectorKey,
    developerPlatformStateKey,
    connectorRuntimeConfigurationKey,
    connectorRuntimeSecret,
    teamIssueEventsTable,
    projectDirectoryTable,
    auditEventsTable,
    processedAuditEventsTable,
    workspaceAccessTable,
    enterpriseIdentityTable,
    tenantAdministrationTable,
    documentsTable,
    documentPublicShareTokenSecret,
    collaborationTable,
    workspaceSearchTable,
    notificationsTable,
    realtimeSessionsTable,
    fileProofingTable,
  };
}

/**
 * Adds the realtime session lookup index at its original point in stack composition.
 *
 * @param resources Data stores containing the realtime session table.
 */
export function configureRealtimeSessionIndexes(resources: DataStoreResources): void {
  resources.realtimeSessionsTable.addGlobalSecondaryIndex({
    indexName: 'ScopeConnectionsIndex',
    partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });
}
