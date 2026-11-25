import { expect, test } from 'bun:test'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { createDynamoDbAutomationDueWorkItemSource } from './due-work-item-source'

test('reads both due keys of every shard and keeps only the Workspace rows due that day', async () => {
  const queries: { shard: unknown, dueKey: unknown, start: unknown }[] = []
  const source = createDynamoDbAutomationDueWorkItemSource({
    workItemsTableName: 'work-items',
    documentClient: {
      async send(command: unknown) {
        if (!(command instanceof QueryCommand)) throw new Error('Unexpected command.')
        const values = command.input.ExpressionAttributeValues ?? {}
        queries.push({
          shard: values[':shard'],
          dueKey: values[':dueKey'],
          start: command.input.ExclusiveStartKey,
        })
        if (values[':shard'] !== 'work-item-schedule-03') return { Items: [] }
        if (values[':dueKey'] === '2026-07-19' && !command.input.ExclusiveStartKey) {
          return {
            Items: [
              { directoryTeamId: 'ws-1#team#core', issueId: 'a', dueDate: '2026-07-19' },
              { directoryTeamId: 'ws-2#team#core', issueId: 'other', dueDate: '2026-07-19' },
            ],
            LastEvaluatedKey: { issueId: 'a' },
          }
        }
        if (values[':dueKey'] === '0000-00-00') {
          return {
            Items: [
              { directoryTeamId: 'ws-1#team#ops', issueId: 'b', dueDate: '2026-07-19' },
              { directoryTeamId: 'ws-1#team#ops', issueId: 'later', dueDate: '2026-07-20' },
              { directoryTeamId: 'ws-1#team#ops', issueId: 'gone', dueDate: '2026-07-19', archivedAt: 'x' },
            ],
          }
        }
        return { Items: [{ directoryTeamId: 'ws-1#team#core', issueId: 'a', dueDate: '2026-07-19' }] }
      },
    },
  })

  const items = await source.listOpenWorkItemsDueOn('ws-1', '2026-07-19')

  expect(items).toEqual([
    { teamId: 'core', workItemId: 'a', dueDate: '2026-07-19' },
    { teamId: 'ops', workItemId: 'b', dueDate: '2026-07-19' },
  ])
  // 16 shards, two keys each, plus the second page of one query.
  expect(queries).toHaveLength(33)
  expect(queries.filter((query) => query.start !== undefined)).toEqual([
    { shard: 'work-item-schedule-03', dueKey: '2026-07-19', start: { issueId: 'a' } },
  ])
})
