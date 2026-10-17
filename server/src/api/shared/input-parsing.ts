import type { Context } from 'hono'
import { ProjectDataError, type Locale } from '../../modules/directory'
import { type AuditEventEntityType, type AuditEventQuery } from '../../modules/audit/audit'
import { FileProofingError } from '../../modules/files/file-proofing'
import { WorkspaceSearchError } from '../../modules/workspace-search/workspace-search'

/**
 * Reads the audit event query parameters for a Workspace or entity.
 *
 * @param c - Hono request context.
 * @param workspaceId - Workspace that scopes the operation.
 * @param entity - Audited entity filter.
 * @returns The audit event query.
 */
export function readAuditEventQuery(
  c: Context,
  workspaceId: string,
  entity?: { type: AuditEventEntityType; id: string },
): AuditEventQuery {
  const limitValue = c.req.query('limit')
  const limit = limitValue ? Number(limitValue) : undefined
  const eventTypes = c.req.query('eventType')
    ?.split(',')
    .map((eventType) => eventType.trim())
    .filter(Boolean)

  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new ProjectDataError(400, 'InvalidAuditQuery', 'Audit limit is invalid.')
  }

  return {
    workspaceId,
    actorId: c.req.query('actorUserId') ?? c.req.query('actorId'),
    targetType: c.req.query('targetType'),
    targetId: c.req.query('targetId'),
    eventTypes,
    from: c.req.query('from'),
    to: c.req.query('to'),
    limit,
    cursor: c.req.query('cursor'),
    direction: c.req.query('direction') === 'ascending' ? 'ascending' : 'descending',
    ...(entity ? { entityType: entity.type, entityId: entity.id } : {}),
  }
}

/**
 * Reads the requested display locale from the query string.
 *
 * @param c - Hono request context.
 * @returns `en` when requested, otherwise `ja`.
 */
export function readLocale(c: Context): Locale {
  return c.req.query('locale') === 'en' ? 'en' : 'ja'
}

/**
 * Reads an optional positive integer query parameter.
 *
 * @param value - Raw input value.
 * @param label - Field label used in validation messages.
 * @returns The parsed integer, or `undefined` when the parameter is absent.
 */
export function readOptionalPositiveQueryInteger(value: string | undefined, label: string) {
  if (value === undefined) return undefined
  return readRequiredPositiveQueryInteger(value, label)
}

/**
 * Reads a required positive integer query parameter.
 *
 * @param value - Raw input value.
 * @param label - Field label used in validation messages.
 * @returns The parsed integer.
 */
export function readRequiredPositiveQueryInteger(value: string | undefined, label: string) {
  const parsed = value ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WorkspaceSearchError(400, 'InvalidWorkspaceSearch', `${label} must be a positive integer.`)
  }
  return parsed
}

/**
 * Reads a required route identifier.
 *
 * @param value - Raw input value.
 * @param label - Field label used in validation messages.
 * @returns The trimmed identifier.
 */
export function readRequiredRouteId(value: string | undefined, label: string) {
  const normalized = value?.trim()
  if (!normalized) {
    throw new FileProofingError(400, 'InvalidFileScope', `${label} is required.`)
  }
  return normalized
}
