import type {
  DynamoDBDocumentClient,
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'

/** Native-value transaction item accepted by DynamoDBDocumentClient. */
type PlanningRevisionFenceTransactionItem = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number]

/** Stable middleware name used to install the Planning migration barrier once. */
const planningRevisionFenceBarrierMiddlewareName =
  'mukurojiPlanningRevisionFenceBarrier'

/** Physical Planning META record key shared by the legacy and fenced rows. */
const planningMetaRecordKey = 'META'

/** Prefix identifying the isolated Planning revision-fence partition. */
const planningFenceWorkspacePrefix = 'FENCE#'

/** Maximum number of DynamoDB transaction actions after barrier checks are added. */
const dynamoDbTransactionItemLimit = 100

/** Stable failure raised when a Planning fence transaction cannot reserve a barrier check. */
export class PlanningRevisionFenceBarrierError extends Error {
  /** Machine-readable raw-value-free failure code. */
  readonly code = 'PLANNING_REVISION_FENCE_BARRIER_REQUIRED'

  /** Creates one fail-closed Planning migration-barrier failure. */
  constructor() {
    super('PLANNING_REVISION_FENCE_BARRIER_REQUIRED')
    this.name = 'PlanningRevisionFenceBarrierError'
  }
}

/**
 * Adds a legacy-META absence check to every normal FENCE-only transaction.
 *
 * The migration transaction itself contains a legacy META mutation and is left
 * untouched; it is the only operation allowed to retire that row. All other
 * fenced writes are therefore blocked until the migration barrier has won.
 *
 * @param client - Document client used by the application writer.
 * @param planningTableName - Exact physical Planning table name.
 * @returns The same client with the fail-closed barrier installed.
 */
export function bindPlanningRevisionFenceBarrierDocumentClient(
  client: DynamoDBDocumentClient,
  planningTableName: string | undefined,
): DynamoDBDocumentClient {
  const tableName = planningTableName?.trim()
  if (!tableName) return client

  client.middlewareStack.add(
    (next, context) => async (arguments_) => {
      if (context.commandName !== 'TransactWriteItemsCommand') {
        if (commandCanMutatePlanningFence(context.commandName, arguments_.input, tableName)) {
          throw new PlanningRevisionFenceBarrierError()
        }
        return await next(arguments_)
      }

      const transactionItems = readTransactionItems(arguments_.input)
      if (!transactionItems) return await next(arguments_)

      const fenceWorkspaces = new Set<string>()
      const barrierWorkspaces = new Set<string>()
      for (const item of transactionItems) {
        const mutation = readPlanningMetaMutation(item, tableName)
        if (mutation === undefined) continue
        if (mutation.fenced) fenceWorkspaces.add(mutation.workspaceId)
        if (mutation.legacy) barrierWorkspaces.add(mutation.workspaceId)
      }

      const guardedWorkspaces = [...fenceWorkspaces].filter(
        (workspaceId) => !barrierWorkspaces.has(workspaceId),
      )
      if (guardedWorkspaces.length === 0) return await next(arguments_)
      if (transactionItems.length + guardedWorkspaces.length > dynamoDbTransactionItemLimit) {
        throw new PlanningRevisionFenceBarrierError()
      }

      const barrierChecks = guardedWorkspaces.map((workspaceId) => ({
        ConditionCheck: {
          TableName: tableName,
          Key: { workspaceId, recordKey: planningMetaRecordKey },
          ConditionExpression:
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        },
      }))
      const input: TransactWriteCommandInput = {
        ...arguments_.input,
        TransactItems: [...transactionItems, ...barrierChecks],
      }
      return await next({ ...arguments_, input })
    },
    {
      name: planningRevisionFenceBarrierMiddlewareName,
      override: false,
      step: 'initialize',
    },
  )
  return client
}

/** Reads a native transaction item array from an SDK command input. */
function readTransactionItems(
  input: object,
): readonly PlanningRevisionFenceTransactionItem[] | undefined {
  const items = Reflect.get(input, 'TransactItems')
  if (!Array.isArray(items)) return undefined
  if (!items.every(isTransactionItem)) return undefined
  return items
}

/** Checks the exact top-level shape required for one transaction item. */
function isTransactionItem(
  value: unknown,
): value is PlanningRevisionFenceTransactionItem {
  if (!isRecord(value)) return false
  const actionNames = ['ConditionCheck', 'Delete', 'Put', 'Update'] as const
  const knownActionNames: ReadonlySet<string> = new Set(actionNames)
  const presentActions = actionNames.filter(
    (actionName) => Reflect.get(value, actionName) !== undefined,
  )
  return presentActions.length === 1 &&
    isRecord(Reflect.get(value, presentActions[0])) &&
    Object.keys(value).every((key) => knownActionNames.has(key))
}

/**
 * Finds a Planning META mutation in one transaction item.
 *
 * @param item - Validated native DynamoDB transaction item.
 * @param tableName - Exact Planning table name.
 * @returns The physical Workspace and whether the item is legacy or fenced.
 */
function readPlanningMetaMutation(
  item: PlanningRevisionFenceTransactionItem,
  tableName: string,
): { workspaceId: string; fenced: boolean; legacy: boolean } | undefined {
  const actionNames = ['Delete', 'Put', 'Update'] as const
  for (const actionName of actionNames) {
    const action = item[actionName]
    if (!action || action.TableName !== tableName) continue
    const key = Reflect.get(action, actionName === 'Put' ? 'Item' : 'Key')
    if (!isRecord(key) || key.recordKey !== planningMetaRecordKey) continue
    const workspaceId = key.workspaceId
    if (typeof workspaceId !== 'string') continue
    if (workspaceId.startsWith(planningFenceWorkspacePrefix)) {
      return {
        workspaceId: workspaceId.slice(planningFenceWorkspacePrefix.length),
        fenced: true,
        legacy: false,
      }
    }
    return { workspaceId, fenced: false, legacy: true }
  }
  return undefined
}

/** Detects direct writes that cannot carry the migration barrier check. */
function commandCanMutatePlanningFence(
  commandName: string | undefined,
  input: object,
  tableName: string,
): boolean {
  if (
    commandName === 'ExecuteStatementCommand' ||
    commandName === 'BatchExecuteStatementCommand' ||
    commandName === 'ExecuteTransactionCommand' ||
    commandName === 'BatchWriteItemCommand'
  ) {
    return true
  }
  if (
    commandName !== 'PutCommand' &&
    commandName !== 'UpdateCommand' &&
    commandName !== 'DeleteCommand' &&
    commandName !== 'PutItemCommand' &&
    commandName !== 'UpdateItemCommand' &&
    commandName !== 'DeleteItemCommand'
  ) return false
  if (Reflect.get(input, 'TableName') !== tableName) return false
  const key = commandName === 'PutCommand' || commandName === 'PutItemCommand'
    ? Reflect.get(input, 'Item')
    : Reflect.get(input, 'Key')
  return isRecord(key) &&
    key.recordKey === planningMetaRecordKey &&
    typeof key.workspaceId === 'string' &&
    key.workspaceId.startsWith(planningFenceWorkspacePrefix)
}

/** Narrows values to non-array records without trusting their fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
