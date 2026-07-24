import {
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb'
import { createDynamoDbClient } from '../aws/dynamodb-client'
import {
  loadServerConfig,
  type ServerEnvironment,
} from '../config/server-config'
import { classifyApiError } from './api-observability'

/**
 * Stable dependency categories allowed in readiness failure logs.
 */
export type ReadinessDependencyName =
  | 'audit-events'
  | 'readiness-probe'
  | 'work-items'
  | 'workspace-access'

/**
 * Safe metadata recorded when a readiness dependency check fails unexpectedly.
 */
export interface ReadinessFailureObservation {
  /** Server-generated identifier joining the failure to its readiness request. */
  readonly correlationId: string
  /** Stable dependency category that excludes physical resource names. */
  readonly dependency: ReadinessDependencyName
  /** Bounded runtime error category without a message or stack trace. */
  readonly errorType: string
}

/**
 * Destination for one safe readiness failure observation.
 *
 * @param observation - Redacted readiness failure metadata.
 */
export type ReadinessFailureRecorder = (
  observation: ReadinessFailureObservation,
) => void

/**
 * Destination for one serialized readiness log record.
 *
 * @param serializedRecord - JSON log record safe for operational storage.
 */
type StructuredReadinessLogSink = (serializedRecord: string) => void

/**
 * Result of one dependency readiness check.
 */
export interface ReadinessCheckResult {
  /** Stable dependency category that never exposes a physical resource name. */
  readonly name: string
  /** Whether the dependency was verified during this check. */
  readonly ready: boolean
}

/**
 * Aggregate readiness result returned to the system router.
 */
export interface ReadinessResult {
  /** Individual safe check results. */
  readonly checks: readonly ReadinessCheckResult[]
  /** Whether every critical dependency is ready. */
  readonly ready: boolean
}

/**
 * Runtime port used by the readiness route.
 */
export interface ReadinessProbe {
  /**
   * Verifies critical dependencies or returns a recent cached result.
   *
   * @param correlationId - Optional server-generated identifier for failure logs.
   * @returns Safe readiness state without raw infrastructure errors.
   */
  check(correlationId?: string): Promise<ReadinessResult>
}

/**
 * Inputs accepted by the DynamoDB readiness probe.
 */
export interface DynamoDbReadinessProbeOptions {
  /** Cache lifetime that bounds repeated dependency calls. */
  readonly cacheMilliseconds?: number
  /** Server-controlled identifier factory used outside an HTTP request. */
  readonly createIdentifier?: () => string
  /** Optional table metadata adapter used by isolated tests. */
  readonly describeTable?: DescribeTableReadiness
  /** Environment map containing critical table names. */
  readonly environment?: ServerEnvironment
  /** Clock used for deterministic cache tests. */
  readonly now?: () => number
  /** Optional destination for safe dependency failure observations. */
  readonly recordFailure?: ReadinessFailureRecorder
  /** Per-table timeout that prevents readiness requests from hanging. */
  readonly timeoutMilliseconds?: number
}

/**
 * Safe availability state returned by one DynamoDB table metadata check.
 */
export interface DynamoDbTableReadinessState {
  /** Whether every configured global secondary index is active. */
  readonly globalSecondaryIndexesActive: boolean
  /** Whether the table itself is active. */
  readonly tableActive: boolean
}

/**
 * Adapter that verifies one physical DynamoDB table.
 *
 * @param tableName - Configured physical table name retained inside infrastructure.
 * @param timeoutMilliseconds - Maximum duration for the metadata call.
 * @returns Safe table and global-secondary-index availability state.
 */
export type DescribeTableReadiness = (
  tableName: string,
  timeoutMilliseconds: number,
) => Promise<DynamoDbTableReadinessState>

/**
 * Internal physical table mapping that is never returned by the HTTP contract.
 */
interface CriticalTable {
  /** Safe dependency category returned by the probe. */
  readonly name: Exclude<ReadinessDependencyName, 'readiness-probe'>
  /** Configured physical table name, when present. */
  readonly tableName: string | undefined
}

/**
 * Cached readiness state retained for a short bounded interval.
 */
interface CachedReadiness {
  /** Aggregate readiness result safe for reuse. */
  readonly result: ReadinessResult
  /** Millisecond timestamp at which the cache expires. */
  readonly validUntil: number
}

const DEFAULT_CACHE_MILLISECONDS = 30_000
const DEFAULT_TIMEOUT_MILLISECONDS = 1_500
const SERVER_CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/**
 * Writes a safe structured record for one unexpected readiness failure.
 *
 * The record excludes physical table names, exception messages, stack traces,
 * request input, and other client-controlled values.
 *
 * @param observation - Safe readiness failure metadata.
 * @param sink - Optional destination used by tests or the runtime console.
 */
export function recordReadinessFailure(
  observation: ReadinessFailureObservation,
  sink: StructuredReadinessLogSink = writeStandardError,
): void {
  sink(JSON.stringify({
    event: 'readiness.dependency.failed',
    service: 'mukuroji-api',
    correlationId: observation.correlationId,
    dependency: observation.dependency,
    errorType: observation.errorType,
  }))
}

/**
 * Accepts only the API's canonical UUID v4 correlation ID contract.
 *
 * Values outside that contract are treated as untrusted input and replaced
 * with a server-generated identifier before they can reach operational logs.
 *
 * @param value - Candidate identifier obtained from the request boundary.
 * @param createIdentifier - Trusted server-side identifier factory.
 * @returns A canonical server-controlled correlation identifier.
 */
export function resolveReadinessCorrelationId(
  value: string | undefined,
  createIdentifier: () => string = () => crypto.randomUUID(),
): string {
  const normalized = value?.trim()
  return normalized && SERVER_CORRELATION_ID_PATTERN.test(normalized)
    ? normalized
    : createIdentifier()
}

/**
 * Creates a fail-closed readiness probe for the API's critical DynamoDB tables.
 *
 * Missing configuration is reported as not ready. Configured dependencies are
 * verified with `DescribeTable` and a short abort timeout. Raw table names and
 * AWS errors never leave this infrastructure boundary.
 *
 * @param options - Optional environment, adapter, cache, timeout, and clock overrides.
 * @returns A cached dependency-aware readiness probe.
 */
export function createDynamoDbReadinessProbe(
  options: DynamoDbReadinessProbeOptions = {},
): ReadinessProbe {
  const serverConfig = loadServerConfig(options.environment)
  const environment = serverConfig.environment
  const describeTable = options.describeTable ?? createDynamoDbTableDescriber()
  const now = options.now ?? Date.now
  const createIdentifier =
    options.createIdentifier ?? (() => crypto.randomUUID())
  const recordFailure = options.recordFailure ?? recordReadinessFailure
  const cacheMilliseconds =
    options.cacheMilliseconds ?? DEFAULT_CACHE_MILLISECONDS
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS
  const criticalTables = resolveCriticalTables(
    environment,
    serverConfig.production,
  )
  let cached: CachedReadiness | undefined
  let pending: Promise<ReadinessResult> | undefined

  return {
    async check(correlationId) {
      const checkedAt = now()
      if (cached && cached.validUntil > checkedAt) {
        return cached.result
      }
      if (pending) return pending

      const effectiveCorrelationId = resolveReadinessCorrelationId(
        correlationId,
        createIdentifier,
      )
      pending = checkCriticalTables(
        describeTable,
        criticalTables,
        timeoutMilliseconds,
        effectiveCorrelationId,
        recordFailure,
      )
      try {
        const result = await pending
        cached = {
          result,
          validUntil: now() + cacheMilliseconds,
        }
        return result
      } finally {
        pending = undefined
      }
    },
  }
}

/**
 * Resolves the three tables required for core request, authorization, and audit paths.
 *
 * @param environment - Untrusted runtime environment values.
 * @param production - Whether missing explicit production table configuration must fail closed.
 * @returns Safe names paired with optional physical resource names.
 */
function resolveCriticalTables(
  environment: ServerEnvironment,
  production: boolean,
): readonly CriticalTable[] {
  return [
    {
      name: 'work-items',
      tableName: firstNonBlank(
        environment.MUKUROJI_WORK_ITEMS_TABLE,
        environment.WORK_ITEMS_TABLE_NAME,
        environment.MUKUROJI_TEAM_ISSUES_TABLE,
        environment.TEAM_ISSUES_TABLE_NAME,
      ) ?? (production ? undefined : 'mukuroji-team-issues-local'),
    },
    {
      name: 'workspace-access',
      tableName: firstNonBlank(
        environment.MUKUROJI_WORKSPACE_ACCESS_TABLE,
        environment.WORKSPACE_ACCESS_TABLE_NAME,
      ) ?? (production ? undefined : 'mukuroji-workspace-access-local'),
    },
    {
      name: 'audit-events',
      tableName: firstNonBlank(
        environment.MUKUROJI_AUDIT_EVENTS_TABLE,
        environment.AUDIT_EVENTS_TABLE_NAME,
      ) ?? (production ? undefined : 'mukuroji-audit-events'),
    },
  ]
}

/**
 * Checks every configured table and marks missing configuration as unavailable.
 *
 * @param client - DynamoDB client used for metadata requests.
 * @param tables - Safe dependency mappings to verify.
 * @param timeoutMilliseconds - Per-request abort timeout.
 * @param correlationId - Server-generated identifier for failure logs.
 * @param recordFailure - Destination for safe dependency failure observations.
 * @returns Aggregate fail-closed readiness result.
 */
async function checkCriticalTables(
  describeTable: DescribeTableReadiness,
  tables: readonly CriticalTable[],
  timeoutMilliseconds: number,
  correlationId: string,
  recordFailure: ReadinessFailureRecorder,
): Promise<ReadinessResult> {
  const checks = await Promise.all(tables.map(async ({ name, tableName }) => {
    if (!tableName) return { name, ready: false }

    try {
      const state = await describeTable(tableName, timeoutMilliseconds)
      return {
        name,
        ready: state.tableActive && state.globalSecondaryIndexesActive,
      }
    } catch (error) {
      recordFailure({
        correlationId,
        dependency: name,
        errorType: classifyApiError(error),
      })
      return { name, ready: false }
    }
  }))

  return Object.freeze({
    checks: Object.freeze(checks),
    ready: checks.every(({ ready }) => ready),
  })
}

/**
 * Creates the AWS adapter used to verify one DynamoDB table with an abort timeout.
 *
 * @returns A table metadata adapter backed by the configured low-level client.
 */
function createDynamoDbTableDescriber(): DescribeTableReadiness {
  const client = createDynamoDbClient()
  return async (tableName, timeoutMilliseconds) => {
    const result = await client.send(
      new DescribeTableCommand({ TableName: tableName }),
      { abortSignal: AbortSignal.timeout(timeoutMilliseconds) },
    )
    return Object.freeze({
      globalSecondaryIndexesActive:
        result.Table?.GlobalSecondaryIndexes?.every(
          ({ IndexStatus }) => IndexStatus === 'ACTIVE',
        ) ?? true,
      tableActive: result.Table?.TableStatus === 'ACTIVE',
    })
  }
}

/**
 * Returns the first trimmed non-empty configuration value.
 *
 * @param values - Candidate environment values in precedence order.
 * @returns The first usable value, when present.
 */
function firstNonBlank(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value?.trim())?.trim()
}

/**
 * Writes a serialized readiness failure record to standard error.
 *
 * @param serializedRecord - JSON record produced by the readiness boundary.
 */
function writeStandardError(serializedRecord: string): void {
  console.error(serializedRecord)
}
