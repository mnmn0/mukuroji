import { X509Certificate, createHash, createHmac } from 'node:crypto'
import { resolve4, resolve6, resolveTxt } from 'node:dns/promises'
import { request as requestHttps } from 'node:https'
import { isIP } from 'node:net'
import {
  ENTERPRISE_PERMISSION_IDS,
  type EnterpriseBreakGlassAccount,
  type EnterpriseCustomRole,
  type EnterpriseIdentityProvider,
  type EnterpriseIdentitySnapshot,
  type EnterprisePermissionId,
  type EnterpriseProvisioningPreview,
  type EnterpriseProvisioningRun,
  type EnterpriseRoleId,
  type EnterpriseScimGroup,
  type EnterpriseScimGroupInput,
  type EnterpriseScimUser,
  type EnterpriseScimUserInput,
  type EnterpriseServiceAccount,
  type EnterpriseVerifiedDomain,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import {
  type EnterpriseIdentityProviderConnectionTester,
} from '../../app/composition/app-dependencies'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import {
  createAuditEvent,
  createMutationAuditContext,
  calculateAuditExpiresAt,
  getConfiguredAuditTableName,
  getConfiguredAuditRetentionDays,
  getConfiguredDynamoDbEndpoint,
  type MutationAuditContext,
} from '../../modules/audit/audit'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  ENTERPRISE_SCIM_DISPLAY_NAME_MAX_BYTES,
  ENTERPRISE_SCIM_EXTERNAL_ID_MAX_BYTES,
  ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT,
  ENTERPRISE_SCIM_GROUP_PAGE_LIMIT,
  ENTERPRISE_SCIM_IDEMPOTENCY_KEY_MAX_BYTES,
  ENTERPRISE_SCIM_MEMBER_ID_MAX_BYTES,
  ENTERPRISE_SCIM_RESOURCE_ID_MAX_BYTES,
  ENTERPRISE_SCIM_USER_EMAIL_LIMIT,
  ENTERPRISE_SCIM_USER_IDENTIFIER_MAX_BYTES,
  EnterpriseIdentityError,
  assertEnterpriseCognitoProviderBinding,
  assertEnterpriseIdentityProviderReady,
  canAssignEnterpriseRole,
  ipMatchesCidr,
  resolveEnterpriseRolePermissions,
} from '../../modules/enterprise-identity'
import {
  createDefaultEnterpriseSecurityPolicy,
  toEnterpriseSecuritySnapshotView,
} from '../../modules/enterprise-identity/enterprise-security-view'
import {
  EnterpriseSsoError,
  buildCognitoAuthorizeUrl,
  createEnterpriseSsoAuthenticationMethod,
  createEnterpriseSsoState,
  parseEnterpriseSsoTokenResponse,
  validateEnterpriseSsoState,
} from '../../modules/enterprise-identity/enterprise-sso'
import { PlanningError } from '../../modules/planning'
import {
  requirePrivateDocumentManagerContinuity,
} from '../../modules/workspace-access/document-manager-lifecycle'
import {
  authenticationDependencies,
  enforceActiveTenantForRequest,
  requireAppDependencies,
  workItemDependencies,
  workspaceDependencies,
} from '../shared/app-dependencies'
import { createAuthenticationResponse, toProjectPrincipal } from '../shared/authentication-session'
import {
  assertEnterpriseCognitoFederationProvider,
  assertEnterpriseCognitoSsoAppClient,
  type CognitoAccessTokenClaims,
  createEnterpriseAuthenticationSessionId,
  isEnterpriseSsoConfigured,
  normalizeEnterpriseEmailDomain,
  readCognitoAuthenticationMethods,
  requireEnterpriseCognitoProviderName,
  requireEnterpriseCognitoSsoAppClientConfiguration,
  requireEnterpriseExternalAccessAllowed,
  resolveEnterpriseClientIp,
  toEnterpriseIdentityErrorResponse,
  validateConfiguredCognitoAccessToken,
} from '../shared/enterprise-access'
import {
  createRequestMutationContext,
  readBearerAccessToken,
  readJson,
  toAuthErrorResponse,
} from '../shared/http'
import { requireWorkspaceMemberHasNoOwnedPlanningEntities } from '../shared/planning-access'
import {
  createWorkspaceMutationContext,
  requireWorkspaceMemberHasNoManagedProjects,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { getAwsRegion, getEnv } from '../shared/runtime-config'
import { decodeJwtPayload, readNumericClaim } from '../shared/token-claims'
import { isRecord } from '../shared/value-guards'
import {
  enforceActiveTenantForWorkspace,
  readWorkspaceEmail,
  toWorkspaceAccessErrorResponse,
} from '../shared/workspace-access'

/**
 * Enterprise security route の current permission set を検証済みの principal です。
 */
type EnterpriseSecurityPrincipal = WorkspacePrincipal & {
  /**
   * Current Enterprise security route で有効な permission です。
   */
  enterprisePermissions: EnterprisePermissionId[]
}

const enterpriseIdentityProviderConnectionTester: EnterpriseIdentityProviderConnectionTester = (
  provider,
) => requireAppDependencies().workspace.enterpriseIdentityProviderConnectionTester(provider)

/**
 * Records rejected Enterprise Security mutations after the downstream response completes.
 *
 * @param c - Hono request context containing the response to inspect.
 * @param next - Downstream middleware dispatcher.
 * @returns A promise that resolves after best-effort audit recording.
 */
export async function auditRejectedEnterpriseSecurityMutation(
  c: Context,
  next: () => Promise<void>,
) {
  await next()
  if (
    c.req.method === 'GET' ||
    c.req.method === 'HEAD' ||
    c.res.status < 400
  ) {
    return
  }
  try {
    const tableName = getConfiguredAuditTableName()
    if (!tableName) return
    const token = readBearerAccessToken(c) ?? ''
    const scimWorkspaceId = c.req.path.match(/^\/api\/scim\/v2\/([^/]+)/u)?.[1]
    let workspaceId: string | undefined
    let actorId: string | undefined
    let actorKind: 'service' | 'user' = 'user'
    if (scimWorkspaceId) {
      workspaceId = decodeURIComponent(scimWorkspaceId)
      const credential = token
        ? await workspaceDependencies.enterpriseIdentity.scimAuthentication.authenticateScimToken(workspaceId, token)
        : undefined
      if (!credential) return
      actorId = credential.credentialId
      actorKind = 'service'
    } else if (token.startsWith('msa_')) {
      workspaceId = getEnv('MUKUROJI_WORKSPACE_DIRECTORY_ID')
      const account = workspaceId
        ? await workspaceDependencies.enterpriseIdentity.serviceAccountAuthentication.authenticateServiceAccountToken(
            workspaceId,
            token,
          )
        : undefined
      if (!workspaceId || !account) return
      actorId = account.accountId
      actorKind = 'service'
    } else {
      if (!token) return
      const principal = toProjectPrincipal(await authenticationDependencies.cognito.getUser(token), token)
      workspaceId = principal.directoryId
      actorId = principal.actorId
    }
    const responseBody = await c.res.clone().json().catch(() => undefined)
    const errorCode = isRecord(responseBody) && typeof responseBody.code === 'string'
      ? responseBody.code
      : 'EnterpriseSecurityRequestRejected'
    const requestId = c.req.header('X-Request-Id')?.trim() || crypto.randomUUID()
    const auditContext = createMutationAuditContext({
      workspaceId,
      actor: {
        id: actorId,
        kind: actorKind,
      },
      idempotencyKey: `rejected:${requestId}`,
      request: {
        method: c.req.method,
        path: c.req.path,
        body: {
          errorCode,
          status: c.res.status,
        },
      },
      source: {
        kind: 'api',
        requestId,
        method: c.req.method,
        route: c.req.path,
        ipAddress: resolveEnterpriseClientIp(c),
        userAgent: c.req.header('User-Agent'),
      },
    })
    const event = createAuditEvent({
      context: auditContext,
      eventType: 'enterprise-security.request-rejected',
      entity: { type: 'enterprise-security', id: c.req.path },
      summary: 'Enterprise security mutation was rejected.',
      metadata: {
        errorCode,
        status: c.res.status,
      },
      expiresAt: calculateAuditExpiresAt(
        auditContext.occurredAt,
        getConfiguredAuditRetentionDays(),
      ),
    })
    await workspaceDependencies.auditEvents.putEvent?.(event)
  } catch (error) {
    console.error('Failed to record rejected enterprise security audit event:', error)
  }
}

function requireEnterpriseSsoFederationConfiguration() {
  const cognitoDomain = getEnv('COGNITO_HOSTED_UI_DOMAIN')?.trim()
  const userPoolId = getEnv('COGNITO_USER_POOL_ID')?.trim()
  const stateSecret = getEnv('ENTERPRISE_SSO_STATE_SECRET')?.trim()
  const ssoClient = requireEnterpriseCognitoSsoAppClientConfiguration()
  if (
    !cognitoDomain ||
    !userPoolId ||
    !stateSecret
  ) {
    throw new EnterpriseSsoError(
      503,
      'EnterpriseSsoFederationUnavailable',
      'Cognito enterprise federation is not configured.',
    )
  }
  return {
    cognitoDomain: normalizeEnterpriseCognitoDomain(cognitoDomain),
    clientId: ssoClient.clientId,
    userPoolId,
    redirectUri: ssoClient.redirectUri,
    identityProviderName: ssoClient.identityProviderName,
    issuer: `https://cognito-idp.${getAwsRegion()}.amazonaws.com/${userPoolId}`,
    stateSecret,
  }
}

function normalizeEnterpriseCognitoDomain(value: string) {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError('Invalid Cognito domain.')
    }
    return url.origin
  } catch (error) {
    throw new EnterpriseSsoError(
      503,
      'EnterpriseSsoFederationUnavailable',
      'Cognito enterprise federation domain is invalid.',
      { cause: error },
    )
  }
}

function toEnterpriseSsoErrorResponse(c: Context, error: unknown) {
  const status = error instanceof EnterpriseSsoError
    ? error.status
    : error instanceof EnterpriseIdentityError
      ? error.status
    : error instanceof CognitoServiceError
      ? error.status
    : error instanceof WorkspaceAccessError
      ? error.status
      : 500
  if (status >= 500) console.error(error)
  c.status(
    status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 409 ||
      status === 429 ||
      status === 502 ||
      status === 503
      ? status
      : 500,
  )
  return c.json({
    code: error instanceof EnterpriseSsoError ||
      error instanceof EnterpriseIdentityError ||
      error instanceof CognitoServiceError ||
      error instanceof WorkspaceAccessError
      ? error.code
      : 'EnterpriseSsoUnavailable',
    message: error instanceof Error
      ? error.message
      : 'Enterprise SSO is unavailable.',
  })
}

async function requireEnterpriseSecurityPrincipal(
  c: Context,
): Promise<EnterpriseSecurityPrincipal> {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    throw new EnterpriseIdentityError(
      401,
      'EnterpriseAuthenticationRequired',
      'Bearer token is required.',
    )
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
  if (principal.enterprisePermissions === undefined) {
    throw new WorkspaceAccessError(
      403,
      'WorkspacePermissionDenied',
      'Enterprise permission is required for this operation.',
    )
  }
  return {
    ...principal,
    enterprisePermissions: principal.enterprisePermissions,
  }
}

function toEnterpriseIdentityBoundaryErrorResponse(c: Context, error: unknown) {
  if (error instanceof EnterpriseIdentityError) {
    return toEnterpriseIdentityErrorResponse(c, error)
  }
  if (error instanceof WorkspaceAccessError) {
    return toWorkspaceAccessErrorResponse(c, error)
  }
  if (error instanceof CognitoServiceError) {
    return toAuthErrorResponse(c, error)
  }
  if (error instanceof ProjectDataError || error instanceof PlanningError) {
    return toProjectDataErrorResponse(c, error)
  }
  console.error(error)
  return c.json({
    code: 'EnterpriseIdentityUnavailable',
    message: 'Enterprise identity service is unavailable.',
  }, 503)
}

function readEnterpriseIdentityProviderInput(
  workspaceId: string,
  body: Record<string, unknown> | undefined,
  existing: EnterpriseIdentityProvider | undefined,
): EnterpriseIdentityProvider {
  const nowIso = new Date().toISOString()
  const providerId = existing?.providerId ?? crypto.randomUUID()
  const status = 'draft'
  const displayName = readEnterpriseText(body?.displayName, 'Identity provider name')
  const cognitoProviderName = requireEnterpriseCognitoProviderName()
  const issuer = readEnterpriseText(body?.issuer, 'Identity provider issuer')
  const ssoUrl = readEnterpriseText(body?.ssoUrl, 'Identity provider SSO URL')
  if (body?.protocol === 'oidc') {
    const issuerUrl = new URL(issuer)
    return {
      workspaceId,
      providerId,
      kind: 'oidc',
      displayName,
      cognitoProviderName,
      status,
      revision: (existing?.revision ?? 0) + 1,
      issuer: issuerUrl.toString(),
      clientId: readEnterpriseText(body?.clientId, 'OIDC client ID'),
      authorizationEndpoint: new URL(ssoUrl).toString(),
      tokenEndpoint: new URL('/token', issuerUrl).toString(),
      jwksUri: new URL('/.well-known/jwks.json', issuerUrl).toString(),
      scopes: ['openid', 'email', 'profile'],
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    } satisfies EnterpriseIdentityProvider
  }
  return {
    workspaceId,
    providerId,
    kind: 'saml',
    displayName,
    cognitoProviderName,
    status,
    revision: (existing?.revision ?? 0) + 1,
    entityId: issuer,
    singleSignOnUrl: new URL(ssoUrl).toString(),
    metadataUrl: new URL(readEnterpriseText(body?.metadataUrl, 'SAML metadata URL')).toString(),
    certificateFingerprints: [],
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  } satisfies EnterpriseIdentityProvider
}

function enterpriseIdentityProviderMatchesInput(
  provider: EnterpriseIdentityProvider,
  body: Record<string, unknown> | undefined,
) {
  if (!body) return false
  if (
    provider.cognitoProviderName !== getEnv('COGNITO_ENTERPRISE_IDP_NAME')?.trim() ||
    body.protocol !== provider.kind ||
    typeof body.displayName !== 'string' ||
    body.displayName.trim() !== provider.displayName ||
    typeof body.issuer !== 'string' ||
    typeof body.ssoUrl !== 'string' ||
    typeof body.clientId !== 'string'
  ) return false
  try {
    if (provider.kind === 'oidc') {
      return new URL(body.issuer).toString() === provider.issuer &&
        new URL(body.ssoUrl).toString() === provider.authorizationEndpoint &&
        body.clientId.trim() === provider.clientId
    }
    return body.issuer.trim() === provider.entityId &&
      new URL(body.ssoUrl).toString() === provider.singleSignOnUrl &&
      typeof body.metadataUrl === 'string' &&
      new URL(body.metadataUrl).toString() === provider.metadataUrl
  } catch {
    return false
  }
}

/**
 * Validates Enterprise Identity provider metadata against its remote endpoints.
 *
 * @param provider - Normalized provider configuration to validate.
 * @returns The validated provider configuration.
 */
export async function testEnterpriseIdentityProviderConnection(
  provider: EnterpriseIdentityProvider,
): Promise<EnterpriseIdentityProvider> {
  try {
    assertEnterpriseCognitoProviderBinding(
      provider,
      requireEnterpriseCognitoProviderName(),
    )
    await assertEnterpriseCognitoFederationProvider(provider)
    if (provider.kind === 'oidc') {
      const issuer = provider.issuer.replace(/\/$/u, '')
      const discoveryUrl = new URL(`${issuer}/.well-known/openid-configuration`)
      const discovery = await fetchEnterpriseIdentityJson(discoveryUrl)
      const discoveredIssuer = readEnterpriseMetadataUrl(discovery.issuer, 'OIDC issuer')
      const authorizationEndpoint = readEnterpriseMetadataUrl(
        discovery.authorization_endpoint,
        'OIDC authorization endpoint',
      )
      const tokenEndpoint = readEnterpriseMetadataUrl(
        discovery.token_endpoint,
        'OIDC token endpoint',
      )
      const jwksUri = readEnterpriseMetadataUrl(discovery.jwks_uri, 'OIDC JWKS endpoint')
      await Promise.all([
        assertEnterpriseIdentityPublicUrl(discoveredIssuer),
        assertEnterpriseIdentityPublicUrl(authorizationEndpoint),
        assertEnterpriseIdentityPublicUrl(tokenEndpoint),
        assertEnterpriseIdentityPublicUrl(jwksUri),
      ])
      if (
        discoveredIssuer.toString().replace(/\/$/u, '') !== issuer ||
        authorizationEndpoint.toString() !== provider.authorizationEndpoint
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseOidcMetadataMismatch',
          'OIDC discovery metadata does not match the configured issuer or authorization URL.',
        )
      }
      const jwks = await fetchEnterpriseIdentityJson(jwksUri)
      if (
        !Array.isArray(jwks.keys) ||
        !jwks.keys.some((key) =>
          isRecord(key) &&
          typeof key.kty === 'string' &&
          (key.use === undefined || key.use === 'sig')
        )
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseOidcSigningKeyMissing',
          'OIDC JWKS metadata does not contain a signing key.',
        )
      }
      return {
        ...provider,
        status: 'active',
        tokenEndpoint: tokenEndpoint.toString(),
        jwksUri: jwksUri.toString(),
        updatedAt: new Date().toISOString(),
        lastTestedAt: new Date().toISOString(),
      }
    }

    const metadataUrl = new URL(provider.metadataUrl)
    const metadata = await fetchEnterpriseIdentityText(metadataUrl, 'application/samlmetadata+xml')
    const entityDescriptor = metadata.match(
      /<(?:[A-Za-z0-9_-]+:)?EntityDescriptor\b[^>]*>/iu,
    )?.[0]
    const entityId = entityDescriptor
      ? readXmlAttribute(entityDescriptor, 'entityID')
      : undefined
    const ssoLocations = [...metadata.matchAll(
      /<(?:[A-Za-z0-9_-]+:)?SingleSignOnService\b[^>]*>/giu,
    )]
      .map((match) => readXmlAttribute(match[0], 'Location'))
      .filter((value): value is string => Boolean(value))
      .map((value) => new URL(decodeEnterpriseXml(value)).toString())
    await Promise.all(ssoLocations.map((location) =>
      assertEnterpriseIdentityPublicUrl(new URL(location))
    ))
    if (
      !entityId ||
      decodeEnterpriseXml(entityId) !== provider.entityId ||
      !ssoLocations.includes(provider.singleSignOnUrl)
    ) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseSamlMetadataMismatch',
        'SAML metadata does not match the configured entity ID or SSO URL.',
      )
    }
    const certificates = [...metadata.matchAll(
      /<(?:[A-Za-z0-9_-]+:)?X509Certificate\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?X509Certificate>/giu,
    )]
      .map((match) => match[1]?.replace(/\s+/gu, ''))
      .filter((value): value is string => Boolean(value))
      .map((value) => new X509Certificate(
        `-----BEGIN CERTIFICATE-----\n${value}\n-----END CERTIFICATE-----`,
      ))
    const now = Date.now()
    const validCertificates = certificates.filter((certificate) =>
      Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) > now
    )
    if (validCertificates.length === 0) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseSamlCertificateMissing',
        'SAML metadata does not contain a currently valid signing certificate.',
      )
    }
    return {
      ...provider,
      status: 'active',
      certificateFingerprints: [
        ...new Set(validCertificates.map((certificate) =>
          certificate.fingerprint256.replaceAll(':', '').toLowerCase()
        )),
      ],
      updatedAt: new Date().toISOString(),
      lastTestedAt: new Date().toISOString(),
    }
  } catch (error) {
    if (error instanceof EnterpriseIdentityError) throw error
    throw new EnterpriseIdentityError(
      502,
      'EnterpriseIdentityProviderTestFailed',
      'Identity provider metadata could not be verified.',
      true,
      { cause: error },
    )
  }
}

async function fetchEnterpriseIdentityJson(url: URL) {
  const text = await fetchEnterpriseIdentityText(url, 'application/json')
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseIdentityProviderMetadataInvalid',
      'Identity provider metadata must be a JSON object.',
    )
  }
  return parsed
}

async function fetchEnterpriseIdentityText(url: URL, accept: string) {
  const [address] = await assertEnterpriseIdentityPublicUrl(url)
  if (!address) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityProviderUrlPrivate',
      'Identity provider metadata URL did not resolve to a public address.',
    )
  }
  return new Promise<string>((resolve, reject) => {
    const request = requestHttps({
      hostname: address,
      port: url.port ? Number(url.port) : 443,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      headers: {
        Accept: accept,
        Host: url.host,
        'User-Agent': 'mukuroji-enterprise-identity-verifier/1',
      },
      rejectUnauthorized: true,
      timeout: 7_500,
    }, (response) => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        response.resume()
        reject(new EnterpriseIdentityError(
          502,
          'EnterpriseIdentityProviderMetadataUnavailable',
          'Identity provider metadata endpoint did not return a successful response.',
          true,
        ))
        return
      }
      const contentLength = Number(response.headers['content-length'] ?? 0)
      if (contentLength > 1_048_576) {
        response.resume()
        reject(new EnterpriseIdentityError(
          409,
          'EnterpriseIdentityProviderMetadataTooLarge',
          'Identity provider metadata exceeds the one megabyte limit.',
        ))
        return
      }
      const chunks: Buffer[] = []
      let totalLength = 0
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalLength += buffer.length
        if (totalLength > 1_048_576) {
          response.destroy(new EnterpriseIdentityError(
            409,
            'EnterpriseIdentityProviderMetadataTooLarge',
            'Identity provider metadata exceeds the one megabyte limit.',
          ))
          return
        }
        chunks.push(buffer)
      })
      response.on('error', reject)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text) {
          reject(new EnterpriseIdentityError(
            409,
            'EnterpriseIdentityProviderMetadataInvalid',
            'Identity provider metadata is empty.',
          ))
          return
        }
        resolve(text)
      })
    })
    request.on('timeout', () => request.destroy(new Error('Metadata request timed out.')))
    request.on('error', reject)
    request.end()
  })
}

async function assertEnterpriseIdentityPublicUrl(url: URL) {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !url.hostname ||
    url.hostname.toLowerCase() === 'localhost' ||
    url.hostname.toLowerCase().endsWith('.local')
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityProviderUrlInvalid',
      'Identity provider metadata must use a public HTTPS URL.',
    )
  }
  const literalAddressFamily = isIP(url.hostname)
  const addresses = literalAddressFamily
    ? [url.hostname]
    : (await Promise.allSettled([
        resolve4(url.hostname),
        resolve6(url.hostname),
      ])).flatMap((resolution) =>
        resolution.status === 'fulfilled' ? resolution.value : []
      )
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isEnterprisePublicIpAddress(address))
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityProviderUrlPrivate',
      'Identity provider metadata URL must resolve only to public addresses.',
    )
  }
  return addresses
}

function isEnterprisePublicIpAddress(address: string) {
  const deniedRanges = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '224.0.0.0/4',
    '240.0.0.0/4',
    '::/128',
    '::1/128',
    '::ffff:0:0/96',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',
  ] as const
  return !deniedRanges.some((cidr) => ipMatchesCidr(address, cidr))
}

function readEnterpriseMetadataUrl(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseIdentityProviderMetadataInvalid',
      `${label} is missing from identity provider metadata.`,
    )
  }
  const url = new URL(value)
  if (url.protocol !== 'https:') {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseIdentityProviderMetadataInvalid',
      `${label} must use HTTPS.`,
    )
  }
  return url
}

function readXmlAttribute(tag: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = tag.match(new RegExp(`${escapedName}\\s*=\\s*(["'])(.*?)\\1`, 'iu'))
  return match?.[2]
}

function decodeEnterpriseXml(value: string) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', '\'')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function readEnterpriseText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4096) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityInputInvalid',
      `${label} is required.`,
    )
  }
  return value.trim()
}

function readEnterpriseInteger(value: unknown, label: string, minimum: number) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityInputInvalid',
      `${label} must be an integer of at least ${minimum}.`,
    )
  }
  return value
}

function readEnterpriseStringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityInputInvalid',
      `${label} must be a string array.`,
    )
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))]
}

function readEnterpriseDomainArray(value: unknown, label: string) {
  const domains = readEnterpriseStringArray(value, label)
    .map((entry) => entry.toLowerCase().replace(/\.$/u, ''))
  if (domains.some((domain) =>
    domain.length > 253 ||
    !domain.includes('.') ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u.test(domain)
  )) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseGuestDomainInvalid',
      `${label} must contain valid DNS domain names.`,
    )
  }
  return [...new Set(domains)]
}

function validateEnterpriseIpAllowlist(ipAllowlist: string[]) {
  if (ipAllowlist.some((cidr) => {
    const address = cidr.split('/')[0]
    return !address || !ipMatchesCidr(address, cidr)
  })) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIpAllowlistInvalid',
      'IP allowlist must contain valid IPv4 or IPv6 CIDRs.',
    )
  }
}

function createEnterprisePolicyCallerImpact(
  c: Context,
  workspaceId: string,
  expectedVersion: number,
  ipAllowlist: string[],
) {
  const callerIp = resolveEnterpriseClientIp(c)
  const callerAllowed = ipAllowlist.length === 0 ||
    Boolean(callerIp && ipAllowlist.some((cidr) => ipMatchesCidr(callerIp, cidr)))
  const requiresConfirmation = !callerAllowed
  const confirmationToken = createHmac('sha256', getEnterpriseIdentityHashSecret())
    .update(JSON.stringify({
      workspaceId,
      expectedVersion,
      callerIp: callerIp ?? '',
      ipAllowlist: [...ipAllowlist].sort(),
    }))
    .digest('base64url')
  return {
    callerIp: callerIp ?? '',
    callerAllowed,
    requiresConfirmation,
    warnings: requiresConfirmation
      ? [
          callerIp
            ? `The current caller IP (${callerIp}) is not included in the new allowlist.`
            : 'The current caller IP could not be resolved from a trusted transport source.',
        ]
      : [],
    ...(requiresConfirmation ? { confirmationToken } : {}),
  }
}

function readEnterprisePermissions(value: unknown) {
  const values = readEnterpriseStringArray(value, 'Permissions')
  const permissions = values.filter((permission): permission is EnterprisePermissionId =>
    ENTERPRISE_PERMISSION_IDS.includes(permission as EnterprisePermissionId)
  )
  if (permissions.length !== values.length || permissions.length === 0) {
    throw new EnterpriseIdentityError(
      400,
      'EnterprisePermissionInvalid',
      'At least one recognized permission is required.',
    )
  }
  return permissions
}

function readEnterpriseRoleId(value: unknown) {
  const roleId = readEnterpriseText(value, 'Role ID')
  if (
    roleId !== 'workspace:owner' &&
    roleId !== 'workspace:admin' &&
    roleId !== 'workspace:member' &&
    roleId !== 'workspace:guest' &&
    roleId !== 'team:manager' &&
    roleId !== 'team:member' &&
    roleId !== 'project:manager' &&
    roleId !== 'project:member' &&
    roleId !== 'project:viewer' &&
    !roleId.startsWith('custom:')
  ) {
    throw new EnterpriseIdentityError(400, 'EnterpriseRoleInvalid', 'Role ID is invalid.')
  }
  return roleId as EnterpriseRoleId
}

function requireEnterpriseAssignableRole(
  snapshot: EnterpriseIdentitySnapshot,
  callerPermissions: readonly EnterprisePermissionId[],
  roleId: EnterpriseRoleId,
  scopeKind: 'workspace' | 'team' | 'project',
) {
  if (
    !canAssignEnterpriseRole(
      snapshot.customRoles,
      callerPermissions,
      roleId,
      scopeKind,
    )
  ) {
    throw new EnterpriseIdentityError(
      403,
      'EnterpriseRoleAssignmentDenied',
      'The selected role exceeds your effective permissions or is invalid for this scope.',
    )
  }
}

function requireEnterprisePermissionGrantCeiling(
  callerPermissions: readonly EnterprisePermissionId[],
  grantedPermissions: readonly EnterprisePermissionId[],
) {
  if (grantedPermissions.some((permission) => !callerPermissions.includes(permission))) {
    throw new EnterpriseIdentityError(
      403,
      'EnterprisePermissionGrantDenied',
      'A custom role cannot grant permissions that the current principal does not hold.',
    )
  }
}

async function requireEnterpriseMappingReferences(
  snapshot: EnterpriseIdentitySnapshot,
  workspaceId: string,
  identityProviderId: string,
  directoryGroupId: string,
  scopeKind: 'workspace' | 'team' | 'project',
  scopeTargetId: string | undefined,
) {
  const provider = snapshot.identityProviders.find((candidate) =>
    candidate.providerId === identityProviderId
  )
  assertEnterpriseIdentityProviderReady(provider)
  assertEnterpriseCognitoProviderBinding(
    provider,
    requireEnterpriseCognitoProviderName(),
  )
  await assertEnterpriseCognitoFederationProvider(provider)
  if (!snapshot.scimGroups.some((group) =>
    group.active &&
    group.identityProviderId === identityProviderId &&
    (group.groupId === directoryGroupId || group.externalId === directoryGroupId)
  )) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseDirectoryGroupNotFound',
      'An active provisioned directory group is required before creating a mapping.',
    )
  }
  if (scopeKind === 'workspace') return
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja')
  const exists = scopeKind === 'team'
    ? directory.teams.some((team) => team.id === scopeTargetId)
    : directory.teams.some((team) =>
        team.projects.some((project) => project.id === scopeTargetId)
      )
  if (!exists) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseMappingScopeNotFound',
      'The selected Team or Project does not belong to this Workspace.',
    )
  }
}

async function requireEnterpriseResourceScope(
  workspaceId: string,
  scopeKind: 'workspace' | 'team' | 'project',
  scopeTargetId: string | undefined,
) {
  if (scopeKind === 'workspace') return
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja')
  const exists = scopeKind === 'team'
    ? directory.teams.some((team) => team.id === scopeTargetId)
    : directory.teams.some((team) =>
        team.projects.some((project) => project.id === scopeTargetId)
      )
  if (!exists) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseResourceScopeNotFound',
      'The selected Team or Project does not belong to this Workspace.',
    )
  }
}

function createEnterpriseDomainVerificationValue(workspaceId: string, domain: string) {
  return `mukuroji-verification=${createHash('sha256')
    .update(`${getEnterpriseIdentityHashSecret()}\0${workspaceId}\0${domain}`)
    .digest('base64url')}`
}

function getEnterpriseIdentityHashSecret() {
  return getEnv('ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET') ??
    'local-enterprise-domain-verification-secret'
}

function createEnterpriseIdempotentResourceId(
  namespace: string,
  workspaceId: string,
  idempotencyKey: string,
) {
  return `${namespace}_${createHash('sha256')
    .update(`${workspaceId}\0${idempotencyKey}`)
    .digest('base64url')
    .slice(0, 22)}`
}

function isLocalEnterpriseDomainVerification() {
  return Boolean(getConfiguredDynamoDbEndpoint()) ||
    !getEnv('ENTERPRISE_IDENTITY_TABLE_NAME') ||
    getEnv('MUKUROJI_ENTERPRISE_SKIP_DOMAIN_DNS_VERIFICATION') === 'true'
}

function toEnterpriseDomainView(domain: EnterpriseVerifiedDomain) {
  return {
    id: domain.domainId,
    domain: domain.domain,
    status: domain.status === 'failed' ? 'conflict' : domain.status,
    verificationRecordName: domain.verificationRecordName,
    verifiedAt: domain.verifiedAt,
    version: domain.revision,
  }
}

function toEnterpriseRoleView(role: EnterpriseCustomRole, assignmentCount: number) {
  return {
    id: role.roleId,
    name: role.name,
    description: role.description ?? '',
    kind: 'custom' as const,
    permissionIds: role.permissions,
    guestAssignable: role.guestAssignable,
    assignmentCount,
    version: role.revision,
  }
}

function createEnterpriseRoleImpact(
  snapshot: EnterpriseIdentitySnapshot,
  role: EnterpriseCustomRole,
  permissionIds: EnterprisePermissionId[],
  guestAssignable: boolean,
  deleteRequested: boolean,
) {
  const assignments = snapshot.roleAssignments.filter((assignment) =>
    assignment.roleId === role.roleId
  )
  const mappings = snapshot.groupMappings.filter((mapping) =>
    mapping.roleId === role.roleId
  )
  const serviceAccounts = snapshot.serviceAccounts.filter((account) =>
    account.roleId === role.roleId && account.status === 'active'
  )
  const removedPermissionIds = deleteRequested
    ? [...role.permissions]
    : role.permissions.filter((permission) => !permissionIds.includes(permission))
  const blocking = deleteRequested &&
    assignments.length + mappings.length + serviceAccounts.length > 0
  const referenceFingerprint = createHash('sha256')
    .update(JSON.stringify({
      assignments: assignments.map((assignment) => assignment.assignmentId).sort(),
      mappings: mappings.map((mapping) => mapping.mappingId).sort(),
      serviceAccounts: serviceAccounts.map((account) => account.accountId).sort(),
    }))
    .digest('base64url')
  const confirmationToken = createHmac('sha256', getEnterpriseIdentityHashSecret())
    .update(JSON.stringify({
      workspaceId: snapshot.workspaceId,
      roleId: role.roleId,
      roleRevision: role.revision,
      deleteRequested,
      permissionIds: [...permissionIds].sort(),
      guestAssignable,
      referenceFingerprint,
    }))
    .digest('base64url')
  const warnings = [
    ...(removedPermissionIds.length > 0
      ? [`${removedPermissionIds.length} permission(s) will be removed immediately.`]
      : []),
    ...(assignments.length > 0
      ? [`${assignments.length} direct role assignment(s) are affected.`]
      : []),
    ...(mappings.length > 0
      ? [`${mappings.length} directory group mapping(s) are affected.`]
      : []),
    ...(serviceAccounts.length > 0
      ? [`${serviceAccounts.length} active service account(s) are affected.`]
      : []),
    ...(role.guestAssignable && !guestAssignable
      ? ['Guest assignments using this role will stop granting permissions.']
      : []),
  ]
  return {
    assignmentCount: assignments.length,
    mappingCount: mappings.length,
    serviceAccountCount: serviceAccounts.length,
    removedPermissionIds,
    blocking,
    warnings,
    ...(blocking ? {} : { confirmationToken }),
  }
}

function toEnterpriseProvisioningImpact(preview: EnterpriseProvisioningPreview) {
  const count = (entityType: 'user' | 'group', action: string) =>
    preview.changes.filter((change) =>
      change.entityType === entityType && change.action === action
    ).length
  return {
    previewId: preview.previewId,
    expiresAt: preview.expiresAt,
    counts: {
      usersCreated: count('user', 'create'),
      usersUpdated: count('user', 'update'),
      usersDeactivated: count('user', 'deactivate'),
      groupsCreated: count('group', 'create'),
      groupsUpdated: count('group', 'update'),
      sessionsRevoked: preview.changes.filter((change) =>
        change.entityType === 'session' && change.action === 'revoke'
      ).length,
    },
    warnings: preview.changes
      .filter((change) => change.blocking || change.action === 'deactivate')
      .map((change) => change.summary),
    blocking: preview.changes.some((change) => change.blocking),
    hasChanges: preview.changes.some((change) => change.action !== 'noop'),
  }
}

function resolveEnterpriseProvisioningFailureCode(error: unknown) {
  if (error instanceof WorkspaceAccessError || error instanceof EnterpriseIdentityError) {
    return error.code
  }
  if (error instanceof ProjectDataError) return error.code
  return 'ProvisioningApplyFailed'
}

async function resolveEnterpriseProtectedProvisioningMemberKeys(
  workspaceId: string,
  snapshot: EnterpriseIdentitySnapshot,
) {
  const members = await workspaceDependencies.workspaceAccess.listActiveMembers(workspaceId)
  const owners = members.filter((member) => member.role === 'owner')
  const protectedMemberKeys = new Set([
    ...owners.map((owner) => owner.memberKey),
    ...snapshot.breakGlassAccounts
      .filter((account) => account.status === 'active')
      .map((account) => account.linkedMemberKey),
  ])
  for (const user of snapshot.scimUsers) {
    if (user.active || !user.linkedMemberKey) continue
    try {
      await requireWorkspaceMemberHasNoManagedProjects(workspaceId, user.linkedMemberKey)
      await requireWorkspaceMemberHasNoOwnedPlanningEntities(workspaceId, user.linkedMemberKey)
    } catch (error) {
      if (
        error instanceof WorkspaceAccessError &&
        (
          error.code === 'WorkspaceMemberManagesProjects' ||
          error.code === 'WorkspaceMemberOwnsPlanningEntities'
        )
      ) {
        protectedMemberKeys.add(user.linkedMemberKey)
        continue
      }
      throw error
    }
  }
  return [...protectedMemberKeys]
}

function toEnterpriseServiceAccountView(
  account: EnterpriseServiceAccount,
  credentialExpiresAt?: string,
) {
  return {
    id: account.accountId,
    name: account.displayName,
    status: account.status === 'active' ? 'active' : 'revoked',
    roleId: account.roleId,
    scopeType: account.scope.kind,
    scopeId: account.scope.targetId,
    credentialLifetimeDays: account.credentialLifetimeDays,
    credentialExpiresAt: credentialExpiresAt ?? account.credentialExpiresAt,
    allowedSourceCidrs: account.allowedSourceCidrs,
    credentialGeneration: account.credentialGeneration,
    createdAt: account.createdAt,
    lastUsedAt: account.lastUsedAt,
    version: account.revision,
  }
}

function toEnterpriseBreakGlassView(account: EnterpriseBreakGlassAccount) {
  return {
    id: account.accountId,
    email: account.email,
    status: account.status,
    mfaConfigured: true,
    lastTestedAt: account.lastTestedAt,
    version: account.revision,
  }
}

function isEnterpriseSsoRecoveryAccountReady(
  snapshot: EnterpriseIdentitySnapshot,
  account: EnterpriseBreakGlassAccount,
) {
  const testedAt = Date.parse(account.lastTestedAt ?? '')
  const now = Date.now()
  return account.status === 'active' &&
    account.requireMfa &&
    Number.isFinite(Date.parse(account.mfaVerifiedAt)) &&
    Number.isFinite(testedAt) &&
    testedAt <= now &&
    now - testedAt <= 30 * 24 * 60 * 60_000 &&
    !snapshot.domains.some((domain) =>
      domain.status === 'verified' &&
      domain.domain === normalizeEnterpriseEmailDomain(account.email)
    )
}

function requireEnterpriseBreakGlassRecoveryDomainUnmanaged(
  snapshot: EnterpriseIdentitySnapshot,
  email: string,
) {
  if (snapshot.domains.some((domain) =>
    domain.status === 'verified' &&
    domain.domain === normalizeEnterpriseEmailDomain(email)
  )) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseBreakGlassRecoveryDomainManaged',
      'Break-glass recovery must use an account outside every managed domain.',
    )
  }
}

async function requireEnterpriseMfa(workspaceId: string, accessToken: string) {
  const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  const sessionId = createHash('sha256').update(accessToken).digest('base64url')
  const verifiedMethods = await workspaceDependencies.enterpriseSessionActivity.getAuthenticationMethods(
    workspaceId,
    sessionId,
  )
  if (![...new Set([
    ...readCognitoAuthenticationMethods(claims),
    ...verifiedMethods,
  ])].some((method) => {
    const normalized = method.toLowerCase()
    return normalized.includes('mfa') ||
      normalized.includes('otp') ||
      normalized.includes('webauthn')
  })) {
    throw new EnterpriseIdentityError(
      403,
      'EnterpriseBreakGlassMfaRequired',
      'Break-glass activation requires a current MFA-authenticated session.',
    )
  }
}

function requireEnterpriseRecentAuthentication(accessToken: string, maximumAgeMinutes: number) {
  const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  const authenticatedAt = readNumericClaim(claims?.auth_time) ??
    readNumericClaim(claims?.iat)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (
    authenticatedAt === undefined ||
    authenticatedAt > nowSeconds ||
    nowSeconds - authenticatedAt > maximumAgeMinutes * 60
  ) {
    throw new EnterpriseIdentityError(
      403,
      'EnterpriseBreakGlassReauthenticationRequired',
      'Break-glass activation requires recent authentication.',
    )
  }
}

async function applyEnterpriseProvisioningPlan(
  c: Context,
  run: EnterpriseProvisioningRun,
) {
  const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(run.workspaceId)
  const desiredGroupOverlays = run.changes
    .filter((change) => change.action !== 'noop' && change.entityType === 'group')
    .map((change) => {
      const group = snapshot.scimGroups.find((candidate) =>
        candidate.groupId === change.entityId &&
        candidate.version === change.desiredVersion
      )
      if (!group) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningPlanStale',
          'A SCIM group changed after this provisioning run was reviewed.',
        )
      }
      return group
    })
  for (const change of run.changes) {
    if (change.action === 'noop' || change.entityType !== 'user') continue
    const user = snapshot.scimUsers.find((candidate) =>
      candidate.userId === change.entityId &&
      candidate.version === change.desiredVersion
    )
    if (!user) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseProvisioningPlanStale',
        'A SCIM user changed after this provisioning run was reviewed.',
      )
    }
    await applyEnterpriseScimUser(c, user, desiredGroupOverlays)
  }
  for (const group of desiredGroupOverlays) {
    await workspaceDependencies.enterpriseIdentity.scimDirectory.markScimGroupApplied(
      run.workspaceId,
      group.groupId,
      group.version,
      createEnterpriseScimMutationContext(
        c,
        run.workspaceId,
        group.identityProviderId,
        {
        runId: run.runId,
        groupId: group.groupId,
        desiredVersion: group.version,
        },
      ),
    )
  }
}

async function applyEnterpriseScimUser(
  c: Context,
  user: EnterpriseScimUser,
  desiredGroupOverlays: readonly EnterpriseScimGroup[] = [],
) {
  return await applyEnterpriseScimUserState(
    user,
    createEnterpriseScimMutationContext(
      c,
      user.workspaceId,
      user.identityProviderId,
      {
        externalId: user.externalId,
        userId: user.userId,
        active: user.active,
      },
    ),
    desiredGroupOverlays,
  )
}

async function applyEnterpriseScimUserState(
  user: EnterpriseScimUser,
  auditContext: MutationAuditContext,
  desiredGroupOverlays: readonly EnterpriseScimGroup[] = [],
) {
  const memberKey = user.linkedMemberKey ??
    user.emails[0]?.trim().toLowerCase() ??
    user.userName.trim().toLowerCase()
  const existing = await workspaceDependencies.workspaceAccess.getMember(user.workspaceId, memberKey)
  if (user.active) {
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(user.workspaceId)
    const workspaceRole = resolveEnterpriseScimWorkspaceRole(
      snapshot,
      user,
      desiredGroupOverlays,
    )
    requireEnterpriseExternalAccessAllowed(
      snapshot,
      user.emails[0] ?? user.userName,
      workspaceRole,
    )
    const expectedPlanningRevision =
      (await workItemDependencies.planning.getAuthorizationState(user.workspaceId)).revision
    const expectedDocumentAuthorizationRevision =
      existing?.status === 'active' &&
        existing.role !== 'guest' &&
        workspaceRole === 'guest'
        ? await requirePrivateDocumentManagerContinuity(
            {
              documents: workItemDependencies.documents,
              workspaceAccess: workspaceDependencies.workspaceAccess,
            },
            user.workspaceId,
            memberKey,
          )
        : undefined
    await workspaceDependencies.workspaceAccess.reconcileDirectoryMember?.(user.workspaceId, {
      memberKey,
      email: user.emails[0] ?? user.userName,
      name: user.displayName,
      role: workspaceRole,
      externalIdentityId: user.userId,
      expectedVersion: existing?.version,
      expectedPlanningRevision,
      ...(expectedDocumentAuthorizationRevision === undefined
        ? {}
        : { expectedDocumentAuthorizationRevision }),
    }, auditContext)
    await authenticationDependencies.cognito.enableWorkspaceUser?.(memberKey)
  } else if (existing) {
    await requireWorkspaceMemberHasNoManagedProjects(user.workspaceId, memberKey)
    const expectedPlanningRevision = await requireWorkspaceMemberHasNoOwnedPlanningEntities(
      user.workspaceId,
      memberKey,
    )
    const expectedDocumentAuthorizationRevision =
      await requirePrivateDocumentManagerContinuity(
        {
          documents: workItemDependencies.documents,
          workspaceAccess: workspaceDependencies.workspaceAccess,
        },
        user.workspaceId,
        memberKey,
      )
    await workspaceDependencies.workspaceAccess.deprovisionDirectoryMember?.(
      user.workspaceId,
      memberKey,
      {
        externalIdentityId: user.userId,
        expectedVersion: existing.version,
        expectedPlanningRevision,
        expectedDocumentAuthorizationRevision,
      },
      auditContext,
    )
    await authenticationDependencies.cognito.disableWorkspaceUser?.(memberKey)
    await authenticationDependencies.cognito.globallySignOutWorkspaceUser?.(memberKey)
  }
  await workspaceDependencies.enterpriseIdentity.scimDirectory.markScimUserApplied(
    user.workspaceId,
    user.userId,
    user.version,
    auditContext,
  )
}

async function requireEnterpriseScimDeprovisionAllowed(
  workspaceId: string,
  memberKey: string,
  snapshot: EnterpriseIdentitySnapshot,
) {
  const members = await workspaceDependencies.workspaceAccess.listActiveMembers(workspaceId)
  const member = members.find((candidate) => candidate.memberKey === memberKey)
  if (!member) return
  if (member.role === 'owner') {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseProvisioningProtectedOwner',
      'Downgrade or transfer this Workspace owner before directory deprovisioning.',
    )
  }
  if (snapshot.breakGlassAccounts.some((account) =>
    account.status === 'active' && account.linkedMemberKey === memberKey
  )) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseProvisioningProtectedRecoveryAccount',
      'Replace the active break-glass recovery account before deprovisioning this member.',
    )
  }
  await requireWorkspaceMemberHasNoManagedProjects(workspaceId, memberKey)
  await requireWorkspaceMemberHasNoOwnedPlanningEntities(workspaceId, memberKey)
}

function resolveEnterpriseScimWorkspaceRole(
  snapshot: EnterpriseIdentitySnapshot,
  user: EnterpriseScimUser,
  desiredGroupOverlays: readonly EnterpriseScimGroup[] = [],
) {
  const desiredGroupsById = new Map(
    desiredGroupOverlays.map((group) => [group.groupId, group]),
  )
  const externalGroupIds = snapshot.scimGroups
    .map((group) => desiredGroupsById.get(group.groupId) ?? group)
    .filter((group) =>
      group.active &&
      (
        desiredGroupsById.has(group.groupId) ||
        group.appliedVersion >= group.version
      ) &&
      group.identityProviderId === user.identityProviderId &&
      group.memberUserIds.includes(user.userId)
    )
    .flatMap((group) => [group.groupId, group.externalId])
  const roles = snapshot.groupMappings
    .filter((mapping) =>
      mapping.enabled &&
      mapping.identityProviderId === user.identityProviderId &&
      mapping.scope.kind === 'workspace' &&
      externalGroupIds.includes(mapping.directoryGroupId)
    )
    .map((mapping) => mapping.roleId)
  if (roles.includes('workspace:guest')) return 'guest' as const
  return 'member' as const
}

async function requireEnterpriseScimWorkspace(c: Context) {
  const workspaceId = readEnterpriseText(c.req.param('workspaceId'), 'Workspace ID')
  const token = readBearerAccessToken(c)
  const authentication = token
    ? await workspaceDependencies.enterpriseIdentity.scimAuthentication.authenticateScimWorkspace(
        workspaceId,
        token,
      )
    : undefined
  if (!authentication) {
    throw new EnterpriseIdentityError(
      401,
      'EnterpriseScimAuthenticationFailed',
      'SCIM bearer credential is invalid or revoked.',
    )
  }
  const { credential, provider } = authentication
  assertEnterpriseIdentityProviderReady(provider)
  assertEnterpriseCognitoProviderBinding(
    provider,
    requireEnterpriseCognitoProviderName(),
  )
  await assertEnterpriseCognitoFederationProvider(provider, 'cached')
  await enforceActiveTenantForRequest(workspaceId, c)
  return { workspaceId, credential }
}

/** 一つの SCIM mutation request に許可する decoded JSON byte 数です。 */
const SCIM_REQUEST_BODY_MAX_BYTES = 512 * 1024

/** 一つの SCIM PATCH request に許可する operation 数です。 */
const SCIM_PATCH_OPERATION_LIMIT = 100

/** SCIM equality filter に許可する UTF-8 byte 数です。 */
const SCIM_FILTER_MAX_BYTES = 512

async function readScimJson(c: Context) {
  const contentLength = c.req.header('Content-Length')
  if (contentLength !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPayloadInvalid',
        'SCIM Content-Length must be a non-negative integer.',
      )
    }
    const parsedContentLength = Number(contentLength)
    if (!Number.isSafeInteger(parsedContentLength)) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPayloadInvalid',
        'SCIM Content-Length is invalid.',
      )
    }
    if (parsedContentLength > SCIM_REQUEST_BODY_MAX_BYTES) {
      throwScimPayloadTooLarge()
    }
  }
  let bytes: ArrayBuffer
  try {
    bytes = await c.req.arrayBuffer()
  } catch {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimPayloadInvalid',
      'A valid SCIM JSON object request body is required.',
    )
  }
  if (bytes.byteLength > SCIM_REQUEST_BODY_MAX_BYTES) {
    throwScimPayloadTooLarge()
  }
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown
    if (!isRecord(value)) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPayloadInvalid',
        'A SCIM JSON object request body is required.',
      )
    }
    return value
  } catch (error) {
    if (error instanceof EnterpriseIdentityError) throw error
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimPayloadInvalid',
      'A valid SCIM JSON object request body is required.',
    )
  }
}

function throwScimPayloadTooLarge(): never {
  throw new EnterpriseIdentityError(
    413,
    'EnterpriseScimPayloadTooLarge',
    `SCIM request bodies cannot exceed ${
      SCIM_REQUEST_BODY_MAX_BYTES
    } bytes.`,
  )
}

function readEnterpriseScimUserInput(
  c: Context,
  workspaceId: string,
  identityProviderId: string,
  body: Record<string, unknown>,
  existing?: EnterpriseScimUser,
): EnterpriseScimUserInput {
  if (existing && existing.identityProviderId !== identityProviderId) {
    throw new EnterpriseIdentityError(
      404,
      'EnterpriseScimUserNotFound',
      'SCIM user was not found.',
    )
  }
  if (
    Array.isArray(body.emails) &&
    body.emails.length > ENTERPRISE_SCIM_USER_EMAIL_LIMIT
  ) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimUserEmailLimitExceeded',
      `A SCIM user can contain at most ${
        ENTERPRISE_SCIM_USER_EMAIL_LIMIT
      } email addresses.`,
    )
  }
  const hasEmails = Object.hasOwn(body, 'emails')
  if (hasEmails && !Array.isArray(body.emails)) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimEmailInvalid',
      'SCIM emails must be an array with at least one valid email.',
    )
  }
  const emails = hasEmails
    ? (body.emails as unknown[])
        .map((entry) => isRecord(entry) && typeof entry.value === 'string'
          ? readScimBoundedText(
            entry.value,
            'SCIM email',
            ENTERPRISE_SCIM_USER_IDENTIFIER_MAX_BYTES,
            false,
          )?.toLowerCase()
          : undefined)
        .filter((value): value is string => Boolean(value))
    : existing?.emails ?? []
  if (hasEmails && emails.length === 0) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimEmailInvalid',
      'SCIM user requires at least one valid email.',
    )
  }
  const userName = Object.hasOwn(body, 'userName')
    ? typeof body.userName === 'string' ? body.userName : undefined
    : existing?.userName
  if (!userName) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimUserInvalid',
      'SCIM userName is required.',
    )
  }
  const boundedUserName = readScimBoundedText(
    userName,
    'SCIM userName',
    ENTERPRISE_SCIM_USER_IDENTIFIER_MAX_BYTES,
  )
  const externalId = Object.hasOwn(body, 'externalId')
    ? typeof body.externalId === 'string' ? body.externalId : boundedUserName
    : existing?.externalId ?? boundedUserName
  const boundedExternalId = readScimBoundedText(
    externalId,
    'SCIM user externalId',
    ENTERPRISE_SCIM_EXTERNAL_ID_MAX_BYTES,
  )
  const displayName = Object.hasOwn(body, 'displayName')
    ? typeof body.displayName === 'string' ? body.displayName : undefined
    : Object.hasOwn(body, 'name')
      ? isRecord(body.name) && typeof body.name.formatted === 'string'
        ? body.name.formatted
        : undefined
      : existing?.displayName
  const boundedDisplayName = displayName === undefined
    ? undefined
    : readScimBoundedText(
      displayName,
      'SCIM user displayName',
      ENTERPRISE_SCIM_DISPLAY_NAME_MAX_BYTES,
      false,
    )
  return {
    workspaceId,
    userId: existing?.userId,
    externalId: boundedExternalId,
    identityProviderId,
    userName: boundedUserName,
    displayName: boundedDisplayName,
    emails: emails.length > 0 ? emails : [boundedUserName],
    active: body.active === undefined ? existing?.active ?? true : body.active === true,
    linkedMemberKey: existing?.linkedMemberKey ??
      (emails[0] ?? boundedUserName).trim().toLowerCase(),
    groupIds: existing?.groupIds ?? [],
    idempotencyKey: readScimIdempotencyKey(
      c,
      `user:${boundedExternalId}:${JSON.stringify(body)}`,
    ),
  }
}

function readEnterpriseScimGroupInput(
  c: Context,
  workspaceId: string,
  identityProviderId: string,
  body: Record<string, unknown>,
  existing?: EnterpriseScimGroup,
): EnterpriseScimGroupInput {
  if (existing && existing.identityProviderId !== identityProviderId) {
    throw new EnterpriseIdentityError(
      404,
      'EnterpriseScimGroupNotFound',
      'SCIM group was not found.',
    )
  }
  const displayName = Object.hasOwn(body, 'displayName')
    ? typeof body.displayName === 'string' ? body.displayName : undefined
    : existing?.displayName
  if (!displayName) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimGroupInvalid',
      'SCIM group displayName is required.',
    )
  }
  const boundedDisplayName = readScimBoundedText(
    displayName,
    'SCIM group displayName',
    ENTERPRISE_SCIM_DISPLAY_NAME_MAX_BYTES,
  )
  const externalId = Object.hasOwn(body, 'externalId')
    ? typeof body.externalId === 'string' ? body.externalId : boundedDisplayName
    : existing?.externalId ?? boundedDisplayName
  const boundedExternalId = readScimBoundedText(
    externalId,
    'SCIM group externalId',
    ENTERPRISE_SCIM_EXTERNAL_ID_MAX_BYTES,
  )
  if (
    Array.isArray(body.members) &&
    body.members.length > ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT
  ) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimGroupMemberLimitExceeded',
      `A SCIM group can contain at most ${
        ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT
      } members.`,
    )
  }
  const hasMembers = Object.hasOwn(body, 'members')
  if (hasMembers && !Array.isArray(body.members)) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimGroupMemberInvalid',
      'SCIM group members must be an array.',
    )
  }
  const memberUserIds = hasMembers
    ? (body.members as unknown[]).map(readScimGroupMemberId)
    : existing?.memberUserIds
  return {
    workspaceId,
    groupId: existing?.groupId,
    externalId: boundedExternalId,
    identityProviderId,
    displayName: boundedDisplayName,
    active: body.active === undefined ? existing?.active ?? true : body.active === true,
    memberUserIds,
    idempotencyKey: readScimIdempotencyKey(
      c,
      `group:${boundedExternalId}:${JSON.stringify(body)}`,
    ),
  }
}

function readScimBoundedText(
  value: string,
  label: string,
  maximumBytes: number,
  required = true,
) {
  const normalized = value.trim()
  if (
    (required && normalized.length === 0) ||
    Buffer.byteLength(normalized, 'utf8') > maximumBytes
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimTextLimitExceeded',
      `${label} must contain ${
        required ? 'between 1 and ' : 'at most '
      }${maximumBytes} UTF-8 bytes.`,
    )
  }
  return normalized
}

function readScimGroupMemberId(entry: unknown) {
  if (!isRecord(entry) || typeof entry.value !== 'string') {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimGroupMemberInvalid',
      'Every SCIM group member requires a string value.',
    )
  }
  const value = entry.value.trim()
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > ENTERPRISE_SCIM_MEMBER_ID_MAX_BYTES
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimGroupMemberInvalid',
      `SCIM member IDs must contain at most ${
        ENTERPRISE_SCIM_MEMBER_ID_MAX_BYTES
      } UTF-8 bytes.`,
    )
  }
  return value
}

function readScimResourceId(value: string, resourceType: 'user' | 'group') {
  return readScimBoundedText(
    value,
    `SCIM ${resourceType} ID`,
    ENTERPRISE_SCIM_RESOURCE_ID_MAX_BYTES,
  )
}

function readScimIdempotencyKey(c: Context, fallbackSeed: string) {
  const provided = c.req.header('Idempotency-Key')
  if (provided !== undefined && provided.trim().length > 0) {
    return readScimBoundedText(
      provided,
      'SCIM Idempotency-Key',
      ENTERPRISE_SCIM_IDEMPOTENCY_KEY_MAX_BYTES,
    )
  }
  return createHash('sha256').update(fallbackSeed).digest('hex')
}

function createEnterpriseScimMutationContext(
  c: Context,
  workspaceId: string,
  identityProviderId: string,
  body: unknown,
) {
  const bodyFingerprint = createHash('sha256')
    .update(JSON.stringify(body))
    .digest('hex')
  const requestIdempotencyKey =
    c.req.header('Idempotency-Key')?.trim() || bodyFingerprint
  return createRequestMutationContext(
    c,
    workspaceId,
    `scim-directory:${identityProviderId}`,
    `SCIM directory (${identityProviderId})`,
    body,
    `${requestIdempotencyKey}:${bodyFingerprint}`,
    'service',
  )
}

function toScimUserResource(user: EnterpriseScimUser) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: user.userId,
    externalId: user.externalId,
    userName: user.userName,
    displayName: user.displayName,
    active: user.active,
    emails: user.emails.map((value, index) => ({
      value,
      primary: index === 0,
      type: 'work',
    })),
    meta: {
      resourceType: 'User',
      created: user.createdAt,
      lastModified: user.updatedAt,
      version: `W/"${user.version}"`,
    },
  }
}

function toScimGroupResource(group: EnterpriseScimGroup) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: group.groupId,
    externalId: group.externalId,
    displayName: group.displayName,
    active: group.active,
    members: group.memberUserIds.map((value) => ({ value })),
    meta: {
      resourceType: 'Group',
      created: group.createdAt,
      lastModified: group.updatedAt,
      version: `W/"${group.version}"`,
    },
  }
}

function readScimEqualityFilter<
  Field extends 'externalId' | 'userName' | 'displayName',
>(
  filter: string | undefined,
  allowedFields: readonly Field[],
) {
  if (!filter) return {}
  if (Buffer.byteLength(filter, 'utf8') > SCIM_FILTER_MAX_BYTES) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimFilterInvalid',
      `SCIM filters cannot exceed ${SCIM_FILTER_MAX_BYTES} UTF-8 bytes.`,
    )
  }
  const match = filter.match(
    /^\s*(externalId|userName|displayName)\s+eq\s+"([^"]+)"\s*$/iu,
  )
  const canonicalField = match
    ? allowedFields.find((field) =>
      field.toLowerCase() === match[1]!.toLowerCase()
    )
    : undefined
  if (!match || !canonicalField) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimFilterInvalid',
      `Only ${allowedFields.join(', ')} equality filters are supported.`,
    )
  }
  return {
    filter: {
      field: canonicalField,
      value: match[2]!,
    },
  }
}

function readScimPagination(c: Context, maximumCount = 200) {
  const startIndex = readScimPaginationInteger(c.req.query('startIndex'), 1, 'startIndex')
  const requestedCount = readScimPaginationInteger(
    c.req.query('count'),
    Math.min(100, maximumCount),
    'count',
    true,
  )
  return {
    startIndex,
    count: Math.min(requestedCount, maximumCount),
  }
}

function readScimPaginationInteger(
  value: string | undefined,
  fallback: number,
  field: 'startIndex' | 'count',
  allowZero = false,
) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (allowZero ? 0 : 1)
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimPaginationInvalid',
      `SCIM ${field} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`,
    )
  }
  return parsed
}

function applyScimPatch(
  body: Record<string, unknown>,
  current: Record<string, unknown>,
) {
  if (!Array.isArray(body.Operations)) return { ...current, ...body }
  if (body.Operations.length > SCIM_PATCH_OPERATION_LIMIT) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimPatchOperationLimitExceeded',
      `A SCIM PATCH request can contain at most ${
        SCIM_PATCH_OPERATION_LIMIT
      } operations.`,
    )
  }
  const next = structuredClone(current)
  for (const operation of body.Operations) {
    if (!isRecord(operation) || typeof operation.op !== 'string') {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPatchInvalid',
        'Every SCIM PATCH operation requires an op value.',
      )
    }
    const op = operation.op.toLowerCase()
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPatchInvalid',
        'Only add, replace, and remove SCIM PATCH operations are supported.',
      )
    }
    if (!operation.path && isRecord(operation.value) && op !== 'remove') {
      Object.assign(next, operation.value)
      assertScimPatchArrayLimits(next)
      continue
    }
    if (typeof operation.path !== 'string') {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPatchInvalid',
        'SCIM PATCH operation path is required.',
      )
    }
    const filteredMembers = operation.path.match(
      /^members\[value\s+eq\s+"([^"]+)"\]$/iu,
    )
    if (filteredMembers) {
      if (op !== 'remove') {
        throw new EnterpriseIdentityError(
          400,
          'EnterpriseScimPatchInvalid',
          'Filtered member paths only support remove operations.',
        )
      }
      const filteredMemberId = readScimGroupMemberId({
        value: filteredMembers[1],
      })
      const members = Array.isArray(next.members) ? next.members : []
      next.members = members.filter((member) =>
        !isRecord(member) || member.value !== filteredMemberId
      )
      assertScimPatchArrayLimits(next)
      continue
    }
    if (operation.path.includes('[')) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPatchInvalid',
        'Only members[value eq "..."] filtered paths are supported.',
      )
    }
    const path = operation.path
    const canonicalPath = Object.keys(next).find((candidate) =>
      candidate.toLowerCase() === path.toLowerCase()
    )
    if (!canonicalPath) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPatchInvalid',
        `Unsupported SCIM PATCH path: ${path}.`,
      )
    }
    const currentValue = next[canonicalPath]
    if (op === 'remove') {
      next[canonicalPath] = Array.isArray(currentValue) ? [] : null
    } else if (Array.isArray(currentValue)) {
      if (op === 'add') {
        const appendedValues = Array.isArray(operation.value)
          ? operation.value
          : [operation.value]
        if (appendedValues.some((value) => !isRecord(value))) {
          throw new EnterpriseIdentityError(
            400,
            'EnterpriseScimPatchInvalid',
            `SCIM PATCH ${canonicalPath} values must be complex objects.`,
          )
        }
        next[canonicalPath] = [...currentValue, ...appendedValues]
      } else {
        if (!Array.isArray(operation.value)) {
          throw new EnterpriseIdentityError(
            400,
            'EnterpriseScimPatchInvalid',
            `SCIM PATCH ${canonicalPath} replacement must be an array.`,
          )
        }
        next[canonicalPath] = operation.value
      }
    } else {
      next[canonicalPath] = operation.value
    }
    assertScimPatchArrayLimits(next)
  }
  return next
}

function assertScimPatchArrayLimits(value: Record<string, unknown>) {
  if (
    Array.isArray(value.members) &&
    value.members.length > ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT
  ) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimGroupMemberLimitExceeded',
      `A SCIM group can contain at most ${
        ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT
      } members.`,
    )
  }
  if (
    Array.isArray(value.emails) &&
    value.emails.length > ENTERPRISE_SCIM_USER_EMAIL_LIMIT
  ) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimUserEmailLimitExceeded',
      `A SCIM user can contain at most ${
        ENTERPRISE_SCIM_USER_EMAIL_LIMIT
      } email addresses.`,
    )
  }
}

function setScimEtag(c: Context, version: number) {
  c.header('ETag', `W/"${version}"`)
}

function requireScimIfMatch(c: Context, version: number) {
  const ifMatch = c.req.header('If-Match')?.trim()
  if (!ifMatch || ifMatch === '*') return
  if (ifMatch !== `W/"${version}"` && ifMatch !== `"${version}"`) {
    throw new EnterpriseIdentityError(
      412,
      'EnterpriseScimVersionConflict',
      'SCIM resource version changed. Reload and retry with the latest ETag.',
    )
  }
}

function toScimJson(c: Context, value: object) {
  c.header('Content-Type', 'application/scim+json')
  c.header('Cache-Control', 'no-store')
  return c.json(value)
}

function toScimErrorResponse(c: Context, error: unknown) {
  const status = error instanceof EnterpriseIdentityError
    ? error.status
    : error instanceof WorkspaceAccessError
      ? error.status
      : 500
  const message = error instanceof Error ? error.message : 'SCIM operation failed.'
  if (status >= 500) console.error(error)
  c.status(
    status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 409 ||
      status === 412 ||
      status === 413 ||
      status === 429 ||
      status === 503
      ? status
      : 500,
  )
  return toScimJson(c, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: String(status),
    detail: message,
  })
}

/**
 * Registers the enterprise identity HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerEnterpriseIdentityRoutes(routeApp: Hono): void {
  /** Email domain に適用される enterprise SSO login policy を返します。 */
  routeApp.get('/api/auth/sso/discovery', async (c) => {
    const email = c.req.query('email')?.trim() ?? ''
    if (!email) {
      return c.json({ code: 'EnterpriseEmailRequired', message: 'Email is required.' }, 400)
    }
    try {
      const discovery = isEnterpriseSsoConfigured()
        ? await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
        : undefined
      if (!discovery) {
        return c.json({ ssoRequired: false, loginMode: 'password-or-sso' as const })
      }
      await enforceActiveTenantForWorkspace(discovery.provider.workspaceId)
      assertEnterpriseIdentityProviderReady(discovery.provider)
      assertEnterpriseCognitoProviderBinding(
        discovery.provider,
        requireEnterpriseCognitoProviderName(),
      )
      await assertEnterpriseCognitoFederationProvider(discovery.provider, 'cached')
      return c.json({
        ssoRequired: true,
        loginMode: 'sso-for-claimed-domains' as const,
        domain: discovery.domain.domain,
        provider: {
          id: discovery.provider.providerId,
          kind: discovery.provider.kind,
          displayName: discovery.provider.displayName,
        },
        ssoStartPath: '/api/auth/sso/start',
      })
    } catch (error) {
      return toEnterpriseSsoErrorResponse(c, error)
    }
  })

  /** Cognito federation の authorization-code + PKCE login を開始します。 */
  routeApp.post('/api/auth/sso/start', async (c) => {
    try {
      const body = await readJson<Record<string, unknown>>(c.req)
      const email = readWorkspaceEmail(body?.email)
      const discovery = isEnterpriseSsoConfigured()
        ? await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
        : undefined
      if (!discovery) {
        throw new EnterpriseSsoError(
          404,
          'EnterpriseSsoNotRequired',
          'Enterprise SSO is not configured for this email domain.',
        )
      }
      await enforceActiveTenantForWorkspace(discovery.provider.workspaceId)
      const configuration = requireEnterpriseSsoFederationConfiguration()
      assertEnterpriseIdentityProviderReady(discovery.provider)
      assertEnterpriseCognitoProviderBinding(
        discovery.provider,
        configuration.identityProviderName,
      )
      await assertEnterpriseCognitoFederationProvider(discovery.provider)
      await assertEnterpriseCognitoSsoAppClient(discovery.provider)
      const state = createEnterpriseSsoState({
        email,
        providerId: discovery.provider.providerId,
        providerRevision: discovery.provider.revision,
        redirectUri: configuration.redirectUri,
        returnTo: typeof body?.returnTo === 'string' ? body.returnTo : undefined,
        hmacSecret: configuration.stateSecret,
      })
      c.header('Cache-Control', 'no-store')
      return c.json({
        authorizationUrl: buildCognitoAuthorizeUrl({
          cognitoDomain: configuration.cognitoDomain,
          clientId: configuration.clientId,
          redirectUri: configuration.redirectUri,
          identityProvider: discovery.provider.cognitoProviderName,
          state: state.state,
          nonce: state.nonce,
          codeChallenge: state.codeChallenge,
        }),
        state: state.state,
        codeVerifier: state.codeVerifier,
        expiresAt: state.expiresAt * 1_000,
        returnTo: state.returnTo,
      })
    } catch (error) {
      return toEnterpriseSsoErrorResponse(c, error)
    }
  })

  /** Cognito federation callback の code を PKCE verifier 付きで token と交換します。 */
  routeApp.post('/api/auth/sso/exchange', async (c) => {
    try {
      const body = await readJson<Record<string, unknown>>(c.req)
      const configuration = requireEnterpriseSsoFederationConfiguration()
      const state = readEnterpriseText(body?.state, 'SSO state')
      const codeVerifier = readEnterpriseText(body?.codeVerifier, 'PKCE verifier')
      const validatedState = validateEnterpriseSsoState({
        state,
        codeVerifier,
        hmacSecret: configuration.stateSecret,
        expectedRedirectUri: configuration.redirectUri,
      })
      const discovery = await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(validatedState.email)
      if (
        !discovery ||
        discovery.provider.providerId !== validatedState.providerId ||
        discovery.provider.revision !== validatedState.providerRevision
      ) {
        throw new EnterpriseSsoError(
          409,
          'EnterpriseSsoConfigurationChanged',
          'Enterprise SSO configuration changed during login. Start again.',
        )
      }
      await enforceActiveTenantForWorkspace(discovery.provider.workspaceId)
      assertEnterpriseIdentityProviderReady(discovery.provider)
      assertEnterpriseCognitoProviderBinding(
        discovery.provider,
        configuration.identityProviderName,
      )
      await assertEnterpriseCognitoFederationProvider(discovery.provider)
      await assertEnterpriseCognitoSsoAppClient(discovery.provider)
      const code = readEnterpriseText(body?.code, 'Authorization code')
      const tokenUrl = new URL('/oauth2/token', normalizeEnterpriseCognitoDomain(
        configuration.cognitoDomain,
      ))
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: configuration.clientId,
          code,
          code_verifier: codeVerifier,
          redirect_uri: configuration.redirectUri,
        }),
        signal: AbortSignal.timeout(7_500),
      })
      const tokenResponse = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw new EnterpriseSsoError(
          401,
          'EnterpriseSsoCodeExchangeFailed',
          'Enterprise SSO authorization code could not be exchanged.',
        )
      }
      c.header('Cache-Control', 'no-store')
      const parsed = parseEnterpriseSsoTokenResponse({
        response: tokenResponse,
        expectedNonce: validatedState.nonce,
        expectedEmail: validatedState.email,
        returnTo: validatedState.returnTo,
        expectedClientId: configuration.clientId,
        expectedIssuer: configuration.issuer,
      })
      validateConfiguredCognitoAccessToken(parsed.accessToken)
      const accessTokenClaims = decodeJwtPayload<CognitoAccessTokenClaims>(parsed.accessToken)
      if (accessTokenClaims?.client_id !== configuration.clientId) {
        throw new EnterpriseSsoError(
          401,
          'InvalidSsoTokenResponse',
          'Cognito returned an access token for another app client.',
        )
      }
      const authentication = await createAuthenticationResponse({
        AccessToken: parsed.accessToken,
        IdToken: parsed.idToken,
        RefreshToken: parsed.refreshToken,
        ExpiresIn: Math.max(1, Math.floor((parsed.expiresAt - Date.now()) / 1_000)),
        TokenType: parsed.tokenType,
      }, c, {
        email: validatedState.email,
        providerId: validatedState.providerId,
        sso: true,
      }, undefined, [
        ...readCognitoAuthenticationMethods(
          decodeJwtPayload<CognitoAccessTokenClaims>(parsed.idToken),
        ),
        createEnterpriseSsoAuthenticationMethod(
          validatedState.providerId,
          discovery.provider.revision,
        ),
      ])
      return c.json({
        ...authentication,
        returnTo: parsed.returnTo,
      })
    } catch (error) {
      return toEnterpriseSsoErrorResponse(c, error)
    }
  })

  /** Enterprise identity/security の管理 snapshot を返します。 */
  routeApp.get('/api/enterprise/security', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const activeBreakGlassActivation = principal.enterpriseAuthenticationSessionId
        ? await workspaceDependencies.enterpriseIdentity.read.getActiveBreakGlassActivation(
          principal.directoryId,
          principal.userKey,
          principal.enterpriseAuthenticationSessionId,
        )
        : undefined
      return c.json({
        ...toEnterpriseSecuritySnapshotView(
        snapshot,
        new URL(`/api/scim/v2/${encodeURIComponent(principal.directoryId)}`, c.req.url).toString(),
        principal.enterprisePermissions,
        ),
        ...(activeBreakGlassActivation
          ? {
              activeBreakGlassActivation: {
                expiresAt: activeBreakGlassActivation.expiresAt,
              },
            }
          : {}),
      })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** SAML/OIDC identity provider を保存または SSO enforcement を更新します。 */
  routeApp.put('/api/enterprise/security/identity-provider', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const auditContext = createWorkspaceMutationContext(c, principal, body)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      if (typeof body?.enforced === 'boolean') {
        const provider = snapshot.identityProviders.find((candidate) =>
          candidate.status === 'active'
        )
        const domain = snapshot.domains.find((candidate) => candidate.status === 'verified')
        const breakGlassAccount = snapshot.breakGlassAccounts.find((candidate) =>
          isEnterpriseSsoRecoveryAccountReady(snapshot, candidate)
        )
        if (
          !domain ||
          body.enforced && (!provider || !breakGlassAccount)
        ) {
          throw new EnterpriseIdentityError(
            409,
            'EnterpriseSsoPrerequisiteMissing',
            'Verify a domain, activate an identity provider, and register an MFA-ready break-glass administrator before enforcing SSO.',
          )
        }
        if (body.enforced && provider) {
          const configuration = requireEnterpriseSsoFederationConfiguration()
          assertEnterpriseIdentityProviderReady(provider)
          assertEnterpriseCognitoProviderBinding(
            provider,
            configuration.identityProviderName,
          )
          await assertEnterpriseCognitoFederationProvider(provider)
          await assertEnterpriseCognitoSsoAppClient(provider)
        }
        const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 0)
        if (expectedVersion !== (provider?.revision ?? 0)) {
          throw new EnterpriseIdentityError(
            409,
            'EnterpriseIdentityProviderConflict',
            'Identity provider changed. Reload before changing SSO enforcement.',
          )
        }
        await workspaceDependencies.enterpriseIdentity.identityProviderAdministration.setSsoEnforcement(
          principal.directoryId,
          body.enforced,
          body.enforced ? provider?.providerId : undefined,
          expectedVersion,
          auditContext,
        )
      } else {
        const existing = snapshot.identityProviders[0]
        const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 0)
        if (expectedVersion !== (existing?.revision ?? 0)) {
          if (
            existing &&
            expectedVersion + 1 === existing.revision &&
            enterpriseIdentityProviderMatchesInput(existing, body)
          ) {
            return c.json({
              identityProvider: toEnterpriseSecuritySnapshotView(
                snapshot,
                new URL(
                  `/api/scim/v2/${encodeURIComponent(principal.directoryId)}`,
                  c.req.url,
                ).toString(),
                principal.enterprisePermissions,
              ).identityProvider,
            })
          }
          throw new EnterpriseIdentityError(
            409,
            'EnterpriseIdentityProviderConflict',
            'Identity provider changed. Reload and try again.',
          )
        }
        let provider = readEnterpriseIdentityProviderInput(
          principal.directoryId,
          body,
          existing,
        )
        if (body?.testConnection === true) {
          provider = await enterpriseIdentityProviderConnectionTester(provider)
        } else if (existing?.status === 'active') {
          throw new EnterpriseIdentityError(
            409,
            'EnterpriseIdentityProviderTestRequired',
            'Test the replacement identity provider before changing an active connection.',
          )
        }
        if (provider.status === 'active') {
          const configuration = requireEnterpriseSsoFederationConfiguration()
          assertEnterpriseIdentityProviderReady(provider)
          assertEnterpriseCognitoProviderBinding(
            provider,
            configuration.identityProviderName,
          )
          await assertEnterpriseCognitoFederationProvider(provider)
          await assertEnterpriseCognitoSsoAppClient(provider)
        }
        await workspaceDependencies.enterpriseIdentity.identityProviderAdministration.putIdentityProvider(
          provider,
          auditContext,
        )
      }
      const nextSnapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      return c.json({
        identityProvider: toEnterpriseSecuritySnapshotView(
          nextSnapshot,
          new URL(`/api/scim/v2/${encodeURIComponent(principal.directoryId)}`, c.req.url).toString(),
          principal.enterprisePermissions,
        ).identityProvider,
      })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Managed domain claim と一回限り DNS verification value を作成します。 */
  routeApp.post('/api/enterprise/security/domains', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const domainName = readEnterpriseText(body?.domain, 'Domain').toLowerCase()
      const requestIdempotencyKey =
        c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
      const domainId = createEnterpriseIdempotentResourceId(
        'domain',
        principal.directoryId,
        requestIdempotencyKey,
      )
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const receiptDomain = snapshot.domains.find((candidate) =>
        candidate.domainId === domainId
      )
      if (receiptDomain) {
        if (receiptDomain.domain !== domainName) {
          throw new EnterpriseIdentityError(
            409,
            'EnterpriseIdempotencyConflict',
            'Domain idempotency key was already used with a different payload.',
          )
        }
        return c.json({
          domain: toEnterpriseDomainView(receiptDomain),
          verificationRecordValue: createEnterpriseDomainVerificationValue(
            principal.directoryId,
            receiptDomain.domain,
          ),
        })
      }
      if (snapshot.domains.some((candidate) => candidate.domain === domainName)) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseDomainAlreadyClaimed',
          'Domain is already claimed in this Workspace.',
        )
      }
      const nowIso = new Date().toISOString()
      const domain = await workspaceDependencies.enterpriseIdentity.identityProviderAdministration.putVerifiedDomain({
        workspaceId: principal.directoryId,
        domainId,
        domain: domainName,
        status: 'pending',
        revision: 1,
        verificationRecordName: `_mukuroji-challenge.${domainName}`,
        enforceSso: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      }, createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey))
      return c.json({
        domain: toEnterpriseDomainView(domain),
        verificationRecordValue: createEnterpriseDomainVerificationValue(
          principal.directoryId,
          domain.domain,
        ),
      }, 201)
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** DNS TXT challenge を確認して domain claim を verified にします。 */
  routeApp.post('/api/enterprise/security/domains/:domain/verify', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const domain = snapshot.domains.find((candidate) =>
        candidate.domain === c.req.param('domain').trim().toLowerCase()
      )
      if (!domain) {
        throw new EnterpriseIdentityError(404, 'EnterpriseDomainNotFound', 'Domain was not found.')
      }
      const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
      if (domain.status === 'verified' && expectedVersion + 1 === domain.revision) {
        return c.json({ domain: toEnterpriseDomainView(domain) })
      }
      if (expectedVersion !== domain.revision) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseDomainConflict',
          'Domain claim changed. Reload and try again.',
        )
      }
      const expectedValue = createEnterpriseDomainVerificationValue(
        principal.directoryId,
        domain.domain,
      )
      if (!isLocalEnterpriseDomainVerification()) {
        const values = (await resolveTxt(domain.verificationRecordName)).flat()
        if (!values.includes(expectedValue)) {
          throw new EnterpriseIdentityError(
            409,
            'EnterpriseDomainVerificationPending',
            'DNS verification record was not found.',
            true,
          )
        }
      }
      const verified = await workspaceDependencies.enterpriseIdentity.identityProviderAdministration.putVerifiedDomain({
        ...domain,
        status: 'verified',
        revision: domain.revision + 1,
        verifiedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, createWorkspaceMutationContext(c, principal, body))
      return c.json({ domain: toEnterpriseDomainView(verified) })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** IP allowlist 保存前に現在の caller が締め出されるかを preview します。 */
  routeApp.post('/api/enterprise/security/policy/preview', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const current = snapshot.policy ??
        createDefaultEnterpriseSecurityPolicy(principal.directoryId, principal.actorId)
      const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 0)
      if (expectedVersion !== current.revision) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseSecurityPolicyConflict',
          'Security policy changed. Reload and try again.',
        )
      }
      const ipAllowlist = readEnterpriseStringArray(body?.ipAllowlist, 'IP allowlist')
      validateEnterpriseIpAllowlist(ipAllowlist)
      return c.json({
        impact: createEnterprisePolicyCallerImpact(
          c,
          principal.directoryId,
          expectedVersion,
          ipAllowlist,
        ),
      })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** MFA/session/reauthentication/IP/guest security policy を更新します。 */
  routeApp.put('/api/enterprise/security/policy', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const current = snapshot.policy ??
        createDefaultEnterpriseSecurityPolicy(principal.directoryId, principal.actorId)
      const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 0)
      if (expectedVersion !== current.revision) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseSecurityPolicyConflict',
          'Security policy changed. Reload and try again.',
        )
      }
      const ipAllowlist = readEnterpriseStringArray(body?.ipAllowlist, 'IP allowlist')
      validateEnterpriseIpAllowlist(ipAllowlist)
      const callerImpact = createEnterprisePolicyCallerImpact(
        c,
        principal.directoryId,
        expectedVersion,
        ipAllowlist,
      )
      if (
        callerImpact.requiresConfirmation &&
        body?.callerIpConfirmationToken !== callerImpact.confirmationToken
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseIpAllowlistCallerExclusionConfirmationRequired',
          'The new IP allowlist excludes the current caller. Preview and explicitly confirm it.',
        )
      }
      const externalCollaboratorsAllowed =
        typeof body?.externalCollaboratorsAllowed === 'boolean'
          ? body.externalCollaboratorsAllowed
          : current.externalAccess.allowExternalCollaborators
      const verifiedDomains = snapshot.domains.filter((domain) =>
        domain.status === 'verified'
      )
      const callerDomain = normalizeEnterpriseEmailDomain(principal.workspaceMember.email)
      const callerIsExternal = verifiedDomains.length > 0 &&
        !verifiedDomains.some((domain) => domain.domain === callerDomain)
      const callerIsRecovery = snapshot.breakGlassAccounts.some((account) =>
        account.status === 'active' && account.linkedMemberKey === principal.userKey
      )
      if (!externalCollaboratorsAllowed && callerIsExternal && !callerIsRecovery) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseExternalPolicyCallerExclusion',
          'Register and test an external break-glass account before excluding the current caller.',
        )
      }
      const policy = await workspaceDependencies.enterpriseIdentity.authorization.putSecurityPolicy({
        ...current,
        mfaRequirement: body?.mfaRequired === true ? 'required' : 'optional',
        sessionLifetimeMinutes: readEnterpriseInteger(
          body?.sessionLifetimeMinutes,
          'Session lifetime',
          1,
        ),
        idleTimeoutMinutes: readEnterpriseInteger(
          body?.idleTimeoutMinutes,
          'Idle timeout',
          1,
        ),
        reauthenticationIntervalMinutes: readEnterpriseInteger(
          body?.reauthenticationMinutes,
          'Reauthentication interval',
          1,
        ),
        sensitiveActionReauthenticationMinutes: readEnterpriseInteger(
          body?.sensitiveActionReauthenticationMinutes,
          'Sensitive reauthentication interval',
          1,
        ),
        ipAllowlistMode: ipAllowlist.length > 0
          ? 'all-users'
          : 'disabled',
        ipAllowlist,
        externalAccess: {
          ...current.externalAccess,
          allowGuests: body?.guestsAllowed === true,
          allowExternalCollaborators: externalCollaboratorsAllowed,
          maximumSessionLifetimeMinutes: readEnterpriseInteger(
            body?.guestSessionLifetimeMinutes,
            'Guest session lifetime',
            1,
          ),
          allowedGuestDomains: readEnterpriseDomainArray(
            body?.allowedGuestDomains,
            'Allowed guest domains',
          ),
        },
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: principal.actorId,
      }, createWorkspaceMutationContext(c, principal, body))
      return c.json({ policy: toEnterpriseSecuritySnapshotView(
        { ...snapshot, policy },
        new URL(`/api/scim/v2/${encodeURIComponent(principal.directoryId)}`, c.req.url).toString(),
        principal.enterprisePermissions,
      ).sessionPolicy })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** SCIM bearer token を rotate して raw token を一回だけ返します。 */
  routeApp.post('/api/enterprise/security/scim/token', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const requestIdempotencyKey =
        c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
      const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 0)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const requestedProviderId = typeof body?.identityProviderId === 'string'
        ? readEnterpriseText(body.identityProviderId, 'Identity provider ID')
        : undefined
      const readyProviders = snapshot.identityProviders.filter((candidate) =>
        candidate.status === 'active' &&
        candidate.lastTestedAt !== undefined &&
        Number.isFinite(Date.parse(candidate.lastTestedAt))
      )
      if (!requestedProviderId && readyProviders.length > 1) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseScimProviderAmbiguous',
          'Select the identity provider that will own this SCIM credential.',
        )
      }
      const provider = requestedProviderId
        ? readyProviders.find((candidate) => candidate.providerId === requestedProviderId)
        : readyProviders[0]
      assertEnterpriseIdentityProviderReady(provider)
      assertEnterpriseCognitoProviderBinding(
        provider,
        requireEnterpriseCognitoProviderName(),
      )
      await assertEnterpriseCognitoFederationProvider(provider)
      const issued = await workspaceDependencies.enterpriseIdentity.scimCredentialAdministration.rotateScimToken(
        principal.directoryId,
        provider.providerId,
        'Directory provider',
        expectedVersion,
        requestIdempotencyKey,
        createHash('sha256')
          .update(JSON.stringify({
            expectedVersion,
            identityProviderId: provider.providerId,
          }))
          .digest('hex'),
        createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey),
      )
      const nextSnapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      return c.json({
        scim: toEnterpriseSecuritySnapshotView(
          nextSnapshot,
          new URL(`/api/scim/v2/${encodeURIComponent(principal.directoryId)}`, c.req.url).toString(),
          principal.enterprisePermissions,
        ).scim,
        token: issued.token,
      }, 201)
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Provisioning dry-run impact preview を返します。 */
  routeApp.post('/api/enterprise/security/provisioning/preview', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const preview = await workspaceDependencies.enterpriseIdentity.provisioning.previewProvisioning({
        workspaceId: principal.directoryId,
        source: 'directory-reconciliation',
        idempotencyKey: c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID(),
        protectedMemberKeys: await resolveEnterpriseProtectedProvisioningMemberKeys(
          principal.directoryId,
          snapshot,
        ),
      }, createWorkspaceMutationContext(c, principal, body))
      return c.json({ impact: toEnterpriseProvisioningImpact(preview) })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** 確認済み provisioning preview を Workspace access state へ適用します。 */
  routeApp.post('/api/enterprise/security/provisioning/reconcile', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const previewId = readEnterpriseText(body?.previewId, 'Preview ID')
      const preview = await workspaceDependencies.enterpriseIdentity.provisioning.getProvisioningPreview(
        principal.directoryId,
        previewId,
      )
      if (
        !preview ||
        typeof body?.previewExpiresAt !== 'string' ||
        body.previewExpiresAt !== preview.expiresAt
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningPreviewExpired',
          'Provisioning preview changed or expired. Run a new dry-run.',
        )
      }
      const currentPreview = await workspaceDependencies.enterpriseIdentity.provisioning.previewProvisioning({
        workspaceId: principal.directoryId,
        source: 'directory-reconciliation',
        idempotencyKey: `${previewId}:freshness-check`,
        protectedMemberKeys: await resolveEnterpriseProtectedProvisioningMemberKeys(
          principal.directoryId,
          await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId),
        ),
      })
      if (currentPreview.fingerprint !== preview.fingerprint) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningPreviewChanged',
          'Directory desired state changed after the dry-run. Review a new preview.',
        )
      }
      const run = await workspaceDependencies.enterpriseIdentity.provisioning.reconcileProvisioning({
        workspaceId: principal.directoryId,
        source: 'directory-reconciliation',
        idempotencyKey: c.req.header('Idempotency-Key')?.trim() || previewId,
        previewFingerprint: preview.fingerprint,
      }, createWorkspaceMutationContext(c, principal, body))
      if (run.status === 'succeeded') return c.json({ run })
      if (run.status === 'failed') {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningRetryRequired',
          'This provisioning run failed previously. Use the retry action.',
        )
      }
      try {
        await applyEnterpriseProvisioningPlan(c, run)
        return c.json({
          run: await workspaceDependencies.enterpriseIdentity.provisioning.finalizeProvisioningRun(
            principal.directoryId,
            run.runId,
            'succeeded',
            undefined,
            createWorkspaceMutationContext(c, principal, body),
          ),
        })
      } catch (error) {
        await workspaceDependencies.enterpriseIdentity.provisioning.finalizeProvisioningRun(
          principal.directoryId,
          run.runId,
          'failed',
          resolveEnterpriseProvisioningFailureCode(error),
          createWorkspaceMutationContext(c, principal, body),
        )
        throw error
      }
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Redacted provisioning operation logs を返します。 */
  routeApp.get('/api/enterprise/security/provisioning/logs', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      return c.json({
        logs: toEnterpriseSecuritySnapshotView(
          snapshot,
          new URL(`/api/scim/v2/${encodeURIComponent(principal.directoryId)}`, c.req.url).toString(),
          principal.enterprisePermissions,
        ).provisioningLogs,
      })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Failed provisioning operation を retry します。 */
  routeApp.post('/api/enterprise/security/provisioning/logs/:runId/retry', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const run = await workspaceDependencies.enterpriseIdentity.provisioning.retryProvisioning(
        principal.directoryId,
        c.req.param('runId'),
        createWorkspaceMutationContext(c, principal, { runId: c.req.param('runId') }),
      )
      if (run.status === 'succeeded') return c.json({ run })
      try {
        await applyEnterpriseProvisioningPlan(c, run)
        return c.json({
          run: await workspaceDependencies.enterpriseIdentity.provisioning.finalizeProvisioningRun(
            principal.directoryId,
            run.runId,
            'succeeded',
            undefined,
            createWorkspaceMutationContext(c, principal, { runId: run.runId }),
          ),
        })
      } catch (error) {
        await workspaceDependencies.enterpriseIdentity.provisioning.finalizeProvisioningRun(
          principal.directoryId,
          run.runId,
          'failed',
          resolveEnterpriseProvisioningFailureCode(error),
          createWorkspaceMutationContext(c, principal, { runId: run.runId }),
        )
        throw error
      }
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Custom role を作成します。 */
  routeApp.post('/api/enterprise/security/roles', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const requestIdempotencyKey =
        c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
      const roleId: EnterpriseCustomRole['roleId'] = `custom:${createEnterpriseIdempotentResourceId(
      'role',
      principal.directoryId,
      requestIdempotencyKey,
    )}`
      const name = readEnterpriseText(body?.name, 'Role name')
      const description = typeof body?.description === 'string'
        ? body.description.trim()
        : undefined
      const permissions = readEnterprisePermissions(body?.permissionIds)
      requireEnterprisePermissionGrantCeiling(
        principal.enterprisePermissions,
        permissions,
      )
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const receiptRole = snapshot.customRoles.find((candidate) =>
        candidate.roleId === roleId
      )
      if (receiptRole) {
        if (
          receiptRole.name !== name ||
          (receiptRole.description ?? '') !== (description ?? '') ||
          receiptRole.permissions.length !== permissions.length ||
          !receiptRole.permissions.every((permission) => permissions.includes(permission)) ||
          receiptRole.guestAssignable !== (body?.guestAssignable === true)
        ) {
          throw new EnterpriseIdentityError(
            409,
            'EnterpriseIdempotencyConflict',
            'Role idempotency key was already used with a different payload.',
          )
        }
        return c.json({
          role: toEnterpriseRoleView(
            receiptRole,
            snapshot.roleAssignments.filter((assignment) =>
              assignment.roleId === receiptRole.roleId
            ).length,
          ),
        })
      }
      const nowIso = new Date().toISOString()
      const role = await workspaceDependencies.enterpriseIdentity.authorization.putCustomRole({
        workspaceId: principal.directoryId,
        roleId,
        name,
        description,
        permissions,
        guestAssignable: body?.guestAssignable === true,
        revision: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      }, createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey))
      return c.json({ role: toEnterpriseRoleView(role, 0) }, 201)
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Custom role 更新・削除前の assignment impact と確認 token を返します。 */
  routeApp.post('/api/enterprise/security/roles/:roleId/impact', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const role = snapshot.customRoles.find((candidate) =>
        candidate.roleId === c.req.param('roleId')
      )
      if (!role) {
        throw new EnterpriseIdentityError(404, 'EnterpriseRoleNotFound', 'Role was not found.')
      }
      if (readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1) !== role.revision) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseCustomRoleConflict',
          'Custom role changed. Reload and try again.',
        )
      }
      const deleteRequested = body?.delete === true
      const permissionIds = deleteRequested || body?.permissionIds === undefined
        ? role.permissions
        : readEnterprisePermissions(body.permissionIds)
      const guestAssignable = deleteRequested || body?.guestAssignable === undefined
        ? role.guestAssignable
        : body.guestAssignable === true
      return c.json({
        impact: createEnterpriseRoleImpact(
          snapshot,
          role,
          permissionIds,
          guestAssignable,
          deleteRequested,
        ),
      })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Custom role permission set を optimistic revision 付きで更新します。 */
  routeApp.put('/api/enterprise/security/roles/:roleId', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const existing = snapshot.customRoles.find((role) =>
        role.roleId === c.req.param('roleId')
      )
      if (!existing) {
        throw new EnterpriseIdentityError(404, 'EnterpriseRoleNotFound', 'Role was not found.')
      }
      if (readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1) !== existing.revision) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseCustomRoleConflict',
          'Custom role changed. Reload and try again.',
        )
      }
      const permissionIds = readEnterprisePermissions(body?.permissionIds)
      requireEnterprisePermissionGrantCeiling(
        principal.enterprisePermissions,
        permissionIds,
      )
      const guestAssignable = body?.guestAssignable === true
      const impact = createEnterpriseRoleImpact(
        snapshot,
        existing,
        permissionIds,
        guestAssignable,
        false,
      )
      if (body?.impactConfirmationToken !== impact.confirmationToken) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseRoleImpactConfirmationRequired',
          'Preview and confirm the custom role assignment impact before saving.',
        )
      }
      const role = await workspaceDependencies.enterpriseIdentity.authorization.putCustomRole({
        ...existing,
        name: readEnterpriseText(body?.name, 'Role name'),
        description: typeof body?.description === 'string' ? body.description.trim() : undefined,
        permissions: permissionIds,
        guestAssignable,
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
      }, createWorkspaceMutationContext(c, principal, body))
      return c.json({
        role: toEnterpriseRoleView(
          role,
          snapshot.roleAssignments.filter((assignment) => assignment.roleId === role.roleId).length,
        ),
      })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** 未使用 custom role を削除します。 */
  routeApp.delete('/api/enterprise/security/roles/:roleId', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const role = snapshot.customRoles.find((candidate) =>
        candidate.roleId === c.req.param('roleId')
      )
      if (!role) {
        throw new EnterpriseIdentityError(404, 'EnterpriseRoleNotFound', 'Role was not found.')
      }
      const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
      if (expectedVersion !== role.revision) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseCustomRoleConflict',
          'Custom role changed. Reload and try again.',
        )
      }
      const impact = createEnterpriseRoleImpact(
        snapshot,
        role,
        role.permissions,
        role.guestAssignable,
        true,
      )
      if (impact.blocking) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseCustomRoleInUse',
          'Reassign every role reference before deleting this custom role.',
        )
      }
      if (body?.impactConfirmationToken !== impact.confirmationToken) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseRoleImpactConfirmationRequired',
          'Preview and confirm the custom role assignment impact before deleting.',
        )
      }
      await workspaceDependencies.enterpriseIdentity.authorization.deleteCustomRole(
        principal.directoryId,
        c.req.param('roleId'),
        expectedVersion,
        createWorkspaceMutationContext(c, principal, body),
      )
      return c.body(null, 204)
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Directory group → scoped role mapping を作成します。 */
  routeApp.post('/api/enterprise/security/group-mappings', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const requestIdempotencyKey =
        c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
      const mappingId = createEnterpriseIdempotentResourceId(
        'group-mapping',
        principal.directoryId,
        requestIdempotencyKey,
      )
      const scopeType = body?.scopeType === 'team' || body?.scopeType === 'project'
        ? body.scopeType
        : 'workspace'
      const directoryGroupId = readEnterpriseText(
        body?.directoryGroupId,
        'Directory group ID',
      )
      const identityProviderId = readEnterpriseText(
        body?.identityProviderId,
        'Identity provider ID',
      )
      const roleId = readEnterpriseRoleId(body?.roleId)
      requireEnterpriseAssignableRole(
        snapshot,
        principal.enterprisePermissions,
        roleId,
        scopeType,
      )
      const scopeTargetId = scopeType === 'workspace'
        ? undefined
        : readEnterpriseText(body?.scopeId, 'Scope ID')
      const receiptMapping = snapshot.groupMappings.find((candidate) =>
        candidate.mappingId === mappingId
      )
      if (receiptMapping) {
        if (
          receiptMapping.directoryGroupId !== directoryGroupId ||
          receiptMapping.identityProviderId !== identityProviderId ||
          receiptMapping.roleId !== roleId ||
          receiptMapping.scope.kind !== scopeType ||
          receiptMapping.scope.targetId !== scopeTargetId
        ) {
          throw new EnterpriseIdentityError(
            409,
            'EnterpriseIdempotencyConflict',
            'Group mapping idempotency key was already used with a different payload.',
          )
        }
        return c.json({
          mapping: {
            id: receiptMapping.mappingId,
            identityProviderId: receiptMapping.identityProviderId,
            directoryGroupId: receiptMapping.directoryGroupId,
            directoryGroupName: typeof body?.directoryGroupName === 'string'
              ? body.directoryGroupName
              : receiptMapping.directoryGroupId,
            scopeType: receiptMapping.scope.kind,
            scopeId: receiptMapping.scope.targetId ?? receiptMapping.scope.workspaceId,
            scopeName: typeof body?.scopeName === 'string' ? body.scopeName : 'Workspace',
            roleId: receiptMapping.roleId,
            version: receiptMapping.revision,
          },
        })
      }
      await requireEnterpriseMappingReferences(
        snapshot,
        principal.directoryId,
        identityProviderId,
        directoryGroupId,
        scopeType,
        scopeTargetId,
      )
      const mapping = await workspaceDependencies.enterpriseIdentity.authorization.putGroupMapping({
        workspaceId: principal.directoryId,
        mappingId,
        identityProviderId,
        directoryGroupId,
        roleId,
        scope: {
          workspaceId: principal.directoryId,
          kind: scopeType,
          ...(scopeType === 'workspace'
            ? {}
            : { targetId: scopeTargetId }),
        },
        enabled: true,
        priority: snapshot.groupMappings.length,
        revision: 1,
        updatedAt: new Date().toISOString(),
      }, createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey))
      return c.json({
        mapping: {
          id: mapping.mappingId,
          identityProviderId: mapping.identityProviderId,
          directoryGroupId: mapping.directoryGroupId,
          directoryGroupName: typeof body?.directoryGroupName === 'string'
            ? body.directoryGroupName
            : mapping.directoryGroupId,
          scopeType: mapping.scope.kind,
          scopeId: mapping.scope.targetId ?? mapping.scope.workspaceId,
          scopeName: typeof body?.scopeName === 'string' ? body.scopeName : 'Workspace',
          roleId: mapping.roleId,
          version: mapping.revision,
        },
      }, 201)
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Directory group mapping の scope と role を optimistic revision 付きで更新します。 */
  routeApp.put('/api/enterprise/security/group-mappings/:mappingId', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const existing = snapshot.groupMappings.find((mapping) =>
        mapping.mappingId === c.req.param('mappingId')
      )
      if (!existing) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseGroupMappingNotFound',
          'Directory group mapping was not found.',
        )
      }
      const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
      if (existing.revision !== expectedVersion) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseGroupMappingConflict',
          'Directory group mapping changed. Reload and try again.',
        )
      }
      const scopeType = body?.scopeType === 'team' || body?.scopeType === 'project'
        ? body.scopeType
        : 'workspace'
      const roleId = readEnterpriseRoleId(body?.roleId)
      requireEnterpriseAssignableRole(
        snapshot,
        principal.enterprisePermissions,
        roleId,
        scopeType,
      )
      const directoryGroupId = readEnterpriseText(
        body?.directoryGroupId,
        'Directory group ID',
      )
      const identityProviderId = typeof body?.identityProviderId === 'string'
        ? readEnterpriseText(body.identityProviderId, 'Identity provider ID')
        : existing.identityProviderId
      if (identityProviderId !== existing.identityProviderId) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseDirectoryGroupProviderMismatch',
          'Directory mappings cannot be moved between identity providers.',
        )
      }
      const scopeTargetId = scopeType === 'workspace'
        ? undefined
        : readEnterpriseText(body?.scopeId, 'Scope ID')
      await requireEnterpriseMappingReferences(
        snapshot,
        principal.directoryId,
        identityProviderId,
        directoryGroupId,
        scopeType,
        scopeTargetId,
      )
      const mapping = await workspaceDependencies.enterpriseIdentity.authorization.putGroupMapping({
        ...existing,
        directoryGroupId,
        roleId,
        scope: {
          workspaceId: principal.directoryId,
          kind: scopeType,
          ...(scopeType === 'workspace'
            ? {}
            : { targetId: scopeTargetId }),
        },
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
      }, createWorkspaceMutationContext(c, principal, body))
      return c.json({
        mapping: {
          id: mapping.mappingId,
          identityProviderId: mapping.identityProviderId,
          directoryGroupId: mapping.directoryGroupId,
          directoryGroupName: typeof body?.directoryGroupName === 'string'
            ? body.directoryGroupName
            : mapping.directoryGroupId,
          scopeType: mapping.scope.kind,
          scopeId: mapping.scope.targetId ?? mapping.scope.workspaceId,
          scopeName: typeof body?.scopeName === 'string' ? body.scopeName : 'Workspace',
          roleId: mapping.roleId,
          version: mapping.revision,
        },
      })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Directory group mapping を削除します。 */
  routeApp.delete('/api/enterprise/security/group-mappings/:mappingId', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      await workspaceDependencies.enterpriseIdentity.authorization.deleteGroupMapping(
        principal.directoryId,
        c.req.param('mappingId'),
        readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1),
        createWorkspaceMutationContext(c, principal, body),
      )
      return c.body(null, 204)
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Service account と一回限り credential を作成します。 */
  routeApp.post('/api/enterprise/security/service-accounts', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const roleId = readEnterpriseRoleId(body?.roleId)
      const scopeType = body?.scopeType === 'team' || body?.scopeType === 'project'
        ? body.scopeType
        : 'workspace'
      const scopeId = scopeType === 'workspace'
        ? undefined
        : readEnterpriseText(body?.scopeId, 'Scope ID')
      requireEnterpriseAssignableRole(
        snapshot,
        principal.enterprisePermissions,
        roleId,
        scopeType,
      )
      await requireEnterpriseResourceScope(
        principal.directoryId,
        scopeType,
        scopeId,
      )
      const permissions = resolveEnterpriseRolePermissions(snapshot.customRoles, roleId)
      const credentialLifetimeDays = body?.credentialLifetimeDays === undefined
        ? 90
        : readEnterpriseInteger(body.credentialLifetimeDays, 'Credential lifetime', 1)
      if (credentialLifetimeDays > 365) {
        throw new EnterpriseIdentityError(
          400,
          'EnterpriseServiceAccountLifetimeInvalid',
          'Credential lifetime must not exceed 365 days.',
        )
      }
      const allowedSourceCidrs = body?.allowedSourceCidrs === undefined
        ? []
        : readEnterpriseStringArray(body.allowedSourceCidrs, 'Allowed source CIDRs')
      validateEnterpriseIpAllowlist(allowedSourceCidrs)
      allowedSourceCidrs.sort()
      const nowIso = new Date().toISOString()
      const requestIdempotencyKey =
        c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
      const issued = await workspaceDependencies.enterpriseIdentity.serviceAccountAdministration.createServiceAccountWithToken({
        workspaceId: principal.directoryId,
        accountId: createEnterpriseIdempotentResourceId(
          'service-account',
          principal.directoryId,
          requestIdempotencyKey,
        ),
        displayName: readEnterpriseText(body?.name, 'Service account name'),
        permissions: [...new Set([...permissions, 'service-accounts.use' as const])],
        roleId,
        scope: {
          workspaceId: principal.directoryId,
          kind: scopeType,
          ...(scopeId ? { targetId: scopeId } : {}),
        },
        credentialLifetimeDays,
        allowedSourceCidrs,
        status: 'active',
        credentialGeneration: 0,
        revision: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      }, requestIdempotencyKey, createHash('sha256')
        .update(JSON.stringify({
          name: body?.name,
          roleId,
          scopeType,
          scopeId,
          credentialLifetimeDays,
          allowedSourceCidrs,
        }))
        .digest('hex'), createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey))
      return c.json({
        serviceAccount: toEnterpriseServiceAccountView(
          issued.account,
          issued.credential.expiresAt,
        ),
        token: issued.token,
      }, 201)
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Service account credential を rotate して一回だけ返します。 */
  routeApp.post('/api/enterprise/security/service-accounts/:accountId/rotate', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const account = snapshot.serviceAccounts.find((candidate) =>
        candidate.accountId === c.req.param('accountId')
      )
      if (!account || account.status !== 'active') {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseServiceAccountNotFound',
          'Active service account was not found.',
        )
      }
      const requestIdempotencyKey =
        c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
      const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
      const issued = await workspaceDependencies.enterpriseIdentity.serviceAccountAdministration.rotateServiceAccountToken(
        principal.directoryId,
        account.accountId,
        expectedVersion,
        requestIdempotencyKey,
        createHash('sha256')
          .update(JSON.stringify({ accountId: account.accountId, expectedVersion }))
          .digest('hex'),
        createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey),
      )
      const rotatedAccount = (await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId))
        .serviceAccounts.find((candidate) => candidate.accountId === account.accountId) ?? account
      return c.json({
        serviceAccount: toEnterpriseServiceAccountView(
          rotatedAccount,
          issued.credential.expiresAt,
        ),
        token: issued.token,
      })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Service account と全 credential を revoke します。 */
  routeApp.post('/api/enterprise/security/service-accounts/:accountId/revoke', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const account = snapshot.serviceAccounts.find((candidate) =>
        candidate.accountId === c.req.param('accountId')
      )
      const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
      if (
        account?.status === 'disabled' &&
        expectedVersion + 1 === account.revision
      ) {
        return c.json({ revoked: true })
      }
      await workspaceDependencies.enterpriseIdentity.serviceAccountAdministration.revokeServiceAccountToken(
        principal.directoryId,
        c.req.param('accountId'),
        undefined,
        expectedVersion,
        createWorkspaceMutationContext(c, principal, body),
      )
      return c.json({ revoked: true })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** MFA enrollment 済み member を break-glass administrator として事前登録します。 */
  routeApp.post('/api/enterprise/security/break-glass/accounts', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const email = readWorkspaceEmail(body?.email)
      const member = (await workspaceDependencies.workspaceAccess.listActiveMembers(principal.directoryId))
        .find((candidate) => candidate.email.trim().toLowerCase() === email)
      if (!member || member.role === 'guest') {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseBreakGlassMemberInvalid',
          'Break-glass administrator must be an active non-guest Workspace member.',
        )
      }
      const profile = await authenticationDependencies.cognito.getUserProfile(member.memberKey)
      if (profile.mfaConfigured !== true) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseBreakGlassMfaRequired',
          'Configure MFA for this member before registering break-glass access.',
        )
      }
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      requireEnterpriseBreakGlassRecoveryDomainUnmanaged(snapshot, email)
      const requestIdempotencyKey =
        c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
      const accountId = createEnterpriseIdempotentResourceId(
        'break-glass',
        principal.directoryId,
        requestIdempotencyKey,
      )
      const receiptAccount = snapshot.breakGlassAccounts.find((account) =>
        account.accountId === accountId
      )
      if (receiptAccount && receiptAccount.linkedMemberKey !== member.memberKey) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseIdempotencyConflict',
          'Break-glass idempotency key was already used with a different member.',
        )
      }
      const existing = snapshot.breakGlassAccounts.find((account) =>
        account.linkedMemberKey === member.memberKey
      )
      if (existing?.status === 'active') {
        return c.json({
          breakGlassAdministrator: toEnterpriseBreakGlassView(existing),
        })
      }
      const nowIso = new Date().toISOString()
      const account = await workspaceDependencies.enterpriseIdentity.breakGlass.putBreakGlassAccount({
        workspaceId: principal.directoryId,
        accountId: existing?.accountId ?? accountId,
        linkedMemberKey: member.memberKey,
        email,
        status: 'active',
        requireMfa: true,
        maximumActivationMinutes: 30,
        mfaVerifiedAt: nowIso,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      }, createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey))
      return c.json({
        breakGlassAdministrator: toEnterpriseBreakGlassView(account),
      }, existing ? 200 : 201)
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /**
   * 事前登録済み recovery identity の local login、MFA、recent authentication を検査します。
   */
  routeApp.post('/api/enterprise/security/break-glass/test', async (c) => {
    try {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        throw new EnterpriseIdentityError(
          401,
          'EnterpriseAuthenticationRequired',
          'Bearer token is required.',
        )
      }
      const principal = await authenticateWorkspacePrincipal(
        accessToken,
        undefined,
        c,
        { breakGlassCandidate: true },
      )
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const account = snapshot.breakGlassAccounts.find((candidate) =>
        candidate.linkedMemberKey === principal.userKey && candidate.status === 'active'
      )
      if (!account) {
        throw new EnterpriseIdentityError(
          403,
          'EnterpriseBreakGlassDenied',
          'A pre-registered active break-glass account was not found for this member.',
        )
      }
      requireEnterpriseBreakGlassRecoveryDomainUnmanaged(snapshot, account.email)
      await requireEnterpriseMfa(principal.directoryId, accessToken)
      requireEnterpriseRecentAuthentication(
        accessToken,
        snapshot.policy?.sensitiveActionReauthenticationMinutes ?? 15,
      )
      const nowIso = new Date().toISOString()
      const tested = await workspaceDependencies.enterpriseIdentity.breakGlass.putBreakGlassAccount({
        ...account,
        lastTestedAt: nowIso,
        revision: account.revision + 1,
        updatedAt: nowIso,
      }, createWorkspaceMutationContext(c, principal, {
        accountId: account.accountId,
        recoveryAccessTested: true,
      }))
      return c.json({
        breakGlassAdministrator: toEnterpriseBreakGlassView(tested),
      })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /**
   * 事前登録済み本人だけが理由・MFA・recent re-authentication 付きで短時間昇格します。
   */
  routeApp.post('/api/enterprise/security/break-glass/activate', async (c) => {
    try {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        throw new EnterpriseIdentityError(
          401,
          'EnterpriseAuthenticationRequired',
          'Bearer token is required.',
        )
      }
      const principal = await authenticateWorkspacePrincipal(
        accessToken,
        undefined,
        c,
        { breakGlassCandidate: true },
      )
      const body = await readJson<Record<string, unknown>>(c.req)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const account = snapshot.breakGlassAccounts.find((candidate) =>
        candidate.linkedMemberKey === principal.userKey &&
        candidate.status === 'active'
      )
      if (!account) {
        throw new EnterpriseIdentityError(
          403,
          'EnterpriseBreakGlassDenied',
          'A pre-registered active break-glass account was not found for this member.',
        )
      }
      await requireEnterpriseMfa(principal.directoryId, accessToken)
      requireEnterpriseRecentAuthentication(
        accessToken,
        snapshot.policy?.sensitiveActionReauthenticationMinutes ?? 15,
      )
      const reason = readEnterpriseText(
        body?.reason ?? c.req.header('X-Break-Glass-Reason'),
        'Break-glass reason',
      )
      const activationSnapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const activationAccount = activationSnapshot.breakGlassAccounts.find((candidate) =>
        candidate.accountId === account.accountId &&
        candidate.linkedMemberKey === principal.userKey &&
        candidate.status === 'active'
      )
      if (!activationAccount) {
        throw new EnterpriseIdentityError(
          403,
          'EnterpriseBreakGlassDenied',
          'A pre-registered active break-glass account was not found for this member.',
        )
      }
      requireEnterpriseBreakGlassRecoveryDomainUnmanaged(
        activationSnapshot,
        activationAccount.email,
      )
      const durationMinutes = body?.durationMinutes === undefined
        ? Math.min(15, activationAccount.maximumActivationMinutes)
        : readEnterpriseInteger(body.durationMinutes, 'Activation duration', 1)
      const activation = await workspaceDependencies.enterpriseIdentity.breakGlass.activateBreakGlass(
        principal.directoryId,
        activationAccount.accountId,
        principal.userKey,
        createEnterpriseAuthenticationSessionId(accessToken),
        reason,
        durationMinutes,
        createWorkspaceMutationContext(c, principal, {
          accountId: activationAccount.accountId,
          durationMinutes,
          reason,
        }),
      )
      return c.json({
        activation: {
          id: activation.activationId,
          accountId: activation.accountId,
          startedAt: activation.startedAt,
          expiresAt: activation.expiresAt,
        },
      }, 201)
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Current member の break-glass elevation だけを早期終了します。 */
  routeApp.post('/api/enterprise/security/break-glass/revoke-activation', async (c) => {
    try {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        throw new EnterpriseIdentityError(
          401,
          'EnterpriseAuthenticationRequired',
          'Bearer token is required.',
        )
      }
      const principal = await authenticateWorkspacePrincipal(
        accessToken,
        undefined,
        c,
        { breakGlassCandidate: true },
      )
      await workspaceDependencies.enterpriseIdentity.breakGlass.revokeBreakGlassActivation(
        principal.directoryId,
        principal.userKey,
        createEnterpriseAuthenticationSessionId(accessToken),
        createWorkspaceMutationContext(c, principal, {
          breakGlassActivationRevoked: true,
        }),
      )
      return c.json({ revoked: true })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** Break-glass activation/account を即時停止します。 */
  routeApp.post('/api/enterprise/security/break-glass/deactivate', async (c) => {
    try {
      const principal = await requireEnterpriseSecurityPrincipal(c)
      const body = await readJson<Record<string, unknown>>(c.req)
      const accountId = readEnterpriseText(body?.administratorId, 'Administrator ID')
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
      const account = snapshot.breakGlassAccounts.find((candidate) =>
        candidate.accountId === accountId
      )
      if (!account) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseBreakGlassAccountNotFound',
          'Break-glass account was not found.',
        )
      }
      const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
      if (account.status === 'disabled' && expectedVersion + 1 === account.revision) {
        return c.json({ deactivated: true })
      }
      await workspaceDependencies.enterpriseIdentity.breakGlass.deactivateBreakGlass(
        principal.directoryId,
        accountId,
        expectedVersion,
        createWorkspaceMutationContext(c, principal, body),
      )
      return c.json({ deactivated: true })
    } catch (error) {
      return toEnterpriseIdentityBoundaryErrorResponse(c, error)
    }
  })

  /** SCIM 2.0 provider capability document を返します。 */
  routeApp.get('/api/scim/v2/:workspaceId/ServiceProviderConfig', async (c) => {
    try {
      await requireEnterpriseScimWorkspace(c)
      return toScimJson(c, {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 200 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: true },
        authenticationSchemes: [{
          type: 'oauthbearertoken',
          name: 'Bearer Token',
          description: 'Workspace-scoped SCIM bearer credential.',
          specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
          primary: true,
        }],
      })
    } catch (error) {
      return toScimErrorResponse(c, error)
    }
  })

  /** SCIM user desired-state collection を list します。 */
  routeApp.get('/api/scim/v2/:workspaceId/Users', async (c) => {
    try {
      const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
      const pagination = readScimPagination(c)
      const page = await workspaceDependencies.enterpriseIdentity.scimDirectory.listScimUsers({
        workspaceId,
        identityProviderId: credential.identityProviderId,
        ...pagination,
        ...readScimEqualityFilter(
          c.req.query('filter'),
          ['externalId', 'userName', 'displayName'],
        ),
      })
      return toScimJson(c, {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: page.totalResults,
        startIndex: page.startIndex,
        itemsPerPage: page.resources.length,
        Resources: page.resources.map(toScimUserResource),
      })
    } catch (error) {
      return toScimErrorResponse(c, error)
    }
  })

  /** SCIM user desired state を idempotent に作成します。 */
  routeApp.post('/api/scim/v2/:workspaceId/Users', async (c) => {
    try {
      const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
      const body = await readScimJson(c)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
      const input = readEnterpriseScimUserInput(
        c,
        workspaceId,
        credential.identityProviderId,
        body,
      )
      if (!input.active && input.linkedMemberKey) {
        await requireEnterpriseScimDeprovisionAllowed(
          workspaceId,
          input.linkedMemberKey,
          snapshot,
        )
      }
      const user = await workspaceDependencies.enterpriseIdentity.scimDirectory.upsertScimUser(
        input,
        createEnterpriseScimMutationContext(
          c,
          workspaceId,
          credential.identityProviderId,
          body,
        ),
      )
      await applyEnterpriseScimUser(c, user)
      c.status(201)
      c.header('Location', new URL(
        `/api/scim/v2/${encodeURIComponent(workspaceId)}/Users/${encodeURIComponent(user.userId)}`,
        c.req.url,
      ).toString())
      setScimEtag(c, user.version)
      return toScimJson(c, toScimUserResource(user))
    } catch (error) {
      return toScimErrorResponse(c, error)
    }
  })

  /** SCIM user desired state を ID で返します。 */
  routeApp.get('/api/scim/v2/:workspaceId/Users/:userId', async (c) => {
    try {
      const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
      const userId = readScimResourceId(c.req.param('userId'), 'user')
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
      const user = snapshot.scimUsers.find((candidate) =>
        candidate.userId === userId &&
        candidate.identityProviderId === credential.identityProviderId
      )
      if (!user) {
        throw new EnterpriseIdentityError(404, 'EnterpriseScimUserNotFound', 'SCIM user was not found.')
      }
      setScimEtag(c, user.version)
      return toScimJson(c, toScimUserResource(user))
    } catch (error) {
      return toScimErrorResponse(c, error)
    }
  })

  /** SCIM user desired state を replace/patch します。 */
  routeApp.on(['PUT', 'PATCH'], '/api/scim/v2/:workspaceId/Users/:userId', async (c) => {
    try {
      const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
      const userId = readScimResourceId(c.req.param('userId'), 'user')
      const body = await readScimJson(c)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
      const existing = snapshot.scimUsers.find((candidate) =>
        candidate.userId === userId &&
        candidate.identityProviderId === credential.identityProviderId
      )
      if (!existing) {
        throw new EnterpriseIdentityError(404, 'EnterpriseScimUserNotFound', 'SCIM user was not found.')
      }
      requireScimIfMatch(c, existing.version)
      const merged = applyScimPatch(body, {
        externalId: existing.externalId,
        userName: existing.userName,
        displayName: existing.displayName,
        emails: existing.emails.map((value) => ({ value, primary: value === existing.emails[0] })),
        active: existing.active,
      })
      const input = readEnterpriseScimUserInput(
        c,
        workspaceId,
        credential.identityProviderId,
        merged,
        existing,
      )
      if (!input.active && input.linkedMemberKey) {
        await requireEnterpriseScimDeprovisionAllowed(
          workspaceId,
          input.linkedMemberKey,
          snapshot,
        )
      }
      const user = await workspaceDependencies.enterpriseIdentity.scimDirectory.upsertScimUser(
        input,
        createEnterpriseScimMutationContext(
          c,
          workspaceId,
          credential.identityProviderId,
          body,
        ),
      )
      await applyEnterpriseScimUser(c, user)
      setScimEtag(c, user.version)
      return toScimJson(c, toScimUserResource(user))
    } catch (error) {
      return toScimErrorResponse(c, error)
    }
  })

  /** SCIM user を desired inactive に収束させます。 */
  routeApp.delete('/api/scim/v2/:workspaceId/Users/:userId', async (c) => {
    try {
      const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
      const userId = readScimResourceId(c.req.param('userId'), 'user')
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
      const existing = snapshot.scimUsers.find((candidate) =>
        candidate.userId === userId &&
        candidate.identityProviderId === credential.identityProviderId
      )
      if (!existing) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseScimUserNotFound',
          'SCIM user was not found.',
        )
      }
      requireScimIfMatch(c, existing.version)
      if (existing.linkedMemberKey) {
        await requireEnterpriseScimDeprovisionAllowed(
          workspaceId,
          existing.linkedMemberKey,
          snapshot,
        )
      }
      const user = await workspaceDependencies.enterpriseIdentity.scimDirectory.deactivateScimUser(
        workspaceId,
        credential.identityProviderId,
        userId,
        readScimIdempotencyKey(c, `delete-user:${userId}`),
        createEnterpriseScimMutationContext(
          c,
          workspaceId,
          credential.identityProviderId,
          { userId },
        ),
      )
      if (user) await applyEnterpriseScimUser(c, user)
      return c.body(null, 204)
    } catch (error) {
      return toScimErrorResponse(c, error)
    }
  })

  /** SCIM group desired-state collection を list します。 */
  routeApp.get('/api/scim/v2/:workspaceId/Groups', async (c) => {
    try {
      const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
      const pagination = readScimPagination(
        c,
        ENTERPRISE_SCIM_GROUP_PAGE_LIMIT,
      )
      const page = await workspaceDependencies.enterpriseIdentity.scimDirectory.listScimGroups({
        workspaceId,
        identityProviderId: credential.identityProviderId,
        ...pagination,
        ...readScimEqualityFilter(
          c.req.query('filter'),
          ['externalId', 'displayName'],
        ),
      })
      return toScimJson(c, {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: page.totalResults,
        startIndex: page.startIndex,
        itemsPerPage: page.resources.length,
        Resources: page.resources.map(toScimGroupResource),
      })
    } catch (error) {
      return toScimErrorResponse(c, error)
    }
  })

  /** SCIM group desired state を idempotent に作成します。 */
  routeApp.post('/api/scim/v2/:workspaceId/Groups', async (c) => {
    try {
      const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
      const body = await readScimJson(c)
      const input = readEnterpriseScimGroupInput(
        c,
        workspaceId,
        credential.identityProviderId,
        body,
      )
      const group = await workspaceDependencies.enterpriseIdentity.scimDirectory.upsertScimGroup(
        input,
        createEnterpriseScimMutationContext(
          c,
          workspaceId,
          credential.identityProviderId,
          body,
        ),
      )
      c.status(202)
      c.header('Retry-After', '1')
      c.header('Location', new URL(
        `/api/scim/v2/${encodeURIComponent(workspaceId)}/Groups/${
        encodeURIComponent(group.groupId)
      }`,
        c.req.url,
      ).toString())
      setScimEtag(c, group.version)
      return toScimJson(c, toScimGroupResource(group))
    } catch (error) {
      return toScimErrorResponse(c, error)
    }
  })

  /** SCIM group desired state を ID で返します。 */
  routeApp.get('/api/scim/v2/:workspaceId/Groups/:groupId', async (c) => {
    try {
      const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
      const groupId = readScimResourceId(c.req.param('groupId'), 'group')
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
      const group = snapshot.scimGroups.find((candidate) =>
        candidate.groupId === groupId &&
        candidate.identityProviderId === credential.identityProviderId
      )
      if (!group) {
        throw new EnterpriseIdentityError(404, 'EnterpriseScimGroupNotFound', 'SCIM group was not found.')
      }
      setScimEtag(c, group.version)
      return toScimJson(c, toScimGroupResource(group))
    } catch (error) {
      return toScimErrorResponse(c, error)
    }
  })

  /** SCIM group desired state を replace/patch します。 */
  routeApp.on(['PUT', 'PATCH'], '/api/scim/v2/:workspaceId/Groups/:groupId', async (c) => {
    try {
      const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
      const groupId = readScimResourceId(c.req.param('groupId'), 'group')
      const body = await readScimJson(c)
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
      const existing = snapshot.scimGroups.find((candidate) =>
        candidate.groupId === groupId &&
        candidate.identityProviderId === credential.identityProviderId
      )
      if (!existing) {
        throw new EnterpriseIdentityError(404, 'EnterpriseScimGroupNotFound', 'SCIM group was not found.')
      }
      requireScimIfMatch(c, existing.version)
      const merged = applyScimPatch(body, {
        externalId: existing.externalId,
        displayName: existing.displayName,
        active: existing.active,
        members: existing.memberUserIds.map((value) => ({ value })),
      })
      const group = await workspaceDependencies.enterpriseIdentity.scimDirectory.upsertScimGroup(
        readEnterpriseScimGroupInput(
          c,
          workspaceId,
          credential.identityProviderId,
          merged,
          existing,
        ),
        createEnterpriseScimMutationContext(
          c,
          workspaceId,
          credential.identityProviderId,
          body,
        ),
      )
      c.status(202)
      c.header('Retry-After', '1')
      setScimEtag(c, group.version)
      return toScimJson(c, toScimGroupResource(group))
    } catch (error) {
      return toScimErrorResponse(c, error)
    }
  })

  /** SCIM group を desired inactive に収束させます。 */
  routeApp.delete('/api/scim/v2/:workspaceId/Groups/:groupId', async (c) => {
    try {
      const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
      const groupId = readScimResourceId(c.req.param('groupId'), 'group')
      const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
      const existing = snapshot.scimGroups.find((candidate) =>
        candidate.groupId === groupId &&
        candidate.identityProviderId === credential.identityProviderId
      )
      if (!existing) {
        throw new EnterpriseIdentityError(
          404,
          'EnterpriseScimGroupNotFound',
          'SCIM group was not found.',
        )
      }
      requireScimIfMatch(c, existing.version)
      await workspaceDependencies.enterpriseIdentity.scimDirectory.deactivateScimGroup(
        workspaceId,
        credential.identityProviderId,
        groupId,
        readScimIdempotencyKey(c, `delete-group:${groupId}`),
        createEnterpriseScimMutationContext(
          c,
          workspaceId,
          credential.identityProviderId,
          { groupId },
        ),
      )
      c.header('Retry-After', '1')
      return c.body(null, 202)
    } catch (error) {
      return toScimErrorResponse(c, error)
    }
  })
}
