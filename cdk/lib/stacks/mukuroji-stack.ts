import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { configureAlarmRouting } from '../aspects/alarm-routing';
import { configureCostAllocationTags } from '../aspects/cost-allocation-tags';
import { configureLambdaTracing } from '../aspects/lambda-tracing';
import { configureStatefulResourceGuards } from '../aspects/stateful-resource-guards';
import { buildLambdaBuildPaths } from '../config/lambda-build-paths';
import { buildStackParameters, type StackParameters } from '../config/stack-parameters';
import {
  buildApiRuntime,
  buildApiTransportsAndRealtime,
} from '../subsystems/api-realtime';
import { buildBootstrapResources } from '../subsystems/bootstrap-resources';
import { buildCostBudget } from '../subsystems/cost-budget';
import { buildCrossDomainIntegrityAccess } from '../subsystems/cross-domain-integrity';
import { buildDataMigration } from '../subsystems/data-migration';
import { buildDataStores } from '../subsystems/data-stores';
import {
  buildFileStorage,
  configureFileStorageApiBoundary,
} from '../subsystems/file-storage';
import { buildStackOutputs } from '../subsystems/outputs';
import { buildRestoreDrill } from '../subsystems/restore-drill';
import { buildRuntimeControls } from '../subsystems/runtime-controls';
import { buildUserIdentity } from '../subsystems/user-identity';
import {
  buildWebDistribution,
  resolveWebCustomDomain,
  type WebCustomDomainSettings,
} from '../subsystems/web-distribution';
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
  defineCycleScheduleJob,
  defineInboxDigestJob,
  defineMemberAccessExpiryJob,
  defineJapanesePublicHolidaySyncJob,
  defineNotificationScheduleJob,
} from '../subsystems/workers/schedules';
import { defineSlackNotificationJob } from '../subsystems/workers/slack-notifications';
import { defineEmailNotificationJob } from '../subsystems/workers/email-notifications';
import { defineEmailFeedback } from '../subsystems/workers/email-feedback';
import { definePushNotificationJob } from '../subsystems/workers/push-notifications';
import { buildTenantOperationWorker } from '../subsystems/workers/tenant-operation';
import { defineTriageScheduleJob } from '../subsystems/workers/triage';
import { buildWebhookDeliveryWorkers } from '../subsystems/workers/webhook-delivery';
import { buildWorkItemImportWorker } from '../subsystems/workers/work-item-import';
import { buildSlackIngestWorker } from '../subsystems/workers/slack-ingest';
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
  /**
   * Serves Software factory: Agent Runs, the Factory board, Team agent settings, personal agent
   * credentials for MCP, and the Agent Run triage job. Without it the API refuses those routes
   * with `503 SoftwareFactoryNotDeployed` and the scheduled-jobs Lambda skips the triage job.
   * Off unless the composition root turns it on.
   */
  readonly softwareFactoryEnabled?: boolean;
  /**
   * Seeds demo members (`@example.com`), two Teams, four Projects, and ten Work Items when the
   * stack is created, and makes the initial owner a manager of the demo Projects. For trial and
   * development environments; a company Workspace starts with only its owner. Off unless the
   * composition root turns it on.
   */
  readonly demoDataEnabled?: boolean;
  /**
   * Optional custom domain that serves the Web app and `/api`, from the `mukuroji:web*` context
   * keys in `cdk.json`. Unset keeps the CloudFront domain. The domain becomes the canonical app
   * URL used in Cognito and notification Email links.
   */
  readonly webCustomDomain?: WebCustomDomainSettings;
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
    const softwareFactoryEnabled = props?.softwareFactoryEnabled ?? false;
    const demoDataEnabled = props?.demoDataEnabled ?? false;
    const webCustomDomain = resolveWebCustomDomain(props?.webCustomDomain);

    const lambdaBuildPaths = buildLambdaBuildPaths();
    const parameterInputs = buildStackParameters(this, {
      restoreDrillEnabled,
      connectorsEnabled,
      requestEmailEnabled,
    });
    // The user pool's email links to the app URL, which exists only once the Web distribution,
    // built from resources that need the pool, is built below.
    let webOrigin: string | undefined;
    let webBrowserOrigins: string | undefined;
    const userIdentity = buildUserIdentity(this, {
      userPoolIdParameter: parameterInputs.cognitoUserPoolIdParameter,
      userPoolClientIdParameter: parameterInputs.cognitoUserPoolClientIdParameter,
      webOrigin: cdk.Lazy.string({
        produce: () => {
          if (webOrigin === undefined) {
            throw new Error('The Web distribution must be built before the stack synthesizes.');
          }
          return webOrigin;
        },
      }),
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
      enterpriseIdentityTokenHashSecret:
        parameters.enterpriseIdentityTokenHashSecret,
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
    buildDataMigration(this, {
      lambdaBuildPaths,
      targets: [
        { logicalName: 'work-items', table: dataStores.workItemsTable },
        { logicalName: 'project-directory', table: dataStores.projectDirectoryTable },
        { logicalName: 'documents', table: dataStores.documentsTable },
      ],
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
    buildSlackIngestWorker(this, {
      dataStores,
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
      // The API reads the app origins from the distribution, which is built from the API below.
      webBrowserOrigins: cdk.Lazy.string({
        produce: () => {
          if (webBrowserOrigins === undefined) {
            throw new Error('The Web distribution must be built before the stack synthesizes.');
          }
          return webBrowserOrigins;
        },
      }),
    });
    const webDistribution = buildWebDistribution(this, {
      customDomain: webCustomDomain,
      ssoRedirectUri: parameters.cognitoSsoRedirectUri.valueAsString,
      edgeOriginSecret: parameters.edgeOriginSecret.valueAsString,
      fileBucket: fileStorage.fileBucket,
      httpApi: apiTransports.httpApi,
      realtimeWebSocketApi: apiTransports.realtimeWebSocketStage.api,
    });
    webOrigin = webDistribution.webOrigin;
    webBrowserOrigins = webDistribution.webBrowserOrigins;
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
        aiAssistanceConfigured: parameters.aiAssistanceAnyProviderConfigured,
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
    const emailFeedback = defineEmailFeedback(this, { dataStores, parameters });
    // The order matches server/src/handlers/scheduled-jobs-handler.ts.
    const scheduledJobs = buildScheduledJobsWorker(this, {
      lambdaBuildPaths,
      runtimeControls,
      jobs: [
        defineAutomationScheduleJob(this, { dataStores, fileStorage, parameters }),
        defineTriageScheduleJob({ dataStores, parameters }),
        ...(softwareFactoryEnabled ? [defineAgentRunTriageJob({ dataStores, parameters })] : []),
        defineSlackNotificationJob(this, { dataStores, parameters, webOrigin: webDistribution.webOrigin }),
        defineEmailNotificationJob(this, {
          dataStores, parameters, webOrigin: webDistribution.webOrigin, configurationSet: emailFeedback.configurationSet,
        }),
        definePushNotificationJob(this, { dataStores, parameters, webOrigin: webDistribution.webOrigin }),
        emailFeedback.job,
        defineAnalyticsScheduleJob({ dataStores, parameters }),
        defineNotificationScheduleJob({ dataStores, parameters }),
        defineCycleScheduleJob({ dataStores, parameters }),
        defineMemberAccessExpiryJob({ dataStores, parameters }),
        defineInboxDigestJob({ dataStores, parameters }),
        defineJapanesePublicHolidaySyncJob({ dataStores, parameters }),
      ],
    });
    // The API and the scheduled-jobs Lambda read this to refuse Software factory routes and to
    // skip the Agent Run triage job.
    const softwareFactorySwitch = softwareFactoryEnabled ? 'enabled' : 'disabled';
    apiRuntime.apiFunction.addEnvironment('SOFTWARE_FACTORY', softwareFactorySwitch);
    scheduledJobs.scheduledJobsFunction.addEnvironment('SOFTWARE_FACTORY', softwareFactorySwitch);
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
    configureStatefulResourceGuards(this);
    configureCostAllocationTags(this);
    configureLambdaTracing(this, {
      tracingMode: parameters.lambdaTracingMode,
      tracingActive: parameters.lambdaTracingActive,
    });
    buildCostBudget(this, {
      monthlyBudgetUsd: parameters.monthlyCostBudgetUsd,
      alertEmail: parameters.costBudgetAlertEmail,
      fallbackEmail: parameters.initialOwnerEmail,
    });
    buildBootstrapResources(this, {
      dataStores,
      parameters,
      demoDataEnabled,
      lambdaBuildPaths,
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
