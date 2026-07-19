import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../api/mutationHeaders'

/**
 * Enterprise security 管理 API が返す操作権限です。
 */
export type EnterpriseSecurityCapabilities = {
  /** Enterprise security の状態を閲覧できるかどうかです。 */
  canView: boolean
  /** Identity provider と domain policy を閲覧できるかどうかです。 */
  canViewIdentity: boolean
  /** SCIM provisioning と reconciliation を閲覧できるかどうかです。 */
  canViewProvisioning: boolean
  /** Group mapping、role、guest policy を閲覧できるかどうかです。 */
  canViewAccess: boolean
  /** MFA、session、IP policy を閲覧できるかどうかです。 */
  canViewSessions: boolean
  /** Service account と break-glass administrator を閲覧できるかどうかです。 */
  canViewPrivileged: boolean
  /** Identity provider と domain policy を変更できるかどうかです。 */
  canManageIdentity: boolean
  /** SCIM provisioning と reconciliation を操作できるかどうかです。 */
  canManageProvisioning: boolean
  /** Group mapping、custom role、guest policy を変更できるかどうかです。 */
  canManageAccess: boolean
  /** Directory group mapping を変更できるかどうかです。 */
  canManageMappings: boolean
  /** Custom role と permission set を変更できるかどうかです。 */
  canManageRoles: boolean
  /** MFA、session、IP policy を変更できるかどうかです。 */
  canManageSessions: boolean
  /** Service account を変更できるかどうかです。 */
  canManagePrivilegedAccess: boolean
  /** Break-glass administrator を変更できるかどうかです。 */
  canManageBreakGlass: boolean
}

/**
 * Workspace に設定できる enterprise identity provider protocol です。
 */
export type EnterpriseIdentityProtocol = 'saml' | 'oidc'

/**
 * Enterprise identity provider の接続状態です。
 */
export type EnterpriseIdentityProviderStatus =
  | 'not-configured'
  | 'draft'
  | 'verified'
  | 'error'

/**
 * SAML/OIDC identity provider の保存済み設定です。
 */
export type EnterpriseIdentityProvider = {
  /** Provider binding に使用する identity provider ID です。 */
  id: string
  /** Identity provider の接続状態です。 */
  status: EnterpriseIdentityProviderStatus
  /** 設定済み protocol です。 */
  protocol: EnterpriseIdentityProtocol
  /** 管理者向け表示名です。 */
  displayName: string
  /** SAML entity ID または OIDC issuer URL です。 */
  issuer: string
  /** Login redirect で使用する SSO URL です。 */
  ssoUrl: string
  /** OIDC client ID または SAML audience です。 */
  clientId: string
  /** SAML metadata XML を取得して署名設定を検証する HTTPS URL です。 */
  metadataUrl?: string
  /** 接続テストが最後に成功したかどうかです。 */
  lastTestSucceeded: boolean
  /** 最後に接続テストを実行した ISO 8601 timestamp です。 */
  lastTestedAt?: string
  /** Managed domain に SSO login を強制するかどうかです。 */
  enforced: boolean
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Workspace が所有を確認する domain の状態です。
 */
export type EnterpriseDomainStatus = 'pending' | 'verified' | 'conflict'

/**
 * Enterprise login policy に使用する domain claim です。
 */
export type EnterpriseDomainClaim = {
  /** Domain claim の一意な ID です。 */
  id: string
  /** 小文字へ正規化された domain 名です。 */
  domain: string
  /** Domain ownership の確認状態です。 */
  status: EnterpriseDomainStatus
  /** DNS TXT record を設定する record name です。 */
  verificationRecordName: string
  /** Domain ownership を確認した ISO 8601 timestamp です。 */
  verifiedAt?: string
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Domain claim 作成時に一度だけ返す DNS verification challenge です。
 */
export type EnterpriseDomainVerificationChallenge = {
  /** 作成された domain claim です。 */
  domain: EnterpriseDomainClaim
  /** DNS TXT record に設定し、一度だけ表示する verification value です。 */
  verificationRecordValue: string
}

/**
 * SCIM directory connection の状態です。
 */
export type EnterpriseScimStatus = 'disabled' | 'ready' | 'syncing' | 'error'

/**
 * SCIM user/group provisioning の接続情報です。
 */
export type EnterpriseScimConfiguration = {
  /** SCIM credential を関連付ける identity provider ID です。 */
  identityProviderId: string
  /** SCIM connection の現在状態です。 */
  status: EnterpriseScimStatus
  /** Identity provider が呼び出す SCIM base URL です。 */
  endpointUrl: string
  /** 現在の bearer token generation です。 */
  tokenGeneration: number
  /** 保存済み bearer token の末尾4文字です。 */
  tokenLastFour?: string
  /** 最後に同期が成功した ISO 8601 timestamp です。 */
  lastSyncAt?: string
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Provisioning operation の状態です。
 */
export type EnterpriseProvisioningLogStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'

/**
 * SCIM または reconciliation operation の安全な表示履歴です。
 */
export type EnterpriseProvisioningLog = {
  /** Provisioning log の一意な ID です。 */
  id: string
  /** 実行された operation 名です。 */
  operation: 'scim' | 'dry-run' | 'reconcile' | 'deprovision'
  /** Operation の現在状態です。 */
  status: EnterpriseProvisioningLogStatus
  /** 管理 UI に表示できる安全な要約です。 */
  summary: string
  /** Operation が開始された ISO 8601 timestamp です。 */
  createdAt: string
  /** Operation が完了した ISO 8601 timestamp です。 */
  completedAt?: string
  /** 同じ logical operation を再試行できるかどうかです。 */
  retryable: boolean
  /** Audit event と照合する correlation ID です。 */
  correlationId?: string
  /** 現在までの試行回数です。 */
  attempts: number
}

/**
 * Reconciliation dry-run が返す変更件数です。
 */
export type EnterpriseProvisioningImpactCounts = {
  /** 新規作成する user 件数です。 */
  usersCreated: number
  /** 属性または role を更新する user 件数です。 */
  usersUpdated: number
  /** 利用停止する user 件数です。 */
  usersDeactivated: number
  /** 新規作成する group 件数です。 */
  groupsCreated: number
  /** 更新する group 件数です。 */
  groupsUpdated: number
  /** 失効させる session/token 件数です。 */
  sessionsRevoked: number
}

/**
 * Reconciliation または deprovision の適用前 preview です。
 */
export type EnterpriseProvisioningImpact = {
  /** Apply API に渡す一回限りの preview ID です。 */
  previewId: string
  /** Preview が失効する ISO 8601 timestamp です。 */
  expiresAt: string
  /** Apply 時に発生する変更件数です。 */
  counts: EnterpriseProvisioningImpactCounts
  /** 管理者が確認すべき warning 文言です。 */
  warnings: string[]
  /** Preview が差分を含むかどうかです。 */
  hasChanges: boolean
  /** 保護対象への影響により Apply を禁止するかどうかです。 */
  blocking: boolean
}

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
 * MFA、session、IP、guest/external collaborator policy です。
 */
export type EnterpriseSessionPolicy = {
  /** Human member に MFA を必須とするかどうかです。 */
  mfaRequired: boolean
  /** Interactive session lifetime の分数です。 */
  sessionLifetimeMinutes: number
  /** User activity がない session を終了するまでの分数です。 */
  idleTimeoutMinutes: number
  /** 通常 session で再認証を求める経過分数です。 */
  reauthenticationMinutes: number
  /** Sensitive operation で再認証を求める経過分数です。 */
  sensitiveActionReauthenticationMinutes: number
  /** Workspace access を許可する CIDR 一覧です。 */
  ipAllowlist: string[]
  /** Guest/external collaborator を許可するかどうかです。 */
  guestsAllowed: boolean
  /** Verified domain 外の member collaborator を許可するかどうかです。 */
  externalCollaboratorsAllowed: boolean
  /** Guest interactive session の最大有効時間（分）です。 */
  guestSessionLifetimeMinutes: number
  /** Guest として許可する email domain 一覧です。 */
  allowedGuestDomains: string[]
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Service account の lifecycle 状態です。
 */
export type EnterpriseServiceAccountStatus = 'active' | 'revoked'

/**
 * Interactive user と分離して管理する service account です。
 */
export type EnterpriseServiceAccount = {
  /** Service account の一意な ID です。 */
  id: string
  /** 管理 UI に表示する名称です。 */
  name: string
  /** Service account の lifecycle 状態です。 */
  status: EnterpriseServiceAccountStatus
  /** 付与されている role ID です。 */
  roleId: string
  /** Credential がアクセスできる resource scope の種類です。 */
  scopeType: 'workspace' | 'team' | 'project'
  /** Team/Project scope の ID です。 */
  scopeId?: string
  /** Rotate 後も維持する credential lifetime policy の日数です。 */
  credentialLifetimeDays: number
  /** Current/last credential が失効する ISO 8601 timestamp です。 */
  credentialExpiresAt?: string
  /** Credential の利用を許可する source CIDR 一覧です。 */
  allowedSourceCidrs: string[]
  /** Credential generation です。 */
  credentialGeneration: number
  /** 最後に API access した ISO 8601 timestamp です。 */
  lastUsedAt?: string
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Break-glass administrator の lifecycle 状態です。
 */
export type EnterpriseBreakGlassStatus = 'active' | 'disabled'

/**
 * 通常の IdP login から分離した break-glass administrator です。
 */
export type EnterpriseBreakGlassAdministrator = {
  /** Break-glass administrator の一意な ID です。 */
  id: string
  /** Login に使用する email address です。 */
  email: string
  /** Break-glass account の lifecycle 状態です。 */
  status: EnterpriseBreakGlassStatus
  /** MFA enrollment が完了しているかどうかです。 */
  mfaConfigured: boolean
  /** 最後に access test を完了した ISO 8601 timestamp です。 */
  lastTestedAt?: string
  /** 最後に利用した ISO 8601 timestamp です。 */
  lastUsedAt?: string
  /** 同時更新検知に使用する version です。 */
  version: number
}

/**
 * Current member に有効な短時間 recovery elevation です。
 */
export type EnterpriseActiveBreakGlassActivation = {
  /** Recovery elevation が自動失効する ISO 8601 timestamp です。 */
  expiresAt: string
}

/**
 * SSO enforcement の非機密 prerequisite 状態です。
 */
export type EnterpriseSsoPrerequisites = {
  /** 接続テスト済み identity provider が存在するかどうかです。 */
  providerReady: boolean
  /** 所有権確認済み domain が存在するかどうかです。 */
  domainReady: boolean
  /** MFA 確認済み break-glass login 経路が存在するかどうかです。 */
  breakGlassReady: boolean
}

/**
 * Enterprise identity と security policy の管理 snapshot です。
 */
export type EnterpriseSecuritySnapshot = {
  /** ログイン中 principal の管理 capability です。 */
  capabilities: EnterpriseSecurityCapabilities
  /** 用途・scope ごとに割り当て可能な role ID です。 */
  assignableRoleIds: EnterpriseAssignableRoleIds
  /** Current principal が custom role へ付与できる permission ID です。 */
  assignablePermissionIds: string[]
  /** SAML/OIDC identity provider 設定です。 */
  identityProvider: EnterpriseIdentityProvider
  /** SSO enforcement の非機密 prerequisite 状態です。 */
  ssoPrerequisites: EnterpriseSsoPrerequisites
  /** Workspace が claim している domain 一覧です。 */
  domains: EnterpriseDomainClaim[]
  /** SCIM connection 設定です。 */
  scim: EnterpriseScimConfiguration
  /** Provisioning operation の新しい順履歴です。 */
  provisioningLogs: EnterpriseProvisioningLog[]
  /** Directory group role mapping 一覧です。 */
  mappings: EnterpriseGroupRoleMapping[]
  /** Built-in/custom role 一覧です。 */
  roles: EnterpriseRoleDefinition[]
  /** Role editor で選べる permission catalog です。 */
  permissions: EnterprisePermissionDefinition[]
  /** MFA、session、IP、guest policy です。 */
  sessionPolicy: EnterpriseSessionPolicy
  /** Interactive user と分離した service account 一覧です。 */
  serviceAccounts: EnterpriseServiceAccount[]
  /** Break-glass administrator 一覧です。 */
  breakGlassAdministrators: EnterpriseBreakGlassAdministrator[]
  /** Server が確認した current member の有効な recovery elevation です。 */
  activeBreakGlassActivation?: EnterpriseActiveBreakGlassActivation
}

/**
 * Identity provider 設定更新 API の入力です。
 */
export type UpdateEnterpriseIdentityProviderInput = {
  /** 更新する protocol です。 */
  protocol: EnterpriseIdentityProtocol
  /** 管理者向け表示名です。 */
  displayName: string
  /** SAML entity ID または OIDC issuer URL です。 */
  issuer: string
  /** Login redirect に使用する SSO URL です。 */
  ssoUrl: string
  /** OIDC client ID または SAML audience です。 */
  clientId: string
  /** SAML metadata XML を取得して署名設定を検証する HTTPS URL です。 */
  metadataUrl: string
  /** 読み込み時点の version です。 */
  expectedVersion: number
}

/**
 * SSO enforcement 更新 API の入力です。
 */
export type UpdateEnterpriseSsoEnforcementInput = {
  /** Managed domain に SSO を強制するかどうかです。 */
  enforced: boolean
  /** 読み込み時点の identity provider version です。 */
  expectedVersion: number
}

/**
 * Domain claim 作成 API の入力です。
 */
export type CreateEnterpriseDomainClaimInput = {
  /** Claim する domain 名です。 */
  domain: string
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

/**
 * Session/security policy 更新 API の入力です。
 */
export type UpdateEnterpriseSessionPolicyInput = {
  /** Human member に MFA を必須とするかどうかです。 */
  mfaRequired: boolean
  /** Interactive session lifetime の分数です。 */
  sessionLifetimeMinutes: number
  /** User activity がない session を終了するまでの分数です。 */
  idleTimeoutMinutes: number
  /** 通常 session の再認証 interval 分数です。 */
  reauthenticationMinutes: number
  /** Sensitive operation の再認証 interval 分数です。 */
  sensitiveActionReauthenticationMinutes: number
  /** Workspace access を許可する CIDR 一覧です。 */
  ipAllowlist: string[]
  /** Guest/external collaborator を許可するかどうかです。 */
  guestsAllowed: boolean
  /** Verified domain 外の member collaborator を許可するかどうかです。 */
  externalCollaboratorsAllowed: boolean
  /** Guest interactive session の最大有効時間（分）です。 */
  guestSessionLifetimeMinutes: number
  /** Guest として許可する email domain 一覧です。 */
  allowedGuestDomains: string[]
  /** 読み込み時点の version です。 */
  expectedVersion: number
  /** Caller IP を allowlist から除外する変更を確認済みであることを示す短時間 token です。 */
  callerIpConfirmationToken?: string
}

/**
 * Session/security policy の保存前 caller IP impact です。
 */
export type EnterpriseSessionPolicyImpact = {
  /** Server が信頼できる transport source から解決した caller IP です。 */
  callerIp?: string
  /** 更新後の allowlist が caller IP を許可するかどうかです。 */
  callerAllowed: boolean
  /** 保存前に明示確認が必要かどうかです。 */
  requiresConfirmation: boolean
  /** 管理者が確認すべき安全上の警告です。 */
  warnings: string[]
  /** Caller IP 除外を確認した場合だけ PUT へ渡す短時間 token です。 */
  confirmationToken?: string
}

/**
 * Service account 作成 API の入力です。
 */
export type CreateEnterpriseServiceAccountInput = {
  /** Service account の名称です。 */
  name: string
  /** Service account に付与する role ID です。 */
  roleId: string
  /** Credential がアクセスできる resource scope の種類です。 */
  scopeType: 'workspace' | 'team' | 'project'
  /** Team/Project scope の ID です。 */
  scopeId?: string
  /** Credential の有効期間（1〜365日）です。 */
  credentialLifetimeDays: number
  /** Credential の利用を許可する source CIDR 一覧です。 */
  allowedSourceCidrs: string[]
}

/**
 * Service account credential create/rotate response です。
 */
export type EnterpriseServiceAccountCredentialResponse = {
  /** 作成または更新した service account です。 */
  serviceAccount: EnterpriseServiceAccount
  /** Create/rotate response で一回だけ返す bearer token です。 */
  token: string
}

/**
 * SCIM token rotate response です。
 */
export type EnterpriseScimTokenResponse = {
  /** Rotate 後の SCIM configuration です。 */
  scim: EnterpriseScimConfiguration
  /** Rotate response で一回だけ返す bearer token です。 */
  token: string
}

/**
 * Break-glass administrator 事前登録 API の入力です。
 */
export type RegisterEnterpriseBreakGlassAdministratorInput = {
  /** Break-glass login に使用する email address です。 */
  email: string
}

/**
 * 現在の member が短時間の recovery access を開始するときの入力です。
 */
export type ActivateEnterpriseBreakGlassInput = {
  /** Audit log に保存する具体的な復旧理由です。 */
  reason: string
  /** Recovery access を有効にする分数です。 */
  durationMinutes: number
}

/**
 * Current member に発行された期限付き recovery access です。
 */
export type EnterpriseBreakGlassActivation = {
  /** Activation の一意な ID です。 */
  id: string
  /** 事前登録済み break-glass account の ID です。 */
  accountId: string
  /** Recovery access を開始した ISO 8601 timestamp です。 */
  startedAt: string
  /** Recovery access が自動終了する ISO 8601 timestamp です。 */
  expiresAt: string
}

/**
 * Break-glass administrator status 更新 API の入力です。
 */
export type UpdateEnterpriseBreakGlassAdministratorInput = {
  /** 更新後の lifecycle 状態です。 */
  status: EnterpriseBreakGlassStatus
  /** 読み込み時点の version です。 */
  expectedVersion: number
}

/**
 * Enterprise security API の失敗を status/code とともに保持する例外です。
 */
export class EnterpriseSecurityApiError extends Error {
  /** API response の HTTP status code です。 */
  readonly status: number
  /** API が返した分岐可能な error code です。 */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'EnterpriseSecurityApiError'
    this.status = status
    this.code = code
  }
}

const enterpriseSecurityApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_ENTERPRISE_IDENTITY_API_BASE_URL ??
    import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Enterprise identity と security policy の管理 snapshot を取得します。
 */
export function getEnterpriseSecuritySnapshot(
  accessToken: string,
  signal?: AbortSignal,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security',
    accessToken,
    { signal },
  ).then(parseEnterpriseSecuritySnapshot)
}

/**
 * Identity provider 設定を保存し、任意で接続テストを実行します。
 */
export function updateEnterpriseIdentityProvider(
  accessToken: string,
  input: UpdateEnterpriseIdentityProviderInput & {
    /** 保存時に接続テストも実行するかどうかです。 */
    testConnection?: boolean
  },
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/identity-provider',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseIdentityProvider>(data, 'identityProvider'),
  )
}

/**
 * Managed domain の SSO enforcement を更新します。
 */
export function updateEnterpriseSsoEnforcement(
  accessToken: string,
  input: UpdateEnterpriseSsoEnforcementInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/identity-provider',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseIdentityProvider>(data, 'identityProvider'),
  )
}

/**
 * Enterprise login に使用する domain claim を作成します。
 */
export function createEnterpriseDomainClaim(
  accessToken: string,
  input: CreateEnterpriseDomainClaimInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/domains',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseDomainVerificationChallenge)
}

/**
 * DNS record を再確認して domain ownership を検証します。
 */
export function verifyEnterpriseDomainClaim(
  accessToken: string,
  domain: string,
  expectedVersion: number,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/domains/${encodeURIComponent(domain)}/verify`,
    accessToken,
    {
      body: JSON.stringify({ expectedVersion }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then((data) => readResponseProperty<EnterpriseDomainClaim>(data, 'domain'))
}

/**
 * SCIM bearer token を発行または rotate します。
 */
export function rotateEnterpriseScimToken(
  accessToken: string,
  expectedVersion: number,
  identityProviderId: string,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/scim/token',
    accessToken,
    {
      body: JSON.stringify({
        expectedVersion,
        identityProviderId,
      }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseScimTokenResponse)
}

/**
 * Provisioning reconciliation の dry-run preview を作成します。
 */
export function previewEnterpriseProvisioning(
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/provisioning/preview',
    accessToken,
    {
      body: JSON.stringify({ mode: 'reconcile' }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseProvisioningImpact)
}

/**
 * 確認済み preview を使って provisioning reconciliation を適用します。
 */
export function reconcileEnterpriseProvisioning(
  accessToken: string,
  impact: EnterpriseProvisioningImpact,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/provisioning/reconcile',
    accessToken,
    {
      body: JSON.stringify({
        previewId: impact.previewId,
        previewExpiresAt: impact.expiresAt,
      }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )
}

/**
 * Provisioning operation log の新しい順一覧を取得します。
 */
export function getEnterpriseProvisioningLogs(
  accessToken: string,
  signal?: AbortSignal,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/provisioning/logs',
    accessToken,
    { signal },
  ).then((data) => {
    if (!isRecord(data) || !Array.isArray(data.logs)) {
      throw createMalformedResponseError()
    }

    return data.logs as EnterpriseProvisioningLog[]
  })
}

/**
 * Retry 可能な provisioning operation を再実行します。
 */
export function retryEnterpriseProvisioningLog(
  accessToken: string,
  logId: string,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/provisioning/logs/${encodeURIComponent(logId)}/retry`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )
}

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

/**
 * Session/security policy の caller IP impact を mutation なしで確認します。
 */
export function previewEnterpriseSessionPolicy(
  accessToken: string,
  input: UpdateEnterpriseSessionPolicyInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/policy/preview',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseSessionPolicyImpact)
}

/**
 * MFA、session、IP、guest policy を保存します。
 */
export function updateEnterpriseSessionPolicy(
  accessToken: string,
  input: UpdateEnterpriseSessionPolicyInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/policy',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseSessionPolicy>(data, 'policy'),
  )
}

/**
 * Service account と一回限りの credential を作成します。
 */
export function createEnterpriseServiceAccount(
  accessToken: string,
  input: CreateEnterpriseServiceAccountInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/service-accounts',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseServiceAccountCredentialResponse)
}

/**
 * Service account credential を rotate して一回だけ返します。
 */
export function rotateEnterpriseServiceAccountCredential(
  accessToken: string,
  serviceAccount: EnterpriseServiceAccount,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/service-accounts/${encodeURIComponent(serviceAccount.id)}/rotate`,
    accessToken,
    {
      body: JSON.stringify({ expectedVersion: serviceAccount.version }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseServiceAccountCredentialResponse)
}

/**
 * Service account とその credential を失効させます。
 */
export function revokeEnterpriseServiceAccount(
  accessToken: string,
  serviceAccount: EnterpriseServiceAccount,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    `/enterprise/security/service-accounts/${encodeURIComponent(serviceAccount.id)}/revoke`,
    accessToken,
    {
      body: JSON.stringify({ expectedVersion: serviceAccount.version }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )
}

/**
 * Break-glass administrator account を管理者が事前登録します。
 */
export function registerEnterpriseBreakGlassAdministrator(
  accessToken: string,
  input: RegisterEnterpriseBreakGlassAdministratorInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/break-glass/accounts',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseBreakGlassAdministrator>(
      data,
      'breakGlassAdministrator',
    ),
  )
}

/**
 * 現在の break-glass session から recovery access test を記録します。
 */
export function testEnterpriseBreakGlassAccess(
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/break-glass/test',
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then((data) =>
    readResponseProperty<EnterpriseBreakGlassAdministrator>(
      data,
      'breakGlassAdministrator',
    ),
  )
}

/**
 * 事前登録済みの current member が期限付き recovery access を開始します。
 */
export function activateEnterpriseBreakGlassAccess(
  accessToken: string,
  input: ActivateEnterpriseBreakGlassInput,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/break-glass/activate',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  ).then(parseEnterpriseBreakGlassActivationResponse)
}

/**
 * Current member の有効な recovery access を期限前に終了します。
 */
export function revokeEnterpriseBreakGlassAccess(
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/break-glass/revoke-activation',
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )
}

/**
 * Break-glass administrator を無効化します。
 */
export function deactivateEnterpriseBreakGlassAdministrator(
  accessToken: string,
  administrator: EnterpriseBreakGlassAdministrator,
  mutationContext: MutationRequestContext,
) {
  return sendEnterpriseSecurityRequest<unknown>(
    '/enterprise/security/break-glass/deactivate',
    accessToken,
    {
      body: JSON.stringify({
        administratorId: administrator.id,
        expectedVersion: administrator.version,
      }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
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

function parseEnterpriseSecuritySnapshot(data: unknown) {
  if (
    !isRecord(data) ||
    !isEnterpriseSecurityCapabilities(data.capabilities) ||
    !isEnterpriseAssignableRoleIds(data.assignableRoleIds) ||
    !Array.isArray(data.assignablePermissionIds) ||
    !data.assignablePermissionIds.every(
      (permissionId) => typeof permissionId === 'string',
    ) ||
    !isRecord(data.identityProvider) ||
    (data.capabilities.canViewIdentity
      ? typeof data.identityProvider.id !== 'string'
      : data.identityProvider.id !== undefined &&
        typeof data.identityProvider.id !== 'string') ||
    !isEnterpriseSsoPrerequisites(data.ssoPrerequisites) ||
    !Array.isArray(data.domains) ||
    !data.domains.every(
      (domain) =>
        isRecord(domain) &&
        typeof domain.verificationRecordName === 'string' &&
        Boolean(domain.verificationRecordName),
    ) ||
    !isEnterpriseScimConfiguration(data.scim) ||
    !Array.isArray(data.mappings) ||
    !data.mappings.every(
      (mapping) =>
        isRecord(mapping) &&
        typeof mapping.identityProviderId === 'string',
    ) ||
    !Array.isArray(data.roles) ||
    !data.roles.every(
      (role) =>
        isRecord(role) && typeof role.guestAssignable === 'boolean',
    ) ||
    !Array.isArray(data.permissions) ||
    !isRecord(data.sessionPolicy) ||
    typeof data.sessionPolicy.idleTimeoutMinutes !== 'number' ||
    typeof data.sessionPolicy.reauthenticationMinutes !== 'number' ||
    typeof data.sessionPolicy.sensitiveActionReauthenticationMinutes !==
      'number' ||
    typeof data.sessionPolicy.externalCollaboratorsAllowed !== 'boolean' ||
    typeof data.sessionPolicy.guestSessionLifetimeMinutes !== 'number' ||
    !Array.isArray(data.serviceAccounts) ||
    !data.serviceAccounts.every(isEnterpriseServiceAccount) ||
    !Array.isArray(data.breakGlassAdministrators) ||
    (data.activeBreakGlassActivation !== undefined &&
      data.activeBreakGlassActivation !== null &&
      (!isRecord(data.activeBreakGlassActivation) ||
        typeof data.activeBreakGlassActivation.expiresAt !== 'string' ||
        !Number.isFinite(
          Date.parse(data.activeBreakGlassActivation.expiresAt),
        )))
  ) {
    throw createMalformedResponseError()
  }

  return {
    assignablePermissionIds: data.assignablePermissionIds,
    assignableRoleIds: data.assignableRoleIds,
    activeBreakGlassActivation:
      isRecord(data.activeBreakGlassActivation) &&
      typeof data.activeBreakGlassActivation.expiresAt === 'string'
        ? { expiresAt: data.activeBreakGlassActivation.expiresAt }
        : undefined,
    breakGlassAdministrators:
      data.breakGlassAdministrators as EnterpriseBreakGlassAdministrator[],
    capabilities: data.capabilities as EnterpriseSecurityCapabilities,
    domains: data.domains as EnterpriseDomainClaim[],
    identityProvider: {
      ...data.identityProvider,
      id:
        typeof data.identityProvider.id === 'string'
          ? data.identityProvider.id
          : '',
    } as EnterpriseIdentityProvider,
    mappings: data.mappings as EnterpriseGroupRoleMapping[],
    permissions: data.permissions as EnterprisePermissionDefinition[],
    provisioningLogs: Array.isArray(data.provisioningLogs)
      ? (data.provisioningLogs as EnterpriseProvisioningLog[])
      : [],
    roles: data.roles as EnterpriseRoleDefinition[],
    scim: data.scim as EnterpriseScimConfiguration,
    serviceAccounts: data.serviceAccounts as EnterpriseServiceAccount[],
    sessionPolicy: data.sessionPolicy as EnterpriseSessionPolicy,
    ssoPrerequisites: data.ssoPrerequisites,
  } satisfies EnterpriseSecuritySnapshot
}

function parseEnterpriseScimTokenResponse(
  data: unknown,
): EnterpriseScimTokenResponse {
  if (
    !isRecord(data) ||
    !isEnterpriseScimConfiguration(data.scim) ||
    typeof data.token !== 'string' ||
    !data.token ||
    data.scim.tokenLastFour === undefined ||
    data.scim.tokenLastFour !== data.token.slice(-4)
  ) {
    throw createMalformedResponseError()
  }

  return data as EnterpriseScimTokenResponse
}

function parseEnterpriseBreakGlassActivationResponse(
  data: unknown,
): EnterpriseBreakGlassActivation {
  const activation = readResponseProperty<unknown>(data, 'activation')

  if (
    !isRecord(activation) ||
    typeof activation.id !== 'string' ||
    !activation.id ||
    typeof activation.accountId !== 'string' ||
    !activation.accountId ||
    typeof activation.startedAt !== 'string' ||
    !activation.startedAt ||
    typeof activation.expiresAt !== 'string' ||
    !activation.expiresAt
  ) {
    throw createMalformedResponseError()
  }

  return activation as EnterpriseBreakGlassActivation
}

function parseEnterpriseProvisioningImpact(
  data: unknown,
): EnterpriseProvisioningImpact {
  const impact = readResponseProperty<unknown>(data, 'impact')

  if (
    !isRecord(impact) ||
    typeof impact.previewId !== 'string' ||
    !impact.previewId ||
    typeof impact.expiresAt !== 'string' ||
    !impact.expiresAt ||
    !isRecord(impact.counts) ||
    !Array.isArray(impact.warnings) ||
    !impact.warnings.every((warning) => typeof warning === 'string') ||
    typeof impact.hasChanges !== 'boolean' ||
    typeof impact.blocking !== 'boolean'
  ) {
    throw createMalformedResponseError()
  }

  return impact as EnterpriseProvisioningImpact
}

function parseEnterpriseDomainVerificationChallenge(
  data: unknown,
): EnterpriseDomainVerificationChallenge {
  if (
    !isRecord(data) ||
    !isRecord(data.domain) ||
    typeof data.domain.verificationRecordName !== 'string' ||
    !data.domain.verificationRecordName ||
    typeof data.verificationRecordValue !== 'string' ||
    !data.verificationRecordValue
  ) {
    throw createMalformedResponseError()
  }

  return data as EnterpriseDomainVerificationChallenge
}

function parseEnterpriseSessionPolicyImpact(
  data: unknown,
): EnterpriseSessionPolicyImpact {
  if (!isRecord(data) || !isRecord(data.impact)) {
    throw createMalformedResponseError()
  }

  const impact = data.impact
  if (
    (impact.callerIp !== undefined && typeof impact.callerIp !== 'string') ||
    typeof impact.callerAllowed !== 'boolean' ||
    typeof impact.requiresConfirmation !== 'boolean' ||
    !Array.isArray(impact.warnings) ||
    !impact.warnings.every((warning) => typeof warning === 'string') ||
    (impact.confirmationToken !== undefined &&
      typeof impact.confirmationToken !== 'string') ||
    (impact.requiresConfirmation &&
      (typeof impact.confirmationToken !== 'string' ||
        !impact.confirmationToken))
  ) {
    throw createMalformedResponseError()
  }

  return impact as EnterpriseSessionPolicyImpact
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

function parseEnterpriseServiceAccountCredentialResponse(
  data: unknown,
): EnterpriseServiceAccountCredentialResponse {
  if (
    !isRecord(data) ||
    !isRecord(data.serviceAccount) ||
    typeof data.token !== 'string' ||
    !data.token
  ) {
    throw createMalformedResponseError()
  }

  return data as EnterpriseServiceAccountCredentialResponse
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

function isEnterpriseSecurityCapabilities(
  value: unknown,
): value is EnterpriseSecurityCapabilities {
  if (!isRecord(value)) {
    return false
  }

  return [
    'canView',
    'canViewIdentity',
    'canViewProvisioning',
    'canViewAccess',
    'canViewSessions',
    'canViewPrivileged',
    'canManageIdentity',
    'canManageProvisioning',
    'canManageAccess',
    'canManageMappings',
    'canManageRoles',
    'canManageSessions',
    'canManagePrivilegedAccess',
    'canManageBreakGlass',
  ].every((capability) => typeof value[capability] === 'boolean')
}

function isEnterpriseScimConfiguration(
  value: unknown,
): value is EnterpriseScimConfiguration {
  return (
    isRecord(value) &&
    typeof value.identityProviderId === 'string' &&
    (
      value.status === 'disabled' ||
      value.status === 'ready' ||
      value.status === 'syncing' ||
      value.status === 'error'
    ) &&
    typeof value.endpointUrl === 'string' &&
    Number.isSafeInteger(value.tokenGeneration) &&
    Number(value.tokenGeneration) >= 0 &&
    (
      value.tokenLastFour === undefined ||
      typeof value.tokenLastFour === 'string' &&
        /^[A-Za-z0-9_-]{4}$/.test(value.tokenLastFour)
    ) &&
    (
      value.lastSyncAt === undefined ||
      typeof value.lastSyncAt === 'string' &&
        Number.isFinite(Date.parse(value.lastSyncAt))
    ) &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 0
  )
}

function isEnterpriseSsoPrerequisites(
  value: unknown,
): value is EnterpriseSsoPrerequisites {
  return (
    isRecord(value) &&
    typeof value.providerReady === 'boolean' &&
    typeof value.domainReady === 'boolean' &&
    typeof value.breakGlassReady === 'boolean'
  )
}

function isEnterpriseServiceAccount(
  value: unknown,
): value is EnterpriseServiceAccount {
  if (!isRecord(value)) {
    return false
  }

  const scopeType = value.scopeType
  return (
    (scopeType === 'workspace' ||
      scopeType === 'team' ||
      scopeType === 'project') &&
    (scopeType === 'workspace'
      ? value.scopeId === undefined
      : typeof value.scopeId === 'string' && Boolean(value.scopeId)) &&
    Number.isSafeInteger(value.credentialLifetimeDays) &&
    Number(value.credentialLifetimeDays) >= 1 &&
    Number(value.credentialLifetimeDays) <= 365 &&
    (value.credentialExpiresAt === undefined ||
      (typeof value.credentialExpiresAt === 'string' &&
        Number.isFinite(Date.parse(value.credentialExpiresAt)))) &&
    isStringArray(value.allowedSourceCidrs)
  )
}

function isEnterpriseAssignableRoleIds(
  value: unknown,
): value is EnterpriseAssignableRoleIds {
  if (!isRecord(value) || !isRecord(value.groupMappings)) {
    return false
  }

  const groupMappings = value.groupMappings

  return (
    ['workspace', 'team', 'project'].every((scope) =>
      isStringArray(groupMappings[scope]),
    ) &&
    isStringArray(value.serviceAccounts)
  )
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && Boolean(item))
  )
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
