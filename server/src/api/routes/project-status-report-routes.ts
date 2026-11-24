import {
  createProjectStatusReportOutline,
  parseProjectStatusReport,
  PROJECT_STATUS_REPORT_MAX_BYTES,
  type ProjectStatusReport,
} from '@mukuroji/contracts'
import { createHmac, randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { createAnalyticsTextPdf } from '../../modules/analytics'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { ProjectDataError } from '../../modules/directory'
import {
  createProjectStatusShareUseCase,
  listProjectStatusSharesUseCase,
  readPublicProjectStatusReportUseCase,
  recordPublicProjectStatusViewUseCase,
  revokeProjectStatusShareUseCase,
} from '../../modules/project-status-shares'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { hasCustomerReadAccess } from '../shared/customer-access'
import { readBearerAccessToken, readJson } from '../shared/http'
import {
  createApiMutationContext,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  canWriteTeamProject,
  createTeamProjectCallerAuthorization,
  requireTeamProjectRead,
} from '../shared/team-project-access'
import { enforceActiveTenantForWorkspace } from '../shared/workspace-access'

/**
 * Registers the Project status report export and share link endpoints.
 *
 * Rendering a PDF needs viewer access to the Project. Listing, creating, and revoking share
 * links needs member access, the same role that edits the Project log. The public endpoints need
 * no sign-in: the token in the URL is the capability, and they return only the stored snapshot.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerProjectStatusReportRoutes(routeApp: Hono): void {
  /** Renders a report the caller built from the Project as a PDF. */
  routeApp.post('/api/teams/:teamId/projects/:projectId/status-report/pdf', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      await requireTeamProjectRead(principal, teamId, projectId)
      const body = await readJson<unknown>(c.req)
      const report = parseProjectStatusReport(isRecord(body) ? body.report : undefined)
      if (!report.ok) throw new ProjectDataError(400, 'InvalidProjectStatusReport', report.message)
      if (Buffer.byteLength(JSON.stringify(report.value), 'utf8') > PROJECT_STATUS_REPORT_MAX_BYTES) {
        throw new ProjectDataError(413, 'ProjectStatusReportTooLarge', 'The report is too large to export.')
      }
      return pdfResponse(report.value)
    } catch (error) {
      return toStatusReportErrorResponse(c, error)
    }
  })

  /** Lists the share links of a Project for the members who manage them. */
  routeApp.get('/api/teams/:teamId/projects/:projectId/status-shares', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      await requireShareManagement(principal, teamId, projectId)
      c.header('Cache-Control', 'private, no-store')
      return c.json(await listProjectStatusSharesUseCase(
        workItemDependencies.projectStatusShares,
        { workspaceId: principal.directoryId, teamId, projectId },
      ))
    } catch (error) {
      return toStatusReportErrorResponse(c, error)
    }
  })

  /** Creates a share link that publishes a redacted report snapshot. */
  routeApp.post('/api/teams/:teamId/projects/:projectId/status-shares', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      await requireShareManagement(principal, teamId, projectId)
      const body = await readJson<unknown>(c.req)
      const now = new Date().toISOString()
      // The request body carries the whole report, so only the fields that identify the share
      // request are fingerprinted for audit.
      const auditContext = createApiMutationContext(c, principal, readAuditBody(body))
      const response = await createProjectStatusShareUseCase(
        workItemDependencies.projectStatusShares,
        { workspaceId: principal.directoryId, teamId, projectId },
        body,
        {
          now,
          callerAuthorization: await createTeamProjectCallerAuthorization(
            principal,
            teamId,
            projectId,
            'ProjectStatusShareAuthorizationUnavailable',
          ),
          auditContext,
          createdByMemberKey: principal.userKey,
          requestSecret: deriveShareRequestSecret(auditContext.idempotencyKeyHash),
          checks: { verifyCustomerContact: (customerId, contactId) => verifyCustomerContact(principal, customerId, contactId) },
        },
      )
      c.header('Cache-Control', 'private, no-store')
      return c.json(response, 201)
    } catch (error) {
      return toStatusReportErrorResponse(c, error)
    }
  })

  /** Revokes a share link; the public page stops working at once. */
  routeApp.post('/api/teams/:teamId/projects/:projectId/status-shares/:shareId/revoke', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readRoute(c)
      const shareId = c.req.param('shareId')?.trim()
      if (!shareId) throw new ProjectDataError(400, 'InvalidProjectStatusShare', 'Share ID is required.')
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      await requireShareManagement(principal, teamId, projectId)
      const share = await revokeProjectStatusShareUseCase(
        workItemDependencies.projectStatusShares,
        { workspaceId: principal.directoryId, teamId, projectId },
        shareId,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createTeamProjectCallerAuthorization(
            principal,
            teamId,
            projectId,
            'ProjectStatusShareAuthorizationUnavailable',
          ),
          auditContext: createApiMutationContext(c, principal, { shareId }),
        },
      )
      return c.json({ share })
    } catch (error) {
      return toStatusReportErrorResponse(c, error)
    }
  })

  /** Returns the report a share link publishes, without sign-in. */
  routeApp.get('/api/public/project-status/:token', async (c) => {
    try {
      const { response, lookup } = await readPublicReport(c)
      await recordView(lookup)
      setPublicHeaders(c)
      return c.json(response)
    } catch (error) {
      return toPublicErrorResponse(c, error)
    }
  })

  /** Returns the report a share link publishes as a PDF, without sign-in. */
  routeApp.get('/api/public/project-status/:token/pdf', async (c) => {
    try {
      const { response, lookup } = await readPublicReport(c)
      // A direct download is a view too; the counting window keeps a page view and its
      // download within a minute from being counted twice.
      await recordView(lookup)
      const pdf = pdfResponse(response.report)
      pdf.headers.set('Referrer-Policy', 'no-referrer')
      return pdf
    } catch (error) {
      return toPublicErrorResponse(c, error)
    }
  })
}

/** Server secret that share request secrets are derived from, resolved on first use. */
let shareRequestKey: string | undefined

/**
 * Derives the secret of one share creation request from its idempotency key hash, which
 * already binds the Workspace and the actor. The token and share ID come from it, so a retry
 * with the same key returns the same link, and nobody without the server secret can predict it.
 *
 * The deployment's public share secret is reused with its own label; without one, as in local
 * runs, a random key lives for the process.
 *
 * @param idempotencyKeyHash - Hash of the request's idempotency key.
 * @returns The request secret.
 */
function deriveShareRequestSecret(idempotencyKeyHash: string) {
  shareRequestKey ??= resolveShareRequestKey(loadServerConfig().environment.DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET)
  return createHmac('sha256', shareRequestKey)
    .update('project-status-share-request-v1\0')
    .update(idempotencyKeyHash)
    .digest('base64url')
}

/**
 * Validates the configured server secret, or makes a random one when none is configured.
 *
 * @param configured - Configured secret.
 * @returns The key.
 * @throws Error when the configured secret is shorter than 32 bytes.
 */
function resolveShareRequestKey(configured: string | undefined) {
  if (configured === undefined) return randomBytes(32).toString('base64url')
  const key = configured.trim()
  if (Buffer.byteLength(key, 'utf8') < 32) {
    throw new Error('DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET must contain at least 32 UTF-8 bytes.')
  }
  return key
}

/**
 * Reads and trims the Team and Project identifiers of a route.
 *
 * @param c - Hono request context.
 * @returns The route identifiers.
 * @throws ProjectDataError when either identifier is missing.
 */
function readRoute(c: Context) {
  const teamId = c.req.param('teamId')?.trim()
  const projectId = c.req.param('projectId')?.trim()
  if (!teamId || !projectId) {
    throw new ProjectDataError(400, 'InvalidProjectStatusShare', 'Team ID and Project ID are required.')
  }
  return { teamId, projectId }
}

/**
 * Requires viewer access to the Project and member write access for share management.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @throws ProjectDataError 404 for a hidden Project and 403 without member access.
 */
async function requireShareManagement(principal: WorkspacePrincipal, teamId: string, projectId: string) {
  await requireTeamProjectRead(principal, teamId, projectId)
  if (!await canWriteTeamProject(principal, teamId, projectId)) {
    throw new ProjectDataError(403, 'ProjectStatusShareForbidden', 'Only a Project member can manage share links.')
  }
}

/**
 * Confirms that the caller may read customers and that the customer, and the contact when
 * given, exist.
 *
 * @param principal - Authenticated principal.
 * @param customerId - Customer ID.
 * @param contactId - Contact ID of that customer.
 * @throws ProjectDataError 403 without customer read access and 400 for an unknown customer.
 */
async function verifyCustomerContact(principal: WorkspacePrincipal, customerId: string, contactId: string | undefined) {
  if (!hasCustomerReadAccess(principal)) {
    throw new ProjectDataError(403, 'ProjectStatusShareCustomerForbidden', 'Customer read permission is required to link a customer.')
  }
  let detail
  try {
    detail = await workspaceDependencies.customers.getCustomer(principal.directoryId, customerId)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
      throw new ProjectDataError(400, 'InvalidProjectStatusShare', 'The customer was not found.')
    }
    throw error
  }
  if (contactId !== undefined && !detail.contacts.some((contact) => contact.id === contactId)) {
    throw new ProjectDataError(400, 'InvalidProjectStatusShare', 'The contact does not belong to the customer.')
  }
}

/**
 * Picks the fields of a share creation body that audit fingerprints.
 *
 * @param body - Untrusted request body.
 * @returns The fields that identify the request, without the report.
 */
function readAuditBody(body: unknown) {
  if (!isRecord(body)) return {}
  const { label, sections, showPeopleNames, expiresInDays, customerId, contactId } = body
  return { label, sections, showPeopleNames, expiresInDays, customerId, contactId }
}

/**
 * Resolves the token of a public request to its report.
 *
 * @param c - Hono request context.
 * @returns The public response and the share it came from.
 */
async function readPublicReport(c: Context) {
  return readPublicProjectStatusReportUseCase(
    workItemDependencies.projectStatusShares,
    c.req.param('token')?.trim() ?? '',
    new Date(),
    {
      assertWorkspaceActive: enforceActiveTenantForWorkspace,
      isProjectActive: async (scope) => {
        const source = await workspaceDependencies.projectDirectory.getProjectSearchSource(
          scope.workspaceId,
          scope.teamId,
          scope.projectId,
        )
        // A Team archive leaves its Projects' rows active, so the Team is checked too.
        return source !== undefined && !source.archived && !source.teamArchived
      },
    },
  )
}

/**
 * Counts a public view. A view that cannot be recorded fails the request, so a report is never
 * served without its audit trail.
 *
 * @param lookup - Share that was opened.
 */
async function recordView(lookup: Parameters<typeof recordPublicProjectStatusViewUseCase>[1]) {
  await recordPublicProjectStatusViewUseCase(workItemDependencies.projectStatusShares, lookup, new Date())
}

/**
 * Sets the headers that keep a public report out of caches and referrers.
 *
 * @param c - Hono request context.
 */
function setPublicHeaders(c: Context) {
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Robots-Tag', 'noindex')
}

/**
 * Renders a report as a PDF download response.
 *
 * @param report - Validated report.
 * @returns The response.
 */
function pdfResponse(report: ProjectStatusReport) {
  const outline = createProjectStatusReportOutline(report)
  const lines = [
    outline.title,
    outline.subtitle,
    '',
    ...outline.sections.flatMap((section) => [
      `■ ${section.heading}`,
      ...section.lines.map((line) => `  ${line}`),
      '',
    ]),
  ]
  const body = createAnalyticsTextPdf(lines, report.locale, 'a4')
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="project-status-report.pdf"',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  })
}

/**
 * Converts a failure of an authenticated endpoint to an HTTP response.
 *
 * @param c - Hono request context.
 * @param error - Thrown error.
 * @returns The response.
 */
function toStatusReportErrorResponse(c: Context, error: unknown) {
  if (
    error instanceof ProjectDataError &&
    (error.code.startsWith('ProjectStatus') || error.code === 'InvalidProjectStatusShare' || error.code === 'InvalidProjectStatusReport')
  ) {
    const status = toKnownStatus(error.status)
    if (status >= 500) {
      console.error('Project status report request failed.', {
        status,
        code: error.code,
        requestId: c.req.header('X-Request-Id'),
        error,
      })
    }
    return c.json({ code: error.code, message: error.message }, status)
  }
  return toProjectDataErrorResponse(c, error)
}

/**
 * Converts a failure of a public endpoint to an HTTP response that reveals nothing about the
 * Workspace: a missing, revoked, or expired link and a closed Workspace all answer 404.
 *
 * @param c - Hono request context.
 * @param error - Thrown error.
 * @returns The response.
 */
function toPublicErrorResponse(c: Context, error: unknown) {
  setPublicHeaders(c)
  if (error instanceof ProjectDataError && error.status === 404) {
    return c.json({ code: 'ProjectStatusShareNotFound', message: error.message }, 404)
  }
  console.error('Public Project status report request failed.', { requestId: c.req.header('X-Request-Id'), error })
  return c.json({ code: 'ProjectStatusShareUnavailable', message: 'The report is temporarily unavailable.' }, 503)
}

/**
 * Narrows an error status to the statuses the endpoints answer with.
 *
 * @param status - Status carried by the error.
 * @returns The same status when it is expected, otherwise 502.
 */
function toKnownStatus(status: number): 400 | 403 | 404 | 409 | 413 | 502 | 503 {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 413:
    case 503:
      return status
    default:
      return 502
  }
}

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
