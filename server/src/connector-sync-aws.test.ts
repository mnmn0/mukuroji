import { describe, expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import type { ExternalWorkItemLink } from '@mukuroji/contracts'
import {
  CONNECTOR_SYNC_LINK_INVENTORY_KEY,
  DynamoDbConnectorPollCheckpointStore,
  DynamoDbConnectorPollInventory,
} from './connector-sync-aws'

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

  test('queries the sparse link index and emits only current inbound targets', async () => {
    const inbound = createLink('link-inbound', 'inbound', 'pending')
    const outbound = createLink('link-outbound', 'outbound', 'pending')
    const queries: QueryCommand[] = []
    const inventory = new DynamoDbConnectorPollInventory({
      tableName: 'developer-platform',
      lookupIndexName: 'LookupKeyIndex',
      documentClient: {
        async send(command: unknown) {
          if (command instanceof QueryCommand) {
            queries.push(command)
            return {
              Items: [
                { workspaceId: 'workspace-1', recordKey: 'EXTERNALLINK#link-inbound' },
                { workspaceId: 'workspace-1', recordKey: 'EXTERNALLINK#link-outbound' },
              ],
              LastEvaluatedKey: {
                workspaceId: 'workspace-1',
                recordKey: 'EXTERNALLINK#link-outbound',
                lookupKey: CONNECTOR_SYNC_LINK_INVENTORY_KEY,
                lookupSortKey: 'workspace-1#link-outbound',
              },
            }
          }
          if (command instanceof GetCommand) {
            const recordKey = command.input.Key?.recordKey
            const link = recordKey === 'EXTERNALLINK#link-inbound' ? inbound : outbound
            return {
              Item: {
                workspaceId: 'workspace-1',
                recordKey,
                entryType: 'external-link',
                value: link,
                version: 1,
              },
            }
          }
          throw new Error('unexpected command')
        },
      } as unknown as DynamoDBDocumentClient,
    })

    const page = await inventory.listPollTargets()

    expect(page.targets).toEqual([{
      workspaceId: 'workspace-1',
      installationId: 'installation-1',
      resourceType: 'issue',
    }])
    expect(page.nextCursor).toBeString()
    expect(queries[0]?.input).toMatchObject({
      IndexName: 'LookupKeyIndex',
      ExpressionAttributeValues: {
        ':lookupKey': CONNECTOR_SYNC_LINK_INVENTORY_KEY,
      },
    })
  })
})

function createLink(
  id: string,
  syncDirection: ExternalWorkItemLink['syncDirection'],
  syncStatus: ExternalWorkItemLink['syncStatus'],
): ExternalWorkItemLink {
  return {
    id,
    teamId: 'team-1',
    workItemId: 'work-item-1',
    installationId: 'installation-1',
    resourceType: 'issue',
    externalId: `external-${id}`,
    externalUrl: `https://example.test/${id}`,
    syncDirection,
    syncStatus,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
}
