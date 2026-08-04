import {
  workspaceSearchMigrationSourceNames,
  type WorkspaceSearchMigrationSourceName,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationRehearsalFaultReceipt,
  type WorkspaceSearchMigrationRehearsalFailpoint,
  type WorkspaceSearchMigrationRehearsalFaultReceipt,
  type WorkspaceSearchMigrationRehearsalPlanningPageTarget,
} from './migration-rehearsal-faults'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import type {
  WorkspaceSearchMigrationCheckpointLocation,
} from './migration-state-machine'

/** Fields shared by every adapter-proven runtime fault observation. */
type WorkspaceSearchMigrationRehearsalFaultObservationBase = {
  /** First runtime fault-observation schema version. */
  readonly observationVersion: 1
  /** Exact selected runtime failpoint owning the observation. */
  readonly failpoint: WorkspaceSearchMigrationRehearsalFailpoint
  /** Stable lease identity that authorized the observed runtime work. */
  readonly leaseIdentityDigest: string
  /** Exact durable applied count at the observed boundary. */
  readonly durableAppliedOperationCount: number
  /** Exact sealed plan count, or null before a plan exists. */
  readonly sealedPlanOperationCount: number | null
}

/** Adapter-proven planning head surrounding one page commit. */
export type WorkspaceSearchMigrationRehearsalPlanningFaultObservation =
  WorkspaceSearchMigrationRehearsalFaultObservationBase & {
    /** Selects a durable planning-page head observation. */
    readonly kind: 'planning-page'
    /** Exact planning page failpoint represented by this observation. */
    readonly failpoint:
      | 'planning-page-artifact-uploaded-before-checkpoint-commit'
      | 'planning-page-transaction-response-lost'
    /** Digest of the closed writer-fence record protecting planning. */
    readonly closedWriterFenceRecordDigest: string
    /** Whether the strong read saw the predecessor or committed successor. */
    readonly durableHeadPosition: 'predecessor' | 'committed-successor'
    /** Exact durable page sequence returned by the strong head read. */
    readonly durableHeadPageSequence: number
    /** Digest of the latest committed planning evidence page. */
    readonly durableHeadEvidenceDigest: string
    /** Digest of the exact durable checkpoint without exposing its cursor. */
    readonly durableHeadCheckpointDigest: string
    /** Digest of the complete exact durable progress head. */
    readonly durableHeadProgressDigest: string
    /** Whether the durable checkpoint retained a raw continuation cursor. */
    readonly durableHeadCursorState: 'absent' | 'present'
    /** Whether the durable planning chain was already terminal. */
    readonly durableHeadCompleted: boolean
    /** Exact safe source or target page selector matched by the observation. */
    readonly planningTarget:
      WorkspaceSearchMigrationRehearsalPlanningPageTarget
  }

/** Adapter-proven apply checkpoint state surrounding one checkpoint commit. */
export type WorkspaceSearchMigrationRehearsalApplyCheckpointFaultObservation =
  WorkspaceSearchMigrationRehearsalFaultObservationBase & {
    /** Selects a durable apply checkpoint observation. */
    readonly kind: 'apply-checkpoint'
    /** Exact apply checkpoint failpoint represented by this observation. */
    readonly failpoint:
      | 'apply-checkpoint-cursor-captured-before-commit'
      | 'apply-checkpoint-cursor-committed-before-return'
    /** Digest of the closed writer-fence record protecting apply. */
    readonly closedWriterFenceRecordDigest: string
    /** Exact source or target traversal whose checkpoint was observed. */
    readonly checkpointLocation: WorkspaceSearchMigrationCheckpointLocation
    /** Whether the strong read saw the predecessor or committed successor. */
    readonly durableStatePosition: 'predecessor' | 'committed-successor'
    /** Exact optimistic revision returned by the strong state read. */
    readonly durableStateRevision: number
    /** Exact applying phase required at a nonterminal checkpoint boundary. */
    readonly durableStateStatus: 'applying'
    /** Digest of the complete exact durable run state. */
    readonly durableRunStateDigest: string
    /** Digest of the exact durable checkpoint without its raw cursor. */
    readonly durableCheckpointDigest: string
    /** Exact durable checkpoint page count at the selected location. */
    readonly durableCheckpointPageSequence: number
    /** Whether the durable checkpoint retained a raw continuation cursor. */
    readonly durableCheckpointCursorState: 'absent' | 'present'
    /** Whether the durable checkpoint was already terminal. */
    readonly durableCheckpointCompleted: boolean
  }

/** Adapter-proven strict partial apply result and subsequent strong read. */
export type WorkspaceSearchMigrationRehearsalApplyOperationFaultObservation =
  WorkspaceSearchMigrationRehearsalFaultObservationBase & {
    /** Selects a committed strict partial apply operation observation. */
    readonly kind: 'apply-operation'
    /** Fixed post-commit apply-operation failpoint. */
    readonly failpoint: 'apply-operation-committed-before-return'
    /** Digest of the closed writer-fence record protecting apply. */
    readonly closedWriterFenceRecordDigest: string
    /** Optimistic revision returned by the committed operation. */
    readonly returnedStateRevision: number
    /** Digest of the complete returned reconciled run state. */
    readonly returnedRunStateDigest: string
    /** Applied count returned by the committed operation. */
    readonly returnedAppliedOperationCount: number
    /** Sealed plan count returned by the committed operation. */
    readonly returnedSealedPlanOperationCount: number
    /** Optimistic revision independently returned by the strong reread. */
    readonly durableStateRevision: number
    /** Exact applying phase required for a strict partial prefix. */
    readonly durableStateStatus: 'applying'
    /** Digest of the complete independently reread durable run state. */
    readonly durableRunStateDigest: string
  }

/** Adapter-proven lease boundary before writer close or planning work. */
export type WorkspaceSearchMigrationRehearsalLeaseFaultObservation =
  WorkspaceSearchMigrationRehearsalFaultObservationBase & {
    /** Selects a post-acquisition lease observation. */
    readonly kind: 'lease'
    /** Fixed lease-acquired pre-heartbeat failpoint. */
    readonly failpoint: 'lease-acquired-before-first-heartbeat'
    /** Writer close has not happened at this lease boundary. */
    readonly closedWriterFenceRecordDigest: null
  }

/** Exact adapter-proven runtime state accompanying one fault receipt. */
export type WorkspaceSearchMigrationRehearsalFaultObservation =
  | WorkspaceSearchMigrationRehearsalPlanningFaultObservation
  | WorkspaceSearchMigrationRehearsalApplyCheckpointFaultObservation
  | WorkspaceSearchMigrationRehearsalApplyOperationFaultObservation
  | WorkspaceSearchMigrationRehearsalLeaseFaultObservation

/** Input for independently validating one adapter-proven fault observation. */
export type VerifyWorkspaceSearchMigrationRehearsalFaultObservationInput = {
  /** Untrusted runtime fault observation candidate. */
  readonly observation: unknown
  /** Already validated runtime receipt owning the observation. */
  readonly faultReceipt: WorkspaceSearchMigrationRehearsalFaultReceipt
  /** Independently authenticated current lease identity. */
  readonly leaseIdentityDigest: string
}

/** Stable raw-value-free failure for every fault-material trust boundary. */
export class WorkspaceSearchMigrationRehearsalStageFaultMaterialError
  extends Error {
  /** Creates the sole stable public fault-material failure. */
  constructor() {
    super('INVALID_STAGE_FAULT_MATERIAL')
    this.name = 'WorkspaceSearchMigrationRehearsalStageFaultMaterialError'
  }
}

/** Strict guards bound to the public fault-observation failure. */
const faultObservationGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failFaultObservation,
)

/** Exact keys accepted for a planning-page fault observation. */
const planningObservationKeys = Object.freeze([
  'closedWriterFenceRecordDigest',
  'durableAppliedOperationCount',
  'durableHeadCheckpointDigest',
  'durableHeadCompleted',
  'durableHeadCursorState',
  'durableHeadEvidenceDigest',
  'durableHeadPageSequence',
  'durableHeadPosition',
  'durableHeadProgressDigest',
  'failpoint',
  'kind',
  'leaseIdentityDigest',
  'observationVersion',
  'planningTarget',
  'sealedPlanOperationCount',
])

/** Exact keys accepted for an apply-checkpoint fault observation. */
const applyCheckpointObservationKeys = Object.freeze([
  'checkpointLocation',
  'closedWriterFenceRecordDigest',
  'durableAppliedOperationCount',
  'durableCheckpointCompleted',
  'durableCheckpointCursorState',
  'durableCheckpointDigest',
  'durableCheckpointPageSequence',
  'durableRunStateDigest',
  'durableStatePosition',
  'durableStateRevision',
  'durableStateStatus',
  'failpoint',
  'kind',
  'leaseIdentityDigest',
  'observationVersion',
  'sealedPlanOperationCount',
])

/** Exact keys accepted for an apply-operation fault observation. */
const applyOperationObservationKeys = Object.freeze([
  'closedWriterFenceRecordDigest',
  'durableAppliedOperationCount',
  'durableRunStateDigest',
  'durableStateRevision',
  'durableStateStatus',
  'failpoint',
  'kind',
  'leaseIdentityDigest',
  'observationVersion',
  'returnedAppliedOperationCount',
  'returnedRunStateDigest',
  'returnedSealedPlanOperationCount',
  'returnedStateRevision',
  'sealedPlanOperationCount',
])

/** Exact keys accepted for a lease fault observation. */
const leaseObservationKeys = Object.freeze([
  'closedWriterFenceRecordDigest',
  'durableAppliedOperationCount',
  'failpoint',
  'kind',
  'leaseIdentityDigest',
  'observationVersion',
  'sealedPlanOperationCount',
])

/** Exact keys accepted for a source planning target. */
const sourcePlanningTargetKeys = Object.freeze([
  'cursorState',
  'kind',
  'pageSequence',
  'source',
])

/** Exact keys accepted for a target-table planning target. */
const targetPlanningTargetKeys = Object.freeze([
  'cursorState',
  'kind',
  'pageSequence',
])

/**
 * Snapshots one secret-free fault observation using only internal invariants.
 *
 * @param value - Untrusted runtime fault observation candidate.
 * @returns Frozen detached observation with an exact finite projection.
 */
export function snapshotWorkspaceSearchMigrationRehearsalFaultObservation(
  value: unknown,
): WorkspaceSearchMigrationRehearsalFaultObservation {
  try {
    return readFaultObservation(value)
  } catch {
    return failFaultObservation()
  }
}

/**
 * Validates one adapter-proven runtime fault observation independently.
 *
 * @param input - Candidate, exact receipt, and authenticated lease identity.
 * @returns Frozen cursor-free durable runtime observation.
 */
export function verifyWorkspaceSearchMigrationRehearsalFaultObservation(
  input: VerifyWorkspaceSearchMigrationRehearsalFaultObservationInput,
): WorkspaceSearchMigrationRehearsalFaultObservation {
  try {
    const observation = readFaultObservation(input.observation)
    const receipt = parseWorkspaceSearchMigrationRehearsalFaultReceipt(
      input.faultReceipt,
    )
    const expectedLeaseIdentityDigest = faultObservationGuards.readDigest(
      input.leaseIdentityDigest,
    )
    requireReceiptMatch(
      observation,
      receipt,
      expectedLeaseIdentityDigest,
    )
    return observation
  } catch {
    return failFaultObservation()
  }
}

/** Reads one strict cursor-free adapter observation. */
function readFaultObservation(
  value: unknown,
): WorkspaceSearchMigrationRehearsalFaultObservation {
  const candidate = faultObservationGuards.requireRecord(value)
  const kind = faultObservationGuards.readOwn(candidate, 'kind')
  if (kind === 'planning-page') {
    return readPlanningFaultObservation(candidate)
  }
  if (kind === 'apply-checkpoint') {
    return readApplyCheckpointFaultObservation(candidate)
  }
  if (kind === 'apply-operation') {
    return readApplyOperationFaultObservation(candidate)
  }
  if (kind === 'lease') {
    return readLeaseFaultObservation(candidate)
  }
  return failFaultObservation()
}

/** Reads one internally consistent planning-page fault observation. */
function readPlanningFaultObservation(
  value: object,
): WorkspaceSearchMigrationRehearsalPlanningFaultObservation {
  const record = requireExactRecord(value, planningObservationKeys)
  const failpoint = readPlanningFailpoint(
    faultObservationGuards.readOwn(record, 'failpoint'),
  )
  const durableHeadPosition = failpoint ===
      'planning-page-artifact-uploaded-before-checkpoint-commit'
    ? 'predecessor'
    : 'committed-successor'
  const durableHeadPageSequence = readNonNegativeInteger(
    faultObservationGuards.readOwn(record, 'durableHeadPageSequence'),
  )
  const durableHeadCursorState = readCursorState(
    faultObservationGuards.readOwn(record, 'durableHeadCursorState'),
  )
  const durableHeadCompleted = readBoolean(
    faultObservationGuards.readOwn(record, 'durableHeadCompleted'),
  )
  const base = readFaultObservationBase(record, failpoint)
  const planningTarget = readPlanningObservationTarget(
    faultObservationGuards.readOwn(record, 'planningTarget'),
  )
  if (
    base.durableAppliedOperationCount !== 0 ||
    base.sealedPlanOperationCount !== null ||
    faultObservationGuards.readOwn(record, 'durableHeadPosition') !==
      durableHeadPosition ||
    durableHeadCompleted ||
    (durableHeadPosition === 'predecessor'
      ? durableHeadPageSequence + 1 !== planningTarget.pageSequence
      : durableHeadPageSequence !== planningTarget.pageSequence ||
        durableHeadCursorState !== 'present')
  ) return failFaultObservation()
  return Object.freeze({
    ...base,
    kind: 'planning-page',
    failpoint,
    closedWriterFenceRecordDigest: faultObservationGuards.readDigest(
      faultObservationGuards.readOwn(
        record,
        'closedWriterFenceRecordDigest',
      ),
    ),
    durableHeadPosition,
    durableHeadPageSequence,
    durableHeadEvidenceDigest: faultObservationGuards.readDigest(
      faultObservationGuards.readOwn(record, 'durableHeadEvidenceDigest'),
    ),
    durableHeadCheckpointDigest: faultObservationGuards.readDigest(
      faultObservationGuards.readOwn(record, 'durableHeadCheckpointDigest'),
    ),
    durableHeadProgressDigest: faultObservationGuards.readDigest(
      faultObservationGuards.readOwn(record, 'durableHeadProgressDigest'),
    ),
    durableHeadCursorState,
    durableHeadCompleted,
    planningTarget,
  })
}

/** Reads one internally consistent apply-checkpoint fault observation. */
function readApplyCheckpointFaultObservation(
  value: object,
): WorkspaceSearchMigrationRehearsalApplyCheckpointFaultObservation {
  const record = requireExactRecord(value, applyCheckpointObservationKeys)
  const failpoint = readApplyCheckpointFailpoint(
    faultObservationGuards.readOwn(record, 'failpoint'),
  )
  const checkpointLocation = readCheckpointLocation(
    faultObservationGuards.readOwn(record, 'checkpointLocation'),
  )
  const durableStatePosition = failpoint ===
      'apply-checkpoint-cursor-captured-before-commit'
    ? 'predecessor'
    : 'committed-successor'
  const durableCheckpointPageSequence = readNonNegativeInteger(
    faultObservationGuards.readOwn(
      record,
      'durableCheckpointPageSequence',
    ),
  )
  const durableCheckpointCursorState = readCursorState(
    faultObservationGuards.readOwn(record, 'durableCheckpointCursorState'),
  )
  const durableCheckpointCompleted = readBoolean(
    faultObservationGuards.readOwn(record, 'durableCheckpointCompleted'),
  )
  const base = readFaultObservationBase(record, failpoint)
  if (
    base.sealedPlanOperationCount === null ||
    base.sealedPlanOperationCount === 0 ||
    base.durableAppliedOperationCount !== base.sealedPlanOperationCount ||
    faultObservationGuards.readOwn(record, 'durableStatePosition') !==
      durableStatePosition ||
    faultObservationGuards.readOwn(record, 'durableStateStatus') !==
      'applying' ||
    durableCheckpointCompleted ||
    (durableStatePosition === 'committed-successor' &&
      durableCheckpointCursorState !== 'present')
  ) return failFaultObservation()
  return Object.freeze({
    ...base,
    kind: 'apply-checkpoint',
    failpoint,
    closedWriterFenceRecordDigest: faultObservationGuards.readDigest(
      faultObservationGuards.readOwn(
        record,
        'closedWriterFenceRecordDigest',
      ),
    ),
    checkpointLocation,
    durableStatePosition,
    durableStateRevision: readPositiveInteger(
      faultObservationGuards.readOwn(record, 'durableStateRevision'),
    ),
    durableStateStatus: 'applying',
    durableRunStateDigest: faultObservationGuards.readDigest(
      faultObservationGuards.readOwn(record, 'durableRunStateDigest'),
    ),
    durableCheckpointDigest: faultObservationGuards.readDigest(
      faultObservationGuards.readOwn(record, 'durableCheckpointDigest'),
    ),
    durableCheckpointPageSequence,
    durableCheckpointCursorState,
    durableCheckpointCompleted,
  })
}

/** Reads one internally consistent apply-operation fault observation. */
function readApplyOperationFaultObservation(
  value: object,
): WorkspaceSearchMigrationRehearsalApplyOperationFaultObservation {
  const record = requireExactRecord(value, applyOperationObservationKeys)
  const failpoint = faultObservationGuards.readOwn(record, 'failpoint')
  if (failpoint !== 'apply-operation-committed-before-return') {
    return failFaultObservation()
  }
  const base = readFaultObservationBase(record, failpoint)
  const returnedAppliedOperationCount = readPositiveInteger(
    faultObservationGuards.readOwn(
      record,
      'returnedAppliedOperationCount',
    ),
  )
  const returnedSealedPlanOperationCount = readPositiveInteger(
    faultObservationGuards.readOwn(
      record,
      'returnedSealedPlanOperationCount',
    ),
  )
  const returnedStateRevision = readPositiveInteger(
    faultObservationGuards.readOwn(record, 'returnedStateRevision'),
  )
  const durableStateRevision = readPositiveInteger(
    faultObservationGuards.readOwn(record, 'durableStateRevision'),
  )
  const returnedRunStateDigest = faultObservationGuards.readDigest(
    faultObservationGuards.readOwn(record, 'returnedRunStateDigest'),
  )
  const durableRunStateDigest = faultObservationGuards.readDigest(
    faultObservationGuards.readOwn(record, 'durableRunStateDigest'),
  )
  if (
    base.sealedPlanOperationCount === null ||
    base.durableAppliedOperationCount <= 0 ||
    base.durableAppliedOperationCount >= base.sealedPlanOperationCount ||
    returnedAppliedOperationCount !== base.durableAppliedOperationCount ||
    returnedSealedPlanOperationCount !== base.sealedPlanOperationCount ||
    returnedStateRevision !== durableStateRevision ||
    returnedRunStateDigest !== durableRunStateDigest ||
    faultObservationGuards.readOwn(record, 'durableStateStatus') !==
      'applying'
  ) return failFaultObservation()
  return Object.freeze({
    ...base,
    kind: 'apply-operation',
    failpoint,
    closedWriterFenceRecordDigest: faultObservationGuards.readDigest(
      faultObservationGuards.readOwn(
        record,
        'closedWriterFenceRecordDigest',
      ),
    ),
    returnedStateRevision,
    returnedRunStateDigest,
    returnedAppliedOperationCount,
    returnedSealedPlanOperationCount,
    durableStateRevision,
    durableStateStatus: 'applying',
    durableRunStateDigest,
  })
}

/** Reads one internally consistent lease fault observation. */
function readLeaseFaultObservation(
  value: object,
): WorkspaceSearchMigrationRehearsalLeaseFaultObservation {
  const record = requireExactRecord(value, leaseObservationKeys)
  const failpoint = faultObservationGuards.readOwn(record, 'failpoint')
  if (failpoint !== 'lease-acquired-before-first-heartbeat') {
    return failFaultObservation()
  }
  const base = readFaultObservationBase(record, failpoint)
  if (
    base.durableAppliedOperationCount !== 0 ||
    base.sealedPlanOperationCount !== null ||
    faultObservationGuards.readOwn(
      record,
      'closedWriterFenceRecordDigest',
    ) !== null
  ) return failFaultObservation()
  return Object.freeze({
    ...base,
    kind: 'lease',
    failpoint,
    closedWriterFenceRecordDigest: null,
  })
}

/** Reads fields shared by every runtime fault observation. */
function readFaultObservationBase(
  record: object,
  failpoint: WorkspaceSearchMigrationRehearsalFailpoint,
): WorkspaceSearchMigrationRehearsalFaultObservationBase {
  const leaseIdentityDigest = faultObservationGuards.readDigest(
    faultObservationGuards.readOwn(record, 'leaseIdentityDigest'),
  )
  const durableAppliedOperationCount = readNonNegativeInteger(
    faultObservationGuards.readOwn(
      record,
      'durableAppliedOperationCount',
    ),
  )
  const sealedPlanOperationCount = readNullablePositiveInteger(
    faultObservationGuards.readOwn(record, 'sealedPlanOperationCount'),
  )
  if (
    faultObservationGuards.readOwn(record, 'observationVersion') !== 1 ||
    faultObservationGuards.readOwn(record, 'failpoint') !== failpoint
  ) return failFaultObservation()
  return Object.freeze({
    observationVersion: 1,
    failpoint,
    leaseIdentityDigest,
    durableAppliedOperationCount,
    sealedPlanOperationCount,
  })
}

/** Reads one strict safe planning page target. */
function readPlanningObservationTarget(
  value: unknown,
): WorkspaceSearchMigrationRehearsalPlanningPageTarget {
  const candidate = faultObservationGuards.requireRecord(value)
  const kind = faultObservationGuards.readOwn(candidate, 'kind')
  if (kind === 'source') {
    const record = requireExactRecord(candidate, sourcePlanningTargetKeys)
    const target: WorkspaceSearchMigrationRehearsalPlanningPageTarget = {
      kind,
      source: readSourceName(
        faultObservationGuards.readOwn(record, 'source'),
      ),
      pageSequence: readPositiveInteger(
        faultObservationGuards.readOwn(record, 'pageSequence'),
      ),
      cursorState: readPresentCursorState(
        faultObservationGuards.readOwn(record, 'cursorState'),
      ),
    }
    return Object.freeze(target)
  }
  if (kind === 'target') {
    const record = requireExactRecord(candidate, targetPlanningTargetKeys)
    const target: WorkspaceSearchMigrationRehearsalPlanningPageTarget = {
      kind,
      pageSequence: readPositiveInteger(
        faultObservationGuards.readOwn(record, 'pageSequence'),
      ),
      cursorState: readPresentCursorState(
        faultObservationGuards.readOwn(record, 'cursorState'),
      ),
    }
    return Object.freeze(target)
  }
  return failFaultObservation()
}

/** Requires an observation to match its receipt and authenticated lease. */
function requireReceiptMatch(
  observation: WorkspaceSearchMigrationRehearsalFaultObservation,
  receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
  expectedLeaseIdentityDigest: string,
): void {
  if (
    observation.failpoint !== receipt.failpoint ||
    observation.leaseIdentityDigest !== expectedLeaseIdentityDigest
  ) return failFaultObservation()
  if (observation.kind === 'planning-page') {
    return requirePlanningReceiptMatch(observation, receipt)
  }
  if (observation.kind === 'apply-checkpoint') {
    return requireApplyCheckpointReceiptMatch(observation, receipt)
  }
  if (observation.kind === 'apply-operation') {
    return requireApplyOperationReceiptMatch(observation, receipt)
  }
  if (receipt.target.kind !== 'planning-lease') {
    return failFaultObservation()
  }
}

/** Requires one planning observation to match its exact receipt target. */
function requirePlanningReceiptMatch(
  observation: WorkspaceSearchMigrationRehearsalPlanningFaultObservation,
  receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
): void {
  const target = receipt.target
  const observedTarget = observation.planningTarget
  if (
    (target.kind !== 'source' && target.kind !== 'target') ||
    observedTarget.kind !== target.kind ||
    observedTarget.pageSequence !== target.pageSequence ||
    (target.kind === 'source' &&
      (observedTarget.kind !== 'source' ||
        observedTarget.source !== target.source))
  ) return failFaultObservation()
}

/** Requires one apply-checkpoint observation to match its receipt target. */
function requireApplyCheckpointReceiptMatch(
  observation:
    WorkspaceSearchMigrationRehearsalApplyCheckpointFaultObservation,
  receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
): void {
  const target = receipt.target
  if (
    target.kind !== 'apply-checkpoint' ||
    observation.checkpointLocation !== target.location ||
    (observation.durableStatePosition === 'predecessor'
      ? observation.durableCheckpointPageSequence + 1 !==
        target.pageSequence
      : observation.durableCheckpointPageSequence !== target.pageSequence ||
        observation.durableCheckpointCursorState !== 'present')
  ) return failFaultObservation()
}

/** Requires one apply-operation observation to match its receipt target. */
function requireApplyOperationReceiptMatch(
  observation:
    WorkspaceSearchMigrationRehearsalApplyOperationFaultObservation,
  receipt: WorkspaceSearchMigrationRehearsalFaultReceipt,
): void {
  if (
    receipt.target.kind !== 'apply-operation' ||
    observation.durableAppliedOperationCount !==
      receipt.target.planSequence
  ) return failFaultObservation()
}

/** Reads one planning-page failpoint. */
function readPlanningFailpoint(
  value: unknown,
): WorkspaceSearchMigrationRehearsalPlanningFaultObservation['failpoint'] {
  if (
    value !==
      'planning-page-artifact-uploaded-before-checkpoint-commit' &&
    value !== 'planning-page-transaction-response-lost'
  ) return failFaultObservation()
  return value
}

/** Reads one apply-checkpoint failpoint. */
function readApplyCheckpointFailpoint(
  value: unknown,
): WorkspaceSearchMigrationRehearsalApplyCheckpointFaultObservation[
  'failpoint'
] {
  if (
    value !== 'apply-checkpoint-cursor-captured-before-commit' &&
    value !== 'apply-checkpoint-cursor-committed-before-return'
  ) return failFaultObservation()
  return value
}

/** Reads one exact finite checkpoint location. */
function readCheckpointLocation(
  value: unknown,
): WorkspaceSearchMigrationCheckpointLocation {
  if (value === 'target') return value
  return readSourceName(value)
}

/** Reads one exact finite source name. */
function readSourceName(
  value: unknown,
): WorkspaceSearchMigrationSourceName {
  for (const source of workspaceSearchMigrationSourceNames) {
    if (value === source) return source
  }
  return failFaultObservation()
}

/** Requires one ordinary exact-key data record. */
function requireExactRecord(
  value: unknown,
  keys: readonly string[],
): object {
  const record = faultObservationGuards.requireRecord(value)
  const prototype = Object.getPrototypeOf(record)
  if (prototype !== Object.prototype && prototype !== null) {
    return failFaultObservation()
  }
  faultObservationGuards.requireExactKeys(record, keys)
  return record
}

/** Reads one positive safe integer. */
function readPositiveInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) return failFaultObservation()
  return value
}

/** Reads one non-negative safe integer. */
function readNonNegativeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return failFaultObservation()
  return value
}

/** Reads one exact boolean scalar. */
function readBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return failFaultObservation()
  return value
}

/** Reads one exact cursor-presence classification. */
function readCursorState(value: unknown): 'absent' | 'present' {
  if (value !== 'absent' && value !== 'present') {
    return failFaultObservation()
  }
  return value
}

/** Reads the only cursor state valid in a selected page target. */
function readPresentCursorState(value: unknown): 'present' {
  if (value !== 'present') return failFaultObservation()
  return value
}

/** Reads one nullable positive safe integer. */
function readNullablePositiveInteger(value: unknown): number | null {
  return value === null ? null : readPositiveInteger(value)
}

/** Raises the stable raw-value-free fault-observation failure. */
function failFaultObservation(): never {
  throw new WorkspaceSearchMigrationRehearsalStageFaultMaterialError()
}
