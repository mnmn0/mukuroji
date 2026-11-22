import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { buildDataStores, type DataStoreResources } from './subsystems/data-stores';

/**
 * Local Floci table bound to one CDK table of the shared data stores.
 */
type LocalTableBinding = {
  /** Property of {@link DataStoreResources} that owns the deployed table definition. */
  readonly resource: keyof DataStoreResources;
  /** Default table name used by the local development environment. */
  readonly tableName: string;
  /** Environment variable that can override the local table name inside the init hook. */
  readonly tableNameVariable: string;
};

/**
 * Tables created by the Floci ready hook. Other local tables are created by server adapters on
 * first use, so they stay out of this list.
 */
const LOCAL_TABLE_BINDINGS: readonly LocalTableBinding[] = [
  { resource: 'workItemsTable', tableName: 'mukuroji-team-issues-local', tableNameVariable: 'WORK_ITEMS_TABLE_NAME' },
  { resource: 'projectDirectoryTable', tableName: 'mukuroji-project-directory-local', tableNameVariable: 'PROJECT_DIRECTORY_TABLE_NAME' },
  { resource: 'workspaceAccessTable', tableName: 'mukuroji-workspace-access-local', tableNameVariable: 'WORKSPACE_ACCESS_TABLE_NAME' },
  { resource: 'enterpriseIdentityTable', tableName: 'mukuroji-enterprise-identity-local', tableNameVariable: 'ENTERPRISE_IDENTITY_TABLE_NAME' },
  { resource: 'realtimeSessionsTable', tableName: 'mukuroji-realtime-sessions-local', tableNameVariable: 'REALTIME_SESSIONS_TABLE_NAME' },
  { resource: 'workspaceSearchTable', tableName: 'mukuroji-workspace-search-local', tableNameVariable: 'WORKSPACE_SEARCH_TABLE_NAME' },
  { resource: 'analyticsTable', tableName: 'mukuroji-analytics-local', tableNameVariable: 'ANALYTICS_TABLE_NAME' },
  { resource: 'tenantAdministrationTable', tableName: 'mukuroji-tenant-administration-local', tableNameVariable: 'TENANT_ADMINISTRATION_TABLE_NAME' },
  { resource: 'collaborationTable', tableName: 'mukuroji-collaboration-local', tableNameVariable: 'COLLABORATION_TABLE_NAME' },
  { resource: 'notificationsTable', tableName: 'mukuroji-notifications-local', tableNameVariable: 'NOTIFICATIONS_TABLE_NAME' },
  { resource: 'processedAuditEventsTable', tableName: 'mukuroji-processed-audit-events-local', tableNameVariable: 'PROCESSED_AUDIT_EVENTS_TABLE_NAME' },
  { resource: 'developerPlatformTable', tableName: 'mukuroji-developer-platform-local', tableNameVariable: 'DEVELOPER_PLATFORM_TABLE_NAME' },
  { resource: 'pushSubscriptionsTable', tableName: 'mukuroji-push-subscriptions-local', tableNameVariable: 'PUSH_SUBSCRIPTIONS_TABLE_NAME' },
  { resource: 'agentRunsTable', tableName: 'mukuroji-agent-runs-local', tableNameVariable: 'AGENT_RUNS_TABLE_NAME' },
];

/**
 * DynamoDB key attribute definition in the CreateTable request shape.
 */
type LocalAttributeDefinition = {
  /** Attribute name. */
  readonly AttributeName: string;
  /** Scalar attribute type: `S`, `N`, or `B`. */
  readonly AttributeType: string;
};

/**
 * DynamoDB key schema element in the CreateTable request shape.
 */
type LocalKeySchemaElement = {
  /** Key attribute name. */
  readonly AttributeName: string;
  /** `HASH` for the partition key or `RANGE` for the sort key. */
  readonly KeyType: string;
};

/**
 * Global secondary index projection in the CreateTable request shape.
 */
type LocalProjection = {
  /** `ALL`, `KEYS_ONLY`, or `INCLUDE`. */
  readonly ProjectionType: string;
  /** Projected non-key attributes, present only for `INCLUDE`. */
  readonly NonKeyAttributes?: readonly string[];
};

/**
 * Global secondary index in the CreateTable request shape.
 */
type LocalGlobalSecondaryIndex = {
  /** Index name shared with the deployed table. */
  readonly IndexName: string;
  /** Index key schema. */
  readonly KeySchema: readonly LocalKeySchemaElement[];
  /** Attributes copied into the index. */
  readonly Projection: LocalProjection;
};

/**
 * Local table definition read by the Floci ready hook.
 */
export type LocalDynamoDbTable = {
  /** CDK construct ID of the deployed table this definition is generated from. */
  readonly constructId: string;
  /** Default local table name. */
  readonly tableName: string;
  /** Environment variable that overrides {@link LocalDynamoDbTable.tableName}. */
  readonly tableNameVariable: string;
  /** Key attribute definitions for the table and every index. */
  readonly attributeDefinitions: readonly LocalAttributeDefinition[];
  /** Table key schema. */
  readonly keySchema: readonly LocalKeySchemaElement[];
  /** Global secondary indexes, in CDK declaration order. */
  readonly globalSecondaryIndexes: readonly LocalGlobalSecondaryIndex[];
  /** TTL attribute name, or `null` when the table has no TTL. */
  readonly timeToLiveAttribute: string | null;
};

/**
 * Narrows an unknown template value to a plain object.
 *
 * @param value - Value read from the synthesized template.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a required string property from a template object.
 *
 * @param value - Template object.
 * @param key - Property name.
 * @param context - Location used in the error message.
 * @returns The string value.
 */
function readString(value: unknown, key: string, context: string): string {
  const property = isRecord(value) ? value[key] : undefined;
  if (typeof property !== 'string') {
    throw new Error(`${context}.${key} must be a literal string in the synthesized template.`);
  }
  return property;
}

/**
 * Reads an optional array property from a template object.
 *
 * @param value - Template object.
 * @param key - Property name.
 * @param context - Location used in the error message.
 * @returns The array, or an empty array when the property is absent.
 */
function readArray(value: unknown, key: string, context: string): readonly unknown[] {
  const property = isRecord(value) ? value[key] : undefined;
  if (property === undefined) {
    return [];
  }
  if (!Array.isArray(property)) {
    throw new Error(`${context}.${key} must be an array in the synthesized template.`);
  }
  return property;
}

/**
 * Converts template key schema elements into the CreateTable request shape.
 *
 * @param elements - `KeySchema` entries from the template.
 * @param context - Location used in error messages.
 * @returns Key schema elements with only the fields DynamoDB accepts.
 */
function readKeySchema(elements: readonly unknown[], context: string): LocalKeySchemaElement[] {
  return elements.map((element, index) => ({
    AttributeName: readString(element, 'AttributeName', `${context}.KeySchema[${index}]`),
    KeyType: readString(element, 'KeyType', `${context}.KeySchema[${index}]`),
  }));
}

/**
 * Converts one synthesized `AWS::DynamoDB::Table` into the local definition.
 *
 * @param binding - Local name binding for the table.
 * @param constructId - CDK construct ID of the deployed table.
 * @param properties - `Properties` of the synthesized table resource.
 * @returns The local table definition.
 */
function toLocalTable(binding: LocalTableBinding, constructId: string, properties: unknown): LocalDynamoDbTable {
  const context = constructId;
  const billingMode = readString(properties, 'BillingMode', context);
  if (billingMode !== 'PAY_PER_REQUEST') {
    throw new Error(`${context} must use PAY_PER_REQUEST to be created locally.`);
  }
  const ttl = isRecord(properties) ? properties.TimeToLiveSpecification : undefined;
  return {
    constructId,
    tableName: binding.tableName,
    tableNameVariable: binding.tableNameVariable,
    attributeDefinitions: readArray(properties, 'AttributeDefinitions', context).map((definition, index) => ({
      AttributeName: readString(definition, 'AttributeName', `${context}.AttributeDefinitions[${index}]`),
      AttributeType: readString(definition, 'AttributeType', `${context}.AttributeDefinitions[${index}]`),
    })),
    keySchema: readKeySchema(readArray(properties, 'KeySchema', context), context),
    globalSecondaryIndexes: readArray(properties, 'GlobalSecondaryIndexes', context).map((index, position) => {
      const indexContext = `${context}.GlobalSecondaryIndexes[${position}]`;
      const projection = isRecord(index) ? index.Projection : undefined;
      const nonKeyAttributes = readArray(projection, 'NonKeyAttributes', `${indexContext}.Projection`).map(
        (attribute, attributePosition) => {
          if (typeof attribute !== 'string') {
            throw new Error(`${indexContext}.Projection.NonKeyAttributes[${attributePosition}] must be a string.`);
          }
          return attribute;
        },
      );
      const projectionType = readString(projection, 'ProjectionType', `${indexContext}.Projection`);
      return {
        IndexName: readString(index, 'IndexName', indexContext),
        KeySchema: readKeySchema(readArray(index, 'KeySchema', indexContext), indexContext),
        Projection:
          nonKeyAttributes.length > 0
            ? { ProjectionType: projectionType, NonKeyAttributes: nonKeyAttributes }
            : { ProjectionType: projectionType },
      };
    }),
    timeToLiveAttribute:
      isRecord(ttl) && ttl.Enabled === true ? readString(ttl, 'AttributeName', `${context}.TimeToLiveSpecification`) : null,
  };
}

/**
 * Synthesizes the shared data stores and derives the tables the Floci ready hook creates.
 *
 * The deployed CDK definition stays the single source of key schemas, indexes, and TTL.
 *
 * @returns Local table definitions in hook creation order.
 */
export function buildLocalDynamoDbTables(): LocalDynamoDbTable[] {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'LocalDynamoDbTables');
  const resources = buildDataStores(stack, {
    connectorRuntimeConfiguration: undefined,
    enterpriseIdentityTokenHashSecret: new cdk.CfnParameter(stack, 'EnterpriseIdentityTokenHashSecret', {
      noEcho: true,
    }),
    workspaceAuditPseudonymKey: new cdk.CfnParameter(stack, 'WorkspaceAuditPseudonymKey', { noEcho: true }),
  });
  const resourcesTemplate = app.synth().getStackByName(stack.stackName).template;
  const templateResources = isRecord(resourcesTemplate) ? resourcesTemplate.Resources : undefined;

  return LOCAL_TABLE_BINDINGS.map((binding) => {
    const table = resources[binding.resource];
    if (!(table instanceof dynamodb.Table)) {
      throw new Error(`${binding.resource} is not a DynamoDB table.`);
    }
    const cfnTable = table.node.defaultChild;
    if (!(cfnTable instanceof dynamodb.CfnTable)) {
      throw new Error(`${binding.resource} has no CloudFormation table.`);
    }
    const logicalId = stack.getLogicalId(cfnTable);
    const resource = isRecord(templateResources) ? templateResources[logicalId] : undefined;
    return toLocalTable(binding, table.node.id, isRecord(resource) ? resource.Properties : undefined);
  });
}

/**
 * Renders the local table definitions as the committed JSON file.
 *
 * @returns Pretty-printed JSON with a trailing newline.
 */
export function renderLocalDynamoDbTables(): string {
  return `${JSON.stringify(buildLocalDynamoDbTables(), null, 2)}\n`;
}
