import { constants as fileSystemConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import {
  createWorkspaceSearchConfigurationHash,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationLease,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationIdentityPort,
  type WorkspaceSearchMigrationManagedAwsSession,
} from './migration-identity-aws'
import {
  validateWorkspaceSearchMigrationRequestedResources,
  type WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import {
  MAINTENANCE_EVIDENCE_MAX_BYTES,
} from './maintenance-evidence'
import {
  type RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  type WorkspaceSearchMigrationPrePlanAuthority,
  type WorkspaceSearchMigrationPrePlanAuthorityClaim,
} from './migration-pre-plan-authority-aws'
import {
  runWithWorkspaceSearchMigrationHeartbeat,
  WorkspaceSearchMigrationHeartbeatInterruptedError,
  type WorkspaceSearchMigrationHeartbeatPort,
} from './migration-heartbeat-supervisor'
import type {
  AcquireWorkspaceSearchMigrationLeaseInput,
  HeartbeatWorkspaceSearchMigrationLeaseInput,
} from './migration-state-machine'
import type {
  WorkspaceSearchWriterFenceObservation,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'

const initialBootstrapApproval = 'initial-writer-fence-bootstrap'

const resourceFlagNames = [
  '--account',
  '--region',
  '--profile',
  '--commit',
  '--project-directory-table',
  '--work-items-table',
  '--collaboration-table',
  '--documents-table',
  '--workspace-search-table',
  '--migration-state-table',
  '--journal-bucket',
  '--journal-key-arn',
]

const measureFlagNames = new Set<string>(resourceFlagNames)
const statusFlagNames = new Set<string>([
  ...resourceFlagNames,
  '--expected-configuration-hash',
])
const bootstrapFlagNames = new Set<string>([
  ...statusFlagNames,
  '--run-id',
  '--owner-id',
  '--maintenance-evidence-file',
  '--approval',
])

const helpPayload = {
  schemaVersion: 1,
  status: 'help',
  commands: [
    'bun run --silent search:migration:control -- measure <resource flags>',
    'bun run --silent search:migration:control -- status <resource flags> --expected-configuration-hash <sha256>',
    `bun run --silent search:migration:control -- bootstrap-open <resource flags> --expected-configuration-hash <sha256> --run-id <id> --owner-id <id> --maintenance-evidence-file <path> --approval ${initialBootstrapApproval}`,
  ],
  resourceFlags: resourceFlagNames,
}

/**
 * Stable operation labels that never contain untrusted argument text.
 */
type WorkspaceSearchMigrationControlCliOperation =
  | 'bootstrap-open'
  | 'help'
  | 'measure'
  | 'status'
  | 'unknown'

/**
 * Stable CLI-only failures safe to emit as one JSON line.
 */
type WorkspaceSearchMigrationControlCliFailureCode =
  | 'INPUT_FILE_INVALID'
  | 'INPUT_FILE_UNREADABLE'
  | 'INTERRUPTED'
  | 'INVALID_USAGE'
  | 'OPERATION_FAILED'

/**
 * Process exit statuses used by the migration control CLI.
 */
export type WorkspaceSearchMigrationControlCliExitCode = 0 | 1 | 2 | 130

/**
 * Classified raw-value-free top-level failure.
 */
type ClassifiedControlCliFailure = {
  /** Stable CLI or migration failure code. */
  readonly code:
    | WorkspaceSearchMigrationControlCliFailureCode
    | WorkspaceSearchMigrationFailureCode
  /** Process exit status for the failure. */
  readonly exitCode: WorkspaceSearchMigrationControlCliExitCode
}

/**
 * Read-only identity-measurement command.
 */
export type WorkspaceSearchMigrationMeasureCliArguments = {
  /** Selected command. */
  readonly command: 'measure'
  /** Complete explicit physical resource selection. */
  readonly resources: WorkspaceSearchMigrationRequestedResources
}

/**
 * Read-only writer-fence status command.
 */
export type WorkspaceSearchMigrationStatusCliArguments = {
  /** Selected command. */
  readonly command: 'status'
  /** Complete explicit physical resource selection. */
  readonly resources: WorkspaceSearchMigrationRequestedResources
  /** Reviewed digest of the exact measured resource incarnation. */
  readonly expectedConfigurationHash: string
}

/**
 * Explicit initial writer-fence bootstrap command.
 */
export type WorkspaceSearchMigrationBootstrapOpenCliArguments = {
  /** Exact approval phrase for this initial-only capability. */
  readonly approval: typeof initialBootstrapApproval
  /** Selected command. */
  readonly command: 'bootstrap-open'
  /** Reviewed digest of the exact measured resource incarnation. */
  readonly expectedConfigurationHash: string
  /** Exact maintenance evidence file path. */
  readonly maintenanceEvidenceFile: string
  /** Process-unique lease owner identifier. */
  readonly ownerId: string
  /** Complete explicit physical resource selection. */
  readonly resources: WorkspaceSearchMigrationRequestedResources
  /** Operator-selected migration run identifier. */
  readonly runId: string
}

/**
 * Machine-readable help command.
 */
export type WorkspaceSearchMigrationControlHelpCliArguments = {
  /** Selected command. */
  readonly command: 'help'
}

/**
 * Strictly parsed migration control CLI arguments.
 */
export type WorkspaceSearchMigrationControlCliArguments =
  | WorkspaceSearchMigrationBootstrapOpenCliArguments
  | WorkspaceSearchMigrationControlHelpCliArguments
  | WorkspaceSearchMigrationMeasureCliArguments
  | WorkspaceSearchMigrationStatusCliArguments

/**
 * Safe writer-fence state emitted without physical resource identifiers.
 */
export type WorkspaceSearchMigrationWriterFenceSummary =
  | {
      /** No row exists for the measured state and dataset incarnation. */
      readonly status: 'missing'
    }
  | {
      /** A strict durable writer-fence row exists. */
      readonly status: 'present'
      /** Whether guarded application mutations are admitted. */
      readonly mode: 'closed' | 'open'
      /** Monotonic writer epoch. */
      readonly writerEpoch: number
      /** Monotonic control-row revision. */
      readonly controlRevision: number
      /** Digest of the exact canonical durable record. */
      readonly recordDigest: string
    }

/**
 * Narrow measured session used by the CLI composition root.
 */
export interface WorkspaceSearchMigrationControlCliSession
  extends WorkspaceSearchMigrationHeartbeatPort {
  /**
   * Measures the complete resource identity and returns its canonical digest.
   *
   * @returns Reviewed configuration hash.
   */
  measureConfigurationHash(): Promise<string>

  /**
   * Acquires or recovers one exact global lease.
   *
   * @param input - Operator-selected run and process owner.
   * @returns Exact durable lease.
   */
  acquireLease(
    input: AcquireWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease>

  /**
   * Renews one immutable maintenance receipt under an active lease.
   *
   * @param input - Exact lease, pointer predecessor, and evidence bytes.
   * @returns Current durable pre-plan authority.
   */
  renewMaintenanceEvidence(
    input: RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority>

  /**
   * Strongly refreshes one exact lease, pointer, and receipt tuple.
   *
   * @param claim - Exact current authority claim.
   * @returns Fresh current authority.
   */
  readAuthority(
    claim: WorkspaceSearchMigrationPrePlanAuthorityClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority>

  /**
   * Strongly reads the measured writer-fence state.
   *
   * @returns Safe detached writer-fence summary.
   */
  readWriterFence(): Promise<WorkspaceSearchMigrationWriterFenceSummary>

  /**
   * Performs the initial missing-to-open transition.
   *
   * @param authority - Fresh lease and maintenance evidence authority.
   * @returns Exact durable open-row summary.
   */
  bootstrapWriterFence(
    authority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchMigrationWriterFenceSummary>

  /**
   * Invalidates the measured generation and releases every AWS client.
   */
  close(): void
}

/**
 * Injectable factories used by the top-level CLI boundary.
 */
export type WorkspaceSearchMigrationControlCliDependencies = {
  /**
   * Creates one closeable measured session for explicit resources.
   */
  readonly createSession: (
    resources: WorkspaceSearchMigrationRequestedResources,
  ) => WorkspaceSearchMigrationControlCliSession
  /**
   * Reads one bounded maintenance evidence file.
   */
  readonly readMaintenanceEvidenceFile: (
    path: string,
  ) => Promise<Uint8Array>
}

/**
 * Result of one initial writer-fence bootstrap.
 */
type BootstrapOpenResult = {
  /** Exact current lease fence. */
  readonly fenceToken: number
  /** Current immutable maintenance receipt digest. */
  readonly maintenanceEvidenceReceiptDigest: string
  /** Current optimistic maintenance pointer revision. */
  readonly maintenanceEvidencePointerRevision: number
  /** Exact durable open writer-fence state. */
  readonly writerFence: WorkspaceSearchMigrationWriterFenceSummary
}

/**
 * Safe CLI failure with a stable code and process status.
 */
class WorkspaceSearchMigrationControlCliFailure extends Error {
  /** Stable raw-value-free failure code. */
  readonly code: WorkspaceSearchMigrationControlCliFailureCode

  /** Process exit status for the failure. */
  readonly exitCode: WorkspaceSearchMigrationControlCliExitCode

  /**
   * Creates one safe CLI failure.
   *
   * @param code - Stable CLI category.
   * @param exitCode - Process exit status.
   */
  constructor(
    code: WorkspaceSearchMigrationControlCliFailureCode,
    exitCode: WorkspaceSearchMigrationControlCliExitCode,
  ) {
    super(code)
    this.name = 'WorkspaceSearchMigrationControlCliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

const defaultControlCliDependencies:
  WorkspaceSearchMigrationControlCliDependencies = {
    createSession: createDefaultControlCliSession,
    readMaintenanceEvidenceFile,
  }

/**
 * Parses strict subcommands and explicit flags without ambient defaults.
 *
 * @param arguments_ - Arguments following the script path.
 * @returns Validated command configuration.
 */
export function parseWorkspaceSearchMigrationControlCliArguments(
  arguments_: readonly string[],
): WorkspaceSearchMigrationControlCliArguments {
  const command = arguments_[0]
  if (command === 'help' || command === '--help') {
    if (arguments_.length !== 1) throw invalidUsage()
    return { command: 'help' }
  }
  if (command === 'measure') {
    const flags = parseFlagPairs(arguments_.slice(1), measureFlagNames)
    return {
      command,
      resources: parseRequestedResources(flags),
    }
  }
  if (command === 'status') {
    const flags = parseFlagPairs(arguments_.slice(1), statusFlagNames)
    return {
      command,
      resources: parseRequestedResources(flags),
      expectedConfigurationHash:
        requireConfigurationHash(flags),
    }
  }
  if (command === 'bootstrap-open') {
    const flags = parseFlagPairs(arguments_.slice(1), bootstrapFlagNames)
    const approval = requireFlag(flags, '--approval')
    if (approval !== initialBootstrapApproval) throw invalidUsage()
    return {
      approval,
      command,
      resources: parseRequestedResources(flags),
      expectedConfigurationHash:
        requireConfigurationHash(flags),
      maintenanceEvidenceFile:
        requireSafePath(flags, '--maintenance-evidence-file'),
      ownerId: requireMigrationIdentifier(flags, '--owner-id'),
      runId: requireMigrationIdentifier(flags, '--run-id'),
    }
  }
  throw invalidUsage()
}

/**
 * Executes the operator CLI and emits one deterministic JSON line.
 *
 * @param arguments_ - Arguments following the script path.
 * @param dependencies - Injectable file and session factories.
 * @param signal - Optional cooperative operator-interruption signal.
 * @returns Stable process exit status.
 */
export async function runWorkspaceSearchMigrationControlCli(
  arguments_: readonly string[],
  dependencies:
    WorkspaceSearchMigrationControlCliDependencies =
      defaultControlCliDependencies,
  signal?: AbortSignal,
): Promise<WorkspaceSearchMigrationControlCliExitCode> {
  const operation = identifyOperation(arguments_[0])
  try {
    const configuration =
      parseWorkspaceSearchMigrationControlCliArguments(arguments_)
    if (configuration.command === 'help') {
      writeJsonLine(console.log, helpPayload)
      return 0
    }
    requireNotInterrupted(signal)

    const evidenceBytes =
      configuration.command === 'bootstrap-open'
        ? await dependencies.readMaintenanceEvidenceFile(
            configuration.maintenanceEvidenceFile,
          )
        : undefined
    requireNotInterrupted(signal)

    const result = await runWithControlCliSession(
      dependencies.createSession(configuration.resources),
      async (session) => {
        requireNotInterrupted(signal)
        const configurationHash =
          await session.measureConfigurationHash()
        requireNotInterrupted(signal)

        if (configuration.command === 'measure') {
          return {
            schemaVersion: 1,
            operation: configuration.command,
            status: 'pass',
            configurationHash,
          }
        }

        requireExpectedConfigurationHash(
          configurationHash,
          configuration.expectedConfigurationHash,
        )

        if (configuration.command === 'status') {
          requireNotInterrupted(signal)
          const writerFence = await session.readWriterFence()
          requireNotInterrupted(signal)
          return {
            schemaVersion: 1,
            operation: configuration.command,
            status: 'pass',
            configurationHash,
            writerFence,
          }
        }

        if (evidenceBytes === undefined) {
          throw new WorkspaceSearchMigrationControlCliFailure(
            'OPERATION_FAILED',
            1,
          )
        }
        const bootstrap = await runBootstrapOpen(
          configuration,
          evidenceBytes,
          session,
          signal,
        )
        return {
          schemaVersion: 1,
          operation: configuration.command,
          status: 'pass',
          configurationHash,
          authority: {
            fenceToken: bootstrap.fenceToken,
            maintenanceEvidencePointerRevision:
              bootstrap.maintenanceEvidencePointerRevision,
            maintenanceEvidenceReceiptDigest:
              bootstrap.maintenanceEvidenceReceiptDigest,
          },
          writerFence: bootstrap.writerFence,
        }
      },
    )
    writeJsonLine(console.log, result)
    return 0
  } catch (error: unknown) {
    const failure = classifyControlCliFailure(error)
    writeJsonLine(console.error, {
      schemaVersion: 1,
      operation,
      status: 'error',
      code: failure.code,
    })
    return failure.exitCode
  }
}

/**
 * Runs the explicit initial bootstrap under a single-flight heartbeat.
 *
 * @param configuration - Strict initial-bootstrap command.
 * @param evidenceBytes - Exact bounded maintenance evidence bytes.
 * @param session - Current measured session.
 * @param signal - Optional operator-interruption signal.
 * @returns Safe durable authority and fence summary.
 */
async function runBootstrapOpen(
  configuration: WorkspaceSearchMigrationBootstrapOpenCliArguments,
  evidenceBytes: Uint8Array,
  session: WorkspaceSearchMigrationControlCliSession,
  signal?: AbortSignal,
): Promise<BootstrapOpenResult> {
  requireNotInterrupted(signal)
  const lease = await session.acquireLease({
    runId: configuration.runId,
    ownerId: configuration.ownerId,
  })
  requireNotInterrupted(signal)

  return await runWithWorkspaceSearchMigrationHeartbeat({
    lease,
    port: session,
    signal,
    task: async (context): Promise<BootstrapOpenResult> => {
      context.assertActive()
      const authority = await session.renewMaintenanceEvidence({
        lease: context.lease,
        expectedPointer: null,
        evidenceBytes,
      })
      context.assertActive()
      const refreshedAuthority = await session.readAuthority({
        lease: context.lease,
        maintenanceEvidenceReceiptDigest:
          authority.maintenanceEvidenceReceiptDigest,
        maintenanceEvidencePointerRevision:
          authority.maintenanceEvidencePointerRevision,
      })
      context.assertActive()
      const writerFence =
        await session.bootstrapWriterFence(refreshedAuthority)
      context.assertActive()
      requireOpenWriterFence(writerFence)
      return {
        fenceToken: refreshedAuthority.lease.fenceToken,
        maintenanceEvidenceReceiptDigest:
          refreshedAuthority.maintenanceEvidenceReceiptDigest,
        maintenanceEvidencePointerRevision:
          refreshedAuthority.maintenanceEvidencePointerRevision,
        writerFence,
      }
    },
  })
}

/**
 * Runs one task and closes its measured session exactly once afterward.
 *
 * A task failure remains primary if an injected close also fails. A cleanup
 * failure suppresses an otherwise successful result.
 *
 * @param session - Closeable measured session.
 * @param task - Session-bound operation.
 * @returns Task result after successful cleanup.
 */
async function runWithControlCliSession<Result>(
  session: WorkspaceSearchMigrationControlCliSession,
  task: (
    session: WorkspaceSearchMigrationControlCliSession,
  ) => Promise<Result>,
): Promise<Result> {
  let outcome:
    | { readonly status: 'success'; readonly value: Result }
    | { readonly status: 'failure'; readonly error: unknown }
  try {
    outcome = {
      status: 'success',
      value: await task(session),
    }
  } catch (error: unknown) {
    outcome = { status: 'failure', error }
  }

  let closeFailed = false
  try {
    session.close()
  } catch {
    closeFailed = true
  }
  if (outcome.status === 'failure') {
    throw outcome.error
  }
  if (closeFailed) {
    throw new WorkspaceSearchMigrationControlCliFailure(
      'OPERATION_FAILED',
      1,
    )
  }
  return outcome.value
}

/**
 * Creates the production narrow CLI session over one managed AWS session.
 *
 * @param resources - Explicit operator-selected physical resources.
 * @returns Capability-minimized session used by CLI orchestration.
 */
function createDefaultControlCliSession(
  resources: WorkspaceSearchMigrationRequestedResources,
): WorkspaceSearchMigrationControlCliSession {
  const managed =
    createAwsWorkspaceSearchMigrationIdentityPort(resources)
  return createControlCliSession(managed)
}

/**
 * Narrows one managed AWS session to the CLI's current safe capabilities.
 *
 * @param managed - Complete measured migration session.
 * @returns Narrow control CLI session.
 */
function createControlCliSession(
  managed: WorkspaceSearchMigrationManagedAwsSession,
): WorkspaceSearchMigrationControlCliSession {
  return {
    measureConfigurationHash: async (): Promise<string> =>
      createWorkspaceSearchConfigurationHash(
        await managed.measureConfiguration(),
      ),
    acquireLease: async (
      input: AcquireWorkspaceSearchMigrationLeaseInput,
    ): Promise<WorkspaceSearchMigrationLease> =>
      await managed.acquireLease(input),
    heartbeatLease: async (
      input: HeartbeatWorkspaceSearchMigrationLeaseInput,
    ): Promise<WorkspaceSearchMigrationLease> =>
      await managed.heartbeatLease(input),
    renewMaintenanceEvidence: async (
      input: RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
    ): Promise<WorkspaceSearchMigrationPrePlanAuthority> =>
      await managed.renewMaintenanceEvidence(input),
    readAuthority: async (
      claim: WorkspaceSearchMigrationPrePlanAuthorityClaim,
    ): Promise<WorkspaceSearchMigrationPrePlanAuthority> =>
      await managed.readAuthority(claim),
    readWriterFence: async ():
      Promise<WorkspaceSearchMigrationWriterFenceSummary> =>
        summarizeWriterFence(
          await managed.createApplicationWriterFencePort().read(),
        ),
    bootstrapWriterFence: async (
      authority: WorkspaceSearchMigrationPrePlanAuthority,
    ): Promise<WorkspaceSearchMigrationWriterFenceSummary> =>
      summarizeWriterFence(
        await managed
          .createApplicationWriterFencePort()
          .bootstrapOpen(authority),
      ),
    close: (): void => {
      managed.close()
    },
  }
}

/**
 * Removes physical names, table IDs, and authority identifiers from a fence read.
 *
 * @param observation - Strict measured writer-fence observation.
 * @returns Operator-safe status and canonical record digest.
 */
function summarizeWriterFence(
  observation: WorkspaceSearchWriterFenceObservation,
): WorkspaceSearchMigrationWriterFenceSummary {
  if (observation.status === 'missing') {
    return { status: 'missing' }
  }
  return {
    status: 'present',
    mode: observation.record.mode,
    writerEpoch: observation.record.writerEpoch,
    controlRevision: observation.record.controlRevision,
    recordDigest: observation.record.recordDigest,
  }
}

/**
 * Requires the bootstrap transition to return an exact open row.
 *
 * @param summary - Safe writer-fence summary.
 */
function requireOpenWriterFence(
  summary: WorkspaceSearchMigrationWriterFenceSummary,
): void {
  if (summary.status !== 'present' || summary.mode !== 'open') {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Initial writer-fence bootstrap did not produce an open row.',
    )
  }
}

/**
 * Reads one regular maintenance evidence file through the contract byte limit.
 *
 * @param path - Explicit operator-supplied path.
 * @returns Exact detached file bytes.
 */
export async function readMaintenanceEvidenceFile(
  path: string,
): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      path,
      fileSystemConstants.O_RDONLY | fileSystemConstants.O_NONBLOCK,
    )
  } catch {
    throw new WorkspaceSearchMigrationControlCliFailure(
      'INPUT_FILE_UNREADABLE',
      2,
    )
  }
  try {
    const file = await handle.stat()
    if (
      !file.isFile() ||
      file.size === 0 ||
      file.size > MAINTENANCE_EVIDENCE_MAX_BYTES
    ) {
      throw new WorkspaceSearchMigrationControlCliFailure(
        'INPUT_FILE_INVALID',
        2,
      )
    }
    const buffer = Buffer.alloc(MAINTENANCE_EVIDENCE_MAX_BYTES + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      )
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset === 0 || offset > MAINTENANCE_EVIDENCE_MAX_BYTES) {
      throw new WorkspaceSearchMigrationControlCliFailure(
        'INPUT_FILE_INVALID',
        2,
      )
    }
    return new Uint8Array(buffer.subarray(0, offset))
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationControlCliFailure) {
      throw error
    }
    throw new WorkspaceSearchMigrationControlCliFailure(
      'INPUT_FILE_UNREADABLE',
      2,
    )
  } finally {
    try {
      await handle.close()
    } catch {
      // The raw filesystem error must not cross the CLI boundary.
    }
  }
}

/**
 * Parses and validates the complete explicit resource selection.
 *
 * @param flags - Strict flag/value map.
 * @returns Validated requested resources.
 */
function parseRequestedResources(
  flags: ReadonlyMap<string, string>,
): WorkspaceSearchMigrationRequestedResources {
  const resources: WorkspaceSearchMigrationRequestedResources = {
    account: requireFlag(flags, '--account'),
    region: requireFlag(flags, '--region'),
    profile: requireFlag(flags, '--profile'),
    commit: requireFlag(flags, '--commit'),
    tables: {
      'project-directory':
        requireFlag(flags, '--project-directory-table'),
      'work-items': requireFlag(flags, '--work-items-table'),
      collaboration: requireFlag(flags, '--collaboration-table'),
      documents: requireFlag(flags, '--documents-table'),
      'workspace-search':
        requireFlag(flags, '--workspace-search-table'),
      'migration-state':
        requireFlag(flags, '--migration-state-table'),
    },
    journalBucket: requireFlag(flags, '--journal-bucket'),
    journalKeyArn: requireFlag(flags, '--journal-key-arn'),
  }
  try {
    validateWorkspaceSearchMigrationRequestedResources(resources)
  } catch {
    throw invalidUsage()
  }
  return resources
}

/**
 * Parses unique explicit flag/value pairs.
 *
 * @param arguments_ - Arguments after the subcommand.
 * @param allowedNames - Exact command-specific flag allowlist.
 * @returns Unique flag/value map.
 */
function parseFlagPairs(
  arguments_: readonly string[],
  allowedNames: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  if (arguments_.length % 2 !== 0) throw invalidUsage()
  const flags = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (
      name === undefined ||
      value === undefined ||
      !allowedNames.has(name) ||
      flags.has(name) ||
      value.startsWith('--') ||
      value.length === 0
    ) {
      throw invalidUsage()
    }
    flags.set(name, value)
  }
  return flags
}

/**
 * Reads one required flag.
 *
 * @param flags - Strict flag map.
 * @param name - Required allowlisted flag.
 * @returns Non-empty flag value.
 */
function requireFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = flags.get(name)
  if (value === undefined) throw invalidUsage()
  return value
}

/**
 * Reads one lowercase SHA-256 configuration hash.
 *
 * @param flags - Strict flag map.
 * @returns Validated expected configuration hash.
 */
function requireConfigurationHash(
  flags: ReadonlyMap<string, string>,
): string {
  const value = requireFlag(flags, '--expected-configuration-hash')
  if (!/^[0-9a-f]{64}$/u.test(value)) throw invalidUsage()
  return value
}

/**
 * Reads one safe operator-selected migration identifier.
 *
 * @param flags - Strict flag map.
 * @param name - Identifier flag.
 * @returns Validated identifier.
 */
function requireMigrationIdentifier(
  flags: ReadonlyMap<string, string>,
  name: '--owner-id' | '--run-id',
): string {
  const value = requireFlag(flags, name)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw invalidUsage()
  }
  return value
}

/**
 * Reads one bounded path without logging or resolving it.
 *
 * @param flags - Strict flag map.
 * @param name - Required path flag.
 * @returns Exact caller path.
 */
function requireSafePath(
  flags: ReadonlyMap<string, string>,
  name: '--maintenance-evidence-file',
): string {
  const value = requireFlag(flags, name)
  if (value.includes('\0') || value.trim().length === 0) {
    throw invalidUsage()
  }
  return value
}

/**
 * Compares the measured configuration against the separately reviewed digest.
 *
 * @param measured - Digest derived from the current AWS measurement.
 * @param expected - Operator-reviewed digest.
 */
function requireExpectedConfigurationHash(
  measured: string,
  expected: string,
): void {
  if (measured !== expected) {
    throw new WorkspaceSearchMigrationFailure(
      'CONFIGURATION_HASH_MISMATCH',
      'Measured migration configuration does not match the reviewed digest.',
    )
  }
}

/**
 * Fails cooperatively when the operator already requested interruption.
 *
 * @param signal - Optional interruption signal.
 */
function requireNotInterrupted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new WorkspaceSearchMigrationHeartbeatInterruptedError()
  }
}

/**
 * Creates one stable invalid-usage failure.
 *
 * @returns CLI failure with exit status two.
 */
function invalidUsage(): WorkspaceSearchMigrationControlCliFailure {
  return new WorkspaceSearchMigrationControlCliFailure(
    'INVALID_USAGE',
    2,
  )
}

/**
 * Converts an untrusted exception into a raw-value-free CLI failure.
 *
 * @param error - Caught unknown failure.
 * @returns Stable code and process exit status.
 */
function classifyControlCliFailure(
  error: unknown,
): ClassifiedControlCliFailure {
  if (error instanceof WorkspaceSearchMigrationControlCliFailure) {
    return {
      code: error.code,
      exitCode: error.exitCode,
    }
  }
  if (error instanceof WorkspaceSearchMigrationHeartbeatInterruptedError) {
    return {
      code: 'INTERRUPTED',
      exitCode: 130,
    }
  }
  if (error instanceof WorkspaceSearchMigrationFailure) {
    return {
      code: error.code,
      exitCode: 1,
    }
  }
  return {
    code: 'OPERATION_FAILED',
    exitCode: 1,
  }
}

/**
 * Identifies a safe operation label without returning arbitrary arguments.
 *
 * @param command - First CLI argument.
 * @returns Stable operation label.
 */
function identifyOperation(
  command: string | undefined,
): WorkspaceSearchMigrationControlCliOperation {
  if (
    command === 'bootstrap-open' ||
    command === 'measure' ||
    command === 'status'
  ) {
    return command
  }
  if (command === 'help' || command === '--help') {
    return 'help'
  }
  return 'unknown'
}

/**
 * Writes one compact deterministic JSON line.
 *
 * @param writer - Console writer.
 * @param value - Raw-value-free payload.
 */
function writeJsonLine(
  writer: (value: string) => void,
  value: unknown,
): void {
  writer(JSON.stringify(value))
}

if (import.meta.main) {
  const controller = new AbortController()
  let signalExitCode: 130 | 143 | undefined
  /**
   * Records only the first process signal and requests cooperative shutdown.
   *
   * @param exitCode - Conventional process status for the signal.
   */
  const interrupt = (exitCode: 130 | 143): void => {
    if (signalExitCode !== undefined) return
    signalExitCode = exitCode
    controller.abort()
  }
  /** Requests cooperative shutdown for an interactive interrupt. */
  const handleSigint = (): void => interrupt(130)
  /** Requests cooperative shutdown for a termination signal. */
  const handleSigterm = (): void => interrupt(143)
  process.once('SIGINT', handleSigint)
  process.once('SIGTERM', handleSigterm)
  void runWorkspaceSearchMigrationControlCli(
    Bun.argv.slice(2),
    defaultControlCliDependencies,
    controller.signal,
  ).then((exitCode) => {
    process.off('SIGINT', handleSigint)
    process.off('SIGTERM', handleSigterm)
    process.exitCode =
      exitCode === 130 && signalExitCode !== undefined
        ? signalExitCode
        : exitCode
  })
}
