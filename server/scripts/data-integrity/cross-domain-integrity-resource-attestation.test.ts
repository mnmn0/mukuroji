import { describe, expect, test } from 'bun:test'
import {
  calculateCrossDomainIntegrityImmutableResourceIdentity,
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityImmutableResourceIdentities,
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  parseCrossDomainIntegrityResourceAttestation,
  parseCrossDomainIntegrityResourceIdentities,
  sameCrossDomainIntegrityResourceAttestation,
  serializeCrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResourceAttestation,
} from './cross-domain-integrity'

const ATTESTATION_KEY = new Uint8Array(32).fill(0x4d)
const ACCOUNT = '123456789012'
const REGION = 'ap-northeast-1'
const MARKER_CHECKSUM = Buffer.alloc(32, 0x5a).toString('base64')

/**
 * Creates one mutable but structurally valid private snapshot candidate.
 *
 * @returns Mutable untrusted snapshot fixture.
 */
function createAttestationCandidate() {
  return {
    kind: 'mukuroji-cross-domain-integrity-resource-attestation',
    version: 1,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account: ACCOUNT,
    region: REGION,
    bucket: {
      target: 'bucket:file',
      bucketName: 'file-integrity-bucket',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'file-bucket-marker-version-1',
        checksumSha256: MARKER_CHECKSUM,
        size: 128,
      },
    },
    tables: [
      createTableCandidate('table:audit-events', 'audit-events-table', 1),
      createTableCandidate('table:file-proofing', 'file-proofing-table', 2),
      createTableCandidate('table:project-directory', 'project-directory-table', 3),
      createTableCandidate(
        'table:work-item-configuration',
        'work-item-configuration-table',
        4,
      ),
      createTableCandidate('table:work-items', 'work-items-table', 5),
      createTableCandidate('table:workspace-access', 'workspace-access-table', 6),
    ],
  }
}

/**
 * Creates one mutable table incarnation candidate.
 *
 * @param target - Canonical logical table target.
 * @param tableName - Exact physical table name.
 * @param index - Unique fixture suffix.
 * @returns Mutable exact immutable table fields.
 */
function createTableCandidate(
  target:
    | 'table:audit-events'
    | 'table:file-proofing'
    | 'table:project-directory'
    | 'table:work-item-configuration'
    | 'table:work-items'
    | 'table:workspace-access',
  tableName: string,
  index: number,
) {
  return {
    target,
    tableName,
    tableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${tableName}`,
    tableId: `immutable-table-id-${index}`,
    creationTime: `2026-01-0${index}T00:00:00.000Z`,
  }
}

/**
 * Returns one strict parsed snapshot fixture.
 *
 * @returns Deeply frozen canonical private snapshot.
 */
function createParsedAttestation(): CrossDomainIntegrityResourceAttestation {
  return parseCrossDomainIntegrityResourceAttestation(
    createAttestationCandidate(),
  )
}

describe('immutable resource-attestation contract', () => {
  test('round-trips only canonical bytes and returns a detached frozen snapshot', () => {
    const candidate = createAttestationCandidate()
    const parsed = parseCrossDomainIntegrityResourceAttestation(candidate)
    const serialized = serializeCrossDomainIntegrityResourceAttestation(candidate)

    expect(serialized).toBe(`${JSON.stringify(parsed, undefined, 2)}\n`)
    expect(parseCrossDomainIntegrityResourceAttestation(
      JSON.parse(serialized),
    )).toEqual(parsed)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.bucket)).toBe(true)
    expect(Object.isFrozen(parsed.bucket.marker)).toBe(true)
    expect(Object.isFrozen(parsed.tables)).toBe(true)
    expect(parsed.tables.every((table) => Object.isFrozen(table))).toBe(true)

    candidate.bucket.marker.versionId = 'mutated-after-parse'
    const mutableFirstTable = candidate.tables[0]
    if (mutableFirstTable === undefined) throw new Error('Missing table fixture.')
    mutableFirstTable.tableId = 'mutated-after-parse'
    expect(parsed.bucket.marker.versionId).toBe('file-bucket-marker-version-1')
    expect(parsed.tables[0]?.tableId).toBe('immutable-table-id-1')
  })

  test('rejects symbol, non-enumerable, accessor, Proxy, and sparse structures', () => {
    const withSymbol = createAttestationCandidate()
    Object.defineProperty(withSymbol, Symbol('extra'), { value: true })
    const withNonEnumerable = createAttestationCandidate()
    Object.defineProperty(withNonEnumerable, 'extra', { value: true })
    const withAccessor = createAttestationCandidate()
    const firstAccessorTable = withAccessor.tables[0]
    if (firstAccessorTable === undefined) throw new Error('Missing table fixture.')
    Object.defineProperty(firstAccessorTable, 'tableId', {
      configurable: true,
      enumerable: true,
      get: () => 'accessor-table-id',
    })
    const accessorArray = createAttestationCandidate()
    const firstArrayTable = accessorArray.tables[0]
    if (firstArrayTable === undefined) throw new Error('Missing table fixture.')
    Object.defineProperty(accessorArray.tables, '0', {
      configurable: true,
      enumerable: true,
      get: () => firstArrayTable,
    })
    const sparse = createAttestationCandidate()
    sparse.tables.splice(2, 1)
    sparse.tables.length = 6

    for (const invalid of [
      withSymbol,
      withNonEnumerable,
      withAccessor,
      accessorArray,
      sparse,
      new Proxy(createAttestationCandidate(), {}),
      {
        ...createAttestationCandidate(),
        tables: new Proxy(createAttestationCandidate().tables, {}),
      },
    ]) {
      expect(() => parseCrossDomainIntegrityResourceAttestation(invalid))
        .toThrow()
    }
  })

  test('rejects duplicate TableIds and invalid immutable AWS fields', () => {
    const duplicateTableId = createAttestationCandidate()
    const firstTable = duplicateTableId.tables[0]
    const secondTable = duplicateTableId.tables[1]
    if (firstTable === undefined || secondTable === undefined) {
      throw new Error('Missing table fixtures.')
    }
    secondTable.tableId = firstTable.tableId

    const wrongAccount = createAttestationCandidate()
    wrongAccount.account = '999999999999'
    const wrongRegion = createAttestationCandidate()
    wrongRegion.region = 'us-east-1'
    const wrongArnName = createAttestationCandidate()
    const wrongArnTable = wrongArnName.tables[0]
    if (wrongArnTable === undefined) throw new Error('Missing table fixture.')
    wrongArnTable.tableArn =
      `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/other-table`
    const noncanonicalTime = createAttestationCandidate()
    const timeTable = noncanonicalTime.tables[0]
    if (timeTable === undefined) throw new Error('Missing table fixture.')
    timeTable.creationTime = '2026-01-01T00:00:00Z'
    const invalidChecksum = createAttestationCandidate()
    invalidChecksum.bucket.marker.checksumSha256 =
      Buffer.alloc(31, 0x5a).toString('base64')
    const nullVersion = createAttestationCandidate()
    nullVersion.bucket.marker.versionId = 'null'
    const c1Version = createAttestationCandidate()
    c1Version.bucket.marker.versionId = 'version\u0085id'

    for (const invalid of [
      duplicateTableId,
      wrongAccount,
      wrongRegion,
      wrongArnName,
      noncanonicalTime,
      invalidChecksum,
      nullVersion,
      c1Version,
    ]) {
      expect(() => parseCrossDomainIntegrityResourceAttestation(invalid))
        .toThrow()
    }
  })

  test('creates one canonical detached and deeply frozen public vector', () => {
    const candidate = createAttestationCandidate()
    const identities = createCrossDomainIntegrityImmutableResourceIdentities(
      candidate,
      ATTESTATION_KEY,
    )
    const digest = calculateCrossDomainIntegrityResourceIdentityDigest(
      identities,
      ATTESTATION_KEY,
    )

    expect(identities.map((identity) => identity.target)).toEqual(
      [...CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS],
    )
    expect(identities.every((identity) =>
      /^[0-9a-f]{64}$/u.test(identity.identityDigest)
    )).toBe(true)
    expect(digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(Object.isFrozen(identities)).toBe(true)
    expect(identities.every((identity) => Object.isFrozen(identity))).toBe(true)

    const originalFirstDigest = identities[0]?.identityDigest
    candidate.bucket.marker.versionId = 'mutated-after-keying'
    expect(identities[0]?.identityDigest).toBe(originalFirstDigest)
  })

  test('strictly parses public vectors without aliases or exotic properties', () => {
    const identities = createCrossDomainIntegrityImmutableResourceIdentities(
      createAttestationCandidate(),
      ATTESTATION_KEY,
    )
    const mutable = identities.map((identity) => ({ ...identity }))
    const parsed = parseCrossDomainIntegrityResourceIdentities(mutable)
    const mutableFirstIdentity = mutable[0]
    if (mutableFirstIdentity === undefined) {
      throw new Error('Missing identity fixture.')
    }
    mutableFirstIdentity.identityDigest = 'f'.repeat(64)
    expect(parsed[0]?.identityDigest).not.toBe('f'.repeat(64))

    const withSymbol = identities.map((identity) => ({ ...identity }))
    const symbolEntry = withSymbol[0]
    if (symbolEntry === undefined) throw new Error('Missing identity fixture.')
    Object.defineProperty(symbolEntry, Symbol('extra'), { value: true })
    const withNonEnumerable = identities.map((identity) => ({ ...identity }))
    const nonEnumerableEntry = withNonEnumerable[0]
    if (nonEnumerableEntry === undefined) throw new Error('Missing identity fixture.')
    Object.defineProperty(nonEnumerableEntry, 'extra', { value: true })
    const withAccessor = identities.map((identity) => ({ ...identity }))
    const accessorEntry = withAccessor[0]
    if (accessorEntry === undefined) throw new Error('Missing identity fixture.')
    Object.defineProperty(withAccessor, '0', {
      configurable: true,
      enumerable: true,
      get: () => accessorEntry,
    })

    for (const invalid of [
      withSymbol,
      withNonEnumerable,
      withAccessor,
      new Proxy(identities.map((identity) => ({ ...identity })), {}),
    ]) {
      expect(() => parseCrossDomainIntegrityResourceIdentities(invalid)).toThrow()
    }
  })

  test('treats every immutable incarnation field as keyed identity material', () => {
    const baseline = createCrossDomainIntegrityImmutableResourceIdentities(
      createAttestationCandidate(),
      ATTESTATION_KEY,
    )
    const candidates = [
      (() => {
        const value = createAttestationCandidate()
        value.bucket.bucketName = 'replacement-file-integrity-bucket'
        return value
      })(),
      (() => {
        const value = createAttestationCandidate()
        value.bucket.marker.versionId = 'replacement-marker-version'
        return value
      })(),
      (() => {
        const value = createAttestationCandidate()
        value.bucket.marker.checksumSha256 =
          Buffer.alloc(32, 0x6b).toString('base64')
        return value
      })(),
      (() => {
        const value = createAttestationCandidate()
        value.bucket.marker.size += 1
        return value
      })(),
      (() => {
        const value = createAttestationCandidate()
        const table = value.tables[0]
        if (table === undefined) throw new Error('Missing table fixture.')
        table.tableId = 'replacement-table-id'
        return value
      })(),
      (() => {
        const value = createAttestationCandidate()
        const table = value.tables[0]
        if (table === undefined) throw new Error('Missing table fixture.')
        table.creationTime = '2026-02-01T00:00:00.000Z'
        return value
      })(),
      (() => {
        const value = createAttestationCandidate()
        const table = value.tables[0]
        if (table === undefined) throw new Error('Missing table fixture.')
        table.tableName = 'replacement-audit-events-table'
        table.tableArn =
          `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${table.tableName}`
        return value
      })(),
    ]

    for (const candidate of candidates) {
      const changed = createCrossDomainIntegrityImmutableResourceIdentities(
        candidate,
        ATTESTATION_KEY,
      )
      expect(changed).not.toEqual(baseline)
      expect(calculateCrossDomainIntegrityResourceIdentityDigest(
        changed,
        ATTESTATION_KEY,
      )).not.toBe(calculateCrossDomainIntegrityResourceIdentityDigest(
        baseline,
        ATTESTATION_KEY,
      ))
    }
  })

  test('enforces a strict single-entry runtime boundary and private key memory', () => {
    const attestation = createParsedAttestation()
    const table = attestation.tables[0]
    if (table === undefined) throw new Error('Missing table fixture.')
    const input = {
      account: attestation.account,
      region: attestation.region,
      ...table,
    }
    const valid = calculateCrossDomainIntegrityImmutableResourceIdentity(
      input,
      ATTESTATION_KEY,
    )
    expect(valid.target).toBe('table:audit-events')

    const withSymbol = { ...input }
    Object.defineProperty(withSymbol, Symbol('extra'), { value: true })
    const withAccessor = { ...input }
    Object.defineProperty(withAccessor, 'tableId', {
      configurable: true,
      enumerable: true,
      get: () => input.tableId,
    })
    expect(() => calculateCrossDomainIntegrityImmutableResourceIdentity(
      withSymbol,
      ATTESTATION_KEY,
    )).toThrow()
    expect(() => calculateCrossDomainIntegrityImmutableResourceIdentity(
      withAccessor,
      ATTESTATION_KEY,
    )).toThrow()
    expect(() => calculateCrossDomainIntegrityImmutableResourceIdentity(
      new Proxy(input, {}),
      ATTESTATION_KEY,
    )).toThrow()

    const sharedKey = new Uint8Array(new SharedArrayBuffer(32))
    expect(() => calculateCrossDomainIntegrityImmutableResourceIdentity(
      input,
      sharedKey,
    )).toThrow()
    expect(() => calculateCrossDomainIntegrityResourceIdentityDigest(
      createCrossDomainIntegrityImmutableResourceIdentities(
        createAttestationCandidate(),
        ATTESTATION_KEY,
      ),
      sharedKey,
    )).toThrow()
  })

  test('compares every private immutable field exactly', () => {
    const left = createParsedAttestation()
    const right = createParsedAttestation()
    const changed = parseCrossDomainIntegrityResourceAttestation((() => {
      const value = createAttestationCandidate()
      value.bucket.marker.versionId = 'different-version'
      return value
    })())
    expect(sameCrossDomainIntegrityResourceAttestation(left, right)).toBe(true)
    expect(sameCrossDomainIntegrityResourceAttestation(left, changed)).toBe(false)
  })
})
