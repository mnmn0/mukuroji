import { z } from 'zod'

/**
 * Environment values available to the server composition root.
 */
export type ServerEnvironment = Readonly<Record<string, string | undefined>>

/**
 * Runtime properties used while resolving environment-dependent server defaults.
 */
export interface ServerRuntime {
  /** Whether the process is running under Bun outside Lambda. */
  readonly localBun: boolean
}

/**
 * Validated server configuration shared by Bun and Lambda entrypoints.
 */
export interface ServerConfig {
  /** Original environment map used by domain-specific adapter configuration. */
  readonly environment: ServerEnvironment
  /** AWS region used by infrastructure clients. */
  readonly awsRegion: string
  /** Optional DynamoDB endpoint, including the local Bun default. */
  readonly dynamoDbEndpoint: string | undefined
  /** Optional SQS endpoint, including the shared AWS endpoint fallback. */
  readonly sqsEndpoint: string | undefined
  /** Optional Secrets Manager endpoint, including the shared AWS endpoint fallback. */
  readonly secretsManagerEndpoint: string | undefined
  /** Whether the validated Secrets Manager endpoint targets an explicit local emulator. */
  readonly secretsManagerEndpointIsLocal: boolean
  /** Optional Cognito endpoint, including the local Bun default. */
  readonly cognitoEndpoint: string | undefined
  /** Browser origins accepted by the CORS middleware. */
  readonly allowedOrigins: readonly string[]
  /** Port used by the local Bun HTTP server. */
  readonly port: number
  /** Whether workspace-search projections should be maintained. */
  readonly workspaceSearchProjectionEnabled: boolean
  /** Optional specialized runtime role used by non-API Lambda bundles. */
  readonly runtimeRole: string | undefined
  /** Whether the process is running with production validation enabled. */
  readonly production: boolean
  /** Full Git commit SHA identifying the deployed application, when configured. */
  readonly applicationCommitSha: string | undefined
  /** Secret used to sign opaque Public API cursors. */
  readonly publicApiCursorSecret: string
}

/** Default origins accepted by local Vite and Storybook development servers. */
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:6006',
  'http://127.0.0.1:6006',
] as const

/** Local signing value retained for non-production development and tests. */
const LOCAL_PUBLIC_API_CURSOR_SECRET = 'mukuroji-local-public-api-cursor-signing-secret'

/** Explicit marker accepted for the repository's Floci AWS emulator runtime. */
const LOCAL_AWS_RUNTIME_MARKER = 'floci'

/**
 * Reads the live runtime environment without copying mutable process state.
 */
export function readServerEnvironment(): ServerEnvironment {
  return typeof Bun !== 'undefined' ? Bun.env : process.env
}

/** Optional raw environment text, kept exactly as the runtime supplied it. */
const optionalEnvironmentText = z.string().optional()

/** Message used when deployment commit provenance is malformed. */
const APPLICATION_COMMIT_SHA_MESSAGE =
  'MUKUROJI_APPLICATION_COMMIT_SHA must be one full lowercase 40-character Git commit SHA.'

/**
 * Environment variables the server configuration reads, validated as text.
 *
 * Unknown keys are ignored here; adapters keep reading them from the live
 * {@link ServerConfig.environment} map.
 */
const serverEnvironmentSchema = z.object({
  NODE_ENV: optionalEnvironmentText,
  AWS_LAMBDA_FUNCTION_NAME: optionalEnvironmentText,
  AWS_EXECUTION_ENV: optionalEnvironmentText,
  AWS_REGION: optionalEnvironmentText,
  AWS_DEFAULT_REGION: optionalEnvironmentText,
  ALLOWED_ORIGINS: optionalEnvironmentText,
  DYNAMODB_ENDPOINT: optionalEnvironmentText,
  AWS_ENDPOINT_URL_DYNAMODB: optionalEnvironmentText,
  AWS_ENDPOINT_URL: optionalEnvironmentText,
  COGNITO_ENDPOINT: optionalEnvironmentText,
  SQS_ENDPOINT: optionalEnvironmentText,
  AWS_ENDPOINT_URL_SQS: optionalEnvironmentText,
  SECRETS_MANAGER_ENDPOINT: optionalEnvironmentText,
  AWS_ENDPOINT_URL_SECRETS_MANAGER: optionalEnvironmentText,
  AWS_ENDPOINT_URL_SECRETSMANAGER: optionalEnvironmentText,
  MUKUROJI_LOCAL_AWS_RUNTIME: optionalEnvironmentText,
  PORT: optionalEnvironmentText,
  WORKSPACE_SEARCH_TABLE_NAME: optionalEnvironmentText,
  MUKUROJI_RUNTIME_ROLE: optionalEnvironmentText,
  MUKUROJI_APPLICATION_COMMIT_SHA: z
    .string()
    .regex(/^[0-9a-f]{40}$/, APPLICATION_COMMIT_SHA_MESSAGE)
    .optional(),
})

/** Environment variables validated by {@link serverEnvironmentSchema}. */
type ParsedServerEnvironment = z.infer<typeof serverEnvironmentSchema>

/** Validated configuration values derived from the environment, excluding live and lazy members. */
type ServerConfigValues = Omit<ServerConfig, 'environment' | 'publicApiCursorSecret'>

/** Schemas built for each local-Bun runtime mode, reused across loads. */
const serverConfigSchemas = new Map<boolean, z.ZodType<ServerConfigValues, ServerEnvironment>>()

/**
 * Returns the configuration schema for one runtime mode.
 *
 * @param runtime - Runtime properties that select local defaults.
 * @returns A schema that validates the environment and derives the typed configuration values.
 */
function getServerConfigSchema(
  runtime: ServerRuntime,
): z.ZodType<ServerConfigValues, ServerEnvironment> {
  const cached = serverConfigSchemas.get(runtime.localBun)
  if (cached) return cached
  const schema = serverEnvironmentSchema.transform(
    (environment, context) => deriveServerConfigValues(environment, runtime, context),
  )
  serverConfigSchemas.set(runtime.localBun, schema)
  return schema
}

/**
 * Derives typed configuration values, reporting unsafe endpoints as schema issues.
 *
 * @param environment - Environment variables already validated as text.
 * @param runtime - Runtime properties that select local defaults.
 * @param context - Transform context that collects validation issues.
 * @returns The derived configuration values, or `z.NEVER` after reporting an issue.
 */
function deriveServerConfigValues(
  environment: ParsedServerEnvironment,
  runtime: ServerRuntime,
  context: z.RefinementCtx,
): ServerConfigValues {
  const production = environment.NODE_ENV === 'production' ||
    Boolean(environment.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(environment.AWS_EXECUTION_ENV)
  const awsRegion = environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION ?? 'us-east-1'
  const configuredOrigins = (environment.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  const configuredDynamoDbEndpoint = firstNonBlank(
    environment.DYNAMODB_ENDPOINT,
    environment.AWS_ENDPOINT_URL_DYNAMODB,
    environment.AWS_ENDPOINT_URL,
  ) ?? (runtime.localBun ? 'http://localhost:4566' : undefined)
  const configuredSecretsManagerEndpoint = firstNonBlank(
    environment.SECRETS_MANAGER_ENDPOINT,
    environment.AWS_ENDPOINT_URL_SECRETS_MANAGER,
    environment.AWS_ENDPOINT_URL_SECRETSMANAGER,
    environment.AWS_ENDPOINT_URL,
  )

  let dynamoDbEndpoint: string | undefined
  let secretsManagerEndpoint: string | undefined
  try {
    dynamoDbEndpoint = configuredDynamoDbEndpoint === undefined
      ? undefined
      : validateDynamoDbEndpoint(configuredDynamoDbEndpoint, awsRegion, environment)
    secretsManagerEndpoint = configuredSecretsManagerEndpoint === undefined
      ? undefined
      : validateSecretsManagerEndpoint(configuredSecretsManagerEndpoint, awsRegion, environment)
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Server endpoint configuration is invalid.',
    })
    return z.NEVER
  }

  const cognitoEndpoint = environment.COGNITO_ENDPOINT ?? environment.AWS_ENDPOINT_URL
  return {
    awsRegion,
    dynamoDbEndpoint,
    sqsEndpoint: firstNonBlank(
      environment.SQS_ENDPOINT,
      environment.AWS_ENDPOINT_URL_SQS,
      environment.AWS_ENDPOINT_URL,
    ),
    secretsManagerEndpoint,
    secretsManagerEndpointIsLocal: secretsManagerEndpoint
      ? isLocalSecretsManagerHostname(new URL(secretsManagerEndpoint).hostname)
      : false,
    cognitoEndpoint: cognitoEndpoint?.trim()
      ? trimTrailingSlash(cognitoEndpoint.trim())
      : runtime.localBun
        ? 'http://localhost:4566'
        : undefined,
    allowedOrigins: Object.freeze(
      configuredOrigins.length > 0 ? configuredOrigins : [...DEFAULT_ALLOWED_ORIGINS],
    ),
    port: Number(environment.PORT ?? 3000),
    workspaceSearchProjectionEnabled: environment.NODE_ENV !== 'test' || Boolean(
      environment.WORKSPACE_SEARCH_TABLE_NAME,
    ),
    runtimeRole: environment.MUKUROJI_RUNTIME_ROLE,
    production,
    applicationCommitSha: environment.MUKUROJI_APPLICATION_COMMIT_SHA,
  }
}

/**
 * Loads existing server defaults and production validation into an immutable value.
 *
 * The environment is validated and converted by a zod schema. A validation
 * failure throws a `TypeError` carrying the first issue's message.
 *
 * @param environment - Live environment map, or an isolated map in tests.
 * @param runtime - Runtime properties that select local defaults.
 * @returns The validated, frozen server configuration.
 */
export function loadServerConfig(
  environment: ServerEnvironment = readServerEnvironment(),
  runtime: ServerRuntime = {
    localBun: typeof Bun !== 'undefined' &&
      environment.NODE_ENV !== 'production' &&
      !environment.AWS_LAMBDA_FUNCTION_NAME &&
      !environment.AWS_EXECUTION_ENV,
  },
): ServerConfig {
  const parsed = getServerConfigSchema(runtime).safeParse(environment)
  if (!parsed.success) {
    throw new TypeError(
      parsed.error.issues[0]?.message ?? 'Server configuration is invalid.',
    )
  }
  const values = parsed.data
  return Object.freeze({
    environment,
    ...values,
    get publicApiCursorSecret() {
      return resolvePublicApiCursorSecret(environment, values.production)
    },
  })
}

/** Applies the existing production-only Public API cursor secret validation lazily. */
function resolvePublicApiCursorSecret(
  environment: ServerEnvironment,
  production: boolean,
): string {
  const configured = environment.PUBLIC_API_CURSOR_SECRET ??
    environment.MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY
  if (configured && Buffer.byteLength(configured, 'utf8') >= 32) {
    return configured
  }
  if (production) {
    throw new TypeError('A 32-byte Public API cursor signing secret is required.')
  }
  return LOCAL_PUBLIC_API_CURSOR_SECRET
}

/** Returns the first non-blank environment value. */
function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim()
}

/** Removes trailing slashes from endpoint URLs. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Validates and normalizes a configured Secrets Manager endpoint.
 *
 * AWS endpoints must use the selected region's standard or FIPS hostname. Local
 * HTTP endpoints require the explicit Floci marker and are never accepted when
 * `NODE_ENV=production`.
 */
function validateSecretsManagerEndpoint(
  value: string,
  awsRegion: string,
  environment: ServerEnvironment,
): string {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new TypeError('Secrets Manager endpoint must be a valid absolute URL.')
  }

  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new TypeError(
      'Secrets Manager endpoint must not include credentials, a path, a query, or a fragment.',
    )
  }

  if (isLocalSecretsManagerHostname(endpoint.hostname)) {
    if (
      endpoint.protocol !== 'http:' ||
      environment.MUKUROJI_LOCAL_AWS_RUNTIME !== LOCAL_AWS_RUNTIME_MARKER ||
      environment.NODE_ENV === 'production'
    ) {
      throw new TypeError(
        'Local Secrets Manager endpoints require MUKUROJI_LOCAL_AWS_RUNTIME=floci outside NODE_ENV=production.',
      )
    }
    return endpoint.origin
  }

  if (
    endpoint.protocol !== 'https:' ||
    hasExplicitPort(value) ||
    !isRegionBoundAwsSecretsManagerHostname(endpoint.hostname, awsRegion)
  ) {
    throw new TypeError(
      'Secrets Manager endpoint must use the configured AWS region standard or FIPS HTTPS hostname.',
    )
  }

  return endpoint.origin
}

/**
 * Validates and normalizes a configured DynamoDB endpoint.
 *
 * Local emulator endpoints are limited to known hosts and HTTP.  Remote
 * endpoints must be the selected region's standard or FIPS AWS hostname so
 * that credentials are not sent to an arbitrary endpoint.
 */
function validateDynamoDbEndpoint(
  value: string,
  awsRegion: string,
  environment: ServerEnvironment,
): string {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new TypeError('DynamoDB endpoint must be a valid absolute URL.')
  }

  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new TypeError(
      'DynamoDB endpoint must not include credentials, a path, a query, or a fragment.',
    )
  }

  if (isLocalDynamoDbHostname(endpoint.hostname)) {
    if (
      endpoint.protocol !== 'http:' ||
      environment.NODE_ENV === 'production' ||
      (environment.AWS_LAMBDA_FUNCTION_NAME || environment.AWS_EXECUTION_ENV) &&
        environment.MUKUROJI_LOCAL_AWS_RUNTIME !== LOCAL_AWS_RUNTIME_MARKER
    ) {
      throw new TypeError(
        'Local DynamoDB endpoints require an explicit non-production Floci runtime.',
      )
    }
    return endpoint.origin
  }

  if (
    endpoint.protocol !== 'https:' ||
    hasExplicitPort(value) ||
    !isRegionBoundAwsDynamoDbHostname(endpoint.hostname, awsRegion)
  ) {
    throw new TypeError(
      'DynamoDB endpoint must use the configured AWS region standard or FIPS HTTPS hostname.',
    )
  }

  return endpoint.origin
}

/** Returns whether an absolute URL spells out a port in its authority component. */
function hasExplicitPort(value: string): boolean {
  const authorityStart = value.indexOf('://') + 3
  const authorityEndOffset = value.slice(authorityStart).search(/[/?#]/)
  const authorityEnd = authorityEndOffset === -1
    ? value.length
    : authorityStart + authorityEndOffset
  const authority = value.slice(authorityStart, authorityEnd)
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1)

  if (hostAndPort.startsWith('[')) {
    return hostAndPort.indexOf(']') !== hostAndPort.length - 1
  }
  return hostAndPort.includes(':')
}

/** Returns whether a hostname is an explicitly supported local AWS emulator host. */
function isLocalSecretsManagerHostname(hostname: string): boolean {
  return [
    'localhost',
    '127.0.0.1',
    '[::1]',
    'floci',
    'localstack',
  ].includes(hostname)
}

/** Returns whether a hostname is an explicitly supported local DynamoDB host. */
function isLocalDynamoDbHostname(hostname: string): boolean {
  return [
    'localhost',
    '127.0.0.1',
    '[::1]',
    '0.0.0.0',
    'floci',
    'localstack',
  ].includes(hostname)
}

/** Returns whether a hostname is an exact regional AWS Secrets Manager endpoint. */
function isRegionBoundAwsSecretsManagerHostname(
  hostname: string,
  awsRegion: string,
): boolean {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+-[0-9]+$/.test(awsRegion)) {
    return false
  }

  return [
    `secretsmanager.${awsRegion}.amazonaws.com`,
    `secretsmanager-fips.${awsRegion}.amazonaws.com`,
    `secretsmanager.${awsRegion}.amazonaws.com.cn`,
    `secretsmanager-fips.${awsRegion}.amazonaws.com.cn`,
  ].includes(hostname)
}

/** Returns whether a hostname is an exact regional AWS DynamoDB endpoint. */
function isRegionBoundAwsDynamoDbHostname(
  hostname: string,
  awsRegion: string,
): boolean {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+-[0-9]+$/.test(awsRegion)) {
    return false
  }

  return [
    `dynamodb.${awsRegion}.amazonaws.com`,
    `dynamodb-fips.${awsRegion}.amazonaws.com`,
    `dynamodb.${awsRegion}.amazonaws.com.cn`,
    `dynamodb-fips.${awsRegion}.amazonaws.com.cn`,
  ].includes(hostname)
}
