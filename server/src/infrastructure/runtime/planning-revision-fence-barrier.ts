import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

/** Stable middleware name used to reject direct Planning fence writes. */
const planningRevisionFenceBarrierMiddlewareName =
  'mukurojiPlanningRevisionFenceBarrier'

/** Physical Planning META record key shared by the legacy and fenced rows. */
const planningMetaRecordKey = 'META'

/** Prefix identifying the isolated Planning revision-fence partition. */
const planningFenceWorkspacePrefix = 'FENCE#'

/** Stable failure raised when a Planning fence write bypasses the transaction boundary. */
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
 * Rejects direct writes to isolated FENCE META rows that cannot establish a revision CAS.
 *
 * Legacy META rows are retained as inert compatibility data after fence initialization, so
 * normal transactions no longer need a broad table-wide condition check or delete capability.
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
      if (context.commandName === 'TransactWriteItemsCommand') return await next(arguments_)
      if (commandCanMutatePlanningFence(context.commandName, arguments_.input, tableName)) {
        throw new PlanningRevisionFenceBarrierError()
      }
      return await next(arguments_)
    },
    {
      name: planningRevisionFenceBarrierMiddlewareName,
      override: false,
      step: 'initialize',
    },
  )
  return client
}

/** Detects direct writes that cannot carry the Planning revision CAS. */
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
