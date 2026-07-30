import { describe, expect, test } from 'bun:test'
import { WorkspaceSearchMigrationFailure } from './migration-contract'
import {
  createWorkspaceSearchMigrationRollbackConflictRecordKeys,
  createWorkspaceSearchMigrationRollbackReceiptV2RecordKey,
  createWorkspaceSearchMigrationRolledBackRootV2RecordKey,
  createWorkspaceSearchMigrationRollbackStateV2RecordKey,
  createWorkspaceSearchMigrationRollbackStartRecordKey,
} from './migration-rollback-key'

describe('workspace search rollback conflict record keys', () => {
  test('preserves the durable version-one rollback-start key vector', () => {
    const keys =
      createWorkspaceSearchMigrationRollbackConflictRecordKeys({
        stateTableId: 'state-table-id',
        configurationHash: '1'.repeat(64),
        runId: 'run-1',
        executionRunDigest: '2'.repeat(64),
      })
    const expectedBindingDigest =
      'f2ecea79c854f6e58b9c23a17af47cd0e8db013002a2b056cea998f97ac009dc'

    expect(keys).toEqual({
      bindingDigest: expectedBindingDigest,
      start: `rollback-start/v1/${expectedBindingDigest}`,
    })
    expect(
      createWorkspaceSearchMigrationRollbackStartRecordKey(
        expectedBindingDigest,
      ),
    ).toBe(keys.start)
    expect(
      createWorkspaceSearchMigrationRollbackStateV2RecordKey(
        expectedBindingDigest,
      ),
    ).toBe(`rollback-state/v2/${expectedBindingDigest}`)
  })

  test('creates deterministic version-two receipt and terminal root keys', () => {
    const bindingDigest = '3'.repeat(64)

    expect(
      createWorkspaceSearchMigrationRollbackReceiptV2RecordKey(
        bindingDigest,
        1,
      ),
    ).toBe(`rollback-receipt/v2/${bindingDigest}/1`)
    expect(
      createWorkspaceSearchMigrationRollbackReceiptV2RecordKey(
        bindingDigest,
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(
      `rollback-receipt/v2/${bindingDigest}/${Number.MAX_SAFE_INTEGER}`,
    )
    expect(
      createWorkspaceSearchMigrationRolledBackRootV2RecordKey(
        bindingDigest,
      ),
    ).toBe(`rolled-back-root/v2/${bindingDigest}`)
  })

  test('rejects non-positive and unsafe receipt sequences', () => {
    const bindingDigest = '4'.repeat(64)
    const invalidSequences = [
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ]

    for (const sequence of invalidSequences) {
      let failure: unknown
      try {
        createWorkspaceSearchMigrationRollbackReceiptV2RecordKey(
          bindingDigest,
          sequence,
        )
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(
        WorkspaceSearchMigrationFailure,
      )
      if (!(failure instanceof WorkspaceSearchMigrationFailure)) {
        throw new Error('Expected a migration failure.')
      }
      expect(failure.code).toBe('INVALID_ARGUMENT')
      expect(failure.message).toBe(
        'Rollback receipt sequence must be a positive safe integer.',
      )
    }
  })
})
