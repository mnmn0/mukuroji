import { createHash } from 'node:crypto'
import { types } from 'node:util'
import {
  compareCrossDomainIntegrityMigrationRehearsalResults,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND,
  parseCrossDomainIntegrityResult,
  parseCrossDomainIntegrityResourceIdentities,
  verifyCrossDomainIntegrityResult,
  type CrossDomainIntegrityRehearsalLiveRuntimeProvenance,
  type CrossDomainIntegrityResourceIdentity,
  type CrossDomainIntegrityResult,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
} from './migration-contract'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Maximum exact canonical bytes accepted for one complete #163 result. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RESULT_MAX_BYTES =
  1_024 * 1_024

/** Rollback scenarios that require a before/after #163 comparison. */
export type WorkspaceSearchMigrationRehearsalRollbackIntegrityPurpose =
  | 'complete-rollback'
  | 'partial-rollback'

/** One raw canonical #163 result pair for a rollback scenario. */
export type WorkspaceSearchMigrationRehearsalIntegrityPairInput = {
  /** Canonical inclusive lower bound for this pair's observations. */
  readonly startedAt: string
  /** Trusted apply start that the complete before observation must precede. */
  readonly applyStartedAt: string
  /** Authoritative rolled-back terminal that the after observation must follow. */
  readonly terminalAt: string
  /** Permit/manifest resource identity digest required for both live results. */
  readonly expectedResourceIdentityDigest: string
  /** Exact #163 canonical publication bytes of the complete before file. */
  readonly beforeResultBytes: Uint8Array
  /** Exact #163 canonical publication bytes of the complete after file. */
  readonly afterResultBytes: Uint8Array
  /** Trusted clock sampled only after both files authenticate and compare. */
  readonly clock: () => Date
}

/** One purpose-bound raw #163 pair admitted to independent authentication. */
export type AuthenticateWorkspaceSearchMigrationRehearsalIntegrityPairInput =
  WorkspaceSearchMigrationRehearsalIntegrityPairInput & {
    /** Exact rollback purpose bound into comparison evidence. */
    readonly purpose:
      WorkspaceSearchMigrationRehearsalRollbackIntegrityPurpose
  }

/** One raw post-terminal #163 result admitted to independent authentication. */
export type AuthenticateWorkspaceSearchMigrationRehearsalIntegrityResultInput = {
  /** Canonical publication time of the authoritative verified terminal root. */
  readonly terminalAt: string
  /** Permit/manifest resource identity digest required for the live result. */
  readonly expectedResourceIdentityDigest: string
  /** Exact canonical publication bytes of the post-terminal #163 result. */
  readonly resultBytes: Uint8Array
  /** Trusted clock sampled only after the complete result authenticates. */
  readonly clock: () => Date
}

/** Raw live #163 result admitted for one pre-apply planning pin. */
export type AuthenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResultInput = {
  /** Exact canonical #163 result bytes completed before apply admission. */
  readonly resultBytes: Uint8Array
  /** Permit/manifest resource identity digest required for the live result. */
  readonly expectedResourceIdentityDigest: string
  /** Trusted clock sampled after complete authentication. */
  readonly clock: () => Date
}

/** Exact actual-runtime projection for one authenticated live #163 result. */
export type WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection = {
  /** Canonical checker observation time authenticated inside the result. */
  readonly checkedAt: string
  /** SHA-256 digest of the exact supplied canonical file bytes. */
  readonly contentDigest: string
  /** Exact supplied canonical file byte length. */
  readonly byteLength: number
  /** Canonical digest of the complete strictly parsed #163 result. */
  readonly resultDigest: string
  /** Whole-result HMAC authenticated with the dedicated #163 key. */
  readonly resultMac: string
  /** Exact authenticated live-runtime provenance retained for pin comparison. */
  readonly runtimeProvenance:
    CrossDomainIntegrityRehearsalLiveRuntimeProvenance
  /** Fixed immutable-incarnation scheme authenticated by the live result MAC. */
  readonly resourceIdentityScheme:
    typeof CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  /** Canonical seven-entry opaque immutable resource identity vector. */
  readonly resourceIdentities: readonly CrossDomainIntegrityResourceIdentity[]
  /** Cross-domain aggregate authenticated inside the complete #163 result. */
  readonly integrityAggregateDigest: string
  /** Exact physical-resource identity digest authenticated by #163. */
  readonly resourceIdentityDigest: string
}

/** Exact raw-file and live-result binding for one #163 observation. */
export type WorkspaceSearchMigrationRehearsalIntegrityResultFileBinding =
  WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection

/** Exact purpose, window, and raw-file bindings verified for one comparison. */
export type WorkspaceSearchMigrationRehearsalIntegrityScenarioBinding = {
  /** Fixed rollback-comparison discriminator. */
  readonly kind: 'rollback-comparison'
  /** Scenario purpose preventing cross-window replay. */
  readonly purpose:
    WorkspaceSearchMigrationRehearsalRollbackIntegrityPurpose
  /** Mandatory passing comparison classification. */
  readonly status: 'pass'
  /** Mandatory absence of comparison failures. */
  readonly failureCount: 0
  /** Canonical inclusive lower bound supplied for both checks. */
  readonly startedAt: string
  /** Trusted apply start strictly after the complete before observation. */
  readonly applyStartedAt: string
  /** Authoritative rollback terminal strictly before the after observation. */
  readonly terminalAt: string
  /** Canonical inclusive upper bound supplied for both checks. */
  readonly completedAt: string
  /** Exact authenticated before-result file binding. */
  readonly before:
    WorkspaceSearchMigrationRehearsalIntegrityResultFileBinding
  /** Exact authenticated after-result file binding. */
  readonly after:
    WorkspaceSearchMigrationRehearsalIntegrityResultFileBinding
  /** Purpose-bound digest of the successful #163 comparison. */
  readonly comparisonDigest: string
  /** Digest binding the purpose, window, files, and comparison together. */
  readonly comparisonContextDigest: string
}

/** Independently authenticated exact binding for one rollback #163 pair. */
export type WorkspaceSearchMigrationRehearsalAuthenticatedIntegrityPair = {
  /** Exact authenticated files, window, purpose, and comparison binding. */
  readonly binding:
    WorkspaceSearchMigrationRehearsalIntegrityScenarioBinding
}

/** Independently authenticated passing post-terminal #163 result binding. */
export type WorkspaceSearchMigrationRehearsalAuthenticatedIntegrityResult = {
  /** Fixed verified-result discriminator. */
  readonly kind: 'verified-result'
  /** Mandatory passing #163 result classification. */
  readonly status: 'pass'
  /** Mandatory absence of #163 result failures. */
  readonly failureCount: 0
  /** Trusted completion sampled after the result authentication. */
  readonly completedAt: string
  /** Exact authenticated raw-file and complete-result binding. */
  readonly result:
    WorkspaceSearchMigrationRehearsalIntegrityResultFileBinding
  /** Cross-domain aggregate independently authenticated inside the #163 result. */
  readonly integrityAggregateDigest: string
}

/** Stable raw-value-free failure at the #163 evidence trust boundary. */
export class WorkspaceSearchMigrationRehearsalIntegrityEvidenceError
  extends Error {
  /** Stable machine-readable integrity evidence failure code. */
  readonly code = 'INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE'

  /** Creates the sole external integrity evidence validation failure. */
  constructor() {
    super('INVALID_MIGRATION_REHEARSAL_INTEGRITY_EVIDENCE')
    this.name = 'WorkspaceSearchMigrationRehearsalIntegrityEvidenceError'
  }
}

/** Private state for one genuine, one-shot integrity preimage capability. */
type WorkspaceSearchMigrationRehearsalIntegrityPreimageResultState = {
  /** Exact authenticated live projection retained outside caller reach. */
  readonly projection:
    WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection
  /** Whether the finalizer already consumed this planning authority. */
  consumed: boolean
}

const integrityPreimageResultCapabilityToken = Symbol(
  'workspace-search-migration-rehearsal-integrity-preimage-result',
)
const integrityPreimageResultStates =
  new WeakMap<WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability,
    WorkspaceSearchMigrationRehearsalIntegrityPreimageResultState>()

/** Opaque one-shot authority carrying a genuine live #163 preimage. */
export class WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability {
  /**
   * Constructs only capabilities minted by this module's authenticator.
   *
   * @param token - Module-private construction authority.
   */
  constructor(token: symbol) {
    if (token !== integrityPreimageResultCapabilityToken) {
      throw new TypeError('Invalid integrity preimage capability.')
    }
    Object.freeze(this)
  }
}

/** Parsed inclusive checker timestamp window. */
type IntegrityEvidenceWindow = {
  /** Canonical inclusive lower bound. */
  readonly startedAt: string
  /** Exclusive upper bound for the complete before observation. */
  readonly applyStartedAt: string
  /** Exclusive lower bound for the complete after observation. */
  readonly terminalAt: string
  /** Canonical inclusive upper bound. */
  readonly completedAt: string
}

/** Strictly authenticated complete result plus its exact raw-file binding. */
type AuthenticatedIntegrityResultFile = {
  /** Complete canonical authenticated #163 result. */
  readonly result: CrossDomainIntegrityResult
  /** SHA-256 digest of the exact supplied canonical bytes. */
  readonly contentDigest: string
  /** Exact supplied canonical byte length. */
  readonly byteLength: number
}

/** Digest-only authenticated projection used while binding one raw result. */
type IntegrityResultDigestBinding = {
  /** Canonical digest of the complete strictly parsed #163 result. */
  readonly resultDigest: string
  /** Whole-result HMAC authenticated with the dedicated #163 key. */
  readonly resultMac: string
}

/** Exact byte length of the transferred #163 HMAC key. */
const integrityDigestKeyByteLength = 32

/** Strict guards bound to this module's stable failure contract. */
const integrityGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failIntegrityEvidence,
)

/**
 * Authenticates and seals one live source result for a pre-apply planning pin.
 *
 * Ownership of `digestKey` transfers to this invocation. The trusted clock is
 * sampled only after the canonical file, result MAC, live provenance, role,
 * status, and physical-resource binding all authenticate.
 *
 * @param input - Exact live result, expected resources, and trusted clock.
 * @param digestKey - Caller-owned 32-byte #163 HMAC key to consume.
 * @returns Opaque one-shot capability retaining the exact live projection.
 */
export function authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(
  input:
    AuthenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResultInput,
  digestKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability {
  let workingKey: Uint8Array | undefined
  try {
    workingKey = copyOwnedDigestKey(digestKey)
    zeroizeDigestKey(digestKey)
    const record = integrityGuards.requireRecord(input)
    integrityGuards.requireExactKeys(record, [
      'clock',
      'expectedResourceIdentityDigest',
      'resultBytes',
    ])
    const authenticated = readAuthenticatedResult(
      integrityGuards.readOwn(record, 'resultBytes'),
      workingKey,
    )
    const result = authenticated.result
    const expectedResourceIdentityDigest = integrityGuards.readDigest(
      integrityGuards.readOwn(record, 'expectedResourceIdentityDigest'),
    )
    requireLiveSourceResult(result, expectedResourceIdentityDigest)
    if (result.status !== 'pass' || result.failureCodes.length !== 0) {
      return failIntegrityEvidence()
    }
    const authenticatedAt = readIntegrityCompletion(record)
    if (Date.parse(result.checkedAt) > Date.parse(authenticatedAt)) {
      return failIntegrityEvidence()
    }
    const projection = createResultFileBinding(
      authenticated,
      createResultBinding(result),
    )
    const capability =
      new WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability(
        integrityPreimageResultCapabilityToken,
      )
    integrityPreimageResultStates.set(capability, {
      projection,
      consumed: false,
    })
    return capability
  } catch {
    return failIntegrityEvidence()
  } finally {
    zeroizeDigestKey(workingKey)
    zeroizeDigestKey(digestKey)
  }
}

/**
 * Reads a detached preimage projection without consuming its finalizer authority.
 *
 * @param value - Candidate opaque preimage capability.
 * @returns Frozen exact live result projection.
 */
export function readWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection {
  return cloneIntegrityLiveResultProjection(
    readIntegrityPreimageResultState(value).projection,
  )
}

/**
 * Consumes one genuine preimage capability exactly once.
 *
 * @param value - Candidate opaque preimage capability.
 * @returns Frozen exact live result projection for planning publication.
 */
export function consumeWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection {
  const state = readIntegrityPreimageResultState(value)
  state.consumed = true
  return cloneIntegrityLiveResultProjection(state.projection)
}

/**
 * Strictly reads one published live-result projection without authenticating
 * the containing artifact.
 *
 * The caller must authenticate the containing document separately. This
 * parser exists so downstream HMAC-authenticated artifacts can retain the
 * complete preimage projection and reject omitted or added fields.
 *
 * @param value - Candidate exact live-result projection.
 * @returns Frozen aliases-free projection with canonical live provenance.
 */
export function readWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection {
  try {
    const record = integrityGuards.requireRecord(value)
    integrityGuards.requireExactKeys(record, [
      'byteLength',
      'checkedAt',
      'contentDigest',
      'integrityAggregateDigest',
      'resourceIdentities',
      'resourceIdentityDigest',
      'resourceIdentityScheme',
      'resultDigest',
      'resultMac',
      'runtimeProvenance',
    ])
    const checkedAt = integrityGuards.readTimestamp(
      integrityGuards.readOwn(record, 'checkedAt'),
    )
    const byteLength = readIntegrityProjectionByteLength(
      integrityGuards.readOwn(record, 'byteLength'),
    )
    const provenanceRecord = integrityGuards.requireRecord(
      integrityGuards.readOwn(record, 'runtimeProvenance'),
    )
    integrityGuards.requireExactKeys(provenanceRecord, [
      'checkedAtSource',
      'completedAt',
      'kind',
      'mode',
      'startedAt',
      'version',
    ])
    const startedAt = integrityGuards.readTimestamp(
      integrityGuards.readOwn(provenanceRecord, 'startedAt'),
    )
    const completedAt = integrityGuards.readTimestamp(
      integrityGuards.readOwn(provenanceRecord, 'completedAt'),
    )
    if (
      integrityGuards.readOwn(provenanceRecord, 'kind') !==
        CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND ||
      integrityGuards.readOwn(provenanceRecord, 'version') !== 1 ||
      integrityGuards.readOwn(provenanceRecord, 'mode') !==
        'migration-rehearsal-live' ||
      integrityGuards.readOwn(provenanceRecord, 'checkedAtSource') !==
        'trusted-wall-clock-after-external-reads' ||
      completedAt !== checkedAt ||
      Date.parse(startedAt) > Date.parse(completedAt)
    ) return failIntegrityEvidence()
    return Object.freeze({
      checkedAt,
      contentDigest: integrityGuards.readDigest(
        integrityGuards.readOwn(record, 'contentDigest'),
      ),
      byteLength,
      resultDigest: integrityGuards.readDigest(
        integrityGuards.readOwn(record, 'resultDigest'),
      ),
      resultMac: integrityGuards.readDigest(
        integrityGuards.readOwn(record, 'resultMac'),
      ),
      runtimeProvenance: Object.freeze({
        kind: CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND,
        version: 1,
        mode: 'migration-rehearsal-live',
        startedAt,
        completedAt,
        checkedAtSource: 'trusted-wall-clock-after-external-reads',
      }),
      resourceIdentityScheme:
        readImmutableResourceIdentityScheme(
          integrityGuards.readOwn(record, 'resourceIdentityScheme'),
        ),
      resourceIdentities: parseCrossDomainIntegrityResourceIdentities(
        integrityGuards.readOwn(record, 'resourceIdentities'),
      ),
      integrityAggregateDigest: integrityGuards.readDigest(
        integrityGuards.readOwn(record, 'integrityAggregateDigest'),
      ),
      resourceIdentityDigest: integrityGuards.readDigest(
        integrityGuards.readOwn(record, 'resourceIdentityDigest'),
      ),
    })
  } catch {
    return failIntegrityEvidence()
  }
}

/**
 * Compares every authenticated field of two live-result projections exactly.
 *
 * @param left - First strictly parsed live-result projection.
 * @param right - Second strictly parsed live-result projection.
 * @returns Whether both raw-file identities and live observations are equal.
 */
export function sameWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection(
  left: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
  right: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
): boolean {
  return left.checkedAt === right.checkedAt &&
    left.contentDigest === right.contentDigest &&
    left.byteLength === right.byteLength &&
    left.resultDigest === right.resultDigest &&
    left.resultMac === right.resultMac &&
    left.runtimeProvenance.kind === right.runtimeProvenance.kind &&
    left.runtimeProvenance.version === right.runtimeProvenance.version &&
    left.runtimeProvenance.mode === right.runtimeProvenance.mode &&
    left.runtimeProvenance.startedAt ===
      right.runtimeProvenance.startedAt &&
    left.runtimeProvenance.completedAt ===
      right.runtimeProvenance.completedAt &&
    left.runtimeProvenance.checkedAtSource ===
      right.runtimeProvenance.checkedAtSource &&
    left.resourceIdentityScheme === right.resourceIdentityScheme &&
    sameIntegrityResourceIdentities(
      left.resourceIdentities,
      right.resourceIdentities,
    ) &&
    left.integrityAggregateDigest === right.integrityAggregateDigest &&
    left.resourceIdentityDigest === right.resourceIdentityDigest
}

/**
 * Reads one module-minted, unconsumed preimage capability state.
 *
 * @param value - Candidate opaque capability.
 * @returns Private active state retained in this module's WeakMap.
 */
function readIntegrityPreimageResultState(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityPreimageResultState {
  if (
    !(value instanceof
      WorkspaceSearchMigrationRehearsalIntegrityPreimageResultCapability)
  ) {
    return failIntegrityEvidence()
  }
  const state = integrityPreimageResultStates.get(value)
  if (state === undefined || state.consumed) return failIntegrityEvidence()
  return state
}

/**
 * Creates one aliases-free frozen copy of an authenticated live projection.
 *
 * @param projection - Module-authenticated live result projection.
 * @returns Frozen detached projection safe for publication.
 */
function cloneIntegrityLiveResultProjection(
  projection: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
): WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection {
  return Object.freeze({
    checkedAt: projection.checkedAt,
    contentDigest: projection.contentDigest,
    byteLength: projection.byteLength,
    resultDigest: projection.resultDigest,
    resultMac: projection.resultMac,
    runtimeProvenance: Object.freeze({ ...projection.runtimeProvenance }),
    resourceIdentityScheme: projection.resourceIdentityScheme,
    resourceIdentities: Object.freeze(
      projection.resourceIdentities.map((identity) =>
        Object.freeze({ ...identity })
      ),
    ),
    integrityAggregateDigest: projection.integrityAggregateDigest,
    resourceIdentityDigest: projection.resourceIdentityDigest,
  })
}

/** Reads one positive bounded exact raw-result byte length. */
function readIntegrityProjectionByteLength(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RESULT_MAX_BYTES
  ) return failIntegrityEvidence()
  return value
}

/** Reads the sole live immutable resource identity scheme. */
function readImmutableResourceIdentityScheme(
  value: unknown,
): typeof CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME {
  if (
    value !== CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  ) return failIntegrityEvidence()
  return CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
}

/** Compares two canonical opaque resource identity vectors exactly. */
function sameIntegrityResourceIdentities(
  left: readonly CrossDomainIntegrityResourceIdentity[],
  right: readonly CrossDomainIntegrityResourceIdentity[],
): boolean {
  return left.length === right.length && left.every((identity, index) => {
    const other = right[index]
    return other !== undefined &&
      identity.target === other.target &&
      identity.identityDigest === other.identityDigest
  })
}

/**
 * Authenticates one passing post-terminal #163 result and its exact file.
 *
 * Ownership of `digestKey` transfers to this invocation. The result must have
 * been observed strictly after the terminal root and no later than the trusted
 * completion sample. Both the caller buffer and working key are overwritten.
 *
 * @param input - Exact terminal window and canonical post-terminal result.
 * @param digestKey - Caller-owned 32-byte #163 result HMAC key to consume.
 * @returns Frozen rich verified-result projection for reconciliation.
 */
export function authenticateWorkspaceSearchMigrationRehearsalIntegrityResult(
  input: AuthenticateWorkspaceSearchMigrationRehearsalIntegrityResultInput,
  digestKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalAuthenticatedIntegrityResult {
  let workingKey: Uint8Array | undefined
  try {
    workingKey = copyOwnedDigestKey(digestKey)
    zeroizeDigestKey(digestKey)
    const record = integrityGuards.requireRecord(input)
    integrityGuards.requireExactKeys(record, [
      'clock',
      'expectedResourceIdentityDigest',
      'resultBytes',
      'terminalAt',
    ])
    const terminalAt = integrityGuards.readTimestamp(
      integrityGuards.readOwn(record, 'terminalAt'),
    )
    const authenticated = readAuthenticatedResult(
      integrityGuards.readOwn(record, 'resultBytes'),
      workingKey,
    )
    const result = authenticated.result
    const expectedResourceIdentityDigest = integrityGuards.readDigest(
      integrityGuards.readOwn(record, 'expectedResourceIdentityDigest'),
    )
    const runtimeProvenance = requireLiveSourceResult(
      result,
      expectedResourceIdentityDigest,
    )
    const completedAt = readIntegrityCompletion(record)
    if (
      result.status !== 'pass' ||
      result.failureCodes.length !== 0 ||
      Date.parse(runtimeProvenance.startedAt) <= Date.parse(terminalAt) ||
      Date.parse(result.checkedAt) <= Date.parse(terminalAt) ||
      Date.parse(result.checkedAt) > Date.parse(completedAt)
    ) {
      return failIntegrityEvidence()
    }
    const resultBinding = createResultFileBinding(
      authenticated,
      createResultBinding(result),
    )
    return Object.freeze({
      kind: 'verified-result',
      status: 'pass',
      failureCount: 0,
      completedAt,
      result: resultBinding,
      integrityAggregateDigest: result.evidence.aggregateDigest,
    })
  } catch {
    return failIntegrityEvidence()
  } finally {
    zeroizeDigestKey(workingKey)
    zeroizeDigestKey(digestKey)
  }
}

/**
 * Authenticates and compares one complete canonical #163 before/after pair.
 *
 * Ownership of `digestKey` transfers to this invocation. The caller buffer and
 * detached working key are overwritten on every success or failure path. Raw
 * result bytes are canonicalized, strictly parsed, HMAC-authenticated, and
 * compared before an identifier-free immutable projection is returned.
 *
 * @param input - Exact purpose, inclusive window, and canonical result files.
 * @param digestKey - Caller-owned 32-byte #163 result HMAC key to consume.
 * @returns Frozen purpose-bound evidence and exact authenticated pair binding.
 */
export function authenticateWorkspaceSearchMigrationRehearsalIntegrityPair(
  input: AuthenticateWorkspaceSearchMigrationRehearsalIntegrityPairInput,
  digestKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalAuthenticatedIntegrityPair {
  let workingKey: Uint8Array | undefined
  try {
    workingKey = copyOwnedDigestKey(digestKey)
    zeroizeDigestKey(digestKey)
    const record = integrityGuards.requireRecord(input)
    integrityGuards.requireExactKeys(record, [
      'afterResultBytes',
      'applyStartedAt',
      'beforeResultBytes',
      'clock',
      'expectedResourceIdentityDigest',
      'purpose',
      'startedAt',
      'terminalAt',
    ])
    const purpose = readIntegrityPurpose(
      integrityGuards.readOwn(record, 'purpose'),
    )
    return authenticateIntegrityPairRecord(
      record,
      purpose,
      workingKey,
    )
  } catch {
    return failIntegrityEvidence()
  } finally {
    zeroizeDigestKey(workingKey)
    zeroizeDigestKey(digestKey)
  }
}

/** Reads and validates one purpose-specific inclusive observation window. */
function readWindow(
  record: object,
  completedAt: string,
): IntegrityEvidenceWindow {
  const startedAt = integrityGuards.readTimestamp(
    integrityGuards.readOwn(record, 'startedAt'),
  )
  const applyStartedAt = integrityGuards.readTimestamp(
    integrityGuards.readOwn(record, 'applyStartedAt'),
  )
  const terminalAt = integrityGuards.readTimestamp(
    integrityGuards.readOwn(record, 'terminalAt'),
  )
  if (
    Date.parse(startedAt) >= Date.parse(applyStartedAt) ||
    Date.parse(applyStartedAt) >= Date.parse(terminalAt) ||
    Date.parse(terminalAt) >= Date.parse(completedAt)
  ) {
    return failIntegrityEvidence()
  }
  return { startedAt, applyStartedAt, terminalAt, completedAt }
}

/**
 * Authenticates one already shape-checked pair through the shared semantics.
 *
 * @param record - Exact pair or purpose-bearing pair record.
 * @param purpose - Validated semantic comparison purpose.
 * @param digestKey - Detached exact 32-byte #163 HMAC key.
 * @returns Frozen identifier-free evidence and exact authenticated binding.
 */
function authenticateIntegrityPairRecord(
  record: object,
  purpose: WorkspaceSearchMigrationRehearsalRollbackIntegrityPurpose,
  digestKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalAuthenticatedIntegrityPair {
  const beforeFile = readAuthenticatedResult(
    integrityGuards.readOwn(record, 'beforeResultBytes'),
    digestKey,
  )
  const afterFile = readAuthenticatedResult(
    integrityGuards.readOwn(record, 'afterResultBytes'),
    digestKey,
  )
  const before = beforeFile.result
  const after = afterFile.result
  const expectedResourceIdentityDigest = integrityGuards.readDigest(
    integrityGuards.readOwn(record, 'expectedResourceIdentityDigest'),
  )
  const beforeRuntimeProvenance = requireLiveSourceResult(
    before,
    expectedResourceIdentityDigest,
  )
  const afterRuntimeProvenance = requireLiveSourceResult(
    after,
    expectedResourceIdentityDigest,
  )
  const compared = compareCrossDomainIntegrityMigrationRehearsalResults(
    before,
    after,
    digestKey,
  )
  if (compared.status !== 'pass' || compared.failureCodes.length !== 0) {
    return failIntegrityEvidence()
  }
  const window = readWindow(record, readIntegrityCompletion(record))
  requireCheckedAtWindow(
    before,
    after,
    beforeRuntimeProvenance,
    afterRuntimeProvenance,
    window,
  )
  const beforeBinding = createResultBinding(before)
  const afterBinding = createResultBinding(after)
  const comparisonDigest = createMigrationDigest({
    purpose,
    beforeResultDigest: beforeBinding.resultDigest,
    afterResultDigest: afterBinding.resultDigest,
    comparison: {
      kind: compared.kind,
      contractVersion: compared.contractVersion,
      status: compared.status,
    },
  })
  const beforeFileBinding = createResultFileBinding(
    beforeFile,
    beforeBinding,
  )
  const afterFileBinding = createResultFileBinding(
    afterFile,
    afterBinding,
  )
  const comparisonContextFields = {
    purpose,
    startedAt: window.startedAt,
    applyStartedAt: window.applyStartedAt,
    terminalAt: window.terminalAt,
    completedAt: window.completedAt,
    before: beforeFileBinding,
    after: afterFileBinding,
    comparisonDigest,
  }
  return Object.freeze({
    binding: Object.freeze({
      kind: 'rollback-comparison',
      status: 'pass',
      failureCount: 0,
      ...comparisonContextFields,
      comparisonContextDigest: createMigrationDigest({
        kind: 'workspace-search-migration-rehearsal-integrity-context',
        version: 1,
        ...comparisonContextFields,
      }),
    }),
  })
}

/**
 * Samples the caller-captured trusted clock after integrity authentication.
 *
 * @param record - Exact authentication input retaining the trusted clock.
 * @returns Canonical millisecond-resolution authentication completion time.
 */
function readIntegrityCompletion(record: object): string {
  const clock = integrityGuards.readOwn(record, 'clock')
  if (typeof clock !== 'function' || types.isProxy(clock)) {
    return failIntegrityEvidence()
  }
  let observed: unknown
  let milliseconds: unknown
  try {
    observed = Reflect.apply(clock, undefined, [])
    if (!(observed instanceof Date) || types.isProxy(observed)) {
      return failIntegrityEvidence()
    }
    milliseconds = Reflect.apply(Date.prototype.getTime, observed, [])
  } catch {
    return failIntegrityEvidence()
  }
  if (
    typeof milliseconds !== 'number' ||
    !Number.isSafeInteger(milliseconds)
  ) return failIntegrityEvidence()
  try {
    return new Date(milliseconds).toISOString()
  } catch {
    return failIntegrityEvidence()
  }
}

/** Reads one exact finite integrity comparison purpose. */
function readIntegrityPurpose(
  value: unknown,
): WorkspaceSearchMigrationRehearsalRollbackIntegrityPurpose {
  if (
    value === 'partial-rollback' ||
    value === 'complete-rollback'
  ) {
    return value
  }
  return failIntegrityEvidence()
}

/** Strictly parses and authenticates one complete canonical #163 result file. */
function readAuthenticatedResult(
  value: unknown,
  digestKey: Uint8Array,
): AuthenticatedIntegrityResultFile {
  let bytes: Uint8Array | undefined
  try {
    bytes = copyCanonicalResultBytes(value)
    const byteLength = bytes.byteLength
    const contentDigest = createHash('sha256').update(bytes).digest('hex')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsedValue: unknown = JSON.parse(text)
    const parsed = parseCrossDomainIntegrityResult(parsedValue)
    const canonicalText = `${JSON.stringify(parsed, undefined, 2)}\n`
    if (canonicalText !== text) {
      return failIntegrityEvidence()
    }
    if (!verifyCrossDomainIntegrityResult(parsed, digestKey)) {
      return failIntegrityEvidence()
    }
    return Object.freeze({
      result: parsed,
      contentDigest,
      byteLength,
    })
  } catch {
    return failIntegrityEvidence()
  } finally {
    zeroizeDigestKey(bytes)
  }
}

/** Creates one rich raw-file binding from an authenticated result. */
function createResultFileBinding(
  file: AuthenticatedIntegrityResultFile,
  result: IntegrityResultDigestBinding,
): WorkspaceSearchMigrationRehearsalIntegrityResultFileBinding {
  return Object.freeze({
    checkedAt: file.result.checkedAt,
    contentDigest: file.contentDigest,
    byteLength: file.byteLength,
    resultDigest: result.resultDigest,
    resultMac: result.resultMac,
    runtimeProvenance: Object.freeze({
      ...requireLiveRuntimeProvenance(file.result),
    }),
    resourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    resourceIdentities: Object.freeze(
      file.result.evidence.resourceIdentities.map((identity) =>
        Object.freeze({ ...identity })
      ),
    ),
    integrityAggregateDigest: file.result.evidence.aggregateDigest,
    resourceIdentityDigest: file.result.evidence.resourceIdentityDigest,
  })
}

/**
 * Requires one passing rehearsal candidate to be a live source observation.
 *
 * @param result - Strictly parsed and HMAC-authenticated #163 result.
 * @param expectedResourceIdentityDigest - Permit/manifest resource identity.
 * @returns Exact authenticated live-runtime provenance.
 */
function requireLiveSourceResult(
  result: CrossDomainIntegrityResult,
  expectedResourceIdentityDigest: string,
): CrossDomainIntegrityRehearsalLiveRuntimeProvenance {
  const provenance = requireLiveRuntimeProvenance(result)
  if (
    result.role !== 'source' ||
    result.evidence.resourceIdentityScheme !==
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME ||
    result.evidence.resourceIdentityDigest !== expectedResourceIdentityDigest
  ) {
    return failIntegrityEvidence()
  }
  return provenance
}

/**
 * Returns the exact live provenance or rejects a logical/backdated result.
 *
 * @param result - Strictly parsed and HMAC-authenticated result.
 * @returns Exact authenticated live runtime provenance.
 */
function requireLiveRuntimeProvenance(
  result: CrossDomainIntegrityResult,
): CrossDomainIntegrityRehearsalLiveRuntimeProvenance {
  const provenance = result.runtimeProvenance
  if (
    provenance === undefined ||
    provenance.kind !==
      CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND ||
    provenance.version !== 1 ||
    provenance.mode !== 'migration-rehearsal-live' ||
    provenance.completedAt !== result.checkedAt ||
    provenance.checkedAtSource !==
      'trusted-wall-clock-after-external-reads'
  ) {
    return failIntegrityEvidence()
  }
  return provenance
}

/** Requires both observations to be ordered inside the inclusive pair window. */
function requireCheckedAtWindow(
  before: CrossDomainIntegrityResult,
  after: CrossDomainIntegrityResult,
  beforeRuntimeProvenance:
    CrossDomainIntegrityRehearsalLiveRuntimeProvenance,
  afterRuntimeProvenance:
    CrossDomainIntegrityRehearsalLiveRuntimeProvenance,
  window: IntegrityEvidenceWindow,
): void {
  if (
    Date.parse(beforeRuntimeProvenance.startedAt) <
      Date.parse(window.startedAt) ||
    Date.parse(before.checkedAt) >= Date.parse(window.applyStartedAt) ||
    Date.parse(afterRuntimeProvenance.startedAt) <=
      Date.parse(window.terminalAt) ||
    Date.parse(after.checkedAt) > Date.parse(window.completedAt) ||
    Date.parse(before.checkedAt) >= Date.parse(after.checkedAt)
  ) {
    return failIntegrityEvidence()
  }
}

/** Creates one frozen binding without retaining raw #163 result fields. */
function createResultBinding(
  result: CrossDomainIntegrityResult,
): IntegrityResultDigestBinding {
  return Object.freeze({
    resultDigest: createMigrationDigest(result),
    resultMac: result.resultMac,
  })
}

/** Copies one exact bounded canonical-result byte buffer without aliases. */
function copyCanonicalResultBytes(value: unknown): Uint8Array {
  if (
    !types.isUint8Array(value) ||
    types.isProxy(value)
  ) {
    return failIntegrityEvidence()
  }
  const buffer = integrityGuards.readIntrinsicBuffer(value)
  const byteLength = integrityGuards.readIntrinsicByteLength(value)
  if (
    types.isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RESULT_MAX_BYTES
  ) {
    return failIntegrityEvidence()
  }
  const copy = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, copy, [value])
  } catch {
    zeroizeDigestKey(copy)
    return failIntegrityEvidence()
  }
  return copy
}

/** Copies the exact transferred key without retaining caller-owned storage. */
function copyOwnedDigestKey(value: Uint8Array): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    types.isProxy(value) ||
    types.isSharedArrayBuffer(
      integrityGuards.readIntrinsicBuffer(value),
    ) ||
    integrityGuards.readIntrinsicByteLength(value) !==
      integrityDigestKeyByteLength
  ) {
    return failIntegrityEvidence()
  }
  try {
    const copied: unknown = Reflect.apply(
      Uint8Array.prototype.slice,
      value,
      [],
    )
    if (
      !(copied instanceof Uint8Array) ||
      copied.byteLength !== integrityDigestKeyByteLength
    ) {
      return failIntegrityEvidence()
    }
    return copied
  } catch {
    return failIntegrityEvidence()
  }
}

/** Best-effort overwrites one owned key buffer without invoking own methods. */
function zeroizeDigestKey(value: Uint8Array | undefined): void {
  if (value === undefined || types.isProxy(value)) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // A malformed caller value is rejected by the stable outer boundary.
  }
}

/** Raises the sole stable failure without retaining a lower-level cause. */
function failIntegrityEvidence(): never {
  throw new WorkspaceSearchMigrationRehearsalIntegrityEvidenceError()
}
