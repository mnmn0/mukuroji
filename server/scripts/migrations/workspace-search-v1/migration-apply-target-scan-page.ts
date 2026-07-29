import { types as nodeUtilTypes } from 'node:util'
import {
  isHexDigest,
  MigrationDigestAccumulator,
  type MigrationDigestState,
  type MigrationSourceCheckpoint,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
} from './migration-contract'
import {
  prepareWorkspaceSearchMigrationTargetScanContext,
  type WorkspaceSearchMigrationTargetScanCheckpoint,
  validateWorkspaceSearchMigrationTargetScanCheckpoint,
} from './migration-target-scan-context'
import type {
  WorkspaceSearchMigrationTargetScanPageResult,
} from './migration-target-scan-page'
import {
  validateWorkspaceSearchMigrationCheckpoint,
} from './migration-state-machine'
import { hasCanonicalDenseArrayShape } from './migration-value-guards'

/**
 * Input for translating apply traversal progress into the target scanner's
 * configuration-bound predecessor.
 */
export type CreateWorkspaceSearchMigrationApplyTargetScanPredecessorInput = {
  /** Complete measured configuration that owns the apply traversal. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Previously committed state-machine target checkpoint. */
  readonly previousCheckpoint: MigrationSourceCheckpoint
}

/**
 * Input for reducing one already classified target Scan page into apply
 * traversal progress.
 */
export type ReduceWorkspaceSearchMigrationApplyTargetScanPageInput = {
  /** Complete measured configuration that owns the apply traversal. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Previously committed state-machine target checkpoint. */
  readonly previousCheckpoint: MigrationSourceCheckpoint
  /** Exact one-page result produced by the existing strong target scanner. */
  readonly pageResult: WorkspaceSearchMigrationTargetScanPageResult
}

/**
 * State-machine-compatible result of one post-apply target Scan page.
 */
export type WorkspaceSearchMigrationApplyTargetScanPageResult = {
  /**
   * Cumulative target checkpoint after exactly one strongly consistent page.
   *
   * Every valid migration-owned row is an expected present target state, so it
   * contributes to both `mapped` and `projected`. Recognized unowned rows and
   * invalid rows contribute only to their matching counters. `deleted` is
   * always zero because an absent post-apply target row cannot appear in Scan
   * output. An operation that was already current is still an owned expected
   * state rather than a distinct scan no-op classification.
   */
  readonly checkpoint: MigrationSourceCheckpoint
}

/**
 * Failure codes deliberately emitted by the apply target-page boundary.
 */
type ApplyTargetScanPageFailureCode =
  | 'AMBIGUOUS_OPERATION_UNRESOLVED'
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_STATE'
  | 'TABLE_SCHEMA_MISMATCH'

/**
 * Privately branded failure that hostile caller values cannot forge.
 */
class ApplyTargetScanPageFailure extends Error {
  /** Stable operator-safe code selected by trusted conversion logic. */
  readonly code: ApplyTargetScanPageFailureCode

  /**
   * Creates one private fixed-code apply target Scan failure.
   *
   * @param code - Stable code selected by trusted conversion logic.
   */
  constructor(code: ApplyTargetScanPageFailureCode) {
    super(code)
    this.name = 'ApplyTargetScanPageFailure'
    this.code = code
  }
}

/**
 * Resource budget for inspecting one caller-owned data graph.
 */
type ApplyTargetScanGraphBudget = {
  /** Number of ordinary object and array nodes already inspected. */
  nodes: number
  /** Objects on the current traversal path, used to reject cycles. */
  active: WeakSet<object>
  /** Fully inspected aliases that need not be traversed twice. */
  visited: WeakSet<object>
}

const maximumApplyTargetScanGraphNodes = 4_096

/**
 * Converts a state-machine apply target checkpoint into the exact predecessor
 * accepted by the existing managed target scanner.
 *
 * The conversion deliberately adds the reviewed configuration hash without
 * changing counters or digest state. Apply target checkpoints must already
 * satisfy `projected === mapped` and `deleted === 0`; otherwise they cannot be
 * represented by the target scanner's `owned` counter.
 *
 * @param input - Measured configuration and durable apply predecessor.
 * @returns Detached configuration-bound target Scan predecessor.
 */
export function createWorkspaceSearchMigrationApplyTargetScanPredecessor(
  input: CreateWorkspaceSearchMigrationApplyTargetScanPredecessorInput,
): WorkspaceSearchMigrationTargetScanCheckpoint {
  return runApplyTargetScanPageBoundary(() => {
    const detached = detachApplyTargetScanGraph(input)
    requireExactOwnDataKeys(detached, [
      'configuration',
      'configurationHash',
      'previousCheckpoint',
    ])
    return createApplyTargetScanPredecessorUnchecked(detached)
  })
}

/**
 * Reduces one existing target scanner result into a state-machine apply target
 * checkpoint.
 *
 * This function performs no I/O. The supplied page result must come from one
 * strongly consistent, bounded target Scan performed under the writer fence.
 * The existing target reducer owns raw-page validation and classification;
 * this boundary only proves that its result is the exact one-page successor of
 * the durable apply predecessor and translates target semantics.
 *
 * An empty terminal page is a real one-page transition that completes the
 * traversal. An empty nonterminal page, an unchanged checkpoint, or any
 * transition consuming other than exactly one page is rejected.
 *
 * @param input - Measured configuration, predecessor, and target page result.
 * @returns Detached cumulative state-machine checkpoint.
 */
export function reduceWorkspaceSearchMigrationApplyTargetScanPage(
  input: ReduceWorkspaceSearchMigrationApplyTargetScanPageInput,
): WorkspaceSearchMigrationApplyTargetScanPageResult {
  return runApplyTargetScanPageBoundary(() => {
    const detached = detachApplyTargetScanGraph(input)
    requireExactOwnDataKeys(detached, [
      'configuration',
      'configurationHash',
      'pageResult',
      'previousCheckpoint',
    ])
    const targetPredecessor = createApplyTargetScanPredecessorUnchecked({
      configuration: detached.configuration,
      configurationHash: detached.configurationHash,
      previousCheckpoint: detached.previousCheckpoint,
    })
    requireTargetPageResultShape(detached.pageResult)
    const targetCheckpoint = detached.pageResult.checkpoint
    if (targetCheckpoint.configurationHash !== detached.configurationHash) {
      return failApplyTargetScanPage('CONFIGURATION_HASH_MISMATCH')
    }
    try {
      validateWorkspaceSearchMigrationTargetScanCheckpoint(
        targetCheckpoint,
        targetPredecessor,
      )
    } catch {
      return failApplyTargetScanPage('INVALID_STATE')
    }
    validateTargetPageEvidence(
      detached.pageResult,
      targetPredecessor,
    )

    const checkpoint = convertTargetCheckpoint(targetCheckpoint)
    try {
      validateWorkspaceSearchMigrationCheckpoint(
        checkpoint,
        detached.previousCheckpoint,
      )
    } catch {
      return failApplyTargetScanPage('INVALID_STATE')
    }
    return { checkpoint }
  })
}

/**
 * Creates one target-scanner predecessor after the public graph boundary.
 *
 * @param input - Detached measured configuration and apply predecessor.
 * @returns Validated target-scanner predecessor.
 */
function createApplyTargetScanPredecessorUnchecked(
  input: CreateWorkspaceSearchMigrationApplyTargetScanPredecessorInput,
): WorkspaceSearchMigrationTargetScanCheckpoint {
  requireMigrationCheckpointShape(input.previousCheckpoint)
  try {
    validateWorkspaceSearchMigrationCheckpoint(input.previousCheckpoint)
  } catch {
    return failApplyTargetScanPage('INVALID_STATE')
  }
  if (
    input.previousCheckpoint.aggregate.projected !==
      input.previousCheckpoint.aggregate.mapped ||
    input.previousCheckpoint.aggregate.deleted !== 0
  ) {
    return failApplyTargetScanPage('INVALID_STATE')
  }

  const candidate = convertApplyCheckpoint(
    input.configurationHash,
    input.previousCheckpoint,
  )
  const preflight = prepareWorkspaceSearchMigrationTargetScanContext({
    configuration: input.configuration,
    configurationHash: input.configurationHash,
    previousCheckpoint: candidate,
  })
  if (!preflight.ok) {
    return failApplyTargetScanPage(preflight.code)
  }
  return preflight.context.previousCheckpoint
}

/**
 * Converts state-machine target semantics to the planning target classifier's
 * equivalent cumulative checkpoint.
 *
 * @param configurationHash - Reviewed measured configuration digest.
 * @param checkpoint - Validated apply target predecessor.
 * @returns Configuration-bound target scanner predecessor.
 */
function convertApplyCheckpoint(
  configurationHash: string,
  checkpoint: MigrationSourceCheckpoint,
): WorkspaceSearchMigrationTargetScanCheckpoint {
  return {
    configurationHash,
    completed: checkpoint.completed,
    ...(checkpoint.cursor === undefined
      ? {}
      : { cursor: checkpoint.cursor }),
    aggregate: {
      scanned: checkpoint.aggregate.scanned,
      owned: checkpoint.aggregate.mapped,
      ignored: checkpoint.aggregate.ignored,
      invalid: checkpoint.aggregate.invalid,
      keyDigest: checkpoint.aggregate.keyDigest,
      contentDigest: checkpoint.aggregate.contentDigest,
      pageCount: checkpoint.aggregate.pageCount,
    },
    keyDigestState: checkpoint.keyDigestState,
    contentDigestState: checkpoint.contentDigestState,
  }
}

/**
 * Converts one target scanner checkpoint to post-apply target semantics.
 *
 * @param checkpoint - Validated one-page target scanner successor.
 * @returns State-machine-compatible post-apply target checkpoint.
 */
function convertTargetCheckpoint(
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
): MigrationSourceCheckpoint {
  return {
    completed: checkpoint.completed,
    ...(checkpoint.cursor === undefined
      ? {}
      : { cursor: checkpoint.cursor }),
    aggregate: {
      scanned: checkpoint.aggregate.scanned,
      mapped: checkpoint.aggregate.owned,
      ignored: checkpoint.aggregate.ignored,
      invalid: checkpoint.aggregate.invalid,
      projected: checkpoint.aggregate.owned,
      deleted: 0,
      keyDigest: checkpoint.aggregate.keyDigest,
      contentDigest: checkpoint.aggregate.contentDigest,
      pageCount: checkpoint.aggregate.pageCount,
    },
    keyDigestState: checkpoint.keyDigestState,
    contentDigestState: checkpoint.contentDigestState,
  }
}

/**
 * Validates exact page evidence against the predecessor and successor digest
 * states emitted by the existing target reducer.
 *
 * @param pageResult - Detached existing target reducer result.
 * @param previous - Exact target-scanner predecessor.
 */
function validateTargetPageEvidence(
  pageResult: WorkspaceSearchMigrationTargetScanPageResult,
  previous: WorkspaceSearchMigrationTargetScanCheckpoint,
): void {
  const checkpoint = pageResult.checkpoint
  const scannedDelta =
    checkpoint.aggregate.scanned - previous.aggregate.scanned
  const ownedDelta =
    checkpoint.aggregate.owned - previous.aggregate.owned
  const ignoredDelta =
    checkpoint.aggregate.ignored - previous.aggregate.ignored
  const invalidDelta =
    checkpoint.aggregate.invalid - previous.aggregate.invalid
  if (
    scannedDelta < 0 ||
    scannedDelta > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE ||
    ownedDelta < 0 ||
    ignoredDelta < 0 ||
    invalidDelta < 0 ||
    ownedDelta + ignoredDelta + invalidDelta !== scannedDelta ||
    (scannedDelta === 0 && !checkpoint.completed)
  ) {
    return failApplyTargetScanPage('INVALID_STATE')
  }
  if (
    pageResult.targetRows.length + pageResult.invalidRows.length !==
      scannedDelta
  ) {
    return failApplyTargetScanPage('INVALID_STATE')
  }

  const keyAccumulator = MigrationDigestAccumulator.fromState(
    previous.keyDigestState,
  )
  const contentAccumulator = MigrationDigestAccumulator.fromState(
    previous.contentDigestState,
  )
  const pageKeyDigests = new Set<string>()
  const expectedObservedBindings: {
    /** Digest of one migration-owned target key. */
    readonly targetKeyDigest: string
    /** Digest of the exact owned target row. */
    readonly targetItemDigest: string
  }[] = []
  let observedOwned = 0
  let observedIgnored = 0

  for (const row of pageResult.targetRows) {
    requireExactOwnDataKeys(row, [
      'classification',
      'targetItemDigest',
      'targetKeyDigest',
    ])
    requireTargetEvidenceDigests(
      row.targetKeyDigest,
      row.targetItemDigest,
      pageKeyDigests,
      keyAccumulator,
      contentAccumulator,
    )
    if (row.classification === 'owned') {
      observedOwned += 1
      expectedObservedBindings.push({
        targetKeyDigest: row.targetKeyDigest,
        targetItemDigest: row.targetItemDigest,
      })
    } else if (row.classification === 'ignored') {
      observedIgnored += 1
    } else {
      return failApplyTargetScanPage('INVALID_STATE')
    }
  }

  for (const row of pageResult.invalidRows) {
    requireExactOwnDataKeys(row, [
      'classification',
      'reasonCode',
      'targetItemDigest',
      'targetKeyDigest',
    ])
    if (
      row.classification !== 'invalid' ||
      row.reasonCode !== 'INVALID_TARGET_ROW'
    ) {
      return failApplyTargetScanPage('INVALID_STATE')
    }
    requireTargetEvidenceDigests(
      row.targetKeyDigest,
      row.targetItemDigest,
      pageKeyDigests,
      keyAccumulator,
      contentAccumulator,
    )
  }

  if (
    observedOwned !== ownedDelta ||
    observedIgnored !== ignoredDelta ||
    pageResult.invalidRows.length !== invalidDelta ||
    pageResult.observedTargetBindings.length !==
      expectedObservedBindings.length
  ) {
    return failApplyTargetScanPage('INVALID_STATE')
  }
  for (
    let index = 0;
    index < expectedObservedBindings.length;
    index += 1
  ) {
    const actual = pageResult.observedTargetBindings[index]
    const expected = expectedObservedBindings[index]
    if (actual === undefined || expected === undefined) {
      return failApplyTargetScanPage('INVALID_STATE')
    }
    requireExactOwnDataKeys(actual, [
      'targetItemDigest',
      'targetKeyDigest',
    ])
    if (
      actual.targetKeyDigest !== expected.targetKeyDigest ||
      actual.targetItemDigest !== expected.targetItemDigest
    ) {
      return failApplyTargetScanPage('INVALID_STATE')
    }
  }
  if (
    !sameDigestState(
      keyAccumulator.exportState(),
      checkpoint.keyDigestState,
    ) ||
    !sameDigestState(
      contentAccumulator.exportState(),
      checkpoint.contentDigestState,
    )
  ) {
    return failApplyTargetScanPage('INVALID_STATE')
  }
}

/**
 * Adds one strict row-evidence pair to the reconstructed page accumulators.
 *
 * @param keyDigest - Exact physical target-key digest.
 * @param itemDigest - Exact full target-row digest.
 * @param pageKeyDigests - Target keys already observed in this page result.
 * @param keyAccumulator - Restored cumulative key accumulator.
 * @param contentAccumulator - Restored cumulative content accumulator.
 */
function requireTargetEvidenceDigests(
  keyDigest: string,
  itemDigest: string,
  pageKeyDigests: Set<string>,
  keyAccumulator: MigrationDigestAccumulator,
  contentAccumulator: MigrationDigestAccumulator,
): void {
  if (!isHexDigest(keyDigest) || !isHexDigest(itemDigest)) {
    return failApplyTargetScanPage('INVALID_STATE')
  }
  if (pageKeyDigests.has(keyDigest)) {
    return failApplyTargetScanPage('AMBIGUOUS_OPERATION_UNRESOLVED')
  }
  pageKeyDigests.add(keyDigest)
  keyAccumulator.add(keyDigest)
  contentAccumulator.add(itemDigest)
}

/**
 * Checks exact equality of two restorable digest states.
 *
 * @param left - First digest state.
 * @param right - Second digest state.
 * @returns Whether count, modular sum, and XOR all match.
 */
function sameDigestState(
  left: MigrationDigestState,
  right: MigrationDigestState,
): boolean {
  return left.count === right.count &&
    left.sumHex === right.sumHex &&
    left.xorHex === right.xorHex
}

/**
 * Requires the exact structural keys of one target reducer result.
 *
 * @param pageResult - Detached target reducer result.
 */
function requireTargetPageResultShape(
  pageResult: WorkspaceSearchMigrationTargetScanPageResult,
): void {
  requireExactOwnDataKeys(pageResult, [
    'checkpoint',
    'invalidRows',
    'observedTargetBindings',
    'targetRows',
  ])
  requireTargetCheckpointShape(pageResult.checkpoint)
  if (
    !hasCanonicalDenseArrayShape(pageResult.targetRows) ||
    !hasCanonicalDenseArrayShape(pageResult.invalidRows) ||
    !hasCanonicalDenseArrayShape(pageResult.observedTargetBindings)
  ) {
    return failApplyTargetScanPage('INVALID_STATE')
  }
}

/**
 * Requires the exact structural keys of one target-scanner checkpoint.
 *
 * @param checkpoint - Detached target checkpoint.
 */
function requireTargetCheckpointShape(
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
): void {
  requireExactOwnDataKeys(
    checkpoint,
    checkpoint.cursor === undefined
      ? [
          'aggregate',
          'completed',
          'configurationHash',
          'contentDigestState',
          'keyDigestState',
        ]
      : [
          'aggregate',
          'completed',
          'configurationHash',
          'contentDigestState',
          'cursor',
          'keyDigestState',
        ],
  )
  requireExactOwnDataKeys(checkpoint.aggregate, [
    'contentDigest',
    'ignored',
    'invalid',
    'keyDigest',
    'owned',
    'pageCount',
    'scanned',
  ])
  requireDigestStateShape(checkpoint.keyDigestState)
  requireDigestStateShape(checkpoint.contentDigestState)
}

/**
 * Requires the exact structural keys of one state-machine checkpoint.
 *
 * @param checkpoint - Detached apply target checkpoint.
 */
function requireMigrationCheckpointShape(
  checkpoint: MigrationSourceCheckpoint,
): void {
  requireExactOwnDataKeys(
    checkpoint,
    checkpoint.cursor === undefined
      ? [
          'aggregate',
          'completed',
          'contentDigestState',
          'keyDigestState',
        ]
      : [
          'aggregate',
          'completed',
          'contentDigestState',
          'cursor',
          'keyDigestState',
        ],
  )
  requireExactOwnDataKeys(checkpoint.aggregate, [
    'contentDigest',
    'deleted',
    'ignored',
    'invalid',
    'keyDigest',
    'mapped',
    'pageCount',
    'projected',
    'scanned',
  ])
  requireDigestStateShape(checkpoint.keyDigestState)
  requireDigestStateShape(checkpoint.contentDigestState)
}

/**
 * Requires the exact structural keys of one accumulator state.
 *
 * @param state - Detached restorable digest state.
 */
function requireDigestStateShape(state: MigrationDigestState): void {
  requireExactOwnDataKeys(state, ['count', 'sumHex', 'xorHex'])
}

/**
 * Requires an ordinary object to contain exactly the expected enumerable data
 * properties.
 *
 * @param value - Detached object being checked.
 * @param expected - Complete expected own-string-key set.
 */
function requireExactOwnDataKeys(
  value: object,
  expected: readonly string[],
): void {
  const actual = Reflect.ownKeys(value)
  if (
    actual.length !== expected.length ||
    actual.some((key) =>
      typeof key !== 'string' || !expected.includes(key)
    )
  ) {
    return failApplyTargetScanPage('INVALID_STATE')
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failApplyTargetScanPage('INVALID_STATE')
    }
  }
}

/**
 * Copies a caller-owned graph after proving it contains no active behavior.
 *
 * @param value - Caller-owned typed graph.
 * @returns Detached graph of the same static type.
 */
function detachApplyTargetScanGraph<Value>(value: Value): Value {
  inspectApplyTargetScanGraph(value, {
    nodes: 0,
    active: new WeakSet<object>(),
    visited: new WeakSet<object>(),
  })
  return structuredClone(value)
}

/**
 * Proves one bounded graph contains only ordinary data objects and dense
 * arrays, rejecting proxies, accessors, symbols, cycles, and exotic objects.
 *
 * @param value - Current graph value.
 * @param budget - Shared graph traversal budget.
 */
function inspectApplyTargetScanGraph(
  value: unknown,
  budget: ApplyTargetScanGraphBudget,
): void {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return failApplyTargetScanPage('INVALID_STATE')
    }
    return
  }
  if (
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value) ||
    budget.active.has(value)
  ) {
    return failApplyTargetScanPage('INVALID_STATE')
  }
  if (budget.visited.has(value)) return
  budget.nodes += 1
  if (budget.nodes > maximumApplyTargetScanGraphNodes) {
    return failApplyTargetScanPage('INVALID_STATE')
  }
  budget.active.add(value)
  if (Array.isArray(value)) {
    if (!hasCanonicalDenseArrayShape(value)) {
      return failApplyTargetScanPage('INVALID_STATE')
    }
    for (const candidate of value) {
      inspectApplyTargetScanGraph(candidate, budget)
    }
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return failApplyTargetScanPage('INVALID_STATE')
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        return failApplyTargetScanPage('INVALID_STATE')
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        return failApplyTargetScanPage('INVALID_STATE')
      }
      inspectApplyTargetScanGraph(descriptor.value, budget)
    }
  }
  budget.active.delete(value)
  budget.visited.add(value)
}

/**
 * Runs one public conversion behind a fixed raw-error replacement boundary.
 *
 * @param operation - Pure conversion that may inspect hostile runtime values.
 * @returns Exact conversion result.
 */
function runApplyTargetScanPageBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    const code = readApplyTargetScanPageFailureCode(error)
    throw new WorkspaceSearchMigrationFailure(
      code,
      `Workspace Search apply target Scan page stopped safely (${code}).`,
    )
  }
}

/**
 * Reads only a privately constructed apply target Scan failure code.
 *
 * @param error - Arbitrary value thrown inside the public boundary.
 * @returns Trusted private code or the fail-closed default.
 */
function readApplyTargetScanPageFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    return error instanceof ApplyTargetScanPageFailure
      ? error.code
      : 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Raises one private fixed-code apply target Scan failure.
 *
 * @param code - Stable trusted conversion failure code.
 * @returns Never returns.
 */
function failApplyTargetScanPage(
  code: ApplyTargetScanPageFailureCode,
): never {
  throw new ApplyTargetScanPageFailure(code)
}
