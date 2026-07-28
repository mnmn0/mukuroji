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
  type WorkspaceSearchMigrationOperation,
  type WorkspaceSearchPlanSeal,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationPlanArtifactSegment,
  parseWorkspaceSearchMigrationPlanManifestHead,
  replayWorkspaceSearchMigrationPlanArtifact,
  serializeWorkspaceSearchMigrationPlanArtifactSegments,
  serializeWorkspaceSearchMigrationPlanManifestHead,
  serializeWorkspaceSearchMigrationPlanManifestPage,
  type WorkspaceSearchMigrationPlanArtifactEncodedSegment,
  WorkspaceSearchMigrationPlanArtifactError,
  type WorkspaceSearchMigrationPlanArtifactStoredObject,
  type WorkspaceSearchMigrationPlanManifestEncodedPage,
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
} from './migration-plan-artifact'
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

/** Complete sealed plan fixture used by artifact tests. */
type PlanFixture = {
  /** Reviewed plan seal. */
  readonly seal: WorkspaceSearchPlanSeal
  /** Ordered operations bound to the seal. */
  readonly operations: readonly WorkspaceSearchPlannedOperation[]
}

/** Fully staged in-memory artifact bundle. */
type StagedFixture = {
  /** Canonical segment encodings. */
  readonly encodedSegments:
    readonly WorkspaceSearchMigrationPlanArtifactEncodedSegment[]
  /** Exact stored segment objects. */
  readonly storedSegments:
    readonly WorkspaceSearchMigrationPlanArtifactStoredObject[]
  /** Canonical manifest-page encodings. */
  readonly encodedPages:
    readonly WorkspaceSearchMigrationPlanManifestEncodedPage[]
  /** Exact stored manifest-page objects. */
  readonly storedPages:
    readonly WorkspaceSearchMigrationPlanArtifactStoredObject[]
  /** Compact canonical head bytes. */
  readonly headBytes: Uint8Array
}

/**
 * Creates one valid source-derived Team operation.
 *
 * @param index - Stable fixture index.
 * @param payloadLength - Optional exact source payload length.
 * @returns Internally consistent migration operation.
 */
function createOperation(
  index: number,
  payloadLength = 0,
): WorkspaceSearchMigrationOperation {
  const teamId = `team-${String(index).padStart(4, '0')}`
  const configurationHash = 'a'.repeat(64)
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
    ...(payloadLength === 0
      ? {}
      : { artifactPayload: { S: 'x'.repeat(payloadLength) } }),
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
 * @param payloadLength - Optional source payload length per operation.
 * @returns Complete sealed plan fixture.
 */
function createPlan(count: number, payloadLength = 0): PlanFixture {
  if (count === 0) {
    return {
      seal: createSeal(createEmptyWorkspaceSearchPlanDigest(), 0),
      operations: [],
    }
  }
  const raw = Array.from({ length: count }, (_, index) => {
    const operation = createOperation(index + 1, payloadLength)
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
      runId: 'artifact-run',
      configurationHash: 'a'.repeat(64),
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
    runId: 'artifact-run',
    configurationHash: 'a'.repeat(64),
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
 * Adds deterministic immutable storage metadata to encoded bytes.
 *
 * @param encoded - Content-addressed encoded object.
 * @param sequence - Stable fixture version sequence.
 * @returns Exact stored object.
 */
function storeEncoded(
  encoded: {
    /** Deterministic object key. */
    readonly objectKey: string
    /** Exact byte content digest. */
    readonly contentDigest: string
    /** Exact byte length. */
    readonly byteLength: number
    /** Exact canonical bytes. */
    readonly bytes: Uint8Array
  },
  sequence: number,
): WorkspaceSearchMigrationPlanArtifactStoredObject {
  return {
    reference: {
      objectKey: encoded.objectKey,
      versionId: `version-${sequence}`,
      contentDigest: encoded.contentDigest,
      byteLength: encoded.byteLength,
      retainUntil: '2026-08-28T01:00:00.000Z',
    },
    bytes: new Uint8Array(encoded.bytes),
  }
}

/**
 * Stages segments, manifest pages, and a compact head entirely in memory.
 *
 * @param plan - Complete sealed plan.
 * @returns Complete staged replay fixture.
 */
function stagePlan(plan: PlanFixture): StagedFixture {
  const encodedSegments =
    serializeWorkspaceSearchMigrationPlanArtifactSegments(
      plan.seal,
      plan.operations,
    )
  const storedSegments = encodedSegments.map(storeEncoded)
  const encodedPages: WorkspaceSearchMigrationPlanManifestEncodedPage[] = []
  const storedPages: WorkspaceSearchMigrationPlanArtifactStoredObject[] = []
  let previousPage:
    WorkspaceSearchMigrationPlanArtifactStoredObject | null = null
  for (
    let start = 0;
    start < storedSegments.length;
    start += WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES
  ) {
    const encodedPage =
      serializeWorkspaceSearchMigrationPlanManifestPage({
        planSeal: plan.seal,
        planSegmentCount: storedSegments.length,
        pageSequence: encodedPages.length + 1,
        previousPage,
        segments: storedSegments.slice(
          start,
          start +
            WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES,
        ),
      })
    const storedPage = storeEncoded(
      encodedPage,
      storedSegments.length + encodedPages.length + 1,
    )
    encodedPages.push(encodedPage)
    storedPages.push(storedPage)
    previousPage = storedPage
  }
  const head =
    serializeWorkspaceSearchMigrationPlanManifestHead({
      planSeal: plan.seal,
      manifestPages: storedPages,
      segments: storedSegments,
    })
  return {
    encodedSegments,
    storedSegments,
    encodedPages,
    storedPages,
    headBytes: head.bytes,
  }
}

/**
 * Requires one callback to fail at the stable plan-artifact boundary.
 *
 * @param operation - Invalid artifact operation.
 */
function expectArtifactFailure(operation: () => unknown): void {
  expect(operation).toThrow(WorkspaceSearchMigrationPlanArtifactError)
}

describe('migration plan artifact codec', () => {
  test('canonically represents and replays an empty sealed plan', () => {
    const plan = createPlan(0)
    const staged = stagePlan(plan)
    expect(staged.encodedSegments).toEqual([])
    expect(staged.encodedPages).toEqual([])
    const head = parseWorkspaceSearchMigrationPlanManifestHead(
      staged.headBytes,
    )
    expect(head).toMatchObject({
      planOperationCount: 0,
      planSegmentCount: 0,
      manifestPageCount: 0,
      terminalSegmentReference: null,
      terminalManifestPageReference: null,
    })
    expect(replayWorkspaceSearchMigrationPlanArtifact({
      planSeal: plan.seal,
      manifestHeadBytes: staged.headBytes,
      manifestPages: [],
      segments: [],
    }).operations).toEqual([])
  })

  test('round-trips one operation through staged exact references', () => {
    const plan = createPlan(1)
    const staged = stagePlan(plan)
    expect(staged.encodedSegments).toHaveLength(1)
    expect(staged.encodedPages).toHaveLength(1)
    expect(staged.encodedSegments[0]?.objectKey).toBe(
      `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/segments/${staged.encodedSegments[0]?.contentDigest}.artifact`,
    )
    const replayed = replayWorkspaceSearchMigrationPlanArtifact({
      planSeal: plan.seal,
      manifestHeadBytes: staged.headBytes,
      manifestPages: staged.storedPages,
      segments: staged.storedSegments,
    })
    expect(replayed.operations).toEqual(plan.operations)
    const storedPage = staged.storedPages[0]
    if (storedPage === undefined) throw new Error('Missing stored page.')
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanManifestHead({
        planSeal: plan.seal,
        manifestPages: [{
          reference: {
            ...storedPage.reference,
            objectKey: storedPage.reference.objectKey.replace(
              '/manifest-pages/',
              '/segments/',
            ),
          },
          bytes: storedPage.bytes,
        }],
        segments: staged.storedSegments,
      })
    )
  })

  test(
    'deterministically segments a large valid plan and rejects graph substitutions',
    () => {
      const plan = createPlan(45, 390_000)
      const first = stagePlan(plan)
      const second =
        serializeWorkspaceSearchMigrationPlanArtifactSegments(
          plan.seal,
          plan.operations,
        )
      expect(first.encodedSegments.length).toBeGreaterThan(1)
      expect(second.map(({ bytes }) => bytes)).toEqual(
        first.encodedSegments.map(({ bytes }) => bytes),
      )
      const aggregateSegmentBytes = first.encodedSegments.reduce(
        (total, segment) => total + segment.byteLength,
        0,
      )
      const largestSegmentBytes = Math.max(
        ...first.encodedSegments.map(({ byteLength }) => byteLength),
      )
      expect(largestSegmentBytes).toBeLessThan(
        aggregateSegmentBytes - 1,
      )
      expect(
        serializeWorkspaceSearchMigrationPlanArtifactSegments(
          plan.seal,
          plan.operations,
          aggregateSegmentBytes,
        ).map(({ bytes }) => bytes),
      ).toEqual(first.encodedSegments.map(({ bytes }) => bytes))
      expectArtifactFailure(() =>
        serializeWorkspaceSearchMigrationPlanArtifactSegments(
          plan.seal,
          plan.operations,
          aggregateSegmentBytes - 1,
        )
      )
      expect(first.encodedSegments.every(
        ({ byteLength }) =>
          byteLength <= WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES,
      )).toBe(true)
      const replayInput = {
        planSeal: plan.seal,
        manifestHeadBytes: first.headBytes,
        manifestPages: first.storedPages,
        segments: first.storedSegments,
      }
      expect(replayWorkspaceSearchMigrationPlanArtifact(
        replayInput,
        aggregateSegmentBytes,
      ).operations).toEqual(plan.operations)
      expectArtifactFailure(() =>
        replayWorkspaceSearchMigrationPlanArtifact(
          replayInput,
          aggregateSegmentBytes - 1,
        )
      )
      expectArtifactFailure(() =>
        serializeWorkspaceSearchMigrationPlanManifestHead({
          planSeal: plan.seal,
          manifestPages: first.storedPages,
          segments: [...first.storedSegments].reverse(),
        })
      )

      expectArtifactFailure(() =>
        replayWorkspaceSearchMigrationPlanArtifact({
          planSeal: plan.seal,
          manifestHeadBytes: first.headBytes,
          manifestPages: first.storedPages,
          segments: first.storedSegments.slice(1),
        })
      )
      expectArtifactFailure(() =>
        replayWorkspaceSearchMigrationPlanArtifact({
          planSeal: plan.seal,
          manifestHeadBytes: first.headBytes,
          manifestPages: first.storedPages,
          segments: [...first.storedSegments].reverse(),
        })
      )
      expectArtifactFailure(() =>
        replayWorkspaceSearchMigrationPlanArtifact({
          planSeal: plan.seal,
          manifestHeadBytes: first.headBytes,
          manifestPages: first.storedPages,
          segments: first.storedSegments.map(() => {
            const firstStored = first.storedSegments[0]
            if (firstStored === undefined) {
              throw new Error('Missing first segment.')
            }
            return firstStored
          }),
        })
      )
      const firstStored = first.storedSegments[0]
      if (firstStored === undefined) throw new Error('Missing segment.')
      for (const replacement of [
        {
          ...firstStored.reference,
          contentDigest: 'f'.repeat(64),
        },
        {
          ...firstStored.reference,
          byteLength: firstStored.reference.byteLength + 1,
        },
        {
          ...firstStored.reference,
          versionId: 'substituted-version',
        },
      ]) {
        expectArtifactFailure(() =>
          replayWorkspaceSearchMigrationPlanArtifact({
            planSeal: plan.seal,
            manifestHeadBytes: first.headBytes,
            manifestPages: first.storedPages,
            segments: [
              { reference: replacement, bytes: firstStored.bytes },
              ...first.storedSegments.slice(1),
            ],
          })
        )
      }
    },
    30_000,
  )

  test('rejects sequence gaps and foreign plan identities before publication', () => {
    const plan = createPlan(2)
    const first = plan.operations[0]
    if (first === undefined) throw new Error('Missing fixture operation.')
    for (const replacement of [
      { ...first, planSequence: 2 },
      { ...first, runId: 'foreign-run' },
      { ...first, configurationHash: 'b'.repeat(64) },
      { ...first, planDigest: 'c'.repeat(64) },
    ]) {
      expectArtifactFailure(() =>
        serializeWorkspaceSearchMigrationPlanArtifactSegments(
          plan.seal,
          [replacement, ...plan.operations.slice(1)],
        )
      )
    }
  })

  test('enforces an inclusive aggregate canonical segment-byte ceiling', () => {
    const plan = createPlan(1)
    const baseline =
      serializeWorkspaceSearchMigrationPlanArtifactSegments(
        plan.seal,
        plan.operations,
      )
    const exactSegmentBytes = baseline.reduce(
      (total, segment) => total + segment.byteLength,
      0,
    )
    expect(
      serializeWorkspaceSearchMigrationPlanArtifactSegments(
        plan.seal,
        plan.operations,
        exactSegmentBytes,
      ).map(({ bytes }) => bytes),
    ).toEqual(baseline.map(({ bytes }) => bytes))
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanArtifactSegments(
        plan.seal,
        plan.operations,
        exactSegmentBytes - 1,
      )
    )
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanArtifactSegments(
        plan.seal,
        plan.operations,
        0,
      )
    )
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanArtifactSegments(
        plan.seal,
        plan.operations,
        WORKSPACE_SEARCH_MIGRATION_PLAN_MAX_TOTAL_SEGMENT_BYTES + 1,
      )
    )
  })

  test('rejects noncanonical bytes and strict byte ceilings', () => {
    const staged = stagePlan(createPlan(1))
    const segment = staged.encodedSegments[0]
    if (segment === undefined) throw new Error('Missing segment.')
    const noncanonical = new Uint8Array(segment.bytes.byteLength + 1)
    noncanonical.set(segment.bytes)
    noncanonical[noncanonical.length - 1] = 0x20
    expectArtifactFailure(() =>
      parseWorkspaceSearchMigrationPlanArtifactSegment(noncanonical)
    )
    expectArtifactFailure(() =>
      parseWorkspaceSearchMigrationPlanArtifactSegment(
        new Uint8Array(
          WORKSPACE_SEARCH_MIGRATION_PLAN_SEGMENT_MAX_BYTES + 1,
        ),
      )
    )
    expectArtifactFailure(() =>
      parseWorkspaceSearchMigrationPlanManifestHead(
        new Uint8Array(
          WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_HEAD_MAX_BYTES + 1,
        ),
      )
    )
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanManifestPage({
        planSeal: createPlan(1).seal,
        planSegmentCount:
          WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES + 1,
        pageSequence: 1,
        previousPage: null,
        segments: Array.from(
          {
            length:
              WORKSPACE_SEARCH_MIGRATION_PLAN_MANIFEST_PAGE_MAX_REFERENCES +
              1,
          },
          () => staged.storedSegments[0],
        ),
      })
    )
    const oversized = createPlan(1)
    const source = oversized.operations[0]?.operation.sourceCondition
    if (!source?.exists) throw new Error('Expected present source.')
    source.item.oversized = { S: 'x'.repeat(17 * 1024 * 1024) }
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanArtifactSegments(
        oversized.seal,
        oversized.operations,
      )
    )
  })

  test('rejects Proxy, accessor, sparse, and shared-memory boundaries without reads', () => {
    const plan = createPlan(1)
    let proxyReads = 0
    const proxied = new Proxy(plan.operations, {
      get(target, property, receiver) {
        proxyReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanArtifactSegments(
        plan.seal,
        proxied,
      )
    )
    expect(proxyReads).toBe(0)

    let accessorReads = 0
    const accessorOperations = [...plan.operations]
    Object.defineProperty(accessorOperations, '0', {
      enumerable: true,
      configurable: true,
      get() {
        accessorReads += 1
        return plan.operations[0]
      },
    })
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanArtifactSegments(
        plan.seal,
        accessorOperations,
      )
    )
    expect(accessorReads).toBe(0)

    const sparse = [...plan.operations]
    sparse.length = 2
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanArtifactSegments(
        plan.seal,
        sparse,
      )
    )

    const staged = stagePlan(plan)
    const shared = new Uint8Array(
      new SharedArrayBuffer(staged.headBytes.byteLength),
    )
    shared.set(staged.headBytes)
    expectArtifactFailure(() =>
      parseWorkspaceSearchMigrationPlanManifestHead(shared)
    )

    const nestedSharedPlan = createPlan(1)
    const source =
      nestedSharedPlan.operations[0]?.operation.sourceCondition
    if (!source?.exists) throw new Error('Expected present source.')
    source.item.shared = {
      B: new Uint8Array(new SharedArrayBuffer(1)),
    }
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanArtifactSegments(
        nestedSharedPlan.seal,
        nestedSharedPlan.operations,
      )
    )
  })

  test('rejects accessor-backed reference substitution without invoking it', () => {
    const plan = createPlan(1)
    const staged = stagePlan(plan)
    const stored = staged.storedSegments[0]
    if (stored === undefined) throw new Error('Missing segment.')
    let reads = 0
    const reference = { ...stored.reference }
    Object.defineProperty(reference, 'versionId', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1
        return stored.reference.versionId
      },
    })
    expectArtifactFailure(() =>
      replayWorkspaceSearchMigrationPlanArtifact({
        planSeal: plan.seal,
        manifestHeadBytes: staged.headBytes,
        manifestPages: staged.storedPages,
        segments: [{ reference, bytes: stored.bytes }],
      })
    )
    expect(reads).toBe(0)
  })

  test('uses strict canonical JSON rather than insertion order', () => {
    const staged = stagePlan(createPlan(1))
    const headText = new TextDecoder().decode(staged.headBytes)
    const parsed: unknown = JSON.parse(headText)
    expect(headText).toBe(serializeCanonicalJson(parsed))
  })
})
