import {
  parseCreateProjectStatusShareResponse,
  parseProjectStatusShare,
  parseProjectStatusShareListResponse,
  parsePublicProjectStatusReportResponse,
  type CreateProjectStatusShareRequest,
  type CreateProjectStatusShareResponse,
  type ProjectStatusReport,
  type ProjectStatusShare,
  type ProjectStatusShareListResponse,
  type PublicProjectStatusReportResponse,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { ProjectDirectoryApiError } from './errors'

const projectsApiBaseUrl = resolveApiBaseUrl('projects')

/**
 * Builds the API path below which one Project's report endpoints live.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @returns The API path below the projects base URL.
 */
function createProjectPath(teamId: string, projectId: string) {
  return `/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}`
}

/**
 * Renders a report as a PDF on the server, which embeds the Japanese font.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param report - Report to render.
 * @returns PDF bytes.
 * @throws ProjectDirectoryApiError when the request fails.
 */
export async function exportProjectStatusReportPdf(
  accessToken: string,
  teamId: string,
  projectId: string,
  report: ProjectStatusReport,
): Promise<Blob> {
  const response = await fetch(`${projectsApiBaseUrl}${createProjectPath(teamId, projectId)}/status-report/pdf`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ report }),
  })
  if (!response.ok) await readResponse(response, 'projects.statusReport.error.export')
  return await response.blob()
}

/**
 * Lists the share links of a Project.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @returns The validated list, newest first.
 */
export async function listProjectStatusShares(
  accessToken: string,
  teamId: string,
  projectId: string,
): Promise<ProjectStatusShareListResponse> {
  const response = await fetch(`${projectsApiBaseUrl}${createProjectPath(teamId, projectId)}/status-shares`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const parsed = parseProjectStatusShareListResponse(await readResponse(response, 'projects.statusReport.error.shares'))
  if (!parsed) throw new ProjectDirectoryApiError(502, 'projects.statusReport.error.shares')
  return parsed
}

/**
 * Creates a share link.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param request - Report, scope, label, and expiry.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The share and its one-time URL.
 */
export async function createProjectStatusShare(
  accessToken: string,
  teamId: string,
  projectId: string,
  request: CreateProjectStatusShareRequest,
  mutationContext: MutationRequestContext,
): Promise<CreateProjectStatusShareResponse> {
  const response = await fetch(`${projectsApiBaseUrl}${createProjectPath(teamId, projectId)}/status-shares`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    body: JSON.stringify(request),
  })
  const parsed = parseCreateProjectStatusShareResponse(await readResponse(response, 'projects.statusReport.error.create'))
  if (!parsed) throw new ProjectDirectoryApiError(502, 'projects.statusReport.error.create')
  return parsed
}

/**
 * Revokes a share link.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param shareId - Share to revoke.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The revoked share.
 */
export async function revokeProjectStatusShare(
  accessToken: string,
  teamId: string,
  projectId: string,
  shareId: string,
  mutationContext: MutationRequestContext,
): Promise<ProjectStatusShare> {
  const response = await fetch(
    `${projectsApiBaseUrl}${createProjectPath(teamId, projectId)}/status-shares/${encodeURIComponent(shareId)}/revoke`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      body: '{}',
    },
  )
  const data = await readResponse(response, 'projects.statusReport.error.revoke')
  const share = typeof data === 'object' && data !== null && 'share' in data ? parseProjectStatusShare(data.share) : undefined
  if (!share) throw new ProjectDirectoryApiError(502, 'projects.statusReport.error.revoke')
  return share
}

/**
 * Reads the report a public share link publishes, without sign-in.
 *
 * @param token - Token from the share URL.
 * @returns The published report.
 */
export async function getPublicProjectStatusReport(token: string): Promise<PublicProjectStatusReportResponse> {
  const response = await fetch(`${projectsApiBaseUrl}/public/project-status/${encodeURIComponent(token)}`, {
    referrerPolicy: 'no-referrer',
  })
  const parsed = parsePublicProjectStatusReportResponse(await readResponse(response, 'projects.statusReport.public.unavailable'))
  if (!parsed) throw new ProjectDirectoryApiError(502, 'projects.statusReport.public.unavailable')
  return parsed
}

/**
 * Downloads the PDF of a public share link, without sign-in.
 *
 * @param token - Token from the share URL.
 * @returns PDF bytes.
 */
export async function exportPublicProjectStatusReportPdf(token: string): Promise<Blob> {
  const response = await fetch(`${projectsApiBaseUrl}/public/project-status/${encodeURIComponent(token)}/pdf`, {
    referrerPolicy: 'no-referrer',
  })
  if (!response.ok) await readResponse(response, 'projects.statusReport.error.export')
  return await response.blob()
}

/**
 * Reads a response body, throwing the API error of a failed response.
 *
 * @param response - Fetch response.
 * @param fallbackMessage - Translation key used when the response carries no message.
 * @returns The parsed body of a successful response, or `undefined` when it is not JSON.
 * @throws ProjectDirectoryApiError when the response failed.
 */
async function readResponse(response: Response, fallbackMessage: string): Promise<unknown> {
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!response.ok) {
    throw new ProjectDirectoryApiError(response.status, fallbackMessage, readStringField(data, 'code'))
  }
  return data
}

/**
 * Reads one optional string field from an untrusted object.
 *
 * @param value - Untrusted value.
 * @param key - Field name.
 * @returns The string value, if present.
 */
function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field: unknown = Reflect.get(value, key)
  return typeof field === 'string' ? field : undefined
}
