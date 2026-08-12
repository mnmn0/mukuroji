import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  parseCrossDomainIntegrityResourceIdentities,
  type CrossDomainIntegrityResourceIdentity,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import {
  parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection,
  type WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection,
} from './migration-rehearsal-integrity-rate-evidence'

/** Exact operator acknowledgement required before runtime fault rehearsal. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL =
  'acknowledge-non-production-migration-runtime-fault-rehearsal'

/** Only deployment environment accepted by the rehearsal boundary. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE =
  'non-production'

/** CDK-owned tag key proving the selected journal belongs to non-production. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY =
  'mukuroji:workspace-search-migration-environment'

/** CDK-owned tag key carrying the reviewed deployment trust-root digest. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY =
  'mukuroji:workspace-search-migration-deployment-trust-root'

/** CDK-owned tag key carrying only a digest of the production account. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY =
  'mukuroji:workspace-search-migration-production-account-sha256'

/** Domain shared with CDK for the protected production-account digest. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_DOMAIN =
  'mukuroji-workspace-search-migration-production-account/v1\0'

/** Stable authenticated permit discriminator. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND =
  'workspace-search-migration-rehearsal-permit'

/** First authenticated non-production rehearsal permit schema. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION = 1

/** Maximum reviewed non-production full-suite permit validity window. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_MAXIMUM_AGE_MILLISECONDS =
  72 * 60 * 60 * 1_000

/** Stable failure raised without reflecting permit or resource values. */
export class WorkspaceSearchMigrationRehearsalPermitError extends Error {
  /** Stable machine-readable rehearsal guard failure. */
  readonly code = 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED'

  /** Creates one raw-value-free permit failure. */
  constructor() {
    super('NON_PRODUCTION_REHEARSAL_GUARD_FAILED')
    this.name = 'WorkspaceSearchMigrationRehearsalPermitError'
  }
}

/** Authenticated claims binding one short-lived rehearsal authorization. */
export type WorkspaceSearchMigrationRehearsalPermitClaims = {
  /** Stable permit document discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND
  /** Permit schema version. */
  readonly permitVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION
  /** Exact non-production stage acknowledgement. */
  readonly stage: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
  /** Exact runtime-fault rehearsal approval phrase. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL
  /** Isolated non-production AWS account selected by the permit. */
  readonly account: string
  /** Production account that must remain different and unreachable. */
  readonly productionAccount: string
  /** Exact AWS Region selected by the permit. */
  readonly region: string
  /** Exact STS assumed-role caller ARN authorized for the run. */
  readonly callerArn: string
  /** Exact reviewed Git commit containing the rehearsal implementation. */
  readonly commit: string
  /** Source-controlled non-production deployment target identifier. */
  readonly deploymentTargetId: string
  /** Source-controlled CDK deployment trust root selected for the run. */
  readonly deploymentTrustRootDigest: string
  /** Digest binding every operator-selected migration resource. */
  readonly requestedResourcesBinding: string
  /** Reviewed pre-known hash reproduced by root configuration measurement. */
  readonly configurationBindingDigest: string
  /** Reviewed durable DescribeTable policy digest used by every segment. */
  readonly policyVersion: string
  /** Fixed immutable-incarnation scheme used by the #163 resource vector. */
  readonly integrityResourceIdentityScheme:
    typeof CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  /** Canonical seven-entry keyed immutable physical-resource vector. */
  readonly integrityResourceIdentities:
    readonly CrossDomainIntegrityResourceIdentity[]
  /** Authenticated #163 physical resource-identity digest. */
  readonly integrityResourceIdentityDigest: string
  /** SHA-256 digest binding the approved evidence authentication key. */
  readonly evidenceKeyDigest: string
  /** SHA-256 digest binding the parent-only publication authentication key. */
  readonly publicationKeyDigest: string
  /** Authenticated minimal ordinal-zero root copied transitively downstream. */
  readonly integrityAttestationRoot:
    WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection
  /** Canonical permit issuance time. */
  readonly issuedAt: string
  /** Canonical exclusive permit expiry time. */
  readonly expiresAt: string
}

/** Serialized authenticated permit stored only in restricted operator state. */
export type WorkspaceSearchMigrationRehearsalPermit =
  WorkspaceSearchMigrationRehearsalPermitClaims & {
    /** HMAC-SHA-256 authenticating the exact canonical claims. */
    readonly permitMac: string
  }

/** Expected trusted bindings supplied by the selected migration request. */
export type VerifyWorkspaceSearchMigrationRehearsalPermitInput = {
  /** Untrusted serialized or in-memory permit. */
  readonly permit: unknown
  /** Dedicated 32-byte in-memory permit verification key. */
  readonly verificationKey: Uint8Array
  /** Expected non-production AWS account. */
  readonly account: string
  /** Expected AWS Region. */
  readonly region: string
  /** Expected reviewed Git commit. */
  readonly commit: string
  /** Expected digest of every requested physical resource. */
  readonly requestedResourcesBinding: string
  /** Trusted current time used for the short-lived validity check. */
  readonly currentTime: Date
}

/** Input used by a protected change process to issue one reviewed permit. */
export type CreateWorkspaceSearchMigrationRehearsalPermitInput = {
  /** Exact claims reviewed by the change owner. */
  readonly claims: WorkspaceSearchMigrationRehearsalPermitClaims
  /** Dedicated 32-byte in-memory permit signing key. */
  readonly signingKey: Uint8Array
}

/** Inputs fixing the main rehearsal resource-attestation digest. */
export type CreateWorkspaceSearchMigrationRehearsalResourceAttestationDigestInput = {
  /** Exact measured six-table configuration digest. */
  readonly configurationHash: string
  /** Source-controlled deployment trust-root digest. */
  readonly deploymentTrustRootDigest: string
  /** Private production account that remains unreachable. */
  readonly productionAccount: string
  /** Digest of the exact requested main migration resources. */
  readonly requestedResourcesBinding: string
}

/** Fixed canonical permit claim fields in serialization order. */
const permitClaimKeys = Object.freeze([
  'account',
  'approval',
  'callerArn',
  'commit',
  'configurationBindingDigest',
  'deploymentTargetId',
  'deploymentTrustRootDigest',
  'evidenceKeyDigest',
  'expiresAt',
  'integrityResourceIdentityDigest',
  'integrityResourceIdentities',
  'integrityResourceIdentityScheme',
  'integrityAttestationRoot',
  'issuedAt',
  'kind',
  'permitVersion',
  'productionAccount',
  'publicationKeyDigest',
  'policyVersion',
  'region',
  'requestedResourcesBinding',
  'stage',
])

/** Exact serialized permit fields including authentication. */
const permitKeys = Object.freeze([
  ...permitClaimKeys,
  'permitMac',
])

/** HMAC domain separating permits from every other evidence contract. */
const permitMacDomain =
  'mukuroji-workspace-search-migration-rehearsal-permit/v1\0'

/** Exact length of one permit HMAC key. */
const permitKeyByteLength = 32

/** Strict guards converting every malformed value to one stable failure. */
const permitGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failPermit,
)

/**
 * Creates one canonical authenticated permit for a protected change process.
 *
 * @param input - Reviewed claims and dedicated signing key.
 * @returns Detached permit including its canonical HMAC.
 */
export function createWorkspaceSearchMigrationRehearsalPermit(
  input: CreateWorkspaceSearchMigrationRehearsalPermitInput,
): WorkspaceSearchMigrationRehearsalPermit {
  let claims: unknown
  let signingKey: unknown
  try {
    claims = input.claims
    signingKey = input.signingKey
  } catch {
    return failPermit()
  }
  const normalizedClaims = readPermitClaims(claims)
  const key = copyPermitKey(signingKey)
  try {
    return Object.freeze({
      ...normalizedClaims,
      permitMac: createPermitMac(normalizedClaims, key),
    })
  } finally {
    key.fill(0)
  }
}

/**
 * Authenticates and validates one short-lived non-production permit.
 *
 * The returned claims still contain restricted account and role bindings and
 * therefore must not be written to external rehearsal evidence.
 *
 * @param input - Untrusted permit, key, expected request, and trusted time.
 * @returns Frozen authenticated claims matching the selected resources.
 */
export function verifyWorkspaceSearchMigrationRehearsalPermit(
  input: VerifyWorkspaceSearchMigrationRehearsalPermitInput,
): Readonly<WorkspaceSearchMigrationRehearsalPermitClaims> {
  let permit: unknown
  let verificationKey: unknown
  let account: unknown
  let region: unknown
  let commit: unknown
  let requestedResourcesBinding: unknown
  let currentTime: unknown
  try {
    permit = input.permit
    verificationKey = input.verificationKey
    account = input.account
    region = input.region
    commit = input.commit
    requestedResourcesBinding = input.requestedResourcesBinding
    currentTime = input.currentTime
  } catch {
    return failPermit()
  }
  const record = permitGuards.requireRecord(permit)
  permitGuards.requireExactKeys(record, permitKeys)
  const claims = readPermitClaims(record)
  const permitMac = permitGuards.readDigest(
    permitGuards.readOwn(record, 'permitMac'),
  )
  const key = copyPermitKey(verificationKey)
  try {
    const expectedMac = createPermitMac(claims, key)
    if (!safeDigestEqual(permitMac, expectedMac)) return failPermit()
  } finally {
    key.fill(0)
  }
  const currentTimeMilliseconds = readCurrentTime(currentTime)
  const issuedAtMilliseconds = Date.parse(claims.issuedAt)
  const expiresAtMilliseconds = Date.parse(claims.expiresAt)
  if (
    claims.account !== account ||
    claims.region !== region ||
    claims.commit !== commit ||
    claims.requestedResourcesBinding !== requestedResourcesBinding ||
    claims.account === claims.productionAccount ||
    currentTimeMilliseconds < issuedAtMilliseconds ||
    currentTimeMilliseconds >= expiresAtMilliseconds ||
    expiresAtMilliseconds - issuedAtMilliseconds >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_MAXIMUM_AGE_MILLISECONDS
  ) {
    return failPermit()
  }
  return Object.freeze({ ...claims })
}

/**
 * Reads exact permit claims without retaining caller-owned objects.
 *
 * @param value - Candidate claims or complete permit record.
 * @returns Detached validated claims.
 */
function readPermitClaims(
  value: unknown,
): WorkspaceSearchMigrationRehearsalPermitClaims {
  const record = permitGuards.requireRecord(value)
  const keys = Object.keys(record)
  if (keys.includes('permitMac')) {
    permitGuards.requireExactKeys(record, permitKeys)
  } else {
    permitGuards.requireExactKeys(record, permitClaimKeys)
  }
  const kind = permitGuards.readOwn(record, 'kind')
  const permitVersion = permitGuards.readOwn(record, 'permitVersion')
  const stage = permitGuards.readOwn(record, 'stage')
  const approval = permitGuards.readOwn(record, 'approval')
  if (
    kind !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND ||
    permitVersion !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION ||
    stage !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE ||
    approval !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL
  ) {
    return failPermit()
  }
  const account = readAccount(permitGuards.readOwn(record, 'account'))
  const productionAccount = readAccount(
    permitGuards.readOwn(record, 'productionAccount'),
  )
  const region = readRegion(permitGuards.readOwn(record, 'region'))
  const callerArn = readCallerArn(
    permitGuards.readOwn(record, 'callerArn'),
    account,
  )
  const commit = readCommit(permitGuards.readOwn(record, 'commit'))
  const deploymentTargetId = readDeploymentTargetId(
    permitGuards.readOwn(record, 'deploymentTargetId'),
  )
  const deploymentTrustRootDigest = permitGuards.readDigest(
    permitGuards.readOwn(record, 'deploymentTrustRootDigest'),
  )
  const requestedResourcesBinding = permitGuards.readDigest(
    permitGuards.readOwn(record, 'requestedResourcesBinding'),
  )
  const configurationBindingDigest = permitGuards.readDigest(
    permitGuards.readOwn(record, 'configurationBindingDigest'),
  )
  const policyVersion = permitGuards.readDigest(
    permitGuards.readOwn(record, 'policyVersion'),
  )
  const integrityResourceIdentityScheme = permitGuards.readOwn(
    record,
    'integrityResourceIdentityScheme',
  )
  if (
    integrityResourceIdentityScheme !==
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  ) {
    return failPermit()
  }
  const integrityResourceIdentities = readPermitResourceIdentities(
    permitGuards.readOwn(record, 'integrityResourceIdentities'),
  )
  const integrityResourceIdentityDigest = permitGuards.readDigest(
    permitGuards.readOwn(record, 'integrityResourceIdentityDigest'),
  )
  const evidenceKeyDigest = permitGuards.readDigest(
    permitGuards.readOwn(record, 'evidenceKeyDigest'),
  )
  const publicationKeyDigest = permitGuards.readDigest(
    permitGuards.readOwn(record, 'publicationKeyDigest'),
  )
  const integrityAttestationRoot =
    readPermitIntegrityAttestationRoot(
      permitGuards.readOwn(record, 'integrityAttestationRoot'),
    )
  const issuedAt = permitGuards.readTimestamp(
    permitGuards.readOwn(record, 'issuedAt'),
  )
  const expiresAt = permitGuards.readTimestamp(
    permitGuards.readOwn(record, 'expiresAt'),
  )
  if (
    account === productionAccount ||
    evidenceKeyDigest === publicationKeyDigest ||
    integrityAttestationRoot.deploymentTargetId !== deploymentTargetId ||
    integrityAttestationRoot.productionAccountDigest !==
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        productionAccount,
      ) ||
    integrityAttestationRoot.configurationBindingDigest !==
      configurationBindingDigest ||
    integrityAttestationRoot.policyVersion !== policyVersion ||
    Date.parse(integrityAttestationRoot.completedAt) >
      Date.parse(issuedAt) ||
    Date.parse(expiresAt) <= Date.parse(issuedAt) ||
    Date.parse(expiresAt) - Date.parse(issuedAt) >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_MAXIMUM_AGE_MILLISECONDS
  ) {
    return failPermit()
  }
  return Object.freeze({
    kind,
    permitVersion,
    stage,
    approval,
    account,
    productionAccount,
    region,
    callerArn,
    commit,
    deploymentTargetId,
    deploymentTrustRootDigest,
    requestedResourcesBinding,
    configurationBindingDigest,
    policyVersion,
    integrityResourceIdentityScheme,
    integrityResourceIdentities,
    integrityResourceIdentityDigest,
    evidenceKeyDigest,
    publicationKeyDigest,
    integrityAttestationRoot,
    issuedAt,
    expiresAt,
  })
}

/** Reads one detached canonical resource-identity vector with permit failures. */
function readPermitResourceIdentities(
  value: unknown,
): readonly CrossDomainIntegrityResourceIdentity[] {
  try {
    return parseCrossDomainIntegrityResourceIdentities(value)
  } catch {
    return failPermit()
  }
}

/** Reads one strict signed minimal root projection with permit failures. */
function readPermitIntegrityAttestationRoot(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection {
  try {
    return parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection(
      value,
    )
  } catch {
    return failPermit()
  }
}

/**
 * Derives the exact CDK-compatible digest of a private production account.
 *
 * @param account - Exact validated twelve-digit production account.
 * @returns Domain-separated lowercase SHA-256 digest.
 */
export function createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
  account: string,
): string {
  return createHash('sha256')
    .update(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_DOMAIN,
      'utf8',
    )
    .update(readAccount(account), 'utf8')
    .digest('hex')
}

/**
 * Derives the exact secret-free main-session resource attestation.
 *
 * This helper is shared by measured session publication and alarm-purpose
 * permit issuance so an alarm plan cannot restate a different main resource
 * session while preserving the same account, commit, or caller.
 *
 * @param input - Exact measured configuration and reviewed deployment claims.
 * @returns Domain-separated lowercase SHA-256 digest.
 */
export function createWorkspaceSearchMigrationRehearsalResourceAttestationDigest(
  input: CreateWorkspaceSearchMigrationRehearsalResourceAttestationDigestInput,
): string {
  const record = permitGuards.requireRecord(input)
  permitGuards.requireExactKeys(record, [
    'configurationHash',
    'deploymentTrustRootDigest',
    'productionAccount',
    'requestedResourcesBinding',
  ])
  const configurationHash = permitGuards.readDigest(
    permitGuards.readOwn(record, 'configurationHash'),
  )
  const deploymentTrustRootDigest = permitGuards.readDigest(
    permitGuards.readOwn(record, 'deploymentTrustRootDigest'),
  )
  const productionAccount = readAccount(
    permitGuards.readOwn(record, 'productionAccount'),
  )
  const requestedResourcesBinding = permitGuards.readDigest(
    permitGuards.readOwn(record, 'requestedResourcesBinding'),
  )
  return createMigrationDigest({
    configurationHash,
    deploymentTrustRootDigest,
    environmentTag: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    productionAccountDigest:
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        productionAccount,
      ),
    requestedResourcesBinding,
  })
}

/**
 * Creates the HMAC over one exact canonical claims document.
 *
 * @param claims - Detached strict permit claims.
 * @param key - Invocation-local 32-byte key copy.
 * @returns Lowercase HMAC-SHA-256.
 */
function createPermitMac(
  claims: WorkspaceSearchMigrationRehearsalPermitClaims,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(permitMacDomain, 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/**
 * Copies one ordinary exact-length Uint8Array key through intrinsic methods.
 *
 * @param value - Candidate signing or verification key.
 * @returns Detached key bytes that the caller cannot mutate during use.
 */
function copyPermitKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    permitGuards.readIntrinsicByteLength(value) !== permitKeyByteLength
  ) {
    return failPermit()
  }
  try {
    const copied: unknown = Reflect.apply(
      Uint8Array.prototype.slice,
      value,
      [],
    )
    if (
      !(copied instanceof Uint8Array) ||
      copied.byteLength !== permitKeyByteLength
    ) {
      return failPermit()
    }
    return copied
  } catch {
    return failPermit()
  }
}

/** Reads one exact twelve-digit AWS account identifier. */
function readAccount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{12}$/u.test(value)) {
    return failPermit()
  }
  return value
}

/** Reads one exact source-controlled deployment target identifier. */
function readDeploymentTargetId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9-]{0,62}$/u.test(value)
  ) return failPermit()
  return value
}

/** Reads one explicit standard AWS Region identifier. */
function readRegion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[1-9][0-9]*$/u.test(value)
  ) {
    return failPermit()
  }
  return value
}

/** Reads one exact lowercase Git commit OID. */
function readCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    return failPermit()
  }
  return value
}

/** Reads one exact STS assumed-role ARN in the permitted account. */
function readCallerArn(value: unknown, account: string): string {
  if (typeof value !== 'string') return failPermit()
  const match = /^arn:(?:aws|aws-us-gov|aws-cn):sts::(\d{12}):assumed-role\/[A-Za-z0-9+=,.@_-]{1,64}\/[A-Za-z0-9+=,.@_-]{1,64}$/u.exec(
    value,
  )
  if (match?.[1] !== account) return failPermit()
  return value
}

/** Reads trusted current time without accepting invalid Date instances. */
function readCurrentTime(value: unknown): number {
  let timestamp: unknown
  try {
    timestamp = Date.prototype.toISOString.call(value)
  } catch {
    return failPermit()
  }
  if (!isCanonicalTimestamp(timestamp)) return failPermit()
  return Date.parse(timestamp)
}

/** Compares two fixed-size lowercase digests without timing leakage. */
function safeDigestEqual(left: string, right: string): boolean {
  if (!isHexDigest(left) || !isHexDigest(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Raises the sole raw-value-free permit failure. */
function failPermit(): never {
  throw new WorkspaceSearchMigrationRehearsalPermitError()
}
