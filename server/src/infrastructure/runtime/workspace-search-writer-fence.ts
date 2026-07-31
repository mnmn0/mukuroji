import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import type {
  AttributeValue,
  GetItemCommandInput,
  TransactWriteItem,
} from '@aws-sdk/client-dynamodb'

const writerFenceKind = 'workspace-search-application-writer-fence'
const writerFenceInitialVersion = 1
const writerFenceReleasedVersion = 2
const writerFenceReleaseVersion = 1
const stateIncarnationDigestVersion = 1
const writerFenceMigrationId = 'workspace-search-maintenance'
const writerFenceRecordKeyPrefix = 'application-writer-fence/v1'
const canonicalTimestampPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u
const lowercaseSha256Pattern = /^[0-9a-f]{64}$/u
const boundedIdentifierPattern = /^[\u0021-\u007e]+$/u
const dynamoTableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/u

/**
 * Fixed physical table roles covered by the Workspace Search writer fence.
 */
export const workspaceSearchWriterFenceTableRoles: readonly [
  'project-directory',
  'work-items',
  'collaboration',
  'documents',
  'workspace-search',
  'migration-state',
] = Object.freeze([
  'project-directory',
  'work-items',
  'collaboration',
  'documents',
  'workspace-search',
  'migration-state',
])

/**
 * Physical table role covered by the Workspace Search writer fence.
 */
export type WorkspaceSearchWriterFenceTableRole =
  typeof workspaceSearchWriterFenceTableRoles[number]

/**
 * Exact physical table identifiers covered by one writer-fence row.
 */
export type WorkspaceSearchWriterFenceTableIds = Readonly<
  Record<WorkspaceSearchWriterFenceTableRole, string>
>

/**
 * Immutable migration-state table identity used to derive its incarnation.
 */
export type WorkspaceSearchWriterFenceStateIdentity = {
  /** Logical role required for the writer-fence control table. */
  readonly role: 'migration-state'
  /** Exact physical migration-state table name. */
  readonly tableName: string
  /** AWS table ARN measured from the current physical table. */
  readonly tableArn: string
  /** Immutable DynamoDB TableId. */
  readonly tableId: string
  /** Canonical UTC physical table creation time. */
  readonly creationTime: string
  /** AWS account owning the physical table. */
  readonly account: string
  /** AWS region containing the physical table. */
  readonly region: string
}

/**
 * Measured storage and dataset identity used to address one global fence row.
 */
export type WorkspaceSearchWriterFenceBinding = {
  /** Exact physical migration-state table name used for DynamoDB requests. */
  readonly stateTableName: string
  /** Immutable physical migration-state TableId. */
  readonly stateTableId: string
  /** Digest of the complete measured migration-state table incarnation. */
  readonly stateIncarnationDigest: string
  /** Exact TableIds for all four sources, the target, and migration state. */
  readonly tableIds: WorkspaceSearchWriterFenceTableIds
  /** Digest of the five source/target TableIds, excluding migration state. */
  readonly datasetBindingDigest: string
  /** Deterministic sort key for this state and dataset incarnation. */
  readonly recordKey: string
}

/**
 * Input used to construct one measured writer-fence binding.
 */
export type CreateWorkspaceSearchWriterFenceBindingInput = {
  /** Exact physical migration-state table name. */
  readonly stateTableName: string
  /** Immutable physical migration-state TableId. */
  readonly stateTableId: string
  /** Digest of the complete measured migration-state table incarnation. */
  readonly stateIncarnationDigest: string
  /** Exact TableIds for all four sources, the target, and migration state. */
  readonly tableIds: WorkspaceSearchWriterFenceTableIds
}

/**
 * Current migration authority bound to one closed application-writer epoch.
 */
export type WorkspaceSearchWriterFenceAuthority = {
  /** Exact reviewed migration configuration digest. */
  readonly configurationHash: string
  /** Operator-selected migration run. */
  readonly runId: string
  /** Process-unique migration lease owner. */
  readonly ownerId: string
  /** Exact migration lease takeover fence. */
  readonly leaseFenceToken: number
  /** Digest of the immutable current maintenance-evidence receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
  /** Exact optimistic revision of the current receipt pointer. */
  readonly maintenanceEvidencePointerRevision: number
}

/**
 * Fields shared by open and closed writer-fence records.
 */
type WorkspaceSearchWriterFenceRecordBase = {
  /** Stable row discriminator. */
  readonly kind: typeof writerFenceKind
  /** Version of the canonical durable row schema. */
  readonly version:
    | typeof writerFenceInitialVersion
    | typeof writerFenceReleasedVersion
  /** Stable migration identifier stored inside canonical bytes. */
  readonly migrationId: typeof writerFenceMigrationId
  /** Deterministic sort key stored inside canonical bytes. */
  readonly recordKey: string
  /** Measured state and dataset binding expected by this record. */
  readonly binding: WorkspaceSearchWriterFenceBinding
  /** Epoch changed by every supported writer-fence transition. */
  readonly writerEpoch: number
  /** Revision changed for every durable control-row transition. */
  readonly controlRevision: number
  /** Exact canonical JSON persisted in the row. */
  readonly canonicalBytes: string
  /** Lowercase SHA-256 digest of `canonicalBytes`. */
  readonly recordDigest: string
}

/**
 * Exact terminal migration outcome that permits one writer-fence release.
 */
export type WorkspaceSearchWriterFenceTerminalOutcome =
  | {
      /** A successful immutable full-verification root authorizes release. */
      readonly kind: 'verified'
      /** Supported full-verification persistence schema version. */
      readonly persistenceVersion: 1
      /** Digest of the exact immutable verified root. */
      readonly rootDigest: string
    }
  | {
      /** A complete immutable rollback root authorizes release. */
      readonly kind: 'rolled-back'
      /** Supported complete or committed-prefix rollback schema version. */
      readonly persistenceVersion: 1 | 2
      /** Digest of the exact immutable rolled-back root. */
      readonly rootDigest: string
    }

/**
 * Immutable terminal evidence retained by one released writer epoch.
 */
export type WorkspaceSearchWriterFenceReleaseBinding = {
  /** Release-binding schema version. */
  readonly releaseVersion: typeof writerFenceReleaseVersion
  /** Exact reviewed migration configuration digest. */
  readonly configurationHash: string
  /** Operator-selected migration run that owned the closed interval. */
  readonly runId: string
  /** Digest of the exact planning-admitted execution boundary. */
  readonly executionBoundaryDigest: string
  /** Digest of the exact immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the exact immutable execution admission. */
  readonly executionRunDigest: string
  /** Exact immutable terminal outcome authorizing the release. */
  readonly terminal: WorkspaceSearchWriterFenceTerminalOutcome
}

/**
 * Durable row permitting application writers at one exact epoch.
 */
export type WorkspaceSearchWriterFenceInitialOpenRecordV1 =
  WorkspaceSearchWriterFenceRecordBase & {
    /** Initial open rows use the original durable schema. */
    readonly version: typeof writerFenceInitialVersion
    /** Open rows permit guarded application transactions. */
    readonly mode: 'open'
    /** Writer-fence v1 has one bootstrap writer epoch. */
    readonly writerEpoch: 1
    /** Writer-fence v1 has one bootstrap open revision. */
    readonly controlRevision: 1
    /** Canonical UTC time when this open epoch was committed. */
    readonly openedAt: string
    /** Writer-fence v1 supports only the initial bootstrap open row. */
    readonly previousClosedRecordDigest: null
  }

/**
 * Durable version-two row permitting writers after a terminal migration.
 */
export type WorkspaceSearchWriterFenceReleasedOpenRecordV2 =
  WorkspaceSearchWriterFenceRecordBase & {
    /** Released open rows use the terminal-bound durable schema. */
    readonly version: typeof writerFenceReleasedVersion
    /** Released rows permit newly acquired guarded application transactions. */
    readonly mode: 'open'
    /** Release advances the closed writer epoch exactly once. */
    readonly writerEpoch: 3
    /** Release advances the closed control revision exactly once. */
    readonly controlRevision: 3
    /** Canonical UTC time when the terminal-bound release was committed. */
    readonly openedAt: string
    /** Digest of the exact version-one closed predecessor. */
    readonly previousClosedRecordDigest: string
    /** Terminal evidence and execution identity authorizing the release. */
    readonly release: WorkspaceSearchWriterFenceReleaseBinding
  }

/**
 * Durable row permitting application writers at one exact supported epoch.
 */
export type WorkspaceSearchWriterFenceOpenRecord =
  | WorkspaceSearchWriterFenceInitialOpenRecordV1
  | WorkspaceSearchWriterFenceReleasedOpenRecordV2

/**
 * Durable row rejecting application writers during one maintenance interval.
 */
export type WorkspaceSearchWriterFenceClosedRecord =
  WorkspaceSearchWriterFenceRecordBase & {
    /** Closed rows use the original durable schema. */
    readonly version: typeof writerFenceInitialVersion
    /** Closed rows reject every normal application transaction. */
    readonly mode: 'closed'
    /** Writer-fence v1 has one closed writer epoch. */
    readonly writerEpoch: 2
    /** Writer-fence v1 has one closed revision. */
    readonly controlRevision: 2
    /** Canonical UTC time when this maintenance epoch was committed. */
    readonly closedAt: string
    /** Exact migration authority that owns the closed interval. */
    readonly authority: WorkspaceSearchWriterFenceAuthority
  }

/**
 * Strict durable Workspace Search writer-fence row.
 */
export type WorkspaceSearchWriterFenceRecord =
  | WorkspaceSearchWriterFenceClosedRecord
  | WorkspaceSearchWriterFenceOpenRecord

/**
 * Canonical initial open-row fields before storage identity is attached.
 */
type WorkspaceSearchWriterFenceInitialOpenRecordDraft = Omit<
  WorkspaceSearchWriterFenceInitialOpenRecordV1,
  'canonicalBytes' | 'recordDigest'
>

/**
 * Canonical released open-row fields before storage identity is attached.
 */
type WorkspaceSearchWriterFenceReleasedOpenRecordDraft = Omit<
  WorkspaceSearchWriterFenceReleasedOpenRecordV2,
  'canonicalBytes' | 'recordDigest'
>

/**
 * Canonical closed-row fields before storage identity is attached.
 */
type WorkspaceSearchWriterFenceClosedRecordDraft = Omit<
  WorkspaceSearchWriterFenceClosedRecord,
  'canonicalBytes' | 'recordDigest'
>

/**
 * Canonical semantic writer-fence row before storage identity is attached.
 */
type WorkspaceSearchWriterFenceRecordDraft =
  | WorkspaceSearchWriterFenceClosedRecordDraft
  | WorkspaceSearchWriterFenceInitialOpenRecordDraft
  | WorkspaceSearchWriterFenceReleasedOpenRecordDraft

/**
 * Strongly read writer-fence state for one exact measured binding.
 */
export type WorkspaceSearchWriterFenceObservation =
  | {
      /** No row exists at the exact incarnation-bound key. */
      readonly status: 'missing'
      /** Expected measured binding used to address the missing row. */
      readonly binding: WorkspaceSearchWriterFenceBinding
    }
  | {
      /** A strict canonical row exists at the exact key. */
      readonly status: 'present'
      /** Detached strict durable row. */
      readonly record: WorkspaceSearchWriterFenceRecord
    }

/**
 * Material prepended to one normal application DynamoDB transaction.
 */
export type WorkspaceSearchWriterFenceGuardMaterial = {
  /** Exact open-row condition check. */
  readonly conditionCheck: TransactWriteItem
  /** Stable secret-free fingerprint for logs, receipts, and tests. */
  readonly materialFingerprint: string
  /** Complete measured state-table identity committed by the incarnation digest. */
  readonly stateTableIdentity: WorkspaceSearchWriterFenceStateIdentity
  /** Exact writer epoch captured once for the application invocation. */
  readonly writerEpoch: number
  /** Exact control revision captured with the writer epoch. */
  readonly controlRevision: number
}

/**
 * Stable raw-value-free failure for invalid or closed writer-fence material.
 */
export class WorkspaceSearchWriterFenceError extends Error {
  /** Machine-readable failure code safe to expose across adapter boundaries. */
  readonly code = 'INVALID_WORKSPACE_SEARCH_WRITER_FENCE'

  /**
   * Creates one raw-value-free writer-fence failure.
   */
  constructor() {
    super('INVALID_WORKSPACE_SEARCH_WRITER_FENCE')
    this.name = 'WorkspaceSearchWriterFenceError'
  }
}

/**
 * Derives the exact migration-state table incarnation used by fence addressing.
 *
 * @param identity - Independently measured immutable state-table identity.
 * @returns Lowercase SHA-256 digest shared by operator and application code.
 */
export function createWorkspaceSearchWriterFenceStateIncarnationDigest(
  identity: WorkspaceSearchWriterFenceStateIdentity,
): string {
  return atFenceBoundary(() => {
    const strict = readStateIdentity(identity)
    return digestCanonicalValue({
      account: strict.account,
      creationTime: strict.creationTime,
      kind: 'workspace-search-migration-state-incarnation',
      region: strict.region,
      role: 'migration-state',
      tableArn: strict.tableArn,
      tableId: strict.tableId,
      tableName: strict.tableName,
      version: stateIncarnationDigestVersion,
    })
  })
}

/**
 * Constructs and detaches one exact measured writer-fence binding.
 *
 * @param input - State table and all six measured physical TableIds.
 * @returns Canonical binding and deterministic row key.
 */
export function createWorkspaceSearchWriterFenceBinding(
  input: CreateWorkspaceSearchWriterFenceBindingInput,
): WorkspaceSearchWriterFenceBinding {
  return atFenceBoundary(() => {
    const record = requireRecord(input)
    requireExactKeys(record, [
      'stateIncarnationDigest',
      'stateTableId',
      'stateTableName',
      'tableIds',
    ])
    const stateTableName = requireTableName(
      Reflect.get(record, 'stateTableName'),
    )
    const stateTableId = requireIdentifier(
      Reflect.get(record, 'stateTableId'),
    )
    const stateIncarnationDigest = requireDigest(
      Reflect.get(record, 'stateIncarnationDigest'),
    )
    const tableIds = readTableIds(Reflect.get(record, 'tableIds'))
    if (tableIds['migration-state'] !== stateTableId) return failFence()
    const distinctTableIds = new Set<string>()
    for (const role of workspaceSearchWriterFenceTableRoles) {
      distinctTableIds.add(tableIds[role])
    }
    if (distinctTableIds.size !== workspaceSearchWriterFenceTableRoles.length) {
      return failFence()
    }
    const datasetBindingDigest = digestCanonicalValue({
      collaboration: tableIds.collaboration,
      documents: tableIds.documents,
      projectDirectory: tableIds['project-directory'],
      workItems: tableIds['work-items'],
      workspaceSearch: tableIds['workspace-search'],
    })
    return {
      stateTableName,
      stateTableId,
      stateIncarnationDigest,
      tableIds,
      datasetBindingDigest,
      recordKey: [
        writerFenceRecordKeyPrefix,
        stateIncarnationDigest,
        datasetBindingDigest,
      ].join('/'),
    }
  })
}

/**
 * Creates the first exact open row for a binding being bootstrapped.
 *
 * Missing rows never authorize application writes. Operators must commit this
 * row conditionally before guarded application code can be enabled.
 *
 * @param binding - Exact measured state and dataset binding.
 * @param openedAt - Trusted bootstrap commit time.
 * @returns Canonical open row at epoch and revision one.
 */
export function createWorkspaceSearchWriterFenceInitialOpenRecord(
  binding: WorkspaceSearchWriterFenceBinding,
  openedAt: Date,
): WorkspaceSearchWriterFenceInitialOpenRecordV1 {
  return atFenceBoundary(() =>
    finalizeOpenRecord({
      binding: readBinding(binding),
      openedAt: readDate(openedAt),
    })
  )
}

/**
 * Closes one exact open epoch under fresh migration authority.
 *
 * @param predecessor - Exact open row read before the close transaction.
 * @param authority - Fresh lease and maintenance receipt owning the close.
 * @param closedAt - Trusted close commit time.
 * @returns Canonical closed successor with both counters incremented once.
 */
export function createWorkspaceSearchWriterFenceClosedSuccessor(
  predecessor: WorkspaceSearchWriterFenceInitialOpenRecordV1,
  authority: WorkspaceSearchWriterFenceAuthority,
  closedAt: Date,
): WorkspaceSearchWriterFenceClosedRecord {
  return atFenceBoundary(() => {
    const open = readInitialOpenRecord(predecessor)
    return finalizeClosedRecord({
      authority: readAuthority(authority),
      binding: open.binding,
      closedAt: readDate(closedAt),
    })
  })
}

/**
 * Releases one exact version-one closed epoch after a terminal migration.
 *
 * @param predecessor - Exact closed row consumed by the release transition.
 * @param release - Terminal root and immutable execution identities.
 * @param openedAt - Trusted release commit time.
 * @returns Canonical version-two open successor at epoch and revision three.
 */
export function createWorkspaceSearchWriterFenceReleasedOpenSuccessor(
  predecessor: WorkspaceSearchWriterFenceClosedRecord,
  release: WorkspaceSearchWriterFenceReleaseBinding,
  openedAt: Date,
): WorkspaceSearchWriterFenceReleasedOpenRecordV2 {
  return atFenceBoundary(() => {
    const closed = readClosedRecord(predecessor)
    const strictRelease = readReleaseBinding(release)
    const openedTimestamp = readDate(openedAt)
    if (
      strictRelease.configurationHash !==
        closed.authority.configurationHash ||
      strictRelease.runId !== closed.authority.runId ||
      Date.parse(openedTimestamp) < Date.parse(closed.closedAt)
    ) {
      return failFence()
    }
    return finalizeReleasedOpenRecord({
      binding: closed.binding,
      openedAt: openedTimestamp,
      previousClosedRecordDigest: closed.recordDigest,
      release: strictRelease,
    })
  })
}

/**
 * Encodes one strict record as the complete low-level DynamoDB item.
 *
 * @param record - Candidate open or closed canonical row.
 * @returns Four-attribute item with exact key, canonical bytes, and digest.
 */
export function encodeWorkspaceSearchWriterFenceRecord(
  record: WorkspaceSearchWriterFenceRecord,
): Readonly<Record<string, AttributeValue>> {
  return atFenceBoundary(() => {
    const strict = readFenceRecord(record)
    return {
      migrationId: { S: writerFenceMigrationId },
      recordKey: { S: strict.recordKey },
      canonicalBytes: { S: strict.canonicalBytes },
      recordDigest: { S: strict.recordDigest },
    }
  })
}

/**
 * Parses an absent or strict canonical low-level writer-fence item.
 *
 * @param item - Raw item returned by an exact strongly consistent GetItem.
 * @param expectedBinding - Independently measured current table identities.
 * @returns Missing observation or detached strict record.
 */
export function parseWorkspaceSearchWriterFenceObservation(
  item: Readonly<Record<string, AttributeValue>> | undefined,
  expectedBinding: WorkspaceSearchWriterFenceBinding,
): WorkspaceSearchWriterFenceObservation {
  return atFenceBoundary(() => {
    const binding = readBinding(expectedBinding)
    if (item === undefined) {
      return { status: 'missing', binding }
    }
    const rawItem = requireRecord(item)
    requireExactKeys(rawItem, [
      'canonicalBytes',
      'migrationId',
      'recordDigest',
      'recordKey',
    ])
    if (
      readStringAttribute(Reflect.get(rawItem, 'migrationId')) !==
        writerFenceMigrationId ||
      readStringAttribute(Reflect.get(rawItem, 'recordKey')) !==
        binding.recordKey
    ) {
      return failFence()
    }
    const canonicalBytes = readStringAttribute(
      Reflect.get(rawItem, 'canonicalBytes'),
    )
    const recordDigest = requireDigest(
      readStringAttribute(Reflect.get(rawItem, 'recordDigest')),
    )
    if (digestText(canonicalBytes) !== recordDigest) return failFence()
    const payload = parseCanonicalPayload(canonicalBytes)
    const record = readPayloadRecord(
      payload,
      binding,
      canonicalBytes,
      recordDigest,
    )
    if (createCanonicalBytes(record) !== canonicalBytes) return failFence()
    return { status: 'present', record }
  })
}

/**
 * Revalidates and detaches one exact closed writer-fence record.
 *
 * @param record - Candidate canonical closed record.
 * @returns Detached strict closed record safe to retain across later work.
 */
export function readWorkspaceSearchWriterFenceClosedRecord(
  record: WorkspaceSearchWriterFenceClosedRecord,
): WorkspaceSearchWriterFenceClosedRecord {
  return atFenceBoundary(() => readClosedRecord(record))
}

/**
 * Creates the exact strongly consistent GetItem input for one fence row.
 *
 * @param binding - Independently measured state and dataset binding.
 * @returns Strongly consistent full-item read material.
 */
export function createWorkspaceSearchWriterFenceReadMaterial(
  binding: WorkspaceSearchWriterFenceBinding,
): GetItemCommandInput {
  return atFenceBoundary(() => {
    const strict = readBinding(binding)
    return {
      TableName: strict.stateTableName,
      ConsistentRead: true,
      Key: createFenceKey(strict),
    }
  })
}

/**
 * Creates the conditional Put used for bootstrap, close, or release.
 *
 * @param predecessor - Exact missing or present state read before the write.
 * @param successor - Exact canonical successor being committed.
 * @returns One Put whose condition linearizes the complete transition.
 */
export function createWorkspaceSearchWriterFenceTransitionPut(
  predecessor: WorkspaceSearchWriterFenceObservation,
  successor: WorkspaceSearchWriterFenceRecord,
): TransactWriteItem {
  return atFenceBoundary(() => {
    const before = readObservation(predecessor)
    const after = readFenceRecord(successor)
    const beforeBinding = before.status === 'missing'
      ? before.binding
      : before.record.binding
    requireSameBinding(beforeBinding, after.binding)
    requireValidTransition(before, after)
    const put: NonNullable<TransactWriteItem['Put']> = {
      TableName: after.binding.stateTableName,
      Item: encodeWorkspaceSearchWriterFenceRecord(after),
      ...(before.status === 'missing'
        ? {
            ConditionExpression:
              'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
            ExpressionAttributeNames: {
              '#migrationId': 'migrationId',
              '#recordKey': 'recordKey',
            },
          }
        : {
            ConditionExpression:
              '#canonicalBytes = :canonicalBytes AND #recordDigest = :recordDigest',
            ExpressionAttributeNames: {
              '#canonicalBytes': 'canonicalBytes',
              '#recordDigest': 'recordDigest',
            },
            ExpressionAttributeValues: {
              ':canonicalBytes': { S: before.record.canonicalBytes },
              ':recordDigest': { S: before.record.recordDigest },
            },
          }),
      ReturnValuesOnConditionCheckFailure: 'NONE',
    }
    return { Put: put }
  })
}

/**
 * Creates the exact open-row check prepended to an application transaction.
 *
 * A missing or closed row always fails before command material is returned.
 * The expected binding must come from an independent current table measurement,
 * so a row cannot authorize itself after restore or replacement. DynamoDB does
 * not remeasure live TableIds inside this transaction; the external supervisor
 * must keep the measurement current and serialize physical table replacement.
 *
 * @param observation - Strongly read strict fence observation.
 * @param expectedBinding - Independently measured current table identities.
 * @param stateTableIdentity - Complete independently measured state identity.
 * @returns Exact condition and one-invocation token fingerprint.
 */
export function createWorkspaceSearchWriterFenceGuardMaterial(
  observation: WorkspaceSearchWriterFenceObservation,
  expectedBinding: WorkspaceSearchWriterFenceBinding,
  stateTableIdentity: WorkspaceSearchWriterFenceStateIdentity,
): WorkspaceSearchWriterFenceGuardMaterial {
  return atFenceBoundary(() => {
    const expected = readBinding(expectedBinding)
    const measuredStateIdentity = readStateIdentity(stateTableIdentity)
    requireStateIdentityMatchesBinding(measuredStateIdentity, expected)
    const observed = readObservation(observation)
    if (
      observed.status !== 'present' ||
      observed.record.mode !== 'open'
    ) {
      return failFence()
    }
    const open = readOpenRecord(observed.record)
    requireSameBinding(expected, open.binding)
    const conditionCheck:
      NonNullable<TransactWriteItem['ConditionCheck']> = {
        TableName: expected.stateTableName,
        Key: createFenceKey(expected),
        ConditionExpression:
          '#canonicalBytes = :canonicalBytes AND #recordDigest = :recordDigest',
        ExpressionAttributeNames: {
          '#canonicalBytes': 'canonicalBytes',
          '#recordDigest': 'recordDigest',
        },
        ExpressionAttributeValues: {
          ':canonicalBytes': { S: open.canonicalBytes },
          ':recordDigest': { S: open.recordDigest },
        },
        ReturnValuesOnConditionCheckFailure: 'NONE',
      }
    return {
      conditionCheck: { ConditionCheck: conditionCheck },
      materialFingerprint: digestCanonicalValue({
        datasetBindingDigest: expected.datasetBindingDigest,
        recordDigest: open.recordDigest,
        recordKey: expected.recordKey,
        stateIncarnationDigest: expected.stateIncarnationDigest,
        stateTableId: expected.stateTableId,
        stateTableName: expected.stateTableName,
      }),
      stateTableIdentity: measuredStateIdentity,
      writerEpoch: open.writerEpoch,
      controlRevision: open.controlRevision,
    }
  })
}

/**
 * Creates the exact closed-row check used by migration-control transactions.
 *
 * The caller must supply an independently measured binding. The returned
 * condition fixes the complete canonical closed record rather than trusting
 * only its epoch, revision, or authority fields.
 *
 * @param record - Exact strict closed row to keep current.
 * @param expectedBinding - Independently measured current table identities.
 * @returns One adapter-owned DynamoDB ConditionCheck transaction item.
 */
export function createWorkspaceSearchWriterFenceClosedConditionCheck(
  record: WorkspaceSearchWriterFenceClosedRecord,
  expectedBinding: WorkspaceSearchWriterFenceBinding,
): TransactWriteItem {
  return atFenceBoundary(() => {
    const closed = readClosedRecord(record)
    const expected = readBinding(expectedBinding)
    requireSameBinding(expected, closed.binding)
    const conditionCheck:
      NonNullable<TransactWriteItem['ConditionCheck']> = {
        TableName: expected.stateTableName,
        Key: createFenceKey(expected),
        ConditionExpression:
          '#canonicalBytes = :canonicalBytes AND #recordDigest = :recordDigest',
        ExpressionAttributeNames: {
          '#canonicalBytes': 'canonicalBytes',
          '#recordDigest': 'recordDigest',
        },
        ExpressionAttributeValues: {
          ':canonicalBytes': { S: closed.canonicalBytes },
          ':recordDigest': { S: closed.recordDigest },
        },
        ReturnValuesOnConditionCheckFailure: 'NONE',
      }
    return { ConditionCheck: conditionCheck }
  })
}

/**
 * Revalidates and detaches exact open-row application guard material.
 *
 * This public boundary prevents a forged closed-row condition from being
 * relabeled with open epoch metadata. It reconstructs the independently bound
 * durable row from canonical bytes and accepts only the exact guard material
 * that the open-row factory would emit.
 *
 * @param material - Candidate low-level application guard material.
 * @returns Detached strict open-row guard material.
 */
export function readWorkspaceSearchWriterFenceGuardMaterial(
  material: unknown,
): WorkspaceSearchWriterFenceGuardMaterial {
  return atFenceBoundary(() => {
    const candidate = requireRecord(material)
    requireExactKeys(candidate, [
      'conditionCheck',
      'controlRevision',
      'materialFingerprint',
      'stateTableIdentity',
      'writerEpoch',
    ])
    const stateTableIdentity = readStateIdentity(
      Reflect.get(candidate, 'stateTableIdentity'),
    )
    const wrapper = requireRecord(Reflect.get(candidate, 'conditionCheck'))
    requireExactKeys(wrapper, ['ConditionCheck'])
    const condition = requireRecord(Reflect.get(wrapper, 'ConditionCheck'))
    requireExactKeys(condition, [
      'ConditionExpression',
      'ExpressionAttributeNames',
      'ExpressionAttributeValues',
      'Key',
      'ReturnValuesOnConditionCheckFailure',
      'TableName',
    ])
    if (
      Reflect.get(condition, 'ConditionExpression') !==
        '#canonicalBytes = :canonicalBytes AND #recordDigest = :recordDigest' ||
      Reflect.get(condition, 'ReturnValuesOnConditionCheckFailure') !==
        'NONE'
    ) {
      return failFence()
    }
    const tableName = requireTableName(
      Reflect.get(condition, 'TableName'),
    )
    if (tableName !== stateTableIdentity.tableName) {
      return failFence()
    }
    const names = requireRecord(
      Reflect.get(condition, 'ExpressionAttributeNames'),
    )
    requireExactKeys(names, ['#canonicalBytes', '#recordDigest'])
    if (
      Reflect.get(names, '#canonicalBytes') !== 'canonicalBytes' ||
      Reflect.get(names, '#recordDigest') !== 'recordDigest'
    ) {
      return failFence()
    }
    const key = requireRecord(Reflect.get(condition, 'Key'))
    requireExactKeys(key, ['migrationId', 'recordKey'])
    const migrationId = readStringAttribute(
      Reflect.get(key, 'migrationId'),
    )
    const recordKey = readStringAttribute(Reflect.get(key, 'recordKey'))
    const values = requireRecord(
      Reflect.get(condition, 'ExpressionAttributeValues'),
    )
    requireExactKeys(values, [':canonicalBytes', ':recordDigest'])
    const canonicalBytes = readStringAttribute(
      Reflect.get(values, ':canonicalBytes'),
    )
    const recordDigest = requireDigest(readStringAttribute(
      Reflect.get(values, ':recordDigest'),
    ))
    const payload = parseCanonicalPayload(canonicalBytes)
    const payloadBinding = requireRecord(Reflect.get(payload, 'binding'))
    requireExactKeys(payloadBinding, [
      'datasetBindingDigest',
      'stateIncarnationDigest',
      'stateTableId',
      'tableIds',
    ])
    const binding = createWorkspaceSearchWriterFenceBinding({
      stateTableName: stateTableIdentity.tableName,
      stateTableId: requireIdentifier(
        Reflect.get(payloadBinding, 'stateTableId'),
      ),
      stateIncarnationDigest: requireDigest(
        Reflect.get(payloadBinding, 'stateIncarnationDigest'),
      ),
      tableIds: readTableIds(Reflect.get(payloadBinding, 'tableIds')),
    })
    requireStateIdentityMatchesBinding(stateTableIdentity, binding)
    if (
      migrationId !== writerFenceMigrationId ||
      recordKey !== binding.recordKey ||
      Reflect.get(payloadBinding, 'datasetBindingDigest') !==
        binding.datasetBindingDigest ||
      digestText(canonicalBytes) !== recordDigest
    ) {
      return failFence()
    }
    const observation = parseWorkspaceSearchWriterFenceObservation(
      {
        migrationId: { S: migrationId },
        recordKey: { S: recordKey },
        canonicalBytes: { S: canonicalBytes },
        recordDigest: { S: recordDigest },
      },
      binding,
    )
    const expected = createWorkspaceSearchWriterFenceGuardMaterial(
      observation,
      binding,
      stateTableIdentity,
    )
    if (
      Reflect.get(candidate, 'materialFingerprint') !==
        expected.materialFingerprint ||
      Reflect.get(candidate, 'writerEpoch') !== expected.writerEpoch ||
      Reflect.get(candidate, 'controlRevision') !==
        expected.controlRevision
    ) {
      return failFence()
    }
    return expected
  })
}

/**
 * Determines whether one durable closed row represents the same logical close.
 *
 * The close timestamp is intentionally excluded so a process restart can
 * recover the original durable identity without sampling a replacement time.
 *
 * @param record - Durable strict closed row.
 * @param binding - Independently measured current table identities.
 * @param authority - Stable current migration authority.
 * @returns Whether the durable row is the same logical close.
 */
export function workspaceSearchWriterFenceClosedRecordMatchesAuthority(
  record: WorkspaceSearchWriterFenceClosedRecord,
  binding: WorkspaceSearchWriterFenceBinding,
  authority: WorkspaceSearchWriterFenceAuthority,
): boolean {
  try {
    const closed = readClosedRecord(record)
    const expectedBinding = readBinding(binding)
    const expectedAuthority = readAuthority(authority)
    requireSameBinding(closed.binding, expectedBinding)
    return equalAuthority(closed.authority, expectedAuthority)
  } catch {
    return false
  }
}

/**
 * Determines whether one released open row represents the same logical release.
 *
 * The release timestamp is intentionally excluded so concurrent callers and a
 * restarted process can recover the single durable successor committed first.
 *
 * @param record - Durable strict version-two released open row.
 * @param binding - Independently measured current table identities.
 * @param release - Stable terminal and execution release identity.
 * @returns Whether the durable row is the same logical release.
 */
export function workspaceSearchWriterFenceReleasedOpenRecordMatchesRelease(
  record: WorkspaceSearchWriterFenceReleasedOpenRecordV2,
  binding: WorkspaceSearchWriterFenceBinding,
  release: WorkspaceSearchWriterFenceReleaseBinding,
): boolean {
  try {
    const released = readReleasedOpenRecord(record)
    const expectedBinding = readBinding(binding)
    const expectedRelease = readReleaseBinding(release)
    requireSameBinding(released.binding, expectedBinding)
    return equalReleaseBinding(released.release, expectedRelease)
  } catch {
    return false
  }
}

/**
 * Input fields used to finalize one open row.
 */
type FinalizeOpenRecordInput = {
  /** Exact measured table binding. */
  readonly binding: WorkspaceSearchWriterFenceBinding
  /** Canonical open time. */
  readonly openedAt: string
}

/**
 * Input fields used to finalize one released open row.
 */
type FinalizeReleasedOpenRecordInput = {
  /** Exact measured table binding. */
  readonly binding: WorkspaceSearchWriterFenceBinding
  /** Canonical release-open time. */
  readonly openedAt: string
  /** Digest of the exact closed predecessor. */
  readonly previousClosedRecordDigest: string
  /** Exact terminal and execution release identity. */
  readonly release: WorkspaceSearchWriterFenceReleaseBinding
}

/**
 * Input fields used to finalize one closed row.
 */
type FinalizeClosedRecordInput = {
  /** Fresh migration authority owning the closed interval. */
  readonly authority: WorkspaceSearchWriterFenceAuthority
  /** Exact measured table binding. */
  readonly binding: WorkspaceSearchWriterFenceBinding
  /** Canonical close time. */
  readonly closedAt: string
}

/**
 * Creates one canonical open record and its exact digest.
 *
 * @param input - Validated open fields.
 * @returns Detached canonical open record.
 */
function finalizeOpenRecord(
  input: FinalizeOpenRecordInput,
): WorkspaceSearchWriterFenceInitialOpenRecordV1 {
  const draft: WorkspaceSearchWriterFenceInitialOpenRecordDraft = {
    kind: writerFenceKind,
    version: writerFenceInitialVersion,
    migrationId: writerFenceMigrationId,
    recordKey: input.binding.recordKey,
    binding: readBinding(input.binding),
    mode: 'open',
    writerEpoch: 1,
    controlRevision: 1,
    openedAt: requireTimestamp(input.openedAt),
    previousClosedRecordDigest: null,
  }
  const canonicalBytes = createCanonicalBytes(draft)
  return {
    ...draft,
    canonicalBytes,
    recordDigest: digestText(canonicalBytes),
  }
}

/**
 * Creates one canonical released open record and its exact digest.
 *
 * @param input - Validated released-open fields.
 * @returns Detached canonical version-two open record.
 */
function finalizeReleasedOpenRecord(
  input: FinalizeReleasedOpenRecordInput,
): WorkspaceSearchWriterFenceReleasedOpenRecordV2 {
  const draft: WorkspaceSearchWriterFenceReleasedOpenRecordDraft = {
    kind: writerFenceKind,
    version: writerFenceReleasedVersion,
    migrationId: writerFenceMigrationId,
    recordKey: input.binding.recordKey,
    binding: readBinding(input.binding),
    mode: 'open',
    writerEpoch: 3,
    controlRevision: 3,
    openedAt: requireTimestamp(input.openedAt),
    previousClosedRecordDigest: requireDigest(
      input.previousClosedRecordDigest,
    ),
    release: readReleaseBinding(input.release),
  }
  const canonicalBytes = createCanonicalBytes(draft)
  return {
    ...draft,
    canonicalBytes,
    recordDigest: digestText(canonicalBytes),
  }
}

/**
 * Creates one canonical closed record and its exact digest.
 *
 * @param input - Validated closed fields.
 * @returns Detached canonical closed record.
 */
function finalizeClosedRecord(
  input: FinalizeClosedRecordInput,
): WorkspaceSearchWriterFenceClosedRecord {
  const draft: WorkspaceSearchWriterFenceClosedRecordDraft = {
    kind: writerFenceKind,
    version: writerFenceInitialVersion,
    migrationId: writerFenceMigrationId,
    recordKey: input.binding.recordKey,
    binding: readBinding(input.binding),
    mode: 'closed',
    writerEpoch: 2,
    controlRevision: 2,
    closedAt: requireTimestamp(input.closedAt),
    authority: readAuthority(input.authority),
  }
  const canonicalBytes = createCanonicalBytes(draft)
  return {
    ...draft,
    canonicalBytes,
    recordDigest: digestText(canonicalBytes),
  }
}

/**
 * Rebuilds and validates one candidate record.
 *
 * @param value - Candidate open or closed runtime object.
 * @returns Detached strict record.
 */
function readFenceRecord(value: unknown): WorkspaceSearchWriterFenceRecord {
  const record = requireRecord(value)
  const mode = Reflect.get(record, 'mode')
  if (mode === 'open') return readOpenRecord(record)
  if (mode === 'closed') return readClosedRecord(record)
  return failFence()
}

/**
 * Rebuilds one strict open runtime object.
 *
 * @param value - Candidate open record.
 * @returns Detached strict open record.
 */
function readOpenRecord(value: unknown): WorkspaceSearchWriterFenceOpenRecord {
  const record = requireRecord(value)
  const version = Reflect.get(record, 'version')
  if (version === writerFenceInitialVersion) {
    return readInitialOpenRecord(record)
  }
  if (version === writerFenceReleasedVersion) {
    return readReleasedOpenRecord(record)
  }
  return failFence()
}

/**
 * Rebuilds one strict version-one initial open runtime object.
 *
 * @param value - Candidate initial open record.
 * @returns Detached strict version-one initial open record.
 */
function readInitialOpenRecord(
  value: unknown,
): WorkspaceSearchWriterFenceInitialOpenRecordV1 {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'binding',
    'canonicalBytes',
    'controlRevision',
    'kind',
    'migrationId',
    'mode',
    'openedAt',
    'previousClosedRecordDigest',
    'recordDigest',
    'recordKey',
    'version',
    'writerEpoch',
  ])
  if (
    Reflect.get(record, 'kind') !== writerFenceKind ||
    Reflect.get(record, 'version') !== writerFenceInitialVersion ||
    Reflect.get(record, 'migrationId') !== writerFenceMigrationId ||
    Reflect.get(record, 'mode') !== 'open'
  ) {
    return failFence()
  }
  const binding = readBinding(Reflect.get(record, 'binding'))
  if (Reflect.get(record, 'recordKey') !== binding.recordKey) {
    return failFence()
  }
  const controlRevision = requirePositiveSafeInteger(
    Reflect.get(record, 'controlRevision'),
  )
  const previousClosedRecordDigest = Reflect.get(
    record,
    'previousClosedRecordDigest',
  )
  const writerEpoch = requirePositiveSafeInteger(
    Reflect.get(record, 'writerEpoch'),
  )
  if (
    controlRevision !== 1 ||
    previousClosedRecordDigest !== null ||
    writerEpoch !== 1
  ) {
    return failFence()
  }
  const rebuilt = finalizeOpenRecord({
    binding,
    openedAt: requireTimestamp(Reflect.get(record, 'openedAt')),
  })
  requireStoredCanonicalIdentity(record, rebuilt)
  return rebuilt
}

/**
 * Rebuilds one strict version-two released open runtime object.
 *
 * @param value - Candidate released open record.
 * @returns Detached strict version-two released open record.
 */
function readReleasedOpenRecord(
  value: unknown,
): WorkspaceSearchWriterFenceReleasedOpenRecordV2 {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'binding',
    'canonicalBytes',
    'controlRevision',
    'kind',
    'migrationId',
    'mode',
    'openedAt',
    'previousClosedRecordDigest',
    'recordDigest',
    'recordKey',
    'release',
    'version',
    'writerEpoch',
  ])
  if (
    Reflect.get(record, 'kind') !== writerFenceKind ||
    Reflect.get(record, 'version') !== writerFenceReleasedVersion ||
    Reflect.get(record, 'migrationId') !== writerFenceMigrationId ||
    Reflect.get(record, 'mode') !== 'open' ||
    Reflect.get(record, 'controlRevision') !== 3 ||
    Reflect.get(record, 'writerEpoch') !== 3
  ) {
    return failFence()
  }
  const binding = readBinding(Reflect.get(record, 'binding'))
  if (Reflect.get(record, 'recordKey') !== binding.recordKey) {
    return failFence()
  }
  const rebuilt = finalizeReleasedOpenRecord({
    binding,
    openedAt: requireTimestamp(Reflect.get(record, 'openedAt')),
    previousClosedRecordDigest: requireDigest(
      Reflect.get(record, 'previousClosedRecordDigest'),
    ),
    release: readReleaseBinding(Reflect.get(record, 'release')),
  })
  requireStoredCanonicalIdentity(record, rebuilt)
  return rebuilt
}

/**
 * Rebuilds one strict closed runtime object.
 *
 * @param value - Candidate closed record.
 * @returns Detached strict closed record.
 */
function readClosedRecord(
  value: unknown,
): WorkspaceSearchWriterFenceClosedRecord {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'authority',
    'binding',
    'canonicalBytes',
    'closedAt',
    'controlRevision',
    'kind',
    'migrationId',
    'mode',
    'recordDigest',
    'recordKey',
    'version',
    'writerEpoch',
  ])
  if (
    Reflect.get(record, 'kind') !== writerFenceKind ||
    Reflect.get(record, 'version') !== writerFenceInitialVersion ||
    Reflect.get(record, 'migrationId') !== writerFenceMigrationId ||
    Reflect.get(record, 'mode') !== 'closed'
  ) {
    return failFence()
  }
  const binding = readBinding(Reflect.get(record, 'binding'))
  if (Reflect.get(record, 'recordKey') !== binding.recordKey) {
    return failFence()
  }
  if (
    Reflect.get(record, 'controlRevision') !== 2 ||
    Reflect.get(record, 'writerEpoch') !== 2
  ) {
    return failFence()
  }
  const rebuilt = finalizeClosedRecord({
    authority: readAuthority(Reflect.get(record, 'authority')),
    binding,
    closedAt: requireTimestamp(Reflect.get(record, 'closedAt')),
  })
  requireStoredCanonicalIdentity(record, rebuilt)
  return rebuilt
}

/**
 * Verifies caller-supplied canonical bytes and digest against one rebuilt row.
 *
 * @param input - Candidate runtime record.
 * @param rebuilt - Strict record rebuilt from semantic fields.
 */
function requireStoredCanonicalIdentity(
  input: Readonly<Record<string, unknown>>,
  rebuilt: WorkspaceSearchWriterFenceRecord,
): void {
  if (
    Reflect.get(input, 'canonicalBytes') !== rebuilt.canonicalBytes ||
    Reflect.get(input, 'recordDigest') !== rebuilt.recordDigest
  ) {
    return failFence()
  }
}

/**
 * Reads a strict observation object.
 *
 * @param value - Candidate missing or present observation.
 * @returns Detached strict observation.
 */
function readObservation(
  value: unknown,
): WorkspaceSearchWriterFenceObservation {
  const record = requireRecord(value)
  const status = Reflect.get(record, 'status')
  if (status === 'missing') {
    requireExactKeys(record, ['binding', 'status'])
    return {
      status: 'missing',
      binding: readBinding(Reflect.get(record, 'binding')),
    }
  }
  if (status === 'present') {
    requireExactKeys(record, ['record', 'status'])
    return {
      status: 'present',
      record: readFenceRecord(Reflect.get(record, 'record')),
    }
  }
  return failFence()
}

/**
 * Reads and detaches one complete migration-state table identity.
 *
 * @param value - Candidate independently measured state identity.
 * @returns Strict detached identity committed by the incarnation digest.
 */
function readStateIdentity(
  value: unknown,
): WorkspaceSearchWriterFenceStateIdentity {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'account',
    'creationTime',
    'region',
    'role',
    'tableArn',
    'tableId',
    'tableName',
  ])
  if (Reflect.get(record, 'role') !== 'migration-state') {
    return failFence()
  }
  return {
    role: 'migration-state',
    tableName: requireTableName(Reflect.get(record, 'tableName')),
    tableArn: requireIdentifier(Reflect.get(record, 'tableArn'), 2_048),
    tableId: requireIdentifier(Reflect.get(record, 'tableId'), 1_024),
    creationTime: requireTimestamp(Reflect.get(record, 'creationTime')),
    account: requireIdentifier(Reflect.get(record, 'account'), 64),
    region: requireIdentifier(Reflect.get(record, 'region'), 64),
  }
}

/**
 * Reads and reconstructs one strict binding.
 *
 * @param value - Candidate measured binding.
 * @returns Detached strict binding.
 */
function readBinding(value: unknown): WorkspaceSearchWriterFenceBinding {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'datasetBindingDigest',
    'recordKey',
    'stateIncarnationDigest',
    'stateTableId',
    'stateTableName',
    'tableIds',
  ])
  const rebuilt = createWorkspaceSearchWriterFenceBinding({
    stateTableName: requireTableName(
      Reflect.get(record, 'stateTableName'),
    ),
    stateTableId: requireIdentifier(
      Reflect.get(record, 'stateTableId'),
    ),
    stateIncarnationDigest: requireDigest(
      Reflect.get(record, 'stateIncarnationDigest'),
    ),
    tableIds: readTableIds(Reflect.get(record, 'tableIds')),
  })
  if (
    Reflect.get(record, 'datasetBindingDigest') !==
      rebuilt.datasetBindingDigest ||
    Reflect.get(record, 'recordKey') !== rebuilt.recordKey
  ) {
    return failFence()
  }
  return rebuilt
}

/**
 * Reads and detaches one exact close authority.
 *
 * @param value - Candidate authority.
 * @returns Strict detached authority.
 */
function readAuthority(value: unknown): WorkspaceSearchWriterFenceAuthority {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'configurationHash',
    'leaseFenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
    'runId',
  ])
  return {
    configurationHash: requireDigest(
      Reflect.get(record, 'configurationHash'),
    ),
    runId: requireIdentifier(Reflect.get(record, 'runId')),
    ownerId: requireIdentifier(Reflect.get(record, 'ownerId')),
    leaseFenceToken: requirePositiveSafeInteger(
      Reflect.get(record, 'leaseFenceToken'),
    ),
    maintenanceEvidenceReceiptDigest: requireDigest(
      Reflect.get(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    maintenanceEvidencePointerRevision: requirePositiveSafeInteger(
      Reflect.get(record, 'maintenanceEvidencePointerRevision'),
    ),
  }
}

/**
 * Reads and detaches one exact terminal release binding.
 *
 * @param value - Candidate release binding.
 * @returns Strict detached terminal and execution identity.
 */
function readReleaseBinding(
  value: unknown,
): WorkspaceSearchWriterFenceReleaseBinding {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'configurationHash',
    'executionBoundaryDigest',
    'executionRunDigest',
    'releaseVersion',
    'runId',
    'sealedPlanningAuthorityDigest',
    'terminal',
  ])
  if (Reflect.get(record, 'releaseVersion') !== writerFenceReleaseVersion) {
    return failFence()
  }
  return {
    releaseVersion: writerFenceReleaseVersion,
    configurationHash: requireDigest(
      Reflect.get(record, 'configurationHash'),
    ),
    runId: requireIdentifier(Reflect.get(record, 'runId')),
    executionBoundaryDigest: requireDigest(
      Reflect.get(record, 'executionBoundaryDigest'),
    ),
    sealedPlanningAuthorityDigest: requireDigest(
      Reflect.get(record, 'sealedPlanningAuthorityDigest'),
    ),
    executionRunDigest: requireDigest(
      Reflect.get(record, 'executionRunDigest'),
    ),
    terminal: readTerminalOutcome(Reflect.get(record, 'terminal')),
  }
}

/**
 * Reads one strict verified or completely rolled-back terminal identity.
 *
 * @param value - Candidate terminal outcome.
 * @returns Detached supported terminal outcome.
 */
function readTerminalOutcome(
  value: unknown,
): WorkspaceSearchWriterFenceTerminalOutcome {
  const record = requireRecord(value)
  requireExactKeys(record, ['kind', 'persistenceVersion', 'rootDigest'])
  const kind = Reflect.get(record, 'kind')
  const persistenceVersion = Reflect.get(record, 'persistenceVersion')
  const rootDigest = requireDigest(Reflect.get(record, 'rootDigest'))
  if (kind === 'verified' && persistenceVersion === 1) {
    return { kind, persistenceVersion, rootDigest }
  }
  if (
    kind === 'rolled-back' &&
    (persistenceVersion === 1 || persistenceVersion === 2)
  ) {
    return { kind, persistenceVersion, rootDigest }
  }
  return failFence()
}

/**
 * Reads all six TableIds with an exact role allowlist.
 *
 * @param value - Candidate TableId record.
 * @returns Detached exact TableIds.
 */
function readTableIds(value: unknown): WorkspaceSearchWriterFenceTableIds {
  const record = requireRecord(value)
  requireExactKeys(record, [...workspaceSearchWriterFenceTableRoles])
  return {
    'project-directory': requireIdentifier(
      Reflect.get(record, 'project-directory'),
    ),
    'work-items': requireIdentifier(Reflect.get(record, 'work-items')),
    collaboration: requireIdentifier(Reflect.get(record, 'collaboration')),
    documents: requireIdentifier(Reflect.get(record, 'documents')),
    'workspace-search': requireIdentifier(
      Reflect.get(record, 'workspace-search'),
    ),
    'migration-state': requireIdentifier(
      Reflect.get(record, 'migration-state'),
    ),
  }
}

/**
 * Parses canonical JSON into a plain payload record.
 *
 * @param canonicalBytes - Exact canonical JSON text.
 * @returns Parsed plain record.
 */
function parseCanonicalPayload(
  canonicalBytes: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(canonicalBytes)
  } catch {
    return failFence()
  }
  return requireRecord(parsed)
}

/**
 * Rebuilds a durable record from canonical payload bytes.
 *
 * @param payload - Parsed canonical payload.
 * @param binding - Independently measured expected binding.
 * @param canonicalBytes - Exact stored canonical JSON.
 * @param recordDigest - Exact stored SHA-256 digest.
 * @returns Detached strict durable record.
 */
function readPayloadRecord(
  payload: Readonly<Record<string, unknown>>,
  binding: WorkspaceSearchWriterFenceBinding,
  canonicalBytes: string,
  recordDigest: string,
): WorkspaceSearchWriterFenceRecord {
  const mode = Reflect.get(payload, 'mode')
  if (mode === 'open') {
    const version = Reflect.get(payload, 'version')
    if (version === writerFenceInitialVersion) {
      return readInitialOpenPayloadRecord(
        payload,
        binding,
        canonicalBytes,
        recordDigest,
      )
    }
    if (version === writerFenceReleasedVersion) {
      return readReleasedOpenPayloadRecord(
        payload,
        binding,
        canonicalBytes,
        recordDigest,
      )
    }
    return failFence()
  }
  if (mode === 'closed') {
    requireExactKeys(payload, [
      'authority',
      'binding',
      'closedAt',
      'controlRevision',
      'kind',
      'migrationId',
      'mode',
      'recordKey',
      'version',
      'writerEpoch',
    ])
    const payloadBinding = readCanonicalBinding(
      Reflect.get(payload, 'binding'),
      binding,
    )
    if (
      Reflect.get(payload, 'controlRevision') !== 2 ||
      Reflect.get(payload, 'writerEpoch') !== 2
    ) {
      return failFence()
    }
    const record = finalizeClosedRecord({
      authority: readAuthority(Reflect.get(payload, 'authority')),
      binding: payloadBinding,
      closedAt: requireTimestamp(Reflect.get(payload, 'closedAt')),
    })
    requirePayloadIdentity(payload, record)
    if (
      record.canonicalBytes !== canonicalBytes ||
      record.recordDigest !== recordDigest
    ) {
      return failFence()
    }
    return record
  }
  return failFence()
}

/**
 * Rebuilds one version-one initial open record from canonical payload bytes.
 *
 * @param payload - Parsed canonical payload.
 * @param binding - Independently measured expected binding.
 * @param canonicalBytes - Exact stored canonical JSON.
 * @param recordDigest - Exact stored SHA-256 digest.
 * @returns Detached strict version-one initial open record.
 */
function readInitialOpenPayloadRecord(
  payload: Readonly<Record<string, unknown>>,
  binding: WorkspaceSearchWriterFenceBinding,
  canonicalBytes: string,
  recordDigest: string,
): WorkspaceSearchWriterFenceInitialOpenRecordV1 {
  requireExactKeys(payload, [
    'binding',
    'controlRevision',
    'kind',
    'migrationId',
    'mode',
    'openedAt',
    'previousClosedRecordDigest',
    'recordKey',
    'version',
    'writerEpoch',
  ])
  if (
    Reflect.get(payload, 'controlRevision') !== 1 ||
    Reflect.get(payload, 'previousClosedRecordDigest') !== null ||
    Reflect.get(payload, 'writerEpoch') !== 1
  ) {
    return failFence()
  }
  const record = finalizeOpenRecord({
    binding: readCanonicalBinding(Reflect.get(payload, 'binding'), binding),
    openedAt: requireTimestamp(Reflect.get(payload, 'openedAt')),
  })
  requirePayloadStorageIdentity(payload, record, canonicalBytes, recordDigest)
  return record
}

/**
 * Rebuilds one version-two released open record from canonical payload bytes.
 *
 * @param payload - Parsed canonical payload.
 * @param binding - Independently measured expected binding.
 * @param canonicalBytes - Exact stored canonical JSON.
 * @param recordDigest - Exact stored SHA-256 digest.
 * @returns Detached strict version-two released open record.
 */
function readReleasedOpenPayloadRecord(
  payload: Readonly<Record<string, unknown>>,
  binding: WorkspaceSearchWriterFenceBinding,
  canonicalBytes: string,
  recordDigest: string,
): WorkspaceSearchWriterFenceReleasedOpenRecordV2 {
  requireExactKeys(payload, [
    'binding',
    'controlRevision',
    'kind',
    'migrationId',
    'mode',
    'openedAt',
    'previousClosedRecordDigest',
    'recordKey',
    'release',
    'version',
    'writerEpoch',
  ])
  if (
    Reflect.get(payload, 'controlRevision') !== 3 ||
    Reflect.get(payload, 'writerEpoch') !== 3
  ) {
    return failFence()
  }
  const record = finalizeReleasedOpenRecord({
    binding: readCanonicalBinding(Reflect.get(payload, 'binding'), binding),
    openedAt: requireTimestamp(Reflect.get(payload, 'openedAt')),
    previousClosedRecordDigest: requireDigest(
      Reflect.get(payload, 'previousClosedRecordDigest'),
    ),
    release: readReleaseBinding(Reflect.get(payload, 'release')),
  })
  requirePayloadStorageIdentity(payload, record, canonicalBytes, recordDigest)
  return record
}

/**
 * Verifies canonical payload discriminators, bytes, and digest together.
 *
 * @param payload - Parsed semantic payload.
 * @param record - Strict record rebuilt from the payload.
 * @param canonicalBytes - Exact stored canonical JSON.
 * @param recordDigest - Exact stored canonical digest.
 */
function requirePayloadStorageIdentity(
  payload: Readonly<Record<string, unknown>>,
  record: WorkspaceSearchWriterFenceRecord,
  canonicalBytes: string,
  recordDigest: string,
): void {
  requirePayloadIdentity(payload, record)
  if (
    record.canonicalBytes !== canonicalBytes ||
    record.recordDigest !== recordDigest
  ) {
    return failFence()
  }
}

/**
 * Reads the canonical binding payload and compares it to current measurement.
 *
 * @param value - Candidate payload binding without the physical table name.
 * @param expected - Independently measured expected binding.
 * @returns Detached expected binding when every persisted identity matches.
 */
function readCanonicalBinding(
  value: unknown,
  expected: WorkspaceSearchWriterFenceBinding,
): WorkspaceSearchWriterFenceBinding {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'datasetBindingDigest',
    'stateIncarnationDigest',
    'stateTableId',
    'tableIds',
  ])
  const candidate = createWorkspaceSearchWriterFenceBinding({
    stateTableName: expected.stateTableName,
    stateTableId: requireIdentifier(Reflect.get(record, 'stateTableId')),
    stateIncarnationDigest: requireDigest(
      Reflect.get(record, 'stateIncarnationDigest'),
    ),
    tableIds: readTableIds(Reflect.get(record, 'tableIds')),
  })
  if (
    Reflect.get(record, 'datasetBindingDigest') !==
      candidate.datasetBindingDigest
  ) {
    return failFence()
  }
  requireSameBinding(candidate, expected)
  return candidate
}

/**
 * Verifies stable payload discriminators and key.
 *
 * @param payload - Parsed payload.
 * @param record - Strict rebuilt record.
 */
function requirePayloadIdentity(
  payload: Readonly<Record<string, unknown>>,
  record: WorkspaceSearchWriterFenceRecord,
): void {
  if (
    Reflect.get(payload, 'kind') !== writerFenceKind ||
    Reflect.get(payload, 'version') !== record.version ||
    Reflect.get(payload, 'migrationId') !== writerFenceMigrationId ||
    Reflect.get(payload, 'recordKey') !== record.recordKey
  ) {
    return failFence()
  }
}

/**
 * Serializes one semantic row into its unique canonical JSON.
 *
 * @param record - Open or closed semantic row fields.
 * @returns Exact canonical JSON text.
 */
function createCanonicalBytes(
  record: WorkspaceSearchWriterFenceRecordDraft,
): string {
  const binding = {
    stateTableId: record.binding.stateTableId,
    stateIncarnationDigest: record.binding.stateIncarnationDigest,
    datasetBindingDigest: record.binding.datasetBindingDigest,
    tableIds: {
      collaboration: record.binding.tableIds.collaboration,
      documents: record.binding.tableIds.documents,
      'migration-state': record.binding.tableIds['migration-state'],
      'project-directory': record.binding.tableIds['project-directory'],
      'work-items': record.binding.tableIds['work-items'],
      'workspace-search': record.binding.tableIds['workspace-search'],
    },
  }
  if (record.mode === 'open') {
    if (record.version === writerFenceReleasedVersion) {
      return JSON.stringify({
        kind: writerFenceKind,
        version: writerFenceReleasedVersion,
        migrationId: writerFenceMigrationId,
        recordKey: record.recordKey,
        binding,
        mode: 'open',
        writerEpoch: record.writerEpoch,
        controlRevision: record.controlRevision,
        openedAt: record.openedAt,
        previousClosedRecordDigest: record.previousClosedRecordDigest,
        release: {
          releaseVersion: writerFenceReleaseVersion,
          configurationHash: record.release.configurationHash,
          runId: record.release.runId,
          executionBoundaryDigest:
            record.release.executionBoundaryDigest,
          sealedPlanningAuthorityDigest:
            record.release.sealedPlanningAuthorityDigest,
          executionRunDigest: record.release.executionRunDigest,
          terminal: {
            kind: record.release.terminal.kind,
            persistenceVersion:
              record.release.terminal.persistenceVersion,
            rootDigest: record.release.terminal.rootDigest,
          },
        },
      })
    }
    return JSON.stringify({
      kind: writerFenceKind,
      version: writerFenceInitialVersion,
      migrationId: writerFenceMigrationId,
      recordKey: record.recordKey,
      binding,
      mode: 'open',
      writerEpoch: record.writerEpoch,
      controlRevision: record.controlRevision,
      openedAt: record.openedAt,
      previousClosedRecordDigest: record.previousClosedRecordDigest,
    })
  }
  return JSON.stringify({
    kind: writerFenceKind,
    version: writerFenceInitialVersion,
    migrationId: writerFenceMigrationId,
    recordKey: record.recordKey,
    binding,
    mode: 'closed',
    writerEpoch: record.writerEpoch,
    controlRevision: record.controlRevision,
    closedAt: record.closedAt,
    authority: {
      configurationHash: record.authority.configurationHash,
      runId: record.authority.runId,
      ownerId: record.authority.ownerId,
      leaseFenceToken: record.authority.leaseFenceToken,
      maintenanceEvidenceReceiptDigest:
        record.authority.maintenanceEvidenceReceiptDigest,
      maintenanceEvidencePointerRevision:
        record.authority.maintenanceEvidencePointerRevision,
    },
  })
}

/**
 * Requires one valid bootstrap, close, or terminal-bound release transition.
 *
 * @param predecessor - Exact state observed before commit.
 * @param successor - Exact proposed successor.
 */
function requireValidTransition(
  predecessor: WorkspaceSearchWriterFenceObservation,
  successor: WorkspaceSearchWriterFenceRecord,
): void {
  if (predecessor.status === 'missing') {
    if (
      successor.mode !== 'open' ||
      successor.version !== writerFenceInitialVersion ||
      successor.writerEpoch !== 1 ||
      successor.controlRevision !== 1 ||
      successor.previousClosedRecordDigest !== null
    ) {
      return failFence()
    }
    return
  }
  const current = predecessor.record
  if (
    successor.writerEpoch !== incrementCounter(current.writerEpoch) ||
    successor.controlRevision !==
      incrementCounter(current.controlRevision)
  ) {
    return failFence()
  }
  if (
    current.mode === 'open' &&
    current.version === writerFenceInitialVersion &&
    successor.mode === 'closed'
  ) {
    return
  }
  if (
    current.mode === 'closed' &&
    successor.mode === 'open' &&
    successor.version === writerFenceReleasedVersion &&
    successor.previousClosedRecordDigest === current.recordDigest &&
    successor.release.configurationHash ===
      current.authority.configurationHash &&
    successor.release.runId === current.authority.runId
  ) {
    return
  }
  return failFence()
}

/**
 * Requires two bindings to represent the same current physical dataset.
 *
 * @param left - First binding.
 * @param right - Second binding.
 */
function requireSameBinding(
  left: WorkspaceSearchWriterFenceBinding,
  right: WorkspaceSearchWriterFenceBinding,
): void {
  if (
    left.stateTableName !== right.stateTableName ||
    left.stateTableId !== right.stateTableId ||
    left.stateIncarnationDigest !== right.stateIncarnationDigest ||
    left.datasetBindingDigest !== right.datasetBindingDigest ||
    left.recordKey !== right.recordKey
  ) {
    return failFence()
  }
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (left.tableIds[role] !== right.tableIds[role]) return failFence()
  }
}

/**
 * Requires one complete state identity to match its reconstructed binding.
 *
 * @param identity - Complete independently measured state-table identity.
 * @param binding - Binding committed by the durable canonical row.
 */
function requireStateIdentityMatchesBinding(
  identity: WorkspaceSearchWriterFenceStateIdentity,
  binding: WorkspaceSearchWriterFenceBinding,
): void {
  if (
    identity.tableName !== binding.stateTableName ||
    identity.tableId !== binding.stateTableId ||
    createWorkspaceSearchWriterFenceStateIncarnationDigest(identity) !==
      binding.stateIncarnationDigest
  ) {
    return failFence()
  }
}

/**
 * Compares two strict migration close authorities.
 *
 * @param left - First authority.
 * @param right - Second authority.
 * @returns Whether every stable authority field matches.
 */
function equalAuthority(
  left: WorkspaceSearchWriterFenceAuthority,
  right: WorkspaceSearchWriterFenceAuthority,
): boolean {
  return left.configurationHash === right.configurationHash &&
    left.runId === right.runId &&
    left.ownerId === right.ownerId &&
    left.leaseFenceToken === right.leaseFenceToken &&
    left.maintenanceEvidenceReceiptDigest ===
      right.maintenanceEvidenceReceiptDigest &&
    left.maintenanceEvidencePointerRevision ===
      right.maintenanceEvidencePointerRevision
}

/**
 * Compares two strict terminal release bindings.
 *
 * @param left - First release binding.
 * @param right - Second release binding.
 * @returns Whether every durable release identity field matches.
 */
function equalReleaseBinding(
  left: WorkspaceSearchWriterFenceReleaseBinding,
  right: WorkspaceSearchWriterFenceReleaseBinding,
): boolean {
  return left.releaseVersion === right.releaseVersion &&
    left.configurationHash === right.configurationHash &&
    left.runId === right.runId &&
    left.executionBoundaryDigest === right.executionBoundaryDigest &&
    left.sealedPlanningAuthorityDigest ===
      right.sealedPlanningAuthorityDigest &&
    left.executionRunDigest === right.executionRunDigest &&
    left.terminal.kind === right.terminal.kind &&
    left.terminal.persistenceVersion === right.terminal.persistenceVersion &&
    left.terminal.rootDigest === right.terminal.rootDigest
}

/**
 * Creates the exact low-level DynamoDB key for one binding.
 *
 * @param binding - Strict measured binding.
 * @returns Low-level partition and sort key.
 */
function createFenceKey(
  binding: WorkspaceSearchWriterFenceBinding,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: writerFenceMigrationId },
    recordKey: { S: binding.recordKey },
  }
}

/**
 * Reads one exact low-level string AttributeValue.
 *
 * @param value - Candidate AttributeValue.
 * @returns Exact string value.
 */
function readStringAttribute(value: unknown): string {
  const record = requireRecord(value)
  requireExactKeys(record, ['S'])
  const text = Reflect.get(record, 'S')
  return typeof text === 'string' ? text : failFence()
}

/**
 * Reads one canonical Date without accepting subclass hooks.
 *
 * @param value - Candidate Date.
 * @returns Canonical UTC timestamp.
 */
function readDate(value: unknown): string {
  if (!(value instanceof Date)) return failFence()
  let milliseconds: number
  try {
    milliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failFence()
  }
  if (!Number.isFinite(milliseconds)) return failFence()
  return new Date(milliseconds).toISOString()
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Exact canonical timestamp.
 */
function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !canonicalTimestampPattern.test(value)) {
    return failFence()
  }
  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    return failFence()
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Exact lowercase digest.
 */
function requireDigest(value: unknown): string {
  return typeof value === 'string' && lowercaseSha256Pattern.test(value)
    ? value
    : failFence()
}

/**
 * Reads one bounded secret-free identifier.
 *
 * @param value - Candidate identifier.
 * @param maximumLength - Maximum accepted UTF-16 code-unit length.
 * @returns Exact bounded identifier.
 */
function requireIdentifier(
  value: unknown,
  maximumLength = 256,
): string {
  return typeof value === 'string' &&
      value.length <= maximumLength &&
      boundedIdentifierPattern.test(value)
    ? value
    : failFence()
}

/**
 * Reads one valid DynamoDB table name.
 *
 * @param value - Candidate table name.
 * @returns Exact table name.
 */
function requireTableName(value: unknown): string {
  return typeof value === 'string' && dynamoTableNamePattern.test(value)
    ? value
    : failFence()
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate number.
 * @returns Positive safe integer.
 */
function requirePositiveSafeInteger(value: unknown): number {
  return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > 0
    ? value
    : failFence()
}

/**
 * Increments one positive safe counter without wrapping.
 *
 * @param value - Current positive counter.
 * @returns Exact successor.
 */
function incrementCounter(value: number): number {
  const current = requirePositiveSafeInteger(value)
  return current < Number.MAX_SAFE_INTEGER
    ? current + 1
    : failFence()
}

/**
 * Computes one lowercase SHA-256 digest of exact text.
 *
 * @param value - Exact input text.
 * @returns Lowercase SHA-256 digest.
 */
function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Computes one deterministic digest for an already canonical object literal.
 *
 * @param value - Fixed-order JSON-compatible value.
 * @returns Lowercase SHA-256 digest.
 */
function digestCanonicalValue(value: unknown): string {
  return digestText(JSON.stringify(value))
}

/**
 * Requires a plain non-array object.
 *
 * @param value - Candidate runtime value.
 * @returns Plain record.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) return failFence()
  return value
}

/**
 * Narrows one value to a plain string-keyed record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value has an ordinary or null object prototype.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false
  }
  let prototype: unknown
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    return false
  }
  return prototype === Object.prototype || prototype === null
}

/**
 * Requires a record to contain exactly the expected own keys.
 *
 * @param record - Candidate plain record.
 * @param expected - Complete expected key list.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  let actual: PropertyKey[]
  try {
    actual = Reflect.ownKeys(record)
  } catch {
    return failFence()
  }
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length) return failFence()
  if (actual.some((key) => typeof key !== 'string')) return failFence()
  actual.sort()
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== sortedExpected[index]) return failFence()
  }
  for (const key of sortedExpected) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(record, key)
    } catch {
      return failFence()
    }
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failFence()
    }
  }
}

/**
 * Runs one public boundary and normalizes every unexpected failure.
 *
 * @param operation - Exact synchronous boundary operation.
 * @returns Successful detached result.
 */
function atFenceBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchWriterFenceError) throw error
    throw new WorkspaceSearchWriterFenceError()
  }
}

/**
 * Raises one stable writer-fence validation failure.
 *
 * @returns Never returns.
 */
function failFence(): never {
  throw new WorkspaceSearchWriterFenceError()
}
