import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceGuardMaterial,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceReadMaterial,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  createWorkspaceSearchWriterFenceTransitionPut,
  encodeWorkspaceSearchWriterFenceRecord,
  parseWorkspaceSearchWriterFenceObservation,
  readWorkspaceSearchWriterFenceGuardMaterial,
  WorkspaceSearchWriterFenceError,
  workspaceSearchWriterFenceClosedRecordMatchesAuthority,
  type WorkspaceSearchWriterFenceAuthority,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceObservation,
  type WorkspaceSearchWriterFenceStateIdentity,
} from './workspace-search-writer-fence'

/**
 * Computes one lowercase SHA-256 test fixture digest.
 *
 * @param value - Fixture seed.
 * @returns Deterministic lowercase digest.
 */
function digestFixture(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Creates one complete migration-state identity fixture.
 *
 * @param suffix - Distinguishes physical state-table incarnations.
 * @returns Complete deterministic measured identity.
 */
function createStateIdentityFixture(
  suffix = 'primary',
): WorkspaceSearchWriterFenceStateIdentity {
  return {
    role: 'migration-state',
    tableName: 'WorkspaceSearchMigrationState',
    tableArn:
      'arn:aws:dynamodb:ap-northeast-1:123456789012:table/WorkspaceSearchMigrationState',
    tableId: `migration-state-${suffix}`,
    creationTime: '2026-07-29T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
  }
}

/**
 * Creates one complete measured writer-fence binding fixture.
 *
 * @param suffix - Distinguishes physical table incarnations.
 * @returns Strict deterministic binding.
 */
function createBindingFixture(
  suffix = 'primary',
): WorkspaceSearchWriterFenceBinding {
  const stateIdentity = createStateIdentityFixture(suffix)
  return createWorkspaceSearchWriterFenceBinding({
    stateTableName: stateIdentity.tableName,
    stateTableId: stateIdentity.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest(stateIdentity),
    tableIds: {
      'project-directory': `project-directory-${suffix}`,
      'work-items': `work-items-${suffix}`,
      collaboration: `collaboration-${suffix}`,
      documents: `documents-${suffix}`,
      'workspace-search': `workspace-search-${suffix}`,
      'migration-state': stateIdentity.tableId,
    },
  })
}

/**
 * Creates one binding fixture with deliberately reordered role properties.
 *
 * @returns Binding equivalent to the primary fixture.
 */
function createReorderedBindingFixture(): WorkspaceSearchWriterFenceBinding {
  const stateIdentity = createStateIdentityFixture()
  return createWorkspaceSearchWriterFenceBinding({
    stateTableName: stateIdentity.tableName,
    stateTableId: stateIdentity.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest(stateIdentity),
    tableIds: {
      'migration-state': 'migration-state-primary',
      'workspace-search': 'workspace-search-primary',
      documents: 'documents-primary',
      collaboration: 'collaboration-primary',
      'work-items': 'work-items-primary',
      'project-directory': 'project-directory-primary',
    },
  })
}

/**
 * Creates one strict migration close-authority fixture.
 *
 * @param leaseFenceToken - Exact lease takeover token.
 * @returns Stable authority fixture.
 */
function createAuthorityFixture(
  leaseFenceToken = 7,
): WorkspaceSearchWriterFenceAuthority {
  return {
    configurationHash: digestFixture('configuration'),
    runId: 'run-2026-07-29',
    ownerId: 'owner-01',
    leaseFenceToken,
    maintenanceEvidenceReceiptDigest: digestFixture(
      'maintenance-evidence',
    ),
    maintenanceEvidencePointerRevision: 3,
  }
}

/**
 * Creates one low-level writer-fence item from exact persisted identity.
 *
 * @param canonicalBytes - Exact persisted canonical bytes.
 * @param recordDigest - Digest persisted beside the bytes.
 * @param recordKey - Exact fence sort key.
 * @returns Four-attribute low-level DynamoDB item.
 */
function createRawItem(
  canonicalBytes: string,
  recordDigest: string,
  recordKey: string,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: 'workspace-search-maintenance' },
    recordKey: { S: recordKey },
    canonicalBytes: { S: canonicalBytes },
    recordDigest: { S: recordDigest },
  }
}

/**
 * Recomputes the public secret-free guard fingerprint for a table name.
 *
 * @param binding - Durable binding committed by the open row.
 * @param recordDigest - Exact open-row digest.
 * @param stateTableName - Candidate ConditionCheck table name.
 * @returns Deterministic lowercase material fingerprint.
 */
function createMaterialFingerprintFixture(
  binding: WorkspaceSearchWriterFenceBinding,
  recordDigest: string,
  stateTableName: string,
): string {
  return digestFixture(JSON.stringify({
    datasetBindingDigest: binding.datasetBindingDigest,
    recordDigest,
    recordKey: binding.recordKey,
    stateIncarnationDigest: binding.stateIncarnationDigest,
    stateTableId: binding.stateTableId,
    stateTableName,
  }))
}

test('constructs deterministic bindings independent of property order', () => {
  const first = createBindingFixture()
  const repeated = createBindingFixture()
  const reordered = createReorderedBindingFixture()
  const replacement = createBindingFixture('replacement')

  expect(repeated).toEqual(first)
  expect(reordered).toEqual(first)
  expect(first.datasetBindingDigest).toMatch(/^[0-9a-f]{64}$/u)
  expect(first.recordKey).toBe(
    `application-writer-fence/v1/${first.stateIncarnationDigest}/${first.datasetBindingDigest}`,
  )
  expect(replacement.datasetBindingDigest).not.toBe(
    first.datasetBindingDigest,
  )
  expect(replacement.recordKey).not.toBe(first.recordKey)
  expect(() => createWorkspaceSearchWriterFenceBinding({
    stateTableName: first.stateTableName,
    stateTableId: first.stateTableId,
    stateIncarnationDigest: first.stateIncarnationDigest,
    tableIds: {
      ...first.tableIds,
      'work-items': first.tableIds['project-directory'],
    },
  })).toThrow(WorkspaceSearchWriterFenceError)
})

test('derives the state incarnation from every immutable physical identity field', () => {
  const identity: WorkspaceSearchWriterFenceStateIdentity = {
    role: 'migration-state',
    tableName: 'WorkspaceSearchMigrationState',
    tableArn:
      'arn:aws:dynamodb:ap-northeast-1:123456789012:table/WorkspaceSearchMigrationState',
    tableId: 'migration-state-primary',
    creationTime: '2026-07-29T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
  }
  const reordered = createWorkspaceSearchWriterFenceStateIncarnationDigest({
    region: identity.region,
    account: identity.account,
    creationTime: identity.creationTime,
    tableId: identity.tableId,
    tableArn: identity.tableArn,
    tableName: identity.tableName,
    role: identity.role,
  })
  const baseline = createWorkspaceSearchWriterFenceStateIncarnationDigest(
    identity,
  )
  const replacements: readonly WorkspaceSearchWriterFenceStateIdentity[] = [
    { ...identity, tableName: 'WorkspaceSearchMigrationState2' },
    {
      ...identity,
      tableArn:
        'arn:aws:dynamodb:ap-northeast-1:123456789012:table/WorkspaceSearchMigrationState2',
    },
    { ...identity, tableId: 'migration-state-replacement' },
    { ...identity, creationTime: '2026-07-29T00:00:00.001Z' },
    { ...identity, account: '210987654321' },
    { ...identity, region: 'us-east-1' },
  ]

  expect(baseline).toMatch(/^[0-9a-f]{64}$/u)
  expect(baseline).toBe(
    'a39317d3eab592e969088ed6a5493293ef87d059ce983cc336b7b213b68bee8c',
  )
  expect(reordered).toBe(baseline)
  for (const replacement of replacements) {
    expect(
      createWorkspaceSearchWriterFenceStateIncarnationDigest(replacement),
    ).not.toBe(baseline)
  }
})

test('round-trips the initial open row through strict storage and read material', () => {
  const binding = createBindingFixture()
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  const item = encodeWorkspaceSearchWriterFenceRecord(open)

  expect(open).toMatchObject({
    mode: 'open',
    writerEpoch: 1,
    controlRevision: 1,
    openedAt: '2026-07-29T00:00:00.000Z',
    previousClosedRecordDigest: null,
  })
  expect(item).toEqual(createRawItem(
    open.canonicalBytes,
    open.recordDigest,
    binding.recordKey,
  ))
  expect(open.canonicalBytes).not.toContain('stateTableIdentity')
  expect(parseWorkspaceSearchWriterFenceObservation(
    item,
    binding,
  )).toEqual({
    status: 'present',
    record: open,
  })
  expect(parseWorkspaceSearchWriterFenceObservation(
    undefined,
    binding,
  )).toEqual({
    status: 'missing',
    binding,
  })
  expect(createWorkspaceSearchWriterFenceReadMaterial(binding)).toEqual({
    TableName: binding.stateTableName,
    ConsistentRead: true,
    Key: {
      migrationId: { S: 'workspace-search-maintenance' },
      recordKey: { S: binding.recordKey },
    },
  })
})

test('fails closed instead of creating guard material for a missing row', () => {
  const binding = createBindingFixture()
  const stateIdentity = createStateIdentityFixture()

  expect(() => createWorkspaceSearchWriterFenceGuardMaterial(
    { status: 'missing', binding },
    binding,
    stateIdentity,
  )).toThrow(WorkspaceSearchWriterFenceError)
})

test('creates an exact deterministic guard for one open row', () => {
  const binding = createBindingFixture()
  const stateIdentity = createStateIdentityFixture()
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  const observation: WorkspaceSearchWriterFenceObservation = {
    status: 'present',
    record: open,
  }
  const guard = createWorkspaceSearchWriterFenceGuardMaterial(
    observation,
    binding,
    stateIdentity,
  )

  expect(guard).toEqual({
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
          ':canonicalBytes': { S: open.canonicalBytes },
          ':recordDigest': { S: open.recordDigest },
        },
        ReturnValuesOnConditionCheckFailure: 'NONE',
      },
    },
    materialFingerprint:
      '16c3962d869f4d3556603348aa44df6ced4b6cd5b560c09d026ed960ff527255',
    stateTableIdentity: stateIdentity,
    writerEpoch: 1,
    controlRevision: 1,
  })
  expect(guard.materialFingerprint).toMatch(/^[0-9a-f]{64}$/u)
  expect(createWorkspaceSearchWriterFenceGuardMaterial(
    observation,
    binding,
    stateIdentity,
  )).toEqual(guard)
  expect(readWorkspaceSearchWriterFenceGuardMaterial(guard)).toEqual(guard)
})

test('rejects a substituted condition table with a recomputed fingerprint', () => {
  const binding = createBindingFixture()
  const stateIdentity = createStateIdentityFixture()
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  const guard = createWorkspaceSearchWriterFenceGuardMaterial(
    { status: 'present', record: open },
    binding,
    stateIdentity,
  )
  const forged = structuredClone(guard)
  const substitutedTableName = 'RestoredWorkspaceSearchMigrationState'
  const condition = forged.conditionCheck.ConditionCheck
  if (condition === undefined) throw new Error('INVALID_TEST_FIXTURE')
  Reflect.set(condition, 'TableName', substitutedTableName)
  Reflect.set(
    forged,
    'materialFingerprint',
    createMaterialFingerprintFixture(
      binding,
      open.recordDigest,
      substitutedTableName,
    ),
  )

  expect(() =>
    readWorkspaceSearchWriterFenceGuardMaterial(forged)
  ).toThrow(WorkspaceSearchWriterFenceError)
})

test('requires complete state identity to match the durable binding', () => {
  const binding = createBindingFixture()
  const stateIdentity = createStateIdentityFixture()
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  const restoredTableName = 'RestoredWorkspaceSearchMigrationState'
  const restoredIdentity: WorkspaceSearchWriterFenceStateIdentity = {
    ...stateIdentity,
    tableName: restoredTableName,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/${restoredTableName}`,
  }

  expect(
    createWorkspaceSearchWriterFenceStateIncarnationDigest(restoredIdentity),
  ).not.toBe(binding.stateIncarnationDigest)
  expect(() => createWorkspaceSearchWriterFenceGuardMaterial(
    { status: 'present', record: open },
    binding,
    restoredIdentity,
  )).toThrow(WorkspaceSearchWriterFenceError)

  const guard = createWorkspaceSearchWriterFenceGuardMaterial(
    { status: 'present', record: open },
    binding,
    stateIdentity,
  )
  const forged = structuredClone(guard)
  const condition = forged.conditionCheck.ConditionCheck
  if (condition === undefined) throw new Error('INVALID_TEST_FIXTURE')
  Reflect.set(condition, 'TableName', restoredTableName)
  Reflect.set(forged, 'stateTableIdentity', restoredIdentity)
  Reflect.set(
    forged,
    'materialFingerprint',
    createMaterialFingerprintFixture(
      binding,
      open.recordDigest,
      restoredTableName,
    ),
  )

  expect(() =>
    readWorkspaceSearchWriterFenceGuardMaterial(forged)
  ).toThrow(WorkspaceSearchWriterFenceError)
})

test('increments epochs and revisions across the one-way exact close', () => {
  const binding = createBindingFixture()
  const stateIdentity = createStateIdentityFixture()
  const authority = createAuthorityFixture()
  const initial = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  const closed = createWorkspaceSearchWriterFenceClosedSuccessor(
    initial,
    authority,
    new Date('2026-07-29T00:01:00.000Z'),
  )

  expect(closed).toMatchObject({
    mode: 'closed',
    writerEpoch: 2,
    controlRevision: 2,
    closedAt: '2026-07-29T00:01:00.000Z',
    authority,
  })
  expect(() => createWorkspaceSearchWriterFenceGuardMaterial(
    { status: 'present', record: closed },
    binding,
    stateIdentity,
  )).toThrow(WorkspaceSearchWriterFenceError)
})

test('binds writer tokens and transitions to exact predecessor bytes', () => {
  const binding = createBindingFixture()
  const stateIdentity = createStateIdentityFixture()
  const initial = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  const closed = createWorkspaceSearchWriterFenceClosedSuccessor(
    initial,
    createAuthorityFixture(),
    new Date('2026-07-29T00:01:00.000Z'),
  )
  const guard = createWorkspaceSearchWriterFenceGuardMaterial(
    { status: 'present', record: initial },
    binding,
    stateIdentity,
  )
  const closePut = createWorkspaceSearchWriterFenceTransitionPut(
    { status: 'present', record: initial },
    closed,
  )

  expect(guard.writerEpoch).toBe(1)
  expect(
    guard.conditionCheck.ConditionCheck?.ExpressionAttributeValues,
  ).toEqual({
    ':canonicalBytes': { S: initial.canonicalBytes },
    ':recordDigest': { S: initial.recordDigest },
  })
  expect(closePut.Put?.ExpressionAttributeValues).toEqual({
    ':canonicalBytes': { S: initial.canonicalBytes },
    ':recordDigest': { S: initial.recordDigest },
  })
  expect(() => createWorkspaceSearchWriterFenceTransitionPut(
    { status: 'present', record: closed },
    initial,
  )).toThrow(WorkspaceSearchWriterFenceError)
})

test('uses missing-key and exact-predecessor transition conditions', () => {
  const binding = createBindingFixture()
  const initial = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  const bootstrap = createWorkspaceSearchWriterFenceTransitionPut(
    { status: 'missing', binding },
    initial,
  )
  const closed = createWorkspaceSearchWriterFenceClosedSuccessor(
    initial,
    createAuthorityFixture(),
    new Date('2026-07-29T00:01:00.000Z'),
  )
  const close = createWorkspaceSearchWriterFenceTransitionPut(
    { status: 'present', record: initial },
    closed,
  )

  expect(bootstrap.Put).toMatchObject({
    TableName: binding.stateTableName,
    ConditionExpression:
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    ExpressionAttributeNames: {
      '#migrationId': 'migrationId',
      '#recordKey': 'recordKey',
    },
    ReturnValuesOnConditionCheckFailure: 'NONE',
  })
  expect(bootstrap.Put?.ExpressionAttributeValues).toBeUndefined()
  expect(close.Put).toMatchObject({
    TableName: binding.stateTableName,
    ConditionExpression:
      '#canonicalBytes = :canonicalBytes AND #recordDigest = :recordDigest',
    ExpressionAttributeNames: {
      '#canonicalBytes': 'canonicalBytes',
      '#recordDigest': 'recordDigest',
    },
    ExpressionAttributeValues: {
      ':canonicalBytes': { S: initial.canonicalBytes },
      ':recordDigest': { S: initial.recordDigest },
    },
    ReturnValuesOnConditionCheckFailure: 'NONE',
  })
})

test('rejects rows, guards, and transitions bound to different tables', () => {
  const binding = createBindingFixture()
  const replacement = createBindingFixture('replacement')
  const replacementStateIdentity = createStateIdentityFixture('replacement')
  const initial = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )

  expect(() => parseWorkspaceSearchWriterFenceObservation(
    encodeWorkspaceSearchWriterFenceRecord(initial),
    replacement,
  )).toThrow(WorkspaceSearchWriterFenceError)
  expect(() => createWorkspaceSearchWriterFenceGuardMaterial(
    { status: 'present', record: initial },
    replacement,
    replacementStateIdentity,
  )).toThrow(WorkspaceSearchWriterFenceError)
  expect(() => createWorkspaceSearchWriterFenceTransitionPut(
    { status: 'missing', binding: replacement },
    initial,
  )).toThrow(WorkspaceSearchWriterFenceError)
})

test('rejects extra, malformed, noncanonical, and digest-tampered items', () => {
  const binding = createBindingFixture()
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  const closed = createWorkspaceSearchWriterFenceClosedSuccessor(
    open,
    createAuthorityFixture(),
    new Date('2026-07-29T00:01:00.000Z'),
  )
  const encoded = encodeWorkspaceSearchWriterFenceRecord(open)
  const noncanonicalBytes = ` ${open.canonicalBytes}`
  const extraPayloadBytes = open.canonicalBytes.replace(
    /\}$/u,
    ',"unexpected":true}',
  )
  const unauthorizedReopenBytes = open.canonicalBytes
    .replace('"writerEpoch":1', '"writerEpoch":3')
    .replace('"controlRevision":1', '"controlRevision":3')
    .replace(
      '"previousClosedRecordDigest":null',
      `"previousClosedRecordDigest":"${digestFixture('closed')}"`,
    )
  const unreachableClosedEpochBytes = closed.canonicalBytes.replace(
    '"writerEpoch":2',
    '"writerEpoch":3',
  )
  const unreachableClosedRevisionBytes = closed.canonicalBytes.replace(
    '"controlRevision":2',
    '"controlRevision":3',
  )
  const candidates: ReadonlyArray<
    Readonly<Record<string, AttributeValue>>
  > = [
    {
      ...encoded,
      unexpected: { S: 'not-allowed' },
    },
    {
      ...encoded,
      recordDigest: { S: '0'.repeat(64) },
    },
    createRawItem(
      noncanonicalBytes,
      digestFixture(noncanonicalBytes),
      binding.recordKey,
    ),
    createRawItem(
      extraPayloadBytes,
      digestFixture(extraPayloadBytes),
      binding.recordKey,
    ),
    createRawItem(
      unauthorizedReopenBytes,
      digestFixture(unauthorizedReopenBytes),
      binding.recordKey,
    ),
    createRawItem(
      unreachableClosedEpochBytes,
      digestFixture(unreachableClosedEpochBytes),
      binding.recordKey,
    ),
    createRawItem(
      unreachableClosedRevisionBytes,
      digestFixture(unreachableClosedRevisionBytes),
      binding.recordKey,
    ),
    createRawItem(
      '{',
      digestFixture('{'),
      binding.recordKey,
    ),
  ]

  for (const candidate of candidates) {
    expect(() => parseWorkspaceSearchWriterFenceObservation(
      candidate,
      binding,
    )).toThrow(WorkspaceSearchWriterFenceError)
  }
})

test('creates deterministic records and strict comparison-helper results', () => {
  const binding = createBindingFixture()
  const authority = createAuthorityFixture()
  const openTime = new Date('2026-07-29T00:00:00.000Z')
  const closeTime = new Date('2026-07-29T00:01:00.000Z')
  const firstOpen = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    openTime,
  )
  const repeatedOpen = createWorkspaceSearchWriterFenceInitialOpenRecord(
    createBindingFixture(),
    new Date(openTime.getTime()),
  )
  const firstClosed = createWorkspaceSearchWriterFenceClosedSuccessor(
    firstOpen,
    authority,
    closeTime,
  )
  const repeatedClosed = createWorkspaceSearchWriterFenceClosedSuccessor(
    repeatedOpen,
    createAuthorityFixture(),
    new Date(closeTime.getTime()),
  )
  expect(repeatedOpen).toEqual(firstOpen)
  expect(repeatedClosed).toEqual(firstClosed)
  expect(workspaceSearchWriterFenceClosedRecordMatchesAuthority(
    firstClosed,
    binding,
    authority,
  )).toBeTrue()
  expect(workspaceSearchWriterFenceClosedRecordMatchesAuthority(
    firstClosed,
    binding,
    createAuthorityFixture(8),
  )).toBeFalse()
  expect(workspaceSearchWriterFenceClosedRecordMatchesAuthority(
    firstClosed,
    createBindingFixture('replacement'),
    authority,
  )).toBeFalse()
})
