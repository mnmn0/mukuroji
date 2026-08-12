import {
  createAttributeMapDigest,
  decodeAttributeMap,
  encodeAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import { createAbsentMigrationItemDigest } from './migration-journal'
import {
  createWorkspaceSearchMigrationScanSnapshotDigest,
  createWorkspaceSearchOperationId,
  isCanonicalTimestamp,
  isHexDigest,
  type MigrationItemSnapshot,
  type MigrationScanAggregate,
  type MigrationSourceCondition,
  serializeCanonicalJson,
  type WorkspaceSearchDryRunEvidence,
  type WorkspaceSearchMigrationOperation,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMigrationOperationDigest,
  createWorkspaceSearchPlanLeafDigest,
  createWorkspaceSearchPlanNodeDigest,
  type WorkspaceSearchPlannedOperation,
  type WorkspaceSearchPlanMembershipProofStep,
} from './migration-state-machine'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/**
 * Maximum exact UTF-8 size accepted for one migration artifact.
 *
 * The bound accommodates three legal 400 KiB DynamoDB items after tagged JSON
 * encoding and worst-case JSON escaping while remaining a finite file boundary.
 */
export const WORKSPACE_SEARCH_MIGRATION_ARTIFACT_MAX_BYTES =
  64 * 1024 * 1024

/** Maximum canonical size reserved for one immutable plan seal. */
export const WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES =
  4 * 1024

const maximumPlanMembershipProofSteps = 53

/**
 * Stable raw-value-free failure raised when a migration artifact is invalid.
 */
export class WorkspaceSearchMigrationArtifactError extends Error {
  /** Secret-free machine-readable artifact failure code. */
  readonly code = 'INVALID_MIGRATION_ARTIFACT'

  /**
   * Creates a stable artifact validation failure.
   */
  constructor() {
    super('INVALID_MIGRATION_ARTIFACT')
    this.name = 'WorkspaceSearchMigrationArtifactError'
  }
}

/**
 * Serializes reviewed dry-run evidence into strict canonical UTF-8 bytes.
 *
 * @param value - Candidate complete dry-run evidence.
 * @returns Exact canonical JSON bytes without a trailing newline.
 */
export function serializeWorkspaceSearchDryRunEvidence(
  value: WorkspaceSearchDryRunEvidence,
): Uint8Array {
  try {
    return encodeCanonicalArtifact(readDryRunEvidence(value))
  } catch (error: unknown) {
    return wrapArtifactFailure(error)
  }
}

/**
 * Parses and validates exact canonical dry-run evidence bytes.
 *
 * @param bytes - Untrusted bounded UTF-8 artifact bytes.
 * @returns Detached complete dry-run evidence.
 */
export function parseWorkspaceSearchDryRunEvidence(
  bytes: Uint8Array,
): WorkspaceSearchDryRunEvidence {
  try {
    const parsed = parseArtifactJson(bytes)
    const evidence = readDryRunEvidence(parsed)
    requireCanonicalArtifactBytes(bytes, evidence)
    return evidence
  } catch (error: unknown) {
    return wrapArtifactFailure(error)
  }
}

/**
 * Serializes one immutable plan seal into strict canonical UTF-8 bytes.
 *
 * @param value - Candidate reviewed plan seal.
 * @returns Exact canonical JSON bytes without a trailing newline.
 */
export function serializeWorkspaceSearchPlanSeal(
  value: WorkspaceSearchPlanSeal,
): Uint8Array {
  try {
    return encodeCanonicalArtifact(
      readPlanSeal(value),
      WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
    )
  } catch (error: unknown) {
    return wrapArtifactFailure(error)
  }
}

/**
 * Parses and validates exact canonical plan-seal bytes.
 *
 * @param bytes - Untrusted bounded UTF-8 artifact bytes.
 * @returns Detached immutable plan seal.
 */
export function parseWorkspaceSearchPlanSeal(
  bytes: Uint8Array,
): WorkspaceSearchPlanSeal {
  try {
    const parsed = parseArtifactJson(
      bytes,
      WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
    )
    const seal = readPlanSeal(parsed)
    requireCanonicalArtifactBytes(
      bytes,
      seal,
      WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
    )
    return seal
  } catch (error: unknown) {
    return wrapArtifactFailure(error)
  }
}

/**
 * Serializes one lossless planned operation into strict canonical UTF-8 bytes.
 *
 * DynamoDB AttributeValue maps are converted to the shared tagged encoding so
 * binary values, sets, and exact number spellings remain part of the artifact.
 *
 * @param value - Candidate immutable planned operation.
 * @returns Exact canonical JSON bytes without a trailing newline.
 */
export function serializeWorkspaceSearchPlannedOperation(
  value: WorkspaceSearchPlannedOperation,
): Uint8Array {
  try {
    requireRawPlannedOperationShape(value)
    const encoded = encodePlannedOperation(value)
    const validated = readPlannedOperation(encoded)
    return encodeCanonicalArtifact(encodePlannedOperation(validated))
  } catch (error: unknown) {
    return wrapArtifactFailure(error)
  }
}

/**
 * Parses one lossless planned operation from exact canonical UTF-8 bytes.
 *
 * @param bytes - Untrusted bounded UTF-8 artifact bytes.
 * @returns Detached planned operation containing raw DynamoDB AttributeValues.
 */
export function parseWorkspaceSearchPlannedOperation(
  bytes: Uint8Array,
): WorkspaceSearchPlannedOperation {
  try {
    const parsed = parseArtifactJson(bytes)
    const planned = readPlannedOperation(parsed)
    requireCanonicalArtifactBytes(bytes, encodePlannedOperation(planned))
    return planned
  } catch (error: unknown) {
    return wrapArtifactFailure(error)
  }
}

/**
 * Reads and validates one complete dry-run evidence document.
 *
 * @param value - Candidate parsed document.
 * @returns Reconstructed canonical evidence.
 */
function readDryRunEvidence(value: unknown): WorkspaceSearchDryRunEvidence {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'completedAt',
    'configurationHash',
    'evidenceVersion',
    'kind',
    'migrationId',
    'migrationVersion',
    'sources',
    'startedAt',
    'status',
    'target',
  ])
  if (
    record.kind !== 'workspace-search-migration-dry-run' ||
    record.evidenceVersion !== 1 ||
    record.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    record.migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION ||
    record.status !== 'pass'
  ) {
    return failArtifact()
  }

  const configurationHash = requireDigest(record.configurationHash)
  const startedAt = requireTimestamp(record.startedAt)
  const completedAt = requireTimestamp(record.completedAt)
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    return failArtifact()
  }

  const sources = readSourceAggregates(record.sources)
  const target = readScanAggregate(record.target)
  if (
    target.invalid !== 0 ||
    workspaceSearchMigrationSourceNames.some(
      (source) => sources[source].invalid !== 0,
    )
  ) {
    return failArtifact()
  }

  void createWorkspaceSearchMigrationScanSnapshotDigest({
    configurationHash,
    sources,
    target,
  })

  return {
    kind: 'workspace-search-migration-dry-run',
    evidenceVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    configurationHash,
    startedAt,
    completedAt,
    sources,
    target,
    status: 'pass',
  }
}

/**
 * Reads the exact four migration source aggregates.
 *
 * @param value - Candidate source aggregate record.
 * @returns Canonically ordered source aggregates.
 */
function readSourceAggregates(
  value: unknown,
): Readonly<Record<WorkspaceSearchMigrationSourceName, MigrationScanAggregate>> {
  const record = requireRecord(value)
  requireExactKeys(record, [...workspaceSearchMigrationSourceNames])
  return {
    'project-directory': readScanAggregate(record['project-directory']),
    'work-items': readScanAggregate(record['work-items']),
    collaboration: readScanAggregate(record.collaboration),
    documents: readScanAggregate(record.documents),
  }
}

/**
 * Reads one internally consistent complete scan aggregate.
 *
 * @param value - Candidate aggregate record.
 * @returns Reconstructed aggregate.
 */
function readScanAggregate(value: unknown): MigrationScanAggregate {
  const record = requireRecord(value)
  requireExactKeys(record, [
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
  const scanned = requireNonNegativeSafeInteger(record.scanned)
  const mapped = requireNonNegativeSafeInteger(record.mapped)
  const ignored = requireNonNegativeSafeInteger(record.ignored)
  const invalid = requireNonNegativeSafeInteger(record.invalid)
  const projected = requireNonNegativeSafeInteger(record.projected)
  const deleted = requireNonNegativeSafeInteger(record.deleted)
  const pageCount = requireNonNegativeSafeInteger(record.pageCount)
  if (
    mapped + ignored + invalid !== scanned ||
    projected + deleted !== mapped
  ) {
    return failArtifact()
  }
  return {
    scanned,
    mapped,
    ignored,
    invalid,
    projected,
    deleted,
    keyDigest: requireDigest(record.keyDigest),
    contentDigest: requireDigest(record.contentDigest),
    pageCount,
  }
}

/**
 * Reads and validates one immutable plan seal.
 *
 * @param value - Candidate parsed seal.
 * @returns Reconstructed canonical seal.
 */
function readPlanSeal(value: unknown): WorkspaceSearchPlanSeal {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'configurationHash',
    'createdAt',
    'dryRunEvidenceDigest',
    'kind',
    'migrationId',
    'migrationVersion',
    'orphanOperationCount',
    'planDigest',
    'planOperationCount',
    'planningSnapshotDigest',
    'runId',
    'sealVersion',
    'sourceOperationCount',
  ])
  if (
    record.kind !== 'workspace-search-plan-seal' ||
    record.sealVersion !== 2 ||
    record.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    record.migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failArtifact()
  }
  const planOperationCount = requireNonNegativeSafeInteger(
    record.planOperationCount,
  )
  const sourceOperationCount = requireNonNegativeSafeInteger(
    record.sourceOperationCount,
  )
  const orphanOperationCount = requireNonNegativeSafeInteger(
    record.orphanOperationCount,
  )
  const classifiedCount = sourceOperationCount + orphanOperationCount
  if (
    !Number.isSafeInteger(classifiedCount) ||
    classifiedCount !== planOperationCount
  ) {
    return failArtifact()
  }
  const planDigest = requireDigest(record.planDigest)
  if (
    (planOperationCount === 0) !==
      (planDigest === createEmptyWorkspaceSearchPlanDigest())
  ) {
    return failArtifact()
  }
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: requireIdentifier(record.runId),
    configurationHash: requireDigest(record.configurationHash),
    dryRunEvidenceDigest: requireDigest(record.dryRunEvidenceDigest),
    planningSnapshotDigest: requireDigest(record.planningSnapshotDigest),
    planDigest,
    planOperationCount,
    sourceOperationCount,
    orphanOperationCount,
    createdAt: requireTimestamp(record.createdAt),
  }
}

/**
 * Converts one raw planned operation into its lossless tagged representation.
 *
 * @param planned - Validated raw planned operation.
 * @returns JSON-safe encoded operation artifact.
 */
function encodePlannedOperation(planned: WorkspaceSearchPlannedOperation) {
  return {
    runId: planned.runId,
    configurationHash: planned.configurationHash,
    planDigest: planned.planDigest,
    planSequence: planned.planSequence,
    operationDigest: planned.operationDigest,
    membershipProof: planned.membershipProof.map((step) => ({
      side: step.side,
      digest: step.digest,
    })),
    operation: {
      operationId: planned.operation.operationId,
      sourceCondition: planned.operation.sourceCondition.exists
        ? {
            exists: true,
            source: planned.operation.sourceCondition.source,
            tableId: planned.operation.sourceCondition.tableId,
            tableName: planned.operation.sourceCondition.tableName,
            key: encodeAttributeMap(planned.operation.sourceCondition.key),
            keyDigest: planned.operation.sourceCondition.keyDigest,
            item: encodeAttributeMap(planned.operation.sourceCondition.item),
            itemDigest: planned.operation.sourceCondition.itemDigest,
          }
        : {
            exists: false,
            source: planned.operation.sourceCondition.source,
            tableId: planned.operation.sourceCondition.tableId,
            tableName: planned.operation.sourceCondition.tableName,
            key: encodeAttributeMap(planned.operation.sourceCondition.key),
            keyDigest: planned.operation.sourceCondition.keyDigest,
          },
      targetKey: encodeAttributeMap(planned.operation.targetKey),
      targetKeyDigest: planned.operation.targetKeyDigest,
      before: encodeSnapshot(planned.operation.before),
      after: encodeSnapshot(planned.operation.after),
      entityType: planned.operation.entityType,
    },
  }
}

/**
 * Converts one raw item snapshot into its lossless tagged representation.
 *
 * @param snapshot - Raw present or absent item snapshot.
 * @returns JSON-safe encoded snapshot.
 */
function encodeSnapshot(snapshot: MigrationItemSnapshot) {
  if (!snapshot.exists) {
    return {
      exists: false,
      digest: snapshot.digest,
    }
  }
  return {
    exists: true,
    item: encodeAttributeMap(snapshot.item),
    digest: snapshot.digest,
  }
}

/**
 * Validates runtime object shape before serializing a typed planned operation.
 *
 * @param value - Candidate typed object received at the runtime boundary.
 */
function requireRawPlannedOperationShape(
  value: WorkspaceSearchPlannedOperation,
): void {
  requireExactKeys(requireRecord(value), [
    'configurationHash',
    'membershipProof',
    'operation',
    'operationDigest',
    'planDigest',
    'planSequence',
    'runId',
  ])
  requireExactKeys(requireRecord(value.operation), [
    'after',
    'before',
    'entityType',
    'operationId',
    'sourceCondition',
    'targetKey',
    'targetKeyDigest',
  ])
  const source = value.operation.sourceCondition
  if (source.exists !== true && source.exists !== false) {
    return failArtifact()
  }
  requireExactKeys(
    requireRecord(source),
    source.exists
      ? [
          'exists',
          'item',
          'itemDigest',
          'key',
          'keyDigest',
          'source',
          'tableId',
          'tableName',
        ]
      : [
          'exists',
          'key',
          'keyDigest',
          'source',
          'tableId',
          'tableName',
        ],
  )
  requireRawSnapshotShape(value.operation.before)
  requireRawSnapshotShape(value.operation.after)
  for (const step of value.membershipProof) {
    requireExactKeys(requireRecord(step), ['digest', 'side'])
  }
}

/**
 * Validates runtime snapshot shape before serialization.
 *
 * @param snapshot - Candidate typed raw snapshot.
 */
function requireRawSnapshotShape(snapshot: MigrationItemSnapshot): void {
  if (snapshot.exists !== true && snapshot.exists !== false) {
    return failArtifact()
  }
  requireExactKeys(
    requireRecord(snapshot),
    snapshot.exists
      ? ['digest', 'exists', 'item']
      : ['digest', 'exists'],
  )
}

/**
 * Reads a strict encoded planned operation and reconstructs raw attributes.
 *
 * @param value - Candidate parsed tagged operation artifact.
 * @returns Fully validated planned operation.
 */
function readPlannedOperation(value: unknown): WorkspaceSearchPlannedOperation {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'configurationHash',
    'membershipProof',
    'operation',
    'operationDigest',
    'planDigest',
    'planSequence',
    'runId',
  ])
  const runId = requireIdentifier(record.runId)
  const configurationHash = requireDigest(record.configurationHash)
  const planDigest = requireDigest(record.planDigest)
  const planSequence = requirePositiveSafeInteger(record.planSequence)
  const operationDigest = requireDigest(record.operationDigest)
  const membershipProof = readMembershipProof(record.membershipProof)
  const operation = readOperation(record.operation)

  const expectedOperationId = createWorkspaceSearchOperationId({
    configurationHash,
    sourceTableId: operation.sourceCondition.tableId,
    sourceKeyDigest: operation.sourceCondition.keyDigest,
    targetKeyDigest: operation.targetKeyDigest,
  })
  if (
    operation.operationId !== expectedOperationId ||
    createWorkspaceSearchMigrationOperationDigest(operation) !==
      operationDigest
  ) {
    return failArtifact()
  }
  validatePlanMembership(
    planDigest,
    planSequence,
    operationDigest,
    membershipProof,
  )

  return {
    runId,
    configurationHash,
    planDigest,
    planSequence,
    operationDigest,
    membershipProof,
    operation,
  }
}

/**
 * Reads one exact encoded migration operation.
 *
 * @param value - Candidate encoded operation.
 * @returns Raw operation with lossless DynamoDB attributes.
 */
function readOperation(value: unknown): WorkspaceSearchMigrationOperation {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'after',
    'before',
    'entityType',
    'operationId',
    'sourceCondition',
    'targetKey',
    'targetKeyDigest',
  ])
  const sourceCondition = readSourceCondition(record.sourceCondition)
  const targetKey = decodeAttributeMap(record.targetKey)
  const targetKeyDigest = requireDigest(record.targetKeyDigest)
  if (createAttributeMapDigest(targetKey) !== targetKeyDigest) {
    return failArtifact()
  }
  return {
    operationId: requireDigest(record.operationId),
    sourceCondition,
    targetKey,
    targetKeyDigest,
    before: readSnapshot(record.before),
    after: readSnapshot(record.after),
    entityType: requireEntityType(record.entityType),
  }
}

/**
 * Reads one present or absent source condition.
 *
 * @param value - Candidate encoded source condition.
 * @returns Raw source condition with exact DynamoDB attributes.
 */
function readSourceCondition(value: unknown): MigrationSourceCondition {
  const record = requireRecord(value)
  const exists = record.exists
  const source = requireSourceName(record.source)
  const tableId = requireNonBlankText(record.tableId)
  const tableName = requireNonBlankText(record.tableName)
  const key = decodeAttributeMap(record.key)
  const keyDigest = requireDigest(record.keyDigest)
  if (createAttributeMapDigest(key) !== keyDigest) {
    return failArtifact()
  }

  if (exists === false) {
    requireExactKeys(record, [
      'exists',
      'key',
      'keyDigest',
      'source',
      'tableId',
      'tableName',
    ])
    return {
      exists: false,
      source,
      tableId,
      tableName,
      key,
      keyDigest,
    }
  }
  if (exists !== true) {
    return failArtifact()
  }
  requireExactKeys(record, [
    'exists',
    'item',
    'itemDigest',
    'key',
    'keyDigest',
    'source',
    'tableId',
    'tableName',
  ])
  const item = decodeAttributeMap(record.item)
  validateDynamoDbItemSize(item)
  const itemDigest = requireDigest(record.itemDigest)
  if (createAttributeMapDigest(item) !== itemDigest) {
    return failArtifact()
  }
  return {
    exists: true,
    source,
    tableId,
    tableName,
    key,
    keyDigest,
    item,
    itemDigest,
  }
}

/**
 * Reads one present or absent raw item snapshot.
 *
 * @param value - Candidate encoded snapshot.
 * @returns Exact raw snapshot.
 */
function readSnapshot(value: unknown): MigrationItemSnapshot {
  const record = requireRecord(value)
  if (record.exists === false) {
    requireExactKeys(record, ['digest', 'exists'])
    const digest = requireDigest(record.digest)
    if (digest !== createAbsentMigrationItemDigest()) {
      return failArtifact()
    }
    return {
      exists: false,
      digest,
    }
  }
  if (record.exists !== true) {
    return failArtifact()
  }
  requireExactKeys(record, ['digest', 'exists', 'item'])
  const item = decodeAttributeMap(record.item)
  validateDynamoDbItemSize(item)
  const digest = requireDigest(record.digest)
  if (createAttributeMapDigest(item) !== digest) {
    return failArtifact()
  }
  return {
    exists: true,
    item,
    digest,
  }
}

/**
 * Reads a bounded ordered Merkle membership proof.
 *
 * @param value - Candidate proof array.
 * @returns Canonical proof steps.
 */
function readMembershipProof(
  value: unknown,
): readonly WorkspaceSearchPlanMembershipProofStep[] {
  if (
    !hasCanonicalDenseArrayShape(value) ||
    value.length > maximumPlanMembershipProofSteps
  ) {
    return failArtifact()
  }
  return value.map((candidate) => {
    const record = requireRecord(candidate)
    requireExactKeys(record, ['digest', 'side'])
    if (record.side !== 'left' && record.side !== 'right') {
      return failArtifact()
    }
    return {
      side: record.side,
      digest: requireDigest(record.digest),
    }
  })
}

/**
 * Recomputes a planned operation's ordered Merkle path.
 *
 * @param planDigest - Reviewed plan root.
 * @param planSequence - One-based leaf position.
 * @param operationDigest - Exact encoded operation digest.
 * @param proof - Ordered sibling path.
 */
function validatePlanMembership(
  planDigest: string,
  planSequence: number,
  operationDigest: string,
  proof: readonly WorkspaceSearchPlanMembershipProofStep[],
): void {
  if (proof.length === 0 && planSequence !== 1) {
    return failArtifact()
  }
  let node = createWorkspaceSearchPlanLeafDigest({
    planSequence,
    operationDigest,
  })
  let zeroBasedIndex = planSequence - 1
  for (const step of proof) {
    const currentIsLeft = zeroBasedIndex % 2 === 0
    if (
      step.side !== (currentIsLeft ? 'right' : 'left')
    ) {
      return failArtifact()
    }
    node = currentIsLeft
      ? createWorkspaceSearchPlanNodeDigest(node, step.digest)
      : createWorkspaceSearchPlanNodeDigest(step.digest, node)
    zeroBasedIndex = Math.floor(zeroBasedIndex / 2)
  }
  if (zeroBasedIndex !== 0 || node !== planDigest) {
    return failArtifact()
  }
}

/**
 * Requires one supported Workspace Search migration source name.
 *
 * @param value - Candidate source name.
 * @returns Validated source name.
 */
function requireSourceName(value: unknown): WorkspaceSearchMigrationSourceName {
  for (const source of workspaceSearchMigrationSourceNames) {
    if (value === source) return source
  }
  return failArtifact()
}

/**
 * Requires one migration-owned Search entity type.
 *
 * @param value - Candidate entity type.
 * @returns Validated entity type.
 */
function requireEntityType(
  value: unknown,
): WorkspaceSearchMigrationOperation['entityType'] {
  if (
    value === 'comment' ||
    value === 'document' ||
    value === 'project' ||
    value === 'team' ||
    value === 'work-item'
  ) {
    return value
  }
  return failArtifact()
}

/**
 * Requires a safe operator-selected migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Validated identifier.
 */
function requireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failArtifact()
  }
  return value
}

/**
 * Requires exact nonblank bounded text.
 *
 * @param value - Candidate text.
 * @returns Validated text.
 */
function requireNonBlankText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value !== value.trim() ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failArtifact()
  }
  return value
}

/**
 * Requires a conventional lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function requireDigest(value: unknown): string {
  if (!isHexDigest(value)) return failArtifact()
  return value
}

/**
 * Requires a canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function requireTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failArtifact()
  return value
}

/**
 * Requires a nonnegative safe integer.
 *
 * @param value - Candidate count.
 * @returns Validated count.
 */
function requireNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failArtifact()
  }
  return value
}

/**
 * Requires a positive safe integer.
 *
 * @param value - Candidate sequence.
 * @returns Validated sequence.
 */
function requirePositiveSafeInteger(value: unknown): number {
  const parsed = requireNonNegativeSafeInteger(value)
  if (parsed === 0) return failArtifact()
  return parsed
}

/**
 * Parses one bounded artifact as strict UTF-8 JSON.
 *
 * @param bytes - Candidate exact bytes.
 * @param maximumBytes - Inclusive artifact-specific byte ceiling.
 * @returns Untrusted parsed JSON value.
 */
function parseArtifactJson(
  bytes: Uint8Array,
  maximumBytes = WORKSPACE_SEARCH_MIGRATION_ARTIFACT_MAX_BYTES,
): unknown {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes
  ) {
    return failArtifact()
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failArtifact()
  }
  try {
    return JSON.parse(text)
  } catch {
    return failArtifact()
  }
}

/**
 * Encodes canonical JSON while enforcing the artifact byte bound.
 *
 * @param value - Validated JSON-safe artifact value.
 * @param maximumBytes - Inclusive artifact-specific byte ceiling.
 * @returns Exact canonical UTF-8 bytes.
 */
function encodeCanonicalArtifact(
  value: unknown,
  maximumBytes = WORKSPACE_SEARCH_MIGRATION_ARTIFACT_MAX_BYTES,
): Uint8Array {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(value))
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes
  ) {
    return failArtifact()
  }
  return bytes
}

/**
 * Requires exact byte-for-byte canonical JSON representation.
 *
 * @param actual - Original untrusted artifact bytes.
 * @param value - Reconstructed JSON-safe canonical value.
 * @param maximumBytes - Inclusive artifact-specific byte ceiling.
 */
function requireCanonicalArtifactBytes(
  actual: Uint8Array,
  value: unknown,
  maximumBytes = WORKSPACE_SEARCH_MIGRATION_ARTIFACT_MAX_BYTES,
): void {
  const expected = encodeCanonicalArtifact(value, maximumBytes)
  if (!Buffer.from(expected).equals(Buffer.from(actual))) {
    return failArtifact()
  }
}

/**
 * Requires one plain validation record.
 *
 * @param value - Candidate value.
 * @returns Plain string-keyed record.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return failArtifact()
  return value
}

/**
 * Checks whether a value is a plain non-array record.
 *
 * @param value - Candidate value.
 * @returns Whether the value is suitable for strict field validation.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Requires exactly the listed object fields.
 *
 * @param record - Candidate record.
 * @param expected - Complete expected field list.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(record).sort()
  const sortedExpected = [...expected].sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    return failArtifact()
  }
}

/**
 * Converts every internal validation error into the stable artifact boundary.
 *
 * @param error - Internal parse, contract, or attribute-codec failure.
 * @returns Never returns.
 */
function wrapArtifactFailure(error: unknown): never {
  void error
  throw new WorkspaceSearchMigrationArtifactError()
}

/**
 * Raises the stable raw-value-free artifact failure.
 *
 * @returns Never returns.
 */
function failArtifact(): never {
  throw new WorkspaceSearchMigrationArtifactError()
}
