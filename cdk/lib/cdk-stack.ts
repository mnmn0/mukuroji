import * as cdk from 'aws-cdk-lib';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

const projectTaskItems = [
  ['refero', 'wireframe', 10, 'tasks.item.wireframe', 'tasks.assignee.sato', 'in-progress', '2025/05/26', 'high'],
  ['refero', 'brand-guideline', 20, 'tasks.item.brandGuideline', 'tasks.assignee.suzuki', 'review', '2025/05/27', 'medium'],
  ['refero', 'pricing-content', 30, 'tasks.item.pricingContent', 'tasks.assignee.tanaka', 'in-progress', '2025/05/28', 'high'],
  ['refero', 'seo-research', 40, 'tasks.item.seoResearch', 'tasks.assignee.yamamoto', 'todo', '2025/05/29', 'medium'],
  ['refero', 'hero-design', 50, 'tasks.item.heroDesign', 'tasks.assignee.sato', 'review', '2025/05/30', 'medium'],
  ['refero', 'analytics-tags', 60, 'tasks.item.analyticsTags', 'tasks.assignee.suzuki', 'in-progress', '2025/06/02', 'low'],
  ['refero', 'competitor-report', 70, 'tasks.item.competitorReport', 'tasks.assignee.tanaka', 'done', '2025/06/03', 'low'],
  ['refero', 'terms-page', 80, 'tasks.item.termsPage', 'tasks.assignee.yamamoto', 'todo', '2025/06/04', 'medium'],
  ['refero', 'faq-content', 90, 'tasks.item.faqContent', 'tasks.assignee.sato', 'todo', '2025/06/05', 'low'],
  ['refero', 'landing-release', 100, 'tasks.item.landingRelease', 'tasks.assignee.suzuki', 'todo', '2025/06/06', 'high'],
] as const;

function createProjectTaskTransactItems(tableName: string) {
  return projectTaskItems.map(([projectId, taskId, sortOrder, titleKey, assigneeKey, status, dueDate, priority]) => ({
    Put: {
      TableName: tableName,
      Item: {
        projectId: { S: projectId },
        taskId: { S: taskId },
        sortOrder: { N: String(sortOrder) },
        titleKey: { S: titleKey },
        assigneeKey: { S: assigneeKey },
        status: { S: status },
        dueDate: { S: dueDate },
        priority: { S: priority },
      },
    },
  }));
}

/**
 * mukuroji のアプリケーションデータ取得基盤を定義する CDK stack です。
 */
export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tasksTable = new dynamodb.Table(this, 'ProjectTasksTable', {
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    tasksTable.addGlobalSecondaryIndex({
      indexName: 'ProjectSortOrderIndex',
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortOrder', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const listTasksFunction = new lambda.Function(this, 'ListProjectTasksFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        TASKS_TABLE_NAME: tasksTable.tableName,
      },
      code: lambda.Code.fromInline(`
const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');

const client = new DynamoDBClient({});
const headers = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'content-type': 'application/json; charset=utf-8',
};

exports.handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  const projectId = event.pathParameters?.projectId ?? event.rawPath?.match(/^\\/projects\\/([^/]+)\\/tasks$/)?.[1];

  if (!projectId) {
    return json(404, { message: 'Project tasks endpoint was not found.' });
  }

  try {
    const response = await client.send(new QueryCommand({
      TableName: process.env.TASKS_TABLE_NAME,
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'projectId = :projectId',
      ExpressionAttributeValues: {
        ':projectId': { S: decodeURIComponent(projectId) },
      },
      ScanIndexForward: true,
    }));

    return json(200, {
      projectId: decodeURIComponent(projectId),
      tasks: (response.Items ?? []).map(toTask),
    });
  } catch (error) {
    console.error(error);
    return json(500, { message: 'Failed to load project tasks.' });
  }
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function toTask(item) {
  return {
    id: item.taskId.S,
    titleKey: item.titleKey.S,
    assigneeKey: item.assigneeKey.S,
    status: item.status.S,
    dueDate: item.dueDate.S,
    priority: item.priority.S,
  };
}
      `),
    });

    tasksTable.grantReadData(listTasksFunction);

    const tasksFunctionUrl = listTasksFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ['authorization', 'content-type'],
      },
    });

    const seedTasks = new customResources.AwsCustomResource(this, 'SeedProjectTasks', {
      onCreate: {
        service: 'DynamoDB',
        action: 'transactWriteItems',
        parameters: {
          TransactItems: createProjectTaskTransactItems(tasksTable.tableName),
        },
        physicalResourceId: customResources.PhysicalResourceId.of('refero-project-tasks-seed-v1'),
      },
      onUpdate: {
        service: 'DynamoDB',
        action: 'transactWriteItems',
        parameters: {
          TransactItems: createProjectTaskTransactItems(tasksTable.tableName),
        },
        physicalResourceId: customResources.PhysicalResourceId.of('refero-project-tasks-seed-v1'),
      },
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:TransactWriteItems'],
          resources: [tasksTable.tableArn],
        }),
      ]),
    });

    seedTasks.node.addDependency(tasksTable);

    new cdk.CfnOutput(this, 'ProjectTasksTableName', {
      value: tasksTable.tableName,
    });

    new cdk.CfnOutput(this, 'ProjectTasksApiUrl', {
      value: tasksFunctionUrl.url,
    });
  }
}
