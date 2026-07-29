import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchDocumentRecordKey,
} from '../../../src/modules/workspace-search'
import {
  createAttributeMapDigest,
  encodeAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createJournalHeadDigest,
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type MigrationTableIdentity,
  type WorkspaceSearchJournalReference,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationTableRole,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  zeroHexDigest,
} from './migration-contract'
import {
  type ReadWorkspaceSearchMigrationImmutableArtifactInput,
  type WorkspaceSearchMigrationImmutableArtifactAwsPort,
  type WorkspaceSearchMigrationImmutableArtifactReference,
  type WriteWorkspaceSearchMigrationImmutableArtifactInput,
} from './migration-immutable-artifact-aws'
import {
  createAbsentMigrationItemDigest,
  serializeWorkspaceSearchJournalSegment,
} from './migration-journal'
import {
  createAwsWorkspaceSearchMigrationJournalGateway,
  type CreateAwsWorkspaceSearchMigrationJournalGatewayInput,
  type WorkspaceSearchMigrationJournalAwsGateway,
  WorkspaceSearchMigrationJournalAwsError,
  WORKSPACE_SEARCH_MIGRATION_APPLY_JOURNAL_SEGMENT_ROLE,
} from './migration-journal-aws'

const testAccount = '123456789012'
const testRegion = 'ap-northeast-1'
const runId = 'journal-run'
const now = '2026-07-29T01:02:03.004Z'

/**
 * Exact immutable object retained by the test port.
 */
type StoredJournalObject = {
  /** Detached exact immutable object bytes. */
  readonly bytes: Uint8Array
  /** Exact rich immutable object reference. */
  readonly reference: WorkspaceSearchMigrationImmutableArtifactReference
  /** Exact fixed metadata supplied by the gateway. */
  readonly metadata: Readonly<Record<string, string>>
  /** Exact semantic role supplied by the gateway. */
  readonly role: string
  /** Exact run-scoped object-key prefix. */
  readonly objectKeyPrefix: string
}

/**
 * Exact gateway and test-port fixture.
 */
type JournalGatewayFixture = {
  /** Run-scoped journal gateway under test. */
  readonly gateway: WorkspaceSearchMigrationJournalAwsGateway
  /** Recording immutable object port. */
  readonly port: RecordingImmutableJournalPort
  /** Exact detached measured configuration used by the gateway. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of the exact measured configuration. */
  readonly configurationHash: string
}

/**
 * Deterministic exact-version immutable object port for journal tests.
 */
class RecordingImmutableJournalPort
implements WorkspaceSearchMigrationImmutableArtifactAwsPort {
  /** Exact stored versions indexed by object key and version. */
  private readonly objects = new Map<string, StoredJournalObject>()

  /** Monotonic deterministic version sequence. */
  private nextVersion = 1

  /** Optional stable or raw failure raised by the next write. */
  private nextWriteFailure: Error | undefined

  /** Optional stable or raw failure raised by the next read. */
  private nextReadFailure: Error | undefined

  /** Whether the next returned write reference must be a Proxy. */
  private proxyNextWriteReference = false

  /** Whether the next returned write reference uses an accessor. */
  private accessorNextWriteReference = false

  /** Whether the next returned read body must be a Proxy. */
  private proxyNextReadBody = false

  /** Whether the next returned read body uses shared memory. */
  private sharedNextReadBody = false

  /** Whether the next returned read body must be corrupted. */
  private corruptNextReadBody = false

  /** Pending barrier used to pause the next immutable write. */
  private nextWriteBarrier: Promise<void> | undefined

  /** Resolver for the pending write barrier. */
  private nextWriteBarrierResolver: (() => void) | undefined

  /** Pending barrier used to pause the next exact read. */
  private nextReadBarrier: Promise<void> | undefined

  /** Resolver for the pending read barrier. */
  private nextReadBarrierResolver: (() => void) | undefined

  /** Resolver notified when a paused write reaches the port. */
  private writeStartedResolver: (() => void) | undefined

  /** Resolver notified when a paused read reaches the port. */
  private readStartedResolver: (() => void) | undefined

  /** Signal fulfilled when the next paused write reaches the port. */
  writeStarted: Promise<void> = Promise.resolve()

  /** Signal fulfilled when the next paused read reaches the port. */
  readStarted: Promise<void> = Promise.resolve()

  /** Ordered immutable storage operations observed by the port. */
  readonly calls: string[] = []

  /** Last exact immutable write input observed by the port. */
  lastWriteInput:
    WriteWorkspaceSearchMigrationImmutableArtifactInput | undefined

  /** Last exact immutable read input observed by the port. */
  lastReadInput:
    ReadWorkspaceSearchMigrationImmutableArtifactInput | undefined

  /** Number of times a rejected returned-reference accessor ran. */
  returnedReferenceAccessorReads = 0

  /** Number of forbidden latest/list/delete operations observed. */
  forbiddenOperationCalls = 0

  /**
   * Stores one exact immutable object version.
   *
   * @param input - Exact immutable write input.
   * @returns Deterministic rich immutable reference.
   */
  async writeImmutableArtifact(
    input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<WorkspaceSearchMigrationImmutableArtifactReference> {
    this.calls.push('write')
    this.lastWriteInput = input
    this.writeStartedResolver?.()
    const barrier = this.nextWriteBarrier
    this.nextWriteBarrier = undefined
    if (barrier !== undefined) await barrier
    const failure = this.nextWriteFailure
    this.nextWriteFailure = undefined
    if (failure !== undefined) throw failure

    const bytes = new Uint8Array(input.bytes)
    const contentDigest = digestBytes(bytes)
    const reference = {
      objectKey:
        `${input.objectKeyPrefix}/${input.role}/${contentDigest}.artifact`,
      versionId: `journal-version-${this.nextVersion}`,
      contentDigest,
      byteLength: bytes.byteLength,
      retainUntil: input.retainUntil,
    }
    this.nextVersion += 1
    this.objects.set(storageKey(reference), {
      bytes,
      reference,
      metadata: { ...input.metadata },
      role: input.role,
      objectKeyPrefix: input.objectKeyPrefix,
    })
    if (this.proxyNextWriteReference) {
      this.proxyNextWriteReference = false
      return new Proxy({ ...reference }, {})
    }
    if (this.accessorNextWriteReference) {
      this.accessorNextWriteReference = false
      const accessorReference = { ...reference }
      Object.defineProperty(accessorReference, 'versionId', {
        enumerable: true,
        get: () => {
          this.returnedReferenceAccessorReads += 1
          return reference.versionId
        },
      })
      return accessorReference
    }
    return { ...reference }
  }

  /**
   * Reads one exact immutable object version.
   *
   * @param input - Exact expected read identity and metadata.
   * @returns Detached exact stored bytes.
   */
  async readImmutableArtifact(
    input: ReadWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<Uint8Array> {
    this.calls.push('read')
    this.lastReadInput = input
    this.readStartedResolver?.()
    const barrier = this.nextReadBarrier
    this.nextReadBarrier = undefined
    if (barrier !== undefined) await barrier
    const failure = this.nextReadFailure
    this.nextReadFailure = undefined
    if (failure !== undefined) throw failure
    const stored = this.objects.get(storageKey(input.reference))
    if (
      stored === undefined ||
      stored.role !== input.role ||
      stored.objectKeyPrefix !== input.objectKeyPrefix ||
      !referencesEqual(stored.reference, input.reference) ||
      !metadataEqual(stored.metadata, input.metadata)
    ) {
      throw new Error('raw missing or substituted immutable object')
    }
    const bytes = new Uint8Array(stored.bytes)
    if (this.proxyNextReadBody) {
      this.proxyNextReadBody = false
      return new Proxy(bytes, {})
    }
    if (this.sharedNextReadBody) {
      this.sharedNextReadBody = false
      const shared = new SharedArrayBuffer(bytes.byteLength)
      const sharedBytes = new Uint8Array(shared)
      sharedBytes.set(bytes)
      return sharedBytes
    }
    if (this.corruptNextReadBody) {
      this.corruptNextReadBody = false
      bytes[0] = bytes[0] === 0 ? 1 : 0
    }
    return bytes
  }

  /** Arms a barrier before the next immutable write consumes bytes. */
  pauseNextWrite(): void {
    this.writeStarted = new Promise((resolve) => {
      this.writeStartedResolver = resolve
    })
    this.nextWriteBarrier = new Promise((resolve) => {
      this.nextWriteBarrierResolver = resolve
    })
  }

  /** Releases the currently paused immutable write. */
  releaseWrite(): void {
    this.nextWriteBarrierResolver?.()
  }

  /** Arms a barrier before the next exact read resolves storage. */
  pauseNextRead(): void {
    this.readStarted = new Promise((resolve) => {
      this.readStartedResolver = resolve
    })
    this.nextReadBarrier = new Promise((resolve) => {
      this.nextReadBarrierResolver = resolve
    })
  }

  /** Releases the currently paused exact read. */
  releaseRead(): void {
    this.nextReadBarrierResolver?.()
  }

  /**
   * Makes the next write fail with one selected stable or raw error.
   *
   * @param error - Exact error selected by the test.
   */
  failNextWrite(error: Error): void {
    this.nextWriteFailure = error
  }

  /**
   * Makes the next read fail with one selected stable or raw error.
   *
   * @param error - Exact error selected by the test.
   */
  failNextRead(error: Error): void {
    this.nextReadFailure = error
  }

  /** Makes the next returned write reference a Proxy. */
  proxyReturnedReference(): void {
    this.proxyNextWriteReference = true
  }

  /** Makes the next returned write reference accessor-backed. */
  accessorReturnedReference(): void {
    this.accessorNextWriteReference = true
  }

  /** Makes the next exact read return a Proxy byte view. */
  proxyReturnedBytes(): void {
    this.proxyNextReadBody = true
  }

  /** Makes the next exact read return a shared-memory byte view. */
  shareReturnedBytes(): void {
    this.sharedNextReadBody = true
  }

  /** Makes the next exact read return different bytes. */
  corruptReturnedBytes(): void {
    this.corruptNextReadBody = true
  }

  /** Records a forbidden list/latest operation if a gateway invokes it. */
  listLatestJournalObject(): void {
    this.forbiddenOperationCalls += 1
  }

  /** Records a forbidden delete operation if a gateway invokes it. */
  deleteJournalObject(): void {
    this.forbiddenOperationCalls += 1
  }
}

describe('Workspace Search immutable journal AWS gateway', () => {
  test(
    'writes canonical bytes into the measured run namespace and exactly reads them',
    async () => {
      const fixture = createGateway()
      const segment = createJournalSegment(
        fixture.configurationHash,
      )
      const reference =
        await fixture.gateway.writeJournalSegment(segment)
      const serialized =
        serializeWorkspaceSearchJournalSegment(segment)
      const expectedBytes = new TextEncoder().encode(serialized)
      const expectedContentDigest = digestBytes(expectedBytes)
      const expectedPrefix =
        `workspace-search/v1/runs/${runId}/${fixture.configurationHash}`
      const expectedRetainUntil = '2026-08-29T01:02:03.004Z'
      const expectedMetadata = {
        'mukuroji-journal-kind':
          'workspace-search-preimage-segment-v1',
        'mukuroji-journal-run-id': runId,
        'mukuroji-journal-configuration-sha256':
          fixture.configurationHash,
      }

      expect(fixture.port.calls).toEqual(['write'])
      expect(fixture.port.lastWriteInput).toEqual({
        role:
          WORKSPACE_SEARCH_MIGRATION_APPLY_JOURNAL_SEGMENT_ROLE,
        objectKeyPrefix: expectedPrefix,
        bytes: expectedBytes,
        metadata: expectedMetadata,
        retainUntil: expectedRetainUntil,
      })
      expect(reference).toEqual({
        objectKey:
          `${expectedPrefix}/apply-journal-segments/${expectedContentDigest}.artifact`,
        versionId: 'journal-version-1',
        contentDigest: expectedContentDigest,
        byteLength: expectedBytes.byteLength,
        retainUntil: expectedRetainUntil,
        headDigest: createJournalHeadDigest({
          previousHeadDigest: segment.previousHeadDigest,
          sequence: segment.sequence,
          operationId: segment.operationId,
          contentDigest: expectedContentDigest,
          versionId: 'journal-version-1',
        }),
      })

      fixture.port.calls.length = 0
      expect(
        await fixture.gateway.readJournalSegment(reference),
      ).toEqual(segment)
      expect(fixture.port.calls).toEqual(['read'])
      expect(fixture.port.lastReadInput).toEqual({
        role:
          WORKSPACE_SEARCH_MIGRATION_APPLY_JOURNAL_SEGMENT_ROLE,
        objectKeyPrefix: expectedPrefix,
        reference: {
          objectKey: reference.objectKey,
          versionId: reference.versionId,
          contentDigest: reference.contentDigest,
          byteLength: reference.byteLength,
          retainUntil: reference.retainUntil,
        },
        metadata: expectedMetadata,
      })
      expect(fixture.port.forbiddenOperationCalls).toBe(0)
    },
  )

  test('derives a fresh 31-day deadline for every write', async () => {
    const configuration = createConfiguration()
    const configurationHash =
      createWorkspaceSearchConfigurationHash(configuration)
    const port = new RecordingImmutableJournalPort()
    let clockEpochMilliseconds = Date.parse(now)
    const gateway =
      createAwsWorkspaceSearchMigrationJournalGateway({
        configuration,
        configurationHash,
        runId,
        immutableArtifactPort: port,
        clock: () => new Date(clockEpochMilliseconds),
      })
    const first = await gateway.writeJournalSegment(
      createJournalSegment(configurationHash),
    )
    clockEpochMilliseconds += 60_000
    const secondSegment = createJournalSegment(configurationHash)
    secondSegment.sequence = 2
    secondSegment.operationId = createMigrationDigest('operation-2')
    const second = await gateway.writeJournalSegment(secondSegment)

    expect(first.retainUntil).toBe('2026-08-29T01:02:03.004Z')
    expect(second.retainUntil).toBe('2026-08-29T01:03:03.004Z')
  })

  test(
    'detaches caller segment and rich reference before the first await',
    async () => {
      const fixture = createGateway()
      const segment = createJournalSegment(
        fixture.configurationHash,
      )
      const originalSerialized =
        serializeWorkspaceSearchJournalSegment(segment)
      fixture.port.pauseNextWrite()
      const write = fixture.gateway.writeJournalSegment(segment)
      await fixture.port.writeStarted
      segment.runId = 'mutated-run'
      segment.operationId = createMigrationDigest('mutated-operation')
      fixture.port.releaseWrite()
      const reference = await write
      expect(reference.contentDigest).toBe(
        digestBytes(new TextEncoder().encode(originalSerialized)),
      )

      fixture.port.pauseNextRead()
      const callerReference: WorkspaceSearchJournalReference = {
        ...reference,
      }
      const read =
        fixture.gateway.readJournalSegment(callerReference)
      await fixture.port.readStarted
      callerReference.versionId = 'mutated-version'
      callerReference.retainUntil = '2030-01-01T00:00:00.000Z'
      fixture.port.releaseRead()
      expect(await read).toEqual(
        createJournalSegment(fixture.configurationHash),
      )
    },
  )

  test(
    'rejects Proxy, accessor, and extra-key public inputs without invoking them',
    async () => {
      const fixture = createGateway()
      const segment = createJournalSegment(
        fixture.configurationHash,
      )
      await expect(
        fixture.gateway.writeJournalSegment(
          new Proxy(segment, {}),
        ),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )

      let accessorReads = 0
      Object.defineProperty(segment, 'sequence', {
        configurable: true,
        enumerable: true,
        get: () => {
          accessorReads += 1
          return 1
        },
      })
      await expect(
        fixture.gateway.writeJournalSegment(segment),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
      expect(accessorReads).toBe(0)

      const extraSegment = {
        ...createJournalSegment(fixture.configurationHash),
        unexpected: 'rejected',
      }
      await expect(
        fixture.gateway.writeJournalSegment(extraSegment),
      ).rejects.toBeInstanceOf(WorkspaceSearchMigrationFailure)
      expect(fixture.port.calls).toEqual([])
    },
  )

  test(
    'rejects wrong run or configuration identity before immutable storage',
    async () => {
      const fixture = createGateway()
      const wrongRun = createJournalSegment(
        fixture.configurationHash,
      )
      wrongRun.runId = 'other-run'
      await expect(
        fixture.gateway.writeJournalSegment(wrongRun),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
      const wrongConfiguration = createJournalSegment(
        createMigrationDigest('other-configuration'),
      )
      await expect(
        fixture.gateway.writeJournalSegment(wrongConfiguration),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
      expect(fixture.port.calls).toEqual([])
    },
  )

  test(
    'revalidates exact bytes, namespace, retention, and journal head on read',
    async () => {
      const fixture = createGateway()
      const reference =
        await fixture.gateway.writeJournalSegment(
          createJournalSegment(fixture.configurationHash),
        )
      fixture.port.calls.length = 0

      await expect(
        fixture.gateway.readJournalSegment(
          new Proxy(reference, {}),
        ),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
      let accessorReads = 0
      const accessorReference = { ...reference }
      Object.defineProperty(accessorReference, 'headDigest', {
        configurable: true,
        enumerable: true,
        get: () => {
          accessorReads += 1
          return reference.headDigest
        },
      })
      await expect(
        fixture.gateway.readJournalSegment(accessorReference),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
      expect(accessorReads).toBe(0)
      const extraReference = {
        ...reference,
        latest: true,
      }
      await expect(
        fixture.gateway.readJournalSegment(extraReference),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
      expect(fixture.port.calls).toEqual([])

      await expect(
        fixture.gateway.readJournalSegment({
          ...reference,
          objectKey: `wrong/${reference.contentDigest}.artifact`,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
      expect(fixture.port.calls).toEqual([])

      await expect(
        fixture.gateway.readJournalSegment({
          ...reference,
          headDigest: createMigrationDigest('wrong-head'),
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
      expect(fixture.port.calls).toEqual(['read'])

      fixture.port.corruptReturnedBytes()
      await expect(
        fixture.gateway.readJournalSegment(reference),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )

      await expect(
        fixture.gateway.readJournalSegment({
          ...reference,
          retainUntil: '2026-08-30T01:02:03.004Z',
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
    },
  )

  test(
    'rejects hostile port results and does not invoke returned accessors',
    async () => {
      const first = createGateway()
      first.port.proxyReturnedReference()
      await expect(
        first.gateway.writeJournalSegment(
          createJournalSegment(first.configurationHash),
        ),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )

      const second = createGateway()
      second.port.accessorReturnedReference()
      await expect(
        second.gateway.writeJournalSegment(
          createJournalSegment(second.configurationHash),
        ),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
      expect(second.port.returnedReferenceAccessorReads).toBe(0)

      const third = createGateway()
      const reference =
        await third.gateway.writeJournalSegment(
          createJournalSegment(third.configurationHash),
        )
      third.port.proxyReturnedBytes()
      await expect(
        third.gateway.readJournalSegment(reference),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
      third.port.shareReturnedBytes()
      await expect(
        third.gateway.readJournalSegment(reference),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
    },
  )

  test(
    'preserves trusted migration codes and replaces raw port details',
    async () => {
      const first = createGateway()
      first.port.failNextWrite(
        new WorkspaceSearchMigrationFailure(
          'TRANSIENT_INFRASTRUCTURE_FAILURE',
          'trusted but replaced detail',
        ),
      )
      try {
        await first.gateway.writeJournalSegment(
          createJournalSegment(first.configurationHash),
        )
        throw new Error('Expected a stable port failure.')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
        if (!(error instanceof WorkspaceSearchMigrationFailure)) {
          throw error
        }
        expect(error.code).toBe(
          'TRANSIENT_INFRASTRUCTURE_FAILURE',
        )
        expect(error.message).toBe(
          'TRANSIENT_INFRASTRUCTURE_FAILURE',
        )
      }

      const second = createGateway()
      second.port.failNextWrite(
        new Error('raw-secret-write-canary'),
      )
      try {
        await second.gateway.writeJournalSegment(
          createJournalSegment(second.configurationHash),
        )
        throw new Error('Expected a sanitized raw failure.')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(
          WorkspaceSearchMigrationJournalAwsError,
        )
        if (!(error instanceof Error)) throw error
        expect(error.message).not.toContain('raw-secret')
      }

      const third = createGateway()
      const reference =
        await third.gateway.writeJournalSegment(
          createJournalSegment(third.configurationHash),
        )
      third.port.failNextRead(
        new WorkspaceSearchMigrationFailure(
          'INVALID_JOURNAL',
          'trusted but replaced read detail',
        ),
      )
      try {
        await third.gateway.readJournalSegment(reference)
        throw new Error('Expected a stable read failure.')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
        if (!(error instanceof WorkspaceSearchMigrationFailure)) {
          throw error
        }
        expect(error.code).toBe('INVALID_JOURNAL')
        expect(error.message).toBe('INVALID_JOURNAL')
      }
    },
  )

  test(
    'requires exact descriptor-only construction input and measured hash',
    async () => {
      const configuration = createConfiguration()
      const configurationHash =
        createWorkspaceSearchConfigurationHash(configuration)
      const port = new RecordingImmutableJournalPort()
      const input:
        CreateAwsWorkspaceSearchMigrationJournalGatewayInput = {
          configuration,
          configurationHash,
          runId,
          immutableArtifactPort: port,
          clock: () => new Date(now),
        }
      expect(() =>
        createAwsWorkspaceSearchMigrationJournalGateway(
          new Proxy(input, {}),
        )
      ).toThrow(WorkspaceSearchMigrationJournalAwsError)

      let accessorReads = 0
      Object.defineProperty(input, 'runId', {
        configurable: true,
        enumerable: true,
        get: () => {
          accessorReads += 1
          return runId
        },
      })
      expect(() =>
        createAwsWorkspaceSearchMigrationJournalGateway(input)
      ).toThrow(WorkspaceSearchMigrationJournalAwsError)
      expect(accessorReads).toBe(0)

      expect(() =>
        createAwsWorkspaceSearchMigrationJournalGateway({
          configuration,
          configurationHash: createMigrationDigest('wrong'),
          runId,
          immutableArtifactPort: port,
          clock: () => new Date(now),
        })
      ).toThrow(WorkspaceSearchMigrationFailure)

      const invalidClockFixture = createGateway(() => new Date(NaN))
      await expect(
        invalidClockFixture.gateway.writeJournalSegment(
          createJournalSegment(
            invalidClockFixture.configurationHash,
          ),
        ),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationJournalAwsError,
      )
    },
  )
})

/**
 * Creates a gateway and recording port around one measured configuration.
 *
 * @param clock - Optional adapter clock selected by the test.
 * @returns Complete journal gateway fixture.
 */
function createGateway(
  clock: () => Date = () => new Date(now),
): JournalGatewayFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const port = new RecordingImmutableJournalPort()
  return {
    gateway: createAwsWorkspaceSearchMigrationJournalGateway({
      configuration,
      configurationHash,
      runId,
      immutableArtifactPort: port,
      clock,
    }),
    port,
    configuration,
    configurationHash,
  }
}

/**
 * Creates one complete canonical journal segment.
 *
 * @param configurationHash - Exact measured configuration digest.
 * @returns Canonical absent-to-present apply journal segment.
 */
function createJournalSegment(
  configurationHash: string,
): WorkspaceSearchJournalSegment {
  const entityId = 'team/core/issue/issue-1'
  const targetKey = {
    workspaceId: { S: 'workspace-1' },
    recordKey: {
      S: createWorkspaceSearchDocumentRecordKey('work-item', entityId),
    },
  }
  const after = {
    ...targetKey,
    entryType: { S: 'search-document' },
    entityType: { S: 'work-item' },
    entityId: { S: entityId },
  }
  return {
    kind: 'workspace-search-preimage-segment',
    segmentVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    sequence: 1,
    preparedFenceToken: 7,
    operationId: createMigrationDigest('operation'),
    sourceDigest: createMigrationDigest('source'),
    previousHeadDigest: zeroHexDigest(),
    targetKey: encodeAttributeMap(targetKey),
    targetKeyDigest: createAttributeMapDigest(targetKey),
    before: {
      exists: false,
      digest: createAbsentMigrationItemDigest(),
    },
    after: {
      exists: true,
      item: encodeAttributeMap(after),
      digest: createAttributeMapDigest(after),
    },
    createdAt: now,
  }
}

/**
 * Creates a complete measured migration configuration.
 *
 * @returns Exact measured configuration bound to the gateway.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: testAccount,
    region: testRegion,
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createTable('project-directory'),
      'work-items': createTable('work-items'),
      collaboration: createTable('collaboration'),
      documents: createTable('documents'),
      'workspace-search': createTable('workspace-search'),
      'migration-state': createTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-07-01T00:00:00.000Z',
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates one complete physical table identity fixture.
 *
 * @param role - Exact logical table role.
 * @returns Complete measured table identity.
 */
function createTable(
  role: WorkspaceSearchMigrationTableRole,
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:${testRegion}:${testAccount}:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: testAccount,
    region: testRegion,
    key: [{ name: 'pk', role: 'HASH', type: 'S' }],
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: role === 'migration-state',
    encryption: 'AWS_OWNED',
    kmsKeyDigest: null,
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-06-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-01T00:00:00.000Z',
    },
  }
}

/**
 * Computes the lowercase SHA-256 digest of exact bytes.
 *
 * @param bytes - Exact bytes to digest.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Creates a deterministic storage lookup key.
 *
 * @param reference - Exact immutable object reference.
 * @returns Object-key and version tuple.
 */
function storageKey(
  reference: WorkspaceSearchMigrationImmutableArtifactReference,
): string {
  return `${reference.objectKey}\u0000${reference.versionId}`
}

/**
 * Compares every rich immutable reference field.
 *
 * @param left - First reference.
 * @param right - Second reference.
 * @returns Whether every immutable field is identical.
 */
function referencesEqual(
  left: WorkspaceSearchMigrationImmutableArtifactReference,
  right: WorkspaceSearchMigrationImmutableArtifactReference,
): boolean {
  return left.objectKey === right.objectKey &&
    left.versionId === right.versionId &&
    left.contentDigest === right.contentDigest &&
    left.byteLength === right.byteLength &&
    left.retainUntil === right.retainUntil
}

/**
 * Compares two exact fixed metadata maps.
 *
 * @param left - First metadata map.
 * @param right - Second metadata map.
 * @returns Whether both maps contain identical entries.
 */
function metadataEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
