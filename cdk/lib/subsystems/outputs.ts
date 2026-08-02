import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import type { FileBucketIncarnationMarker } from './file-storage';

/**
 * Resources whose deployment attributes are published as stack outputs.
 */
export type StackOutputResources = {
  /** Legacy project task table retained for backward compatibility. */
  readonly legacyTasksTable: dynamodb.ITable;
  /** Project directory table. */
  readonly projectDirectoryTable: dynamodb.ITable;
  /** Canonical Work Item table, also exposed through the legacy team issue output. */
  readonly workItemsTable: dynamodb.ITable;
  /** Work Item workflow and custom field configuration table. */
  readonly workItemConfigurationTable: dynamodb.ITable;
  /** Automation rules and execution state table. */
  readonly automationTable: dynamodb.ITable;
  /** Planning and portfolio data table. */
  readonly planningTable: dynamodb.ITable;
  /** Developer platform state table. */
  readonly developerPlatformTable: dynamodb.ITable;
  /** Analytics facts, reports, and snapshots table. */
  readonly analyticsTable: dynamodb.ITable;
  /** Public request intake table. */
  readonly requestIntakeTable: dynamodb.ITable;
  /** Append-only Work Item event table. */
  readonly teamIssueEventsTable: dynamodb.ITable;
  /** Workspace directory identifier parameter. */
  readonly workspaceDirectoryId: cdk.CfnParameter;
  /** Workspace audit event table with a stream enabled. */
  readonly auditEventsTable: dynamodb.ITable;
  /** Table that tracks audit events processed by downstream consumers. */
  readonly processedAuditEventsTable: dynamodb.ITable;
  /** Workspace membership and invitation table. */
  readonly workspaceAccessTable: dynamodb.ITable;
  /** Enterprise identity and security state table. */
  readonly enterpriseIdentityTable: dynamodb.ITable;
  /** Collaborative documents table. */
  readonly documentsTable: dynamodb.ITable;
  /** Work Item collaboration projection table. */
  readonly collaborationTable: dynamodb.ITable;
  /** Workspace search index table. */
  readonly workspaceSearchTable: dynamodb.ITable;
  /** Durable Workspace Search migration checkpoint and operation state table. */
  readonly workspaceSearchMigrationStateTable: dynamodb.ITable;
  /** Write-once Workspace Search migration preimage journal bucket. */
  readonly workspaceSearchMigrationJournalBucket: s3.IBucket;
  /** Customer-managed encryption key for the migration journal. */
  readonly workspaceSearchMigrationJournalKey: kms.IKey;
  /** Least-privilege policy attached explicitly to an approved migration operator. */
  readonly workspaceSearchMigrationOperatorPolicy: iam.IManagedPolicy;
  /** Non-production-only retention extension attached alongside the migration operator policy. */
  readonly workspaceSearchMigrationRehearsalEvidencePolicy: iam.IManagedPolicy;
  /** Deployment condition guarding rehearsal-only evidence resources. */
  readonly workspaceSearchMigrationRehearsalEvidenceCondition: cdk.CfnCondition;
  /** Read-only policy attached explicitly to an approved integrity-check operator. */
  readonly crossDomainIntegrityOperatorPolicy: iam.IManagedPolicy;
  /** Standard state machine that performs an isolated restore drill. */
  readonly workflow: stepfunctions.IStateMachine;
  /** Standard state machine that performs approval-gated drill cleanup. */
  readonly cleanupWorkflow: stepfunctions.IStateMachine;
  /** Append-only immutable restore-drill evidence bucket. */
  readonly evidenceBucket: s3.IBucket;
  /** Isolated bucket containing temporary exports and exact object copies. */
  readonly scratchBucket: s3.IBucket;
  /** Durable restore-drill run, checkpoint, and cadence table. */
  readonly stateTable: dynamodb.ITable;
  /** Unattached policy for data-owner cleanup approval sessions. */
  readonly cleanupApprovalPolicy: iam.IManagedPolicy;
  /** Dead-letter queue for exhausted restore-drill schedule deliveries. */
  readonly scheduleDlq: sqs.IQueue;
  /** Durable notification table. */
  readonly notificationsTable: dynamodb.ITable;
  /** Realtime connection and session table. */
  readonly realtimeSessionsTable: dynamodb.ITable;
  /** File proofing metadata table. */
  readonly fileProofingTable: dynamodb.ITable;
  /** Versioned workspace file bucket. */
  readonly fileBucket: s3.IBucket;
  /** Exact immutable marker that identifies this file-bucket incarnation. */
  readonly fileBucketIncarnationMarker: FileBucketIncarnationMarker;
  /** GuardDuty malware protection plan for workspace files. */
  readonly malwareProtectionPlan: guardduty.CfnMalwareProtectionPlan;
  /** Deployed realtime WebSocket stage. */
  readonly realtimeWebSocketStage: apigatewayv2.WebSocketStage;
  /** Dead-letter queue for collaboration projection failures. */
  readonly collaborationProjectionDlq: sqs.IQueue;
  /** Dead-letter queue for enterprise identity maintenance failures. */
  readonly enterpriseIdentityMaintenanceDlq: sqs.IQueue;
  /** Lambda function that processes enterprise SCIM group jobs. */
  readonly enterpriseScimGroupJobFunction: lambda.IFunction;
  /** Dead-letter queue for enterprise SCIM group jobs. */
  readonly enterpriseScimGroupJobDlq: sqs.IQueue;
  /** Queue that carries outbound webhook deliveries. */
  readonly webhookDeliveryQueue: sqs.IQueue;
  /** Dead-letter queue for outbound webhook delivery failures. */
  readonly webhookDeliveryDlq: sqs.IQueue;
  /** Versioned bucket that stores Work Item import sources. */
  readonly workItemImportBucket: s3.IBucket;
  /** Queue that carries resumable Work Item imports. */
  readonly workItemImportQueue: sqs.IQueue;
  /** Dead-letter queue for Work Item import failures. */
  readonly workItemImportDlq: sqs.IQueue;
  /** Secret that stores connector runtime credentials. */
  readonly connectorRuntimeSecret: secretsmanager.ISecret;
  /** Queue that carries connector synchronization work. */
  readonly connectorSyncQueue: sqs.IQueue;
  /** Dead-letter queue for connector synchronization failures. */
  readonly connectorSyncDlq: sqs.IQueue;
  /** Dead-letter queue for scheduled connector polling failures. */
  readonly connectorPollDlq: sqs.IQueue;
  /** Dead-letter queue for event-triggered automation failures. */
  readonly automationEventDlq: sqs.IQueue;
  /** Dead-letter queue for scheduled automation failures. */
  readonly automationScheduleDlq: sqs.IQueue;
  /** Dead-letter queue for scheduled analytics failures. */
  readonly analyticsScheduleDlq: sqs.IQueue;
  /** Dead-letter queue for scheduled notification failures. */
  readonly notificationScheduleDlq: sqs.IQueue;
  /** Lambda function that ingests request email. */
  readonly requestEmailIngestionFunction: lambda.IFunction;
  /** Dead-letter queue for request email ingestion failures. */
  readonly requestEmailIngestionDlq: sqs.IQueue;
  /** Lambda Function URL for the project task API. */
  readonly functionUrl: lambda.FunctionUrl;
  /** HTTP API Gateway endpoint for the project task API. */
  readonly httpApi: apigatewayv2.HttpApi;
  /** AWS AppConfig application identifier for runtime controls. */
  readonly applicationId: string;
  /** AWS AppConfig environment identifier for runtime controls. */
  readonly environmentId: string;
  /** AWS AppConfig configuration profile identifier for runtime controls. */
  readonly configurationProfileId: string;
  /** AWS AppConfig canary deployment strategy identifier for operator changes. */
  readonly canaryDeploymentStrategyId: string;
};

/**
 * Publishes stable deployment attributes with their original output identifiers.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param resources Resources whose deployment attributes are published.
 * @returns Nothing.
 */
export function buildStackOutputs(
  scope: cdk.Stack,
  resources: StackOutputResources,
): void {
  new cdk.CfnOutput(scope, 'ProjectTasksTableName', {
    value: resources.legacyTasksTable.tableName,
  });
  new cdk.CfnOutput(scope, 'ProjectDirectoryTableName', {
    value: resources.projectDirectoryTable.tableName,
  });
  new cdk.CfnOutput(scope, 'TeamIssuesTableName', {
    value: resources.workItemsTable.tableName,
  });
  new cdk.CfnOutput(scope, 'WorkItemsTableName', {
    value: resources.workItemsTable.tableName,
  });
  new cdk.CfnOutput(scope, 'WorkItemConfigurationTableName', {
    value: resources.workItemConfigurationTable.tableName,
  });
  new cdk.CfnOutput(scope, 'AutomationTableName', {
    value: resources.automationTable.tableName,
  });
  new cdk.CfnOutput(scope, 'PlanningTableName', {
    value: resources.planningTable.tableName,
  });
  new cdk.CfnOutput(scope, 'DeveloperPlatformTableName', {
    value: resources.developerPlatformTable.tableName,
  });
  new cdk.CfnOutput(scope, 'DeveloperPlatformLookupIndexName', {
    value: 'LookupKeyIndex',
  });
  new cdk.CfnOutput(scope, 'AnalyticsTableName', {
    value: resources.analyticsTable.tableName,
  });
  new cdk.CfnOutput(scope, 'RequestIntakeTableName', {
    value: resources.requestIntakeTable.tableName,
  });
  new cdk.CfnOutput(scope, 'TeamIssueEventsTableName', {
    value: resources.teamIssueEventsTable.tableName,
  });
  const workspaceDirectoryIdOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceDirectoryIdOutput',
    {
      value: resources.workspaceDirectoryId.valueAsString,
    },
  );
  workspaceDirectoryIdOutput.overrideLogicalId('WorkspaceDirectoryId');
  new cdk.CfnOutput(scope, 'AuditEventsTableName', {
    value: resources.auditEventsTable.tableName,
  });
  new cdk.CfnOutput(scope, 'AuditEventsStreamArn', {
    value: resources.auditEventsTable.tableStreamArn!,
  });
  new cdk.CfnOutput(scope, 'ProcessedAuditEventsTableName', {
    value: resources.processedAuditEventsTable.tableName,
  });
  new cdk.CfnOutput(scope, 'WorkspaceAccessTableName', {
    value: resources.workspaceAccessTable.tableName,
  });
  new cdk.CfnOutput(scope, 'EnterpriseIdentityTableName', {
    value: resources.enterpriseIdentityTable.tableName,
  });
  new cdk.CfnOutput(scope, 'DocumentsTableName', {
    value: resources.documentsTable.tableName,
  });
  new cdk.CfnOutput(scope, 'WorkItemCollaborationTableName', {
    value: resources.collaborationTable.tableName,
  });
  new cdk.CfnOutput(scope, 'WorkspaceSearchTableName', {
    value: resources.workspaceSearchTable.tableName,
  });
  new cdk.CfnOutput(scope, 'WorkspaceSearchMigrationStateTableName', {
    value: resources.workspaceSearchMigrationStateTable.tableName,
  });
  new cdk.CfnOutput(scope, 'WorkspaceSearchMigrationJournalBucketName', {
    value: resources.workspaceSearchMigrationJournalBucket.bucketName,
  });
  new cdk.CfnOutput(scope, 'WorkspaceSearchMigrationJournalKeyArn', {
    value: resources.workspaceSearchMigrationJournalKey.keyArn,
  });
  new cdk.CfnOutput(scope, 'WorkspaceSearchMigrationOperatorPolicyArn', {
    value: resources.workspaceSearchMigrationOperatorPolicy.managedPolicyArn,
  });
  const rehearsalEvidencePolicyOutput = new cdk.CfnOutput(
    scope,
    'WorkspaceSearchMigrationRehearsalEvidencePolicyArn',
    {
      value:
        resources.workspaceSearchMigrationRehearsalEvidencePolicy
          .managedPolicyArn,
    },
  );
  rehearsalEvidencePolicyOutput.condition =
    resources.workspaceSearchMigrationRehearsalEvidenceCondition;
  new cdk.CfnOutput(scope, 'CrossDomainIntegrityOperatorPolicyArn', {
    value: resources.crossDomainIntegrityOperatorPolicy.managedPolicyArn,
  });
  new cdk.CfnOutput(scope, 'RestoreDrillStateMachineArn', {
    value: resources.workflow.stateMachineArn,
  });
  new cdk.CfnOutput(scope, 'RestoreDrillCleanupStateMachineArn', {
    value: resources.cleanupWorkflow.stateMachineArn,
  });
  new cdk.CfnOutput(scope, 'RestoreDrillEvidenceBucketName', {
    value: resources.evidenceBucket.bucketName,
  });
  new cdk.CfnOutput(scope, 'RestoreDrillScratchBucketName', {
    value: resources.scratchBucket.bucketName,
  });
  new cdk.CfnOutput(scope, 'RestoreDrillStateTableName', {
    value: resources.stateTable.tableName,
  });
  new cdk.CfnOutput(scope, 'RestoreDrillCleanupApprovalPolicyArn', {
    value: resources.cleanupApprovalPolicy.managedPolicyArn,
  });
  new cdk.CfnOutput(scope, 'RestoreDrillScheduleDlqUrl', {
    value: resources.scheduleDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'NotificationsTableName', {
    value: resources.notificationsTable.tableName,
  });
  new cdk.CfnOutput(scope, 'RealtimeSessionsTableName', {
    value: resources.realtimeSessionsTable.tableName,
  });
  new cdk.CfnOutput(scope, 'FileProofingTableName', {
    value: resources.fileProofingTable.tableName,
  });
  new cdk.CfnOutput(scope, 'FileBucketName', {
    value: resources.fileBucket.bucketName,
  });
  new cdk.CfnOutput(scope, 'FileBucketIncarnationMarkerKey', {
    value: resources.fileBucketIncarnationMarker.key,
  });
  new cdk.CfnOutput(scope, 'FileBucketIncarnationMarkerVersionId', {
    value: resources.fileBucketIncarnationMarker.versionId,
  });
  new cdk.CfnOutput(scope, 'FileBucketIncarnationMarkerChecksumSha256', {
    value: resources.fileBucketIncarnationMarker.checksumSha256,
  });
  new cdk.CfnOutput(scope, 'FileBucketIncarnationMarkerSize', {
    value: resources.fileBucketIncarnationMarker.size,
  });
  new cdk.CfnOutput(scope, 'FileMalwareProtectionPlanId', {
    value: resources.malwareProtectionPlan.attrMalwareProtectionPlanId,
  });
  new cdk.CfnOutput(scope, 'RealtimeWebSocketUrl', {
    value: resources.realtimeWebSocketStage.url,
  });
  new cdk.CfnOutput(scope, 'CollaborationProjectionDlqUrl', {
    value: resources.collaborationProjectionDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'EnterpriseIdentityMaintenanceDlqUrl', {
    value: resources.enterpriseIdentityMaintenanceDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'EnterpriseScimGroupJobFunctionName', {
    value: resources.enterpriseScimGroupJobFunction.functionName,
  });
  new cdk.CfnOutput(scope, 'EnterpriseScimGroupJobDlqUrl', {
    value: resources.enterpriseScimGroupJobDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'WebhookDeliveryQueueUrl', {
    value: resources.webhookDeliveryQueue.queueUrl,
  });
  new cdk.CfnOutput(scope, 'WebhookDeliveryDlqUrl', {
    value: resources.webhookDeliveryDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'WorkItemImportBucketName', {
    value: resources.workItemImportBucket.bucketName,
  });
  new cdk.CfnOutput(scope, 'WorkItemImportQueueUrl', {
    value: resources.workItemImportQueue.queueUrl,
  });
  new cdk.CfnOutput(scope, 'WorkItemImportDlqUrl', {
    value: resources.workItemImportDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'ConnectorRuntimeSecretArn', {
    value: resources.connectorRuntimeSecret.secretArn,
  });
  new cdk.CfnOutput(scope, 'ConnectorSyncQueueUrl', {
    value: resources.connectorSyncQueue.queueUrl,
  });
  new cdk.CfnOutput(scope, 'ConnectorSyncDlqUrl', {
    value: resources.connectorSyncDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'ConnectorPollDlqUrl', {
    value: resources.connectorPollDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'AutomationEventDlqUrl', {
    value: resources.automationEventDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'AutomationScheduleDlqUrl', {
    value: resources.automationScheduleDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'AnalyticsScheduleDlqUrl', {
    value: resources.analyticsScheduleDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'NotificationScheduleDlqUrl', {
    value: resources.notificationScheduleDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'RequestEmailIngestionFunctionName', {
    value: resources.requestEmailIngestionFunction.functionName,
  });
  new cdk.CfnOutput(scope, 'RequestEmailIngestionDlqUrl', {
    value: resources.requestEmailIngestionDlq.queueUrl,
  });
  new cdk.CfnOutput(scope, 'ProjectTasksApiUrl', {
    value: resources.functionUrl.url,
    description: 'Backward-compatible alias for the Lambda Function URL.',
  });
  new cdk.CfnOutput(scope, 'ProjectTasksFunctionUrl', {
    value: resources.functionUrl.url,
  });
  new cdk.CfnOutput(scope, 'ProjectTasksApiGatewayUrl', {
    value: resources.httpApi.apiEndpoint,
  });
  new cdk.CfnOutput(scope, 'RuntimeControlApplicationId', {
    value: resources.applicationId,
  });
  new cdk.CfnOutput(scope, 'RuntimeControlEnvironmentId', {
    value: resources.environmentId,
  });
  new cdk.CfnOutput(scope, 'RuntimeControlConfigurationProfileId', {
    value: resources.configurationProfileId,
  });
  new cdk.CfnOutput(scope, 'RuntimeControlCanaryDeploymentStrategyId', {
    value: resources.canaryDeploymentStrategyId,
  });
}
