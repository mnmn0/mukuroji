import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import {
  calculateDynamoDbItemSize,
  DYNAMODB_MAX_ITEM_SIZE_BYTES,
} from './dynamodb-attribute-codec'
import {
  serializeCanonicalJson,
  type DynamoAttributeMap,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactContentDigest,
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
  parseWorkspaceSearchMigrationPlanningTargetArtifactPage,
  parseWorkspaceSearchMigrationPlanningTargetArtifactSegment,
  serializeWorkspaceSearchMigrationPlanningTargetArtifactPage,
  serializeWorkspaceSearchMigrationPlanningTargetArtifactSegment,
  WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_OBJECT_KEY_PREFIX,
  WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES,
  WorkspaceSearchMigrationTargetArtifactError,
  type WorkspaceSearchMigrationPlanningTargetArtifactPage,
  type WorkspaceSearchMigrationPlanningTargetArtifactReference,
} from './migration-target-artifact'

/** Stable digest fixtures used by planning-target artifact tests. */
const configurationHash = 'a'.repeat(64)
const previousEvidenceDigest = 'b'.repeat(64)
const previousCheckpointDigest = 'c'.repeat(64)
const maintenanceEvidenceReceiptDigest = 'd'.repeat(64)

/**
 * Creates one exact mixed-AttributeValue item fixture.
 *
 * @returns Raw item containing every supported AttributeValue family.
 */
function createMixedItem(): DynamoAttributeMap {
  return {
    pk: { S: 'row-1' },
    exactNumber: { N: '1.2300' },
    binary: { B: new Uint8Array([0, 127, 255]) },
    stringSet: { SS: ['alpha', 'beta'] },
    numberSet: { NS: ['1.2300', '2'] },
    binarySet: {
      BS: [
        new Uint8Array([0]),
        new Uint8Array([1, 2]),
      ],
    },
    enabled: { BOOL: true },
    nothing: { NULL: true },
    nestedMap: {
      M: {
        label: { S: 'nested' },
        values: {
          L: [
            { N: '-0.50' },
            { B: new Uint8Array([4, 5, 6]) },
            {
              M: {
                final: { BOOL: false },
              },
            },
          ],
        },
      },
    },
    orderedList: {
      L: [
        { S: 'first' },
        { SS: ['x', 'y'] },
      ],
    },
  }
}

/**
 * Creates one complete canonical planning-target page fixture.
 *
 * @param items - Exact raw Scan items represented by the page.
 * @returns Complete planning-target artifact page.
 */
function createPage(
  items: readonly DynamoAttributeMap[] = [
    createMixedItem(),
    {
      pk: { S: 'row-2' },
      ignoredPayload: { S: 'retained-losslessly' },
    },
  ],
): WorkspaceSearchMigrationPlanningTargetArtifactPage {
  return {
    kind: 'workspace-search-planning-target-artifact-page',
    artifactVersion: 1,
    migrationId: 'workspace-search-maintenance',
    migrationVersion: 1,
    purpose: 'planning',
    runId: 'run-20260728',
    configurationHash,
    targetTable: {
      tableName: 'workspace-search-production',
      tableArn:
        'arn:aws:dynamodb:ap-northeast-1:123456789012:table/workspace-search-production',
      tableId: '00000000-0000-0000-0000-000000000001',
      creationTime: '2026-07-28T00:00:00.000Z',
    },
    stateTable: {
      tableName: 'workspace-search-migration-state-production',
      tableArn:
        'arn:aws:dynamodb:ap-northeast-1:123456789012:table/workspace-search-migration-state-production',
      tableId: '00000000-0000-0000-0000-000000000002',
      creationTime: '2026-07-28T00:01:00.000Z',
    },
    pageSequence: 3,
    previousEvidenceDigest,
    previousCheckpointDigest,
    planningAuthority: {
      ownerId: 'owner-01',
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 4,
      maintenanceEvidenceReceiptDigest,
    },
    items,
  }
}

/**
 * Creates a page whose canonical item bytes require multiple segments.
 *
 * @returns Complete page containing ten individually legal large items.
 */
function createMultiSegmentPage():
  WorkspaceSearchMigrationPlanningTargetArtifactPage {
  const payload = '\u0000'.repeat(300_000)
  const items = Array.from({ length: 10 }, (_, index) => ({
    pk: { S: `large-row-${index}` },
    payload: { S: payload },
  }))
  return createPage(items)
}

/**
 * Parses exact artifact bytes into one mutable fixture record.
 *
 * @param bytes - Exact canonical segment bytes.
 * @returns Mutable plain parsed record.
 */
function parseFixtureRecord(bytes: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!isRecord(parsed)) {
    throw new Error('Expected a parsed fixture record.')
  }
  return parsed
}

/**
 * Encodes one fixture value using repository canonical JSON ordering.
 *
 * @param value - JSON-safe test fixture.
 * @returns Canonical UTF-8 bytes.
 */
function encodeFixture(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Reads one fixture array property.
 *
 * @param record - Parsed fixture record.
 * @param key - Array field to read.
 * @returns Mutable fixture array.
 */
function readFixtureArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
): unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) {
    throw new Error(`Expected fixture array ${key}.`)
  }
  return value
}

/**
 * Reads one fixture record property.
 *
 * @param record - Parsed fixture record.
 * @param key - Record field to read.
 * @returns Mutable fixture record.
 */
function readFixtureRecord(
  record: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const value = record[key]
  if (!isRecord(value)) {
    throw new Error(`Expected fixture record ${key}.`)
  }
  return value
}

/**
 * Checks whether one runtime value is a plain fixture record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Expects one artifact operation to fail through the stable secret-free boundary.
 *
 * @param operation - Deferred invalid artifact operation.
 * @param forbiddenText - Optional raw value that must not escape.
 */
function expectArtifactFailure(
  operation: () => unknown,
  forbiddenText?: string,
): void {
  try {
    operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkspaceSearchMigrationTargetArtifactError)
    if (!(error instanceof WorkspaceSearchMigrationTargetArtifactError)) {
      throw error
    }
    expect(error.code).toBe('INVALID_TARGET_ARTIFACT')
    expect(error.message).toBe('INVALID_TARGET_ARTIFACT')
    if (forbiddenText !== undefined) {
      expect(error.message).not.toContain(forbiddenText)
      expect(error.code).not.toContain(forbiddenText)
    }
    return
  }
  throw new Error('Expected a planning-target artifact failure.')
}

describe('Workspace Search planning target artifact codec', () => {
  test('round-trips every AttributeValue family and exact stored bytes', () => {
    const page = createPage()
    const encoded =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(page)

    expect(encoded).toHaveLength(1)
    const stored = encoded[0]
    if (stored === undefined) {
      throw new Error('Expected one encoded segment.')
    }
    expect(stored.segment.segmentIndex).toBe(0)
    expect(stored.segment.segmentCount).toBe(1)
    expect(stored.segment.itemStartIndex).toBe(0)
    expect(stored.segment.itemCount).toBe(2)
    expect(stored.segment.pageItemCount).toBe(2)
    expect(stored.byteLength).toBe(stored.bytes.byteLength)
    expect(stored.contentDigest).toBe(
      createHash('sha256').update(stored.bytes).digest('hex'),
    )
    expect(
      createWorkspaceSearchMigrationPlanningTargetArtifactContentDigest(
        stored.bytes,
      ),
    ).toBe(stored.contentDigest)
    const reference: WorkspaceSearchMigrationPlanningTargetArtifactReference = {
      objectKey:
        createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
          stored.contentDigest,
        ),
      versionId: 'version-01',
      contentDigest: stored.contentDigest,
    }
    expect(reference.objectKey).toBe(
      `${WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_OBJECT_KEY_PREFIX}/${stored.contentDigest}.json`,
    )
    expect(stored.segment.kind).toBe(
      'workspace-search-planning-target-artifact-segment',
    )

    const parsed =
      parseWorkspaceSearchMigrationPlanningTargetArtifactPage([
        stored.bytes,
      ])
    expect(parsed.kind).toBe(
      'workspace-search-planning-target-artifact-page',
    )
    expect(parsed).toEqual(page)
    expect(
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(parsed)
        .map((segment) => segment.bytes),
    ).toEqual([stored.bytes])

    const mixed = parsed.items[0]
    expect(mixed?.exactNumber).toEqual({ N: '1.2300' })
    expect(mixed?.binary).toEqual({
      B: new Uint8Array([0, 127, 255]),
    })
    expect(mixed?.stringSet).toEqual({ SS: ['alpha', 'beta'] })
    expect(mixed?.numberSet).toEqual({ NS: ['1.2300', '2'] })
    expect(mixed?.binarySet).toEqual({
      BS: [
        new Uint8Array([0]),
        new Uint8Array([1, 2]),
      ],
    })
    expect(mixed?.nestedMap).toEqual(createMixedItem().nestedMap)
  })

  test('produces deterministic canonical bytes and binds every authority field', () => {
    const page = createPage()
    const first =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(page)
    const second =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(page)
    expect(second).toEqual(first)

    const changed: WorkspaceSearchMigrationPlanningTargetArtifactPage = {
      ...page,
      planningAuthority: {
        ...page.planningAuthority,
        fenceToken: 8,
      },
    }
    const changedBytes =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(changed)
    expect(changedBytes[0]?.contentDigest).not.toBe(
      first[0]?.contentDigest,
    )

    const padded = new TextEncoder().encode(
      ` ${new TextDecoder().decode(first[0]?.bytes)}`,
    )
    expectArtifactFailure(
      () => parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(padded),
    )
  })

  test('round-trips a canonical empty target page as one empty segment', () => {
    const page = createPage([])
    const encoded =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(page)
    expect(encoded).toHaveLength(1)
    expect(encoded[0]?.segment).toMatchObject({
      segmentIndex: 0,
      segmentCount: 1,
      itemStartIndex: 0,
      itemCount: 0,
      pageItemCount: 0,
      items: [],
    })
    expect(
      parseWorkspaceSearchMigrationPlanningTargetArtifactPage(
        encoded.map((segment) => segment.bytes),
      ),
    ).toEqual(page)
  })

  test('keeps a worst-escaping maximum-size DynamoDB item whole', () => {
    const fixedItemBytes = 3
    const item: DynamoAttributeMap = {
      p: { S: 'k' },
      x: {
        S: '\u0000'.repeat(
          DYNAMODB_MAX_ITEM_SIZE_BYTES - fixedItemBytes,
        ),
      },
    }
    expect(calculateDynamoDbItemSize(item)).toBe(
      DYNAMODB_MAX_ITEM_SIZE_BYTES,
    )

    const page = createPage([item])
    const encoded =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(page)
    expect(encoded).toHaveLength(1)
    expect(encoded[0]?.byteLength).toBeGreaterThan(2 * 1024 * 1024)
    expect(encoded[0]?.byteLength).toBeLessThanOrEqual(
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES,
    )
    expect(encoded[0]?.segment.itemCount).toBe(1)
    expect(
      parseWorkspaceSearchMigrationPlanningTargetArtifactPage(
        encoded.map((segment) => segment.bytes),
      ),
    ).toEqual(page)
  })

  test('segments only between complete items and rejects reordered or missing segments', () => {
    const page = createMultiSegmentPage()
    const encoded =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(page)
    expect(encoded.length).toBeGreaterThan(1)

    let expectedItemStartIndex = 0
    for (let index = 0; index < encoded.length; index += 1) {
      const stored = encoded[index]
      if (stored === undefined) {
        throw new Error('Expected a dense encoded segment list.')
      }
      expect(stored.byteLength).toBeLessThanOrEqual(
        WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES,
      )
      expect(stored.segment.segmentIndex).toBe(index)
      expect(stored.segment.segmentCount).toBe(encoded.length)
      expect(stored.segment.itemStartIndex).toBe(expectedItemStartIndex)
      expect(stored.segment.itemCount).toBe(stored.segment.items.length)
      expect(stored.segment.itemCount).toBeGreaterThan(0)
      expectedItemStartIndex += stored.segment.itemCount
    }
    expect(expectedItemStartIndex).toBe(page.items.length)
    expect(
      parseWorkspaceSearchMigrationPlanningTargetArtifactPage(
        encoded.map((segment) => segment.bytes),
      ),
    ).toEqual(page)

    expectArtifactFailure(() =>
      parseWorkspaceSearchMigrationPlanningTargetArtifactPage(
        [...encoded].reverse().map((segment) => segment.bytes),
      )
    )
    expectArtifactFailure(() =>
      parseWorkspaceSearchMigrationPlanningTargetArtifactPage(
        encoded.slice(1).map((segment) => segment.bytes),
      )
    )

    const first = encoded[0]
    const second = encoded[1]
    if (first === undefined || second === undefined) {
      throw new Error('Expected at least two encoded segments.')
    }
    const identityMismatch = parseFixtureRecord(second.bytes)
    identityMismatch.previousEvidenceDigest = 'e'.repeat(64)
    expectArtifactFailure(() =>
      parseWorkspaceSearchMigrationPlanningTargetArtifactPage([
        first.bytes,
        encodeFixture(identityMismatch),
        ...encoded.slice(2).map((segment) => segment.bytes),
      ])
    )
  })

  test('rejects extra, missing, cursor, and nested authority fields', () => {
    const encoded =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        createPage(),
      )
    const first = encoded[0]
    if (first === undefined) {
      throw new Error('Expected one encoded segment.')
    }

    const extra = parseFixtureRecord(first.bytes)
    extra.unexpected = 'raw-value'
    expectArtifactFailure(
      () => parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        encodeFixture(extra),
      ),
    )

    const cursor = parseFixtureRecord(first.bytes)
    cursor.cursor = { pk: { type: 'S', value: 'must-not-be-stored' } }
    expectArtifactFailure(
      () => parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        encodeFixture(cursor),
      ),
    )

    const missing = parseFixtureRecord(first.bytes)
    Reflect.deleteProperty(missing, 'runId')
    expectArtifactFailure(
      () => parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        encodeFixture(missing),
      ),
    )

    const nested = parseFixtureRecord(first.bytes)
    const authority = readFixtureRecord(nested, 'planningAuthority')
    authority.rawReceipt = 'must-not-leak'
    expectArtifactFailure(
      () => parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        encodeFixture(nested),
      ),
    )
  })

  test('rejects source-artifact substitution at the codec boundary', () => {
    const encoded =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        createPage(),
      )
    const first = encoded[0]
    if (first === undefined) {
      throw new Error('Expected one encoded segment.')
    }

    const sourceKind = parseFixtureRecord(first.bytes)
    sourceKind.kind =
      'workspace-search-planning-source-artifact-segment'
    expectArtifactFailure(() =>
      parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        encodeFixture(sourceKind),
      )
    )

    const sourceShape = parseFixtureRecord(first.bytes)
    sourceShape.source = 'project-directory'
    sourceShape.sourceTable = sourceShape.targetTable
    Reflect.deleteProperty(sourceShape, 'targetTable')
    expectArtifactFailure(() =>
      parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        encodeFixture(sourceShape),
      )
    )
  })

  test('rejects tampered item encodings, metadata ranges, and table incarnations', () => {
    const encoded =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        createPage(),
      )
    const first = encoded[0]
    if (first === undefined) {
      throw new Error('Expected one encoded segment.')
    }

    const numberTamper = parseFixtureRecord(first.bytes)
    const items = readFixtureArray(numberTamper, 'items')
    const mixed = items[0]
    if (!isRecord(mixed)) {
      throw new Error('Expected one encoded item.')
    }
    const exactNumber = readFixtureRecord(mixed, 'exactNumber')
    exactNumber.value = '01'
    expectArtifactFailure(
      () => parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        encodeFixture(numberTamper),
      ),
    )

    const rangeTamper = parseFixtureRecord(first.bytes)
    rangeTamper.itemStartIndex = 2
    expectArtifactFailure(
      () => parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        encodeFixture(rangeTamper),
      ),
    )

    const sameTable = parseFixtureRecord(first.bytes)
    sameTable.stateTable = sameTable.targetTable
    expectArtifactFailure(
      () => parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        encodeFixture(sameTable),
      ),
    )

    const badCreationTime = parseFixtureRecord(first.bytes)
    const targetTable = readFixtureRecord(badCreationTime, 'targetTable')
    targetTable.creationTime = 'not-a-time'
    expectArtifactFailure(
      () => parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        encodeFixture(badCreationTime),
      ),
    )
  })

  test('rejects oversized, over-count, sparse, and invalid raw page inputs', () => {
    const oversizedBytes = new Uint8Array(
      WORKSPACE_SEARCH_MIGRATION_TARGET_ARTIFACT_SEGMENT_MAX_BYTES + 1,
    )
    expectArtifactFailure(
      () => parseWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        oversizedBytes,
      ),
    )

    const tooManyItems = Array.from({ length: 101 }, (_, index) => ({
      pk: { S: `row-${index}` },
    }))
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        createPage(tooManyItems),
      )
    )

    const sparseItems: DynamoAttributeMap[] = []
    sparseItems.length = 1
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        createPage(sparseItems),
      )
    )

    const sparseSegments: Uint8Array[] = []
    sparseSegments.length = 1
    expectArtifactFailure(() =>
      parseWorkspaceSearchMigrationPlanningTargetArtifactPage(sparseSegments)
    )

    const invalidNumber: DynamoAttributeMap = {
      pk: { S: 'invalid-number' },
      value: { N: '01' },
    }
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        createPage([invalidNumber]),
      )
    )

    const oversizedItem: DynamoAttributeMap = {
      pk: { S: 'oversized' },
      payload: { S: 'x'.repeat(410 * 1024) },
    }
    expectArtifactFailure(() =>
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        createPage([oversizedItem]),
      )
    )
  })

  test('rejects runtime extras and replaces hostile failures without raw values', () => {
    const extraPage = createPage()
    Object.defineProperty(extraPage, 'unexpected', {
      configurable: true,
      enumerable: true,
      value: 'TENANT_SECRET',
      writable: true,
    })
    expectArtifactFailure(
      () => serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        extraPage,
      ),
      'TENANT_SECRET',
    )

    const hiddenExtraPage = createPage()
    Object.defineProperty(hiddenExtraPage, 'hidden', {
      configurable: true,
      enumerable: false,
      value: 'TENANT_SECRET',
      writable: true,
    })
    expectArtifactFailure(
      () => serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        hiddenExtraPage,
      ),
      'TENANT_SECRET',
    )

    const hostilePage = createPage()
    Object.defineProperty(hostilePage, 'runId', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('TENANT_SECRET')
      },
    })
    expectArtifactFailure(
      () => serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        hostilePage,
      ),
      'TENANT_SECRET',
    )

    const wrongPrototype = createPage()
    Object.setPrototypeOf(wrongPrototype, {
      inherited: 'TENANT_SECRET',
    })
    expectArtifactFailure(
      () => serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        wrongPrototype,
      ),
      'TENANT_SECRET',
    )

    const symbolExtra = createPage()
    Reflect.set(symbolExtra, Symbol('TENANT_SECRET'), 'TENANT_SECRET')
    expectArtifactFailure(
      () => serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        symbolExtra,
      ),
      'TENANT_SECRET',
    )

    const encoded =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(
        createPage(),
      )
    const segment = encoded[0]?.segment
    if (segment === undefined) {
      throw new Error('Expected one encoded segment.')
    }
    Object.defineProperty(segment, 'cursor', {
      configurable: true,
      enumerable: true,
      value: { pk: { S: 'TENANT_SECRET' } },
      writable: true,
    })
    expectArtifactFailure(
      () => serializeWorkspaceSearchMigrationPlanningTargetArtifactSegment(
        segment,
      ),
      'TENANT_SECRET',
    )
  })

  test('rejects a non-canonical digest request rather than hashing arbitrary bytes', () => {
    const page = createPage()
    const encoded =
      serializeWorkspaceSearchMigrationPlanningTargetArtifactPage(page)
    const first = encoded[0]
    if (first === undefined) {
      throw new Error('Expected one encoded segment.')
    }
    const tampered = new Uint8Array(first.bytes)
    tampered[tampered.length - 1] = 0x20
    expectArtifactFailure(() =>
      createWorkspaceSearchMigrationPlanningTargetArtifactContentDigest(
        tampered,
      )
    )
  })
})

/**
 * Compile-time fixture proving nested set values satisfy the SDK union.
 */
const attributeValueFixture: AttributeValue = {
  L: [
    { SS: ['a'] },
    { NS: ['1.0'] },
    { BS: [new Uint8Array([1])] },
  ],
}
void attributeValueFixture
