import { describe, expect, test } from '@jest/globals';
import {
  createDemoDataCleanupTransactItems,
  createDemoDataRowId,
  findForeignDemoScopeRows,
  listDemoDataRows,
  planDemoDataCleanup,
  type DemoDataRow,
  type ObservedDemoDataRow,
  type StoredDemoDataItem,
} from '../lib/demo-data-cleanup';

const workspaceId = 'workspace#acme';
const initialOwnerEmail = 'owner@acme.test';

/**
 * Builds the item the seed would have stored for a demo row.
 *
 * @param row - Demo row.
 * @returns Stored item carrying the row's key, entryType, and seeded revision.
 */
function seededItem(row: DemoDataRow): StoredDemoDataItem {
  const key = Object.fromEntries(Object.entries(row.key).map(([name, value]) => [name, { S: value }]));
  return row.table === 'workItems'
    ? { ...key, revision: { N: '1' }, teamId: { S: 'core-team' }, assignedProjectId: { S: 'refero' } }
    : { ...key, entryType: { S: row.entryType ?? '' }, role: { S: 'member' } };
}

/**
 * Observes every demo row as still seeded.
 *
 * @param rows - Demo rows.
 * @returns Observed rows with seeded items.
 */
function observeSeeded(rows: readonly DemoDataRow[]): ObservedDemoDataRow[] {
  return rows.map((row) => ({ row, item: seededItem(row) }));
}

describe('demo data cleanup', () => {
  const rows = listDemoDataRows({ workspaceId, initialOwnerEmail });

  test('lists every seeded member, Team, Project, Work Item, and owner grant once', () => {
    const count = (table: DemoDataRow['table']) => rows.filter((row) => row.table === table).length;
    expect(count('workspaceAccess')).toBe(5);
    expect(count('workItems')).toBe(10);
    // 7 Team and Project rows, 2 member rows and 4 grant rows, then 4 owner rows and 10 grant rows.
    expect(count('projectDirectory')).toBe(27);
    expect(new Set(rows.map((row) => createDemoDataRowId(row.table, row.key))).size).toBe(rows.length);
    expect(rows).toContainEqual({
      table: 'projectDirectory',
      key: { directoryId: workspaceId, entryKey: `PROJECT_MEMBER#refero#${initialOwnerEmail}` },
      entryType: 'project-member',
    });
    expect(rows).toContainEqual({
      table: 'workspaceAccess',
      key: { workspaceId, recordKey: 'MEMBER#sato@example.com' },
      entryType: 'workspace-member',
    });
    // The owner's own Workspace rows are not demo data.
    expect(rows.some((row) => Object.values(row.key).includes(`MEMBER#${initialOwnerEmail}`))).toBe(false);
    expect(rows.some((row) => Object.values(row.key).includes(`WORKSPACE_MEMBER#${initialOwnerEmail}`))).toBe(false);
  });

  test('deletes every unchanged seeded row in one conditional transaction', () => {
    const plan = planDemoDataCleanup(observeSeeded(rows), []);
    expect(plan.blockers).toEqual([]);
    expect(plan.deletes).toHaveLength(rows.length);
    const transactItems = createDemoDataCleanupTransactItems(plan, {
      workspaceAccess: 'access',
      projectDirectory: 'directory',
      workItems: 'items',
    });
    expect(transactItems).toHaveLength(rows.length);
    expect(transactItems).toContainEqual({
      Delete: {
        TableName: 'items',
        Key: { directoryTeamId: { S: `${workspaceId}#team#core-team` }, issueId: { S: 'wireframe' } },
        ConditionExpression: '#revision = :revision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':revision': { N: '1' } },
      },
    });
    expect(transactItems).toContainEqual({
      Delete: {
        TableName: 'access',
        Key: { workspaceId: { S: workspaceId }, recordKey: { S: 'MEMBER#viewer@example.com' } },
        ConditionExpression: '#entryType = :entryType AND #role <> :owner',
        ExpressionAttributeNames: { '#entryType': 'entryType', '#role': 'role' },
        ExpressionAttributeValues: { ':entryType': { S: 'workspace-member' }, ':owner': { S: 'owner' } },
      },
    });
  });

  test('skips rows that are already gone', () => {
    const observed = observeSeeded(rows).map((entry) =>
      entry.row.table === 'workItems' ? { row: entry.row, item: undefined } : entry
    );
    const plan = planDemoDataCleanup(observed, []);
    expect(plan.missing).toHaveLength(10);
    expect(plan.deletes.some((row) => row.table === 'workItems')).toBe(false);
    expect(plan.blockers).toEqual([]);
  });

  test('blocks on edited Work Items, demo members made owner, and reused keys', () => {
    const observed = observeSeeded(rows).map((entry) => {
      const { row, item } = entry;
      if (row.table === 'workItems' && row.key.issueId === 'wireframe') {
        return { row, item: { ...item, revision: { N: '3' } } };
      }
      if (row.table === 'workspaceAccess' && row.key.recordKey === 'MEMBER#sato@example.com') {
        return { row, item: { ...item, role: { S: 'owner' } } };
      }
      if (row.table === 'projectDirectory' && row.key.entryKey === '000010#000000#TEAM#core-team') {
        return { row, item: { ...item, entryType: { S: 'project' } } };
      }
      return entry;
    });
    const plan = planDemoDataCleanup(observed, []);
    expect(plan.blockers).toEqual([
      'workspaceAccess workspaceId=workspace#acme recordKey=MEMBER#sato@example.com is now a Workspace owner',
      'projectDirectory directoryId=workspace#acme entryKey=000010#000000#TEAM#core-team holds a project row, not the seeded team',
      `workItems directoryTeamId=${workspaceId}#team#core-team issueId=wireframe was changed after the seed (revision 3)`,
    ]);
    expect(() => createDemoDataCleanupTransactItems(plan, {
      workspaceAccess: 'access',
      projectDirectory: 'directory',
      workItems: 'items',
    })).toThrow('blockers');
  });

  test('finds rows people added to demo Teams and Projects, and ignores the rest', () => {
    const seeded = observeSeeded(rows).flatMap(({ row, item }) => (item ? [{ table: row.table, item }] : []));
    const foreign = findForeignDemoScopeRows(rows, [
      ...seeded,
      {
        table: 'workItems',
        item: {
          directoryTeamId: { S: `${workspaceId}#team#core-team` },
          issueId: { S: 'real-task' },
          teamId: { S: 'core-team' },
        },
      },
      {
        table: 'workItems',
        item: {
          directoryTeamId: { S: `${workspaceId}#team#platform` },
          issueId: { S: 'moved-in' },
          teamId: { S: 'platform' },
          assignedProjectId: { S: 'refero' },
        },
      },
      {
        table: 'projectDirectory',
        item: {
          directoryId: { S: workspaceId },
          entryKey: { S: 'PROJECT_MEMBER#brand-refresh#real@acme.test' },
          projectId: { S: 'brand-refresh' },
        },
      },
      {
        table: 'projectDirectory',
        item: {
          directoryId: { S: workspaceId },
          entryKey: { S: '000030#000000#TEAM#platform' },
          teamId: { S: 'platform' },
        },
      },
    ]);
    expect(foreign).toEqual([
      `workItems directoryTeamId=${workspaceId}#team#core-team issueId=real-task is in a demo Team or Project but was not seeded`,
      `workItems directoryTeamId=${workspaceId}#team#platform issueId=moved-in is in a demo Team or Project but was not seeded`,
      `projectDirectory directoryId=${workspaceId} entryKey=PROJECT_MEMBER#brand-refresh#real@acme.test is in a demo Team or Project but was not seeded`,
    ]);
    expect(planDemoDataCleanup(observeSeeded(rows), foreign).blockers).toEqual(foreign);
  });
});
