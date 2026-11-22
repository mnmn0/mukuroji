import {
  DEMO_DIRECTORY_SCOPE,
  createCanonicalWorkItemMemberIndexTransactItems,
  createCanonicalWorkItemTransactItems,
  createDemoProjectOwnerAccessTransactItems,
  createProjectDirectoryTransactItems,
  createWorkspaceDemoMemberTransactItems,
} from './bootstrap-data';

/**
 * Table that holds rows written by the demo seed.
 */
export type DemoDataTable = 'workspaceAccess' | 'projectDirectory' | 'workItems';

/**
 * Key attribute names of each table that the demo seed writes.
 */
export const DEMO_DATA_TABLE_KEYS: Readonly<Record<DemoDataTable, readonly [string, string]>> = {
  workspaceAccess: ['workspaceId', 'recordKey'],
  projectDirectory: ['directoryId', 'entryKey'],
  workItems: ['directoryTeamId', 'issueId'],
};

/**
 * A DynamoDB item in the low-level attribute-value shape, such as `{ entryKey: { S: '...' } }`.
 */
export type StoredDemoDataItem = Readonly<Record<string, unknown>>;

/**
 * One row that the demo seed writes, identified by its table and key.
 */
export interface DemoDataRow {
  /** Table that holds the row. */
  readonly table: DemoDataTable;
  /** Partition and sort key values, by attribute name. */
  readonly key: Readonly<Record<string, string>>;
  /** `entryType` the seed wrote, or undefined for canonical Work Items, which have none. */
  readonly entryType: string | undefined;
}

/**
 * A demo row as read from DynamoDB before the cleanup.
 */
export interface ObservedDemoDataRow {
  /** Row the demo seed writes. */
  readonly row: DemoDataRow;
  /** Item stored at the row's key, or undefined when the key holds nothing. */
  readonly item: StoredDemoDataItem | undefined;
}

/**
 * Result of comparing the demo seed with what the tables hold.
 */
export interface DemoDataCleanupPlan {
  /** Demo rows that still exist and can be deleted. */
  readonly deletes: readonly DemoDataRow[];
  /** Demo rows whose key holds nothing, such as rows already removed. */
  readonly missing: readonly DemoDataRow[];
  /** Reasons that stop the cleanup; nothing is deleted while any remains. */
  readonly blockers: readonly string[];
}

/**
 * One conditional delete of a demo row, for DynamoDB `TransactWriteItems`.
 */
export interface DemoDataDeleteTransactItem {
  /** Delete operation. */
  readonly Delete: {
    /** Physical table name. */
    readonly TableName: string;
    /** Row key in attribute-value shape. */
    readonly Key: Record<string, { readonly S: string }>;
    /** Condition that the row still looks as planned. */
    readonly ConditionExpression: string;
    /** Attribute names used by the condition. */
    readonly ExpressionAttributeNames: Record<string, string>;
    /** Attribute values used by the condition. */
    readonly ExpressionAttributeValues: Record<string, { readonly S: string } | { readonly N: string }>;
  };
}

/**
 * Revision the demo seed gives each Work Item; any edit raises it.
 */
const seededWorkItemRevision = '1';

/**
 * Most items one DynamoDB transaction accepts.
 */
const maxTransactionItems = 100;

/**
 * Lists every row that the demo seed of `cdk deploy -c mukuroji:demoData=true` writes.
 *
 * The rows come from the same builders the stack uses, so the list follows the seed.
 *
 * @param input - Workspace directory ID and initial owner email used by the deploy.
 * @returns Demo rows with unique keys.
 */
export function listDemoDataRows(input: {
  /** `WorkspaceDirectoryId` stack parameter. */
  readonly workspaceId: string;
  /** `InitialOwnerEmail` stack parameter, in lowercase. */
  readonly initialOwnerEmail: string;
}): readonly DemoDataRow[] {
  const { workspaceId, initialOwnerEmail } = input;
  const sources: readonly (readonly [DemoDataTable, readonly unknown[]])[] = [
    ['workspaceAccess', createWorkspaceDemoMemberTransactItems('workspaceAccess', workspaceId)],
    ['projectDirectory', createProjectDirectoryTransactItems('projectDirectory', workspaceId)],
    [
      'projectDirectory',
      createDemoProjectOwnerAccessTransactItems('projectDirectory', workspaceId, initialOwnerEmail),
    ],
    ['workItems', createCanonicalWorkItemTransactItems('workItems', workspaceId)],
    ['workItems', createCanonicalWorkItemMemberIndexTransactItems('workItems', workspaceId)],
  ];
  const rows = new Map<string, DemoDataRow>();
  for (const [table, transactItems] of sources) {
    for (const transactItem of transactItems) {
      const row = readDemoDataRow(table, transactItem);
      rows.set(createDemoDataRowId(row.table, row.key), row);
    }
  }
  return [...rows.values()];
}

/**
 * Creates a stable identifier for a row from its table and key.
 *
 * @param table - Table that holds the row.
 * @param key - Key attribute values by name.
 * @returns Identifier unique across the demo tables.
 */
export function createDemoDataRowId(
  table: DemoDataTable,
  key: Readonly<Record<string, string>>,
): string {
  const [partitionKey, sortKey] = DEMO_DATA_TABLE_KEYS[table];
  return JSON.stringify([table, key[partitionKey], key[sortKey]]);
}

/**
 * Reads the key of a stored item in one of the demo tables.
 *
 * @param table - Table the item came from.
 * @param item - Stored item in attribute-value shape.
 * @returns Key values by name, or undefined when a key attribute is not a string.
 */
export function readDemoDataItemKey(
  table: DemoDataTable,
  item: StoredDemoDataItem,
): Readonly<Record<string, string>> | undefined {
  const [partitionKey, sortKey] = DEMO_DATA_TABLE_KEYS[table];
  const partitionValue = readStringAttribute(item, partitionKey);
  const sortValue = readStringAttribute(item, sortKey);
  if (partitionValue === undefined || sortValue === undefined) {
    return undefined;
  }
  return { [partitionKey]: partitionValue, [sortKey]: sortValue };
}

/**
 * Finds rows in the demo Teams and Projects that the demo seed did not write.
 *
 * Such rows are data that people added after the deploy, such as a Work Item in a demo Team
 * or a member added to a demo Project. Deleting the demo Team or Project would orphan them.
 *
 * @param demoRows - Rows the demo seed writes.
 * @param scanned - Items read from the demo Team and Project scopes, by table.
 * @returns A description of each row outside the seed.
 */
export function findForeignDemoScopeRows(
  demoRows: readonly DemoDataRow[],
  scanned: readonly {
    /** Table the item came from. */
    readonly table: DemoDataTable;
    /** Stored item in attribute-value shape. */
    readonly item: StoredDemoDataItem;
  }[],
): readonly string[] {
  const demoRowIds = new Set(demoRows.map((row) => createDemoDataRowId(row.table, row.key)));
  const foreign: string[] = [];
  const seen = new Set<string>();
  for (const { table, item } of scanned) {
    const key = readDemoDataItemKey(table, item);
    if (!key) {
      continue;
    }
    const id = createDemoDataRowId(table, key);
    if (demoRowIds.has(id) || seen.has(id) || !isInDemoScope(table, item)) {
      continue;
    }
    seen.add(id);
    foreign.push(`${table} ${formatKey(key)} is in a demo Team or Project but was not seeded`);
  }
  return foreign;
}

/**
 * Compares the demo seed with the stored rows and decides what the cleanup deletes.
 *
 * The cleanup deletes only rows that still look as the seed wrote them. A changed demo Work
 * Item, a demo member made owner, a key reused by another kind of row, or any row people added
 * to a demo Team or Project blocks the whole cleanup.
 *
 * @param observed - Each demo row with the item stored at its key.
 * @param foreignRows - Rows found in the demo scopes that the seed did not write.
 * @returns Rows to delete, rows already gone, and reasons that block the cleanup.
 */
export function planDemoDataCleanup(
  observed: readonly ObservedDemoDataRow[],
  foreignRows: readonly string[],
): DemoDataCleanupPlan {
  const deletes: DemoDataRow[] = [];
  const missing: DemoDataRow[] = [];
  const blockers: string[] = [...foreignRows];
  for (const { row, item } of observed) {
    if (!item) {
      missing.push(row);
      continue;
    }
    const blocker = findRowBlocker(row, item);
    if (blocker) {
      blockers.push(blocker);
      continue;
    }
    deletes.push(row);
  }
  if (deletes.length > maxTransactionItems) {
    blockers.push(
      `The cleanup has ${deletes.length} rows, more than one transaction of ${maxTransactionItems} accepts.`,
    );
  }
  return { deletes, missing, blockers };
}

/**
 * Builds one all-or-nothing transaction that deletes the planned rows.
 *
 * Each delete repeats the plan's checks as its condition, so a row changed after the plan
 * fails the whole transaction and nothing is deleted.
 *
 * @param plan - Cleanup plan without blockers.
 * @param tableNames - Physical table name of each demo table.
 * @returns `TransactItems` for DynamoDB `TransactWriteItems`.
 */
export function createDemoDataCleanupTransactItems(
  plan: DemoDataCleanupPlan,
  tableNames: Readonly<Record<DemoDataTable, string>>,
): DemoDataDeleteTransactItem[] {
  if (plan.blockers.length > 0) {
    throw new Error('A cleanup plan with blockers cannot be applied.');
  }
  return plan.deletes.map((row): DemoDataDeleteTransactItem => {
    const key = Object.fromEntries(
      Object.entries(row.key).map(([name, value]) => [name, { S: value }]),
    );
    if (row.table === 'workItems' && row.entryType === undefined) {
      return {
        Delete: {
          TableName: tableNames.workItems,
          Key: key,
          ConditionExpression: '#revision = :revision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':revision': { N: seededWorkItemRevision } },
        },
      };
    }
    if (row.table === 'workspaceAccess') {
      return {
        Delete: {
          TableName: tableNames.workspaceAccess,
          Key: key,
          ConditionExpression: '#entryType = :entryType AND #role <> :owner',
          ExpressionAttributeNames: { '#entryType': 'entryType', '#role': 'role' },
          ExpressionAttributeValues: {
            ':entryType': { S: requireEntryType(row) },
            ':owner': { S: 'owner' },
          },
        },
      };
    }
    return {
      Delete: {
        TableName: tableNames[row.table],
        Key: key,
        ConditionExpression: '#entryType = :entryType',
        ExpressionAttributeNames: { '#entryType': 'entryType' },
        ExpressionAttributeValues: { ':entryType': { S: requireEntryType(row) } },
      },
    };
  });
}

/**
 * Formats a key for messages.
 *
 * @param key - Key attribute values by name.
 * @returns `name=value` pairs joined by spaces.
 */
export function formatKey(key: Readonly<Record<string, string>>): string {
  return Object.entries(key).map(([name, value]) => `${name}=${value}`).join(' ');
}

/**
 * Explains why a stored demo row must not be deleted.
 *
 * @param row - Demo row the seed wrote.
 * @param item - Item stored at the row's key.
 * @returns A blocker message, or undefined when the row can be deleted.
 */
function findRowBlocker(row: DemoDataRow, item: StoredDemoDataItem): string | undefined {
  const label = `${row.table} ${formatKey(row.key)}`;
  if (row.table === 'workItems' && row.entryType === undefined) {
    const revision = readNumberAttribute(item, 'revision');
    return revision === seededWorkItemRevision
      ? undefined
      : `${label} was changed after the seed (revision ${revision ?? 'unknown'})`;
  }
  const entryType = readStringAttribute(item, 'entryType');
  if (entryType !== row.entryType) {
    return `${label} holds a ${entryType ?? 'untyped'} row, not the seeded ${row.entryType ?? 'row'}`;
  }
  if (row.table === 'workspaceAccess' && readStringAttribute(item, 'role') === 'owner') {
    return `${label} is now a Workspace owner`;
  }
  return undefined;
}

/**
 * Tells whether a stored item belongs to a demo Team or Project.
 *
 * @param table - Table the item came from.
 * @param item - Stored item in attribute-value shape.
 * @returns True when the item names a demo Team or Project.
 */
function isInDemoScope(table: DemoDataTable, item: StoredDemoDataItem): boolean {
  if (table === 'workspaceAccess') {
    return false;
  }
  const teamId = readStringAttribute(item, 'teamId');
  const projectId = readStringAttribute(item, table === 'workItems' ? 'assignedProjectId' : 'projectId');
  return (teamId !== undefined && DEMO_DIRECTORY_SCOPE.teamIds.includes(teamId))
    || (projectId !== undefined && DEMO_DIRECTORY_SCOPE.projectIds.includes(projectId));
}

/**
 * Reads the key and seeded `entryType` of one seed transaction item.
 *
 * @param table - Table the seed writes the item to.
 * @param transactItem - `Put` or `Update` transaction item built for the seed.
 * @returns The demo row it writes.
 */
function readDemoDataRow(table: DemoDataTable, transactItem: unknown): DemoDataRow {
  const put = readRecord(transactItem, 'Put');
  if (put) {
    const item = readRecord(put, 'Item');
    const key = item && readDemoDataItemKey(table, item);
    if (!item || !key) {
      throw new Error(`A ${table} seed Put has no key.`);
    }
    return { table, key, entryType: readStringAttribute(item, 'entryType') };
  }
  const update = readRecord(transactItem, 'Update');
  const keyItem = update && readRecord(update, 'Key');
  const key = keyItem && readDemoDataItemKey(table, keyItem);
  if (!update || !key) {
    throw new Error(`A ${table} seed item is neither a Put nor an Update with a key.`);
  }
  const values = readRecord(update, 'ExpressionAttributeValues');
  return { table, key, entryType: values && readStringAttribute(values, ':entryType') };
}

/**
 * Returns the seeded `entryType` of a row that must have one.
 *
 * @param row - Demo row outside the Work Item table.
 * @returns The seeded `entryType`.
 */
function requireEntryType(row: DemoDataRow): string {
  if (row.entryType === undefined) {
    throw new Error(`${row.table} ${formatKey(row.key)} has no seeded entryType.`);
  }
  return row.entryType;
}

/**
 * Reads a nested object property.
 *
 * @param value - Object to read from.
 * @param name - Property name.
 * @returns The property when it is a non-array object.
 */
function readRecord(value: unknown, name: string): StoredDemoDataItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const property = value[name];
  return isRecord(property) ? property : undefined;
}

/**
 * Reads a string attribute in attribute-value shape.
 *
 * @param item - Item to read from.
 * @param name - Attribute name.
 * @returns The `S` value, or undefined when the attribute is missing or not a string.
 */
function readStringAttribute(item: StoredDemoDataItem, name: string): string | undefined {
  const attribute = readRecord(item, name);
  const value = attribute?.S;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads a number attribute in attribute-value shape.
 *
 * @param item - Item to read from.
 * @param name - Attribute name.
 * @returns The `N` value as written, or undefined when the attribute is missing or not a number.
 */
function readNumberAttribute(item: StoredDemoDataItem, name: string): string | undefined {
  const attribute = readRecord(item, name);
  const value = attribute?.N;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Tells whether a value is a non-array object.
 *
 * @param value - Value to check.
 * @returns True for plain objects.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
