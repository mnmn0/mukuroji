import type {
  PlanningEntityType,
  WorkspaceMemberMfaStatus,
  WorkspaceMemberOffboarding,
  WorkspaceMemberOffboardingCredential,
  WorkspaceMemberOffboardingProject,
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

export type {
  WorkspaceMemberMfaStatus,
  WorkspaceMemberOffboarding,
  WorkspaceMemberOffboardingCredential,
  WorkspaceMemberPasswordResetAvailability,
  WorkspaceMemberSignInSecurity,
}

/** Sign-in action an admin takes for a member who cannot sign in. */
export type WorkspaceMemberCredentialAction = 'password-reset' | 'mfa-reset'

const workspaceApiBaseUrl = resolveApiBaseUrl('workspace')
const memberMfaStatuses = new Set<string>(['enrolled', 'not-enrolled', 'sso', 'unknown'])
const planningEntityTypes = new Set<string>([
  'cycle',
  'milestone',
  'release',
  'phase',
  'goal',
  'initiative',
  'roadmap',
  'portfolio',
] satisfies PlanningEntityType[])
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
  return (await getWorkspaceMembersSignInSecurityReport(accessToken)).members
}

/** Sign-in security of the active members, with who is a system administrator. */
export type WorkspaceMembersSignInSecurityReport = {
  /** Sign-in security of each active member. */
  members: WorkspaceMemberSignInSecurity[]
  /** Member keys of the system administrators, absent when the API could not read them. */
  systemAdministratorMemberKeys?: string[]
  /** Whether the API reported that it could not read the system administrators. */
  systemAdministratorsLoadFailed: boolean
}

/**
 * Reads each active member's sign-in security and which members are system administrators.
 *
 * Only owners and admins can call it.
 *
 * @param accessToken - Access token of the session.
 * @returns The members' sign-in security and the system administrators.
 */
export async function getWorkspaceMembersSignInSecurityReport(
  accessToken: string,
): Promise<WorkspaceMembersSignInSecurityReport> {
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
  const systemAdministrators = typeof data === 'object' && data !== null &&
    'systemAdministratorMemberKeys' in data
    ? data.systemAdministratorMemberKeys
    : undefined
  const systemAdministratorsLoadFailed = typeof data === 'object' && data !== null &&
    'systemAdministratorsUnavailable' in data && data.systemAdministratorsUnavailable === true
  return {
    systemAdministratorsLoadFailed,
    members: members.flatMap((member: unknown) => {
      const parsed = parseMemberSignInSecurity(member)
      return parsed ? [parsed] : []
    }),
    ...(Array.isArray(systemAdministrators)
      ? {
          systemAdministratorMemberKeys: systemAdministrators.filter(
            (memberKey: unknown): memberKey is string => typeof memberKey === 'string',
          ),
        }
      : {}),
  }
}

/**
 * Grants or revokes system administrator access for a member. Owners only.
 *
 * The API records the change in the audit log before it changes the Cognito group.
 *
 * @param accessToken - Access token of the session.
 * @param memberKey - Member to change.
 * @param systemAdministrator - Whether the member should be a system administrator.
 * @param mutationContext - Idempotency and correlation headers.
 */
export async function setWorkspaceMemberSystemAdministrator(
  accessToken: string,
  memberKey: string,
  systemAdministrator: boolean,
  mutationContext: MutationRequestContext,
): Promise<void> {
  await sendWorkspaceAccessRequest<unknown>(
    `/workspace/members/${encodeURIComponent(memberKey)}/system-administrator`,
    accessToken,
    {
      body: JSON.stringify({ systemAdministrator }),
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  )
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
 * Reads what a member manages, owns, or created, so it can be handed over before deactivation.
 *
 * Only owners and admins can call it.
 *
 * @param accessToken - Access token of the session.
 * @param memberKey - Member who is leaving.
 * @returns The handover summary.
 * @throws WorkspaceAccessApiError when the request fails or the response cannot be read.
 */
export async function getWorkspaceMemberOffboarding(
  accessToken: string,
  memberKey: string,
): Promise<WorkspaceMemberOffboarding> {
  const data = await sendWorkspaceAccessRequest<unknown>(
    `/workspace/members/${encodeURIComponent(memberKey)}/offboarding`,
    accessToken,
  )
  const offboarding = parseMemberOffboarding(data)
  if (!offboarding) {
    throw new WorkspaceAccessApiError(502, 'workspace.access.error.operation')
  }
  return offboarding
}

/**
 * Sets or clears the time a member's access ends.
 *
 * @param accessToken - Access token of the session.
 * @param memberKey - Member whose access is limited.
 * @param input - New expiry as an ISO 8601 timestamp, or null to clear it, and the member version it was read at.
 * @param mutationContext - Idempotency and correlation headers.
 * @returns The updated member.
 */
export async function updateWorkspaceMemberAccessExpiry(
  accessToken: string,
  memberKey: string,
  input: { accessExpiresAt: string | null; expectedVersion: number },
  mutationContext: MutationRequestContext,
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceMemberResponse>(
    `/workspace/members/${encodeURIComponent(memberKey)}/access-expiry`,
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
 * Revokes every API key and OAuth application a member created.
 *
 * @param accessToken - Access token of the session.
 * @param memberKey - Member whose credentials stop working.
 * @param mutationContext - Idempotency and correlation headers.
 */
export async function revokeWorkspaceMemberCredentials(
  accessToken: string,
  memberKey: string,
  mutationContext: MutationRequestContext,
): Promise<void> {
  await sendWorkspaceAccessRequest<unknown>(
    `/workspace/members/${encodeURIComponent(memberKey)}/credentials/revoke`,
    accessToken,
    {
      body: '{}',
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )
}

/**
 * Validates the offboarding summary the API returned.
 *
 * @param value - Response body.
 * @returns The summary, or undefined when it is malformed.
 */
function parseMemberOffboarding(value: unknown): WorkspaceMemberOffboarding | undefined {
  if (
    !isRecord(value) ||
    typeof value.memberKey !== 'string' ||
    (value.accessExpiresAt !== undefined && typeof value.accessExpiresAt !== 'string') ||
    typeof value.accessExpired !== 'boolean' ||
    typeof value.planningRevision !== 'number' ||
    typeof value.managesPrivateDocuments !== 'boolean' ||
    typeof value.canDeactivate !== 'boolean' ||
    !Array.isArray(value.managedProjects) ||
    !Array.isArray(value.ownedPlanningEntities) ||
    !Array.isArray(value.credentials) ||
    !Array.isArray(value.webhooks)
  ) {
    return undefined
  }
  // One malformed element fails the whole summary, so it is not shown as an empty list.
  const managedProjects = parseEvery(value.managedProjects, (project): WorkspaceMemberOffboardingProject | undefined =>
    isRecord(project) &&
    typeof project.projectId === 'string' &&
    (project.teamId === undefined || typeof project.teamId === 'string') &&
    (project.name === undefined || typeof project.name === 'string')
      ? {
          projectId: project.projectId,
          ...(typeof project.teamId === 'string' ? { teamId: project.teamId } : {}),
          ...(typeof project.name === 'string' ? { name: project.name } : {}),
        }
      : undefined
  )
  const ownedPlanningEntities = parseEvery(value.ownedPlanningEntities, (entity) =>
    isRecord(entity) &&
    typeof entity.id === 'string' &&
    typeof entity.title === 'string' &&
    isPlanningEntityType(entity.type)
      ? { id: entity.id, type: entity.type, title: entity.title }
      : undefined
  )
  const credentials = parseEvery(value.credentials, (credential): WorkspaceMemberOffboardingCredential | undefined => {
    if (!isRecord(credential) || typeof credential.id !== 'string' || typeof credential.name !== 'string') {
      return undefined
    }
    const kind = credential.kind === 'api-key' || credential.kind === 'oauth-app' ? credential.kind : undefined
    return kind ? { id: credential.id, kind, name: credential.name } : undefined
  })
  const webhooks = parseEvery(value.webhooks, (webhook) =>
    isRecord(webhook) && typeof webhook.id === 'string' && typeof webhook.name === 'string'
      ? { id: webhook.id, name: webhook.name }
      : undefined
  )
  if (!managedProjects || !ownedPlanningEntities || !credentials || !webhooks) return undefined
  return {
    memberKey: value.memberKey,
    ...(typeof value.accessExpiresAt === 'string' ? { accessExpiresAt: value.accessExpiresAt } : {}),
    accessExpired: value.accessExpired,
    managedProjects,
    ownedPlanningEntities,
    planningRevision: value.planningRevision,
    managesPrivateDocuments: value.managesPrivateDocuments,
    credentials,
    webhooks,
    canDeactivate: value.canDeactivate,
  }
}

/**
 * Parses every element of a list, failing the whole list when one element is malformed.
 *
 * @param values - Untrusted list elements.
 * @param parse - Parser of one element; undefined marks it malformed.
 * @returns The parsed elements, or undefined when any element is malformed.
 */
function parseEvery<T>(values: readonly unknown[], parse: (value: unknown) => T | undefined): T[] | undefined {
  const parsed: T[] = []
  for (const value of values) {
    const element = parse(value)
    if (element === undefined) return undefined
    parsed.push(element)
  }
  return parsed
}

/**
 * Narrows a value to a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Narrows a value to a Planning entity type.
 *
 * @param value - Value to check.
 * @returns Whether the value is a known type.
 */
function isPlanningEntityType(value: unknown): value is PlanningEntityType {
  return typeof value === 'string' && planningEntityTypes.has(value)
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
