import {
  decodeAttributeMap,
  encodeAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createWorkspaceSearchConfigurationHash,
  isHexDigest,
  type DynamoAttributeMap,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
} from './migration-contract'
import {
  validateWorkspaceSearchMigrationCheckpoint,
} from './migration-state-machine'
import { hasCanonicalDenseArrayShape } from './migration-value-guards'

/**
 * Shared measured context required before any source page can be consumed.
 */
export type WorkspaceSearchMigrationSourceScanContextInput = {
  /** Complete measured configuration that owns the source checkpoint. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Logical source selected from the fixed four-source allowlist. */
  readonly source: WorkspaceSearchMigrationSourceName
  /** Previously committed cumulative source checkpoint. */
  readonly previousCheckpoint: MigrationSourceCheckpoint
}

/**
 * Fixed codes returned by shared source Scan preflight validation.
 */
export type WorkspaceSearchMigrationSourceScanPreflightFailureCode =
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'TABLE_SCHEMA_MISMATCH'

/**
 * Detached source context shared by the AWS reader and pure page reducer.
 */
export type PreparedWorkspaceSearchMigrationSourceScanContext = {
  /** Detached exact measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed configuration hash captured exactly once. */
  readonly configurationHash: string
  /** Detached validated predecessor checkpoint. */
  readonly previousCheckpoint: MigrationSourceCheckpoint
  /** Selected logical source. */
  readonly source: WorkspaceSearchMigrationSourceName
  /** Validated measured source table identity. */
  readonly table: MigrationTableIdentity
}

/**
 * Successful shared source Scan preflight result.
 */
type WorkspaceSearchMigrationSourceScanPreflightSuccess = {
  /** Successful-result discriminator. */
  readonly ok: true
  /** Detached validated source context. */
  readonly context: PreparedWorkspaceSearchMigrationSourceScanContext
}

/**
 * Failed shared source Scan preflight result.
 */
type WorkspaceSearchMigrationSourceScanPreflightFailure = {
  /** Failed-result discriminator. */
  readonly ok: false
  /** Stable operator-safe failure code. */
  readonly code: WorkspaceSearchMigrationSourceScanPreflightFailureCode
}

/**
 * Result of validating and detaching one source Scan context.
 */
export type WorkspaceSearchMigrationSourceScanPreflightResult =
  | WorkspaceSearchMigrationSourceScanPreflightFailure
  | WorkspaceSearchMigrationSourceScanPreflightSuccess

/**
 * Successful exact-key clone result.
 */
type WorkspaceSearchMigrationExactTableKeySuccess = {
  /** Successful-result discriminator. */
  readonly ok: true
  /** Detached exact physical key. */
  readonly key: DynamoAttributeMap
}

/**
 * Failed exact-key clone result.
 */
type WorkspaceSearchMigrationExactTableKeyFailure = {
  /** Failed-result discriminator. */
  readonly ok: false
  /** Stable raw-value-free failure code. */
  readonly code: 'INVALID_STATE' | 'TABLE_SCHEMA_MISMATCH'
}

/**
 * Result of cloning a key against one measured table schema.
 */
export type WorkspaceSearchMigrationExactTableKeyResult =
  | WorkspaceSearchMigrationExactTableKeyFailure
  | WorkspaceSearchMigrationExactTableKeySuccess

/**
 * Detaches and validates one source context without throwing caller-controlled
 * errors across the module boundary.
 *
 * @param input - Caller-owned measured context and predecessor checkpoint.
 * @returns Detached context or a fixed failure code.
 */
export function prepareWorkspaceSearchMigrationSourceScanContext(
  input: WorkspaceSearchMigrationSourceScanContextInput,
): WorkspaceSearchMigrationSourceScanPreflightResult {
  try {
    return prepareSourceScanContextUnchecked(input)
  } catch {
    return sourceScanPreflightFailure('INVALID_STATE')
  }
}

/**
 * Clones one opaque key against an exact measured table schema.
 *
 * @param key - Candidate low-level physical key.
 * @param table - Measured source table identity.
 * @returns Detached exact key or a fixed failure code.
 */
export function cloneWorkspaceSearchMigrationExactTableKey(
  key: DynamoAttributeMap,
  table: MigrationTableIdentity,
): WorkspaceSearchMigrationExactTableKeyResult {
  try {
    return cloneExactTableKeyUnchecked(key, table)
  } catch {
    return {
      ok: false,
      code: 'INVALID_STATE',
    }
  }
}

/**
 * Extracts and clones the exact measured primary key from one full item.
 *
 * @param item - Candidate full low-level DynamoDB item.
 * @param table - Measured source table identity.
 * @returns Detached exact key or a fixed raw-value-free failure code.
 */
export function cloneWorkspaceSearchMigrationExactTableKeyFromItem(
  item: DynamoAttributeMap,
  table: MigrationTableIdentity,
): WorkspaceSearchMigrationExactTableKeyResult {
  try {
    const key: DynamoAttributeMap = {}
    for (const descriptor of table.key) {
      const property = Object.getOwnPropertyDescriptor(item, descriptor.name)
      const attribute: unknown =
        property !== undefined &&
        property.enumerable === true &&
        Object.prototype.hasOwnProperty.call(property, 'value')
          ? property.value
          : undefined
      if (attribute === undefined) {
        return {
          ok: false,
          code: 'TABLE_SCHEMA_MISMATCH',
        }
      }
      Object.defineProperty(key, descriptor.name, {
        configurable: true,
        enumerable: true,
        value: attribute,
        writable: true,
      })
    }
    return cloneExactTableKeyUnchecked(key, table)
  } catch {
    return {
      ok: false,
      code: 'INVALID_STATE',
    }
  }
}

/**
 * Performs shared preflight after the public raw-error replacement boundary.
 *
 * @param input - Caller-owned source context.
 * @returns Detached validated context or a deliberate fixed failure.
 */
function prepareSourceScanContextUnchecked(
  input: WorkspaceSearchMigrationSourceScanContextInput,
): WorkspaceSearchMigrationSourceScanPreflightResult {
  const source = readSourceName(input.source)
  if (source === undefined) {
    return sourceScanPreflightFailure('INVALID_ARGUMENT')
  }
  const configuration = structuredClone(input.configuration)
  const table = configuration.tables[source]
  if (table === undefined) {
    return sourceScanPreflightFailure('TABLE_SCHEMA_MISMATCH')
  }
  const configurationHash = input.configurationHash
  if (
    !isHexDigest(configurationHash) ||
    createWorkspaceSearchConfigurationHash(configuration) !== configurationHash
  ) {
    return sourceScanPreflightFailure('CONFIGURATION_HASH_MISMATCH')
  }
  const tableFailure = validateSourceTable(table, source)
  if (tableFailure !== undefined) {
    return sourceScanPreflightFailure(tableFailure)
  }

  const checkpointClone = cloneCheckpoint(input.previousCheckpoint)
  try {
    validateWorkspaceSearchMigrationCheckpoint(checkpointClone)
  } catch {
    return sourceScanPreflightFailure('INVALID_STATE')
  }
  if (checkpointClone.completed) {
    return sourceScanPreflightFailure('INVALID_STATE')
  }
  let previousCheckpoint = checkpointClone
  if (checkpointClone.cursor !== undefined) {
    const cursorResult = cloneExactTableKeyUnchecked(
      checkpointClone.cursor,
      table,
    )
    if (!cursorResult.ok) {
      return sourceScanPreflightFailure(cursorResult.code)
    }
    previousCheckpoint = {
      ...checkpointClone,
      cursor: cursorResult.key,
    }
  }
  return {
    ok: true,
    context: {
      configuration,
      configurationHash,
      previousCheckpoint,
      source,
      table,
    },
  }
}

/**
 * Clones one checkpoint before validation can inspect mutable containers.
 *
 * @param checkpoint - Caller-owned predecessor checkpoint.
 * @returns Detached checkpoint with a losslessly cloned optional cursor.
 */
function cloneCheckpoint(
  checkpoint: MigrationSourceCheckpoint,
): MigrationSourceCheckpoint {
  const clone = structuredClone(checkpoint)
  return clone.cursor === undefined
    ? clone
    : {
        ...clone,
        cursor: cloneAttributeMap(clone.cursor),
      }
}

/**
 * Clones and validates one exact physical key without a replacement boundary.
 *
 * @param key - Candidate physical key.
 * @param table - Measured source table identity.
 * @returns Detached exact key or a deliberate schema failure.
 */
function cloneExactTableKeyUnchecked(
  key: DynamoAttributeMap,
  table: MigrationTableIdentity,
): WorkspaceSearchMigrationExactTableKeyResult {
  const clone = cloneAttributeMap(key)
  if (Object.keys(clone).length !== table.key.length) {
    return {
      ok: false,
      code: 'TABLE_SCHEMA_MISMATCH',
    }
  }
  for (const descriptor of table.key) {
    const attribute = clone[descriptor.name]
    if (!attribute || !matchesKeyAttributeType(attribute, descriptor.type)) {
      return {
        ok: false,
        code: 'TABLE_SCHEMA_MISMATCH',
      }
    }
  }
  return {
    ok: true,
    key: clone,
  }
}

/**
 * Clones one low-level attribute map through the strict lossless codec.
 *
 * @param value - Caller-owned item or key.
 * @returns Detached canonical low-level map.
 */
function cloneAttributeMap(value: DynamoAttributeMap): DynamoAttributeMap {
  return decodeAttributeMap(encodeAttributeMap(value))
}

/**
 * Validates one measured source table role and exact key descriptor.
 *
 * @param table - Measured source table identity.
 * @param source - Selected logical source.
 * @returns Fixed failure code or undefined when valid.
 */
function validateSourceTable(
  table: MigrationTableIdentity,
  source: WorkspaceSearchMigrationSourceName,
): 'IDENTITY_MISMATCH' | 'TABLE_SCHEMA_MISMATCH' | undefined {
  if (table.role !== source) return 'IDENTITY_MISMATCH'
  if (
    !hasCanonicalDenseArrayShape(table.key) ||
    table.key.length < 1 ||
    table.key.length > 2
  ) {
    return 'TABLE_SCHEMA_MISMATCH'
  }
  const names = new Set<string>()
  let hashCount = 0
  let rangeCount = 0
  for (const descriptor of table.key) {
    if (
      typeof descriptor.name !== 'string' ||
      descriptor.name.length === 0 ||
      descriptor.type !== 'B' &&
        descriptor.type !== 'N' &&
        descriptor.type !== 'S' ||
      descriptor.role !== 'HASH' && descriptor.role !== 'RANGE' ||
      names.has(descriptor.name)
    ) {
      return 'TABLE_SCHEMA_MISMATCH'
    }
    names.add(descriptor.name)
    if (descriptor.role === 'HASH') hashCount += 1
    else rangeCount += 1
  }
  return hashCount === 1 && rangeCount === table.key.length - 1
    ? undefined
    : 'TABLE_SCHEMA_MISMATCH'
}

/**
 * Checks one low-level key attribute against its measured scalar type.
 *
 * @param value - Candidate exact key attribute.
 * @param type - Measured DynamoDB scalar key type.
 * @returns Whether the attribute has exactly the required scalar tag.
 */
function matchesKeyAttributeType(
  value: DynamoAttributeMap[string],
  type: MigrationTableIdentity['key'][number]['type'],
): boolean {
  if (Object.keys(value).length !== 1) return false
  if (type === 'S') return typeof value.S === 'string'
  if (type === 'N') return typeof value.N === 'string'
  return value.B instanceof Uint8Array
}

/**
 * Reads one canonical source name without trusting the static input type.
 *
 * @param source - Runtime source value.
 * @returns Narrowed source or undefined when outside the allowlist.
 */
function readSourceName(
  source: WorkspaceSearchMigrationSourceName,
): WorkspaceSearchMigrationSourceName | undefined {
  return source === 'project-directory' ||
      source === 'work-items' ||
      source === 'collaboration' ||
      source === 'documents'
    ? source
    : undefined
}

/**
 * Creates one fixed failed preflight result.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Failed preflight result.
 */
function sourceScanPreflightFailure(
  code: WorkspaceSearchMigrationSourceScanPreflightFailureCode,
): WorkspaceSearchMigrationSourceScanPreflightFailure {
  return {
    ok: false,
    code,
  }
}
