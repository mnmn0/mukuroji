import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { loadServerConfig } from '../config/server-config'
import {
  createAwsWorkspaceSearchWriterFenceGuardSource,
  type WorkspaceSearchWriterFenceAwsTableNames,
} from '../runtime/workspace-search-writer-fence-aws'
import {
  bindWorkspaceSearchWriterFenceDocumentClient,
  bindWorkspaceSearchWriterFenceRolloutPendingDocumentClient,
} from '../runtime/workspace-search-writer-fence-document-client'
import {
  createWorkspaceSearchWriterFenceGuardProvider,
  type WorkspaceSearchWriterFenceGuardProvider,
} from '../runtime/workspace-search-writer-fence-invocation'

/** Exact production mode requiring one durable writer-fence guard. */
const requiredWriterFenceMode = 'required'
/** Temporary explicit production mode used before the first open-row bootstrap. */
const rolloutPendingWriterFenceMode = 'rollout-pending'
/** Explicit local Lambda-emulator mode that omits the production guard. */
const localFlociWriterFenceBypassMode = 'local-floci-bypass'
/** Explicit marker used by the repository's Floci deployment. */
const localFlociRuntimeMarker = 'floci'

/**
 * Exact endpoint used to construct each shared configured low-level client.
 */
const configuredDynamoDbClientEndpoints =
  new WeakMap<DynamoDBClient, string | undefined>()

/**
 * Process-stable default provider and exact table-name configuration.
 */
type DefaultWorkspaceSearchWriterFence = {
  /** Provider shared by every guarded document client in this process. */
  readonly provider: WorkspaceSearchWriterFenceGuardProvider
  /** Exact six-table names measured by the shared source. */
  readonly tableNames: WorkspaceSearchWriterFenceAwsTableNames
}

/** Lazy process-stable writer-fence provider. */
let defaultWorkspaceSearchWriterFence:
  | DefaultWorkspaceSearchWriterFence
  | undefined

/**
 * Creates a low-level DynamoDB client from the current server configuration.
 *
 * @returns A configured DynamoDB client.
 */
export function createDynamoDbClient(): DynamoDBClient {
  const config = loadServerConfig()

  const client = new DynamoDBClient({
    region: config.awsRegion,
    ...(config.dynamoDbEndpoint
      ? {
          endpoint: config.dynamoDbEndpoint,
          credentials: {
            accessKeyId: config.environment.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: config.environment.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
  configuredDynamoDbClientEndpoints.set(client, config.dynamoDbEndpoint)
  return client
}

/**
 * Creates a DynamoDB document client with undefined-value removal enabled.
 *
 * @param dynamoDbClient - Low-level DynamoDB client to wrap.
 * @returns A configured DynamoDB document client.
 */
export function createDynamoDbDocumentClient(
  dynamoDbClient: DynamoDBClient = createDynamoDbClient(),
): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(dynamoDbClient, {
    marshallOptions: { removeUndefinedValues: true },
  })
}

/**
 * Creates a DocumentClient that guards mutations to migration-bound tables.
 *
 * Production and real AWS runtimes require exact six-table configuration.
 * Repository tests, local Bun development, and an explicitly marked Floci
 * Lambda runtime omit the guard because no production TableId-bound row exists.
 *
 * @param dynamoDbClient - Low-level client shared with table measurement.
 * @returns A guarded or explicitly local-only DocumentClient.
 */
export function createWorkspaceSearchWriterDynamoDbDocumentClient(
  dynamoDbClient: DynamoDBClient = createDynamoDbClient(),
): DynamoDBDocumentClient {
  const documentClient = createDynamoDbDocumentClient(dynamoDbClient)
  const config = loadServerConfig()
  if (
    isRepositoryTestDynamoDbRuntime(
      config.environment,
      config.dynamoDbEndpoint,
      dynamoDbClient,
    )
  ) {
    return documentClient
  }

  const configuredMode =
    config.environment.MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE?.trim()
  if (
    isLocalBunDynamoDbRuntime(
      config.environment,
      config.dynamoDbEndpoint,
      dynamoDbClient,
    ) &&
    configuredMode === undefined
  ) {
    return documentClient
  }
  if (configuredMode === localFlociWriterFenceBypassMode) {
    if (
      config.environment.NODE_ENV === 'production' ||
      config.environment.MUKUROJI_LOCAL_AWS_RUNTIME !==
        localFlociRuntimeMarker ||
      !isVerifiedLocalDynamoDbTransport(
        dynamoDbClient,
        config.dynamoDbEndpoint,
      )
    ) {
      throw new TypeError(
        'Workspace Search writer-fence local bypass configuration is invalid.',
      )
    }
    return documentClient
  }
  if (configuredMode === rolloutPendingWriterFenceMode) {
    if (
      !isExactAwsLambdaWriterFenceRolloutPendingRuntime(
        config.environment,
        config.dynamoDbEndpoint,
      )
    ) {
      throw new TypeError(
        'Workspace Search writer-fence rollout-pending configuration is invalid.',
      )
    }
    console.warn('WORKSPACE_SEARCH_WRITER_FENCE_ROLLOUT_PENDING')
    return bindWorkspaceSearchWriterFenceRolloutPendingDocumentClient(
      documentClient,
      readWorkspaceSearchWriterFenceTableNames(config.environment),
    )
  }
  if (configuredMode !== requiredWriterFenceMode) {
    throw new TypeError(
      'MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE=required is required.',
    )
  }

  const tableNames = readWorkspaceSearchWriterFenceTableNames(
    config.environment,
  )
  const writerFence = resolveDefaultWorkspaceSearchWriterFence(
    dynamoDbClient,
    tableNames,
  )
  return bindWorkspaceSearchWriterFenceDocumentClient(
    documentClient,
    writerFence.provider,
    writerFence.tableNames,
  )
}

/**
 * Restricts the temporary pre-bootstrap bridge to a real AWS Lambda shape.
 *
 * This mode permits the production runtime shape only while AppConfig
 * admission is disabled and writers are drained. A separate SDK middleware
 * still blocks every fenced mutation if admission is accidentally re-enabled.
 * It is not a local/test bypass and must be removed after bootstrap.
 *
 * @param environment - Current server environment.
 * @param endpoint - Resolved DynamoDB endpoint, which must be absent.
 * @returns Whether the explicit temporary production bridge is permitted.
 */
function isExactAwsLambdaWriterFenceRolloutPendingRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  endpoint: string | undefined,
): boolean {
  return environment.NODE_ENV !== 'test' &&
    endpoint === undefined &&
    Boolean(environment.AWS_LAMBDA_FUNCTION_NAME?.trim()) &&
    Boolean(environment.AWS_EXECUTION_ENV?.trim()) &&
    environment.MUKUROJI_LOCAL_AWS_RUNTIME === undefined
}

/**
 * Determines whether missing tables may be bootstrapped for the configured local endpoint.
 *
 * @returns Whether local DynamoDB table bootstrapping is enabled.
 */
export function shouldBootstrapLocalDynamoDb(): boolean {
  const endpoint = loadServerConfig().dynamoDbEndpoint

  return isExplicitLocalDynamoDbEndpoint(endpoint)
}

/**
 * Resolves the one source identity shared by every client in this process.
 *
 * @param dynamoDbClient - Low-level transport captured by the first caller.
 * @param tableNames - Exact canonical six-table names.
 * @returns Process-stable provider and table-name configuration.
 */
function resolveDefaultWorkspaceSearchWriterFence(
  dynamoDbClient: DynamoDBClient,
  tableNames: WorkspaceSearchWriterFenceAwsTableNames,
): DefaultWorkspaceSearchWriterFence {
  const existing = defaultWorkspaceSearchWriterFence
  if (existing) {
    if (!writerFenceTableNamesEqual(existing.tableNames, tableNames)) {
      throw new TypeError(
        'Workspace Search writer-fence table configuration changed.',
      )
    }
    return existing
  }

  const source = createAwsWorkspaceSearchWriterFenceGuardSource(
    tableNames,
    {
      async describeTable(command) {
        return await dynamoDbClient.send(command)
      },
      async getItem(command) {
        return await dynamoDbClient.send(command)
      },
    },
    {
      recordFailure(diagnostic) {
        console.error(JSON.stringify(diagnostic))
      },
    },
  )
  const resolved = Object.freeze({
    provider: createWorkspaceSearchWriterFenceGuardProvider(source),
    tableNames,
  })
  defaultWorkspaceSearchWriterFence = resolved
  return resolved
}

/**
 * Reads exact canonical names without accepting compatibility aliases.
 *
 * @param environment - Current server environment.
 * @returns Validated six-table writer-fence configuration.
 */
function readWorkspaceSearchWriterFenceTableNames(
  environment: Readonly<Record<string, string | undefined>>,
): WorkspaceSearchWriterFenceAwsTableNames {
  return Object.freeze({
    'project-directory': readRequiredWriterFenceEnvironment(
      environment,
      'PROJECT_DIRECTORY_TABLE_NAME',
    ),
    'work-items': readRequiredWriterFenceEnvironment(
      environment,
      'WORK_ITEMS_TABLE_NAME',
    ),
    collaboration: readRequiredWriterFenceEnvironment(
      environment,
      'COLLABORATION_TABLE_NAME',
    ),
    documents: readRequiredWriterFenceEnvironment(
      environment,
      'DOCUMENTS_TABLE_NAME',
    ),
    'workspace-search': readRequiredWriterFenceEnvironment(
      environment,
      'WORKSPACE_SEARCH_TABLE_NAME',
    ),
    'migration-state': readRequiredWriterFenceEnvironment(
      environment,
      'WORKSPACE_SEARCH_MIGRATION_STATE_TABLE_NAME',
    ),
  })
}

/**
 * Reads one non-blank canonical writer-fence environment value.
 *
 * @param environment - Current server environment.
 * @param name - Exact canonical environment key.
 * @returns Trimmed configured value.
 */
function readRequiredWriterFenceEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim()
  if (!value) {
    throw new TypeError(`${name} is required for the Workspace Search writer fence.`)
  }
  return value
}

/**
 * Compares exact six-table configurations.
 *
 * @param left - Existing process configuration.
 * @param right - Candidate process configuration.
 * @returns Whether every role retains the same physical table name.
 */
function writerFenceTableNamesEqual(
  left: WorkspaceSearchWriterFenceAwsTableNames,
  right: WorkspaceSearchWriterFenceAwsTableNames,
): boolean {
  return left['project-directory'] === right['project-directory'] &&
    left['work-items'] === right['work-items'] &&
    left.collaboration === right.collaboration &&
    left.documents === right.documents &&
    left['workspace-search'] === right['workspace-search'] &&
    left['migration-state'] === right['migration-state']
}

/**
 * Detects local Bun development with an exact local DynamoDB endpoint.
 *
 * @param environment - Current server environment.
 * @param endpoint - Resolved DynamoDB endpoint.
 * @param dynamoDbClient - Low-level transport that must match the endpoint.
 * @returns Whether implicit developer-only bypass is permitted.
 */
function isLocalBunDynamoDbRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  endpoint: string | undefined,
  dynamoDbClient: DynamoDBClient,
): boolean {
  return typeof Bun !== 'undefined' &&
    !environment.AWS_LAMBDA_FUNCTION_NAME &&
    environment.NODE_ENV !== 'production' &&
    isVerifiedLocalDynamoDbTransport(dynamoDbClient, endpoint)
}

/**
 * Detects the repository test runner without creating a Lambda bypass.
 *
 * @param environment - Current server environment.
 * @param endpoint - Resolved DynamoDB endpoint.
 * @param dynamoDbClient - Low-level transport that must match the endpoint.
 * @returns Whether this is an isolated local Bun test process.
 */
function isRepositoryTestDynamoDbRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  endpoint: string | undefined,
  dynamoDbClient: DynamoDBClient,
): boolean {
  return typeof Bun !== 'undefined' &&
    environment.NODE_ENV === 'test' &&
    !environment.AWS_LAMBDA_FUNCTION_NAME &&
    !environment.AWS_EXECUTION_ENV &&
    isVerifiedLocalDynamoDbTransport(dynamoDbClient, endpoint)
}

/**
 * Proves that a low-level client was constructed for the validated local URL.
 *
 * Environment-only endpoint checks are insufficient for injected clients: an
 * unconfigured client would still resolve the real regional AWS endpoint.
 *
 * @param dynamoDbClient - Candidate low-level transport.
 * @param endpoint - Resolved server endpoint expected by the runtime.
 * @returns Whether this factory created the client for that exact local URL.
 */
function isVerifiedLocalDynamoDbTransport(
  dynamoDbClient: DynamoDBClient,
  endpoint: string | undefined,
): boolean {
  return isExplicitLocalDynamoDbEndpoint(endpoint) &&
    configuredDynamoDbClientEndpoints.has(dynamoDbClient) &&
    configuredDynamoDbClientEndpoints.get(dynamoDbClient) === endpoint
}

/**
 * Validates a loopback or named Floci HTTP DynamoDB endpoint.
 *
 * @param endpoint - Candidate resolved endpoint.
 * @returns Whether it is an exact supported local origin.
 */
function isExplicitLocalDynamoDbEndpoint(
  endpoint: string | undefined,
): boolean {
  if (!endpoint) return false
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname === '/' &&
    !parsed.search &&
    !parsed.hash &&
    [
      'localhost',
      '127.0.0.1',
      '[::1]',
      '0.0.0.0',
      'floci',
      'localstack',
    ].includes(parsed.hostname)
}
