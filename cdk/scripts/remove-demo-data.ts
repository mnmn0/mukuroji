import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type QueryCommandInput,
} from '@aws-sdk/client-dynamodb';
import { DEMO_DIRECTORY_SCOPE } from '../lib/bootstrap-data';
import {
  createDemoDataCleanupTransactItems,
  findForeignDemoScopeRows,
  formatKey,
  listDemoDataRows,
  planDemoDataCleanup,
  type DemoDataTable,
  type ObservedDemoDataRow,
  type StoredDemoDataItem,
} from '../lib/demo-data-cleanup';

/**
 * Removes the demo data that `cdk deploy -c mukuroji:demoData=true` seeded.
 *
 * Without `--apply` it only prints the plan. With `--apply` it deletes every seeded row that
 * is still unchanged in one transaction, and deletes nothing while any blocker remains.
 */
const usage = `Usage: bun run demo-data:remove [--apply]

Environment:
  WORKSPACE_ACCESS_TABLE_NAME     WorkspaceAccessTableName stack output
  PROJECT_DIRECTORY_TABLE_NAME    ProjectDirectoryTableName stack output
  WORK_ITEMS_TABLE_NAME           WorkItemsTableName stack output
  MUKUROJI_WORKSPACE_DIRECTORY_ID WorkspaceDirectoryId stack parameter
  INITIAL_OWNER_EMAIL             InitialOwnerEmail stack parameter
  AWS_REGION, AWS_ENDPOINT_URL    optional; AWS_ENDPOINT_URL points at an emulator`;

/**
 * Reads a required environment variable.
 *
 * @param name - Variable name.
 * @returns The trimmed value.
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required.\n\n${usage}`);
    process.exit(2);
  }
  return value;
}

/**
 * Reads every item of a query, following pagination.
 *
 * @param client - DynamoDB client.
 * @param input - Query input without a start key.
 * @returns All items the query returns.
 */
async function queryAll(
  client: DynamoDBClient,
  input: QueryCommandInput,
): Promise<StoredDemoDataItem[]> {
  const items: StoredDemoDataItem[] = [];
  let exclusiveStartKey: QueryCommandInput['ExclusiveStartKey'];
  do {
    const page = await client.send(new QueryCommand({
      ...input,
      ExclusiveStartKey: exclusiveStartKey,
    }));
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

/**
 * A stored item with the demo table it came from.
 */
interface TaggedItem {
  /** Table the item came from. */
  readonly table: DemoDataTable;
  /** Stored item in attribute-value shape. */
  readonly item: StoredDemoDataItem;
}

/**
 * Pairs each item with the table it came from.
 *
 * @param table - Table the items came from.
 * @param items - Stored items.
 * @returns Items tagged with their table.
 */
function tagItems(table: DemoDataTable, items: readonly StoredDemoDataItem[]): TaggedItem[] {
  return items.map((item) => ({ table, item }));
}

/**
 * Builds a query input for one partition.
 *
 * @param tableName - Physical table name.
 * @param partitionKey - Partition key attribute name.
 * @param value - Partition key value.
 * @param indexName - Optional index to query.
 * @returns Query input reading the whole partition.
 */
function partitionQuery(
  tableName: string,
  partitionKey: string,
  value: string,
  indexName?: string,
): QueryCommandInput {
  return {
    TableName: tableName,
    IndexName: indexName,
    KeyConditionExpression: '#partitionKey = :partitionKey',
    ExpressionAttributeNames: { '#partitionKey': partitionKey },
    ExpressionAttributeValues: { ':partitionKey': { S: value } },
    ConsistentRead: indexName ? undefined : true,
  };
}

/**
 * Runs the cleanup.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return 0;
  }
  const unknownArgs = args.filter((arg) => arg !== '--apply');
  if (unknownArgs.length > 0) {
    console.error(`Unknown arguments: ${unknownArgs.join(' ')}\n\n${usage}`);
    return 2;
  }
  const apply = args.includes('--apply');
  const tableNames: Record<DemoDataTable, string> = {
    workspaceAccess: requireEnv('WORKSPACE_ACCESS_TABLE_NAME'),
    projectDirectory: requireEnv('PROJECT_DIRECTORY_TABLE_NAME'),
    workItems: requireEnv('WORK_ITEMS_TABLE_NAME'),
  };
  const workspaceId = requireEnv('MUKUROJI_WORKSPACE_DIRECTORY_ID');
  const initialOwnerEmail = requireEnv('INITIAL_OWNER_EMAIL').toLowerCase();
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL || undefined,
  });

  const demoRows = listDemoDataRows({ workspaceId, initialOwnerEmail });
  const observed: ObservedDemoDataRow[] = [];
  for (const row of demoRows) {
    const result = await client.send(new GetItemCommand({
      TableName: tableNames[row.table],
      Key: Object.fromEntries(Object.entries(row.key).map(([name, value]) => [name, { S: value }])),
      ConsistentRead: true,
    }));
    observed.push({ row, item: result.Item });
  }

  const scanned: TaggedItem[] = [];
  const directoryItems = await queryAll(
    client,
    partitionQuery(tableNames.projectDirectory, 'directoryId', workspaceId),
  );
  scanned.push(...tagItems('projectDirectory', directoryItems));
  for (const teamId of DEMO_DIRECTORY_SCOPE.teamIds) {
    const grantCleanupItems = await queryAll(
      client,
      partitionQuery(
        tableNames.projectDirectory,
        'directoryId',
        `WEBHOOK_GRANT_CLEANUP#${workspaceId}#${teamId}`,
      ),
    );
    scanned.push(...tagItems('projectDirectory', grantCleanupItems));
    const teamWorkItems = await queryAll(
      client,
      partitionQuery(tableNames.workItems, 'directoryTeamId', `${workspaceId}#team#${teamId}`),
    );
    scanned.push(...tagItems('workItems', teamWorkItems));
  }
  for (const projectId of DEMO_DIRECTORY_SCOPE.projectIds) {
    const projectWorkItems = await queryAll(
      client,
      partitionQuery(
        tableNames.workItems,
        'directoryProjectId',
        `${workspaceId}#project#${projectId}`,
        'AssignedProjectIssueIndex',
      ),
    );
    scanned.push(...tagItems('workItems', projectWorkItems));
  }

  const plan = planDemoDataCleanup(observed, findForeignDemoScopeRows(demoRows, scanned));
  console.log(`Workspace ${workspaceId}: ${plan.deletes.length} demo rows to delete, ${plan.missing.length} already gone.`);
  for (const row of plan.deletes) {
    console.log(`  delete ${row.table} ${formatKey(row.key)}`);
  }
  if (plan.blockers.length > 0) {
    console.error(`\nNothing was deleted. ${plan.blockers.length} rows block the cleanup:`);
    for (const blocker of plan.blockers) {
      console.error(`  - ${blocker}`);
    }
    console.error('\nArchive the demo Teams and Projects from the app instead, or remove these rows first.');
    return 1;
  }
  if (plan.deletes.length === 0) {
    console.log('No demo data remains.');
    return 0;
  }
  if (!apply) {
    console.log('\nDry run. Run again with --apply to delete these rows.');
    return 0;
  }
  await client.send(new TransactWriteItemsCommand({
    TransactItems: createDemoDataCleanupTransactItems(plan, tableNames),
  }));
  console.log(`Deleted ${plan.deletes.length} demo rows.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
