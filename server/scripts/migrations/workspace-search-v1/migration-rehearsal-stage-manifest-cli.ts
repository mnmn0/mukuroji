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
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS,
  type WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'
import {
  readWorkspaceSearchMigrationRehearsalPermitSigningKey,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_OUTPUT_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_SIGNING_KEY_BYTES,
  writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
  type WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome,
} from './migration-rehearsal-permit-cli'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
} from './migration-rehearsal-private-input'
import {
  verifyWorkspaceSearchMigrationRehearsalPermit,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationRehearsalPermitClaims,
} from './migration-rehearsal-permit'
import {
  createWorkspaceSearchMigrationRehearsalStageManifest,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
  type WorkspaceSearchMigrationRehearsalStageCommand,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageManifestClaims,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageOutcome,
} from './migration-rehearsal-stage-manifest'

/** Exact acknowledgement required to issue one reviewed stage manifest. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_ISSUANCE_APPROVAL =
  'issue-reviewed-non-production-migration-rehearsal-stage-manifest'

/** Stable discriminator for stage-manifest CLI result lines. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_CLI_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-manifest-issuance-result'

/** Maximum canonical UTF-8 bytes accepted for reviewed manifest claims. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_CLAIMS_MAX_BYTES =
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES

/** Maximum canonical UTF-8 bytes published through the shared secure writer. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_OUTPUT_MAX_BYTES =
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_OUTPUT_MAX_BYTES

/** Strictly parsed explicit stage-manifest issuance command. */
export type WorkspaceSearchMigrationRehearsalStageManifestCliArguments = {
  /** Exact reviewed canonical stage-manifest claims file path. */
  readonly claimsFile: string
  /** Exact canonical authenticated rehearsal permit file path. */
  readonly permitFile: string
  /** Exact restricted raw manifest signing-key file path. */
  readonly signingKeyFile: string
  /** New final manifest path that must not already exist. */
  readonly outputFile: string
  /** Exact stage-manifest issuance acknowledgement. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_ISSUANCE_APPROVAL
}

/** Injectable finite I/O boundary for reviewed stage-manifest issuance. */
export type WorkspaceSearchMigrationRehearsalStageManifestCliDependencies = {
  /** Supplies trusted current time for permit-active issuance checks. */
  readonly clock: () => Date
  /** Reads one stable owner-only no-follow file through a byte ceiling. */
  readonly readInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Reads one exact owner-only raw key through the secure no-follow reader. */
  readonly readSigningKeyFile: (path: string) => Promise<Uint8Array>
  /** Exclusively creates and durably syncs one canonical private manifest. */
  readonly writeManifestFileExclusive: (
    outputPath: string,
    manifestBytes: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome>
  /** Emits one already canonical secret-free success line. */
  readonly writeStdoutLine: (serializedLine: string) => void
  /** Emits one already canonical secret-free failure line. */
  readonly writeStderrLine: (serializedLine: string) => void
}

/** Process statuses used by the stage-manifest issuance wrapper. */
export type WorkspaceSearchMigrationRehearsalStageManifestCliExitCode =
  | 0
  | 1
  | 2

/** Stable raw-value-free stage-manifest issuance failures. */
type WorkspaceSearchMigrationRehearsalStageManifestCliFailureCode =
  | 'INVALID_CLAIMS_FILE'
  | 'INVALID_PERMIT_FILE'
  | 'INVALID_SIGNING_KEY'
  | 'INVALID_USAGE'
  | 'OPERATION_FAILED'
  | 'OUTPUT_FILE_EXISTS'
  | 'OUTPUT_FILE_WRITE_FAILED'
  | 'PERMIT_MISMATCH'

/** Private raw-value-free stage-manifest issuance failure. */
class WorkspaceSearchMigrationRehearsalStageManifestCliFailure extends Error {
  /** Stable machine-readable classification. */
  readonly code:
    WorkspaceSearchMigrationRehearsalStageManifestCliFailureCode

  /** Exact process status paired with the classification. */
  readonly exitCode:
    WorkspaceSearchMigrationRehearsalStageManifestCliExitCode

  /**
   * Creates one stable stage-manifest issuance failure.
   *
   * @param code - Raw-value-free failure classification.
   * @param exitCode - Exact process exit status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalStageManifestCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalStageManifestCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalStageManifestCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Exact canonical stage-manifest claim fields. */
const stageManifestClaimKeys = Object.freeze([
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

/** Exact canonical fields for one reviewed stage entry. */
const stageManifestEntryKeys = Object.freeze([
  'attemptOrdinal',
  'command',
  'controlArgumentsDigest',
  'expectedOutcome',
  'faultPlanDigest',
  'ordinal',
  'scenario',
  'scenarioStageOrdinal',
])

/** Default finite filesystem and process-output boundary. */
const defaultStageManifestCliDependencies:
  WorkspaceSearchMigrationRehearsalStageManifestCliDependencies =
    Object.freeze({
      clock: (): Date => new Date(),
      readInputFile:
        readWorkspaceSearchMigrationRehearsalPrivateInputFile,
      readSigningKeyFile: (path): Promise<Uint8Array> =>
        readWorkspaceSearchMigrationRehearsalPermitSigningKey(path),
      writeManifestFileExclusive:
        writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
      writeStdoutLine: (serializedLine: string): void => {
        console.log(serializedLine)
      },
      writeStderrLine: (serializedLine: string): void => {
        console.error(serializedLine)
      },
    })

/**
 * Parses only the exact ordered reviewed stage-manifest issuance command.
 *
 * @param arguments_ - Arguments following the stage-manifest CLI script path.
 * @returns Frozen detached explicit inputs, output, and approval.
 */
export function parseWorkspaceSearchMigrationRehearsalStageManifestCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalStageManifestCliArguments {
  const snapshot = snapshotStageManifestCliArguments(arguments_)
  if (
    snapshot[0] !== '--claims-file' ||
    snapshot[2] !== '--permit-file' ||
    snapshot[4] !== '--signing-key-file' ||
    snapshot[6] !== '--output-file' ||
    snapshot[8] !== '--approval' ||
    snapshot[9] !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_ISSUANCE_APPROVAL
  ) {
    throw invalidStageManifestCliUsage()
  }
  return Object.freeze({
    claimsFile: requireStageManifestCliPath(snapshot[1]),
    permitFile: requireStageManifestCliPath(snapshot[3]),
    signingKeyFile: requireStageManifestCliPath(snapshot[5]),
    outputFile: requireStageManifestCliPath(snapshot[7]),
    approval:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_ISSUANCE_APPROVAL,
  })
}

/**
 * Validates and detaches one exact reviewed stage-manifest claims value.
 *
 * @param candidate - Untrusted decoded claims value.
 * @returns Frozen detached exact stage-manifest claims.
 */
export function parseWorkspaceSearchMigrationRehearsalStageManifestClaims(
  candidate: unknown,
): WorkspaceSearchMigrationRehearsalStageManifestClaims {
  try {
    const record = requireStageManifestOrdinaryRecord(
      candidate,
      invalidClaimsFile,
    )
    requireStageManifestExactKeys(
      record,
      stageManifestClaimKeys,
      invalidClaimsFile,
    )
    const kind = readStageManifestDataProperty(
      record,
      'kind',
      invalidClaimsFile,
    )
    const manifestVersion = readStageManifestDataProperty(
      record,
      'manifestVersion',
      invalidClaimsFile,
    )
    const stage = readStageManifestDataProperty(
      record,
      'stage',
      invalidClaimsFile,
    )
    if (
      kind !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND ||
      manifestVersion !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION ||
      stage !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
    ) {
      throw invalidClaimsFile()
    }
    const commit = readStageManifestCommit(
      readStageManifestDataProperty(record, 'commit', invalidClaimsFile),
      invalidClaimsFile,
    )
    const deploymentTrustRootDigest = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'deploymentTrustRootDigest',
        invalidClaimsFile,
      ),
      invalidClaimsFile,
    )
    const permitDigest = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'permitDigest',
        invalidClaimsFile,
      ),
      invalidClaimsFile,
    )
    const evidenceKeyDigest = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'evidenceKeyDigest',
        invalidClaimsFile,
      ),
      invalidClaimsFile,
    )
    const publicationKeyDigest = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'publicationKeyDigest',
        invalidClaimsFile,
      ),
      invalidClaimsFile,
    )
    const requestedResourcesBinding = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'requestedResourcesBinding',
        invalidClaimsFile,
      ),
      invalidClaimsFile,
    )
    const integrityResourceIdentityScheme =
      readStageManifestResourceIdentityScheme(
        readStageManifestDataProperty(
          record,
          'integrityResourceIdentityScheme',
          invalidClaimsFile,
        ),
      )
    const integrityResourceIdentities =
      readStageManifestResourceIdentities(
        readStageManifestDataProperty(
          record,
          'integrityResourceIdentities',
          invalidClaimsFile,
        ),
      )
    const integrityResourceIdentityDigest = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'integrityResourceIdentityDigest',
        invalidClaimsFile,
      ),
      invalidClaimsFile,
    )
    const configurationBindingDigest = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'configurationBindingDigest',
        invalidClaimsFile,
      ),
      invalidClaimsFile,
    )
    const policyVersion = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'policyVersion',
        invalidClaimsFile,
      ),
      invalidClaimsFile,
    )
    const reviewedAt = readStageManifestTimestamp(
      readStageManifestDataProperty(
        record,
        'reviewedAt',
        invalidClaimsFile,
      ),
      invalidClaimsFile,
    )
    const entries = readStageManifestEntries(
      readStageManifestDataProperty(record, 'entries', invalidClaimsFile),
    )
    return Object.freeze({
      kind,
      manifestVersion,
      stage,
      commit,
      deploymentTrustRootDigest,
      permitDigest,
      evidenceKeyDigest,
      publicationKeyDigest,
      requestedResourcesBinding,
      integrityResourceIdentityScheme,
      integrityResourceIdentities,
      integrityResourceIdentityDigest,
      configurationBindingDigest,
      policyVersion,
      reviewedAt,
      entries,
    })
  } catch {
    throw invalidClaimsFile()
  }
}

/**
 * Issues one authenticated reviewed stage manifest without AWS capability.
 *
 * Both the reader-owned key buffer and the issuance-local key copy are
 * zeroized on every path after they become available.
 *
 * @param arguments_ - Exact ordered operator command.
 * @param dependencies - Injectable finite file and output boundary.
 * @returns Stable stage-manifest issuance process status.
 */
export async function runWorkspaceSearchMigrationRehearsalStageManifestCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalStageManifestCliDependencies =
      defaultStageManifestCliDependencies,
): Promise<WorkspaceSearchMigrationRehearsalStageManifestCliExitCode> {
  let writeStdoutLine = defaultStageManifestCliDependencies.writeStdoutLine
  let writeStderrLine = defaultStageManifestCliDependencies.writeStderrLine
  let callerKey: Uint8Array | undefined
  let localKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  try {
    const capturedDependencies = snapshotStageManifestCliDependencies(
      dependencies,
    )
    writeStdoutLine = capturedDependencies.writeStdoutLine
    writeStderrLine = capturedDependencies.writeStderrLine
    const configuration =
      parseWorkspaceSearchMigrationRehearsalStageManifestCliArguments(
        arguments_,
      )
    const claimsBytes = await readStageManifestCliInputFile(
      configuration.claimsFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_CLAIMS_MAX_BYTES,
      capturedDependencies,
      invalidClaimsFile,
    )
    const claimsValue = parseCanonicalStageManifestCliDocument(
      claimsBytes,
      invalidClaimsFile,
    )
    const claims =
      parseWorkspaceSearchMigrationRehearsalStageManifestClaims(claimsValue)
    const permitBytes = await readStageManifestCliInputFile(
      configuration.permitFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_OUTPUT_MAX_BYTES,
      capturedDependencies,
      invalidPermitFile,
    )
    const permitValue = parseCanonicalStageManifestCliDocument(
      permitBytes,
      invalidPermitFile,
    )
    callerKey = await readStageManifestCliSigningKey(
      configuration.signingKeyFile,
      capturedDependencies,
    )
    const permitBindings = readStageManifestPermitBindings(permitValue)
    const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(callerKey)
    localKey = derivedKeys.runtimeKey
    publicationKey = derivedKeys.publicationKey
    zeroizeStageManifestCliKey(callerKey)
    callerKey = undefined
    if (
      derivedKeys.runtimeKeyDigest !== permitBindings.evidenceKeyDigest ||
      derivedKeys.publicationKeyDigest !==
        permitBindings.publicationKeyDigest ||
      claims.evidenceKeyDigest !== derivedKeys.runtimeKeyDigest ||
      claims.publicationKeyDigest !== derivedKeys.publicationKeyDigest
    ) {
      throw invalidSigningKey()
    }
    const permit = verifyStageManifestPermit(
      permitValue,
      permitBindings,
      readStageManifestCliCurrentTime(capturedDependencies.clock),
      localKey,
    )
    requireStageManifestPermitBinding(claims, permitValue, permit)
    let manifest: WorkspaceSearchMigrationRehearsalStageManifest
    try {
      manifest = createWorkspaceSearchMigrationRehearsalStageManifest({
        claims,
        signingKey: localKey,
      })
    } catch {
      throw invalidClaimsFile()
    }
    const manifestBytes = new TextEncoder().encode(
      serializeCanonicalJson(manifest),
    )
    if (
      manifestBytes.byteLength === 0 ||
      manifestBytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_OUTPUT_MAX_BYTES
    ) {
      throw outputFileWriteFailed()
    }
    verifyStageManifestPermit(
      permitValue,
      permitBindings,
      readStageManifestCliCurrentTime(capturedDependencies.clock),
      localKey,
    )
    let writeOutcome:
      WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome
    try {
      writeOutcome = await capturedDependencies.writeManifestFileExclusive(
        configuration.outputFile,
        manifestBytes,
      )
    } catch {
      throw outputFileWriteFailed()
    }
    if (writeOutcome === 'exists') throw outputFileExists()
    if (writeOutcome !== 'created' && writeOutcome !== 'reconciled') {
      throw outputFileWriteFailed()
    }
    writeStdoutLine(serializeCanonicalJson({
      entryCount: manifest.entries.length,
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_CLI_RESULT_KIND,
      manifestDigest: createMigrationDigest(manifest),
    }))
    return 0
  } catch (error: unknown) {
    const failure = classifyStageManifestCliFailure(error)
    writeStageManifestCliFailureLine(writeStderrLine, failure.code)
    return failure.exitCode
  } finally {
    zeroizeWorkspaceSearchMigrationRehearsalKey(publicationKey)
    zeroizeStageManifestCliKey(localKey)
    zeroizeStageManifestCliKey(callerKey)
  }
}

/** Reads and validates every exact reviewed stage entry. */
function readStageManifestEntries(
  value: unknown,
): readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw invalidClaimsFile()
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const lengthValue = lengthDescriptor?.value
  if (
    typeof lengthValue !== 'number' ||
    !Number.isSafeInteger(lengthValue) ||
    lengthValue <= 0 ||
    lengthValue >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES
  ) {
    throw invalidClaimsFile()
  }
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== lengthValue + 1) throw invalidClaimsFile()
  const entries: WorkspaceSearchMigrationRehearsalStageManifestEntry[] = []
  for (let index = 0; index < lengthValue; index += 1) {
    entries.push(readStageManifestEntry(
      readStageManifestDataProperty(
        value,
        String(index),
        invalidClaimsFile,
      ),
    ))
  }
  return Object.freeze(entries)
}

/** Reads one exact reviewed stage entry without retaining caller objects. */
function readStageManifestEntry(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageManifestEntry {
  const record = requireStageManifestOrdinaryRecord(
    value,
    invalidClaimsFile,
  )
  requireStageManifestExactKeys(
    record,
    stageManifestEntryKeys,
    invalidClaimsFile,
  )
  const ordinal = readStageManifestPositiveInteger(
    readStageManifestDataProperty(record, 'ordinal', invalidClaimsFile),
  )
  const scenario = readStageManifestScenario(
    readStageManifestDataProperty(record, 'scenario', invalidClaimsFile),
  )
  const scenarioStageOrdinal = readStageManifestPositiveInteger(
    readStageManifestDataProperty(
      record,
      'scenarioStageOrdinal',
      invalidClaimsFile,
    ),
  )
  const command = readStageManifestCommand(
    readStageManifestDataProperty(record, 'command', invalidClaimsFile),
  )
  const controlArgumentsDigest = readStageManifestDigest(
    readStageManifestDataProperty(
      record,
      'controlArgumentsDigest',
      invalidClaimsFile,
    ),
    invalidClaimsFile,
  )
  const attemptOrdinal = readStageManifestPositiveInteger(
    readStageManifestDataProperty(
      record,
      'attemptOrdinal',
      invalidClaimsFile,
    ),
  )
  const faultPlanDigest = readStageManifestNullableDigest(
    readStageManifestDataProperty(
      record,
      'faultPlanDigest',
      invalidClaimsFile,
    ),
  )
  const expectedOutcome = readStageManifestOutcome(
    readStageManifestDataProperty(
      record,
      'expectedOutcome',
      invalidClaimsFile,
    ),
  )
  return Object.freeze({
    ordinal,
    scenario,
    scenarioStageOrdinal,
    command,
    controlArgumentsDigest,
    attemptOrdinal,
    faultPlanDigest,
    expectedOutcome,
  })
}

/** Reads only the untrusted permit fields required to invoke verification. */
function readStageManifestPermitBindings(
  value: unknown,
): Readonly<Pick<
  WorkspaceSearchMigrationRehearsalPermitClaims,
  | 'account'
  | 'commit'
  | 'deploymentTrustRootDigest'
  | 'evidenceKeyDigest'
  | 'integrityResourceIdentityDigest'
  | 'region'
  | 'requestedResourcesBinding'
  | 'publicationKeyDigest'
>> {
  try {
    const record = requireStageManifestOrdinaryRecord(
      value,
      invalidPermitFile,
    )
    const account = readStageManifestString(
      readStageManifestDataProperty(record, 'account', invalidPermitFile),
      invalidPermitFile,
    )
    const region = readStageManifestString(
      readStageManifestDataProperty(record, 'region', invalidPermitFile),
      invalidPermitFile,
    )
    const commit = readStageManifestCommit(
      readStageManifestDataProperty(record, 'commit', invalidPermitFile),
      invalidPermitFile,
    )
    const deploymentTrustRootDigest = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'deploymentTrustRootDigest',
        invalidPermitFile,
      ),
      invalidPermitFile,
    )
    const requestedResourcesBinding = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'requestedResourcesBinding',
        invalidPermitFile,
      ),
      invalidPermitFile,
    )
    const evidenceKeyDigest = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'evidenceKeyDigest',
        invalidPermitFile,
      ),
      invalidPermitFile,
    )
    const publicationKeyDigest = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'publicationKeyDigest',
        invalidPermitFile,
      ),
      invalidPermitFile,
    )
    const integrityResourceIdentityDigest = readStageManifestDigest(
      readStageManifestDataProperty(
        record,
        'integrityResourceIdentityDigest',
        invalidPermitFile,
      ),
      invalidPermitFile,
    )
    return Object.freeze({
      account,
      region,
      commit,
      deploymentTrustRootDigest,
      requestedResourcesBinding,
      evidenceKeyDigest,
      publicationKeyDigest,
      integrityResourceIdentityDigest,
    })
  } catch {
    throw invalidPermitFile()
  }
}

/** Authenticates one canonical permit at a trusted issuance time. */
function verifyStageManifestPermit(
  permitValue: unknown,
  bindings: ReturnType<typeof readStageManifestPermitBindings>,
  currentTime: Date,
  verificationKey: Uint8Array,
): Readonly<WorkspaceSearchMigrationRehearsalPermitClaims> {
  try {
    return verifyWorkspaceSearchMigrationRehearsalPermit({
      permit: permitValue,
      verificationKey,
      account: bindings.account,
      region: bindings.region,
      commit: bindings.commit,
      requestedResourcesBinding: bindings.requestedResourcesBinding,
      currentTime,
    })
  } catch {
    throw invalidPermitFile()
  }
}

/** Requires the reviewed manifest to match its authenticated permit exactly. */
function requireStageManifestPermitBinding(
  claims: WorkspaceSearchMigrationRehearsalStageManifestClaims,
  permitValue: unknown,
  permit: Readonly<WorkspaceSearchMigrationRehearsalPermitClaims>,
): void {
  const reviewedAtMilliseconds = Date.parse(claims.reviewedAt)
  if (
    claims.stage !== permit.stage ||
    claims.commit !== permit.commit ||
    claims.deploymentTrustRootDigest !==
      permit.deploymentTrustRootDigest ||
    claims.permitDigest !== createMigrationDigest(permitValue) ||
    claims.requestedResourcesBinding !==
      permit.requestedResourcesBinding ||
    claims.integrityResourceIdentityScheme !==
      permit.integrityResourceIdentityScheme ||
    !sameStageManifestResourceIdentities(
      claims.integrityResourceIdentities,
      permit.integrityResourceIdentities,
    ) ||
    claims.integrityResourceIdentityDigest !==
      permit.integrityResourceIdentityDigest ||
    claims.evidenceKeyDigest !== permit.evidenceKeyDigest ||
    claims.publicationKeyDigest !== permit.publicationKeyDigest ||
    reviewedAtMilliseconds < Date.parse(permit.issuedAt) ||
    reviewedAtMilliseconds >= Date.parse(permit.expiresAt)
  ) {
    throw permitMismatch()
  }
}

/** Captures every injected effect before the first file-system await. */
function snapshotStageManifestCliDependencies(
  dependencies: WorkspaceSearchMigrationRehearsalStageManifestCliDependencies,
): WorkspaceSearchMigrationRehearsalStageManifestCliDependencies {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    nodeUtilTypes.isProxy(dependencies)
  ) {
    throw operationFailed()
  }
  let readInputFile:
    WorkspaceSearchMigrationRehearsalStageManifestCliDependencies[
      'readInputFile'
    ]
  let clock:
    WorkspaceSearchMigrationRehearsalStageManifestCliDependencies['clock']
  let readSigningKeyFile:
    WorkspaceSearchMigrationRehearsalStageManifestCliDependencies[
      'readSigningKeyFile'
    ]
  let writeManifestFileExclusive:
    WorkspaceSearchMigrationRehearsalStageManifestCliDependencies[
      'writeManifestFileExclusive'
    ]
  let writeStdoutLine:
    WorkspaceSearchMigrationRehearsalStageManifestCliDependencies[
      'writeStdoutLine'
    ]
  let writeStderrLine:
    WorkspaceSearchMigrationRehearsalStageManifestCliDependencies[
      'writeStderrLine'
    ]
  try {
    clock = dependencies.clock
    readInputFile = dependencies.readInputFile
    readSigningKeyFile = dependencies.readSigningKeyFile
    writeManifestFileExclusive = dependencies.writeManifestFileExclusive
    writeStdoutLine = dependencies.writeStdoutLine
    writeStderrLine = dependencies.writeStderrLine
  } catch {
    throw operationFailed()
  }
  if (
    !isDirectStageManifestCliFunction(clock) ||
    !isDirectStageManifestCliFunction(readInputFile) ||
    !isDirectStageManifestCliFunction(readSigningKeyFile) ||
    !isDirectStageManifestCliFunction(writeManifestFileExclusive) ||
    !isDirectStageManifestCliFunction(writeStdoutLine) ||
    !isDirectStageManifestCliFunction(writeStderrLine)
  ) {
    throw operationFailed()
  }
  return Object.freeze({
    clock: () => clock(),
    readInputFile: (path, maximumBytes) =>
      readInputFile(path, maximumBytes),
    readSigningKeyFile: (path) => readSigningKeyFile(path),
    writeManifestFileExclusive: (outputPath, manifestBytes) =>
      writeManifestFileExclusive(outputPath, manifestBytes),
    writeStdoutLine: (line) => writeStdoutLine(line),
    writeStderrLine: (line) => writeStderrLine(line),
  })
}

/**
 * Samples and detaches one valid trusted wall-clock value.
 *
 * @param clock - Captured direct issuance clock.
 * @returns Fresh finite Date detached from the injected instance.
 */
function readStageManifestCliCurrentTime(clock: () => Date): Date {
  let value: Date
  try {
    value = clock()
  } catch {
    throw operationFailed()
  }
  if (
    !(value instanceof Date) ||
    nodeUtilTypes.isProxy(value) ||
    !Number.isFinite(value.getTime())
  ) {
    throw operationFailed()
  }
  return new Date(value.getTime())
}

/** Checks one injected effect without permitting callable Proxy traps. */
function isDirectStageManifestCliFunction(
  value: unknown,
): value is (...arguments_: readonly never[]) => unknown {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/** Reads one bounded input and normalizes every reader failure. */
async function readStageManifestCliInputFile(
  path: string,
  maximumBytes: number,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageManifestCliDependencies,
    'readInputFile'
  >,
  fail: () => WorkspaceSearchMigrationRehearsalStageManifestCliFailure,
): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    bytes = await dependencies.readInputFile(path, maximumBytes)
  } catch {
    throw fail()
  }
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes
  ) {
    throw fail()
  }
  let copied: unknown
  try {
    copied = Reflect.apply(Uint8Array.prototype.slice, bytes, [])
  } catch {
    throw fail()
  }
  if (!(copied instanceof Uint8Array)) throw fail()
  return copied
}

/** Parses one already bounded exact canonical JSON document. */
function parseCanonicalStageManifestCliDocument(
  bytes: Uint8Array,
  fail: () => WorkspaceSearchMigrationRehearsalStageManifestCliFailure,
): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const candidate: unknown = JSON.parse(text)
    const canonicalBytes = new TextEncoder().encode(
      serializeCanonicalJson(candidate),
    )
    if (!equalStageManifestCliBytes(bytes, canonicalBytes)) throw fail()
    return candidate
  } catch {
    throw fail()
  }
}

/** Reads one exact reader-owned raw key for final zeroization. */
async function readStageManifestCliSigningKey(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalStageManifestCliDependencies,
    'readSigningKeyFile'
  >,
): Promise<Uint8Array> {
  let key: Uint8Array
  try {
    key = await dependencies.readSigningKeyFile(path)
  } catch {
    throw invalidSigningKey()
  }
  if (
    !(key instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(key) ||
    key.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_SIGNING_KEY_BYTES
  ) {
    zeroizeStageManifestCliKey(
      key instanceof Uint8Array && !nodeUtilTypes.isProxy(key)
        ? key
        : undefined,
    )
    throw invalidSigningKey()
  }
  return key
}

/** Reads one ordinary, non-accessor-backed untrusted record. */
function requireStageManifestOrdinaryRecord(
  value: unknown,
  fail: () => WorkspaceSearchMigrationRehearsalStageManifestCliFailure,
): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw fail()
  }
  return value
}

/** Requires one record to contain exactly the expected own string keys. */
function requireStageManifestExactKeys(
  record: object,
  expectedKeys: readonly string[],
  fail: () => WorkspaceSearchMigrationRehearsalStageManifestCliFailure,
): void {
  const observedKeys = Reflect.ownKeys(record)
  if (
    observedKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !observedKeys.includes(key))
  ) {
    throw fail()
  }
}

/** Reads one enumerable own data property without invoking accessors. */
function readStageManifestDataProperty(
  record: object,
  property: string,
  fail: () => WorkspaceSearchMigrationRehearsalStageManifestCliFailure,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, property)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    throw fail()
  }
  return descriptor.value
}

/** Reads one non-empty untrusted string. */
function readStageManifestString(
  value: unknown,
  fail: () => WorkspaceSearchMigrationRehearsalStageManifestCliFailure,
): string {
  if (typeof value !== 'string' || value.length === 0) throw fail()
  return value
}

/** Reads one exact lowercase Git commit OID. */
function readStageManifestCommit(
  value: unknown,
  fail: () => WorkspaceSearchMigrationRehearsalStageManifestCliFailure,
): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    throw fail()
  }
  return value
}

/** Reads one conventional lowercase digest. */
function readStageManifestDigest(
  value: unknown,
  fail: () => WorkspaceSearchMigrationRehearsalStageManifestCliFailure,
): string {
  if (!isHexDigest(value)) throw fail()
  return value
}

/** Reads the sole immutable-incarnation scheme accepted by reviewed claims. */
function readStageManifestResourceIdentityScheme(
  value: unknown,
): typeof CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME {
  if (
    value !== CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  ) throw invalidClaimsFile()
  return value
}

/** Reads one detached canonical resource-identity vector from reviewed claims. */
function readStageManifestResourceIdentities(
  value: unknown,
): readonly CrossDomainIntegrityResourceIdentity[] {
  try {
    return parseCrossDomainIntegrityResourceIdentities(value)
  } catch {
    throw invalidClaimsFile()
  }
}

/** Compares two canonical resource-identity vectors entry by entry. */
function sameStageManifestResourceIdentities(
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

/** Reads one nullable conventional digest. */
function readStageManifestNullableDigest(value: unknown): string | null {
  if (value === null) return null
  return readStageManifestDigest(value, invalidClaimsFile)
}

/** Reads one canonical timestamp. */
function readStageManifestTimestamp(
  value: unknown,
  fail: () => WorkspaceSearchMigrationRehearsalStageManifestCliFailure,
): string {
  if (!isCanonicalTimestamp(value)) throw fail()
  return value
}

/** Reads one positive safe integer. */
function readStageManifestPositiveInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw invalidClaimsFile()
  }
  return value
}

/** Reads one canonical rehearsal scenario. */
function readStageManifestScenario(
  value: unknown,
): WorkspaceSearchMigrationRehearsalScenarioName {
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    if (value === scenario) return scenario
  }
  throw invalidClaimsFile()
}

/** Reads one existing mutating control command. */
function readStageManifestCommand(
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
  throw invalidClaimsFile()
}

/** Reads one finite authenticated stage outcome. */
function readStageManifestOutcome(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageOutcome {
  if (
    value === 'completed' ||
    value === 'fault-reached' ||
    value === 'response-loss-reconciled' ||
    value === 'takeover-completed'
  ) return value
  throw invalidClaimsFile()
}

/** Copies every CLI argument before reading positional flags. */
function snapshotStageManifestCliArguments(
  arguments_: readonly string[],
): readonly string[] {
  let length: number
  try {
    length = arguments_.length
  } catch {
    throw invalidStageManifestCliUsage()
  }
  if (length !== 10) throw invalidStageManifestCliUsage()
  const snapshot: string[] = []
  try {
    for (let index = 0; index < length; index += 1) {
      const value = arguments_[index]
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 8_192 ||
        value.includes('\0')
      ) {
        throw invalidStageManifestCliUsage()
      }
      snapshot.push(value)
    }
  } catch {
    throw invalidStageManifestCliUsage()
  }
  return Object.freeze(snapshot)
}

/** Requires one bounded nonblank explicit path without resolving it. */
function requireStageManifestCliPath(value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.includes('\0') ||
    value.length > 4_096
  ) {
    throw invalidStageManifestCliUsage()
  }
  return value
}

/** Compares two non-secret byte vectors without string conversion. */
function equalStageManifestCliBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Zeroizes one direct key buffer without masking the primary outcome. */
function zeroizeStageManifestCliKey(key: Uint8Array | undefined): void {
  if (key === undefined) return
  try {
    Uint8Array.prototype.fill.call(key, 0)
  } catch {
    // The primary issuance outcome remains authoritative.
  }
}

/** Classifies arbitrary errors without inspecting messages or causes. */
function classifyStageManifestCliFailure(
  error: unknown,
): WorkspaceSearchMigrationRehearsalStageManifestCliFailure {
  if (
    error instanceof
      WorkspaceSearchMigrationRehearsalStageManifestCliFailure
  ) {
    return error
  }
  return operationFailed()
}

/** Emits one stable canonical failure line and drops writer errors. */
function writeStageManifestCliFailureLine(
  writeStderrLine: (serializedLine: string) => void,
  code: WorkspaceSearchMigrationRehearsalStageManifestCliFailureCode,
): void {
  try {
    writeStderrLine(serializeCanonicalJson({
      code,
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_CLI_RESULT_KIND,
      status: 'error',
    }))
  } catch {
    // Raw writer failures never replace the stable exit code.
  }
}

/** Creates one exact strict-command usage failure. */
function invalidStageManifestCliUsage():
  WorkspaceSearchMigrationRehearsalStageManifestCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageManifestCliFailure(
    'INVALID_USAGE',
    2,
  )
}

/** Creates one exact reviewed-claims failure. */
function invalidClaimsFile():
  WorkspaceSearchMigrationRehearsalStageManifestCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageManifestCliFailure(
    'INVALID_CLAIMS_FILE',
    2,
  )
}

/** Creates one exact authenticated-permit input failure. */
function invalidPermitFile():
  WorkspaceSearchMigrationRehearsalStageManifestCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageManifestCliFailure(
    'INVALID_PERMIT_FILE',
    2,
  )
}

/** Creates one exact raw signing-key failure. */
function invalidSigningKey():
  WorkspaceSearchMigrationRehearsalStageManifestCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageManifestCliFailure(
    'INVALID_SIGNING_KEY',
    2,
  )
}

/** Creates one exact authenticated permit-to-manifest mismatch. */
function permitMismatch():
  WorkspaceSearchMigrationRehearsalStageManifestCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageManifestCliFailure(
    'PERMIT_MISMATCH',
    2,
  )
}

/** Creates one exact no-overwrite collision failure. */
function outputFileExists():
  WorkspaceSearchMigrationRehearsalStageManifestCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageManifestCliFailure(
    'OUTPUT_FILE_EXISTS',
    1,
  )
}

/** Creates one exact output durability failure. */
function outputFileWriteFailed():
  WorkspaceSearchMigrationRehearsalStageManifestCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageManifestCliFailure(
    'OUTPUT_FILE_WRITE_FAILED',
    1,
  )
}

/** Creates one exact unexpected operation failure. */
function operationFailed():
  WorkspaceSearchMigrationRehearsalStageManifestCliFailure {
  return new WorkspaceSearchMigrationRehearsalStageManifestCliFailure(
    'OPERATION_FAILED',
    1,
  )
}

if (import.meta.main) {
  void runWorkspaceSearchMigrationRehearsalStageManifestCli(
    Bun.argv.slice(2),
    defaultStageManifestCliDependencies,
  ).then((exitCode) => {
    process.exitCode = exitCode
  })
}
