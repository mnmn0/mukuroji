import type {
  WorkspaceMemberMfaStatus,
  WorkspaceMemberPasswordResetAvailability,
  WorkspaceMemberSignInSecurity,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type { WorkspaceMember, WorkspaceMemberStatus, WorkspaceRole } from './access'
import { WorkspaceAccessApiError } from './errors'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

/**
 * Workspace member 更新 API の入力です。
 */
export type UpdateWorkspaceMemberInput = {
  /**
   * 更新後の Workspace role です。
   */
  role?: WorkspaceRole
  /**
   * 更新後の member status です。
   */
  status?: WorkspaceMemberStatus
  /**
   * 更新対象を読み込んだ時点の version です。
   */
  expectedVersion: number
}

/**
 * Workspace access API が member mutation 後に返す response body です。
 */
type WorkspaceMemberResponse = {
  /**
   * 更新された member です。
   */
  member: WorkspaceMember
}

export type { WorkspaceMemberMfaStatus, WorkspaceMemberPasswordResetAvailability, WorkspaceMemberSignInSecurity }

/** Sign-in action an admin takes for a member who cannot sign in. */
export type WorkspaceMemberCredentialAction = 'password-reset' | 'mfa-reset'

const workspaceApiBaseUrl = resolveApiBaseUrl('workspace')
const memberMfaStatuses = new Set<string>(['enrolled', 'not-enrolled', 'sso', 'unknown'])
const passwordResetAvailabilities = new Set<string>([
  'available',
  'invitation-pending',
  'sso',
  'unavailable',
])

/**
 * Workspace member の role または利用状態を version 付きで更新します。
 */
export async function updateWorkspaceMember(
  accessToken: string,
  memberKey: string,
  input: UpdateWorkspaceMemberInput,
  mutationContext: MutationRequestContext,
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceMemberResponse>(
    `/workspace/members/${encodeURIComponent(memberKey)}`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PATCH',
    },
  )

  return response.member
}

/**
 * Corrects a member's display name as a Workspace administrator.
 *
 * @param accessToken - Access token of the session.
 * @param memberKey - Member to rename.
 * @param input - New name (null removes it) and the member version it was read at.
 * @param mutationContext - Idempotency context of the request.
 * @returns The updated member.
 */
export async function updateWorkspaceMemberName(
  accessToken: string,
  memberKey: string,
  input: { name: string | null; expectedVersion: number },
  mutationContext: MutationRequestContext,
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceMemberResponse>(
    `/workspace/members/${encodeURIComponent(memberKey)}/name`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  )

  return response.member
}

/**
 * Reads each active member's MFA enrollment and whether a password reset can be sent.
 *
 * Only owners and admins can call it.
 *
 * @param accessToken - Access token of the session.
 * @returns Sign-in security keyed by member key.
 */
export async function getWorkspaceMembersSignInSecurity(
  accessToken: string,
): Promise<WorkspaceMemberSignInSecurity[]> {
  const data = await sendWorkspaceAccessRequest<unknown>(
    '/workspace/members/sign-in-security',
    accessToken,
  )
  const members = typeof data === 'object' && data !== null && 'members' in data
    ? data.members
    : undefined
  if (!Array.isArray(members)) {
    throw new WorkspaceAccessApiError(502, 'workspace.access.error.operation')
  }
  return members.flatMap((member: unknown) => {
    const parsed = parseMemberSignInSecurity(member)
    return parsed ? [parsed] : []
  })
}

/**
 * Sends a password reset code to a member, or resets the member's authenticator app.
 *
 * The API records the action in the audit log before it changes the account.
 *
 * @param accessToken - Access token of the session.
 * @param memberKey - Member to act on.
 * @param action - Which credential to reset.
 * @param mutationContext - Idempotency and correlation headers.
 */
export async function resetWorkspaceMemberCredential(
  accessToken: string,
  memberKey: string,
  action: WorkspaceMemberCredentialAction,
  mutationContext: MutationRequestContext,
): Promise<void> {
  await sendWorkspaceAccessRequest<unknown>(
    `/workspace/members/${encodeURIComponent(memberKey)}/${action}`,
    accessToken,
    {
      body: '{}',
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )
}

/**
 * Validates one member's sign-in security entry and drops entries the Web cannot read.
 *
 * @param value - Entry from the response.
 * @returns The entry, or undefined when malformed.
 */
function parseMemberSignInSecurity(value: unknown): WorkspaceMemberSignInSecurity | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('memberKey' in value) ||
    !('mfa' in value) ||
    !('passwordReset' in value) ||
    typeof value.memberKey !== 'string' ||
    !isMemberMfaStatus(value.mfa) ||
    !isPasswordResetAvailability(value.passwordReset)
  ) {
    return undefined
  }
  return { memberKey: value.memberKey, mfa: value.mfa, passwordReset: value.passwordReset }
}

/**
 * Narrows a value to a member MFA status.
 *
 * @param value - Value to check.
 * @returns Whether the value is a known status.
 */
function isMemberMfaStatus(value: unknown): value is WorkspaceMemberMfaStatus {
  return typeof value === 'string' && memberMfaStatuses.has(value)
}

/**
 * Narrows a value to a password reset availability.
 *
 * @param value - Value to check.
 * @returns Whether the value is a known availability.
 */
function isPasswordResetAvailability(
  value: unknown,
): value is WorkspaceMemberPasswordResetAvailability {
  return typeof value === 'string' && passwordResetAvailabilities.has(value)
}

async function sendWorkspaceAccessRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(`${workspaceApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    throw new WorkspaceAccessApiError(
      response.status,
      readErrorMessage(data),
      readErrorCode(data),
    )
  }

  return data as T
}

function readErrorCode(data: unknown) {
  return typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    typeof data.code === 'string'
    ? data.code
    : undefined
}

function readErrorMessage(data: unknown) {
  return typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string'
    ? data.message
    : 'workspace.access.error.operation'
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  return JSON.parse(text) as T
}
