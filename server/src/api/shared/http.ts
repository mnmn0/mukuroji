import { type LambdaEvent } from 'hono/aws-lambda'
import type { Context } from 'hono'
import { TenantAdministrationError } from '../../modules/tenant-administration'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { CognitoServiceError } from '../../modules/authentication'
import { createMutationAuditContext, type AuditActorKind } from '../../modules/audit/audit'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { CollaborationError } from '../../modules/collaboration/collaboration'

/**
 * Workspace principal authentication の例外的な route 境界です。
 */
export type WorkspaceAuthenticationOptions = {
  /**
   * 事前登録済み recovery identity の MFA/recent-auth 検証前アクセスかどうかです。
   */
  breakGlassCandidate?: boolean
}

/**
 * Parses a JSON request body without throwing on malformed input.
 *
 * @param request - Request whose body is read.
 * @returns The parsed body, or `undefined` when the body is not valid JSON.
 */
export async function readJson<T>(request: { json: () => Promise<T> }) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/**
 * Creates the audit mutation context for a request from its headers and route.
 *
 * @param c - Hono request context.
 * @param workspaceId - Workspace that scopes the operation.
 * @param actorId - Actor ID recorded in the audit context.
 * @param displayName - Actor display name recorded in the audit context.
 * @param body - Request body recorded in the audit context.
 * @param idempotencyKeyOverride - Idempotency key that replaces the request header.
 * @param actorKind - Audit actor kind.
 * @param correlationIdOverride - Correlation ID that replaces the request header.
 * @returns The mutation audit context.
 */
export function createRequestMutationContext(
  c: Context,
  workspaceId: string,
  actorId: string,
  displayName: string,
  body: unknown,
  idempotencyKeyOverride?: string,
  actorKind: AuditActorKind = 'user',
  correlationIdOverride?: string,
) {
  const idempotencyKey = idempotencyKeyOverride ??
    (c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID())
  const correlationId = correlationIdOverride ?? c.req.header('X-Correlation-Id')?.trim()
  const path = new URL(c.req.url).pathname

  return createMutationAuditContext({
    workspaceId,
    actor: {
      id: actorId,
      kind: actorKind,
      displayName,
    },
    idempotencyKey,
    ...(correlationId ? { correlationId } : {}),
    request: {
      method: c.req.method,
      path,
      body,
    },
    source: {
      kind: 'api',
      requestId: c.req.header('X-Request-Id'),
      method: c.req.method,
      route: path,
      ipAddress: c.req.header('X-Forwarded-For')?.split(',')[0]?.trim(),
      userAgent: c.req.header('User-Agent'),
    },
  })
}

/**
 * Converts tenant policy failures to the cross-route Workspace authorization shape.
 *
 * @param error - Tenant policy or infrastructure failure.
 * @returns A Workspace boundary error for tenant failures, otherwise the original error.
 */
export function toTenantLifecycleBoundaryError(error: unknown): unknown {
  if (!(error instanceof TenantAdministrationError)) return error
  return new WorkspaceAccessError(
    error.status,
    error.code,
    error.message,
    { cause: error },
  )
}

/**
 * Reads the bearer access token from the `Authorization` header.
 *
 * @param c - Hono request context.
 * @returns The access token, or `undefined` when the header is absent or malformed.
 */
export function readBearerAccessToken(c: Context) {
  const authorization = c.req.header('Authorization') ?? ''

  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]
}

/**
 * Converts Cognito authentication failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @returns The HTTP error response.
 */
export function toAuthErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof CognitoServiceError)) {
    console.error(error)
    return c.json({ message: 'Unexpected authentication error.' }, 500)
  }

  if (error.code === 'CognitoTimeout') {
    console.error(error)
    return c.json({ message: 'Cognito local service timed out.' }, 504)
  }

  if (error.code === 'InvalidCognitoResponse' || error.status === 200 || !error.code) {
    console.error(error)
    return c.json({ message: 'Cognito local service returned an invalid response.' }, 502)
  }

  if (error.code === 'NotAuthorizedException' || error.code === 'UserNotFoundException') {
    return c.json({ message: 'Invalid email or password.' }, 401)
  }

  if (error.code === 'CognitoAccessTokenInvalid') {
    return c.json({ message: 'Authentication failed.' }, 401)
  }

  if (error.code === 'CognitoConfigurationMissing') {
    console.error(error)
    return c.json({ message: 'Cognito is not configured.' }, 503)
  }

  if (error.code === 'CognitoUserDisabled') {
    return c.json({ code: 'CognitoUserDisabled' as const, message: error.message }, 409)
  }

  if (error.code === 'WorkspaceDirectoryConflict') {
    return c.json({ message: error.message }, 409)
  }

  if (error.code === 'ResourceNotFoundException' || error.code === 'ClientNotFoundException') {
    return c.json({ message: 'Cognito local resources are not ready.' }, 503)
  }

  if (error.status >= 500) {
    console.error(error)
    return c.json({ message: 'Cognito local service is unavailable.' }, 502)
  }

  return c.json({ message: error.message }, 400)
}

/**
 * Resolves a rate-limit client key from the transport source and trusted proxies.
 *
 * @param transportSource - Network peer observed by the server transport.
 * @param forwardedFor - Untrusted forwarded chain supplied by the request.
 * @param trustedProxyAddresses - Transport peers allowed to supply the forwarded chain.
 * @returns The trusted client source or a stable unavailable marker.
 */
export function resolveRequestClientKey(
  transportSource: string | undefined,
  forwardedFor: string | undefined,
  trustedProxyAddresses: ReadonlySet<string>,
) {
  const normalizedTransportSource = transportSource?.trim()
  if (normalizedTransportSource && trustedProxyAddresses.has(normalizedTransportSource)) {
    const forwardedSource = forwardedFor
      ?.split(',')
      .map((entry) => entry.trim())
      .find(Boolean)
    if (forwardedSource) return forwardedSource
  }
  return normalizedTransportSource || 'transport-unavailable'
}

/**
 * Reads one positive optimistic revision.
 *
 * @param value - Untrusted revision.
 * @param label - Safe validation label.
 * @returns Positive integer revision.
 */
export function readCuratedContextRevision(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalidCuratedContextInput(`${label} must be a positive integer.`)
  }
  return value
}

/**
 * Reads one curated-context identifier.
 *
 * @param value - Untrusted identifier.
 * @param label - Safe validation label.
 * @returns Trimmed bounded identifier.
 */
export function readCuratedContextIdentifier(value: unknown, label: string) {
  return readCuratedContextText(value, label, 512)
}

/**
 * Normalizes one required curated-context text field.
 *
 * @param value - Untrusted text.
 * @param label - Safe validation label.
 * @param maximumLength - Maximum retained UTF-16 length.
 * @returns Trimmed normalized text.
 */
export function readCuratedContextText(value: unknown, label: string, maximumLength: number) {
  if (typeof value !== 'string') {
    throw invalidCuratedContextInput(`${label} must be text.`)
  }
  const normalized = value.replace(/\r\n?/gu, '\n').trim()
  if (!normalized || normalized.length > maximumLength) {
    throw invalidCuratedContextInput(`${label} is empty or too long.`)
  }
  return normalized
}

/**
 * Creates a stable collaboration validation error.
 *
 * @param message - Safe client-facing validation message.
 * @returns Stable validation error.
 */
export function invalidCuratedContextInput(message: string) {
  return new CollaborationError(400, 'InvalidCuratedContextInput', message)
}

/**
 * Reads the configured browser origins accepted by CORS middleware.
 *
 * @returns Normalized allowed origins.
 */
export function getAllowedOrigins() {
  return loadServerConfig().allowedOrigins
}

/**
 * Normalizes a Lambda HTTP event path to the canonical `/api` route prefix.
 *
 * @param event - API Gateway or Lambda Function URL event.
 * @returns The original event when canonical, or a copy with normalized paths.
 */
export function normalizeLambdaApiEvent(event: LambdaEvent): LambdaEvent {
  if ('rawPath' in event) {
    const rawPath = normalizeApiRequestPath(event.rawPath)

    if (rawPath === event.rawPath) {
      return event
    }

    return {
      ...event,
      rawPath,
      requestContext: {
        ...event.requestContext,
        http: {
          ...event.requestContext.http,
          path: rawPath,
        },
      },
    }
  }

  const path = normalizeApiRequestPath(event.path)

  return path === event.path ? event : { ...event, path }
}

function normalizeApiRequestPath(path: string) {
  if (path === '/' || path === '/api' || path.startsWith('/api/')) {
    return path
  }

  return `/api${path.startsWith('/') ? path : `/${path}`}`
}
