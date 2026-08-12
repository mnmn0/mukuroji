import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  MigrationDigestAccumulator,
  serializeCanonicalJson,
  type MigrationSourceCheckpoint,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationApplyCheckpointCommandIdentity,
  createWorkspaceSearchMigrationApplyCheckpointReceipt,
  createWorkspaceSearchMigrationApplyCheckpointReceiptRecordKey,
  createWorkspaceSearchMigrationApplyCheckpointSnapshot,
  decodeWorkspaceSearchMigrationApplyCheckpointSnapshot,
  parseWorkspaceSearchMigrationApplyCheckpointReceipt,
  serializeWorkspaceSearchMigrationApplyCheckpointReceipt,
  type CreateWorkspaceSearchMigrationApplyCheckpointCommandIdentityInput,
  type CreateWorkspaceSearchMigrationApplyCheckpointReceiptInput,
  type WorkspaceSearchMigrationApplyCheckpointCommandIdentity,
  type WorkspaceSearchMigrationApplyCheckpointReceipt,
  WORKSPACE_SEARCH_MIGRATION_APPLY_CHECKPOINT_RECEIPT_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_APPLY_CHECKPOINT_RECEIPT_RECORD_KEY_PREFIX,
  WorkspaceSearchMigrationApplyCheckpointReceiptError,
} from './migration-apply-checkpoint-receipt'

const stateTableId = '11111111-2222-3333-4444-555555555555'
const runId = 'apply-checkpoint-receipt-test'
const committedAt = '2026-07-30T03:00:00.000Z'

describe('Workspace Search migration apply-checkpoint receipt', () => {
  test('round-trips one canonical immutable checkpoint receipt', () => {
    const command =
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
        createCommandInput(),
      )
    const input = createReceiptInput(command)
    const receipt =
      createWorkspaceSearchMigrationApplyCheckpointReceipt(input)
    const bytes =
      serializeWorkspaceSearchMigrationApplyCheckpointReceipt(
        receipt,
      )
    const parsed =
      parseWorkspaceSearchMigrationApplyCheckpointReceipt(bytes)

    expect(parsed).toEqual(receipt)
    expect(
      serializeWorkspaceSearchMigrationApplyCheckpointReceipt(
        parsed,
      ),
    ).toEqual(bytes)
    expect(
      decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
        parsed.checkpoint,
      ),
    ).toEqual(input.checkpoint)
    expect(
      createWorkspaceSearchMigrationApplyCheckpointSnapshot(
        input.checkpoint,
      ),
    ).toEqual(receipt.checkpoint)
    expect(receipt).toMatchObject({
      commandDigest: command.commandDigest,
      predecessorRevision: command.expectedRevision,
      predecessorKind: 'mutable-execution-state',
      successorRevision: command.expectedRevision + 1,
      location: command.location,
      phase: 'apply',
      checkpointDigest: createMigrationDigest(
        receipt.checkpoint,
      ),
    })

    const receiptFields = structuredClone(receipt)
    Reflect.deleteProperty(receiptFields, 'receiptDigest')
    expect(receipt.receiptDigest).toBe(
      createMigrationDigest(receiptFields),
    )
  })

  test('derives deterministic command digests and bounded row keys', () => {
    const first =
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
        createCommandInput(),
      )
    const repeated =
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
        createCommandInput(),
      )
    const differentLocation =
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity({
        ...createCommandInput(),
        location: 'target',
      })
    const differentRevision =
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity({
        ...createCommandInput(),
        expectedRevision: 8,
      })

    expect(repeated).toEqual(first)
    expect(differentLocation.commandDigest).not.toBe(
      first.commandDigest,
    )
    expect(differentRevision.commandDigest).not.toBe(
      first.commandDigest,
    )

    const key =
      createWorkspaceSearchMigrationApplyCheckpointReceiptRecordKey(
        first,
      )
    expect(key).toBe(
      `${WORKSPACE_SEARCH_MIGRATION_APPLY_CHECKPOINT_RECEIPT_RECORD_KEY_PREFIX}/${first.commandDigest}/receipt`,
    )
    expect(
      createWorkspaceSearchMigrationApplyCheckpointReceiptRecordKey(
        repeated,
      ),
    ).toBe(key)
    expect(
      createWorkspaceSearchMigrationApplyCheckpointReceiptRecordKey(
        differentLocation,
      ),
    ).not.toBe(key)
  })

  test('rejects hostile or tampered command identities', () => {
    const accessor = createCommandInput()
    let getterInvoked = false
    Object.defineProperty(accessor, 'runId', {
      enumerable: true,
      get() {
        getterInvoked = true
        return 'raw-getter-secret'
      },
    })
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
        accessor,
      )
    )
    expect(getterInvoked).toBe(false)

    const proxy = new Proxy(createCommandInput(), {
      ownKeys() {
        throw new Error('raw-proxy-secret')
      },
    })
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
        proxy,
      )
    )

    const symbolic = createCommandInput()
    Reflect.set(symbolic, Symbol('hidden'), true)
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
        symbolic,
      )
    )

    const tampered = structuredClone(createCommandIdentity())
    Reflect.set(
      tampered,
      'commandDigest',
      digest('tampered-command'),
    )
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceiptRecordKey(
        tampered,
      )
    )
  })

  test('represents the immutable execution admission as the first predecessor', () => {
    const command =
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity({
        ...createCommandInput(),
        expectedRevision: 1,
      })
    const receipt =
      createWorkspaceSearchMigrationApplyCheckpointReceipt({
        ...createReceiptInput(command),
        predecessorKind: 'execution-run-admission',
        predecessorExecutionStateDigest:
          command.executionRunDigest,
        successorRevision: 2,
      })

    expect(receipt.predecessorKind).toBe(
      'execution-run-admission',
    )
    expect(receipt.predecessorExecutionStateDigest).toBe(
      command.executionRunDigest,
    )

    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt({
        ...createReceiptInput(command),
        predecessorKind: 'execution-run-admission',
        predecessorExecutionStateDigest: digest('other-root'),
        successorRevision: 2,
      })
    )
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt({
        ...createReceiptInput(command),
        predecessorKind: 'mutable-execution-state',
        successorRevision: 2,
      })
    )
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt({
        ...createReceiptInput(
          createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
            createCommandInput(),
          ),
        ),
        predecessorKind: 'execution-run-admission',
      })
    )
  })

  test('rejects invalid binding, revision, time, digest, and checkpoint data', () => {
    const invalidIdentifier = createCommandInput()
    Reflect.set(invalidIdentifier, 'runId', 'invalid/run')
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
        invalidIdentifier,
      )
    )

    const invalidLocation = createCommandInput()
    Reflect.set(invalidLocation, 'location', 'verification')
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
        invalidLocation,
      )
    )

    const command =
      createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
        createCommandInput(),
      )
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt({
        ...createReceiptInput(command),
        successorRevision: command.expectedRevision + 2,
      })
    )
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt({
        ...createReceiptInput(command),
        committedAt: '2026-07-30T03:00:00Z',
      })
    )

    const invalidSuccessorDigest = createReceiptInput(command)
    Reflect.set(
      invalidSuccessorDigest,
      'successorExecutionStateDigest',
      'not-a-digest',
    )
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(
        invalidSuccessorDigest,
      )
    )

    const inconsistentCheckpoint = createReceiptInput(command)
    Reflect.set(
      inconsistentCheckpoint.checkpoint.aggregate,
      'scanned',
      2,
    )
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(
        inconsistentCheckpoint,
      )
    )

    const completedWithCursor = createReceiptInput(command)
    Reflect.set(
      completedWithCursor.checkpoint,
      'completed',
      true,
    )
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(
        completedWithCursor,
      )
    )

    const explicitUndefinedCursor = createReceiptInput(command)
    Reflect.set(
      explicitUndefinedCursor.checkpoint,
      'cursor',
      undefined,
    )
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(
        explicitUndefinedCursor,
      )
    )
  })

  test('rejects tampered and noncanonical serialized receipts', () => {
    const receipt = createReceipt()
    const canonical =
      serializeWorkspaceSearchMigrationApplyCheckpointReceipt(
        receipt,
      )
    const text = new TextDecoder().decode(canonical)

    expectReceiptFailure(() =>
      parseWorkspaceSearchMigrationApplyCheckpointReceipt(
        new TextEncoder().encode(` ${text}`),
      )
    )

    const tamperedReceipt = structuredClone(receipt)
    Reflect.set(
      tamperedReceipt,
      'successorRunStateDigest',
      digest('tampered-run-state'),
    )
    expectReceiptFailure(() =>
      parseWorkspaceSearchMigrationApplyCheckpointReceipt(
        encodeCanonicalJson(tamperedReceipt),
      )
    )

    const tamperedCheckpointDigest = structuredClone(receipt)
    Reflect.set(
      tamperedCheckpointDigest,
      'checkpointDigest',
      digest('tampered-checkpoint'),
    )
    const checkpointFields =
      structuredClone(tamperedCheckpointDigest)
    Reflect.deleteProperty(checkpointFields, 'receiptDigest')
    Reflect.set(
      tamperedCheckpointDigest,
      'receiptDigest',
      createMigrationDigest(checkpointFields),
    )
    expectReceiptFailure(() =>
      parseWorkspaceSearchMigrationApplyCheckpointReceipt(
        encodeCanonicalJson(tamperedCheckpointDigest),
      )
    )

    const wrongVersion = structuredClone(receipt)
    Reflect.set(wrongVersion, 'receiptVersion', 2)
    expectReceiptFailure(() =>
      parseWorkspaceSearchMigrationApplyCheckpointReceipt(
        encodeCanonicalJson(wrongVersion),
      )
    )

    expectReceiptFailure(() =>
      parseWorkspaceSearchMigrationApplyCheckpointReceipt(
        new Uint8Array(
          WORKSPACE_SEARCH_MIGRATION_APPLY_CHECKPOINT_RECEIPT_MAX_BYTES +
            1,
        ),
      )
    )
  })

  test('rejects extra, symbolic, non-enumerable, accessor, Proxy, and cyclic input', () => {
    const extra = createReceiptInput(
      createCommandIdentity(),
    )
    Reflect.set(extra, 'rawTenantSecret', true)
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(extra)
    )

    const symbolic = createReceiptInput(
      createCommandIdentity(),
    )
    Reflect.set(symbolic, Symbol('hidden'), true)
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(
        symbolic,
      )
    )

    const nonEnumerable = createReceiptInput(
      createCommandIdentity(),
    )
    Object.defineProperty(nonEnumerable, 'hidden', {
      enumerable: false,
      value: true,
    })
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(
        nonEnumerable,
      )
    )

    const accessor = createReceiptInput(
      createCommandIdentity(),
    )
    let getterInvoked = false
    Object.defineProperty(accessor, 'committedAt', {
      enumerable: true,
      get() {
        getterInvoked = true
        return 'raw-getter-secret'
      },
    })
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(
        accessor,
      )
    )
    expect(getterInvoked).toBe(false)

    const proxy = new Proxy(
      createReceiptInput(createCommandIdentity()),
      {
        ownKeys() {
          throw new Error('raw-proxy-secret')
        },
      },
    )
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(proxy)
    )

    const nestedSymbol = createReceiptInput(
      createCommandIdentity(),
    )
    Reflect.set(
      nestedSymbol.checkpoint.aggregate,
      Symbol('hidden'),
      true,
    )
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(
        nestedSymbol,
      )
    )

    const cyclic = createReceiptInput(
      createCommandIdentity(),
    )
    const cursor = cyclic.checkpoint.cursor
    if (cursor === undefined) {
      throw new Error('Expected checkpoint cursor fixture.')
    }
    const cyclicAttribute: Record<string, unknown> = {}
    Reflect.set(cyclicAttribute, 'M', cyclicAttribute)
    Reflect.set(cursor, 'cycle', cyclicAttribute)
    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(
        cyclic,
      )
    )
  })

  test('rejects hostile runtime receipts without invoking accessors', () => {
    const receipt = createReceipt()
    const accessor = structuredClone(receipt)
    let getterInvoked = false
    Object.defineProperty(accessor, 'runId', {
      enumerable: true,
      get() {
        getterInvoked = true
        return 'raw-getter-secret'
      },
    })
    expectReceiptFailure(() =>
      serializeWorkspaceSearchMigrationApplyCheckpointReceipt(
        accessor,
      )
    )
    expect(getterInvoked).toBe(false)

    const proxy = new Proxy(receipt, {
      ownKeys() {
        throw new Error('raw-proxy-secret')
      },
    })
    expectReceiptFailure(() =>
      serializeWorkspaceSearchMigrationApplyCheckpointReceipt(
        proxy,
      )
    )

    const symbolic = structuredClone(receipt)
    Reflect.set(symbolic, Symbol('hidden'), true)
    expectReceiptFailure(() =>
      serializeWorkspaceSearchMigrationApplyCheckpointReceipt(
        symbolic,
      )
    )
  })

  test('enforces the receipt byte ceiling before returning created data', () => {
    const input = createReceiptInput(createCommandIdentity())
    const cursor = input.checkpoint.cursor
    if (cursor === undefined) {
      throw new Error('Expected checkpoint cursor fixture.')
    }
    Reflect.set(
      cursor,
      'x'.repeat(64_000),
      { S: 'oversized-checkpoint' },
    )

    expectReceiptFailure(() =>
      createWorkspaceSearchMigrationApplyCheckpointReceipt(input)
    )
  })
})

/**
 * Creates one strict command input fixture.
 *
 * @returns Exact apply-checkpoint command identity input.
 */
function createCommandInput():
  CreateWorkspaceSearchMigrationApplyCheckpointCommandIdentityInput {
  return {
    stateTableId,
    configurationHash: digest('configuration'),
    runId,
    executionRunDigest: digest('execution-run'),
    location: 'documents',
    expectedRevision: 7,
  }
}

/**
 * Creates one strict deterministic command identity fixture.
 *
 * @returns Exact apply-checkpoint command identity.
 */
function createCommandIdentity():
  WorkspaceSearchMigrationApplyCheckpointCommandIdentity {
  return createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
    createCommandInput(),
  )
}

/**
 * Creates one strict receipt-construction fixture.
 *
 * @param command - Deterministic command identity to bind.
 * @returns Exact receipt construction input.
 */
function createReceiptInput(
  command: WorkspaceSearchMigrationApplyCheckpointCommandIdentity,
): CreateWorkspaceSearchMigrationApplyCheckpointReceiptInput {
  return {
    commandIdentity: command,
    predecessorKind: 'mutable-execution-state',
    predecessorExecutionStateDigest: digest('predecessor-state'),
    successorRevision: command.expectedRevision + 1,
    successorExecutionStateDigest: digest('successor-state'),
    successorRunStateDigest: digest('successor-run-state'),
    checkpoint: createCheckpoint(),
    committedAt,
  }
}

/**
 * Creates one strict immutable receipt fixture.
 *
 * @returns Canonical immutable apply-checkpoint receipt.
 */
function createReceipt():
  WorkspaceSearchMigrationApplyCheckpointReceipt {
  return createWorkspaceSearchMigrationApplyCheckpointReceipt(
    createReceiptInput(createCommandIdentity()),
  )
}

/**
 * Creates one valid cumulative single-page checkpoint with a binary cursor.
 *
 * @returns Exact low-level checkpoint.
 */
function createCheckpoint(): MigrationSourceCheckpoint {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  keyAccumulator.add(digest('checkpoint-key'))
  contentAccumulator.add(digest('checkpoint-content'))
  return {
    completed: false,
    cursor: {
      pk: { B: new Uint8Array([1, 2, 3, 4]) },
    },
    aggregate: {
      scanned: 1,
      mapped: 1,
      ignored: 0,
      invalid: 0,
      projected: 1,
      deleted: 0,
      keyDigest: keyAccumulator.digest(),
      contentDigest: contentAccumulator.digest(),
      pageCount: 1,
    },
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
}

/**
 * Creates one stable fixture digest.
 *
 * @param label - Nonsecret fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest({ label })
}

/**
 * Encodes one value using the migration canonical JSON serializer.
 *
 * @param value - Candidate JSON-compatible value.
 * @returns Canonical UTF-8 bytes.
 */
function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    serializeCanonicalJson(value),
  )
}

/**
 * Expects one operation to fail at the stable receipt boundary.
 *
 * @param operation - Candidate invalid receipt operation.
 */
function expectReceiptFailure(operation: () => unknown): void {
  expect(operation).toThrow(
    WorkspaceSearchMigrationApplyCheckpointReceiptError,
  )
}
