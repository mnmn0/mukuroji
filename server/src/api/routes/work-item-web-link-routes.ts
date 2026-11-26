import type { Context, Hono } from 'hono'
import {
  parseWorkItemWebLinkTitle,
  parseWorkItemWebLinkUrl,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import { readBearerAccessToken, readJson } from '../shared/http'
import { createApiMutationContext, toProjectDataErrorResponse } from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  createWorkItemWebLink,
  deleteWorkItemWebLink,
  listWorkItemWebLinks,
  type NewWorkItemWebLink,
} from '../shared/work-item-web-link-access'

/** Error codes of the link store and rules that the Web routes return with their own status. */
const WEB_LINK_ERROR_CODES = new Set([
  'InvalidWorkItemWebLink',
  'WorkItemWebLinkDuplicate',
  'WorkItemWebLinkLimitExceeded',
  'WorkItemWebLinkNotFound',
  'WorkItemWebLinkConflict',
  'WorkItemWebLinkRetryable',
])

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
      return c.json(await createWorkItemWebLink(principal, teamId, issueId, input, auditContext), 201)
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
      return c.json(await deleteWorkItemWebLink(principal, teamId, issueId, linkId, auditContext))
    } catch (error) {
      return toWebLinkErrorResponse(c, error)
    }
  })
}
