import { createHash } from 'node:crypto'
import { z } from 'zod'
import { DATA_MIGRATION_INVOCATION_DEFAULTS } from '../../application/data-migration-invocation-defaults'
import type {
  DataMigrationCheckpointStore,
  DataMigrationClock,
  DataMigrationOperatorVerifier,
  DataMigrationRowStore,
} from '../../application/ports/data-migration-ports'
import { runDataMigration } from '../../application/use-cases/run-data-migration'
import { verifyDataMigration } from '../../application/use-cases/verify-data-migration'
import {
  assertValidDataMigrationRegistry,
  DATA_MIGRATION_MAX_PAGE_SIZE,
  DATA_MIGRATION_MAX_SEGMENTS,
  DataMigrationFailure,
  type DataMigrationDefinition,
} from '../../domain/data-migration'

/** Time kept back from the Lambda limit so the last page, checkpoint and run record finish. */
const DEADLINE_SAFETY_MILLISECONDS = 60_000

/** Shape of a verifier rejection reason that is safe to log; anything else is dropped. */
const REASON_CODE_PATTERN = /^[A-Z][A-Z_]{0,39}$/u

/** Version tag of the binding digest, changed whenever its inputs change. */
const BINDING_VERSION = 'mukuroji-data-migration-request/v1'

/** Builds a positive integer field with an upper bound. */
const boundedInteger = (maximum: number) => z.number().int().min(1).max(maximum)

/** Shape of an invocation payload; unknown fields are rejected. */
const invocationSchema = z.object({
  command: z.enum(['list', 'run', 'verify']),
  migrationId: z.string().min(1).max(128).optional(),
  apply: z.boolean().optional(),
  segments: boundedInteger(DATA_MIGRATION_MAX_SEGMENTS).optional(),
  pageSize: boundedInteger(DATA_MIGRATION_MAX_PAGE_SIZE).optional(),
  maxPages: boundedInteger(Number.MAX_SAFE_INTEGER).optional(),
  maxWritesPerSecond: boundedInteger(DATA_MIGRATION_INVOCATION_DEFAULTS.maxWritesPerSecondLimit).optional(),
  nonce: z.string().regex(/^[A-Za-z0-9-]{16,64}$/u).optional(),
  operatorProof: z.string().min(1).max(8192).optional(),
}).strict()

/** Validated invocation payload of the data migration Lambda. */
export type DataMigrationInvocationRequest = {
  /** `list` registered migrations, `run` one (dry run unless `apply`), or `verify` one. */
  readonly command: 'list' | 'run' | 'verify'
  /** Migration identifier; required by `run` and `verify`. */
  readonly migrationId?: string
  /** `run` only: write rows and checkpoints. */
  readonly apply?: boolean
  /** Parallel scan segments. */
  readonly segments?: number
  /** Rows per page. */
  readonly pageSize?: number
  /** Page budget of this invocation. */
  readonly maxPages?: number
  /** `run` only: write budget. */
  readonly maxWritesPerSecond?: number
  /** Applying `run` only: random value that makes each operator proof single-purpose. */
  readonly nonce?: string
  /** Applying `run` only: operator identity proof, bound to this request. */
  readonly operatorProof?: string
}

/** Facts about the Lambda invocation the handler is running in. */
export type DataMigrationInvocationContext = {
  /** Lambda request identifier, written to the audit log line. */
  readonly requestId: string
  /** Name of the invoked function, bound into the operator proof. */
  readonly functionName: string
  /** AWS account the function runs in; the operator must belong to it. */
  readonly accountId: string
  /** Milliseconds left before the Lambda limit. */
  readonly remainingMilliseconds: number
}

/** Dependencies of the data migration Lambda adapter. */
export type DataMigrationInvocationDependencies = {
  /** Registered migrations. */
  readonly registry: readonly DataMigrationDefinition[]
  /** Physical table names by the logical `table` of a definition; only these tables can be migrated. */
  readonly targetTables: ReadonlyMap<string, string>
  /** Physical checkpoint table name. */
  readonly checkpointTableName: string
  /**
   * Builds the stores for one invocation.
   *
   * @param request - Physical tables and segment count.
   * @returns The stores.
   */
  readonly createStores: (request: {
    /** Physical target table name. */
    readonly tableName: string
    /** Physical checkpoint table name. */
    readonly checkpointTableName: string
    /** Parallel scan segments. */
    readonly segments: number
  }) => Promise<{
    /** Target table rows. */
    readonly rowStore: DataMigrationRowStore
    /** Checkpoints and run records. */
    readonly checkpointStore: DataMigrationCheckpointStore
  }>
  /** Authenticates the operator of an applying run. */
  readonly verifyOperator: DataMigrationOperatorVerifier
  /** Time source and delay. */
  readonly clock: DataMigrationClock
  /**
   * Creates a run identifier.
   *
   * @returns A unique identifier.
   */
  readonly createRunId: () => string
  /**
   * Writes one audit log line; it holds no keys, rows, table names or proofs.
   *
   * @param line - JSON text.
   */
  readonly writeAuditLog: (line: string) => void
}

/** Stable codes an invocation can be refused with before a migration starts. */
export type DataMigrationInvocationErrorCode =
  | 'INVALID_REQUEST'
  | 'MIGRATION_NOT_FOUND'
  | 'TABLE_NOT_CONFIGURED'
  | 'OPERATOR_UNVERIFIED'

/** Content-free response of one invocation. */
export type DataMigrationInvocationResponse = Readonly<Record<string, unknown>> & {
  /** Command the response belongs to, or `unknown` for an unparseable payload. */
  readonly operation: 'list' | 'run' | 'verify' | 'unknown'
}

/**
 * Computes the digest an operator proof must carry for a request. Every
 * parameter that changes what the invocation does is included, so a proof
 * cannot be reused for another migration, mode, bound or function.
 *
 * @param functionName - Name of the function the request is sent to.
 * @param request - Invocation parameters; the proof itself is ignored.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function computeDataMigrationRequestBinding(
  functionName: string,
  request: DataMigrationInvocationRequest,
): string {
  const fields = [
    BINDING_VERSION,
    functionName,
    request.command,
    request.migrationId ?? null,
    request.apply ?? null,
    request.segments ?? null,
    request.pageSize ?? null,
    request.maxPages ?? null,
    request.maxWritesPerSecond ?? null,
    request.nonce ?? null,
  ]
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

/**
 * Parses an untrusted invocation payload and checks the combination of
 * fields each command accepts.
 *
 * @param event - Raw Lambda event.
 * @returns The request, or `undefined` when it is invalid.
 */
export function parseDataMigrationInvocation(event: unknown): DataMigrationInvocationRequest | undefined {
  const parsed = invocationSchema.safeParse(event)
  if (!parsed.success) return undefined
  const request = parsed.data
  if (request.command === 'list') {
    return Object.keys(request).length === 1 ? { command: 'list' } : undefined
  }
  if (request.migrationId === undefined) return undefined
  if (request.command === 'verify') {
    const writeOnly = request.apply !== undefined ||
      request.maxWritesPerSecond !== undefined ||
      request.nonce !== undefined ||
      request.operatorProof !== undefined
    return writeOnly ? undefined : request
  }
  const applying = request.apply === true
  const proofFields = [request.nonce, request.operatorProof].filter((value) => value !== undefined).length
  if (applying ? proofFields !== 2 : proofFields !== 0) return undefined
  return request
}

/**
 * Handles one operator invocation of the data migration Lambda: lists
 * migrations, runs one bounded slice (dry run unless `apply`), or verifies
 * one. An applying run must carry an operator proof bound to the request;
 * the authenticated principal is stored in the run record and the audit log.
 * The run stops before the Lambda limit and reports `paused`.
 *
 * @param event - Raw Lambda event.
 * @param context - Invocation facts.
 * @param dependencies - Stores, verifier, clock and log.
 * @returns A content-free response.
 */
export async function handleDataMigrationInvocation(
  event: unknown,
  context: DataMigrationInvocationContext,
  dependencies: DataMigrationInvocationDependencies,
): Promise<DataMigrationInvocationResponse> {
  const request = parseDataMigrationInvocation(event)
  if (request === undefined) return refuse('unknown', 'INVALID_REQUEST')
  const operation = request.command
  try {
    assertValidDataMigrationRegistry(dependencies.registry)
    if (request.command === 'list') {
      return {
        operation,
        migrations: dependencies.registry.map((definition) => ({
          id: definition.id,
          description: definition.description,
          table: definition.table,
          fromSchemaVersion: definition.fromSchemaVersion,
          toSchemaVersion: definition.toSchemaVersion,
          writerPolicy: definition.writerPolicy,
        })),
      }
    }
    const definition = dependencies.registry.find((candidate) => candidate.id === request.migrationId)
    if (definition === undefined) return refuse(operation, 'MIGRATION_NOT_FOUND')
    const tableName = dependencies.targetTables.get(definition.table)
    if (tableName === undefined) return refuse(operation, 'TABLE_NOT_CONFIGURED')
    const deadline = dependencies.clock.now() +
      Math.max(0, context.remainingMilliseconds - DEADLINE_SAFETY_MILLISECONDS)
    const segments = request.segments ?? DATA_MIGRATION_INVOCATION_DEFAULTS.segments
    if (request.command === 'verify') {
      const stores = await dependencies.createStores({
        tableName,
        checkpointTableName: dependencies.checkpointTableName,
        segments,
      })
      const report = await verifyDataMigration({
        definition,
        ...stores,
        pageSize: request.pageSize ?? DATA_MIGRATION_INVOCATION_DEFAULTS.verifyPageSize,
        maxPages: request.maxPages ?? DATA_MIGRATION_INVOCATION_DEFAULTS.verifyMaxPages,
        clock: dependencies.clock,
        deadline,
      })
      writeAudit(dependencies, context, { operation, ...report })
      return { operation, ...report }
    }
    const applying = request.apply === true
    let operator = 'dry-run'
    if (applying) {
      try {
        operator = await dependencies.verifyOperator({
          proof: request.operatorProof ?? '',
          binding: computeDataMigrationRequestBinding(context.functionName, request),
          accountId: context.accountId,
        })
      } catch (error: unknown) {
        const reason = error instanceof Error && REASON_CODE_PATTERN.test(error.message) ? error.message : undefined
        writeAudit(dependencies, context, {
          operation,
          migrationId: definition.id,
          table: definition.table,
          mode: 'apply',
          status: 'error',
          code: 'OPERATOR_UNVERIFIED',
          ...(reason === undefined ? {} : { reason }),
        })
        return refuse(operation, 'OPERATOR_UNVERIFIED')
      }
    }
    const stores = await dependencies.createStores({
      tableName,
      checkpointTableName: dependencies.checkpointTableName,
      segments,
    })
    const report = await runDataMigration({
      definition,
      ...stores,
      clock: dependencies.clock,
      runId: dependencies.createRunId(),
      operator,
      mode: applying ? 'apply' : 'dry-run',
      pageSize: request.pageSize ?? DATA_MIGRATION_INVOCATION_DEFAULTS.runPageSize,
      maxPages: request.maxPages ?? DATA_MIGRATION_INVOCATION_DEFAULTS.runMaxPages,
      maxWritesPerSecond: request.maxWritesPerSecond ?? DATA_MIGRATION_INVOCATION_DEFAULTS.maxWritesPerSecond,
      deadline,
    })
    writeAudit(dependencies, context, {
      operation,
      ...report,
      ...(applying ? { operator } : {}),
    })
    return { operation, ...report }
  } catch (error: unknown) {
    const code = error instanceof DataMigrationFailure ? error.code : 'UPSTREAM_FAILURE'
    const detail = error instanceof DataMigrationFailure ? error.detail : undefined
    writeAudit(dependencies, context, {
      operation,
      ...(request.migrationId === undefined ? {} : { migrationId: request.migrationId }),
      status: 'error',
      code,
      ...(detail === undefined ? {} : { detail }),
    })
    return { operation, status: 'error', code, ...(detail === undefined ? {} : { detail }) }
  }
}

/**
 * Builds a refusal response.
 *
 * @param operation - Command, or `unknown`.
 * @param code - Refusal code.
 * @returns The response.
 */
function refuse(
  operation: DataMigrationInvocationResponse['operation'],
  code: DataMigrationInvocationErrorCode,
): DataMigrationInvocationResponse {
  return { operation, status: 'error', code }
}

/**
 * Writes one audit log line tagged with the Lambda request identifier.
 *
 * @param dependencies - Adapter dependencies.
 * @param context - Invocation facts.
 * @param fields - Content-free fields of the outcome.
 */
function writeAudit(
  dependencies: DataMigrationInvocationDependencies,
  context: DataMigrationInvocationContext,
  fields: Readonly<Record<string, unknown>>,
): void {
  dependencies.writeAuditLog(JSON.stringify({
    type: 'data-migration.invocation',
    requestId: context.requestId,
    ...fields,
  }))
}
