import { describe, expect, test } from 'bun:test'
import type { ScanCommandOutput } from '@aws-sdk/client-dynamodb'
import {
  type DynamoAttributeMap,
  type MigrationTableIdentity,
} from './migration-contract'
import {
  normalizeWorkspaceSearchMigrationTargetScanOutput,
} from './migration-target-scan-aws'

describe('Workspace Search migration AWS target Scan output', () => {
  test('losslessly detaches full items and the exact measured cursor', () => {
    const binary = new Uint8Array([1, 2, 3])
    const item: DynamoAttributeMap = {
      workspaceId: { S: 'workspace-1' },
      recordKey: { S: 'DOCUMENT#document#1' },
      binary: { B: binary },
      binarySet: { BS: [new Uint8Array([3]), new Uint8Array([2])] },
      nested: {
        M: {
          value: {
            L: [{ BOOL: true }, { N: '1.25e+2' }],
          },
        },
      },
      numberSet: { NS: ['2', '1'] },
      stringSet: { SS: ['z', 'a'] },
    }
    const cursor = createCursor('1')
    const output: ScanCommandOutput = {
      $metadata: { requestId: 'not-evidence' },
      Count: 1,
      Items: [item],
      LastEvaluatedKey: cursor,
      ScannedCount: 1,
    }

    const result =
      normalizeWorkspaceSearchMigrationTargetScanOutput(
        output,
        createTargetTableIdentity(),
      )
    const detachedResult = structuredClone(result)
    binary[0] = 9
    item.workspaceId = { S: 'mutated' }
    cursor.workspaceId = { S: 'mutated' }

    expect(result).toEqual(detachedResult)
    expect(result).toEqual({
      ok: true,
      page: {
        items: [{
          workspaceId: { S: 'workspace-1' },
          recordKey: { S: 'DOCUMENT#document#1' },
          binary: { B: new Uint8Array([1, 2, 3]) },
          binarySet: {
            BS: [new Uint8Array([2]), new Uint8Array([3])],
          },
          nested: {
            M: {
              value: {
                L: [{ BOOL: true }, { N: '1.25e+2' }],
              },
            },
          },
          numberSet: { NS: ['1', '2'] },
          stringSet: { SS: ['a', 'z'] },
        }],
        lastEvaluatedKey: createCursor('1'),
      },
    })
  })

  test('accepts omitted Items only with explicit zero response counts', () => {
    const table = createTargetTableIdentity()

    expect(
      normalizeWorkspaceSearchMigrationTargetScanOutput(
        {
          $metadata: {},
          Count: 0,
          ScannedCount: 0,
        },
        table,
      ),
    ).toEqual({
      ok: true,
      page: { items: [] },
    })
    expect(
      normalizeWorkspaceSearchMigrationTargetScanOutput(
        { $metadata: {} },
        table,
      ),
    ).toEqual({
      ok: false,
      code: 'INVALID_STATE',
    })

    const nullItems: ScanCommandOutput = {
      $metadata: {},
      Count: 0,
      ScannedCount: 0,
    }
    Reflect.set(nullItems, 'Items', null)
    expect(
      normalizeWorkspaceSearchMigrationTargetScanOutput(nullItems, table),
    ).toEqual({
      ok: false,
      code: 'INVALID_STATE',
    })
  })

  test('rejects malformed page shapes, counts, and cursors fail-closed', () => {
    const table = createTargetTableIdentity()
    const tooMany = Array.from(
      { length: 101 },
      (_, index) => createItem(`too-many-${index}`),
    )
    const sparse = [createItem('sparse')]
    delete sparse[0]
    const lengthMutatingItems = [
      createItem('length-mutation-1'),
      createItem('length-mutation-2'),
    ]
    Object.defineProperty(lengthMutatingItems, '0', {
      configurable: true,
      enumerable: true,
      get() {
        lengthMutatingItems.length = 1
        return createItem('length-mutation-1')
      },
    })
    const malformedOutputs: readonly ScanCommandOutput[] = [
      {
        $metadata: {},
        Count: 101,
        Items: tooMany,
        ScannedCount: 101,
      },
      {
        $metadata: {},
        Count: 1,
        Items: sparse,
        ScannedCount: 1,
      },
      {
        $metadata: {},
        Count: 2,
        Items: lengthMutatingItems,
        ScannedCount: 2,
      },
      {
        $metadata: {},
        Count: 2,
        Items: [createItem('count-mismatch')],
        ScannedCount: 1,
      },
      {
        $metadata: {},
        Count: 0,
        Items: [],
      },
      {
        $metadata: {},
        Items: [],
        ScannedCount: 0,
      },
    ]

    for (const output of malformedOutputs) {
      expect(
        normalizeWorkspaceSearchMigrationTargetScanOutput(output, table),
      ).toEqual({
        ok: false,
        code: 'INVALID_STATE',
      })
    }

    expect(
      normalizeWorkspaceSearchMigrationTargetScanOutput(
        {
          $metadata: {},
          Count: 0,
          Items: [],
          LastEvaluatedKey: {
            workspaceId: { S: 'missing-sort-key' },
          },
          ScannedCount: 0,
        },
        table,
      ),
    ).toEqual({
      ok: false,
      code: 'TABLE_SCHEMA_MISMATCH',
    })

    expect(
      normalizeWorkspaceSearchMigrationTargetScanOutput(
        {
          $metadata: {},
          Count: 0,
          Items: [],
          LastEvaluatedKey: createCursor('empty-page'),
          ScannedCount: 0,
        },
        table,
      ),
    ).toEqual({
      ok: false,
      code: 'INVALID_STATE',
    })
    expect(
      normalizeWorkspaceSearchMigrationTargetScanOutput(
        {
          $metadata: {},
          Count: 1,
          Items: [createItem('last-returned')],
          LastEvaluatedKey: createCursor('skipped-ahead'),
          ScannedCount: 1,
        },
        table,
      ),
    ).toEqual({
      ok: false,
      code: 'INVALID_STATE',
    })
  })

  test('replaces hostile response and codec failures with fixed results', () => {
    const canary = 'RAW-TARGET-SCAN-CANARY-DO-NOT-LEAK'
    const hostileOutput: ScanCommandOutput = {
      $metadata: {},
      Count: 0,
      ScannedCount: 0,
    }
    Object.defineProperty(hostileOutput, 'Items', {
      enumerable: true,
      get() {
        throw new Error(canary)
      },
    })
    const hostileResult =
      normalizeWorkspaceSearchMigrationTargetScanOutput(
        hostileOutput,
        createTargetTableIdentity(),
      )
    expect(hostileResult).toEqual({
      ok: false,
      code: 'INVALID_STATE',
    })
    expect(JSON.stringify(hostileResult)).not.toContain(canary)

    const malformedItem: DynamoAttributeMap = {
      workspaceId: { S: 'workspace-1' },
      recordKey: { S: 'DOCUMENT#document#1' },
    }
    Reflect.set(malformedItem, 'payload', { S: 1 })
    expect(
      normalizeWorkspaceSearchMigrationTargetScanOutput(
        {
          $metadata: {},
          Count: 1,
          Items: [malformedItem],
          ScannedCount: 1,
        },
        createTargetTableIdentity(),
      ),
    ).toEqual({
      ok: false,
      code: 'INVALID_STATE',
    })
  })
})

/**
 * Creates one target table identity with the exact composite string key.
 *
 * @returns Complete measured Workspace Search target table identity.
 */
function createTargetTableIdentity(): MigrationTableIdentity {
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
    deletionProtection: false,
    encryption: 'AWS_OWNED',
    kmsKeyDigest: null,
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Creates one full low-level target item.
 *
 * @param id - Stable fixture identifier.
 * @returns Exact target item.
 */
function createItem(id: string): DynamoAttributeMap {
  return {
    workspaceId: { S: `workspace-${id}` },
    recordKey: { S: `DOCUMENT#document#${id}` },
    payload: { S: id },
  }
}

/**
 * Creates one exact physical target cursor.
 *
 * @param id - Stable fixture identifier.
 * @returns Composite low-level target table key.
 */
function createCursor(id: string): DynamoAttributeMap {
  return {
    workspaceId: { S: `workspace-${id}` },
    recordKey: { S: `DOCUMENT#document#${id}` },
  }
}
