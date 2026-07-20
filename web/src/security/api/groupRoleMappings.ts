import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { EnterpriseSecurityApiError } from './errors'

/**
 * Directory group mapping の適用 scope です。
 */
export type EnterpriseMappingScope = 'workspace' | 'team' | 'project'

/**
 * Directory group と mukuroji role の mapping です。
 */
export type EnterpriseGroupRoleMapping = {
  /** Mapping の一意な ID です。 */
  id: string
  /** Identity provider directory の group ID です。 */
  directoryGroupId: string
  /** Directory group を所有する identity provider ID です。 */
  identityProviderId: string
  /** 管理 UI に表示する directory group 名です。 */
  directoryGroupName: string
  /** Role を付与する scope 種別です。 */
  scopeType: EnterpriseMappingScope
  /** Workspace、Team、Project の ID です。 */
  scopeId: string
  /** 管理 UI に表示する scope 名です。 */
  scopeName: string
  /** Mapping によって付与する role ID です。 */
  roleId: string
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Directory group mapping 作成 API の入力です。
 */
export type CreateEnterpriseGroupRoleMappingInput = {
  /** Directory group を所有する identity provider ID です。 */
  identityProviderId: string
  /** Identity provider directory の group ID です。 */
  directoryGroupId: string
  /** 管理 UI に表示する directory group 名です。 */
  directoryGroupName: string
  /** Mapping の適用 scope です。 */
  scopeType: EnterpriseMappingScope
  /** Workspace、Team、Project の ID です。 */
  scopeId: string
  /** 管理 UI に表示する scope 名です。 */
  scopeName: string
  /** 付与する role ID です。 */
  roleId: string
}

/**
 * Directory group mapping 更新 API の入力です。
 */
export type UpdateEnterpriseGroupRoleMappingInput =
  CreateEnterpriseGroupRoleMappingInput & {
    /** 読み込み時点の version です。 */
    expectedVersion: number
  }

const enterpriseSecurityApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_ENTERPRISE_IDENTITY_API_BASE_URL ??
    import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Directory group role mapping を作成します。
 */
export function createEnterpriseGroupRoleMapping(
  accessToken: string,
  input: CreateEnterpriseGroupRoleMappingInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/group-mappings',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseGroupRoleMapping>(data, 'mapping'),
  )
}

/**
 * Directory group role mapping の scope または role を更新します。
 */
export function updateEnterpriseGroupRoleMapping(
  accessToken: string,
  mappingId: string,
  input: UpdateEnterpriseGroupRoleMappingInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/group-mappings/${encodeURIComponent(mappingId)}`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseGroupRoleMapping>(data, 'mapping'),
  )
}

/**
 * Directory group role mapping を削除します。
 */
export function deleteEnterpriseGroupRoleMapping(
  accessToken: string,
  mapping: EnterpriseGroupRoleMapping,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/group-mappings/${encodeURIComponent(mapping.id)}`,
    accessToken,
    {
      body: JSON.stringify({ expectedVersion: mapping.version }),
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )
}

async function sendEnterpriseSecurityRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(`${enterpriseSecurityApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    throw new EnterpriseSecurityApiError(
      response.status,
      readErrorMessage(data),
      readErrorCode(data),
    )
  }

  return data as T
}

function readResponseProperty<T>(
  data: unknown,
  property: string,
): T {
  if (!isRecord(data) || !(property in data) || !isRecord(data[property])) {
    throw createMalformedResponseError()
  }

  return data[property] as T
}

function createMalformedResponseError() {
  return new EnterpriseSecurityApiError(
    502,
    'Enterprise security API returned an invalid response.',
    'EnterpriseSecurityInvalidResponse',
  )
}

function readErrorCode(data: unknown) {
  return isRecord(data) && typeof data.code === 'string'
    ? data.code
    : undefined
}

function readErrorMessage(data: unknown) {
  return isRecord(data) && typeof data.message === 'string'
    ? data.message
    : 'Enterprise security request failed.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw createMalformedResponseError()
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
