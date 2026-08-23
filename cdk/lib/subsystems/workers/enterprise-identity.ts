import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { StackParameters } from '../../config/stack-parameters';
import {
  grantPlanningRevisionFenceAccess,
} from '../../policies/planning-revision-fence';
import type { DataStoreResources } from '../data-stores';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';

/**
 * Inputs required by enterprise identity background workers.
 */
export interface EnterpriseIdentityWorkerInput {
  /** Shared data stores used by SCIM and maintenance processing. */
  readonly dataStores: DataStoreResources;
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters and derived identity configuration. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
}

/**
 * Enterprise identity worker resources exposed to outputs and dependent builders.
 */
export type EnterpriseIdentityWorkerResources = {
  /** Dead-letter queue for enterprise identity maintenance failures. */
  readonly enterpriseIdentityMaintenanceDlq: sqs.Queue;
  /** Dead-letter queue for asynchronous SCIM group reconciliation failures. */
  readonly enterpriseScimGroupJobDlq: sqs.Queue;
  /** Lambda that performs asynchronous SCIM group reconciliation. */
  readonly enterpriseScimGroupJobFunction: lambdaNodejs.NodejsFunction;
};

/**
 * Builds bounded enterprise identity stream workers and their alarms.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Shared parameters, tables, and Lambda build paths.
 * @returns Enterprise identity worker resources used by stack outputs.
 */
export function buildEnterpriseIdentityWorkers(
  scope: cdk.Stack,
  input: EnterpriseIdentityWorkerInput,
): EnterpriseIdentityWorkerResources {
  const {
    auditEventsTable,
    documentsTable,
    enterpriseIdentityTable,
    planningTable,
    projectDirectoryTable,
    tenantAdministrationTable,
    workspaceAccessTable,
  } = input.dataStores;
  const {
    auditRetentionDays,
    cognitoUserPoolArn,
    cognitoUserPoolId,
    enterpriseIdentityTokenHashSecret,
    workspaceAuditPseudonymKey,
  } = input.parameters;
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } = input.lambdaBuildPaths;

  const enterpriseScimGroupJobDlq = new sqs.Queue(
    scope,
    'EnterpriseScimGroupJobDlq',
    {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
    },
  );
  const enterpriseScimGroupJobFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'EnterpriseScimGroupJobFunction',
    {
      entry: path.join(
        serverHandlersDirectory,
        'enterprise-scim-group-job-worker-handler.ts',
      ),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      reservedConcurrentExecutions: 5,
      description:
        'Dedicated bounded worker for asynchronous enterprise SCIM group reconciliation.',
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        DOCUMENTS_TABLE_NAME: documentsTable.tableName,
        ENTERPRISE_IDENTITY_TABLE_NAME: enterpriseIdentityTable.tableName,
        ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET:
          enterpriseIdentityTokenHashSecret.valueAsString,
        MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY:
          workspaceAuditPseudonymKey.valueAsString,
        PLANNING_TABLE_NAME: planningTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        TENANT_ADMINISTRATION_TABLE_NAME:
          tenantAdministrationTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
      },
    },
  );
  bindRuntimeControls(
    input.runtimeControls,
    enterpriseScimGroupJobFunction,
    'enterprise-scim-group-job',
  );
  enterpriseScimGroupJobFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:BatchWriteItem',
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
    ],
    resources: [enterpriseIdentityTable.tableArn],
  }));
  enterpriseScimGroupJobFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
    resources: [planningTable.tableArn],
  }));
  grantPlanningRevisionFenceAccess(planningTable, enterpriseScimGroupJobFunction);
  enterpriseScimGroupJobFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ],
    resources: [workspaceAccessTable.tableArn],
  }));
  enterpriseScimGroupJobFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
    resources: [documentsTable.tableArn],
  }));
  enterpriseScimGroupJobFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [projectDirectoryTable.tableArn],
  }));
  enterpriseScimGroupJobFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:PutItem'],
    resources: [auditEventsTable.tableArn],
  }));
  enterpriseScimGroupJobFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query'],
    resources: [tenantAdministrationTable.tableArn],
  }));
  enterpriseScimGroupJobFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:ConditionCheckItem', 'dynamodb:PutItem'],
    resources: [tenantAdministrationTable.tableArn],
    conditions: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
  }));
  enterpriseScimGroupJobFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminUserGlobalSignOut',
    ],
    resources: [cognitoUserPoolArn],
  }));
  enterpriseScimGroupJobFunction.addEventSource(
    new lambdaEventSources.DynamoEventSource(enterpriseIdentityTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 1,
      bisectBatchOnError: true,
      parallelizationFactor: 1,
      retryAttempts: 10,
      reportBatchItemFailures: true,
      filters: [lambda.FilterCriteria.filter({
        eventName: lambda.FilterRule.or('INSERT', 'MODIFY'),
        dynamodb: {
          NewImage: {
            entryType: {
              S: lambda.FilterRule.isEqual('enterprise-scim-group-job'),
            },
            recordKey: {
              S: lambda.FilterRule.beginsWith('SCIM_GROUP_JOB#'),
            },
          },
        },
      })],
      onFailure: new lambdaEventSources.SqsDlq(enterpriseScimGroupJobDlq),
    }),
  );
  enterpriseIdentityTable.grantStreamRead(enterpriseScimGroupJobFunction);
  new cloudwatch.Alarm(scope, 'EnterpriseScimGroupJobDlqAlarm', {
    alarmDescription:
      'Detects failed asynchronous enterprise SCIM group reconciliation jobs.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: enterpriseScimGroupJobDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  const enterpriseIdentityMaintenanceDlq = new sqs.Queue(
    scope,
    'EnterpriseIdentityMaintenanceDlq',
    {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
    },
  );
  const enterpriseIdentityMaintenanceFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'EnterpriseIdentityMaintenanceFunction',
    {
      entry: path.join(
        serverHandlersDirectory,
        'enterprise-identity-maintenance-handler.ts',
      ),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      description:
        'Compacts enterprise identity generations and applies grace-period TTL retirement.',
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        ENTERPRISE_IDENTITY_TABLE_NAME: enterpriseIdentityTable.tableName,
      },
    },
  );
  bindRuntimeControls(
    input.runtimeControls,
    enterpriseIdentityMaintenanceFunction,
    'enterprise-identity-maintenance',
  );
  enterpriseIdentityMaintenanceFunction.addEventSource(
    new lambdaEventSources.DynamoEventSource(enterpriseIdentityTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 1,
      bisectBatchOnError: true,
      retryAttempts: 10,
      reportBatchItemFailures: true,
      filters: [lambda.FilterCriteria.filter({
        eventName: lambda.FilterRule.or('INSERT', 'MODIFY'),
        dynamodb: {
          NewImage: {
            entryType: {
              S: lambda.FilterRule.isEqual('enterprise-identity-control'),
            },
            maintenanceRequired: {
              BOOL: lambda.FilterRule.isEqual(true),
            },
            recordKey: { S: lambda.FilterRule.isEqual('CONTROL') },
          },
        },
      })],
      onFailure: new lambdaEventSources.SqsDlq(enterpriseIdentityMaintenanceDlq),
    }),
  );
  enterpriseIdentityTable.grantStreamRead(enterpriseIdentityMaintenanceFunction);
  enterpriseIdentityMaintenanceFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:BatchWriteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ],
    resources: [enterpriseIdentityTable.tableArn],
  }));
  new cloudwatch.Alarm(scope, 'EnterpriseIdentityMaintenanceDlqAlarm', {
    alarmDescription:
      'Detects enterprise identity compaction or generation retirement failures.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: enterpriseIdentityMaintenanceDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  return {
    enterpriseIdentityMaintenanceDlq,
    enterpriseScimGroupJobDlq,
    enterpriseScimGroupJobFunction,
  };
}
