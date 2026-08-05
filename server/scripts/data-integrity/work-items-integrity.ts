import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  AttributeValue,
  DescribeContinuousBackupsCommandOutput,
  DescribeTableCommandOutput,
  DescribeTimeToLiveCommandOutput,
  GlobalSecondaryIndexDescription,
  KeySchemaElement,
  ScanCommandOutput,
  TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import { isCanonicalWorkItemRecord } from '../../src/modules/work-items'

const MANIFEST_KIND = 'mukuroji-work-items-integrity-manifest'
const MANIFEST_VERSION = 1
const DIGEST_ALGORITHM = 'HMAC-SHA-256'
const DIGEST_VERSION = 1
const DIGEST_BYTE_LENGTH = 32
const MAX_SCAN_PAGES = 100_000
const MAX_SCAN_ITEMS = 1_000_000

const requiredStringAttributeNames = [
  'assigneeUserId',
  'createdAt',
  'creatorMemberKey',
  'directoryId',
  'directoryTeamId',
  'dueDate',
  'issueId',
  'priority',
  'statusCategory',
  'teamId',
  'title',
  'updatedAt',
  'workflowStatusId',
]

const optionalStringAttributeNames = [
  'archivedAt',
  'archivedBy',
  'assignedProjectId',
  'description',
  'directoryProjectId',
  'importRequestDigest',
  'sourceRequestId',
]

const requiredNumberAttributeNames = [
  'revision',
  'schemaVersion',
  'sortOrder',
  'workflowSchemaVersion',
]

const expectedAttributeDefinitions = [
  { name: 'directoryProjectId', type: 'S' },
  { name: 'directoryTeamId', type: 'S' },
  { name: 'issueId', type: 'S' },
  { name: 'sortOrder', type: 'N' },
  { name: 'updatedAt', type: 'S' },
]

const expectedBaseKey = [
  { name: 'directoryTeamId', type: 'HASH' },
  { name: 'issueId', type: 'RANGE' },
]

const expectedGlobalSecondaryIndexes = [
  {
    name: 'AssignedProjectIssueIndex',
    key: [
      { name: 'directoryProjectId', type: 'HASH' },
      { name: 'sortOrder', type: 'RANGE' },
    ],
    projection: 'ALL',
    status: 'ACTIVE',
  },
  {
    name: 'TeamIssueSortOrderIndex',
    key: [
      { name: 'directoryTeamId', type: 'HASH' },
      { name: 'sortOrder', type: 'RANGE' },
    ],
    projection: 'ALL',
    status: 'ACTIVE',
  },
  {
    name: 'TeamIssueUpdatedAtIndex',
    key: [
      { name: 'directoryTeamId', type: 'HASH' },
      { name: 'updatedAt', type: 'RANGE' },
    ],
    projection: 'ALL',
    status: 'ACTIVE',
  },
]

/** Identifies whether a manifest describes the protected source or an isolated restore. */
export type WorkItemsIntegrityRole = 'source' | 'restore'

/** Records the external write-isolation evidence available during a source scan. */
export type SourceCaptureConsistency = 'writer-fenced' | 'live-observation'

/** Stable failure categories emitted without tenant data or raw AWS errors. */
export type WorkItemsIntegrityFailureCode =
  | 'ACCOUNT_MISMATCH'
  | 'ATTRIBUTE_DEFINITION_MISMATCH'
  | 'BASE_KEY_MISMATCH'
  | 'BILLING_MODE_MISMATCH'
  | 'CONTENT_DIGEST_MISMATCH'
  | 'CURSOR_LOOP'
  | 'DESCRIPTOR_MISMATCH'
  | 'DIGEST_KEY_INVALID'
  | 'DUPLICATE_PRIMARY_KEY'
  | 'ENCRYPTION_STATE_INVALID'
  | 'GLOBAL_SECONDARY_INDEX_MISMATCH'
  | 'INTEGRITY_LIMIT_EXCEEDED'
  | 'INVALID_MANIFEST'
  | 'INVALID_WORK_ITEM_RECORD'
  | 'ITEM_COUNT_MISMATCH'
  | 'KEY_FINGERPRINT_MISMATCH'
  | 'KEY_SET_DIGEST_MISMATCH'
  | 'LOCAL_SECONDARY_INDEX_UNEXPECTED'
  | 'MANIFEST_AUTHENTICATION_FAILED'
  | 'MANIFEST_ROLE_MISMATCH'
  | 'PARTITION_COUNT_MISMATCH'
  | 'PITR_SOURCE_NOT_READY'
  | 'REGION_MISMATCH'
  | 'RESTORE_IN_PROGRESS'
  | 'RESTORE_POINT_OUTSIDE_WINDOW'
  | 'RESTORE_SOURCE_MISMATCH'
  | 'RESTORE_SUMMARY_MISSING'
  | 'SOURCE_NOT_WRITER_FENCED'
  | 'TABLE_IDENTITY_INVALID'
  | 'TABLE_ID_REUSED'
  | 'TABLE_NOT_ACTIVE'
  | 'TTL_STATE_MISMATCH'

/** A DynamoDB primary or secondary key component. */
export type WorkItemsKeyDescriptor = {
  /** Attribute name used by the key component. */
  name: string
  /** DynamoDB key role. */
  type: 'HASH' | 'RANGE'
}

/** A normalized Work Items global secondary index descriptor. */
export type WorkItemsGlobalSecondaryIndexDescriptor = {
  /** Stable index name. */
  name: string
  /** Ordered partition and sort key definition. */
  key: WorkItemsKeyDescriptor[]
  /** Required projection mode. */
  projection: 'ALL'
  /** Required operational state. */
  status: 'ACTIVE'
}

/** The normalized storage descriptor compared between source and restore tables. */
export type WorkItemsTableDescriptor = {
  /** Ordered base-table key definition. */
  baseKey: WorkItemsKeyDescriptor[]
  /** Billing mode required by the CDK contract. */
  billingMode: 'PAY_PER_REQUEST'
  /** Observed server-side encryption family. */
  encryption: 'AWS_OWNED' | 'KMS'
  /** Sorted set of required global secondary indexes. */
  globalSecondaryIndexes: WorkItemsGlobalSecondaryIndexDescriptor[]
  /** Work Items must not expire through DynamoDB TTL. */
  ttlStatus: 'DISABLED'
}

/** Explicit operator inputs captured in a signed manifest. */
export type WorkItemsManifestRequest = {
  /** Explicit AWS account allowed for the read. */
  account: string
  /** Explicit AWS profile bound to the client credentials. */
  profile: string
  /** Explicit AWS region allowed for the read. */
  region: string
  /** Explicit physical table name allowed for the read. */
  tableName: string
}

/** Observed immutable table identity. */
export type WorkItemsObservedTable = {
  /** Account returned by STS for the bound profile. */
  callerAccount: string
  /** Table ARN returned by DynamoDB. */
  tableArn: string
  /** DynamoDB table creation timestamp. */
  tableCreationTime: string
  /** DynamoDB table identifier. */
  tableId: string
}

/** Point-in-time recovery state observed while creating a manifest. */
export type WorkItemsPitrState = {
  /** Earliest restorable timestamp, or null when PITR is disabled. */
  earliestRestorableTime: string | null
  /** Latest restorable timestamp, or null when PITR is disabled. */
  latestRestorableTime: string | null
  /** Point-in-time recovery status. */
  status: 'ENABLED' | 'DISABLED'
}

/** DynamoDB restore provenance required for a restore manifest. */
export type WorkItemsRestoreSummary = {
  /** Restore completion state. */
  restoreInProgress: false
  /** Selected point in time restored into the table. */
  restoreDateTime: string
  /** ARN of the source table used by DynamoDB restore. */
  sourceTableArn: string
}

/** Secret-free scan evidence embedded in a manifest. */
export type WorkItemsScanEvidence = {
  /** Capture context that determines whether exact comparison can pass. */
  captureContext: SourceCaptureConsistency | 'isolated-restore'
  /** UTC time at which all scan pages completed. */
  completedAt: string
  /** Confirms every base-table scan page requested strong per-item reads. */
  consistentRead: true
  /** Exact number of valid Work Item rows scanned. */
  itemCount: number
  /** Exact number of distinct hashed logical partitions. */
  logicalPartitionCount: number
  /** Exact number of DynamoDB scan pages processed. */
  pageCount: number
  /** Explicitly records that DynamoDB Scan is not table-wide snapshot isolation. */
  snapshotIsolation: false
  /** UTC time immediately before the first scan page. */
  startedAt: string
}

/** Aggregate keyed digests that do not expose row-level identifiers. */
export type WorkItemsDigestEvidence = {
  /** Digest algorithm name. */
  algorithm: typeof DIGEST_ALGORITHM
  /** Aggregate full-content digest. */
  contentDigest: string
  /** Non-secret fingerprint proving both manifests used the same key. */
  keyFingerprint: string
  /** Aggregate primary-key-set digest. */
  keySetDigest: string
  /** Digest contract version. */
  version: typeof DIGEST_VERSION
}

/** Signed, raw-data-free Work Items integrity evidence. */
export type WorkItemsIntegrityManifest = {
  /** Aggregate descriptor and content digests. */
  digest: WorkItemsDigestEvidence
  /** Normalized Work Items table descriptor. */
  descriptor: WorkItemsTableDescriptor
  /** Fixed artifact discriminator. */
  kind: typeof MANIFEST_KIND
  /** HMAC authenticating every other manifest field. */
  manifestMac: string
  /** Manifest schema version. */
  manifestVersion: typeof MANIFEST_VERSION
  /** Immutable identity observed from AWS. */
  observed: WorkItemsObservedTable
  /** Point-in-time recovery state observed during capture. */
  pitr: WorkItemsPitrState
  /** Explicit operator request. */
  requested: WorkItemsManifestRequest
  /** Restore provenance, present only for restore manifests. */
  restore: WorkItemsRestoreSummary | null
  /** Source or restore role. */
  role: WorkItemsIntegrityRole
  /** Secret-free scan evidence. */
  scan: WorkItemsScanEvidence
  /** Canonical Work Item configuration schema version checked by the row validator. */
  workflowSchemaVersion: typeof WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  /** Canonical Work Item storage schema version checked by the row validator. */
  workItemSchemaVersion: typeof WORK_ITEM_SCHEMA_VERSION
}

/** Inputs needed to create one signed Work Items integrity manifest. */
export type CreateWorkItemsIntegrityManifestInput = {
  /** Expected AWS account. */
  account: string
  /** 32-byte key used only in memory for row digests and the manifest MAC. */
  digestKey: Uint8Array
  /** Optional deterministic clock used by tests. */
  now?: () => Date
  /** Explicit AWS profile recorded in the evidence. */
  profile: string
  /** Read-only AWS port. */
  reader: WorkItemsIntegrityReadPort
  /** Expected AWS region. */
  region: string
  /** Manifest role. */
  role: WorkItemsIntegrityRole
  /** Required source capture context; omitted for restore manifests. */
  sourceConsistency?: SourceCaptureConsistency
  /** Expected physical table name. */
  tableName: string
}

/** Result of comparing authenticated source and restore manifests. */
export type WorkItemsIntegrityComparison = {
  /** Stable mismatch categories with no row-level data. */
  failureCodes: WorkItemsIntegrityFailureCode[]
  /** Overall exact-comparison result. */
  status: 'pass' | 'fail'
}

/** Read-only AWS operations used by the Work Items verifier. */
export interface WorkItemsIntegrityReadPort {
  /**
   * Reads the caller account from STS.
   *
   * @returns Caller AWS account identifier.
   */
  readCallerAccount(): Promise<string>
  /**
   * Reads DynamoDB table metadata.
   *
   * @param tableName - Explicit physical table name.
   * @returns DescribeTable response.
   */
  describeTable(tableName: string): Promise<DescribeTableCommandOutput>
  /**
   * Reads point-in-time recovery state.
   *
   * @param tableName - Explicit physical table name.
   * @returns DescribeContinuousBackups response.
   */
  describeContinuousBackups(
    tableName: string,
  ): Promise<DescribeContinuousBackupsCommandOutput>
  /**
   * Reads DynamoDB TTL state.
   *
   * @param tableName - Explicit physical table name.
   * @returns DescribeTimeToLive response.
   */
  describeTimeToLive(tableName: string): Promise<DescribeTimeToLiveCommandOutput>
  /**
   * Reads one full, unfiltered base-table scan page.
   *
   * @param tableName - Explicit physical table name.
   * @param exclusiveStartKey - Opaque cursor from the immediately preceding page.
   * @returns One strongly consistent scan page.
   */
  scanPage(
    tableName: string,
    exclusiveStartKey?: Record<string, AttributeValue>,
  ): Promise<ScanCommandOutput>
}

/** Stable verifier failure that is safe to serialize by code only. */
export class WorkItemsIntegrityFailure extends Error {
  /** Stable raw-data-free failure category. */
  readonly code: WorkItemsIntegrityFailureCode

  /**
   * Creates a safe integrity failure.
   *
   * @param code - Stable failure category.
   */
  constructor(code: WorkItemsIntegrityFailureCode) {
    super(code)
    this.name = 'WorkItemsIntegrityFailure'
    this.code = code
  }
}

/** Unsigned manifest fields authenticated by the final manifest MAC. */
type UnsignedWorkItemsIntegrityManifest = Omit<WorkItemsIntegrityManifest, 'manifestMac'>

/** Intermediate aggregate produced by the full table scan. */
type ScanAggregate = {
  /** Full-content aggregate digest. */
  contentDigest: string
  /** Exact valid row count. */
  itemCount: number
  /** Primary-key-set aggregate digest. */
  keySetDigest: string
  /** Exact logical partition count. */
  logicalPartitionCount: number
  /** Exact processed page count. */
  pageCount: number
}

/** Parsed table identity used before any row scan begins. */
type TableIdentity = {
  /** Table ARN. */
  arn: string
  /** AWS account parsed from the ARN. */
  account: string
  /** Table creation timestamp. */
  creationTime: string
  /** DynamoDB table identifier. */
  id: string
  /** Physical table name parsed from the ARN. */
  name: string
  /** AWS region parsed from the ARN. */
  region: string
}

/**
 * Creates a signed manifest after validating AWS identity, table schema, PITR state, and every row.
 *
 * @param input - Explicit verifier configuration and read-only AWS port.
 * @returns Authenticated secret-free manifest.
 */
export async function createWorkItemsIntegrityManifest(
  input: CreateWorkItemsIntegrityManifestInput,
): Promise<WorkItemsIntegrityManifest> {
  validateDigestKey(input.digestKey)
  const now = input.now ?? currentTime
  const captureContext = readCaptureContext(input.role, input.sourceConsistency)
  const callerAccount = await input.reader.readCallerAccount()
  if (callerAccount !== input.account) {
    throw new WorkItemsIntegrityFailure('ACCOUNT_MISMATCH')
  }

  const tableOutput = await input.reader.describeTable(input.tableName)
  const table = tableOutput.Table
  if (!table) {
    throw new WorkItemsIntegrityFailure('TABLE_IDENTITY_INVALID')
  }
  const identity = readTableIdentity(table)
  if (
    identity.account !== input.account ||
    identity.region !== input.region ||
    identity.name !== input.tableName
  ) {
    throw new WorkItemsIntegrityFailure(
      identity.account !== input.account
        ? 'ACCOUNT_MISMATCH'
        : identity.region !== input.region
          ? 'REGION_MISMATCH'
          : 'TABLE_IDENTITY_INVALID',
    )
  }

  const backupOutput = await input.reader.describeContinuousBackups(input.tableName)
  const ttlOutput = await input.reader.describeTimeToLive(input.tableName)
  const descriptor = readTableDescriptor(table, ttlOutput)
  const pitr = readPitrState(backupOutput, input.role)
  const restore = readRestoreSummary(table, input.role)
  const startedAt = toCanonicalTimestamp(now())
  const scan = await scanWorkItemsTable(input.reader, input.tableName, input.digestKey)
  const completedAt = toCanonicalTimestamp(now())

  const unsigned: UnsignedWorkItemsIntegrityManifest = {
    kind: MANIFEST_KIND,
    manifestVersion: MANIFEST_VERSION,
    role: input.role,
    workItemSchemaVersion: WORK_ITEM_SCHEMA_VERSION,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    requested: {
      account: input.account,
      region: input.region,
      tableName: input.tableName,
      profile: input.profile,
    },
    observed: {
      callerAccount,
      tableArn: identity.arn,
      tableId: identity.id,
      tableCreationTime: identity.creationTime,
    },
    descriptor,
    pitr,
    restore,
    scan: {
      captureContext,
      startedAt,
      completedAt,
      consistentRead: true,
      snapshotIsolation: false,
      pageCount: scan.pageCount,
      itemCount: scan.itemCount,
      logicalPartitionCount: scan.logicalPartitionCount,
    },
    digest: {
      algorithm: DIGEST_ALGORITHM,
      version: DIGEST_VERSION,
      keyFingerprint: calculateKeyFingerprint(input.digestKey),
      keySetDigest: scan.keySetDigest,
      contentDigest: scan.contentDigest,
    },
  }

  return {
    ...unsigned,
    manifestMac: calculateManifestMac(unsigned, input.digestKey),
  }
}

/**
 * Compares two authenticated manifests without reading AWS or tenant data.
 *
 * @param source - Source manifest.
 * @param restore - Isolated restore manifest.
 * @param digestKey - 32-byte key used when both manifests were created.
 * @returns Exact comparison result with stable failure categories.
 */
export function compareWorkItemsIntegrityManifests(
  source: WorkItemsIntegrityManifest,
  restore: WorkItemsIntegrityManifest,
  digestKey: Uint8Array,
): WorkItemsIntegrityComparison {
  validateDigestKey(digestKey)
  const failures = new Set<WorkItemsIntegrityFailureCode>()
  if (!verifyManifestMac(source, digestKey) || !verifyManifestMac(restore, digestKey)) {
    failures.add('MANIFEST_AUTHENTICATION_FAILED')
  }
  if (
    source.digest.keyFingerprint !== calculateKeyFingerprint(digestKey) ||
    restore.digest.keyFingerprint !== calculateKeyFingerprint(digestKey)
  ) {
    failures.add('KEY_FINGERPRINT_MISMATCH')
  }
  if (source.role !== 'source' || restore.role !== 'restore') {
    failures.add('MANIFEST_ROLE_MISMATCH')
  }
  if (source.scan.captureContext !== 'writer-fenced') {
    failures.add('SOURCE_NOT_WRITER_FENCED')
  }
  if (
    source.requested.account !== restore.requested.account ||
    source.observed.callerAccount !== restore.observed.callerAccount
  ) {
    failures.add('ACCOUNT_MISMATCH')
  }
  if (source.requested.region !== restore.requested.region) {
    failures.add('REGION_MISMATCH')
  }
  if (stableJson(source.descriptor) !== stableJson(restore.descriptor)) {
    failures.add('DESCRIPTOR_MISMATCH')
  }
  if (!restore.restore || restore.restore.sourceTableArn !== source.observed.tableArn) {
    failures.add('RESTORE_SOURCE_MISMATCH')
  }
  if (source.observed.tableId === restore.observed.tableId) {
    failures.add('TABLE_ID_REUSED')
  }
  if (restore.restore && restore.restore.restoreInProgress) {
    failures.add('RESTORE_IN_PROGRESS')
  }
  if (!isRestorePointInsideSourceWindow(source, restore)) {
    failures.add('RESTORE_POINT_OUTSIDE_WINDOW')
  }
  if (source.scan.itemCount !== restore.scan.itemCount) {
    failures.add('ITEM_COUNT_MISMATCH')
  }
  if (source.scan.logicalPartitionCount !== restore.scan.logicalPartitionCount) {
    failures.add('PARTITION_COUNT_MISMATCH')
  }
  if (source.digest.keySetDigest !== restore.digest.keySetDigest) {
    failures.add('KEY_SET_DIGEST_MISMATCH')
  }
  if (source.digest.contentDigest !== restore.digest.contentDigest) {
    failures.add('CONTENT_DIGEST_MISMATCH')
  }

  const failureCodes = [...failures].sort()
  return {
    status: failureCodes.length === 0 ? 'pass' : 'fail',
    failureCodes,
  }
}

/**
 * Parses an untrusted JSON value into the strict manifest schema.
 *
 * @param value - Parsed JSON value.
 * @returns Validated manifest.
 */
export function parseWorkItemsIntegrityManifest(value: unknown): WorkItemsIntegrityManifest {
  const manifest = requireRecord(value)
  requireExactKeys(manifest, [
    'descriptor',
    'digest',
    'kind',
    'manifestMac',
    'manifestVersion',
    'observed',
    'pitr',
    'requested',
    'restore',
    'role',
    'scan',
    'workflowSchemaVersion',
    'workItemSchemaVersion',
  ])
  if (
    manifest.kind !== MANIFEST_KIND ||
    manifest.manifestVersion !== MANIFEST_VERSION ||
    manifest.workItemSchemaVersion !== WORK_ITEM_SCHEMA_VERSION ||
    manifest.workflowSchemaVersion !== WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  ) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }

  const role = readRole(manifest.role)
  const requested = parseManifestRequest(manifest.requested)
  const observed = parseObservedTable(manifest.observed)
  const descriptor = parseTableDescriptor(manifest.descriptor)
  const pitr = parsePitrState(manifest.pitr)
  const restore = manifest.restore === null ? null : parseRestoreSummary(manifest.restore)
  const scan = parseScanEvidence(manifest.scan)
  const digest = parseDigestEvidence(manifest.digest)
  const manifestMac = readHexDigest(manifest.manifestMac)
  if (
    role === 'source' && scan.captureContext === 'isolated-restore' ||
    role === 'restore' && scan.captureContext !== 'isolated-restore' ||
    role === 'source' && restore !== null ||
    role === 'restore' && restore === null
  ) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }

  return {
    kind: MANIFEST_KIND,
    manifestVersion: MANIFEST_VERSION,
    role,
    workItemSchemaVersion: WORK_ITEM_SCHEMA_VERSION,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    requested,
    observed,
    descriptor,
    pitr,
    restore,
    scan,
    digest,
    manifestMac,
  }
}

/**
 * Resolves the capture context and rejects ambiguous role configuration.
 *
 * @param role - Manifest role.
 * @param sourceConsistency - Optional source isolation declaration.
 * @returns Role-specific capture context.
 */
function readCaptureContext(
  role: WorkItemsIntegrityRole,
  sourceConsistency: SourceCaptureConsistency | undefined,
): WorkItemsScanEvidence['captureContext'] {
  if (role === 'source') {
    if (sourceConsistency === 'writer-fenced' || sourceConsistency === 'live-observation') {
      return sourceConsistency
    }
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  if (sourceConsistency !== undefined) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  return 'isolated-restore'
}

/**
 * Reads and validates immutable DynamoDB table identity.
 *
 * @param table - DescribeTable payload.
 * @returns Parsed immutable identity.
 */
function readTableIdentity(table: TableDescription): TableIdentity {
  if (
    !isNonEmptyString(table.TableArn) ||
    !isNonEmptyString(table.TableId) ||
    !isNonEmptyString(table.TableName) ||
    !table.CreationDateTime
  ) {
    throw new WorkItemsIntegrityFailure('TABLE_IDENTITY_INVALID')
  }
  const arnParts = table.TableArn.split(':')
  if (
    arnParts.length !== 6 ||
    arnParts[0] !== 'arn' ||
    arnParts[2] !== 'dynamodb' ||
    !isRegion(arnParts[3]) ||
    !isAwsAccount(arnParts[4]) ||
    !arnParts[5]?.startsWith('table/')
  ) {
    throw new WorkItemsIntegrityFailure('TABLE_IDENTITY_INVALID')
  }
  const name = arnParts[5].slice('table/'.length)
  if (!isNonEmptyString(name) || name !== table.TableName) {
    throw new WorkItemsIntegrityFailure('TABLE_IDENTITY_INVALID')
  }
  return {
    arn: table.TableArn,
    account: arnParts[4],
    region: arnParts[3],
    name,
    id: table.TableId,
    creationTime: toCanonicalTimestamp(table.CreationDateTime),
  }
}

/**
 * Validates and normalizes the complete Work Items table descriptor.
 *
 * @param table - DescribeTable payload.
 * @param ttlOutput - DescribeTimeToLive payload.
 * @returns Normalized descriptor.
 */
function readTableDescriptor(
  table: TableDescription,
  ttlOutput: DescribeTimeToLiveCommandOutput,
): WorkItemsTableDescriptor {
  if (table.TableStatus !== 'ACTIVE') {
    throw new WorkItemsIntegrityFailure('TABLE_NOT_ACTIVE')
  }
  if ((table.LocalSecondaryIndexes?.length ?? 0) !== 0) {
    throw new WorkItemsIntegrityFailure('LOCAL_SECONDARY_INDEX_UNEXPECTED')
  }
  const attributes = (table.AttributeDefinitions ?? [])
    .map((attribute) => ({
      name: attribute.AttributeName ?? '',
      type: attribute.AttributeType ?? '',
    }))
    .sort((left, right) => compareUtf8Ordinal(left.name, right.name))
  if (stableJson(attributes) !== stableJson(expectedAttributeDefinitions)) {
    throw new WorkItemsIntegrityFailure('ATTRIBUTE_DEFINITION_MISMATCH')
  }
  const baseKey = normalizeKeySchema(table.KeySchema)
  if (stableJson(baseKey) !== stableJson(expectedBaseKey)) {
    throw new WorkItemsIntegrityFailure('BASE_KEY_MISMATCH')
  }
  const globalSecondaryIndexes = (table.GlobalSecondaryIndexes ?? [])
    .map(normalizeGlobalSecondaryIndex)
    .sort((left, right) => compareUtf8Ordinal(left.name, right.name))
  if (stableJson(globalSecondaryIndexes) !== stableJson(expectedGlobalSecondaryIndexes)) {
    throw new WorkItemsIntegrityFailure('GLOBAL_SECONDARY_INDEX_MISMATCH')
  }
  if (table.BillingModeSummary?.BillingMode !== 'PAY_PER_REQUEST') {
    throw new WorkItemsIntegrityFailure('BILLING_MODE_MISMATCH')
  }
  if (ttlOutput.TimeToLiveDescription?.TimeToLiveStatus !== 'DISABLED') {
    throw new WorkItemsIntegrityFailure('TTL_STATE_MISMATCH')
  }

  return {
    baseKey,
    billingMode: 'PAY_PER_REQUEST',
    encryption: readEncryption(table),
    globalSecondaryIndexes,
    ttlStatus: 'DISABLED',
  }
}

/**
 * Normalizes one DynamoDB key schema.
 *
 * @param schema - Untrusted key schema returned by DynamoDB.
 * @returns Ordered hash and range key descriptor.
 */
function normalizeKeySchema(
  schema: KeySchemaElement[] | undefined,
): WorkItemsKeyDescriptor[] {
  if (!schema || schema.length !== 2) {
    throw new WorkItemsIntegrityFailure('BASE_KEY_MISMATCH')
  }
  const normalized: WorkItemsKeyDescriptor[] = []
  for (const element of schema) {
    if (
      !isNonEmptyString(element.AttributeName) ||
      element.KeyType !== 'HASH' && element.KeyType !== 'RANGE'
    ) {
      throw new WorkItemsIntegrityFailure('BASE_KEY_MISMATCH')
    }
    normalized.push({
      name: element.AttributeName,
      type: element.KeyType,
    })
  }
  return normalized.sort((left, right) => keyTypeRank(left.type) - keyTypeRank(right.type))
}

/**
 * Returns a stable sort rank for a DynamoDB key role.
 *
 * @param type - DynamoDB key role.
 * @returns Sort rank.
 */
function keyTypeRank(type: WorkItemsKeyDescriptor['type']): number {
  return type === 'HASH' ? 0 : 1
}

/**
 * Validates and normalizes one global secondary index.
 *
 * @param index - DynamoDB index description.
 * @returns Normalized active ALL-projection descriptor.
 */
function normalizeGlobalSecondaryIndex(
  index: GlobalSecondaryIndexDescription,
): WorkItemsGlobalSecondaryIndexDescriptor {
  if (
    !isNonEmptyString(index.IndexName) ||
    index.IndexStatus !== 'ACTIVE' ||
    index.Projection?.ProjectionType !== 'ALL'
  ) {
    throw new WorkItemsIntegrityFailure('GLOBAL_SECONDARY_INDEX_MISMATCH')
  }
  return {
    name: index.IndexName,
    key: normalizeKeySchema(index.KeySchema),
    projection: 'ALL',
    status: 'ACTIVE',
  }
}

/**
 * Normalizes DynamoDB server-side encryption without exposing key ARNs.
 *
 * @param table - DescribeTable payload.
 * @returns Encryption family.
 */
function readEncryption(table: TableDescription): WorkItemsTableDescriptor['encryption'] {
  if (!table.SSEDescription) {
    return 'AWS_OWNED'
  }
  if (table.SSEDescription.Status !== 'ENABLED') {
    throw new WorkItemsIntegrityFailure('ENCRYPTION_STATE_INVALID')
  }
  if (table.SSEDescription.SSEType === 'KMS') {
    return 'KMS'
  }
  if (table.SSEDescription.SSEType === 'AES256') {
    return 'AWS_OWNED'
  }
  throw new WorkItemsIntegrityFailure('ENCRYPTION_STATE_INVALID')
}

/**
 * Validates point-in-time recovery state for the selected role.
 *
 * @param output - DescribeContinuousBackups payload.
 * @param role - Manifest role.
 * @returns Normalized PITR evidence.
 */
function readPitrState(
  output: DescribeContinuousBackupsCommandOutput,
  role: WorkItemsIntegrityRole,
): WorkItemsPitrState {
  const description = output.ContinuousBackupsDescription
  const recovery = description?.PointInTimeRecoveryDescription
  if (
    description?.ContinuousBackupsStatus !== 'ENABLED' ||
    recovery?.PointInTimeRecoveryStatus !== 'ENABLED' &&
      recovery?.PointInTimeRecoveryStatus !== 'DISABLED'
  ) {
    throw new WorkItemsIntegrityFailure('PITR_SOURCE_NOT_READY')
  }
  if (recovery.PointInTimeRecoveryStatus === 'DISABLED') {
    if (role === 'source') {
      throw new WorkItemsIntegrityFailure('PITR_SOURCE_NOT_READY')
    }
    return {
      status: 'DISABLED',
      earliestRestorableTime: null,
      latestRestorableTime: null,
    }
  }
  if (!recovery.EarliestRestorableDateTime || !recovery.LatestRestorableDateTime) {
    throw new WorkItemsIntegrityFailure('PITR_SOURCE_NOT_READY')
  }
  return {
    status: 'ENABLED',
    earliestRestorableTime: toCanonicalTimestamp(recovery.EarliestRestorableDateTime),
    latestRestorableTime: toCanonicalTimestamp(recovery.LatestRestorableDateTime),
  }
}

/**
 * Reads required DynamoDB restore provenance.
 *
 * @param table - DescribeTable payload.
 * @param role - Manifest role.
 * @returns Restore summary for restore manifests, otherwise null.
 */
function readRestoreSummary(
  table: TableDescription,
  role: WorkItemsIntegrityRole,
): WorkItemsRestoreSummary | null {
  if (role === 'source') {
    return null
  }
  const summary = table.RestoreSummary
  if (
    !summary ||
    !isNonEmptyString(summary.SourceTableArn) ||
    !summary.RestoreDateTime
  ) {
    throw new WorkItemsIntegrityFailure('RESTORE_SUMMARY_MISSING')
  }
  if (summary.RestoreInProgress !== false) {
    throw new WorkItemsIntegrityFailure('RESTORE_IN_PROGRESS')
  }
  return {
    sourceTableArn: summary.SourceTableArn,
    restoreDateTime: toCanonicalTimestamp(summary.RestoreDateTime),
    restoreInProgress: false,
  }
}

/**
 * Scans every base-table row and builds order-independent keyed aggregates.
 *
 * @param reader - Read-only AWS port.
 * @param tableName - Explicit physical table name.
 * @param digestKey - In-memory HMAC key.
 * @returns Exact secret-free aggregate.
 */
async function scanWorkItemsTable(
  reader: WorkItemsIntegrityReadPort,
  tableName: string,
  digestKey: Uint8Array,
): Promise<ScanAggregate> {
  const digests: Buffer[] = []
  const partitionDigests = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: Record<string, AttributeValue> | undefined
  let pageCount = 0
  let invalidCount = 0
  let scannedItemCount = 0

  do {
    if (pageCount >= MAX_SCAN_PAGES) {
      throw new WorkItemsIntegrityFailure('INTEGRITY_LIMIT_EXCEEDED')
    }
    const page = await reader.scanPage(tableName, cursor)
    pageCount += 1
    for (const item of page.Items ?? []) {
      if (scannedItemCount >= MAX_SCAN_ITEMS) {
        throw new WorkItemsIntegrityFailure('INTEGRITY_LIMIT_EXCEEDED')
      }
      scannedItemCount += 1
      try {
        if (!hasCanonicalPhysicalWorkItemShape(item)) {
          invalidCount += 1
          continue
        }
        const decoded = decodeAttributeMap(item)
        if (!isCanonicalWorkItemRecord(decoded)) {
          invalidCount += 1
          continue
        }
        const primaryKey = readPrimaryKey(item)
        const canonicalKey = canonicalizeAttributeMap(primaryKey)
        const canonicalItem = canonicalizeAttributeMap(item)
        const keyDigest = keyedDigest(digestKey, 'primary-key-v1', canonicalKey)
        const itemDigest = keyedDigest(digestKey, 'full-item-v1', canonicalItem)
        const partitionDigest = keyedDigest(
          digestKey,
          'logical-partition-v1',
          canonicalizeAttributeValue(item.directoryTeamId),
        )
        digests.push(Buffer.concat([keyDigest, itemDigest]))
        partitionDigests.add(partitionDigest.toString('hex'))
      } catch (error: unknown) {
        if (error instanceof WorkItemsIntegrityFailure) {
          invalidCount += 1
          continue
        }
        throw error
      }
    }

    cursor = page.LastEvaluatedKey
    if (cursor) {
      const cursorFingerprint = keyedDigest(
        digestKey,
        'scan-cursor-v1',
        canonicalizeAttributeMap(cursor),
      ).toString('hex')
      if (seenCursors.has(cursorFingerprint)) {
        throw new WorkItemsIntegrityFailure('CURSOR_LOOP')
      }
      seenCursors.add(cursorFingerprint)
    }
  } while (cursor)

  if (invalidCount > 0) {
    throw new WorkItemsIntegrityFailure('INVALID_WORK_ITEM_RECORD')
  }
  digests.sort(Buffer.compare)
  for (let index = 1; index < digests.length; index += 1) {
    const previous = digests[index - 1]?.subarray(0, DIGEST_BYTE_LENGTH)
    const current = digests[index]?.subarray(0, DIGEST_BYTE_LENGTH)
    if (previous && current && previous.equals(current)) {
      throw new WorkItemsIntegrityFailure('DUPLICATE_PRIMARY_KEY')
    }
  }

  const keySetHmac = createDomainHmac(digestKey, 'key-set-aggregate-v1')
  const contentHmac = createDomainHmac(digestKey, 'content-aggregate-v1')
  const count = Buffer.from(`${digests.length}\n`, 'utf8')
  keySetHmac.update(count)
  contentHmac.update(count)
  for (const digest of digests) {
    keySetHmac.update(digest.subarray(0, DIGEST_BYTE_LENGTH))
    contentHmac.update(digest)
  }

  return {
    pageCount,
    itemCount: digests.length,
    logicalPartitionCount: partitionDigests.size,
    keySetDigest: keySetHmac.digest('hex'),
    contentDigest: contentHmac.digest('hex'),
  }
}

/**
 * Extracts the raw DynamoDB primary key without decoding tenant identifiers.
 *
 * @param item - Raw DynamoDB item.
 * @returns Raw primary key map.
 */
function readPrimaryKey(
  item: Record<string, AttributeValue>,
): Record<string, AttributeValue> {
  const directoryTeamId = item.directoryTeamId
  const issueId = item.issueId
  if (
    !directoryTeamId ||
    !issueId ||
    !isStringAttributeValue(directoryTeamId) ||
    !isStringAttributeValue(issueId)
  ) {
    throw new WorkItemsIntegrityFailure('INVALID_WORK_ITEM_RECORD')
  }
  return { directoryTeamId, issueId }
}

/**
 * Checks whether an unknown DynamoDB value is exactly a string attribute.
 *
 * @param value - Raw attribute value.
 * @returns True for one valid S member.
 */
function isStringAttributeValue(value: unknown): value is AttributeValue.SMember {
  if (!isRecord(value)) {
    return false
  }
  return Object.keys(value).length === 1 && typeof value.S === 'string'
}

/**
 * Checks whether all known Work Item fields use their canonical DynamoDB AttributeValue types.
 *
 * @param item - Raw low-level DynamoDB item.
 * @returns True when scalar, map, and list fields retain their canonical physical encoding.
 */
function hasCanonicalPhysicalWorkItemShape(
  item: Record<string, AttributeValue>,
): boolean {
  return requiredStringAttributeNames.every((name) => isStringAttributeValue(item[name])) &&
    optionalStringAttributeNames.every((name) =>
      item[name] === undefined || isStringAttributeValue(item[name])
    ) &&
    requiredNumberAttributeNames.every((name) => isNumberAttributeValue(item[name])) &&
    isCanonicalCustomFieldValuesAttribute(item.customFieldValues) &&
    isStringListAttributeValue(item.relationIds) &&
    isMapAttributeValue(item.schedule)
}

/**
 * Checks whether an unknown DynamoDB value is exactly one valid number attribute.
 *
 * @param value - Raw attribute value.
 * @returns True for one canonical low-level number member.
 */
function isNumberAttributeValue(value: unknown): value is AttributeValue.NMember {
  if (!isRecord(value)) {
    return false
  }
  return Object.keys(value).length === 1 &&
    typeof value.N === 'string' &&
    isDynamoNumber(value.N)
}

/**
 * Checks whether a custom-field map preserves scalar values and string arrays without sets.
 *
 * @param value - Raw customFieldValues attribute.
 * @returns True for one map whose values use S, N, BOOL, or L-of-S encoding.
 */
function isCanonicalCustomFieldValuesAttribute(value: unknown): boolean {
  if (!isMapAttributeValue(value)) {
    return false
  }
  return Object.values(value.M).every((fieldValue) =>
    isStringAttributeValue(fieldValue) ||
    isNumberAttributeValue(fieldValue) ||
    isBooleanAttributeValue(fieldValue) ||
    isStringListAttributeValue(fieldValue)
  )
}

/**
 * Checks whether an unknown DynamoDB value is exactly one map attribute.
 *
 * @param value - Raw attribute value.
 * @returns True for one low-level map member.
 */
function isMapAttributeValue(value: unknown): value is AttributeValue.MMember {
  if (!isRecord(value)) {
    return false
  }
  return Object.keys(value).length === 1 && isRecord(value.M)
}

/**
 * Checks whether an unknown DynamoDB value is exactly one boolean attribute.
 *
 * @param value - Raw attribute value.
 * @returns True for one low-level boolean member.
 */
function isBooleanAttributeValue(value: unknown): value is AttributeValue.BOOLMember {
  if (!isRecord(value)) {
    return false
  }
  return Object.keys(value).length === 1 && typeof value.BOOL === 'boolean'
}

/**
 * Checks whether an unknown DynamoDB value is exactly one list containing only strings.
 *
 * @param value - Raw attribute value.
 * @returns True for one low-level L member whose children are all S members.
 */
function isStringListAttributeValue(value: unknown): value is AttributeValue.LMember {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.L)) {
    return false
  }
  return value.L.every(isStringAttributeValue)
}

/**
 * Produces a lossless canonical representation of one DynamoDB item map.
 *
 * @param value - Raw DynamoDB attribute map.
 * @returns Type-tagged deterministic representation.
 */
function canonicalizeAttributeMap(value: Record<string, AttributeValue>): string {
  const entries = Object.entries(value)
    .sort(([left], [right]) => compareUtf8Ordinal(left, right))
    .map(([name, attribute]) =>
      encodeNode('entry', `${encodeNode('name', name)}${canonicalizeAttributeValue(attribute)}`)
    )
  return encodeNode('map', `${entries.length}:${entries.join('')}`)
}

/**
 * Produces a lossless canonical representation of one untrusted AttributeValue.
 *
 * @param value - Raw attribute value.
 * @returns Type-tagged deterministic representation.
 */
function canonicalizeAttributeValue(value: unknown): string {
  const attribute = requireSingleAttributeValue(value)
  if (typeof attribute.S === 'string') {
    return encodeNode('S', attribute.S)
  }
  if (typeof attribute.N === 'string' && isDynamoNumber(attribute.N)) {
    return encodeNode('N', attribute.N)
  }
  if (attribute.B instanceof Uint8Array) {
    return encodeNode('B', Buffer.from(attribute.B).toString('base64'))
  }
  if (Array.isArray(attribute.SS) && attribute.SS.every((entry) => typeof entry === 'string')) {
    return canonicalizeSet('SS', attribute.SS)
  }
  if (
    Array.isArray(attribute.NS) &&
    attribute.NS.every((entry) => typeof entry === 'string' && isDynamoNumber(entry))
  ) {
    return canonicalizeSet('NS', attribute.NS)
  }
  if (
    Array.isArray(attribute.BS) &&
    attribute.BS.every((entry) => entry instanceof Uint8Array)
  ) {
    return canonicalizeSet(
      'BS',
      attribute.BS.map((entry) => Buffer.from(entry).toString('base64')),
    )
  }
  if (isRecord(attribute.M)) {
    const entries = Object.entries(attribute.M)
      .sort(([left], [right]) => compareUtf8Ordinal(left, right))
      .map(([name, child]) =>
        encodeNode('entry', `${encodeNode('name', name)}${canonicalizeAttributeValue(child)}`)
      )
    return encodeNode('M', `${entries.length}:${entries.join('')}`)
  }
  if (Array.isArray(attribute.L)) {
    const values = attribute.L.map(canonicalizeAttributeValue)
    return encodeNode('L', `${values.length}:${values.join('')}`)
  }
  if (attribute.NULL === true) {
    return encodeNode('NULL', 'true')
  }
  if (typeof attribute.BOOL === 'boolean') {
    return encodeNode('BOOL', attribute.BOOL ? 'true' : 'false')
  }
  throw new WorkItemsIntegrityFailure('INVALID_WORK_ITEM_RECORD')
}

/**
 * Validates that an AttributeValue contains exactly one supported type member.
 *
 * @param value - Untrusted value.
 * @returns Runtime-validated attribute record.
 */
function requireSingleAttributeValue(value: unknown): Record<string, unknown> {
  const record = requireRecord(value)
  const keys = Object.keys(record)
  if (
    keys.length !== 1 ||
    ![
      'B',
      'BOOL',
      'BS',
      'L',
      'M',
      'N',
      'NS',
      'NULL',
      'S',
      'SS',
    ].includes(keys[0] ?? '')
  ) {
    throw new WorkItemsIntegrityFailure('INVALID_WORK_ITEM_RECORD')
  }
  return record
}

/**
 * Canonicalizes a DynamoDB set while rejecting duplicate or empty elements.
 *
 * @param tag - DynamoDB set type.
 * @param values - Losslessly encoded set values.
 * @returns Deterministic set representation.
 */
function canonicalizeSet(tag: 'BS' | 'NS' | 'SS', values: string[]): string {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new WorkItemsIntegrityFailure('INVALID_WORK_ITEM_RECORD')
  }
  const sorted = [...values].sort()
  return encodeNode(tag, `${sorted.length}:${sorted.map((value) => encodeNode('value', value)).join('')}`)
}

/**
 * Encodes one canonical node using UTF-8 byte length boundaries.
 *
 * @param tag - Stable node type.
 * @param payload - Canonical payload.
 * @returns Unambiguous encoded node.
 */
function encodeNode(tag: string, payload: string): string {
  return `${tag}:${Buffer.byteLength(payload, 'utf8')}:${payload}`
}

/**
 * Compares strings by their exact UTF-8 bytes without consulting the host locale.
 *
 * @param left - Left string.
 * @param right - Right string.
 * @returns Negative, zero, or positive ordering result.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * Checks the lexical DynamoDB number representation without converting precision.
 *
 * @param value - Raw DynamoDB number string.
 * @returns True when the representation is a finite decimal form.
 */
function isDynamoNumber(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
}

/**
 * Decodes a raw DynamoDB item into unknown JavaScript values for the shared row validator.
 *
 * @param value - Raw DynamoDB item.
 * @returns Decoded record.
 */
function decodeAttributeMap(
  value: Record<string, AttributeValue>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([name, attribute]) => [name, decodeAttributeValue(attribute)]),
  )
}

/**
 * Runtime-decodes one AttributeValue without losing data used by aggregate digests.
 *
 * @param value - Untrusted attribute value.
 * @returns Decoded JavaScript value for schema validation only.
 */
function decodeAttributeValue(value: unknown): unknown {
  const attribute = requireSingleAttributeValue(value)
  if (typeof attribute.S === 'string') {
    return attribute.S
  }
  if (typeof attribute.N === 'string' && isDynamoNumber(attribute.N)) {
    const number = Number(attribute.N)
    if (!Number.isFinite(number)) {
      throw new WorkItemsIntegrityFailure('INVALID_WORK_ITEM_RECORD')
    }
    return number
  }
  if (attribute.B instanceof Uint8Array) {
    return Buffer.from(attribute.B)
  }
  if (Array.isArray(attribute.SS) && attribute.SS.every((entry) => typeof entry === 'string')) {
    return [...attribute.SS]
  }
  if (
    Array.isArray(attribute.NS) &&
    attribute.NS.every((entry) => typeof entry === 'string' && isDynamoNumber(entry))
  ) {
    const numbers = attribute.NS.map(Number)
    if (!numbers.every(Number.isFinite)) {
      throw new WorkItemsIntegrityFailure('INVALID_WORK_ITEM_RECORD')
    }
    return numbers
  }
  if (
    Array.isArray(attribute.BS) &&
    attribute.BS.every((entry) => entry instanceof Uint8Array)
  ) {
    return attribute.BS.map((entry) => Buffer.from(entry))
  }
  if (isRecord(attribute.M)) {
    return Object.fromEntries(
      Object.entries(attribute.M).map(([name, child]) => [name, decodeAttributeValue(child)]),
    )
  }
  if (Array.isArray(attribute.L)) {
    return attribute.L.map(decodeAttributeValue)
  }
  if (attribute.NULL === true) {
    return null
  }
  if (typeof attribute.BOOL === 'boolean') {
    return attribute.BOOL
  }
  throw new WorkItemsIntegrityFailure('INVALID_WORK_ITEM_RECORD')
}

/**
 * Creates a domain-separated keyed digest.
 *
 * @param key - 32-byte digest key.
 * @param domain - Versioned digest domain.
 * @param payload - Canonical payload.
 * @returns 32-byte digest.
 */
function keyedDigest(key: Uint8Array, domain: string, payload: string): Buffer {
  const hmac = createDomainHmac(key, domain)
  hmac.update(payload, 'utf8')
  return hmac.digest()
}

/**
 * Creates an HMAC initialized with an unambiguous versioned domain.
 *
 * @param key - 32-byte digest key.
 * @param domain - Versioned digest domain.
 * @returns Initialized HMAC.
 */
function createDomainHmac(key: Uint8Array, domain: string) {
  const hmac = createHmac('sha256', key)
  hmac.update(encodeNode('domain', `mukuroji-work-items-integrity/${domain}`), 'utf8')
  return hmac
}

/**
 * Calculates the non-secret fingerprint for a digest key.
 *
 * @param key - 32-byte digest key.
 * @returns Hex-encoded fingerprint.
 */
function calculateKeyFingerprint(key: Uint8Array): string {
  return keyedDigest(key, 'key-fingerprint-v1', 'manifest-key').toString('hex')
}

/**
 * Calculates the manifest MAC over every unsigned field.
 *
 * @param manifest - Unsigned manifest.
 * @param key - 32-byte digest key.
 * @returns Hex-encoded manifest MAC.
 */
function calculateManifestMac(
  manifest: UnsignedWorkItemsIntegrityManifest,
  key: Uint8Array,
): string {
  return keyedDigest(key, 'manifest-mac-v1', stableJson(manifest)).toString('hex')
}

/**
 * Authenticates a manifest using constant-time digest comparison.
 *
 * @param manifest - Signed manifest.
 * @param key - 32-byte digest key.
 * @returns True when the manifest is authentic.
 */
function verifyManifestMac(
  manifest: WorkItemsIntegrityManifest,
  key: Uint8Array,
): boolean {
  const expected = calculateManifestMac(toUnsignedManifest(manifest), key)
  if (!isHexDigest(manifest.manifestMac)) {
    return false
  }
  return timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(manifest.manifestMac, 'hex'),
  )
}

/**
 * Removes the MAC field through explicit reconstruction.
 *
 * @param manifest - Signed manifest.
 * @returns Unsigned fields.
 */
function toUnsignedManifest(
  manifest: WorkItemsIntegrityManifest,
): UnsignedWorkItemsIntegrityManifest {
  return {
    kind: manifest.kind,
    manifestVersion: manifest.manifestVersion,
    role: manifest.role,
    workItemSchemaVersion: manifest.workItemSchemaVersion,
    workflowSchemaVersion: manifest.workflowSchemaVersion,
    requested: manifest.requested,
    observed: manifest.observed,
    descriptor: manifest.descriptor,
    pitr: manifest.pitr,
    restore: manifest.restore,
    scan: manifest.scan,
    digest: manifest.digest,
  }
}

/**
 * Serializes JSON-compatible data with recursively sorted object keys.
 *
 * @param value - JSON-compatible value.
 * @returns Deterministic JSON text.
 */
function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
}

/**
 * Checks whether the restore point is covered by the source PITR window.
 *
 * @param source - Source manifest.
 * @param restore - Restore manifest.
 * @returns True when the restore timestamp is inside the signed source window.
 */
function isRestorePointInsideSourceWindow(
  source: WorkItemsIntegrityManifest,
  restore: WorkItemsIntegrityManifest,
): boolean {
  if (
    source.pitr.status !== 'ENABLED' ||
    !source.pitr.earliestRestorableTime ||
    !source.pitr.latestRestorableTime ||
    !restore.restore
  ) {
    return false
  }
  const restoreTime = Date.parse(restore.restore.restoreDateTime)
  return restoreTime >= Date.parse(source.pitr.earliestRestorableTime) &&
    restoreTime <= Date.parse(source.pitr.latestRestorableTime)
}

/**
 * Parses the manifest role.
 *
 * @param value - Untrusted role.
 * @returns Valid role.
 */
function readRole(value: unknown): WorkItemsIntegrityRole {
  if (value === 'source' || value === 'restore') {
    return value
  }
  throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
}

/**
 * Parses explicit request evidence.
 *
 * @param value - Untrusted request object.
 * @returns Validated request evidence.
 */
function parseManifestRequest(value: unknown): WorkItemsManifestRequest {
  const request = requireRecord(value)
  requireExactKeys(request, ['account', 'profile', 'region', 'tableName'])
  const account = readNonEmptyString(request.account)
  const region = readNonEmptyString(request.region)
  if (!isAwsAccount(account) || !isRegion(region)) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  return {
    account,
    profile: readNonEmptyString(request.profile),
    region,
    tableName: readNonEmptyString(request.tableName),
  }
}

/**
 * Parses observed immutable table identity.
 *
 * @param value - Untrusted observed identity.
 * @returns Validated identity evidence.
 */
function parseObservedTable(value: unknown): WorkItemsObservedTable {
  const observed = requireRecord(value)
  requireExactKeys(observed, [
    'callerAccount',
    'tableArn',
    'tableCreationTime',
    'tableId',
  ])
  const callerAccount = readNonEmptyString(observed.callerAccount)
  if (!isAwsAccount(callerAccount)) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  return {
    callerAccount,
    tableArn: readNonEmptyString(observed.tableArn),
    tableCreationTime: readCanonicalTimestamp(observed.tableCreationTime),
    tableId: readNonEmptyString(observed.tableId),
  }
}

/**
 * Parses and revalidates a normalized table descriptor.
 *
 * @param value - Untrusted descriptor.
 * @returns Validated descriptor.
 */
function parseTableDescriptor(value: unknown): WorkItemsTableDescriptor {
  const descriptor = requireRecord(value)
  requireExactKeys(descriptor, [
    'baseKey',
    'billingMode',
    'encryption',
    'globalSecondaryIndexes',
    'ttlStatus',
  ])
  if (
    descriptor.billingMode !== 'PAY_PER_REQUEST' ||
    descriptor.ttlStatus !== 'DISABLED' ||
    descriptor.encryption !== 'AWS_OWNED' && descriptor.encryption !== 'KMS'
  ) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  const baseKey = parseKeyDescriptors(descriptor.baseKey)
  const globalSecondaryIndexes = parseGlobalSecondaryIndexes(
    descriptor.globalSecondaryIndexes,
  )
  if (
    stableJson(baseKey) !== stableJson(expectedBaseKey) ||
    stableJson(globalSecondaryIndexes) !== stableJson(expectedGlobalSecondaryIndexes)
  ) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  return {
    baseKey,
    billingMode: 'PAY_PER_REQUEST',
    encryption: descriptor.encryption,
    globalSecondaryIndexes,
    ttlStatus: 'DISABLED',
  }
}

/**
 * Parses an ordered key descriptor array.
 *
 * @param value - Untrusted key descriptor array.
 * @returns Validated key descriptors.
 */
function parseKeyDescriptors(value: unknown): WorkItemsKeyDescriptor[] {
  if (!Array.isArray(value)) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  return value.map((entry) => {
    const descriptor = requireRecord(entry)
    requireExactKeys(descriptor, ['name', 'type'])
    if (descriptor.type !== 'HASH' && descriptor.type !== 'RANGE') {
      throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
    }
    return {
      name: readNonEmptyString(descriptor.name),
      type: descriptor.type,
    }
  })
}

/**
 * Parses the complete global secondary index list.
 *
 * @param value - Untrusted index list.
 * @returns Validated index descriptors.
 */
function parseGlobalSecondaryIndexes(
  value: unknown,
): WorkItemsGlobalSecondaryIndexDescriptor[] {
  if (!Array.isArray(value)) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  return value.map((entry) => {
    const index = requireRecord(entry)
    requireExactKeys(index, ['key', 'name', 'projection', 'status'])
    if (index.projection !== 'ALL' || index.status !== 'ACTIVE') {
      throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
    }
    return {
      name: readNonEmptyString(index.name),
      key: parseKeyDescriptors(index.key),
      projection: 'ALL',
      status: 'ACTIVE',
    }
  })
}

/**
 * Parses point-in-time recovery evidence.
 *
 * @param value - Untrusted PITR evidence.
 * @returns Validated PITR state.
 */
function parsePitrState(value: unknown): WorkItemsPitrState {
  const pitr = requireRecord(value)
  requireExactKeys(pitr, [
    'earliestRestorableTime',
    'latestRestorableTime',
    'status',
  ])
  if (pitr.status === 'DISABLED') {
    if (pitr.earliestRestorableTime !== null || pitr.latestRestorableTime !== null) {
      throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
    }
    return {
      status: 'DISABLED',
      earliestRestorableTime: null,
      latestRestorableTime: null,
    }
  }
  if (pitr.status !== 'ENABLED') {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  const earliestRestorableTime = readCanonicalTimestamp(pitr.earliestRestorableTime)
  const latestRestorableTime = readCanonicalTimestamp(pitr.latestRestorableTime)
  if (Date.parse(earliestRestorableTime) > Date.parse(latestRestorableTime)) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  return {
    status: 'ENABLED',
    earliestRestorableTime,
    latestRestorableTime,
  }
}

/**
 * Parses DynamoDB restore provenance.
 *
 * @param value - Untrusted restore summary.
 * @returns Validated restore summary.
 */
function parseRestoreSummary(value: unknown): WorkItemsRestoreSummary {
  const restore = requireRecord(value)
  requireExactKeys(restore, [
    'restoreDateTime',
    'restoreInProgress',
    'sourceTableArn',
  ])
  if (restore.restoreInProgress !== false) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  return {
    restoreDateTime: readCanonicalTimestamp(restore.restoreDateTime),
    restoreInProgress: false,
    sourceTableArn: readNonEmptyString(restore.sourceTableArn),
  }
}

/**
 * Parses secret-free scan evidence.
 *
 * @param value - Untrusted scan evidence.
 * @returns Validated scan evidence.
 */
function parseScanEvidence(value: unknown): WorkItemsScanEvidence {
  const scan = requireRecord(value)
  requireExactKeys(scan, [
    'captureContext',
    'completedAt',
    'consistentRead',
    'itemCount',
    'logicalPartitionCount',
    'pageCount',
    'snapshotIsolation',
    'startedAt',
  ])
  if (
    scan.captureContext !== 'writer-fenced' &&
    scan.captureContext !== 'live-observation' &&
    scan.captureContext !== 'isolated-restore' ||
    scan.consistentRead !== true ||
    scan.snapshotIsolation !== false
  ) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  const startedAt = readCanonicalTimestamp(scan.startedAt)
  const completedAt = readCanonicalTimestamp(scan.completedAt)
  const pageCount = readNonNegativeInteger(scan.pageCount)
  const itemCount = readNonNegativeInteger(scan.itemCount)
  const logicalPartitionCount = readNonNegativeInteger(scan.logicalPartitionCount)
  if (
    pageCount < 1 ||
    logicalPartitionCount > itemCount ||
    Date.parse(startedAt) > Date.parse(completedAt)
  ) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  return {
    captureContext: scan.captureContext,
    completedAt,
    consistentRead: true,
    itemCount,
    logicalPartitionCount,
    pageCount,
    snapshotIsolation: false,
    startedAt,
  }
}

/**
 * Parses aggregate digest evidence.
 *
 * @param value - Untrusted digest evidence.
 * @returns Validated aggregate digests.
 */
function parseDigestEvidence(value: unknown): WorkItemsDigestEvidence {
  const digest = requireRecord(value)
  requireExactKeys(digest, [
    'algorithm',
    'contentDigest',
    'keyFingerprint',
    'keySetDigest',
    'version',
  ])
  if (digest.algorithm !== DIGEST_ALGORITHM || digest.version !== DIGEST_VERSION) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  return {
    algorithm: DIGEST_ALGORITHM,
    version: DIGEST_VERSION,
    keyFingerprint: readHexDigest(digest.keyFingerprint),
    keySetDigest: readHexDigest(digest.keySetDigest),
    contentDigest: readHexDigest(digest.contentDigest),
  }
}

/**
 * Validates a 32-byte in-memory digest key.
 *
 * @param key - Candidate digest key.
 */
function validateDigestKey(key: Uint8Array): void {
  if (key.byteLength !== DIGEST_BYTE_LENGTH) {
    throw new WorkItemsIntegrityFailure('DIGEST_KEY_INVALID')
  }
}

/**
 * Reads a canonical lowercase SHA-256 hex digest.
 *
 * @param value - Untrusted digest.
 * @returns Validated digest.
 */
function readHexDigest(value: unknown): string {
  if (typeof value === 'string' && isHexDigest(value)) {
    return value
  }
  throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
}

/**
 * Checks a canonical lowercase SHA-256 hex digest.
 *
 * @param value - Candidate digest.
 * @returns True for exactly 32 bytes of lowercase hex.
 */
function isHexDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

/**
 * Reads a non-empty trimmed string.
 *
 * @param value - Untrusted value.
 * @returns Validated string.
 */
function readNonEmptyString(value: unknown): string {
  if (isNonEmptyString(value)) {
    return value
  }
  throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
}

/**
 * Checks a non-empty trimmed string.
 *
 * @param value - Untrusted value.
 * @returns True for a non-empty canonical string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim()
}

/**
 * Reads a non-negative safe integer.
 *
 * @param value - Untrusted value.
 * @returns Validated integer.
 */
function readNonNegativeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value
  }
  throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
}

/**
 * Reads a canonical UTC ISO timestamp.
 *
 * @param value - Untrusted timestamp.
 * @returns Canonical timestamp.
 */
function readCanonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
  return value
}

/**
 * Converts a Date into a canonical timestamp and rejects invalid clocks.
 *
 * @param value - Date to serialize.
 * @returns Canonical UTC timestamp.
 */
function toCanonicalTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new WorkItemsIntegrityFailure('TABLE_IDENTITY_INVALID')
  }
  return value.toISOString()
}

/**
 * Returns the current wall-clock time.
 *
 * @returns Current Date.
 */
function currentTime(): Date {
  return new Date()
}

/**
 * Requires a plain non-array object.
 *
 * @param value - Untrusted value.
 * @returns Record view after runtime validation.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value
  }
  throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
}

/**
 * Checks a plain non-array object.
 *
 * @param value - Untrusted value.
 * @returns True for a non-null object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rejects omitted or extra object fields.
 *
 * @param value - Object to validate.
 * @param expectedKeys - Exact sorted-independent key set.
 */
function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: string[],
): void {
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (stableJson(actual) !== stableJson(expected)) {
    throw new WorkItemsIntegrityFailure('INVALID_MANIFEST')
  }
}

/**
 * Checks a 12-digit AWS account identifier.
 *
 * @param value - Candidate account identifier.
 * @returns True for a canonical AWS account.
 */
function isAwsAccount(value: string): boolean {
  return /^\d{12}$/.test(value)
}

/**
 * Checks a conventional AWS region identifier.
 *
 * @param value - Candidate region.
 * @returns True for a bounded AWS region name.
 */
function isRegion(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+){2,5}$/u.test(value)
}
