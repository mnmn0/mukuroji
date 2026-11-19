import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { EnterpriseSecurityApiError } from './errors'
import { isRecord } from '../../shared/api/jsonValidation'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

/**
 * Resource level that a member role assignment applies to.
 */
export type EnterpriseMemberRoleAssignmentScope = 'workspace' | 'team' | 'project'

/**
 * Role assigned directly to one Workspace member.
 */
export type EnterpriseMemberRoleAssignment = {
  /** Stable assignment ID. */
  id: string
  /** Member key of the member who holds the role. */
  memberKey: string
  /** Built-in or custom role ID. */
  roleId: string
  /** Resource level of the assignment. */
  scopeType: EnterpriseMemberRoleAssignmentScope
  /** Workspace, Team, or Project ID of the assignment. */
  scopeId: string
  /** Team that owns the Project of a Project-scoped assignment. */
  scopeParentId?: string
}

/**
 * Active Workspace member that the security screen can assign a role to.
 */
export type EnterpriseAssignableMember = {
  /** Stable member key. */
  memberKey: string
  /** Member email address. */
  email: string
  /** Optional display name. */
  name?: string
  /** Workspace role that applies while the member has no direct assignment. */
  role: 'owner' | 'admin' | 'member' | 'guest'
}

/**
 * Input of the member role assignment create API.
 */
export type CreateEnterpriseMemberRoleAssignmentInput = {
  /** Member who receives the role. */
  memberKey: string
  /** Role to assign. */
  roleId: string
  /** Resource level of the assignment. */
  scopeType: EnterpriseMemberRoleAssignmentScope
  /** Team or Project ID; the Workspace scope ignores it. */
  scopeId: string
  /** Team that owns the Project, required when the Project belongs to several Teams. */
  scopeParentId?: string
}

const enterpriseSecurityApiBaseUrl = resolveApiBaseUrl('enterpriseIdentity')

/**
 * Assigns a role to one Workspace member.
 *
 * @param accessToken - Access token of the administrator.
 * @param input - Member, role, and scope to assign.
 * @param mutationContext - Idempotency and audit headers of the mutation.
 * @returns The stored assignment.
 */
export async function createEnterpriseMemberRoleAssignment(
  accessToken: string,
  input: CreateEnterpriseMemberRoleAssignmentInput,
  mutationContext: MutationRequestContext,
): Promise<EnterpriseMemberRoleAssignment> {
  const data = await sendMemberRoleAssignmentRequest(
    '/enterprise/security/role-assignments',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )
  const assignment = isRecord(data) ? data.assignment : undefined
  if (!isEnterpriseMemberRoleAssignment(assignment)) {
    throw createMalformedResponseError()
  }
  return assignment
}

/**
 * Removes a role assigned directly to a Workspace member.
 *
 * @param accessToken - Access token of the administrator.
 * @param assignment - Assignment to remove.
 * @param mutationContext - Idempotency and audit headers of the mutation.
 */
export async function deleteEnterpriseMemberRoleAssignment(
  accessToken: string,
  assignment: EnterpriseMemberRoleAssignment,
  mutationContext: MutationRequestContext,
): Promise<void> {
  await sendMemberRoleAssignmentRequest(
    `/enterprise/security/role-assignments/${encodeURIComponent(assignment.id)}`,
    accessToken,
    {
      body: JSON.stringify({}),
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )
}

/**
 * Validates one member role assignment from the API.
 *
 * @param value - Untrusted response value.
 * @returns Whether the value is a member role assignment.
 */
export function isEnterpriseMemberRoleAssignment(
  value: unknown,
): value is EnterpriseMemberRoleAssignment {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Boolean(value.id) &&
    typeof value.memberKey === 'string' &&
    Boolean(value.memberKey) &&
    typeof value.roleId === 'string' &&
    Boolean(value.roleId) &&
    (value.scopeType === 'workspace' ||
      value.scopeType === 'team' ||
      value.scopeType === 'project') &&
    typeof value.scopeId === 'string' &&
    (value.scopeParentId === undefined || typeof value.scopeParentId === 'string')
  )
}

/**
 * Validates one assignable member from the API.
 *
 * @param value - Untrusted response value.
 * @returns Whether the value is an assignable member.
 */
export function isEnterpriseAssignableMember(
  value: unknown,
): value is EnterpriseAssignableMember {
  return (
    isRecord(value) &&
    typeof value.memberKey === 'string' &&
    Boolean(value.memberKey) &&
    typeof value.email === 'string' &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.role === 'owner' ||
      value.role === 'admin' ||
      value.role === 'member' ||
      value.role === 'guest')
  )
}

/**
 * Sends one member role assignment request and maps API errors.
 *
 * @param path - API path below the enterprise identity base URL.
 * @param accessToken - Access token of the administrator.
 * @param init - Fetch options.
 * @returns The parsed JSON body, or an empty object for an empty body.
 */
async function sendMemberRoleAssignmentRequest(
  path: string,
  accessToken: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetch(`${enterpriseSecurityApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const text = await response.text()
  let data: unknown = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      throw createMalformedResponseError()
    }
  }

  if (!response.ok) {
    throw new EnterpriseSecurityApiError(
      response.status,
      isRecord(data) && typeof data.message === 'string'
        ? data.message
        : 'Enterprise security request failed.',
      isRecord(data) && typeof data.code === 'string' ? data.code : undefined,
    )
  }

  return data
}

/**
 * Creates the error used when the API response does not match the contract.
 *
 * @returns The malformed response error.
 */
function createMalformedResponseError() {
  return new EnterpriseSecurityApiError(
    502,
    'Enterprise security API returned an invalid response.',
    'EnterpriseSecurityInvalidResponse',
  )
}
