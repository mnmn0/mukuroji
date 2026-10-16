import type { Hono } from 'hono'
import type { Context } from 'hono'
import { createAuditRouter } from '../../modules/audit/adapter-in/http/audit-router'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import {
  auditEventsToNdjson,
  createAuditEvent,
  calculateAuditExpiresAt,
  getConfiguredAuditRetentionDays,
  toAuditEventView,
  type AuditEventPage,
  type AuditEventQuery,
} from '../../modules/audit/audit'
import { workspaceDependencies } from '../shared/app-dependencies'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import { readBearerAccessToken } from '../shared/http'
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

/**
 * Registers the audit HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerAuditRoutes(routeApp: Hono): void {
  routeApp.route('/', createAuditRouter(handleWorkspaceAuditRequest))
}
