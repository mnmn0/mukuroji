import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchMigrationFullVerificationConflictRecordKeys,
} from './migration-full-verification-key'

describe(
  'workspace search full-verification conflict record keys',
  () => {
    test('preserves the durable version-one key vector', () => {
      const keys =
        createWorkspaceSearchMigrationFullVerificationConflictRecordKeys({
          stateTableId: 'state-table-id',
          configurationHash: '1'.repeat(64),
          runId: 'run-1',
          executionRunDigest: '2'.repeat(64),
          sealedPlanningAuthorityDigest: '3'.repeat(64),
        })
      const expectedBindingDigest =
        'e6917e70479ab6db8db03c7a8d8490305eb9094d0f8d6bb63e149ea37b61cdd1'

      expect(keys).toEqual({
        bindingDigest: expectedBindingDigest,
        state:
          `full-verification-state/v1/${expectedBindingDigest}`,
        root:
          `full-verification-verified-root/v1/${expectedBindingDigest}`,
      })
    })
  },
)
