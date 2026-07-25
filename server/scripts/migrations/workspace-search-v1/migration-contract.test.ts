import { describe, expect, test } from 'bun:test'
import {
  createEmptyMigrationScanAggregate,
  createJournalHeadDigest,
  createMigrationDigest,
  createWorkspaceSearchOperationId,
  isCanonicalTimestamp,
  MigrationDigestAccumulator,
  requireCommitOid,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  WorkspaceSearchMigrationFailure,
  zeroHexDigest,
} from './migration-contract'

describe('Workspace Search migration contract', () => {
  test('canonicalizes nested JSON and rejects unsupported values', () => {
    expect(serializeCanonicalJson({
      z: [3, { beta: true, alpha: 'first' }],
      a: { second: 2, first: 1, omitted: undefined },
    })).toBe(
      '{"a":{"first":1,"second":2},"z":[3,{"alpha":"first","beta":true}]}',
    )

    expect(() => serializeCanonicalJson(new Set(['unsupported']))).toThrow(
      WorkspaceSearchMigrationFailure,
    )
    expect(() => serializeCanonicalJson(Number.NaN)).toThrow(
      WorkspaceSearchMigrationFailure,
    )
  })

  test('builds order-independent bounded aggregate digests', () => {
    const values = ['alpha', 'beta', 'gamma'].map(createMigrationDigest)
    const forward = new MigrationDigestAccumulator()
    const reverse = new MigrationDigestAccumulator()

    for (const value of values) forward.add(value)
    for (const value of [...values].reverse()) reverse.add(value)

    expect(forward.digest()).toBe(reverse.digest())
    expect(forward.size()).toBe(3)

    const duplicate = new MigrationDigestAccumulator()
    duplicate.add(values[0] ?? '')
    duplicate.add(values[0] ?? '')
    duplicate.add(values[2] ?? '')
    expect(duplicate.digest()).not.toBe(forward.digest())
  })

  test('binds operation IDs to physical source and target identity, not mutable content', () => {
    const configurationHash = createMigrationDigest('configuration')
    const sourceKeyDigest = createMigrationDigest('source-key')
    const targetKeyDigest = createMigrationDigest('target-key')
    const operationId = createWorkspaceSearchOperationId({
      configurationHash,
      sourceTableId: 'physical-source-table-id',
      sourceKeyDigest,
      targetKeyDigest,
    })

    expect(operationId).toBe(
      createWorkspaceSearchOperationId({
        configurationHash,
        sourceTableId: 'physical-source-table-id',
        sourceKeyDigest,
        targetKeyDigest,
      }),
    )
    expect(operationId).not.toBe(
      createWorkspaceSearchOperationId({
        configurationHash,
        sourceTableId: 'replacement-source-table-id',
        sourceKeyDigest,
        targetKeyDigest,
      }),
    )
  })

  test('chains exact journal bytes and immutable S3 versions', () => {
    const contentDigest = createMigrationDigest('exact-journal-bytes')
    const operationId = createMigrationDigest('operation')
    const first = createJournalHeadDigest({
      previousHeadDigest: zeroHexDigest(),
      sequence: 1,
      operationId,
      contentDigest,
      versionId: 'version-one',
    })

    expect(first).not.toBe(zeroHexDigest())
    expect(createJournalHeadDigest({
      previousHeadDigest: zeroHexDigest(),
      sequence: 1,
      operationId,
      contentDigest,
      versionId: 'version-two',
    })).not.toBe(first)
    expect(createJournalHeadDigest({
      previousHeadDigest: first,
      sequence: 2,
      operationId: createMigrationDigest('next-operation'),
      contentDigest: createMigrationDigest('next-journal-bytes'),
      versionId: 'version-three',
    })).not.toBe(first)
  })

  test('validates safe identifiers, exact commits, and canonical timestamps', () => {
    expect(requireMigrationIdentifier('run_2026-07-25.1', 'Run ID')).toBe(
      'run_2026-07-25.1',
    )
    expect(() => requireMigrationIdentifier('../escape', 'Run ID')).toThrow(
      WorkspaceSearchMigrationFailure,
    )
    expect(requireCommitOid('a'.repeat(40))).toBe('a'.repeat(40))
    expect(() => requireCommitOid('a'.repeat(39))).toThrow(
      WorkspaceSearchMigrationFailure,
    )
    expect(isCanonicalTimestamp('2026-07-25T04:00:00.000Z')).toBe(true)
    expect(isCanonicalTimestamp('2026-07-25T13:00:00+09:00')).toBe(false)
  })

  test('uses canonical zero-entry digests for empty scans', () => {
    const aggregate = createEmptyMigrationScanAggregate()

    expect(aggregate).toEqual({
      scanned: 0,
      mapped: 0,
      ignored: 0,
      invalid: 0,
      projected: 0,
      deleted: 0,
      keyDigest: aggregate.keyDigest,
      contentDigest: aggregate.contentDigest,
      pageCount: 0,
    })
    expect(aggregate.keyDigest).toBe(aggregate.contentDigest)
  })
})
