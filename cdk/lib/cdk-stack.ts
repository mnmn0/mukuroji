import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import {
  createWorkspaceAccessTransactItems,
  createWorkspaceDemoMemberTransactItems,
  createCanonicalWorkItemTransactItems,
  createProjectDirectoryTransactItems,
  createWorkspaceBootstrapTransactItems,
  createIdempotentAwsCustomResourceProps,
} from './bootstrap-data';

/**
 * mukuroji の本番 API、永続 data store、workspace bootstrap を定義する stack です。
 */
export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const taskApiAllowedOrigins = new cdk.CfnParameter(this, 'TaskApiAllowedOrigins', {
      type: 'String',
      default: 'http://localhost:5173,http://127.0.0.1:5173',
      allowedPattern: '^https?://[^,\\s]+(,https?://[^,\\s]+)*$',
      constraintDescription:
        'TaskApiAllowedOrigins must be a comma-separated list of HTTP(S) origins without whitespace.',
      description: 'Comma-separated CORS origins allowed to call the mukuroji API.',
    });
    const taskApiAllowedOriginList = cdk.Fn.split(',', taskApiAllowedOrigins.valueAsString);
    const systemAdminGroups = new cdk.CfnParameter(this, 'SystemAdminGroups', {
      type: 'String',
      default: 'mukuroji-system-admins',
      description: 'Comma-separated Cognito group names that grant system administrator privileges.',
    });
    const auditRetentionDays = new cdk.CfnParameter(this, 'AuditRetentionDays', {
      type: 'Number',
      default: 2555,
      minValue: 1,
      description: 'Number of days immutable audit events are retained before DynamoDB TTL expiry.',
    });
    const cognitoUserPoolId = new cdk.CfnParameter(this, 'CognitoUserPoolId', {
      type: 'String',
      allowedPattern: '^[a-z]{2}(?:-[a-z0-9]+)+_[A-Za-z0-9]+$',
      description: 'Existing Cognito user pool ID trusted by the mukuroji API.',
    });
    const cognitoUserPoolClientId = new cdk.CfnParameter(this, 'CognitoUserPoolClientId', {
      type: 'String',
      allowedPattern: '^[A-Za-z0-9]+$',
      description: 'Existing Cognito app client ID used by the mukuroji API.',
    });
    const workspaceDirectoryId = new cdk.CfnParameter(this, 'WorkspaceDirectoryId', {
      type: 'String',
      minLength: 1,
      allowedPattern: '^\\S+$',
      constraintDescription: 'WorkspaceDirectoryId must not contain whitespace.',
      description: 'Canonical workspace directory ID shared by Cognito claims and DynamoDB partitions.',
    });
    const initialOwnerEmail = new cdk.CfnParameter(this, 'InitialOwnerEmail', {
      type: 'String',
      allowedPattern: '^[^A-Z\\s@]+@[^A-Z\\s@]+$',
      constraintDescription: 'InitialOwnerEmail must be a lowercase email address.',
      description: 'Canonical lowercase email address stored for the initial workspace owner.',
    });
    const initialOwnerUsername = new cdk.CfnParameter(this, 'InitialOwnerUsername', {
      type: 'String',
      minLength: 1,
      allowedPattern: '^\\S+$',
      constraintDescription: 'InitialOwnerUsername must not contain whitespace.',
      description: 'Cognito username targeted when bootstrapping the initial owner attributes.',
    });
    const cognitoUserPoolArn = cdk.Stack.of(this).formatArn({
      service: 'cognito-idp',
      resource: 'userpool',
      resourceName: cognitoUserPoolId.valueAsString,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });

    const legacyTasksTable = new dynamodb.Table(this, 'ProjectTasksTable', {
      partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    legacyTasksTable.addGlobalSecondaryIndex({
      indexName: 'ProjectSortOrderIndex',
      partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const workItemsTable = new dynamodb.Table(this, 'TeamIssuesTable', {
      partitionKey: { name: 'directoryTeamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'issueId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    workItemsTable.addGlobalSecondaryIndex({
      indexName: 'TeamIssueSortOrderIndex',
      partitionKey: { name: 'directoryTeamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    workItemsTable.addGlobalSecondaryIndex({
      indexName: 'AssignedProjectIssueIndex',
      partitionKey: { name: 'directoryProjectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const teamIssueEventsTable = new dynamodb.Table(this, 'TeamIssueEventsTable', {
      partitionKey: { name: 'directoryTeamIssueId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const projectDirectoryTable = new dynamodb.Table(this, 'ProjectDirectoryTable', {
      partitionKey: { name: 'directoryId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'entryKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const auditEventsTable = new dynamodb.Table(this, 'AuditEventsTable', {
      partitionKey: { name: 'directoryId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      timeToLiveAttribute: 'expiresAt',
    });

    for (const [id, partitionKey, sortKey] of [
      ['WorkspaceOccurredAtIndex', 'workspaceKey', 'workspaceEventKey'],
      ['EntityOccurredAtIndex', 'entityKey', 'entityEventKey'],
      ['ActorOccurredAtIndex', 'actorKey', 'actorEventKey'],
      ['TargetOccurredAtIndex', 'targetKey', 'targetEventKey'],
    ] as const) {
      auditEventsTable.addGlobalSecondaryIndex({
        indexName: id,
        partitionKey: { name: partitionKey, type: dynamodb.AttributeType.STRING },
        sortKey: { name: sortKey, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }

    const processedAuditEventsTable = new dynamodb.Table(this, 'ProcessedAuditEventsTable', {
      partitionKey: { name: 'consumerName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    const workspaceAccessTable = new dynamodb.Table(this, 'WorkspaceAccessTable', {
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const collaborationTable = new dynamodb.Table(this, 'WorkItemCollaborationTable', {
      partitionKey: { name: 'entityKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    const workspaceSearchTable = new dynamodb.Table(this, 'WorkspaceSearchTable', {
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const notificationsTable = new dynamodb.Table(this, 'NotificationsTable', {
      partitionKey: { name: 'recipientKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'notificationKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    notificationsTable.addGlobalSecondaryIndex({
      indexName: 'RecipientStatusIndex',
      partitionKey: { name: 'recipientStatusKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'notificationKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const realtimeSessionsTable = new dynamodb.Table(this, 'RealtimeSessionsTable', {
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });

    realtimeSessionsTable.addGlobalSecondaryIndex({
      indexName: 'ScopeConnectionsIndex',
      partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const apiFunction = new lambdaNodejs.NodejsFunction(this, 'ListProjectTasksFunction', {
      entry: path.join(__dirname, '../../server/src/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      depsLockFilePath: path.join(__dirname, '../../bun.lock'),
      projectRoot: path.join(__dirname, '../..'),
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      description: 'Bundled shared Hono handler for the mukuroji Function URL and HTTP API.',
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        ALLOWED_ORIGINS: taskApiAllowedOrigins.valueAsString,
        COLLABORATION_TABLE_NAME: collaborationTable.tableName,
        COGNITO_CLIENT_ID: cognitoUserPoolClientId.valueAsString,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
        MUKUROJI_PROJECT_DIRECTORY_ID: workspaceDirectoryId.valueAsString,
        MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
        MUKUROJI_PROJECT_TASKS_TABLE: legacyTasksTable.tableName,
        MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
        MUKUROJI_TEAM_ISSUES_TABLE: workItemsTable.tableName,
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        MUKUROJI_WORKSPACE_DIRECTORY_ID: workspaceDirectoryId.valueAsString,
        NOTIFICATIONS_TABLE_NAME: notificationsTable.tableName,
        NOTIFICATIONS_STATUS_INDEX_NAME: 'RecipientStatusIndex',
        REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TASKS_TABLE_NAME: legacyTasksTable.tableName,
        TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
      },
    });

    legacyTasksTable.grantReadData(apiFunction);
    workItemsTable.grantReadWriteData(apiFunction);
    teamIssueEventsTable.grantReadWriteData(apiFunction);
    projectDirectoryTable.grantReadWriteData(apiFunction);
    auditEventsTable.grantReadWriteData(apiFunction);
    workspaceAccessTable.grantReadWriteData(apiFunction);
    collaborationTable.grantReadWriteData(apiFunction);
    notificationsTable.grantReadWriteData(apiFunction);
    workspaceSearchTable.grantReadWriteData(apiFunction);
    realtimeSessionsTable.grantWriteData(apiFunction);
    const apiTransactWritePolicy = new iam.Policy(this, 'ApiTransactWritePolicy', {
      statements: [new iam.PolicyStatement({
        actions: ['dynamodb:TransactWriteItems'],
        resources: [
          workItemsTable.tableArn,
          teamIssueEventsTable.tableArn,
          projectDirectoryTable.tableArn,
          auditEventsTable.tableArn,
          workspaceAccessTable.tableArn,
          collaborationTable.tableArn,
          workspaceSearchTable.tableArn,
        ],
      })],
    });
    if (!apiFunction.role) {
      throw new Error('API Lambda execution role was not created.');
    }
    apiFunction.role.attachInlinePolicy(apiTransactWritePolicy);
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:GetUser',
          'cognito-idp:ListUsers',
        ],
        resources: [cognitoUserPoolArn],
      }),
    );

    const functionUrl = apiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: taskApiAllowedOriginList,
        allowedMethods: [
          lambda.HttpMethod.GET,
          lambda.HttpMethod.POST,
          lambda.HttpMethod.PUT,
          lambda.HttpMethod.PATCH,
          lambda.HttpMethod.DELETE,
        ],
        allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-correlation-id'],
      },
    });
    const httpApi = new apigatewayv2.HttpApi(this, 'ProjectTasksHttpApi', {
      description: 'HTTP API backed by the same bundled Hono Lambda as the Function URL.',
      defaultIntegration: new apigatewayv2Integrations.HttpLambdaIntegration(
        'SharedHonoHandlerIntegration',
        apiFunction,
        {
          payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
          scopePermissionToRoute: false,
        },
      ),
      corsPreflight: {
        allowOrigins: taskApiAllowedOriginList,
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.PATCH,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-correlation-id'],
      },
    });

    const realtimeFunction = new lambdaNodejs.NodejsFunction(this, 'RealtimeHandlerFunction', {
      entry: path.join(__dirname, '../../server/src/realtime-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      depsLockFilePath: path.join(__dirname, '../../bun.lock'),
      projectRoot: path.join(__dirname, '../..'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      description: 'Consumes one-time tickets and handles mukuroji WebSocket presence events.',
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
        REALTIME_SESSION_TTL_SECONDS: '3600',
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
      },
    });
    const realtimeIntegration = new apigatewayv2Integrations.WebSocketLambdaIntegration(
      'RealtimeLambdaIntegration',
      realtimeFunction,
    );
    const realtimeWebSocketApi = new apigatewayv2.WebSocketApi(this, 'RealtimeWebSocketApi', {
      connectRouteOptions: { integration: realtimeIntegration },
      disconnectRouteOptions: { integration: realtimeIntegration },
      defaultRouteOptions: { integration: realtimeIntegration },
    });
    const realtimeWebSocketStage = new apigatewayv2.WebSocketStage(
      this,
      'RealtimeWebSocketStage',
      {
        webSocketApi: realtimeWebSocketApi,
        stageName: 'production',
        autoDeploy: true,
      },
    );

    realtimeSessionsTable.grantReadWriteData(realtimeFunction);
    projectDirectoryTable.grantReadData(realtimeFunction);
    workItemsTable.grantReadData(realtimeFunction);
    workspaceAccessTable.grantReadData(realtimeFunction);
    realtimeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:TransactWriteItems'],
        resources: [realtimeSessionsTable.tableArn],
      }),
    );
    realtimeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminListGroupsForUser'],
        resources: [cognitoUserPoolArn],
      }),
    );
    realtimeWebSocketStage.grantManagementApiAccess(realtimeFunction);

    apiFunction.addEnvironment('REALTIME_WEBSOCKET_URL', realtimeWebSocketStage.url);

    const collaborationProjectionDlq = new sqs.Queue(this, 'CollaborationProjectionDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    const collaborationProjectionFunction = new lambdaNodejs.NodejsFunction(
      this,
      'CollaborationProjectionFunction',
      {
        entry: path.join(__dirname, '../../server/src/collaboration-projection-handler.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        description: 'Projects audit outbox events into notifications and realtime invalidations.',
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          COLLABORATION_TABLE_NAME: collaborationTable.tableName,
          COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
          NOTIFICATIONS_TABLE_NAME: notificationsTable.tableName,
          NOTIFICATION_RETENTION_SECONDS: String(365 * 24 * 60 * 60),
          PROCESSED_AUDIT_EVENTS_TABLE_NAME: processedAuditEventsTable.tableName,
          PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
          REALTIME_SESSIONS_TABLE_NAME: realtimeSessionsTable.tableName,
          SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
          MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
          TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
          WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
          WEBSOCKET_CALLBACK_ENDPOINT: realtimeWebSocketStage.callbackUrl,
          WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        },
      },
    );

    collaborationProjectionFunction.addEventSource(
      new lambdaEventSources.DynamoEventSource(auditEventsTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 3,
        reportBatchItemFailures: true,
        onFailure: new lambdaEventSources.SqsDlq(collaborationProjectionDlq),
      }),
    );
    auditEventsTable.grantStreamRead(collaborationProjectionFunction);
    collaborationTable.grantReadData(collaborationProjectionFunction);
    notificationsTable.grantReadWriteData(collaborationProjectionFunction);
    processedAuditEventsTable.grantReadWriteData(collaborationProjectionFunction);
    projectDirectoryTable.grantReadData(collaborationProjectionFunction);
    realtimeSessionsTable.grantReadWriteData(collaborationProjectionFunction);
    workItemsTable.grantReadData(collaborationProjectionFunction);
    workspaceAccessTable.grantReadData(collaborationProjectionFunction);
    collaborationProjectionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:TransactWriteItems'],
        resources: [notificationsTable.tableArn, processedAuditEventsTable.tableArn],
      }),
    );
    collaborationProjectionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminListGroupsForUser'],
        resources: [cognitoUserPoolArn],
      }),
    );
    realtimeWebSocketStage.grantManagementApiAccess(collaborationProjectionFunction);

    const notificationScheduleDlq = new sqs.Queue(this, 'NotificationScheduleDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    const notificationScheduleFunction = new lambdaNodejs.NodejsFunction(
      this,
      'NotificationScheduleFunction',
      {
        entry: path.join(__dirname, '../../server/src/notification-schedule-handler.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        depsLockFilePath: path.join(__dirname, '../../bun.lock'),
        projectRoot: path.join(__dirname, '../..'),
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        description: 'Emits deterministic due and overdue Work Item notification events.',
        onFailure: new lambdaDestinations.SqsDestination(notificationScheduleDlq),
        retryAttempts: 2,
        bundling: {
          bundleAwsSDK: true,
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
        environment: {
          AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
          AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
          NOTIFICATION_SCHEDULE_MAX_PAGES: '1000',
          NOTIFICATION_SCHEDULE_SCAN_PAGE_SIZE: '100',
          WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        },
      },
    );
    workItemsTable.grantReadData(notificationScheduleFunction);
    auditEventsTable.grantWriteData(notificationScheduleFunction);

    new cloudwatch.Alarm(this, 'NotificationScheduleDlqAlarm', {
      alarmDescription:
        'Detects notification schedule failures after asynchronous retries, including scan page limit exhaustion.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: notificationScheduleDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new events.Rule(this, 'NotificationScheduleRule', {
      description: 'Checks canonical Work Items for due and overdue notifications.',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new eventsTargets.LambdaFunction(notificationScheduleFunction)],
    });

    const cognitoPolicy = customResources.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:DescribeUserPoolClient',
        ],
        resources: [cognitoUserPoolArn],
      }),
    ]);
    const validateCognitoClientCall: customResources.AwsSdkCall = {
      service: 'CognitoIdentityServiceProvider',
      action: 'describeUserPoolClient',
      parameters: {
        UserPoolId: cognitoUserPoolId.valueAsString,
        ClientId: cognitoUserPoolClientId.valueAsString,
      },
      logging: customResources.Logging.withDataHidden(),
      physicalResourceId: customResources.PhysicalResourceId.of('mukuroji-cognito-client-validation-v1'),
    };
    const validateCognitoClient = new customResources.AwsCustomResource(
      this,
      'ValidateCognitoUserPoolClient',
      createIdempotentAwsCustomResourceProps(validateCognitoClientCall, cognitoPolicy),
    );
    const updateInitialOwnerAttributesCall: customResources.AwsSdkCall = {
      service: 'CognitoIdentityServiceProvider',
      action: 'adminUpdateUserAttributes',
      parameters: {
        UserPoolId: cognitoUserPoolId.valueAsString,
        Username: initialOwnerUsername.valueAsString,
        UserAttributes: [
          {
            Name: 'custom:directory_id',
            Value: workspaceDirectoryId.valueAsString,
          },
          {
            Name: 'custom:workspace_id',
            Value: workspaceDirectoryId.valueAsString,
          },
        ],
      },
      logging: customResources.Logging.withDataHidden(),
      physicalResourceId: customResources.PhysicalResourceId.of('mukuroji-initial-owner-attributes-v1'),
    };
    const updateInitialOwnerAttributes = new customResources.AwsCustomResource(
      this,
      'UpdateInitialOwnerAttributes',
      createIdempotentAwsCustomResourceProps(updateInitialOwnerAttributesCall, cognitoPolicy),
    );

    updateInitialOwnerAttributes.node.addDependency(validateCognitoClient);

    const seedCanonicalWorkItemsCall: customResources.AwsSdkCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createCanonicalWorkItemTransactItems(
          workItemsTable.tableName,
          workspaceDirectoryId.valueAsString,
        ),
      },
      physicalResourceId: customResources.PhysicalResourceId.of('canonical-work-items-seed-v1'),
    };
    const seedCanonicalWorkItems = new customResources.AwsCustomResource(this, 'SeedProjectTasks', {
      onCreate: seedCanonicalWorkItemsCall,
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:TransactWriteItems'],
          resources: [workItemsTable.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem'],
          resources: [workItemsTable.tableArn],
          conditions: {
            'ForAnyValue:StringEquals': {
              'dynamodb:EnclosingOperation': ['TransactWriteItems'],
            },
          },
        }),
      ]),
      installLatestAwsSdk: false,
    });

    seedCanonicalWorkItems.node.addDependency(workItemsTable);

    const seedProjectDirectoryCall: customResources.AwsSdkCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createProjectDirectoryTransactItems(
          projectDirectoryTable.tableName,
          workspaceDirectoryId.valueAsString,
        ),
      },
      physicalResourceId: customResources.PhysicalResourceId.of('project-directory-seed-v3'),
    };
    const seedProjectDirectory = new customResources.AwsCustomResource(this, 'SeedProjectDirectory', {
      onCreate: seedProjectDirectoryCall,
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:TransactWriteItems'],
          resources: [projectDirectoryTable.tableArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    seedProjectDirectory.node.addDependency(projectDirectoryTable);
    seedCanonicalWorkItems.node.addDependency(seedProjectDirectory);

    const seedWorkspaceAccessCall: customResources.AwsSdkCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createWorkspaceAccessTransactItems(
          workspaceAccessTable.tableName,
          workspaceDirectoryId.valueAsString,
          initialOwnerEmail.valueAsString,
        ),
      },
      physicalResourceId: customResources.PhysicalResourceId.of('workspace-access-seed-v1'),
    };
    const seedWorkspaceAccess = new customResources.AwsCustomResource(
      this,
      'SeedWorkspaceAccess',
      createIdempotentAwsCustomResourceProps(
        seedWorkspaceAccessCall,
        customResources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['dynamodb:TransactWriteItems'],
            resources: [workspaceAccessTable.tableArn],
          }),
        ]),
      ),
    );
    seedWorkspaceAccess.node.addDependency(workspaceAccessTable);

    const bootstrapWorkspaceCall: customResources.AwsSdkCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createWorkspaceBootstrapTransactItems(
          projectDirectoryTable.tableName,
          workspaceDirectoryId.valueAsString,
          initialOwnerEmail.valueAsString,
          initialOwnerUsername.valueAsString,
        ),
      },
      physicalResourceId: customResources.PhysicalResourceId.of('workspace-bootstrap-v1'),
    };
    const bootstrapWorkspace = new customResources.AwsCustomResource(
      this,
      'BootstrapWorkspace',
      createIdempotentAwsCustomResourceProps(
        bootstrapWorkspaceCall,
        customResources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['dynamodb:TransactWriteItems'],
            resources: [projectDirectoryTable.tableArn],
          }),
        ]),
      ),
    );

    bootstrapWorkspace.node.addDependency(seedProjectDirectory);
    bootstrapWorkspace.node.addDependency(updateInitialOwnerAttributes);

    const seedWorkspaceDemoMembersCall: customResources.AwsSdkCall = {
      service: 'DynamoDB',
      action: 'transactWriteItems',
      parameters: {
        TransactItems: createWorkspaceDemoMemberTransactItems(
          workspaceAccessTable.tableName,
          workspaceDirectoryId.valueAsString,
        ),
      },
      physicalResourceId: customResources.PhysicalResourceId.of(
        'workspace-access-demo-members-seed-v1',
      ),
    };
    const seedWorkspaceDemoMembers = new customResources.AwsCustomResource(
      this,
      'SeedWorkspaceDemoMembers',
      createIdempotentAwsCustomResourceProps(
        seedWorkspaceDemoMembersCall,
        customResources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['dynamodb:TransactWriteItems'],
            resources: [workspaceAccessTable.tableArn],
          }),
        ]),
      ),
    );

    seedWorkspaceDemoMembers.node.addDependency(seedWorkspaceAccess);

    new cdk.CfnOutput(this, 'ProjectTasksTableName', {
      value: legacyTasksTable.tableName,
    });
    new cdk.CfnOutput(this, 'ProjectDirectoryTableName', {
      value: projectDirectoryTable.tableName,
    });
    new cdk.CfnOutput(this, 'TeamIssuesTableName', {
      value: workItemsTable.tableName,
    });
    new cdk.CfnOutput(this, 'WorkItemsTableName', {
      value: workItemsTable.tableName,
    });
    new cdk.CfnOutput(this, 'TeamIssueEventsTableName', {
      value: teamIssueEventsTable.tableName,
    });
    const workspaceDirectoryIdOutput = new cdk.CfnOutput(this, 'WorkspaceDirectoryIdOutput', {
      value: workspaceDirectoryId.valueAsString,
    });
    workspaceDirectoryIdOutput.overrideLogicalId('WorkspaceDirectoryId');
    new cdk.CfnOutput(this, 'AuditEventsTableName', { value: auditEventsTable.tableName });
    new cdk.CfnOutput(this, 'AuditEventsStreamArn', { value: auditEventsTable.tableStreamArn! });
    new cdk.CfnOutput(this, 'ProcessedAuditEventsTableName', {
      value: processedAuditEventsTable.tableName,
    });
    new cdk.CfnOutput(this, 'WorkspaceAccessTableName', { value: workspaceAccessTable.tableName });
    new cdk.CfnOutput(this, 'WorkItemCollaborationTableName', {
      value: collaborationTable.tableName,
    });
    new cdk.CfnOutput(this, 'WorkspaceSearchTableName', {
      value: workspaceSearchTable.tableName,
    });
    new cdk.CfnOutput(this, 'NotificationsTableName', { value: notificationsTable.tableName });
    new cdk.CfnOutput(this, 'RealtimeSessionsTableName', {
      value: realtimeSessionsTable.tableName,
    });
    new cdk.CfnOutput(this, 'RealtimeWebSocketUrl', {
      value: realtimeWebSocketStage.url,
    });
    new cdk.CfnOutput(this, 'CollaborationProjectionDlqUrl', {
      value: collaborationProjectionDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'NotificationScheduleDlqUrl', {
      value: notificationScheduleDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'ProjectTasksApiUrl', {
      value: functionUrl.url,
      description: 'Backward-compatible alias for the Lambda Function URL.',
    });
    new cdk.CfnOutput(this, 'ProjectTasksFunctionUrl', {
      value: functionUrl.url,
    });
    new cdk.CfnOutput(this, 'ProjectTasksApiGatewayUrl', {
      value: httpApi.apiEndpoint,
    });
  }
}
