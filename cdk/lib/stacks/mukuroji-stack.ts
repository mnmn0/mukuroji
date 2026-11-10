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
import {
  buildAutomationWorkers,
  defineAutomationScheduleJob,
} from '../subsystems/workers/automation';
import { buildWorkerChannels } from '../subsystems/workers/channels';
import { buildConnectorWorkers } from '../subsystems/workers/connectors';
import { buildEnterpriseIdentityWorkers } from '../subsystems/workers/enterprise-identity';
import { buildRequestEmailWorker } from '../subsystems/workers/request-email';
import { buildScheduledJobsWorker } from '../subsystems/workers/scheduled-jobs';
import {
  defineAnalyticsScheduleJob,
  defineNotificationScheduleJob,
} from '../subsystems/workers/schedules';
import { defineSlackNotificationJob } from '../subsystems/workers/slack-notifications';
import { buildTenantOperationWorker } from '../subsystems/workers/tenant-operation';
import { defineTriageScheduleJob } from '../subsystems/workers/triage';
import { buildWebhookDeliveryWorkers } from '../subsystems/workers/webhook-delivery';
import { buildWorkItemImportWorker } from '../subsystems/workers/work-item-import';
import { buildAuditExportWorker } from '../subsystems/workers/audit-export';
import { defineAgentRunTriageJob } from '../subsystems/workers/agent-run-triage';

/** Stack configuration, including the optional modules the stack deploys. */
export type MukurojiStackProps = cdk.StackProps & Readonly<{
  /**
   * Deploys the scheduled isolated restore drill. It adds Step Functions workflows, a KMS-encrypted
   * scratch bucket, and an Object Lock evidence bucket whose objects cannot be deleted for 400
   * days. Off unless the composition root turns it on.
   */
  readonly restoreDrillEnabled?: boolean;
  /**
   * Deploys the external connector sync and poll workers, their queues, and the connector runtime
   * secret. Without it the audit projection does not dispatch connector sync. Off unless the
   * composition root turns it on.
   */
  readonly connectorsEnabled?: boolean;
  /**
   * Deploys the request email ingestion Lambda that an external mail relay invokes. Off unless the
   * composition root turns it on.
   */
  readonly requestEmailEnabled?: boolean;
  /**
   * Deploys the tenant export and closure resource owners, their queues, and the export bucket.
   * Without them the API refuses export and closure requests, and the tenant operation worker
   * only reconciles audit retention. Off unless the composition root turns it on.
   */
  readonly tenantLifecycleEnabled?: boolean;
}>;

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
    const restoreDrillEnabled = props?.restoreDrillEnabled ?? false;
    const connectorsEnabled = props?.connectorsEnabled ?? false;
    const requestEmailEnabled = props?.requestEmailEnabled ?? false;
    const tenantLifecycleEnabled = props?.tenantLifecycleEnabled ?? false;

    const lambdaBuildPaths = buildLambdaBuildPaths();
    const parameterInputs = buildStackParameters(this, {
      restoreDrillEnabled,
      connectorsEnabled,
      requestEmailEnabled,
    });
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

    const workerChannels = buildWorkerChannels(this, connectorsEnabled);
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
    if (connectorsEnabled) {
      buildConnectorWorkers(this, {
        dataStores,
        lambdaBuildPaths,
        parameters,
        runtimeControls,
        workerChannels,
      });
    }
    const requestEmailWorker = requestEmailEnabled
      ? buildRequestEmailWorker(this, {
        dataStores,
        lambdaBuildPaths,
        parameters,
        runtimeControls,
      })
      : undefined;
    // The order matches server/src/handlers/scheduled-jobs-handler.ts.
    const scheduledJobs = buildScheduledJobsWorker(this, {
      lambdaBuildPaths,
      runtimeControls,
      jobs: [
        defineAutomationScheduleJob(this, { dataStores, fileStorage, parameters }),
        defineTriageScheduleJob({ dataStores, parameters }),
        defineAgentRunTriageJob({ dataStores, parameters }),
        defineSlackNotificationJob(this, { dataStores, parameters }),
        defineAnalyticsScheduleJob({ dataStores, parameters }),
        defineNotificationScheduleJob({ dataStores, parameters }),
      ],
    });
    const tenantOperationWorker = buildTenantOperationWorker(this, {
      dataStores,
      fileStorage,
      lambdaBuildPaths,
      parameters,
      runtimeControls,
      workspaceAuditPseudonymSecret:
        apiTransports.workspaceAuditPseudonymSecret,
      lifecycleEnabled: tenantLifecycleEnabled,
    });
    const { tenantLifecycle } = tenantOperationWorker;
    // The API refuses export and closure requests unless their resource owners exist.
    apiRuntime.apiFunction.addEnvironment(
      'TENANT_LIFECYCLE_OPERATIONS',
      tenantLifecycle ? 'enabled' : 'disabled',
    );
    if (tenantLifecycle) {
      apiRuntime.apiFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [tenantLifecycle.tenantExportBucket.bucketArn],
        conditions: {
          StringLike: {
            's3:prefix': ['tenant-exports/*'],
          },
        },
      }));
      apiRuntime.apiFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [
          tenantLifecycle.tenantExportBucket.arnForObjects('tenant-exports/*'),
        ],
      }));
      apiRuntime.apiFunction.addEnvironment(
        'TENANT_EXPORT_BUCKET_NAME',
        tenantLifecycle.tenantExportBucket.bucketName,
      );
    }

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
      ...scheduledJobs,
      ...tenantOperationWorker,
      ...runtimeControls,
      workspaceDirectoryId: parameters.workspaceDirectoryId,
    });
  }
}
