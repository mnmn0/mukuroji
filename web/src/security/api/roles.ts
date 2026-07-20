import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { EnterpriseSecurityApiError } from './errors'

/**
 * 現在の principal が用途・scope ごとに割り当て可能な role ID 一覧です。
 */
export type EnterpriseAssignableRoleIds = {
  /** Directory group mapping で scope ごとに選択可能な role ID です。 */
  groupMappings: {
    /** Workspace scope へ割り当て可能な role ID です。 */
    workspace: string[]
    /** Team scope へ割り当て可能な role ID です。 */
    team: string[]
    /** Project scope へ割り当て可能な role ID です。 */
    project: string[]
  }
  /** Workspace-scoped service account へ割り当て可能な role ID です。 */
  serviceAccounts: string[]
}

/**
 * Permission matrix の一つの permission definition です。
 */
export type EnterprisePermissionDefinition = {
  /** Permission の安定した ID です。 */
  id: string
  /** Permission をまとめる group ID です。 */
  group: 'workspace' | 'members' | 'content' | 'security' | 'automation'
  /** UI に表示する短い名称です。 */
  name: string
  /** Permission の影響を示す説明です。 */
  description: string
  /** Break-glass 以外へ付与できない permission かどうかです。 */
  privileged: boolean
}

/**
 * Workspace、Team、Project へ割り当てられる role definition です。
 */
export type EnterpriseRoleDefinition = {
  /** Role の安定した ID です。 */
  id: string
  /** 管理 UI に表示する role 名です。 */
  name: string
  /** Role の用途を示す説明です。 */
  description: string
  /** Built-in role か custom role かを表します。 */
  kind: 'built-in' | 'custom'
  /** Role に含まれる permission ID 一覧です。 */
  permissionIds: string[]
  /** Guest principal へこの role を割り当てられるかどうかです。 */
  guestAssignable: boolean
  /** 現在この role を持つ principal 件数です。 */
  assignmentCount: number
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Custom role 作成 API の入力です。
 */
export type CreateEnterpriseRoleInput = {
  /** Custom role の名称です。 */
  name: string
  /** Custom role の説明です。 */
  description: string
  /** Custom role に含める permission ID 一覧です。 */
  permissionIds: string[]
  /** Guest principal へこの role を割り当てられるかどうかです。 */
  guestAssignable: boolean
}

/**
 * Custom role 更新 API の入力です。
 */
export type UpdateEnterpriseRoleInput = {
  /** Custom role の名称です。 */
  name: string
  /** Custom role の説明です。 */
  description: string
  /** Custom role に含める permission ID 一覧です。 */
  permissionIds: string[]
  /** Guest principal へこの role を割り当てられるかどうかです。 */
  guestAssignable: boolean
  /** 読み込み時点の version です。 */
  expectedVersion: number
  /** Assignment impact を確認済みであることを示す短時間 token です。 */
  impactConfirmationToken?: string
}

/**
 * Custom role 更新・削除前の assignment impact preview 入力です。
 */
export type PreviewEnterpriseRoleImpactInput = {
  /** 読み込み時点の role version です。 */
  expectedVersion: number
  /** 更新後の permission ID 一覧です。 */
  permissionIds?: string[]
  /** 更新後に Guest principal へ割り当て可能かどうかです。 */
  guestAssignable?: boolean
  /** Role 削除の impact を確認するかどうかです。 */
  delete?: boolean
}

/**
 * Custom role 更新・削除が既存割り当てへ与える影響です。
 */
export type EnterpriseRoleImpact = {
  /** 直接 role assignment されている principal 数です。 */
  assignmentCount: number
  /** この role を参照する directory group mapping 数です。 */
  mappingCount: number
  /** この role を参照する active service account 数です。 */
  serviceAccountCount: number
  /** 更新により失われる permission ID 一覧です。 */
  removedPermissionIds: string[]
  /** 影響が解消されるまで操作を適用できないかどうかです。 */
  blocking: boolean
  /** 管理者が確認すべき安全上の警告です。 */
  warnings: string[]
  /** Blocking でない preview を PUT/DELETE へ渡す短時間 token です。 */
  confirmationToken?: string
}

const enterpriseSecurityApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_ENTERPRISE_IDENTITY_API_BASE_URL ??
    import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Custom role を作成します。
 */
export function createEnterpriseRole(
  accessToken: string,
  input: CreateEnterpriseRoleInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/roles',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then((data) => readResponseProperty<EnterpriseRoleDefinition>(data, 'role'))
}

/**
 * Custom role の permission set を更新します。
 */
export function updateEnterpriseRole(
  accessToken: string,
  roleId: string,
  input: UpdateEnterpriseRoleInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/roles/${encodeURIComponent(roleId)}`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  ).then((data) => readResponseProperty<EnterpriseRoleDefinition>(data, 'role'))
}

/**
 * Custom role 更新・削除前の assignment impact を mutation なしで確認します。
 */
export function previewEnterpriseRoleImpact(
  accessToken: string,
  roleId: string,
  input: PreviewEnterpriseRoleImpactInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/roles/${encodeURIComponent(roleId)}/impact`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseRoleImpact)
}

/**
 * 未使用の custom role を削除します。
 */
export function deleteEnterpriseRole(
  accessToken: string,
  role: EnterpriseRoleDefinition,
  impactConfirmationToken: string,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/roles/${encodeURIComponent(role.id)}`,
    accessToken,
    {
      body: JSON.stringify({
        expectedVersion: role.version,
        impactConfirmationToken,
      }),
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

function parseEnterpriseRoleImpact(data: unknown): EnterpriseRoleImpact {
  if (!isRecord(data) || !isRecord(data.impact)) {
    throw createMalformedResponseError()
  }

  const impact = data.impact
  if (
    !Number.isSafeInteger(impact.assignmentCount) ||
    Number(impact.assignmentCount) < 0 ||
    !Number.isSafeInteger(impact.mappingCount) ||
    Number(impact.mappingCount) < 0 ||
    (impact.serviceAccountCount !== undefined &&
      (!Number.isSafeInteger(impact.serviceAccountCount) ||
        Number(impact.serviceAccountCount) < 0)) ||
    !Array.isArray(impact.removedPermissionIds) ||
    !impact.removedPermissionIds.every(
      (permissionId) => typeof permissionId === 'string',
    ) ||
    typeof impact.blocking !== 'boolean' ||
    (impact.warnings !== undefined &&
      (!Array.isArray(impact.warnings) ||
        !impact.warnings.every((warning) => typeof warning === 'string'))) ||
    (impact.confirmationToken !== undefined &&
      typeof impact.confirmationToken !== 'string') ||
    (!impact.blocking &&
      (typeof impact.confirmationToken !== 'string' ||
        !impact.confirmationToken))
  ) {
    throw createMalformedResponseError()
  }

  return {
    ...impact,
    serviceAccountCount:
      typeof impact.serviceAccountCount === 'number'
        ? impact.serviceAccountCount
        : 0,
    warnings: Array.isArray(impact.warnings) ? impact.warnings : [],
  } as EnterpriseRoleImpact
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
