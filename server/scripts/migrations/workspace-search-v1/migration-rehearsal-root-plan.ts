import { Buffer } from 'node:buffer'
import { types as nodeUtilTypes } from 'node:util'
import {
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
  CROSS_DOMAIN_INTEGRITY_MAX_DURATION_MILLISECONDS,
} from '../../data-integrity/cross-domain-integrity'
import type {
  CrossDomainIntegrityTableNames,
} from '../../data-integrity/cross-domain-integrity-aws-types'
import { serializeCanonicalJson } from './migration-contract'
import {
  resolveWorkspaceSearchMigrationRehearsalDeploymentTarget,
} from './migration-deployment-targets'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  createWorkspaceSearchMigrationRequestedResourcesSnapshot,
  type WorkspaceSearchMigrationRequestedResourcesSnapshot,
} from './migration-identity'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Fixed discriminator for an owner-only pre-permit rehearsal root plan. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_KIND =
  'mukuroji-workspace-search-migration-rehearsal-root-plan'

/** Initial owner-only pre-permit rehearsal root-plan contract version. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_VERSION = 1

/** Exact human-reviewed approval admitted by the root-plan parser. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_APPROVAL =
  'bootstrap-reviewed-non-production-migration-rehearsal-root'

/** Maximum canonical UTF-8 size of one owner-only root-plan document. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_MAX_BYTES =
  64 * 1024

/** Maximum finite duration admitted for one complete rehearsal root. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_MAX_DURATION_MILLISECONDS =
  CROSS_DOMAIN_INTEGRITY_MAX_DURATION_MILLISECONDS

/** Stable raw-value-free error code for every invalid root plan. */
const invalidRootPlanCode = 'INVALID_REHEARSAL_ROOT_PLAN'

/** Exact logical order of the six cross-domain integrity tables. */
const integrityTableTargets = Object.freeze([
  'audit-events',
  'file-proofing',
  'project-directory',
  'work-item-configuration',
  'work-items',
  'workspace-access',
] satisfies readonly (keyof CrossDomainIntegrityTableNames)[])

/** Exact top-level owner-only root-plan fields. */
const rootPlanKeys = Object.freeze([
  'approval',
  'deploymentTargetId',
  'expectedCallerArn',
  'expectedConfigurationBindingDigest',
  'integrityResources',
  'kind',
  'maximumDurationMilliseconds',
  'requestedResources',
  'version',
])

/** Exact requested migration-resource fields. */
const requestedResourceKeys = Object.freeze([
  'account',
  'commit',
  'journalBucket',
  'journalKeyArn',
  'profile',
  'region',
  'tables',
])

/** Exact migration table-role fields. */
const requestedTableKeys = Object.freeze([
  'collaboration',
  'documents',
  'migration-state',
  'project-directory',
  'work-items',
  'workspace-search',
])

/** Exact integrity-resource fields. */
const integrityResourceKeys = Object.freeze([
  'fileBucket',
  'marker',
  'tables',
])

/** Exact integrity table-role fields. */
const integrityTableKeys = Object.freeze([
  'audit-events',
  'file-proofing',
  'project-directory',
  'work-item-configuration',
  'work-items',
  'workspace-access',
])

/** Exact immutable File bucket marker fields. */
const markerKeys = Object.freeze([
  'checksumSha256',
  'key',
  'size',
  'versionId',
])

/** Stable raw-value-free failure for an invalid owner-only root plan. */
export class WorkspaceSearchMigrationRehearsalRootPlanError extends Error {
  /** Stable machine-readable root-plan failure code. */
  readonly code = invalidRootPlanCode

  /** Creates the sole public root-plan validation failure. */
  constructor() {
    super(invalidRootPlanCode)
    this.name = 'WorkspaceSearchMigrationRehearsalRootPlanError'
  }
}

/** Exact immutable File bucket marker selected by the reviewed root plan. */
export type WorkspaceSearchMigrationRehearsalRootFileBucketMarker = {
  /** Fixed infrastructure-owned marker object key. */
  readonly key: typeof CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY
  /** Exact non-null immutable S3 object VersionId. */
  readonly versionId: string
  /** Exact canonical base64 SHA-256 checksum emitted by S3. */
  readonly checksumSha256: string
  /** Exact non-negative marker object size in bytes. */
  readonly size: number
}

/** Owner-only integrity resources selected for the rehearsal root. */
export type WorkspaceSearchMigrationRehearsalRootIntegrityResources = {
  /** Complete six-table physical-name map used by integrity checks. */
  readonly tables: CrossDomainIntegrityTableNames
  /** Exact physical File bucket name used by integrity checks. */
  readonly fileBucket: string
  /** Exact immutable marker incarnation for the File bucket. */
  readonly marker: WorkspaceSearchMigrationRehearsalRootFileBucketMarker
}

/** Canonical owner-only pre-permit rehearsal root-plan document. */
export type WorkspaceSearchMigrationRehearsalRootPlanDocument = {
  /** Fixed root-plan discriminator. */
  readonly kind: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_KIND
  /** Initial root-plan contract version. */
  readonly version: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_VERSION
  /** Exact reviewed non-production bootstrap approval. */
  readonly approval: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_APPROVAL
  /** Source-controlled enabled non-production deployment target identifier. */
  readonly deploymentTargetId: string
  /** Exact STS assumed-role caller ARN required for every root AWS read. */
  readonly expectedCallerArn: string
  /** Reviewed digest required of the measured migration configuration. */
  readonly expectedConfigurationBindingDigest: string
  /** Exact owner-only migration resource selection. */
  readonly requestedResources: WorkspaceSearchMigrationRequestedResourcesSnapshot
  /** Exact owner-only integrity resource selection. */
  readonly integrityResources:
    WorkspaceSearchMigrationRehearsalRootIntegrityResources
  /** Finite wall-clock bound shared by the complete rehearsal root. */
  readonly maximumDurationMilliseconds: number
}

/** Detached trusted root plan plus values derived at the validation boundary. */
export type WorkspaceSearchMigrationRehearsalRootPlan = {
  /** Detached and deeply frozen canonical owner-only plan document. */
  readonly document: WorkspaceSearchMigrationRehearsalRootPlanDocument
  /** Digest of the exact source-controlled deployment trust root. */
  readonly deploymentTrustRootDigest: string
  /** Domain-separated digest of the distinct production account. */
  readonly productionAccountDigest: string
  /** Digest binding the exact requested migration resources. */
  readonly requestedResourcesBinding: string
  /** Reviewed configuration digest required by the measured result. */
  readonly configurationBindingDigest: string
  /** Exact ten-name owner-only DescribeTable allowlist in canonical order. */
  readonly allowedDescribeTableNames: readonly string[]
}

/** Shared strict guards bound to this module's stable public failure. */
const strictGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failRootPlan,
)

/**
 * Strictly validates an in-memory owner-only pre-permit root plan.
 *
 * The deployment target is always resolved from the repository-owned target
 * map; callers cannot inject or replace that source of trust.
 *
 * @param value - Untrusted root-plan candidate.
 * @returns Detached and deeply frozen plan plus derived trust bindings.
 */
export function parseWorkspaceSearchMigrationRehearsalRootPlan(
  value: unknown,
): WorkspaceSearchMigrationRehearsalRootPlan {
  return atRootPlanBoundary(() => readRootPlan(value))
}

/**
 * Parses exact canonical UTF-8 bytes for an owner-only pre-permit root plan.
 *
 * @param bytes - Untrusted bounded canonical JSON bytes.
 * @returns Detached and deeply frozen plan plus derived trust bindings.
 */
export function parseWorkspaceSearchMigrationRehearsalRootPlanDocument(
  bytes: unknown,
): WorkspaceSearchMigrationRehearsalRootPlan {
  return atRootPlanBoundary(() => {
    const snapshot = copyBoundedBytes(bytes)
    const parsed = parseJson(snapshot)
    const plan = readRootPlan(parsed)
    const canonical = encodeDocument(plan.document)
    if (!equalBytes(snapshot, canonical)) {
      return failRootPlan()
    }
    return plan
  })
}

/**
 * Reads and detaches one strict root plan before deriving its trust bindings.
 *
 * @param value - Untrusted root-plan candidate.
 * @returns Detached and deeply frozen plan plus derived trust bindings.
 */
function readRootPlan(
  value: unknown,
): WorkspaceSearchMigrationRehearsalRootPlan {
  const record = requireOrdinaryRecord(value)
  strictGuards.requireExactKeys(record, rootPlanKeys)
  if (
    strictGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_KIND ||
    strictGuards.readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_VERSION ||
    strictGuards.readOwn(record, 'approval') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_APPROVAL
  ) {
    return failRootPlan()
  }

  const deploymentTargetId = readDeploymentTargetId(
    strictGuards.readOwn(record, 'deploymentTargetId'),
  )
  const expectedCaller = readExpectedCallerArn(
    strictGuards.readOwn(record, 'expectedCallerArn'),
  )
  const expectedConfigurationBindingDigest = strictGuards.readDigest(
    strictGuards.readOwn(record, 'expectedConfigurationBindingDigest'),
  )
  const requestedResources = readRequestedResources(
    strictGuards.readOwn(record, 'requestedResources'),
  )
  const integrityResources = readIntegrityResources(
    strictGuards.readOwn(record, 'integrityResources'),
  )
  const maximumDurationMilliseconds = readMaximumDurationMilliseconds(
    strictGuards.readOwn(record, 'maximumDurationMilliseconds'),
  )
  const target = resolveRehearsalTarget(deploymentTargetId)

  if (
    target.targetId !== deploymentTargetId ||
    requestedResources.account !== target.deploymentAccount ||
    requestedResources.region !== target.region ||
    expectedCaller.account !== target.deploymentAccount
  ) {
    return failRootPlan()
  }
  const allowedDescribeTableNames = bindDescribeTableNames(
    requestedResources,
    integrityResources.tables,
  )
  const requestedResourcesBinding =
    readRequestedResourcesBinding(requestedResources)
  const document = Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_VERSION,
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_APPROVAL,
    deploymentTargetId,
    expectedCallerArn: expectedCaller.arn,
    expectedConfigurationBindingDigest,
    requestedResources,
    integrityResources,
    maximumDurationMilliseconds,
  })

  return Object.freeze({
    document,
    deploymentTrustRootDigest: strictGuards.readDigest(target.digest),
    productionAccountDigest: strictGuards.readDigest(
      target.productionAccountDigest,
    ),
    requestedResourcesBinding,
    configurationBindingDigest: expectedConfigurationBindingDigest,
    allowedDescribeTableNames,
  })
}

/** Exact trusted target fields retained inside the parser boundary. */
type ResolvedRehearsalTarget = {
  /** Exact source-controlled deployment target identifier. */
  readonly targetId: string
  /** Exact non-production deployment account. */
  readonly deploymentAccount: string
  /** Exact selected AWS Region. */
  readonly region: string
  /** Exact deployment trust-root digest. */
  readonly digest: string
  /** Exact domain-separated production-account digest. */
  readonly productionAccountDigest: string
}

/**
 * Resolves one enabled target through the repository-owned production resolver.
 *
 * @param deploymentTargetId - Validated source-controlled target identifier.
 * @returns Detached target fields required by this parser.
 */
function resolveRehearsalTarget(
  deploymentTargetId: string,
): ResolvedRehearsalTarget {
  const target = resolveWorkspaceSearchMigrationRehearsalDeploymentTarget(
    deploymentTargetId,
  )
  return Object.freeze({
    targetId: target.targetId,
    deploymentAccount: target.deploymentAccount,
    region: target.region,
    digest: target.digest,
    productionAccountDigest: target.productionAccountDigest,
  })
}

/** Parsed STS assumed-role identity fields required by target binding. */
type ExpectedCaller = {
  /** Exact validated STS assumed-role ARN. */
  readonly arn: string
  /** Twelve-digit account encoded by the ARN. */
  readonly account: string
}

/**
 * Reads one exact STS assumed-role ARN without accepting other IAM identities.
 *
 * @param value - Untrusted caller ARN candidate.
 * @returns Exact ARN and its encoded AWS account.
 */
function readExpectedCallerArn(value: unknown): ExpectedCaller {
  if (typeof value !== 'string' || value.length > 2_048) {
    return failRootPlan()
  }
  const match = /^arn:aws(?:-[a-z0-9-]+)?:sts::(\d{12}):assumed-role\/[A-Za-z0-9_+=,.@-]{1,64}\/[A-Za-z0-9_+=,.@-]{2,64}$/u
    .exec(value)
  if (match === null || match[1] === undefined || match[1] === '000000000000') {
    return failRootPlan()
  }
  return Object.freeze({ arn: value, account: match[1] })
}

/**
 * Reads one conservative source-controlled deployment target identifier.
 *
 * @param value - Untrusted target identifier candidate.
 * @returns Exact validated identifier.
 */
function readDeploymentTargetId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9-]{0,62}$/u.test(value)
  ) {
    return failRootPlan()
  }
  return value
}

/**
 * Strictly reads and validates the exact migration resource selection.
 *
 * @param value - Untrusted requested-resource candidate.
 * @returns Detached and frozen migration resource snapshot.
 */
function readRequestedResources(
  value: unknown,
): WorkspaceSearchMigrationRequestedResourcesSnapshot {
  const record = requireOrdinaryRecord(value)
  strictGuards.requireExactKeys(record, requestedResourceKeys)
  const tableRecord = requireOrdinaryRecord(
    strictGuards.readOwn(record, 'tables'),
  )
  strictGuards.requireExactKeys(tableRecord, requestedTableKeys)
  const requested = {
    account: readAwsAccount(strictGuards.readOwn(record, 'account')),
    region: readAwsRegion(strictGuards.readOwn(record, 'region')),
    profile: readProfile(strictGuards.readOwn(record, 'profile')),
    commit: readCommit(strictGuards.readOwn(record, 'commit')),
    tables: {
      'project-directory': readTableName(
        strictGuards.readOwn(tableRecord, 'project-directory'),
      ),
      'work-items': readTableName(
        strictGuards.readOwn(tableRecord, 'work-items'),
      ),
      collaboration: readTableName(
        strictGuards.readOwn(tableRecord, 'collaboration'),
      ),
      documents: readTableName(
        strictGuards.readOwn(tableRecord, 'documents'),
      ),
      'workspace-search': readTableName(
        strictGuards.readOwn(tableRecord, 'workspace-search'),
      ),
      'migration-state': readTableName(
        strictGuards.readOwn(tableRecord, 'migration-state'),
      ),
    },
    journalBucket: readBucketName(
      strictGuards.readOwn(record, 'journalBucket'),
    ),
    journalKeyArn: readText(
      strictGuards.readOwn(record, 'journalKeyArn'),
    ),
  }
  try {
    return createWorkspaceSearchMigrationRequestedResourcesSnapshot(requested)
  } catch {
    return failRootPlan()
  }
}

/**
 * Creates the canonical requested-resource binding inside the stable boundary.
 *
 * @param requested - Detached validated requested-resource snapshot.
 * @returns Lowercase SHA-256 resource binding.
 */
function readRequestedResourcesBinding(
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
): string {
  try {
    return strictGuards.readDigest(
      createWorkspaceSearchMigrationRequestedResourcesBinding(requested),
    )
  } catch {
    return failRootPlan()
  }
}

/**
 * Strictly reads the exact owner-only cross-domain integrity resources.
 *
 * @param value - Untrusted integrity-resource candidate.
 * @returns Detached and deeply frozen integrity resources.
 */
function readIntegrityResources(
  value: unknown,
): WorkspaceSearchMigrationRehearsalRootIntegrityResources {
  const record = requireOrdinaryRecord(value)
  strictGuards.requireExactKeys(record, integrityResourceKeys)
  const tableRecord = requireOrdinaryRecord(
    strictGuards.readOwn(record, 'tables'),
  )
  strictGuards.requireExactKeys(tableRecord, integrityTableKeys)
  const markerRecord = requireOrdinaryRecord(
    strictGuards.readOwn(record, 'marker'),
  )
  strictGuards.requireExactKeys(markerRecord, markerKeys)
  if (
    strictGuards.readOwn(markerRecord, 'key') !==
      CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY
  ) {
    return failRootPlan()
  }
  const tables = Object.freeze({
    'audit-events': readTableName(
      strictGuards.readOwn(tableRecord, 'audit-events'),
    ),
    'file-proofing': readTableName(
      strictGuards.readOwn(tableRecord, 'file-proofing'),
    ),
    'project-directory': readTableName(
      strictGuards.readOwn(tableRecord, 'project-directory'),
    ),
    'work-item-configuration': readTableName(
      strictGuards.readOwn(tableRecord, 'work-item-configuration'),
    ),
    'work-items': readTableName(
      strictGuards.readOwn(tableRecord, 'work-items'),
    ),
    'workspace-access': readTableName(
      strictGuards.readOwn(tableRecord, 'workspace-access'),
    ),
  })
  const marker = Object.freeze({
    key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
    versionId: strictGuards.readVersionId(
      strictGuards.readOwn(markerRecord, 'versionId'),
    ),
    checksumSha256: readSha256Base64(
      strictGuards.readOwn(markerRecord, 'checksumSha256'),
    ),
    size: readNonNegativeSafeInteger(
      strictGuards.readOwn(markerRecord, 'size'),
    ),
  })
  return Object.freeze({
    tables,
    fileBucket: readBucketName(
      strictGuards.readOwn(record, 'fileBucket'),
    ),
    marker,
  })
}

/**
 * Binds both six-table maps to the required exact ten-name union.
 *
 * @param requested - Validated migration resource selection.
 * @param integrityTables - Validated integrity table map.
 * @returns Frozen exact ten-name owner-only DescribeTable allowlist.
 */
function bindDescribeTableNames(
  requested: WorkspaceSearchMigrationRequestedResourcesSnapshot,
  integrityTables: CrossDomainIntegrityTableNames,
): readonly string[] {
  if (
    requested.tables['project-directory'] !==
      integrityTables['project-directory'] ||
    requested.tables['work-items'] !== integrityTables['work-items']
  ) {
    return failRootPlan()
  }
  const migrationNames = [
    requested.tables['project-directory'],
    requested.tables['work-items'],
    requested.tables.collaboration,
    requested.tables.documents,
    requested.tables['workspace-search'],
    requested.tables['migration-state'],
  ]
  const integrityNames = integrityTableTargets.map(
    (target) => integrityTables[target],
  )
  if (
    new Set(migrationNames).size !== 6 ||
    new Set(integrityNames).size !== 6 ||
    new Set([...migrationNames, ...integrityNames]).size !== 10
  ) {
    return failRootPlan()
  }
  return Object.freeze([
    ...migrationNames,
    integrityTables['audit-events'],
    integrityTables['file-proofing'],
    integrityTables['work-item-configuration'],
    integrityTables['workspace-access'],
  ])
}

/**
 * Requires an ordinary own-data-only record.
 *
 * @param value - Untrusted record candidate.
 * @returns Validated ordinary record.
 */
function requireOrdinaryRecord(value: unknown): object {
  const record = strictGuards.requireRecord(value)
  if (Object.getPrototypeOf(record) !== Object.prototype) {
    return failRootPlan()
  }
  return record
}

/**
 * Reads one exact twelve-digit nonzero AWS account.
 *
 * @param value - Untrusted account candidate.
 * @returns Exact validated account identifier.
 */
function readAwsAccount(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{12}$/u.test(value) ||
    value === '000000000000'
  ) {
    return failRootPlan()
  }
  return value
}

/**
 * Reads one conservative explicit AWS Region identifier.
 *
 * @param value - Untrusted Region candidate.
 * @returns Exact validated Region identifier.
 */
function readAwsRegion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z]{2}(?:-gov)?-[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*$/u
      .test(value)
  ) {
    return failRootPlan()
  }
  return value
}

/**
 * Reads one explicit safe shared-configuration profile.
 *
 * @param value - Untrusted profile candidate.
 * @returns Exact validated profile.
 */
function readProfile(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)
  ) {
    return failRootPlan()
  }
  return value
}

/**
 * Reads one exact reviewed lowercase Git commit OID.
 *
 * @param value - Untrusted commit candidate.
 * @returns Exact validated 40-character OID.
 */
function readCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    return failRootPlan()
  }
  return value
}

/**
 * Reads one physical DynamoDB table name.
 *
 * @param value - Untrusted table-name candidate.
 * @returns Exact validated table name.
 */
function readTableName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_.-]{3,255}$/u.test(value)
  ) {
    return failRootPlan()
  }
  return value
}

/**
 * Reads one conventional general-purpose S3 bucket name.
 *
 * @param value - Untrusted bucket-name candidate.
 * @returns Exact validated bucket name.
 */
function readBucketName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value) ||
    value.includes('..') ||
    /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(value)
  ) {
    return failRootPlan()
  }
  const reservedPrefixes = ['xn--', 'sthree-', 'amzn_s3_demo_']
  const reservedSuffixes = [
    '-s3alias',
    '--ol-s3',
    '.mrap',
    '--x-s3',
    '--table-s3',
  ]
  if (
    reservedPrefixes.some((prefix) => value.startsWith(prefix)) ||
    reservedSuffixes.some((suffix) => value.endsWith(suffix))
  ) {
    return failRootPlan()
  }
  return value
}

/**
 * Reads one bounded nonempty text value.
 *
 * @param value - Untrusted text candidate.
 * @returns Exact validated text.
 */
function readText(value: unknown): string {
  return strictGuards.readText(value)
}

/**
 * Reads one canonical base64-encoded SHA-256 checksum.
 *
 * @param value - Untrusted checksum candidate.
 * @returns Exact canonical checksum.
 */
function readSha256Base64(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 44) {
    return failRootPlan()
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
    return failRootPlan()
  }
  return value
}

/**
 * Reads one non-negative safe integer.
 *
 * @param value - Untrusted numeric candidate.
 * @returns Exact validated integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failRootPlan()
  }
  return value
}

/**
 * Reads one positive finite duration within the complete root bound.
 *
 * @param value - Untrusted duration candidate.
 * @returns Exact validated duration in milliseconds.
 */
function readMaximumDurationMilliseconds(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_MAX_DURATION_MILLISECONDS
  ) {
    return failRootPlan()
  }
  return value
}

/**
 * Encodes one validated document into bounded canonical UTF-8 bytes.
 *
 * @param value - Validated canonical root-plan document.
 * @returns Exact canonical bytes.
 */
function encodeDocument(
  value: WorkspaceSearchMigrationRehearsalRootPlanDocument,
): Uint8Array {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(value))
  if (
    bytes.byteLength <= 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_MAX_BYTES
  ) {
    return failRootPlan()
  }
  return bytes
}

/**
 * Copies exact bounded non-shared Uint8Array bytes without retaining aliases.
 *
 * @param value - Untrusted byte-array candidate.
 * @returns Detached exact bytes.
 */
function copyBoundedBytes(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failRootPlan()
  }
  const buffer = strictGuards.readIntrinsicBuffer(value)
  const byteLength = strictGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_MAX_BYTES
  ) {
    return failRootPlan()
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
  } catch {
    return failRootPlan()
  }
  return copy
}

/**
 * Parses strict UTF-8 JSON without replacement characters.
 *
 * @param bytes - Detached bounded root-plan bytes.
 * @returns Untrusted parsed JSON value.
 */
function parseJson(bytes: Uint8Array): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failRootPlan()
  }
  try {
    return JSON.parse(text)
  } catch {
    return failRootPlan()
  }
}

/**
 * Compares two exact byte arrays without string normalization.
 *
 * @param left - First byte array.
 * @param right - Second byte array.
 * @returns Whether every byte is identical.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Runs one operation behind the stable raw-value-free root-plan boundary.
 *
 * @param operation - Validation operation that may inspect untrusted data.
 * @returns Exact successful operation result.
 */
function atRootPlanBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch {
    return failRootPlan()
  }
}

/**
 * Raises the sole stable raw-value-free root-plan failure.
 *
 * @returns Never; this function always throws.
 */
function failRootPlan(): never {
  throw new WorkspaceSearchMigrationRehearsalRootPlanError()
}
