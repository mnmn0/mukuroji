import {
  parseOrgStructure,
  type OrgStructure,
  type ReplaceOrgStructureInput,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { ProjectDirectoryApiError } from './errors'

const projectsApiBaseUrl = resolveApiBaseUrl('projects')

/**
 * Reads the OrgUnit tree and Team memberships of the Workspace.
 *
 * @param accessToken - Bearer token of the member.
 * @param signal - Optional abort signal.
 * @returns The structure; a Workspace without OrgUnits has none and revision 0.
 */
export async function getOrgStructure(
  accessToken: string,
  signal?: AbortSignal,
): Promise<OrgStructure> {
  return await sendOrgStructureRequest(accessToken, { signal })
}

/**
 * Replaces the whole OrgUnit tree and Team memberships, refused when another change came first.
 *
 * @param accessToken - Bearer token of the Workspace administrator.
 * @param input - New structure and the revision it was edited from.
 * @param mutationContext - Idempotency context of the mutation.
 * @returns The stored structure.
 */
export async function replaceOrgStructure(
  accessToken: string,
  input: ReplaceOrgStructureInput,
  mutationContext: MutationRequestContext,
): Promise<OrgStructure> {
  return await sendOrgStructureRequest(
    accessToken,
    { method: 'PUT', body: JSON.stringify(input) },
    mutationContext,
  )
}

/**
 * Sends one OrgUnit structure request and validates the structure it returns.
 *
 * @param accessToken - Bearer token.
 * @param init - Fetch options.
 * @param mutationContext - Idempotency context, for a replacement.
 * @returns The structure in the response.
 */
async function sendOrgStructureRequest(
  accessToken: string,
  init: RequestInit,
  mutationContext?: MutationRequestContext,
): Promise<OrgStructure> {
  const response = await fetch(`${projectsApiBaseUrl}/org-structure`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(mutationContext ? createMutationHeaders(mutationContext) : {}),
    },
  })
  const data = parseResponseBody(await response.text())
  if (!response.ok) {
    throw new ProjectDirectoryApiError(
      response.status,
      readStringField(data, 'message') ?? 'projects.error.loading',
      readStringField(data, 'code'),
    )
  }
  const structure = typeof data === 'object' && data !== null
    ? parseOrgStructure(Reflect.get(data, 'orgStructure'))
    : undefined
  if (!structure) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
  }
  return structure
}

/**
 * Parses a response body, treating an empty or malformed body as an empty object.
 *
 * @param text - Raw response text.
 * @returns The parsed body.
 */
function parseResponseBody(text: string): unknown {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * Reads a string field from an untrusted response body.
 *
 * @param data - Parsed response body.
 * @param field - Field name.
 * @returns The field value when it is a string.
 */
function readStringField(data: unknown, field: string) {
  if (typeof data !== 'object' || data === null) return undefined
  const value: unknown = Reflect.get(data, field)
  return typeof value === 'string' ? value : undefined
}
