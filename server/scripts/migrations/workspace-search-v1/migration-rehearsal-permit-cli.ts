import { createHash, timingSafeEqual } from 'node:crypto'
import { constants as fileSystemConstants, type Stats } from 'node:fs'
import { link, open, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { types as nodeUtilTypes } from 'node:util'
import {
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityImmutableResourceIdentities,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
  parseCrossDomainIntegrityResourceAttestation,
  serializeCrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResourceAttestation,
} from '../../data-integrity/cross-domain-integrity'
import {
  isCanonicalTimestamp,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalProductionAccountDigest,
  createWorkspaceSearchMigrationRehearsalPermit,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_MAXIMUM_AGE_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationRehearsalPermitClaims,
} from './migration-rehearsal-permit'
import {
  consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization,
  parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection,
  verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_ATTESTATION_ROOT_MAX_BYTES,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
} from './migration-rehearsal-rate-evidence'
import {
  readBoundedInputFile,
} from './migration-control-cli'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
} from './migration-rehearsal-private-input'

/** Exact operator approval required to issue one reviewed rehearsal permit. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_ISSUANCE_APPROVAL =
  'issue-reviewed-non-production-migration-rehearsal-permit'

/** Stable discriminator for permit-issuance success and failure lines. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-permit-issuance-result'

/** Maximum canonical UTF-8 bytes accepted for one reviewed claims file. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLAIMS_MAX_BYTES =
  64 * 1_024

/** Exact raw byte length required for one permit signing key file. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_SIGNING_KEY_BYTES = 32

/** Exact raw byte length required for the dedicated #163 integrity key. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_INTEGRITY_KEY_BYTES =
  32

/** Maximum canonical UTF-8 bytes written for one authenticated permit. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_OUTPUT_MAX_BYTES =
  64 * 1_024

/** Strictly parsed explicit permit-issuance command. */
export type WorkspaceSearchMigrationRehearsalPermitCliArguments = {
  /** Exact reviewed canonical claims file path. */
  readonly claimsFile: string
  /** Exact restricted raw signing-key file path. */
  readonly signingKeyFile: string
  /** Exact restricted raw dedicated #163 integrity-key file path. */
  readonly integrityKeyFile: string
  /** Exact owner-only canonical immutable resource-attestation path. */
  readonly integrityResourceAttestationFile: string
  /** Exact owner-only canonical authenticated integrity-root path. */
  readonly integrityAttestationRootFile: string
  /** Exact owner-only raw ordinal-zero rate-segment path. */
  readonly integrityRootRateSegmentFile: string
  /** New final permit path that must not already exist. */
  readonly outputFile: string
  /** Exact issuance acknowledgement. */
  readonly approval:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_ISSUANCE_APPROVAL
}

/** Operator-reviewed claims before private resource identities are derived. */
export type WorkspaceSearchMigrationRehearsalPermitIssuanceClaims = Omit<
  WorkspaceSearchMigrationRehearsalPermitClaims,
  'integrityResourceIdentities' | 'integrityResourceIdentityScheme'
>

/** Result of one exclusive durable permit-file publication attempt. */
export type WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome =
  | 'created'
  | 'reconciled'
  | 'exists'

/** Stable security-relevant metadata captured from an opened file handle. */
export type WorkspaceSearchMigrationRehearsalPermitFileStatus = {
  /** Device containing the opened inode. */
  readonly device: number
  /** Inode identifying the opened file within its device. */
  readonly inode: number
  /** Current owner user identifier. */
  readonly ownerUserId: number
  /** Complete POSIX mode including type and special permission bits. */
  readonly mode: number
  /** Current byte length. */
  readonly size: number
  /** Millisecond-resolution last metadata-change time. */
  readonly changedAtMilliseconds: number
  /** Millisecond-resolution last content-modification time. */
  readonly modifiedAtMilliseconds: number
  /** Whether the opened inode is a regular file. */
  readonly regularFile: boolean
}

/** Minimal no-follow readable file used by secure local boundaries. */
export type WorkspaceSearchMigrationRehearsalPermitReadableFile = {
  /** Captures current metadata from the already opened inode. */
  readonly stat: () =>
    Promise<WorkspaceSearchMigrationRehearsalPermitFileStatus>
  /** Reads at most the requested bytes at one explicit file position. */
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<number>
  /** Closes the opened inode. */
  readonly close: () => Promise<void>
}

/** Injectable secure signing-key file boundary. */
export type WorkspaceSearchMigrationRehearsalPermitSigningKeyReaderDependencies = {
  /** Opens one path read-only without following a final symbolic link. */
  readonly openFileNoFollow: (
    path: string,
  ) => Promise<WorkspaceSearchMigrationRehearsalPermitReadableFile>
  /** Returns the effective local process user identifier. */
  readonly currentUserId: () => number
}

/** Minimal exclusive temporary file used by atomic permit publication. */
export type WorkspaceSearchMigrationRehearsalPermitTemporaryFile = {
  /** Forces the exact private permission mode before content is written. */
  readonly chmod: (mode: number) => Promise<void>
  /** Replaces the empty temporary file with exact bounded bytes. */
  readonly write: (bytes: Uint8Array) => Promise<void>
  /** Flushes temporary file content and metadata to stable storage. */
  readonly sync: () => Promise<void>
  /** Captures current metadata from the already opened inode. */
  readonly stat: () =>
    Promise<WorkspaceSearchMigrationRehearsalPermitFileStatus>
  /** Closes the temporary inode before it is linked into place. */
  readonly close: () => Promise<void>
}

/** Minimal containing-directory handle used for publication durability. */
export type WorkspaceSearchMigrationRehearsalPermitDirectory = {
  /** Flushes directory entry changes to stable storage. */
  readonly sync: () => Promise<void>
  /** Closes the containing-directory handle. */
  readonly close: () => Promise<void>
}

/** Injectable filesystem boundary for atomic no-replace permit publication. */
export type WorkspaceSearchMigrationRehearsalPermitPublicationDependencies =
  WorkspaceSearchMigrationRehearsalPermitSigningKeyReaderDependencies & {
    /** Exclusively creates one private no-follow temporary regular file. */
    readonly createTemporaryFile: (
      path: string,
    ) => Promise<WorkspaceSearchMigrationRehearsalPermitTemporaryFile>
    /** Atomically creates a second hard link without replacing the final path. */
    readonly linkFile: (
      temporaryPath: string,
      finalPath: string,
    ) => Promise<void>
    /** Removes one exact temporary directory entry. */
    readonly unlinkFile: (path: string) => Promise<void>
    /** Opens the exact containing directory for durable entry synchronization. */
    readonly openDirectory: (
      path: string,
    ) => Promise<WorkspaceSearchMigrationRehearsalPermitDirectory>
  }

/** Injectable finite I/O boundary for permit issuance. */
export type WorkspaceSearchMigrationRehearsalPermitCliDependencies = {
  /** Reads one stable regular file through an inclusive byte ceiling. */
  readonly readInputFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Reads one exact owner-only raw key through the secure no-follow reader. */
  readonly readSigningKeyFile: (path: string) => Promise<Uint8Array>
  /** Reads one exact owner-only dedicated #163 key without following symlinks. */
  readonly readIntegrityKeyFile: (path: string) => Promise<Uint8Array>
  /** Reads one owner-only immutable resource snapshot through a byte ceiling. */
  readonly readIntegrityResourceAttestationFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Reads one canonical owner-only root through its exact byte ceiling. */
  readonly readIntegrityAttestationRootFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Reads one raw owner-only root rate segment through its exact ceiling. */
  readonly readIntegrityRootRateSegmentFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Exclusively creates, mode-fixes, and durably syncs one permit file. */
  readonly writePermitFileExclusive: (
    outputPath: string,
    permitBytes: Uint8Array,
  ) => Promise<WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome>
  /** Emits one already canonical secret-free success line. */
  readonly writeStdoutLine: (serializedLine: string) => void
  /** Emits one already canonical secret-free failure line. */
  readonly writeStderrLine: (serializedLine: string) => void
}

/** Process statuses used by the permit-issuance wrapper. */
export type WorkspaceSearchMigrationRehearsalPermitCliExitCode = 0 | 1 | 2

/** Stable raw-value-free permit-issuance failures. */
type WorkspaceSearchMigrationRehearsalPermitCliFailureCode =
  | 'INVALID_CLAIMS_FILE'
  | 'INVALID_INTEGRITY_KEY'
  | 'INVALID_INTEGRITY_ATTESTATION_ROOT'
  | 'INVALID_INTEGRITY_RESOURCE_ATTESTATION'
  | 'INVALID_INTEGRITY_ROOT_RATE_SEGMENT'
  | 'INVALID_SIGNING_KEY'
  | 'INVALID_USAGE'
  | 'OPERATION_FAILED'
  | 'OUTPUT_FILE_EXISTS'
  | 'OUTPUT_FILE_WRITE_FAILED'

/** Private raw-value-free permit-issuance failure. */
class WorkspaceSearchMigrationRehearsalPermitCliFailure extends Error {
  /** Stable machine-readable classification. */
  readonly code: WorkspaceSearchMigrationRehearsalPermitCliFailureCode

  /** Exact process status paired with the classification. */
  readonly exitCode: WorkspaceSearchMigrationRehearsalPermitCliExitCode

  /**
   * Creates one stable permit-issuance failure.
   *
   * @param code - Raw-value-free failure classification.
   * @param exitCode - Exact process exit status.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalPermitCliFailureCode,
    exitCode: WorkspaceSearchMigrationRehearsalPermitCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalPermitCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

/** Exact canonical claims keys accepted by the issuance boundary. */
const permitClaimsKeys = Object.freeze([
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

/** Default POSIX no-follow file boundary used by the signing-key reader. */
export const workspaceSearchMigrationRehearsalPermitNodeSigningKeyReaderDependencies:
  WorkspaceSearchMigrationRehearsalPermitSigningKeyReaderDependencies =
    Object.freeze({
      openFileNoFollow: openWorkspaceSearchMigrationRehearsalPermitFileNoFollow,
      currentUserId: readWorkspaceSearchMigrationRehearsalPermitCurrentUserId,
    })

/** Default POSIX filesystem boundary used by atomic permit publication. */
export const workspaceSearchMigrationRehearsalPermitNodePublicationDependencies:
  WorkspaceSearchMigrationRehearsalPermitPublicationDependencies =
    Object.freeze({
      ...workspaceSearchMigrationRehearsalPermitNodeSigningKeyReaderDependencies,
      createTemporaryFile:
        createWorkspaceSearchMigrationRehearsalPermitTemporaryFile,
      linkFile: async (temporaryPath, finalPath): Promise<void> => {
        await link(temporaryPath, finalPath)
      },
      unlinkFile: async (path): Promise<void> => {
        await unlink(path)
      },
      openDirectory: openWorkspaceSearchMigrationRehearsalPermitDirectory,
    })

/** Default finite filesystem and process-output boundary. */
const defaultPermitCliDependencies:
  WorkspaceSearchMigrationRehearsalPermitCliDependencies = Object.freeze({
    readInputFile: readBoundedInputFile,
    readSigningKeyFile: (path): Promise<Uint8Array> =>
      readWorkspaceSearchMigrationRehearsalPermitSigningKey(path),
    readIntegrityKeyFile: (path): Promise<Uint8Array> =>
      readWorkspaceSearchMigrationRehearsalPermitSigningKey(path),
    readIntegrityResourceAttestationFile:
      readWorkspaceSearchMigrationRehearsalPrivateInputFile,
    readIntegrityAttestationRootFile:
      readWorkspaceSearchMigrationRehearsalPrivateInputFile,
    readIntegrityRootRateSegmentFile:
      readWorkspaceSearchMigrationRehearsalPrivateInputFile,
    writePermitFileExclusive:
      writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
    writeStdoutLine: (serializedLine: string): void => {
      console.log(serializedLine)
    },
    writeStderrLine: (serializedLine: string): void => {
      console.error(serializedLine)
    },
  })

/**
 * Parses only the exact ordered permit-issuance command.
 *
 * @param arguments_ - Arguments following the permit CLI script path.
 * @returns Frozen detached explicit file selection and approval.
 */
export function parseWorkspaceSearchMigrationRehearsalPermitCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationRehearsalPermitCliArguments {
  const snapshot = snapshotPermitCliArguments(arguments_)
  if (
    snapshot[0] !== '--claims-file' ||
    snapshot[2] !== '--signing-key-file' ||
    snapshot[4] !== '--integrity-key-file' ||
    snapshot[6] !== '--integrity-resource-attestation-file' ||
    snapshot[8] !== '--integrity-attestation-root-file' ||
    snapshot[10] !== '--integrity-root-rate-segment-file' ||
    snapshot[12] !== '--output-file' ||
    snapshot[14] !== '--approval' ||
    snapshot[15] !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_ISSUANCE_APPROVAL
  ) {
    throw invalidPermitCliUsage()
  }
  return Object.freeze({
    claimsFile: requirePermitCliPath(snapshot[1]),
    signingKeyFile: requirePermitCliPath(snapshot[3]),
    integrityKeyFile: requirePermitCliPath(snapshot[5]),
    integrityResourceAttestationFile: requirePermitCliPath(snapshot[7]),
    integrityAttestationRootFile: requirePermitCliPath(snapshot[9]),
    integrityRootRateSegmentFile: requirePermitCliPath(snapshot[11]),
    outputFile: requirePermitCliPath(snapshot[13]),
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_ISSUANCE_APPROVAL,
  })
}

/**
 * Validates and detaches one exact rehearsal permit claims value.
 *
 * Accessor-backed, Proxy, non-ordinary, extra-key, or semantically invalid
 * claims are rejected without reflecting their values.
 *
 * @param candidate - Untrusted decoded claims value.
 * @returns Frozen detached exact permit claims.
 */
export function parseWorkspaceSearchMigrationRehearsalPermitClaims(
  candidate: unknown,
): WorkspaceSearchMigrationRehearsalPermitIssuanceClaims {
  try {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      nodeUtilTypes.isProxy(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype
    ) {
      throw invalidClaimsFile()
    }
    const keys = Reflect.ownKeys(candidate)
    if (
      keys.length !== permitClaimsKeys.length ||
      permitClaimsKeys.some((key) => !keys.includes(key))
    ) {
      throw invalidClaimsFile()
    }
    const kind = readPermitClaimsDataProperty(candidate, 'kind')
    const permitVersion = readPermitClaimsDataProperty(
      candidate,
      'permitVersion',
    )
    const stage = readPermitClaimsDataProperty(candidate, 'stage')
    const approval = readPermitClaimsDataProperty(candidate, 'approval')
    const account = readPermitClaimsDataProperty(candidate, 'account')
    const productionAccount = readPermitClaimsDataProperty(
      candidate,
      'productionAccount',
    )
    const region = readPermitClaimsDataProperty(candidate, 'region')
    const callerArn = readPermitClaimsDataProperty(candidate, 'callerArn')
    const commit = readPermitClaimsDataProperty(candidate, 'commit')
    const deploymentTargetId = readPermitClaimsDataProperty(
      candidate,
      'deploymentTargetId',
    )
    const deploymentTrustRootDigest = readPermitClaimsDataProperty(
      candidate,
      'deploymentTrustRootDigest',
    )
    const evidenceKeyDigest = readPermitClaimsDataProperty(
      candidate,
      'evidenceKeyDigest',
    )
    const publicationKeyDigest = readPermitClaimsDataProperty(
      candidate,
      'publicationKeyDigest',
    )
    const requestedResourcesBinding = readPermitClaimsDataProperty(
      candidate,
      'requestedResourcesBinding',
    )
    const configurationBindingDigest = readPermitClaimsDataProperty(
      candidate,
      'configurationBindingDigest',
    )
    const policyVersion = readPermitClaimsDataProperty(
      candidate,
      'policyVersion',
    )
    const integrityResourceIdentityDigest = readPermitClaimsDataProperty(
      candidate,
      'integrityResourceIdentityDigest',
    )
    const integrityAttestationRootCandidate =
      readPermitClaimsDataProperty(candidate, 'integrityAttestationRoot')
    const integrityAttestationRoot = (() => {
      try {
        return parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection(
          integrityAttestationRootCandidate,
        )
      } catch {
        throw invalidClaimsFile()
      }
    })()
    const issuedAt = readPermitClaimsDataProperty(candidate, 'issuedAt')
    const expiresAt = readPermitClaimsDataProperty(candidate, 'expiresAt')
    if (
      kind !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND ||
      permitVersion !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION ||
      stage !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE ||
      approval !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL ||
      typeof account !== 'string' ||
      !/^\d{12}$/u.test(account) ||
      typeof productionAccount !== 'string' ||
      !/^\d{12}$/u.test(productionAccount) ||
      account === productionAccount ||
      typeof region !== 'string' ||
      !/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[1-9][0-9]*$/u.test(region) ||
      typeof callerArn !== 'string' ||
      !callerArnMatchesPermitAccount(callerArn, account) ||
      typeof commit !== 'string' ||
      !/^[0-9a-f]{40}$/u.test(commit) ||
      typeof deploymentTargetId !== 'string' ||
      !/^[a-z][a-z0-9-]{0,62}$/u.test(deploymentTargetId) ||
      !isHexDigest(deploymentTrustRootDigest) ||
      !isHexDigest(configurationBindingDigest) ||
      !isHexDigest(policyVersion) ||
      !isHexDigest(evidenceKeyDigest) ||
      !isHexDigest(publicationKeyDigest) ||
      !isHexDigest(requestedResourcesBinding) ||
      !isHexDigest(integrityResourceIdentityDigest) ||
      !isCanonicalTimestamp(issuedAt) ||
      !isCanonicalTimestamp(expiresAt) ||
      Date.parse(expiresAt) <= Date.parse(issuedAt) ||
      Date.parse(expiresAt) - Date.parse(issuedAt) >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_MAXIMUM_AGE_MILLISECONDS ||
      integrityAttestationRoot.deploymentTargetId !== deploymentTargetId ||
      integrityAttestationRoot.configurationBindingDigest !==
        configurationBindingDigest ||
      integrityAttestationRoot.policyVersion !== policyVersion ||
      integrityAttestationRoot.productionAccountDigest !==
        createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
          productionAccount,
        ) ||
      Date.parse(integrityAttestationRoot.completedAt) > Date.parse(issuedAt)
    ) {
      throw invalidClaimsFile()
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
      evidenceKeyDigest,
      publicationKeyDigest,
      requestedResourcesBinding,
      configurationBindingDigest,
      policyVersion,
      integrityResourceIdentityDigest,
      integrityAttestationRoot,
      issuedAt,
      expiresAt,
    })
  } catch {
    throw invalidClaimsFile()
  }
}

/**
 * Runs one strict reviewed permit issuance without ambient configuration.
 *
 * Both the reader-owned key buffer and the issuance-local key copy are
 * zeroized on every path after they become available.
 *
 * @param arguments_ - Exact ordered operator command.
 * @param dependencies - Injectable finite file and output boundary.
 * @returns Stable permit-issuance process status.
 */
export async function runWorkspaceSearchMigrationRehearsalPermitCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationRehearsalPermitCliDependencies =
      defaultPermitCliDependencies,
): Promise<WorkspaceSearchMigrationRehearsalPermitCliExitCode> {
  let writeStdoutLine = defaultPermitCliDependencies.writeStdoutLine
  let writeStderrLine = defaultPermitCliDependencies.writeStderrLine
  let callerKey: Uint8Array | undefined
  let integrityKey: Uint8Array | undefined
  let runtimeKey: Uint8Array | undefined
  let publicationKey: Uint8Array | undefined
  let integrityResourceAttestationBytes: Uint8Array | undefined
  let integrityAttestationRootBytes: Uint8Array | undefined
  let integrityRootRateSegmentBytes: Uint8Array | undefined
  try {
    const capturedDependencies = snapshotPermitCliDependencies(dependencies)
    writeStdoutLine = capturedDependencies.writeStdoutLine
    writeStderrLine = capturedDependencies.writeStderrLine
    const configuration =
      parseWorkspaceSearchMigrationRehearsalPermitCliArguments(arguments_)
    const claimsBytes = await readPermitCliInputFile(
      configuration.claimsFile,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLAIMS_MAX_BYTES,
      capturedDependencies,
      invalidClaimsFile,
    )
    const claims = parseCanonicalPermitClaimsDocument(claimsBytes)
    callerKey = await readPermitCliSigningKey(
      configuration.signingKeyFile,
      capturedDependencies,
    )
    const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(callerKey)
    runtimeKey = derivedKeys.runtimeKey
    publicationKey = derivedKeys.publicationKey
    if (
      derivedKeys.runtimeKeyDigest !== claims.evidenceKeyDigest ||
      derivedKeys.publicationKeyDigest !== claims.publicationKeyDigest
    ) {
      throw invalidSigningKey()
    }
    integrityKey = await readPermitCliIntegrityKey(
      configuration.integrityKeyFile,
      capturedDependencies,
    )
    if (
      samePermitCliSecretKey(integrityKey, callerKey) ||
      samePermitCliSecretKey(integrityKey, runtimeKey) ||
      samePermitCliSecretKey(integrityKey, publicationKey)
    ) {
      throw invalidIntegrityKey()
    }
    zeroizePermitCliKey(callerKey)
    callerKey = undefined
    integrityResourceAttestationBytes =
      await readPermitCliIntegrityResourceAttestation(
        configuration.integrityResourceAttestationFile,
        capturedDependencies,
      )
    const integrityResourceAttestation =
      parseCanonicalPermitIntegrityResourceAttestationDocument(
        integrityResourceAttestationBytes,
      )
    const integrityResourceIdentities =
      createCrossDomainIntegrityImmutableResourceIdentities(
        integrityResourceAttestation,
        integrityKey,
      )
    const integrityResourceIdentityDigest =
      calculateCrossDomainIntegrityResourceIdentityDigest(
        integrityResourceIdentities,
        integrityKey,
      )
    if (
      integrityResourceAttestation.account !== claims.account ||
      integrityResourceAttestation.region !== claims.region ||
      integrityResourceIdentityDigest !==
        claims.integrityResourceIdentityDigest
    ) {
      throw invalidIntegrityResourceAttestation()
    }
    integrityAttestationRootBytes = await readPermitCliIntegrityAttestationRoot(
      configuration.integrityAttestationRootFile,
      capturedDependencies,
    )
    integrityRootRateSegmentBytes =
      await readPermitCliIntegrityRootRateSegment(
        configuration.integrityRootRateSegmentFile,
        capturedDependencies,
      )
    let rootAuthorizations: ReturnType<
      typeof verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot
    >
    try {
      rootAuthorizations =
        verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot({
          rootBytes: integrityAttestationRootBytes,
          canonicalSegmentBytes: integrityRootRateSegmentBytes,
          resourceAttestationBytes: integrityResourceAttestationBytes,
          rateAuthenticationKey: runtimeKey,
        })
    } catch {
      throw invalidIntegrityAttestationRoot()
    }
    let integrityAttestationRoot: ReturnType<
      typeof consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization
    >
    try {
      integrityAttestationRoot =
        consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization({
          authorization: rootAuthorizations.permit,
          expected: {
            deploymentTargetId: claims.deploymentTargetId,
            deploymentTrustRootDigest: claims.deploymentTrustRootDigest,
            productionAccountDigest:
              createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
                claims.productionAccount,
              ),
            account: claims.account,
            region: claims.region,
            callerArn: claims.callerArn,
            commit: claims.commit,
            requestedResourcesBinding: claims.requestedResourcesBinding,
            configurationBindingDigest:
              claims.configurationBindingDigest,
            policyVersion: claims.policyVersion,
            evidenceKeyDigest: claims.evidenceKeyDigest,
            publicationKeyDigest: claims.publicationKeyDigest,
            resourceIdentityScheme:
              CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
            resourceIdentities: integrityResourceIdentities,
            resourceIdentityDigest: integrityResourceIdentityDigest,
            issuedAt: claims.issuedAt,
          },
        })
    } catch {
      throw invalidIntegrityAttestationRoot()
    }
    if (
      serializeCanonicalJson(integrityAttestationRoot) !==
        serializeCanonicalJson(claims.integrityAttestationRoot)
    ) throw invalidIntegrityAttestationRoot()
    const authenticatedClaims:
      WorkspaceSearchMigrationRehearsalPermitClaims = Object.freeze({
        ...claims,
        integrityResourceIdentityScheme:
          CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        integrityResourceIdentities,
        integrityAttestationRoot,
      })
    const permit = createWorkspaceSearchMigrationRehearsalPermit({
      claims: authenticatedClaims,
      signingKey: runtimeKey,
    })
    const permitBytes = new TextEncoder().encode(
      serializeCanonicalJson(permit),
    )
    if (
      permitBytes.byteLength === 0 ||
      permitBytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_OUTPUT_MAX_BYTES
    ) {
      throw operationFailed()
    }
    let writeOutcome:
      WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome
    try {
      writeOutcome = await capturedDependencies.writePermitFileExclusive(
        configuration.outputFile,
        permitBytes,
      )
    } catch {
      throw outputFileWriteFailed()
    }
    if (writeOutcome === 'exists') throw outputFileExists()
    if (writeOutcome !== 'created' && writeOutcome !== 'reconciled') {
      throw outputFileWriteFailed()
    }
    const permitDigest = createHash('sha256')
      .update(permitBytes)
      .digest('hex')
    writeStdoutLine(serializeCanonicalJson({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
      permitDigest,
      status: 'succeeded',
    }))
    return 0
  } catch (error: unknown) {
    const failure = classifyPermitCliFailure(error)
    writePermitCliFailureLine(writeStderrLine, failure.code)
    return failure.exitCode
  } finally {
    zeroizePermitCliKey(integrityRootRateSegmentBytes)
    zeroizePermitCliKey(integrityAttestationRootBytes)
    zeroizePermitCliKey(integrityResourceAttestationBytes)
    zeroizePermitCliKey(integrityKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(publicationKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(runtimeKey)
    zeroizePermitCliKey(callerKey)
  }
}

/**
 * Publishes one exact mode-0600 permit through a durable atomic hard link.
 *
 * Content is first written and fsynced to a deterministic private temporary
 * inode in the final directory. A hard link then publishes it without any
 * replacement window. Link-response loss and pre-existing identical canonical
 * output are reconciled through a no-follow owner/mode/content check.
 *
 * @param outputPath - Explicit final permit path.
 * @param permitBytes - Exact canonical authenticated permit bytes.
 * @param dependencies - Injectable finite no-follow filesystem boundary.
 * @returns Whether publication was new, reconciled, or collided with other data.
 */
export async function writeWorkspaceSearchMigrationRehearsalPermitFileExclusive(
  outputPath: string,
  permitBytes: Uint8Array,
  dependencies:
    WorkspaceSearchMigrationRehearsalPermitPublicationDependencies =
      workspaceSearchMigrationRehearsalPermitNodePublicationDependencies,
): Promise<WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome> {
  let content: Uint8Array | undefined
  try {
    const finalPath = resolve(requirePermitCliPath(outputPath))
    content = copyPermitCliOutputBytes(permitBytes)
    if (!isCanonicalPermitCliDocument(content)) {
      throw outputBoundaryFailed()
    }
    const capturedDependencies = snapshotPermitPublicationDependencies(
      dependencies,
    )
    const currentUserId = requirePermitCliCurrentUserId(
      capturedDependencies.currentUserId,
    )
    const directoryPath = dirname(finalPath)
    const temporaryPath = createPermitCliTemporaryPath(
      directoryPath,
      content,
    )
    let temporaryCreated = false
    let temporaryReady = false
    try {
      const temporaryFile = await capturedDependencies.createTemporaryFile(
        temporaryPath,
      )
      temporaryCreated = true
      await preparePermitCliTemporaryFile({
        content,
        currentUserId,
        temporaryFile,
      })
      const preparedTemporary = await inspectPermitCliFile({
        expectedBytes: content,
        expectedOwnerUserId: currentUserId,
        path: temporaryPath,
        dependencies: capturedDependencies,
      })
      if (preparedTemporary !== 'match') throw outputBoundaryFailed()
      temporaryReady = true
    } catch (error: unknown) {
      if (temporaryCreated) {
        await removePermitCliTemporaryFile({
          content,
          currentUserId,
          directoryPath,
          temporaryPath,
          dependencies: capturedDependencies,
        })
        throw outputBoundaryFailed()
      }
      if (isPermitCliFileExistsError(error)) {
        const existingTemporary = await inspectPermitCliFile({
          expectedBytes: content,
          expectedOwnerUserId: currentUserId,
          path: temporaryPath,
          dependencies: capturedDependencies,
        })
        if (existingTemporary === 'match') {
          temporaryReady = true
        }
      }
      if (!temporaryReady) throw outputBoundaryFailed()
    }

    let outcome: WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome =
      'created'
    try {
      await capturedDependencies.linkFile(temporaryPath, finalPath)
    } catch (error: unknown) {
      const finalInspection = await inspectPermitCliFile({
        expectedBytes: content,
        expectedOwnerUserId: currentUserId,
        path: finalPath,
        dependencies: capturedDependencies,
      })
      if (finalInspection === 'match') {
        outcome = 'reconciled'
      } else {
        await removePermitCliTemporaryFile({
          content,
          currentUserId,
          directoryPath,
          temporaryPath,
          dependencies: capturedDependencies,
        })
        if (
          isPermitCliFileExistsError(error) ||
          finalInspection === 'mismatch' ||
          finalInspection === 'unsafe'
        ) {
          return 'exists'
        }
        throw outputBoundaryFailed()
      }
    }

    await syncPermitCliDirectory(directoryPath, capturedDependencies)
    await removePermitCliTemporaryFile({
      content,
      currentUserId,
      directoryPath,
      temporaryPath,
      dependencies: capturedDependencies,
    })
    return outcome
  } catch {
    throw outputBoundaryFailed()
  } finally {
    zeroizePermitCliKey(content)
  }
}

/** Captures every injected permit effect before the first file await. */
function snapshotPermitCliDependencies(
  dependencies: WorkspaceSearchMigrationRehearsalPermitCliDependencies,
): WorkspaceSearchMigrationRehearsalPermitCliDependencies {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    nodeUtilTypes.isProxy(dependencies)
  ) {
    throw operationFailed()
  }
  let readInputFile:
    WorkspaceSearchMigrationRehearsalPermitCliDependencies['readInputFile']
  let readSigningKeyFile:
    WorkspaceSearchMigrationRehearsalPermitCliDependencies[
      'readSigningKeyFile'
    ]
  let readIntegrityKeyFile:
    WorkspaceSearchMigrationRehearsalPermitCliDependencies[
      'readIntegrityKeyFile'
    ]
  let readIntegrityResourceAttestationFile:
    WorkspaceSearchMigrationRehearsalPermitCliDependencies[
      'readIntegrityResourceAttestationFile'
    ]
  let readIntegrityAttestationRootFile:
    WorkspaceSearchMigrationRehearsalPermitCliDependencies[
      'readIntegrityAttestationRootFile'
    ]
  let readIntegrityRootRateSegmentFile:
    WorkspaceSearchMigrationRehearsalPermitCliDependencies[
      'readIntegrityRootRateSegmentFile'
    ]
  let writePermitFileExclusive:
    WorkspaceSearchMigrationRehearsalPermitCliDependencies[
      'writePermitFileExclusive'
    ]
  let writeStdoutLine:
    WorkspaceSearchMigrationRehearsalPermitCliDependencies[
      'writeStdoutLine'
    ]
  let writeStderrLine:
    WorkspaceSearchMigrationRehearsalPermitCliDependencies[
      'writeStderrLine'
    ]
  try {
    readInputFile = dependencies.readInputFile
    readSigningKeyFile = dependencies.readSigningKeyFile
    readIntegrityKeyFile = dependencies.readIntegrityKeyFile
    readIntegrityResourceAttestationFile =
      dependencies.readIntegrityResourceAttestationFile
    readIntegrityAttestationRootFile =
      dependencies.readIntegrityAttestationRootFile
    readIntegrityRootRateSegmentFile =
      dependencies.readIntegrityRootRateSegmentFile
    writePermitFileExclusive = dependencies.writePermitFileExclusive
    writeStdoutLine = dependencies.writeStdoutLine
    writeStderrLine = dependencies.writeStderrLine
  } catch {
    throw operationFailed()
  }
  if (
    !isDirectPermitCliFunction(readInputFile) ||
    !isDirectPermitCliFunction(readSigningKeyFile) ||
    !isDirectPermitCliFunction(readIntegrityKeyFile) ||
    !isDirectPermitCliFunction(
      readIntegrityResourceAttestationFile,
    ) ||
    !isDirectPermitCliFunction(readIntegrityAttestationRootFile) ||
    !isDirectPermitCliFunction(readIntegrityRootRateSegmentFile) ||
    !isDirectPermitCliFunction(writePermitFileExclusive) ||
    !isDirectPermitCliFunction(writeStdoutLine) ||
    !isDirectPermitCliFunction(writeStderrLine)
  ) {
    throw operationFailed()
  }
  return Object.freeze({
    readInputFile: (path, maximumBytes) =>
      readInputFile(path, maximumBytes),
    readSigningKeyFile: (path) => readSigningKeyFile(path),
    readIntegrityKeyFile: (path) => readIntegrityKeyFile(path),
    readIntegrityResourceAttestationFile: (path, maximumBytes) =>
      readIntegrityResourceAttestationFile(path, maximumBytes),
    readIntegrityAttestationRootFile: (path, maximumBytes) =>
      readIntegrityAttestationRootFile(path, maximumBytes),
    readIntegrityRootRateSegmentFile: (path, maximumBytes) =>
      readIntegrityRootRateSegmentFile(path, maximumBytes),
    writePermitFileExclusive: (outputPath, permitBytes) =>
      writePermitFileExclusive(outputPath, permitBytes),
    writeStdoutLine: (line) => writeStdoutLine(line),
    writeStderrLine: (line) => writeStderrLine(line),
  })
}

/** Checks one injected effect without permitting callable Proxy traps. */
function isDirectPermitCliFunction(
  value: unknown,
): value is (...arguments_: readonly never[]) => unknown {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Parses one already bounded exact canonical claims document.
 *
 * @param bytes - Stable non-empty claims-file bytes.
 * @returns Frozen detached validated claims.
 */
function parseCanonicalPermitClaimsDocument(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRehearsalPermitIssuanceClaims {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const candidate: unknown = JSON.parse(text)
    const canonicalBytes = new TextEncoder().encode(
      serializeCanonicalJson(candidate),
    )
    if (!equalPermitCliBytes(bytes, canonicalBytes)) {
      throw invalidClaimsFile()
    }
    return parseWorkspaceSearchMigrationRehearsalPermitClaims(candidate)
  } catch {
    throw invalidClaimsFile()
  }
}

/**
 * Parses one exact canonical owner-only immutable resource snapshot.
 *
 * @param bytes - Stable non-empty private attestation bytes.
 * @returns Detached deeply frozen strict resource attestation.
 */
function parseCanonicalPermitIntegrityResourceAttestationDocument(
  bytes: Uint8Array,
): CrossDomainIntegrityResourceAttestation {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const candidate: unknown = JSON.parse(text)
    const attestation = parseCrossDomainIntegrityResourceAttestation(
      candidate,
    )
    const canonicalBytes = new TextEncoder().encode(
      serializeCrossDomainIntegrityResourceAttestation(attestation),
    )
    if (!equalPermitCliBytes(bytes, canonicalBytes)) {
      throw invalidIntegrityResourceAttestation()
    }
    return attestation
  } catch {
    throw invalidIntegrityResourceAttestation()
  }
}

/**
 * Reads one bounded file and normalizes every reader failure.
 *
 * @param path - Explicit private input path.
 * @param maximumBytes - Positive inclusive byte ceiling.
 * @param dependencies - Captured bounded reader.
 * @param fail - Stable role-specific input failure factory.
 * @returns Exact finite non-Proxy file bytes.
 */
async function readPermitCliInputFile(
  path: string,
  maximumBytes: number,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalPermitCliDependencies,
    'readInputFile'
  >,
  fail: () => WorkspaceSearchMigrationRehearsalPermitCliFailure,
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
  return bytes
}

/**
 * Reads one exact owner-only raw signing key without following a final symlink.
 *
 * The already opened inode must remain the same regular mode-0600 file owned by
 * the effective process user across a bounded exact-length read. All working
 * buffers are zeroized on both success and failure.
 *
 * @param path - Explicit restricted raw signing-key path.
 * @param dependencies - Injectable no-follow local file boundary.
 * @returns New caller-owned exact 32-byte signing-key buffer.
 */
export async function readWorkspaceSearchMigrationRehearsalPermitSigningKey(
  path: string,
  dependencies:
    WorkspaceSearchMigrationRehearsalPermitSigningKeyReaderDependencies =
      workspaceSearchMigrationRehearsalPermitNodeSigningKeyReaderDependencies,
): Promise<Uint8Array> {
  let file: WorkspaceSearchMigrationRehearsalPermitReadableFile | undefined
  let workingBytes: Uint8Array | undefined
  let signingKey: Uint8Array | undefined
  let failed = false
  try {
    const restrictedPath = requirePermitCliPath(path)
    const capturedDependencies = snapshotPermitSigningKeyReaderDependencies(
      dependencies,
    )
    const currentUserId = requirePermitCliCurrentUserId(
      capturedDependencies.currentUserId,
    )
    file = await capturedDependencies.openFileNoFollow(restrictedPath)
    const before = requirePermitCliSecureFileStatus(
      await file.stat(),
      currentUserId,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_SIGNING_KEY_BYTES,
    )
    workingBytes = await readPermitCliOpenedFileBounded(
      file,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_SIGNING_KEY_BYTES,
    )
    const after = requirePermitCliSecureFileStatus(
      await file.stat(),
      currentUserId,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_SIGNING_KEY_BYTES,
    )
    if (
      !permitCliFileStatusIsStable(before, after) ||
      workingBytes.byteLength !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_SIGNING_KEY_BYTES
    ) {
      throw signingKeyBoundaryFailed()
    }
    signingKey = copyPermitCliSigningKey(workingBytes)
  } catch {
    failed = true
  } finally {
    if (file !== undefined) {
      try {
        await file.close()
      } catch {
        failed = true
      }
    }
    zeroizePermitCliKey(workingBytes)
    if (failed) zeroizePermitCliKey(signingKey)
  }
  if (failed || signingKey === undefined) {
    throw signingKeyBoundaryFailed()
  }
  return signingKey
}

/**
 * Reads one raw signing key and captures it before exact-length validation.
 *
 * @param path - Explicit restricted signing-key path.
 * @param dependencies - Captured bounded reader.
 * @returns Reader-owned raw key bytes for final zeroization.
 */
async function readPermitCliSigningKey(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalPermitCliDependencies,
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
    zeroizePermitCliKey(
      key instanceof Uint8Array && !nodeUtilTypes.isProxy(key)
        ? key
        : undefined,
    )
    throw invalidSigningKey()
  }
  return key
}

/**
 * Reads one exact dedicated #163 key and transfers ownership to the CLI.
 *
 * @param path - Explicit restricted integrity-key path.
 * @param dependencies - Captured secure integrity-key reader.
 * @returns Reader-owned exact 32-byte key for mandatory final zeroization.
 */
async function readPermitCliIntegrityKey(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalPermitCliDependencies,
    'readIntegrityKeyFile'
  >,
): Promise<Uint8Array> {
  let key: Uint8Array
  try {
    key = await dependencies.readIntegrityKeyFile(path)
  } catch {
    throw invalidIntegrityKey()
  }
  if (
    !(key instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(key) ||
    key.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_INTEGRITY_KEY_BYTES
  ) {
    zeroizePermitCliKey(
      key instanceof Uint8Array && !nodeUtilTypes.isProxy(key)
        ? key
        : undefined,
    )
    throw invalidIntegrityKey()
  }
  return key
}

/**
 * Reads one owner-only canonical resource snapshot through its exact ceiling.
 *
 * @param path - Explicit restricted resource-attestation path.
 * @param dependencies - Captured secure private snapshot reader.
 * @returns Reader-owned bytes for parse and mandatory final zeroization.
 */
async function readPermitCliIntegrityResourceAttestation(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalPermitCliDependencies,
    'readIntegrityResourceAttestationFile'
  >,
): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    bytes = await dependencies.readIntegrityResourceAttestationFile(
      path,
      CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
    )
  } catch {
    throw invalidIntegrityResourceAttestation()
  }
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES
  ) {
    zeroizePermitCliKey(
      bytes instanceof Uint8Array && !nodeUtilTypes.isProxy(bytes)
        ? bytes
        : undefined,
    )
    throw invalidIntegrityResourceAttestation()
  }
  return bytes
}

/** Reads one owner-only canonical root through its exact byte ceiling. */
async function readPermitCliIntegrityAttestationRoot(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalPermitCliDependencies,
    'readIntegrityAttestationRootFile'
  >,
): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    bytes = await dependencies.readIntegrityAttestationRootFile(
      path,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_ATTESTATION_ROOT_MAX_BYTES,
    )
  } catch {
    throw invalidIntegrityAttestationRoot()
  }
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_ATTESTATION_ROOT_MAX_BYTES
  ) {
    zeroizePermitCliKey(
      bytes instanceof Uint8Array && !nodeUtilTypes.isProxy(bytes)
        ? bytes
        : undefined,
    )
    throw invalidIntegrityAttestationRoot()
  }
  return bytes
}

/** Reads one exact raw ordinal-zero rate segment through its byte ceiling. */
async function readPermitCliIntegrityRootRateSegment(
  path: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalPermitCliDependencies,
    'readIntegrityRootRateSegmentFile'
  >,
): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    bytes = await dependencies.readIntegrityRootRateSegmentFile(
      path,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
    )
  } catch {
    throw invalidIntegrityRootRateSegment()
  }
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES
  ) {
    zeroizePermitCliKey(
      bytes instanceof Uint8Array && !nodeUtilTypes.isProxy(bytes)
        ? bytes
        : undefined,
    )
    throw invalidIntegrityRootRateSegment()
  }
  return bytes
}

/** Captures the secure reader effects before opening a private path. */
function snapshotPermitSigningKeyReaderDependencies(
  dependencies: WorkspaceSearchMigrationRehearsalPermitSigningKeyReaderDependencies,
): WorkspaceSearchMigrationRehearsalPermitSigningKeyReaderDependencies {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    nodeUtilTypes.isProxy(dependencies)
  ) {
    throw signingKeyBoundaryFailed()
  }
  let openFileNoFollow:
    WorkspaceSearchMigrationRehearsalPermitSigningKeyReaderDependencies[
      'openFileNoFollow'
    ]
  let currentUserId:
    WorkspaceSearchMigrationRehearsalPermitSigningKeyReaderDependencies[
      'currentUserId'
    ]
  try {
    openFileNoFollow = dependencies.openFileNoFollow
    currentUserId = dependencies.currentUserId
  } catch {
    throw signingKeyBoundaryFailed()
  }
  if (
    !isDirectPermitCliFunction(openFileNoFollow) ||
    !isDirectPermitCliFunction(currentUserId)
  ) {
    throw signingKeyBoundaryFailed()
  }
  return Object.freeze({
    openFileNoFollow: (path) => openFileNoFollow(path),
    currentUserId: () => currentUserId(),
  })
}

/** Captures every publication effect before creating a temporary inode. */
function snapshotPermitPublicationDependencies(
  dependencies: WorkspaceSearchMigrationRehearsalPermitPublicationDependencies,
): WorkspaceSearchMigrationRehearsalPermitPublicationDependencies {
  const reader = snapshotPermitSigningKeyReaderDependencies(dependencies)
  let createTemporaryFile:
    WorkspaceSearchMigrationRehearsalPermitPublicationDependencies[
      'createTemporaryFile'
    ]
  let linkFile:
    WorkspaceSearchMigrationRehearsalPermitPublicationDependencies['linkFile']
  let unlinkFile:
    WorkspaceSearchMigrationRehearsalPermitPublicationDependencies[
      'unlinkFile'
    ]
  let openDirectory:
    WorkspaceSearchMigrationRehearsalPermitPublicationDependencies[
      'openDirectory'
    ]
  try {
    createTemporaryFile = dependencies.createTemporaryFile
    linkFile = dependencies.linkFile
    unlinkFile = dependencies.unlinkFile
    openDirectory = dependencies.openDirectory
  } catch {
    throw outputBoundaryFailed()
  }
  if (
    !isDirectPermitCliFunction(createTemporaryFile) ||
    !isDirectPermitCliFunction(linkFile) ||
    !isDirectPermitCliFunction(unlinkFile) ||
    !isDirectPermitCliFunction(openDirectory)
  ) {
    throw outputBoundaryFailed()
  }
  return Object.freeze({
    ...reader,
    createTemporaryFile: (path) => createTemporaryFile(path),
    linkFile: (temporaryPath, finalPath) =>
      linkFile(temporaryPath, finalPath),
    unlinkFile: (path) => unlinkFile(path),
    openDirectory: (path) => openDirectory(path),
  })
}

/** Opens one regular file read-only with a final-component no-follow guard. */
async function openWorkspaceSearchMigrationRehearsalPermitFileNoFollow(
  path: string,
): Promise<WorkspaceSearchMigrationRehearsalPermitReadableFile> {
  const handle = await open(
    path,
    fileSystemConstants.O_RDONLY | requirePermitCliNoFollowFlag(),
  )
  return Object.freeze({
    stat: async () => snapshotPermitCliNativeFileStatus(await handle.stat()),
    read: async (
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => {
      const result = await handle.read(buffer, offset, length, position)
      return result.bytesRead
    },
    close: async () => {
      await handle.close()
    },
  })
}

/** Exclusively opens one new no-follow mode-0600 temporary regular file. */
async function createWorkspaceSearchMigrationRehearsalPermitTemporaryFile(
  path: string,
): Promise<WorkspaceSearchMigrationRehearsalPermitTemporaryFile> {
  const handle = await open(
    path,
    fileSystemConstants.O_WRONLY |
      fileSystemConstants.O_CREAT |
      fileSystemConstants.O_EXCL |
      requirePermitCliNoFollowFlag(),
    0o600,
  )
  return Object.freeze({
    chmod: async (mode: number) => {
      await handle.chmod(mode)
    },
    write: async (bytes: Uint8Array) => {
      await handle.writeFile(bytes)
    },
    sync: async () => {
      await handle.sync()
    },
    stat: async () => snapshotPermitCliNativeFileStatus(await handle.stat()),
    close: async () => {
      await handle.close()
    },
  })
}

/** Opens one containing directory for durable entry synchronization. */
async function openWorkspaceSearchMigrationRehearsalPermitDirectory(
  path: string,
): Promise<WorkspaceSearchMigrationRehearsalPermitDirectory> {
  const handle = await open(
    path,
    fileSystemConstants.O_RDONLY | fileSystemConstants.O_DIRECTORY,
  )
  return Object.freeze({
    sync: async () => {
      await handle.sync()
    },
    close: async () => {
      await handle.close()
    },
  })
}

/** Detaches security-relevant native stat fields from an opened inode. */
function snapshotPermitCliNativeFileStatus(
  status: Stats,
): WorkspaceSearchMigrationRehearsalPermitFileStatus {
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    ownerUserId: status.uid,
    mode: status.mode,
    size: status.size,
    changedAtMilliseconds: status.ctimeMs,
    modifiedAtMilliseconds: status.mtimeMs,
    regularFile: status.isFile(),
  })
}

/** Reads at most one inclusive byte ceiling plus an overflow sentinel. */
async function readPermitCliOpenedFileBounded(
  file: WorkspaceSearchMigrationRehearsalPermitReadableFile,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw outputBoundaryFailed()
  }
  const working = new Uint8Array(maximumBytes + 1)
  try {
    let total = 0
    while (total < working.byteLength) {
      const bytesRead = await file.read(
        working,
        total,
        working.byteLength - total,
        total,
      )
      if (
        !Number.isSafeInteger(bytesRead) ||
        bytesRead < 0 ||
        bytesRead > working.byteLength - total
      ) {
        throw outputBoundaryFailed()
      }
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > maximumBytes) throw outputBoundaryFailed()
    const copied: unknown = Reflect.apply(
      Uint8Array.prototype.slice,
      working,
      [0, total],
    )
    if (!(copied instanceof Uint8Array)) throw outputBoundaryFailed()
    return copied
  } finally {
    zeroizePermitCliKey(working)
  }
}

/** Requires exact stable owner, regular-file, private-mode, and size metadata. */
function requirePermitCliSecureFileStatus(
  status: WorkspaceSearchMigrationRehearsalPermitFileStatus,
  expectedOwnerUserId: number,
  expectedSize: number,
): WorkspaceSearchMigrationRehearsalPermitFileStatus {
  if (
    typeof status !== 'object' ||
    status === null ||
    nodeUtilTypes.isProxy(status) ||
    !Number.isSafeInteger(status.device) ||
    !Number.isSafeInteger(status.inode) ||
    !Number.isSafeInteger(status.ownerUserId) ||
    !Number.isSafeInteger(status.mode) ||
    !Number.isSafeInteger(status.size) ||
    !Number.isFinite(status.changedAtMilliseconds) ||
    !Number.isFinite(status.modifiedAtMilliseconds) ||
    status.device < 0 ||
    status.inode < 0 ||
    status.ownerUserId !== expectedOwnerUserId ||
    status.size !== expectedSize ||
    status.regularFile !== true ||
    (status.mode & 0o7777) !== 0o600
  ) {
    throw outputBoundaryFailed()
  }
  return Object.freeze({
    device: status.device,
    inode: status.inode,
    ownerUserId: status.ownerUserId,
    mode: status.mode,
    size: status.size,
    changedAtMilliseconds: status.changedAtMilliseconds,
    modifiedAtMilliseconds: status.modifiedAtMilliseconds,
    regularFile: status.regularFile,
  })
}

/** Checks that an opened file did not change identity, metadata, or size. */
function permitCliFileStatusIsStable(
  before: WorkspaceSearchMigrationRehearsalPermitFileStatus,
  after: WorkspaceSearchMigrationRehearsalPermitFileStatus,
): boolean {
  return (
    before.device === after.device &&
    before.inode === after.inode &&
    before.ownerUserId === after.ownerUserId &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.changedAtMilliseconds === after.changedAtMilliseconds &&
    before.modifiedAtMilliseconds === after.modifiedAtMilliseconds &&
    before.regularFile === after.regularFile
  )
}

/** Checks that a temporary inode retained its identity while content changed. */
function permitCliFileIdentityIsStable(
  before: WorkspaceSearchMigrationRehearsalPermitFileStatus,
  after: WorkspaceSearchMigrationRehearsalPermitFileStatus,
): boolean {
  return (
    before.device === after.device &&
    before.inode === after.inode &&
    before.ownerUserId === after.ownerUserId &&
    before.mode === after.mode &&
    before.regularFile === after.regularFile
  )
}

/** Returns the effective process user identifier or fails closed. */
function readWorkspaceSearchMigrationRehearsalPermitCurrentUserId(): number {
  if (typeof process.getuid !== 'function') throw outputBoundaryFailed()
  return process.getuid()
}

/** Requires native final-component no-follow support instead of degrading. */
function requirePermitCliNoFollowFlag(): number {
  const flag: unknown = fileSystemConstants.O_NOFOLLOW
  if (!Number.isSafeInteger(flag) || typeof flag !== 'number' || flag <= 0) {
    throw outputBoundaryFailed()
  }
  return flag
}

/** Calls one captured user-id source and validates its finite POSIX shape. */
function requirePermitCliCurrentUserId(
  currentUserId: () => number,
): number {
  let value: number
  try {
    value = currentUserId()
  } catch {
    throw outputBoundaryFailed()
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw outputBoundaryFailed()
  }
  return value
}

/** Builds one same-directory deterministic private temporary permit path. */
function createPermitCliTemporaryPath(
  directoryPath: string,
  permitBytes: Uint8Array,
): string {
  const digest = createHash('sha256').update(permitBytes).digest('hex')
  return join(
    directoryPath,
    `.mukuroji-rehearsal-permit-${digest}.tmp`,
  )
}

/** Writes, syncs, closes, and verifies one new private temporary inode. */
async function preparePermitCliTemporaryFile(input: {
  /** Exact canonical bytes to publish. */
  readonly content: Uint8Array
  /** Required owner user identifier. */
  readonly currentUserId: number
  /** Already exclusively created temporary inode. */
  readonly temporaryFile: WorkspaceSearchMigrationRehearsalPermitTemporaryFile
}): Promise<void> {
  let failed = false
  try {
    await input.temporaryFile.chmod(0o600)
    const before = requirePermitCliSecureFileStatus(
      await input.temporaryFile.stat(),
      input.currentUserId,
      0,
    )
    await input.temporaryFile.write(input.content)
    await input.temporaryFile.sync()
    const after = requirePermitCliSecureFileStatus(
      await input.temporaryFile.stat(),
      input.currentUserId,
      input.content.byteLength,
    )
    if (!permitCliFileIdentityIsStable(before, after)) {
      throw outputBoundaryFailed()
    }
  } catch {
    failed = true
  }
  try {
    await input.temporaryFile.close()
  } catch {
    failed = true
  }
  if (failed) throw outputBoundaryFailed()
}

/** Result of one no-follow exact-content file reconciliation inspection. */
type PermitCliFileInspection =
  | 'absent'
  | 'match'
  | 'mismatch'
  | 'unsafe'

/** Inspects one final or recovered temporary path without following symlinks. */
async function inspectPermitCliFile(input: {
  /** Exact canonical bytes required for a match. */
  readonly expectedBytes: Uint8Array
  /** Required local owner user identifier. */
  readonly expectedOwnerUserId: number
  /** Exact path whose final component must not be followed. */
  readonly path: string
  /** Captured finite secure filesystem boundary. */
  readonly dependencies: Pick<
    WorkspaceSearchMigrationRehearsalPermitPublicationDependencies,
    'openFileNoFollow'
  >
}): Promise<PermitCliFileInspection> {
  let file: WorkspaceSearchMigrationRehearsalPermitReadableFile | undefined
  let observedBytes: Uint8Array | undefined
  let inspection: PermitCliFileInspection = 'unsafe'
  try {
    try {
      file = await input.dependencies.openFileNoFollow(input.path)
    } catch (error: unknown) {
      return isPermitCliNoEntryError(error) ? 'absent' : 'unsafe'
    }
    const before = requirePermitCliSecureFileStatus(
      await file.stat(),
      input.expectedOwnerUserId,
      input.expectedBytes.byteLength,
    )
    observedBytes = await readPermitCliOpenedFileBounded(
      file,
      input.expectedBytes.byteLength,
    )
    const after = requirePermitCliSecureFileStatus(
      await file.stat(),
      input.expectedOwnerUserId,
      input.expectedBytes.byteLength,
    )
    if (!permitCliFileStatusIsStable(before, after)) return 'unsafe'
    inspection =
      equalPermitCliBytes(observedBytes, input.expectedBytes) &&
        isCanonicalPermitCliDocument(observedBytes)
        ? 'match'
        : 'mismatch'
  } catch {
    inspection = 'unsafe'
  } finally {
    if (file !== undefined) {
      try {
        await file.close()
      } catch {
        inspection = 'unsafe'
      }
    }
    zeroizePermitCliKey(observedBytes)
  }
  return inspection
}

/** Removes one verified temporary entry and durably records its removal. */
async function removePermitCliTemporaryFile(input: {
  /** Exact canonical bytes expected in the temporary inode. */
  readonly content: Uint8Array
  /** Required local owner user identifier. */
  readonly currentUserId: number
  /** Exact containing directory path. */
  readonly directoryPath: string
  /** Exact deterministic temporary path. */
  readonly temporaryPath: string
  /** Captured finite publication filesystem boundary. */
  readonly dependencies: WorkspaceSearchMigrationRehearsalPermitPublicationDependencies
}): Promise<void> {
  try {
    await input.dependencies.unlinkFile(input.temporaryPath)
  } catch {
    const inspection = await inspectPermitCliFile({
      expectedBytes: input.content,
      expectedOwnerUserId: input.currentUserId,
      path: input.temporaryPath,
      dependencies: input.dependencies,
    })
    if (inspection !== 'absent') throw outputBoundaryFailed()
  }
  await syncPermitCliDirectory(input.directoryPath, input.dependencies)
}

/** Fsyncs and closes one exact containing directory. */
async function syncPermitCliDirectory(
  directoryPath: string,
  dependencies: Pick<
    WorkspaceSearchMigrationRehearsalPermitPublicationDependencies,
    'openDirectory'
  >,
): Promise<void> {
  let directory: WorkspaceSearchMigrationRehearsalPermitDirectory | undefined
  let failed = false
  try {
    directory = await dependencies.openDirectory(directoryPath)
    await directory.sync()
  } catch {
    failed = true
  }
  if (directory !== undefined) {
    try {
      await directory.close()
    } catch {
      failed = true
    }
  }
  if (failed) throw outputBoundaryFailed()
}

/** Checks whether bounded bytes are one exact canonical JSON document. */
function isCanonicalPermitCliDocument(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const candidate: unknown = JSON.parse(text)
    const canonical = new TextEncoder().encode(
      serializeCanonicalJson(candidate),
    )
    return equalPermitCliBytes(bytes, canonical)
  } catch {
    return false
  }
}

/** Copies one exact raw signing key through an intrinsic byte operation. */
function copyPermitCliSigningKey(key: Uint8Array): Uint8Array {
  let copied: unknown
  try {
    copied = Reflect.apply(Uint8Array.prototype.slice, key, [])
  } catch {
    throw invalidSigningKey()
  }
  if (
    !(copied instanceof Uint8Array) ||
    copied.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_SIGNING_KEY_BYTES
  ) {
    throw invalidSigningKey()
  }
  return copied
}

/** Copies and bounds canonical permit bytes before the first output await. */
function copyPermitCliOutputBytes(bytes: Uint8Array): Uint8Array {
  if (
    !(bytes instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_OUTPUT_MAX_BYTES
  ) {
    throw outputBoundaryFailed()
  }
  let copied: unknown
  try {
    copied = Reflect.apply(Uint8Array.prototype.slice, bytes, [])
  } catch {
    throw outputBoundaryFailed()
  }
  if (!(copied instanceof Uint8Array)) throw outputBoundaryFailed()
  return copied
}

/** Reads one exact enumerable own data property without invoking accessors. */
function readPermitClaimsDataProperty(
  record: object,
  property:
    | 'account'
    | 'approval'
    | 'callerArn'
    | 'commit'
    | 'configurationBindingDigest'
    | 'deploymentTargetId'
    | 'deploymentTrustRootDigest'
    | 'evidenceKeyDigest'
    | 'expiresAt'
    | 'integrityResourceIdentityDigest'
    | 'integrityAttestationRoot'
    | 'issuedAt'
    | 'kind'
    | 'permitVersion'
    | 'productionAccount'
    | 'publicationKeyDigest'
    | 'policyVersion'
    | 'region'
    | 'requestedResourcesBinding'
    | 'stage',
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, property)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    throw invalidClaimsFile()
  }
  return descriptor.value
}

/** Checks one exact STS assumed-role ARN against its claimed account. */
function callerArnMatchesPermitAccount(
  callerArn: string,
  account: string,
): boolean {
  const match = /^arn:(?:aws|aws-us-gov|aws-cn):sts::(\d{12}):assumed-role\/[A-Za-z0-9+=,.@_-]{1,64}\/[A-Za-z0-9+=,.@_-]{1,64}$/u.exec(
    callerArn,
  )
  return match?.[1] === account
}

/** Copies every CLI argument before reading any positional flag. */
function snapshotPermitCliArguments(
  arguments_: readonly string[],
): readonly string[] {
  let length: number
  try {
    length = arguments_.length
  } catch {
    throw invalidPermitCliUsage()
  }
  if (length !== 16) throw invalidPermitCliUsage()
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
        throw invalidPermitCliUsage()
      }
      snapshot.push(value)
    }
  } catch {
    throw invalidPermitCliUsage()
  }
  return Object.freeze(snapshot)
}

/** Requires one bounded nonblank explicit path without resolving it. */
function requirePermitCliPath(value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.includes('\0') ||
    value.length > 4_096
  ) {
    throw invalidPermitCliUsage()
  }
  return value
}

/** Compares two non-secret byte vectors without converting them to strings. */
function equalPermitCliBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Compares two exact secret keys without data-dependent byte iteration. */
function samePermitCliSecretKey(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  try {
    return timingSafeEqual(left, right)
  } catch {
    throw invalidIntegrityKey()
  }
}

/** Zeroizes one direct key buffer without allowing cleanup failure to escape. */
function zeroizePermitCliKey(key: Uint8Array | undefined): void {
  if (key === undefined) return
  try {
    Uint8Array.prototype.fill.call(key, 0)
  } catch {
    // The primary issuance outcome remains authoritative.
  }
}

/** Detects only the stable exclusive-create collision code. */
function isPermitCliFileExistsError(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    nodeUtilTypes.isProxy(error)
  ) {
    return false
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor?.value === 'EEXIST'
}

/** Detects only the stable missing-path filesystem code. */
function isPermitCliNoEntryError(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    nodeUtilTypes.isProxy(error)
  ) {
    return false
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor?.value === 'ENOENT'
}

/** Classifies arbitrary errors without inspecting their messages or causes. */
function classifyPermitCliFailure(
  error: unknown,
): WorkspaceSearchMigrationRehearsalPermitCliFailure {
  if (error instanceof WorkspaceSearchMigrationRehearsalPermitCliFailure) {
    return error
  }
  return operationFailed()
}

/** Emits one stable canonical failure line and drops writer errors. */
function writePermitCliFailureLine(
  writeStderrLine: (serializedLine: string) => void,
  code: WorkspaceSearchMigrationRehearsalPermitCliFailureCode,
): void {
  try {
    writeStderrLine(serializeCanonicalJson({
      code,
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_CLI_RESULT_KIND,
      status: 'error',
    }))
  } catch {
    // Raw writer failures never replace the stable exit code.
  }
}

/** Creates one exact strict-command usage failure. */
function invalidPermitCliUsage():
  WorkspaceSearchMigrationRehearsalPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalPermitCliFailure(
    'INVALID_USAGE',
    2,
  )
}

/** Creates one exact reviewed-claims failure. */
function invalidClaimsFile():
  WorkspaceSearchMigrationRehearsalPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalPermitCliFailure(
    'INVALID_CLAIMS_FILE',
    2,
  )
}

/** Creates one exact dedicated #163 key failure. */
function invalidIntegrityKey():
  WorkspaceSearchMigrationRehearsalPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalPermitCliFailure(
    'INVALID_INTEGRITY_KEY',
    2,
  )
}

/** Creates one exact owner-only authenticated root failure. */
function invalidIntegrityAttestationRoot():
  WorkspaceSearchMigrationRehearsalPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalPermitCliFailure(
    'INVALID_INTEGRITY_ATTESTATION_ROOT',
    2,
  )
}

/** Creates one exact private immutable resource snapshot failure. */
function invalidIntegrityResourceAttestation():
  WorkspaceSearchMigrationRehearsalPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalPermitCliFailure(
    'INVALID_INTEGRITY_RESOURCE_ATTESTATION',
    2,
  )
}

/** Creates one exact raw ordinal-zero rate-segment failure. */
function invalidIntegrityRootRateSegment():
  WorkspaceSearchMigrationRehearsalPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalPermitCliFailure(
    'INVALID_INTEGRITY_ROOT_RATE_SEGMENT',
    2,
  )
}

/** Creates one exact raw signing-key failure. */
function invalidSigningKey():
  WorkspaceSearchMigrationRehearsalPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalPermitCliFailure(
    'INVALID_SIGNING_KEY',
    2,
  )
}

/** Creates one exact no-overwrite collision failure. */
function outputFileExists():
  WorkspaceSearchMigrationRehearsalPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalPermitCliFailure(
    'OUTPUT_FILE_EXISTS',
    1,
  )
}

/** Creates one exact output durability failure. */
function outputFileWriteFailed():
  WorkspaceSearchMigrationRehearsalPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalPermitCliFailure(
    'OUTPUT_FILE_WRITE_FAILED',
    1,
  )
}

/** Creates one exact unexpected operation failure. */
function operationFailed():
  WorkspaceSearchMigrationRehearsalPermitCliFailure {
  return new WorkspaceSearchMigrationRehearsalPermitCliFailure(
    'OPERATION_FAILED',
    1,
  )
}

/** Creates one fixed internal durable-writer failure. */
function outputBoundaryFailed(): Error {
  return new Error('OUTPUT_FILE_WRITE_FAILED')
}

/** Creates one fixed raw-path-free secure key-reader failure. */
function signingKeyBoundaryFailed(): Error {
  return new Error('INVALID_SIGNING_KEY')
}

if (import.meta.main) {
  void runWorkspaceSearchMigrationRehearsalPermitCli(
    Bun.argv.slice(2),
    defaultPermitCliDependencies,
  ).then((exitCode) => {
    process.exitCode = exitCode
  })
}
