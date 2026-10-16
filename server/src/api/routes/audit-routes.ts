import { createHash } from 'node:crypto'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import { createAuditRouter } from '../../modules/audit/adapter-in/http/audit-router'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import {
  auditEventsToNdjson,
  AuditEventIdempotencyConflictError,
  createAuditEvent,
  calculateAuditExpiresAt,
  getConfiguredAuditRetentionDays,
  toAuditEventView,
  type AuditEventPage,
  type AuditEventQuery,
} from '../../modules/audit/audit'
import {
  AUDIT_EXPORT_RECEIPT_RETENTION_DAYS,
  AUDIT_EXPORT_RETENTION_DAYS,
  AuditExportError,
  auditExportIdempotencyKeyExpired,
  toAuditExportView,
  type AuditExportFilters,
} from '../../modules/audit/audit-export'
import { workspaceDependencies } from '../shared/app-dependencies'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import { readBearerAccessToken, readJson } from '../shared/http'
import { readAuditEventQuery } from '../shared/input-parsing'
import {
  createApiMutationContext,
  type ProjectPrincipal,
  toProjectDataErrorResponse,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'

/**
 * Storage schema の内部属性を除いた paginated audit response を作成します。
 */
function toAuditEventPageView(page: AuditEventPage) {
  return {
    events: page.events.map(toAuditEventView),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}

async function recordWorkspaceAuditAccess(
  c: Context,
  principal: ProjectPrincipal,
  query: AuditEventQuery,
  exportAsNdjson: boolean,
  returnedEventCount: number,
  truncated: boolean,
) {
  if (!workspaceDependencies.auditEvents.putEvent) {
    throw new ProjectDataError(
      503,
      'AuditWriteUnavailable',
      'Audit access cannot proceed without an immutable audit writer.',
    )
  }
  const accessKind = exportAsNdjson ? 'exported' : 'viewed'
  const context = createApiMutationContext(c, principal, {
    auditAccess: accessKind,
    filters: {
      actorId: query.actorId,
      targetType: query.targetType,
      targetId: query.targetId,
      entityType: query.entityType,
      entityId: query.entityId,
      eventTypes: query.eventTypes,
      from: query.from,
      to: query.to,
      direction: query.direction,
      hasCursor: query.cursor !== undefined,
    },
  })
  await workspaceDependencies.auditEvents.putEvent(createAuditEvent({
    context,
    eventType: `audit.${accessKind}`,
    entity: {
      type: 'audit-log',
      id: principal.directoryId,
    },
    summary: exportAsNdjson ? 'Audit events were exported.' : 'Audit events were viewed.',
    metadata: {
      format: exportAsNdjson ? 'ndjson' : 'json',
      returnedEventCount,
      truncated,
      filtered: Boolean(
        query.actorId ||
        query.targetType ||
        query.targetId ||
        query.entityType ||
        query.entityId ||
        query.eventTypes?.length ||
        query.from ||
        query.to ||
        query.cursor
      ),
    },
    expiresAt: calculateAuditExpiresAt(
      context.occurredAt,
      getConfiguredAuditRetentionDays(),
    ),
  }))
}

async function handleWorkspaceAuditRequest(c: Context, exportAsNdjson: boolean) {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireSystemAdmin(principal)
    const query = readAuditEventQuery(c, principal.directoryId)

    if (!exportAsNdjson) {
      const page = await workspaceDependencies.auditEvents.query(query)
      await recordWorkspaceAuditAccess(
        c,
        principal,
        query,
        false,
        page.events.length,
        false,
      )
      return c.json(toAuditEventPageView(page))
    }

    const events = []
    let cursor = query.cursor

    do {
      const page = await workspaceDependencies.auditEvents.query({
        ...query,
        cursor,
        limit: Math.min(100, 1_000 - events.length),
      })
      events.push(...page.events)
      cursor = page.nextCursor
    } while (cursor && events.length < 1_000)

    const headers: Record<string, string> = {
      'Content-Disposition': 'attachment; filename="mukuroji-audit.ndjson"',
      'Content-Type': 'application/x-ndjson; charset=utf-8',
    }

    if (events.length === 1_000 && cursor) {
      headers['X-Audit-Truncated'] = 'true'
      headers['X-Audit-Next-Cursor'] = cursor
    }

    await recordWorkspaceAuditAccess(
      c,
      principal,
      query,
      true,
      events.length,
      events.length === 1_000 && Boolean(cursor),
    )
    return c.body(await auditEventsToNdjson(events), 200, headers)
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    if (error instanceof TypeError || error instanceof RangeError) {
      return c.json({ message: error.message }, 400)
    }

    return toProjectDataErrorResponse(c, error)
  }
}

function requireSystemAdmin(principal: ProjectPrincipal) {
  if (
    principal.isSystemAdmin ||
    principal.enterprisePermissions?.includes('audit.read') ||
    principal.enterprisePermissions?.includes('audit.export')
  ) {
    return
  }

  throw new ProjectDataError(
    403,
    'ProjectAccessDenied',
    `User "${principal.userKey}" must be a system administrator.`,
  )
}

/** Body fields accepted when requesting an asynchronous export. */
const AUDIT_EXPORT_FILTER_FIELDS = [
  'actorId',
  'actorKind',
  'entityType',
  'entityId',
  'targetType',
  'targetId',
  'eventTypes',
  'from',
  'to',
] as const

/**
 * Parses the filters of an asynchronous export request body.
 *
 * @param body - Parsed JSON request body.
 * @returns The requested filters.
 */
function readAuditExportFilters(body: unknown): AuditExportFilters {
  // A missing or malformed body must never widen into an unfiltered export.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AuditExportError(400, 'InvalidAuditExportRequest', 'Request body must be a JSON object such as {"filters":{}}.')
  }
  const unknownTopLevelField = Object.keys(body).find((key) => key !== 'filters')
  if (unknownTopLevelField !== undefined) {
    throw new AuditExportError(
      400,
      'InvalidAuditExportRequest',
      `Unsupported field: ${unknownTopLevelField}. Put export filters inside "filters".`,
    )
  }
  // An export of everything must be requested explicitly with {"filters":{}}.
  if (!Object.hasOwn(body, 'filters')) {
    throw new AuditExportError(400, 'InvalidAuditExportRequest', 'Request body must contain "filters"; use {"filters":{}} to export everything.')
  }
  const filters: unknown = Reflect.get(body, 'filters')
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
    throw new AuditExportError(400, 'InvalidAuditExportFilters', 'filters must be a JSON object.')
  }
  const unknownField = Object.keys(filters).find((key) => !AUDIT_EXPORT_FILTER_FIELDS.some((field) => field === key))
  if (unknownField) {
    throw new AuditExportError(400, 'InvalidAuditExportFilters', `Unsupported filter: ${unknownField}.`)
  }
  const result: Record<string, unknown> = {}
  for (const field of AUDIT_EXPORT_FILTER_FIELDS) {
    const value: unknown = Reflect.get(filters, field)
    if (value === undefined) continue
    if (field === 'eventTypes') {
      if (!Array.isArray(value) || value.length > 50 || !value.every((entry) => typeof entry === 'string' && entry.length <= 128)) {
        throw new AuditExportError(400, 'InvalidAuditExportFilters', 'eventTypes must be up to 50 strings.')
      }
      result.eventTypes = value
      continue
    }
    if (typeof value !== 'string' || value.length > 512) {
      throw new AuditExportError(400, 'InvalidAuditExportFilters', `${field} must be a string.`)
    }
    result[field] = value
  }
  const actorKind = result.actorKind
  if (actorKind !== undefined && actorKind !== 'user' && actorKind !== 'system' && actorKind !== 'service' && actorKind !== 'break-glass') {
    throw new AuditExportError(400, 'InvalidAuditExportFilters', 'actorKind is not supported.')
  }
  return {
    ...(typeof result.actorId === 'string' ? { actorId: result.actorId } : {}),
    ...(actorKind === 'user' || actorKind === 'system' || actorKind === 'service' || actorKind === 'break-glass'
      ? { actorKind }
      : {}),
    ...(typeof result.entityType === 'string' ? { entityType: result.entityType } : {}),
    ...(typeof result.entityId === 'string' ? { entityId: result.entityId } : {}),
    ...(typeof result.targetType === 'string' ? { targetType: result.targetType } : {}),
    ...(typeof result.targetId === 'string' ? { targetId: result.targetId } : {}),
    ...(Array.isArray(result.eventTypes)
      ? { eventTypes: result.eventTypes.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
    ...(typeof result.from === 'string' ? { from: result.from } : {}),
    ...(typeof result.to === 'string' ? { to: result.to } : {}),
  }
}

/**
 * Requires the principal to export audit events.
 *
 * @param principal - Authenticated Workspace principal.
 */
function requireAuditExporter(principal: ProjectPrincipal) {
  if (principal.isSystemAdmin || principal.enterprisePermissions?.includes('audit.export')) return
  throw new ProjectDataError(
    403,
    'ProjectAccessDenied',
    `User "${principal.userKey}" must be allowed to export audit events.`,
  )
}

/**
 * Records an immutable audit event for an asynchronous export action.
 *
 * @param c - Hono request context.
 * @param principal - Authenticated Workspace principal.
 * @param eventType - Export action event type.
 * @param metadata - Safe action metadata.
 * @param idempotencyKeyOverride - Operation-scoped audit idempotency key, if any.
 * @param replayGuard - For export requests, whether the export job still exists.
 * @returns When the request was first recorded: the earlier event's time on a retry,
 * otherwise this event's time.
 */
async function recordAuditExportAction(
  c: Context,
  principal: ProjectPrincipal,
  eventType: 'audit.export-requested' | 'audit.export-downloaded',
  metadata: Record<string, string | number | boolean>,
  idempotencyKeyOverride?: string,
  replayGuard?: { readonly jobExists: boolean },
): Promise<string> {
  if (!workspaceDependencies.auditEvents.putEvent) {
    throw new ProjectDataError(
      503,
      'AuditWriteUnavailable',
      'Audit access cannot proceed without an immutable audit writer.',
    )
  }
  const context = createApiMutationContext(c, principal, { auditExport: eventType, ...metadata }, idempotencyKeyOverride)
  const event = createAuditEvent({
    context,
    eventType,
    entity: { type: 'audit-log', id: principal.directoryId },
    summary: eventType === 'audit.export-requested'
      ? 'An audit export was requested.'
      : 'Audit export download links were issued.',
    metadata,
    // The request event is the key's receipt, so it outlives every export artifact even when
    // the configured audit retention is shorter.
    expiresAt: calculateAuditExpiresAt(
      context.occurredAt,
      eventType === 'audit.export-requested'
        ? Math.max(getConfiguredAuditRetentionDays(), AUDIT_EXPORT_RECEIPT_RETENTION_DAYS)
        : getConfiguredAuditRetentionDays(),
    ),
  })
  let recorded: Awaited<ReturnType<typeof workspaceDependencies.auditEvents.getEvent>> | undefined
  if (replayGuard && !replayGuard.jobExists) {
    // The audit event outlives the export job. A key whose recorded request is older than the
    // job lifetime belonged to an export that already expired, so it must not start a new one.
    recorded = await workspaceDependencies.auditEvents.getEvent(principal.directoryId, event.eventId)
    if (recorded && recorded.requestFingerprint !== event.requestFingerprint) throw auditExportIdempotencyConflict()
    if (
      recorded &&
      Date.parse(recorded.occurredAt) + AUDIT_EXPORT_RETENTION_DAYS * 86_400_000 <= Date.parse(context.occurredAt)
    ) {
      throw auditExportIdempotencyKeyExpired()
    }
  }
  try {
    await workspaceDependencies.auditEvents.putEvent(event)
  } catch (error) {
    // Only the writer's typed conflict is a reused key; malformed stored rows stay server errors.
    if (error instanceof AuditEventIdempotencyConflictError && eventType === 'audit.export-requested') {
      throw auditExportIdempotencyConflict()
    }
    throw error
  }
  return recorded?.occurredAt ?? event.occurredAt
}

/**
 * Creates the stable conflict for an export key reused with a different request.
 *
 * @returns A 409 audit export error.
 */
function auditExportIdempotencyConflict(): AuditExportError {
  return new AuditExportError(
    409,
    'AuditExportIdempotencyConflict',
    'Idempotency-Key was already used for a different audit export.',
  )
}

/**
 * Runs an asynchronous export route with shared authentication and error mapping.
 *
 * @param c - Hono request context.
 * @param run - Route body that receives the principal and service.
 * @returns The HTTP response.
 */
async function handleAuditExportJobRequest(
  c: Context,
  run: (
    principal: ProjectPrincipal,
    service: NonNullable<typeof workspaceDependencies.auditExports>,
  ) => Promise<Response>,
) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireAuditExporter(principal)
    const service = workspaceDependencies.auditExports
    if (!service) {
      return c.json({ code: 'AuditExportUnavailable', message: 'Asynchronous audit export is not configured.' }, 503)
    }
    return await run(principal, service)
  } catch (error) {
    if (error instanceof AuditExportError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }
    if (error instanceof CognitoServiceError) return toCognitoDirectoryErrorResponse(c, error)
    return toProjectDataErrorResponse(c, error)
  }
}

/**
 * Reads the first part index of a download page.
 *
 * @param value - Raw `fromPart` query value.
 * @returns The part index, 0 when absent.
 */
function readFromPartQuery(value: string | undefined): number {
  if (value === undefined) return 0
  if (!/^(0|[1-9]\d{0,6})$/u.test(value)) {
    throw new AuditExportError(400, 'InvalidAuditExportPart', 'fromPart must be a non-negative integer.')
  }
  return Number(value)
}

/**
 * Registers the audit HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerAuditRoutes(routeApp: Hono): void {
  routeApp.route('/', createAuditRouter(handleWorkspaceAuditRequest, {
    create: (c) => handleAuditExportJobRequest(c, async (principal, service) => {
      const filters = readAuditExportFilters(await readJson<unknown>(c.req))
      const idempotencyKey = c.req.header('Idempotency-Key')
      if (idempotencyKey === undefined) {
        throw new AuditExportError(400, 'IdempotencyKeyRequired', 'An Idempotency-Key header is required.')
      }
      const request = {
        workspaceId: principal.directoryId,
        requestedBy: { userKey: principal.userKey, displayName: principal.userKey },
        filters,
        idempotencyKey,
      }
      // The request is recorded before any job exists, so an export can never run
      // without its audit event. The key makes every retry reuse the same export and
      // write the same event, which the audit writer treats as an idempotent repeat.
      // The audit identity is scoped to export requests through the key-derived export
      // ID, so a key the member also used for another audited operation cannot collide
      // with it. The filter digest makes a reused key with different filters conflict
      // even before the job exists.
      const prepared = await service.prepareExport(request)
      // A retry after the request was recorded but its job was not created keeps the original
      // request time, so the export snapshot matches the recorded request.
      const requestedAt = await recordAuditExportAction(c, principal, 'audit.export-requested', {
        exportId: prepared.exportId,
        filtered: Object.keys(prepared.filters).length > 0,
        filtersDigest: prepared.requestFingerprint,
      }, `audit-export-request:${prepared.exportId}`, { jobExists: prepared.jobExists })
      const { job, created } = await service.requestExport({ ...request, requestedAt })
      return c.json({ export: toAuditExportView(job) }, created ? 202 : 200)
    }),
    list: (c) => handleAuditExportJobRequest(c, async (principal, service) =>
      c.json({ exports: (await service.listExports(principal.directoryId)).map(toAuditExportView) })
    ),
    get: (c) => handleAuditExportJobRequest(c, async (principal, service) =>
      c.json({ export: toAuditExportView(await service.getExport(principal.directoryId, c.req.param('exportId') ?? '')) })
    ),
    download: (c) => handleAuditExportJobRequest(c, async (principal, service) => {
      const job = await service.getExport(principal.directoryId, c.req.param('exportId') ?? '')
      const fromPart = readFromPartQuery(c.req.query('fromPart'))
      const page = await service.createDownloadLinks(job, fromPart)
      // A client key is scoped to this export page, so one key reused while following
      // nextPart neither collides across pages nor with other audited operations.
      // Without a key, every issuance is recorded as its own event.
      const downloadKey = c.req.header('Idempotency-Key')
      await recordAuditExportAction(c, principal, 'audit.export-downloaded', {
        exportId: job.exportId,
        fromPart,
        partCount: page.parts.length,
        eventCount: job.eventCount,
      }, downloadKey === undefined
        ? undefined
        : `audit-export-download:${job.exportId}:${fromPart}:${createHash('sha256').update(downloadKey).digest('hex')}`)
      return c.json({ export: toAuditExportView(job), ...page })
    }),
  }))
}
