import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { configureAlarmRouting } from './aspects/alarm-routing';
import { buildLambdaBuildPaths } from './config/lambda-build-paths';
import { buildStackParameters } from './config/stack-parameters';
import type { WorkspaceSearchWriterFenceResources } from './policies/workspace-search-writer-fence';
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
import { buildMigrationStorage } from './subsystems/migration-storage';
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
import { buildWebhookDeliveryWorkers } from './subsystems/workers/webhook-delivery';
import { buildWorkItemImportWorker } from './subsystems/workers/work-item-import';

/**
 * Composes the production infrastructure from logical-ID-preserving subsystem builders.
 */
export class CdkStack extends cdk.Stack {
  /**
   * Creates the application stack without introducing additional construct scopes.
   *
   * @param scope Parent construct that owns the stack.
   * @param id Stable stack construct identifier.
   * @param props Optional CDK stack configuration.
   */
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const lambdaBuildPaths = buildLambdaBuildPaths();
    const parameters = buildStackParameters(this);
    const runtimeControls = buildRuntimeControls(this, { lambdaBuildPaths });
    const dataStores = buildDataStores(this, {
      connectorRuntimeConfiguration: parameters.connectorRuntimeConfiguration,
    });
    const migrationStorage = buildMigrationStorage(this, {
      collaborationTable: dataStores.collaborationTable,
      documentsTable: dataStores.documentsTable,
      projectDirectoryTable: dataStores.projectDirectoryTable,
      workItemsTable: dataStores.workItemsTable,
      workspaceSearchTable: dataStores.workspaceSearchTable,
    });
    const workspaceSearchWriterFence:
      WorkspaceSearchWriterFenceResources = {
        collaborationTable: dataStores.collaborationTable,
        documentsTable: dataStores.documentsTable,
        migrationStateTable:
          migrationStorage.workspaceSearchMigrationStateTable,
        projectDirectoryTable: dataStores.projectDirectoryTable,
        runtimeMode:
          parameters.workspaceSearchWriterFenceMode.valueAsString,
        workItemsTable: dataStores.workItemsTable,
        workspaceSearchTable: dataStores.workspaceSearchTable,
      };
    const fileStorage = buildFileStorage(this, {
      allowedOrigins: parameters.taskApiAllowedOriginList,
      fileProofingTable: dataStores.fileProofingTable,
      retentionDays: parameters.fileRetentionDays,
      downloadUrlTtlSeconds: parameters.fileDownloadUrlTtlSeconds,
      uploadUrlTtlSeconds: parameters.fileUploadUrlTtlSeconds,
    });
    const crossDomainIntegrity = buildCrossDomainIntegrityAccess(this, {
      auditEventsTable: dataStores.auditEventsTable,
      fileProofingTable: dataStores.fileProofingTable,
      fileBucket: fileStorage.fileBucket,
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
      workspaceSearchWriterFence,
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
      workspaceSearchWriterFence,
    });
    buildWorkItemImportWorker(this, {
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workerChannels,
      workspaceSearchWriterFence,
    });

    const apiTransports = buildApiTransportsAndRealtime(this, {
      apiRuntime,
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workerChannels,
      workspaceSearchWriterFence,
    });
    const auditProjection = buildAuditProjectionWorker(this, {
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      parameters,
      realtimeWebSocketStage: apiTransports.realtimeWebSocketStage,
      runtimeControls,
      workerChannels,
      workspaceSearchWriterFence,
    });
    const automationWorkers = buildAutomationWorkers(this, {
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workspaceSearchWriterFence,
    });
    buildWebhookDeliveryWorkers(this, {
      apiLiveAlias: apiTransports.apiLiveAlias,
      apiRuntime,
      auditProjection,
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workerChannels,
      workspaceSearchWriterFence,
    });
    buildConnectorWorkers(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workerChannels,
      workspaceSearchWriterFence,
    });
    const scheduleWorkers = buildScheduleWorkers(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workspaceSearchWriterFence,
    });
    const requestEmailWorker = buildRequestEmailWorker(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
    });

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
      ...migrationStorage,
      ...restoreDrill,
      ...workerChannels,
      ...apiTransports,
      ...enterpriseIdentityWorkers,
      ...auditProjection,
      ...automationWorkers,
      ...scheduleWorkers,
      ...requestEmailWorker,
      ...runtimeControls,
      workspaceDirectoryId: parameters.workspaceDirectoryId,
    });
  }
}
