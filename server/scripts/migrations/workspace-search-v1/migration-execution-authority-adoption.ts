import { Buffer } from 'node:buffer'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  type WorkspaceSearchMigrationExecutionRunAuthorityBinding,
} from './migration-execution-run'
import {
  type WorkspaceSearchMigrationPrePlanAuthorityClaim,
} from './migration-pre-plan-authority-aws'

/** Maximum canonical bytes accepted for one authority-adoption receipt. */
export const WORKSPACE_SEARCH_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT_MAX_BYTES =
  64 * 1024

/** Stable prefix for deterministic authority-adoption receipt record keys. */
export const WORKSPACE_SEARCH_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT_RECORD_KEY_PREFIX =
  'execution-authority-adoption/v1'

const authorityAdoptionCommandVersion = 1
const authorityAdoptionReceiptVersion = 1
const intrinsicTypedArrayByteLengthGetter =
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    'byteLength',
  )?.get

/**
 * Stable raw-value-free failure raised for invalid authority-adoption data.
 */
export class WorkspaceSearchMigrationExecutionAuthorityAdoptionError
  extends Error {
  /** Secret-free machine-readable authority-adoption failure code. */
  readonly code =
    'INVALID_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT'

  /** Creates one stable authority-adoption validation failure. */
  constructor() {
    super('INVALID_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT')
    this.name =
      'WorkspaceSearchMigrationExecutionAuthorityAdoptionError'
  }
}

/**
 * Input used to derive one deterministic authority-adoption command identity.
 */
export type CreateWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentityInput =
  {
    /** Immutable physical migration-state TableId. */
    readonly stateTableId: string
    /** Digest of the exact measured migration configuration. */
    readonly configurationHash: string
    /** Operator-selected run that owns the execution state. */
    readonly runId: string
    /** Digest of the immutable revision-one execution admission. */
    readonly executionRunDigest: string
    /** Exact mutable predecessor revision expected by the command. */
    readonly expectedRevision: number
    /** Exact live lease, pointer, and receipt claim selected for adoption. */
    readonly authorityClaim:
      WorkspaceSearchMigrationPrePlanAuthorityClaim
  }

/**
 * Content-addressed identity of one execution-authority adoption command.
 */
export type WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity =
  {
    /** Authority-adoption command identity discriminator. */
    readonly kind:
      'workspace-search-migration-execution-authority-adoption-command'
    /** Authority-adoption command identity schema version. */
    readonly commandVersion: 1
    /** Stable migration identifier. */
    readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
    /** Stable migration behavior version. */
    readonly migrationVersion:
      typeof WORKSPACE_SEARCH_MIGRATION_VERSION
    /** Immutable physical migration-state TableId. */
    readonly stateTableId: string
    /** Digest of the exact measured migration configuration. */
    readonly configurationHash: string
    /** Operator-selected run that owns the execution state. */
    readonly runId: string
    /** Digest of the immutable revision-one execution admission. */
    readonly executionRunDigest: string
    /** Exact mutable predecessor revision expected by the command. */
    readonly expectedRevision: number
    /** Exact live lease, pointer, and receipt claim selected for adoption. */
    readonly authorityClaim:
      WorkspaceSearchMigrationPrePlanAuthorityClaim
    /** Digest of every preceding command-identity field. */
    readonly commandDigest: string
  }

/**
 * Identifies the durable root preceding one authority-adoption transition.
 */
export type WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorKind =
  | 'execution-run-admission'
  | 'mutable-execution-state'

/**
 * Supported mutable execution-state schema versions preceding an adoption.
 */
export type WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorExecutionStateVersion =
  1 | 2 | 3

/**
 * Material used to create one immutable authority-adoption receipt.
 */
export type CreateWorkspaceSearchMigrationExecutionAuthorityAdoptionReceiptInput =
  {
    /** Strict deterministic identity of the authority-adoption command. */
    readonly commandIdentity:
      WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity
    /** Whether admission or mutable execution state preceded the transition. */
    readonly predecessorKind:
      WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorKind
    /** Mutable predecessor schema version, absent for direct admission. */
    readonly predecessorExecutionStateVersion?:
      WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorExecutionStateVersion
    /** Exact predecessor renewal count, required only for version-three state. */
    readonly predecessorMaintenanceEvidenceRenewalCount?: number
    /**
     * Digest of the predecessor envelope or immutable execution admission.
     */
    readonly predecessorExecutionStateDigest: string
    /** Digest of the complete reconstructed predecessor run state. */
    readonly predecessorRunStateDigest: string
    /** Exact next mutable revision written by the transaction. */
    readonly successorRevision: number
    /** Digest of the exact successor mutable execution-state envelope. */
    readonly successorExecutionStateDigest: string
    /** Digest of the complete reconstructed successor run state. */
    readonly successorRunStateDigest: string
    /** Exact cumulative number of durable authority adoptions. */
    readonly maintenanceEvidenceRenewalCount: number
    /** Compact fresh authority atomically adopted by the transaction. */
    readonly currentAuthority:
      WorkspaceSearchMigrationExecutionRunAuthorityBinding
    /** Adapter-owned canonical UTC transaction time. */
    readonly committedAt: string
  }

/**
 * Immutable receipt written atomically with an adopted execution authority.
 */
export type WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt = {
  /** Authority-adoption receipt discriminator. */
  readonly kind:
    'workspace-search-migration-execution-authority-adoption-receipt'
  /** Authority-adoption receipt schema version. */
  readonly receiptVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Stable migration behavior version. */
  readonly migrationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Immutable physical migration-state TableId. */
  readonly stateTableId: string
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Operator-selected run that owns the execution state. */
  readonly runId: string
  /** Digest of the immutable revision-one execution admission. */
  readonly executionRunDigest: string
  /** Digest of the deterministic authority-adoption command. */
  readonly commandDigest: string
  /** Whether admission or mutable execution state preceded the transition. */
  readonly predecessorKind:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorKind
  /** Mutable predecessor schema version, absent for direct admission. */
  readonly predecessorExecutionStateVersion?:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorExecutionStateVersion
  /** Exact predecessor renewal count, present only for version-three state. */
  readonly predecessorMaintenanceEvidenceRenewalCount?: number
  /** Exact predecessor optimistic-concurrency revision. */
  readonly predecessorRevision: number
  /**
   * Digest of the predecessor envelope or immutable execution admission.
   */
  readonly predecessorExecutionStateDigest: string
  /** Digest of the complete reconstructed predecessor run state. */
  readonly predecessorRunStateDigest: string
  /** Exact next mutable revision written by the transaction. */
  readonly successorRevision: number
  /** Digest of the exact successor mutable execution-state envelope. */
  readonly successorExecutionStateDigest: string
  /** Digest of the complete reconstructed successor run state. */
  readonly successorRunStateDigest: string
  /** Exact cumulative number of durable authority adoptions. */
  readonly maintenanceEvidenceRenewalCount: number
  /** Compact fresh authority atomically adopted by the transaction. */
  readonly currentAuthority:
    WorkspaceSearchMigrationExecutionRunAuthorityBinding
  /** Adapter-owned canonical UTC transaction time. */
  readonly committedAt: string
  /** Digest of every preceding immutable receipt field. */
  readonly receiptDigest: string
}

/**
 * Creates one deterministic execution-authority adoption command identity.
 *
 * @param input - Exact run binding, predecessor revision, and authority claim.
 * @returns Detached content-addressed command identity.
 */
export function createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
  input:
    CreateWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentityInput,
): WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity {
  return atAuthorityAdoptionBoundary(() => {
    const record = requireExactRecord(input, [
      'authorityClaim',
      'configurationHash',
      'executionRunDigest',
      'expectedRevision',
      'runId',
      'stateTableId',
    ])
    const runId = readIdentifier(readOwn(record, 'runId'))
    const authorityClaim = readAuthorityClaim(
      readOwn(record, 'authorityClaim'),
    )
    if (authorityClaim.lease.runId !== runId) {
      return failAuthorityAdoption()
    }
    const fields = {
      kind:
        'workspace-search-migration-execution-authority-adoption-command',
      commandVersion: authorityAdoptionCommandVersion,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      stateTableId: readIdentifier(
        readOwn(record, 'stateTableId'),
      ),
      configurationHash: readDigest(
        readOwn(record, 'configurationHash'),
      ),
      runId,
      executionRunDigest: readDigest(
        readOwn(record, 'executionRunDigest'),
      ),
      expectedRevision: readPositiveSafeInteger(
        readOwn(record, 'expectedRevision'),
      ),
      authorityClaim,
    } satisfies Omit<
      WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity,
      'commandDigest'
    >
    return {
      ...fields,
      commandDigest: createMigrationDigest(fields),
    }
  })
}

/**
 * Creates the bounded deterministic state-table sort key for one command.
 *
 * @param identity - Strict authority-adoption command identity.
 * @returns Content-addressed immutable receipt record key.
 */
export function createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceiptRecordKey(
  identity:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity,
): string {
  return atAuthorityAdoptionBoundary(() => {
    const strict = readCommandIdentity(identity)
    return `${WORKSPACE_SEARCH_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT_RECORD_KEY_PREFIX}/${strict.commandDigest}/receipt`
  })
}

/**
 * Creates one immutable receipt from an exact authority-adoption transition.
 *
 * @param input - Exact command, predecessor, successor, authority, and time.
 * @returns Detached strict immutable receipt.
 */
export function createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
  input:
    CreateWorkspaceSearchMigrationExecutionAuthorityAdoptionReceiptInput,
): WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt {
  return atAuthorityAdoptionBoundary(() => {
    const inputRecord = requirePlainRecord(input)
    const hasPredecessorVersion = hasOwnDataProperty(
      inputRecord,
      'predecessorExecutionStateVersion',
    )
    const hasPredecessorRenewalCount = hasOwnDataProperty(
      inputRecord,
      'predecessorMaintenanceEvidenceRenewalCount',
    )
    const expectedKeys = hasPredecessorVersion
      ? [
          'commandIdentity',
          'committedAt',
          'currentAuthority',
          'maintenanceEvidenceRenewalCount',
          'predecessorExecutionStateDigest',
          'predecessorExecutionStateVersion',
          'predecessorKind',
          'predecessorRunStateDigest',
          'successorExecutionStateDigest',
          'successorRevision',
          'successorRunStateDigest',
        ]
      : [
          'commandIdentity',
          'committedAt',
          'currentAuthority',
          'maintenanceEvidenceRenewalCount',
          'predecessorExecutionStateDigest',
          'predecessorKind',
          'predecessorRunStateDigest',
          'successorExecutionStateDigest',
          'successorRevision',
          'successorRunStateDigest',
        ]
    const record = requireExactRecord(
      inputRecord,
      hasPredecessorRenewalCount
        ? [
            ...expectedKeys,
            'predecessorMaintenanceEvidenceRenewalCount',
          ]
        : expectedKeys,
    )
    const command = readCommandIdentity(
      readOwn(record, 'commandIdentity'),
    )
    const predecessorKind = readPredecessorKind(
      readOwn(record, 'predecessorKind'),
    )
    const predecessorExecutionStateVersion =
      hasPredecessorVersion
        ? readExecutionStateVersion(
            readOwn(
              record,
              'predecessorExecutionStateVersion',
            ),
          )
        : undefined
    const predecessorMaintenanceEvidenceRenewalCount =
      hasPredecessorRenewalCount
        ? readPositiveSafeInteger(
            readOwn(
              record,
              'predecessorMaintenanceEvidenceRenewalCount',
            ),
          )
        : undefined
    const predecessorExecutionStateDigest = readDigest(
      readOwn(record, 'predecessorExecutionStateDigest'),
    )
    requirePredecessorBinding({
      command,
      predecessorKind,
      predecessorExecutionStateVersion,
      predecessorExecutionStateDigest,
    })
    const successorRevision = readPositiveSafeInteger(
      readOwn(record, 'successorRevision'),
    )
    if (
      command.expectedRevision === Number.MAX_SAFE_INTEGER ||
      successorRevision !== command.expectedRevision + 1
    ) {
      return failAuthorityAdoption()
    }
    const currentAuthority = readAuthorityBinding(
      readOwn(record, 'currentAuthority'),
    )
    requireCommandAuthorityBinding(command, currentAuthority)
    const committedAt = readTimestamp(
      readOwn(record, 'committedAt'),
    )
    const maintenanceEvidenceRenewalCount =
      readPositiveSafeInteger(
        readOwn(record, 'maintenanceEvidenceRenewalCount'),
      )
    requireRenewalCountLineage(
      predecessorKind,
      predecessorExecutionStateVersion,
      predecessorMaintenanceEvidenceRenewalCount,
      maintenanceEvidenceRenewalCount,
    )
    if (
      Date.parse(committedAt) <
        Date.parse(currentAuthority.evaluatedAt) ||
      maintenanceEvidenceRenewalCount >= successorRevision
    ) {
      return failAuthorityAdoption()
    }
    const common = {
      kind:
        'workspace-search-migration-execution-authority-adoption-receipt',
      receiptVersion: authorityAdoptionReceiptVersion,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      stateTableId: command.stateTableId,
      configurationHash: command.configurationHash,
      runId: command.runId,
      executionRunDigest: command.executionRunDigest,
      commandDigest: command.commandDigest,
      predecessorKind,
      predecessorRevision: command.expectedRevision,
      predecessorExecutionStateDigest,
      predecessorRunStateDigest: readDigest(
        readOwn(record, 'predecessorRunStateDigest'),
      ),
      successorRevision,
      successorExecutionStateDigest: readDigest(
        readOwn(record, 'successorExecutionStateDigest'),
      ),
      successorRunStateDigest: readDigest(
        readOwn(record, 'successorRunStateDigest'),
      ),
      maintenanceEvidenceRenewalCount,
      currentAuthority,
      committedAt,
    } satisfies Omit<
      WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt,
      | 'predecessorExecutionStateVersion'
      | 'predecessorMaintenanceEvidenceRenewalCount'
      | 'receiptDigest'
    >
    const fields = predecessorExecutionStateVersion === undefined
      ? common
      : predecessorMaintenanceEvidenceRenewalCount === undefined
        ? {
            ...common,
            predecessorExecutionStateVersion,
          }
        : {
            ...common,
            predecessorExecutionStateVersion,
            predecessorMaintenanceEvidenceRenewalCount,
          }
    const receipt = {
      ...fields,
      receiptDigest: createMigrationDigest(fields),
    } satisfies WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt
    void encodeReceipt(receipt)
    return receipt
  })
}

/**
 * Serializes one strict receipt as bounded canonical UTF-8 JSON.
 *
 * @param value - Candidate immutable authority-adoption receipt.
 * @returns Exact canonical receipt bytes without a trailing newline.
 */
export function serializeWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
  value:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt,
): Uint8Array {
  return atAuthorityAdoptionBoundary(() =>
    encodeReceipt(readReceipt(value))
  )
}

/**
 * Parses one exact canonical immutable authority-adoption receipt.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 receipt bytes.
 * @returns Detached strict immutable authority-adoption receipt.
 */
export function parseWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
  bytes: Uint8Array,
): WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt {
  return atAuthorityAdoptionBoundary(() => {
    const snapshot = copyBoundedBytes(bytes)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        snapshot,
      )
    } catch {
      return failAuthorityAdoption()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failAuthorityAdoption()
    }
    const receipt = readReceipt(parsed)
    const canonical = encodeReceipt(receipt)
    if (!equalBytes(snapshot, canonical)) {
      return failAuthorityAdoption()
    }
    return receipt
  })
}

/**
 * Reads and reconstructs one strict deterministic command identity.
 *
 * @param value - Candidate command identity.
 * @returns Detached strict identity.
 */
function readCommandIdentity(
  value: unknown,
): WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity {
  const record = requireExactRecord(value, [
    'authorityClaim',
    'commandDigest',
    'commandVersion',
    'configurationHash',
    'executionRunDigest',
    'expectedRevision',
    'kind',
    'migrationId',
    'migrationVersion',
    'runId',
    'stateTableId',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-execution-authority-adoption-command' ||
    readOwn(record, 'commandVersion') !==
      authorityAdoptionCommandVersion ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failAuthorityAdoption()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const authorityClaim = readAuthorityClaim(
    readOwn(record, 'authorityClaim'),
  )
  if (authorityClaim.lease.runId !== runId) {
    return failAuthorityAdoption()
  }
  const fields = {
    kind:
      'workspace-search-migration-execution-authority-adoption-command',
    commandVersion: authorityAdoptionCommandVersion,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    stateTableId: readIdentifier(
      readOwn(record, 'stateTableId'),
    ),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    runId,
    executionRunDigest: readDigest(
      readOwn(record, 'executionRunDigest'),
    ),
    expectedRevision: readPositiveSafeInteger(
      readOwn(record, 'expectedRevision'),
    ),
    authorityClaim,
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity,
    'commandDigest'
  >
  const commandDigest = readDigest(
    readOwn(record, 'commandDigest'),
  )
  if (commandDigest !== createMigrationDigest(fields)) {
    return failAuthorityAdoption()
  }
  return { ...fields, commandDigest }
}

/**
 * Reads and reconstructs one strict immutable authority-adoption receipt.
 *
 * @param value - Candidate runtime or parsed receipt.
 * @returns Detached strict immutable receipt.
 */
function readReceipt(
  value: unknown,
): WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt {
  const candidate = requirePlainRecord(value)
  const hasPredecessorVersion = hasOwnDataProperty(
    candidate,
    'predecessorExecutionStateVersion',
  )
  const hasPredecessorRenewalCount = hasOwnDataProperty(
    candidate,
    'predecessorMaintenanceEvidenceRenewalCount',
  )
  const expectedKeys = hasPredecessorVersion
    ? [
        'commandDigest',
        'committedAt',
        'configurationHash',
        'currentAuthority',
        'executionRunDigest',
        'kind',
        'maintenanceEvidenceRenewalCount',
        'migrationId',
        'migrationVersion',
        'predecessorExecutionStateDigest',
        'predecessorExecutionStateVersion',
        'predecessorKind',
        'predecessorRevision',
        'predecessorRunStateDigest',
        'receiptDigest',
        'receiptVersion',
        'runId',
        'stateTableId',
        'successorExecutionStateDigest',
        'successorRevision',
        'successorRunStateDigest',
      ]
    : [
        'commandDigest',
        'committedAt',
        'configurationHash',
        'currentAuthority',
        'executionRunDigest',
        'kind',
        'maintenanceEvidenceRenewalCount',
        'migrationId',
        'migrationVersion',
        'predecessorExecutionStateDigest',
        'predecessorKind',
        'predecessorRevision',
        'predecessorRunStateDigest',
        'receiptDigest',
        'receiptVersion',
        'runId',
        'stateTableId',
        'successorExecutionStateDigest',
        'successorRevision',
        'successorRunStateDigest',
      ]
  const record = requireExactRecord(
    candidate,
    hasPredecessorRenewalCount
      ? [
          ...expectedKeys,
          'predecessorMaintenanceEvidenceRenewalCount',
        ]
      : expectedKeys,
  )
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-execution-authority-adoption-receipt' ||
    readOwn(record, 'receiptVersion') !==
      authorityAdoptionReceiptVersion ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failAuthorityAdoption()
  }
  const stateTableId = readIdentifier(
    readOwn(record, 'stateTableId'),
  )
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const runId = readIdentifier(readOwn(record, 'runId'))
  const executionRunDigest = readDigest(
    readOwn(record, 'executionRunDigest'),
  )
  const predecessorRevision = readPositiveSafeInteger(
    readOwn(record, 'predecessorRevision'),
  )
  const successorRevision = readPositiveSafeInteger(
    readOwn(record, 'successorRevision'),
  )
  if (
    predecessorRevision === Number.MAX_SAFE_INTEGER ||
    successorRevision !== predecessorRevision + 1
  ) {
    return failAuthorityAdoption()
  }
  const currentAuthority = readAuthorityBinding(
    readOwn(record, 'currentAuthority'),
  )
  const command =
    createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
      {
        stateTableId,
        configurationHash,
        runId,
        executionRunDigest,
        expectedRevision: predecessorRevision,
        authorityClaim: createAuthorityClaim(
          runId,
          currentAuthority,
        ),
      },
    )
  const commandDigest = readDigest(
    readOwn(record, 'commandDigest'),
  )
  if (commandDigest !== command.commandDigest) {
    return failAuthorityAdoption()
  }
  const predecessorKind = readPredecessorKind(
    readOwn(record, 'predecessorKind'),
  )
  const predecessorExecutionStateVersion =
    hasPredecessorVersion
      ? readExecutionStateVersion(
          readOwn(
            record,
            'predecessorExecutionStateVersion',
          ),
        )
      : undefined
  const predecessorMaintenanceEvidenceRenewalCount =
    hasPredecessorRenewalCount
      ? readPositiveSafeInteger(
          readOwn(
            record,
            'predecessorMaintenanceEvidenceRenewalCount',
          ),
        )
      : undefined
  const predecessorExecutionStateDigest = readDigest(
    readOwn(record, 'predecessorExecutionStateDigest'),
  )
  requirePredecessorBinding({
    command,
    predecessorKind,
    predecessorExecutionStateVersion,
    predecessorExecutionStateDigest,
  })
  const committedAt = readTimestamp(
    readOwn(record, 'committedAt'),
  )
  const maintenanceEvidenceRenewalCount =
    readPositiveSafeInteger(
      readOwn(record, 'maintenanceEvidenceRenewalCount'),
    )
  requireRenewalCountLineage(
    predecessorKind,
    predecessorExecutionStateVersion,
    predecessorMaintenanceEvidenceRenewalCount,
    maintenanceEvidenceRenewalCount,
  )
  if (
    Date.parse(committedAt) <
      Date.parse(currentAuthority.evaluatedAt) ||
    maintenanceEvidenceRenewalCount >= successorRevision
  ) {
    return failAuthorityAdoption()
  }
  const common = {
    kind:
      'workspace-search-migration-execution-authority-adoption-receipt',
    receiptVersion: authorityAdoptionReceiptVersion,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    stateTableId,
    configurationHash,
    runId,
    executionRunDigest,
    commandDigest,
    predecessorKind,
    predecessorRevision,
    predecessorExecutionStateDigest,
    predecessorRunStateDigest: readDigest(
      readOwn(record, 'predecessorRunStateDigest'),
    ),
    successorRevision,
    successorExecutionStateDigest: readDigest(
      readOwn(record, 'successorExecutionStateDigest'),
    ),
    successorRunStateDigest: readDigest(
      readOwn(record, 'successorRunStateDigest'),
    ),
    maintenanceEvidenceRenewalCount,
    currentAuthority,
    committedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt,
    | 'predecessorExecutionStateVersion'
    | 'predecessorMaintenanceEvidenceRenewalCount'
    | 'receiptDigest'
  >
  const fields = predecessorExecutionStateVersion === undefined
    ? common
    : predecessorMaintenanceEvidenceRenewalCount === undefined
      ? {
          ...common,
          predecessorExecutionStateVersion,
        }
      : {
          ...common,
          predecessorExecutionStateVersion,
          predecessorMaintenanceEvidenceRenewalCount,
        }
  const receiptDigest = readDigest(
    readOwn(record, 'receiptDigest'),
  )
  if (receiptDigest !== createMigrationDigest(fields)) {
    return failAuthorityAdoption()
  }
  return {
    ...fields,
    receiptDigest,
  } satisfies WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt
}

/**
 * Exact predecessor material used by receipt semantic validation.
 */
type AuthorityAdoptionPredecessorBinding = {
  /** Strict deterministic command identity. */
  readonly command:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity
  /** Durable predecessor root discriminator. */
  readonly predecessorKind:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorKind
  /** Mutable predecessor version, absent for direct admission. */
  readonly predecessorExecutionStateVersion?:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorExecutionStateVersion
  /** Digest of the direct predecessor envelope or admission. */
  readonly predecessorExecutionStateDigest: string
}

/**
 * Requires predecessor kind, version, revision, and digest to correlate.
 *
 * @param input - Exact command and predecessor identity.
 */
function requirePredecessorBinding(
  input: AuthorityAdoptionPredecessorBinding,
): void {
  if (input.predecessorKind === 'execution-run-admission') {
    if (
      input.predecessorExecutionStateVersion !== undefined ||
      input.command.expectedRevision !== 1 ||
      input.predecessorExecutionStateDigest !==
        input.command.executionRunDigest
    ) {
      return failAuthorityAdoption()
    }
    return
  }
  if (
    input.predecessorExecutionStateVersion === undefined ||
    input.command.expectedRevision === 1
  ) {
    return failAuthorityAdoption()
  }
}

/**
 * Requires the renewal count to advance exactly from its predecessor schema.
 *
 * @param predecessorKind - Admission or mutable predecessor discriminator.
 * @param predecessorVersion - Mutable predecessor schema, when present.
 * @param predecessorCount - Exact V3 predecessor renewal count, when present.
 * @param successorCount - Exact cumulative successor renewal count.
 */
function requireRenewalCountLineage(
  predecessorKind:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorKind,
  predecessorVersion:
    | WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorExecutionStateVersion
    | undefined,
  predecessorCount: number | undefined,
  successorCount: number,
): void {
  if (
    predecessorKind === 'execution-run-admission' ||
    predecessorVersion === 1 ||
    predecessorVersion === 2
  ) {
    if (
      predecessorCount !== undefined ||
      successorCount !== 1
    ) {
      return failAuthorityAdoption()
    }
    return
  }
  if (
    predecessorVersion !== 3 ||
    predecessorCount === undefined ||
    predecessorCount === Number.MAX_SAFE_INTEGER ||
    successorCount !== predecessorCount + 1
  ) {
    return failAuthorityAdoption()
  }
}

/**
 * Requires the adopted compact authority to equal the command claim.
 *
 * @param command - Strict command identity carrying the exact live claim.
 * @param authority - Compact authority persisted by the successor.
 */
function requireCommandAuthorityBinding(
  command:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity,
  authority: WorkspaceSearchMigrationExecutionRunAuthorityBinding,
): void {
  const claim = command.authorityClaim
  if (
    authority.ownerId !== claim.lease.ownerId ||
    authority.fenceToken !== claim.lease.fenceToken ||
    authority.maintenanceEvidencePointerRevision !==
      claim.maintenanceEvidencePointerRevision ||
    authority.maintenanceEvidenceReceiptDigest !==
      claim.maintenanceEvidenceReceiptDigest
  ) {
    return failAuthorityAdoption()
  }
}

/**
 * Creates one detached authority claim from compact persisted authority.
 *
 * @param runId - Operator-selected run bound by the enclosing receipt.
 * @param authority - Compact authority persisted by the successor.
 * @returns Exact claim used to reconstruct the command identity.
 */
function createAuthorityClaim(
  runId: string,
  authority: WorkspaceSearchMigrationExecutionRunAuthorityBinding,
): WorkspaceSearchMigrationPrePlanAuthorityClaim {
  return {
    lease: {
      runId,
      ownerId: authority.ownerId,
      fenceToken: authority.fenceToken,
    },
    maintenanceEvidenceReceiptDigest:
      authority.maintenanceEvidenceReceiptDigest,
    maintenanceEvidencePointerRevision:
      authority.maintenanceEvidencePointerRevision,
  }
}

/**
 * Reads one exact live pre-plan authority claim.
 *
 * @param value - Candidate lease, pointer, and receipt claim.
 * @returns Detached strict authority claim.
 */
function readAuthorityClaim(
  value: unknown,
): WorkspaceSearchMigrationPrePlanAuthorityClaim {
  const record = requireExactRecord(value, [
    'lease',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
  ])
  const leaseRecord = requireExactRecord(
    readOwn(record, 'lease'),
    ['fenceToken', 'ownerId', 'runId'],
  )
  return {
    lease: {
      runId: readIdentifier(readOwn(leaseRecord, 'runId')),
      ownerId: readIdentifier(readOwn(leaseRecord, 'ownerId')),
      fenceToken: readPositiveSafeInteger(
        readOwn(leaseRecord, 'fenceToken'),
      ),
    },
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    maintenanceEvidencePointerRevision:
      readPositiveSafeInteger(
        readOwn(record, 'maintenanceEvidencePointerRevision'),
      ),
  }
}

/**
 * Reads one exact compact execution authority binding.
 *
 * @param value - Candidate compact authority binding.
 * @returns Detached strict authority binding.
 */
function readAuthorityBinding(
  value: unknown,
): WorkspaceSearchMigrationExecutionRunAuthorityBinding {
  const record = requireExactRecord(value, [
    'evaluatedAt',
    'fenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
  ])
  return {
    ownerId: readIdentifier(readOwn(record, 'ownerId')),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
    maintenanceEvidencePointerRevision:
      readPositiveSafeInteger(
        readOwn(record, 'maintenanceEvidencePointerRevision'),
      ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    evaluatedAt: readTimestamp(readOwn(record, 'evaluatedAt')),
  }
}

/**
 * Reads one supported predecessor root discriminator.
 *
 * @param value - Candidate predecessor kind.
 * @returns Strict predecessor kind.
 */
function readPredecessorKind(
  value: unknown,
): WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorKind {
  if (
    value !== 'execution-run-admission' &&
    value !== 'mutable-execution-state'
  ) {
    return failAuthorityAdoption()
  }
  return value
}

/**
 * Reads one supported mutable execution-state schema version.
 *
 * @param value - Candidate execution-state schema version.
 * @returns Strict supported execution-state schema version.
 */
function readExecutionStateVersion(
  value: unknown,
): WorkspaceSearchMigrationExecutionAuthorityAdoptionPredecessorExecutionStateVersion {
  if (value !== 1 && value !== 2 && value !== 3) {
    return failAuthorityAdoption()
  }
  return value
}

/**
 * Reads one safe migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Validated identifier.
 */
function readIdentifier(value: unknown): string {
  if (typeof value !== 'string') {
    return failAuthorityAdoption()
  }
  requireMigrationIdentifier(
    value,
    'Execution authority adoption identifier',
  )
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) {
    return failAuthorityAdoption()
  }
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) {
    return failAuthorityAdoption()
  }
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated positive integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return failAuthorityAdoption()
  }
  return value
}

/**
 * Requires one strict plain record with exactly the expected own keys.
 *
 * @param value - Candidate record.
 * @param expectedKeys - Complete allowed string-key set.
 * @returns Strict caller-owned record.
 */
function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = requirePlainRecord(value)
  const keys = Reflect.ownKeys(record)
  if (
    keys.some((key) => typeof key === 'symbol') ||
    keys.length !== expectedKeys.length
  ) {
    return failAuthorityAdoption()
  }
  const actual = keys.filter(
    (key): key is string => typeof key === 'string',
  ).sort()
  const expected = [...expectedKeys].sort()
  if (
    actual.some((key, index) => key !== expected[index])
  ) {
    return failAuthorityAdoption()
  }
  for (const key of expected) {
    if (!hasOwnDataProperty(record, key)) {
      return failAuthorityAdoption()
    }
  }
  return record
}

/**
 * Requires one non-Proxy plain record.
 *
 * @param value - Candidate value.
 * @returns Plain record with an ordinary or null prototype.
 */
function requirePlainRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    return failAuthorityAdoption()
  }
  return value
}

/**
 * Checks whether one value is a supported non-Proxy plain record.
 *
 * @param value - Candidate value.
 * @returns Whether the value has an ordinary or null prototype.
 */
function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Checks one enumerable own data property without invoking accessors.
 *
 * @param record - Candidate record.
 * @param key - Expected own property name.
 * @returns Whether a strict own data property exists.
 */
function hasOwnDataProperty(record: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined) return false
  if (
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return failAuthorityAdoption()
  }
  return true
}

/**
 * Reads one validated own data property without invoking accessors.
 *
 * @param record - Strict record.
 * @param key - Exact own property name.
 * @returns Stored property value.
 */
function readOwn(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return failAuthorityAdoption()
  }
  return descriptor.value
}

/**
 * Encodes one validated immutable receipt under its byte ceiling.
 *
 * @param receipt - Strict immutable receipt.
 * @returns Canonical bounded UTF-8 JSON bytes.
 */
function encodeReceipt(
  receipt:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt,
): Uint8Array {
  const bytes = new TextEncoder().encode(
    serializeCanonicalJson(receipt),
  )
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT_MAX_BYTES
  ) {
    return failAuthorityAdoption()
  }
  return bytes
}

/**
 * Copies untrusted input after enforcing its finite byte bound.
 *
 * @param bytes - Candidate receipt bytes.
 * @returns Detached bounded bytes.
 */
function copyBoundedBytes(bytes: Uint8Array): Uint8Array {
  if (!isSupportedBinaryValue(bytes)) {
    return failAuthorityAdoption()
  }
  if (intrinsicTypedArrayByteLengthGetter === undefined) {
    return failAuthorityAdoption()
  }
  const byteLength: unknown = Reflect.apply(
    intrinsicTypedArrayByteLengthGetter,
    bytes,
    [],
  )
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength === 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT_MAX_BYTES
  ) {
    return failAuthorityAdoption()
  }
  const snapshot = new Uint8Array(bytes)
  if (snapshot.byteLength !== byteLength) {
    return failAuthorityAdoption()
  }
  return snapshot
}

/**
 * Narrows one binary value to a trusted built-in byte-array prototype.
 *
 * @param value - Candidate receipt bytes.
 * @returns Whether the value is a plain Uint8Array or Node.js Buffer.
 */
function isSupportedBinaryValue(
  value: unknown,
): value is Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Uint8Array.prototype ||
    prototype === Buffer.prototype
}

/**
 * Compares two byte arrays without decoding untrusted input.
 *
 * @param left - First byte array.
 * @param right - Second byte array.
 * @returns Whether both arrays are byte-for-byte identical.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Maps every implementation failure to the stable public adoption error.
 *
 * @param operation - Authority-adoption contract operation.
 * @returns Successful operation result.
 */
function atAuthorityAdoptionBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch {
    throw new WorkspaceSearchMigrationExecutionAuthorityAdoptionError()
  }
}

/**
 * Raises the only public authority-adoption validation failure.
 *
 * @returns Never returns.
 */
function failAuthorityAdoption(): never {
  throw new WorkspaceSearchMigrationExecutionAuthorityAdoptionError()
}
