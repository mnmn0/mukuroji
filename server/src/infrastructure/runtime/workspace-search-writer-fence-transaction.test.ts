import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { NumberValue } from '@aws-sdk/lib-dynamodb'
import { expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceGuardMaterial,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  encodeWorkspaceSearchWriterFenceRecord,
  parseWorkspaceSearchWriterFenceObservation,
  type WorkspaceSearchWriterFenceGuardMaterial,
  type WorkspaceSearchWriterFenceStateIdentity,
} from './workspace-search-writer-fence'
import {
  isWorkspaceSearchWriterFenceBlockedTransaction,
  prependWorkspaceSearchWriterFenceGuard,
  throwIfWorkspaceSearchWriterFenceBlocked,
  WorkspaceSearchWriterFenceBlockedError,
  WorkspaceSearchWriterFenceTransactionPreparationError,
  type WorkspaceSearchWriterFenceDocumentTransactionItem,
} from './workspace-search-writer-fence-transaction'

/**
 * Unsupported custom application value used to verify fail-closed detachment.
 */
class UnsupportedApplicationDocumentValue {
  /** Enumerable value that structured cloning would silently turn into a map. */
  readonly value = 'unsupported'
}

/**
 * Unsupported NumberValue subclass used to verify exact prototype checks.
 */
class UnsupportedNumberValueSubclass extends NumberValue {}

/**
 * Unsupported boxed Number subclass used to verify exact prototype checks.
 */
class UnsupportedBoxedNumberSubclass extends Number {}

/**
 * Unsupported Array subclass used to verify exact prototype checks.
 */
class UnsupportedArraySubclass extends Array<string> {}

/**
 * Unsupported Set subclass used to verify exact prototype checks.
 */
class UnsupportedSetSubclass extends Set<string> {}

/**
 * Unsupported Map subclass used to verify exact prototype checks.
 */
class UnsupportedMapSubclass extends Map<string, string> {}

/**
 * Unsupported ArrayBuffer subclass used to verify exact prototype checks.
 */
class UnsupportedArrayBufferSubclass extends ArrayBuffer {}

/**
 * Unsupported typed-array subclass used to verify exact prototype checks.
 */
class UnsupportedUint8ArraySubclass extends Uint8Array {}

/**
 * Unsupported Blob subclass used to verify exact prototype checks.
 */
class UnsupportedBlobSubclass extends Blob {}

/**
 * Unsupported File subclass used to verify exact prototype checks.
 */
class UnsupportedFileSubclass extends File {}

/**
 * Creates one complete measured migration-state identity.
 *
 * @param suffix - Fixture identity suffix.
 * @returns Exact state-table identity.
 */
function createStateIdentityFixture(
  suffix: string,
): WorkspaceSearchWriterFenceStateIdentity {
  const tableName = 'WorkspaceSearchMigrationState'
  return {
    role: 'migration-state',
    tableName,
    tableArn:
      `arn:aws:dynamodb:us-east-1:123456789012:table/${tableName}`,
    tableId: `migration-state-${suffix}`,
    creationTime: '2026-07-29T00:00:00.000Z',
    account: '123456789012',
    region: 'us-east-1',
  }
}

/**
 * Creates deterministic open-row guard material for transaction tests.
 *
 * @returns Exact valid guard material.
 */
function createGuardFixture(): WorkspaceSearchWriterFenceGuardMaterial {
  const stateTableIdentity = createStateIdentityFixture('primary')
  const binding = createWorkspaceSearchWriterFenceBinding({
    stateTableName: stateTableIdentity.tableName,
    stateTableId: stateTableIdentity.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest(
        stateTableIdentity,
      ),
    tableIds: {
      'project-directory': 'project-directory-primary',
      'work-items': 'work-items-primary',
      collaboration: 'collaboration-primary',
      documents: 'documents-primary',
      'workspace-search': 'workspace-search-primary',
      'migration-state': stateTableIdentity.tableId,
    },
  })
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  return createWorkspaceSearchWriterFenceGuardMaterial(
    parseWorkspaceSearchWriterFenceObservation(
      encodeWorkspaceSearchWriterFenceRecord(open),
      binding,
    ),
    binding,
    stateTableIdentity,
  )
}

/**
 * Creates closed-row bytes mislabeled as an open application guard.
 *
 * @returns Deliberately forged guard material.
 */
function createClosedRowMasqueradingGuardFixture():
  WorkspaceSearchWriterFenceGuardMaterial {
  const stateTableIdentity = createStateIdentityFixture('closed')
  const binding = createWorkspaceSearchWriterFenceBinding({
    stateTableName: stateTableIdentity.tableName,
    stateTableId: stateTableIdentity.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest(
        stateTableIdentity,
      ),
    tableIds: {
      'project-directory': 'project-directory-closed',
      'work-items': 'work-items-closed',
      collaboration: 'collaboration-closed',
      documents: 'documents-closed',
      'workspace-search': 'workspace-search-closed',
      'migration-state': stateTableIdentity.tableId,
    },
  })
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  const closed = createWorkspaceSearchWriterFenceClosedSuccessor(
    open,
    {
      configurationHash: createHash('sha256')
        .update('configuration')
        .digest('hex'),
      runId: 'migration-run',
      ownerId: 'migration-owner',
      leaseFenceToken: 3,
      maintenanceEvidenceReceiptDigest: createHash('sha256')
        .update('receipt')
        .digest('hex'),
      maintenanceEvidencePointerRevision: 2,
    },
    new Date('2026-07-29T00:05:00.000Z'),
  )
  return {
    conditionCheck: {
      ConditionCheck: {
        TableName: binding.stateTableName,
        Key: {
          migrationId: { S: 'workspace-search-maintenance' },
          recordKey: { S: binding.recordKey },
        },
        ConditionExpression:
          '#canonicalBytes = :canonicalBytes AND #recordDigest = :recordDigest',
        ExpressionAttributeNames: {
          '#canonicalBytes': 'canonicalBytes',
          '#recordDigest': 'recordDigest',
        },
        ExpressionAttributeValues: {
          ':canonicalBytes': { S: closed.canonicalBytes },
          ':recordDigest': { S: closed.recordDigest },
        },
        ReturnValuesOnConditionCheckFailure: 'NONE',
      },
    },
    materialFingerprint: createHash('sha256')
      .update('forged-closed-material')
      .digest('hex'),
    stateTableIdentity,
    writerEpoch: 1,
    controlRevision: 1,
  }
}

test('prepends a native-value guard and detaches application items', () => {
  const material = createGuardFixture()
  const applicationItem = {
    Put: {
      TableName: 'WorkspaceSearch',
      Item: {
        workspaceId: 'workspace-1',
        recordKey: 'search/work-item/issue-1',
        title: 'Before mutation',
      },
    },
  }
  const guarded = prependWorkspaceSearchWriterFenceGuard(
    material,
    [applicationItem],
  )

  applicationItem.Put.Item.title = 'After mutation'

  expect(guarded.transactItems).toHaveLength(2)
  expect(guarded.transactItems[0]).toEqual({
    ConditionCheck: {
      TableName: 'WorkspaceSearchMigrationState',
      Key: {
        migrationId: 'workspace-search-maintenance',
        recordKey: material.conditionCheck.ConditionCheck?.Key?.recordKey.S,
      },
      ConditionExpression:
        '#canonicalBytes = :canonicalBytes AND #recordDigest = :recordDigest',
      ExpressionAttributeNames: {
        '#canonicalBytes': 'canonicalBytes',
        '#recordDigest': 'recordDigest',
      },
      ExpressionAttributeValues: {
        ':canonicalBytes':
          material.conditionCheck.ConditionCheck
            ?.ExpressionAttributeValues?.[':canonicalBytes'].S,
        ':recordDigest':
          material.conditionCheck.ConditionCheck
            ?.ExpressionAttributeValues?.[':recordDigest'].S,
      },
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  })
  expect(guarded.transactItems[1]).toEqual({
    Put: {
      TableName: 'WorkspaceSearch',
      Item: {
        workspaceId: 'workspace-1',
        recordKey: 'search/work-item/issue-1',
        title: 'Before mutation',
      },
    },
  })
  expect(guarded.materialFingerprint).toBe(material.materialFingerprint)
  expect(guarded.writerEpoch).toBe(1)
  expect(guarded.controlRevision).toBe(1)
  expect(Object.isFrozen(guarded)).toBe(true)
  expect(Object.isFrozen(guarded.transactItems)).toBe(true)
  expect(Object.isFrozen(guarded.transactItems[0])).toBe(true)
  expect(() => guarded.transactItems.shift()).toThrow(TypeError)
  expect(guarded.transactItems).toHaveLength(2)
})

test('accepts ninety-nine application actions after reserving the guard', () => {
  const material = createGuardFixture()
  const applicationItems:
    WorkspaceSearchWriterFenceDocumentTransactionItem[] = Array.from(
      { length: 99 },
      (_, index) => ({
        Put: {
          TableName: 'WorkspaceSearch',
          Item: {
            workspaceId: 'workspace-1',
            recordKey: `search/work-item/${index}`,
          },
        },
      }),
    )

  expect(
    prependWorkspaceSearchWriterFenceGuard(material, applicationItems)
      .transactItems,
  ).toHaveLength(100)
})

test('preserves detached native binary and set attribute values', () => {
  const binary = new Uint8Array([1, 2, 3])
  const buffer = Buffer.from([4, 5])
  const dataViewBytes = new Uint8Array([6, 7, 8, 9])
  const dataView = new DataView(dataViewBytes.buffer, 1, 2)
  const labels = new Set(['alpha'])
  const guarded = prependWorkspaceSearchWriterFenceGuard(
    createGuardFixture(),
    [{
      Put: {
        TableName: 'WorkspaceSearch',
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'search/work-item/native-values',
          binary,
          buffer,
          dataView,
          labels,
        },
      },
    }],
  )
  const applicationPut = guarded.transactItems[1]?.Put
  if (!applicationPut?.Item) {
    throw new Error('Expected prepared application Put.')
  }
  const preparedBinary = Reflect.get(applicationPut.Item, 'binary')
  const preparedBuffer = Reflect.get(applicationPut.Item, 'buffer')
  const preparedDataView = Reflect.get(applicationPut.Item, 'dataView')
  const preparedLabels = Reflect.get(applicationPut.Item, 'labels')
  if (
    !(preparedBinary instanceof Uint8Array) ||
    !(preparedBuffer instanceof Uint8Array) ||
    !(preparedDataView instanceof Uint8Array) ||
    !(preparedLabels instanceof Set)
  ) {
    throw new Error('Expected detached native DynamoDB values.')
  }

  binary[0] = 9
  buffer[0] = 9
  dataView.setUint8(0, 9)
  labels.add('caller-mutation')

  expect([...preparedBinary]).toEqual([1, 2, 3])
  expect([...preparedBuffer]).toEqual([4, 5])
  expect([...preparedDataView]).toEqual([7, 8])
  expect([...preparedLabels]).toEqual(['alpha'])
  expect(Object.isFrozen(guarded.transactItems)).toBe(true)
  expect(Object.isFrozen(preparedBinary)).toBe(false)
  expect(Object.isFrozen(preparedLabels)).toBe(false)
})

test('preserves exact detached boxed primitive attributes', () => {
  const boxedBoolean: unknown = Reflect.construct(Boolean, [false])
  const boxedNumber: unknown = Reflect.construct(Number, [42])
  const boxedString: unknown = Reflect.construct(String, ['boxed'])
  if (
    !(boxedBoolean instanceof Boolean) ||
    !(boxedNumber instanceof Number) ||
    !(boxedString instanceof String)
  ) {
    throw new Error('Expected boxed primitive fixtures.')
  }
  const guarded = prependWorkspaceSearchWriterFenceGuard(
    createGuardFixture(),
    [{
      Put: {
        TableName: 'WorkspaceSearch',
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'search/work-item/boxed-values',
          boxedBoolean,
          boxedNumber,
          boxedString,
        },
      },
    }],
  )
  const applicationPut = guarded.transactItems[1]?.Put
  if (!applicationPut?.Item) {
    throw new Error('Expected prepared application Put.')
  }
  const preparedBoolean = Reflect.get(
    applicationPut.Item,
    'boxedBoolean',
  )
  const preparedNumber = Reflect.get(applicationPut.Item, 'boxedNumber')
  const preparedString = Reflect.get(applicationPut.Item, 'boxedString')
  if (
    !(preparedBoolean instanceof Boolean) ||
    !(preparedNumber instanceof Number) ||
    !(preparedString instanceof String)
  ) {
    throw new Error('Expected detached boxed primitive values.')
  }

  expect(preparedBoolean).not.toBe(boxedBoolean)
  expect(preparedNumber).not.toBe(boxedNumber)
  expect(preparedString).not.toBe(boxedString)
  expect(preparedBoolean.valueOf()).toBe(false)
  expect(preparedNumber.valueOf()).toBe(42)
  expect(preparedString.valueOf()).toBe('boxed')
  expect(Object.getPrototypeOf(preparedBoolean)).toBe(Boolean.prototype)
  expect(Object.getPrototypeOf(preparedNumber)).toBe(Number.prototype)
  expect(Object.getPrototypeOf(preparedString)).toBe(String.prototype)
})

test('detaches nested Map values from caller mutation', () => {
  const exactNumber = NumberValue.from('9007199254740993')
  const nested = {
    exactNumber,
    title: 'Before mutation',
  }
  const attributes = new Map<string, unknown>([
    ['details', nested],
  ])
  const guarded = prependWorkspaceSearchWriterFenceGuard(
    createGuardFixture(),
    [{
      Put: {
        TableName: 'WorkspaceSearch',
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'search/work-item/map-value',
          attributes,
        },
      },
    }],
  )
  const applicationPut = guarded.transactItems[1]?.Put
  if (!applicationPut?.Item) {
    throw new Error('Expected prepared application Put.')
  }
  const preparedAttributesValue = Reflect.get(
    applicationPut.Item,
    'attributes',
  )
  if (!(preparedAttributesValue instanceof Map)) {
    throw new Error('Expected a detached Map.')
  }
  const preparedAttributes: Map<unknown, unknown> =
    preparedAttributesValue
  const preparedNested = preparedAttributes.get('details')
  if (
    typeof preparedNested !== 'object' ||
    preparedNested === null ||
    Array.isArray(preparedNested)
  ) {
    throw new Error('Expected a detached nested Map value.')
  }
  const preparedNumber = Reflect.get(preparedNested, 'exactNumber')
  if (!(preparedNumber instanceof NumberValue)) {
    throw new Error('Expected a detached nested NumberValue.')
  }

  nested.title = 'After mutation'
  exactNumber.value = '1'
  attributes.set('later', 'caller-mutation')

  expect(preparedAttributes).not.toBe(attributes)
  expect(preparedAttributes.size).toBe(1)
  expect(Reflect.get(preparedNested, 'title')).toBe('Before mutation')
  expect(preparedNumber.toString()).toBe('9007199254740993')
})

test('copies exact shared-memory view bytes into independent storage', () => {
  const sharedBuffer = new SharedArrayBuffer(6)
  const sharedView = new Uint8Array(sharedBuffer, 2, 3)
  sharedView.set([1, 2, 3])
  const guarded = prependWorkspaceSearchWriterFenceGuard(
    createGuardFixture(),
    [{
      Put: {
        TableName: 'WorkspaceSearch',
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'search/work-item/shared-binary',
          sharedView,
        },
      },
    }],
  )
  const applicationPut = guarded.transactItems[1]?.Put
  if (!applicationPut?.Item) {
    throw new Error('Expected prepared application Put.')
  }
  const preparedView = Reflect.get(applicationPut.Item, 'sharedView')
  if (!(preparedView instanceof Uint8Array)) {
    throw new Error('Expected independent binary bytes.')
  }

  sharedView[0] = 9

  expect([...preparedView]).toEqual([1, 2, 3])
  expect(preparedView.buffer).toBeInstanceOf(ArrayBuffer)
  expect(preparedView.buffer).not.toBe(sharedBuffer)
})

test('preserves an exact detached NumberValue scalar attribute', () => {
  const exactNumber =
    NumberValue.from('1000000000000000000000.000000000001')
  const guarded = prependWorkspaceSearchWriterFenceGuard(
    createGuardFixture(),
    [{
      Put: {
        TableName: 'WorkspaceSearch',
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'search/work-item/number-value',
          exactNumber,
        },
      },
    }],
  )
  const applicationPut = guarded.transactItems[1]?.Put
  if (!applicationPut?.Item) {
    throw new Error('Expected prepared application Put.')
  }
  const preparedNumber = Reflect.get(
    applicationPut.Item,
    'exactNumber',
  )
  if (!(preparedNumber instanceof NumberValue)) {
    throw new Error('Expected a detached NumberValue.')
  }

  exactNumber.value = '1'

  expect(preparedNumber).not.toBe(exactNumber)
  expect(preparedNumber.toString())
    .toBe('1000000000000000000000.000000000001')
  expect(preparedNumber.toAttributeValue()).toEqual({
    N: '1000000000000000000000.000000000001',
  })
  expect(Object.isFrozen(preparedNumber)).toBe(false)
})

test('preserves exact detached NumberValue set members', () => {
  const exactNumber = NumberValue.from('9007199254740993')
  const numbers = new Set([exactNumber])
  const guarded = prependWorkspaceSearchWriterFenceGuard(
    createGuardFixture(),
    [{
      Put: {
        TableName: 'WorkspaceSearch',
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'search/work-item/number-value-set',
          numbers,
        },
      },
    }],
  )
  const applicationPut = guarded.transactItems[1]?.Put
  if (!applicationPut?.Item) {
    throw new Error('Expected prepared application Put.')
  }
  const preparedNumbers = Reflect.get(applicationPut.Item, 'numbers')
  if (!(preparedNumbers instanceof Set)) {
    throw new Error('Expected a detached NumberValue set.')
  }
  const preparedNumber = preparedNumbers.values().next().value
  if (!(preparedNumber instanceof NumberValue)) {
    throw new Error('Expected a detached NumberValue set member.')
  }

  exactNumber.value = '1'
  numbers.add(NumberValue.from('2'))

  expect(preparedNumbers).not.toBe(numbers)
  expect(preparedNumbers.size).toBe(1)
  expect(preparedNumber.toString()).toBe('9007199254740993')
  expect(preparedNumber.toAttributeValue()).toEqual({
    N: '9007199254740993',
  })
  expect(preparedNumber).not.toBe(exactNumber)
})

test('rejects unsupported custom application values before transport', () => {
  expect(() =>
    prependWorkspaceSearchWriterFenceGuard(
      createGuardFixture(),
      [{
        Put: {
          TableName: 'WorkspaceSearch',
          Item: {
            workspaceId: 'workspace-1',
            recordKey: 'search/work-item/custom-value',
            custom: new UnsupportedApplicationDocumentValue(),
          },
        },
      }],
    )
  ).toThrow(WorkspaceSearchWriterFenceTransactionPreparationError)
})

test('rejects subclasses of supported native values before transport', () => {
  const unsupportedValues = [
    new UnsupportedNumberValueSubclass('1'),
    new UnsupportedBoxedNumberSubclass(1),
    new UnsupportedArraySubclass('value'),
    new UnsupportedSetSubclass(['value']),
    new UnsupportedMapSubclass([['key', 'value']]),
    new UnsupportedArrayBufferSubclass(1),
    new UnsupportedUint8ArraySubclass([1]),
    new UnsupportedBlobSubclass(['value']),
    new UnsupportedFileSubclass(['value'], 'value.txt'),
  ]

  for (const custom of unsupportedValues) {
    expect(() =>
      prependWorkspaceSearchWriterFenceGuard(
        createGuardFixture(),
        [{
          Put: {
            TableName: 'WorkspaceSearch',
            Item: {
              workspaceId: 'workspace-1',
              recordKey: 'search/work-item/native-subclass',
              custom,
            },
          },
        }],
      )
    ).toThrow(WorkspaceSearchWriterFenceTransactionPreparationError)
  }
})

test('rejects one hundred application actions before transport', () => {
  const material = createGuardFixture()
  const applicationItems:
    WorkspaceSearchWriterFenceDocumentTransactionItem[] = Array.from(
      { length: 100 },
      (_, index) => ({
        Put: {
          TableName: 'WorkspaceSearch',
          Item: {
            workspaceId: 'workspace-1',
            recordKey: `search/work-item/${index}`,
          },
        },
      }),
    )

  expect(() =>
    prependWorkspaceSearchWriterFenceGuard(material, applicationItems)
  ).toThrow(WorkspaceSearchWriterFenceTransactionPreparationError)
})

test('rejects tampered low-level material before document marshalling', () => {
  const material = structuredClone(createGuardFixture())
  const canonicalValue =
    material.conditionCheck.ConditionCheck
      ?.ExpressionAttributeValues?.[':canonicalBytes']
  if (!canonicalValue) {
    throw new Error('Expected canonical fixture value.')
  }
  Reflect.set(canonicalValue, 'N', '1')

  expect(() =>
    prependWorkspaceSearchWriterFenceGuard(material, [])
  ).toThrow(WorkspaceSearchWriterFenceTransactionPreparationError)
})

test('rejects closed-row bytes relabeled with open epoch metadata', () => {
  expect(() =>
    prependWorkspaceSearchWriterFenceGuard(
      createClosedRowMasqueradingGuardFixture(),
      [],
    )
  ).toThrow(WorkspaceSearchWriterFenceTransactionPreparationError)
})

test('detects only a guard cancellation at reserved reason zero', () => {
  const blocked = {
    name: 'TransactionCanceledException',
    CancellationReasons: [
      { Code: 'ConditionalCheckFailed' },
      { Code: 'None' },
    ],
  }
  const applicationConflict = {
    name: 'TransactionCanceledException',
    CancellationReasons: [
      { Code: 'None' },
      { Code: 'ConditionalCheckFailed' },
    ],
  }

  expect(isWorkspaceSearchWriterFenceBlockedTransaction(blocked)).toBe(true)
  expect(
    isWorkspaceSearchWriterFenceBlockedTransaction(applicationConflict),
  ).toBe(false)
  expect(
    isWorkspaceSearchWriterFenceBlockedTransaction(new Error('unrelated')),
  ).toBe(false)
  expect(() =>
    throwIfWorkspaceSearchWriterFenceBlocked(blocked)
  ).toThrow(WorkspaceSearchWriterFenceBlockedError)
  expect(() =>
    throwIfWorkspaceSearchWriterFenceBlocked(applicationConflict)
  ).not.toThrow()
})
