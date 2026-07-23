/** Conditional generation commit failure reported without persistence-specific types. */
export class EnterpriseGenerationCommitConflictError extends Error {
  /** Zero-based transaction indexes whose conditional checks failed. */
  readonly conflictingOperationIndexes: readonly number[]

  /**
   * Creates a conditional generation commit failure.
   *
   * @param conflictingOperationIndexes - Zero-based indexes of failed operations.
   * @param cause - Raw conditional error retained for diagnostics.
   */
  constructor(
    conflictingOperationIndexes: readonly number[],
    cause: unknown,
  ) {
    super('Enterprise identity generation commit conflicted.', { cause })
    this.name = 'EnterpriseGenerationCommitConflictError'
    this.conflictingOperationIndexes = [...conflictingOperationIndexes]
  }
}

/**
 * Commits immutable state-generation records through a persistence-specific checkpoint.
 *
 * @typeParam TransactionItem - Opaque transaction item owned by the output adapter.
 */
export interface EnterpriseGenerationCommitter<TransactionItem> {
  /**
   * Stages immutable state and atomically publishes the supplied checkpoint transaction.
   *
   * @param stagedItems - Immutable records that are unreachable before publication.
   * @param transactionItems - Persistence-specific atomic checkpoint operations.
   * @returns A promise that resolves only when publication is known to have succeeded.
   */
  commit(
    stagedItems: Record<string, unknown>[],
    transactionItems: TransactionItem[],
  ): Promise<void>
}
