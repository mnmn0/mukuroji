import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { EnterpriseIdentityError } from '../../errors'
import type {
  EnterpriseGenerationCommitter,
} from '../../application/ports/enterprise-generation-committer'
import {
  EnterpriseGenerationCommitConflictError,
} from '../../application/ports/enterprise-generation-committer'

/** DynamoDB transaction item accepted by the generation committer. */
type EnterpriseDynamoTransactionItem = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number]

/** Checkpoint identity used to make an ambiguous generation commit recoverable. */
type EnterpriseGenerationCheckpoint = {
  /** Workspace CONTROL partition key. */
  scopeKey: string
  /** Canonical CONTROL record key. */
  recordKey: 'CONTROL'
  /** Canonical workspace identifier. */
  workspaceId: string
  /** Storage revision published by this transaction. */
  controlRevision: number
  /** Immutable generation identifier and DynamoDB idempotency token. */
  stateGeneration: string
}

/** Output adapter that owns immutable generation staging and the atomic CONTROL transaction. */
export class DynamoDbEnterpriseGenerationCommitter implements
  EnterpriseGenerationCommitter<EnterpriseDynamoTransactionItem>
{
  /** Enterprise Identity table name. */
  private readonly tableName: string
  /** DynamoDB document client used for staging and checkpoint commits. */
  private readonly documentClient: DynamoDBDocumentClient

  /**
   * Creates a DynamoDB generation committer.
   *
   * @param tableName - Enterprise Identity table name.
   * @param documentClient - DynamoDB document client.
   */
  constructor(tableName: string, documentClient: DynamoDBDocumentClient) {
    const normalizedTableName = tableName.trim()
    if (!normalizedTableName) {
      throw new EnterpriseIdentityError(
        503,
        'EnterpriseIdentityUnavailable',
        'Enterprise identity state is unavailable.',
        true,
      )
    }
    this.tableName = normalizedTableName
    this.documentClient = documentClient
  }

  /**
   * Stages an immutable generation and commits its CONTROL, projection, and audit transaction.
   *
   * @param stagedItems - Immutable generation items not yet referenced by CONTROL.
   * @param transactItems - DynamoDB writes included in the atomic checkpoint.
   * @returns A promise that resolves when the checkpoint commits.
   */
  async commit(
    stagedItems: Record<string, unknown>[],
    transactItems: EnterpriseDynamoTransactionItem[],
  ): Promise<void> {
    if (transactItems.length > 100) {
      throw new EnterpriseIdentityError(
        413,
        'EnterpriseIdentityMutationTooLarge',
        'This mutation changes too many enterprise records for one atomic checkpoint.',
      )
    }
    const checkpoint = readGenerationCheckpoint(transactItems)
    await this.stageGeneration(stagedItems)
    let transactionError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: transactItems,
          ClientRequestToken: checkpoint.stateGeneration,
        }))
        return
      } catch (error) {
        transactionError = error
        if (isDefinitiveTransactionRejection(error)) break
      }
    }

    if (isDefinitiveTransactionRejection(transactionError)) {
      await this.cleanupGeneration(stagedItems)
      const conflictingOperationIndexes = readConditionalConflictIndexes(transactionError)
      if (conflictingOperationIndexes) {
        throw new EnterpriseGenerationCommitConflictError(
          conflictingOperationIndexes,
          transactionError,
        )
      }
      throw toEnterprisePersistenceError(transactionError)
    }

    try {
      if (await this.isCheckpointCommitted(checkpoint)) return
    } catch (verificationError) {
      throw toEnterprisePersistenceError(new AggregateError(
        [transactionError, verificationError],
        'Enterprise identity generation commit outcome is unknown.',
      ))
    }

    // An opaque timeout can still complete after this strongly consistent read. Leaving an
    // unreachable UUID generation is safer than deleting records a late CONTROL commit may use.
    throw toEnterprisePersistenceError(transactionError)
  }

  /** Returns whether CONTROL proves that an ambiguously acknowledged generation committed. */
  private async isCheckpointCommitted(
    checkpoint: EnterpriseGenerationCheckpoint,
  ): Promise<boolean> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: checkpoint.scopeKey,
        recordKey: checkpoint.recordKey,
      },
      ConsistentRead: true,
    }))
    const item: unknown = response.Item
    if (!isUnknownRecord(item)) return false
    const activeGenerations = Array.isArray(item.activeStateGenerations)
      ? item.activeStateGenerations
      : []
    const retiredGenerations = Array.isArray(item.retiredStateGenerations)
      ? item.retiredStateGenerations
      : []
    return item.workspaceId === checkpoint.workspaceId &&
      typeof item.controlRevision === 'number' &&
      item.controlRevision >= checkpoint.controlRevision &&
      (
        item.activeStateGeneration === checkpoint.stateGeneration ||
        activeGenerations.includes(checkpoint.stateGeneration) ||
        retiredGenerations.some((generation) =>
          isUnknownRecord(generation) &&
          generation.stateGeneration === checkpoint.stateGeneration
        )
      )
  }

  /** Stages immutable generation records in bounded DynamoDB batches. */
  private async stageGeneration(items: Record<string, unknown>[]): Promise<void> {
    try {
      for (let offset = 0; offset < items.length; offset += 25) {
        let pending: NonNullable<BatchWriteCommandInput['RequestItems']>[string] =
          items.slice(offset, offset + 25).map((item) => ({
            PutRequest: { Item: item },
          }))
        for (let attempt = 0; pending.length > 0 && attempt < 5; attempt += 1) {
          const response = await this.documentClient.send(new BatchWriteCommand({
            RequestItems: { [this.tableName]: pending },
          }))
          pending = response.UnprocessedItems?.[this.tableName] ?? []
        }
        if (pending.length > 0) {
          throw new EnterpriseIdentityError(
            503,
            'EnterpriseIdentityUnavailable',
            'Enterprise identity state is unavailable.',
            true,
          )
        }
      }
    } catch (error) {
      await this.cleanupGeneration(items)
      if (error instanceof EnterpriseIdentityError) throw error
      throw toEnterprisePersistenceError(error)
    }
  }

  /** Removes known keys for an uncommitted generation on a best-effort basis. */
  private async cleanupGeneration(items: Record<string, unknown>[]): Promise<void> {
    try {
      for (let offset = 0; offset < items.length; offset += 25) {
        let pending: NonNullable<BatchWriteCommandInput['RequestItems']>[string] =
          items.slice(offset, offset + 25).map((item) => ({
            DeleteRequest: {
              Key: {
                scopeKey: item.scopeKey,
                recordKey: item.recordKey,
              },
            },
          }))
        for (let attempt = 0; pending.length > 0 && attempt < 3; attempt += 1) {
          const response = await this.documentClient.send(new BatchWriteCommand({
            RequestItems: { [this.tableName]: pending },
          }))
          pending = response.UnprocessedItems?.[this.tableName] ?? []
        }
      }
    } catch {
      // Orphaned UUID partitions are invisible unless CONTROL points to them.
    }
  }
}

/** Extracts the CONTROL checkpoint from the generated transaction. */
function readGenerationCheckpoint(
  transactItems: NonNullable<TransactWriteCommandInput['TransactItems']>,
): EnterpriseGenerationCheckpoint {
  for (const transactItem of transactItems) {
    const item: unknown = transactItem.Put?.Item
    if (
      isUnknownRecord(item) &&
      typeof item.scopeKey === 'string' &&
      item.recordKey === 'CONTROL' &&
      typeof item.workspaceId === 'string' &&
      typeof item.controlRevision === 'number' &&
      Number.isSafeInteger(item.controlRevision) &&
      typeof item.activeStateGeneration === 'string' &&
      /^[0-9a-f-]{36}$/u.test(item.activeStateGeneration)
    ) {
      return {
        scopeKey: item.scopeKey,
        recordKey: 'CONTROL',
        workspaceId: item.workspaceId,
        controlRevision: item.controlRevision,
        stateGeneration: item.activeStateGeneration,
      }
    }
  }
  throw new EnterpriseIdentityError(
    503,
    'EnterpriseIdentityStateInvalid',
    'Enterprise identity generation checkpoint is invalid.',
  )
}

/** Returns whether DynamoDB definitively rejected the transaction without committing it. */
function isDefinitiveTransactionRejection(error: unknown): boolean {
  return error instanceof Error &&
    (
      error.name === 'ConditionalCheckFailedException' ||
      error.name === 'TransactionCanceledException' ||
      error.name === 'ValidationException' ||
      error.name === 'IdempotentParameterMismatchException'
    )
}

/** Returns the transaction indexes containing only conditional-check failures. */
function readConditionalConflictIndexes(error: unknown): number[] | undefined {
  if (!(error instanceof Error)) return undefined
  if (error.name === 'ConditionalCheckFailedException') return [0]
  if (error.name !== 'TransactionCanceledException') return undefined
  const reasonCodes = readCancellationReasonCodes(error)
  if (
    reasonCodes === undefined ||
    !reasonCodes.includes('ConditionalCheckFailed') ||
    reasonCodes.some((code) => code !== 'None' && code !== 'ConditionalCheckFailed')
  ) return undefined
  return reasonCodes.flatMap((code, index) =>
    code === 'ConditionalCheckFailed' ? [index] : []
  )
}

/** Reads safe DynamoDB cancellation reason codes from an opaque error. */
function readCancellationReasonCodes(error: Error): string[] | undefined {
  if (!('CancellationReasons' in error)) return undefined
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons)) return undefined
  const codes: string[] = []
  for (const reason of reasons) {
    if (!isUnknownRecord(reason) || typeof reason.Code !== 'string') return undefined
    codes.push(reason.Code)
  }
  return codes
}

/** Narrows an opaque value to a string-keyed record. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Maps an opaque DynamoDB failure to the stable Enterprise Identity error contract. */
function toEnterprisePersistenceError(error: unknown): EnterpriseIdentityError {
  return new EnterpriseIdentityError(
    503,
    'EnterpriseIdentityUnavailable',
    'Enterprise identity state is unavailable.',
    true,
    { cause: error },
  )
}
