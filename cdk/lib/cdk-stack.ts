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
  DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID,
  bindWorkspaceSearchMigrationStackEnvironment,
  resolveWorkspaceSearchMigrationDeploymentTarget,
} from './config/workspace-search-migration-deployment-targets';
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
import { buildMigrationAlarmEvidenceSink } from './subsystems/migration-alarm-evidence';
import { buildMigrationObservability } from './subsystems/migration-observability';
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
import { buildTenantOperationWorker } from './subsystems/workers/tenant-operation';
import { buildTriageScheduleWorker } from './subsystems/workers/triage';
import { buildWebhookDeliveryWorkers } from './subsystems/workers/webhook-delivery';
import { buildWorkItemImportWorker } from './subsystems/workers/work-item-import';

/** Stack configuration plus reviewed migration and stateful-index rollout selections. */
export interface CdkStackProps extends cdk.StackProps {
  /** Reviewed one-index-at-a-time rollout stage for Triage GSIs. */
  readonly triageIndexDeploymentStage?: TriageIndexDeploymentStage;
  /** Reviewed one-index-at-a-time rollout stage for Team Issue event GSIs. */
  readonly teamIssueCommentIndexDeploymentStage?: TeamIssueCommentIndexDeploymentStage;
  /** Source-controlled target identifier; free-form target definitions are never accepted. */
  readonly workspaceSearchMigrationDeploymentTargetId?: string;
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
   * @param props Optional CDK stack and reviewed migration-target configuration.
   */
  constructor(scope: Construct, id: string, props?: CdkStackProps) {
    const {
      triageIndexDeploymentStage: configuredTriageIndexDeploymentStage,
      teamIssueCommentIndexDeploymentStage: configuredTeamIssueCommentIndexDeploymentStage,
      workspaceSearchMigrationDeploymentTargetId,
      ...baseStackProps
    } = props ?? {};
    const triageIndexDeploymentStage = resolveTriageIndexDeploymentStage(
      configuredTriageIndexDeploymentStage,
    );
    const teamIssueCommentIndexDeploymentStage = resolveTeamIssueCommentIndexDeploymentStage(
      configuredTeamIssueCommentIndexDeploymentStage,
    );
    const deploymentTarget =
      resolveWorkspaceSearchMigrationDeploymentTarget(
        workspaceSearchMigrationDeploymentTargetId ??
          DEFAULT_WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_ID,
      );
    const deploymentEnvironment =
      bindWorkspaceSearchMigrationStackEnvironment(
        deploymentTarget,
        baseStackProps.env,
      );
    const resolvedStackProps: cdk.StackProps = deploymentTarget.rehearsalEnabled
      ? {
        ...baseStackProps,
        env: deploymentEnvironment,
      }
      : baseStackProps;
    super(scope, id, resolvedStackProps);

    if (deploymentTarget.rehearsalEnabled) {
      new cdk.CfnRule(this, 'WorkspaceSearchMigrationDeploymentTargetIdentity', {
        assertions: [{
          assert: cdk.Fn.conditionAnd(
            cdk.Fn.conditionEquals(
              cdk.Aws.ACCOUNT_ID,
              deploymentTarget.deploymentAccount,
            ),
            cdk.Fn.conditionEquals(
              cdk.Aws.REGION,
              deploymentTarget.region,
            ),
          ),
          assertDescription:
            'AWS::AccountId and AWS::Region must match the reviewed Workspace Search migration deployment target.',
        }],
      });
    }
    new cdk.CfnOutput(this, 'WorkspaceSearchMigrationDeploymentTargetId', {
      value: deploymentTarget.targetId,
    });
    new cdk.CfnOutput(this, 'WorkspaceSearchMigrationDeploymentTrustVersion', {
      value: String(deploymentTarget.version),
    });
    new cdk.CfnOutput(this, 'WorkspaceSearchMigrationDeploymentEnvironment', {
      value: deploymentTarget.environment,
    });
    new cdk.CfnOutput(this, 'WorkspaceSearchMigrationDeploymentAccount', {
      value: deploymentTarget.rehearsalEnabled
        ? deploymentTarget.deploymentAccount
        : cdk.Aws.ACCOUNT_ID,
    });
    new cdk.CfnOutput(this, 'WorkspaceSearchMigrationDeploymentRegion', {
      value: deploymentTarget.rehearsalEnabled
        ? deploymentTarget.region
        : cdk.Aws.REGION,
    });
    new cdk.CfnOutput(
      this,
      'WorkspaceSearchMigrationProductionAccountDigest',
      { value: deploymentTarget.productionAccountDigest },
    );
    new cdk.CfnOutput(this, 'WorkspaceSearchMigrationDeploymentTrustRootDigest', {
      value: deploymentTarget.digest,
    });
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
    const migrationStorage = buildMigrationStorage(this, {
      collaborationTable: dataStores.collaborationTable,
      documentsTable: dataStores.documentsTable,
      deploymentTrustRoot: deploymentTarget,
      projectDirectoryTable: dataStores.projectDirectoryTable,
      workItemsTable: dataStores.workItemsTable,
      workspaceSearchTable: dataStores.workspaceSearchTable,
    });
    const migrationObservability = buildMigrationObservability(this);
    buildMigrationAlarmEvidenceSink(this, {
      alarms: migrationObservability.alarms,
      deploymentTrustRoot: deploymentTarget,
      notificationTopicArns: parameters.alarmNotificationTopicArns,
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
      ...migrationStorage,
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
