import { types as nodeUtilTypes } from 'node:util'
import {
  QueryCommand,
  type AttributeValue,
  type QueryCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  calculateDynamoDbItemSize,
  DYNAMODB_MAX_ITEM_SIZE_BYTES,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  MigrationDigestAccumulator,
  type WorkspaceSearchOperationMarker,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationApplyAuditBindingInput,
  WorkspaceSearchMigrationApplyAuthorityAuditRecord,
  WorkspaceSearchMigrationApplyMarkerAuditRecord,
} from './migration-apply-operation-aws'
import type {
  WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt,
} from './migration-execution-authority-adoption'
import type {
  WorkspaceSearchMigrationRehearsalReconciliationAuthorityCollectorResult,
  WorkspaceSearchMigrationRehearsalReconciliationMarkerCollectorResult,
} from './migration-rehearsal-reconciliation-audit'

/** Maximum state-table Query pages accepted across both reconciliation sets. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_PAGES =
  10_000

/** Maximum state-table rows inspected across both reconciliation sets. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_ITEMS =
  100_000

/** Maximum cumulative low-level DynamoDB item bytes retained by one audit. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_BYTES =
  256 * 1_024 * 1_024

/** Maximum wall-clock duration accepted for one complete Query collection. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_DURATION_MILLISECONDS =
  15 * 60 * 1_000

/** Maximum deadline accepted for one terminal, incarnation, or Query request. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_REQUEST_TIMEOUT_MILLISECONDS =
  30_000

/** Stable operation-marker sort-key prefix written by the v1 apply adapter. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX =
  'apply-operation/v1/'

/** Stable authority-adoption sort-key prefix written by the v1 apply adapter. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_AUTHORITY_ADOPTION_KEY_PREFIX =
  'execution-authority-adoption/v1/'

/** Stable raw-value-free AWS reconciliation failure categories. */
export type WorkspaceSearchMigrationRehearsalReconciliationAwsErrorCode =
  | 'ABORTED'
  | 'IDENTITY_DRIFT'
  | 'INVALID_ARGUMENT'
  | 'INVALID_RESPONSE'
  | 'LIMIT_EXCEEDED'
  | 'QUERY_FAILED'
  | 'TIMEOUT'

/** Stable raw-value-free failure raised by the read-only AWS collector. */
export class WorkspaceSearchMigrationRehearsalReconciliationAwsError
  extends Error {
  /** Machine-readable failure category without raw AWS or rehearsal values. */
  readonly code:
    WorkspaceSearchMigrationRehearsalReconciliationAwsErrorCode

  /**
   * Creates one bounded collector failure.
   *
   * @param code - Stable raw-value-free failure category.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalReconciliationAwsErrorCode,
  ) {
    super(code)
    this.name =
      'WorkspaceSearchMigrationRehearsalReconciliationAwsError'
    this.code = code
  }
}

/** Exact immutable terminal identity guarded around every Query page. */
export type WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding = {
  /** Digest of the measured six-table configuration and resource generation. */
  readonly configurationBindingDigest: string
  /** Digest of the immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Merkle root of the exact ordered immutable plan. */
  readonly planDigest: string
  /** Digest of the complete applied root or committed-prefix origin. */
  readonly applyBoundaryDigest: string
  /** Authoritative immutable terminal-root classification. */
  readonly terminalRootKind: 'rolled-back' | 'verified'
  /** Persistence version of the authoritative immutable terminal root. */
  readonly terminalRootVersion: 1 | 2
  /** Digest of the complete authoritative immutable terminal root. */
  readonly terminalRootDigest: string
  /** Exact operation count fixed by the sealed plan. */
  readonly sealedPlanOperationCount: number
  /** Exact complete or committed-prefix operation count applied before terminal. */
  readonly appliedOperationCount: number
  /** Canonical publication time of the authoritative terminal root. */
  readonly terminalAt: string
}

/** One plan operation expected to own exactly one durable marker. */
export type WorkspaceSearchMigrationRehearsalExpectedMarker = {
  /** Stable operation identity fixed by the replayed immutable plan. */
  readonly operationId: string
  /** One-based immutable plan position. */
  readonly planSequence: number
  /** Digest of the exact immutable planned operation. */
  readonly planOperationDigest: string
}

/** One immutable authority-adoption receipt expected in the terminal chain. */
export type WorkspaceSearchMigrationRehearsalExpectedAuthority = {
  /** Cumulative one-based renewal position fixed by durable execution state. */
  readonly maintenanceEvidenceRenewalCount: number
  /** Digest of the exact immutable authority-adoption receipt. */
  readonly receiptDigest: string
}

/** Strict durable marker projection returned only by the writer-owned codec. */
export type WorkspaceSearchMigrationRehearsalDurableMarkerProjection = {
  /** Exact strictly parsed no-op or mutation marker. */
  readonly marker: WorkspaceSearchOperationMarker
  /** Revision condition-checked by the marker transaction. */
  readonly predecessorRevision: number
  /** Revision produced by the marker transaction. */
  readonly successorRevision: number
  /** Digest of the exact successor mutable execution-state envelope. */
  readonly successorExecutionStateDigest: string
  /** Digest of the exact canonical marker bytes. */
  readonly markerDigest: string
}

/** Narrow strict row codecs shared with the authoritative apply writer. */
export type WorkspaceSearchMigrationRehearsalReconciliationRowParsers = {
  /**
   * Parses one marker-prefix row for the exact admitted execution binding.
   *
   * A self-consistent row owned by another execution returns `undefined`.
   * Any row that claims or hashes to the current binding but is malformed must
   * throw rather than being treated as unrelated.
   *
   * @param binding - Exact measured six-object admitted-run binding.
   * @param item - Exact low-level DynamoDB row returned by the base-table Query.
   * @returns Detached strict marker audit row, or undefined for another run.
   */
  readonly parseMarker: (
    binding: WorkspaceSearchMigrationApplyAuditBindingInput,
    item: Readonly<Record<string, AttributeValue>>,
  ) => WorkspaceSearchMigrationApplyMarkerAuditRecord | undefined
  /**
   * Parses one adoption-prefix row for the exact admitted execution binding.
   *
   * @param binding - Exact measured six-object admitted-run binding.
   * @param item - Exact low-level DynamoDB row returned by the base-table Query.
   * @returns Detached strict authority audit row, or undefined for another run.
   */
  readonly parseAuthority: (
    binding: WorkspaceSearchMigrationApplyAuditBindingInput,
    item: Readonly<Record<string, AttributeValue>>,
  ) => WorkspaceSearchMigrationApplyAuthorityAuditRecord | undefined
}

/** Allowlisted low-level Query transport borrowed from one measured session. */
export interface WorkspaceSearchMigrationRehearsalReconciliationAwsTransport {
  /**
   * Sends one strongly consistent base-table Query page.
   *
   * @param command - Collector-owned exact Query command.
   * @param signal - Request-local cancellation signal enforcing the deadline.
   * @returns Raw low-level Query response for strict normalization.
   */
  queryStatePage(
    command: QueryCommand,
    signal: AbortSignal,
  ): Promise<QueryCommandOutput>
}

/** Fresh measured guards invoked on both sides of every Query page. */
export type WorkspaceSearchMigrationRehearsalReconciliationAwsGuards = {
  /**
   * Strongly reconstructs the exact immutable terminal graph.
   *
   * @param signal - Request-local cancellation signal.
   * @returns Detached exact terminal identity.
   */
  readonly readTerminalBinding: (
    signal: AbortSignal,
  ) => Promise<WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding>
  /**
   * Revalidates migration state, four source tables, and target incarnation.
   *
   * @param signal - Request-local cancellation signal.
   */
  readonly requireCurrentTableIncarnations: (
    signal: AbortSignal,
  ) => Promise<void>
}

/** Explicit finite resource budgets for one complete collector invocation. */
export type WorkspaceSearchMigrationRehearsalReconciliationAwsLimits = {
  /** Maximum combined marker and authority Query pages. */
  readonly maximumPages: number
  /** Maximum combined low-level rows inspected, including unrelated runs. */
  readonly maximumItems: number
  /** Maximum combined low-level DynamoDB item bytes inspected. */
  readonly maximumBytes: number
  /** Maximum duration of one terminal, incarnation, or Query request. */
  readonly requestTimeoutMilliseconds: number
  /** Maximum wall-clock duration of the complete collection. */
  readonly maximumDurationMilliseconds: number
}

/** Complete input to one independently guarded terminal Query collection. */
export type CollectWorkspaceSearchMigrationRehearsalReconciliationAwsInput = {
  /** Exact measured migration-state table name, never an endpoint or ARN. */
  readonly stateTableName: string
  /** Immutable terminal identity expected on every guarded reread. */
  readonly expectedTerminalBinding:
    WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding
  /** Replayed plan prefix expected to own durable apply markers. */
  readonly expectedMarkers:
    readonly WorkspaceSearchMigrationRehearsalExpectedMarker[]
  /** Complete or committed-prefix marker aggregate fixed by the apply seal. */
  readonly expectedMarkerAggregateDigest: string
  /** Exact immutable authority receipts expected in the execution chain. */
  readonly expectedAuthorities:
    readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[]
  /** Exact measured six-object binding consumed by writer-owned audit codecs. */
  readonly auditBinding: WorkspaceSearchMigrationApplyAuditBindingInput
  /** Strict writer-shared row parsers bound to the admitted execution graph. */
  readonly parsers:
    WorkspaceSearchMigrationRehearsalReconciliationRowParsers
  /** Narrow official-endpoint Query transport from the measured session. */
  readonly transport:
    WorkspaceSearchMigrationRehearsalReconciliationAwsTransport
  /** Strong terminal and all-six table-incarnation guards. */
  readonly guards:
    WorkspaceSearchMigrationRehearsalReconciliationAwsGuards
  /** Reviewed finite page, item, byte, request, and wall-clock budgets. */
  readonly limits:
    WorkspaceSearchMigrationRehearsalReconciliationAwsLimits
  /** Trusted clock used only for total duration enforcement. */
  readonly clock: () => Date
  /** Optional caller cancellation propagated to every request. */
  readonly signal?: AbortSignal
}

/** Marker and authority material accepted by the reconciliation finalizer. */
export type WorkspaceSearchMigrationRehearsalReconciliationAwsCollectorResult = {
  /** Complete sealed marker versus strong-read comparison. */
  readonly markerSummary:
    WorkspaceSearchMigrationRehearsalReconciliationMarkerCollectorResult
  /** Complete expected versus observed authority-chain comparison. */
  readonly authoritySummary:
    WorkspaceSearchMigrationRehearsalReconciliationAuthorityCollectorResult
}

/** Mutable invocation-wide budgets retained across both prefix Queries. */
type QueryBudget = {
  /** Number of Query responses consumed. */
  pageCount: number
  /** Number of low-level rows inspected, including unrelated runs. */
  itemCount: number
  /** Cumulative low-level DynamoDB item bytes inspected. */
  byteCount: number
}

/** Monotonic trusted-clock state and the fixed overall deadline. */
type CollectorClockState = {
  /** Most recent trusted wall-clock sample. */
  lastMilliseconds: number
  /** Inclusive fixed wall-clock deadline. */
  readonly deadlineMilliseconds: number
}

/** Exact last-evaluated base-table key retained between Query pages. */
type StateQueryCursor = {
  /** Fixed migration partition identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Last evaluated sort key in the selected prefix. */
  readonly recordKey: string
}

/** Relevant markers collected for the exact admitted execution. */
type CollectedMarker = {
  /** Strict detached marker projection. */
  readonly projection:
    WorkspaceSearchMigrationRehearsalDurableMarkerProjection
  /** Stable sort key used only for deterministic tie-breaking. */
  readonly recordKey: string
}

/** Relevant authority receipts collected for the exact admitted execution. */
type CollectedAuthority = {
  /** Strict detached authority-adoption receipt. */
  readonly receipt:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt
  /** Stable sort key used only for deterministic tie-breaking. */
  readonly recordKey: string
}

/** Internal sentinel distinguishing a request deadline from transport errors. */
class ReconciliationRequestTimeout extends Error {}

/** Internal sentinel distinguishing caller cancellation from transport errors. */
class ReconciliationRequestAborted extends Error {}

const authorityChainDigestKind =
  'workspace-search-migration-rehearsal-authority-chain'
const authorityChainDigestVersion = 1

/**
 * Queries and reconciles immutable operation markers and authority receipts.
 *
 * Every base-table page is strongly consistent and is bracketed by a strong
 * terminal reread plus all-six table-incarnation validation. The collector
 * never accepts a GSI, filter, projection, caller-owned cursor, or eventual
 * read. Raw rows are reduced immediately and top-level binary buffers are
 * overwritten after the writer-owned strict parser returns.
 *
 * @param input - Exact terminal binding, expectations, parsers, and budgets.
 * @returns Marker and authority summaries accepted by the pure finalizer.
 */
export async function collectWorkspaceSearchMigrationRehearsalReconciliationAws(
  input: CollectWorkspaceSearchMigrationRehearsalReconciliationAwsInput,
): Promise<WorkspaceSearchMigrationRehearsalReconciliationAwsCollectorResult> {
  const prepared = prepareCollectorInput(input)
  const budget: QueryBudget = { pageCount: 0, itemCount: 0, byteCount: 0 }
  const startedAt = readClockMilliseconds(prepared.clock)
  const deadlineMilliseconds = addSafeDuration(
    startedAt,
    prepared.limits.maximumDurationMilliseconds,
  )
  const clockState: CollectorClockState = {
    lastMilliseconds: startedAt,
    deadlineMilliseconds,
  }
  requireCallerActive(prepared.signal)
  await requireReadBoundary(prepared, clockState)
  const markers = await queryPrefix(
    prepared,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX,
    budget,
    clockState,
    (item, recordKey) => {
      const record = prepared.parsers.parseMarker(
        prepared.auditBinding,
        item,
      )
      return record === undefined
        ? undefined
        : {
            projection: readMarkerProjection(record, recordKey),
            recordKey,
          }
    },
  )
  const authorities = await queryPrefix(
    prepared,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_AUTHORITY_ADOPTION_KEY_PREFIX,
    budget,
    clockState,
    (item, recordKey) => {
      const record = prepared.parsers.parseAuthority(
        prepared.auditBinding,
        item,
      )
      return record === undefined
        ? undefined
        : {
            receipt: readAuthorityReceipt(record, recordKey),
            recordKey,
          }
    },
  )
  await requireReadBoundary(prepared, clockState)
  return Object.freeze({
    markerSummary: createMarkerSummary(
      prepared.expectedMarkers,
      prepared.expectedMarkerAggregateDigest,
      markers,
    ),
    authoritySummary: createAuthoritySummary(
      prepared.expectedAuthorities,
      authorities,
    ),
  })
}

/** Validated detached input used after the public synchronous boundary. */
type PreparedCollectorInput = CollectWorkspaceSearchMigrationRehearsalReconciliationAwsInput

/** Captures and validates every public input before the first await. */
function prepareCollectorInput(
  input: CollectWorkspaceSearchMigrationRehearsalReconciliationAwsInput,
): PreparedCollectorInput {
  if (!isPlainRecord(input)) return fail('INVALID_ARGUMENT')
  const keys = Object.keys(input).sort()
  const expectedKeys = [
    'auditBinding',
    'clock',
    'expectedAuthorities',
    'expectedMarkerAggregateDigest',
    'expectedMarkers',
    'expectedTerminalBinding',
    'guards',
    'limits',
    'parsers',
    ...(Object.hasOwn(input, 'signal') ? ['signal'] : []),
    'stateTableName',
    'transport',
  ].sort()
  if (!sameStrings(keys, expectedKeys)) return fail('INVALID_ARGUMENT')
  const stateTableName = input.stateTableName
  if (
    typeof stateTableName !== 'string' ||
    !/^[A-Za-z0-9_.-]{3,255}$/u.test(stateTableName)
  ) return fail('INVALID_ARGUMENT')
  const expectedTerminalBinding = readTerminalBinding(
    input.expectedTerminalBinding,
  )
  const limits = readLimits(input.limits)
  const expectedMarkers = readExpectedMarkers(
    input.expectedMarkers,
    limits.maximumItems,
  )
  if (
    expectedMarkers.length !==
      expectedTerminalBinding.appliedOperationCount ||
    !isHexDigest(input.expectedMarkerAggregateDigest)
  ) return fail('INVALID_ARGUMENT')
  const expectedAuthorities = readExpectedAuthorities(
    input.expectedAuthorities,
    limits.maximumItems,
  )
  if (
    expectedMarkers.length + expectedAuthorities.length >
      limits.maximumItems
  ) return fail('INVALID_ARGUMENT')
  const auditBinding = readAuditBinding(input.auditBinding)
  const parsers = readParsers(input.parsers)
  const transport = readTransport(input.transport)
  const guards = readGuards(input.guards)
  if (
    typeof input.clock !== 'function' ||
    nodeUtilTypes.isProxy(input.clock) ||
    (input.signal !== undefined && !isAbortSignal(input.signal))
  ) return fail('INVALID_ARGUMENT')
  return Object.freeze({
    stateTableName,
    expectedTerminalBinding,
    expectedMarkers,
    expectedMarkerAggregateDigest:
      input.expectedMarkerAggregateDigest,
    expectedAuthorities,
    auditBinding,
    parsers,
    transport,
    guards,
    limits,
    clock: input.clock,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
}

/** Reads one exact reviewed budget record. */
function readLimits(
  value: WorkspaceSearchMigrationRehearsalReconciliationAwsLimits,
): WorkspaceSearchMigrationRehearsalReconciliationAwsLimits {
  if (!isPlainRecord(value)) return fail('INVALID_ARGUMENT')
  if (!sameStrings(Object.keys(value).sort(), [
    'maximumBytes',
    'maximumDurationMilliseconds',
    'maximumItems',
    'maximumPages',
    'requestTimeoutMilliseconds',
  ])) return fail('INVALID_ARGUMENT')
  const limits = {
    maximumPages: value.maximumPages,
    maximumItems: value.maximumItems,
    maximumBytes: value.maximumBytes,
    requestTimeoutMilliseconds: value.requestTimeoutMilliseconds,
    maximumDurationMilliseconds: value.maximumDurationMilliseconds,
  }
  for (const scalar of Object.values(limits)) {
    if (!Number.isSafeInteger(scalar) || scalar < 1) {
      return fail('INVALID_ARGUMENT')
    }
  }
  if (
    limits.maximumPages >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_PAGES ||
    limits.maximumItems >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_ITEMS ||
    limits.maximumBytes >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_QUERY_BYTES ||
    limits.requestTimeoutMilliseconds >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_REQUEST_TIMEOUT_MILLISECONDS ||
    limits.maximumDurationMilliseconds >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_MAX_DURATION_MILLISECONDS
  ) return fail('INVALID_ARGUMENT')
  return Object.freeze(limits)
}

/** Reads and canonicalizes one terminal identity. */
function readTerminalBinding(
  value: WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding,
): WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding {
  if (!isPlainRecord(value)) return fail('INVALID_ARGUMENT')
  if (!sameStrings(Object.keys(value).sort(), [
    'appliedOperationCount',
    'applyBoundaryDigest',
    'configurationBindingDigest',
    'executionRunDigest',
    'planDigest',
    'sealedPlanOperationCount',
    'sealedPlanningAuthorityDigest',
    'terminalAt',
    'terminalRootDigest',
    'terminalRootKind',
    'terminalRootVersion',
  ])) return fail('INVALID_ARGUMENT')
  for (const digest of [
    value.configurationBindingDigest,
    value.sealedPlanningAuthorityDigest,
    value.executionRunDigest,
    value.planDigest,
    value.applyBoundaryDigest,
    value.terminalRootDigest,
  ]) {
    if (!isHexDigest(digest)) return fail('INVALID_ARGUMENT')
  }
  if (
    (value.terminalRootKind !== 'rolled-back' &&
      value.terminalRootKind !== 'verified') ||
    (value.terminalRootVersion !== 1 &&
      value.terminalRootVersion !== 2) ||
    !isNonNegativeInteger(value.sealedPlanOperationCount) ||
    !isNonNegativeInteger(value.appliedOperationCount) ||
    value.appliedOperationCount > value.sealedPlanOperationCount ||
    !isCanonicalTimestamp(value.terminalAt)
  ) return fail('INVALID_ARGUMENT')
  return Object.freeze({ ...value })
}

/** Reads the exact ordered plan prefix used to classify observed markers. */
function readExpectedMarkers(
  value: readonly WorkspaceSearchMigrationRehearsalExpectedMarker[],
  maximumItems: number,
): readonly WorkspaceSearchMigrationRehearsalExpectedMarker[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length > maximumItems
  ) return fail('INVALID_ARGUMENT')
  const markers = value.map((candidate) => {
    if (!isPlainRecord(candidate)) return fail('INVALID_ARGUMENT')
    if (!sameStrings(Object.keys(candidate).sort(), [
      'operationId',
      'planOperationDigest',
      'planSequence',
    ])) return fail('INVALID_ARGUMENT')
    if (
      !isBoundedIdentifier(candidate.operationId) ||
      !isPositiveInteger(candidate.planSequence) ||
      !isHexDigest(candidate.planOperationDigest)
    ) return fail('INVALID_ARGUMENT')
    return Object.freeze({
      operationId: candidate.operationId,
      planSequence: candidate.planSequence,
      planOperationDigest: candidate.planOperationDigest,
    })
  })
  markers.sort((left, right) => left.planSequence - right.planSequence)
  const operationIds = new Set<string>()
  const operationDigests = new Set<string>()
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]
    if (
      marker === undefined ||
      marker.planSequence !== index + 1 ||
      operationIds.has(marker.operationId) ||
      operationDigests.has(marker.planOperationDigest)
    ) return fail('INVALID_ARGUMENT')
    operationIds.add(marker.operationId)
    operationDigests.add(marker.planOperationDigest)
  }
  return Object.freeze(markers)
}

/** Reads the exact ordered immutable authority expectation. */
function readExpectedAuthorities(
  value: readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[],
  maximumItems: number,
): readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length > maximumItems
  ) return fail('INVALID_ARGUMENT')
  const authorities = value.map((candidate) => {
    if (!isPlainRecord(candidate)) return fail('INVALID_ARGUMENT')
    if (!sameStrings(Object.keys(candidate).sort(), [
      'maintenanceEvidenceRenewalCount',
      'receiptDigest',
    ])) return fail('INVALID_ARGUMENT')
    if (
      !isPositiveInteger(candidate.maintenanceEvidenceRenewalCount) ||
      !isHexDigest(candidate.receiptDigest)
    ) return fail('INVALID_ARGUMENT')
    return Object.freeze({
      maintenanceEvidenceRenewalCount:
        candidate.maintenanceEvidenceRenewalCount,
      receiptDigest: candidate.receiptDigest,
    })
  })
  authorities.sort((left, right) =>
    left.maintenanceEvidenceRenewalCount -
      right.maintenanceEvidenceRenewalCount
  )
  const digests = new Set<string>()
  for (let index = 0; index < authorities.length; index += 1) {
    const authority = authorities[index]
    if (
      authority === undefined ||
      authority.maintenanceEvidenceRenewalCount !== index + 1 ||
      digests.has(authority.receiptDigest)
    ) return fail('INVALID_ARGUMENT')
    digests.add(authority.receiptDigest)
  }
  return Object.freeze(authorities)
}

/** Detaches the exact six-object binding accepted by writer-owned codecs. */
function readAuditBinding(
  value: WorkspaceSearchMigrationApplyAuditBindingInput,
): WorkspaceSearchMigrationApplyAuditBindingInput {
  if (!isPlainRecord(value)) return fail('INVALID_ARGUMENT')
  if (!sameStrings(Object.keys(value).sort(), [
    'closedWriterFenceRecord',
    'configuration',
    'configurationHash',
    'executionBoundary',
    'executionRun',
    'sealedPlanningAuthority',
  ])) return fail('INVALID_ARGUMENT')
  if (
    !isPlainRecord(value.closedWriterFenceRecord) ||
    !isPlainRecord(value.configuration) ||
    typeof value.configurationHash !== 'string' ||
    !isPlainRecord(value.executionBoundary) ||
    !isPlainRecord(value.executionRun) ||
    !isPlainRecord(value.sealedPlanningAuthority)
  ) return fail('INVALID_ARGUMENT')
  let detached: WorkspaceSearchMigrationApplyAuditBindingInput
  try {
    detached = structuredClone(value)
  } catch {
    return fail('INVALID_ARGUMENT')
  }
  return Object.freeze(detached)
}

/** Captures direct non-Proxy parser functions. */
function readParsers(
  value: WorkspaceSearchMigrationRehearsalReconciliationRowParsers,
): WorkspaceSearchMigrationRehearsalReconciliationRowParsers {
  if (!isPlainRecord(value)) return fail('INVALID_ARGUMENT')
  if (!sameStrings(Object.keys(value).sort(), [
    'parseAuthority',
    'parseMarker',
  ])) return fail('INVALID_ARGUMENT')
  if (
    typeof value.parseMarker !== 'function' ||
    nodeUtilTypes.isProxy(value.parseMarker) ||
    typeof value.parseAuthority !== 'function' ||
    nodeUtilTypes.isProxy(value.parseAuthority)
  ) return fail('INVALID_ARGUMENT')
  return Object.freeze({
    parseMarker: (
      binding: WorkspaceSearchMigrationApplyAuditBindingInput,
      item: Readonly<Record<string, AttributeValue>>,
    ) => value.parseMarker(binding, item),
    parseAuthority: (
      binding: WorkspaceSearchMigrationApplyAuditBindingInput,
      item: Readonly<Record<string, AttributeValue>>,
    ) =>
      value.parseAuthority(binding, item),
  })
}

/** Captures one direct narrow Query transport. */
function readTransport(
  value: WorkspaceSearchMigrationRehearsalReconciliationAwsTransport,
): WorkspaceSearchMigrationRehearsalReconciliationAwsTransport {
  if (
    !isPlainRecord(value) ||
    !sameStrings(Object.keys(value).sort(), ['queryStatePage']) ||
    typeof value.queryStatePage !== 'function' ||
    nodeUtilTypes.isProxy(value.queryStatePage)
  ) return fail('INVALID_ARGUMENT')
  return Object.freeze({
    queryStatePage: (command: QueryCommand, signal: AbortSignal) =>
      value.queryStatePage(command, signal),
  })
}

/** Captures direct terminal and incarnation guard functions. */
function readGuards(
  value: WorkspaceSearchMigrationRehearsalReconciliationAwsGuards,
): WorkspaceSearchMigrationRehearsalReconciliationAwsGuards {
  if (!isPlainRecord(value)) return fail('INVALID_ARGUMENT')
  if (!sameStrings(Object.keys(value).sort(), [
    'readTerminalBinding',
    'requireCurrentTableIncarnations',
  ])) return fail('INVALID_ARGUMENT')
  if (
    typeof value.readTerminalBinding !== 'function' ||
    nodeUtilTypes.isProxy(value.readTerminalBinding) ||
    typeof value.requireCurrentTableIncarnations !== 'function' ||
    nodeUtilTypes.isProxy(value.requireCurrentTableIncarnations)
  ) return fail('INVALID_ARGUMENT')
  return Object.freeze({
    readTerminalBinding: (signal) =>
      value.readTerminalBinding(signal),
    requireCurrentTableIncarnations: (signal) =>
      value.requireCurrentTableIncarnations(signal),
  })
}

/** Queries one complete strongly consistent sort-key prefix. */
async function queryPrefix<Result>(
  input: PreparedCollectorInput,
  prefix: string,
  budget: QueryBudget,
  clockState: CollectorClockState,
  parse: (
    item: Readonly<Record<string, AttributeValue>>,
    recordKey: string,
  ) => Result | undefined,
): Promise<readonly Result[]> {
  const results: Result[] = []
  let cursor: StateQueryCursor | undefined
  let previousRecordKey: string | undefined
  const observedCursors = new Set<string>()
  while (true) {
    requireBudgetBeforePage(input.limits, budget)
    const command = createQueryCommand(
      input.stateTableName,
      prefix,
      cursor,
    )
    const output = await runGuardedQuery(input, command, clockState)
    budget.pageCount += 1
    let normalized: NormalizedQueryPage
    try {
      normalized = readQueryPage(output, prefix, previousRecordKey)
    } catch (error) {
      zeroizeUnknownQueryOutputItems(output)
      throw error
    }
    if (
      normalized.items.length === 0 &&
      normalized.cursor !== undefined
    ) return fail('INVALID_RESPONSE')
    try {
      for (const entry of normalized.items) {
        try {
          let itemBytes: number
          try {
            itemBytes = calculateDynamoDbItemSize(entry.item)
          } catch {
            return fail('INVALID_RESPONSE')
          }
          if (itemBytes > DYNAMODB_MAX_ITEM_SIZE_BYTES) {
            return fail('INVALID_RESPONSE')
          }
          budget.itemCount = addBudget(
            budget.itemCount,
            1,
            input.limits.maximumItems,
          )
          budget.byteCount = addBudget(
            budget.byteCount,
            itemBytes,
            input.limits.maximumBytes,
          )
          try {
            const parsed = parse(entry.item, entry.recordKey)
            if (parsed !== undefined) results.push(parsed)
          } catch {
            return fail('INVALID_RESPONSE')
          }
        } finally {
          zeroizeTopLevelBinaryAttributes(entry.item)
        }
        previousRecordKey = entry.recordKey
      }
    } finally {
      for (const entry of normalized.items) {
        zeroizeTopLevelBinaryAttributes(entry.item)
      }
    }
    cursor = normalized.cursor
    if (cursor === undefined) return Object.freeze(results)
    const cursorDigest = createMigrationDigest(cursor)
    if (observedCursors.has(cursorDigest)) {
      return fail('INVALID_RESPONSE')
    }
    observedCursors.add(cursorDigest)
    previousRecordKey = cursor.recordKey
  }
}

/** Builds the only Query shape accepted by the collector. */
function createQueryCommand(
  tableName: string,
  prefix: string,
  cursor: StateQueryCursor | undefined,
): QueryCommand {
  return new QueryCommand({
    TableName: tableName,
    ConsistentRead: true,
    ScanIndexForward: true,
    Limit: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
    KeyConditionExpression:
      '#migrationId = :migrationId AND begins_with(#recordKey, :recordKeyPrefix)',
    ExpressionAttributeNames: {
      '#migrationId': 'migrationId',
      '#recordKey': 'recordKey',
    },
    ExpressionAttributeValues: {
      ':migrationId': { S: WORKSPACE_SEARCH_MIGRATION_ID },
      ':recordKeyPrefix': { S: prefix },
    },
    ...(cursor === undefined
      ? {}
      : {
          ExclusiveStartKey: {
            migrationId: { S: cursor.migrationId },
            recordKey: { S: cursor.recordKey },
          },
        }),
  })
}

/** One normalized Query item and its exact ascending sort key. */
type NormalizedQueryItem = {
  /** Exact raw item consumed by the writer-owned strict parser. */
  readonly item: Readonly<Record<string, AttributeValue>>
  /** Exact ascending record key returned by the base table. */
  readonly recordKey: string
}

/** Strict normalized Query page. */
type NormalizedQueryPage = {
  /** Exact ascending rows returned without a filter expression. */
  readonly items: readonly NormalizedQueryItem[]
  /** Exact continuation key, or undefined at terminal pagination. */
  readonly cursor: StateQueryCursor | undefined
}

/** Strictly normalizes one no-filter base-table Query response. */
function readQueryPage(
  output: QueryCommandOutput,
  prefix: string,
  previousRecordKey: string | undefined,
): NormalizedQueryPage {
  if (!isPlainRecord(output)) return fail('INVALID_RESPONSE')
  const itemsValue = readOwnDataProperty(output, 'Items')
  const countValue = readOwnDataProperty(output, 'Count')
  const scannedCountValue = readOwnDataProperty(output, 'ScannedCount')
  const items = itemsValue === undefined ? [] : itemsValue
  if (
    !Array.isArray(items) ||
    nodeUtilTypes.isProxy(items) ||
    items.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE ||
    !isNonNegativeInteger(countValue) ||
    !isNonNegativeInteger(scannedCountValue) ||
    countValue !== items.length ||
    scannedCountValue !== items.length
  ) return fail('INVALID_RESPONSE')
  const normalized: NormalizedQueryItem[] = []
  let lastRecordKey = previousRecordKey
  for (const item of items) {
    if (!isDynamoDbItem(item)) return fail('INVALID_RESPONSE')
    const migrationId = readStringAttribute(item, 'migrationId')
    const recordKey = readStringAttribute(item, 'recordKey')
    if (
      migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
      !recordKey.startsWith(prefix) ||
      (lastRecordKey !== undefined &&
        compareUtf8Ordinal(recordKey, lastRecordKey) <= 0)
    ) return fail('INVALID_RESPONSE')
    normalized.push({ item, recordKey })
    lastRecordKey = recordKey
  }
  const cursorValue = readOwnDataProperty(output, 'LastEvaluatedKey')
  const cursor = cursorValue === undefined
    ? undefined
    : readStateQueryCursor(cursorValue, prefix)
  if (
    cursor !== undefined &&
    (normalized.length === 0 ||
      cursor.recordKey !== normalized.at(-1)?.recordKey)
  ) return fail('INVALID_RESPONSE')
  return Object.freeze({
    items: Object.freeze(normalized),
    cursor,
  })
}

/** Reads one exact two-attribute LastEvaluatedKey. */
function readStateQueryCursor(
  value: unknown,
  prefix: string,
): StateQueryCursor {
  if (!isPlainRecord(value)) return fail('INVALID_RESPONSE')
  if (!sameStrings(Object.keys(value).sort(), [
    'migrationId',
    'recordKey',
  ])) return fail('INVALID_RESPONSE')
  const migrationId = readStringAttribute(value, 'migrationId')
  const recordKey = readStringAttribute(value, 'recordKey')
  if (
    migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    !recordKey.startsWith(prefix)
  ) return fail('INVALID_RESPONSE')
  return Object.freeze({ migrationId, recordKey })
}

/** Runs one Query between fresh terminal and all-six incarnation guards. */
async function runGuardedQuery(
  input: PreparedCollectorInput,
  command: QueryCommand,
  clockState: CollectorClockState,
): Promise<QueryCommandOutput> {
  await requireReadBoundary(input, clockState)
  let output: QueryCommandOutput
  try {
    output = await runTimedRequest(
      input,
      clockState,
      (signal) => input.transport.queryStatePage(command, signal),
      'QUERY_FAILED',
    )
  } catch (error) {
    await requireReadBoundary(input, clockState)
    throw error
  }
  try {
    await requireReadBoundary(input, clockState)
  } catch (error) {
    zeroizeUnknownQueryOutputItems(output)
    throw error
  }
  return output
}

/** Requires exact terminal identity and all six table incarnations. */
async function requireReadBoundary(
  input: PreparedCollectorInput,
  clockState: CollectorClockState,
): Promise<void> {
  let terminal:
    WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding
  try {
    terminal = await runTimedRequest(
      input,
      clockState,
      (signal) => input.guards.readTerminalBinding(signal),
      'IDENTITY_DRIFT',
    )
    await runTimedRequest(
      input,
      clockState,
      (signal) =>
        input.guards.requireCurrentTableIncarnations(signal),
      'IDENTITY_DRIFT',
    )
  } catch (error) {
    if (
      error instanceof WorkspaceSearchMigrationRehearsalReconciliationAwsError &&
      (error.code === 'ABORTED' || error.code === 'TIMEOUT')
    ) throw error
    return fail('IDENTITY_DRIFT')
  }
  let strictTerminal:
    WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding
  try {
    strictTerminal = readTerminalBinding(terminal)
  } catch {
    return fail('IDENTITY_DRIFT')
  }
  if (
    createMigrationDigest(strictTerminal) !==
      createMigrationDigest(input.expectedTerminalBinding)
  ) return fail('IDENTITY_DRIFT')
}

/** Runs one external request with caller cancellation and a finite deadline. */
async function runTimedRequest<Result>(
  input: PreparedCollectorInput,
  clockState: CollectorClockState,
  operation: (signal: AbortSignal) => Promise<Result>,
  failureCode: WorkspaceSearchMigrationRehearsalReconciliationAwsErrorCode,
): Promise<Result> {
  requireCallerActive(input.signal)
  const now = sampleCollectorClock(input.clock, clockState)
  const remaining = clockState.deadlineMilliseconds - now
  if (remaining <= 0) return fail('TIMEOUT')
  const timeoutMilliseconds = Math.min(
    remaining,
    input.limits.requestTimeoutMilliseconds,
  )
  const controller = new AbortController()
  const callerSignal = input.signal
  let rejectCallerAbort: (() => void) | undefined
  const aborted = callerSignal === undefined
    ? undefined
    : new Promise<never>((_resolve, reject) => {
        rejectCallerAbort = (): void =>
          reject(new ReconciliationRequestAborted())
      })
  /** Propagates caller cancellation to both the race and AWS request. */
  const abortFromCaller = (): void => {
    rejectCallerAbort?.()
    controller.abort()
  }
  if (callerSignal !== undefined) {
    callerSignal.addEventListener('abort', abortFromCaller, { once: true })
    if (callerSignal.aborted) abortFromCaller()
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const request = operation(controller.signal)
    if (!nodeUtilTypes.isPromise(request)) return fail('INVALID_RESPONSE')
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new ReconciliationRequestTimeout())
        controller.abort()
      }, timeoutMilliseconds)
    })
    const result = await Promise.race(
      aborted === undefined ? [request, timedOut] : [request, timedOut, aborted],
    )
    sampleCollectorClock(input.clock, clockState)
    return result
  } catch (error) {
    if (error instanceof ReconciliationRequestTimeout) return fail('TIMEOUT')
    if (error instanceof ReconciliationRequestAborted) return fail('ABORTED')
    if (callerSignal?.aborted === true) return fail('ABORTED')
    if (
      error instanceof WorkspaceSearchMigrationRehearsalReconciliationAwsError
    ) throw error
    return fail(failureCode)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (callerSignal !== undefined) {
      callerSignal.removeEventListener('abort', abortFromCaller)
    }
  }
}

/** Derives the exact marker comparison accepted by the artifact finalizer. */
function createMarkerSummary(
  expected:
    readonly WorkspaceSearchMigrationRehearsalExpectedMarker[],
  expectedAggregateDigest: string,
  observed: readonly CollectedMarker[],
): WorkspaceSearchMigrationRehearsalReconciliationMarkerCollectorResult {
  const byOperationId = new Map(
    expected.map((entry) => [entry.operationId, entry]),
  )
  const byPlanIdentity = new Map(
    expected.map((entry) => [
      createPlanIdentity(entry.planSequence, entry.planOperationDigest),
      entry,
    ]),
  )
  const matchedOperationIds = new Set<string>()
  let matchedCount = 0
  let duplicateCount = 0
  let unexpectedCount = 0
  const accumulator = new MigrationDigestAccumulator()
  for (const entry of observed) {
    const marker = entry.projection.marker
    accumulator.add(entry.projection.markerDigest)
    const expectedByOperation = byOperationId.get(marker.operationId)
    if (
      expectedByOperation !== undefined &&
      marker.planSequence === expectedByOperation.planSequence &&
      marker.planOperationDigest ===
        expectedByOperation.planOperationDigest
    ) {
      if (matchedOperationIds.has(expectedByOperation.operationId)) {
        duplicateCount += 1
      } else {
        matchedOperationIds.add(expectedByOperation.operationId)
        matchedCount += 1
      }
      continue
    }
    const expectedByPlan = byPlanIdentity.get(
      createPlanIdentity(marker.planSequence, marker.planOperationDigest),
    )
    if (expectedByPlan !== undefined) {
      duplicateCount += 1
      continue
    }
    unexpectedCount += 1
  }
  const missingCount = expected.length - matchedCount
  const observedAggregateDigest = accumulator.digest()
  const discrepancyCount =
    duplicateCount + missingCount + unexpectedCount
  if (
    (discrepancyCount === 0) !==
      (observedAggregateDigest === expectedAggregateDigest)
  ) return fail('INVALID_RESPONSE')
  return Object.freeze({
    expectedCount: expected.length,
    expectedAggregateDigest,
    observedCount: observed.length,
    observedAggregateDigest,
    matchedCount,
    duplicateCount,
    missingCount,
    unexpectedCount,
  })
}

/** Derives the exact immutable authority-set comparison. */
function createAuthoritySummary(
  expected:
    readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[],
  observed: readonly CollectedAuthority[],
): WorkspaceSearchMigrationRehearsalReconciliationAuthorityCollectorResult {
  const expectedByDigest = new Map(
    expected.map((entry) => [entry.receiptDigest, entry]),
  )
  const matchedDigests = new Set<string>()
  let matchedCount = 0
  let orphanCount = 0
  for (const entry of observed) {
    const receipt = entry.receipt
    const expectedEntry = expectedByDigest.get(receipt.receiptDigest)
    if (
      expectedEntry === undefined ||
      expectedEntry.maintenanceEvidenceRenewalCount !==
        receipt.maintenanceEvidenceRenewalCount ||
      matchedDigests.has(receipt.receiptDigest)
    ) {
      orphanCount += 1
      continue
    }
    matchedDigests.add(receipt.receiptDigest)
    matchedCount += 1
  }
  const missingCount = expected.length - matchedCount
  const expectedChainDigest = createAuthorityChainDigest(expected)
  const observedChainDigest = createAuthorityChainDigest(
    observed.map((entry) => ({
      maintenanceEvidenceRenewalCount:
        entry.receipt.maintenanceEvidenceRenewalCount,
      receiptDigest: entry.receipt.receiptDigest,
    })),
  )
  const discrepancyCount = missingCount + orphanCount
  if (
    (discrepancyCount === 0) !==
      (expectedChainDigest === observedChainDigest)
  ) return fail('INVALID_RESPONSE')
  return Object.freeze({
    expectedChainDigest,
    observedChainDigest,
    expectedCount: expected.length,
    observedCount: observed.length,
    matchedCount,
    missingCount,
    orphanCount,
  })
}

/** Creates one ordered authority-chain digest independent of Query page order. */
function createAuthorityChainDigest(
  entries: readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[],
): string {
  const ordered = entries.map((entry) => ({
    maintenanceEvidenceRenewalCount:
      entry.maintenanceEvidenceRenewalCount,
    receiptDigest: entry.receiptDigest,
  })).sort((left, right) =>
    left.maintenanceEvidenceRenewalCount -
      right.maintenanceEvidenceRenewalCount ||
    compareUtf8Ordinal(left.receiptDigest, right.receiptDigest)
  )
  return createMigrationDigest({
    kind: authorityChainDigestKind,
    version: authorityChainDigestVersion,
    entries: ordered,
  })
}

/** Reads and detaches one writer-owned strict marker projection. */
function readMarkerProjection(
  value: WorkspaceSearchMigrationApplyMarkerAuditRecord,
  expectedRecordKey: string,
): WorkspaceSearchMigrationRehearsalDurableMarkerProjection {
  if (!isPlainRecord(value)) return fail('INVALID_RESPONSE')
  if (!sameStrings(Object.keys(value).sort(), [
    'marker',
    'markerDigest',
    'predecessorRevision',
    'recordKey',
    'successorExecutionStateDigest',
    'successorRevision',
  ])) return fail('INVALID_RESPONSE')
  const marker = value.marker
  if (!isPlainRecord(marker)) return fail('INVALID_RESPONSE')
  const operationId = readOwnDataProperty(marker, 'operationId')
  const planSequence = readOwnDataProperty(marker, 'planSequence')
  const planOperationDigest = readOwnDataProperty(
    marker,
    'planOperationDigest',
  )
  if (
    value.recordKey !== expectedRecordKey ||
    !isBoundedIdentifier(operationId) ||
    !isPositiveInteger(planSequence) ||
    !isHexDigest(planOperationDigest) ||
    !isPositiveInteger(value.predecessorRevision) ||
    value.successorRevision !== value.predecessorRevision + 1 ||
    !isHexDigest(value.successorExecutionStateDigest) ||
    !isHexDigest(value.markerDigest)
  ) return fail('INVALID_RESPONSE')
  return Object.freeze({
    marker: structuredClone(marker),
    predecessorRevision: value.predecessorRevision,
    successorRevision: value.successorRevision,
    successorExecutionStateDigest: value.successorExecutionStateDigest,
    markerDigest: value.markerDigest,
  })
}

/** Reads the strict authority fields used by cross-row reconciliation. */
function readAuthorityReceipt(
  value: WorkspaceSearchMigrationApplyAuthorityAuditRecord,
  expectedRecordKey: string,
): WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt {
  if (!isPlainRecord(value)) return fail('INVALID_RESPONSE')
  if (!sameStrings(Object.keys(value).sort(), ['receipt', 'recordKey'])) {
    return fail('INVALID_RESPONSE')
  }
  if (
    value.recordKey !== expectedRecordKey ||
    !isPlainRecord(value.receipt)
  ) return fail('INVALID_RESPONSE')
  const receipt = value.receipt
  if (
    !isHexDigest(receipt.receiptDigest) ||
    !isPositiveInteger(receipt.maintenanceEvidenceRenewalCount) ||
    !isPositiveInteger(receipt.predecessorRevision) ||
    receipt.successorRevision !== receipt.predecessorRevision + 1 ||
    !isHexDigest(receipt.predecessorExecutionStateDigest) ||
    !isHexDigest(receipt.successorExecutionStateDigest)
  ) return fail('INVALID_RESPONSE')
  return structuredClone(receipt)
}

/** Creates the stable plan sequence/digest lookup identity. */
function createPlanIdentity(sequence: number, digest: string): string {
  return `${sequence}:${digest}`
}

/** Requires another page to fit the fixed page budget. */
function requireBudgetBeforePage(
  limits: WorkspaceSearchMigrationRehearsalReconciliationAwsLimits,
  budget: QueryBudget,
): void {
  if (budget.pageCount >= limits.maximumPages) {
    return fail('LIMIT_EXCEEDED')
  }
}

/** Adds one bounded non-negative budget value without overflow. */
function addBudget(current: number, delta: number, maximum: number): number {
  const next = current + delta
  if (!Number.isSafeInteger(next) || next > maximum) {
    return fail('LIMIT_EXCEEDED')
  }
  return next
}

/** Samples a trusted clock and rejects regression or the overall deadline. */
function sampleCollectorClock(
  clock: () => Date,
  state: CollectorClockState,
): number {
  const milliseconds = readClockMilliseconds(clock)
  if (
    milliseconds < state.lastMilliseconds ||
    milliseconds > state.deadlineMilliseconds
  ) return fail('TIMEOUT')
  state.lastMilliseconds = milliseconds
  return milliseconds
}

/** Reads one finite trusted-clock value without accepting accessors or Proxies. */
function readClockMilliseconds(clock: () => Date): number {
  let value: unknown
  let milliseconds: unknown
  try {
    value = Reflect.apply(clock, undefined, [])
    milliseconds = Date.prototype.getTime.call(value)
  } catch {
    return fail('INVALID_ARGUMENT')
  }
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) {
    return fail('INVALID_ARGUMENT')
  }
  return milliseconds
}

/** Adds a reviewed duration without crossing the safe integer boundary. */
function addSafeDuration(start: number, duration: number): number {
  const deadline = start + duration
  if (!Number.isSafeInteger(deadline)) return fail('INVALID_ARGUMENT')
  return deadline
}

/** Rejects an already aborted caller signal. */
function requireCallerActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) return fail('ABORTED')
}

/** Checks an exact native AbortSignal rather than a thenable lookalike. */
function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal && !nodeUtilTypes.isProxy(value)
}

/** Reads one exact top-level DynamoDB string attribute. */
function readStringAttribute(item: object, name: string): string {
  const value = readOwnDataProperty(item, name)
  if (!isPlainRecord(value)) return fail('INVALID_RESPONSE')
  if (!sameStrings(Object.keys(value), ['S'])) {
    return fail('INVALID_RESPONSE')
  }
  const stringValue = readOwnDataProperty(value, 'S')
  if (typeof stringValue !== 'string') return fail('INVALID_RESPONSE')
  return stringValue
}

/** Reads one own enumerable data property without invoking an accessor. */
function readOwnDataProperty(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) return undefined
  return descriptor.value
}

/** Best-effort overwrites top-level binary buffers after strict parsing. */
function zeroizeTopLevelBinaryAttributes(
  item: Readonly<Record<string, AttributeValue>>,
): void {
  for (const attribute of Object.values(item)) {
    if (!isPlainRecord(attribute)) continue
    const binary = readOwnDataProperty(attribute, 'B')
    if (!(binary instanceof Uint8Array) || nodeUtilTypes.isProxy(binary)) {
      continue
    }
    try {
      Reflect.apply(Uint8Array.prototype.fill, binary, [0])
    } catch {
      // Cleanup must never replace the primary reconciliation outcome.
    }
  }
}

/** Best-effort clears raw page buffers when normalization fails early. */
function zeroizeUnknownQueryOutputItems(output: unknown): void {
  if (!isPlainRecord(output)) return
  const items = readOwnDataProperty(output, 'Items')
  if (!Array.isArray(items) || nodeUtilTypes.isProxy(items)) return
  for (const item of items) {
    if (!isPlainRecord(item)) continue
    for (const attribute of Object.values(item)) {
      if (!isPlainRecord(attribute)) continue
      const binary = readOwnDataProperty(attribute, 'B')
      if (!(binary instanceof Uint8Array) || nodeUtilTypes.isProxy(binary)) {
        continue
      }
      try {
        Reflect.apply(Uint8Array.prototype.fill, binary, [0])
      } catch {
        // Cleanup must never replace the strict response failure.
      }
    }
  }
}

/** Checks one complete low-level DynamoDB item without a type assertion. */
function isDynamoDbItem(
  value: unknown,
): value is Record<string, AttributeValue> {
  return isPlainRecord(value) &&
    Object.values(value).every((attribute) =>
      isDynamoDbAttributeValue(attribute)
    )
}

/** Checks one strict low-level DynamoDB AttributeValue recursively. */
function isDynamoDbAttributeValue(
  value: unknown,
): value is AttributeValue {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 1) return false
  const key = keys[0]
  if (key === undefined) return false
  const member = readOwnDataProperty(value, key)
  switch (key) {
    case 'B':
      return member instanceof Uint8Array && !nodeUtilTypes.isProxy(member)
    case 'BOOL':
    case 'NULL':
      return typeof member === 'boolean'
    case 'BS':
      return Array.isArray(member) &&
        !nodeUtilTypes.isProxy(member) &&
        member.every((entry) =>
          entry instanceof Uint8Array && !nodeUtilTypes.isProxy(entry)
        )
    case 'L':
      return Array.isArray(member) &&
        !nodeUtilTypes.isProxy(member) &&
        member.every((entry) => isDynamoDbAttributeValue(entry))
    case 'M':
      return isDynamoDbItem(member)
    case 'N':
    case 'S':
      return typeof member === 'string'
    case 'NS':
    case 'SS':
      return Array.isArray(member) &&
        !nodeUtilTypes.isProxy(member) &&
        member.every((entry) => typeof entry === 'string')
    default:
      return false
  }
}

/** Checks one ordinary object with no accessors or Proxy behavior. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) return false
  }
  return true
}

/** Checks one stable bounded operation identifier. */
function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
}

/** Checks one positive safe integer. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Checks one non-negative safe integer. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Compares two strings using deterministic UTF-8 ordinal order. */
function compareUtf8Ordinal(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0)
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
}

/** Checks two already sorted exact string arrays. */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((entry, index) => entry === right[index])
}

/** Raises one stable raw-value-free collector failure. */
function fail(
  code: WorkspaceSearchMigrationRehearsalReconciliationAwsErrorCode,
): never {
  throw new WorkspaceSearchMigrationRehearsalReconciliationAwsError(code)
}
