import {
  DynamoDBClient,
  ScanCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import {
  GetObjectAttributesCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ObjectAttributes,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  GetCallerIdentityCommand,
  STSClient,
} from '@aws-sdk/client-sts'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import {
  parseCanonicalAttributeMap,
  serializeCanonicalAttributeMap,
} from '../../infrastructure/aws/dynamodb-attribute-codec'
import {
  readCrossDomainIntegrityAwsNormalizedPage,
} from './cross-domain-integrity-aws'
import type {
  CrossDomainIntegrityManagedAwsReadPort,
  CrossDomainIntegrityObjectVersionReference,
} from './cross-domain-integrity-aws-types'
import type {
  CrossDomainIntegrityNormalizedPage,
  CrossDomainIntegrityNormalizedPageReader,
  CrossDomainIntegrityNormalizedPageReaderConfiguration,
  CrossDomainIntegrityNormalizedPageRequest,
  CrossDomainIntegrityTableNames,
  CrossDomainIntegrityTableTarget,
} from './cross-domain-integrity-page-contract'

/** SDK-independent normalized-page types colocated in the public contract. */
export type {
  CrossDomainIntegrityNormalizedAuditCandidate,
  CrossDomainIntegrityNormalizedAuditCandidateValue,
  CrossDomainIntegrityNormalizedItem,
  CrossDomainIntegrityNormalizedPage,
  CrossDomainIntegrityNormalizedPageReader,
  CrossDomainIntegrityNormalizedPageReaderConfiguration,
  CrossDomainIntegrityNormalizedPageRequest,
  CrossDomainIntegrityTableNames,
  CrossDomainIntegrityTableTarget,
} from './cross-domain-integrity-page-contract'

const CURSOR_PREFIX = 'dynamodb-key-v1.'
const MAX_CURSOR_LENGTH = 16_384
const MAX_OBJECT_REFERENCE_BYTES = 1_024
const AWS_CONNECTION_TIMEOUT_MILLISECONDS = 5_000
const AWS_MAX_ATTEMPTS = 3
const AWS_REQUEST_TIMEOUT_MILLISECONDS = 30_000
const REQUIRED_TABLE_TARGETS: readonly CrossDomainIntegrityTableTarget[] = [
  'work-items',
  'work-item-configuration',
  'project-directory',
  'workspace-access',
  'audit-events',
  'file-proofing',
]

/**
 * Creates an isolated, bounded AWS client configuration for one reader client.
 *
 * @param region - Exact AWS Region containing the isolated restore resources.
 * @returns Client configuration with finite connection, request, and retry budgets.
 */
function createBoundedAwsClientConfiguration(region: string) {
  return {
    maxAttempts: AWS_MAX_ATTEMPTS,
    region,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: AWS_CONNECTION_TIMEOUT_MILLISECONDS,
      requestTimeout: AWS_REQUEST_TIMEOUT_MILLISECONDS,
      throwOnRequestTimeout: true,
    }),
  }
}

/** Stable failure emitted by the SDK-independent normalized reader boundary. */
export class CrossDomainIntegrityNormalizedPageReaderFailure extends Error {
  /** Stable raw-value-free failure category. */
  readonly code:
    | 'AWS_RESPONSE_INVALID'
    | 'CONFIGURATION_INVALID'
    | 'CURSOR_INVALID'

  /**
   * Creates a normalized reader failure without embedding raw AWS values.
   *
   * @param code - Stable raw-value-free failure category.
   */
  constructor(
    code:
      | 'AWS_RESPONSE_INVALID'
      | 'CONFIGURATION_INVALID'
      | 'CURSOR_INVALID',
  ) {
    super(code)
    this.name = 'CrossDomainIntegrityNormalizedPageReaderFailure'
    this.code = code
  }
}

/**
 * Creates a concrete AWS adapter behind the normalized data-integrity boundary.
 *
 * @param configuration - Exact isolated resources, account, Region, and page bound.
 * @returns Closeable reader whose public contract is independent of the AWS SDK.
 */
export function createCrossDomainIntegrityNormalizedPageReader(
  configuration: CrossDomainIntegrityNormalizedPageReaderConfiguration,
): CrossDomainIntegrityNormalizedPageReader {
  return new AwsCrossDomainIntegrityNormalizedPageReader(configuration)
}

/** Concrete normalized reader that owns its raw SDK adapter. */
class AwsCrossDomainIntegrityNormalizedPageReader
  implements CrossDomainIntegrityNormalizedPageReader {
  /** Expected owner account independently checked before every normalized page. */
  private readonly accountId: string

  /** Fixed normalization page size shared with the low-level Scan command. */
  private readonly pageSize: number

  /** Module-private raw AWS reader. */
  private readonly reader: CrossDomainIntegrityManagedAwsReadPort

  /**
   * Creates one normalized reader over an exact isolated resource allowlist.
   *
   * @param configuration - Validated reader configuration.
   */
  constructor(configuration: CrossDomainIntegrityNormalizedPageReaderConfiguration) {
    validateReaderConfiguration(configuration)
    this.accountId = configuration.accountId
    this.pageSize = configuration.pageSize
    this.reader = new RawAwsReadPort(configuration)
  }

  /** @inheritdoc */
  close(): void {
    this.reader.close()
  }

  /** @inheritdoc */
  async readPage(
    request: CrossDomainIntegrityNormalizedPageRequest,
  ): Promise<CrossDomainIntegrityNormalizedPage> {
    try {
      const exclusiveStartKey = request.cursor === undefined
        ? undefined
        : decodeCrossDomainIntegrityPageCursor(request.cursor)
      const callerAccount = await this.reader.readCallerAccount(request.signal)
      if (callerAccount !== this.accountId) {
        throw new CrossDomainIntegrityNormalizedPageReaderFailure(
          'AWS_RESPONSE_INVALID',
        )
      }
      const normalized = await readCrossDomainIntegrityAwsNormalizedPage({
        auditPseudonymKey: request.auditPseudonymKey,
        checkedAt: request.checkedAt,
        digestKey: request.digestKey,
        ...(exclusiveStartKey === undefined ? {} : { exclusiveStartKey }),
        pageSize: this.pageSize,
        reader: this.reader,
        remainingItemCapacity: request.remainingItemCapacity,
        signal: request.signal,
        target: request.target,
      })
      return {
        auditCandidates: normalized.auditCandidates,
        externalFileFailureCodes: normalized.externalFileFailureCodes,
        items: normalized.items,
        ...(normalized.nextKey === undefined
          ? {}
          : { nextCursor: encodeCrossDomainIntegrityPageCursor(normalized.nextKey) }),
        retainedUnitCount: normalized.retainedUnitCount,
      }
    } catch (error) {
      if (error instanceof CrossDomainIntegrityNormalizedPageReaderFailure) throw error
      throw new CrossDomainIntegrityNormalizedPageReaderFailure(
        'AWS_RESPONSE_INVALID',
      )
    }
  }
}

/** Module-private low-level AWS reader used only by the normalized adapter. */
class RawAwsReadPort implements CrossDomainIntegrityManagedAwsReadPort {
  /** Expected owner account for every exact-version request. */
  private readonly accountId: string

  /** Exact isolated File bucket. */
  private readonly bucketName: string

  /** Low-level DynamoDB client. */
  private readonly dynamodb: DynamoDBClient

  /** Fixed item limit placed on every Scan request. */
  private readonly pageSize: number

  /** S3 client for exact immutable-version observations. */
  private readonly s3: S3Client

  /** STS client retained for the complete internal raw-port contract. */
  private readonly sts: STSClient

  /** Complete logical-to-physical table allowlist. */
  private readonly tableNames: CrossDomainIntegrityTableNames

  /**
   * Creates a raw adapter that remains private to the data-integrity module.
   *
   * @param configuration - Validated exact resource configuration.
   */
  constructor(configuration: CrossDomainIntegrityNormalizedPageReaderConfiguration) {
    this.accountId = configuration.accountId
    this.bucketName = configuration.bucketName
    this.pageSize = configuration.pageSize
    this.tableNames = { ...configuration.tableNames }
    this.dynamodb = new DynamoDBClient(
      createBoundedAwsClientConfiguration(configuration.region),
    )
    this.s3 = new S3Client(
      createBoundedAwsClientConfiguration(configuration.region),
    )
    this.sts = new STSClient(
      createBoundedAwsClientConfiguration(configuration.region),
    )
  }

  /** @inheritdoc */
  close(): void {
    this.dynamodb.destroy()
    this.s3.destroy()
    this.sts.destroy()
  }

  /** @inheritdoc */
  getObjectAttributes(
    reference: CrossDomainIntegrityObjectVersionReference,
    signal?: AbortSignal,
  ) {
    const target = this.requireObjectReference(reference)
    return this.s3.send(new GetObjectAttributesCommand({
      Bucket: this.bucketName,
      ExpectedBucketOwner: this.accountId,
      Key: target.key,
      ObjectAttributes: [ObjectAttributes.CHECKSUM, ObjectAttributes.OBJECT_SIZE],
      VersionId: target.versionId,
    }), { abortSignal: requireNormalizedPageSignal(signal) })
  }

  /** @inheritdoc */
  getObjectTagging(
    reference: CrossDomainIntegrityObjectVersionReference,
    signal?: AbortSignal,
  ) {
    const target = this.requireObjectReference(reference)
    return this.s3.send(new GetObjectTaggingCommand({
      Bucket: this.bucketName,
      ExpectedBucketOwner: this.accountId,
      Key: target.key,
      VersionId: target.versionId,
    }), { abortSignal: requireNormalizedPageSignal(signal) })
  }

  /** @inheritdoc */
  headObject(
    reference: CrossDomainIntegrityObjectVersionReference,
    signal?: AbortSignal,
  ) {
    const target = this.requireObjectReference(reference)
    return this.s3.send(new HeadObjectCommand({
      Bucket: this.bucketName,
      ExpectedBucketOwner: this.accountId,
      Key: target.key,
      VersionId: target.versionId,
    }), { abortSignal: requireNormalizedPageSignal(signal) })
  }

  /** @inheritdoc */
  async readCallerAccount(signal?: AbortSignal): Promise<string> {
    const output = await this.sts.send(
      new GetCallerIdentityCommand({}),
      { abortSignal: requireNormalizedPageSignal(signal) },
    )
    if (output.Account !== this.accountId) {
      throw new CrossDomainIntegrityNormalizedPageReaderFailure(
        'AWS_RESPONSE_INVALID',
      )
    }
    return output.Account
  }

  /** @inheritdoc */
  scanPage(
    target: CrossDomainIntegrityTableTarget,
    exclusiveStartKey?: Record<string, AttributeValue>,
    signal?: AbortSignal,
  ) {
    return this.dynamodb.send(new ScanCommand({
      ConsistentRead: true,
      ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      Limit: this.pageSize,
      TableName: resolveTableName(this.tableNames, target),
    }), { abortSignal: requireNormalizedPageSignal(signal) })
  }

  /**
   * Validates one exact immutable File version reference.
   *
   * @param reference - Reference emitted by strict File-row normalization.
   * @returns The same validated reference.
   */
  private requireObjectReference(
    reference: CrossDomainIntegrityObjectVersionReference,
  ): CrossDomainIntegrityObjectVersionReference {
    if (
      reference.bucket !== 'file' ||
      !isBoundedText(reference.key, MAX_OBJECT_REFERENCE_BYTES) ||
      !isBoundedText(reference.versionId, MAX_OBJECT_REFERENCE_BYTES) ||
      reference.versionId === 'null'
    ) {
      throw new CrossDomainIntegrityNormalizedPageReaderFailure(
        'AWS_RESPONSE_INVALID',
      )
    }
    return reference
  }
}

/** Requires the caller's finite normalized-page cancellation signal. */
function requireNormalizedPageSignal(signal: AbortSignal | undefined): AbortSignal {
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw new CrossDomainIntegrityNormalizedPageReaderFailure(
      'AWS_RESPONSE_INVALID',
    )
  }
  return signal
}

/**
 * Encodes one strict low-level key as a canonical versioned opaque cursor.
 *
 * @param key - Strict low-level DynamoDB continuation key.
 * @returns Canonical versioned base64url cursor.
 */
function encodeCrossDomainIntegrityPageCursor(
  key: Readonly<Record<string, AttributeValue>>,
): string {
  try {
    if (Object.keys(key).length === 0) return invalidCursor()
    const canonical = serializeCanonicalAttributeMap(key)
    const cursor = `${CURSOR_PREFIX}${Buffer.from(canonical, 'utf8').toString('base64url')}`
    if (cursor.length > MAX_CURSOR_LENGTH) return invalidCursor()
    return cursor
  } catch (error) {
    if (error instanceof CrossDomainIntegrityNormalizedPageReaderFailure) throw error
    return invalidCursor()
  }
}

/**
 * Decodes and revalidates one canonical versioned opaque cursor.
 *
 * @param cursor - Untrusted cursor supplied by the preceding normalized page.
 * @returns Strict low-level DynamoDB continuation key.
 */
function decodeCrossDomainIntegrityPageCursor(
  cursor: string,
): Record<string, AttributeValue> {
  try {
    if (
      cursor.length <= CURSOR_PREFIX.length ||
      cursor.length > MAX_CURSOR_LENGTH ||
      !cursor.startsWith(CURSOR_PREFIX)
    ) return invalidCursor()
    const payload = cursor.slice(CURSOR_PREFIX.length)
    if (!/^[A-Za-z0-9_-]+$/u.test(payload)) return invalidCursor()
    const bytes = Buffer.from(payload, 'base64url')
    if (bytes.toString('base64url') !== payload) return invalidCursor()
    const canonical = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const key = parseCanonicalAttributeMap(canonical)
    if (
      Object.keys(key).length === 0 ||
      encodeCrossDomainIntegrityPageCursor(key) !== cursor
    ) return invalidCursor()
    return key
  } catch (error) {
    if (error instanceof CrossDomainIntegrityNormalizedPageReaderFailure) throw error
    return invalidCursor()
  }
}

/** Validates all primitive reader settings before constructing SDK clients. */
function validateReaderConfiguration(
  configuration: CrossDomainIntegrityNormalizedPageReaderConfiguration,
): void {
  const tableNames = REQUIRED_TABLE_TARGETS.map((target) =>
    resolveTableName(configuration.tableNames, target))
  if (
    !/^\d{12}$/u.test(configuration.accountId) ||
    !isBucketName(configuration.bucketName) ||
    !Number.isSafeInteger(configuration.pageSize) ||
    configuration.pageSize < 1 ||
    configuration.pageSize > 100 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+){2,5}$/u.test(configuration.region) ||
    new Set(tableNames).size !== REQUIRED_TABLE_TARGETS.length
  ) {
    throw new CrossDomainIntegrityNormalizedPageReaderFailure(
      'CONFIGURATION_INVALID',
    )
  }
}

/** Resolves one allowlisted logical table after validating its physical name. */
function resolveTableName(
  tableNames: CrossDomainIntegrityTableNames,
  target: CrossDomainIntegrityTableTarget,
): string {
  const tableName = tableNames[target]
  if (
    tableName.length < 3 ||
    tableName.length > 255 ||
    !/^[A-Za-z0-9_.-]+$/u.test(tableName)
  ) {
    throw new CrossDomainIntegrityNormalizedPageReaderFailure(
      'CONFIGURATION_INVALID',
    )
  }
  return tableName
}

/** Checks one general-purpose S3 bucket name without accepting IP literals. */
function isBucketName(value: string): boolean {
  return value.length >= 3 &&
    value.length <= 63 &&
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value) &&
    !value.includes('..') &&
    !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)
}

/** Checks one non-empty bounded value for unsafe control characters. */
function isBoundedText(value: string, maximumBytes: number): boolean {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > maximumBytes) return false
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return false
  }
  return true
}

/** Throws the stable cursor failure while preserving expression typing. */
function invalidCursor(): never {
  throw new CrossDomainIntegrityNormalizedPageReaderFailure('CURSOR_INVALID')
}
