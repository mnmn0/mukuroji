import { types as nodeUtilTypes } from 'node:util'
import {
  DescribeTableCommand,
  type DescribeTableCommandOutput,
  type ScanCommand,
  type ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
import type {
  GetObjectAttributesCommand,
  GetObjectAttributesCommandOutput,
  GetObjectTaggingCommand,
  GetObjectTaggingCommandOutput,
  GetBucketVersioningCommand,
  GetBucketVersioningCommandOutput,
  HeadObjectCommand,
  HeadObjectCommandOutput,
} from '@aws-sdk/client-s3'
import type {
  GetCallerIdentityCommand,
  GetCallerIdentityCommandOutput,
} from '@aws-sdk/client-sts'
import {
  CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS,
  type CrossDomainIntegrityTableResourceTarget,
} from '../../data-integrity/cross-domain-integrity'
import type {
  CrossDomainIntegrityTableNames,
} from '../../data-integrity/cross-domain-integrity-aws-types'
import type {
  CrossDomainIntegrityAwsTransport,
} from '../../data-integrity/verify-cross-domain-integrity'
import { createMigrationDigest } from './migration-contract'
import type {
  WorkspaceSearchMigrationManagedDescribeTableRate,
} from './migration-describe-table-rate-managed-session'

/** Sole rate-ledger phase used by migration-rehearsal integrity reads. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE =
  'integrity-check'

/** Number of canonical six-table passes required by one integrity operation. */
export type WorkspaceSearchMigrationRehearsalIntegrityTablePassCount = 1 | 2

/** Secret-free exact call-order proof minted by the managed adapter. */
export type WorkspaceSearchMigrationRehearsalIntegrityRateSequence = {
  /** Fixed sequence-proof discriminator. */
  readonly kind:
    'mukuroji-workspace-search-migration-rehearsal-integrity-rate-sequence'
  /** Initial exact call-order proof contract. */
  readonly version: 1
  /** Sole semantic rate-ledger phase used by every call. */
  readonly phase:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE
  /** One attestation pass or two live preflight/postflight passes. */
  readonly tablePassCount:
    WorkspaceSearchMigrationRehearsalIntegrityTablePassCount
  /** Six calls per pass completed through the rate owner without fallback. */
  readonly describeTableCallCount: 6 | 12
  /** First globally charged attempt owned exclusively by this operation. */
  readonly firstAttemptSequence: number
  /** Last globally charged attempt owned exclusively by this operation. */
  readonly lastAttemptSequence: number
  /** Digest of canonical logical targets and exact physical names in call order. */
  readonly tableOrderBindingDigest: string
}

/** Input selecting one exact-six rate-managed integrity adapter. */
export type CreateWorkspaceSearchMigrationRehearsalIntegrityRateAdapterInput = {
  /** Complete logical-to-physical #163 table allowlist. */
  readonly tableNames: CrossDomainIntegrityTableNames
  /** One initial attestation pass or two live checker passes. */
  readonly tablePassCount:
    WorkspaceSearchMigrationRehearsalIntegrityTablePassCount
  /** Existing read-only transport retained only for STS, S3, and Scan. */
  readonly baseTransport: CrossDomainIntegrityAwsTransport
  /** Existing durable maxAttempts=1 rate owner for all DescribeTable calls. */
  readonly rate: WorkspaceSearchMigrationManagedDescribeTableRate
}

/**
 * Rate-managed transport and exact one-shot integrity operation boundary.
 *
 * `describeTable` is implemented only by the durable rate owner. Every other
 * read delegates to the existing read-only transport, so STS, S3, Scan,
 * cancellation, and the checker deadline retain their established behavior.
 */
export interface WorkspaceSearchMigrationRehearsalIntegrityRateAdapter
  extends CrossDomainIntegrityAwsTransport {
  /**
   * Runs the complete attestation or live checker under one non-page rate gate.
   *
   * @param task - Checker operation using this adapter through its reader.
   * @returns Exact task result only after the fixed call sequence completes.
   */
  run<Result>(task: () => Promise<Result>): Promise<Result>

  /**
   * Reads the completed fixed call-order proof exactly once.
   *
   * @param taskResult - Exact object reference returned by the completed task.
   * @returns Frozen secret-free exact-six or exact-twelve sequence binding.
   */
  takeCompletedSequence(taskResult: unknown):
    WorkspaceSearchMigrationRehearsalIntegrityRateSequence
}

/** Stable fail-closed adapter error without table names or AWS details. */
export class WorkspaceSearchMigrationRehearsalIntegrityRateAdapterError
  extends Error {
  /** Stable raw-value-free error code. */
  readonly code = 'INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE'

  /** Creates the sole external adapter failure. */
  constructor() {
    super('INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE')
    this.name = 'WorkspaceSearchMigrationRehearsalIntegrityRateAdapterError'
  }
}

/** Genuine operation result retained behind an authentic sequence capability. */
type AuthenticatedIntegrityRateSequenceState = {
  /** Detached exact call-order claims. */
  readonly claims: WorkspaceSearchMigrationRehearsalIntegrityRateSequence
  /** Exact object reference returned by the adapter-owned task. */
  readonly taskResult: object
  /** Canonical digest sampled before the task result left the adapter. */
  readonly taskResultBindingDigest: string
}

/** One-shot detached claims retained behind an authentic sequence capability. */
const authenticatedIntegrityRateSequences = new WeakMap<
  object,
  AuthenticatedIntegrityRateSequenceState
>()

/** Detached validated construction state for one adapter. */
type IntegrityRateAdapterSnapshot = {
  /** Existing read-only transport for non-DescribeTable calls. */
  readonly baseTransport: CrossDomainIntegrityAwsTransport
  /** Durable maxAttempts=1 DescribeTable rate owner. */
  readonly rate: WorkspaceSearchMigrationManagedDescribeTableRate
  /** Exact physical names repeated in canonical pass order. */
  readonly expectedTableNames: readonly string[]
  /** Number of complete canonical six-table passes. */
  readonly tablePassCount:
    WorkspaceSearchMigrationRehearsalIntegrityTablePassCount
  /** Digest binding canonical logical targets to the physical call order. */
  readonly tableOrderBindingDigest: string
}

/** Concrete one-shot adapter whose base DescribeTable method is unreachable. */
class ManagedIntegrityRateAdapter
  implements WorkspaceSearchMigrationRehearsalIntegrityRateAdapter {
  /** Existing read-only transport used only for STS, S3, and Scan. */
  readonly #baseTransport: CrossDomainIntegrityAwsTransport

  /** Durable maxAttempts=1 owner of every DescribeTable call. */
  readonly #rate: WorkspaceSearchMigrationManagedDescribeTableRate

  /** Exact physical table order required from the checker reader. */
  readonly #expectedTableNames: readonly string[]

  /** Fixed one-pass or two-pass operation classification. */
  readonly #tablePassCount:
    WorkspaceSearchMigrationRehearsalIntegrityTablePassCount

  /** Secret-free digest of logical targets and physical names. */
  readonly #tableOrderBindingDigest: string

  /** Number of ordered DescribeTable calls issued to the rate owner. */
  #issuedTableCallCount = 0

  /** Number of ordered rate-owned calls that completed successfully. */
  #completedTableCallCount = 0

  /** Whether one rate-owned DescribeTable call remains unsettled. */
  #describeTableCallInFlight = false

  /** Whether the sole operation is currently allowed to call DescribeTable. */
  #operationActive = false

  /** Whether the sole complete operation already began. */
  #operationStarted = false

  /** Whether the fixed call sequence completed successfully. */
  #operationCompleted = false

  /** Whether the exact sequence proof was already consumed. */
  #sequenceConsumed = false

  /** First exclusive durable attempt sequence, set only after successful run. */
  #firstAttemptSequence: number | undefined

  /** Last exclusive durable attempt sequence, set only after successful run. */
  #lastAttemptSequence: number | undefined

  /** Exact object reference causally returned by the completed operation. */
  #taskResult: object | undefined

  /** Canonical digest of the result before it left the operation boundary. */
  #taskResultBindingDigest: string | undefined

  /** Whether the delegated base transport was closed. */
  #closed = false

  /** Retains one already validated construction snapshot. */
  constructor(snapshot: IntegrityRateAdapterSnapshot) {
    this.#baseTransport = snapshot.baseTransport
    this.#rate = snapshot.rate
    this.#expectedTableNames = snapshot.expectedTableNames
    this.#tablePassCount = snapshot.tablePassCount
    this.#tableOrderBindingDigest = snapshot.tableOrderBindingDigest
  }

  /** Closes only the delegated STS/S3/Scan transport exactly once. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#baseTransport.close()
  }

  /** Routes one exact ordered command exclusively through the rate owner. */
  async describeTable(
    command: DescribeTableCommand,
    signal: AbortSignal,
  ): Promise<DescribeTableCommandOutput> {
    if (
      !this.#operationActive ||
      this.#operationCompleted ||
      this.#describeTableCallInFlight ||
      this.#closed ||
      !(command instanceof DescribeTableCommand) ||
      nodeUtilTypes.isProxy(command) ||
      !(signal instanceof AbortSignal) ||
      nodeUtilTypes.isProxy(signal)
    ) return failIntegrityRateAdapter()
    const input = command.input
    if (
      typeof input !== 'object' ||
      input === null ||
      nodeUtilTypes.isProxy(input) ||
      Reflect.ownKeys(input).length !== 1 ||
      !Object.hasOwn(input, 'TableName')
    ) return failIntegrityRateAdapter()
    const tableName = input.TableName
    const expectedTableName =
      this.#expectedTableNames[this.#issuedTableCallCount]
    if (
      typeof tableName !== 'string' ||
      expectedTableName === undefined ||
      tableName !== expectedTableName
    ) return failIntegrityRateAdapter()
    const issuedIndex = this.#issuedTableCallCount
    this.#issuedTableCallCount += 1
    this.#describeTableCallInFlight = true
    try {
      const output = await this.#rate.describeTable(
        tableName,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE,
        signal,
      )
      if (
        !this.#operationActive ||
        this.#completedTableCallCount !== issuedIndex
      ) return failIntegrityRateAdapter()
      this.#completedTableCallCount += 1
      return output
    } finally {
      this.#describeTableCallInFlight = false
    }
  }

  /** @inheritdoc */
  getBucketVersioning(
    command: GetBucketVersioningCommand,
    signal: AbortSignal,
  ): Promise<GetBucketVersioningCommandOutput> {
    return this.#baseTransport.getBucketVersioning(command, signal)
  }

  /** @inheritdoc */
  getObjectAttributes(
    command: GetObjectAttributesCommand,
    signal: AbortSignal,
  ): Promise<GetObjectAttributesCommandOutput> {
    return this.#baseTransport.getObjectAttributes(command, signal)
  }

  /** @inheritdoc */
  getObjectTagging(
    command: GetObjectTaggingCommand,
    signal: AbortSignal,
  ): Promise<GetObjectTaggingCommandOutput> {
    return this.#baseTransport.getObjectTagging(command, signal)
  }

  /** @inheritdoc */
  headObject(
    command: HeadObjectCommand,
    signal: AbortSignal,
  ): Promise<HeadObjectCommandOutput> {
    return this.#baseTransport.headObject(command, signal)
  }

  /** @inheritdoc */
  readCallerIdentity(
    command: GetCallerIdentityCommand,
    signal: AbortSignal,
  ): Promise<GetCallerIdentityCommandOutput> {
    return this.#baseTransport.readCallerIdentity(command, signal)
  }

  /** @inheritdoc */
  scan(
    command: ScanCommand,
    signal: AbortSignal,
  ): Promise<ScanCommandOutput> {
    return this.#baseTransport.scan(command, signal)
  }

  /** Runs the sole complete operation under one serialized non-page gate. */
  async run<Result>(task: () => Promise<Result>): Promise<Result> {
    if (
      this.#operationStarted ||
      this.#closed ||
      typeof task !== 'function' ||
      nodeUtilTypes.isProxy(task)
    ) return failIntegrityRateAdapter()
    this.#operationStarted = true
    return await this.#rate.runNonPageOperation(async () => {
      this.#operationActive = true
      try {
        const before = this.#rate.readEvidence()
        const result = await task()
        const after = this.#rate.readEvidence()
        const expectedAttemptCount = this.#expectedTableNames.length
        if (
          typeof result !== 'object' ||
          result === null ||
          nodeUtilTypes.isProxy(result) ||
          this.#describeTableCallInFlight ||
          this.#issuedTableCallCount !== expectedAttemptCount ||
          this.#completedTableCallCount !== expectedAttemptCount ||
          after.policyVersion !== before.policyVersion ||
          after.attemptCount !== before.attemptCount + expectedAttemptCount ||
          after.forfeitedAttemptCount !== before.forfeitedAttemptCount ||
          after.throttleCount !== before.throttleCount ||
          after.budgetStopCount !== before.budgetStopCount
        ) {
          return failIntegrityRateAdapter()
        }
        this.#firstAttemptSequence = before.attemptCount + 1
        this.#lastAttemptSequence = after.attemptCount
        this.#taskResult = result
        this.#taskResultBindingDigest = createMigrationDigest(result)
        this.#operationCompleted = true
        return result
      } finally {
        this.#operationActive = false
      }
    })
  }

  /** Returns the fixed successful call-order proof once. */
  takeCompletedSequence(taskResult: unknown):
    WorkspaceSearchMigrationRehearsalIntegrityRateSequence {
    const firstAttemptSequence = this.#firstAttemptSequence
    const lastAttemptSequence = this.#lastAttemptSequence
    const expectedTaskResult = this.#taskResult
    const taskResultBindingDigest = this.#taskResultBindingDigest
    if (
      !this.#operationCompleted ||
      this.#sequenceConsumed ||
      firstAttemptSequence === undefined ||
      lastAttemptSequence === undefined ||
      expectedTaskResult === undefined ||
      taskResultBindingDigest === undefined ||
      taskResult !== expectedTaskResult ||
      createMigrationDigest(expectedTaskResult) !== taskResultBindingDigest
    ) {
      return failIntegrityRateAdapter()
    }
    this.#sequenceConsumed = true
    const describeTableCallCount = this.#tablePassCount === 1 ? 6 : 12
    const claims = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-rate-sequence',
      version: 1,
      phase: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE,
      tablePassCount: this.#tablePassCount,
      describeTableCallCount,
      firstAttemptSequence,
      lastAttemptSequence,
      tableOrderBindingDigest: this.#tableOrderBindingDigest,
    })
    const capability = Object.freeze({ ...claims })
    authenticatedIntegrityRateSequences.set(capability, {
      claims,
      taskResult: expectedTaskResult,
      taskResultBindingDigest,
    })
    return capability
  }
}

/**
 * Creates one strict rate-owned integrity transport without a DescribeTable
 * fallback to the supplied base SDK transport.
 *
 * @param input - Exact table allowlist, pass count, base reads, and rate owner.
 * @returns One-shot operation adapter and completed-sequence capability.
 */
export function createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter(
  input: CreateWorkspaceSearchMigrationRehearsalIntegrityRateAdapterInput,
): WorkspaceSearchMigrationRehearsalIntegrityRateAdapter {
  return new ManagedIntegrityRateAdapter(detachAdapterInput(input))
}

/**
 * Consumes one same-process exact call-order capability exactly once.
 *
 * Structural copies, proxies, structured clones, and replayed capabilities do
 * not carry the private WeakMap brand and therefore fail closed.
 *
 * @param value - Exact capability returned by `takeCompletedSequence`.
 * @param taskResult - Exact object reference returned by the adapter task.
 * @returns Detached frozen sequence claims for immediate private finalization.
 */
export function consumeWorkspaceSearchMigrationRehearsalIntegrityRateSequence(
  value: unknown,
  taskResult: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityRateSequence {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) return failIntegrityRateAdapter()
  const state = authenticatedIntegrityRateSequences.get(value)
  if (
    state === undefined ||
    taskResult !== state.taskResult ||
    createMigrationDigest(state.taskResult) !== state.taskResultBindingDigest
  ) return failIntegrityRateAdapter()
  authenticatedIntegrityRateSequences.delete(value)
  return Object.freeze({ ...state.claims })
}

/** Validates and detaches one adapter construction input. */
function detachAdapterInput(
  input: CreateWorkspaceSearchMigrationRehearsalIntegrityRateAdapterInput,
): IntegrityRateAdapterSnapshot {
  let tableNames: CrossDomainIntegrityTableNames
  let tablePassCount:
    WorkspaceSearchMigrationRehearsalIntegrityTablePassCount
  let baseTransport: CrossDomainIntegrityAwsTransport
  let rate: WorkspaceSearchMigrationManagedDescribeTableRate
  try {
    tableNames = input.tableNames
    tablePassCount = input.tablePassCount
    baseTransport = input.baseTransport
    rate = input.rate
  } catch {
    return failIntegrityRateAdapter()
  }
  if (
    (tablePassCount !== 1 && tablePassCount !== 2) ||
    typeof baseTransport !== 'object' ||
    baseTransport === null ||
    nodeUtilTypes.isProxy(baseTransport) ||
    typeof rate !== 'object' ||
    rate === null ||
    nodeUtilTypes.isProxy(rate)
  ) return failIntegrityRateAdapter()
  const ordered = CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS.map(
    (target) => Object.freeze({
      target,
      tableName: readPhysicalTableName(tableNames, target),
    }),
  )
  const physicalNames = ordered.map((entry) => entry.tableName)
  if (new Set(physicalNames).size !== physicalNames.length) {
    return failIntegrityRateAdapter()
  }
  const expectedTableNames = Array.from(
    { length: tablePassCount },
    () => physicalNames,
  ).flat()
  return Object.freeze({
    baseTransport,
    rate,
    expectedTableNames: Object.freeze(expectedTableNames),
    tablePassCount,
    tableOrderBindingDigest: createMigrationDigest(ordered),
  })
}

/** Reads one physical table name from the canonical logical target. */
function readPhysicalTableName(
  tableNames: CrossDomainIntegrityTableNames,
  target: CrossDomainIntegrityTableResourceTarget,
): string {
  let value: unknown
  try {
    switch (target) {
      case 'table:audit-events':
        value = tableNames['audit-events']
        break
      case 'table:file-proofing':
        value = tableNames['file-proofing']
        break
      case 'table:project-directory':
        value = tableNames['project-directory']
        break
      case 'table:work-item-configuration':
        value = tableNames['work-item-configuration']
        break
      case 'table:work-items':
        value = tableNames['work-items']
        break
      case 'table:workspace-access':
        value = tableNames['workspace-access']
        break
    }
  } catch {
    return failIntegrityRateAdapter()
  }
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 255 ||
    !/^[A-Za-z0-9_.-]+$/u.test(value)
  ) return failIntegrityRateAdapter()
  return value
}

/** Throws the stable raw-value-free adapter failure. */
function failIntegrityRateAdapter(): never {
  throw new WorkspaceSearchMigrationRehearsalIntegrityRateAdapterError()
}
