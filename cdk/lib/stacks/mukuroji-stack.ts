import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { configureAlarmRouting } from '../aspects/alarm-routing';
import { buildLambdaBuildPaths } from '../config/lambda-build-paths';
import {
  NO_OPTIONAL_MODULES,
  type OptionalModules,
} from '../config/optional-modules';
import { buildStackParameters, type StackParameters } from '../config/stack-parameters';
import {
  buildApiRuntime,
  buildApiTransportsAndRealtime,
} from '../subsystems/api-realtime';
import { buildBootstrapResources } from '../subsystems/bootstrap-resources';
import { buildCrossDomainIntegrityAccess } from '../subsystems/cross-domain-integrity';
import { buildDataStores } from '../subsystems/data-stores';
import {
  buildFileStorage,
  configureFileStorageApiBoundary,
} from '../subsystems/file-storage';
import { buildStackOutputs } from '../subsystems/outputs';
import { buildRestoreDrill } from '../subsystems/restore-drill';
import { buildRuntimeControls } from '../subsystems/runtime-controls';
import { buildUserIdentity } from '../subsystems/user-identity';
import { buildWebDistribution } from '../subsystems/web-distribution';
import {
  buildAiAssistanceObservabilityWorker,
} from '../subsystems/workers/ai-assistance-observability';
import { buildAuditProjectionWorker } from '../subsystems/workers/audit-projection';
import { buildAutomationWorkers } from '../subsystems/workers/automation';
import { buildWorkerChannels } from '../subsystems/workers/channels';
import { buildConnectorWorkers } from '../subsystems/workers/connectors';
import { buildEnterpriseIdentityWorkers } from '../subsystems/workers/enterprise-identity';
import { buildRequestEmailWorker } from '../subsystems/workers/request-email';
import { buildScheduleWorkers } from '../subsystems/workers/schedules';
import { buildSlackNotificationWorker } from '../subsystems/workers/slack-notifications';
import { buildTenantOperationWorker } from '../subsystems/workers/tenant-operation';
import { buildTriageScheduleWorker } from '../subsystems/workers/triage';
import { buildWebhookDeliveryWorkers } from '../subsystems/workers/webhook-delivery';
import { buildWorkItemImportWorker } from '../subsystems/workers/work-item-import';
import { buildAuditExportWorker } from '../subsystems/workers/audit-export';
import { buildAgentRunTriageWorker } from '../subsystems/workers/agent-run-triage';

/**
 * Configuration of the Mukuroji application stack.
 */
export interface MukurojiStackProps extends cdk.StackProps {
  /** Optional modules to create. Every optional module is omitted by default. */
  readonly optionalModules?: OptionalModules;
}

/**
 * Composes the Mukuroji application infrastructure from subsystem builders.
 */
export class MukurojiStack extends cdk.Stack {
  /**
   * Creates the application stack without introducing additional construct scopes.
   *
   * @param scope Parent construct that owns the stack.
   * @param id Stable stack construct identifier.
   * @param props Optional CDK stack configuration and optional-module selection.
   */
  constructor(scope: Construct, id: string, props?: MukurojiStackProps) {
    super(scope, id, props);

    const optionalModules = props?.optionalModules ?? NO_OPTIONAL_MODULES;

    const lambdaBuildPaths = buildLambdaBuildPaths();
    const parameterInputs = buildStackParameters(this, optionalModules);
    const userIdentity = buildUserIdentity(this, {
      userPoolIdParameter: parameterInputs.cognitoUserPoolIdParameter,
      userPoolClientIdParameter: parameterInputs.cognitoUserPoolClientIdParameter,
    });
    const parameters: StackParameters = {
      ...parameterInputs,
      cognitoUserPoolId: userIdentity.userPoolId,
      cognitoUserPoolClientId: userIdentity.userPoolClientId,
      cognitoUserPoolArn: userIdentity.userPoolArn,
      userIdentity,
    };
    const runtimeControls = buildRuntimeControls(this, { lambdaBuildPaths });
    const dataStores = buildDataStores(this, {
      connectorRuntimeConfiguration: parameters.connectorRuntimeConfiguration,
      workspaceAuditPseudonymKey: parameters.workspaceAuditPseudonymKey,
    });
    const fileStorage = buildFileStorage(this, {
      allowedOrigins: parameters.apiAllowedOriginList,
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
    const { restoreDrillCleanupApproverRoleArn } = parameters;
    const restoreDrill = restoreDrillCleanupApproverRoleArn
      ? buildRestoreDrill(this, {
        dataStores,
        fileStorage,
        lambdaBuildPaths,
        cleanupApproverRoleArn: restoreDrillCleanupApproverRoleArn,
      })
      : undefined;

    const workerChannels = buildWorkerChannels(this, optionalModules.connectors);
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
      restoreDrill?.runnerRole,
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
    buildAuditExportWorker(this, {
      dataStores,
      fileStorage,
      lambdaBuildPaths,
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
    const webDistribution = buildWebDistribution(this, {
      edgeOriginSecret: parameters.edgeOriginSecret.valueAsString,
      fileBucket: fileStorage.fileBucket,
      httpApi: apiTransports.httpApi,
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
    const aiAssistanceObservabilityWorker = buildAiAssistanceObservabilityWorker(
      this,
      {
        aiAssistanceConfigured: parameters.aiAssistanceConfigured,
        applicationCommitSha: parameters.applicationCommitSha.valueAsString,
        dataStores,
        lambdaBuildPaths,
      },
    );
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
    if (optionalModules.connectors) {
      buildConnectorWorkers(this, {
        dataStores,
        lambdaBuildPaths,
        parameters,
        runtimeControls,
        workerChannels,
      });
    }
    buildSlackNotificationWorker(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
    });
    const scheduleWorkers = buildScheduleWorkers(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
    });
    const requestEmailWorker = optionalModules.requestEmail
      ? buildRequestEmailWorker(this, {
        dataStores,
        lambdaBuildPaths,
        parameters,
        runtimeControls,
      })
      : undefined;
    const triageScheduleWorker = buildTriageScheduleWorker(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
    });
    buildAgentRunTriageWorker(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
    });
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
    const { connectorChannels } = workerChannels;
    const { connectorRuntimeSecret } = dataStores;
    buildStackOutputs(this, {
      restoreDrill,
      connectors: connectorChannels && connectorRuntimeSecret
        ? { ...connectorChannels, connectorRuntimeSecret }
        : undefined,
      requestEmail: requestEmailWorker,
      ...dataStores,
      ...fileStorage,
      ...crossDomainIntegrity,
      ...workerChannels,
      ...apiTransports,
      ...webDistribution,
      ...enterpriseIdentityWorkers,
      ...auditProjection,
      ...aiAssistanceObservabilityWorker,
      ...automationWorkers,
      ...scheduleWorkers,
      ...triageScheduleWorker,
      ...tenantOperationWorker,
      ...runtimeControls,
      workspaceDirectoryId: parameters.workspaceDirectoryId,
    });
  }
}
