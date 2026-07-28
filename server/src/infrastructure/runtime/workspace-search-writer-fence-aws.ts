import { randomUUID } from 'node:crypto'
import {
  DescribeTableCommand,
  GetItemCommand,
  type DescribeTableCommandOutput,
  type GetItemCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceGuardMaterial,
  createWorkspaceSearchWriterFenceReadMaterial,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  parseWorkspaceSearchWriterFenceObservation,
  WorkspaceSearchWriterFenceError,
  workspaceSearchWriterFenceTableRoles,
  type WorkspaceSearchWriterFenceGuardMaterial,
  type WorkspaceSearchWriterFenceStateIdentity,
  type WorkspaceSearchWriterFenceTableRole,
} from './workspace-search-writer-fence'

const dynamoTableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/u
const awsPartitionPattern =
  /^aws(?:-cn|-iso|-iso-b|-iso-e|-iso-f|-us-gov)?$/u
const awsRegionPattern = /^[a-z0-9]+(?:-[a-z0-9]+)+-[0-9]+$/u
const awsAccountPattern = /^[0-9]{12}$/u
const tableIdPattern = /^[\u0021-\u007e]{1,1024}$/u
const safeDiagnosticIdentifierPattern =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u
const authorizationErrorNames = new Set([
  'AccessDeniedException',
  'CredentialsProviderError',
  'ExpiredTokenException',
  'IncompleteSignature',
  'InvalidClientTokenId',
  'InvalidSignatureException',
  'MissingAuthenticationTokenException',
  'UnauthorizedException',
  'UnrecognizedClientException',
])

/**
 * Exact configured table names measured before a writer guard is acquired.
 */
export type WorkspaceSearchWriterFenceAwsTableNames = {
  /** Physical Project Directory table name. */
  readonly 'project-directory': string
  /** Physical Work Items table name. */
  readonly 'work-items': string
  /** Physical Collaboration table name. */
  readonly collaboration: string
  /** Physical Documents table name. */
  readonly documents: string
  /** Physical Workspace Search table name. */
  readonly 'workspace-search': string
  /** Physical migration-state table name. */
  readonly 'migration-state': string
}

/**
 * Narrow low-level DynamoDB transport used to acquire one writer guard.
 */
export interface WorkspaceSearchWriterFenceAwsTransport {
  /**
   * Describes one exact configured table.
   *
   * @param command - Adapter-owned DescribeTable command.
   * @returns Raw low-level DynamoDB response.
   */
  describeTable(
    command: DescribeTableCommand,
  ): Promise<DescribeTableCommandOutput>

  /**
   * Strongly reads the exact derived writer-fence row.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  getItem(command: GetItemCommand): Promise<GetItemCommandOutput>
}

/**
 * Safe low-cardinality cause of one unavailable writer-fence acquisition.
 */
export type WorkspaceSearchWriterFenceFailureCategory =
  | 'authorization'
  | 'upstream'
  | 'validation'

/**
 * Redacted internal diagnostic emitted before the public error is returned.
 */
export type WorkspaceSearchWriterFenceFailureDiagnostic = {
  /** Fixed writer-fence failure event name. */
  readonly event: 'workspace-search.writer-fence.unavailable'
  /** Fixed runtime service name. */
  readonly service: 'mukuroji-writer-fence'
  /** Safe AWS request ID or server-generated diagnostic identifier. */
  readonly correlationId: string
  /** Low-cardinality failure classification without raw cause material. */
  readonly category: WorkspaceSearchWriterFenceFailureCategory
}

/**
 * Destination for one redacted writer-fence failure diagnostic.
 *
 * @param diagnostic - Safe fixed-shape diagnostic without raw cause values.
 */
export type WorkspaceSearchWriterFenceFailureRecorder = (
  diagnostic: WorkspaceSearchWriterFenceFailureDiagnostic,
) => void

/**
 * Optional diagnostics dependencies used by tests and runtime composition.
 */
export type WorkspaceSearchWriterFenceDiagnostics = {
  /** Trusted fallback identifier factory when AWS has no safe request ID. */
  readonly createCorrelationId?: () => string
  /** Destination for one fixed-shape redacted failure diagnostic. */
  readonly recordFailure?: WorkspaceSearchWriterFenceFailureRecorder
}

/**
 * Invocation-scoped source of exact application writer-fence guard material.
 */
export interface WorkspaceSearchWriterFenceGuardSource {
  /**
   * Remeasures all table incarnations and acquires one current open-row guard.
   *
   * @returns Exact condition material for one application invocation.
   */
  acquire(): Promise<WorkspaceSearchWriterFenceGuardMaterial>
}

/**
 * Stable raw-value-free failure for every unavailable writer-fence source.
 */
export class WorkspaceSearchWriterFenceUnavailableError extends Error {
  /** Machine-readable raw-value-free failure code. */
  readonly code = 'WORKSPACE_SEARCH_WRITER_FENCE_UNAVAILABLE'

  /**
   * Creates one stable unavailable failure without retaining its cause.
   */
  constructor() {
    super('WORKSPACE_SEARCH_WRITER_FENCE_UNAVAILABLE')
    this.name = 'WorkspaceSearchWriterFenceUnavailableError'
  }
}

/**
 * Captured transport functions immune to later caller mutation.
 */
type PreparedWorkspaceSearchWriterFenceAwsTransport = {
  /**
   * Describes one exact configured table.
   *
   * @param command - Adapter-owned DescribeTable command.
   * @returns Raw low-level DynamoDB response.
   */
  readonly describeTable: (
    command: DescribeTableCommand,
  ) => Promise<DescribeTableCommandOutput>
  /**
   * Strongly reads the exact derived fence row.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  readonly getItem: (
    command: GetItemCommand,
  ) => Promise<GetItemCommandOutput>
}

/**
 * Captured diagnostics dependencies immune to later caller mutation.
 */
type PreparedWorkspaceSearchWriterFenceDiagnostics = {
  /**
   * Creates one trusted fallback diagnostic identifier.
   *
   * @returns Candidate server-generated identifier.
   */
  readonly createCorrelationId: () => string
  /**
   * Records one fixed-shape redacted failure diagnostic.
   *
   * @param diagnostic - Safe failure observation.
   */
  readonly recordFailure: WorkspaceSearchWriterFenceFailureRecorder
}

/**
 * Strict immutable identity measured from one active physical table.
 */
type MeasuredWorkspaceSearchWriterFenceTable = {
  /** Logical role assigned by trusted application configuration. */
  readonly role: WorkspaceSearchWriterFenceTableRole
  /** Exact configured and observed physical table name. */
  readonly tableName: string
  /** Exact observed physical table ARN. */
  readonly tableArn: string
  /** Immutable observed physical TableId. */
  readonly tableId: string
  /** Canonical UTC physical table creation time. */
  readonly creationTime: string
  /** AWS partition parsed from the exact table ARN. */
  readonly partition: string
  /** AWS account parsed from the exact table ARN. */
  readonly account: string
  /** AWS region parsed from the exact table ARN. */
  readonly region: string
}

/**
 * Strict DynamoDB table ARN components.
 */
type WorkspaceSearchWriterFenceTableArn = {
  /** Exact validated ARN. */
  readonly arn: string
  /** AWS partition containing the table. */
  readonly partition: string
  /** AWS account owning the table. */
  readonly account: string
  /** AWS region containing the table. */
  readonly region: string
}

/**
 * Concrete source that remeasures durable state for every acquisition.
 */
class AwsWorkspaceSearchWriterFenceGuardSource
implements WorkspaceSearchWriterFenceGuardSource {
  /** Detached exact configured table names. */
  private readonly tableNames: WorkspaceSearchWriterFenceAwsTableNames

  /** Captured narrow low-level DynamoDB transport. */
  private readonly transport: PreparedWorkspaceSearchWriterFenceAwsTransport

  /** Captured safe failure diagnostics dependencies. */
  private readonly diagnostics:
    PreparedWorkspaceSearchWriterFenceDiagnostics

  /**
   * Creates one validated dormant guard source.
   *
   * @param tableNames - Detached exact six-table configuration.
   * @param transport - Captured narrow low-level transport.
   * @param diagnostics - Captured safe diagnostics dependencies.
   */
  constructor(
    tableNames: WorkspaceSearchWriterFenceAwsTableNames,
    transport: PreparedWorkspaceSearchWriterFenceAwsTransport,
    diagnostics: PreparedWorkspaceSearchWriterFenceDiagnostics,
  ) {
    this.tableNames = tableNames
    this.transport = transport
    this.diagnostics = diagnostics
  }

  /**
   * Remeasures all six tables and strongly reads the exact open fence row.
   *
   * @returns Exact guard material for one application invocation.
   */
  async acquire(): Promise<WorkspaceSearchWriterFenceGuardMaterial> {
    return runWorkspaceSearchWriterFenceUnavailableBoundary(
      () =>
        acquirePreparedWorkspaceSearchWriterFenceGuardMaterial(
          this.tableNames,
          this.transport,
        ),
      this.diagnostics,
    )
  }
}

/**
 * Creates a dormant source that remeasures tables on every acquisition.
 *
 * @param tableNames - Exact configured six-table names.
 * @param transport - Narrow low-level DynamoDB transport.
 * @param diagnostics - Optional safe diagnostic dependencies.
 * @returns Validated guard source with no acquired-material cache.
 */
export function createAwsWorkspaceSearchWriterFenceGuardSource(
  tableNames: WorkspaceSearchWriterFenceAwsTableNames,
  transport: WorkspaceSearchWriterFenceAwsTransport,
  diagnostics: WorkspaceSearchWriterFenceDiagnostics = {},
): WorkspaceSearchWriterFenceGuardSource {
  const preparedDiagnostics =
    prepareWorkspaceSearchWriterFenceDiagnostics(diagnostics)
  return runWorkspaceSearchWriterFenceUnavailableSyncBoundary(
    () =>
      new AwsWorkspaceSearchWriterFenceGuardSource(
        readWorkspaceSearchWriterFenceTableNames(tableNames),
        prepareWorkspaceSearchWriterFenceTransport(transport),
        preparedDiagnostics,
      ),
    preparedDiagnostics,
  )
}

/**
 * Acquires exact writer-fence guard material directly from DynamoDB.
 *
 * Every call independently describes all six configured tables and strongly
 * reads the incarnation-bound fence row. No acquired result survives the call.
 *
 * @param tableNames - Exact configured six-table names.
 * @param transport - Narrow low-level DynamoDB transport.
 * @param diagnostics - Optional safe diagnostic dependencies.
 * @returns Exact guard material for one application invocation.
 */
export async function acquireWorkspaceSearchWriterFenceGuardMaterialFromAws(
  tableNames: WorkspaceSearchWriterFenceAwsTableNames,
  transport: WorkspaceSearchWriterFenceAwsTransport,
  diagnostics: WorkspaceSearchWriterFenceDiagnostics = {},
): Promise<WorkspaceSearchWriterFenceGuardMaterial> {
  const preparedDiagnostics =
    prepareWorkspaceSearchWriterFenceDiagnostics(diagnostics)
  return runWorkspaceSearchWriterFenceUnavailableBoundary(
    async () => {
      const names = readWorkspaceSearchWriterFenceTableNames(tableNames)
      const preparedTransport =
        prepareWorkspaceSearchWriterFenceTransport(transport)
      return acquirePreparedWorkspaceSearchWriterFenceGuardMaterial(
        names,
        preparedTransport,
      )
    },
    preparedDiagnostics,
  )
}

/**
 * Measures current table identities and reads their exact fence row.
 *
 * @param tableNames - Detached exact configured table names.
 * @param transport - Captured narrow low-level DynamoDB transport.
 * @returns Exact open-row application guard.
 */
async function acquirePreparedWorkspaceSearchWriterFenceGuardMaterial(
  tableNames: WorkspaceSearchWriterFenceAwsTableNames,
  transport: PreparedWorkspaceSearchWriterFenceAwsTransport,
): Promise<WorkspaceSearchWriterFenceGuardMaterial> {
  const measuredTables = await Promise.all(
    workspaceSearchWriterFenceTableRoles.map((role) =>
      measureWorkspaceSearchWriterFenceTable(
        role,
        tableNames[role],
        transport,
      )
    ),
  )
  const projectDirectory = requireMeasuredTable(
    measuredTables,
    'project-directory',
  )
  const workItems = requireMeasuredTable(measuredTables, 'work-items')
  const collaboration = requireMeasuredTable(
    measuredTables,
    'collaboration',
  )
  const documents = requireMeasuredTable(measuredTables, 'documents')
  const workspaceSearch = requireMeasuredTable(
    measuredTables,
    'workspace-search',
  )
  const migrationState = requireMeasuredTable(
    measuredTables,
    'migration-state',
  )
  requireCoLocatedDistinctTables(measuredTables)
  const stateTableIdentity: WorkspaceSearchWriterFenceStateIdentity = {
    role: 'migration-state',
    tableName: migrationState.tableName,
    tableArn: migrationState.tableArn,
    tableId: migrationState.tableId,
    creationTime: migrationState.creationTime,
    account: migrationState.account,
    region: migrationState.region,
  }
  const binding = createWorkspaceSearchWriterFenceBinding({
    stateTableName: migrationState.tableName,
    stateTableId: migrationState.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest(
        stateTableIdentity,
      ),
    tableIds: {
      'project-directory': projectDirectory.tableId,
      'work-items': workItems.tableId,
      collaboration: collaboration.tableId,
      documents: documents.tableId,
      'workspace-search': workspaceSearch.tableId,
      'migration-state': migrationState.tableId,
    },
  })
  const output = await transport.getItem(
    new GetItemCommand(
      createWorkspaceSearchWriterFenceReadMaterial(binding),
    ),
  )
  const observation = parseWorkspaceSearchWriterFenceObservation(
    output.Item,
    binding,
  )
  return createWorkspaceSearchWriterFenceGuardMaterial(
    observation,
    binding,
    stateTableIdentity,
  )
}

/**
 * Describes and strictly validates one configured physical table.
 *
 * @param role - Trusted logical table role.
 * @param tableName - Exact configured physical name.
 * @param transport - Captured narrow low-level transport.
 * @returns Strict immutable physical identity.
 */
async function measureWorkspaceSearchWriterFenceTable(
  role: WorkspaceSearchWriterFenceTableRole,
  tableName: string,
  transport: PreparedWorkspaceSearchWriterFenceAwsTransport,
): Promise<MeasuredWorkspaceSearchWriterFenceTable> {
  const output = await transport.describeTable(
    new DescribeTableCommand({ TableName: tableName }),
  )
  const table = output.Table
  if (
    table === undefined ||
    table.TableStatus !== 'ACTIVE' ||
    table.TableName !== tableName
  ) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  const tableArn = readWorkspaceSearchWriterFenceTableArn(
    table.TableArn,
    tableName,
  )
  return {
    role,
    tableName,
    tableArn: tableArn.arn,
    tableId: readWorkspaceSearchWriterFenceTableId(table.TableId),
    creationTime: readWorkspaceSearchWriterFenceCreationTime(
      table.CreationDateTime,
    ),
    partition: tableArn.partition,
    account: tableArn.account,
    region: tableArn.region,
  }
}

/**
 * Requires all roles to be present in one complete measurement.
 *
 * @param measuredTables - Six measured table identities.
 * @param role - Exact logical role being selected.
 * @returns Measured identity for the requested role.
 */
function requireMeasuredTable(
  measuredTables: readonly MeasuredWorkspaceSearchWriterFenceTable[],
  role: WorkspaceSearchWriterFenceTableRole,
): MeasuredWorkspaceSearchWriterFenceTable {
  const matches = measuredTables.filter((table) => table.role === role)
  if (matches.length !== 1) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  const measured = matches[0]
  if (measured === undefined) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  return measured
}

/**
 * Requires one account, region, partition, and six distinct physical TableIds.
 *
 * @param measuredTables - Complete measured table identities.
 */
function requireCoLocatedDistinctTables(
  measuredTables: readonly MeasuredWorkspaceSearchWriterFenceTable[],
): void {
  const baseline = measuredTables[0]
  if (
    baseline === undefined ||
    measuredTables.length !== workspaceSearchWriterFenceTableRoles.length
  ) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  const tableIds = new Set<string>()
  for (const table of measuredTables) {
    if (
      table.account !== baseline.account ||
      table.region !== baseline.region ||
      table.partition !== baseline.partition
    ) {
      return failWorkspaceSearchWriterFenceUnavailable()
    }
    tableIds.add(table.tableId)
  }
  if (tableIds.size !== workspaceSearchWriterFenceTableRoles.length) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
}

/**
 * Validates and detaches exact six-role table-name configuration.
 *
 * @param value - Candidate table-name configuration.
 * @returns Detached exact table names.
 */
function readWorkspaceSearchWriterFenceTableNames(
  value: unknown,
): WorkspaceSearchWriterFenceAwsTableNames {
  if (typeof value !== 'object' || value === null) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== workspaceSearchWriterFenceTableRoles.length ||
    keys.some((key) =>
      typeof key !== 'string' ||
      !workspaceSearchWriterFenceTableRoles.includes(
        readWorkspaceSearchWriterFenceRole(key),
      )
    )
  ) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  return {
    'project-directory': readWorkspaceSearchWriterFenceTableName(
      Reflect.get(value, 'project-directory'),
    ),
    'work-items': readWorkspaceSearchWriterFenceTableName(
      Reflect.get(value, 'work-items'),
    ),
    collaboration: readWorkspaceSearchWriterFenceTableName(
      Reflect.get(value, 'collaboration'),
    ),
    documents: readWorkspaceSearchWriterFenceTableName(
      Reflect.get(value, 'documents'),
    ),
    'workspace-search': readWorkspaceSearchWriterFenceTableName(
      Reflect.get(value, 'workspace-search'),
    ),
    'migration-state': readWorkspaceSearchWriterFenceTableName(
      Reflect.get(value, 'migration-state'),
    ),
  }
}

/**
 * Validates one role name without a type assertion.
 *
 * @param value - Candidate role property key.
 * @returns Exact supported table role.
 */
function readWorkspaceSearchWriterFenceRole(
  value: string,
): WorkspaceSearchWriterFenceTableRole {
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (value === role) return role
  }
  return failWorkspaceSearchWriterFenceUnavailable()
}

/**
 * Validates one exact configured DynamoDB table name.
 *
 * @param value - Candidate table name.
 * @returns Strict table name.
 */
function readWorkspaceSearchWriterFenceTableName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !dynamoTableNamePattern.test(value)
  ) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  return value
}

/**
 * Parses one exact DynamoDB table ARN and binds it to its configured name.
 *
 * @param value - Candidate observed table ARN.
 * @param expectedTableName - Exact configured and observed table name.
 * @returns Strict table ARN components.
 */
function readWorkspaceSearchWriterFenceTableArn(
  value: unknown,
  expectedTableName: string,
): WorkspaceSearchWriterFenceTableArn {
  if (
    typeof value !== 'string' ||
    value.length > 2_048 ||
    !/^[\u0021-\u007e]+$/u.test(value)
  ) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  const parts = value.split(':')
  if (parts.length !== 6) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  const prefix = parts[0]
  const partition = parts[1]
  const service = parts[2]
  const region = parts[3]
  const account = parts[4]
  const resource = parts[5]
  if (
    prefix !== 'arn' ||
    partition === undefined ||
    !awsPartitionPattern.test(partition) ||
    service !== 'dynamodb' ||
    region === undefined ||
    !awsRegionPattern.test(region) ||
    account === undefined ||
    !awsAccountPattern.test(account) ||
    resource !== `table/${expectedTableName}`
  ) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  return { arn: value, partition, account, region }
}

/**
 * Validates one immutable physical DynamoDB TableId.
 *
 * @param value - Candidate observed TableId.
 * @returns Strict physical TableId.
 */
function readWorkspaceSearchWriterFenceTableId(value: unknown): string {
  if (typeof value !== 'string' || !tableIdPattern.test(value)) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  return value
}

/**
 * Canonicalizes one genuine finite DynamoDB creation Date.
 *
 * @param value - Candidate observed CreationDateTime.
 * @returns Canonical UTC timestamp.
 */
function readWorkspaceSearchWriterFenceCreationTime(
  value: unknown,
): string {
  if (!(value instanceof Date)) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  let milliseconds: number
  try {
    milliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  if (!Number.isFinite(milliseconds)) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  return new Date(milliseconds).toISOString()
}

/**
 * Captures and validates the narrow transport functions.
 *
 * @param transport - Candidate caller-owned transport.
 * @returns Captured bound transport functions.
 */
function prepareWorkspaceSearchWriterFenceTransport(
  transport: WorkspaceSearchWriterFenceAwsTransport,
): PreparedWorkspaceSearchWriterFenceAwsTransport {
  if (typeof transport !== 'object' || transport === null) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  const describeTable = transport.describeTable
  const getItem = transport.getItem
  if (
    typeof describeTable !== 'function' ||
    typeof getItem !== 'function'
  ) {
    return failWorkspaceSearchWriterFenceUnavailable()
  }
  return {
    describeTable: (command) =>
      describeTable.call(transport, command),
    getItem: (command) => getItem.call(transport, command),
  }
}

/**
 * Captures diagnostics functions or falls back to structured standard error.
 *
 * Diagnostics are non-authoritative: malformed optional dependencies cannot
 * weaken the guard or replace its stable public failure.
 *
 * @param diagnostics - Candidate caller-owned diagnostics dependencies.
 * @returns Captured safe diagnostics functions.
 */
function prepareWorkspaceSearchWriterFenceDiagnostics(
  diagnostics: WorkspaceSearchWriterFenceDiagnostics,
): PreparedWorkspaceSearchWriterFenceDiagnostics {
  try {
    if (typeof diagnostics !== 'object' || diagnostics === null) {
      return createDefaultWorkspaceSearchWriterFenceDiagnostics()
    }
    const createCorrelationId = diagnostics.createCorrelationId
    const recordFailure = diagnostics.recordFailure
    return {
      createCorrelationId: typeof createCorrelationId === 'function'
        ? () => createCorrelationId.call(diagnostics)
        : randomUUID,
      recordFailure: typeof recordFailure === 'function'
        ? (diagnostic) => recordFailure.call(diagnostics, diagnostic)
        : writeWorkspaceSearchWriterFenceFailureDiagnostic,
    }
  } catch {
    return createDefaultWorkspaceSearchWriterFenceDiagnostics()
  }
}

/**
 * Creates the production diagnostics dependencies.
 *
 * @returns Server-generated identifiers and structured standard-error output.
 */
function createDefaultWorkspaceSearchWriterFenceDiagnostics():
  PreparedWorkspaceSearchWriterFenceDiagnostics {
  return {
    createCorrelationId: randomUUID,
    recordFailure: writeWorkspaceSearchWriterFenceFailureDiagnostic,
  }
}

/**
 * Records only a fixed-shape redacted structured failure.
 *
 * @param diagnostic - Safe observation without raw error material.
 */
function writeWorkspaceSearchWriterFenceFailureDiagnostic(
  diagnostic: WorkspaceSearchWriterFenceFailureDiagnostic,
): void {
  console.error(JSON.stringify(diagnostic))
}

/**
 * Emits one redacted diagnostic without allowing diagnostics to affect safety.
 *
 * @param error - Unknown internal failure used only for safe classification.
 * @param diagnostics - Captured safe diagnostics dependencies.
 */
function recordWorkspaceSearchWriterFenceUnavailable(
  error: unknown,
  diagnostics: PreparedWorkspaceSearchWriterFenceDiagnostics,
): void {
  const diagnostic = Object.freeze({
    event: 'workspace-search.writer-fence.unavailable',
    service: 'mukuroji-writer-fence',
    correlationId: resolveWorkspaceSearchWriterFenceCorrelationId(
      error,
      diagnostics.createCorrelationId,
    ),
    category: classifyWorkspaceSearchWriterFenceFailure(error),
  }) satisfies WorkspaceSearchWriterFenceFailureDiagnostic
  try {
    diagnostics.recordFailure(diagnostic)
  } catch {
    try {
      writeWorkspaceSearchWriterFenceFailureDiagnostic(diagnostic)
    } catch {
      // Diagnostics must never replace the stable fail-closed public error.
    }
  }
}

/**
 * Classifies one failure without copying its message, stack, or raw fields.
 *
 * @param error - Unknown internal source failure.
 * @returns Safe low-cardinality failure category.
 */
function classifyWorkspaceSearchWriterFenceFailure(
  error: unknown,
): WorkspaceSearchWriterFenceFailureCategory {
  try {
    if (
      error instanceof WorkspaceSearchWriterFenceUnavailableError ||
      error instanceof WorkspaceSearchWriterFenceError
    ) {
      return 'validation'
    }
    const errorName = readWorkspaceSearchWriterFenceErrorName(error)
    const statusCode =
      readWorkspaceSearchWriterFenceAwsHttpStatusCode(error)
    if (
      (errorName !== undefined &&
        authorizationErrorNames.has(errorName)) ||
      statusCode === 401 ||
      statusCode === 403
    ) {
      return 'authorization'
    }
  } catch {
    return 'upstream'
  }
  return 'upstream'
}

/**
 * Resolves a bounded AWS request ID or a safe generated diagnostic ID.
 *
 * @param error - Unknown failure that may contain AWS response metadata.
 * @param createCorrelationId - Trusted fallback identifier factory.
 * @returns Bounded safe diagnostic correlation identifier.
 */
function resolveWorkspaceSearchWriterFenceCorrelationId(
  error: unknown,
  createCorrelationId: () => string,
): string {
  const awsRequestId =
    readWorkspaceSearchWriterFenceAwsRequestId(error)
  if (awsRequestId !== undefined) return awsRequestId
  try {
    const generated = readWorkspaceSearchWriterFenceDiagnosticIdentifier(
      createCorrelationId(),
    )
    if (generated !== undefined) return generated
  } catch {
    // The trusted runtime UUID fallback below remains raw-value-free.
  }
  return randomUUID()
}

/**
 * Reads one safe AWS SDK error name.
 *
 * @param error - Unknown caught failure.
 * @returns Bounded exact error name when safely readable.
 */
function readWorkspaceSearchWriterFenceErrorName(
  error: unknown,
): string | undefined {
  const record = readWorkspaceSearchWriterFenceUnknownRecord(error)
  if (record === undefined) return undefined
  try {
    const name = Reflect.get(record, 'name')
    return typeof name === 'string' && name.length <= 128
      ? name
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads one AWS response status without retaining other metadata.
 *
 * @param error - Unknown caught failure.
 * @returns Integer HTTP status when safely readable.
 */
function readWorkspaceSearchWriterFenceAwsHttpStatusCode(
  error: unknown,
): number | undefined {
  const metadata = readWorkspaceSearchWriterFenceAwsMetadata(error)
  if (metadata === undefined) return undefined
  try {
    const statusCode = Reflect.get(metadata, 'httpStatusCode')
    return typeof statusCode === 'number' &&
        Number.isSafeInteger(statusCode)
      ? statusCode
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads one bounded AWS SDK request identifier.
 *
 * @param error - Unknown caught failure.
 * @returns Safe request identifier when present.
 */
function readWorkspaceSearchWriterFenceAwsRequestId(
  error: unknown,
): string | undefined {
  const metadata = readWorkspaceSearchWriterFenceAwsMetadata(error)
  if (metadata === undefined) return undefined
  try {
    return readWorkspaceSearchWriterFenceDiagnosticIdentifier(
      Reflect.get(metadata, 'requestId'),
    )
  } catch {
    return undefined
  }
}

/**
 * Reads AWS SDK metadata as an inspectable record.
 *
 * @param error - Unknown caught failure.
 * @returns Metadata record when safely readable.
 */
function readWorkspaceSearchWriterFenceAwsMetadata(
  error: unknown,
): Record<string, unknown> | undefined {
  const record = readWorkspaceSearchWriterFenceUnknownRecord(error)
  if (record === undefined) return undefined
  try {
    return readWorkspaceSearchWriterFenceUnknownRecord(
      Reflect.get(record, '$metadata'),
    )
  } catch {
    return undefined
  }
}

/**
 * Validates a generated or AWS-provided diagnostic identifier.
 *
 * @param value - Candidate identifier.
 * @returns Bounded safe identifier when valid.
 */
function readWorkspaceSearchWriterFenceDiagnosticIdentifier(
  value: unknown,
): string | undefined {
  return typeof value === 'string' &&
      safeDiagnosticIdentifierPattern.test(value)
    ? value
    : undefined
}

/**
 * Narrows one unknown value to an inspectable record.
 *
 * @param value - Unknown failure or metadata value.
 * @returns Record when the value is a non-null object.
 */
function readWorkspaceSearchWriterFenceUnknownRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return isWorkspaceSearchWriterFenceUnknownRecord(value)
    ? value
    : undefined
}

/**
 * Determines whether one unknown value is an inspectable record.
 *
 * @param value - Unknown failure or metadata value.
 * @returns Whether named properties can be inspected.
 */
function isWorkspaceSearchWriterFenceUnknownRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Maps every asynchronous source failure to the one public unavailable error.
 *
 * @param operation - Complete source operation.
 * @param diagnostics - Captured safe diagnostics dependencies.
 * @returns Operation result when every boundary is valid and available.
 */
async function runWorkspaceSearchWriterFenceUnavailableBoundary<Result>(
  operation: () => Promise<Result>,
  diagnostics: PreparedWorkspaceSearchWriterFenceDiagnostics,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    recordWorkspaceSearchWriterFenceUnavailable(error, diagnostics)
    throw new WorkspaceSearchWriterFenceUnavailableError()
  }
}

/**
 * Maps every synchronous source failure to the one public unavailable error.
 *
 * @param operation - Complete synchronous source operation.
 * @param diagnostics - Captured safe diagnostics dependencies.
 * @returns Operation result when every boundary is valid.
 */
function runWorkspaceSearchWriterFenceUnavailableSyncBoundary<Result>(
  operation: () => Result,
  diagnostics: PreparedWorkspaceSearchWriterFenceDiagnostics,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    recordWorkspaceSearchWriterFenceUnavailable(error, diagnostics)
    throw new WorkspaceSearchWriterFenceUnavailableError()
  }
}

/**
 * Throws the sole public raw-value-free unavailable failure.
 */
function failWorkspaceSearchWriterFenceUnavailable(): never {
  throw new WorkspaceSearchWriterFenceUnavailableError()
}
