import { types as nodeUtilTypes } from 'node:util'
import {
  isCanonicalTimestamp,
  type WorkspaceSearchMigrationSourceName,
  workspaceSearchMigrationSourceNames,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'
import type {
  WorkspaceSearchMigrationCheckpointLocation,
} from './migration-state-machine'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Planning-page failpoints that require a present successor cursor. */
export type WorkspaceSearchMigrationRehearsalPlanningPageFailpoint =
  | 'planning-page-artifact-uploaded-before-checkpoint-commit'
  | 'planning-page-transaction-response-lost'

/** Apply checkpoint cursor failpoints requiring a non-terminal successor. */
export type WorkspaceSearchMigrationRehearsalApplyCheckpointFailpoint =
  | 'apply-checkpoint-cursor-captured-before-commit'
  | 'apply-checkpoint-cursor-committed-before-return'

/** Every finite runtime fault available to a migration rehearsal. */
export type WorkspaceSearchMigrationRehearsalFailpoint =
  | WorkspaceSearchMigrationRehearsalPlanningPageFailpoint
  | WorkspaceSearchMigrationRehearsalApplyCheckpointFailpoint
  | 'apply-operation-committed-before-return'
  | 'lease-acquired-before-first-heartbeat'

/** Exact reviewed runtime fault surface. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAILPOINTS:
  readonly WorkspaceSearchMigrationRehearsalFailpoint[] = Object.freeze([
    'planning-page-artifact-uploaded-before-checkpoint-commit',
    'planning-page-transaction-response-lost',
    'apply-checkpoint-cursor-captured-before-commit',
    'apply-checkpoint-cursor-committed-before-return',
    'apply-operation-committed-before-return',
    'lease-acquired-before-first-heartbeat',
  ])

/** One non-terminal planning page selected for runtime fault injection. */
export type WorkspaceSearchMigrationRehearsalPlanningPageTarget =
  | {
    /** Selects one named source-table planning scan. */
    readonly kind: 'source'
    /** Exact source-table role selected by the operator. */
    readonly source: WorkspaceSearchMigrationSourceName
    /** Positive successor page sequence selected by the operator. */
    readonly pageSequence: number
    /** Requires the selected successor checkpoint to retain a cursor. */
    readonly cursorState: 'present'
  }
  | {
    /** Selects the Workspace Search target-table planning scan. */
    readonly kind: 'target'
    /** Positive successor page sequence selected by the operator. */
    readonly pageSequence: number
    /** Requires the selected successor checkpoint to retain a cursor. */
    readonly cursorState: 'present'
  }

/** One non-terminal apply checkpoint selected for cursor interruption. */
export type WorkspaceSearchMigrationRehearsalApplyCheckpointTarget = {
  /** Selects the apply phase's durable traversal checkpoint. */
  readonly kind: 'apply-checkpoint'
  /** Exact source or target traversal selected by the operator. */
  readonly location: WorkspaceSearchMigrationCheckpointLocation
  /** Positive successor page sequence selected by the operator. */
  readonly pageSequence: number
  /** Requires the selected successor checkpoint to retain a cursor. */
  readonly cursorState: 'present'
}

/** One strict partial apply prefix selected for process interruption. */
export type WorkspaceSearchMigrationRehearsalApplyOperationTarget = {
  /** Selects an already committed forward apply operation. */
  readonly kind: 'apply-operation'
  /** Exact positive committed plan sequence selected by the operator. */
  readonly planSequence: number
  /** Proves that at least one later planned operation remains uncommitted. */
  readonly remainingOperations: 'present'
}

/** The unique planning-session lease selected for expiry and takeover. */
export type WorkspaceSearchMigrationRehearsalLeaseTarget = {
  /** Selects the planning session rather than a page checkpoint. */
  readonly kind: 'planning-lease'
}

/** Exact non-production acknowledgement carried by every fault plan. */
type WorkspaceSearchMigrationRehearsalFaultPlanGuard = {
  /** Only the literal non-production stage is accepted. */
  readonly stage: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
  /** Exact operator acknowledgement required by the rehearsal permit. */
  readonly approval: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL
}

/** One page-specific runtime fault plan. */
type WorkspaceSearchMigrationRehearsalPlanningPageFaultPlan =
  WorkspaceSearchMigrationRehearsalFaultPlanGuard & {
    /** Exact page failpoint selected by the operator. */
    readonly failpoint:
      WorkspaceSearchMigrationRehearsalPlanningPageFailpoint
    /** Exact non-terminal source or target page selected by the operator. */
    readonly target: WorkspaceSearchMigrationRehearsalPlanningPageTarget
  }

/** One apply-checkpoint cursor interruption plan. */
type WorkspaceSearchMigrationRehearsalApplyCheckpointFaultPlan =
  WorkspaceSearchMigrationRehearsalFaultPlanGuard & {
    /** Exact apply checkpoint boundary selected by the operator. */
    readonly failpoint:
      WorkspaceSearchMigrationRehearsalApplyCheckpointFailpoint
    /** Exact non-terminal apply checkpoint selected by the operator. */
    readonly target:
      WorkspaceSearchMigrationRehearsalApplyCheckpointTarget
  }

/** One strict partial-prefix apply interruption plan. */
type WorkspaceSearchMigrationRehearsalApplyOperationFaultPlan =
  WorkspaceSearchMigrationRehearsalFaultPlanGuard & {
    /** Exact post-commit apply operation barrier. */
    readonly failpoint: 'apply-operation-committed-before-return'
    /** Exact strict partial prefix selected by the operator. */
    readonly target:
      WorkspaceSearchMigrationRehearsalApplyOperationTarget
  }

/** One planning-lease runtime fault plan. */
type WorkspaceSearchMigrationRehearsalLeaseFaultPlan =
  WorkspaceSearchMigrationRehearsalFaultPlanGuard & {
    /** Exact lease barrier selected by the operator. */
    readonly failpoint: 'lease-acquired-before-first-heartbeat'
    /** Unique planning lease selected by the operator. */
    readonly target: WorkspaceSearchMigrationRehearsalLeaseTarget
  }

/** Strict detached plan for one and only one runtime fault. */
export type WorkspaceSearchMigrationRehearsalFaultPlan =
  | WorkspaceSearchMigrationRehearsalPlanningPageFaultPlan
  | WorkspaceSearchMigrationRehearsalApplyCheckpointFaultPlan
  | WorkspaceSearchMigrationRehearsalApplyOperationFaultPlan
  | WorkspaceSearchMigrationRehearsalLeaseFaultPlan

/** A page failpoint reached by the migration runtime. */
type WorkspaceSearchMigrationRehearsalPlanningPageFaultReach = {
  /** Exact page failpoint reached by the runtime. */
  readonly failpoint:
    WorkspaceSearchMigrationRehearsalPlanningPageFailpoint
  /** Exact non-terminal planning page that reached the failpoint. */
  readonly target: WorkspaceSearchMigrationRehearsalPlanningPageTarget
  /** Canonical time at which the runtime reached the failpoint. */
  readonly reachedAt: string
}

/** An apply checkpoint cursor boundary reached by the migration runtime. */
type WorkspaceSearchMigrationRehearsalApplyCheckpointFaultReach = {
  /** Exact cursor boundary reached by the apply runtime. */
  readonly failpoint:
    WorkspaceSearchMigrationRehearsalApplyCheckpointFailpoint
  /** Exact non-terminal apply checkpoint that reached the boundary. */
  readonly target:
    WorkspaceSearchMigrationRehearsalApplyCheckpointTarget
  /** Canonical time at which the runtime reached the failpoint. */
  readonly reachedAt: string
}

/** A strict partial apply prefix reached by the migration runtime. */
type WorkspaceSearchMigrationRehearsalApplyOperationFaultReach = {
  /** Exact post-commit apply barrier reached by the runtime. */
  readonly failpoint: 'apply-operation-committed-before-return'
  /** Exact strict partial prefix committed before interruption. */
  readonly target:
    WorkspaceSearchMigrationRehearsalApplyOperationTarget
  /** Canonical time at which the runtime reached the failpoint. */
  readonly reachedAt: string
}

/** The planning lease barrier reached by the migration runtime. */
type WorkspaceSearchMigrationRehearsalLeaseFaultReach = {
  /** Exact lease failpoint reached by the runtime. */
  readonly failpoint: 'lease-acquired-before-first-heartbeat'
  /** Unique planning lease that reached the barrier. */
  readonly target: WorkspaceSearchMigrationRehearsalLeaseTarget
  /** Canonical time at which the runtime reached the failpoint. */
  readonly reachedAt: string
}

/** Strict semantic event offered to one runtime fault controller. */
export type WorkspaceSearchMigrationRehearsalFaultReach =
  | WorkspaceSearchMigrationRehearsalPlanningPageFaultReach
  | WorkspaceSearchMigrationRehearsalApplyCheckpointFaultReach
  | WorkspaceSearchMigrationRehearsalApplyOperationFaultReach
  | WorkspaceSearchMigrationRehearsalLeaseFaultReach

/** Runtime action required after one selected failpoint is reached. */
export type WorkspaceSearchMigrationRehearsalFaultAction =
  | 'barrier'
  | 'response-loss'

/** Secret-free evidence emitted before the selected fault takes effect. */
export type WorkspaceSearchMigrationRehearsalFaultReceipt = {
  /** Receipt schema version. */
  readonly receiptVersion: 1
  /** Fixed environment label safe for external evidence. */
  readonly stage: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
  /** Exact failpoint reached by the runtime. */
  readonly failpoint: WorkspaceSearchMigrationRehearsalFailpoint
  /** External harness action associated with the failpoint. */
  readonly action: WorkspaceSearchMigrationRehearsalFaultAction
  /** Semantic page or lease target, excluding physical resource values. */
  readonly target:
    | WorkspaceSearchMigrationRehearsalPlanningPageTarget
    | WorkspaceSearchMigrationRehearsalApplyCheckpointTarget
    | WorkspaceSearchMigrationRehearsalApplyOperationTarget
    | WorkspaceSearchMigrationRehearsalLeaseTarget
  /** Fixed occurrence proving the controller is one-shot. */
  readonly occurrence: 1
  /** Canonical time supplied by the reaching runtime boundary. */
  readonly reachedAt: string
}

/** Stable raw-value-free fault-controller failures. */
export type WorkspaceSearchMigrationRehearsalFaultErrorCode =
  | 'INVALID_PLAN'
  | 'INVALID_CONTROLLER'
  | 'INVALID_REACH'
  | 'ALREADY_REACHED'
  | 'NOT_REACHED'
  | 'CALLBACK_FAILED'
  | 'TRANSACTION_RESPONSE_LOST'

/** Stable error raised by the pure runtime fault boundary. */
export class WorkspaceSearchMigrationRehearsalFaultError extends Error {
  /** Stable machine-readable failure without caller-owned values. */
  readonly code: WorkspaceSearchMigrationRehearsalFaultErrorCode

  /**
   * Creates one raw-value-free controller failure.
   *
   * @param code - Stable failure classification.
   */
  constructor(code: WorkspaceSearchMigrationRehearsalFaultErrorCode) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalFaultError'
    this.code = code
  }
}

/** Callback invoked with one frozen secret-free reach receipt. */
export type WorkspaceSearchMigrationRehearsalFaultCallback = (
  receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
) => Promise<void>

/** Pre-effect preparation invoked only after one exact fault-plan match. */
export type WorkspaceSearchMigrationRehearsalFaultMatchPreparation = (
  receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
) => Promise<void>

/** Dependencies used to construct one isolated fault controller. */
export type CreateWorkspaceSearchMigrationRehearsalFaultControllerInput = {
  /** Untrusted operator-selected fault plan. */
  readonly plan: unknown
  /** Barrier that an external harness may hold until it kills the process. */
  readonly waitAtBarrier:
    WorkspaceSearchMigrationRehearsalFaultCallback
  /** Reporter invoked before a synthetic transaction response-loss error. */
  readonly reportResponseLoss:
    WorkspaceSearchMigrationRehearsalFaultCallback
}

/** One-shot pure controller for an exact semantic runtime fault. */
export interface WorkspaceSearchMigrationRehearsalFaultController {
  /**
   * Offers one strict semantic reach event to the selected plan.
   *
   * A non-matching valid event returns undefined. A matching barrier waits for
   * the injected callback, while a matching response-loss point reports its
   * receipt and then rejects with `TRANSACTION_RESPONSE_LOST`.
   *
   * @param candidate - Untrusted semantic reach event.
   * @param prepareMatch - Optional trusted preparation before external effect.
   * @returns Frozen receipt for a completed barrier, or undefined on mismatch.
   */
  reach(
    candidate: unknown,
    prepareMatch?: WorkspaceSearchMigrationRehearsalFaultMatchPreparation,
  ): Promise<WorkspaceSearchMigrationRehearsalFaultReceipt | undefined>

  /**
   * Reads a detached receipt after the selected failpoint was reached.
   *
   * @returns Frozen detached receipt, or undefined before the first match.
   */
  readReceipt():
    WorkspaceSearchMigrationRehearsalFaultReceipt | undefined

  /**
   * Requires a detached receipt after the selected failpoint was reached.
   *
   * @returns Frozen detached receipt.
   */
  requireReceipt(): WorkspaceSearchMigrationRehearsalFaultReceipt
}

/** Exact fields carried by a fault plan. */
const planKeys = Object.freeze([
  'approval',
  'failpoint',
  'stage',
  'target',
])

/** Exact fields carried by one semantic reach event. */
const reachKeys = Object.freeze([
  'failpoint',
  'reachedAt',
  'target',
])

/** Exact fields carried by one external secret-free fault receipt. */
const receiptKeys = Object.freeze([
  'action',
  'failpoint',
  'occurrence',
  'reachedAt',
  'receiptVersion',
  'stage',
  'target',
])

/** Exact fields carried by a source planning-page target. */
const sourcePageTargetKeys = Object.freeze([
  'cursorState',
  'kind',
  'pageSequence',
  'source',
])

/** Exact fields carried by a target-table planning-page target. */
const targetPageTargetKeys = Object.freeze([
  'cursorState',
  'kind',
  'pageSequence',
])

/** Exact fields carried by one apply-checkpoint cursor target. */
const applyCheckpointTargetKeys = Object.freeze([
  'cursorState',
  'kind',
  'location',
  'pageSequence',
])

/** Exact fields carried by one strict partial apply target. */
const applyOperationTargetKeys = Object.freeze([
  'kind',
  'planSequence',
  'remainingOperations',
])

/** Exact fields carried by the planning-lease target. */
const leaseTargetKeys = Object.freeze(['kind'])

/** Exact fields used to construct a fault controller. */
const controllerKeys = Object.freeze([
  'plan',
  'reportResponseLoss',
  'waitAtBarrier',
])

/** Strict guards for one operator fault plan. */
const planGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  () => failRehearsalFault('INVALID_PLAN'),
)

/** Strict guards for one runtime reach event. */
const reachGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  () => failRehearsalFault('INVALID_REACH'),
)

/** Strict guards for one external secret-free fault receipt. */
const receiptGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  () => failRehearsalFault('INVALID_REACH'),
)

/** Strict guards for controller construction dependencies. */
const controllerGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  () => failRehearsalFault('INVALID_CONTROLLER'),
)

/** Pure implementation retaining one-shot state behind a frozen instance. */
class WorkspaceSearchMigrationRehearsalFaultControllerImplementation
implements WorkspaceSearchMigrationRehearsalFaultController {
  /** Detached strict fault plan. */
  readonly #plan: WorkspaceSearchMigrationRehearsalFaultPlan

  /** Captured and normalized external process-kill barrier. */
  readonly #waitAtBarrier:
    WorkspaceSearchMigrationRehearsalFaultCallback

  /** Captured and normalized transaction response-loss reporter. */
  readonly #reportResponseLoss:
    WorkspaceSearchMigrationRehearsalFaultCallback

  /** First and only matching reach receipt. */
  #receipt: WorkspaceSearchMigrationRehearsalFaultReceipt | undefined

  /**
   * Creates one controller from detached plan and callback snapshots.
   *
   * @param plan - Detached strict fault plan.
   * @param waitAtBarrier - Captured process-kill barrier.
   * @param reportResponseLoss - Captured response-loss reporter.
   */
  constructor(
    plan: WorkspaceSearchMigrationRehearsalFaultPlan,
    waitAtBarrier: WorkspaceSearchMigrationRehearsalFaultCallback,
    reportResponseLoss: WorkspaceSearchMigrationRehearsalFaultCallback,
  ) {
    this.#plan = plan
    this.#waitAtBarrier = waitAtBarrier
    this.#reportResponseLoss = reportResponseLoss
    this.#receipt = undefined
  }

  /**
   * Offers one strict semantic reach event to the selected plan.
   *
   * @param candidate - Untrusted semantic reach event.
   * @returns Frozen receipt for a completed barrier, or undefined on mismatch.
   */
  async reach(
    candidate: unknown,
    prepareMatch?: WorkspaceSearchMigrationRehearsalFaultMatchPreparation,
  ): Promise<WorkspaceSearchMigrationRehearsalFaultReceipt | undefined> {
    if (prepareMatch !== undefined && typeof prepareMatch !== 'function') {
      return failRehearsalFault('INVALID_REACH')
    }
    const reach = snapshotWorkspaceSearchMigrationRehearsalFaultReach(
      candidate,
    )
    if (!faultPlanMatchesReach(this.#plan, reach)) return undefined
    if (this.#receipt !== undefined) {
      return failRehearsalFault('ALREADY_REACHED')
    }
    const receipt = createRehearsalFaultReceipt(reach)
    this.#receipt = receipt
    if (prepareMatch !== undefined) {
      await prepareMatch(cloneRehearsalFaultReceipt(receipt))
    }
    if (receipt.action === 'barrier') {
      await this.#waitAtBarrier(cloneRehearsalFaultReceipt(receipt))
      return cloneRehearsalFaultReceipt(receipt)
    }
    await this.#reportResponseLoss(cloneRehearsalFaultReceipt(receipt))
    return failRehearsalFault('TRANSACTION_RESPONSE_LOST')
  }

  /**
   * Reads a detached receipt after the selected failpoint was reached.
   *
   * @returns Frozen receipt, or undefined before the first match.
   */
  readReceipt():
    WorkspaceSearchMigrationRehearsalFaultReceipt | undefined {
    const receipt = this.#receipt
    return receipt === undefined
      ? undefined
      : cloneRehearsalFaultReceipt(receipt)
  }

  /**
   * Requires a detached receipt after the selected failpoint was reached.
   *
   * @returns Frozen detached receipt.
   */
  requireReceipt(): WorkspaceSearchMigrationRehearsalFaultReceipt {
    const receipt = this.#receipt
    if (receipt === undefined) return failRehearsalFault('NOT_REACHED')
    return cloneRehearsalFaultReceipt(receipt)
  }
}

Object.freeze(
  WorkspaceSearchMigrationRehearsalFaultControllerImplementation.prototype,
)

/**
 * Validates and detaches one exact non-production runtime fault plan.
 *
 * @param candidate - Untrusted operator-selected plan.
 * @returns Frozen plan detached from caller-owned objects.
 */
export function snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
  candidate: unknown,
): WorkspaceSearchMigrationRehearsalFaultPlan {
  try {
    const record = requireExactRecord(
      planGuards,
      candidate,
      planKeys,
      () => failRehearsalFault('INVALID_PLAN'),
    )
    const stage = planGuards.readOwn(record, 'stage')
    const approval = planGuards.readOwn(record, 'approval')
    if (
      stage !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE ||
      approval !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL
    ) {
      return failRehearsalFault('INVALID_PLAN')
    }
    const failpoint = readRehearsalFailpoint(
      planGuards.readOwn(record, 'failpoint'),
      () => failRehearsalFault('INVALID_PLAN'),
    )
    const targetValue = planGuards.readOwn(record, 'target')
    if (isPlanningPageFailpoint(failpoint)) {
      const target = readPlanningPageTarget(
        planGuards,
        targetValue,
        () => failRehearsalFault('INVALID_PLAN'),
      )
      const plan: WorkspaceSearchMigrationRehearsalPlanningPageFaultPlan = {
        stage,
        approval,
        failpoint,
        target,
      }
      return Object.freeze(plan)
    }
    if (isApplyCheckpointFailpoint(failpoint)) {
      const target = readApplyCheckpointTarget(
        planGuards,
        targetValue,
        () => failRehearsalFault('INVALID_PLAN'),
      )
      const plan: WorkspaceSearchMigrationRehearsalApplyCheckpointFaultPlan = {
        stage,
        approval,
        failpoint,
        target,
      }
      return Object.freeze(plan)
    }
    if (failpoint === 'apply-operation-committed-before-return') {
      const target = readApplyOperationTarget(
        planGuards,
        targetValue,
        () => failRehearsalFault('INVALID_PLAN'),
      )
      const plan: WorkspaceSearchMigrationRehearsalApplyOperationFaultPlan = {
        stage,
        approval,
        failpoint,
        target,
      }
      return Object.freeze(plan)
    }
    const target = readLeaseTarget(
      planGuards,
      targetValue,
      () => failRehearsalFault('INVALID_PLAN'),
    )
    const plan: WorkspaceSearchMigrationRehearsalLeaseFaultPlan = {
      stage,
      approval,
      failpoint,
      target,
    }
    return Object.freeze(plan)
  } catch {
    return failRehearsalFault('INVALID_PLAN')
  }
}

/**
 * Creates one pure one-shot fault controller with injected effects.
 *
 * The module never reads ambient environment state and never terminates a
 * process. A real rehearsal harness implements process kill by holding the
 * injected barrier after it has received the secret-free receipt.
 *
 * @param input - Untrusted plan and trusted injected callbacks.
 * @returns Frozen controller retaining only detached state.
 */
export function createWorkspaceSearchMigrationRehearsalFaultController(
  input: CreateWorkspaceSearchMigrationRehearsalFaultControllerInput,
): WorkspaceSearchMigrationRehearsalFaultController {
  const record = readControllerRecord(input)
  const planCandidate = controllerGuards.readOwn(record, 'plan')
  const waitAtBarrier = captureRehearsalFaultCallback(
    controllerGuards.readOwn(record, 'waitAtBarrier'),
  )
  const reportResponseLoss = captureRehearsalFaultCallback(
    controllerGuards.readOwn(record, 'reportResponseLoss'),
  )
  const controller =
    new WorkspaceSearchMigrationRehearsalFaultControllerImplementation(
      snapshotWorkspaceSearchMigrationRehearsalFaultPlan(planCandidate),
      waitAtBarrier,
      reportResponseLoss,
    )
  return Object.freeze(controller)
}

/**
 * Parses one exact secret-free fault receipt emitted across a process boundary.
 *
 * @param candidate - Untrusted decoded receipt value.
 * @returns Frozen detached receipt after semantic target validation.
 */
export function parseWorkspaceSearchMigrationRehearsalFaultReceipt(
  candidate: unknown,
): WorkspaceSearchMigrationRehearsalFaultReceipt {
  try {
    const record = requireExactRecord(
      receiptGuards,
      candidate,
      receiptKeys,
      () => failRehearsalFault('INVALID_REACH'),
    )
    const reach = snapshotWorkspaceSearchMigrationRehearsalFaultReach({
      failpoint: receiptGuards.readOwn(record, 'failpoint'),
      target: receiptGuards.readOwn(record, 'target'),
      reachedAt: receiptGuards.readOwn(record, 'reachedAt'),
    })
    const expected = createRehearsalFaultReceipt(reach)
    if (
      receiptGuards.readOwn(record, 'receiptVersion') !== 1 ||
      receiptGuards.readOwn(record, 'stage') !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE ||
      receiptGuards.readOwn(record, 'occurrence') !== 1 ||
      receiptGuards.readOwn(record, 'action') !== expected.action
    ) {
      return failRehearsalFault('INVALID_REACH')
    }
    return expected
  } catch {
    return failRehearsalFault('INVALID_REACH')
  }
}

/**
 * Reads and validates one runtime reach event without retaining input objects.
 *
 * @param candidate - Untrusted semantic reach event.
 * @returns Frozen detached reach event.
 */
function snapshotWorkspaceSearchMigrationRehearsalFaultReach(
  candidate: unknown,
): WorkspaceSearchMigrationRehearsalFaultReach {
  try {
    const record = requireExactRecord(
      reachGuards,
      candidate,
      reachKeys,
      () => failRehearsalFault('INVALID_REACH'),
    )
    const failpoint = readRehearsalFailpoint(
      reachGuards.readOwn(record, 'failpoint'),
      () => failRehearsalFault('INVALID_REACH'),
    )
    const reachedAt = reachGuards.readOwn(record, 'reachedAt')
    if (!isCanonicalTimestamp(reachedAt)) {
      return failRehearsalFault('INVALID_REACH')
    }
    const targetValue = reachGuards.readOwn(record, 'target')
    if (isPlanningPageFailpoint(failpoint)) {
      const target = readPlanningPageTarget(
        reachGuards,
        targetValue,
        () => failRehearsalFault('INVALID_REACH'),
      )
      const reach: WorkspaceSearchMigrationRehearsalPlanningPageFaultReach = {
        failpoint,
        target,
        reachedAt,
      }
      return Object.freeze(reach)
    }
    if (isApplyCheckpointFailpoint(failpoint)) {
      const target = readApplyCheckpointTarget(
        reachGuards,
        targetValue,
        () => failRehearsalFault('INVALID_REACH'),
      )
      const reach: WorkspaceSearchMigrationRehearsalApplyCheckpointFaultReach = {
        failpoint,
        target,
        reachedAt,
      }
      return Object.freeze(reach)
    }
    if (failpoint === 'apply-operation-committed-before-return') {
      const target = readApplyOperationTarget(
        reachGuards,
        targetValue,
        () => failRehearsalFault('INVALID_REACH'),
      )
      const reach: WorkspaceSearchMigrationRehearsalApplyOperationFaultReach = {
        failpoint,
        target,
        reachedAt,
      }
      return Object.freeze(reach)
    }
    const target = readLeaseTarget(
      reachGuards,
      targetValue,
      () => failRehearsalFault('INVALID_REACH'),
    )
    const reach: WorkspaceSearchMigrationRehearsalLeaseFaultReach = {
      failpoint,
      target,
      reachedAt,
    }
    return Object.freeze(reach)
  } catch {
    return failRehearsalFault('INVALID_REACH')
  }
}

/**
 * Requires one ordinary exact-key record without invoking accessors.
 *
 * @param guards - Consumer-specific strict record guards.
 * @param candidate - Candidate record.
 * @param keys - Exact required enumerable own data keys.
 * @param fail - Stable consumer-specific failure callback.
 * @returns Validated ordinary record.
 */
function requireExactRecord(
  guards: WorkspaceSearchMigrationStrictRecordGuards,
  candidate: unknown,
  keys: readonly string[],
  fail: () => never,
): object {
  const record = guards.requireRecord(candidate)
  const prototype = Object.getPrototypeOf(record)
  if (prototype !== Object.prototype && prototype !== null) return fail()
  guards.requireExactKeys(record, keys)
  return record
}

/**
 * Reads one exact finite failpoint.
 *
 * @param value - Candidate failpoint.
 * @param fail - Stable caller-specific failure callback.
 * @returns Exact finite failpoint.
 */
function readRehearsalFailpoint(
  value: unknown,
  fail: () => never,
): WorkspaceSearchMigrationRehearsalFailpoint {
  switch (value) {
    case 'planning-page-artifact-uploaded-before-checkpoint-commit':
    case 'planning-page-transaction-response-lost':
    case 'apply-checkpoint-cursor-captured-before-commit':
    case 'apply-checkpoint-cursor-committed-before-return':
    case 'apply-operation-committed-before-return':
    case 'lease-acquired-before-first-heartbeat':
      return value
    default:
      return fail()
  }
}

/**
 * Checks whether one finite failpoint targets a non-terminal planning page.
 *
 * @param value - Validated finite failpoint.
 * @returns Whether the failpoint requires a page target.
 */
function isPlanningPageFailpoint(
  value: WorkspaceSearchMigrationRehearsalFailpoint,
): value is WorkspaceSearchMigrationRehearsalPlanningPageFailpoint {
  return value.startsWith('planning-page-')
}

/**
 * Checks whether one finite failpoint targets an apply checkpoint cursor.
 *
 * @param value - Validated finite failpoint.
 * @returns Whether the failpoint requires an apply-checkpoint target.
 */
function isApplyCheckpointFailpoint(
  value: WorkspaceSearchMigrationRehearsalFailpoint,
): value is WorkspaceSearchMigrationRehearsalApplyCheckpointFailpoint {
  return value.startsWith('apply-checkpoint-')
}

/**
 * Reads one strict source or target planning-page selector.
 *
 * @param guards - Consumer-specific strict record guards.
 * @param value - Candidate target.
 * @param fail - Stable caller-specific failure callback.
 * @returns Frozen detached page target.
 */
function readPlanningPageTarget(
  guards: WorkspaceSearchMigrationStrictRecordGuards,
  value: unknown,
  fail: () => never,
): WorkspaceSearchMigrationRehearsalPlanningPageTarget {
  const record = guards.requireRecord(value)
  const prototype = Object.getPrototypeOf(record)
  if (prototype !== Object.prototype && prototype !== null) return fail()
  const kind = guards.readOwn(record, 'kind')
  if (kind === 'source') {
    guards.requireExactKeys(record, sourcePageTargetKeys)
    const target: WorkspaceSearchMigrationRehearsalPlanningPageTarget = {
      kind,
      source: readSourceName(guards.readOwn(record, 'source'), fail),
      pageSequence: readPositivePageSequence(
        guards.readOwn(record, 'pageSequence'),
        fail,
      ),
      cursorState: readPresentCursorState(
        guards.readOwn(record, 'cursorState'),
        fail,
      ),
    }
    return Object.freeze(target)
  }
  if (kind === 'target') {
    guards.requireExactKeys(record, targetPageTargetKeys)
    const target: WorkspaceSearchMigrationRehearsalPlanningPageTarget = {
      kind,
      pageSequence: readPositivePageSequence(
        guards.readOwn(record, 'pageSequence'),
        fail,
      ),
      cursorState: readPresentCursorState(
        guards.readOwn(record, 'cursorState'),
        fail,
      ),
    }
    return Object.freeze(target)
  }
  return fail()
}

/**
 * Reads one strict non-terminal apply checkpoint selector.
 *
 * @param guards - Consumer-specific strict record guards.
 * @param value - Candidate apply-checkpoint target.
 * @param fail - Stable caller-specific failure callback.
 * @returns Frozen detached apply checkpoint target.
 */
function readApplyCheckpointTarget(
  guards: WorkspaceSearchMigrationStrictRecordGuards,
  value: unknown,
  fail: () => never,
): WorkspaceSearchMigrationRehearsalApplyCheckpointTarget {
  const record = requireExactRecord(
    guards,
    value,
    applyCheckpointTargetKeys,
    fail,
  )
  const kind = guards.readOwn(record, 'kind')
  if (kind !== 'apply-checkpoint') return fail()
  const target: WorkspaceSearchMigrationRehearsalApplyCheckpointTarget = {
    kind,
    location: readCheckpointLocation(
      guards.readOwn(record, 'location'),
      fail,
    ),
    pageSequence: readPositivePageSequence(
      guards.readOwn(record, 'pageSequence'),
      fail,
    ),
    cursorState: readPresentCursorState(
      guards.readOwn(record, 'cursorState'),
      fail,
    ),
  }
  return Object.freeze(target)
}

/**
 * Reads one strict partial-prefix apply operation selector.
 *
 * @param guards - Consumer-specific strict record guards.
 * @param value - Candidate apply-operation target.
 * @param fail - Stable caller-specific failure callback.
 * @returns Frozen detached strict partial-prefix target.
 */
function readApplyOperationTarget(
  guards: WorkspaceSearchMigrationStrictRecordGuards,
  value: unknown,
  fail: () => never,
): WorkspaceSearchMigrationRehearsalApplyOperationTarget {
  const record = requireExactRecord(
    guards,
    value,
    applyOperationTargetKeys,
    fail,
  )
  const kind = guards.readOwn(record, 'kind')
  const remainingOperations = guards.readOwn(
    record,
    'remainingOperations',
  )
  if (
    kind !== 'apply-operation' ||
    remainingOperations !== 'present'
  ) {
    return fail()
  }
  const target: WorkspaceSearchMigrationRehearsalApplyOperationTarget = {
    kind,
    planSequence: readPositivePageSequence(
      guards.readOwn(record, 'planSequence'),
      fail,
    ),
    remainingOperations,
  }
  return Object.freeze(target)
}

/**
 * Reads the unique strict planning-lease selector.
 *
 * @param guards - Consumer-specific strict record guards.
 * @param value - Candidate lease target.
 * @param fail - Stable caller-specific failure callback.
 * @returns Frozen detached lease target.
 */
function readLeaseTarget(
  guards: WorkspaceSearchMigrationStrictRecordGuards,
  value: unknown,
  fail: () => never,
): WorkspaceSearchMigrationRehearsalLeaseTarget {
  const record = requireExactRecord(
    guards,
    value,
    leaseTargetKeys,
    fail,
  )
  const kind = guards.readOwn(record, 'kind')
  if (kind !== 'planning-lease') return fail()
  return Object.freeze({ kind })
}

/**
 * Reads one exact migration source role.
 *
 * @param value - Candidate source role.
 * @param fail - Stable caller-specific failure callback.
 * @returns Exact finite source role.
 */
function readSourceName(
  value: unknown,
  fail: () => never,
): WorkspaceSearchMigrationSourceName {
  for (const source of workspaceSearchMigrationSourceNames) {
    if (value === source) return source
  }
  return fail()
}

/**
 * Reads one exact apply checkpoint location.
 *
 * @param value - Candidate source or target location.
 * @param fail - Stable caller-specific failure callback.
 * @returns Exact finite checkpoint location.
 */
function readCheckpointLocation(
  value: unknown,
  fail: () => never,
): WorkspaceSearchMigrationCheckpointLocation {
  if (value === 'target') return value
  return readSourceName(value, fail)
}

/**
 * Reads one positive safe planning-page sequence.
 *
 * @param value - Candidate page sequence.
 * @param fail - Stable caller-specific failure callback.
 * @returns Positive safe page sequence.
 */
function readPositivePageSequence(
  value: unknown,
  fail: () => never,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return fail()
  }
  return value
}

/**
 * Reads the literal state proving a successor cursor is present.
 *
 * @param value - Candidate cursor-state marker.
 * @param fail - Stable caller-specific failure callback.
 * @returns Literal present state.
 */
function readPresentCursorState(
  value: unknown,
  fail: () => never,
): 'present' {
  if (value !== 'present') return fail()
  return value
}

/**
 * Reads exact controller fields without retaining its input object.
 *
 * @param input - Candidate controller construction dependencies.
 * @returns Strict controller input record.
 */
function readControllerRecord(
  input: CreateWorkspaceSearchMigrationRehearsalFaultControllerInput,
): object {
  try {
    return requireExactRecord(
      controllerGuards,
      input,
      controllerKeys,
      () => failRehearsalFault('INVALID_CONTROLLER'),
    )
  } catch {
    return failRehearsalFault('INVALID_CONTROLLER')
  }
}

/**
 * Captures one non-proxy callback and normalizes every runtime failure.
 *
 * @param value - Candidate injected callback.
 * @returns Safe callback wrapper requiring an exact native Promise<void>.
 */
function captureRehearsalFaultCallback(
  value: unknown,
): WorkspaceSearchMigrationRehearsalFaultCallback {
  if (
    typeof value !== 'function' ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failRehearsalFault('INVALID_CONTROLLER')
  }
  return async (receipt) => {
    let result: unknown
    try {
      result = Reflect.apply(value, undefined, [receipt])
    } catch {
      return failRehearsalFault('CALLBACK_FAILED')
    }
    if (!isExactNativePromise(result)) {
      return failRehearsalFault('CALLBACK_FAILED')
    }
    let resolution: unknown
    try {
      resolution = await result
    } catch {
      return failRehearsalFault('CALLBACK_FAILED')
    }
    if (resolution !== undefined) {
      return failRehearsalFault('CALLBACK_FAILED')
    }
  }
}

/**
 * Checks an exact native Promise without assimilating arbitrary thenables.
 *
 * @param value - Candidate callback result.
 * @returns Whether the result is an unmodified native Promise instance.
 */
function isExactNativePromise(value: unknown): value is Promise<unknown> {
  if (
    !nodeUtilTypes.isPromise(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false
  }
  try {
    return Object.getPrototypeOf(value) === Promise.prototype &&
      !Object.hasOwn(value, 'constructor')
  } catch {
    return false
  }
}

/**
 * Checks whether one detached plan matches one detached reach event.
 *
 * @param plan - Selected one-shot fault plan.
 * @param reach - Runtime semantic reach event.
 * @returns Whether point and semantic target match exactly.
 */
function faultPlanMatchesReach(
  plan: WorkspaceSearchMigrationRehearsalFaultPlan,
  reach: WorkspaceSearchMigrationRehearsalFaultReach,
): boolean {
  return plan.failpoint === reach.failpoint &&
    rehearsalFaultTargetsEqual(plan.target, reach.target)
}

/**
 * Compares two safe semantic targets without serializing them.
 *
 * @param left - Plan target.
 * @param right - Reach target.
 * @returns Whether every semantic selector is equal.
 */
function rehearsalFaultTargetsEqual(
  left:
    | WorkspaceSearchMigrationRehearsalPlanningPageTarget
    | WorkspaceSearchMigrationRehearsalApplyCheckpointTarget
    | WorkspaceSearchMigrationRehearsalApplyOperationTarget
    | WorkspaceSearchMigrationRehearsalLeaseTarget,
  right:
    | WorkspaceSearchMigrationRehearsalPlanningPageTarget
    | WorkspaceSearchMigrationRehearsalApplyCheckpointTarget
    | WorkspaceSearchMigrationRehearsalApplyOperationTarget
    | WorkspaceSearchMigrationRehearsalLeaseTarget,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'planning-lease') return true
  if (right.kind === 'planning-lease') return false
  if (left.kind === 'apply-operation') {
    return right.kind === 'apply-operation' &&
      left.planSequence === right.planSequence &&
      left.remainingOperations === right.remainingOperations
  }
  if (right.kind === 'apply-operation') return false
  if (
    left.pageSequence !== right.pageSequence ||
    left.cursorState !== right.cursorState
  ) {
    return false
  }
  if (left.kind === 'apply-checkpoint') {
    return right.kind === 'apply-checkpoint' &&
      left.location === right.location
  }
  if (right.kind === 'apply-checkpoint') return false
  if (left.kind === 'target') return true
  return right.kind === 'source' && left.source === right.source
}

/**
 * Creates one minimal secret-free receipt before the injected effect runs.
 *
 * @param reach - Detached matching semantic reach event.
 * @returns Frozen secret-free receipt.
 */
function createRehearsalFaultReceipt(
  reach: WorkspaceSearchMigrationRehearsalFaultReach,
): WorkspaceSearchMigrationRehearsalFaultReceipt {
  const receipt: WorkspaceSearchMigrationRehearsalFaultReceipt = {
    receiptVersion: 1,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    failpoint: reach.failpoint,
    action: reach.failpoint ===
      'planning-page-transaction-response-lost'
      ? 'response-loss'
      : 'barrier',
    target: cloneRehearsalFaultTarget(reach.target),
    occurrence: 1,
    reachedAt: reach.reachedAt,
  }
  return Object.freeze(receipt)
}

/**
 * Clones one receipt so callbacks and readers share no mutable wrapper.
 *
 * @param receipt - Safe stored receipt.
 * @returns Frozen detached receipt.
 */
function cloneRehearsalFaultReceipt(
  receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
): WorkspaceSearchMigrationRehearsalFaultReceipt {
  const clone: WorkspaceSearchMigrationRehearsalFaultReceipt = {
    receiptVersion: receipt.receiptVersion,
    stage: receipt.stage,
    failpoint: receipt.failpoint,
    action: receipt.action,
    target: cloneRehearsalFaultTarget(receipt.target),
    occurrence: receipt.occurrence,
    reachedAt: receipt.reachedAt,
  }
  return Object.freeze(clone)
}

/**
 * Clones one small semantic target into a frozen ordinary record.
 *
 * @param target - Safe detached target.
 * @returns Frozen detached target clone.
 */
function cloneRehearsalFaultTarget(
  target:
    | WorkspaceSearchMigrationRehearsalPlanningPageTarget
    | WorkspaceSearchMigrationRehearsalApplyCheckpointTarget
    | WorkspaceSearchMigrationRehearsalApplyOperationTarget
    | WorkspaceSearchMigrationRehearsalLeaseTarget,
):
  | WorkspaceSearchMigrationRehearsalPlanningPageTarget
  | WorkspaceSearchMigrationRehearsalApplyCheckpointTarget
  | WorkspaceSearchMigrationRehearsalApplyOperationTarget
  | WorkspaceSearchMigrationRehearsalLeaseTarget {
  if (target.kind === 'planning-lease') {
    return Object.freeze({ kind: target.kind })
  }
  if (target.kind === 'target') {
    return Object.freeze({
      kind: target.kind,
      pageSequence: target.pageSequence,
      cursorState: target.cursorState,
    })
  }
  if (target.kind === 'apply-checkpoint') {
    return Object.freeze({
      kind: target.kind,
      location: target.location,
      pageSequence: target.pageSequence,
      cursorState: target.cursorState,
    })
  }
  if (target.kind === 'apply-operation') {
    return Object.freeze({
      kind: target.kind,
      planSequence: target.planSequence,
      remainingOperations: target.remainingOperations,
    })
  }
  return Object.freeze({
    kind: target.kind,
    source: target.source,
    pageSequence: target.pageSequence,
    cursorState: target.cursorState,
  })
}

/** Raises one stable raw-value-free rehearsal fault error. */
function failRehearsalFault(
  code: WorkspaceSearchMigrationRehearsalFaultErrorCode,
): never {
  throw new WorkspaceSearchMigrationRehearsalFaultError(code)
}
