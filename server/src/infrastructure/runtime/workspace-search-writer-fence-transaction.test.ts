import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceGuardMaterial,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  encodeWorkspaceSearchWriterFenceRecord,
  parseWorkspaceSearchWriterFenceObservation,
  type WorkspaceSearchWriterFenceGuardMaterial,
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
 * Creates deterministic open-row guard material for transaction tests.
 *
 * @returns Exact valid guard material.
 */
function createGuardFixture(): WorkspaceSearchWriterFenceGuardMaterial {
  const stateTableId = 'migration-state-primary'
  const binding = createWorkspaceSearchWriterFenceBinding({
    stateTableName: 'WorkspaceSearchMigrationState',
    stateTableId,
    stateIncarnationDigest: createHash('sha256')
      .update('state-primary')
      .digest('hex'),
    tableIds: {
      'project-directory': 'project-directory-primary',
      'work-items': 'work-items-primary',
      collaboration: 'collaboration-primary',
      documents: 'documents-primary',
      'workspace-search': 'workspace-search-primary',
      'migration-state': stateTableId,
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
  )
}

/**
 * Creates closed-row bytes mislabeled as an open application guard.
 *
 * @returns Deliberately forged guard material.
 */
function createClosedRowMasqueradingGuardFixture():
  WorkspaceSearchWriterFenceGuardMaterial {
  const stateTableId = 'migration-state-closed'
  const binding = createWorkspaceSearchWriterFenceBinding({
    stateTableName: 'WorkspaceSearchMigrationState',
    stateTableId,
    stateIncarnationDigest: createHash('sha256')
      .update('state-closed')
      .digest('hex'),
    tableIds: {
      'project-directory': 'project-directory-closed',
      'work-items': 'work-items-closed',
      collaboration: 'collaboration-closed',
      documents: 'documents-closed',
      'workspace-search': 'workspace-search-closed',
      'migration-state': stateTableId,
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
  const preparedLabels = Reflect.get(applicationPut.Item, 'labels')
  if (
    !(preparedBinary instanceof Uint8Array) ||
    !(preparedLabels instanceof Set)
  ) {
    throw new Error('Expected detached native DynamoDB values.')
  }

  binary[0] = 9
  labels.add('caller-mutation')

  expect([...preparedBinary]).toEqual([1, 2, 3])
  expect([...preparedLabels]).toEqual(['alpha'])
  expect(Object.isFrozen(guarded.transactItems)).toBe(true)
  expect(Object.isFrozen(preparedBinary)).toBe(false)
  expect(Object.isFrozen(preparedLabels)).toBe(false)
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
