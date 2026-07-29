import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { describe, expect, test } from 'bun:test'
import {
  createAttributeMapDigest,
  decodeAttributeMap,
  encodeAttributeMap,
} from './dynamodb-attribute-codec'
import {
  type MigrationItemSnapshot,
  type MigrationTableIdentity,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationItemConditionMaterial,
  verifyWorkspaceSearchMigrationItemStrongRead,
} from './migration-item-condition-aws'
import { createAbsentMigrationItemDigest } from './migration-journal'

describe('Workspace Search migration item condition AWS material', () => {
  test('binds every present top-level value and every known absent name', () => {
    const item = createPresentItem()
    const snapshot = createPresentSnapshot(item)
    const key = createKey()
    const material =
      createWorkspaceSearchMigrationItemConditionMaterial(
        createTableIdentity(),
        key,
        snapshot,
        [
          'workspaceId',
          'recordKey',
          'count',
          'binary',
          'labels',
          'metadata',
          'removedAt',
        ],
      )

    expect(material.ConditionExpression).toBe(
      [
        '#a0 = :v0',
        '#a1 = :v1',
        '#a2 = :v2',
        '#a3 = :v3',
        '#a4 = :v4',
        '#a5 = :v5',
        'attribute_not_exists(#a6)',
      ].join(' AND '),
    )
    expect(material.ExpressionAttributeNames).toEqual({
      '#a0': 'binary',
      '#a1': 'count',
      '#a2': 'labels',
      '#a3': 'metadata',
      '#a4': 'recordKey',
      '#a5': 'workspaceId',
      '#a6': 'removedAt',
    })
    expect(material.ExpressionAttributeValues).toEqual({
      ':v0': { B: Uint8Array.from([0, 1, 255]) },
      ':v1': { N: '1.00e+1' },
      ':v2': { SS: ['alpha', 'zeta'] },
      ':v3': {
        M: {
          nested: { NS: ['-0', '2.0'] },
        },
      },
      ':v4': { S: 'DOCUMENT#document-1' },
      ':v5': { S: 'workspace-1' },
    })

    item.count = { N: '999' }
    key.workspaceId = { S: 'workspace-mutated' }
    expect(material.Key).toEqual(createKey())
    expect(material.ExpressionAttributeValues?.[':v1']).toEqual({
      N: '1.00e+1',
    })
  })

  test('guards every composite key component for an absent item', () => {
    const material =
      createWorkspaceSearchMigrationItemConditionMaterial(
        createTableIdentity(),
        createKey(),
        createAbsentSnapshot(),
        ['workspaceId', 'recordKey', 'payload'],
      )

    expect(material).toEqual({
      Key: createKey(),
      ConditionExpression:
        'attribute_not_exists(#a0) AND attribute_not_exists(#a1)',
      ExpressionAttributeNames: {
        '#a0': 'workspaceId',
        '#a1': 'recordKey',
      },
    })
    expect(
      Object.hasOwn(material, 'ExpressionAttributeValues'),
    ).toBe(false)
  })

  test('rejects malformed keys, snapshots, descriptors, and oversized items', () => {
    const table = createTableIdentity()
    const item = createPresentItem()
    const invalidCases: readonly (() => unknown)[] = [
      () =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          {
            ...table,
            key: [
              { name: 'workspaceId', role: 'RANGE', type: 'S' },
            ],
          },
          createKey(),
          createPresentSnapshot(item),
          [],
        ),
      () =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          table,
          {
            ...createKey(),
            extra: { S: 'extra' },
          },
          createPresentSnapshot(item),
          [],
        ),
      () =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          table,
          {
            workspaceId: { N: '1' },
            recordKey: { S: 'DOCUMENT#document-1' },
          },
          createPresentSnapshot(item),
          [],
        ),
      () =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          table,
          createKey(),
          createPresentSnapshot({
            ...item,
            workspaceId: { S: 'workspace-other' },
          }),
          [],
        ),
      () =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          table,
          createKey(),
          {
            ...createPresentSnapshot(item),
            digest: '0'.repeat(64),
          },
          [],
        ),
      () =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          table,
          createKey(),
          {
            exists: false,
            digest: '0'.repeat(64),
          },
          [],
        ),
      () =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          table,
          createKey(),
          createPresentSnapshot({
            ...createKey(),
            payload: { S: 'x'.repeat(410_000) },
          }),
          [],
        ),
      () =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          table,
          createKey(),
          createPresentSnapshot(item),
          ['duplicate', 'duplicate'],
        ),
    ]

    for (const invalidCase of invalidCases) {
      expect(captureFailure(invalidCase).code).toBe(
        'INVALID_ARGUMENT',
      )
    }
  })

  test('fails closed at condition-expression and substitution byte bounds', () => {
    const table = createTableIdentity()
    const snapshot = createPresentSnapshot(createPresentItem())
    const expressionNames = Array.from(
      { length: 220 },
      (_, index) => `known${index}`,
    )
    expect(
      captureFailure(() =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          table,
          createKey(),
          snapshot,
          expressionNames,
        )
      ).code,
    ).toBe('INVALID_ARGUMENT')

    const largeNames = Array.from(
      { length: 40 },
      (_, index) => `${index}-${'x'.repeat(55_000)}`,
    )
    expect(
      captureFailure(() =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          table,
          createKey(),
          snapshot,
          largeNames,
        )
      ).code,
    ).toBe('INVALID_ARGUMENT')
  })

  test('rejects hostile construction graphs without invoking accessors or leaking raw values', () => {
    const rawSecret = 'raw-construction-secret'
    let accessorInvocations = 0
    const accessorSnapshot = createPresentSnapshot(
      createPresentItem(),
    )
    Object.defineProperty(accessorSnapshot, 'item', {
      enumerable: true,
      get() {
        accessorInvocations += 1
        throw new Error(rawSecret)
      },
    })
    const proxyItem = new Proxy(createPresentItem(), {
      ownKeys() {
        throw new Error(rawSecret)
      },
    })
    const symbolKey = Symbol('raw-symbol-secret')
    const symbolSnapshot = createPresentSnapshot(
      createPresentItem(),
    )
    Object.defineProperty(symbolSnapshot, symbolKey, {
      enumerable: true,
      value: rawSecret,
    })

    const failures = [
      captureFailure(() =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          createTableIdentity(),
          createKey(),
          accessorSnapshot,
          [],
        )
      ),
      captureFailure(() =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          createTableIdentity(),
          createKey(),
          {
            exists: true,
            item: proxyItem,
            digest: createAttributeMapDigest(createPresentItem()),
          },
          [],
        )
      ),
      captureFailure(() =>
        createWorkspaceSearchMigrationItemConditionMaterial(
          createTableIdentity(),
          createKey(),
          symbolSnapshot,
          [],
        )
      ),
    ]

    expect(accessorInvocations).toBe(0)
    for (const failure of failures) {
      expect(failure.code).toBe('INVALID_ARGUMENT')
      expect(failure.message).not.toContain(rawSecret)
    }
  })
})

describe('Workspace Search migration item strong-read verifier', () => {
  test('returns a detached exact snapshot for matching binary, set, and number spellings', () => {
    const planned = createPresentSnapshot(createPresentItem())
    const outputItem = createPresentItem()
    const observed = verifyWorkspaceSearchMigrationItemStrongRead(
      createTableIdentity(),
      createKey(),
      planned,
      {
        $metadata: {},
        Item: outputItem,
      },
      'TARGET_DRIFT',
    )

    expect(observed).toEqual(planned)
    outputItem.count = { N: '999' }
    if (!observed.exists) {
      throw new Error('Expected a present observed snapshot.')
    }
    expect(observed.item.count).toEqual({ N: '1.00e+1' })
  })

  test('accepts exact absence and classifies present/absent drift by caller role', () => {
    expect(
      verifyWorkspaceSearchMigrationItemStrongRead(
        createTableIdentity(),
        createKey(),
        createAbsentSnapshot(),
        { $metadata: {} },
        'SOURCE_DRIFT',
      ),
    ).toEqual(createAbsentSnapshot())

    expect(
      captureFailure(() =>
        verifyWorkspaceSearchMigrationItemStrongRead(
          createTableIdentity(),
          createKey(),
          createPresentSnapshot(createPresentItem()),
          { $metadata: {} },
          'SOURCE_DRIFT',
        )
      ).code,
    ).toBe('SOURCE_DRIFT')
    expect(
      captureFailure(() =>
        verifyWorkspaceSearchMigrationItemStrongRead(
          createTableIdentity(),
          createKey(),
          createAbsentSnapshot(),
          {
            $metadata: {},
            Item: createPresentItem(),
          },
          'TARGET_DRIFT',
        )
      ).code,
    ).toBe('TARGET_DRIFT')
  })

  test('detects exact canonical value drift including number spelling', () => {
    const planned = createPresentSnapshot(createPresentItem())
    const changed = createPresentItem()
    changed.count = { N: '10.0' }

    const failure = captureFailure(() =>
      verifyWorkspaceSearchMigrationItemStrongRead(
        createTableIdentity(),
        createKey(),
        planned,
        { Item: changed },
        'TARGET_DRIFT',
      )
    )
    expect(failure.code).toBe('TARGET_DRIFT')
  })

  test('rejects malformed output, wrong keys, and oversized items as invalid state', () => {
    const planned = createPresentSnapshot(createPresentItem())
    const invalidOutputs: readonly unknown[] = [
      undefined,
      [],
      { Item: undefined },
      {
        Item: {
          ...createPresentItem(),
          workspaceId: { S: 'workspace-other' },
        },
      },
      {
        Item: {
          ...createKey(),
          malformed: { S: 'value', N: '1' },
        },
      },
      {
        Item: {
          ...createKey(),
          payload: { S: 'x'.repeat(410_000) },
        },
      },
      {
        Item: createPresentItem(),
        [Symbol('unexpected')]: true,
      },
    ]

    for (const output of invalidOutputs) {
      expect(
        captureFailure(() =>
          verifyWorkspaceSearchMigrationItemStrongRead(
            createTableIdentity(),
            createKey(),
            planned,
            output,
            'TARGET_DRIFT',
          )
        ).code,
      ).toBe('INVALID_STATE')
    }
  })

  test('rejects Proxy and accessor output without traps or raw-value leakage', () => {
    const rawSecret = 'raw-strong-read-secret'
    let accessorInvocations = 0
    const accessorOutput: Record<string, unknown> = {}
    Object.defineProperty(accessorOutput, 'Item', {
      enumerable: true,
      get() {
        accessorInvocations += 1
        throw new Error(rawSecret)
      },
    })
    const nestedAccessor: Record<string, unknown> = {
      ...createKey(),
    }
    Object.defineProperty(nestedAccessor, 'payload', {
      enumerable: true,
      get() {
        accessorInvocations += 1
        throw new Error(rawSecret)
      },
    })
    const proxyOutput = new Proxy(
      { Item: createPresentItem() },
      {
        getPrototypeOf() {
          throw new Error(rawSecret)
        },
      },
    )
    const proxyItem = new Proxy(createPresentItem(), {
      ownKeys() {
        throw new Error(rawSecret)
      },
    })
    const outputs: readonly unknown[] = [
      accessorOutput,
      { Item: nestedAccessor },
      proxyOutput,
      { Item: proxyItem },
    ]

    for (const output of outputs) {
      const failure = captureFailure(() =>
        verifyWorkspaceSearchMigrationItemStrongRead(
          createTableIdentity(),
          createKey(),
          createPresentSnapshot(createPresentItem()),
          output,
          'SOURCE_DRIFT',
        )
      )
      expect(failure.code).toBe('INVALID_STATE')
      expect(failure.message).not.toContain(rawSecret)
    }
    expect(accessorInvocations).toBe(0)
  })

  test('rejects malformed verifier inputs as invalid argument', () => {
    const planned = createPresentSnapshot(createPresentItem())
    const failure = captureFailure(() =>
      verifyWorkspaceSearchMigrationItemStrongRead(
        createTableIdentity(),
        {
          workspaceId: { S: '' },
          recordKey: { S: 'DOCUMENT#document-1' },
        },
        planned,
        { Item: createPresentItem() },
        'TARGET_DRIFT',
      )
    )
    expect(failure.code).toBe('INVALID_ARGUMENT')
  })
})

/**
 * Creates the measured target table identity used by focused tests.
 *
 * @returns Complete composite-string-key table identity.
 */
function createTableIdentity(): MigrationTableIdentity {
  return {
    role: 'workspace-search',
    tableName: 'mukuroji-workspace-search-production-sensitive',
    tableArn:
      'arn:aws:dynamodb:ap-northeast-1:123456789012:table/mukuroji-workspace-search-production-sensitive',
    tableId: 'table-id-workspace-search',
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key: [
      { name: 'workspaceId', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ],
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'KMS',
    kmsKeyDigest: 'a'.repeat(64),
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-29T00:00:00.000Z',
    },
  }
}

/**
 * Creates one exact composite physical key.
 *
 * @returns Detached low-level DynamoDB key.
 */
function createKey(): Record<string, AttributeValue> {
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: 'DOCUMENT#document-1' },
  }
}

/**
 * Creates one exact item covering binary, set, map, and number spellings.
 *
 * @returns Low-level DynamoDB item.
 */
function createPresentItem(): Record<string, AttributeValue> {
  return {
    ...createKey(),
    binary: { B: Uint8Array.from([0, 1, 255]) },
    count: { N: '1.00e+1' },
    labels: { SS: ['zeta', 'alpha'] },
    metadata: {
      M: {
        nested: { NS: ['2.0', '-0'] },
      },
    },
  }
}

/**
 * Creates one canonical detached present snapshot.
 *
 * @param item - Candidate exact low-level item.
 * @returns Canonical snapshot and digest.
 */
function createPresentSnapshot(
  item: Readonly<Record<string, AttributeValue>>,
): MigrationItemSnapshot {
  const detached = decodeAttributeMap(encodeAttributeMap(item))
  return {
    exists: true,
    item: detached,
    digest: createAttributeMapDigest(detached),
  }
}

/**
 * Creates the canonical absent snapshot.
 *
 * @returns Canonical absent item state.
 */
function createAbsentSnapshot(): MigrationItemSnapshot {
  return {
    exists: false,
    digest: createAbsentMigrationItemDigest(),
  }
}

/**
 * Captures one expected public migration failure.
 *
 * @param operation - Synchronous operation expected to fail.
 * @returns Stable public migration failure.
 */
function captureFailure(
  operation: () => unknown,
): WorkspaceSearchMigrationFailure {
  try {
    operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) {
      return error
    }
    throw error
  }
  throw new Error('Expected WorkspaceSearchMigrationFailure.')
}
