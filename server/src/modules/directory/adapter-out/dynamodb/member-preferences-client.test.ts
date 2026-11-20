import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { DynamoDbProjectDirectoryClient } from './project-directory-client'

/** Command input captured by the fake DynamoDB document client. */
type SentInput = Record<string, unknown>

/**
 * Creates a fake document client that answers each command with the next handler result.
 *
 * @param respond - Produces the response for one command input.
 * @returns The fake client and the inputs it received.
 */
function createDocumentClient(respond: (input: SentInput) => unknown) {
  const sentInputs: SentInput[] = []
  const documentClient = {
    async send(command: { input: SentInput }) {
      sentInputs.push(command.input)
      return respond(command.input)
    },
  } as unknown as DynamoDBDocumentClient
  return { documentClient, sentInputs }
}

/**
 * Creates a DynamoDB transaction cancellation caused by a failed condition.
 *
 * @returns An error shaped like the AWS SDK cancellation.
 */
function createConditionalTransactionCancellation() {
  return Object.assign(new Error('Transaction was canceled.'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  })
}

/**
 * Creates one stored member preference row.
 *
 * @param revision - Positive stored revision.
 * @param values - Stored preference fields.
 * @returns A storage row accepted by the directory client.
 */
function createStoredItem(revision: number, values: Record<string, unknown>) {
  return {
    directoryId: 'MEMBER_PREFERENCES#workspace%23one#demo%40example.com',
    entryKey: 'PREFERENCE',
    entryType: 'member-preferences',
    memberKey: 'demo@example.com',
    revision,
    updatedAt: '2026-11-19T00:00:00.000Z',
    workspaceId: 'workspace#one',
    ...values,
  }
}

test('returns revision zero when a member has saved no preferences', async () => {
  const { documentClient, sentInputs } = createDocumentClient(() => ({}))
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getMemberPreferences('workspace#one', 'demo@example.com', true))
    .resolves.toEqual({ revision: 0 })
  expect(sentInputs).toEqual([{
    ConsistentRead: true,
    Key: {
      directoryId: 'MEMBER_PREFERENCES#workspace%23one#demo%40example.com',
      entryKey: 'PREFERENCE',
    },
    TableName: 'DirectoryTable',
  }])
})

test('saves the first preferences only when no row exists and reads them back', async () => {
  let stored: Record<string, unknown> | undefined
  const { documentClient, sentInputs } = createDocumentClient((input) => {
    if ('TransactItems' in input) {
      stored = createStoredItem(1, { locale: 'en', theme: 'dark', timeZone: 'Asia/Tokyo' })
      return {}
    }
    return stored ? { Item: stored } : {}
  })
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.replaceMemberPreferences('workspace#one', 'demo@example.com', {
    locale: 'en',
    revision: 0,
    theme: 'dark',
    timeZone: 'Asia/Tokyo',
  })).resolves.toEqual({ locale: 'en', revision: 1, theme: 'dark', timeZone: 'Asia/Tokyo' })
  await expect(client.getMemberPreferences('workspace#one', 'demo@example.com'))
    .resolves.toEqual({ locale: 'en', revision: 1, theme: 'dark', timeZone: 'Asia/Tokyo' })
  expect(sentInputs[0]).toMatchObject({
    TransactItems: [{
      Put: {
        ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        Item: {
          directoryId: 'MEMBER_PREFERENCES#workspace%23one#demo%40example.com',
          entryKey: 'PREFERENCE',
          entryType: 'member-preferences',
          locale: 'en',
          memberKey: 'demo@example.com',
          revision: 1,
          theme: 'dark',
          timeZone: 'Asia/Tokyo',
          workspaceId: 'workspace#one',
        },
        TableName: 'DirectoryTable',
      },
    }],
  })
})

test('rejects a stale replacement with a conflict', async () => {
  const { documentClient, sentInputs } = createDocumentClient((input) => {
    if ('TransactItems' in input) throw createConditionalTransactionCancellation()
    return { Item: createStoredItem(3, { locale: 'ja' }) }
  })
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.replaceMemberPreferences('workspace#one', 'demo@example.com', {
    locale: 'en',
    revision: 1,
  })).rejects.toMatchObject({ code: 'MemberPreferencesConflict', status: 409 })
  expect(sentInputs[0]).toMatchObject({
    TransactItems: [{
      Put: {
        ExpressionAttributeValues: {
          ':entryType': 'member-preferences',
          ':expectedRevision': 1,
          ':memberKey': 'demo@example.com',
          ':workspaceId': 'workspace#one',
        },
      },
    }],
  })
  expect(sentInputs[1]).toMatchObject({ ConsistentRead: true })
})

test('treats a retried replacement that already committed as a success', async () => {
  const { documentClient } = createDocumentClient((input) => {
    if ('TransactItems' in input) throw createConditionalTransactionCancellation()
    return { Item: createStoredItem(2, { fontSize: 'compact' }) }
  })
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.replaceMemberPreferences('workspace#one', 'demo@example.com', {
    fontSize: 'compact',
    revision: 1,
  })).resolves.toEqual({ fontSize: 'compact', revision: 2 })
})

test('rejects invalid input before writing', async () => {
  const { documentClient, sentInputs } = createDocumentClient(() => ({}))
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.replaceMemberPreferences('workspace#one', 'demo@example.com', {
    revision: 0,
    timeZone: 'Mars/Olympus',
  })).rejects.toMatchObject({ code: 'InvalidMemberPreferencesInput', status: 400 })
  expect(sentInputs).toEqual([])
})

test('reports a stored row for another member as invalid data', async () => {
  const { documentClient } = createDocumentClient(() => ({
    Item: { ...createStoredItem(1, {}), memberKey: 'other@example.com' },
  }))
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getMemberPreferences('workspace#one', 'demo@example.com'))
    .rejects.toMatchObject({ code: 'InvalidMemberPreferences', status: 503 })
})
