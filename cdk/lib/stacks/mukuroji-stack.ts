import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { configureAlarmRouting } from '../aspects/alarm-routing';
import { buildLambdaBuildPaths } from '../config/lambda-build-paths';
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

/** Context key that turns on the optional restore drill. */
export const RESTORE_DRILL_CONTEXT_KEY = 'mukuroji:restoreDrill';

/** Stack configuration, including the optional modules the stack deploys. */
export type MukurojiStackProps = cdk.StackProps & Readonly<{
  /**
   * Deploys the scheduled isolated restore drill. It adds Step Functions workflows, a KMS-encrypted
   * scratch bucket, and an Object Lock evidence bucket whose objects cannot be deleted for 400
   * days. Defaults to the `mukuroji:restoreDrill` context value, which is off.
   */
  readonly restoreDrillEnabled?: boolean;
}>;

/**
 * Reads a boolean CDK context value given in `cdk.json` or as `-c key=true`.
 *
 * @param scope Construct whose context is read.
 * @param key Context key.
 * @returns Whether the value is `true` or the string `"true"`.
 */
function readBooleanContext(scope: Construct, key: string): boolean {
  const value: unknown = scope.node.tryGetContext(key);
  return value === true || value === 'true';
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
   * @param props Optional CDK stack configuration and optional modules.
   */
  constructor(scope: Construct, id: string, props?: MukurojiStackProps) {
    super(scope, id, props);
    const restoreDrillEnabled =
      props?.restoreDrillEnabled ?? readBooleanContext(this, RESTORE_DRILL_CONTEXT_KEY);

    const lambdaBuildPaths = buildLambdaBuildPaths();
    const parameterInputs = buildStackParameters(this, { restoreDrillEnabled });
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
    const restoreDrill = parameters.restoreDrillCleanupApproverRoleArn
      ? buildRestoreDrill(this, {
        dataStores,
        fileStorage,
        lambdaBuildPaths,
        cleanupApproverRoleArn: parameters.restoreDrillCleanupApproverRoleArn,
      })
      : undefined;

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
    buildConnectorWorkers(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workerChannels,
    });
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
    const requestEmailWorker = buildRequestEmailWorker(this, {
      dataStores,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
    });
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
    buildStackOutputs(this, {
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
      ...requestEmailWorker,
      ...triageScheduleWorker,
      ...tenantOperationWorker,
      ...runtimeControls,
      workspaceDirectoryId: parameters.workspaceDirectoryId,
    });
  }
}
