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

/**
 * Loads existing server defaults and production validation into an immutable value.
 */
export function loadServerConfig(
  environment: ServerEnvironment = readServerEnvironment(),
  runtime: ServerRuntime = {
    localBun: typeof Bun !== 'undefined' && !environment.AWS_LAMBDA_FUNCTION_NAME,
  },
): ServerConfig {
  const production = environment.NODE_ENV === 'production' ||
    Boolean(environment.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(environment.AWS_EXECUTION_ENV)
  const awsRegion = environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION ?? 'us-east-1'
  const configuredOrigins = (environment.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  const dynamoDbEndpoint = firstNonBlank(
    environment.DYNAMODB_ENDPOINT,
    environment.AWS_ENDPOINT_URL_DYNAMODB,
    environment.AWS_ENDPOINT_URL,
  ) ?? (runtime.localBun ? 'http://localhost:4566' : undefined)
  const cognitoEndpoint =
    environment.COGNITO_ENDPOINT ?? environment.AWS_ENDPOINT_URL
  const sqsEndpoint = firstNonBlank(
    environment.SQS_ENDPOINT,
    environment.AWS_ENDPOINT_URL_SQS,
    environment.AWS_ENDPOINT_URL,
  )
  const configuredSecretsManagerEndpoint = firstNonBlank(
    environment.SECRETS_MANAGER_ENDPOINT,
    environment.AWS_ENDPOINT_URL_SECRETS_MANAGER,
    environment.AWS_ENDPOINT_URL_SECRETSMANAGER,
    environment.AWS_ENDPOINT_URL,
  )
  const secretsManagerEndpoint = configuredSecretsManagerEndpoint
    ? validateSecretsManagerEndpoint(configuredSecretsManagerEndpoint, awsRegion, environment)
    : undefined

  return Object.freeze({
    environment,
    awsRegion,
    dynamoDbEndpoint,
    sqsEndpoint,
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
      environment.WORKSPACE_SEARCH_TABLE_NAME ??
        environment.MUKUROJI_WORKSPACE_SEARCH_TABLE,
    ),
    runtimeRole: environment.MUKUROJI_RUNTIME_ROLE,
    production,
    get publicApiCursorSecret() {
      return resolvePublicApiCursorSecret(environment, production)
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
