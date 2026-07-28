import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import {
  createTeamWorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createAttributeMapDigest,
} from './dynamodb-attribute-codec'
import {
  createAbsentMigrationItemDigest,
} from './migration-journal'
import {
  createMigrationDigest,
  createWorkspaceSearchOperationId,
  serializeCanonicalJson,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationOperation,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import {
  serializeWorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
} from './migration-artifacts'
import type {
  ReadWorkspaceSearchMigrationImmutableArtifactInput,
  WorkspaceSearchMigrationImmutableArtifactAwsPort,
  WorkspaceSearchMigrationImmutableArtifactReference,
  WriteWorkspaceSearchMigrationImmutableArtifactInput,
} from './migration-immutable-artifact-aws'
import {
  createAwsWorkspaceSearchMigrationPlanningArtifactGateway,
  type CreateAwsWorkspaceSearchMigrationPlanningArtifactGatewayInput,
  type WorkspaceSearchMigrationPlanningArtifactAwsGateway,
  WorkspaceSearchMigrationPlanningArtifactAwsError,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-planning-artifact-aws'
import {
  type WorkspaceSearchMigrationPlanArtifactReference,
  type WorkspaceSearchMigrationPlanManifestHead,
  type WorkspaceSearchMigrationPlanManifestPage,
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES,
} from './migration-plan-artifact'
import {
  type WorkspaceSearchMigrationPlanningProvenanceManifestHead,
  type WorkspaceSearchMigrationPlanningProvenanceManifestPage,
  type WorkspaceSearchMigrationPlanningProvenanceManifestPageLocator,
  type WorkspaceSearchMigrationPlanningProvenanceSegmentLocator,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_TOTAL_SEGMENT_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
} from './migration-planning-provenance-manifest'
import {
  createWorkspaceSearchMigrationPlanningProvenanceArtifact,
  type WorkspaceSearchMigrationPlanningProvenanceArtifact,
  type WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  advanceWorkspaceSearchMigrationSourceEvidenceProgress,
  createInitialWorkspaceSearchMigrationSourceEvidenceProgress,
  createWorkspaceSearchMigrationSourceEvidencePage,
  serializeWorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationPlanningAuthorityBinding,
} from './migration-source-evidence'
import {
  createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey,
} from './migration-source-artifact'
import {
  createInitialWorkspaceSearchMigrationTargetEvidenceProgress,
  createWorkspaceSearchMigrationTargetEvidencePage,
  serializeWorkspaceSearchMigrationTargetEvidencePage,
} from './migration-target-evidence'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
} from './migration-target-artifact'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMigrationOperationDigest,
  createWorkspaceSearchPlanLeafDigest,
  createWorkspaceSearchPlanNodeDigest,
  type WorkspaceSearchPlannedOperation,
  type WorkspaceSearchPlanMembershipProofStep,
} from './migration-state-machine'
import {
  encodeWorkspaceSearchMigrationDocument,
} from './migration-target-snapshot'

const runId = 'artifact-run'
const configurationHash = 'a'.repeat(64)
const retainUntil = '2026-08-28T01:00:00.000Z'
const ownerId = 'planning-owner'

/**
 * Exact immutable object retained by the in-memory storage port.
 */
type StoredImmutableObject = {
  /** Exact detached immutable object bytes. */
  readonly bytes: Uint8Array
  /** Exact rich immutable object reference. */
  readonly reference: WorkspaceSearchMigrationImmutableArtifactReference
  /** Exact caller-owned metadata supplied by the gateway. */
  readonly metadata: Readonly<Record<string, string>>
  /** Exact semantic role supplied by the gateway. */
  readonly role: string
  /** Exact codec-owned object-key prefix. */
  readonly objectKeyPrefix: string
}

/**
 * Deterministic exact-version immutable object port for gateway tests.
 */
class InMemoryImmutableArtifactPort
implements WorkspaceSearchMigrationImmutableArtifactAwsPort {
  /** Exact stored object versions indexed by key and version. */
  private readonly objects = new Map<string, StoredImmutableObject>()

  /** Monotonic deterministic version sequence. */
  private nextVersion = 1

  /** Role whose next returned reference must be a Proxy. */
  private proxyReferenceRole: string | undefined

  /** Role whose next returned reference must contain an accessor. */
  private accessorReferenceRole: string | undefined

  /** Invalid version identifier returned by the next write. */
  private nextInvalidVersionId: string | undefined

  /** Whether the next returned read body must be a Proxy. */
  private proxyNextRead = false

  /** Whether the next returned read body must use shared memory. */
  private sharedNextRead = false

  /** Optional stable or raw failure raised by the next write. */
  private nextWriteFailure: Error | undefined

  /** Ordered semantic storage calls observed by the port. */
  readonly calls: string[] = []

  /** Number of times a rejected returned-reference accessor was invoked. */
  returnedReferenceAccessorReads = 0

  /**
   * Stores one exact immutable object version.
   *
   * @param input - Exact immutable write input.
   * @returns Deterministic rich immutable reference.
   */
  async writeImmutableArtifact(
    input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<WorkspaceSearchMigrationImmutableArtifactReference> {
    const nextWriteFailure = this.nextWriteFailure
    this.nextWriteFailure = undefined
    if (nextWriteFailure !== undefined) throw nextWriteFailure
    const bytes = new Uint8Array(input.bytes)
    const contentDigest = digestBytes(bytes)
    const versionId =
      this.nextInvalidVersionId ?? `version-${this.nextVersion}`
    this.nextInvalidVersionId = undefined
    const reference = {
      objectKey:
        `${input.objectKeyPrefix}/${input.role}/${contentDigest}.artifact`,
      versionId,
      contentDigest,
      byteLength: bytes.byteLength,
      retainUntil: input.retainUntil,
    }
    this.nextVersion += 1
    this.calls.push(`write:${input.role}`)
    this.objects.set(createStorageKey(reference), {
      bytes,
      reference,
      metadata: { ...input.metadata },
      role: input.role,
      objectKeyPrefix: input.objectKeyPrefix,
    })
    if (this.proxyReferenceRole === input.role) {
      this.proxyReferenceRole = undefined
      return new Proxy({ ...reference }, {})
    }
    if (this.accessorReferenceRole === input.role) {
      this.accessorReferenceRole = undefined
      const accessorReference = { ...reference }
      Reflect.defineProperty(accessorReference, 'versionId', {
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
    this.calls.push(`read:${input.role}`)
    const stored = this.objects.get(createStorageKey(input.reference))
    if (
      stored === undefined ||
      stored.role !== input.role ||
      stored.objectKeyPrefix !== input.objectKeyPrefix ||
      !referencesEqual(stored.reference, input.reference) ||
      !metadataEqual(stored.metadata, input.metadata)
    ) {
      throw new Error('Exact immutable object was not found.')
    }
    const bytes = new Uint8Array(stored.bytes)
    if (this.proxyNextRead) {
      this.proxyNextRead = false
      return new Proxy(bytes, {})
    }
    if (this.sharedNextRead) {
      this.sharedNextRead = false
      const shared = new SharedArrayBuffer(bytes.byteLength)
      const sharedBytes = new Uint8Array(shared)
      sharedBytes.set(bytes)
      return sharedBytes
    }
    return bytes
  }

  /**
   * Removes one exact version to simulate a substituted or missing predecessor.
   *
   * @param reference - Exact object version to remove.
   */
  removeExactVersion(
    reference: WorkspaceSearchMigrationImmutableArtifactReference,
  ): void {
    this.objects.delete(createStorageKey(reference))
  }

  /**
   * Makes the next reference for one role a Proxy.
   *
   * @param role - Exact semantic role to corrupt.
   */
  proxyNextReferenceForRole(role: string): void {
    this.proxyReferenceRole = role
  }

  /**
   * Makes the next reference for one role accessor-backed.
   *
   * @param role - Exact semantic role to corrupt.
   */
  accessorNextReferenceForRole(role: string): void {
    this.accessorReferenceRole = role
  }

  /**
   * Makes the next write return one invalid exact-version identifier.
   *
   * @param versionId - Invalid version identifier selected by the test.
   */
  invalidateNextVersionId(versionId: string): void {
    this.nextInvalidVersionId = versionId
  }

  /** Makes the next exact read body a Proxy. */
  proxyNextReadBody(): void {
    this.proxyNextRead = true
  }

  /** Makes the next exact read body SharedArrayBuffer-backed. */
  shareNextReadBody(): void {
    this.sharedNextRead = true
  }

  /**
   * Makes the next write raise one selected stable or raw failure.
   *
   * @param failure - Exact failure to raise.
   */
  failNextWrite(failure: Error): void {
    this.nextWriteFailure = failure
  }

  /**
   * Seeds one exact immutable object without recording a gateway call.
   *
   * @param objectKeyPrefix - Exact codec-owned key prefix.
   * @param role - Exact semantic storage role.
   * @param bytes - Exact immutable object bytes.
   * @param metadata - Exact caller-owned metadata.
   * @returns Deterministic rich immutable reference.
   */
  seedExactObject(
    objectKeyPrefix: string,
    role: string,
    bytes: Uint8Array,
    metadata: Readonly<Record<string, string>>,
  ): WorkspaceSearchMigrationImmutableArtifactReference {
    const detached = new Uint8Array(bytes)
    const contentDigest = digestBytes(detached)
    const reference = {
      objectKey:
        `${objectKeyPrefix}/${role}/${contentDigest}.artifact`,
      versionId: `seed-version-${this.nextVersion}`,
      contentDigest,
      byteLength: detached.byteLength,
      retainUntil,
    }
    this.nextVersion += 1
    this.objects.set(createStorageKey(reference), {
      bytes: detached,
      reference,
      metadata: { ...metadata },
      role,
      objectKeyPrefix,
    })
    return { ...reference }
  }
}

/**
 * Immutable port that pauses the first write after gateway preparation.
 */
class DelayedFirstWriteImmutableArtifactPort
implements WorkspaceSearchMigrationImmutableArtifactAwsPort {
  /** Exact-version delegate used after the controlled pause. */
  private readonly delegate = new InMemoryImmutableArtifactPort()

  /** Resolves when the first write invocation reaches the port. */
  readonly firstWriteStarted: Promise<void>

  /** Completes the first paused write when released by the test. */
  private readonly firstWriteReleased: Promise<void>

  /** Resolver for the first-write-started signal. */
  private firstWriteStartedResolver: (() => void) | undefined

  /** Resolver for the first-write release barrier. */
  private firstWriteReleasedResolver: (() => void) | undefined

  /** Whether the one controlled delay has already been claimed. */
  private delayed = false

  /** Creates one controlled first-write boundary. */
  constructor() {
    this.firstWriteStarted = new Promise((resolve) => {
      this.firstWriteStartedResolver = resolve
    })
    this.firstWriteReleased = new Promise((resolve) => {
      this.firstWriteReleasedResolver = resolve
    })
  }

  /** Ordered semantic storage calls observed by the delegate. */
  get calls(): readonly string[] {
    return this.delegate.calls
  }

  /**
   * Pauses the first exact write and delegates all storage behavior.
   *
   * @param input - Exact immutable object write input.
   * @returns Deterministic rich immutable reference.
   */
  async writeImmutableArtifact(
    input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<WorkspaceSearchMigrationImmutableArtifactReference> {
    if (!this.delayed) {
      this.delayed = true
      this.firstWriteStartedResolver?.()
      await this.firstWriteReleased
    }
    return this.delegate.writeImmutableArtifact(input)
  }

  /**
   * Delegates one exact immutable object read.
   *
   * @param input - Exact expected read identity and metadata.
   * @returns Detached exact stored bytes.
   */
  async readImmutableArtifact(
    input: ReadWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<Uint8Array> {
    return this.delegate.readImmutableArtifact(input)
  }

  /** Releases the first paused immutable write. */
  releaseFirstWrite(): void {
    this.firstWriteReleasedResolver?.()
  }
}

/**
 * Complete sealed plan fixture used by gateway tests.
 */
type PlanFixture = {
  /** Reviewed plan seal. */
  readonly seal: WorkspaceSearchPlanSeal
  /** Complete ordered operations bound to the seal. */
  readonly operations: readonly WorkspaceSearchPlannedOperation[]
}

describe('Workspace Search planning immutable artifact gateway', () => {
  test(
    'stores an empty plan as only its seal and compact head',
    async () => {
      const { gateway, port } = createGateway()
      const plan = createPlan(0)
      const stored = await gateway.writePlanArtifact({
        planSeal: plan.seal,
        operations: plan.operations,
        retainUntil,
      })
      expect(port.calls).toEqual([
        'write:plan-seals',
        'write:manifest-heads',
      ])
      port.calls.length = 0
      const replayed = await gateway.replayPlanArtifact(stored)
      expect(replayed.operations).toEqual([])
      expect(port.calls).toEqual([
        'read:plan-seals',
        'read:manifest-heads',
      ])
    },
  )

  test(
    'uploads plan leaves, pages, and head sequentially and replays through exact roots',
    async () => {
      const { gateway, port } = createGateway()
      const plan = createPlan(2)
      const stored = await gateway.writePlanArtifact({
        planSeal: plan.seal,
        operations: plan.operations,
        retainUntil,
      })
      expect(port.calls).toEqual([
        'write:plan-seals',
        'write:segments',
        'write:manifest-pages',
        'write:manifest-heads',
      ])
      expect(stored.planSealReference.retainUntil).toBe(retainUntil)
      expect(stored.manifestHeadReference.retainUntil).toBe(
        retainUntil,
      )

      port.calls.length = 0
      await expect(
        gateway.replayPlanArtifact({
          ...stored,
          planSealReference: {
            ...stored.planSealReference,
            byteLength:
              WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES + 1,
          },
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(port.calls).toEqual([])

      await expect(
        gateway.replayPlanArtifact({
          ...stored,
          manifestHeadReference: {
            ...stored.manifestHeadReference,
            byteLength:
              WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES + 1,
          },
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(port.calls).toEqual([])

      const replayed = await gateway.replayPlanArtifact(stored)
      expect(replayed.planSeal).toEqual(plan.seal)
      expect(replayed.operations).toEqual(plan.operations)
      expect(port.calls).toEqual([
        'read:plan-seals',
        'read:manifest-heads',
        'read:manifest-pages',
        'read:segments',
      ])
    },
  )

  test(
    'rejects Proxy and accessor references before writing a dependent head',
    async () => {
      const first = createGateway()
      const plan = createPlan(1)
      first.port.proxyNextReferenceForRole('plan-seals')
      await expect(
        first.gateway.writePlanArtifact({
          planSeal: plan.seal,
          operations: plan.operations,
          retainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(first.port.calls).toEqual(['write:plan-seals'])

      const second = createGateway()
      second.port.accessorNextReferenceForRole('segments')
      await expect(
        second.gateway.writePlanArtifact({
          planSeal: plan.seal,
          operations: plan.operations,
          retainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(second.port.returnedReferenceAccessorReads).toBe(0)
      expect(second.port.calls).not.toContain('write:manifest-heads')

      const third = createGateway()
      third.port.proxyNextReferenceForRole('manifest-pages')
      await expect(
        third.gateway.writePlanArtifact({
          planSeal: plan.seal,
          operations: plan.operations,
          retainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(third.port.calls).not.toContain('write:manifest-heads')
    },
  )

  test('rejects null and unpaired-surrogate version identifiers', async () => {
    for (const invalidVersionId of ['null', '\uD800']) {
      const { gateway, port } = createGateway()
      const plan = createPlan(0)
      port.invalidateNextVersionId(invalidVersionId)

      await expect(
        gateway.writePlanArtifact({
          planSeal: plan.seal,
          operations: plan.operations,
          retainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(port.calls).toEqual(['write:plan-seals'])
    }
  })

  test(
    'rejects Proxy and shared-memory read bodies at the gateway boundary',
    async () => {
      const { gateway, port } = createGateway()
      const plan = createPlan(1)
      const stored = await gateway.writePlanArtifact({
        planSeal: plan.seal,
        operations: plan.operations,
        retainUntil,
      })
      port.proxyNextReadBody()
      await expect(
        gateway.replayPlanArtifact(stored),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      port.shareNextReadBody()
      await expect(
        gateway.replayPlanArtifact(stored),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
    },
  )

  test(
    'preserves stable core failures and replaces unknown port errors',
    async () => {
      const first = createGateway()
      const plan = createPlan(0)
      const stableFailure = new WorkspaceSearchMigrationFailure(
        'TRANSIENT_INFRASTRUCTURE_FAILURE',
        'Trusted safe failure.',
      )
      first.port.failNextWrite(stableFailure)
      try {
        await first.gateway.writePlanArtifact({
          planSeal: plan.seal,
          operations: plan.operations,
          retainUntil,
        })
        throw new Error('Expected the stable core failure.')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
        if (!(error instanceof WorkspaceSearchMigrationFailure)) {
          throw error
        }
        expect(error.code).toBe('TRANSIENT_INFRASTRUCTURE_FAILURE')
        expect(error.message).not.toContain('Trusted safe failure.')
      }

      const second = createGateway()
      second.port.failNextWrite(
        new Error('untrusted raw injected-port detail'),
      )
      await expect(
        second.gateway.writePlanArtifact({
          planSeal: plan.seal,
          operations: plan.operations,
          retainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
    },
  )

  test(
    'rejects an accessor-backed gateway input without invoking it',
    () => {
      const port = new InMemoryImmutableArtifactPort()
      const input:
        CreateAwsWorkspaceSearchMigrationPlanningArtifactGatewayInput = {
          runId,
          configurationHash,
          immutableArtifactPort: port,
        }
      let reads = 0
      Reflect.defineProperty(input, 'runId', {
        enumerable: true,
        get: () => {
          reads += 1
          return runId
        },
      })
      expect(() =>
        createAwsWorkspaceSearchMigrationPlanningArtifactGateway(input)
      ).toThrow(WorkspaceSearchMigrationPlanningArtifactAwsError)
      expect(reads).toBe(0)
    },
  )

  test(
    'rejects an accessor-backed write input without invoking it or storage',
    async () => {
      const { gateway, port } = createGateway()
      const plan = createPlan(0)
      const input = {
        planSeal: plan.seal,
        operations: plan.operations,
        retainUntil,
      }
      let reads = 0
      Reflect.defineProperty(input, 'retainUntil', {
        enumerable: true,
        get: () => {
          reads += 1
          return retainUntil
        },
      })
      await expect(
        gateway.writePlanArtifact(input),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(reads).toBe(0)
      expect(port.calls).toEqual([])
    },
  )

  test(
    'rejects an aggregate plan-segment limit before starting storage',
    async () => {
      const { gateway, port } = createGateway()
      const plan = createPlan(1)
      await expect(
        gateway.writePlanArtifact({
          planSeal: plan.seal,
          operations: plan.operations,
          maximumTotalPlanSegmentBytes: 1,
          retainUntil,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(port.calls).toEqual([])
    },
  )

  test(
    'preflights manifest-declared aggregate segment bytes before any segment GET',
    async () => {
      const { gateway, port } = createGateway()
      const plan = createPlan(17)
      const planSealBytes =
        serializeWorkspaceSearchPlanSeal(plan.seal)
      const metadata = createPlanStorageMetadata()
      const planSealReference = port.seedExactObject(
        WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
        'plan-seals',
        planSealBytes,
        metadata,
      )
      const oversizedSegmentByteLength =
        Math.floor(
          WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES / 16,
        )
      const segmentReferences:
        WorkspaceSearchMigrationPlanArtifactReference[] =
        Array.from({ length: 17 }, (_, index) => {
          const contentDigest = digestText(
            `oversized-segment:${index}`,
          )
          return {
            objectKey:
              `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/segments/${contentDigest}.artifact`,
            versionId: `missing-segment-version-${index}`,
            contentDigest,
            byteLength: oversizedSegmentByteLength,
            retainUntil,
          }
        })
      const page: WorkspaceSearchMigrationPlanManifestPage = {
        kind: 'workspace-search-migration-plan-manifest-page',
        artifactVersion: 1,
        migrationId: 'workspace-search-maintenance',
        migrationVersion: 1,
        runId,
        configurationHash,
        planDigest: plan.seal.planDigest,
        planSealContentDigest: digestBytes(planSealBytes),
        planOperationCount: 17,
        planSegmentCount: 17,
        pageSequence: 1,
        previousPageReference: null,
        segments: segmentReferences.map((reference, index) => ({
          segmentSequence: index + 1,
          operationStartSequence: index + 1,
          segmentOperationCount: 1,
          reference,
        })),
      }
      const pageReference = port.seedExactObject(
        WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
        'manifest-pages',
        encodeCanonical(page),
        metadata,
      )
      const terminalSegmentReference = segmentReferences.at(-1)
      if (terminalSegmentReference === undefined) {
        throw new Error('Missing terminal oversized segment reference.')
      }
      const head: WorkspaceSearchMigrationPlanManifestHead = {
        kind: 'workspace-search-migration-plan-manifest-head',
        artifactVersion: 1,
        migrationId: 'workspace-search-maintenance',
        migrationVersion: 1,
        runId,
        configurationHash,
        planDigest: plan.seal.planDigest,
        planSealContentDigest: digestBytes(planSealBytes),
        planOperationCount: 17,
        planSegmentCount: 17,
        manifestPageCount: 1,
        terminalSegmentReference,
        terminalManifestPageReference: pageReference,
      }
      const oversizedPageHeadReference = port.seedExactObject(
        WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
        'manifest-heads',
        encodeCanonical({
          ...head,
          terminalManifestPageReference: {
            ...pageReference,
            byteLength:
              WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_BYTES + 1,
          },
        }),
        metadata,
      )
      await expect(
        gateway.replayPlanArtifact({
          planSealReference,
          manifestHeadReference: oversizedPageHeadReference,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(port.calls).toEqual([
        'read:plan-seals',
        'read:manifest-heads',
      ])
      port.calls.length = 0

      const manifestHeadReference = port.seedExactObject(
        WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
        'manifest-heads',
        encodeCanonical(head),
        metadata,
      )

      await expect(
        gateway.replayPlanArtifact({
          planSealReference,
          manifestHeadReference,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(port.calls).toEqual([
        'read:plan-seals',
        'read:manifest-heads',
        'read:manifest-pages',
      ])
    },
  )

  test(
    'rejects a plan root with a different graph retention before reading',
    async () => {
      const { gateway, port } = createGateway()
      const plan = createPlan(1)
      const stored = await gateway.writePlanArtifact({
        planSeal: plan.seal,
        operations: plan.operations,
        retainUntil,
      })
      port.calls.length = 0
      await expect(
        gateway.replayPlanArtifact({
          planSealReference: stored.planSealReference,
          manifestHeadReference: {
            ...stored.manifestHeadReference,
            retainUntil: '2026-08-29T01:00:00.000Z',
          },
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(port.calls).toEqual([])
    },
  )

  test(
    'does not reread caller-owned plan inputs after the first upload begins',
    async () => {
      const port = new DelayedFirstWriteImmutableArtifactPort()
      const gateway =
        createAwsWorkspaceSearchMigrationPlanningArtifactGateway({
          runId,
          configurationHash,
          immutableArtifactPort: port,
        })
      const fixture = createPlan(1)
      const originalSeal = structuredClone(fixture.seal)
      const originalOperations = structuredClone(fixture.operations)
      const callerSeal = structuredClone(fixture.seal)
      const callerOperations = [...fixture.operations]
      const pending = gateway.writePlanArtifact({
        planSeal: callerSeal,
        operations: callerOperations,
        retainUntil,
      })
      await port.firstWriteStarted
      Reflect.set(callerSeal, 'runId', 'mutated-after-await')
      callerOperations.splice(0)
      port.releaseFirstWrite()
      const stored = await pending

      const replayed = await gateway.replayPlanArtifact(stored)
      expect(replayed.planSeal).toEqual(originalSeal)
      expect(replayed.operations).toEqual(originalOperations)
    },
  )

  test(
    'uploads and replays provenance from only the exact compact-head reference',
    async () => {
      const { gateway, port } = createGateway()
      const artifact = createProvenanceArtifact()
      const stored =
        await gateway.writePlanningProvenanceArtifact({
          artifact,
          maximumManifestPageBytes: 20_000,
          maximumSegmentBytes: 8_192,
          retainUntil,
        })
      expect(stored.manifestHead.summary.objectKeyPrefix).toBe(
        `${WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_OBJECT_KEY_PREFIX}/${runId}/${configurationHash}`,
      )
      expect(port.calls.slice(0, 2)).toEqual([
        'write:segments',
        'write:segments',
      ])
      expect(port.calls.at(-1)).toBe('write:manifest-heads')
      expect(stored.manifestHead.manifestPageCount).toBeGreaterThan(1)

      port.calls.length = 0
      await expect(
        gateway.replayPlanningProvenanceArtifact({
          manifestHeadReference: {
            ...stored.manifestHeadReference,
            byteLength:
              WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_HEAD_MAX_BYTES +
              1,
          },
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(port.calls).toEqual([])

      const replayed =
        await gateway.replayPlanningProvenanceArtifact({
          manifestHeadReference: stored.manifestHeadReference,
        })
      expect(replayed).toEqual(artifact)
      expect(port.calls[0]).toBe('read:manifest-heads')
      expect(port.calls).toContain('read:manifest-pages')
      expect(port.calls).toContain('read:segments')
    },
  )

  test(
    'rejects aggregate provenance segment bytes before any segment GET',
    async () => {
      const { gateway, port } = createGateway()
      const stored =
        await gateway.writePlanningProvenanceArtifact({
          artifact: createProvenanceArtifact(),
          maximumSegmentBytes: 8_192,
          retainUntil,
        })
      const summary = stored.manifestHead.summary
      const objectKeyPrefix = summary.objectKeyPrefix
      const segmentCount =
        Math.floor(
          WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MAX_TOTAL_SEGMENT_BYTES /
            WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
        ) + 1
      const segmentLocators:
        WorkspaceSearchMigrationPlanningProvenanceSegmentLocator[] =
        Array.from({ length: segmentCount }, (_, index) => {
          const contentDigest = digestText(
            `oversized-provenance-segment:${index}`,
          )
          return {
            role: index === segmentCount - 1
              ? 'historical-receipts'
              : 'evidence-pages',
            segmentIndex: index,
            segmentCount,
            entryStartIndex:
              index === segmentCount - 1 ? 0 : index,
            entryCount: 1,
            segmentDigest: digestText(
              `oversized-provenance-segment-document:${index}`,
            ),
            reference: {
              objectKey:
                `${objectKeyPrefix}/segments/${contentDigest}.artifact`,
              versionId: `missing-segment-version-${index}`,
              contentDigest,
              byteLength:
                WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_SEGMENT_MAX_BYTES,
              retainUntil,
            },
          }
        })
      const pageFields = {
        kind: 'workspace-search-planning-provenance-manifest-page',
        manifestPageVersion: 1,
        summary,
        pageIndex: 0,
        pageCount: 1,
        segmentStartIndex: 0,
        segmentCount,
        segments: segmentLocators,
        previousPageReference: null,
      } satisfies Omit<
        WorkspaceSearchMigrationPlanningProvenanceManifestPage,
        'pageDigest'
      >
      const page:
        WorkspaceSearchMigrationPlanningProvenanceManifestPage = {
          ...pageFields,
          pageDigest: createMigrationDigest(pageFields),
        }
      const pageReference = port.seedExactObject(
        objectKeyPrefix,
        'manifest-pages',
        encodeCanonical(page),
        createProvenanceStorageMetadata(),
      )
      const terminalManifestPageLocator:
        WorkspaceSearchMigrationPlanningProvenanceManifestPageLocator = {
          pageIndex: 0,
          pageCount: 1,
          segmentStartIndex: 0,
          segmentCount,
          pageDigest: page.pageDigest,
          reference: pageReference,
        }
      const headFields = {
        kind: 'workspace-search-planning-provenance-manifest-head',
        manifestHeadVersion: 1,
        summary,
        segmentCount,
        evidenceSegmentCount: segmentCount - 1,
        receiptSegmentCount: 1,
        manifestPageCount: 1,
        manifestPageLocatorsDigest: createMigrationDigest({
          kind:
            'workspace-search-planning-provenance-manifest-page-locators',
          locatorSetVersion: 1,
          manifestPages: [terminalManifestPageLocator],
        }),
        terminalManifestPageLocator,
      } satisfies Omit<
        WorkspaceSearchMigrationPlanningProvenanceManifestHead,
        'headDigest'
      >
      const head:
        WorkspaceSearchMigrationPlanningProvenanceManifestHead = {
          ...headFields,
          headDigest: createMigrationDigest(headFields),
        }
      const oversizedTerminalManifestPageLocator = {
        ...terminalManifestPageLocator,
        reference: {
          ...pageReference,
          byteLength:
            WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_MANIFEST_PAGE_MAX_BYTES +
            1,
        },
      }
      const oversizedPageHeadFields = {
        ...headFields,
        manifestPageLocatorsDigest: createMigrationDigest({
          kind:
            'workspace-search-planning-provenance-manifest-page-locators',
          locatorSetVersion: 1,
          manifestPages: [oversizedTerminalManifestPageLocator],
        }),
        terminalManifestPageLocator:
          oversizedTerminalManifestPageLocator,
      }
      const oversizedPageHeadReference = port.seedExactObject(
        objectKeyPrefix,
        'manifest-heads',
        encodeCanonical({
          ...oversizedPageHeadFields,
          headDigest: createMigrationDigest(oversizedPageHeadFields),
        }),
        createProvenanceStorageMetadata(),
      )
      port.calls.length = 0
      await expect(
        gateway.replayPlanningProvenanceArtifact({
          manifestHeadReference: oversizedPageHeadReference,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(port.calls).toEqual(['read:manifest-heads'])

      const manifestHeadReference = port.seedExactObject(
        objectKeyPrefix,
        'manifest-heads',
        encodeCanonical(head),
        createProvenanceStorageMetadata(),
      )
      port.calls.length = 0

      await expect(
        gateway.replayPlanningProvenanceArtifact({
          manifestHeadReference,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
      expect(port.calls).toEqual([
        'read:manifest-heads',
        'read:manifest-pages',
      ])
    },
  )

  test(
    'does not reread caller-owned provenance after the first upload begins',
    async () => {
      const port = new DelayedFirstWriteImmutableArtifactPort()
      const gateway =
        createAwsWorkspaceSearchMigrationPlanningArtifactGateway({
          runId,
          configurationHash,
          immutableArtifactPort: port,
        })
      const artifact = createProvenanceArtifact()
      const original = structuredClone(artifact)
      const pending =
        gateway.writePlanningProvenanceArtifact({
          artifact,
          maximumSegmentBytes: 8_192,
          retainUntil,
        })
      await port.firstWriteStarted
      Reflect.set(artifact, 'runId', 'mutated-after-await')
      Reflect.set(artifact, 'historicalReceipts', [])
      port.releaseFirstWrite()
      const stored = await pending

      expect(
        await gateway.replayPlanningProvenanceArtifact({
          manifestHeadReference: stored.manifestHeadReference,
        }),
      ).toEqual(original)
    },
  )

  test(
    'fails closed when an exact provenance predecessor version is missing',
    async () => {
      const { gateway, port } = createGateway()
      const stored =
        await gateway.writePlanningProvenanceArtifact({
          artifact: createProvenanceArtifact(),
          maximumSegmentBytes: 8_192,
          retainUntil,
        })
      port.removeExactVersion(
        stored.manifestHead.terminalManifestPageLocator.reference,
      )
      await expect(
        gateway.replayPlanningProvenanceArtifact({
          manifestHeadReference: stored.manifestHeadReference,
        }),
      ).rejects.toBeInstanceOf(
        WorkspaceSearchMigrationPlanningArtifactAwsError,
      )
    },
  )
})

/**
 * Creates one gateway and its exact-version in-memory port.
 *
 * @returns Run-bound gateway and observable storage port.
 */
function createGateway(): {
  /** Run-bound planning artifact gateway. */
  readonly gateway: WorkspaceSearchMigrationPlanningArtifactAwsGateway
  /** Observable exact-version in-memory storage port. */
  readonly port: InMemoryImmutableArtifactPort
} {
  const port = new InMemoryImmutableArtifactPort()
  return {
    port,
    gateway:
      createAwsWorkspaceSearchMigrationPlanningArtifactGateway({
        runId,
        configurationHash,
        immutableArtifactPort: port,
      }),
  }
}

/**
 * Creates one valid source-derived Team operation.
 *
 * @param index - Stable fixture index.
 * @returns Internally consistent migration operation.
 */
function createOperation(index: number): WorkspaceSearchMigrationOperation {
  const teamId = `team-${String(index).padStart(4, '0')}`
  const sourceKey = {
    directoryId: { S: 'workspace-1' },
    entryKey: {
      S: `${String(index).padStart(6, '0')}#000000#TEAM#${teamId}`,
    },
  }
  const sourceItem: Record<string, AttributeValue> = {
    ...sourceKey,
    entryType: { S: 'team' },
    teamId: { S: teamId },
    teamSortOrder: { N: String(index) },
    nameJa: { S: `チーム ${index}` },
    nameEn: { S: `Team ${index}` },
    expanded: { BOOL: true },
  }
  const document = createTeamWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    teamId,
    title: `チーム ${index}`,
    subtitle: `Team ${index}`,
  })
  const targetItem = encodeWorkspaceSearchMigrationDocument(document)
  const targetKey = {
    workspaceId: targetItem.workspaceId,
    recordKey: targetItem.recordKey,
  }
  if (!targetKey.workspaceId || !targetKey.recordKey) {
    throw new Error('Fixture target key is incomplete.')
  }
  const sourceKeyDigest = createAttributeMapDigest(sourceKey)
  const targetKeyDigest = createAttributeMapDigest(targetKey)
  return {
    operationId: createWorkspaceSearchOperationId({
      configurationHash,
      sourceTableId: '00000000-0000-0000-0000-000000000001',
      sourceKeyDigest,
      targetKeyDigest,
    }),
    sourceCondition: {
      exists: true,
      source: 'project-directory',
      tableId: '00000000-0000-0000-0000-000000000001',
      tableName: 'project-directory-production',
      key: sourceKey,
      keyDigest: sourceKeyDigest,
      item: sourceItem,
      itemDigest: createAttributeMapDigest(sourceItem),
    },
    targetKey,
    targetKeyDigest,
    before: {
      exists: false,
      digest: createAbsentMigrationItemDigest(),
    },
    after: {
      exists: true,
      item: targetItem,
      digest: createAttributeMapDigest(targetItem),
    },
    entityType: 'team',
  }
}

/**
 * Creates a valid ordered Merkle-sealed operation plan.
 *
 * @param count - Exact planned-operation count.
 * @returns Complete sealed plan fixture.
 */
function createPlan(count: number): PlanFixture {
  if (count === 0) {
    return {
      seal: createSeal(createEmptyWorkspaceSearchPlanDigest(), 0),
      operations: [],
    }
  }
  const raw = Array.from({ length: count }, (_, index) => {
    const operation = createOperation(index + 1)
    return {
      operation,
      operationDigest:
        createWorkspaceSearchMigrationOperationDigest(operation),
    }
  })
  const levels: string[][] = [
    raw.map(({ operationDigest }, index) =>
      createWorkspaceSearchPlanLeafDigest({
        planSequence: index + 1,
        operationDigest,
      })
    ),
  ]
  while ((levels.at(-1)?.length ?? 0) > 1) {
    const current = levels.at(-1)
    if (current === undefined) throw new Error('Missing Merkle level.')
    const next: string[] = []
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index]
      const right = current[index + 1] ?? left
      if (left === undefined || right === undefined) {
        throw new Error('Incomplete Merkle fixture.')
      }
      next.push(createWorkspaceSearchPlanNodeDigest(left, right))
    }
    levels.push(next)
  }
  const planDigest = levels.at(-1)?.[0]
  if (planDigest === undefined) throw new Error('Missing plan root.')
  const operations = raw.map(
    ({ operation, operationDigest }, operationIndex) => ({
      runId,
      configurationHash,
      planDigest,
      planSequence: operationIndex + 1,
      operationDigest,
      membershipProof: createMembershipProof(levels, operationIndex),
      operation,
    }),
  )
  return { seal: createSeal(planDigest, count), operations }
}

/**
 * Creates one operation's ordered Merkle membership proof.
 *
 * @param levels - Complete Merkle levels beginning with leaves.
 * @param leafIndex - Zero-based operation leaf index.
 * @returns Ordered proof steps.
 */
function createMembershipProof(
  levels: readonly (readonly string[])[],
  leafIndex: number,
): readonly WorkspaceSearchPlanMembershipProofStep[] {
  const proof: WorkspaceSearchPlanMembershipProofStep[] = []
  let index = leafIndex
  for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex += 1) {
    const level = levels[levelIndex]
    if (level === undefined) throw new Error('Missing proof level.')
    const current = level[index]
    const isLeft = index % 2 === 0
    const sibling = isLeft
      ? level[index + 1] ?? current
      : level[index - 1]
    if (sibling === undefined) throw new Error('Missing proof sibling.')
    proof.push({ side: isLeft ? 'right' : 'left', digest: sibling })
    index = Math.floor(index / 2)
  }
  return proof
}

/**
 * Creates a plan seal for one fixture root and count.
 *
 * @param planDigest - Exact Merkle root.
 * @param count - Exact operation count.
 * @returns Valid strict plan seal.
 */
function createSeal(
  planDigest: string,
  count: number,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: 'workspace-search-maintenance',
    migrationVersion: 1,
    runId,
    configurationHash,
    dryRunEvidenceDigest: createMigrationDigest('dry-run'),
    planningSnapshotDigest: createMigrationDigest('snapshot'),
    planDigest,
    planOperationCount: count,
    sourceOperationCount: count,
    orphanOperationCount: 0,
    createdAt: '2026-07-28T01:00:00.000Z',
  }
}

/**
 * Creates one coherent strict full provenance artifact fixture.
 *
 * @returns Full artifact accepted by the segmented provenance boundary.
 */
function createProvenanceArtifact():
  WorkspaceSearchMigrationPlanningProvenanceArtifact {
  const receipt = createReceipt()
  const receiptDigest = createMigrationDigest(receipt)
  const authority: WorkspaceSearchMigrationPlanningAuthorityBinding = {
    ownerId,
    fenceToken: receipt.fenceToken,
    maintenanceEvidencePointerRevision: 11,
    maintenanceEvidenceReceiptDigest: receiptDigest,
  }
  return createWorkspaceSearchMigrationPlanningProvenanceArtifact({
    sourceEvidencePageBytes: {
      'project-directory': createSourceEvidencePageChain(
        'project-directory',
        authority,
        12,
      ),
      'work-items': [
        createTerminalSourceEvidencePage('work-items', authority),
      ],
      collaboration: [
        createTerminalSourceEvidencePage('collaboration', authority),
      ],
      documents: [
        createTerminalSourceEvidencePage('documents', authority),
      ],
    },
    targetEvidencePageBytes: [
      createTerminalTargetEvidencePage(authority),
    ],
    historicalReceiptBindings: [{
      configurationHash,
      stateTableId: tableIds['migration-state'],
      ownerId,
      receiptDigest,
      receipt,
    }],
  })
}

/**
 * Creates one completed multi-page empty source evidence chain.
 *
 * @param source - Fixed logical source chain.
 * @param authority - Exact durable planning authority.
 * @param pageCount - Positive page count.
 * @returns Canonical evidence-page bytes in predecessor order.
 */
function createSourceEvidencePageChain(
  source: WorkspaceSearchMigrationSourceName,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
  pageCount: number,
): readonly Uint8Array[] {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    source,
    sourceTableId: tableIds[source],
    stateTableId: tableIds['migration-state'],
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationSourceEvidenceProgress
  >[0]
  let progress =
    createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
  const pageBytes: Uint8Array[] = []
  for (let index = 0; index < pageCount; index += 1) {
    const completed = index === pageCount - 1
    const artifactDigest = digestText(
      `source-artifact:${source}:${index}`,
    )
    const page = createWorkspaceSearchMigrationSourceEvidencePage({
      identity,
      planningAuthority: authority,
      sourceArtifacts: [{
        objectKey:
          createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey(
            artifactDigest,
          ),
        versionId: `source-version-${source}-${index}`,
        contentDigest: artifactDigest,
      }],
      previousProgress: progress,
      pageResult: {
        checkpoint: {
          completed,
          ...(
            completed
              ? {}
              : { cursor: { page: { N: String(index + 1) } } }
          ),
          aggregate: {
            ...progress.checkpoint.aggregate,
            pageCount: index + 1,
          },
          keyDigestState: {
            ...progress.checkpoint.keyDigestState,
          },
          contentDigestState: {
            ...progress.checkpoint.contentDigestState,
          },
        },
        sourceRows: [],
        invalidRows: [],
        sourceBindings: [],
      },
    })
    pageBytes.push(
      serializeWorkspaceSearchMigrationSourceEvidencePage(page),
    )
    progress =
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(progress, page)
  }
  return pageBytes
}

/**
 * Creates one completed empty planning source evidence page.
 *
 * @param source - Fixed logical source chain.
 * @param authority - Exact durable planning authority.
 * @returns Exact canonical source evidence-page bytes.
 */
function createTerminalSourceEvidencePage(
  source: WorkspaceSearchMigrationSourceName,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
): Uint8Array {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    source,
    sourceTableId: tableIds[source],
    stateTableId: tableIds['migration-state'],
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationSourceEvidenceProgress
  >[0]
  const initial =
    createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
  const artifactDigest = digestText(`source-artifact:${source}`)
  const page = createWorkspaceSearchMigrationSourceEvidencePage({
    identity,
    planningAuthority: authority,
    sourceArtifacts: [{
      objectKey:
        createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey(
          artifactDigest,
        ),
      versionId: `source-version-${source}`,
      contentDigest: artifactDigest,
    }],
    previousProgress: initial,
    pageResult: {
      checkpoint: {
        ...initial.checkpoint,
        completed: true,
        aggregate: {
          ...initial.checkpoint.aggregate,
          pageCount: 1,
        },
      },
      sourceRows: [],
      invalidRows: [],
      sourceBindings: [],
    },
  })
  void advanceWorkspaceSearchMigrationSourceEvidenceProgress(
    initial,
    page,
  )
  return serializeWorkspaceSearchMigrationSourceEvidencePage(page)
}

/**
 * Creates one completed empty planning target evidence page.
 *
 * @param authority - Exact durable planning authority.
 * @returns Exact canonical target evidence-page bytes.
 */
function createTerminalTargetEvidencePage(
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
): Uint8Array {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    targetTableId: tableIds['workspace-search'],
    stateTableId: tableIds['migration-state'],
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationTargetEvidenceProgress
  >[0]
  const initial =
    createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
  const artifactDigest = digestText('target-artifact')
  const page = createWorkspaceSearchMigrationTargetEvidencePage({
    identity,
    planningAuthority: authority,
    targetArtifacts: [{
      objectKey:
        createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
          artifactDigest,
        ),
      versionId: 'target-version-1',
      contentDigest: artifactDigest,
    }],
    previousProgress: initial,
    pageResult: {
      checkpoint: {
        ...initial.checkpoint,
        completed: true,
        aggregate: {
          ...initial.checkpoint.aggregate,
          pageCount: 1,
        },
      },
      targetRows: [],
      invalidRows: [],
      observedTargetBindings: [],
    },
  })
  return serializeWorkspaceSearchMigrationTargetEvidencePage(page)
}

/** Fixed six-table physical identity fixture. */
const tableIds: WorkspaceSearchMigrationSealedPlanningTableIds = {
  'project-directory': 'project-directory-table-id',
  'work-items': 'work-items-table-id',
  collaboration: 'collaboration-table-id',
  documents: 'documents-table-id',
  'workspace-search': 'workspace-search-table-id',
  'migration-state': 'migration-state-table-id',
}

/**
 * Creates one canonical historical maintenance receipt.
 *
 * @returns Strict receipt bound to the fixture transition.
 */
function createReceipt(): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digestText('maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/manifest-fixture.json',
    runtimeRevision: 3,
    fenceToken: 7,
    validatedAt: '2026-07-28T00:02:00.000Z',
    oldestObservationAt: '2026-07-28T00:01:00.000Z',
    validUntil: '2026-07-28T00:06:00.001Z',
  }
}

/**
 * Creates one exact storage lookup key.
 *
 * @param reference - Exact rich immutable reference.
 * @returns Collision-free object-key and version lookup key.
 */
function createStorageKey(
  reference: WorkspaceSearchMigrationImmutableArtifactReference,
): string {
  return `${reference.objectKey}\u0000${reference.versionId}`
}

/**
 * Compares two exact rich immutable references.
 *
 * @param left - First exact reference.
 * @param right - Second exact reference.
 * @returns Whether every rich identity field matches.
 */
function referencesEqual(
  left: WorkspaceSearchMigrationImmutableArtifactReference,
  right: WorkspaceSearchMigrationImmutableArtifactReference,
): boolean {
  return (
    left.objectKey === right.objectKey &&
    left.versionId === right.versionId &&
    left.contentDigest === right.contentDigest &&
    left.byteLength === right.byteLength &&
    left.retainUntil === right.retainUntil
  )
}

/**
 * Compares exact caller-owned metadata maps.
 *
 * @param left - First metadata map.
 * @param right - Second metadata map.
 * @returns Whether both maps contain identical entries.
 */
function metadataEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort()
  const rightEntries = Object.entries(right).sort()
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        key === rightEntries[index]?.[0] &&
        value === rightEntries[index]?.[1],
    )
  )
}

/**
 * Creates the exact plan metadata expected by the run-bound gateway.
 *
 * @returns Exact nonsecret caller-owned metadata.
 */
function createPlanStorageMetadata(): Readonly<Record<string, string>> {
  return {
    'mukuroji-planning-artifact-bundle': 'plan',
    'mukuroji-planning-run-id': runId,
    'mukuroji-planning-configuration-sha256': configurationHash,
  }
}

/**
 * Creates the exact provenance metadata expected by the run-bound gateway.
 *
 * @returns Exact nonsecret caller-owned metadata.
 */
function createProvenanceStorageMetadata():
  Readonly<Record<string, string>> {
  return {
    'mukuroji-planning-artifact-bundle': 'provenance',
    'mukuroji-planning-run-id': runId,
    'mukuroji-planning-configuration-sha256': configurationHash,
  }
}

/**
 * Encodes one strict JSON-compatible fixture canonically.
 *
 * @param value - Strict fixture value.
 * @returns Canonical UTF-8 JSON bytes.
 */
function encodeCanonical(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Computes the SHA-256 digest of exact bytes.
 *
 * @param bytes - Exact immutable bytes.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Computes a stable SHA-256 fixture digest.
 *
 * @param value - Stable fixture label.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
