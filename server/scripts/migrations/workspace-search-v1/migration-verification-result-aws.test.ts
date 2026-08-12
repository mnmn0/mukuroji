import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  MigrationDigestAccumulator,
  type MigrationDigestState,
  type MigrationSourceCheckpoint,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  type WorkspaceSearchMigrationFullVerificationProgress,
  type WorkspaceSearchMigrationFullVerificationResult,
  type WorkspaceSearchMigrationVerificationBindingAggregate,
  WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
} from './migration-full-verification'
import type {
  ReadWorkspaceSearchMigrationImmutableArtifactInput,
  WorkspaceSearchMigrationImmutableArtifactAwsPort,
  WorkspaceSearchMigrationImmutableArtifactReference,
  WriteWorkspaceSearchMigrationImmutableArtifactInput,
} from './migration-immutable-artifact-aws'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
} from './migration-source-evidence'
import {
  createAwsWorkspaceSearchMigrationVerificationResultGateway,
  type CreateAwsWorkspaceSearchMigrationVerificationResultGatewayInput,
  WorkspaceSearchMigrationVerificationResultAwsError,
  WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_OBJECT_KEY_PREFIX,
  WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_ROLE,
} from './migration-verification-result-aws'

const testRunId = 'run-verification-result-20260730'
const testConfigurationHash = digestText('configuration')
const testAppliedRootDigest = digestText('applied-root')
const testRetainUntil = '2026-08-30T00:00:00.000Z'

/**
 * Exact stored object retained by the in-memory immutable port.
 */
type StoredVerificationResultObject = {
  /** Detached exact canonical bytes. */
  readonly bytes: Uint8Array
  /** Exact deterministic immutable reference. */
  readonly reference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Exact semantic role used for storage. */
  readonly role: string
  /** Exact gateway-owned key prefix. */
  readonly objectKeyPrefix: string
  /** Exact caller metadata bound to the version. */
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Narrow in-memory immutable port with controllable failure behavior.
 */
class RecordingVerificationResultArtifactPort
  implements WorkspaceSearchMigrationImmutableArtifactAwsPort {
  /** Exact write inputs observed by the port. */
  readonly writes:
    WriteWorkspaceSearchMigrationImmutableArtifactInput[] = []

  /** Exact read inputs observed by the port. */
  readonly reads:
    ReadWorkspaceSearchMigrationImmutableArtifactInput[] = []

  /** Content-addressed exact-version objects retained across retries. */
  private readonly objects =
    new Map<string, StoredVerificationResultObject>()

  /** Raw failure raised before the next write, when configured. */
  private nextWriteError: Error | undefined

  /** Raw failure raised before the next read, when configured. */
  private nextReadError: Error | undefined

  /** Whether the next successful store loses its response. */
  private loseNextWriteResponse = false

  /** Optional substituted read bytes returned once. */
  private nextReadBytes: Uint8Array | undefined

  /** Whether the next returned write reference is a Proxy. */
  private proxyNextWriteResult = false

  /** Whether the next returned write reference contains an accessor. */
  private accessorNextWriteResult = false

  /** Wrong retention returned once after a successful store. */
  private wrongRetainUntilNextWrite: string | undefined

  /** Number of hostile returned-reference getter executions. */
  returnedReferenceGetterReads = 0

  /**
   * Stores or reconciles one deterministic content-addressed object.
   *
   * @param input - Exact gateway-owned immutable write input.
   * @returns Exact deterministic immutable reference.
   */
  async writeImmutableArtifact(
    input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<WorkspaceSearchMigrationImmutableArtifactReference> {
    this.writes.push(input)
    const nextError = this.nextWriteError
    this.nextWriteError = undefined
    if (nextError !== undefined) throw nextError

    const bytes = new Uint8Array(input.bytes)
    const contentDigest = digestBytes(bytes)
    const objectKey =
      `${input.objectKeyPrefix}/${input.role}/${contentDigest}.artifact`
    const versionId = `version-${contentDigest.slice(0, 16)}`
    const reference:
      WorkspaceSearchMigrationImmutableArtifactReference = {
        objectKey,
        versionId,
        contentDigest,
        byteLength: bytes.byteLength,
        retainUntil: input.retainUntil,
      }
    const storageKey = createStorageKey(reference)
    const existing = this.objects.get(storageKey)
    if (existing === undefined) {
      this.objects.set(storageKey, {
        bytes,
        reference,
        role: input.role,
        objectKeyPrefix: input.objectKeyPrefix,
        metadata: { ...input.metadata },
      })
    } else if (
      !equalBytes(existing.bytes, bytes) ||
      existing.reference.retainUntil !== input.retainUntil ||
      existing.role !== input.role ||
      existing.objectKeyPrefix !== input.objectKeyPrefix ||
      createMigrationDigest(existing.metadata) !==
        createMigrationDigest(input.metadata)
    ) {
      throw new Error('raw-secret-inexact-reconciliation')
    }
    if (this.loseNextWriteResponse) {
      this.loseNextWriteResponse = false
      throw new Error('raw-secret-response-loss')
    }
    const wrongRetainUntil = this.wrongRetainUntilNextWrite
    this.wrongRetainUntilNextWrite = undefined
    const returned = wrongRetainUntil === undefined
      ? { ...reference }
      : {
          ...reference,
          retainUntil: wrongRetainUntil,
        }
    if (this.proxyNextWriteResult) {
      this.proxyNextWriteResult = false
      return new Proxy(returned, {})
    }
    if (this.accessorNextWriteResult) {
      this.accessorNextWriteResult = false
      Object.defineProperty(returned, 'versionId', {
        configurable: true,
        enumerable: true,
        get: () => {
          this.returnedReferenceGetterReads += 1
          return reference.versionId
        },
      })
    }
    return returned
  }

  /**
   * Reads one exact stored immutable object version.
   *
   * @param input - Exact gateway-owned immutable read input.
   * @returns Detached exact stored bytes.
   */
  async readImmutableArtifact(
    input: ReadWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<Uint8Array> {
    this.reads.push(input)
    const nextError = this.nextReadError
    this.nextReadError = undefined
    if (nextError !== undefined) throw nextError
    const substituted = this.nextReadBytes
    this.nextReadBytes = undefined
    if (substituted !== undefined) {
      return new Uint8Array(substituted)
    }
    const stored = this.objects.get(createStorageKey(input.reference))
    if (
      stored === undefined ||
      stored.role !== input.role ||
      stored.objectKeyPrefix !== input.objectKeyPrefix ||
      stored.reference.contentDigest !==
        input.reference.contentDigest ||
      stored.reference.byteLength !== input.reference.byteLength ||
      stored.reference.retainUntil !== input.reference.retainUntil ||
      createMigrationDigest(stored.metadata) !==
        createMigrationDigest(input.metadata)
    ) {
      throw new Error('raw-secret-version-or-metadata-substitution')
    }
    return new Uint8Array(stored.bytes)
  }

  /** Causes the next successful store to lose its response. */
  loseResponseAfterNextStore(): void {
    this.loseNextWriteResponse = true
  }

  /**
   * Causes the next write to fail before storage.
   *
   * @param error - Raw injected failure.
   */
  failNextWrite(error: Error): void {
    this.nextWriteError = error
  }

  /**
   * Causes the next read to fail before lookup.
   *
   * @param error - Raw injected failure.
   */
  failNextRead(error: Error): void {
    this.nextReadError = error
  }

  /**
   * Substitutes exact bytes for the next read.
   *
   * @param bytes - Wrong bytes returned by the test port.
   */
  substituteNextRead(bytes: Uint8Array): void {
    this.nextReadBytes = new Uint8Array(bytes)
  }

  /** Returns a Proxy for the next successful write reference. */
  proxyNextReference(): void {
    this.proxyNextWriteResult = true
  }

  /** Returns an accessor-backed next successful write reference. */
  accessorNextReference(): void {
    this.accessorNextWriteResult = true
  }

  /**
   * Returns a wrong retention deadline for the next successful write.
   *
   * @param retainUntil - Wrong returned retention deadline.
   */
  returnWrongRetainUntilOnce(retainUntil: string): void {
    this.wrongRetainUntilNextWrite = retainUntil
  }
}

describe('Workspace Search verification-result artifact gateway', () => {
  test(
    'uploads deterministic exact evidence and replays its exact version',
    async () => {
      const { gateway, port } = createGateway()
      const result = createVerificationResult()
      const reference =
        await gateway.writeVerificationResultArtifact({
          verificationResult: result,
          retainUntil: testRetainUntil,
        })

      expect(port.writes).toHaveLength(1)
      const write = port.writes[0]
      expect(write?.role).toBe(
        WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_ROLE,
      )
      expect(write?.objectKeyPrefix).toBe(
        `${WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_OBJECT_KEY_PREFIX}` +
          `/runs/${testRunId}/${testConfigurationHash}/${testAppliedRootDigest}`,
      )
      expect(write?.retainUntil).toBe(testRetainUntil)
      expect(reference.objectKey).toBe(
        `${write?.objectKeyPrefix}/${WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_ROLE}/${reference.contentDigest}.artifact`,
      )
      expect(reference.appliedRootDigest).toBe(
        testAppliedRootDigest,
      )
      expect(reference.verificationResultDigest).toBe(
        result.resultDigest,
      )
      expect(reference.retainUntil).toBe(testRetainUntil)

      const storedText = new TextDecoder().decode(write?.bytes)
      expect(storedText).not.toContain('completedAt')
      const replayed =
        await gateway.replayVerificationResultArtifact(reference)
      expect(replayed.verificationResult).toEqual(result)
      expect(replayed.appliedRootDigest).toBe(
        testAppliedRootDigest,
      )
      expect(replayed.verificationResultDigest).toBe(
        result.resultDigest,
      )
      expect(replayed.envelopeDigest).toBe(
        reference.envelopeDigest,
      )
      expect(port.reads[0]?.reference.versionId).toBe(
        reference.versionId,
      )
    },
  )

  test(
    'reconciles the same content-addressed version after response loss',
    async () => {
      const { gateway, port } = createGateway()
      const result = createVerificationResult()
      port.loseResponseAfterNextStore()

      const firstFailure = await captureFailure(() =>
        gateway.writeVerificationResultArtifact({
          verificationResult: result,
          retainUntil: testRetainUntil,
        })
      )
      expect(firstFailure).toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(firstFailure.message).not.toContain(
        'raw-secret-response-loss',
      )

      const recovered =
        await gateway.writeVerificationResultArtifact({
          verificationResult: result,
          retainUntil: testRetainUntil,
        })
      expect(port.writes).toHaveLength(2)
      expect(port.writes[0]?.bytes).toEqual(port.writes[1]?.bytes)
      expect(await gateway.replayVerificationResultArtifact(
        recovered,
      )).toMatchObject({
        appliedRootDigest: testAppliedRootDigest,
        verificationResultDigest: result.resultDigest,
      })
    },
  )

  test(
    'rejects version and content substitution during exact replay',
    async () => {
      const { gateway, port } = createGateway()
      const reference =
        await gateway.writeVerificationResultArtifact({
          verificationResult: createVerificationResult(),
          retainUntil: testRetainUntil,
        })

      const versionFailure = await captureFailure(() =>
        gateway.replayVerificationResultArtifact({
          ...reference,
          versionId: 'substituted-version',
        })
      )
      expect(versionFailure).toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(versionFailure.message).not.toContain(
        'raw-secret-version-or-metadata-substitution',
      )

      port.substituteNextRead(new TextEncoder().encode(
        '{"substituted":"tenant-secret-content"}',
      ))
      await expect(
        gateway.replayVerificationResultArtifact(reference),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
    },
  )

  test(
    'rejects applied-root and semantic-result mismatches before storage',
    async () => {
      const first = createGateway()
      const wrongRunResult = createVerificationResult(
        'run-from-another-root',
      )
      await expect(
        first.gateway.writeVerificationResultArtifact({
          verificationResult: wrongRunResult,
          retainUntil: testRetainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(first.port.writes).toEqual([])

      const result = createVerificationResult()
      const reference =
        await first.gateway.writeVerificationResultArtifact({
          verificationResult: result,
          retainUntil: testRetainUntil,
        })
      first.port.reads.length = 0
      await expect(
        first.gateway.replayVerificationResultArtifact({
          ...reference,
          appliedRootDigest: digestText('different-applied-root'),
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(first.port.reads).toEqual([])

      const staleSemanticResult = {
        ...result,
        applySealDigest: digestText('different-apply-seal'),
      }
      await expect(
        first.gateway.writeVerificationResultArtifact({
          verificationResult: staleSemanticResult,
          retainUntil: testRetainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(first.port.writes).toHaveLength(1)
    },
  )

  test(
    'preflights retention, accessors, reference shape, and size',
    async () => {
      const { gateway, port } = createGateway()
      const result = createVerificationResult()
      await expect(
        gateway.writeVerificationResultArtifact({
          verificationResult: result,
          retainUntil: 'not-a-retention-deadline',
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(port.writes).toEqual([])

      const hostileInput = {
        verificationResult: result,
        retainUntil: testRetainUntil,
      }
      let getterReads = 0
      Object.defineProperty(hostileInput, 'retainUntil', {
        configurable: true,
        enumerable: true,
        get: () => {
          getterReads += 1
          return testRetainUntil
        },
      })
      await expect(
        gateway.writeVerificationResultArtifact(hostileInput),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(getterReads).toBe(0)
      expect(port.writes).toEqual([])

      const reference =
        await gateway.writeVerificationResultArtifact({
          verificationResult: result,
          retainUntil: testRetainUntil,
        })
      port.reads.length = 0
      await expect(
        gateway.replayVerificationResultArtifact({
          ...reference,
          byteLength:
            WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_MAX_BYTES +
            1,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(port.reads).toEqual([])

      const second = createGateway()
      second.port.returnWrongRetainUntilOnce(
        '2026-09-01T00:00:00.000Z',
      )
      await expect(
        second.gateway.writeVerificationResultArtifact({
          verificationResult: result,
          retainUntil: testRetainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
    },
  )

  test(
    'rejects Proxy and accessor graphs without invoking hostile behavior',
    async () => {
      const first = createGateway()
      const result = createVerificationResult()
      await expect(
        first.gateway.writeVerificationResultArtifact({
          verificationResult: new Proxy(result, {}),
          retainUntil: testRetainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(first.port.writes).toEqual([])

      const hostileResult = { ...result }
      let getterReads = 0
      Object.defineProperty(hostileResult, 'runId', {
        configurable: true,
        enumerable: true,
        get: () => {
          getterReads += 1
          return testRunId
        },
      })
      await expect(
        first.gateway.writeVerificationResultArtifact({
          verificationResult: hostileResult,
          retainUntil: testRetainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(getterReads).toBe(0)
      expect(first.port.writes).toEqual([])

      const second = createGateway()
      second.port.proxyNextReference()
      await expect(
        second.gateway.writeVerificationResultArtifact({
          verificationResult: result,
          retainUntil: testRetainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )

      const third = createGateway()
      third.port.accessorNextReference()
      await expect(
        third.gateway.writeVerificationResultArtifact({
          verificationResult: result,
          retainUntil: testRetainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(third.port.returnedReferenceGetterReads).toBe(0)
    },
  )

  test(
    'redacts raw failures and preserves only trusted migration codes',
    async () => {
      const first = createGateway()
      first.port.failNextWrite(
        new Error('tenant-secret-raw-write-failure'),
      )
      const writeFailure = await captureFailure(() =>
        first.gateway.writeVerificationResultArtifact({
          verificationResult: createVerificationResult(),
          retainUntil: testRetainUntil,
        })
      )
      expect(writeFailure).toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(writeFailure.message).not.toContain('tenant-secret')

      const second = createGateway()
      const reference =
        await second.gateway.writeVerificationResultArtifact({
          verificationResult: createVerificationResult(),
          retainUntil: testRetainUntil,
        })
      second.port.failNextRead(
        new Error('tenant-secret-raw-read-failure'),
      )
      const readFailure = await captureFailure(() =>
        second.gateway.replayVerificationResultArtifact(reference)
      )
      expect(readFailure).toBeInstanceOf(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(readFailure.message).not.toContain('tenant-secret')

      const third = createGateway()
      third.port.failNextWrite(
        new WorkspaceSearchMigrationFailure(
          'TRANSIENT_INFRASTRUCTURE_FAILURE',
          'tenant-secret-trusted-message',
        ),
      )
      const preservedFailure = await captureFailure(() =>
        third.gateway.writeVerificationResultArtifact({
          verificationResult: createVerificationResult(),
          retainUntil: testRetainUntil,
        })
      )
      expect(preservedFailure).toBeInstanceOf(
        WorkspaceSearchMigrationFailure,
      )
      if (
        !(preservedFailure instanceof WorkspaceSearchMigrationFailure)
      ) {
        throw new Error('Expected one public migration failure.')
      }
      expect(preservedFailure.code).toBe(
        'TRANSIENT_INFRASTRUCTURE_FAILURE',
      )
      expect(preservedFailure.message).toBe(
        'TRANSIENT_INFRASTRUCTURE_FAILURE',
      )
      expect(preservedFailure.message).not.toContain('tenant-secret')
    },
  )

  test(
    'rejects an accessor-backed gateway input without reading it',
    () => {
      const port = new RecordingVerificationResultArtifactPort()
      const input:
        CreateAwsWorkspaceSearchMigrationVerificationResultGatewayInput = {
          runId: testRunId,
          configurationHash: testConfigurationHash,
          appliedRootDigest: testAppliedRootDigest,
          immutableArtifactPort: port,
        }
      let getterReads = 0
      Object.defineProperty(input, 'appliedRootDigest', {
        configurable: true,
        enumerable: true,
        get: () => {
          getterReads += 1
          return testAppliedRootDigest
        },
      })
      expect(() =>
        createAwsWorkspaceSearchMigrationVerificationResultGateway(
          input,
        )
      ).toThrow(
        WorkspaceSearchMigrationVerificationResultAwsError,
      )
      expect(getterReads).toBe(0)
    },
  )
})

/**
 * Creates one gateway and its recording immutable storage port.
 *
 * @returns Gateway and exact recording port.
 */
function createGateway(): {
  /** Run-scoped verification-result gateway. */
  readonly gateway: ReturnType<
    typeof createAwsWorkspaceSearchMigrationVerificationResultGateway
  >
  /** Recording immutable artifact dependency. */
  readonly port: RecordingVerificationResultArtifactPort
} {
  const port = new RecordingVerificationResultArtifactPort()
  return {
    gateway:
      createAwsWorkspaceSearchMigrationVerificationResultGateway({
        runId: testRunId,
        configurationHash: testConfigurationHash,
        appliedRootDigest: testAppliedRootDigest,
        immutableArtifactPort: port,
      }),
    port,
  }
}

/**
 * Creates one valid zero-operation terminal full-verification result.
 *
 * @param runId - Operator-selected run for the result.
 * @returns Canonical internally consistent successful result.
 */
function createVerificationResult(
  runId = testRunId,
): WorkspaceSearchMigrationFullVerificationResult {
  const sourceCheckpoints = createSourceCheckpoints()
  const targetCheckpoint = createTerminalCheckpoint()
  const sourceBindings = createSourceDigestStates()
  const targetPresentBindings = createEmptyDigestState()
  const verification:
    WorkspaceSearchMigrationFullVerificationProgress = {
      kind:
        'workspace-search-migration-full-verification-progress',
      verificationVersion:
        WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
      runId,
      configurationHash: testConfigurationHash,
      planDigest: digestText('plan'),
      verificationPlanDigest: digestText('verification-plan'),
      traversal: {
        sources: sourceCheckpoints,
        target: targetCheckpoint,
      },
      sourceBindings,
      targetPresentBindings,
    }
  const expectedSourceBindings = createSourceBindingAggregates()
  const observedSourceBindings = createSourceBindingAggregates()
  const expectedTargetPresentBindings =
    createEmptyBindingAggregate()
  const observedTargetPresentBindings =
    createEmptyBindingAggregate()
  const common = {
    kind: 'workspace-search-migration-full-verification-result',
    verificationVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: testConfigurationHash,
    planDigest: verification.planDigest,
    verificationPlanDigest: verification.verificationPlanDigest,
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    applySealDigest: digestText('apply-seal'),
    sealedPlanningAuthorityDigest: digestText(
      'sealed-planning-authority',
    ),
    sourceCheckpointDigests: {
      'project-directory':
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          sourceCheckpoints['project-directory'],
        ),
      'work-items':
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          sourceCheckpoints['work-items'],
        ),
      collaboration:
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          sourceCheckpoints.collaboration,
        ),
      documents:
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          sourceCheckpoints.documents,
        ),
    },
    targetCheckpointDigest:
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        targetCheckpoint,
      ),
    verification,
    expectedSourceBindings,
    observedSourceBindings,
    expectedTargetPresentBindings,
    observedTargetPresentBindings,
    status: 'pass',
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationResult,
    'resultDigest'
  >
  return {
    ...common,
    resultDigest: createMigrationDigest(common),
  }
}

/**
 * Creates four independently owned empty terminal checkpoints.
 *
 * @returns Fixed source checkpoint record.
 */
function createSourceCheckpoints(): Readonly<
  Record<WorkspaceSearchMigrationSourceName, MigrationSourceCheckpoint>
> {
  return {
    'project-directory': createTerminalCheckpoint(),
    'work-items': createTerminalCheckpoint(),
    collaboration: createTerminalCheckpoint(),
    documents: createTerminalCheckpoint(),
  }
}

/**
 * Creates one canonical empty completed scan checkpoint.
 *
 * @returns Exact terminal checkpoint.
 */
function createTerminalCheckpoint(): MigrationSourceCheckpoint {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  return {
    completed: true,
    aggregate: {
      scanned: 0,
      mapped: 0,
      ignored: 0,
      invalid: 0,
      projected: 0,
      deleted: 0,
      keyDigest: keyAccumulator.digest(),
      contentDigest: contentAccumulator.digest(),
      pageCount: 0,
    },
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
}

/**
 * Creates four independently owned empty digest states.
 *
 * @returns Fixed source digest-state record.
 */
function createSourceDigestStates(): Readonly<
  Record<WorkspaceSearchMigrationSourceName, MigrationDigestState>
> {
  return {
    'project-directory': createEmptyDigestState(),
    'work-items': createEmptyDigestState(),
    collaboration: createEmptyDigestState(),
    documents: createEmptyDigestState(),
  }
}

/**
 * Creates four independently owned empty binding aggregates.
 *
 * @returns Fixed source binding-aggregate record.
 */
function createSourceBindingAggregates(): Readonly<
  Record<
    WorkspaceSearchMigrationSourceName,
    WorkspaceSearchMigrationVerificationBindingAggregate
  >
> {
  return {
    'project-directory': createEmptyBindingAggregate(),
    'work-items': createEmptyBindingAggregate(),
    collaboration: createEmptyBindingAggregate(),
    documents: createEmptyBindingAggregate(),
  }
}

/**
 * Creates one canonical empty digest state.
 *
 * @returns Exact empty state.
 */
function createEmptyDigestState(): MigrationDigestState {
  return new MigrationDigestAccumulator().exportState()
}

/**
 * Creates one canonical empty verification binding aggregate.
 *
 * @returns Exact empty binding aggregate.
 */
function createEmptyBindingAggregate():
  WorkspaceSearchMigrationVerificationBindingAggregate {
  const accumulator = new MigrationDigestAccumulator()
  return {
    count: 0,
    digestState: accumulator.exportState(),
    digest: accumulator.digest(),
  }
}

/**
 * Captures one expected asynchronous failure.
 *
 * @param operation - Operation expected to reject.
 * @returns Exact caught Error.
 */
async function captureFailure(
  operation: () => Promise<unknown>,
): Promise<Error> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof Error) return error
    throw new Error('Expected an Error rejection.')
  }
  throw new Error('Expected operation to fail.')
}

/**
 * Computes one lowercase SHA-256 test digest.
 *
 * @param value - Exact test label.
 * @returns Lowercase digest.
 */
function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Computes lowercase SHA-256 over exact bytes.
 *
 * @param bytes - Exact bytes.
 * @returns Lowercase digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Creates one exact-version in-memory storage key.
 *
 * @param reference - Exact immutable reference.
 * @returns Stable lookup key.
 */
function createStorageKey(
  reference: WorkspaceSearchMigrationImmutableArtifactReference,
): string {
  return `${reference.objectKey}\u0000${reference.versionId}`
}

/**
 * Compares two byte sequences exactly.
 *
 * @param left - First bytes.
 * @param right - Second bytes.
 * @returns Whether lengths and byte values match.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}
