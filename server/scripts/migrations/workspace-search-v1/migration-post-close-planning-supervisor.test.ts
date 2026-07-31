import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  MigrationDigestAccumulator,
  serializeCanonicalJson,
  type MigrationKeyAttribute,
  type MigrationScanAggregate,
  type MigrationTableIdentity,
  type WorkspaceSearchDryRunEvidence,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationLease,
  type WorkspaceSearchMigrationScanSnapshot,
  type WorkspaceSearchMigrationSourceName,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  serializeWorkspaceSearchDryRunEvidence,
} from './migration-artifacts'
import {
  admitWorkspaceSearchMigrationExecutionBoundaryPlanning,
  createWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationClosedExecutionBoundary,
  type WorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import type {
  AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput,
  WorkspaceSearchMigrationExecutionBoundaryAwsPort,
} from './migration-execution-boundary-aws'
import type {
  WorkspaceSearchMigrationHeartbeatScheduler,
  WorkspaceSearchMigrationHeartbeatTimerHandle,
} from './migration-heartbeat-supervisor'
import {
  type ValidateWorkspaceSearchMigrationPlanningArtifactPreflightInput,
  WORKSPACE_SEARCH_MIGRATION_MANAGED_ARTIFACT_REQUEST_TIMEOUT_MILLISECONDS,
  type WorkspaceSearchMigrationPreparedCommittedPlanningEvidence,
} from './migration-identity-aws'
import {
  hasWorkspaceSearchMigrationImmutableArtifactRetentionHeadroom,
  type ReadWorkspaceSearchMigrationImmutableArtifactInput,
  type WorkspaceSearchMigrationImmutableArtifactAwsPort,
  type WorkspaceSearchMigrationImmutableArtifactReference,
  type WriteWorkspaceSearchMigrationImmutableArtifactInput,
} from './migration-immutable-artifact-aws'
import {
  createAwsWorkspaceSearchMigrationPlanningArtifactGateway,
  type WorkspaceSearchMigrationPlanningArtifactAwsGateway,
} from './migration-planning-artifact-aws'
import {
  joinWorkspaceSearchMigrationPlanningEvidence,
  type WorkspaceSearchMigrationPlanningJoinLimits,
  type WorkspaceSearchMigrationPlanningJoinResult,
} from './migration-planning-join'
import type {
  WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding,
  WorkspaceSearchMigrationPrePlanAuthority,
  WorkspaceSearchMigrationPrePlanAuthorityClaim,
  WorkspaceSearchMigrationPrePlanMaintenancePointerClaim,
  RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
} from './migration-pre-plan-authority-aws'
import {
  createWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import type {
  PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
  WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort,
} from './migration-sealed-planning-authority-aws'
import type {
  WorkspaceSearchMigrationPlanningSourceEvidencePage,
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  advanceWorkspaceSearchMigrationSourceEvidenceProgress,
  createInitialWorkspaceSearchMigrationSourceEvidenceProgress,
  createWorkspaceSearchMigrationSourceEvidencePage,
  serializeWorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationPlanningAuthorityBinding,
  type WorkspaceSearchMigrationSourceEvidenceProgress,
} from './migration-source-evidence'
import type {
  WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest,
  WorkspaceSearchMigrationSourceEvidenceAwsRequest,
} from './migration-source-evidence-aws'
import {
  createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey,
} from './migration-source-artifact'
import {
  advanceWorkspaceSearchMigrationTargetEvidenceProgress,
  createInitialWorkspaceSearchMigrationTargetEvidenceProgress,
  createWorkspaceSearchMigrationTargetEvidencePage,
  serializeWorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidencePage,
  type WorkspaceSearchMigrationTargetEvidenceProgress,
} from './migration-target-evidence'
import type {
  WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest,
  WorkspaceSearchMigrationTargetEvidenceAwsRequest,
} from './migration-target-evidence-aws'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
} from './migration-target-artifact'
import {
  maintenanceRuntimeControlSurfaces,
  parseMaintenanceEvidence,
  type WorkspaceSearchMaintenanceEvidence,
} from './maintenance-evidence'
import type {
  AcquireWorkspaceSearchMigrationLeaseInput,
  HeartbeatWorkspaceSearchMigrationLeaseInput,
  WorkspaceSearchMigrationLeaseClaim,
} from './migration-state-machine'
import {
  superviseWorkspaceSearchMigrationPostClosePlanning,
  type SuperviseWorkspaceSearchMigrationPostClosePlanningInput,
  type WorkspaceSearchMigrationCollectedMaintenanceEvidence,
  type WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest,
  type WorkspaceSearchMigrationMaintenanceEvidenceProvider,
  type WorkspaceSearchMigrationPostClosePlanningSession,
} from './migration-post-close-planning-supervisor'

const runId = 'post-close-planning-run'
const ownerId = 'post-close-planning-owner'
const now = new Date('2026-07-31T01:36:00.000Z')
const closedAt = '2026-07-31T01:20:00.000Z'
const drainCompletedAt = '2026-07-31T01:35:00.000Z'
const retainUntil = '2026-08-31T00:00:00.000Z'
const retentionDayMilliseconds = 24 * 60 * 60 * 1_000
const planningJoinLimits: WorkspaceSearchMigrationPlanningJoinLimits = {
  maxTotalRows: 100,
  maxTotalCanonicalItemBytes: 1024 * 1024,
  maxPlanOperations: 100,
}

/**
 * One source page and its exact terminal durable progress.
 */
type StoredSourcePlanningPage = {
  /** Strict terminal planning page. */
  readonly page: WorkspaceSearchMigrationPlanningSourceEvidencePage
  /** Canonical exact page bytes retained for provenance. */
  readonly bytes: Uint8Array
  /** Durable terminal head derived from the page. */
  readonly progress: WorkspaceSearchMigrationSourceEvidenceProgress
}

/**
 * One target page and its exact terminal durable progress.
 */
type StoredTargetPlanningPage = {
  /** Strict terminal planning page. */
  readonly page: WorkspaceSearchMigrationTargetEvidencePage
  /** Canonical exact page bytes retained for provenance. */
  readonly bytes: Uint8Array
  /** Durable terminal head derived from the page. */
  readonly progress: WorkspaceSearchMigrationTargetEvidenceProgress
}

/**
 * Shared restart-safe state retained independently from a fake session.
 */
type DurableSupervisorState = {
  /** Current revision-one or revision-two execution boundary. */
  boundary: WorkspaceSearchMigrationExecutionBoundary | undefined
  /** Revision-one predecessor retained for mismatch tests. */
  closedBoundary: WorkspaceSearchMigrationClosedExecutionBoundary | undefined
  /** Current immutable sealed planning root. */
  root: WorkspaceSearchMigrationSealedPlanningAuthorityV2 | undefined
  /** Committed source evidence heads and their exact page material. */
  readonly sources:
    Map<WorkspaceSearchMigrationSourceName, StoredSourcePlanningPage>
  /** Committed target evidence head and its exact page material. */
  target: StoredTargetPlanningPage | undefined
  /** Current fenced lease shared across restart sessions. */
  lease: WorkspaceSearchMigrationLease | undefined
  /** Current maintenance pointer revision. */
  pointerRevision: number
  /** Latest strongly resolved authority. */
  currentAuthority: WorkspaceSearchMigrationPrePlanAuthority | undefined
  /** Historical receipt bindings retained by digest. */
  readonly historicalBindings:
    Map<string, WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding>
  /** Five planning heads observed when close linearized. */
  headsAtClose: readonly string[]
}

/**
 * Optional failures and barriers injected into one fake session.
 */
type RecordingSessionBehavior = {
  /** Fails the first periodic heartbeat after the initial heartbeat succeeds. */
  readonly failPeriodicHeartbeat?: boolean
  /** Optional artifact-preflight clock advanced by a focused test. */
  readonly artifactPreflightClock?: () => Date
  /** Optional sealed-root publication clock advanced by a focused test. */
  readonly sealedRootClock?: () => Date
  /** Fails planning after durable post-close evidence is complete. */
  readonly failPlanningPreparation?: boolean
  /** Optional barrier entered by a selected source page commit. */
  readonly beforeSourceCommit?: (
    source: WorkspaceSearchMigrationSourceName,
  ) => Promise<void>
  /** Source whose first durable page response is lost after commit. */
  readonly loseSourceCommitResponse?:
    WorkspaceSearchMigrationSourceName
  /** Loses the first sealed-root response after durable publication. */
  readonly loseRootPublishResponse?: boolean
}

/**
 * Pending promise controlled explicitly by a test.
 */
type Deferred<Value> = {
  /** Pending promise. */
  readonly promise: Promise<Value>
  /** Resolves the promise exactly once. */
  readonly resolve: (value: Value) => void
}

/**
 * One callback recorded by the deterministic heartbeat scheduler.
 */
type ManualHeartbeat = {
  /** One-shot callback supplied by the heartbeat supervisor. */
  readonly callback: () => void
  /** Whether the callback was canceled before it started. */
  canceled: boolean
  /** Whether the callback already started. */
  started: boolean
}

/**
 * Deterministic scheduler that advances only when a test requests it.
 */
class ManualHeartbeatScheduler
implements WorkspaceSearchMigrationHeartbeatScheduler {
  /** Recorded one-shot heartbeat callbacks. */
  readonly heartbeats: ManualHeartbeat[] = []

  /**
   * Records one scheduled heartbeat.
   *
   * @param callback - One-shot heartbeat callback.
   * @returns Cancelable callback handle.
   */
  schedule(
    callback: () => void,
  ): WorkspaceSearchMigrationHeartbeatTimerHandle {
    const heartbeat: ManualHeartbeat = {
      callback,
      canceled: false,
      started: false,
    }
    this.heartbeats.push(heartbeat)
    return {
      cancel: (): void => {
        heartbeat.canceled = true
      },
    }
  }

  /**
   * Starts the oldest active heartbeat callback.
   */
  runNext(): void {
    const heartbeat = this.heartbeats.find(
      (candidate) => !candidate.canceled && !candidate.started,
    )
    if (heartbeat === undefined) {
      throw new Error('No active heartbeat was scheduled.')
    }
    heartbeat.started = true
    heartbeat.callback()
  }
}

/**
 * Minimal exact-version immutable store used only to make valid graph roots.
 */
class InMemoryImmutableArtifactPort
implements WorkspaceSearchMigrationImmutableArtifactAwsPort {
  /** Exact object bytes indexed by object key and immutable version. */
  private readonly objects = new Map<string, Uint8Array>()

  /** Monotonic deterministic immutable version number. */
  private nextVersion = 1

  /**
   * Stores detached bytes and returns a rich immutable reference.
   *
   * @param input - Exact codec-owned object write.
   * @returns Deterministic version-pinned reference.
   */
  async writeImmutableArtifact(
    input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<WorkspaceSearchMigrationImmutableArtifactReference> {
    const bytes = Uint8Array.from(input.bytes)
    const contentDigest = digestBytes(bytes)
    const reference: WorkspaceSearchMigrationImmutableArtifactReference = {
      objectKey:
        `${input.objectKeyPrefix}/${input.role}/${contentDigest}.artifact`,
      versionId: `version-${this.nextVersion}`,
      contentDigest,
      byteLength: bytes.byteLength,
      retainUntil: input.retainUntil,
    }
    this.nextVersion += 1
    this.objects.set(createArtifactStorageKey(reference), bytes)
    return reference
  }

  /**
   * Reads detached bytes from one exact immutable version.
   *
   * @param input - Exact codec-owned version lookup.
   * @returns Detached stored bytes.
   */
  async readImmutableArtifact(
    input: ReadWorkspaceSearchMigrationImmutableArtifactInput,
  ): Promise<Uint8Array> {
    const bytes = this.objects.get(
      createArtifactStorageKey(input.reference),
    )
    if (bytes === undefined) {
      throw new Error('Immutable fixture object was not found.')
    }
    return Uint8Array.from(bytes)
  }
}

/**
 * Trusted evidence provider that records close and post-close requests.
 */
class RecordingMaintenanceEvidenceProvider
implements WorkspaceSearchMigrationMaintenanceEvidenceProvider {
  /** Requests received in exact supervisor order. */
  readonly requests:
    WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest[] = []

  /** Whether post-close evidence should begin just before close. */
  invalidPostCloseStart = false

  /** Exact measured TableIds returned with every evidence file. */
  private readonly tableIds:
    WorkspaceSearchMigrationSealedPlanningTableIds

  /** Optional post-close collection barrier. */
  postCloseBarrier: Promise<void> | undefined

  /** Monotonic runtime-control revision independent from trace resets. */
  private nextRuntimeRevision = 41

  /**
   * Creates a provider bound to one measured configuration.
   *
   * @param tableIds - Exact measured six-TableId binding.
   */
  constructor(tableIds: WorkspaceSearchMigrationSealedPlanningTableIds) {
    this.tableIds = tableIds
  }

  /**
   * Returns canonical current evidence for the requested phase.
   *
   * @param request - Exact close or post-close collection request.
   * @returns Canonical evidence and measured identity.
   */
  async collect(
    request: WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest,
  ): Promise<WorkspaceSearchMigrationCollectedMaintenanceEvidence> {
    this.requests.push(request)
    if (request.phase === 'post-close') {
      await this.postCloseBarrier
    }
    const drainStartedAt =
      request.phase === 'post-close' && this.invalidPostCloseStart
        ? new Date(Date.parse(request.closedAt) - 1).toISOString()
        : request.phase === 'post-close'
          ? request.closedAt
          : closedAt
    const runtimeRevision = this.nextRuntimeRevision
    this.nextRuntimeRevision += 1
    return {
      configurationHash: request.configurationHash,
      tableIds: { ...this.tableIds },
      evidenceBytes: createMaintenanceEvidenceBytes(
        drainStartedAt,
        runtimeRevision,
      ),
    }
  }
}

/**
 * Focused fake managed session over restart-safe durable checkpoint state.
 */
class RecordingPostClosePlanningSession
implements WorkspaceSearchMigrationPostClosePlanningSession {
  /** Number of acquire operations started by this session. */
  acquireCount = 0

  /** Number of heartbeat operations started by this session. */
  heartbeatCount = 0

  /** Exact configuration measured by the fake session. */
  private readonly configuration: WorkspaceSearchMigrationConfiguration

  /** Reviewed digest of the exact configuration. */
  private readonly configurationHash: string

  /** Shared durable state surviving new session instances. */
  private readonly state: DurableSupervisorState

  /** Shared immutable object store surviving new session instances. */
  private readonly immutableArtifacts: InMemoryImmutableArtifactPort

  /** High-level operation trace used by focused ordering assertions. */
  private readonly events: string[]

  /** Optional failure and operation barriers. */
  private readonly behavior: RecordingSessionBehavior

  /** Whether this session already lost one durable source-page response. */
  private sourceCommitResponseLost = false

  /** Whether this session already lost one durable root response. */
  private rootPublishResponseLost = false

  /**
   * Creates one new managed-session view over durable fixture state.
   *
   * @param input - Measured identity, durable state, trace, and behavior.
   */
  constructor(input: {
    /** Exact measured configuration. */
    readonly configuration: WorkspaceSearchMigrationConfiguration
    /** Shared durable state. */
    readonly state: DurableSupervisorState
    /** Shared immutable object store. */
    readonly immutableArtifacts: InMemoryImmutableArtifactPort
    /** Shared high-level event trace. */
    readonly events: string[]
    /** Optional behavior injection. */
    readonly behavior?: RecordingSessionBehavior
  }) {
    this.configuration = input.configuration
    this.configurationHash =
      createWorkspaceSearchConfigurationHash(input.configuration)
    this.state = input.state
    this.immutableArtifacts = input.immutableArtifacts
    this.events = input.events
    this.behavior = input.behavior ?? {}
  }

  /**
   * Returns the exact measured configuration.
   *
   * @returns Detached measured configuration.
   */
  async measureConfiguration():
    Promise<WorkspaceSearchMigrationConfiguration> {
    this.events.push('session:measure')
    return structuredClone(this.configuration)
  }

  /**
   * Validates one deadline with the measured immutable-port clock and timeout.
   *
   * @param input - Exact deadline and additional pre-write runway.
   * @returns Exact accepted canonical retention deadline.
   */
  validatePlanningArtifactPreflight(
    input:
      ValidateWorkspaceSearchMigrationPlanningArtifactPreflightInput,
  ): string {
    this.events.push('artifacts:retention:validate')
    const currentTime =
      this.behavior.artifactPreflightClock?.() ?? now
    if (
      !hasWorkspaceSearchMigrationImmutableArtifactRetentionHeadroom(
        input.retainUntil,
        this.configuration,
        WORKSPACE_SEARCH_MIGRATION_MANAGED_ARTIFACT_REQUEST_TIMEOUT_MILLISECONDS,
        currentTime,
        input.minimumAdditionalHeadroomMilliseconds,
      )
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_ARGUMENT',
        'Fixture planning retention is unsafe.',
      )
    }
    if (
      Date.parse(input.reviewedDryRunCompletedAt) >
        currentTime.getTime()
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'DRY_RUN_INVALID_ROWS',
        'Fixture reviewed dry-run completes in the future.',
      )
    }
    return input.retainUntil
  }

  /**
   * Acquires or recovers the one durable fixture lease.
   *
   * @param input - Requested run and owner.
   * @returns Exact fixed-duration active lease.
   */
  async acquireLease(
    input: AcquireWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    this.acquireCount += 1
    this.events.push('lease:acquire')
    const lease = createLease(input.runId, input.ownerId)
    this.state.lease = lease
    return { ...lease }
  }

  /**
   * Extends the exact lease or injects one periodic lease loss.
   *
   * @param input - Exact stable lease claim.
   * @returns Current fixed-duration durable lease.
   */
  async heartbeatLease(
    input: HeartbeatWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    this.heartbeatCount += 1
    this.events.push(`lease:heartbeat:${this.heartbeatCount}`)
    if (
      this.behavior.failPeriodicHeartbeat === true &&
      this.heartbeatCount > 1
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'LEASE_LOST',
        'Injected periodic heartbeat loss.',
      )
    }
    const lease = createLease(
      input.lease.runId,
      input.lease.ownerId,
      input.lease.fenceToken,
    )
    this.state.lease = lease
    return { ...lease }
  }

  /**
   * Advances the durable maintenance pointer with exact evidence.
   *
   * @param input - Lease claim, predecessor, and evidence bytes.
   * @returns Fresh current pre-plan authority.
   */
  async renewMaintenanceEvidence(
    input: RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    const durablePointer =
      createDurableMaintenancePointerClaim(this.state)
    if (
      durablePointer?.fenceToken === input.lease.fenceToken
        ? !sameMaintenancePointerClaim(
            durablePointer,
            input.expectedPointer,
          )
        : input.expectedPointer !== null
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_MAINTENANCE_EVIDENCE',
        'Fixture maintenance pointer CAS failed.',
      )
    }
    this.state.pointerRevision += 1
    this.events.push(`authority:renew:${this.state.pointerRevision}`)
    const parsed = parseMaintenanceEvidence(input.evidenceBytes, { now })
    const oldestObservationAt = parsed.evidence.drainCompletedAt
    const receipt: WorkspaceSearchMaintenanceEvidenceReceipt = {
      runId: input.lease.runId,
      evidenceDigest: parsed.fileSha256,
      evidenceLocator: parsed.evidence.locator,
      runtimeRevision: parsed.evidence.runtimeRevision,
      fenceToken: input.lease.fenceToken,
      validatedAt: now.toISOString(),
      oldestObservationAt,
      validUntil: new Date(
        Date.parse(oldestObservationAt) + 5 * 60_000 + 1,
      ).toISOString(),
    }
    const receiptDigest = createMigrationDigest(receipt)
    const lease = requireLease(this.state)
    const authority: WorkspaceSearchMigrationPrePlanAuthority = {
      configurationHash: this.configurationHash,
      stateTableId:
        this.configuration.tables['migration-state'].tableId,
      lease: { ...lease },
      maintenanceEvidenceReceiptDigest: receiptDigest,
      maintenanceEvidencePointerRevision: this.state.pointerRevision,
      maintenanceEvidenceReceipt: receipt,
      evaluatedAt: now.toISOString(),
    }
    this.state.currentAuthority = authority
    this.state.historicalBindings.set(receiptDigest, {
      configurationHash: this.configurationHash,
      stateTableId:
        this.configuration.tables['migration-state'].tableId,
      ownerId: lease.ownerId,
      receiptDigest,
      receipt,
    })
    return structuredClone(authority)
  }

  /**
   * Reads the current same-fence maintenance pointer predecessor.
   *
   * @param lease - Exact active lease claim.
   * @returns Same-fence pointer claim, or null after first acquire/takeover.
   */
  async readMaintenanceEvidencePointer(
    lease: WorkspaceSearchMigrationLeaseClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null> {
    this.events.push('authority:pointer:read')
    const pointer = createDurableMaintenancePointerClaim(this.state)
    if (
      pointer === null ||
      pointer.fenceToken !== lease.fenceToken
    ) {
      return null
    }
    const current = requireCurrentAuthority(this.state)
    if (
      current.lease.runId !== lease.runId ||
      current.lease.ownerId !== lease.ownerId
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'LEASE_LOST',
        'Fixture maintenance pointer lease changed.',
      )
    }
    return { ...pointer }
  }

  /**
   * Strongly resolves the exact current authority.
   *
   * @param claim - Exact lease and pointer claim.
   * @returns Detached current authority.
   */
  async readAuthority(
    claim: WorkspaceSearchMigrationPrePlanAuthorityClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    this.events.push('authority:read')
    const authority = requireCurrentAuthority(this.state)
    if (
      claim.maintenanceEvidencePointerRevision !==
        authority.maintenanceEvidencePointerRevision ||
      claim.maintenanceEvidenceReceiptDigest !==
        authority.maintenanceEvidenceReceiptDigest
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'Fixture authority claim changed.',
      )
    }
    return {
      ...structuredClone(authority),
      evaluatedAt: now.toISOString(),
    }
  }

  /**
   * Creates the focused durable execution-boundary port.
   *
   * @returns Boundary port over shared state.
   */
  createExecutionBoundaryPort():
    WorkspaceSearchMigrationExecutionBoundaryAwsPort {
    return {
      read: async (requestedRunId) => {
        this.events.push('boundary:read')
        if (
          this.state.boundary !== undefined &&
          this.state.boundary.runId !== requestedRunId
        ) {
          return undefined
        }
        return this.state.boundary === undefined
          ? undefined
          : structuredClone(this.state.boundary)
      },
      close: async (currentAuthority) => {
        this.events.push('boundary:close')
        this.state.headsAtClose = [
          ...this.state.sources.keys(),
          ...(this.state.target === undefined
            ? []
            : ['workspace-search']),
          ...(this.state.root === undefined ? [] : ['sealed-root']),
        ]
        const tableIds = createTableIds(this.configuration)
        const stateTable = this.configuration.tables['migration-state']
        const binding = createWorkspaceSearchWriterFenceBinding({
          stateTableName: stateTable.tableName,
          stateTableId: stateTable.tableId,
          stateIncarnationDigest:
            createWorkspaceSearchWriterFenceStateIncarnationDigest(
              {
                role: 'migration-state',
                tableName: stateTable.tableName,
                tableArn: stateTable.tableArn,
                tableId: stateTable.tableId,
                creationTime: stateTable.creationTime,
                account: stateTable.account,
                region: stateTable.region,
              },
            ),
          tableIds,
        })
        const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
          binding,
          new Date('2026-07-30T00:00:00.000Z'),
        )
        const closed = createWorkspaceSearchWriterFenceClosedSuccessor(
          open,
          {
            configurationHash: this.configurationHash,
            runId: currentAuthority.lease.runId,
            ownerId: currentAuthority.lease.ownerId,
            leaseFenceToken: currentAuthority.lease.fenceToken,
            maintenanceEvidenceReceiptDigest:
              currentAuthority.maintenanceEvidenceReceiptDigest,
            maintenanceEvidencePointerRevision:
              currentAuthority.maintenanceEvidencePointerRevision,
          },
          new Date(closedAt),
        )
        const boundary =
          createWorkspaceSearchMigrationExecutionBoundary({
            runId: currentAuthority.lease.runId,
            configurationHash: this.configurationHash,
            tableIds,
            closedWriterFenceRecord: closed,
          })
        this.state.closedBoundary = boundary
        this.state.boundary = boundary
        return structuredClone(boundary)
      },
      admitPlanning: async (
        input: AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput,
      ) => {
        this.events.push('boundary:admit')
        const current = requireClosedBoundary(this.state)
        const admitted =
          admitWorkspaceSearchMigrationExecutionBoundaryPlanning({
            current,
            currentAuthority: input.currentAuthority,
            admittedAt: now.toISOString(),
            maintenanceEvidenceBytes: input.maintenanceEvidenceBytes,
          })
        this.state.boundary = admitted
        return structuredClone(admitted)
      },
    }
  }

  /**
   * Reads one durable source head or returns the canonical initial head.
   *
   * @param input - Exact planning source request.
   * @returns Current durable progress.
   */
  async readSourceEvidenceProgress(
    input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress> {
    this.events.push(`source:read:${input.source}`)
    const stored = this.state.sources.get(input.source)
    return stored === undefined
      ? createInitialSourceProgress(input, this.configuration)
      : structuredClone(stored.progress)
  }

  /**
   * Commits one empty terminal source page under current authority.
   *
   * @param input - Exact planning source commit request.
   * @returns New durable terminal progress.
   */
  async commitNextSourceEvidencePage(
    input: WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest,
  ): Promise<WorkspaceSearchMigrationSourceEvidenceProgress> {
    this.events.push(`source:commit:${input.source}`)
    await this.behavior.beforeSourceCommit?.(input.source)
    if (input.purpose !== 'planning') {
      throw new Error('Supervisor fixture requires planning authority.')
    }
    const stored = createTerminalSourcePlanningPage(
      input,
      this.configuration,
    )
    this.state.sources.set(input.source, stored)
    if (
      this.behavior.loseSourceCommitResponse === input.source &&
      !this.sourceCommitResponseLost
    ) {
      this.sourceCommitResponseLost = true
      throw new WorkspaceSearchMigrationFailure(
        'TRANSIENT_INFRASTRUCTURE_FAILURE',
        'Injected durable source-page response loss.',
      )
    }
    return structuredClone(stored.progress)
  }

  /**
   * Reads the durable target head or returns the canonical initial head.
   *
   * @param input - Exact planning target request.
   * @returns Current durable target progress.
   */
  async readTargetEvidenceProgress(
    input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceProgress> {
    this.events.push('target:read')
    return this.state.target === undefined
      ? createInitialTargetProgress(input, this.configuration)
      : structuredClone(this.state.target.progress)
  }

  /**
   * Commits one empty terminal target page under current authority.
   *
   * @param input - Exact target commit request.
   * @returns New durable terminal target progress.
   */
  async commitNextTargetEvidencePage(
    input: WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest,
  ): Promise<WorkspaceSearchMigrationTargetEvidenceProgress> {
    this.events.push('target:commit')
    const stored = createTerminalTargetPlanningPage(
      input,
      this.configuration,
    )
    this.state.target = stored
    return structuredClone(stored.progress)
  }

  /**
   * Joins all durable page material and returns an opaque provenance writer.
   *
   * @param input - Exact bounded planning join request.
   * @returns Revalidated join result and private provenance writer.
   */
  async prepareCommittedPlanningEvidence(
    input: Parameters<
      WorkspaceSearchMigrationPostClosePlanningSession[
        'prepareCommittedPlanningEvidence'
      ]
    >[0],
  ): Promise<WorkspaceSearchMigrationPreparedCommittedPlanningEvidence> {
    this.events.push('planning:prepare')
    if (this.behavior.failPlanningPreparation === true) {
      throw new WorkspaceSearchMigrationFailure(
        'DRY_RUN_INVALID_ROWS',
        'Injected stale reviewed dry-run failure.',
      )
    }
    const sourcePages = {
      'project-directory': [
        createSourcePlanningMaterial(
          requireStoredSource(this.state, 'project-directory'),
        ),
      ],
      'work-items': [
        createSourcePlanningMaterial(
          requireStoredSource(this.state, 'work-items'),
        ),
      ],
      collaboration: [
        createSourcePlanningMaterial(
          requireStoredSource(this.state, 'collaboration'),
        ),
      ],
      documents: [
        createSourcePlanningMaterial(
          requireStoredSource(this.state, 'documents'),
        ),
      ],
    }
    const target = requireStoredTarget(this.state)
    const result = joinWorkspaceSearchMigrationPlanningEvidence({
      ...input,
      sourcePages,
      targetPages: [{ page: target.page, items: [] }],
    })
    const sourceEvidencePageBytes = {
      'project-directory': [
        requireStoredSource(this.state, 'project-directory').bytes,
      ],
      'work-items': [
        requireStoredSource(this.state, 'work-items').bytes,
      ],
      collaboration: [
        requireStoredSource(this.state, 'collaboration').bytes,
      ],
      documents: [
        requireStoredSource(this.state, 'documents').bytes,
      ],
    }
    const historicalReceiptBindings =
      createHistoricalBindings(this.state, result)
    const gateway = this.createDelegatePlanningGateway(input.runId)
    return {
      result,
      writePlanningProvenanceArtifact: async ({ retainUntil }) => {
        this.events.push('artifacts:provenance')
        return gateway.writePlanningProvenanceArtifact({
          sourceEvidencePageBytes,
          targetEvidencePageBytes: [target.bytes],
          historicalReceiptBindings,
          retainUntil,
        })
      },
    }
  }

  /**
   * Creates one recording wrapper around the real pure graph gateway.
   *
   * @param requestedRunId - Run-scoped immutable graph namespace.
   * @returns Recording plan gateway.
   */
  createPlanningArtifactGateway(
    requestedRunId: string,
  ): WorkspaceSearchMigrationPlanningArtifactAwsGateway {
    const delegate = this.createDelegatePlanningGateway(requestedRunId)
    return {
      writePlanArtifact: async (input) => {
        this.events.push('artifacts:plan')
        return delegate.writePlanArtifact(input)
      },
      replayPlanArtifact: async (input) => {
        this.events.push('artifacts:replay-plan')
        return delegate.replayPlanArtifact(input)
      },
      writePlanningProvenanceArtifact: async (input) =>
        delegate.writePlanningProvenanceArtifact(input),
      replayPlanningProvenanceArtifact: async (input) => {
        this.events.push('artifacts:replay-provenance')
        return delegate.replayPlanningProvenanceArtifact(input)
      },
    }
  }

  /**
   * Creates the focused immutable sealed-root port.
   *
   * @returns Root port over shared durable state.
   */
  createSealedPlanningAuthorityPort():
    WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort {
    return {
      read: async (requestedRunId) => {
        this.events.push('root:read')
        if (
          this.state.root !== undefined &&
          this.state.root.runId !== requestedRunId
        ) {
          return this.state.root
        }
        return this.state.root === undefined
          ? undefined
          : structuredClone(this.state.root)
      },
      publish: async (
        input: PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
      ) => {
        this.events.push('root:publish')
        const root =
          createWorkspaceSearchMigrationSealedPlanningAuthorityV2({
            ...input,
            sealedAt:
              (this.behavior.sealedRootClock?.() ?? now).toISOString(),
          })
        this.state.root = root
        if (
          this.behavior.loseRootPublishResponse === true &&
          !this.rootPublishResponseLost
        ) {
          this.rootPublishResponseLost = true
          throw new WorkspaceSearchMigrationFailure(
            'TRANSIENT_INFRASTRUCTURE_FAILURE',
            'Injected durable sealed-root response loss.',
          )
        }
        return structuredClone(root)
      },
    }
  }

  /**
   * Creates a graph gateway over the shared immutable object store.
   *
   * @param requestedRunId - Run-scoped immutable namespace.
   * @returns Real graph codec over a deterministic in-memory object port.
   */
  private createDelegatePlanningGateway(
    requestedRunId: string,
  ): WorkspaceSearchMigrationPlanningArtifactAwsGateway {
    return createAwsWorkspaceSearchMigrationPlanningArtifactGateway({
      runId: requestedRunId,
      configurationHash: this.configurationHash,
      immutableArtifactPort: this.immutableArtifacts,
    })
  }
}

/**
 * Complete focused fixture for one or more restart sessions.
 */
type SupervisorFixture = {
  /** Exact measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed measured configuration digest. */
  readonly configurationHash: string
  /** Exact dry-run bytes matching the empty joined scan. */
  readonly reviewedDryRunEvidenceBytes: Uint8Array
  /** Shared restart-safe durable state. */
  readonly state: DurableSupervisorState
  /** Shared high-level event trace. */
  readonly events: string[]
  /** Trusted evidence provider. */
  readonly provider: RecordingMaintenanceEvidenceProvider
  /**
   * Creates a new measured session over the shared state.
   *
   * @param behavior - Optional failure or barrier injection.
   * @returns Fresh session view.
   */
  readonly createSession: (
    behavior?: RecordingSessionBehavior,
  ) => RecordingPostClosePlanningSession
}

describe('Workspace Search post-close planning supervisor', () => {
  test('orders absent close, revision two, five chains, artifacts, and root', async () => {
    const fixture = createSupervisorFixture()
    const session = fixture.createSession()

    const result =
      await superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(fixture, session),
      )

    expect(fixture.state.headsAtClose).toEqual([])
    expectOrderedEvents(fixture.events, [
      'boundary:close',
      'boundary:admit',
      'source:read:project-directory',
      'source:read:work-items',
      'source:read:collaboration',
      'source:read:documents',
      'target:read',
      'source:commit:project-directory',
      'source:commit:work-items',
      'source:commit:collaboration',
      'source:commit:documents',
      'target:commit',
      'planning:prepare',
      'artifacts:provenance',
      'artifacts:plan',
      'root:publish',
    ])
    expect(
      fixture.events.filter((event) => event === 'boundary:close'),
    ).toHaveLength(1)
    expect(
      fixture.events.filter((event) => event === 'boundary:admit'),
    ).toHaveLength(1)
    expect(fixture.provider.requests.map(({ phase }) => phase))
      .toEqual(['close', 'post-close', 'post-close'])
    for (const request of fixture.provider.requests) {
      expect('configuration' in request).toBe(false)
      expect(request.configurationHash).toBe(fixture.configurationHash)
      expect(request.tableIds)
        .toEqual(createTableIds(fixture.configuration))
    }
    const postCloseRequest = fixture.provider.requests[1]
    if (postCloseRequest?.phase !== 'post-close') {
      throw new Error('Expected one post-close evidence request.')
    }
    expect(postCloseRequest.closedAt).toBe(closedAt)
    expect(result.executionBoundary).toMatchObject({
      phase: 'planning-admitted',
      revision: 2,
      closedAt,
      planningAdmission: {
        drainStartedAt: closedAt,
        drainCompletedAt,
      },
    })
    expect(result.sealedPlanningAuthority.evidenceHeads.map(
      ({ chain }) => chain,
    )).toEqual([
      ...workspaceSearchMigrationSourceNames,
      'workspace-search',
    ])
    expect(result.sealedPlanningAuthority.tableIds)
      .toEqual(createTableIds(fixture.configuration))
    expect(result.planSeal.planOperationCount).toBe(0)
    expect(result.planSeal.createdAt)
      .toBe(result.executionBoundary.planningAdmission.admittedAt)
  })

  test('snapshots top-level collaborators before the first asynchronous read', async () => {
    const fixture = createSupervisorFixture()
    const session = fixture.createSession()
    const base = createSupervisorInput(fixture, session)
    let sessionReads = 0
    let providerReads = 0
    let schedulerReads = 0
    let clockReads = 0

    const result =
      await superviseWorkspaceSearchMigrationPostClosePlanning({
        ...base,
        get session() {
          sessionReads += 1
          return session
        },
        get maintenanceEvidenceProvider() {
          providerReads += 1
          return fixture.provider
        },
        get heartbeatScheduler() {
          schedulerReads += 1
          return base.heartbeatScheduler
        },
        get clock() {
          clockReads += 1
          return base.clock
        },
      })

    expect(result.executionBoundary.phase).toBe('planning-admitted')
    expect(sessionReads).toBe(1)
    expect(providerReads).toBe(1)
    expect(schedulerReads).toBe(1)
    expect(clockReads).toBe(1)
  })

  test('rejects unsafe retention windows before lease acquisition or writer close', async () => {
    const invalidRetentions = [
      new Date(
        now.getTime() +
          30 * retentionDayMilliseconds +
          15 * 60_000 +
          9_999,
      ).toISOString(),
      new Date(
        now.getTime() +
          31 * retentionDayMilliseconds +
          1,
      ).toISOString(),
    ]

    for (const invalidRetention of invalidRetentions) {
      const fixture = createSupervisorFixture()
      const session = fixture.createSession()
      const failure = await captureFailure(
        superviseWorkspaceSearchMigrationPostClosePlanning({
          ...createSupervisorInput(fixture, session),
          retainUntil: invalidRetention,
        }),
      )

      expect(readFailureCode(failure)).toBe('INVALID_ARGUMENT')
      expect(session.acquireCount).toBe(0)
      expect(fixture.state.boundary).toBeUndefined()
      expect(fixture.provider.requests).toEqual([])
      expect(fixture.events).not.toContain('boundary:close')
    }
  })

  test('revalidates retention after close-authority renewal before writer close', async () => {
    const fixture = createSupervisorFixture()
    let artifactPreflightClockReads = 0
    const session = fixture.createSession({
      artifactPreflightClock: () => {
        const elapsedMilliseconds =
          artifactPreflightClockReads
        artifactPreflightClockReads += 1
        return new Date(now.getTime() + elapsedMilliseconds)
      },
    })
    const minimumSafeRetention = new Date(
      now.getTime() +
        30 * retentionDayMilliseconds +
        15 * 60_000 +
        WORKSPACE_SEARCH_MIGRATION_MANAGED_ARTIFACT_REQUEST_TIMEOUT_MILLISECONDS,
    ).toISOString()

    const failure = await captureFailure(
      superviseWorkspaceSearchMigrationPostClosePlanning({
        ...createSupervisorInput(fixture, session),
        retainUntil: minimumSafeRetention,
      }),
    )

    expect(readFailureCode(failure)).toBe('INVALID_ARGUMENT')
    expect(artifactPreflightClockReads).toBe(2)
    expect(
      fixture.events.filter(
        (event) => event === 'artifacts:retention:validate',
      ),
    ).toHaveLength(2)
    expect(
      fixture.events.filter((event) =>
        event.startsWith('authority:renew:')),
    ).toEqual(['authority:renew:1'])
    expect(fixture.provider.requests.map(({ phase }) => phase))
      .toEqual(['close'])
    expect(fixture.state.boundary).toBeUndefined()
    expect(fixture.events).not.toContain('boundary:close')
  })

  test('rejects a dry run newer than the measured publication clock before lease acquisition', async () => {
    const fixture = createSupervisorFixture()
    const session = fixture.createSession()
    const futureDryRunEvidenceBytes =
      createReviewedDryRunEvidenceBytes(
        fixture.configurationHash,
        new Date(now.getTime() + 1).toISOString(),
      )

    const failure = await captureFailure(
      superviseWorkspaceSearchMigrationPostClosePlanning({
        ...createSupervisorInput(fixture, session),
        reviewedDryRunEvidenceBytes: futureDryRunEvidenceBytes,
        clock: () => new Date(now.getTime() + 2),
      }),
    )

    expect(readFailureCode(failure)).toBe('DRY_RUN_INVALID_ROWS')
    expect(session.acquireCount).toBe(0)
    expect(fixture.events).toContain('session:measure')
    expect(fixture.events).toContain('artifacts:retention:validate')
    expect(fixture.events).not.toContain('boundary:close')
    expect(fixture.events).not.toContain('planning:prepare')
  })

  test('uses a later replacement dry-run completion as the restart-stable plan epoch', async () => {
    const fixture = createSupervisorFixture()
    const firstFailure = await captureFailure(
      superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(
          fixture,
          fixture.createSession({
            failPlanningPreparation: true,
          }),
        ),
      ),
    )
    expect(readFailureCode(firstFailure))
      .toBe('DRY_RUN_INVALID_ROWS')
    const admittedBoundary = requireAdmittedBoundary(fixture.state)
    expect(fixture.state.root).toBeUndefined()
    fixture.events.length = 0
    fixture.provider.requests.length = 0
    const replacementCompletedAt =
      new Date(now.getTime() + 1_000).toISOString()
    const replacementDryRunEvidenceBytes =
      createReviewedDryRunEvidenceBytes(
        fixture.configurationHash,
        replacementCompletedAt,
      )

    const resumed =
      await superviseWorkspaceSearchMigrationPostClosePlanning({
        ...createSupervisorInput(
          fixture,
          fixture.createSession({
            artifactPreflightClock: () =>
              new Date(now.getTime() + 2_000),
            sealedRootClock: () =>
              new Date(now.getTime() + 2_000),
          }),
        ),
        reviewedDryRunEvidenceBytes:
          replacementDryRunEvidenceBytes,
        clock: () => new Date(now.getTime() + 2_000),
      })

    expect(admittedBoundary.planningAdmission.admittedAt)
      .toBe(now.toISOString())
    expect(Date.parse(replacementCompletedAt)).toBeGreaterThan(
      Date.parse(admittedBoundary.planningAdmission.admittedAt),
    )
    expect(resumed.planSeal.createdAt).toBe(replacementCompletedAt)
    expect(resumed.executionBoundary.boundaryDigest)
      .toBe(admittedBoundary.boundaryDigest)
    expect(fixture.events).not.toContain('boundary:close')
    expect(fixture.events).not.toContain('boundary:admit')
  })

  test('recovers a same-fence revision-one pointer before renewing admission evidence', async () => {
    const fixture = createSupervisorFixture()
    fixture.provider.invalidPostCloseStart = true
    const firstFailure = await captureFailure(
      superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(fixture, fixture.createSession()),
      ),
    )
    expect(readFailureCode(firstFailure))
      .toBe('INVALID_MAINTENANCE_EVIDENCE')
    expect(fixture.state.boundary?.phase).toBe('closed')
    expect(fixture.state.pointerRevision).toBe(1)

    fixture.provider.invalidPostCloseStart = false
    fixture.provider.requests.length = 0
    fixture.events.length = 0
    const resumed =
      await superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(fixture, fixture.createSession()),
      )

    expect(resumed.executionBoundary.phase).toBe('planning-admitted')
    expect(fixture.events).not.toContain('boundary:close')
    expectOrderedEvents(fixture.events, [
      'authority:pointer:read',
      'authority:renew:2',
      'boundary:admit',
      'source:read:project-directory',
    ])
    expect(fixture.provider.requests.map(({ phase }) => phase))
      .toEqual(['post-close', 'post-close'])
  })

  test('resumes durable revision two heads and recovers an existing root read-only', async () => {
    const fixture = createSupervisorFixture()
    await superviseWorkspaceSearchMigrationPostClosePlanning(
      createSupervisorInput(fixture, fixture.createSession()),
    )
    fixture.state.root = undefined
    fixture.state.sources.delete('collaboration')
    fixture.state.sources.delete('documents')
    fixture.state.target = undefined
    fixture.events.length = 0
    fixture.provider.requests.length = 0

    const resumed =
      await superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(fixture, fixture.createSession()),
      )

    expect(resumed.executionBoundary.phase).toBe('planning-admitted')
    expect(fixture.events).not.toContain('boundary:close')
    expect(fixture.events).not.toContain('boundary:admit')
    expect(fixture.events).not.toContain(
      'source:commit:project-directory',
    )
    expect(fixture.events).not.toContain('source:commit:work-items')
    expect(fixture.events).toContain('authority:pointer:read')
    expectOrderedEvents(fixture.events, [
      'source:read:project-directory',
      'source:read:work-items',
      'source:read:collaboration',
      'source:read:documents',
      'target:read',
      'source:commit:collaboration',
      'source:commit:documents',
      'target:commit',
      'root:publish',
    ])
    expect(fixture.provider.requests.map(({ phase }) => phase))
      .toEqual(['post-close', 'post-close'])

    fixture.events.length = 0
    fixture.provider.requests.length = 0
    const recoverySession = fixture.createSession({
      artifactPreflightClock: () => {
        throw new Error('read-only recovery must not read the clock')
      },
    })
    const recovered =
      await superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(fixture, recoverySession),
      )

    expect(recovered.sealedPlanningAuthority.authorityDigest)
      .toBe(resumed.sealedPlanningAuthority.authorityDigest)
    expect(fixture.events).toEqual([
      'session:measure',
      'boundary:read',
      'root:read',
      'artifacts:replay-plan',
      'artifacts:replay-provenance',
    ])
    expect(recoverySession.acquireCount).toBe(0)
    expect(recoverySession.heartbeatCount).toBe(0)
    expect(fixture.provider.requests).toEqual([])
  })

  test('resumes a durably committed source page after its response is lost without duplicate promotion', async () => {
    const fixture = createSupervisorFixture()
    const firstFailure = await captureFailure(
      superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(
          fixture,
          fixture.createSession({
            loseSourceCommitResponse: 'project-directory',
          }),
        ),
      ),
    )
    expect(readFailureCode(firstFailure))
      .toBe('TRANSIENT_INFRASTRUCTURE_FAILURE')
    expect(fixture.state.sources.has('project-directory')).toBe(true)
    expect(
      fixture.events.filter(
        (event) => event === 'source:commit:project-directory',
      ),
    ).toHaveLength(1)

    const resumed =
      await superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(fixture, fixture.createSession()),
      )

    expect(resumed.sealedPlanningAuthority.authorityVersion).toBe(2)
    expect(
      fixture.events.filter(
        (event) => event === 'source:commit:project-directory',
      ),
    ).toHaveLength(1)
    expect(
      fixture.events.filter((event) => event === 'boundary:close'),
    ).toHaveLength(1)
    expect(
      fixture.events.filter((event) => event === 'boundary:admit'),
    ).toHaveLength(1)
    expect(fixture.events).toContain('authority:pointer:read')
  })

  test('recovers a durably published root after its response is lost without publishing again', async () => {
    const fixture = createSupervisorFixture()
    const firstFailure = await captureFailure(
      superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(
          fixture,
          fixture.createSession({
            loseRootPublishResponse: true,
          }),
        ),
      ),
    )
    expect(readFailureCode(firstFailure))
      .toBe('TRANSIENT_INFRASTRUCTURE_FAILURE')
    const durableRoot = requireFixtureRoot(fixture.state)
    expect(
      fixture.events.filter((event) => event === 'root:publish'),
    ).toHaveLength(1)

    const recoverySession = fixture.createSession()
    const recovered =
      await superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(fixture, recoverySession),
      )

    expect(recovered.sealedPlanningAuthority.authorityDigest)
      .toBe(durableRoot.authorityDigest)
    expect(
      fixture.events.filter((event) => event === 'root:publish'),
    ).toHaveLength(1)
    expect(fixture.events).toContain('artifacts:replay-plan')
    expect(fixture.events).toContain('artifacts:replay-provenance')
    expect(recoverySession.acquireCount).toBe(0)
    expect(recoverySession.heartbeatCount).toBe(0)
  })

  test('does not begin another operation after an operator signal aborts an in-flight commit', async () => {
    const fixture = createSupervisorFixture()
    const barrier = createDeferred<void>()
    const abortController = new AbortController()
    const session = fixture.createSession({
      beforeSourceCommit: async (source) => {
        if (source === 'project-directory') await barrier.promise
      },
    })
    const supervision = superviseWorkspaceSearchMigrationPostClosePlanning({
      ...createSupervisorInput(fixture, session),
      signal: abortController.signal,
    })
    await waitForEvent(
      fixture.events,
      'source:commit:project-directory',
    )

    abortController.abort()
    barrier.resolve()
    const failure = await captureFailure(supervision)

    expect(readFailureCode(failure)).toBe('INTERRUPTED')
    expect(fixture.events).not.toContain('source:commit:work-items')
    expect(fixture.events).not.toContain('planning:prepare')
    expect(fixture.events).not.toContain('root:publish')
  })

  test('does not begin another operation after a periodic heartbeat loses the lease', async () => {
    const fixture = createSupervisorFixture()
    const barrier = createDeferred<void>()
    const scheduler = new ManualHeartbeatScheduler()
    const session = fixture.createSession({
      failPeriodicHeartbeat: true,
      beforeSourceCommit: async (source) => {
        if (source === 'project-directory') await barrier.promise
      },
    })
    const supervision = superviseWorkspaceSearchMigrationPostClosePlanning({
      ...createSupervisorInput(fixture, session),
      heartbeatScheduler: scheduler,
    })
    await waitForEvent(
      fixture.events,
      'source:commit:project-directory',
    )

    scheduler.runNext()
    await flushMicrotasks()
    barrier.resolve()
    const failure = await captureFailure(supervision)

    expect(readFailureCode(failure)).toBe('LEASE_LOST')
    expect(fixture.events).not.toContain('source:commit:work-items')
    expect(fixture.events).not.toContain('planning:prepare')
    expect(fixture.events).not.toContain('root:publish')
  })

  test('rejects pre-close roots and mismatched durable roots or boundaries before lease acquisition', async () => {
    const fixture = createSupervisorFixture()
    await superviseWorkspaceSearchMigrationPostClosePlanning(
      createSupervisorInput(fixture, fixture.createSession()),
    )
    const admitted = requireAdmittedBoundary(fixture.state)
    const closed = requireFixtureClosedBoundary(fixture.state)
    const root = requireFixtureRoot(fixture.state)

    fixture.state.boundary = closed
    fixture.events.length = 0
    let session = fixture.createSession()
    expect(readFailureCode(await captureFailure(
      superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(fixture, session),
      ),
    ))).toBe('INVALID_STATE')
    expect(session.acquireCount).toBe(0)

    fixture.state.boundary = admitted
    fixture.state.root = {
      ...root,
      runId: 'different-post-close-run',
    }
    fixture.events.length = 0
    session = fixture.createSession()
    expect(readFailureCode(await captureFailure(
      superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(fixture, session),
      ),
    ))).toBe('INVALID_STATE')
    expect(session.acquireCount).toBe(0)

    fixture.state.root = undefined
    fixture.state.boundary = {
      ...admitted,
      tableIds: {
        ...admitted.tableIds,
        documents: 'different-documents-table-id',
      },
    }
    fixture.events.length = 0
    session = fixture.createSession()
    expect(readFailureCode(await captureFailure(
      superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(fixture, session),
      ),
    ))).toBe('INVALID_STATE')
    expect(session.acquireCount).toBe(0)
  })

  test('rejects a post-close drain that starts before the durable close', async () => {
    const fixture = createSupervisorFixture()
    fixture.provider.invalidPostCloseStart = true

    const failure = await captureFailure(
      superviseWorkspaceSearchMigrationPostClosePlanning(
        createSupervisorInput(fixture, fixture.createSession()),
      ),
    )

    expect(readFailureCode(failure))
      .toBe('INVALID_MAINTENANCE_EVIDENCE')
    expect(fixture.events).toContain('boundary:close')
    expect(fixture.events).not.toContain('boundary:admit')
    expect(fixture.events).not.toContain(
      'source:read:project-directory',
    )
    expect(
      fixture.events.filter((event) =>
        event.startsWith('authority:renew:')),
    ).toEqual(['authority:renew:1'])
  })
})

/**
 * Creates a complete fixture with absent durable planning state.
 *
 * @returns Fresh focused supervisor fixture.
 */
function createSupervisorFixture(): SupervisorFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const state: DurableSupervisorState = {
    boundary: undefined,
    closedBoundary: undefined,
    root: undefined,
    sources: new Map(),
    target: undefined,
    lease: undefined,
    pointerRevision: 0,
    currentAuthority: undefined,
    historicalBindings: new Map(),
    headsAtClose: [],
  }
  const immutableArtifacts = new InMemoryImmutableArtifactPort()
  const events: string[] = []
  const provider = new RecordingMaintenanceEvidenceProvider(
    createTableIds(configuration),
  )
  return {
    configuration,
    configurationHash,
    reviewedDryRunEvidenceBytes:
      createReviewedDryRunEvidenceBytes(configurationHash),
    state,
    events,
    provider,
    createSession: (behavior) =>
      new RecordingPostClosePlanningSession({
        configuration,
        state,
        immutableArtifacts,
        events,
        behavior,
      }),
  }
}

/**
 * Creates complete supervisor input for one fixture session.
 *
 * @param fixture - Shared restart-safe fixture.
 * @param session - Fresh managed-session view.
 * @returns Complete deterministic supervisor input.
 */
function createSupervisorInput(
  fixture: SupervisorFixture,
  session: RecordingPostClosePlanningSession,
): SuperviseWorkspaceSearchMigrationPostClosePlanningInput {
  return {
    session,
    maintenanceEvidenceProvider: fixture.provider,
    runId,
    ownerId,
    expectedConfigurationHash: fixture.configurationHash,
    reviewedDryRunEvidenceBytes:
      fixture.reviewedDryRunEvidenceBytes,
    planningJoinLimits,
    retainUntil,
    heartbeatScheduler: new ManualHeartbeatScheduler(),
    clock: () => new Date(now),
  }
}

/**
 * Creates one valid fixed-duration lease at the fixture clock.
 *
 * @param requestedRunId - Lease run.
 * @param requestedOwnerId - Lease owner.
 * @param fenceToken - Durable takeover fence.
 * @returns Canonical sixty-second lease.
 */
function createLease(
  requestedRunId: string,
  requestedOwnerId: string,
  fenceToken = 1,
): WorkspaceSearchMigrationLease {
  return {
    runId: requestedRunId,
    ownerId: requestedOwnerId,
    fenceToken,
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  }
}

/**
 * Creates canonical zero-writer evidence for one drain start.
 *
 * @param drainStartedAt - Exact beginning of the observed drain.
 * @param runtimeRevision - Distinct durable runtime-control revision.
 * @returns Canonical evidence file bytes.
 */
function createMaintenanceEvidenceBytes(
  drainStartedAt: string,
  runtimeRevision: number,
): Uint8Array {
  const evidence: WorkspaceSearchMaintenanceEvidence = {
    schemaVersion: 1,
    locator: 'change:OPS-155',
    runtimeMode: 'disabled',
    runtimeRevision,
    drainStartedAt,
    drainCompletedAt,
    observedWriterMutations: 0,
    surfaces: maintenanceRuntimeControlSurfaces.map((surface) => ({
      surface,
      mode: 'disabled',
      status: 'current',
      revision: runtimeRevision,
      observedAt: drainCompletedAt,
    })),
  }
  return new TextEncoder().encode(serializeCanonicalJson(evidence))
}

/**
 * Creates reviewed empty scan evidence matching five one-page chains.
 *
 * @param configurationHash - Exact measured configuration digest.
 * @param completedAt - Canonical reviewed completion timestamp.
 * @returns Canonical passing dry-run bytes.
 */
function createReviewedDryRunEvidenceBytes(
  configurationHash: string,
  completedAt = '2026-07-31T00:30:00.000Z',
): Uint8Array {
  const scanSnapshot = createEmptyScanSnapshot(configurationHash)
  const evidence: WorkspaceSearchDryRunEvidence = {
    kind: 'workspace-search-migration-dry-run',
    evidenceVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    configurationHash,
    startedAt: '2026-07-31T00:00:00.000Z',
    completedAt,
    sources: scanSnapshot.sources,
    target: scanSnapshot.target,
    status: 'pass',
  }
  return serializeWorkspaceSearchDryRunEvidence(evidence)
}

/**
 * Creates empty aggregate evidence for all five terminal pages.
 *
 * @param configurationHash - Exact measured configuration digest.
 * @returns Empty one-page planning scan snapshot.
 */
function createEmptyScanSnapshot(
  configurationHash: string,
): WorkspaceSearchMigrationScanSnapshot {
  return {
    configurationHash,
    sources: {
      'project-directory': createEmptyAggregate(),
      'work-items': createEmptyAggregate(),
      collaboration: createEmptyAggregate(),
      documents: createEmptyAggregate(),
    },
    target: createEmptyAggregate(),
  }
}

/**
 * Creates one empty completed single-page scan aggregate.
 *
 * @returns Canonical empty aggregate.
 */
function createEmptyAggregate(): MigrationScanAggregate {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  return {
    scanned: 0,
    mapped: 0,
    ignored: 0,
    invalid: 0,
    projected: 0,
    deleted: 0,
    keyDigest: keyAccumulator.digest(),
    contentDigest: contentAccumulator.digest(),
    pageCount: 1,
  }
}

/**
 * Creates the canonical initial progress for one source request.
 *
 * @param input - Source evidence request.
 * @param configuration - Exact measured configuration.
 * @returns Initial zero-page progress.
 */
function createInitialSourceProgress(
  input: WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSourceEvidenceProgress {
  return createInitialWorkspaceSearchMigrationSourceEvidenceProgress({
    purpose: input.purpose,
    runId: input.runId,
    configurationHash: input.configurationHash,
    source: input.source,
    sourceTableId: configuration.tables[input.source].tableId,
    stateTableId: configuration.tables['migration-state'].tableId,
  })
}

/**
 * Creates one exact empty terminal source page and durable head.
 *
 * @param input - Authority-bound source commit request.
 * @param configuration - Exact measured configuration.
 * @returns Canonical page bytes and terminal progress.
 */
function createTerminalSourcePlanningPage(
  input: Extract<
    WorkspaceSearchMigrationSourceEvidenceAwsCommitRequest,
    { readonly purpose: 'planning' }
  >,
  configuration: WorkspaceSearchMigrationConfiguration,
): StoredSourcePlanningPage {
  const initial = createInitialSourceProgress(input, configuration)
  const artifactDigest = createMigrationDigest(
    `source-artifact:${input.source}`,
  )
  const page = createWorkspaceSearchMigrationSourceEvidencePage({
    identity: {
      purpose: 'planning',
      runId: input.runId,
      configurationHash: input.configurationHash,
      source: input.source,
      sourceTableId: configuration.tables[input.source].tableId,
      stateTableId:
        configuration.tables['migration-state'].tableId,
    },
    planningAuthority: createPlanningAuthorityBinding(input.authority),
    sourceArtifacts: [{
      objectKey:
        createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey(
          artifactDigest,
        ),
      versionId: `source-version-${input.source}`,
      contentDigest: artifactDigest,
    }],
    previousProgress: initial,
    pageResult: {
      checkpoint: {
        ...initial.checkpoint,
        completed: true,
        aggregate: {
          ...initial.checkpoint.aggregate,
          pageCount: 1,
        },
      },
      sourceRows: [],
      invalidRows: [],
      sourceBindings: [],
    },
  })
  if (page.purpose !== 'planning' || page.evidenceVersion !== 3) {
    throw new Error('Expected one planning-v3 source page.')
  }
  return {
    page,
    bytes:
      serializeWorkspaceSearchMigrationSourceEvidencePage(page),
    progress:
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        initial,
        page,
      ),
  }
}

/**
 * Creates the canonical initial target progress for one request.
 *
 * @param input - Target evidence request.
 * @param configuration - Exact measured configuration.
 * @returns Initial target progress.
 */
function createInitialTargetProgress(
  input: WorkspaceSearchMigrationTargetEvidenceAwsRequest,
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationTargetEvidenceProgress {
  return createInitialWorkspaceSearchMigrationTargetEvidenceProgress({
    purpose: 'planning',
    runId: input.runId,
    configurationHash: input.configurationHash,
    targetTableId:
      configuration.tables['workspace-search'].tableId,
    stateTableId: configuration.tables['migration-state'].tableId,
  })
}

/**
 * Creates one exact empty terminal target page and durable head.
 *
 * @param input - Authority-bound target commit request.
 * @param configuration - Exact measured configuration.
 * @returns Canonical page bytes and terminal progress.
 */
function createTerminalTargetPlanningPage(
  input: WorkspaceSearchMigrationTargetEvidenceAwsCommitRequest,
  configuration: WorkspaceSearchMigrationConfiguration,
): StoredTargetPlanningPage {
  const initial = createInitialTargetProgress(input, configuration)
  const artifactDigest = createMigrationDigest('target-artifact')
  const page = createWorkspaceSearchMigrationTargetEvidencePage({
    identity: {
      purpose: 'planning',
      runId: input.runId,
      configurationHash: input.configurationHash,
      targetTableId:
        configuration.tables['workspace-search'].tableId,
      stateTableId:
        configuration.tables['migration-state'].tableId,
    },
    planningAuthority: createPlanningAuthorityBinding(input.authority),
    targetArtifacts: [{
      objectKey:
        createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
          artifactDigest,
        ),
      versionId: 'target-version',
      contentDigest: artifactDigest,
    }],
    previousProgress: initial,
    pageResult: {
      checkpoint: {
        ...initial.checkpoint,
        completed: true,
        aggregate: {
          ...initial.checkpoint.aggregate,
          pageCount: 1,
        },
      },
      targetRows: [],
      invalidRows: [],
      observedTargetBindings: [],
    },
  })
  return {
    page,
    bytes:
      serializeWorkspaceSearchMigrationTargetEvidencePage(page),
    progress:
      advanceWorkspaceSearchMigrationTargetEvidenceProgress(
        initial,
        page,
      ),
  }
}

/**
 * Projects one exact authority into evidence-page authority fields.
 *
 * @param authority - Current full pre-plan authority.
 * @returns Exact page authority binding.
 */
function createPlanningAuthorityBinding(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationPlanningAuthorityBinding {
  return {
    ownerId: authority.lease.ownerId,
    fenceToken: authority.lease.fenceToken,
    maintenanceEvidencePointerRevision:
      authority.maintenanceEvidencePointerRevision,
    maintenanceEvidenceReceiptDigest:
      authority.maintenanceEvidenceReceiptDigest,
  }
}

/**
 * Creates one source material entry without tenant rows.
 *
 * @param stored - Exact stored source page.
 * @returns Planning join material.
 */
function createSourcePlanningMaterial(
  stored: StoredSourcePlanningPage,
) {
  return { page: stored.page, items: [] }
}

/**
 * Resolves historical receipt bindings in provenance transition order.
 *
 * @param state - Durable receipt store.
 * @param result - Revalidated five-chain join result.
 * @returns Exact transition-ordered historical bindings.
 */
function createHistoricalBindings(
  state: DurableSupervisorState,
  result: WorkspaceSearchMigrationPlanningJoinResult,
): readonly WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding[] {
  return result.planningAuthorityProvenance.authorityTransitions.map(
    ({ maintenanceEvidenceReceiptDigest }) => {
      const binding = state.historicalBindings.get(
        maintenanceEvidenceReceiptDigest,
      )
      if (binding === undefined) {
        throw new Error('Historical receipt fixture was not found.')
      }
      return structuredClone(binding)
    },
  )
}

/**
 * Derives all six exact TableIds from one measured configuration.
 *
 * @param configuration - Exact measured configuration.
 * @returns Six-table durable identity.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  return {
    'project-directory':
      configuration.tables['project-directory'].tableId,
    'work-items': configuration.tables['work-items'].tableId,
    collaboration: configuration.tables.collaboration.tableId,
    documents: configuration.tables.documents.tableId,
    'workspace-search':
      configuration.tables['workspace-search'].tableId,
    'migration-state':
      configuration.tables['migration-state'].tableId,
  }
}

/**
 * Creates the complete strict measured configuration used by the fixture.
 *
 * @returns Exact six-table configuration.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search': createSupportTable('workspace-search'),
      'migration-state': createSupportTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-07-01T00:00:00.000Z',
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates one strict measured source table.
 *
 * @param source - Fixed source role.
 * @returns Complete source identity.
 */
function createSourceTable(
  source: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTableIdentity(source, sourceKeyDescriptors(source), false)
}

/**
 * Creates one strict measured target or state table.
 *
 * @param role - Supporting table role.
 * @returns Complete supporting identity.
 */
function createSupportTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  const key = role === 'workspace-search'
    ? [
        { name: 'workspaceId', role: 'HASH', type: 'S' },
        { name: 'recordKey', role: 'RANGE', type: 'S' },
      ] satisfies readonly MigrationKeyAttribute[]
    : [
        { name: 'migrationId', role: 'HASH', type: 'S' },
        { name: 'recordKey', role: 'RANGE', type: 'S' },
      ] satisfies readonly MigrationKeyAttribute[]
  return createTableIdentity(role, key, true)
}

/**
 * Creates shared strict DynamoDB table identity fields.
 *
 * @param role - Logical migration table role.
 * @param key - Exact primary-key schema.
 * @param deletionProtection - Whether deletion protection is enabled.
 * @returns Complete measured table identity.
 */
function createTableIdentity(
  role: MigrationTableIdentity['role'],
  key: readonly MigrationKeyAttribute[],
  deletionProtection: boolean,
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection,
    encryption: 'KMS',
    kmsKeyDigest: createMigrationDigest(`${role}-key`),
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-31T00:00:00.000Z',
    },
  }
}

/**
 * Returns the exact measured key schema for one source role.
 *
 * @param source - Fixed source role.
 * @returns Ordered partition and sort keys.
 */
function sourceKeyDescriptors(
  source: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (source === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'entryKey', role: 'RANGE', type: 'S' },
    ]
  }
  if (source === 'work-items') {
    return [
      { name: 'directoryTeamId', role: 'HASH', type: 'S' },
      { name: 'issueId', role: 'RANGE', type: 'S' },
    ]
  }
  if (source === 'collaboration') {
    return [
      { name: 'entityKey', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ]
}

/**
 * Requires the current durable lease.
 *
 * @param state - Shared durable state.
 * @returns Current lease.
 */
function requireLease(
  state: DurableSupervisorState,
): WorkspaceSearchMigrationLease {
  if (state.lease === undefined) {
    throw new Error('Fixture lease was not acquired.')
  }
  return state.lease
}

/**
 * Requires the current durable pre-plan authority.
 *
 * @param state - Shared durable state.
 * @returns Current authority.
 */
function requireCurrentAuthority(
  state: DurableSupervisorState,
): WorkspaceSearchMigrationPrePlanAuthority {
  if (state.currentAuthority === undefined) {
    throw new Error('Fixture authority was not renewed.')
  }
  return state.currentAuthority
}

/**
 * Projects the durable fake pointer independently from a session controller.
 *
 * @param state - Shared durable state.
 * @returns Exact current pointer claim, or null before first renewal.
 */
function createDurableMaintenancePointerClaim(
  state: DurableSupervisorState,
): WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null {
  const authority = state.currentAuthority
  if (authority === undefined) return null
  return {
    fenceToken: authority.lease.fenceToken,
    revision: authority.maintenanceEvidencePointerRevision,
    receiptDigest:
      authority.maintenanceEvidenceReceiptDigest,
  }
}

/**
 * Compares an expected pointer CAS claim with durable fixture state.
 *
 * @param durable - Exact current durable claim.
 * @param expected - Caller-selected predecessor or null.
 * @returns Whether all same-fence predecessor fields match.
 */
function sameMaintenancePointerClaim(
  durable: WorkspaceSearchMigrationPrePlanMaintenancePointerClaim,
  expected:
    WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null,
): boolean {
  return expected !== null &&
    durable.fenceToken === expected.fenceToken &&
    durable.revision === expected.revision &&
    durable.receiptDigest === expected.receiptDigest
}

/**
 * Requires the current revision-one boundary.
 *
 * @param state - Shared durable state.
 * @returns Exact closed boundary.
 */
function requireClosedBoundary(
  state: DurableSupervisorState,
): WorkspaceSearchMigrationClosedExecutionBoundary {
  if (state.boundary?.phase !== 'closed') {
    throw new Error('Fixture boundary is not closed revision one.')
  }
  return state.boundary
}

/**
 * Requires the retained revision-one boundary fixture.
 *
 * @param state - Shared durable state.
 * @returns Exact retained close boundary.
 */
function requireFixtureClosedBoundary(
  state: DurableSupervisorState,
): WorkspaceSearchMigrationClosedExecutionBoundary {
  if (state.closedBoundary === undefined) {
    throw new Error('Fixture close boundary was not retained.')
  }
  return state.closedBoundary
}

/**
 * Requires the current revision-two boundary.
 *
 * @param state - Shared durable state.
 * @returns Exact admitted boundary.
 */
function requireAdmittedBoundary(
  state: DurableSupervisorState,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  if (state.boundary?.phase !== 'planning-admitted') {
    throw new Error('Fixture boundary is not planning-admitted.')
  }
  return state.boundary
}

/**
 * Requires the current durable sealed root.
 *
 * @param state - Shared durable state.
 * @returns Exact sealed root.
 */
function requireFixtureRoot(
  state: DurableSupervisorState,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  if (state.root === undefined) {
    throw new Error('Fixture sealed root was not published.')
  }
  return state.root
}

/**
 * Requires one durable source page.
 *
 * @param state - Shared durable state.
 * @param source - Fixed source role.
 * @returns Exact stored page.
 */
function requireStoredSource(
  state: DurableSupervisorState,
  source: WorkspaceSearchMigrationSourceName,
): StoredSourcePlanningPage {
  const stored = state.sources.get(source)
  if (stored === undefined) {
    throw new Error(`Fixture source page is missing: ${source}`)
  }
  return stored
}

/**
 * Requires the durable target page.
 *
 * @param state - Shared durable state.
 * @returns Exact stored target page.
 */
function requireStoredTarget(
  state: DurableSupervisorState,
): StoredTargetPlanningPage {
  if (state.target === undefined) {
    throw new Error('Fixture target page is missing.')
  }
  return state.target
}

/**
 * Creates one externally resolved promise.
 *
 * @returns Pending promise and resolver.
 */
function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) {
        throw new Error('Deferred resolver is unavailable.')
      }
      resolvePromise(value)
    },
  }
}

/**
 * Waits until one high-level operation has started.
 *
 * @param events - Shared operation trace.
 * @param expected - Event that must appear.
 */
async function waitForEvent(
  events: readonly string[],
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.includes(expected)) return
    await flushMicrotasks()
  }
  throw new Error(`Timed out waiting for fixture event: ${expected}`)
}

/**
 * Allows queued promise continuations to complete.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Captures an expected rejected promise.
 *
 * @param promise - Promise expected to reject.
 * @returns Caught failure.
 */
async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error: unknown) {
    return error
  }
  throw new Error('Expected promise to reject.')
}

/**
 * Reads one stable code from a known migration or interruption failure.
 *
 * @param failure - Caught failure.
 * @returns Stable machine-readable code.
 */
function readFailureCode(failure: unknown): string {
  if (failure instanceof WorkspaceSearchMigrationFailure) {
    return failure.code
  }
  if (failure instanceof Error && 'code' in failure) {
    const code = failure.code
    if (typeof code === 'string') return code
  }
  throw new Error('Expected one coded migration failure.')
}

/**
 * Asserts that selected events appear in strict trace order.
 *
 * @param events - Complete high-level operation trace.
 * @param expected - Ordered selected event subsequence.
 */
function expectOrderedEvents(
  events: readonly string[],
  expected: readonly string[],
): void {
  let previousIndex = -1
  for (const event of expected) {
    const index = events.indexOf(event)
    expect(index).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
}

/**
 * Computes a rich-reference storage lookup key.
 *
 * @param reference - Exact immutable object reference.
 * @returns Collision-free fixture lookup key.
 */
function createArtifactStorageKey(
  reference: WorkspaceSearchMigrationImmutableArtifactReference,
): string {
  return `${reference.objectKey}\u0000${reference.versionId}`
}

/**
 * Computes the lowercase SHA-256 digest of exact bytes.
 *
 * @param bytes - Exact artifact bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
