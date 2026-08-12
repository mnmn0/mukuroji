import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, spyOn, test } from 'bun:test'
import {
  bindPlanningRevisionFenceBarrierDocumentClient,
  PlanningRevisionFenceBarrierError,
} from './planning-revision-fence-barrier'

/** Creates a deterministic client harness for the Planning migration barrier. */
function createMiddlewareHarness() {
  const lowLevelClient = new DynamoDBClient({
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
    region: 'ap-northeast-1',
  })
  const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
  let registeredMiddleware: unknown
  const addSpy = spyOn(documentClient.middlewareStack, 'add')
  addSpy.mockImplementation((middleware: unknown) => {
    registeredMiddleware = middleware
  })
  bindPlanningRevisionFenceBarrierDocumentClient(documentClient, 'PlanningTable')
  addSpy.mockRestore()

  if (typeof registeredMiddleware !== 'function') {
    throw new Error('Expected the Planning migration barrier middleware.')
  }
  const middleware = registeredMiddleware

  /**
   * Invokes the captured initialize middleware without contacting DynamoDB.
   *
   * @param input - Smithy command input presented to the middleware.
   * @param commandName - Smithy command name used by the input.
   * @returns Inputs forwarded to the downstream handler.
   */
  async function invoke(input: object, commandName = 'TransactWriteItemsCommand') {
    const forwardedInputs: object[] = []
    async function next(arguments_: { input: object }) {
      forwardedInputs.push(arguments_.input)
      return { output: {}, response: {} }
    }
    const initialized: unknown = Reflect.apply(
      middleware,
      undefined,
      [next, { commandName }],
    )
    if (typeof initialized !== 'function') {
      throw new Error('Expected an initialized Planning migration barrier.')
    }
    await Reflect.apply(initialized, undefined, [{ input }])
    return forwardedInputs
  }

  return {
    destroy: () => documentClient.destroy(),
    invoke,
  }
}

test('adds a legacy META absence check to normal fenced transactions', async () => {
  const harness = createMiddlewareHarness()
  try {
    const forwarded = await harness.invoke({
      TransactItems: [
        {
          Update: {
            TableName: 'PlanningTable',
            Key: { workspaceId: 'FENCE#workspace-1', recordKey: 'META' },
            UpdateExpression: 'ADD #revision :increment',
            ExpressionAttributeNames: { '#revision': 'revision' },
            ExpressionAttributeValues: { ':increment': 1 },
          },
        },
      ],
    })

    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]).toMatchObject({
      TransactItems: [
        expect.objectContaining({ Update: expect.any(Object) }),
        {
          ConditionCheck: {
            TableName: 'PlanningTable',
            Key: { workspaceId: 'workspace-1', recordKey: 'META' },
            ConditionExpression:
              'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
          },
        },
      ],
    })
  } finally {
    harness.destroy()
  }
})

test('does not add a second barrier to the legacy-to-fence migration transaction', async () => {
  const harness = createMiddlewareHarness()
  try {
    const forwarded = await harness.invoke({
      TransactItems: [
        {
          Delete: {
            TableName: 'PlanningTable',
            Key: { workspaceId: 'workspace-1', recordKey: 'META' },
            ConditionExpression: '#revision = :revision',
            ExpressionAttributeNames: { '#revision': 'revision' },
            ExpressionAttributeValues: { ':revision': 7 },
          },
        },
        {
          Put: {
            TableName: 'PlanningTable',
            Item: {
              workspaceId: 'FENCE#workspace-1',
              recordKey: 'META',
              revision: 7,
            },
          },
        },
      ],
    })

    expect(forwarded[0]).toMatchObject({
      TransactItems: expect.arrayContaining([
        expect.objectContaining({ Delete: expect.any(Object) }),
        expect.objectContaining({ Put: expect.any(Object) }),
      ]),
    })
    expect(forwarded[0]).not.toMatchObject({
      TransactItems: expect.arrayContaining([
        expect.objectContaining({ ConditionCheck: expect.any(Object) }),
      ]),
    })
  } finally {
    harness.destroy()
  }
})

test('rejects direct fenced META writes that cannot carry the migration barrier', async () => {
  const harness = createMiddlewareHarness()
  try {
    await expect(harness.invoke({
      TableName: 'PlanningTable',
      Item: { workspaceId: 'FENCE#workspace-1', recordKey: 'META', revision: 1 },
    }, 'PutCommand')).rejects.toBeInstanceOf(PlanningRevisionFenceBarrierError)
  } finally {
    harness.destroy()
  }
})
