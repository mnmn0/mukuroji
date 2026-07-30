import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchMigrationRollbackConflictRecordKeys,
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
})
