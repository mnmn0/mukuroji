import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { buildLocalDynamoDbTables, renderLocalDynamoDbTables } from '../lib/local-dynamodb-tables';

describe('local DynamoDB tables', () => {
  test('the committed Floci definitions match the CDK data stores', () => {
    const committed = readFileSync(resolve(__dirname, '../../floci/init/dynamodb/tables.json'), 'utf8');

    // On failure, run `bun run floci:tables` and commit the regenerated file.
    expect(committed).toBe(renderLocalDynamoDbTables());
  });

  test('every index key is a declared attribute and local names are unique', () => {
    const tables = buildLocalDynamoDbTables();
    const names = tables.map((table) => table.tableName);

    expect(new Set(names).size).toBe(names.length);
    for (const table of tables) {
      const declared = new Set(table.attributeDefinitions.map((definition) => definition.AttributeName));
      const keys = [table.keySchema, ...table.globalSecondaryIndexes.map((index) => index.KeySchema)].flat();
      expect(keys.filter((key) => !declared.has(key.AttributeName))).toEqual([]);
    }
  });

  test('keeps the Work Item indexes the local seed and API read', () => {
    const workItems = buildLocalDynamoDbTables().find((table) => table.constructId === 'WorkItemsTable');

    expect(workItems?.tableName).toBe('mukuroji-team-issues-local');
    expect(workItems?.globalSecondaryIndexes.map((index) => index.IndexName)).toEqual([
      'TeamIssueSortOrderIndex',
      'TeamIssueUpdatedAtIndex',
      'AssignedProjectIssueIndex',
      'WorkItemNotificationDueIndex',
      'TeamStartedWorkItemIndex',
      'WorkItemCustomerCompletionPreparationIndex',
    ]);
  });
});
