import { Hono, type Context } from 'hono'
import type {
  RequestTenantClosureInput,
  RequestTenantExportInput,
  TenantDefaultPolicy,
  UpdateTenantEntitlementInput,
  UpdateTenantGovernanceInput,
  UpdateTenantProfileInput,
} from '@mukuroji/contracts'
import {
  TenantAdministrationError,
  validateTenantBoolean,
  validateTenantFeatures,
  validateTenantInteger,
  validateTenantLocale,
  validateTenantPlan,
  validateTenantRegion,
} from '../../domain/tenant-administration'
import type { TenantAdministrationClient } from '../../application/ports/tenant-administration-port'

/** Minimal authenticated principal required by tenant administration routes. */
export type TenantAdministrationPrincipal = {
  /** Canonical Workspace identifier used as the tenant identifier. */
  directoryId: string
  /** Stable authenticated Workspace member key. */
  userKey: string
}

/** Authoritative membership inputs used when tenant state is first initialized. */
export type TenantAdministrationInitialization = {
  /** Stable member key of the active Workspace owner. */
  ownerMemberKey: string
  /** Number of active Workspace members that currently consume seats. */
  activeSeats: number
}

/** Dependencies injected into the tenant administration HTTP adapter. */
export type TenantAdministrationRouterDependencies<
  Principal extends TenantAdministrationPrincipal,
> = {
  /** Resolves a bearer token to the current Workspace principal. */
  authenticate(accessToken: string, context: Context): Promise<Principal>
  /** Enforces Workspace owner/admin authorization at the route boundary. */
  requireAdministration(principal: Principal): void
  /** Restricts commercial entitlement mutations to the trusted system control plane. */
  requireEntitlementAdministration(principal: Principal): void
  /** Provides the tenant administration application port. */
  client: TenantAdministrationClient
  /** Resolves authoritative owner and seat state for first-time initialization. */
  resolveInitialization(
    principal: Principal,
  ): Promise<TenantAdministrationInitialization>
  /** Parses an untrusted HTTP request body. */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Converts authentication and domain failures to the repository response shape. */
  mapError(context: Context, error: unknown): Response
}

/**
 * Creates tenant profile, entitlement, governance, export, and closure routes.
 *
 * @param dependencies - Auth, application, parsing, and error-boundary dependencies.
 * @returns A Hono router mounted by the API composition root.
 */
export function createTenantAdministrationRouter<
  Principal extends TenantAdministrationPrincipal,
>(
  dependencies: TenantAdministrationRouterDependencies<Principal>,
) {
  const router = new Hono()

  router.get('/api/tenant/administration', async (context) => {
    try {
      const principal = await requirePrincipal(context, dependencies)
      dependencies.requireAdministration(principal)
      return context.json(await ensureTenantInitialized(principal, dependencies))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.patch('/api/tenant/profile', async (context) => {
    try {
      const principal = await requirePrincipal(context, dependencies)
      dependencies.requireAdministration(principal)
      await ensureTenantInitialized(principal, dependencies)
      const input = readTenantProfileInput(await dependencies.readJson(context.req))
      return context.json({
        profile: await dependencies.client.updateProfile(
          principal.directoryId,
          principal.userKey,
          input,
        ),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.patch('/api/tenant/entitlement', async (context) => {
    try {
      const principal = await requirePrincipal(context, dependencies)
      dependencies.requireEntitlementAdministration(principal)
      await ensureTenantInitialized(principal, dependencies)
      const input = readTenantEntitlementInput(await dependencies.readJson(context.req))
      return context.json({
        entitlement: await dependencies.client.updateEntitlement(
          principal.directoryId,
          principal.userKey,
          input,
        ),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.patch('/api/tenant/governance', async (context) => {
    try {
      const principal = await requirePrincipal(context, dependencies)
      dependencies.requireAdministration(principal)
      await ensureTenantInitialized(principal, dependencies)
      const input = readTenantGovernanceInput(await dependencies.readJson(context.req))
      return context.json({
        governance: await dependencies.client.updateGovernance(
          principal.directoryId,
          principal.userKey,
          input,
        ),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/tenant/exports', async (context) => {
    try {
      const principal = await requirePrincipal(context, dependencies)
      dependencies.requireAdministration(principal)
      await ensureTenantInitialized(principal, dependencies)
      const input = readTenantExportInput(await dependencies.readJson(context.req))
      return context.json({
        operation: await dependencies.client.requestExport(
          principal.directoryId,
          principal.userKey,
          input,
          readOptionalIdempotencyKey(context.req.header('Idempotency-Key')),
        ),
      }, 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/tenant/closures', async (context) => {
    try {
      const principal = await requirePrincipal(context, dependencies)
      dependencies.requireAdministration(principal)
      await ensureTenantInitialized(principal, dependencies)
      const input = readTenantClosureInput(await dependencies.readJson(context.req))
      return context.json({
        operation: await dependencies.client.requestClosure(
          principal.directoryId,
          principal.userKey,
          input,
          readOptionalIdempotencyKey(context.req.header('Idempotency-Key')),
        ),
      }, 202)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/tenant/operations/:operationId', async (context) => {
    try {
      const principal = await requirePrincipal(context, dependencies)
      dependencies.requireAdministration(principal)
      return context.json({
        operation: await dependencies.client.getOperation(
          principal.directoryId,
          readOperationId(context.req.param('operationId')),
        ),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  for (const action of ['pause', 'resume', 'verify'] as const) {
    router.post(`/api/tenant/operations/:operationId/${action}`, async (context) => {
      try {
        const principal = await requirePrincipal(context, dependencies)
        dependencies.requireAdministration(principal)
        const operationId = readOperationId(context.req.param('operationId'))
        const operation = action === 'pause'
          ? await dependencies.client.pauseOperation(principal.directoryId, principal.userKey, operationId)
          : action === 'resume'
            ? await dependencies.client.resumeOperation(principal.directoryId, principal.userKey, operationId)
            : await dependencies.client.verifyClosure(principal.directoryId, principal.userKey, operationId)
        return context.json({ operation })
      } catch (error) {
        return dependencies.mapError(context, error)
      }
    })
  }

  return router
}

/**
 * Initializes legacy tenant state from authoritative active Workspace membership.
 *
 * @param principal - Authenticated tenant administration principal.
 * @param dependencies - Tenant administration route dependencies.
 * @returns The current tenant administration snapshot.
 */
async function ensureTenantInitialized<
  Principal extends TenantAdministrationPrincipal,
>(
  principal: Principal,
  dependencies: TenantAdministrationRouterDependencies<Principal>,
) {
  const initialization = await dependencies.resolveInitialization(principal)
  return await dependencies.client.ensureSnapshot(
    principal.directoryId,
    initialization.ownerMemberKey,
    initialization.activeSeats,
  )
}

async function requirePrincipal<Principal extends TenantAdministrationPrincipal>(
  context: Context,
  dependencies: TenantAdministrationRouterDependencies<Principal>,
): Promise<Principal> {
  const authorization = context.req.header('Authorization') ?? ''
  const accessToken = authorization.match(/^Bearer\s+([^\s]+)$/iu)?.[1]
  if (!accessToken) {
    throw new TenantAdministrationError(401, 'AuthenticationRequired', 'Bearer token is required.')
  }
  return dependencies.authenticate(accessToken, context)
}

function readTenantProfileInput(value: unknown): UpdateTenantProfileInput {
  const body = readRecord(value)
  return {
    region: validateTenantRegion(body.region),
    locale: validateTenantLocale(body.locale),
    defaultPolicy: readTenantDefaultPolicy(body.defaultPolicy),
    expectedRevision: validateTenantInteger(body.expectedRevision, 1_000_000, 'InvalidTenantRevision'),
  }
}

function readTenantEntitlementInput(value: unknown): UpdateTenantEntitlementInput {
  const body = readRecord(value)
  return {
    plan: validateTenantPlan(body.plan),
    features: validateTenantFeatures(body.features),
    seatLimit: validateTenantInteger(body.seatLimit, 1_000_000, 'InvalidTenantSeatLimit'),
    usageQuota: validateTenantInteger(body.usageQuota, 1_000_000_000, 'InvalidTenantUsageQuota'),
    gracePeriodDays: validateTenantInteger(body.gracePeriodDays, 90, 'InvalidTenantGracePeriod'),
    expectedRevision: validateTenantInteger(body.expectedRevision, 1_000_000, 'InvalidTenantRevision'),
  }
}

function readTenantGovernanceInput(value: unknown): UpdateTenantGovernanceInput {
  const body = readRecord(value)
  const encryptionKeyPolicy = body.encryptionKeyPolicy === 'aws-managed' || body.encryptionKeyPolicy === 'customer-managed'
    ? body.encryptionKeyPolicy
    : undefined
  if (encryptionKeyPolicy === undefined) {
    throw new TenantAdministrationError(400, 'InvalidEncryptionKeyPolicy', 'Encryption key policy is invalid.')
  }
  return {
    auditRetentionDays: validateTenantInteger(body.auditRetentionDays, 2_555, 'InvalidAuditRetentionDays'),
    legalHold: validateTenantBoolean(body.legalHold, 'InvalidLegalHold'),
    dataResidency: validateTenantRegion(body.dataResidency),
    encryptionKeyPolicy,
    expectedRevision: validateTenantInteger(body.expectedRevision, 1_000_000, 'InvalidTenantRevision'),
  }
}

function readTenantDefaultPolicy(value: unknown): TenantDefaultPolicy {
  const policy = readRecord(value)
  const defaultMemberRole = policy.defaultMemberRole === 'member' || policy.defaultMemberRole === 'guest'
    ? policy.defaultMemberRole
    : undefined
  if (defaultMemberRole === undefined) {
    throw new TenantAdministrationError(400, 'InvalidTenantDefaultRole', 'Tenant default role is invalid.')
  }
  return {
    allowExternalCollaborators: validateTenantBoolean(policy.allowExternalCollaborators, 'InvalidTenantPolicy'),
    requireMfa: validateTenantBoolean(policy.requireMfa, 'InvalidTenantPolicy'),
    defaultMemberRole,
  }
}

function readTenantExportInput(value: unknown): RequestTenantExportInput {
  const body = readRecord(value)
  if (body.format !== 'jsonl' && body.format !== 'csv') {
    throw new TenantAdministrationError(400, 'InvalidTenantExportFormat', 'Tenant export format is invalid.')
  }
  return { format: body.format }
}

function readTenantClosureInput(value: unknown): RequestTenantClosureInput {
  const body = readRecord(value)
  if (body.confirmation !== 'CLOSE') {
    throw new TenantAdministrationError(400, 'ClosureConfirmationRequired', 'Closure confirmation is required.')
  }
  return { confirmation: 'CLOSE' }
}

function readOperationId(value: string | undefined): string {
  const operationId = value?.trim()
  if (!operationId || !/^[a-zA-Z0-9-]{1,128}$/u.test(operationId)) {
    throw new TenantAdministrationError(400, 'InvalidTenantOperationId', 'Tenant operation ID is invalid.')
  }
  return operationId
}

/**
 * Validates an optional tenant operation idempotency header.
 *
 * @param value - Candidate header value.
 * @returns A normalized key, or undefined when the header is absent.
 */
function readOptionalIdempotencyKey(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (normalized.length > 256 || hasControlCharacter) {
    throw new TenantAdministrationError(
      400,
      'InvalidTenantIdempotencyKey',
      'Tenant idempotency key is invalid.',
    )
  }
  return normalized
}

function readRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value
  }
  throw new TenantAdministrationError(400, 'InvalidRequestBody', 'Request body is invalid.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
