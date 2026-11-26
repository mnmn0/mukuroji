import { createHash } from 'node:crypto'
import type { Context, Hono } from 'hono'
import {
  parseWorkItemWebLinkTitle,
  parseWorkItemWebLinkUrl,
  type PublicWorkItemWebLink,
  type PublicWorkItemWebLinkMutation,
} from '@mukuroji/contracts'
import { DeveloperPlatformError } from '../../modules/developer-platform'
import type { ReleaseIdempotencyRequest, ReserveIdempotencyRequest } from '../../modules/developer-platform/application/ports'
import { ProjectDataError } from '../../modules/directory'
import { developerPlatformDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson } from '../shared/http'
import { createApiMutationContext, toProjectDataErrorResponse, type WorkspacePrincipal } from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { isRecord, stableDigestStringify } from '../shared/value-guards'
import { createWorkItemIdempotencyTransaction } from '../shared/work-item-access'
import { createWorkItemScheduleIdempotencyUserId, createWorkItemScheduleIdempotencyWorkspaceId } from '../shared/work-item-schedule'
import {
  authorizeWorkItemWebLinkChange,
  createWorkItemWebLink,
  deleteWorkItemWebLink,
  listWorkItemWebLinks,
  type NewWorkItemWebLink,
  type WorkItemWebLinkCoWrites,
} from '../shared/work-item-web-link-access'

/** Error codes of the link store and rules that the Web routes return with their own status. */
const WEB_LINK_ERROR_CODES = new Set([
  'InvalidWorkItemWebLink',
  'WorkItemWebLinkDuplicate',
  'WorkItemWebLinkLimitExceeded',
  'WorkItemWebLinkNotFound',
  'WorkItemWebLinkConflict',
  'WorkItemWebLinkRetryable',
  'InvalidWorkItemWebLinkIdempotencyKey',
  'WorkItemWebLinkIdempotencyConflict',
  'WorkItemWebLinkIdempotencyInProgress',
  'WorkItemWebLinkIdempotencyUnavailable',
])

/** One link change of a Web route, bound to its idempotency key. */
type IdempotentWebLinkChange = {
  /** Caller with current permissions. */
  principal: WorkspacePrincipal
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item whose links change. */
  issueId: string
  /** HTTP method of the request. */
  method: 'POST' | 'DELETE'
  /** Canonical request path the key is bound to. */
  path: string
  /** Request body the key is bound to: the normalized link, or nothing for a removal. */
  body: unknown
  /** Response status of a success. */
  status: 200 | 201
  /** Link a removal names; a replay must return the same link. */
  linkId?: string
  /** Applies the change, committing the given writes with it. */
  apply: (coWrites: WorkItemWebLinkCoWrites) => Promise<PublicWorkItemWebLinkMutation>
}

/**
 * Reads the Team and Work Item IDs of a web link route.
 *
 * @param c - Hono request context.
 * @returns The Team and Work Item IDs.
 * @throws ProjectDataError 400 when one is missing.
 */
function readWorkItemRoute(c: Context) {
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')
  if (!teamId || !issueId) {
    throw new ProjectDataError(400, 'InvalidWorkItemWebLink', 'Team ID and Work Item ID are required.')
  }
  return { teamId, issueId }
}

/**
 * Reads the body of a link to add.
 *
 * @param value - Parsed JSON body.
 * @returns The normalized URL and title.
 * @throws ProjectDataError 400 when the URL or title is not acceptable.
 */
function readNewWebLink(value: unknown): NewWorkItemWebLink {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectDataError(400, 'InvalidWorkItemWebLink', 'A link body is required.')
  }
  const url = parseWorkItemWebLinkUrl(Reflect.get(value, 'url'))
  if (url === undefined) {
    throw new ProjectDataError(400, 'InvalidWorkItemWebLink', 'Enter an http or https URL of up to 2048 characters without a user name or password.')
  }
  const title = parseWorkItemWebLinkTitle(Reflect.get(value, 'title'))
  if (title === undefined) {
    throw new ProjectDataError(400, 'InvalidWorkItemWebLink', 'The title must be up to 256 characters without control characters.')
  }
  return { url, ...(title === null ? {} : { title }) }
}

/**
 * Turns an error of a link route into a response, keeping the link codes the Web shows.
 *
 * @param c - Hono request context.
 * @param error - Raised error.
 * @returns The error response.
 */
function toWebLinkErrorResponse(c: Context, error: unknown) {
  if (error instanceof ProjectDataError && WEB_LINK_ERROR_CODES.has(error.code)) {
    if (error.status === 400) return c.json({ code: error.code, message: error.message }, 400)
    if (error.status === 404) return c.json({ code: error.code, message: error.message }, 404)
    if (error.status === 409) return c.json({ code: error.code, message: error.message }, 409)
    return c.json({ code: error.code, message: error.message }, 503)
  }
  return toProjectDataErrorResponse(c, error)
}

/**
 * Reads the Idempotency-Key that every Web link change carries.
 *
 * @param value - Raw header value.
 * @returns The trimmed key.
 * @throws ProjectDataError 400 when the key is missing, too long, or has control characters.
 */
function readRequiredIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? ''
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (!key || key.length > 256 || hasControlCharacter) {
    throw new ProjectDataError(400, 'InvalidWorkItemWebLinkIdempotencyKey', 'Idempotency-Key must contain 1 to 256 characters without control characters.')
  }
  return key
}

/**
 * Reserves the idempotency key of a link change and maps store failures to link errors.
 *
 * @param request - Caller-scoped reservation.
 * @returns The reservation, in-progress, or replay decision.
 */
async function reserveWebLinkChange(request: ReserveIdempotencyRequest) {
  try {
    return await developerPlatformDependencies.idempotency.reserveIdempotency(request)
  } catch (error) {
    if (error instanceof DeveloperPlatformError && error.code === 'IdempotencyKeyConflict') {
      throw new ProjectDataError(409, 'WorkItemWebLinkIdempotencyConflict', 'Idempotency-Key was already used for a different link change.')
    }
    throw new ProjectDataError(503, 'WorkItemWebLinkIdempotencyUnavailable', 'Link change idempotency is unavailable.')
  }
}

/**
 * Reads a stored link of a replayed response.
 *
 * @param value - Stored link.
 * @returns The link, or `undefined` when it is malformed.
 */
function readStoredWebLink(value: unknown): PublicWorkItemWebLink | undefined {
  if (!isRecord(value)) return undefined
  const { id, url, title, createdByMemberId, createdAt } = value
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/u.test(id) || typeof url !== 'string' || typeof createdByMemberId !== 'string' || typeof createdAt !== 'string') {
    return undefined
  }
  if (title !== undefined && typeof title !== 'string') return undefined
  return { id, url, ...(title === undefined ? {} : { title }), createdByMemberId, createdAt }
}

/**
 * Reads the stored response of a link change replayed after a lost response.
 *
 * @param value - Stored `{ status, body }` response.
 * @param change - Change the request asks for.
 * @returns The response body.
 * @throws ProjectDataError 503 when the stored response does not belong to this change.
 */
function readStoredWebLinkMutation(value: unknown, change: IdempotentWebLinkChange): PublicWorkItemWebLinkMutation {
  const body = isRecord(value) && value.status === change.status && isRecord(value.body) ? value.body : undefined
  const link = readStoredWebLink(body?.link)
  if (
    body === undefined || link === undefined || body.schemaVersion !== 1 ||
    body.teamId !== change.teamId || body.workItemId !== change.issueId ||
    (change.linkId !== undefined && link.id !== change.linkId)
  ) {
    throw new ProjectDataError(503, 'WorkItemWebLinkIdempotencyUnavailable', 'The stored response of this link change is invalid.')
  }
  return { schemaVersion: 1, teamId: change.teamId, workItemId: change.issueId, link }
}

/**
 * Runs a link change once per Idempotency-Key. The receipt commits with the link row, so a retry
 * after a lost response replays the first response instead of failing as a duplicate or missing
 * link. Member access is checked before the key is reserved and again when the change commits.
 *
 * @param c - Hono request context.
 * @param change - Link change to run.
 * @returns The response of the change or of its replay.
 */
async function runIdempotentWebLinkChange(c: Context, change: IdempotentWebLinkChange) {
  const { principal } = change
  const idempotencyKey = readRequiredIdempotencyKey(c.req.header('Idempotency-Key'))
  const request: ReserveIdempotencyRequest = {
    workspaceId: createWorkItemScheduleIdempotencyWorkspaceId(principal.directoryId),
    credentialId: createWorkItemScheduleIdempotencyUserId(principal.directoryId, principal.actorId),
    idempotencyKey,
    requestFingerprint: createHash('sha256').update(`${change.method}\n${change.path}\n${stableDigestStringify(change.body)}`).digest('hex'),
  }
  // Access is checked before the key is reserved, so a caller who cannot change the links neither
  // holds a reservation nor reads a stored response; the change checks it again when it commits.
  await authorizeWorkItemWebLinkChange(principal, change.teamId, change.issueId)
  const reservation = await reserveWebLinkChange(request)
  if (reservation.status === 'in-progress') {
    throw new ProjectDataError(409, 'WorkItemWebLinkIdempotencyInProgress', 'The same link change is still in progress.')
  }
  if (reservation.status === 'replay') {
    const replayed = readStoredWebLinkMutation(reservation.response, change)
    c.header('Idempotency-Replayed', 'true')
    return c.json(replayed, change.status)
  }
  const owned: ReleaseIdempotencyRequest = { ...request, reservationId: reservation.reservationId }
  const transaction = createWorkItemIdempotencyTransaction(request.workspaceId, {
    credentialId: request.credentialId,
    idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    reservationId: reservation.reservationId,
  })
  let response: PublicWorkItemWebLinkMutation
  try {
    response = await change.apply(async (mutation) => {
      const receipt = await transaction?.prepare({ status: change.status, body: mutation })
      return receipt ? [receipt.transactWriteItem] : []
    })
  } catch (error) {
    await developerPlatformDependencies.idempotency.releaseIdempotency(owned).catch(() => undefined)
    throw error
  }
  // The receipt already committed with the link row where the store supports it; completing the
  // reservation again covers stores that keep receipts apart, and its failure does not undo the change.
  await developerPlatformDependencies.idempotency
    .completeIdempotency({ ...owned, response: { status: change.status, body: response } })
    .catch(() => undefined)
  return c.json(response, change.status)
}

/**
 * Registers the Web endpoints that list, add, and remove the web links of a Work Item. Listing
 * needs viewer access to the Work Item; adding and removing need member access and a business
 * write role.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerWorkItemWebLinkRoutes(routeApp: Hono): void {
  /** Lists the links of one Work Item, oldest first. */
  routeApp.get('/api/teams/:teamId/issues/:issueId/web-links', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, issueId } = readWorkItemRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      c.header('Cache-Control', 'no-store')
      return c.json(await listWorkItemWebLinks(principal, teamId, issueId))
    } catch (error) {
      return toWebLinkErrorResponse(c, error)
    }
  })

  /** Adds a link to one Work Item. */
  routeApp.post('/api/teams/:teamId/issues/:issueId/web-links', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, issueId } = readWorkItemRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const input = readNewWebLink(await readJson<unknown>(c.req))
      // The audit body names the Work Item only: the URL and title are user data kept in the link row.
      const auditContext = createApiMutationContext(c, principal, { teamId, issueId })
      return await runIdempotentWebLinkChange(c, {
        principal,
        teamId,
        issueId,
        method: 'POST',
        path: `/api/teams/${teamId}/issues/${issueId}/web-links`,
        body: input,
        status: 201,
        apply: (coWrites) => createWorkItemWebLink(principal, teamId, issueId, input, auditContext, coWrites),
      })
    } catch (error) {
      return toWebLinkErrorResponse(c, error)
    }
  })

  /** Removes one link from a Work Item. */
  routeApp.delete('/api/teams/:teamId/issues/:issueId/web-links/:linkId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, issueId } = readWorkItemRoute(c)
      const linkId = c.req.param('linkId')
      if (!linkId || !/^[0-9a-f]{32}$/u.test(linkId)) {
        throw new ProjectDataError(400, 'InvalidWorkItemWebLink', 'The link ID is invalid.')
      }
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const auditContext = createApiMutationContext(c, principal, { teamId, issueId, linkId })
      return await runIdempotentWebLinkChange(c, {
        principal,
        teamId,
        issueId,
        method: 'DELETE',
        path: `/api/teams/${teamId}/issues/${issueId}/web-links/${linkId}`,
        body: {},
        status: 200,
        linkId,
        apply: (coWrites) => deleteWorkItemWebLink(principal, teamId, issueId, linkId, auditContext, coWrites),
      })
    } catch (error) {
      return toWebLinkErrorResponse(c, error)
    }
  })
}
