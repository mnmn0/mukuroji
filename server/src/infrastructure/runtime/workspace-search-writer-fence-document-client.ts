import {
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import type { WorkspaceSearchWriterFenceAwsTableNames } from './workspace-search-writer-fence-aws'
import type { WorkspaceSearchWriterFenceGuardProvider } from './workspace-search-writer-fence-invocation'
import {
  prependWorkspaceSearchWriterFenceGuard,
  throwIfWorkspaceSearchWriterFenceBlocked,
  type WorkspaceSearchWriterFenceDocumentTransactionItem,
  WorkspaceSearchWriterFenceTransactionPreparationError,
} from './workspace-search-writer-fence-transaction'

/** Stable middleware name used to prevent accidental duplicate installation. */
const writerFenceDocumentClientMiddlewareName =
  'mukurojiWorkspaceSearchWriterFence'

/** Stable middleware name for the temporary fail-closed rollout bridge. */
const writerFenceRolloutPendingDocumentClientMiddlewareName =
  'mukurojiWorkspaceSearchWriterFenceRolloutPending'

/** Complete stable error-code set owned by the application writer fence. */
const workspaceSearchWriterFenceTerminalErrorCodes = new Set([
  'INVALID_WORKSPACE_SEARCH_WRITER_FENCE',
  'INVALID_WORKSPACE_SEARCH_WRITER_FENCE_TRANSACTION',
  'UNCLASSIFIED_WORKSPACE_SEARCH_WRITER_FENCE_TRANSACTION',
  'WORKSPACE_SEARCH_WRITER_FENCE_BLOCKED',
  'WORKSPACE_SEARCH_WRITER_FENCE_INVOCATION_SCOPE_REQUIRED',
  'WORKSPACE_SEARCH_WRITER_FENCE_INVOCATION_SOURCE_MISMATCH',
  'WORKSPACE_SEARCH_WRITER_FENCE_ROLLOUT_PENDING',
  'WORKSPACE_SEARCH_WRITER_FENCE_UNAVAILABLE',
])

/**
 * Stable failure raised when a fenced mutation reaches the temporary
 * pre-bootstrap rollout mode.
 */
export class WorkspaceSearchWriterFenceRolloutPendingError extends Error {
  /** Machine-readable raw-value-free failure code. */
  readonly code = 'WORKSPACE_SEARCH_WRITER_FENCE_ROLLOUT_PENDING'

  /**
   * Creates one fail-closed rollout-pending failure.
   */
  constructor() {
    super('WORKSPACE_SEARCH_WRITER_FENCE_ROLLOUT_PENDING')
    this.name = 'WorkspaceSearchWriterFenceRolloutPendingError'
  }
}

/**
 * Stable failure raised when DynamoDB does not expose a classifiable guarded
 * transaction outcome.
 */
export class WorkspaceSearchWriterFenceTransactionOutcomeError extends Error {
  /** Machine-readable raw-value-free failure code. */
  readonly code = 'UNCLASSIFIED_WORKSPACE_SEARCH_WRITER_FENCE_TRANSACTION'

  /**
   * Creates one fail-closed transaction outcome failure.
   */
  constructor() {
    super('UNCLASSIFIED_WORKSPACE_SEARCH_WRITER_FENCE_TRANSACTION')
    this.name = 'WorkspaceSearchWriterFenceTransactionOutcomeError'
  }
}

/**
 * Preserves every stable terminal writer-fence error across adapter mappers.
 *
 * @param error - Unknown adapter failure.
 */
export function throwIfWorkspaceSearchWriterFenceTerminalError(
  error: unknown,
): void {
  const code = isRecord(error) ? Reflect.get(error, 'code') : undefined
  if (
    typeof code === 'string' &&
    workspaceSearchWriterFenceTerminalErrorCodes.has(code)
  ) {
    throw error
  }
}

/**
 * Installs guard-first preparation on transactions that mutate a fenced table.
 *
 * Transactions that only read fenced tables through ConditionCheck, and
 * transactions that mutate unrelated tables, retain their original shape.
 * Application cancellation reason indices are restored before the error
 * reaches existing adapter classifiers.
 *
 * @param client - Document client used by one application writer.
 * @param provider - Process-stable provider shared by the invocation.
 * @param tableNames - Exact six-table configuration measured by the provider.
 * @param additionalFencedMutationTableNames - Additional rollback-owned tables
 * whose mutations must participate in the same durable guard.
 * @returns The same configured document client.
 */
export function bindWorkspaceSearchWriterFenceDocumentClient(
  client: DynamoDBDocumentClient,
  provider: WorkspaceSearchWriterFenceGuardProvider,
  tableNames: WorkspaceSearchWriterFenceAwsTableNames,
  additionalFencedMutationTableNames: readonly string[] = [],
): DynamoDBDocumentClient {
  const fencedMutationTableNames = new Set([
    tableNames['project-directory'],
    tableNames['work-items'],
    tableNames.collaboration,
    tableNames.documents,
    tableNames['workspace-search'],
  ])
  for (const tableName of additionalFencedMutationTableNames) {
    if (tableName.length === 0 || tableName.trim() !== tableName) {
      throw new WorkspaceSearchWriterFenceTransactionPreparationError()
    }
    fencedMutationTableNames.add(tableName)
  }

  client.middlewareStack.add(
    (next, context) => async (arguments_) => {
      if (context.commandName !== 'TransactWriteItemsCommand') {
        if (
          commandCanMutateFencedTable(
            context.commandName,
            arguments_.input,
            fencedMutationTableNames,
          )
        ) {
          throw new WorkspaceSearchWriterFenceTransactionPreparationError()
        }
        return await next(arguments_)
      }
      const applicationItems = readApplicationTransactionItems(
        arguments_.input,
        fencedMutationTableNames,
      )
      if (
        !applicationItems ||
        !applicationItems.some((item) =>
          transactionItemMutatesTable(item, fencedMutationTableNames)
        )
      ) {
        return await next(arguments_)
      }

      const material = await provider.get()
      const guarded = prependWorkspaceSearchWriterFenceGuard(
        material,
        applicationItems,
      )
      const input: TransactWriteCommandInput = {
        ...arguments_.input,
        TransactItems: guarded.transactItems,
      }

      try {
        return await next({
          ...arguments_,
          input,
        })
      } catch (error: unknown) {
        throwIfWorkspaceSearchWriterFenceBlocked(error)
        throw restoreApplicationTransactionCancellation(
          error,
          applicationItems.length,
        )
      }
    },
    {
      name: writerFenceDocumentClientMiddlewareName,
      override: false,
      step: 'initialize',
    },
  )
  return client
}

/**
 * Blocks every mutation to a fenced table during the temporary rollout bridge.
 *
 * This code-level barrier prevents an accidental AppConfig re-enable from
 * admitting unguarded writes before the durable guard row is bootstrapped.
 * Reads and mutations to unrelated tables retain their original behavior.
 *
 * @param client - Document client used by one application writer.
 * @param tableNames - Exact six-table production configuration.
 * @returns The same fail-closed configured document client.
 */
export function bindWorkspaceSearchWriterFenceRolloutPendingDocumentClient(
  client: DynamoDBDocumentClient,
  tableNames: WorkspaceSearchWriterFenceAwsTableNames,
): DynamoDBDocumentClient {
  const fencedMutationTableNames = new Set([
    tableNames['project-directory'],
    tableNames['work-items'],
    tableNames.collaboration,
    tableNames.documents,
    tableNames['workspace-search'],
  ])

  client.middlewareStack.add(
    (next, context) => async (arguments_) => {
      if (context.commandName === 'TransactWriteItemsCommand') {
        const applicationItems = readApplicationTransactionItems(
          arguments_.input,
          fencedMutationTableNames,
        )
        if (
          applicationItems?.some((item) =>
            transactionItemMutatesTable(item, fencedMutationTableNames)
          )
        ) {
          throw new WorkspaceSearchWriterFenceRolloutPendingError()
        }
      } else if (
        commandCanMutateFencedTable(
          context.commandName,
          arguments_.input,
          fencedMutationTableNames,
        )
      ) {
        throw new WorkspaceSearchWriterFenceRolloutPendingError()
      }
      return await next(arguments_)
    },
    {
      name: writerFenceRolloutPendingDocumentClientMiddlewareName,
      override: false,
      step: 'initialize',
    },
  )
  return client
}

/**
 * Detects write commands that cannot carry the required guard transaction.
 *
 * Direct and batch writes to a fenced table are rejected. PartiQL commands are
 * rejected wholesale because their target table cannot be established without
 * implementing the complete DynamoDB PartiQL grammar.
 *
 * @param commandName - Smithy command name selected by the caller.
 * @param input - Smithy command input.
 * @param tableNames - Exact fenced mutation table names.
 * @returns Whether the command must fail before serialization.
 */
function commandCanMutateFencedTable(
  commandName: string | undefined,
  input: object,
  tableNames: ReadonlySet<string>,
): boolean {
  if (
    commandName === 'ExecuteStatementCommand' ||
    commandName === 'BatchExecuteStatementCommand' ||
    commandName === 'ExecuteTransactionCommand'
  ) {
    return true
  }
  if (
    commandName === 'PutCommand' ||
    commandName === 'UpdateCommand' ||
    commandName === 'DeleteCommand' ||
    commandName === 'PutItemCommand' ||
    commandName === 'UpdateItemCommand' ||
    commandName === 'DeleteItemCommand'
  ) {
    const tableName = Reflect.get(input, 'TableName')
    return tableNameNeedsWriterFence(tableName, tableNames)
  }
  if (
    commandName !== 'BatchWriteCommand' &&
    commandName !== 'BatchWriteItemCommand'
  ) return false
  const requestItems = Reflect.get(input, 'RequestItems')
  if (!isRecord(requestItems)) return false
  return Object.entries(requestItems).some(
    ([tableName, requests]) =>
      tableNameNeedsWriterFence(tableName, tableNames) &&
      Array.isArray(requests) &&
      requests.length > 0,
  )
}

/**
 * Reads native DocumentClient transaction items from an unknown command input.
 *
 * @param input - Smithy command input.
 * @param fencedTableNames - Exact fenced mutation table names.
 * @returns Transaction items, or undefined for a different input shape.
 */
function readApplicationTransactionItems(
  input: object,
  fencedTableNames: ReadonlySet<string>,
): readonly WorkspaceSearchWriterFenceDocumentTransactionItem[] | undefined {
  const items = Reflect.get(input, 'TransactItems')
  if (!Array.isArray(items)) {
    return undefined
  }
  if (!items.every(isWorkspaceSearchWriterFenceDocumentTransactionItem)) {
    if (
      items.some((item) =>
        candidateTransactionItemMutatesTable(item, fencedTableNames)
      )
    ) {
      throw new WorkspaceSearchWriterFenceTransactionPreparationError()
    }
    return undefined
  }
  return items
}

/**
 * Detects a potentially serializable fenced mutation in an untrusted item.
 *
 * AWS SDK serialization ignores unknown top-level members. Therefore an item
 * that contains a valid covered mutation plus an extra member must not bypass
 * the strict shape check and reach DynamoDB without a guard.
 *
 * @param value - Candidate transaction item.
 * @param tableNames - Exact fenced mutation table names.
 * @returns Whether a known mutation member targets a fenced table.
 */
function candidateTransactionItemMutatesTable(
  value: unknown,
  tableNames: ReadonlySet<string>,
): boolean {
  if (!isRecord(value)) return false
  for (const actionName of ['Delete', 'Put', 'Update'] as const) {
    const action = Reflect.get(value, actionName)
    const tableName = isRecord(action)
      ? Reflect.get(action, 'TableName')
      : undefined
    if (tableNameNeedsWriterFence(tableName, tableNames)) return true
  }
  return false
}

/**
 * Checks the exact top-level shape of one DocumentClient transaction item.
 *
 * @param value - Candidate transaction item.
 * @returns Whether exactly one supported action is present.
 */
function isWorkspaceSearchWriterFenceDocumentTransactionItem(
  value: unknown,
): value is WorkspaceSearchWriterFenceDocumentTransactionItem {
  if (!isRecord(value)) return false
  const actionNames: readonly string[] = [
    'ConditionCheck',
    'Delete',
    'Put',
    'Update',
  ]
  const presentActions = actionNames.filter(
    (actionName) => Reflect.get(value, actionName) !== undefined,
  )
  return presentActions.length === 1 &&
    isRecord(Reflect.get(value, presentActions[0])) &&
    Object.keys(value).every((key) => actionNames.includes(key))
}

/**
 * Determines whether one transaction item mutates an exact fenced table.
 *
 * @param item - Strict top-level transaction item.
 * @param tableNames - Exact fenced mutation table names.
 * @returns Whether the item contains Put, Update, or Delete on a fenced table.
 */
function transactionItemMutatesTable(
  item: WorkspaceSearchWriterFenceDocumentTransactionItem,
  tableNames: ReadonlySet<string>,
): boolean {
  for (const actionName of ['Delete', 'Put', 'Update'] as const) {
    const action = item[actionName]
    if (
      action &&
      tableNameNeedsWriterFence(action.TableName, tableNames)
    ) return true
  }
  return false
}

/**
 * Treats an exact fenced name or any table ARN as requiring the fence.
 *
 * DynamoDB accepts table ARNs anywhere it accepts a table name. Without the
 * conservative ARN rule, the same physical table could evade name comparison.
 *
 * @param value - Candidate table name or ARN.
 * @param tableNames - Exact configured fenced table names.
 * @returns Whether the mutation must be guarded or rejected.
 */
function tableNameNeedsWriterFence(
  value: unknown,
  tableNames: ReadonlySet<string>,
): boolean {
  return typeof value === 'string' &&
    (tableNames.has(value) || value.startsWith('arn:'))
}

/**
 * Removes the reserved guard cancellation reason before existing classifiers.
 *
 * @param error - DynamoDB transaction failure.
 * @param applicationItemCount - Exact number of application transaction items.
 * @returns Original error with application-relative cancellation reasons.
 */
function restoreApplicationTransactionCancellation(
  error: unknown,
  applicationItemCount: number,
): unknown {
  if (
    !isRecord(error) ||
    Reflect.get(error, 'name') !== 'TransactionCanceledException'
  ) {
    return error
  }
  const reasons = Reflect.get(error, 'CancellationReasons')
  if (
    !Array.isArray(reasons) ||
    reasons.length !== applicationItemCount + 1
  ) {
    throw new WorkspaceSearchWriterFenceTransactionOutcomeError()
  }
  const guardReason = reasons[0]
  if (
    !isRecord(guardReason) ||
    Reflect.get(guardReason, 'Code') !== 'None'
  ) {
    throw new WorkspaceSearchWriterFenceTransactionOutcomeError()
  }
  const applicationReasons = reasons.slice(1)
  if (
    !applicationReasons.every((reason) =>
      isRecord(reason) &&
      typeof Reflect.get(reason, 'Code') === 'string'
    )
  ) {
    throw new WorkspaceSearchWriterFenceTransactionOutcomeError()
  }
  if (
    !Reflect.set(error, 'CancellationReasons', applicationReasons) ||
    Reflect.get(error, 'CancellationReasons') !== applicationReasons
  ) {
    throw new WorkspaceSearchWriterFenceTransactionOutcomeError()
  }
  return error
}

/**
 * Determines whether one value is a non-array object.
 *
 * @param value - Candidate value.
 * @returns Whether the value supports safe reflection.
 */
function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
