import { describe, expect, spyOn, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ScanCommand,
  type ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  GetObjectAttributesCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ObjectAttributes,
  type GetObjectAttributesCommandOutput,
  type GetObjectTaggingCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3'
import {
  GetCallerIdentityCommand,
  type GetCallerIdentityCommandOutput,
} from '@aws-sdk/client-sts'
import {
  authenticateCrossDomainIntegrityResult,
  calculateCrossDomainIntegrityResourceIdentityDigest,
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_NON_TARGETS,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  CROSS_DOMAIN_INTEGRITY_RESULT_KIND,
  CROSS_DOMAIN_INTEGRITY_TARGETS,
  type CrossDomainDomainEvidence,
  type CrossDomainIntegrityDomain,
  type CrossDomainIntegrityResourceIdentity,
  type CrossDomainIntegrityResult,
} from './cross-domain-integrity'
import {
  AwsCrossDomainIntegrityReader,
  createCrossDomainIntegrityAwsSdkTransport,
  createCrossDomainIntegrityResourceBindingDigest,
  createCrossDomainIntegrityResourceIdentities,
  createCrossDomainIntegrityResourceIdentityDigest,
  parseCrossDomainIntegrityAuditPseudonymKey,
  parseCrossDomainIntegrityCliArguments,
  parseCrossDomainIntegrityDigestKey,
  runCrossDomainIntegrityCli,
  writeCrossDomainIntegrityEvidenceAtomically,
  type CrossDomainIntegrityAwsReaderConfiguration,
  type CrossDomainIntegrityAwsSdkClientConfiguration,
  type CrossDomainIntegrityAwsTransport,
  type CrossDomainIntegrityCheckBridgeInput,
  type CrossDomainIntegrityManagedAwsReadPort,
  type CrossDomainIntegrityObjectVersionReference,
  type CrossDomainIntegrityPublicationExpectation,
  type CrossDomainIntegrityTableNames,
} from './verify-cross-domain-integrity'

const TEST_CHECKED_AT = '2026-08-01T00:00:00.000Z'
const TEST_DIGEST_KEY = Buffer.from('ab'.repeat(32), 'hex')
const TEST_RESOURCE_IDENTITIES: CrossDomainIntegrityResourceIdentity[] =
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) => ({
    target,
    identityDigest: ((index + 1) % 16).toString(16).repeat(64),
  }))
const TEST_RESOURCE_IDENTITY_DIGEST =
  calculateCrossDomainIntegrityResourceIdentityDigest(
    TEST_RESOURCE_IDENTITIES,
    TEST_DIGEST_KEY,
  )

/** Complete non-sensitive physical table-name fixture. */
function createTableNames(): CrossDomainIntegrityTableNames {
  return {
    'audit-events': 'audit-events-table',
    'file-proofing': 'file-proofing-table',
    'project-directory': 'project-directory-table',
    'work-item-configuration': 'work-item-configuration-table',
    'work-items': 'work-items-table',
    'workspace-access': 'workspace-access-table',
  }
}

/**
 * Creates complete safe AWS reader settings.
 *
 * @param maxPages - Optional total scan-page budget.
 * @returns Reader configuration fixture.
 */
function createReaderConfiguration(
  maxPages = 10,
): CrossDomainIntegrityAwsReaderConfiguration {
  return {
    buckets: { file: 'file-integrity-bucket' },
    expectedAccount: '123456789012',
    maxPages,
    pageSize: 100,
    profile: 'integrity-read-only',
    region: 'ap-northeast-1',
    tables: createTableNames(),
  }
}

/**
 * Creates one complete valid CLI argument list.
 *
 * @param digestKeyPath - Mode-restricted key-file path.
 * @param outputPath - Fresh evidence path.
 * @param role - Source or restore role.
 * @returns Strict checker CLI arguments.
 */
function createCheckArguments(
  digestKeyPath: string,
  outputPath: string,
  role: 'restore' | 'source' = 'source',
  auditPseudonymKeyPath = `${digestKeyPath}.audit-pseudonym`,
): string[] {
  return [
    'check',
    '--role',
    role,
    '--checked-at',
    '2026-08-01T00:00:00.000Z',
    '--account',
    '123456789012',
    '--region',
    'ap-northeast-1',
    '--profile',
    'integrity-read-only',
    '--table',
    'work-items=work-items-table',
    '--table',
    'work-item-configuration=work-item-configuration-table',
    '--table',
    'project-directory=project-directory-table',
    '--table',
    'workspace-access=workspace-access-table',
    '--table',
    'audit-events=audit-events-table',
    '--table',
    'file-proofing=file-proofing-table',
    '--bucket',
    'file=file-integrity-bucket',
    '--page-size',
    '100',
    '--max-pages',
    '10',
    '--max-items',
    '1000',
    '--audit-pseudonym-key-file',
    auditPseudonymKeyPath,
    '--digest-key-file',
    digestKeyPath,
    '--output',
    outputPath,
  ]
}

/**
 * Writes distinct owner-only evidence and Workspace Audit keys for a CLI test.
 *
 * @param digestKeyPath - Evidence HMAC key path used by the argument fixture.
 */
async function writeTestKeyFiles(digestKeyPath: string): Promise<void> {
  await Promise.all([
    writeFile(digestKeyPath, 'ab'.repeat(32), { mode: 0o600 }),
    writeFile(`${digestKeyPath}.audit-pseudonym`, 'cd'.repeat(32), { mode: 0o600 }),
  ])
}

/** Optional overrides for an authenticated evidence fixture. */
type EvidenceFixtureOptions = {
  /** Canonical check timestamp. */
  readonly checkedAt?: string
  /** Maximum total item count. */
  readonly maxItems?: number
  /** Maximum page count. */
  readonly maxPages?: number
  /** Requested page size. */
  readonly pageSize?: number
  /** Logical resource-binding digest. */
  readonly resourceBindingDigest?: string
  /** Canonical per-resource physical identity vector. */
  readonly resourceIdentities?: readonly CrossDomainIntegrityResourceIdentity[]
  /** Physical resource-identity digest. */
  readonly resourceIdentityDigest?: string
  /** Dataset role. */
  readonly role?: 'restore' | 'source'
  /** Overall fixture status. */
  readonly status?: 'fail' | 'pass'
}

/**
 * Creates an exact-schema result authenticated by the supplied key.
 *
 * @param digestKey - Result-MAC key.
 * @param options - Optional result and expectation overrides.
 * @returns Raw-data-free authenticated result fixture.
 */
function createEvidence(
  digestKey: Uint8Array = TEST_DIGEST_KEY,
  options: EvidenceFixtureOptions = {},
): CrossDomainIntegrityResult {
  const status = options.status ?? 'pass'
  const domains: readonly CrossDomainIntegrityDomain[] = [
    'audit',
    'configuration',
    'file',
    'relation',
    'resource',
    'work-item',
  ]
  const domainEvidence = domains.map((domain) => ({
    aggregateDigest: 'ef'.repeat(32),
    domain,
    itemCount: 0,
  }))
  const resourceBindingDigest = options.resourceBindingDigest ??
    createCrossDomainIntegrityResourceBindingDigest()
  const resourceIdentities = (options.resourceIdentities ??
    TEST_RESOURCE_IDENTITIES).map((identity) => ({ ...identity }))
  return authenticateCrossDomainIntegrityResult({
    checkedAt: options.checkedAt ?? TEST_CHECKED_AT,
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    evidence: {
      algorithm: 'HMAC-SHA-256',
      aggregateDigest: calculateTestEvidenceAggregateDigest(
        digestKey,
        resourceBindingDigest,
        domainEvidence,
      ),
      digestVersion: 1,
      domains: domainEvidence,
      itemCount: 0,
      keyFingerprint: 'cd'.repeat(32),
      resourceBindingDigest,
      resourceIdentities,
      resourceIdentityDigest: options.resourceIdentityDigest ??
        calculateCrossDomainIntegrityResourceIdentityDigest(
          resourceIdentities,
          digestKey,
        ),
    },
    failureCodes: status === 'pass' ? [] : ['DUPLICATE_RECORD'],
    kind: CROSS_DOMAIN_INTEGRITY_RESULT_KIND,
    limits: {
      maxItems: options.maxItems ?? 1000,
      maxPages: options.maxPages ?? 10,
      pageSize: options.pageSize ?? 100,
    },
    role: options.role ?? 'source',
    scope: {
      nonTargets: [...CROSS_DOMAIN_INTEGRITY_NON_TARGETS],
      targets: [...CROSS_DOMAIN_INTEGRITY_TARGETS],
    },
    status,
  }, digestKey)
}

/**
 * Recreates the documented total-evidence HMAC for a strict fixture.
 *
 * @param digestKey - Fixture HMAC key.
 * @param resourceBindingDigest - Logical resource-binding digest.
 * @param domains - Canonical per-domain aggregate evidence.
 * @returns Semantically valid total evidence HMAC.
 */
function calculateTestEvidenceAggregateDigest(
  digestKey: Uint8Array,
  resourceBindingDigest: string,
  domains: readonly CrossDomainDomainEvidence[],
): string {
  const hmac = createHmac('sha256', digestKey)
  hmac.update(
    'mukuroji-cross-domain-integrity\0cross-domain-aggregate-v1\0',
    'utf8',
  )
  hmac.update(`${resourceBindingDigest}\n`, 'utf8')
  for (const domain of domains) {
    hmac.update(
      `${domain.domain}\0${domain.itemCount}\0${domain.aggregateDigest}\n`,
      'utf8',
    )
  }
  return hmac.digest('hex')
}

/**
 * Creates CLI-owned publication expectations matching the default fixture.
 *
 * @param digestKey - Result-MAC verification key.
 * @param role - Expected dataset role.
 * @returns Complete publication expectation.
 */
function createPublicationExpectation(
  digestKey: Uint8Array = TEST_DIGEST_KEY,
  role: 'restore' | 'source' = 'source',
): CrossDomainIntegrityPublicationExpectation {
  return {
    checkedAt: TEST_CHECKED_AT,
    digestKey,
    limits: { maxItems: 1000, maxPages: 10, pageSize: 100 },
    resourceBindingDigest:
      createCrossDomainIntegrityResourceBindingDigest(),
    resourceIdentities: TEST_RESOURCE_IDENTITIES,
    resourceIdentityDigest: TEST_RESOURCE_IDENTITY_DIGEST,
    role,
  }
}

/** Allowlisted command recorder used without AWS or network access. */
class RecordingAwsTransport implements CrossDomainIntegrityAwsTransport {
  /** Recorded S3 object-attributes commands. */
  readonly getObjectAttributesCommands: GetObjectAttributesCommand[] = []

  /** Recorded S3 object-tagging commands. */
  readonly getObjectTaggingCommands: GetObjectTaggingCommand[] = []

  /** Recorded S3 HEAD commands. */
  readonly headObjectCommands: HeadObjectCommand[] = []

  /** Recorded STS caller-identity commands. */
  readonly callerIdentityCommands: GetCallerIdentityCommand[] = []

  /** Recorded DynamoDB scan commands. */
  readonly scanCommands: ScanCommand[] = []

  /** Number of transport closure calls. */
  closeCount = 0

  /** Optional raw failure emitted by the caller-identity read. */
  callerIdentityFailure: unknown

  /** Releases the fake transport. */
  close(): void {
    this.closeCount += 1
  }

  /** @inheritdoc */
  async getObjectAttributes(
    command: GetObjectAttributesCommand,
  ): Promise<GetObjectAttributesCommandOutput> {
    this.getObjectAttributesCommands.push(command)
    return { $metadata: {} }
  }

  /** @inheritdoc */
  async getObjectTagging(
    command: GetObjectTaggingCommand,
  ): Promise<GetObjectTaggingCommandOutput> {
    this.getObjectTaggingCommands.push(command)
    return { $metadata: {}, TagSet: [] }
  }

  /** @inheritdoc */
  async headObject(
    command: HeadObjectCommand,
  ): Promise<HeadObjectCommandOutput> {
    this.headObjectCommands.push(command)
    return { $metadata: {} }
  }

  /** @inheritdoc */
  async readCallerIdentity(
    command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    this.callerIdentityCommands.push(command)
    if (this.callerIdentityFailure !== undefined) {
      throw this.callerIdentityFailure
    }
    return { $metadata: {}, Account: '123456789012' }
  }

  /** @inheritdoc */
  async scan(command: ScanCommand): Promise<ScanCommandOutput> {
    this.scanCommands.push(command)
    return { $metadata: {}, Items: [] }
  }
}

describe('cross-domain integrity CLI argument parsing', () => {
  test('requires complete typed resource allowlists and explicit safety bounds', () => {
    expect(parseCrossDomainIntegrityCliArguments(
      createCheckArguments('/secure/key.hex', '/evidence/result.json'),
    )).toEqual({
      account: '123456789012',
      auditPseudonymKeyFile: '/secure/key.hex.audit-pseudonym',
      buckets: { file: 'file-integrity-bucket' },
      checkedAt: '2026-08-01T00:00:00.000Z',
      command: 'check',
      digestKeyFile: '/secure/key.hex',
      maxItems: 1000,
      maxPages: 10,
      output: '/evidence/result.json',
      pageSize: 100,
      profile: 'integrity-read-only',
      region: 'ap-northeast-1',
      role: 'source',
      tables: createTableNames(),
    })

    expect(() => parseCrossDomainIntegrityCliArguments(
      createCheckArguments(
        '/secure/key.hex',
        '/evidence/result.json',
        'source',
        '/secure/key.hex',
      ),
    )).toThrow('INVALID_USAGE')
  })

  test('rejects missing, duplicate, and untyped resource mappings', () => {
    const valid = createCheckArguments('/secure/key.hex', '/evidence/result.json')
    const firstTableIndex = valid.indexOf('--table')
    const missingTable = valid.slice()
    missingTable.splice(firstTableIndex, 2)
    const duplicateTable = valid.slice()
    duplicateTable.splice(
      firstTableIndex,
      0,
      '--table',
      'work-items=second-work-items-table',
    )
    const untypedTable = valid.slice()
    untypedTable[firstTableIndex + 1] = 'unknown=unknown-table'
    const duplicatePhysicalTable = valid.slice()
    duplicatePhysicalTable[firstTableIndex + 1] =
      'work-items=work-item-configuration-table'
    const bucketIndex = valid.indexOf('--bucket')
    const untypedBucket = valid.slice()
    untypedBucket[bucketIndex + 1] = 'uploads=file-integrity-bucket'

    for (const invalid of [
      missingTable,
      duplicateTable,
      untypedTable,
      duplicatePhysicalTable,
      untypedBucket,
    ]) {
      expect(() => parseCrossDomainIntegrityCliArguments(invalid)).toThrow(
        'INVALID_USAGE',
      )
    }
  })

  test('rejects unbounded scans and unsafe resource or endpoint input', () => {
    const cases = [
      ['--page-size', '0'],
      ['--page-size', '1001'],
      ['--max-pages', '0'],
      ['--max-pages', '10001'],
      ['--max-items', '0'],
      ['--max-items', '1000001'],
      ['--checked-at', '2026-08-01'],
      ['--region', 'ap-northeast-1.attacker.invalid'],
      ['--bucket', 'file=127.0.0.1'],
    ]

    for (const [flag, invalidValue] of cases) {
      const arguments_ = createCheckArguments(
        '/secure/key.hex',
        '/evidence/result.json',
      )
      const flagIndex = arguments_.indexOf(flag ?? '')
      arguments_[flagIndex + 1] = invalidValue ?? ''
      expect(() => parseCrossDomainIntegrityCliArguments(arguments_)).toThrow(
        'INVALID_USAGE',
      )
    }

    const excessiveProduct = createCheckArguments(
      '/secure/key.hex',
      '/evidence/result.json',
    )
    excessiveProduct[excessiveProduct.indexOf('--page-size') + 1] = '1000'
    excessiveProduct[excessiveProduct.indexOf('--max-pages') + 1] = '1001'
    expect(() => parseCrossDomainIntegrityCliArguments(excessiveProduct)).toThrow(
      'INVALID_USAGE',
    )

    const normalizedCapacityExceedsRaw = createCheckArguments(
      '/secure/key.hex',
      '/evidence/result.json',
    )
    normalizedCapacityExceedsRaw[
      normalizedCapacityExceedsRaw.indexOf('--max-items') + 1
    ] = '1001'
    expect(() => parseCrossDomainIntegrityCliArguments(
      normalizedCapacityExceedsRaw,
    )).toThrow('INVALID_USAGE')
  })

  test('keys exact physical resource identity without role or profile', () => {
    const key = new Uint8Array(32).fill(7)
    const source = parseCrossDomainIntegrityCliArguments(
      createCheckArguments('/secure/key.hex', '/evidence/result.json', 'source'),
    )
    const restoreArguments = createCheckArguments(
      '/secure/key.hex',
      '/evidence/result.json',
      'restore',
    )
    restoreArguments[restoreArguments.indexOf('--profile') + 1] = 'other-profile'
    const restore = parseCrossDomainIntegrityCliArguments(restoreArguments)
    if (source.command !== 'check' || restore.command !== 'check') {
      throw new Error('check fixture must parse as check')
    }
    const sourceIdentities = createCrossDomainIntegrityResourceIdentities(source, key)
    const sourceDigest = createCrossDomainIntegrityResourceIdentityDigest(source, key)
    expect(sourceIdentities.map((identity) => identity.target)).toEqual(
      [...CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS],
    )
    expect(createCrossDomainIntegrityResourceIdentities(restore, key)).toEqual(
      sourceIdentities,
    )
    expect(createCrossDomainIntegrityResourceIdentityDigest(restore, key)).toBe(sourceDigest)

    const changedArguments = restoreArguments.slice()
    const tableIndex = changedArguments.indexOf('work-items=work-items-table')
    changedArguments[tableIndex] = 'work-items=restored-work-items-table'
    const changed = parseCrossDomainIntegrityCliArguments(changedArguments)
    if (changed.command !== 'check') throw new Error('check fixture must parse as check')
    const changedIdentities = createCrossDomainIntegrityResourceIdentities(changed, key)
    expect(changedIdentities.filter((identity, index) =>
      identity.identityDigest !== sourceIdentities[index]?.identityDigest
    ).map((identity) => identity.target)).toEqual(['table:work-items'])
    expect(createCrossDomainIntegrityResourceIdentityDigest(changed, key)).not.toBe(sourceDigest)
  })

  test('returns only machine-readable help for the exact help command', () => {
    expect(parseCrossDomainIntegrityCliArguments(['help'])).toEqual({
      command: 'help',
    })
    expect(() => parseCrossDomainIntegrityCliArguments([
      'help',
      'unexpected',
    ])).toThrow('INVALID_USAGE')
  })
})

describe('cross-domain integrity AWS adapter', () => {
  test('issues only allowlisted bounded DynamoDB and exact-version S3 reads', async () => {
    const transport = new RecordingAwsTransport()
    let capturedConfiguration: CrossDomainIntegrityAwsReaderConfiguration | undefined
    const reader = new AwsCrossDomainIntegrityReader(
      createReaderConfiguration(),
      (configuration) => {
        capturedConfiguration = configuration
        return transport
      },
    )
    const cursor = { PK: { S: 'opaque-cursor' } }
    const objectReference: CrossDomainIntegrityObjectVersionReference = {
      bucket: 'file',
      key: 'workspaces/example/files/proof.pdf',
      versionId: 'exact-version-id',
    }

    await expect(reader.readCallerAccount()).resolves.toBe('123456789012')
    await reader.scanPage('file-proofing')
    await reader.scanPage('project-directory', cursor)
    await reader.headObject(objectReference)
    await reader.getObjectAttributes(objectReference)
    await reader.getObjectTagging(objectReference)
    reader.close()

    expect(capturedConfiguration).toEqual(createReaderConfiguration())
    expect(transport.callerIdentityCommands[0]).toBeInstanceOf(
      GetCallerIdentityCommand,
    )
    expect(transport.callerIdentityCommands[0]?.input).toEqual({})
    expect(transport.scanCommands[0]).toBeInstanceOf(ScanCommand)
    expect(transport.scanCommands[0]?.input).toEqual({
      ConsistentRead: true,
      Limit: 100,
      TableName: 'file-proofing-table',
    })
    expect(transport.scanCommands[1]?.input).toEqual({
      ConsistentRead: true,
      ExclusiveStartKey: cursor,
      Limit: 100,
      TableName: 'project-directory-table',
    })
    expect(transport.headObjectCommands[0]).toBeInstanceOf(HeadObjectCommand)
    expect(transport.headObjectCommands[0]?.input).toEqual({
      Bucket: 'file-integrity-bucket',
      ExpectedBucketOwner: '123456789012',
      Key: objectReference.key,
      VersionId: objectReference.versionId,
    })
    expect(transport.getObjectAttributesCommands[0]).toBeInstanceOf(
      GetObjectAttributesCommand,
    )
    expect(transport.getObjectAttributesCommands[0]?.input).toEqual({
      Bucket: 'file-integrity-bucket',
      ExpectedBucketOwner: '123456789012',
      Key: objectReference.key,
      ObjectAttributes: [
        ObjectAttributes.CHECKSUM,
        ObjectAttributes.ETAG,
        ObjectAttributes.OBJECT_SIZE,
        ObjectAttributes.STORAGE_CLASS,
      ],
      VersionId: objectReference.versionId,
    })
    expect(transport.getObjectTaggingCommands[0]).toBeInstanceOf(
      GetObjectTaggingCommand,
    )
    expect(transport.getObjectTaggingCommands[0]?.input).toEqual({
      Bucket: 'file-integrity-bucket',
      ExpectedBucketOwner: '123456789012',
      Key: objectReference.key,
      VersionId: objectReference.versionId,
    })
    expect(transport.closeCount).toBe(1)
  })

  test('enforces the global page budget before issuing an extra Scan', async () => {
    const transport = new RecordingAwsTransport()
    const reader = new AwsCrossDomainIntegrityReader(
      createReaderConfiguration(2),
      () => transport,
    )

    await reader.scanPage('work-items')
    await reader.scanPage('workspace-access')
    expect(() => reader.scanPage('audit-events')).toThrow(
      'SCAN_PAGE_LIMIT_EXCEEDED',
    )
    expect(transport.scanCommands).toHaveLength(2)
  })

  test('rejects absent or unsafe VersionId input before any S3 request', async () => {
    const transport = new RecordingAwsTransport()
    const reader = new AwsCrossDomainIntegrityReader(
      createReaderConfiguration(),
      () => transport,
    )

    expect(() => reader.headObject({
      bucket: 'file',
      key: 'workspaces/example/file.pdf',
      versionId: '',
    })).toThrow('OBJECT_VERSION_INVALID')
    expect(() => reader.getObjectTagging({
      bucket: 'file',
      key: 'workspaces/example/file.pdf',
      versionId: 'unsafe\nversion',
    })).toThrow('OBJECT_VERSION_INVALID')
    expect(() => reader.getObjectAttributes({
      bucket: 'file',
      key: 'workspaces/example/file.pdf',
      versionId: 'null',
    })).toThrow('OBJECT_VERSION_INVALID')
    expect(transport.headObjectCommands).toHaveLength(0)
    expect(transport.getObjectTaggingCommands).toHaveLength(0)
    expect(transport.getObjectAttributesCommands).toHaveLength(0)
  })

  test('requires a twelve-digit expected resource-owner account', () => {
    const configuration = createReaderConfiguration()
    expect(() => new AwsCrossDomainIntegrityReader({
      ...configuration,
      expectedAccount: 'not-an-account',
    })).toThrow('INVALID_USAGE')
  })

  test('pins every SDK client to one explicit profile and official endpoints', () => {
    const transport = new RecordingAwsTransport()
    let dynamodbConfiguration:
      CrossDomainIntegrityAwsSdkClientConfiguration | undefined
    let s3Configuration: CrossDomainIntegrityAwsSdkClientConfiguration | undefined
    let stsConfiguration: CrossDomainIntegrityAwsSdkClientConfiguration | undefined

    const created = createCrossDomainIntegrityAwsSdkTransport(
      createReaderConfiguration(),
      (nextDynamoDb, nextS3, nextSts) => {
        dynamodbConfiguration = nextDynamoDb
        s3Configuration = nextS3
        stsConfiguration = nextSts
        return transport
      },
    )

    expect(created).toBe(transport)
    expect(dynamodbConfiguration).toMatchObject({
      endpoint: 'https://dynamodb.ap-northeast-1.amazonaws.com/',
      profile: 'integrity-read-only',
      region: 'ap-northeast-1',
    })
    expect(s3Configuration).toMatchObject({
      endpoint: 'https://s3.ap-northeast-1.amazonaws.com/',
      profile: 'integrity-read-only',
      region: 'ap-northeast-1',
    })
    expect(stsConfiguration).toMatchObject({
      endpoint: 'https://sts.ap-northeast-1.amazonaws.com/',
      profile: 'integrity-read-only',
      region: 'ap-northeast-1',
    })
    expect(dynamodbConfiguration?.credentials).toBe(s3Configuration?.credentials)
    expect(dynamodbConfiguration?.credentials).toBe(stsConfiguration?.credentials)
  })
})

describe('cross-domain integrity evidence publication', () => {
  test('publishes only an exact authenticated result with mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-evidence-'))
    const outputPath = join(directory, 'result.json')
    const evidence = createEvidence()
    try {
      const published = await writeCrossDomainIntegrityEvidenceAtomically(
        outputPath,
        evidence,
        createPublicationExpectation(),
      )

      expect(published).toEqual(evidence)
      const output = await stat(outputPath)
      expect(output.mode & 0o077).toBe(0)
      expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(evidence)
      expect(await readdir(directory)).toEqual(['result.json'])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('refuses to replace existing evidence byte-for-byte', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-no-clobber-'))
    const outputPath = join(directory, 'result.json')
    const existing = Buffer.from('existing-evidence\n', 'utf8')
    try {
      await writeFile(outputPath, existing, { mode: 0o600 })
      await expect(writeCrossDomainIntegrityEvidenceAtomically(
        outputPath,
        createEvidence(),
        createPublicationExpectation(),
      )).rejects.toThrow('OUTPUT_FILE_WRITE_FAILED')

      expect(await readFile(outputPath)).toEqual(existing)
      expect(await readdir(directory)).toEqual(['result.json'])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('rejects every structural or MAC-authentication mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-tamper-'))
    const outputPath = join(directory, 'result.json')
    const valid = createEvidence()
    const { resultMac: removedResultMac, ...missingResultMac } = valid
    const invalidEvidence = [
      { ...valid, role: 'restore' },
      { ...valid, status: 'fail' },
      { ...valid, failureCodes: ['DUPLICATE_RECORD'] },
      { ...valid, status: 'fail', failureCodes: ['DUPLICATE_RECORD'] },
      {
        ...valid,
        evidence: { ...valid.evidence, aggregateDigest: '00'.repeat(32) },
      },
      {
        ...valid,
        evidence: { ...valid.evidence, itemCount: 1 },
      },
      {
        ...valid,
        evidence: {
          ...valid.evidence,
          resourceIdentities: valid.evidence.resourceIdentities.slice(1),
        },
      },
      {
        ...valid,
        evidence: {
          ...valid.evidence,
          resourceIdentities: valid.evidence.resourceIdentities.map(
            (identity, index) => index === 0
              ? { ...identity, unexpected: 'field' }
              : identity,
          ),
        },
      },
      { ...valid, resultMac: '00'.repeat(32) },
      { ...valid, note: 'harmless-but-unknown' },
      missingResultMac,
      { ...valid, failureCodes: ['UNKNOWN_FAILURE_CODE'] },
    ]
    try {
      expect(removedResultMac).toBe(valid.resultMac)
      for (const evidence of invalidEvidence) {
        await expect(writeCrossDomainIntegrityEvidenceAtomically(
          outputPath,
          evidence,
          createPublicationExpectation(),
        )).rejects.toThrow('EVIDENCE_INVALID')
      }
      await expect(stat(outputPath)).rejects.toBeDefined()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('rejects authenticated results not bound to the CLI configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-binding-'))
    const outputPath = join(directory, 'result.json')
    const valid = createEvidence()
    const expectation = createPublicationExpectation()
    const mismatchedExpectations: CrossDomainIntegrityPublicationExpectation[] = [
      { ...expectation, role: 'restore' },
      { ...expectation, checkedAt: '2026-08-01T00:00:01.000Z' },
      {
        ...expectation,
        limits: { ...expectation.limits, pageSize: 99 },
      },
      { ...expectation, resourceBindingDigest: '34'.repeat(32) },
      {
        ...expectation,
        resourceIdentities: expectation.resourceIdentities.map(
          (identity, index) => index === 0
            ? { ...identity, identityDigest: '56'.repeat(32) }
            : identity,
        ),
      },
      { ...expectation, resourceIdentityDigest: '56'.repeat(32) },
      {
        ...expectation,
        digestKey: Buffer.from('cd'.repeat(32), 'hex'),
      },
    ]
    try {
      for (const mismatched of mismatchedExpectations) {
        await expect(writeCrossDomainIntegrityEvidenceAtomically(
          outputPath,
          valid,
          mismatched,
        )).rejects.toThrow('EVIDENCE_INVALID')
      }
      await expect(stat(outputPath)).rejects.toBeDefined()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})

describe('cross-domain integrity CLI execution boundary', () => {
  test('checks the account, publishes evidence, closes the reader, and erases key bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-cli-'))
    const digestKeyPath = join(directory, 'digest-key.hex')
    const outputPath = join(directory, 'result.json')
    const transport = new RecordingAwsTransport()
    const reader = new AwsCrossDomainIntegrityReader(
      createReaderConfiguration(),
      () => transport,
    )
    let bridgeInput: CrossDomainIntegrityCheckBridgeInput | undefined
    let receivedAuditPseudonymKey: Uint8Array | undefined
    let readerConfiguration: CrossDomainIntegrityAwsReaderConfiguration | undefined
    let returnedEvidence: CrossDomainIntegrityResult | undefined
    const outputWriter = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await writeTestKeyFiles(digestKeyPath)
      const exitCode = await runCrossDomainIntegrityCli(
        createCheckArguments(digestKeyPath, outputPath),
        {
          /** Returns the deterministic read-only adapter. */
          createReader: (configuration) => {
            readerConfiguration = configuration
            return reader
          },
          /** Captures bridge input and returns aggregate-only evidence. */
          runCheck: (input) => {
            bridgeInput = input
            receivedAuditPseudonymKey = Uint8Array.from(input.auditPseudonymKey)
            returnedEvidence = createEvidence(input.digestKey, {
              checkedAt: input.checkedAt,
              maxItems: input.maxItems,
              maxPages: input.maxPages,
              pageSize: input.pageSize,
              resourceBindingDigest: input.resourceBindingDigest,
              resourceIdentities: input.resourceIdentities,
              resourceIdentityDigest: input.resourceIdentityDigest,
              role: input.role,
            })
            return Promise.resolve(returnedEvidence)
          },
        },
      )

      expect(exitCode).toBe(0)
      expect(transport.callerIdentityCommands).toHaveLength(1)
      expect(transport.closeCount).toBe(1)
      expect(readerConfiguration?.expectedAccount).toBe('123456789012')
      expect(bridgeInput?.role).toBe('source')
      expect(bridgeInput?.pageSize).toBe(100)
      expect(bridgeInput?.maxPages).toBe(10)
      expect(bridgeInput?.maxItems).toBe(1000)
      expect(bridgeInput?.checkedAt).toBe(TEST_CHECKED_AT)
      expect(bridgeInput?.reader).toBe(reader)
      expect(bridgeInput?.resourceBindingDigest).toBe(
        createCrossDomainIntegrityResourceBindingDigest(),
      )
      expect(bridgeInput?.resourceIdentities.map((identity) => identity.target))
        .toEqual([...CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS])
      expect(bridgeInput?.resourceIdentityDigest).toMatch(/^[0-9a-f]{64}$/u)
      expect(receivedAuditPseudonymKey).toEqual(
        new Uint8Array(32).fill(0xcd),
      )
      expect(Array.from(bridgeInput?.auditPseudonymKey ?? [])).toEqual(
        Array.from({ length: 32 }, () => 0),
      )
      expect(Array.from(bridgeInput?.digestKey ?? [])).toEqual(
        Array.from({ length: 32 }, () => 0),
      )
      expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(returnedEvidence)
      expect(outputWriter).toHaveBeenCalledWith(
        '{"operation":"check","role":"source","status":"pass"}',
      )
    } finally {
      outputWriter.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('redacts raw AWS errors and resource arguments from JSONL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-aws-error-'))
    const digestKeyPath = join(directory, 'digest-key.hex')
    const outputPath = join(directory, 'result.json')
    const rawCanary = 'RAW-AWS-ERROR-RESOURCE-TENANT-CURSOR-CANARY'
    const transport = new RecordingAwsTransport()
    transport.callerIdentityFailure = {
      $metadata: { requestId: rawCanary },
      message: rawCanary,
    }
    const reader = new AwsCrossDomainIntegrityReader(
      createReaderConfiguration(),
      () => transport,
    )
    const errorWriter = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await writeTestKeyFiles(digestKeyPath)
      const exitCode = await runCrossDomainIntegrityCli(
        createCheckArguments(digestKeyPath, outputPath),
        {
          /** Returns the reader that emits a raw AWS-shaped failure. */
          createReader: () => reader,
          /** Must never run after caller identity failure. */
          runCheck: () => Promise.resolve(createEvidence()),
        },
      )

      expect(exitCode).toBe(1)
      expect(errorWriter).toHaveBeenCalledWith(
        '{"operation":"check","status":"error","code":"AWS_READ_FAILED"}',
      )
      expect(JSON.stringify(errorWriter.mock.calls)).not.toContain(rawCanary)
      expect(JSON.stringify(errorWriter.mock.calls)).not.toContain(digestKeyPath)
      expect(JSON.stringify(errorWriter.mock.calls)).not.toContain('work-items-table')
      expect(transport.closeCount).toBe(1)
      await expect(stat(outputPath)).rejects.toBeDefined()
    } finally {
      errorWriter.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('rejects a signed dependency result that changes CLI-owned values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-cli-binding-'))
    const digestKeyPath = join(directory, 'digest-key.hex')
    const outputPath = join(directory, 'result.json')
    const transport = new RecordingAwsTransport()
    const reader = new AwsCrossDomainIntegrityReader(
      createReaderConfiguration(),
      () => transport,
    )
    const errorWriter = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await writeTestKeyFiles(digestKeyPath)
      const exitCode = await runCrossDomainIntegrityCli(
        createCheckArguments(digestKeyPath, outputPath),
        {
          /** Returns the deterministic read-only adapter. */
          createReader: () => reader,
          /** Signs a structurally valid result with a different timestamp. */
          runCheck: (input) => Promise.resolve(createEvidence(input.digestKey, {
            checkedAt: '2026-08-01T00:00:01.000Z',
            maxItems: input.maxItems,
            maxPages: input.maxPages,
            pageSize: input.pageSize,
            resourceBindingDigest: input.resourceBindingDigest,
            resourceIdentities: input.resourceIdentities,
            resourceIdentityDigest: input.resourceIdentityDigest,
            role: input.role,
          })),
        },
      )

      expect(exitCode).toBe(1)
      expect(errorWriter).toHaveBeenCalledWith(
        '{"operation":"check","status":"error","code":"EVIDENCE_INVALID"}',
      )
      expect(transport.closeCount).toBe(1)
      await expect(stat(outputPath)).rejects.toBeDefined()
    } finally {
      errorWriter.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('fails closed on account mismatch before invoking the checker core', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-account-'))
    const digestKeyPath = join(directory, 'digest-key.hex')
    const outputPath = join(directory, 'result.json')
    const transport = new RecordingAwsTransport()
    const originalIdentityReader = transport.readCallerIdentity.bind(transport)
    transport.readCallerIdentity = async (command) => {
      await originalIdentityReader(command)
      return { $metadata: {}, Account: '999999999999' }
    }
    const reader = new AwsCrossDomainIntegrityReader(
      createReaderConfiguration(),
      () => transport,
    )
    let checkCalls = 0
    const errorWriter = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await writeTestKeyFiles(digestKeyPath)
      const exitCode = await runCrossDomainIntegrityCli(
        createCheckArguments(digestKeyPath, outputPath),
        {
          /** Returns a reader bound to the wrong account. */
          createReader: () => reader,
          /** Records any unsafe invocation after account mismatch. */
          runCheck: () => {
            checkCalls += 1
            return Promise.resolve(createEvidence())
          },
        },
      )

      expect(exitCode).toBe(1)
      expect(checkCalls).toBe(0)
      expect(errorWriter).toHaveBeenCalledWith(
        '{"operation":"check","status":"error","code":"ACCOUNT_MISMATCH"}',
      )
      await expect(stat(outputPath)).rejects.toBeDefined()
    } finally {
      errorWriter.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('rejects reuse of the evidence key as the Workspace Audit pseudonym key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-key-reuse-'))
    const digestKeyPath = join(directory, 'digest-key.hex')
    const auditPseudonymKeyPath = `${digestKeyPath}.audit-pseudonym`
    const outputPath = join(directory, 'result.json')
    const errorWriter = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await Promise.all([
        writeFile(digestKeyPath, 'ab'.repeat(32), { mode: 0o600 }),
        writeFile(auditPseudonymKeyPath, 'ab'.repeat(32), { mode: 0o600 }),
      ])
      const exitCode = await runCrossDomainIntegrityCli(
        createCheckArguments(digestKeyPath, outputPath),
        {
          /** Must not create AWS clients when the two security domains reuse one key. */
          createReader: () => createUnreachableReader(),
          /** Must not run when the two security domains reuse one key. */
          runCheck: () => Promise.resolve(createEvidence()),
        },
      )

      expect(exitCode).toBe(2)
      expect(errorWriter).toHaveBeenCalledWith(
        '{"operation":"check","status":"error","code":"KEY_REUSE_FORBIDDEN"}',
      )
      expect(JSON.stringify(errorWriter.mock.calls)).not.toContain(digestKeyPath)
    } finally {
      errorWriter.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('rejects a Workspace Audit pseudonym key readable by other users', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-audit-key-mode-'))
    const digestKeyPath = join(directory, 'digest-key.hex')
    const auditPseudonymKeyPath = `${digestKeyPath}.audit-pseudonym`
    const outputPath = join(directory, 'result.json')
    const errorWriter = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await writeTestKeyFiles(digestKeyPath)
      await chmod(auditPseudonymKeyPath, 0o644)
      const exitCode = await runCrossDomainIntegrityCli(
        createCheckArguments(digestKeyPath, outputPath),
        {
          /** Must not create AWS clients for an unsafe key file. */
          createReader: () => createUnreachableReader(),
          /** Must not run for an unsafe key file. */
          runCheck: () => Promise.resolve(createEvidence()),
        },
      )

      expect(exitCode).toBe(2)
      expect(errorWriter).toHaveBeenCalledWith(
        '{"operation":"check","status":"error","code":"AUDIT_PSEUDONYM_KEY_INVALID"}',
      )
      expect(JSON.stringify(errorWriter.mock.calls)).not.toContain(
        auditPseudonymKeyPath,
      )
    } finally {
      errorWriter.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('rejects a digest key readable by group or other users', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-key-mode-'))
    const digestKeyPath = join(directory, 'digest-key.hex')
    const outputPath = join(directory, 'result.json')
    const errorWriter = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await writeFile(digestKeyPath, 'ab'.repeat(32), { mode: 0o600 })
      await chmod(digestKeyPath, 0o644)
      const exitCode = await runCrossDomainIntegrityCli(
        createCheckArguments(digestKeyPath, outputPath),
        {
          /** Must not create AWS clients for an unsafe key file. */
          createReader: () => createUnreachableReader(),
          /** Must not run for an unsafe key file. */
          runCheck: () => Promise.resolve(createEvidence()),
        },
      )

      expect(exitCode).toBe(2)
      expect(errorWriter).toHaveBeenCalledWith(
        '{"operation":"check","status":"error","code":"DIGEST_KEY_INVALID"}',
      )
      expect(JSON.stringify(errorWriter.mock.calls)).not.toContain(digestKeyPath)
    } finally {
      errorWriter.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('rejects non-ASCII key bytes before creating AWS clients', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-domain-key-bytes-'))
    const digestKeyPath = join(directory, 'digest-key.hex')
    const outputPath = join(directory, 'result.json')
    const encodedKey = Buffer.from('ab'.repeat(32), 'ascii')
    encodedKey[12] = 0xff
    const errorWriter = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await writeFile(digestKeyPath, encodedKey, { mode: 0o600 })
      const exitCode = await runCrossDomainIntegrityCli(
        createCheckArguments(digestKeyPath, outputPath),
        {
          /** Must not create AWS clients for non-ASCII key bytes. */
          createReader: () => createUnreachableReader(),
          /** Must not run for non-ASCII key bytes. */
          runCheck: () => Promise.resolve(createEvidence()),
        },
      )

      expect(exitCode).toBe(2)
      expect(errorWriter).toHaveBeenCalledWith(
        '{"operation":"check","status":"error","code":"DIGEST_KEY_INVALID"}',
      )
      await expect(stat(outputPath)).rejects.toBeDefined()
    } finally {
      encodedKey.fill(0)
      errorWriter.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })
})

/**
 * Creates an unreachable reader while satisfying the dependency type.
 *
 * @returns Reader that fails if unexpectedly used.
 */
function createUnreachableReader(): CrossDomainIntegrityManagedAwsReadPort {
  throw new Error('reader must not be created')
}

describe('cross-domain integrity digest key parsing', () => {
  test('accepts only an exact lowercase 32-byte hexadecimal key', () => {
    const hexadecimalKey = 'ab'.repeat(32)
    expect(parseCrossDomainIntegrityDigestKey(hexadecimalKey)).toEqual(
      Buffer.from(hexadecimalKey, 'hex'),
    )
    expect(parseCrossDomainIntegrityDigestKey(`${hexadecimalKey}\n`)).toEqual(
      Buffer.from(hexadecimalKey, 'hex'),
    )
    expect(parseCrossDomainIntegrityAuditPseudonymKey(hexadecimalKey)).toEqual(
      Buffer.from(hexadecimalKey, 'hex'),
    )

    for (const invalid of [
      hexadecimalKey.toUpperCase(),
      hexadecimalKey.slice(2),
      `${hexadecimalKey}\r\n`,
      `${hexadecimalKey}\n\n`,
      `${hexadecimalKey.slice(0, -1)}g`,
    ]) {
      expect(() => parseCrossDomainIntegrityDigestKey(invalid)).toThrow(
        'DIGEST_KEY_INVALID',
      )
      expect(() => parseCrossDomainIntegrityAuditPseudonymKey(invalid)).toThrow(
        'AUDIT_PSEUDONYM_KEY_INVALID',
      )
    }
  })
})
