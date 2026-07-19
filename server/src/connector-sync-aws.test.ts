import { describe, expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  DynamoDbConnectorPollCheckpointStore,
  DynamoDbConnectorPollInventory,
} from './connector-sync-aws'
import {
  createConnectorPollTargetLookupKey,
  createConnectorPollTargetRecordKey,
  createConnectorPollTargetShardLookupKey,
} from './connector-poll-projection'

describe('DynamoDB connector poll adapters', () => {
  test('encrypts provider cursors and reads them through a bound context', async () => {
    const commands: unknown[] = []
    const documentClient = {
      async send(command: unknown) {
        commands.push(command)
        if (command instanceof GetCommand) {
          return {
            Item: {
              workspaceId: 'workspace-1',
              recordKey: 'CONNECTORPOLL#installation-1#issue',
              entryType: 'connector-poll-checkpoint',
              value: {
                installationId: 'installation-1',
                resourceType: 'issue',
              },
              version: 3,
              cursorCiphertext: 'encrypted:cursor-3',
            },
          }
        }
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const contexts: string[] = []
    const store = new DynamoDbConnectorPollCheckpointStore({
      tableName: 'developer-platform',
      documentClient,
      secretProtector: {
        async protect(plaintext, context) {
          contexts.push(context)
          return `encrypted:${plaintext}`
        },
        async unprotect(ciphertext, context) {
          contexts.push(context)
          return ciphertext.replace('encrypted:', '')
        },
      },
    })

    await expect(store.get({
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      resourceType: 'issue',
    })).resolves.toEqual({ revision: 3, cursor: 'cursor-3' })
    await expect(store.compareAndSet({
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      resourceType: 'issue',
      expectedRevision: 3,
      nextCursor: 'cursor-4',
    })).resolves.toBe(true)

    expect(contexts).toEqual([
      'mukuroji:platform-state:connector-poll:v1\0workspace-1\0installation-1\0issue',
      'mukuroji:platform-state:connector-poll:v1\0workspace-1\0installation-1\0issue',
    ])
    const put = commands.find((command) => command instanceof PutCommand)
    expect(put).toBeInstanceOf(PutCommand)
    expect((put as PutCommand).input.Item).toMatchObject({
      version: 4,
      cursorCiphertext: 'encrypted:cursor-4',
    })
    expect(JSON.stringify((put as PutCommand).input.Item)).not.toContain('"cursor-4"')
  })

  test('returns false when a checkpoint CAS loses a race', async () => {
    const store = new DynamoDbConnectorPollCheckpointStore({
      tableName: 'developer-platform',
      documentClient: {
        async send() {
          throw Object.assign(new Error('conditional'), {
            name: 'ConditionalCheckFailedException',
          })
        },
      } as unknown as DynamoDBDocumentClient,
      secretProtector: {
        async protect(value) {
          return value
        },
        async unprotect(value) {
          return value
        },
      },
    })

    await expect(store.compareAndSet({
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      resourceType: 'issue',
    })).resolves.toBe(false)
  })

  test('queries sharded poll targets and strongly reads once per installation/resource', async () => {
    const activeInstallationId = 'installation-7'
    const inactiveInstallationId = 'installation-42'
    const shardLookupKey = createConnectorPollTargetShardLookupKey(0)
    const activeRecordKey = createConnectorPollTargetRecordKey(
      activeInstallationId,
      'issue',
    )
    const inactiveRecordKey = createConnectorPollTargetRecordKey(
      inactiveInstallationId,
      'issue',
    )
    const activeLookupSortKey = `workspace-1#${activeInstallationId}#issue`
    const inactiveLookupSortKey = `workspace-1#${inactiveInstallationId}#issue`
    const lastEvaluatedKey = {
      workspaceId: 'workspace-1',
      recordKey: inactiveRecordKey,
      lookupKey: shardLookupKey,
      lookupSortKey: inactiveLookupSortKey,
    }
    const queries: QueryCommand[] = []
    const gets: GetCommand[] = []
    const deletes: DeleteCommand[] = []
    const inventory = new DynamoDbConnectorPollInventory({
      tableName: 'developer-platform',
      lookupIndexName: 'LookupKeyIndex',
      documentClient: {
        async send(command: unknown) {
          if (command instanceof QueryCommand) {
            queries.push(command)
            if (queries.length > 1) return {}
            return {
              Items: [
                {
                  workspaceId: 'workspace-1',
                  recordKey: activeRecordKey,
                  lookupKey: shardLookupKey,
                  lookupSortKey: activeLookupSortKey,
                },
                {
                  workspaceId: 'workspace-1',
                  recordKey: inactiveRecordKey,
                  lookupKey: shardLookupKey,
                  lookupSortKey: inactiveLookupSortKey,
                },
              ],
              LastEvaluatedKey: lastEvaluatedKey,
            }
          }
          if (command instanceof GetCommand) {
            gets.push(command)
            const recordKey = command.input.Key?.recordKey
            const installationId = recordKey === activeRecordKey
              ? activeInstallationId
              : inactiveInstallationId
            return {
              Item: {
                workspaceId: 'workspace-1',
                recordKey,
                entryType: 'connector-poll-target',
                value: {
                  installationId,
                  resourceType: 'issue',
                },
                lookupKey: shardLookupKey,
                lookupSortKey: `workspace-1#${installationId}#issue`,
                pollableLinkCount: installationId === activeInstallationId ? 2 : 0,
                version: 1,
              },
            }
          }
          if (command instanceof DeleteCommand) {
            deletes.push(command)
            return {}
          }
          throw new Error('unexpected command')
        },
      } as unknown as DynamoDBDocumentClient,
    })

    const page = await inventory.listPollTargets()

    expect(page.targets).toEqual([{
      workspaceId: 'workspace-1',
      installationId: activeInstallationId,
      resourceType: 'issue',
    }])
    expect(page.nextCursor).toBeString()
    expect(gets).toHaveLength(2)
    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.input).toMatchObject({
      Key: {
        workspaceId: 'workspace-1',
        recordKey: inactiveRecordKey,
      },
      ConditionExpression: expect.stringContaining('pollableLinkCount = :zero'),
      ExpressionAttributeValues: {
        ':entryType': 'connector-poll-target',
        ':expectedVersion': 1,
        ':zero': 0,
      },
    })
    expect(gets.every((command) =>
      command.input.ConsistentRead === true &&
      String(command.input.Key?.recordKey).startsWith('CONNECTORPOLLTARGET#')
    )).toBe(true)
    expect(queries[0]?.input).toMatchObject({
      IndexName: 'LookupKeyIndex',
      ExpressionAttributeValues: {
        ':lookupKey': shardLookupKey,
      },
    })

    const sameShardContinuation = await inventory.listPollTargets(page.nextCursor)
    expect(sameShardContinuation.targets).toEqual([])
    expect(sameShardContinuation.nextCursor).toBeString()
    expect(queries[1]?.input).toMatchObject({
      ExclusiveStartKey: lastEvaluatedKey,
      ExpressionAttributeValues: { ':lookupKey': shardLookupKey },
    })

    await inventory.listPollTargets(sameShardContinuation.nextCursor)
    expect(queries[2]?.input.ExpressionAttributeValues).toEqual({
      ':lookupKey': createConnectorPollTargetShardLookupKey(1),
    })
  })

  test('rejects a poll target projected into the wrong shard', async () => {
    const installationId = 'installation-1'
    const recordKey = createConnectorPollTargetRecordKey(installationId, 'issue')
    const queriedLookupKey = createConnectorPollTargetShardLookupKey(0)
    expect(createConnectorPollTargetLookupKey(
      'workspace-1',
      installationId,
      'issue',
    )).not.toBe(queriedLookupKey)
    const inventory = new DynamoDbConnectorPollInventory({
      tableName: 'developer-platform',
      lookupIndexName: 'LookupKeyIndex',
      documentClient: {
        async send(command: unknown) {
          if (command instanceof QueryCommand) {
            return {
              Items: [{
                workspaceId: 'workspace-1',
                recordKey,
                lookupKey: queriedLookupKey,
                lookupSortKey: `workspace-1#${installationId}#issue`,
              }],
            }
          }
          if (command instanceof GetCommand) {
            return {
              Item: {
                workspaceId: 'workspace-1',
                recordKey,
                entryType: 'connector-poll-target',
                value: { installationId, resourceType: 'issue' },
                lookupKey: queriedLookupKey,
                lookupSortKey: `workspace-1#${installationId}#issue`,
                pollableLinkCount: 1,
                version: 1,
              },
            }
          }
          throw new Error('unexpected command')
        },
      } as unknown as DynamoDBDocumentClient,
    })

    await expect(inventory.listPollTargets()).rejects.toThrow(
      'Stored connector poll state is invalid.',
    )
  })
})
