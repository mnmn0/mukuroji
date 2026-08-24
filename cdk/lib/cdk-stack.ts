import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { configureAlarmRouting } from './aspects/alarm-routing';
import { buildLambdaBuildPaths } from './config/lambda-build-paths';
import { buildStackParameters } from './config/stack-parameters';
import {
  resolveTeamIssueCommentIndexDeploymentStage,
  type TeamIssueCommentIndexDeploymentStage,
} from './config/team-issue-comment-index-deployment';
import {
  resolveTriageIndexDeploymentStage,
  triageIndexDeploymentIncludes,
  type TriageIndexDeploymentStage,
} from './config/triage-index-deployment';
import {
  buildApiRuntime,
  buildApiTransportsAndRealtime,
} from './subsystems/api-realtime';
import { buildBootstrapResources } from './subsystems/bootstrap-resources';
import { buildCrossDomainIntegrityAccess } from './subsystems/cross-domain-integrity';
import {
  buildDataStores,
  configureRealtimeSessionIndexes,
} from './subsystems/data-stores';
import {
  buildFileStorage,
  configureFileStorageApiBoundary,
} from './subsystems/file-storage';
import { buildStackOutputs } from './subsystems/outputs';
import { buildRestoreDrill } from './subsystems/restore-drill';
import { buildRuntimeControls } from './subsystems/runtime-controls';
import { buildAuditProjectionWorker } from './subsystems/workers/audit-projection';
import { buildAutomationWorkers } from './subsystems/workers/automation';
import { buildWorkerChannels } from './subsystems/workers/channels';
import { buildConnectorWorkers } from './subsystems/workers/connectors';
import { buildEnterpriseIdentityWorkers } from './subsystems/workers/enterprise-identity';
import { buildRequestEmailWorker } from './subsystems/workers/request-email';
import { buildScheduleWorkers } from './subsystems/workers/schedules';
import { buildTenantOperationWorker } from './subsystems/workers/tenant-operation';
import { buildTriageScheduleWorker } from './subsystems/workers/triage';
import { buildWebhookDeliveryWorkers } from './subsystems/workers/webhook-delivery';
import { buildWorkItemImportWorker } from './subsystems/workers/work-item-import';

/** Stack configuration plus reviewed stateful-index rollout selections. */
export interface CdkStackProps extends cdk.StackProps {
  /** Reviewed one-index-at-a-time rollout stage for Triage GSIs. */
  readonly triageIndexDeploymentStage?: TriageIndexDeploymentStage;
  /** Reviewed one-index-at-a-time rollout stage for Team Issue event GSIs. */
  readonly teamIssueCommentIndexDeploymentStage?: TeamIssueCommentIndexDeploymentStage;
}

/**
 * Composes the production infrastructure from logical-ID-preserving subsystem builders.
 */
export class CdkStack extends cdk.Stack {
  /**
   * Creates the application stack without introducing additional construct scopes.
   *
   * @param scope Parent construct that owns the stack.
   * @param id Stable stack construct identifier.
   * @param props Optional CDK stack and reviewed index-rollout configuration.
   */
  constructor(scope: Construct, id: string, props?: CdkStackProps) {
    const {
      triageIndexDeploymentStage: configuredTriageIndexDeploymentStage,
      teamIssueCommentIndexDeploymentStage: configuredTeamIssueCommentIndexDeploymentStage,
      ...baseStackProps
    } = props ?? {};
    const triageIndexDeploymentStage = resolveTriageIndexDeploymentStage(
      configuredTriageIndexDeploymentStage,
    );
    const teamIssueCommentIndexDeploymentStage = resolveTeamIssueCommentIndexDeploymentStage(
      configuredTeamIssueCommentIndexDeploymentStage,
    );
    super(scope, id, baseStackProps);
    new cdk.CfnOutput(this, 'TriageIndexDeploymentStage', {
      value: triageIndexDeploymentStage,
    });
    new cdk.CfnOutput(this, 'TeamIssueCommentIndexDeploymentStage', {
      value: teamIssueCommentIndexDeploymentStage,
    });

    const lambdaBuildPaths = buildLambdaBuildPaths();
    const parameters = buildStackParameters(this);
    const runtimeControls = buildRuntimeControls(this, { lambdaBuildPaths });
    const dataStores = buildDataStores(this, {
      connectorRuntimeConfiguration: parameters.connectorRuntimeConfiguration,
      teamIssueCommentIndexDeploymentStage,
      triageIndexDeploymentStage,
    });
    const fileStorage = buildFileStorage(this, {
      allowedOrigins: parameters.taskApiAllowedOriginList,
      fileProofingTable: dataStores.fileProofingTable,
      lambdaBuildPaths,
      retentionDays: parameters.fileRetentionDays,
      downloadUrlTtlSeconds: parameters.fileDownloadUrlTtlSeconds,
      uploadUrlTtlSeconds: parameters.fileUploadUrlTtlSeconds,
    });
    const crossDomainIntegrity = buildCrossDomainIntegrityAccess(this, {
      auditEventsTable: dataStores.auditEventsTable,
      fileProofingTable: dataStores.fileProofingTable,
      fileBucket: fileStorage.fileBucket,
      fileBucketIncarnationMarkerKey:
        fileStorage.fileBucketIncarnationMarker.key,
      fileBucketIncarnationMarkerVersionId:
        fileStorage.fileBucketIncarnationMarker.versionId,
      projectDirectoryTable: dataStores.projectDirectoryTable,
      workItemsTable: dataStores.workItemsTable,
      workItemConfigurationTable: dataStores.workItemConfigurationTable,
      workspaceAccessTable: dataStores.workspaceAccessTable,
    });
    const restoreDrill = buildRestoreDrill(this, {
      apiRuntimeConfigurationRevision:
        parameters.apiRuntimeConfigurationRevision,
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      cleanupApproverRoleArn:
        parameters.restoreDrillCleanupApproverRoleArn,
      workspaceAuditPseudonymKey: parameters.workspaceAuditPseudonymKey,
    });
    configureRealtimeSessionIndexes(dataStores);

    const workerChannels = buildWorkerChannels(this);
    const apiRuntime = buildApiRuntime(this, {
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workerChannels,
    });
    configureFileStorageApiBoundary(
      fileStorage,
      apiRuntime.apiFunction,
      restoreDrill.runnerRole,
    );

    const enterpriseIdentityWorkers = buildEnterpriseIdentityWorkers(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
    });
    buildWorkItemImportWorker(this, {
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workerChannels,
    });

    const apiTransports = buildApiTransportsAndRealtime(this, {
      apiRuntime,
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workerChannels,
    });
    const auditProjection = buildAuditProjectionWorker(this, {
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      parameters,
      realtimeWebSocketStage: apiTransports.realtimeWebSocketStage,
      runtimeControls,
      workerChannels,
    });
    const automationWorkers = buildAutomationWorkers(this, {
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
    });
    buildWebhookDeliveryWorkers(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workerChannels,
    });
    buildConnectorWorkers(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workerChannels,
    });
    const scheduleWorkers = buildScheduleWorkers(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
    });
    const requestEmailWorker = buildRequestEmailWorker(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
    });
    const triageScheduleWorker = triageIndexDeploymentIncludes(
      triageIndexDeploymentStage,
      'wake',
    )
      ? buildTriageScheduleWorker(this, {
        dataStores,
        lambdaBuildPaths,
        parameters,
        runtimeControls,
      })
      : {};
    const tenantOperationWorker = buildTenantOperationWorker(this, {
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workspaceAuditPseudonymSecret:
        apiTransports.workspaceAuditPseudonymSecret,
    });
    apiRuntime.apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [tenantOperationWorker.tenantExportBucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': ['tenant-exports/*'],
        },
      },
    }));
    apiRuntime.apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        tenantOperationWorker.tenantExportBucket.arnForObjects('tenant-exports/*'),
      ],
    }));
    apiRuntime.apiFunction.addEnvironment(
      'TENANT_EXPORT_BUCKET_NAME',
      tenantOperationWorker.tenantExportBucket.bucketName,
    );

    configureAlarmRouting(this, {
      notificationTopicArns: parameters.alarmNotificationTopicArns,
    });
    buildBootstrapResources(this, {
      dataStores,
      parameters,
    });
    buildStackOutputs(this, {
      ...dataStores,
      ...fileStorage,
      ...crossDomainIntegrity,
      ...restoreDrill,
      ...workerChannels,
      ...apiTransports,
      ...enterpriseIdentityWorkers,
      ...auditProjection,
      ...automationWorkers,
      ...scheduleWorkers,
      ...requestEmailWorker,
      ...triageScheduleWorker,
      ...tenantOperationWorker,
      ...runtimeControls,
      workspaceDirectoryId: parameters.workspaceDirectoryId,
    });
  }
}
