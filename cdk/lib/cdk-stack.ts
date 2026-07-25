import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { configureAlarmRouting } from './aspects/alarm-routing';
import { buildLambdaBuildPaths } from './config/lambda-build-paths';
import { buildStackParameters } from './config/stack-parameters';
import {
  buildApiRuntime,
  buildApiTransportsAndRealtime,
} from './subsystems/api-realtime';
import { buildBootstrapResources } from './subsystems/bootstrap-resources';
import {
  buildDataStores,
  configureRealtimeSessionIndexes,
} from './subsystems/data-stores';
import {
  buildFileStorage,
  configureFileStorageApiBoundary,
} from './subsystems/file-storage';
import { buildStackOutputs } from './subsystems/outputs';
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
    const fileStorage = buildFileStorage(this, {
      allowedOrigins: parameters.taskApiAllowedOriginList,
      fileProofingTable: dataStores.fileProofingTable,
      retentionDays: parameters.fileRetentionDays,
      downloadUrlTtlSeconds: parameters.fileDownloadUrlTtlSeconds,
      uploadUrlTtlSeconds: parameters.fileUploadUrlTtlSeconds,
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
    configureFileStorageApiBoundary(fileStorage, apiRuntime.apiFunction);

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
      lambdaBuildPaths,
      parameters,
      runtimeControls,
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
      apiRuntime,
      auditProjection,
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
