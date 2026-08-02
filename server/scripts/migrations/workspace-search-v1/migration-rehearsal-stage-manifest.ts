import { createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  parseCrossDomainIntegrityResourceIdentities,
  type CrossDomainIntegrityResourceIdentity,
} from '../../data-integrity/cross-domain-integrity'
import {
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS,
  type WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Stable discriminator for a reviewed complete rehearsal stage manifest. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-manifest'

/** First reviewed complete rehearsal stage-manifest contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION = 1

/** Maximum accepted canonical bytes for a reviewed stage manifest. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES =
  64 * 1_024

/** Exact total stages fixed by all eight canonical reviewed scenarios. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES =
  36

/** Existing mutating control commands admitted by a reviewed stage manifest. */
export type WorkspaceSearchMigrationRehearsalStageCommand =
  | 'apply'
  | 'close-replan'
  | 'release'
  | 'rollback-complete'
  | 'rollback-partial'
  | 'verify'

/** Finite authenticated result of one reviewed process attempt. */
export type WorkspaceSearchMigrationRehearsalStageOutcome =
  | 'completed'
  | 'fault-reached'
  | 'response-loss-reconciled'
  | 'takeover-completed'

/** One exact stage selected by the reviewed complete manifest. */
export type WorkspaceSearchMigrationRehearsalStageManifestEntry = {
  /** Globally contiguous one-based stage ordinal. */
  readonly ordinal: number
  /** Canonical scenario owning this stage. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Contiguous one-based ordinal within the scenario. */
  readonly scenarioStageOrdinal: number
  /** Exact existing control command to execute. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Digest of the exact existing control argument vector. */
  readonly controlArgumentsDigest: string
  /** One-based process attempt ordinal within the scenario. */
  readonly attemptOrdinal: number
  /** Digest of an exact reviewed fault plan, or null for no fault. */
  readonly faultPlanDigest: string | null
  /** Expected authenticated attempt outcome. */
  readonly expectedOutcome: WorkspaceSearchMigrationRehearsalStageOutcome
}

/** Authenticated reviewed claims controlling all eight scenario stage chains. */
export type WorkspaceSearchMigrationRehearsalStageManifestClaims = {
  /** Fixed reviewed-manifest discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND
  /** Reviewed-manifest schema version. */
  readonly manifestVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION
  /** Fixed non-production environment. */
  readonly stage: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
  /** Exact reviewed implementation commit OID. */
  readonly commit: string
  /** Source-controlled CDK deployment trust root selected by the permit. */
  readonly deploymentTrustRootDigest: string
  /** Digest of the authenticated rehearsal permit. */
  readonly permitDigest: string
  /** Digest of the child-visible runtime evidence key. */
  readonly evidenceKeyDigest: string
  /** Digest of the parent-only lifecycle and publication key. */
  readonly publicationKeyDigest: string
  /** Requested-resource binding authenticated by the permit. */
  readonly requestedResourcesBinding: string
  /** Fixed immutable-incarnation scheme authenticated by the permit. */
  readonly integrityResourceIdentityScheme:
    typeof CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  /** Canonical seven-entry keyed immutable physical-resource vector. */
  readonly integrityResourceIdentities:
    readonly CrossDomainIntegrityResourceIdentity[]
  /** Authenticated #163 physical resource-identity digest. */
  readonly integrityResourceIdentityDigest: string
  /** Reviewed measured configuration binding. */
  readonly configurationBindingDigest: string
  /** Reviewed DescribeTable policy digest. */
  readonly policyVersion: string
  /** Canonical protected-review time. */
  readonly reviewedAt: string
  /** Explicit full stage sequence for all eight required scenarios. */
  readonly entries:
    readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[]
}

/** Complete authenticated reviewed stage manifest. */
export type WorkspaceSearchMigrationRehearsalStageManifest =
  WorkspaceSearchMigrationRehearsalStageManifestClaims & {
    /** HMAC-SHA-256 over the exact canonical manifest claims. */
    readonly manifestMac: string
  }

/** Input for a protected process creating one reviewed stage manifest. */
export type CreateWorkspaceSearchMigrationRehearsalStageManifestInput = {
  /** Exact reviewed manifest claims. */
  readonly claims: WorkspaceSearchMigrationRehearsalStageManifestClaims
  /** Main 32-byte rehearsal evidence authentication key. */
  readonly signingKey: Uint8Array
}

/** Authenticated selection returned before a reviewed child may be spawned. */
export type WorkspaceSearchMigrationRehearsalSelectedStage = {
  /** Exact authenticated reviewed manifest. */
  readonly manifest: WorkspaceSearchMigrationRehearsalStageManifest
  /** Digest of the exact authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Exact next detached reviewed entry. */
  readonly entry: WorkspaceSearchMigrationRehearsalStageManifestEntry
  /** Digest of the exact preceding receipt, or null for global stage one. */
  readonly previousStageReceiptDigest: string | null
}

/** Stable raw-value-free failure at the manifest or receipt trust boundary. */
export class WorkspaceSearchMigrationRehearsalStageReceiptError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'INVALID_REHEARSAL_STAGE_RECEIPT'

  /** Creates the sole public stage-manifest and stage-receipt failure. */
  constructor() {
    super('INVALID_REHEARSAL_STAGE_RECEIPT')
    this.name = 'WorkspaceSearchMigrationRehearsalStageReceiptError'
  }
}

/** Exact manifest claim fields. */
const manifestClaimKeys = Object.freeze([
  'commit',
  'configurationBindingDigest',
  'deploymentTrustRootDigest',
  'evidenceKeyDigest',
  'entries',
  'integrityResourceIdentityDigest',
  'integrityResourceIdentities',
  'integrityResourceIdentityScheme',
  'kind',
  'manifestVersion',
  'permitDigest',
  'policyVersion',
  'publicationKeyDigest',
  'requestedResourcesBinding',
  'reviewedAt',
  'stage',
])

/** Exact authenticated manifest fields. */
const manifestKeys = Object.freeze([...manifestClaimKeys, 'manifestMac'])

/** Exact manifest-entry fields. */
const manifestEntryKeys = Object.freeze([
  'attemptOrdinal',
  'command',
  'controlArgumentsDigest',
  'expectedOutcome',
  'faultPlanDigest',
  'ordinal',
  'scenario',
  'scenarioStageOrdinal',
])

/** HMAC domain separating reviewed manifests from all other evidence. */
const manifestMacDomain =
  'mukuroji-workspace-search-migration-rehearsal-stage-manifest/v1\0'

/** Exact main evidence-key length. */
const evidenceKeyByteLength = 32

/** Strict guards converting malformed input to the shared stable failure. */
const manifestGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failStageManifest,
)

/**
 * Creates one authenticated reviewed full-suite stage manifest.
 *
 * @param input - Reviewed complete claims and main evidence key.
 * @returns Frozen canonical authenticated manifest.
 */
export function createWorkspaceSearchMigrationRehearsalStageManifest(
  input: CreateWorkspaceSearchMigrationRehearsalStageManifestInput,
): WorkspaceSearchMigrationRehearsalStageManifest {
  let claims: unknown
  let signingKey: unknown
  try {
    claims = input.claims
    signingKey = input.signingKey
  } catch {
    return failStageManifest()
  }
  const normalizedClaims = readManifestClaims(claims)
  const key = copyEvidenceKey(signingKey)
  try {
    return Object.freeze({
      ...normalizedClaims,
      manifestMac: createManifestMac(normalizedClaims, key),
    })
  } finally {
    key.fill(0)
  }
}

/**
 * Authenticates and validates one explicit complete eight-scenario manifest.
 *
 * @param value - Untrusted serialized or in-memory manifest.
 * @param verificationKey - Main 32-byte rehearsal evidence key.
 * @returns Frozen detached authenticated manifest.
 */
export function verifyWorkspaceSearchMigrationRehearsalStageManifest(
  value: unknown,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageManifest {
  const record = manifestGuards.requireRecord(value)
  manifestGuards.requireExactKeys(record, manifestKeys)
  const claims = readManifestClaims(record)
  const manifestMac = manifestGuards.readDigest(
    manifestGuards.readOwn(record, 'manifestMac'),
  )
  const key = copyEvidenceKey(verificationKey)
  try {
    if (!safeDigestEqual(manifestMac, createManifestMac(claims, key))) {
      return failStageManifest()
    }
  } finally {
    key.fill(0)
  }
  return Object.freeze({ ...claims, manifestMac })
}

/**
 * Parses exact canonical manifest bytes and authenticates their HMAC.
 *
 * @param bytes - Untrusted bounded manifest file bytes without a trailing LF.
 * @param verificationKey - Main 32-byte rehearsal evidence key.
 * @returns Frozen detached authenticated manifest.
 */
export function parseWorkspaceSearchMigrationRehearsalStageManifestDocument(
  bytes: Uint8Array,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageManifest {
  const value = parseCanonicalManifestDocument(bytes)
  const manifest = verifyWorkspaceSearchMigrationRehearsalStageManifest(
    value,
    verificationKey,
  )
  requireCanonicalManifestDocument(bytes, manifest)
  return manifest
}

/** Reads and validates exact detached manifest claims. */
function readManifestClaims(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageManifestClaims {
  const record = manifestGuards.requireRecord(value)
  const keys = Object.keys(record)
  manifestGuards.requireExactKeys(
    record,
    keys.includes('manifestMac') ? manifestKeys : manifestClaimKeys,
  )
  const kind = manifestGuards.readOwn(record, 'kind')
  const manifestVersion = manifestGuards.readOwn(record, 'manifestVersion')
  const stage = manifestGuards.readOwn(record, 'stage')
  if (
    kind !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND ||
    manifestVersion !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION ||
    stage !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
  ) return failStageManifest()
  const entries = readManifestEntries(manifestGuards.readOwn(record, 'entries'))
  validateCompleteManifest(entries)
  return Object.freeze({
    kind,
    manifestVersion,
    stage,
    commit: readCommit(manifestGuards.readOwn(record, 'commit')),
    deploymentTrustRootDigest: manifestGuards.readDigest(
      manifestGuards.readOwn(record, 'deploymentTrustRootDigest'),
    ),
    permitDigest: manifestGuards.readDigest(
      manifestGuards.readOwn(record, 'permitDigest'),
    ),
    evidenceKeyDigest: manifestGuards.readDigest(
      manifestGuards.readOwn(record, 'evidenceKeyDigest'),
    ),
    publicationKeyDigest: manifestGuards.readDigest(
      manifestGuards.readOwn(record, 'publicationKeyDigest'),
    ),
    requestedResourcesBinding: manifestGuards.readDigest(
      manifestGuards.readOwn(record, 'requestedResourcesBinding'),
    ),
    integrityResourceIdentityScheme:
      readStageManifestResourceIdentityScheme(
        manifestGuards.readOwn(record, 'integrityResourceIdentityScheme'),
      ),
    integrityResourceIdentities: readStageManifestResourceIdentities(
      manifestGuards.readOwn(record, 'integrityResourceIdentities'),
    ),
    integrityResourceIdentityDigest: manifestGuards.readDigest(
      manifestGuards.readOwn(record, 'integrityResourceIdentityDigest'),
    ),
    configurationBindingDigest: manifestGuards.readDigest(
      manifestGuards.readOwn(record, 'configurationBindingDigest'),
    ),
    policyVersion: manifestGuards.readDigest(
      manifestGuards.readOwn(record, 'policyVersion'),
    ),
    reviewedAt: manifestGuards.readTimestamp(
      manifestGuards.readOwn(record, 'reviewedAt'),
    ),
    entries,
  })
}

/** Reads the sole immutable-incarnation scheme accepted by manifests. */
function readStageManifestResourceIdentityScheme(
  value: unknown,
): typeof CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME {
  if (
    value !== CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  ) return failStageManifest()
  return value
}

/** Reads one detached canonical resource-identity vector for a manifest. */
function readStageManifestResourceIdentities(
  value: unknown,
): readonly CrossDomainIntegrityResourceIdentity[] {
  try {
    return parseCrossDomainIntegrityResourceIdentities(value)
  } catch {
    return failStageManifest()
  }
}

/** Reads and validates all detached manifest entries. */
function readManifestEntries(
  value: unknown,
): readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return failStageManifest()
  }
  const entries: WorkspaceSearchMigrationRehearsalStageManifestEntry[] = []
  for (const candidate of value) entries.push(readManifestEntry(candidate))
  if (
    entries.length === 0 ||
    entries.length >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES
  ) return failStageManifest()
  return Object.freeze(entries)
}

/** Reads one exact detached manifest entry. */
function readManifestEntry(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageManifestEntry {
  const record = manifestGuards.requireRecord(value)
  manifestGuards.requireExactKeys(record, manifestEntryKeys)
  const faultPlanDigest = readNullableDigest(
    manifestGuards.readOwn(record, 'faultPlanDigest'),
  )
  const expectedOutcome = readStageOutcome(
    manifestGuards.readOwn(record, 'expectedOutcome'),
  )
  requireFaultOutcomePair(faultPlanDigest, expectedOutcome)
  return Object.freeze({
    ordinal: readPositiveSafeInteger(
      manifestGuards.readOwn(record, 'ordinal'),
    ),
    scenario: readScenario(manifestGuards.readOwn(record, 'scenario')),
    scenarioStageOrdinal: readPositiveSafeInteger(
      manifestGuards.readOwn(record, 'scenarioStageOrdinal'),
    ),
    command: readStageCommand(manifestGuards.readOwn(record, 'command')),
    controlArgumentsDigest: manifestGuards.readDigest(
      manifestGuards.readOwn(record, 'controlArgumentsDigest'),
    ),
    attemptOrdinal: readPositiveSafeInteger(
      manifestGuards.readOwn(record, 'attemptOrdinal'),
    ),
    faultPlanDigest,
    expectedOutcome,
  })
}

/** Requires one explicit non-no-op chain for each canonical scenario. */
function validateCompleteManifest(
  entries: readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[],
): void {
  let globalOrdinal = 1
  let cursor = 0
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    const scenarioEntries:
      WorkspaceSearchMigrationRehearsalStageManifestEntry[] = []
    while (entries[cursor]?.scenario === scenario) {
      const entry = entries[cursor]
      if (
        entry === undefined ||
        entry.ordinal !== globalOrdinal ||
        entry.scenarioStageOrdinal !== scenarioEntries.length + 1
      ) return failStageManifest()
      scenarioEntries.push(entry)
      cursor += 1
      globalOrdinal += 1
    }
    validateScenarioManifest(scenario, scenarioEntries)
  }
  if (cursor !== entries.length) return failStageManifest()
}

/** Exact non-secret stage shape fixed by one canonical scenario. */
type WorkspaceSearchMigrationRehearsalExpectedManifestStage = {
  /** Exact existing control command required at this position. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Exact finite process outcome required at this position. */
  readonly expectedOutcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** One-based logical process attempt required at this position. */
  readonly attemptOrdinal: number
  /** Whether this exact position must carry the reviewed fault plan. */
  readonly requiresFaultPlan: boolean
}

/** Requires the scenario's one and only reviewed complete stage sequence. */
function validateScenarioManifest(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  entries: readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[],
): void {
  const expected = createExpectedScenarioManifestStages(scenario)
  if (entries.length !== expected.length) return failStageManifest()
  for (let index = 0; index < expected.length; index += 1) {
    const entry = entries[index]
    const expectedEntry = expected[index]
    if (
      entry === undefined ||
      expectedEntry === undefined ||
      entry.command !== expectedEntry.command ||
      entry.expectedOutcome !== expectedEntry.expectedOutcome ||
      entry.attemptOrdinal !== expectedEntry.attemptOrdinal ||
      (entry.faultPlanDigest !== null) !== expectedEntry.requiresFaultPlan
    ) return failStageManifest()
  }
}

/**
 * Returns the only admissible command, attempt, outcome, and fault sequence.
 *
 * @param scenario - Canonical required rehearsal scenario.
 * @returns Frozen exact stage sequence for the reviewed manifest.
 */
function createExpectedScenarioManifestStages(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): readonly WorkspaceSearchMigrationRehearsalExpectedManifestStage[] {
  /** Creates one successful expected stage. */
  const completed = (
    command: WorkspaceSearchMigrationRehearsalStageCommand,
    attemptOrdinal: number,
  ): WorkspaceSearchMigrationRehearsalExpectedManifestStage => Object.freeze({
    command,
    expectedOutcome: 'completed',
    attemptOrdinal,
    requiresFaultPlan: false,
  })
  /** Creates one fault-bearing expected stage. */
  const fault = (
    command: WorkspaceSearchMigrationRehearsalStageCommand,
    expectedOutcome: 'fault-reached' | 'response-loss-reconciled',
    attemptOrdinal: number,
  ): WorkspaceSearchMigrationRehearsalExpectedManifestStage => Object.freeze({
    command,
    expectedOutcome,
    attemptOrdinal,
    requiresFaultPlan: true,
  })
  /** Creates one successful second-attempt takeover stage. */
  const takeover = (
    command: WorkspaceSearchMigrationRehearsalStageCommand,
  ): WorkspaceSearchMigrationRehearsalExpectedManifestStage => Object.freeze({
    command,
    expectedOutcome: 'takeover-completed',
    attemptOrdinal: 2,
    requiresFaultPlan: false,
  })
  switch (scenario) {
    case 'happy-path-verified':
      return Object.freeze([
        completed('close-replan', 1),
        completed('apply', 1),
        completed('verify', 1),
        completed('release', 1),
      ])
    case 'complete-apply-rollback':
      return Object.freeze([
        completed('close-replan', 1),
        completed('apply', 1),
        completed('rollback-complete', 1),
        completed('release', 1),
      ])
    case 'partial-apply-rollback':
      return Object.freeze([
        completed('close-replan', 1),
        fault('apply', 'fault-reached', 1),
        takeover('rollback-partial'),
        completed('release', 2),
      ])
    case 'transaction-response-loss':
      return Object.freeze([
        fault('close-replan', 'response-loss-reconciled', 1),
        completed('apply', 1),
        completed('verify', 1),
        completed('release', 1),
      ])
    case 'artifact-before-checkpoint-kill':
    case 'lease-expiry-takeover':
      return Object.freeze([
        fault('close-replan', 'fault-reached', 1),
        takeover('close-replan'),
        completed('apply', 2),
        completed('verify', 2),
        completed('release', 2),
      ])
    case 'cursor-before-commit-kill':
    case 'cursor-after-commit-kill':
      return Object.freeze([
        completed('close-replan', 1),
        fault('apply', 'fault-reached', 1),
        takeover('apply'),
        completed('verify', 2),
        completed('release', 2),
      ])
  }
}

/** Parses one bounded UTF-8 JSON manifest before strict validation. */
function parseCanonicalManifestDocument(value: unknown): unknown {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    manifestGuards.readIntrinsicByteLength(value) === 0 ||
    manifestGuards.readIntrinsicByteLength(value) >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES
  ) return failStageManifest()
  let copied: Uint8Array
  try {
    const candidate: unknown = Reflect.apply(
      Uint8Array.prototype.slice,
      value,
      [],
    )
    if (!(candidate instanceof Uint8Array)) return failStageManifest()
    copied = candidate
  } catch {
    return failStageManifest()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copied))
  } catch {
    return failStageManifest()
  }
}

/** Requires source bytes to equal the exact normalized canonical manifest. */
function requireCanonicalManifestDocument(
  source: Uint8Array,
  normalized: unknown,
): void {
  const canonical = new TextEncoder().encode(
    serializeCanonicalJson(normalized),
  )
  let sourceLength: number
  try {
    sourceLength = manifestGuards.readIntrinsicByteLength(source)
  } catch {
    return failStageManifest()
  }
  if (sourceLength !== canonical.byteLength) return failStageManifest()
  try {
    for (let index = 0; index < canonical.byteLength; index += 1) {
      if (Reflect.get(source, index) !== canonical[index]) {
        return failStageManifest()
      }
    }
  } catch {
    return failStageManifest()
  }
}

/** Copies one ordinary exact-length evidence key. */
function copyEvidenceKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    manifestGuards.readIntrinsicByteLength(value) !== evidenceKeyByteLength
  ) return failStageManifest()
  try {
    const copied: unknown = Reflect.apply(
      Uint8Array.prototype.slice,
      value,
      [],
    )
    if (
      !(copied instanceof Uint8Array) ||
      copied.byteLength !== evidenceKeyByteLength
    ) return failStageManifest()
    return copied
  } catch {
    return failStageManifest()
  }
}

/** Creates one manifest HMAC. */
function createManifestMac(
  claims: WorkspaceSearchMigrationRehearsalStageManifestClaims,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(manifestMacDomain, 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/** Reads one exact lowercase Git commit OID. */
function readCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    return failStageManifest()
  }
  return value
}

/** Reads one canonical required scenario. */
function readScenario(
  value: unknown,
): WorkspaceSearchMigrationRehearsalScenarioName {
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    if (value === scenario) return scenario
  }
  return failStageManifest()
}

/** Reads one finite existing control command. */
function readStageCommand(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageCommand {
  if (
    value === 'apply' ||
    value === 'close-replan' ||
    value === 'release' ||
    value === 'rollback-complete' ||
    value === 'rollback-partial' ||
    value === 'verify'
  ) return value
  return failStageManifest()
}

/** Reads one finite stage outcome. */
function readStageOutcome(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageOutcome {
  if (
    value === 'completed' ||
    value === 'fault-reached' ||
    value === 'response-loss-reconciled' ||
    value === 'takeover-completed'
  ) return value
  return failStageManifest()
}

/** Reads a positive safe integer. */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) return failStageManifest()
  return value
}

/** Reads a nullable conventional digest. */
function readNullableDigest(value: unknown): string | null {
  if (value === null) return null
  return manifestGuards.readDigest(value)
}

/** Requires fault-plan presence to match its exact expected outcome. */
function requireFaultOutcomePair(
  faultPlanDigest: string | null,
  outcome: WorkspaceSearchMigrationRehearsalStageOutcome,
): void {
  if (
    (faultPlanDigest === null && outcome === 'fault-reached') ||
    (faultPlanDigest !== null &&
      outcome !== 'fault-reached' &&
      outcome !== 'response-loss-reconciled') ||
    (faultPlanDigest === null && outcome === 'response-loss-reconciled')
  ) return failStageManifest()
}

/** Compares two fixed-size lowercase digests without timing leakage. */
function safeDigestEqual(left: string, right: string): boolean {
  if (!isHexDigest(left) || !isHexDigest(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Raises the shared raw-value-free manifest and receipt failure. */
function failStageManifest(): never {
  throw new WorkspaceSearchMigrationRehearsalStageReceiptError()
}
