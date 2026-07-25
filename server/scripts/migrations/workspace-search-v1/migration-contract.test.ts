import { describe, expect, test } from 'bun:test'
import { encodeAttributeMap } from './dynamodb-attribute-codec'
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
  type WorkspaceSearchJournalSegment,
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

    const prototypeNamed = Object.fromEntries([
      ['__proto__', 'preserved'],
      ['constructor', 'also-preserved'],
    ])
    expect(serializeCanonicalJson(prototypeNamed)).toBe(
      '{"__proto__":"preserved","constructor":"also-preserved"}',
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

  test('exports and restores complete digest checkpoint state', () => {
    const values = ['alpha', 'beta', 'gamma'].map(createMigrationDigest)
    const uninterrupted = new MigrationDigestAccumulator()
    const checkpointed = new MigrationDigestAccumulator()

    uninterrupted.add(values[0] ?? '')
    uninterrupted.add(values[1] ?? '')
    uninterrupted.add(values[2] ?? '')
    checkpointed.add(values[0] ?? '')
    checkpointed.add(values[1] ?? '')

    const state = checkpointed.exportState()
    const resumed = MigrationDigestAccumulator.fromState(state)
    resumed.add(values[2] ?? '')

    expect(resumed.exportState()).toEqual(uninterrupted.exportState())
    expect(resumed.digest()).toBe(uninterrupted.digest())
    expect(() => MigrationDigestAccumulator.fromState({
      count: -1,
      sumHex: state.sumHex,
      xorHex: state.xorHex,
    })).toThrow(WorkspaceSearchMigrationFailure)
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

  test('keeps restart-safe target keys and snapshots JSON-safe in journal segments', () => {
    const targetKey = encodeAttributeMap({
      workspaceId: { S: 'workspace-1' },
      recordKey: { S: 'DOCUMENT#work-item#example' },
    })
    const afterItem = encodeAttributeMap({
      workspaceId: { S: 'workspace-1' },
      recordKey: { S: 'DOCUMENT#work-item#example' },
      binary: { B: Uint8Array.from([0, 1, 255]) },
      numberSet: { NS: ['1.00', '2e+1'] },
    })
    const segment: WorkspaceSearchJournalSegment = {
      kind: 'workspace-search-preimage-segment',
      segmentVersion: 1,
      migrationId: 'workspace-search-maintenance',
      migrationVersion: 1,
      runId: 'run-1',
      configurationHash: createMigrationDigest('configuration'),
      sequence: 1,
      preparedFenceToken: 1,
      operationId: createMigrationDigest('operation'),
      sourceDigest: createMigrationDigest('source'),
      previousHeadDigest: zeroHexDigest(),
      targetKey,
      targetKeyDigest: createMigrationDigest(targetKey),
      before: {
        exists: false,
        digest: createMigrationDigest({ exists: false }),
      },
      after: {
        exists: true,
        item: afterItem,
        digest: createMigrationDigest(afterItem),
      },
      createdAt: '2026-07-25T04:00:00.000Z',
    }

    const serialized = serializeCanonicalJson(segment)

    expect(serialized).toContain('"targetKey"')
    expect(serialized).toContain('"type":"B","value":"AAH/"')
    expect(serialized).toContain('"type":"NS","value":["1.00","2e+1"]')
    expect(serialized).not.toContain('"0":0')
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
    const emptyDigest = new MigrationDigestAccumulator().digest()

    expect(aggregate).toEqual({
      scanned: 0,
      mapped: 0,
      ignored: 0,
      invalid: 0,
      projected: 0,
      deleted: 0,
      keyDigest: emptyDigest,
      contentDigest: emptyDigest,
      pageCount: 0,
    })
    expect(aggregate.keyDigest).toBe(aggregate.contentDigest)
  })
})
