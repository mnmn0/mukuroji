import { createHmac } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { types as nodeUtilTypes } from 'node:util'

/** Private resource snapshot discriminator used by the operator workflow. */
export const CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_KIND =
  'mukuroji-cross-domain-integrity-resource-attestation'

/** Current private resource snapshot contract version. */
export const CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_VERSION = 1

/** Identity scheme proving immutable DynamoDB and S3 resource incarnations. */
export const CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME =
  'immutable-incarnation-v1'

/** Fixed object key whose exact immutable version identifies the File bucket. */
export const CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY =
  'system/data-integrity/file-bucket-incarnation/v1.json'

/** Maximum canonical private resource-attestation file size. */
export const CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES =
  128 * 1024

/** Logical AWS resources whose physical identities are authenticated individually. */
export type CrossDomainIntegrityResourceTarget =
  | 'bucket:file'
  | 'table:audit-events'
  | 'table:file-proofing'
  | 'table:project-directory'
  | 'table:work-item-configuration'
  | 'table:work-items'
  | 'table:workspace-access'

/** DynamoDB subset of the fixed resource identity vector. */
export type CrossDomainIntegrityTableResourceTarget = Exclude<
  CrossDomainIntegrityResourceTarget,
  'bucket:file'
>

/** Canonical fixed order for the complete physical-resource identity vector. */
export const CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS:
  readonly CrossDomainIntegrityResourceTarget[] = Object.freeze([
    'bucket:file',
    'table:audit-events',
    'table:file-proofing',
    'table:project-directory',
    'table:work-item-configuration',
    'table:work-items',
    'table:workspace-access',
  ])

/** Canonical fixed order for all six DynamoDB resource attestations. */
export const CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS:
  readonly CrossDomainIntegrityTableResourceTarget[] = Object.freeze([
    'table:audit-events',
    'table:file-proofing',
    'table:project-directory',
    'table:work-item-configuration',
    'table:work-items',
    'table:workspace-access',
  ])

/** One secret-free keyed identity for an exact physical resource. */
export type CrossDomainIntegrityResourceIdentity = {
  /** Logical resource target in the canonical fixed vector. */
  readonly target: CrossDomainIntegrityResourceTarget
  /** HMAC of the exact immutable physical resource incarnation. */
  readonly identityDigest: string
}

/** Exact immutable DynamoDB table incarnation retained in a private snapshot. */
export type CrossDomainIntegrityTableResourceAttestation = {
  /** Canonical logical table target. */
  readonly target: CrossDomainIntegrityTableResourceTarget
  /** Exact configured physical table name. */
  readonly tableName: string
  /** Exact ARN returned by DynamoDB DescribeTable. */
  readonly tableArn: string
  /** Immutable TableId returned by DynamoDB DescribeTable. */
  readonly tableId: string
  /** Canonical UTC creation time returned by DynamoDB DescribeTable. */
  readonly creationTime: string
}

/** Exact immutable S3 marker version retained in a private snapshot. */
export type CrossDomainIntegrityFileBucketMarkerAttestation = {
  /** Fixed marker object key. */
  readonly key: typeof CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY
  /** Exact non-null S3 VersionId emitted by the infrastructure stack. */
  readonly versionId: string
  /** Exact canonical base64 SHA-256 checksum emitted by S3. */
  readonly checksumSha256: string
  /** Exact non-negative marker object size in bytes. */
  readonly size: number
}

/** Exact File bucket incarnation retained in a private snapshot. */
export type CrossDomainIntegrityFileBucketResourceAttestation = {
  /** Fixed logical bucket target. */
  readonly target: 'bucket:file'
  /** Exact configured physical bucket name. */
  readonly bucketName: string
  /** Exact immutable marker object version for this bucket incarnation. */
  readonly marker: CrossDomainIntegrityFileBucketMarkerAttestation
}

/** Owner-only raw snapshot used to derive public keyed resource identities. */
export type CrossDomainIntegrityResourceAttestation = {
  /** Private resource snapshot discriminator. */
  readonly kind: typeof CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_KIND
  /** Private resource snapshot contract version. */
  readonly version: typeof CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_VERSION
  /** Immutable resource identity scheme selected by this snapshot. */
  readonly scheme:
    typeof CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  /** Exact AWS account owning every measured resource. */
  readonly account: string
  /** Exact AWS Region containing every measured resource. */
  readonly region: string
  /** Exact File bucket and immutable marker incarnation. */
  readonly bucket: CrossDomainIntegrityFileBucketResourceAttestation
  /** Exact canonical six-table incarnation vector. */
  readonly tables: readonly CrossDomainIntegrityTableResourceAttestation[]
}

/** Raw fields accepted by the per-resource immutable identity HMAC. */
export type CrossDomainIntegrityImmutableResourceIdentityInput =
  | ({
    /** Exact AWS account owning this table. */
    readonly account: string
    /** Exact AWS Region containing this table. */
    readonly region: string
  } & CrossDomainIntegrityTableResourceAttestation)
  | {
    /** Exact AWS account owning this bucket. */
    readonly account: string
    /** Exact AWS Region containing this bucket. */
    readonly region: string
    /** Fixed logical bucket target. */
    readonly target: 'bucket:file'
    /** Exact configured physical bucket name. */
    readonly bucketName: string
    /** Exact immutable marker object version for this bucket incarnation. */
    readonly marker: CrossDomainIntegrityFileBucketMarkerAttestation
  }

/**
 * Strictly parses an owner-only immutable resource-attestation snapshot.
 *
 * @param value - Untrusted candidate snapshot.
 * @returns Detached and deeply frozen canonical snapshot.
 */
export function parseCrossDomainIntegrityResourceAttestation(
  value: unknown,
): CrossDomainIntegrityResourceAttestation {
  const record = requireRecord(value, 'resource attestation')
  requireExactKeys(record, [
    'account',
    'bucket',
    'kind',
    'region',
    'scheme',
    'tables',
    'version',
  ], 'resource attestation')
  if (
    readOwn(record, 'kind') !==
      CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_KIND ||
    readOwn(record, 'version') !==
      CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_VERSION ||
    readOwn(record, 'scheme') !==
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  ) {
    throw new TypeError('Cross-domain integrity resource attestation is invalid.')
  }
  const account = readAwsAccount(readOwn(record, 'account'))
  const region = readAwsRegion(readOwn(record, 'region'))
  const bucket = readBucketAttestation(
    readOwn(record, 'bucket'),
  )
  const tables = readTableAttestations(
    readOwn(record, 'tables'),
    account,
    region,
  )
  return Object.freeze({
    kind: CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_KIND,
    version: CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_VERSION,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account,
    region,
    bucket,
    tables: Object.freeze(tables),
  })
}

/**
 * Serializes one strict private snapshot into canonical owner-only bytes.
 *
 * @param value - Untrusted candidate snapshot.
 * @returns Canonical newline-terminated JSON text.
 */
export function serializeCrossDomainIntegrityResourceAttestation(
  value: unknown,
): string {
  const attestation = parseCrossDomainIntegrityResourceAttestation(value)
  return `${JSON.stringify(attestation, undefined, 2)}\n`
}

/**
 * Creates the fixed public keyed vector from one private raw snapshot.
 *
 * @param value - Untrusted private resource snapshot.
 * @param digestKey - Dedicated 32-byte identity HMAC key.
 * @returns Detached, aliases-free, and deeply frozen seven-entry vector.
 */
export function createCrossDomainIntegrityImmutableResourceIdentities(
  value: unknown,
  digestKey: Uint8Array,
): readonly CrossDomainIntegrityResourceIdentity[] {
  const attestation = parseCrossDomainIntegrityResourceAttestation(value)
  requireDigestKey(digestKey)
  const identities: CrossDomainIntegrityResourceIdentity[] = [
    calculateCrossDomainIntegrityImmutableResourceIdentity({
      account: attestation.account,
      region: attestation.region,
      target: 'bucket:file',
      bucketName: attestation.bucket.bucketName,
      marker: attestation.bucket.marker,
    }, digestKey),
  ]
  for (const table of attestation.tables) {
    identities.push(calculateCrossDomainIntegrityImmutableResourceIdentity({
      account: attestation.account,
      region: attestation.region,
      ...table,
    }, digestKey))
  }
  return Object.freeze(identities)
}

/**
 * Calculates one public HMAC for an exact immutable AWS incarnation.
 *
 * @param input - Exact raw immutable resource fields.
 * @param digestKey - Dedicated 32-byte identity HMAC key.
 * @returns Frozen logical target and keyed immutable identity.
 */
export function calculateCrossDomainIntegrityImmutableResourceIdentity(
  input: CrossDomainIntegrityImmutableResourceIdentityInput,
  digestKey: Uint8Array,
): CrossDomainIntegrityResourceIdentity {
  requireDigestKey(digestKey)
  const parsedInput = parseImmutableResourceIdentityInput(input)
  const fields = parsedInput.target === 'bucket:file'
    ? [
      parsedInput.target,
      parsedInput.account,
      parsedInput.region,
      parsedInput.bucketName,
      parsedInput.marker.key,
      parsedInput.marker.versionId,
      parsedInput.marker.checksumSha256,
      String(parsedInput.marker.size),
    ]
    : [
      parsedInput.target,
      parsedInput.account,
      parsedInput.region,
      parsedInput.tableName,
      parsedInput.tableArn,
      parsedInput.tableId,
      parsedInput.creationTime,
    ]
  const identityDigest = createDomainHmac(
    digestKey,
    'physical-resource-identity-immutable-incarnation-v1',
  ).update(canonicalFields(fields), 'utf8').digest('hex')
  return Object.freeze({ target: parsedInput.target, identityDigest })
}

/**
 * Calculates the aggregate identity HMAC for the canonical resource vector.
 *
 * @param resourceIdentities - Strict canonical seven-entry identity vector.
 * @param digestKey - Dedicated 32-byte identity HMAC key.
 * @returns Lowercase hexadecimal aggregate identity digest.
 */
export function calculateCrossDomainIntegrityResourceIdentityDigest(
  resourceIdentities: readonly CrossDomainIntegrityResourceIdentity[],
  digestKey: Uint8Array,
): string {
  requireDigestKey(digestKey)
  const parsedIdentities = parseCrossDomainIntegrityResourceIdentities(
    resourceIdentities,
  )
  const fields: string[] = [String(parsedIdentities.length)]
  for (const identity of parsedIdentities) {
    fields.push(identity.target, identity.identityDigest)
  }
  return createDomainHmac(digestKey, 'resource-identity-vector-v1')
    .update(canonicalFields(fields), 'utf8')
    .digest('hex')
}

/**
 * Strictly parses the canonical seven-entry public resource vector.
 *
 * @param value - Untrusted candidate public identity vector.
 * @returns Detached, aliases-free, and deeply frozen canonical vector.
 */
export function parseCrossDomainIntegrityResourceIdentities(
  value: unknown,
): readonly CrossDomainIntegrityResourceIdentity[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.length
  ) {
    throw new TypeError('Cross-domain integrity resource identities are incomplete.')
  }
  requireExactArrayKeys(value)
  const identities: CrossDomainIntegrityResourceIdentity[] = []
  for (
    let index = 0;
    index < CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.length;
    index += 1
  ) {
    const expectedTarget = CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS[index]
    const record = requireRecord(
      readArrayEntry(value, index),
      'resource identity',
    )
    requireExactKeys(record, ['identityDigest', 'target'], 'resource identity')
    if (
      expectedTarget === undefined ||
      readOwn(record, 'target') !== expectedTarget
    ) {
      throw new TypeError(
        'Cross-domain integrity resource identities are not in canonical order.',
      )
    }
    identities.push(Object.freeze({
      target: expectedTarget,
      identityDigest: readHexDigest(readOwn(record, 'identityDigest')),
    }))
  }
  return Object.freeze(identities)
}

/**
 * Compares every private immutable resource-attestation field exactly.
 *
 * @param left - First strict immutable resource snapshot.
 * @param right - Second strict immutable resource snapshot.
 * @returns Whether every raw immutable identity field is identical.
 */
export function sameCrossDomainIntegrityResourceAttestation(
  left: CrossDomainIntegrityResourceAttestation,
  right: CrossDomainIntegrityResourceAttestation,
): boolean {
  const parsedLeft = parseCrossDomainIntegrityResourceAttestation(left)
  const parsedRight = parseCrossDomainIntegrityResourceAttestation(right)
  if (
    parsedLeft.kind !== parsedRight.kind ||
    parsedLeft.version !== parsedRight.version ||
    parsedLeft.scheme !== parsedRight.scheme ||
    parsedLeft.account !== parsedRight.account ||
    parsedLeft.region !== parsedRight.region ||
    parsedLeft.bucket.target !== parsedRight.bucket.target ||
    parsedLeft.bucket.bucketName !== parsedRight.bucket.bucketName ||
    parsedLeft.bucket.marker.key !== parsedRight.bucket.marker.key ||
    parsedLeft.bucket.marker.versionId !== parsedRight.bucket.marker.versionId ||
    parsedLeft.bucket.marker.checksumSha256 !==
      parsedRight.bucket.marker.checksumSha256 ||
    parsedLeft.bucket.marker.size !== parsedRight.bucket.marker.size ||
    parsedLeft.tables.length !== parsedRight.tables.length
  ) return false
  return parsedLeft.tables.every((table, index) => {
    const other = parsedRight.tables[index]
    return other !== undefined &&
      table.target === other.target &&
      table.tableName === other.tableName &&
      table.tableArn === other.tableArn &&
      table.tableId === other.tableId &&
      table.creationTime === other.creationTime
  })
}

/**
 * Reads the strict six-table private attestation vector.
 *
 * @param value - Untrusted table-vector candidate.
 * @param account - Expected owning AWS account.
 * @param region - Expected AWS Region.
 * @returns Detached canonical table attestations.
 */
function readTableAttestations(
  value: unknown,
  account: string,
  region: string,
): CrossDomainIntegrityTableResourceAttestation[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length !== CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS.length
  ) {
    throw new TypeError('Cross-domain integrity table attestations are incomplete.')
  }
  requireExactArrayKeys(value)
  const tables: CrossDomainIntegrityTableResourceAttestation[] = []
  for (
    let index = 0;
    index < CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS.length;
    index += 1
  ) {
    const target = CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS[index]
    const record = requireRecord(
      readArrayEntry(value, index),
      'table attestation',
    )
    requireExactKeys(record, [
      'creationTime',
      'tableArn',
      'tableId',
      'tableName',
      'target',
    ], 'table attestation')
    if (target === undefined || readOwn(record, 'target') !== target) {
      throw new TypeError(
        'Cross-domain integrity table attestations are not in canonical order.',
      )
    }
    const tableName = readTableName(readOwn(record, 'tableName'))
    const tableArn = readTableArn(
      readOwn(record, 'tableArn'),
      account,
      region,
      tableName,
    )
    tables.push(Object.freeze({
      target,
      tableName,
      tableArn,
      tableId: readBoundedText(readOwn(record, 'tableId'), 1_024),
      creationTime: readCanonicalTimestamp(readOwn(record, 'creationTime')),
    }))
  }
  if (new Set(tables.map((table) => table.tableId)).size !== tables.length) {
    throw new TypeError(
      'Cross-domain integrity table attestations reuse a TableId.',
    )
  }
  return tables
}

/**
 * Reads the strict File bucket and immutable marker attestation.
 *
 * @param value - Untrusted bucket-attestation candidate.
 * @returns Detached and frozen exact bucket incarnation.
 */
function readBucketAttestation(
  value: unknown,
): CrossDomainIntegrityFileBucketResourceAttestation {
  const record = requireRecord(value, 'bucket attestation')
  requireExactKeys(record, [
    'bucketName',
    'marker',
    'target',
  ], 'bucket attestation')
  if (readOwn(record, 'target') !== 'bucket:file') {
    throw new TypeError('Cross-domain integrity bucket target is invalid.')
  }
  return Object.freeze({
    target: 'bucket:file',
    bucketName: readBucketName(readOwn(record, 'bucketName')),
    marker: readMarkerAttestation(readOwn(record, 'marker')),
  })
}

/**
 * Strictly parses one raw per-resource identity input before keying it.
 *
 * @param value - Untrusted runtime value presented through the typed helper.
 * @returns Detached and frozen exact immutable resource fields.
 */
function parseImmutableResourceIdentityInput(
  value: unknown,
): CrossDomainIntegrityImmutableResourceIdentityInput {
  const record = requireRecord(value, 'immutable resource identity input')
  const target = readOwn(record, 'target')
  const account = readAwsAccount(readOwn(record, 'account'))
  const region = readAwsRegion(readOwn(record, 'region'))
  if (target === 'bucket:file') {
    requireExactKeys(record, [
      'account',
      'bucketName',
      'marker',
      'region',
      'target',
    ], 'immutable bucket identity input')
    return Object.freeze({
      account,
      region,
      target,
      bucketName: readBucketName(readOwn(record, 'bucketName')),
      marker: readMarkerAttestation(readOwn(record, 'marker')),
    })
  }
  requireExactKeys(record, [
    'account',
    'creationTime',
    'region',
    'tableArn',
    'tableId',
    'tableName',
    'target',
  ], 'immutable table identity input')
  const tableTarget = readTableResourceTarget(target)
  const tableName = readTableName(readOwn(record, 'tableName'))
  return Object.freeze({
    account,
    region,
    target: tableTarget,
    tableName,
    tableArn: readTableArn(
      readOwn(record, 'tableArn'),
      account,
      region,
      tableName,
    ),
    tableId: readBoundedText(readOwn(record, 'tableId'), 1_024),
    creationTime: readCanonicalTimestamp(readOwn(record, 'creationTime')),
  })
}

/**
 * Strictly parses one exact immutable File bucket marker.
 *
 * @param value - Untrusted marker candidate.
 * @returns Detached and frozen canonical marker fields.
 */
function readMarkerAttestation(
  value: unknown,
): CrossDomainIntegrityFileBucketMarkerAttestation {
  const markerRecord = requireRecord(value, 'bucket marker attestation')
  requireExactKeys(markerRecord, [
    'checksumSha256',
    'key',
    'size',
    'versionId',
  ], 'bucket marker attestation')
  if (
    readOwn(markerRecord, 'key') !==
      CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY
  ) {
    throw new TypeError('Cross-domain integrity bucket marker key is invalid.')
  }
  return Object.freeze({
    key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
    versionId: readVersionId(readOwn(markerRecord, 'versionId')),
    checksumSha256: readSha256Base64(
      readOwn(markerRecord, 'checksumSha256'),
    ),
    size: readNonNegativeInteger(readOwn(markerRecord, 'size')),
  })
}

/**
 * Reads one canonical DynamoDB resource target.
 *
 * @param value - Untrusted table target candidate.
 * @returns Exact canonical table resource target.
 */
function readTableResourceTarget(
  value: unknown,
): CrossDomainIntegrityTableResourceTarget {
  for (const target of CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS) {
    if (value === target) return target
  }
  throw new TypeError('Cross-domain integrity table target is invalid.')
}

/**
 * Requires one ordinary own-property-only record.
 *
 * @param value - Untrusted record candidate.
 * @param label - Safe diagnostic field label.
 * @returns Validated ordinary record.
 */
function requireRecord(
  value: unknown,
  label: string,
): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`Cross-domain integrity ${label} must be a record.`)
  }
  return value
}

/**
 * Requires one record to own exactly the expected keys.
 *
 * @param record - Ordinary record to inspect.
 * @param expected - Complete expected string-key set.
 * @param label - Safe diagnostic field label.
 * @returns Nothing; invalid keys throw.
 */
function requireExactKeys(
  record: object,
  expected: readonly string[],
  label: string,
): void {
  const ownKeys = Reflect.ownKeys(record)
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError(`Cross-domain integrity ${label} keys are invalid.`)
  }
  const keys = ownKeys.filter((key): key is string => typeof key === 'string')
    .sort()
  const expectedKeys = [...expected].sort()
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(`Cross-domain integrity ${label} keys are invalid.`)
  }
}

/**
 * Reads one direct data property without invoking accessors.
 *
 * @param record - Validated ordinary record.
 * @param key - Required own data-property name.
 * @returns Direct descriptor value.
 */
function readOwn(
  record: object,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('Cross-domain integrity attestation property is invalid.')
  }
  return descriptor.value
}

/**
 * Reads one required own array entry without invoking an accessor.
 *
 * @param value - Validated dense array.
 * @param index - Required own entry index.
 * @returns Direct descriptor value.
 */
function readArrayEntry(value: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('Cross-domain integrity attestation array is invalid.')
  }
  return descriptor.value
}

/**
 * Requires an array to own only its length and dense numeric entries.
 *
 * @param value - Non-Proxy array candidate.
 * @returns Nothing; sparse, accessor, or extra-key arrays throw.
 */
function requireExactArrayKeys(value: readonly unknown[]): void {
  const expectedKeys = ['length']
  for (let index = 0; index < value.length; index += 1) {
    expectedKeys.push(String(index))
  }
  expectedKeys.sort()
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== expectedKeys.length
  ) {
    throw new TypeError('Cross-domain integrity attestation array is invalid.')
  }
  const actualKeys = ownKeys.filter(
    (key): key is string => typeof key === 'string',
  ).sort()
  if (actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError('Cross-domain integrity attestation array is invalid.')
  }
}

/**
 * Reads one twelve-digit AWS account identifier.
 *
 * @param value - Untrusted account candidate.
 * @returns Exact twelve-digit account identifier.
 */
function readAwsAccount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{12}$/u.test(value)) {
    throw new TypeError('Cross-domain integrity attestation account is invalid.')
  }
  return value
}

/**
 * Reads one conventional AWS Region identifier.
 *
 * @param value - Untrusted Region candidate.
 * @returns Validated AWS Region identifier.
 */
function readAwsRegion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/u.test(value)
  ) {
    throw new TypeError('Cross-domain integrity attestation Region is invalid.')
  }
  return value
}

/**
 * Reads one conventional DynamoDB table name.
 *
 * @param value - Untrusted table-name candidate.
 * @returns Validated physical table name.
 */
function readTableName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_.-]{3,255}$/u.test(value)
  ) {
    throw new TypeError('Cross-domain integrity attestation table name is invalid.')
  }
  return value
}

/**
 * Reads one table ARN and binds it to the expected account, Region, and name.
 *
 * @param value - Untrusted ARN candidate.
 * @param account - Expected owning account.
 * @param region - Expected AWS Region.
 * @param tableName - Expected exact physical table name.
 * @returns Validated exact table ARN.
 */
function readTableArn(
  value: unknown,
  account: string,
  region: string,
  tableName: string,
): string {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new TypeError('Cross-domain integrity attestation table ARN is invalid.')
  }
  const match = /^arn:[^:]+:dynamodb:([^:]+):(\d{12}):table\/(.+)$/u.exec(
    value,
  )
  if (
    match === null ||
    match[1] !== region ||
    match[2] !== account ||
    match[3] !== tableName
  ) {
    throw new TypeError('Cross-domain integrity attestation table ARN is invalid.')
  }
  return value
}

/**
 * Reads one conventional general-purpose S3 bucket name.
 *
 * @param value - Untrusted bucket-name candidate.
 * @returns Validated physical bucket name.
 */
function readBucketName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value) ||
    value.includes('..') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)
  ) {
    throw new TypeError('Cross-domain integrity attestation bucket name is invalid.')
  }
  return value
}

/**
 * Reads one bounded non-empty text field without control characters.
 *
 * @param value - Untrusted text candidate.
 * @param maximumBytes - Maximum UTF-8 byte length.
 * @returns Validated bounded text.
 */
function readBoundedText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    containsControlCharacter(value)
  ) {
    throw new TypeError('Cross-domain integrity attestation text is invalid.')
  }
  return value
}

/**
 * Returns whether text contains a C0, DEL, or C1 control character.
 *
 * @param value - Text to inspect without locale-dependent behavior.
 * @returns True when the text contains a forbidden control character.
 */
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0)
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true
    }
  }
  return false
}

/**
 * Reads one exact non-null S3 object VersionId.
 *
 * @param value - Untrusted VersionId candidate.
 * @returns Validated exact non-null VersionId.
 */
function readVersionId(value: unknown): string {
  const versionId = readBoundedText(value, 1_024)
  if (versionId === 'null') {
    throw new TypeError('Cross-domain integrity marker VersionId is invalid.')
  }
  return versionId
}

/**
 * Reads one canonical base64-encoded SHA-256 checksum.
 *
 * @param value - Untrusted checksum candidate.
 * @returns Canonical base64 SHA-256 checksum.
 */
function readSha256Base64(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Cross-domain integrity marker checksum is invalid.')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
    throw new TypeError('Cross-domain integrity marker checksum is invalid.')
  }
  return value
}

/**
 * Reads one canonical millisecond-resolution UTC timestamp.
 *
 * @param value - Untrusted timestamp candidate.
 * @returns Canonical millisecond-resolution UTC timestamp.
 */
function readCanonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Cross-domain integrity table creation time is invalid.')
  }
  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new TypeError('Cross-domain integrity table creation time is invalid.')
  }
  return value
}

/**
 * Reads one non-negative safe integer.
 *
 * @param value - Untrusted integer candidate.
 * @returns Validated non-negative safe integer.
 */
function readNonNegativeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError('Cross-domain integrity marker size is invalid.')
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Untrusted digest candidate.
 * @returns Exact lowercase hexadecimal SHA-256 digest.
 */
function readHexDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('Cross-domain integrity resource identity is invalid.')
  }
  return value
}

/**
 * Requires one ordinary 32-byte HMAC key.
 *
 * @param digestKey - Untrusted key view.
 * @returns Nothing; invalid or shared-memory keys throw.
 */
function requireDigestKey(digestKey: Uint8Array): void {
  if (
    !nodeUtilTypes.isUint8Array(digestKey) ||
    nodeUtilTypes.isProxy(digestKey) ||
    nodeUtilTypes.isSharedArrayBuffer(digestKey.buffer) ||
    digestKey.byteLength !== 32
  ) {
    throw new TypeError('Cross-domain integrity digest key is invalid.')
  }
}

/**
 * Encodes strings without delimiter ambiguity.
 *
 * @param fields - Ordered raw string fields.
 * @returns Length-prefixed canonical field encoding.
 */
function canonicalFields(fields: readonly string[]): string {
  return fields
    .map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`)
    .join('|')
}

/**
 * Creates one checker-compatible domain-separated HMAC instance.
 *
 * @param key - Validated 32-byte HMAC key.
 * @param domain - Fixed purpose-specific domain label.
 * @returns Initialized HMAC instance.
 */
function createDomainHmac(key: Uint8Array, domain: string) {
  return createHmac('sha256', key).update(
    `mukuroji-cross-domain-integrity\0${domain}\0`,
    'utf8',
  )
}
